/**
 * owner-statement-sections.ts — 5-section Yannie statement assembly (Task 2a-4).
 *
 * Assembles the structured data for the owner statement view from:
 *   - Invoice (period + owner reference)
 *   - Party (owner name + bank details)
 *   - OwnerLedgerEntry rows (income + expense lines for the month)
 *   - Listing rows (occupancy snapshot + rental rates)
 *   - Deposit rows (cash collected in-month, non-income)
 *
 * Used by the GET /statements/:id/sections endpoint AND the PDF renderer,
 * so the two surfaces always show the same numbers.
 */

// `Prisma` is a VALUE import (not `import type`) because fetchOwnerReceivablePayoutRows
// constructs `new Prisma.Decimal(...)` for the adjustment-netted receivable amount.
import { getDb, Prisma } from "@kason/db";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import type { OwnerLedgerLine } from "@kason/shared";
import {
  toCents,
  centsToString,
  summarizeOwnerPeriod,
  computeManagementFee,
  effectiveWindowOverlapsBillingMonth,
  isPassThroughIncomeLine,
} from "@kason/shared";
import { findDepositsCollectedInMonth, findDepositsHeldForUnits, depositWindowEndOfMonth } from "./owner-billing.repository";
import { adjustmentSumsByChargeId } from "../billing-documents/adjustment-sums";
import { adjustmentSplitByChargeId } from "../owner-ledger/net-adjustments-by-charge";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

// ─── Types ────────────────────────────────────────────────────────────────────

// "Admin Fee (First Month Rental)" labels an INFORMATIONAL row (direction
// "informational"), never
// a real income row — see the isInformational field on IncomeBreakdownRow. Mirrored in
// apps/web/src/api/owner-ledger.ts; both copies must agree.
export type IncomeType =
  | "Monthly"
  | "Prorate"
  | "Aircond Fee"
  | "Carpark"
  | "Shared Utility"
  | "Admin Fee (First Month Rental)"
  // Historical persisted/test discriminator. New statements intentionally do not
  // expose tenant-paid expenses to owners.
  | "Tenant-paid Expense"
  // DERIVED memo, never a ledger row — the partition aircond spread. Like "Admin Fee
  // (First Month Rental)" it rides isInformational:true and is excluded from every total; unlike
  // it, the money HAS already reached the payout (as Aircond Fee minus the master TNB
  // bill), so its footnote must say "already included", never "retained by KAEN".
  | "Extra Electricity";

export interface StatementHeader {
  reportMonth: string;           // "June 2026"
  propertyName: string;
  ownerName: string;
  bankName: string | null;
  accountHolder: string | null;
  accountNumberMasked: string | null; // FULL account number, unmasked (admin/owner need it for the payout transfer); field name kept for compatibility
}

export interface OccupancyRow {
  unitCode: string;
  tenantName: string | null;       // null = vacant
  tenancyStart: string | null;     // ISO date or null
  tenancyEnd: string | null;
  monthlyRental: string;           // 2dp string — agreedMonthlyRent or asking Listing.rentalRate
  depositMonths: number | null;
  depositAmount: string;           // 2dp string (from Deposit rows collected in month)
  isVacant: boolean;
}

export interface PayoutSummaryLine {
  label: string;
  amount: string;        // 2dp string; negative for expenses
  isNonIncome?: boolean; // memo line (deposit collected / owner-paid expense): shown but NOT part of the payout math
  isTotal?: boolean;
}

export interface IncomeBreakdownRow {
  unitCode: string;
  tenantName: string | null;
  incomeType: IncomeType;
  billingPeriod: string;           // "June 2026"
  amount: string;                  // 2dp string — COLLECTED amount (drives all payout math)
  chargedAmount: string;           // 2dp string — BILLED amount (Charge.amount); equals amount when paid; display-only
  mgmtFee: string;                 // 2dp string; "0.00" for aircond_income
  mgmtFeeSst: string;              // 2dp string; "0.00" for aircond_income
  paymentStatus: string;           // "pending" | "partial" | "paid" | "cancelled"
  /**
   * WHICH component this line is — "Electricity (TNB)", "Water (Air Selangor)",
   * "WiFi", "Cleaning", "Aircond" — read from the source Charge's description.
   * `incomeType` alone is a coarse bucket, so several rows share the same badge;
   * this is what tells them apart. null when the row has no source charge (a manual
   * ledger entry) or carries no readable description.
   */
  detail: string | null;
  /**
   * Tenant-borne utility money KAEN collects and forwards to the supplier. Listed
   * so the owner can see what their tenant was charged, but EXCLUDED from
   * `totalIncome` — it is not the owner's money and does not reach their payout.
   * Surfaces must render it as a memo, never as earnings.
   */
  isPassThrough: boolean;
  /**
   * An EXPLANATORY row, not money — sourced from an OwnerLedgerEntry with
   * direction "informational" (today: the first month's rent retained by KAEN as
   * letting commission). It exists so a commission month reads as "your rent went
   * here" instead of a blank income section with an unexplained SST deduction.
   *
   * Excluded from `totalIncome` AND `passThroughIncome`, carries no management fee,
   * and is appended AFTER the fee-aligned rows so the lineFees[i] 1:1 mapping with
   * incomeLedgerRows is untouched. Surfaces MUST render it as a memo — never as
   * earnings, never summed.
   */
  isInformational: boolean;
}

export interface ExpenseBreakdownRow {
  category: string;                // human label e.g. "Electricity (TNB)"
  categoryKey: string;             // RAW OwnerLedgerEntry.category e.g. "utilities_tnb" — the per-row proof attach posts category=<categoryKey>
  description: string | null;
  amount: string;                  // 2dp string
  sstAmount: string;               // "0.00" or SST on mgmt fee
  paymentStatus: string;
  // RAW OwnerLedgerEntry.sourceType (e.g. "utility_tnb", "owner_borne_expense",
  // "statement", "reversal"). Drives the WEB-only expense visibility filter
  // (filterWebVisibleExpenses / ENABLE_OWNER_WEB_EXPENSE_HIDE). Optional so legacy
  // fixtures that predate it still typecheck; a row without it fails CLOSED (hidden
  // on the web), never leaking. The PDF renderer reads none of this.
  sourceType?: string;
  // Whether a utility expense is TENANT-FUNDED (recharged / KAEN-advanced-recover)
  // vs OWNER-ABSORBED, per the bill's snapshotted bearer. Only meaningful for the four
  // allow-listed utility sourceTypes; undefined elsewhere. The WEB filter shows a
  // utility only when this is true, so an owner-absorbed category (e.g. wifi with
  // wifiBearer "owner") riding a bill-level "paid" status can never leak. Fail-closed:
  // undefined ⇒ not web-visible. The PDF ignores it (still shows every expense).
  tenantRecharged?: boolean;
  /**
   * "Debit note +RM 80.00 · Credit note -RM 30.00[ · SST -RM 4.00]" — the active
   * credit/debit notes that moved `amount`/`sstAmount` away from what was minted,
   * named and split by direction. null when no active note touched the row.
   *
   * DISPLAY-ONLY, and NOT optional information: §5 has always shown the ADJUSTED
   * figure (the receivable path nets notes in, and owner-ledger.sync nets them into
   * the `statement` rows), so before this an owner saw a RM 1.00 expense silently
   * become RM 0.50 with nothing on the page naming the note that did it. §4 has
   * printed this beside the income line it moved since 2026-08-07; this is the same
   * event, worded identically (adjustmentNoteText is the ONE formatter).
   *
   * Optional on the TYPE only so fixtures that predate it still typecheck — the
   * assembler always sets it, null included.
   */
  adjustmentNote?: string | null;
  // Paid-on-behalf metadata (Task 9) — DISPLAY-ONLY. When present, the statement
  // documents "KAEN paid <payeeName> on the owner's behalf" beside this expense.
  payeeName: string | null;
  paidOnBehalfRef: string | null;
  paidOnBehalfDate: string | null; // YYYY-MM-DD or null
}

export interface YannieSections {
  header: StatementHeader;
  // The statement's apartment scope (Invoice.apartmentId): the apartment this
  // per-unit statement was generated for, or null for a legacy combined statement.
  // Surfaced so the admin per-expense proof attach posts the matching apartmentId
  // (B2 keys proof off (org, owner, month, apartmentId, category)).
  apartmentId: string | null;
  occupancy: { rows: OccupancyRow[]; occupiedCount: number; vacantCount: number; totalMonthlyRental: string };
  payoutSummary: {
    lines: PayoutSummaryLine[];
    netPayoutToOwner: string;
    /** Deposit cash RELEASED to the owner this month — summed into Gross Cash In. */
    depositCollected: string;
    /** Deposit KAEN is HOLDING for this owner's tenants — display-only, in NO total. */
    depositHeld: string;
  };
  incomeBreakdown: { rows: IncomeBreakdownRow[]; totalIncome: string; passThroughIncome: string; totalMgmtFee: string };
  expenseBreakdown: { rows: ExpenseBreakdownRow[]; totalExpenses: string };
}

// ─── Owner WEB statement — expense visibility filter (money-visibility) ─────────
//
// The owner PDF shows ALL expenses. On the WEB portal (behind
// ENABLE_OWNER_WEB_EXPENSE_HIDE) the owner sees an expense ONLY when it is a
// tenant-recharge utility (KAEN advanced the cost, recovers it from the tenant) AND
// the tenant has FULLY paid — i.e. KAEN actually holds the money it spent on the
// owner's behalf. Owner-borne costs (cleaning, cukai, repairs, Source-6 grid
// expenses), the computed KAEN mgmt fee, and reversal rows are NEVER shown on the
// web, even when their OWN charge reads "paid".
//
// The predicate is an ALLOW-LIST on sourceType — exactly the four Source-3 gross
// utility bills, whose paymentStatus rolls up the tenant's own charge settlement
// (owner-ledger.sync.ts). Being an allow-list, it inherently hides every
// owner-borne / fee / reversal row regardless of paymentStatus, closing the
// "a paid owner-borne row leaks through" hazard (those sources hardcode or derive
// paymentStatus:"paid" without any tenant behind them).
export const WEB_VISIBLE_EXPENSE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "utility_tnb",
  "utility_water",
  "utility_indah_water",
  "utility_wifi",
]);

