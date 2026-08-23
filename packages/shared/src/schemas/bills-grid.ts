import { z } from "zod";
import type { ScalarRecurringKind } from "../constants/scalar-recurring";

// Amount cells accept NO formula — literal numbers only (R31).
export const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amounts only");
export const periodMonth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD (first of month)");
export const uuid = z.string().uuid();

// Task 4 (bills-grid grid funded-by capture): "manager_advanced" = KAEN paid the
// provider directly and recovers from the tenant pool (recharged semantics for
// the split; fundedBy=manager for revenue-classification purposes — see
// fundedByForUtility in apps/api/src/modules/bills-grid/service.ts).
export const utilityPattern = z.enum(["recharged", "absorbed", "tenant_direct", "manager_advanced"]);
export const bearer = z.enum(["owner", "tenant"]);
export const paymentStatus = z.enum(["unpaid", "pending", "partial", "paid"]);

// ─── Settlement (READ-TIME derived payment state) ────────────────────────────
//
// DISTINCT from `paymentStatus` above. That one is a MANUALLY-set column on
// UnitBillsGridEntry (default "unpaid", deliberately untouched by the Bill —
// "billing is not payment", service.ts R10) and it drives the row EDIT LOCK.
// The vocabulary below is DERIVED at read time from the entry's live grid
// Charges + their net-of-reversal PaymentAllocations, and is DISPLAY-ONLY: it
// never gates an edit, a Bill, or any money write. Keeping the two apart is
// deliberate — making the lock follow real payments would newly freeze rows an
// admin can amend today, which is a separate decision from showing the truth.
export const settlementState = z.enum(["none", "unpaid", "partial", "paid"]);
export type SettlementState = z.infer<typeof settlementState>;

/**
 * One money column-group on the grid that can carry a settled/unsettled state.
 * `<utility><Bearer>` — the utility comes from the Charge's ChargeCategory code,
 * the bearer from the BillingDocument it was issued on (IVTEN → tenant, IVOWN →
 * owner), so it holds for utility, recurring AND expense charges alike.
 *
 * `otherOwner`/`otherTenant` are the catch-all: a charge whose category maps to
 * no grid column (e.g. sewerage, subsidy) still lands in a bucket so it is
 * counted in the ROW roll-up — it simply renders no per-cell tick. Without it a
 * genuinely-outstanding charge could vanish from the roll-up and show a row as
 * fully Paid while money is still owed.
 */
export const SETTLEMENT_GROUPS = [
  "tnb", "air", "wifi", "cleaning", "maintenance", "recurring", "expenses", "other",
] as const;
export type SettlementGroup = (typeof SETTLEMENT_GROUPS)[number];
export const SETTLEMENT_SIDES = ["Owner", "Tenant"] as const;

/** `tnbOwner` | `tnbTenant` | … — a TEMPLATE-LITERAL type over the two parts, so the
 * union and the runtime list below cannot drift: `SETTLEMENT_BUCKETS` is BUILT from
 * the same two arrays, and any `Record<SettlementBucket, …>` is exhaustive by
 * construction. Adding a group is one edit, not two that can disagree. */
export type SettlementBucket = `${SettlementGroup}${(typeof SETTLEMENT_SIDES)[number]}`;
export const SETTLEMENT_BUCKETS: readonly SettlementBucket[] = SETTLEMENT_GROUPS.flatMap((g) =>
  SETTLEMENT_SIDES.map((s) => `${g}${s}` as SettlementBucket),
);

/**
 * Grid column-group for a ChargeCategory `code` (`electricity_tenant` → `tnb`).
 * Keyed by the code's leading token; anything unrouted falls to `other`, which
 * still counts in the ROW roll-up but renders no per-cell tick — so an
 * unrecognised outstanding charge can never make a row read "Paid".
 */
const GROUP_OF_CATEGORY: Record<string, SettlementGroup> = {
  electricity: "tnb",
  water: "air",
  wifi: "wifi",
  cleaning: "cleaning",
  maintenance: "maintenance",
  recurring: "recurring",
};

