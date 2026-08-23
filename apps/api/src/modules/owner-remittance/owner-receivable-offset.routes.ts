// Phase-2 owner remittance — POST /owner-receivable-offsets router.
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md (Task 8).
//
// A DELIBERATELY separate router + base path from owner-remittance.routes.ts
// (mounted at /api/owner-remittances) — an offset is a distinct settlement
// mechanism (non-cash, IVOWN-line-scoped) from a remittance, and the two
// endpoints' ACCOUNTING_ALLOW entries do not overlap (accountant-scope.ts).
//
// Thin plumbing only, mirroring owner-remittance.routes.ts EXACTLY: flag-gate
// (canonical 404 while dark, BEFORE auth — utility-billing-config/routes.ts:13-17
// precedent) → requireWorkspaceOrRank → Zod parse (Task 4 offsetCreateSchema) →
// recordOffsetService → forward the service's own {status, error} verbatim
// (owner-ledger.routes.ts precedent: the SERVICE decides both the error code
// and the HTTP status per guard; the route never re-maps).
import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodError } from "zod";
import { offsetCreateSchema, reverseSchema } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";
import { getActorHeaders } from "../../lib/actor-ctx";
import { recordOffsetService, reverseOffsetService } from "./owner-remittance.service";
import type { RemittanceActorCtx } from "./owner-remittance.service";

const ownerReceivableOffsetRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate FIRST: every /api/owner-receivable-offsets route 404s (canonical
// "not_found") while ENABLE_PHASE2_OWNER_REMITTANCE is dark, BEFORE any
// auth/workspace check runs — SAME flag as /api/owner-remittances (an offset
// is part of the same Phase-2 owner-remittance feature set, not a separate
// flag).
ownerReceivableOffsetRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_REMITTANCE")) return c.json({ error: "not_found" }, 404);
  await next();
});

type OffsetCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: OffsetCtx): RemittanceActorCtx {
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

function zerr(c: OffsetCtx, err: ZodError) {
  const friendly = formatZodError(err, { domain: "owner-remittance" });
  return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
}

// POST /api/owner-receivable-offsets — WRITE = accounting workspace OR rank>=manager.
ownerReceivableOffsetRoutes.post("/", requirePermission("owner_payout.record"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = offsetCreateSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);

  const result = await recordOffsetService(actor(c), parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409 | 422);
  return c.json({ data: result.data }, result.status as 200 | 201);
});

// POST /api/owner-receivable-offsets/:id/reverse — append-only reversal of
// an OWNER_RECEIVABLE_OFFSET entry (Task 9): restores owner payable AND the
// settled charges' outstanding, atomically, no cash refund. Same WRITE gate
// as create. `:id` is the path param; reverseSchema covers only
// {reason, idempotencyKey}.
ownerReceivableOffsetRoutes.post("/:id/reverse", requirePermission("owner_payout.reverse"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = reverseSchema.safeParse(body);
  if (!parsed.success) return zerr(c, parsed.error);

  const entryId = c.req.param("id");
  const result = await reverseOffsetService(actor(c), entryId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, result.status as 200 | 201);
});

export { ownerReceivableOffsetRoutes };
