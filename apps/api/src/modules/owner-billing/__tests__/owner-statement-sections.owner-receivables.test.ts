/**
 * §5 owner-receivable itemisation.
 *
 * Bills-grid owner-borne costs (maintenance, owner-funded utilities, freeform owner
 * expenses) land on an IVOWN invoice. They are NOT owner-ledger expense rows — the
 * durable XOR at owner-ledger.sync.ts:114-150 keeps a charge with a live IVOWN line
 * out of Source 6, because it is a receivable rather than a payout deduction. So §5
 * showed only the management fee and the owner asked, reasonably, where the rest of
 * their costs had gone.
 *
 * Pinned here:
 *   • each owner-receivable charge is listed individually, by name
 *   • a charge Source 2 ALREADY booked as a ledger expense is not listed twice
 *   • totals are untouched — these are listed, never summed
 *
 * Run:
 *   npx vitest run owner-statement-sections.owner-receivables
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// Only `getDb` is faked. The REAL `Prisma` namespace is kept, because
// fetchOwnerReceivablePayoutRows constructs a genuine `Prisma.Decimal` for the
// adjustment-netted amount — a hand-rolled { toString } shim would let a rounding
// or precision bug in that construction pass unnoticed. `getDb` is a lazy factory,
// so importing the real module opens no connection.
vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return { ...actual, getDb: vi.fn() };
});
vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  // findDepositsHeldForUnits defaults to empty — see owner-statement-sections.test.ts.
  return { ...actual, findDepositsCollectedInMonth: vi.fn(), findDepositsHeldForUnits: vi.fn(async () => []) };
});

import { getDb } from "@kason/db";
import { findDepositsCollectedInMonth } from "../owner-billing.repository";
import { assembleYannieStatement } from "../owner-statement-sections";

const ORG = "00000000-0000-0000-0000-000000000001";
const STMT_ID = "00000000-0000-0000-0000-000000000002";
const OWNER_ID = "00000000-0000-0000-0000-000000000003";
const LISTING_A = "00000000-0000-0000-0000-000000000004";
const APT_1 = "apt-1";
const SERIES_IVOWN = "series-ivown";
const MGMT_CHARGE = "charge-mgmt-0000-0000-000000000001";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u1", actorRole: "admin" };
const dec = (s: string) => ({ toString: () => s });
const PERIOD = new Date("2026-08-01T00:00:00.000Z");

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    direction: "income",
    category: "rental_income",
    amount: dec("3000.00"),
    sstAmount: null,
    includeInPayout: true,
    taxCategory: "not_applicable",
    propertyId: "prop-1",
    apartmentId: APT_1,
    listingId: LISTING_A,
    statementMonth: PERIOD,
    paymentStatus: "paid",
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
    description: null,
    remarks: null,
    sourceType: "rent",
    sourceChargeId: null,
    sourceUtilityBillId: null,
    settlementKind: null,
    memo: null,
    ...overrides,
  };
}

function makeListing() {
  return {
    id: LISTING_A,
    apartmentId: APT_1,
    rentalRate: dec("3000.00"),
    unitKind: null,
    apartment: { unitCode: "A-01-01", propertyId: "prop-1", property: { name: "Kason Residences" } },
    tenancies: [
      {
        startDate: new Date("2026-08-01"),
        endDate: null,
        monthlyRentAmount: dec("3000.00"),
        depositAmount: dec("0.00"),
        tenantParty: { displayName: "Demo Tenant" },
      },
    ],
  };
}

describe("assembleYannieStatement — §5 owner receivables", () => {
  let dbMock: {
    invoice: { findFirst: ReturnType<typeof vi.fn> };
    party: { findFirst: ReturnType<typeof vi.fn> };
    ownerLedgerEntry: { findMany: ReturnType<typeof vi.fn> };
    listing: { findMany: ReturnType<typeof vi.fn> };
    managementFeeConfig: { findMany: ReturnType<typeof vi.fn> };
    charge: { findMany: ReturnType<typeof vi.fn> };
    documentSeries: { findFirst: ReturnType<typeof vi.fn> };
    billingDocumentLine: { findMany: ReturnType<typeof vi.fn> };
    unitUtilityBill: { findMany: ReturnType<typeof vi.fn> };
  };

  /**
   * Active adjustment-note lines the netting helpers should see. Assign directly in
   * a test BEFORE calling assembleYannieStatement; reset to none in beforeEach, so
   * every existing test keeps its no-notes behaviour.
   */
  let noteLines: Array<Record<string, unknown>> = [];

  /**
   * billingDocumentLine.findMany now serves TWO distinct queries on this path:
   *   • the IVOWN invoice-line fetch      — where.document.docType === "invoice"
   *   • the CN/DN netting (net-adjustments-by-charge.ts)
   *                                       — where.document.docType === { in: [...] }
   * One blanket mockResolvedValue answered BOTH with invoice-shaped rows, so the
   * netting helper read `.amount` off a row that never carried one. Discriminate on
   * the docType filter's SHAPE (string vs object), mirroring how the charge.findMany
   * mock below already tells its two callers apart.
   */
  function mockDocLines(invoiceLines: Array<Record<string, unknown>>) {
    dbMock.billingDocumentLine.findMany.mockImplementation(
      async (args: { where?: { document?: { docType?: unknown } } }) =>
        typeof args?.where?.document?.docType === "object" ? noteLines : invoiceLines,
    );
  }

  /** The four bills-grid owner costs from the demo's IVOWN-0002. */
  const OWNER_COSTS = [
    { id: "c-maint", description: "Maintenance 202608", amount: dec("300.00"), status: "paid", categoryId: null },
    { id: "c-recur", description: "CUSTOM RECURRING OWNER 202608", amount: dec("100.00"), status: "paid", categoryId: null },
    { id: "c-exp1", description: "EXPENSES OWNER NON SST", amount: dec("200.00"), status: "paid", categoryId: null },
    { id: "c-exp2", description: "EXPENSES OWNER SST", amount: dec("200.00"), status: "posted", categoryId: null },
  ];

  beforeEach(() => {
    dbMock = {
      invoice: { findFirst: vi.fn() },
      party: { findFirst: vi.fn() },
      ownerLedgerEntry: { findMany: vi.fn() },
      listing: { findMany: vi.fn() },
      managementFeeConfig: { findMany: vi.fn() },
      charge: { findMany: vi.fn() },
      documentSeries: { findFirst: vi.fn() },
      billingDocumentLine: { findMany: vi.fn() },
      unitUtilityBill: { findMany: vi.fn() },
    };
    (getDb as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);
    (findDepositsCollectedInMonth as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID, ownerPartyId: OWNER_ID, periodMonth: PERIOD, apartmentId: null,
    });
    noteLines = [];
    dbMock.party.findFirst.mockResolvedValue({
      displayName: "Demo Owner", bankName: "Maybank", bankAccountHolder: "Demo Owner", bankAccountNumber: "5141",
    });
    dbMock.listing.findMany.mockResolvedValue([makeListing()]);
    dbMock.managementFeeConfig.findMany.mockResolvedValue([]);
    dbMock.unitUtilityBill.findMany.mockResolvedValue([]);
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([ledgerRow()]);
    dbMock.documentSeries.findFirst.mockResolvedValue({ id: SERIES_IVOWN });
    // BillingDocumentLine.sstAmount is NOT nullable (schema.prisma:2378, @default(0)) —
    // a non-SST line really does carry "0.00", not null.
    mockDocLines(
      OWNER_COSTS.map((c) => ({ chargeId: c.id, description: c.description, sstAmount: dec("0.00") })),
    );
    // charge.findMany serves BOTH the §4 charged-amount lookup and the §5 receivable
    // lookup; discriminate on the status filter the receivable query carries.
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { status?: unknown; sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : args?.where?.status ? OWNER_COSTS : [],
    );
  });

  it("lists every owner-receivable cost individually, by name", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.description)).toEqual([
      "Maintenance 202608",
      "CUSTOM RECURRING OWNER 202608",
      "EXPENSES OWNER NON SST",
      "EXPENSES OWNER SST",
    ]);
    expect(rows.map((r) => r.amount)).toEqual(["300.00", "100.00", "200.00", "200.00"]);
  });

  it("reports real settlement state — settled reads paid, unsettled reads pending", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

    expect(rows.find((r) => r.description === "Maintenance 202608")!.paymentStatus).toBe("paid");
    // status "posted" = still owed; must never render as paid.
    expect(rows.find((r) => r.description === "EXPENSES OWNER SST")!.paymentStatus).toBe("pending");
  });

  it("MONEY: does not double-list a charge Source 2 already booked as a ledger expense", async () => {
    // The management fee is BOTH an IVOWN line and a ledger expense row. It belongs
    // to the ledger-expense list only — listing it here too would show it twice.
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      ledgerRow(),
      ledgerRow({
        direction: "expense",
        category: "management_fee",
        amount: dec("300.00"),
        sourceType: "statement",
        sourceChargeId: MGMT_CHARGE,
      }),
    ]);
    mockDocLines([
      { chargeId: MGMT_CHARGE, description: "Management fee" },
      { chargeId: "c-maint", description: "Maintenance 202608" },
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { status?: unknown; sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId
        ? []
        : args?.where?.status
        ? [
            { id: MGMT_CHARGE, description: "Management fee", amount: dec("300.00"), status: "paid", categoryId: null },
            OWNER_COSTS[0]!,
          ]
        : [],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const receivables = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

    expect(receivables).toHaveLength(1);
    expect(receivables[0]!.description).toBe("Maintenance 202608");
  });

  it("MONEY: the §5 total foots to the rows it displays", async () => {
    // The bug this pins: §5 listed RM 1,124 of rows under a RM 324 total, because the
    // receivables were displayed but never summed. A table that does not add up to
    // its own total is not a rounding quibble — it is the statement disagreeing with
    // itself in front of the owner.
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.expenseBreakdown.rows;
    const summed = rows.reduce((acc, r) => acc + Number(r.amount) + Number(r.sstAmount), 0);

    expect(result!.expenseBreakdown.totalExpenses).toBe("800.00");
    expect(summed.toFixed(2)).toBe(result!.expenseBreakdown.totalExpenses);
  });

  it("MONEY: receivables reduce the owner's net payout", async () => {
    // RM 3,000 rent, no fee config, RM 800 of owner-borne costs KAEN recovers from
    // the rent ⇒ the owner nets RM 2,200. Before this they were shown RM 3,000.
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.payoutSummary.netPayoutToOwner).toBe("2200.00");
  });

  it("MONEY: a management fee already in the ledger is deducted ONCE, not twice", async () => {
    // The fee is both an IVOWN line AND a ledger expense. Counting the receivable
    // copy too would deduct RM 300 twice and understate the payout by that much —
    // the same double-deduct the auto-offset hook guards against.
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      ledgerRow(),
      ledgerRow({
        direction: "expense",
        category: "management_fee",
        amount: dec("300.00"),
        sstAmount: null,
        sourceType: "statement",
        sourceChargeId: MGMT_CHARGE,
      }),
    ]);
    mockDocLines([
      { chargeId: MGMT_CHARGE, description: "Management fee" },
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { status?: unknown; sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId
        ? []
        : args?.where?.status
        ? [{ id: MGMT_CHARGE, description: "Management fee", amount: dec("300.00"), status: "paid" }]
        : [],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    // §5 replaces the ledger's own management_fee row with the fee computed from
    // config (isSuppressedFromSection5), and this fixture has no fee config — so a
    // correctly-excluded receivable leaves totalExpenses at 0.00. WITHOUT the guard
    // the receivable copy would add RM 300 here and drop the payout to RM 2,700.
    expect(result!.expenseBreakdown.totalExpenses).toBe("0.00");
    expect(result!.payoutSummary.netPayoutToOwner).toBe("3000.00");
    expect(result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable")).toHaveLength(0);
  });

  // ─── withSST owner costs ────────────────────────────────────────────────────
  //
  // A bills-grid owner expense ticked "With SST" mints a Charge with sstRate 8, and
  // issueDocumentTx puts round(amount × rate) onto that charge's OWN invoice line
  // (issue.service.ts:117-130 — the document's sstAmount is the SUM of its lines, not
  // a separate document-level levy). §5 previously hardcoded these rows to "0.00", so
  // an owner invoiced RM 216.00 was shown RM 200.00 of cost and paid RM 16.00 too much.
  describe("a withSST owner cost", () => {
    /** c-exp2 "EXPENSES OWNER SST": RM 200.00 @ 8% ⇒ RM 16.00 on its invoice line. */
    function lineWithSst() {
      mockDocLines(
        OWNER_COSTS.map((c) => ({
          chargeId: c.id,
          description: c.description,
          sstAmount: dec(c.id === "c-exp2" ? "16.00" : "0.00"),
        })),
      );
    }

    it("MONEY: carries its invoice-line SST into the §5 row", async () => {
      lineWithSst();
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

      expect(rows.find((r) => r.description === "EXPENSES OWNER SST")!.sstAmount).toBe("16.00");
      // Every other owner cost is genuinely SST-free and must stay at 0.00.
      expect(rows.filter((r) => r.description !== "EXPENSES OWNER SST").map((r) => r.sstAmount)).toEqual([
        "0.00",
        "0.00",
        "0.00",
      ]);
    });

    it("MONEY: the §5 total absorbs the SST and still foots to its own rows", async () => {
      lineWithSst();
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const summed = result!.expenseBreakdown.rows.reduce(
        (acc, r) => acc + Number(r.amount) + Number(r.sstAmount),
        0,
      );

      expect(result!.expenseBreakdown.totalExpenses).toBe("816.00");
      expect(summed.toFixed(2)).toBe(result!.expenseBreakdown.totalExpenses);
    });

    it("MONEY: the owner's payout is reduced by the SST they were invoiced", async () => {
      lineWithSst();
      const result = await assembleYannieStatement(ctx, STMT_ID);
      // RM 3,000 rent − RM 800 base − RM 16 SST. Showing RM 2,200 pays the owner the
      // SST that KAEN billed them on IVOWN — the same under-deduction Source 6 already
      // guards against via ownerBorneExpenseSstAmount (owner-ledger.sync.ts:106).
      expect(result!.payoutSummary.netPayoutToOwner).toBe("2184.00");
    });
  });

  // ─── CN/DN on an owner receivable ───────────────────────────────────────────
  //
  // Reported 2026-08-17: an admin credited RM 0.50 off a RM 1.00 owner expense and
  // raised a RM 0.30 debit note on another; §5 went on showing RM 1.00 and RM 0.01.
  // `Charge.amount` is the FROZEN mint figure — charge-adjustment.service.ts moves
  // `outstandingAmount` and records the delta on the note, never rewriting `amount`
  // — so reading it bare here ignored both notes. And because these rows feed
  // computeOwnerPayout, the payout deducted the UN-credited cost too.
  describe("active credit/debit notes on an owner receivable", () => {
    it("MONEY: nets both directions into the §5 row AND the payout", async () => {
      // −100 on the RM 300 maintenance, +50 on the RM 100 recurring.
      noteLines = [
        { chargeId: "c-maint", amount: dec("100.00"), sstAmount: dec("0.00"), document: { docType: "credit_note" } },
        { chargeId: "c-recur", amount: dec("50.00"), sstAmount: dec("0.00"), document: { docType: "debit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

      expect(rows.find((r) => r.description === "Maintenance 202608")!.amount).toBe("200.00");
      expect(rows.find((r) => r.description === "CUSTOM RECURRING OWNER 202608")!.amount).toBe("150.00");
      // Untouched costs stay exactly as they were — absent from the map means 0.
      expect(rows.find((r) => r.description === "EXPENSES OWNER NON SST")!.amount).toBe("200.00");
      // 3000 − (200 + 150 + 200 + 200) = 2250. Bare `amount` gave 800 of cost → 2200.
      expect(result!.payoutSummary.netPayoutToOwner).toBe("2250.00");
    });

    it("MONEY: a credit note's own SST relief reaches the row, not just its base", async () => {
      // The RM 200 @ 8% cost credited by RM 50; the CN itself declares RM 4.00 of SST.
      mockDocLines(
        OWNER_COSTS.map((c) => ({
          chargeId: c.id,
          description: c.description,
          sstAmount: dec(c.id === "c-exp2" ? "16.00" : "0.00"),
        })),
      );
      noteLines = [
        { chargeId: "c-exp2", amount: dec("50.00"), sstAmount: dec("4.00"), document: { docType: "credit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const row = result!
        .expenseBreakdown.rows.find((r) => r.description === "EXPENSES OWNER SST")!;

      expect(row.amount).toBe("150.00");
      // The tax the NOTE declared (16.00 − 4.00), never a re-derivation of the rate.
      expect(row.sstAmount).toBe("12.00");
    });

    it("a credit note larger than the charge floors the cost at zero, never negative", async () => {
      // A cost cannot become owner INCOME — that would pay them for a cancelled bill.
      noteLines = [
        { chargeId: "c-maint", amount: dec("999.00"), sstAmount: dec("0.00"), document: { docType: "credit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

      expect(rows.find((r) => r.description === "Maintenance 202608")!.amount).toBe("0.00");
    });
  });

  // ─── §5 must SAY which note moved the row (reported 2026-08-17) ──────────────
  //
  // Netting the notes silently was only half the fix. §4 already prints
  // "WiFi · Debit note +RM 0.05" beside the income line it moved, so the owner can
  // reconcile the figure against the note KAEN issued. §5 printed the adjusted
  // number bare: an owner looking at "test own exp sst — RM 0.50" had no way to
  // tell it started life at RM 1.00 and carries a credit note, and no way to check
  // the deduction against the document in their inbox. Same wording as §4, because
  // it is the same event.
  describe("§5 names the credit/debit note that moved each expense row", () => {
    it("annotates an owner-receivable row with the note direction and amount", async () => {
      noteLines = [
        { chargeId: "c-maint", amount: dec("100.00"), sstAmount: dec("0.00"), document: { docType: "credit_note" } },
        { chargeId: "c-recur", amount: dec("50.00"), sstAmount: dec("0.00"), document: { docType: "debit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const rows = result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable");

      expect(rows.find((r) => r.description === "Maintenance 202608")!.adjustmentNote).toBe(
        "Credit note -RM 100.00",
      );
      expect(
        rows.find((r) => r.description === "CUSTOM RECURRING OWNER 202608")!.adjustmentNote,
      ).toBe("Debit note +RM 50.00");
      // A row no note touched stays clean — never an empty "·" or a "RM 0.00" note.
      expect(rows.find((r) => r.description === "EXPENSES OWNER NON SST")!.adjustmentNote).toBeNull();
    });

    it("splits both directions rather than netting them into one opaque figure", async () => {
      // Netting +80/−30 to "+RM 50.00" hides a debit note the owner never saw. The
      // tenant surfaces split them for exactly this reason; so does §4.
      noteLines = [
        { chargeId: "c-maint", amount: dec("80.00"), sstAmount: dec("0.00"), document: { docType: "debit_note" } },
        { chargeId: "c-maint", amount: dec("30.00"), sstAmount: dec("0.00"), document: { docType: "credit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const row = result!.expenseBreakdown.rows.find((r) => r.description === "Maintenance 202608")!;

      expect(row.adjustmentNote).toBe("Debit note +RM 80.00 · Credit note -RM 30.00");
      expect(row.amount).toBe("350.00"); // 300 + 80 − 30 — the note IS the arithmetic
    });

    it("names the SST the note itself relieved, so the SST column reconciles too", async () => {
      // §5 shows Amount and SST as two columns. A note that moved BOTH and only
      // explained the base left the owner an unexplained 16.00 → 12.00 drop.
      mockDocLines(
        OWNER_COSTS.map((c) => ({
          chargeId: c.id,
          description: c.description,
          sstAmount: dec(c.id === "c-exp2" ? "16.00" : "0.00"),
        })),
      );
      noteLines = [
        { chargeId: "c-exp2", amount: dec("50.00"), sstAmount: dec("4.00"), document: { docType: "credit_note" } },
      ];
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const row = result!.expenseBreakdown.rows.find((r) => r.description === "EXPENSES OWNER SST")!;

      expect(row.adjustmentNote).toBe("Credit note -RM 50.00 · SST -RM 4.00");
      expect(row.amount).toBe("150.00");
      expect(row.sstAmount).toBe("12.00");
    });

    it("annotates a statement-sourced ledger expense the same way", async () => {
      // The other §5 family: owner-borne charges booked as `statement` ledger rows
      // (letting-commission SST, and friends). owner-ledger.sync nets their notes in
      // at sync time (expectedStatementLedgerRows), so they carry the SAME silent
      // adjustment the receivables did.
      dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
        ledgerRow(),
        ledgerRow({
          direction: "expense",
          category: "other_expense",
          amount: dec("80.00"), // 100.00 minted, less the 20.00 credit note below
          sourceType: "statement",
          sourceChargeId: "c-stmt",
          description: "SST on Admin Fee (First Month Rental)",
        }),
      ]);
      noteLines = [
        { chargeId: "c-stmt", amount: dec("20.00"), sstAmount: dec("0.00"), document: { docType: "credit_note" } },
      ];

      const result = await assembleYannieStatement(ctx, STMT_ID);
      const row = result!.expenseBreakdown.rows.find(
        (r) => r.description === "SST on Admin Fee (First Month Rental)",
      )!;

      expect(row.adjustmentNote).toBe("Credit note -RM 20.00");
    });

    it("uses the owner-facing Admin Fee label for the internal letting_commission category", async () => {
      dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
        ledgerRow(),
        ledgerRow({
          direction: "expense",
          category: "letting_commission",
          amount: dec("1500.00"),
          includeInPayout: false,
          sourceType: "statement",
          sourceChargeId: "c-admin-fee",
          description: "Admin Fee (First Month Rental)",
        }),
      ]);

      const result = await assembleYannieStatement(ctx, STMT_ID);
      const row = result!.expenseBreakdown.rows.find(
        (item) => item.categoryKey === "letting_commission",
      )!;

      expect(row.category).toBe("Admin Fee (First Month Rental)");
      expect(row.description).toBe("Admin Fee (First Month Rental)");
    });

    it("leaves every un-adjusted row's note null", async () => {
      const result = await assembleYannieStatement(ctx, STMT_ID);
      const rows = result!.expenseBreakdown.rows;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.adjustmentNote === null)).toBe(true);
    });
  });

  it("an org with no IVOWN series configured simply gains no rows", async () => {
    dbMock.documentSeries.findFirst.mockResolvedValue(null);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable")).toHaveLength(0);
  });

  it("skips void/credited charges (the query filters them; none survive to §5)", async () => {
    dbMock.charge.findMany.mockImplementation(async () => []);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.expenseBreakdown.rows.filter((r) => r.categoryKey === "owner_receivable")).toHaveLength(0);
  });
});
