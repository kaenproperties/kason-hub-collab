// Bills & Expenses Grid — recurring settings editor (recurring-charges, Task 7). Renders as a
// section inside the unit Setting drawer. Manager-only mutations; every save runs preview →
// confirm → apply (the server re-checks every syncability guard and applies atomically block-all).
//
// All controls are type="button" — this section lives inside the SettingDrawer's <form>, so a
// naked submit button would fire the bearer-config Save. Nothing here mutates until the admin
// confirms in the modal; a 409 surfaces the per-period conflicts and never claims success.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { usePermission } from "@/components/permission-gate";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { formatMoney } from "@/components/format";
import { GRID_QUERY_KEY_ROOT } from "@/api/bills-grid";
import {
  applyRecurring,
  listRecurring,
  previewRecurring,
  isRecurringConflict,
  RECURRING_QUERY_KEY_ROOT,
  type RecurringConflictError,
} from "@/api/bills-grid-recurring";
import type { RecurringPreview, RecurringUpsertInput } from "@kason/shared";

type Bearer = "owner" | "tenant";
// Full recurringKind union from the shared schema — the list DTO now carries scalar kinds
// (TNB/AIR/MAINTENANCE) too, and narrowing here is what hid the Maintenance leak from tsc.
type Kind = RecurringUpsertInput["kind"];
type Nature = "expense" | "profit";

const BEARER_OPTIONS: SegmentedOption<Bearer>[] = [
  { value: "owner", label: "Owner" },
  { value: "tenant", label: "Tenant" },
];
const KIND_OPTIONS: SegmentedOption<Kind>[] = [
  { value: "CLEANING", label: "Cleaning" },
  { value: "WIFI", label: "WiFi" },
  { value: "CUSTOM", label: "Custom" },
];
// Order mirrors settings/sections/charge-categories-section.tsx's category-level
// Profit/Expense dropdown, so the vocabulary reads the same across both surfaces.
const NATURE_OPTIONS: SegmentedOption<Nature>[] = [
  { value: "profit", label: "Profit" },
  { value: "expense", label: "Expense" },
];
/** Fail-closed default (spec R5): the API 422s NATURE_REQUIRED if `nature` is omitted while
 * ENABLE_CHARGE_NATURE_ROUTING is ON — so a new/edited draft must always resolve to a
 * concrete nature, never undefined.
 *
 * Kind-aware:
 *  • Cleaning IS owner REVENUE billed on the Owner Invoice (IVOWN) — the LOCKED redesign
 *    decision "IVOWN = mgmt + cleaning only" — so it defaults to Profit (stays a line on
 *    IVOWN). Expense would divert it off the invoice into an owner-rent deduction (and, since
 *    the deduction is only materialised on a later owner-ledger sync, make it silently vanish
 *    from the owner's billing at Bill time).
 *  • WiFi is a cost the owner bears (NOT an IVOWN line under that same decision) → Expense.
 *  • Custom recurring fees can be a genuine KAEN charge → Profit (also the fallback for any
 *    unrecognized kind). */
export function defaultNatureForKind(kind: Kind): Nature {
  return kind === "WIFI" ? "expense" : "profit";
}

/** Current month as YYYY-MM (the month-input default). */
function thisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
const isValidMoney = (raw: string) => /^\d+(\.\d{1,2})?$/.test(raw.trim());

type Draft = { definitionId?: string; kind: Kind; name: string; amount: string; bearer: Bearer; nature: Nature; effectiveFromMonth: string; enabled: boolean };

function emptyDraft(): Draft {
  return { kind: "CUSTOM", name: "", amount: "", bearer: "owner", nature: defaultNatureForKind("CUSTOM"), effectiveFromMonth: thisMonth(), enabled: true };
}

