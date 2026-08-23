/**
 * Settle the owner's open IVOWN receivable lines when a tenant's RENT is fully paid.
 *
 * KAEN has always netted the management fee and owner-borne expenses out of the rent
 * before remitting — the owner ledger deducts them, and the payout the owner receives
 * is already net of both. What did NOT happen is the paperwork: the IVOWN invoice sat
 * "Unpaid" forever, so the document disagreed with money that had, in substance,
 * already been collected. An owner with three units saw three permanently-unpaid
 * management-fee invoices while KAEN had in fact been paid every one of them.
 *
 * This closes that gap at the moment the money arrives, along TWO rails — because the
 * IVOWN series carries two economically different things and settling both the same way
 * would double-charge the owner:
 *
 *   1. OFFSET (payable-consuming) — a bills-grid owner-borne charge nothing has
 *      deducted yet. It records the SAME non-cash OWNER_RECEIVABLE_OFFSET an admin can
 *      post by hand at POST /api/owner-receivable-offsets, through the SAME service,
 *      guards, advisory lock and audit trail. The only thing new here is the trigger.
 *
 *   2. LEDGER-BACKED SETTLEMENT (payable-NEUTRAL) — a statement charge (management fee,
 *      cleaning) that owner-ledger Source 2 has ALREADY deducted from the payout. The
 *      money moved; only the Charge was never settled, which is exactly why those
 *      invoices sat "Unpaid" forever. Settled on the plain charge rail with NO ledger
 *      entry of any kind. See settleLedgerBackedLines.
 *
 * Routing between them reads the charge's PERSISTED state (does an active owner-ledger
 * expense row exist for it?), never a flag — see findOpenIvownLines' double-deduct guard.
 *
 * ─── What it will and will not do ────────────────────────────────────────────────
 *
 * OFFSET settlement (rail 1 only) is capped by the owner's AVAILABLE PAYABLE
 * (recordOffsetService's OFFSET_EXCEEDS_PAYABLE guard): you can only write off a
 * receivable against money KAEN actually owes that owner. Consequences worth stating
 * plainly, because both look like bugs and are not:
 *
 *   • In a letting-commission month the payable is zero — the first month's rent is
 *     KAEN's, not the owner's — so nothing OFFSETS. Correct: there is no owner money
 *     to net against. Rail 2 still settles, since it consumes no payable.
 *   • When rent covers only part of what is owed, lines settle in priority order and
 *     the last one settles PARTIALLY. Charge.status becomes partially_paid via the
 *     ordinary settlement rail, exactly as a cash payment would leave it.
 *
 * Priority is KAEN's own fees first (management fee, then owner-borne letting-
 * commission SST), then third-party costs KAEN fronted. Within a priority band,
 * oldest document first, so a shortfall always lands on the same line given the same
 * data — a stable, explicable allocation rather than whatever order the DB returned.
 *
 * ─── Contract ────────────────────────────────────────────────────────────────────
 *
 * Mirrors its two siblings in afterPaymentSettled (owner-ledger.sync-hook.ts,
 * mgmt-fee-on-payment.hook.ts) deliberately:
 *   • runs OUT of the caller's transaction, AFTER it commits
 *   • SWALLOWS every error — settling a document must NEVER roll back a payment
 *   • leaves a durable AuditLog marker when it swallows something, so a missed
 *     settlement is detectable instead of vanishing into a console line
 *
 * UNCONDITIONAL (2026-08-16, operator decision: "when payout, IT MUST DEDUCT the
 * expenses from the current IVOWN"). This used to sit behind ENABLE_AUTO_OFFSET_ON_RENT,
 * default OFF — which meant the deduction KAEN has always performed in practice simply
 * did not happen in the system, and owners' IVOWN invoices sat Unpaid forever. There is
 * now exactly ONE way an owner-borne cost reaches the owner: billed on IVOWN, netted out
 * of the payout here. (The competing model — never invoice, deduct at ledger-sync time,
 * behind ENABLE_OWNER_BORNE_DEDUCT — was removed in the same change.)
 *
 * Still deliberately NOT gated on ENABLE_PHASE2_OWNER_REMITTANCE — that flag opens the
 * cash-remittance HTTP endpoints and carries its own open enablement gate.
 * recordOffsetService itself is not flag-gated (only the routes are), so this hook can
 * run without opening those endpoints.
 *
 * ORDER: must run AFTER issueMgmtFeeForPaidRent — that hook is what creates the very
 * management-fee lines this one settles. Running it first would find nothing to do
 * on the payment that generated the fee.
 */
