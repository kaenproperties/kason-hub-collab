// apps/api/src/modules/billing-documents/issue.service.ts
//
// Transactional issuance core for the immutable BillingDocument layer
// (spec §4.2 mint-on-post). issueDocumentTx runs INSIDE the caller's
// transaction: the number is minted, the document + lines inserted, and a
// rollback burns nothing. Immutability contract: this module exposes NO
// update/delete for financial fields — corrections are new linked documents.

import type { DocumentSeries, Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import { centsToString, toCents, splitInclusiveSst, resolveDocumentClassification, resolveOwnerReferences, DEFAULT_SERIES_FOR_CLASSIFICATION, CLASSIFICATION_FOR_DEFAULT_SERIES } from "@kason/shared";
import type { CommercialPurpose, FundedBy, RevenueRecognition, SettlementRecipient } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { mintDocumentNumberTx } from "../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { resolveMgmtFeeSstRateByUnit } from "../owner-billing/owner-billing-sst-rate";

export type IssueLineInput = {
  /** Optional: overpayment-CN lines (R12a) settle no charge. */
  chargeId?: string;
  /** Optional: overpayment-CN lines (R12a) have no category. */
  categoryId?: string;
  description: string;
  /** 2-dp decimal string (base amount, pre-SST). */
  amount: string;
  /** Percent, e.g. "8" or "0". */
  sstRate: string;
  /**
   * Optional exact SST amount for an SST-inclusive source total. When absent,
   * SST is derived from amount × rate using the normal per-line rounding rule.
   * This lets a gross RM500.00 agreement fee remain exactly RM500.00 while its
   * tax fields state RM462.96 base + RM37.04 SST.
   */
  sstAmount?: string;
  /**
   * TAX line. Its `amount` IS the SST that a SIBLING base line already contributed via
   * that line's `sstRate` — it exists only so the tax has a Charge a payment can settle
   * (bills-grid `mintExpenseChargesTx`). It therefore contributes NOTHING to `subtotal`,
   * and its own `sstRate` is "0" so it contributes nothing to `sstAmount` either:
   * `total` on a document carrying tax lines is BYTE-IDENTICAL to one issued without
   * them. Without this flag the amount would be counted twice (once as the base line's
   * derived SST, once as this line's amount) and `total` would overstate the invoice.
   */
  isTax?: boolean;
};

export type IssueDocumentInput = {
  organizationId: string;
  docType: "invoice" | "debit_note" | "credit_note" | "refund_note" | "receipt" | "owner_expense_advice" | "proforma";
  /** Default: resolved via the first line's category. REQUIRED ("CN"/"RN") for credit/refund notes. */
  seriesCode?: string;
  counterpartyType: "tenant" | "owner";
  partyId: string;
  tenancyId?: string;
  propertyId?: string;
  apartmentId?: string;
  listingId?: string;
  /** Spec 1 rent-reclassification (Phase 1) — additive; persisted on the document. */
  commercialDocumentType?: string;
  ledgerTreatment?: string;
  principalOwnerId?: string;
  collectedOnBehalfOfOwnerId?: string;
  /** "YYYY-MM-01". */
  billingMonth?: string;
  originalDocumentId?: string;
  statementInvoiceId?: string;
  /** credit_note only: collected portion = spendable credit. */
  creditAmount?: string;
  reason?: string;
  idempotencyKey?: string;
  /** Proforma spec R3: set on a GRADUATED invoice → the proforma its lines came from.
   *  NEVER originalDocumentId — see BillingDocument.proformaDocumentId in schema.prisma. */
  proformaDocumentId?: string;
  lines: IssueLineInput[];
  actorUserId: string;
};

/** CN/RN issued without the LHDN "Original e-Invoice Reference Number". */
export class DocumentReferenceRequiredError extends Error {
  readonly code = "DOCUMENT_REFERENCE_REQUIRED";
  constructor(docType: string) {
    super(`DOCUMENT_REFERENCE_REQUIRED: ${docType} requires originalDocumentId`);
    this.name = "DocumentReferenceRequiredError";
  }
}

/**
 * Line SST in cents: round(amountCents × rate%).
 *
 * EXPORTED so charge-adjustment.service.ts can compute a note's tax with the exact
 * same rounding this function applies at mint. That note has to move its charge's
 * `-SST` sibling by precisely the tax the document declares — a second, independent
 * rounding there would drift a cent and leave the sibling permanently unpayable.
 */
export function lineSstCents(amount: string, sstRate: string): number {
  const rate = Number(sstRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round((toCents(amount, "issueDocumentTx.line") * rate) / 100);
}

export async function issueDocumentTx(
  tx: Prisma.TransactionClient,
  input: IssueDocumentInput,
): Promise<{ id: string; documentNumber: string }> {
  if (input.lines.length === 0) throw new Error("DOCUMENT_LINES_REQUIRED");

  const isNote = input.docType === "credit_note" || input.docType === "refund_note";
  if (isNote && !input.originalDocumentId) throw new DocumentReferenceRequiredError(input.docType);
  if (isNote && !input.seriesCode) throw new Error("SERIES_CODE_REQUIRED");

  // Idempotency dedupe — deterministic keys let auto-post re-runs return the
  // existing document instead of double-issuing.
  if (input.idempotencyKey) {
    const existing = await tx.billingDocument.findFirst({
      where: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
      select: { id: true, documentNumber: true },
    });
    if (existing) return existing;
  }

  // Resolve the series: explicit code wins; otherwise route via the first
  // line's category (spec §4.2 category-routed issuance).
  let series: DocumentSeries | null = null;
  if (input.seriesCode) {
    series = await tx.documentSeries.findFirst({
      where: { organizationId: input.organizationId, code: input.seriesCode },
    });
  } else {
    const category = await tx.chargeCategory.findFirst({
      where: { organizationId: input.organizationId, id: input.lines[0].categoryId },
      select: { seriesId: true },
    });
    if (!category) throw new Error("CATEGORY_NOT_FOUND");
    series = await tx.documentSeries.findFirst({
      where: { organizationId: input.organizationId, id: category.seriesId },
    });
  }
  if (!series) throw new Error("SERIES_NOT_FOUND");

  // Totals from lines — cent math only (no float drift).
  let subtotalCents = 0;
  let sstCents = 0;
  const lineRows = input.lines.map((l) => {
    const amountCents = toCents(l.amount, "issueDocumentTx.amount");
    const sst = l.sstAmount === undefined
      ? lineSstCents(l.amount, l.sstRate)
      : toCents(l.sstAmount, "issueDocumentTx.sstAmount");
    if (sst < 0) throw new Error("DOCUMENT_LINE_SST_MUST_NOT_BE_NEGATIVE");
    // A TAX line carries, as its amount, the SST its sibling base line already added
    // to `sstCents` via that line's rate. Counting it into subtotal too would put the
    // same money into `total` twice. Its own rate is "0", so `sstCents += sst` is a
    // no-op for it and every non-tax line keeps its exact pre-existing arithmetic.
    if (!l.isTax) subtotalCents += amountCents;
    sstCents += sst;
    return {
      chargeId: l.chargeId ?? null,
      categoryId: l.categoryId ?? null,
      description: l.description,
      amount: l.amount,
      sstRate: l.sstRate,
      sstAmount: centsToString(sst),
      // PERSIST the flag the subtotal decision above already made. It used to be
      // dropped here, leaving every reader unable to distinguish a tax line from a
      // real one — see BillingDocumentLine.isTax in schema.prisma.
      isTax: l.isTax ?? false,
    };
  });

  const issuedAt = new Date();
  const documentNumber = await mintDocumentNumberTx(tx, input.organizationId, series, issuedAt);

  // Classification backstop. Callers that route through the classification matrix
  // (the ENABLE_PHASE2_RENT_RECLASSIFICATION path below) pass both columns
  // explicitly. Every other caller — the bills-grid grouped path especially, which
  // resolves its series from the charge's CATEGORY — passed neither, so its
  // documents were written with commercialDocumentType and ledgerTreatment NULL.
  //
  // That is not cosmetic: a NULL ledgerTreatment makes a document unrecognisable to
  // every consumer that reads it, including the owner-receivable offset guard, which
  // requires MANAGER_REVENUE and so rejected the very IVOWN invoices this system
  // mints.
  //
  // Derived from the ALREADY-RESOLVED series (the authoritative one, after category
  // lookup / explicit override), and ONLY where that mapping is 1:1 — see
  // CLASSIFICATION_FOR_DEFAULT_SERIES for why RB and the rest stay null. An explicit
  // caller value always wins; this only ever fills a gap, never overrides.
  //
  // Scoped to docType "invoice" deliberately: a credit/debit/refund note against an
  // IVOWN invoice is a different economic act from the invoice itself, and the
  // forward map classifies invoices only.
  const derivedClassification =
    input.ledgerTreatment == null && input.commercialDocumentType == null && input.docType === "invoice"
      ? CLASSIFICATION_FOR_DEFAULT_SERIES(series.code)
      : null;

  const doc = await tx.billingDocument.create({
    data: {
      organizationId: input.organizationId,
      docType: input.docType,
      documentNumber,
      seriesId: series.id,
      status: "issued",
      issuedAt,
      issuedById: input.actorUserId,
      billingMonth: input.billingMonth ? new Date(`${input.billingMonth}T00:00:00.000Z`) : null,
      counterpartyType: input.counterpartyType,
      partyId: input.partyId,
      tenancyId: input.tenancyId ?? null,
      propertyId: input.propertyId ?? null,
      apartmentId: input.apartmentId ?? null,
      listingId: input.listingId ?? null,
      originalDocumentId: input.originalDocumentId ?? null,
      statementInvoiceId: input.statementInvoiceId ?? null,
      creditAmount: input.creditAmount ?? null,
      reason: input.reason ?? null,
      commercialDocumentType: input.commercialDocumentType ?? derivedClassification?.commercialDocumentType ?? null,
      ledgerTreatment: input.ledgerTreatment ?? derivedClassification?.ledgerTreatment ?? null,
      principalOwnerId: input.principalOwnerId ?? null,
      collectedOnBehalfOfOwnerId: input.collectedOnBehalfOfOwnerId ?? null,
      subtotal: centsToString(subtotalCents),
      sstAmount: centsToString(sstCents),
      total: centsToString(subtotalCents + sstCents),
      idempotencyKey: input.idempotencyKey ?? null,
      proformaDocumentId: input.proformaDocumentId ?? null,
      lines: { create: lineRows },
    },
    select: { id: true, documentNumber: true },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    action: "billing_documents.issue",
    entityType: "BillingDocument",
    entityId: doc.id,
    meta: {
      docType: input.docType,
      documentNumber: doc.documentNumber,
      total: centsToString(subtotalCents + sstCents),
      originalDocumentId: input.originalDocumentId ?? null,
    },
  });

  return doc;
}

// ── In-transaction auto-post minting (spec §4.2 mint-on-post + §4.6) ─────────

/**
 * Legacy chargeType → seeded category code (spec §4.2: auto-post literals map
 * onto registry rows at post time; same map as scripts/backfill-charge-categories.ts).
 */
export const CHARGE_TYPE_TO_CATEGORY_CODE: Record<string, string> = {
  rent: "rental",
  rental: "rental",
  letting_commission: "letting_commission", // Phase 2: first-full-month commission → IVTEN (KAEN revenue), NOT RB

  utility: "utility_tnb",
  aircond: "aircond",
  carpark: "carpark",
  cleaning: "cleaning_tenant",
  management_fee: "management_fee",
  access_card: "access_card_replacement",
  tenancy_agreement_fee: "tenancy_agreement_fee",
  renewal_fee: "renewal_fee",
};

type ChargeForMint = {
  id: string;
  organizationId: string;
  chargeNumber: string;
  chargeType: string;
  status: string;
  categoryId: string | null;
  description: string | null;
  amount: { toString(): string };
  sstRate: { toString(): string } | null;
  parentChargeId: string | null;
  invoiceId: string | null;
  currency: string;
  dueDate: Date;
  billingMonth: Date | null;
  partyId: string;
  tenancyId: string | null;
  unitId: string | null;
  unit: { apartmentId: string; apartment: { propertyId: string } | null } | null;
  // Spec 1 rent-reclassification (Phase 1) — authoritative routing input (never inferred from category name).
  commercialPurpose: string | null;
  fundedBy: string | null;
  revenueRecognition: string | null;
  settlementRecipient: string | null;
  nonBillable: boolean;
};

/**
 * A posted charge resolves to NO ChargeCategory (neither charge.categoryId nor
 * the auto-post literal map). While the flag is on this MUST abort the posting
 * tx (spec §4.6) — a charge must never become visible without its document.
 */
export class DocumentCategoryUnresolvedError extends Error {
  readonly code = "DOCUMENT_CATEGORY_UNRESOLVED";
  constructor(chargeId: string, chargeType: string) {
    super(`DOCUMENT_CATEGORY_UNRESOLVED: charge ${chargeId} (chargeType "${chargeType}") maps to no ChargeCategory`);
    this.name = "DocumentCategoryUnresolvedError";
  }
}

/** Spec 1 (Phase 1) fail-closed: a charge with absent/ambiguous economic classification
 * cannot issue a document. Thrown inside the caller's tx so the whole posting aborts
 * (mint-on-post §4.6). Populating a persistent NEEDS_ECONOMIC_CLASSIFICATION marker is a
 * safe POST-tx follow-up — it must NOT be written from inside this tx (would deadlock on
 * the charge row the caller already locked). */
export class ChargeNeedsClassificationError extends Error {
  readonly code = "NEEDS_ECONOMIC_CLASSIFICATION";
  constructor(chargeId: string, reason: string) {
    super(`NEEDS_ECONOMIC_CLASSIFICATION: charge ${chargeId} — ${reason}`);
    this.name = "ChargeNeedsClassificationError";
  }
}

/** Spec 1 (Phase 1): a valid classification resolved to no permitted series (fail closed, R1). */
export class SeriesNotConfiguredError extends Error {
  readonly code = "SERIES_NOT_CONFIGURED";
  constructor(commercialDocumentType: string, ledgerTreatment: string) {
    super(`SERIES_NOT_CONFIGURED: no series for ${commercialDocumentType} / ${ledgerTreatment}`);
    this.name = "SeriesNotConfiguredError";
  }
}


async function resolveCategoryForChargeTx(tx: Prisma.TransactionClient, charge: ChargeForMint) {
  if (charge.categoryId) {
    return tx.chargeCategory.findFirst({
      where: { id: charge.categoryId, organizationId: charge.organizationId },
    });
  }
  const code = CHARGE_TYPE_TO_CATEGORY_CODE[charge.chargeType];
  if (!code) return null;
  const cat = await tx.chargeCategory.findFirst({
    where: { organizationId: charge.organizationId, code },
  });
  if (cat) {
    // Back-fill so document lines + future mints agree with the registry.
    // Same tx as the mint — a rollback also rolls the back-fill back.
    await tx.charge.update({ where: { id: charge.id }, data: { categoryId: cat.id } });
  }
  return cat;
}

/**
 * One itemized document line a single charge should be split into. Lets a charge
 * whose amount is a POOL of components (e.g. the meter "Shared utilities" charge =
 * electricity + water + sewerage + wifi + cleaning − subsidy) render as one line
 * PER component — an accounting statement, not a lump — WITHOUT fragmenting the
 * receivable (the Charge, its outstanding, void/credit flows, and the owner ledger
 * stay whole; this is presentation only). Every generated line still carries the
 * SAME parent chargeId (settlement traceability) and the SAME resolved category +
 * SST rate as the lump, so routing (IVTEN/DEP) and totals are byte-identical
 * except for the extra lines.
 */
export type ChargeLineBreakdown = { description: string; amount: string };

/** A charge's itemized-line breakdown does not sum back to the charge amount —
 * fail-closed (spec §4.6): abort the posting rather than issue a document that
 * cannot foot with its own receivable. Structurally unreachable when the breakdown
 * is derived from the SAME shares that produced the charge amount, but a money
 * guard against future drift (mirrors bills-grid's SUM_INVARIANT). */
export class ChargeLineBreakdownMismatchError extends Error {
  readonly code = "CHARGE_LINE_BREAKDOWN_MISMATCH";
  constructor(chargeId: string, chargeCents: number, sumCents: number) {
    super(
      `CHARGE_LINE_BREAKDOWN_MISMATCH: charge ${chargeId} amount ${chargeCents}¢ ≠ Σ itemized lines ${sumCents}¢`,
    );
    this.name = "ChargeLineBreakdownMismatchError";
  }
}

/** Build the document line(s) for one charge. Default: the single whole-charge line
 * (Yannie's one-line-per-charge practice). When an itemized breakdown is supplied,
 * emit one line per component — each stamped with the SAME parent chargeId and the
 * SAME category/SST as the lump — after asserting Σ(component amounts) === charge
 * amount (money guard: a mismatch aborts the posting). */
function buildLinesForCharge(
  charge: ChargeForMint,
  category: { id: string; name: string; defaultSstRate: { toString(): string } },
  breakdown: ChargeLineBreakdown[] | undefined,
): IssueLineInput[] {
  const sstRate = charge.sstRate != null ? charge.sstRate.toString() : category.defaultSstRate.toString();
  const description = charge.chargeType === "tenancy_agreement_fee"
    ? "Admin and Agreement Fee"
    : charge.chargeType === "renewal_fee"
      ? "Admin and Agreement Fee (Renewal)"
      : charge.description ?? category.name;
  if (!breakdown || breakdown.length === 0) {
    return [
      {
        chargeId: charge.id,
        categoryId: category.id,
        description,
        amount: charge.amount.toString(),
        sstRate,
      },
    ];
  }
  const sumCents = breakdown.reduce(
    (s, b) => s + toCents(b.amount, "issueDocumentsForChargesTx.breakdownLine"),
    0,
  );
  const chargeCents = toCents(charge.amount.toString(), "issueDocumentsForChargesTx.charge");
  if (sumCents !== chargeCents) {
    throw new ChargeLineBreakdownMismatchError(charge.id, chargeCents, sumCents);
  }
  return breakdown.map((b) => ({
    chargeId: charge.id,
    categoryId: category.id,
    description: b.description,
    amount: b.amount,
    sstRate,
  }));
}

/**
 * In-transaction auto-post minting used by the posting flows ("Post charges"
 * in chargeUtilityBillService, manual postChargeService; statement generate
 * uses the IVOWN sibling below). Runs INSIDE the caller's posting transaction and
 * THROWS on any failure — a mint failure aborts the posting (spec §4.6: no
 * charge visible without its document while the flag is on). One document per
 * charge (Yannie's practice: separate docs per item per unit). Replay-safe:
 * deterministic idempotencyKey ("doc:"+chargeNumber) + the existing-line skip
 * make a replayed post a no-op. The flag check here is defense-in-depth —
 * call sites also gate with if (isPhase2FlagEnabled(...)).
 */
export async function issueDocumentsForChargesTx(
  tx: Prisma.TransactionClient,
  chargeIds: string[],
  actorUserId: string,
  /** Optional per-charge itemized line breakdown. A charge listed here issues one
   * document line PER breakdown entry (all carrying that charge's id) instead of the
   * default single whole-charge line — used by the meter path to split the pooled
   * "Shared utilities" charge into per-utility lines. Amounts MUST sum to the charge
   * amount (asserted in buildLinesForCharge). Charges absent from the map keep the
   * unchanged one-line behaviour, so every OTHER caller is untouched. */
  lineBreakdowns?: Map<string, ChargeLineBreakdown[]>,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  if (!chargeIds || chargeIds.length === 0) return;
  const requestedIds = [...new Set(chargeIds)];
  const requestedCharges: ChargeForMint[] = await tx.charge.findMany({
    // Read the requested rows before filtering by status. Agreement-fee pairs
    // are a strong invariant: silently ignoring a draft/void leg here can let a
    // caller issue only its live sibling.
    where: { id: { in: requestedIds } },
    select: {
      id: true, organizationId: true, chargeNumber: true, chargeType: true, status: true, categoryId: true,
      description: true, amount: true, sstRate: true, parentChargeId: true, invoiceId: true, currency: true, dueDate: true,
      billingMonth: true, partyId: true, tenancyId: true,
      unitId: true,
      unit: { select: { apartmentId: true, apartment: { select: { propertyId: true } } } },
      commercialPurpose: true, fundedBy: true, revenueRecognition: true, settlementRecipient: true, nonBillable: true,
    },
  });
  if (requestedCharges.length === 0) return;
  const orgIds = new Set(requestedCharges.map((charge) => charge.organizationId));
  if (orgIds.size !== 1) throw new Error("DOCUMENT_CHARGES_MUST_SHARE_ORGANIZATION");
  const orgId = requestedCharges[0]!.organizationId;

  // TA and renewal amounts use a base + exact payable SST sibling. Posting and
  // healing callers do not all pass both ids, so close the requested set over
  // the pair before issuing. This is read-only closure: if one leg is still
  // draft, validation below aborts the caller's posting transaction rather than
  // silently promoting money the caller did not authorize.
  const isAgreementFee = (charge: Pick<ChargeForMint, "chargeType">) =>
    charge.chargeType === "tenancy_agreement_fee" || charge.chargeType === "renewal_fee";
  const liveStatuses = new Set(["posted", "partially_paid", "paid"]);
  for (const charge of requestedCharges) {
    if (isAgreementFee(charge) && !liveStatuses.has(charge.status)) {
      throw new Error(`TA_TAX_PAIR_NOT_POSTED: ${charge.chargeNumber}`);
    }
  }
  const requestedLiveCharges = requestedCharges.filter((charge) => liveStatuses.has(charge.status));
  if (requestedLiveCharges.length === 0) return;
  const pairRootIds = [...new Set(requestedCharges.flatMap((charge) => {
    if (!isAgreementFee(charge)) return [];
    return [charge.parentChargeId && charge.chargeNumber.endsWith("-SST") ? charge.parentChargeId : charge.id];
  }))];
  let charges = requestedLiveCharges;
  if (pairRootIds.length > 0) {
    const pairMembers: ChargeForMint[] = await tx.charge.findMany({
      where: {
        organizationId: orgId,
        OR: [{ id: { in: pairRootIds } }, { parentChargeId: { in: pairRootIds } }],
      },
      select: {
        id: true, organizationId: true, chargeNumber: true, chargeType: true, status: true, categoryId: true,
        description: true, amount: true, sstRate: true, parentChargeId: true, invoiceId: true, currency: true, dueDate: true,
        billingMonth: true, partyId: true, tenancyId: true,
        unitId: true,
        unit: { select: { apartmentId: true, apartment: { select: { propertyId: true } } } },
        commercialPurpose: true, fundedBy: true, revenueRecognition: true, settlementRecipient: true, nonBillable: true,
      },
    });
    const byId = new Map(requestedLiveCharges.map((charge) => [charge.id, charge]));
    for (const member of pairMembers) byId.set(member.id, member);
    charges = [...byId.values()];
  }
  // Idempotent per-org seed — §4.6: series unconfigured → auto-seed defaults,
  // never a production-path failure. ensureChargeCategorySeeds opens its OWN
  // connection (create-only upserts, harmless if they outlive a rollback); the
  // tx reads below run at READ COMMITTED and see the freshly committed rows.
  await ensureChargeCategorySeeds(orgId);

  // A linked `-SST` Charge is the payable tax sibling of its base Charge. Keep
  // both receivables on ONE document: the base line declares the exact SST and
  // the sibling line is marked isTax so it remains payable without being counted
  // into subtotal a second time. Generic parentChargeId links are deliberately
  // ignored; the exact charge-number convention is the tax identity guard.
  const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
  const taxChildByParentId = new Map<string, ChargeForMint>();
  const taxChildIds = new Set<string>();
  const sameDate = (left: Date | null, right: Date | null) => left?.getTime() === right?.getTime();
  for (const rootId of pairRootIds) {
    const parent = chargeById.get(rootId);
    if (!parent || !isAgreementFee(parent) || parent.parentChargeId !== null) {
      throw new Error(`TA_TAX_PAIR_PARENT_INVALID: ${rootId}`);
    }
    const children = charges.filter((charge) =>
      charge.parentChargeId === parent.id && charge.chargeNumber === `${parent.chargeNumber}-SST`,
    );
    const explicitRate = Number(parent.sstRate?.toString() ?? "NaN");
    if (children.length === 0) {
      // Explicit zero is the migration-stamped legacy gross row. Null is not
      // accepted here because the category fallback is now 8% and would revive
      // the historical double-SST bug during a heal.
      if (explicitRate === 0) continue;
      throw new Error(`TA_TAX_SIBLING_REQUIRED: ${parent.chargeNumber}`);
    }
    if (children.length !== 1) throw new Error(`MULTIPLE_TAX_SIBLINGS: ${parent.chargeNumber}`);
    const child = children[0]!;
    if (!liveStatuses.has(parent.status) || !liveStatuses.has(child.status)) {
      throw new Error(`TA_TAX_PAIR_NOT_POSTED: ${parent.chargeNumber}`);
    }
    if (explicitRate !== 8 || Number(child.sstRate?.toString() ?? "NaN") !== 0) {
      throw new Error(`TA_TAX_PAIR_RATE_INVALID: ${parent.chargeNumber}`);
    }
    if (toCents(child.amount.toString(), "issueDocumentsForChargesTx.taxChild") <= 0) {
      throw new Error(`TA_TAX_PAIR_AMOUNT_INVALID: ${parent.chargeNumber}`);
    }
    const pairFieldsMatch =
      child.organizationId === parent.organizationId
      && parent.invoiceId !== null
      && child.invoiceId === parent.invoiceId
      && child.partyId === parent.partyId
      && child.tenancyId === parent.tenancyId
      && child.unitId === parent.unitId
      && child.categoryId === parent.categoryId
      && child.currency === parent.currency
      && child.chargeType === parent.chargeType
      && sameDate(child.billingMonth, parent.billingMonth)
      && child.dueDate.getTime() === parent.dueDate.getTime()
      && child.commercialPurpose === parent.commercialPurpose
      && child.fundedBy === parent.fundedBy
      && child.revenueRecognition === parent.revenueRecognition
      && child.settlementRecipient === parent.settlementRecipient
      && child.nonBillable === parent.nonBillable;
    if (!pairFieldsMatch) throw new Error(`TA_TAX_PAIR_SCOPE_MISMATCH: ${parent.chargeNumber}`);

    // The two receivables must be the exact inclusive split, not merely two
    // arbitrary amounts that happen to share a link. This also protects small
    // values where recomputing SST from the rounded base would lose a sen.
    const pairGrossCents =
      toCents(parent.amount.toString(), "issueDocumentsForChargesTx.taxBase")
      + toCents(child.amount.toString(), "issueDocumentsForChargesTx.taxChild");
    const expected = splitInclusiveSst(centsToString(pairGrossCents), "8");
    if (
      toCents(parent.amount.toString(), "issueDocumentsForChargesTx.taxBase") !== toCents(expected.base)
      || toCents(child.amount.toString(), "issueDocumentsForChargesTx.taxChild") !== toCents(expected.sst)
    ) {
      throw new Error(`TA_TAX_PAIR_AMOUNT_INVALID: ${parent.chargeNumber}`);
    }
    taxChildByParentId.set(parent.id, child);
    taxChildIds.add(child.id);
  }

  for (const charge of charges) {
    if (taxChildIds.has(charge.id)) continue;
    const taxChild = taxChildByParentId.get(charge.id);
    const groupChargeIds = taxChild ? [charge.id, taxChild.id] : [charge.id];

    // Replay guard: the complete pair is already documented → skip. A partial
    // pair is an invariant violation; issuing only the missing half would create
    // a second tax document for the same service.
    const existingLines = await tx.billingDocumentLine.findMany({
      where: { chargeId: { in: groupChargeIds } },
      select: { chargeId: true, documentId: true },
    });
    if (existingLines.length > 0) {
      const documentedIds = new Set(existingLines.map((line) => line.chargeId));
      const documentIds = new Set(existingLines.map((line) => line.documentId));
      if (groupChargeIds.every((id) => documentedIds.has(id)) && documentIds.size === 1) continue;
      throw new Error(`PARTIAL_TAX_DOCUMENT: ${charge.chargeNumber}`);
    }

    // Spec 1 (Phase 1) rent-reclassification: flag-gated routing via commercialPurpose ×
    // economic treatment (NEVER the category name). Legacy category.docType path runs when
    // the flag is off — byte-identical to before. One document per charge ⇒ each document is
    // inherently homogeneous (R5); the grouped path is bills-grid's, out of this scope.
    if (isPhase2FlagEnabled("ENABLE_PHASE2_RENT_RECLASSIFICATION")) {
      const routed = resolveDocumentClassification({
        commercialPurpose: charge.commercialPurpose as CommercialPurpose | null,
        fundedBy: charge.fundedBy as FundedBy | null,
        revenueRecognition: charge.revenueRecognition as RevenueRecognition | null,
        settlementRecipient: charge.settlementRecipient as SettlementRecipient | null,
        nonBillable: charge.nonBillable,
      });
      if (routed.kind === "NEEDS_ECONOMIC_CLASSIFICATION") {
        // Fail closed: abort the posting tx (mint-on-post §4.6). Do NOT write the charge
        // marker here — a separate-connection write to this row would deadlock against the
        // caller's tx, which has already row-locked this charge (status:"posted"). The
        // throw is the safety; marker population is a safe post-tx follow-up.
        throw new ChargeNeedsClassificationError(charge.id, routed.reason);
      }
      if (routed.kind === "NO_DOCUMENT") continue; // included / genuine owner pass-through
      const seriesCode = DEFAULT_SERIES_FOR_CLASSIFICATION(routed.commercialDocumentType, routed.ledgerTreatment);
      if (!seriesCode) throw new SeriesNotConfiguredError(routed.commercialDocumentType, routed.ledgerTreatment);
      // Principal owner (PAYABLE_TO_OWNER only): the unit's owner (Listing.ownerPartyId).
      let principalOwnerId: string | null = null;
      if (routed.ledgerTreatment === "PAYABLE_TO_OWNER" && charge.unitId) {
        const listing = await tx.listing.findFirst({ where: { id: charge.unitId, organizationId: charge.organizationId }, select: { ownerPartyId: true } });
        principalOwnerId = listing?.ownerPartyId ?? null;
      }
      const owner = resolveOwnerReferences({ ledgerTreatment: routed.ledgerTreatment, principalOwnerId });
      if ("error" in owner) {
        throw new ChargeNeedsClassificationError(charge.id, owner.error); // fail closed (see note above)
      }
      const catForLines = await resolveCategoryForChargeTx(tx, charge);
      if (!catForLines) throw new DocumentCategoryUnresolvedError(charge.id, charge.chargeType);
      // Billed party: PAYABLE_TO_OWNER + owner-service bill the owner? No — rent/owner-collection
      // bill the TENANT; OWNER_SERVICE bills the owner; TENANT_SERVICE bills the tenant.
      const counterpartyType: "tenant" | "owner" =
        routed.commercialDocumentType === "OWNER_SERVICE_INVOICE" ? "owner" : "tenant";
      const lines = buildLinesForCharge(charge, catForLines, lineBreakdowns?.get(charge.id));
      if (taxChild) {
        if (lines.length !== 1 || lineBreakdowns?.has(charge.id)) {
          throw new Error(`TAX_SIBLING_BREAKDOWN_UNSUPPORTED: ${charge.chargeNumber}`);
        }
        const rate = lines[0]!.sstRate;
        if (!(Number(rate) > 0)) throw new Error(`TAX_SIBLING_BASE_RATE_REQUIRED: ${charge.chargeNumber}`);
        lines[0] = { ...lines[0]!, sstAmount: taxChild.amount.toString() };
        lines.push({
          chargeId: taxChild.id,
          categoryId: taxChild.categoryId ?? catForLines.id,
          description: `${lines[0]!.description} — SST ${rate}%`,
          amount: taxChild.amount.toString(),
          sstRate: "0",
          isTax: true,
        });
      }
      await issueDocumentTx(tx, {
        organizationId: charge.organizationId,
        docType: "invoice",
        seriesCode,
        counterpartyType,
        partyId: charge.partyId,
        tenancyId: charge.tenancyId ?? undefined,
        propertyId: charge.unit?.apartment?.propertyId ?? undefined,
        apartmentId: charge.unit?.apartmentId ?? undefined,
        listingId: charge.unitId ?? undefined,
        billingMonth: charge.billingMonth ? charge.billingMonth.toISOString().slice(0, 10) : undefined,
        commercialDocumentType: routed.commercialDocumentType,
        ledgerTreatment: routed.ledgerTreatment,
        principalOwnerId: owner.principalOwnerId ?? undefined,
        collectedOnBehalfOfOwnerId: owner.collectedOnBehalfOfOwnerId ?? undefined,
        idempotencyKey: `doc:${charge.chargeNumber}`,
        lines,
        actorUserId,
      });
      continue;
    }

    const category = await resolveCategoryForChargeTx(tx, charge);
    if (!category) throw new DocumentCategoryUnresolvedError(charge.id, charge.chargeType);

    const lines = buildLinesForCharge(charge, category, lineBreakdowns?.get(charge.id));
    if (taxChild) {
      if (lines.length !== 1 || lineBreakdowns?.has(charge.id)) {
        throw new Error(`TAX_SIBLING_BREAKDOWN_UNSUPPORTED: ${charge.chargeNumber}`);
      }
      const rate = lines[0]!.sstRate;
      if (!(Number(rate) > 0)) throw new Error(`TAX_SIBLING_BASE_RATE_REQUIRED: ${charge.chargeNumber}`);
      lines[0] = { ...lines[0]!, sstAmount: taxChild.amount.toString() };
      lines.push({
        chargeId: taxChild.id,
        categoryId: taxChild.categoryId ?? category.id,
        description: `${lines[0]!.description} — SST ${rate}%`,
        amount: taxChild.amount.toString(),
        sstRate: "0",
        isTax: true,
      });
    }
    await issueDocumentTx(tx, {
      organizationId: charge.organizationId,
      docType: category.docType as "invoice" | "debit_note",
      counterpartyType: category.family === "owner_income" ? "owner" : "tenant",
      partyId: charge.partyId,
      tenancyId: charge.tenancyId ?? undefined,
      propertyId: charge.unit?.apartment?.propertyId ?? undefined,
      apartmentId: charge.unit?.apartmentId ?? undefined,
      listingId: charge.unitId ?? undefined,
      billingMonth: charge.billingMonth ? charge.billingMonth.toISOString().slice(0, 10) : undefined,
      idempotencyKey: `doc:${charge.chargeNumber}`,
      lines,
      actorUserId,
    });
  }
}

// ── Healing/backfill wrapper (NOT a posting path) ────────────────────────────

/** Durable failure marker — mirrors owner-ledger.sync-hook recordSyncFailure. */
async function recordMintFailure(orgId: string, actorUserId: string, entityId: string, meta: Prisma.InputJsonObject): Promise<void> {
  try {
    const db = getDb();
    await db.$transaction((tx) =>
      recordAudit(tx, {
        organizationId: orgId,
        actorUserId,
        actorRole: "system",
        action: "billing_documents.mint_failed",
        entityType: "BillingDocument",
        entityId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[billing-documents.issue] failed to record mint_failed audit (swallowed):", auditErr);
  }
}

/**
 * HEALING/BACKFILL ONLY — never called by the posting flows (those mint
 * in-tx via issueDocumentsForChargesTx and let failures abort the posting).
 * Opens its OWN transaction and NEVER throws: a failure is swallowed into
 * the durable billing_documents.mint_failed audit marker, so an ops re-run
 * over legacy / partially-healed charges can never break anything. The
 * deterministic doc:<chargeNumber> idempotency key lets a later re-run
 * finish a partial heal without double-issuing.
 */
export async function healBillingDocumentsForCharges(chargeIds: string[], actorUserId: string): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  if (!chargeIds || chargeIds.length === 0) return;
  const db = getDb();
  const first = await db.charge.findFirst({
    where: { id: { in: chargeIds } },
    select: { organizationId: true },
  });
  if (!first) return;
  try {
    await db.$transaction((tx) => issueDocumentsForChargesTx(tx, chargeIds, actorUserId));
  } catch (e) {
    console.error("[billing-documents.issue] healBillingDocumentsForCharges failed (swallowed):", e);
    await recordMintFailure(first.organizationId, actorUserId, chargeIds[0]!, {
      chargeIds,
      error: (e as Error).message,
    });
  }
}

// ── Owner-statement IVOWN mint (spec §4.2 row 3) ─────────────────────────────

/**
 * Issue ONE IVOWN invoice for a freshly generated owner statement, covering
 * the KAEN-income-from-owner lines (management_fee + cleaning). Pass-through
 * statement lines (tnb/wifi/sewerage) stay statement/ledger-only. Runs INSIDE
 * generateStatementService's write tx (the statement Invoice + its charges
 * are visible here because this tx created them) and THROWS on failure —
 * aborting the generate, so a statement can never exist without its IVOWN
 * document while the flag is on (spec §4.6). idempotencyKey
 * "ivown:"+statement.idempotencyKey makes generate re-runs dedupe; the
 * generate's raced short-circuit returns before ever reaching this call.
 * Flag check here is defense-in-depth — the call site also gates.
 *
 * SST note: the management_fee line's SST rate is resolved via
 * `resolveMgmtFeeSstRateByUnit` — the SAME per-owner/per-property fee-config
 * lookup (config precedence `resolveConfigForUnit`) that
 * `generateStatementService`/`computeManagementFee` used to produce this
 * charge's amount and Invoice.sstAmount. Both then run round(base × rate/100)
 * per line, so the document foots with the statement for ANY configured
 * sstPercent — not just the seeded 8% default. (ChargeCategory.defaultSstRate
 * is NOT used for management_fee here; it stays the fallback for the generic
 * per-charge auto-post path in issueDocumentsForChargesTx, which has no
 * statement to mirror.) Legacy statement-attached cleaning Charges remain a
 * flat explicit line here; new bills-grid Cleaning invoices use the category's
 * configured 8% rate in the grid issuer.
 * Plan 3 note: after a statement void→CN, the CN flow releases this key
 * (nulls idempotencyKey on the offset document) so a regenerate mints fresh.
 */
export async function issueStatementIvownDocumentTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorUserId: string,
  statementInvoiceId: string,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  const inv = await tx.invoice.findFirst({
    where: { id: statementInvoiceId, organizationId: orgId, invoiceType: "owner_statement" },
    select: {
      id: true,
      ownerPartyId: true,
      apartmentId: true,
      periodMonth: true,
      idempotencyKey: true,
      charges: {
        where: {
          status: { not: "void" },
          chargeType: { in: ["management_fee", "cleaning", "letting_commission", "letting_commission_sst"] },
        },
        select: { id: true, chargeType: true, description: true, amount: true, unitId: true },
      },
    },
  });
  if (!inv || !inv.ownerPartyId || !inv.idempotencyKey) return; // defensive — generate always sets these
  if (inv.charges.length === 0) return; // no KAEN income this month → no IVOWN document

  // §4.6: series/categories unconfigured → auto-seed defaults (own connection,
  // create-only upserts; tx reads below run READ COMMITTED and see them).
  await ensureChargeCategorySeeds(orgId);
  const mgmtCat = await tx.chargeCategory.findFirst({ where: { organizationId: orgId, code: "management_fee" } });
  const cleanCat = await tx.chargeCategory.findFirst({ where: { organizationId: orgId, code: "cleaning_owner" } });
  const commissionCat = await tx.chargeCategory.findFirst({ where: { organizationId: orgId, code: "letting_commission" } });
  const sstCat = await tx.chargeCategory.findFirst({ where: { organizationId: orgId, code: "letting_commission_sst" } });
  if (!mgmtCat || !cleanCat || !commissionCat || !sstCat) {
    // Unreachable after the seed — but if it happens, the generate MUST abort
    // rather than commit a statement without its IVOWN document (§4.6).
    throw new Error(
      "IVOWN_CATEGORY_MISSING: management_fee/cleaning_owner/letting_commission/letting_commission_sst not found after seeding",
    );
  }

  const propertyId = inv.apartmentId
    ? (
        await tx.apartment.findFirst({
          where: { id: inv.apartmentId, organizationId: orgId },
          select: { propertyId: true },
        })
      )?.propertyId
    : undefined;

  // Per-unit mgmt-fee SST rate — the SAME resolution
  // (owner-billing-sst-rate.resolveMgmtFeeSstRateByUnit, sharing
  // resolveConfigForUnit with generateStatementService and the statement's own
  // recomputeTotals) that produced Invoice.sstAmount for this statement, so the
  // IVOWN document's SST can never diverge from it. Resolved off the tx (own
  // connection, same pattern as ensureChargeCategorySeeds) — the ManagementFeeConfig
  // rows are pre-existing, not written by this transaction.
  const hasMgmtLine = inv.charges.some((c) => c.chargeType === "management_fee");
  const sstRateByUnit =
    hasMgmtLine && inv.periodMonth
      ? await resolveMgmtFeeSstRateByUnit(orgId, inv.ownerPartyId, inv.periodMonth)
      : new Map<string, string>();

  const lines: IssueLineInput[] = inv.charges.map((c) => {
    if (c.chargeType === "management_fee") {
      const sstRate = c.unitId ? sstRateByUnit.get(c.unitId) : undefined;
      if (sstRate === undefined) {
        // Unreachable in the normal generate flow — the statement's own
        // recomputeTotals resolves through the identical lookup at write time.
        // If it ever misses, abort the mint (§4.6) rather than guess an SST rate
        // that could disagree with Invoice.sstAmount.
        throw new Error(
          `IVOWN_SST_RATE_UNRESOLVED: no management-fee config resolves for unit ${c.unitId ?? "(none)"}`,
        );
      }
      return {
        chargeId: c.id,
        categoryId: mgmtCat.id,
        description: c.description ?? "Management fee",
        amount: c.amount.toString(),
        sstRate,
      };
    }
    if (c.chargeType === "letting_commission_sst") {
      // Owner-borne letting-commission SST → its OWN IVOWN line (never mislabeled "Cleaning").
      // The charge amount IS the SST (8% of the commission); it is not itself SST-able → sstRate 0.
      return {
        chargeId: c.id,
        categoryId: sstCat.id,
        description: "SST on Admin Fee (First Month Rental)",
        amount: c.amount.toString(),
        sstRate: "0",
      };
    }
    if (c.chargeType === "letting_commission") {
      // The first month's rent remains the tenant's Rental document. This is the
      // matching owner-facing service invoice line explaining the amount KAEN
      // retains as its fee. The SST is its own exact flat Charge immediately above.
      return {
        chargeId: c.id,
        categoryId: commissionCat.id,
        description: "Admin Fee (First Month Rental)",
        amount: c.amount.toString(),
        sstRate: "0",
      };
    }
    return {
      chargeId: c.id,
      categoryId: cleanCat.id,
      description: c.description ?? "Cleaning",
      amount: c.amount.toString(),
      sstRate: "0",
    };
  });

  await issueDocumentTx(tx, {
    organizationId: orgId,
    docType: "invoice",
    seriesCode: "IVOWN",
    counterpartyType: "owner",
    partyId: inv.ownerPartyId,
    apartmentId: inv.apartmentId ?? undefined,
    propertyId,
    billingMonth: inv.periodMonth ? inv.periodMonth.toISOString().slice(0, 10) : undefined,
    statementInvoiceId: inv.id,
    idempotencyKey: `ivown:${inv.idempotencyKey}`,
    lines,
    actorUserId,
  });
}
