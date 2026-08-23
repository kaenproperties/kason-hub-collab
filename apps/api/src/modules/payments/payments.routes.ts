import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { PaymentsSession } from "./payments.types";
import {
  allocatePaymentSchema,
  allocatePaymentBatchSchema,
  createPaymentSchema,
  updatePaymentStatusSchema,
  postPaymentSchema,
  rejectPaymentSchema,
  resolveReconciliationSchema,
  reverseAllocationSchema,
  listPaymentsQuerySchema,
  paymentsSummaryQuerySchema,
  recordAndAllocatePaymentSchema,
  recordInvoicePaymentSchema,
} from "./payments.validation";
import {
  allocatePaymentService,
  allocatePaymentBatchService,
  createPaymentService,
  getPaymentsService,
  getPaymentsSummaryService,
  updatePaymentStatusService,
  postPaymentService,
  rejectPaymentService,
  reverseAllocationService,
  listInFlightFpxService,
  cancelInFlightFpxService,
  listNeedsReconciliationService,
  resolveNeedsReconciliationService,
  recordAndAllocatePaymentService,
  recordInvoicePaymentService,
} from "./payments.service";
import { findPaymentGatewayStatus } from "./payments.repository";
import { formatZodError } from "../../lib/zod-error-mapper";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { requirePermission } from "../../middleware/require-permission";
import { getPaymentProofUrlsService } from "./payments.proof-urls";

const paymentsRoutes = new Hono<{ Variables: { session: PaymentsSession } }>();

// In-flight-FPX guard for the by-id admin mutation endpoints (post / allocate /
// allocate-batch / status). A tenant FPX payment is created pending_approval +
// gatewayStatus "pending" and settles ONLY via the signed gateway callback, which
// calls postPaymentService DIRECTLY (bypassing these HTTP routes). Letting an admin
// manually action it here would settle charges before the bank confirms, and a
// later FAILED callback would be swallowed by the idempotency fast-path → phantom
// collection. So a gatewayStatus "pending" payment is rejected with 409. A null
// gatewayStatus (manual cash/bank-transfer) or a settled one ("success"/"failed")
// proceeds normally.
//
// CRITICAL: this guard lives ONLY in the HTTP layer — never inside
// postPaymentService / allocate* / updatePaymentStatusService — because the FPX
// callback settles THROUGH those services while gatewayStatus is still "pending".
const IN_FLIGHT_FPX_ERROR =
  "This payment is an in-flight FPX transaction; it settles automatically via the gateway and cannot be actioned manually.";

async function isInFlightFpx(orgId: string, paymentId: string): Promise<boolean> {
  const row = await findPaymentGatewayStatus(orgId, paymentId);
  return row?.gatewayStatus === "pending";
}

// Registered ABOVE "/" (static path first) so it never falls through to the
// unfiltered list handler below.
paymentsRoutes.get("/summary", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const parsed = paymentsSummaryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  return c.json(await getPaymentsSummaryService(session, parsed.data));
});

paymentsRoutes.get("/", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const parsed = listPaymentsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getPaymentsService(session, parsed.data);
  return c.json(result);
});

paymentsRoutes.post("/", requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const parsed = createPaymentSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createPaymentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 409);
  return c.json(result.data, result.status as 201);
});

paymentsRoutes.post("/:paymentId/allocate", requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json();
  const parsed = allocatePaymentSchema.safeParse({ ...body, paymentId: c.req.param("paymentId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await allocatePaymentService(session, parsed.data);
  // B7: allocatePaymentService now rides the guarded rail, which can also
  // reject with 409 (StaleError — a concurrent charge update raced this one).
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data, result.status as 201);
});

paymentsRoutes.put("/:paymentId/status", requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  // (inline viewer check removed — middleware admits admin/manager via rank + accountant via workspace; editor/viewer denied per the matrix)
  const body = await c.req.json();
  const parsed = updatePaymentStatusSchema.safeParse({ ...body, paymentId: c.req.param("paymentId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await updatePaymentStatusService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json(result.data);
});

// ── Phase-2 flag-gated routes ─────────────────────────────────────────────────
// The /api/payments module is NOT globally flag-gated; gate per new route only.

const multiPayGate: MiddlewareHandler = async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY")) return c.json({ error: "not_found" }, 404);
  await next();
};

// Static 1-segment path — registered before the "/:paymentId/..." 2-segment
// routes below so there is never a route-matching conflict (Hono matches by
// segment count/shape; "/record-and-allocate" never collides with
// "/:paymentId/allocate-batch" etc).
paymentsRoutes.post("/record-and-allocate", multiPayGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = recordAndAllocatePaymentSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await recordAndAllocatePaymentService(session, parsed.data);
  if (!result.ok) {
    // Spec2 R9: forward existingPaymentId ONLY for the duplicate-payment
    // guard — mirrors billing.routes.ts's existingChargeId forwarding for
    // DUPLICATE_CHARGE. Never leak the id for any other error.
    return c.json(
      result.error === "DUPLICATE_PAYMENT"
        ? { error: result.error, existingPaymentId: (result as { existingPaymentId?: string }).existingPaymentId }
        : { error: result.error },
      result.status as 400 | 409,
    );
  }
  return c.json(result.data, result.status as 200 | 201);
});

// Invoice-scoped "Record payment" (manual bank transfer). Payer + method are
// derived server-side from the document; the transfer slip is mandatory (schema).
// Static 1-segment path — no collision with the "/:paymentId/..." routes below.
paymentsRoutes.post("/record-invoice-payment", multiPayGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = recordInvoicePaymentSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await recordInvoicePaymentService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      result.error === "DUPLICATE_PAYMENT"
        ? { error: result.error, existingPaymentId: (result as { existingPaymentId?: string }).existingPaymentId }
        : { error: result.error },
      result.status as 400 | 404 | 409,
    );
  }
  return c.json(result.data, result.status as 200 | 201);
});

