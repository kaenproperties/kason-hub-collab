import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, Search } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api-client";
import { SidebarShell } from "@/components/sidebar";
import { DashboardHeader } from "@/components/dashboard-header";
import { MobileNav } from "@/components/dashboard-nav";
import { MobileDrawer } from "@/components/mobile-drawer";
import { UserMenu } from "@/components/user-menu";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SearchCommand } from "@/components/search-command";

export function DashboardLayout() {
  const { user, clearAuth } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isWideOperationalWorkspace = pathname === "/billing/tenant-owner-billing"
    || pathname === "/accounting/bank-reconciliation"
    || pathname === "/accounting/employee-expense-claims";
  const isSettingsWorkspace = pathname === "/settings" || pathname.startsWith("/settings/");

  const handleLogout = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    clearAuth();
    navigate("/login");
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--page-bg)]">
      <SidebarShell />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DashboardHeader leftSlot={<MobileDrawer />}>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] transition hover:bg-[var(--page-bg)]"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] transition hover:bg-[var(--page-bg)]"
          >
            <Bell className="h-4 w-4" />
          </button>
          <UserMenu
            fullName={user?.fullName ?? ""}
            role={user?.role ?? "viewer"}
            profileHref="/account"
            onLogout={handleLogout}
          />
        </DashboardHeader>

        <div className="border-b border-[var(--border)] bg-[var(--card-bg)] px-4 py-2 hidden sm:block lg:hidden">
          <MobileNav />
        </div>

        <Breadcrumbs />

        <main className="flex-1 overflow-y-auto">
          <div
            className={isSettingsWorkspace
              ? "dashboard-content w-full max-w-none space-y-4 overflow-x-hidden px-1 py-3 sm:px-2 lg:px-3 lg:py-4"
              : isWideOperationalWorkspace
                ? "w-full max-w-none space-y-4 overflow-x-hidden px-1 py-3 sm:px-2 lg:px-3 lg:py-4"
                : "dashboard-content mx-auto w-full max-w-[1400px] space-y-5 overflow-x-hidden px-4 py-5 lg:px-6 lg:py-6"}
          >
            <Outlet />
          </div>
        </main>
      </div>

      <SearchCommand />
    </div>
  );
}
