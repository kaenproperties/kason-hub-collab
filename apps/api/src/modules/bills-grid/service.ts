// Bills & Expenses Grid — service layer (Task 5). The highest-risk task in the plan.
//
// This module reads/writes ONLY the five grid tables (UnitBillsGridEntry,
// UnitBillsBearerConfig, GridExpense, GridMeterReading, GridAttachment). It NEVER
// writes Charge / OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation (HARD
// CONSTRAINT 2 / C5), and NEVER calls buildComputeInputs (meter/service.ts:435, C6).
//
// The shared money engine (meter/compute.ts) is imported READ-ONLY, and its ONLY
// seam is the pure shapeUtilityPool adapter (shape.ts). It takes an additive
// `privateAircond` flag (PARTITIONED private per-room electricity); default false
// preserves the shared master-meter model byte-for-byte.
//
// Money contract, pinned by the integration suite:
//  • Save ≠ Bill. Save is a pure draft persist and NEVER invokes computeAllocation.
//  • Bill is terminal (billedAt) — no un-Bill, no void of an entry/reading/config.
//  • ownerBorne* is recorded from the RAW un-shaped inputs (C3), never from
//    ComputeResult.ownerBorneUtilitiesTotal (which understates), and is GROSS
//    (not net of the per-room aircond recovery).
//  • Bulk Bill is NON-atomic: each row bills in its OWN $transaction; a shaping /
//    compute failure is that row's `compute_error` inside a 200 manifest, never a 422.
//
// DEVIATIONS from the plan's literal excerpt (see docs / task-5-report.md), each
// non-money and proven:
//  1. `getDb()` (not `new PrismaClient()`): under Prisma 7 the datasource is
//     adapter-only, so `new PrismaClient()` throws. meter/service.ts:1 uses getDb.
//  2. The three CHILD tables store the month in a column named `periodMonth`
//     (verified against the generated client AND the live DB); the plan's
//     `billingMonth` would not compile. `billingMonth` survives ONLY as the WIRE
//     field on createExpensesSchema — resolved to the `periodMonth` column here.
import { getDb, Prisma } from "@kason/db";
import { randomUUID } from "node:crypto";
import { computeAllocation, ComputeError, type Bearers, type BillingMode, type ComputeResult, type PoolComponents, type RoomInput, type SubsidyPolicy } from "../meter/compute";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { createSignedDownloadUrl, deleteObject, objectExists, putObject, requireBucket } from "../../lib/storage";
import { computeProratedRent, pickBaseRent } from "../../lib/rent-math";
import { isCommissionMonth } from "../../lib/commission-month";
import { tenancyPeriodWhere, primaryTenancyForPeriod } from "../../lib/tenancy-period";
import { bearerDefaultsFor, DEFAULT_CLEANING_RECURRING_AMOUNT } from "./bearer-defaults";
import { invalidateDocumentPdfsForAttachment } from "../billing-documents/attachment-pdf-invalidation";
// R13 repair path, re-exported from the SEAM rather than imported directly by routes.ts.
// forbidden-writes.integration.test.ts allows billing-documents imports only in service.ts
// and issue-grouped.ts; that module boundary is worth more than saving one import hop.
export { retryGraduationForEntryService } from "../billing-documents/graduation-retry.service";
import { pendingGraduationEntryIds } from "../billing-documents/graduation-retry.service";
import { getOrCreateEntry, resolveRecurringForPeriod } from "./repository";
import { shapeUtilityPool, ShapeError } from "./shape";
import { classifyUtilityCharge, type ClassifyResult, type FundedBy, type Utility } from "./classify-utility";
import {
  GRID_UTILITY_CATEGORY_CODES, UTILITIES, UTILITY_DESCRIPTION, UTILITY_SPEC, UTILITY_SUPPLIER,
  ownerCategoryCode, tenantCategoryCode, type OwnerUtility,
} from "./utility-spec";
import { governingScalarKinds, isPeriodSnapshotSyncable, ownerStatementFrozen, resolveScalarNatures, type ScalarNatureEntry } from "./period-lock";
// GRID→OWNER-LEDGER SEAM (2026-07-29). Permitted by a NARROWED forbidden-writes exception —
// see forbidden-writes.integration.test.ts. This module still never writes OwnerLedgerEntry
// itself; it asks the owner-ledger module to re-derive from ALREADY-COMMITTED charges, which is
// what meter/, payments/ and inventory/ all do. Called POST-COMMIT only.
import { syncOwnerLedgerForApartmentMonth } from "../owner-ledger/owner-ledger.sync-hook";
// POST-COMMIT settlement of a freshly-issued owner receivable against rent already
// collected. Same seam as the owner-ledger sync beside it: called after the row's money
// tx commits, opens its own transaction, swallows its own failures.
import { autoOffsetOwnerReceivablesForBilledApartment } from "../owner-billing/auto-offset-on-rent.hook";
import type {
  GridBillTnbSubsidyBreakdownDto,
  GridBillUtilityPlanDto,
  GridBillUtilityPlanLineDto,
  GridRecurringDto,
  GridTnbSubsidyPolicy,
  RecurringLineDto,
} from "@kason/shared";
import {
  computeManagementFee,
  computeManagementFeeRentBase,
  effectiveWindowOverlapsBillingMonth,
  isInFreePeriod,
  resolveDocumentClassification,
} from "@kason/shared";
import { SCALAR_RECURRING_KINDS, SCALAR_RECURRING_KIND_LIST, isScalarRecurringKind, noScalarGovernance, type ScalarRecurringKind } from "@kason/shared";
import { emptySettlementCells, settlementBucketFor, type GridSettlementDto, type SettlementBucket, type SettlementState } from "@kason/shared";
// R11: the ONE definition of "this allocation represents money that actually
// arrived". The three reads below used to filter on nothing, so an abandoned FPX
// attempt — which mints a Payment("pending_approval") AND its allocations at
// initiate, settling no charge — read as cash: a false part-paid tick, a locked
// row, and a blocked re-Bill on a unit nobody paid for.
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
// Task 4 (bills-grid Bill → invoice): the ONLY grid→money seam, flag-gated by
// ENABLE_PHASE2_BILLING_DOCS. Task 6 (grid-scoped grouped invoice issuance)
// replaced the first-issuance call with `issueGroupedGridInvoiceTx`
// (issue-grouped.ts) — ONE itemized BillingDocument per counterparty instead
// of one document per charge — which itself calls `issueDocumentTx`, the SAME
// immutable issuance core the meter charge path uses (meter/service.ts:778).
// `issueDocumentsForChargesTx` (the per-charge issuer) is UNCHANGED and still
// used by the meter/shared-pool path; the grid no longer calls it directly.
// The `charge`-delegate access + `billing-documents` import this seam needs
// are DELIBERATELY exempted in forbidden-writes.integration.test.ts for BOTH
// service.ts (the flag-gated tx.charge.create below, Task 4) and
// issue-grouped.ts (Task 6's tx.charge.findMany + issueDocumentTx call) — see
// that file's allowance; the OwnerLedgerEntry / UnitUtilityBill /
// UtilityAllocation bans stay absolute in every file.
import { issueGroupedGridInvoiceTx, expenseSstChargeNumber } from "./issue-grouped";
import { CHARGE_TYPE_TO_CATEGORY_CODE } from "../billing-documents/issue.service";
import { resolveUtilitySubsidyPolicy } from "../meter/subsidy-policy";
import { assessPaidBlockers, type PaidBlocker } from "./rebill-assessment";
import { docsSafeToCancel } from "./owner-offset-settlement";
// The non-cash owner settlement rail. Read from the owner-remittance module, which owns
// both of its tables: bills-grid may not touch the `ownerLedgerEntry` delegate at all
// (HARD CONSTRAINT 2, enforced by __tests__/forbidden-writes.integration.test.ts), so the
// query lives on that side of the seam and the grid consumes a plain Map. Pure read.
import { activeOwnerOffsetByChargeId } from "../owner-remittance/owner-offset-reader";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
// bills-grid re-Bill supersede: the amend→re-Bill path issues ONE grouped
// BillingDocument per counterparty (N charges → 1 doc), so the re-Bill runs at the
// DOCUMENT level: previous-period / any-payment / confirmation guards (PRE-LOCK) →
// credit the old charges → re-mint + re-group-issue → cancel the old grouped doc(s).
// The ANY-PAYMENT block uses sumReversalsForAllocations for the net-of-reversal paid
// math (a fully-reversed allocation does NOT count as paid), so the grid never reverses
// a received payment — it refuses re-Bill and defers to the accounting reversal process.
// This is a billing/payment-module READ composed INSIDE the row tx — the same allowed
// seam as the issuance path (forbidden-writes STATIC guard permits the payments read +
// tx.charge writes in service.ts).
import { sumReversalsForAllocations } from "../payments/payments.repository";
// R1 (closed-period integrity): the shared owner-statement closed-period write guard.
// PURE READ — reads OwnerStatementPeriod and throws ClosedPeriodError; it writes NONE
// of the four money delegates. Wired into the flag-gated OWNER-borne charge mint
// (mintItemizedCharges) so a grid Bill dated into a FROZEN owner month is rejected at
// creation, before the sync-hook's void-only forward-reversal can silently drop it.
// This is the ONE owner-ledger import the forbidden-writes static guard exempts for
// this seam file (see forbidden-writes.integration.test.ts CLOSED_PERIOD_GUARD_MODULE).
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";
import { currentBillingMonthUTC, isBeyondAdvanceBillingWindow } from "../../lib/billing-month";
import { approveBulkService } from "../billing/auto-draft.service";

type Db = ReturnType<typeof getDb>;
const prisma: Db = getDb();

// meter/service.ts:46-50 declares this shape but does NOT export it. Redeclared here.
type Result<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };
const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });

export async function listSummaryNotesService(session: { orgId: string }, period: string) {
  const periodMonth = new Date(`${period.slice(0, 7)}-01T00:00:00.000Z`);
  const items = await getDb().billsGridSummaryNote.findMany({
    where: { organizationId: session.orgId, periodMonth },
    select: { apartmentId: true, note: true, updatedAt: true },
  });
  return { items: items.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })) };
}

export async function saveSummaryNoteService(
  session: { orgId: string; userId?: string },
  apartmentId: string,
  input: { period: string; note: string },
): Promise<Result<{ apartmentId: string; note: string; updatedAt: string }>> {
  const db = getDb();
  const apartment = await db.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId }, select: { id: true } });
  if (!apartment) return { ok: false, status: 404, error: "APARTMENT_NOT_FOUND" };
  const periodMonth = new Date(`${input.period.slice(0, 7)}-01T00:00:00.000Z`);
  const saved = await db.billsGridSummaryNote.upsert({
    where: { organizationId_apartmentId_periodMonth: { organizationId: session.orgId, apartmentId, periodMonth } },
    create: { organizationId: session.orgId, apartmentId, periodMonth, note: input.note, updatedById: session.userId ?? null },
    update: { note: input.note, updatedById: session.userId ?? null },
    select: { apartmentId: true, note: true, updatedAt: true },
  });
  return ok({ ...saved, updatedAt: saved.updatedAt.toISOString() });
}
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

const num = (v: Prisma.Decimal | null | undefined): number => (v == null ? 0 : Number(v.toString()));
const toMonth = (s: string): Date => new Date(`${s.slice(0, 7)}-01T00:00:00.000Z`);
/** `YYYY-MM-DD` — the @db.Date wire format used everywhere in this module. */
const iso = (d: Date): string => d.toISOString().slice(0, 10);
/** Half-up to 2 decimals. Mirrors meter/compute.ts's `round2` (that file is byte-frozen; not imported from it). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// BillOutcome + PaidBlocker now live in @kason/shared (constants/bill-outcomes.ts) so the API
// and the web share ONE declaration — the API-side assertNever test could never see the
// web's hand-copied union. Re-exported so every existing `from "./service"` import is unchanged.
import type { BillOutcome } from "@kason/shared";
export type { BillOutcome };
export interface BillRowResult {
  apartmentId: string; outcome: BillOutcome; entryId?: string; ownerBorneRecorded?: string;
  // Populated ONLY on rebill_confirmation_required — the live tenant/owner invoice
  // numbers the admin is being asked to void+reissue (drives the confirmation modal).
  existingTenantInvoiceNumber?: string | null; existingOwnerInvoiceNumber?: string | null;
  // Also rebill_confirmation_required, and only meaningful once partial re-bill is on:
  // WHICH lines survive the re-Bill and which are replaced. Before this, the dialog showed
  // only the invoice numbers, which after partial re-bill is actively misleading — an
  // admin could not tell that a paid line stays exactly as it is.
  keptPaidLines?: { description: string; amount: number; documentNumber: string | null }[];
  // Populated ONLY on rebill_blocked_payment_exists — the paid/partially-paid invoice(s) that
  // block the re-Bill: counterparty, invoice number, paid amount, and paid-vs-partial state.
  // Read-only detail; the block itself mutates nothing (see rebill-assessment.ts).
  paidBlockers?: PaidBlocker[];
  // Stable failure code forwarded onto the manifest so the admin sees WHY a row failed.
  // ComputeError/ShapeError → AIRCON_EXCEEDS_TNB/TNB_UNDERSHOOT; ServiceError →
  // ABSORBED_REQUIRES_OWNER_BORNE; IssuanceError (Task 4) → CATEGORY_UNRESOLVED/OWNER_UNRESOLVED;
  // IssuanceError (Task 5, mintItemizedCharges money guard) → SUM_INVARIANT; IssuanceError
  // (bill-expenses R4, mintExpenseChargesTx fail-closed) → EXPENSE_TENANT_UNRESOLVED.
  code?: "AIRCON_EXCEEDS_TNB" | "TNB_UNDERSHOOT" | "ABSORBED_REQUIRES_OWNER_BORNE" | "CATEGORY_UNRESOLVED" | "OWNER_UNRESOLVED" | "SUM_INVARIANT" | "EXPENSE_TENANT_UNRESOLVED";
  detail?: { totalAircond: number; tnbTotal: number };
  tenantInvoiceIds?: string[]; ownerInvoiceIds?: string[];
}

/**
 * A NON-fatal, row-level anomaly surfaced on the READ path only.
 *
 * ZERO_PAX_TENANCY: a GridMeterReading has a non-null tenancyId whose Tenancy has
 * numberOfPax 0 (or null). compute.ts's partition (compute.ts:88-92) puts a room
 * in `occupied` only when pax > 0, and in `vacant` only when tenancyId === null.
 * Such a room lands in NEITHER bucket: its airconCharge still counts toward
 * totalAircond (compute.ts:107 sums over ALL rooms — correct for the
 * AIRCON_EXCEEDS_TNB guard), but it produces no AllocationLine and adds nothing to
 * ownerAttributableAircond. We surface it instead of throwing: one bad row must
 * never blank the grid.
 */
export type RowWarning =
  | { code: "ZERO_PAX_TENANCY"; tenancyId: string }
  | { code: "NEGATIVE_CONSUMPTION"; listingId: string };

/** Stable-coded service failure. Distinct from ComputeError/ShapeError. */
class ServiceError extends Error {
  constructor(public code: "ABSORBED_REQUIRES_OWNER_BORNE") { super(code); this.name = "ServiceError"; }
}

/** The shape of a GridMeterReading row as both paths load it. */
type ReadingRow = { id: string; listingId: string; tenancyId: string | null; partyId: string | null; amount: Prisma.Decimal | null };

/**
 * PURE. Turn readings + a pax lookup into compute's RoomInput[], collecting any
 * row-level warnings. Shared by the Bill path (tx-loaded readings) and the read
 * path (readings arriving via `include`), so both agree on the room set exactly.
 *
 * This is NOT buildComputeInputs (meter/service.ts:435) and must never be confused
 * with it: that helper reads UnitUtilityBill (C6). This one reads ONLY grid tables.
 *
 * `airconCharge` is the ADMIN-ENTERED per-room submeter charge (v1). A room with no
 * reading contributes 0. Vacant rooms are included because compute.ts:107 sums
 * aircond over ALL rooms incl. vacant (C1).
 */
function roomsFromReadings(readings: ReadingRow[], paxByTenancy: Map<string, number>): { rooms: RoomInput[]; warnings: RowWarning[] } {
  const warnings: RowWarning[] = [];
  const rooms = readings.map((r) => {
    const pax = r.tenancyId ? (paxByTenancy.get(r.tenancyId) ?? 0) : 0;
    if (r.tenancyId !== null && pax === 0) warnings.push({ code: "ZERO_PAX_TENANCY", tenancyId: r.tenancyId });
    return {
      unitId: r.listingId,      // the ROOM (= Listing.id), mirroring MeterReading.unitId.
      tenancyId: r.tenancyId,   // null ⇒ vacant / whole-unit
      partyId: r.partyId,
      pax,
      airconCharge: num(r.amount),
    };
  });
  return { rooms, warnings };
}

/**
 * Load the pax lookup for the tenancies referenced by these readings. ORG-SCOPED:
 * a reading's tenancyId is an unvalidated snapshot (no FK — schema.prisma:2919), so
 * `organizationId` MUST bound this lookup or a foreign org's tenancy could fold its
 * pax into this org's preview. A foreign id simply does not resolve here (defence in
 * depth on top of the write-path rejection in saveReadingsService).
 */
async function paxByTenancyFor(db: Prisma.TransactionClient | Db, orgId: string, readings: ReadingRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const tenancyIds = readings.map((r) => r.tenancyId).filter((t): t is string => t !== null);
  if (tenancyIds.length === 0) return out;
  const tenancies = await db.tenancy.findMany({ where: { id: { in: tenancyIds }, organizationId: orgId }, select: { id: true, numberOfPax: true } });
  for (const t of tenancies) out.set(t.id, t.numberOfPax ?? 0);
  return out;
}

/** Bill-path loader. The Bill path ignores `warnings` — see billService. */
async function buildGridRooms(tx: Prisma.TransactionClient, orgId: string, entryId: string): Promise<{ rooms: RoomInput[]; warnings: RowWarning[] }> {
  const readings = await tx.gridMeterReading.findMany({ where: { organizationId: orgId, entryId } });
  return roomsFromReadings(readings, await paxByTenancyFor(tx, orgId, readings));
}

/**
 * BILL-PATH room-set builder (Task 3). Shapes the `RoomInput[]` that Task 4 feeds
 * verbatim to the REUSED `computeAllocation` (meter/compute.ts is byte-frozen — never
 * edited; this only SHAPES its input). PURE builder: no charge-minting, no DB writes
 * (that is Task 4). `activeTenancy` is PASSED IN by the caller (Task 4 sources it via a
 * `resolveWholeUnitTenancy` helper); this builder just consumes it.
 *
 * The load-bearing rule is compute.ts:88-92's `partition()`: a room is OCCUPIED only when
 * `tenancyId != null && partyId != null && pax > 0`, and VACANT only when `tenancyId === null`.
 *
 * WHOLE unit (`isWholeUnit === true`): a whole unit's grid readings carry `tenancyId: null`,
 * so they'd all fall in the VACANT bucket → zero allocation → an empty invoice. Instead,
 * when an `activeTenancy` is provided, inject ONE synthesized OCCUPIED room built from it
 * (`tenancyId`/`partyId`/`unitId`) with `pax: 1` and `airconCharge` = the SUM of the entry's
 * readings' `airconCharge`. The pax VALUE is immaterial (one occupant gets 100% of the pool);
 * `pax: 1` only guarantees the room classifies as occupied. A whole unit with
 * `activeTenancy == null` (vacant) has nothing to bill → `{ rooms: [], blockedTenancyIds: [] }`.
 *
 * PARTITIONED (`isWholeUnit === false`): return the REAL rooms from {@link buildGridRooms},
 * and collect `blockedTenancyIds` = every ACTIVE room (`tenancyId != null && partyId != null`)
 * whose `pax === 0` — a zero-pax active partitioned room can't get a fair per-pax split, so
 * Task 5 turns each into a `pax_blocked` outcome rather than silently billing it RM0.
 */
export function billRoomsFromLoaded(
  rawRooms: readonly RoomInput[],
  isWholeUnit: boolean,
  activeTenancy: { tenancyId: string; partyId: string; unitId: string } | null,
): { rooms: RoomInput[]; blockedTenancyIds: string[] } {
  if (isWholeUnit) {
    if (!activeTenancy) return { rooms: [], blockedTenancyIds: [] }; // vacant whole unit → nothing to bill
    // Sum aircon across the entry's (vacant-tenancyId) readings but allocate it to ONE
    // synthesized 1-pax occupied room so the whole-unit tenant gets 100% of the pool.
    const airconTotal = rawRooms.reduce((s, r) => s + r.airconCharge, 0);
    return {
      rooms: [
        {
          tenancyId: activeTenancy.tenancyId,
          partyId: activeTenancy.partyId,
          unitId: activeTenancy.unitId,
          pax: 1,
          airconCharge: airconTotal,
        },
      ],
      blockedTenancyIds: [],
    };
  }
  // EXACT COMPLEMENT of compute.ts:88-92's `partition()` occupied rule
  // (`tenancyId != null && partyId != null && pax > 0`): block every ACTIVE-tenancy room
  // (`tenancyId != null`) that `partition()` would NOT put in `occupied` — i.e. NOT
  // (`partyId != null && pax > 0`). This deliberately catches pax === 0 AND pax < 0 (a
  // negative numberOfPax is reachable via the M9 Excel import, which does not clamp
  // negatives; `pax === 0` alone would let it escape the gate → `partition()` drops it
  // from BOTH occupied and vacant → it's silently billed RM0 with no `pax_blocked`
  // signal) AND a partyId-null active room (latent orphan trap). Vacant rooms
  // (`tenancyId === null`) and healthy rooms (`partyId != null && pax > 0`) are never
  // blocked. Keep this in lock-step with `partition()` if that occupied rule ever changes.
  const blockedTenancyIds = rawRooms
    .filter((r) => r.tenancyId !== null && !(r.partyId !== null && r.pax > 0))
    .map((r) => r.tenancyId as string);
  return { rooms: [...rawRooms], blockedTenancyIds };
}

export async function buildBillRooms(
  tx: Prisma.TransactionClient,
  orgId: string,
  entry: { id: string },
  isWholeUnit: boolean,
  activeTenancy: { tenancyId: string; partyId: string; unitId: string } | null,
): Promise<{ rooms: RoomInput[]; blockedTenancyIds: string[] }> {
  // Preserve the vacant-WHOLE fast path: the original implementation returned
  // before loading readings/pax when there was no tenancy to invoice.
  if (isWholeUnit && !activeTenancy) return billRoomsFromLoaded([], true, null);
  const { rooms } = await buildGridRooms(tx, orgId, entry.id);
  return billRoomsFromLoaded(rooms, isWholeUnit, activeTenancy);
}

// ─────────────────── Task 4: Bill → invoice issuance (flag-gated) ────────────
//
// The ONLY grid→money seam, fully guarded by isPhase2FlagEnabled(
// "ENABLE_PHASE2_BILLING_DOCS"). Everything below runs INSIDE the row's existing
// per-row $transaction, so an issuance failure rolls the whole row back → the
// catch turns it into that row's `save_failed`. Mirrors chargeUtilityBillService
// (meter/service.ts:573) exactly — same computeAllocation call, same charge
// fields, same issueDocumentsForChargesTx — differing ONLY in the data source
// (a UnitBillsGridEntry, not a UnitUtilityBill). NEVER touches UnitUtilityBill /
// OwnerLedgerEntry / UtilityAllocation.

/**
 * The tenancy that occupied a WHOLE-listing apartment during `period`, shaped for
 * buildBillRooms's synthesized 1-pax occupied room. A whole unit's grid readings
 * carry `tenancyId: null` (so they'd land in the VACANT bucket); this resolves the
 * Tenancy directly so the whole-unit tenant is billed.
 *
 * Selection is PERIOD-scoped, not `status: "active"`. Billing a past month against
 * whoever occupies the unit today invoices the wrong tenant — and, once the prior
 * tenancy ends, drops that month's real occupant entirely.
 *
 * KNOWN LIMIT (deliberate, not an oversight): when TWO tenancies share the month
 * this returns only the longest-occupancy one, because buildBillRooms synthesizes
 * exactly ONE 1-pax room and `meter/compute.ts` splits the utility pool BY PAX.
 * Emitting a room per tenancy would split a handover month's utilities 50/50
 * instead of by days. Splitting utilities across a handover needs its own design
 * decision; until then the month's utilities go to its majority occupant.
 *  • tenancyId — the active Tenancy.id
 *  • partyId   — Tenancy.tenantPartyId (NOT NULL in the schema)
 *  • unitId    — the tenancy's own room (Listing.id), so the minted charge's
 *                `unit.apartment` resolves apartmentId/propertyId for the invoice.
 * Returns null for a vacant whole unit (nothing to bill). ORG-SCOPED.
 */
async function resolveWholeUnitTenancy(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  period: Date,
): Promise<{ tenancyId: string; partyId: string; unitId: string } | null> {
  const candidates = await tx.tenancy.findMany({
    where: { organizationId: orgId, unit: { apartmentId }, ...tenancyPeriodWhere(period) },
    orderBy: [{ startDate: "desc" }, { id: "asc" }],
    select: { id: true, tenantPartyId: true, unitId: true, startDate: true, endDate: true, status: true },
  });
  const t = primaryTenancyForPeriod(candidates, period);
  if (!t) return null;
  return { tenancyId: t.id, partyId: t.tenantPartyId, unitId: t.unitId };
}

/**
 * The apartment's owner party — the first non-archived room that carries an
 * `ownerPartyId` (every room of one apartment shares the same owner). Mirrors
 * meter/repository.findApartmentOwnerPartyId (kept inline so the grid imports no
 * money-writer module). Also returns a representative `listingId` in the
 * apartment so the owner charge's `unit.apartment` resolves apartmentId/propertyId
 * onto the IVOWN document. Returns null when no owner is assigned.
 */
async function resolveApartmentOwner(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
): Promise<{ ownerPartyId: string; listingId: string } | null> {
  const apt = await tx.apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: { listings: { where: { listingStatus: { not: "archived" } }, select: { id: true, ownerPartyId: true } } },
  });
  if (!apt) return null;
  const owned = apt.listings.find((l) => l.ownerPartyId);
  if (!owned) return null;
  return { ownerPartyId: owned.ownerPartyId!, listingId: owned.id };
}

/** A utility with both a tenant-side and an owner-side invoice category. */
type GridUtilityCategoryPair = { tenantCategoryId: string; ownerCategoryId: string };

/**
 * Per-utility ChargeCategory id map (Task 3, spec §R3). `subsidy` is
 * DELIBERATELY tenant-only — there is no `subsidy_owner` code (an owner-funded
 * offset is shown as a negative line on the TENANT invoice, spec R2/R5) — so
 * its shape has no `ownerCategoryId` key at all. This is a compile-time
 * guard: a future caller (Task 5/6/8) writing `cats.subsidy.ownerCategoryId`
 * fails to type-check instead of reading `undefined` into a Charge FK.
 */
type GridInvoiceCategoryMap = {
  // DERIVED per utility: those with an owner ChargeCategory get the pair; subsidy (an
  // owner-funded offset shown on the TENANT invoice) has no owner counterpart and so
  // exposes only the tenant id. Previously seven hand-written members that had to be kept
  // in step with the utility union by hand.
  [K in Utility]: (typeof UTILITY_SPEC)[K]["ownerCategory"] extends true
    ? GridUtilityCategoryPair
    : { tenantCategoryId: string };
};

// GRID_UTILITY_CATEGORY_CODES is DERIVED from UTILITY_SPEC (utility-spec.ts) — it used to
// be a hand-written array, i.e. one more place that had to remember every utility. A code
// missing here makes resolveGridInvoiceCategories return null, which fails EVERY grid Bill
// closed, so this is exactly the list you least want maintained by hand.

/**
 * Seed (idempotent, create-only) then resolve the per-utility ChargeCategory
 * ids the grid mints with — routing is derived by issueDocumentsForChargesTx
 * off `category.family`/`category.docType`, so EVERY resolved id must be
 * `docType:"invoice"`: tenant codes are `family:"tenant_income"`/IVTEN
 * (counterparty tenant), owner codes are `family:"owner_income"`/IVOWN
 * (counterparty owner) — spec §R2/R3. ensureChargeCategorySeeds opens its OWN
 * connection (create-only), and the subsequent tx reads (READ COMMITTED) see
 * the freshly committed rows — the SAME idiom issueDocumentsForChargesTx
 * itself uses. A mis-configured category (e.g. wrong docType) surfaces at
 * issue time as the row's `save_failed`.
 *
 * Returns `null` if ANY required category is missing (same fail-closed
 * contract as before the widening — see IssuanceError("CATEGORY_UNRESOLVED")
 * at every call site).
 *
 * CURRENT CALLERS still mint under `cats.cleaning` (the pre-existing
 * lump-charge placeholder) — splitting a grid entry's utility lump into one
 * Charge per non-zero component, routed through `cats.electricity`/`water`/
 * `sewerage`/`wifi`/`subsidy`, is itemized minting (spec R5) and is a LATER
 * task's job, not this one's.
 */
async function resolveGridInvoiceCategories(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<GridInvoiceCategoryMap | null> {
  await ensureChargeCategorySeeds(orgId);
  const cats = await tx.chargeCategory.findMany({
    where: { organizationId: orgId, code: { in: [...GRID_UTILITY_CATEGORY_CODES] } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(cats.map((c) => [c.code, c.id]));

  // Built by iterating UTILITY_SPEC rather than seven hand-written lines plus a seven-way
  // null check. Same fail-closed contract: ANY missing code returns null. A new utility is
  // picked up here automatically — previously it would have been silently absent from the
  // map while `GridInvoiceCategoryMap` still claimed the key existed.
  const out = {} as Record<Utility, { tenantCategoryId: string; ownerCategoryId?: string }>;
  for (const utility of UTILITIES) {
    const tenantCategoryId = idByCode.get(tenantCategoryCode(utility));
    if (!tenantCategoryId) return null;
    if (!UTILITY_SPEC[utility].ownerCategory) {
      out[utility] = { tenantCategoryId };
      continue;
    }
    const ownerCategoryId = idByCode.get(ownerCategoryCode(utility));
    if (!ownerCategoryId) return null;
    out[utility] = { tenantCategoryId, ownerCategoryId };
  }
  return out as GridInvoiceCategoryMap;
}

/** Stable-coded issuance failure — surfaces as the row's `save_failed`. */
class IssuanceError extends Error {
  constructor(public code: "CATEGORY_UNRESOLVED" | "OWNER_UNRESOLVED" | "SUM_INVARIANT" | "EXPENSE_TENANT_UNRESOLVED") { super(code); this.name = "IssuanceError"; }
}

/**
 * A live charge sourced by THIS grid entry — its id, unit (room), the fresh party
 * (used only for the owner classification via family), and its category's family
 * (routes tenant vs owner). Loaded ISSUED-doc-scoped so a CANCELLED original from a
 * prior re-Bill is excluded and only the current live generation is superseded.
 *
 * `tenancyId`/`partyId` snapshot the party this live charge was INVOICED to — the
 * occupancy-change fail-closed guard (fix pass 2) compares them to the CURRENT
 * expected occupant (fresh allocation for a tenant charge; apartment owner for an
 * owner charge) so a mid-period hand-over refuses re-Bill instead of mis-billing.
 */
type LiveGridCharge = { id: string; chargeNumber: string; unitId: string | null; tenancyId: string | null; partyId: string; family: string | null; categoryId: string | null; amount: number; outstandingAmount: number; sourceRecurringLineId: string | null; documentId: string | null };

// Moved to lib/billing-month.ts so callers outside the grid can use it without importing
// this module (which opens a DB connection at import time). Re-exported here, unchanged,
// so every existing `from "./service"` / `from "../service"` importer keeps working.
export { currentBillingMonthUTC };

/**
 * A grid component's IDENTITY — stable across re-Bills and across amount changes.
 *
 * Every grid charge number encodes what the component IS, then a `-r<revision>` suffix
 * saying which generation minted it:
 *
 *   GRIDUTIL-<ym>-<unitId>-<UTILITY>      shared utility, per room
 *   GRIDAC-<ym>-<unitId>                  that room's PRIVATE submeter electricity
 *   GRIDOWN-<ym>-<apartmentId>-<UTILITY>  owner-borne utility
 *   GRIDRECUR-<ym>-<definitionId>         recurring snapshot line
 *   GRIDEXP-<ym>-<expenseId>[-SST]        grid expense line (and its SST sibling)
 *
 * Stripping the suffix yields the identity. This is what a partial re-Bill keys its
 * "already paid, do not re-mint" set on.
 *
 * ⚠️ It is deliberately NOT (unitId, categoryId). A single room can carry TWO electricity
 * components — shared TNB and its private submeter — and both mint under
 * cats.electricity.tenantCategoryId with the same unitId (previewItemizedComponents). Keyed
 * on the category pair, a skip set could not tell them apart and would withhold the wrong
 * one, under-billing the tenant for a line nobody paid.
 *
 * Anchored at end-of-string so a `-r` appearing INSIDE an id is never truncated.
 */
export function componentIdentity(chargeNumber: string): string {
  return chargeNumber.replace(/-r\d+$/, "");
}

/**
 * Partition a unit-month's live grid charges into the ones money actually arrived for and
 * the ones still owed.
 *
 * This is the ANY-PAYMENT block's math, extracted verbatim: CASH_ALLOCATION_WHERE (posted
 * payments only — the allow-list that is already the system-wide definition of paid),
 * sumReversalsForAllocations netting, and the same `> 0.005` per-allocation threshold. For
 * every payment that is `posted`, the paid set here is identical to the set that block
 * flags today, which is the whole safety argument for reusing it to DRIVE a re-Bill rather
 * than merely refuse one.
 *
 * Direction matters, and it is opposite on each side. A charge wrongly called PAID is
 * silently dropped from the new proforma and never billed. A charge wrongly called UNPAID
 * is credited while a live allocation still points at it — money received, receivable
 * erased. Both are guarded by the same single definition of cash.
 */
export async function splitLiveChargesByPayment<T extends { id: string; chargeNumber: string }>(
  tx: Prisma.TransactionClient,
  orgId: string,
  live: readonly T[],
): Promise<{ paid: T[]; unpaid: T[]; activePaidByChargeId: Map<string, number> }> {
  const activePaidByChargeId = new Map<string, number>();
  const liveIds = live.map((c) => c.id);
  if (liveIds.length === 0) return { paid: [], unpaid: [], activePaidByChargeId };

  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: liveIds }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, chargeId: true, allocatedAmount: true },
  });
  if (allocs.length > 0) {
    const reversed = await sumReversalsForAllocations(tx, orgId, allocs.map((a) => a.id));
    for (const a of allocs) {
      const net = round2(num(a.allocatedAmount) - (reversed.get(a.id) ?? 0));
      if (net > 0.005 && a.chargeId) {
        activePaidByChargeId.set(a.chargeId, round2((activePaidByChargeId.get(a.chargeId) ?? 0) + net));
      }
    }
  }

  // ⚠️ MONEY — the SECOND settlement rail. An OWNER charge is settled without any
  // Payment/PaymentAllocation existing: the offset rail decrements the charge directly
  // (see owner-offset-settlement.ts for the full mechanism and the incident it caused).
  // Folded into the SAME map, so every consumer of "how much of this charge is already
  // settled" — the flag-off hard block, the partial-re-Bill protection set, and
  // assessPaidBlockers' message — sees owner money and tenant cash identically.
  for (const [chargeId, amount] of await activeOwnerOffsetByChargeId(tx, orgId, liveIds)) {
    if (amount <= 0.005) continue;
    activePaidByChargeId.set(chargeId, round2((activePaidByChargeId.get(chargeId) ?? 0) + amount));
  }

  const paid: T[] = [];
  const unpaid: T[] = [];
  for (const c of live) (activePaidByChargeId.has(c.id) ? paid : unpaid).push(c);
  return { paid, unpaid, activePaidByChargeId };
}

/** A live head-of-chain grid invoice for a unit-month — the doc a re-Bill supersedes. */
type ReclaimableDoc = { id: string; counterpartyType: string; documentNumber: string; partyId: string | null; listingId: string | null; billingMonth: Date | null; docType: string };

/**
 * Identity of a re-Bill supersede SLOT: which fresh document an old document is
 * replaced by. INCLUDES docType — an owner can hold two documents for one
 * (party, unit, month): an IVOWN receivable for profit-natured charges and an OEA
 * advice for expense-natured ones. Without docType both collapse to one key and
 * `freshByKey` (a Map) keeps only the last, so old documents supersede to the wrong
 * replacement or to null.
 *
 * Exported ONLY so the unit test can exercise the real builder instead of a mirror
 * that could silently drift from it.
 */
export const reBillDocKey = (d: {
  counterpartyType: string; partyId: string | null; listingId: string | null;
  billingMonth: Date | null; docType: string;
}) => `${d.counterpartyType}|${d.partyId ?? "∅"}|${d.listingId ?? "∅"}|${d.billingMonth?.toISOString() ?? "∅"}|${d.docType}`;

/** The existing-invoice state of a grid unit-month (see {@link findGridInvoiceState}). */
type GridInvoiceState = {
  reclaimableDocs: ReclaimableDoc[];
  reclaimableCharges: LiveGridCharge[];
  hasConflict: boolean;
  // HISTORICAL-ONLY re-Bill fix (money bug). Owner-borne charges from a PRIOR
  // generation of this entry that carry NO BillingDocumentLine — so they can never
  // appear in `reclaimableCharges` (which requires a live doc). Nothing produces such a
  // charge any more: ENABLE_OWNER_BORNE_DEDUCT, whose IVOWN skip created them, was
  // removed and every owner-borne charge is now billed as an ordinary IVOWN line. This
  // list is therefore always empty on any data minted after 2026-08-16 — kept because a
  // database that ran with that flag ON still holds doc-less charges, and retiring them
  // on re-Bill is what stops the owner being double-deducted. TWO families:
  //   • P5: GRIDEXP charges (chargeType "expense", sourceGridExpenseId set).
  //   • Task 6: OWNER-borne recurring Expense charges (chargeType "utility",
  //     nature:"expense", tenancyId null, sourceGridExpenseId null) — the doc-less
  //     owner family the per-charge nature-routing feature added.
  // Left un-retired, either stays `status:"posted"` forever while a re-Bill mints a
  // fresh successor, and the legacy owner-ledger deduction booked BOTH as separate rows
  // (owner double-deducted). See the credit step in rebillSupersedeTx (step 7) below,
  // which retires these by provenance instead of by document. Always [] when the
  // owner-borne charge co-grouped onto a real IVOWN at mint+group time (never doc-less)
  // — a structural, not flag-checked, no-op.
  docLessOwnerBorneExpenseChargeIds: string[];
};

/**
 * Resolve the existing live invoices of a grid unit-month by BILLING PROVENANCE, not by
 * `sourceGridEntryId` alone — so a legacy invoice whose charge was orphaned
 * (`sourceGridEntryId` nulled by the entry's `onDelete: SetNull`) is still recognised as
 * THIS workflow's invoice and treated as a RE-BILL candidate, never a hard conflict (rule 6).
 *
 * Covers BOTH grid-workflow charge families — shared-utility (`chargeType: "utility"`) AND
 * expense (`chargeType: "expense"`, spec R5) — so a re-Bill's credit step (rebillSupersedeTx
 * step 7) reclaims every charge the prior grid mint produced for this unit-month, not just
 * the utility ones; otherwise the re-mint re-creates the same (unitId, categoryId,
 * billingMonth, amount) key against a still-live original and P2002s.
 *
 * A charge is grid-workflow provenance iff (structural markers, never description text):
 *   • `sourceGridEntryId === entryId` (the normal linked case), OR
 *   • `chargeNumber` begins `GRIDUTIL-${ym}-` / `GRIDOWN-${ym}-` / `GRIDEXP-${ym}-` (the grid
 *     mint format — lump, itemized, AND expense — for THIS billing month). The meter path
 *     mints `UTIL-`/`AC-`, so a meter/manual utility invoice never matches → it sets
 *     `hasConflict` and the caller fails closed (`conflicting_invoice`). Replaces the old
 *     sourceGridEntryId-only `findLiveGridCharges` — reclaimableCharges IS the supersede set.
 */
async function findGridInvoiceState(
  tx: Prisma.TransactionClient,
  orgId: string,
  entryId: string,
  listingIds: string[],
  periodMonth: Date,
  ym: string,
): Promise<GridInvoiceState> {
  const empty: GridInvoiceState = { reclaimableDocs: [], reclaimableCharges: [], hasConflict: false, docLessOwnerBorneExpenseChargeIds: [] };
  if (listingIds.length === 0) return empty;
  // Live (not void/credited) grid-workflow charges (shared-utility AND expense) for this
  // physical unit-month, from ANY source. billingMonth + unitId key them to the same
  // unit-month the grid entry covers.
  const utilCharges = await tx.charge.findMany({
    where: {
      organizationId: orgId,
      // "aircond" joins the family so a re-Bill RECLAIMS the private-submeter charges the
      // mint now creates (GRIDAC-). Without it they survive the supersede as live orphans and
      // the re-mint P2002s on the same chargeNumber. It also makes a meter-path `AC-` charge
      // for the same unit-month visible here — non-grid provenance, so it correctly trips
      // `hasConflict` → `conflicting_invoice` instead of double-billing the same aircond.
      chargeType: { in: ["utility", "expense", "aircond"] },
      billingMonth: periodMonth,
      unitId: { in: listingIds },
      status: { notIn: ["void", "credited"] },
    },
    // sourceGridExpenseId: P5 re-Bill fix — identifies a doc-less owner-borne GRIDEXP
    // charge below (only mintExpenseChargesTx ever sets this column). nature: Task-6
    // re-Bill fix — identifies a doc-less owner-borne recurring Expense charge below
    // (only recurringChargeData sets a Charge's `nature`, and only when the flag was ON).
    select: { id: true, unitId: true, tenancyId: true, partyId: true, categoryId: true, amount: true, outstandingAmount: true, sourceGridEntryId: true, sourceGridExpenseId: true, sourceRecurringLineId: true, chargeNumber: true, nature: true, category: { select: { family: true } } },
  });
  if (utilCharges.length === 0) return empty;
  // Keep only charges backed by a LIVE head-of-chain document (a charge whose doc a
  // prior re-Bill cancelled is not live).
  //
  // OEA is included so a prior generation's Owner Expense Advice is reclaimed and
  // CANCELLED on re-Bill. Without it, issue-grouped's `:r<revision>` idempotencyKey
  // mints a FRESH OEA every time while the old one stays ISSUED forever — N re-Bills
  // leave N live advices for one owner-unit-month.
  //
  // MONEY: this moves an OEA-backed charge OUT of the `!doc` branch below (which feeds
  // docLessOwnerBorneExpenseChargeIds) and INTO reclaimableCharges → liveIds. `creditIds`
  // (step 7) unions BOTH lists, so the stale charge is still credited exactly once and
  // Source 6's reverse-pass still voids its old deduction. The doc-less branch MUST stay:
  // pre-OEA historical charges have no document at all and are reclaimable only through
  // it, as are owner-borne recurring Expense charges (sourceGridExpenseId null).
  const liveLines = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: utilCharges.map((c) => c.id) },
      // `proforma` is in the allowlist so a re-Bill supersedes the existing PI instead of
      // leaving it ISSUED and minting a second one. `invoice` stays so pre-flag grid
      // documents remain re-billable (R12).
      document: { organizationId: orgId, documentStatus: "ISSUED", docType: { in: ["invoice", "debit_note", "owner_expense_advice", "proforma"] }, originalDocumentId: null },
    },
    select: { chargeId: true, document: { select: { id: true, counterpartyType: true, documentNumber: true, partyId: true, listingId: true, billingMonth: true, docType: true, proformaDocumentId: true } } },
  });
  const docByCharge = new Map<string, ReclaimableDoc>();
  // R5: a GRADUATED invoice is a real tax invoice against money already received. It can
  // never be reclaimed or cancelled by a re-Bill — only the proforma it came from can.
  for (const l of liveLines) if (l.chargeId && l.document && l.document.proformaDocumentId === null) docByCharge.set(l.chargeId, l.document);
  const isGridProvenance = (c: { sourceGridEntryId: string | null; chargeNumber: string }) =>
    c.sourceGridEntryId === entryId
    || c.chargeNumber.startsWith(`GRIDUTIL-${ym}-`)
    || c.chargeNumber.startsWith(`GRIDOWN-${ym}-`)
    || c.chargeNumber.startsWith(`GRIDEXP-${ym}-`)
    // Private submeter electricity minted by THIS workflow. The meter path's `AC-` is
    // deliberately NOT matched — that is a different workflow's charge and must conflict.
    || c.chargeNumber.startsWith(`GRIDAC-${ym}-`);

  const reclaimableCharges: LiveGridCharge[] = [];
  const reclaimableDocs = new Map<string, ReclaimableDoc>();
  // P5 re-Bill fix: doc-less owner-borne GRIDEXP charges from a prior generation of
  // THIS entry — see the type doc on GridInvoiceState above and the credit step in
  // rebillSupersedeTx (step 7) that consumes this list.
  const docLessOwnerBorneExpenseChargeIds: string[] = [];
  let hasConflict = false;
  for (const c of utilCharges) {
    const doc = docByCharge.get(c.id);
    if (!doc) {
      // A doc-less charge is never part of the LIVE existing-invoice state (nothing to
      // supersede a document for) — but a doc-less GRIDEXP charge from THIS entry is
      // still a STALE prior-generation charge that must be retired on re-Bill, or it
      // strands forever and the legacy owner-ledger deduction double-books it alongside
      // the fresh re-mint (money bug). Scoped tightly: sourceGridExpenseId is set ONLY
      // by mintExpenseChargesTx, and isGridProvenance's `sourceGridEntryId === entryId`
      // arm is ALWAYS true for such a charge (mintExpenseChargesTx stamps both fields
      // together) — so this can never reach into another entry's charges, nor into a
      // plain utility/meter charge (which never carries sourceGridExpenseId).
      if (c.sourceGridExpenseId !== null && isGridProvenance(c)) {
        docLessOwnerBorneExpenseChargeIds.push(c.id);
      } else if (c.nature === "expense" && c.tenancyId === null && c.sourceGridEntryId === entryId) {
        // Task 6 (per-charge nature routing) TWIN of the GRIDEXP case above, for the
        // OTHER doc-less owner family it introduced: an OWNER-borne CUSTOM recurring
        // charge stamped nature:"expense" (chargeType:"utility", sourceGridExpenseId
        // NULL — it carries sourceRecurringLineId + sourceGridEntryId instead).
        // The removed ENABLE_OWNER_BORNE_DEDUCT skip in issue-grouped.ts (broadened to
        // nature by Task 5) used to exclude it from IVOWN, leaving it doc-less and booked
        // as an owner-ledger deduction — and, left un-retired on re-Bill, double-booked
        // alongside the fresh re-mint exactly like GRIDEXP (owner underpaid). Such a
        // charge is no longer created; this arm only ever sees legacy rows now.
        // Scoped as tightly: `tenancyId === null` is the owner-vs-tenant discriminator
        // (recurringChargeData stamps a tenancyId ONLY for tenant-borne lines), so a
        // tenant-borne Expense recurring charge — a receivable, always doc-BACKED and
        // reclaimed via its IVTEN/EB document (the `else` branch below), never doc-less —
        // is never swept in here; `sourceGridEntryId === entryId` bounds it to THIS
        // entry. Flag-off byte-identical: a Charge's `nature` column is "expense" ONLY
        // when ENABLE_CHARGE_NATURE_ROUTING was ON at mint time (recurringChargeData) —
        // structurally [] for an org that never enabled it, exactly like the
        // sourceGridExpenseId arm above. Un-gated on the LIVE flag on purpose, mirroring
        // GRIDEXP: a flag-flip-OFF-then-re-Bill still retires the stale rev so Source 6's
        // reverse-pass voids its deduction rather than stranding it beside a now-invoiced
        // successor.
        docLessOwnerBorneExpenseChargeIds.push(c.id);
      }
      continue;
    }
    if (isGridProvenance(c)) {
      // Family routes owner-vs-tenant in the occupancy guard. A LEGACY lump charge carries
      // NO per-utility category (categoryId null → family null), so fall back to the
      // chargeNumber provenance: `GRIDOWN-` is the OWNER charge (owner_income). Without this
      // the legacy owner charge is misread as a tenant charge and its OWNER partyId is
      // compared against the fresh TENANT party → a false-positive `occupancy_changed`.
      const family = c.category?.family ?? (c.chargeNumber.startsWith(`GRIDOWN-${ym}-`) ? "owner_income" : null);
      reclaimableCharges.push({ id: c.id, chargeNumber: c.chargeNumber, unitId: c.unitId, tenancyId: c.tenancyId, partyId: c.partyId, family, categoryId: c.categoryId, amount: num(c.amount), outstandingAmount: num(c.outstandingAmount), sourceRecurringLineId: c.sourceRecurringLineId, documentId: doc.id });
      reclaimableDocs.set(doc.id, doc);
    } else {
      hasConflict = true; // a live utility invoice from a non-grid path (meter/manual) → conflict
    }
  }
  return { reclaimableDocs: [...reclaimableDocs.values()], reclaimableCharges, hasConflict, docLessOwnerBorneExpenseChargeIds };
}

/**
 * Task 8: BATCHED net-of-reversal paid predicate for the grid LIST read. Returns the
 * subset of `entryIds` that have at least ONE net-positive payment on a LIVE
 * (ISSUED-document) charge — the SAME semantics anyChargePaid enforces per-entry for
 * the Task-6 paid-freeze, but computed for the WHOLE page in a BOUNDED, CONSTANT number
 * of queries (never per-row: preserves the read path's strict no-N+1 discipline). A
 * fully-reversed payment nets out and does NOT mark the entry paid. The server
 * paid-freeze (anyChargePaid, inside the Bill tx) remains AUTHORITATIVE — this only
 * drives the FE lock affordance, so a divergence can never mis-post money.
 */
async function entriesWithPaidInvoice(orgId: string, entryIds: string[]): Promise<Set<string>> {
  const paid = new Set<string>();
  if (entryIds.length === 0) return paid;
  // 1. All charges tagged to these entries (charge id → entry id).
  const tagged = await prisma.charge.findMany({
    where: { organizationId: orgId, sourceGridEntryId: { in: entryIds } },
    select: { id: true, sourceGridEntryId: true },
  });
  if (tagged.length === 0) return paid;
  const entryByCharge = new Map(tagged.map((c) => [c.id, c.sourceGridEntryId]));
  // 2. Keep only charges whose BillingDocument is still ISSUED — a cancelled original
  //    from a prior re-Bill is NOT a live invoice (mirrors findLiveGridCharges).
  const liveLines = await prisma.billingDocumentLine.findMany({
    where: { chargeId: { in: tagged.map((c) => c.id) }, document: { organizationId: orgId, documentStatus: "ISSUED" } },
    select: { chargeId: true },
  });
  const liveChargeIds = [...new Set(liveLines.map((l) => l.chargeId).filter((x): x is string => !!x))];
  if (liveChargeIds.length === 0) return paid;
  // 3. Payment allocations on those live charges (allocation → charge).
  const allocs = await prisma.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: liveChargeIds }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true, chargeId: true },
  });
  if (allocs.length === 0) return paid;
  // 4. Reversal sums per allocation — ONE grouped query, exactly anyChargePaid's math.
  const reversed = await sumReversalsForAllocations(prisma, orgId, allocs.map((a) => a.id));
  // 5. A net-positive allocation marks its charge's entry paid.
  for (const a of allocs) {
    if (round2(Number(a.allocatedAmount.toString()) - (reversed.get(a.id) ?? 0)) > 0) {
      const entryId = a.chargeId ? entryByCharge.get(a.chargeId) : null;
      if (entryId) paid.add(entryId);
    }
  }
  return paid;
}

/**
 * TRUE iff any LIVE charge tagged to this grid entry carries a net-of-reversal active cash
 * allocation — the single-entry, IN-TRANSACTION twin of {@link entriesWithPaidInvoice} above,
 * with identical semantics and filters:
 *
 *   1. charges tagged to the entry via `sourceGridEntryId`
 *   2. narrowed to those on a still-ISSUED BillingDocument — a document CANCELLED by a prior
 *      re-Bill is not a live invoice, so payment against it must not freeze the row
 *   3. their PaymentAllocations, filtered by the shared CASH_ALLOCATION_WHERE, so an abandoned
 *      FPX attempt (`pending_approval`, no money received) never reads as cash
 *   4. minus each allocation's reversals — a fully-reversed payment nets out to nothing
 *
 * WHY IT EXISTS. It is the write guard for expense lines and bearer config (2026-08-17). Those
 * four sites used to reject on the bare `entry.billedAt`, freezing a unit-month the instant it
 * was Billed even though no money had arrived — out of step with saveEntryService /
 * saveReadingsService, which 0818f297 relaxed so a billed-but-UNPAID month stays amendable
 * before a re-Bill. A GridExpense is inert draft data exactly like a saved cell value: it
 * becomes money only when Bill mints charges from it, and Bill keeps its own payment guard
 * (`rebill_blocked_payment_exists`). Sharing this ONE fact with the read path, the FE row lock
 * and rebillSupersedeTx's own block is what stops the server accepting a write that a re-Bill
 * would then refuse to carry.
 *
 * WHY IT LIVES HERE rather than in a leaf module: `Charge` access inside bills-grid is confined
 * to service.ts + issue-grouped.ts by the static guard in forbidden-writes.integration.test.ts.
 * Putting it beside its batched twin respects that boundary instead of widening the allowlist,
 * and leaves the two copies adjacent for the consolidation the spec defers.
 *
 * READ-ONLY: performs no writes and takes no locks.
 *
 * FAILS CLOSED BY CONSTRUCTION. Callers use it as a write guard where `false` means "no money,
 * allow the write", so it must never convert an error into `false`: a query rejection propagates
 * to the caller's `$transaction`, rolling the write back. Do not add a try/catch returning a boolean.
 */
export async function entryHasActivePayment(
  tx: Prisma.TransactionClient,
  orgId: string,
  entryId: string,
): Promise<boolean> {
  const tagged = await tx.charge.findMany({
    where: { organizationId: orgId, sourceGridEntryId: entryId },
    select: { id: true },
  });
  if (tagged.length === 0) return false;

  const liveLines = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: tagged.map((c) => c.id) },
      document: { organizationId: orgId, documentStatus: "ISSUED" },
    },
    select: { chargeId: true },
  });
  const liveChargeIds = [...new Set(liveLines.map((l) => l.chargeId).filter((x): x is string => !!x))];
  if (liveChargeIds.length === 0) return false;

  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: liveChargeIds }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true },
  });
  if (allocs.length === 0) return false;

  const reversed = await sumReversalsForAllocations(tx, orgId, allocs.map((a) => a.id));
  return allocs.some((a) => round2(Number(a.allocatedAmount.toString()) - (reversed.get(a.id) ?? 0)) > 0);
}

/**
 * Has money arrived for THIS expense line specifically?
 *
 * The entry-scoped {@link entryHasActivePayment} answers "has anything on this month been
 * paid", which froze every expense line the moment a tenant paid one of them — the
 * reported complaint. Once partial re-Bill exists, an edit to an UNPAID line has a route
 * onto a document again, so the guard can be as narrow as the money is.
 *
 * BOTH charges count: an SST-bearing expense mints a base charge and a `-SST` sibling
 * under one sourceGridExpenseId, and paying either one freezes the line. Deliberately
 * ANY rather than ALL here — the display grain (slice 1's expenseLines) calls a
 * half-settled line "partial", and a partially-settled line must not be editable either.
 */
export async function expenseHasActivePayment(
  tx: Prisma.TransactionClient,
  orgId: string,
  expenseId: string,
): Promise<boolean> {
  const charges = await tx.charge.findMany({
    where: { organizationId: orgId, sourceGridExpenseId: expenseId },
    select: { id: true },
  });
  if (charges.length === 0) return false;

  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: charges.map((c) => c.id) }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true },
  });
  if (allocs.length === 0) return false;

  const reversed = await sumReversalsForAllocations(tx, orgId, allocs.map((a) => a.id));
  return allocs.some((a) => round2(num(a.allocatedAmount) - (reversed.get(a.id) ?? 0)) > 0.005);
}

/**
 * Has money arrived against THIS entry's electricity specifically?
 *
 * Guards the one scalar that re-prices someone else's settled money. `tnbTotal` is the
 * WHOLE TNB bill, and every occupied room's tenant share is derived from it
 * (meter/compute.ts: `leftoverTnb = tnbTotal - totalAircond`, then
 * `tnbShare = leftoverTnb / totalPax * pax`); under an "absorbed" pattern it is also the
 * owner's own electricity charge. So editing it after the electricity is paid rewrites what
 * a settled charge "should" have been — the same hazard `updateLinesService` guards
 * entry-wide against for bearer/pattern changes.
 *
 * Deliberately per-FIELD rather than entry-wide: the whole point of partial re-Bill is that
 * a paid electricity line no longer freezes the WiFi, so this must not re-freeze the month.
 *
 * BOTH sides count, matching the client's `CELL_BUCKET` entry for `tnbOwner` — category
 * codes are `electricity_tenant` / `electricity_owner`, so the `electricity` prefix takes
 * either. ANY net-positive allocation freezes it, partial included, exactly like
 * {@link expenseHasActivePayment}.
 */
export async function electricityHasActivePayment(
  tx: Prisma.TransactionClient,
  orgId: string,
  entryId: string,
): Promise<boolean> {
  const charges = await tx.charge.findMany({
    where: {
      organizationId: orgId,
      sourceGridEntryId: entryId,
      category: { code: { startsWith: "electricity" } },
    },
    select: { id: true },
  });
  if (charges.length === 0) return false;

  const allocs = await tx.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: charges.map((c) => c.id) }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true },
  });
  if (allocs.length === 0) return false;

  const reversed = await sumReversalsForAllocations(tx, orgId, allocs.map((a) => a.id));
  return allocs.some((a) => round2(num(a.allocatedAmount) - (reversed.get(a.id) ?? 0)) > 0.005);
}

/**
 * READ-TIME settlement (payment) state per entry, for DISPLAY only.
 *
 * Same scoping as {@link entriesWithPaidInvoice} — charges tagged to the entry whose
 * BillingDocument is still ISSUED (a cancelled original from a prior re-Bill is not a
 * live bill) — but resolved to three states instead of a boolean, both for the row as a
 * whole AND per money column-group, so the grid can grey a settled cell.
 *
 * Two DIFFERENT signals, deliberately:
 *   • settled  ⟸ `charge.outstandingAmount <= 0`. The charge ledger's own field, the
 *     same one the rest of the system settles on, so a credit note that nets a line to
 *     zero correctly reads settled without re-deriving CN math here.
 *   • touched  ⟸ net-of-reversal allocations > 0. `outstandingAmount` alone cannot tell
 *     "partly paid" from "never paid", and a FULLY-reversed payment must not read as
 *     partial — that is exactly anyChargePaid's math, reused via sumReversalsForAllocations.
 *
 * This NEVER gates a write: the Bill-time paid-freeze (anyChargePaid) and the row edit
 * lock (`entry.paymentStatus`) are untouched, so a divergence here cannot mis-post money.
 */
async function settlementByEntry(orgId: string, entryIds: string[]): Promise<Map<string, GridSettlementDto>> {
  const out = new Map<string, GridSettlementDto>();
  if (entryIds.length === 0) return out;

  // 1. Every charge tagged to these entries, with what we need to bucket it. `unitId` is
  //    the ROOM (listingId) the charge was minted against — it is what lets a PARTITIONED
  //    unit tick room A's electricity while room B's is still outstanding. Without it the
  //    two rooms share one tally and a genuinely-paid room shows no tick.
  const charges = await prisma.charge.findMany({
    where: { organizationId: orgId, sourceGridEntryId: { in: entryIds } },
    select: {
      id: true,
      sourceGridEntryId: true,
      // The GridExpense this charge was minted from — already an indexed FK
      // (schema.prisma:1012, :1080), and the SST sibling inherits it from the shared
      // `base` object at mint (service.ts:2103-2114), so both charges of one SST-bearing
      // line resolve to the same expense. Null for every non-expense charge.
      sourceGridExpenseId: true,
      chargeNumber: true,
      outstandingAmount: true,
      unitId: true,
      category: { select: { code: true } },
    },
  });
  if (charges.length === 0) return out;

  // 2. Keep only charges still on a LIVE (ISSUED) document, and read the bearer side
  //    off that document (IVTEN → tenant, IVOWN → owner) — this is what makes the
  //    bucketing work for expense charges too, whose category code carries no side.
  const liveLines = await prisma.billingDocumentLine.findMany({
    where: {
      chargeId: { in: charges.map((c) => c.id) },
      document: { organizationId: orgId, documentStatus: "ISSUED" },
    },
    select: { chargeId: true, document: { select: { counterpartyType: true } } },
  });
  const sideByCharge = new Map<string, "owner" | "tenant">();
  for (const l of liveLines) {
    if (l.chargeId) sideByCharge.set(l.chargeId, l.document.counterpartyType === "owner" ? "owner" : "tenant");
  }
  const live = charges.filter((c) => sideByCharge.has(c.id));
  if (live.length === 0) return out;

  // 3. Net-of-reversal payment per charge — two queries for the whole page.
  const allocs = await prisma.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId: { in: live.map((c) => c.id) }, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true, chargeId: true },
  });
  const reversed = await sumReversalsForAllocations(prisma, orgId, allocs.map((a) => a.id));
  const netPaidByCharge = new Map<string, number>();
  for (const a of allocs) {
    if (!a.chargeId) continue;
    const net = Number(a.allocatedAmount.toString()) - (reversed.get(a.id) ?? 0);
    netPaidByCharge.set(a.chargeId, round2((netPaidByCharge.get(a.chargeId) ?? 0) + net));
  }

  // 4-5. Everything from here is PURE — see foldSettlement.
  return foldSettlement(
    live.map((c) => ({
      entryId: c.sourceGridEntryId!,
      categoryCode: c.category?.code ?? null,
      isExpense: c.chargeNumber.startsWith("GRIDEXP-"),
      expenseId: c.sourceGridExpenseId,
      side: sideByCharge.get(c.id)!,
      roomId: c.unitId,
      isSettled: Number(c.outstandingAmount.toString()) <= 0,
      isTouched: (netPaidByCharge.get(c.id) ?? 0) > 0,
    })),
  );
}

/** One live grid charge, reduced to only what settlement state depends on. */
export type SettlementChargeFact = {
  entryId: string;
  categoryCode: string | null;
  isExpense: boolean;
  /** `Charge.sourceGridExpenseId` — the GridExpense line this charge was minted from.
   *  Null for every non-expense charge. An SST-bearing line yields TWO facts sharing
   *  one `expenseId`, which is what makes its line read "partial" until both settle. */
  expenseId: string | null;
  side: "owner" | "tenant";
  /** The room (listingId) this charge was minted against; null for unit-level charges. */
  roomId: string | null;
  /** `outstandingAmount <= 0` — the charge ledger's own settled test. */
  isSettled: boolean;
  /** Net-of-reversal payment > 0. Distinguishes "part paid" from "never paid". */
  isTouched: boolean;
};

/**
 * PURE fold of live grid charges into row / per-column / per-room settlement state.
 * Extracted from the query above so these rules — which decide whether an admin sees a
 * line as PAID — are unit-testable without a database.
 *
 * Every charge is counted into all FOUR grains at once, so they cannot disagree: a row
 * can never read "paid" while one of its buckets is outstanding.
 */
export function foldSettlement(facts: SettlementChargeFact[]): Map<string, GridSettlementDto> {
  type Tally = { total: number; settled: number; touched: number };
  const blank = (): Tally => ({ total: 0, settled: 0, touched: 0 });
  type Acc = {
    row: Tally;
    buckets: Map<SettlementBucket, Tally>;
    rooms: Map<string, Map<SettlementBucket, Tally>>;
    expenseLines: Map<string, Tally>;
  };
  const perEntry = new Map<string, Acc>();

  for (const f of facts) {
    if (!f.entryId) continue;
    const bucket = settlementBucketFor(f.categoryCode, f.side, f.isExpense);
    let acc = perEntry.get(f.entryId);
    if (!acc) { acc = { row: blank(), buckets: new Map(), rooms: new Map(), expenseLines: new Map() }; perEntry.set(f.entryId, acc); }
    const b = acc.buckets.get(bucket) ?? blank();
    acc.buckets.set(bucket, b);
    const targets: Tally[] = [acc.row, b];
    if (f.roomId) {
      let roomBuckets = acc.rooms.get(f.roomId);
      if (!roomBuckets) { roomBuckets = new Map(); acc.rooms.set(f.roomId, roomBuckets); }
      const rb = roomBuckets.get(bucket) ?? blank();
      roomBuckets.set(bucket, rb);
      targets.push(rb);
    }
    // Line grain. Guarded on the id being a real string: a non-expense charge carries
    // null here and must NOT create a key — a `null`/`"null"` entry in expenseLines
    // would be indistinguishable from a real GridExpense id to the dialog.
    if (f.expenseId) {
      const el = acc.expenseLines.get(f.expenseId) ?? blank();
      acc.expenseLines.set(f.expenseId, el);
      targets.push(el);
    }
    for (const t of targets) {
      t.total += 1;
      if (f.isSettled) t.settled += 1;
      if (f.isTouched) t.touched += 1;
    }
  }

  // A tally with no live charge stays "none" so the FE can tell "nothing billed here"
  // from "billed and unpaid" — only the latter should ever look outstanding. "paid"
  // requires EVERY charge settled, so one unpaid line keeps the whole tally off green.
  const resolve = (t: Tally): SettlementState =>
    t.total === 0 ? "none" : t.settled === t.total ? "paid" : t.settled > 0 || t.touched > 0 ? "partial" : "unpaid";

  const out = new Map<string, GridSettlementDto>();
  for (const [entryId, acc] of perEntry) {
    const cells = emptySettlementCells();
    for (const [bucket, t] of acc.buckets) cells[bucket] = resolve(t);
    const rooms: Record<string, Record<SettlementBucket, SettlementState>> = {};
    for (const [listingId, roomBuckets] of acc.rooms) {
      const roomCells = emptySettlementCells();
      for (const [bucket, t] of roomBuckets) roomCells[bucket] = resolve(t);
      rooms[listingId] = roomCells;
    }
    const expenseLines: Record<string, SettlementState> = {};
    for (const [expenseId, t] of acc.expenseLines) expenseLines[expenseId] = resolve(t);
    out.set(entryId, { status: resolve(acc.row), cells, rooms, expenseLines });
  }
  return out;
}

/** One itemized component the re-mint WOULD create: its room (`unitId`; an owner
 * component carries the owner's listingId — matching how mintItemizedCharges stamps
 * `unitId: owner.listingId`), the per-utility ChargeCategory id it routes through, and
 * its amount (subsidy is negative). */
type ItemizedComponent = {
  unitId: string | null;
  categoryId: string;
  amount: number;
  /** {@link componentIdentity} of the charge this component WOULD mint. Lets the no-op
   *  detector apply the same skip the mint does — without it, a part-paid month churns a
   *  cancel-and-reissue on every Bill click. Absent on components whose family carries no
   *  stable identity. */
  identity?: string;
};


// ─── Utility component maps — THE anti-drift seam (lock-step refactor, piece A) ──────────────
//
// Four places must agree about which utilities carry money: the tenant mint, the tenant
// preview, the owner mint and the owner preview. They used to be four independent array
// literals. TypeScript checks each ELEMENT of such a literal against `Utility`, but NEVER that
// every member appears — so omitting one compiles cleanly. That is not theoretical: adding
// `maintenance` to the allocation and forgetting the tenant array shipped, and only blew up at
// Bill time as IssuanceError("SUM_INVARIANT") in front of an admin. Probing it afterwards:
// deleting a member from a `Record<Utility, …>` is 1 type error; deleting the same member from
// the array literal was 0 errors.
//
// A `Record` keyed by the union is exhaustive by construction, so the compiler now refuses to
// build until a new utility is handled in BOTH the tenant and owner maps. Object.keys preserves
// the literal key order, so the maps also carry the deterministic line order the documents rely
// on — one declaration for membership AND order, instead of two things that can disagree.
const TENANT_SHARE_OF: Record<Utility, (a: ComputeResult["allocations"][number]) => number> = {
  electricity: (a) => a.tnbShare,
  water: (a) => a.airSelangorShare,
  sewerage: (a) => a.indahShare,
  wifi: (a) => a.wifiShare,
  cleaning: (a) => a.cleaningShare,
  maintenance: (a) => a.maintenanceShare,
  subsidy: (a) => -a.subsidyDeduction,
};
const TENANT_UTILITIES = Object.keys(TENANT_SHARE_OF) as Utility[];

// Owner amounts come from the ENTRY's raw/pattern/bearer columns, not the allocation. The
// cleaning/wifi/maintenance gates use `!== "tenant"` (never `=== "owner"`) to match
// fundedByForUtility's convention — a stricter gate would silently drop a legacy bearer value
// here while the caller's ownerBorne formula still counted it, tripping SUM_INVARIANT on
// otherwise-valid data.
const OWNER_AMOUNT_OF: Record<OwnerUtility, (e: MintItemizedChargesEntryInput) => number> = {
  electricity: (e) => (e.tnbPattern === "absorbed" ? num(e.tnbTotalRaw) : 0),
  water: (e) => (e.airPattern === "absorbed" ? num(e.airSelangorRaw) : 0),
  cleaning: (e) => (e.cleaningBearer === "tenant" ? 0 : num(e.cleaning)),
  wifi: (e) => (e.wifiBearer === "tenant" ? 0 : num(e.wifi)),
  maintenance: (e) => (e.maintenanceFeeBearer === "tenant" ? 0 : num(e.maintenanceFee)),
};
const OWNER_UTILITIES = Object.keys(OWNER_AMOUNT_OF) as OwnerUtility[];

/**
 * PRIVATE SUBMETER ELECTRICITY — the per-room aircond a tenant actually consumed.
 *
 * THE BUG THIS CLOSES: a room's `GridMeterReading.amount` reached the money engine ONLY as
 * `RoomInput.airconCharge`, where compute.ts uses it to SHRINK the shared TNB pool
 * (`leftoverTnb = TNB − Σaircond`) — and was then dropped. No code path ever minted it into
 * a Charge, so a partitioned tenant's own aircond consumption reached NO invoice. Worse, it
 * hid itself: once Σaircond exceeded the master TNB bill, `leftoverTnb` clamped to 0 and the
 * tenant's electricity line vanished ENTIRELY rather than merely being wrong. The parallel
 * legacy meter path DOES mint this (`AC-`, meter/service.ts) but reads a DIFFERENT table
 * (`MeterReading`), so readings entered on the grid could never reach it.
 *
 * WHY NOT A `UTILITY_SPEC` MEMBER: every member of `TENANT_SHARE_OF` feeds the per-room
 * Σ-invariant asserted against `alloc.computedAmount`, and aircond is deliberately NOT part
 * of computedAmount — compute.ts bills it separately by design (meter/compute.ts:107-113).
 * Adding it there would trip `IssuanceError("SUM_INVARIANT")` on every Bill. So it mints
 * OUTSIDE the Σ, exactly like a custom recurring line.
 *
 * WHY KEYED OFF THE ALLOCATION, NOT THE RAW READINGS: a WHOLE unit's readings carry
 * `tenancyId: null` and are folded into ONE synthesized occupied room by
 * {@link buildBillRooms}, so iterating readings directly would bill nobody there. Reading
 * the occupied set instead is mode-correct for BOTH listing modes by construction. A VACANT
 * room's aircond is `ownerAttributableAircond` (the owner's, never a tenant's) and is absent
 * from `alloc.allocations` — so it can never leak onto a tenant invoice through here.
 *
 * NOT gated on `computedAmount > 0` (unlike the utility loop): that guard is exactly what
 * would re-hide this money. A room whose every pooled share is 0 — the clamped-leftover case
 * above — still owes its own metered consumption.
 */
function aircondComponents(
  alloc: ComputeResult,
  rooms: readonly RoomInput[],
): Array<{ unitId: string; tenancyId: string; partyId: string; amount: number }> {
  const airconByUnit = new Map(rooms.map((r) => [r.unitId, r.airconCharge]));
  const out: Array<{ unitId: string; tenancyId: string; partyId: string; amount: number }> = [];
  for (const a of alloc.allocations) {
    const amount = round2(airconByUnit.get(a.unitId) ?? 0);
    if (!(amount > 0)) continue;
    out.push({ unitId: a.unitId, tenancyId: a.tenancyId, partyId: a.partyId, amount });
  }
  return out;
}

/** PURE. Itemize only the utility Charges that {@link mintItemizedCharges}
 * creates. The candidate membership, order, zero guards, tenant-direct skip and
 * private-aircond source are deliberately the same declarations the mint uses.
 * Recurring and GridExpense lines have their own exact read DTOs and never enter
 * this utility-only plan. */
export function toGridBillUtilityPlanLines(
  entry: MintItemizedChargesEntryInput,
  alloc: ComputeResult,
  rooms: readonly RoomInput[],
  ownerListingId: string | null,
): GridBillUtilityPlanLineDto[] {
  const lines: GridBillUtilityPlanLineDto[] = [];

  // Actual mint order: pooled tenant components per occupied room first.
  for (const a of alloc.allocations) {
    if (!(a.computedAmount > 0)) continue;
    for (const utility of TENANT_UTILITIES) {
      const amount = TENANT_SHARE_OF[utility](a);
      if (amount === 0) continue;
      if (fundedByForUtility(entry, utility) === "tenant_direct") continue;
      lines.push({
        key: `utility:tenant:${a.unitId}:${utility}`,
        code: utility,
        label: UTILITY_DESCRIPTION[utility],
        payer: "tenant",
        amount: round2(amount).toFixed(2),
        listingId: a.unitId,
        tenancyId: a.tenancyId,
      });
    }
  }

  // Private submeter electricity is outside computedAmount, including for the
  // synthesized WHOLE room and for a fully-subsidised RM0 pooled allocation.
  for (const ac of aircondComponents(alloc, rooms)) {
    lines.push({
      key: `utility:tenant:${ac.unitId}:private_aircond`,
      code: "private_aircond",
      label: "Aircond (private meter)",
      payer: "tenant",
      amount: ac.amount.toFixed(2),
      listingId: ac.unitId,
      tenancyId: ac.tenancyId,
    });
  }

  for (const utility of OWNER_UTILITIES) {
    const amount = OWNER_AMOUNT_OF[utility](entry);
    if (amount === 0) continue;
    if (fundedByForUtility(entry, utility) === "tenant_direct") continue;
    lines.push({
      key: `utility:owner:${entry.apartmentId}:${utility}`,
      code: utility,
      label: UTILITY_DESCRIPTION[utility],
      payer: "owner",
      amount: round2(amount).toFixed(2),
      listingId: ownerListingId,
      tenancyId: null,
    });
  }

  return lines;
}

type GridBillUtilityPlanEntry = MintItemizedChargesEntryInput & {
  billedAt: Date | null;
  invoicedAt: Date | null;
};

export interface ResolvedGridTnbSubsidy {
  mode: BillingMode;
  computePolicy: SubsidyPolicy;
  policy: GridTnbSubsidyPolicy;
  tnbSubsidyCap: number | null;
  /** Written only by a first successful Bill; null denotes an already-locked or
   * pre-snapshot historical row. */
  snapshotOnBill: { policy: GridTnbSubsidyPolicy; cap: number | null } | null;
}

/**
 * Resolve the grid's effective subsidy policy without changing historical money.
 *
 * A billed row with no snapshot predates the unit-cap feature and therefore stays
 * on the legacy per-pax rail even if an apartment cap is configured later. A new
 * row may adopt the apartment cap; once adopted, its entry snapshot wins for every
 * read and re-Bill (including after the apartment setting changes).
 */
export function resolveGridTnbSubsidy(input: {
  isWholeUnit: boolean;
  partitionBillingMode: string;
  subsidyPerPax: number;
  apartmentTnbSubsidyCap: number | null;
  billedAt: Date | null;
  subsidyPolicySnapshot: string | null;
  tnbSubsidyCapSnapshot: number | null;
}): ResolvedGridTnbSubsidy {
  // Keep one policy/validation implementation for both billing rails. The grid
  // adapter supplies its own lock signal (`billedAt`) because, unlike
  // UnitUtilityBill, UnitBillsGridEntry has no status/billingMode snapshot.
  const liveMode: BillingMode = input.isWholeUnit
    ? "whole"
    : input.apartmentTnbSubsidyCap != null || input.partitionBillingMode === "SUBSIDY"
      ? "subsidy"
      : "no_subsidy";
  const explicitSnapshot = input.subsidyPolicySnapshot != null;
  const historicalLegacy = !input.isWholeUnit && input.billedAt != null && !explicitSnapshot;
  const billBillingMode: BillingMode = input.isWholeUnit
    ? "whole"
    : input.subsidyPolicySnapshot === "none"
      ? "no_subsidy"
      : explicitSnapshot || historicalLegacy
        ? "subsidy"
        : liveMode;
  const resolved = resolveUtilitySubsidyPolicy({
    liveMode,
    apartmentTnbSubsidyCap: input.apartmentTnbSubsidyCap,
    organizationSubsidyPerPax: input.subsidyPerPax,
    billStatus: input.billedAt == null ? "draft" : "charged",
    billBillingMode,
    billPolicySnapshot: input.subsidyPolicySnapshot,
    billTnbSubsidyCapSnapshot: input.tnbSubsidyCapSnapshot,
    // Grid entries have no legacy-rate snapshot column. An explicit legacy
    // marker therefore continues the existing org-level rate at read/re-Bill.
    billSubsidyPerPax: input.subsidyPolicySnapshot === "legacy_per_pax"
      ? input.subsidyPerPax
      : null,
  });
  const cap = resolved.subsidyPolicy.kind === "unit_tnb_cap_equal_tenancy"
    ? resolved.subsidyPolicy.cap
    : null;
  return {
    mode: resolved.mode,
    computePolicy: resolved.subsidyPolicy,
    policy: resolved.subsidyPolicy.kind,
    tnbSubsidyCap: cap,
    snapshotOnBill:
      !input.isWholeUnit
      && input.billedAt == null
      && input.subsidyPolicySnapshot == null
        ? { policy: resolved.subsidyPolicy.kind, cap }
        : null,
  };
}

export interface GridBillUtilityPlanInput {
  entry: GridBillUtilityPlanEntry;
  rawRooms: readonly RoomInput[];
  isWholeUnit: boolean;
  partitionBillingMode: string;
  activeTenancy: { tenancyId: string; partyId: string; unitId: string } | null;
  subsidyPerPax: number;
  /** Server-resolved snapshot/current policy. Omitted by legacy pure callers. */
  resolvedSubsidy?: ResolvedGridTnbSubsidy;
  billingDocuments: boolean;
  ownerListingId: string | null;
}

function emptyGridBillUtilityPlan(
  status: GridBillUtilityPlanDto["status"] = "not_applicable",
  mode: GridBillUtilityPlanDto["mode"] = null,
  errorCode: string | null = null,
  blockedTenancyIds: string[] = [],
): GridBillUtilityPlanDto {
  return {
    status,
    mode,
    subsidyPerPax: "0.00",
    subsidyPolicy: null,
    tnbSubsidyCap: null,
    tnbSubsidyBreakdown: null,
    lines: [],
    blockedTenancyIds,
    errorCode,
  };
}

/** PURE first-issuance preflight for the utility portion of Bill. It repeats
 * Bill's validation order (raw-room shaping/compute, absorbed invariant, Bill
 * room shaping, pax gate, configured-mode compute) but performs no reads/writes.
 * The caller supplies the one org subsidy value and all room/tenancy facts from
 * getGridService's page-wide batches. */
export function buildGridBillUtilityPlan(input: GridBillUtilityPlanInput): GridBillUtilityPlanDto {
  const resolved = input.resolvedSubsidy ?? resolveGridTnbSubsidy({
    isWholeUnit: input.isWholeUnit,
    partitionBillingMode: input.partitionBillingMode,
    subsidyPerPax: input.subsidyPerPax,
    apartmentTnbSubsidyCap: null,
    billedAt: input.entry.billedAt,
    subsidyPolicySnapshot: null,
    tnbSubsidyCapSnapshot: null,
  });
  const mode = resolved.mode;
  const subsidyPerPax = resolved.computePolicy.kind === "legacy_per_pax"
    ? resolved.computePolicy.amountPerPax
    : 0;
  const base = (status: GridBillUtilityPlanDto["status"], errorCode: string | null = null, blockedTenancyIds: string[] = []): GridBillUtilityPlanDto => ({
    ...emptyGridBillUtilityPlan(status, mode, errorCode, blockedTenancyIds),
    subsidyPerPax: subsidyPerPax.toFixed(2),
    subsidyPolicy: resolved.policy,
    tnbSubsidyCap: resolved.tnbSubsidyCap?.toFixed(2) ?? null,
  });

  // No utility Charge is minted with the document rail dark. A legacy billed,
  // document-less entry is also the exact already_billed short circuit in Bill.
  if (!input.billingDocuments) return base("not_applicable");
  if (input.entry.billedAt && input.entry.invoicedAt == null) return base("not_applicable");

  try {
    const rawRooms = [...input.rawRooms];
    const rawTnbTotal = num(input.entry.tnbTotalRaw);
    const rawAirSelangor = num(input.entry.airSelangorRaw);
    if (!Number.isFinite(rawTnbTotal) || !Number.isFinite(rawAirSelangor)) {
      return base("unavailable", "PREVIEW_FAILED");
    }

    const shaped = shapeUtilityPool({
      tnbPattern: input.entry.tnbPattern as never,
      airPattern: input.entry.airPattern as never,
      rawTnbTotal,
      rawAirSelangor,
      rooms: rawRooms,
    });
    const pool: PoolComponents = {
      tnbTotal: shaped.tnbTotal,
      airSelangor: shaped.airSelangor,
      indahWater: 0,
      wifi: num(input.entry.wifi),
      cleaning: num(input.entry.cleaning),
      maintenance: num(input.entry.maintenanceFee),
    };
    const bearers: Bearers = {
      indahWater: "owner",
      cleaning: input.entry.cleaningBearer as never,
      wifi: input.entry.wifiBearer as never,
      maintenance: input.entry.maintenanceFeeBearer as never,
    };
    const privateAircond = !input.isWholeUnit;

    // Bill performs this raw-room/no-subsidy compute before resolving the Bill
    // room set. Keep that precedence so a compute error is not mislabeled pax.
    computeAllocation("no_subsidy", 0, pool, rawRooms, bearers, privateAircond);

    if (input.entry.tnbPattern === "absorbed" && !(rawTnbTotal > 0)) {
      return base("unavailable", "ABSORBED_REQUIRES_OWNER_BORNE");
    }
    if (input.entry.airPattern === "absorbed" && !(rawAirSelangor > 0)) {
      return base("unavailable", "ABSORBED_REQUIRES_OWNER_BORNE");
    }

    const built = billRoomsFromLoaded(rawRooms, input.isWholeUnit, input.activeTenancy);
    if (built.blockedTenancyIds.length > 0) {
      return base("pax_blocked", null, [...new Set(built.blockedTenancyIds)]);
    }

    const alloc = computeAllocation(mode, resolved.computePolicy, pool, built.rooms, bearers, privateAircond);

    // A re-Bill may retain component identities already paid. The fresh split is
    // useful for validation above but is not an honest list of newly-created lines.
    if (input.entry.invoicedAt != null) return base("rebill_review");

    const lines = toGridBillUtilityPlanLines(input.entry, alloc, built.rooms, input.ownerListingId);
    if (lines.some((line) => line.payer === "owner") && input.ownerListingId == null) {
      return base("unavailable", "OWNER_UNRESOLVED");
    }
    let tnbSubsidyBreakdown: GridBillTnbSubsidyBreakdownDto | null = null;
    if (resolved.policy === "unit_tnb_cap_equal_tenancy" && resolved.tnbSubsidyCap != null && alloc.allocations.length > 0) {
      const allocations = alloc.allocations.map((allocation) => ({
        listingId: allocation.unitId,
        tenancyId: allocation.tenancyId,
        amount: round2(Math.max(0, allocation.tnbShare - allocation.subsidyDeduction)).toFixed(2),
      }));
      const tenantExcess = round2(allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0));
      tnbSubsidyBreakdown = {
        residual: round2(Math.max(0, alloc.leftoverTnb)).toFixed(2),
        ownerCap: resolved.tnbSubsidyCap.toFixed(2),
        ownerPortion: round2(alloc.subsidyCovered).toFixed(2),
        tenantExcess: tenantExcess.toFixed(2),
        occupiedRoomCount: alloc.allocations.length,
        allocations,
      };
    }
    return {
      status: "ready",
      mode,
      subsidyPerPax: subsidyPerPax.toFixed(2),
      subsidyPolicy: resolved.policy,
      tnbSubsidyCap: resolved.tnbSubsidyCap?.toFixed(2) ?? null,
      tnbSubsidyBreakdown,
      lines,
      blockedTenancyIds: [],
      errorCode: null,
    };
  } catch (e) {
    if (e instanceof ComputeError || e instanceof ShapeError) return base("unavailable", e.code);
    return base("unavailable", "PREVIEW_FAILED");
  }
}

/**
 * PURE preview of the itemized components a fresh mint would produce — used by
 * rebillSupersedeTx's component-aware no-op to compare the fresh plan against the live
 * charges WITHOUT minting anything.
 *
 * It MUST mirror {@link mintItemizedCharges}'s candidate + skip logic EXACTLY: the
 * tenant candidates come from the allocation's per-utility shares (RM0 rooms —
 * `computedAmount <= 0` — contribute nothing), the owner candidates from the entry's
 * raw/pattern/bearer columns; a component is dropped when its amount is 0 or its
 * utility is funded `tenant_direct` (the tenant pays the provider, never billed). The
 * two are kept in lock-step by construction and mintItemizedCharges' Σ-invariant is the
 * runtime backstop against any drift. Amounts only (no classify()/SST) — the no-op
 * compares (unitId, categoryId, amount), which is all `mint → issue` persists per line.
 */
function previewItemizedComponents(
  entry: MintItemizedChargesEntryInput,
  alloc: ComputeResult,
  ownerBorne: number,
  ownerListingId: string | null,
  cats: NonNullable<Awaited<ReturnType<typeof resolveGridInvoiceCategories>>>,
  rooms: readonly RoomInput[],
  /** The period key the identities below are built from — MUST be the same `ym` the mint
   *  stamps into its chargeNumbers, or no skip ever matches here. */
  ym: string,
  /**
   * The SAME set handed to {@link mintItemizedCharges}. Withholding a component at mint
   * but still previewing it would make the live set and the fresh preview permanently
   * unequal, so `already_billed` could never fire and EVERY re-Bill of a part-paid month
   * would churn a needless cancel-and-reissue.
   */
  skipIdentities: ReadonlySet<string> = new Set(),
): ItemizedComponent[] {
  const out: ItemizedComponent[] = [];
  // Private submeter electricity — mirrors the mint's OWN aircond loop, which likewise runs
  // outside the `computedAmount > 0` room guard. Omitting it here would make every re-Bill of
  // a metered month miss `already_billed` and churn a needless reissue.
  for (const ac of aircondComponents(alloc, rooms)) {
    if (skipIdentities.has(`GRIDAC-${ym}-${ac.unitId}`)) continue;
    out.push({ unitId: ac.unitId, categoryId: cats.electricity.tenantCategoryId, amount: ac.amount, identity: `GRIDAC-${ym}-${ac.unitId}` });
  }
  for (const a of alloc.allocations) {
    if (!(a.computedAmount > 0)) continue; // RM0 room → no charge (unchanged mint guard)
    for (const utility of TENANT_UTILITIES) {
      const amount = TENANT_SHARE_OF[utility](a);
      if (amount === 0) continue;
      if (fundedByForUtility(entry, utility) === "tenant_direct") continue;
      if (skipIdentities.has(`GRIDUTIL-${ym}-${a.unitId}-${utility.toUpperCase()}`)) continue;
      out.push({ unitId: a.unitId, categoryId: cats[utility].tenantCategoryId, amount: round2(amount), identity: `GRIDUTIL-${ym}-${a.unitId}-${utility.toUpperCase()}` });
    }
  }
  if (ownerBorne > 0) {
    for (const utility of OWNER_UTILITIES) {
      const amount = OWNER_AMOUNT_OF[utility](entry);
      if (amount === 0) continue;
      if (fundedByForUtility(entry, utility) === "tenant_direct") continue;
      // entry.apartmentId, NOT ownerListingId: the mint stamps the apartment id into a
      // GRIDOWN- charge number even though the charge's unitId is the owner's listing.
      if (skipIdentities.has(`GRIDOWN-${ym}-${entry.apartmentId}-${utility.toUpperCase()}`)) continue;
      out.push({ unitId: ownerListingId, categoryId: cats[utility].ownerCategoryId, amount: round2(amount), identity: `GRIDOWN-${ym}-${entry.apartmentId}-${utility.toUpperCase()}` });
    }
  }
  return out;
}

// ─────────────────── Recurring custom lines (Task 5, spec R7) ────────────────
// A CUSTOM GridEntryRecurringLine is a FROZEN per-period snapshot that mints exactly one
// Charge, routed by its stored category (recurring_other_tenant → IVTEN / recurring_other_owner
// → IVOWN) to its resolved party. Every recurring Charge carries BOTH sourceGridEntryId (so the
// existing re-Bill supersede reclaims + credits it exactly like a utility charge) AND
// sourceRecurringLineId (line-level provenance for invoice/owner-statement). Owner lines feed the
// ownerBorne Σ-invariant. Cleaning/WiFi keep their scalar path (Non-goal) — never here.

/** Structural shape of a recurring snapshot line the mint + no-op preview consume. */
type RecurringLineRow = {
  id: string; definitionId: string; name: string; amount: Prisma.Decimal; bearer: string;
  nature?: string | null;
  categoryId: string; resolvedPartyId: string; resolvedTenancyId: string | null; resolvedUnitId: string;
};

/** Load an entry's CUSTOM recurring snapshot lines. Shared by mintItemizedCharges, the re-Bill
 * no-op preview, and the billService owner-Σ / gate prep so all three read one source of truth. */
async function loadRecurringLines(tx: Prisma.TransactionClient, orgId: string, gridEntryId: string): Promise<RecurringLineRow[]> {
  return tx.gridEntryRecurringLine.findMany({
    where: { organizationId: orgId, gridEntryId },
    select: { id: true, definitionId: true, name: true, amount: true, bearer: true, nature: true, categoryId: true, resolvedPartyId: true, resolvedTenancyId: true, resolvedUnitId: true },
  });
}

/** True iff some enabled CUSTOM definition is applicable to `periodMonth` yet has NO materialized
 * snapshot line on the entry (its owner/tenant target was unresolvable at open, R4) — a
 * fail-closed billing conflict (`recurring_unresolved`), never a silent omission. */
async function unresolvedRecurringDefs(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  periodMonth: Date,
  existingLines: RecurringLineRow[],
): Promise<boolean> {
  const defs = await tx.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId, kind: "CUSTOM", archivedAt: null },
    include: { revisions: true },
  });
  const haveLineFor = new Set(existingLines.map((l) => l.definitionId));
  const t = periodMonth.getTime();
  for (const def of defs) {
    const rev = def.revisions.find((r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()));
    if (rev && rev.enabled && !haveLineFor.has(def.id)) return true;
  }
  return false;
}

/** Structural view of the grid entry the nature guard reads (scalar wifi/cleaning + their nature). */
type NatureGuardEntry = { apartmentId: string; wifi: Prisma.Decimal | null; cleaning: Prisma.Decimal | null } & ScalarNatureEntry;

/**
 * Fix 3 (spec R5): true iff — with ENABLE_CHARGE_NATURE_ROUTING ON — some ENABLED recurring
 * component about to be billed has a NULL `nature`. Such a component was configured WHILE the flag
 * was OFF (the config route's 422 NATURE_REQUIRED never fired for it), so minting it now would
 * SILENTLY default it to profit (recurringChargeData / scalarNatureFor treat null as
 * manager_revenue). The caller fails closed (`nature_unresolved`) so NOTHING is minted and the
 * admin re-saves the definition with a nature. Caller gates on the flag — inert when OFF.
 *
 * Covers BOTH representations of a nature-bearing recurring charge:
 *  (a) CUSTOM snapshot lines — every {@link GridEntryRecurringLine} is definition-backed, so a
 *      billable (amount>0) line with null nature is unambiguously a dark-period/legacy definition.
 *  (b) SCALAR WiFi/Cleaning — fire whenever the scalar is billable (>0) and
 *      {@link resolveScalarNatures} cannot resolve a nature for it from ANY source.
 *
 * ── charge-nature gate (2026-07-27) — two deliberate reversals of the original Fix 3 ──────────
 * 1. NO MORE BARE-SCALAR EXEMPTION. (b) used to be definition-AWARE: a scalar with no backing
 *    {@link RecurringChargeDefinition} was treated as "legacy, not subject to the nature
 *    requirement" and billed normally. In practice that is the COMMON case, not a legacy edge —
 *    an org with zero recurring definitions has every WiFi/Cleaning scalar unconfigured — and
 *    "unconfigured" then silently meant `wifiBearer` = the schema default 'owner' + nature null
 *    ⇒ manager PROFIT ⇒ an IVOWN receivable billed to the owner for the owner's own WiFi. Not
 *    configuring a unit must never be read as a money decision, so an undecided billable scalar
 *    now fails closed like every other null-nature component.
 * 2. THE GUARD AND THE MINT SHARE ONE RESOLVER. Fix 3b made (b) key off the FROZEN
 *    entry.wifiNature/cleaningNature column because the mint read that column — pessimism bought
 *    the agreement. But `billedAt`/`invoicedAt` make an entry non-syncable
 *    ({@link isPeriodSnapshotSyncable}) and materialize is create-only, so a frozen NULL can
 *    never be written again: naturing the definition afterwards fired this guard FOREVER, with a
 *    message ("re-save the recurring definition with a type") that could not possibly help.
 *    Both sides now call {@link resolveScalarNatures}, whose precedence (frozen → governing
 *    revision → unit-setting default) resolves that dead end while keeping the real invariant:
 *    the guard and the mint always read the identical value.
 */
async function billableNatureUnresolved(
  tx: Prisma.TransactionClient,
  orgId: string,
  entry: NatureGuardEntry,
  periodMonth: Date,
  recurLines: RecurringLineRow[],
): Promise<boolean> {
  // (a) CUSTOM snapshot lines — definition-backed by construction.
  for (const l of recurLines) if (num(l.amount) > 0 && l.nature == null) return true;

  // (b) SCALAR WiFi/Cleaning — billable ∧ unresolvable ⇒ fail closed. Only a BILLABLE (>0) scalar
  // is gated: a zero/absent scalar mints nothing, so there is no money decision to make and an
  // unconfigured unit that bills no WiFi is never blocked.
  const scalarNature = await resolveScalarNatures(tx, orgId, entry.apartmentId, periodMonth, entry);
  if (num(entry.wifi) > 0 && scalarNature.wifi == null) return true;
  if (num(entry.cleaning) > 0 && scalarNature.cleaning == null) return true;
  return false;
}

/** The itemized components an entry's recurring lines contribute (same (unitId, categoryId,
 * amount) shape previewItemizedComponents emits) — for the re-Bill no-op multiset comparison. */
async function recurringComponents(tx: Prisma.TransactionClient, orgId: string, gridEntryId: string, ym?: string): Promise<ItemizedComponent[]> {
  const lines = await loadRecurringLines(tx, orgId, gridEntryId);
  return lines.filter((l) => num(l.amount) > 0).map((l) => ({
    unitId: l.resolvedUnitId,
    categoryId: l.categoryId,
    amount: round2(num(l.amount)),
    // Mirrors recurringChargeData's chargeNumber exactly. Omitted when no `ym` is supplied
    // (the pure-preview callers that never skip).
    identity: ym ? `GRIDRECUR-${ym}-${l.definitionId}` : undefined,
  }));
}

/** The Charge `data` a recurring snapshot line mints (Task 5). chargeType "utility" so the re-Bill
 * reclaim (findGridInvoiceState) finds it; chargeNumber GRIDRECUR-<ym>-<definitionId>[-r<rev>] is
 * globally unique (the recurring dedup guarantee — the amount-index exempts sourceRecurringLineId).
 * Tenant-borne → tenancyId+unitId+partyId; owner-borne → unitId(owner listing)+partyId, no tenancy. */
function recurringChargeData(orgId: string, entryId: string, ym: string, suffix: string, monthDate: Date, line: RecurringLineRow) {
  const amt = num(line.amount).toFixed(2);
  const isOwner = line.bearer === "owner";
  // Nature routing (ENABLE_CHARGE_NATURE_ROUTING): a tenant-borne line snapshotted nature:"expense"
  // is a recovery of a manager-advanced cost, NOT KAEN service revenue → recovery_of_advance. Owner
  // lines stay owner_funds regardless (owner economics never become a manager recovery). Flag OFF:
  // nature stamped null AND revenueRecognition unchanged (byte-identical to pre-feature behaviour).
  const natureOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");
  const isExpense = natureOn && line.nature === "expense" && !isOwner;
  const revenueRecognition = isOwner ? "owner_funds" : isExpense ? "recovery_of_advance" : "manager_revenue";
  return {
    organizationId: orgId,
    chargeNumber: `GRIDRECUR-${ym}-${line.definitionId}${suffix}`,
    tenancyId: isOwner ? null : line.resolvedTenancyId,
    unitId: line.resolvedUnitId,
    partyId: line.resolvedPartyId,
    categoryId: line.categoryId,
    chargeType: "utility" as const,
    status: "posted" as const,
    postedAt: new Date(),
    description: `${line.name} ${ym}`,
    dueDate: monthDate,
    amount: amt,
    currency: "MYR",
    outstandingAmount: amt,
    billingMonth: monthDate,
    sourceGridEntryId: entryId,
    sourceRecurringLineId: line.id,
    attachmentKeys: [],
    fundedBy: isOwner ? "owner" : "manager",
    revenueRecognition,
    settlementRecipient: isOwner ? "owner" : "manager",
    nature: natureOn ? (line.nature ?? null) : null,
  };
}

/**
 * RE-BILL supersede + itemized reissue, running INSIDE the grid row's single
 * $transaction. PRE-LOCK: every guard returns BEFORE the updateMany relock, so a blocked
 * / confirmation-required / no-op / occupancy return leaves billedAt UNMUTATED and
 * nothing superseded (HARD RULE #1 — the Task-4 stranding bug). The supersede set is the
 * PROVENANCE-resolved existing invoices ({@link findGridInvoiceState}.reclaimable) —
 * including a legacy invoice whose charge was orphaned (`sourceGridEntryId` nulled by the
 * entry's onDelete:SetNull), so it is re-Billed rather than hard-conflicted (rule 6).
 *
 * ORDER (billing-mechanism rework — all PRE-LOCK, no write):
 *   1. PREVIOUS-PERIOD block (rule 1) — period before the org-local current month →
 *      `rebill_blocked_previous_period`.
 *   2. ANY-PAYMENT block (rule 4) — the existing invoice charges carry ANY active
 *      (non-reversed) allocation, partial OR full → `rebill_blocked_payment_exists`
 *      (the paired owner invoice is left untouched; use accounting reversal instead). This
 *      REPLACES Task 8's fully-paid-freeze / partial-reversal — the grid never reverses a
 *      received payment now.
 *   3. OCCUPANCY-CHANGE fail-closed guard → `occupancy_changed`.
 *   4. COMPONENT-AWARE no-op → `already_billed` (nothing changed).
 *   5. CONFIRMATION gate (rule 3) — a real change to reissue but the admin has not
 *      confirmed → `rebill_confirmation_required` with the existing invoice numbers for
 *      the modal. Do NOT silently re-Bill.
 * Then (confirmed): RELOCK + bump billRevision (0 rows → `stale`) → credit old charges →
 * re-mint + re-group-issue → CANCEL old docs (reason "re-Billed / superseded", link
 * `supersededByDocumentId`) → audit → post-commit notify → `reinvoiced` (rule 5).
 *
 * ATOMICITY: a Prisma interactive $transaction COMMITS on a returned value and rolls back
 * ONLY on a THROW, so the relock precedes all writes and any later failure rolls the
 * ENTIRE re-Bill back to `save_failed`, leaving the prior invoices intact. IDEMPOTENT on
 * retry: a repeat with the old token relocks 0 rows (`stale`); a repeat with the new
 * token sees the fresh docs as the live set and no-ops (`already_billed`) — so neither the
 * invoices nor the notification are duplicated.
 */
/** A re-Bill's affected recipient (a tenant party or the owner party), de-duped by
 * partyId. Carried OUT of rebillSupersedeTx on its result so billService can emit the
 * notifications POST-COMMIT (see notifyRebillParties) — never inside the money tx. */
type NotifyParty = { partyId: string; kind: "owner" | "tenant" };
/** rebillSupersedeTx's result, widened with internal payloads STRIPPED by billService
 * before the FE manifest (they never leave the server; only `reinvoiced` carries them):
 * `_notifyParties` (post-commit recipients) and `_newInvoiceNumbers` (the replacement
 * invoice numbers for the notification body, rule 5.10). */
type RebillResult = BillRowResult & {
  _notifyParties?: NotifyParty[];
  _newInvoiceNumbers?: { tenant: string | null; owner: string | null };
};

async function rebillSupersedeTx(
  tx: Prisma.TransactionClient,
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  entry: MintItemizedChargesEntryInput & { billRevision: number },
  expectedUpdatedAt: string,
  alloc: ComputeResult,
  ownerBorne: number,
  ym: string,
  periodMonth: Date,
  orgTimezone: string,
  reclaimable: GridInvoiceState,
  confirm: boolean,
  /** Same room set fed to `computeAllocation` — carries per-room `airconCharge`. */
  rooms: readonly RoomInput[],
): Promise<RebillResult> {
  const entryId = entry.id;
  const cats = await resolveGridInvoiceCategories(tx, session.orgId);
  if (!cats) throw new IssuanceError("CATEGORY_UNRESOLVED");

  // The supersede set = the provenance-resolved existing invoices (incl. legacy
  // null-sourced charges), NOT a sourceGridEntryId-only lookup.
  const live = reclaimable.reclaimableCharges;
  const liveIds = live.map((c) => c.id);

  // 1. PREVIOUS-PERIOD BLOCK (rule 1). Re-Bill is allowed ONLY for the CURRENT month in
  //    the org's local timezone — a past billing period must go through accounting
  //    correction. Enforced by billing PERIOD, not the invoice issue date.
  if (periodMonth.getTime() < currentBillingMonthUTC(orgTimezone).getTime()) {
    return { apartmentId, outcome: "rebill_blocked_previous_period" as const };
  }

  // 2. ANY-PAYMENT BLOCK (rule 4). If the existing invoice charges carry ANY active
  //    (non-reversed) payment allocation — partial, full, or any amount > 0 — DENY the
  //    WHOLE re-Bill (the paired owner invoice is left untouched — we return before any
  //    write). The admin must use the accounting adjustment/reversal process. This is the
  //    authoritative server-side, in-tx guard; the grid never reverses received payment.
  const { paid, unpaid, activePaidByChargeId } = await splitLiveChargesByPayment(tx, session.orgId, live);
  const partialRebillOn = isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES");

  // ── The PROTECTION set (review findings 1 + 2) ────────────────────────────
  //
  // `live` above is reclaimableCharges: charges on a live head-of-chain document, with
  // graduated invoices deliberately excluded (R5 — a real tax invoice is never reclaimed).
  // That is the right set to CANCEL. It is the wrong set to decide what money to protect,
  // and it was too narrow in two ways that each erased a receivable:
  //
  //   • a doc-less expense charge is not in it at all, yet creditIds unioned the doc-less
  //     list unconditionally — so a PAID expense was credited with its live allocation
  //     still attached, and re-billed;
  //   • the moment a partial re-Bill cancels the proforma, the kept paid lines lose their
  //     live document too, so on the NEXT re-Bill they were invisible here and got
  //     re-minted alongside the still-live original.
  //
  // So protection reads EVERY live grid charge for this entry, whatever document it does
  // or does not sit on. Only ever used to WITHHOLD (never to credit or mint), so a charge
  // wrongly included here is at worst not re-billed — the safe direction.
  //
  // Flag OFF: not computed, and nothing below consults it. Byte-identical to before.
  let protectedPaidIds = new Set<string>();
  let protectedPaid: { id: string; chargeNumber: string; amount: number; outstanding: number }[] = [];
  let allGridChargesForSplit: { id: string; chargeNumber: string; amount: number; outstanding: number }[] = [];
  if (partialRebillOn) {
    const allGridCharges = await tx.charge.findMany({
      where: {
        organizationId: session.orgId,
        sourceGridEntryId: entryId,
        status: { notIn: ["void", "credited"] },
      },
      select: { id: true, chargeNumber: true, amount: true, outstandingAmount: true },
    });
    allGridChargesForSplit = allGridCharges.map((c) => ({
      id: c.id,
      chargeNumber: c.chargeNumber,
      amount: num(c.amount),
      outstanding: num(c.outstandingAmount),
    }));
    const split = await splitLiveChargesByPayment(tx, session.orgId, allGridChargesForSplit);
    protectedPaid = split.paid;
    protectedPaidIds = new Set(split.paid.map((c) => c.id));

    // A PARTIALLY-paid charge is neither safely kept nor safely replaced.
    //
    // The split classified any charge with net cash > 0.005 as fully `paid`, so a line
    // paid RM100 of RM300 was withheld whole: the remaining RM200 was never re-billed, its
    // only document was cancelled, and keptPaidLines told the admin "Keeping Electricity ·
    // 300.00 · paid" when RM100 had arrived. Splitting the remainder onto a new document
    // while the original stays live is an accounting correction, not a re-Bill — so this
    // routes there, exactly as flag-off already did.
    const partiallyPaid = split.paid.filter((c) => c.outstanding > 0.005);
    if (partiallyPaid.length > 0) {
      const { paidBlockers } = assessPaidBlockers({ charges: live, docs: reclaimable.reclaimableDocs, activePaidByChargeId });
      return { apartmentId, outcome: "rebill_blocked_payment_exists" as const, paidBlockers };
    }
  }

  if (activePaidByChargeId.size > 0 && !partialRebillOn) {
    const { paidBlockers } = assessPaidBlockers({ charges: live, docs: reclaimable.reclaimableDocs, activePaidByChargeId });
    return { apartmentId, outcome: "rebill_blocked_payment_exists" as const, paidBlockers };
  }

  // PARTIAL RE-BILL (R4). Paid lines are kept exactly as they are — their charge stays
  // live and uncredited, and the invoice + receipt graduated from them are never touched.
  // Only the unpaid lines are credited and re-minted, so the fresh proforma carries no
  // trace of money the tenant has already paid.
  //
  // An EXPENSE line is withheld when ANY of its charges is paid — base or `-SST` sibling.
  //
  // The first version of this required BOTH, reasoning that a half-settled line would
  // otherwise leave the tenant owing tax with no document carrying it. That was the wrong
  // branch: with base paid and SST unpaid the group was NOT withheld, so the mint created a
  // fresh base beside the still-live paid one (expense charges are exempt from the
  // duplicate-amount index, so nothing stopped it) and the tenant was billed twice for
  // money they had already sent. Double-billing settled money is worse than the tax
  // question, and ANY-paid also matches how the line already READS everywhere else:
  // slice 1's expenseLines grain and expenseHasActivePayment both call a half-settled line
  // frozen.
  //
  // The whole GROUP is protected when any of it is paid, so the unpaid sibling is neither
  // credited nor re-minted — it stays live and still owed, on the document it was issued on.
  const paidIdentities = new Set<string>();
  /** identity → the amount the live (paid) charge carries. Feeds the Sigma-invariant. */
  const paidBilledAmounts = new Map<string, number>();
  if (partialRebillOn && protectedPaid.length > 0) {
    const paidIds = protectedPaidIds;
    // Groups are built over ALL of this entry's live charges, not just the paid ones —
    // otherwise an unpaid sibling is invisible here and cannot be protected.
    const expenseGroups = new Map<string, { id: string; chargeNumber: string; amount: number; outstanding: number }[]>();
    for (const c of allGridChargesForSplit) {
      const id = componentIdentity(c.chargeNumber);
      if (!id.startsWith("GRIDEXP-")) {
        if (paidIds.has(c.id)) {
          paidIdentities.add(id);
          paidBilledAmounts.set(id, c.amount);
        }
        continue;
      }
      const base = id.endsWith("-SST") ? id.slice(0, -"-SST".length) : id;
      expenseGroups.set(base, [...(expenseGroups.get(base) ?? []), c]);
    }
    for (const [, group] of expenseGroups) {
      if (!group.some((c) => paidIds.has(c.id))) continue;
      for (const c of group) {
        paidIdentities.add(componentIdentity(c.chargeNumber));
        paidBilledAmounts.set(componentIdentity(c.chargeNumber), c.amount);
        // Protect the unpaid sibling from the credit sweep too — it is not being re-minted,
        // so crediting it would silently drop the tax.
        protectedPaidIds.add(c.id);
      }
    }
  }

  // Resolve the apartment owner ONCE when either a live owner charge exists (occupancy
  // guard) or fresh owner-borne is > 0 (no-op preview + re-mint). OWNER_UNRESOLVED is
  // fatal only when we actually need to bill an owner (ownerBorne > 0).
  const needOwner = ownerBorne > 0 || live.some((c) => c.family === "owner_income");
  const owner = needOwner ? await resolveApartmentOwner(tx, session.orgId, apartmentId) : null;
  if (ownerBorne > 0 && !owner) throw new IssuanceError("OWNER_UNRESOLVED");

  // 3. OCCUPANCY-CHANGE FAIL-CLOSED GUARD. MONEY-CRITICAL, PRE-LOCK, PURE READ. If a
  // room's occupant changed since the invoice was issued (mid-period tenant hand-over, or
  // the unit changed owner), reissuing would re-bill the DEPARTED party. FAIL CLOSED with
  // `occupancy_changed`, write NOTHING; the admin handles the hand-over explicitly.
  {
    const freshPartyByUnit = new Map<string, { partyId: string; tenancyId: string }>();
    for (const a of alloc.allocations) freshPartyByUnit.set(a.unitId, { partyId: a.partyId, tenancyId: a.tenancyId });
    const currentOwnerPartyId = owner?.ownerPartyId ?? null;
    const occupancyChanged = live.some((c) => {
      if (c.family === "owner_income") return c.partyId !== currentOwnerPartyId;
      // Recurring custom lines (Task 5) are re-minted from a FROZEN GridEntryRecurringLine
      // snapshot that a re-Bill never re-resolves (sync/materialize only touch open periods,
      // never a billed one), so a TENANT recurring charge cannot have an occupancy change — it
      // is regenerated identically. (Owner recurring is family owner_income above, which still
      // correctly trips if the apartment owner changed.) Skip it here to avoid a false positive
      // when its resolvedUnitId has no fresh utility allocation this month.
      if (c.sourceRecurringLineId) return false;
      if (!c.unitId) return true;
      const fresh = freshPartyByUnit.get(c.unitId);
      if (!fresh) return true; // room no longer occupied (tenant left)
      return fresh.partyId !== c.partyId || fresh.tenancyId !== c.tenancyId;
    });
    if (occupancyChanged) {
      return { apartmentId, outcome: "occupancy_changed" as const };
    }
  }

  // 4. COMPONENT-AWARE no-op → `already_billed` (nothing changed). Compares the live
  // component multiset to the fresh mint preview by (unitId, categoryId, amount). A legacy
  // LUMP invoice never matches an itemized preview, so it correctly falls through to be
  // reissued as itemized.
  const fresh = previewItemizedComponents(entry, alloc, ownerBorne, owner?.listingId ?? null, cats, rooms, ym, paidIdentities);
  // Recurring custom snapshot lines each mint one Charge (Task 5), which appears in `live` via
  // sourceGridEntryId — so include their fresh components here or an UNCHANGED re-Bill of a
  // period carrying recurring lines would never match (never `already_billed`).
  // FIX 3 (final review): expense charges (spec bill-expenses) likewise appear in `live` via
  // findGridInvoiceState's chargeType:"expense" provenance match — so their fresh preview
  // (expenseComponents, flag-gated/[] when off) must be included too, or ANY month carrying
  // an expense would never match and would always churn a needless reissue.
  // Recurring and expense previews must apply the SAME skip the mint does. `fresh` above
  // already does (previewItemizedComponents takes paidIdentities); these two did not, so a
  // part-paid month could never match and churned a full cancel-and-reissue on EVERY Bill
  // click — which is what made the credit/re-mint paths reachable from ordinary use rather
  // than requiring an edit.
  const recurringFresh = (await recurringComponents(tx, session.orgId, entry.id, ym))
    .filter((c) => !c.identity || !paidIdentities.has(c.identity));
  const expenseFresh = (await expenseComponents(tx, session, entry, ym))
    .filter((c) => !c.identity || !paidIdentities.has(c.identity));
  const freshWithRecurring = [...fresh, ...recurringFresh, ...expenseFresh];
  const compKey = (unitId: string | null, categoryId: string | null, amount: number) =>
    `${unitId ?? "∅"}|${categoryId ?? "∅"}|${round2(amount).toFixed(2)}`;

  // A CORRECTION TO A PAID LINE IS NOT A RE-BILL.
  //
  // Both sides skip paid components, so a change confined to one made the two multisets
  // identical and returned `already_billed` — indistinguishable from a genuine no-op, with
  // the correction silently discarded. Detected here instead, and routed the way flag-off
  // already routed it: a paid line's amount can only be changed through accounting
  // correction, never by re-billing over money the tenant has already sent.
  if (partialRebillOn && paidBilledAmounts.size > 0) {
    const freshByIdentity = new Map<string, number>();
    for (const f of [...previewItemizedComponents(entry, alloc, ownerBorne, owner?.listingId ?? null, cats, rooms, ym),
                     ...(await recurringComponents(tx, session.orgId, entry.id, ym)),
                     ...(await expenseComponents(tx, session, entry, ym))]) {
      if (f.identity) freshByIdentity.set(f.identity, round2(f.amount));
    }
    const changedPaid = [...paidBilledAmounts.entries()].filter(([identity, billed]) => {
      const now = freshByIdentity.get(identity);
      return now !== undefined && round2(now) !== round2(billed);
    });
    if (changedPaid.length > 0) {
      const { paidBlockers } = assessPaidBlockers({ charges: live, docs: reclaimable.reclaimableDocs, activePaidByChargeId });
      return { apartmentId, outcome: "rebill_blocked_payment_exists" as const, paidBlockers };
    }
  }

  // Compare only the lines this re-Bill would actually replace. A paid line is absent
  // from `fresh` (skipped) and must therefore be absent here as well, or `already_billed`
  // could never fire on a part-paid month.
  const comparableLive = partialRebillOn
    ? live.filter((c) => !protectedPaidIds.has(c.id))
    : live;
  // Every live line is paid AND there is nothing new to bill ⇒ nothing left to amend. A
  // terminal state, not an error.
  //
  // Checked HERE rather than before the preview, which is where it used to sit: an admin
  // who added a late expense to a fully-paid month had the line accepted by
  // createExpensesService (correctly — a line that does not exist yet cannot be paid) and
  // then silently stranded, because paid_locked returned long before any mint. Exactly the
  // dead end the 2026-08-17 spec rejected Approach A over. With the fresh preview in hand,
  // a genuinely-new component means there IS something to bill.
  if (partialRebillOn && unpaid.length === 0 && paid.length > 0 && freshWithRecurring.length === 0) {
    return { apartmentId, outcome: "paid_locked" as const };
  }

  const liveKeys = comparableLive.map((c) => compKey(c.unitId, c.categoryId, c.amount)).sort();
  const freshKeys = freshWithRecurring.map((f) => compKey(f.unitId, f.categoryId, f.amount)).sort();
  if (liveKeys.length === freshKeys.length && liveKeys.every((k, i) => k === freshKeys[i])) {
    return { apartmentId, outcome: "already_billed" as const };
  }

  // 5. CONFIRMATION GATE (rule 3). A real change to reissue, but the admin has not
  // confirmed → return `rebill_confirmation_required` WITH the existing invoice numbers
  // for the modal, mutating NOTHING. Do NOT silently re-Bill.
  if (!confirm) {
    // Name only what will ACTUALLY be superseded — same partition step 9 applies. A
    // settled owner invoice is left exactly as issued, so listing it here would ask the
    // admin to confirm replacing a document this re-Bill never touches.
    const { cancel: willCancel } = docsSafeToCancel({
      docs: reclaimable.reclaimableDocs,
      charges: live,
      protectedChargeIds: protectedPaidIds,
    });
    const tenantDoc = willCancel.find((d) => d.counterpartyType === "tenant");
    const ownerDoc = willCancel.find((d) => d.counterpartyType === "owner");
    // Which lines this re-Bill will LEAVE ALONE, and the tax invoice each already sits on.
    // Resolved from the graduated documents (proformaDocumentId set) rather than assumed,
    // so a paid line with no graduated invoice yet reads `null` instead of a wrong number.
    let keptPaidLines: BillRowResult["keptPaidLines"];
    if (partialRebillOn && paid.length > 0) {
      const gradLines = await tx.billingDocumentLine.findMany({
        where: {
          chargeId: { in: paid.map((c) => c.id) },
          // documentStatus too: without it a CANCELLED graduated invoice could be shown to
          // the admin as the document a kept line sits on.
          document: { organizationId: session.orgId, proformaDocumentId: { not: null }, documentStatus: "ISSUED" },
        },
        select: { chargeId: true, document: { select: { documentNumber: true } } },
      });
      const docByCharge = new Map(gradLines.map((l) => [l.chargeId, l.document.documentNumber]));
      const paidCharges = await tx.charge.findMany({
        where: { id: { in: paid.map((c) => c.id) } },
        select: { id: true, description: true, chargeNumber: true },
      });
      const descById = new Map(paidCharges.map((c) => [c.id, c.description ?? c.chargeNumber]));
      keptPaidLines = paid.map((c) => ({
        description: descById.get(c.id) ?? c.chargeNumber,
        amount: c.amount,
        documentNumber: docByCharge.get(c.id) ?? null,
      }));
    }
    return {
      apartmentId, outcome: "rebill_confirmation_required" as const,
      existingTenantInvoiceNumber: tenantDoc?.documentNumber ?? null,
      existingOwnerInvoiceNumber: ownerDoc?.documentNumber ?? null,
      ...(keptPaidLines ? { keptPaidLines } : {}),
    };
  }

  // 6. RELOCK + bump billRevision. HOISTED ahead of every write: a 0-row update ⇒ a
  // concurrent edit (or a retry after a prior confirmed re-Bill) → `return stale` with
  // NOTHING credited/minted. The revision gives the re-mint a fresh `-r${revision}`
  // chargeNumber + `:r${revision}` idempotencyKey so the new charges/docs never collide
  // with the credited prior generation.
  const relocked = await tx.unitBillsGridEntry.updateMany({
    where: { id: entryId, updatedAt: new Date(expectedUpdatedAt) },
    data: { invoicedAt: new Date(), billedAt: new Date(), lockedBy: session.userId, billRevision: { increment: 1 } },
  });
  if (relocked.count === 0) return { apartmentId, outcome: "stale" as const };
  const revision = entry.billRevision + 1;

  // 7. CREDIT the old live charges BEFORE minting — vacates the partial unique index on
  // (unitId, categoryId, billingMonth, amount) WHERE status NOT IN ('void','credited') so
  // the fresh mint never P2002s against the still-live originals. No payment reversal
  // happens here — step 2 already guaranteed the invoices are fully unpaid.
  //
  // P5 re-Bill fix (money bug): ALSO credit reclaimable.docLessOwnerBorneExpenseChargeIds
  // — stale owner-borne GRIDEXP charges from the prior generation that the doc-gated
  // `liveIds` above can never see (P5 deliberately never gives them a document; see
  // findGridInvoiceState). Left un-credited, a stale charge stays `status:"posted"`
  // forever while step 8 mints a fresh one under the SAME sourceGridExpenseId (the
  // expense-dedup-exempt migration lets the two coexist without a P2002), and owner-
  // ledger.sync.ts's Source 6 — which has no revision/supersede awareness of its own,
  // only a `status NOT IN (void,credited)` filter — books BOTH as separate deductions.
  // Crediting the stale charge here lets Source 6's own reverse-pass void its deduction
  // on the next sync, symmetric with every other superseded grid charge. Structural
  // flag-off no-op: docLessOwnerBorneExpenseChargeIds is always [] when ENABLE_OWNER_
  // BORNE_DEDUCT was off at mint+group time (the charge co-grouped onto a real IVOWN
  // immediately, so `liveIds` already covers it — see findGridInvoiceState).
  // MONEY: `unpaid`, never `liveIds`, once partial re-bill is on. Crediting a paid charge
  // would zero a receivable that a live PaymentAllocation still points at — the money would
  // be received and the record of it owed erased.
  const creditIds = [
    ...(partialRebillOn ? unpaid.map((c) => c.id) : liveIds),
    ...reclaimable.docLessOwnerBorneExpenseChargeIds,
    // The doc-less list is unioned UNCONDITIONALLY above, so it must be filtered here or a
    // PAID doc-less expense charge is credited with its live allocation still pointing at
    // it — money received, receivable erased, and the tenant billed for it again. Applied
    // to the whole list rather than just that arm, so no future addition can slip past.
  ].filter((id) => !protectedPaidIds.has(id));
  await tx.charge.updateMany({
    where: { id: { in: creditIds } },
    data: { status: "credited", outstandingAmount: "0.00" },
  });

  // 8. RE-MINT + RE-GROUP-ISSUE under the bumped revision — the SAME helpers first-issuance
  // uses, so the reissue preserves the itemized rows (rule 5.5/5.11). A Σ-invariant /
  // category / doc-layer throw rolls the whole re-Bill back to `save_failed`.
  const { tenantChargeIds, ownerChargeIds } = await mintItemizedCharges(tx, session, entry, alloc, ownerBorne, ym, revision, rooms, paidIdentities, paidBilledAmounts);
  const expenseCharges = await mintExpenseChargesTx(tx, session, entry, ym, revision, paidIdentities);
  const freshChargeIds = [...tenantChargeIds, ...ownerChargeIds, ...expenseCharges.tenantChargeIds, ...expenseCharges.ownerChargeIds];
  const { tenantInvoiceIds, ownerInvoiceIds } = await issueGroupedGridInvoiceTx(tx, freshChargeIds, session.userId, revision);

  // 9. VOID (CANCEL) the old document(s) — the provenance-resolved reclaimable docs (incl.
  // legacy) — preserving them + their lines for audit (CANCELLED, never deleted, rule 5.3),
  // recording the void reason (rule 5.4), and linking `supersededByDocumentId` to the fresh
  // replacement matched by grouping key (counterpartyType, partyId, listingId, billingMonth).
  // KNOWN LATENT GAP (P4, accounting-document redesign, documented not fixed — narrow,
  // non-money, out of P4's scoped surface): this key does NOT include series/docType, so
  // when ENABLE_EXPENSE_BILL routes a tenant-borne expense onto its own EB- document
  // (issue-grouped.ts), a tenant can now hold TWO "tenant" documents (IVTEN + EB) for the
  // SAME (partyId, listingId, billingMonth) — a multiplicity this key predates. `freshByKey`
  // then collapses both fresh docs to ONE Map entry (last-write-wins), so an old IVTEN and
  // an old EB being superseded in the same re-Bill could both resolve `supersededByDocumentId`
  // to the SAME fresh doc (one of the two, arbitrarily) instead of each to its own analog.
  // Verified NOT a money bug: reclaimable.reclaimableDocs (charge-provenance-resolved, keyed
  // by doc id) still finds and CANCELS both old docs correctly regardless; the only consumer
  // of supersededByDocumentId (billing-documents/derive-for-docs.ts's `isReBilled`) reads it
  // as a non-null boolean, never the specific target id. `newTenantInvoiceNumber` below has
  // the analogous cosmetic gap: `.find()` surfaces only ONE of the two new tenant invoice
  // numbers in the re-Bill notification body.
  //
  // The docType half of that deferred fix is now DONE — reBillDocKey (above) folds docType
  // into the key, because an owner can hold both an IVOWN and an OEA for one unit-month.
  // The notification's N-numbers half remains cosmetic and deferred.
  const freshDocIds = [...tenantInvoiceIds, ...ownerInvoiceIds];
  const freshDocs = freshDocIds.length
    ? await tx.billingDocument.findMany({
        where: { id: { in: freshDocIds } },
        select: { id: true, documentNumber: true, counterpartyType: true, partyId: true, listingId: true, billingMonth: true, docType: true },
      })
    : [];
  const freshByKey = new Map(freshDocs.map((d) => [reBillDocKey(d), d.id]));
  const newTenantInvoiceNumber = freshDocs.find((d) => d.counterpartyType === "tenant")?.documentNumber ?? null;
  const newOwnerInvoiceNumber = freshDocs.find((d) => d.counterpartyType === "owner")?.documentNumber ?? null;

  // ⚠️ MONEY — WHICH docs may be cancelled. NOT all of them: a document still carrying a
  // charge this re-Bill deliberately KEPT (settled money — protected from both the credit
  // sweep in step 7 and the re-mint in step 8) has to stay ISSUED, because that charge has
  // nowhere else to live. This is the owner case specifically: a tenant proforma's paid
  // lines have already graduated onto a real IVTEN, so cancelling the PI strands nothing,
  // while an IVOWN is the ONLY document its charges will ever sit on. Cancelling a settled
  // IVOWN is what re-billed RM 1.29 the owner's payable had already absorbed. See
  // docsSafeToCancel + owner-offset-settlement.ts.
  //
  // `live` carries each charge's OWN documentId (findGridInvoiceState resolved it), so the
  // keep decision is made per DOCUMENT off exact linkage, never by counterparty.
  const { cancel: docsToCancel, kept: docsKept } = docsSafeToCancel({
    docs: reclaimable.reclaimableDocs,
    charges: live,
    protectedChargeIds: protectedPaidIds,
  });
  // Name only the documents actually being superseded — listing a kept one would tell the
  // admin their settled invoice was replaced when it was left exactly as issued.
  const voidedLabel = docsToCancel.map((d) => d.documentNumber).join(", ");
  const voidReason = `Re-Billed — superseded${voidedLabel ? ` (was ${voidedLabel})` : ""} (revision ${revision})`;
  for (const d of docsToCancel) {
    await tx.billingDocument.update({
      where: { id: d.id },
      data: { documentStatus: "CANCELLED", reason: voidReason, supersededByDocumentId: freshByKey.get(reBillDocKey(d)) ?? null },
    });
  }

  // 10. Notify set (rule 5.10) — parties who received a FRESH invoice, de-duped by partyId.
  const notifyParties = new Map<string, "owner" | "tenant">();
  const ownerChargeSet = new Set(ownerChargeIds);
  const freshChargesForNotify = freshChargeIds.length
    ? await tx.charge.findMany({ where: { id: { in: freshChargeIds } }, select: { id: true, partyId: true } })
    : [];
  for (const fc of freshChargesForNotify) {
    if (fc.partyId) notifyParties.set(fc.partyId, ownerChargeSet.has(fc.id) ? "owner" : "tenant");
  }

  await recordAudit(tx, {
    organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
    action: "grid.entry.rebill", entityType: "UnitBillsGridEntry", entityId: entryId,
    meta: { reinvoiced: true, revision, tenantInvoiceIds, ownerInvoiceIds, superseded: docsToCancel.length, keptSettledDocuments: docsKept.map((d) => d.documentNumber), voidReason },
  });

  // Task 7 (rule 5.10): notify the affected parties their prior invoice was replaced (with
  // the NEW invoice number). Emission is DEFERRED to POST-COMMIT (billService →
  // notifyRebillParties) — an in-tx notification.create failure poisons the pg transaction,
  // silently rolling back the reissue. A retry naturally no-ops (stale / already_billed), so
  // no duplicate notification is sent. The primary new tenant invoice number rides on the
  // result for the notification body.
  return {
    apartmentId, outcome: "reinvoiced" as const, entryId, tenantInvoiceIds, ownerInvoiceIds,
    _notifyParties: [...notifyParties].map(([partyId, kind]) => ({ partyId, kind })),
    _newInvoiceNumbers: { tenant: newTenantInvoiceNumber, owner: newOwnerInvoiceNumber },
  };
}

/**
 * POST-COMMIT, BEST-EFFORT notification of a re-Bill's affected parties (spec R5).
 * Called by billService AFTER the money $transaction commits, on the shared client —
 * deliberately NOT inside the tx. An in-tx `notification.create` failure poisons the
 * Postgres transaction, turning the final COMMIT into a silent ROLLBACK that discards
 * the just-issued invoices (confirmed by adversarial probe). Running here, post-commit,
 * every create is its own autocommit statement, so a failure is isolated and can never
 * undo the reissue. Mirrors payments.owner-notify.ts (shared client, post-commit,
 * swallow-and-log). A party with no portal User is skipped (no org-wide spam). Writes
 * ONLY the in-app Notification — never NotificationQueue (that is the email queue).
 */
async function notifyRebillParties(
  orgId: string,
  apartmentId: string,
  parties: NotifyParty[],
  newInvoiceNumbers?: { tenant: string | null; owner: string | null },
): Promise<void> {
  try {
    // Resolve the apartment's unitCode once for the body label (tolerate null).
    const apt = await prisma.apartment.findUnique({ where: { id: apartmentId }, select: { unitCode: true } });
    for (const { partyId, kind } of parties) {
      // One User per Party (User.partyId @unique). No portal user → skip this party.
      const u = await prisma.user.findFirst({ where: { organizationId: orgId, partyId }, select: { id: true } });
      if (!u) continue;
      // Rule 5.10: the body states the prior invoice was replaced and names the NEW number.
      const newNumber = kind === "owner" ? newInvoiceNumbers?.owner : newInvoiceNumbers?.tenant;
      const unitLabel = apt?.unitCode ? ` for unit ${apt.unitCode}` : "";
      await prisma.notification.create({
        data: {
          organizationId: orgId,
          userId: u.id,
          domain: "finance",
          title: "Invoice replaced",
          body: `Your previous invoice${unitLabel} was replaced${newNumber ? ` by a new invoice (${newNumber})` : " by a new invoice"}.`,
          // Owner → the owner financials home (matches payments.owner-notify.ts).
          // Tenant → the tenant portal charges/invoices page (RoleRoute allowed=["tenant"]).
          actionUrl: kind === "owner" ? "/owner/financials" : "/portal/charges",
          read: false,
        },
      });
    }
  } catch (e) {
    // Non-fatal: the money tx is ALREADY committed; a notify failure must never surface.
    console.error("[bills-grid] re-Bill notify failed (non-fatal):", e);
  }
}

/** Structural input for {@link fundedByForUtility} — deliberately narrower than the Prisma payload (PURE mapper), mirroring EntryDtoInput's convention. */
interface FundedByEntryInput {
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
}

/**
 * Task 4 (bills-grid grid funded-by capture): derives the {@link FundedBy} a
 * grid entry implies for ONE utility — the classifier input Task 5's mint
 * passes to {@link classifyUtilityCharge} (classify-utility.ts). PURE, no-I/O.
 *
 * electricity/water read tnbPattern/airPattern: absorbed/recharged => owner
 * (recharged still recovers the money from tenants via the shared pool, but
 * the FUNDING party for classification purposes is the owner side);
 * manager_advanced => manager (KAEN fronted the provider payment, recovers
 * from the tenant pool — recovery_of_advance, never owner-credited);
 * tenant_direct => tenant_direct (tenant pays the provider directly).
 *
 * sewerage is hardcoded owner: Indah Water has no bearer column on the grid
 * entry — a frozen Non-goal, hardcoded owner-borne throughout this module.
 *
 * cleaning/wifi read their own bearer column (owner|tenant): "tenant" bearer
 * means KAEN fronts/manages the service and recovers from the tenant => manager.
 *
 * subsidy is always owner (an owner-funded tenant offset, never billed).
 */
export function fundedByForUtility(entry: FundedByEntryInput, utility: Utility): FundedBy {
  if (utility === "electricity") {
    if (entry.tnbPattern === "manager_advanced") return "manager";
    if (entry.tnbPattern === "tenant_direct") return "tenant_direct";
    if (entry.tnbPattern === "absorbed" || entry.tnbPattern === "recharged") return "owner";
  }
  if (utility === "water") {
    if (entry.airPattern === "manager_advanced") return "manager";
    if (entry.airPattern === "tenant_direct") return "tenant_direct";
    if (entry.airPattern === "absorbed" || entry.airPattern === "recharged") return "owner";
  }
  // Indah Water (sewerage) has NO grid column — hardcoded owner-borne Non-goal
  // throughout this module (bearers.indahWater: "owner", ~:1093).
  if (utility === "sewerage") return "owner";
  if (utility === "cleaning") return entry.cleaningBearer === "tenant" ? "manager" : "owner";
  if (utility === "wifi") return entry.wifiBearer === "tenant" ? "manager" : "owner";
  if (utility === "maintenance") return entry.maintenanceFeeBearer === "tenant" ? "manager" : "owner";
  if (utility === "subsidy") return "owner"; // always an owner-funded offset to the tenant, never billed
  // Mirrors classify-utility.ts's UNKNOWN_UTILITY precedent: never silently
  // misclassify. Reachable in practice ONLY if a pattern/bearer column holds a
  // value outside its zod enum (the write-path gate) — e.g. legacy data, or a
  // future Utility/pattern member this function was not updated for.
  throw new Error(`fundedByForUtility: unrecognized utility/pattern combination for ${utility}`);
}

/** Structural input for {@link mintItemizedCharges} — deliberately narrower than
 * the full Prisma payload (PURE-ish mapper), mirroring {@link FundedByEntryInput}. */
interface MintItemizedChargesEntryInput extends FundedByEntryInput {
  id: string;
  apartmentId: string;
  tnbTotalRaw: Prisma.Decimal | null;
  airSelangorRaw: Prisma.Decimal | null;
  cleaning: Prisma.Decimal | null;
  wifi: Prisma.Decimal | null;
  maintenanceFee: Prisma.Decimal | null;
  // charge-nature-routing Fix 2 — the SCALAR wifi/cleaning charge's per-charge nature
  // ("expense" | "profit" | null), materialized from the WIFI/CLEANING recurring
  // definition. Read only when ENABLE_CHARGE_NATURE_ROUTING is ON (see scalarNatureFor).
  cleaningNature: string | null;
  wifiNature: string | null;
}

/** Utility that can appear on the OWNER side (spec R5): sewerage/subsidy never do
 * (sewerage's pool is hardcoded 0 — a Non-goal; subsidy is tenant-side only, no
 * `subsidy_owner` category exists). A narrower type so `cats[utility].ownerCategoryId`
 * type-checks without a runtime-only guard against `GridInvoiceCategoryMap.subsidy`
 * (which has no `ownerCategoryId` field at all). */

// UTILITY_DESCRIPTION / UTILITY_SUPPLIER are DERIVED from UTILITY_SPEC (utility-spec.ts).

/**
 * Task 5 (agency billing itemization, spec R5). Replaces the single lump
 * "Shared utilities"/"Owner-borne utilities" charge with one `Charge` PER
 * non-zero utility component, each classified via {@link classifyUtilityCharge}
 * (Task 2) using {@link fundedByForUtility} (Task 4) and routed to its
 * per-utility category (Task 3, resolved here via {@link resolveGridInvoiceCategories}).
 *
 * MONEY INVARIANT (spec R5): itemization changes presentation ONLY — for every
 * occupied room, Σ(tenant component amounts) MUST equal `a.computedAmount`
 * exactly; Σ(owner component amounts) MUST equal `ownerBorne` exactly. Both
 * sums are computed PURELY (no charge created yet) and asserted BEFORE any
 * `tx.charge.create` for that side — a mismatch throws
 * `IssuanceError("SUM_INVARIANT")` with NOTHING written for that side (the
 * caller's row `$transaction` then rolls back everything, surfacing as
 * `save_failed` — never a partial itemized mint).
 *
 * `actualCost === chargedAmount` for every component (no markup concept exists
 * at the grid level in this phase — the pooled share IS both the provider's
 * cost and the amount charged) — so `classifyUtilityCharge`'s `markupAmount`
 * is always stamped as exactly 0, sidestepping Task 2's flagged
 * charged-vs-actual undercharge asymmetry entirely (it can only manifest when
 * the two differ).
 *
 * `tenant_direct` utilities (the tenant pays the provider directly) are
 * SKIPPED — no charge minted — BEFORE `classifyUtilityCharge` is ever called,
 * since the classifier THROWS (`PASSTHROUGH_FUNDING`) on a pass-through utility
 * funded tenant_direct. With the `shape.ts` fix (Task 5 contract 2) a
 * tenant_direct utility's pool share is already zero by construction, so this
 * skip is belt-and-suspenders defence-in-depth, not the primary money-safety
 * mechanism — the Σ-invariant above is.
 *
 * `revision` is the re-Bill attempt counter (`entry.billRevision`, Task 8): 0 on
 * first issuance (chargeNumber carries NO `-r0` suffix, preserving the original
 * numbering), N on the Nth re-Bill (suffix `-r${N}`) so the re-mint never
 * collides with the CREDITED prior-attempt charges under the unconditional
 * `@@unique([organizationId, chargeNumber])` on `Charge`.
 *
 * Does its own transaction management NOT AT ALL: every write runs inside the
 * caller's existing row `$transaction` — this function is a plain (non-pure,
 * it does I/O) helper, never opening its own `$transaction`.
 */
export async function mintItemizedCharges(
  tx: Prisma.TransactionClient,
  session: { orgId: string; userId: string; role: string },
  entry: MintItemizedChargesEntryInput,
  alloc: ComputeResult,
  ownerBorne: number,
  ym: string,
  revision: number,
  /** The SAME `RoomInput[]` fed to `computeAllocation` — carries each room's
   *  `airconCharge` (its private submeter money), which the allocation does not.
   *  See {@link aircondComponents}. */
  rooms: readonly RoomInput[],
  /**
   * Component identities (see {@link componentIdentity}) this mint must NOT create,
   * because the tenant has ALREADY PAID them and their charge is still live. Empty by
   * default, so first issuance and every flag-off re-Bill are byte-identical.
   *
   * A skipped component is still counted into the Σ-invariant below — see the assertion.
   */
  skipIdentities: ReadonlySet<string> = new Set(),
  /**
   * For each withheld identity, the amount the LIVE charge actually carries. The
   * Sigma-invariant must reconcile against what the paid document says, not against a
   * freshly recomputed share — otherwise a correction to a paid line silently drops money.
   * Empty ⇒ falls back to the recomputed amount, which is exact whenever nothing changed.
   */
  skippedBilledAmounts: ReadonlyMap<string, number> = new Map(),
): Promise<{ tenantChargeIds: string[]; ownerChargeIds: string[] }> {
  const cats = await resolveGridInvoiceCategories(tx, session.orgId);
  if (!cats) throw new IssuanceError("CATEGORY_UNRESOLVED");

  const monthDate = new Date(`${ym.slice(0, 4)}-${ym.slice(4, 6)}-01T00:00:00.000Z`);
  const suffix = revision > 0 ? `-r${revision}` : "";

  // CUSTOM recurring snapshot lines for this entry (Task 5) — tenant lines mint independently
  // below; owner lines are folded into the owner Σ-invariant and minted on the owner side.
  const recurLines = await loadRecurringLines(tx, session.orgId, entry.id);
  const tenantRecur = recurLines.filter((l) => l.bearer === "tenant");
  const ownerRecur = recurLines.filter((l) => l.bearer === "owner");

  // charge-nature-routing Fix 2 — the SCALAR wifi/cleaning charge carries the per-charge nature
  // resolved by {@link resolveScalarNatures}: the FROZEN entry.wifiNature/cleaningNature column
  // first, then the GOVERNING recurring revision, then the unit-setting default. ONLY
  // wifi/cleaning; electricity/water/sewerage/subsidy are OUT of scope (they never get a nature).
  //
  // charge-nature gate (2026-07-27): this is the SAME call billableNatureUnresolved makes, and
  // that is the point — the guard admits exactly the values the mint is about to stamp, so a
  // scalar can never pass the gate on one source and then book off another (the drift class of
  // bug Fix 3b hardened against, now closed by agreement instead of by refusing to bill).
  // Resolved ONCE here, outside the per-room loop, rather than per component.
  // Flag OFF ⇒ null everywhere ⇒ classifier input unchanged AND the stamped charge.nature is
  // null — byte-identical to pre-feature.
  const natureOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");
  const resolvedScalarNature = natureOn
    ? await resolveScalarNatures(tx, session.orgId, entry.apartmentId, monthDate, entry)
    : { wifi: null, cleaning: null };
  const scalarNatureFor = (utility: Utility): "expense" | "profit" | null => {
    if (!natureOn) return null;
    return utility === "wifi" ? resolvedScalarNature.wifi : utility === "cleaning" ? resolvedScalarNature.cleaning : null;
  };

  /** charge-nature-routing (PASS-THROUGH utilities → Expense Bill): a TENANT-recovered
   * pass-through utility — electricity (TNB) / water (Air Selangor) / sewerage (Indah Water) —
   * is COST RECOVERY, not KAEN service revenue: the tenant reimburses the landlord's provider
   * bill, always AT COST (no markup — the pooled share IS both the provider's cost and the
   * amount charged, so markupAmount is always 0 here). So when ENABLE_CHARGE_NATURE_ROUTING is
   * ON, STAMP nature:"expense" on the tenant GRIDUTIL- charge whenever its classification is a
   * RECOVERY (revenueRecognition recovery_of_advance | owner_funds), routing it onto the
   * tenant's Expense Bill (EB-) OFF IVTEN (issue-grouped.ts). No new entry column — nature is
   * auto-derived from the classification the mint already computes; there is no user selector.
   *
   * Restricted to the three PASS-THROUGH utilities on purpose:
   *   - wifi/cleaning keep their OWN definition nature (scalarNatureFor) — untouched here.
   *   - subsidy also classifies owner_funds but is an owner-funded NEGATIVE tenant offset, NOT
   *     a recovery to move to EB — excluded by the utility check.
   * DEFENSIVE GUARD: a marked-up line (manager_revenue) keeps nature null so the markup stays
   * on IVTEN as genuine KAEN revenue — never hard-route a markup to EB (the grid never marks up
   * a pass-through today, so this branch is unreachable in practice, but must not misbook if it
   * ever arises). Owner-side callers do NOT use this: an owner-borne pass-through (absorbed) is
   * the owner's OWN cost, left exactly as before. Flag OFF ⇒ null ⇒ byte-identical to pre-feature. */
  const passthroughRecoveryNatureFor = (utility: Utility, classified: ClassifyResult): "expense" | null => {
    if (!natureOn) return null;
    if (utility !== "electricity" && utility !== "water" && utility !== "sewerage") return null;
    if (classified.revenueRecognition === "manager_revenue") return null; // markup stays on IVTEN as revenue
    return "expense";
  };

  /** Classify one non-zero, non-tenant_direct component. Returns null for a
   * genuinely zero amount (RM0 guard, mirrors the pre-existing
   * `if (a.computedAmount > 0)` room guard, but per-COMPONENT) or a tenant_direct
   * funding (contract 3 — skipped BEFORE classifying, never reaches the
   * classifier's PASSTHROUGH_FUNDING throw). `nature` (Fix 2) is threaded into the
   * classifier so an Expense-natured wifi/cleaning recovers as recovery_of_advance,
   * not taxable manager_revenue — and is returned so the charge below stamps it. */
  const classify = (utility: Utility, amount: number): { fundedBy: FundedBy; classified: ClassifyResult; nature: "expense" | "profit" | null } | null => {
    if (amount === 0) return null; // RM0 component (subsidy's negative amount is NOT zero, so it survives this check)
    const fundedBy = fundedByForUtility(entry, utility);
    if (fundedBy === "tenant_direct") return null; // tenant pays the provider directly — never billed via the grid
    const magnitude = Math.abs(amount);
    const nature = scalarNatureFor(utility);
    const classified = classifyUtilityCharge({ utility, fundedBy, actualCost: magnitude, chargedAmount: magnitude, nature: nature ?? undefined });
    return { fundedBy, classified, nature };
  };

  // ── Tenant side: one Charge per non-zero component, per occupied room ─────
  const tenantChargeIds: string[] = [];
  for (const a of alloc.allocations) {
    if (!(a.computedAmount > 0)) continue; // RM0 room → no charge at all (unchanged guard)

    // Derived from TENANT_SHARE_OF — see that map for why this is not a literal array.
    const candidates = TENANT_UTILITIES.map((utility) => ({ utility, amount: TENANT_SHARE_OF[utility](a) }));

    let componentSum = 0;
    // Components withheld because they are already paid. Tracked SEPARATELY from
    // componentSum so the invariant below can still account for every cent the allocation
    // engine expects this room to carry.
    let skippedSum = 0;
    const toCreate: Array<{ utility: Utility; amount: number; fundedBy: FundedBy; classified: ClassifyResult; nature: "expense" | "profit" | null }> = [];
    for (const { utility, amount } of candidates) {
      const built = classify(utility, amount);
      if (!built) continue;
      if (skipIdentities.has(`GRIDUTIL-${ym}-${a.unitId}-${utility.toUpperCase()}`)) {
        // The BILLED amount, not the freshly recomputed one.
        //
        // This was `amount` — the recomputed share — which quietly relaxed the guard it
        // was meant to preserve. The withheld component's real money sits on the old
        // charge at the figure it was billed and PAID; if an admin then corrects the
        // meter, `amount` moves while that document does not, and the invariant
        // "accounts for" cents no document carries. Executed: electricity billed and paid
        // at RM300, corrected to RM400, re-Bill succeeded with RM100 on no document.
        //
        // Comparing the BILLED figure makes the assertion mean what it claims again:
        // minted + (what the paid document actually carries) === computedAmount. A
        // correction to a paid line now trips it, which is correct — that money cannot be
        // re-billed without an accounting correction, and failing closed says so.
        skippedSum = round2(skippedSum + (skippedBilledAmounts.get(`GRIDUTIL-${ym}-${a.unitId}-${utility.toUpperCase()}`) ?? amount));
        continue;
      }
      // TENANT side only (pass-through cost recovery → EB): a tenant-recovered pass-through
      // utility is stamped nature:"expense" so issue-grouped routes it onto the Expense Bill;
      // wifi/cleaning/subsidy fall through to their existing nature (built.nature). The owner
      // loop below deliberately does NOT apply this override.
      const nature = passthroughRecoveryNatureFor(utility, built.classified) ?? built.nature;
      toCreate.push({ utility, amount, fundedBy: built.fundedBy, classified: built.classified, nature });
      componentSum = round2(componentSum + amount);
    }
    // Σ-invariant (money guard): asserted BEFORE any charge for this room is
    // created — a mismatch writes NOTHING for this room (or any prior room in
    // this same call — the caller's tx rolls back the whole row).
    //
    // RESTATED, not relaxed, for partial re-Bill: what this room was computed to owe must
    // still be fully accounted for, as components either MINTED now or deliberately
    // WITHHELD as already-paid. A utility genuinely missing from the component map is in
    // neither bucket, so it still throws — which is the drift this guard exists to catch.
    // With an empty skip set (first issuance, flag off) skippedSum is 0 and this reduces to
    // the original expression exactly.
    if (round2(componentSum + skippedSum) !== round2(a.computedAmount)) {
      throw new IssuanceError("SUM_INVARIANT");
    }

    for (const { utility, amount, fundedBy, classified, nature } of toCreate) {
      const code = utility.toUpperCase();
      const c = await tx.charge.create({
        data: {
          organizationId: session.orgId,
          chargeNumber: `GRIDUTIL-${ym}-${a.unitId}-${code}${suffix}`,
          tenancyId: a.tenancyId,
          unitId: a.unitId,
          partyId: a.partyId,
          categoryId: cats[utility].tenantCategoryId,
          chargeType: "utility",
          status: "posted",
          postedAt: new Date(),
          description: `${UTILITY_DESCRIPTION[utility]} ${ym}`,
          dueDate: monthDate,
          amount: amount.toFixed(2),
          currency: "MYR",
          outstandingAmount: amount.toFixed(2),
          billingMonth: monthDate,
          sourceGridEntryId: entry.id,
          attachmentKeys: [],
          fundedBy,
          revenueRecognition: classified.revenueRecognition,
          settlementRecipient: classified.settlementRecipient,
          taxTreatment: classified.taxTreatment,
          markupAmount: classified.markupAmount.toFixed(2),
          sourceSupplier: UTILITY_SUPPLIER[utility] ?? null,
          // Fix 2 — scalar wifi/cleaning carry their nature (null for all other utilities and
          // flag-off); issue-grouped routes an Expense-natured tenant charge onto its own EB.
          nature,
        },
        select: { id: true },
      });
      tenantChargeIds.push(c.id);
    }
  }

  // ── Tenant private submeter electricity: one Charge per occupied room ──────
  // Independent of the per-room utility Σ (see {@link aircondComponents}): this money is the
  // room's OWN metered consumption, not a share of any pool, so it is neither part of
  // `computedAmount` nor subject to the Σ-invariant above.
  //
  // `chargeType: "aircond"` is load-bearing, not cosmetic — owner-ledger Source 4
  // (owner-ledger.sync.ts) discriminates on exactly this value to book the charge as
  // `aircond_income` rather than `utility_income`. Paired with the TNB expense that Source 3
  // already books from the entry, the owner's ledger nets to the real spread (the excess of
  // Σ aircond over the master TNB bill = owner profit).
  //
  // Routed on `cats.electricity` (family `tenant_income`, docType `invoice`) so it lands on
  // the tenant's IVTEN alongside the pooled electricity share. `nature` stays NULL
  // DELIBERATELY even under ENABLE_CHARGE_NATURE_ROUTING: `passthroughRecoveryNatureFor`
  // moves at-cost pass-through RECOVERIES onto the Expense Bill, but submetered aircond is
  // billed at KAEN's own kWh rate with the excess accruing to the owner as profit — it is not
  // an at-cost recovery, so it must not be routed to EB.
  for (const ac of aircondComponents(alloc, rooms)) {
    // Plain skip, no invariant bookkeeping: private submeter electricity mints OUTSIDE the
    // room candidate loop above and never enters componentSum / computedAmount.
    if (skipIdentities.has(`GRIDAC-${ym}-${ac.unitId}`)) continue;
    const c = await tx.charge.create({
      data: {
        organizationId: session.orgId,
        chargeNumber: `GRIDAC-${ym}-${ac.unitId}${suffix}`,
        tenancyId: ac.tenancyId,
        unitId: ac.unitId,
        partyId: ac.partyId,
        categoryId: cats.electricity.tenantCategoryId,
        chargeType: "aircond",
        status: "posted",
        postedAt: new Date(),
        description: `Aircond (private meter) ${ym}`,
        dueDate: monthDate,
        amount: ac.amount.toFixed(2),
        currency: "MYR",
        outstandingAmount: ac.amount.toFixed(2),
        billingMonth: monthDate,
        sourceGridEntryId: entry.id,
        attachmentKeys: [],
      },
      select: { id: true },
    });
    tenantChargeIds.push(c.id);
  }

  // ── Tenant recurring: one Charge per tenant-borne custom snapshot line ─────
  // Independent of the per-room utility Σ (a recurring line is a standalone fee, not part of any
  // room's computedAmount) — minted here with durable provenance (source*Id) + IVTEN routing.
  for (const line of tenantRecur) {
    if (!(num(line.amount) > 0)) continue;
    // Already paid ⇒ the original charge is still live and must not be duplicated.
    // Recurring charges are EXEMT from the duplicate-amount index
    // (20260720130000_recurring_charge_dedup_exempt), so nothing downstream would have
    // caught the double — it simply billed the tenant twice for the same fee.
    if (skipIdentities.has(`GRIDRECUR-${ym}-${line.definitionId}`)) continue;
    const c = await tx.charge.create({ data: recurringChargeData(session.orgId, entry.id, ym, suffix, monthDate, line), select: { id: true } });
    tenantChargeIds.push(c.id);
  }

  // ── Owner side: one Charge per non-zero owner-borne component + custom line ─
  const ownerChargeIds: string[] = [];
  if (ownerBorne > 0 || ownerRecur.length > 0) {
    const owner = await resolveApartmentOwner(tx, session.orgId, entry.apartmentId);
    if (!owner) throw new IssuanceError("OWNER_UNRESOLVED");

    // R1 (closed-period integrity): this side mints OWNER-borne charges dated into
    // monthDate. Reject IN-TX, BEFORE the owner tx.charge.create below, if the owner's
    // statement month is frozen — else the owner-ledger sync-hook's void-only forward-
    // reversal silently drops the impact (the exact bug this feature fixes). No-op when
    // the flag is off or the period is open. Scoped to the owner charge: a tenant-only
    // entry (ownerBorne === 0) never enters this block, so the guard never fires there.
    await assertPeriodOpen(tx, session.orgId, owner.ownerPartyId, monthDate);

    // Re-derived from entry's raw/pattern columns (never entry.ownerBorneTnb/Air —
    // those may not yet be committed/visible on this JS object at mint time).
    // Mirrors EXACTLY the formula billService uses to compute the `ownerBorne`
    // it passes in — the Σ-invariant below is what catches any future drift
    // between the two derivations, rather than silently trusting either one.
    // cleaning/wifi gate on `!== "tenant"` (NOT `=== "owner"`), matching BOTH
    // fundedByForUtility's own convention AND the caller's `ownerBearerExtras`
    // formula exactly (adversarial-audit finding) — a stricter `=== "owner"`
    // gate would silently DROP a legacy/corrupted bearer value from the owner
    // side here while the caller's ownerBorne formula still counted it in,
    // causing a false-positive SUM_INVARIANT on otherwise-legitimate data.
    // Derived from OWNER_AMOUNT_OF — mirrors the tenant side; both are exhaustive by type.
    const ownerCandidates = OWNER_UTILITIES.map((utility) => ({ utility, amount: OWNER_AMOUNT_OF[utility](entry) }));

    let ownerSum = 0;
    // Withheld owner components — see the tenant loop for why these are tracked apart.
    let ownerSkippedSum = 0;
    const toCreate: Array<{ utility: OwnerUtility; amount: number; fundedBy: FundedBy; classified: ClassifyResult; nature: "expense" | "profit" | null }> = [];
    for (const { utility, amount } of ownerCandidates) {
      const built = classify(utility, amount);
      if (!built) continue;
      if (skipIdentities.has(`GRIDOWN-${ym}-${entry.apartmentId}-${utility.toUpperCase()}`)) {
        // Billed amount, not the recomputed one — see the tenant twin above.
        ownerSkippedSum = round2(ownerSkippedSum + (skippedBilledAmounts.get(`GRIDOWN-${ym}-${entry.apartmentId}-${utility.toUpperCase()}`) ?? amount));
        continue;
      }
      toCreate.push({ utility, amount, fundedBy: built.fundedBy, classified: built.classified, nature: built.nature });
      ownerSum = round2(ownerSum + amount);
    }
    // Owner recurring custom lines are part of ownerBorne (folded in at the billService prep) —
    // add them to the Σ so the invariant (Σ owner components === ownerBorne) still holds exactly.
    //
    // A SETTLED owner recurring line is withheld exactly like its tenant twin above and like
    // the GRIDOWN components beside it — into ownerSkippedSum, never ownerSum, so the
    // invariant still balances while the mint below skips it. This arm used to have no skip
    // at all: harmless while owner charges could never read as paid, and a double-bill the
    // moment they could (recurring charges are EXEMPT from the duplicate-amount index, so
    // nothing downstream would have caught it either — see the tenant twin's note).
    for (const line of ownerRecur) {
      if (!(num(line.amount) > 0)) continue;
      const identity = `GRIDRECUR-${ym}-${line.definitionId}`;
      if (skipIdentities.has(identity)) {
        ownerSkippedSum = round2(ownerSkippedSum + (skippedBilledAmounts.get(identity) ?? num(line.amount)));
        continue;
      }
      ownerSum = round2(ownerSum + num(line.amount));
    }
    // Restated exactly as the tenant invariant above: minted + withheld === ownerBorne.
    if (round2(ownerSum + ownerSkippedSum) !== round2(ownerBorne)) {
      throw new IssuanceError("SUM_INVARIANT");
    }

    for (const { utility, amount, fundedBy, classified, nature } of toCreate) {
      const code = utility.toUpperCase();
      const oc = await tx.charge.create({
        data: {
          organizationId: session.orgId,
          chargeNumber: `GRIDOWN-${ym}-${entry.apartmentId}-${code}${suffix}`,
          unitId: owner.listingId,
          partyId: owner.ownerPartyId,
          categoryId: cats[utility].ownerCategoryId,
          chargeType: "utility",
          status: "posted",
          postedAt: new Date(),
          description: `${UTILITY_DESCRIPTION[utility]} ${ym}`,
          dueDate: monthDate,
          amount: amount.toFixed(2),
          currency: "MYR",
          outstandingAmount: amount.toFixed(2),
          billingMonth: monthDate,
          sourceGridEntryId: entry.id,
          attachmentKeys: [],
          fundedBy,
          revenueRecognition: classified.revenueRecognition,
          settlementRecipient: classified.settlementRecipient,
          taxTreatment: classified.taxTreatment,
          markupAmount: classified.markupAmount.toFixed(2),
          sourceSupplier: UTILITY_SUPPLIER[utility] ?? null,
          // Fix 2 — scalar owner wifi/cleaning carry their nature; issue-grouped EXCLUDES an
          // Expense-natured owner charge from IVOWN and owner-ledger Source 6 deducts it.
          nature,
        },
        select: { id: true },
      });
      ownerChargeIds.push(oc.id);
    }

    // Owner recurring: one Charge per owner-borne custom snapshot line, using the FROZEN
    // resolved owner party/listing (not a fresh re-resolution) so the re-Bill regenerates it
    // identically. Already counted in ownerSum above, so the Σ-invariant covers it.
    for (const line of ownerRecur) {
      if (!(num(line.amount) > 0)) continue;
      // Settled ⇒ the original charge is still live on its IVOWN; re-minting duplicates it.
      if (skipIdentities.has(`GRIDRECUR-${ym}-${line.definitionId}`)) continue;
      const oc = await tx.charge.create({ data: recurringChargeData(session.orgId, entry.id, ym, suffix, monthDate, line), select: { id: true } });
      ownerChargeIds.push(oc.id);
    }
  }

  return { tenantChargeIds, ownerChargeIds };
}

/** Malaysia standard SST rate applied to a withSST expense line (bill-expenses R2).
 * Named constant — see spec Open Questions for confirming the source of truth. */
const EXPENSE_STANDARD_SST_RATE = "8";

/** Get-or-seed then resolve the two per-bearer "Other expense" fallback categories.
 * Mirrors resolveGridInvoiceCategories: seed create-only, resolve by code, fail-closed. */
async function resolveExpenseFallbackCategories(
  tx: Prisma.TransactionClient, orgId: string,
): Promise<{ tenantCategoryId: string; ownerCategoryId: string }> {
  await ensureChargeCategorySeeds(orgId);
  const cats = await tx.chargeCategory.findMany({
    where: { organizationId: orgId, code: { in: ["other_expense_tenant", "other_expense_owner"] } },
    select: { id: true, code: true },
  });
  const byCode = new Map(cats.map((c) => [c.code, c.id]));
  const tenantCategoryId = byCode.get("other_expense_tenant");
  const ownerCategoryId = byCode.get("other_expense_owner");
  if (!tenantCategoryId || !ownerCategoryId) throw new IssuanceError("CATEGORY_UNRESOLVED");
  return { tenantCategoryId, ownerCategoryId };
}

/** An active GridExpense row, as loaded for both the mint and the re-Bill no-op preview. */
type ExpenseRow = Prisma.GridExpenseGetPayload<object>;

/**
 * Loads entry's active GridExpense rows PLUS the category-resolution context
 * (fallback ids + picked-category lookup) and returns a `categoryFor` closure —
 * shared by {@link mintExpenseChargesTx} (the real mint) and {@link expenseComponents}
 * (the re-Bill no-op preview, FIX 3) so the two can NEVER drift: both resolve every
 * expense's ChargeCategory id through the SAME function, reading the SAME query.
 *
 * Short-circuits BEFORE resolving any category (no `chargeCategory.findMany` call at
 * all) when there are no active expenses — preserves the pre-refactor no-op contract
 * pinned by mint-expense-charges.test.ts ("void expense skipped"). `categoryFor` is
 * never invoked by either caller in that case (both check `expenses.length === 0`
 * immediately), so the empty-expenses branch returns a stub that is provably dead code.
 */
async function loadExpenseMintContext(
  tx: Prisma.TransactionClient, orgId: string, entryId: string,
): Promise<{ expenses: ExpenseRow[]; categoryFor: (bearer: "tenant" | "owner", pickedId: string | null) => string }> {
  const expenses = await tx.gridExpense.findMany({
    where: { organizationId: orgId, entryId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (expenses.length === 0) {
    return { expenses, categoryFor: () => { throw new Error("unreachable: categoryFor called with no expenses"); } };
  }

  const fallback = await resolveExpenseFallbackCategories(tx, orgId);
  // Pre-fetch picked categories (org-scoped) to decide bearer-consistency in one query.
  const pickedIds = [...new Set(expenses.map((e) => e.chargeCategoryId).filter((id): id is string => !!id))];
  const pickedCats = pickedIds.length
    ? await tx.chargeCategory.findMany({ where: { organizationId: orgId, id: { in: pickedIds } }, select: { id: true, family: true, docType: true } })
    : [];
  const pickedById = new Map(pickedCats.map((c) => [c.id, c]));

  const categoryFor = (bearer: "tenant" | "owner", pickedId: string | null): string => {
    const fallbackId = bearer === "owner" ? fallback.ownerCategoryId : fallback.tenantCategoryId;
    if (!pickedId) return fallbackId;
    const picked = pickedById.get(pickedId);
    if (!picked || picked.docType !== "invoice") return fallbackId;
    const isOwnerFamily = picked.family === "owner_income";
    if (bearer === "owner" && isOwnerFamily) return picked.id;
    if (bearer === "tenant" && !isOwnerFamily) return picked.id;
    return fallbackId; // bearer wins on mismatch (spec R3)
  };

  return { expenses, categoryFor };
}

/** Resolve the tenancy a tenant-bearer GridExpense should bill to, FAIL-CLOSED on the
 * attribution the row itself records — never silently re-attribute to a different tenant.
 *   1. `e.tenancyId` (the explicit snapshot, bill-expenses R3): resolve it, or return null
 *      if it no longer resolves in-org (deleted / cross-org). A SET id that fails is a
 *      hard stop — we do NOT fall through and bill someone else (review #1/#3).
 *   2. HISTORICAL rows (created before tenancyId was persisted) still record the tenant
 *      `partyId`: resolve THAT party's active tenancy in this apartment. If the party is no
 *      longer active (handover), return null — the caller throws EXPENSE_TENANT_UNRESOLVED
 *      so an admin re-attributes it, rather than billing the current occupant.
 *   3. Neither recorded → genuinely unattributed → null.
 * No whole-unit fallback: the recorded party is the source of truth; there is no safe way
 * to guess a tenant for a row that records neither id nor party. ORG-SCOPED. */
async function resolveTenantExpenseTenancy(
  tx: Prisma.TransactionClient,
  orgId: string,
  e: { tenancyId: string | null; partyId: string | null },
  apartmentId: string,
): Promise<{ tenancyId: string; unitId: string; tenantPartyId: string } | null> {
  if (e.tenancyId) {
    const t = await tx.tenancy.findFirst({ where: { id: e.tenancyId, organizationId: orgId }, select: { id: true, unitId: true, tenantPartyId: true } });
    return t ? { tenancyId: t.id, unitId: t.unitId, tenantPartyId: t.tenantPartyId } : null; // SET-but-unresolvable → fail closed, no fall-through
  }
  if (e.partyId) {
    const t = await tx.tenancy.findFirst({
      where: { organizationId: orgId, tenantPartyId: e.partyId, status: "active", unit: { apartmentId } },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
      select: { id: true, unitId: true, tenantPartyId: true },
    });
    return t ? { tenancyId: t.id, unitId: t.unitId, tenantPartyId: t.tenantPartyId } : null; // party moved out → fail closed, never bill the current tenant
  }
  return null;
}

/**
 * SST on an expense, in the SAME cent math `issueDocumentTx`'s `lineSstCents` uses to
 * derive the document line's tax (round(amountCents × rate) / 100). The sibling Charge
 * minted below MUST equal the tax the invoice header shows TO THE CENT — any drift
 * reopens the `Σ charges ≠ document.total` gap this whole mechanism exists to close.
 * Returns 0 for a zero/absent rate, so a non-SST expense still mints exactly one charge,
 * byte-identical to before this fix.
 */
const expenseSstAmount = (amount: number, sstRate: string): number => {
  const rate = Number(sstRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round((Math.round(amount * 100) * rate) / 100) / 100;
};

/** Mint one Charge per active GridExpense on `entry` — plus a sibling SST Charge when the
 * row is SST-bearing (see {@link expenseSstAmount}) — stamped to co-group with that
 * party's utility charges (spec R1-R4). No-op when the flag is off or no active expenses.
 * Fail-closed when a tenant expense has no resolvable tenancy or an owner has no owner. */
export async function mintExpenseChargesTx(
  tx: Prisma.TransactionClient,
  session: { orgId: string; userId: string; role: string },
  entry: { id: string; apartmentId: string },
  ym: string,
  revision: number,
  /** Expense component identities the tenant has already paid — see
   *  {@link componentIdentity}. Empty by default, so nothing changes for a first issuance
   *  or a flag-off re-Bill. Expenses carry no Σ-invariant, so this is a plain skip. */
  skipIdentities: ReadonlySet<string> = new Set(),
): Promise<{ tenantChargeIds: string[]; ownerChargeIds: string[] }> {
  if (!isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES")) return { tenantChargeIds: [], ownerChargeIds: [] };
  const { expenses, categoryFor } = await loadExpenseMintContext(tx, session.orgId, entry.id);
  if (expenses.length === 0) return { tenantChargeIds: [], ownerChargeIds: [] };

  const monthDate = new Date(`${ym.slice(0, 4)}-${ym.slice(4, 6)}-01T00:00:00.000Z`);
  const suffix = revision > 0 ? `-r${revision}` : "";
  // gridexpense-nature: stamp the row's per-row Expense/Profit choice onto the minted
  // Charge (mirrors recurringChargeData's `nature` stamp). Flag OFF ⇒ null on every
  // charge, byte-identical to pre-feature — a null/"expense" row still routes to the
  // Expense Bill / owner deduction; only an explicit "profit" diverts downstream
  // (issue-grouped.ts isExpenseCharge, owner-ledger.sync Source-6).
  const natureOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");

  const tenantChargeIds: string[] = [];
  const ownerChargeIds: string[] = [];
  let owner: { ownerPartyId: string; listingId: string } | null = null;

  for (const e of expenses) {
    const amount = num(e.amount);
    if (!(amount > 0)) continue; // RM0 expense → no charge (mirrors the utility RM0 guard)
    // Already paid: the base charge (and its SST sibling) stay live on the graduated
    // invoice. Skipping the whole line here is why the caller only marks an expense paid
    // when BOTH of its charges are — a half-skip would strand the tax.
    if (skipIdentities.has(`GRIDEXP-${ym}-${e.id}`)) continue;
    const sstRate = e.withSST ? EXPENSE_STANDARD_SST_RATE : "0";
    const base = {
      organizationId: session.orgId,
      chargeNumber: `GRIDEXP-${ym}-${e.id}${suffix}`,
      chargeType: "expense",
      status: "posted",
      postedAt: new Date(),
      description: e.description,
      dueDate: monthDate,
      amount: amount.toFixed(2),
      currency: "MYR",
      outstandingAmount: amount.toFixed(2),
      billingMonth: monthDate,
      sourceGridEntryId: entry.id,
      sourceGridExpenseId: e.id,
      sstRate,
      attachmentKeys: [],
      nature: natureOn ? (e.nature ?? null) : null,
    };
    // Resolve the counterparty ONCE. The SST sibling below MUST land on the SAME
    // party/unit/tenancy/category as its base charge — any other target would group it
    // onto a different document (or none at all), leaving the tax exactly as
    // uncollectable as it was before this fix.
    let sink: string[];
    let target: { tenancyId?: string; unitId: string; partyId: string; categoryId: string };
    if (e.bearer === "tenant") {
      const tenancy = await resolveTenantExpenseTenancy(tx, session.orgId, e, entry.apartmentId);
      if (!tenancy) throw new IssuanceError("EXPENSE_TENANT_UNRESOLVED");
      sink = tenantChargeIds;
      target = { tenancyId: tenancy.tenancyId, unitId: tenancy.unitId, partyId: tenancy.tenantPartyId, categoryId: categoryFor("tenant", e.chargeCategoryId) };
    } else {
      if (!owner) {
        owner = await resolveApartmentOwner(tx, session.orgId, entry.apartmentId);
        if (!owner) throw new IssuanceError("OWNER_UNRESOLVED");
      }
      sink = ownerChargeIds;
      target = { unitId: owner.listingId, partyId: owner.ownerPartyId, categoryId: categoryFor("owner", e.chargeCategoryId) };
    }

    const c = await tx.charge.create({ data: { ...base, ...target }, select: { id: true } });
    sink.push(c.id);

    // SST-PAYABLE (money guard). issueDocumentTx derives this expense's SST from the line
    // rate and adds it to the document total, but nothing ever wrote that money back to a
    // Charge — so the tax was invoiced, declared to LHDN and owed by the payer, yet had NO
    // row a payment could settle: it was absent from the portal's payable list, excluded
    // from balance-due, and invisible to deriveDocumentStatus, which flipped the invoice to
    // "settled" the moment only the BASE amount was paid. Minting the tax as its own Charge
    // on the same target restores Σ charges === document.total. Its own sstRate is "0"
    // (tax is not taxed again) and its document line is flagged `isTax`, so the invoice's
    // subtotal/SST/total are byte-identical to what they were before the sibling existed.
    const sstAmount = expenseSstAmount(amount, sstRate);
    if (sstAmount > 0) {
      const sc = await tx.charge.create({
        data: {
          ...base,
          ...target,
          chargeNumber: expenseSstChargeNumber(ym, e.id, suffix),
          description: `${e.description} — SST ${sstRate}%`,
          amount: sstAmount.toFixed(2),
          outstandingAmount: sstAmount.toFixed(2),
          sstRate: "0",
          parentChargeId: c.id,
        },
        select: { id: true },
      });
      sink.push(sc.id);
    }
  }
  return { tenantChargeIds, ownerChargeIds };
}

/**
 * FIX 3 (final review): PURE-ish preview of the itemized components a fresh
 * {@link mintExpenseChargesTx} call WOULD mint for `entry`'s active GridExpense rows —
 * used by `rebillSupersedeTx`'s component-aware no-op (step 4) so a month carrying an
 * expense charge can be correctly recognised as UNCHANGED (`already_billed`) instead of
 * always churning a reissue (the live expense charge previously had nothing to compare
 * against in the fresh preview, so it never matched).
 *
 * Shares {@link loadExpenseMintContext} (same `categoryFor` closure, same query) and
 * {@link resolveApartmentOwner} with the real mint, so this preview's
 * `(unitId, categoryId, amount)` triple can NEVER drift from what mintExpenseChargesTx
 * actually persists — the two read the identical resolution path, not a re-implementation.
 *
 * Flag-gated: returns `[]` when `ENABLE_BILL_EXPENSES_AS_CHARGES` is off, mirroring
 * mintExpenseChargesTx's own gate (inert flag-off — `freshWithRecurring` is byte-identical
 * to today).
 *
 * An expense whose tenancy/owner is unresolvable is SKIPPED here (not thrown) — the no-op
 * compare simply won't match it, so a real re-Bill proceeds past step 4 to the actual
 * mint, which DOES throw `IssuanceError` exactly as it does today (this preview changes
 * no failure mode, only the no-op DETECTION).
 */
async function expenseComponents(
  tx: Prisma.TransactionClient,
  session: { orgId: string },
  entry: { id: string; apartmentId: string },
  ym?: string,
): Promise<ItemizedComponent[]> {
  if (!isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES")) return [];
  const { expenses, categoryFor } = await loadExpenseMintContext(tx, session.orgId, entry.id);
  if (expenses.length === 0) return [];

  const out: ItemizedComponent[] = [];
  let owner: { ownerPartyId: string; listingId: string } | null = null;
  for (const e of expenses) {
    const amount = num(e.amount);
    if (!(amount > 0)) continue; // RM0 expense → no charge (mirrors the mint's own RM0 guard)
    let unitId: string;
    let categoryId: string;
    if (e.bearer === "tenant") {
      // SAME resolution as mintExpenseChargesTx (resolveTenantExpenseTenancy) so the no-op
      // preview never drifts from what the mint actually bills — a historical null-tenancyId
      // row the mint now resolves via partyId must resolve here too, else an unchanged month
      // is falsely seen as changed and churns a reissue (reversing partial payments, R8).
      const tenancy = await resolveTenantExpenseTenancy(tx, session.orgId, e, entry.apartmentId);
      if (!tenancy) continue; // genuinely unresolvable — mint throws; preview just won't match
      unitId = tenancy.unitId;
      categoryId = categoryFor("tenant", e.chargeCategoryId);
    } else {
      if (!owner) owner = await resolveApartmentOwner(tx, session.orgId, entry.apartmentId);
      if (!owner) continue; // unresolvable — mint will throw; preview just won't match
      unitId = owner.listingId;
      categoryId = categoryFor("owner", e.chargeCategoryId);
    }
    out.push({ unitId, categoryId, amount: round2(amount), identity: ym ? `GRIDEXP-${ym}-${e.id}` : undefined });
    // The SST sibling is a component the mint now produces, so the preview MUST produce it
    // too — same reason as the resolution mirroring above. Omit it and an UNCHANGED
    // SST-bearing month compares short by one component every time, so `already_billed` is
    // never reached and each re-Bill churns a reissue that reverses partial payments (R8).
    const sstAmount = expenseSstAmount(amount, e.withSST ? EXPENSE_STANDARD_SST_RATE : "0");
    if (sstAmount > 0) out.push({ unitId, categoryId, amount: sstAmount, identity: ym ? `GRIDEXP-${ym}-${e.id}-SST` : undefined });
  }
  return out;
}

/**
 * PER-ROW, NOT ATOMIC. Each row bills in its OWN transaction and succeeds or fails
 * independently (R25). A shaping/compute failure is that row's `compute_error`
 * outcome inside a 200 manifest — never a request-level status. There is NO HTTP 422.
 *
 * C5: writes go ONLY to grid tables — EXCEPT the flag-gated Task-4 issuance phase,
 * which mints Charge rows + issues BillingDocuments via issueGroupedGridInvoiceTx
 * (Task 6 — one itemized document per counterparty, built on issueDocumentTx, the
 * SAME immutable core the meter charge path uses). It NEVER writes
 * UnitUtilityBill / OwnerLedgerEntry / UtilityAllocation. Flag OFF ⇒ that phase is
 * skipped entirely — byte-identical legacy behaviour (lock + owner-borne record).
 * C3: ownerBorne* is recorded from the RAW un-shaped inputs, never from ComputeResult.
 */
export async function billService(
  session: { orgId: string; userId: string; role: string },
  body: { period: string; rows: Array<{ apartmentId: string; expectedUpdatedAt: string; confirmRebill?: boolean }> },
): Promise<Result<{ results: BillRowResult[] }>> {
  const periodMonth = new Date(`${body.period.slice(0, 7)}-01T00:00:00.000Z`);
  // Org timezone drives the previous-period re-Bill block (rule 1) — loaded once for all rows.
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  // ADVANCE-BILL WINDOW. Current month and exactly the next org-local month are allowed;
  // anything farther ahead remains preparation-only. Resolved once (periodMonth is one
  // value for the whole request) but
  // reported PER ROW, because billService's contract is a 200 manifest with no request-level
  // abort — an admin sees the same shaped result for every row, not an opaque request error.
  const currentMonth = currentBillingMonthUTC(org.timezone);
  const periodIsFuture = isBeyondAdvanceBillingWindow(periodMonth, currentMonth);
  const results: BillRowResult[] = [];

  for (const row of body.rows) {
    if (periodIsFuture) {
      results.push({ apartmentId: row.apartmentId, outcome: "blocked_future_period" as const });
      continue;
    }
    try {
      const r = await prisma.$transaction(async (tx) => {
        const entry = await tx.unitBillsGridEntry.findUnique({
          where: { organizationId_apartmentId_periodMonth: { organizationId: session.orgId, apartmentId: row.apartmentId, periodMonth } },
        });
        if (!entry) return { apartmentId: row.apartmentId, outcome: "no_entry" as const };
        // Task 6: billedAt is NO LONGER terminal. A billed-but-NEVER-invoiced entry
        // (flag off historically, or nothing to issue) keeps the idempotent short-
        // circuit → `already_billed`. A billed+INVOICED entry (invoicedAt != null)
        // FALLS THROUGH to the flag-gated re-Bill supersede branch below, which
        // supersedes its prior tenant+owner invoices and reissues from the amended
        // amounts (spec R4).
        //
        // IDEMPOTENT NO-OP (review fix #2, IMPLEMENTED in rebillSupersedeTx): a
        // billed+invoiced entry re-Billed with NO effective change returns a pure
        // `already_billed` — no cancel, no reissue. It is computed DETERMINISTICALLY
        // by AMOUNT (compare each live charge's `amount` to its freshly-recomputed
        // amount), NOT by the dead time-based `updatedAt <= invoicedAt` heuristic
        // (`updatedAt` lands a few ms AFTER the `invoicedAt` stamp within the SAME
        // issuance UPDATE — proven — so that guard never fires). The no-op check runs
        // inside rebillSupersedeTx, BEFORE the relock, so a no-op writes nothing.
        if (entry.billedAt && entry.invoicedAt == null) return { apartmentId: row.apartmentId, outcome: "already_billed" as const };

        // `warnings` is READ-PATH only: a ZERO_PAX_TENANCY room changes no money here
        // (ownerBorne* comes from the raw columns, and computeAllocation's result is
        // discarded below), so the Bill path deliberately drops it.
        const { rooms } = await buildGridRooms(tx, session.orgId, entry.id);

        // Downstream note (api-1 adversarial): reject non-finite raw inputs at the
        // SERVICE boundary — the pure adapter does not guard NaN/Infinity. Unreachable
        // from a Decimal(12,2) column in practice, so this is defence-in-depth; a
        // violation is that ROW's failure, never a corrupt Bill.
        const rawTnbTotal = num(entry.tnbTotalRaw);
        const rawAirSelangor = num(entry.airSelangorRaw);
        if (!Number.isFinite(rawTnbTotal) || !Number.isFinite(rawAirSelangor)) {
          return { apartmentId: row.apartmentId, outcome: "save_failed" as const };
        }

        // Shape a FRESH literal. Never buildComputeInputs (C6), never mutate anything.
        const shaped = shapeUtilityPool({
          tnbPattern: entry.tnbPattern as never,
          airPattern: entry.airPattern as never,
          rawTnbTotal,
          rawAirSelangor,
          rooms,
        });
        const pool: PoolComponents = {
          tnbTotal: shaped.tnbTotal,
          airSelangor: shaped.airSelangor,
          indahWater: 0,                 // Indah Water is a Non-goal — hardcoded
          wifi: num(entry.wifi),
          cleaning: num(entry.cleaning),
          maintenance: num(entry.maintenanceFee),
        };
        // PARTITIONED units bill private per-room electricity: the aircond Σ may
        // exceed the master TNB bill (excess = owner profit), so the AIRCON_EXCEEDS_TNB
        // guard is a WHOLE-unit-only data check. Resolved ONCE here and reused by the
        // flag-gated issuance block below (isWholeUnit).
        const aptModes = await tx.apartment.findFirstOrThrow({
          where: { id: entry.apartmentId, organizationId: session.orgId },
          select: { listingMode: true, partitionBillingMode: true, tnbSubsidyCapMonthly: true },
        });
        const privateAircond = aptModes.listingMode !== "WHOLE";
        // The RESULT IS DISCARDED. We call compute only so a genuine ComputeError
        // (AIRCON_EXCEEDS_TNB, WHOLE only) surfaces as this row's `compute_error`. No
        // allocation line and no ComputeResult field is ever persisted.
        computeAllocation("no_subsidy", 0, pool, rooms, {
          indahWater: "owner",           // Non-goal — hardcoded to satisfy the frozen Bearers type
          cleaning: entry.cleaningBearer as never,
          wifi: entry.wifiBearer as never,
          maintenance: entry.maintenanceFeeBearer as never,
        }, privateAircond);

        // Invariant 2, enforced HERE. ownerBorne* is GROSS: the raw provider bill the
        // owner actually paid. With aircond > 0 the owner recovers part of it via
        // separately-billed per-room submeter charges, so their NET burden is
        // `raw − totalAircond` (C3, R16). Storing the net figure here would erase the
        // real bill and reopen C4. Pinned by the `ownerBorneTnb is GROSS` test.
        const ownerBorneTnb = entry.tnbPattern === "absorbed" ? rawTnbTotal : null;
        const ownerBorneAir = entry.airPattern === "absorbed" ? rawAirSelangor : null;
        if (entry.tnbPattern === "absorbed" && !(ownerBorneTnb! > 0)) throw new ServiceError("ABSORBED_REQUIRES_OWNER_BORNE");
        if (entry.airPattern === "absorbed" && !(ownerBorneAir! > 0)) throw new ServiceError("ABSORBED_REQUIRES_OWNER_BORNE");

        // ── Task 4: CHECK-THEN-LOCK issuance prep (flag-gated, PRE-LOCK) ───────
        // CRITICAL ORDERING (review fix #1): the pax gate + computeAllocation run
        // BEFORE the updateMany lock, so a `pax_blocked` or a ComputeError leaves
        // NOTHING written — the row's $transaction commits an empty change (or
        // rolls back on a throw) and the entry stays EDITABLE (billedAt NULL). The
        // OLD order locked first, so a pax-blocked entry was stranded LOCKED with
        // NO invoices and could never be re-Billed (`already_billed` short-circuit).
        // Flag OFF ⇒ this whole block is skipped; the lock below is byte-identical
        // to the legacy path (no pax gate flag-off).
        let issuancePrep: {
          mode: BillingMode; subsidyPerPax: number;
          snapshotOnBill: ResolvedGridTnbSubsidy["snapshotOnBill"];
          alloc: ComputeResult; ownerBorne: number; hasRecurring: boolean;
          // Carried across the lock alongside `alloc` because the room set is where each
          // room's private submeter money lives (`airconCharge`) — the allocation drops it.
          rooms: readonly RoomInput[];
        } | null = null;
        // P5 re-Bill fix RESIDUAL (adversarial re-verification of 3d5e138b): stale
        // doc-less owner-borne GRIDEXP charges from a PRIOR generation of THIS entry,
        // by `sourceGridExpenseId` provenance — see findGridInvoiceState's
        // docLessOwnerBorneExpenseChargeIds doc. Hoisted OUT of the flag-gated block
        // below because the reclaimableCharges>0 branch returns early via
        // rebillSupersedeTx (which already credits this SAME list at its step 7); this
        // outer copy is consumed ONLY by the fallthrough first-issuance path further
        // down (POST-LOCK, after the `if (issuancePrep)` gate), which rebillSupersedeTx
        // never reaches for an expense-ONLY / vacant unit-month (it has NO doc-backed
        // charge, so reclaimableCharges is always [] and that whole function is
        // skipped). Always [] when the flag-gated block below doesn't run (flag off) or
        // finds nothing stale — a structural, not flag-checked, no-op.
        let staleDocLessOwnerBorneChargeIds: string[] = [];
        if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
          const isWholeUnit = aptModes.listingMode === "WHOLE"; // === !privateAircond
          // A historical null snapshot stays on the existing per-pax behaviour;
          // a new/snapshotted apartment cap is resolved once and reused through
          // compute + lock so a concurrent settings edit cannot reprice this Bill.
          const needsLegacySubsidyRate = !isWholeUnit && (
            aptModes.partitionBillingMode === "SUBSIDY"
            || entry.subsidyPolicySnapshot === "legacy_per_pax"
            || (entry.billedAt != null && entry.subsidyPolicySnapshot == null)
          );
          const subsidyPerPax = needsLegacySubsidyRate
            ? Number((await tx.utilityBillingConfig.findFirst({ where: { organizationId: session.orgId }, select: { subsidyPerPax: true } }))?.subsidyPerPax ?? 50)
            : 0;
          const resolvedSubsidy = resolveGridTnbSubsidy({
            isWholeUnit,
            partitionBillingMode: aptModes.partitionBillingMode,
            subsidyPerPax,
            apartmentTnbSubsidyCap: aptModes.tnbSubsidyCapMonthly == null
              ? null
              : Number(aptModes.tnbSubsidyCapMonthly),
            billedAt: entry.billedAt,
            subsidyPolicySnapshot: entry.subsidyPolicySnapshot,
            tnbSubsidyCapSnapshot: entry.tnbSubsidyCapSnapshot == null
              ? null
              : Number(entry.tnbSubsidyCapSnapshot),
          });
          const mode = resolvedSubsidy.mode;

          // Room set (Task 3). Whole units source their single active tenancy so the
          // synthesized 1-pax room classifies as occupied; a vacant whole unit yields
          // no rooms → no tenant invoice. A zero-pax active PARTITIONED room blocks
          // the row (Task 5 refines the message/double-count). PARTITIONED units read
          // their real rooms and ignore activeTenancy, so only query it when WHOLE.
          const activeTenancy = isWholeUnit ? await resolveWholeUnitTenancy(tx, session.orgId, entry.apartmentId, entry.periodMonth) : null;
          const { rooms: billRooms, blockedTenancyIds } = await buildBillRooms(tx, session.orgId, entry, isWholeUnit, activeTenancy);
          // PRE-LOCK pax gate: returns with the lock NEVER taken (billedAt stays NULL,
          // the entry stays editable for a set-pax → re-Bill, spec R10).
          if (blockedTenancyIds.length > 0) return { apartmentId: row.apartmentId, outcome: "pax_blocked" as const };

          // ── Task 5: PRE-LOCK double-count guard (spec R7) ─────────────────────
          // Fire ONLY when this (org, apartment, period) already has a LIVE
          // SHARED-UTILITY bill from a FOREIGN path — a live (`documentStatus:
          // "ISSUED"`) `invoice`/`debit_note` anchored on a LIVE `chargeType:
          // "utility"` charge that is NOT this entry's own. If so, return
          // `already_invoiced` WITH THE LOCK NEVER TAKEN — exactly like the pax gate
          // above (billedAt stays NULL, nothing written, the entry stays editable).
          // A guard running AFTER the lock would strand the entry locked-but-
          // uninvoiced (the Task-4 bug), so this MUST stay pre-lock.
          //
          // SCOPE — three tightenings vs. the original over-broad guard, each a
          // review-confirmed money bug (the guard was matching ANY live-documented
          // charge for the unit-month → it wrongly blocked nearly every real grid
          // Bill, since almost every occupied unit has a live rent/aircond/deposit
          // doc for the month):
          //   1. `chargeType: "utility"` ONLY. This is THE shared-utility type — the
          //      grid mints it (below) and the meter shared-pool split mints it
          //      (meter/service.ts:660). It deliberately EXCLUDES rent, `aircond`
          //      (a PER-ROOM submeter recovery, meter/service.ts:732 — not the shared
          //      pool), carpark, management_fee, and the deposit charge types, none of
          //      which are a shared-utility bill.
          //   2. LIVE charges only — exclude reversed ones (`status` in
          //      {`credited`,`void`}). A utility charge voided via the credit-note path
          //      is set `status:"credited"` (credit-notes.service.ts:193; legacy/plain
          //      void → `"void"`, :126) while its ORIGINAL doc keeps
          //      `documentStatus:"ISSUED"` (only the settlement `status`→`"offset"` and
          //      only CANCEL_AND_REPLACE flips `documentStatus`). Without this a
          //      reversed (un-billed) unit-month would still anchor the guard and block
          //      its legitimate re-bill.
          //   3. `docType` in {`invoice`,`debit_note`} ONLY — a reversal doc
          //      (`credit_note`/`refund_note`) is never a "live bill". The credit_note
          //      minted by the void path carries the SAME foreign chargeId in its line,
          //      so without this it would itself trip the guard.
          //
          // docType note: the guard spans BOTH `invoice` and `debit_note`, not
          // `invoice` alone. The meter/charge shared-utility path routes
          // `utility → utility_tnb → DEP` to a `docType: "debit_note"` document, so an
          // `invoice`-only filter would miss every real meter-path DEP doc; the grid's
          // own prior Bills issue IVTEN/IVOWN `invoice`s. Both are caught.
          //
          // Key-mapping (spec R7): meter/charge utility charges are keyed by
          // Listing(unitId) + billingMonth, whereas the grid entry is keyed by
          // apartmentId + periodMonth — so resolve the apartment→its listings join to
          // see meter-path charges for the same physical unit-month.
          //
          // Re-Bill exemption: only fire when THIS entry has no live issuance of its
          // own (`entry.invoicedAt == null`). If invoicedAt != null, THIS entry already
          // owns live invoices → skip the guard so Task 6's supersede path handles the
          // re-Bill (never trip `already_invoiced` on the entry's own prior issuance).
          //
          // One-directional caveat (spec Open Question, DEFERRED): the grid checks the
          // meter path, but the meter path has NO reciprocal check — a meter issuance
          // AFTER a grid Bill can still double-issue. Not addressed here.
          // REUSED frozen engine — drives the split (same shaped pool as the read path;
          // indah hardcoded owner — Non-goal). PRE-LOCK: a ComputeError (AIRCON_EXCEEDS_TNB)
          // throws BEFORE the lock, so the catch's `compute_error` leaves billedAt NULL.
          const bearers: Bearers = { indahWater: "owner", cleaning: entry.cleaningBearer as never, wifi: entry.wifiBearer as never, maintenance: entry.maintenanceFeeBearer as never };
          const alloc = computeAllocation(mode, resolvedSubsidy.computePolicy, pool, billRooms, bearers, privateAircond);

          // Owner-borne total (spec §R2): absorbed TNB + AirSelangor + owner-bearer
          // Indah/cleaning/wifi. Indah is hardcoded owner (Non-goal, 0 in the pool).
          const ownerBearerExtras =
            (entry.cleaningBearer === "tenant" ? 0 : num(entry.cleaning)) +
            (entry.wifiBearer === "tenant" ? 0 : num(entry.wifi)) +
            (entry.maintenanceFeeBearer === "tenant" ? 0 : num(entry.maintenanceFee));

          // Recurring custom lines (Task 5): fail closed on any enabled applicable CUSTOM def with
          // no materialized line (unresolvable target at open) — PRE-LOCK, nothing written. Then
          // fold owner-borne recurring totals into ownerBorne so the owner side mints them and the
          // mint Σ-invariant (Σ owner components === ownerBorne) holds; tenant lines mint on their
          // own and drive `hasRecurring` so a tenant-only-recurring row still issues.
          const recurLinesPrep = await loadRecurringLines(tx, session.orgId, entry.id);
          // The fail-closed check is FIRST-ISSUANCE only (entry.invoicedAt == null). On a re-Bill
          // the period's recurring set is exactly its already-materialized lines; a CUSTOM def
          // created AFTER this period was billed must NOT retroactively block the re-Bill (spec:
          // no retroactive change to billed periods) — its charge is simply not part of this period.
          if (entry.invoicedAt == null && (await unresolvedRecurringDefs(tx, session.orgId, entry.apartmentId, periodMonth, recurLinesPrep))) {
            return { apartmentId: row.apartmentId, outcome: "recurring_unresolved" as const };
          }
          // Fix 3 (spec R5): fail CLOSED on a null-nature recurring component under
          // ENABLE_CHARGE_NATURE_ROUTING — a definition saved WHILE the flag was OFF never hit the
          // config route's 422, so minting it here would silently default it to profit. Runs for
          // BOTH first issuance AND re-Bill (a null-nature line re-mints as silent profit too), so
          // NOT gated on entry.invoicedAt. Flag OFF ⇒ inert (byte-identical to pre-feature).
          if (isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING")
            && (await billableNatureUnresolved(tx, session.orgId, entry, periodMonth, recurLinesPrep))) {
            return { apartmentId: row.apartmentId, outcome: "nature_unresolved" as const };
          }
          const ownerRecurTotal = round2(recurLinesPrep.filter((l) => l.bearer === "owner").reduce((s, l) => s + num(l.amount), 0));

          const ownerBorne = round2((ownerBorneTnb ?? 0) + (ownerBorneAir ?? 0) + ownerBearerExtras + ownerRecurTotal);
          issuancePrep = {
            mode,
            subsidyPerPax,
            snapshotOnBill: resolvedSubsidy.snapshotOnBill,
            alloc,
            ownerBorne,
            hasRecurring: recurLinesPrep.length > 0,
            rooms: billRooms,
          };

          // ── UNIFIED EXISTING-INVOICE DETECTION (billing-mechanism rework) ──────
          // Resolve the CURRENT live invoices of this unit-month by BILLING PROVENANCE
          // (rule 6), NOT by entry.invoicedAt/sourceGridEntryId — so a legacy invoice
          // whose charge was orphaned (sourceGridEntryId nulled when its grid entry was
          // deleted) is recognised as a RE-BILL candidate, while a live utility invoice
          // from a NON-grid path (meter/manual) is a hard conflict. PRE-LOCK: every branch
          // returns BEFORE the updateMany lock, so a blocked/confirmation/conflict return
          // writes nothing and leaves the entry editable (the Task-4 stranding invariant).
          const listingIds = (
            await tx.listing.findMany({
              where: { organizationId: session.orgId, apartmentId: entry.apartmentId },
              select: { id: true },
            })
          ).map((l) => l.id);
          const ym = `${periodMonth.getUTCFullYear()}${String(periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;
          const gridInvoiceState = await findGridInvoiceState(tx, session.orgId, entry.id, listingIds, periodMonth, ym);
          // Captured for the fallthrough path below (see the hoisted `let` above) —
          // harmless to set even when the reclaimableCharges>0 branch is about to
          // return early, since that branch's OWN rebillSupersedeTx call reads the
          // SAME list off `gridInvoiceState` directly and this outer copy simply goes
          // unused in that call frame (never double-credited — the two branches are
          // mutually exclusive by the early `return` below).
          staleDocLessOwnerBorneChargeIds = gridInvoiceState.docLessOwnerBorneExpenseChargeIds;

          // A live utility invoice for this unit-month from a NON-grid path (meter/manual)
          // or otherwise ambiguous → fail closed (rule 6 tail).
          if (gridInvoiceState.hasConflict) {
            return { apartmentId: row.apartmentId, outcome: "conflicting_invoice" as const };
          }
          // Existing grid invoices (this entry's OR a legacy orphaned one) → the RE-BILL
          // flow: previous-period / any-payment / occupancy / no-op / confirmation gates +
          // atomic void-and-reissue, all inside rebillSupersedeTx.
          if (gridInvoiceState.reclaimableCharges.length > 0) {
            return await rebillSupersedeTx(
              tx, session, row.apartmentId, entry, row.expectedUpdatedAt, alloc, ownerBorne, ym,
              periodMonth, org.timezone, gridInvoiceState, row.confirmRebill === true, billRooms,
            );
          }
          // else: NO existing invoice → fall through to FIRST ISSUANCE below (`invoiced`).
        }

        // updatedAt-in-WHERE: a 0-row update means someone else moved first.
        // This is THE LOCK. In the flag-ON path it runs ONLY after the pax gate +
        // computeAllocation above passed, so a blocked/failed row never reaches it.
        //
        // P5 re-Bill fix RESIDUAL: when staleDocLessOwnerBorneChargeIds is non-empty
        // (a stale doc-less owner-borne GRIDEXP charge from a PRIOR generation of this
        // SAME entry is about to be retired below — see the credit step right after
        // this lock), ALSO bump billRevision here, in the SAME lock update
        // rebillSupersedeTx's own step 6 uses for exactly this reason: the fresh mint
        // further down needs a `-r${revision}` chargeNumber suffix so it never
        // collides with the just-credited original under the unconditional
        // @@unique([organizationId, chargeNumber]) on Charge (mintItemizedCharges'
        // own doc explains this). Never bumped on a genuine first issuance (nothing
        // stale ⇒ the spread below contributes nothing) — billRevision must stay 0
        // then, or every first Bill would misreport as "Re-Billed" on the grid read
        // (FE: row.billRevision > 0).
        const updated = await tx.unitBillsGridEntry.updateMany({
          where: { id: entry.id, updatedAt: new Date(row.expectedUpdatedAt) },
          data: {
            billedAt: new Date(),
            lockedBy: session.userId,
            ownerBorneTnb: ownerBorneTnb?.toFixed(2) ?? null,
            ownerBorneAir: ownerBorneAir?.toFixed(2) ?? null,
            ...(issuancePrep?.snapshotOnBill
              ? {
                  subsidyPolicySnapshot: issuancePrep.snapshotOnBill.policy,
                  tnbSubsidyCapSnapshot: issuancePrep.snapshotOnBill.cap?.toFixed(2) ?? null,
                }
              : {}),
            // paymentStatus is DELIBERATELY untouched — billing is not payment (R10).
            ...(staleDocLessOwnerBorneChargeIds.length > 0 ? { billRevision: { increment: 1 } } : {}),
          },
        });
        if (updated.count === 0) return { apartmentId: row.apartmentId, outcome: "stale" as const };

        // P5 re-Bill fix RESIDUAL (money bug, adversarial re-verification of
        // 3d5e138b): retire stale doc-less owner-borne GRIDEXP charges that the
        // reclaimableCharges-gated rebillSupersedeTx branch above can NEVER reach for
        // an expense-ONLY / vacant unit-month — such a unit-month has NO doc-backed
        // charge at all (P5 deliberately never gives an owner-borne GRIDEXP charge a
        // document, see issue-grouped.ts), so `reclaimableCharges` is always [] and
        // rebillSupersedeTx (whose step 7 credits this SAME list) is skipped
        // entirely, even when a stale rev-N charge from an earlier Bill of this exact
        // entry is sitting there `status:"posted"`. Left un-retired, the fresh mint
        // below would either strand a SECOND live sourceGridExpenseId charge
        // alongside it (a swapped GridExpense mints under a NEW chargeNumber that
        // dodges @@unique(org, chargeNumber) — owner-ledger.sync.ts's Source 6 then
        // double-books both as separate deductions) or P2002 outright (the SAME
        // GridExpense re-mints under the IDENTICAL chargeNumber pre-fix, since
        // billRevision never bumped on this path before this fix).
        //
        // Reuses the EXACT SAME collection (findGridInvoiceState's
        // docLessOwnerBorneExpenseChargeIds) and the EXACT SAME credit shape
        // (status→"credited", outstandingAmount→"0.00") rebillSupersedeTx's step 7
        // already uses for the reclaimableCharges>0 case — never duplicated
        // divergently. The two paths are mutually exclusive (the early `return` in
        // the reclaimableCharges>0 branch above), so a charge credited here can never
        // ALSO be credited by rebillSupersedeTx, and vice versa — no double-credit.
        //
        // Structural, not flag-checked, no-op: staleDocLessOwnerBorneChargeIds is
        // always [] for anything minted today (every owner-borne charge co-groups onto a
        // real IVOWN immediately, so it is never doc-less — see findGridInvoiceState's
        // doc) or on a genuine first issuance (nothing PRIOR to retire) — `mintRevision`
        // then equals `entry.billRevision` unchanged. Only a database that once ran with
        // ENABLE_OWNER_BORNE_DEDUCT ON can still put anything in this list.
        const mintRevision = staleDocLessOwnerBorneChargeIds.length > 0 ? entry.billRevision + 1 : entry.billRevision;
        if (staleDocLessOwnerBorneChargeIds.length > 0) {
          await tx.charge.updateMany({
            where: { id: { in: staleDocLessOwnerBorneChargeIds } },
            data: { status: "credited", outstandingAmount: "0.00" },
          });
        }

        // ── Task 4: flag-gated issuance MINT (POST-LOCK) ──────────────────────
        // Uses the PRE-LOCK-computed alloc/ownerBorne (issuancePrep). All of it runs
        // inside THIS row's $transaction — a failure rolls the row back (lock +
        // charges + docs + invoicedAt stamp) and the catch turns it into this row's
        // `save_failed`, never a half-issued state. Flag OFF ⇒ issuancePrep is null
        // and the row falls through to the EXISTING `billed` return below.
        if (issuancePrep) {
          const { alloc, ownerBorne, hasRecurring, rooms: billRooms } = issuancePrep;
          // FIX 2 (final review): a vacant/no-utility apartment with ONLY an active
          // owner-borne (or tenant-borne) GridExpense has zero allocations, zero
          // ownerBorne, and no recurring line — the gate below was previously false,
          // so mintExpenseChargesTx never ran and the expense was silently,
          // permanently un-billable. Flag-gated (inert, always false) when
          // ENABLE_BILL_EXPENSES_AS_CHARGES is off — byte-identical to today.
          const hasBillableExpenses = isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES")
            && (await tx.gridExpense.count({ where: { organizationId: session.orgId, entryId: entry.id, status: "active" } })) > 0;
          // Nothing to issue (zero occupied rooms AND zero owner-borne AND no recurring line
          // AND no billable expense) → fall through to the existing `billed` return (no empty
          // invoice). A tenant-only recurring row (no utility allocation, no owner-borne)
          // still issues via hasRecurring; an expense-only row still issues via hasBillableExpenses.
          if (alloc.allocations.length > 0 || ownerBorne > 0 || hasRecurring || hasBillableExpenses) {
            const ym = `${periodMonth.getUTCFullYear()}${String(periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;

            // Task 5 (itemized minting, spec R5): one Charge per non-zero utility
            // component (replaces the single lump "Shared utilities"/"Owner-borne
            // utilities" charge). revision = mintRevision — entry.billRevision (0) on
            // a genuine first issuance; the RESIDUAL-fix-bumped value (entry.
            // billRevision + 1) when the retire step above just credited a stale
            // doc-less owner-borne charge for this entry (see the comment on the lock
            // update above). Resolves its OWN categories (CATEGORY_UNRESOLVED) and
            // owner (OWNER_UNRESOLVED); asserts the Σ-invariant per room/owner before
            // writing anything for that side (SUM_INVARIANT on mismatch — money guard).
            const { tenantChargeIds, ownerChargeIds } = await mintItemizedCharges(tx, session, entry, alloc, ownerBorne, ym, mintRevision, billRooms);
            const expenseCharges = await mintExpenseChargesTx(tx, session, entry, ym, mintRevision);

            // If every tenant room was fully subsidised (RM0) AND there is no owner
            // component, nothing was minted → fall through to `billed` (no empty issue).
            const mintIds = [...tenantChargeIds, ...ownerChargeIds, ...expenseCharges.tenantChargeIds, ...expenseCharges.ownerChargeIds];
            if (mintIds.length > 0) {
              // Task 6 (grid-scoped grouped invoice issuance): group the minted
              // charges by (partyId, unitId, billingMonth, docType) and issue ONE
              // itemized BillingDocument per counterparty — never one document per
              // charge. A category/series mis-config throws here → this row's
              // `save_failed`. revision = mintRevision, matching the mint calls above
              // (0 on a genuine first-issuance path; the RESIDUAL-fix-bumped value on
              // a retired-stale-charge fallthrough) — the `:r${revision}`
              // idempotencyKey suffix on a re-Bill keeps it from being swallowed by a
              // cancelled prior-attempt doc.
              const { tenantInvoiceIds, ownerInvoiceIds } = await issueGroupedGridInvoiceTx(
                tx, mintIds, session.userId, mintRevision,
              );

              await tx.unitBillsGridEntry.update({ where: { id: entry.id }, data: { invoicedAt: new Date() } });

              await recordAudit(tx, {
                organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
                action: "grid.entry.bill", entityType: "UnitBillsGridEntry", entityId: entry.id,
                meta: { ownerBorneTnb, ownerBorneAir, tnbPattern: entry.tnbPattern, airPattern: entry.airPattern, invoiced: true, tenantInvoiceIds, ownerInvoiceIds },
              });
              return { apartmentId: row.apartmentId, outcome: "invoiced" as const, entryId: entry.id, tenantInvoiceIds, ownerInvoiceIds };
            }
            // else: everything was RM0-subsidised with no owner component → fall through.
          }
          // else: nothing to issue → fall through to the `billed` return below.
        }

        await recordAudit(tx, {
          organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
          action: "grid.entry.bill", entityType: "UnitBillsGridEntry", entityId: entry.id,
          meta: { ownerBorneTnb, ownerBorneAir, tnbPattern: entry.tnbPattern, airPattern: entry.airPattern },
        });

        const recorded = (ownerBorneTnb ?? 0) + (ownerBorneAir ?? 0);
        return { apartmentId: row.apartmentId, outcome: "billed" as const, entryId: entry.id, ownerBorneRecorded: recorded.toFixed(2) };
      });
      // POST-COMMIT best-effort notify (spec R5). The money tx has COMMITTED here, so a
      // notification failure is its own isolated statement on the shared client and can
      // NEVER roll back the reissue (contrast: an in-tx notification.create failure
      // poisons the pg tx → silent rollback of the invoices). Gated on `reinvoiced`;
      // `_notifyParties` is stripped so it never reaches the FE manifest.
      const { _notifyParties, _newInvoiceNumbers, ...rowResult } = r as RebillResult;
      if (rowResult.outcome === "reinvoiced" && _notifyParties?.length) {
        await notifyRebillParties(session.orgId, rowResult.apartmentId, _notifyParties, _newInvoiceNumbers);
      }
      // POST-COMMIT owner-ledger sync. Billing used to leave the Owner Ledger empty: every
      // syncOwnerLedgerFor* trigger was a PAYMENT, an adjustment or a statement generation, so
      // an admin who billed tenant + owner saw "No owners found" and no statement could be
      // produced from it. The ledger is what the owner statement reads, so this is the seam that
      // makes billing visible to the owner side at all.
      //
      // Runs AFTER the row's money tx has committed — never inside it — for the same reason the
      // notify above does: the sync opens its own transaction, and an in-tx failure here would
      // poison the pg transaction and silently roll back the invoices. It is best-effort by
      // design (the hook swallows and records its own failures), so a sync problem can never
      // undo a successful Bill. Mirrors meter/service.ts's post-commit call exactly.
      if (rowResult.outcome === "billed" || rowResult.outcome === "invoiced" || rowResult.outcome === "reinvoiced") {
        await syncOwnerLedgerForApartmentMonth(session.orgId, session.userId, session.role, rowResult.apartmentId, periodMonth);
        // AUTO-OFFSET the owner receivable this Bill just issued, when the unit's rent is
        // ALREADY collected. The sibling trigger fires when money ARRIVES and can only
        // settle lines that exist at that instant — so an owner cost added afterwards (an
        // amended month, a re-Bill adding an expense) issued an IVOWN that sat "Unpaid"
        // against a payable that already covered it. Same rails, same guards, same
        // service; only the trigger is new, and `OFFSET_EXCEEDS_PAYABLE` still caps it at
        // money KAEN genuinely owes this owner.
        //
        // AFTER the ledger sync, matching the ordering rule its sibling documents: the
        // sync is what books the expenses the payable is computed from. Post-commit and
        // best-effort (it swallows into an audit row), so it can never undo a Bill.
        await autoOffsetOwnerReceivablesForBilledApartment(session.orgId, session.userId, session.role, rowResult.apartmentId);
      }

      // Rental drafts are displayed in this matrix as orange `Saved · not billed`
      // cells, but historically the matrix Bill action ignored them and required a
      // second trip to Draft Approvals. Approve the selected apartment's rent drafts
      // through the existing approval service (same audit, posting, document and owner-
      // ledger rails) after the grid transaction succeeds. `no_entry` is deliberately
      // eligible: a unit whose ONLY pending money is prorated rent should still be
      // billable from this page and must not need a synthetic empty grid entry.
      if (["billed", "invoiced", "reinvoiced", "already_billed", "no_entry"].includes(rowResult.outcome)) {
        const tenantDrafts = await prisma.invoice.findMany({
          where: {
            organizationId: session.orgId,
            // Rent and move-in deposits are both visible as orange Saved cells in
            // this matrix. A selected Bill action must issue both rails together;
            // otherwise the screen promises one workflow but silently leaves the
            // deposit behind in Draft Approvals.
            invoiceType: { in: ["tenant_rental", "tenant_deposit", "tenant_agreement_fee", "tenant_renewal"] },
            status: "draft",
            periodMonth,
            tenancy: { unit: { apartmentId: row.apartmentId } },
          },
          select: { id: true },
        });
        if (tenantDrafts.length > 0) {
          const approved = await approveBulkService(
            {
              orgId: session.orgId,
              actorUserId: session.userId,
              actorRole: session.role as Parameters<typeof approveBulkService>[0]["actorRole"],
            },
            tenantDrafts.map((invoice) => invoice.id),
          );
          if (approved.ok && approved.data.approved.length > 0) {
            const tenantInvoiceIds = [...new Set([...(rowResult.tenantInvoiceIds ?? []), ...approved.data.approved])];
            results.push({
              ...rowResult,
              // `no_entry`/`already_billed` described only the grid rail. The
              // selected unit DID issue rental money, so report a real success.
              outcome: rowResult.outcome === "no_entry" || rowResult.outcome === "already_billed" ? "invoiced" : rowResult.outcome,
              tenantInvoiceIds,
            });
            continue;
          }
        }
      }
      results.push(rowResult);
    } catch (e) {
      // A shaping/compute failure is that ROW's outcome, never a request-level
      // status. There is no HTTP 422 anywhere in this design.
      if (e instanceof ComputeError || e instanceof ShapeError) {
        results.push({
          apartmentId: row.apartmentId, outcome: "compute_error",
          code: e.code as BillRowResult["code"],
          detail: e instanceof ShapeError ? e.detail : undefined,
        });
      } else if (e instanceof ServiceError) {
        // Invariant 2 violation. `save_failed` per the spec, but the stable code survives.
        results.push({ apartmentId: row.apartmentId, outcome: "save_failed", code: e.code });
      } else if (e instanceof IssuanceError) {
        // Task-4 issuance failure with a STABLE code (OWNER_UNRESOLVED / CATEGORY_UNRESOLVED):
        // forward it on the manifest so the admin sees WHY (e.g. "no owner assigned") instead
        // of a bare "needs attention". Same shape as the ServiceError branch. The whole row's
        // tx already rolled back — nothing half-issued.
        results.push({ apartmentId: row.apartmentId, outcome: "save_failed", code: e.code });
      } else {
        // Any OTHER issuance failure: a doc-layer throw from issueGroupedGridInvoiceTx
        // (Task 6 — GroupedIssuanceCategoryUnresolvedError, or a DocumentReferenceRequiredError
        // / series mis-config bubbling up from the underlying issueDocumentTx call) rolled
        // the whole row's tx back — nothing half-issued — and surfaces here as this row's
        // `save_failed` (no stable code to forward).
        //
        // LOG IT. This branch is the ONLY one that discards its error, and the admin-facing
        // copy for it is the generic "couldn't issue the invoice — try again or contact
        // support". Silently swallowing meant a real defect (2026-07-28: `maintenance` had no
        // classifier bucket, so ClassificationError killed every Bill carrying a maintenance
        // fee) was diagnosable only by attaching a debugger to a reproduction. One line here
        // turns the next occurrence into a log grep. Server-side only — the manifest shape is
        // unchanged, so nothing new reaches the client.
        console.error("[bills-grid] unclassified Bill failure — row rolled back, reported as save_failed", {
          apartmentId: row.apartmentId,
          period: body.period,
          name: (e as Error)?.name,
          message: (e as Error)?.message,
          stack: (e as Error)?.stack,
        });
        results.push({ apartmentId: row.apartmentId, outcome: "save_failed" });
      }
    }
  }
  return ok({ results });
}

/**
 * Save ≠ Bill, and there is NO auto-save. This is a pure draft persist of raw
 * amounts. It does NOT call shapeUtilityPool or computeAllocation, so it can never
 * raise TNB_UNDERSHOOT or AIRCON_EXCEEDS_TNB. `saveEntrySchema` is amounts-only: no
 * pattern/bearer (snapshotted on create, changed only via PATCH …/entries/:id/lines)
 * and no ownerBorne* (derived at Bill from the RAW inputs, C3).
 */
export async function saveEntryService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  body: { period: string; expectedUpdatedAt?: string; [k: string]: unknown },
): Promise<Result<{ id: string; updatedAt: string }>> {
  const periodMonth = toMonth(body.period);
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");

  try {
    return await prisma.$transaction(async (tx) => {
      const entry = await getOrCreateEntry(tx, { orgId: session.orgId, apartmentId, periodMonth, actorUserId: session.userId });
      // Client/server parity: a billed entry is LOCKED for Save only once FULLY PAID.
      // Billed-but-unpaid stays amendable so an admin can correct figures before re-Bill
      // (the money op — re-Bill — keeps its own payment guard, `rebill_blocked_payment_exists`).
      // Mirrors the client's bills-grid-page.tsx `billedApartmentIds`
      // (billedAt != null && paymentStatus === "paid").
      if (entry.billedAt && entry.paymentStatus === "paid") return err(409, "ENTRY_LOCKED");

      // …but that check reads the MANUAL admin column, which is deliberately never advanced by
      // a Bill or by a payment (R10, "billing is not payment"). So it does NOT stop a write over
      // money that really has settled — and `tnbTotal` is the one scalar here that re-prices
      // ANOTHER party's paid charge (see electricityHasActivePayment). Until the per-cell render
      // lock shipped, the greyed-out row was the only thing preventing this; a direct API call
      // was always accepted. Guarded per-FIELD so every other scalar on a part-paid month stays
      // amendable, and only on a real CHANGE so an unchanged echo of the current value (a
      // full-row save that happens to include it) is never refused.
      if (body.tnbTotal !== undefined
        && Number(String(body.tnbTotal)) !== num(entry.tnbTotalRaw)
        && await electricityHasActivePayment(tx, session.orgId, entry.id)) {
        return err(409, "ENTRY_LOCKED");
      }

      // R6 (refined): cleaning/wifi are write-protected ONLY when an ENABLED recurring definition
      // GOVERNS that scalar for this month (then they're settings-controlled — a direct save is
      // REJECTED so the admin learns the amount is managed in Unit Settings, never silently
      // overwriting the configured recurring amount). When NO enabled def governs a scalar (no
      // def, a disabled def like the WiFi backfill default, or a month before the earliest
      // revision), the cell stays a plain editable per-month value — the admin types it directly,
      // exactly like the legacy grid. Flag-OFF preserves the legacy write for both.
      const flagOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
      const governed = flagOn ? await governingScalarKinds(tx, session.orgId, apartmentId, periodMonth) : noScalarGovernance();
      // One rule for every scalar kind: a governed amount is settings-controlled and a direct
      // write is REJECTED. Driven off SCALAR_RECURRING_KINDS so a new kind is protected the
      // moment it is added to that map — no extra condition to remember here.
      const lockedWrite = SCALAR_RECURRING_KIND_LIST.find(
        (kind) => governed[kind] && body[SCALAR_RECURRING_KINDS[kind].saveBodyField] !== undefined,
      );
      if (lockedWrite) {
        return err(409, "recurring_charge_locked");
      }

      // `rental` is deliberately ABSENT from `data` (Task 4): dropped from
      // saveEntrySchema, server-derived per tenancy on the read path. A wire
      // `rental` (e.g. a stale/bypassing caller) is silently ignored — never
      // written. The old sibling-COUNT Invariant-9 check that lived here is
      // gone with it; Invariant 9 now lives in saveReadingsService, keyed on
      // Apartment.listingMode (see its own doc comment).
      const data = {
        readingDate: body.readingDate ? new Date(String(body.readingDate)) : undefined,
        // Every scalar amount is written UNLESS an enabled recurring def governs it (then it is
        // settings-controlled and was already rejected above). An ungoverned scalar is a normal
        // editable per-month value on both flag-on and flag-off paths. Built from
        // SCALAR_RECURRING_KINDS so the governed-skip and the write can never disagree about
        // which column a kind owns. tnbTotalRaw/airSelangorRaw stay RAW, never a shaped value (C5).
        ...Object.fromEntries(
          SCALAR_RECURRING_KIND_LIST.filter((kind) => !governed[kind]).map((kind) => {
            const { entryAmountField, saveBodyField } = SCALAR_RECURRING_KINDS[kind];
            return [entryAmountField, body[saveBodyField] as string | undefined];
          }),
        ),
        maintenanceFee: body.maintenanceFee as string | undefined,
        paymentStatus: body.paymentStatus as string | undefined,
        updatedById: session.userId, // P5: last admin editor
      };

      // Optimistic concurrency: updatedAt in the WHERE. A 0-row update = someone moved first.
      const where = body.expectedUpdatedAt
        ? { id: entry.id, updatedAt: new Date(body.expectedUpdatedAt) }
        : { id: entry.id, updatedAt: entry.updatedAt };
      const res = await tx.unitBillsGridEntry.updateMany({ where, data });
      if (res.count === 0) return err(409, "STALE");

      const fresh = await tx.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const auditChanges = Object.entries(data)
        .filter(([field, after]) => field !== "updatedById" && after !== undefined)
        .map(([field, after]) => ({
          field,
          before: String((entry as Record<string, unknown>)[field] ?? ""),
          after: after instanceof Date ? after.toISOString() : String(after ?? ""),
        }))
        .filter((change) => change.before !== change.after);
      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.entry.save", entityType: "UnitBillsGridEntry", entityId: entry.id,
        diff: { changes: auditChanges } as never,
      });
      return ok({ id: fresh.id, updatedAt: fresh.updatedAt.toISOString() });
    });
  } catch {
    return err(500, "SAVE_FAILED");
  }
}

/**
 * PATCH …/entries/:id/lines — edit an entry's snapshotted line settings (pattern +
 * bearers). Manager-gated. NEVER shapes a pool. `409 ENTRY_LOCKED` once MONEY HAS ARRIVED
 * for the month (not merely once billed — a billed-but-unpaid month stays amendable and is
 * re-Billed to reissue, which re-derives every total from the new bearer split);
 * `409 STALE` on token mismatch. The entry must already exist (addressed by id).
 */
export async function updateLinesService(
  session: { orgId: string; userId: string; role: string },
  entryId: string,
  body: { tnbPattern: string; airPattern: string; cleaningBearer: string; wifiBearer: string; maintenanceFeeBearer: string; expectedUpdatedAt?: string },
): Promise<Result<{ id: string; updatedAt: string }>> {
  try {
    return await prisma.$transaction(async (tx) => {
      const entry = await tx.unitBillsGridEntry.findFirst({ where: { id: entryId, organizationId: session.orgId } });
      if (!entry) return err(404, "ENTRY_NOT_FOUND");
      // Locked by MONEY, not by Bill. Sits exactly where the old `billedAt` check did —
      // after ENTRY_NOT_FOUND, before the updateMany — so error precedence is UNCHANGED:
      // ENTRY_LOCKED still wins over STALE when both would apply, as it always has.
      // DELIBERATELY still entry-wide, unlike the three expense guards. A bearer or
      // pattern change re-routes money for the WHOLE room and feeds the allocation
      // engine's computedAmount — which partial re-Bill's invariant compares the withheld
      // (already-paid) component amounts against. Flipping a bearer on a part-paid month
      // could therefore change what a paid component "should" have been. Narrowing this
      // needs its own analysis, not a symmetry argument.
      if (await entryHasActivePayment(tx, session.orgId, entry.id)) return err(409, "ENTRY_LOCKED");

      // Cleaning and WiFi are owner-only grid charges. Keep accepting the legacy
      // bearer fields so an older/stale client can still save its other settings,
      // but never let a new entry snapshot reintroduce the removed tenant columns.
      const settings = {
        tnbPattern: body.tnbPattern, airPattern: body.airPattern,
        cleaningBearer: "owner", wifiBearer: "owner",
        maintenanceFeeBearer: body.maintenanceFeeBearer,
      };
      const where = body.expectedUpdatedAt
        ? { id: entry.id, updatedAt: new Date(body.expectedUpdatedAt) }
        : { id: entry.id, updatedAt: entry.updatedAt };
      const res = await tx.unitBillsGridEntry.updateMany({ where, data: settings });
      if (res.count === 0) return err(409, "STALE");

      const fresh = await tx.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entry.id } });
      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.entry.lines", entityType: "UnitBillsGridEntry", entityId: entry.id, diff: settings,
      });
      return ok({ id: fresh.id, updatedAt: fresh.updatedAt.toISOString() });
    });
  } catch {
    return err(500, "UPDATE_LINES_FAILED");
  }
}

// ─────────────────────────────── READ PATH ──────────────────────────────────

/**
 * Batch-resolve each room's electricity rate, N+1-free (ONE `aircondMeter.findMany`
 * regardless of how many rooms are requested; zero queries for an empty input).
 *
 * meter/service.ts:169-192 parity: a room's single AircondMeter row
 * (`@@unique([organizationId, unitId])` — at most one, ever) supplies its stored
 * `ratePerKwh` whether ACTIVE or RETIRED. Deliberately NO `isActive` filter —
 * filtering it out would silently mis-rate a retired-meter room by falling through
 * to the 0.6 lazy default, exactly the bug meter/service.ts's own lazy resolution
 * avoids by reading a retired meter's rate directly. `configured: true` means "a
 * meter row exists" (active or retired) — NOT "the rate differs from 0.6": a real,
 * active, configured meter can legitimately be set to exactly 0.6.
 *
 * TOTAL map: every requested id gets an entry (found → its own rate; not found,
 * including a foreign-org id — never leaked — → the lazy default). Contrast with
 * {@link resolveRoomRentsBatch}'s PARTIAL map, which omits ids that don't resolve.
 */
export async function resolveRoomRatesBatch(
  db: Prisma.TransactionClient | Db,
  orgId: string,
  listingIds: string[],
): Promise<Map<string, { ratePerKwh: number; configured: boolean }>> {
  const out = new Map<string, { ratePerKwh: number; configured: boolean }>();
  if (listingIds.length === 0) return out;
  const meters = await db.aircondMeter.findMany({
    where: { organizationId: orgId, unitId: { in: listingIds } },
    select: { unitId: true, ratePerKwh: true },
  });
  for (const m of meters) out.set(m.unitId, { ratePerKwh: Number(m.ratePerKwh.toString()), configured: true });
  for (const id of listingIds) if (!out.has(id)) out.set(id, { ratePerKwh: 0.6, configured: false });
  return out;
}

/**
 * Batch-resolve each tenancy's prorated rent for `period`, N+1-free: exactly TWO
 * org-scoped queries for the whole batch (`tenancy.findMany` + `recurringCharge.
 * findMany` via `Promise.all`, regardless of how many tenancies are requested;
 * zero queries for an empty input) → then {@link pickBaseRent} (Task 1's precedence:
 * active rent RecurringCharge → reservation.agreedMonthlyRent → Tenancy.
 * monthlyRentAmount) + {@link computeProratedRent} (Task 1's pure mid-month
 * proration) per tenancy.
 *
 * `orderBy: { id: "asc" }` + "first wins" gives a DETERMINISTIC tie-break when a
 * tenancy carries two-plus active rent RecurringCharges — empirically confirmed
 * necessary: Postgres otherwise returns physical/insertion order, not id order.
 * This is a NARROWER contract than Task 1's own `resolveMonthlyRentAmount`, whose
 * single-row `recurringCharge.findFirst` has no `orderBy` and can therefore pick a
 * DIFFERENT row than this batch loader for the same multi-RC tenancy — a latent
 * cross-path divergence pre-existing in `resolveMonthlyRentAmount`, out of this
 * task's scope to change (flagged for a follow-up, not silently patched here).
 *
 * PARTIAL map: only tenancy ids that resolve (this org, real row) get an entry —
 * a foreign-org or nonexistent id is simply ABSENT, never a zero or a throw.
 * Contrast with {@link resolveRoomRatesBatch}'s TOTAL map.
 *
 * The two internal queries run concurrently (`Promise.all`), not inside a shared
 * snapshot: called with a raw `Db` (not a `Prisma.TransactionClient`), a write
 * landing between them (e.g. an admin deactivating the RC mid-call) could produce
 * a torn read. Callers that need snapshot consistency should pass a
 * `Prisma.TransactionClient` — exactly what the `db` union type invites.
 */
async function resolveRoomRentFactsBatch(
  db: Prisma.TransactionClient | Db,
  orgId: string,
  tenancyIds: string[],
  period: Date,
): Promise<Map<string, { billedRent: string; fullMonthRent: string }>> {
  const out = new Map<string, { billedRent: string; fullMonthRent: string }>();
  if (tenancyIds.length === 0) return out;
  const [tenancies, rcs] = await Promise.all([
    db.tenancy.findMany({
      where: { id: { in: tenancyIds }, organizationId: orgId },
      select: { id: true, startDate: true, endDate: true, monthlyRentAmount: true, reservation: { select: { agreedMonthlyRent: true } } },
    }),
    db.recurringCharge.findMany({
      where: { organizationId: orgId, tenancyId: { in: tenancyIds }, chargeType: "rent", isActive: true },
      select: { tenancyId: true, amount: true },
      orderBy: { id: "asc" }, // deterministic tie-break: "first wins" below then always keeps the lowest id
    }),
  ]);
  const rcByTenancy = new Map<string, number>();
  for (const rc of rcs) if (!rcByTenancy.has(rc.tenancyId)) rcByTenancy.set(rc.tenancyId, Number(rc.amount.toString()));
  for (const t of tenancies) {
    const base = pickBaseRent(
      rcByTenancy.get(t.id) ?? null,
      t.reservation?.agreedMonthlyRent != null ? Number(t.reservation.agreedMonthlyRent) : null,
      Number(t.monthlyRentAmount),
    );
    out.set(t.id, {
      billedRent: computeProratedRent(base, t.startDate, t.endDate, period).toFixed(2),
      fullMonthRent: base.toFixed(2),
    });
  }
  return out;
}

export async function resolveRoomRentsBatch(
  db: Prisma.TransactionClient | Db,
  orgId: string,
  tenancyIds: string[],
  period: Date,
): Promise<Map<string, string>> {
  const facts = await resolveRoomRentFactsBatch(db, orgId, tenancyIds, period);
  return new Map([...facts].map(([id, value]) => [id, value.billedRent]));
}

/**
 * The `months` requested periods, LATEST-FIRST, each pinned to the 1st.
 * `period` (or today) anchors index 0; index i is i months earlier.
 */
async function resolvePeriods(_orgId: string, period: string | undefined, months: number): Promise<Date[]> {
  const anchor = period ? toMonth(period) : toMonth(iso(new Date()));
  return Array.from({ length: months }, (_, i) => new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1)));
}

/** The compact prior-month strip (R5): five read-only lines, no rental/fee/meter/split. */
export interface PriorMonthStrip {
  period: string; cleaning: string | null; tnb: string | null; air: string | null; wifi: string | null; others: string;
}

/**
 * One nested tenant/room sub-row (spec §5 response `subRows`), keyed on `listingId`
 * (Foundation CORRECTION 2). Two VACANT rooms (both `tenancyId: null`) remain
 * distinguishable. `partyName` is null for a vacant room.
 *
 * Task 5: `ratePerKwh`/`rateConfigured`/`rental` are DISPLAY-ONLY derivations —
 * `ratePerKwh`/`rateConfigured` from {@link resolveRoomRatesBatch} (meter-parity:
 * an active-or-retired AircondMeter row's own rate; `configured:false` + the 0.6
 * lazy default when no row exists). `rental` from {@link resolveRoomRentsBatch},
 * keyed on the ROOM's current active tenancy (RoomTenancyInfo.tenancyId) — NOT
 * the reading's own tenancyId snapshot, unlike `tenancyId`/`partyName` above
 * (see `subRowsFor`'s "reading's snapshot wins" comment). A vacant room (no
 * active tenancy) always has `rental: null`. None of these three ever feed
 * computeAllocation (frozen money engine) — display-side only.
 */
export interface SubRowDto {
  listingId: string;
  tenancyId: string | null;
  /** Tenant party billed for this room; read-only, used by the admin portal-preview. */
  partyId?: string | null;
  partyName: string | null;
  /** The tenant's primaryPhone (display + search); null for a vacant room / unresolved orphan. */
  partyPhone: string | null;
  tenancyEndDate?: string | null;
  renewalDecision?: "pending" | "contacted" | "renew" | "not_renew" | null;
  previousKwh: string | null;
  currentKwh: string | null;
  amount: string | null;
  ratePerKwh: string;
  rateConfigured: boolean;
  rental: string | null;
  /** Rental invoice/payment state for this selected month. */
  rentalBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  /** Move-in rental + utilities deposit charges raised in this selected month. */
  deposit?: string | null;
  /** Deposit document/payment state, independent from the bills-grid Bill action. */
  depositBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  /** P5: this reading's own updatedAt (ISO), or null when the room has no reading yet. */
  updatedAt: string | null;
  /** P5: the fullName of the last admin who edited THIS reading; null when never edited / not resolvable. */
  lastEditedByName: string | null;
  /** PAX-per-room: the room's active-tenancy headcount (Tenancy.numberOfPax); null for a vacant /
   * whole-unit room or an orphan reading. Read-only here — the Setting drawer edits it via
   * PATCH /meter/tenancies/:tenancyId/pax. `null`/`0` both render as an unset (blocked) input. */
  numberOfPax: number | null;
}

/**
 * Task 10 (spec §1, additive read-only enrichment): the raw editable amounts +
 * snapshotted line settings for the CURRENT period's entry. WIRE-NAME
 * DISCIPLINE: `tnbTotal`/`airSelangor` echo the RAW columns
 * (`tnbTotalRaw`/`airSelangorRaw`) under the SAME wire names `saveEntrySchema`
 * accepts, so the grid can Save back what it read without a rename.
 *
 * Task 5: `rental` REMOVED — the entry-level column was dropped from the wire/save
 * path (Task 4); per-room rental now lives ONLY on {@link SubRowDto.rental},
 * server-derived from the room's active tenancy (never entered here).
 */
export interface GridEntryDto {
  cleaning: string | null;
  tnbTotal: string | null; // WIRE NAME; sourced from column tnbTotalRaw (RAW, un-shaped)
  airSelangor: string | null; // WIRE NAME; sourced from column airSelangorRaw
  wifi: string | null;
  maintenanceFee: string | null;
  readingDate: string | null; // YYYY-MM-DD or null
  paymentStatus: string;
  tnbPattern: string; // snapshotted line settings (authoritative for the period)
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  updatedAt: string; // ISO; the optimistic-concurrency token the grid echoes as expectedUpdatedAt
  lockState: "draft" | "locked"; // billedAt == null ? "draft" : "locked"
  /** P5: the fullName of the last admin who edited this entry; null when never edited / not resolvable. */
  lastEditedByName: string | null;
}

/** Task 10: the resolved bearer config for this apartment. ALWAYS present on GridRowDto. */
export interface GridBearerConfigDto {
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  cleaningRecurringAmount: string; // toFixed(2)
  isLocked: boolean;
  /** charge-nature gate (2026-07-27): unit-default scalar nature; null = undecided (Bill fails closed). */
  cleaningNature: string | null;
  wifiNature: string | null;
  /** True when an ENABLED recurring definition GOVERNS that scalar for the CURRENT billing month —
   * then amount/bearer/nature are owned end-to-end by the Recurring-charges editor and the drawer
   * renders its controls read-only rather than offering a second, losing source of truth. */
  cleaningGoverned: boolean;
  wifiGoverned: boolean;
  /** Per-kind recurring state for ALL scalar kinds — the tick + amount the Setting drawer renders.
   *  cleaningGoverned/wifiGoverned above are legacy PROJECTIONS of this same record (kept so the
   *  grid's existing consumers are untouched), never a second source of truth. */
  scalarRecurring: Record<ScalarRecurringKind, ScalarRecurringState>;
}

/** Task 10: active-only expense totals, split tenant/owner, each further split by withSST. */
export interface GridExpenseSummaryItemDto {
  id: string;
  description: string;
  amount: string;
  sst: string;
  total: string;
  withSST: boolean;
}

export interface GridExpensesDto {
  tenant: { total: string; withSstTotal: string; sstTotal: string; count: number; items: GridExpenseSummaryItemDto[]; nonSstCount: number; withSstCount: number; nonSstActionRequiredCount: number; withSstActionRequiredCount: number; nonSstGrossMargin: string; withSstGrossMargin: string };
  owner: { total: string; withSstTotal: string; sstTotal: string; count: number; items: GridExpenseSummaryItemDto[]; nonSstCount: number; withSstCount: number; nonSstActionRequiredCount: number; withSstActionRequiredCount: number; nonSstGrossMargin: string; withSstGrossMargin: string };
}

/** Task 10: a brief attachment reference — no storageKey/contentType/etc on the grid row. */
export interface GridAttachmentBrief {
  id: string;
  filename: string;
  cellKey: string | null;
  columnId: string | null;
  documentKind: string | null;
}

/** Structural input for {@link toEntryDto} — deliberately narrower than the Prisma payload (PURE mapper). */
interface EntryDtoInput {
  cleaning: Prisma.Decimal | null;
  tnbTotalRaw: Prisma.Decimal | null;
  airSelangorRaw: Prisma.Decimal | null;
  wifi: Prisma.Decimal | null;
  maintenanceFee: Prisma.Decimal | null;
  readingDate: Date | null;
  paymentStatus: string;
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  updatedAt: Date;
  billedAt: Date | null;
  /** P5: last admin editor (User.id). OPTIONAL so existing pure-mapper fixtures compile unchanged. */
  updatedById?: string | null;
}

/**
 * PURE. `null` when the apartment-month was never materialised (no entry row).
 * P5: `nameById` (optional) resolves `updatedById` → `lastEditedByName`; absent
 * (pure-mapper callers) or an unresolvable/foreign id ⇒ `lastEditedByName: null`.
 */
export function toEntryDto(entry: EntryDtoInput | null, nameById?: ReadonlyMap<string, string>): GridEntryDto | null {
  if (!entry) return null;
  return {
    cleaning: entry.cleaning?.toString() ?? null,
    tnbTotal: entry.tnbTotalRaw?.toString() ?? null,
    airSelangor: entry.airSelangorRaw?.toString() ?? null,
    wifi: entry.wifi?.toString() ?? null,
    maintenanceFee: entry.maintenanceFee?.toString() ?? null,
    readingDate: entry.readingDate ? iso(entry.readingDate) : null,
    paymentStatus: entry.paymentStatus,
    tnbPattern: entry.tnbPattern,
    airPattern: entry.airPattern,
    cleaningBearer: entry.cleaningBearer,
    wifiBearer: entry.wifiBearer,
    maintenanceFeeBearer: entry.maintenanceFeeBearer,
    updatedAt: entry.updatedAt.toISOString(),
    lockState: entry.billedAt == null ? "draft" : "locked",
    lastEditedByName: entry.updatedById ? (nameById?.get(entry.updatedById) ?? null) : null,
  };
}

/** PURE. `expenses` is active-only — already filtered by the caller's query (`status: "active"`). */
export function toExpensesDto(expenses: Array<{ id?: string; description?: string; bearer: string; amount: Prisma.Decimal; withSST: boolean; actualCost?: Prisma.Decimal | null; costPaymentStatus?: string }>): GridExpensesDto {
  let tenantTotal = 0;
  let tenantWithSstTotal = 0;
  let tenantSstTotal = 0;
  let tenantCount = 0;
  let tenantNonSstCount = 0;
  let tenantWithSstCount = 0;
  let tenantNonSstActionRequiredCount = 0;
  let tenantWithSstActionRequiredCount = 0;
  let tenantNonSstActualCost = 0;
  let tenantWithSstActualCost = 0;
  const tenantItems: GridExpenseSummaryItemDto[] = [];
  let ownerTotal = 0;
  let ownerWithSstTotal = 0;
  let ownerSstTotal = 0;
  let ownerCount = 0;
  let ownerNonSstCount = 0;
  let ownerWithSstCount = 0;
  let ownerNonSstActionRequiredCount = 0;
  let ownerWithSstActionRequiredCount = 0;
  let ownerNonSstActualCost = 0;
  let ownerWithSstActualCost = 0;
  const ownerItems: GridExpenseSummaryItemDto[] = [];
  for (const e of expenses) {
    const amount = num(e.amount);
    const sst = e.withSST ? expenseSstAmount(amount, EXPENSE_STANDARD_SST_RATE) : 0;
    const item = e.id != null && e.description != null
      ? {
          id: e.id,
          description: e.description,
          amount: amount.toFixed(2),
          sst: sst.toFixed(2),
          total: round2(amount + sst).toFixed(2),
          withSST: e.withSST,
        }
      : null;
    const actionRequired = e.actualCost == null || e.costPaymentStatus !== "paid";
    if (e.bearer === "tenant") {
      tenantTotal += amount;
      tenantSstTotal = round2(tenantSstTotal + sst);
      tenantCount += 1;
      if (item) tenantItems.push(item);
      if (e.withSST) {
        tenantWithSstTotal += amount;
        tenantWithSstCount += 1;
        if (actionRequired) tenantWithSstActionRequiredCount += 1;
        tenantWithSstActualCost += e.actualCost == null ? 0 : num(e.actualCost);
      } else {
        tenantNonSstCount += 1;
        if (actionRequired) tenantNonSstActionRequiredCount += 1;
        tenantNonSstActualCost += e.actualCost == null ? 0 : num(e.actualCost);
      }
    } else if (e.bearer === "owner") {
      ownerTotal += amount;
      ownerSstTotal = round2(ownerSstTotal + sst);
      ownerCount += 1;
      if (item) ownerItems.push(item);
      if (e.withSST) {
        ownerWithSstTotal += amount;
        ownerWithSstCount += 1;
        if (actionRequired) ownerWithSstActionRequiredCount += 1;
        ownerWithSstActualCost += e.actualCost == null ? 0 : num(e.actualCost);
      } else {
        ownerNonSstCount += 1;
        if (actionRequired) ownerNonSstActionRequiredCount += 1;
        ownerNonSstActualCost += e.actualCost == null ? 0 : num(e.actualCost);
      }
    }
  }
  return {
    tenant: {
      total: tenantTotal.toFixed(2),
      withSstTotal: tenantWithSstTotal.toFixed(2),
      sstTotal: tenantSstTotal.toFixed(2),
      count: tenantCount,
      items: tenantItems,
      nonSstCount: tenantNonSstCount,
      withSstCount: tenantWithSstCount,
      nonSstActionRequiredCount: tenantNonSstActionRequiredCount,
      withSstActionRequiredCount: tenantWithSstActionRequiredCount,
      nonSstGrossMargin: (tenantTotal - tenantWithSstTotal - tenantNonSstActualCost).toFixed(2),
      withSstGrossMargin: (tenantWithSstTotal - tenantWithSstActualCost).toFixed(2),
    },
    owner: {
      total: ownerTotal.toFixed(2),
      withSstTotal: ownerWithSstTotal.toFixed(2),
      sstTotal: ownerSstTotal.toFixed(2),
      count: ownerCount,
      items: ownerItems,
      nonSstCount: ownerNonSstCount,
      withSstCount: ownerWithSstCount,
      nonSstActionRequiredCount: ownerNonSstActionRequiredCount,
      withSstActionRequiredCount: ownerWithSstActionRequiredCount,
      nonSstGrossMargin: (ownerTotal - ownerWithSstTotal - ownerNonSstActualCost).toFixed(2),
      withSstGrossMargin: (ownerWithSstTotal - ownerWithSstActualCost).toFixed(2),
    },
  };
}

/** Per-entry CUSTOM recurring totals (owner/tenant), summed from GridEntryRecurringLine.
 * Cleaning/WiFi are NOT here — they keep their own scalar columns (R9). */
export interface GridRecurringTotalItem { id: string; name: string; amount: string }
export interface GridRecurringTotals {
  ownerTotal: number;
  ownerCount: number;
  ownerItems?: GridRecurringTotalItem[];
  tenantTotal: number;
  tenantCount: number;
  tenantItems?: GridRecurringTotalItem[];
}

export function toRecurringDto(t?: GridRecurringTotals): GridRecurringDto {
  return {
    owner: { total: (t?.ownerTotal ?? 0).toFixed(2), count: t?.ownerCount ?? 0, items: t?.ownerItems ?? [] },
    tenant: { total: (t?.tenantTotal ?? 0).toFixed(2), count: t?.tenantCount ?? 0, items: t?.tenantItems ?? [] },
  };
}

/** Batched per-entry recurring totals for the grid read — ONE query for the whole page (no
 * N+1, mirroring entriesWithPaidInvoice/billedApartmentIds). */
async function recurringTotalsByEntry(orgId: string, entryIds: string[]): Promise<Map<string, GridRecurringTotals>> {
  const map = new Map<string, GridRecurringTotals>();
  if (entryIds.length === 0) return map;
  const lines = await prisma.gridEntryRecurringLine.findMany({
    where: { organizationId: orgId, gridEntryId: { in: entryIds } },
    select: { id: true, gridEntryId: true, name: true, amount: true, bearer: true },
  });
  for (const l of lines) {
    let t = map.get(l.gridEntryId);
    if (!t) { t = { ownerTotal: 0, ownerCount: 0, ownerItems: [], tenantTotal: 0, tenantCount: 0, tenantItems: [] }; map.set(l.gridEntryId, t); }
    const item = { id: l.id, name: l.name, amount: l.amount.toFixed(2) };
    if (l.bearer === "owner") { t.ownerTotal = round2(t.ownerTotal + num(l.amount)); t.ownerCount += 1; t.ownerItems!.push(item); }
    else { t.tenantTotal = round2(t.tenantTotal + num(l.amount)); t.tenantCount += 1; t.tenantItems!.push(item); }
  }
  return map;
}

/** CUSTOM recurring totals PROJECTED for apartments whose month entry does not EXIST yet —
 * the Recurring Owner/Tenant columns' sibling of the dialog's read-time projection
 * (listRecurringLinesService): a definition saved in Settings must show in the grid total
 * immediately, not only after some unrelated save opens the period and materialize-on-open
 * runs. Uses the SAME resolver materialization uses (fail-closed on unresolvable
 * target/category), so the projected total is exactly what opening the month will write —
 * never money billing won't mint. PURE read — no entry is created. Flag-gated so the legacy
 * (flag-off) read stays byte-identically empty.
 *
 * Query shape: ONE page-wide def scan; the per-apartment resolver then runs ONLY for
 * apartments that actually have an enabled applicable CUSTOM revision this period — for
 * everyone else (the overwhelming page majority) this adds zero queries. */
export async function projectedRecurringTotalsByApartment(
  orgId: string,
  apartmentIds: string[],
  period: Date,
): Promise<Map<string, GridRecurringTotals>> {
  const map = new Map<string, GridRecurringTotals>();
  if (apartmentIds.length === 0 || !isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return map;
  const defs = await prisma.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId: { in: apartmentIds }, kind: "CUSTOM", archivedAt: null },
    include: { revisions: true },
  });
  const t = period.getTime();
  const candidates = new Set<string>();
  for (const def of defs) {
    const rev = def.revisions.find(
      (r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()),
    );
    if (rev?.enabled) candidates.add(def.apartmentId);
  }
  for (const aptId of candidates) {
    const resolved = await resolveRecurringForPeriod(prisma, orgId, aptId, period);
    if (resolved.customLines.length === 0) continue;
    const tot: GridRecurringTotals = { ownerTotal: 0, ownerCount: 0, ownerItems: [], tenantTotal: 0, tenantCount: 0, tenantItems: [] };
    for (const l of resolved.customLines) {
      const item = { id: l.definitionId, name: l.name, amount: l.amount.toFixed(2) };
      if (l.bearer === "owner") { tot.ownerTotal = round2(tot.ownerTotal + num(l.amount)); tot.ownerCount += 1; tot.ownerItems!.push(item); }
      else { tot.tenantTotal = round2(tot.tenantTotal + num(l.amount)); tot.tenantCount += 1; tot.tenantItems!.push(item); }
    }
    map.set(aptId, tot);
  }
  return map;
}

/** Per-apartment cleaning/wifi governance for the grid read: whether an ENABLED recurring def
 * governs the scalar at `period` (→ read-only + write-protected, R6) AND the generated amount it
 * produces (so a governed cell shows that value even for an unopened month whose entry scalar is
 * still null — the "shows – instead of 100" fix). Batched ONE query for the whole page. */
/** Per-kind recurring state for one apartment-month: whether an ENABLED definition governs that
 * scalar (→ the grid cell is read-only + write-protected) and the amount it generates.
 *
 * Keyed by ScalarRecurringKind rather than a hand-written {cleaning, wifi, cleaningAmount,
 * wifiAmount} shape — the same anti-drift pattern as TENANT_SHARE_OF / OWNER_AMOUNT_OF. Adding a
 * kind to SCALAR_RECURRING_KINDS extends governance, the DTO and the drawer with no change here,
 * and a `Record` makes an omission a compile error rather than a silently unlocked money cell. */
export type ScalarRecurringState = {
  governed: boolean;
  amount: string | null;
  /** The governing definition's id — required to DISABLE it when the admin unticks the box.
   *  Null when un-governed (nothing to disable). */
  definitionId: string | null;
};
type GovernedScalars = Record<ScalarRecurringKind, ScalarRecurringState>;

const noGovernedScalars = (): GovernedScalars =>
  Object.fromEntries(
    SCALAR_RECURRING_KIND_LIST.map((k) => [k, { governed: false, amount: null, definitionId: null }]),
  ) as GovernedScalars;

async function governingScalarByApartment(orgId: string, apartmentIds: string[], period: Date): Promise<Map<string, GovernedScalars>> {
  const map = new Map<string, GovernedScalars>();
  if (apartmentIds.length === 0) return map;
  const defs = await prisma.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId: { in: apartmentIds }, kind: { in: SCALAR_RECURRING_KIND_LIST }, archivedAt: null },
    include: { revisions: true },
  });
  const t = period.getTime();
  for (const def of defs) {
    const rev = def.revisions.find((r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()));
    if (!rev || !rev.enabled) continue;
    // The query already filters to scalar kinds; the guard keeps the index type-safe.
    if (!isScalarRecurringKind(def.kind)) continue;
    let g = map.get(def.apartmentId);
    if (!g) { g = noGovernedScalars(); map.set(def.apartmentId, g); }
    g[def.kind] = { governed: true, amount: rev.amount.toFixed(2), definitionId: def.id };
  }
  return map;
}

/** Structural input for {@link toBearerConfigDto}. */
interface BearerConfigDtoInput {
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  cleaningRecurringAmount: Prisma.Decimal;
  isLocked: boolean;
  cleaningNature?: string | null;
  wifiNature?: string | null;
}

/**
 * PURE. `null` → the SAME defaults `getBearerConfigService` returns when no config
 * row exists, and the same ones `resolveBearerConfig` WRITES when it creates one —
 * all three resolve through `bearerDefaultsFor`, which is the single source of truth.
 *
 * `listingMode` is REQUIRED, not optional-with-a-fallback, precisely because it decides
 * money (whether a tenant is billed cleaning + WiFi). An optional param would let a new
 * call site silently take WHOLE's defaults for a partition unit.
 */
export function toBearerConfigDto(
  cfg: BearerConfigDtoInput | null,
  listingMode: string,
  governed?: GovernedScalars,
): GridBearerConfigDto {
  // charge-nature gate: `null` nature is the SEEDED default for a unit with no config row —
  // deliberately undecided, NOT "profit". Governance defaults false when the caller does not
  // resolve it (every pre-gate caller), which renders the drawer's new controls editable.
  const gov: GovernedScalars = governed ?? noGovernedScalars();
  if (!cfg) {
    return {
      ...bearerDefaultsFor(listingMode),
      cleaningRecurringAmount: DEFAULT_CLEANING_RECURRING_AMOUNT,
      isLocked: false,
      cleaningNature: null,
      wifiNature: null,
      cleaningGoverned: gov.CLEANING.governed,
      wifiGoverned: gov.WIFI.governed,
      scalarRecurring: gov,
    };
  }
  return {
    tnbPattern: cfg.tnbPattern,
    airPattern: cfg.airPattern,
    cleaningBearer: cfg.cleaningBearer,
    wifiBearer: cfg.wifiBearer,
    maintenanceFeeBearer: cfg.maintenanceFeeBearer,
    cleaningRecurringAmount: cfg.cleaningRecurringAmount.toFixed(2),
    isLocked: cfg.isLocked,
    cleaningNature: cfg.cleaningNature ?? null,
    wifiNature: cfg.wifiNature ?? null,
    cleaningGoverned: gov.CLEANING.governed,
    wifiGoverned: gov.WIFI.governed,
    scalarRecurring: gov,
  };
}

/** PURE. Exposes only safe display/scope metadata; storage keys stay server-internal. */
export function toAttachmentBriefs(attachments: Array<{ id: string; filename: string; cellKey: string | null; columnId: string | null; documentKind: string | null }>): GridAttachmentBrief[] {
  return attachments.map((a) => ({ id: a.id, filename: a.filename, cellKey: a.cellKey, columnId: a.columnId, documentKind: a.documentKind }));
}

export type GridManagementFeeStatus =
  | "not_configured"
  | "before_first_charge"
  | "free_period"
  | "commission_month"
  | "no_rental_income"
  | "awaiting_rent"
  | "chargeable"
  | "posted";

export interface GridManagementFeeDto {
  nonSst: string;
  sst: string;
  total: string;
  configured: boolean;
  status: GridManagementFeeStatus;
  reason: string | null;
}

export type PendingTenancyChargeKind =
  | "rental"
  | "deposit"
  | "agreement_fee"
  | "renewal_fee"
  | "carpark"
  | "other";

export interface PendingTenancyChargeDto {
  id: string;
  description: string;
  kind: PendingTenancyChargeKind;
  payer: "tenant" | "owner";
  baseAmount: string;
  sst: string;
  total: string;
  /** Legacy wire name; contains the actual billed party name for either payer. */
  tenantName: string | null;
}

interface PendingTenancyChargeInput {
  id: string;
  description: string | null;
  chargeType: string;
  chargeStatus: string;
  amount: Prisma.Decimal;
  sstRate: Prisma.Decimal | null;
  categoryName?: string | null;
  categorySstRate?: Prisma.Decimal | null;
  exactSstAmount?: Prisma.Decimal | null;
  payer: "tenant" | "owner";
  invoiceStatus: string | null;
  invoiceType: string | null;
  tenantName: string | null;
}

const BILLABLE_TENANCY_INVOICE_TYPES = new Set([
  "tenant_rental",
  "tenant_deposit",
  "tenant_agreement_fee",
  "tenant_renewal",
]);

/** PURE. Maps every draft charge attached to one of the exact tenancy invoices the
 * Bills Grid Bill action sends through bulk approval. Charge type does not gate the
 * result: approval posts every attached draft charge, including carpark and manually
 * attached extras. */
export function toPendingTenancyChargeDto(input: PendingTenancyChargeInput): PendingTenancyChargeDto | null {
  if (
    input.invoiceStatus !== "draft"
    || input.chargeStatus !== "draft"
    || !input.invoiceType
    || !BILLABLE_TENANCY_INVOICE_TYPES.has(input.invoiceType)
  ) {
    return null;
  }
  const kind: PendingTenancyChargeKind =
    input.chargeType === "rent" || input.chargeType === "letting_commission"
      ? "rental"
      : input.chargeType === "security_deposit" || input.chargeType === "utility_deposit"
        ? "deposit"
        : input.chargeType === "tenancy_agreement_fee"
          ? "agreement_fee"
          : input.chargeType === "renewal_fee"
            ? "renewal_fee"
            : input.chargeType === "carpark"
              ? "carpark"
              : "other";

  const fallbackDescription: Record<PendingTenancyChargeKind, string> = {
    rental: "Rental",
    deposit: "Deposit",
    agreement_fee: "TA (WITH SST)",
    renewal_fee: "Renewal TA (WITH SST)",
    carpark: "Carpark rent",
    other: "Additional charge",
  };
  const baseAmount = num(input.amount);
  // Keep the preview cent-identical to issuance. Inclusive TA charges carry a
  // payable tax sibling whose amount is the exact residual from the entered
  // gross total; ordinary lines keep the standard amount × rate rounding.
  const effectiveSstRate = input.sstRate ?? input.categorySstRate;
  const sst = input.exactSstAmount != null
    ? num(input.exactSstAmount)
    : expenseSstAmount(baseAmount, effectiveSstRate?.toString() ?? "0");
  return {
    id: input.id,
    description: (
      kind === "agreement_fee" && input.description?.trim() === "Tenancy agreement fee"
        ? fallbackDescription.agreement_fee
        : kind === "renewal_fee" && input.description?.trim() === "Tenancy renewal fee"
          ? fallbackDescription.renewal_fee
          : input.description?.trim() || input.categoryName?.trim() || fallbackDescription[kind]
    ),
    kind,
    payer: input.payer,
    baseAmount: baseAmount.toFixed(2),
    sst: sst.toFixed(2),
    total: round2(baseAmount + sst).toFixed(2),
    tenantName: input.tenantName,
  };
}

export interface GridRowDto {
  /** R13: money settled against a proforma line that never got its tax invoice. The money
   *  is correct; only the document is missing, and it is repairable. */
  graduationPending?: boolean;
  apartmentId: string;
  unitCode: string;
  /** Task 10 (spec §1): the apartment's parent property, for grid grouping/filtering. */
  propertyId: string;
  /** Fix (final review): the property's display name, so the Categorize
   * filter can show a name instead of a raw propertyId UUID. Sourced from
   * the apartment→property relation (Property.name). */
  propertyName: string;
  /** Business-facing property short form (Property.propertyCode). The Unit
   * column combines this with Apartment.unitCode instead of repeating the
   * full condo name on every row. */
  propertyCode: string;
  /** The unit owner's displayName (every room shares one owner via Listing.ownerPartyId).
   * Display + search only — never a billing-math input. null when the apartment has no
   * owned listing / no owner party. Owner PHONE is intentionally not surfaced here. */
  ownerName: string | null;
  /** Owner party identity for the admin-only link to Owner Details. */
  ownerPartyId: string | null;
  entryId: string | null;
  /** null when the apartment-month was never Saved, or when shaping/compute failed. */
  preview: ComputeResult | null;
  /** Structured, never an HTTP status. `null` when the preview succeeded. */
  previewError: { code: string; detail?: unknown } | null;
  /** Exact, server-effective first-issuance utility component plan. */
  billUtilityPlan: GridBillUtilityPlanDto;
  /** NON-fatal row-level anomalies. An empty array is the healthy case. */
  warnings: RowWarning[];
  /** Nested tenant/room sub-rows, keyed on listingId (Foundation CORRECTION 2). */
  subRows: SubRowDto[];
  billedAt: string | null;
  /** Task 8: when the entry's invoices were first ISSUED (null until a Bill issues docs).
   * DISTINCT from billedAt — an entry can be billed (locked) WITHOUT issuing invoices
   * (flag-off history, or nothing billable). Non-null ⇒ a re-Bill supersedes live docs. */
  invoicedAt: string | null;
  paymentStatus: string;
  /** Task 8: TRUE iff a LIVE invoice for this entry carries a net-positive payment
   * (net-of-reversal) — the SAME predicate the server paid-freeze uses. Drives the FE
   * amend/re-Bill lock (a paid entry is frozen). Server paid-freeze stays authoritative. */
  hasPaidInvoice: boolean;
  /** TRUE iff this month is billed AND carries grid data newer than that Bill — an amend
   * that has not been re-Billed, so the live invoice no longer matches the row. Exists
   * because the 2026-08-17 unlock lets an admin amend a billed-but-unpaid month: without a
   * marker they can add an expense, never press Bill, and that money never reaches an
   * invoice. Derived at read time from timestamps already loaded — no column, no query. */
  hasUnbilledChanges: boolean;
  /** READ-TIME payment state derived from the entry's live grid charges — `status` for the
   * row badge, `cells`/`rooms` for the per-column tick. DISPLAY ONLY: distinct from the manual
   * `paymentStatus` column above, which still owns the edit lock. See settlementByEntry. */
  settlement: GridSettlementDto;
  /** Rule 2: TRUE iff this unit-month has a LIVE grid-workflow invoice, derived from the
   * invoices THIS workflow generated (GRIDUTIL/GRIDOWN provenance) — NOT from
   * `invoicedAt`, so a legacy invoice whose charge was orphaned (sourceGridEntryId nulled)
   * still shows the `Billed` tag. Drives the row's Billed badge on the FE. */
  billed: boolean;
  /** Re-Bill signal: `0` on the first Bill, incremented once per CONFIRMED re-Bill
   * (rebillSupersedeTx step 6). `> 0` ⇒ this live unit-month has been re-Billed, which
   * drives the FE's mutually-exclusive Re-Billed tag (replacing Billed). Never distinguishes
   * a first Bill from a re-Bill via `billedAt` alone — that is set on BOTH. */
  billRevision: number;
  /** Latest-first, one per requested prior month; empty when `months = 1` (R6). */
  priorMonths: PriorMonthStrip[];
  /** Task 10: raw editable amounts + snapshotted line settings. `null` when unsaved. */
  entry: GridEntryDto | null;
  /** Task 10: ALWAYS present — defaults when no config row (mirrors getBearerConfigService). */
  bearerConfig: GridBearerConfigDto;
  /** Task 10: active-only expense totals. "0.00" totals when `entry` is null. */
  expenses: GridExpensesDto;
  /** Management fee base and SST split; SST is payable to government, not revenue. */
  managementFee: GridManagementFeeDto;
  /** Tenant agreement charges created outside the editable bills grid. */
  agreementFees: {
    new: { amount: string; outstanding: string; state: "none" | "saved" | "billed-unpaid" | "paid" };
    renewal: { amount: string; outstanding: string; state: "none" | "saved" | "billed-unpaid" | "paid" };
  };
  /** Exact base/SST lines attached to draft tenancy invoices this row's Bill action approves. */
  pendingTenancyCharges: PendingTenancyChargeDto[];
  /** Cash-basis owner payout and any owner top-up shortfall from the authoritative ledger. */
  ownerPayout: string;
  ownerTopUpRequired: string;
  /** Recurring-charges (R9): CUSTOM recurring-line totals ONLY (cleaning/WiFi excluded — they
   * have their own columns). "0.00"/0 when `entry` is null or the flag is dark. */
  recurring: GridRecurringDto;
  /** Recurring-charges (R6 refined): TRUE iff an ENABLED recurring definition GOVERNS this
   * apartment-month's cleaning / wifi scalar (→ read-only + write-protected). FALSE ⇒ the cell is
   * an editable per-month value (no def, disabled def, or pre-effective month). Drives the grid's
   * per-cell read-only vs editable rendering. */
  cleaningRecurringLocked: boolean;
  wifiRecurringLocked: boolean;
  /** The generated cleaning/wifi amount when governed (the enabled applicable revision's amount),
   * so a read-only cell shows it even for an unopened month (entry scalar still null). null when
   * ungoverned. */
  cleaningRecurringAmount: string | null;
  wifiRecurringAmount: string | null;
  /** Per-kind recurring state for ALL scalar kinds — drives the grid's cell locking. The two
   *  *RecurringAmount fields above are legacy projections of this same record. */
  scalarRecurring: Record<ScalarRecurringKind, ScalarRecurringState>;
  /** Task 10: brief attachment refs. `[]` when `entry` is null. */
  attachments: GridAttachmentBrief[];
  /**
   * Task 5: `apt.listingMode === "WHOLE"`. The FE grain-lock's replacement signal
   * now that `entry.rental` (the old WHOLE-vs-PARTITIONED tell) is gone from the
   * wire — see Task 4's Apartment.listingMode migration.
   */
  isWholeUnit: boolean;
}

/**
 * R5: the prior strip's "Others (Expenses)" is the per-apartment-month SUM of
 * GridExpense.amount over `withSST = false`, `status = "active"`, `bearer = "owner"`.
 */
async function priorStripsFor(orgId: string, apartmentId: string, priors: Date[]): Promise<PriorMonthStrip[]> {
  const out: PriorMonthStrip[] = [];
  for (const p of priors) {
    const e = await prisma.unitBillsGridEntry.findUnique({
      where: { organizationId_apartmentId_periodMonth: { organizationId: orgId, apartmentId, periodMonth: p } },
    });
    const agg = await prisma.gridExpense.aggregate({
      _sum: { amount: true },
      where: { organizationId: orgId, apartmentId, periodMonth: p, withSST: false, status: "active", bearer: "owner" },
    });
    out.push({
      period: iso(p),
      cleaning: e?.cleaning?.toString() ?? null,
      tnb: e?.tnbTotalRaw?.toString() ?? null,
      air: e?.airSelangorRaw?.toString() ?? null,
      wifi: e?.wifi?.toString() ?? null,
      others: (agg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
    });
  }
  return out;
}

type GridEntryWithChildren = Prisma.UnitBillsGridEntryGetPayload<{ include: { readings: true; expenses: true; attachments: true } }>;

/**
 * TRUE iff a BILLED month carries grid data newer than its Bill — an amend that has not
 * been re-Billed, so the live invoice no longer matches the row.
 *
 * WHY IT EXISTS. The 2026-08-17 unlock lets an admin amend a billed-but-UNPAID month
 * ({@link entryHasActivePayment}). Without a marker they can add an expense, forget to Bill, and
 * that money never reaches an invoice — the one money risk the unlock introduces. It also
 * answers the concern voidExpenseService used to prevent outright: voiding a line on a
 * billed month moves the recorded "Others (Expenses)" total, which is now SHOWN rather
 * than blocked.
 *
 * FREE: the read path already loads every child (GridEntryWithChildren above), so this is a
 * pure in-memory fold — no extra query, no new column, no migration.
 *
 * BIASED TO DIRTY. A false positive costs one re-Bill that returns `already_billed`, which
 * mutates nothing; a false negative silently leaves money off an invoice. Ambiguity resolves
 * to true.
 *
 * The three child models do NOT share a shape: GridExpense and GridMeterReading carry
 * createdAt AND updatedAt, but GridAttachment carries createdAt ONLY (no @updatedAt column).
 * They are folded separately rather than concatenated, which would not typecheck. The
 * consequence is accepted: replacing an attachment in place is invisible here, and an
 * attachment carries no billed amount, so that miss cannot cost money.
 */
export function deriveHasUnbilledChanges(entry: GridEntryWithChildren | null): boolean {
  if (!entry?.billedAt) return false;
  const billed = entry.billedAt.getTime();
  const newer = (d: Date | null | undefined): boolean => d != null && d.getTime() > billed;
  // Prisma's @updatedAt is stamped a fraction after the explicit billedAt during the
  // SAME Bill update (observed locally: billedAt .585, updatedAt .586). That 1 ms is
  // issuance metadata, not an admin edit. A real follow-up Save cannot complete inside
  // this tiny 50 ms write-settle window, so ignore only that immediate companion stamp.
  if (entry.updatedAt.getTime() > billed + 50) return true;
  if (entry.readings.some((r) => newer(r.updatedAt) || newer(r.createdAt))) return true;
  if (entry.expenses.some((e) => newer(e.updatedAt) || newer(e.createdAt))) return true;
  return entry.attachments.some((a) => newer(a.createdAt));
}

/**
 * One of the apartment's REAL rooms (a Listing) with its current active tenancy,
 * batch-loaded ONCE per grid request in getGridService (never per-apartment — no
 * N+1). `tenancyId`/`partyName` come from the room's active Tenancy (latest-first);
 * both null for a vacant room. This is the SAME source of truth the tenant-tracker
 * reads (Listing → active Tenancy → tenantParty.displayName) — the grid is no
 * longer a silo that only "discovers" a room once a meter reading is keyed.
 *
 * Task 5: `ratePerKwh`/`rateConfigured` from {@link resolveRoomRatesBatch} (keyed
 * on `listingId`); `rental` from {@link resolveRoomRentsBatch} keyed on THIS
 * room's current active `tenancyId` above (never a reading's own tenancyId
 * snapshot — deliberately DIFFERENT from the "reading's snapshot wins" rule
 * `subRowsFor` applies to `tenancyId`/`partyName`, because rental is a property
 * of who lives there NOW, not who was billed on a past reading). `rental` is
 * null for a vacant room (no active tenancy to resolve rent for).
 */
export interface RoomTenancyInfo {
  listingId: string;
  tenancyId: string | null;
  partyId?: string | null;
  partyName: string | null;
  /** The active tenant's primaryPhone; null for a vacant room. Display + search only. */
  partyPhone: string | null;
  tenancyEndDate?: string | null;
  renewalDecision?: "pending" | "contacted" | "renew" | "not_renew" | null;
  ratePerKwh: string;
  rateConfigured: boolean;
  rental: string | null;
  rentalBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  deposit?: string | null;
  depositBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  /** PAX-per-room: the active tenancy's numberOfPax; null for a vacant room. */
  numberOfPax: number | null;
}

/** Task 5 defaults for a sub-row with no batch-loaded room info (orphan readings). */
const ORPHAN_RATE_DEFAULTS = {
  ratePerKwh: "0.6000",
  rateConfigured: false,
  rental: null as string | null,
  rentalBillingState: null as "saved" | "billed-unpaid" | "paid" | null,
  deposit: null as string | null,
  depositBillingState: null as "saved" | "billed-unpaid" | "paid" | null,
};

/**
 * Nested sub-rows for the READ path, keyed on listingId. Every one of the
 * apartment's real rooms is surfaced up-front (with its active tenant's name),
 * so the grid shows tenants + editable meter cells IMMEDIATELY — the admin no
 * longer has to blind-create a room by keying a reading first. Any existing
 * GridMeterReading is left-merged onto its room by listingId (previous/current
 * kWh + submeter amount); a room with no reading yet shows null meter cells that
 * the admin fills in and Saves (that Save is what feeds the frozen money engine —
 * unchanged). When a reading exists its OWN tenancy snapshot wins (that is what
 * was billed); an empty room adopts the current active tenancy so a NEW reading
 * attributes to the right tenant.
 *
 * ORG-SCOPED party resolution: a reading whose room is NOT among the apartment's
 * current Listings (an orphaned / foreign-listing snapshot) is still rendered so
 * no keyed data ever vanishes, with its party resolved from the reading's partyId
 * snapshot bounded by `organizationId` — a foreign org's `displayName` MUST NOT
 * be echoed (schema.prisma:2920 has no FK; this is the same defence-in-depth the
 * write path applies in saveReadingsService).
 *
 * Task 5: real rooms carry `ratePerKwh`/`rateConfigured`/`rental` from their
 * batch-loaded `RoomTenancyInfo` (rental keyed on the ROOM's active tenancy, NOT
 * the reading's snapshot — see RoomTenancyInfo's doc comment); orphan-reading
 * rows have no batched room to draw from and default to
 * `{ratePerKwh:"0.6000", rateConfigured:false, rental:null}` (ORPHAN_RATE_DEFAULTS).
 * Also derives NEGATIVE_CONSUMPTION warnings, one per room whose STORED reading
 * has `round2(currentKwh - previousKwh) < 0` — mirrors the save-time clamp
 * (`deriveReadingAmount`'s discarded `negative` flag) but reads the PERSISTED
 * columns, never re-deriving. A reading with `currentKwh: null` (not yet keyed)
 * or `previousKwh: null` is skipped — never miscoerced to a false negative.
 */
async function subRowsFor(
  orgId: string,
  rooms: RoomTenancyInfo[],
  entry: GridEntryWithChildren | null,
  nameById: ReadonlyMap<string, string>,
): Promise<{ subRows: SubRowDto[]; warnings: RowWarning[] }> {
  const readings = entry?.readings ?? [];
  const readingByListing = new Map(readings.map((r) => [r.listingId, r]));
  const negWarnings: RowWarning[] = [];

  const toSub = (
    listingId: string,
    tenancyId: string | null,
    partyId: string | null,
    partyName: string | null,
    partyPhone: string | null,
    rate: Pick<RoomTenancyInfo, "ratePerKwh" | "rateConfigured" | "rental" | "rentalBillingState" | "deposit" | "depositBillingState">,
    numberOfPax: number | null,
    tenancyEndDate: string | null,
    renewalDecision: "pending" | "contacted" | "renew" | "not_renew" | null,
  ): SubRowDto => {
    const rd = readingByListing.get(listingId);
    if (rd && rd.previousKwh != null && rd.currentKwh != null) {
      const consumption = round2(Number(rd.currentKwh.toString()) - Number(rd.previousKwh.toString()));
      if (consumption < 0) negWarnings.push({ code: "NEGATIVE_CONSUMPTION", listingId });
    }
    const resolvedTenancyId = rd ? rd.tenancyId : tenancyId; // reading's snapshot wins once one exists
    return {
      listingId,
      tenancyId: resolvedTenancyId,
      partyId: rd ? rd.partyId : partyId,
      partyName,
      partyPhone,
      tenancyEndDate: resolvedTenancyId === tenancyId ? tenancyEndDate : null,
      renewalDecision: resolvedTenancyId === tenancyId ? renewalDecision : null,
      previousKwh: rd?.previousKwh?.toString() ?? null,
      currentKwh: rd?.currentKwh?.toString() ?? null,
      amount: rd?.amount?.toString() ?? null,
      ratePerKwh: rate.ratePerKwh,
      rateConfigured: rate.rateConfigured,
      rental: rate.rental,
      rentalBillingState: rate.rentalBillingState ?? null,
      deposit: rate.deposit ?? null,
      depositBillingState: rate.depositBillingState ?? null,
      // P5: per-reading audit surface. No reading ⇒ both null. A null/foreign
      // updatedById resolves to null (never a raw UUID, never a throw).
      updatedAt: rd?.updatedAt ? rd.updatedAt.toISOString() : null,
      lastEditedByName: rd?.updatedById ? (nameById.get(rd.updatedById) ?? null) : null,
      // PAX-per-room (review Finding 1): numberOfPax must correspond to `tenancyId` — the tenancy
      // the bill uses AND the Setting drawer's pax editor writes to. The passed `numberOfPax` is the
      // ACTIVE tenancy's headcount; when a reading pins a DIFFERENT tenancy (mid-period turnover
      // before re-keying), its pax is unknown at this layer → null. NEVER surface the active
      // tenancy's pax against a snapshot tenancy: that made the editor display one tenancy's value
      // while writing to another.
      numberOfPax: resolvedTenancyId === tenancyId ? numberOfPax : null,
    };
  };

  // Real rooms first, in the batched listing order (getGridService orders by
  // listingType then id — stable Master/Medium/Small display).
  const roomRows = rooms.map((room) =>
    toSub(room.listingId, room.tenancyId, room.partyId ?? null, room.partyName, room.partyPhone, room, room.numberOfPax, room.tenancyEndDate ?? null, room.renewalDecision ?? null),
  );

  // Reading-only rows: a reading whose listingId is not a current room. Party
  // name from the partyId snapshot, org-scoped (a foreign id resolves to null).
  const roomListingIds = new Set(rooms.map((r) => r.listingId));
  const orphanReadings = readings.filter((r) => !roomListingIds.has(r.listingId));
  const orphanNames = new Map<string, string>();
  const orphanPhones = new Map<string, string | null>();
  const orphanPartyIds = orphanReadings.map((r) => r.partyId).filter((p): p is string => p !== null);
  if (orphanPartyIds.length > 0) {
    const parties = await prisma.party.findMany({
      where: { id: { in: orphanPartyIds }, organizationId: orgId },
      select: { id: true, displayName: true, primaryPhone: true },
    });
    for (const p of parties) { orphanNames.set(p.id, p.displayName); orphanPhones.set(p.id, p.primaryPhone); }
  }
  const orphanRows = orphanReadings.map((r) =>
    toSub(
      r.listingId, r.tenancyId, r.partyId,
      r.partyId ? (orphanNames.get(r.partyId) ?? null) : null,
      r.partyId ? (orphanPhones.get(r.partyId) ?? null) : null,
      ORPHAN_RATE_DEFAULTS, null, null, null,
    ),
  );

  return { subRows: [...roomRows, ...orphanRows], warnings: negWarnings };
}

export async function toGridRowDto(
  orgId: string,
  apt: { id: string; unitCode: string; propertyId: string; propertyName: string; propertyCode: string; listingMode: string },
  rooms: RoomTenancyInfo[],
  entry: GridEntryWithChildren | null,
  preview: ComputeResult | null,
  previewError: { code: string; detail?: unknown } | null,
  warnings: RowWarning[],
  priors: Date[],
  bearerConfig: BearerConfigDtoInput | null,
  nameById: ReadonlyMap<string, string> = new Map(),
  // Task 8: precomputed by getGridService's batched entriesWithPaidInvoice (never a
  // per-row query here — the read path is strictly N+1-free). Defaults false for the
  // pure-mapper unit tests / an unsaved entry.
  hasPaidInvoice = false,
  // Rule 2: precomputed by getGridService's batched billedApartmentIds (provenance-based,
  // never a per-row query). Defaults false for the pure-mapper unit tests.
  billed = false,
  // R9: precomputed by getGridService's batched recurringTotalsByEntry. Undefined → zero totals
  // (pure-mapper unit tests / an unsaved entry / flag dark).
  recurring?: GridRecurringTotals,
  // R6 refined: precomputed by getGridService's batched governingScalarByApartment. Undefined →
  // ungoverned (editable cell) — the pure-mapper / flag-dark default.
  governed?: GovernedScalars,
  // Owner name (display + search): precomputed by getGridService's batched ownerById
  // (never a per-row query). Undefined/null → no owner resolved (pure-mapper default).
  owner?: { id?: string; name: string | null } | null,
  // Precomputed by getGridService's batched settlementByEntry. Undefined → nothing billed
  // (pure-mapper unit tests / an unsaved entry): every bucket "none", row "none".
  settlement?: GridSettlementDto,
  // R13: precomputed by getGridService's batched pendingGraduationEntryIds. Defaults false
  // for the pure-mapper unit tests, an unsaved entry, and a flag-dark read.
  graduationPending = false,
  managementFee: GridManagementFeeDto = {
    nonSst: "0.00",
    sst: "0.00",
    total: "0.00",
    configured: false,
    status: "not_configured",
    reason: "Management fee setup required",
  },
  agreementFees: GridRowDto["agreementFees"] = {
    new: { amount: "0.00", outstanding: "0.00", state: "none" },
    renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
  },
  ownerMoney: { payout: string; topUp: string } = { payout: "0.00", topUp: "0.00" },
  pendingTenancyCharges: PendingTenancyChargeDto[] = [],
  billUtilityPlan: GridBillUtilityPlanDto = emptyGridBillUtilityPlan(),
): Promise<GridRowDto> {
  const { subRows, warnings: negWarnings } = await subRowsFor(orgId, rooms, entry, nameById);
  return {
    apartmentId: apt.id,
    unitCode: apt.unitCode,
    propertyId: apt.propertyId,
    propertyName: apt.propertyName,
    propertyCode: apt.propertyCode,
    ownerName: owner?.name ?? null,
    ownerPartyId: owner?.id ?? null,
    entryId: entry?.id ?? null,
    preview,
    previewError,
    billUtilityPlan,
    warnings: [...warnings, ...negWarnings],
    subRows,
    billedAt: entry?.billedAt?.toISOString() ?? null,
    invoicedAt: entry?.invoicedAt?.toISOString() ?? null,
    paymentStatus: entry?.paymentStatus ?? "unpaid",
    hasPaidInvoice,
    hasUnbilledChanges: deriveHasUnbilledChanges(entry),
    settlement: settlement ?? { status: "none", cells: emptySettlementCells(), rooms: {}, expenseLines: {} },
    // R13: money arrived but the tax invoice is missing. The money is correct; only the
    // document is absent, and it is repairable via POST /entries/:entryId/graduate-retry.
    graduationPending,
    billed,
    billRevision: entry?.billRevision ?? 0,
    priorMonths: await priorStripsFor(orgId, apt.id, priors),
    entry: toEntryDto(entry, nameById),
    bearerConfig: toBearerConfigDto(bearerConfig, apt.listingMode),
    isWholeUnit: apt.listingMode === "WHOLE",
    expenses: toExpensesDto(entry?.expenses ?? []),
    managementFee,
    agreementFees,
    pendingTenancyCharges,
    ownerPayout: ownerMoney.payout,
    ownerTopUpRequired: ownerMoney.topUp,
    recurring: toRecurringDto(recurring),
    cleaningRecurringLocked: governed?.CLEANING.governed ?? false,
    wifiRecurringLocked: governed?.WIFI.governed ?? false,
    // Projections of the ONE governed record — never a second source of truth.
    cleaningRecurringAmount: governed?.CLEANING.amount ?? null,
    wifiRecurringAmount: governed?.WIFI.amount ?? null,
    scalarRecurring: governed ?? noGovernedScalars(),
    attachments: toAttachmentBriefs(entry?.attachments ?? []),
  };
}

/**
 * Rule 2: the set of apartments whose unit-month carries a LIVE grid-workflow invoice —
 * derived from the invoices THIS workflow generated (chargeNumber `GRIDUTIL-${ym}-` /
 * `GRIDOWN-${ym}-` / `GRIDEXP-${ym}-`, the reliable structural provenance for BOTH linked
 * and legacy null-sourced charges), NOT from `gridEntry.invoicedAt`. Batched for the WHOLE
 * page in a bounded, constant number of queries — never per-row (same N+1 discipline as the
 * paid check). `listingToApt` maps every room on the page → its apartment id.
 *
 * FIX 4 (final review): `chargeType` includes "expense" alongside "utility" — an apartment
 * billed via ONLY an expense charge (spec bill-expenses, e.g. a vacant unit with no
 * utilities) must still tag `billed: true`. No extra flag gate is needed: a `chargeType:
 * "expense"` charge only ever exists when ENABLE_BILL_EXPENSES_AS_CHARGES minted it
 * (mintExpenseChargesTx's own gate), so this query is naturally inert flag-off. The same
 * live-status + ISSUED-document filters below apply uniformly to both types, so a
 * void/credited-only expense charge still doesn't mis-tag the apartment.
 */
async function billedApartmentIds(
  orgId: string,
  listingToApt: ReadonlyMap<string, string>,
  periodMonth: Date,
  ym: string,
): Promise<Set<string>> {
  const billed = new Set<string>();
  const listingIds = [...listingToApt.keys()];
  if (listingIds.length === 0) return billed;
  const charges = await prisma.charge.findMany({
    where: {
      organizationId: orgId,
      // "aircond"/GRIDAC- included so an apartment billed ONLY for private submeter
      // electricity (every pooled share 0 — the clamped-leftover case) still tags billed.
      chargeType: { in: ["utility", "expense", "aircond"] },
      billingMonth: periodMonth,
      unitId: { in: listingIds },
      status: { notIn: ["void", "credited"] },
      OR: [
        { chargeNumber: { startsWith: `GRIDUTIL-${ym}-` } },
        { chargeNumber: { startsWith: `GRIDOWN-${ym}-` } },
        { chargeNumber: { startsWith: `GRIDEXP-${ym}-` } },
        { chargeNumber: { startsWith: `GRIDAC-${ym}-` } },
      ],
    },
    select: { id: true, unitId: true },
  });
  if (charges.length === 0) return billed;
  const liveLines = await prisma.billingDocumentLine.findMany({
    where: {
      chargeId: { in: charges.map((c) => c.id) },
      // "proforma" included: a whole-unit tenancy bearing all utilities produces NO owner
      // charge, so under the flag its ONLY document is the PI- and the row would render
      // neither the Billed nor the Re-Billed badge after a successful Bill.
      // "proforma" gated on the flag: inert for an org that never enabled it, but NOT
      // inert after a flip-OFF, where a stale PI- would keep tagging the month billed.
      document: {
        organizationId: orgId,
        documentStatus: "ISSUED",
        docType: { in: isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES") ? ["invoice", "debit_note", "proforma"] : ["invoice", "debit_note"] },
      },
    },
    select: { chargeId: true },
  });
  const liveChargeIds = new Set(liveLines.map((l) => l.chargeId).filter((x): x is string => !!x));
  for (const c of charges) {
    if (c.unitId && liveChargeIds.has(c.id)) {
      const apt = listingToApt.get(c.unitId);
      if (apt) billed.add(apt);
    }
  }
  return billed;
}

/**
 * READ path. Each apartment's shaping + computeAllocation runs in its OWN try/catch:
 * a failure degrades THAT apartment to `preview: null` plus a structured
 * `previewError`, and every other apartment still renders. It never 500s and never
 * surfaces a compute failure as an HTTP error status. Creates nothing. Touches no
 * UnitUtilityBill.
 */
export async function getGridService(
  session: { orgId: string },
  q: { period?: string; propertyId?: string; months: number },
): Promise<Result<{
  period: string;
  periods: string[];
  rows: GridRowDto[];
  billingCapabilities: { billingDocuments: boolean; expensesAsCharges: boolean };
}>> {
  // The confirmation surface must describe the same feature world as the API that
  // performs Bill. Vite flags can drift during a rolling deploy, so publish the
  // server's effective capabilities with every grid snapshot.
  const billingDocuments = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const expensesAsCharges = billingDocuments && isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES");
  const periods = await resolvePeriods(session.orgId, q.period, q.months); // latest-first
  const apartments = await prisma.apartment.findMany({
    where: { organizationId: session.orgId, ...(q.propertyId ? { propertyId: q.propertyId } : {}) },
    orderBy: { unitCode: "asc" },
    // Fix (final review): join the parent property for `propertyName` — the
    // Categorize filter needs a display name, not just the raw propertyId.
    //
    // Real rooms + active tenancy, batch-loaded ONCE (never a per-apartment
    // query in the loop below — same N+1 discipline as the bearer configs).
    // This is the tenant-tracker's source of truth (Listing → active Tenancy →
    // tenantParty.displayName): it makes every unit show its rooms + tenant
    // names + editable meter cells immediately, instead of only after a reading
    // is keyed. It feeds ONLY the display-side subRows — the money preview below
    // still computes from entry.readings (frozen), untouched.
    include: {
      property: { select: { name: true, propertyCode: true } },
      listings: {
        orderBy: [{ listingType: "asc" }, { id: "asc" }],
        select: {
          id: true,
          // Owner (display + search): every room of an apartment shares one owner.
          ownerPartyId: true,
          // Exact Bill owner resolution ignores archived listings. The utility
          // plan needs the same representative-listing eligibility without a query.
          listingStatus: true,
          // PERIOD-scoped, not `status: "active"`. Reading a past month must show the
          // tenant who lived there THEN; selecting by current status priced the month
          // against a tenancy that may not overlap it at all (a replacement starting
          // next month prorates to RM0.00) and hid the month's real occupant once
          // their tenancy ended. May legitimately return TWO rows for a handover month.
          tenancies: {
            where: tenancyPeriodWhere(periods[0]),
            orderBy: [{ startDate: "desc" }, { id: "asc" }],
            select: {
              id: true,
              numberOfPax: true,
              monthlyRentAmount: true,
              firstMonthIsCommission: true,
              startDate: true,
              endDate: true,
              status: true,
              renewalDecision: true,
              tenantParty: { select: { id: true, displayName: true, primaryPhone: true } },
            },
          },
        },
      },
    },
  });

  // Task 10: batch-load bearer configs ONCE — never a per-apartment query inside
  // the loop below (would reintroduce an N+1 the plan explicitly forbids here).
  const configs = await prisma.unitBillsBearerConfig.findMany({
    where: { organizationId: session.orgId, apartmentId: { in: apartments.map((a) => a.id) } },
  });
  const configByApt = new Map(configs.map((c) => [c.apartmentId, c]));

  // Task 5: batch-derive each room's rate + each occupied room's rental ONCE for
  // the WHOLE page — across every apartment, not per-apartment inside the loop
  // below (same N+1 discipline as bearer configs above; a query-spy test asserts
  // a bounded, constant count regardless of page size). Read-only (`findMany`):
  // resolveRoomRatesBatch NEVER creates an AircondMeter row. Rental is keyed on
  // each room's CURRENT active tenancy (l.tenancies[0].id below), matching
  // RoomTenancyInfo's own tenancyId — not a reading's snapshot.
  const allListingIds = apartments.flatMap((a) => a.listings.map((l) => l.id));
  const allTenancyIds = apartments.flatMap((a) => a.listings.flatMap((l) => l.tenancies.map((t) => t.id)));
  const apartmentIdByListing = new Map(apartments.flatMap((apt) => apt.listings.map((listing) => [listing.id, apt.id] as const)));
  const pendingTenancyChargesByApt = new Map<string, PendingTenancyChargeDto[]>();
  const addPendingTenancyCharge = (apartmentId: string, item: PendingTenancyChargeDto | null): void => {
    if (!item) return;
    const items = pendingTenancyChargesByApt.get(apartmentId) ?? [];
    items.push(item);
    pendingTenancyChargesByApt.set(apartmentId, items);
  };

  // Confirm Bill approves these exact draft invoice types after the grid row succeeds,
  // and approval posts every attached DRAFT charge. Load the same invoice rail once for
  // the whole page so the dialog includes carpark and manually attached extras too; do
  // not re-filter by chargeType/billingMonth or issue one query per apartment.
  const pendingTenantDraftInvoices = apartments.length > 0
    ? await prisma.invoice.findMany({
        where: {
          organizationId: session.orgId,
          invoiceType: { in: [...BILLABLE_TENANCY_INVOICE_TYPES] },
          status: "draft",
          periodMonth: periods[0],
          tenancy: { unit: { apartmentId: { in: apartments.map((apt) => apt.id) } } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          invoiceType: true,
          status: true,
          tenancy: { select: { unit: { select: { apartmentId: true } } } },
          charges: {
            where: { organizationId: session.orgId, status: "draft" },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              chargeNumber: true,
              parentChargeId: true,
              description: true,
              chargeType: true,
              status: true,
              amount: true,
              sstRate: true,
              commercialPurpose: true,
              fundedBy: true,
              revenueRecognition: true,
              settlementRecipient: true,
              nonBillable: true,
              category: { select: { name: true, family: true, defaultSstRate: true } },
              party: { select: { displayName: true } },
            },
          },
        },
      })
    : [];

  // issueDocumentsForChargesTx resolves categoryId first, then this shared
  // chargeType→category-code fallback. Mirror that fallback in one bounded lookup so
  // descriptions and category-default SST match the document that will be issued.
  const fallbackCategoryCodes = [...new Set(pendingTenantDraftInvoices.flatMap((invoice) =>
    invoice.charges.flatMap((charge) => {
      if (charge.category) return [];
      const code = CHARGE_TYPE_TO_CATEGORY_CODE[charge.chargeType];
      return code ? [code] : [];
    }),
  ))];
  const fallbackCategories = fallbackCategoryCodes.length > 0
    ? await prisma.chargeCategory.findMany({
        where: { organizationId: session.orgId, code: { in: fallbackCategoryCodes } },
        select: { code: true, name: true, family: true, defaultSstRate: true },
      })
    : [];
  const fallbackCategoryByCode = new Map(fallbackCategories.map((category) => [category.code, category]));
  const rentReclassificationEnabled = isPhase2FlagEnabled("ENABLE_PHASE2_RENT_RECLASSIFICATION");

  for (const invoice of pendingTenantDraftInvoices) {
    const apartmentId = invoice.tenancy?.unit.apartmentId;
    if (!apartmentId) continue;
    const chargeById = new Map(invoice.charges.map((charge) => [charge.id, charge]));
    const taxChildByParentId = new Map<string, (typeof invoice.charges)[number]>();
    const taxChildIds = new Set(invoice.charges.flatMap((charge) => {
      if (!charge.parentChargeId) return [];
      const parent = chargeById.get(charge.parentChargeId);
      if (!parent || charge.chargeNumber !== `${parent.chargeNumber}-SST`) return [];
      taxChildByParentId.set(parent.id, charge);
      return [charge.id];
    }));
    for (const charge of invoice.charges) {
      // The base row already previews its SST through sstRate. The linked
      // payable sibling exists for settlement only and must not appear as a
      // second Confirm Bill item.
      if (taxChildIds.has(charge.id)) continue;
      const fallbackCode = charge.category ? null : CHARGE_TYPE_TO_CATEGORY_CODE[charge.chargeType];
      const category = charge.category ?? (fallbackCode ? fallbackCategoryByCode.get(fallbackCode) : null);
      let payer: "tenant" | "owner" = category?.family === "owner_income" ? "owner" : "tenant";
      if (rentReclassificationEnabled) {
        const routed = resolveDocumentClassification({
          commercialPurpose: charge.commercialPurpose,
          fundedBy: charge.fundedBy,
          revenueRecognition: charge.revenueRecognition,
          settlementRecipient: charge.settlementRecipient,
          nonBillable: charge.nonBillable,
        } as Parameters<typeof resolveDocumentClassification>[0]);
        if (routed.kind !== "NEEDS_ECONOMIC_CLASSIFICATION" && routed.kind !== "NO_DOCUMENT") {
          payer = routed.commercialDocumentType === "OWNER_SERVICE_INVOICE" ? "owner" : "tenant";
        }
      }
      addPendingTenancyCharge(apartmentId, toPendingTenancyChargeDto({
        id: charge.id,
        description: charge.description,
        chargeType: charge.chargeType,
        chargeStatus: charge.status,
        amount: charge.amount,
        sstRate: charge.sstRate,
        categoryName: category?.name ?? null,
        categorySstRate: category?.defaultSstRate ?? null,
        exactSstAmount: taxChildByParentId.get(charge.id)?.amount ?? null,
        payer,
        invoiceStatus: invoice.status,
        invoiceType: invoice.invoiceType,
        tenantName: charge.party.displayName,
      }));
    }
  }

  const rateByListing = await resolveRoomRatesBatch(prisma, session.orgId, allListingIds);
  const rentFactsByTenancy = await resolveRoomRentFactsBatch(
    prisma,
    session.orgId,
    allTenancyIds,
    periods[0],
  );
  const rentByTenancy = new Map(
    [...rentFactsByTenancy].map(([id, value]) => [id, value.billedRent]),
  );

  // Rental and deposit documents are independent from the bills-grid Bill button.
  // Load their real charge/document/payment states in one bounded query so their
  // cell colours agree with what the tenant sees as outstanding.
  const tenantDocumentCharges = allTenancyIds.length
    ? await prisma.charge.findMany({
        where: {
          organizationId: session.orgId,
          tenancyId: { in: allTenancyIds },
          billingMonth: periods[0],
          // First-month rent may be economically reclassified as KAEN's
          // letting commission, but it is still the tenant's rental document
          // for this cell. Excluding it left a real saved draft colourless.
          chargeType: { in: ["rent", "letting_commission", "security_deposit", "utility_deposit"] },
          status: { notIn: ["void", "credited"] },
        },
        select: {
          tenancyId: true,
          amount: true,
          outstandingAmount: true,
          status: true,
          chargeType: true,
          invoice: { select: { status: true } },
        },
      })
    : [];
  const depositsByTenancy = new Map<string, { amount: number; state: "saved" | "billed-unpaid" | "paid" }>();
  const rentalStatesByTenancy = new Map<string, "saved" | "billed-unpaid" | "paid">();
  for (const charge of tenantDocumentCharges) {
    if (!charge.tenancyId) continue;
    const paid = Number(charge.outstandingAmount) <= 0 || charge.status === "paid";
    const issued = charge.invoice?.status != null && charge.invoice.status !== "draft";
    const lineState: "saved" | "billed-unpaid" | "paid" = paid ? "paid" : issued ? "billed-unpaid" : "saved";
    const rank = { saved: 0, "billed-unpaid": 1, paid: 2 } as const;
    if (charge.chargeType === "rent" || charge.chargeType === "letting_commission") {
      const previous = rentalStatesByTenancy.get(charge.tenancyId);
      const state = previous && rank[previous] < rank[lineState] ? previous : lineState;
      rentalStatesByTenancy.set(charge.tenancyId, state);
      continue;
    }
    const previous = depositsByTenancy.get(charge.tenancyId);
    const amount = (previous?.amount ?? 0) + Number(charge.amount);
    // Mixed legs use the least-complete state: the cell only turns cyan when both are paid.
    const state = previous && rank[previous.state] < rank[lineState] ? previous.state : lineState;
    depositsByTenancy.set(charge.tenancyId, { amount, state });
  }

  // Tenancy agreement fees are created by the tenancy workflow rather than by
  // UnitBillsGridEntry. Join them by listing so this operational grid still shows
  // the exact tenant charge, payment state and month in which it is due.
  const agreementFeeCharges = allListingIds.length
    ? await prisma.charge.findMany({
        where: {
          organizationId: session.orgId,
          unitId: { in: allListingIds },
          billingMonth: periods[0],
          chargeType: { in: ["tenancy_agreement_fee", "renewal_fee"] },
          status: { notIn: ["void", "credited"] },
        },
        select: {
          unitId: true,
          chargeType: true,
          amount: true,
          outstandingAmount: true,
          status: true,
          invoice: { select: { status: true } },
        },
      })
    : [];
  type AgreementFeeState = "none" | "saved" | "billed-unpaid" | "paid";
  type AgreementFeeLine = { amount: number; outstanding: number; state: AgreementFeeState };
  type AgreementFeePair = { new: AgreementFeeLine; renewal: AgreementFeeLine };
  const emptyAgreementLine = (): AgreementFeeLine => ({ amount: 0, outstanding: 0, state: "none" });
  const agreementFeesByApt = new Map<string, AgreementFeePair>();
  const agreementRank: Record<AgreementFeeState, number> = { none: 0, paid: 1, "billed-unpaid": 2, saved: 3 };
  for (const charge of agreementFeeCharges) {
    if (!charge.unitId) continue;
    const apartmentId = apartmentIdByListing.get(charge.unitId);
    if (!apartmentId) continue;
    const pair = agreementFeesByApt.get(apartmentId) ?? { new: emptyAgreementLine(), renewal: emptyAgreementLine() };
    const key = charge.chargeType === "renewal_fee" ? "renewal" : "new";
    const issued = charge.invoice?.status != null && charge.invoice.status !== "draft";
    // A deliberately saved RM0 TA charge is still an unbilled action, not a
    // payment. Zero outstanding alone must not turn it green before an invoice
    // has actually been issued; otherwise an admin mistake becomes invisible.
    const paid = issued && (Number(charge.outstandingAmount) <= 0 || charge.status === "paid");
    const state: AgreementFeeState = !issued ? "saved" : paid ? "paid" : "billed-unpaid";
    const current = pair[key];
    pair[key] = {
      amount: current.amount + Number(charge.amount),
      outstanding: current.outstanding + Number(charge.outstandingAmount),
      // A group is only green when every charge is paid; any unissued draft wins.
      state: agreementRank[state] > agreementRank[current.state] ? state : current.state,
    };
    agreementFeesByApt.set(apartmentId, pair);
  }

  // P5: build the read path in TWO passes so editor names resolve N+1-FREE.
  // Pass 1 (this loop) does the per-apartment compute + room shaping EXACTLY as
  // before (shapeUtilityPool / computeAllocation are untouched; the entry fetch
  // and pax lookup that used to run per-apartment inside this loop — via a
  // per-apartment findUnique + buildGridRoomsFromEntry, now removed — are
  // batched ABOVE the loop instead) and collects the interim result. Then ONE
  // user.findMany resolves every editor id on the page → nameById. Pass 2
  // builds the DTOs.
  type Interim = {
    apt: (typeof apartments)[number];
    rooms: RoomTenancyInfo[];
    entry: GridEntryWithChildren | null;
    preview: ComputeResult | null;
    previewError: { code: string; detail?: unknown } | null;
    billUtilityPlan: GridBillUtilityPlanDto;
    warnings: RowWarning[];
  };
  // Batch EVERY apartment's entry for the period in ONE query (was a per-apartment
  // findUnique inside the loop — an N+1 of ~N serial round-trips; measured 1218ms for
  // 62 apts vs 59ms batched). Keyed by apartmentId for O(1) lookup below.
  const entries = await prisma.unitBillsGridEntry.findMany({
    where: { organizationId: session.orgId, periodMonth: periods[0], apartmentId: { in: apartments.map((a) => a.id) } },
    include: { readings: true, expenses: { where: { status: "active" } }, attachments: true },
  });
  const entryByApt = new Map(entries.map((e) => [e.apartmentId, e]));
  // The Bill transaction resolves this singleton once per SUBSIDY row. The read
  // path needs the same value, but page-wide: one bounded query, never N queries.
  const hasSubsidyEntry = billingDocuments && apartments.some((apt) => {
    const entry = entryByApt.get(apt.id);
    return entry != null
      && apt.listingMode !== "WHOLE"
      && (
        apt.partitionBillingMode === "SUBSIDY"
        || entry.subsidyPolicySnapshot === "legacy_per_pax"
        || (entry.billedAt != null && entry.subsidyPolicySnapshot == null)
      );
  });
  const subsidyPerPax = hasSubsidyEntry
    ? Number((await prisma.utilityBillingConfig.findFirst({
        where: { organizationId: session.orgId },
        select: { subsidyPerPax: true },
      }))?.subsidyPerPax ?? 50)
    : 0;
  // Batch pax for ALL entries' readings in ONE query (was per-entry inside the loop).
  // roomsFromReadings is pure and consumes this shared map.
  const paxByTenancy = await paxByTenancyFor(prisma, session.orgId, entries.flatMap((e) => e.readings));
  const interim: Interim[] = [];
  for (const apt of apartments) {
    const entry = entryByApt.get(apt.id) ?? null;

    let preview: ComputeResult | null = null;
    let previewError: { code: string; detail?: unknown } | null = null;
    let billUtilityPlan = emptyGridBillUtilityPlan();
    let warnings: RowWarning[] = [];
    if (entry) {
      const built = roomsFromReadings(entry.readings, paxByTenancy);
      warnings = built.warnings; // surfaced even if either compute later throws
      try {
        const shaped = shapeUtilityPool({
          tnbPattern: entry.tnbPattern as never, airPattern: entry.airPattern as never,
          rawTnbTotal: num(entry.tnbTotalRaw), rawAirSelangor: num(entry.airSelangorRaw), rooms: built.rooms,
        });
        preview = computeAllocation("no_subsidy", 0,
          { tnbTotal: shaped.tnbTotal, airSelangor: shaped.airSelangor, indahWater: 0, wifi: num(entry.wifi), cleaning: num(entry.cleaning), maintenance: num(entry.maintenanceFee) },
          built.rooms,
          { indahWater: "owner", cleaning: entry.cleaningBearer as never, wifi: entry.wifiBearer as never, maintenance: entry.maintenanceFeeBearer as never },
          // PARTITIONED units allow the private aircond Σ to exceed TNB (excess = owner
          // profit); only a WHOLE unit surfaces AIRCON_EXCEEDS_TNB in the preview.
          apt.listingMode !== "WHOLE");
      } catch (e) {
        if (e instanceof ComputeError) previewError = { code: e.code };
        else if (e instanceof ShapeError) previewError = { code: e.code, detail: e.detail };
        else previewError = { code: "PREVIEW_FAILED" };
      }

      // WHOLE Bill resolves ONE apartment-wide majority occupant, not one per
      // listing. The apartment query above already loaded the same period-scoped
      // candidate set, so flatten + reuse primaryTenancyForPeriod with zero I/O.
      const wholePrimary = apt.listingMode === "WHOLE"
        ? primaryTenancyForPeriod(
            apt.listings.flatMap((listing) => listing.tenancies.map((tenancy) => ({
              ...tenancy,
              unitId: listing.id,
              partyId: tenancy.tenantParty.id,
            }))),
            periods[0],
          )
        : null;
      const activeTenancy = wholePrimary
        ? { tenancyId: wholePrimary.id, partyId: wholePrimary.partyId, unitId: wholePrimary.unitId }
        : null;
      const ownerListingId = apt.listings.find(
        (listing) => listing.listingStatus !== "archived" && listing.ownerPartyId != null,
      )?.id ?? null;
      try {
        const resolvedSubsidy = resolveGridTnbSubsidy({
          isWholeUnit: apt.listingMode === "WHOLE",
          partitionBillingMode: apt.partitionBillingMode,
          subsidyPerPax,
          apartmentTnbSubsidyCap: apt.tnbSubsidyCapMonthly == null
            ? null
            : Number(apt.tnbSubsidyCapMonthly),
          billedAt: entry.billedAt,
          subsidyPolicySnapshot: entry.subsidyPolicySnapshot,
          tnbSubsidyCapSnapshot: entry.tnbSubsidyCapSnapshot == null
            ? null
            : Number(entry.tnbSubsidyCapSnapshot),
        });
        billUtilityPlan = buildGridBillUtilityPlan({
          entry,
          rawRooms: built.rooms,
          isWholeUnit: apt.listingMode === "WHOLE",
          partitionBillingMode: apt.partitionBillingMode,
          activeTenancy,
          subsidyPerPax,
          resolvedSubsidy,
          billingDocuments,
          ownerListingId,
        });
      } catch (error) {
        billUtilityPlan = emptyGridBillUtilityPlan(
          "unavailable",
          null,
          error instanceof ComputeError ? error.code : "PREVIEW_FAILED",
        );
      }
    }
    // One room per Listing; its active tenant (latest-first) supplies the name
    // + tenancyId. A vacant room (no active tenancy) is null/null but still shown.
    // Task 5: rate/rental are looked up from the page-wide batch maps above —
    // NO per-room query here. rateByListing is a TOTAL map (lazy 0.6/false
    // default baked in by resolveRoomRatesBatch); rentByTenancy is PARTIAL
    // (absent ⇒ null rental, e.g. a vacant room with no active tenancy).
    const rooms: RoomTenancyInfo[] = apt.listings.map((l) => {
      // `l.tenancies` is already period-scoped. The row can display only ONE tenant,
      // so show the month's majority occupant — but the RENTAL cell sums EVERY
      // overlapping tenancy's prorated share, or a handover month would report only
      // the incoming tenant's days and silently under-state the unit's rent.
      const occupants = l.tenancies;
      const primary = primaryTenancyForPeriod(occupants, periods[0]);
      const rate = rateByListing.get(l.id) ?? { ratePerKwh: 0.6, configured: false };
      const rentalTotal = occupants.reduce((sum, t) => sum + Number(rentByTenancy.get(t.id) ?? 0), 0);
      const rentalStates = occupants
        .map((t) => rentalStatesByTenancy.get(t.id))
        .filter((state): state is NonNullable<typeof state> => state != null);
      const rentalState = rentalStates.length === 0
        ? null
        : rentalStates.some((state) => state === "saved")
          ? "saved" as const
          : rentalStates.some((state) => state === "billed-unpaid")
            ? "billed-unpaid" as const
            : "paid" as const;
      const depositLines = occupants
        .map((t) => depositsByTenancy.get(t.id))
        .filter((d): d is NonNullable<typeof d> => d != null);
      const depositTotal = depositLines.reduce((sum, d) => sum + d.amount, 0);
      const depositState = depositLines.length === 0
        ? null
        : depositLines.some((d) => d.state === "saved")
          ? "saved" as const
          : depositLines.some((d) => d.state === "billed-unpaid")
            ? "billed-unpaid" as const
            : "paid" as const;
      return {
        listingId: l.id,
        tenancyId: primary?.id ?? null,
        partyId: primary?.tenantParty.id ?? null,
        partyName: primary?.tenantParty.displayName ?? null,
        partyPhone: primary?.tenantParty.primaryPhone ?? null,
        tenancyEndDate: primary?.endDate?.toISOString() ?? null,
        renewalDecision: (primary?.renewalDecision as "pending" | "contacted" | "renew" | "not_renew" | undefined) ?? null,
        ratePerKwh: rate.ratePerKwh.toFixed(4),
        rateConfigured: rate.configured,
        rental: primary ? rentalTotal.toFixed(2) : null,
        rentalBillingState: rentalState,
        deposit: depositLines.length > 0 ? depositTotal.toFixed(2) : null,
        depositBillingState: depositState,
        numberOfPax: primary?.numberOfPax ?? null,
      };
    });
    interim.push({ apt, rooms, entry, preview, previewError, billUtilityPlan, warnings });
  }

  // P5: resolve every last-editor fullName in ONE org-scoped query for the WHOLE
  // page (entry.updatedById + each reading.updatedById), NOT one per apartment/row.
  // organizationId bounds it so a foreign editor id never resolves; a null/missing
  // id simply is not in the map ⇒ lastEditedByName null downstream (never a UUID).
  const editorIds = new Set<string>();
  for (const it of interim) {
    if (it.entry?.updatedById) editorIds.add(it.entry.updatedById);
    for (const rd of it.entry?.readings ?? []) if (rd.updatedById) editorIds.add(rd.updatedById);
  }
  const editors = editorIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...editorIds] }, organizationId: session.orgId },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById: ReadonlyMap<string, string> = new Map(editors.map((u) => [u.id, u.fullName]));

  // Owner name/phone per apartment (display + search). Every room of one apartment shares one
  // owner (Listing.ownerPartyId) — resolve the FIRST owned listing's owner, then batch-load all
  // owner Parties for the WHOLE page in ONE query (N+1-free, same discipline as nameById above).
  // Display-only: never feeds the money preview.
  const ownerPartyIdByApt = new Map<string, string>();
  for (const apt of apartments) {
    const owned = apt.listings.find((l) => l.ownerPartyId);
    if (owned?.ownerPartyId) ownerPartyIdByApt.set(apt.id, owned.ownerPartyId);
  }
  const ownerParties = ownerPartyIdByApt.size
    ? await prisma.party.findMany({
        where: { id: { in: [...new Set(ownerPartyIdByApt.values())] }, organizationId: session.orgId },
        select: { id: true, displayName: true },
      })
    : [];
  const ownerById = new Map(ownerParties.map((p) => [p.id, { id: p.id, name: p.displayName }]));

  // Task 8: batch the net-of-reversal paid check for the WHOLE page in a bounded,
  // constant number of queries — NEVER a per-row query inside the loop below (same
  // N+1 discipline as the bearer configs / rate / rental batches above).
  const paidEntryIds = await entriesWithPaidInvoice(
    session.orgId,
    interim.map((it) => it.entry?.id).filter((x): x is string => !!x),
  );

  // Batched READ-TIME settlement for the row badge + per-cell tick. Same bounded,
  // constant query count as the paid check above — never per-row.
  const settlementByEntryId = await settlementByEntry(
    session.orgId,
    interim.map((it) => it.entry?.id).filter((x): x is string => !!x),
  );

  // R13: entries whose money settled against a proforma line that never got its tax
  // invoice. Batched exactly like the settlement pass above — never per row. Flag-gated,
  // because with the proforma dark no entry can ever be in this state and the three
  // queries would be pure waste on every grid read.
  const graduationPendingIds = isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")
    ? await pendingGraduationEntryIds(
        prisma,
        session.orgId,
        interim.map((it) => it.entry?.id).filter((x): x is string => !!x),
      )
    : new Set<string>();

  // Rule 2: batched Billed-tag set (provenance-based, whole page). Map every page room →
  // its apartment, then resolve which apartments have a live grid-workflow invoice.
  const listingToApt = new Map<string, string>();
  for (const it of interim) for (const r of it.rooms) listingToApt.set(r.listingId, it.apt.id);
  const ym = `${periods[0].getUTCFullYear()}${String(periods[0].getUTCMonth() + 1).padStart(2, "0")}`;
  const billedApts = await billedApartmentIds(session.orgId, listingToApt, periods[0], ym);

  // R9: batched CUSTOM recurring totals for the whole page (one query, N+1-free).
  const recurringByEntry = await recurringTotalsByEntry(
    session.orgId,
    interim.map((it) => it.entry?.id).filter((x): x is string => !!x),
  );
  // R9 display fix: rows whose month entry does NOT exist yet project their totals from the
  // saved definitions (same resolver materialize-on-open uses) — a recurring charge saved in
  // Settings shows immediately instead of only after an unrelated save opens the period.
  const projectedRecurringByApt = await projectedRecurringTotalsByApartment(
    session.orgId,
    interim.filter((it) => !it.entry).map((it) => it.apt.id),
    periods[0],
  );
  // R6 refined: batched cleaning/wifi "governed by an enabled recurring def" at the primary period
  // (drives per-cell read-only vs editable). Keyed by apartment so it applies even to unopened rows.
  const governedByApt = await governingScalarByApartment(session.orgId, interim.map((it) => it.apt.id), periods[0]);

  // Management fee belongs to the owner ledger, not the editable utility entry.
  // Read it once for the whole page and keep fee base separate from SST: only the
  // base is company income; SST is collected for the government.
  const managementFeeLines = await prisma.ownerLedgerEntry.findMany({
    where: {
      organizationId: session.orgId,
      statementMonth: periods[0],
      apartmentId: { in: interim.map((it) => it.apt.id) },
      status: "active",
      direction: "expense",
      category: "management_fee",
    },
    select: { apartmentId: true, amount: true, sstAmount: true },
  });
  type ManagementFeeView = {
    nonSst: number;
    sst: number;
    configured: boolean;
    status: GridManagementFeeStatus;
    reason: string | null;
  };
  const managementFeeByApt = new Map<string, ManagementFeeView>();
  for (const line of managementFeeLines) {
    if (!line.apartmentId) continue;
    // An existing ledger line remains authoritative even if its old config has
    // since been retired. It proves that the unit-month was configured when the
    // fee was generated, so it must not be mislabelled as "Not configured".
    const current = managementFeeByApt.get(line.apartmentId) ?? {
      nonSst: 0,
      sst: 0,
      configured: true,
      status: "posted" as const,
      reason: null,
    };
    current.nonSst += Number(line.amount);
    current.sst += Number(line.sstAmount ?? 0);
    managementFeeByApt.set(line.apartmentId, current);
  }
  const ownerIds = [...new Set(ownerPartyIdByApt.values())];
  const feeConfigs = ownerIds.length ? await prisma.managementFeeConfig.findMany({
    where: { organizationId: session.orgId, ownerPartyId: { in: ownerIds }, isActive: true },
  }) : [];
  const billingYm = iso(periods[0]).slice(0, 7);
  for (const it of interim) {
    // A posted ledger amount is authoritative. Before rent is collected/posted, show the
    // amount that SHOULD be charged from the same config + fee engine used by owner billing.
    if (managementFeeByApt.has(it.apt.id)) continue;
    const ownerPartyId = ownerPartyIdByApt.get(it.apt.id);
    if (!ownerPartyId) continue;
    const eligible = feeConfigs.filter((cfg) =>
      cfg.ownerPartyId === ownerPartyId &&
      (cfg.apartmentId === it.apt.id ||
        (cfg.apartmentId === null && (cfg.propertyId === null || cfg.propertyId === it.apt.propertyId))) &&
      effectiveWindowOverlapsBillingMonth(billingYm, {
        effectiveFrom: cfg.effectiveFrom,
        effectiveTo: cfg.effectiveTo,
      }));
    const cfg = eligible.find((row) => row.apartmentId === it.apt.id)
      ?? eligible.find((row) => row.apartmentId === null && row.propertyId === it.apt.propertyId)
      ?? eligible.find((row) => row.apartmentId === null && row.propertyId === null);
    if (!cfg) continue;
    const firstChargeMonth = cfg.firstChargeMonth == null
      ? null
      : new Date(Date.UTC(cfg.firstChargeMonth.getUTCFullYear(), cfg.firstChargeMonth.getUTCMonth(), 1));
    if (firstChargeMonth && periods[0].getTime() < firstChargeMonth.getTime()) {
      managementFeeByApt.set(it.apt.id, {
        nonSst: 0,
        sst: 0,
        configured: true,
        status: "before_first_charge",
        reason: `Starts in ${firstChargeMonth.toLocaleDateString("en-MY", { month: "short", year: "numeric", timeZone: "UTC" })}`,
      });
      continue;
    }
    const inFreePeriod = isInFreePeriod(billingYm, {
      freePeriodStart: cfg.freePeriodStart?.toISOString() ?? null,
      freePeriodEnd: cfg.freePeriodEnd?.toISOString() ?? null,
    });
    if (inFreePeriod) {
      managementFeeByApt.set(it.apt.id, {
        nonSst: 0,
        sst: 0,
        configured: true,
        status: "free_period",
        reason: "No management fee — free period",
      });
      continue;
    }

    const rent = computeManagementFeeRentBase(
      it.apt.listings.flatMap((listing) => listing.tenancies.map((tenancy) => {
        const facts = rentFactsByTenancy.get(tenancy.id);
        return {
          billedRent: facts?.billedRent ?? "0.00",
          fullMonthRent: facts?.fullMonthRent ?? tenancy.monthlyRentAmount.toString(),
          numberOfPax: tenancy.numberOfPax,
          isCommissionMonth: isCommissionMonth(tenancy, periods[0]),
          fullyCollected: rentalStatesByTenancy.get(tenancy.id) === "paid",
        };
      })),
      cfg.paxDeductionPerPerson?.toString() ?? null,
    );

    if (rent.reason === "commission_month") {
      managementFeeByApt.set(it.apt.id, {
        nonSst: 0,
        sst: 0,
        configured: true,
        status: "commission_month",
        reason: "No management fee — first full-month rent retained as commission",
      });
      continue;
    }
    if (rent.reason === "no_rental_income") {
      managementFeeByApt.set(it.apt.id, {
        nonSst: 0,
        sst: 0,
        configured: true,
        status: "no_rental_income",
        reason: "No management fee — no owner rental income",
      });
      continue;
    }

    const useFirstChargeOverride =
      firstChargeMonth != null &&
      cfg.firstChargeBaseAmount != null &&
      firstChargeMonth.getTime() === periods[0].getTime();
    const fee = computeManagementFee(
      useFirstChargeOverride
        ? { feeType: "fixed", feeValue: cfg.firstChargeBaseAmount!.toString(), capAmount: null, sstPercent: "8" }
        : {
            feeType: cfg.feeType as "percent" | "fixed" | "cap",
            feeValue: cfg.feeValue.toString(),
            capAmount: cfg.capAmount?.toString() ?? null,
            sstPercent: "8",
          },
      rent.eligibleRentBase,
    );
    managementFeeByApt.set(it.apt.id, {
      nonSst: Number(fee.base),
      sst: Number(fee.sst),
      configured: true,
      status: rent.fullyCollected ? "chargeable" : "awaiting_rent",
      reason: rent.fullyCollected
        ? null
        : "Forecast only — collect the tenant's rent before charging the owner",
    });
  }

  const unitMonthMoney = await prisma.unitMonthLedger.findMany({
    where: {
      organizationId: session.orgId,
      periodMonth: periods[0],
      apartmentId: { in: interim.map((it) => it.apt.id) },
    },
    select: { apartmentId: true, netPayoutC: true, ownerTopUpC: true },
  });
  const ownerMoneyByApt = new Map(
    unitMonthMoney.map((row) => [
      row.apartmentId,
      { payout: (row.netPayoutC / 100).toFixed(2), topUp: (row.ownerTopUpC / 100).toFixed(2) },
    ]),
  );

  const rows: GridRowDto[] = [];
  for (const it of interim) {
    rows.push(
      await toGridRowDto(
        session.orgId,
        {
          id: it.apt.id,
          unitCode: it.apt.unitCode,
          propertyId: it.apt.propertyId,
          propertyName: it.apt.property.name,
          propertyCode: it.apt.property.propertyCode,
          listingMode: it.apt.listingMode,
        },
        it.rooms,
        it.entry, it.preview, it.previewError, it.warnings, periods.slice(1), configByApt.get(it.apt.id) ?? null, nameById,
        it.entry ? paidEntryIds.has(it.entry.id) : false,
        billedApts.has(it.apt.id),
        it.entry ? recurringByEntry.get(it.entry.id) : projectedRecurringByApt.get(it.apt.id),
        governedByApt.get(it.apt.id) ?? noGovernedScalars(),
        (() => { const pid = ownerPartyIdByApt.get(it.apt.id); return pid ? (ownerById.get(pid) ?? null) : null; })(),
        it.entry ? settlementByEntryId.get(it.entry.id) : undefined,
        it.entry ? graduationPendingIds.has(it.entry.id) : false,
        (() => {
          const fee = managementFeeByApt.get(it.apt.id) ?? {
            nonSst: 0,
            sst: 0,
            configured: false,
            status: "not_configured" as const,
            reason: "Management fee setup required",
          };
          return {
            nonSst: fee.nonSst.toFixed(2),
            sst: fee.sst.toFixed(2),
            total: (fee.nonSst + fee.sst).toFixed(2),
            configured: fee.configured,
            status: fee.status,
            reason: fee.reason,
          };
        })(),
        (() => {
          const fees = agreementFeesByApt.get(it.apt.id) ?? { new: emptyAgreementLine(), renewal: emptyAgreementLine() };
          return {
            new: { amount: fees.new.amount.toFixed(2), outstanding: fees.new.outstanding.toFixed(2), state: fees.new.state },
            renewal: { amount: fees.renewal.amount.toFixed(2), outstanding: fees.renewal.outstanding.toFixed(2), state: fees.renewal.state },
          };
        })(),
        ownerMoneyByApt.get(it.apt.id) ?? { payout: "0.00", topUp: "0.00" },
        pendingTenancyChargesByApt.get(it.apt.id) ?? [],
        it.billUtilityPlan,
      ),
    );
  }
  return ok({
    period: iso(periods[0]),
    periods: periods.map(iso),
    rows,
    billingCapabilities: { billingDocuments, expensesAsCharges },
  });
}

// ─────────────────────────────── READINGS ───────────────────────────────────

/**
 * PURE-ish (one read query) derivation of a single reading's `previousKwh` +
 * `amount`, mirroring meter/service.ts's own resolution (lines ~195-207):
 *  • previousKwh: explicit wire value → else the PRIOR PERIOD's GridMeterReading.
 *    currentKwh for this exact (org, apartment, listing) → else 0 (first-month
 *    parity: no prior reading ⇒ previous 0 ⇒ amount = current * rate).
 *  • amount = round2(round2(currentKwh - previousKwh) * ratePerKwh). If
 *    `currentKwh` is absent, there is nothing to derive yet: amount stays null,
 *    but previousKwh is still resolved/persisted.
 *  • Negative consumption (current < previous) CLAMPS amount to 0 — the reading
 *    still saves, HTTP 200. This is a DELIBERATE divergence from meter/service.ts,
 *    which 422s on negative consumption: the grid's NEGATIVE_CONSUMPTION warning
 *    is a READ-path concern (Task 5), not a save-time rejection.
 *  • The derived amount is a SNAPSHOT: it is persisted at save time and a later
 *    AircondMeter rate change does not re-price an already-saved reading (the
 *    read path only ever echoes the stored `amount` column — see subRowsFor).
 */
async function deriveReadingAmount(
  tx: Prisma.TransactionClient, orgId: string, apartmentId: string, periodMonth: Date,
  listingId: string, previousRaw: string | null, currentRaw: string | null, rate: number,
): Promise<{ previousKwh: string | null; amount: string | null; negative: boolean }> {
  let prev = previousRaw != null ? Number(previousRaw) : null;
  if (prev == null) {
    const prior = await tx.gridMeterReading.findFirst({
      where: { organizationId: orgId, apartmentId, listingId, periodMonth: { lt: periodMonth }, currentKwh: { not: null } },
      orderBy: { periodMonth: "desc" }, select: { currentKwh: true },
    });
    prev = prior?.currentKwh != null ? Number(prior.currentKwh.toString()) : 0;
  }
  const cur = currentRaw != null ? Number(currentRaw) : null;
  if (cur == null) return { previousKwh: prev.toFixed(2), amount: null, negative: false };
  const consumption = round2(cur - prev);
  const negative = consumption < 0;
  const amount = round2((negative ? 0 : consumption) * rate);
  return { previousKwh: prev.toFixed(2), amount: amount.toFixed(2), negative };
}

/**
 * Upsert one GridMeterReading per (entry, room). The room is `listingId`
 * (= Listing.id), mirroring MeterReading.unitId. The key is
 * `organizationId_entryId_listingId`, NOT `…_tenancyId` (Foundation CORRECTION 2):
 * tenancyId is nullable (does not compile as a compound-unique member) and two
 * VACANT rooms share `null` (would collapse). `listingId` is NOT NULL and unique
 * per (entry, room).
 *
 * ⚠️ The Invariant-9 sibling-COUNT check is NOT redundant with the unique index and
 * MUST NOT be deleted: the index says "≤1 reading per entry per ROOM"; Invariant 9
 * says "≤1 reading TOTAL when the apartment's `listingMode` is WHOLE" (Task 4 —
 * re-based off Apartment.listingMode; PARTITIONED apartments are unconstrained).
 */
export async function saveReadingsService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  body: { period: string; readings: Array<{ listingId: string; tenancyId: string | null; partyId: string | null; previousKwh: string | null; currentKwh: string | null; expectedUpdatedAt?: string }> },
): Promise<Result<{ results: Array<{ listingId: string; tenancyId: string | null; id: string; updatedAt: string; outcome: "saved" | "stale" }> }>> {
  const periodMonth = toMonth(body.period);
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");

  return await prisma.$transaction(async (tx) => {
    // Mirror the expenses discipline (resolveExpenseParty / createExpensesService):
    // the wire is UNTRUSTED. Pre-validate EVERY reading BEFORE any write (and before
    // getOrCreateEntry, so a rejection mints no stray parent entry either):
    //  • listingId must be a room in THIS org — a foreign/nonexistent id → 400.
    //  • tenancyId, if present, is resolved ORG-SCOPED to its Tenancy; a foreign/
    //    nonexistent id → 404 (never 403 — a 403 would confirm the row exists).
    //  • partyId is SERVER-DERIVED from that Tenancy (tenantPartyId) and NEVER taken
    //    from the wire; a vacant room (tenancyId null) persists partyId null.
    // Any failure rejects the whole request and writes NOTHING.
    const derived: Array<{ r: (typeof body.readings)[number]; partyId: string | null }> = [];
    for (const r of body.readings) {
      const listing = await tx.listing.findFirst({ where: { id: r.listingId, organizationId: session.orgId }, select: { id: true } });
      if (!listing) return err(400, "LISTING_NOT_FOUND");
      const party = await resolveExpenseParty(tx, session.orgId, r.tenancyId ?? undefined);
      if (!party.ok) return err(404, "TENANCY_NOT_FOUND");
      derived.push({ r, partyId: party.partyId });
    }

    const entry = await getOrCreateEntry(tx, { orgId: session.orgId, apartmentId, periodMonth, actorUserId: session.userId });
    // Billed entry is LOCKED for Save only once FULLY PAID (same rule as saveEntryService):
    // a billed-but-unpaid reading stays amendable for a pre-re-Bill correction.
    if (entry.billedAt && entry.paymentStatus === "paid") return err(409, "ENTRY_LOCKED");

    // Invariant 9 (service-layer, conditional count), re-based on Apartment.listingMode
    // (Task 4) — NOT `entry.rental` (dropped from the wire; server-derived elsewhere).
    // Count DISTINCT rooms with a reading after this write; >1 on a WHOLE apartment
    // is illegal. PARTITIONED apartments are unconstrained.
    const apartment = await tx.apartment.findFirst({
      where: { id: apartmentId, organizationId: session.orgId }, select: { listingMode: true },
    });
    if (apartment?.listingMode === "WHOLE") {
      const rooms = new Set(body.readings.map((r) => r.listingId));
      const existing = await tx.gridMeterReading.findMany({ where: { organizationId: session.orgId, entryId: entry.id }, select: { listingId: true } });
      for (const e of existing) rooms.add(e.listingId);
      if (rooms.size > 1) return err(400, "WHOLE_UNIT_MULTI_READING");
    }

    // Amount is SERVER-DERIVED (Task 3) — never taken from the wire (there is no wire
    // `amount` field anymore; the Zod schema dropped it). Batch-load each requested
    // room's rate once (N+1-free), mirroring meter/service.ts's own rate resolution
    // (resolveRoomRatesBatch: active-or-retired AircondMeter row, else the 0.6 lazy
    // default).
    const rateByListing = await resolveRoomRatesBatch(tx, session.orgId, derived.map((d) => d.r.listingId));

    const priorReadings = await tx.gridMeterReading.findMany({
      where: { organizationId: session.orgId, entryId: entry.id, listingId: { in: derived.map((d) => d.r.listingId) } },
    });
    const priorReadingByListing = new Map(priorReadings.map((reading) => [reading.listingId, reading]));
    const readingAuditChanges: Array<{ listingId: string; field: string; before: string; after: string }> = [];
    const results = [];
    for (const { r, partyId } of derived) {
      const rate = rateByListing.get(r.listingId)?.ratePerKwh ?? 0.6;
      const d = await deriveReadingAmount(tx, session.orgId, apartmentId, periodMonth, r.listingId, r.previousKwh, r.currentKwh, rate);
      const write = {
        tenancyId: r.tenancyId, partyId,   // partyId is SERVER-DERIVED above; the wire partyId is discarded
        previousKwh: d.previousKwh, currentKwh: r.currentKwh, amount: d.amount,
        updatedById: session.userId, // P5: last admin editor of this reading
      };
      const prior = priorReadingByListing.get(r.listingId);
      for (const field of ["previousKwh", "currentKwh", "amount"] as const) {
        const before = String(prior?.[field] ?? "");
        const after = String(write[field] ?? "");
        if (before !== after) readingAuditChanges.push({ listingId: r.listingId, field, before, after });
      }
      let row;
      try {
        row = await tx.gridMeterReading.upsert({
          where: { organizationId_entryId_listingId: { organizationId: session.orgId, entryId: entry.id, listingId: r.listingId } },
          update: write,
          create: { organizationId: session.orgId, entryId: entry.id, apartmentId, periodMonth, listingId: r.listingId, createdBy: session.userId, ...write },
        });
      } catch (e) {
        // Race backstop: two concurrent upserts for the same (entry, listingId) can
        // both SELECT-miss and both INSERT. The loser hits the @@unique → P2002.
        // Resolve to the winner's row and apply our update; never surface a 500.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
        row = await tx.gridMeterReading.update({
          where: { organizationId_entryId_listingId: { organizationId: session.orgId, entryId: entry.id, listingId: r.listingId } },
          data: write,
        });
      }
      results.push({ listingId: r.listingId, tenancyId: r.tenancyId, id: row.id, updatedAt: row.updatedAt.toISOString(), outcome: "saved" as const });
    }

    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.reading.save", entityType: "UnitBillsGridEntry", entityId: entry.id,
      diff: { changes: readingAuditChanges }, meta: { count: results.length },
    });
    return ok({ results });
  });
}

// ─────────────────────────────── BEARER CONFIG ──────────────────────────────

export interface BearerConfigDto {
  apartmentId: string;
  tnbPattern: string; airPattern: string;
  cleaningBearer: string; wifiBearer: string; maintenanceFeeBearer: string;
  cleaningRecurringAmount: string;
  isLocked: boolean;
  updatedAt: string | null;
  /** charge-nature gate (2026-07-27): unit-default scalar nature. null = undecided ⇒ a billable
   * scalar fails the Bill closed (`nature_unresolved`) instead of silently booking as profit. */
  cleaningNature: string | null;
  wifiNature: string | null;
  /** True when an ENABLED recurring definition governs that scalar for the CURRENT billing month:
   * the Recurring-charges editor owns amount+bearer+nature, so the drawer shows its own controls
   * read-only rather than presenting a second source of truth that silently loses. */
  cleaningGoverned: boolean;
  wifiGoverned: boolean;
  /** Per-kind recurring state for ALL scalar kinds — the tick + amount the Setting drawer renders.
   *  cleaningGoverned/wifiGoverned above are legacy PROJECTIONS of this same record (kept so the
   *  grid's existing consumers are untouched), never a second source of truth. */
  scalarRecurring: Record<ScalarRecurringKind, ScalarRecurringState>;
}

/**
 * GET config. Missing config → 200 with the seeded defaults + `isLocked:false`.
 * Creates NOTHING (a GET must never mint a config row).
 */
export async function getBearerConfigService(
  session: { orgId: string },
  apartmentId: string,
): Promise<Result<BearerConfigDto>> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");
  const cfg = await prisma.unitBillsBearerConfig.findUnique({
    where: { organizationId_apartmentId: { organizationId: session.orgId, apartmentId } },
  });
  // charge-nature gate: governance for the CURRENT billing month decides whether the drawer's new
  // WiFi/Cleaning controls are editable here or owned by the Recurring-charges editor. Resolved on
  // the read so the drawer never has to guess (and never offers a control whose value would lose).
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  const governedMap = await governingScalarByApartment(session.orgId, [apartmentId], currentBillingMonthUTC(org.timezone));
  const governed = governedMap.get(apartmentId) ?? noGovernedScalars();
  if (!cfg) {
    // Unit-type defaults — the READ half of the pair whose CREATE half is
    // resolveBearerConfig (repository.ts). Both go through `bearerDefaultsFor`, so what
    // the drawer shows for a never-configured unit is exactly what gets written and
    // snapshotted the moment that unit's first period is opened.
    return ok({
      apartmentId, ...bearerDefaultsFor(apt.listingMode),
      cleaningRecurringAmount: DEFAULT_CLEANING_RECURRING_AMOUNT, isLocked: false, updatedAt: null,
      cleaningNature: null, wifiNature: null,
      cleaningGoverned: governed.CLEANING.governed, wifiGoverned: governed.WIFI.governed, scalarRecurring: governed,
    });
  }
  return ok({
    apartmentId, tnbPattern: cfg.tnbPattern, airPattern: cfg.airPattern,
    cleaningBearer: cfg.cleaningBearer, wifiBearer: cfg.wifiBearer, maintenanceFeeBearer: cfg.maintenanceFeeBearer,
    cleaningRecurringAmount: cfg.cleaningRecurringAmount.toFixed(2), isLocked: cfg.isLocked,
    updatedAt: cfg.updatedAt.toISOString(),
    cleaningNature: cfg.cleaningNature, wifiNature: cfg.wifiNature,
    cleaningGoverned: governed.CLEANING.governed, wifiGoverned: governed.WIFI.governed, scalarRecurring: governed,
  });
}

/**
 * PUT config. Set-once: a locked config with `unlock:false` → `409 BEARER_LOCKED`.
 * `unlock:true` records BOTH `grid.bearer.unlock` (only when there is a locked
 * config to unlock) AND `grid.bearer.set`, in ONE transaction. A successful set
 * (re-)locks the config.
 */
export async function setBearerConfigService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  body: {
    tnbPattern: string; airPattern: string; cleaningBearer: string; wifiBearer: string; maintenanceFeeBearer: string;
    cleaningRecurringAmount: string; unlock: boolean;
    cleaningNature?: string | null; wifiNature?: string | null;
  },
): Promise<Result<{ id: string; isLocked: boolean; updatedAt: string; syncedEntries: number; lockedEntries: number }>> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  // Cleaning and WiFi no longer have tenant-side grid columns. Keep accepting the
  // legacy wire vocabulary so a rolling/stale client does not fail its entire Save,
  // but canonicalise every NEW config write to Owner server-side. Exceptional tenant
  // recovery is created through Tenant Expenses instead. Existing paid/frozen period
  // snapshots remain protected by the sync guards below and are never rewritten here.
  const cleaningBearer = "owner";
  const wifiBearer = "owner";
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.unitBillsBearerConfig.findUnique({
        where: { organizationId_apartmentId: { organizationId: session.orgId, apartmentId } },
      });
      if (existing?.isLocked && !body.unlock) return err(409, "BEARER_LOCKED");

      if (body.unlock && existing?.isLocked) {
        await recordAudit(tx, {
          organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
          action: "grid.bearer.unlock", entityType: "UnitBillsBearerConfig", entityId: existing.id,
        });
      }

      const data = {
        tnbPattern: body.tnbPattern, airPattern: body.airPattern,
        cleaningBearer, wifiBearer, maintenanceFeeBearer: body.maintenanceFeeBearer,
        cleaningRecurringAmount: body.cleaningRecurringAmount,
        isLocked: true, lockedAt: new Date(), lockedBy: session.userId,
        // charge-nature gate: `undefined` (field absent on the wire) leaves the stored value
        // untouched — Prisma skips undefined — so a pre-gate client that never sends these can
        // never blank a decided nature. An explicit null DOES clear it back to undecided.
        ...(body.cleaningNature !== undefined ? { cleaningNature: body.cleaningNature } : {}),
        ...(body.wifiNature !== undefined ? { wifiNature: body.wifiNature } : {}),
      };
      const cfg = await tx.unitBillsBearerConfig.upsert({
        where: { organizationId_apartmentId: { organizationId: session.orgId, apartmentId } },
        update: data,
        create: { organizationId: session.orgId, apartmentId, ...data },
      });

      // PUSH the new settings onto every SYNCABLE period from this month forward. Without this
      // the drawer would be write-only for months whose entry already exists: materialize-on-open
      // is create-only (repository.ts `if (existing) return existing`), so a config edit would
      // never reach the open month the admin is actually about to bill.
      //
      // Scope (user rule 2026-08-06: "if unbilled, let the admin change ANYTIME; if billed, say
      // so — never pretend"):
      //  • ALL five settings — cleaning/WiFi bearer+nature AND tnb/air patterns. The old
      //    "patterns snapshot onto FUTURE periods only" carve-out is retired: it made the
      //    drawer a silent no-op for the very month the admin was looking at.
      //  • only periods >= the current billing month — never a closed/back month.
      //  • a billed-but-unpaid month IS syncable here. This matches updateLinesService below:
      //    changing who bears a charge before money arrives is a normal re-bill workflow. The
      //    previous use of isPeriodSnapshotSyncable rejected every billed/invoiced month, so the
      //    drawer saved "Water = Owner" into the unit config while the month on screen silently
      //    kept its old Tenant snapshot. Only received money or a frozen owner report makes the
      //    month immutable. Skipped months are counted and surfaced to the drawer.
      //
      // BEARER IS NO LONGER GOVERNANCE-GATED (2026-07-27). A recurring definition fixes the
      // AMOUNT only; who bears the cost stays this drawer's Owner/Tenant control, which remains
      // editable while the tick is on. One writer per fact: amount = recurring def, bearer = here
      // (materialize-on-open reads bearer from THIS config too — repository.ts getOrCreateEntry).
      const fromMonth = currentBillingMonthUTC(org.timezone);
      const openEntries = await tx.unitBillsGridEntry.findMany({
        where: { organizationId: session.orgId, apartmentId, periodMonth: { gte: fromMonth } },
        select: { id: true, billedAt: true, invoicedAt: true, apartmentId: true, periodMonth: true },
      });
      let syncedEntries = 0;
      let lockedEntries = 0;
      for (const e of openEntries) {
        const lockedByMoney = await entryHasActivePayment(tx, session.orgId, e.id);
        const lockedByOwnerReport = await ownerStatementFrozen(
          tx, session.orgId, e.apartmentId, e.periodMonth,
        );
        if (lockedByMoney || lockedByOwnerReport) {
          lockedEntries += 1;
          continue;
        }
        const patch = {
          tnbPattern: body.tnbPattern,
          airPattern: body.airPattern,
          cleaningBearer,
          ...(body.cleaningNature !== undefined ? { cleaningNature: body.cleaningNature } : {}),
          wifiBearer,
          ...(body.wifiNature !== undefined ? { wifiNature: body.wifiNature } : {}),
          maintenanceFeeBearer: body.maintenanceFeeBearer,
        };
        await tx.unitBillsGridEntry.update({ where: { id: e.id }, data: { ...patch, updatedById: session.userId } });
        syncedEntries += 1;
      }

      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.bearer.set", entityType: "UnitBillsBearerConfig", entityId: cfg.id,
        diff: { ...data, syncedEntries, lockedEntries } as never,
      });
      return ok({ id: cfg.id, isLocked: cfg.isLocked, updatedAt: cfg.updatedAt.toISOString(), syncedEntries, lockedEntries });
    });
  } catch {
    return err(500, "SET_BEARER_FAILED");
  }
}

// ─────────────────────────────── EXPENSES ───────────────────────────────────

/**
 * Resolve the client's `tenancyId` to the server-derived `GridExpense.partyId`
 * snapshot. Tenancy's party column is `tenantPartyId` (there is no Tenancy.partyId).
 * A tenancyId outside session.orgId is a 404, never a 403 (a 403 would confirm the
 * row exists): Tenancy.unitId/propertyId FKs carry no organization predicate, so a
 * tenancy row CAN reference another org's unit — this org check is that boundary.
 */
async function resolveExpenseParty(
  tx: Prisma.TransactionClient, orgId: string, tenancyId: string | undefined,
): Promise<{ ok: true; partyId: string | null } | { ok: false }> {
  if (!tenancyId) return { ok: true, partyId: null }; // owner-side / unattributed expense
  const tenancy = await tx.tenancy.findFirst({ where: { id: tenancyId, organizationId: orgId }, select: { tenantPartyId: true } });
  if (!tenancy) return { ok: false };
  return { ok: true, partyId: tenancy.tenantPartyId };
}

export async function createExpensesService(
  session: { orgId: string; userId: string; role: string },
  body: { apartmentId: string; billingMonth: string; bearer: "tenant" | "owner"; tenancyId?: string; items: Array<{ description: string; amount: string; withSST: boolean; chargeCategoryId?: string | null; nature?: "expense" | "profit"; actualCost?: string | null; costVendor?: string | null; costPaymentStatus?: "unpaid" | "partial" | "paid"; costPaymentDate?: string | null; costPaymentAccount?: string | null; costNotes?: string | null }> },
): Promise<Result<{ ids: string[]; total: string }>> {
  const periodMonth = toMonth(body.billingMonth); // WIRE `billingMonth` → COLUMN `periodMonth`
  const apt = await prisma.apartment.findFirst({ where: { id: body.apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");

  return await prisma.$transaction(async (tx) => {
    // BEFORE getOrCreateEntry: a bad tenancyId must not leave a stray parent entry.
    const party = await resolveExpenseParty(tx, session.orgId, body.tenancyId);
    if (!party.ok) return err(404, "TENANCY_NOT_FOUND");

    // Prevention (bill-expenses): tenant-bearer expense MUST attribute to a tenancy so Bill-time mint
    // always has a tenant. Historical null rows handled by mint's resolveTenantExpenseTenancy fallback.
    // Owner expenses stay unattributed (tenancyId null) by design. Flag-gated to match the mint that
    // consumes it — flag-OFF envs keep the pre-feature create behaviour (no new 400, review #5).
    if (isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES") && body.bearer === "tenant" && !body.tenancyId) return err(400, "EXPENSE_TENANCY_REQUIRED");

    // ALSO before getOrCreateEntry, and before ANY item is written: an interactive
    // Prisma transaction commits normally on a plain `return` — it only rolls back
    // if the callback THROWS. So a rejection here must happen before getOrCreateEntry
    // ever runs, or a bad chargeCategoryId on a FRESH apartment/period would leave a
    // stray UnitBillsGridEntry behind (caught by this task's own integration test).
    // Checking ALL items up front (not inline in the write loop) also guarantees a
    // cross-org id on item[2] never lets item[0]/item[1] get written first.
    for (const item of body.items) {
      if (!item.chargeCategoryId) continue;
      const cat = await tx.chargeCategory.findFirst({ where: { id: item.chargeCategoryId, organizationId: session.orgId }, select: { id: true, active: true } });
      if (!cat) return err(400, "CATEGORY_NOT_FOUND");
      // Review fix (T4): mirrors billing.service.ts:280's CATEGORY_INACTIVE precedent
      // for the same "attach a category to a money line" shape — a deactivated
      // category must not become newly attachable.
      if (!cat.active) return err(400, "CATEGORY_INACTIVE");
    }

    const entry = await getOrCreateEntry(tx, { orgId: session.orgId, apartmentId: body.apartmentId, periodMonth, actorUserId: session.userId });
    // Locked by MONEY, not by Bill: a late expense on a billed-but-UNPAID month is
    // recorded here and picked up by the re-Bill (its component-aware no-op detector
    // already folds in expenseComponents, so the row reports rebill_confirmation_required
    // rather than already_billed). Stays immediately after getOrCreateEntry and before the
    // create loop, so a rejection still leaves no stray expense rows behind.
    //
    // A line that does not exist yet cannot have been paid, and with partial re-Bill the
    // month can carry it onto a fresh proforma. Flag OFF the entry-wide refusal stays:
    // re-Bill would reject the whole month and the new line would strand with no route to
    // any document — the stranding failure the 2026-08-17 spec rejected Approach A over.
    if (!isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")
        && await entryHasActivePayment(tx, session.orgId, entry.id)) return err(409, "ENTRY_LOCKED");

    const ids: string[] = [];
    for (const item of body.items) {
      const row = await tx.gridExpense.create({
        data: {
          organizationId: session.orgId, entryId: entry.id, apartmentId: body.apartmentId, periodMonth,
          bearer: body.bearer, description: item.description, amount: item.amount, withSST: item.withSST,
          partyId: party.partyId,   // server-derived; never accepted from the wire
          tenancyId: body.tenancyId ?? null, // source tenancy snapshot (bill-expenses R3) — drives co-grouping
          chargeCategoryId: item.chargeCategoryId ?? null,
          // gridexpense-nature (Task B2): per-row Expense/Profit choice, persisted as-is —
          // NOT gated on ENABLE_CHARGE_NATURE_ROUTING here (see createExpensesSchema's
          // doc-comment); an omitted value stays NULL, which mint/issue-grouped/owner-ledger
          // treat identically to "expense" (Task B1).
          nature: item.nature ?? null,
          actualCost: item.actualCost ?? null,
          costVendor: item.costVendor?.trim() || null,
          costPaymentStatus: item.costPaymentStatus ?? "unpaid",
          costPaymentDate: item.costPaymentDate ? new Date(`${item.costPaymentDate}T00:00:00.000Z`) : null,
          costPaymentAccount: item.costPaymentAccount?.trim() || null,
          costNotes: item.costNotes?.trim() || null,
          createdBy: session.userId,
        },
      });
      ids.push(row.id);
    }
    const total = body.items.reduce((s, i) => s + Number(i.amount), 0).toFixed(2);

    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.expense.create", entityType: "UnitBillsGridEntry", entityId: entry.id,
      meta: { bearer: body.bearer, count: ids.length, total, partyId: party.partyId },
    });
    return ok({ ids, total }, 201);
  });
}

export interface ExpenseListItem {
  id: string; apartmentId: string; periodMonth: string; bearer: string;
  description: string; amount: string; withSST: boolean; partyId: string | null; status: string; updatedAt: string;
  actualCost: string | null;
  costVendor: string | null;
  costPaymentStatus: string;
  costPaymentDate: string | null;
  costPaymentAccount: string | null;
  costNotes: string | null;
  // Item 1 (R1/R7): the owner's display name resolved from `partyId`, ORG-SCOPED.
  // null when partyId is null or unresolvable in-org (never leaks a foreign name).
  partyName: string | null;
  chargeCategoryId: string | null;
  category: { name: string; profitExpense: string | null } | null;
  // Task B2: the row's own Expense/Profit routing choice (Task B1's column), surfaced so
  // the admin UI's per-row selector can seed from server truth instead of always
  // resetting to the default on reload. null = legacy/unset (routes as Expense).
  nature: string | null;
  /**
   * This LINE's own settlement state, from GridSettlementDto.expenseLines.
   *
   * The dialog edits lines individually but had no per-line payment signal, so it
   * rendered live inputs over a line the server had already frozen — the admin typed,
   * saved, and got a 409 ENTRY_LOCKED they could not have predicted. "none" for a line
   * that has never been billed (no charge yet), which is the editable default.
   */
  settlement: SettlementState;
}

/**
 * List expenses. Totals sum `status === "active"` ONLY (void lines are shown but
 * never counted). `q` searches party name / phone (via the `partyId` snapshot) and
 * unit code.
 */
export async function listExpensesService(
  session: { orgId: string },
  q: { apartmentId?: string; billingMonth?: string; bearer?: string; q?: string },
  options: { includeInternalCosts?: boolean } = {},
): Promise<Result<{ items: ExpenseListItem[]; total: string }>> {
  const where: Prisma.GridExpenseWhereInput = { organizationId: session.orgId };
  if (q.apartmentId) where.apartmentId = q.apartmentId;
  if (q.billingMonth) where.periodMonth = toMonth(q.billingMonth);
  if (q.bearer) where.bearer = q.bearer;

  const term = q.q?.trim();
  if (term) {
    const [parties, apts] = await Promise.all([
      prisma.party.findMany({
        where: { organizationId: session.orgId, OR: [{ displayName: { contains: term, mode: "insensitive" } }, { primaryPhone: { contains: term } }] },
        select: { id: true },
      }),
      prisma.apartment.findMany({ where: { organizationId: session.orgId, unitCode: { contains: term, mode: "insensitive" } }, select: { id: true } }),
    ]);
    where.OR = [
      { partyId: { in: parties.map((p) => p.id) } },
      { apartmentId: { in: apts.map((a) => a.id) } },
    ];
  }

  // The `chargeCategory` relation is org-scoped IN THE INCLUDE too (not just at
  // write time): `chargeCategoryId` carries no organization predicate of its own
  // (mirrors the `partyId` snapshot precedent, service.integration.test.ts's
  // "FINDING 2 (read)"), so a tampered/legacy row pointing at a foreign org's
  // category would otherwise leak that category's real name into this org's list.
  const rows = await prisma.gridExpense.findMany({
    where, orderBy: { createdAt: "desc" },
    include: { chargeCategory: { where: { organizationId: session.orgId }, select: { name: true, profitExpense: true } } },
  });
  const total = rows.filter((r) => r.status === "active").reduce((s, r) => s + num(r.amount), 0).toFixed(2);

  // Item 1 (R1/R7): resolve each line's owner name from its `partyId` snapshot in
  // ONE batched, ORG-SCOPED query (no per-line N+1). A foreign-org / unresolvable
  // id is simply absent from the map ⇒ `partyName: null`, never leaking a name —
  // the same defence-in-depth as the org-scoped `chargeCategory` include above and
  // subRowsFor's orphan-party resolution.
  const ownerPartyIds = [...new Set(rows.map((r) => r.partyId).filter((p): p is string => p !== null))];
  const ownerNames = new Map<string, string>();
  if (ownerPartyIds.length > 0) {
    const parties = await prisma.party.findMany({
      where: { id: { in: ownerPartyIds }, organizationId: session.orgId },
      select: { id: true, displayName: true },
    });
    for (const p of parties) ownerNames.set(p.id, p.displayName);
  }

  // Per-LINE settlement, one batched call for the whole page (same no-N+1 discipline as
  // `ownerNames` above). `settlementByEntry` is already org-scoped and already filters to
  // charges on a LIVE (ISSUED) document with cash-backed allocations, so this adds a
  // grain rather than a second definition of "paid". A line with no charge yet is simply
  // absent from the map ⇒ "none" ⇒ editable, which is the correct default for a line
  // that has never been billed.
  const entryIds = [...new Set(rows.map((r) => r.entryId).filter((e): e is string => e !== null))];
  const settlementByExpenseId = new Map<string, SettlementState>();
  if (entryIds.length > 0) {
    for (const dto of (await settlementByEntry(session.orgId, entryIds)).values()) {
      for (const [expenseId, state] of Object.entries(dto.expenseLines)) {
        settlementByExpenseId.set(expenseId, state);
      }
    }
  }

  const items: ExpenseListItem[] = rows.map((r) => ({
    id: r.id, apartmentId: r.apartmentId, periodMonth: iso(r.periodMonth), bearer: r.bearer,
    description: r.description, amount: r.amount.toFixed(2), withSST: r.withSST, partyId: r.partyId, status: r.status,
    // Internal cost and margin data is a separate permission from customer-facing
    // billing. Returning nulls (rather than relying on the UI to hide controls)
    // prevents a billing-only user from reading supplier/payee data in DevTools.
    actualCost: options.includeInternalCosts ? (r.actualCost?.toFixed(2) ?? null) : null,
    costVendor: options.includeInternalCosts ? r.costVendor : null,
    costPaymentStatus: options.includeInternalCosts ? r.costPaymentStatus : "unpaid",
    costPaymentDate: options.includeInternalCosts && r.costPaymentDate ? iso(r.costPaymentDate) : null,
    costPaymentAccount: options.includeInternalCosts ? r.costPaymentAccount : null,
    costNotes: options.includeInternalCosts ? r.costNotes : null,
    updatedAt: r.updatedAt.toISOString(),
    partyName: r.partyId ? (ownerNames.get(r.partyId) ?? null) : null,
    // Review fix (T4): null the id itself when the org-scoped relation resolved to
    // null (foreign-org id via tampered/legacy data) — keeps the id consistent with
    // the already-nulled `category` object instead of exposing the raw foreign FK.
    chargeCategoryId: r.chargeCategory ? r.chargeCategoryId : null,
    category: r.chargeCategory ? { name: r.chargeCategory.name, profitExpense: r.chargeCategory.profitExpense } : null,
    nature: r.nature,
    settlement: settlementByExpenseId.get(r.id) ?? "none",
  }));
  return ok({ items, total });
}

/**
 * PATCH an expense line. `409 ENTRY_LOCKED` once MONEY HAS ARRIVED for the parent month
 * (not merely once billed — an amend on a billed-but-unpaid month is picked up by the
 * re-Bill). `bearer` is NOT accepted (filing to the wrong side is fixed by void + recreate).
 */
export async function updateExpenseService(
  session: { orgId: string; userId: string; role: string },
  expenseId: string,
  body: { description?: string; amount?: string; withSST?: boolean; chargeCategoryId?: string | null; nature?: "expense" | "profit"; actualCost?: string | null; costVendor?: string | null; costPaymentStatus?: "unpaid" | "partial" | "paid"; costPaymentDate?: string | null; costPaymentAccount?: string | null; costNotes?: string | null; expectedUpdatedAt?: string },
): Promise<Result<{ id: string; updatedAt: string }>> {
  try {
    return await prisma.$transaction(async (tx) => {
      const exp = await tx.gridExpense.findFirst({ where: { id: expenseId, organizationId: session.orgId } });
      if (!exp) return err(404, "EXPENSE_NOT_FOUND");
      // Locked by MONEY on THIS LINE, not by Bill and not by the month. Paying one line
      // used to freeze every other line on the month; partial re-Bill gives an edit to an
      // unpaid line a route onto a document, so the guard narrows to match. Falls back to
      // the entry-wide check when partial re-Bill is off, because without it a re-Bill
      // would refuse to carry the edit and it would strand.
      // After EXPENSE_NOT_FOUND and before any write, so today's error precedence and the
      // clean-no-op property both hold.
      const lockedByMoney = isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")
        ? await expenseHasActivePayment(tx, session.orgId, exp.id)
        : await entryHasActivePayment(tx, session.orgId, exp.entryId);
      // Customer-facing charge truth freezes once money has arrived, but the
      // internal cost ledger is often completed afterwards (supplier invoice,
      // bank account and payment date arrive later). A cost-only patch must stay
      // available or a paid charge can never receive its real margin/cost record.
      const customerFacingKeys = ["description", "amount", "withSST", "chargeCategoryId", "nature"] as const;
      const changesCustomerFacingCharge = customerFacingKeys.some((key) => body[key] !== undefined);
      if (lockedByMoney && changesCustomerFacingCharge) return err(409, "ENTRY_LOCKED");

      // Only when TRUTHY: an omitted or explicit-null chargeCategoryId (clearing the
      // category) needs no ownership check — nothing is being attached. Runs BEFORE
      // any write (updateMany below), so a rejection here is a clean no-op — no
      // partial write / stray-row risk (unlike createExpensesService's getOrCreateEntry).
      if (body.chargeCategoryId) {
        const cat = await tx.chargeCategory.findFirst({ where: { id: body.chargeCategoryId, organizationId: session.orgId }, select: { id: true, active: true } });
        if (!cat) return err(400, "CATEGORY_NOT_FOUND");
        // Review fix (T4): mirrors billing.service.ts:280's CATEGORY_INACTIVE precedent.
        if (!cat.active) return err(400, "CATEGORY_INACTIVE");
      }

      // `nature` mirrors chargeCategoryId's omitted-key-leaves-untouched semantics (B5's
      // sibling guard, expense-category.integration.test.ts): Prisma ignores an
      // `undefined`-valued key entirely, so an omitted `body.nature` never clobbers the
      // row's existing value — only an explicit "expense"/"profit" writes. Not gated on
      // ENABLE_CHARGE_NATURE_ROUTING here — see createExpensesSchema's doc-comment.
      const data = {
        description: body.description,
        amount: body.amount,
        withSST: body.withSST,
        chargeCategoryId: body.chargeCategoryId,
        nature: body.nature,
        actualCost: body.actualCost,
        costVendor: body.costVendor === undefined ? undefined : (body.costVendor?.trim() || null),
        costPaymentStatus: body.costPaymentStatus,
        costPaymentDate: body.costPaymentDate === undefined ? undefined : (body.costPaymentDate ? new Date(`${body.costPaymentDate}T00:00:00.000Z`) : null),
        costPaymentAccount: body.costPaymentAccount === undefined ? undefined : (body.costPaymentAccount?.trim() || null),
        costNotes: body.costNotes === undefined ? undefined : (body.costNotes?.trim() || null),
      };
      const where = body.expectedUpdatedAt
        ? { id: exp.id, updatedAt: new Date(body.expectedUpdatedAt) }
        : { id: exp.id, updatedAt: exp.updatedAt };
      const res = await tx.gridExpense.updateMany({ where, data });
      if (res.count === 0) return err(409, "STALE");

      const fresh = await tx.gridExpense.findUniqueOrThrow({ where: { id: exp.id } });
      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.expense.update", entityType: "GridExpense", entityId: exp.id, diff: data as never,
      });
      return ok({ id: fresh.id, updatedAt: fresh.updatedAt.toISOString() });
    });
  } catch {
    return err(500, "UPDATE_EXPENSE_FAILED");
  }
}

/**
 * Void an expense line (the ONLY retire path in this module). `409 NOT_VOIDABLE` if
 * already void. Deletes nothing from the bucket — expense lines carry no storage object.
 */
export async function voidExpenseService(
  session: { orgId: string; userId: string; role: string },
  expenseId: string,
): Promise<Result<{ id: string }>> {
  try {
    return await prisma.$transaction(async (tx) => {
      const exp = await tx.gridExpense.findFirst({ where: { id: expenseId, organizationId: session.orgId } });
      if (!exp) return err(404, "EXPENSE_NOT_FOUND");
      if (exp.status === "void") return err(409, "NOT_VOIDABLE");
      // Locked by MONEY on THIS LINE. The prior concern — voiding an owner-borne expense
      // on a BILLED month silently mutates that month's recorded totals (the prior-strip
      // "Others (Expenses)" sum counts status:"active" live) — is answered by the
      // hasUnbilledChanges marker: the divergence is SHOWN and cleared by a re-Bill, rather
      // than prevented outright on a month nobody has paid. Mirrors updateExpenseService,
      // including its flag fallback.
      const voidLockedByMoney = isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")
        ? await expenseHasActivePayment(tx, session.orgId, exp.id)
        : await entryHasActivePayment(tx, session.orgId, exp.entryId);
      if (voidLockedByMoney) return err(409, "ENTRY_LOCKED");

      await tx.gridExpense.update({ where: { id: exp.id }, data: { status: "void" } });
      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.expense.void", entityType: "GridExpense", entityId: exp.id,
      });
      return ok({ id: exp.id });
    });
  } catch {
    return err(500, "VOID_EXPENSE_FAILED");
  }
}

// ─────────────────────────────── ATTACHMENTS ────────────────────────────────

/**
 * Fail-closed object delete (R28, no-orphan-storage). lib/storage.ts deleteObject
 * swallows a Supabase 404 as success, so it alone cannot tell us the object is
 * really gone. We delete, then CONFIRM absence before the caller removes the row.
 * An already-absent object is a legitimate success: the goal state is "gone".
 */
async function deleteObjectFailClosed(storageKey: string): Promise<void> {
  await deleteObject(requireBucket(), storageKey); // throws on a genuine storage error
  if (await objectExists(storageKey)) {
    throw new Error("ATTACHMENT_DELETE_FAILED");
  }
}

export interface AttachmentListItem {
  id: string; filename: string; contentType: string; sizeBytes: number; storageKey: string; uploadedBy: string; createdAt: string;
  cellKey: string | null; columnId: string | null; documentKind: string | null;
}

/**
 * Upload an attachment. The row is written ONLY AFTER a confirmed 2xx putObject
 * (R28): if the object is not confirmed, NO row is written. The parent entry is
 * get-or-created first (the attachment carries a NON-NULL entryId).
 */
export async function uploadAttachmentService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  file: { period: string; cellKey?: string; columnId?: string; documentKind?: "invoice" | "receipt"; filename: string; contentType: string; sizeBytes: number; body: Buffer },
): Promise<Result<{ id: string; storageKey: string }>> {
  const periodMonth = toMonth(file.period);
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");

  const entry = await prisma.$transaction((tx) => getOrCreateEntry(tx, { orgId: session.orgId, apartmentId, periodMonth, actorUserId: session.userId }));
  const storageKey = `bills-grid/${session.orgId}/${entry.id}/${randomUUID()}-${file.filename}`;

  try {
    await putObject(storageKey, file.body, file.contentType); // throws if the 2xx never arrives
  } catch {
    return err(502, "ATTACHMENT_UPLOAD_FAILED"); // NO row is written when the object is not confirmed
  }

  return await prisma.$transaction(async (tx) => {
    const row = await tx.gridAttachment.create({
      data: {
        organizationId: session.orgId, entryId: entry.id, apartmentId, periodMonth,
        storageKey, filename: file.filename, contentType: file.contentType, sizeBytes: file.sizeBytes,
        cellKey: file.cellKey ?? null, columnId: file.columnId ?? null, documentKind: file.documentKind ?? null,
        uploadedBy: session.userId,
      },
    });
    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.attachment.upload", entityType: "GridAttachment", entityId: row.id,
      meta: { filename: file.filename, sizeBytes: file.sizeBytes, cellKey: file.cellKey, columnId: file.columnId, documentKind: file.documentKind },
    });
    await invalidateDocumentPdfsForAttachment(tx, {
      orgId: session.orgId, apartmentId, periodMonth, expenseId: null,
    });
    return ok({ id: row.id, storageKey }, 201);
  });
}

/** List an apartment-month's attachments. Creates nothing; empty when unsaved. */
export async function listAttachmentsService(
  session: { orgId: string },
  apartmentId: string,
  period: string,
  scope: { cellKey?: string; columnId?: string; documentKind?: "invoice" | "receipt" } = {},
): Promise<Result<{ items: AttachmentListItem[] }>> {
  const periodMonth = toMonth(period);
  const entry = await prisma.unitBillsGridEntry.findUnique({
    where: { organizationId_apartmentId_periodMonth: { organizationId: session.orgId, apartmentId, periodMonth } },
    include: { attachments: true },
  });
  const items: AttachmentListItem[] = (entry?.attachments ?? [])
    .filter((a) => (!scope.cellKey || a.cellKey === scope.cellKey)
      && (!scope.columnId || a.columnId === scope.columnId)
      && (!scope.documentKind || a.documentKind === scope.documentKind))
    .map((a) => ({
    id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
    storageKey: a.storageKey, uploadedBy: a.uploadedBy, createdAt: a.createdAt.toISOString(),
    cellKey: a.cellKey, columnId: a.columnId, documentKind: a.documentKind,
  }));
  return ok({ items });
}

/**
 * Delete an attachment. Object FIRST, fail-closed; the row is removed only on the
 * object's confirmed 2xx. On a genuine storage failure the row is RETAINED and the
 * call returns `502 ATTACHMENT_DELETE_FAILED` — no row ever points at a missing
 * object, and no object is ever orphaned by a removed row.
 */
export async function deleteAttachmentService(
  session: { orgId: string; userId: string; role: string },
  attachmentId: string,
): Promise<Result<{ id: string }>> {
  const att = await prisma.gridAttachment.findFirst({ where: { id: attachmentId, organizationId: session.orgId } });
  if (!att) return err(404, "ATTACHMENT_NOT_FOUND");

  try {
    await deleteObjectFailClosed(att.storageKey); // object FIRST — throws if it survives
  } catch {
    return err(502, "ATTACHMENT_DELETE_FAILED"); // row retained; no orphan
  }

  return await prisma.$transaction(async (tx) => {
    await tx.gridAttachment.delete({ where: { id: att.id } });
    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.attachment.delete", entityType: "GridAttachment", entityId: att.id,
      meta: { storageKey: att.storageKey },
    });
    await invalidateDocumentPdfsForAttachment(tx, {
      orgId: session.orgId, apartmentId: att.apartmentId, periodMonth: att.periodMonth, expenseId: att.expenseId,
    });
    return ok({ id: att.id });
  });
}

/**
 * A short-lived signed URL for INLINE preview of a GridAttachment (Item 4).
 * Works for entry-level AND per-line attachments alike — one table, resolved by
 * attachment id (org-scoped, exactly as {@link deleteAttachmentService}), so the
 * admin can view what was uploaded and catch a wrong file. Read-only: mints a
 * signed URL, writes no row and touches no object.
 *
 * NO `filename` download opt is passed to createSignedDownloadUrl on purpose —
 * that opt sets Content-Disposition: attachment (a forced download); omitting it
 * lets the browser render images/PDFs inline in a new tab / the viewer. The
 * `contentType` is surfaced so the client can pick <img> vs <iframe>.
 */
export async function getAttachmentUrlService(
  session: { orgId: string },
  attachmentId: string,
): Promise<Result<{ downloadUrl: string; filename: string; contentType: string }>> {
  const att = await prisma.gridAttachment.findFirst({ where: { id: attachmentId, organizationId: session.orgId } });
  if (!att) return err(404, "ATTACHMENT_NOT_FOUND");
  const downloadUrl = await createSignedDownloadUrl(att.storageKey);
  return ok({ downloadUrl, filename: att.filename, contentType: att.contentType });
}

/** Per-line attachment upload (T1, R6/R7). Scope is resolved from the expense
 * (org-scoped) — its entry already exists, so NO get-or-create. Fail-closed:
 * the row is written only after a confirmed 2xx putObject. */
export async function uploadLineAttachmentService(
  session: { orgId: string; userId: string; role: string },
  expenseId: string,
  file: { filename: string; contentType: string; sizeBytes: number; body: Buffer },
): Promise<Result<{ id: string; storageKey: string }>> {
  const exp = await prisma.gridExpense.findFirst({ where: { id: expenseId, organizationId: session.orgId } });
  if (!exp) return err(404, "EXPENSE_NOT_FOUND");
  const storageKey = `bills-grid/${session.orgId}/${exp.entryId}/${exp.id}/${randomUUID()}-${file.filename}`;
  try {
    await putObject(storageKey, file.body, file.contentType);
  } catch {
    return err(502, "ATTACHMENT_UPLOAD_FAILED");
  }
  return await prisma.$transaction(async (tx) => {
    const row = await tx.gridAttachment.create({
      data: {
        organizationId: session.orgId, entryId: exp.entryId, apartmentId: exp.apartmentId, periodMonth: exp.periodMonth,
        expenseId: exp.id, storageKey, filename: file.filename, contentType: file.contentType, sizeBytes: file.sizeBytes,
        uploadedBy: session.userId,
      },
    });
    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.line-attachment.upload", entityType: "GridAttachment", entityId: row.id,
      meta: { expenseId: exp.id, filename: file.filename, sizeBytes: file.sizeBytes },
    });
    await invalidateDocumentPdfsForAttachment(tx, {
      orgId: session.orgId, apartmentId: exp.apartmentId, periodMonth: exp.periodMonth, expenseId: exp.id,
    });
    return ok({ id: row.id, storageKey }, 201);
  });
}

/** List a single expense line's attachments (T1). 404 for a cross-org/missing line. */
export async function listLineAttachmentService(
  session: { orgId: string },
  expenseId: string,
): Promise<Result<{ items: AttachmentListItem[] }>> {
  const exp = await prisma.gridExpense.findFirst({ where: { id: expenseId, organizationId: session.orgId }, select: { id: true } });
  if (!exp) return err(404, "EXPENSE_NOT_FOUND");
  const rows = await prisma.gridAttachment.findMany({ where: { organizationId: session.orgId, expenseId }, orderBy: { createdAt: "asc" } });
  const items: AttachmentListItem[] = rows.map((a) => ({
    id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
    storageKey: a.storageKey, uploadedBy: a.uploadedBy, createdAt: a.createdAt.toISOString(),
    cellKey: a.cellKey, columnId: a.columnId, documentKind: a.documentKind,
  }));
  return ok({ items });
}
