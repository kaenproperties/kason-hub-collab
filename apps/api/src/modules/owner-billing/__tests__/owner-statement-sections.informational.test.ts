/**
 * §4 informational rows — the letting-commission explanation line.
 *
 * owner-ledger.sync.ts books the first month's rent as an `informational` row
 * ("First month rental retained by KAEN as Admin Fee") specifically so a
 * commission month does not read as a blank statement. §4 previously filtered the
 * ledger to direction "income"/"expense" only, so that row reached no surface: the
 * owner saw RM 0.00 income beside an unexplained owner-borne SST deduction.
 *
 * These tests pin BOTH halves of the contract:
 *   1. the row is surfaced, and
 *   2. it never touches totalIncome, passThroughIncome, or any management fee.
 *
 * (2) is the money-critical half. owner-ledger.sync.ts:626-631 refuses to book
 * letting commission as income precisely because the per-line management fee is
 * aligned 1:1 with the income rows — an income row here would bill the owner a
 * management fee on rent they never received.
 *
 * Run:
 *   npx vitest run owner-statement-sections.informational
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

vi.mock("@kason/db", () => ({ getDb: vi.fn() }));
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
const RENT_CHARGE = "charge-aaaa-0000-0000-000000000001";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u1", actorRole: "admin" };
const dec = (s: string) => ({ toString: () => s });
const PERIOD = new Date("2026-08-01T00:00:00.000Z");

function makeLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    direction: "income",
    category: "rental_income",
    amount: dec("0.00"),
    sstAmount: null,
    includeInPayout: true,
    taxCategory: "not_applicable",
    propertyId: "prop-1",
    apartmentId: APT_1,
    listingId: LISTING_A,
    statementMonth: PERIOD,
    paymentStatus: "pending",
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
    description: null,
    remarks: null,
    sourceType: "rent",
    sourceChargeId: null,
    sourceUtilityBillId: null,
    ...overrides,
  };
}

/** The row owner-ledger.sync.ts actually writes for a commission month. */
function lettingCommissionRow(amount = "3000.00") {
  return makeLedgerRow({
    direction: "informational",
    category: "letting_commission",
    amount: dec(amount),
    includeInPayout: false,
    paymentStatus: "paid",
    description: "First month rental retained by KAEN as Admin Fee",
    sourceType: "letting_commission",
  });
}

function makeListing() {
  return {
    id: LISTING_A,
    apartmentId: APT_1,
    rentalRate: dec("3000.00"),
    unitKind: null,
    apartment: {
      unitCode: "A-01-01",
      propertyId: "prop-1",
      property: { name: "Kason Residences" },
    },
    tenancies: [
      {
        startDate: new Date("2026-08-01"),
        endDate: null,
        monthlyRentAmount: dec("3000.00"),
        depositAmount: dec("3000.00"),
        tenantParty: { displayName: "Demo Tenant" },
      },
    ],
  };
}

