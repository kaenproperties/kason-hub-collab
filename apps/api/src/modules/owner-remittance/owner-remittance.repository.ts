// Phase-2 owner remittance — repository rails. Pure data layer: payable(cents),
// advisory lock, idempotency read, entry/allocation writers. NO service
// orchestration, NO route handling, NO Zod parsing here (Tasks 6-9).
//
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md
// (Task 5). Spec: docs/superpowers/specs/2026-07-20-rental-reclassification-owner-payable-completion-design.md
// (R8/R9/R11/R12/R25; GC1-GC10).
//
// EVERY function below takes `tx: Prisma.TransactionClient` as its first
// argument and never calls getDb() internally — GC3 requires
// computeAvailableOwnerPayableC (and periodRemainingPayableC) to run inside
// the SAME locked transaction as the guard+write that follows.

import type { Prisma } from "@kason/db";
import { computeOwnerRunningBalance } from "@kason/shared";
import { signedToCents } from "../owner-ledger/owner-ledger.repository";
import { rowToLedgerLine } from "../owner-ledger/owner-ledger.types";
import { applyAllocationToChargeTx } from "../payments/payments.repository";

// ─── Advisory lock ────────────────────────────────────────────────────────────

/**
 * Owner-level advisory lock — serializes ALL of an owner's remittance/offset/
 * reversal writes against each other (and against a concurrent read of
 * payable). Mirrors owner-ledger.sync.ts:721's per-(owner,month) sync lock,
 * but scoped to the OWNER ONLY (no `:month` suffix — plan decision #4/GC3):
 * every money-mutating owner-remittance operation for one owner must
 * serialize with every OTHER one for that owner, not just same-month ones.
 *
 * MUST be called first, inside the caller's transaction, before any read of
 * available payable (GC3). pg_advisory_xact_lock is transaction-scoped —
 * automatically released on COMMIT/ROLLBACK.
 */
export async function lockOwnerPayable(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerPartyId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-remittance:${orgId}:${ownerPartyId}`}))`;
}

// ─── Available payable (cents) ────────────────────────────────────────────────

/**
 * Reversal-aware owner payable, in integer cents. The payable has TWO cash
 * sources which the owner statement already presents as one payout:
 *
 *   1. active OwnerLedgerEntry rows (rent/income less expenses/remittances), and
 *   2. tenant deposits collected for onward transfer to this owner.
 *
 * Deposits are deliberately not owner income and therefore do not belong in the
 * owner ledger. They are nevertheless cash payable to the owner, so excluding
 * them here made the remittance/offset guard disagree with the owner report:
 * the report showed deposit cash in Owner Payout while owner-borne expenses
 * could only consume the rent component. That left later owner expenses
 * partially paid even though the displayed Owner Payout still covered them.
 *
 * The ledger component reduces every `status:"active"` row through the SAME
 * pure-calc primitives resolveOwnerBalance uses (computeOwnerRunningBalance +
 * signedToCents). The deposit component sums append-only `released_to_owner`
 * deltas for units currently belonging to this owner; reversals are negative
 * deltas, so the sum is reversal-aware without mutating history. Task 3 made
 * computeOwnerRunningBalance reversal-aware: a payout row with
 * reversalOfEntryId set ADDS instead of subtracting, restoring payable
 * exactly; an included expense still deducts, an excluded one (owner-paid-
 * direct) does not.
 *
 * MUST run inside the SAME locked tx as the guard+write that follows (GC3) —
 * callers pass the tx obtained after lockOwnerPayable(tx, ...) on that SAME tx.
 */
export async function computeAvailableOwnerPayableC(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerPartyId: string,
): Promise<number> {
  const [rows, deposits] = await Promise.all([
    tx.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, ownerPartyId, status: "active" },
    }),
    tx.deposit.aggregate({
      where: {
        organizationId: orgId,
        status: "released_to_owner",
        unit: { ownerPartyId },
      },
      _sum: { amount: true },
    }),
  ]);
  const balance = computeOwnerRunningBalance(rows.map(rowToLedgerLine));
  const ledgerBalanceC = signedToCents(balance, "computeAvailableOwnerPayableC.ledger");
  const releasedDepositC = signedToCents(
    deposits._sum.amount?.toString() ?? "0.00",
    "computeAvailableOwnerPayableC.deposits",
  );
  return ledgerBalanceC + releasedDepositC;
}

