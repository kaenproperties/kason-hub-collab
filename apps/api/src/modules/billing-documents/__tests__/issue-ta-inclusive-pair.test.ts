import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: vi.fn((flag: string) => flag === "ENABLE_PHASE2_BILLING_DOCS"),
}));
vi.mock("../../charge-categories/seed", () => ({ ensureChargeCategorySeeds: vi.fn() }));
vi.mock("../../../lib/reference-codes/series-numbers", () => ({
  mintDocumentNumberTx: vi.fn(async () => "IVTEN-0001"),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));

import { issueDocumentsForChargesTx } from "../issue.service";

const parent = {
  id: "ta-base",
  organizationId: "org-1",
  chargeNumber: "TA-1",
  chargeType: "tenancy_agreement_fee",
  status: "posted",
  categoryId: "cat-ta",
  description: "TA",
  amount: { toString: () => "462.96" },
  sstRate: { toString: () => "8" },
  parentChargeId: null,
  invoiceId: "inv-1",
  currency: "MYR",
  dueDate: new Date("2026-08-15T00:00:00.000Z"),
  billingMonth: new Date("2026-08-01T00:00:00.000Z"),
  partyId: "party-1",
  tenancyId: "tenancy-1",
  unitId: "unit-1",
  unit: null,
  commercialPurpose: "manager_service",
  fundedBy: "tenant",
  revenueRecognition: "manager_revenue",
  settlementRecipient: "manager",
  nonBillable: false,
};

const child = {
  ...parent,
  id: "ta-tax",
  chargeNumber: "TA-1-SST",
  amount: { toString: () => "37.04" },
  sstRate: { toString: () => "0" },
  parentChargeId: parent.id,
};

function txFor(requested: unknown[], closure: unknown[]) {
  type CreateInput = {
    data: {
      subtotal: unknown;
      sstAmount: unknown;
      total: unknown;
      lines: { create: unknown[] };
    };
  };
  const create = vi.fn(async (_input: CreateInput) => ({ id: "doc-1", documentNumber: "IVTEN-0001" }));
  const tx = {
    charge: {
      findMany: vi.fn()
        .mockResolvedValueOnce(requested)
        .mockResolvedValueOnce(closure),
      update: vi.fn(),
    },
    chargeCategory: {
      findFirst: vi.fn(async () => ({
        id: "cat-ta",
        name: "Tenancy Agreement Fee",
        defaultSstRate: { toString: () => "8" },
        docType: "invoice",
        family: "tenant_income",
        seriesId: "series-ivten",
      })),
    },
    billingDocumentLine: { findMany: vi.fn(async () => []) },
    billingDocument: { findFirst: vi.fn(async () => null), create },
    documentSeries: {
      findFirst: vi.fn(async () => ({
        id: "series-ivten",
        code: "IVTEN",
        prefix: "IVTEN",
        padding: 4,
        includeYear: false,
        active: true,
      })),
    },
  };
  return { tx: tx as never, create };
}

describe("issueDocumentsForChargesTx — inclusive TA pair", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["base", [parent]],
    ["tax child", [child]],
  ])("closes a request containing only the %s over the full pair", async (_label, requested) => {
    const { tx, create } = txFor(requested, [parent, child]);

    await issueDocumentsForChargesTx(tx, requested.map((charge) => charge.id), "actor-1");

    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ subtotal: "462.96", sstAmount: "37.04", total: "500.00" });
    expect(data.lines.create).toEqual([
      expect.objectContaining({ chargeId: "ta-base", amount: "462.96", sstAmount: "37.04", isTax: false }),
      expect.objectContaining({ chargeId: "ta-tax", amount: "37.04", sstAmount: "0.00", isTax: true }),
    ]);
  });

  it("rejects a mixed draft/live pair before a document is created", async () => {
    const draftChild = { ...child, status: "draft" };
    const { tx, create } = txFor([parent], [parent, draftChild]);

    await expect(issueDocumentsForChargesTx(tx, [parent.id], "actor-1"))
      .rejects.toThrow("TA_TAX_PAIR_NOT_POSTED");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects amounts that are not the exact inclusive 8% split", async () => {
    const wrongChild = { ...child, amount: { toString: () => "37.03" } };
    const { tx, create } = txFor([parent], [parent, wrongChild]);

    await expect(issueDocumentsForChargesTx(tx, [parent.id], "actor-1"))
      .rejects.toThrow("TA_TAX_PAIR_AMOUNT_INVALID");
    expect(create).not.toHaveBeenCalled();
  });
});
