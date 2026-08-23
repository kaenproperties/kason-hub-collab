/**
 * Owner-Ledger sync bridge — materialises OwnerLedgerEntry rows from THREE
 * EXISTING subsystems, idempotently, in one transaction + one audit row.
 *
 * The sync is STRICTLY READ-ONLY on its three sources (Charge / Invoice /
 * UnitUtilityBill) — it only ever writes OwnerLedgerEntry + the audit row.
 *
 * Sources (all scoped to the owner's units for ONE billing month):
 *   1. RENT income   — one row per rent Charge on the owner's units (per room,
 *                      per resolved decision). amount = collected (charge.amount
 *                      − outstandingAmount). Reuses the EXACT owner→units join
 *                      that getCollectedRentForOwnerMonth / getFinancials walk,
 *                      so the ledger can never diverge from the portal totals.
 *   2. STATEMENT     — the owner's owner_statement Invoice (M6) → its child
 *                      Charges. category mapped from chargeType. The statement's
 *                      aggregate Invoice.sstAmount is attached to EXACTLY ONE
 *                      management_fee row (others → null), mirroring the
 *                      financials-extended summary contract.
 *   3. UTILITY       — UnitUtilityBill full per-category bills (M2 → M6 seam):
 *                      GROSS model — one expense row per FULL supplier-bill
 *                      component (tnb / water / indah / cleaning / wifi),
 *                      includeInPayout:true, keyed on a per-category sourceType.
 *   4. TENANT CARVE  — tenant-borne utility/aircond Charges as payout income; the
 *                      Source-3 full bill minus this carve-out nets to the owner.
 *   (6. OWNER-BORNE EXPENSE DEDUCT — REMOVED 2026-08-16, operator decision. It booked
 *       bills-grid owner-borne expense Charges as an includeInPayout deduction INSTEAD
 *       of billing them, behind ENABLE_OWNER_BORNE_DEDUCT. KAEN wants the expense to
 *       SHOW as an IVOWN line the owner can see, and to be netted out of the payout when
 *       the rent is collected — which auto-offset-on-rent.hook.ts already does, on the
 *       payable-consuming offset rail. Two mechanisms for one outcome; this was the one
 *       nobody wanted, and it silently ignored CN/DN on the expense besides. Historical
 *       `owner_borne_expense` rows are left untouched: nothing creates them any more,
 *       and the reverse pass below still voids one whose source Charge is voided.)
 *
 * IDEMPOTENCY (the DB @@unique is NOT sufficient):
 *   The table's @@unique(organizationId, sourceType, sourceChargeId) covers
 *   rent/statement rows (they carry a sourceChargeId) but NOT utility rows
 *   (sourceChargeId is null; Postgres treats NULLs as distinct → re-sync would
 *   duplicate). So idempotency is enforced IN CODE for every source row:
 *     • rent/statement — keyed on {orgId, sourceType, sourceChargeId}
 *     • utility        — keyed on {orgId, sourceType:"utility", sourceUtilityBillId}
 *   then per existing row:
 *     not found                       → create  (created++)
 *     found, updatedById == SENTINEL  → update  (updated++)   // still sync-owned
 *     found, updatedById != SENTINEL  → SKIP    (skipped++)   // an admin edited it
 *
 *   Synced rows stamp createdById = updatedById = SYNC_ACTOR_ID (a sentinel — the
 *   createdById/updatedById columns are plain, NO FK, so a sentinel is safe). The
 *   audit row still uses the REAL actor.actorUserId (User FK).
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { OwnerLedgerCategory } from "@kason/shared";
import { centsToString, OWNER_CATEGORY_DEFAULTS } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { findPeriod } from "../owner-billing/owner-statement-period.repository";
import { netAdjustmentsByChargeId } from "./net-adjustments-by-charge";
import type { OwnerLedgerActorCtx } from "./owner-ledger.types";
import { FORWARD_SOURCE_TYPES } from "./owner-ledger.types";

// ─── Per-category sync defaults ─────────────────────────────────────────────
//
// Derive paidBy + taxCategory from the canonical OWNER_CATEGORY_DEFAULTS map
// rather than hardcoding "kaen" / "check_with_tax_agent" for every row.
function syncDefaults(category: string): { paidBy: string; taxCategory: string } {
  const d = OWNER_CATEGORY_DEFAULTS[category];
  return {
    paidBy: d?.defaultPaidBy ?? "kaen",
    taxCategory: d?.defaultTaxCategory ?? "check_with_tax_agent",
  };
}

// ─── Sentinel actor ─────────────────────────────────────────────────────────
//
// A fixed UUID stamped on createdById/updatedById of every sync-owned row. An
// admin edit through the CRUD service overwrites updatedById with a REAL user id,
// which is how the next sync recognises "do not overwrite" rows.
export const SYNC_ACTOR_ID = "00000000-0000-4000-8000-00000000a0a0";

// ─── Source-4 (tenant carve-out INCOME) sourceTypes ──────────────────────────
//
// The two sourceTypes Source 4 mints for tenant-borne utility/aircond income (see the
// tenant-borne income loop below). The reverse pass reuses this set to identify which
// candidate rows are Source-4 income rows eligible for the Finding-C owner-billed
// self-heal — so the heal can NEVER sweep a Source-6 owner_borne_expense deduction
// (also owner-billed by design) or any other source.
const SOURCE4_INCOME_SOURCE_TYPES = new Set<string>(["tenant_utility", "tenant_aircond"]);

// ─── Source-4 pairing rule — is this carve-out real owner income? ─────────────
//
// The GROSS model only balances as a PAIR: Source 3 books the FULL supplier bill as
// an owner expense, Source 4 books the tenant carve-out as owner income, and the
// difference is what the owner actually bears. Source 3 requires a CHARGED
// UnitUtilityBill for the apartment — but bills-grid NEVER writes one (its HARD
// CONSTRAINT 2, bills-grid/service.ts), so on the grid path the expense half can
// never be booked. The income half then stands alone and the owner's payout is
// inflated by the ENTIRE tenant utility bill: money KAEN collected in order to pay
// TNB / Air Selangor, not money the owner earned.
//
// So an unpaired carve-out is stamped includeInPayout:false — visible on the
// statement (the owner still sees what their tenant was charged) but out of the
// payout maths, which is exactly how the shared summariser reads that flag on a
// utility income line (isPassThroughIncomeLine, packages/shared owner-net-payout).
//
// TWO guards keep the blast radius at the bug:
//   • paired apartments are untouched — where Source 3 DID book the full bill,
//     dropping the income would deduct the whole supplier bill from the owner
//     (the opposite money bug, and a worse one: KAEN would keep the difference).
//   • PARTITIONED units are untouched — their split maths (per-pax pooling,
//     subsidy, private aircond) is a separate design not yet signed off. They keep
//     today's behaviour, unpaired carve-outs included.
export function tenantCarveOutIncludeInPayout(args: {
  listingMode: string | null;
  apartmentHasGrossUtilityExpense: boolean;
}): boolean {
  if (args.listingMode !== "WHOLE") return true;
  return args.apartmentHasGrossUtilityExpense;
}

// ─── Source 7 — bills-grid provider bills → owner expense (PARTITIONED) ───────
//
// PARTITIONED is the MIRROR of the whole-unit case. On a whole unit the tenant is
// charged exactly the bill, so the owner's utility position is zero and the
// carve-out is pure pass-through (see tenantCarveOutIncludeInPayout). On a
// partitioned unit it is NOT zero, and every part of the difference belongs to the
// owner:
//   • private submeters bill at KAEN's rate, which is above TNB's — a 300.00 master
//     bill recharged as 320.00 leaves 20.00 of OWNER PROFIT (meter/compute.ts:107)
//   • subsidy (RM/pax, when the mode is "subsidy") cuts what tenants are charged
//     while the supplier bill is unchanged — the owner covers the gap
//   • a vacant room's aircond and the rounding residual are the owner's too
//
// The gross model already expresses all of that as income − expense, and needs no
// special cases for any of it — but it needs BOTH halves. Source 3 books the expense
// half from a CHARGED UnitUtilityBill, which bills-grid never writes. So on the grid
// path only the income half existed and the owner was credited the tenant's ENTIRE
// utility payment (320.00 instead of 20.00). This source supplies the missing half
// from the grid entry's RAW provider bill.
//
// Only TNB + Air Selangor are booked here. They are the two the schema pins as
// always tenant-pooled (UnitUtilityBill "TNB + AirSelangor are always tenant"), so
// there is no bearer ambiguity, and their Source-2 statement twins are display-only
// (STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES) so nothing double-counts. cleaning and
// maintenance are deliberately EXCLUDED: Source 2 books them as real payout expenses,
// so booking the grid's copy too would deduct them from the owner twice.
const GRID_PROVIDER_BILL_ROWS: ReadonlyArray<{
  rawField: "tnbTotalRaw" | "airSelangorRaw";
  patternField: "tnbPattern" | "airPattern";
  category: OwnerLedgerCategory;
  sourceType: string;
}> = [
  { rawField: "tnbTotalRaw", patternField: "tnbPattern", category: "utilities_tnb", sourceType: "grid_utility_tnb" },
  { rawField: "airSelangorRaw", patternField: "airPattern", category: "water", sourceType: "grid_utility_water" },
];

/** Every sourceType Source 7 can mint — the stale-row sweep below keys on this set. */
const GRID_PROVIDER_BILL_SOURCE_TYPES = new Set<string>(GRID_PROVIDER_BILL_ROWS.map((r) => r.sourceType));

// Which billing patterns mean "KAEN fronted this supply and recovers it from the
// tenant pool" — the only ones that may deduct from the owner's payout.
//
//   recharged / manager_advanced → KAEN pays the provider, bills the tenants. The
//     tenant charges are already booked as owner income by Source 4, so the bill
//     must be booked against them or the owner keeps the tenants' money.
//   absorbed  → owner-borne, and bills-grid ALREADY mints a GRIDOWN- charge billed
//     TO the owner for it (service.ts:1557-1580). That is a receivable the owner
//     settles directly; deducting it from the payout as well would charge them
//     twice for one supply.
//   tenant_direct → the tenant pays the provider themselves. No KAEN money moves,
//     no tenant charge exists, so there is nothing to pair and nothing to deduct.
const KAEN_FRONTED_RECHARGE_PATTERNS = new Set<string>(["recharged", "manager_advanced"]);

