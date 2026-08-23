import { Prisma, getDb } from "@kason/db";
import type { ManagementFeeConfigInput } from "@kason/shared";
import { rematerializeOwnerRecentMonths } from "../owner-ledger/unit-month-ledger.remateralize-range";
import {
  ACTIVE_ADJUSTMENT_NOTE_STATUSES,
  centsToString,
  computeManagementFee,
  computeManagementFeeRentBase,
  isInFreePeriod,
  toCents,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { StaleUpdateError } from "../../lib/concurrency-error";
import { isPhase2FlagEnabled, isLettingCommissionEnabled } from "../../lib/feature-flags";
import { mintDocumentNumberTx } from "../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { issueDocumentTx, issueStatementIvownDocumentTx } from "../billing-documents/issue.service";
import { resolveMgmtFeeSstRateByUnit } from "./owner-billing-sst-rate";
import { createSignedDownloadUrl, deleteObject, putObject, requireBucket } from "../../lib/storage";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import { renderToHtml } from "../../lib/document-templates/render";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { buildYanniePdfHtml } from "./owner-statement-pdf";
import { assembleYannieStatement, assembleYannieStatementForMonth } from "./owner-statement-sections";
import type { YannieSections } from "./owner-statement-sections";
import { syncMonthService } from "../owner-ledger/owner-ledger.sync";
import {
  syncOwnerLedgerForCharges,
  syncOwnerLedgerForOwnerMonth,
} from "../owner-ledger/owner-ledger.sync-hook";
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";
import { resolveBillingReadiness, type BillingReadiness } from "./owner-billing-ready";
import {
  attachChargeToInvoice,
  buildOwnerStatementInvoiceKey,
  countChargesWithPrefix,
  createFeeConfig,
  createLineCharge,
  createOwnerStatementInvoice,
  addToStatementInvoiceTotalsInTx,
  createStatementCharge,
  findChargeInStatement,
  findDocumentSeriesInTx,
  findFeeConfigsForOwner,
  findInvoiceByIdInTx,
  findInvoiceByIdempotencyKey,
  findInvoiceByIdempotencyKeyInTx,
  findCommissionRentCharges,
  findOwnerBorneUtilityComponents,
  findOwnerInOrg,
  findApartmentOwnedByOwner,
  findPropertyInOrg,
  findStatementById,
  findUnitOwnedByOwner,
  findUnvoidedChargeForUnitMonth,
  getFeeConfig,
  listFeeConfigs,
  setStatementPdfKey,
  listOwnerStatements,
  resolveConfigForUnit,
  resolveOwnerUnitsForMonth,
  releaseVoidedStatementSlotsInTx,
  setFeeConfigActive,
  transitionStatementStatusGuarded,
  updateFeeConfigGuarded,
  updateLineChargeGuarded,
  updateStatementTotals,
  voidLineCharge,
  withTransaction,
  type DbCharge,
  type DbInvoice,
  type DbManagementFeeConfig,
  type FeeConfigFilters,
  type OwnerUnitForMonth,
  type SstRateByUnit,
  type Pagination,
  type StatementFilters,
} from "./owner-billing.repository";
import type {
  GenerateStatementInput,
  ManagementFeeConfigListRow,
  ManagementFeeConfigPatchInput,
  ManagementFeeConfigRow,
  OwnerBillingActorCtx,
  OwnerBillingServiceResult,
  OwnerStatementListRow,
  OwnerStatementPdfResult,
  OwnerPayoutApprovalPreflight,
  OwnerPayoutSafetyCheck,
  OwnerStatementRow,
  OwnerStatementSendResult,
  StatementLineInput,
  StatementLinePatchInput,
} from "./owner-billing.types";

const STALE = "Record changed — reloaded";
const NOT_FOUND = "Fee config not found";
const OWNER_NOT_IN_ORG = "Owner not found in this organization";
const PROPERTY_NOT_IN_ORG = "Property not found in this organization";
const UNIT_NOT_OWNED = "Unit not found for this owner";
const CAP_REQUIRES_AMOUNT = "capAmount is required when feeType is 'cap'";

/**
 * Serialise a Prisma row to the read DTO. Decimal columns come back as
 * Prisma.Decimal and are converted to strings via `.toString()` here — they are
 * NEVER leaked as Decimal across the service boundary. `.toString()` does NOT
 * pad to 2 dp (e.g. a feeValue of 10.00 serialises to "10", not "10.00").
 * Nullable Decimals stay null.
 */
function mapConfig(row: DbManagementFeeConfig): ManagementFeeConfigRow {
  return {
    id: row.id,
    ownerPartyId: row.ownerPartyId,
    propertyId: row.propertyId,
    apartmentId: row.apartmentId,
    feeType: row.feeType,
    feeValue: row.feeValue.toString(),
    capAmount: row.capAmount === null ? null : row.capAmount.toString(),
    sstPercent: row.sstPercent.toString(),
    freePeriodStart: row.freePeriodStart?.toISOString() ?? null,
    freePeriodEnd: row.freePeriodEnd?.toISOString() ?? null,
    firstChargeMonth: row.firstChargeMonth?.toISOString() ?? null,
    firstChargeBaseAmount: row.firstChargeBaseAmount?.toString() ?? null,
    paxDeductionPerPerson: row.paxDeductionPerPerson?.toString() ?? null,
    isActive: row.isActive,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Create a management-fee config. The input is already parsed by
 * managementFeeConfigInput at the route, so its defaults (sstPercent "8",
 * isActive true) are present. The insert + audit row land in ONE transaction.
 */
export async function createFeeConfigService(
  ctx: OwnerBillingActorCtx,
  input: ManagementFeeConfigInput,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  // Cross-org FK guard (mirrors tasks' findListing/findTicketById pre-validation):
  // every referenced id must resolve inside the actor's org BEFORE the insert tx,
  // else a cross-org id would be persisted. ownerPartyId is "in org" iff it is a
  // landlord on some LandlordTenancy in this org; propertyId, when given, must be
  // a Property in this org.
  const ownerInOrg = await findOwnerInOrg(ctx.orgId, input.ownerPartyId);
  if (!ownerInOrg) return { ok: false as const, status: 404, error: OWNER_NOT_IN_ORG };
  let resolvedPropertyId = input.propertyId ?? null;
  if (input.apartmentId != null) {
    const apartment = await findApartmentOwnedByOwner(ctx.orgId, input.ownerPartyId, input.apartmentId);
    if (!apartment) return { ok: false as const, status: 404, error: UNIT_NOT_OWNED };
    resolvedPropertyId = apartment.propertyId;
  } else if (input.propertyId != null) {
    const propertyInOrg = await findPropertyInOrg(ctx.orgId, input.propertyId);
    if (!propertyInOrg) return { ok: false as const, status: 404, error: PROPERTY_NOT_IN_ORG };
  }

  const created = await withTransaction(async (tx) => {
    const row = await createFeeConfig(tx, {
      organizationId: ctx.orgId,
      ownerPartyId: input.ownerPartyId,
      propertyId: resolvedPropertyId,
      apartmentId: input.apartmentId ?? null,
      feeType: input.feeType,
      feeValue: input.feeValue,
      capAmount: input.capAmount ?? null,
      // Management services are always subject to the current 8% SST rule.
      // Keep this server-side so an old UI or direct API call cannot save a
      // different tax rate and create accounting drift.
      sstPercent: "8",
      freePeriodStart: input.freePeriodStart ? new Date(input.freePeriodStart) : null,
      freePeriodEnd: input.freePeriodEnd ? new Date(input.freePeriodEnd) : null,
      firstChargeMonth: input.firstChargeMonth ? new Date(input.firstChargeMonth) : null,
      firstChargeBaseAmount: input.firstChargeBaseAmount ?? null,
      paxDeductionPerPerson: input.paxDeductionPerPerson ?? null,
      isActive: input.isActive,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    });
    const dto = mapConfig(row);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.feeConfig.create",
      entityType: "ManagementFeeConfig",
      entityId: row.id,
      diff: { after: dto } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return dto;
  });
  await rematerializeOwnerRecentMonths(ctx, created.ownerPartyId, new Date());
  return { ok: true as const, status: 201, data: created };
}

export async function listFeeConfigsService(
  ctx: OwnerBillingActorCtx,
  filters: FeeConfigFilters,
  page: Pagination,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigListRow>> {
  const rows = await listFeeConfigs(ctx.orgId, filters, page);
  return {
    ok: true as const,
    status: 200,
    data: { items: rows.map(mapConfig), limit: page.limit, offset: page.offset },
  };
}

export async function getFeeConfigService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  const row = await getFeeConfig(ctx.orgId, id);
  if (!row) return { ok: false as const, status: 404, error: NOT_FOUND };
  return { ok: true as const, status: 200, data: mapConfig(row) };
}

/**
 * R3 readiness read for the tracker "Bill this unit" pre-check. Apartment scope,
 * current-month reference. requireRole("manager") at the route. resolveBillingReadiness
 * returns non-null for apartment scope (only a null listingId yields null), so the
 * ?? is defensive.
 */
export async function getBillingReadinessService(
  ctx: OwnerBillingActorCtx,
  apartmentId: string,
): Promise<OwnerBillingServiceResult<BillingReadiness>> {
  const now = new Date();
  const asOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const readiness = await resolveBillingReadiness(getDb(), {
    orgId: ctx.orgId,
    scope: { kind: "apartment", apartmentId },
    asOf,
  });
  return {
    ok: true as const,
    status: 200,
    data: readiness ?? { ownerAssigned: false, hasActiveConfig: false, ownerPartyId: null },
  };
}

/**
 * Per-field update with optimistic concurrency. The patch is parsed at the route
 * by managementFeeConfigPatch (every config field optional + a required
 * expectedUpdatedAt). We pre-read org-scoped (404 if missing/cross-org), then run
 * the guarded write + audit in ONE transaction. A stale expectedUpdatedAt makes
 * updateFeeConfigGuarded throw StaleUpdateError → mapped to 409 with the exact
 * "Record changed — reloaded" body; the whole tx (write + audit) unwinds.
 */
export async function updateFeeConfigService(
  ctx: OwnerBillingActorCtx,
  id: string,
  patch: ManagementFeeConfigPatchInput,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  const existing = await getFeeConfig(ctx.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: NOT_FOUND };

  // Cross-org FK guard on a patch that re-points the owner or the property — the
  // new reference must live in the actor's org, same as on create. (A patch that
  // clears propertyId to null skips the property check; null = "all the owner's
  // properties".)
  if (patch.ownerPartyId !== undefined) {
    const ownerInOrg = await findOwnerInOrg(ctx.orgId, patch.ownerPartyId);
    if (!ownerInOrg) return { ok: false as const, status: 404, error: OWNER_NOT_IN_ORG };
  }
  if (patch.propertyId !== undefined && patch.propertyId !== null) {
    const propertyInOrg = await findPropertyInOrg(ctx.orgId, patch.propertyId);
    if (!propertyInOrg) return { ok: false as const, status: 404, error: PROPERTY_NOT_IN_ORG };
  }
  if (patch.apartmentId !== undefined && patch.apartmentId !== null) {
    const effectiveOwnerId = patch.ownerPartyId ?? existing.ownerPartyId;
    const apartment = await findApartmentOwnedByOwner(ctx.orgId, effectiveOwnerId, patch.apartmentId);
    if (!apartment) return { ok: false as const, status: 404, error: UNIT_NOT_OWNED };
    patch.propertyId = apartment.propertyId;
  }

  // Cap invariant guard. The route-level refine only fires when the patch carries
  // feeType: "cap" (v.feeType !== undefined). A patch that sets capAmount: null
  // while OMITTING feeType slips past it but, on a row already stored
  // feeType: "cap", produces an invalid cap-without-amount row that
  // computeManagementFee later throws on. Re-check against the EFFECTIVE
  // (post-merge) values here, where `existing` is known.
  const effectiveFeeType = patch.feeType ?? existing.feeType;
  const effectiveCapAmount =
    patch.capAmount !== undefined ? patch.capAmount : existing.capAmount;
  if (effectiveFeeType === "cap" && effectiveCapAmount == null) {
    return { ok: false as const, status: 400, error: CAP_REQUIRES_AMOUNT };
  }

  // Split the concurrency token out of the row data — only the config fields the
  // admin actually supplied are written (each remaining `undefined` is skipped).
  const { expectedUpdatedAt, ...fields } = patch;
  const data: Prisma.ManagementFeeConfigUncheckedUpdateManyInput = {
    ...(fields.ownerPartyId !== undefined ? { ownerPartyId: fields.ownerPartyId } : {}),
    ...(fields.propertyId !== undefined ? { propertyId: fields.propertyId } : {}),
    ...(fields.apartmentId !== undefined ? { apartmentId: fields.apartmentId } : {}),
    ...(fields.feeType !== undefined ? { feeType: fields.feeType } : {}),
    ...(fields.feeValue !== undefined ? { feeValue: fields.feeValue } : {}),
    ...(fields.capAmount !== undefined ? { capAmount: fields.capAmount } : {}),
    // Management service is always taxable at 8%; never preserve a legacy or
    // client-supplied alternative when this rule is edited.
    sstPercent: "8",
    ...(fields.freePeriodStart !== undefined
      ? { freePeriodStart: fields.freePeriodStart ? new Date(fields.freePeriodStart) : null }
      : {}),
    ...(fields.freePeriodEnd !== undefined
      ? { freePeriodEnd: fields.freePeriodEnd ? new Date(fields.freePeriodEnd) : null }
      : {}),
    ...(fields.firstChargeMonth !== undefined
      ? { firstChargeMonth: fields.firstChargeMonth ? new Date(fields.firstChargeMonth) : null }
      : {}),
    ...(fields.firstChargeBaseAmount !== undefined
      ? { firstChargeBaseAmount: fields.firstChargeBaseAmount }
      : {}),
    ...(fields.paxDeductionPerPerson !== undefined
      ? { paxDeductionPerPerson: fields.paxDeductionPerPerson }
      : {}),
    ...(fields.isActive !== undefined ? { isActive: fields.isActive } : {}),
    ...(fields.effectiveFrom !== undefined
      ? { effectiveFrom: fields.effectiveFrom ? new Date(fields.effectiveFrom) : null }
      : {}),
    ...(fields.effectiveTo !== undefined
      ? { effectiveTo: fields.effectiveTo ? new Date(fields.effectiveTo) : null }
      : {}),
  };

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateFeeConfigGuarded(tx, ctx.orgId, id, expectedUpdatedAt, data);
      const dto = mapConfig(row);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.feeConfig.update",
        entityType: "ManagementFeeConfig",
        entityId: row.id,
        diff: { before: mapConfig(existing), after: dto } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return dto;
    });
    await rematerializeOwnerRecentMonths(ctx, updated.ownerPartyId, new Date());
    return { ok: true as const, status: 200, data: updated };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

/** Shared retire/restore body: org-scoped pre-read → isActive flip + audit in-tx. */
async function setActiveService(
  ctx: OwnerBillingActorCtx,
  id: string,
  isActive: boolean,
  action: "owner-billing.feeConfig.retire" | "owner-billing.feeConfig.restore",
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  const existing = await getFeeConfig(ctx.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: NOT_FOUND };

  const updated = await withTransaction(async (tx) => {
    const row = await setFeeConfigActive(tx, ctx.orgId, id, isActive);
    const dto = mapConfig(row);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action,
      entityType: "ManagementFeeConfig",
      entityId: row.id,
      meta: { isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return dto;
  });
  await rematerializeOwnerRecentMonths(ctx, updated.ownerPartyId, new Date());
  return { ok: true as const, status: 200, data: updated };
}

export function retireFeeConfigService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  return setActiveService(ctx, id, false, "owner-billing.feeConfig.retire");
}

export function restoreFeeConfigService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<ManagementFeeConfigRow>> {
  return setActiveService(ctx, id, true, "owner-billing.feeConfig.restore");
}

// ─── Owner statement (C4) — generate (idempotent) + list ────────────────────

const OWNER_NOT_FOUND = "Owner not found in this organization";
const UNIT_NOT_FOUND = "Unit not found for this owner";
const P2002 = "P2002"; // Prisma unique-constraint violation code

/**
 * First-of-month (UTC) Date for a "YYYY-MM" billing month. Used for the
 * Invoice.periodMonth and the Charge.billingMonth / Charge.dueDate keys. We use
 * UTC so the same calendar month is produced regardless of server timezone —
 * never parse the month back out of the idempotencyKey (schema note on periodMonth).
 */
function firstOfMonthUtc(billingMonth: string): Date {
  const [y, m] = billingMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/** "YYYYMM" form of a billing month, for the invoiceNumber / chargeNumber prefixes. */
function compactMonth(billingMonth: string): string {
  return billingMonth.replace("-", "");
}

/**
 * Serialise a money Decimal to a canonical 2-dp string (e.g. Prisma's
 * `200` / `200.5` → "200.00" / "200.50"). Routed through the cent primitive so
 * the statement read DTO matches the 2-dp money contract `computeManagementFee`
 * produces — never a scale-trimmed `.toString()`.
 */
function money2dp(value: { toString(): string }): string {
  return centsToString(toCents(value.toString(), "mapStatement"));
}

function sameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * One source of truth for the management fee that may actually be charged.
 * The fee agreement is intentionally fully configurable: percentage/fixed/cap,
 * optional per-person deduction, optional free period and an optional first
 * charge override. Listing mode never hard-codes any of those choices.
 *
 * Management fee is company revenue but only becomes chargeable after the
 * owner's ordinary rent for the month has been fully collected. Letting-
 * commission rent is not owner income and is excluded from the rent base.
 */
function chargeableManagementFee(
  config: DbManagementFeeConfig,
  unit: OwnerUnitForMonth,
  firstOfMonth: Date,
  billingMonth: string,
): ReturnType<typeof computeManagementFee> | null {
  if (
    config.firstChargeMonth != null &&
    firstOfMonth.getTime() < new Date(Date.UTC(
      config.firstChargeMonth.getUTCFullYear(),
      config.firstChargeMonth.getUTCMonth(),
      1,
    )).getTime()
  ) {
    return null;
  }

  const inFreePeriod = isInFreePeriod(billingMonth, {
    freePeriodStart: config.freePeriodStart?.toISOString() ?? null,
    freePeriodEnd: config.freePeriodEnd?.toISOString() ?? null,
  });
  if (inFreePeriod) return null;

  const rent = computeManagementFeeRentBase(
    unit.managementFeeRentComponents,
    config.paxDeductionPerPerson?.toString() ?? null,
  );
  if (!rent.fullyCollected || toCents(rent.eligibleRentBase, "managementFee.rentBase") <= 0) {
    return null;
  }

  const useFirstChargeOverride =
    config.firstChargeMonth != null &&
    config.firstChargeBaseAmount != null &&
    sameUtcMonth(config.firstChargeMonth, firstOfMonth);

  return computeManagementFee(
    useFirstChargeOverride
      ? {
          feeType: "fixed",
          feeValue: config.firstChargeBaseAmount!.toString(),
          capAmount: null,
          sstPercent: "8",
        }
      : {
          feeType: config.feeType as "percent" | "fixed" | "cap",
          feeValue: config.feeValue.toString(),
          capAmount: config.capAmount === null ? null : config.capAmount.toString(),
          sstPercent: "8",
        },
    rent.eligibleRentBase,
  );
}

/** Serialise an Invoice + its line Charges to the read DTO (Decimals → 2dp strings). */
export function mapStatement(inv: DbInvoice): OwnerStatementRow {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    invoiceType: inv.invoiceType,
    status: inv.status,
    ownerPartyId: inv.ownerPartyId,
    partyId: inv.partyId,
    // ADDITIVE (Task 10): per-unit statement scope; null = legacy owner-combined.
    apartmentId: inv.apartmentId ?? null,
    periodMonth: inv.periodMonth?.toISOString() ?? null,
    invoiceDate: inv.invoiceDate.toISOString(),
    dueDate: inv.dueDate?.toISOString() ?? null,
    currency: inv.currency,
    totalAmount: money2dp(inv.totalAmount),
    sstAmount: inv.sstAmount === null ? "0.00" : money2dp(inv.sstAmount),
    // BACKEND↔FRONTEND CONTRACT: the admin Owner-Statements page gates the
    // "Download PDF" + "Send soft copy" buttons on this. null = no PDF rendered yet.
    pdfKey: inv.pdfKey ?? null,
    attachmentKeys: inv.attachmentKeys ?? [],
    lines: inv.charges.map((ch) => ({
      id: ch.id,
      chargeNumber: ch.chargeNumber,
      chargeType: ch.chargeType,
      unitId: ch.unitId,
      description: ch.description,
      amount: money2dp(ch.amount),
      currency: ch.currency,
      status: ch.status,
      updatedAt: ch.updatedAt.toISOString(),
    })),
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  };
}

/** A single line to write onto the statement (resolved BEFORE the tx). */
interface PlannedLine {
  chargeType: "management_fee" | "cleaning" | "letting_commission" | "letting_commission_sst";
  unitId: string;
  amount: string; // 2dp string (mgmt-fee = base; cleaning = config; letting_commission_sst = 8% of the commission charge)
}

/** An owner-borne utility line auto-fed from the unit's UnitUtilityBill (PART 4).
 * Written through the same no-double-bill (unit+month+chargeType) idempotency
 * probe the mgmt-fee lines use, so a regenerate never duplicates it. */
interface PlannedUtilityLine {
  chargeType: "tnb" | "wifi" | "sewerage";
  unitId: string;
  amount: string; // 2dp string
}

/** Human label for a management-fee statement line. Byte-identical to the
 * fallback `issueStatementIvownDocumentTx` applies when Charge.description is
 * null, so populating the column changes no rendered text — it only stops the
 * charge depending on a downstream default to describe itself. */
const MGMT_FEE_LINE_DESCRIPTION = "Management fee";

/** Human label for an auto-fed owner-borne utility line. */
const UTILITY_LINE_DESCRIPTION: Record<PlannedUtilityLine["chargeType"], string> = {
  tnb: "Owner-borne electricity (vacant aircond / subsidy / rounding)",
  wifi: "Owner-borne WiFi",
  sewerage: "Owner-borne Indah Water",
};

/**
 * Generate (or return the existing) DRAFT owner statement for {owner, month}.
 *
 * Idempotency: keyed on idempotencyKey = "owner:<ownerPartyId>:<billingMonth>".
 * If an Invoice already exists for {org, key} → return it (200) without creating
 * anything. Otherwise build the lines, then create Invoice + Charges + audit in
 * ONE transaction. A P2002 on the unique (a racing concurrent create) is caught
 * and the existing draft re-read and returned.
 *
 * Money: every management-fee amount comes from `computeManagementFee` (NEVER
 * hand-math). The mgmt-fee Charge.amount is the fee BASE (pre-SST); the SST is
 * accumulated into Invoice.sstAmount. Cleaning is a flat per-UNIT pass-through
 * (no SST). Invoice.totalAmount = Σ(line amounts) + sstAmount.
 *
 * `opts.appendToExistingDraft` — APPEND mode, used by the rent-payment hook
 * (mgmt-fee-on-payment.hook.ts). Default OFF, so every existing caller keeps the
 * exact return-the-existing behaviour described above.
 *
 * Why it exists: the fee is now issued when a tenant's rent is fully paid, and an
 * owner with several units gets several payments across the month. The first
 * payment creates the statement; without append mode the second payment would hit
 * the idempotency return and that unit's fee would NEVER be billed — a silent
 * under-bill. In append mode the two early returns are skipped so the in-tx
 * per-(unit, month, chargeType) no-double-bill probes run: units already billed
 * are dropped, the newly-payable unit is appended to the SAME invoice, and the
 * invoice header is incremented to match (addToStatementInvoiceTotalsInTx).
 *
 * Append mode applies ONLY to a `draft` statement. An approved/sent/paid one is
 * returned untouched — moving an issued document's total underneath it is never
 * correct. The caller is responsible for noticing that case; the hook records a
 * durable audit marker so the skipped fee is detectable rather than silent.
 */
export async function generateStatementService(
  ctx: OwnerBillingActorCtx,
  input: GenerateStatementInput,
  opts?: { appendToExistingDraft?: boolean },
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const appendMode = opts?.appendToExistingDraft === true;
  // 1) Owner must be in the actor's org (else 404 — no cross-org leak).
  const ownerInOrg = await findOwnerInOrg(ctx.orgId, input.ownerPartyId);
  if (!ownerInOrg) return { ok: false as const, status: 404, error: OWNER_NOT_FOUND };

  // TWO scopes, one idempotent slot each. Absent apartmentId ⇒ the combined "All
  // Units" statement, keyed `owner:<owner>:<month>`. Present apartmentId ⇒ a per-unit
  // statement, keyed `owner:<owner>:<month>:<apartmentId>`. Distinct keys let the
  // combined statement and any per-unit statement (and per-unit statements for OTHER
  // apartments) coexist for the same owner+month without colliding on the unique key.
  // The SHARED buildOwnerStatementInvoiceKey (Task 6 C) is byte-identical to the
  // prior inline formula and is also called by the freeze service's PDF lookup, so
  // the two can never drift.
  const idempotencyKey = buildOwnerStatementInvoiceKey(
    input.ownerPartyId,
    input.billingMonth,
    input.apartmentId,
  );

  // 2) Idempotency: an existing NON-VOID draft/approved/sent for this {org, key}
  // is returned as-is. A VOID row is treated as absent — the slot has been (or
  // will be) released so a fresh statement can be created.
  // In APPEND mode a `draft` row does NOT short-circuit — we fall through so the
  // in-tx no-double-bill probes can add any not-yet-billed unit to it. A non-draft
  // row still returns as-is (an issued document is never appended to).
  const existing = await findInvoiceByIdempotencyKey(ctx.orgId, idempotencyKey);
  if (existing && existing.status !== "void") {
    if (!(appendMode && existing.status === "draft")) {
      return { ok: true as const, status: 200, data: mapStatement(existing) };
    }
  }
  // else (none, or only a VOID one) → fall through and create a fresh statement.

  const firstOfMonth = firstOfMonthUtc(input.billingMonth);

  // 3) Resolve the owner's units + per-unit rent (reuse the financials resolution).
  //    The combined statement covers the FULL owner-unit set; a per-unit statement
  //    narrows to the one apartment's rooms. Every downstream line selection (utility
  //    components, mgmt-fee, cleaning) reads `scopedUnits`, so scoping here scopes all.
  const allOwnerUnits = await resolveOwnerUnitsForMonth(ctx.orgId, input.ownerPartyId, firstOfMonth);
  const scopedUnits = input.apartmentId
    ? allOwnerUnits.filter((u) => u.apartmentId === input.apartmentId)
    : allOwnerUnits;
  // A per-unit request for an apartment that isn't this owner's (no matching rooms)
  // is a 404 — never generate an empty statement for a foreign/unknown unit.
  if (input.apartmentId && scopedUnits.length === 0) {
    return { ok: false as const, status: 404, error: UNIT_NOT_FOUND };
  }
  // 4) All the owner's configs; per-unit precedence is resolved below.
  const configs = await findFeeConfigsForOwner(ctx.orgId, input.ownerPartyId);
  // 4b) PART 4: owner-borne utility components from each unit's UnitUtilityBill for
  //     the month (TNB-leftover/aircond + indah + wifi), auto-fed as statement lines.
  const utilityComponents = await findOwnerBorneUtilityComponents(
    ctx.orgId,
    scopedUnits.map((u) => u.unitId),
    firstOfMonth,
  );

  // Plan the lines (pure, pre-tx). The no-double-bill probe + writes happen in-tx.
  const plannedLines: PlannedLine[] = [];

  // 5) MGMT FEE — per UNIT/room, only after ordinary owner rent is collected.
  for (const unit of scopedUnits) {
    const config = resolveConfigForUnit(configs, unit, firstOfMonth);
    if (!config) continue; // no applicable config → no mgmt-fee line for this unit
    const fee = chargeableManagementFee(config, unit, firstOfMonth, input.billingMonth);
    if (fee) {
      // ⚠️ MONEY. A zero fee is NOT a line. `findUnvoidedChargeForUnitMonth`
      // treats any existing management_fee charge for this unit+month as
      // already-billed, so a RM 0.00 row would permanently occupy the slot: the
      // corrective re-generate would skip the unit and the real fee could never
      // be recovered without an admin voiding the phantom first. Skipping leaves
      // the slot free, so a re-run bills it properly.
      if (toCents(fee.base, "generateStatement.mgmtFeeBase") <= 0) continue;
      // Charge.amount = fee BASE (pre-SST); the SST is aggregated into
      // Invoice.sstAmount in-tx over the lines we actually keep.
      //
      // NOTE: carpark management fee is applied by computeOwnerPayout (the
      // authoritative owner-facing figure) and is intentionally NOT persisted as
      // a management_fee Charge here. Only listing-unit fees flow through this
      // plannedLines path and appear in Invoice.sstAmount + the persisted Charge
      // rows. Any SST/revenue report that reads persisted management_fee Charges
      // must reconcile against computeOwnerPayout to account for the carpark
      // contribution — do not change the money logic here.
      plannedLines.push({ chargeType: "management_fee", unitId: unit.unitId, amount: fee.base });
    }
  }

  // 6) CLEANING — NOT ISSUED HERE, and no longer issuable anywhere on the owner-billing
  // side. It was a straight DUPLICATE of the bills grid, which bills owner-borne cleaning
  // as chargeType "utility" / category cleaning_owner from the entry scalar (or its
  // recurring tick). The old ensureCleaningCharge idempotency probe filtered on
  // chargeType:"cleaning", so it was structurally blind to the grid's charge and an owner
  // with a configured auto-bill amount was billed cleaning TWICE for the same
  // apartment-month. The automatic issuer went on 2026-07-29; the manual endpoint and the
  // owner-settings amount that fed it went on 2026-08-17. The grid owns cleaning — it has
  // the bearer, the recurring tick and the per-apartment amount. Do NOT add a second
  // issuer back here.

  // 6b) LETTING COMMISSION — the tenant's first-month document remains Rental.
  // The owner statement carries a separate KAEN fee line for the same amount,
  // so the owner's rent income and KAEN's commission are explicit and auditable
  // without ever charging the tenant twice.
  const commissionRows = isLettingCommissionEnabled()
    ? await findCommissionRentCharges(
        ctx.orgId,
        scopedUnits.map((u) => u.unitId),
        firstOfMonth,
      )
    : [];
  for (const row of commissionRows) {
    plannedLines.push({ chargeType: "letting_commission", unitId: row.unitId, amount: row.amount });
  }

  // 6c) LETTING COMMISSION SST (Phase 3) — when a scoped unit's tenancy has commissionSstBearer
  // "owner" AND this statement month is that tenancy's commission month, the owner owes KAEN the
  // 8% SST on KAEN's first-month commission. Derive the SST from the ACTUAL letting_commission
  // charge amount (= 8% of what was really billed to the tenant, never a re-derived rent — M-F2),
  // billed as a flat owner IVOWN line that DEDUCTS from payout via owner-ledger Source 2 only
  // (owner_income ≠ expense/nature → Source 6 skips it → no double-deduct, M-B2). Flag kill-switch.
  if (isLettingCommissionEnabled()) {
    for (const row of commissionRows.filter((item) => item.sstBearer === "owner")) {
      const sstCents = Math.round(toCents(row.amount, "generateStatement") * 0.08);
      if (sstCents <= 0) continue;
      plannedLines.push({ chargeType: "letting_commission_sst", unitId: row.unitId, amount: centsToString(sstCents) });
    }
  }

  // Human-readable number: combined = OS-<mm>-<owner8>; per-unit appends the apartment
  // segment → OS-<mm>-<owner8>-<apt8> (mirrors aptSegment used by the multi-month
  // export + PDF), so per-unit and combined numbers are distinct and each claim their
  // own unique slot.
  const invoiceNumber = input.apartmentId
    ? `OS-${compactMonth(input.billingMonth)}-${input.ownerPartyId.slice(0, 8)}-${input.apartmentId.slice(0, 8)}`
    : `OS-${compactMonth(input.billingMonth)}-${input.ownerPartyId.slice(0, 8)}`;

  // Mgmt-fee lines keep the inline no-double-bill + createStatementCharge path;
  // cleaning lines flow through the SHARED idempotent ensureCleaningCharge helper
  // (C7) so generate + the manual cleaning endpoints can never double-bill the
  // same unit+month. Split the plan here so each family writes through its path.
  const mgmtLines = plannedLines.filter((l) => l.chargeType === "management_fee");
  const commissionLines = plannedLines.filter((l) => l.chargeType === "letting_commission");
  const sstLines = plannedLines.filter((l) => l.chargeType === "letting_commission_sst");

  try {
    const { invoiceId, chargeIds } = await withTransaction(async (tx) => {
      // Race defence: a concurrent create may have landed the draft between our
      // pre-tx idempotency read and here. Re-check in-tx and short-circuit only
      // on an ACTIVE (non-void) racer — a void row falls through to the release
      // + create path below.
      const raced = await findInvoiceByIdempotencyKeyInTx(tx, ctx.orgId, idempotencyKey);
      // APPEND mode reuses a `draft` racer instead of bailing — that IS the point of
      // the mode. Anything non-draft still bails (never append to an issued doc).
      const appendTarget = appendMode && raced && raced.status === "draft" ? raced : null;
      if (raced && raced.status !== "void" && !appendTarget) {
        return { invoiceId: raced.id, chargeIds: [] as string[] };
      }

      // R1: generating a statement mints new dated mgmt-fee/cleaning/utility charges
      // — reject the whole generate if the owner-month is frozen, IN-TX and BEFORE
      // any write. No-op when the flag is off or the period is open.
      await assertPeriodOpen(tx, ctx.orgId, input.ownerPartyId, firstOfMonth);

      // Release any voided row holding our idempotencyKey / invoiceNumber so the
      // create below can claim the unique slots. The voided row is KEPT as a
      // terminal audit record (idempotencyKey → null, invoiceNumber mangled).
      // Skipped when appending: we are reusing a LIVE draft, not claiming a slot,
      // and mangling its number/key would orphan the invoice we are writing to.
      if (!appendTarget) {
        await releaseVoidedStatementSlotsInTx(tx, ctx.orgId, idempotencyKey, invoiceNumber);
      }

      // No-double-bill (mgmt-fee): drop any planned mgmt line whose (unit, month)
      // already has an un-voided mgmt Charge.
      const mgmtToWrite: PlannedLine[] = [];
      for (const line of mgmtLines) {
        const pre = await findUnvoidedChargeForUnitMonth(tx, {
          orgId: ctx.orgId,
          unitId: line.unitId,
          billingMonth: firstOfMonth,
          chargeType: line.chargeType,
        });
        if (pre) continue;
        mgmtToWrite.push(line);
      }

      // PART 4: owner-borne utility lines. Drop any whose (unit, month, chargeType)
      // already has an un-voided Charge (same no-double-bill probe the mgmt-fee
      // lines use), so a regenerate never duplicates a utility line. The KEPT lines
      // are this statement's; pass-through (no SST).
      const utilToWrite: PlannedUtilityLine[] = [];
      for (const comp of utilityComponents) {
        const pre = await findUnvoidedChargeForUnitMonth(tx, {
          orgId: ctx.orgId,
          unitId: comp.unitId,
          billingMonth: firstOfMonth,
          chargeType: comp.chargeType,
        });
        if (pre) continue;
        utilToWrite.push(comp);
      }

      // Letting commission SST (Phase 3): no-double-bill probe per unit+month+chargeType so a
      // regenerate never duplicates the owner SST line.
      const sstToWrite: PlannedLine[] = [];
      for (const line of sstLines) {
        const pre = await findUnvoidedChargeForUnitMonth(tx, {
          orgId: ctx.orgId,
          unitId: line.unitId,
          billingMonth: firstOfMonth,
          chargeType: line.chargeType,
        });
        if (pre) continue;
        sstToWrite.push(line);
      }

      const commissionToWrite: PlannedLine[] = [];
      for (const line of commissionLines) {
        const pre = await findUnvoidedChargeForUnitMonth(tx, {
          orgId: ctx.orgId,
          unitId: line.unitId,
          billingMonth: firstOfMonth,
          chargeType: line.chargeType,
        });
        if (pre) continue;
        commissionToWrite.push(line);
      }

      // SST aggregate over the KEPT mgmt-fee lines, so a skipped (already-billed)
      // line never inflates Invoice.sstAmount.
      const writeSstCents = recomputeSstForLines(
        mgmtToWrite,
        scopedUnits,
        configs,
        firstOfMonth,
        input.billingMonth,
      );

      const mgmtCents = mgmtToWrite.reduce((sum, l) => sum + toCents(l.amount, "generateStatement"), 0);
      const utilCents = utilToWrite.reduce((sum, l) => sum + toCents(l.amount, "generateStatement"), 0);
      const commissionCents = commissionToWrite.reduce((sum, l) => sum + toCents(l.amount, "generateStatement"), 0);
      const commissionSstCents = sstToWrite.reduce((sum, l) => sum + toCents(l.amount, "generateStatement"), 0);
      // cleaningCents is gone with the duplicate cleaning issuer (2026-07-29).
      const totalCents = mgmtCents + utilCents + commissionCents + writeSstCents + commissionSstCents;

      // APPEND: reuse the existing draft. Its header is incremented after the
      // charges are written (below) so total/SST move with the lines. CREATE
      // otherwise — unchanged from before append mode existed.
      const invoice = appendTarget
        ? { id: appendTarget.id }
        : await createOwnerStatementInvoice(tx, {
            organizationId: ctx.orgId,
            invoiceNumber,
            // Combined statement ⇒ apartmentId null (covers all units). Per-unit
            // statement ⇒ the scoped apartmentId, which the assembler's apartment
            // FILTER reads to render just this apartment's lines (and keeps it OFF
            // the owner portal).
            apartmentId: input.apartmentId ?? null,
            partyId: input.ownerPartyId, // bill-to = owner
            ownerPartyId: input.ownerPartyId,
            invoiceType: "owner_statement",
            status: "draft",
            invoiceDate: new Date(),
            periodMonth: firstOfMonth,
            totalAmount: centsToString(totalCents),
            sstAmount: centsToString(writeSstCents),
            currency: "MYR",
            idempotencyKey,
          });

      // Allocate a contiguous chargeNumber run for the mgmt-fee lines.
      const chargePrefix = `OSC-${compactMonth(input.billingMonth)}-${input.ownerPartyId.slice(0, 8)}-`;
      let seq = await countChargesWithPrefix(tx, ctx.orgId, chargePrefix);
      // BUG1: collect every Charge this generate CREATES (mgmt-fee + cleaning +
      // utility) so the post-commit owner-ledger re-sync below covers them. Without
      // it the Source-2 cleaning never materialises as an OwnerLedgerEntry and the
      // §5 Expense Breakdown omits it.
      const createdChargeIds: string[] = [];
      for (const line of mgmtToWrite) {
        seq += 1;
        const charge = await createStatementCharge(tx, {
          organizationId: ctx.orgId,
          chargeNumber: `${chargePrefix}${String(seq).padStart(4, "0")}`,
          unitId: line.unitId,
          partyId: input.ownerPartyId,
          chargeType: line.chargeType,
          status: "draft",
          // Explicit, like the utility + letting-commission-SST siblings below.
          // Omitting it left Charge.description NULL, so every reader fell back
          // to a constant literal and the charge could not describe itself. The
          // unit is deliberately NOT baked in here — it is carried separately
          // (Charge.unitId) and rendered per line by the document surfaces, so
          // repeating it in the text would duplicate it on screen and on the PDF.
          description: MGMT_FEE_LINE_DESCRIPTION,
          dueDate: firstOfMonth,
          billingMonth: firstOfMonth,
          amount: line.amount,
          outstandingAmount: line.amount,
          currency: "MYR",
          invoiceId: invoice.id,
          attachmentKeys: [],
          // A management fee is KAEN's service revenue (the Charge amount is
          // the pre-SST fee base).  Keep the economic treatment on the source
          // charge so profitability never has to infer it from the document
          // title or from an owner-ledger presentation row.
          nature: "profit",
          fundedBy: "owner",
          revenueRecognition: "manager_revenue",
          settlementRecipient: "manager",
          commercialPurpose: "MANAGEMENT_FEE",
          taxTreatment: "taxable_service",
        });
        createdChargeIds.push(charge.id);
        // invoiceId is set on create above; attach is also explicit so a future
        // two-step create-then-link path stays covered + audited identically.
        await attachChargeToInvoice(tx, ctx.orgId, charge.id, invoice.id);
      }

      // PART 4: write the KEPT owner-borne utility lines on the same chargeNumber
      // run, attached to this statement Invoice (pass-through, status draft).
      for (const line of utilToWrite) {
        seq += 1;
        const charge = await createStatementCharge(tx, {
          organizationId: ctx.orgId,
          chargeNumber: `${chargePrefix}${String(seq).padStart(4, "0")}`,
          unitId: line.unitId,
          partyId: input.ownerPartyId,
          chargeType: line.chargeType,
          status: "draft",
          description: UTILITY_LINE_DESCRIPTION[line.chargeType],
          dueDate: firstOfMonth,
          billingMonth: firstOfMonth,
          amount: line.amount,
          outstandingAmount: line.amount,
          currency: "MYR",
          invoiceId: invoice.id,
          attachmentKeys: [],
        });
        createdChargeIds.push(charge.id);
        await attachChargeToInvoice(tx, ctx.orgId, charge.id, invoice.id);
      }

      // Owner-facing letting commission base. This is the KAEN invoice line;
      // the tenant-facing Rental charge remains separate and unchanged.
      for (const line of commissionToWrite) {
        seq += 1;
        const charge = await createStatementCharge(tx, {
          organizationId: ctx.orgId,
          chargeNumber: `${chargePrefix}${String(seq).padStart(4, "0")}`,
          unitId: line.unitId,
          partyId: input.ownerPartyId,
          chargeType: line.chargeType,
          status: "draft",
          description: "Admin Fee (First Month Rental)",
          dueDate: firstOfMonth,
          billingMonth: firstOfMonth,
          amount: line.amount,
          outstandingAmount: line.amount,
          currency: "MYR",
          invoiceId: invoice.id,
          attachmentKeys: [],
          // The tenant still pays first-month rent on the tenant side.  This
          // separate owner-facing charge is KAEN's letting commission and is
          // therefore company revenue (SST remains its own non-profit line).
          nature: "profit",
          fundedBy: "owner",
          revenueRecognition: "manager_revenue",
          settlementRecipient: "manager",
          commercialPurpose: "SERVICE",
          taxTreatment: "taxable_service",
        });
        createdChargeIds.push(charge.id);
        await attachChargeToInvoice(tx, ctx.orgId, charge.id, invoice.id);
      }

      // Letting commission SST lines — flat owner IVOWN charges on the same chargeNumber run.
      for (const line of sstToWrite) {
        seq += 1;
        const charge = await createStatementCharge(tx, {
          organizationId: ctx.orgId,
          chargeNumber: `${chargePrefix}${String(seq).padStart(4, "0")}`,
          unitId: line.unitId,
          partyId: input.ownerPartyId,
          chargeType: line.chargeType,
          status: "draft",
          description: "SST on Admin Fee (First Month Rental)",
          dueDate: firstOfMonth,
          billingMonth: firstOfMonth,
          amount: line.amount,
          outstandingAmount: line.amount,
          currency: "MYR",
          invoiceId: invoice.id,
          attachmentKeys: [],
        });
        createdChargeIds.push(charge.id);
        await attachChargeToInvoice(tx, ctx.orgId, charge.id, invoice.id);
      }

      const lineCount = mgmtToWrite.length + utilToWrite.length + commissionToWrite.length + sstToWrite.length;

      // APPEND: the charges above were attached to an invoice created by an EARLIER
      // pass, whose header still reflects only that pass. Move it by exactly what
      // this pass wrote, or Invoice.totalAmount under-states the charges hanging off
      // it (and the owner is under-billed on the document even though the ledger
      // deduction is right). Guarded to `draft` inside the helper; a zero-line
      // append is a no-op, so an unchanged count there is expected and harmless.
      if (appendTarget && lineCount > 0) {
        await addToStatementInvoiceTotalsInTx(
          tx,
          ctx.orgId,
          invoice.id,
          centsToString(totalCents),
          centsToString(writeSstCents),
        );
      }

      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.generate",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          ownerPartyId: input.ownerPartyId,
          billingMonth: input.billingMonth,
          lineCount,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      // Accounting docs (§4.2 row 3): ONE IVOWN invoice covering this statement's
      // KAEN income lines (mgmt fee + SST + cleaning) — minted INSIDE this same
      // write tx, so a mint failure aborts the generate (§4.6) and a statement
      // can never commit without its IVOWN document while the flag is on.
      // Deduped on "ivown:"+idempotencyKey (regenerate replays return the
      // existing document); the raced short-circuit above returns before this
      // line, so a concurrent creator is never double-minted.
      if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
        await issueStatementIvownDocumentTx(tx, ctx.orgId, ctx.actorUserId, invoice.id);
      }

      return { invoiceId: invoice.id, chargeIds: createdChargeIds };
    });

    // BUG1: AFTER the write tx commits, re-sync the owner-ledger for the charges
    // this generate created (mirrors postPaymentService). This materialises the
    // Source-2 cleaning — plus mgmt-fee/utility — charges as OwnerLedgerEntry rows so
    // the net-payout Expense Breakdown (assembleYannieStatement reads the ledger)
    // includes Cleaning. The hook is ENABLE_PHASE2_OWNER_BILLING-gated, opens its
    // OWN tx, and SWALLOWS its errors (durable owner_ledger.sync_failed audit on
    // failure), so it can never roll back or break generate. NOT inside the write tx.
    await syncOwnerLedgerForCharges(ctx.orgId, ctx.actorUserId, ctx.actorRole, chargeIds);

    // Re-read the freshly-created statement (with lines) outside the write tx.
    const fresh = await withTransaction((tx) => findInvoiceByIdInTx(tx, ctx.orgId, invoiceId));
    if (!fresh) {
      // Should be unreachable (we just created it in the same org). Fall back to
      // the idempotency read so we never return a half-shape.
      const byKey = await findInvoiceByIdempotencyKey(ctx.orgId, idempotencyKey);
      if (byKey) return { ok: true as const, status: 200, data: mapStatement(byKey) };
      throw new Error("generateStatement: created invoice not found on re-read");
    }
    return { ok: true as const, status: 201, data: mapStatement(fresh) };
  } catch (err) {
    // Race: another request created the {org, key} draft concurrently → P2002 on
    // the unique. Re-read and return the existing draft (idempotent). Guard: only
    // return a non-void racer — a void row means the release race-conflicted and
    // the slot is not yet free; let the error propagate so the caller retries.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === P2002) {
      const byKey = await findInvoiceByIdempotencyKey(ctx.orgId, idempotencyKey);
      if (byKey && byKey.status !== "void") return { ok: true as const, status: 200, data: mapStatement(byKey) };
    }
    throw err;
  }
}