// P3: signed slip-proof URLs for a payment's attachmentKeys (R10). 2-segment
// static path — a distinct terminal segment ("proof-urls") never collides
// with /allocate-batch, /post, /status. multiPayGate keeps it dark until the
// flag is on, matching the record-and-allocate surface it serves.
paymentsRoutes.get("/:paymentId/proof-urls", multiPayGate, requirePermission("billing.document_manage"), async (c) => {
  const session = c.get("session");
  const result = await getPaymentProofUrlsService(session.orgId, c.req.param("paymentId"));
  if (!result.ok) return c.json({ error: result.status === 404 ? "Payment not found" : "Failed to sign proof URLs" }, result.status);
  return c.json({ urls: result.urls });
});

paymentsRoutes.post("/:paymentId/allocate-batch", multiPayGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = allocatePaymentBatchSchema.safeParse({ ...body, paymentId: c.req.param("paymentId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await allocatePaymentBatchService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data, result.status as 200 | 201);
});

paymentsRoutes.post("/:paymentId/allocations/:allocationId/reverse", multiPayGate, requirePermission("billing.rebill"), async (c) => {
  const session = c.get("session");
  // Parse the body too (reason/idempotencyKey/amount) — an empty body still
  // parses via the schema's server default on `reason`.
  const body = await c.req.json().catch(() => ({}));
  const parsed = reverseAllocationSchema.safeParse({
    ...body,
    paymentId: c.req.param("paymentId"),
    allocationId: c.req.param("allocationId"),
  });
  if (!parsed.success) return c.json({ error: "Invalid input" }, 400);
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await reverseAllocationService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

// requireWorkspaceOrRank, not requireRole: verifying a tenant's transfer slip
// against the bank account IS the accountant's job, and `accountant` is
// deliberately absent from the RANK ladder (rbac.ts), so requireRole("manager")
// 403s it outright — leaving an accountant able to open the verification panel
// and read the slip but not act on it.
//
// The delta is exactly one role. `accounting` = {admin, manager, accountant};
// the "manager" floor adds only admin/manager, who already held this. Editor
// (rank 1) holds `operations`, not `accounting`, and sits below the floor — so
// it stays denied on both routes, as do operator/viewer.
paymentsRoutes.post("/:paymentId/post", multiPayGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const parsed = postPaymentSchema.safeParse({ paymentId: c.req.param("paymentId") });
  if (!parsed.success) return c.json({ error: "Invalid id" }, 400);
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await postPaymentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

// The "no" to /post's "yes": an admin read the tenant's transfer slip and
// refused it. Deliberately the SAME gate as /post — accepting and refusing a
// claim on money are the same authority, and a reviewer who can approve but not
// reject is pushed toward approving. Same in-flight-FPX guard too, so a live
// gateway attempt is never resolved by hand from underneath the callback.
paymentsRoutes.post("/:paymentId/reject", multiPayGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = rejectPaymentSchema.safeParse({ ...body, paymentId: c.req.param("paymentId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  if (await isInFlightFpx(session.orgId, parsed.data.paymentId)) return c.json({ error: IN_FLIGHT_FPX_ERROR }, 409);
  const result = await rejectPaymentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

// ── In-flight FPX ops (admin) — ENABLE_PHASE2_FPX-gated ─────────────────────
// The default admin listing hides gatewayStatus "pending" FPX rows; these give an
// admin a dedicated VIEW of genuinely stuck attempts plus a manual CANCEL (→
// "expired"; charges untouched). The lazy-expiry on re-initiate only clears rows
// for tenants who come back — these clear the ones who never do.
const fpxOpsGate: MiddlewareHandler = async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.json({ error: "not_found" }, 404);
  await next();
};

paymentsRoutes.get("/fpx/in-flight", fpxOpsGate, requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const result = await listInFlightFpxService(session);
  return c.json(result);
});

// The `needs_reconciliation` queue: payments the gateway CONFIRMED that we could
// not apply automatically, because a human had already cancelled them or the
// gateway had already failed them. Every row is money the payer's bank has most
// likely taken and our books do not yet show, so this is a liability list, not a
// report — and the FPX merchant agreement gives the payer 60 days to demand it
// back. Manager rank to read, admin to resolve, mirroring post/reject.
paymentsRoutes.get("/fpx/needs-reconciliation", fpxOpsGate, requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const result = await listNeedsReconciliationService(session);
  return c.json(result);
});

paymentsRoutes.post("/fpx/:paymentId/resolve", fpxOpsGate, requirePermission("billing.mark_paid"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = resolveReconciliationSchema.safeParse({ ...body, paymentId: c.req.param("paymentId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await resolveNeedsReconciliationService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

paymentsRoutes.post("/fpx/:paymentId/cancel", fpxOpsGate, requirePermission("billing.rebill"), async (c) => {
  const session = c.get("session");
  const parsed = postPaymentSchema.safeParse({ paymentId: c.req.param("paymentId") });
  if (!parsed.success) return c.json({ error: "Invalid id" }, 400);
  const result = await cancelInFlightFpxService(session, parsed.data.paymentId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

export { paymentsRoutes };