/** PURE. Whether a grid entry's per-utility provider bill deducts from the owner payout. */
export function gridProviderBillDeducts(args: {
  listingMode: string | null;
  billed: boolean;
  pattern: string;
  rawAmount: number | null;
}): boolean {
  if (args.listingMode !== "PARTITIONED") return false;
  // Mirrors Source 3's `status === "charged"` gate: before Bill there are no tenant
  // charges to pair against, so deducting now would show the owner carrying the
  // whole master bill alone.
  if (!args.billed) return false;
  if (!KAEN_FRONTED_RECHARGE_PATTERNS.has(args.pattern)) return false;
  return args.rawAmount != null && args.rawAmount > 0;
}

// ─── chargeType → ledger category map (statement source) ────────────────────
const STATEMENT_CATEGORY_MAP: Record<string, OwnerLedgerCategory> = {
  management_fee: "management_fee",
  letting_commission: "letting_commission",
  cleaning: "cleaning",
  tnb: "utilities_tnb",
  water: "water",
  wifi: "wifi",
  maintenance: "maintenance_fee",
  insurance: "fire_insurance",
  assessment_tax: "assessment",
  sewerage: "indah_water",
  cukai_petak: "cukai_petak",
  access_card: "access_card",
  other: "other_expense",
  // Phase 3: owner-borne letting-commission SST → a deducting owner expense. Books via Source 2
  // ONLY (owner_income charge ≠ expense/nature → the owner-borne-deduct Source 6 never sees it →
  // no double-deduct, M-B2). "other_expense" is includeInPayout → deducts from the owner payout.
  letting_commission_sst: "other_expense",
};

// ─── Source-2/3 RECONCILIATION — statement categories that are DISPLAY-ONLY (C1) ──
//
// GROSS model: Source 3 books the FULL per-category UnitUtilityBill amounts
// (tnb / water / indah / wifi) as the SOLE payout-source expense rows (see
// UTILITY_BILL_CATEGORY_ROWS below). The owner_statement (Source 2) ALSO carries
// itemised child Charges for those same categories (the PART-4 auto-feed). If those
// statement rows ALSO counted toward net payout the category would be deducted TWICE
// (once via the Source-3 full bill, once via the Source-2 charge) → owner UNDERPAID.
//
// RULE (exactly one payout source per category): Source 3 (UnitUtilityBill) owns
// the payout for these four categories; the matching Source-2 statement rows are
// kept VISIBLE on the statement/ledger (itemised detail) but flagged
// includeInPayout:false.
//
// CLEANING is deliberately NOT here. Its owner-statement billing path is the config
// RM100 auto-bill — a Source-2 `cleaning` charge — and the PART-4 auto-feed NEVER
// emits cleaning, while UnitUtilityBill.cleaning is ~0 for the owner statement. So
// Source 2 is cleaning's SOLE payout source (like management_fee / maintenance_fee /
// insurance). Making the Source-2 cleaning display-only WITHOUT a Source-3 cleaning
// backing would silently DROP the RM100 from the payout → owner OVERPAID. assessment
// / cukai_petak / access_card / other_expense are likewise not UnitUtilityBill-derived.
const STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES = new Set<OwnerLedgerCategory>([
  "utilities_tnb",
  "wifi",
  "indah_water",
  "water",
]);

// ─── Source 3 — full per-category UnitUtilityBill → ledger expense rows (C1) ──
//
// The GROSS statement books each FULL supplier-bill component as its own expense
// row (includeInPayout:true), pairing with the tenant carve-out income (Source 4)
// so the pair nets to the owner's real share. Each category uses a DISTINCT
// sourceType ("utility_<cat>") so the table's @@unique(org, sourceType,
// sourceUtilityBillId) admits one row per category from the SAME bill WITHOUT a
// schema change — and code-side idempotency probes on the same key, so a re-sync
// updates (never duplicates) each per-category row. CLEANING is intentionally NOT
// gross-sourced here — config cleaning is a Source-2 payout charge (see the
// display-only set above), so booking it here too would double-source it.
const UTILITY_BILL_CATEGORY_ROWS: ReadonlyArray<{
  field: "tnbTotal" | "airSelangor" | "indahWater" | "wifi";
  category: OwnerLedgerCategory;
  sourceType: string;
}> = [
  { field: "tnbTotal", category: "utilities_tnb", sourceType: "utility_tnb" },
  { field: "airSelangor", category: "water", sourceType: "utility_water" },
  { field: "indahWater", category: "indah_water", sourceType: "utility_indah_water" },
  { field: "wifi", category: "wifi", sourceType: "utility_wifi" },
];

// ─── Source-charge status → owner-ledger paymentStatus (PART 2 / Workstream D) ─
//
// The owner-ledger paymentStatus must reflect the TENANT's actual charge/payment
// state, not a hardcoded "paid". A ledger row materialised from a Charge inherits
// that Charge's settlement state so the owner sees "pending payment from tenant"
// vs "paid":
//   draft / posted        → "pending"  (raised, not yet paid)
//   partially_paid        → "partial"
//   paid                  → "paid"
//   void                  → "cancelled" (defensive — void charges are filtered out
//                           upstream, so this only guards an unexpected leak)
// Any unrecognised status falls back to "pending" (never silently claim "paid").
function chargeStatusToPaymentStatus(status: string): string {
  switch (status) {
    case "paid":
      return "paid";
    case "partially_paid":
      return "partial";
    case "void":
      return "cancelled";
    case "draft":
    case "posted":
    default:
      return "pending";
  }
}

// Aggregate the paymentStatus for a utility ledger row from the UnitUtilityBill's
// own lifecycle + the tenant Charges it raised:
//   • a DRAFT bill is keyed/saved but NOT yet posted to the tenant       → "pending"
//   • a VOID bill                                                        → "cancelled"
//   • a CHARGED bill: roll up the linked tenant utility/aircond Charges —
//       every charge paid          → "paid"
//       some paid (or partial)     → "partial"
//       none paid                  → "pending"
//       no linked charges resolved → "pending" (charged but nothing to settle yet)
function utilityBillPaymentStatus(
  billStatus: string,
  chargeStatuses: string[],
): string {
  if (billStatus === "void") return "cancelled";
  if (billStatus !== "charged") return "pending"; // draft (or any pre-charge state)
  if (chargeStatuses.length === 0) return "pending";
  const mapped = chargeStatuses.map(chargeStatusToPaymentStatus);
  if (mapped.every((s) => s === "paid")) return "paid";
  if (mapped.some((s) => s === "paid" || s === "partial")) return "partial";
  return "pending";
}

// ─── Result type (matches Task 5's service-result shape) ────────────────────
type SyncCounts = { created: number; updated: number; skipped: number; reversed: number };
type SyncResult =
  | { ok: true; status: 200; data: SyncCounts }
  | { ok: false; status: 400; error: string };

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Integer-cent collected for a tenant-side Charge, on the ADJUSTED billed basis:
 *
 *   collected = max(0, max(0, amount + netAdjustment) − outstanding)
 *
 * `netAdjustmentCents` = Σ active DN − Σ active CN line cents for the charge
 * (netAdjustmentsByChargeId — the same seam-#1 netting Source 2 already applies
 * to statement expenses). Raw `amount − outstanding` misread adjustment notes
 * as cash, both ways:
 *   • CN on a PAID charge — outstanding fell at note mint, so the credited RM
 *     counted as collected (a 400 charge with a 30 CN booked 400 "collected"
 *     when the tenant actually paid 370);
 *   • CN on an UNPAID charge — phantom collected appeared the moment the note
 *     posted (400 − 370 = "30 collected", zero cash in);
 *   • DN — the extra cash genuinely collected was invisible (or collected went
 *     NEGATIVE while the charge sat unpaid: 150 − 180).
 * Clamped at 0: collected cash can never be negative — clawbacks are the
 * reversal machinery's job, never this figure.
 */
function collectedString(
  amount: Prisma.Decimal,
  outstanding: Prisma.Decimal,
  netAdjustmentCents: number,
): string {
  const amountC = Math.round(Number(amount.toString()) * 100);
  const outstandingC = Math.round(Number(outstanding.toString()) * 100);
  const adjustedC = Math.max(0, amountC + netAdjustmentCents);
  return (Math.max(0, adjustedC - outstandingC) / 100).toFixed(2);
}

/** A Decimal-like → 2dp string (no rounding beyond fixed(2)). */
function decString(value: { toString(): string }): string {
  return Number(value.toString()).toFixed(2);
}

/**
 * One owner-ledger row the sync SHOULD book from an owner_statement Invoice child
 * Charge — the PURE Source-2 decision (category map, SST-on-exactly-one-management_fee
 * row), carrying ONLY the reconciliation-relevant economics. The sync layers on the
 * per-charge property/apartment/tenancy/paid-on-behalf context; R5 recon
 * (source-to-ledger) reuses this to enumerate the expected statement rows WITHOUT
 * re-implementing the sync's exclusion rules.
 */
export interface ExpectedStatementRow {
  /** The source child Charge id — the ledger row's sourceChargeId + R5 dedupe sourceId. */
  sourceChargeId: string;
  /** The child Charge's chargeType (management_fee, cleaning, maintenance, …). */
  chargeType: string;
  /** Mapped owner-ledger category. */
  category: OwnerLedgerCategory;
  /** Statement expense rows are always expense. */
  direction: "expense";
  /** 2dp ledger amount string (decString(charge.amount)) — byte-identical to the sync. */
  amount: string;
  /** Integer cents of `amount`. */
  amountC: number;
  /** Aggregate invoice SST attached to EXACTLY ONE management_fee row (raw .toString()), else null. */
  sstAmount: string | null;
  /** Whether the row counts toward net payout (display-only utility twins would be false). */
  includeInPayout: boolean;
}

