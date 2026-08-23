export type PermissionCode =
  | "portfolio.view" | "portfolio.create" | "portfolio.edit" | "portfolio.delete"
  | "party.view" | "party.create" | "party.edit" | "party.sensitive.view" | "party.blacklist"
  | "tenancy.view" | "tenancy.create" | "tenancy.edit" | "tenancy.move" | "tenancy.renew" | "tenancy.cancel_renewal"
  | "agreement.view" | "agreement.generate" | "agreement.edit" | "agreement.template_manage" | "agreement.download" | "agreement.void"
  | "billing.view" | "billing.charge.edit" | "billing.save" | "billing.bill" | "billing.rebill" | "billing.mark_paid" | "billing.document_manage" | "billing.export" | "billing.period_manage"
  | "cost.view" | "cost.create" | "cost.create_from_bank" | "cost.edit" | "claim.create" | "claim.view_all" | "claim.approve" | "claim.reimburse" | "profit.view" | "profit.export"
  | "owner_report.view" | "owner_report.generate" | "owner_report.first_check" | "owner_report.final_approve" | "owner_report.reopen" | "owner_report.download" | "owner_payout.record" | "owner_payout.reverse"
  | "bank.read" | "bank.import" | "bank.manage_accounts" | "bank.categorize" | "bank.allocate_credit" | "bank.allocate_debit" | "bank.internal_transfer" | "bank.undo_match" | "bank.export"
  | "accounting.view" | "accounting.issue" | "accounting.void" | "accounting.export" | "management_fee.configure"
  | "audit.view" | "settings.view" | "settings.manage" | "roles.manage" | "user.disable" | "user.reset_password" | "important_record.delete";

export type PermissionOverrides = Partial<Record<PermissionCode, boolean>>;
type Item = readonly [PermissionCode, string, string, boolean?];
const group = (group: string, items: Item[]) => ({ group, items });

