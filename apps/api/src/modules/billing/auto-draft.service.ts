import { getDb, Prisma } from "@kason/db";
import {
  addMonthsToYm,
  findMissingBillingPeriods,
  resolveBillingPeriod,
  ymOfUtc,
  DEFAULT_BILLING_GAP_LOOKBACK_MONTHS,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { withStaleCheck } from "../../lib/optimistic-update";
import type { AutoDraftActorCtx, DraftConfigRow, DraftRunRow, DraftInvoiceRow, DraftInvoiceDetail, ServiceResult, RunSummary } from "./auto-draft.types";
import {
  firstOfMonthUtc, compactMonth, tenantInvoiceNumber, rentChargeNumber, getDraftConfig,
  listTenanciesForPeriod, findExistingDraft,
  createInvoiceTx, createRentChargeTx, attachChargeTx, detachChargeTx, recomputeInvoiceTotalTx,
  listDistinctActiveOwners, listDraftRuns, getDraftRun, listDraftInvoices, getDraftInvoiceWithCharges, toNumber,
  listCompletedDraftPeriodsSince,
} from "./auto-draft.repository";
import { resolveMonthlyRentAmount } from "./post-monthly-rent";
import { carparkChargeNumber } from "./post-monthly-carpark";
import { reprorateRentDraftsForPeriod } from "./reprorate-rent-drafts";
import { generateStatementService } from "../owner-billing/owner-billing.service";
import { issueDocumentsForChargesTx } from "../billing-documents/issue.service";
import { creditPostedChargeTx } from "../billing-documents/credit-notes.service";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";

type AgreementFeeInvoiceCharge = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  status: string;
  parentChargeId: string | null;
  sstRate: { toString(): string } | null;
};

const isAgreementFeeType = (chargeType: string) =>
  chargeType === "tenancy_agreement_fee" || chargeType === "renewal_fee";

const isAgreementTaxChild = (charge: Pick<AgreementFeeInvoiceCharge, "chargeType" | "chargeNumber" | "parentChargeId">) =>
  isAgreementFeeType(charge.chargeType)
  && charge.parentChargeId !== null
  && charge.chargeNumber.endsWith("-SST");

class AgreementFeePairInvariantError extends Error {
  readonly code = "TA_TAX_PAIR_INVARIANT";
}

/**
 * Identify the strong TA/renewal inclusive-SST pairs already attached to one
 * invoice. Explicit zero-rate single rows are migration-stamped legacy gross
 * charges and remain supported; null/non-zero rows must have one exact sibling.
 */
function agreementFeePairIds(charges: AgreementFeeInvoiceCharge[]): Set<string> {
  const pairedIds = new Set<string>();
  for (const parent of charges) {
    if (!isAgreementFeeType(parent.chargeType) || isAgreementTaxChild(parent)) continue;
    const children = charges.filter((candidate) =>
      candidate.parentChargeId === parent.id
      && candidate.chargeNumber === `${parent.chargeNumber}-SST`
      && candidate.chargeType === parent.chargeType,
    );
    const rate = parent.sstRate === null ? Number.NaN : Number(parent.sstRate.toString());
    if (children.length === 0 && rate === 0) continue;
    if (children.length !== 1 || rate !== 8 || Number(children[0]!.sstRate?.toString() ?? "NaN") !== 0) {
      throw new AgreementFeePairInvariantError(`TA_TAX_PAIR_INVARIANT: ${parent.chargeNumber}`);
    }
    pairedIds.add(parent.id);
    pairedIds.add(children[0]!.id);
  }
  for (const charge of charges) {
    if (isAgreementTaxChild(charge) && !pairedIds.has(charge.id)) {
      throw new AgreementFeePairInvariantError(`TA_TAX_PAIR_INVARIANT: ${charge.chargeNumber}`);
    }
  }
  return pairedIds;
}

async function isAgreementFeePairMemberTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  charge: AgreementFeeInvoiceCharge,
): Promise<boolean> {
  if (!isAgreementFeeType(charge.chargeType)) return false;
  if (isAgreementTaxChild(charge)) return true;
  const rate = charge.sstRate === null ? Number.NaN : Number(charge.sstRate.toString());
  if (rate !== 0) return true;
  const child = await tx.charge.findFirst({
    where: {
      organizationId,
      parentChargeId: charge.id,
      chargeNumber: `${charge.chargeNumber}-SST`,
      chargeType: charge.chargeType,
    },
    select: { id: true },
  });
  return child !== null;
}

/**
 * Post an approved auto-draft invoice's charges. Approving a draft rent invoice must
 * turn its charges into LIVE receivables — otherwise the invoice reads "approved" while
 * its rent Charge stays `draft` forever (invisible as a real receivable; shown as
 * "Draft" with an outstanding balance on the tenant statement, never billed).
 *
 * Per charge: draft → posted (guarded updateMany, so it is idempotent and a no-op on a
 * charge already posted by another flow), a `charge_posted` event, and — when
 * ENABLE_PHASE2_BILLING_DOCS is on — the per-charge BillingDocument via the SAME issuer
 * the meter "Post charges" flow uses (issueDocumentsForChargesTx is flag-gated + replay
 * safe), so the now-live rent surfaces in Accounting. Runs INSIDE the approval tx: a
 * failure rolls the whole approval back (invoice stays draft), never half-approved.
 */