// ─── Idempotency read ─────────────────────────────────────────────────────────

export type IdempotentEntryLookup = { id: string; requestFingerprint: string | null };

/**
 * Reads the (organizationId, settlementKind, idempotencyKey) unique
 * (schema.prisma Task-2 `@@unique`) for replay detection (GC6). The SERVICE
 * (Task 6) compares the returned requestFingerprint against the current
 * request's computed fingerprint: same → return the prior success, write
 * nothing; different → 409 IDEMPOTENCY_KEY_REUSED, write nothing.
 *
 * Deliberately NOT filtered by `status` — the unique index itself doesn't
 * care whether the matched row is later voided (status:"void", reachable via
 * the pre-existing Phase-1 manual-void endpoint, which is not GC5-aware for
 * Phase-2 rows), so this read must not silently ignore a voided match either:
 * if it did, the service would attempt a fresh INSERT with the same
 * (org, kind, key) triple and hit a raw P2002 instead of a clean replay
 * decision. Returns null only when NO row exists for this exact triple.
 */
export async function findEntryByIdempotency(
  tx: Prisma.TransactionClient,
  orgId: string,
  settlementKind: string,
  idempotencyKey: string,
): Promise<IdempotentEntryLookup | null> {
  return tx.ownerLedgerEntry.findFirst({
    where: { organizationId: orgId, settlementKind, idempotencyKey },
    select: { id: true, requestFingerprint: true },
  });
}

// ─── Payout entry writer ──────────────────────────────────────────────────────

export interface InsertPayoutEntryArgs {
  orgId: string;
  ownerPartyId: string;
  /**
   * NULLABLE on OwnerLedgerEntry as of Task 6a, no DB default, NO foreign-key
   * enforcement (grep-verified: only `organizationId` carries a real FK on
   * this table — every other id-shaped column, including this one, is a
   * "plain column" per the schema's own comments and every migration.sql
   * touching it). A Phase-2 remittance is OWNER-level and, per spec R9, may
   * legitimately allocate across MULTIPLE properties/units in one remittance,
   * or — as a PRE_STATEMENT_REMITTANCE — be created with ZERO allocations at
   * all (spec R9's third acceptance scenario). The `POST /owner-remittances`
   * request shape carries no property field whatsoever. There is therefore no
   * single value this repository can derive on its own without guessing; the
   * CALLER (Task 6/8 service) resolves and supplies it — `null` when the
   * remittance is not attributable to one property (the normal, expected case
   * for a cross-property or combined-scope payout), a real propertyId when it
   * legitimately IS single-property. This repository does NOT choose between
   * the two — that derivation logic is the caller's (Task 6), same
   * caller-supplied contract as ownerPartyId/createdById, just nullable.
   */
  propertyId: string | null;
  /** Optional pass-through — nullable, no FK. Natural pairing with propertyId
   *  when the caller resolves both from one allocation's period. */
  apartmentId?: string | null;
  /** "OWNER_REMITTANCE" | "PRE_STATEMENT_REMITTANCE" | "OWNER_RECEIVABLE_OFFSET" —
   *  plain string (no single shared TS union spans all three kinds yet;
   *  REMITTANCE_SETTLEMENT_KINDS in @kason/shared covers only the first two). */
  settlementKind: string;
  /** 2dp decimal string, matching OwnerLedgerEntry.amount's Decimal(12,2)
   *  column — already validated/positive-checked by the CALLER (Task 6). Not
   *  re-validated or magnitude-checked here. */
  amount: string;
  /** statementMonth is derived as the first-of-UTC-month of this date;
   *  transactionDate is set to this date exactly. */
  effectiveDate: Date;
  paymentMethod?: string | null;
  bankReference?: string | null;
  proofKey?: string | null;
  proofStatus?: string | null;
  memo?: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  createdById: string;
  updatedById: string;
  /**
   * Task 9 (append-only reversal) — set ONLY when this call is writing a
   * REVERSAL entry; omitted/undefined for every ordinary create (Task 6/8),
   * which is exactly the pre-Task-9 behavior (the column always resolved to
   * `null` there, since it was never part of `data` at all). One-way: the
   * ORIGINAL entry this points at is never itself updated to carry a
   * back-pointer — R11/schema.prisma:2623's own comment. The caller (Task 9's
   * reverseRemittanceService/reverseOffsetService) is responsible for every
   * reversal invariant (same settlementKind/amount as the original,
   * single-active-reversal, idempotency) — this writer just persists the
   * column verbatim, same "caller decides, repo persists" contract
   * `propertyId` documents above.
   */
  reversalOfEntryId?: string | null;
  /**
   * Redesign P1 (2026-07-23) — REM- display number, minted by the CALLER
   * (recordRemittanceService only, via mintDocumentNumberTx) and passed through
   * verbatim. Omitted/undefined for every other call site (recordOffsetService,
   * reverseRemittanceService, reverseOffsetService) — an offset or a reversal is
   * not new cash to the owner, so it is never numbered; `?? null` below is their
   * entire "no mint" contract. This writer makes no minting decision of its own.
   */
  remittanceNumber?: string | null;
}