/**
 * Recompute the SST cents over the kept mgmt-fee lines. Mirrors the pre-tx
 * compute exactly (same config precedence + computeManagementFee), so a line
 * dropped by the no-double-bill probe does not leave stale SST in the total.
 */
function recomputeSstForLines(
  lines: PlannedLine[],
  units: OwnerUnitForMonth[],
  configs: DbManagementFeeConfig[],
  firstOfMonth: Date,
  billingMonth: string,
): number {
  let cents = 0;
  for (const line of lines) {
    if (line.chargeType !== "management_fee") continue;
    const unit = units.find((u) => u.unitId === line.unitId);
    if (!unit) continue;
    const config = resolveConfigForUnit(configs, unit, firstOfMonth);
    if (!config) continue;
    const fee = chargeableManagementFee(config, unit, firstOfMonth, billingMonth);
    if (!fee) continue;
    cents += toCents(fee.sst, "generateStatement");
  }
  return cents;
}

/**
 * Org-scoped owner-statement list (invoiceType "owner_statement"), filtered by
 * ownerPartyId / billingMonth / status, offset-paged. Every row is mapped to the
 * read DTO (Decimals → strings). requireRole("manager") is enforced at the route.
 */
export async function listStatementsService(
  ctx: OwnerBillingActorCtx,
  filters: { ownerPartyId?: string; status?: string; billingMonth?: string },
  page: Pagination,
): Promise<OwnerBillingServiceResult<OwnerStatementListRow>> {
  const repoFilters: StatementFilters = {
    ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.billingMonth ? { periodMonth: firstOfMonthUtc(filters.billingMonth) } : {}),
  };
  const rows = await listOwnerStatements(ctx.orgId, repoFilters, page);
  return {
    ok: true as const,
    status: 200,
    data: { items: rows.map(mapStatement), limit: page.limit, offset: page.offset },
  };
}

