import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createChargeService,
  getChargesService,
  postChargeService,
  voidChargeService,
} from "../billing.service";

import * as repo from "../billing.repository";
import { issueDocumentsForChargesTx } from "../../billing-documents/issue.service";

vi.mock("../billing.repository", () => ({
  listCharges: vi.fn(),
  countCharges: vi.fn(),
  findChargeByNumber: vi.fn(),
  findChargeById: vi.fn(),
  findChargeCategoryForCreate: vi.fn(),
  findActiveDuplicateCharge: vi.fn(),
  createCharge: vi.fn(),
  updateChargeStatus: vi.fn(),
  createChargeEvent: vi.fn(),
}));

// postChargeService now runs its writes inside db.$transaction — hand the
// callback a shared fake tx so the tests can assert the in-tx calls.
const { txMock } = vi.hoisted(() => ({
  txMock: {
    charge: { update: vi.fn().mockResolvedValue({}) },
    chargeEvent: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  }),
}));

vi.mock("../../billing-documents/issue.service", () => ({
  issueDocumentsForChargesTx: vi.fn().mockResolvedValue(undefined),
}));

const mockedRepo = vi.mocked(repo);

const session = {
  userId: "user-1",
  orgId: "org-1",
  role: "admin",
};

describe("billing.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // These two legacy-path tests predate CATEGORY_REQUIRED enforcement and the
    // void→CN delegation and don't mock either code path — they must run with
    // the flag dark regardless of the ambient process env (a full-suite run
    // with ENABLE_PHASE2_BILLING_DOCS=1 set globally would otherwise leak in).
    // Tests further down that need it ON set it explicitly per-test.
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    // Spec2 R1 dedup guard: none of this file's createChargeService calls set a
    // real unitId, so the guard is always skipped — default to "no dup found"
    // for hygiene/future-proofing in case a later test adds one.
    mockedRepo.findActiveDuplicateCharge.mockResolvedValue(null);
  });

  it("rejects duplicate charge numbers", async () => {
    mockedRepo.findChargeByNumber.mockResolvedValueOnce({ id: "c-1" });

    const result = await createChargeService(session, {
      chargeNumber: "CHG-001",
      partyId: "11111111-1111-1111-1111-111111111111",
      chargeType: "rent",
      dueDate: "2026-04-15",
      amount: "1500",
      currency: "MYR",
      description: "Monthly rental",
      tenancyId: "",
      unitId: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("already exists");
    }
  });

  it("creates charge and logs event", async () => {
    mockedRepo.findChargeByNumber.mockResolvedValueOnce(null);
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-1" });

    const result = await createChargeService(session, {
      chargeNumber: "CHG-002",
      partyId: "11111111-1111-1111-1111-111111111111",
      chargeType: "rent",
      dueDate: "2026-04-15",
      amount: "2500",
      currency: "MYR",
      description: "Monthly rental",
      tenancyId: "",
      unitId: "",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.data.id).toBe("charge-1");
    }

    expect(mockedRepo.createChargeEvent).toHaveBeenCalledTimes(1);
  });

  it("prevents posting void charge", async () => {
    mockedRepo.findChargeById.mockResolvedValueOnce({
      id: "charge-1", chargeNumber: "CHG-001", chargeType: "rent", status: "void", parentChargeId: null, invoiceId: null, sstRate: null, unitId: null, billingMonth: null, dueDate: new Date("2026-04-15"),
    });

    const result = await postChargeService(session, { chargeId: "charge-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("Cannot post a void charge");
    }
  });

  it("voids a charge and records event", async () => {
    mockedRepo.findChargeById.mockResolvedValueOnce({
      id: "charge-1", chargeNumber: "CHG-001", chargeType: "rent", status: "posted", parentChargeId: null, invoiceId: null, sstRate: null, unitId: null, billingMonth: null, dueDate: new Date("2026-04-15"),
    });

    const result = await voidChargeService(session, {
      chargeId: "charge-1",
      reason: "Duplicate invoice",
    });

    expect(result.ok).toBe(true);
    expect(mockedRepo.updateChargeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: "charge-1",
        status: "void",
      }),
    );
    expect(mockedRepo.createChargeEvent).toHaveBeenCalledTimes(1);
  });

  it("postChargeService mints the charge's document INSIDE the posting tx (flag on)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    try {
      mockedRepo.findChargeById.mockResolvedValueOnce({
        id: "charge-9", chargeNumber: "CHG-009", chargeType: "rent", status: "draft", parentChargeId: null, invoiceId: null, sstRate: null, unitId: null, billingMonth: null, dueDate: new Date("2026-04-15"),
      });
      const result = await postChargeService(session, { chargeId: "charge-9" });
      expect(result.ok).toBe(true);
      expect(txMock.charge.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "charge-9" } }),
      );
      expect(txMock.chargeEvent.create).toHaveBeenCalledTimes(1);
      // Called with the SAME tx the status flip used — that's the atomicity seam.
      expect(issueDocumentsForChargesTx).toHaveBeenCalledWith(txMock, ["charge-9"], "user-1");
    } finally {
      delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    }
  });

  it("postChargeService flag dark: posts the charge with NO mint call (byte-identical legacy behavior)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    mockedRepo.findChargeById.mockResolvedValueOnce({
      id: "charge-10", chargeNumber: "CHG-010", chargeType: "rent", status: "draft", parentChargeId: null, invoiceId: null, sstRate: null, unitId: null, billingMonth: null, dueDate: new Date("2026-04-15"),
    });
    const result = await postChargeService(session, { chargeId: "charge-10" });
    expect(result.ok).toBe(true);
    expect(txMock.charge.update).toHaveBeenCalledTimes(1);
    expect(issueDocumentsForChargesTx).not.toHaveBeenCalled();
  });

  it("postChargeService: a mint failure aborts the posting (tx rejects, spec §4.6)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    try {
      mockedRepo.findChargeById.mockResolvedValueOnce({
        id: "charge-11", chargeNumber: "CHG-011", chargeType: "rent", status: "draft", parentChargeId: null, invoiceId: null, sstRate: null, unitId: null, billingMonth: null, dueDate: new Date("2026-04-15"),
      });
      vi.mocked(issueDocumentsForChargesTx).mockRejectedValueOnce(new Error("DOCUMENT_CATEGORY_UNRESOLVED"));
      await expect(postChargeService(session, { chargeId: "charge-11" })).rejects.toThrow(
        "DOCUMENT_CATEGORY_UNRESOLVED",
      );
    } finally {
      delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    }
  });
});