/**
 * Inserts a `direction:"payout"` OwnerLedgerEntry for a Phase-2 settlement
 * (remittance / pre-statement remittance / offset) OR its reversal (Task 9 —
 * `reversalOfEntryId` set). Fixed, spec-mandated columns (never
 * caller-overridable): direction="payout", category=
 * "owner_payout" and paidBy="kaen" (the existing payout-shaped Zod refine in
 * schemas/owner-ledger.ts requires exactly these), includeInPayout=false
 * (spec R8), taxCategory="not_applicable" (OWNER_CATEGORY_DEFAULTS.owner_payout
 * in schemas/owner-ledger.ts), status="active", sourceType="manual" (the DB
 * default — this is not a sync-authored row; sourceChargeId/sourceUtilityBillId
 * stay null, so it never collides with the NULLS-DISTINCT unique indexes on
 * those pairs regardless of sourceType). sstAmount stays null (remittances
 * carry no SST breakdown).
 */
export async function insertPayoutEntry(
  tx: Prisma.TransactionClient,
  args: InsertPayoutEntryArgs,
): Promise<{ id: string }> {
  const statementMonth = new Date(
    Date.UTC(args.effectiveDate.getUTCFullYear(), args.effectiveDate.getUTCMonth(), 1),
  );

  return tx.ownerLedgerEntry.create({
    data: {
      organizationId: args.orgId,
      ownerPartyId: args.ownerPartyId,
      propertyId: args.propertyId,
      apartmentId: args.apartmentId ?? null,
      statementMonth,
      transactionDate: args.effectiveDate,
      direction: "payout",
      category: "owner_payout",
      amount: args.amount,
      paidBy: "kaen",
      taxCategory: "not_applicable",
      includeInPayout: false,
      sourceType: "manual",
      status: "active",
      settlementKind: args.settlementKind,
      paymentMethod: args.paymentMethod ?? null,
      bankReference: args.bankReference ?? null,
      proofKey: args.proofKey ?? null,
      proofStatus: args.proofStatus ?? null,
      memo: args.memo ?? null,
      idempotencyKey: args.idempotencyKey,
      requestFingerprint: args.requestFingerprint,
      reversalOfEntryId: args.reversalOfEntryId ?? null,
      remittanceNumber: args.remittanceNumber ?? null,
      createdById: args.createdById,
      updatedById: args.updatedById,
    },
    select: { id: true },
  });
}

// ─── Remittance allocation writer ─────────────────────────────────────────────

export interface RemittanceAllocationInput {
  ownerStatementPeriodId: string;
  allocatedAmountC: number;
}