// ─── Owner statement detail + line add/edit/void (C5) ───────────────────────

const STATEMENT_NOT_FOUND = "Statement not found";
const LINE_NOT_FOUND = "Line not found on this statement";
const NOT_DRAFT = "Statement is not a draft — lines can no longer be added or edited";

/**
 * A statement CN (issueStatementCreditNoteTx, below) is ALWAYS a full-line
 * reversal — it is called only from the two void paths, and in both the
 * target charge(s) are simultaneously set `status → "void"`. If an active
 * charge-adjustment note (CN or DN) already exists on that charge, issuing
 * the full statement CN on top would over-credit the document (e.g. an
 * existing active CN(30) + a new full CN(100) = 130 against a 100 charge).
 * Both void paths reject with this error while any target charge carries an
 * active charge-adjustment note — mutual exclusion caps total active credits
 * at the charge's original adjustable amount.
 */
export const STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT = "STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT";

/**
 * Resolve the per-unit SST rate map for a statement's owner. Thin wrapper over
 * `owner-billing-sst-rate.resolveMgmtFeeSstRateByUnit` (same config precedence
 * the generate path used — and now also the IVOWN document mint in
 * billing-documents/issue.service.ts) so the SST a voided/edited mgmt-fee line
 * carries is recomputed from the SAME source of truth that produced it.
 * Returns an empty map when the statement has no period (defensive —
 * owner_statement always has one) or no owner.
 */
