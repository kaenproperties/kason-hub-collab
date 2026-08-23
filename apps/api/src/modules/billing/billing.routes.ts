import { Hono } from "hono";
import { z } from "zod";
import {
  createChargeService,
  getChargeByIdService,
  getChargesGroupedService,
  getChargesService,
  getChargesSummaryService,
  postChargeService,
  voidChargeService,
} from "./billing.service";
import {
  chargesGroupedQuerySchema,
  chargesSummaryQuerySchema,
  createChargeSchema,
  listChargesQuerySchema,
  postChargeSchema,
  voidChargeSchema,
} from "./billing.validation";
import type { BillingSession } from "./billing.types";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";
import { getDb } from "@kason/db";
import { patchEconomicTreatmentInput, resolveDocumentClassification } from "@kason/shared";
import type { CommercialPurpose, FundedBy, RevenueRecognition, SettlementRecipient } from "@kason/shared";

const billingRoutes = new Hono<{ Variables: { session: BillingSession } }>();

// Registered BEFORE the "/charges" handler below so the static "/grouped"
// path never falls through to it (Hono matches route order).
billingRoutes.get("/charges/grouped", requirePermission("billing.view"), async (c) => {
  const session = c.get("session");
  const parsed = chargesGroupedQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await getChargesGroupedService(session, parsed.data);
  return c.json(result);
});

// Registered ABOVE "/charges" (static path first, spec §3.1) so it never
// falls through to the "/charges" handler below.
billingRoutes.get("/charges/summary", requirePermission("billing.view"), async (c) => {
  const session = c.get("session");
  const parsed = chargesSummaryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  return c.json(await getChargesSummaryService(session, parsed.data));
});

billingRoutes.get("/charges", requirePermission("billing.view"), async (c) => {
  const session = c.get("session");
  const parsed = listChargesQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  // Presence of EITHER param is the pagination switch (spec §4.8 gap); no
  // params at all reproduces the pre-existing full-list response shape
  // exactly ({ data: ChargeListItem[] }, no `total`). Everything else on the
  // parsed query is a server-side filter (spec §3.4), threaded through as-is.
  const { page, pageSize, ...filters } = parsed.data;
  const pagination =
    page !== undefined || pageSize !== undefined
      ? { page: page ?? 1, pageSize: pageSize ?? 25 }
      : undefined;

  const result = await getChargesService(session, pagination, filters);
  return c.json(result);
});

// Review fix: Charge.id is @db.Uuid, so an unguarded malformed chargeId
// reaches Postgres via findChargeById() and throws P2023 ("invalid input
// syntax for type uuid"), which has no `.status` and escapes the global
// error handler as a bare 500. Mirrors the sibling POST routes'
// postChargeSchema/voidChargeSchema convention (chargeId: z.string().uuid()).
const chargeIdParamSchema = z.object({ chargeId: z.string().uuid() });

