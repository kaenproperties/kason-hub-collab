import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ZodError } from "zod";
import {
  ownerLedgerEntryInput,
  ownerLedgerListQuery,
  ownerLedgerEntryPatch,
  ownerLedgerSyncInput,
  ownerLedgerRangeQuery,
} from "@kason/shared";
import { requirePermission } from "../../middleware/require-permission";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { createSignedUploadUrl } from "../../lib/storage";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { ownerLedgerFlagGate } from "./owner-ledger.gate";
import { createPriorPeriodAdjustment } from "./prior-period-adjustment";
import {
  createEntryService,
  listEntriesService,
  getEntryService,
  updateEntryService,
  voidEntryService,
  getSummaryService,
  getTaxSummaryService,
  getOwnerTreeService,
  getOwnersSummaryService,
  getOwnerMonthsService,
  getUnitsSummaryService,
  getOrgUnitsSummaryService,
  getApartmentContextService,
  recomputeUnitMonthLedgerService,
} from "./owner-ledger.service";
import { syncMonthService } from "./owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "./owner-ledger.types";
import { buildReceiptWithBillsPdf } from "./owner-ledger-receipt.service";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

const ownerLedgerRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate first: every /api/owner-ledger route 404s (canonical "not_found")
// while ENABLE_PHASE2_OWNER_BILLING is dark, BEFORE any auth/role check runs.
ownerLedgerRoutes.use("*", ownerLedgerFlagGate);

type OwnerLedgerCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: OwnerLedgerCtx): OwnerLedgerActorCtx {
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

function zerr(c: OwnerLedgerCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "owner-ledger" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// ─── Route-local schemas ──────────────────────────────────────────────────────

const voidBody = z.object({ expectedUpdatedAt: z.string().datetime() });

// ─── Ledger entries — CRUD ────────────────────────────────────────────────────
// WRITES = requireRole("admin"); READS = requireRole("manager").

ownerLedgerRoutes.post("/entries", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = ownerLedgerEntryInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await createEntryService(actor(c), parsed.data);
  // R2: a closed-period rejection carries the structured 409 body; surface it verbatim.
  if (!result.ok) {
    if (result.body) return c.json(result.body, 409);
    return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 201);
});

ownerLedgerRoutes.get("/entries", requirePermission("owner_report.view"), async (c) => {
  const parsed = ownerLedgerListQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { limit, offset, ...filters } = parsed.data;

  // T2': read-through sync — materialise the owner-ledger month on-demand so the
  // admin sees current data when they open a specific owner+month view, without
  // requiring a manual "Sync" button click.
  // Only fires when the request is scoped to a SPECIFIC ownerPartyId + month
  // (not the all-owners listing or month-unscoped queries).
  // Failures are swallowed and logged: the page must still render existing rows.
  if (filters.ownerPartyId && filters.month) {
    try {
      const syncResult = await syncMonthService(actor(c), {
        ownerPartyId: filters.ownerPartyId,
        month: filters.month,
      });
      if (!syncResult.ok) {
        console.error(
          "[owner-ledger.routes] read-through sync returned error (swallowed):",
          syncResult.error,
        );
      }
    } catch (e) {
      console.error("[owner-ledger.routes] read-through sync failed (swallowed):", e);
    }
  }

  const result = await listEntriesService(actor(c), filters, { limit, offset });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

ownerLedgerRoutes.get("/entries/:id", requirePermission("owner_report.view"), async (c) => {
  const result = await getEntryService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ownerLedgerRoutes.patch("/entries/:id", requirePermission("owner_report.reopen"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = ownerLedgerEntryPatch.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateEntryService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ownerLedgerRoutes.post("/entries/:id/void", requirePermission("owner_report.reopen"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = voidBody.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await voidEntryService(actor(c), c.req.param("id"), parsed.data.expectedUpdatedAt);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// ─── Sync ─────────────────────────────────────────────────────────────────────
// WRITE = requireRole("admin").

ownerLedgerRoutes.post("/sync", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = ownerLedgerSyncInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await syncMonthService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Prior-period adjustment (R4 spike) — flag-dark, admin-only ────────────────
// POST /api/owner-ledger/prior-period-adjustments. Records a newly-discovered prior-
// period CHARGE dated into an already-FROZEN month: the source Charge keeps its true
// frozen billingMonth; its owner-ledger effect posts as a `prior_period_adjustment`
// entry into the current OPEN month (atomic; no frozen row; no direction flip).
//
// MOUNT: inside ownerLedgerRoutes (spec API path `/owner-ledger/prior-period-adjustments`),
// so it inherits the module's ENABLE_PHASE2_OWNER_BILLING gate + admin RBAC. Its OWN flag
// (ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT) is checked FIRST — BEFORE requireRole — so while
// the spike is dark every caller (any role) gets the canonical 404, leaking no shape.
const ppaSourceChargeInput = z.object({
  id: z.string().uuid().optional(),
  unitId: z.string().uuid(),
  partyId: z.string().uuid(),
  chargeType: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "amount must be a 2dp money string"),
  outstandingAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  status: z.string().optional(),
  tenancyId: z.string().uuid().nullish(),
  dueDate: z.string().optional(),
  chargeNumber: z.string().optional(),
  currency: z.string().optional(),
  description: z.string().nullish(),
});

const ppaBody = z
  .object({
    ownerPartyId: z.string().uuid(),
    originalBillingMonth: z.string().regex(/^\d{4}-\d{2}$/, "originalBillingMonth must match YYYY-MM"),
    targetPostingMonth: z.string().regex(/^\d{4}-\d{2}$/, "targetPostingMonth must match YYYY-MM").optional(),
    sourceChargeId: z.string().uuid().optional(),
    sourceChargeInput: ppaSourceChargeInput.optional(),
  })
  .refine((b) => !!b.sourceChargeId !== !!b.sourceChargeInput, {
    message: "provide exactly one of sourceChargeId or sourceChargeInput",
  });

ownerLedgerRoutes.post(
  "/prior-period-adjustments",
  // Flag gate FIRST (before auth): canonical 404 while the spike is dark, no shape leak.
  async (c, next) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT")) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  },
  requirePermission("owner_report.reopen"),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = ppaBody.safeParse(body);
    if (!parsed.success) return zerr(c, parsed.error);
    const result = await createPriorPeriodAdjustment(actor(c), parsed.data);
    if (!result.ok) {
      // A closed-period rejection carries the structured 409 body (R2); surface it verbatim.
      if (result.body) return c.json(result.body, 409);
      return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
    }
    return c.json({ data: result.data }, 201);
  },
);

// ─── Summary / tax-summary ────────────────────────────────────────────────────
// READ = requireRole("manager").

ownerLedgerRoutes.get("/summary", requirePermission("owner_report.view"), async (c) => {
  const parsed = ownerLedgerRangeQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getSummaryService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

ownerLedgerRoutes.get("/tax-summary", requirePermission("owner_report.view"), async (c) => {
  const parsed = ownerLedgerRangeQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getTaxSummaryService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Owner-tree ───────────────────────────────────────────────────────────────
// READ = requireRole("manager").

const ownerTreeQuery = z.object({
  ownerPartyId: z.string().uuid({ message: "ownerPartyId must be a valid UUID" }),
});

ownerLedgerRoutes.get("/owner-tree", requirePermission("owner_report.view"), async (c) => {
  const parsed = ownerTreeQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await getOwnerTreeService(actor(c), parsed.data.ownerPartyId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Owners summary ────────────────────────────────────────────────────────────
// READ = requireRole("manager"). Returns per-owner aggregate for a month range.

const ownersSummaryQuery = z.object({
  fromMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "fromMonth must match YYYY-MM")
    .optional(),
  toMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "toMonth must match YYYY-MM")
    .optional(),
});

ownerLedgerRoutes.get("/owners-summary", requirePermission("owner_report.view"), async (c) => {
  const parsed = ownersSummaryQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);

  // Omitted months = all-time (no defaulting to current month).
  const result = await getOwnersSummaryService(actor(c), {
    fromMonth: parsed.data.fromMonth,
    toMonth: parsed.data.toMonth,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Owner monthly summaries (2a-5) ──────────────────────────────────────────
// READ = requireRole("manager"). Returns per-month summary cards for a specific
// owner: Gross / Expenses / Net Payout / status / statementId.

const ownerMonthsQuery = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/, "year must be a 4-digit year")
    .optional(),
  // Optional per-apartment scope: present ⇒ the cards reflect ONLY that apartment
  // (entries + statement + deposits); absent ⇒ owner-combined (unchanged).
  apartmentId: z.string().uuid().optional(),
});

ownerLedgerRoutes.get("/owners/:ownerPartyId/months", requirePermission("owner_report.view"), async (c) => {
  const ownerPartyId = c.req.param("ownerPartyId");
  const parsed = ownerMonthsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { year, apartmentId } = parsed.data;
  // apartmentId absent ⇒ call with the SAME 3-arg shape as before. A trailing
  // `undefined` 4th arg would NOT be byte-identical: Vitest's toHaveBeenCalledWith
  // (existing route suite) does not treat trailing undefined as optional.
  const result = apartmentId
    ? await getOwnerMonthsService(actor(c), ownerPartyId, year, apartmentId)
    : await getOwnerMonthsService(actor(c), ownerPartyId, year);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Owner units-summary (Task 5) ────────────────────────────────────────────
// READ = requireRole("manager"). Per-unit + combined payout cards for a month.
// Converges with the /months card: combined.netPayout === months[month].netPayoutToOwner.

const unitsSummaryQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must match YYYY-MM"),
});

ownerLedgerRoutes.get("/owners/:ownerPartyId/units-summary", requirePermission("owner_report.view"), async (c) => {
  const ownerPartyId = c.req.param("ownerPartyId");
  const parsed = unitsSummaryQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { month } = parsed.data;
  // requireRole("manager") guarantees role is "admin" | "manager" — cast is safe.
  const result = await getUnitsSummaryService(
    actor(c) as unknown as OwnerBillingActorCtx,
    ownerPartyId,
    month,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Org-wide units summary (P4 unit-first ledger) ───────────────────────────
// READ = requireRole("manager"). Front door for the Units tab: paginated
// per-apartment month figures across ALL owners. Static "/units-summary" —
// distinct from "/owners/:ownerPartyId/units-summary", no shadowing.

const orgUnitsSummaryQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, "month must match YYYY-MM-01"),
  q: z.string().trim().min(1).max(100).optional(),
  propertyId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

ownerLedgerRoutes.get("/units-summary", requirePermission("owner_report.view"), async (c) => {
  const parsed = orgUnitsSummaryQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  // requireRole("manager") guarantees role is "admin" | "manager" — cast is safe
  // (same pattern as the per-owner units-summary route above).
  const result = await getOrgUnitsSummaryService(
    actor(c) as unknown as OwnerBillingActorCtx,
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Manual recompute (Task 8) ────────────────────────────────────────────────
// POST /owner-ledger/units-summary/recompute — admin escape hatch to
// re-materialize UnitMonthLedger figures on demand. requireRole("manager")
// matches the read route; cast to OwnerBillingActorCtx is safe (same pattern
// as GET /units-summary above).

const recomputeBody = z.object({
  month: z.string().regex(/^\d{4}-\d{2}-01$/, "month must match YYYY-MM-01"),
  ownerPartyId: z.string().uuid().optional(),
});

ownerLedgerRoutes.post("/units-summary/recompute", requirePermission("owner_report.generate"), async (c) => {
  const parsed = recomputeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await recomputeUnitMonthLedgerService(
    actor(c) as unknown as OwnerBillingActorCtx,
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Apartment context (P4 unit workspace) ────────────────────────────────────
// READ = requireRole("manager"). Header + inverted unit-first cascade resolve.

const apartmentIdParam = z.string().uuid();

ownerLedgerRoutes.get("/units/:apartmentId/context", requirePermission("owner_report.view"), async (c) => {
  const apartmentId = c.req.param("apartmentId");
  if (!apartmentIdParam.safeParse(apartmentId).success) {
    return c.json({ error: "Invalid apartment id" }, 400);
  }
  const result = await getApartmentContextService(actor(c), apartmentId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Entry attachment upload-url mint (2c-5) ──────────────────────────────────
// Mint-only: client PUTs directly to Supabase, then submits the returned key(s)
// in the entry form body's attachmentKeys array. No /complete call — the entry
// form controls the key list locally and persists it on submit.
// Storage prefix: owner-ledger-entries/<uuid>.<ext>

const ENTRY_ATTACHMENT_EXTS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const entryAttachmentUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
  sizeBytes: z.number().int().positive().max(15 * 1024 * 1024),
});

ownerLedgerRoutes.post("/entries/attachments/upload-url", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = entryAttachmentUploadSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  // filename is validated for display length only — never echoed into storageKey (server UUID prevents path injection)
  const { mimeType } = parsed.data;
  const ext = ENTRY_ATTACHMENT_EXTS[mimeType] ?? "bin";
  const storageKey = `owner-ledger-entries/${randomUUID()}.${ext}`;
  const signed = await createSignedUploadUrl({ storageKey, contentType: mimeType });
  return c.json({ data: signed });
});

// ─── Receipt — on-demand itemized ledger extract (admin/manager only) ────────
// Mirrors GET /owner-billing/proof-pack (lines 523-539) exactly:
//   - requireRole("manager") allows admin + manager; portal roles are blocked.
//   - Zod validates ownerPartyId, month (YYYY-MM), optional apartmentId.
//   - Service returns null when no active ledger rows → 404.
//   - Responds with raw bytes + Content-Type/Disposition; never stored.
// Flag-gated by the module-level ownerLedgerFlagGate middleware above.

const receiptQuery = z.object({
  ownerPartyId: z.string().uuid({ message: "ownerPartyId must be a valid UUID" }),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must match YYYY-MM"),
  apartmentId: z.string().uuid().optional(),
});

ownerLedgerRoutes.get("/receipt", requirePermission("owner_report.download"), async (c) => {
  const parsed = receiptQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { ownerPartyId, month, apartmentId } = parsed.data;
  // requireRole("manager") above guarantees the role is "admin" | "manager" (never
  // "owner"), so the OwnerLedgerActorCtx → OwnerBillingActorCtx cast is safe.
  const bytes = await buildReceiptWithBillsPdf(
    actor(c) as unknown as OwnerBillingActorCtx,
    ownerPartyId,
    month,
    apartmentId ?? null,
  );
  if (!bytes) return c.json({ error: "No ledger entries" }, 404);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="receipt-${month}.pdf"`,
    },
  });
});

export { ownerLedgerRoutes };
