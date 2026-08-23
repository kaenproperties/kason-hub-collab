import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserService, listUsersService } from "../users.service";
import type { SessionPayload } from "../../../lib/auth";

// ── Mock storage ─────────────────────────────────────────────────────────────
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
}));

// ── Mock @kason/db ──────────────────────────────────────────────────────────
vi.mock("@kason/db", () => {
  const mockDb = {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      // findFirst is called by findSuperAdminPartyId to locate the org's
      // admin party — default to null so tests that don't care get a
      // brand-new org (no admin, new staff become roots, no uplineId set).
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
    // party.create is invoked inside createUserService's tx to create the
    // operator's individual Party row alongside the User. Default stub returns
    // a new party id so the User then references it via partyId.
    party: {
      create: vi.fn(async () => ({ id: "party-id" })),
    },
    $transaction: vi.fn(),
  };
  return { getDb: () => mockDb };
});

// ── Mock hashPassword so tests don't need bcrypt to actually run ────────────
vi.mock("../../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/auth")>();
  return {
    ...actual,
    hashPassword: vi.fn().mockResolvedValue("hashed-password"),
  };
});

// ── Mock recordAudit ────────────────────────────────────────────────────────
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import { getDb } from "@kason/db";
import { recordAudit } from "../../../lib/audit";
import { createSignedDownloadUrl } from "../../../lib/storage";
import {
  updateUserService,
  deactivateUserService,
  activateUserService,
  resetPasswordService,
} from "../users.service";

const mockDb = getDb() as unknown as {
  user: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  party: {
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const session: SessionPayload = {
  userId: "user-admin",
  orgId: "org-123",
  role: "admin",
  userType: "operator",
};

const managerSession: SessionPayload = {
  userId: "user-manager",
  orgId: "org-123",
  role: "manager",
  userType: "operator",
};

const directorSession: SessionPayload = {
  userId: "user-director",
  orgId: "org-123",
  role: "director",
  userType: "operator",
};

const financeSession: SessionPayload = {
  userId: "user-finance",
  orgId: "org-123",
  role: "accountant",
  userType: "operator",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findFirst.mockImplementation(async (args: { where?: { id?: string; role?: string } }) => {
    if (args.where?.id === "user-admin") return { id: "user-admin", role: "admin" };
    if (args.where?.id === "user-manager") return { id: "user-manager", role: "manager" };
    if (args.where?.id === "user-director") return { id: "user-director", role: "director" };
    if (args.where?.id === "user-finance") return { id: "user-finance", role: "accountant" };
    if (args.where?.id === "user-operations") return { id: "user-operations", role: "editor" };
    // findSuperAdminPartyId query in createUserService.
    if (args.where?.role === "admin") return null;
    return null;
  });
  // Default $transaction implementation — runs the callback with the mockDb as tx
  mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => Promise<unknown>) =>
    fn(mockDb),
  );
});

// ── listUsersService ─────────────────────────────────────────────────────────

