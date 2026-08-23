/**
 * CANCEL_AND_REPLACE (spec R3) — supersede a paid/collected invoice and MOVE the
 * allocation onto its replacement, atomically.
 *
 * The most correctness-critical correction: money + concurrency in ONE
 * transaction. Invoked from `voidPostedChargeWithCreditNote`'s CANCEL_AND_REPLACE
 * strategy branch, running INSIDE that caller's `db.$transaction`, so a failure
 * in ANY step here rolls the WHOLE correction back — no partial state.
 *
 * What it does (all in-tx):
 *  1. Load the original document via the charge's BillingDocumentLine. GUARD
 *     BEFORE any write: `documentStatus === "ISSUED"` (else 409
 *     DOCUMENT_NOT_ISSUED) and `taxStatus ∈ {NOT_REQUIRED, NOT_SUBMITTED}` (else
 *     409 TAX_SUBMITTED — a Phase-3 e-invoice-submission gate placeholder).
 *  2. Mint a REPLACEMENT invoice (new number) via `issueDocumentTx`, against a
 *     NEW Charge so the moved allocation has a real charge to attach to.
 *  3. MOVE each allocation on the original's charge: an append-only
 *     `PaymentAllocationReversal` (deterministic key `replace:<origDocId>:<allocId>`,
 *     amount = effective-allocated = allocatedAmount − Σ prior reversals) AND a
 *     NEW `PaymentAllocation` on the replacement's charge for the SAME amount. The
 *     original `PaymentAllocation` is NEVER mutated/deleted; the `Payment` row is
 *     NEVER touched (R5).
 *  4. Cancel the original: `documentStatus = "CANCELLED"`, `supersededByDocumentId
 *     = replacement.id`.
 *  5. Audit (`billing-docs.cancel_and_replace`).
 *
 * Decimal(12,2) throughout; cent-safe money math (round2) mirrors the reverse /
 * void-payment paths in payments.repository.ts.
 */
import { Prisma } from "@kason/db";
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import {
  applyAllocationToChargeTx,
  sumReversalsForAllocations,
} from "../payments/payments.repository";
import { CreditNoteVoidError } from "./credit-notes.service";
import { issueDocumentTx, type IssueLineInput } from "./issue.service";
import { isExactTaTaxPairCharge } from "./ta-tax-pair.guard";

// taxStatus values that still permit a cancel-and-replace (nothing legally
// submitted yet). Any other value (SUBMITTED / VALID / INVALID / CANCELLED) →
// 409 TAX_SUBMITTED.
const REPLACEABLE_TAX_STATUSES = new Set(["NOT_REQUIRED", "NOT_SUBMITTED"]);

// Half-up 2dp rounding for money math (mirrors payments.repository round2).
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type CancelAndReplaceInput = {
  organizationId: string;
  /** The original charge being corrected (its document is the one superseded). */
  chargeId: string;
  reason: string;
  /** The corrected line-set for the replacement invoice (min 1, validated by the caller schema). */
  replacementLines: { categoryId: string; description: string; amount: string }[];
  actorUserId: string;
  actorRole: string;
};

export type CancelAndReplaceResult = {
  replacementDocumentId: string;
  replacementNumber: string;
};

/**
 * Runs INSIDE the caller's transaction. Throws `CreditNoteVoidError` on a guard
 * failure (the caller maps {status, code} to HTTP); any thrown error — guard or
 * mid-mint — rolls the whole tx back.
 */
