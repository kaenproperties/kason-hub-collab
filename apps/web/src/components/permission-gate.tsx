import { useAuth } from "@/lib/auth";
import type { PermissionCode } from "@/lib/permissions";

export function usePermission(permission: PermissionCode): boolean {
  const { user } = useAuth();
  return user?.permissions?.includes(permission) ?? false;
}

export function PermissionGate({
  permission,
  children,
  fallback = null,
}: {
  permission: PermissionCode;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}