async function postApprovedInvoiceChargesTx(
  tx: Prisma.TransactionClient,
  ctx: AutoDraftActorCtx,
  invoiceId: string,
): Promise<string[]> {
  // Mint-on-post: only post when documents will be minted. Flag OFF ⇒ approval stays
  // review-only (charges remain draft — the pre-existing behaviour), so a posted charge
  // never exists without its document in either flag state.
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return [];
  const charges = await tx.charge.findMany({
    where: { organizationId: ctx.orgId, invoiceId, status: { not: "void" } },
    select: {
      id: true,
      chargeNumber: true,
      chargeType: true,
      status: true,
      parentChargeId: true,
      sstRate: true,
    },
  });
  const pairedIds = agreementFeePairIds(charges);
  for (const chargeId of pairedIds) {
    const member = charges.find((charge) => charge.id === chargeId)!;
    const partner = charges.find((charge) => charge.id !== chargeId && pairedIds.has(charge.id)
      && (charge.parentChargeId === member.id || member.parentChargeId === charge.id));
    if (!partner || (member.status === "draft") !== (partner.status === "draft")) {
      throw new AgreementFeePairInvariantError(`TA_TAX_PAIR_MIXED_STATUS: ${member.chargeNumber}`);
    }
  }
  const draftIds = charges.filter((c) => c.status === "draft").map((c) => c.id);
  if (draftIds.length === 0) return [];

  const updated = await tx.charge.updateMany({
    where: { id: { in: draftIds }, organizationId: ctx.orgId, status: "draft" },
    data: { status: "posted", postedAt: new Date() },
  });
  if (updated.count !== draftIds.length) {
    throw new AgreementFeePairInvariantError("TA_TAX_PAIR_POST_CONFLICT");
  }
  for (const chargeId of draftIds) {
    await tx.chargeEvent.create({
      data: {
        organizationId: ctx.orgId, chargeId, eventType: "charge_posted", eventAt: new Date(),
        actorUserId: ctx.actorUserId,
        payloadJson: { previousStatus: "draft", nextStatus: "posted", source: "auto-draft.approve", invoiceId },
      },
    });
  }
  await issueDocumentsForChargesTx(tx, draftIds, ctx.actorUserId);
  return draftIds;
}

/**
 * Draft owner statements for all active landlords by reusing M6's
 * generateStatementService. M5 toggle granularity: the run calls M6 when EITHER
 * includeMgmtFee OR includeCleaning is on — finer per-line control lives in each
 * owner's M6 ManagementFeeConfig, not here. When both toggles are off the owner
 * step is skipped entirely (no M6 call, no listDistinctActiveOwners query).
 */
async function draftOwnerStatements(
  ctx: AutoDraftActorCtx & { triggeredBy: string },
  config: { includeMgmtFee: boolean; includeCleaning: boolean },
  periodMonth: string,
): Promise<{ created: number; skipped: number; errors: string[] }> {
  if (!config.includeMgmtFee && !config.includeCleaning) {
    return { created: 0, skipped: 0, errors: [] };
  }

  let created = 0, skipped = 0;
  const errors: string[] = [];
  const owners = await listDistinctActiveOwners(ctx.orgId);

  for (const ownerPartyId of owners) {
    try {
      const res = await generateStatementService(
        { orgId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole, ip: ctx.ip, userAgent: ctx.userAgent },
        { ownerPartyId, billingMonth: periodMonth },
      );
      if (res.ok && res.status === 201) created += 1;
      else if (res.ok && res.status === 200) skipped += 1;
      else if (!res.ok) errors.push(`owner ${ownerPartyId}: ${res.error}`);
    } catch (err) {
      errors.push(`owner ${ownerPartyId}: ${(err as Error).message}`);
    }
  }

  return { created, skipped, errors };
}

/**
 * The tenancy row shape the per-tenancy draft step needs — exactly what
 * listTenanciesForPeriod selects (its extra monthlyRentAmount rides along
 * unused; resolveMonthlyRentAmount re-reads the amount inside the tx).
 */
export type DraftableTenancy = {
  id: string;
  unitId: string;
  tenantPartyId: string;
  propertyId: string;
  startDate: Date;
  endDate: Date | null;
  firstMonthIsCommission: boolean;
};

/**
 * Draft ONE tenancy's rent invoice for ONE period — the per-tenancy unit of the
 * auto-draft run, extracted so the tenancy-creation catch-up hook
 * (draft-catchup.hook.ts) can bring a late-created tenancy level with the cohort
 * a run already drafted, through the SAME idempotency keys
 * (`draft:{tenancyId}:{period}` invoice key + `RENT-{YYYYMM}-{tenancyId}` charge
 * number), so run and hook can never double-draft each other.
 *
 * Returns "skipped" when the draft already exists (any status — a voided draft
 * deliberately stays retired) or the tenancy has no billable days in the period
 * (the prorated amount resolves to 0). Throws on real failures — including a
 * P2002 from a concurrent identical create — for the caller to classify,
 * exactly like the inline code this was extracted from.
 */
