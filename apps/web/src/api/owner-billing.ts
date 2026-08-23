// Typed react-query hooks for the Owner-Billing module (M6) — admin Settings.
//
// Wires the admin Settings → Owner Billing section to the real endpoints
// (mounted at /api/owner-billing; apiFetch prepends /api, so paths here start
// with /owner-billing). Flag-gated server-side by ENABLE_PHASE2_OWNER_BILLING:
// every route 404s while the flag is dark.
//
// Decimal money/percent values travel as 2-dp-ish decimal STRINGS (the API
// serialises Prisma.Decimal via .toString(), so "10" not "10.00") — the live
// SST preview hands these straight to computeManagementFee from @kason/shared.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FeeType, OwnerChargeType } from "@kason/shared";
import { apiFetch, API_BASE, ApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";
import { triggerBlobDownload } from "@/lib/download-media";
import { OWNER_LEDGER_KEY } from "./owner-ledger";

// ─── Row type ────────────────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/owner-billing/owner-billing.types.ts
// (ManagementFeeConfigRow) — keep in sync.

export type FeeConfigRow = {
  id: string;
  ownerPartyId: string;
  propertyId: string | null;
  apartmentId?: string | null;
  feeType: FeeType;
  feeValue: string;
  capAmount: string | null;
  sstPercent: string;
  freePeriodStart: string | null;
  freePeriodEnd: string | null;
  firstChargeMonth: string | null;
  firstChargeBaseAmount: string | null;
  paxDeductionPerPerson: string | null;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Offset-pagination envelope returned by GET /owner-billing/fee-configs. */
export type FeeConfigListEnvelope = {
  items: FeeConfigRow[];
  limit: number;
  offset: number;
};

export type FeeConfigFilters = {
  ownerPartyId?: string;
  propertyId?: string;
  apartmentId?: string;
  feeType?: FeeType;
  /** "true" | "false" — the API parses these enum strings; "" / undefined = all. */
  isActive?: string;
  limit?: number;
  offset?: number;
};

/** Body for POST /owner-billing/fee-configs (create). Mirrors managementFeeConfigInput. */
export type CreateFeeConfigBody = {
  ownerPartyId: string;
  propertyId?: string | null;
  apartmentId?: string | null;
  feeType: FeeType;
  feeValue: string;
  capAmount?: string | null;
  sstPercent?: string;
  freePeriodStart?: string | null;
  freePeriodEnd?: string | null;
  firstChargeMonth?: string | null;
  firstChargeBaseAmount?: string | null;
  paxDeductionPerPerson?: string | null;
};

/** Body for PATCH /owner-billing/fee-configs/:id. expectedUpdatedAt = optimistic-concurrency token. */
export type UpdateFeeConfigBody = Partial<Omit<CreateFeeConfigBody, "ownerPartyId">> & {
  ownerPartyId?: string;
  expectedUpdatedAt: string;
};

// ─── Query keys ──────────────────────────────────────────────────────────────

export const OWNER_FEE_CONFIGS_KEY = ["owner-fee-configs"] as const;

// Drop undefined/"" entries: keeps {ownerPartyId:""} and {} on one cache entry,
// and the API's enum query params reject "" values. Numbers (limit/offset) are
// stringified for the querystring.
function sanitizeFilters(filters: FeeConfigFilters): Record<string, string> {
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

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useFeeConfigs(
  filters: FeeConfigFilters = {},
  options: { enabled?: boolean } = {},
) {
  const sanitized = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...OWNER_FEE_CONFIGS_KEY, sanitized],
    queryFn: () =>
      apiFetch<{ data: FeeConfigListEnvelope }>(
        `/owner-billing/fee-configs${toQueryString(sanitized)}`,
      ),
    placeholderData: (prev) => prev,
    enabled: options.enabled ?? true,
  });
}

/**
 * All ACTIVE fee configs across the org, paged client-side until a short page is
 * returned (the list endpoint caps limit at 100; KAEN ≈ 137 owners → ≤ 2 pages).
 * Backs the Settings owner-centric readiness overview (R4): owner → has an active
 * config? Manager-gated (same endpoint as useFeeConfigs).
 */