/**
 * Given an owner_statement Invoice (its aggregate sstAmount) and its NON-void/credited
 * child Charges, return — in charge order — the owner-ledger rows the sync SHOULD book.
 *
 * BEHAVIOR-PRESERVING EXTRACT of syncMonthService's Source-2 loop: the category map, the
 * SST-on-exactly-one-management_fee-row rule and includeInPayout are verbatim, so the
 * sync's Source-2 output stays byte-identical when it calls this. Shared with R5 recon so
 * the two can never diverge on which statement rows must exist.
 *
 * Seam #1 (payout netting): the optional `adjustmentsByChargeId` map nets each charge's
 * ACTIVE charge-backed CN/DN (net-adjustments-by-charge.ts) into its expense amount —
 * Formula-B: `adjustedCents = max(0, round(charge.amount*100) + Σ active DN cents − Σ
 * active CN cents)`. Owner CN → expense down → payable up; owner DN → expense up →
 * payable down. Omitting the param (or a charge absent from the map) is a 0 delta, so
 * every existing caller stays byte-identical until it opts in.
 */
export function expectedStatementLedgerRows(
  invoice: { sstAmount: Prisma.Decimal | null },
  charges: ReadonlyArray<{ id: string; chargeType: string; amount: Prisma.Decimal }>,
  adjustmentsByChargeId?: ReadonlyMap<string, number>,
): ExpectedStatementRow[] {
  const sstTotal = invoice.sstAmount != null ? invoice.sstAmount.toString() : null;
  let sstAttached = false;
  const rows: ExpectedStatementRow[] = [];
  for (const ch of charges) {
    const category = STATEMENT_CATEGORY_MAP[ch.chargeType] ?? "other_expense";
    // Approach B: do NOT materialize the display-only utility twin — the Source-3 full
    // supplier bill is the sole payout+display source for each utility. Skipping here keeps
    // R5 recon from ever expecting (and false-flagging) a row the sync deliberately omits.
    if (STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES.has(category)) continue;
    const isFee = ch.chargeType === "management_fee";
    const carriesSst = isFee && !sstAttached && sstTotal != null;
    if (carriesSst) sstAttached = true;
    const includeInPayout = !STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES.has(category);
    const baseCents = Math.round(Number(decString(ch.amount)) * 100);
    const adjustedCents = Math.max(0, baseCents + (adjustmentsByChargeId?.get(ch.id) ?? 0));
    rows.push({
      sourceChargeId: ch.id,
      chargeType: ch.chargeType,
      category,
      direction: "expense",
      amount: centsToString(adjustedCents),
      amountC: adjustedCents,
      sstAmount: carriesSst ? sstTotal : null,
      includeInPayout,
    });
  }
  return rows;
}

/**
 * A single source row, normalised to the OwnerLedgerEntry-create shape, plus the
 * idempotency probe used to find an existing row for it.
 */
type PlannedRow = {
  /** WHERE used to find an existing ledger row for this source row. */
  probe: Prisma.OwnerLedgerEntryWhereInput;
  /** The data to create (or to write on update of a still-sync-owned row). */
  data: Prisma.OwnerLedgerEntryUncheckedCreateInput;
};

// ─── Service ────────────────────────────────────────────────────────────────

