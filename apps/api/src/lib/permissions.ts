/** Fine-grained business capabilities for the Tenant Management workspace. */
export type BusinessRole = "admin" | "director" | "manager" | "editor" | "accountant" | "viewer";

type CatalogRow = readonly [code: string, group: string, label: string, description: string, sensitive?: boolean];
export const PERMISSION_CATALOG = [
  ["portfolio.view", "Portfolio & Parties", "View properties and units", "See property, unit and occupancy information."],
  ["portfolio.create", "Portfolio & Parties", "Create properties and units", "Add properties, units, rooms and parking."],
  ["portfolio.edit", "Portfolio & Parties", "Edit properties and units", "Change property, unit, room and parking details."],
  ["portfolio.delete", "Portfolio & Parties", "Delete properties and units", "Delete portfolio records and permitted related data.", true],
  ["party.view", "Portfolio & Parties", "View owners and tenants", "See owner and tenant profiles."],
  ["party.create", "Portfolio & Parties", "Create owners and tenants", "Add owner and tenant profiles."],
  ["party.edit", "Portfolio & Parties", "Edit owners and tenants", "Change owner and tenant profile details."],
  ["party.sensitive.view", "Portfolio & Parties", "View sensitive identity details", "See identity numbers, bank details and protected contact data.", true],
  ["party.blacklist", "Portfolio & Parties", "Manage blacklist status", "Blacklist or restore an owner or tenant.", true],
  ["tenancy.view", "Tenancies & Agreements", "View tenancies", "See tenancy dates, rent, deposits and history."],
  ["tenancy.create", "Tenancies & Agreements", "Create and assign tenancies", "Assign tenants and create tenancy records."],
  ["tenancy.edit", "Tenancies & Agreements", "Edit tenancy terms", "Change dates, rent, deposit and tenancy details."],
  ["tenancy.move", "Tenancies & Agreements", "Move in, move out and transfer", "Complete tenant movement and unit-transfer workflows."],
  ["tenancy.renew", "Tenancies & Agreements", "Manage renewals", "Record renewal decisions, fees and renewed terms."],
  ["tenancy.cancel_renewal", "Tenancies & Agreements", "Cancel renewals", "Cancel a future renewed tenancy and safely reverse its unissued drafts.", true],
  ["agreement.view", "Tenancies & Agreements", "View agreements", "Open tenancy and property-management agreements."],
  ["agreement.generate", "Tenancies & Agreements", "Generate agreements", "Create an agreement from an approved template."],
  ["agreement.edit", "Tenancies & Agreements", "Edit generated agreements", "Change agreement wording before finalisation."],
  ["agreement.template_manage", "Tenancies & Agreements", "Manage agreement templates", "Create, edit and retire reusable agreement templates.", true],
  ["agreement.download", "Tenancies & Agreements", "Download agreements", "Preview or download agreement PDFs."],
  ["agreement.void", "Tenancies & Agreements", "Void agreements", "Void a generated agreement while keeping its history.", true],
  ["billing.view", "Billing & Collections", "View Tenant & Owner Billing", "See the billing matrix, summaries and statuses."],
  ["billing.charge.edit", "Billing & Collections", "Enter and edit charges", "Add or change tenant charges and owner expenses."],
  ["billing.save", "Billing & Collections", "Save billing changes", "Save draft billing-cell changes."],
  ["billing.bill", "Billing & Collections", "Bill tenants", "Issue selected saved tenant charges."],
  ["billing.rebill", "Billing & Collections", "Re-bill and adjust charges", "Replace or adjust an already billed amount.", true],
  ["billing.mark_paid", "Billing & Collections", "Record payments and mark paid", "Record full or partial payment against a charge."],
  ["billing.document_manage", "Billing & Collections", "Manage charge documents", "Upload, view and download invoices or receipts."],
  ["billing.export", "Billing & Collections", "Export billing data", "Export detailed, selected and summary billing reports."],
  ["billing.period_manage", "Billing & Collections", "Manage billing periods", "Create, close or reopen a billing period.", true],
  ["cost.view", "Costs, Claims & Margin", "View actual costs", "See recorded and allocated business costs."],
  ["cost.create", "Costs, Claims & Margin", "Create actual costs", "Enter actual costs and allocate them to charges."],
  ["cost.create_from_bank", "Costs, Claims & Margin", "Create costs from bank transactions", "Allocate debit transactions as actual costs."],
  ["cost.edit", "Costs, Claims & Margin", "Edit actual costs", "Correct vendor, amount, payment and allocation details."],
  ["claim.create", "Costs, Claims & Margin", "Create expense claims", "Submit employee expense claims and attachments."],
  ["claim.view_all", "Costs, Claims & Margin", "View all employee claims", "See claims submitted by every employee."],
  ["claim.approve", "Costs, Claims & Margin", "Approve or reject claims", "Complete management review of employee claims.", true],
  ["claim.reimburse", "Costs, Claims & Margin", "Record claim reimbursement", "Record and reverse claim reimbursement payments.", true],
  ["profit.view", "Costs, Claims & Margin", "View margin and profit", "See owner, tenant and unit profit or loss.", true],
  ["profit.export", "Costs, Claims & Margin", "Export profitability", "Download profitability and margin records.", true],
  ["owner_report.view", "Owner Payout & Reports", "View owner reports", "Open owner payout calculations and reports."],
  ["owner_report.generate", "Owner Payout & Reports", "Generate owner reports", "Create or refresh monthly owner reports."],
  ["owner_report.first_check", "Owner Payout & Reports", "First-check owner reports", "Complete the manager checking stage."],
  ["owner_report.final_approve", "Owner Payout & Reports", "Final-approve owner reports", "Approve the final owner payout report.", true],
  ["owner_report.reopen", "Owner Payout & Reports", "Reopen approved owner reports", "Return a checked or approved report to draft.", true],
  ["owner_report.download", "Owner Payout & Reports", "Download owner reports", "Download individual or bulk owner-report PDFs."],
  ["owner_payout.record", "Owner Payout & Reports", "Record owner payouts", "Record full or partial payments made to owners.", true],
  ["owner_payout.reverse", "Owner Payout & Reports", "Reverse owner payouts", "Reverse an incorrectly recorded owner payout.", true],
  ["bank.read", "Bank Reconciliation", "View bank reconciliation", "See imported bank transactions and matching status."],
  ["bank.import", "Bank Reconciliation", "Import bank transactions", "Upload bank statement or transaction files.", true],
  ["bank.manage_accounts", "Bank Reconciliation", "Manage bank accounts", "Create and maintain company bank accounts.", true],
  ["bank.categorize", "Bank Reconciliation", "Categorise transactions", "Classify a transaction without creating a financial record."],
  ["bank.allocate_credit", "Bank Reconciliation", "Allocate collections", "Split and match credit transactions to tenant collections."],
  ["bank.allocate_debit", "Bank Reconciliation", "Allocate payments and costs", "Split and match debit transactions to payouts or costs."],
  ["bank.internal_transfer", "Bank Reconciliation", "Match internal transfers", "Pair transfers between company bank accounts."],
  ["bank.undo_match", "Bank Reconciliation", "Undo transaction matches", "Return a matched transaction for reclassification.", true],
  ["bank.export", "Bank Reconciliation", "Export bank reconciliation", "Download matched or unmatched transaction data."],
  ["accounting.view", "Accounting & Documents", "View accounting records", "See invoices, receipts, notes and accounting transactions."],
  ["accounting.issue", "Accounting & Documents", "Issue accounting documents", "Issue invoices, receipts, debit notes and credit notes."],
  ["accounting.void", "Accounting & Documents", "Void accounting documents", "Void an issued accounting document with an audit trail.", true],
  ["accounting.export", "Accounting & Documents", "Export accountant ledger", "Download yearly and filtered accounting transactions."],
  ["management_fee.configure", "Accounting & Documents", "Configure management fees", "Change per-unit rates, caps, free periods and SST.", true],
  ["audit.view", "System & Security", "View audit log", "See who changed what and when.", true],
  ["settings.view", "System & Security", "View settings", "See Tenant Management configuration."],
  ["settings.manage", "System & Security", "Manage settings", "Change Tenant Management configuration.", true],
  ["roles.manage", "System & Security", "Manage users and permissions", "Create users, assign roles and customise access.", true],
  ["user.disable", "System & Security", "Disable or reactivate users", "Control whether a staff account can sign in.", true],
  ["user.reset_password", "System & Security", "Reset staff passwords", "Issue a new temporary password.", true],
  ["important_record.delete", "System & Security", "Delete other important records", "Delete protected records not covered by a specific permission.", true],
] as const satisfies readonly CatalogRow[];