export function useAllActiveFeeConfigs() {
  return useQuery({
    queryKey: [...OWNER_FEE_CONFIGS_KEY, "all-active"],
    queryFn: async () => {
      const all: FeeConfigRow[] = [];
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const res = await apiFetch<{ data: FeeConfigListEnvelope }>(
          `/owner-billing/fee-configs?isActive=true&limit=${limit}&offset=${offset}`,
        );
        all.push(...res.data.items);
        if (res.data.items.length < limit) break;
      }
      return all;
    },
  });
}

// ─── Billing readiness (R3 advisory pre-check) ──────────────────────────────────
// Mirrors apps/api/.../owner-billing-ready.ts BillingReadiness. The tracker "Bill
// this unit" workspace reads this to disable "Post charges" + link to owner setup.
// Advisory only — a failed/absent read must NOT hard-block (the server guard wins).

export type BillingReadiness = {
  ownerAssigned: boolean;
  hasActiveConfig: boolean;
  ownerPartyId: string | null;
};

export function useBillingReadiness(apartmentId: string | null) {
  return useQuery({
    queryKey: ["owner-billing-readiness", apartmentId],
    queryFn: () =>
      apiFetch<{ data: BillingReadiness }>(
        `/owner-billing/units/${apartmentId}/billing-readiness`,
      ),
    enabled: !!apartmentId,
  });
}

export function useCreateFeeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFeeConfigBody) =>
      apiFetch<{ data: FeeConfigRow }>("/owner-billing/fee-configs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_FEE_CONFIGS_KEY }),
  });
}