async function resolveSstRatesForStatement(
  orgId: string,
  inv: DbInvoice,
): Promise<SstRateByUnit> {
  const ownerPartyId = inv.ownerPartyId ?? null;
  if (ownerPartyId === null || inv.periodMonth === null) return new Map();
  return resolveMgmtFeeSstRateByUnit(orgId, ownerPartyId, inv.periodMonth);
}

/**
 * Recompute a statement's totalAmount AND sstAmount (cents) from its child
 * Charges. Voided lines are EXCLUDED from BOTH sums.
 *
 * `sstAmount` is derived from the SURVIVING (un-voided) `management_fee` lines:
 * for each, `round(effectiveBase × perUnitSstRate/100)`, summed. This is the fix
 * for the stranded-SST defect — previously `sstAmount` was preserved verbatim, so
 * voiding the generate-path mgmt-fee line left its SST in the statement total
 * (worked example: void the mgmt line of {mgmt 200 + cleaning 100 + sst 16 = 316}
 * now yields 100.00, not 116.00). `sstRateByUnit` is resolved from the SAME fee
 * configs + unit precedence the generate path used, so the recomputed SST matches
 * what generate produced. A line whose unit is absent from the map (no applicable
 * config) contributes no SST. Pass-through lines (tnb/water/…) never carry SST.
 *
 * `totalAmount` = Σ(surviving line amounts) + recomputed sstAmount.
 *
 * Deliberately SEPARATE from `summarizeStatement`
 * (packages/shared/src/finance/owner-statement-totals.ts): that helper derives
 * the owner-facing NET REMITTANCE (collectedRent − Σ deduction lines, with each
 * line carrying its own sstAmount) for the statement render, a different concern
 * than the Invoice.totalAmount billed figure computed here. Both intentionally
 * use the SAME integer-cent primitives (`toCents` / `centsToString` from
 * packages/shared/src/utils/money-cents.ts), so rounding behaviour lives in one
 * place and the two totals cannot drift via parseFloat. Keep them in sync if the
 * cent-summation rule ever changes.
 *
 * `override` lets a caller substitute the post-edit amount/status of a single
 * line BEFORE the freshly-written row is visible on the passed-in (pre-edit)
 * charges array — so the recompute reflects the edit deterministically.
 */
function recomputeTotals(
  inv: DbInvoice,
  sstRateByUnit: SstRateByUnit,
  override?: { chargeId: string; amount?: string; status?: string },
): { totalAmount: string; sstAmount: string } {
  let lineCents = 0;
  let sstCents = 0;
  for (const ch of inv.charges) {
    const status = override && override.chargeId === ch.id && override.status !== undefined
      ? override.status
      : ch.status;
    if (status === "void") continue;
    const amountStr =
      override && override.chargeId === ch.id && override.amount !== undefined
        ? override.amount
        : ch.amount.toString();
    const baseCents = toCents(amountStr, "recomputeTotals");
    lineCents += baseCents;
    // SST is recomputed ONLY from surviving mgmt-fee lines, at the unit's rate.
    if (ch.chargeType === "management_fee" && ch.unitId !== null) {
      const rate = sstRateByUnit.get(ch.unitId);
      if (rate !== undefined) {
        sstCents += Math.round((baseCents * Number(rate)) / 100);
      }
    }
  }
  return {
    totalAmount: centsToString(lineCents + sstCents),
    sstAmount: centsToString(sstCents),
  };
}

