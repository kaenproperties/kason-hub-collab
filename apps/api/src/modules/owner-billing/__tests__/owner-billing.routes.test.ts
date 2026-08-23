import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the service so the DB is never reached — routes are tested in isolation
// (mirrors the tasks route-test harness).
vi.mock("../owner-billing.service", () => ({
  createFeeConfigService: vi.fn(),
  listFeeConfigsService: vi.fn(),
  getFeeConfigService: vi.fn(),
  updateFeeConfigService: vi.fn(),
  retireFeeConfigService: vi.fn(),
  restoreFeeConfigService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import {
  createFeeConfigService,
  getFeeConfigService,
  listFeeConfigsService,
  restoreFeeConfigService,
  retireFeeConfigService,
  updateFeeConfigService,
} from "../owner-billing.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CONFIG = "33333333-3333-4333-8333-333333333333";
const APARTMENT = "44444444-4444-4444-8444-444444444444";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

const validPercentBody = {
  ownerPartyId: OWNER,
  feeType: "percent",
  feeValue: "10",
};

const createdRow = {
  id: CONFIG,
  ownerPartyId: OWNER,
  propertyId: null,
  feeType: "percent",
  feeValue: "10",
  capAmount: null,
  sstPercent: "8",
  firstChargeMonth: null,
  firstChargeBaseAmount: null,
  paxDeductionPerPerson: null,
  freePeriodStart: null,
  freePeriodEnd: null,
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function postFeeConfig(session: SessionPayload | null, body: unknown) {
  return makeApp(session).request("/fee-configs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

const UPDATED_AT = "2026-06-01T00:00:00.000Z";
const BUMPED_AT = "2026-06-02T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFeeConfigService).mockResolvedValue({ ok: true, status: 201, data: createdRow });
  vi.mocked(listFeeConfigsService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { items: [], limit: 50, offset: 0 },
  });
  vi.mocked(getFeeConfigService).mockResolvedValue({ ok: true, status: 200, data: createdRow });
  vi.mocked(updateFeeConfigService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...createdRow, feeValue: "12", updatedAt: BUMPED_AT },
  });
  vi.mocked(retireFeeConfigService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...createdRow, isActive: false },
  });
  vi.mocked(restoreFeeConfigService).mockResolvedValue({
    ok: true,
    status: 200,
    data: { ...createdRow, isActive: true },
  });
});