export function useUpdateFeeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateFeeConfigBody & { id: string }) =>
      apiFetch<{ data: FeeConfigRow }>(`/owner-billing/fee-configs/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_FEE_CONFIGS_KEY }),
  });
}

export function useRetireFeeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: FeeConfigRow }>(`/owner-billing/fee-configs/${id}/retire`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_FEE_CONFIGS_KEY }),
  });
}

export function useRestoreFeeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: FeeConfigRow }>(`/owner-billing/fee-configs/${id}/restore`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_FEE_CONFIGS_KEY }),
  });
}

// ─── Owner statements (F2) ─────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/owner-billing/owner-billing.types.ts
// (OwnerStatementRow / OwnerStatementLineRow). Decimal money values are 2-dp
// strings. Keep in sync with the API DTO.

export type OwnerStatementLineRow = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  unitId: string | null;
  description: string | null;
  amount: string;
  currency: string;
  /** Charge.status — "void" lines are excluded from the statement total. */
  status: string;
  /** Optimistic-concurrency token for the line PATCH (Charge.updatedAt, ISO). */
  updatedAt: string;
};

export type OwnerStatementRow = {
  id: string;
  invoiceNumber: string;
  invoiceType: string;
  /** draft → approved → sent → paid | void */
  status: string;
  ownerPartyId: string | null;
  partyId: string;
  /**
   * Invoice.apartmentId — per-unit scope when statement was generated for one
   * apartment; null for legacy owner-combined statements. Optional in the type
   * (so pre-existing fixtures need no shape-patch) but ALWAYS present on real rows.
   * invariant: present on every owner_statement row from /owner-billing/statements.
   */
  apartmentId?: string | null;
  periodMonth: string | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  totalAmount: string;
  sstAmount: string;
  /**
   * Invoice.pdfKey — storage key of the generated soft-copy PDF, or null when no
   * PDF exists yet. BACKEND↔FRONTEND CONTRACT: the page gates "Download PDF" +
   * "Send soft copy" on this. null = Download disabled with a callout + DEV warn.
   * invariant: present on every owner_statement row from /owner-billing/statements.
   */
  pdfKey: string | null;
  /** Statement-level bulk-receipt keys (Invoice.attachmentKeys); never null. */
  attachmentKeys: string[];
  lines: OwnerStatementLineRow[];
  createdAt: string;
  updatedAt: string;
};

export type StatementListEnvelope = {
  items: OwnerStatementRow[];
  limit: number;
  offset: number;
};

export type StatementFilters = {
  ownerPartyId?: string;
  /** Free-text status: draft | approved | sent | paid | void. */
  status?: string;
  /** YYYY-MM. */
  billingMonth?: string;
  limit?: number;
  offset?: number;
};

// apartmentId is OPTIONAL, mirroring generateStatementInput (@kason/shared): absent ⇒
// the combined "All Units" statement; present ⇒ a per-unit statement scoped to that
// one apartment (Task 9 D1's bill-workspace Generate-statement action always sends it).
export type GenerateStatementBody = { ownerPartyId: string; billingMonth: string; apartmentId?: string };

export type AddStatementLineBody = {
  chargeType: OwnerChargeType;
  description: string;
  amount: string;
  // Optional paid-on-behalf metadata (Task 9) — DISPLAY-ONLY. When KAEN settled this
  // expense (e.g. fire insurance) for the owner, who was paid + the supplier ref + the
  // payment date (YYYY-MM-DD). Never affects the payout math.
  payeeName?: string;
  paidOnBehalfRef?: string;
  paidOnBehalfDate?: string;
};
export type UpdateStatementLineBody = {
  amount?: string;
  description?: string;
  expectedUpdatedAt: string;
};

/** Result of POST /send and the shape getStatementPdfUrl/regenerate hand back. */
export type StatementSendResult = { statement: OwnerStatementRow; downloadUrl: string };
export type StatementPdfResult = { pdfKey: string; downloadUrl: string };
export type OwnerPayoutSafetyCheck = {
  code: string;
  label: string;
  status: "pass" | "warning" | "block";
  detail: string;
  blocks: "first_check" | "approve" | "both" | null;
};
export type OwnerPayoutApprovalPreflight = {
  statementId: string;
  canFirstCheck: boolean;
  canApprove: boolean;
  totalPayoutToOwner: string;
  netPayoutToOwner: string;
  checks: OwnerPayoutSafetyCheck[];
};

export const OWNER_STATEMENTS_KEY = ["owner-statements"] as const;

export function useStatements(filters: StatementFilters = {}) {
  const sanitized = sanitizeFilters(filters as FeeConfigFilters);
  return useQuery({
    queryKey: [...OWNER_STATEMENTS_KEY, sanitized],
    queryFn: () =>
      apiFetch<{ data: StatementListEnvelope }>(
        `/owner-billing/statements${toQueryString(sanitized)}`,
      ),
    placeholderData: (prev) => prev,
  });
}

export function useAllStatementsForMonth(billingMonth: string) {
  return useQuery({
    queryKey: [...OWNER_STATEMENTS_KEY, "month-all", billingMonth],
    enabled: !!billingMonth,
    queryFn: async () => {
      const items: OwnerStatementRow[] = [];
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const qs = new URLSearchParams({ billingMonth, limit: String(limit), offset: String(offset) });
        const res = await apiFetch<{ data: StatementListEnvelope }>(`/owner-billing/statements?${qs}`);
        items.push(...res.data.items);
        if (res.data.items.length < limit) break;
      }
      return items;
    },
  });
}

/** Single statement detail (lines + receipts + pdfKey). Disabled until an id is set. */
export function useStatement(id: string | null) {
  return useQuery({
    queryKey: [...OWNER_STATEMENTS_KEY, "detail", id],
    queryFn: () => apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${id}`),
    enabled: !!id,
  });
}

