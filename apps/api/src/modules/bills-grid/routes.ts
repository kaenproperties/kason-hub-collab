// Bills & Expenses Grid — HTTP router (Task 6). Mirrors modules/meter/routes.ts
// byte-for-byte on conventions: a router-level flag gate FIRST (canonical 404 even
// unauthenticated), then per-route `requireRole` (editor < manager < admin), Zod
// `safeParse` → `zodBadRequest`, and a faithful Result→HTTP mapping.
//
// AUTH is the risk this file owns. The SERVICE layer enforces NO roles — the ROUTE
// does. Per spec §API/R26: read + Save-oriented paths admit `editor`; Bill,
// bearer-config writes (PUT bearer-config, PATCH …/entries/:id/lines) and expense/
// attachment DELETE/void require `manager`. A non-listed role (viewer) → 403.
//
// Status codes: 400 = Zod (mapped with `domain: "bills-grid"`) + bad path UUID;
// 409 = STALE/ENTRY_LOCKED/BEARER_LOCKED; 404 = not-found AND flag-dark; 500 =
// unexpected; 502 = ATTACHMENT_*_FAILED. The ONLY HTTP 422 is the recurring-apply
// nature-routing fail-closed guard (ENABLE_CHARGE_NATURE_ROUTING ON + `nature`
// omitted → NATURE_REQUIRED); otherwise the service returns `previewError` on READ
// and per-row `outcome`s on BILL, both passed through with a 200.
import { Hono } from "hono";
import type { Context } from "hono";
import { z, type ZodError } from "zod";
import {
  bearer,
  bearerConfigSchema,
  billSchema,
  createExpensesSchema,
  gridQuerySchema,
  lineSettingsSchema,
  periodMonth,
  recurringApplySchema,
  recurringUpsertSchema,
  saveEntrySchema,
  saveReadingsSchema,
  updateExpenseSchema,
  uuid,
} from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireAllPermissions, requirePermission, userHasPermission } from "../../middleware/require-permission";
import {
  billService,
  createExpensesService,
  deleteAttachmentService,
} from "./service";
import { getBillingFundsSummary } from "../billing-funds-summary/service";
import {
  applyRecurringService,
  archiveRecurringService,
  disableRecurringService,
  listRecurringLinesService,
  listRecurringService,
  previewRecurringService,
} from "./recurring.service";
import {
  getAttachmentUrlService,
  getBearerConfigService,
  getGridService,
  listAttachmentsService,
  listExpensesService,
  listLineAttachmentService,
  listSummaryNotesService,
  saveEntryService,
  saveReadingsService,
  saveSummaryNoteService,
  setBearerConfigService,
  updateExpenseService,
  updateLinesService,
  uploadAttachmentService,
  uploadLineAttachmentService,
  voidExpenseService,
  retryGraduationForEntryService,
} from "./service";

const billsGridRoutes = new Hono<{ Variables: { session: SessionPayload } }>();
const idParam = z.string().uuid();

// Route-local query schemas: the shared package (Task 4) ships no list-query
// schema, so build them here from the shared primitives so the periodMonth/uuid/
// bearer contracts stay single-sourced with the bodies.
const expenseListQuerySchema = z.object({
  apartmentId: uuid.optional(),
  billingMonth: periodMonth.optional(),
  bearer: bearer.optional(),
  q: z.string().optional(),
});
const attachmentQuerySchema = z.object({
  period: periodMonth,
  cellKey: z.string().trim().min(1).max(120).optional(),
  columnId: z.string().trim().min(1).max(80).optional(),
  documentKind: z.enum(["invoice", "receipt"]).optional(),
});

// Nature routing (ENABLE_CHARGE_NATURE_ROUTING, spec R5): the recurring APPLY body
// may carry an explicit Expense/Profit nature. Route-local extension of the shared
// apply schema — kept here (not in @kason/shared) so the fail-closed guard stays
// co-located with the handler and neither the preview route nor the internal
// disable/archive callers (which never carry nature) are affected.
const recurringApplyWithNatureSchema = recurringApplySchema.extend({
  nature: z.enum(["expense", "profit"]).optional(),
});

// ── Feature-flag gate (FIRST — before requireRole; canonical 404 even unauth) ─
billsGridRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID")) return c.json({ error: "not_found" }, 404);
  await next();
});