export async function draftRentInvoiceForTenancy(
  ctx: AutoDraftActorCtx & { triggeredBy: string },
  t: DraftableTenancy,
  periodMonth: string,
  dueDayOffset: number | null,
): Promise<"created" | "skipped"> {
  const db = getDb();
  const firstOfMonth = firstOfMonthUtc(periodMonth);
  // `dueDayOffset` is configured and labelled as days after the invoice/run
  // date.  It used to be added to the first day of the *billing period*, which
  // silently turned an offset of 0 into the first of every month (and made an
  // advance-billed September invoice raised in August carry the wrong date).
  // Pin the issue timestamp once so invoiceDate and dueDate use the same clock.
  const invoiceDate = new Date();
  const dueDate = dueDayOffset == null
    ? null
    : new Date(invoiceDate.getTime() + dueDayOffset * 86400000);
  const idemKey = `draft:${t.id}:${periodMonth}`;
  return db.$transaction(async (tx) => {
    const existing = await findExistingDraft(tx, ctx.orgId, idemKey);
    if (existing) {
      return "skipped" as const;
    }
    // "Is this month's rent already billed?" — the second half of that question.
    // The idempotency key above only sees a draft THIS path created. The meter
    // "Post charges" flow (postMonthlyRentForTenancy) mints the very same
    // `RENT-{YYYYMM}-{tenancyId}` as a POSTED charge with NO Invoice row, so a
    // month already billed that way is invisible to the key. Without this check
    // the create below hits `Charge @@unique(organizationId, chargeNumber)`,
    // which aborts the whole interactive transaction — the money stayed right
    // (nothing double-bills) but every caller had to classify a P2002 to learn
    // "already billed". Check-first turns it into the ordinary skip the run
    // reports and the queue counts.
    const alreadyBilled = await tx.charge.findFirst({
      where: { organizationId: ctx.orgId, chargeNumber: rentChargeNumber(periodMonth, t.id) },
      select: { id: true },
    });
    if (alreadyBilled) {
      return "skipped" as const;
    }
    // R9 parity with postMonthlyRentForTenancy (post-monthly-rent.ts): a month
    // entirely outside [startDate, endDate] prorates to 0 — there is nothing to
    // bill. Resolve the amount BEFORE minting anything, so a tenancy that did not
    // occupy this period produces neither an RM0.00 rent charge nor the empty
    // tenant_rental invoice that would carry it. Without this the cron drafted a
    // zero-value invoice for a replacement tenancy that starts next month.
    const amount = await resolveMonthlyRentAmount(tx, ctx.orgId, t.id, firstOfMonth);
    if (Number(amount) === 0) {
      return "skipped" as const;
    }
    const inv = await createInvoiceTx(tx, {
      orgId: ctx.orgId, invoiceNumber: tenantInvoiceNumber(periodMonth, t.id), partyId: t.tenantPartyId,
      tenancyId: t.id, propertyId: t.propertyId, invoiceType: "tenant_rental",
      invoiceDate, dueDate, periodMonth: firstOfMonth, idempotencyKey: idemKey,
    });
    const rent = await createRentChargeTx(tx, {
      orgId: ctx.orgId, chargeNumber: rentChargeNumber(periodMonth, t.id), tenancyId: t.id, unitId: t.unitId,
      partyId: t.tenantPartyId, amount, dueDate: dueDate ?? firstOfMonth, billingMonth: firstOfMonth, invoiceId: inv.id,
      // Tenant always owes RENT. If the owner agreed that first-month rent is
      // KAEN's commission, that is represented separately on the OWNER statement.
      chargeType: "rent",
    });
    await tx.chargeEvent.create({ data: { organizationId: ctx.orgId, chargeId: rent.id, eventType: "draft.created", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId: inv.id, source: "auto-draft" } } });
    // Carpark draft charges — one per active CarparkAssignment (Task 4.2 parity).
    // Charges are attached to the same invoice so recomputeInvoiceTotalTx below
    // picks them up. Idempotent (check-first on CARPARK-{YYYYMM}-{carparkId});
    // outer idemKey covers replay at the invoice level, inner chargeNumber covers
    // per-bay uniqueness.
    const cm = compactMonth(periodMonth);
    const carparkAssignments = await tx.carparkAssignment.findMany({
      where: { organizationId: ctx.orgId, tenancyId: t.id, status: "active" },
      select: { carparkId: true, monthlyCharge: true },
    });
    for (const ca of carparkAssignments) {
      const cpChargeNumber = carparkChargeNumber(cm, ca.carparkId);
      const cpExisting = await tx.charge.findFirst({ where: { organizationId: ctx.orgId, chargeNumber: cpChargeNumber }, select: { id: true } });
      if (!cpExisting) {
        const cpAmount = ca.monthlyCharge.toFixed(2);
        const cpCharge = await tx.charge.create({
          data: {
            organizationId: ctx.orgId, chargeNumber: cpChargeNumber, tenancyId: t.id,
            unitId: null, carparkId: ca.carparkId, partyId: t.tenantPartyId,
            chargeType: "carpark", status: "draft", description: "Carpark rent",
            dueDate: dueDate ?? firstOfMonth, amount: cpAmount, currency: "MYR",
            outstandingAmount: cpAmount, billingMonth: firstOfMonth, attachmentKeys: [],
            invoiceId: inv.id,
          },
          select: { id: true },
        });
        await tx.chargeEvent.create({ data: { organizationId: ctx.orgId, chargeId: cpCharge.id, eventType: "draft.created", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId: inv.id, source: "auto-draft.carpark" } } });
      }
    }
    await recomputeInvoiceTotalTx(tx, ctx.orgId, inv.id);
    await recordAudit(tx, { organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.draft_created", entityType: "Invoice", entityId: inv.id,
      meta: { tenancyId: t.id, periodMonth, triggeredBy: ctx.triggeredBy } });
    return "created" as const;
  });
}

export async function runAutoDraftInvoices(
  ctx: AutoDraftActorCtx & { triggeredBy: string },
  periodMonth: string,
): Promise<RunSummary> {
  const db = getDb();
  const firstOfMonth = firstOfMonthUtc(periodMonth);
  const config = await getDraftConfig(ctx.orgId);

  if (!config || !config.isActive) {
    // Run-ledger create + audit in their OWN tx (separate from any per-tenancy work).
    const run = await db.$transaction(async (tx) => {
      const r = await tx.invoiceDraftRun.create({ data: {
        organizationId: ctx.orgId, periodMonth: firstOfMonth, runDate: new Date(), status: "completed",
        draftsCreated: 0, draftsSkipped: 0, errorText: "no active DraftConfig", triggeredBy: ctx.triggeredBy } });
      await recordAudit(tx, {
        organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
        action: "billing.draftrun.completed", entityType: "InvoiceDraftRun", entityId: r.id,
        meta: { periodMonth, triggeredBy: ctx.triggeredBy, note: "no active config" } });
      return r;
    });
    return { runId: run.id, status: "completed", draftsCreated: 0, draftsSkipped: 0, errorText: run.errorText };
  }

  // Run-ledger create + audit in their OWN tx — MUST stay OUTSIDE the per-tenancy
  // draft transactions below so the run row (the failure ledger) persists even when
  // per-tenancy draft work fails.
  const run = await db.$transaction(async (tx) => {
    const r = await tx.invoiceDraftRun.create({ data: {
      organizationId: ctx.orgId, periodMonth: firstOfMonth, runDate: new Date(), status: "running", triggeredBy: ctx.triggeredBy } });
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.draftrun.started", entityType: "InvoiceDraftRun", entityId: r.id,
      meta: { periodMonth, triggeredBy: ctx.triggeredBy } });
    return r;
  });

  let created = 0, skipped = 0;
  const errors: string[] = [];

  // ── Tenant rental drafts ───────────────────────────────────────────────
  // Drafts the monthly rent invoice — one tenant_rental Invoice + rent Charge per
  // active tenancy. Tenant utility/aircond charges are NO LONGER folded here: under
  // the one-action "Post charges" flow they are created as standalone POSTED charges,
  // so the auto-draft must not also bundle them onto the rent invoice. The deprecated
  // DraftConfig.includeElectricity column no longer drives any folding.
  if (config.includeRent) {
    const tenancies = await listTenanciesForPeriod(ctx.orgId, firstOfMonth);
    for (const t of tenancies) {
      try {
        const outcome = await draftRentInvoiceForTenancy(ctx, t, periodMonth, config.dueDayOffset);
        if (outcome === "created") created += 1;
        else skipped += 1;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") { skipped += 1; continue; }
        errors.push(`tenancy ${t.id}: ${(err as Error).message}`);
      }
    }

    // ── Re-prorate what this period ALREADY had ──────────────────────────────
    // The run bills by period OVERLAP, so a handover month legitimately selects
    // BOTH tenancies. The incoming one is drafted correctly above; the outgoing
    // one is skipped because its draft already exists — and that draft was
    // priced before the move-out date was known. Without this the run is a
    // second route to the same over-drafted unit-month, reachable by clicking
    // Generate after a handover.
    //
    // Scoped by PERIOD, not by the units this run just billed: a tenancy whose
    // endDate has since moved BEFORE the period start is not in `tenancies` at
    // all, so a unit-derived sweep would miss its stale draft entirely.
    // Best-effort — a correction failure must never fail a run that just drafted
    // real invoices, and it is REPORTED in errorText, not silently dropped.
    try {
      await reprorateRentDraftsForPeriod(ctx, periodMonth);
    } catch (err) {
      errors.push(`reprorate ${periodMonth}: ${(err as Error).message}`);
    }
  }

  // ── Owner statements (reuse M6) ────────────────────────────────────────  [Task 5 fills this]
  const ownerResult = await draftOwnerStatements(ctx, config, periodMonth);
  created += ownerResult.created; skipped += ownerResult.skipped; errors.push(...ownerResult.errors);

  const status = errors.length && created === 0 && skipped === 0 ? "failed" : "completed";
  const errorText = errors.length ? errors.join("; ").slice(0, 2000) : null;
  // Run-ledger final update + audit in their OWN tx — again OUTSIDE the per-tenancy
  // draft transactions, so the ledger always records the run's terminal state.
  await db.$transaction(async (tx) => {
    await tx.invoiceDraftRun.update({ where: { id: run.id }, data: {
      status, draftsCreated: created, draftsSkipped: skipped, errorText } });
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: status === "failed" ? "billing.draftrun.failed" : "billing.draftrun.completed",
      entityType: "InvoiceDraftRun", entityId: run.id,
      meta: { draftsCreated: created, draftsSkipped: skipped, errorText } });
  });
  return { runId: run.id, status, draftsCreated: created, draftsSkipped: skipped, errorText };
}