import { createHash } from "node:crypto";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { recordOffsetService } from "../owner-remittance/owner-remittance.service";
import type { RemittanceActorCtx } from "../owner-remittance/owner-remittance.service";
import { computeAvailableOwnerPayableC } from "../owner-remittance/owner-remittance.repository";
import { applyAllocationToChargeTx } from "../payments/payments.repository";
import { refreshDocumentStatusForCharges } from "../billing-documents/status.service";

/**
 * KAEN's OWN revenue lines, settled before third-party costs (the operator's chosen
 * priority: the agency's fee is recovered first; owner-borne expenses absorb any
 * shortfall). A chargeType absent from this set is priority 1.
 */
const KAEN_FEE_CHARGE_TYPES = new Set(["management_fee", "letting_commission_sst"]);

/** Cents are the unit throughout this module, matching owner-remittance. */
const toCentsFromDecimalString = (s: string): number => Math.round(Number(s) * 100);
const centsToAmountString = (c: number): string => (c / 100).toFixed(2);

/**
 * Deterministic UUIDv5-shaped key over the triggering facts, so a retried
 * afterPaymentSettled replays (same key + same fingerprint → recordOffsetService
 * returns the prior result and writes nothing) while a genuinely different rent
 * settlement gets its own offset.
 *
 * Keyed on the RENT CHARGE IDS, not on (owner, month): an owner with several units
 * receives several rent payments in one month, and each must be free to settle more
 * lines. A month-scoped key would make the second payment replay the first and
 * silently settle nothing.
 *
 * ⚠️ AND on the TARGET LINES. Rent alone is not enough to identify the operation, because
 * the same collected rent is now a trigger TWICE: once when it arrives, and again when a
 * later bill issues a NEW owner receivable against the money already sitting in the
 * owner's payable. Both calls carry the same rent charge ids but different
 * `lineAllocations`, so a rent-only key produced a key COLLISION — matching key, different
 * `requestFingerprint` — and recordOffsetService correctly rejected it with
 * IDEMPOTENCY_KEY_REUSED, leaving the new IVOWN permanently unpaid while the owner's
 * payable still covered it. Including the lines makes the key describe what the offset
 * actually DOES: identical work replays, different work gets its own entry. Settling more
 * than KAEN owes stays impossible either way — `OFFSET_EXCEEDS_PAYABLE` re-reads the
 * available payable under the advisory lock and is the authority.
 */
