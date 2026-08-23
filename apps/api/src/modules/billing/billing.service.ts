import {
  chargesSummary,
  countCharges,
  createCharge,
  createChargeEvent,
  findActiveDuplicateCharge,
  findChargeById,
  findChargeByNumber,
  findChargeCategoryForCreate,
  findDocumentsByChargeIds,
  findIvownDocsByInvoiceIds,
  listCharges,
  listChargesForMonth,
  updateChargeStatus,
  type ChargesListFilters,
  type ChargesPagination,
} from "./billing.repository";
import type { BillingSession } from "./billing.types";
import type { z } from "zod";
import { createChargeSchema, postChargeSchema, voidChargeSchema } from "./billing.validation";
import {
  chargeDisplayStatus,
  chargeTrack,
  chargeCategoryLabel,
  OWNER_FALLBACK_CHARGE_TYPES,
} from "./charge-classify";
import { dashboardCache } from "../../lib/cache";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { getDb, Prisma } from "@kason/db";
import { firstOfMonthUtc } from "./auto-draft.repository";
import { issueDocumentsForChargesTx } from "../billing-documents/issue.service";
import {
  CreditNoteVoidError,
  voidPostedChargeWithCreditNote,
} from "../billing-documents/credit-notes.service";
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { assertOwnerBillingReady, OwnerBillingNotReadyError } from "../owner-billing/owner-billing-ready";

// Spec §4.8 gap: GET /billing/charges was unpaginated at 100+ unit scale.
// `pagination` is OPTIONAL and additive — undefined reproduces the OLD
// behavior byte-for-byte ({ data: <full list> }, no `total`). Passing it
// switches to a page slice + a sibling `total` count; `data` stays an array
// in both modes so existing full-list consumers (payments-page charge pool,
// the parked M5 draft-invoice-charge-picker) that never send page params are
// unaffected — they just ignore the extra `total` field when present.
export async function getChargesService(
  session: BillingSession,
  pagination?: ChargesPagination,
  filters?: ChargesListFilters,
) {
  if (!pagination) {
    return { data: await listCharges(session.orgId, undefined, filters) };
  }
  const [data, total] = await Promise.all([
    listCharges(session.orgId, pagination, filters),
    countCharges(session.orgId, filters),
  ]);
  return { data, total };
}

type MonthWindow = { monthStart: Date; monthEnd: Date };
function monthWindow(month: string): MonthWindow {
  const [y, m] = month.split("-").map(Number);
  return {
    monthStart: new Date(Date.UTC(y, m - 1, 1)),
    monthEnd: new Date(Date.UTC(y, m, 1)),
  };
}

/** First-of-month (UTC) of a Date — the guard's date reference for the admin post
 * path (Charge.billingMonth when set, else derived from Charge.dueDate). Named
 * distinctly from the `firstOfMonthUtc` imported above (auto-draft.repository's
 * helper takes a "YYYY-MM" string, not a Date — same concept, different signature,
 * so it can't share the name in this file). */
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

const isAgreementFeeType = (chargeType: string) =>
  chargeType === "tenancy_agreement_fee" || chargeType === "renewal_fee";

class AgreementFeePairPostError extends Error {
  readonly code = "TA_TAX_PAIR_POST_REQUIRES_COMPLETE_DRAFT_PAIR";
}

