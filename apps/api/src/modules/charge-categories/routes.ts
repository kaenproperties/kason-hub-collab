// apps/api/src/modules/charge-categories/routes.ts
import { Hono } from "hono";
import type { Context } from "hono";
import { createChargeCategoryInput, updateChargeCategoryInput, updateDocumentSeriesInput } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";
import { billingDocsFlagGate } from "./billing-docs.gate";
import { ensureChargeCategorySeeds } from "./seed";
import {
  type ChargeCategoryActorCtx,
  createChargeCategoryService,
  deactivateChargeCategoryService,
  listChargeCategoriesService,
  listDocumentSeriesService,
  updateChargeCategoryService,
  updateDocumentSeriesService,
} from "./service";

const chargeCategoriesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate FIRST: every route 404s (canonical "not_found") while
// ENABLE_PHASE2_BILLING_DOCS is dark, before any role check runs
// (owner-ledger.gate.ts precedent).
chargeCategoriesRoutes.use("*", billingDocsFlagGate);

type ChargeCategoriesCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: ChargeCategoriesCtx): ChargeCategoryActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as AdminRole,
    ip,
    userAgent,
  };
}

// Reads: any admin session (viewer included) — the dropdown feeds ChargeForm.
// Lazy-ensure seeds on first read (M6 owner_statement template precedent).
chargeCategoriesRoutes.get("/", requirePermission("settings.view"), async (c) => {
  const session = c.get("session");
  await ensureChargeCategorySeeds(session.orgId);
  const includeInactive = c.req.query("includeInactive") === "true";
  return c.json({ items: await listChargeCategoriesService(session.orgId, { includeInactive }) });
});

// /series routes declared BEFORE /:id so "series" is never captured as an id.
chargeCategoriesRoutes.get("/series", requirePermission("settings.view"), async (c) => {
  const session = c.get("session");
  await ensureChargeCategorySeeds(session.orgId);
  return c.json({ items: await listDocumentSeriesService(session.orgId) });
});

chargeCategoriesRoutes.patch("/series/:id", requirePermission("settings.manage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = updateDocumentSeriesInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateDocumentSeriesService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// Category CRUD is manager-or-above (was admin-only). The registry is maintained from
// Settings → Billing Config, which managers run day-to-day; editors stay 403.
// DELIBERATELY NOT widened: PATCH /series/:id above. Renumbering a document SERIES is
// org-wide and affects every future document on it, so it stays admin-only — note a
// manager CAN still point one category at a different existing series via PATCH /:id.
chargeCategoriesRoutes.post("/", requirePermission("settings.manage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = createChargeCategoryInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createChargeCategoryService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 409);
  return c.json({ data: result.data }, 201);
});

chargeCategoriesRoutes.patch("/:id", requirePermission("settings.manage"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = updateChargeCategoryInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateChargeCategoryService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

chargeCategoriesRoutes.post("/:id/deactivate", requirePermission("settings.manage"), async (c) => {
  const result = await deactivateChargeCategoryService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

export { chargeCategoriesRoutes };