function deterministicOffsetKey(orgId: string, ownerPartyId: string, triggeringChargeIds: string[], targetAllocations: string[]): string {
  const h = createHash("sha256")
    .update(`auto-offset:${orgId}:${ownerPartyId}:${[...triggeringChargeIds].sort().join(",")}:${[...targetAllocations].sort().join(",")}`)
    .digest("hex");
  // Stamp version (5) and RFC-4122 variant so the value is a well-formed UUID —
  // offsetCreateSchema validates it with z.string().uuid().
  const v = `${h.slice(0, 12)}5${h.slice(13, 16)}${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 32)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** Durable marker for a swallowed failure or a deliberate skip. Best-effort in its
 *  OWN try/catch so an audit-write failure can never re-throw into the money path. */
async function recordOffsetIssue(
  ctx: RemittanceActorCtx,
  action:
    | "owner-billing.auto_offset.failed"
    | "owner-billing.auto_offset.skipped"
    | "owner-billing.auto_offset.ledger_settled",
  entityId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await getDb().$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action,
        entityType: "OwnerLedgerEntry",
        entityId,
        meta,
      }),
    );
  } catch {
    // Never re-throw into the money path.
  }
}

type OpenLine = {
  billingDocumentLineId: string;
  chargeId: string;
  chargeType: string;
  outstandingC: number;
  issuedAt: Date;
};

/**
 * An open IVOWN line whose cost the owner ledger ALREADY deducted from the payout.
 * Settled on the plain charge rail with no payout entry — see settleLedgerBackedLines.
 */
type LedgerSettledLine = {
  billingDocumentLineId: string;
  chargeId: string;
  outstandingC: number;
  /** What Source 2 actually deducted. Caps the settlement — never settle more. */
  ledgerExpenseC: number;
};

/** The two economically distinct kinds of open line, split by findOpenIvownLines. */
type OpenLines = {
  /** Not yet deducted anywhere — the offset IS the deduction (consumes payable). */
  offsettable: OpenLine[];
  /** Already deducted by Source 2 — only the paperwork is outstanding (payable-neutral). */
  ledgerSettled: LedgerSettledLine[];
};

/**
 * The owner's open IVOWN receivable lines, in settlement order.
 *
 * Scoped exactly as recordOffsetService's own guard scopes a valid target — series
 * IVOWN, docType invoice, ledgerTreatment MANAGER_REVENUE, document party == owner —
 * so this never proposes a line the service would then 422 on.
 */
async function findOpenIvownLines(orgId: string, ownerPartyId: string): Promise<OpenLines> {
  // BillingDocument.seriesId is a PLAIN column — no Prisma relation to DocumentSeries
  // — so the series cannot be filtered inline. Resolve the org's IVOWN series first,
  // exactly as recordOffsetService's own guard does. Series is resolved CONFIGURATION
  // (an org may override the map), so this is a lookup, never a hard-coded id.
  const ivownSeries = await getDb().documentSeries.findFirst({
    where: { organizationId: orgId, code: "IVOWN" },
    select: { id: true },
  });
  const EMPTY: OpenLines = { offsettable: [], ledgerSettled: [] };
  if (!ivownSeries) return EMPTY; // org has no IVOWN series configured — nothing to settle

  const rows = await getDb().billingDocumentLine.findMany({
    where: {
      chargeId: { not: null },
      document: {
        organizationId: orgId,
        docType: "invoice",
        ledgerTreatment: "MANAGER_REVENUE",
        partyId: ownerPartyId,
        seriesId: ivownSeries.id,
      },
    },
    select: {
      id: true,
      chargeId: true,
      document: { select: { issuedAt: true } },
    },
  });
  if (rows.length === 0) return EMPTY;

  // Outstanding lives on the Charge, not the line. Resolved in one batched read;
  // a void/credited charge is not a settleable receivable.
  const charges = await getDb().charge.findMany({
    where: {
      organizationId: orgId,
      id: { in: rows.map((r) => r.chargeId!) },
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true, chargeType: true, outstandingAmount: true },
  });
  const chargeById = new Map(charges.map((c) => [c.id, c]));

  // ⚠️ MONEY — DOUBLE-DEDUCT GUARD. An IVOWN line is NOT automatically a cost the
  // owner still has to bear. Two economically different things share this series,
  // and they settle by DIFFERENT rails:
  //
  //   • A STATEMENT charge (management fee, cleaning) is ALREADY booked as an owner-
  //     ledger expense by owner-ledger.sync's Source 2, which deducts it from the
  //     payout. The IVOWN document is merely the tax invoice for a fee already
  //     netted. Offsetting it consumes payable a SECOND time — the owner is charged
  //     the management fee twice and their payout is short by exactly that fee.
  //     → settled payable-NEUTRALLY by settleLedgerBackedLines: the money already
  //       moved, only the Charge/document paperwork is outstanding.
  //
  //   • A bills-grid owner-borne charge is NOT a ledger expense. Nothing anywhere books
  //     one: owner-ledger.sync has no source that reads GridExpense-backed owner charges
  //     (the Source 6 that did, and the durable-XOR guard that kept it off charges with a
  //     live IVOWN line, were both removed with ENABLE_OWNER_BORNE_DEDUCT). Such a charge
  //     is billed on IVOWN and nothing has deducted it, so the offset IS its deduction.
  //     → settled by recordOffsetService, which consumes payable.
  //
  // ⚠️ The split above is decided by findOpenIvownLines' double-deduct guard reading the
  // charge's PERSISTED state — does an active OwnerLedgerEntry{direction:"expense",
  // sourceChargeId} exist? — never by a flag and never by charge type. Verify it that way
  // if you are auditing this; do not look for a flag, there has never been one here.
  //
  // Only the second kind may be OFFSET. Both kinds must still be SETTLED — dropping
  // the first is what left management-fee invoices permanently "Unpaid" while KAEN
  // had in fact already been paid out of the rent (this module's header case).
  //
  // This mirrors the XOR guard's own reasoning, read from the charge's PERSISTED
  // state rather than from any flag: does an active owner-ledger expense row already
  // exist for this charge, and for how much?
  const ledgerExpenseCByCharge = new Map<string, number>();
  for (const e of await getDb().ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      status: "active",
      direction: "expense",
      sourceChargeId: { in: charges.map((c) => c.id) },
    },
    select: { sourceChargeId: true, amount: true },
  })) {
    if (e.sourceChargeId === null) continue;
    // Sum, not overwrite: nothing forbids two active expense rows for one charge,
    // and the cap must reflect everything actually deducted.
    //
    // BASE ONLY — `sstAmount` is deliberately excluded. The ledger row carries the
    // document's aggregate SST (owner-ledger.sync attaches it to exactly one
    // management_fee row), but Charge.outstandingAmount is base-only, so folding SST
    // into the cap would license settling MORE than the charge's own base. The cap
    // exists to under-settle rather than over-settle when the two disagree.
    ledgerExpenseCByCharge.set(
      e.sourceChargeId,
      (ledgerExpenseCByCharge.get(e.sourceChargeId) ?? 0) + toCentsFromDecimalString(e.amount.toString()),
    );
  }

  const open: OpenLine[] = [];
  const ledgerSettled: LedgerSettledLine[] = [];
  for (const r of rows) {
    const charge = chargeById.get(r.chargeId!);
    if (!charge) continue;
    const outstandingC = toCentsFromDecimalString(charge.outstandingAmount.toString());
    if (outstandingC <= 0) continue; // nothing owed — already settled, by any rail
    const ledgerExpenseC = ledgerExpenseCByCharge.get(charge.id);
    if (ledgerExpenseC !== undefined) {
      // Already deducted from the payout — paperwork only, never a second deduction.
      ledgerSettled.push({
        billingDocumentLineId: r.id,
        chargeId: charge.id,
        outstandingC,
        ledgerExpenseC,
      });
      continue;
    }
    open.push({
      billingDocumentLineId: r.id,
      chargeId: charge.id,
      chargeType: charge.chargeType,
      outstandingC,
      issuedAt: r.document.issuedAt,
    });
  }

  // KAEN fees first, then oldest document, then line id — fully deterministic, so a
  // shortfall always lands on the same line for the same data.
  open.sort((a, b) => {
    const pa = KAEN_FEE_CHARGE_TYPES.has(a.chargeType) ? 0 : 1;
    const pb = KAEN_FEE_CHARGE_TYPES.has(b.chargeType) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const t = a.issuedAt.getTime() - b.issuedAt.getTime();
    if (t !== 0) return t;
    return a.billingDocumentLineId.localeCompare(b.billingDocumentLineId);
  });
  return { offsettable: open, ledgerSettled };
}

/**
 * Settle IVOWN lines whose cost the owner ledger has ALREADY deducted from the payout.
 *
 * ⚠️ MONEY — this rail is deliberately PAYABLE-NEUTRAL. It writes NO OwnerLedgerEntry:
 * no payout row, no offset, nothing that computeAvailableOwnerPayableC can see. The
 * deduction already happened (Source 2 booked the expense); the only thing missing is
 * that nothing ever settled the Charge, so the invoice read "Unpaid" against money KAEN
 * had in substance already collected. Adding a payout entry here would deduct the fee a
 * SECOND time — precisely the double-deduct the calling guard exists to prevent.
 *
 * Settlement goes through applyAllocationToChargeTx, the same guarded rail every payment
 * allocation uses: it re-reads outstanding inside the tx, asserts the charge belongs to
 * the expected party, refuses to exceed outstanding, and uses updatedAt-in-WHERE so a
 * concurrent writer loses rather than corrupts. ⚠️ It takes RINGGIT, not cents.
 *
 * Idempotent by construction — it settles `outstanding`, so a replay finds 0 outstanding
 * and the line is filtered out upstream before ever reaching here.
 *
 * Each line commits in its OWN transaction: one stale charge must not strand the others,
 * and none of this may hold a lock across the caller's payment path.
 *
 * ⚠️ Settling the Charge is only HALF of "the invoice is paid". BillingDocument.status /
 * settlementStatus is a PERSISTED projection that list views read directly; only the
 * document DETAIL view re-derives from charges. Skip the refresh and the two disagree —
 * the drawer says Paid while every list still says Unpaid. Every sibling rail refreshes
 * it (owner-remittance.service.ts:904 after an offset, all six payment paths, CN/DN,
 * meter), so this one does too, once per batch after the loop.
 */
async function settleLedgerBackedLines(
  ctx: RemittanceActorCtx,
  ownerPartyId: string,
  lines: LedgerSettledLine[],
): Promise<void> {
  const settledChargeIds: string[] = [];

  for (const line of lines) {
    // Never settle more than the ledger actually deducted. Equal in the ordinary case
    // (Source 2 books the expense FROM the charge amount); an adjustment can shrink the
    // expense, and the remainder is then a REAL receivable, not paperwork.
    const settleC = Math.min(line.outstandingC, line.ledgerExpenseC);
    if (settleC <= 0) continue;

    try {
      const applied = await getDb().$transaction((tx) =>
        applyAllocationToChargeTx(
          tx,
          ctx.orgId,
          line.chargeId,
          Number(centsToAmountString(settleC)), // ⚠️ RINGGIT — the rail's unit
          ownerPartyId,
        ),
      );
      if (applied.exceeded) {
        await recordOffsetIssue(ctx, "owner-billing.auto_offset.skipped", line.chargeId, {
          ownerPartyId,
          chargeId: line.chargeId,
          reason: "LEDGER_SETTLE_EXCEEDS_OUTSTANDING",
          attemptedC: settleC,
        });
        continue;
      }
      settledChargeIds.push(line.chargeId);
      await recordOffsetIssue(ctx, "owner-billing.auto_offset.ledger_settled", line.chargeId, {
        ownerPartyId,
        chargeId: line.chargeId,
        billingDocumentLineId: line.billingDocumentLineId,
        settledC: settleC,
        payableNeutral: true,
        reason: "already deducted from payout by owner-ledger Source 2 — paperwork only",
      });
    } catch (e) {
      // A StaleError/PartyMismatchError on ONE line must not stop the others, and must
      // never reach the payment path.
      await recordOffsetIssue(ctx, "owner-billing.auto_offset.failed", line.chargeId, {
        ownerPartyId,
        chargeId: line.chargeId,
        reason: (e as Error).message,
        rail: "ledger-backed settlement",
      });
    }
  }

  // ONE refresh for the whole batch, only for what actually settled. The projection is
  // per-DOCUMENT and these lines usually share one invoice, so refreshing per line would
  // re-derive the same document repeatedly; a charge whose settlement threw must not be
  // included, or the document could be re-derived as if it had settled.
  // Never throws (it is a best-effort projection, flag-gated on ENABLE_PHASE2_BILLING_DOCS
  // internally) — but it stays outside the per-line try/catch so a refresh failure is not
  // misfiled as a settlement failure.
  if (settledChargeIds.length > 0) {
    await refreshDocumentStatusForCharges(settledChargeIds);
  }
}

/**
 * For each newly settled source of owner money, net the owning owner's open IVOWN
 * lines against what KAEN now holds for them. Owner money includes fully-paid rent
 * and every posted partial/full deposit collection that has already been projected
 * as payable to the owner.
 *
 * `chargeIds` are the charges the payment touched — the same list the caller hands
 * the sibling hooks.
 */
export async function autoOffsetOwnerReceivablesForPaidRent(
  orgId: string,
  userId: string,
  role: string,
  chargeIds: string[] | null | undefined,
): Promise<void> {
  if (!chargeIds || chargeIds.length === 0) return;

  const ctx: RemittanceActorCtx = {
    orgId,
    actorUserId: userId,
    actorRole: role,
  };

  let currentOwnerPartyId: string | null = null;

  try {
    const db = getDb();

    // Rent remains a FULLY-paid trigger: a partial rent payment is not yet owner
    // payout money under the current business rule, and its management fee has not
    // been issued either.
    const rentCharges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        id: { in: chargeIds },
        chargeType: "rent",
        status: "paid",
      },
      select: {
        id: true,
        // Owner resolution mirrors the sibling hooks exactly: a unit charge resolves
        // via unit.ownerPartyId, a carpark charge via carpark.ownerPartyId.
        unit: { select: { ownerPartyId: true } },
        carpark: { select: { ownerPartyId: true } },
      },
    });

    // Deposits are different: KAEN transfers every amount collected to the owner,
    // including a partial collection. afterPaymentSettled records that collected
    // delta in Deposit BEFORE calling this hook, so computeAvailableOwnerPayableC
    // can safely use it without treating the deposit as income.
    const depositCharges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        id: { in: chargeIds },
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: { notIn: ["void", "credited"] },
      },
      select: {
        id: true,
        unit: { select: { ownerPartyId: true } },
        carpark: { select: { ownerPartyId: true } },
      },
    });

    const ownerFundCharges = [...rentCharges, ...depositCharges];
    if (ownerFundCharges.length === 0) return;

    // Collapse to the distinct owners whose funds just settled, carrying the charge
    // ids that triggered each — they key that owner's idempotency below.
    const byOwner = new Map<string, string[]>();
    for (const c of ownerFundCharges) {
      const owner = c.unit?.ownerPartyId ?? c.carpark?.ownerPartyId ?? null;
      if (!owner) continue;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)!.push(c.id);
    }
    if (byOwner.size === 0) return;

    const org = await db.organization.findFirst({
      where: { id: orgId },
      select: { defaultCurrency: true },
    });
    if (!org) return;

    for (const [ownerPartyId, triggeringChargeIds] of byOwner) {
      currentOwnerPartyId = ownerPartyId;

      const { offsettable, ledgerSettled } = await findOpenIvownLines(orgId, ownerPartyId);

      // Payable-NEUTRAL settlement first, and unconditionally: it needs no payable, so
      // it must NOT sit behind the availableC guard below. In a letting-commission month
      // the payable is zero yet the management fee was still deducted by Source 2 — its
      // paperwork has to settle regardless.
      await settleLedgerBackedLines(ctx, ownerPartyId, ledgerSettled);

      const openLines = offsettable;
      if (openLines.length === 0) continue; // nothing owed — ordinary, not worth an audit row

      // Size the offset against what KAEN actually owes this owner. Read here
      // WITHOUT the advisory lock purely to decide the allocation; recordOffsetService
      // re-reads it inside its own locked tx and its OFFSET_EXCEEDS_PAYABLE guard is
      // the authority. A racing write can only make this proposal too large, which
      // that guard then rejects cleanly — never too small in a way that overpays.
      const availableC = await db.$transaction((tx) =>
        computeAvailableOwnerPayableC(tx, orgId, ownerPartyId),
      );
      if (availableC <= 0) {
        // The commission-month case, and any month where the owner is already square.
        // Skipped silently: this is the expected steady state, not an anomaly.
        continue;
      }

      // Greedy allocation in priority order; the line that exhausts the payable
      // settles partially.
      let remainingC = availableC;
      const lineAllocations: { billingDocumentLineId: string; allocatedAmount: string }[] = [];
      for (const line of openLines) {
        if (remainingC <= 0) break;
        const allocC = Math.min(remainingC, line.outstandingC);
        if (allocC <= 0) continue;
        lineAllocations.push({
          billingDocumentLineId: line.billingDocumentLineId,
          allocatedAmount: centsToAmountString(allocC),
        });
        remainingC -= allocC;
        // offsetCreateSchema caps lineAllocations at 50.
        if (lineAllocations.length >= 50) break;
      }
      if (lineAllocations.length === 0) continue;

      const result = await recordOffsetService(ctx, {
        ownerPartyId,
        effectiveDate: new Date().toISOString().slice(0, 10),
        currency: org.defaultCurrency as "MYR",
        lineAllocations,
        memo: "Auto-settled from tenant funds held for owner payout",
        idempotencyKey: deterministicOffsetKey(
          orgId,
          ownerPartyId,
          triggeringChargeIds,
          // Include the amount as well as the line. A later deposit receipt may top
          // up a line that an earlier rent payment only settled partially. Using the
          // line id alone made that legitimate second offset collide with the first
          // idempotency key and left the expense yellow forever.
          lineAllocations.map((l) => `${l.billingDocumentLineId}:${l.allocatedAmount}`),
        ),
      });

      if (!result.ok) {
        // Every guard rejection lands here — OFFSET_EXCEEDS_PAYABLE from a racing
        // write, IDEMPOTENCY_KEY_REUSED, a stale charge. Nothing was written; record
        // it so an unsettled invoice is detectable rather than silent.
        await recordOffsetIssue(ctx, "owner-billing.auto_offset.failed", ownerPartyId, {
          ownerPartyId,
          triggeringChargeIds,
          reason: result.error,
          status: result.status,
          proposedLines: lineAllocations.length,
        });
      }
    }
  } catch (e) {
    await recordOffsetIssue(
      ctx,
      "owner-billing.auto_offset.failed",
      currentOwnerPartyId ?? chargeIds[0]!,
      {
        ownerPartyId: currentOwnerPartyId,
        reason: (e as Error).message,
      },
    );
  }
}

/**
 * The OTHER direction of the same rule: a NEW owner receivable was just issued for a unit
 * whose rent has ALREADY been collected.
 *
 * {@link autoOffsetOwnerReceivablesForPaidRent} fires when the money arrives, and settles
 * whatever IVOWN lines exist at that instant. It cannot settle a line that does not exist
 * yet — so an owner expense added AFTER the rent was banked (an admin amending the month,
 * a re-Bill adding a cost) issued an IVOWN that sat "Unpaid" against a payable that
 * already covered it, exactly the permanent-unpaid symptom this module was written to end.
 *
 * Same rails, same guards, same service — only the trigger is new. The rent charges are
 * re-derived rather than passed in, because at bill time nobody is holding a payment:
 * "has this unit's rent been collected?" is a question about persisted state.
 *
 * Deliberately NOT scoped to a billing month. `computeAvailableOwnerPayableC` is the
 * authority on what may be netted (recordOffsetService's OFFSET_EXCEEDS_PAYABLE re-reads
 * it under the advisory lock), so rent whose payable a previous offset already consumed
 * contributes nothing here — a month filter would add a second, weaker rule that could
 * only disagree with it.
 *
 * Best-effort and post-commit, exactly like its sibling: it must never roll back a Bill.
 */
export async function autoOffsetOwnerReceivablesForBilledApartment(
  orgId: string,
  userId: string,
  role: string,
  apartmentId: string,
): Promise<void> {
  try {
    const db = getDb();
    const listings = await db.listing.findMany({
      where: { organizationId: orgId, apartmentId },
      select: { id: true },
    });
    if (listings.length === 0) return;

    // Same predicate the sibling applies to the charges a payment touched: rent, and
    // FULLY paid. A part-paid rent is not yet the owner's money to net against.
    const paidRent = await db.charge.findMany({
      where: {
        organizationId: orgId,
        chargeType: "rent",
        status: "paid",
        unitId: { in: listings.map((l) => l.id) },
      },
      select: { id: true },
    });
    if (paidRent.length === 0) return;

    await autoOffsetOwnerReceivablesForPaidRent(orgId, userId, role, paidRent.map((c) => c.id));
  } catch (e) {
    // The sibling swallows into an audit row; so does this. A settlement problem must
    // never surface as a failed Bill.
    await recordOffsetIssue(
      { orgId, actorUserId: userId, actorRole: role },
      "owner-billing.auto_offset.failed",
      apartmentId,
      { apartmentId, reason: (e as Error).message, trigger: "billed-apartment" },
    );
  }
}
