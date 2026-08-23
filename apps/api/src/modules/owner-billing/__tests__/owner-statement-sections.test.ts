import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// mock getDb
vi.mock("@kason/db", () => ({ getDb: vi.fn() }));
// Stub only the DB-hitting findDepositsCollectedInMonth; keep the rest of the
// module REAL — assembleYannieStatement also imports the pure depositWindowEndOfMonth
// helper from here, and a bare `{ findDepositsCollectedInMonth }` factory would make
// it `undefined` (→ throws). Spreading the actual module keeps that helper real.
vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  // findDepositsHeldForUnits defaults to empty: it is a second DB-hitting read on
  // the same table, and these tests mock getDb() without a `deposit` model. A
  // default-[] stub keeps every case that does not care about held deposits
  // working unchanged.
  return { ...actual, findDepositsCollectedInMonth: vi.fn(), findDepositsHeldForUnits: vi.fn(async () => []) };
});

import { getDb } from "@kason/db";
import { findDepositsCollectedInMonth } from "../owner-billing.repository";
import {
  assembleYannieStatement,
  computeOwnerPayout,
  computedMgmtFeePaymentStatus,
} from "../owner-statement-sections";

const ORG = "00000000-0000-0000-0000-000000000001";
const STMT_ID = "00000000-0000-0000-0000-000000000002";
const OWNER_ID = "00000000-0000-0000-0000-000000000003";
const LISTING_A = "00000000-0000-0000-0000-000000000004";
const LISTING_B = "00000000-0000-0000-0000-000000000005";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u1", actorRole: "admin" };

// Helper to create a Decimal-like object (Prisma Decimal)
const dec = (s: string) => ({ toString: () => s });

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

// Parse a 2dp money string to integer cents — keeps waterfall assertions exact (no float drift).
const cents = (s: string): number => Math.round(parseFloat(s) * 100);

type PayoutLine = { label: string; amount: string; isNonIncome?: boolean; isTotal?: boolean };
const lineByLabel = (lines: PayoutLine[], label: string): PayoutLine | undefined =>
  lines.find((l) => l.label === label);