export async function syncMonthService(
  actor: OwnerLedgerActorCtx,
  input: { ownerPartyId: string; month: string },
): Promise<SyncResult> {
  const { ownerPartyId, month } = input;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false as const, status: 400, error: "Invalid month format" };
  }
  const [year, mon] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year!, mon! - 1, 1));
  const monthEnd = new Date(Date.UTC(year!, mon!, 0));

  const db = getDb();

  // ── Freeze guard (Task 7) — once a month is FROZEN its ledger rows are
  //    immutable (append-only). A re-sync must NOT rebuild them; corrections flow
  //    FORWARD as a reversing entry posted into the current open month (see the
  //    sync-hook's postForwardReversalForFrozenMonth wiring). Flag-gated so the
  //    flag-off path is byte-identical to today: no findPeriod read, no early
  //    return, no extra query when ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER is off.
  if (isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER")) {
    const frozen = await findPeriod(actor.orgId, { ownerPartyId, apartmentId: null, periodMonth: monthStart });
    if (frozen?.status === "frozen") {
      return { ok: true as const, status: 200, data: { created: 0, updated: 0, skipped: 1, reversed: 0 } };
    }
  }

  // ── Resolve the owner's units — keyed by the per-unit Listing.ownerPartyId
  //    (owner money is attributed per-unit, NOT per-property via LandlordTenancy).
  //    Each non-archived listing the owner owns resolves its propertyId (NOT NULL
  //    on the ledger row) + apartmentId from the flat row. We still build the same
  //    maps the rest of the sync depends on: listingId→propertyId,
  //    listingId→apartmentId, apartmentId→propertyId (for utility rows). ──
  const ownedListings = await db.listing.findMany({
    where: { ownerPartyId, organizationId: actor.orgId, listingStatus: { not: "archived" } },
    select: {
      id: true,
      apartmentId: true,
      // listingMode scopes the Source-4 pairing rule to WHOLE units — see
      // tenantCarveOutIncludeInPayout.
      apartment: { select: { propertyId: true, listingMode: true } },
    },
  });

  // listingId → propertyId (rent + statement-by-unit rows resolve their property here).
  const listingToProperty = new Map<string, string>();
  // listingId → apartmentId (rent + statement rows set apartmentId on the ledger row).
  const listingToApartment = new Map<string, string>();
  // apartmentId → propertyId (utility rows resolve their property here).
  const apartmentToProperty = new Map<string, string>();
  // apartmentId → listingMode ("WHOLE" | "PARTITIONED") — scopes the Source-4
  // pairing rule; a missing entry falls back to today's behaviour.
  const apartmentToListingMode = new Map<string, string>();
  const unitIds: string[] = [];
  const apartmentIdSet = new Set<string>();
  let fallbackPropertyId: string | null = null;
  for (const listing of ownedListings) {
    const propertyId = listing.apartment.propertyId;
    if (fallbackPropertyId === null) fallbackPropertyId = propertyId;
    listingToProperty.set(listing.id, propertyId);
    listingToApartment.set(listing.id, listing.apartmentId);
    apartmentToProperty.set(listing.apartmentId, propertyId);
    apartmentToListingMode.set(listing.apartmentId, listing.apartment.listingMode);
    apartmentIdSet.add(listing.apartmentId);
    unitIds.push(listing.id);
  }
  const apartmentIds: string[] = [...apartmentIdSet];

  // ── Task 4.4: resolve the owner's carpark bays (Source 5 — new model). ──
  //    Fetched BEFORE the early-return so an owner who holds ONLY carpark bays
  //    (no residential listings) still gets their carpark income synced.
  //    Carpark.ownerPartyId mirrors the home apartment's Listing.ownerPartyId,
  //    so a bay's rent income is attributed to the BAY's owner (who may differ
  //    from the room's owner when a bay belongs to a different landlord).
  //    carparkId → { apartmentId, propertyId } used to stamp ledger property context.
  const ownedCarparks = await db.carpark.findMany({
    where: { ownerPartyId, organizationId: actor.orgId },
    select: { id: true, apartmentId: true, propertyId: true },
  });
  const carparkIds: string[] = ownedCarparks.map((cp) => cp.id);
  const carparkById = new Map<string, { apartmentId: string; propertyId: string }>();
  for (const cp of ownedCarparks) {
    carparkById.set(cp.id, { apartmentId: cp.apartmentId, propertyId: cp.propertyId });
  }

  // No units AND no carparks resolved (e.g. cross-org owner) → nothing to sync.
  if (fallbackPropertyId === null && ownedCarparks.length === 0) {
    return { ok: true as const, status: 200, data: { created: 0, updated: 0, skipped: 0, reversed: 0 } };
  }

  // ── Read the three sources (READ-ONLY). ──

  // 1) Rent Charges on the owner's units, due in the month, not void.
  const rentCharges = unitIds.length
    ? await db.charge.findMany({
        where: {
          organizationId: actor.orgId,
          unitId: { in: unitIds },
          chargeType: "rent",
          dueDate: { gte: monthStart, lte: monthEnd },
          status: { notIn: ["void", "credited"] },
        },
        select: {
          id: true,
          unitId: true,
          tenancyId: true,
          amount: true,
          outstandingAmount: true,
          dueDate: true,
          status: true, // PART 2: drives the rent row's paymentStatus
          attachmentKeys: true, // 2b-5: carry proof bundle through to ledger entry
        },
      })
    : [];

  // 1b) Letting-commission Charges — KAEN's first-month commission on the owner's units.
  //     Read SEPARATELY from source 1 rather than widening that `chargeType: "rent"`
  //     filter to an `in: [...]`: these must NEVER become rental_income. The statement's
  //     management fee is aligned 1:1 with `rows.filter(direction === "income")`, so an
  //     income row here would bill the owner a management fee on rent they never got.
  //     They book as `informational` instead — visible, explained, never summed.
  const lettingCommissionCharges = unitIds.length
    ? await db.charge.findMany({
        where: {
          organizationId: actor.orgId,
          unitId: { in: unitIds },
          chargeType: "letting_commission",
          // Legacy tenant-side commission rows only. New owner-side commission
          // lines live on the owner statement and are booked by Source 2 below.
          partyId: { not: ownerPartyId },
          dueDate: { gte: monthStart, lte: monthEnd },
          status: { notIn: ["void", "credited"] },
        },
        select: {
          id: true,
          unitId: true,
          tenancyId: true,
          amount: true,
          outstandingAmount: true,
          dueDate: true,
          status: true,
          attachmentKeys: true,
        },
      })
    : [];

  // 2) The owner's owner_statement Invoices for the month → their non-void children.
  //    Sourced by (ownerPartyId, periodMonth) so BOTH the legacy owner-COMBINED
  //    statement (idempotencyKey `owner:<owner>:<month>`) AND per-APARTMENT statements
  //    (Tasks 1-7 — idempotencyKey `owner:<owner>:<apt>:<month>`) book their owner-side
  //    charges. The previous combined-key-only lookup silently dropped per-apartment
  //    statement charges from the ledger (understated expenses → overstated payout).
  //    Booking stays collision-free: each child Charge is booked once, keyed on its
  //    sourceChargeId (a Charge belongs to exactly one Invoice), and each Invoice's
  //    aggregate SST attaches to one of ITS OWN management_fee rows.
  const statements = await db.invoice.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      invoiceType: "owner_statement",
      periodMonth: monthStart,
      status: { not: "void" },
    },
    select: {
      id: true,
      propertyId: true,
      sstAmount: true,
      charges: {
        where: { status: { notIn: ["void", "credited"] } },
        // PART 2: status drives each statement row's paymentStatus.
        // Task 9: carry the paid-on-behalf metadata through to the ledger row (display-only).
        select: {
          id: true,
          chargeType: true,
          amount: true,
          unitId: true,
          tenancyId: true,
          status: true,
          // Carried onto the ledger row so the statement can NAME the line. Several
          // distinct charge types collapse to the "other_expense" ledger category —
          // owner-borne letting-commission SST among them — and that category renders
          // as the bare word "Other". Without the charge's own description the owner
          // sees an unexplained "Other RM 240.00" deduction with no way to tell what
          // it is. Display-only: never touches amount, sstAmount, or includeInPayout.
          description: true,
          payeeName: true,
          paidOnBehalfRef: true,
          paidOnBehalfDate: true,
        },
      },
    },
  });

  // 3) UnitUtilityBills on the owner's apartments for the month with a positive
  //    owner-borne total.
  const utilityBills = apartmentIds.length
    ? await db.unitUtilityBill.findMany({
        where: { organizationId: actor.orgId, apartmentId: { in: apartmentIds }, periodMonth: monthStart },
        select: {
          id: true,
          apartmentId: true,
          // C1 GROSS: book each FULL per-category supplier bill as its own expense.
          // (cleaning is NOT gross-sourced — it stays the Source-2 config charge.)
          tnbTotal: true,
          airSelangor: true,
          indahWater: true,
          wifi: true,
          status: true, // PART 2: draft bill → pending; charged → roll up tenant charges
          // PART 2: the tenant utility/aircond Charges this bill raised, via its
          // allocations' chargeId links (chargeId is a plain column — no FK relation,
          // so we resolve the Charge statuses with a follow-up query below). A void
          // allocation is excluded from the roll-up.
          allocations: {
            where: { status: { not: "void" } },
            select: { chargeId: true },
          },
        },
      })
    : [];

  // 3b) Source 7 — bills-grid entries carrying the RAW provider bill for the month.
  //     One entry per (apartment, month) by @@unique, so the ledger row's identity is
  //     (sourceType, apartmentId, statementMonth) and no new column is needed.
  const gridEntries = apartmentIds.length
    ? await db.unitBillsGridEntry.findMany({
        where: { organizationId: actor.orgId, apartmentId: { in: apartmentIds }, periodMonth: monthStart },
        select: {
          id: true,
          apartmentId: true,
          // RAW un-shaped provider bills — NEVER the shaped/net values (grid caveat C3).
          tnbTotalRaw: true,
          tnbPattern: true,
          airSelangorRaw: true,
          airPattern: true,
          // null = never billed → no tenant charges exist yet to pair against.
          billedAt: true,
        },
      })
    : [];

  // PART 2: resolve the statuses of the tenant Charges linked to those bills'
  // allocations (one batched query — chargeId has no FK relation on the allocation).
  const utilityChargeIds = utilityBills.flatMap((b) =>
    b.allocations.map((a) => a.chargeId).filter((id): id is string => id !== null),
  );
  const utilityChargeStatusById = new Map<string, string>();
  if (utilityChargeIds.length) {
    const utilCharges = await db.charge.findMany({
      where: { organizationId: actor.orgId, id: { in: utilityChargeIds } },
      select: { id: true, status: true },
    });
    for (const c of utilCharges) utilityChargeStatusById.set(c.id, c.status);
  }

  // ── Plan one row per source row. ──
  const planned: PlannedRow[] = [];

  // CN/DN awareness for COLLECTED income figures (fix 2026-08-07): each income
  // source below nets the charge's active notes into its collected amount via
  // collectedString's third argument. Batched per source family — absent = 0,
  // so a charge with no notes stays byte-identical to the pre-fix output.
  const rentFamilyNetAdj = await netAdjustmentsByChargeId(
    db,
    actor.orgId,
    [...rentCharges, ...lettingCommissionCharges].map((c) => c.id),
  );

  // 1) Rent income — per charge. Carpark income now comes from Source 5 (Carpark entity
  //    charges via carparkId), not from a unitKind discriminator on Listing rows.
  for (const c of rentCharges) {
    const listingId = c.unitId ?? null;
    // fallbackPropertyId is non-null here: rentCharges is non-empty only when unitIds
    // is non-empty, which means ownedListings is non-empty → fallbackPropertyId set.
    const propertyId = (listingId && listingToProperty.get(listingId)) || fallbackPropertyId!;
    const apartmentId = (listingId && listingToApartment.get(listingId)) ?? null;
    const rentCategory: OwnerLedgerCategory = "rental_income";
    planned.push({
      probe: { organizationId: actor.orgId, sourceType: "rent", sourceChargeId: c.id },
      data: {
        organizationId: actor.orgId,
        ownerPartyId,
        propertyId,
        apartmentId,
        listingId,
        tenancyId: c.tenancyId ?? null,
        statementMonth: monthStart,
        transactionDate: c.dueDate, // the rent charge's own due date
        direction: "income",
        category: rentCategory,
        amount: collectedString(c.amount, c.outstandingAmount, rentFamilyNetAdj.get(c.id) ?? 0),
        sstAmount: null,
        ...syncDefaults(rentCategory),
        // PART 2: the rent row's paymentStatus follows the rent Charge's settlement.
        paymentStatus: chargeStatusToPaymentStatus(c.status),
        includeInPayout: true,
        attachmentKeys: c.attachmentKeys ?? [], // 2b-5: carry proof bundle from Charge
        sourceType: "rent",
        sourceChargeId: c.id,
        status: "active",
        createdById: SYNC_ACTOR_ID,
        updatedById: SYNC_ACTOR_ID,
      },
    });
  }

  // 1b) Letting commission — an INFORMATIONAL row per commission charge.
  //
  //     In the commission month the tenant's rent is KAEN's revenue, not the owner's, so
  //     there is no income row and no payout. Before this the owner simply saw a blank
  //     month plus an unexplained 8% SST deduction. This row answers "where did my first
  //     month's rent go?" without moving a cent: direction "informational" +
  //     includeInPayout:false means it is skipped by every total, by the tax summary, and
  //     by the per-income-line management fee.
  for (const c of lettingCommissionCharges) {
    const listingId = c.unitId ?? null;
    const propertyId = (listingId && listingToProperty.get(listingId)) || fallbackPropertyId!;
    const apartmentId = (listingId && listingToApartment.get(listingId)) ?? null;
    const commissionCategory: OwnerLedgerCategory = "letting_commission";
    planned.push({
      probe: { organizationId: actor.orgId, sourceType: "letting_commission", sourceChargeId: c.id },
      data: {
        organizationId: actor.orgId,
        ownerPartyId,
        propertyId,
        apartmentId,
        listingId,
        tenancyId: c.tenancyId ?? null,
        statementMonth: monthStart,
        transactionDate: c.dueDate,
        direction: "informational",
        category: commissionCategory,
        amount: collectedString(c.amount, c.outstandingAmount, rentFamilyNetAdj.get(c.id) ?? 0),
        sstAmount: null,
        ...syncDefaults(commissionCategory),
        description: "First month rental retained by KAEN as Admin Fee",
        paymentStatus: chargeStatusToPaymentStatus(c.status),
        // NON-NEGOTIABLE: the owner never receives this rent. Hardcoded rather than
        // inherited so a later edit to the category defaults cannot start paying it out.
        includeInPayout: false,
        attachmentKeys: c.attachmentKeys ?? [],
        sourceType: "letting_commission",
        sourceChargeId: c.id,
        status: "active",
        createdById: SYNC_ACTOR_ID,
        updatedById: SYNC_ACTOR_ID,
      },
    });
  }

  // 2) Statement expenses — per child Charge. The PURE "which statement rows should exist"
  //    decision (category map, display-only-utility skip, SST-on-exactly-one-management_fee
  //    row, includeInPayout) is the shared expectedStatementLedgerRows — REUSED verbatim by
  //    R5 recon so the two can never diverge — and here we layer on the per-charge
  //    property/apartment/tenancy/paid-on-behalf context. Output is byte-identical to the
  //    prior inline loop (proven by the sync gross / sync-reverse / statement-section suites)
  //    aside from seam #1's active-note netting.
  //
  //    Seam #1: build ONE batched adjustments map across ALL statement charge IDs (never one
  //    query per charge), then hand it to expectedStatementLedgerRows for every statement —
  //    the SAME map R5 recon builds from the SAME helper, so the two can never net differently.
  const allStatementChargeIds = statements.flatMap((s) => s.charges.map((c) => c.id));
  const adjustmentsByChargeId = await netAdjustmentsByChargeId(db, actor.orgId, allStatementChargeIds);
  for (const statement of statements) {
    const chargeById = new Map(statement.charges.map((c) => [c.id, c]));
    for (const exp of expectedStatementLedgerRows(statement, statement.charges, adjustmentsByChargeId)) {
      const ch = chargeById.get(exp.sourceChargeId)!;
      const listingId = ch.unitId ?? null;
      // fallbackPropertyId is non-null HERE because only LISTING owners receive
      // owner_statement rows today (generateStatementService skips carpark-only
      // owners), so this loop never iterates when fallbackPropertyId is null.
      // (Invoice.propertyId is currently always null for combined statements, so the
      // resolved value is the charge's listing property or the owner's fallback.)
      // TODO: when carpark-only owners can receive statements, resolve propertyId from
      // the statement's apartment/listing rather than asserting fallbackPropertyId.
      const propertyId =
        (listingId && listingToProperty.get(listingId)) || statement.propertyId || fallbackPropertyId!;
      const apartmentId = (listingId && listingToApartment.get(listingId)) ?? null;
      planned.push({
        probe: { organizationId: actor.orgId, sourceType: "statement", sourceChargeId: ch.id },
        data: {
          organizationId: actor.orgId,
          ownerPartyId,
          propertyId,
          apartmentId,
          listingId,
          tenancyId: ch.tenancyId ?? null,
          statementMonth: monthStart,
          transactionDate: monthStart,
          direction: "expense",
          category: exp.category,
          amount: exp.amount,
          sstAmount: exp.sstAmount,
          ...syncDefaults(exp.category),
          // Name the line. AFTER the syncDefaults spread deliberately — that helper
          // sets only paidBy/taxCategory, so this cannot clobber a money field. Gives
          // the §5 Expense Breakdown a real Description ("Letting commission SST
          // (owner-borne)") beside the coarse "Other" category label, instead of the
          // em-dash it showed before. Display-only.
          description: ch.description ?? null,
          // PART 2: the statement row follows its child Charge's settlement state.
          paymentStatus: chargeStatusToPaymentStatus(ch.status),
          includeInPayout: exp.includeInPayout,
          attachmentKeys: [],
          // Task 9: copy the paid-on-behalf metadata verbatim from the source Charge.
          // ADDITIVE field-copy ONLY — does NOT touch amount / sstAmount / includeInPayout
          // or any payout math. null stays null.
          payeeName: ch.payeeName ?? null,
          paidOnBehalfRef: ch.paidOnBehalfRef ?? null,
          paidOnBehalfDate: ch.paidOnBehalfDate ?? null,
          sourceType: "statement",
          sourceChargeId: ch.id,
          sourceInvoiceId: statement.id,
          status: "active",
          createdById: SYNC_ACTOR_ID,
          updatedById: SYNC_ACTOR_ID,
        },
      });
    }
  }

  // 3) Utility expenses — GROSS: one row per FULL per-category supplier bill
  //    amount on the bill (tnb / water / indah / cleaning / wifi), each
  //    includeInPayout:true and keyed on a distinct sourceType so the SAME bill
  //    can carry up to five idempotent rows (no schema change). A zero/absent
  //    category amount books nothing.
  //
  //    The apartments that actually receive a gross expense row are recorded as we
  //    go — Source 4 below reads this to tell a PAIRED carve-out (offsets a real
  //    supplier-bill expense) from an UNPAIRED one (nothing to offset). Built from
  //    the rows genuinely pushed, not from "a charged bill exists", so a charged
  //    bill whose categories are all zero counts as unpaired — which it is.
  const apartmentsWithGrossUtilityExpense = new Set<string>();
  for (const bill of utilityBills) {
    // M-1: book the FULL supplier bill as an owner expense ONLY once the bill is
    // CHARGED. A draft (or void) bill has no tenant carve-out charges yet (Source 4),
    // so booking the gross expense now would debit the owner the whole bill with no
    // carve-out income to net it down → owner overstated as owing. Skip non-charged.
    if (bill.status !== "charged") continue;
    // fallbackPropertyId is non-null here: utilityBills is non-empty only when
    // apartmentIds is non-empty, which means ownedListings is non-empty → set.
    const propertyId = apartmentToProperty.get(bill.apartmentId) || fallbackPropertyId!;
    // PART 2: roll up the tenant Charges this bill raised → the utility rows'
    // paymentStatus (draft bill → pending; charged → derived from the charges).
    const billChargeStatuses = bill.allocations
      .map((a) => (a.chargeId !== null ? utilityChargeStatusById.get(a.chargeId) : undefined))
      .filter((s): s is string => s !== undefined);
    const utilPaymentStatus = utilityBillPaymentStatus(bill.status, billChargeStatuses);
    for (const def of UTILITY_BILL_CATEGORY_ROWS) {
      const raw = bill[def.field];
      if (raw == null) continue;
      if (Number(raw.toString()) <= 0) continue;
      apartmentsWithGrossUtilityExpense.add(bill.apartmentId);
      planned.push({
        // utility rows carry NO sourceChargeId — probe on (sourceType, sourceUtilityBillId).
        probe: { organizationId: actor.orgId, sourceType: def.sourceType, sourceUtilityBillId: bill.id },
        data: {
          organizationId: actor.orgId,
          ownerPartyId,
          propertyId,
          apartmentId: bill.apartmentId,
          listingId: null,
          tenancyId: null,
          statementMonth: monthStart,
          transactionDate: monthStart,
          direction: "expense",
          category: def.category,
          amount: decString(raw),
          sstAmount: null,
          ...syncDefaults(def.category),
          paymentStatus: utilPaymentStatus,
          includeInPayout: true,
          attachmentKeys: [],
          sourceType: def.sourceType,
          sourceChargeId: null,
          sourceUtilityBillId: bill.id,
          status: "active",
          createdById: SYNC_ACTOR_ID,
          updatedById: SYNC_ACTOR_ID,
        },
      });
    }
  }

  // 3b) Source 7 — the grid's RAW provider bills as owner expenses, completing the
  //     gross pair for PARTITIONED units (see gridProviderBillDeducts for the rules
  //     and for why absorbed / tenant_direct / unbilled book nothing).
  const plannedGridSourceTypes = new Set<string>();
  for (const entry of gridEntries) {
    const listingMode = apartmentToListingMode.get(entry.apartmentId) ?? null;
    const propertyId = apartmentToProperty.get(entry.apartmentId) || fallbackPropertyId!;
    for (const def of GRID_PROVIDER_BILL_ROWS) {
      const raw = entry[def.rawField];
      const rawAmount = raw == null ? null : Number(raw.toString());
      if (!gridProviderBillDeducts({
        listingMode,
        billed: entry.billedAt != null,
        pattern: entry[def.patternField],
        rawAmount,
      })) continue;
      plannedGridSourceTypes.add(def.sourceType);
      planned.push({
        // No sourceChargeId / sourceUtilityBillId exists for a grid entry — identity
        // is (sourceType, apartmentId, statementMonth), unique by the grid's own
        // @@unique(organizationId, apartmentId, periodMonth).
        probe: {
          organizationId: actor.orgId,
          sourceType: def.sourceType,
          apartmentId: entry.apartmentId,
          statementMonth: monthStart,
        },
        data: {
          organizationId: actor.orgId,
          ownerPartyId,
          propertyId,
          apartmentId: entry.apartmentId,
          listingId: null,
          tenancyId: null,
          statementMonth: monthStart,
          transactionDate: monthStart,
          direction: "expense",
          category: def.category,
          amount: decString(raw!),
          sstAmount: null,
          ...syncDefaults(def.category),
          // KAEN fronted the supply and the tenants have been billed for it; the
          // owner's real position is this bill netted against that income.
          paymentStatus: "paid",
          includeInPayout: true,
          attachmentKeys: [],
          sourceType: def.sourceType,
          sourceChargeId: null,
          sourceUtilityBillId: null,
          status: "active",
          createdById: SYNC_ACTOR_ID,
          updatedById: SYNC_ACTOR_ID,
        },
      });
    }
  }

  // 4) Task 2a-2 — Tenant-borne income (Source 4): utility + aircond Charges on the
  //    owner's units billed to tenants. These are the "pass-through" income rows —
  //    the owner sees what each tenant was billed for utilities/aircond (with payment
  //    status). The gross/pass-through model (spec §10b) requires them as income
  //    (direction: "income") so they appear in grossRental and the Payout Summary.
  //
  //    Idempotency: each row carries sourceType "tenant_utility" or "tenant_aircond"
  //    + the tenant Charge id as sourceChargeId. The existing DB
  //    @@unique([organizationId, sourceType, sourceChargeId]) covers them — no new
  //    unique constraint needed.
  //
  //    GROSS pairing: Source 3 books the FULL supplier bill per category as an
  //    expense; Source 4 books the tenant carve-out as income. Both are in the
  //    payout — the full bill MINUS the carve-out nets to the owner's real share
  //    (e.g. full TNB 188.70 − tenant aircond 8.46 = owner bears 180.24).
  //
  //    Note: aircond charges are NOT linked via UtilityAllocation — they come from
  //    AircondMeter separately. We query all chargeType in ["utility","aircond"] on
  //    the owner's units in the month to cover both paths in one query.
  const tenantBorneCharges = unitIds.length
    ? await db.charge.findMany({
        where: {
          organizationId: actor.orgId,
          unitId: { in: unitIds },
          chargeType: { in: ["utility", "aircond"] },
          dueDate: { gte: monthStart, lte: monthEnd },
          status: { notIn: ["void", "credited"] },
          // Finding C discriminator: Source 4 is TENANT-borne income, so exclude any
          // charge billed to the OWNER (partyId === ownerPartyId). Without this, the
          // bills-grid OWNER-billed utility charges on the owner's own listings —
          // `GRIDOWN-*` AND owner-borne `GRIDRECUR-*` (both chargeType:"utility",
          // partyId:ownerPartyId) — matched this query and were mis-booked as tenant
          // income (a latent owner-overpayout the moment their outstanding moved).
          // A partyId filter (not a chargeNumber prefix) is required because the
          // `GRIDRECUR-` prefix is SHARED with tenant-borne recurring carve-outs.
          // Safe against dropping a real carve-out: `Charge.partyId` is NON-NULLABLE,
          // and every legitimate tenant carve-out mint (GRIDUTIL / GRIDRECUR-tenant /
          // meter UTIL / meter AC) sets partyId to the TENANT party, never the owner's.
          partyId: { not: ownerPartyId },
        },
        select: {
          id: true,
          unitId: true,
          tenancyId: true,
          chargeType: true,
          amount: true,
          outstandingAmount: true,
          dueDate: true,
          status: true,
          attachmentKeys: true, // 2b-5: carry proof bundle through to ledger entry
        },
      })
    : [];

  // Same CN/DN netting as Source 1 — a GRIDUTIL/GRIDRECUR carve-out with an
  // active note must book what the tenant actually owes/paid, not the raw mint.
  const tenantBorneNetAdj = await netAdjustmentsByChargeId(
    db,
    actor.orgId,
    tenantBorneCharges.map((c) => c.id),
  );

  for (const c of tenantBorneCharges) {
    const listingId = c.unitId ?? null;
    // fallbackPropertyId is non-null here: tenantBorneCharges is non-empty only when
    // unitIds is non-empty, which means ownedListings is non-empty → set.
    const propertyId = (listingId && listingToProperty.get(listingId)) || fallbackPropertyId!;
    const apartmentId = (listingId && listingToApartment.get(listingId)) ?? null;
    const sourceType = c.chargeType === "aircond" ? "tenant_aircond" : "tenant_utility";
    const category: OwnerLedgerCategory = c.chargeType === "aircond" ? "aircond_income" : "utility_income";
    planned.push({
      probe: { organizationId: actor.orgId, sourceType, sourceChargeId: c.id },
      data: {
        organizationId: actor.orgId,
        ownerPartyId,
        propertyId,
        apartmentId,
        listingId,
        tenancyId: c.tenancyId ?? null,
        statementMonth: monthStart,
        transactionDate: c.dueDate,
        direction: "income",
        category,
        amount: collectedString(c.amount, c.outstandingAmount, tenantBorneNetAdj.get(c.id) ?? 0),
        sstAmount: null,
        ...syncDefaults(category),
        paymentStatus: chargeStatusToPaymentStatus(c.status),
        // C1 GROSS: a PAIRED tenant carve-out is part of the payout — it offsets the
        // full-bill expense (Source 3) so the pair nets to the owner's share. An
        // UNPAIRED one (whole unit, no supplier-bill expense booked — the bills-grid
        // path, which never writes a UnitUtilityBill) is tenant money passing through
        // KAEN to the supplier: it stays VISIBLE on the statement but must not inflate
        // the payout. See tenantCarveOutIncludeInPayout for the two guards.
        includeInPayout: tenantCarveOutIncludeInPayout({
          listingMode: apartmentId != null ? (apartmentToListingMode.get(apartmentId) ?? null) : null,
          apartmentHasGrossUtilityExpense:
            apartmentId != null && apartmentsWithGrossUtilityExpense.has(apartmentId),
        }),
        attachmentKeys: c.attachmentKeys ?? [], // 2b-5: carry proof bundle from Charge
        sourceType,
        sourceChargeId: c.id,
        status: "active",
        createdById: SYNC_ACTOR_ID,
        updatedById: SYNC_ACTOR_ID,
      },
    });
  }

  // 5) Task 4.4 — Carpark income (new model). Charges with carparkId set have
  //    unitId:null, so they are invisible to the Source-1 unitId-IN-unitIds fetch.
  //    Each carpark charge uses sourceType:"carpark" (distinct from "rent") so the
  //    @@unique([organizationId, sourceType, sourceChargeId]) gives idempotency for
  //    free — no schema change required.
  const carparkCharges = carparkIds.length
    ? await db.charge.findMany({
        where: {
          organizationId: actor.orgId,
          carparkId: { in: carparkIds },
          chargeType: "carpark",
          dueDate: { gte: monthStart, lte: monthEnd },
          status: { notIn: ["void", "credited"] },
        },
        select: {
          id: true,
          carparkId: true,
          tenancyId: true,
          amount: true,
          outstandingAmount: true,
          dueDate: true,
          status: true,
          attachmentKeys: true,
        },
      })
    : [];

  // Same CN/DN netting as Sources 1/4 for the carpark charges' collected figure.
  const carparkNetAdj = await netAdjustmentsByChargeId(
    db,
    actor.orgId,
    carparkCharges.map((c) => c.id),
  );

  for (const c of carparkCharges) {
    const cp = carparkById.get(c.carparkId!);
    if (!cp) continue; // should never happen — charge is scoped to ownerPartyId's carparks
    planned.push({
      probe: { organizationId: actor.orgId, sourceType: "carpark", sourceChargeId: c.id },
      data: {
        organizationId: actor.orgId,
        ownerPartyId,
        propertyId: cp.propertyId,
        apartmentId: cp.apartmentId,
        listingId: null,
        tenancyId: c.tenancyId ?? null,
        statementMonth: monthStart,
        transactionDate: c.dueDate,
        direction: "income",
        category: "carpark_income",
        amount: collectedString(c.amount, c.outstandingAmount, carparkNetAdj.get(c.id) ?? 0),
        sstAmount: null,
        ...syncDefaults("carpark_income"),
        paymentStatus: chargeStatusToPaymentStatus(c.status),
        includeInPayout: true,
        attachmentKeys: c.attachmentKeys ?? [],
        sourceType: "carpark",
        sourceChargeId: c.id,
        status: "active",
        createdById: SYNC_ACTOR_ID,
        updatedById: SYNC_ACTOR_ID,
      },
    });
  }

  // ── Apply: create / update / skip per planned row, in ONE transaction with one
  //    audit row. Idempotency + the admin-edit guard live here. ──
  const counts: SyncCounts = { created: 0, updated: 0, skipped: 0, reversed: 0 };

  await db.$transaction(async (tx) => {
    // C2: serialize concurrent syncs for the same (owner, month) so the
    // read-then-write in this loop cannot interleave with another call and
    // produce duplicate utility rows. The lock is transaction-scoped
    // (pg_advisory_xact_lock) — automatically released on COMMIT / ROLLBACK.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-ledger:${actor.orgId}:${input.ownerPartyId}:${input.month}`}))`;

    for (const p of planned) {
      const existing = await tx.ownerLedgerEntry.findFirst({
        where: p.probe,
        select: { id: true, updatedById: true },
      });

      if (!existing) {
        await tx.ownerLedgerEntry.create({ data: p.data });
        counts.created += 1;
        continue;
      }

      // An admin (or anything non-sync) touched this row → leave it alone.
      if (existing.updatedById !== SYNC_ACTOR_ID) {
        counts.skipped += 1;
        continue;
      }

      // Still sync-owned → refresh the derived fields from source. PART 2: also
      // refresh paymentStatus, so a re-sync after the tenant pays flips the owner
      // row from pending → paid (the whole point of driving it from real state).
      await tx.ownerLedgerEntry.update({
        where: { id: existing.id },
        data: {
          amount: p.data.amount,
          sstAmount: p.data.sstAmount ?? null,
          paymentStatus: p.data.paymentStatus,
          // C1 fix: refresh includeInPayout too, so a re-sync self-heals any
          // pre-fix statement-utility row that was created includeInPayout:true.
          includeInPayout: p.data.includeInPayout,
          // Task 9: keep the display-only paid-on-behalf metadata in lock-step with
          // the source Charge on re-sync (still-sync-owned rows only). null clears.
          payeeName: p.data.payeeName ?? null,
          paidOnBehalfRef: p.data.paidOnBehalfRef ?? null,
          paidOnBehalfDate: p.data.paidOnBehalfDate ?? null,
          // Display-only line name, kept in lock-step with the source Charge on
          // re-sync (still-sync-owned rows only). MUST be in this allowlist, not
          // just on the create path: every ledger row that predates the description
          // being carried through was written with null, and would otherwise keep
          // rendering as a bare "Other" with an em-dash description forever. A
          // re-sync now self-heals them. null clears, matching the fields above.
          description: p.data.description ?? null,
          updatedById: SYNC_ACTOR_ID,
        },
      });
      counts.updated += 1;
    }

    // ── Reverse pass (spec §4.3): void sync-owned rows whose SOURCE is now
    //    void/credited. Admin-edited rows (updatedById !== SYNC_ACTOR_ID) keep
    //    the never-touch rule. Covers all three source kinds:
    //      • sourceChargeId       → Charge.status ∈ {void, credited}
    //      • sourceInvoiceId      → owner_statement Invoice.status = "void"
    //        (a whole-statement void leaves child charges' own status intact,
    //        so the charge check alone would miss these rows)
    //      • sourceUtilityBillId  → UnitUtilityBill.status = "void"
    const candidates = await tx.ownerLedgerEntry.findMany({
      where: {
        organizationId: actor.orgId,
        ownerPartyId,
        statementMonth: monthStart,
        status: "active",
        updatedById: SYNC_ACTOR_ID,
      },
      select: { id: true, sourceType: true, sourceChargeId: true, sourceInvoiceId: true, sourceUtilityBillId: true },
    });
    const srcChargeIds = [...new Set(candidates.map((r) => r.sourceChargeId).filter((v): v is string => v !== null))];
    const srcInvoiceIds = [...new Set(candidates.map((r) => r.sourceInvoiceId).filter((v): v is string => v !== null))];
    const srcBillIds = [...new Set(candidates.map((r) => r.sourceUtilityBillId).filter((v): v is string => v !== null))];
    // Finding-C self-heal (money): Source-4 income rows (tenant carve-out) whose source Charge is
    // OWNER-billed (partyId === ownerPartyId) were mis-booked as tenant income before Finding C
    // excluded owner-billed utility/aircond charges from CREATION. Their source charge is neither
    // void nor credited, so the dead-charge check below misses them; collect those charge ids so a
    // single targeted partyId probe can flag the owner-billed ones for voiding. Gathered from the
    // Source-4 sourceTypes ONLY, so a legit owner-billed Source-6 owner_borne_expense deduction is
    // never gathered here.
    const source4ChargeIds = [
      ...new Set(
        candidates
          .filter((r) => SOURCE4_INCOME_SOURCE_TYPES.has(r.sourceType) && r.sourceChargeId !== null)
          .map((r) => r.sourceChargeId as string),
      ),
    ];
    const [deadCharges, deadInvoices, deadBills, ownerBilledSource4Charges] = await Promise.all([
      srcChargeIds.length
        ? tx.charge.findMany({
            where: { organizationId: actor.orgId, id: { in: srcChargeIds }, status: { in: ["void", "credited"] } },
            select: { id: true },
          })
        : Promise.resolve([]),
      srcInvoiceIds.length
        ? tx.invoice.findMany({
            where: { organizationId: actor.orgId, id: { in: srcInvoiceIds }, status: "void" },
            select: { id: true },
          })
        : Promise.resolve([]),
      srcBillIds.length
        ? tx.unitUtilityBill.findMany({
            where: { organizationId: actor.orgId, id: { in: srcBillIds }, status: "void" },
            select: { id: true },
          })
        : Promise.resolve([]),
      // Owner-billed probe for the Source-4 self-heal: which candidate Source-4 charges are billed
      // to the OWNER (partyId === ownerPartyId). Status-agnostic — a mis-booked owner-billed charge
      // is typically still active/posted (which is exactly why the dead-charge check misses it).
      source4ChargeIds.length
        ? tx.charge.findMany({
            where: { organizationId: actor.orgId, id: { in: source4ChargeIds }, partyId: ownerPartyId },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const deadChargeSet = new Set(deadCharges.map((c) => c.id));
    const deadInvoiceSet = new Set(deadInvoices.map((i) => i.id));
    const deadBillSet = new Set(deadBills.map((b) => b.id));
    const ownerBilledSource4ChargeSet = new Set(ownerBilledSource4Charges.map((c) => c.id));
    for (const row of candidates) {
      const sourceDead =
        (row.sourceChargeId !== null && deadChargeSet.has(row.sourceChargeId)) ||
        (row.sourceInvoiceId !== null && deadInvoiceSet.has(row.sourceInvoiceId)) ||
        (row.sourceUtilityBillId !== null && deadBillSet.has(row.sourceUtilityBillId));
      // Finding-C self-heal: a still-sync-owned Source-4 income row whose source Charge is
      // owner-billed (partyId === ownerPartyId) — a pre-Finding-C mis-booking the dead-charge
      // check misses (the charge is neither void nor credited) — is a latent owner-overpayout.
      // Void it here. Gated on BOTH the row's own Source-4 sourceType AND owner-billed membership,
      // so it can never touch a Source-6 owner_borne_expense deduction or any other source.
      const misBookedOwnerBilledSource4 =
        SOURCE4_INCOME_SOURCE_TYPES.has(row.sourceType) &&
        row.sourceChargeId !== null &&
        ownerBilledSource4ChargeSet.has(row.sourceChargeId);
      // Source-7 stale sweep. A grid provider-bill row carries NO source id, so the
      // dead-source checks above can never reach it — yet the conditions that justify
      // it are all mutable (the pattern can flip to "absorbed", the entry can be
      // un-billed, the raw amount can be cleared). A row left behind after that keeps
      // deducting a bill the owner is now separately invoiced for, i.e. charges them
      // twice. Voiding any sync-owned grid row this run did NOT re-plan keeps the
      // ledger a faithful projection of the entry's CURRENT state.
      const staleGridProviderBill =
        GRID_PROVIDER_BILL_SOURCE_TYPES.has(row.sourceType) && !plannedGridSourceTypes.has(row.sourceType);
      if (!sourceDead && !misBookedOwnerBilledSource4 && !staleGridProviderBill) continue;
      await tx.ownerLedgerEntry.update({
        where: { id: row.id },
        data: { status: "void", updatedById: SYNC_ACTOR_ID },
      });
      counts.reversed += 1;
      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId, // REAL actor (User FK) — never the sentinel
        actorRole: actor.actorRole,
        action: "owner_ledger.entry.reverse_synced",
        entityType: "OwnerLedgerEntry",
        entityId: row.id,
        meta: {
          month,
          sourceChargeId: row.sourceChargeId,
          sourceInvoiceId: row.sourceInvoiceId,
          sourceUtilityBillId: row.sourceUtilityBillId,
        } as unknown as Prisma.InputJsonValue,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }

    await recordAudit(tx, {
      organizationId: actor.orgId,
      actorUserId: actor.actorUserId, // REAL actor (User FK) — never the sentinel
      actorRole: actor.actorRole,
      action: "owner_ledger.sync",
      entityType: "OwnerLedgerEntry",
      entityId: ownerPartyId,
      meta: { month, ...counts } as unknown as Prisma.InputJsonValue,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  });

  // Materialize per-unit figures for the Units tab (best-effort — NEVER rolls
  // back the sync above; mirrors the swallow-and-record-drift hook contract).
  // Gated on the read flag: when dark, we skip the write entirely so behavior is
  // truly identical to today and no rows accrue before go-live (backfill seeds
  // them at flip time).
  if (isPhase2FlagEnabled("ENABLE_UNIT_MONTH_LEDGER")) {
    try {
      const { materializeOwnerUnitMonths } = await import("./unit-month-ledger.materialize");
      await materializeOwnerUnitMonths(
        { orgId: actor.orgId, actorUserId: actor.actorUserId, actorRole: actor.actorRole as "admin" | "manager" | "editor" },
        ownerPartyId,
        month,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[unit-month-ledger] materialize after sync failed (swallowed):", e);
    }
  }

  return { ok: true as const, status: 200, data: counts };
}

// ─── Forward reversal into the current open month (Task 7) ───────────────────
//
// When a source Charge booked into a FROZEN month is voided/credited, the frozen
// month's ledger rows stay immutable (the freeze guard above blocks a rebuild).
// The correction flows FORWARD: for each still-active source-charge row in the frozen
// month whose source Charge is now void/credited, post a reversing OwnerLedgerEntry into
// the CURRENT open month sized so owner-recognised income for that charge nets to ZERO.
//
// Idempotent by the EXISTING @@unique([organizationId, sourceType, sourceChargeId]):
// the reversal carries sourceType "reversal" + the original sourceChargeId → a
// tuple distinct from the original row's (whose sourceType is "rent"/"statement"/…),
// so upsert with update:{} is a no-op on repeat → NO compounding duplicates.
//
// Net-cash (not paymentStatus): the holdback target nets BOTH the frozen collected cash
// AND any post-freeze prior_period_collection, less collection-reversals. A charge that
// collected nothing (pending at freeze, no post-freeze cash) yields target 0 → no reversal,
// so scanning all rows (not just paid ones) is safe AND fixes the Case-B over-credit where
// an unpaid-at-freeze charge collected post-freeze then voided kept its cash as owner income.
//
// Self-discovers voided charges (no chargeId threading) by scanning the frozen
// month's rows — the caller passes only (owner, frozenMonth).
export async function postForwardReversalForFrozenMonth(
  actor: OwnerLedgerActorCtx,
  ownerPartyId: string,
  frozenMonth: string, // "YYYY-MM"
): Promise<{ reversed: number }> {
  const db = getDb();
  const [fy, fm] = frozenMonth.split("-").map(Number);
  const frozenStart = new Date(Date.UTC(fy!, fm! - 1, 1));
  // ALL still-active source-charge rows booked into the frozen month — regardless of
  // paymentStatus. The old paymentStatus:"paid" filter skipped a frozen row that was
  // pending/partial at freeze but whose charge later collected cash post-freeze (a
  // prior_period_collection) and was then voided — leaving that post-freeze cash
  // recognised as owner income with no holdback (Case B over-credit). Net cash, not the
  // frozen-row status, decides the holdback below: a row that collected nothing pre- AND
  // post-freeze nets to a target of 0 (no reversal), so including pending/partial rows is
  // safe and byte-identical for the paid-at-freeze case (ppcC = 0).
  const originals = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      statementMonth: frozenStart,
      status: "active",
      // EXCLUDE the COMPLETE forward-source-type family — not just "reversal". A FORWARD
      // row (prior_period_collection / _reversal / reversal_forward_adjustment /
      // prior_period_adjustment) posted into a then-open month that LATER froze is an
      // active, non-"reversal" row carrying a sourceChargeId in this frozen statementMonth;
      // the old `not: "reversal"` swept it into `originals` and mistook it for the frozen
      // NORMAL row, double-counting the same cash (frozenCollectedC = row.amount AND +ppcC)
      // and inflating the write-once holdback → owner income booked negative (Finding 1).
      sourceType: { notIn: FORWARD_SOURCE_TYPES },
      sourceChargeId: { not: null },
    },
  });
  if (originals.length === 0) return { reversed: 0 };
  // Of those, which source charges are now voided/credited at source?
  const changed = await db.charge.findMany({
    where: {
      organizationId: actor.orgId,
      id: { in: originals.map((o) => o.sourceChargeId!) },
      status: { in: ["void", "credited"] },
    },
    select: { id: true },
  });
  const changedIds = new Set(changed.map((c) => c.id));

  // The holdback nets ALL owner-recognised cash for a void/credited charge to ZERO, across
  // both the frozen collected figure AND the post-freeze forward-collection stream, reversing
  // each exactly ONCE. postPriorPeriodCollections (which the sync-hook runs FIRST within one
  // fire) books, per post-freeze allocation EVENT: a prior_period_collection (+cash collected)
  // and, per PaymentAllocationReversal, a prior_period_collection_reversal (−cash clawed back);
  // both are append-only and independent of charge status. Build two per-charge cent maps over
  // that stream:
  //   ppcC         = Σ active prior_period_collection          (post-freeze cash collected)
  //   priorPpcRevC = Σ active prior_period_collection_reversal (post-freeze cash already clawed back)
  // Holdback target (floored at 0 — never post a negative reversal; a residual negative is
  // caught by R5 recon's booked<0 band):
  //   target = max(0, frozen_collected + ppcC − priorPpcRevC)
  // Bug-2 (review Scen2): the −priorPpcRevC term keeps a collection-reversal from being
  // double-debited here. Case B: the +ppcC term holds back an un-refunded post-freeze
  // collection. Plain paid-at-freeze void (ppcC = priorPpcRevC = 0): reverses the full
  // frozen_collected once — byte-identical to the original contract.
  const ppcC = new Map<string, number>();
  const priorPpcReversalC = new Map<string, number>();
  if (changedIds.size > 0) {
    const forwardRows = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: actor.orgId,
        ownerPartyId,
        status: "active",
        sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal"] },
        sourceChargeId: { in: [...changedIds] },
      },
      select: { sourceChargeId: true, amount: true, sourceType: true },
    });
    for (const r of forwardRows) {
      const k = r.sourceChargeId!;
      const c = Math.round(Number(r.amount.toString()) * 100);
      const target = r.sourceType === "prior_period_collection" ? ppcC : priorPpcReversalC;
      target.set(k, (target.get(k) ?? 0) + c);
    }
  }

  const now = new Date();
  const curMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Frozen-status of an owner-statement month (combined scope, apartmentId:null — the freeze
  // unit), cached across the loop so a multi-charge fire never re-reads the same period.
  const frozenMonthCache = new Map<number, boolean>();
  const monthIsFrozen = async (monthStart: Date): Promise<boolean> => {
    const key = monthStart.getTime();
    const cached = frozenMonthCache.get(key);
    if (cached !== undefined) return cached;
    const p = await findPeriod(actor.orgId, { ownerPartyId, apartmentId: null, periodMonth: monthStart });
    const frozen = p?.status === "frozen";
    frozenMonthCache.set(key, frozen);
    return frozen;
  };
  let reversed = 0;
  for (const o of originals) {
    if (!changedIds.has(o.sourceChargeId!)) continue;
    // RECONCILE the forward reversal to the CURRENT net on EVERY fire (self-heal). Owner income
    // for a void/credited charge must net to ZERO across cash collected BEFORE the freeze
    // (frozen_collected) AND after it (prior_period_collection), less collection-reversals:
    //   target = max(0, frozen_collected + Σppc − Σ active prior_period_collection_reversal(charge))
    // postPriorPeriodCollections (which the sync-hook runs FIRST) already claws back its share via
    // prior_period_collection_reversal rows; the +Σppc term holds an un-refunded post-freeze
    // collection back (Case B). With no post-freeze cash (ppcC = 0) this is byte-identical to the
    // plain paid-at-freeze contract.
    const frozenCollectedC = Math.round(Number(o.amount.toString()) * 100);
    const targetC = Math.max(
      0,
      frozenCollectedC + (ppcC.get(o.sourceChargeId!) ?? 0) - (priorPpcReversalC.get(o.sourceChargeId!) ?? 0),
    );
    // Reversal canonical direction = OPPOSITE the original (income↔expense). A reversal-family row
    // in this direction is a holdback (+); one in the original direction is a give-back (−).
    const reversalDir = o.direction === "income" ? "expense" : "income";

    // The write-once `reversal` row (org,"reversal",sourceChargeId) — matched status-agnostically
    // (the partial index has no status predicate); its statementMonth drives the frozen gate.
    const existing = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: actor.orgId, ownerPartyId, sourceType: "reversal", sourceChargeId: o.sourceChargeId },
      select: { id: true, amount: true, status: true, statementMonth: true },
    });

    // ── FROZEN-IMMUTABILITY GATE ──────────────────────────────────────────────────────────
    // The `reversal` row may be reconciled IN PLACE only while ITS month is still OPEN. Once
    // that month FROZE the row is manifest-snapshotted + PDF-issued — a plain in-place update
    // (below) would mutate it, breaching frozen immutability (and tripping R6). So post the DELTA
    // FORWARD into the current open month as a `reversal_forward_adjustment`, keeping
    // Σ(reversal-family, signed) == targetC while every frozen row stays byte-identical. (A
    // `reversal` in an OPEN month never accreted a forward adjustment — periods never un-freeze —
    // so the open path below stays byte-identical to the prior contract.)
    if (existing && (await monthIsFrozen(existing.statementMonth))) {
      await reconcileForwardAdjustmentIntoOpenMonth({ actor, ownerPartyId, template: o, targetC, reversalDir, curMonth, now, frozenMonth });
      reversed++;
      continue;
    }

    if (targetC <= 0) {
      // Fully clawed back by collection-reversals → no forward reversal should stand; void any
      // previously-posted (now stale) OPEN one so the frozen cash is reversed exactly once.
      if (existing && existing.status === "active") {
        await db.ownerLedgerEntry.update({
          where: { id: existing.id },
          data: { status: "void", updatedById: actor.actorUserId },
        });
      }
      continue;
    }

    const targetAmount = (targetC / 100).toFixed(2);
    if (existing) {
      // OPEN `reversal` row → reconcile in place to `target` (byte-identical to the prior
      // contract): repair a stale amount, or re-activate a row wrongly voided by an earlier fire.
      const needsFix =
        existing.status !== "active" || Math.round(Number(existing.amount.toString()) * 100) !== targetC;
      if (needsFix) {
        await db.ownerLedgerEntry.update({
          where: { id: existing.id },
          data: { amount: targetAmount, status: "active", updatedById: actor.actorUserId },
        });
      }
      reversed++;
      continue;
    }

    // No row yet → insert the `reversal` into the current open month. Flip direction (payout rows
    // carry no sourceChargeId so never reach here). ON CONFLICT DO NOTHING keeps concurrent fires safe.
    await db.ownerLedgerEntry.createMany({
      data: [
        {
          organizationId: actor.orgId,
          ownerPartyId,
          propertyId: o.propertyId,
          apartmentId: o.apartmentId,
          listingId: o.listingId,
          tenancyId: o.tenancyId,
          statementMonth: curMonth,
          transactionDate: now,
          direction: reversalDir,
          category: o.category,
          // Every forward `reversal` row exists because its source charge is now
          // void/credited (the changedIds gate) — so the retained cash is the tenant's
          // credit, not owner income. Describe that truthfully for the owner statement.
          description: `Owner payout holdback — voided/credited charge, tenant credit outstanding (${o.category}, from ${frozenMonth})`,
          amount: targetAmount,
          sstAmount: o.sstAmount,
          paidBy: o.paidBy,
          paymentStatus: "paid",
          includeInPayout: o.includeInPayout,
          sourceType: "reversal",
          sourceChargeId: o.sourceChargeId,
          status: "active",
          createdById: actor.actorUserId,
          updatedById: actor.actorUserId,
        },
      ],
      skipDuplicates: true,
    });
    reversed++;
  }
  return { reversed };
}