describe("listUsersService", () => {
  it("queries only operator users in the caller's org, ordered by createdAt desc", async () => {
    const mockUsers = [
      {
        id: "u2",
        email: "b@example.com",
        fullName: "Bob",
        role: "editor",
        status: "active",
        lastLoginAt: null,
        createdAt: new Date("2025-02-01"),
        mustChangePassword: false,
      },
      {
        id: "u1",
        email: "a@example.com",
        fullName: "Alice",
        role: "manager",
        status: "active",
        lastLoginAt: new Date("2025-01-15"),
        createdAt: new Date("2025-01-01"),
        mustChangePassword: true,
      },
    ];
    mockDb.user.findMany.mockResolvedValueOnce(mockUsers);

    const result = await listUsersService(session);

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-123", userType: "operator" },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("returns empty array when org has no operator users", async () => {
    mockDb.user.findMany.mockResolvedValueOnce([]);
    const result = await listUsersService(session);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it("filters by single role when roles=['manager']", async () => {
    const s = { orgId: "org-1", userId: "u1", role: "editor" } as never;
    mockDb.user.findMany.mockResolvedValueOnce([]);
    await listUsersService(s, { roles: ["manager"] });
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userType: "operator",
          role: { in: ["manager"] },
        }),
      }),
    );
  });

  it("filters by multiple roles when roles=['admin','editor','viewer']", async () => {
    const s = { orgId: "org-1", userId: "u1", role: "editor" } as never;
    mockDb.user.findMany.mockResolvedValueOnce([]);
    await listUsersService(s, { roles: ["admin", "editor", "viewer"] });
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: { in: ["admin", "editor", "viewer"] },
        }),
      }),
    );
  });

  it("does not include role filter when opts is undefined", async () => {
    const s = { orgId: "org-1", userId: "u1", role: "editor" } as never;
    mockDb.user.findMany.mockResolvedValueOnce([]);
    await listUsersService(s);
    const call = mockDb.user.findMany.mock.calls[0][0];
    expect(call.where.role).toBeUndefined();
  });

  it("includes photoUrl=null for users without a photoKey", async () => {
    const s = { orgId: "org-1", userId: "u1", role: "editor" } as never;
    mockDb.user.findMany.mockResolvedValueOnce([
      { id: "u1", email: "x@y.com", fullName: "X", role: "editor", status: "active", lastLoginAt: null, createdAt: new Date(), mustChangePassword: false, photoKey: null },
    ]);
    const result = await listUsersService(s);
    expect(result.data[0].photoUrl).toBeNull();
  });

  it("includes a signed photoUrl for users with a photoKey", async () => {
    const s = { orgId: "org-1", userId: "u1", role: "editor" } as never;
    mockDb.user.findMany.mockResolvedValueOnce([
      { id: "u1", email: "x@y.com", fullName: "X", role: "editor", status: "active", lastLoginAt: null, createdAt: new Date(), mustChangePassword: false, photoKey: "avatars/users/u1/abc.jpg" },
    ]);
    vi.mocked(createSignedDownloadUrl).mockResolvedValueOnce("https://signed/abc.jpg");
    const result = await listUsersService(s);
    expect(result.data[0].photoUrl).toBe("https://signed/abc.jpg");
  });
});

// ── createUserService ────────────────────────────────────────────────────────