// Private per-module helpers. meter/routes.ts:60,64 declares its own copies —
// these are NOT shared lib exports. `domain: "bills-grid"` (not "tenancy", whose
// DOMAIN_FIELD_LABELS entry is empty).
function zodBadRequest(c: Context, error: ZodError) {
  const friendly = formatZodError(error, { domain: "bills-grid" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}
function badId(c: Context) {
  return c.json({ error: "Invalid id" }, 400);
}

// ── 1. Batched grid read (§1) — editor, read-only, always 200 ────────────────
billsGridRoutes.get("/", requirePermission("billing.view"), async (c) => {
  const parsed = gridQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await getGridService(c.get("session"), parsed.data);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});

// Reporting is a separate request by design. A reporting failure must never
// blank the operational grid or hide its saved apartment rows.
billsGridRoutes.get("/funds-summary", requirePermission("billing.view"), async (c) => {
  const parsed = z.object({ period: periodMonth }).safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const month = new Date(`${parsed.data.period.slice(0, 7)}-01T00:00:00.000Z`);
  const summary = await getBillingFundsSummary(c.get("session").orgId, month);
  if (!(await userHasPermission(c.get("session"), "cost.view"))) {
    // Billing totals remain visible, but supplier-cost and margin facts do not.
    // This is response-level redaction so browser DevTools cannot bypass the UI.
    return c.json({
      ...summary,
      tenantExpenseDirectCosts: "0.00",
      tenantExpenseGrossMargin: "0.00",
      tenantExpenseCostPendingCount: 0,
      tenantExpenseActionRequiredCount: 0,
      tenantExpenseActionItems: [],
    }, 200);
  }
  return c.json(summary, 200);
});

const summaryNoteSchema = z.object({ period: periodMonth, note: z.string().max(500) });

billsGridRoutes.get("/summary-notes", requirePermission("billing.view"), async (c) => {
  const parsed = z.object({ period: periodMonth }).safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  return c.json({ data: await listSummaryNotesService(c.get("session"), parsed.data.period) }, 200);
});

billsGridRoutes.put("/apartments/:apartmentId/summary-note", requirePermission("billing.save"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = summaryNoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const result = await saveSummaryNoteService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data }, 200);
});

// ── 2. Save draft (§2) — editor. amounts-only; no pattern/bearer ─────────────
billsGridRoutes.put("/apartments/:apartmentId/entries", requireAllPermissions("billing.charge.edit", "billing.save"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = saveEntrySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await saveEntryService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 404 | 409 | 500);
  return c.json(r.data, r.status as 200);
});

// ── 2a. Update line settings on an unbilled entry (§2a) — MANAGER (editor 403) ─
billsGridRoutes.patch("/entries/:id/lines", requirePermission("billing.rebill"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = lineSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await updateLinesService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 500);
  return c.json(r.data, r.status as 200);
});

// ── 3. Bill (§3) — MANAGER (mirrors meter `charge`). 200 manifest even when rows
// fail; there is NO request-level abort and NO 422. ──────────────────────────
billsGridRoutes.post("/bill", requirePermission("billing.bill"), async (c) => {
  const parsed = billSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await billService(c.get("session"), parsed.data);
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});

