// apps/api/src/modules/billing/__tests__/mint-on-post-invariant.test.ts
// B5 (2026-07-04 spec, amended): pins the mint-on-post invariant.
// (a) flag-ON manual post mints in-tx; (b) auto-draft approve never posts
// charges, so it can never create an undocumented posted charge.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { txMock, chargeUpdateMock, chargeUpdateManyMock, chargeEventCreateMock, chargeFindManyMock, invoiceUpdateMock } = vi.hoisted(() => ({
  txMock: vi.fn(),
  chargeUpdateMock: vi.fn(),
  chargeUpdateManyMock: vi.fn(),
  chargeEventCreateMock: vi.fn(),
  chargeFindManyMock: vi.fn(),
  invoiceUpdateMock: vi.fn(),
}));

vi.mock("@kason/db", async (orig) => ({
  ...(await orig()),
  getDb: () => ({ $transaction: txMock }),
}));
vi.mock("../../billing-documents/issue.service", () => ({ issueDocumentsForChargesTx: vi.fn() }));
vi.mock("../../billing-documents/credit-notes.service", async (orig) => ({ ...(await orig()) }));
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled: vi.fn(() => true) }));
vi.mock("../billing.repository", async (orig) => ({
  ...(await orig()),
  // unitId: null → the owner-billing guard's listing scope is null, a documented
  // no-op (this test is about mint-on-post atomicity, not owner-billing readiness).
  // isPhase2FlagEnabled is mocked to always return true (line below) — WITHOUT a
  // null unitId, the guard would try to resolve a listing owner against this
  // file's fake tx (no `.listing` property) and throw.
  findChargeById: vi.fn().mockResolvedValue({
    id: "charge-1", chargeNumber: "CHG-1", chargeType: "rent", status: "draft",
    parentChargeId: null, invoiceId: null, sstRate: null,
    unitId: null, billingMonth: null, dueDate: new Date("2026-06-15"),
  }),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges: vi.fn() }));

import { issueDocumentsForChargesTx } from "../../billing-documents/issue.service";
import { findChargeById } from "../billing.repository";
import { postChargeService } from "../billing.service";
import { approveInvoiceService } from "../auto-draft.service";

const session = { orgId: "org1", userId: "u1", role: "admin" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findChargeById).mockResolvedValue({
    id: "charge-1", chargeNumber: "CHG-1", chargeType: "rent", status: "draft",
    parentChargeId: null, invoiceId: null, sstRate: null,
    unitId: null, billingMonth: null, dueDate: new Date("2026-06-15"),
  });
  chargeUpdateManyMock.mockResolvedValue({ count: 1 });
  chargeFindManyMock.mockResolvedValue([{ id: "charge-1", status: "draft" }]);
  txMock.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      charge: {
        update: chargeUpdateMock,
        updateMany: chargeUpdateManyMock,
        findMany: chargeFindManyMock,
      },
      chargeEvent: { create: chargeEventCreateMock },
      invoice: { update: invoiceUpdateMock.mockResolvedValue({ id: "inv-1" }) },
    }),
  );
});

describe("mint-on-post invariant (B5)", () => {
  it("manual post mints: issueDocumentsForChargesTx called with the chargeId inside the tx", async () => {
    await postChargeService(session, { chargeId: "charge-1" });
    expect(vi.mocked(issueDocumentsForChargesTx)).toHaveBeenCalledWith(
      expect.anything(), ["charge-1"], "u1",
    );
    expect(chargeUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "posted" }) }),
    );
  });

  it("approve (flag on) posts the invoice's draft charges AND mints their documents", async () => {
    await approveInvoiceService(
      { orgId: "org1", actorUserId: "u1", actorRole: "admin" } as never,
      "inv-1",
      new Date().toISOString(),
    );
    expect(invoiceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "approved" }) }),
    );
    // Draft charges flip to posted…
    expect(chargeUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "posted" }) }),
    );
    // …AND their documents are minted in the same tx → no undocumented posted charge.
    expect(vi.mocked(issueDocumentsForChargesTx)).toHaveBeenCalledWith(
      expect.anything(), ["charge-1"], "u1",
    );
  });

  it("manual post promotes and issues an inclusive TA base + SST sibling atomically", async () => {
    const parent = {
      id: "ta-base", chargeNumber: "TA-1", chargeType: "tenancy_agreement_fee", status: "draft",
      parentChargeId: null, invoiceId: "inv-1", sstRate: { toString: () => "8" },
      unitId: null, billingMonth: null, dueDate: new Date("2026-06-15"),
    };
    const child = {
      id: "ta-tax", chargeNumber: "TA-1-SST", chargeType: "tenancy_agreement_fee", status: "draft",
      parentChargeId: "ta-base", invoiceId: "inv-1", sstRate: { toString: () => "0" },
    };
    vi.mocked(findChargeById).mockResolvedValue(parent as never);
    chargeFindManyMock.mockResolvedValue([parent, child]);
    chargeUpdateManyMock.mockResolvedValue({ count: 2 });

    const result = await postChargeService(session, { chargeId: parent.id });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(chargeUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["ta-base", "ta-tax"] }, status: "draft" }),
    }));
    expect(chargeEventCreateMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(issueDocumentsForChargesTx)).toHaveBeenCalledWith(
      expect.anything(), ["ta-base", "ta-tax"], "u1",
    );
  });

  it("manual post rejects a mixed-status TA pair before either leg is changed", async () => {
    const parent = {
      id: "ta-base", chargeNumber: "TA-1", chargeType: "tenancy_agreement_fee", status: "draft",
      parentChargeId: null, invoiceId: "inv-1", sstRate: { toString: () => "8" },
      unitId: null, billingMonth: null, dueDate: new Date("2026-06-15"),
    };
    vi.mocked(findChargeById).mockResolvedValue(parent as never);
    chargeFindManyMock.mockResolvedValue([
      parent,
      {
        id: "ta-tax", chargeNumber: "TA-1-SST", chargeType: "tenancy_agreement_fee", status: "posted",
        parentChargeId: "ta-base", invoiceId: "inv-1", sstRate: { toString: () => "0" },
      },
    ]);

    const result = await postChargeService(session, { chargeId: parent.id });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "TA_TAX_PAIR_POST_REQUIRES_COMPLETE_DRAFT_PAIR",
    });
    expect(chargeUpdateMock).not.toHaveBeenCalled();
    expect(chargeUpdateManyMock).not.toHaveBeenCalled();
    expect(issueDocumentsForChargesTx).not.toHaveBeenCalled();
  });

  it("auto-draft approval rejects a mixed draft/live TA pair before posting", async () => {
    chargeFindManyMock.mockResolvedValue([
      {
        id: "ta-base", chargeNumber: "TA-1", chargeType: "tenancy_agreement_fee", status: "draft",
        parentChargeId: null, sstRate: { toString: () => "8" },
      },
      {
        id: "ta-tax", chargeNumber: "TA-1-SST", chargeType: "tenancy_agreement_fee", status: "posted",
        parentChargeId: "ta-base", sstRate: { toString: () => "0" },
      },
    ]);

    await expect(approveInvoiceService(
      { orgId: "org1", actorUserId: "u1", actorRole: "admin" } as never,
      "inv-1",
      new Date().toISOString(),
    )).rejects.toThrow("TA_TAX_PAIR_MIXED_STATUS");
    expect(chargeUpdateManyMock).not.toHaveBeenCalled();
    expect(issueDocumentsForChargesTx).not.toHaveBeenCalled();
  });
});