describe("createUserService", () => {
  it("creates a user with mustChangePassword=true and correct flags", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null); // no existing user
    mockDb.user.create.mockResolvedValueOnce({ id: "new-user-id" });
    mockDb.party.create.mockResolvedValueOnce({ id: "new-party-id" });
    mockDb.user.update.mockResolvedValueOnce({ id: "new-user-id" });

    const result = await createUserService(session, {
      email: "newuser@example.com",
      fullName: "New User",
      role: "editor",
      password: "super-secure-passphrase",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.status).toBe(201);
    expect(result.data.id).toBe("new-user-id");
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "newuser@example.com",
          fullName: "New User",
          role: "editor",
          userType: "operator",
          status: "active",
          emailVerified: true,
          mustChangePassword: true,
          organizationId: "org-123",
        }),
      }),
    );
  });

  it("creates a Party row (partyType='individual') and links the new User to it", async () => {
    // Regression for the 2026-05-24 'TEST MANAGER invisible' bug AND the
    // sibling 'Listing in-charge picker drops new operators' bug. Both
    // need every new operator user to land with a paired Party.
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    mockDb.party.create.mockResolvedValueOnce({ id: "new-party-id" });
    mockDb.user.create.mockResolvedValueOnce({ id: "new-user-id" });

    await createUserService(session, {
      email: "new-with-party@example.com",
      fullName: "New With Party",
      role: "manager",
      password: "secure-pass",
    });

    // Party created with the right shape.
    expect(mockDb.party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          partyType: "individual",
          displayName: "New With Party",
          primaryEmail: "new-with-party@example.com",
          status: "active",
          organizationId: "org-123",
        }),
      }),
    );
    // User created with partyId linking to the new Party.
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ partyId: "new-party-id" }),
      }),
    );
  });

  it("normalises email to lowercase before creating", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    mockDb.user.create.mockResolvedValueOnce({ id: "uid" });
    mockDb.party.create.mockResolvedValueOnce({ id: "pid" });
    mockDb.user.update.mockResolvedValueOnce({ id: "uid" });

    await createUserService(session, {
      email: "UPPER@EXAMPLE.COM",
      fullName: "Upper Case",
      role: "viewer",
      password: "another-secure-pass",
    });

    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "upper@example.com" }),
      }),
    );
  });

  it("rejects role=admin with 400 (belt-and-suspenders guard)", async () => {
    const result = await createUserService(session, {
      email: "admin@example.com",
      fullName: "Sneaky Admin",
      role: "admin" as any, // force past type system for test
      password: "secure-password-here",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/admin/i);
    // Should NOT touch the DB
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate email within the same org with 409", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "existing-id" });

    const result = await createUserService(session, {
      email: "existing@example.com",
      fullName: "Existing User",
      role: "editor",
      password: "secure-password-here",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(409);
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("scopes uniqueness check to organizationId so same email can exist in a different org", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null); // not found in this org
    mockDb.user.create.mockResolvedValueOnce({ id: "new-id" });
    mockDb.party.create.mockResolvedValueOnce({ id: "p-new" });
    mockDb.user.update.mockResolvedValueOnce({ id: "new-id" });

    const result = await createUserService(session, {
      email: "shared@example.com",
      fullName: "Cross Org User",
      role: "viewer",
      password: "secure-password-here",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_email: { organizationId: "org-123", email: "shared@example.com" } },
      }),
    );
  });
});

// ── updateUserService ────────────────────────────────────────────────────────

describe("updateUserService", () => {
  it("updates fullName and role for a non-admin target, writes audit", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "target-id",
      role: "editor",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "target-id" });

    const result = await updateUserService(managerSession, "target-id", {
      fullName: "Updated Name",
      role: "viewer",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-id" },
        data: expect.objectContaining({ fullName: "Updated Name", role: "viewer" }),
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user.updated",
        entityType: "user",
        entityId: "target-id",
        actorUserId: "user-manager",
      }),
    );
  });

  it("rejects if target user is admin-tier (403)", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "admin-user",
      role: "admin",
      organizationId: "org-123",
    });

    const result = await updateUserService(managerSession, "admin-user", {
      fullName: "Hacked Name",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/cannot modify admin-tier users/i);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("rejects with 404 if target user not found in org", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);

    const result = await updateUserService(managerSession, "nonexistent", { fullName: "Ghost" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
  });

  it("rejects self-edit", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-manager",
      role: "manager",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "user-manager" });

    const result = await updateUserService(managerSession, "user-manager", {
      fullName: "Self Updated",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("records previous+new role when assigning another lower role", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "u1",
      role: "editor",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });

    const result = await updateUserService(managerSession, "u1", { role: "viewer" });

    expect(result.ok).toBe(true);
    const diff = (recordAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].diff;
    expect(diff.previousRole).toBe("editor");
    expect(diff.newRole).toBe("viewer");
  });

  it("does not let Manager promote Operations Admin to same-tier Finance", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "u1", role: "editor", organizationId: "org-123" });
    const result = await updateUserService(managerSession, "u1", { role: "accountant" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("does not let Manager edit another Manager at the same tier", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "manager-2", role: "manager", organizationId: "org-123" });

    const result = await updateUserService(managerSession, "manager-2", { fullName: "Changed" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("lets Director edit Manager and Finance users below the Director tier", async () => {
    for (const target of [
      { id: "manager-2", role: "manager" },
      { id: "finance-2", role: "accountant" },
    ]) {
      mockDb.user.findUnique.mockResolvedValueOnce({ ...target, organizationId: "org-123" });
      mockDb.user.update.mockResolvedValueOnce({ id: target.id });

      const result = await updateUserService(directorSession, target.id, { fullName: `Updated ${target.role}` });
      expect(result.ok).toBe(true);
    }
  });

  it("lets Finance edit Operations Admin but not Manager", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "operations-2", role: "editor", organizationId: "org-123" });
    mockDb.user.update.mockResolvedValueOnce({ id: "operations-2" });
    expect((await updateUserService(financeSession, "operations-2", { fullName: "Updated Ops" })).ok).toBe(true);

    mockDb.user.findUnique.mockResolvedValueOnce({ id: "manager-2", role: "manager", organizationId: "org-123" });
    const denied = await updateUserService(financeSession, "manager-2", { fullName: "Not Allowed" });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.status).toBe(403);
  });

  it("omits previousRole/newRole when only fullName changes", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "u1",
      role: "editor",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "u1" });

    await updateUserService(managerSession, "u1", { fullName: "New Name" });

    const diff = (recordAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].diff;
    expect(diff.previousRole).toBeUndefined();
  });
});

