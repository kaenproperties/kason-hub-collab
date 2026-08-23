/**
 * R8 — admin reconciliation endpoints (runs + findings triage).
 *
 * MOUNT CHOICE (spec R10, documented): these endpoints MUST be reachable regardless of
 * ENABLE_PHASE2_OWNER_BILLING / ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER, because the
 * enablement preflight has to run BEFORE the live-ledger flag is turned on. The existing
 * owner-ledger router applies `ownerLedgerFlagGate` via `use("*")`, which Hono binds to
 * the path pattern `/api/owner-ledger/*` — so ANY router mounted under that prefix
 * inherits the 404-while-dark gate (confirmed by the portal `/owner-live` precedent,
 * which chose a DISTINCT prefix for exactly this reason). This router therefore mounts at
 * the DISTINCT top-level prefix `/api/owner-ledger-reconciliation` (see app.ts), which
 * cannot match `/api/owner-ledger/*`, so it carries NO flag gate — only `requireRole`.
 * The spec resource names (`reconciliation-runs`, `reconciliation-findings`) are kept
 * verbatim under that prefix for discoverability.
 *
 * All routes are `requireRole("admin")`. Money-read-only: writes only run + finding rows.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ZodError } from "zod";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import type { AdminRole } from "../../../lib/rbac";
import { requirePermission } from "../../../middleware/require-permission";
import { getActorHeaders } from "../../../lib/actor-ctx";
import { formatZodError } from "../../../lib/zod-error-mapper";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import { runReconciliation } from "./runs";
import { runEnablementPreflight } from "./preflight";

const reconciliationRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

type ReconCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: ReconCtx): OwnerLedgerActorCtx {
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

function zerr(c: ReconCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "owner-ledger" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

const monthRe = /^\d{4}-\d{2}$/;
const monthStartOf = (m: string): Date => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, 1));

// ─── POST /reconciliation-runs — trigger a run (omit filters = full scope) ────────
const runBody = z.object({
  reconciliationType: z.enum(["source_to_ledger", "frozen_integrity", "both"]).optional(),
  ownerPartyId: z.string().uuid().optional(),
  month: z.string().regex(monthRe, "month must match YYYY-MM").optional(),
});

reconciliationRoutes.post("/reconciliation-runs", requirePermission("owner_report.generate"), async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = runBody.safeParse(raw ?? {});
  if (!parsed.success) return zerr(c, parsed.error);
  const a = actor(c);
  const result = await runReconciliation(a, {
    reconciliationType: parsed.data.reconciliationType,
    ownerPartyId: parsed.data.ownerPartyId,
    month: parsed.data.month,
    triggerType: "manual",
    triggeredById: a.actorUserId,
  });
  return c.json({ data: result }, 201);
});

// ─── GET /reconciliation-runs — run history (type/status/limit) ───────────────────
const runsQuery = z.object({
  type: z.enum(["source_to_ledger", "frozen_integrity"]).optional(),
  status: z.enum(["running", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

reconciliationRoutes.get("/reconciliation-runs", requirePermission("owner_report.view"), async (c) => {
  const parsed = runsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { type, status, limit } = parsed.data;
  const rows = await getDb().ownerLedgerReconciliationRun.findMany({
    where: {
      organizationId: actor(c).orgId,
      ...(type ? { reconciliationType: type } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return c.json({ data: rows });
});

// ─── GET /reconciliation-findings — findings page (checkKind/status/severity/owner/month) ─
const findingsQuery = z.object({
  checkKind: z.enum(["source_to_ledger", "frozen_integrity"]).optional(),
  status: z.enum(["open", "acknowledged", "resolved", "ignored"]).optional(),
  severity: z.enum(["critical", "warning"]).optional(),
  ownerPartyId: z.string().uuid().optional(),
  month: z.string().regex(monthRe, "month must match YYYY-MM").optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

reconciliationRoutes.get("/reconciliation-findings", requirePermission("owner_report.view"), async (c) => {
  const parsed = findingsQuery.safeParse(c.req.query());
  if (!parsed.success) return zerr(c, parsed.error);
  const { checkKind, status, severity, ownerPartyId, month, limit } = parsed.data;
  const rows = await getDb().ownerLedgerReconciliationFinding.findMany({
    where: {
      organizationId: actor(c).orgId,
      ...(checkKind ? { checkKind } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(ownerPartyId ? { ownerPartyId } : {}),
      ...(month ? { originalBillingMonth: monthStartOf(month) } : {}),
    },
    orderBy: { lastDetectedAt: "desc" },
    take: limit,
  });
  return c.json({ data: rows });
});

// ─── POST /reconciliation-findings/:id/acknowledge — admin triage ─────────────────
// Org-scoped lookup first (tenant isolation) → 404 if not this org's finding.
reconciliationRoutes.post("/reconciliation-findings/:id/acknowledge", requirePermission("owner_report.reopen"), async (c) => {
  const id = c.req.param("id");
  const a = actor(c);
  const existing = await getDb().ownerLedgerReconciliationFinding.findFirst({
    where: { id, organizationId: a.orgId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);
  const updated = await getDb().ownerLedgerReconciliationFinding.update({
    where: { id },
    data: { status: "acknowledged" },
  });
  return c.json({ data: updated });
});

// ─── POST /reconciliation-findings/:id/ignore — reason REQUIRED (no resolve-without-repair) ─
const ignoreBody = z.object({ reason: z.string().trim().min(1, "reason is required") });

reconciliationRoutes.post("/reconciliation-findings/:id/ignore", requirePermission("owner_report.reopen"), async (c) => {
  // Validate the reason BEFORE the resource lookup: an ignore without a reason is a 400
  // regardless of whether the finding exists (spec: ignore requires a reason).
  const raw = await c.req.json().catch(() => ({}));
  const parsed = ignoreBody.safeParse(raw ?? {});
  if (!parsed.success) return zerr(c, parsed.error);
  const id = c.req.param("id");
  const a = actor(c);
  const existing = await getDb().ownerLedgerReconciliationFinding.findFirst({
    where: { id, organizationId: a.orgId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: "not_found" }, 404);
  const updated = await getDb().ownerLedgerReconciliationFinding.update({
    where: { id },
    data: { status: "ignored", reason: parsed.data.reason },
  });
  return c.json({ data: updated });
});

// ─── GET /enablement-preflight — R9/R10 executable enablement gate (admin-only) ────
// READ-ONLY and flag-INDEPENDENT (inherits this router's distinct-prefix escape from
// ownerLedgerFlagGate): it MUST be answerable BEFORE ENABLE_PHASE2_OWNER_STATEMENT_LIVE_
// LEDGER is turned on, since it is what decides whether turning it on is safe.
reconciliationRoutes.get("/enablement-preflight", requirePermission("owner_report.view"), async (c) => {
  const result = await runEnablementPreflight({ orgId: actor(c).orgId });
  return c.json({ data: result });
});

export { reconciliationRoutes };
