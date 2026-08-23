import { getDb } from "@kason/db";
import { hashPassword } from "../../lib/auth";
import { recordAudit } from "../../lib/audit";
import { createSignedDownloadUrl } from "../../lib/storage";
import type { CreateUserInput, UpdateUserInput, ResetPasswordInput } from "./users.validation";
import type { SessionPayload } from "../../lib/auth";
import { canManageRole, permissionCanBeGrantedToRole, type PermissionOverrides } from "../../lib/permissions";

export async function listUsersService(
  session: SessionPayload,
  opts?: { roles?: ("admin" | "director" | "accountant" | "manager" | "editor" | "viewer")[] },
) {
  const db = getDb();
  const users = await db.user.findMany({
    where: {
      organizationId: session.orgId,
      userType: "operator",
      ...(opts?.roles?.length ? { role: { in: opts.roles } } : {}),
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      permissionOverrides: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
      mustChangePassword: true,
      photoKey: true,
      partyId: true,
      party: {
        select: {
          id: true,
          uplineId: true,
          upline: { select: { id: true, displayName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const withPhotoUrl = await Promise.all(
    users.map(async (u) => ({
      ...u,
      photoUrl: u.photoKey ? await createSignedDownloadUrl(u.photoKey) : null,
    })),
  );
  return { ok: true as const, data: withPhotoUrl };
}

export async function createUserService(session: SessionPayload, input: CreateUserInput) {
  const db = getDb();
  const email = input.email.trim().toLowerCase();

  // Reject admin role before the hierarchy lookup. The public schema already
  // blocks this, but keeping the service guard first makes the rule explicit
  // for internal callers as well.
  if ((input.role as string) === "admin") {
    return { ok: false as const, status: 400 as const, error: 'Role "admin" is not allowed' };
  }

  const actor = await fetchActorInOrg(db, session.orgId, session.userId);
  if (!actor || !canManageRole(actor.role, input.role)) {
    return { ok: false as const, status: 403 as const, error: "You can only create users below your role level" };
  }
  const invalidGrant = firstInvalidRoleGrant(input.role, input.permissionOverrides);
  if (invalidGrant) {
    return { ok: false as const, status: 403 as const, error: `Permission ${invalidGrant} cannot be granted to this role` };
  }

  // Check email uniqueness within the org
  const existing = await db.user.findUnique({
    where: { organizationId_email: { organizationId: session.orgId, email } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false as const, status: 409 as const, error: "A user with this email already exists in your organisation" };
  }

  const passwordHash = await hashPassword(input.password);

  // Two parallel sessions converged on the same fix. Both reasons matter:
  //
  // (a) Operator users need a paired Party row so they're addressable by
  //     anything keyed off Party.id — most importantly the Listing in-charge
  //     picker (Listing.inChargePartyId FK → Party.id) and the
  //     /parties/assignable search which reads Party only. (Client report
  //     2026-05-24)
  // (b) Without the Party row, new managers/editors/viewers are invisible
  //     to the org-chart hierarchy + upline picker — the 2026-05-23
  //     "TEST MANAGER invisible" bug.
  //
  // Wrapped in a tx so a failure half-way never leaves a User without a
  // Party (or vice-versa). Party-then-User ordering avoids the extra
  // update round-trip that User-then-Party would need.
  //
  // Auto-uplineing: new staff inherit the super-admin (the lone existing
  // admin-role User's Party) as upline so they immediately appear under
  // KAEN Properties in the org chart — matching the user's mental model
  // that "new operator → under the top node by default". If no admin user
  // exists yet (fresh org), uplineId stays NULL and they appear as a root.
  const superAdminPartyId = await findSuperAdminPartyId(db, session.orgId);

  const userId = await db.$transaction(async (tx) => {
    const party = await tx.party.create({
      data: {
        organizationId: session.orgId,
        partyType: "individual",
        displayName: input.fullName,
        primaryEmail: email,
        status: "active",
        uplineId: superAdminPartyId, // null when no admin exists
      },
      select: { id: true },
    });
    const user = await tx.user.create({
      data: {
        email,
        fullName: input.fullName,
        role: input.role,
        permissionOverrides: input.permissionOverrides ?? {},
        passwordHash,
        userType: "operator",
        status: "active",
        emailVerified: true,
        mustChangePassword: true,
        organizationId: session.orgId,
        partyId: party.id,
      },
      select: { id: true },
    });
    return user.id;
  });

  return { ok: true as const, status: 201 as const, data: { id: userId } };
}

/**
 * Find the org's super-admin party id — the partyId of the lone admin-role
 * User. Used by createUserService to auto-place new staff in the org chart.
 *
 * Returns null if no admin exists yet (e.g. brand-new org), or if the
 * existing admin User has no linked Party (legacy state pre-backfill).
 */
async function findSuperAdminPartyId(
  db: ReturnType<typeof getDb>,
  orgId: string,
): Promise<string | null> {
  const admin = await db.user.findFirst({
    where: {
      organizationId: orgId,
      role: "admin",
      userType: "operator",
      status: "active",
    },
    select: { partyId: true },
    orderBy: { createdAt: "asc" }, // earliest admin wins for determinism
  });
  return admin?.partyId ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTargetInOrg(db: ReturnType<typeof getDb>, orgId: string, targetId: string) {
  return db.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true, organizationId: true },
  });
}

async function fetchActorInOrg(db: ReturnType<typeof getDb>, orgId: string, actorId: string) {
  return db.user.findFirst({
    where: { id: actorId, organizationId: orgId, userType: "operator", status: "active" },
    select: { id: true, role: true },
  });
}

function firstInvalidRoleGrant(role: string, overrides?: PermissionOverrides | null) {
  return Object.entries(overrides ?? {}).find(
    ([permission, enabled]) => enabled === true && !permissionCanBeGrantedToRole(role, permission as Parameters<typeof permissionCanBeGrantedToRole>[1]),
  )?.[0];
}

async function hierarchyCheck(
  db: ReturnType<typeof getDb>,
  session: SessionPayload,
  target: { id: string; role: string },
  nextRole?: string,
) {
  if (session.userId === target.id) {
    return { ok: false as const, status: 403 as const, error: "You cannot administer your own account" };
  }
  const actor = await fetchActorInOrg(db, session.orgId, session.userId);
  if (!actor || !canManageRole(actor.role, target.role) || (nextRole && !canManageRole(actor.role, nextRole))) {
    return { ok: false as const, status: 403 as const, error: "You can only administer users below your role level" };
  }
  return null;
}

function rejectAdminTier(target: { role: string }) {
  if (target.role === "admin") {
    return {
      ok: false as const,
      status: 403 as const,
      error: "cannot modify admin-tier users",
    };
  }
  return null;
}

// ── updateUserService ─────────────────────────────────────────────────────────

export async function updateUserService(
  session: SessionPayload,
  targetId: string,
  input: UpdateUserInput,
) {
  const db = getDb();

  const target = await fetchTargetInOrg(db, session.orgId, targetId);
  if (!target || target.organizationId !== session.orgId) {
    return { ok: false as const, status: 404 as const, error: "User not found" };
  }

  const adminCheck = rejectAdminTier(target);
  if (adminCheck) return adminCheck;

  const hierarchy = await hierarchyCheck(db, session, target, input.role);
  if (hierarchy) return hierarchy;

  const invalidGrant = firstInvalidRoleGrant(input.role ?? target.role, input.permissionOverrides);
  if (invalidGrant) {
    return { ok: false as const, status: 403 as const, error: `Permission ${invalidGrant} cannot be granted to this role` };
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetId },
      data: {
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.permissionOverrides !== undefined && { permissionOverrides: input.permissionOverrides }),
      },
    });

    const roleChanged = input.role !== undefined && input.role !== target.role;
    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "user.updated",
      entityType: "user",
      entityId: targetId,
      diff: {
        input,
        ...(roleChanged ? { previousRole: target.role, newRole: input.role } : {}),
      },
    });
  });

  return { ok: true as const };
}

