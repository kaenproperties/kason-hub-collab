// Bills & Expenses Grid — typed web API client (UI Task 1). Mirrors the house
// style of apps/web/src/api/meter.ts: apiFetch/getAdminToken, no hardcoded
// storage keys, and response typing lifted verbatim from the server DTOs in
// apps/api/src/modules/bills-grid/service.ts + routes.ts.
//
// AUTH per routes.ts: read + Save-oriented paths admit "editor"; Bill, bearer-
// config writes, and expense/attachment void/delete require "manager". This
// module does not enforce that — the server does; it only shapes requests.
//
// Flag-dark: the router applies its feature-flag gate BEFORE any route logic
// (routes.ts:68-71), returning a canonical `{"error":"not_found"}` 404 for
// EVERY endpoint under /api/bills-grid when ENABLE_PHASE2_BILLS_GRID is off.
// Every JSON helper below routes through `gridFetch`, which recognizes exactly
// that canonical body and rethrows it as `FlagDarkError` — a route-specific
// 404 (e.g. APARTMENT_NOT_FOUND) carries a different `error` string and is
// left as the underlying ApiError so callers don't mistake "wrong id" for
// "feature is off".
import { apiFetch, ApiError, API_BASE } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";
import {
  saveEntrySchema,
  lineSettingsSchema,
  billSchema,
  bearerConfigSchema,
  createExpensesSchema,
  updateExpenseSchema,
  saveReadingsSchema,
} from "@kason/shared";
import type { GridRecurringDto, AllocationLine, GridSettlementDto, GridBillUtilityPlanDto } from "@kason/shared";
import type { z } from "zod";

/** The React-Query root key for the batched grid read (GET /bills-grid). Prefix
 * invalidation on this key refetches the visible period. Single source of truth
 * shared by the page query and every mutation that must refresh the grid. */
export const GRID_QUERY_KEY_ROOT = ["bills-grid", "grid"] as const;

// The @kason/shared bills-grid module (packages/shared/src/schemas/bills-grid.ts)
// exports its response DTO interfaces plus the request Zod schema VALUES. It
// intentionally ships no `z.infer`/`z.input` request aliases, so the request-body
// shapes below are DERIVED from the schema VALUES via `z.input<typeof ...>` (single-source: a
// schema field change fails the client's typecheck instead of silently
// drifting). `z.input` — not `z.infer` — because these are REQUEST bodies:
// fields with `.optional()` must stay optional and fields with only
// `.nullable()` must stay required-but-nullable, exactly as the wire body the
// server's own zod parse expects, not the post-parse output shape.

/** Mirrors saveEntrySchema — amounts-only; no pattern/bearer or ownerBorne*. */
export type SaveEntryInput = z.input<typeof saveEntrySchema>;

/** Mirrors lineSettingsSchema. */
export type LineSettingsInput = z.input<typeof lineSettingsSchema>;

/** Mirrors billSchema. */
export type BillInput = z.input<typeof billSchema>;

/** Mirrors bearerConfigSchema (= lineSettingsSchema + cleaningRecurringAmount + unlock). */
export type BearerConfigInput = z.input<typeof bearerConfigSchema>;

/** Mirrors createExpensesSchema. `partyId` is deliberately absent — server-derived from `tenancyId`. */
export type CreateExpensesInput = z.input<typeof createExpensesSchema>;

/** Mirrors updateExpenseSchema. `bearer` is deliberately absent (void + recreate instead). */
export type UpdateExpenseInput = z.input<typeof updateExpenseSchema>;

export class FlagDarkError extends Error {
  constructor() {
    super("bills-grid is flag-dark");
    this.name = "FlagDarkError";
  }
}

/**
 * Thin wrapper over apiFetch: converts the canonical flag-dark 404
 * (`{"error":"not_found"}`) into `FlagDarkError` so callers can distinguish
 * "the feature is off" from every other 404/409/500 ApiError, which is
 * rethrown unchanged.
 */
async function gridFetch<T>(path: string, options?: RequestInit): Promise<T> {
  try {
    return await apiFetch<T>(path, options);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && (e.data as { error?: string } | undefined)?.error === "not_found") {
      throw new FlagDarkError();
    }
    throw e;
  }
}

// ── 1. Batched grid read (GET /) ─────────────────────────────────────────────

/** R5: the prior strip's five read-only lines (service.ts PriorMonthStrip). */
export interface PriorMonthStrip {
  period: string;
  cleaning: string | null;
  tnb: string | null;
  air: string | null;
  wifi: string | null;
  others: string;
}

