// Phase-2 owner remittance — POST /owner-remittances router.
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md (Task 6).
//
// Thin plumbing only: flag-gate (canonical 404 while dark, BEFORE auth —
// utility-billing-config/routes.ts:13-17 precedent) → requireWorkspaceOrRank
// → Zod parse (Task 4 remittanceCreateSchema) → recordRemittanceService →
// forward the service's own {status, error} verbatim (owner-ledger.routes.ts
// precedent: the SERVICE decides both the error code and the HTTP status per
// guard; the route never re-maps).
import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import { remittanceCreateSchema, remittanceAllocateSchema, reverseSchema } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";
import { getActorHeaders } from "../../lib/actor-ctx";
import {
  recordRemittanceService,
  allocatePreStatementService,
  reverseRemittanceService,
  getOwnerAccountService,
} from "./owner-remittance.service";
import type { RemittanceActorCtx } from "./owner-remittance.service";

const ownerRemittanceRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate FIRST: every /api/owner-remittances route 404s (canonical
// "not_found") while ENABLE_PHASE2_OWNER_REMITTANCE is dark, BEFORE any
// auth/workspace check runs (utility-billing-config/routes.ts:13-17 precedent).
ownerRemittanceRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_REMITTANCE")) return c.json({ error: "not_found" }, 404);
  await next();
});

type OwnerRemittanceCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: OwnerRemittanceCtx): RemittanceActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role,
    ip,
    userAgent,
  };
}

function zerr(c: OwnerRemittanceCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "owner-remittance" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// POST /api/owner-remittances — WRITE = accounting workspace OR rank>=manager.
ownerRemittanceRoutes.post("/", requirePermission("owner_payout.record"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = remittanceCreateSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);

  const result = await recordRemittanceService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  return c.json({ data: result.data }, result.status as 200 | 201);
});

// POST /api/owner-remittances/:id/allocate — later allocation of an existing
// PRE_STATEMENT_REMITTANCE (Task 7). Same WRITE gate as create. `:id` is the
// path param, never part of the Zod-parsed body (remittanceAllocateSchema
// covers only {allocations, idempotencyKey}).
ownerRemittanceRoutes.post("/:id/allocate", requirePermission("owner_payout.record"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = remittanceAllocateSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);

  const entryId = c.req.param("id");
  const result = await allocatePreStatementService(actor(c), entryId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 422);
  return c.json({ data: result.data }, result.status as 200);
});

// POST /api/owner-remittances/:id/reverse — append-only reversal of an
// OWNER_REMITTANCE or PRE_STATEMENT_REMITTANCE entry (Task 9). Same WRITE
// gate as create/allocate. `:id` is the path param; reverseSchema covers
// only {reason, idempotencyKey}.
ownerRemittanceRoutes.post("/:id/reverse", requirePermission("owner_payout.reverse"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = reverseSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);

  const entryId = c.req.param("id");
  const result = await reverseRemittanceService(actor(c), entryId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 200 | 201);
});

// GET /api/owner-remittances/owner/:ownerPartyId — Task 10: read-only
// owner-account view (Phase-2 settlement/reversal entries + per-period
// derived remittance status, R14). No lock, no tx (read-only — see
// getOwnerAccountService's own docstring). SAME permission gate as the
// write routes above — this module has no separate write/read role tier
// (contrast owner-ledger.routes.ts's WRITE=admin/READ=manager split, which
// doesn't apply here since every route on this router predates this one as
// a write). accountant-scope.ts carries its OWN separate GET allowlist
// entry for this exact path — the accountant default-deny wall runs BEFORE
// this middleware for every method, not just POST.
ownerRemittanceRoutes.get("/owner/:ownerPartyId", requirePermission("owner_report.view"), async (c) => {
  const result = await getOwnerAccountService(actor(c), c.req.param("ownerPartyId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  return c.json({ data: result.data });
});

export { ownerRemittanceRoutes };