// ── Manual trigger (HTTP POST /draft-runs → same logic as cron) ──────────────

export async function triggerRunService(
  ctx: AutoDraftActorCtx,
  periodMonth: string,
): Promise<ServiceResult<RunSummary>> {
  const summary = await runAutoDraftInvoices(
    { ...ctx, triggeredBy: ctx.actorUserId },
    periodMonth,
  );
  return { ok: true, status: 200, data: summary };
}

// ── Config CRUD ─────────────────────────────────────────────────────────────

/** Every `select` feeding this mapper — keep them in step with its param type. */
const CONFIG_SELECT = {
  id: true, runDayOfMonth: true, billPeriodOffset: true, autoBillDayOfMonth: true,
  dueDayOffset: true, includeRent: true,
  includeElectricity: true, includeMgmtFee: true, includeCleaning: true,
  autoApprove: true, isActive: true, updatedAt: true,
} as const;

function mapConfigRow(row: {
  id: string; runDayOfMonth: number; billPeriodOffset: number; autoBillDayOfMonth: number | null;
  dueDayOffset: number | null;
  includeRent: boolean; includeElectricity: boolean; includeMgmtFee: boolean; includeCleaning: boolean;
  autoApprove: boolean; isActive: boolean; updatedAt: Date;
}): DraftConfigRow {
  return {
    id: row.id, runDayOfMonth: row.runDayOfMonth, billPeriodOffset: row.billPeriodOffset,
    autoBillDayOfMonth: row.autoBillDayOfMonth,
    dueDayOffset: row.dueDayOffset,
    includeRent: row.includeRent, includeElectricity: row.includeElectricity,
    includeMgmtFee: row.includeMgmtFee, includeCleaning: row.includeCleaning,
    autoApprove: row.autoApprove, isActive: row.isActive, updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDraftConfigService(ctx: AutoDraftActorCtx): Promise<ServiceResult<DraftConfigRow>> {
  const row = await getDraftConfig(ctx.orgId);
  if (!row) return { ok: false, status: 404, error: "Draft config not found" };
  return { ok: true, status: 200, data: mapConfigRow(row) };
}

export async function createDraftConfigService(
  ctx: AutoDraftActorCtx,
  input: { runDayOfMonth: number; billPeriodOffset?: number; autoBillDayOfMonth?: number | null; dueDayOffset?: number | null; includeRent?: boolean; includeElectricity?: boolean; includeMgmtFee?: boolean; includeCleaning?: boolean },
): Promise<ServiceResult<DraftConfigRow>> {
  const db = getDb();
  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.draftConfig.create({
        data: {
          organizationId: ctx.orgId,
          runDayOfMonth: input.runDayOfMonth,
          // Omit ⇒ the column default (1 = bill next month), never a silent 0.
          ...(input.billPeriodOffset !== undefined ? { billPeriodOffset: input.billPeriodOffset } : {}),
          // `?? null` (not a conditional spread): creating a schedule must land on
          // auto-billing OFF whether the caller omitted the field or sent null.
          autoBillDayOfMonth: input.autoBillDayOfMonth ?? null,
          dueDayOffset: input.dueDayOffset ?? null,
          ...(input.includeRent !== undefined ? { includeRent: input.includeRent } : {}),
          ...(input.includeElectricity !== undefined ? { includeElectricity: input.includeElectricity } : {}),
          ...(input.includeMgmtFee !== undefined ? { includeMgmtFee: input.includeMgmtFee } : {}),
          ...(input.includeCleaning !== undefined ? { includeCleaning: input.includeCleaning } : {}),
        },
        select: CONFIG_SELECT,
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
        action: "billing.draftconfig.created", entityType: "DraftConfig", entityId: created.id,
        meta: {
          runDayOfMonth: created.runDayOfMonth, billPeriodOffset: created.billPeriodOffset,
          // Money-gate setting: who turned unattended billing on, and when, must
          // be answerable from the audit trail alone.
          autoBillDayOfMonth: created.autoBillDayOfMonth,
          dueDayOffset: created.dueDayOffset,
          includeRent: created.includeRent, includeElectricity: created.includeElectricity,
          includeMgmtFee: created.includeMgmtFee, includeCleaning: created.includeCleaning,
        },
        ip: ctx.ip, userAgent: ctx.userAgent,
      });
      return created;
    });
    return { ok: true, status: 201, data: mapConfigRow(row) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, status: 409, error: "Draft config already exists for this organization" };
    }
    throw err;
  }
}