/**
 * One nested tenant/room sub-row (service.ts SubRowDto), keyed on `listingId`
 * (= Listing.id, the room). NOT-NULL, the row's identity — `tenancyId` is
 * `null` for a vacant room and is NEVER the identity.
 */
export interface GridSubRow {
  listingId: string;
  tenancyId: string | null;
  /** Tenant party billed for this room; used only for the admin's tenant-view preview. */
  partyId?: string | null;
  partyName: string | null;
  /** Tenant's primaryPhone (display + search); null for a vacant room. Optional so
   * existing fixtures compile unchanged (server always sends it). */
  partyPhone?: string | null;
  /** Renewal control for the active occupant. Used only to show the 60-day
   * operational reminder and deep-link to the tenancy workflow. */
  tenancyEndDate?: string | null;
  renewalDecision?: "pending" | "contacted" | "renew" | "not_renew" | null;
  previousKwh: string | null;
  currentKwh: string | null;
  amount: string | null;
  /** Task 5/6: the room's per-kwh submeter rate (meter-parity default when
   * unconfigured), used for the client-side live-preview of `amount`. */
  ratePerKwh: string;
  /** Task 5/6: whether the rate came from a real configured meter row vs the
   * ORPHAN_RATE_DEFAULTS fallback. Display-only; not consumed by Task 6 yet. */
  rateConfigured: boolean;
  /** Task 5/6: per-room rental now lives HERE (moved off GridEntryDto). */
  rental: string | null;
  rentalBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  /** Rental + utilities deposit charges belonging to this selected month. */
  deposit?: string | null;
  depositBillingState?: "saved" | "billed-unpaid" | "paid" | null;
  /** Task 6/7: per-row audit trail (optional — server always sends; optional
   * here so existing web fixtures compile unchanged). */
  updatedAt?: string | null;
  lastEditedByName?: string | null;
  /** PAX-per-room: the room's active-tenancy headcount. Optional here (server always
   * sends it) so existing fixtures/`makeSub` literals compile unchanged.
   * invariant: `null` means vacant/whole-unit/unset — NOT a regression; the Setting
   * drawer renders it as a blank, must-set pax input for partition units. */
  numberOfPax?: number | null;
}

/** A NON-fatal, row-level anomaly (service.ts RowWarning). */
export type GridRowWarning =
  | { code: "ZERO_PAX_TENANCY"; tenancyId: string }
  | { code: "NEGATIVE_CONSUMPTION"; listingId: string };

// The frozen money engine's ComputeResult (apps/api/src/modules/meter/compute.ts)
// is server-internal and not published via @kason/shared, so its shape is
// mirrored here field-for-field for typing the read-only `preview`.
// Was a hand-copied restatement of the engine's shape. `maintenanceShare` reached
// grossShareTotal server-side while this copy still lacked the field, so the breakdown
// could omit a component the total included. Aliased to the shared declaration instead.
export type GridAllocationLine = AllocationLine;
export interface GridPreview {
  allocations: GridAllocationLine[];
  totalAircond: number;
  leftoverTnb: number;
  sharedPool: number;
  totalPax: number;
  subsidyCovered: number;
  ownerAttributableAircond: number;
  ownerBorneUtilities: number;
  roundingResidual: number;
  ownerBorneUtilitiesTotal: number;
}

/**
 * Task 10 (spec §1): the raw editable amounts + snapshotted line settings for
 * the current period's entry. WIRE-NAME DISCIPLINE: `tnbTotal`/`airSelangor`
 * echo the server's RAW columns (tnbTotalRaw/airSelangorRaw) under the SAME
 * wire names `saveEntrySchema` accepts on Save — never rename these.
 */
export interface GridEntryDto {
  cleaning: string | null;
  tnbTotal: string | null;
  airSelangor: string | null;
  wifi: string | null;
  maintenanceFee: string | null;
  readingDate: string | null;
  paymentStatus: string;
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  updatedAt: string;
  lockState: "draft" | "locked";
  /** Task 6/7: batched-resolved editor display name (optional — server
   * always sends; optional here so existing web fixtures compile unchanged). */
  lastEditedByName?: string | null;
}

export interface GridBearerConfigDto {
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  cleaningRecurringAmount: string;
  isLocked: boolean;
}