/**
 * Org-scoped statement detail (requireRole("manager") at the route). Returns the
 * owner-statement Invoice + its child Charge lines + the statement-level
 * attachmentKeys. A cross-org / unknown / non-owner-statement id → 404 (never
 * leak existence).
 */
export async function getStatementService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  return { ok: true as const, status: 200, data: mapStatement(inv) };
}

/**
 * SHARED in-tx helper for the two "append a Charge to an owner statement" paths
 * (addStatementLineService for drafts, addAdjustmentLineService for approved/sent).
 * Allocates the next contiguous chargeNumber, creates the Charge (status "draft"
 * to match the generate path's child-Charge lifecycle; partyId = owner; billingMonth
 * = the invoice period), then recomputes & persists Invoice.totalAmount/sstAmount
 * over the AUTHORITATIVE in-tx charge set (a concurrent edit/void between the
 * caller's pre-read and here is reflected; empty in-tx re-read falls back to the
 * pre-read snapshot + the just-added line). Returns the created Charge AND the fresh
 * Invoice so each caller can write its OWN audit row (different action name) and map
 * the result. The audit deliberately lives in the caller, not here.
 */
async function insertStatementChargeAndRecompute(
  tx: Prisma.TransactionClient,
  orgId: string,
  inv: DbInvoice,
  input: StatementLineInput,
  sstRateByUnit: SstRateByUnit,
): Promise<{ charge: DbCharge; fresh: DbInvoice }> {
  // billingMonth from the invoice period (fallback: first-of-month "now" never
  // happens for an owner_statement — periodMonth is always set by generate).
  const billingMonth = inv.periodMonth ?? null;

  // R1: appending a statement line (add-line + adjust both funnel here) is a NEW
  // dated impact — reject it if the statement's owner-month is frozen, IN-TX and
  // BEFORE the charge write. No-op when the flag is off or the period is open.
  if (billingMonth) {
    await assertPeriodOpen(tx, orgId, inv.ownerPartyId ?? inv.partyId, billingMonth);
  }

  // Allocate a contiguous chargeNumber suffix for this statement's lines, reusing
  // the same per-org per-prefix counter the generate path uses.
  const chargePrefix = `OSC-${invoiceChargePrefix(inv)}-`;
  const seq = (await countChargesWithPrefix(tx, orgId, chargePrefix)) + 1;

  const charge = await createLineCharge(tx, {
    organizationId: orgId,
    chargeNumber: `${chargePrefix}${String(seq).padStart(4, "0")}`,
    partyId: inv.ownerPartyId ?? inv.partyId, // bill-to = owner
    chargeType: input.chargeType,
    status: "draft",
    description: input.description,
    dueDate: billingMonth ?? new Date(),
    ...(billingMonth ? { billingMonth } : {}),
    amount: input.amount,
    outstandingAmount: input.amount,
    currency: inv.currency,
    invoiceId: inv.id,
    attachmentKeys: [],
    // Paid-on-behalf metadata (Task 9) — DISPLAY-ONLY, optional. Persisted on the
    // Charge so owner-ledger.sync (source-2) can copy it onto the OwnerLedgerEntry
    // and the statement/receipt can document "KAEN paid <payee> on your behalf".
    // Parsed as a calendar date (no TZ shift) for the @db.Date column.
    ...(input.payeeName ? { payeeName: input.payeeName } : {}),
    ...(input.paidOnBehalfRef ? { paidOnBehalfRef: input.paidOnBehalfRef } : {}),
    ...(input.paidOnBehalfDate
      ? { paidOnBehalfDate: new Date(`${input.paidOnBehalfDate}T00:00:00.000Z`) }
      : {}),
  });

  // Recompute over the AUTHORITATIVE in-tx charge set, not the pre-read snapshot.
  const inTx = await findInvoiceByIdInTx(tx, orgId, inv.id);
  const recomputeOn: DbInvoice = inTx ?? { ...inv, charges: [...inv.charges, charge] };
  const totals = recomputeTotals(recomputeOn, sstRateByUnit);
  const fresh = await updateStatementTotals(tx, orgId, inv.id, totals);
  return { charge, fresh };
}

/**
 * Add a child Charge line to a DRAFT owner statement (requireRole("admin")).
 * Pre-reads the statement org-scoped (404 cross-org). Adding to a NON-draft
 * invoice → 409 (the statement is locked once approved/sent). Otherwise creates
 * a Charge (chargeType/description/amount from the body; billingMonth from the
 * invoice period; partyId = ownerPartyId; invoiceId; org-scoped; status "draft" to
 * match the generate path's child-Charge lifecycle) then recomputes & persists
 * Invoice.totalAmount. Audit + writes land in ONE tx.
 */
export async function addStatementLineService(
  ctx: OwnerBillingActorCtx,
  id: string,
  input: StatementLineInput,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status !== "draft") return { ok: false as const, status: 409, error: NOT_DRAFT };

  // Per-unit SST rates (for recomputing the surviving mgmt-fee SST). Resolved
  // outside the write tx — the owner's configs/units are independent of the line
  // being added; the in-tx re-read inside the helper supplies the authoritative
  // sibling amounts.
  const sstRateByUnit = await resolveSstRatesForStatement(ctx.orgId, inv);

  const updated = await withTransaction(async (tx) => {
    const { charge, fresh } = await insertStatementChargeAndRecompute(
      tx,
      ctx.orgId,
      inv,
      input,
      sstRateByUnit,
    );
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.statement.line.add",
      entityType: "Charge",
      entityId: charge.id,
      diff: {
        after: {
          chargeType: input.chargeType,
          description: input.description,
          amount: input.amount,
          ...(input.payeeName ? { payeeName: input.payeeName } : {}),
          ...(input.paidOnBehalfRef ? { paidOnBehalfRef: input.paidOnBehalfRef } : {}),
          ...(input.paidOnBehalfDate ? { paidOnBehalfDate: input.paidOnBehalfDate } : {}),
        },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return fresh;
  });

  return { ok: true as const, status: 200, data: mapStatement(updated) };
}

const STATEMENT_NOT_ADJUSTABLE =
  "Statement is paid or void — no adjustments allowed";

/**
 * Append an ad-hoc ADJUSTMENT Charge to a NON-terminal owner statement
 * (requireRole("admin")) WITHOUT changing its status. Unlike addStatementLineService
 * (which is draft-only), this is the explicit, audited path for adding a charge
 * (e.g. fire insurance paid on behalf) to an ALREADY-approved (or sent) statement:
 * un-approving would hide the statement from the owner portal (the owner sees it at
 * status `approved`), so the status is deliberately PRESERVED here.
 *
 * Gate: a `paid` or `void` statement is terminal → 409 STATEMENT_NOT_ADJUSTABLE.
 * Any other state (draft / approved / sent) is adjustable (an adjustment on a draft
 * is harmless — addStatementLine is the ordinary draft path; the gate is purely
 * "not paid/void"). Cross-org / unknown id → 404.
 *
 * Flow: org-scoped pre-read → in ONE tx, insert the Charge + recompute totals via
 * the SHARED insertStatementChargeAndRecompute helper + audit
 * `owner-billing.statement.adjust`. AFTER the tx commits (mirrors the generate path
 * and approve): re-sync the owner ledger for the new charge so the appended expense
 * books an OwnerLedgerEntry (and the net payout deducts it), THEN regenerate the
 * statement PDF so the owner's soft-copy reflects the adjustment. Both follow-ons are
 * non-fatal (the ledger hook swallows its own errors + records a durable drift marker;
 * a PDF render hiccup is logged), so neither can roll back the committed adjustment.
 * Returns the updated statement (status unchanged). The owner money engine
 * (owner-ledger.sync / owner-net-payout) is CALLED, never modified.
 */