async function agreementFeePostMembersTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  requested: {
    id: string;
    chargeNumber: string;
    chargeType: string;
    parentChargeId: string | null;
    sstRate: { toString(): string } | null;
  },
) {
  const requestedIsTaxChild = requested.parentChargeId !== null && requested.chargeNumber.endsWith("-SST");
  const rootId = requestedIsTaxChild ? requested.parentChargeId! : requested.id;
  const members = await tx.charge.findMany({
    where: {
      organizationId,
      OR: [{ id: rootId }, { parentChargeId: rootId }],
    },
    select: {
      id: true,
      chargeNumber: true,
      chargeType: true,
      status: true,
      parentChargeId: true,
      invoiceId: true,
      sstRate: true,
    },
  });
  const parent = members.find((member) => member.id === rootId);
  if (!parent || !isAgreementFeeType(parent.chargeType) || parent.parentChargeId !== null) {
    throw new AgreementFeePairPostError("TA_TAX_PAIR_POST_REQUIRES_COMPLETE_DRAFT_PAIR");
  }
  const children = members.filter((member) =>
    member.parentChargeId === parent.id
    && member.chargeNumber === `${parent.chargeNumber}-SST`
    && member.chargeType === parent.chargeType,
  );
  const parentRate = parent.sstRate === null ? Number.NaN : Number(parent.sstRate.toString());
  if (children.length === 0 && parentRate === 0 && !requestedIsTaxChild) return [parent];
  if (
    children.length !== 1
    || parentRate !== 8
    || Number(children[0]!.sstRate?.toString() ?? "NaN") !== 0
    || parent.invoiceId === null
    || children[0]!.invoiceId !== parent.invoiceId
    || parent.status !== "draft"
    || children[0]!.status !== "draft"
  ) {
    throw new AgreementFeePairPostError("TA_TAX_PAIR_POST_REQUIRES_COMPLETE_DRAFT_PAIR");
  }
  return [parent, children[0]!];
}

/** Month-scoped header metrics for the charges v2 page (spec §3.1). */
export async function getChargesSummaryService(session: BillingSession, input: { month: string }) {
  const { monthStart, monthEnd } = monthWindow(input.month);
  return chargesSummary(session.orgId, monthStart, monthEnd);
}

/**
 * Single-charge lookup (R5b) — backs the unit-ledger void dialog, which needs
 * { id, chargeNumber, status } to open VoidChargeDialog for a charge-derived
 * ledger row. No prior single-GET endpoint existed for charges.
 */
export async function getChargeByIdService(session: BillingSession, chargeId: string) {
  const charge = await findChargeById(session.orgId, chargeId);
  if (!charge) return { ok: false as const, status: 404, error: "CHARGE_NOT_FOUND" };
  return {
    ok: true as const,
    status: 200,
    data: { id: charge.id, chargeNumber: charge.chargeNumber, status: charge.status },
  };
}

function isOwnerBilled(row: {
  categoryId: string | null;
  category: { family: string } | null;
  chargeType: string;
  invoice: { invoiceType: string } | null;
}): boolean {
  if (row.invoice?.invoiceType === "owner_statement") return true;
  if (row.category) return row.category.family === "owner_income";
  return (OWNER_FALLBACK_CHARGE_TYPES as readonly string[]).includes(row.chargeType);
}