export interface GridExpensesDto {
  tenant: { total: string; withSstTotal: string; sstTotal?: string; count: number; items?: GridExpenseSummaryItemDto[]; nonSstCount?: number; withSstCount?: number; nonSstActionRequiredCount?: number; withSstActionRequiredCount?: number; nonSstGrossMargin?: string; withSstGrossMargin?: string };
  owner: { total: string; withSstTotal: string; sstTotal?: string; count: number; items?: GridExpenseSummaryItemDto[]; nonSstCount?: number; withSstCount?: number; nonSstActionRequiredCount?: number; withSstActionRequiredCount?: number; nonSstGrossMargin?: string; withSstGrossMargin?: string };
}

export interface GridExpenseSummaryItemDto {
  id: string;
  description: string;
  amount: string;
  sst: string;
  total: string;
  withSST: boolean;
}

export interface GridManagementFeeDto {
  nonSst: string;
  sst: string;
  total: string;
  /** False means no active per-unit/owner fee rule resolved for this month.
   * This is distinct from a configured rule whose legitimate result is RM0. */
  configured?: boolean;
  status?:
    | "not_configured"
    | "before_first_charge"
    | "free_period"
    | "commission_month"
    | "no_rental_income"
    | "awaiting_rent"
    | "chargeable"
    | "posted";
  reason?: string | null;
}

export interface GridAgreementFeeLineDto {
  amount: string;
  outstanding: string;
  state: "none" | "saved" | "billed-unpaid" | "paid";
}

export interface GridAgreementFeesDto {
  new: GridAgreementFeeLineDto;
  renewal: GridAgreementFeeLineDto;
}

export interface PendingTenancyChargeDto {
  id: string;
  description: string;
  kind: "rental" | "deposit" | "agreement_fee" | "renewal_fee" | "carpark" | "other";
  /** Optional only for a rolling cached payload; current servers always provide it. */
  payer?: "tenant" | "owner";
  baseAmount: string;
  sst: string;
  total: string;
  /** Legacy wire name; current servers return the actual billed party name. */
  tenantName: string | null;
}

export interface GridAttachmentBrief {
  id: string;
  filename: string;
  cellKey?: string | null;
  columnId?: string | null;
  documentKind?: "invoice" | "receipt" | null;
}

/** Read-time settlement state. The shape lives in @kason/shared so this client and the
 * API DTO share ONE declaration — re-exported here for callers already importing from
 * this module. See settlementByEntry (api bills-grid/service.ts) for how it is derived. */
export type { GridSettlementDto } from "@kason/shared";