export function RecurringSettings({ apartmentId }: { apartmentId: string }) {
  const canEditCharges = usePermission("billing.charge.edit");
  const queryClient = useQueryClient();
  // Presentation-only gate (Task 9): flag OFF renders no Nature control and the apply body
  // omits `nature` entirely — byte-identical to pre-feature behavior.
  const natureRoutingOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");

  const listQuery = useQuery({
    queryKey: [...RECURRING_QUERY_KEY_ROOT, "defs", apartmentId],
    queryFn: () => listRecurring(apartmentId),
  });
  /**
   * CUSTOM only (2026-07-31; hardened 2026-08-06). Every SCALAR kind — Cleaning, WiFi,
   * TNB, AIR, Maintenance — is fully owned by the unit's own row in the drawer above:
   * that row carries the bearer/pattern, the recurring tick AND the amount, and saves
   * through `applyRecurring`, the SAME definition API this list writes to. Listing them
   * here again showed one definition as two entries ("two cleaning"; then 2026-08-06 the
   * client hit the same duplicate with Maintenance), which reads as a duplicate charge on
   * a money screen. Allow-list, not a deny-list of kind names — a future scalar kind is
   * excluded automatically instead of leaking until someone extends a hardcoded pair.
   *
   * Display-only: the definitions still exist, still bill, and are still editable — from
   * the row above, which is their single surface. Nothing is archived or deleted, so
   * flipping this filter back restores the old view exactly.
   */
  const definitions = useMemo(
    () =>
      (listQuery.data?.definitions ?? []).filter(
        (d) => !d.archivedAt && d.kind === "CUSTOM",
      ),
    [listQuery.data],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<RecurringPreview | null>(null);
  const [conflicts, setConflicts] = useState<RecurringPreview["conflicts"] | null>(null);

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  // Kind selector is only enabled for a brand-new draft (disabled once definitionId is set —
  // see the Segmented below), so re-deriving nature here never clobbers a saved definition's
  // stored value; it only re-seeds the still-unsaved selector to match whichever kind is
  // currently chosen.
  const setKind = (kind: Kind) => setDraft((prev) => (prev ? { ...prev, kind, nature: defaultNatureForKind(kind) } : prev));

  const upsertBody = (d: Draft): RecurringUpsertInput => ({
    definitionId: d.definitionId,
    kind: d.kind,
    name: d.name.trim() || (d.kind === "CLEANING" ? "Cleaning" : d.kind === "WIFI" ? "WiFi" : "Recurring charge"),
    amount: Number(d.amount).toFixed(2),
    bearer: d.bearer,
    effectiveFromMonth: `${d.effectiveFromMonth}-01`,
    enabled: d.enabled,
  });

  const previewMutation = useMutation({
    mutationFn: (d: Draft) => previewRecurring(apartmentId, upsertBody(d)),
    onSuccess: (data) => { setPreview(data); setConflicts(null); },
    onError: (err: Error) => toast.error(err.message || "Preview failed."),
  });

  const applyMutation = useMutation({
    // `nature` is a route-local extension of the shared apply body (bills-grid-recurring.ts) —
    // only wired in when the flag is ON, so a flag-OFF apply is byte-identical to pre-Task-9.
    // When ON, draft.nature is always concrete (Segmented has no unset state; emptyDraft/the
    // read-back below both seed it) so this never sends `nature: undefined` — the API 422s
    // NATURE_REQUIRED on that (routes.ts).
    mutationFn: (d: Draft) => applyRecurring(apartmentId, { ...upsertBody(d), confirm: true, ...(natureRoutingOn ? { nature: d.nature } : {}) }),
    onSuccess: (res) => {
      toast.success(`Applied to ${res.applied} open period${res.applied === 1 ? "" : "s"}.`);
      setDraft(null); setPreview(null); setConflicts(null);
      queryClient.invalidateQueries({ queryKey: [...RECURRING_QUERY_KEY_ROOT, "defs", apartmentId] });
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
    },
    onError: (err: RecurringConflictError | Error) => {
      if (isRecurringConflict(err)) { setConflicts(err.conflicts); return; } // surfaced in the modal; NOT a success
      toast.error((err as Error).message || "Apply failed.");
    },
  });

  const draftValid = draft && isValidMoney(draft.amount) && !!draft.effectiveFromMonth;
  // Why the primary button is greyed — surfaced inline so a disabled "Preview & apply" never
  // looks broken (the empty-amount trap: the "0.00" is placeholder text, not a value). Mirrors
  // the exact checks draftValid makes, in order; null once the draft validates.
  const saveDisabledReason = !draft
    ? null
    : !draft.amount.trim()
      ? "Enter an amount to save."
      : !isValidMoney(draft.amount)
        ? "Amount must be a number like 120.00."
        : !draft.effectiveFromMonth
          ? "Choose an effective month to save."
          : null;

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border/50 bg-background/40 p-4" data-testid="recurring-settings">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Recurring charges</p>
          <p className="text-xs text-muted-foreground">Custom fixed monthly fees — generated read-only each period (like rental). Cleaning, WiFi and Maintenance are set entirely on their own rows above, so they are not listed here.</p>
        </div>
        {canEditCharges && !draft && (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setDraft(emptyDraft())}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        )}
      </div>

      {/* Existing definitions — latest revision summary. */}
      <div className="space-y-1.5">
        {listQuery.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : definitions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recurring charges configured.</p>
        ) : (
          definitions.map((d) => {
            const rev = d.revisions[d.revisions.length - 1];
            return (
              <button
                key={d.id}
                type="button"
                disabled={!canEditCharges}
                onClick={() => canEditCharges && rev && setDraft({ definitionId: d.id, kind: d.kind, name: d.name, amount: rev.amount, bearer: rev.bearer, nature: rev.nature ?? defaultNatureForKind(d.kind), effectiveFromMonth: thisMonth(), enabled: rev.enabled })}
                className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-left transition-colors enabled:hover:bg-background/60"
              >
                <div className="min-w-0">
                  <span className="text-sm text-foreground">{d.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{d.kind.toLowerCase()}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {rev && <span className="text-sm tabular-nums text-foreground">{formatMoney(Number(rev.amount))}</span>}
                  <Badge variant={rev?.enabled ? "emerald" : "amber"}>{rev?.enabled ? "on" : "off"}</Badge>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Editor form — appears when adding/editing. */}
      {draft && (
        <div className="space-y-3 rounded-lg border border-dashed border-border/50 p-3">
          {/* Type is LEGACY-DISPLAY ONLY (2026-07-27). A NEW definition is always CUSTOM —
              Cleaning/WiFi are configured by the unit's Owner/Tenant toggle in the drawer above,
              so offering them here recreated the two-sources-of-truth split that silently zeroed
              cleaning. Existing CLEANING/WIFI definitions stay listed and editable (amount,
              bearer, effective-from, enabled); the selector renders their saved kind read-only,
              exactly as it already did — it has always been `disabled` once definitionId is set.

              The selector renders ONLY the definition's own kind (2026-07-28), not all
              three chips: offering Cleaning/WiFi as visible options on a control that
              cannot select them just advertised two dead choices. A legacy CLEANING/WIFI
              definition still displays its real kind, so the row stays identifiable —
              the value itself is untouched, so nothing about what gets billed changes. */}
          {draft.definitionId && (
            <Field label="Type">
              <Segmented<Kind>
                ariaLabel="Recurring kind"
                value={draft.kind}
                onChange={setKind}
                options={KIND_OPTIONS.filter((o) => o.value === draft.kind)}
                disabled
              />
            </Field>
          )}
          {draft.kind === "CUSTOM" && (
            <Field label="Name">
              <TextInput value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Service fee" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (RM)" error={draft.amount && !isValidMoney(draft.amount) ? "Amounts only" : null}>
              <TextInput type="text" inputMode="decimal" value={draft.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Effective from">
              <TextInput type="month" value={draft.effectiveFromMonth} onChange={(e) => set("effectiveFromMonth", e.target.value)} />
            </Field>
          </div>
          <Field label="Borne by">
            <Segmented<Bearer> ariaLabel="Recurring bearer" value={draft.bearer} onChange={(v) => set("bearer", v)} options={BEARER_OPTIONS} />
          </Field>
          {natureRoutingOn && (
            <Field label="Nature">
              <Segmented<Nature> ariaLabel="Recurring nature" value={draft.nature} onChange={(v) => set("nature", v)} options={NATURE_OPTIONS} />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Enabled
          </label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="gold" size="sm" disabled={!draftValid || previewMutation.isPending} title={saveDisabledReason ?? undefined} onClick={() => draft && previewMutation.mutate(draft)}>
              {previewMutation.isPending ? "Previewing…" : "Preview & apply"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(null); setPreview(null); setConflicts(null); }}>Cancel</Button>
          </div>
          {saveDisabledReason && (
            <p className="text-xs text-muted-foreground" data-testid="recurring-save-disabled-reason">{saveDisabledReason}</p>
          )}
        </div>
      )}

      {/* Preview → confirm modal. Nothing mutates until "Confirm & apply". */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && (setPreview(null), setConflicts(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply this change{draft ? ` from ${draft.effectiveFromMonth}` : ""}?</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat label="Open updated" value={preview.willUpdate.length} />
                <Stat label="On open" value={preview.willCreateOnOpen} />
                <Stat label="Unchanged" value={preview.excluded.length} />
              </div>
              {preview.excluded.length > 0 && (
                <Callout variant="info">
                  {preview.excluded.filter((e) => e.reason === "billed").length} billed, {preview.excluded.filter((e) => e.reason === "invoiced").length} invoiced, {preview.excluded.filter((e) => e.reason === "frozen").length} frozen — left unchanged.
                </Callout>
              )}
              {(conflicts && conflicts.length > 0) || preview.conflicts.length > 0 ? (
                <Callout variant="danger" title="Conflicts — nothing applied">
                  <ul className="mt-1 list-disc pl-4">
                    {(conflicts ?? preview.conflicts).map((c, i) => (
                      <li key={i}>{c.period}: {c.reason}</li>
                    ))}
                  </ul>
                </Callout>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="gold"
              disabled={applyMutation.isPending || !draft || (!!preview && preview.conflicts.length > 0)}
              onClick={() => draft && applyMutation.mutate(draft)}
            >
              {applyMutation.isPending ? "Applying…" : "Confirm & apply"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setPreview(null); setConflicts(null); }}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-2">
      <p className="text-lg font-bold tabular-nums text-foreground">{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