// ─── Forward-correction into the OPEN month when the `reversal` row is FROZEN (Task 7.1) ─────
//
// The write-once `reversal` row is immutable once its statement month freezes. When the holdback
// `targetC` for a charge must change but the `reversal` (and any earlier adjustments) live in
// FROZEN month(s), the correction is carried by a single `reversal_forward_adjustment` row in the
// CURRENT open month, sized to the DELTA so the whole reversal-family nets to `targetC`:
//
//   signedFixedC = Σ over ACTIVE reversal-family rows NOT in the open month, signed in the holdback
//                  direction (reversalDir → +amount, original direction → −amount)
//   deltaC       = targetC − signedFixedC
//
//   deltaC > 0 → a holdback in reversalDir (e.g. more post-freeze cash on a void charge);
//   deltaC < 0 → a give-back in the original direction (e.g. a bounce clawed cash back — nets a
//                now-excessive frozen reversal DOWN without ever touching it);
//   deltaC = 0 → nothing to carry → void a now-stale open-month adjustment (which is OPEN, so this
//                is a legal mutation).
//
// Idempotent + race-safe on the per-(charge, statementMonth) partial unique
// (OwnerLedgerEntry_org_revFwdAdj_charge_month_key, migration 20260720100000): a re-fire in the
// same open month UPDATES the one adjustment row; once THAT month freezes, the next open month
// gets its own row (a multi-freeze chain accretes one adjustment per month). Frozen rows are only
// READ here — the sole write target is the current open month.
async function reconcileForwardAdjustmentIntoOpenMonth(p: {
  actor: OwnerLedgerActorCtx;
  ownerPartyId: string;
  template: {
    sourceChargeId: string | null;
    // propertyId is nullable on OwnerLedgerEntry (Phase-2 Task 6a: owner-level/multi-property
    // remittance payouts carry null). These charge-backed reversal templates always have a
    // non-null propertyId at runtime, so the forward-adjustment row inherits the same value;
    // the type is widened only to accept the now-nullable source row.
    propertyId: string | null;
    apartmentId: string | null;
    listingId: string | null;
    tenancyId: string | null;
    direction: string;
    category: string;
    sstAmount: Prisma.Decimal | null;
    paidBy: string;
    includeInPayout: boolean;
  };
  targetC: number;
  reversalDir: string;
  curMonth: Date;
  now: Date;
  frozenMonth: string;
}): Promise<void> {
  const { actor, ownerPartyId, template: o, targetC, reversalDir, curMonth, now, frozenMonth } = p;
  const db = getDb();
  const curTime = curMonth.getTime();

  const family = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      sourceChargeId: o.sourceChargeId,
      sourceType: { in: ["reversal", "reversal_forward_adjustment"] },
    },
    select: { id: true, sourceType: true, statementMonth: true, direction: true, amount: true, status: true },
  });

  // Partition: the single adjustable slot is the open-month adjustment (status-agnostic, so a
  // wrongly-voided one can be re-activated); everything else (the frozen `reversal` + any
  // earlier/frozen adjustments) is FIXED and only summed.
  let signedFixedC = 0;
  let curAdj: (typeof family)[number] | null = null;
  for (const r of family) {
    if (r.sourceType === "reversal_forward_adjustment" && r.statementMonth.getTime() === curTime) {
      curAdj = r;
      continue;
    }
    if (r.status === "active") {
      const c = Math.round(Number(r.amount.toString()) * 100);
      signedFixedC += r.direction === reversalDir ? c : -c;
    }
  }
  const deltaC = targetC - signedFixedC;

  if (deltaC === 0) {
    // Nothing left for the open month to carry → void a now-stale open-month adjustment.
    if (curAdj && curAdj.status === "active") {
      await db.ownerLedgerEntry.update({ where: { id: curAdj.id }, data: { status: "void", updatedById: actor.actorUserId } });
    }
    return;
  }

  // deltaC>0 → holdback (reversalDir); deltaC<0 → give-back (the original direction).
  const adjDirection = deltaC > 0 ? reversalDir : o.direction;
  const adjAmountC = Math.abs(deltaC);
  const adjAmount = (adjAmountC / 100).toFixed(2);

  if (curAdj) {
    const needsFix =
      curAdj.status !== "active" ||
      curAdj.direction !== adjDirection ||
      Math.round(Number(curAdj.amount.toString()) * 100) !== adjAmountC;
    if (needsFix) {
      await db.ownerLedgerEntry.update({
        where: { id: curAdj.id },
        data: { amount: adjAmount, direction: adjDirection, status: "active", updatedById: actor.actorUserId },
      });
    }
    return;
  }

  // No open-month adjustment yet → insert (race-safe on the per-(charge, month) partial unique).
  await db.ownerLedgerEntry.createMany({
    data: [
      {
        organizationId: actor.orgId,
        ownerPartyId,
        propertyId: o.propertyId,
        apartmentId: o.apartmentId,
        listingId: o.listingId,
        tenancyId: o.tenancyId,
        statementMonth: curMonth,
        transactionDate: now,
        direction: adjDirection,
        category: o.category,
        description:
          deltaC > 0
            ? `Owner payout holdback (forward correction) — voided/credited charge, tenant credit outstanding (${o.category}, from ${frozenMonth})`
            : `Owner payout holdback release (forward correction) — cash clawed back on voided/credited charge (${o.category}, from ${frozenMonth})`,
        amount: adjAmount,
        sstAmount: o.sstAmount,
        paidBy: o.paidBy,
        paymentStatus: "paid",
        includeInPayout: o.includeInPayout,
        sourceType: "reversal_forward_adjustment",
        sourceChargeId: o.sourceChargeId,
        status: "active",
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
      },
    ],
    skipDuplicates: true,
  });
}