export function useGenerateStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateStatementBody) =>
      apiFetch<{ data: OwnerStatementRow }>("/owner-billing/statements", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Invalidate EVERY key the per-month statement page reads, not just the admin
    // statements list. The page derives its statementId from useOwnerMonthlySummaries
    // (["owner-monthly-summaries", ownerPartyId]) and renders useStatementSections
    // (["statement-sections", statementId]) + the owner-ledger (OWNER_LEDGER_KEY).
    // Without these, a fresh generate leaves the page showing "No statement
    // generated" until a manual refresh. Prefix form → every ownerPartyId /
    // statementId variant is matched (react-query invalidates by prefix).
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
        qc.invalidateQueries({ queryKey: ["owner-monthly-summaries"] }),
        qc.invalidateQueries({ queryKey: ["statement-sections"] }),
        qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
      ]),
  });
}


export function useAddStatementLine(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddStatementLineBody) =>
      apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${statementId}/lines`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

/**
 * Append an ad-hoc ADJUSTMENT charge to a NON-terminal statement (approved/sent/
 * draft) WITHOUT changing its status — POST /statements/:id/adjust. The backend
 * re-syncs the owner ledger + regenerates the PDF, so invalidate BOTH the statements
 * keys (totals + pdfKey) AND the owner-ledger key (the appended expense books a new
 * ledger row that the workspace/receipt reads). Mirrors useGenerateStatement's
 * cross-key invalidation.
 */
export function useAddAdjustment(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddStatementLineBody) =>
      apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${statementId}/adjust`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
        qc.invalidateQueries({ queryKey: ["owner-monthly-summaries"] }),
        qc.invalidateQueries({ queryKey: ["statement-sections"] }),
        qc.invalidateQueries({ queryKey: OWNER_LEDGER_KEY }),
      ]),
  });
}

export function useUpdateStatementLine(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chargeId, ...body }: UpdateStatementLineBody & { chargeId: string }) =>
      apiFetch<{ data: OwnerStatementRow }>(
        `/owner-billing/statements/${statementId}/lines/${chargeId}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

export function useVoidStatementLine(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chargeId, reason }: { chargeId: string; reason?: string }) =>
      apiFetch<{ data: OwnerStatementRow }>(
        `/owner-billing/statements/${statementId}/lines/${chargeId}/void`,
        {
          method: "POST",
          ...(reason !== undefined ? { body: JSON.stringify({ reason }) } : {}),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

export function useApproveStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${id}/approve`, {
        method: "POST",
      }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
      qc.invalidateQueries({ queryKey: ["owner-monthly-summaries"] }),
      qc.invalidateQueries({ queryKey: ["statement-sections"] }),
    ]),
  });
}

export function useStatementApprovalPreflight(id: string | undefined) {
  return useQuery({
    queryKey: [...OWNER_STATEMENTS_KEY, "approval-preflight", id],
    queryFn: () => apiFetch<{ data: OwnerPayoutApprovalPreflight }>(`/owner-billing/statements/${id}/approval-preflight`),
    enabled: !!id,
  });
}

