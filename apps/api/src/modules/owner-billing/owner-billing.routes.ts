import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { ZodError } from "zod";
import { z } from "zod";
import {
  generateStatementInput,
  managementFeeConfigInput,
  managementFeeConfigPatch,
  statementLineInput,
  statementLinePatch,
  voidReasonBody,
  FEE_TYPES,
} from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import type { AdminRole } from "../../lib/rbac";
import { requirePermission } from "../../middleware/require-permission";
import { getActorHeaders } from "../../lib/actor-ctx";
import { formatZodError } from "../../lib/zod-error-mapper";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { ownerBillingFlagGate } from "./owner-billing.gate";
import {
  addAdjustmentLineService,
  addStatementLineService,
  approveStatementService,
  firstCheckStatementService,
  getStatementApprovalPreflightService,
  createFeeConfigService,
  generateStatementService,
  getBillingReadinessService,
  getFeeConfigService,
  getStatementPdfUrl,
  getStatementService,
  listFeeConfigsService,
  listStatementsService,
  regenerateStatementPdf,
  restoreFeeConfigService,
  retireFeeConfigService,
  sendStatementService,
  updateFeeConfigService,
  updateStatementLineService,
  voidStatementLineService,
  voidStatementService,
  getStatementSectionsService,
  getLiveStatementSectionsService,
  renderLiveStatementPdfBytes,
} from "./owner-billing.service";
import {
  detachReceiptService,
  listReceiptUrlsService,
  uploadReceiptsService,
  type ReceiptFile,
} from "./owner-billing-receipts.service";
import {
  attachExpenseProofService,
  detachExpenseProofService,
  listExpenseProofUrlsService,
  type ProofFile,
} from "./owner-expense-proof.service";
import { buildProofPackPdf } from "./proof-pack.service";
import {
  resolveOwnerStatementsInRange,
  streamMonthRangeZip,
  validateExportRange,
} from "./multi-month-export.service";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

const ownerBillingRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate first: every /api/owner-billing route 404s (canonical "not_found")
// while ENABLE_PHASE2_OWNER_BILLING is dark, BEFORE any auth/role check runs.
ownerBillingRoutes.use("*", ownerBillingFlagGate);

type OwnerBillingCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: OwnerBillingCtx): OwnerBillingActorCtx {
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

function zerr(c: OwnerBillingCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "owner-billing" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// Query schema for the list endpoint — every filter optional. `isActive` and the
// paging numbers arrive as strings; coerce/transform them here so the service
// receives typed values. `limit` is clamped to a sane ceiling.
const listFeeConfigsQuery = z.object({
  ownerPartyId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  apartmentId: z.string().uuid().optional(),
  feeType: z.enum(FEE_TYPES).optional(),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// PATCH validator: the shared managementFeeConfigPatch (every config field
// optional + required expectedUpdatedAt). The shared schema can't carry the
// cap→capAmount refine (it derives from `.partial()`), so re-apply that one
// cross-field rule HERE, at the route boundary, without redefining the schema:
// when a patch switches feeType to "cap" it must also carry capAmount.
const feeConfigPatchBody = managementFeeConfigPatch.refine(
  (v) => v.feeType !== "cap" || v.capAmount != null,
  { message: "capAmount is required when feeType is 'cap'", path: ["capAmount"] },
);

// ─── Management-fee configs ────────────────────────────────────────────────
// Config WRITE = requireRole("admin"); config READ = requireRole("manager").
// require-role.ts also enforces operator userType, so portal sessions 403.

ownerBillingRoutes.post("/fee-configs", requirePermission("management_fee.configure"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = managementFeeConfigInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await createFeeConfigService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 201);
});

ownerBillingRoutes.get("/fee-configs", requirePermission("management_fee.configure"), async (c) => {
  const parsed = listFeeConfigsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { limit, offset, ...filters } = parsed.data;
  const result = await listFeeConfigsService(actor(c), filters, { limit, offset });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

ownerBillingRoutes.get("/fee-configs/:id", requirePermission("management_fee.configure"), async (c) => {
  const result = await getFeeConfigService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ownerBillingRoutes.patch("/fee-configs/:id", requirePermission("management_fee.configure"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = feeConfigPatchBody.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateFeeConfigService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/fee-configs/:id/retire", requirePermission("management_fee.configure"), async (c) => {
  const result = await retireFeeConfigService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/fee-configs/:id/restore", requirePermission("management_fee.configure"), async (c) => {
  const result = await restoreFeeConfigService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// GET /owner-units was REMOVED 2026-08-17 with the cleaning-bill form it bounded.

// R3: lightweight billing-readiness signal for the tracker "Bill this unit"
// pre-check. READ = manager. Advisory only — the R2 server guard is authoritative.
ownerBillingRoutes.get("/units/:apartmentId/billing-readiness", requirePermission("owner_report.view"), async (c) => {
  const result = await getBillingReadinessService(actor(c), c.req.param("apartmentId"));
  // getBillingReadinessService always returns ok:true (it has no error branch); this
  // guard is defensive-only, matching every other OwnerBillingServiceResult call site
  // in this file (e.g. GET /fee-configs/:id) so `result.data` narrows without a cast.
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data });
});

// ─── Owner statements (C4) ─────────────────────────────────────────────────
// Generate = requireRole("admin"); list = requireRole("manager"). Generate is
// idempotent on {owner, month}: a re-run returns the existing draft (HTTP 200)
// rather than creating a duplicate (a fresh statement returns 201).

// COMBINED-ONLY: generate yields exactly ONE owner_statement Invoice per
// {owner, month} (apartmentId null), covering all the owner's units. The strict
// generateStatementInput rejects a stray `apartmentId` (400) — per-unit statement
// generation is retired; per-unit reporting is a separate on-demand Receipt.
ownerBillingRoutes.post("/statements", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = generateStatementInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await generateStatementService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data }, result.status as 200 | 201);
});

// Query schema for the statement list — every filter optional. billingMonth is
// "YYYY-MM"; status is free-text (draft → approved → sent → paid | void). The
// org comes from the SESSION, never the query — cross-org reads are impossible.
const listStatementsQuery = z.object({
  ownerPartyId: z.string().uuid().optional(),
  status: z.string().min(1).max(40).optional(),
  billingMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "expected YYYY-MM")
    .optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

ownerBillingRoutes.get("/statements", requirePermission("owner_report.view"), async (c) => {
  const parsed = listStatementsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { limit, offset, ...filters } = parsed.data;
  const result = await listStatementsService(actor(c), filters, { limit, offset });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

// ─── Multi-month statement export — streamed ZIP (D1) ──────────────────────
// Download an owner's CLEAN statement PDFs across [fromMonth, toMonth] as ONE
// streamed ZIP (admin/manager). includeProof=1 also bundles each month's separate
// proof pack (bills-*.pdf). The range is capped at ≤24 months AND from ≤ to (else
// 400); no POST-only statements in range → 404. Reuses the PURE renderer (or a
// stored Invoice.pdfKey) — no side effects, no re-stored PDFs, no audit. The ZIP is
// streamed (bounded memory). Flag-dark → 404 via the module gate above. Registered
// BEFORE /statements/:id so the static "export" path is never captured as an id.
const exportQuery = z.object({
  ownerPartyId: z.string().uuid(),
  fromMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  toMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  includeProof: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

ownerBillingRoutes.get("/statements/export", requirePermission("owner_report.download"), async (c) => {
  const parsed = exportQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { ownerPartyId, fromMonth, toMonth, includeProof } = parsed.data;

  const range = validateExportRange(fromMonth, toMonth);
  if (!range.ok) return c.json({ error: range.error }, 400);

  // Resolve first so an empty range is a clean 404 (a started 200 stream can't 404).
  const statements = await resolveOwnerStatementsInRange(actor(c), ownerPartyId, fromMonth, toMonth);
  if (statements.length === 0) return c.json({ error: "No statements to export in range" }, 404);

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename="owner-statements-${fromMonth}_to_${toMonth}.zip"`);
  return stream(
    c,
    async (s) => {
      await streamMonthRangeZip(actor(c), { ownerPartyId, fromMonth, toMonth, includeProof }, s);
    },
    async (err) => {
      // Headers are already sent (200); log the mid-stream failure (rare — renders of
      // resolved statements). The client receives a truncated ZIP.
      // eslint-disable-next-line no-console
      console.error(`[owner-billing] export stream failed (owner ${ownerPartyId} ${fromMonth}..${toMonth}):`, err);
    },
  );
});

// ─── Statement LIVE 5-section view — no Invoice required (live-ledger) ──────
// Read = requireRole("manager") (mirrors GET /statements/:id/sections). Returns
// the SAME 5-section YannieSections computed LIVE from the posted ledger for
// (owner, month[, apartment]) WITHOUT issuing a statement — "Issue statement" now
// only produces the formal PDF, it is no longer a prerequisite to VIEW the
// detail. Additionally gated on ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER: 404 (no
// shape leak) while that flag is dark; the flag gate runs BEFORE the role check.
// Registered BEFORE /statements/:id so the static "live" path is never captured
// as an :id (same precedent as /statements/export above).
const liveStatementQuery = z.object({
  ownerPartyId: z.string().uuid(),
  billingMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  apartmentId: z.string().uuid().optional(),
});

ownerBillingRoutes.get(
  "/statements/live",
  async (c, next) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  },
  requirePermission("owner_report.view"),
  async (c) => {
    const parsed = liveStatementQuery.safeParse(c.req.query());
    if (!parsed.success) return zerr(c, parsed.error);
    const result = await getLiveStatementSectionsService(
      actor(c),
      parsed.data.ownerPartyId,
      parsed.data.billingMonth,
      parsed.data.apartmentId ?? null,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json({ data: result.data });
  },
);

// ─── LIVE statement PDF — real-time, stored NOWHERE ────────────────────────
// The PDF twin of /statements/live above: same assembler, same 5 sections, same
// flag gate, same manager role, and likewise registered BEFORE /statements/:id so
// the static path is never captured as an :id.
//
// Admin pulls this whenever they want and gets the figures AS THEY STAND — an
// unpaid tenant reads as unpaid. That is the point: it is a working document, not
// the owner's copy. No Invoice needs to exist first.
//
// Nothing is persisted. We do not putObject, do not set pdfKey, and do not touch
// OwnerStatementPeriod. A stored render of a live figure is stale as soon as a
// payment lands, and a failed store leaves a silently-absent file (the failure the
// freeze path's best-effort `pdfKey = null` already has). Rendering per request
// keeps the bytes current and turns a render failure into a 500 the caller sees.
//
// The OWNER's copy is a separate artifact rendered from the frozen month-end
// snapshot; this endpoint is admin-only and never feeds it.
ownerBillingRoutes.get(
  "/statements/live-pdf",
  async (c, next) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  },
  requirePermission("owner_report.download"),
  async (c) => {
    const parsed = liveStatementQuery.safeParse(c.req.query());
    if (!parsed.success) return zerr(c, parsed.error);
    const { ownerPartyId, billingMonth, apartmentId } = parsed.data;

    const bytes = await renderLiveStatementPdfBytes(
      actor(c),
      ownerPartyId,
      billingMonth,
      apartmentId ?? null,
    );
    const seg = apartmentId ? apartmentId.slice(0, 8) : "combined";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="owner-statement-${billingMonth}-${seg}.pdf"`,
      },
    });
  },
);

// ─── Owner statement detail + line add/edit/void (C5) ──────────────────────
// Detail = requireRole("manager"); line mutations (add/edit/void) = admin. Adds
// + edits are only allowed while the statement is draft (NON-draft → 409); a line
// void is allowed even post-approve. Stale line edit → 409 "Record changed —
// reloaded". Every query is org-scoped; cross-org → 404.

ownerBillingRoutes.get("/statements/:id", requirePermission("owner_report.view"), async (c) => {
  const result = await getStatementService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/lines", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = statementLineInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await addStatementLineService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 200);
});

ownerBillingRoutes.patch("/statements/:id/lines/:chargeId", requirePermission("owner_report.generate"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = statementLinePatch.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await updateStatementLineService(
    actor(c),
    c.req.param("id"),
    c.req.param("chargeId"),
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/lines/:chargeId/void", requirePermission("owner_report.reopen"), async (c) => {
  // Spec §4.3: reason mandatory (min 3) once ENABLE_PHASE2_BILLING_DOCS is on.
  let body: { reason?: string } | undefined;
  if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    const parsed = voidReasonBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return zerr(c, parsed.error);
    body = parsed.data;
  }
  const result = await voidStatementLineService(actor(c), c.req.param("id"), c.req.param("chargeId"), body);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

// Adjustment = requireRole("admin"): append an ad-hoc charge to a NON-terminal
// statement (approved/sent/draft) WITHOUT un-approving it — un-approving would hide
// the statement from the owner portal. A paid/void statement → 409. Same zod body as
// add-line ({ chargeType, description, amount }); the service re-syncs the owner
// ledger + regenerates the PDF and keeps the status unchanged.
ownerBillingRoutes.post("/statements/:id/adjust", requirePermission("owner_report.reopen"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = statementLineInput.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await addAdjustmentLineService(actor(c), c.req.param("id"), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 200);
});

// ─── Owner statement status transitions — approve / void / send (C8) ───────
// Per the locked crud-gate matrix, OwnerStatement WRITES are admin-only:
// Approve = requireRole("admin"): draft → approved.
// Void = requireRole("admin"): any non-paid → void.
// Send = requireRole("admin"): approved (WITH a pdfKey) → sent; returns the
// signed PDF download URL. SOFT-COPY ONLY — send NEVER auto-delivers; the generate
// path only ever yields a draft. Sending a draft → 409; sending an approved
// statement with no pdfKey → 400 (generate the PDF first). Every query is
// org-scoped; cross-org / unknown → 404. Stale transition → 409 "Record changed —
// reloaded". (Reads/list stay manager; generate stays admin.)

ownerBillingRoutes.get("/statements/:id/approval-preflight", requirePermission("owner_report.view"), async (c) => {
  const result = await getStatementApprovalPreflightService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/approve", requirePermission("owner_report.final_approve"), async (c) => {
  const result = await approveStatementService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/first-check", requirePermission("owner_report.first_check"), async (c) => {
  const result = await firstCheckStatementService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/void", requirePermission("owner_report.reopen"), async (c) => {
  let body: { reason?: string } | undefined;
  if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    const parsed = voidReasonBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return zerr(c, parsed.error);
    body = parsed.data;
  }
  const result = await voidStatementService(actor(c), c.req.param("id"), body);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json({ data: result.data });
});

ownerBillingRoutes.post("/statements/:id/send", requirePermission("owner_report.generate"), async (c) => {
  const result = await sendStatementService(actor(c), c.req.param("id"));
  // 400 = approved but no PDF yet; 409 = not approved (e.g. draft) or stale; 404 =
  // cross-org / unknown. On success the data carries { statement, downloadUrl }.
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

// ─── Owner statement PDF — regenerate / download (D1) ──────────────────────
// Regenerate = requireRole("admin"): renders the combined owner statement to a
// soft-copy PDF and persists Invoice.pdfKey; returns { pdfKey, downloadUrl }.
// GET pdf = requireRole("manager"): mints a signed download URL when pdfKey is
// present, else 404 "PDF not generated". Every query is org-scoped; cross-org /
// unknown → 404. Soft-copy only — regenerate NEVER auto-sends.

ownerBillingRoutes.post("/statements/:id/regenerate-pdf", requirePermission("owner_report.generate"), async (c) => {
  const result = await regenerateStatementPdf(actor(c), c.req.param("id"));
  // 400 = statement has no owner/period; 404 = cross-org / unknown.
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

ownerBillingRoutes.get("/statements/:id/pdf", requirePermission("owner_report.download"), async (c) => {
  const result = await getStatementPdfUrl(actor(c), c.req.param("id"));
  // 404 = cross-org / unknown / no pdfKey ("PDF not generated").
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Statement 5-section assembly (2a-5) ───────────────────────────────────
// Read = requireRole("manager"). Returns the 5-section Yannie statement data
// for use by the web statement page, PDF renderer, and portal. 404 when the
// statement is not found or has no owner/period.

ownerBillingRoutes.get("/statements/:id/sections", requirePermission("owner_report.view"), async (c) => {
  const result = await getStatementSectionsService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Bulk receipt upload + attach/detach (C6) ──────────────────────────────
// Upload + detach are BOTH requireRole("admin"). Upload is multipart/form-data:
// one or more `files` fields carry the receipt bytes (server names the object —
// the client never picks keys); an optional `chargeId` field targets a specific
// line (line-level), else the receipt attaches to the statement (statement-level).
// Detach takes the storage key in the path (URL-encoded). Every query is
// org-scoped; cross-org → 404. Statements stay SOFT-COPY (no auto-send).

ownerBillingRoutes.post("/statements/:id/receipts", requirePermission("owner_report.generate"), async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);

  // Collect every `files` (or `file`) field that is an actual File upload.
  const raw = [...form.getAll("files"), ...form.getAll("file")];
  const uploads = raw.filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0) return c.json({ error: "Missing file field" }, 400);

  const files: ReceiptFile[] = await Promise.all(
    uploads.map(async (file) => ({
      filename: file.name,
      mimeType: file.type,
      content: Buffer.from(await file.arrayBuffer()),
    })),
  );

  // Optional line-level target. A blank/absent field stays undefined (statement-level).
  const chargeIdField = form.get("chargeId");
  const chargeId = typeof chargeIdField === "string" && chargeIdField.length > 0 ? chargeIdField : undefined;

  const result = await uploadReceiptsService(actor(c), c.req.param("id"), files, chargeId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data }, result.status as 201);
});

ownerBillingRoutes.post("/statements/:id/receipts/:key/detach", requirePermission("owner_report.generate"), async (c) => {
  // The key is URL-encoded in the path (it contains slashes) — decode before use.
  const key = decodeURIComponent(c.req.param("key"));
  const result = await detachReceiptService(actor(c), c.req.param("id"), key);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Signed VIEW URLs for a statement's attached receipts — backs the ReceiptUploader
// thumbnail tiles (image preview / click-to-open). requireRole("admin") matches the
// receipts upload/detach gate above. Pure read: signs ONLY this statement's
// Invoice.attachmentKeys (never a caller-supplied key). Org-scoped; cross-org /
// unknown → 404. Returns { data: Array<{ key, url }> }.
ownerBillingRoutes.get("/statements/:id/receipts/urls", requirePermission("owner_report.view"), async (c) => {
  const result = await listReceiptUrlsService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Per-expense proof bills (apartment-scoped, B2) ────────────────────────
// Bills attach to a specific (owner, month, apartment, category) expense — NOT to
// the statement Invoice/Charge — so they survive owner-ledger re-sync and stay
// per-apartment. Attach + detach = requireRole("admin"); the signed list read =
// requireRole("manager") (admin/manager). The server mints the storage key (the
// client never picks it). Detach is NO-ORPHAN (the service deletes the bucket
// object after the row commits). Every query is org-scoped; cross-org → 404 / [].

// statementMonth is "YYYY-MM"; apartmentId optional (absent ⇒ legacy combined,
// null at the service). category is the RAW OwnerLedgerEntry.category.
const expenseProofFields = z.object({
  ownerPartyId: z.string().uuid(),
  statementMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  apartmentId: z.string().uuid().optional(),
  category: z.string().min(1).max(60),
});

ownerBillingRoutes.post("/expense-proofs", requirePermission("owner_report.generate"), async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);

  // Collect every `files` (or `file`) field that is an actual File upload.
  const raw = [...form.getAll("files"), ...form.getAll("file")];
  const uploads = raw.filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0) return c.json({ error: "Missing file field" }, 400);

  // Validate the non-file fields (all arrive as multipart strings).
  const fieldsRaw: Record<string, unknown> = {
    ownerPartyId: form.get("ownerPartyId") ?? undefined,
    statementMonth: form.get("statementMonth") ?? undefined,
    category: form.get("category") ?? undefined,
  };
  const apartmentField = form.get("apartmentId");
  if (typeof apartmentField === "string" && apartmentField.length > 0) {
    fieldsRaw.apartmentId = apartmentField;
  }
  const parsed = expenseProofFields.safeParse(fieldsRaw);
  if (!parsed.success) return zerr(c, parsed.error);

  const files: ProofFile[] = await Promise.all(
    uploads.map(async (file) => ({
      filename: file.name,
      mimeType: file.type,
      content: Buffer.from(await file.arrayBuffer()),
    })),
  );

  const result = await attachExpenseProofService(
    actor(c),
    {
      ownerPartyId: parsed.data.ownerPartyId,
      statementMonth: parsed.data.statementMonth,
      apartmentId: parsed.data.apartmentId ?? null,
      category: parsed.data.category,
    },
    files,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data }, result.status as 201);
});

const listExpenseProofsQuery = z.object({
  ownerPartyId: z.string().uuid(),
  statementMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  apartmentId: z.string().uuid().optional(),
});

ownerBillingRoutes.get("/expense-proofs", requirePermission("owner_report.view"), async (c) => {
  const parsed = listExpenseProofsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const result = await listExpenseProofUrlsService(
    actor(c),
    parsed.data.ownerPartyId,
    parsed.data.statementMonth,
    parsed.data.apartmentId ?? null,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ data: result.data });
});

ownerBillingRoutes.delete("/expense-proofs/:id", requirePermission("owner_report.generate"), async (c) => {
  const result = await detachExpenseProofService(actor(c), c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// ─── Proof pack — merged bills PDF (apartment-scoped, C1) ───────────────────
// One downloadable PDF merging every bill attached to (owner, month, apartment),
// kept SEPARATE from the clean statement. requireRole("manager") (admin/manager).
// Miss-resilient (a missing/unreadable bill is skipped) and bounded (≤50 bills /
// 100 MB). No bills for the (owner, month, apartment) → the service returns null,
// which this route maps to 404. Flag-dark → 404 via the module gate above.
const proofPackQuery = z.object({
  ownerPartyId: z.string().uuid(),
  statementMonth: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM"),
  apartmentId: z.string().uuid().optional(),
});

ownerBillingRoutes.get("/proof-pack", requirePermission("owner_report.download"), async (c) => {
  const parsed = proofPackQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const bytes = await buildProofPackPdf(
    actor(c),
    parsed.data.ownerPartyId,
    parsed.data.statementMonth,
    parsed.data.apartmentId ?? null,
  );
  if (!bytes) return c.json({ error: "No proof bills found" }, 404);
  const filename = `proof-pack-${parsed.data.statementMonth}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ─── Cleaning bills — REMOVED 2026-08-17 ───────────────────────────────────
// POST /cleaning-bills, PATCH /cleaning-bills/:id and POST /cleaning-bills/:id/void are
// grid is the single cleaning issuer (bearer in the unit Setting drawer, amount in the
// Recurring editor). The automatic twin of this path was removed 2026-07-29 for
// double-billing the same apartment-month; this is the other half. No web surface ever
// called these routes. Existing chargeType:"cleaning" Charges still render untouched.

export { ownerBillingRoutes };