export async function patchDraftConfigService(
  ctx: AutoDraftActorCtx,
  id: string,
  input: {
    expectedUpdatedAt: string;
    runDayOfMonth?: number;
    billPeriodOffset?: number;
    autoBillDayOfMonth?: number | null;
    dueDayOffset?: number | null;
    isActive?: boolean;
    includeRent?: boolean;
    includeElectricity?: boolean;
    includeMgmtFee?: boolean;
    includeCleaning?: boolean;
  },
): Promise<ServiceResult<DraftConfigRow>> {
  const { expectedUpdatedAt, ...fields } = input;
  const data: Record<string, unknown> = {};
  if (fields.runDayOfMonth !== undefined) data.runDayOfMonth = fields.runDayOfMonth;
  if (fields.billPeriodOffset !== undefined) data.billPeriodOffset = fields.billPeriodOffset;
  // `undefined` = field absent = leave as-is; explicit `null` = turn auto-billing
  // OFF. Both must stay reachable, so this cannot collapse into a truthiness test.
  if (fields.autoBillDayOfMonth !== undefined) data.autoBillDayOfMonth = fields.autoBillDayOfMonth;
  if (fields.dueDayOffset !== undefined) data.dueDayOffset = fields.dueDayOffset;
  if (fields.isActive !== undefined) data.isActive = fields.isActive;
  if (fields.includeRent !== undefined) data.includeRent = fields.includeRent;
  if (fields.includeElectricity !== undefined) data.includeElectricity = fields.includeElectricity;
  if (fields.includeMgmtFee !== undefined) data.includeMgmtFee = fields.includeMgmtFee;
  if (fields.includeCleaning !== undefined) data.includeCleaning = fields.includeCleaning;

  const db = getDb();
  const updated = await db.$transaction(async (tx) => {
    const row = await withStaleCheck(() =>
      tx.draftConfig.update({
        where: { id, organizationId: ctx.orgId, updatedAt: new Date(expectedUpdatedAt) },
        data,
        select: CONFIG_SELECT,
      }),
    );
    if (row === null) return null;
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.draftconfig.updated", entityType: "DraftConfig", entityId: id,
      meta: { patch: data as Record<string, string | number | boolean | null> },
    });
    return row;
  });

  if (updated === null) return { ok: false, status: 409, error: "Record changed since you loaded it" };
  return { ok: true, status: 200, data: mapConfigRow(updated) };
}

// ── Run query services ──────────────────────────────────────────────────────

function mapRunRow(row: {
  id: string; periodMonth: Date; runDate: Date; status: string;
  draftsCreated: number; draftsSkipped: number; errorText: string | null;
  triggeredBy: string | null; createdAt: Date;
}): DraftRunRow {
  return {
    id: row.id, periodMonth: row.periodMonth.toISOString(), runDate: row.runDate.toISOString(),
    status: row.status, draftsCreated: row.draftsCreated, draftsSkipped: row.draftsSkipped,
    errorText: row.errorText, triggeredBy: row.triggeredBy, createdAt: row.createdAt.toISOString(),
  };
}

export async function listDraftRunsService(
  ctx: AutoDraftActorCtx,
  q: { periodMonth?: string; status?: string; limit: number; offset: number },
): Promise<ServiceResult<{ items: DraftRunRow[]; total: number }>> {
  const { rows, total } = await listDraftRuns(ctx.orgId, q);
  return { ok: true, status: 200, data: { total, items: rows.map(mapRunRow) } };
}