/**
 * PURE. Whether a Source-3 utility expense row is TENANT-FUNDED (recharged /
 * KAEN-advanced-recover — the tenant is actually charged) vs OWNER-ABSORBED, from
 * the bill's snapshotted per-category bearer. TNB + AirSelangor rows are always
 * tenant-funded — schema-enforced: UnitUtilityBill has NO tnb/air bearer column (only
 * indahWaterBearer/cleaningBearer/wifiBearer, schema.prisma:3221-3223), the ONLY
 * writer of tnbTotal/.airSelangor is the meter path (meter/service.ts:311-312), which
 * pools tnb/water to tenants unconditionally, and the utility_tnb/utility_water
 * Source-3 rows read EXCLUSIVELY from UnitUtilityBill (owner-ledger.sync.ts:247-248,
 * :712-759). (An owner-ABSORBED tnb/water lives only in the SEPARATE bills-grid system
 * and books as sourceType "owner_borne_expense" — already hidden by the allow-list —
 * never as a utility_tnb/water row.) indahWater + wifi DO carry an explicit per-bill
 * bearer ("owner" | "tenant"). Non-utility sourceTypes return false (never web-visible).
 * Missing bearers for indah/wifi ⇒ false (fail-closed).
 */
export function utilityRowTenantFunded(
  sourceType: string | undefined,
  bearers: { indahWaterBearer: string; wifiBearer: string } | undefined,
): boolean {
  switch (sourceType) {
    case "utility_tnb":
    case "utility_water":
      return true;
    case "utility_indah_water":
      return bearers?.indahWaterBearer === "tenant";
    case "utility_wifi":
      return bearers?.wifiBearer === "tenant";
    default:
      return false;
  }
}

/**
 * PURE. Returns a NEW YannieSections whose expenseBreakdown keeps only the
 * web-visible expense rows (tenant-recharge utility AND paymentStatus "paid"),
 * with totalExpenses recomputed to the surviving rows. The input is never mutated,
 * so the SAME assembled sections rendered into the PDF are untouched. Applied ONLY
 * on the portal JSON path (portal.owner-statements.routes.ts), never in the builder
 * and never on any PDF/export path.
 */
