import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput, SelectInput } from "@/components/form-ui";
import { apiFetch, ApiError } from "@/lib/api-client";
import { useCreateUser, useUpdateUser, useSetPartyUpline } from "@/api/users";
import type { OperatorUser, CreateUserInput, UpdateUserInput } from "@/api/users";
import { PERMISSION_GROUPS, effectivePermission, permissionCanBeGrantedToRole, roleHasPermission, type PermissionCode, type PermissionOverrides } from "@/lib/permissions";

export type AdminFormMode = "create" | "edit";

type Props = {
  open: boolean;
  mode: AdminFormMode;
  user: OperatorUser | null;
  onClose: () => void;
  forcedRole?: StaffAssignableRole;
  availableRoles?: StaffAssignableRole[];
};

type StaffAssignableRole = "director" | "accountant" | "manager" | "editor" | "viewer";

type FormState = {
  fullName: string;
  email: string;
  role: StaffAssignableRole;
  password: string;
  showPassword: boolean;
  uplineId: string | null;
  uplineDisplayName: string;
  permissionOverrides: PermissionOverrides;
};

// Slim shape from /parties/assignable — must match the agent-form-drawer's
// SlimAgent so the picker stays consistent across the two surfaces.
type SlimUpline = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  partyType: string | null;
  status: string;
};

const UPLINE_SUBLABEL: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};

function uplineSubLabel(row: SlimUpline): string {
  if (row.partyType === "agent") {
    return row.agentLevel ? (UPLINE_SUBLABEL[row.agentLevel] ?? row.agentLevel) : "agent";
  }
  return "staff";
}

function useDebounced<T>(value: T, ms: number): T {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dv;
}