export async function getDraftRunService(ctx: AutoDraftActorCtx, id: string): Promise<ServiceResult<DraftRunRow>> {
  const row = await getDraftRun(ctx.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Draft run not found" };
  return { ok: true, status: 200, data: mapRunRow(row) };
}

/**
 * Which billing months this org should have drafted and never did.
 *
 * ONE implementation behind both the cron's post-run report and the admin
 * endpoint, so the log and the screen can never disagree about which months are
 * missing — the same lock-step rule that put resolveBillingPeriod in @kason/shared.
 *
 * Reports only. Drafting a past month is a money-visible act that can also land
 * in a frozen owner-statement period, so recovery stays the explicit
 * POST /draft-runs call an admin already has.
 */
export async function findBillingGapsService(
  ctx: AutoDraftActorCtx,
  opts: { now?: Date; lookbackMonths?: number } = {},
): Promise<
  ServiceResult<{
    targetPeriod: string;
    missingPeriods: string[];
    lookbackMonths: number;
    billPeriodOffset: number | null;
  }>
> {
  const lookbackMonths = opts.lookbackMonths ?? DEFAULT_BILLING_GAP_LOOKBACK_MONTHS;
  const config = await getDraftConfig(ctx.orgId);
  // No config ⇒ this org has never been on scheduled billing; every month would
  // read as "missing" and none of them are.
  if (!config) {
    return {
      ok: true,
      status: 200,
      data: { targetPeriod: ymOfUtc(opts.now ?? new Date()), missingPeriods: [], lookbackMonths, billPeriodOffset: null },
    };
  }

  const targetPeriod = resolveBillingPeriod(opts.now ?? new Date(), config.billPeriodOffset);
  const windowStart = addMonthsToYm(targetPeriod, -lookbackMonths);
  const draftedPeriods = await listCompletedDraftPeriodsSince(ctx.orgId, windowStart);

  return {
    ok: true,
    status: 200,
    data: {
      targetPeriod,
      missingPeriods: findMissingBillingPeriods({ draftedPeriods, targetPeriod, lookbackMonths }),
      lookbackMonths,
      billPeriodOffset: config.billPeriodOffset,
    },
  };
}

// ── Invoice queue services ──────────────────────────────────────────────────

function mapInvoiceRow(row: {
  id: string; invoiceNumber: string; invoiceType: string; status: string;
  party: { displayName: string }; tenancy: { tenancyCode: string } | null;
  periodMonth: Date | null; invoiceDate: Date; dueDate: Date | null;
  totalAmount: { toString(): string }; sstAmount: { toString(): string } | null; updatedAt: Date;
  unitCode?: string | null; propertyName?: string | null;
}): DraftInvoiceRow {
  return {
    id: row.id, invoiceNumber: row.invoiceNumber, invoiceType: row.invoiceType, status: row.status,
    partyName: row.party.displayName, tenancyCode: row.tenancy?.tenancyCode ?? null,
    periodMonth: row.periodMonth ? row.periodMonth.toISOString() : null,
    invoiceDate: row.invoiceDate.toISOString(), dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    totalAmount: toNumber(row.totalAmount), sstAmount: row.sstAmount != null ? toNumber(row.sstAmount) : null,
    updatedAt: row.updatedAt.toISOString(),
    unitCode: row.unitCode ?? null, propertyName: row.propertyName ?? null,
  };
}

export async function listDraftInvoicesService(
  ctx: AutoDraftActorCtx,
  q: { status?: string; periodMonth?: string; partyId?: string; invoiceType?: string; limit: number; offset: number },
): Promise<ServiceResult<{ items: DraftInvoiceRow[]; total: number }>> {
  const { rows, total } = await listDraftInvoices(ctx.orgId, q);
  return { ok: true, status: 200, data: { total, items: rows.map(mapInvoiceRow) } };
}

export async function getDraftInvoiceService(ctx: AutoDraftActorCtx, id: string): Promise<ServiceResult<DraftInvoiceDetail>> {
  const row = await getDraftInvoiceWithCharges(ctx.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Invoice not found" };
  return {
    ok: true, status: 200,
    data: {
      ...mapInvoiceRow(row),
      unitCode: row.unitCode,
      propertyName: row.propertyName,
      listingType: row.listingType,
      charges: row.charges.map((c) => ({
        id: c.id, chargeNumber: c.chargeNumber, chargeType: c.chargeType,
        status: c.status, amount: toNumber(c.amount), description: c.description,
        billingMonth: c.billingMonth ? c.billingMonth.toISOString() : null,
      })),
    },
  };
}

// ── Invoice transitions (Task 7) ──────────────────────────────────────────────
//
// Money rules (NON-NEGOTIABLE):
//  • approve: ONLY from draft → approved (status:"draft" + updatedAt in WHERE; null ⇒ 409).
//  • void: ONLY from draft|approved → void (status:{ in:["draft","approved"] } + updatedAt in WHERE; null ⇒ 409).
//        on void: the synthesized rent Charge (chargeType:"rent") is set status:"void";
//        every OTHER linked charge (electricity/utility/owner line) is DETACHED (invoiceId:null)
//        so a future run can re-draft it. A Charge row is NEVER deleted.
//  • editDates: ONLY while draft; touches invoiceDate/dueDate only — never amounts.
//  • attach: invoice must be draft (404 missing / 409 not-draft); charge must be org-scoped
//        with invoiceId === null (else 409 "already attached"); then recompute totals.
//  • detach: unset the link, recompute; never delete the Charge.
//  • All mutations run inside getDb().$transaction; recordAudit + ChargeEvent are written
//    INSIDE the same tx so they roll back with the action.

/** Approve a single DRAFT invoice → approved, stamping the actor + timestamp. */
export async function approveInvoiceService(
  ctx: AutoDraftActorCtx,
  id: string,
  expectedUpdatedAt: string,
): Promise<ServiceResult<{ id: string }>> {
  const db = getDb();
  const out = await db.$transaction(async (tx) => {
    const res = await withStaleCheck(() =>
      tx.invoice.update({
        where: { id, organizationId: ctx.orgId, status: "draft", updatedAt: new Date(expectedUpdatedAt) },
        data: { status: "approved", approvedBy: ctx.actorUserId, approvedAt: new Date() },
        select: { id: true },
      }),
    );
    if (res === null) return null;
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.approved", entityType: "Invoice", entityId: id,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    // Approval POSTS the draft charges (→ live receivables) + issues their documents.
    const postedIds = await postApprovedInvoiceChargesTx(tx, ctx, id);
    return { res, postedIds };
  });
  if (out === null) return { ok: false, status: 409, error: "Invoice not in draft or changed since loaded" };
  // Post-commit (never-throws): surface the now-posted rent as owner rental income so it
  // reflects on the owner ledger/statement — mirrors the meter "Post charges" flow.
  await syncOwnerLedgerForCharges(ctx.orgId, ctx.actorUserId, ctx.actorRole, out.postedIds);
  return { ok: true, status: 200, data: { id } };
}

/**
 * Bulk-approve: approve each id ONLY if it is currently draft. Each id is its own
 * per-id transaction (a failing/non-draft id never aborts the batch). Non-draft or
 * concurrently-changed ids are reported in `skipped`, never thrown.
 */
export async function approveBulkService(
  ctx: AutoDraftActorCtx,
  ids: string[],
): Promise<ServiceResult<{ approved: string[]; skipped: string[] }>> {
  const db = getDb();
  const approved: string[] = [];
  const skipped: string[] = [];
  const allPostedIds: string[] = [];
  for (const id of ids) {
    try {
      const postedIds = await db.$transaction(async (tx) => {
        const res = await withStaleCheck(() =>
          tx.invoice.update({
            where: { id, organizationId: ctx.orgId, status: "draft" },
            data: { status: "approved", approvedBy: ctx.actorUserId, approvedAt: new Date() },
            select: { id: true },
          }),
        );
        if (res === null) return null;
        await recordAudit(tx, {
          organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
          action: "billing.invoice.approved", entityType: "Invoice", entityId: id,
          meta: { bulk: true }, ip: ctx.ip, userAgent: ctx.userAgent,
        });
        // Approval POSTS the draft charges (→ live receivables) + issues their documents.
        return await postApprovedInvoiceChargesTx(tx, ctx, id);
      });
      if (postedIds !== null) {
        approved.push(id);
        allPostedIds.push(...postedIds);
      } else {
        skipped.push(id);
      }
    } catch {
      skipped.push(id);
    }
  }
  // Post-commit (never-throws): one owner-ledger sync for every posted charge so the
  // newly-live rent reflects as owner rental income on the ledger/statement.
  if (allPostedIds.length > 0) {
    await syncOwnerLedgerForCharges(ctx.orgId, ctx.actorUserId, ctx.actorRole, allPostedIds);
  }
  return { ok: true, status: 200, data: { approved, skipped } };
}

/**
 * Void an invoice. Allowed ONLY from draft or approved (else 409). The synthesized
 * rent charge is voided; every other linked charge is detached so it can be
 * re-drafted later. Charges are never deleted.
 */
export async function voidInvoiceService(
  ctx: AutoDraftActorCtx,
  id: string,
  expectedUpdatedAt: string,
  reason?: string,
): Promise<ServiceResult<{ id: string }>> {
  const db = getDb();
  try {
    const out = await db.$transaction(async (tx) => {
      const res = await withStaleCheck(() =>
        tx.invoice.update({
          where: { id, organizationId: ctx.orgId, status: { in: ["draft", "approved"] }, updatedAt: new Date(expectedUpdatedAt) },
          data: { status: "void" },
          select: { id: true },
        }),
      );
      if (res === null) return null;

      const billingDocsOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
      const charges = await tx.charge.findMany({
        where: { organizationId: ctx.orgId, invoiceId: id },
        select: {
          id: true,
          chargeNumber: true,
          chargeType: true,
          status: true,
          parentChargeId: true,
          sstRate: true,
        },
      });
      const pairedAgreementFeeIds = agreementFeePairIds(charges);
      if ([...pairedAgreementFeeIds].some((chargeId) => charges.find((charge) => charge.id === chargeId)?.status !== "draft")) {
        throw new AgreementFeePairInvariantError("PAIRED_TA_REQUIRES_ACCOUNTING_CORRECTION");
      }
      for (const c of charges) {
        if (pairedAgreementFeeIds.has(c.id)) {
          // A draft inclusive-SST fee has no issued document yet. Void both
          // receivable legs together; never detach one and orphan the pair.
          await tx.charge.update({
            where: { id: c.id, organizationId: ctx.orgId, status: "draft" },
            data: { status: "void" },
          });
          await tx.chargeEvent.create({
            data: {
              organizationId: ctx.orgId,
              chargeId: c.id,
              eventType: "void",
              eventAt: new Date(),
              actorUserId: ctx.actorUserId,
              payloadJson: { invoiceId: id, reason: reason ?? null },
            },
          });
        } else if (c.chargeType === "rent") {
        // M5-synthesized rent line has no life outside this invoice → reverse it.
        // Flag ON: creditPostedChargeTx handles BOTH states — a posted+documented
        // charge (approved) is credited (CN issued, original offset, outstanding 0);
        // an undocumented one (still draft, or approved before mint-on-post) is
        // plain-voided — so a voided approved invoice never orphans a live document.
        // Flag OFF: the legacy plain status-void (no documents exist to reconcile).
        if (billingDocsOn) {
          await creditPostedChargeTx(tx, {
            organizationId: ctx.orgId, chargeId: c.id, reason: reason ?? "Invoice voided",
            actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
          });
        } else {
          await tx.charge.update({ where: { id: c.id, organizationId: ctx.orgId }, data: { status: "void" } });
          await tx.chargeEvent.create({
            data: { organizationId: ctx.orgId, chargeId: c.id, eventType: "void", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId: id, reason: reason ?? null } },
          });
        }
        } else {
        // Externally-sourced charge (electricity/utility/owner line) → detach, keep the row.
        await detachChargeTx(tx, ctx.orgId, c.id);
        await tx.chargeEvent.create({
          data: { organizationId: ctx.orgId, chargeId: c.id, eventType: "draft.unlinked", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId: id, reason: "invoice voided" } },
        });
        }
      }
      await recordAudit(tx, {
        organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
        action: "billing.invoice.voided", entityType: "Invoice", entityId: id,
        meta: { reason: reason ?? null }, ip: ctx.ip, userAgent: ctx.userAgent,
      });
      return res;
    });
    if (out === null) return { ok: false, status: 409, error: "Invoice not voidable from its current state or changed since loaded" };
    return { ok: true, status: 200, data: { id } };
  } catch (error) {
    if (error instanceof AgreementFeePairInvariantError) {
      return { ok: false, status: 409, error: error.message };
    }
    throw error;
  }
}

