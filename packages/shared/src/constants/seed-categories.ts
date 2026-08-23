// packages/shared/src/constants/seed-categories.ts
// Default DocumentSeries + ChargeCategory seeds (spec §4.1, from Yannie's
// document-series photo + existing auto-post flows). Retired series
// IVBTA/IVADF/IVPAF are deliberately NOT seeded (decision B5).
//
// ledgerCategory values were VERIFIED against OWNER_LEDGER_CATEGORIES
// (packages/shared/src/schemas/owner-ledger.ts:13-24) — the enum on disk is
// truth: "utilities_tnb" / "water" / "wifi" / "indah_water" (NOT utility_*).
// Validated by src/__tests__/seed-categories.test.ts.

import type { OwnerLedgerCategory } from "../schemas/owner-ledger";
import type { CategoryDocType, CategoryFamily } from "../schemas/charge-categories";

// TA amounts are entered as the final SST-inclusive amount. Creation splits that
// gross value into a base Charge plus its linked SST Charge; the base/document
// line therefore carries the real statutory rate without increasing the total.
export const TENANCY_AGREEMENT_SST_RATE = "8";

// Cleaning is entered in the grid as the pre-SST service amount: RM100 becomes
// RM100 + RM8 SST on the invoice. This differs from WiFi, whose grid value is the
// supplier's already-gross pass-through amount and therefore remains zero-rated here.
export const CLEANING_SST_RATE = "8";

export type SeedDocumentSeries = { code: "IVTEN" | "IVOWN" | "RB" | "DEP" | "DEPO" | "CN" | "DN" | "RN" | "RCPT" | "EXP" | "EB" | "OST" | "REM" | "OEA" | "PI"; prefix: string };

export const SEED_DOCUMENT_SERIES: readonly SeedDocumentSeries[] = [
  { code: "IVTEN", prefix: "IVTEN" },
  { code: "IVOWN", prefix: "IVOWN" },
  { code: "RB", prefix: "RB" }, // Spec 1: monthly rent / owner collections (PAYABLE_TO_OWNER)
  { code: "DEP", prefix: "DEP" },
  { code: "CN", prefix: "CN" },
  { code: "DN", prefix: "DN" }, // debit notes (charge-adjustment / debit-note issuance); previously referenced by code but unseeded → SERIES_NOT_FOUND in seed-only orgs
  { code: "RN", prefix: "RN" },
  { code: "RCPT", prefix: "RCPT" }, // P2 R7: receipts mint RCPT-0001 (lazy per-org create in ensureChargeCategorySeeds)
  { code: "EXP", prefix: "EXP" }, // redesign P3: internal supplier Expense doc (EXP-0001)
  // redesign P4: tenant-borne bills-grid expense RECOVERY (ENABLE_EXPENSE_BILL) — its own
  // "Expense Bill" series, kept OUT of IVTEN (KAEN service revenue). No ChargeCategory routes
  // here directly: issue-grouped.ts's grouped issuer passes seriesCode:"EB" explicitly when
  // issuing a routed group (an EXPLICIT override of the line category's own IVTEN series —
  // the SAME issueDocumentTx mechanism CN/RN/IVOWN-statement-mint already use), so the
  // tenant_income category family → IVTEN invariant (seed-categories.test.ts) stays intact.
  // Lazy per-org create in ensureChargeCategorySeeds, same as RCPT/EXP above.
  { code: "EB", prefix: "EB" },
  // redesign P1 (2026-07-23): human-facing sequential DISPLAY numbers for Owner
  // Statements (OST-) and Owner Remittances (REM-) — additive, minted alongside
  // (never replacing) each document's existing identity/dedupe key (Invoice.
  // invoiceNumber's "OS-<mm>-<owner8>" slug; OwnerLedgerEntry's idempotencyKey).
  // No ChargeCategory routes to either — same explicit seriesCode-override mint
  // shape as EXP/EB above (owner-billing.service.ts's approveStatementService /
  // owner-remittance.service.ts's recordRemittanceService pass the code
  // directly). Lazy per-org create in ensureChargeCategorySeeds.
  { code: "OST", prefix: "OST" },
  { code: "REM", prefix: "REM" },
  // Owner Expense Advice: the NON-RECEIVABLE document for owner-borne bills-grid
  // expenses — money KAEN paid on the owner's behalf and deducted from their payout,
  // never billed to them.
  //
  // ⚠️ NO LIVE MINT PATH since 2026-08-16. resolveRoutedSeries can no longer return
  // "OEA" (an owner-borne expense is billed on IVOWN and netted out of the payout at
  // collection instead), so `issue-grouped.ts` never passes this seriesCode. The series
  // is still seeded per-org deliberately: historical OEA documents must keep resolving
  // their series to render, and `oea-backfill.ts` still mints into it by hand. Removing
  // it would break both. No ChargeCategory routes here.
  { code: "OEA", prefix: "OEA" },
  // Move-in DEPOSITS (rental + utilities), carved OUT of the shared DEP pool for the
  // same reason EB was carved out of IVTEN: customer identity. DEP also carries aircond
  // and the four utility debit notes (issue.service.ts's CHARGE_TYPE_TO_CATEGORY_CODE
  // maps chargeType "utility"→utility_tnb and "aircond"→aircond), and both label maps
  // key on the SERIES prefix — so titling DEP "RENTAL DEPOSITS" would retitle every
  // utility and aircond debit note in the system. A deposit needs its own series to
  // carry its own name. docType stays debit_note and the economics are unchanged
  // (PAYABLE_TO_OWNER, never manager revenue); only the numbering and title differ.
  { code: "DEPO", prefix: "DEPO" },
  // PROFORMA invoices (spec 2026-08-10, R1). The bills grid mints its tenant-family
  // group here instead of IVTEN when ENABLE_PROFORMA_INVOICES is on. Same explicit
  // seriesCode-override shape as EB/EXP/OST/REM above — issue-grouped.ts passes "PI"
  // directly, so no ChargeCategory routes here and the tenant_income → IVTEN category
  // invariant (seed-categories.test.ts) is untouched.
  //
  // Seeded UNCONDITIONALLY, not behind the flag: issueDocumentTx resolves a series by
  // code and throws SERIES_NOT_FOUND when the row is absent, which would roll back the
  // whole grid transaction as `save_failed` the first time anyone flips the flag on. The
  // lazy per-org create in ensureChargeCategorySeeds means orgs created BEFORE this
  // change also get the row on their next seed run, so there is no backfill migration.
  { code: "PI", prefix: "PI" },
] as const;