// Inline typeahead — separate from the AgentTypeahead in agent-form-drawer
// to keep that file's import surface stable. Same endpoint, same shape.
function UplineTypeahead({
  value,
  displayName,
  excludeId,
  onSelect,
  onClear,
}: {
  value: string | null;
  displayName: string;
  excludeId?: string;
  onSelect: (id: string, name: string) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(displayName);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q, 300);
  const results = useQuery({
    queryKey: ["upline-typeahead", dq],
    queryFn: () =>
      apiFetch<{ data: SlimUpline[] }>(
        `/parties/assignable?q=${encodeURIComponent(dq)}&partyType=agent,individual&take=20`,
      ),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  });
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const options = (results.data?.data ?? []).filter((a) => a.id !== excludeId);
  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value ? displayName : q}
          readOnly={!!value}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!value) setOpen(true);
          }}
          placeholder="Search by name…"
          className="h-9 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Clear
          </button>
        )}
      </div>
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg py-1">
          {options.map((o) => (
            <li
              key={o.id}
              onMouseDown={() => {
                onSelect(o.id, o.displayName);
                setQ(o.displayName);
                setOpen(false);
              }}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-[var(--muted)] text-[var(--text-primary)]"
            >
              <div className="font-medium">{o.displayName}</div>
              <div className="text-xs text-[var(--text-muted)] capitalize">{uplineSubLabel(o)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type FormErrors = Partial<Record<keyof Omit<FormState, "showPassword">, string>>;

const ALL_ROLE_OPTIONS: { value: StaffAssignableRole; label: string }[] = [
  { value: "director", label: "Director" },
  { value: "accountant", label: "Finance" },
  { value: "manager", label: "Manager" },
  { value: "editor", label: "Operations Admin" },
  { value: "viewer", label: "Viewer" },
];

function blankForm(forcedRole?: StaffAssignableRole): FormState {
  return {
    fullName: "",
    email: "",
    role: forcedRole ?? "editor",
    password: "",
    showPassword: false,
    uplineId: null,
    uplineDisplayName: "",
    permissionOverrides: {},
  };
}

export function AdminFormDrawer({ open, mode, user, onClose, forcedRole, availableRoles }: Props) {
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const setUpline = useSetPartyUpline();

  const effectiveRoleOptions = availableRoles?.length
    ? ALL_ROLE_OPTIONS.filter((o) => availableRoles!.includes(o.value))
    : ALL_ROLE_OPTIONS;
  const isForcedRole = !!forcedRole;

  const [form, setForm] = useState<FormState>(() => blankForm(forcedRole));
  const [errors, setErrors] = useState<FormErrors>({});
  const [permissionSearch, setPermissionSearch] = useState("");
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    if (open) {
      if (mode === "edit" && user) {
        const editRole = forcedRole ?? ((user.role === "admin" ? "editor" : (user.role as StaffAssignableRole)));
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
        setForm({
          fullName: user.fullName,
          email: user.email,
          role: editRole,
          password: "",
          showPassword: false,
          uplineId: user.party?.uplineId ?? null,
          uplineDisplayName: user.party?.upline?.displayName ?? "",
          permissionOverrides: user.permissionOverrides ?? {},
        });
      } else {
        setForm(blankForm(forcedRole));
      }
      setErrors({});
      setSubmitError("");
      setPermissionSearch("");
    }
  }, [open, mode, user?.id, forcedRole]);

  function set<K extends keyof FormState>(field: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value as FormState[K];
      setForm((prev) => ({ ...prev, [field]: value }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field as keyof FormErrors];
        return next;
      });
    };
  }

  const isPending = createUser.isPending || updateUser.isPending;

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.fullName.trim()) errs.fullName = "Full name is required.";
    if (mode === "create") {
      if (!form.email.trim()) errs.email = "Email is required.";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = "Invalid email address.";
      if (!form.password) errs.password = "Password is required.";
      else if (form.password.length < 6) errs.password = "Password must be at least 6 characters.";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (mode === "create") {
      const input: CreateUserInput = {
        fullName: form.fullName.trim(),
        email: form.email.trim().toLowerCase(),
        role: form.role,
        password: form.password,
        permissionOverrides: form.permissionOverrides,
      };
      setSubmitError("");
      createUser.mutate(input, {
        onSuccess: onClose,
        onError: (error) => {
          setSubmitError(
            error instanceof ApiError
              ? error.message
              : "The user could not be created. Please check the details and try again.",
          );
        },
      });
    } else if (user) {
      const input: UpdateUserInput & { id: string } = {
        id: user.id,
        fullName: form.fullName.trim(),
        role: form.role,
        permissionOverrides: form.permissionOverrides,
      };
      // Detect upline change against the snapshot, then fire BOTH mutations.
      // The upline call goes to /parties/:partyId/upline (the User PATCH
      // doesn't accept uplineId by design — it's a Party concern).
      const originalUplineId = user.party?.uplineId ?? null;
      const uplineChanged = form.uplineId !== originalUplineId;
      setSubmitError("");
      updateUser.mutate(input, {
        onSuccess: () => {
          if (uplineChanged && user.partyId) {
            setUpline.mutate(
              { partyId: user.partyId, uplineId: form.uplineId },
              { onSuccess: onClose, onError: onClose },
            );
          } else {
            onClose();
          }
        },
        onError: (error) => {
          setSubmitError(
            error instanceof ApiError
              ? error.message
              : "The permissions could not be saved. Please try again.",
          );
        },
      });
    }
  }

  const title = mode === "create" ? "Add staff user" : "Edit staff user";
  const description =
    mode === "create"
      ? "Create a new operator user account."
      : `Edit ${user?.fullName ?? "user"}'s details.`;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="screen"
      title={title}
      description={description}
      onSubmit={handleSubmit}
      submit={{
        label: mode === "create" ? "Create user" : "Save changes",
        pendingLabel: mode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4">
        {submitError && (
          <Callout variant="danger" title={mode === "create" ? "User not created" : "Changes not saved"}>
            {submitError}
          </Callout>
        )}

        <Field label="Full name">
          <TextInput
            value={form.fullName}
            onChange={set("fullName")}
            placeholder="e.g. Jane Smith"
            required
            autoFocus={mode === "create"}
          />
          {errors.fullName && <p className="mt-1 text-xs text-rose-500">{errors.fullName}</p>}
        </Field>

        {mode === "create" && (
          <Field label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="user@example.com"
              required
            />
            {errors.email && <p className="mt-1 text-xs text-rose-500">{errors.email}</p>}
          </Field>
        )}

        <Field label="Role">
          {isForcedRole ? (
            <div className="rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm font-medium">
              {ALL_ROLE_OPTIONS.find((o) => o.value === forcedRole)?.label}
            </div>
          ) : (
            <SelectInput value={form.role} onChange={set("role")}>
              {effectiveRoleOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          )}
          {errors.role && <p className="mt-1 text-xs text-rose-500">{errors.role}</p>}
        </Field>

        <div className="rounded-xl border border-[var(--gold)]/60 bg-[#FFF9EC] p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-bold text-[var(--navy-text)]">Detailed custom permissions</h3>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">Every checkbox controls one specific business action. Role defaults apply until you customise this user.</p>
            </div>
            {Object.keys(form.permissionOverrides).length > 0 && (
              <button type="button" className="rounded-lg border border-[var(--gold)] bg-white px-3 py-1.5 text-xs font-bold text-[var(--navy-text)]" onClick={() => setForm((old) => ({ ...old, permissionOverrides: {} }))}>Reset to role defaults</button>
            )}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
            <input
              type="search"
              value={permissionSearch}
              onChange={(event) => setPermissionSearch(event.target.value)}
              placeholder="Search permissions, e.g. bill, bank, delete…"
              className="h-10 rounded-lg border border-[var(--border)] bg-white px-3 text-sm text-[var(--navy-text)] outline-none focus:border-[var(--gold)]"
            />
            <div className="text-xs font-bold text-[var(--text-secondary)]">
              {PERMISSION_GROUPS.reduce((total, item) => total + item.items.length, 0)} permissions · {Object.keys(form.permissionOverrides).length} customised
            </div>
          </div>
          <div className="mt-3 columns-1 gap-3 lg:columns-3 2xl:columns-4">
            {PERMISSION_GROUPS.map((group) => ({
              ...group,
              items: group.items.filter(([, label, description]) => `${group.group} ${label} ${description}`.toLowerCase().includes(permissionSearch.trim().toLowerCase())),
            })).filter((group) => group.items.length > 0).map((group) => (
              <section key={group.group} className="mb-3 break-inside-avoid overflow-hidden rounded-lg border border-[var(--border)] bg-white">
                <div className="flex items-center justify-between bg-[var(--table-header)] px-3 py-2 text-xs font-extrabold uppercase tracking-wide text-[var(--navy-text)]">
                  <span>{group.group}</span><span>{group.items.length}</span>
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {group.items.map(([code, label, description, sensitive]) => {
                    const defaultOn = roleHasPermission(form.role, code);
                    const enabled = effectivePermission(form.role, form.permissionOverrides, code);
                    const customised = typeof form.permissionOverrides[code] === "boolean";
                    const roleLocked = !permissionCanBeGrantedToRole(form.role, code);
                    return <label key={code} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-[var(--page-bg)]">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={roleLocked}
                        onChange={(event) => setForm((old) => {
                          const next = { ...old.permissionOverrides };
                          if (event.target.checked === defaultOn) delete next[code as PermissionCode];
                          else next[code as PermissionCode] = event.target.checked;
                          return { ...old, permissionOverrides: next };
                        })}
                        className="h-4 w-4 shrink-0 accent-[var(--navy)] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-[var(--navy-text)]">{label}{sensitive && <span className="rounded bg-rose-50 px-1 py-0.5 text-[8px] font-extrabold uppercase text-rose-700">Sensitive</span>}</span>
                        <span className="block text-[10px] leading-tight text-[var(--text-secondary)]">{description}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${customised ? "bg-[var(--gold-soft)] text-[var(--navy-text)]" : "bg-slate-100 text-slate-600"}`}>
                        {roleLocked ? "Role restricted" : customised ? (enabled ? "Individually granted" : "Individually blocked") : (defaultOn ? "Role default" : "Not included")}
                      </span>
                    </label>;
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        {mode === "edit" && user?.partyId && (
          <Field label="Upline" hint="Who this user reports to in the org chart. Pick any agent or staff member.">
            <UplineTypeahead
              value={form.uplineId}
              displayName={form.uplineDisplayName}
              excludeId={user.partyId}
              onSelect={(id, name) =>
                setForm((prev) => ({ ...prev, uplineId: id, uplineDisplayName: name }))
              }
              onClear={() => setForm((prev) => ({ ...prev, uplineId: null, uplineDisplayName: "" }))}
            />
          </Field>
        )}

        {mode === "create" && (
          <>
            <Callout variant="info">
              This is a temporary password. The user will be required to change it on first login.
            </Callout>

            <Field label="Temporary password">
              <div className="relative">
                <TextInput
                  type={form.showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={set("password")}
                  placeholder="Minimum 6 characters"
                  required
                  className="pr-24"
                />
                <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                    onClick={() => setForm((prev) => ({ ...prev, showPassword: !prev.showPassword }))}
                  >
                    {form.showPassword ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                    onClick={() => {
                      if (form.password) {
                        void navigator.clipboard.writeText(form.password);
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
              {errors.password && <p className="mt-1 text-xs text-rose-500">{errors.password}</p>}
            </Field>
          </>
        )}
      </div>
    </FormDrawer>
  );
}