/** Edit ONLY the date fields (invoiceDate/dueDate) of a DRAFT invoice — never amounts. */
export async function editInvoiceDatesService(
  ctx: AutoDraftActorCtx,
  id: string,
  patch: { invoiceDate?: string; dueDate?: string; expectedUpdatedAt: string },
): Promise<ServiceResult<{ id: string }>> {
  const data: Record<string, Date> = {};
  if (patch.invoiceDate !== undefined) data.invoiceDate = new Date(patch.invoiceDate);
  if (patch.dueDate !== undefined) data.dueDate = new Date(patch.dueDate);

  const db = getDb();
  const out = await db.$transaction(async (tx) => {
    const res = await withStaleCheck(() =>
      tx.invoice.update({
        where: { id, organizationId: ctx.orgId, status: "draft", updatedAt: new Date(patch.expectedUpdatedAt) },
        data,
        select: { id: true },
      }),
    );
    if (res === null) return null;
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.dates_edited", entityType: "Invoice", entityId: id,
      meta: { invoiceDate: patch.invoiceDate ?? null, dueDate: patch.dueDate ?? null },
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return res;
  });
  if (out === null) return { ok: false, status: 409, error: "Invoice not in draft or changed since loaded" };
  return { ok: true, status: 200, data: { id } };
}

/** Manual exception for an invoice charge line. Draft-only, manager-only at the
 * route, optimistic-concurrency guarded, and atomic with total + audit updates. */