export interface GridRow {
  apartmentId: string;
  unitCode: string;
  /** Task 10 (spec §1): the apartment's parent property, for grid grouping/filtering. */
  propertyId: string;
  /** Fix (final review): the property's display name — Categorize shows this, not the raw propertyId UUID. */
  propertyName: string;
  /** The property's business-facing short form (stored as Property.propertyCode).
   * Used with the unit number in the compact Unit identity line. Optional only
   * for compatibility with an older cached payload during a rolling update. */
  propertyCode?: string;
  /** Unit owner's display name (display + search). Optional so existing fixtures compile
   * unchanged (server always sends it, null when no owner party resolved). Owner phone is
   * intentionally NOT surfaced on this page. */
  ownerName?: string | null;
  /** Owner party identity used only for navigation to Owner Details. */
  ownerPartyId?: string | null;
  /** Per-unit Owner Income Report workflow, joined client-side from Owner Statements. */
  ownerPayoutStatus?: "draft" | "first_checked" | "approved";
  ownerStatementId?: string | null;
  entryId: string | null;
  /** null when the apartment-month was never Saved, or when shaping/compute failed. */
  preview: GridPreview | null;
  /** Structured, never an HTTP status. `null` when the preview succeeded. */
  previewError: { code: string; detail?: unknown } | null;
  /** Server-computed first-issuance utility plan. Optional only for an older
   * cached response during a rolling update; absence is not an exact preview. */
  billUtilityPlan?: GridBillUtilityPlanDto;
  /** NON-fatal row-level anomalies. An empty array is the healthy case. */
  warnings: GridRowWarning[];
  /** Nested tenant/room sub-rows, keyed on listingId. */
  subRows: GridSubRow[];
  billedAt: string | null;
  /** Rule 2: TRUE iff this unit-month has a LIVE grid-workflow invoice (provenance-based,
   * survives a legacy sourceGridEntryId=null orphaning) — drives the row's `Billed` tag.
   * The server ALWAYS sends it; optional here only so mock rows in tests may omit it. */
  billed?: boolean;
  /** Re-Bill signal: `0`/absent on the first Bill, `> 0` once the unit-month has been
   * re-Billed. Drives the mutually-exclusive Billed vs Re-Billed tag (a re-Billed row shows
   * Re-Billed only, never both). Optional so mock rows in tests may omit it (→ treated as 0). */
  billRevision?: number;
  /** TRUE iff this billed month has grid data newer than its Bill — an amend that has not
   * been re-Billed, so the live invoice no longer matches the row. ADDITIVE to Billed /
   * Re-Billed, not exclusive with them. Optional so existing fixtures compile unchanged;
   * absent ⇒ false, which degrades an older cached payload to today's behaviour rather
   * than showing a spurious tag. */
  hasUnbilledChanges?: boolean;
  paymentStatus: string;
  /** Server-derived, READ-TIME payment state from this unit-month's live grid charges:
   * `status` drives the row badge, `cells` the per-column greyed+tick affordance.
   * DISPLAY ONLY — `paymentStatus` above (a manual column) still owns the edit lock.
   * Optional so existing test fixtures compile unchanged; absent ⇒ nothing paid. */
  settlement?: GridSettlementDto;
  /** R13: money settled against a proforma line that never got its tax invoice. Drives the
   *  amber "Invoice pending" chip and the retry affordance. The money is correct; only the
   *  document is missing. */
  graduationPending?: boolean;
  /** Latest-first, one per requested prior month; empty when `months = 1`. */
  priorMonths: PriorMonthStrip[];
  /** Task 10: raw editable amounts + snapshotted line settings. `null` when unsaved. */
  entry: GridEntryDto | null;
  // invariant: bearerConfig is ALWAYS present (server sends defaults when no config row) — null would mean a contract regression (§16).
  bearerConfig: GridBearerConfigDto;
  /** Task 10: active-only expense totals. */
  expenses: GridExpensesDto;
  /** Base fee and government SST are deliberately separate. */
  managementFee?: GridManagementFeeDto;
  /** Tenant-facing agreement charges created by the tenancy workflow. */
  agreementFees?: GridAgreementFeesDto;
  /** Exact draft tenancy invoice lines this row's Bill action will approve.
   * Optional only for compatibility with an older cached payload. */
  pendingTenancyCharges?: PendingTenancyChargeDto[];
  /** Authoritative cash-basis owner money. Never negative. */
  ownerPayout?: string;
  ownerTopUpRequired?: string;
  /** Recurring-charges (R9): CUSTOM recurring-line totals (cleaning/WiFi excluded). Optional so
   * older web fixtures compile unchanged; the server always sends it flag-on. */
  recurring?: GridRecurringDto;
  /** Recurring-charges (R6 refined): TRUE iff an ENABLED recurring def governs this month's
   * cleaning / wifi scalar (→ read-only). The server sends explicit true/false flag-on; the grid
   * renders the cleaning/WiFi cell EDITABLE only when the flag is explicitly `false`, so an
   * older fixture that omits it (undefined) defaults to read-only (money-safe). */
  cleaningRecurringLocked?: boolean;
  wifiRecurringLocked?: boolean;
  /** The generated cleaning/wifi amount when governed — shown read-only even for an unopened
   * month whose entry scalar is still null (fixes a governed cell rendering "–" instead of the
   * configured amount). null when ungoverned. */
  cleaningRecurringAmount?: string | null;
  /** Per-kind recurring state — drives which grid cells lock. Projections above are derived from it. */
  scalarRecurring?: Record<ScalarRecurringKind, ScalarRecurringState>;
  wifiRecurringAmount?: string | null;
  /** Task 10: brief attachment refs. */
  attachments: GridAttachmentBrief[];
  /** Task 6: server-derived (Apartment.listingMode === "WHOLE") — the
   * grain-lock authority. Replaces the old `subRows.length > 1 ||
   * entry.rental == null` heuristic now that entry.rental is gone. */
  isWholeUnit: boolean;
}

export interface GridResponse {
  period: string;
  periods: string[];
  rows: GridRow[];
  /** Server-effective Bill flags. Optional only for rolling compatibility. */
  billingCapabilities?: GridBillingCapabilities;
}

export interface GridBillingCapabilities {
  billingDocuments: boolean;
  expensesAsCharges: boolean;
}

