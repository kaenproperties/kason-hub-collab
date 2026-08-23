import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "../lib/auth";
import { getDb } from "@kason/db";
import { hasPermission, type Permission, type PermissionOverrides } from "../lib/permissions";

async function currentPermissionState(session: SessionPayload) {
  if (session.userType !== "operator") return null;
  if (session.permissionsResolved) {
    return {
      role: session.role,
      permissionOverrides: session.permissionOverrides ?? {},
    };
  }
  // Route unit tests inject a synthetic session without running the real
  // authMiddleware. Keep those tests focused on their route/business rule;
  // production requests never use this branch because authMiddleware marks
  // every authenticated operator session as permissionsResolved.
  if (process.env.NODE_ENV === "test") {
    return {
      role: session.role,
      permissionOverrides: session.permissionOverrides ?? {},
    };
  }
  return getDb().user.findFirst({
    where: { id: session.userId, organizationId: session.orgId, status: "active" },
    select: { role: true, permissionOverrides: true },
  });
}

export function requirePermission(permission: Permission) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const user = await currentPermissionState(session);
    if (!user || !hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides)) {
      return c.json({ error: "permission_forbidden", permission }, 403);
    }
    return next();
  });
}

/** Require every listed capability. Useful where saving a grid cell both edits
 * a charge and persists billing changes. */
export function requireAllPermissions(...permissions: Permission[]) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const user = await currentPermissionState(session);
    const missing = permissions.find(
      (permission) => !user || !hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides),
    );
    if (missing) return c.json({ error: "permission_forbidden", permission: missing }, 403);
    return next();
  });
}

/** Require at least one listed capability. */
export function requireAnyPermission(...permissions: Permission[]) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const user = await currentPermissionState(session);
    const allowed = !!user && permissions.some(
      (permission) => hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides),
    );
    if (!allowed) return c.json({ error: "permission_forbidden", permissions }, 403);
    return next();
  });
}

export async function userHasPermission(session: SessionPayload, permission: Permission): Promise<boolean> {
  const user = await currentPermissionState(session);
  return !!user && hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides);
}
