import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import type { Permission } from "../../lib/permissions";
import { requirePermission } from "../require-permission";

function app(permission: Permission, session?: SessionPayload) {
  const instance = new Hono<{ Variables: { session: SessionPayload } }>();
  instance.use("*", async (c, next) => {
    if (session) c.set("session", session);
    return next();
  });
  instance.use("*", requirePermission(permission));
  instance.get("/", (c) => c.json({ ok: true }));
  return instance;
}

const resolvedSession: SessionPayload = {
  userId: "staff-1",
  orgId: "org-1",
  role: "manager",
  userType: "operator",
  permissionsResolved: true,
  permissionOverrides: {},
};

describe("requirePermission", () => {
  it("rejects a missing session", async () => {
    const response = await app("billing.view").request("/");
    expect(response.status).toBe(401);
  });

  it("uses an explicit false override even when the role grants the permission", async () => {
    const response = await app("billing.bill", {
      ...resolvedSession,
      permissionOverrides: { "billing.bill": false },
    }).request("/");
    expect(response.status).toBe(403);
  });

  it("uses an explicit true override when the permission is custom-grantable", async () => {
    const response = await app("profit.view", {
      ...resolvedSession,
      role: "editor",
      permissionOverrides: { "profit.view": true },
    }).request("/");
    expect(response.status).toBe(200);
  });

  it("does not allow an override to bypass a hard role restriction", async () => {
    const response = await app("bank.import", {
      ...resolvedSession,
      role: "editor",
      permissionOverrides: { "bank.import": true },
    }).request("/");
    expect(response.status).toBe(403);
  });

  it("uses the role resolved by auth middleware for the current request", async () => {
    const response = await app("billing.bill", {
      ...resolvedSession,
      role: "viewer",
    }).request("/");
    expect(response.status).toBe(403);
  });

  it("rejects non-operator sessions", async () => {
    const response = await app("billing.view", {
      ...resolvedSession,
      userType: "tenant",
    }).request("/");
    expect(response.status).toBe(403);
  });
});