describe("computeOwnerPayout business safeguards", () => {
  it("never exposes a negative payable and reports the owner top-up separately", () => {
    const result = computeOwnerPayout({
      rows: [
        {
          direction: "expense",
          category: "maintenance",
          amount: dec("500"),
          sstAmount: null,
          includeInPayout: true,
          taxCategory: "non_sst",
          propertyId: "property-a",
          apartmentId: "apartment-a",
        },
      ],
      feeConfigRows: [],
      depositCollectedC: 0,
    });
    expect(result.totalPayoutC).toBe(-50_000);
    expect(result.payableToOwnerC).toBe(0);
    expect(result.ownerTopUpRequiredC).toBe(50_000);
  });

  it("uses unit fee config before property and owner defaults", () => {
    const result = computeOwnerPayout({
      rows: [
        {
          direction: "income",
          category: "rental_income",
          amount: dec("1000"),
          sstAmount: null,
          includeInPayout: true,
          taxCategory: "non_sst",
          propertyId: "property-a",
          apartmentId: "apartment-a",
        },
      ],
      feeConfigRows: [
        { propertyId: null, apartmentId: null, feeType: "percent", feeValue: dec("5"), capAmount: null, sstPercent: dec("8"), updatedAt: new Date("2026-01-01") },
        { propertyId: "property-a", apartmentId: null, feeType: "percent", feeValue: dec("10"), capAmount: null, sstPercent: dec("8"), updatedAt: new Date("2026-01-02") },
        { propertyId: "property-a", apartmentId: "apartment-a", feeType: "percent", feeValue: dec("12"), capAmount: null, sstPercent: dec("8"), updatedAt: new Date("2026-01-03") },
      ],
      depositCollectedC: 0,
    });
    expect(result.computedMgmtBaseC).toBe(12_000);
    expect(result.computedMgmtSstC).toBe(960);
    expect(result.payableToOwnerC).toBe(87_040);
  });

  it("uses the exact billed management fee instead of recomputing changed custom settings", () => {
    const result = computeOwnerPayout({
      rows: [
        {
          direction: "income", category: "rental_income", amount: dec("1000"),
          sstAmount: null, includeInPayout: true, taxCategory: "non_sst",
          propertyId: "property-a", apartmentId: "apartment-a",
        },
        {
          direction: "expense", category: "management_fee", amount: dec("75"),
          sstAmount: dec("6"), includeInPayout: true, taxCategory: "with_sst",
          propertyId: "property-a", apartmentId: "apartment-a",
          sourceChargeId: "management-fee-charge-a",
        },
      ],
      // The current config would produce RM108. The sourced row is the already
      // billed custom result and must win for payout/report consistency.
      feeConfigRows: [
        { propertyId: "property-a", apartmentId: "apartment-a", feeType: "percent", feeValue: dec("10"), capAmount: null, sstPercent: dec("8"), updatedAt: new Date("2026-01-03") },
      ],
      depositCollectedC: 0,
    });
    expect(result.computedMgmtBaseC).toBe(7_500);
    expect(result.computedMgmtSstC).toBe(600);
    expect(result.payableToOwnerC).toBe(91_900);
  });

  it("does not deduct management fee during the unit's free period", () => {
    const result = computeOwnerPayout({
      rows: [{
        direction: "income", category: "rental_income", amount: dec("1000"),
        sstAmount: null, includeInPayout: true, taxCategory: "non_sst",
        propertyId: "property-a", apartmentId: "apartment-a",
      }],
      feeConfigRows: [{
        propertyId: "property-a", apartmentId: "apartment-a", feeType: "percent",
        feeValue: dec("10"), capAmount: null, sstPercent: dec("8"),
        freePeriodStart: new Date("2026-01-01T00:00:00.000Z"),
        freePeriodEnd: new Date("2026-06-30T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
      depositCollectedC: 0,
      statementMonth: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result.computedMgmtTotalC).toBe(0);
    expect(result.payableToOwnerC).toBe(100_000);
  });
});

describe("assembleYannieStatement", () => {
  let dbMock: {
    invoice: { findFirst: ReturnType<typeof vi.fn> };
    party: { findFirst: ReturnType<typeof vi.fn> };
    ownerLedgerEntry: { findMany: ReturnType<typeof vi.fn> };
    listing: { findMany: ReturnType<typeof vi.fn> };
    managementFeeConfig: { findMany: ReturnType<typeof vi.fn> };
    charge: { findMany: ReturnType<typeof vi.fn> };
    documentSeries: { findFirst: ReturnType<typeof vi.fn> };
    billingDocumentLine: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    dbMock = {
      invoice: { findFirst: vi.fn() },
      party: { findFirst: vi.fn() },
      ownerLedgerEntry: { findMany: vi.fn() },
      listing: { findMany: vi.fn() },
      managementFeeConfig: { findMany: vi.fn() },
      // Backs the Task-6 chargedAmountByChargeId lookup — only invoked when an
      // income row carries a sourceChargeId (existing tests never set one; new
      // Task B2 safety-net test below does).
      charge: { findMany: vi.fn() },
      // §5 owner-receivable itemisation reads the IVOWN series + its document lines.
      documentSeries: { findFirst: vi.fn() },
      billingDocumentLine: { findMany: vi.fn() },
    };
    (getDb as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);
    (findDepositsCollectedInMonth as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // No IVOWN series/lines by default ⇒ §5 gains no owner-receivable rows, so every
    // pre-existing expectation in these suites stays byte-identical.
    dbMock.documentSeries.findFirst.mockResolvedValue(null);
    dbMock.billingDocumentLine.findMany.mockResolvedValue([]);
    dbMock.charge.findMany.mockResolvedValue([]);

    // G4: mgmt fee is now COMPUTED per income line, resolving the owner's
    // ManagementFeeConfig per property (10% + 8% SST; all-properties default). On
    // 2000.00 rent this yields the same 200.00 + 16.00 the old ledger-sourced fee
    // did, so the assertions below hold.
    dbMock.managementFeeConfig.findMany.mockResolvedValue([
      {
        propertyId: null,
        feeType: "percent",
        feeValue: dec("10"),
        capAmount: null,
        sstPercent: dec("8"),
        updatedAt: PERIOD,
      },
    ]);

    // Default invoice mock
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
    });

    // Default party mock
    dbMock.party.findFirst.mockResolvedValue({
      displayName: "Ahmad Owner",
      bankName: "Maybank",
      bankAccountHolder: "Ahmad bin Ali",
      bankAccountNumber: "12345678",
    });

    // Default ledger entries: one rental_income + one management_fee expense
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("2000.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
      {
        direction: "expense",
        category: "management_fee",
        amount: dec("200.00"),
        sstAmount: dec("16.00"),
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: "Management fee",
        remarks: null,
      },
    ]);

    // Default listing mock
    dbMock.listing.findMany.mockResolvedValue([
      {
        id: LISTING_A,
        rentalRate: dec("2000.00"),
        apartment: {
          unitCode: "A-10-04",
          propertyId: "prop-1",
          property: { name: "PV9 Residences" },
        },
        tenancies: [
          {
            startDate: new Date("2026-01-01"),
            endDate: null,
            monthlyRentAmount: dec("2000.00"),
            depositAmount: dec("4000.00"),
            tenantParty: { displayName: "John Tenant" },
          },
        ],
      },
    ]);
  });

  it("returns null when statement not found", async () => {
    dbMock.invoice.findFirst.mockResolvedValue(null);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).toBeNull();
  });

  it("returns null when statement has no ownerPartyId", async () => {
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: null,
      periodMonth: PERIOD,
    });
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).toBeNull();
  });

  it("returns all 5 sections with correct shapes", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("header");
    expect(result).toHaveProperty("occupancy");
    expect(result).toHaveProperty("payoutSummary");
    expect(result).toHaveProperty("incomeBreakdown");
    expect(result).toHaveProperty("expenseBreakdown");
  });

  it("header has correct reportMonth and full (unmasked) account number", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.header.reportMonth).toBe("June 2026");
    expect(result!.header.ownerName).toBe("Ahmad Owner");
    expect(result!.header.bankName).toBe("Maybank");
    // shown in full — admin/owner need the complete number to make the transfer
    expect(result!.header.accountNumberMasked).toBe("12345678");
  });

  it("occupancy section has 1 occupied unit", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.occupancy.occupiedCount).toBe(1);
    expect(result!.occupancy.vacantCount).toBe(0);
    expect(result!.occupancy.rows).toHaveLength(1);
    expect(result!.occupancy.rows[0].isVacant).toBe(false);
    expect(result!.occupancy.rows[0].tenantName).toBe("John Tenant");
    expect(result!.occupancy.rows[0].monthlyRental).toBe("2000.00");
  });

  it("payout summary shows correct gross, expenses, and net", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const lines = result!.payoutSummary.lines;
    // grossRental = 2000.00, deductible expenses = 200.00 + 16.00 = 216.00
    // netPayoutToOwner = 2000.00 - 216.00 = 1784.00
    expect(lines[0].label).toBe("Total Income Collected");
    expect(lines[0].amount).toBe("2000.00");
    expect(result!.payoutSummary.netPayoutToOwner).toBe("1784.00");
  });

  it("PV9 default (no owner-paid expense): waterfall reconciles, relabeled, no spurious memo", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const lines = result!.payoutSummary.lines;

    // Relabeled "Less:" line shows the ACTUALLY-deducted total (216.00), same value as before.
    const deductible = lineByLabel(lines, "Less: Deductible Expenses");
    expect(deductible).toBeDefined();
    expect(deductible!.amount).toBe("216.00");
    // Old label is gone.
    expect(lineByLabel(lines, "Less: Total Expenses")).toBeUndefined();

    // Zero owner-paid expenses (default) ⇒ NO memo line: visible output unchanged but for the relabel.
    expect(lineByLabel(lines, "Owner-paid expenses (not deducted)")).toBeUndefined();

    // Waterfall reconciles EXACTLY in integer cents: GrossCashIn − Deductible = Total Payout.
    const grossCashIn = lineByLabel(lines, "Gross Cash In")!;
    const totalPayout = lineByLabel(lines, "Total Payout to Owner")!;
    expect(cents(grossCashIn.amount) - cents(deductible!.amount)).toBe(cents(totalPayout.amount));

    // netPayoutToOwner is the SAME value as before the fix.
    expect(result!.payoutSummary.netPayoutToOwner).toBe("1784.00");
    expect(totalPayout.amount).toBe("1784.00");
  });

  it("queries ledger entries with a deterministic orderBy (soft-copy must not drift from screen)", async () => {
    await assembleYannieStatement(ctx, STMT_ID);
    expect(dbMock.ownerLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { direction: "asc" },
          { category: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      }),
    );
  });

  it("owner-paid (includeInPayout:false) expense: memo line, NOT deducted, netPayout unchanged", async () => {
    // income 2000.00 + deductible mgmt fee 200.00 (+16.00 SST) + owner-paid assessment 320.00.
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("2000.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
      {
        direction: "expense",
        category: "management_fee",
        amount: dec("200.00"),
        sstAmount: dec("16.00"),
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: "Management fee",
        remarks: null,
      },
      {
        // Owner settled this directly — includeInPayout:false ⇒ must NOT reduce the payout.
        direction: "expense",
        category: "assessment_tax",
        amount: dec("320.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "govt_assessment",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: "Assessment tax (owner-paid)",
        remarks: null,
      },
    ]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const lines = result!.payoutSummary.lines;

    // (a) netPayoutToOwner = grossRental − only-deductible = 2000 − 216 = 1784.00,
    //     UNCHANGED by the 320.00 owner-paid expense.
    expect(result!.payoutSummary.netPayoutToOwner).toBe("1784.00");

    // (b) Owner-paid expense appears as an isNonIncome memo line, NOT in the deducted total.
    const deductible = lineByLabel(lines, "Less: Deductible Expenses")!;
    expect(deductible.amount).toBe("216.00"); // still ONLY the includeInPayout:true expenses
    const ownerPaidMemo = lineByLabel(lines, "Owner-paid expenses (not deducted)");
    expect(ownerPaidMemo).toBeDefined();
    expect(ownerPaidMemo!.amount).toBe("320.00");
    expect(ownerPaidMemo!.isNonIncome).toBe(true);

    // (c) GrossCashIn − deductibleLine === totalPayoutLine, exactly (integer cents).
    const grossCashIn = lineByLabel(lines, "Gross Cash In")!;
    const totalPayout = lineByLabel(lines, "Total Payout to Owner")!;
    expect(cents(grossCashIn.amount) - cents(deductible.amount)).toBe(cents(totalPayout.amount));
    expect(totalPayout.amount).toBe("1784.00");
  });

  it("income breakdown has 1 row with correct mgmt fee", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.rows).toHaveLength(1);
    const row = result!.incomeBreakdown.rows[0];
    expect(row.incomeType).toBe("Monthly");
    expect(row.amount).toBe("2000.00");
    expect(row.mgmtFee).toBe("200.00");
    expect(row.mgmtFeeSst).toBe("16.00");
    expect(row.paymentStatus).toBe("paid");
  });

  it("aircond_income row has zero mgmt fee", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "aircond_income",
        amount: dec("150.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
    ]);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const row = result!.incomeBreakdown.rows[0];
    expect(row.incomeType).toBe("Aircond Fee");
    expect(row.mgmtFee).toBe("0.00");
    expect(row.mgmtFeeSst).toBe("0.00");
  });

  it("expense breakdown has management_fee and correct SST", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.expenseBreakdown.rows).toHaveLength(1);
    const row = result!.expenseBreakdown.rows[0];
    expect(row.category).toBe("Management Fee");
    expect(row.amount).toBe("200.00");
    expect(row.sstAmount).toBe("16.00");
  });

  it("totalIncome matches grossRental from summarizeOwnerPeriod", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.totalIncome).toBe("2000.00");
  });

  it("deposit collected from findDepositsCollectedInMonth appears in payoutSummary", async () => {
    (findDepositsCollectedInMonth as ReturnType<typeof vi.fn>).mockResolvedValue([
      { unitId: LISTING_A, type: "security", amount: "4000.00" },
    ]);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.payoutSummary.depositCollected).toBe("4000.00");
    // Deposit line in the payout summary
    const depositLine = result!.payoutSummary.lines.find((l) => l.isNonIncome);
    expect(depositLine?.amount).toBe("4000.00");
  });

  it("vacant listing uses rentalRate as monthlyRental", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      {
        id: LISTING_B,
        rentalRate: dec("1800.00"),
        apartment: {
          unitCode: "B-10-05",
          propertyId: "prop-1",
          property: { name: "PV9 Residences" },
        },
        tenancies: [], // no active tenancy = vacant
      },
    ]);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.occupancy.rows[0].isVacant).toBe(true);
    expect(result!.occupancy.rows[0].monthlyRental).toBe("1800.00");
    expect(result!.occupancy.vacantCount).toBe(1);
    expect(result!.occupancy.occupiedCount).toBe(0);
  });

  it("carpark income shows incomeType Carpark", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "carpark_income",
        amount: dec("150.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
    ]);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.rows[0].incomeType).toBe("Carpark");
  });

  it("utility_income shows incomeType Shared Utility (not Monthly) with zero mgmt fee", async () => {
    // Tenant-borne shared utilities pass through as owner income. They must read as
    // "Shared Utility" — NOT fall through to "Monthly" like rent — and carry no mgmt fee
    // (utility income is excluded from FEE_INCOME_CATEGORIES).
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "utility_income",
        amount: dec("10.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
    ]);
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const row = result!.incomeBreakdown.rows[0];
    expect(row.incomeType).toBe("Shared Utility");
    expect(row.mgmtFee).toBe("0.00");
    expect(row.mgmtFeeSst).toBe("0.00");
  });

  // ─── B3: per-expense proof needs the RAW category + the statement apartmentId ──

  it("each §5 expense row exposes categoryKey = the RAW ledger category (guards the stale label map)", async () => {
    // A FULL TNB supplier bill (includeInPayout:true ⇒ NOT a display-only twin, so it
    // survives §5) + a cleaning expense whose human label ("Cleaning") DIFFERS from its
    // raw key ("cleaning"). categoryKey must be the RAW ledger category in BOTH cases —
    // never the categoryToExpenseLabel() human label — because the per-row attach posts
    // `category=<categoryKey>` and B2 keys proof off the raw OwnerLedgerEntry.category.
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("2000.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
      {
        direction: "expense",
        category: "utilities_tnb",
        amount: dec("123.45"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: "TNB June",
        remarks: null,
      },
      {
        direction: "expense",
        category: "cleaning",
        amount: dec("100.00"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: "Monthly cleaning",
        remarks: null,
      },
    ]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.expenseBreakdown.rows;

    // Pin: the TNB row carries the RAW "utilities_tnb" key.
    const tnb = rows.find((r) => r.categoryKey === "utilities_tnb");
    expect(tnb).toBeDefined();
    expect(tnb!.categoryKey).toBe("utilities_tnb");

    // Cleaning: human label "Cleaning" but raw key "cleaning".
    const cleaning = rows.find((r) => r.category === "Cleaning");
    expect(cleaning).toBeDefined();
    expect(cleaning!.categoryKey).toBe("cleaning");

    // The appended computed KAEN fee row carries the raw "management_fee" key too.
    const mgmt = rows.find((r) => r.category === "Management Fee");
    expect(mgmt).toBeDefined();
    expect(mgmt!.categoryKey).toBe("management_fee");

    // Every §5 row has a non-empty raw categoryKey.
    for (const r of rows) {
      expect(typeof r.categoryKey).toBe("string");
      expect(r.categoryKey.length).toBeGreaterThan(0);
    }
  });

  it("exposes the statement apartmentId on the sections payload (null when the Invoice is legacy-combined)", async () => {
    // Default invoice mock carries no apartmentId ⇒ null (legacy combined statement).
    const legacy = await assembleYannieStatement(ctx, STMT_ID);
    expect(legacy!.apartmentId).toBeNull();

    // A per-apartment statement Invoice carries an apartmentId ⇒ surfaced verbatim
    // so the per-row attach can post the matching apartment scope.
    const APT = "00000000-0000-0000-0000-0000000000aa";
    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: APT,
    });
    const perUnit = await assembleYannieStatement(ctx, STMT_ID);
    expect(perUnit!.apartmentId).toBe(APT);
  });

  // ─── Task B2 (#9): hide the RM0 shared-utility income row, render-side ──────

  it("hides zero shared utility row from incomeBreakdown.rows but keeps a non-zero one, totalIncome unchanged", async () => {
    // The owner's subsidy fully covered one room's utility share (0.00 line) while
    // a different room's share was only partly covered (15.00 line still owed).
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("2000.00"),
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
      {
        // Fully subsidised — the room's utility charge computed to RM0.00. This
        // render-only fix hides it; it is NOT a real receivable.
        direction: "income",
        category: "utility_income",
        amount: dec("0.00"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
      {
        // A different room's non-zero shared-utility income — must still appear.
        direction: "income",
        category: "utility_income",
        amount: dec("15.00"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "paid",
        description: null,
        remarks: null,
      },
    ]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.incomeBreakdown.rows;

    // No 0.00 Shared Utility row.
    expect(
      rows.find((r) => r.incomeType === "Shared Utility" && r.amount === "0.00"),
    ).toBeUndefined();

    // The non-zero Shared Utility row still appears.
    expect(
      rows.find((r) => r.incomeType === "Shared Utility" && r.amount === "15.00"),
    ).toBeDefined();

    // The non-utility (Monthly) row is unaffected — lineFees[i] alignment intact.
    expect(rows.find((r) => r.incomeType === "Monthly")).toBeDefined();

    // Only 2 rows render — the 0.00 row was dropped, nothing else was.
    expect(rows).toHaveLength(2);

    // totalIncome is unchanged: 2000.00 + 0.00 + 15.00 = 2015.00 (0 contributes 0).
    expect(result!.incomeBreakdown.totalIncome).toBe("2015.00");
  });

  it("does NOT hide a merely-unpaid utility_income row that still carries a real billed amount (collected-zero ≠ billed-zero)", async () => {
    // Real TNB carve-out of RM50.00 raised on the tenant this month but UNPAID.
    // OwnerLedgerEntry.amount for a utility_income row is COLLECTED
    // (billed − outstanding = 50 − 50 = 0.00) — owner-ledger.sync.ts
    // collectedString(). That is NOT the same "RM0" as task #9's fully-subsidised
    // case: chargedAmount (sourced from the Charge itself) stays 50.00 and
    // paymentStatus stays "pending". This is an ordinary unpaid receivable and
    // MUST remain visible, or the owner loses sight of money still owed to them.
    const CHARGE_ID = "00000000-0000-0000-0000-0000000000c1";
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "utility_income",
        amount: dec("0.00"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "pending",
        description: null,
        remarks: null,
        sourceChargeId: CHARGE_ID,
      },
    ]);
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: CHARGE_ID, amount: dec("50.00") }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.incomeBreakdown.rows;

    const pendingUtility = rows.find(
      (r) => r.incomeType === "Shared Utility" && r.paymentStatus === "pending",
    );
    expect(pendingUtility).toBeDefined();
    expect(pendingUtility!.chargedAmount).toBe("50.00");
    expect(pendingUtility!.amount).toBe("0.00");
  });

  // ─── §5 computed KAEN-fee row: status follows the TENANT, never a hardcode ─────
  //
  // Reported 2026-08-17: an owner statement showed "Management Fee … RM 0.24 … RM 0.02
  // … paid" while the tenant had not paid the rent. The row's paymentStatus was the
  // literal "paid". The AMOUNT and its payout deduction are correct and unchanged —
  // KAEN recovers the fee out of the payout either way — so these tests pin the label
  // only, and the deduction is re-asserted alongside so a future "fix" cannot quietly
  // stop deducting.
  const feeRowOf = (result: Awaited<ReturnType<typeof assembleYannieStatement>>) =>
    result!.expenseBreakdown.rows.find((r) => r.categoryKey === "management_fee");

  it("§5 fee row is 'paid' when the rent behind it is paid (happy path unchanged)", async () => {
    const result = await assembleYannieStatement(ctx, STMT_ID);
    const fee = feeRowOf(result);
    expect(fee).toBeDefined();
    expect(fee!.amount).toBe("200.00");
    expect(fee!.sstAmount).toBe("16.00");
    expect(fee!.paymentStatus).toBe("paid");
  });

  it("REGRESSION: a FIXED fee on unpaid rent reads 'pending', not 'paid' — and is still deducted", async () => {
    // The reported row, reproduced exactly: a flat RM 0.24 fee (+8% SST = RM 0.02).
    // computeManagementFee ignores rent entirely for feeType "fixed", so the fee is
    // charged against RM 0.00 collected — the case the hardcode mislabelled.
    dbMock.managementFeeConfig.findMany.mockResolvedValue([
      { propertyId: null, feeType: "fixed", feeValue: dec("0.24"), capAmount: null, sstPercent: dec("8"), updatedAt: PERIOD },
    ]);
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("0.00"), // collected = billed − outstanding; nothing paid
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "pending", // the tenant has NOT paid
        description: null,
        remarks: null,
      },
    ]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const fee = feeRowOf(result);
    expect(fee).toBeDefined();
    expect(fee!.amount).toBe("0.24");
    expect(fee!.sstAmount).toBe("0.02");
    expect(fee!.paymentStatus).toBe("pending"); // was "paid" — the reported bug
    // ⚠️ MONEY: still deducted in full. RM 0.24 + RM 0.02 = RM 0.26.
    expect(result!.expenseBreakdown.totalExpenses).toBe("0.26");
  });

  it("§5 fee row is 'partial' when the rent behind it is partially paid", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income",
        category: "rental_income",
        amount: dec("500.00"), // partial collection → percent fee of 50.00 + 4.00
        sstAmount: null,
        includeInPayout: false,
        taxCategory: "not_applicable",
        listingId: LISTING_A,
        statementMonth: PERIOD,
        paymentStatus: "partial",
        description: null,
        remarks: null,
      },
    ]);

    const fee = feeRowOf(await assembleYannieStatement(ctx, STMT_ID));
    expect(fee!.amount).toBe("50.00");
    expect(fee!.paymentStatus).toBe("partial");
  });

  it("§5 fee row is 'partial' when one unit's rent is paid and another's is not", async () => {
    dbMock.managementFeeConfig.findMany.mockResolvedValue([
      { propertyId: null, feeType: "fixed", feeValue: dec("10.00"), capAmount: null, sstPercent: dec("0"), updatedAt: PERIOD },
    ]);
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      {
        direction: "income", category: "rental_income", amount: dec("2000.00"), sstAmount: null,
        includeInPayout: false, taxCategory: "not_applicable", listingId: LISTING_A,
        statementMonth: PERIOD, paymentStatus: "paid", description: null, remarks: null,
      },
      {
        direction: "income", category: "rental_income", amount: dec("0.00"), sstAmount: null,
        includeInPayout: false, taxCategory: "not_applicable", listingId: LISTING_B,
        statementMonth: PERIOD, paymentStatus: "pending", description: null, remarks: null,
      },
    ]);

    const fee = feeRowOf(await assembleYannieStatement(ctx, STMT_ID));
    expect(fee!.paymentStatus).toBe("partial");
  });
});

describe("computedMgmtFeePaymentStatus", () => {
  it("all contributing lines paid → paid", () => {
    expect(computedMgmtFeePaymentStatus(["paid", "paid"])).toBe("paid");
  });

  it("no contributing line paid → pending (never silently claims paid)", () => {
    expect(computedMgmtFeePaymentStatus(["pending", "pending"])).toBe("pending");
  });

  it("a mix of paid and unpaid → partial", () => {
    expect(computedMgmtFeePaymentStatus(["paid", "pending"])).toBe("partial");
  });

  it("any partially-settled line drags the fee to partial", () => {
    expect(computedMgmtFeePaymentStatus(["partial"])).toBe("partial");
  });

  it("an unrecognised status is never treated as paid", () => {
    expect(computedMgmtFeePaymentStatus(["completed"])).toBe("pending");
    expect(computedMgmtFeePaymentStatus(["cancelled"])).toBe("pending");
  });

  it("empty (unreachable while the row only emits on a non-zero fee) fails to pending", () => {
    expect(computedMgmtFeePaymentStatus([])).toBe("pending");
  });
});