export async function getChargesGroupedService(
  session: BillingSession,
  input: { month: string; groupBy: "unit" | "statement" },
) {
  const { monthStart, monthEnd } = monthWindow(input.month);
  const rows = await listChargesForMonth(session.orgId, monthStart, monthEnd);
  const docByCharge = await findDocumentsByChargeIds(rows.map((r) => r.id));

  const serialize = (r: (typeof rows)[number]) => ({
    id: r.id,
    chargeNumber: r.chargeNumber,
    partyName: r.party.displayName,
    tenancyCode: r.tenancy?.tenancyCode ?? null,
    chargeType: r.chargeType,
    categoryLabel: chargeCategoryLabel(r),
    track: chargeTrack(r),
    status: r.status,
    displayStatus: chargeDisplayStatus(r),
    dueDate: r.dueDate.toISOString(),
    amount: Number(r.amount.toString()),
    outstandingAmount: Number(r.outstandingAmount.toString()),
    currency: r.currency,
    documentId: docByCharge.get(r.id)?.id ?? null,
    documentNumber: docByCharge.get(r.id)?.documentNumber ?? null,
  });

  type Group = {
    key: string; kind: "unit" | "carpark" | "unassigned" | "statement" | "unattached";
    label: string; propertyName: string; apartmentId: string | null; subtitle: string;
    statementStatus: string | null; ivownDocumentId: string | null; ivownDocumentNumber: string | null;
    totals: { amount: number; outstanding: number; chargeCount: number };
    charges: ReturnType<typeof serialize>[];
  };
  const groups = new Map<string, Group>();
  const ensure = (key: string, init: Omit<Group, "totals" | "charges">) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...init, totals: { amount: 0, outstanding: 0, chargeCount: 0 }, charges: [] };
      groups.set(key, g);
    }
    return g;
  };
  const add = (g: Group, r: (typeof rows)[number]) => {
    g.charges.push(serialize(r));
    g.totals.amount += Number(r.amount.toString());
    g.totals.outstanding += Number(r.outstandingAmount.toString());
    g.totals.chargeCount += 1;
  };

  if (input.groupBy === "unit") {
    for (const r of rows) {
      if (r.unitId && r.unit) {
        const g = ensure(`unit:${r.unitId}`, {
          key: `unit:${r.unitId}`, kind: "unit",
          label: r.unit.apartment.unitCode, propertyName: r.unit.apartment.property.name,
          apartmentId: r.unit.apartment.id,
          subtitle: "", statementStatus: null, ivownDocumentId: null, ivownDocumentNumber: null,
        });
        if (!g.subtitle.includes(r.party.displayName)) {
          g.subtitle = g.subtitle ? `${g.subtitle} · ${r.party.displayName}` : r.party.displayName;
        }
        add(g, r);
      } else if (r.carparkId && r.carpark) {
        const g = ensure(`carpark:${r.carparkId}`, {
          key: `carpark:${r.carparkId}`, kind: "carpark",
          label: r.carpark.label, propertyName: "", apartmentId: null, subtitle: r.party.displayName,
          statementStatus: null, ivownDocumentId: null, ivownDocumentNumber: null,
        });
        add(g, r);
      } else {
        const g = ensure("unassigned", {
          key: "unassigned", kind: "unassigned", label: "Unassigned", propertyName: "", apartmentId: null,
          subtitle: "", statementStatus: null, ivownDocumentId: null, ivownDocumentNumber: null,
        });
        add(g, r);
      }
    }
  } else {
    const ownerRows = rows.filter(
      (r) => isOwnerBilled(r) && r.invoice?.invoiceType !== "tenant_rental",
    );
    const invoiceIds = [...new Set(ownerRows.map((r) => r.invoice?.id).filter((x): x is string => Boolean(x)))];
    const ivownByInvoice = await findIvownDocsByInvoiceIds(invoiceIds);
    for (const r of ownerRows) {
      if (r.invoice && r.invoice.invoiceType === "owner_statement") {
        const g = ensure(`statement:${r.invoice.id}`, {
          key: `statement:${r.invoice.id}`, kind: "statement",
          label: r.invoice.invoiceNumber, propertyName: "", apartmentId: null, subtitle: r.party.displayName,
          statementStatus: r.invoice.status,
          ivownDocumentId: ivownByInvoice.get(r.invoice.id)?.id ?? null,
          ivownDocumentNumber: ivownByInvoice.get(r.invoice.id)?.documentNumber ?? null,
        });
        add(g, r);
      } else {
        const g = ensure("unattached", {
          key: "unattached", kind: "unattached", label: "Unattached", propertyName: "", apartmentId: null,
          subtitle: "", statementStatus: null, ivownDocumentId: null, ivownDocumentNumber: null,
        });
        add(g, r);
      }
    }
  }

  return { month: input.month, groupBy: input.groupBy, groups: [...groups.values()] };
}

// Spec2 R1: thrown INSIDE the create transaction by the check-first dedup
// lookup, caught below and mapped to 409 DUPLICATE_CHARGE. Not exported —
// callers only ever see the { ok:false, ... } shape createChargeService returns.
class DuplicateChargeError extends Error {
  constructor(public existingChargeId: string) {
    super("DUPLICATE_CHARGE");
  }
}

