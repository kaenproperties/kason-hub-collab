import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { authMiddleware } from "../auth";

const mocks = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("../../lib/auth", () => ({
  verifySessionToken: mocks.verifySessionToken,
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    user: { findFirst: mocks.findFirst },
  }),
}));

const tokenSession: SessionPayload = {
  userId: "staff-1",
  orgId: "org-1",
  role: "manager",
  userType: "operator",
};

function app() {
  const instance = new Hono<{ Variables: { session: SessionPayload } }>();
  instance.use("*", authMiddleware);
  instance.get("/", (c) => c.json(c.get("session")));
  return instance;
}

describe("authMiddleware current operator access", () => {
  beforeEach(() => {
    mocks.verifySessionToken.mockReset();
    mocks.findFirst.mockReset();
    mocks.verifySessionToken.mockResolvedValue(tokenSession);
  });

  it("replaces stale token role and overrides with the active database record", async () => {
    mocks.findFirst.mockResolvedValue({
      role: "viewer",
      partyId: "party-2",
      permissionOverrides: { "billing.view": false },
    });

    const response = await app().request("/", {
      headers: { authorization: "Bearer valid-session" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      role: "viewer",
      partyId: "party-2",
      permissionOverrides: { "billing.view": false },
      permissionsResolved: true,
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "staff-1",
        organizationId: "org-1",
        status: "active",
      }),
    }));
  });

  it("rejects a deactivated or deleted operator immediately", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const response = await app().request("/", {
      headers: { authorization: "Bearer valid-session" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Account deactivated" });
  });
});
