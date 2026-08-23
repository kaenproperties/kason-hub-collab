import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { requirePermission } from "../../middleware/require-permission";
import { formatZodError } from "../../lib/zod-error-mapper";
import {
  draftConfigCreateSchema,
  draftConfigPatchSchema,
  triggerRunSchema,
  runListQuerySchema,
  invoiceQueueQuerySchema,
  editInvoiceDatesSchema,
  attachChargeSchema,
  voidInvoiceSchema,
  approveBulkSchema,
  approveOneSchema,
  billingGapsQuerySchema,
  editDraftChargeAmountSchema,
} from "./auto-draft.validation";
import {
  getDraftConfigService,
  createDraftConfigService,
  patchDraftConfigService,
  triggerRunService,
  listDraftRunsService,
  getDraftRunService,
  listDraftInvoicesService,
  getDraftInvoiceService,
  editInvoiceDatesService,
  attachChargeService,
  detachChargeService,
  approveInvoiceService,
  approveBulkService,
  voidInvoiceService,
  findBillingGapsService,
  editDraftChargeAmountService,
} from "./auto-draft.service";
import type { AutoDraftActorCtx } from "./auto-draft.types";

const autoDraftRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// ── Feature-flag gate (FIRST — before requireRole; canonical 404 even unauth) ─
autoDraftRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) return c.json({ error: "not_found" }, 404);
  await next();
});

function ctxOf(c: Context): AutoDraftActorCtx {
  const s = c.get("session") as SessionPayload;
  return { orgId: s.orgId, actorUserId: s.userId, actorRole: s.role as AdminRole };
}

function zerr(c: Context, e: ZodError) {
  const f = formatZodError(e, { domain: "billing" });
  return c.json({ error: f.message, fieldErrors: f.fieldErrors }, 400);
}

function out<T>(
  c: Context,
  r: { ok: true; status: number; data: T } | { ok: false; status: number; error: string },
) {
  if (r.ok) return c.json(r.data as object, r.status as 200 | 201);
  return c.json({ error: r.error }, r.status as 400 | 404 | 409);
}

// ── DraftConfig ──────────────────────────────────────────────────────────────

autoDraftRoutes.get("/draft-config", requirePermission("billing.view"), async (c) =>
  out(c, await getDraftConfigService(ctxOf(c))),
);

autoDraftRoutes.post("/draft-config", requirePermission("billing.period_manage"), async (c) => {
  const p = draftConfigCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await createDraftConfigService(ctxOf(c), p.data));
});

autoDraftRoutes.patch("/draft-config/:id", requirePermission("billing.period_manage"), async (c) => {
  const p = draftConfigPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await patchDraftConfigService(ctxOf(c), c.req.param("id"), p.data));
});

// ── InvoiceDraftRun ──────────────────────────────────────────────────────────

// POST /draft-runs = manager (manual trigger; same logic as the cron)
autoDraftRoutes.post("/draft-runs", requirePermission("billing.period_manage"), async (c) => {
  const p = triggerRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await triggerRunService(ctxOf(c), p.data.periodMonth));
});

autoDraftRoutes.get("/draft-runs", requirePermission("billing.view"), async (c) => {
  const p = runListQuerySchema.safeParse(c.req.query());
  if (!p.success) return zerr(c, p.error);
  return out(c, await listDraftRunsService(ctxOf(c), p.data));
});

// GET /draft-runs/gaps — billing months that were never drafted.
// MUST stay declared BEFORE /draft-runs/:id, or Hono matches "gaps" as :id and
// this returns a 404 "Draft run not found" instead.
autoDraftRoutes.get("/draft-runs/gaps", requirePermission("billing.view"), async (c) => {
  const p = billingGapsQuerySchema.safeParse(c.req.query());
  if (!p.success) return zerr(c, p.error);
  return out(c, await findBillingGapsService(ctxOf(c), { lookbackMonths: p.data.lookbackMonths }));
});

autoDraftRoutes.get("/draft-runs/:id", requirePermission("billing.view"), async (c) =>
  out(c, await getDraftRunService(ctxOf(c), c.req.param("id"))),
);

// ── Invoice queue ────────────────────────────────────────────────────────────

autoDraftRoutes.get("/invoices", requirePermission("billing.view"), async (c) => {
  const p = invoiceQueueQuerySchema.safeParse(c.req.query());
  if (!p.success) return zerr(c, p.error);
  return out(c, await listDraftInvoicesService(ctxOf(c), p.data));
});

autoDraftRoutes.get("/invoices/:id", requirePermission("billing.view"), async (c) =>
  out(c, await getDraftInvoiceService(ctxOf(c), c.req.param("id"))),
);

autoDraftRoutes.patch("/invoices/:id", requirePermission("billing.charge.edit"), async (c) => {
  const p = editInvoiceDatesSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  // dueDate from the schema is string | null | undefined; the service expects string | undefined.
  // Treat explicit null as "clear the field" by passing undefined (service skips undefined).
  const patch = { ...p.data, dueDate: p.data.dueDate ?? undefined };
  return out(c, await editInvoiceDatesService(ctxOf(c), c.req.param("id"), patch));
});

autoDraftRoutes.post("/invoices/:id/charges", requirePermission("billing.charge.edit"), async (c) => {
  const p = attachChargeSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await attachChargeService(ctxOf(c), c.req.param("id"), p.data.chargeId));
});

autoDraftRoutes.delete("/invoices/:id/charges/:chargeId", requirePermission("billing.charge.edit"), async (c) =>
  out(c, await detachChargeService(ctxOf(c), c.req.param("id"), c.req.param("chargeId"))),
);

autoDraftRoutes.patch("/invoices/:id/charges/:chargeId/amount", requirePermission("billing.charge.edit"), async (c) => {
  const p = editDraftChargeAmountSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await editDraftChargeAmountService(
    ctxOf(c), c.req.param("id"), c.req.param("chargeId"), p.data,
  ));
});

// IMPORTANT: register /invoices/approve-bulk BEFORE /invoices/:id/approve
// so "approve-bulk" is not captured as the :id param.
autoDraftRoutes.post("/invoices/approve-bulk", requirePermission("billing.bill"), async (c) => {
  const p = approveBulkSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await approveBulkService(ctxOf(c), p.data.ids));
});

autoDraftRoutes.post("/invoices/:id/approve", requirePermission("billing.bill"), async (c) => {
  const p = approveOneSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await approveInvoiceService(ctxOf(c), c.req.param("id"), p.data.expectedUpdatedAt));
});

autoDraftRoutes.post("/invoices/:id/void", requirePermission("billing.rebill"), async (c) => {
  const p = voidInvoiceSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return zerr(c, p.error);
  return out(c, await voidInvoiceService(ctxOf(c), c.req.param("id"), p.data.expectedUpdatedAt, p.data.reason));
});

export { autoDraftRoutes };
