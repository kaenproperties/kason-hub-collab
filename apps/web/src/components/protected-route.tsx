import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { PermissionCode } from "@/lib/permissions";

const ROUTE_PERMISSIONS: readonly [string, PermissionCode][] = [
  ["/billing/tenant-owner-billing", "billing.view"],
  ["/billing/draft-approvals", "billing.view"],
  ["/billing/documents", "accounting.view"],
  ["/accounting/bank-reconciliation", "bank.read"],
  ["/accounting/profitability", "profit.view"],
  ["/accounting/month-end-control", "accounting.view"],
  ["/accounting/employee-expense-claims", "claim.create"],
  ["/accounting/invoices", "accounting.view"],
  ["/accounting/receipts", "accounting.view"],
  ["/tenancy/owner-ledger", "owner_report.view"],
  ["/tenancy/owners/", "owner_report.view"],
  ["/portfolio/property-management-agreements", "agreement.view"],
  ["/tenancy/tenancies", "tenancy.view"],
  ["/parties", "party.view"],
  ["/inventory", "portfolio.view"],
  ["/organization/staff", "roles.manage"],
  ["/settings", "settings.view"],
  ["/audit", "audit.view"],
];

export function requiredPermissionForPath(pathname: string): PermissionCode | undefined {
  return ROUTE_PERMISSIONS.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`) || (prefix.endsWith("/") && pathname.startsWith(prefix)))?.[1];
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (user?.userType && user.userType !== "operator") {
    return <Navigate to="/portal/login" replace />;
  }

  const requiredPermission = requiredPermissionForPath(location.pathname);
  // Fail closed. An older/stale localStorage user can briefly exist without a
  // permissions array while /auth/me refreshes. Letting that state through
  // would make a directly-entered URL visible even though the current user has
  // not been proven to hold the capability.
  if (requiredPermission && !user?.permissions?.includes(requiredPermission)) {
    return <Navigate to="/dashboard" replace state={{ permissionDenied: requiredPermission }} />;
  }

  return <>{children}</>;
}