export interface BillingFundsSummary {
  tenantDue: string;
  tenantOutstanding: string;
  tenantCollected: string;
  depositsHeld: string;
  ownerExpenses: string;
  managementFee: string;
  managementFeeNonSst: string;
  managementFeeSst: string;
  companyFees: string;
  tenantExpenseCharges: string;
  tenantExpenseDirectCosts: string;
  tenantExpenseGrossMargin: string;
  tenantExpenseCostPendingCount: number;
  tenantExpenseActionRequiredCount: number;
  tenantExpenseActionItems: Array<{
    expenseId: string; apartmentId: string; propertyName: string; unitCode: string;
    description: string; chargeAmount: string; actualCost: string | null;
    costPaymentStatus: string; withSST: boolean;
  }>;
  passThrough: string;
  rental: { due: string; collected: string; outstanding: string };
  deposit: { due: string; collected: string; outstanding: string };
  tenantBreakdown: Array<{ key: string; label: string; due: string; collected: string; outstanding: string }>;
  ownerPayout: string;
  ownerTopUpRequired: string;
  ownerPaid: string;
  status: "safe" | "attention" | "shortfall";
}

export function fetchBillingFundsSummary(period: string): Promise<BillingFundsSummary> {
  const qs = new URLSearchParams({ period: period.length === 7 ? `${period}-01` : period.slice(0, 10) });
  return gridFetch<BillingFundsSummary>(`/bills-grid/funds-summary?${qs.toString()}`);
}

export type BillingSummaryNote = { apartmentId: string; note: string; updatedAt: string };

export async function fetchBillingSummaryNotes(period: string): Promise<BillingSummaryNote[]> {
  const normalized = period.length === 7 ? `${period}-01` : period.slice(0, 10);
  const response = await gridFetch<{ data: { items: BillingSummaryNote[] } }>(`/bills-grid/summary-notes?${new URLSearchParams({ period: normalized })}`);
  return response.data.items;
}

export async function saveBillingSummaryNote(apartmentId: string, period: string, note: string): Promise<BillingSummaryNote> {
  const normalized = period.length === 7 ? `${period}-01` : period.slice(0, 10);
  const response = await gridFetch<{ data: BillingSummaryNote }>(`/bills-grid/apartments/${apartmentId}/summary-note`, {
    method: "PUT",
    body: JSON.stringify({ period: normalized, note }),
  });
  return response.data;
}

export interface FetchGridParams {
  period?: string;
  propertyId?: string;
  months?: number;
}

/** GET / — batched grid read (editor, read-only, always 200 when flag is on). */
export function fetchGrid(params: FetchGridParams = {}): Promise<GridResponse> {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.propertyId) qs.set("propertyId", params.propertyId);
  if (params.months != null) qs.set("months", String(params.months));
  const query = qs.toString();
  return gridFetch<GridResponse>(`/bills-grid${query ? `?${query}` : ""}`);
}

// ── 2. Save draft (PUT /apartments/:apartmentId/entries) — editor ───────────

export interface SaveEntryResult {
  id: string;
  updatedAt: string;
}

