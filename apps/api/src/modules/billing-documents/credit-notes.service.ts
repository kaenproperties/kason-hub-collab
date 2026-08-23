/**
 * Void → Credit Note (spec §4.3, unified reversal).
 *
 * Rule: draft → plain void, no artifact. Posted → "Void & issue Credit Note":
 * ONE transaction — CN minted (issueDocumentTx), original document `offset`,
 * charge → `credited`, outstanding zeroed — then post-commit ledger re-sync +
 * document-status refresh (both never-throw).
 *
 * Charges with NO BillingDocument (pre-cutover / legacy / flag-was-dark) fall
 * back to plain void — a CN must reference an original document (LHDN
 * "Original e-Invoice Reference Number"), so there is nothing to offset.
 */
import { getDb, Prisma } from "@kason/db";
import type { CorrectionStrategy } from "@kason/shared";
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { cancelAndReplaceDocumentTx } from "./correction-replace.service";
import { issueDocumentTx, type IssueLineInput } from "./issue.service";
import { refreshDocumentStatusForCharges, deriveAndWriteDocumentStatusTx } from "./status.service";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { isExactTaTaxPairCharge } from "./ta-tax-pair.guard";

/** Thrown from the tx; route/service callers map {status, code} to HTTP. */
export class CreditNoteVoidError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = "CreditNoteVoidError";
  }
}

/** Integer-cent collected = amount − outstanding, floored at 0, as a 2dp string. */
export function computeCollectedPortion(
  amount: { toString(): string } | string,
  outstanding: { toString(): string } | string,
): string {
  const cents =
    Math.round(Number(amount.toString()) * 100) - Math.round(Number(outstanding.toString()) * 100);
  return (Math.max(0, cents) / 100).toFixed(2);
}

export type CreditChargeTxResult =
  | {
      kind: "credit_note";
      creditNoteId: string;
      creditNoteNumber: string;
      originalDocumentId: string;
      partyId: string;
      counterpartyType: "tenant" | "owner";
      tenancyId: string | null;
      propertyId: string | null;
      apartmentId: string | null;
      listingId: string | null;
      categoryId: string;
    }
  | { kind: "plain_void" };

/**
 * Single-charge CN core, usable INSIDE an existing transaction (the utility-bill
 * cascade issues one CN per affected document in ITS tx). Issues the CN, flips
 * the charge to `credited` (outstanding 0, cancelledReason), marks the original
 * document `offset`, writes ChargeEvent `charge_credited` + AuditLog. Legacy
 * charge without a document → plain void (status `void`, outstanding 0,
 * ChargeEvent `charge_voided`) and returns { kind: "plain_void" }.
 *
 * `creditAmount` omitted ⇒ the collected portion (hold-credit semantics).
 */