// ── deactivateUserService ─────────────────────────────────────────────────────

export async function deactivateUserService(session: SessionPayload, targetId: string) {
  // Reject self-deactivation before hitting the DB
  if (session.userId === targetId) {
    return { ok: false as const, status: 400 as const, error: "cannot deactivate yourself" };
  }

  const db = getDb();

  const target = await fetchTargetInOrg(db, session.orgId, targetId);
  if (!target || target.organizationId !== session.orgId) {
    return { ok: false as const, status: 404 as const, error: "User not found" };
  }

  const adminCheck = rejectAdminTier(target);
  if (adminCheck) return adminCheck;

  const hierarchy = await hierarchyCheck(db, session, target);
  if (hierarchy) return hierarchy;

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetId },
      data: { status: "disabled" },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "user.deactivated",
      entityType: "user",
      entityId: targetId,
    });
  });

  return { ok: true as const };
}

// ── activateUserService ───────────────────────────────────────────────────────

export async function activateUserService(session: SessionPayload, targetId: string) {
  const db = getDb();

  const target = await fetchTargetInOrg(db, session.orgId, targetId);
  if (!target || target.organizationId !== session.orgId) {
    return { ok: false as const, status: 404 as const, error: "User not found" };
  }

  const adminCheck = rejectAdminTier(target);
  if (adminCheck) return adminCheck;

  const hierarchy = await hierarchyCheck(db, session, target);
  if (hierarchy) return hierarchy;

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetId },
      data: { status: "active" },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "user.activated",
      entityType: "user",
      entityId: targetId,
    });
  });

  return { ok: true as const };
}

// ── resetPasswordService ──────────────────────────────────────────────────────

export async function resetPasswordService(
  session: SessionPayload,
  targetId: string,
  input: ResetPasswordInput,
) {
  const db = getDb();

  const target = await fetchTargetInOrg(db, session.orgId, targetId);
  if (!target || target.organizationId !== session.orgId) {
    return { ok: false as const, status: 404 as const, error: "User not found" };
  }

  const adminCheck = rejectAdminTier(target);
  if (adminCheck) return adminCheck;

  const hierarchy = await hierarchyCheck(db, session, target);
  if (hierarchy) return hierarchy;

  const passwordHash = await hashPassword(input.password);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetId },
      data: { passwordHash, mustChangePassword: true },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "user.password_reset",
      entityType: "user",
      entityId: targetId,
    });
  });

  return { ok: true as const };
}