describe("assembleYannieStatement — informational (letting commission) rows", () => {
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

  beforeEach(() => {
    dbMock = {
      invoice: { findFirst: vi.fn() },
      party: { findFirst: vi.fn() },
      ownerLedgerEntry: { findMany: vi.fn() },
      listing: { findMany: vi.fn() },
      managementFeeConfig: { findMany: vi.fn() },
      charge: { findMany: vi.fn() },
      // §5 owner-receivable itemisation reads the IVOWN series + its document lines.
      documentSeries: { findFirst: vi.fn() },
      billingDocumentLine: { findMany: vi.fn() },
      unitUtilityBill: { findMany: vi.fn() },
    };
    (getDb as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);
    (findDepositsCollectedInMonth as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // No IVOWN series/lines by default ⇒ §5 gains no owner-receivable rows, so every
    // pre-existing expectation in these suites stays byte-identical.
    dbMock.documentSeries.findFirst.mockResolvedValue(null);
    dbMock.billingDocumentLine.findMany.mockResolvedValue([]);

    dbMock.invoice.findFirst.mockResolvedValue({
      id: STMT_ID,
      ownerPartyId: OWNER_ID,
      periodMonth: PERIOD,
      apartmentId: null,
    });
    dbMock.party.findFirst.mockResolvedValue({
      displayName: "Demo Owner",
      bankName: "Maybank",
      bankAccountHolder: "Demo Owner",
      bankAccountNumber: "5141223344",
    });
    dbMock.charge.findMany.mockResolvedValue([]);
    dbMock.unitUtilityBill.findMany.mockResolvedValue([]);
    dbMock.listing.findMany.mockResolvedValue([makeListing()]);
    // A REAL 10% + 8% SST fee config — so a fee wrongly charged on the
    // informational row would show up as a non-zero figure below.
    dbMock.managementFeeConfig.findMany.mockResolvedValue([
      {
        propertyId: null,
        feeType: "percentage",
        feeValue: dec("10"),
        capAmount: null,
        sstPercent: dec("8"),
        updatedAt: new Date("2026-01-01"),
      },
    ]);
  });

  it("surfaces the letting-commission row in the income breakdown", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([lettingCommissionRow()]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.incomeBreakdown.rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.isInformational).toBe(true);
    expect(rows[0]!.incomeType).toBe("Admin Fee (First Month Rental)");
    expect(rows[0]!.amount).toBe("3000.00");
  });

  it("carries the ledger's own explanation through as the row detail", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([lettingCommissionRow()]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.rows[0]!.detail).toBe(
      "First month rental retained by KAEN as Admin Fee",
    );
  });

  it("MONEY: contributes nothing to totalIncome", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([lettingCommissionRow()]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.totalIncome).toBe("0.00");
  });

  it("MONEY: contributes nothing to passThroughIncome either", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([lettingCommissionRow()]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    expect(result!.incomeBreakdown.passThroughIncome).toBe("0.00");
  });

  it("MONEY: attracts NO management fee — the owner never received this rent", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([lettingCommissionRow()]);

    const result = await assembleYannieStatement(ctx, STMT_ID);
    // 10% of 3000 would be 300.00 — a fee on rent that went to KAEN, not the owner.
    expect(result!.incomeBreakdown.rows[0]!.mgmtFee).toBe("0.00");
    expect(result!.incomeBreakdown.rows[0]!.mgmtFeeSst).toBe("0.00");
    expect(result!.incomeBreakdown.totalMgmtFee).toBe("0.00");
  });

  it("MONEY: a real income row alongside it keeps its OWN fee correctly aligned", async () => {
    // The regression that matters: informational rows are appended AFTER the
    // fee-aligned map. If they ever entered that map, lineFees[i] would shift and
    // this real row would be charged the wrong line's fee (or none at all).
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      lettingCommissionRow(),
      makeLedgerRow({
        amount: dec("1000.00"),
        paymentStatus: "paid",
        sourceChargeId: RENT_CHARGE,
      }),
    ]);
    // Serves the Task-6 charged-amount lookup only; the derived tenant-paid-
    // expense scan (discriminated by its sourceGridExpenseId filter) sees none.
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: RENT_CHARGE, amount: dec("1000.00"), description: null }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.incomeBreakdown.rows;

    const real = rows.find((r) => !r.isInformational)!;
    const info = rows.find((r) => r.isInformational)!;

    // Real rent row: 10% of 1000 = 100.00, SST 8% of that = 8.00.
    expect(real.mgmtFee).toBe("100.00");
    expect(real.mgmtFeeSst).toBe("8.00");
    // Informational row still fee-free.
    expect(info.mgmtFee).toBe("0.00");
    // Only the real row is income.
    expect(result!.incomeBreakdown.totalIncome).toBe("1000.00");
    expect(result!.incomeBreakdown.totalMgmtFee).toBe("108.00");
  });

  it("statements with no informational rows are completely unchanged", async () => {
    dbMock.ownerLedgerEntry.findMany.mockResolvedValue([
      makeLedgerRow({ amount: dec("1000.00"), paymentStatus: "paid", sourceChargeId: RENT_CHARGE }),
    ]);
    // Serves the Task-6 charged-amount lookup only; the derived tenant-paid-
    // expense scan (discriminated by its sourceGridExpenseId filter) sees none.
    dbMock.charge.findMany.mockImplementation(async (args: { where?: { sourceGridExpenseId?: unknown } }) =>
      args?.where?.sourceGridExpenseId ? [] : [{ id: RENT_CHARGE, amount: dec("1000.00"), description: null }],
    );

    const result = await assembleYannieStatement(ctx, STMT_ID);
    const rows = result!.incomeBreakdown.rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.isInformational).toBe(false);
    expect(result!.incomeBreakdown.totalIncome).toBe("1000.00");
  });
});