export type Permission = (typeof PERMISSION_CATALOG)[number][0];
export type PermissionOverrides = Partial<Record<Permission, boolean>>;
const ALL = PERMISSION_CATALOG.map(([code]) => code);
const FINANCE_ONLY = new Set<Permission>(["bank.import", "bank.manage_accounts", "bank.export"]);
const SENIOR_FINANCE_ONLY = new Set<Permission>(["claim.approve", "claim.reimburse"]);
const DIRECTOR_ONLY = new Set<Permission>(["owner_report.final_approve"]);
const SUPER_ADMIN_ONLY = new Set<Permission>(["settings.manage", "important_record.delete"]);
const OPERATIONS: Permission[] = ["portfolio.view","portfolio.create","portfolio.edit","party.view","party.create","party.edit","tenancy.view","tenancy.create","tenancy.edit","tenancy.move","tenancy.renew","agreement.view","agreement.generate","agreement.edit","agreement.download","billing.view","billing.charge.edit","billing.save","billing.bill","billing.document_manage","claim.create","owner_report.view","owner_report.download","bank.read","bank.categorize","bank.allocate_credit","bank.allocate_debit","bank.internal_transfer","accounting.view","settings.view"];
// Business rule: Manager can operate every part of Tenant Management except
// the final owner-payout approval, which remains Director/Super Admin only.
const MANAGER: Permission[] = ALL.filter((code) => code !== "owner_report.final_approve" && !FINANCE_ONLY.has(code) && !SENIOR_FINANCE_ONLY.has(code) && !SUPER_ADMIN_ONLY.has(code));
const FINANCE: Permission[] = ["portfolio.view","party.view","party.sensitive.view","tenancy.view","agreement.view","agreement.download","billing.view","billing.mark_paid","billing.document_manage","billing.export","billing.period_manage","cost.view","cost.create","cost.create_from_bank","cost.edit","claim.view_all","claim.approve","claim.reimburse","profit.view","profit.export","owner_report.view","owner_report.generate","owner_report.download","owner_payout.record","owner_payout.reverse","bank.read","bank.import","bank.manage_accounts","bank.categorize","bank.allocate_credit","bank.allocate_debit","bank.internal_transfer","bank.undo_match","bank.export","accounting.view","accounting.issue","accounting.void","accounting.export","management_fee.configure","audit.view","settings.view"];
const ROLE_PERMISSIONS: Record<BusinessRole, ReadonlySet<Permission>> = {
  admin: new Set(ALL),
  director: new Set([...MANAGER,"portfolio.delete","party.blacklist","agreement.template_manage","agreement.void","claim.approve","claim.reimburse","profit.view","profit.export","owner_report.final_approve","owner_report.reopen","owner_payout.record","owner_payout.reverse","management_fee.configure","user.disable","user.reset_password"]),
  manager: new Set(MANAGER), editor: new Set(OPERATIONS), accountant: new Set(FINANCE),
  viewer: new Set(["portfolio.view","party.view","tenancy.view","agreement.view","billing.view","owner_report.view","accounting.view","settings.view"]),
};
export function hasPermission(role: string | undefined, permission: Permission, overrides?: PermissionOverrides | null): boolean {
  if (role === "admin") return true;
  if (SUPER_ADMIN_ONLY.has(permission)) return false;
  if (DIRECTOR_ONLY.has(permission) && role !== "director") return false;
  if (FINANCE_ONLY.has(permission) && role !== "accountant") return false;
  if (SENIOR_FINANCE_ONLY.has(permission) && role !== "accountant" && role !== "director") return false;
  const override = overrides?.[permission];
  return typeof override === "boolean" ? override : (ROLE_PERMISSIONS[role as BusinessRole]?.has(permission) ?? false);
}
export function permissionCanBeGrantedToRole(role: string | undefined, permission: Permission): boolean {
  if (SUPER_ADMIN_ONLY.has(permission)) return role === "admin";
  if (DIRECTOR_ONLY.has(permission)) return role === "admin" || role === "director";
  if (FINANCE_ONLY.has(permission)) return role === "admin" || role === "accountant";
  if (SENIOR_FINANCE_ONLY.has(permission)) return role === "admin" || role === "accountant" || role === "director";
  return true;
}
export function permissionsFor(role: string | undefined): ReadonlySet<Permission> { return ROLE_PERMISSIONS[role as BusinessRole] ?? new Set<Permission>(); }
export function effectivePermissions(role: string | undefined, overrides?: PermissionOverrides | null): Permission[] { return ALL.filter((code) => hasPermission(role, code, overrides)); }

/**
 * Staff-management hierarchy. Manager and Finance deliberately share one
 * tier, so neither can administer the other. A user may only administer a
 * strictly lower tier; permissions such as roles.manage are still required
 * separately by the route middleware.
 */
const ROLE_TIER: Record<BusinessRole, number> = {
  admin: 5,
  director: 4,
  manager: 3,
  accountant: 3,
  editor: 2,
  viewer: 1,
};

export function canManageRole(actorRole: string | undefined, targetRole: string | undefined): boolean {
  const actorTier = ROLE_TIER[actorRole as BusinessRole];
  const targetTier = ROLE_TIER[targetRole as BusinessRole];
  return Number.isFinite(actorTier) && Number.isFinite(targetTier) && actorTier > targetTier;
}