function patchFeeConfig(session: SessionPayload | null, id: string, body: unknown) {
  return makeApp(session).request(`/fee-configs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function postLifecycle(session: SessionPayload | null, id: string, action: "retire" | "restore") {
  return makeApp(session).request(`/fee-configs/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

describe("POST /fee-configs (write = admin)", () => {
  it("403s for an editor operator session", async () => {
    const res = await postFeeConfig(editorSession, validPercentBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(createFeeConfigService).not.toHaveBeenCalled();
  });

  it("403s for a manager (write requires admin, not just manager)", async () => {
    const res = await postFeeConfig(managerSession, validPercentBody);
    expect(res.status).toBe(403);
    expect(createFeeConfigService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await postFeeConfig(ownerPortalSession, validPercentBody);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await postFeeConfig(null, validPercentBody);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("admin with a valid percent config gets 201 and the row echoes feeType/feeValue", async () => {
    const res = await postFeeConfig(adminSession, validPercentBody);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: typeof createdRow };
    expect(json.data.feeType).toBe("percent");
    expect(json.data.feeValue).toBe("10");
    // The parsed body (with schema defaults applied) reaches the service, with
    // the admin's org/actor ctx.
    expect(createFeeConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      expect.objectContaining({ ownerPartyId: OWNER, feeType: "percent", feeValue: "10" }),
    );
  });

  it("rejects an invalid body (cap config missing capAmount) with 400 + fieldErrors", async () => {
    const res = await postFeeConfig(adminSession, {
      ownerPartyId: OWNER,
      feeType: "cap",
      feeValue: "12",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("capAmount");
    expect(createFeeConfigService).not.toHaveBeenCalled();
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await makeApp(adminSession).request("/fee-configs", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("GET /fee-configs (read = manager) — filters + org-scope + paging", () => {
  it("403s for a portal (owner) session even with the flag on", async () => {
    const res = await makeApp(ownerPortalSession).request("/fee-configs");
    expect(res.status).toBe(403);
  });

  it("manager can list and owner/unit filters + offset paging reach the service", async () => {
    const res = await makeApp(managerSession).request(
      `/fee-configs?ownerPartyId=${OWNER}&apartmentId=${APARTMENT}&limit=25&offset=10`,
    );
    expect(res.status).toBe(200);
    expect(listFeeConfigsService).toHaveBeenCalledWith(
      // org comes from the SESSION, not the query — cross-org reads are impossible.
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      expect.objectContaining({ ownerPartyId: OWNER, apartmentId: APARTMENT }),
      { limit: 25, offset: 10 },
    );
  });

  it("defaults paging to limit 50 / offset 0 when omitted", async () => {
    const res = await makeApp(managerSession).request("/fee-configs");
    expect(res.status).toBe(200);
    expect(listFeeConfigsService).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      { limit: 50, offset: 0 },
    );
  });

  it("admin (>= manager) can also read", async () => {
    const res = await makeApp(adminSession).request("/fee-configs");
    expect(res.status).toBe(200);
  });

  it("rejects a non-uuid ownerPartyId filter with 400", async () => {
    const res = await makeApp(managerSession).request("/fee-configs?ownerPartyId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(listFeeConfigsService).not.toHaveBeenCalled();
  });

  it("returns the service envelope under data", async () => {
    vi.mocked(listFeeConfigsService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { items: [createdRow], limit: 50, offset: 0 },
    });
    const res = await makeApp(managerSession).request("/fee-configs");
    const json = (await res.json()) as { data: { items: unknown[]; limit: number; offset: number } };
    expect(json.data.items).toHaveLength(1);
    expect(json.data.limit).toBe(50);
  });
});

describe("GET /fee-configs/:id (read = manager) — org-scoped detail", () => {
  it("403s for an editor (read requires manager)", async () => {
    const res = await makeApp(editorSession).request(`/fee-configs/${CONFIG}`);
    expect(res.status).toBe(403);
  });

  it("manager gets 200 for an id in their org", async () => {
    const res = await makeApp(managerSession).request(`/fee-configs/${CONFIG}`);
    expect(res.status).toBe(200);
    expect(getFeeConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      CONFIG,
    );
  });

  it("returns 404 for an id that belongs to another org (service 404 → HTTP 404)", async () => {
    vi.mocked(getFeeConfigService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Fee config not found",
    });
    const res = await makeApp(managerSession).request(`/fee-configs/${OTHER_OWNER}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Fee config not found" });
  });
});

describe("PATCH /fee-configs/:id (write = admin) — update + concurrency", () => {
  const validPatch = { feeValue: "12", expectedUpdatedAt: UPDATED_AT };

  it("403s for a manager (write requires admin)", async () => {
    const res = await patchFeeConfig(managerSession, CONFIG, validPatch);
    expect(res.status).toBe(403);
    expect(updateFeeConfigService).not.toHaveBeenCalled();
  });

  it("403s for an editor operator session", async () => {
    const res = await patchFeeConfig(editorSession, CONFIG, validPatch);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await patchFeeConfig(ownerPortalSession, CONFIG, validPatch);
    expect(res.status).toBe(403);
  });

  it("admin valid PATCH gets 200 with the bumped updatedAt", async () => {
    const res = await patchFeeConfig(adminSession, CONFIG, validPatch);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { feeValue: string; updatedAt: string } };
    expect(json.data.feeValue).toBe("12");
    expect(json.data.updatedAt).toBe(BUMPED_AT);
    // id from the path + parsed patch reach the service with the admin ctx.
    expect(updateFeeConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      CONFIG,
      expect.objectContaining({ feeValue: "12", expectedUpdatedAt: UPDATED_AT }),
    );
  });

  it("maps a 409 ServiceResult to HTTP 409 with the exact reload body", async () => {
    vi.mocked(updateFeeConfigService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed — reloaded",
    });
    const res = await patchFeeConfig(adminSession, CONFIG, {
      feeValue: "12",
      expectedUpdatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed — reloaded" });
  });

  it("400s a PATCH that omits expectedUpdatedAt (concurrency token required)", async () => {
    const res = await patchFeeConfig(adminSession, CONFIG, { feeValue: "12" });
    expect(res.status).toBe(400);
    expect(updateFeeConfigService).not.toHaveBeenCalled();
  });

  it("passes a {capAmount:null} (no feeType) PATCH through the refine to the service, which 400s on the cap invariant", async () => {
    // The route refine is keyed on patch.feeType, so a patch that only nulls
    // capAmount slips past it and reaches the service. The service owns the
    // effective-feeType cap invariant and returns 400 → HTTP 400.
    vi.mocked(updateFeeConfigService).mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "capAmount is required when feeType is 'cap'",
    });
    const res = await patchFeeConfig(adminSession, CONFIG, {
      capAmount: null,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "capAmount is required when feeType is 'cap'",
    });
    // The refine did NOT block it — the service was reached.
    expect(updateFeeConfigService).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG,
      expect.objectContaining({ capAmount: null, expectedUpdatedAt: UPDATED_AT }),
    );
  });

  it("400s a PATCH switching feeType to 'cap' without capAmount (route refine)", async () => {
    const res = await patchFeeConfig(adminSession, CONFIG, {
      feeType: "cap",
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("capAmount");
    expect(updateFeeConfigService).not.toHaveBeenCalled();
  });

  it("returns 404 when the service 404s (cross-org / missing)", async () => {
    vi.mocked(updateFeeConfigService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Fee config not found",
    });
    const res = await patchFeeConfig(adminSession, OTHER_OWNER, validPatch);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Fee config not found" });
  });

  it("returns 400 Invalid JSON body for malformed JSON", async () => {
    const res = await makeApp(adminSession).request(`/fee-configs/${CONFIG}`, {
      method: "PATCH",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("POST /fee-configs/:id/retire (write = admin)", () => {
  it("403s for a manager (retire requires admin)", async () => {
    const res = await postLifecycle(managerSession, CONFIG, "retire");
    expect(res.status).toBe(403);
    expect(retireFeeConfigService).not.toHaveBeenCalled();
  });

  it("403s for an editor + portal session", async () => {
    expect((await postLifecycle(editorSession, CONFIG, "retire")).status).toBe(403);
    expect((await postLifecycle(ownerPortalSession, CONFIG, "retire")).status).toBe(403);
  });

  it("admin retire gets 200 with isActive false", async () => {
    const res = await postLifecycle(adminSession, CONFIG, "retire");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { isActive: boolean } };
    expect(json.data.isActive).toBe(false);
    expect(retireFeeConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      CONFIG,
    );
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(retireFeeConfigService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Fee config not found",
    });
    const res = await postLifecycle(adminSession, OTHER_OWNER, "retire");
    expect(res.status).toBe(404);
  });
});

describe("POST /fee-configs/:id/restore (write = admin)", () => {
  it("403s for a manager (restore requires admin)", async () => {
    const res = await postLifecycle(managerSession, CONFIG, "restore");
    expect(res.status).toBe(403);
    expect(restoreFeeConfigService).not.toHaveBeenCalled();
  });

  it("admin restore gets 200 with isActive true", async () => {
    const res = await postLifecycle(adminSession, CONFIG, "restore");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { isActive: boolean } };
    expect(json.data.isActive).toBe(true);
    expect(restoreFeeConfigService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      CONFIG,
    );
  });
});

describe("owner-billing flag gate still wraps the C2 routes", () => {
  it("404s the POST while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await postFeeConfig(adminSession, validPercentBody);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