export async function createChargeService(
  session: BillingSession,
  input: z.infer<typeof createChargeSchema>,
) {
  const duplicate = await findChargeByNumber(session.orgId, input.chargeNumber);
  if (duplicate) {
    return { ok: false as const, status: 409, error: "Charge number already exists" };
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false as const, status: 400, error: "Amount must be a valid positive number" };
  }

  // dueDate feeds the billingMonth slice below and is stored as new Date(dueDate).
  // The shared schema only checks z.string().min(1) (the ^\d{4}-\d{2}-\d{2}$ pin is
  // a deferred cross-package follow-up), so validate a REAL calendar date here —
  // shape alone is not enough: "2026-02-30" is well-shaped but new Date() rolls it
  // to Mar 2 while the slice buckets it in Feb (a cross-month dedup-key mismatch
  // that silently defeats the duplicate guard), and "2026-13-45" is shaped but
  // impossible (→ Invalid Date → 500). Parse the YYYY-MM-DD prefix and require it
  // to round-trip through a UTC date unchanged (rejects month>12 and day-overflow),
  // while still accepting a TZ-bearing ISO like "2026-07-01T00:00:00+08:00". The
  // prefix match alone would still let trailing garbage after a valid date prefix
  // through (e.g. "2026-07-01xyz" or "2026-07-01 garbage") — new Date() on those
  // is Invalid Date, which is then stored → a real DB rejects it → the same
  // "Invalid Date → 500" class this guard exists to prevent. Reject up front
  // whenever the WHOLE string fails to parse to a valid instant.
  const dueDateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.dueDate);
  if (!dueDateMatch || Number.isNaN(new Date(input.dueDate).getTime())) {
    return { ok: false as const, status: 400, error: "Due date must be a valid YYYY-MM-DD date" };
  }
  const dueYear = Number(dueDateMatch[1]);
  const dueMonth = Number(dueDateMatch[2]);
  const dueDay = Number(dueDateMatch[3]);
  const dueProbe = new Date(Date.UTC(dueYear, dueMonth - 1, dueDay));
  if (
    dueProbe.getUTCFullYear() !== dueYear ||
    dueProbe.getUTCMonth() !== dueMonth - 1 ||
    dueProbe.getUTCDate() !== dueDay
  ) {
    return { ok: false as const, status: 400, error: "Due date must be a valid YYYY-MM-DD date" };
  }

  // Category enforcement (accounting-docs P1, spec §4.2): only when
  // ENABLE_PHASE2_BILLING_DOCS is on. Flag-dark keeps the OLD behavior
  // byte-for-byte (categoryId ignored, stored null) so master stays inert.
  let categoryId: string | null = null;
  if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
    if (!input.categoryId) {
      return { ok: false as const, status: 400, error: "CATEGORY_REQUIRED" };
    }
    const category = await findChargeCategoryForCreate(session.orgId, input.categoryId);
    if (!category) return { ok: false as const, status: 400, error: "CATEGORY_NOT_FOUND" };
    if (!category.active) return { ok: false as const, status: 400, error: "CATEGORY_INACTIVE" };
    categoryId = category.id;
  }

  // Duplicate-charge prevention (Spec2 R1): billingMonth is now ALWAYS set
  // (first-of-month UTC of dueDate) — previously null on ad-hoc charges,
  // which made the Task-1 partial unique index a no-op for this path.
  //
  // TZ-safe by construction (Finding 2 fix): slice the literal "YYYY-MM"
  // prefix off the input string instead of routing through
  // `new Date(input.dueDate).toISOString()`. The Date() roundtrip converts
  // to UTC first, so a schema-valid TZ-bearing dueDate like
  // "2026-07-01T00:00:00+08:00" would shift to "2026-06-30T16:00:00Z" and
  // silently derive June instead of July — bypassing the compound dedup
  // guard (wrong-month check-first) and mis-filing the charge in the
  // matrix/UnitMonthLedger. A literal-prefix slice never shifts: it works
  // identically for bare "YYYY-MM-DD" and any TZ-bearing ISO string.
  const billingMonth = firstOfMonthUtc(input.dueDate.slice(0, 7));

  try {
    const charge = await getDb().$transaction(async (tx) => {
      // Compound check-first (organizationId, unitId, categoryId, billingMonth,
      // amount) — the primary guard. Only meaningful with BOTH a unit anchor and
      // a resolved category (matches the Task-1 index's predicate); unit-less
      // ad-hoc charges have no anchor to dedup against (documented exclusion).
      if (input.unitId && categoryId) {
        const dup = await findActiveDuplicateCharge(tx, session.orgId, {
          unitId: input.unitId,
          categoryId,
          billingMonth,
          amount,
        });
        if (dup) throw new DuplicateChargeError(dup.id);
      }

      const created = await createCharge(
        {
          organizationId: session.orgId,
          chargeNumber: input.chargeNumber,
          tenancyId: input.tenancyId || null,
          unitId: input.unitId || null,
          partyId: input.partyId,
          chargeType: input.chargeType,
          categoryId,
          description: input.description || null,
          dueDate: new Date(input.dueDate),
          billingMonth,
          amount,
          currency: input.currency || "MYR",
        },
        tx,
      );

      await createChargeEvent(
        {
          organizationId: session.orgId,
          chargeId: created.id,
          eventType: "charge_created",
          actorUserId: session.userId,
          payload: {
            chargeNumber: input.chargeNumber,
            amount,
            dueDate: input.dueDate,
          },
        },
        tx,
      );

      return created;
    });

    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    return { ok: true as const, status: 201, data: { id: charge.id } };
  } catch (err) {
    if (err instanceof DuplicateChargeError) {
      return {
        ok: false as const,
        status: 409,
        error: "DUPLICATE_CHARGE",
        existingChargeId: err.existingChargeId,
      };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race backstop: two concurrent creates both passed the in-tx check-first,
      // and the loser's INSERT violated a unique constraint. The tx has already
      // rolled back, so we're on the base connection and can re-query to classify.
      //
      // Why re-query, not err.meta.target: Prisma 7's driver adapter leaves
      // err.meta.target UNDEFINED (constraint name/columns live under the
      // undocumented err.meta.driverAdapterError.cause). Charge has exactly three
      // unique constraints — @@unique(organizationId, chargeNumber) and the two
      // partial dedup indexes — so re-running the same lookups the check-first path
      // uses classifies the violation without depending on Prisma's error internals.
      const numberDup = await findChargeByNumber(session.orgId, input.chargeNumber);
      if (numberDup) {
        return { ok: false as const, status: 409, error: "Charge number already exists" };
      }
      if (input.unitId && categoryId) {
        const dup = await findActiveDuplicateCharge(getDb(), session.orgId, {
          unitId: input.unitId,
          categoryId,
          billingMonth,
          amount,
        });
        if (dup) {
          return { ok: false as const, status: 409, error: "DUPLICATE_CHARGE", existingChargeId: dup.id };
        }
      }
      // P2002 fired but neither re-query found the row (e.g. the winning row was
      // voided in the microsecond between the failed insert and this re-query). It
      // was still a duplicate on a dedup constraint — return the clean 409, never
      // fail the backstop open to a 500.
      return { ok: false as const, status: 409, error: "DUPLICATE_CHARGE" };
    }
    throw err;
  }
}