/**
 * Bulk-inserts OwnerRemittanceAllocation rows linking one payout entry to one
 * or more OwnerStatementPeriods (cross-unit-same-owner allocation, spec R9).
 * Duplicate-sum-or-reject and per-period cap validation are the SERVICE's job
 * (Task 6/7) — this writer inserts exactly what it's given; a duplicate
 * `ownerStatementPeriodId` within one call surfaces as a real P2002 from the
 * `@@unique([organizationId, payoutEntryId, ownerStatementPeriodId])` index.
 */
export async function insertRemittanceAllocations(
  tx: Prisma.TransactionClient,
  orgId: string,
  payoutEntryId: string,
  allocations: RemittanceAllocationInput[],
  createdById: string,
): Promise<{ count: number }> {
  return tx.ownerRemittanceAllocation.createMany({
    data: allocations.map((a) => ({
      organizationId: orgId,
      payoutEntryId,
      ownerStatementPeriodId: a.ownerStatementPeriodId,
      allocatedAmountC: a.allocatedAmountC,
      createdById,
    })),
  });
}

// ─── Period remaining payable ─────────────────────────────────────────────────

/**
 * `netPayoutC − Σ ACTIVE allocations` for one OwnerStatementPeriod. An
 * allocation is ACTIVE iff its parent payout entry is ITSELF `status:"active"`
 * AND has NO active reversal (no OwnerLedgerEntry row exists with
 * `reversalOfEntryId` = that payout entry's id AND `status:"active"`) —
 * activity is DERIVED from the parent, never a mutable column on the
 * allocation itself (GC5). Both checks are required and independent: a
 * payout entry can leave the owner's active set either via an active
 * reversal row OR via being directly voided (status:"void", the pre-existing
 * Phase-1 manual-void endpoint — it flips status only, no reversal row is
 * created). This function's notion of "active" MUST agree with
 * computeAvailableOwnerPayableC's `status:"active"` filter above — checking
 * only the reversal case let a directly-voided payout's allocation keep
 * counting here while computeAvailableOwnerPayableC had already freed that
 * money at the owner level, so the two money reads diverged.
 *
 * Org-scoped: the period lookup filters by (id, organizationId) together, so
 * a period id belonging to a DIFFERENT organization never resolves — throws
 * rather than silently computing against foreign data.
 *
 * Zero-allocation periods return `netPayoutC` unchanged (an explicit early
 * return — summing an empty array would still be 0 either way, but the guard
 * documents the case explicitly and avoids ever routing through an
 * aggregate-style `null` that could otherwise propagate as NaN).
 */
export async function periodRemainingPayableC(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerStatementPeriodId: string,
): Promise<number> {
  const period = await tx.ownerStatementPeriod.findFirst({
    where: { id: ownerStatementPeriodId, organizationId: orgId },
    select: { netPayoutC: true },
  });
  if (!period) {
    throw new Error(
      `periodRemainingPayableC: OwnerStatementPeriod not found (org=${orgId}, id=${ownerStatementPeriodId})`,
    );
  }

  const allocations = await tx.ownerRemittanceAllocation.findMany({
    where: { organizationId: orgId, ownerStatementPeriodId },
    select: { payoutEntryId: true, allocatedAmountC: true },
  });
  if (allocations.length === 0) return period.netPayoutC;

  const payoutEntryIds = [...new Set(allocations.map((a) => a.payoutEntryId))];

  const activeParents = await tx.ownerLedgerEntry.findMany({
    where: { organizationId: orgId, id: { in: payoutEntryIds }, status: "active" },
    select: { id: true },
  });
  const activeParentIds = new Set(activeParents.map((p) => p.id));

  const activeReversals = await tx.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      status: "active",
      reversalOfEntryId: { in: payoutEntryIds },
    },
    select: { reversalOfEntryId: true },
  });
  const reversedPayoutIds = new Set(activeReversals.map((r) => r.reversalOfEntryId as string));

  const activeSumC = allocations
    .filter((a) => activeParentIds.has(a.payoutEntryId) && !reversedPayoutIds.has(a.payoutEntryId))
    .reduce((sum, a) => sum + a.allocatedAmountC, 0);

  return period.netPayoutC - activeSumC;
}

// ─── IVOWN receivable settlement (Task 8 — non-cash owner-receivable offset) ──