describe("getChargesService — pagination (spec §4.8 gap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no pagination arg → returns { data } only, no `total`, countCharges never called (byte-identical legacy shape)", async () => {
    const fullList = [{ id: "c1" }, { id: "c2" }];
    mockedRepo.listCharges.mockResolvedValueOnce(fullList as never);

    const result = await getChargesService(session);

    expect(result).toEqual({ data: fullList });
    expect("total" in result).toBe(false);
    expect(mockedRepo.listCharges).toHaveBeenCalledWith(session.orgId, undefined, undefined);
    expect(mockedRepo.countCharges).not.toHaveBeenCalled();
  });

  it("pagination arg → returns { data, total } and forwards page/pageSize to listCharges", async () => {
    const pageSlice = [{ id: "c26" }];
    mockedRepo.listCharges.mockResolvedValueOnce(pageSlice as never);
    mockedRepo.countCharges.mockResolvedValueOnce(137);

    const result = await getChargesService(session, { page: 2, pageSize: 25 });

    expect(result).toEqual({ data: pageSlice, total: 137 });
    expect(mockedRepo.listCharges).toHaveBeenCalledWith(session.orgId, { page: 2, pageSize: 25 }, undefined);
    expect(mockedRepo.countCharges).toHaveBeenCalledWith(session.orgId, undefined);
  });
});

describe("createChargeService — category enforcement (ENABLE_PHASE2_BILLING_DOCS)", () => {
  const CAT_ID = "22222222-2222-4222-8222-222222222222";
  const BASE_INPUT = {
    chargeNumber: "CHG-CAT-1",
    partyId: "11111111-1111-1111-1111-111111111111",
    chargeType: "rental",
    dueDate: "2026-07-01",
    amount: "1500",
    currency: "MYR",
    description: "Monthly rental",
    tenancyId: "" as const,
    unitId: "" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findChargeByNumber.mockResolvedValue(null);
    mockedRepo.createCharge.mockResolvedValue({ id: "charge-1" });
    // Spec2 R1 dedup guard: BASE_INPUT has no unitId, so the guard is always
    // skipped here too — default to "no dup found" for hygiene.
    mockedRepo.findActiveDuplicateCharge.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("flag ON + no categoryId → 400 CATEGORY_REQUIRED", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    const result = await createChargeService(session, BASE_INPUT);
    expect(result).toMatchObject({ ok: false, status: 400, error: "CATEGORY_REQUIRED" });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("flag ON + unknown category → 400 CATEGORY_NOT_FOUND; inactive → 400 CATEGORY_INACTIVE", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    mockedRepo.findChargeCategoryForCreate.mockResolvedValueOnce(null);
    const missing = await createChargeService(session, { ...BASE_INPUT, categoryId: CAT_ID });
    expect(missing).toMatchObject({ ok: false, status: 400, error: "CATEGORY_NOT_FOUND" });

    mockedRepo.findChargeCategoryForCreate.mockResolvedValueOnce({ id: CAT_ID, active: false, code: "legacy_other" });
    const inactive = await createChargeService(session, { ...BASE_INPUT, categoryId: CAT_ID });
    expect(inactive).toMatchObject({ ok: false, status: 400, error: "CATEGORY_INACTIVE" });
  });

  it("flag ON + valid category → persists categoryId on the charge", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    mockedRepo.findChargeCategoryForCreate.mockResolvedValue({ id: CAT_ID, active: true, code: "rental" });
    const result = await createChargeService(session, { ...BASE_INPUT, categoryId: CAT_ID });
    expect(result).toMatchObject({ ok: true, status: 201 });
    // Second arg is the in-tx client (Spec2 R1) — the mock ignores it, but the
    // real signature is now (params, tx), so match it rather than pin an object.
    expect(mockedRepo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: CAT_ID }),
      expect.anything(),
    );
  });

  it("flag DARK → old behavior byte-for-byte: categoryId ignored, stored null, no lookup", async () => {
    const result = await createChargeService(session, { ...BASE_INPUT, categoryId: CAT_ID });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(mockedRepo.findChargeCategoryForCreate).not.toHaveBeenCalled();
    expect(mockedRepo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: null }),
      expect.anything(),
    );
  });
});