export async function creditPostedChargeTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    chargeId: string;
    reason: string;
    creditAmount?: string;
    actorUserId: string;
    actorRole: string;
  },
): Promise<CreditChargeTxResult> {
  const charge = await tx.charge.findFirst({
    where: { id: input.chargeId, organizationId: input.organizationId },
    select: {
      id: true,
      chargeNumber: true,
      status: true,
      amount: true,
      outstandingAmount: true,
      billingMonth: true,
    },
  });
  if (!charge) throw new CreditNoteVoidError(404, "CHARGE_NOT_FOUND");
  if (await isExactTaTaxPairCharge(tx, input.organizationId, charge.id)) {
    throw new CreditNoteVoidError(409, "TAX_PAIR_CORRECTION_UNSUPPORTED");
  }

  const docLine = await tx.billingDocumentLine.findFirst({
    where: {
      chargeId: charge.id,
      document: {
        organizationId: input.organizationId,
        docType: { in: ["invoice", "debit_note"] },
      },
    },
    select: {
      documentId: true,
      categoryId: true,
      description: true,
      amount: true,
      sstRate: true,
      document: {
        select: {
          id: true,
          status: true,
          counterpartyType: true,
          partyId: true,
          tenancyId: true,
          propertyId: true,
          apartmentId: true,
          listingId: true,
        },
      },
    },
  });

  if (!docLine) {
    // Legacy / pre-cutover: nothing issued → plain void (existing behaviour,
    // plus outstanding zeroed + reason, matching voidChargeService today).
    await tx.charge.update({
      where: { id: charge.id, organizationId: input.organizationId },
      data: { status: "void", cancelledReason: input.reason, outstandingAmount: 0 },
    });
    await tx.chargeEvent.create({
      data: {
        organizationId: input.organizationId,
        chargeId: charge.id,
        eventType: "charge_voided",
        eventAt: new Date(),
        actorUserId: input.actorUserId,
        payloadJson: {
          previousStatus: charge.status,
          nextStatus: "void",
          reason: input.reason,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return { kind: "plain_void" };
  }

  const creditAmount =
    input.creditAmount ?? computeCollectedPortion(charge.amount, charge.outstandingAmount);

  // P4 (R12a) widened BillingDocumentLine.categoryId to nullable for overpayment
  // CN lines — but THIS query is scoped to `chargeId: charge.id` (a real charge),
  // and overpayment-CN lines always carry chargeId=null, so they can never be
  // the row fetched here. A null categoryId on a real charge's line would be a
  // data-integrity bug, not an expected state — fail loud instead of silently
  // minting a category-less CN line for a real charge.
  if (!docLine.categoryId) {
    throw new Error(`INVARIANT_VIOLATION: charge ${charge.id}'s document line has no categoryId`);
  }

  // The CN mirrors THIS charge's line on the original document (Plan 2 mints one
  // document per charge, but be precise anyway: only this charge's line).
  const lines: IssueLineInput[] = [
    {
      chargeId: charge.id,
      categoryId: docLine.categoryId,
      description: `Reversal: ${docLine.description}`,
      amount: docLine.amount.toString(),
      sstRate: docLine.sstRate.toString(),
    },
  ];

  const cn = await issueDocumentTx(tx, {
    organizationId: input.organizationId,
    docType: "credit_note",
    seriesCode: "CN",
    counterpartyType: docLine.document.counterpartyType as "tenant" | "owner",
    partyId: docLine.document.partyId,
    tenancyId: docLine.document.tenancyId ?? undefined,
    propertyId: docLine.document.propertyId ?? undefined,
    apartmentId: docLine.document.apartmentId ?? undefined,
    listingId: docLine.document.listingId ?? undefined,
    billingMonth: charge.billingMonth
      ? charge.billingMonth.toISOString().slice(0, 10)
      : undefined,
    originalDocumentId: docLine.document.id,
    creditAmount,
    reason: input.reason,
    idempotencyKey: `cn:charge:${charge.id}`,
    lines,
    actorUserId: input.actorUserId,
  });

  await tx.charge.update({
    where: { id: charge.id, organizationId: input.organizationId },
    data: { status: "credited", cancelledReason: input.reason, outstandingAmount: 0 },
  });
  await tx.chargeEvent.create({
    data: {
      organizationId: input.organizationId,
      chargeId: charge.id,
      eventType: "charge_credited",
      eventAt: new Date(),
      actorUserId: input.actorUserId,
      payloadJson: {
        previousStatus: charge.status,
        nextStatus: "credited",
        reason: input.reason,
        creditNoteId: cn.id,
        creditNoteNumber: cn.documentNumber,
        creditAmount,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  // Derive the document's status from ALL its charges (post-credit) — NOT a blanket
  // `offset`, which corrupts a multi-charge grouped invoice where only THIS charge was
  // credited. Writes both status axes consistently (§7-A3 / Issue 3).
  await deriveAndWriteDocumentStatusTx(tx, docLine.document.id);
  await recordAudit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing-docs.credit_note.issue",
    entityType: "BillingDocument",
    entityId: cn.id,
    meta: {
      originalDocumentId: docLine.document.id,
      chargeId: charge.id,
      chargeNumber: charge.chargeNumber,
      creditNoteNumber: cn.documentNumber,
      creditAmount,
      reason: input.reason,
    } as unknown as Prisma.InputJsonValue,
  });

  return {
    kind: "credit_note",
    creditNoteId: cn.id,
    creditNoteNumber: cn.documentNumber,
    originalDocumentId: docLine.document.id,
    partyId: docLine.document.partyId,
    counterpartyType: docLine.document.counterpartyType as "tenant" | "owner",
    tenancyId: docLine.document.tenancyId,
    propertyId: docLine.document.propertyId,
    apartmentId: docLine.document.apartmentId,
    listingId: docLine.document.listingId,
    categoryId: docLine.categoryId,
  };
}

export type VoidWithCreditNoteInput = {
  organizationId: string;
  chargeId: string;
  reason: string;
  // R1 explicit correction strategy. Takes precedence over the deprecated
  // paidHandling alias below.
  strategy?: CorrectionStrategy;
  // DEBIT_ADJUSTMENT only (R2): the amount the receivable is raised by. A Debit
  // Note of this magnitude is minted against the original document and the
  // charge's outstanding grows by it. Ignored by every other strategy.
  adjustmentAmount?: string;
  // DEBIT_ADJUSTMENT only (R2): caller-supplied idempotency token that dedupes a
  // true retry of the SAME adjustment. When present it keys the DN + the whole
  // outstanding-increment state change, so a replay returns the existing DN and
  // increments outstanding EXACTLY once. Absent, the key derives from
  // charge+amount (distinct amounts ⇒ distinct adjustments). The route wires this
  // from the request in Task 11 (R12c).
  idempotencyKey?: string;
  // CANCEL_AND_REPLACE only (R3): the corrected line-set for the replacement
  // invoice. min-1 lines enforced by the schema (voidChargeSchema) + the service.
  // Ignored by every other strategy.
  replacement?: { lines: { categoryId: string; description: string; amount: string }[] };
  // DEPRECATED (R1) one-release alias: hold_credit → CREDIT_ADJUSTMENT,
  // refund → REFUND. error_revert_first no longer maps to anything (its old
  // 409-default behaviour is gone) → resolves to no strategy → STRATEGY_REQUIRED.
  paidHandling?: "error_revert_first" | "hold_credit" | "refund";
  refund?: {
    amount: string;
    method: string;
    bankRef?: string;
    proofKey?: string;
    refundedAt: string;
  };
  actorUserId: string;
  actorRole: string;
};

export type VoidWithCreditNoteResult = {
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  refundNoteNumber?: string;
  // DEBIT_ADJUSTMENT (R2): the Debit Note minted to raise the receivable.
  debitNoteNumber?: string;
  // CANCEL_AND_REPLACE (R3): the replacement invoice that supersedes the original.
  replacementDocumentId?: string;
  replacementNumber?: string;
  plainVoid: boolean;
};

/**
 * Standalone posted-charge void→CN — opens its OWN transaction, then fires the
 * post-commit hooks (ledger re-sync + document-status refresh; both never-throw).
 *
 * Paid / partially-paid fork (spec §4.3, R1): collected > 0 requires an explicit
 * correction `strategy` (the deprecated `paidHandling` alias maps hold_credit →
 * CREDIT_ADJUSTMENT, refund → REFUND for one release). No resolvable strategy →
 * 400 STRATEGY_REQUIRED. `CREDIT_ADJUSTMENT` → the collected portion becomes
 * CN.creditAmount (spendable credit). `REFUND` → issues a Refund Note (RN)
 * referencing the original document + a `Refund` row with the operational
 * details (method/bankRef/proofKey); CN.creditAmount = collected − refund.amount
 * (a partial refund leaves the remainder as spendable credit). refund.amount
 * must be > 0 and ≤ collected (400 REFUND_AMOUNT_INVALID / REFUND_EXCEEDS_COLLECTED).
 * `DEBIT_ADJUSTMENT` (R2) → mints a Debit Note (DN) against the original document
 * raising the receivable by `adjustmentAmount` (> 0, else 400
 * ADJUSTMENT_AMOUNT_INVALID); the charge's outstanding grows by the same amount
 * and the `PaymentAllocation` rows are NEVER touched — the payment stays allocated
 * to this charge. `CANCEL_AND_REPLACE` → 400 STRATEGY_NOT_IMPLEMENTED (Task 8). An
 * UNPAID posted charge voids plainly — no strategy required.
 */
export async function voidPostedChargeWithCreditNote(
  input: VoidWithCreditNoteInput,
): Promise<VoidWithCreditNoteResult> {
  const db = getDb();
  // Fail before even the lazy category seed can write.  The inclusive TA / renewal
  // receivable is two Charges and none of the single-charge correction strategies
  // can safely credit, refund, debit, or replace only one member.
  const pairedTa = await db.$transaction((tx) =>
    isExactTaTaxPairCharge(tx, input.organizationId, input.chargeId),
  );
  if (pairedTa) {
    throw new CreditNoteVoidError(409, "TAX_PAIR_CORRECTION_UNSUPPORTED");
  }
  // The DEBIT_ADJUSTMENT branch mints on the "DN" series (CN branch on "CN").
  // ensureChargeCategorySeeds opens its own connection (create-only) → BEFORE the tx, so an
  // existing org not yet re-seeded since DN was added can't throw SERIES_NOT_FOUND (redesign P0).
  await ensureChargeCategorySeeds(input.organizationId);
  const result = await db.$transaction(async (tx) => {
    const charge = await tx.charge.findFirst({
      where: { id: input.chargeId, organizationId: input.organizationId },
      select: { id: true, status: true, amount: true, outstandingAmount: true },
    });
    if (!charge) throw new CreditNoteVoidError(404, "CHARGE_NOT_FOUND");
    // Repeat under the correction transaction so a concurrent relationship change
    // cannot slip between the preflight and the first financial write.
    if (await isExactTaTaxPairCharge(tx, input.organizationId, charge.id)) {
      throw new CreditNoteVoidError(409, "TAX_PAIR_CORRECTION_UNSUPPORTED");
    }
    if (!["posted", "partially_paid", "paid"].includes(charge.status)) {
      throw new CreditNoteVoidError(409, "CHARGE_NOT_POSTED");
    }

    const collected = computeCollectedPortion(charge.amount, charge.outstandingAmount);
    const hasCollected = Number(collected) > 0;

    // R1: resolve the correction strategy ONCE, then drive every downstream
    // branch off it. `input.strategy` wins over the deprecated one-release
    // paidHandling alias (the `??` order guarantees precedence):
    //   hold_credit → CREDIT_ADJUSTMENT, refund → REFUND. error_revert_first (or
    //   any absent/unmapped value) → undefined → STRATEGY_REQUIRED. The old
    //   error_revert_first default (409 REVERT_PAYMENT_FIRST) is gone.
    const strategy =
      input.strategy ??
      (input.paidHandling === "hold_credit"
        ? "CREDIT_ADJUSTMENT"
        : input.paidHandling === "refund"
          ? "REFUND"
          : undefined);

    if (hasCollected) {
      if (!strategy) throw new CreditNoteVoidError(400, "STRATEGY_REQUIRED");
      if (strategy === "REFUND") {
        if (!input.refund) throw new CreditNoteVoidError(400, "REFUND_DETAILS_REQUIRED");
        const refundAmount = Number(input.refund.amount);
        if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
          throw new CreditNoteVoidError(400, "REFUND_AMOUNT_INVALID");
        }
        if (refundAmount > Number(collected) + 0.005) {
          throw new CreditNoteVoidError(400, "REFUND_EXCEEDS_COLLECTED");
        }
      }
    }

    // CANCEL_AND_REPLACE (R3): supersede the original document + MOVE the
    // allocation onto a fresh replacement invoice — all in THIS transaction (a
    // failure anywhere rolls it ALL back). Applies to paid AND unpaid posted
    // charges. The Payment row is never touched (R5); the original PaymentAllocation
    // is never mutated (append-only reversal). Delegated to the dedicated service.
    if (strategy === "CANCEL_AND_REPLACE") {
      if (!input.replacement || input.replacement.lines.length === 0) {
        throw new CreditNoteVoidError(400, "REPLACEMENT_LINES_REQUIRED");
      }
      const repl = await cancelAndReplaceDocumentTx(tx, {
        organizationId: input.organizationId,
        chargeId: input.chargeId,
        reason: input.reason,
        replacementLines: input.replacement.lines,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
      });
      return {
        creditNoteId: null,
        creditNoteNumber: null,
        replacementDocumentId: repl.replacementDocumentId,
        replacementNumber: repl.replacementNumber,
        plainVoid: false,
      } as VoidWithCreditNoteResult;
    }

    // DEBIT_ADJUSTMENT (R2): correcting a paid invoice UPWARD. Mint a Debit Note
    // against the original receivable (raising it by adjustmentAmount) and grow
    // the charge's outstanding by the same amount. The PaymentAllocation rows are
    // NEVER touched — the collected money stays allocated to THIS charge; only
    // the amount owed on top of it grows. No CN, no void, no charge-status flip.
    if (strategy === "DEBIT_ADJUSTMENT") {
      // Validate the raise amount up front (independent of hasCollected — a DN
      // can raise the receivable on an unpaid posted charge too). Reject any
      // non-2dp / non-positive amount BEFORE it can key an idempotency slot or
      // mint a mis-scaled DN line.
      if (!/^\d+(\.\d{1,2})?$/.test(input.adjustmentAmount ?? "")) {
        throw new CreditNoteVoidError(400, "ADJUSTMENT_AMOUNT_INVALID");
      }
      const adjAmt = Number(input.adjustmentAmount);
      if (!Number.isFinite(adjAmt) || adjAmt <= 0) {
        throw new CreditNoteVoidError(400, "ADJUSTMENT_AMOUNT_INVALID");
      }
      const adjustmentAmount = adjAmt.toFixed(2);

      // Per-adjustment idempotency key. A caller-supplied token dedupes a TRUE
      // retry of the same adjustment; absent one, the key is charge+amount so
      // DIFFERENT amounts get DIFFERENT keys (a legitimate 2nd distinct
      // adjustment is NOT swallowed) while a same-amount replay without a token
      // still dedupes (the conservative default). This single key governs BOTH
      // the DN mint AND the outstanding-increment state change below.
      const dnKey = `dn:adjust:${input.idempotencyKey ?? `charge:${input.chargeId}:${adjustmentAmount}`}`;

      // REPLAY GUARD: if a DN already exists for this key, the whole state change
      // (increment + ChargeEvent + AuditLog) already ran on the first apply.
      // issueDocumentTx is itself idempotent (returns the existing doc), but the
      // relative `increment` + the events are NOT — so short-circuit here and
      // return the existing DN WITHOUT re-running any of them. This is the fix
      // for the double-count on replay (R2).
      const existingDn = await tx.billingDocument.findFirst({
        where: { organizationId: input.organizationId, idempotencyKey: dnKey },
        select: { id: true, documentNumber: true },
      });
      if (existingDn) {
        return {
          creditNoteId: null,
          creditNoteNumber: null,
          debitNoteNumber: existingDn.documentNumber,
          plainVoid: false,
        } as VoidWithCreditNoteResult;
      }

      // Resolve the original invoice/debit_note document + this charge's line,
      // reusing the SAME derivation idiom as the CN path (creditPostedChargeTx).
      // Pinned to the OLDEST matching line (orderBy createdAt asc) + never an
      // adjustment DN — a prior DEBIT_ADJUSTMENT mints another debit_note against
      // the same chargeId, and it must not shadow the real original document.
      const docLine = await tx.billingDocumentLine.findFirst({
        where: {
          chargeId: input.chargeId,
          document: {
            organizationId: input.organizationId,
            docType: { in: ["invoice", "debit_note"] },
            // Exclude adjustment DNs (they reference an original via
            // originalDocumentId); the true original is the head of the chain.
            originalDocumentId: null,
          },
        },
        // Pin the OLDEST matching document (BillingDocumentLine carries no
        // timestamp of its own, so order by the parent document's createdAt).
        orderBy: { document: { createdAt: "asc" } },
        select: {
          categoryId: true,
          document: {
            select: {
              id: true,
              counterpartyType: true,
              partyId: true,
              tenancyId: true,
              propertyId: true,
              apartmentId: true,
              listingId: true,
              billingMonth: true,
            },
          },
        },
      });
      // A DN must reference an original document (LHDN "Original e-Invoice
      // Reference Number"). A collected charge with NO document is a data-integrity
      // impossibility (money can't be allocated to an unissued charge) — fail loud.
      if (!docLine) throw new CreditNoteVoidError(400, "ORIGINAL_DOCUMENT_NOT_FOUND");
      if (!docLine.categoryId) {
        throw new Error(
          `INVARIANT_VIOLATION: charge ${input.chargeId}'s document line has no categoryId`,
        );
      }

      const dn = await issueDocumentTx(tx, {
        organizationId: input.organizationId,
        docType: "debit_note",
        seriesCode: "DN",
        counterpartyType: docLine.document.counterpartyType as "tenant" | "owner",
        partyId: docLine.document.partyId,
        tenancyId: docLine.document.tenancyId ?? undefined,
        propertyId: docLine.document.propertyId ?? undefined,
        apartmentId: docLine.document.apartmentId ?? undefined,
        listingId: docLine.document.listingId ?? undefined,
        billingMonth: docLine.document.billingMonth
          ? docLine.document.billingMonth.toISOString().slice(0, 10)
          : undefined,
        originalDocumentId: docLine.document.id,
        reason: input.reason,
        idempotencyKey: dnKey,
        lines: [
          {
            chargeId: input.chargeId,
            categoryId: docLine.categoryId,
            description: `Debit adjustment: ${input.reason}`,
            amount: adjustmentAmount,
            sstRate: "0",
          },
        ],
        actorUserId: input.actorUserId,
      });

      // Raise the receivable by the adjustment — outstanding += adjustmentAmount.
      // The PaymentAllocation row is deliberately NOT touched (R2). Runs EXACTLY
      // once per DN: the replay guard above returns before reaching here on any
      // retry of the same key.
      await tx.charge.update({
        where: { id: input.chargeId, organizationId: input.organizationId },
        data: { outstandingAmount: { increment: adjustmentAmount } },
      });
      await tx.chargeEvent.create({
        data: {
          organizationId: input.organizationId,
          chargeId: input.chargeId,
          eventType: "charge_debit_adjusted",
          eventAt: new Date(),
          actorUserId: input.actorUserId,
          payloadJson: {
            strategy: "DEBIT_ADJUSTMENT",
            reason: input.reason,
            debitNoteNumber: dn.documentNumber,
            adjustmentAmount,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: "billing-docs.debit_note.issue",
        entityType: "BillingDocument",
        entityId: dn.id,
        meta: {
          strategy: "DEBIT_ADJUSTMENT",
          originalDocumentId: docLine.document.id,
          chargeId: input.chargeId,
          debitNoteNumber: dn.documentNumber,
          adjustmentAmount,
          reason: input.reason,
        } as unknown as Prisma.InputJsonValue,
      });

      return {
        creditNoteId: null,
        creditNoteNumber: null,
        debitNoteNumber: dn.documentNumber,
        plainVoid: false,
      } as VoidWithCreditNoteResult;
    }

    // CREDIT_ADJUSTMENT: the collected portion becomes spendable CN credit.
    // REFUND: the returned money is NOT spendable — creditAmount = collected −
    // refund (a partial refund leaves the remainder as credit). Unpaid: 0.
    let creditAmount = "0.00";
    if (hasCollected && strategy === "CREDIT_ADJUSTMENT") creditAmount = collected;
    if (hasCollected && strategy === "REFUND" && input.refund) {
      creditAmount = (
        Math.round(Number(collected) * 100) / 100 -
        Math.round(Number(input.refund.amount) * 100) / 100
      ).toFixed(2);
    }

    const r = await creditPostedChargeTx(tx, {
      organizationId: input.organizationId,
      chargeId: input.chargeId,
      reason: input.reason,
      creditAmount,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
    });
    if (r.kind === "plain_void") {
      return { creditNoteId: null, creditNoteNumber: null, plainVoid: true } as VoidWithCreditNoteResult;
    }

    // Genuine refund (spec §4.3 fork 3): Refund Note referencing the ORIGINAL
    // document + a Refund row with the operational details. Same tx as the CN.
    let refundNoteNumber: string | undefined;
    if (hasCollected && strategy === "REFUND" && input.refund) {
      // Posted-only. This picks the payment the refund is BOOKED AGAINST, and an
      // unfiltered read takes the most RECENT allocation — which on a charge that
      // was really paid and later had an abandoned portal attempt is the dead
      // attempt, not the payment that brought the money in. The refund would then
      // reference a payment that never settled, and every downstream read keyed on
      // that paymentId (reversals, reconciliation) inherits the wrong parent.
      //
      // It also repairs the guard below: a phantom allocation satisfies
      // `!lastAlloc` and lets a refund through on a charge with no real payment
      // behind it. With the filter, that case correctly raises NO_PAYMENT_TO_REFUND.
      const lastAlloc = await tx.paymentAllocation.findFirst({
        where: { organizationId: input.organizationId, chargeId: input.chargeId, ...CASH_ALLOCATION_WHERE },
        orderBy: { allocatedAt: "desc" },
        select: { paymentId: true },
      });
      if (!lastAlloc) throw new CreditNoteVoidError(400, "NO_PAYMENT_TO_REFUND");
      const rn = await issueDocumentTx(tx, {
        organizationId: input.organizationId,
        docType: "refund_note",
        seriesCode: "RN",
        counterpartyType: r.counterpartyType,
        partyId: r.partyId,
        tenancyId: r.tenancyId ?? undefined,
        propertyId: r.propertyId ?? undefined,
        apartmentId: r.apartmentId ?? undefined,
        listingId: r.listingId ?? undefined,
        originalDocumentId: r.originalDocumentId,
        reason: input.reason,
        idempotencyKey: `rn:charge:${input.chargeId}`,
        lines: [
          {
            chargeId: input.chargeId,
            categoryId: r.categoryId,
            description: `Refund: ${input.reason}`,
            amount: Number(input.refund.amount).toFixed(2),
            sstRate: "0",
          },
        ],
        actorUserId: input.actorUserId,
      });
      await tx.refund.create({
        data: {
          organizationId: input.organizationId,
          refundNoteDocumentId: rn.id,
          originalPaymentId: lastAlloc.paymentId,
          amount: Number(input.refund.amount).toFixed(2),
          method: input.refund.method,
          bankRef: input.refund.bankRef ?? null,
          proofKey: input.refund.proofKey ?? null,
          refundedAt: new Date(input.refund.refundedAt),
          recordedById: input.actorUserId,
        },
      });
      await recordAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: "billing-docs.refund_note.issue",
        entityType: "BillingDocument",
        entityId: rn.id,
        meta: {
          creditNoteId: r.creditNoteId,
          originalDocumentId: r.originalDocumentId,
          chargeId: input.chargeId,
          amount: Number(input.refund.amount).toFixed(2),
          method: input.refund.method,
          refundNoteNumber: rn.documentNumber,
        } as unknown as Prisma.InputJsonValue,
      });
      refundNoteNumber = rn.documentNumber;
    }

    return {
      creditNoteId: r.creditNoteId,
      creditNoteNumber: r.creditNoteNumber,
      refundNoteNumber,
      plainVoid: false,
    } as VoidWithCreditNoteResult;
  });

  // Post-commit, never-throw (spec §4.6): CN issuance is transactional with the
  // void; ledger re-sync stays post-commit with the durable sync_failed marker.
  await syncOwnerLedgerForCharges(
    input.organizationId,
    input.actorUserId,
    input.actorRole,
    [input.chargeId],
  );
  await refreshDocumentStatusForCharges([input.chargeId]);

  return result;
}
