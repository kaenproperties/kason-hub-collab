// apps/api/src/modules/billing-documents/charge-adjustment.service.ts
//
// Phase 3.1: charge-scoped CREATE credit/debit note (PARTIAL amounts). Mints
// a Debit Note (raises the receivable) or a Credit Note (reduces it, capped
// at the still-adjustable balance) against ONE charge's already-issued
// invoice line, without touching PaymentAllocations. Was TENANT-ONLY through
// Phase 4.1; seam #4 (owner-invoice-adjustments-enablement plan) removed the
// OWNER_ADJUSTMENT_NOT_SUPPORTED 403 once the owner payout correctly nets
// active notes (seam #1) and the frozen-period guard above is in place (seam
// #2) — the note's counterpartyType is derived from the linked document, so
// tenant docs still mint tenant notes and owner docs now mint owner notes.
//
// Mirrors two existing patterns rather than inventing a second correction
// wizard:
//   - credit-notes.service.ts's DEBIT_ADJUSTMENT branch: increment
//     outstanding, mint via issueDocumentTx, ChargeEvent + AuditLog, NEVER
//     touch charge.status, PaymentAllocations untouched.
//   - creditPostedChargeTx / overpayment-cn.service.ts: mirror the original
//     line's categoryId/description/sstRate onto the note line; row-lock
//     (SELECT ... FOR UPDATE, credit-apply.service.ts idiom) + a P2002
//     defense-in-depth catch for idempotency replay.
//
// The charge row lock is taken FIRST (before the credit-cap read) so two
// concurrent adjustments on the SAME charge serialize: under Postgres READ
// COMMITTED, the second transaction's post-lock reads see the first's
// already-committed notes, so the credit cap can never be double-spent by a
// race (this is a genuine gap the naive "read cap, then write" version has —
// verified against overpayment-cn.service.ts's identical concern).
import { getDb, Prisma } from "@kason/db";
import {
  toCents,
  centsToString,
  ACTIVE_ADJUSTMENT_NOTE_STATUSES,
  type ChargeAdjustmentInput,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { issueDocumentTx, lineSstCents, type IssueLineInput } from "./issue.service";
import { refreshDocumentStatusForCharges } from "./status.service";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { offsetCreditNoteAgainstOpenCharges } from "./credit-apply.service";
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { isExactTaTaxPairCharge } from "./ta-tax-pair.guard";

export type ChargeAdjustmentSession = { orgId: string; userId: string; role: string };

export type ChargeAdjustmentData = {
  id: string;
  documentNumber: string;
  docType: "debit_note" | "credit_note";
  creditAmount?: string;
};

export type ChargeAdjustmentResult =
  | { ok: true; status: 201; data: ChargeAdjustmentData }
  | { ok: false; status: number; error: string };

// Positive, max 2dp — no leading minus (unlike toCents' internal regex, which
// deliberately allows negatives for other callers). Matches the
// ADJUSTMENT_AMOUNT_INVALID precedent in credit-notes.service.ts.
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/**
 * The `-SST` sibling Charge of `baseChargeId` on document `documentId`, if any.
 *
 * ⚠️ MONEY — why this exists. `mintExpenseChargesTx` mints an SST-bearing charge as
 * TWO Charges: the base, and a sibling whose amount IS the tax (that sibling is what
 * makes the tax payable at all — see foldTaxLines' header). Adjusting the base alone
 * left the sibling holding the FULL original tax forever:
 *
 *   RM 1.00 @ 8%  →  base 1.00 + sibling 0.08
 *   credit RM 0.50 →  base outstanding 0.50, sibling STILL 0.08
 *                     tenant asked for 0.58; the credit note itself says 0.54
 *
 * The note already COMPUTES and DECLARES that RM 0.04 of tax relief (issueDocumentTx
 * derives it from the base line's own sstRate, and it is in the document's sstAmount
 * and total). What was missing was a line pointing at the sibling, so the money had
 * nowhere to land. This finds that sibling; the callers mirror the note onto it.
 *
 * Identified by BOTH `parentChargeId` AND the `isTax` flag on its line of the SAME
 * document — parentChargeId alone is not enough, because it is a generic parent link
 * that non-tax charges also use.
 */
async function findTaxSibling(
  tx: Prisma.TransactionClient,
  orgId: string,
  documentId: string,
  baseChargeId: string,
): Promise<{ chargeId: string; categoryId: string | null; description: string; outstandingCents: number } | null> {
  // TWO queries, not a nested filter: BillingDocumentLine.chargeId is a PLAIN column
  // with no Prisma relation to Charge (schema.prisma:2387), so `charge: {...}` is not
  // expressible in either `where` or `select` here.
  const taxLines = await tx.billingDocumentLine.findMany({
    where: { documentId, isTax: true, chargeId: { not: null } },
    select: { chargeId: true, categoryId: true, description: true },
  });
  if (taxLines.length === 0) return null;

  const sibling = await tx.charge.findFirst({
    where: {
      organizationId: orgId,
      parentChargeId: baseChargeId,
      id: { in: taxLines.map((l) => l.chargeId!) },
      // A voided/credited sibling holds no live receivable — moving it would resurrect
      // money the void already retired.
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true, outstandingAmount: true },
  });
  if (!sibling) return null;

  const line = taxLines.find((l) => l.chargeId === sibling.id)!;
  return {
    chargeId: sibling.id,
    categoryId: line.categoryId,
    description: line.description,
    outstandingCents: toCents(sibling.outstandingAmount.toString(), "chargeAdjustment.taxSibling"),
  };
}

/**
 * The extra note line that carries this adjustment's tax onto the sibling, plus the
 * sibling's new outstanding. Returns null when there is no tax to move.
 *
 * The line is `isTax: true` with `sstRate: "0"`, which is what keeps the DOCUMENT
 * arithmetic byte-identical: issue.service.ts:134 excludes an isTax line from
 * `subtotal`, and a "0" rate contributes nothing to `sstCents`. So subtotal, sstAmount
 * and total are exactly what they were before this line existed — the note still reads
 * "credit 0.50 + 0.04 SST = 0.54". Only the sibling CHARGE moves, which is the bug.
 *
 * `signum` is +1 for a debit note (sibling owes more) and −1 for a credit note.
 */
function taxSiblingMirror(
  sibling: { chargeId: string; categoryId: string | null; description: string; outstandingCents: number },
  noteAmount: string,
  baseSstRate: string,
  signum: 1 | -1,
): { line: IssueLineInput; nextOutstanding: string; taxCents: number } | null {
  const taxCents = lineSstCents(noteAmount, baseSstRate);
  if (taxCents === 0) return null;
  // Clamped at 0 for a credit: the sibling's outstanding can never go negative, in the
  // same way the base's `reduction` is min(amount, outstanding) below.
  const nextCents =
    signum === 1 ? sibling.outstandingCents + taxCents : Math.max(0, sibling.outstandingCents - taxCents);
  return {
    line: {
      chargeId: sibling.chargeId,
      categoryId: sibling.categoryId ?? undefined,
      description: sibling.description,
      amount: centsToString(taxCents),
      sstRate: "0",
      isTax: true,
    },
    nextOutstanding: centsToString(nextCents),
    taxCents,
  };
}

/**
 * True when `chargeId` is an `-SST` sibling that a note on its BASE charge would
 * already move — i.e. adjusting it directly would relieve the same tax twice.
 *
 * ⚠️ MONEY. The two reliefs do not cancel out. `taxSiblingMirror` clamps the sibling
 * Charge's outstanding at zero, so the receivable looks fine — but each note DECLARES
 * its own tax in its `sstAmount`/`total`, so an operator who credits both the base and
 * its SST row leaves the org declaring RM 0.16 of relief against RM 0.08 of tax it
 * ever charged. Wrong on the invoice, wrong in the owner ledger's note netting
 * (`net-adjustments-by-charge`), wrong to LHDN.
 *
 * The picker no longer offers the row (`adjustmentTargetLines`), but a stale tab or a
 * direct API call still can — hence a server-side gate rather than UI copy alone.
 *
 * The condition is the EXACT inverse of `findTaxSibling` + `taxSiblingMirror`, so the
 * two can never disagree about which rows are self-adjusting:
 *   • this charge has an `isTax` line on the linked document, AND
 *   • its `parentChargeId` has a non-tax line on that SAME document — an ORPHAN tax
 *     line (base invoiced elsewhere) is unreachable by any mirror and stays directly
 *     adjustable, and
 *   • that base line's rate is non-zero — a zero rate makes `taxSiblingMirror` a
 *     no-op, so blocking would strand the sibling.
 */
async function isMirroredTaxSibling(
  tx: Prisma.TransactionClient,
  documentId: string,
  chargeId: string,
  parentChargeId: string | null,
): Promise<boolean> {
  if (!parentChargeId) return false;
  const taxLine = await tx.billingDocumentLine.findFirst({
    where: { documentId, chargeId, isTax: true },
    select: { id: true },
  });
  if (!taxLine) return false;
  const baseLine = await tx.billingDocumentLine.findFirst({
    where: { documentId, chargeId: parentChargeId, isTax: false },
    select: { sstRate: true },
  });
  if (!baseLine) return false;
  return baseLine.sstRate.gt(0);
}

async function readExistingByIdempotencyKey(
  orgId: string,
  idempotencyKey: string,
): Promise<ChargeAdjustmentResult | null> {
  const db = getDb();
  const existing = await db.billingDocument.findFirst({
    where: { organizationId: orgId, idempotencyKey },
    select: { id: true, documentNumber: true, docType: true, creditAmount: true },
  });
  if (!existing) return null;
  return {
    ok: true,
    status: 201,
    data: {
      id: existing.id,
      documentNumber: existing.documentNumber,
      docType: existing.docType as "debit_note" | "credit_note",
      creditAmount: existing.docType === "credit_note" ? (existing.creditAmount?.toString() ?? "0.00") : undefined,
    },
  };
}

export async function createChargeAdjustmentService(
  session: ChargeAdjustmentSession,
  input: ChargeAdjustmentInput,
): Promise<ChargeAdjustmentResult> {
  // Cheap format check first — no DB hit, no row lock, for a malformed
  // request (spec: "nothing written on reject").
  if (!AMOUNT_RE.test(input.amount)) return { ok: false, status: 400, error: "AMOUNT_INVALID" };
  const amountCents = toCents(input.amount, "chargeAdjustment.amount");
  if (amountCents <= 0) return { ok: false, status: 400, error: "AMOUNT_INVALID" };

  const db = getDb();
  // This endpoint adjusts one logical charge.  Gross-inclusive TA / renewal fees
  // are represented by an exact base + SST pair, so the existing generic sibling
  // mirror is not a safe correction mechanism for them.  Guard before the lazy
  // category seed (which may write) and repeat inside the financial transaction.
  const pairedTa = await db.$transaction((tx) =>
    isExactTaTaxPairCharge(tx, session.orgId, input.chargeId),
  );
  if (pairedTa) {
    return { ok: false, status: 409, error: "TAX_PAIR_CORRECTION_UNSUPPORTED" };
  }
  // Kind-namespaced idempotency key: the prefix is ALWAYS applied (even over a
  // caller-supplied token), mirroring credit-notes.service.ts's `dn:adjust:`
  // idiom — this is deliberate, not a literal "use the caller's key verbatim"
  // reading of the spec: BillingDocument's unique constraint is
  // [organizationId, idempotencyKey] with NO docType component, so an
  // un-namespaced caller key shared between a debit and a credit call on the
  // same charge would silently collide (issueDocumentTx's own dedup check
  // would return the WRONG doc). Namespacing by kind closes that gap.
  const kindPrefix = input.kind === "credit" ? "cn" : "dn";
  const idemKey = `chgadj:${kindPrefix}:${input.idempotencyKey ?? `${input.chargeId}:${amountCents}`}`;

  // Charges the credit offset settled inside the tx — collected here so the
  // post-commit status refresh below covers THEIR documents too, not just the
  // adjusted charge's. Without this an invoice that a credit just paid off keeps
  // showing its stale settlement pill until something else touches it.
  const offsetChargeIds: string[] = [];

  // The debit branch mints on the "DN" series. ensureChargeCategorySeeds opens its OWN
  // connection (create-only, idempotent) so it runs BEFORE the tx — an existing org not yet
  // lazily re-seeded since DN was added would otherwise throw SERIES_NOT_FOUND (redesign P0).
  await ensureChargeCategorySeeds(session.orgId);

  try {
    const result = await db.$transaction(async (tx) => {
      // Row-lock the charge FIRST (see file header) — serializes concurrent
      // adjustments on the same charge before any cap computation.
      await tx.$queryRaw`SELECT id FROM "Charge" WHERE id = ${input.chargeId}::uuid AND "organizationId" = ${session.orgId}::uuid FOR UPDATE`;

      const charge = await tx.charge.findFirst({
        where: { id: input.chargeId, organizationId: session.orgId },
        select: {
          id: true,
          status: true,
          amount: true,
          outstandingAmount: true,
          billingMonth: true,
          // Read for isMirroredTaxSibling below — the link an `-SST` sibling carries
          // back to the charge it taxes.
          parentChargeId: true,
        },
      });
      if (!charge) return { ok: false as const, status: 400, error: "CHARGE_NOT_ADJUSTABLE" };
      if (await isExactTaTaxPairCharge(tx, session.orgId, charge.id)) {
        return {
          ok: false as const,
          status: 409,
          error: "TAX_PAIR_CORRECTION_UNSUPPORTED",
        };
      }
      if (!["posted", "partially_paid", "paid"].includes(charge.status)) {
        return { ok: false as const, status: 400, error: "CHARGE_NOT_ADJUSTABLE" };
      }

      // REPLAY GUARD (mirrors credit-notes.service.ts's DEBIT_ADJUSTMENT branch):
      // issueDocumentTx is itself idempotent (returns the existing doc instead of
      // inserting), but the outstanding increment/decrement + ChargeEvent + audit
      // below are NOT — without this short-circuit a replay would re-apply the
      // money movement a second time even though only one note ever exists.
      const existingNote = await tx.billingDocument.findFirst({
        where: { organizationId: session.orgId, idempotencyKey: idemKey },
        select: { id: true, documentNumber: true, docType: true, creditAmount: true },
      });
      if (existingNote) {
        return {
          ok: true as const,
          status: 201 as const,
          data: {
            id: existingNote.id,
            documentNumber: existingNote.documentNumber,
            docType: existingNote.docType as "debit_note" | "credit_note",
            creditAmount:
              existingNote.docType === "credit_note" ? (existingNote.creditAmount?.toString() ?? "0.00") : undefined,
          },
        };
      }

      // The charge's ORIGINAL invoice/debit_note line — pinned to the head of
      // the chain (originalDocumentId: null, oldest by document.createdAt),
      // mirroring the DEBIT_ADJUSTMENT lookup in credit-notes.service.ts. This
      // is essential: a PRIOR call to this same endpoint mints a new
      // BillingDocumentLine carrying the SAME chargeId, so an unfiltered
      // lookup could resolve a previous adjustment note as "the invoice".
      const docLine = await tx.billingDocumentLine.findFirst({
        where: {
          chargeId: charge.id,
          document: {
            organizationId: session.orgId,
            docType: { in: ["invoice", "debit_note"] },
            originalDocumentId: null,
          },
        },
        orderBy: { document: { createdAt: "asc" } },
        select: {
          categoryId: true,
          description: true,
          sstRate: true,
          document: {
            select: {
              id: true,
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
      if (!docLine) return { ok: false as const, status: 400, error: "NO_LINKED_INVOICE" };
      // R1 frozen-period guard, OWNER branch only — keyed on the LINKED owner
      // charge's billingMonth (never a client-supplied note date). In-tx: a
      // throw rolls back atomically. No-op when the live-ledger flag is off,
      // the period is open/absent, or billingMonth is unset (mirrors
      // insertStatementChargeAndRecompute's identical guard).
      if (docLine.document.counterpartyType === "owner" && charge.billingMonth) {
        await assertPeriodOpen(tx, session.orgId, docLine.document.partyId, charge.billingMonth);
      }
      if (!docLine.categoryId) {
        throw new Error(`INVARIANT_VIOLATION: charge ${charge.id}'s invoice line has no categoryId`);
      }

      const invoiceId = docLine.document.id;
      // ⚠️ MONEY. Refuse to adjust a row that adjusting its base already adjusts —
      // see isMirroredTaxSibling. Before any write, and before either branch, so
      // neither can mint a note that double-declares the same tax.
      if (await isMirroredTaxSibling(tx, invoiceId, charge.id, charge.parentChargeId)) {
        return { ok: false as const, status: 400, error: "CHARGE_IS_SST_SIBLING" };
      }
      const desc = docLine.description;
      const lineBase = {
        chargeId: charge.id,
        categoryId: docLine.categoryId,
        sstRate: docLine.sstRate.toString(),
        document: docLine.document,
      };

      if (input.kind === "debit") {
        const lines: IssueLineInput[] = [
          { chargeId: lineBase.chargeId, categoryId: lineBase.categoryId, description: input.description ?? `Adjustment: ${desc}`, amount: input.amount, sstRate: lineBase.sstRate },
        ];
        // ⚠️ MONEY. Carry this debit's tax onto the charge's `-SST` sibling, so the
        // tax the note already declares actually lands on the row that holds it.
        const debitSibling = await findTaxSibling(tx, session.orgId, invoiceId, charge.id);
        const debitMirror = debitSibling
          ? taxSiblingMirror(debitSibling, input.amount, lineBase.sstRate, 1)
          : null;
        if (debitSibling && debitMirror) {
          lines.push(debitMirror.line);
          await tx.charge.update({
            where: { id: debitSibling.chargeId, organizationId: session.orgId },
            data: { outstandingAmount: debitMirror.nextOutstanding },
          });
        }
        const dnDoc = await issueDocumentTx(tx, {
          organizationId: session.orgId,
          docType: "debit_note",
          seriesCode: "DN",
          counterpartyType: docLine.document.counterpartyType as "tenant" | "owner",
          partyId: docLine.document.partyId,
          tenancyId: docLine.document.tenancyId ?? undefined,
          propertyId: docLine.document.propertyId ?? undefined,
          apartmentId: docLine.document.apartmentId ?? undefined,
          listingId: docLine.document.listingId ?? undefined,
          billingMonth: charge.billingMonth ? charge.billingMonth.toISOString().slice(0, 10) : undefined,
          originalDocumentId: invoiceId,
          reason: input.reason,
          idempotencyKey: idemKey,
          lines,
          actorUserId: session.userId,
        });

        // increment is atomic; the row lock above additionally serializes any
        // cap computation elsewhere against this write.
        await tx.charge.update({
          where: { id: charge.id, organizationId: session.orgId },
          data: { outstandingAmount: { increment: input.amount } },
        });
        // The original invoice's cached PDF no longer matches its adjusted
        // totals — clear the render-once key so the next download re-renders
        // with this note (pdf.service model is adjustment-aware).
        await tx.billingDocument.updateMany({
          where: { id: invoiceId, organizationId: session.orgId },
          data: { pdfKey: null },
        });
        await tx.chargeEvent.create({
          data: {
            organizationId: session.orgId,
            chargeId: charge.id,
            eventType: "charge_adjusted",
            eventAt: new Date(),
            actorUserId: session.userId,
            payloadJson: {
              kind: "debit",
              amount: input.amount,
              reason: input.reason,
              debitNoteId: dnDoc.id,
              debitNoteNumber: dnDoc.documentNumber,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "billing-docs.charge_adjustment.issue",
          entityType: "BillingDocument",
          entityId: dnDoc.id,
          meta: {
            chargeId: charge.id,
            kind: "debit",
            amount: input.amount,
            invoiceId,
            reason: input.reason,
          } as unknown as Prisma.InputJsonValue,
        });

        return {
          ok: true as const,
          status: 201 as const,
          data: { id: dnDoc.id, documentNumber: dnDoc.documentNumber, docType: "debit_note" as const },
        };
      }

      // kind === "credit" — cap check first (nothing written if it fails).
      // adjustableCents = charge.amount + Σ(active DN note-line cents on THIS
      // charge) − Σ(active CN note-line cents on THIS charge). "Active" =
      // linked to invoiceId (originalDocumentId), documentStatus ISSUED, and
      // the note's line for THIS charge specifically (a sibling charge's note
      // on the same grouped invoice must not leak in).
      const activeNotes = await tx.billingDocument.findMany({
        where: {
          organizationId: session.orgId,
          originalDocumentId: invoiceId,
          docType: { in: ["credit_note", "debit_note"] },
          documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
          lines: { some: { chargeId: charge.id } },
        },
        select: { docType: true, lines: { where: { chargeId: charge.id }, select: { amount: true } } },
      });
      const notesCents = activeNotes.reduce((s, n) => {
        const lineCents = n.lines.reduce((ls, l) => ls + toCents(l.amount.toString(), "chargeAdjustment.note"), 0);
        return n.docType === "debit_note" ? s + lineCents : s - lineCents;
      }, 0);
      const chargeCents = toCents(charge.amount.toString(), "chargeAdjustment.charge");
      const adjustableCents = chargeCents + notesCents;
      if (amountCents > adjustableCents) {
        return { ok: false as const, status: 400, error: "CREDIT_EXCEEDS_ADJUSTABLE" };
      }

      const outstandingCents = toCents(charge.outstandingAmount.toString(), "chargeAdjustment.outstanding");
      const reduction = Math.min(amountCents, outstandingCents);
      const spendableCents = amountCents - reduction;

      await tx.charge.update({
        where: { id: charge.id, organizationId: session.orgId },
        data: { outstandingAmount: centsToString(outstandingCents - reduction) },
      });
      // The original invoice's cached PDF no longer matches its adjusted
      // totals — clear the render-once key so the next download re-renders
      // with this note (pdf.service model is adjustment-aware).
      await tx.billingDocument.updateMany({
        where: { id: invoiceId, organizationId: session.orgId },
        data: { pdfKey: null },
      });

      const lines: IssueLineInput[] = [
        { chargeId: lineBase.chargeId, categoryId: lineBase.categoryId, description: input.description ?? `Correction: ${desc}`, amount: input.amount, sstRate: lineBase.sstRate },
      ];
      // ⚠️ MONEY. Mirror of the debit branch: relieve the `-SST` sibling by this
      // credit's own tax. Without it the tenant keeps being billed the full original
      // SST on a charge that has been partly credited away — the note says 0.54, the
      // charges still add to 0.58. Placed AFTER the base's outstanding write above so
      // both charge updates land in the same transaction, all-or-nothing.
      const creditSibling = await findTaxSibling(tx, session.orgId, invoiceId, charge.id);
      const creditMirror = creditSibling
        ? taxSiblingMirror(creditSibling, input.amount, lineBase.sstRate, -1)
        : null;
      if (creditSibling && creditMirror) {
        lines.push(creditMirror.line);
        await tx.charge.update({
          where: { id: creditSibling.chargeId, organizationId: session.orgId },
          data: { outstandingAmount: creditMirror.nextOutstanding },
        });
      }
      const cnDoc = await issueDocumentTx(tx, {
        organizationId: session.orgId,
        docType: "credit_note",
        seriesCode: "CN",
        counterpartyType: docLine.document.counterpartyType as "tenant" | "owner",
        partyId: docLine.document.partyId,
        tenancyId: docLine.document.tenancyId ?? undefined,
        propertyId: docLine.document.propertyId ?? undefined,
        apartmentId: docLine.document.apartmentId ?? undefined,
        listingId: docLine.document.listingId ?? undefined,
        billingMonth: charge.billingMonth ? charge.billingMonth.toISOString().slice(0, 10) : undefined,
        originalDocumentId: invoiceId,
        creditAmount: centsToString(spendableCents),
        reason: input.reason,
        idempotencyKey: idemKey,
        lines,
        actorUserId: session.userId,
      });

      // `spendableCents` is the part of this credit that could NOT come off the
      // linked charge — because that charge was already (partly) paid, so the
      // credit is money owed back rather than a receivable reduction. Offset it
      // against this party's other open receivables now, oldest first.
      //
      // Without this the amount stranded on the note: nothing else applies credit
      // except the meter posting path (and only to charges created in that run),
      // so the tenant kept being asked for a balance that ignored credit they
      // already held. See offsetCreditNoteAgainstOpenCharges for the accounting.
      //
      // In-tx and atomic with the mint: a failure here rolls the note back too,
      // so we never commit a note whose offset half-applied. Anything left after
      // this stays on the note as a carried-forward credit balance, which the
      // next posting draws down via autoApplyOpenCredits.
      if (spendableCents > 0) {
        const offsetIds = await offsetCreditNoteAgainstOpenCharges(
          tx,
          session.orgId,
          {
            id: cnDoc.id,
            documentNumber: cnDoc.documentNumber,
            partyId: docLine.document.partyId,
            creditAmount: spendableCents / 100,
          },
          session.userId,
        );
        offsetChargeIds.push(...offsetIds);
      }
      await tx.chargeEvent.create({
        data: {
          organizationId: session.orgId,
          chargeId: charge.id,
          eventType: "charge_adjusted",
          eventAt: new Date(),
          actorUserId: session.userId,
          payloadJson: {
            kind: "credit",
            amount: input.amount,
            reason: input.reason,
            creditNoteId: cnDoc.id,
            creditNoteNumber: cnDoc.documentNumber,
            creditAmount: centsToString(spendableCents),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "billing-docs.charge_adjustment.issue",
        entityType: "BillingDocument",
        entityId: cnDoc.id,
        meta: {
          chargeId: charge.id,
          kind: "credit",
          amount: input.amount,
          invoiceId,
          reason: input.reason,
        } as unknown as Prisma.InputJsonValue,
      });

      return {
        ok: true as const,
        status: 201 as const,
        data: {
          id: cnDoc.id,
          documentNumber: cnDoc.documentNumber,
          docType: "credit_note" as const,
          creditAmount: centsToString(spendableCents),
        },
      };
    });

    if (result.ok) {
      // Post-commit, never-throw (mirrors voidPostedChargeWithCreditNote's
      // exact ordering) — the note mint is transactional with the charge
      // write; ledger re-sync + document-status refresh stay post-commit.
      //
      // `offsetChargeIds` rides along so a document the credit offset settles
      // has its own status re-derived in the same pass. De-duplicated because the
      // adjusted charge can itself be among them (a partly-paid charge takes the
      // reduction AND then some of the offset).
      const touchedChargeIds = [...new Set([input.chargeId, ...offsetChargeIds])];
      await refreshDocumentStatusForCharges(touchedChargeIds);
      await syncOwnerLedgerForCharges(session.orgId, session.userId, session.role, touchedChargeIds);
    }
    return result;
  } catch (e) {
    // Defense-in-depth (overpayment-cn.service.ts precedent): the charge row
    // lock above already serializes a same-charge replay through
    // issueDocumentTx's own dedup check, so this only fires for a genuine
    // cross-request race (e.g. a caller-supplied key reused across DIFFERENT
    // charges) or a bare retry that lands after the lock is released.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await readExistingByIdempotencyKey(session.orgId, idemKey);
      if (existing) return existing;
      return { ok: false, status: 409, error: "DUPLICATE" };
    }
    throw e;
  }
}
