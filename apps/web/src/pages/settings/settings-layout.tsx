import { Link, Outlet, useLocation, Navigate } from "react-router-dom";
import {
  Calculator,
  Building2,
  Paintbrush,
  LayoutTemplate,
  Receipt,
  FileText,
  Zap,
  Hash,
  Flag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { canSeeNavItemFor, type NavItem, type MinRole } from "@/components/navigation";

type SettingsDepartment = {
  title: string;
  company: string;
  description: string;
  sections: NavItem[];
};

const TENANT_MANAGEMENT_SECTIONS: NavItem[] = [
  { title: "Inventory",          href: "/settings/inventory",          icon: Building2,      minRole: "manager", permission: "settings.view" },
  { title: "Document Templates", href: "/settings/document-templates", icon: LayoutTemplate, minRole: "admin", permission: "settings.view" },
  // Phase-2 Owner Billing (M6) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")
    ? [{ title: "Owner Billing", href: "/settings/owner-billing", icon: Receipt, minRole: "admin" as const, permission: "settings.view" as const }]
    : []),
  // Phase-2 Auto-Draft Invoices (M5) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  //
  // minRole "manager" (was "admin"): this page now also hosts the Charge Categories
  // panel, which managers maintain (API: requireRole("manager") on category
  // create/patch/deactivate). The auto-draft config above it stays admin-editable —
  // BillingConfigSection's own `canWrite` is still `role === "admin"`, so a manager
  // sees the schedule read-only with no Save / Run now.
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")
    ? [{ title: "Billing Config", href: "/settings/billing-config", icon: FileText, minRole: "manager" as const, permission: "settings.view" as const }]
    : []),
  // Phase-2 Meter & Utilities (M2) — section only exists when the flag is on
  // (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_METER")
    ? [{ title: "Utilities", href: "/settings/utilities", icon: Zap, minRole: "admin" as const, permission: "settings.view" as const }]
    : []),
  // Accounting-docs P1 — BillingDocument numbering config; section only exists
  // when the flag is on (router.tsx gates the child route the same way).
  ...(isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")
    ? [{ title: "Document Series", href: "/settings/document-series", icon: Hash, minRole: "admin" as const, permission: "settings.view" as const }]
    : []),
  // NOTE (2026-08-03): the "Charge Categories" entry that used to sit here was removed.
  // That table is now a panel inside Billing Config above. The /settings/charge-categories
  // route still resolves (charge-categories-section.tsx redirects) so old bookmarks work —
  // it just has no nav item of its own.
];

const SETTINGS_DEPARTMENTS: SettingsDepartment[] = [
  {
    title: "Tenant Management",
    company: "KAEN Properties Management Sdn Bhd",
    description: "Managed units, billing, utilities and documents",
    sections: TENANT_MANAGEMENT_SECTIONS,
  },
  {
    title: "Rental Services",
    company: "KAEN Properties Management Sdn Bhd",
    description: "Rental commission and tenancy administration",
    sections: [
      { title: "Commission & TA", href: "/settings/commission", icon: Calculator, minRole: "manager", permission: "settings.view" },
    ],
  },
  {
    title: "Investment Renovation",
    company: "KAEN Properties Sdn Bhd",
    description: "Renovation commercial configuration",
    sections: [
      { title: "Sales & Renovation", href: "/settings/sales-renovation", icon: Paintbrush, minRole: "admin", permission: "settings.view" },
    ],
  },
  {
    title: "New Projects",
    company: "KAEN Properties Sdn Bhd",
    description: "No dedicated settings in this module yet",
    sections: [],
  },
  {
    title: "System & Access",
    company: "Shared system controls",
    description: "Technical diagnostics and system-wide controls",
    sections: [
      // Deliberately not flag-gated: diagnostics must remain reachable when flags fail.
      { title: "Feature Flags", href: "/settings/feature-flags", icon: Flag, minRole: "manager", permission: "settings.view" },
    ],
  },
];

const SECTIONS: NavItem[] = SETTINGS_DEPARTMENTS.flatMap((department) => department.sections);

function isSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const role = user?.role;
  const allowedDepartments = SETTINGS_DEPARTMENTS.map((department) => ({
    ...department,
    sections: department.sections.filter((section) => canSeeNavItemFor(role, section, user?.permissions)),
  }));
  const allowed = allowedDepartments.flatMap((department) => department.sections);

  if (allowed.length === 0) {
    return <Navigate to="/dashboard" replace />;
  }

  if (pathname === "/settings" || pathname === "/settings/") {
    return <Navigate to={allowed[0].href} replace />;
  }

  return (
    <div
      data-testid="settings-layout"
      className="grid min-h-[calc(100vh-8rem)] w-full max-w-none grid-cols-1 gap-5 md:grid-cols-[18rem_minmax(0,1fr)] md:gap-7"
    >
      <aside className="w-full min-w-0 md:border-r md:border-border/50 md:pr-5">
        <div className="mb-4 px-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#9A742B]">Settings</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Organised by KAEN business department.
          </p>
        </div>
        <nav
          aria-label="Settings sections"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:flex md:flex-col"
        >
          {allowedDepartments.map((department) => {
            const hasVisibleSections = department.sections.length > 0;
            return (
              <section
                key={department.title}
                className="rounded-xl border border-[#9DAFC1]/65 bg-white/70 p-2 shadow-[0_2px_8px_rgba(8,47,85,0.05)]"
              >
                <div className="px-2 pb-2 pt-1">
                  <h2 className="text-sm font-bold text-[#082B4F]">{department.title}</h2>
                  <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#9A742B]">
                    {department.company}
                  </p>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{department.description}</p>
                </div>

                {hasVisibleSections ? (
                  <div className="space-y-1">
                    {department.sections.map((section) => {
                      const active = isSectionActive(pathname, section.href);
                      return (
                        <Link
                          key={section.href}
                          to={section.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all",
                            active
                              ? "bg-[#082F55] text-[#F3D493] shadow-sm"
                              : "text-[#082B4F] hover:bg-[#DFE9F3]",
                          )}
                        >
                          <section.icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" />
                          <span>{section.title}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg bg-[#F3F6F9] px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                    No settings available yet.
                  </p>
                )}
              </section>
            );
          })}
        </nav>
      </aside>

      <main data-testid="settings-content" className="w-full min-w-0 max-w-none">
        <Outlet />
      </main>
    </div>
  );
}

export { SECTIONS as SETTINGS_SECTIONS };
export { SETTINGS_DEPARTMENTS };
export type { MinRole };