/** amounts-only Save; never carries pattern/bearer or ownerBorne* (C3/C5). */
export function saveEntry(apartmentId: string, body: SaveEntryInput): Promise<SaveEntryResult> {
  return gridFetch<SaveEntryResult>(`/bills-grid/apartments/${apartmentId}/entries`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── 2a. Update line settings (PATCH /entries/:id/lines) — MANAGER ───────────

/** Edit an entry's snapshotted line settings (pattern + bearers). 409 ENTRY_LOCKED once billed. */
export function updateLines(entryId: string, body: LineSettingsInput): Promise<SaveEntryResult> {
  return gridFetch<SaveEntryResult>(`/bills-grid/entries/${entryId}/lines`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ── 3. Bill (POST /bill) — MANAGER. 200 manifest even when rows fail ────────

// BillOutcome + PaidBlocker come from @kason/shared — this file used to hand-copy both,
// which is how an API-side outcome could be added without the web's union knowing.
import type { BillOutcome, PaidBlocker, ScalarRecurringKind, SettlementState } from "@kason/shared";
/** Mirrors the API's ScalarRecurringState (service.ts) — governed = the tick, amount = its value. */
export type ScalarRecurringState = { governed: boolean; amount: string | null; definitionId: string | null };
export type { BillOutcome, PaidBlocker };



export interface BillRowResult {
  apartmentId: string;
  outcome: BillOutcome;
  entryId?: string;
  ownerBorneRecorded?: string;
  code?: "AIRCON_EXCEEDS_TNB" | "TNB_UNDERSHOOT" | "ABSORBED_REQUIRES_OWNER_BORNE" | "CATEGORY_UNRESOLVED" | "OWNER_UNRESOLVED" | "EXPENSE_TENANT_UNRESOLVED";
  detail?: { totalAircond: number; tnbTotal: number };
  tenantInvoiceIds?: string[];
  /** ALL owner documents from this Bill. Independently declared from the API's own
   * GroupedGridInvoiceResult, so web typecheck cannot detect a drift — keep in sync
   * by hand. An owner can hold both an IVOWN receivable and an OEA advice per month. */
  ownerInvoiceIds?: string[];
  /** On rebill_confirmation_required — the live invoice numbers to void+reissue (for the modal). */
  /** rebill_confirmation_required, partial re-bill only: the lines this re-Bill will
   *  LEAVE ALONE because they are already paid, and the tax invoice each sits on. */
  keptPaidLines?: { description: string; amount: number; documentNumber: string | null }[];
  existingTenantInvoiceNumber?: string | null;
  existingOwnerInvoiceNumber?: string | null;
  /** On rebill_blocked_payment_exists — the paid/partially-paid invoice(s) blocking the re-Bill. */
  paidBlockers?: PaidBlocker[];
}

/** Bulk Bill is NON-atomic: each row bills in its OWN transaction. There is NO HTTP 422. */
export function billRows(body: BillInput): Promise<{ results: BillRowResult[] }> {
  return gridFetch(`/bills-grid/bill`, { method: "POST", body: JSON.stringify(body) });
}

// ── 4/5. Bearer config (GET/PUT /apartments/:apartmentId/bearer-config) ─────

export interface BearerConfigDto {
  apartmentId: string;
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
  cleaningRecurringAmount: string;
  isLocked: boolean;
  updatedAt: string | null;
  /** charge-nature gate (2026-07-27): the unit's DEFAULT Expense/Profit nature for its
   * cleaning / wifi scalar. `null` = undecided, which makes the Bill fail closed
   * (`nature_unresolved`) rather than silently booking the scalar as manager profit.
   * Optional so older fixtures compile unchanged; the server always sends it. */
  cleaningNature?: string | null;
  wifiNature?: string | null;
  /** True when an ENABLED recurring definition governs that scalar this month — the
   * Recurring-charges editor owns it and the drawer renders its control read-only.
   * Optional/undefined ⇒ treated as ungoverned (editable), matching the pre-gate server. */
  cleaningGoverned?: boolean;
  wifiGoverned?: boolean;
  /** Per-kind recurring state for EVERY scalar kind — the tick + amount the drawer renders.
   *  cleaningGoverned/wifiGoverned above are legacy projections of this same record. Optional so
   *  a response from an older API still parses. */
  scalarRecurring?: Record<ScalarRecurringKind, ScalarRecurringState>;
}

/** GET config — editor may read. Missing config → 200 with the seeded defaults. */
export function getBearerConfig(apartmentId: string): Promise<BearerConfigDto> {
  return gridFetch<BearerConfigDto>(`/bills-grid/apartments/${apartmentId}/bearer-config`);
}

export interface SetBearerConfigResult {
  id: string;
  isLocked: boolean;
  updatedAt: string;
  /** How many already-open (syncable) periods the save pushed the new settings onto.
   * Optional — older servers omit it. */
  syncedEntries?: number;
  /** How many open periods were SKIPPED because they are billed/invoiced/frozen — the
   * drawer surfaces these honestly instead of an unqualified "Saved.". Optional. */
  lockedEntries?: number;
}

/** PUT config — MANAGER (editor 403). Set-once: a locked config needs `unlock:true`. */
export function setBearerConfig(apartmentId: string, body: BearerConfigInput): Promise<SetBearerConfigResult> {
  return gridFetch<SetBearerConfigResult>(`/bills-grid/apartments/${apartmentId}/bearer-config`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── 6. Expenses (POST/GET /expenses, PATCH /expenses/:id, POST …/void) ──────

export interface CreateExpensesResult {
  ids: string[];
  total: string;
}

export function createExpenses(body: CreateExpensesInput): Promise<CreateExpensesResult> {
  return gridFetch<CreateExpensesResult>(`/bills-grid/expenses`, { method: "POST", body: JSON.stringify(body) });
}

export interface ExpenseListItem {
  id: string;
  apartmentId: string;
  periodMonth: string;
  bearer: string;
  description: string;
  amount: string;
  withSST: boolean;
  actualCost?: string | null;
  costVendor?: string | null;
  costPaymentStatus?: "unpaid" | "partial" | "paid";
  costPaymentDate?: string | null;
  costPaymentAccount?: string | null;
  costNotes?: string | null;
  partyId: string | null;
  /** Item 1 (R1/R7): the owner's display name resolved from partyId, org-scoped.
   * Null when partyId is null or unresolvable in-org. Drives the "Expense owner:"
   * grouping headers in the dialog. */
  partyName: string | null;
  status: string;
  updatedAt: string;
  /** T3 (folded Task 5): classify-only ChargeCategory FK, surfaced by the API since Task 4. Null = uncategorized. */
  chargeCategoryId: string | null;
  /** T3 (folded Task 5): denormalized category name + profitExpense for read paths that never fetch the full ChargeCategory list. Null when chargeCategoryId is null. */
  category: { name: string; profitExpense: string | null } | null;
  /** Task B2: the row's own Expense/Profit routing choice (Task B1's GridExpense.nature
   * column). Null = legacy/unset (routes as Expense). Lets the per-row selector in
   * expenses-dialog.tsx seed from server truth instead of always resetting to the default. */
  nature: string | null;
  /** This LINE's own settlement state (GridSettlementDto.expenseLines). Drives the
   *  dialog's per-line edit lock — see expense-lock.ts. OPTIONAL on the wire so an older
   *  cached payload still parses; absent is treated as LOCKED, never editable. */
  settlement?: SettlementState;
}

export interface ListExpensesParams {
  apartmentId?: string;
  billingMonth?: string;
  bearer?: string;
  q?: string;
}

/** Totals sum `status === "active"` ONLY (void lines are shown but never counted). */
export function listExpenses(params: ListExpensesParams = {}): Promise<{ items: ExpenseListItem[]; total: string }> {
  const qs = new URLSearchParams();
  if (params.apartmentId) qs.set("apartmentId", params.apartmentId);
  if (params.billingMonth) qs.set("billingMonth", params.billingMonth);
  if (params.bearer) qs.set("bearer", params.bearer);
  if (params.q) qs.set("q", params.q);
  const query = qs.toString();
  return gridFetch(`/bills-grid/expenses${query ? `?${query}` : ""}`);
}

/** `bearer` is NOT accepted here — filing to the wrong side is void + recreate. */
export function updateExpense(expenseId: string, body: UpdateExpenseInput): Promise<SaveEntryResult> {
  return gridFetch<SaveEntryResult>(`/bills-grid/expenses/${expenseId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** The ONLY retire path for an expense line. 409 NOT_VOIDABLE / ENTRY_LOCKED. */
export function voidExpense(expenseId: string): Promise<{ id: string }> {
  return gridFetch(`/bills-grid/expenses/${expenseId}/void`, { method: "POST" });
}

// ── 7. Meter readings (PUT /apartments/:apartmentId/meter-readings) ─────────

/**
 * REQUIRED per reading — the sibling-key the API upserts on. `tenancyId` is a
 * snapshot; a vacant room writes `tenancyId: null` and the server derives
 * `partyId` itself (a wire `partyId` is discarded).
 *
 * Derived from `saveReadingsSchema.readings`'s element (single-source): the
 * schema marks tenancyId/partyId/previousKwh/currentKwh/amount `.nullable()`
 * WITHOUT `.optional()` — required-present, nullable-valued — so a caller
 * that omits one of these fields now fails the client's own typecheck
 * instead of shipping a body the server 400s at runtime. Only
 * `expectedUpdatedAt` (the schema's one genuinely `.optional()` field) stays
 * `?:`.
 */
export type SaveReadingInput = z.input<typeof saveReadingsSchema>["readings"][number];

export interface SaveReadingResult {
  listingId: string;
  tenancyId: string | null;
  id: string;
  updatedAt: string;
  outcome: "saved" | "stale";
}

/**
 * PUT …/meter-readings — upsert one GridMeterReading per (entry, room). Note:
 * the wire response is `{ results: SaveReadingResult[] }` (service.ts
 * saveReadingsService), not a bare `{ data: GridSubRow[] }` — mirrored from
 * the actual server code per the task brief's own instruction to verify
 * against service.ts rather than an illustrative shape.
 */
export function saveReadings(
  apartmentId: string,
  period: string,
  readings: SaveReadingInput[],
): Promise<{ results: SaveReadingResult[] }> {
  return gridFetch(`/bills-grid/apartments/${apartmentId}/meter-readings`, {
    method: "PUT",
    body: JSON.stringify({ period, readings }),
  });
}

// ── 8. Attachments (upload/list editor; delete MANAGER) ──────────────────────

export interface AttachmentListItem {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  createdAt: string;
  cellKey?: string | null;
  columnId?: string | null;
  documentKind?: "invoice" | "receipt" | null;
}

/**
 * Raw `fetch` + `FormData` — the shared JSON client (apiFetch) cannot send
 * multipart. Built on `${API_BASE}` (same as the sibling raw-fetch uploads in
 * bill-attachments.ts / owner-billing.ts / document-templates.ts) — never a
 * hand-built origin. `credentials: "include"` keeps the cookie the desktop
 * primary; the bearer is attached BY HAND and CONDITIONALLY on top of it: on
 * iOS Safari the cross-site cookie is silently dropped, and interpolating a
 * `null` token would yield the literal `"Bearer null"`, which the API rejects
 * exactly like a missing header and hides the real cause (the known UAT 401
 * trap). `Content-Type` is deliberately NOT set — the browser adds the
 * multipart boundary itself.
 *
 * Return shape mirrors the ACTUAL server response: routes.ts:192-204 builds
 * `data: Array<{ id, storageKey }>` from `uploadAttachmentService`
 * (service.ts:887-919), NOT `{id, filename, createdAt}`.
 *
 * 404 narrowing mirrors `gridFetch`: only the canonical flag-dark body
 * `{"error":"not_found"}` becomes `FlagDarkError`. A route-specific 404 like
 * `APARTMENT_NOT_FOUND` (service.ts:894, surfaced by routes.ts:201) is a real
 * not-found and falls through to a plain `Error` instead.
 */
export async function uploadAttachments(
  apartmentId: string,
  period: string,
  files: File[],
  scope?: { cellKey: string; columnId: string; documentKind: "invoice" | "receipt" },
): Promise<{ data: Array<{ id: string; storageKey: string }> }> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const token = getAdminToken();
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(
    `${API_BASE}/bills-grid/apartments/${apartmentId}/attachments?${new URLSearchParams({ period, ...(scope ?? {}) }).toString()}`,
    { method: "POST", headers, credentials: "include", body: form },
  );
  if (res.status === 404) {
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON body */
    }
    if (body && typeof body === "object" && (body as { error?: string }).error === "not_found") {
      throw new FlagDarkError();
    }
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return (await res.json()) as { data: Array<{ id: string; storageKey: string }> };
}

/** List an apartment-month's attachments. Creates nothing; empty when unsaved. */
export function listAttachments(
  apartmentId: string,
  period: string,
  scope?: { cellKey?: string; columnId?: string; documentKind?: "invoice" | "receipt" },
): Promise<{ items: AttachmentListItem[] }> {
  return gridFetch(`/bills-grid/apartments/${apartmentId}/attachments?${new URLSearchParams({ period, ...(scope ?? {}) }).toString()}`);
}

/**
 * Per-line attachment upload (T1 Task 4). Same raw `fetch` + `FormData`
 * pattern as `uploadAttachments` above (multipart boundary, conditional
 * bearer, `credentials: "include"`, `FlagDarkError` 404-narrowing) but scoped
 * to a single expense LINE instead of an apartment-month: no `period` query
 * string — `expenseId` alone (a path param, routes.ts) carries all scope.
 */
export async function uploadLineAttachments(
  expenseId: string,
  files: File[],
): Promise<{ data: Array<{ id: string; storageKey: string }> }> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const token = getAdminToken();
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(
    `${API_BASE}/bills-grid/expenses/${expenseId}/attachments`,
    { method: "POST", headers, credentials: "include", body: form },
  );
  if (res.status === 404) {
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON body */
    }
    if (body && typeof body === "object" && (body as { error?: string }).error === "not_found") {
      throw new FlagDarkError();
    }
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return (await res.json()) as { data: Array<{ id: string; storageKey: string }> };
}

/** List a single expense line's attachments (T1 Task 4). No query string — `expenseId` is the whole scope. */
export function listLineAttachments(expenseId: string): Promise<{ items: AttachmentListItem[] }> {
  return gridFetch(`/bills-grid/expenses/${expenseId}/attachments`);
}

/** Object deleted FIRST (fail-closed); on a genuine storage fault the row is retained (502). */
export function deleteAttachment(apartmentId: string, attachmentId: string): Promise<{ ok: true }> {
  return gridFetch(`/bills-grid/apartments/${apartmentId}/attachments/${attachmentId}`, { method: "DELETE" });
}

/** A short-lived signed URL for INLINE preview of an attachment (Item 4). Shared for
 * entry-level AND per-line attachments — an attachment id alone is the whole scope
 * (mirrors the DELETE route). `contentType` lets the viewer pick <img> vs <iframe>. */
export interface AttachmentUrlResponse {
  downloadUrl: string;
  filename: string;
  contentType: string;
}
export function getAttachmentUrl(attachmentId: string): Promise<AttachmentUrlResponse> {
  return gridFetch(`/bills-grid/attachments/${attachmentId}/url`);
}