export async function postChargeService(
  session: BillingSession,
  input: z.infer<typeof postChargeSchema>,
) {
  const existing = await findChargeById(session.orgId, input.chargeId);
  if (!existing) return { ok: false as const, status: 404, error: "Charge not found" };
  if (existing.status === "void") return { ok: false as const, status: 400, error: "Cannot post a void charge" };

  // Accounting docs (§4.2 mint-on-post): status flip + charge event + the
  // category-routed document (IVTEN invoice / DEP debit note) are ATOMIC —
  // a mint failure aborts the posting (§4.6), so a charge never becomes
  // visible without its document while the flag is on. The writes mirror
  // updateChargeStatus/createChargeEvent (billing.repository) exactly, on
  // the tx client instead of fresh connections.
  const db = getDb();
  try {
    await db.$transaction(async (tx) => {
      // R2 guard: block the draft→posted flip when the charge's unit is not
      // billing-ready. Fires BEFORE the status update — so a rejection rolls back
      // a clean, empty tx (no flip, no event, no doc mint). listingId null (a
      // non-unit charge) → no-op. No-op when ENABLE_PHASE2_OWNER_BILLING is dark.
      await assertOwnerBillingReady(tx, {
        orgId: session.orgId,
        scope: { kind: "listing", listingId: existing.unitId },
        asOf: existing.billingMonth ?? monthStartUtc(existing.dueDate),
      });
      const postMembers = isAgreementFeeType(existing.chargeType)
        ? await agreementFeePostMembersTx(tx, session.orgId, existing)
        : [existing];
      if (postMembers.length === 1) {
        await tx.charge.update({
          where: { id: input.chargeId },
          data: { status: "posted", postedAt: new Date() },
        });
      } else {
        const posted = await tx.charge.updateMany({
          where: {
            organizationId: session.orgId,
            id: { in: postMembers.map((member) => member.id) },
            status: "draft",
          },
          data: { status: "posted", postedAt: new Date() },
        });
        if (posted.count !== postMembers.length) {
          throw new AgreementFeePairPostError("TA_TAX_PAIR_POST_REQUIRES_COMPLETE_DRAFT_PAIR");
        }
      }
      for (const member of postMembers) {
        await tx.chargeEvent.create({
          data: {
            organizationId: session.orgId,
            chargeId: member.id,
            eventType: "charge_posted",
            eventAt: new Date(),
            actorUserId: session.userId,
            payloadJson: {
              previousStatus: member.status,
              nextStatus: "posted",
            },
          },
        });
      }
      if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
        await issueDocumentsForChargesTx(tx, postMembers.map((member) => member.id), session.userId);
      }
    });
  } catch (err) {
    if (err instanceof OwnerBillingNotReadyError) {
      return { ok: false as const, status: err.status, error: err.code };
    }
    if (err instanceof AgreementFeePairPostError) {
      return { ok: false as const, status: 409, error: err.code };
    }
    throw err;
  }

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  return { ok: true as const, status: 200, data: { id: input.chargeId } };
}