export async function addAdjustmentLineService(
  ctx: OwnerBillingActorCtx,
  id: string,
  input: StatementLineInput,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status === "paid" || inv.status === "void") {
    return { ok: false as const, status: 409, error: STATEMENT_NOT_ADJUSTABLE };
  }

  // Per-unit SST rates for the surviving mgmt-fee SST recompute (resolved once,
  // outside the write tx — same precedence the generate path used).
  const sstRateByUnit = await resolveSstRatesForStatement(ctx.orgId, inv);

  const updated = await withTransaction(async (tx) => {
    const { charge, fresh } = await insertStatementChargeAndRecompute(
      tx,
      ctx.orgId,
      inv,
      input,
      sstRateByUnit,
    );
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.statement.adjust",
      entityType: "Charge",
      entityId: charge.id,
      diff: {
        after: {
          chargeType: input.chargeType,
          description: input.description,
          amount: input.amount,
          ...(input.payeeName ? { payeeName: input.payeeName } : {}),
          ...(input.paidOnBehalfRef ? { paidOnBehalfRef: input.paidOnBehalfRef } : {}),
          ...(input.paidOnBehalfDate ? { paidOnBehalfDate: input.paidOnBehalfDate } : {}),
        },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return fresh;
  });

  // AFTER the write tx commits (mirrors generateStatementService :744 + approve):
  // re-sync the owner ledger so the appended adjustment books its OwnerLedgerEntry.
  // The adjustment Charge may carry NO unitId (the body is just
  // {chargeType,description,amount}), so syncOwnerLedgerForCharges — which discovers
  // the (owner, month) pair via charge.unit.ownerPartyId — would skip it. We have the
  // owner + period directly from the pre-read invoice, so sync the owner-month
  // explicitly. The hook is ENABLE_PHASE2_OWNER_BILLING-gated, opens its own tx, and
  // SWALLOWS its errors (durable drift marker on failure) — it can never roll back or
  // break the committed adjustment. Source-2 of the sync books EVERY non-void
  // owner_statement child Charge, so the new line is materialised (and the net payout
  // deducts it). Defensive guard: a non-terminal owner_statement always has both.
  if (inv.ownerPartyId !== null && inv.periodMonth !== null) {
    await syncOwnerLedgerForOwnerMonth(
      ctx.orgId,
      ctx.actorUserId,
      ctx.actorRole,
      inv.ownerPartyId,
      inv.periodMonth,
    );
  }

  // Keep the published soft-copy in lockstep: the owner can see the (still-approved)
  // statement, so the PDF must reflect the new line. Non-fatal on render failure —
  // the adjustment already committed (matches approveStatementService).
  const pdf = await regenerateStatementPdf(ctx, id);
  if (!pdf.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[owner-billing] adjust: PDF regenerate failed for ${id} (status ${pdf.status})`);
  }

  // Re-read so the returned statement carries the fresh pdfKey (regenerate persisted
  // it AFTER the totals-recompute tx above).
  const final = await findStatementById(ctx.orgId, id);
  return { ok: true as const, status: 200, data: mapStatement(final ?? updated) };
}

/**
 * Edit a DRAFT statement line's amount/description (requireRole("admin")) with
 * optimistic concurrency on the Charge. Pre-reads the statement (404 cross-org)
 * + the line (404 not-on-statement). A NON-draft statement → 409 before any
 * write. A stale expectedUpdatedAt makes updateLineChargeGuarded throw
 * StaleUpdateError → 409 with the EXACT "Record changed — reloaded" body; the tx
 * (write + recompute + audit) unwinds. On success recomputes & persists totals.
 */
export async function updateStatementLineService(
  ctx: OwnerBillingActorCtx,
  id: string,
  chargeId: string,
  patch: StatementLinePatchInput,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status !== "draft") return { ok: false as const, status: 409, error: NOT_DRAFT };
  if (!inv.charges.some((ch) => ch.id === chargeId)) {
    return { ok: false as const, status: 404, error: LINE_NOT_FOUND };
  }

  const { expectedUpdatedAt, ...fields } = patch;
  const data: Prisma.ChargeUncheckedUpdateManyInput = {
    ...(fields.amount !== undefined ? { amount: fields.amount, outstandingAmount: fields.amount } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
  };

  // Per-unit SST rates for the surviving mgmt-fee SST recompute (resolved once).
  const sstRateByUnit = await resolveSstRatesForStatement(ctx.orgId, inv);

  try {
    const updated = await withTransaction(async (tx) => {
      // R1: editing a line's amount/description is an ECONOMIC edit — reject it if
      // the statement's owner-month is frozen, IN-TX and BEFORE the write. Voiding
      // a line is a distinct, always-allowed path (voidStatementLineService is
      // intentionally NOT guarded). No-op when the flag is off or the period is open.
      if (inv.periodMonth) {
        await assertPeriodOpen(tx, ctx.orgId, inv.ownerPartyId ?? inv.partyId, inv.periodMonth);
      }
      const before = await findChargeInStatement(tx, ctx.orgId, inv.id, chargeId);
      if (!before) throw new StaleUpdateError();
      const row = await updateLineChargeGuarded(tx, ctx.orgId, inv.id, chargeId, expectedUpdatedAt, data);
      // Recompute reflecting the NEW amount of the edited line. If the edited line
      // is itself a mgmt-fee line, its SST re-derives from the new base.
      const totals = recomputeTotals(inv, sstRateByUnit, { chargeId, amount: row.amount.toString() });
      const fresh = await updateStatementTotals(tx, ctx.orgId, inv.id, totals);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.line.update",
        entityType: "Charge",
        entityId: chargeId,
        diff: {
          before: { amount: before.amount.toString(), description: before.description },
          after: { amount: row.amount.toString(), description: row.description },
        } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return fresh;
    });
    return { ok: true as const, status: 200, data: mapStatement(updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

/**
 * Returns the DISTINCT chargeIds (of `chargeIds`) that carry at least one
 * ACTIVE charge-adjustment note — credit_note or debit_note, documentStatus
 * ∈ ACTIVE_ADJUSTMENT_NOTE_STATUSES. ONE batched `findMany` — never one query
 * per charge. Presence, not net delta: a statement CN is always a full-line
 * reversal (see STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT above), so mutual
 * exclusion is enforced by "does an active note exist on this charge", not by
 * the note's amount.
 */
async function chargesWithActiveAdjustment(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<string[]> {
  if (chargeIds.length === 0) return [];
  const rows = await client.billingDocumentLine.findMany({
    where: {
      chargeId: { in: chargeIds },
      document: {
        organizationId: orgId,
        // A PRIMARY bill for a pay_back_landlord category is itself minted
        // `docType: "debit_note"` (seed-categories.ts), so docType alone would
        // read a charge's own bill as "this charge has an active adjustment
        // note". `originalDocumentId` is the discriminator: a note references
        // what it adjusts, a primary bill references nothing.
        //
        // Owner-statement charges mint IVOWN `invoice` docs, so this gate was
        // never wrong in practice — the clause keeps it from becoming wrong.
        // NOTE: the two netting helpers (net-adjustments-by-charge.ts,
        // adjustment-sums.ts) have the SAME hole and it is genuinely live there.
        // Their fix is branch `worktree-adjustment-money-fixes` / PR #161 —
        // deliberately not duplicated here.
        originalDocumentId: { not: null },
        docType: { in: ["credit_note", "debit_note"] },
        documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
      },
    },
    select: { chargeId: true },
    distinct: ["chargeId"],
  });
  return rows.map((r) => r.chargeId).filter((id): id is string => id !== null);
}

/**
 * Void a statement line (requireRole("admin")) — Charge.status → "void". Allowed
 * even AFTER the statement is approved (the only line mutation that is). Pre-reads
 * the statement (404 cross-org) + the line (404 not-on-statement), then rejects
 * (409 STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT) if the target charge already carries
 * an active charge-adjustment note (seam #3, Option B — see the error const doc).
 * On success recomputes & persists totals EXCLUDING the now-voided line. Writes +
 * audit in ONE tx.
 */
export async function voidStatementLineService(
  ctx: OwnerBillingActorCtx,
  id: string,
  chargeId: string,
  body?: { reason?: string },
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (!inv.charges.some((ch) => ch.id === chargeId)) {
    return { ok: false as const, status: 404, error: LINE_NOT_FOUND };
  }
  if ((await chargesWithActiveAdjustment(getDb(), ctx.orgId, [chargeId])).length > 0) {
    return { ok: false as const, status: 409, error: STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT };
  }

  // Per-unit SST rates for the surviving mgmt-fee SST recompute (resolved once).
  // Voiding a mgmt-fee line drops it from the surviving set, so its SST is
  // excluded from sstAmount here — no stranded SST in the statement total.
  const sstRateByUnit = await resolveSstRatesForStatement(ctx.orgId, inv);

  const updated = await withTransaction(async (tx) => {
    const before = await findChargeInStatement(tx, ctx.orgId, inv.id, chargeId);
    if (!before) throw new StaleUpdateError();
    const row = await voidLineCharge(tx, ctx.orgId, inv.id, chargeId);
    // Spec §4.3: income line (on the IVOWN doc) → PARTIAL CN against that doc;
    // pass-through line (not on the doc) → ledger re-sync only (helper no-ops).
    if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
      await issueStatementCreditNoteTx(tx, ctx, inv.id, {
        onlyChargeId: chargeId,
        reason: body?.reason ?? "Statement line voided",
        idempotencyKey: `cn:line-void:${chargeId}`,
      });
    }
    // Recompute excluding the now-voided line (base AND, for a mgmt-fee line, SST).
    const totals = recomputeTotals(inv, sstRateByUnit, { chargeId, status: "void" });
    const fresh = await updateStatementTotals(tx, ctx.orgId, inv.id, totals);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.statement.line.void",
      entityType: "Charge",
      entityId: chargeId,
      meta: { previousStatus: before.status, status: row.status },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return fresh;
  });
  // Post-commit, flag-independent (spec §4.5): reverse-sync clears the
  // pass-through ledger rows this statement booked. Never throws.
  if (inv.ownerPartyId && inv.periodMonth) {
    await syncOwnerLedgerForOwnerMonth(ctx.orgId, ctx.actorUserId, ctx.actorRole, inv.ownerPartyId, inv.periodMonth);
  }
  return { ok: true as const, status: 200, data: mapStatement(updated) };
}

/**
 * Per-statement chargeNumber prefix segment. Derived from the invoiceNumber
 * (which the generate path builds as `OS-<YYYYMM>-<owner8>`) so manually-added
 * lines share the same `OSC-<YYYYMM>-<owner8>-` run as the auto-generated lines.
 */
function invoiceChargePrefix(inv: DbInvoice): string {
  // invoiceNumber === `OS-${YYYYMM}-${owner8}` → strip the leading "OS-".
  return inv.invoiceNumber.replace(/^OS-/, "");
}

// ─── Owner statement status transitions — approve / void / send (C8) ─────────
//
// The owner-statement lifecycle is draft → approved → sent → paid | void. C8
// implements the three operator-driven transitions:
//   • approve (manager+): draft → approved
//   • void   (admin):     any non-paid → void
//   • send   (manager+):  approved (WITH a pdfKey) → sent, surfacing the soft copy
//
// SOFT-COPY ONLY: send NEVER auto-delivers (no email / WhatsApp / etc.). It flips
// the status and hands back a short-lived signed download URL for the PDF the
// admin can forward manually. The generate path only ever yields a DRAFT — nothing
// here is reachable automatically.
//
// Every transition: org-scoped pre-read (cross-org / unknown → 404), legal-state
// check on the CURRENT status (illegal → 409 / 400), then the updatedAt-in-WHERE
// guarded write + in-tx audit. A stale concurrency token → StaleUpdateError → 409
// with the EXACT "Record changed — reloaded" body (the whole tx unwinds).

const STATEMENT_NOT_APPROVABLE =
  "Statement can no longer be approved — a unit statement must be First Checked first";
const STATEMENT_NOT_FIRST_CHECKABLE =
  "Statement can no longer be First Checked — only a draft statement may be checked";
const STATEMENT_NOT_VOIDABLE =
  "Statement can no longer be voided — a paid or already-voided statement cannot be voided";
const STATEMENT_NOT_SENDABLE =
  "Statement must be approved before it can be sent";
const STATEMENT_NO_PDF =
  "Generate the statement PDF before sending";

function moneyNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getStatementApprovalPreflightService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerPayoutApprovalPreflight>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };

  return buildStatementApprovalPreflight(ctx, inv);
}

async function buildStatementApprovalPreflight(
  ctx: OwnerBillingActorCtx,
  inv: DbInvoice,
): Promise<OwnerBillingServiceResult<OwnerPayoutApprovalPreflight>> {
  const id = inv.id;
  const sections = await assembleYannieStatement(ctx, id);
  if (!sections) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };

  const checks: OwnerPayoutSafetyCheck[] = [];
  const bankMissing = [
    sections.header.bankName ? null : "bank name",
    sections.header.accountHolder ? null : "bank account holder",
    sections.header.accountNumberMasked ? null : "bank account number",
  ].filter((part): part is string => part != null);
  checks.push(bankMissing.length === 0 ? {
    code: "owner_bank_details",
    label: "Owner bank details",
    status: "pass",
    detail: "Bank name, account holder and account number are complete.",
    blocks: null,
  } : {
    code: "owner_bank_details",
    label: "Owner bank details",
    status: "block",
    detail: `Complete ${bankMissing.join(", ")} before final Approval.`,
    blocks: "approve",
  });

  const totalPayoutToOwner = sections.payoutSummary.lines.find(
    (line) => line.label === "Total Payout to Owner",
  )?.amount ?? sections.payoutSummary.netPayoutToOwner;
  const totalPayout = moneyNumber(totalPayoutToOwner);
  checks.push(totalPayout >= 0 ? {
    code: "non_negative_payout",
    label: "Payout amount",
    status: "pass",
    detail: `Total cash payout to the owner is RM ${totalPayoutToOwner}, including any deposit collected for onward transfer.`,
    blocks: null,
  } : {
    code: "non_negative_payout",
    label: "Payout amount",
    status: "block",
    detail: `Owner Payout is negative (RM ${totalPayoutToOwner}). Review charges and deductions.`,
    blocks: "both",
  });

  const depositHeld = moneyNumber(sections.payoutSummary.depositHeld);
  checks.push(depositHeld === 0 ? {
    code: "deposit_custody",
    label: "Deposit custody",
    status: "pass",
    detail: "No tenant deposit is recorded as held by KAEN.",
    blocks: null,
  } : {
    code: "deposit_custody",
    label: "Deposit custody",
    status: "block",
    detail: `RM ${sections.payoutSummary.depositHeld} is still recorded as held by KAEN. Deposits must be transferred to the owner before payout approval.`,
    blocks: "both",
  });

  const collectedRentUnitCodes = new Set(
    sections.incomeBreakdown.rows
      .filter((row) => (row.incomeType === "Monthly" || row.incomeType === "Prorate") && moneyNumber(row.amount) > 0)
      .map((row) => row.unitCode),
  );
  const month = inv.periodMonth?.toISOString().slice(0, 7) ?? null;
  let missingFeeUnits: string[] = [];
  if (inv.ownerPartyId && month && collectedRentUnitCodes.size > 0) {
    const firstOfMonth = new Date(`${month}-01T00:00:00.000Z`);
    const [configs, units] = await Promise.all([
      findFeeConfigsForOwner(ctx.orgId, inv.ownerPartyId),
      resolveOwnerUnitsForMonth(ctx.orgId, inv.ownerPartyId, firstOfMonth),
    ]);
    missingFeeUnits = units
      .filter((unit) => collectedRentUnitCodes.has(unit.unitCode))
      .filter((unit) => resolveConfigForUnit(configs, unit, firstOfMonth) == null)
      .map((unit) => unit.unitCode);
  }
  checks.push(missingFeeUnits.length === 0 ? {
    code: "management_fee_config",
    label: "Management Fee coverage",
    status: "pass",
    detail: collectedRentUnitCodes.size > 0
      ? "Every unit with collected rent has an applicable Management Fee setting."
      : "No collected rental income requires a Management Fee for this period.",
    blocks: null,
  } : {
    code: "management_fee_config",
    label: "Management Fee coverage",
    status: "block",
    detail: `Missing an applicable Management Fee setting for: ${missingFeeUnits.join(", ")}.`,
    blocks: "both",
  });

  const canFirstCheck = !checks.some((check) => check.status === "block" && (check.blocks === "first_check" || check.blocks === "both"));
  const canApprove = !checks.some((check) => check.status === "block" && (check.blocks === "approve" || check.blocks === "both"));
  return {
    ok: true as const,
    status: 200,
    data: {
      statementId: id,
      canFirstCheck,
      canApprove,
      totalPayoutToOwner,
      netPayoutToOwner: sections.payoutSummary.netPayoutToOwner,
      checks,
    },
  };
}

function preflightBlockMessage(preflight: OwnerPayoutApprovalPreflight, stage: "first_check" | "approve"): string | null {
  const blocked = preflight.checks.filter((check) =>
    check.status === "block" && (check.blocks === stage || check.blocks === "both"),
  );
  return blocked.length > 0
    ? `Owner Payout safety check failed: ${blocked.map((check) => check.detail).join(" ")}`
    : null;
}

/**
 * Approve an owner statement (requireRole("manager") at the route). ONLY a draft
 * statement may be approved; any other state → 409 (idempotent re-approve is not
 * a no-op — it is a conflict). Org-scoped pre-read (404 cross-org / unknown). The
 * guarded transition (updatedAt-in-WHERE) + audit land in ONE tx; a stale token →
 * 409 with the EXACT stale message. Audit: owner-billing.statement.approve.
 */
export async function firstCheckStatementService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status !== "draft") {
    return { ok: false as const, status: 409, error: STATEMENT_NOT_FIRST_CHECKABLE };
  }
  const preflightResult = await buildStatementApprovalPreflight(ctx, inv);
  if (!preflightResult.ok) return preflightResult;
  const preflightError = preflightBlockMessage(preflightResult.data, "first_check");
  if (preflightError) return { ok: false as const, status: 409, error: preflightError };
  try {
    const checked = await withTransaction(async (tx) => {
      const row = await transitionStatementStatusGuarded(
        tx, ctx.orgId, id, inv.updatedAt.toISOString(), "first_checked",
      );
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.first-check",
        entityType: "Invoice",
        entityId: id,
        meta: { previousStatus: inv.status, status: "first_checked" },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 200, data: mapStatement(checked) };
  } catch (err) {
    if (err instanceof StaleUpdateError) return { ok: false as const, status: 409, error: STALE };
    throw err;
  }
}

export async function approveStatementService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status !== (inv.apartmentId ? "first_checked" : "draft")) {
    return { ok: false as const, status: 409, error: STATEMENT_NOT_APPROVABLE };
  }
  const preflightResult = await buildStatementApprovalPreflight(ctx, inv);
  if (!preflightResult.ok) return preflightResult;
  const preflightError = preflightBlockMessage(preflightResult.data, "approve");
  if (preflightError) return { ok: false as const, status: 409, error: preflightError };

  // redesign P1 — OST- statement display number, minted ONCE at approval (the
  // statement is LOCKED after approval — approval is the stable, non-regenerable
  // mint point; a draft that gets regenerated never reaches this function at
  // all, so it can never burn a number). Gated on the flag AND idempotent: a
  // row that already carries a statementNumber (defense-in-depth — the status
  // guard above already blocks any real re-approve attempt) is never re-minted.
  // ensureChargeCategorySeeds runs on its OWN connection BEFORE the tx (same
  // lazy-ensure convention as expenses.service.ts's EXP mint) — skipped
  // entirely when there is nothing to mint.
  const shouldMintOst = isPhase2FlagEnabled("ENABLE_OWNER_DOC_NUMBERING") && !inv.statementNumber;
  if (shouldMintOst) {
    await ensureChargeCategorySeeds(ctx.orgId);
  }

  let approved: DbInvoice;
  try {
    approved = await withTransaction(async (tx) => {
      // Stamp the first-class approval-provenance columns in the SAME guarded
      // write as the status flip (mirrors commissions' approve idiom). Without
      // this Invoice.approvedBy/approvedAt stay permanently null after a real
      // approval — the in-tx audit captures actor+ts, but downstream consumers
      // (owner-portal / statement PDF "Approved by X on Y") read these columns.
      const approvedAt = new Date();
      const extraData: Prisma.InvoiceUpdateManyMutationInput = {
        approvedBy: ctx.actorUserId,
        approvedAt,
      };
      if (shouldMintOst) {
        const series = await findDocumentSeriesInTx(tx, ctx.orgId, "OST");
        if (series) {
          // mintDocumentNumberTx MUST run inside THIS transaction — its own
          // contract: a rollback (e.g. a losing StaleUpdateError race below)
          // burns nothing, no gap. Same `now` instant as approvedAt above.
          extraData.statementNumber = await mintDocumentNumberTx(tx, ctx.orgId, series, approvedAt);
        } else {
          // Non-fatal: the series is expected to always exist after
          // ensureChargeCategorySeeds above — this is defense-in-depth, not a
          // reachable path in practice. Mirrors this same function's own
          // established fault-tolerance idiom for a non-critical side effect
          // (the PDF-regenerate failure below is also a warn, never a throw):
          // the approve transition itself must never fail because of the
          // display-number side effect.
          // eslint-disable-next-line no-console
          console.warn(`[owner-billing] approve: OST series not found for org ${ctx.orgId} — approved without a number`);
        }
      }
      const row = await transitionStatementStatusGuarded(
        tx,
        ctx.orgId,
        id,
        inv.updatedAt.toISOString(),
        "approved",
        extraData,
      );
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.approve",
        entityType: "Invoice",
        entityId: id,
        meta: { previousStatus: inv.status, status: "approved" },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }

  // Keep the published PDF in lockstep with approval: the owner sees the statement
  // the moment it is approved, so the soft-copy must match the approved figures.
  try {
    const pdf = await regenerateStatementPdf(ctx, id);
    if (!pdf.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[owner-billing] approve: PDF regenerate failed for ${id} (status ${pdf.status})`);
    }
  } catch (error) {
    // Approval is already committed. A renderer/storage failure must not make the
    // client retry the financial approval and mistake it for a failed transition.
    // eslint-disable-next-line no-console
    console.warn(`[owner-billing] approve: PDF regenerate threw for ${id}`, error);
  }
  return { ok: true as const, status: 200, data: mapStatement(approved) };
}

