// Staff — the unified operator-user register (Team hub → Staff tab).
//
// Supersedes the former Managers + Admin pages, which listed the SAME operator
// User entity (/api/users) split by role. This one page fetches every operator
// user and filters by role client-side. Role-tab equivalents:
//   - old "Managers" page  = Role filter → Manager
//   - old "Admin" page     = Role filter → Admin / Editor / Viewer
// Both old URLs redirect here (see router.tsx). Agents (party-side) and the
// Hierarchy tree stay their own surfaces — this page never touches them.
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { PageHeader, Surface, StatusPill } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PermissionGate, usePermission } from "@/components/permission-gate";
import { useUsers } from "@/api/users";
import { useAuth } from "@/lib/auth";
import { AdminFormDrawer } from "./admin-form-drawer";
import { AdminDeactivateDrawer } from "./admin-deactivate-drawer";
import { AdminResetPasswordDrawer } from "./admin-reset-password-drawer";
import { TeamAreaTabs } from "./team-area-tabs";
import type { OperatorUser } from "@/api/users";
import type { DeactivateMode } from "./admin-deactivate-drawer";
import { MoreHorizontalIcon } from "lucide-react";
import { canManageRole } from "@/lib/permissions";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
} from "@/components/ui";

type DrawerState =
  | { kind: "form"; mode: "create" | "edit"; user: OperatorUser | null }
  | { kind: "deactivate"; mode: DeactivateMode; user: OperatorUser }
  | { kind: "resetPassword"; user: OperatorUser }
  | null;

const ROLE_LABELS: Record<string, string> = {
  admin: "Super Admin",
  director: "Director",
  accountant: "Finance",
  manager: "Manager",
  editor: "Operations Admin",
  viewer: "Viewer",
};

const ROLE_TONES: Record<string, "emerald" | "amber" | "sky" | "slate"> = {
  admin: "emerald",
  director: "amber",
  accountant: "sky",
  manager: "amber",
  editor: "sky",
  viewer: "slate",
};

// Role filter chips. "all" first; the rest mirror the four operator roles in
// rank order. Selecting one narrows the register below — e.g. "Manager" is the
// exact view the retired Managers page used to give.
type RoleFilter = "all" | "admin" | "director" | "accountant" | "manager" | "editor" | "viewer";
const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "admin", label: "Super Admin" },
  { id: "director", label: "Director" },
  { id: "accountant", label: "Finance" },
  { id: "manager", label: "Manager" },
  { id: "editor", label: "Operations Admin" },
  { id: "viewer", label: "Viewer" },
];