// ── deactivateUserService ────────────────────────────────────────────────────

describe("deactivateUserService", () => {
  it("sets status=disabled for a non-admin target, writes audit", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "target-id",
      role: "editor",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "target-id" });

    const result = await deactivateUserService(managerSession, "target-id");

    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-id" },
        data: { status: "disabled" },
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user.deactivated",
        entityType: "user",
        entityId: "target-id",
      }),
    );
  });

  it("rejects self-deactivation with 400", async () => {
    const result = await deactivateUserService(managerSession, "user-manager");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/cannot deactivate yourself/i);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("rejects admin-tier target with 403", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "admin-user",
      role: "admin",
      organizationId: "org-123",
    });

    const result = await deactivateUserService(managerSession, "admin-user");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/cannot modify admin-tier users/i);
  });

  it("rejects with 404 if target not found", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    const result = await deactivateUserService(managerSession, "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
  });
});

// ── activateUserService ──────────────────────────────────────────────────────

describe("activateUserService", () => {
  it("sets status=active for a non-admin target, writes audit", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "target-id",
      role: "viewer",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "target-id" });

    const result = await activateUserService(managerSession, "target-id");

    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-id" },
        data: { status: "active" },
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user.activated",
        entityType: "user",
        entityId: "target-id",
      }),
    );
  });

  it("rejects admin-tier target with 403", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "admin-user",
      role: "admin",
      organizationId: "org-123",
    });

    const result = await activateUserService(managerSession, "admin-user");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("rejects with 404 if target not found", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    const result = await activateUserService(managerSession, "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
  });
});

// ── resetPasswordService ─────────────────────────────────────────────────────

describe("resetPasswordService", () => {
  it("hashes the new password, sets mustChangePassword=true, writes audit", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "target-id",
      role: "editor",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "target-id" });

    const result = await resetPasswordService(managerSession, "target-id", {
      password: "new-secure-password-123",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-id" },
        data: expect.objectContaining({
          passwordHash: "hashed-password",
          mustChangePassword: true,
        }),
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user.password_reset",
        entityType: "user",
        entityId: "target-id",
        actorUserId: "user-manager",
      }),
    );
  });

  it("rejects self-reset from the staff-administration endpoint", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-manager",
      role: "manager",
      organizationId: "org-123",
    });
    mockDb.user.update.mockResolvedValueOnce({ id: "user-manager" });

    const result = await resetPasswordService(managerSession, "user-manager", {
      password: "self-reset-password-123",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("rejects admin-tier target with 403", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "admin-user",
      role: "admin",
      organizationId: "org-123",
    });

    const result = await resetPasswordService(managerSession, "admin-user", {
      password: "new-secure-password-123",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(403);
  });

  it("rejects with 404 if target not found", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    const result = await resetPasswordService(managerSession, "nonexistent", {
      password: "new-secure-password-123",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
  });
});
