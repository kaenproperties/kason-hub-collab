import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  feeFindMany: vi.fn(),
  listingFindMany: vi.fn(),
  unitMonthUpsert: vi.fn(),
  unitMonthDeleteMany: vi.fn(),
  findLedgerRows: vi.fn(),
  findReceivableRows: vi.fn(),
  findDeposits: vi.fn(),
}));

vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return {
    ...actual,
    getDb: () => ({
      managementFeeConfig: { findMany: mocks.feeFindMany },
      listing: { findMany: mocks.listingFindMany },
      unitMonthLedger: {
        upsert: mocks.unitMonthUpsert,
        deleteMany: mocks.unitMonthDeleteMany,
      },
    }),
  };
});

vi.mock("../../owner-billing/owner-statement-sections", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../owner-billing/owner-statement-sections")
  >();
  return {
    ...actual,
    findOwnerLedgerRowsForMonth: mocks.findLedgerRows,
    fetchOwnerReceivablePayoutRows: mocks.findReceivableRows,
  };
});

vi.mock("../../owner-billing/owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../owner-billing/owner-billing.repository")
  >();
  return {
    ...actual,
    findDepositsCollectedInMonth: mocks.findDeposits,
  };
});

import { materializeOwnerUnitMonths } from "../unit-month-ledger.materialize";

const decimal = (value: string) => ({ toString: () => value });
const updatedAt = new Date("2026-08-22T12:00:00.000Z");

describe("materializeOwnerUnitMonths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.feeFindMany.mockResolvedValue([]);
    mocks.listingFindMany.mockResolvedValue([{ id: "listing-1", apartmentId: "apt-1" }]);
    mocks.findDeposits.mockResolvedValue([{ unitId: "listing-1", amount: "1075.81" }]);
    mocks.unitMonthUpsert.mockResolvedValue({});
    mocks.unitMonthDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("deducts IVOWN owner receivables exactly like the live owner report", async () => {
    mocks.findLedgerRows.mockResolvedValue([
      {
        direction: "income",
        category: "rent",
        amount: decimal("774.19"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "rental",
        propertyId: "property-1",
        apartmentId: "apt-1",
        updatedAt,
      },
    ]);
    mocks.findReceivableRows.mockResolvedValue([
      {
        direction: "expense",
        category: "owner_receivable",
        amount: decimal("500.00"),
        sstAmount: decimal("0.00"),
        includeInPayout: true,
        taxCategory: "expense",
        propertyId: "property-1",
        apartmentId: "apt-1",
        updatedAt,
      },
      {
        direction: "expense",
        category: "owner_receivable",
        amount: decimal("77.00"),
        sstAmount: decimal("6.16"),
        includeInPayout: true,
        taxCategory: "expense",
        propertyId: "property-1",
        apartmentId: "apt-1",
        updatedAt,
      },
    ]);

    await materializeOwnerUnitMonths(
      { orgId: "org-1", actorUserId: "user-1", actorRole: "admin" },
      "owner-1",
      "2026-08",
    );

    expect(mocks.findReceivableRows).toHaveBeenCalledWith(
      "org-1",
      "owner-1",
      new Date("2026-08-01T00:00:00.000Z"),
      "apt-1",
      expect.any(Array),
    );
    expect(mocks.unitMonthUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          incomeC: 77419,
          deductibleExpensesC: 58316,
          netPayoutC: 126684,
          ownerTopUpC: 0,
        }),
        update: expect.objectContaining({
          incomeC: 77419,
          deductibleExpensesC: 58316,
          netPayoutC: 126684,
          ownerTopUpC: 0,
        }),
      }),
    );
  });

  it("materializes an owner top-up when only an owner receivable exists", async () => {
    mocks.findLedgerRows.mockResolvedValue([]);
    mocks.findDeposits.mockResolvedValue([]);
    mocks.findReceivableRows.mockResolvedValue([
      {
        direction: "expense",
        category: "owner_receivable",
        amount: decimal("500.00"),
        sstAmount: null,
        includeInPayout: true,
        taxCategory: "expense",
        propertyId: "property-1",
        apartmentId: "apt-1",
        updatedAt,
      },
    ]);

    await materializeOwnerUnitMonths(
      { orgId: "org-1", actorUserId: "user-1", actorRole: "admin" },
      "owner-1",
      "2026-08",
    );

    expect(mocks.unitMonthUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ netPayoutC: 0, ownerTopUpC: 50000 }),
        update: expect.objectContaining({ netPayoutC: 0, ownerTopUpC: 50000 }),
      }),
    );
  });
});
