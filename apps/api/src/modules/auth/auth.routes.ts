import { Hono } from "hono";
import { z } from "zod";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { verifySessionToken } from "../../lib/auth";
import {
  loginService,
  meService,
  requestPasswordResetService,
  resetPasswordService,
  verifyResetTokenService,
  changePasswordService,
} from "./auth.service";
import { adminCookieConfig } from "./admin.cookie-config";
import { checkPerKey, checkCompound, type RateLimitBucket } from "../../lib/rate-limit";
import { formatZodError } from "../../lib/zod-error-mapper";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ─── Rate limit buckets (in-memory, per-process) ───────────────────────────
const ADMIN_LOGIN_PER_EMAIL: RateLimitBucket = new Map();
const FORGOT_PER_EMAIL: RateLimitBucket = new Map();
const FORGOT_PER_IP: RateLimitBucket = new Map();

const authRoutes = new Hono();

authRoutes.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const limit = checkPerKey(ADMIN_LOGIN_PER_EMAIL, email, 5, 15 * 60 * 1000);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return c.json({ error: "Too many login attempts. Please try again later.", retryAfter: limit.retryAfter }, 429);
  }

  const result = await loginService(parsed.data);
  if (!result.ok) {
    return c.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}) },
      result.status as 400 | 401,
    );
  }

  // Set httpOnly cookie (preferred on desktop — XSS-safer).
  setCookie(c, "admin_session", result.data.token, adminCookieConfig);

  // Also return the token in the body so the frontend can store it for the
  // Authorization-header fallback path. iOS Safari drops the cross-site
  // cookie (CloudFront web → Lightsail api are different eTLD+1) which loops
  // mobile users back to /login. The middleware already accepts Bearer
  // tokens (auth.middleware.ts:21-26) — only the send-side was missing.
  return c.json(
    { user: result.data.user, orgId: result.data.orgId, token: result.data.token },
    200,
  );
});

authRoutes.post("/logout", async (c) => {
  deleteCookie(c, "admin_session", { path: adminCookieConfig.path });
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  // Try cookie first, fall back to Bearer header
  let token = getCookie(c, "admin_session");

  if (!token) {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
    token = header.slice(7);
  }

  const session = await verifySessionToken(token, { issuer: "admin", audience: "admin" });
  if (!session || session.userType?.toLowerCase() === "tenant") return c.json({ error: "Unauthorized" }, 401);

  const result = await meService(session);
  if (!result.ok) return c.json({ error: "Unauthorized" }, 401);
  return c.json(result.data);
});

// ─── Password Reset ────────────────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

authRoutes.post("/forgot-password", async (c) => {
  const parsed = forgotPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid email" }, 400);

  const email = parsed.data.email.trim().toLowerCase();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

  const limit = checkCompound(
    () => checkPerKey(FORGOT_PER_EMAIL, email, 3, 15 * 60 * 1000),
    () => checkPerKey(FORGOT_PER_IP, ip, 20, 60 * 60 * 1000),
  );
  if (!limit.ok) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.rate_limited", surface: "admin", ip, retryAfter: limit.retryAfter }));
    c.header("Retry-After", String(limit.retryAfter));
    return c.json({ error: "Too many reset requests. Please try again later.", retryAfter: limit.retryAfter }, 429);
  }

  await requestPasswordResetService(email);
  return c.json({ message: "If an account exists, a reset email has been sent." }, 200);
});

authRoutes.post("/verify-reset-token", async (c) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "expired_or_invalid" }, 401);

  const result = await verifyResetTokenService(parsed.data.token, "admin");
  if (!result.ok) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.invalid_token", surface: "admin", ip, reason: "verify" }));
    return c.json({ error: "expired_or_invalid" }, 401);
  }
  return c.json({ ok: true, fullName: result.fullName });
});

authRoutes.post("/reset-password", async (c) => {
  const parsed = z.object({
    token: z.string().min(1),
    password: z.string().min(6, "Password must be at least 6 characters"),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await resetPasswordService(parsed.data.token, parsed.data.password);
  if (!result.ok) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.invalid_token", surface: "admin", ip, reason: "reset" }));
    return c.json({ error: result.error }, result.status as 401);
  }
  return c.json({ ok: true, message: "Password reset successful." });
});

authRoutes.post("/change-password", async (c) => {
  const token = getCookie(c, "admin_session") ?? c.req.header("Authorization")?.replace(/^Bearer /, "");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const session = await verifySessionToken(token, { issuer: "admin", audience: "admin" });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6, "New password must be at least 6 characters"),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await changePasswordService(
    session.userId,
    parsed.data.currentPassword,
    parsed.data.newPassword,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 401 | 404);
  return c.json({ ok: true, message: "Password changed successfully." });
});

export { authRoutes };