export type SeedChargeCategory = {
  code: string;
  name: string;
  family: CategoryFamily;
  docType: CategoryDocType;
  seriesCode: SeedDocumentSeries["code"];
  defaultSstRate?: string;
  eInvoiceEligible?: boolean;
  ledgerCategory?: OwnerLedgerCategory;
  isSystem?: boolean;
  active?: boolean;
  sortOrder: number;
};

export const SEED_CHARGE_CATEGORIES: readonly SeedChargeCategory[] = [
  // ── tenant_income → Invoice / IVTEN ─────────────────────────────────────────
  { code: "booking_fee", name: "Booking fee", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", sortOrder: 10 },
  { code: "tenancy_agreement_fee", name: "Tenancy agreement fee", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: TENANCY_AGREEMENT_SST_RATE, sortOrder: 20 },
  { code: "renewal_fee", name: "Renewal fee", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: TENANCY_AGREEMENT_SST_RATE, sortOrder: 30 },
  { code: "access_card_replacement", name: "Access card replacement", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", sortOrder: 40 },
  { code: "late_payment_interest", name: "Late payment interest (10%)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", sortOrder: 50 },
  { code: "cleaning_tenant", name: "Cleaning (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: CLEANING_SST_RATE, sortOrder: 60 },
  // Maintenance (2026-07-28) — a bills-grid scalar like cleaning/wifi. REQUIRED by
  // resolveGridInvoiceCategories — a missing row makes it
  // return null and every grid Bill fail closed, so this must be seeded in EVERY environment.
  { code: "maintenance_tenant", name: "Maintenance (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", sortOrder: 69 },
  // ── grid-utility itemization (Task 3 spec §R3) → Invoice / IVTEN, tenant side.
  // Pass-through utilities + subsidy carry NO markup by default → SST 0.
  { code: "electricity_tenant", name: "Electricity (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 61 },
  { code: "water_tenant", name: "Water (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 62 },
  { code: "sewerage_tenant", name: "Sewerage (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 63 },
  // WiFi is the supplier's already-SST-inclusive pass-through amount. Do not add
  // another 8% when billing/recovering it through the grid.
  { code: "wifi_tenant", name: "WiFi (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 64 },
  // Subsidy is TENANT-SIDE ONLY — an owner-funded offset shown as a negative
  // line on the tenant invoice (spec R2/R5); there is deliberately NO
  // subsidy_owner counterpart code.
  { code: "subsidy_tenant", name: "Subsidy (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 65 },
  // Custom recurring charges (recurring-charges feature) — the SINGLE seeded tenant-side
  // category all admin-defined tenant-borne recurring lines route through (IVTEN). No generic
  // picker in v1. Custom fees remain zero-rated by default; the admin can choose
  // an explicitly taxable expense category when a particular fee needs SST.
  { code: "recurring_other_tenant", name: "Recurring charge (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 66 },
  { code: "other_expense_tenant", name: "Other expense (tenant)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", sortOrder: 67 },
  // Letting commission (Phase 2 — first-full-month rent is KAEN's commission). The commission
  // month bills to the TENANT as KAEN revenue on IVTEN (an Invoice), NOT the owner's RB Rental
  // Bill. defaultSstRate 0: the tenant pays no SST on it — the 8% SST is OWNER-borne and billed
  // separately on IVOWN. Auto-minted by the rent poster (chargeType "letting_commission"), isSystem.
  // Distinct from the agent sales-commission domain (category "commission" on the Bill model).
  { code: "letting_commission", name: "Letting commission (first month)", family: "tenant_income", docType: "invoice", seriesCode: "IVTEN", defaultSstRate: "0", isSystem: true, sortOrder: 68 },
  // ── owner_income → Invoice / IVOWN (statement auto-post consumes these) ─────
  { code: "management_fee", name: "Management fee", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", defaultSstRate: "8", ledgerCategory: "management_fee", isSystem: true, sortOrder: 100 },
  { code: "cleaning_owner", name: "Cleaning (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", defaultSstRate: CLEANING_SST_RATE, ledgerCategory: "cleaning", isSystem: true, sortOrder: 110 },
  // Owner side of the maintenance scalar — mirrors cleaning_owner exactly (isSystem, IVOWN,
  // the EXISTING "maintenance_fee" ledger category so the owner statement buckets it
  // separately from cleaning — no new ledger vocabulary needed).
  { code: "maintenance_owner", name: "Maintenance (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", ledgerCategory: "maintenance_fee", isSystem: true, sortOrder: 118 },
  // ── grid-utility itemization (Task 3 spec §R3) → Invoice / IVOWN, owner side.
  // ledgerCategory mirrors the legacy pay_back_landlord utility_* rows below
  // (utility_tnb→utilities_tnb, utility_water→water, utility_wifi→wifi,
  // utility_indah_water→indah_water) — same owner-ledger bucket, different
  // document routing (IVOWN invoice, not a DEP debit note).
  { code: "electricity_owner", name: "Electricity (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", ledgerCategory: "utilities_tnb", isSystem: true, sortOrder: 111 },
  { code: "water_owner", name: "Water (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", ledgerCategory: "water", isSystem: true, sortOrder: 112 },
  { code: "sewerage_owner", name: "Sewerage (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", ledgerCategory: "indah_water", isSystem: true, sortOrder: 113 },
  { code: "wifi_owner", name: "WiFi (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", defaultSstRate: "0", ledgerCategory: "wifi", isSystem: true, sortOrder: 114 },
  // Custom recurring charges (recurring-charges feature) — the SINGLE seeded owner-side
  // category all admin-defined owner-borne recurring lines route through (IVOWN). No generic
  // picker in v1. ledgerCategory "cleaning" reuse: a generic owner recurring maps to the
  // cleaning owner-ledger bucket in v1 (a dedicated bucket is a future refinement, spec Non-goals).
  { code: "recurring_other_owner", name: "Recurring charge (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", ledgerCategory: "cleaning", isSystem: true, sortOrder: 115 },
  { code: "other_expense_owner", name: "Other expense (owner)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", defaultSstRate: "0", ledgerCategory: "other_expense", isSystem: true, sortOrder: 116 },
  // Letting commission SST (Phase 3): when commissionSstBearer="owner", the 8% SST on KAEN's
  // first-month commission is billed to the OWNER on their IVOWN statement + DEDUCTED from payout
  // (owner owes KAEN the tax). Flat amount (defaultSstRate 0 — it IS the SST). ledgerCategory
  // other_expense: a valid owner-expense bucket that deducts (a dedicated SST bucket is a fast-follow).
  { code: "letting_commission_sst", name: "Letting commission SST (owner-borne)", family: "owner_income", docType: "invoice", seriesCode: "IVOWN", defaultSstRate: "0", ledgerCategory: "other_expense", isSystem: true, sortOrder: 117 },
  // ── pay_back_landlord → Debit Note / DEP ────────────────────────────────────
  // isSystem on the codes auto-post flows resolve by (Plan 2 mint points).
  // Rental Bill (redesign P2, 2026-07-22): rent + carpark rental are the owner's money
  // billed to the tenant → their OWN series RB ("Rental Bill"), split out of the shared
  // DEP debit-note pool. docType stays debit_note (status-quo; avoids owner-ledger sign
  // ripple in net-adjustments-by-charge which keys on docType). Customer-facing title
  // "RENTAL BILL" is a presentation label on RB docs.
  { code: "rental", name: "Monthly rental", family: "pay_back_landlord", docType: "debit_note", seriesCode: "RB", ledgerCategory: "rental_income", isSystem: true, sortOrder: 200 },
  { code: "aircond", name: "Aircond (submeter)", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", ledgerCategory: "aircond_income", isSystem: true, sortOrder: 210 },
  { code: "carpark", name: "Carpark", family: "pay_back_landlord", docType: "debit_note", seriesCode: "RB", ledgerCategory: "carpark_income", isSystem: true, sortOrder: 220 },
  { code: "security_deposit", name: "Security deposit", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", sortOrder: 230 },
  { code: "utility_deposit", name: "Utility deposit", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", sortOrder: 240 },
  // ── Move-in deposits, DEPO series ───────────────────────────────────────────
  // NEW CODES rather than repointing security_deposit/utility_deposit above, because
  // ensureChargeCategorySeeds is deliberately CREATE-ONLY (it must never churn
  // `updatedAt`, which repository.ts uses as an optimistic-concurrency token). Editing
  // an existing seed's seriesCode therefore reaches only orgs seeded AFTER deploy,
  // leaving older orgs minting into DEP — the per-environment divergence this whole
  // series split exists to remove. A new code is created for every org, old and new.
  //
  // The two DEP-routed codes above keep their rows and stay unused by any code path;
  // they are not deleted because removing a seeded category needs an update path that
  // this create-only seeder does not have.
  { code: "tenancy_rental_deposit", name: "Rental deposit (move-in)", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEPO", isSystem: true, sortOrder: 235 },
  { code: "tenancy_utility_deposit", name: "Utilities deposit (move-in)", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEPO", isSystem: true, sortOrder: 245 },
  { code: "carpark_deposit", name: "Carpark deposit", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", sortOrder: 250 },
  { code: "access_card_deposit", name: "Access card deposit", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", sortOrder: 260 },
  { code: "utility_tnb", name: "Utilities — TNB electricity", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", ledgerCategory: "utilities_tnb", isSystem: true, sortOrder: 270 },
  { code: "utility_water", name: "Utilities — water (Air Selangor)", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", ledgerCategory: "water", isSystem: true, sortOrder: 280 },
  { code: "utility_wifi", name: "Utilities — WiFi", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", ledgerCategory: "wifi", isSystem: true, sortOrder: 290 },
  { code: "utility_indah_water", name: "Utilities — Indah Water", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", ledgerCategory: "indah_water", isSystem: true, sortOrder: 300 },
  // ── migration bucket (inactive for NEW entry; backfill target — spec §4.5) ──
  { code: "legacy_other", name: "Legacy / other", family: "pay_back_landlord", docType: "debit_note", seriesCode: "DEP", active: false, isSystem: true, sortOrder: 900 },
] as const;