// ── 4. Bearer-config read (§5) — editor (may read; writes require manager) ────
billsGridRoutes.get("/apartments/:apartmentId/bearer-config", requirePermission("billing.view"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const r = await getBearerConfigService(c.get("session"), c.req.param("apartmentId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, r.status as 200);
});

// ── 5. Bearer-config write (§5) — MANAGER (editor 403). Set-once + audited unlock.
billsGridRoutes.put("/apartments/:apartmentId/bearer-config", requirePermission("billing.charge.edit"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = bearerConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await setBearerConfigService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 500);
  return c.json(r.data, r.status as 200);
});

// ── 5b. Recurring charges (recurring-charges feature) — READ editor; every MUTATION
// Manager-only (mirrors bearer-config). Additionally gated on ENABLE_PHASE2_BILLING_DOCS:
// dark ⇒ 404 (flag-dark hides existence), matching the spec's flag-dark contract. The
// service re-checks every syncability guard; apply is atomic block-all (409 carries conflicts).
billsGridRoutes.get("/apartments/:apartmentId/recurring", requirePermission("billing.view"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const r = await listRecurringService(c.get("session"), c.req.param("apartmentId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.get("/apartments/:apartmentId/recurring/lines", requirePermission("billing.view"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = attachmentQuerySchema.safeParse(c.req.query()); // { period }
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await listRecurringLinesService(c.get("session"), c.req.param("apartmentId"), parsed.data.period);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.post("/apartments/:apartmentId/recurring/preview", requirePermission("billing.charge.edit"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = recurringUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await previewRecurringService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.post("/apartments/:apartmentId/recurring/apply", requirePermission("billing.charge.edit"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = recurringApplyWithNatureSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  // Fail CLOSED (spec R5) — but only where a nature decision is genuinely being made:
  // CREATING a nature-carrying kind (CLEANING/WIFI/CUSTOM) without one. EDITS with
  // nature omitted copy the latest revision's decided nature forward service-side
  // (never a silent null), and TNB/AIR/MAINTENANCE have no nature slot at all —
  // 422ing those made the Setting drawer's Save half-apply in nature-routing envs.
  // Flag OFF ⇒ nature is ignored (unchanged).
  const natureKinds = new Set(["CLEANING", "WIFI", "CUSTOM"]);
  if (
    isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING") &&
    parsed.data.nature === undefined &&
    parsed.data.definitionId === undefined &&
    natureKinds.has(parsed.data.kind)
  ) {
    return c.json({ error: "NATURE_REQUIRED" }, 422);
  }
  const r = await applyRecurringService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!r.ok) {
    if (r.status === 409) return c.json({ error: r.error, conflicts: r.conflicts }, 409);
    return c.json({ error: r.error }, r.status as 400 | 404);
  }
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.post("/apartments/:apartmentId/recurring/:definitionId/disable", requirePermission("billing.charge.edit"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success || !idParam.safeParse(c.req.param("definitionId")).success) return badId(c);
  const r = await disableRecurringService(c.get("session"), c.req.param("apartmentId"), c.req.param("definitionId"));
  if (!r.ok) {
    if (r.status === 409) return c.json({ error: r.error, conflicts: r.conflicts }, 409);
    return c.json({ error: r.error }, r.status as 400 | 404);
  }
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.post("/apartments/:apartmentId/recurring/:definitionId/archive", requirePermission("billing.charge.edit"), async (c) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return c.json({ error: "not_found" }, 404);
  if (!idParam.safeParse(c.req.param("apartmentId")).success || !idParam.safeParse(c.req.param("definitionId")).success) return badId(c);
  const r = await archiveRecurringService(c.get("session"), c.req.param("apartmentId"), c.req.param("definitionId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404);
  return c.json(r.data, r.status as 200);
});

// ── 6. Expenses (§5) — create/list/edit editor; void MANAGER ─────────────────
billsGridRoutes.post("/expenses", requirePermission("billing.charge.edit"), async (c) => {
  const parsed = createExpensesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const includesInternalCost = parsed.data.items.some((item) =>
    item.actualCost !== undefined ||
    item.costVendor !== undefined ||
    item.costPaymentStatus !== undefined ||
    item.costPaymentDate !== undefined ||
    item.costPaymentAccount !== undefined ||
    item.costNotes !== undefined,
  );
  if (includesInternalCost && !(await userHasPermission(c.get("session"), "cost.create"))) {
    return c.json({ error: "permission_forbidden", permission: "cost.create" }, 403);
  }
  const r = await createExpensesService(c.get("session"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, r.status as 201);
});
billsGridRoutes.get("/expenses", requirePermission("billing.view"), async (c) => {
  const parsed = expenseListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const includeInternalCosts = await userHasPermission(c.get("session"), "cost.view");
  const r = await listExpensesService(c.get("session"), parsed.data, { includeInternalCosts });
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});
billsGridRoutes.patch("/expenses/:id", requirePermission("billing.charge.edit"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const parsed = updateExpenseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const includesInternalCost =
    parsed.data.actualCost !== undefined ||
    parsed.data.costVendor !== undefined ||
    parsed.data.costPaymentStatus !== undefined ||
    parsed.data.costPaymentDate !== undefined ||
    parsed.data.costPaymentAccount !== undefined ||
    parsed.data.costNotes !== undefined;
  if (includesInternalCost && !(await userHasPermission(c.get("session"), "cost.edit"))) {
    return c.json({ error: "permission_forbidden", permission: "cost.edit" }, 403);
  }
  const r = await updateExpenseService(c.get("session"), c.req.param("id"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 500);
  return c.json(r.data, r.status as 200);
});
billsGridRoutes.post("/expenses/:id/void", requirePermission("billing.rebill"), async (c) => {
  if (!idParam.safeParse(c.req.param("id")).success) return badId(c);
  const r = await voidExpenseService(c.get("session"), c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409 | 500);
  return c.json(r.data, r.status as 200);
});

// -- 6b. Graduation retry (proforma spec R13) -- MANAGER ----------------------
// Graduation runs post-commit and never throws, so a failure leaves the tenant correctly
// PAID with the tax invoice missing. Without this an operator's only recourse is reading
// `graduation.issue_failed` audit rows. Idempotent: it re-derives what is missing rather
// than replaying a remembered failure, so an empty result is the ordinary answer once
// someone has already repaired it -- 200, not an error.
billsGridRoutes.post("/entries/:entryId/graduate-retry", requirePermission("billing.bill"), async (c) => {
  if (!idParam.safeParse(c.req.param("entryId")).success) return badId(c);
  const r = await retryGraduationForEntryService(c.get("session"), c.req.param("entryId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 409);
  return c.json(r.data, r.status as 200);
});

// ── 7. Meter-reading write (§6) — editor. Upsert per (apartment, period, room) ─
billsGridRoutes.put("/apartments/:apartmentId/meter-readings", requireAllPermissions("billing.charge.edit", "billing.save"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsed = saveReadingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zodBadRequest(c, parsed.error);
  const r = await saveReadingsService(c.get("session"), c.req.param("apartmentId"), parsed.data);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 404 | 409);
  return c.json(r.data, r.status as 200);
});

// ── 8. Attachments (§7) — upload/list editor; delete MANAGER ─────────────────
// Upload: multipart/form-data, files under form key "files"; the apartment-month
// is addressed by ?period=YYYY-MM-DD. The GridAttachment row is written by the
// service only after a confirmed 2xx putObject (R28); a per-file storage fault is
// 502. Empty/invalid form → 400 {error:"Invalid form body"}.
billsGridRoutes.post("/apartments/:apartmentId/attachments", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsedQuery = attachmentQuerySchema.safeParse(c.req.query());
  if (!parsedQuery.success) return zodBadRequest(c, parsedQuery.error);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);
  const uploads = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0) return c.json({ error: "Invalid form body" }, 400);

  const data: Array<{ id: string; storageKey: string }> = [];
  for (const file of uploads) {
    const r = await uploadAttachmentService(c.get("session"), c.req.param("apartmentId"), {
      period: parsedQuery.data.period,
      cellKey: parsedQuery.data.cellKey,
      columnId: parsedQuery.data.columnId,
      documentKind: parsedQuery.data.documentKind,
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 502);
    data.push(r.data);
  }
  return c.json({ data }, 201);
});
billsGridRoutes.get("/apartments/:apartmentId/attachments", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("apartmentId")).success) return badId(c);
  const parsedQuery = attachmentQuerySchema.safeParse(c.req.query());
  if (!parsedQuery.success) return zodBadRequest(c, parsedQuery.error);
  const r = await listAttachmentsService(c.get("session"), c.req.param("apartmentId"), parsedQuery.data.period, {
    cellKey: parsedQuery.data.cellKey,
    columnId: parsedQuery.data.columnId,
    documentKind: parsedQuery.data.documentKind,
  });
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200);
});
// Delete: object first (fail-closed), then the row; a genuine storage failure is
// 502 ATTACHMENT_DELETE_FAILED with the row retained (no orphan).
billsGridRoutes.delete("/apartments/:apartmentId/attachments/:attId", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("attId")).success) return badId(c);
  const r = await deleteAttachmentService(c.get("session"), c.req.param("attId"));
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 502);
  return c.json({ ok: true }, 200);
});

// ── 9. Per-line attachments (T1) — upload/list editor. Scope is the expenseId
// path param alone — there is NO ?period (unlike the entry-level routes above);
// the expense already carries its entry/apartment/period. Delete is UNCHANGED —
// the existing manager-gated DELETE .../attachments/:attId route above is reused
// verbatim (an attachment id alone identifies the row + object).
billsGridRoutes.post("/expenses/:expenseId/attachments", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("expenseId")).success) return badId(c);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);
  const uploads = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0) return c.json({ error: "Invalid form body" }, 400);
  const data: Array<{ id: string; storageKey: string }> = [];
  for (const file of uploads) {
    const r = await uploadLineAttachmentService(c.get("session"), c.req.param("expenseId"), {
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 502);
    data.push(r.data);
  }
  return c.json({ data }, 201);
});
billsGridRoutes.get("/expenses/:expenseId/attachments", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("expenseId")).success) return badId(c);
  const r = await listLineAttachmentService(c.get("session"), c.req.param("expenseId"));
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200 | 404);
});

// ── 10. Attachment preview URL (§7, Item 4) — a short-lived signed URL for
// INLINE view of an attachment. SHARED for entry-level AND per-line attachments:
// an attachment id alone identifies the row + object (same basis as the reused
// manager DELETE route). Editor-gated read, matching the list routes above.
billsGridRoutes.get("/attachments/:attId/url", requirePermission("billing.document_manage"), async (c) => {
  if (!idParam.safeParse(c.req.param("attId")).success) return badId(c);
  const r = await getAttachmentUrlService(c.get("session"), c.req.param("attId"));
  return c.json(r.ok ? r.data : { error: r.error }, r.status as 200 | 404);
});

export { billsGridRoutes };