export function useFirstCheckStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${id}/first-check`, { method: "POST" }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
      qc.invalidateQueries({ queryKey: ["owner-monthly-summaries"] }),
      qc.invalidateQueries({ queryKey: ["statement-sections"] }),
    ]),
  });
}

export function useVoidStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<{ data: OwnerStatementRow }>(`/owner-billing/statements/${id}/void`, {
        method: "POST",
        ...(reason !== undefined ? { body: JSON.stringify({ reason }) } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

export function useSendStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: StatementSendResult }>(`/owner-billing/statements/${id}/send`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

export function useRegenerateStatementPdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: StatementPdfResult }>(`/owner-billing/statements/${id}/regenerate-pdf`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
  });
}

// Owner units (cleaning-bill picker) + the cleaning-bill endpoints were REMOVED here
// (2026-08-17). The bills grid owns cleaning end to end; the owner-settings cleaning
// auto-bill and its manual POST/PATCH/void path were a second, competing issuer. No web
// surface ever called them — useCreateCleaningBill and useOwnerUnits had zero callers.

export function useDetachReceipt(statementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<{ data: OwnerStatementRow }>(
        `/owner-billing/statements/${statementId}/receipts/${encodeURIComponent(key)}/detach`,
        { method: "POST" },
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: OWNER_STATEMENTS_KEY }),
        // Re-sign the remaining receipts so a detached key's stale URL is dropped.
        qc.invalidateQueries({ queryKey: [...STATEMENT_RECEIPT_URLS_KEY, statementId] }),
      ]),
  });
}

/**
 * Fetch a fresh signed download URL for a statement's already-generated PDF.
 * Returns null when the API 404s ("PDF not generated") so callers can fall back.
 */
export async function fetchStatementPdfUrl(id: string): Promise<string | null> {
  try {
    const res = await apiFetch<{ data: { downloadUrl: string } }>(
      `/owner-billing/statements/${id}/pdf`,
    );
    return res.data.downloadUrl;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// ─── Receipt view URLs (signed) ────────────────────────────────────────────────
// Backs the ReceiptUploader thumbnail tiles. Each attached receipt key is signed
// server-side (GET /statements/:id/receipts/urls — admin, signs ONLY that
// statement's Invoice.attachmentKeys) so the admin can preview images inline and
// click through to the full file. Mirrors fetchStatementPdfUrl's auth + signing.

/** One attached receipt key + its short-lived signed view URL. */
export type ReceiptUrl = { key: string; url: string };

export const STATEMENT_RECEIPT_URLS_KEY = ["statement-receipt-urls"] as const;

/**
 * Fetch fresh signed view URLs for every receipt attached to a statement. Returns
 * [] when the API 404s (unknown / cross-org statement) so the caller falls back to
 * filename-only tiles. Mirrors fetchStatementPdfUrl.
 */
export async function fetchReceiptUrls(statementId: string): Promise<ReceiptUrl[]> {
  try {
    const res = await apiFetch<{ data: ReceiptUrl[] }>(
      `/owner-billing/statements/${statementId}/receipts/urls`,
    );
    return res.data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

/**
 * Signed view URLs for a statement's receipts, keyed by statementId. Enabled only
 * when the statement actually has attachment keys — an empty set never hits the
 * network (and the signer would return nothing). The component looks each
 * attachmentKey up in this result to render its thumbnail / click-to-open tile.
 */
export function useReceiptUrls(statementId: string, attachmentKeys: string[]) {
  return useQuery({
    queryKey: [...STATEMENT_RECEIPT_URLS_KEY, statementId],
    queryFn: () => fetchReceiptUrls(statementId),
    enabled: attachmentKeys.length > 0,
  });
}

/**
 * Upload one or more receipt files to a statement (statement-level) or a specific
 * line (line-level when chargeId is set). Hits fetch directly (not apiFetch)
 * because apiFetch forces a JSON content-type — multipart needs the browser to
 * set its own boundary. Mirrors uploadTemplateLogo. Returns the updated statement.
 */
export async function uploadStatementReceipts(
  statementId: string,
  files: File[],
  chargeId?: string,
): Promise<OwnerStatementRow> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  if (chargeId) fd.append("chargeId", chargeId);
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/owner-billing/statements/${statementId}/receipts`, {
    method: "POST",
    body: fd,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Upload failed (${res.status})`, res.status, body?.code);
  }
  const body = (await res.json()) as { data: OwnerStatementRow };
  return body.data;
}

// ─── Per-expense proofs (B2/B3): apartment-scoped bills attached per §5 row ───────
// Backs the per-expense-row attach/view in the admin Expense Breakdown (Section 5).
// The proof store is keyed (org, owner, statementMonth, apartmentId, category)
// server-side (B1) — OFF the continuously-re-synced owner ledger — so a TNB bill
// attached to a row survives ledger re-projection AND stays per-apartment. The GET
// signs each bill INLINE (renders, not downloads). Mutating routes are admin-gated
// (read = manager); every route 404s while ENABLE_PHASE2_OWNER_BILLING is dark.

/** One attached bill + its short-lived signed (inline) view URL. */
export type ExpenseProofItem = {
  id: string;
  filename: string;
  url: string;
  /** Which store the bill came from. Absent (legacy) ⇒ treat as "manual". */
  source?: "manual" | "grid";
  /** Grid bills are managed in the Bill Grid, not detachable from the statement. */
  readOnly?: boolean;
};
/** Bills grouped by RAW category — matches ExpenseBreakdownRow.categoryKey. */
export type ExpenseProofGroup = { category: string; proofs: ExpenseProofItem[] };
/** Append-row DTO POST returns (no signed url — that arrives via the GET list). */
export type ExpenseProofRowDto = {
  id: string;
  category: string;
  filename: string;
  apartmentId: string | null;
  createdAt: string;
};

/** The (owner, month, apartment) coordinate the proof endpoints key off. */
export type ExpenseProofScope = {
  ownerPartyId: string;
  /** "YYYY-MM". */
  statementMonth: string;
  /** null ⇒ legacy combined statement (apartmentId omitted from the request). */
  apartmentId: string | null;
};

export const EXPENSE_PROOFS_KEY = ["owner-expense-proofs"] as const;

function expenseProofsQs(scope: ExpenseProofScope): string {
  const params: Record<string, string> = {
    ownerPartyId: scope.ownerPartyId,
    statementMonth: scope.statementMonth,
  };
  if (scope.apartmentId) params.apartmentId = scope.apartmentId;
  return `?${new URLSearchParams(params).toString()}`;
}

/**
 * Signed bills for an (owner, month, apartment), grouped by RAW category. Disabled
 * until ownerPartyId + statementMonth are known. apartmentId is part of the cache
 * key so each apartment's bills get their own slot (the per-apartment guarantee) —
 * the owner-level (no-apartment) variant is never evicted by a per-unit fetch.
 */
export function useExpenseProofs(
  ownerPartyId: string | undefined,
  statementMonth: string | undefined,
  apartmentId: string | null,
) {
  return useQuery({
    queryKey: [
      ...EXPENSE_PROOFS_KEY,
      ownerPartyId ?? null,
      statementMonth ?? null,
      apartmentId ?? null,
    ],
    queryFn: () =>
      apiFetch<{ data: ExpenseProofGroup[] }>(
        `/owner-billing/expense-proofs${expenseProofsQs({
          ownerPartyId: ownerPartyId!,
          statementMonth: statementMonth!,
          apartmentId,
        })}`,
      ),
    enabled: !!ownerPartyId && !!statementMonth,
  });
}

/**
 * Attach one or more bills to a specific (owner, month, apartment, category) expense.
 * Multipart — hits fetch directly (apiFetch forces a JSON content-type; multipart
 * needs the browser to set its own boundary). Mirrors uploadStatementReceipts.
 */
export async function attachExpenseProof(
  args: ExpenseProofScope & { category: string; files: File[] },
): Promise<ExpenseProofRowDto[]> {
  const fd = new FormData();
  fd.append("ownerPartyId", args.ownerPartyId);
  fd.append("statementMonth", args.statementMonth);
  if (args.apartmentId) fd.append("apartmentId", args.apartmentId);
  fd.append("category", args.category);
  for (const f of args.files) fd.append("files", f);
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/owner-billing/expense-proofs`, {
    method: "POST",
    body: fd,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Upload failed (${res.status})`, res.status, body?.code);
  }
  const body = (await res.json()) as { data: ExpenseProofRowDto[] };
  return body.data;
}

/**
 * Attach bills per expense row. Invalidates the whole proof-groups cache (prefix)
 * so the freshly-uploaded bill's signed thumbnail appears without a manual reload.
 */
export function useAttachExpenseProof() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: ExpenseProofScope & { category: string; files: File[] }) =>
      attachExpenseProof(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXPENSE_PROOFS_KEY }),
  });
}

/** Detach (delete) one bill by id. The server deletes the bucket object too (no orphan). */
export function useDetachExpenseProof() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proofId: string) =>
      apiFetch<{ data: { id: string } }>(`/owner-billing/expense-proofs/${proofId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXPENSE_PROOFS_KEY }),
  });
}

