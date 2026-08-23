import { Hono } from "hono";
import type { Context } from "hono";
import { type ZodError } from "zod";
import { utilityBillingConfigSchema } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";
import { getUtilityBillingConfigService, upsertUtilityBillingConfigService } from "./service";

const utilityBillingConfigRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// ── Feature-flag gate (FIRST — before requireRole; canonical 404 even unauth) ─
utilityBillingConfigRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_METER")) return c.json({ error: "not_found" }, 404);
  await next();
});

function zodBadRequest(c: Context, error: ZodError) {
  const friendly = formatZodError(error, { domain: "utility-billing-config" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// GET /api/utility-billing-config — requires editor
utilityBillingConfigRoutes.get("/", requirePermission("settings.view"), async (c) => {
  const session = c.get("session");
  const result = await getUtilityBillingConfigService(session);
  return c.json(result, 200);
});

// PATCH /api/utility-billing-config — requires admin
utilityBillingConfigRoutes.patch("/", requirePermission("settings.manage"), async (c) => {
  const session = c.get("session");
  const parsed = utilityBillingConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const result = await upsertUtilityBillingConfigService(session, parsed.data);
  return c.json(result, 200);
});

export { utilityBillingConfigRoutes };