export async function voidChargeService(
  session: BillingSession,
  input: z.infer<typeof voidChargeSchema>,
) {
  const existing = await findChargeById(session.orgId, input.chargeId);
  if (!existing) return { ok: false as const, status: 404, error: "Charge not found" };

  // Spec §4.3: flag ON + posted-state charge → "Void & issue Credit Note" (one
  // tx: CN minted, original document offset, charge → credited, outstanding 0).
  // Drafts (and the flag-dark path below) void plainly — nothing was issued.
  if (
    isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") &&
    ["posted", "partially_paid", "paid"].includes(existing.status)
  ) {
    try {
      const r = await voidPostedChargeWithCreditNote({
        organizationId: session.orgId,
        chargeId: input.chargeId,
        reason: input.reason,
        strategy: input.strategy,
        // R2 DEBIT_ADJUSTMENT + R3 CANCEL_AND_REPLACE inputs (Task 11): forward
        // them so the service can mint the DN / replacement invoice. The credit-
        // notes service ignores whichever fields don't apply to the chosen strategy.
        adjustmentAmount: input.adjustmentAmount,
        idempotencyKey: input.idempotencyKey,
        replacement: input.replacement,
        paidHandling: input.paidHandling,
        refund: input.refund,
        actorUserId: session.userId,
        actorRole: session.role,
      });
      dashboardCache.invalidate(`dashboard:${session.orgId}`);
      return {
        ok: true as const,
        status: 200,
        data: {
          id: input.chargeId,
          creditNoteId: r.creditNoteId,
          creditNoteNumber: r.creditNoteNumber,
          refundNoteNumber: r.refundNoteNumber ?? null,
          // R2/R3 (Task 11): surface the DN + replacement identifiers so the
          // drawer can name the effect on success.
          debitNoteNumber: r.debitNoteNumber ?? null,
          replacementNumber: r.replacementNumber ?? null,
        },
      };
    } catch (err) {
      if (err instanceof CreditNoteVoidError) {
        return { ok: false as const, status: err.status, error: err.code };
      }
      throw err;
    }
  }

  if (existing.status === "paid") return { ok: false as const, status: 400, error: "Cannot void a paid charge" };

  await updateChargeStatus({
    chargeId: input.chargeId,
    status: "void",
    cancelledReason: input.reason,
    outstandingAmount: 0,
  });

  await createChargeEvent({
    organizationId: session.orgId,
    chargeId: input.chargeId,
    eventType: "charge_voided",
    actorUserId: session.userId,
    payload: {
      previousStatus: existing.status,
      nextStatus: "void",
      reason: input.reason,
    },
  });

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  // Flag-INDEPENDENT fix (spec §4.5): a plain void previously left the synced
  // owner-ledger row `active` — re-sync so the reverse pass (Task 9) voids it.
  // The hook itself no-ops unless ENABLE_PHASE2_OWNER_BILLING is on, never throws.
  await syncOwnerLedgerForCharges(session.orgId, session.userId, session.role, [input.chargeId]);
  return { ok: true as const, status: 200, data: { id: input.chargeId } };
}