export interface SettleIvownChargeArgs {
  orgId: string;
  /** Passed straight through to applyAllocationToChargeTx's expectedPartyId —
   *  the SERVICE (Task 8) has already proven, via the owning BillingDocument,
   *  that this offset's ownerPartyId is the correct party for this charge. */
  ownerPartyId: string;
  offsetEntryId: string;
  chargeId: string;
  /**
   * Aggregated cents for this ONE charge. The CALLER (recordOffsetService)
   * MUST have already summed every offsetCreateSchema.lineAllocations entry
   * that resolved to this chargeId (B33: two lines on one charge, applied
   * separately, would raw-P2002 on the SECOND OwnerReceivableOffsetAllocation
   * insert — @@unique([organizationId, offsetEntryId, chargeId]) forbids two
   * rows for one (offset, charge) pair, schema.prisma:2700).
   */
  allocatedAmountC: number;
  /** Display/trace only (schema.prisma:2693) — the single billingDocumentLineId
   *  when exactly one line settled this charge, else null (ambiguous once the
   *  caller has aggregated more than one line onto the same charge). */
  billingDocumentLineId: string | null;
  createdById: string;
}

export type SettleIvownChargeResult =
  | { exceeded: true; chargeId: string; outstanding: number }
  | { exceeded: false; chargeId: string };

/**
 * Settles ONE already-aggregated charge for an owner-receivable offset —
 * called once per DISTINCT chargeId from recordOffsetService's per-line
 * validation/aggregation loop, never once per line (see allocatedAmountC's
 * own docstring above for why).
 *
 * ⚠️ UNIT BOUNDARY (a 100× money bug if got wrong): applyAllocationToChargeTx
 * (payments.repository.ts:418) is the SAME rail single/batch payment
 * allocation uses, and it takes its money argument in RINGGIT DECIMALS — its
 * own guard is `allocatedAmount > outstanding + 0.005`, comparing directly
 * against `Number(Charge.outstandingAmount.toString())`, i.e. RM. EVERY other
 * quantity in this Phase-2 module — this function's own `allocatedAmountC`
 * parameter, the OFFSET_EXCEEDS_PAYABLE guard, computeAvailableOwnerPayableC,
 * OwnerReceivableOffsetAllocation.allocatedAmountC — is integer CENTS.
 * Passing `allocatedAmountC` straight into the RM-expecting rail would settle
 * 100× too much (e.g. a 60.00 charge would be handed "6000", read as RM 6000,
 * and — since 6000 > 60.00 outstanding — actually report {exceeded:true}
 * instead of silently over-settling; the 100× bug therefore surfaces as a
 * WRONG 409 on a legitimate exact-payoff, which is exactly what
 * offset.integration.test.ts's exact_settle_unit_check pins). The `/ 100`
 * below is the ONE line that prevents this — never remove it without also
 * updating every caller's units.
 *
 * On success, writes the OwnerReceivableOffsetAllocation row (cents) — the
 * ONLY write this function performs besides the Charge update already inside
 * applyAllocationToChargeTx. Never creates a Payment/PaymentAllocation/receipt.
 */
export async function settleIvownChargeTx(
  tx: Prisma.TransactionClient,
  args: SettleIvownChargeArgs,
): Promise<SettleIvownChargeResult> {
  const applied = await applyAllocationToChargeTx(
    tx,
    args.orgId,
    args.chargeId,
    args.allocatedAmountC / 100, // cents -> RM: applyAllocationToChargeTx's own unit (see docstring above).
    args.ownerPartyId,
  );
  if (applied.exceeded) {
    return { exceeded: true, chargeId: args.chargeId, outstanding: applied.outstanding };
  }

  await tx.ownerReceivableOffsetAllocation.create({
    data: {
      organizationId: args.orgId,
      offsetEntryId: args.offsetEntryId,
      chargeId: args.chargeId,
      billingDocumentLineId: args.billingDocumentLineId,
      allocatedAmountC: args.allocatedAmountC,
      createdById: args.createdById,
    },
  });
  return { exceeded: false, chargeId: args.chargeId };
}
