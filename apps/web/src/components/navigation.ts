import type { LucideIcon } from "lucide-react";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import type { PermissionCode } from "@/lib/permissions";
import {
  BarChart3,
  BellDot,
  BookOpen,
  Building2,
  CalendarCheck2,
  CheckSquare,
  ClipboardList,
  CreditCard,
  FileCheck,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Hammer,
  LayoutDashboard,
  Landmark,
  ListTodo,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";

/**
 * Minimum admin role required to see a nav item. Mirrors apps/api/src/lib/rbac.ts
 * (editor < manager < admin). Undefined = visible to all admin roles.
 */
export type MinRole = "editor" | "manager" | "admin";

export type NavWorkspace = "operations" | "accounting" | "neutral";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  minRole?: MinRole;
  workspace?: NavWorkspace;
  /** Exact capability required once the authenticated session has permissions. */
  permission?: PermissionCode;
};

export type NavSection = {
  label: string;
  items: NavItem[];
  /** If true, the section header is a click-to-toggle dropdown (collapsed by default). */
  collapsible?: boolean;
};

const ROLE_RANK: Record<string, number> = { editor: 1, manager: 2, director: 3, admin: 4 };

/** Returns true if `role` meets the minimum for a nav item. */
export function canSeeNavItem(role: string | undefined, item: NavItem): boolean {
  if (!item.minRole) return true;
  const current = ROLE_RANK[role ?? ""] ?? 0;
  const required = ROLE_RANK[item.minRole] ?? Number.POSITIVE_INFINITY;
  return current >= required;
}

/**
 * Workspace-aware visibility. The accountant is a capability, not a rank, so it
 * is DEFAULT-DENIED: it sees only items tagged "accounting" or "neutral".
 * Other roles: an "accounting"-tagged item is visible to admin/manager only;
 * everything else falls back to the rank gate (canSeeNavItem).
 */
export function canSeeNavItemFor(role: string | undefined, item: NavItem, permissions?: readonly string[]): boolean {
  // The effective permission list already includes role defaults plus per-user
  // grants and blocks. Permission-bound items fail closed while a stale local
  // session is waiting for /auth/me; otherwise a removed permission could
  // remain visible through the old role fallback until the refresh completes.
  if (item.permission) return permissions?.includes(item.permission) ?? false;
  if (item.href === "/accounting/profitability" && permissions?.includes("profit.view")) return true;
  if (role === "accountant") return item.workspace === "accounting" || item.workspace === "neutral";
  // Operations Admin participates in bank categorisation but does not gain the
  // rest of the Accounting workspace (especially profitability and month-end).
  if (item.href === "/accounting/bank-reconciliation" && role === "editor") return true;
  if (item.workspace === "accounting") return role === "admin" || role === "director" || role === "manager";
  return canSeeNavItem(role, item);
}

/**
 * True when `role` meets the minimum (editor < manager < admin). Same ranking
 * canSeeNavItem uses — exported so pages gate role-bound affordances (e.g.
 * tenant-tracker export/IC-reveal) without hand-rolling role literals.
 */
export function hasMinRole(role: string | undefined, min: "editor" | MinRole): boolean {
  const current = ROLE_RANK[role ?? ""] ?? 0;
  const required = ROLE_RANK[min] ?? Number.POSITIVE_INFINITY;
  return current >= required;
}

