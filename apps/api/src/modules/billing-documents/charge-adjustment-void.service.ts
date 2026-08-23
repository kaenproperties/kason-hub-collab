// apps/api/src/modules/billing-documents/charge-adjustment-void.service.ts
//
// Phase 4.1: VOID a charge-scoped credit/debit note (Phase 3.1's CREATE
// path), safe-default BLOCK. There are NO reversal rails for a spent
// CreditApplication or a Refund, so void is allowed only when the note has no
// such downstream settlement — otherwise 409. Never mutates/deletes issued
// history: void flips documentStatus ISSUED -> CANCELLED and reverses the
// linked charge's outstandingAmount; the note row, its lines, PDF, and
// document number are all untouched. Was TENANT-ONLY through Phase 4.1; seam
// #4 (owner-invoice-adjustments-enablement plan) removed the
// OWNER_VOID_NOT_SUPPORTED 403 once the owner payout correctly nets active
// notes and the frozen-period guard below is in place.
//
// Mirrors charge-adjustment.service.ts's structure (validation -> lock ->
// $transaction -> post-commit hooks -> P2002 defense-in-depth), with one
// deliberate addition: for a CREDIT NOTE void, this ALSO takes a
// `SELECT ... FOR UPDATE` on the note's own BillingDocument row, BEFORE the
// charge lock — mirroring credit-apply.service.ts's
// lockCreditNoteAndRecomputeAvailable, which locks the CN row before
// creating a CreditApplication. Without that note-row lock, a concurrent
// apply-credit against THIS EXACT note could insert a CreditApplication
// between this void's downstream-settlement read and its commit (the
// CreditApplication's target charge is normally a DIFFERENT charge than the
// one this note was minted against, so the charge-row lock alone does not
// serialize against it — verified against credit-apply.service.ts). Locking
// the note FIRST then the charge SECOND matches apply-credit's own lock
// order (note, then an implicit charge-row lock via its `charge.update`), so
// the two flows can never deadlock on reversed lock order. A debit-note void
// only ever needs the charge lock: its downstream guard reads
// charge.outstandingAmount directly, and every writer of that field
// (payments, the OTHER full-void-via-credit-note correction path) updates
// the SAME charge row, so the charge lock alone closes that race.
import { getDb, Prisma } from "@kason/db";
import { toCents, centsToString, type VoidChargeAdjustmentInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { refreshDocumentStatusForCharges } from "./status.service";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";
import { isExactTaTaxPairCharge } from "./ta-tax-pair.guard";

export type VoidChargeAdjustmentSession = { orgId: string; userId: string; role: string };
export type VoidChargeAdjustmentResult =
  | { ok: true; status: 200; data: { id: string; documentStatus: "CANCELLED" } }
  | { ok: false; status: number; error: string };

type TxOutcome =
  | { ok: true; status: 200; id: string; chargeId: string }
  | { ok: false; status: number; error: string };

export async function voidChargeAdjustmentService(
  session: VoidChargeAdjustmentSession,
  noteId: string,
  input: VoidChargeAdjustmentInput,
): Promise<VoidChargeAdjustmentResult> {
  const db = getDb();

  // Cheap pre-checks OUTSIDE any tx/lock (spec: "nothing written on reject") —
  // all fields read here (docType, originalDocumentId, line.chargeId,
  // counterpartyType) are IMMUTABLE once a BillingDocument is issued (issue.service.ts's
  // "no update/delete for financial fields" contract), so no TOCTOU risk reading them
  // pre-lock. Only documentStatus / charge.status / charge.outstandingAmount /
  // CreditApplication / Refund existence are re-verified INSIDE the tx after the lock.
  const note = await db.billingDocument.findFirst({
    where: { id: noteId, organizationId: session.orgId },
    select: {
      id: true,
      docType: true,
      originalDocumentId: true,
      counterpartyType: true,
      lines: { select: { chargeId: true } },
    },
  });
  if (!note || (note.docType !== "credit_note" && note.docType !== "debit_note")) {
    return { ok: false, status: 400, error: "NOT_A_NOTE" };
  }
  const chargeIds = [...new Set(note.lines.flatMap((line) => (line.chargeId ? [line.chargeId] : [])))];
  if (chargeIds.length > 1) {
    // The old implementation silently picked the first line then applied the
    // note's whole total to that one Charge.  Refuse any multi-charge note until
    // voiding can reverse every line atomically.
    return { ok: false, status: 409, error: "MULTI_CHARGE_NOTE_VOID_UNSUPPORTED" };
  }
  const chargeId = chargeIds[0];
  if (!note.originalDocumentId || !chargeId) {
    return { ok: false, status: 400, error: "NOT_CHARGE_SCOPED" };
  }
  const pairedTa = await db.$transaction((tx) =>
    isExactTaTaxPairCharge(tx, session.orgId, chargeId),
  );
  if (pairedTa) {
    return { ok: false, status: 409, error: "TAX_PAIR_CORRECTION_UNSUPPORTED" };
  }

  // Linked invoice's counterpartyType (LITERAL spec check — not note.counterpartyType,
  // which by construction always mirrors it for a well-formed note, but the linked
  // invoice is the authoritative source and this endpoint operates on ANY charge-scoped
  // CN/DN, tenant or owner). partyId is read here too (immutable once issued) for the
  // in-tx owner frozen-period guard below.
  const invoice = await db.billingDocument.findFirst({
    where: { id: note.originalDocumentId, organizationId: session.orgId },
    select: { id: true, counterpartyType: true, partyId: true },
  });
  if (!invoice) {
    throw new Error(`INVARIANT_VIOLATION: note ${noteId}'s originalDocumentId ${note.originalDocumentId} not found`);
  }

  const docType = note.docType as "credit_note" | "debit_note";

  try {
    const outcome = await db.$transaction(async (tx) => {
      // Lock ordering (see file header): credit_note locks the NOTE row FIRST
      // (mirrors credit-apply.service.ts's lockCreditNoteAndRecomputeAvailable),
      // THEN the charge row. debit_note only needs the charge row.
      if (docType === "credit_note") {
        await tx.$queryRaw`SELECT id FROM "BillingDocument" WHERE id = ${noteId}::uuid AND "organizationId" = ${session.orgId}::uuid FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM "Charge" WHERE id = ${chargeId}::uuid AND "organizationId" = ${session.orgId}::uuid FOR UPDATE`;
      if (await isExactTaTaxPairCharge(tx, session.orgId, chargeId)) {
        return {
          ok: false,
          status: 409,
          error: "TAX_PAIR_CORRECTION_UNSUPPORTED",
        } as TxOutcome;
      }

      // Re-read note, authoritative, AFTER the lock(s).
      const txNote = await tx.billingDocument.findFirst({
        where: { id: noteId, organizationId: session.orgId },
        select: { id: true, docType: true, documentStatus: true, total: true, creditAmount: true },
      });
      if (!txNote) return { ok: false, status: 400, error: "NOT_A_NOTE" } as TxOutcome;
      // Idempotency: already voided — 200 no-op, nothing re-written.
      if (txNote.documentStatus === "CANCELLED") {
        return { ok: true, status: 200, id: txNote.id, chargeId } as TxOutcome;
      }

      const charge = await tx.charge.findFirst({
        where: { id: chargeId, organizationId: session.orgId },
        select: { id: true, status: true, outstandingAmount: true, billingMonth: true },
      });
      if (!charge) {
        throw new Error(`INVARIANT_VIOLATION: charge ${chargeId} referenced by note ${noteId} not found`);
      }
      if (charge.status === "credited") {
        return { ok: false, status: 400, error: "CHARGE_FULLY_CREDITED_USE_CORRECTION" } as TxOutcome;
      }

      // R1 frozen-period guard, OWNER branch only — keyed on the LINKED owner
      // charge's billingMonth (never a client-supplied note date). In-tx: a
      // throw rolls back atomically. No-op when the live-ledger flag is off,
      // the period is open/absent, or billingMonth is unset.
      if (invoice.counterpartyType === "owner" && charge.billingMonth) {
        await assertPeriodOpen(tx, session.orgId, invoice.partyId, charge.billingMonth);
      }

      const noteTotalCents = toCents(txNote.total.toString(), "voidChargeAdjustment.total");
      const outstandingCents = toCents(charge.outstandingAmount.toString(), "voidChargeAdjustment.outstanding");

      // Downstream-settlement guard (safe-default BLOCK) — re-verified here with
      // FRESH, lock-protected reads.
      if (docType === "credit_note") {
        const creditApp = await tx.creditApplication.findFirst({
          where: { organizationId: session.orgId, creditDocumentId: noteId },
          select: { id: true },
        });
        if (creditApp) return { ok: false, status: 409, error: "NOTE_HAS_DOWNSTREAM_SETTLEMENTS" } as TxOutcome;

        const refundNote = await tx.billingDocument.findFirst({
          where: { organizationId: session.orgId, docType: "refund_note", originalDocumentId: noteId },
          select: { id: true },
        });
        if (refundNote) {
          const refund = await tx.refund.findFirst({
            where: { organizationId: session.orgId, refundNoteDocumentId: refundNote.id },
            select: { id: true },
          });
          if (refund) return { ok: false, status: 409, error: "NOTE_HAS_DOWNSTREAM_SETTLEMENTS" } as TxOutcome;
        }
      } else if (outstandingCents < noteTotalCents) {
        return { ok: false, status: 409, error: "NOTE_HAS_DOWNSTREAM_SETTLEMENTS" } as TxOutcome;
      }

      // Effect.
      let restoredOrRemovedCents: number;
      if (docType === "credit_note") {
        const creditAmtCents = toCents((txNote.creditAmount ?? "0").toString(), "voidChargeAdjustment.creditAmount");
        restoredOrRemovedCents = noteTotalCents - creditAmtCents;
        await tx.charge.update({
          where: { id: chargeId, organizationId: session.orgId },
          data: { outstandingAmount: centsToString(outstandingCents + restoredOrRemovedCents) },
        });
      } else {
        restoredOrRemovedCents = noteTotalCents;
        await tx.charge.update({
          where: { id: chargeId, organizationId: session.orgId },
          data: { outstandingAmount: centsToString(outstandingCents - restoredOrRemovedCents) },
        });
      }

      await tx.billingDocument.update({
        where: { id: noteId, organizationId: session.orgId },
        data: { documentStatus: "CANCELLED", reason: input.reason },
      });

      // Voiding the note changes the original invoice's adjusted totals — clear
      // its render-once PDF key so the next download re-renders without it.
      await tx.billingDocument.updateMany({
        where: { id: invoice.id, organizationId: session.orgId },
        data: { pdfKey: null },
      });

      await tx.chargeEvent.create({
        data: {
          organizationId: session.orgId,
          chargeId,
          eventType: "charge_adjustment_voided",
          eventAt: new Date(),
          actorUserId: session.userId,
          payloadJson: {
            noteId,
            kind: docType === "credit_note" ? "credit" : "debit",
            restoredOrRemovedCents,
            reason: input.reason,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "billing-docs.charge_adjustment.void",
        entityType: "BillingDocument",
        entityId: noteId,
        meta: {
          chargeId,
          kind: docType === "credit_note" ? "credit" : "debit",
          restoredOrRemovedCents,
          invoiceId: invoice.id,
          reason: input.reason,
        } as unknown as Prisma.InputJsonValue,
      });

      return { ok: true, status: 200, id: noteId, chargeId } as TxOutcome;
    });

    if (outcome.ok) {
      // Post-commit, never-throw (mirrors createChargeAdjustmentService's ordering).
      await refreshDocumentStatusForCharges([outcome.chargeId]);
      await syncOwnerLedgerForCharges(session.orgId, session.userId, session.role, [outcome.chargeId]);
      return { ok: true, status: 200, data: { id: outcome.id, documentStatus: "CANCELLED" } };
    }
    return { ok: false, status: outcome.status, error: outcome.error };
  } catch (e) {
    // Defense-in-depth (mirrors createChargeAdjustmentService) — no write in this
    // flow currently targets a unique-constrained column, so this is not expected
    // to fire under the CURRENT schema; kept for structural parity + future-proofing.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await db.billingDocument.findFirst({
        where: { id: noteId, organizationId: session.orgId },
        select: { id: true, documentStatus: true },
      });
      if (existing && existing.documentStatus === "CANCELLED") {
        return { ok: true, status: 200, data: { id: existing.id, documentStatus: "CANCELLED" } };
      }
      return { ok: false, status: 409, error: "DUPLICATE" };
    }
    throw e;
  }
}
