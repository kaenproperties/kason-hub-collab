import { Dialog } from "@base-ui/react/dialog";
import { Menu, X, LogOut } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { navSections, allNavItems, canSeeNavItemFor, type NavItem } from "./navigation";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string, allItems: NavItem[]): boolean {
  if (href === "/dashboard") return pathname === href;
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  const hasMoreSpecificSibling = allItems.some(
    (other) =>
      other.href !== href &&
      other.href.length > href.length &&
      (pathname === other.href || pathname.startsWith(`${other.href}/`)),
  );
  return !hasMoreSpecificSibling;
}

export function MobileDrawer() {
  const { pathname } = useLocation();
  const { user, clearAuth } = useAuth();
  const navigate = useNavigate();
  const role = user?.role;

  const handleLogout = () => {
    clearAuth();
    navigate("/login");
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] transition hover:bg-[var(--page-bg)] lg:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="h-4 w-4" />
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-[var(--sidebar-bg)] shadow-2xl data-open:animate-in data-open:slide-in-from-left data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-left data-closed:fade-out-0 duration-200">
          <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
            <div className="flex items-center gap-3">
              <img
                src="/logo.png"
                alt="KAEN Properties"
                width={44}
                height={44}
                className="h-11 w-11 rounded-lg object-contain"
              />
              <span className="text-sm font-semibold text-[var(--sidebar-ink)]">KAEN Properties</span>
            </div>
            <Dialog.Close className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--sidebar-muted)] transition hover:bg-white/5 hover:text-[var(--sidebar-ink)]">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <nav className="scrollbar-slim flex-1 overflow-y-auto px-3 py-4">
            {navSections.map((section) => {
              const visibleItems = section.items.filter((item) => canSeeNavItemFor(role, item, user?.permissions));
              if (visibleItems.length === 0) return null;
              return (
              <div key={section.label} className="mb-4">
                <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--sidebar-muted)] opacity-60">
                  {section.label}
                </p>
                <div className="space-y-0.5">
                  {visibleItems.map((item) => {
                    const active = isActive(pathname, item.href, allNavItems);
                    return (
                      <Dialog.Close
                        key={item.href}
                        render={
                          <Link
                            to={item.href}
                            className={cn(
                              "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                              active
                                ? "bg-[var(--sidebar-active-bg)] text-[var(--gold)]"
                                : "text-[var(--sidebar-muted)] hover:bg-white/5 hover:text-[var(--sidebar-ink)]",
                            )}
                          />
                        }
                      >
                        {active && (
                          <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-[var(--gold)]" />
                        )}
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.title}
                      </Dialog.Close>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </nav>

          <div className="border-t border-white/[0.06] p-3">
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--sidebar-muted)] transition hover:bg-white/5 hover:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