/**
 * Download the merged proof-pack PDF (C1) for an (owner, month, apartment) — the
 * "Download all bills" action behind the admin Bills/Proof panel (C2). Hits fetch
 * directly (binary, not JSON) with the admin bearer token, then triggers a browser
 * download of the streamed PDF via a same-origin blob URL. Throws ApiError on
 * failure (incl. 404 when the scope has no usable bills).
 */
export async function downloadProofPack(scope: ExpenseProofScope): Promise<void> {
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/owner-billing/proof-pack${expenseProofsQs(scope)}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Download failed (${res.status})`, res.status, body?.code);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, `proof-pack-${scope.statementMonth}.pdf`);
}

// ─── Multi-month statement export (D1/D2): streamed ZIP of a month range ─────────
// Backs the admin "Download a range of statements" picker (MultiMonthDownload). The
// range is owner-scoped via ownerPartyId; the server streams a ZIP of every POST-only
// statement in [fromMonth, toMonth] (includeProof=1 also bundles each month's proof
// pack). Hits fetch directly (binary, not JSON) with the admin bearer token, then
// triggers a browser download of the streamed ZIP via a same-origin blob URL.

/** Coordinates for the admin month-range export. Mirrors GET /statements/export. */
export type MonthRangeExportArgs = {
  ownerPartyId: string;
  /** "YYYY-MM" inclusive lower bound. */
  fromMonth: string;
  /** "YYYY-MM" inclusive upper bound. */
  toMonth: string;
  /** Also bundle each month's proof pack (bills). */
  includeProof: boolean;
};

/**
 * Download a ZIP of an owner's POST-only statements across [fromMonth, toMonth] (the
 * admin "Download a range of statements" action). Throws ApiError on failure (incl.
 * 404 for an empty range, 400 for from>to / range>24mo — though the picker pre-checks
 * those client-side). Mirrors downloadProofPack's auth + blob-download pattern.
 */
export async function downloadMonthRangeZip(args: MonthRangeExportArgs): Promise<void> {
  const token = getAdminToken();
  const qs = new URLSearchParams({
    ownerPartyId: args.ownerPartyId,
    fromMonth: args.fromMonth,
    toMonth: args.toMonth,
    includeProof: args.includeProof ? "1" : "0",
  }).toString();
  const res = await fetch(`${API_BASE}/owner-billing/statements/export?${qs}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Download failed (${res.status})`, res.status, body?.code);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, `owner-statements-${args.fromMonth}_to_${args.toMonth}.zip`);
}

export type LiveStatementPdfArgs = {
  ownerPartyId: string;
  billingMonth: string; // YYYY-MM
  apartmentId?: string; // omit for the combined all-units statement
};

/**
 * Download the owner statement as a PDF rendered RIGHT NOW from the posted
 * ledger — no issued statement required and nothing stored server-side.
 *
 * This is admin's working copy, so it shows the figures as they stand: an unpaid
 * tenant reads as unpaid. It is deliberately NOT the owner's copy, which is
 * rendered from the frozen month-end snapshot and is final by construction.
 *
 * Because the server stores nothing, every call re-renders — the bytes can never
 * be a stale artifact left over from an earlier month. Same auth + blob pattern
 * as downloadMonthRangeZip above.
 */
export async function downloadLiveStatementPdf(args: LiveStatementPdfArgs, filename?: string): Promise<void> {
  const token = getAdminToken();
  const qs = new URLSearchParams({
    ownerPartyId: args.ownerPartyId,
    billingMonth: args.billingMonth,
    ...(args.apartmentId ? { apartmentId: args.apartmentId } : {}),
  }).toString();
  const res = await fetch(`${API_BASE}/owner-billing/statements/live-pdf?${qs}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Download failed (${res.status})`, res.status, body?.code);
  }
  const seg = args.apartmentId ? args.apartmentId.slice(0, 8) : "combined";
  triggerBlobDownload(await res.blob(), filename ?? `owner-statement-${args.billingMonth}-${seg}.pdf`);
}
