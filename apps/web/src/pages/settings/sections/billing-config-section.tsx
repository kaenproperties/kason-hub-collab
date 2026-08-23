// Settings → Billing Config (M5 Auto-Draft Invoices). Admin CRUD for the single
// DraftBillingConfig row + a "Run now" button that triggers a DraftRun, plus a
// recent-runs table. Non-admin sees the config read-only (no Save / Run now).
//
// Flag-gated: only registered in settings-layout.tsx + router.tsx when
// ENABLE_PHASE2_AUTODRAFT is on. The API mirrors the gate.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Play, RefreshCw, Settings2 } from "lucide-react";
import {
  PHASE2_STATUS_TONES,
  BILL_PERIOD_CHOICES,
  addMonthsToYm,
  describeBillPeriodOffset,
  AUTO_BILL_DAY_MAX,
  AUTO_BILL_DAY_MIN,
} from "@kason/shared";
import {
  PageHeader,
  Surface,
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Field, RadioField, TextInput } from "@/components/form-ui";
import { apiFetch, ApiError } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { ChargeCategoriesPanel } from "./charge-categories-panel";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DraftBillingConfig {
  id: string;
  runDayOfMonth: number;
  billPeriodOffset: number;
  /** Day drafts are auto-BILLED. null = off; a human issues from the queue. */
  autoBillDayOfMonth: number | null;
  dueDayOffset: number | null;
  includeRent: boolean;
  includeElectricity: boolean;
  includeMgmtFee: boolean;
  includeCleaning: boolean;
  isActive: boolean;
  autoApprove: boolean;
  updatedAt: string;
}

interface DraftRun {
  id: string;
  periodMonth: string; // "YYYY-MM"
  runDate: string;     // ISO date-time
  created: number;
  skipped: number;
  status: "running" | "completed" | "failed";
  errorText: string | null;
}

interface DraftRunSummary {
  id: string;
  periodMonth: string;
  created: number;
  skipped: number;
  status: "running" | "completed" | "failed";
}

// ─── Query keys ───────────────────────────────────────────────────────────────

const CONFIG_QK = ["billing", "draft-config"] as const;
const RUNS_QK   = ["billing", "draft-runs"]   as const;

// ─── API helpers ──────────────────────────────────────────────────────────────

function fetchConfig(): Promise<DraftBillingConfig> {
  return apiFetch<DraftBillingConfig>("/billing/draft-config");
}

function createConfig(defaults: Partial<DraftBillingConfig>): Promise<DraftBillingConfig> {
  return apiFetch<DraftBillingConfig>("/billing/draft-config", {
    method: "POST",
    body: JSON.stringify(defaults),
  });
}

