import { apiFetch } from "@/lib/api-client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type AdminSession = {
  userId: string;
  id: string;
  fullName: string;
  email: string;
  userType: string;
  partyId: string | null;
  orgId: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
};

export const adminSessionKey = ["admin-auth", "me"] as const;

export async function fetchAdminSession(): Promise<AdminSession> {
  // Backend handler returns the session payload directly (not wrapped in { data }).
  // See apps/api/src/modules/auth/auth.routes.ts → `return c.json(result.data)`.
  return apiFetch<AdminSession>("/auth/me");
}

export function useAdminSession(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminSessionKey,
    queryFn: fetchAdminSession,
    enabled: opts?.enabled ?? true,
    retry: false,
  });
}

export function useChangeAdminPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ ok: boolean; message: string }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminSessionKey }),
  });
}

// ─── Password reset helpers (raw apiFetch — not react-query) ───────────────

export async function adminForgotPassword(email: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function adminVerifyResetToken(token: string): Promise<{ ok: true; fullName: string }> {
  return apiFetch<{ ok: true; fullName: string }>("/auth/verify-reset-token", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function adminResetPassword(token: string, password: string): Promise<{ ok: true; message: string }> {
  return apiFetch<{ ok: true; message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}
