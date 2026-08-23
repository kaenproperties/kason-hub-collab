import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { getDb } from "@kason/db";
import { verifySessionToken, type SessionPayload } from "../lib/auth";

export const authMiddleware = createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
  // 1. Read token: cookie first, then Bearer header
  let token = getCookie(c, "admin_session");

  if (!token) {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    token = header.slice(7);
  }

  const session = await verifySessionToken(token, { issuer: "admin", audience: "admin" });

  if (!session) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const adminTypes: string[] = ["operator"];
  if (session.userType && !adminTypes.includes(session.userType.toLowerCase())) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 2. Reload the authoritative operator on every request. Role changes,
  // explicit false overrides and deactivation must take effect immediately;
  // relying on the JWT (or the old 60-second status cache) left a window where
  // a revoked permission could still be exercised.
  const operator = await getDb().user.findFirst({
    where: {
      id: session.userId,
      organizationId: session.orgId,
      userType: "operator",
      status: "active",
    },
    select: {
      role: true,
      partyId: true,
      permissionOverrides: true,
    },
  });

  if (!operator) {
    return c.json({ error: "Account deactivated" }, 401);
  }

  c.set("session", {
    ...session,
    role: operator.role,
    partyId: operator.partyId ?? undefined,
    permissionOverrides: (operator.permissionOverrides ?? {}) as Record<string, boolean>,
    permissionsResolved: true,
  });
  await next();
});