export const navSections: NavSection[] = [
  {
    label: "Main",
    items: [
      { title: "Overview", href: "/dashboard", icon: LayoutDashboard, workspace: "neutral" },
      { title: "Action Centre", href: "/action-centre", icon: ListTodo, workspace: "neutral" },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { title: "Inventory",  href: "/inventory", icon: Building2, permission: "portfolio.view" },
      // Inventory Settings is now a section inside /settings (left-rail).
      { title: "Tenants & Owners", href: "/parties", icon: Users, permission: "party.view" },
      { title: "Tenancy Agreements", href: "/tenancy/tenancies", icon: FileSignature, permission: "tenancy.view" },
      { title: "Management Agreements", href: "/portfolio/property-management-agreements", icon: FileText, permission: "agreement.view" },
    ],
  },
  // Phase-2 Operations — Tasks board (M7) + Unit Analytics (Spec 2), placed
  // above Tenancy. Section appears when either flag is on; each item is gated
  // by its own flag (routes are gated the same way in router.tsx).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_TASKS")
    ? [
        {
          label: "Operations",
          items: [
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_TASKS")
              ? [{ title: "Tasks", href: "/tasks", icon: ListTodo, minRole: "editor" as const }]
              : []),
          ],
        },
      ]
    : []),
  // Billing section — exists when Auto-Draft (M5) OR the accounting Documents
  // register OR the Tenant & Owner Billing grid is on. Each item gated by its
  // own flag (routes gated the same way in router.tsx). Draft Approvals:
  // minRole editor matches requireRole("editor"); Documents: minRole manager
  // matches the API's requireRole("manager"). ENABLE_PHASE2_BILLS_GRID is
  // included in the SECTION condition (not just its item) so the grid stays
  // visible even when AUTODRAFT + BILLING_DOCS are both dark.
  ...((isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT") || isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") || isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID"))
    ? [
        {
          label: "Billing",
          items: [
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLS_GRID")
              ? [
                  {
                    title: "Tenant & Owner Billing",
                    href: "/billing/tenant-owner-billing",
                    icon: Table2,
                    minRole: "editor" as const,
                    permission: "billing.view" as const,
                  },
                ]
              : []),
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
              ? [
                  {
                    title: "Draft Approvals",
                    href: "/billing/draft-approvals",
                    icon: FileCheck,
                    minRole: "editor" as const,
                    permission: "billing.view" as const,
                  },
                ]
              : []),
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
              ? [
                  {
                    title: "Documents",
                    href: "/billing/documents",
                    icon: FileText,
                    minRole: "manager" as const,
                    workspace: "accounting" as const,
                    permission: "accounting.view" as const,
                  },
                ]
              : []),
            // Charges/Payments retired from the active nav once the accounting
            // workspace is on — Invoices/Receipts/Documents supersede them for
            // day-to-day work. They remain in the flag-OFF Hidden fallback below
            // (the only billing surface when the accounting workspace is dark)
            // and reachable by URL for the admin-only post/void + FPX-recovery +
            // refund flows the accounting workspace doesn't yet cover.
          ],
        },
      ]
    : []),
  // Accounting section (P3): the accountant's manual invoice-create + Transfer
  // -from-Invoice recording surfaces. workspace:"accounting" admits admin/manager
  // + the accountant; minRole:"manager" gives non-accountant admin/manager the
  // rank fallback too.
  ...((isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") || isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING"))
    ? [
        {
          label: "Accounting",
          items: [
            ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
              ? [
                  { title: "Bank Reconciliation", href: "/accounting/bank-reconciliation", icon: Landmark, minRole: "editor" as const, workspace: "accounting" as const, permission: "bank.read" as const },
                  { title: "Invoices", href: "/accounting/invoices", icon: FileText, minRole: "manager" as const, workspace: "accounting" as const, permission: "accounting.view" as const },
                  { title: "Receipts", href: "/accounting/receipts", icon: ReceiptText, minRole: "manager" as const, workspace: "accounting" as const, permission: "accounting.view" as const },
                  { title: "Employee Claims", href: "/accounting/employee-expense-claims", icon: ClipboardList, minRole: "manager" as const, workspace: "accounting" as const, permission: "claim.create" as const },
                  ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
                    ? [{ title: "Owner Ledger", href: "/tenancy/owner-ledger", icon: BookOpen, minRole: "manager" as const, workspace: "accounting" as const, permission: "owner_report.view" as const }]
                    : []),
                  { title: "Owner & Tenant Profitability", href: "/accounting/profitability", icon: TrendingUp, minRole: "admin" as const, workspace: "accounting" as const, permission: "profit.view" as const },
                  { title: "Month-End Control", href: "/accounting/month-end-control", icon: CalendarCheck2, minRole: "admin" as const, workspace: "accounting" as const, permission: "accounting.view" as const },
                ]
              : [
                  ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
                    ? [{ title: "Owner Ledger", href: "/tenancy/owner-ledger", icon: BookOpen, minRole: "manager" as const, workspace: "accounting" as const }]
                    : []),
                ]),
          ],
        },
      ]
    : []),
  {
    label: "Audit",
    items: [
      { title: "Audit", href: "/audit", icon: ShieldCheck, minRole: "manager", permission: "audit.view" },
    ],
  },
  {
    // Staff roles and access control belong with system configuration rather
    // than the day-to-day operating sections. The underlying organization
    // routes stay intact so existing bookmarks and data flows are unaffected.
    label: "Settings",
    items: [
      { title: "Roles", href: "/organization/staff", icon: Users, workspace: "neutral", permission: "roles.manage" },
      { title: "Settings", href: "/settings", icon: SlidersHorizontal, workspace: "neutral", permission: "settings.view" },
    ],
  },
  // Operations section relocated above Tenancy (Tasks + Unit Analytics).
  {
    // Parked sections — surfaces that exist in the codebase but are not part
    // of the active product flow yet. Kept here (instead of removed) so we
    // don't forget about them. Click "Hidden" in the sidebar to expand.
    // S&R Settings moved out — it's now reachable via /settings/sales-renovation.
    label: "Other Modules",
    collapsible: true,
    items: [
      { title: "Source Queue", href: "/source-queue", icon: CheckSquare, minRole: "manager" },
      { title: "Reservations", href: "/admin/reservations", icon: FileSignature },
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_UNIT_ANALYTICS")
        ? [{ title: "Unit Analytics", href: "/tenancy/unit-analytics", icon: BarChart3, minRole: "manager" as const }]
        : []),
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_TENANT_TRACKER")
        ? [{ title: "Data Import", href: "/tenancy/data-import", icon: FileSpreadsheet, minRole: "admin" as const }]
        : []),
      { title: "Commission Claims", href: "/commissions/claims", icon: ClipboardList },
      { title: "Commission Performance", href: "/commissions/performance", icon: TrendingUp },
      ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
        ? []
        : [
            { title: "Charges",  href: "/billing/charges",  icon: ReceiptText },
            { title: "Payments", href: "/billing/payments", icon: CreditCard },
          ]),
      { title: "Pipeline",           href: "/sales/pipeline",                icon: Workflow },
      { title: "Renovation Claims",  href: "/renovation/claims",             icon: Hammer },
      { title: "Sales Claims",       href: "/sales/claims",                  icon: ClipboardList },
      { title: "Notifications",      href: "/communications/notifications",  icon: BellDot },
    ],
  },
];

// Flat list for mobile nav
export const allNavItems: NavItem[] = navSections.flatMap((s) => s.items);