/** `electricity_tenant` + tenant-side document → `tnbTenant`. */
export function settlementBucketFor(
  categoryCode: string | null,
  side: "owner" | "tenant",
  isExpense = false,
): SettlementBucket {
  const head = (categoryCode ?? "").split("_")[0] ?? "";
  const group: SettlementGroup = isExpense ? "expenses" : (GROUP_OF_CATEGORY[head] ?? "other");
  return `${group}${side === "owner" ? "Owner" : "Tenant"}`;
}

export const emptySettlementCells = (): Record<SettlementBucket, SettlementState> =>
  Object.fromEntries(SETTLEMENT_BUCKETS.map((b) => [b, "none"])) as Record<SettlementBucket, SettlementState>;

/**
 * ONE declaration of the wire shape, imported by BOTH the API DTO and the web client —
 * a hand-copied twin is exactly how the grid row types drifted before.
 */
export interface GridSettlementDto {
  /** Roll-up over EVERY live grid charge on the unit-month, tenant AND owner. A row whose
   * tenant invoice is settled but whose owner invoice is not reads "partial" — deliberately,
   * so outstanding owner money is never hidden behind a green "Paid". */
  status: SettlementState;
  /** Unit-grain state per column-group. */
  cells: Record<SettlementBucket, SettlementState>;
  /** Room-grain state, keyed by the room's `listingId` — what the per-room TNB `amount`
   * column reads, so one paid room in a PARTITIONED unit ticks while its unpaid sibling
   * does not. Empty for a whole unit whose charges carry no room. */
  rooms: Record<string, Record<SettlementBucket, SettlementState>>;
  /**
   * LINE-grain state, keyed by `GridExpense.id`.
   *
   * The `expenses{Owner,Tenant}` bucket in `cells` collapses every expense on the
   * unit-month into ONE state, so it can say "some expense money arrived" but never
   * WHICH line. That is too coarse for the expense dialog, which edits lines
   * individually — it was rendering a live <input> over a line the server had already
   * frozen, so the admin typed, saved, and got a 409 they could not have predicted.
   *
   * An SST-bearing line mints TWO charges under one `sourceGridExpenseId` (the base and
   * its `-SST` sibling, service.ts:2103-2114). Both count into this tally, so the line
   * reads "paid" only when BOTH are settled — which is why the fold counts charges
   * rather than short-circuiting on the first settled one.
   *
   * Empty for an entry whose live charges carry no `sourceGridExpenseId` (pure utilities).
   */
  expenseLines: Record<string, SettlementState>;
}

// ─── Confirm-Bill utility plan (READ-TIME, no writes) ────────────────────────

/** One utility Charge the Bills Grid's first-issuance path is prepared to mint.
 * `amount` is the exact 2-dp Charge amount (a subsidy is negative). `listingId`
 * and `tenancyId` retain room grain for partitioned units; owner lines have no
 * tenancy and use the representative owner listing when one resolves. */
export interface GridBillUtilityPlanLineDto {
  key: string;
  code: string;
  label: string;
  payer: "tenant" | "owner";
  amount: string;
  listingId: string | null;
  tenancyId: string | null;
}

/** Subsidy policy frozen for a unit-month once the additive unit-cap rail is used. */
export type GridTnbSubsidyPolicy =
  | "legacy_per_pax"
  | "unit_tnb_cap_equal_tenancy"
  | "none";

/** Exact room-grain share of the TNB amount above the owner's monthly unit cap.
 * This is explanatory only: the corresponding electricity/subsidy Charge lines
 * remain the one monetary source of truth. */
export interface GridBillTnbExcessAllocationDto {
  listingId: string;
  tenancyId: string;
  amount: string;
}

/** Informational reconciliation for the per-unit monthly TNB cap.
 * `residual = ownerPortion + tenantExcess`; the excess is split by occupied
 * tenancy/room, never by pax. It must not be rendered as an extra bill line. */
export interface GridBillTnbSubsidyBreakdownDto {
  residual: string;
  ownerCap: string;
  ownerPortion: string;
  tenantExcess: string;
  occupiedRoomCount: number;
  allocations: GridBillTnbExcessAllocationDto[];
}

