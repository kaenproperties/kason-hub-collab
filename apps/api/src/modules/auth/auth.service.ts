import crypto from "node:crypto";
import { getDb } from "@kason/db";
import { createSessionToken, verifySessionToken, hashPassword, verifyPassword, type SessionPayload } from "../../lib/auth";
import { sendEmail } from "../../lib/email";
import { passwordResetEmail } from "../../lib/email-templates/password-reset";
import { recordAudit } from "../../lib/audit";
import { findActiveUserByEmail } from "./auth.repository";
import type { LoginInput } from "./auth.types";
import { effectivePermissions, type PermissionOverrides } from "../../lib/permissions";

export async function loginService(input: LoginInput) {
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!email || !password) {
    return { ok: false as const, status: 400, error: "Missing credentials" };
  }

  const user = await findActiveUserByEmail(email);
  if (!user?.passwordHash) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return { ok: false as const, status: 401, error: "Invalid credentials" };
  }

  const adminTypes: string[] = ["operator"];
  if (user.userType && !adminTypes.includes(user.userType.toLowerCase())) {
    return { ok: false as const, status: 401, code: "PORTAL_ACCOUNT" as const, error: "Unauthorized" };
  }

  const absoluteExp = Math.floor(Date.now() / 1000) + 8 * 3600; // 8-hour ceiling
  const token = await createSessionToken(user.id, user.organizationId, user.role, {
    userType: user.userType,
    partyId: user.partyId ?? undefined,
    absoluteExp,
    iss: "admin",
    aud: "admin",
  }, "8h");

  return {
    ok: true as const,
    status: 200,
    data: {
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        permissions: effectivePermissions(user.role, user.permissionOverrides as PermissionOverrides),
        userType: user.userType,
      },
      orgId: user.organizationId,
    },
  };
}

export async function meService(session: SessionPayload) {
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      organizationId: true,
      userType: true,
      partyId: true,
      status: true,
      permissionOverrides: true,
      mustChangePassword: true,
    },
  });

  if (!user || user.status !== "active") {
    return { ok: false as const, status: 401, data: null };
  }

  return {
    ok: true as const,
    status: 200,
    data: {
      userId: user.id,
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      orgId: user.organizationId,
      role: user.role,
      userType: user.userType,
      partyId: user.partyId,
      permissions: effectivePermissions(user.role, user.permissionOverrides as PermissionOverrides),
      mustChangePassword: user.mustChangePassword,
    },
  };
}

// ─── Password Reset ────────────────────────────────────────────────────────

const RESET_TOKEN_EXPIRY = "15m";
const ADMIN_RESET_AUDIENCE = "reset:admin";

export async function requestPasswordResetService(email: string) {
  const db = getDb();
  const normalized = email.toLowerCase().trim();
  const user = await db.user.findFirst({
    where: { email: normalized, status: "active", userType: "operator" },
    select: { id: true, organizationId: true, email: true, fullName: true },
  });

  // Structured log for ops; emailHash keeps PII out of stdout.
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ event: "password_reset.requested", surface: "admin", emailHash: hashEmail(normalized), found: !!user }));

  // Always return success to prevent email enumeration
  if (!user) return { ok: true as const };

  const token = await createSessionToken(user.id, user.organizationId, "reset", {
    iss: "reset",
    aud: ADMIN_RESET_AUDIENCE,
  }, RESET_TOKEN_EXPIRY);

  const tokenHash = sha256Hex(token);
  await db.user.update({
    where: { id: user.id },
    data: { resetTokenHash: tokenHash },
  });

  const baseUrl = process.env.APP_URL || "http://localhost:5173";
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const email_ = passwordResetEmail({ surface: "admin", fullName: user.fullName, resetUrl });
  const sendResult = await sendEmail({
    to: user.email,
    subject: email_.subject,
    body: email_.html,
    text: email_.text,
  });
  if (!sendResult.success) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: "password_reset.send_failed", surface: "admin", emailHash: hashEmail(normalized), error: sendResult.error }));
  }

  return { ok: true as const };
}

export async function verifyResetTokenService(
  token: string,
  surface: "admin" | "portal",
): Promise<{ ok: true; fullName: string } | { ok: false }> {
  const audience = surface === "admin" ? ADMIN_RESET_AUDIENCE : "reset:portal";
  const session = await verifySessionToken(token, { issuer: "reset", audience });
  if (!session) return { ok: false };

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, fullName: true, status: true, resetTokenHash: true },
  });
  if (!user || user.status !== "active" || !user.resetTokenHash) return { ok: false };

  const tokenHash = sha256Hex(token);
  if (tokenHash !== user.resetTokenHash) return { ok: false };

  return { ok: true, fullName: user.fullName };
}

export async function resetPasswordService(token: string, newPassword: string) {
  const session = await verifySessionToken(token, { issuer: "reset", audience: ADMIN_RESET_AUDIENCE });
  if (!session) return { ok: false as const, status: 401, error: "Invalid or expired reset token" };

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, organizationId: true, role: true, resetTokenHash: true, status: true },
  });

  if (!user || user.status !== "active" || !user.resetTokenHash) {
    return { ok: false as const, status: 401, error: "Invalid or expired reset token" };
  }

  const tokenHash = sha256Hex(token);
  if (tokenHash !== user.resetTokenHash) {
    return { ok: false as const, status: 401, error: "Invalid or expired reset token" };
  }

  const passwordHash = await hashPassword(newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, resetTokenHash: null, mustChangePassword: false },
    });
    await recordAudit(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      actorRole: user.role,
      action: "user.password_reset",
      entityType: "user",
      entityId: user.id,
    });
  });

  return { ok: true as const };
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashEmail(email: string): string {
  // Truncated SHA-256 — keeps PII out of logs while staying correlatable.
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// ─── Change Password ──────────────────────────────────────────────────────────

export async function changePasswordService(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<
  | { ok: true }
  | { ok: false; status: 400 | 401 | 404; error: string }
> {
  if (newPassword.length < 6) {
    return { ok: false, status: 400, error: "New password must be at least 6 characters" };
  }

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user || !user.passwordHash) {
    return { ok: false, status: 404, error: "User not found" };
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return { ok: false, status: 401, error: "Current password is incorrect" };

  const newHash = await hashPassword(newPassword);
  await db.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, mustChangePassword: false },
  });

  return { ok: true };
}
