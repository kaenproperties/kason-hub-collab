import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  charge: { findMany: vi.fn() },
  billingDocumentLine: { findMany: vi.fn() },
  apartment: { findMany: vi.fn() },
  paymentAllocationReversal: { findMany: vi.fn() },
};

vi.mock("@kason/db", () => ({ getDb: () => db }));

import { getProfitability } from "../service";

const baseCharge = {
  id: "charge-ta-base",
  organizationId: "org-1",
  party: { id: "tenant-1", displayName: "Tenant One" },
  category: { name: "Tenancy Agreement Fee", code: "tenancy_agreement_fee", defaultSstRate: 8 },
  unit: { apartment: { unitCode: "A-02-02", property: { name: "Kensho Residence" } } },
  tenancy: { tenancyCode: "TEN-001" },
  sourceGridExpense: null,
  sourceGridExpenseId: null,
  allocations: [],
  amount: "462.96",
  actualCost: null,
  outstandingAmount: "462.96",
  sstRate: "8",
  taxRate: null,
  chargeNumber: "CHG-BASE",
  chargeType: "tenancy_agreement_fee",
  description: "Admin and Agreement Fee",
  billingMonth: new Date("2026-08-01T00:00:00.000Z"),
  postedAt: new Date("2026-08-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

const taxCharge = {
  ...baseCharge,
  id: "charge-ta-tax",
  amount: "37.04",
  outstandingAmount: "37.04",
  sstRate: "0",
  chargeNumber: "CHG-TAX",
  description: "SST on Admin and Agreement Fee",
};

describe("getProfitability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.apartment.findMany.mockResolvedValue([]);
    db.paymentAllocationReversal.findMany.mockResolvedValue([]);
  });

  it("keeps the inclusive-SST base as revenue and excludes its tax sibling", async () => {
    db.charge.findMany.mockResolvedValue([baseCharge, taxCharge]);
    db.billingDocumentLine.findMany.mockResolvedValue([
      {
        chargeId: baseCharge.id,
        isTax: false,
        sstAmount: "37.04",
        document: { apartmentId: null },
      },
      {
        chargeId: taxCharge.id,
        isTax: true,
        sstAmount: "0.00",
        document: { apartmentId: null },
      },
    ]);

    const result = await getProfitability("org-1", { view: "tenant", month: "2026-08" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      itemCount: 1,
      chargesBeforeSst: "462.96",
      grossProfit: "462.96",
    });
    expect(result.rows[0]?.details).toEqual([
      expect.objectContaining({
        id: baseCharge.id,
        chargedBeforeSst: "462.96",
        sst: "37.04",
      }),
    ]);
    expect(result.totals).toMatchObject({
      chargesBeforeSst: "462.96",
      grossProfit: "462.96",
    });
  });
});
