// Typed react-query hooks for the Owner-Ledger module (M6b) — admin ledger CRUD.
//
// Wires the admin Owner Ledger section to the real endpoints (mounted at
// /api/owner-ledger; apiFetch prepends /api, so paths here start with
// /owner-ledger). Flag-gated server-side by ENABLE_PHASE2_OWNER_BILLING:
// every route 404s while the flag is dark.
//
// Decimal money values travel as 2-dp decimal STRINGS (Prisma.Decimal.toString()).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OwnerLedgerDirection,
  OwnerLedgerCategory,
  OwnerPaidBy,
  OwnerPaymentStatus,
  OwnerTaxCategory,
} from "@kason/shared";
import { apiFetch, API_BASE, ApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";
import { triggerBlobDownload } from "@/lib/download-media";

// ─── Row types ────────────────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/owner-ledger/owner-ledger.service.ts (LedgerEntryRow).
// Extra fields present in the API response: organizationId, sourceType,
// createdById, updatedById — included for completeness.

export type OwnerLedgerEntryRow = {
  id: string;
  organizationId: string;
  ownerPartyId: string;
  propertyId: string;
  apartmentId: string | null;
  unitCode: string | null;
  listingId: string | null;
  tenancyId: string | null;
  /** ISO date string (first of month, UTC). */
  statementMonth: string;
  /** ISO date string. */
  transactionDate: string;
  direction: OwnerLedgerDirection;
  category: OwnerLedgerCategory;
  description: string | null;
  remarks: string | null;
  /** Decimal.toString() — e.g. "1000" or "1000.50". For income rows this is
   * COLLECTED-so-far (0 until the tenant pays); the payout math reads this. */
  amount: string;
  /** BILLED price for display, or null → fall back to `amount`. Income rows'
   * `amount` is collected-so-far; this surfaces the source charge's price so
   * the UI shows the amount owed. null for expenses (their `amount` is billed).
   * Server-side CN/DN-adjusted — never compute an adjusted figure on the client. */
  chargedAmount: string | null;
  /** Σ active DEBIT-note lines against this row's source charge, 2-dp; "0.00" when
   * none. Server-derived, display-only — it exists so the ledger can SHOW that an
   * adjustment moved the numbers instead of silently changing them. */
  debitAdjustmentAmount: string;
  /** Σ active CREDIT-note lines against this row's source charge. See above. */
  creditAdjustmentAmount: string;
  /** Decimal.toString() or null when no SST applies. */
  sstAmount: string | null;
  paidBy: OwnerPaidBy;
  paymentStatus: OwnerPaymentStatus;
  taxCategory: OwnerTaxCategory;
  includeInPayout: boolean;
  attachmentKeys: string[];
  sourceType: string;
  /** Non-null when this row was auto-synced from a posted Charge — void it
   * via the charge (VoidChargeDialog: reverses money + document), NEVER with
   * the shallow ledger-entry void (the backend now 409s that as
   * VOID_AT_SOURCE). Takes precedence over sourceUtilityBillId. */
  sourceChargeId: string | null;
  /** Non-null when this row was auto-synced from a UnitUtilityBill AND
   * sourceChargeId is null — void it at the utility bill itself, not here. */
  sourceUtilityBillId: string | null;
  /** "active" | "void" */
  status: string;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
};

/** Shape returned by GET /owner-ledger/summary. */
export type OwnerLedgerSummary = {
  grossRental: string;
  totalExpenses: string;
  netRentalAfterExpenses: string;
  netPayoutToOwner: string;
  payoutsTotal: string;
  byCategory: Record<string, string>;
  // Balance fields (close-out)
  broughtForward: string;     // carried-forward IN
  periodGross: string;
  periodExpenses: string;
  periodPayouts: string;      // payout recorded
  netThisPeriod: string;      // this-month net, INCL. deposit collected
  depositCollected: string;   // non-income cash-in folded into netThisPeriod
  carriedForward: string;     // carried-forward OUT
};

// ─── Filter + body types ──────────────────────────────────────────────────────

export type OwnerLedgerFilters = {
  ownerPartyId?: string;
  propertyId?: string;
  /** P4 unit-first ledger: narrow to one apartment (additive). */
  apartmentId?: string;
  /** Exact month match — YYYY-MM. */
  month?: string;
  fromMonth?: string;
  toMonth?: string;
  direction?: OwnerLedgerDirection;
  category?: OwnerLedgerCategory;
  paidBy?: OwnerPaidBy;
  paymentStatus?: OwnerPaymentStatus;
  taxCategory?: OwnerTaxCategory;
  /** "true" | "false" — coerced server-side to boolean. */
  hasAttachment?: string;
  limit?: number;
  offset?: number;
};

export type OwnerLedgerRangeFilters = {
  ownerPartyId?: string;
  /** Omit for open lower bound (all-time). */
  fromMonth?: string;
  /** Omit for open upper bound (all-time). */
  toMonth?: string;
  propertyId?: string;
};

/** Body for POST /owner-ledger/entries. Mirrors ownerLedgerEntryInput from @kason/shared. */
export type CreateLedgerEntryBody = {
  ownerPartyId: string;
  propertyId: string;
  apartmentId?: string | null;
  listingId?: string | null;
  tenancyId?: string | null;
  statementMonth: string;
  transactionDate: string;
  direction: OwnerLedgerDirection;
  category: OwnerLedgerCategory;
  description?: string | null;
  remarks?: string | null;
  amount: string;
  sstAmount?: string | null;
  paidBy: OwnerPaidBy;
  paymentStatus?: OwnerPaymentStatus;
  taxCategory?: OwnerTaxCategory;
  attachmentKeys?: string[];
};

/**
 * Body for PATCH /owner-ledger/entries/:id.
 * Mirrors ownerLedgerEntryPatch from @kason/shared — all fields optional,
 * expectedUpdatedAt required (optimistic-concurrency token).
 */
export type PatchLedgerEntryBody = Partial<Omit<CreateLedgerEntryBody, "ownerPartyId">> & {
  ownerPartyId?: string;
  expectedUpdatedAt: string;
};

/** Body for POST /owner-ledger/entries/:id/void. */
export type VoidLedgerEntryBody = { expectedUpdatedAt: string };

/** Body for POST /owner-ledger/sync. Mirrors ownerLedgerSyncInput from @kason/shared. */
export type SyncMonthBody = { ownerPartyId: string; month: string };

// ─── Query keys ───────────────────────────────────────────────────────────────

export const OWNER_LEDGER_KEY = ["owner-ledger"] as const;

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Drop undefined / null / "" entries, stringify numbers. Mirrors sanitizeFilters
// in owner-billing.ts.
function sanitizeFilters(
  filters: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return out;
}

function toQueryString(sanitized: Record<string, string>): string {
  const entries = Object.entries(sanitized);
  return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
}

// ─── Hooks — entries ──────────────────────────────────────────────────────────

/** List ledger entries with optional filters + pagination. */
export function useOwnerLedgerEntries(
  filters: OwnerLedgerFilters = {},
  options: { enabled?: boolean } = {},
) {
  const sanitized = sanitizeFilters(filters as Parameters<typeof sanitizeFilters>[0]);
  const enabled = options.enabled !== undefined ? options.enabled : true;
  return useQuery({
    queryKey: [...OWNER_LEDGER_KEY, "entries", sanitized],
    queryFn: () =>
      apiFetch<{ data: { rows: OwnerLedgerEntryRow[]; total: number } }>(
        `/owner-ledger/entries${toQueryString(sanitized)}`,
      ),
    placeholderData: (prev) => prev,
    enabled,
  });
}

/** Create a new ledger entry (admin role required). Returns 201 on success. */
export function useCreateLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLedgerEntryBody) =>
      apiFetch<{ data: OwnerLedgerEntryRow }>("/owner-ledger/entries", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
  });
}