export async function cancelAndReplaceDocumentTx(
  tx: Prisma.TransactionClient,
  input: CancelAndReplaceInput,
): Promise<CancelAndReplaceResult> {
  if (await isExactTaTaxPairCharge(tx, input.organizationId, input.chargeId)) {
    throw new CreditNoteVoidError(409, "TAX_PAIR_CORRECTION_UNSUPPORTED");
  }
  if (input.replacementLines.length === 0) {
    throw new CreditNoteVoidError(400, "REPLACEMENT_LINES_REQUIRED");
  }

  // 1. Resolve the ORIGINAL invoice/debit_note document via this charge's line.
  //    Pin the head of the chain (oldest, non-adjustment) exactly like the
  //    DEBIT_ADJUSTMENT path, so a prior linked doc can't shadow the original.
  const docLine = await tx.billingDocumentLine.findFirst({
    where: {
      chargeId: input.chargeId,
      document: {
        organizationId: input.organizationId,
        docType: { in: ["invoice", "debit_note"] },
        originalDocumentId: null,
      },
    },
    orderBy: { document: { createdAt: "asc" } },
    select: {
      document: {
        select: {
          id: true,
          documentStatus: true,
          taxStatus: true,
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
  // A collected charge with NO original document is a data-integrity impossibility
  // (money can't be allocated to an unissued charge) — fail loud.
  if (!docLine) throw new CreditNoteVoidError(400, "ORIGINAL_DOCUMENT_NOT_FOUND");
  const original = docLine.document;

  // GUARDS — fire BEFORE any write.
  if (original.documentStatus !== "ISSUED") {
    throw new CreditNoteVoidError(409, "DOCUMENT_NOT_ISSUED");
  }
  if (!REPLACEABLE_TAX_STATUSES.has(original.taxStatus)) {
    throw new CreditNoteVoidError(409, "TAX_SUBMITTED");
  }

  // 2. Mint the replacement invoice against a NEW Charge. The charge carries the
  //    corrected total; its outstanding starts at the total and is drawn down as
  //    the moved allocation re-applies below. Deterministic chargeNumber keyed on
  //    the original doc → a replay never reaches here (the ISSUED guard already
  //    threw), and a legit collision would surface loudly rather than silently.
  const replacementTotal = input.replacementLines.reduce(
    (sum, l) => round2(sum + Number(l.amount)),
    0,
  );
  const newCharge = await tx.charge.create({
    data: {
      organizationId: input.organizationId,
      chargeNumber: `RPL-${original.id.slice(0, 8)}-${input.chargeId.slice(0, 8)}`,
      partyId: original.partyId,
      tenancyId: original.tenancyId,
      unitId: original.listingId,
      chargeType: "rental",
      status: "posted",
      description: `Replacement for ${input.reason}`,
      dueDate: new Date(),
      postedAt: new Date(),
      amount: replacementTotal.toFixed(2),
      currency: "MYR",
      outstandingAmount: replacementTotal.toFixed(2),
      billingMonth: original.billingMonth,
      // R6 lineage: the corrected charge points back at the original.
      parentChargeId: input.chargeId,
      // First line's category on the replacement (single-category corrections;
      // multi-category line-sets still route the DOC via issueDocumentTx per line).
      categoryId: input.replacementLines[0].categoryId,
    },
    select: { id: true },
  });

  const lines: IssueLineInput[] = input.replacementLines.map((l) => ({
    chargeId: newCharge.id,
    categoryId: l.categoryId,
    description: l.description,
    amount: Number(l.amount).toFixed(2),
    sstRate: "0",
  }));

  const replacement = await issueDocumentTx(tx, {
    organizationId: input.organizationId,
    docType: "invoice",
    counterpartyType: original.counterpartyType as "tenant" | "owner",
    partyId: original.partyId,
    tenancyId: original.tenancyId ?? undefined,
    propertyId: original.propertyId ?? undefined,
    apartmentId: original.apartmentId ?? undefined,
    listingId: original.listingId ?? undefined,
    billingMonth: original.billingMonth
      ? original.billingMonth.toISOString().slice(0, 10)
      : undefined,
    reason: input.reason,
    lines,
    actorUserId: input.actorUserId,
  });

  // 3. MOVE the allocations. Net any prior partial reversals (Task-4 idiom) so we
  //    never move more than the REMAINING effective-allocated balance — reversing
  //    the full allocatedAmount on top of a prior reversal double-counts.
  //
  //    CASH_ALLOCATION_WHERE: "move the allocations" means moving MONEY, and only
  //    a `posted` payment is money. An allocation can be live while carrying no
  //    cash at all — the portal creates one the moment a tenant uploads a transfer
  //    slip (status pending_approval), and rejectPaymentTx refuses that slip by
  //    flipping the Payment to "rejected" while RETAINING the allocation row.
  //    Reading them unfiltered moved those phantoms: applyAllocationToChargeTx
  //    below drew the replacement's outstanding DOWN by an amount that never
  //    arrived — under-billing the tenant, with nothing to notice it — and minted
  //    a reversal against credit no one ever posted. Reachable with no failure at
  //    all: this strategy applies to paid AND unpaid posted charges, and a refused
  //    slip leaves collected = 0, so no strategy guard stands in the way.
  //
  //    void/refunded payments need no separate handling: their allocations are
  //    already fully reversed, so the `amount <= 0` skip below would drop them
  //    anyway. This filter just stops them being fetched.
  //
  //    A non-cash allocation is LEFT BEHIND on the superseded charge rather than
  //    blocking the correction. For a refused slip that is simply right — it is
  //    dead. For one still awaiting verification it is a deliberate trade: a later
  //    approval settles a superseded charge, which is visible and fixable, whereas
  //    a new 409 here would add a fresh way for the correction to fail.
  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: input.organizationId, chargeId: input.chargeId, ...CASH_ALLOCATION_WHERE },
    select: { id: true, paymentId: true, allocatedAmount: true, prorateRatio: true },
  });
  const already = await sumReversalsForAllocations(
    tx,
    input.organizationId,
    allocs.map((a) => a.id),
  );
  let movedTotal = 0;
  const base = Date.now();
  for (let i = 0; i < allocs.length; i++) {
    const a = allocs[i];
    const amount = round2(Number(a.allocatedAmount.toString()) - (already.get(a.id) ?? 0));
    if (amount <= 0) continue; // fully reversed already — nothing to move
    // Append-only reversal fact on the ORIGINAL allocation (never mutated).
    // Deterministic key so a replay never double-writes.
    await tx.paymentAllocationReversal.create({
      data: {
        organizationId: input.organizationId,
        originalAllocationId: a.id,
        amount: amount.toFixed(2),
        reason: `cancel-and-replace: ${input.reason}`,
        reversedById: input.actorUserId,
        idempotencyKey: `replace:${original.id}:${a.id}`,
      },
    });
    // NEW allocation on the replacement's charge for the SAME amount — draws down
    // the replacement charge's outstanding via the guarded rail (updatedAt-checked,
    // over-outstanding → exceeded). The Payment row is NOT touched (R5).
    const applied = await applyAllocationToChargeTx(
      tx,
      input.organizationId,
      newCharge.id,
      amount,
      original.partyId,
    );
    if (applied.exceeded) {
      // The moved money exceeds the replacement's outstanding (replacement total <
      // moved amount). Abort the whole correction — a replacement must at least
      // cover the money already collected.
      throw new CreditNoteVoidError(409, "REPLACEMENT_TOTAL_TOO_LOW");
    }
    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: a.paymentId,
        chargeId: newCharge.id,
        allocatedAmount: amount.toFixed(2),
        prorateRatio: a.prorateRatio,
        allocatedAt: new Date(base + i),
      },
    });
    movedTotal = round2(movedTotal + amount);
  }

  // 4. Cancel the original: documentStatus CANCELLED + supersededByDocumentId.
  await tx.billingDocument.update({
    where: { id: original.id },
    data: { documentStatus: "CANCELLED", supersededByDocumentId: replacement.id },
  });

  // R6 lineage event on the reissued charge.
  await tx.chargeEvent.create({
    data: {
      organizationId: input.organizationId,
      chargeId: newCharge.id,
      eventType: "charge_reissued",
      eventAt: new Date(),
      actorUserId: input.actorUserId,
      payloadJson: {
        strategy: "CANCEL_AND_REPLACE",
        originalChargeId: input.chargeId,
        originalDocumentId: original.id,
        replacementDocumentId: replacement.id,
        replacementNumber: replacement.documentNumber,
        movedAmount: movedTotal.toFixed(2),
        reason: input.reason,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // 5. Audit.
  await recordAudit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing-docs.cancel_and_replace",
    entityType: "BillingDocument",
    entityId: original.id,
    meta: {
      strategy: "CANCEL_AND_REPLACE",
      originalChargeId: input.chargeId,
      originalDocumentId: original.id,
      replacementChargeId: newCharge.id,
      replacementDocumentId: replacement.id,
      replacementNumber: replacement.documentNumber,
      replacementTotal: replacementTotal.toFixed(2),
      movedAmount: movedTotal.toFixed(2),
      reason: input.reason,
    } as unknown as Prisma.InputJsonValue,
  });

  return {
    replacementDocumentId: replacement.id,
    replacementNumber: replacement.documentNumber,
  };
}