// Registered AFTER the "/charges" list handler above (never shadows the
// static "/grouped" or "/summary" paths, spec §3.1) and admin-only per spec
// (stricter than the sibling POST admin+manager gate — the ledger-row
// trigger this backs is admin-gated).
billingRoutes.get("/charges/:chargeId", requirePermission("billing.view"), async (c) => {
  const session = c.get("session");

  const parsed = chargeIdParamSchema.safeParse({ chargeId: c.req.param("chargeId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await getChargeByIdService(session, parsed.data.chargeId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data, 200);
});

// Spec 1 (Phase 1, R26): set/correct a charge's authoritative economic classification.
// UNISSUED charges only — an issued charge (any BillingDocumentLine references it) cannot be
// reclassified in place (409); it requires the audited correction path. Also clears the
// fail-closed NEEDS_ECONOMIC_CLASSIFICATION marker so a corrected charge can re-issue.
billingRoutes.patch("/charges/:chargeId/economic-treatment", requirePermission("billing.rebill"), async (c) => {
  const session = c.get("session");
  const idParsed = chargeIdParamSchema.safeParse({ chargeId: c.req.param("chargeId") });
  if (!idParsed.success) return c.json({ error: "invalid chargeId" }, 400);
  const parsed = patchEconomicTreatmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const sel = { id: true, commercialPurpose: true, fundedBy: true, revenueRecognition: true, settlementRecipient: true, nonBillable: true, economicClassificationStatus: true } as const;
  // Atomic (issued-check + re-validate + update in one tx): a concurrent issuance cannot slip
  // a reclassification under a just-issued document, and the fail-closed marker only clears if
  // the MERGED classification actually routes (never on a still-invalid partial patch).
  const result = await getDb().$transaction(async (tx) => {
    const charge = await tx.charge.findFirst({ where: { id: idParsed.data.chargeId, organizationId: session.orgId }, select: sel });
    if (!charge) return { status: 404 as const };
    const issued = await tx.billingDocumentLine.findFirst({ where: { chargeId: charge.id }, select: { id: true } });
    if (issued) return { status: 409 as const };
    const m = { ...charge, ...parsed.data };
    const routed = resolveDocumentClassification({
      commercialPurpose: m.commercialPurpose as CommercialPurpose | null,
      fundedBy: m.fundedBy as FundedBy | null,
      revenueRecognition: m.revenueRecognition as RevenueRecognition | null,
      settlementRecipient: m.settlementRecipient as SettlementRecipient | null,
      nonBillable: m.nonBillable,
    });
    const needs = routed.kind === "NEEDS_ECONOMIC_CLASSIFICATION";
    const updated = await tx.charge.update({
      where: { id: charge.id },
      data: {
        ...parsed.data,
        economicClassificationStatus: needs ? "NEEDS_ECONOMIC_CLASSIFICATION" : null,
        economicClassificationReason: needs ? routed.reason : null,
      },
      select: sel,
    });
    return { status: 200 as const, data: updated };
  });
  if (result.status === 404) return c.json({ error: "Charge not found" }, 404);
  if (result.status === 409) return c.json({ error: "CHARGE_ALREADY_ISSUED", message: "Issued charges require the audited correction path" }, 409);
  return c.json({ data: result.data }, 200);
});

billingRoutes.post("/charges", requirePermission("billing.charge.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json();
  const parsed = createChargeSchema.safeParse(body);

  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await createChargeService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      result.error === "DUPLICATE_CHARGE"
        ? { error: result.error, existingChargeId: (result as { existingChargeId?: string }).existingChargeId }
        : { error: result.error },
      result.status as 400 | 404 | 409,
    );
  }
  return c.json(result.data, result.status as 201);
});

billingRoutes.post("/charges/:chargeId/post", requirePermission("billing.bill"), async (c) => {
  const session = c.get("session");
  const parsed = postChargeSchema.safeParse({ chargeId: c.req.param("chargeId") });

  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await postChargeService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 422);
  return c.json(result.data);
});

billingRoutes.post("/charges/:chargeId/void", requirePermission("billing.rebill"), async (c) => {
  const session = c.get("session");
  // (inline admin||manager check removed — middleware admits admin/manager via rank + accountant via workspace)
  const body = await c.req.json().catch(() => ({}));
  const parsed = voidChargeSchema.safeParse({
    chargeId: c.req.param("chargeId"),
    reason: body.reason,
    // R1/R2/R3 correction strategy (Task 11): forward the FULL correction body so
    // the schema validates it and the service can act on it. Previously only
    // paidHandling/refund survived — strategy/replacement/adjustmentAmount/
    // idempotencyKey were dropped, silently ignoring the drawer's POST for the
    // new strategies. All optional + additive: flag-dark clients never send them.
    strategy: body.strategy,
    replacement: body.replacement,
    adjustmentAmount: body.adjustmentAmount,
    idempotencyKey: body.idempotencyKey,
    // P3: three-way fork for paid charges (spec §4.3) — optional + additive.
    paidHandling: body.paidHandling,
    refund: body.refund,
  });

  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await voidChargeService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

import { autoDraftRoutes } from "./auto-draft.routes";
billingRoutes.route("/", autoDraftRoutes); // M5 paths: /draft-config, /draft-runs, /invoices — flag-gated; existing /charges untouched

export { billingRoutes };