export async function editDraftChargeAmountService(
  ctx: AutoDraftActorCtx,
  invoiceId: string,
  chargeId: string,
  patch: { amount: number; expectedUpdatedAt: string },
): Promise<ServiceResult<{ id: string; chargeId: string; totalAmount: number }>> {
  const amount = patch.amount.toFixed(2);
  const out = await getDb().$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId: ctx.orgId },
      select: { id: true, status: true, updatedAt: true },
    });
    if (!invoice) return { kind: "missing" as const };
    if (invoice.status !== "draft") return { kind: "not_draft" as const };
    if (invoice.updatedAt.getTime() !== new Date(patch.expectedUpdatedAt).getTime()) {
      return { kind: "stale" as const };
    }
    const charge = await tx.charge.findFirst({
      where: { id: chargeId, organizationId: ctx.orgId },
      select: {
        id: true,
        invoiceId: true,
        status: true,
        amount: true,
        chargeNumber: true,
        chargeType: true,
        parentChargeId: true,
        sstRate: true,
      },
    });
    if (!charge) return { kind: "charge_missing" as const };
    if (charge.invoiceId !== invoiceId) return { kind: "not_attached" as const };
    if (charge.status !== "draft") return { kind: "charge_live" as const };
    if (await isAgreementFeePairMemberTx(tx, ctx.orgId, charge)) {
      return { kind: "paired_agreement_fee" as const };
    }
    const before = charge.amount.toString();
    await tx.charge.update({
      where: { id: chargeId, organizationId: ctx.orgId },
      data: { amount, outstandingAmount: amount },
    });
    const totalAmount = await recomputeInvoiceTotalTx(tx, ctx.orgId, invoiceId);
    await tx.chargeEvent.create({
      data: {
        organizationId: ctx.orgId, chargeId, eventType: "draft.amount_manually_edited",
        eventAt: new Date(), actorUserId: ctx.actorUserId,
        payloadJson: { invoiceId, before, after: amount, source: "invoice-drawer" },
      },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.charge_amount_edited", entityType: "Invoice", entityId: invoiceId,
      diff: { before: { chargeId, amount: before }, after: { chargeId, amount } },
      meta: { chargeId, before, after: amount }, ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { kind: "ok" as const, totalAmount };
  });

  switch (out.kind) {
    case "missing": return { ok: false, status: 404, error: "Invoice not found" };
    case "charge_missing": return { ok: false, status: 404, error: "Charge not found" };
    case "not_draft": return { ok: false, status: 409, error: "Invoice is not a draft" };
    case "stale": return { ok: false, status: 409, error: "Invoice changed since loaded. Refresh and try again." };
    case "not_attached": return { ok: false, status: 409, error: "Charge is not attached to this invoice" };
    case "charge_live": return { ok: false, status: 409, error: "Only draft charges can be edited" };
    case "paired_agreement_fee": return { ok: false, status: 409, error: "PAIRED_TA_EDIT_FROM_TENANCY" };
    default: return { ok: true, status: 200, data: { id: invoiceId, chargeId, totalAmount: out.totalAmount } };
  }
}

/** Attach an unlinked org-scoped charge to a DRAFT invoice, then recompute the total. */
export async function attachChargeService(
  ctx: AutoDraftActorCtx,
  invoiceId: string,
  chargeId: string,
): Promise<ServiceResult<{ id: string }>> {
  const db = getDb();
  const out = await db.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: ctx.orgId }, select: { id: true, status: true } });
    if (!inv) return { kind: "missing" as const };
    if (inv.status !== "draft") return { kind: "not_draft" as const };

    const charge = await tx.charge.findFirst({
      where: { id: chargeId, organizationId: ctx.orgId },
      select: {
        id: true,
        invoiceId: true,
        status: true,
        chargeNumber: true,
        chargeType: true,
        parentChargeId: true,
        sstRate: true,
      },
    });
    if (!charge) return { kind: "charge_missing" as const };
    if (charge.invoiceId !== null) return { kind: "already_attached" as const };
    if (await isAgreementFeePairMemberTx(tx, ctx.orgId, charge)) {
      return { kind: "paired_agreement_fee" as const };
    }

    await attachChargeTx(tx, ctx.orgId, chargeId, invoiceId);
    await recomputeInvoiceTotalTx(tx, ctx.orgId, invoiceId);
    await tx.chargeEvent.create({
      data: { organizationId: ctx.orgId, chargeId, eventType: "draft.linked", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId, source: "manual" } },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.charge_attached", entityType: "Invoice", entityId: invoiceId,
      meta: { chargeId }, ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { kind: "ok" as const };
  });

  switch (out.kind) {
    case "missing": return { ok: false, status: 404, error: "Invoice not found" };
    case "charge_missing": return { ok: false, status: 404, error: "Charge not found" };
    case "not_draft": return { ok: false, status: 409, error: "Invoice is not a draft" };
    case "already_attached": return { ok: false, status: 409, error: "Charge already attached to an invoice" };
    case "paired_agreement_fee": return { ok: false, status: 409, error: "PAIRED_TA_ATTACH_FROM_TENANCY" };
    default: return { ok: true, status: 200, data: { id: invoiceId } };
  }
}

/**
 * Detach a charge from its invoice (unset link only — never delete), then recompute.
 * Guarded exactly like attachChargeService: the invoice must exist + be a draft, and
 * the charge must exist + actually be attached to THIS invoice (no cross-invoice detach,
 * no mutating the total of an approved/sent invoice).
 */
export async function detachChargeService(
  ctx: AutoDraftActorCtx,
  invoiceId: string,
  chargeId: string,
): Promise<ServiceResult<{ id: string }>> {
  const db = getDb();
  const out = await db.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: ctx.orgId }, select: { id: true, status: true } });
    if (!inv) return { kind: "missing" as const };
    if (inv.status !== "draft") return { kind: "not_draft" as const };

    const charge = await tx.charge.findFirst({
      where: { id: chargeId, organizationId: ctx.orgId },
      select: {
        id: true,
        invoiceId: true,
        status: true,
        chargeNumber: true,
        chargeType: true,
        parentChargeId: true,
        sstRate: true,
      },
    });
    if (!charge) return { kind: "charge_missing" as const };
    if (charge.invoiceId !== invoiceId) return { kind: "not_attached" as const };
    if (await isAgreementFeePairMemberTx(tx, ctx.orgId, charge)) {
      return { kind: "paired_agreement_fee" as const };
    }

    await detachChargeTx(tx, ctx.orgId, chargeId);
    await recomputeInvoiceTotalTx(tx, ctx.orgId, invoiceId);
    await tx.chargeEvent.create({
      data: { organizationId: ctx.orgId, chargeId, eventType: "draft.unlinked", eventAt: new Date(), actorUserId: ctx.actorUserId, payloadJson: { invoiceId, source: "manual" } },
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "billing.invoice.charge_detached", entityType: "Invoice", entityId: invoiceId,
      meta: { chargeId }, ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { kind: "ok" as const };
  });

  switch (out.kind) {
    case "missing": return { ok: false, status: 404, error: "Invoice not found" };
    case "charge_missing": return { ok: false, status: 404, error: "Charge not found" };
    case "not_draft": return { ok: false, status: 409, error: "Invoice is not a draft" };
    case "not_attached": return { ok: false, status: 409, error: "Charge is not attached to this invoice" };
    case "paired_agreement_fee": return { ok: false, status: 409, error: "PAIRED_TA_DETACH_FROM_TENANCY" };
    default: return { ok: true, status: 200, data: { id: invoiceId } };
  }
}