/** Exact utility component plan for the next normal (first-issuance) Bill.
 *
 * A re-Bill is deliberately `rebill_review`: the server may retain paid lines,
 * and a grid read cannot honestly predict that component-aware decision. A
 * blocked/unavailable plan carries no would-be lines, so clients cannot present
 * a known subtotal as the amount that will actually be issued. */
export interface GridBillUtilityPlanDto {
  status: "ready" | "not_applicable" | "pax_blocked" | "unavailable" | "rebill_review";
  mode: "whole" | "subsidy" | "no_subsidy" | null;
  subsidyPerPax: string;
  /** Effective policy used by this read/preflight. Optional only for a rolling
   * cached payload from a server predating unit-level TNB caps. */
  subsidyPolicy?: GridTnbSubsidyPolicy | null;
  /** The snapshotted/current unit cap used by `subsidyPolicy`, if applicable. */
  tnbSubsidyCap?: string | null;
  /** Present only when an exact fresh unit-cap allocation can be explained. */
  tnbSubsidyBreakdown?: GridBillTnbSubsidyBreakdownDto | null;
  lines: GridBillUtilityPlanLineDto[];
  blockedTenancyIds: string[];
  errorCode: string | null;
}

export const gridQuerySchema = z.object({
  period: periodMonth.optional(),
  propertyId: uuid.optional(),
  months: z.coerce.number().int().min(1).max(12).default(1),
});

// AMOUNTS ONLY. It carries neither tnbPattern (snapshotted onto the row at
// create, R14) nor ownerBorne* (derived from the raw inputs at Bill, C3).
// Do NOT add them: the `absorbed ⇒ ownerBorne > 0` invariant is enforced in the
// Bill transaction, not here. `.strict()` is deliberately NOT used — unknown
// keys are stripped, so a stale client cannot 400 the whole Save.
export const saveEntrySchema = z.object({
  period: periodMonth,
  readingDate: z.string().date().optional(),
  // `rental` is deliberately ABSENT (Task 4): rental is SERVER-DERIVED per
  // tenancy (wired in the read path), so a client-supplied rental would let the
  // wire spoof the money. Do not re-add it. `entry.rental` survives only as a
  // vestigial DB column.
  cleaning: money.optional(),
  tnbTotal: money.optional(),      // RAW un-shaped provider total → tnbTotalRaw
  airSelangor: money.optional(),   // RAW un-shaped provider total → airSelangorRaw
  wifi: money.optional(),
  maintenanceFee: money.optional(),
  paymentStatus: paymentStatus.optional(),
  expectedUpdatedAt: z.string().optional(),
});

export const lineSettingsSchema = z.object({
  tnbPattern: utilityPattern,
  airPattern: utilityPattern,
  cleaningBearer: bearer,
  wifiBearer: bearer,
  maintenanceFeeBearer: bearer,
  expectedUpdatedAt: z.string().optional(),
});

export const billSchema = z.object({
  period: periodMonth,
  // `confirmRebill` is the admin's explicit "yes, void the existing invoices and reissue"
  // for a row that returned `rebill_confirmation_required` on the first click. Absent/false
  // ⇒ a row with existing live grid invoices returns the confirmation outcome and mutates
  // NOTHING; true ⇒ the re-Bill proceeds (still subject to the payment / previous-period guards).
  rows: z.array(z.object({ apartmentId: uuid, expectedUpdatedAt: z.string(), confirmRebill: z.boolean().optional() })).min(1),
});

export const bearerConfigSchema = lineSettingsSchema.extend({
  cleaningRecurringAmount: money,
  unlock: z.boolean().default(false),
  // charge-nature gate (2026-07-27): the unit's DEFAULT Expense/Profit nature for its
  // cleaning / wifi SCALAR — step 3 of resolveScalarNatures' precedence (period-lock.ts).
  // `.optional()` (absent = leave unchanged) AND `.nullable()` (explicit null = clear back to
  // undecided): unlike GridExpense.nature this one genuinely needs a clear path, because
  // "undecided" is a MEANINGFUL state here — it is what makes the Bill fail closed instead of
  // silently defaulting an unconfigured WiFi to profit on the owner's IVOWN. Not flag-gated at
  // this layer; ENABLE_CHARGE_NATURE_ROUTING only gates whether the mint/guard READ it.
  cleaningNature: z.enum(["expense", "profit"]).nullable().optional(),
  wifiNature: z.enum(["expense", "profit"]).nullable().optional(),
});