export function filterWebVisibleExpenses(sections: YannieSections): YannieSections {
  const rows = sections.expenseBreakdown.rows.filter(
    (r) =>
      r.sourceType != null &&
      WEB_VISIBLE_EXPENSE_SOURCE_TYPES.has(r.sourceType) &&
      r.paymentStatus === "paid" &&
      r.tenantRecharged === true, // owner-absorbed utility categories (e.g. wifiBearer "owner") stay hidden
  );
  // Sum amount + sstAmount to mirror the assembler's own totalExpensesC (which
  // includes per-row SST). Today every surviving row is a Source-3 utility with
  // sstAmount "0.00", so this equals Σamount — but it stays correct if an SST-bearing
  // sourceType is ever added to the allow-list.
  const totalC = rows.reduce(
    (acc, r) => acc + toCents(r.amount, "filterWebVisibleExpenses") + toCents(r.sstAmount, "filterWebVisibleExpenses"),
    0,
  );
  return { ...sections, expenseBreakdown: { rows, totalExpenses: centsToString(totalC) } };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function firstDayOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthLabel(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function money2dp(val: { toString(): string } | null | undefined): string {
  if (val === null || val === undefined) return "0.00";
  const n = parseFloat(val.toString());
  return isNaN(n) ? "0.00" : n.toFixed(2);
}

function categoryToIncomeType(category: string): IncomeType {
  if (category === "carpark_income") return "Carpark";
  if (category === "aircond_income") return "Aircond Fee";
  if (category === "utility_income") return "Shared Utility";
  return "Monthly";
}

/**
 * Charge.status → the statement's paymentStatus vocabulary, for an IVOWN owner
 * receivable listed in §5. Mirrors owner-ledger.sync's chargeStatusToPaymentStatus
 * (module-private there); duplicated rather than exported so this display path
 * cannot widen the sync module's API surface. Unrecognised → "pending": never
 * silently claim an unsettled cost is paid.
 */
/**
 * Owner-borne IVOWN costs as synthetic `expense` rows for computeOwnerPayout.
 *
 * Bills-grid owner-borne costs (maintenance, owner-funded utilities, freeform owner
 * expenses) land on an IVOWN invoice, and IVOWN charges are deliberately NOT
 * owner-ledger expense rows: the durable XOR at owner-ledger.sync.ts:114-150 keeps a
 * charge with a live IVOWN line out of Source 6, because it is a receivable rather
 * than a Source-6 deduction. They are still, unambiguously, money the owner bears —
 * omitting them told an owner with RM 800 of real costs that their only expense was
 * KAEN's fee.
 *
 * Lives here, exported, and is called by EVERY surface that computes an owner payout
 * (the statement, resolveOwnerPayoutForScope, getOwnerMonthsService). That is the
 * point: this started as inline logic in the statement only, which immediately made
 * the statement disagree with the Live Ledger Summary. One helper, one answer.
 *
 * Sourced from the IVOWN invoice rather than from the offset allocations, so a cost
 * counts from the moment it is BILLED, not only once collected.
 *
 * PURE READ.
 */
export async function fetchOwnerReceivablePayoutRows(
  orgId: string,
  ownerPartyId: string,
  monthStart: Date,
  apartmentId: string | null,
  /** The month's ledger rows — used to skip anything already booked as an expense. */
  ledgerRows: ReadonlyArray<{ direction: string; sourceChargeId: string | null }>,
): Promise<
  Array<{
    direction: string;
    category: string;
    amount: Prisma.Decimal;
    sstAmount: string;
    includeInPayout: boolean;
    taxCategory: string;
    sourceChargeId: string;
    sourceType: string;
    sourceUtilityBillId: null;
    description: string | null;
    status: string;
    /** DISPLAY-ONLY — see ExpenseBreakdownRow.adjustmentNote. Ignored by every
     *  payout consumer (computeOwnerPayout reads direction/amount/sstAmount only). */
    adjustmentNote: string | null;
  }>
> {
  const db = getDb();
  // BillingDocument.seriesId is a PLAIN column (no Prisma relation), so the series
  // cannot be filtered inline. Series is resolved CONFIGURATION — a lookup, never a
  // hard-coded id.
  const ivownSeries = await db.documentSeries.findFirst({
    where: { organizationId: orgId, code: "IVOWN" },
    select: { id: true },
  });
  if (!ivownSeries) return [];

  const lines = await db.billingDocumentLine.findMany({
    where: {
      chargeId: { not: null },
      // ⚠️ MONEY. An `isTax` line's amount IS tax already carried by its BASE line's
      // own `sstAmount` (the invariant issueDocumentTx relies on when it excludes
      // isTax from `subtotal`). mintExpenseChargesTx mints an SST-bearing owner
      // expense as TWO Charges — base + a `-SST` sibling — and BOTH land on the IVOWN
      // invoice, so without this filter the sibling became its own `owner_receivable`
      // expense row worth the tax, while the base row deducted the SAME tax again
      // through `sstAmount` below. A RM 1.00 owner expense at 8% deducted RM 1.16 from
      // the payout instead of RM 1.08, and §5 listed a bare "— SST 8%" row the owner
      // could not reconcile against anything.
      isTax: false,
      document: {
        organizationId: orgId,
        docType: "invoice",
        partyId: ownerPartyId,
        seriesId: ivownSeries.id,
        billingMonth: monthStart,
        ...(apartmentId ? { apartmentId } : {}),
      },
    },
    select: { chargeId: true, description: true, sstAmount: true },
  });
  if (lines.length === 0) return [];

  // ⚠️ MONEY. A charge Source 2 already booked as a ledger expense — the management
  // fee — is ALREADY in the rows passed to computeOwnerPayout. Counting its IVOWN
  // copy would deduct it twice, the same double-deduct the auto-offset hook guards
  // against, for the same reason.
  const alreadyLedgerExpensed = new Set(
    ledgerRows
      .filter((e) => e.direction === "expense")
      .map((e) => e.sourceChargeId)
      .filter((id): id is string => id !== null),
  );

  const charges = await db.charge.findMany({
    where: {
      organizationId: orgId,
      id: { in: lines.map((l) => l.chargeId!) },
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true, description: true, amount: true, status: true },
  });
  // ⚠️ MONEY. One entry per charge — description AND SST come from the SAME line, so
  // they can never describe different lines. Taken ONCE per charge (last-wins, as the
  // description lookup has always been), never SUMMED across lines: `amount` below is
  // likewise the Charge's own single amount, so summing SST over a charge that appears
  // on two lines would deduct SST the owner was billed once, twice.
  const lineByChargeId = new Map(lines.map((l) => [l.chargeId!, l]));

  // ⚠️ MONEY. `Charge.amount` is the FROZEN mint figure — a credit/debit note never
  // rewrites it (charge-adjustment.service.ts moves `outstandingAmount` and records
  // the delta on the note). Reading it bare here told an owner their RM 1.00 expense
  // still cost RM 1.00 after a RM 0.50 credit note, and — because these rows feed
  // computeOwnerPayout, not just §5 — DEDUCTED the un-credited RM 1.00 from the
  // payout. This is the identical hole the deleted Source 6 carried
  // ([[ivown-sst-fold-and-deduct-cleanup]]); the replacement path inherited it.
  //
  // Both directions are netted, and SST comes from what the NOTES DECLARED rather
  // than a re-derivation — see netAdjustmentSstByChargeId's own note.
  //
  // Read SPLIT by direction (debit − credit IS the net the two netting helpers
  // return, over the same `loadActiveNoteLines` rows) so this ONE read serves both
  // the money and the sentence §5 prints beside it — see adjustmentSplitByChargeId's
  // ⚠️ MONEY note for why the annotation must not come from a second query.
  const payoutChargeIds = charges.filter((c) => !alreadyLedgerExpensed.has(c.id)).map((c) => c.id);
  const adjSplit = await adjustmentSplitByChargeId(db, orgId, payoutChargeIds);

  return charges
    .filter((c) => !alreadyLedgerExpensed.has(c.id))
    .map((c) => {
      const adj = adjSplit.get(c.id);
      const netAdjC = (adj?.debitCents ?? 0) - (adj?.creditCents ?? 0);
      const netSstAdjC = (adj?.debitSstCents ?? 0) - (adj?.creditSstCents ?? 0);
      return {
        direction: "expense",
        category: "owner_receivable",
        // Clamped at 0: a credit note larger than the charge cannot turn an owner COST
        // into owner income — that would pay them for a bill being cancelled. Mirrors
        // the same clamp in collectedString (owner-ledger.sync.ts:343).
        amount: new Prisma.Decimal(
          centsToString(
            Math.max(0, toCents(money2dp(c.amount), "ownerReceivable.amount") + netAdjC),
          ),
        ),
        // ⚠️ MONEY. The SST the owner was ACTUALLY invoiced on this charge's own IVOWN
        // line. A document's sstAmount is not a separate document-level levy — it is the
        // SUM of its lines, each computed as round(line.amount × the CHARGE's own
        // sstRate) (issue.service.ts:117-130 via issue-grouped.ts's resolveLineSst). So a
        // withSST bills-grid expense (sstRate 8) carries its SST here, fully attributable.
        // Omitting it under-deducted the payout by exactly that SST — the owner was paid
        // money KAEN had already billed them. This mirrors Source 6's own reclaim for the
        // non-invoiced twin of this cost (ownerBorneExpenseSstAmount,
        // owner-ledger.sync.ts:106), so the two paths deduct the same total.
        //
        // …and netted by the tax the notes themselves declared, so a credited expense
        // stops deducting the tax on money the owner is no longer billed for. Clamped
        // at 0 for the same reason `amount` above is.
        sstAmount: centsToString(
          Math.max(
            0,
            toCents(money2dp(lineByChargeId.get(c.id)?.sstAmount), "ownerReceivable.sst") +
              netSstAdjC,
          ),
        ),
        // KAEN recovers these out of the rent, so they reduce what the owner is paid.
        includeInPayout: true,
        taxCategory: "check_with_tax_agent",
        sourceChargeId: c.id,
        sourceType: "owner_receivable",
        sourceUtilityBillId: null as null,
        description: c.description ?? lineByChargeId.get(c.id)?.description ?? null,
        status: c.status,
        // Names the notes behind the two figures above. Built from the SAME `adj`
        // that produced them, so the row can never explain a movement it did not make.
        adjustmentNote: adj ? adjustmentNoteText(adj) : null,
      };
    });
}

function receivableChargePaymentStatus(status: string): string {
  switch (status) {
    case "paid":
      return "paid";
    case "partially_paid":
      return "partial";
    case "void":
      return "cancelled";
    default:
      return "pending";
  }
}

/**
 * PURE. The computed KAEN-fee row's payment status, rolled up from the income lines
 * that actually produced the fee.
 *
 * ⚠️ This was the literal `"paid"` until 2026-08-17. The §5 fee row is SYNTHESIZED —
 * isSuppressedFromSection5 drops every real `management_fee` ledger row and this single
 * computed row replaces them — so the hardcode threw away the only rows that knew the
 * answer and told an owner their fee was "paid" while the tenant's rent was still
 * outstanding. owner-ledger.sync.ts:262 already states the rule this restores: a row's
 * paymentStatus must reflect the TENANT's actual charge state, never a hardcoded "paid".
 *
 * ⚠️ MONEY — the AMOUNT is deliberately untouched. computeOwnerPayout still folds
 * computedMgmtTotalC into deductibleExpensesC in full: KAEN recovers the fee out of the
 * payout whether or not the tenant has settled. Only the LABEL is derived. Do not
 * "finish the job" by gating the deduction on this status — that is a different
 * decision and it was made the other way.
 *
 * Rolled up over the fee-BEARING lines only. A percent/cap fee is computed FROM collected
 * cash (OwnerLedgerEntry.amount is collectedString(...)), so a zero-fee line has nothing
 * to say about the fee. A `fixed` fee ignores rent entirely (computeManagementFee reads
 * only cfg.feeValue) — that is the case that produced a "paid" fee against RM 0.00
 * collected, and those lines DO carry a fee, so they DO count here.
 *
 * Fails to "pending", never to "paid" — the same never-silently-claim-paid default
 * chargeStatusToPaymentStatus uses.
 */
export function computedMgmtFeePaymentStatus(feeBearingIncomeStatuses: readonly string[]): string {
  if (feeBearingIncomeStatuses.length === 0) return "pending";
  const paid = feeBearingIncomeStatuses.filter((s) => s === "paid").length;
  if (paid === feeBearingIncomeStatuses.length) return "paid";
  if (paid > 0 || feeBearingIncomeStatuses.some((s) => s === "partial")) return "partial";
  return "pending";
}

function categoryToExpenseLabel(category: string): string {
  const MAP: Record<string, string> = {
    management_fee: "Management Fee",
    cleaning: "Cleaning",
    tnb: "Electricity (TNB)",
    water: "Water",
    wifi: "Wi-Fi",
    maintenance: "Maintenance",
    insurance: "Fire Insurance",
    assessment_tax: "Assessment Tax",
    sewerage: "Sewerage / Indah Water",
    cukai_petak: "Cukai Petak",
    access_card: "Access Card",
    letting_commission: "Admin Fee (First Month Rental)",
    other: "Other",
    other_expense: "Other",
  };
  return MAP[category] ?? category;
}

// Utility categories whose owner-borne Source-2 auto-feed rows are DISPLAY-ONLY
// (includeInPayout:false) twins of the FULL Source-3 supplier bill. Mirrors
// owner-ledger.sync's STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES. These twins are
// excluded from §5 (like management_fee) so each utility expense is listed ONCE —
// the full bill — and never double-listed (which would inflate totalExpenses + the
// owner-paid memo). cleaning is NOT here: its Source-2 charge IS the payout source.
const SECTION5_DISPLAY_ONLY_UTILITY_CATEGORIES = new Set<string>([
  "utilities_tnb",
  "wifi",
  "indah_water",
  "water",
]);

// ─── "Extra Electricity" memo — the two ledger sides it is derived from ────────
//
// Matched on sourceType, NOT category, and that is load-bearing: `utilities_tnb` is
// also the category of the display-only Source-2 twin (includeInPayout:false), so a
// category match would subtract the master TNB bill twice and understate the spread.
//
// The two expense sourceTypes are mutually exclusive per apartment-month by
// construction — Source 7 (`grid_utility_tnb`) books the RAW provider bill for a
// bills-grid unit, Source 3 (`utility_tnb`) books it from a CHARGED UnitUtilityBill on
// the legacy meter path, and bills-grid never writes UnitUtilityBill. Both are listed
// so the memo works on either path.
const PARTITION_TNB_EXPENSE_SOURCE_TYPES = new Set<string>(["grid_utility_tnb", "utility_tnb"]);
/** Source-4 tenant aircond carve-out (the per-room `AC-` submeter charges). */
const AIRCOND_INCOME_SOURCE_TYPE = "tenant_aircond";

/** Minimal ledger-row shape {@link deriveExtraElectricityRows} needs. */
export type ExtraElectricityLedgerRow = {
  direction: string;
  sourceType: string;
  apartmentId: string | null;
  amount: { toString(): string };
};

/**
 * PURE. The derived "Extra Electricity" memo rows for one statement — one per
 * PARTITIONED apartment whose tenant aircond collections exceeded the master TNB bill.
 *
 * A partition room's aircond is submetered at KAEN's own RM/kWh, which sits ABOVE TNB's
 * tariff, so Σ per-room aircond can exceed the master bill. That spread is genuinely the
 * owner's — they pay TNB and recover more through the separately-billed AC- charges —
 * and it ALREADY reaches their payout, as two rows that never name it: "Aircond Fee"
 * income (Source 4) minus the raw master bill booked as an owner expense (Source 7, or
 * Source 3 on the legacy meter path). The owner saw both numbers and no explanation of
 * the difference. This names it.
 *
 * DERIVED, NEVER A LEDGER ROW. Posting a real +50 entry would pay the owner TWICE — the
 * income and expense above already net to exactly this figure. The caller appends these
 * AFTER totalIncome/passThroughIncome are summed (the same discipline the informational
 * rows use), each row carries zero management fee, and none of them enter any total.
 * Payout math is untouched: computeOwnerPayout reads ledger rows, not these.
 *
 * Both sides read the ledger's COLLECTED `amount`, so a memo reconciles line-for-line
 * with the two rows the owner can see in the same statement. A consequence worth
 * keeping: an unpaid or part-paid month yields NO row rather than announcing a spread
 * KAEN has not collected — this can understate, never overstate.
 */
export function deriveExtraElectricityRows(
  ledgerEntries: readonly ExtraElectricityLedgerRow[],
  apartmentById: ReadonlyMap<string, { unitCode: string; listingMode: string }>,
  monthStart: Date,
): IncomeBreakdownRow[] {
  const spreadByApartment = new Map<string, { aircondC: number; tnbC: number }>();
  for (const e of ledgerEntries) {
    if (e.apartmentId == null) continue;
    const isAircond = e.direction === "income" && e.sourceType === AIRCOND_INCOME_SOURCE_TYPE;
    const isTnb = e.direction === "expense" && PARTITION_TNB_EXPENSE_SOURCE_TYPES.has(e.sourceType);
    if (!isAircond && !isTnb) continue;
    const acc = spreadByApartment.get(e.apartmentId) ?? { aircondC: 0, tnbC: 0 };
    const cents = toCents(money2dp(e.amount), "deriveExtraElectricityRows");
    if (isAircond) acc.aircondC += cents;
    else acc.tnbC += cents;
    spreadByApartment.set(e.apartmentId, acc);
  }
  return [...spreadByApartment.entries()]
    .flatMap(([aptId, { aircondC, tnbC }]) => {
      // An apartment with no non-archived listing is absent from the map and skipped:
      // there is no unit code to render the row under, and no listing means no live
      // rooms billing aircond this month.
      const apt = apartmentById.get(aptId);
      // WHOLE units are excluded STRUCTURALLY, not merely arithmetically: one tenant on
      // one master meter means aircond > TNB is a data-entry error there — exactly what
      // the AIRCON_EXCEEDS_TNB guard rejects — and never owner profit.
      if (apt?.listingMode !== "PARTITIONED") return [];
      const excessC = aircondC - tnbC;
      if (excessC <= 0) return [];
      const amount = centsToString(excessC);
      return [{
        unitCode: apt.unitCode,
        tenantName: null, // the spread is the unit's, not any one tenant's
        incomeType: "Extra Electricity" as const,
        billingPeriod: monthLabel(monthStart),
        amount,
        chargedAmount: amount,
        mgmtFee: "0.00",
        mgmtFeeSst: "0.00",
        paymentStatus: "paid", // collected by construction — both sides read collected amounts
        detail: "Aircond submeters collected above the TNB bill",
        isPassThrough: false,
        isInformational: true,
      }];
    })
    // The PDF render and the GET /sections API are SEPARATE invocations of the
    // assembler, so ordering is pinned explicitly rather than left to Map iteration —
    // the soft copy must not drift from the screen.
    .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
}

/**
 * PURE. The specific component behind an income line, for display beside the coarse
 * `incomeType` badge.
 *
 * "Shared Utility" alone is not readable — an owner looking at five identical rows
 * cannot tell electricity from water from WiFi. The component is already on the
 * source Charge: bills-grid mints `description` as "<label> <YYYYMM>" from
 * UTILITY_SPEC ("Electricity (TNB)", "Water (Air Selangor)", "Sewerage (Indah
 * Water)", "WiFi", "Cleaning", "Maintenance"), and the meter path as "Aircond
 * <YYYYMM>". The trailing period stamp is dropped because the statement already has
 * its own Period column.
 *
 * The 6-digit anchor is deliberately tight: it strips a minted stamp without
 * truncating a description that merely ends in a number ("Meter 12345" keeps its
 * number). Returns null when nothing readable remains, so a caller renders no label
 * rather than an empty one.
 */
export function incomeRowDetail(description: string | null): string | null {
  if (description == null) return null;
  // (?:^|\s) anchors the stamp to a whole token: "Unit 1234567" keeps its number
  // because the trailing 6 digits are preceded by another digit, not a boundary.
  const stripped = description.replace(/(?:^|\s)\d{6}$/, "").trim();
  return stripped.length > 0 ? stripped : null;
}

/** Join a row's detail with its CN/DN note text ("Credit note -RM 30.00"), either
 * side optional — a note on a detail-less row still renders alone. */
function appendAdjustmentNote(detail: string | null, note: string | undefined): string | null {
  if (!note) return detail;
  return detail ? `${detail} · ${note}` : note;
}

/**
 * PURE. THE one wording for "which notes moved this row, and by how much" — used by
 * §4 income rows and §5 expense rows alike, so the two sections cannot describe the
 * same event in two voices. null when nothing moved (never an empty string, never a
 * "RM 0.00" note the owner would go looking for).
 *
 * SPLIT by direction, deliberately: a row carrying +80 and −30 says both, never a
 * netted "+RM 50.00" that hides a debit note the owner was issued and can be asked
 * to pay. Same reason the tenant surfaces split them (adjustment-sums.ts header).
 *
 * The SST clause is NETTED rather than split — it is the tax the notes themselves
 * DECLARED (never a re-derivation; see netAdjustmentSstByChargeId), and it exists to
 * explain a movement in §5's separate SST column. §4 passes no SST here: an income
 * row's SST column is the management-fee tax, which no credit note touches.
 */
function adjustmentNoteText(sums: {
  debitCents: number;
  creditCents: number;
  debitSstCents?: number;
  creditSstCents?: number;
}): string | null {
  const parts: string[] = [];
  if (sums.debitCents > 0) parts.push(`Debit note +RM ${centsToString(sums.debitCents)}`);
  if (sums.creditCents > 0) parts.push(`Credit note -RM ${centsToString(sums.creditCents)}`);
  const netSstC = (sums.debitSstCents ?? 0) - (sums.creditSstCents ?? 0);
  if (netSstC !== 0) {
    parts.push(`SST ${netSstC > 0 ? "+" : "-"}RM ${centsToString(Math.abs(netSstC))}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Income categories that bear a management fee (Yannie): rental + carpark.
// aircond/utility pass-through income bears NO fee.
const FEE_INCOME_CATEGORIES = new Set(["rental_income", "carpark_income"]);

// A ledger expense row is SUPPRESSED from §5 (and the §5 totals) when it is either
// (a) a management_fee row — replaced by the single computed KAEN Service Fee — or
// (b) a display-only Source-2 utility twin (includeInPayout:false) of the FULL
// Source-3 supplier bill, so each utility expense is listed ONCE.
// Exported so the receipt builder (owner-ledger-receipt.service.ts) can reuse the
// IDENTICAL predicate — ensuring receipt.totals.total === statement.deductibleExpensesC.
export function isSuppressedFromSection5(category: string, includeInPayout: boolean): boolean {
  return (
    category === "management_fee" ||
    (!includeInPayout && SECTION5_DISPLAY_ONLY_UTILITY_CATEGORIES.has(category))
  );
}

// ─── Shared payout computation (I-2) ───────────────────────────────────────────
//
// THE single source of truth for "Total Payout to Owner" + the per-income-line
// management fee. BOTH assembleYannieStatement (the statement/PDF) AND
// getOwnerMonthsService (the /months card) call this, so the card's net payout can
// NEVER diverge from the statement's Total Payout — including for PRE-STATEMENT
// months that carry no owner_statement Invoice. Before billing, the fee is
// computed from the active config; after billing, the sourced management-fee
// ledger row wins so historical custom amounts cannot drift.
//
//   Total Payout = (collected income) + (deposit collected)
//                  − (deductible non-fee expenses + Σ per-line computed mgmt fee)
//
// Pure: no DB access. The caller pre-fetches the ledger rows, the owner's active
// ManagementFeeConfig rows, and the in-month deposit total (cents).

/** Minimal ledger-row shape this computation needs (income + expense rows). */
export type PayoutLedgerRow = {
  direction: string;
  category: string;
  amount: { toString(): string };
  sstAmount: { toString(): string } | null;
  includeInPayout: boolean;
  taxCategory: string;
  propertyId: string | null;
  apartmentId?: string | null;
  /** Present on statement-generated rows. A sourced management-fee row is the
   * exact fee already produced by the billing engine (including custom unit
   * overrides such as pax deduction and first-charge amount). */
  sourceChargeId?: string | null;
};

/** Minimal ManagementFeeConfig shape (per-property fee resolution). */
export type PayoutFeeConfigRow = {
  propertyId: string | null;
  apartmentId?: string | null;
  feeType: string;
  feeValue: { toString(): string };
  capAmount: { toString(): string } | null;
  sstPercent: { toString(): string };
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  freePeriodStart?: Date | null;
  freePeriodEnd?: Date | null;
  updatedAt: Date;
};

export interface OwnerPayoutBreakdown {
  grossRentalC: number;
  grossRentalStr: string;
  depositCollectedC: number;
  grossCashInC: number;
  computedMgmtBaseC: number;
  computedMgmtSstC: number;
  computedMgmtTotalC: number;
  nonFeeAllExpensesC: number;
  nonFeeDeductibleC: number;
  totalExpensesC: number;
  deductibleExpensesC: number;
  ownerPaidExpensesC: number;
  netPayoutNoDepositC: number;
  totalPayoutC: number;
  /** Cash payable now. Never negative; a shortfall is exposed separately. */
  payableToOwnerC: number;
  /** Owner must top up this amount when deductible costs exceed available cash. */
  ownerTopUpRequiredC: number;
  /** Per-income-line fee, aligned 1:1 with rows.filter(r => r.direction === "income"). */
  lineFees: { base: string; sst: string; baseC: number; sstC: number }[];
}

export function computeOwnerPayout(args: {
  rows: PayoutLedgerRow[];
  feeConfigRows: PayoutFeeConfigRow[];
  depositCollectedC: number;
  /** First day of the payout month. Required by production callers so effective
   * windows and free-management periods are honoured. Optional for legacy pure tests. */
  statementMonth?: Date;
}): OwnerPayoutBreakdown {
  const { rows, depositCollectedC } = args;
  const statementMonth = args.statementMonth;
  const feeConfigRows = args.feeConfigRows.filter((config) => {
    if (!statementMonth) return true;
    if (!effectiveWindowOverlapsBillingMonth(statementMonth, config)) return false;
    if (
      config.freePeriodStart &&
      config.freePeriodEnd &&
      statementMonth >= config.freePeriodStart &&
      statementMonth <= config.freePeriodEnd
    ) return false;
    return true;
  });

  // grossRental via the shared summariser (folds SST into income lines).
  const ledgerLines: OwnerLedgerLine[] = rows.map((e) => ({
    direction: e.direction as "income" | "expense" | "payout",
    category: e.category,
    amount: e.amount.toString(),
    sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
    includeInPayout: e.includeInPayout,
    taxCategory: e.taxCategory,
  }));
  const summary = summarizeOwnerPeriod(ledgerLines);
  const grossRentalC = toCents(summary.grossRental, "computeOwnerPayout");

  const incomeRows = rows.filter((e) => e.direction === "income");
  const expenseRows = rows.filter((e) => e.direction === "expense");

  // Per-line management fee, resolved PER income line's property (a property-specific
  // config OVERRIDES the all-properties default; latest wins) — mirrors the charge
  // path's resolveConfigForUnit. A single findFirst cannot express the NULLS-LAST
  // precedence, so resolve per line from all active configs.
  const feeConfigsByRecency = [...feeConfigRows].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const toFeeCfg = (row: PayoutFeeConfigRow) => ({
    feeType: row.feeType as "percent" | "fixed" | "cap",
    feeValue: row.feeValue.toString(),
    capAmount: row.capAmount == null ? null : row.capAmount.toString(),
    sstPercent: row.sstPercent.toString(),
  });
  const resolveFeeCfgForUnit = (apartmentId: string | null, propertyId: string | null) => {
    const unitSpecific =
      apartmentId != null
        ? feeConfigsByRecency.find((c) => c.apartmentId === apartmentId)
        : undefined;
    const specific =
      propertyId != null
        ? feeConfigsByRecency.find((c) => c.apartmentId == null && c.propertyId === propertyId)
        : undefined;
    const allProperties = feeConfigsByRecency.find(
      (c) => c.apartmentId == null && c.propertyId == null,
    );
    const row = unitSpecific ?? specific ?? allProperties;
    return row ? toFeeCfg(row) : null;
  };
  // Once billing has generated a management-fee charge, that sourced ledger row
  // is the accounting truth. Prefer it over recomputing from today's settings:
  // this preserves unit-specific pax deductions, one-off first-charge amounts,
  // and historical settings after an operator edits the config later. Unsourced
  // legacy/manual rows deliberately stay on the old calculation path.
  const exactFeesByScope = new Map<string, { baseC: number; sstC: number }>();
  const scopeKey = (row: Pick<PayoutLedgerRow, "apartmentId" | "propertyId">) =>
    row.apartmentId ? `apartment:${row.apartmentId}` : `property:${row.propertyId ?? "all"}`;
  for (const row of expenseRows) {
    if (row.category !== "management_fee" || !row.sourceChargeId) continue;
    const key = scopeKey(row);
    const current = exactFeesByScope.get(key) ?? { baseC: 0, sstC: 0 };
    current.baseC += toCents(row.amount.toString(), "computeOwnerPayout");
    current.sstC += row.sstAmount == null
      ? 0
      : toCents(row.sstAmount.toString(), "computeOwnerPayout");
    exactFeesByScope.set(key, current);
  }
  const consumedExactFeeScopes = new Set<string>();

  const lineFees = incomeRows.map((e) => {
    const key = scopeKey(e);
    const exact = exactFeesByScope.get(key);
    if (exact && !consumedExactFeeScopes.has(key) && FEE_INCOME_CATEGORIES.has(e.category)) {
      consumedExactFeeScopes.add(key);
      return {
        base: centsToString(exact.baseC),
        sst: centsToString(exact.sstC),
        baseC: exact.baseC,
        sstC: exact.sstC,
      };
    }
    if (exact && consumedExactFeeScopes.has(key)) {
      return { base: "0.00", sst: "0.00", baseC: 0, sstC: 0 };
    }
    const feeCfg = FEE_INCOME_CATEGORIES.has(e.category)
      ? resolveFeeCfgForUnit(e.apartmentId ?? null, e.propertyId ?? null)
      : null;
    if (!feeCfg) return { base: "0.00", sst: "0.00", baseC: 0, sstC: 0 };
    const fee = computeManagementFee(feeCfg, money2dp(e.amount));
    return {
      base: fee.base,
      sst: fee.sst,
      baseC: toCents(fee.base, "computeOwnerPayout"),
      sstC: toCents(fee.sst, "computeOwnerPayout"),
    };
  });
  let computedMgmtBaseC = 0;
  let computedMgmtSstC = 0;
  for (const f of lineFees) {
    computedMgmtBaseC += f.baseC;
    computedMgmtSstC += f.sstC;
  }
  const computedMgmtTotalC = computedMgmtBaseC + computedMgmtSstC;

  const grossCashInC = grossRentalC + depositCollectedC;

  // Expenses EXCLUDING §5-suppressed rows (management_fee — superseded by the single
  // computed KAEN Service Fee — and display-only Source-2 utility twins), partitioned
  // into all vs deductible (includeInPayout:true). The computed mgmt fee is fully
  // deductible (KAEN collects it from the payout).
  let nonFeeAllExpensesC = 0;
  let nonFeeDeductibleC = 0;
  for (const e of expenseRows) {
    if (isSuppressedFromSection5(e.category, e.includeInPayout)) continue;
    const c =
      toCents(e.amount.toString(), "computeOwnerPayout") +
      (e.sstAmount != null ? toCents(e.sstAmount.toString(), "computeOwnerPayout") : 0);
    nonFeeAllExpensesC += c;
    if (e.includeInPayout) nonFeeDeductibleC += c;
  }
  const totalExpensesC = nonFeeAllExpensesC + computedMgmtTotalC;
  const deductibleExpensesC = nonFeeDeductibleC + computedMgmtTotalC;
  const ownerPaidExpensesC = nonFeeAllExpensesC - nonFeeDeductibleC;
  const netPayoutNoDepositC = grossRentalC - deductibleExpensesC;
  const totalPayoutC = grossCashInC - deductibleExpensesC;
  const payableToOwnerC = Math.max(0, totalPayoutC);
  const ownerTopUpRequiredC = Math.max(0, -totalPayoutC);

  return {
    grossRentalC,
    grossRentalStr: summary.grossRental,
    depositCollectedC,
    grossCashInC,
    computedMgmtBaseC,
    computedMgmtSstC,
    computedMgmtTotalC,
    nonFeeAllExpensesC,
    nonFeeDeductibleC,
    totalExpensesC,
    deductibleExpensesC,
    ownerPaidExpensesC,
    netPayoutNoDepositC,
    totalPayoutC,
    payableToOwnerC,
    ownerTopUpRequiredC,
    lineFees,
  };
}

// ─── Shared ledger query (Task 5: also consumed by the owner Receipt) ─────────

/**
 * Return all ACTIVE OwnerLedgerEntry rows for an owner+month, optionally scoped
 * to a single apartment.  This is the EXACT query the statement assembler uses —
 * extracting it here ensures the owner Receipt (Task 6) and the statement can
 * never disagree on which rows they see.
 *
 * Identical filter semantics:
 *   - status: "active"  (voided rows excluded)
 *   - optional apartmentId scope (null ⇒ all apartments for this owner+month)
 * Identical deterministic orderBy (direction asc → category asc → createdAt asc → id asc).
 */
export async function findOwnerLedgerRowsForMonth(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  monthStart: Date,
  apartmentId: string | null,
) {
  const db = getDb();
  return db.ownerLedgerEntry.findMany({
    where: {
      organizationId: ctx.orgId,
      ownerPartyId,
      statementMonth: monthStart,
      status: "active",
      ...(apartmentId ? { apartmentId } : {}),
    },
    orderBy: [
      { direction: "asc" },
      { category: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Assemble the 5-section Yannie statement for a given statementId.
 * Returns null when the statement is not found, or has no ownerPartyId / periodMonth.
 */
export async function assembleYannieStatement(
  ctx: OwnerBillingActorCtx,
  statementId: string,
): Promise<YannieSections | null> {
  const db = getDb();

  // 1. Query Invoice — resolve the (owner, month, apartment) ANCHOR + header
  // identity from the owner_statement Invoice, then delegate to the shared
  // assembler. Everything below the anchor is IDENTICAL whether it came from a
  // statement Invoice (issued path) or straight from (owner, month) (live view).
  const invoice = await db.invoice.findFirst({
    where: { id: statementId, organizationId: ctx.orgId, invoiceType: "owner_statement" },
    select: { id: true, ownerPartyId: true, periodMonth: true, apartmentId: true },
  });
  if (!invoice || !invoice.ownerPartyId || !invoice.periodMonth) return null;

  // Task 5: when the owner_statement Invoice carries an apartmentId, scope the
  // statement to THAT apartment (ledger + listings, and thus deposits). Null ⇒
  // verbatim legacy behaviour (all owner listings combined).
  return assembleYannieStatementForMonth(
    ctx,
    invoice.ownerPartyId,
    invoice.periodMonth,
    invoice.apartmentId ?? null,
  );
}

/**
 * LIVE (no-invoice) assembler — build the SAME 5-section YannieSections directly
 * from the posted ledger for (owner, month[, apartment]), WITHOUT an
 * owner_statement Invoice. This is the shared body behind BOTH:
 *   - assembleYannieStatement (issued path — anchor resolved from the Invoice)
 *   - getLiveStatementSectionsService (live path — owner+month passed directly)
 * so the pre-issue live view and a freshly-issued statement show IDENTICAL
 * numbers for the same month. It never touches the owner_statement Invoice and
 * never mutates — a pure read of the posted OwnerLedgerEntry rows + listings +
 * deposits. Always returns sections (never null): an owner+month with no ledger
 * activity yields empty sections (zero totals); the live view gates that case.
 *
 * `periodMonth` is any Date inside the target month (first-of-month by
 * convention); the internal window helpers normalise it exactly as the
 * Invoice.periodMonth path always has.
 */
export async function assembleYannieStatementForMonth(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  periodMonth: Date,
  apartmentId: string | null,
): Promise<YannieSections> {
  const db = getDb();

  // 2. Query Party for owner
  const party = await db.party.findFirst({
    where: { id: ownerPartyId, organizationId: ctx.orgId },
    select: {
      displayName: true,
      bankName: true,
      bankAccountHolder: true,
      bankAccountNumber: true,
    },
  });

  // 3. Query OwnerLedgerEntry rows for this owner + month
  // Deterministic row order: the PDF render and the GET /sections API are
  // SEPARATE invocations of this assembler. Without a stable orderBy the DB may
  // return income/expense rows — and therefore the "first income row per listing"
  // that the mgmt-fee column attaches to — in a different order each time, so the
  // soft-copy could drift from the screen. Ordering only; totals are order-independent.
  const monthStart = firstDayOfMonth(periodMonth);
  const ledgerEntries = await findOwnerLedgerRowsForMonth(ctx, ownerPartyId, monthStart, apartmentId);

  // 4. Query owner's Listing rows (non-archived)
  const listings = await db.listing.findMany({
    where: {
      ownerPartyId,
      organizationId: ctx.orgId,
      listingStatus: { not: "archived" },
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: {
      id: true,
      rentalRate: true,
      apartment: {
        select: {
          // id + listingMode drive the derived "Extra Electricity" memo below: the
          // ledger keys its rows by apartmentId, and only a PARTITIONED unit can have
          // an aircond spread at all (a whole unit has one meter, so the
          // AIRCON_EXCEEDS_TNB guard rejects aircond > TNB as a data error).
          id: true,
          listingMode: true,
          unitCode: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
      tenancies: {
        where: { status: "active" },
        select: {
          startDate: true,
          endDate: true,
          monthlyRentAmount: true,
          depositAmount: true,
          tenantParty: { select: { displayName: true } },
        },
        take: 1,
      },
    },
    orderBy: { apartment: { unitCode: "asc" } },
  });

  const unitIds = listings.map((l) => l.id);
  // M-C1: end-of-day-INCLUSIVE upper bound (shared helper) so a deposit collected
  // any time on the last calendar day lands in THIS month — and so the statement,
  // the /months card, and the running balance use a byte-identical window.
  const monthEnd = depositWindowEndOfMonth(periodMonth);

  // 5. Find deposits collected in the month window — deposits RELEASED to the
  //    owner, i.e. real cash-in. See findDepositsCollectedInMonth.
  const deposits = await findDepositsCollectedInMonth(ctx.orgId, unitIds, monthStart, monthEnd);

  // 5b. Deposits KAEN is HOLDING for these units. A balance, so no month window:
  //     it reappears on every statement until the deposit is released or refunded.
  //     Display-only — deliberately NOT fed to computeOwnerPayout below.
  const depositsHeld = await findDepositsHeldForUnits(ctx.orgId, unitIds);

  // Build deposits-by-unit map (sum across deposit types)
  const depositsByUnit = new Map<string, number>();
  for (const dep of deposits) {
    const curr = depositsByUnit.get(dep.unitId) ?? 0;
    depositsByUnit.set(dep.unitId, curr + toCents(dep.amount, "assembleYannieStatement"));
  }

  // ─── Section 1: Header ──────────────────────────────────────────────────────

  const propertyName = listings[0]?.apartment?.property?.name ?? "—";
  const ownerName = party?.displayName ?? "—";

  const header: StatementHeader = {
    reportMonth: monthLabel(periodMonth),
    propertyName,
    ownerName,
    bankName: party?.bankName ?? null,
    accountHolder: party?.bankAccountHolder ?? null,
    accountNumberMasked: party?.bankAccountNumber?.replace(/\s+/g, "") || null,
  };

  // ─── Section 2: Occupancy ──────────────────────────────────────────────────

  let occupiedCount = 0;
  let vacantCount = 0;
  let totalMonthlyRentalC = 0;
  const occupancyRows: OccupancyRow[] = [];

  for (const listing of listings) {
    const activeTenancy = listing.tenancies[0] ?? null;
    const isVacant = activeTenancy == null;

    let monthlyRentalStr: string;
    if (!isVacant && activeTenancy) {
      monthlyRentalStr = money2dp(activeTenancy.monthlyRentAmount);
    } else if (listing.rentalRate != null) {
      monthlyRentalStr = money2dp(listing.rentalRate);
    } else {
      monthlyRentalStr = "0.00";
    }

    // depositMonths = round(depositAmount / monthlyRentAmount) when both > 0
    let depositMonths: number | null = null;
    if (!isVacant && activeTenancy?.depositAmount && activeTenancy?.monthlyRentAmount) {
      const rentCents = toCents(
        activeTenancy.monthlyRentAmount.toString(),
        "assembleYannieStatement",
      );
      if (rentCents > 0) {
        const depCents = toCents(
          activeTenancy.depositAmount.toString(),
          "assembleYannieStatement",
        );
        depositMonths = Math.round(depCents / rentCents);
      }
    }

    const depositC = depositsByUnit.get(listing.id) ?? 0;

    totalMonthlyRentalC += toCents(monthlyRentalStr, "assembleYannieStatement");
    if (isVacant) {
      vacantCount++;
    } else {
      occupiedCount++;
    }

    // Derive ISO date strings without time component
    const tenancyStartIso = activeTenancy?.startDate
      ? activeTenancy.startDate.toISOString().split("T")[0] ?? null
      : null;
    const tenancyEndIso = activeTenancy?.endDate
      ? activeTenancy.endDate.toISOString().split("T")[0] ?? null
      : null;

    occupancyRows.push({
      unitCode: listing.apartment.unitCode,
      tenantName: activeTenancy?.tenantParty?.displayName ?? null,
      tenancyStart: tenancyStartIso,
      tenancyEnd: tenancyEndIso,
      monthlyRental: monthlyRentalStr,
      depositMonths,
      depositAmount: centsToString(depositC),
      isVacant,
    });
  }

  // ─── Section 3: Payout Summary ─────────────────────────────────────────────

  // §4/§5 breakdowns iterate the income/expense rows directly; the payout math +
  // per-line management fee come from the SHARED computeOwnerPayout helper (the
  // SAME one getOwnerMonthsService uses for the /months card), so the statement's
  // "Total Payout to Owner" and the card's net payout can never diverge.
  const expenseLedgerRows = ledgerEntries.filter((e) => e.direction === "expense");
  const incomeLedgerRows = ledgerEntries.filter((e) => e.direction === "income");

  // Task 6: fetch the source Charge's billed amount for each income ledger row that
  // carries a sourceChargeId (rent + tenant-borne charges). Manual rows (null
  // sourceChargeId) fall back to the collected `amount`. This map is DISPLAY-ONLY —
  // all payout math continues to use the collected `amount` on the ledger entry.
  const incomeSourceChargeIds = incomeLedgerRows
    .map((e) => e.sourceChargeId)
    .filter((id): id is string => id != null);
  const chargedAmountByChargeId = new Map<string, string>();
  // …and its description, which carries WHICH utility the line is (electricity /
  // water / WiFi / cleaning). Without it every tenant-borne row renders as the same
  // opaque "Shared Utility" badge. Same fetch, one extra column.
  const detailByChargeId = new Map<string, string>();
  // CN/DN visibility (fix 2026-08-07): "Credit note -RM x" / "Debit note +RM x"
  // text appended to the row's detail line, split (not netted) because the owner
  // must see WHICH way the figure moved — same wording the tenant surfaces use.
  const adjustmentNoteByChargeId = new Map<string, string>();
  if (incomeSourceChargeIds.length > 0) {
    const [sourceCharges, incomeAdjSums] = await Promise.all([
      db.charge.findMany({
        where: { id: { in: incomeSourceChargeIds } },
        select: { id: true, amount: true, description: true },
      }),
      adjustmentSumsByChargeId(db, ctx.orgId, incomeSourceChargeIds),
    ]);
    for (const c of sourceCharges) {
      const adj = incomeAdjSums.get(c.id);
      const debitC = adj?.debitCents ?? 0;
      const creditC = adj?.creditCents ?? 0;
      // Billed AFTER active notes. The raw mint amount disagreed with everything
      // else the moment a note landed: the tenant's own invoice shows the
      // adjusted figure, and the ledger `amount` (collected) now nets notes too —
      // §4's primary cell showing raw 400 above a 370-collected total was the
      // reported "credit note not showing" bug on this surface.
      const billedAdjustedC = Math.max(
        0,
        toCents(money2dp(c.amount), "chargedAmountAdjusted") + debitC - creditC,
      );
      chargedAmountByChargeId.set(c.id, centsToString(billedAdjustedC));
      const detail = incomeRowDetail(c.description);
      if (detail != null) detailByChargeId.set(c.id, detail);
      // No SST clause on §4: an income row's SST column is the management-fee tax,
      // which no credit note touches — see adjustmentNoteText.
      const note = adjustmentNoteText({ debitCents: debitC, creditCents: creditC });
      if (note != null) adjustmentNoteByChargeId.set(c.id, note);
    }
  }

  // The owner's active ManagementFeeConfig rows (resolved PER income line's property
  // inside the helper: property-specific OVERRIDES the all-properties default; latest
  // wins — Postgres NULLS-FIRST can't express that in one findFirst, so load all).
  const feeConfigRows = await db.managementFeeConfig.findMany({
    where: { organizationId: ctx.orgId, ownerPartyId, isActive: true },
    select: { propertyId: true, apartmentId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, effectiveFrom: true, effectiveTo: true, freePeriodStart: true, freePeriodEnd: true, updatedAt: true },
  });

  // Sum total deposit collected (all units combined).
  const depositTotalC = [...depositsByUnit.values()].reduce((acc, c) => acc + c, 0);
  const depositTotal = centsToString(depositTotalC);

  // Sum total deposit HELD (all units combined). Enters no total — it is neither
  // income nor expense nor Gross Cash In, unlike depositTotalC above.
  const depositHeldTotalC = depositsHeld.reduce(
    (acc, d) => acc + toCents(d.amount, "assembleYannieStatement"),
    0,
  );
  const depositHeld = centsToString(depositHeldTotalC);

  // ─── Owner receivables (IVOWN) — real owner costs that are NOT ledger rows ────
  //
  // Bills-grid owner-borne costs (maintenance, owner-funded utilities, freeform owner
  // expenses) land on an IVOWN invoice, and IVOWN charges are deliberately NOT
  // owner-ledger expense rows: the durable XOR at owner-ledger.sync.ts:114-150 keeps a
  // charge with a live IVOWN line out of Source 6, because it is a receivable rather
  // than a Source-6 deduction.
  //
  // They are still, unambiguously, money the owner bears. Leaving them out of the
  // payout made the statement claim the owner's only cost was KAEN's fee, and left §5
  // listing RM 1,124 of rows under a RM 324 total — a table that did not foot.
  //
  // Sourced from the IVOWN invoice, not from the offset allocations, so a cost counts
  // from the moment it is BILLED rather than only once collected: an owner should see
  // what they owe before it is taken, not after.
  // Shared with resolveOwnerPayoutForScope and getOwnerMonthsService, so the
  // statement, the Live Ledger Summary and the /months card cannot disagree.
  const receivablePayoutRows = await fetchOwnerReceivablePayoutRows(
    ctx.orgId,
    ownerPartyId,
    monthStart,
    apartmentId,
    ledgerEntries,
  );

  // SHARED payout computation. lineFees aligns 1:1 with incomeLedgerRows — the helper
  // filters income from the SAME ledgerEntries array, in the same order. The appended
  // receivable rows are all `expense`, so they never disturb that income alignment.
  const payout = computeOwnerPayout({
    rows: [...ledgerEntries, ...receivablePayoutRows] as typeof ledgerEntries,
    feeConfigRows,
    // depositHeldTotalC is deliberately NOT added here. Held deposits are the
    // tenant's money; adding them pays the owner RM6,600 that isn't theirs (the
    // "holding a deposit moves NO payout figure" integration test proves it).
    depositCollectedC: depositTotalC,
    statementMonth: monthStart,
  });
  const {
    grossRentalStr,
    grossCashInC,
    computedMgmtBaseC,
    computedMgmtSstC,
    computedMgmtTotalC,
    totalExpensesC,
    deductibleExpensesC,
    ownerPaidExpensesC,
    netPayoutNoDepositC,
    payableToOwnerC,
    ownerTopUpRequiredC,
    lineFees,
  } = payout;
  const grossCashIn = centsToString(grossCashInC);

  const payoutLines: PayoutSummaryLine[] = [
    { label: "Total Income Collected", amount: grossRentalStr },
    { label: "Add: Deposit Collected", amount: depositTotal, isNonIncome: true },
    { label: "Gross Cash In", amount: grossCashIn },
    // Only the actually-deducted (includeInPayout:true) expenses reduce the payout,
    // so the waterfall always reconciles: GrossCashIn − Deductible = Total Payout.
    { label: "Less: Deductible Expenses", amount: centsToString(deductibleExpensesC) },
  ];

  // Owner-paid expenses (includeInPayout:false) appear as a non-income memo line —
  // visible for transparency but NOT deducted from the payout (mirrors the
  // Deposit-Collected non-income line). Emitted only when present, so the default
  // statement (all expenses deductible) is unchanged apart from the relabel above.
  if (ownerPaidExpensesC > 0) {
    payoutLines.push({
      label: "Owner-paid expenses (not deducted)",
      amount: centsToString(ownerPaidExpensesC),
      isNonIncome: true,
    });
  }

  // Deposits KAEN is holding for this owner's tenants. A memo line in the
  // STRICTEST sense: not income, not an expense, and part of NO total — unlike
  // "Add: Deposit Collected" above, which is also non-income but IS summed into
  // Gross Cash In. It answers "where is my tenant's deposit?" without moving a
  // cent, and reappears every month until the deposit is released or refunded.
  // Emitted only when non-zero, so a statement for an owner holding none is
  // byte-identical to before this line existed.
  if (depositHeldTotalC > 0) {
    payoutLines.push({
      label: "Deposit held by KAEN",
      amount: depositHeld,
      isNonIncome: true,
    });
  }

  // G1: Total Payout = GrossCashIn − Deductible (= netPayout + deposit). The line
  // gains the deposit so the waterfall reconciles when a deposit is present.
  payoutLines.push({
    label: "Total Payout to Owner",
    amount: centsToString(payableToOwnerC),
    isTotal: true,
  });
  if (ownerTopUpRequiredC > 0) {
    payoutLines.push({
      label: "Owner Top-up Required",
      amount: centsToString(ownerTopUpRequiredC),
      isNonIncome: true,
    });
  }

  // ─── Section 4: Income Breakdown ───────────────────────────────────────────

  // Lookup maps from listings
  const unitCodeByListingId = new Map<string, string>();
  const tenantNameByListingId = new Map<string, string | null>();
  // Keyed by APARTMENT (not listing) for the derived memo below — a partition unit has
  // many listings (one per room) but exactly one master TNB bill and one listing mode.
  const apartmentById = new Map<string, { unitCode: string; listingMode: string }>();
  for (const listing of listings) {
    unitCodeByListingId.set(listing.id, listing.apartment.unitCode);
    tenantNameByListingId.set(
      listing.id,
      listing.tenancies[0]?.tenantParty?.displayName ?? null,
    );
    apartmentById.set(listing.apartment.id, {
      unitCode: listing.apartment.unitCode,
      listingMode: listing.apartment.listingMode,
    });
  }

  let totalIncomeC = 0;
  let passThroughIncomeC = 0;

  const incomeRowsMapped: IncomeBreakdownRow[] = incomeLedgerRows.map((e, i) => {
    const incomeType = categoryToIncomeType(e.category);
    const amount = money2dp(e.amount);
    const fee = lineFees[i]!; // 1:1 with incomeLedgerRows

    // A pass-through row is tenant utility money in transit to the supplier. It is
    // out of grossRental (summarizeOwnerPeriod), so counting it here would make §4
    // foot to a different number than "Total Income Collected" in the Payout
    // Summary — the owner would see two contradictory income totals.
    const isPassThrough = isPassThroughIncomeLine({
      direction: "income",
      category: e.category,
      amount,
      sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
      includeInPayout: e.includeInPayout,
      taxCategory: e.taxCategory,
    });
    if (isPassThrough) passThroughIncomeC += toCents(amount, "assembleYannieStatement");
    else totalIncomeC += toCents(amount, "assembleYannieStatement");

    // Task 6: chargedAmount = what was BILLED (Charge.amount); falls back to the
    // collected `amount` for manual rows that carry no sourceChargeId. DISPLAY-ONLY —
    // `amount` (collected) continues to drive all payout math unchanged.
    const chargedAmount: string =
      e.sourceChargeId != null
        ? (chargedAmountByChargeId.get(e.sourceChargeId) ?? amount)
        : amount;

    return {
      unitCode: e.listingId ? (unitCodeByListingId.get(e.listingId) ?? "—") : "—",
      tenantName: e.listingId ? (tenantNameByListingId.get(e.listingId) ?? null) : null,
      incomeType,
      billingPeriod: monthLabel(e.statementMonth),
      amount,
      chargedAmount,
      mgmtFee: fee.base,
      mgmtFeeSst: fee.sst,
      paymentStatus: e.paymentStatus,
      // Prefer the ledger row's own description (an admin may have written a better
      // one); fall back to the source charge's. Legacy rows need no re-sync — the
      // detail is read from the charge at render time. Active CN/DN on the source
      // charge are appended so the owner sees WHY the figure differs from the mint.
      detail: appendAdjustmentNote(
        incomeRowDetail(e.description ?? null)
          ?? (e.sourceChargeId != null ? (detailByChargeId.get(e.sourceChargeId) ?? null) : null),
        e.sourceChargeId != null ? adjustmentNoteByChargeId.get(e.sourceChargeId) : undefined,
      ),
      isPassThrough,
      isInformational: false, // real income rows only — see the informational append below
    };
  });

  // Task B2 (#9): hide a Shared-Utility row that computed to a genuine RM0.00 BILL
  // (the owner's subsidy fully covered that room's share) — a confusing render
  // artifact, not new information. Filtered AFTER the map so lineFees[i] index
  // alignment above stays intact. A 0.00 row already contributed exactly 0 to
  // totalIncomeC above, so totals are unchanged.
  //
  // Checks BOTH `amount` (collected) AND `chargedAmount` (billed) — `amount`
  // alone is not enough. OwnerLedgerEntry.amount for a utility_income row is
  // collected = billed − outstanding (owner-ledger.sync.ts collectedString()), so
  // an ordinary UNPAID utility bill also carries amount:"0.00" while
  // chargedAmount stays the real billed figure. Requiring chargedAmount:"0.00"
  // too ensures this only ever hides a truly zero-billed line, never a real
  // unpaid receivable (see the Task-6 chargedAmount comment above).
  const incomeRows = incomeRowsMapped.filter(
    (row) =>
      !(
        row.incomeType === categoryToIncomeType("utility_income") &&
        row.amount === "0.00" &&
        row.chargedAmount === "0.00"
      ),
  );

  // INFORMATIONAL rows (direction "informational"). owner-ledger.sync.ts books the
  // first month's rent here — KAEN keeps it as letting commission, so the owner earns
  // nothing that month. The ledger row was already written to explain exactly that
  // ("First month rental retained by KAEN as Admin Fee"), but §4 previously
  // filtered to direction "income"/"expense" only, so it never reached any surface:
  // the owner saw RM 0.00 income plus an unexplained owner-borne SST deduction — the
  // precise confusion the row exists to prevent.
  //
  // Appended AFTER the filter above, deliberately:
  //   • lineFees[i] is 1:1 with incomeLedgerRows — these rows are NOT in that array,
  //     so they must never enter the mapped loop or every fee would shift by one.
  //   • totalIncomeC / passThroughIncomeC are already summed above, so an appended
  //     row cannot perturb either total. Both fee columns are hard "0.00": charging
  //     a management fee on rent the owner never received is the exact bug
  //     owner-ledger.sync.ts:626-631 refuses to create an income row to avoid.
  const informationalRows: IncomeBreakdownRow[] = ledgerEntries
    .filter((e) => e.direction === "informational")
    .map((e) => ({
      unitCode: e.listingId ? (unitCodeByListingId.get(e.listingId) ?? "—") : "—",
      tenantName: e.listingId ? (tenantNameByListingId.get(e.listingId) ?? null) : null,
      incomeType: "Admin Fee (First Month Rental)" as const,
      billingPeriod: monthLabel(e.statementMonth),
      amount: money2dp(e.amount),
      chargedAmount: money2dp(e.amount),
      mgmtFee: "0.00",
      mgmtFeeSst: "0.00",
      paymentStatus: e.paymentStatus,
      detail: e.description ?? null,
      isPassThrough: false,
      isInformational: true,
    }));
  incomeRows.push(...informationalRows);

  // ─── DERIVED: "Extra Electricity" memo (PARTITION units) ──────────────────────
  //
  // A partition room's aircond is submetered at KAEN's own RM/kWh, which sits ABOVE
  // TNB's tariff, so Σ per-room aircond can exceed the master TNB bill. That spread is
  // genuinely the owner's — they pay TNB and recover more through the separately-billed
  // AC- charges — and it ALREADY reaches their payout, as two rows that never name it:
  // "Aircond Fee" income (Source 4) minus the raw master bill booked as an owner
  // expense (Source 7 / Source 3). The owner saw both numbers and no explanation of the
  // difference; this names it.
  //
  // DERIVED, NEVER A LEDGER ROW. Posting a real +50 entry would pay the owner TWICE —
  // the income and expense above already net to exactly this figure. So it follows the
  // informational-row discipline above: appended AFTER totalIncomeC / passThroughIncomeC
  // are summed, so it cannot perturb either; zero management fee; excluded from every
  // total. Payout math is untouched — computeOwnerPayout reads ledger rows, not this.
  //
  // Both sides read the ledger's COLLECTED `amount`, so the memo reconciles line-for-
  // line with the two rows the owner can see in this same statement. A consequence
  // worth keeping: an unpaid or part-paid month yields NO row rather than announcing a
  // spread KAEN has not actually collected — it can understate, never overstate.
  //
  // An apartment with no non-archived listing is absent from apartmentById and is
  // skipped: there is no unit code to render the row under, and no listing means no
  // live rooms billing aircond this month.
  // DERIVED memo rows (partition aircond spread) — see deriveExtraElectricityRows.
  // Appended HERE, after totalIncomeC / passThroughIncomeC are summed and after the
  // lineFees[i] loop, for the same two reasons the informational rows are: they are not
  // in incomeLedgerRows (so they must never enter the mapped loop or every fee shifts by
  // one), and they must not perturb either total.
  incomeRows.push(...deriveExtraElectricityRows(ledgerEntries, apartmentById, monthStart));

  // ─── Section 5: Expense Breakdown ──────────────────────────────────────────
  //
  // Ledger expense rows EXCEPT the §5-suppressed ones (management_fee — replaced by
  // the single computed KAEN Service Fee appended below — and the display-only
  // Source-2 utility twins, so each utility expense is listed once).
  // Web-visibility (ENABLE_OWNER_WEB_EXPENSE_HIDE): load each utility row's bill so
  // its snapshotted per-category bearer can mark the row tenant-funded vs
  // owner-absorbed. Only indahWater + wifi carry a per-bill bearer (tnb/water are
  // always tenant), so ONLY those bills are fetched. Purely additive — sets a field
  // the PDF ignores; no effect on payout math or the assembled totals. Gated on the
  // flag so this extra query is zero-overhead while the feature is dark (every non-
  // portal assembly — PDF, /statements/export, admin live — also skips it; the field
  // it feeds is consumed ONLY by the flag-gated portal filter).
  const bearerBillIds = isPhase2FlagEnabled("ENABLE_OWNER_WEB_EXPENSE_HIDE")
    ? [
        ...new Set(
          expenseLedgerRows
            .filter((e) => e.sourceType === "utility_indah_water" || e.sourceType === "utility_wifi")
            .map((e) => e.sourceUtilityBillId)
            .filter((id): id is string => id != null),
        ),
      ]
    : [];
  const billBearers = new Map<string, { indahWaterBearer: string; wifiBearer: string }>();
  if (bearerBillIds.length > 0) {
    const bills = await getDb().unitUtilityBill.findMany({
      where: { id: { in: bearerBillIds } },
      select: { id: true, indahWaterBearer: true, wifiBearer: true },
    });
    for (const b of bills) billBearers.set(b.id, { indahWaterBearer: b.indahWaterBearer, wifiBearer: b.wifiBearer });
  }

  // CN/DN visibility on the OTHER §5 family (2026-08-17). A charge-backed ledger
  // expense — the `statement` rows: letting-commission SST and friends — already
  // carries a note-NETTED amount: owner-ledger.sync nets active notes in through
  // expectedStatementLedgerRows before writing the row. So §5 was showing an
  // adjusted figure with nothing naming the adjustment, exactly as the receivables
  // were. ONE batched query over every charge-backed expense row.
  //
  // The amount is the SYNCED one and this note is read LIVE, so a note raised after
  // the last sync annotates a row that has not moved yet. That is the honest failure
  // here: it surfaces stale sync (a re-sync reconciles them) instead of hiding it,
  // and it is strictly better than the silence it replaces.
  const expenseAdjSplit = await adjustmentSplitByChargeId(
    db,
    ctx.orgId,
    [...new Set(expenseLedgerRows.map((e) => e.sourceChargeId).filter((id): id is string => id != null))],
  );

  const expenseRows: ExpenseBreakdownRow[] = expenseLedgerRows
    .filter((e) => !isSuppressedFromSection5(e.category, e.includeInPayout))
    .map((e) => ({
      category: categoryToExpenseLabel(e.category),
      categoryKey: e.category, // RAW key — the per-row proof attach posts category=<categoryKey>
      description: e.description ?? null,
      adjustmentNote: e.sourceChargeId
        ? adjustmentNoteText(
            expenseAdjSplit.get(e.sourceChargeId) ?? { debitCents: 0, creditCents: 0 },
          )
        : null,
      amount: money2dp(e.amount),
      sstAmount: e.sstAmount != null ? money2dp(e.sstAmount) : "0.00",
      paymentStatus: e.paymentStatus,
      sourceType: e.sourceType, // web-visibility discriminator (recharge vs owner-borne)
      tenantRecharged: utilityRowTenantFunded(
        e.sourceType,
        e.sourceUtilityBillId ? billBearers.get(e.sourceUtilityBillId) : undefined,
      ),
      // Task 9: display-only paid-on-behalf metadata (null on ordinary expenses).
      payeeName: e.payeeName ?? null,
      paidOnBehalfRef: e.paidOnBehalfRef ?? null,
      paidOnBehalfDate: e.paidOnBehalfDate
        ? (e.paidOnBehalfDate.toISOString().split("T")[0] ?? null)
        : null,
    }));

  // The single mgmt-fee expense = Σ per-line fee (the same figure deducted from the
  // payout). Emitted only when there is a fee, so fee-free statements are unchanged.
  if (computedMgmtTotalC > 0) {
    // Status DERIVED from the income lines that produced the fee — never hardcoded.
    // lineFees is 1:1 with incomeLedgerRows (see the computeOwnerPayout call above and
    // the §4 mapped loop, which relies on the same alignment), so index i pairs a fee
    // with the ledger row whose tenant settlement it depends on.
    const feeBearingIncomeStatuses = incomeLedgerRows
      .filter((_, i) => {
        const f = lineFees[i];
        return f != null && f.baseC + f.sstC > 0;
      })
      .map((e) => e.paymentStatus);

    expenseRows.push({
      category: categoryToExpenseLabel("management_fee"),
      categoryKey: "management_fee",
      description: "Property Management Fee (Per Income Line)",
      // COMPUTED from the fee config against collected income — it has no charge of
      // its own, so no credit/debit note can move it.
      adjustmentNote: null,
      amount: centsToString(computedMgmtBaseC),
      sstAmount: centsToString(computedMgmtSstC),
      // ⚠️ Derived, NOT "paid" — see computedMgmtFeePaymentStatus. The amount above and
      // its full payout deduction are unchanged; only this label follows the tenant.
      paymentStatus: computedMgmtFeePaymentStatus(feeBearingIncomeStatuses),
      sourceType: "management_fee", // owner-borne KAEN fee → never web-visible (not in the allow-list)
      tenantRecharged: false, // not a utility; never web-visible

      // The computed mgmt-fee line is never paid-on-behalf.
      payeeName: null,
      paidOnBehalfRef: null,
      paidOnBehalfDate: null,
    });
  }

  // Owner receivables settled straight out of the rent (auto-offset, or an admin's
  // manual offset). These are REAL owner costs — bills-grid owner-borne expenses on
  // an IVOWN invoice — that KAEN recovered from the rent before remitting. They are
  // NOT owner-ledger expense rows: the durable XOR at owner-ledger.sync.ts:114-150
  // keeps a charge that has a live IVOWN line out of Source 6, because it is a
  // receivable rather than a payout deduction. So without this the owner saw the
  // money leave (their invoice went Paid, their balance dropped) with nothing on the
  // statement naming it.
  //
  // Listed, never summed into totalExpenses. computeOwnerPayout reads only
  // direction income/expense, so "Net Payout to Owner" deliberately still means
  // "what you earned this month net of costs", BEFORE settlements — the same figure
  // every other surface shows. Folding these in here would silently disagree with
  // the /months card, which runs the same engine.
  // Listed ITEMISED, not as one lump. Collapsing them into a single "settled" total
  // is what made the owner ask where their maintenance and utility costs went — the
  // money left, the invoice went Paid, and the statement named none of it.
  //
  // Sourced from the IVOWN invoice itself rather than from the offset allocations, so
  // a cost appears the moment it is BILLED, not only once it has been settled — an
  // owner should see what they owe before it is collected, not after.
  // Display rows for the SAME receivables already folded into the payout above — one
  // fetch, one filter, so the listed lines and the total can never disagree.
  for (const c of receivablePayoutRows) {
    expenseRows.push({
      category: "Owner expense",
      categoryKey: "owner_receivable",
      description: c.description,
      // Carried verbatim from the helper that netted `amount`/`sstAmount` below.
      adjustmentNote: c.adjustmentNote,
      amount: money2dp(c.amount),
      // The SST actually invoiced on this charge's IVOWN line — see the helper's own
      // note. Hardcoding "0.00" here showed an owner billed RM 216.00 a RM 200.00 cost.
      sstAmount: c.sstAmount,
      // Real settlement state: "paid" once the auto-offset (or a manual one) has
      // netted it out of the rent, "pending" while it is still owed.
      paymentStatus: receivableChargePaymentStatus(c.status),
      sourceType: "owner_receivable", // not a utility → never web-visible
      tenantRecharged: false,
      payeeName: null,
      paidOnBehalfRef: null,
      paidOnBehalfDate: null,
    });
  }

  // ─── Assemble result ────────────────────────────────────────────────────────

  return {
    header,
    apartmentId,
    occupancy: {
      rows: occupancyRows,
      occupiedCount,
      vacantCount,
      totalMonthlyRental: centsToString(totalMonthlyRentalC),
    },
    payoutSummary: {
      lines: payoutLines,
      netPayoutToOwner: centsToString(netPayoutNoDepositC),
      depositCollected: depositTotal,
      depositHeld,
    },
    incomeBreakdown: {
      rows: incomeRows,
      totalIncome: centsToString(totalIncomeC),
      // Tenant utility money collected and forwarded to suppliers — shown as a memo,
      // deliberately NOT part of totalIncome.
      passThroughIncome: centsToString(passThroughIncomeC),
      totalMgmtFee: centsToString(computedMgmtTotalC),
    },
    expenseBreakdown: {
      rows: expenseRows,
      totalExpenses: centsToString(totalExpensesC),
    },
  };
}