export const PERMISSION_GROUPS = [
  group("Portfolio & Parties", [
    ["portfolio.view","View properties and units","See property, unit and occupancy information."],
    ["portfolio.create","Create properties and units","Add properties, units, rooms and parking."],
    ["portfolio.edit","Edit properties and units","Change property, unit, room and parking details."],
    ["portfolio.delete","Delete properties and units","Delete portfolio records and permitted related data.",true],
    ["party.view","View owners and tenants","See owner and tenant profiles."],
    ["party.create","Create owners and tenants","Add owner and tenant profiles."],
    ["party.edit","Edit owners and tenants","Change owner and tenant profile details."],
    ["party.sensitive.view","View sensitive identity details","See identity numbers, bank details and protected contact data.",true],
    ["party.blacklist","Manage blacklist status","Blacklist or restore an owner or tenant.",true],
  ]),
  group("Tenancies & Agreements", [
    ["tenancy.view","View tenancies","See tenancy dates, rent, deposits and history."],
    ["tenancy.create","Create and assign tenancies","Assign tenants and create tenancy records."],
    ["tenancy.edit","Edit tenancy terms","Change dates, rent, deposit and tenancy details."],
    ["tenancy.move","Move in, move out and transfer","Complete tenant movement and unit-transfer workflows."],
    ["tenancy.renew","Manage renewals","Record renewal decisions, fees and renewed terms."],
    ["tenancy.cancel_renewal","Cancel renewals","Cancel a future renewed tenancy and safely reverse its unissued drafts.",true],
    ["agreement.view","View agreements","Open tenancy and property-management agreements."],
    ["agreement.generate","Generate agreements","Create an agreement from an approved template."],
    ["agreement.edit","Edit generated agreements","Change agreement wording before finalisation."],
    ["agreement.template_manage","Manage agreement templates","Create, edit and retire reusable agreement templates.",true],
    ["agreement.download","Download agreements","Preview or download agreement PDFs."],
    ["agreement.void","Void agreements","Void a generated agreement while keeping its history.",true],
  ]),
  group("Billing & Collections", [
    ["billing.view","View Tenant & Owner Billing","See the billing matrix, summaries and statuses."],
    ["billing.charge.edit","Enter and edit charges","Add or change tenant charges and owner expenses."],
    ["billing.save","Save billing changes","Save draft billing-cell changes."],
    ["billing.bill","Bill tenants","Issue selected saved tenant charges."],
    ["billing.rebill","Re-bill and adjust charges","Replace or adjust an already billed amount.",true],
    ["billing.mark_paid","Record payments and mark paid","Record full or partial payment against a charge."],
    ["billing.document_manage","Manage charge documents","Upload, view and download invoices or receipts."],
    ["billing.export","Export billing data","Export detailed, selected and summary billing reports."],
    ["billing.period_manage","Manage billing periods","Create, close or reopen a billing period.",true],
  ]),
  group("Costs, Claims & Margin", [
    ["cost.view","View actual costs","See recorded and allocated business costs."],
    ["cost.create","Create actual costs","Enter actual costs and allocate them to charges."],
    ["cost.create_from_bank","Create costs from bank transactions","Allocate debit transactions as actual costs."],
    ["cost.edit","Edit actual costs","Correct vendor, amount, payment and allocation details."],
    ["claim.create","Create expense claims","Submit employee expense claims and attachments."],
    ["claim.view_all","View all employee claims","See claims submitted by every employee."],
    ["claim.approve","Approve or reject claims","Complete management review of employee claims.",true],
    ["claim.reimburse","Record claim reimbursement","Record and reverse claim reimbursement payments.",true],
    ["profit.view","View margin and profit","See owner, tenant and unit profit or loss.",true],
    ["profit.export","Export profitability","Download profitability and margin records.",true],
  ]),
  group("Owner Payout & Reports", [
    ["owner_report.view","View owner reports","Open owner payout calculations and reports."],
    ["owner_report.generate","Generate owner reports","Create or refresh monthly owner reports."],
    ["owner_report.first_check","First-check owner reports","Complete the manager checking stage."],
    ["owner_report.final_approve","Final-approve owner reports","Approve the final owner payout report.",true],
    ["owner_report.reopen","Reopen approved owner reports","Return a checked or approved report to draft.",true],
    ["owner_report.download","Download owner reports","Download individual or bulk owner-report PDFs."],
    ["owner_payout.record","Record owner payouts","Record full or partial payments made to owners.",true],
    ["owner_payout.reverse","Reverse owner payouts","Reverse an incorrectly recorded owner payout.",true],
  ]),
  group("Bank Reconciliation", [
    ["bank.read","View bank reconciliation","See imported bank transactions and matching status."],
    ["bank.import","Import bank transactions","Upload bank statement or transaction files.",true],
    ["bank.manage_accounts","Manage bank accounts","Create and maintain company bank accounts.",true],
    ["bank.categorize","Categorise transactions","Classify a transaction without creating a financial record."],
    ["bank.allocate_credit","Allocate collections","Split and match credit transactions to tenant collections."],
    ["bank.allocate_debit","Allocate payments and costs","Split and match debit transactions to payouts or costs."],
    ["bank.internal_transfer","Match internal transfers","Pair transfers between company bank accounts."],
    ["bank.undo_match","Undo transaction matches","Return a matched transaction for reclassification.",true],
    ["bank.export","Export bank reconciliation","Download matched or unmatched transaction data."],
  ]),
  group("Accounting & Documents", [
    ["accounting.view","View accounting records","See invoices, receipts, notes and accounting transactions."],
    ["accounting.issue","Issue accounting documents","Issue invoices, receipts, debit notes and credit notes."],
    ["accounting.void","Void accounting documents","Void an issued accounting document with an audit trail.",true],
    ["accounting.export","Export accountant ledger","Download yearly and filtered accounting transactions."],
    ["management_fee.configure","Configure management fees","Change per-unit rates, caps, free periods and SST.",true],
  ]),
  group("System & Security", [
    ["audit.view","View audit log","See who changed what and when.",true],
    ["settings.view","View settings","See Tenant Management configuration."],
    ["settings.manage","Manage settings","Change Tenant Management configuration.",true],
    ["roles.manage","Manage users and permissions","Create users, assign roles and customise access.",true],
    ["user.disable","Disable or reactivate users","Control whether a staff account can sign in.",true],
    ["user.reset_password","Reset staff passwords","Issue a new temporary password.",true],
    ["important_record.delete","Delete other important records","Delete protected records not covered by a specific permission.",true],
  ]),
] as const;