// Wire contract per spec §5 (`…-grid-design.md:487`), verbatim.
//
// `tenancyId` is the WIRE field; `GridExpense` has no such column. The service
// (Task 5, Step 7) loads the Tenancy scoped to session.orgId and snapshots
// `tenancy.tenantPartyId` into `GridExpense.partyId`. `partyId` is deliberately
// NOT a wire field: server-derived, so a client cannot claim a party it does not
// own. A cross-org tenancyId is a 404, never a 403 (no existence leak).
//
// `billingMonth` is the GridExpense COLUMN name (spec :218). Only the parent
// UnitBillsGridEntry uses `periodMonth` — which here is the shared Zod validator.
// gridexpense-nature (Task B2): per-row Expense/Profit routing choice, threaded straight
// onto GridExpense.nature (Task B1's column). Optional/omittable on BOTH create and
// update — an absent value stays NULL, which routes as Expense (Task B1: NULL/"expense"
// → tenant Expense Bill / owner payout deduction, backward-compatible). Deliberately NOT
// flag-gated at this schema/write layer (no fail-closed guard, unlike the recurring-apply
// route's NATURE_REQUIRED 422): the column is a single source of truth and
// ENABLE_CHARGE_NATURE_ROUTING only gates whether mint/issue-grouped/owner-ledger actually
// READ it downstream (Task B1). `.nullable()` is deliberately absent — there is no need to
// ever wire-clear nature back to NULL; sending "expense" achieves the identical default
// routing.
const gridExpenseNature = z.enum(["expense", "profit"]);
const expenseCostFields = {
  actualCost: money.nullable().optional(),
  costVendor: z.string().max(200).nullable().optional(),
  costPaymentStatus: z.enum(["unpaid", "partial", "paid"]).optional(),
  costPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  costPaymentAccount: z.string().max(200).nullable().optional(),
  costNotes: z.string().max(2000).nullable().optional(),
};

export const createExpensesSchema = z.object({
  apartmentId: uuid,
  billingMonth: periodMonth,
  bearer: z.enum(["tenant", "owner"]),
  tenancyId: uuid.optional(),
  items: z.array(z.object({ description: z.string().min(1), amount: money, withSST: z.boolean(), chargeCategoryId: uuid.nullable().optional(), nature: gridExpenseNature.optional(), ...expenseCostFields })).min(1),
});

export const updateExpenseSchema = z.object({
  description: z.string().min(1).optional(),
  amount: money.optional(),
  withSST: z.boolean().optional(),
  chargeCategoryId: uuid.nullable().optional(),
  nature: gridExpenseNature.optional(),
  ...expenseCostFields,
  expectedUpdatedAt: z.string().optional(),
});
// `bearer` is deliberately absent: filing to the wrong side is fixed by
// void + recreate, never by silently moving money between the tenant and
// owner columns of a possibly-billed month.

export const saveReadingsSchema = z.object({
  period: periodMonth,
  readings: z.array(z.object({
    listingId: uuid,                  // NOT NULL — the room (= Listing.id). The upsert key. Foundation CORRECTION 2.
    tenancyId: uuid.nullable(),       // snapshot; null = vacant. Multiple NULLs per entry are EXPECTED.
    partyId: uuid.nullable(),
    previousKwh: money.nullable(),
    currentKwh: money.nullable(),
    // `amount` is deliberately ABSENT: the per-room AIRCOND submeter charge is
    // SERVER-DERIVED (Task 3) as round2(round2(currentKwh-previousKwh)*ratePerKwh) —
    // a client-supplied amount would let the wire spoof the money. Do not re-add it.
    expectedUpdatedAt: z.string().optional(),
  })).min(1),
});