/**
 * Issue the CN that reverses a statement's IVOWN invoice document (spec §4.3).
 * Full void → all lines; line void → the one line. Returns null when the
 * statement has no IVOWN doc (pre-cutover) — plain void semantics apply, and
 * also when the only-charge requested isn't an IVOWN line (a pass-through
 * line, e.g. tnb/wifi/sewerage, which never had a document — ledger re-sync
 * only). Runs INSIDE the caller's tx.
 *
 * On a FULL reversal the original IVOWN doc is marked `offset` AND its
 * idempotencyKey is released (set to null) in the SAME update — mirroring
 * releaseVoidedStatementSlotsInTx's release-on-void pattern for the statement
 * Invoice itself (BillingDocument.idempotencyKey has the same
 * `@@unique([organizationId, idempotencyKey])` + Postgres-NULLs-distinct
 * shape as Invoice). Without this release, a subsequent void→regenerate cycle
 * would replay the SAME "ivown:"+statement-idempotencyKey into
 * issueStatementIvownDocumentTx → issueDocumentTx's dedupe lookup (which
 * matches on idempotencyKey alone, with NO status filter) and hand the
 * regenerated statement a reference to THIS offset/voided document instead of
 * minting a fresh one (see issueStatementIvownDocumentTx's "Plan 3 note").
 * A PARTIAL reversal (line void) leaves the IVOWN doc `issued` and its
 * idempotencyKey untouched — there is nothing to regenerate.
 */
async function issueStatementCreditNoteTx(
  tx: Prisma.TransactionClient,
  ctx: OwnerBillingActorCtx,
  statementId: string,
  opts: { onlyChargeId?: string; reason: string; idempotencyKey: string },
): Promise<{ creditNoteId: string; creditNoteNumber: string } | null> {
  const ivown = await tx.billingDocument.findFirst({
    where: {
      organizationId: ctx.orgId,
      statementInvoiceId: statementId,
      docType: "invoice",
      status: { not: "offset" },
    },
    select: {
      id: true,
      partyId: true,
      propertyId: true,
      apartmentId: true,
      listingId: true,
      billingMonth: true,
      lines: {
        select: { chargeId: true, categoryId: true, description: true, amount: true, sstRate: true },
      },
    },
  });
  if (!ivown) return null;
  const lines = (
    opts.onlyChargeId ? ivown.lines.filter((l) => l.chargeId === opts.onlyChargeId) : ivown.lines
  ).map((l) => ({
    // IVOWN lines are always fully populated (real chargeId+categoryId; R12a's
    // nullable widening is for overpayment-CN lines, which never appear on an
    // IVOWN document) — `?? undefined` only satisfies IssueLineInput's optional
    // (not nullable) typing.
    chargeId: l.chargeId ?? undefined,
    categoryId: l.categoryId ?? undefined,
    description: `Reversal: ${l.description}`,
    amount: l.amount.toString(),
    sstRate: l.sstRate.toString(),
  }));
  if (lines.length === 0) return null; // pass-through line: not on the IVOWN doc → ledger re-sync only
  const cn = await issueDocumentTx(tx, {
    organizationId: ctx.orgId,
    docType: "credit_note",
    seriesCode: "CN",
    counterpartyType: "owner",
    partyId: ivown.partyId,
    propertyId: ivown.propertyId ?? undefined,
    apartmentId: ivown.apartmentId ?? undefined,
    listingId: ivown.listingId ?? undefined,
    billingMonth: ivown.billingMonth ? ivown.billingMonth.toISOString().slice(0, 10) : undefined,
    originalDocumentId: ivown.id,
    statementInvoiceId: statementId,
    reason: opts.reason,
    idempotencyKey: opts.idempotencyKey,
    lines,
    actorUserId: ctx.actorUserId,
  });
  if (!opts.onlyChargeId) {
    await tx.billingDocument.update({
      where: { id: ivown.id },
      data: { status: "offset", idempotencyKey: null },
    });
  }
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "billing-docs.credit_note.issue",
    entityType: "BillingDocument",
    entityId: cn.id,
    meta: {
      originalDocumentId: ivown.id,
      statementInvoiceId: statementId,
      onlyChargeId: opts.onlyChargeId ?? null,
      creditNoteNumber: cn.documentNumber,
      reason: opts.reason,
    } as unknown as Prisma.InputJsonValue,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { creditNoteId: cn.id, creditNoteNumber: cn.documentNumber };
}

/**
 * Void an owner statement (requireRole("admin") at the route). Allowed from ANY
 * non-paid state (draft / approved / sent) — a paid or already-voided statement →
 * 409. Org-scoped pre-read (404 cross-org / unknown). The guarded transition
 * (updatedAt-in-WHERE) + audit land in ONE tx; a stale token → 409 with the EXACT
 * stale message. Audit: owner-billing.statement.void. (Child line Charges are left
 * as-is — the statement-level void is the terminal billing state; line voids stay
 * the C5 path's concern.)
 *
 * Spec §4.3: while ENABLE_PHASE2_BILLING_DOCS is on, the void ALSO issues a CN
 * against the statement's IVOWN document (full reversal — mgmt fee + SST +
 * cleaning), in the SAME tx as the status transition. Post-commit (spec §4.5,
 * flag-independent at the call site — syncOwnerLedgerForOwnerMonth internally
 * gates on ENABLE_PHASE2_OWNER_BILLING and never throws), the owner-month
 * ledger is re-synced so the pass-through rows this statement booked clear.
 */
