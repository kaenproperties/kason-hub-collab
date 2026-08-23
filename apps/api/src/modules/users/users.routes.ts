import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import { formatZodError } from "../../lib/zod-error-mapper";
import { createUserSchema, updateUserSchema, resetPasswordSchema } from "./users.validation";
import {
  createUserService,
  listUsersService,
  updateUserService,
  deactivateUserService,
  activateUserService,
  resetPasswordService,
} from "./users.service";

const usersRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// GET /api/users — follows the same capability as the Roles page itself.
usersRoutes.get("/", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const rawRoles = c.req.query("roles");
  const roles = rawRoles
    ? (rawRoles
        .split(",")
        .map((r) => r.trim())
        .filter((r) => ["admin", "director", "accountant", "manager", "editor", "viewer"].includes(r)) as ("admin" | "director" | "accountant" | "manager" | "editor" | "viewer")[])
    : undefined;
  const result = await listUsersService(session, roles ? { roles } : undefined);
  return c.json({ data: result.data });
});

// POST /api/users — manager+ can create operator users
usersRoutes.post("/", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "users" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await createUserService(session, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ data: result.data }, 201);
});

// PATCH /api/users/:id — manager+ can edit fullName / role
usersRoutes.patch("/:id", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "users" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await updateUserService(session, targetId, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true });
});

// POST /api/users/:id/deactivate — manager+ sets status to "disabled"
usersRoutes.post("/:id/deactivate", requirePermission("user.disable"), async (c) => {
  const session = c.get("session");
  const targetId = c.req.param("id");

  const result = await deactivateUserService(session, targetId);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true });
});

// POST /api/users/:id/activate — manager+ sets status to "active"
usersRoutes.post("/:id/activate", requirePermission("user.disable"), async (c) => {
  const session = c.get("session");
  const targetId = c.req.param("id");

  const result = await activateUserService(session, targetId);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true });
});

// POST /api/users/:id/reset-password — manager+ sets new temp password
usersRoutes.post("/:id/reset-password", requirePermission("user.reset_password"), async (c) => {
  const session = c.get("session");
  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "users" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await resetPasswordService(session, targetId, parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true });
});

export { usersRoutes };