// ─── Recurring charges (recurring-charges feature) ──────────────────────────────
// One shared definition/revision config engine. Cleaning/WiFi are built-in kinds that
// still snapshot into the scalar entry fields; CUSTOM lines snapshot into
// GridEntryRecurringLine and route through the two seeded categories.
// SCALAR kinds (CLEANING/WIFI/TNB/AIR) each snapshot onto one UnitBillsGridEntry money
// column — that mapping lives in SCALAR_RECURRING_KINDS (constants/scalar-recurring.ts).
// CUSTOM is NOT a scalar: it writes a GridEntryRecurringLine child row instead, so it
// never appears in that map.
//
// Listed literally rather than spread from the map so zod keeps the literal union type
// (a spread widens it to `string`). `_scalarKindsCovered` below is the compile-time guard
// that the two stay in sync.
export const recurringKind = z.enum(["CLEANING", "WIFI", "TNB", "AIR", "MAINTENANCE", "CUSTOM"]);

/** Compile-time only: adding a kind to SCALAR_RECURRING_KINDS without adding it to
 *  `recurringKind` above is a type error here, never a silent runtime gap. */
const _scalarKindsCovered: Record<ScalarRecurringKind, z.infer<typeof recurringKind>> = {
  CLEANING: "CLEANING",
  WIFI: "WIFI",
  TNB: "TNB",
  AIR: "AIR",
  MAINTENANCE: "MAINTENANCE",
};
void _scalarKindsCovered;

/** Create a definition (definitionId absent) or edit one (definitionId present → NEW revision,
 * closing the prior's effectiveToMonth). `categoryId` is required for CUSTOM, ignored for
 * CLEANING/WIFI (they route via the per-utility cats). */
export const recurringUpsertSchema = z.object({
  definitionId: uuid.optional(),
  kind: recurringKind,
  name: z.string().min(1).max(120),
  amount: money,
  bearer,
  categoryId: uuid.optional(),
  effectiveFromMonth: periodMonth,
  enabled: z.boolean().default(true),
});
export type RecurringUpsertInput = z.infer<typeof recurringUpsertSchema>;

/** Apply REQUIRES an explicit confirm — the preview→confirm gate (rule 3). */
export const recurringApplySchema = recurringUpsertSchema.extend({ confirm: z.literal(true) });
export type RecurringApplyInput = z.infer<typeof recurringApplySchema>;

// DTOs (server → client) — types only.
export type RecurringExcludedReason = "billed" | "invoiced" | "frozen";
export interface RecurringPreview {
  willUpdate: Array<{ period: string; oldAmount: string | null; newAmount: string; oldBearer: string | null; newBearer: string; resolvedTarget: string | null }>;
  willCreateOnOpen: number;
  excluded: Array<{ period: string; reason: RecurringExcludedReason }>;
  conflicts: Array<{ apartmentId: string; period: string; reason: string }>;
}
export interface RecurringApplyResult { applied: number; excluded: number; conflicts: RecurringPreview["conflicts"] }
export interface RecurringRevisionDto { id: string; amount: string; bearer: "owner" | "tenant"; categoryId: string | null; nature: "expense" | "profit" | null; effectiveFromMonth: string; effectiveToMonth: string | null; enabled: boolean }
// kind carries the FULL recurringKind union — the server lists every definition, and the
// scalar engine (drawer rows) mints TNB/AIR/MAINTENANCE defs through the same API. The old
// 3-value union hid exactly that from the type checker (2026-08-06: a MAINTENANCE def leaked
// into the "custom" list because `kind !== "MAINTENANCE"` wouldn't even have typechecked).
export interface RecurringDefinitionDto { id: string; kind: z.infer<typeof recurringKind>; code: string; name: string; archivedAt: string | null; revisions: RecurringRevisionDto[] }
/** Per-row CUSTOM recurring totals for the grid summary cells (mirrors GridExpensesDto). */
export interface GridRecurringItemDto { id: string; name: string; amount: string }
export interface GridRecurringDto {
  owner: { total: string; count: number; items?: GridRecurringItemDto[] };
  tenant: { total: string; count: number; items?: GridRecurringItemDto[] };
}
/** A read-only recurring snapshot line for the grid dialog. */
export interface RecurringLineDto { id: string; name: string; amount: string; bearer: "owner" | "tenant"; nature: "expense" | "profit" | null; categoryName: string }