export async function voidStatementService(
  ctx: OwnerBillingActorCtx,
  id: string,
  body?: { reason?: string },
): Promise<OwnerBillingServiceResult<OwnerStatementRow>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  // Any non-paid, non-void state may be voided. A paid statement is terminal; an
  // already-void statement has nothing to transition (both → 409).
  if (inv.status === "paid" || inv.status === "void") {
    return { ok: false as const, status: 409, error: STATEMENT_NOT_VOIDABLE };
  }
  // seam #3, Option B: reject the full void if ANY of the statement's charges
  // already carries an active charge-adjustment note (see
  // STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT's doc) — the full-line statement CN
  // this void would issue must not stack on top of one.
  if (
    (await chargesWithActiveAdjustment(getDb(), ctx.orgId, inv.charges.map((ch) => ch.id))).length > 0
  ) {
    return { ok: false as const, status: 409, error: STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await transitionStatementStatusGuarded(
        tx,
        ctx.orgId,
        id,
        inv.updatedAt.toISOString(),
        "void",
      );
      // Spec §4.3: statement keeps its void + regenerate mechanics, PLUS a CN
      // auto-issued against its IVOWN invoice document (reverses mgmt fee + SST
      // + cleaning income). Pre-cutover statements have no IVOWN doc → skip.
      if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
        await issueStatementCreditNoteTx(tx, ctx, id, {
          reason: body?.reason ?? "Statement voided",
          idempotencyKey: `cn:statement-void:${id}`,
        });
      }
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.void",
        entityType: "Invoice",
        entityId: id,
        meta: { previousStatus: inv.status, status: "void", reason: body?.reason ?? null },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    // Post-commit, flag-independent (spec §4.5): reverse-sync clears the
    // pass-through ledger rows this statement booked. Never throws.
    if (inv.ownerPartyId && inv.periodMonth) {
      await syncOwnerLedgerForOwnerMonth(ctx.orgId, ctx.actorUserId, ctx.actorRole, inv.ownerPartyId, inv.periodMonth);
    }
    return { ok: true as const, status: 200, data: mapStatement(updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

/**
 * Send an owner statement as a SOFT COPY (requireRole("manager") at the route).
 *
 * Preconditions, checked in order on the org-scoped pre-read (404 cross-org /
 * unknown):
 *   • status MUST be "approved" — a draft (or any non-approved state) → 409.
 *   • Invoice.pdfKey MUST be present — an approved statement with no PDF yet → 400
 *     (the PDF is produced separately in Phase D; you cannot send what was never
 *     rendered).
 *
 * NEVER auto-sends: this only flips status approved → sent and mints a short-lived
 * signed download URL (createSignedDownloadUrl over the pdfKey) for the admin to
 * forward manually. No email/WhatsApp/etc. is dispatched. The guarded transition
 * (updatedAt-in-WHERE) + audit land in ONE tx; a stale token → 409 with the EXACT
 * stale message. The signed URL is minted AFTER the successful transition (so a
 * 409/400 never leaks a URL). Audit: owner-billing.statement.send.
 */
export async function sendStatementService(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerStatementSendResult>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  if (inv.status !== "approved") {
    return { ok: false as const, status: 409, error: STATEMENT_NOT_SENDABLE };
  }
  // Soft-copy send requires the rendered PDF to exist (Phase D). 400 = "generate
  // the PDF first" — a precondition the caller can fix, distinct from the 409
  // state conflict.
  const pdfKey = inv.pdfKey;
  if (pdfKey === null || pdfKey === undefined) {
    return { ok: false as const, status: 400, error: STATEMENT_NO_PDF };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await transitionStatementStatusGuarded(
        tx,
        ctx.orgId,
        id,
        inv.updatedAt.toISOString(),
        "sent",
      );
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.statement.send",
        entityType: "Invoice",
        entityId: id,
        meta: { previousStatus: inv.status, status: "sent", pdfKey },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    // Mint the soft-copy download URL only after the transition committed.
    const downloadUrl = await createSignedDownloadUrl(pdfKey);
    return {
      ok: true as const,
      status: 200,
      data: { statement: mapStatement(updated), downloadUrl },
    };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

// ─── Statement PDF regenerate / download (D1) ───────────────────────────────

const STATEMENT_NO_OWNER =
  "Statement has no owner or billing period — cannot render the owner statement PDF";
const STATEMENT_PDF_NOT_GENERATED = "PDF not generated";

/** "YYYYMM" compact form of a first-of-month period Date, for the PDF object key. */
function periodCompact(periodMonth: Date): string {
  return `${periodMonth.getUTCFullYear()}${String(periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" form of a first-of-month period Date, for the collected-rent query. */
function periodMonthYYYYMM(periodMonth: Date): string {
  return `${periodMonth.getUTCFullYear()}-${String(periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Pure, side-effect-free renderer for an owner statement's CLEAN 5-section PDF
 * bytes — NO embedded receipts, NO appended bills. Assembles the shared
 * `YannieSections` (the SAME structured data as GET /statements/:id/sections and
 * the owner portal, so the soft copy can never drift from the on-screen figures)
 * → `buildYanniePdfHtml` → `renderToHtml` → `htmlToPdf`, and returns the PDF
 * Buffer.
 *
 * NO putObject / NO Invoice.pdfKey write / NO audit — this is the SINGLE source
 * of statement-PDF bytes, reused by `regenerateStatementPdf` AND the multi-month
 * export (no duplicate PDF logic, no side-effects in the export path). Throws if
 * the statement is missing or has no owner/period; callers pre-validate, so the
 * throw is a defensive guard, never the happy path.
 */
/**
 * LIVE sibling of `renderCleanStatementPdfBytes` — renders the same CLEAN
 * 5-section statement PDF for (owner, month[, apartment]) computed from the
 * posted ledger RIGHT NOW, with no issued Invoice required.
 *
 * This is a real-time snapshot on purpose: an unpaid tenant shows as unpaid,
 * because that is the point of an admin pulling the statement mid-month. It is
 * the PDF twin of GET /statements/live, and shares that endpoint's assembler, so
 * the bytes can never drift from the figures on screen.
 *
 * Deliberately stores NOTHING — no putObject, no pdfKey, no OwnerStatementPeriod
 * write. A stored copy of a live figure is stale the moment a payment lands, and
 * a render failure would leave a silently-missing file behind (exactly what the
 * freeze path's best-effort `pdfKey = null` does). Rendering on demand means the
 * bytes are always current and a failure surfaces as an error to the caller
 * instead of as an absent file discovered later.
 *
 * The owner-facing copy is a DIFFERENT artifact: it renders from the frozen
 * OwnerStatementPeriod snapshot after month-end and is final by construction.
 * Nothing here touches it.
 *
 * `referenceCode` is synthetic (`LIVE-<YYYYMM>`) — there is no invoiceNumber to
 * quote, and stamping a real one would imply this render is the issued document.
 */
/**
 * Read-through sync for the LIVE statement surfaces — the same T2' contract
 * GET /owner-ledger/entries has: materialise the (owner, month) ledger on-demand
 * so a live view shows current figures, swallowing failures so the page still
 * renders existing rows. Without this the live statement's ROWS could show
 * read-time-derived figures (CN/DN-adjusted chargedAmount) while its TOTALS
 * summed stale ledger amounts — the reported "rows say 683, total says 688".
 */
async function syncLedgerMonthForLiveView(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  billingMonth: string,
): Promise<void> {
  try {
    const r = await syncMonthService(
      { orgId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole },
      { ownerPartyId, month: billingMonth },
    );
    if (!r.ok) {
      console.error("[owner-billing] live-view read-through sync returned error (swallowed):", r.error);
    }
  } catch (e) {
    console.error("[owner-billing] live-view read-through sync failed (swallowed):", e);
  }
}

export async function renderLiveStatementPdfBytes(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  billingMonth: string,
  apartmentId: string | null,
): Promise<Buffer> {
  await syncLedgerMonthForLiveView(ctx, ownerPartyId, billingMonth);
  const [y, m] = billingMonth.split("-").map(Number);
  const periodMonth = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1));
  const sections = await assembleYannieStatementForMonth(
    ctx,
    ownerPartyId,
    periodMonth,
    apartmentId,
  );

  const template = await getTemplateForOrgDocType(ctx.orgId, "owner_statement");
  const bodyHtml = buildYanniePdfHtml(sections);
  const html = renderToHtml({
    template,
    referenceCode: `LIVE-${billingMonth.replace("-", "")}`,
    issuedDate: new Date(),
    bodyHtml,
  });
  return htmlToPdf(html);
}

export async function renderCleanStatementPdfBytes(
  ctx: OwnerBillingActorCtx,
  statementId: string,
): Promise<Buffer> {
  const inv = await findStatementById(ctx.orgId, statementId);
  if (!inv) throw new Error(`Owner statement not found: ${statementId}`);

  const sections = await assembleYannieStatement(ctx, statementId);
  if (!sections) throw new Error(`Owner statement has no owner/period: ${statementId}`);

  const template = await getTemplateForOrgDocType(ctx.orgId, "owner_statement");
  const bodyHtml = buildYanniePdfHtml(sections);
  const html = renderToHtml({
    template,
    referenceCode: inv.invoiceNumber,
    issuedDate: new Date(),
    bodyHtml,
  });
  return htmlToPdf(html);
}

/**
 * Regenerate an owner-statement PDF (requireRole("admin") at the route).
 *
 * Renders the CLEAN 5-section Yannie statement (header, occupancy, payout
 * summary, income + expense breakdowns) via `renderCleanStatementPdfBytes` — the
 * single source of statement-PDF bytes. Supporting bills/receipts are NOT folded
 * in here; they live in the per-expense bills + the separate proof pack.
 *
 * Stores the result at
 * "owner-statements/<ownerPartyId>/<YYYYMM>-<apt8|combined>.pdf": the apartment
 * segment (first 8 of Invoice.apartmentId, or "combined" for a legacy
 * owner-combined statement) keeps two apartment-scoped statements for the same
 * owner+month from COLLIDING on one object. The key stays deterministic per
 * (owner, month, apartment) so a re-render OVERWRITES in place (no orphan).
 * Persists Invoice.pdfKey in a transaction with an in-tx audit row. Returns the
 * pdfKey + a freshly-minted signed download URL.
 *
 * Org-scoped pre-read (cross-org / unknown / non-owner-statement id → 404; no
 * owner or billing period → 400). The render + Storage write happen BEFORE the
 * DB transaction (mirrors reservations' sign path); a failed transaction leaves
 * an orphan PDF blob (accepted — low volume, re-render overwrites at the same
 * key). Audit: owner-billing.statement.regeneratePdf.
 */
export async function regenerateStatementPdf(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<OwnerStatementPdfResult>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };

  const ownerPartyId = inv.ownerPartyId;
  const periodMonth = inv.periodMonth;
  if (ownerPartyId === null || periodMonth === null) {
    return { ok: false as const, status: 400, error: STATEMENT_NO_OWNER };
  }

  // Pre-flight 400 guard: a statement with no assemblable sections (no owner /
  // billing period) is a 400, never a 500. `renderCleanStatementPdfBytes`
  // re-derives the sections itself — it is self-contained so the multi-month
  // export can reuse it — so the extra read here is a cheap, admin-triggered cost
  // paid to keep the graceful 400 contract.
  const sections = await assembleYannieStatement(ctx, id);
  if (!sections) return { ok: false as const, status: 400, error: STATEMENT_NO_OWNER };

  // CLEAN statement bytes — the single source (no embedded receipts, no appended
  // bills). The pure renderer owns assemble → buildYanniePdfHtml → htmlToPdf.
  const pdfBuffer = await renderCleanStatementPdfBytes(ctx, id);

  const monthStr = periodMonthYYYYMM(periodMonth);
  // Apartment segment keeps per-apartment statements from colliding on one key;
  // a null apartmentId = legacy owner-combined → "combined".
  const aptSegment = inv.apartmentId ? inv.apartmentId.slice(0, 8) : "combined";
  const pdfKey = `owner-statements/${ownerPartyId}/${periodCompact(periodMonth)}-${aptSegment}.pdf`;
  // Capture the PRIOR stored key BEFORE the overwrite so the old object can be
  // cleaned up if the new key differs (a legacy "…/<YYYYMM>.pdf" object or a
  // future apartment re-scope) — see the no-orphan delete after the tx.
  const oldKey = inv.pdfKey;
  // Storage write before the tx (mirrors reservations' sign path). A re-render
  // overwrites the object at the same key (putObject upsert:true).
  await putObject(pdfKey, pdfBuffer, "application/pdf");

  await withTransaction(async (tx) => {
    await setStatementPdfKey(tx, ctx.orgId, inv.id, pdfKey);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "owner-billing.statement.regeneratePdf",
      entityType: "Invoice",
      entityId: inv.id,
      meta: { pdfKey, periodMonth: monthStr },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });

  // NO ORPHAN: when the new key differs from the prior stored key (a legacy
  // "…/<YYYYMM>.pdf" object or a future apartment re-scope), delete the OLD object
  // AFTER the tx commits. Best-effort — a failed delete must never fail the request
  // (the same idiom as detachExpenseProofService). A same-key regenerate
  // (oldKey === pdfKey) overwrote in place → nothing to delete, never self-orphan.
  if (oldKey && oldKey !== pdfKey) {
    try {
      await deleteObject(requireBucket(), oldKey);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[owner-billing] statement regenerate: best-effort delete failed for ${oldKey}`);
    }
  }

  const downloadUrl = await createSignedDownloadUrl(pdfKey);
  return { ok: true as const, status: 200, data: { pdfKey, downloadUrl } };
}

/**
 * Mint a signed download URL for an owner statement's already-generated PDF
 * (requireRole("manager") at the route). Org-scoped pre-read (cross-org / unknown
 * → 404). When Invoice.pdfKey is absent → 404 "PDF not generated" (the soft copy
 * must be regenerated first). No state change, no audit (a pure read).
 */
export async function getStatementPdfUrl(
  ctx: OwnerBillingActorCtx,
  id: string,
): Promise<OwnerBillingServiceResult<{ downloadUrl: string }>> {
  const inv = await findStatementById(ctx.orgId, id);
  if (!inv) return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  const pdfKey = inv.pdfKey;
  if (pdfKey === null || pdfKey === undefined) {
    return { ok: false as const, status: 404, error: STATEMENT_PDF_NOT_GENERATED };
  }
  const downloadUrl = await createSignedDownloadUrl(pdfKey);
  return { ok: true as const, status: 200, data: { downloadUrl } };
}

// ─── Cleaning bills — REMOVED 2026-08-17 ─────────────────────────────────────
//
// The manual cleaning-bill surface (create/patch/void + `resolveCleaningAmount`, which
// the owner-settings field that fed it and `listOwnerUnitsService`, the picker that only
// existed to bound that form's unit choice. Its automatic twin was already deleted on
// 2026-07-29 for double-billing the same apartment-month — see the CLEANING step of
// generateStatementService. This removes the other half.
//
// The bills grid is now the SINGLE cleaning issuer: bearer in the unit Setting drawer,
// amount in the Recurring editor, billed as chargeType "utility" / category
// cleaning_owner. Do NOT reintroduce a second issuer here — that is the bug this change
// and the 2026-07-29 one each removed half of.
//
// Pre-existing chargeType:"cleaning" Charges are UNTOUCHED and still render (they remain
// in issue.service.ts's IVOWN line query); only the create/patch/void path for them is gone.

// ─── Statement sections (2a-4/2a-5) ──────────────────────────────────────────

/**
 * Assemble the 5-section Yannie statement for a given statementId.
 * Delegates to assembleYannieStatement — the single source of truth shared by
 * the PDF renderer and this GET endpoint.
 */
export async function getStatementSectionsService(
  ctx: OwnerBillingActorCtx,
  statementId: string,
): Promise<OwnerBillingServiceResult<YannieSections>> {
  const sections = await assembleYannieStatement(ctx, statementId);
  if (!sections) {
    return { ok: false as const, status: 404, error: STATEMENT_NOT_FOUND };
  }
  return { ok: true as const, status: 200, data: sections };
}

/**
 * Assemble the 5-section Yannie statement LIVE from the posted ledger for an
 * (owner, month[, apartment]) — WITHOUT any owner_statement Invoice. Backs the
 * admin live-view (GET /owner-billing/statements/live): the admin sees the full
 * 5-section detail computed from the ledger BEFORE issuing. The numbers are
 * IDENTICAL to what a freshly-issued statement would show for the same month —
 * both funnel through assembleYannieStatementForMonth (the shared assembly body).
 * `billingMonth` is "YYYY-MM"; it is normalised to a first-of-month UTC Date.
 * Always 200 (an owner+month with no activity yields empty sections; the caller
 * decides whether to render them). Pure read — no Invoice is ever materialised.
 */
export async function getLiveStatementSectionsService(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  billingMonth: string,
  apartmentId: string | null,
): Promise<OwnerBillingServiceResult<YannieSections>> {
  await syncLedgerMonthForLiveView(ctx, ownerPartyId, billingMonth);
  const [y, m] = billingMonth.split("-").map(Number);
  const periodMonth = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1));
  const sections = await assembleYannieStatementForMonth(ctx, ownerPartyId, periodMonth, apartmentId);
  return { ok: true as const, status: 200, data: sections };
}
