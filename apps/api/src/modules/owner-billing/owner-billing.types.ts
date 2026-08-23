import type { z } from "zod";
import type {
  generateStatementInput,
  managementFeeConfigPatch,
  statementLineInput,
  statementLinePatch,
} from "@kason/shared";
import type { AdminRole } from "../../lib/rbac";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type OwnerBillingServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface OwnerBillingActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

/**
 * Read DTO for a ManagementFeeConfig row. Prisma.Decimal columns
 * (feeValue, capAmount, sstPercent) are serialised to
 * strings via `.toString()` at the repository/service boundary — never leaked
 * as Decimal. Note: `.toString()` does not pad to 2 dp (10.00 -> "10").
 * Populated in C2/C3; declared here so the module's shape is fixed up front.
 */
export type ManagementFeeConfigRow = {
  id: string;
  ownerPartyId: string;
  propertyId: string | null;
  apartmentId?: string | null;
  feeType: string;
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

/** Paginated list envelope for fee configs (offset pagination). */
export type ManagementFeeConfigListRow = {
  items: ManagementFeeConfigRow[];
  limit: number;
  offset: number;
};

/**
 * Parsed PATCH payload for a fee config — the shared `managementFeeConfigPatch`
 * (every config field optional + a required `expectedUpdatedAt` for optimistic
 * concurrency). The type is inferred from the shared schema so it never drifts.
 */
export type ManagementFeeConfigPatchInput = z.infer<typeof managementFeeConfigPatch>;

// ─── Owner statement (C4) ──────────────────────────────────────────────────

/**
 * Parsed generate-statement body — { ownerPartyId, billingMonth:"YYYY-MM" }.
 * Combined-only: the schema is strict (no apartmentId); generation always yields
 * one owner-combined statement (apartmentId=null) covering all the owner's units.
 */
export type GenerateStatementInput = z.infer<typeof generateStatementInput>;

/**
 * A single owner-statement line (a Charge attached to the statement Invoice).
 * Decimal columns are serialised to strings at the service boundary — never
 * leaked as Prisma.Decimal.
 */
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

/**
 * Read DTO for an owner-statement Invoice + its line Charges. `totalAmount` is
 * the sum of every line's amount plus `sstAmount`; `sstAmount` is the sum of the
 * management-fee SST. Both are 2-dp strings.
 */
export type OwnerStatementRow = {
  id: string;
  invoiceNumber: string;
  invoiceType: string;
  status: string;
  ownerPartyId: string | null;
  partyId: string;
  /**
   * Invoice.apartmentId — null for the owner-combined statement (the only kind
   * generation now produces). The column stays nullable so the assembler's
   * apartment filter (reused by the on-demand Receipt) and any historical/voided
   * per-unit rows still read correctly; mapStatement returns `inv.apartmentId ?? null`.
   * Optional in the type so pre-existing fixtures need no shape-patch.
   */
  apartmentId?: string | null;
  periodMonth: string | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  totalAmount: string;
  sstAmount: string;
  /**
   * Invoice.pdfKey — the storage key of the generated soft-copy PDF, or null when
   * no PDF has been rendered yet. BACKEND↔FRONTEND CONTRACT: the admin
   * Owner-Statements page gates the "Download PDF" + "Send soft copy" affordances
   * on this field (null = disable Download with a "generate the PDF first" callout;
   * send requires approved + pdfKey). Do NOT drop it from mapStatement — the
   * feature silently disappears if this stops being sent. (owner-statements-page.tsx)
   */
  pdfKey: string | null;
  /** Statement-level bulk-receipt keys (Invoice.attachmentKeys); never null. */
  attachmentKeys: string[];
  lines: OwnerStatementLineRow[];
  createdAt: string;
  updatedAt: string;
};

/** Paginated list envelope for owner statements (offset pagination). */
export type OwnerStatementListRow = {
  items: OwnerStatementRow[];
  limit: number;
  offset: number;
};

/**
 * Result of the soft-copy SEND action (C8). The statement transitions to "sent"
 * and the caller is handed a short-lived signed download URL for the already-
 * generated PDF (Invoice.pdfKey, produced in Phase D). Sending NEVER auto-delivers
 * anything — it only flips the status and surfaces the soft copy to download.
 */
export type OwnerStatementSendResult = {
  statement: OwnerStatementRow;
  /** Short-lived signed download URL for the statement PDF (createSignedDownloadUrl). */
  downloadUrl: string;
};

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
  /** Actual cash transfer for the month, including deposits collected for onward transfer. */
  totalPayoutToOwner: string;
  /** Operating balance after expenses, excluding deposit custody transfers. */
  netPayoutToOwner: string;
  checks: OwnerPayoutSafetyCheck[];
};

/**
 * Result of the regenerate-PDF action (D1, requireRole("admin")). The combined
 * owner statement is rendered to a soft-copy PDF, its key persisted on
 * Invoice.pdfKey, and the caller handed a freshly-minted signed download URL.
 */
export type OwnerStatementPdfResult = {
  /** The persisted Invoice.pdfKey ("owner-statements/<ownerPartyId>/<YYYYMM>.pdf"). */
  pdfKey: string;
  /** Short-lived signed download URL for the just-rendered PDF (createSignedDownloadUrl). */
  downloadUrl: string;
};

// ─── Owner statement line add/edit/void (C5) ───────────────────────────────

/** Parsed add-line body — { chargeType, description, amount } (amount a 2dp string). */
export type StatementLineInput = z.infer<typeof statementLineInput>;

/**
 * Parsed line PATCH body — { amount?, description?, expectedUpdatedAt }. The
 * expectedUpdatedAt drives the optimistic-concurrency guard on the child Charge.
 */
export type StatementLinePatchInput = z.infer<typeof statementLinePatch>;

// Cleaning-bill types (CleaningBillInput / CleaningBillPatchInput / CleaningBillRow)