/** Patch a ledger entry (optimistic concurrency via expectedUpdatedAt). 409 on stale. */
export function usePatchLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: PatchLedgerEntryBody & { id: string }) =>
      apiFetch<{ data: OwnerLedgerEntryRow }>(`/owner-ledger/entries/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
  });
}

/** Void a ledger entry (admin role required). Returns 409 on stale token. */
export function useVoidLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt }: VoidLedgerEntryBody & { id: string }) =>
      apiFetch<{ data: OwnerLedgerEntryRow }>(`/owner-ledger/entries/${id}/void`, {
        method: "POST",
        body: JSON.stringify({ expectedUpdatedAt }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
  });
}

// ─── Hook — sync ──────────────────────────────────────────────────────────────

/** Trigger a month sync for an owner (admin role required). */
export function useSyncMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SyncMonthBody) =>
      apiFetch<{ data: { created: number; updated: number; skipped: number } }>(
        "/owner-ledger/sync",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
  });
}

// ─── Hooks — summaries ────────────────────────────────────────────────────────

/** Period summary (gross rental, expenses, payout) over a month range. Omit fromMonth/toMonth for all-time. */
export function useOwnerLedgerSummary(range: OwnerLedgerRangeFilters) {
  const sanitized = sanitizeFilters(range as Parameters<typeof sanitizeFilters>[0]);
  return useQuery({
    queryKey: [...OWNER_LEDGER_KEY, "summary", sanitized],
    queryFn: () =>
      apiFetch<{ data: OwnerLedgerSummary }>(
        `/owner-ledger/summary${toQueryString(sanitized)}`,
      ),
    // Gate only on ownerPartyId when present; dates are optional (all-time when omitted).
    enabled: range.ownerPartyId !== undefined ? !!range.ownerPartyId : true,
  });
}

// ─── Yannie statement types (2c-1) ───────────────────────────────────────────
//
// CONTRACT: mirrors apps/api/src/modules/owner-billing/owner-statement-sections.ts
// YannieSections — keep in sync.
// These types are NOT exported from @kason/shared; defined web-side and imported
// by 2c-2/2c-3/2c-4 from this file.

// "Admin Fee (First Month Rental)" labels an INFORMATIONAL row (see
// isInformational below), never
// real income. Mirrors apps/api/src/modules/owner-billing/owner-statement-sections.ts;
// both copies must agree.
export type IncomeType =
  | "Monthly"
  | "Prorate"
  | "Aircond Fee"
  | "Carpark"
  | "Shared Utility"
  | "Admin Fee (First Month Rental)"
  // DERIVED memo, never a ledger row — the partition aircond spread (Σ per-room
  // submeter above the master TNB bill). Also isInformational:true, so it renders muted
  // and is outside every total. But unlike "Admin Fee (First Month Rental)" the money
  // HAS already
  // reached the payout, via Aircond Fee minus the master TNB expense — so its footnote
  // must read "already included", never "retained by KAEN".
  | "Extra Electricity"
  // DERIVED memo, never a ledger row — tenant-borne bills-grid expense charges
  // (GRIDEXP- fees the tenant pays KAEN). Also isInformational:true, outside every
  // total; the default "Retained by KAEN — not part of payout" footnote applies.
  | "Tenant-paid Expense";

export type StatementHeader = {
  reportMonth: string;              // "June 2026"
  propertyName: string;
  ownerName: string;
  bankName: string | null;
  accountHolder: string | null;
  accountNumberMasked: string | null; // FULL account number, unmasked (backend no longer masks it)
};

export type OccupancyRow = {
  unitCode: string;
  tenantName: string | null;        // null = vacant
  tenancyStart: string | null;      // ISO date or null
  tenancyEnd: string | null;
  monthlyRental: string;            // 2dp string
  depositMonths: number | null;
  depositAmount: string;            // 2dp string
  isVacant: boolean;
};

export type PayoutSummaryLine = {
  label: string;
  amount: string;                   // 2dp string; negative for expenses
  isNonIncome?: boolean;            // deposit-collected: not part of rental income
  isTotal?: boolean;
};

export type IncomeBreakdownRow = {
  unitCode: string;
  tenantName: string | null;
  incomeType: IncomeType;
  billingPeriod: string;            // "June 2026"
  amount: string;                   // 2dp string — COLLECTED (drives payout math)
  chargedAmount?: string;           // 2dp string — BILLED (Charge.amount); display-only; falls back to amount when absent
  mgmtFee: string;                  // 2dp string; "0.00" for aircond_income
  mgmtFeeSst: string;               // 2dp string; "0.00" for aircond_income
  paymentStatus: string;            // "pending" | "partial" | "paid" | "cancelled"
  // WHICH component the line is — "Electricity (TNB)", "Water (Air Selangor)",
  // "WiFi", "Cleaning", "Aircond". incomeType is a coarse bucket several rows share;
  // this is what distinguishes them. Optional for fixtures predating the field.
  detail?: string | null;
  // Tenant utility money KAEN collects and forwards to the supplier. Listed so the
  // owner sees what their tenant was charged, but NOT part of totalIncome and NOT
  // part of the payout. Optional so pre-existing fixtures still typecheck; absent
  // reads as false, i.e. ordinary owner income.
  isPassThrough?: boolean;
  // An EXPLANATORY row, not money — today the first month's rent KAEN retained as
  // letting commission. Excluded from totalIncome and from the payout, and carries no
  // management fee. Render it as a memo, never as earnings. Optional so pre-existing
  // fixtures still typecheck; absent reads as false.
  isInformational?: boolean;
};

export type ExpenseBreakdownRow = {
  category: string;                 // human label e.g. "Electricity (TNB)"
  categoryKey: string;              // RAW OwnerLedgerEntry.category e.g. "utilities_tnb" — per-row proof attach posts category=<categoryKey>
  description: string | null;
  amount: string;                   // 2dp string
  sstAmount: string;                // "0.00" or SST on mgmt fee
  paymentStatus: string;
  /**
   * "Debit note +RM 80.00 · Credit note -RM 30.00[ · SST -RM 4.00]" — the active
   * credit/debit notes that moved `amount`/`sstAmount` away from what was minted.
   * null/absent when no note touched the row. §5 always showed the ADJUSTED figure,
   * so without this an owner watched a RM 1.00 expense become RM 0.50 with nothing
   * naming the note. Mirrors the API's ExpenseBreakdownRow — keep in sync.
   */
  adjustmentNote?: string | null;
};

export type YannieSections = {
  header: StatementHeader;
  // Invoice.apartmentId — the apartment this per-unit statement was generated for,
  // or null for a legacy combined statement. Threaded to the per-expense proof attach.
  apartmentId: string | null;
  occupancy: {
    rows: OccupancyRow[];
    occupiedCount: number;
    vacantCount: number;
    totalMonthlyRental: string;
  };
  payoutSummary: {
    lines: PayoutSummaryLine[];
    netPayoutToOwner: string;
    depositCollected: string;
  };
  incomeBreakdown: {
    rows: IncomeBreakdownRow[];
    totalIncome: string;
    // Σ of the isPassThrough rows — tenant utilities collected and forwarded to
    // suppliers. Shown as a memo beneath the total, deliberately excluded from it.
    // Optional for compatibility with fixtures predating the field.
    passThroughIncome?: string;
    totalMgmtFee: string;
  };
  expenseBreakdown: {
    rows: ExpenseBreakdownRow[];
    totalExpenses: string;
  };
};

// ─── Monthly statement summary (2c-1) ────────────────────────────────────────
//
// CONTRACT: mirrors apps/api/src/modules/owner-ledger/owner-ledger.service.ts
// MonthlyStatementSummary — keep in sync.

export type MonthlyStatementSummary = {
  month: string;               // "YYYY-MM"
  grossRental: string;         // 2dp
  totalExpenses: string;       // 2dp
  netPayoutToOwner: string;    // 2dp (may be negative)
  depositCollected: string;    // 2dp — real deposit collected in-month; matches the statement
  statementId: string | null;  // null = no statement generated yet
  statementStatus: string | null; // "draft" | "approved" | "sent" | "paid" | "void" | null
  hasData: boolean;            // true when ≥1 OwnerLedgerEntry exists
};

// ─── Hooks — monthly summaries + statement sections (2c-1) ───────────────────

/**
 * List monthly statement summaries for an owner (admin). Disabled until
 * ownerPartyId is provided. When apartmentId is supplied the response is
 * scoped to that single apartment's ledger entries (Task 7 backend).
 * apartmentId is included in the query key so each apartment gets its own
 * cache slot without evicting the owner-level (no apartmentId) variant.
 */
export function useOwnerMonthlySummaries(
  ownerPartyId: string | undefined,
  apartmentId?: string,
) {
  const qs = apartmentId ? `?apartmentId=${encodeURIComponent(apartmentId)}` : "";
  return useQuery({
    queryKey: ["owner-monthly-summaries", ownerPartyId, apartmentId ?? null],
    queryFn: () =>
      apiFetch<{ data: { items: MonthlyStatementSummary[] } }>(
        `/owner-ledger/owners/${ownerPartyId}/months${qs}`,
      ),
    enabled: !!ownerPartyId,
  });
}

/**
 * Fetch the 5-section Yannie statement for a statement (invoice) id (admin).
 * Disabled until statementId is provided.
 */
export function useStatementSections(statementId: string | undefined) {
  return useQuery({
    queryKey: ["statement-sections", statementId],
    queryFn: () =>
      apiFetch<{ data: YannieSections }>(
        `/owner-billing/statements/${statementId}/sections`,
      ),
    enabled: !!statementId,
  });
}

/**
 * Fetch the 5-section Yannie statement LIVE from the posted ledger for an
 * (owner, month[, apartment]) — WITHOUT a statement Invoice. Same YannieSections
 * shape as useStatementSections; the admin live-view uses it to render the full
 * 5-section detail BEFORE a statement is issued (issuing now only produces the
 * formal PDF). Disabled until both ownerPartyId and billingMonth are provided.
 * Server-gated by ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (404 while dark), so
 * callers should also gate `enabled` on the web flag mirror to stay flag-dark.
 */
export function useLiveStatementSections(
  ownerPartyId: string | undefined,
  billingMonth: string | undefined,
  apartmentId?: string,
) {
  const params = new URLSearchParams();
  if (ownerPartyId) params.set("ownerPartyId", ownerPartyId);
  if (billingMonth) params.set("billingMonth", billingMonth);
  if (apartmentId) params.set("apartmentId", apartmentId);
  return useQuery({
    queryKey: [
      "live-statement-sections",
      ownerPartyId ?? null,
      billingMonth ?? null,
      apartmentId ?? null,
    ],
    queryFn: () =>
      apiFetch<{ data: YannieSections }>(
        `/owner-billing/statements/live?${params.toString()}`,
      ),
    enabled: !!ownerPartyId && !!billingMonth,
  });
}

// ─── Owner-tree ───────────────────────────────────────────────────────────────

export type OwnerTreeRoom = {
  listingId: string;
  listingType: string;
  occupancyStatus: string;
  tenancy: { tenancyId: string; tenantDisplayName: string } | null;
};

export type OwnerTreeUnit = {
  apartmentId: string;
  unitCode: string;
  listingMode: "WHOLE" | "PARTITIONED";
  rooms: OwnerTreeRoom[];
};

export type OwnerTreeProperty = {
  id: string;
  name: string;
  units: OwnerTreeUnit[];
};

export type OwnerTree = {
  properties: OwnerTreeProperty[];
};

/** Resolve the owner's property+unit tree for the cascade picker. Disabled until ownerPartyId is provided. */
export function useOwnerTree(ownerPartyId: string | null) {
  return useQuery({
    queryKey: ["owner-tree", ownerPartyId],
    queryFn: () =>
      apiFetch<{ data: OwnerTree }>(
        `/owner-ledger/owner-tree?ownerPartyId=${ownerPartyId}`,
      ),
    enabled: !!ownerPartyId,
  });
}

// ─── Owners summary ───────────────────────────────────────────────────────────

/** Shape returned by GET /owner-ledger/owners-summary. */
export type OwnersSummary = {
  owners: Array<{
    ownerPartyId: string;
    ownerName: string;
    unitCount: number;
    /** Distinct unit codes from active LandlordTenancies for this owner. */
    unitCodes: string[];
    grossRental: string;
    totalExpenses: string;
    netPayoutToOwner: string;
    pendingCount: number;
    lastEntryMonth: string | null;
    /** Per-apartment breakdown added by Task 7. */
    units: Array<{
      apartmentId: string;
      unitCode: string;
      grossRental: string;
      totalExpenses: string;
      netPayoutToOwner: string;
    }>;
  }>;
};

/**
 * Aggregate owner-list landing data. Omit fromMonth/toMonth for all-time.
 * queryKey: ["owners-summary", fromMonth, toMonth].
 * Always enabled (no date range required).
 */
export function useOwnersSummary(fromMonth?: string, toMonth?: string) {
  const params = new URLSearchParams();
  if (fromMonth) params.set("fromMonth", fromMonth);
  if (toMonth) params.set("toMonth", toMonth);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return useQuery({
    queryKey: ["owners-summary", fromMonth ?? null, toMonth ?? null],
    queryFn: () =>
      apiFetch<{ data: OwnersSummary }>(`/owner-ledger/owners-summary${qs}`),
    enabled: true,
  });
}

// ─── Units summary (Task 5) ──────────────────────────────────────────────────
//
// Per-unit + combined payout breakdown for a (owner, month) pair.
// CONVERGENCE: combined.netPayout === useOwnerMonthlySummaries()[month].netPayoutToOwner.

/** Wire-safe payout shape — all money values are 2dp decimal strings. */
export type UnitPayout = {
  incomeCollected: string;
  depositCollected: string;
  deductibleExpenses: string;
  netPayout: string;
};

export type UnitPayoutRow = UnitPayout & {
  /** null for the property-level residual ("Unassigned") bucket. */
  apartmentId: string | null;
  unitCode: string;
};

export type UnitsSummaryData = {
  month: string;
  /** null when no ledger rows exist for this month. */
  combined: UnitPayout | null;
  units: UnitPayoutRow[];
};

/**
 * Per-unit + combined payout breakdown for a given owner + month (admin).
 * Disabled until both ownerPartyId and month are provided.
 * queryKey: ["owner-units-summary", ownerPartyId, month].
 */
export function useUnitsSummary(
  ownerPartyId: string | undefined,
  month: string | undefined,
) {
  return useQuery({
    queryKey: ["owner-units-summary", ownerPartyId ?? null, month ?? null],
    queryFn: () =>
      apiFetch<{ data: UnitsSummaryData }>(
        `/owner-ledger/owners/${ownerPartyId}/units-summary?month=${encodeURIComponent(month!)}`,
      ),
    enabled: !!ownerPartyId && !!month,
  });
}

// ─── Org-wide units summary + apartment context (P4 unit-first ledger) ───────
//
// CONTRACT: mirrors apps/api/src/modules/owner-ledger/owner-ledger.service.ts
// OrgUnitSummaryRow / ApartmentContext — keep in sync.

export type OrgUnitSummaryRow = {
  /** null only for the per-property "Unassigned / property-level" residual row. */
  apartmentId: string | null;
  unitCode: string | null;
  propertyId: string;
  propertyName: string;
  ownerPartyId: string | null;
  ownerName: string | null;
  occupancy: { activeTenancies: number };
  /** 2dp strings — income / deductible expenses / computeOwnerPayout net. */
  figures: { income: string; expenses: string; netPayout: string };
  statement: { id: string; status: string } | null;
  openDocuments: number;
};

/**
 * Org-wide paginated unit-month summary — the Units tab front door (manager+).
 * `month` is a first-of-month date string ("YYYY-MM-01") per the P4 contract.
 * Disabled until a month is provided.
 */
export function useOrgUnitsSummary(params: {
  month: string;
  q?: string;
  propertyId?: string;
  page?: number;
  pageSize?: number;
}) {
  const sanitized = sanitizeFilters(params as Parameters<typeof sanitizeFilters>[0]);
  return useQuery({
    queryKey: [...OWNER_LEDGER_KEY, "org-units-summary", sanitized],
    queryFn: () =>
      apiFetch<{ data: { items: OrgUnitSummaryRow[]; total: number } }>(
        `/owner-ledger/units-summary${toQueryString(sanitized)}`,
      ),
    placeholderData: (prev) => prev,
    enabled: !!params.month,
  });
}

export type ApartmentContext = {
  apartmentId: string;
  unitCode: string;
  listingMode: string;
  propertyId: string;
  propertyName: string;
  ownerPartyId: string | null;
  ownerName: string | null;
  activeTenancies: Array<{
    tenancyId: string;
    listingId: string;
    listingType: string;
    tenantPartyId: string;
    tenantDisplayName: string;
  }>;
};

/**
 * Unit-workspace header + inverted unit-first cascade resolve (P4).
 * Disabled until an apartmentId is provided.
 */
export function useApartmentContext(apartmentId: string | undefined) {
  return useQuery({
    queryKey: [...OWNER_LEDGER_KEY, "apartment-context", apartmentId ?? null],
    queryFn: () =>
      apiFetch<{ data: ApartmentContext }>(`/owner-ledger/units/${apartmentId}/context`),
    enabled: !!apartmentId,
  });
}

// ─── Receipt download (Task 7) ────────────────────────────────────────────────

/**
 * Download an on-demand itemized receipt PDF for an (owner, month[, apartment])
 * scope — the "Print Invoice" action on the admin Owner Workspace.
 *
 * Mirrors downloadProofPack in owner-billing.ts:
 *   - Uses the admin bearer token directly (binary fetch, not apiFetch/JSON).
 *   - Triggers a same-origin blob download via triggerBlobDownload (avoids
 *     popup blockers and works behind a JWT-gated API).
 *   - On 404 the API returns JSON { error: "No ledger entries" }; we surface a
 *     friendly message so the caller can toast it.
 *
 * Admin/manager only — NOT a portal function.
 */
export async function downloadLedgerReceipt(
  ownerPartyId: string,
  month: string,
  apartmentId?: string,
): Promise<void> {
  const params = new URLSearchParams({ ownerPartyId, month });
  if (apartmentId) params.set("apartmentId", apartmentId);
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/owner-ledger/receipt?${params.toString()}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      res.status === 404
        ? "No ledger entries for this scope."
        : body?.error ?? `Download failed (${res.status})`;
    throw new ApiError(msg, res.status, body?.code);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, `invoice-${month}.pdf`);
}