function patchConfig(
  id: string,
  fields: Partial<DraftBillingConfig> & { expectedUpdatedAt: string },
): Promise<DraftBillingConfig> {
  return apiFetch<DraftBillingConfig>(`/billing/draft-config/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

function triggerRun(periodMonth: string): Promise<DraftRunSummary> {
  return apiFetch<DraftRunSummary>("/billing/draft-runs", {
    method: "POST",
    body: JSON.stringify({ periodMonth }),
  });
}

function fetchRuns(): Promise<{ data: DraftRun[] }> {
  return apiFetch<{ data: DraftRun[] }>("/billing/draft-runs?limit=20");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Current period in "YYYY-MM" format. */
function currentPeriodMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * The period a run started NOW would draft, honouring the org's advance offset.
 * "Run now" MUST use this rather than the current month: with offset 1 the cron
 * drafts next month, so a Run-now that targeted the current month would produce a
 * different period than the schedule it is supposed to be previewing.
 */
function targetPeriodMonth(config: DraftBillingConfig | null): string {
  return addMonthsToYm(currentPeriodMonth(), config?.billPeriodOffset ?? 1);
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-MY", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Toggle row ───────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border/50 bg-background/40 px-4 py-3">
      <span className="text-sm text-foreground">{label}</span>
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
    </label>
  );
}

// ─── Default config values ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  runDayOfMonth: 25,
  // 1 = bill NEXT month, matching KAEN's "issue on the 25th for the coming month".
  billPeriodOffset: 1,
  // null = auto-billing OFF. Creating a schedule must never, on its own, start
  // posting live receivables — that is a separate, deliberate decision.
  autoBillDayOfMonth: null,
  dueDayOffset: null,
  includeRent: true,
  includeElectricity: true,
  includeMgmtFee: true,
  includeCleaning: true,
  isActive: true,
};

// ─── Config form (edit) ───────────────────────────────────────────────────────

interface ConfigFormState {
  runDayOfMonth: string;
  billPeriodOffset: number;
  /** "" = auto-billing off (mirrors dueDayOffset's blank-means-null convention). */
  autoBillDayOfMonth: string;
  dueDayOffset: string;
  includeRent: boolean;
  includeElectricity: boolean;
  includeMgmtFee: boolean;
  includeCleaning: boolean;
  isActive: boolean;
}

function configToForm(c: DraftBillingConfig): ConfigFormState {
  return {
    runDayOfMonth: String(c.runDayOfMonth),
    billPeriodOffset: c.billPeriodOffset,
    autoBillDayOfMonth: c.autoBillDayOfMonth == null ? "" : String(c.autoBillDayOfMonth),
    dueDayOffset: c.dueDayOffset == null ? "" : String(c.dueDayOffset),
    includeRent: c.includeRent,
    includeElectricity: c.includeElectricity,
    includeMgmtFee: c.includeMgmtFee,
    includeCleaning: c.includeCleaning,
    isActive: c.isActive,
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BillingConfigSection() {
  const canWrite = usePermission("settings.manage");
  const qc = useQueryClient();
  // The category registry lives behind its own flag (the /charge-categories API 404s
  // while ENABLE_PHASE2_BILLING_DOCS is dark), independent of this page's AUTODRAFT gate.
  const categoriesOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");

  // Config query — treat 404 as "no config yet" (empty state)
  const configQuery = useQuery<DraftBillingConfig | null, ApiError>({
    queryKey: CONFIG_QK,
    queryFn: async () => {
      try {
        return await fetchConfig();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  // Runs query
  const runsQuery = useQuery({
    queryKey: RUNS_QK,
    queryFn: fetchRuns,
  });

  // Local form state (mirrors server on load, editable)
  const [form, setForm] = useState<ConfigFormState | null>(null);
  const [editing, setEditing] = useState(false);

  // Sync form when config loads (first time only)
  const config = configQuery.data ?? null;
  if (config && form === null) {
    setForm(configToForm(config));
  }

  // "Run now" confirm dialog
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  // Create config mutation
  const createMutation = useMutation({
    mutationFn: () => createConfig(DEFAULT_CONFIG),
    onSuccess: (data) => {
      qc.setQueryData(CONFIG_QK, data);
      setForm(configToForm(data));
      toast.success("Billing config created.");
    },
    onError: (err: ApiError) => toast.error(err.message),
  });

  // Patch config mutation
  const patchMutation = useMutation({
    mutationFn: (fields: Partial<DraftBillingConfig> & { expectedUpdatedAt: string }) => {
      if (!config) throw new Error("No config loaded");
      return patchConfig(config.id, fields);
    },
    onSuccess: (data) => {
      qc.setQueryData(CONFIG_QK, data);
      setForm(configToForm(data));
      setEditing(false);
      toast.success("Billing config saved.");
    },
    onError: (err: ApiError) => {
      if (err.status === 409) {
        toast.error("Config changed since you loaded it — refresh to see the latest.");
      } else {
        toast.error(err.message);
      }
    },
  });

  // Trigger run mutation
  const runMutation = useMutation({
    mutationFn: () => triggerRun(targetPeriodMonth(config)),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: RUNS_QK });
      toast.success(
        `Draft run started — ${data.created} created, ${data.skipped} skipped.`,
      );
      setRunDialogOpen(false);
    },
    onError: (err: ApiError) => {
      toast.error(err.message);
      setRunDialogOpen(false);
    },
  });

  function handleSave() {
    if (!form || !config) return;
    const runDay = parseInt(form.runDayOfMonth, 10);
    const dueOff = form.dueDayOffset === "" ? null : parseInt(form.dueDayOffset, 10);
    // Blank = null = auto-billing off. Trimmed first so a field holding only
    // whitespace turns billing OFF rather than PATCHing NaN at the money gate.
    const autoBillRaw = form.autoBillDayOfMonth.trim();
    const autoBillDay = autoBillRaw === "" ? null : parseInt(autoBillRaw, 10);
    patchMutation.mutate({
      runDayOfMonth: runDay,
      billPeriodOffset: form.billPeriodOffset,
      autoBillDayOfMonth: autoBillDay,
      dueDayOffset: dueOff,
      includeRent: form.includeRent,
      includeElectricity: form.includeElectricity,
      includeMgmtFee: form.includeMgmtFee,
      includeCleaning: form.includeCleaning,
      isActive: form.isActive,
      expectedUpdatedAt: config.updatedAt,
    });
  }

  function handleDiscardEdits() {
    if (config) setForm(configToForm(config));
    setEditing(false);
  }

  // ── Render states ──────────────────────────────────────────────────────────

  if (configQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-16 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  // The charge-category registry is rendered even when the draft-config fetch fails:
  // this page is now its ONLY surface (the standalone /settings/charge-categories route
  // redirects here), so an unrelated /billing/draft-config error must not make the
  // category list unreachable.
  if (configQuery.isError) {
    return (
      <div className="space-y-6">
        <Callout variant="danger" title="Couldn't load billing config">
          Failed to load billing config. Please refresh.
        </Callout>
        {categoriesOn && <ChargeCategoriesPanel />}
      </div>
    );
  }

  const runs = runsQuery.data?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader
        title="Billing Config"
        icon={Settings2}
        description={
          canWrite
            ? "Auto-draft invoice schedule and inclusions. Admin only to edit."
            : "Auto-draft invoice schedule and inclusions. Read-only for your role."
        }
        actions={
          canWrite && config ? (
            <Button
              variant="gold"
              onClick={() => setRunDialogOpen(true)}
              disabled={runMutation.isPending}
            >
              <Play className="h-4 w-4" />
              Run now
            </Button>
          ) : undefined
        }
      />

      {/* ── Config panel ── */}
      {config === null ? (
        /* No config yet */
        <Surface title="No billing config">
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">
              No billing config has been created yet. Create one to enable auto-draft invoice
              generation.
            </p>
            {canWrite && (
              <Button
                variant="gold"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> Creating…
                  </>
                ) : (
                  "Create config"
                )}
              </Button>
            )}
          </div>
        </Surface>
      ) : (
        /* Config exists */
        <Surface
          title="Draft schedule"
          description="Controls when invoices are auto-drafted and which charge types to include."
          actions={
            canWrite ? (
              editing ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDiscardEdits}
                    disabled={patchMutation.isPending}
                  >
                    Discard
                  </Button>
                  <Button
                    variant="gold"
                    size="sm"
                    onClick={handleSave}
                    disabled={patchMutation.isPending}
                  >
                    {patchMutation.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )
            ) : undefined
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Draft day — invoices are CREATED. This day bills nobody. */}
            <Field
              label="Draft day of month (1–28)"
              hint="Day each month when drafts are CREATED. Creating a draft charges nobody."
            >
              <TextInput
                type="number"
                min={1}
                max={28}
                value={form?.runDayOfMonth ?? ""}
                disabled={!editing}
                onChange={(e) =>
                  setForm((f) => f && { ...f, runDayOfMonth: e.target.value })
                }
              />
            </Field>

            {/* Auto-bill day — the day drafts BECOME real bills. Blank = off, the
                same blank-means-null convention the due-day offset uses. */}
            <Field
              label={`Auto-bill day of month (${AUTO_BILL_DAY_MIN}–${AUTO_BILL_DAY_MAX})`}
              hint="Day drafts are BILLED automatically: charges go live and tenants see what they owe. Leave blank to require an admin to issue them."
            >
              <TextInput
                type="number"
                min={AUTO_BILL_DAY_MIN}
                max={AUTO_BILL_DAY_MAX}
                placeholder="Blank — admin issues manually"
                value={form?.autoBillDayOfMonth ?? ""}
                disabled={!editing}
                onChange={(e) =>
                  setForm((f) => f && { ...f, autoBillDayOfMonth: e.target.value })
                }
              />
            </Field>

            {/* Bill period — WHICH month the run day drafts (advance billing). */}
            <RadioField
              label="Bill period"
              hint="Which month the run drafts. KAEN issues on the 25th for the coming month → Next month."
              value={form?.billPeriodOffset ?? 1}
              disabled={!editing}
              onChange={(v) => setForm((f) => f && { ...f, billPeriodOffset: v })}
              options={BILL_PERIOD_CHOICES}
            />

            {/* Due offset */}
            <Field
              label="Due day offset"
              hint="Days after run date that payment is due. Leave blank for no due date."
            >
              <TextInput
                type="number"
                min={0}
                placeholder="No due date"
                value={form?.dueDayOffset ?? ""}
                disabled={!editing}
                onChange={(e) =>
                  setForm((f) => f && { ...f, dueDayOffset: e.target.value })
                }
              />
            </Field>
          </div>

          {/* Toggles */}
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <ToggleRow
              label="Include Rent"
              checked={form?.includeRent ?? false}
              onChange={(v) => setForm((f) => f && { ...f, includeRent: v })}
              disabled={!editing}
            />
            <ToggleRow
              label="Include Electricity"
              checked={form?.includeElectricity ?? false}
              onChange={(v) => setForm((f) => f && { ...f, includeElectricity: v })}
              disabled={!editing}
            />
            <ToggleRow
              label="Include Management Fee"
              checked={form?.includeMgmtFee ?? false}
              onChange={(v) => setForm((f) => f && { ...f, includeMgmtFee: v })}
              disabled={!editing}
            />
            <ToggleRow
              label="Include Cleaning"
              checked={form?.includeCleaning ?? false}
              onChange={(v) => setForm((f) => f && { ...f, includeCleaning: v })}
              disabled={!editing}
            />
          </div>

          {/* Active toggle */}
          <div className="mt-2">
            <ToggleRow
              label="Active (schedule is live)"
              checked={form?.isActive ?? false}
              onChange={(v) => setForm((f) => f && { ...f, isActive: v })}
              disabled={!editing}
            />
          </div>

          {/* Who turns drafts into real bills — derived from the SAVED config, not
              the in-progress form, so it always describes what the cron will
              actually do tonight rather than an unsaved edit. This block replaced a
              hardcoded "Auto-approve: Off — all drafted invoices require manual
              admin approval", which became a false statement the moment scheduled
              auto-billing existed. */}
          <div className="mt-4 rounded-lg border border-border/40 bg-background/30 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Who bills the drafts
            </p>
            <p className="mt-1 text-sm text-foreground">
              <span className="inline-flex items-center gap-1.5">
                {config?.autoBillDayOfMonth == null ? (
                  <>
                    <StatusPill tone={PHASE2_STATUS_TONES.invoice.draft}>Manual</StatusPill>
                    <span className="text-muted-foreground">
                      An admin issues drafts from the approvals queue. Nothing is billed
                      automatically.
                    </span>
                  </>
                ) : (
                  <>
                    <StatusPill tone={PHASE2_STATUS_TONES.invoice.approved}>
                      Automatic
                    </StatusPill>
                    <span className="text-muted-foreground">
                      From day {config.autoBillDayOfMonth} each month, drafts are billed
                      without a human check — charges go live and tenants see what they owe.
                    </span>
                  </>
                )}
              </span>
            </p>
          </div>
        </Surface>
      )}

      {/* ── Recent runs panel ── */}
      <Surface
        title="Recent draft runs"
        description="Last 20 auto-draft runs for this organisation."
      >
        {runsQuery.isLoading ? (
          <div className="space-y-2 animate-pulse">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <TableWrap>
            <DataTable>
              <TableHead>
                <tr>
                  <HeadCell>Period</HeadCell>
                  <HeadCell>Run date</HeadCell>
                  <HeadCell>Created</HeadCell>
                  <HeadCell>Skipped</HeadCell>
                  <HeadCell>Status</HeadCell>
                </tr>
              </TableHead>
              <tbody>
                {runs.length === 0 ? (
                  <EmptyRow colSpan={5} label="No draft runs yet." />
                ) : (
                  runs.map((run) => (
                    <Row key={run.id}>
                      <BodyCell>
                        <span className="font-mono text-xs">{run.periodMonth}</span>
                      </BodyCell>
                      <BodyCell>{formatDateTime(run.runDate)}</BodyCell>
                      <BodyCell>{run.created}</BodyCell>
                      <BodyCell>{run.skipped}</BodyCell>
                      <BodyCell>
                        <div className="flex flex-col gap-1">
                          <span
                            className="inline-flex"
                            title={run.status === "failed" && run.errorText ? run.errorText : undefined}
                          >
                            <StatusPill tone={PHASE2_STATUS_TONES.draftRun[run.status]}>
                              {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                            </StatusPill>
                          </span>
                          {run.status === "failed" && run.errorText ? (
                            <span
                              className="inline-flex items-start gap-1 text-xs text-destructive"
                              title={run.errorText}
                            >
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                              <span className="line-clamp-2">{run.errorText}</span>
                            </span>
                          ) : null}
                        </div>
                      </BodyCell>
                    </Row>
                  ))
                )}
              </tbody>
            </DataTable>
          </TableWrap>
        )}
      </Surface>

      {/* ── Charge categories panel ──
          Moved here from the standalone Settings → Charge Categories section so the
          list that feeds every Category dropdown is maintained alongside the rest of
          the billing configuration. */}
      {categoriesOn && <ChargeCategoriesPanel />}

      {/* ── "Run now" confirm dialog ── */}
      <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen} lockProgress={false}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              Trigger draft run for {targetPeriodMonth(config)}?
            </DialogTitle>
            <DialogDescription>
              This drafts invoices for <strong>{targetPeriodMonth(config)}</strong> — the schedule
              bills {describeBillPeriodOffset(config?.billPeriodOffset ?? 1)}.{" "}
              {config?.autoBillDayOfMonth == null ? (
                <>
                  Nothing is billed by this action; each draft requires manual admin approval
                  before it is visible to tenants.
                </>
              ) : (
                <>
                  This action only DRAFTS — but note that auto-billing is on, so from day{" "}
                  {config.autoBillDayOfMonth} these drafts are billed automatically and become
                  visible to tenants without further approval.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <Callout variant="info">
            Drafts can be reviewed and approved individually on the Invoices page. Running twice
            in the same period is safe — already-drafted tenancies will be skipped.
          </Callout>

          <DialogFooter>
            <Button
              variant="gold"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Running…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" /> Run drafts
                </>
              )}
            </Button>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