export default function StaffPage() {
  const { user: session } = useAuth();
  const assignableRoles = (["director", "accountant", "manager", "editor", "viewer"] as const).filter((role) =>
    canManageRole(session?.role, role),
  );
  // Fetch the four operator ROLES the Staff register manages — the exact union
  // the retired Managers + Admin pages covered. Deliberately EXCLUDES the
  // "accountant" capability role (managed via the Accounting workspace, never
  // listed here) so the role-filter chips and the metrics always reconcile with
  // the fetched set — an unfiltered useUsers() would leak an accountant that has
  // no chip, no ROLE_LABELS entry, and no matching Add/Edit-drawer option.
  const users = useUsers({ roles: ["admin", "director", "accountant", "manager", "editor", "viewer"] });
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const canManageUsers = usePermission("roles.manage");
  const canDisableUsers = usePermission("user.disable");
  const canResetPasswords = usePermission("user.reset_password");

  // Metrics describe the WHOLE team (stable regardless of the chip filter);
  // the chips only narrow the register table below.
  const all = users.data?.data ?? [];
  const activeCount = all.filter((u) => u.status === "active").length;
  const list = roleFilter === "all" ? all : all.filter((u) => u.role === roleFilter);

  function closeDrawer() {
    setDrawer(null);
  }

  return (
    <div className="space-y-6">
      <TeamAreaTabs activeTab="staff" />

      <PageHeader
        title="Staff"
        description="Company access roles — Super Admin, Director, Finance, Manager, Operations Admin and Viewer."
        metrics={[
          { label: "Total", value: String(all.length), hint: "Operator login users" },
          { label: "Active", value: String(activeCount), hint: "Can currently log in" },
          { label: "Disabled", value: String(all.filter((u) => u.status === "disabled").length), hint: "Deactivated accounts" },
        ]}
        actions={
          <PermissionGate permission="roles.manage">
            <Button
              variant="gold"
              disabled={drawer !== null || assignableRoles.length === 0}
              onClick={() => setDrawer({ kind: "form", mode: "create", user: null })}
            >
              + Add user
            </Button>
          </PermissionGate>
        }
      />

      <Surface
        title="Operator register"
        description="Staff administration follows the company hierarchy. A user must have the relevant permission and can only manage staff below their own role level."
      >
        <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--page-bg)] px-4 py-3">
          <div className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--text-secondary)]">
            Permission-management hierarchy
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-bold text-[var(--navy-text)]">
            <span className="rounded-full bg-[var(--navy)] px-3 py-1.5 text-white">Super Admin</span>
            <span aria-hidden="true" className="text-[var(--gold)]">→</span>
            <span className="rounded-full border border-[var(--gold)] bg-white px-3 py-1.5">Director</span>
            <span aria-hidden="true" className="text-[var(--gold)]">→</span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1.5">Manager / Finance</span>
            <span aria-hidden="true" className="text-[var(--gold)]">→</span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1.5">Operations Admin</span>
            <span aria-hidden="true" className="text-[var(--gold)]">→</span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1.5">Viewer</span>
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
            Only users with Manage users and permissions can edit staff, and only below their own level. Manager and Finance are the same level and cannot edit each other.
          </p>
        </div>

        {/* Role filter — 'Manager' reproduces the old Managers tab exactly. */}
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by role">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Role</span>
          {ROLE_FILTERS.map((f) => {
            const isActive = roleFilter === f.id;
            const count = f.id === "all" ? all.length : all.filter((u) => u.role === f.id).length;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setRoleFilter(f.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  isActive
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {f.label}
                <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        {users.isLoading ? (
          <div className="space-y-2 animate-pulse">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
            ))}
          </div>
        ) : users.isError ? (
          <p className="p-6 text-sm text-rose-600">Failed to load staff. Please refresh.</p>
        ) : (
          <TableWrap>
            <DataTable>
              <TableHead>
                <tr>
                  <HeadCell>Name</HeadCell>
                  <HeadCell>Email</HeadCell>
                  <HeadCell>Role</HeadCell>
                  <HeadCell>Status</HeadCell>
                  <HeadCell className="text-right">Actions</HeadCell>
                </tr>
              </TableHead>
              <tbody>
                {list.length === 0 ? (
                  <EmptyRow
                    colSpan={5}
                    label={
                      roleFilter === "all"
                        ? "No staff users yet. Click + Add user to create one."
                        : `No ${ROLE_LABELS[roleFilter] ?? roleFilter} users.`
                    }
                  />
                ) : (
                  list.map((user) => {
                    const isSelf = session?.id === user.id;
                    const canManageThisUser = !isSelf && canManageRole(session?.role, user.role);
                    return (
                      <Row key={user.id}>
                        <BodyCell>
                          <div className="flex items-center gap-3">
                            <Avatar src={user.photoUrl ?? null} name={user.fullName} size="sm" />
                            <span className="font-medium text-[var(--text-primary)]">
                              {user.fullName}
                              {isSelf && (
                                <span className="ml-2 text-xs text-[var(--text-muted)]">(you)</span>
                              )}
                            </span>
                          </div>
                        </BodyCell>
                        <BodyCell>{user.email}</BodyCell>
                        <BodyCell>
                          <StatusPill tone={ROLE_TONES[user.role] ?? "slate"}>
                            {ROLE_LABELS[user.role] ?? user.role}
                          </StatusPill>
                        </BodyCell>
                        <BodyCell>
                          <StatusPill tone={user.status === "active" ? "emerald" : "slate"}>
                            {user.status === "active" ? "Active" : "Disabled"}
                          </StatusPill>
                        </BodyCell>
                        <BodyCell className="text-right">
                          {/* Admin-tier rows are managed out-of-band (glossary): no UI mutation. */}
                          {canManageThisUser && (canManageUsers || canDisableUsers || canResetPasswords) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                aria-label={`Actions for ${user.fullName}`}
                                className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreHorizontalIcon className="h-4 w-4" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {canManageUsers && (
                                  <DropdownMenuItem
                                    onClick={() => setDrawer({ kind: "form", mode: "edit", user })}
                                  >
                                    Edit
                                  </DropdownMenuItem>
                                )}

                                {canDisableUsers && (
                                  user.status === "active" ? (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        setDrawer({ kind: "deactivate", mode: "deactivate", user })
                                      }
                                      className="text-rose-600 data-highlighted:bg-rose-500/10 data-highlighted:text-rose-700"
                                    >
                                      Deactivate
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        setDrawer({ kind: "deactivate", mode: "activate", user })
                                      }
                                    >
                                      Activate
                                    </DropdownMenuItem>
                                  )
                                )}

                                {canResetPasswords && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => setDrawer({ kind: "resetPassword", user })}
                                    >
                                      Reset password
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </BodyCell>
                      </Row>
                    );
                  })
                )}
              </tbody>
            </DataTable>
          </TableWrap>
        )}
      </Surface>

      <AdminFormDrawer
        open={drawer?.kind === "form"}
        mode={drawer?.kind === "form" ? drawer.mode : "create"}
        user={drawer?.kind === "form" ? drawer.user : null}
        availableRoles={assignableRoles}
        onClose={closeDrawer}
      />

      {drawer?.kind === "deactivate" && (
        <AdminDeactivateDrawer open mode={drawer.mode} user={drawer.user} onClose={closeDrawer} />
      )}

      {drawer?.kind === "resetPassword" && (
        <AdminResetPasswordDrawer open user={drawer.user} onClose={closeDrawer} />
      )}
    </div>
  );
}