const allCodes = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i[0]));
const FINANCE_ONLY = new Set<PermissionCode>(["bank.import", "bank.manage_accounts", "bank.export"]);
const SENIOR_FINANCE_ONLY = new Set<PermissionCode>(["claim.approve", "claim.reimburse"]);
const DIRECTOR_ONLY = new Set<PermissionCode>(["owner_report.final_approve"]);
const SUPER_ADMIN_ONLY = new Set<PermissionCode>(["settings.manage", "important_record.delete"]);
const OPERATIONS: PermissionCode[] = ["portfolio.view","portfolio.create","portfolio.edit","party.view","party.create","party.edit","tenancy.view","tenancy.create","tenancy.edit","tenancy.move","tenancy.renew","agreement.view","agreement.generate","agreement.edit","agreement.download","billing.view","billing.charge.edit","billing.save","billing.bill","billing.document_manage","claim.create","owner_report.view","owner_report.download","bank.read","bank.categorize","bank.allocate_credit","bank.allocate_debit","bank.internal_transfer","accounting.view","settings.view"];
// Managers can run the full department except final owner-payout approval.
const MANAGER: PermissionCode[] = allCodes.filter((code) => code !== "owner_report.final_approve" && !FINANCE_ONLY.has(code) && !SENIOR_FINANCE_ONLY.has(code) && !SUPER_ADMIN_ONLY.has(code));
const FINANCE: PermissionCode[] = ["portfolio.view","party.view","party.sensitive.view","tenancy.view","agreement.view","agreement.download","billing.view","billing.mark_paid","billing.document_manage","billing.export","billing.period_manage","cost.view","cost.create","cost.create_from_bank","cost.edit","claim.view_all","claim.approve","claim.reimburse","profit.view","profit.export","owner_report.view","owner_report.generate","owner_report.download","owner_payout.record","owner_payout.reverse","bank.read","bank.import","bank.manage_accounts","bank.categorize","bank.allocate_credit","bank.allocate_debit","bank.internal_transfer","bank.undo_match","bank.export","accounting.view","accounting.issue","accounting.void","accounting.export","management_fee.configure","audit.view","settings.view"];
const DEFAULTS: Record<string, ReadonlySet<PermissionCode>> = {
  admin: new Set(allCodes), director: new Set([...MANAGER,"portfolio.delete","party.blacklist","agreement.template_manage","agreement.void","claim.approve","claim.reimburse","profit.view","profit.export","owner_report.final_approve","owner_report.reopen","owner_payout.record","owner_payout.reverse","management_fee.configure","user.disable","user.reset_password"]),
  manager: new Set(MANAGER), editor: new Set(OPERATIONS), accountant: new Set(FINANCE),
  viewer: new Set(["portfolio.view","party.view","tenancy.view","agreement.view","billing.view","owner_report.view","accounting.view","settings.view"]),
};
export function roleHasPermission(role: string, code: PermissionCode): boolean { return DEFAULTS[role]?.has(code) ?? false; }
export function permissionCanBeGrantedToRole(role: string, code: PermissionCode): boolean {
  if (SUPER_ADMIN_ONLY.has(code)) return role === "admin";
  if (DIRECTOR_ONLY.has(code)) return role === "admin" || role === "director";
  if (FINANCE_ONLY.has(code)) return role === "admin" || role === "accountant";
  if (SENIOR_FINANCE_ONLY.has(code)) return role === "admin" || role === "accountant" || role === "director";
  return true;
}
export function effectivePermission(role: string, overrides: PermissionOverrides, code: PermissionCode): boolean {
  if (!permissionCanBeGrantedToRole(role, code)) return false;
  return overrides[code] ?? roleHasPermission(role, code);
}

const ROLE_TIER: Record<string, number> = { admin: 5, director: 4, manager: 3, accountant: 3, editor: 2, viewer: 1 };
export function canManageRole(actorRole: string | undefined, targetRole: string | undefined): boolean {
  const actorTier = actorRole ? ROLE_TIER[actorRole] : undefined;
  const targetTier = targetRole ? ROLE_TIER[targetRole] : undefined;
  return Number.isFinite(actorTier) && Number.isFinite(targetTier) && (actorTier as number) > (targetTier as number);
}
