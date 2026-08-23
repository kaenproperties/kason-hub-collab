// UI Task 5 — per-unit Setting drawer (R11/R12/R13/R14). HIGH: these five
// lines are SNAPSHOTTED onto every future period's entry — a wrong default
// silently mis-bills every subsequent month. Opens over a grid row as a
// modal/drawer (FormDrawer/Sheet) — NEVER a route change.
//
// AUTH per api/bills-grid.ts: GET admits editor; PUT (Save) is MANAGER-only
// (editor 403). The server locks (`isLocked:true`) on EVERY successful save
// (service.ts setBearerConfigService), so "locked" is the steady state after
// the first save, not a rare race. A locked config (`dto.isLocked`) OR a 409
// BEARER_LOCKED race — both surface the SAME manager-only "Unlock & save"
// affordance (submit(true) → unlock:true, an audited unlock+re-lock), never a
// generic error toast and never a permanently read-only manager view (the
// whole point of the set-once design, R14 — "edit config for future
// periods"). Editors never see the unlock control: the whole drawer is
// read-only for them regardless of lock state (setBearerConfig is
// manager-only; R26).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { usePermission } from "@/components/permission-gate";
import { ApiError } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import {
  getBearerConfig,
  setBearerConfig,
  GRID_QUERY_KEY_ROOT,
  type BearerConfigDto,
  type BearerConfigInput,
  type GridManagementFeeDto,
  type GridSubRow,
} from "@/api/bills-grid";
import { useSetTenancyPax, useUnitMeter, useUpdateMeter, useCreateMeter } from "@/api/meter";
import { RecurringSettings } from "./recurring-settings";
import { applyRecurring, disableRecurring } from "@/api/bills-grid-recurring";
import { SCALAR_RECURRING_KINDS, SCALAR_RECURRING_KIND_LIST, type ScalarRecurringKind } from "@kason/shared";

export type SettingDrawerProps = {
  apartmentId: string;
  open: boolean;
  onClose: () => void;
  /** PAX-per-room: the open row's rooms + whole/partition discriminator, passed from the grid
   * page. The "PAX per room" section renders ONLY when isWholeUnit === false and subRows is
   * non-empty — exclusively for partition units (a whole unit's single tenant bears all). */
  subRows?: GridSubRow[];
  isWholeUnit?: boolean;
  managementFee?: GridManagementFeeDto;
  ownerAssigned?: boolean;
  onOpenManagementFee?: () => void;
};

type Bearer = "owner" | "tenant";
// Task 7 (Part B, R4 completion): "manager_advanced" — KAEN paid the provider
// directly and recovers the cost from the tenant pool — joins the existing 3
// patterns. Mirrors the shared `utilityPattern` enum
// (packages/shared/src/schemas/bills-grid.ts) and shape.ts's LineBearerPattern
// union (Task 4); this local type existed BEFORE the shared enum widened and
// was never updated to import it — kept as its own literal union (not
// `import { utilityPattern } from "@kason/shared"`) to avoid widening this
// drawer's scope beyond adding the missing 4th value.
type UtilityPatternValue = "recharged" | "absorbed" | "tenant_direct" | "manager_advanced";

/** charge-nature gate (2026-07-27): "" is the UNDECIDED sentinel the Segmented needs (it has no
 * unset state) and maps back to wire `null`. Undecided is a real, meaningful value here — it is
 * what makes the Bill fail closed instead of silently booking the scalar as manager profit. */
type NatureValue = "" | "expense" | "profit";

type FormState = {
  tnbPattern: UtilityPatternValue;
  airPattern: UtilityPatternValue;
  cleaningBearer: Bearer;
  wifiBearer: Bearer;
  maintenanceFeeBearer: Bearer;
  cleaningRecurringAmount: string;
  cleaningNature: NatureValue;
  wifiNature: NatureValue;
};

// Same vocabulary as the Recurring-charges editor's NATURE_OPTIONS (recurring-settings.tsx) so
// the two surfaces read identically. "Not set" is deliberately OFFERED rather than hidden: an
// admin must be able to see that a unit is undecided, which is why its Bill is blocked.
const NATURE_OPTIONS: SegmentedOption<NatureValue>[] = [
  { value: "", label: "Not set" },
  { value: "profit", label: "Profit" },
  { value: "expense", label: "Expense" },
];

// AIR = Air Selangor = WATER; never label it "Aircond" anywhere near this control.
//
// Simplified vocabulary (2026-07-27): the drawer asks exactly ONE question per cost —
// who BEARS it — matching the Cleaning/WiFi/Maintenance controls above and below.
//   Tenant → "recharged" (the owner fronts it, KAEN bills the tenant, tenant bears it)
//   Owner  → "absorbed"  (the owner eats the cost, nothing is billed to the tenant)
// The wire vocabulary is UNCHANGED — all four values remain valid in the schema and the
// allocation math (buildComputeInputs / fundedByForUtility) is untouched. Only the two
// values an admin can newly CHOOSE are narrowed.
const UTILITY_BEARER_OPTIONS: SegmentedOption<UtilityPatternValue>[] = [
  { value: "absorbed", label: "Owner" },
  { value: "recharged", label: "Tenant" },
];

// Legacy values stay visible on a unit that already carries one, instead of rendering a
// blank Segmented. This is a MONEY guard, not cosmetics: "tenant_direct" means the tenant
// pays TNB directly and KAEN never bills it. Silently folding that into "Tenant"
// (= recharged) would start billing the tenant for electricity KAEN does not collect.
// Showing it keeps the value sticky until an admin deliberately picks Owner or Tenant.
const LEGACY_UTILITY_LABELS: Record<string, string> = {
  tenant_direct: "Tenant pays directly (legacy)",
  manager_advanced: "KAEN advanced (legacy)",
};

/** Options for one utility row: the two bearer choices, plus this unit's legacy value if it has one. */
function utilityOptionsFor(value: UtilityPatternValue): SegmentedOption<UtilityPatternValue>[] {
  const legacyLabel = LEGACY_UTILITY_LABELS[value];
  return legacyLabel ? [...UTILITY_BEARER_OPTIONS, { value, label: legacyLabel }] : UTILITY_BEARER_OPTIONS;
}

/** One row's recurring tick + amount, as edited in this drawer. `amount` is a free-text money
 *  string so a half-typed value never coerces; it is validated on save. */
type RecurringDraft = { ticked: boolean; amount: string; definitionId: string | null };
type RecurringForm = Record<ScalarRecurringKind, RecurringDraft>;

/** Seed every kind from the DTO's per-kind record — driven off SCALAR_RECURRING_KIND_LIST so a
 *  new kind gains its tick automatically, with no edit here. */
function recurringFromDto(dto: BearerConfigDto): RecurringForm {
  return Object.fromEntries(
    SCALAR_RECURRING_KIND_LIST.map((k) => {
      const st = dto.scalarRecurring?.[k];
      return [k, { ticked: st?.governed ?? false, amount: st?.amount ?? "", definitionId: st?.definitionId ?? null }];
    }),
  ) as RecurringForm;
}

/** A ticked row must carry a valid amount — otherwise Save would apply a recurring charge of
 *  nothing, or coerce a half-typed value to RM0. Mirrors the cleaning-amount guard above. */
function recurringInvalidKind(rf: RecurringForm): ScalarRecurringKind | null {
  return SCALAR_RECURRING_KIND_LIST.find((k) => rf[k].ticked && !/^\d+(\.\d{1,2})?$/.test(rf[k].amount.trim())) ?? null;
}

/** The per-row "Recurring" tick + its amount. ONE component for all five scalar rows so the
 *  control cannot drift between them; each row passes its kind. Ticking fixes the monthly AMOUNT
 *  and locks that column in the grid — who bears it stays the row's Owner/Tenant toggle. */
function RecurringTick({
  kind, draft, disabled, onChange,
}: {
  kind: ScalarRecurringKind;
  draft: RecurringDraft;
  disabled: boolean;
  onChange: (next: RecurringDraft) => void;
}) {
  const invalid = draft.ticked && draft.amount.trim() !== "" && !/^\d+(\.\d{1,2})?$/.test(draft.amount.trim());
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          aria-label={`${SCALAR_RECURRING_KINDS[kind].label} recurring`}
          checked={draft.ticked}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, ticked: e.target.checked })}
        />
        Recurring
      </label>
      {draft.ticked && (
        <>
          <span className="text-sm text-muted-foreground">RM</span>
          <TextInput
            aria-label={`${SCALAR_RECURRING_KINDS[kind].label} recurring amount`}
            className="h-8 w-28"
            inputMode="decimal"
            placeholder="0.00"
            value={draft.amount}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
          />
          {invalid && <span className="text-xs text-destructive">Amounts only</span>}
        </>
      )}
    </div>
  );
}

/** Narrow the wire's nullable nature onto the Segmented's sentinel domain. */
function natureFromDto(raw: string | null | undefined): NatureValue {
  return raw === "expense" || raw === "profit" ? raw : "";
}

function formFromDto(dto: BearerConfigDto): FormState {
  return {
    tnbPattern: dto.tnbPattern as UtilityPatternValue,
    airPattern: dto.airPattern as UtilityPatternValue,
    // Cleaning and WiFi are owner-only grid costs. Historical tenant-side
    // documents remain immutable; exceptional new tenant recoveries are entered
    // through Tenant Expenses instead of reviving a permanent tenant column.
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: dto.maintenanceFeeBearer as Bearer,
    cleaningRecurringAmount: dto.cleaningRecurringAmount,
    cleaningNature: natureFromDto(dto.cleaningNature),
    wifiNature: natureFromDto(dto.wifiNature),
  };
}

/**
 * The bills-grid API returns failures as `{ error: "CODE" }`; apiFetch
 * surfaces that in BOTH `ApiError.data.error` and `ApiError.message`. Read
 * whichever is present — mirrors bill-workspace/billing-pane.tsx's
 * `previewErrorCode`, decoupled from the ApiError class so it's trivially
 * unit-testable against a plain rejected value too.
 */
function bearerErrorCode(e: unknown): string | null {
  if (e && typeof e === "object") {
    const x = e as { data?: { error?: unknown }; code?: unknown; message?: unknown };
    if (typeof x.data?.error === "string") return x.data.error;
    if (typeof x.code === "string") return x.code;
    if (typeof x.message === "string") return x.message;
  }
  return null;
}

function normalizeAmount(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(2) : raw;
}

/**
 * Guards the cleaning recurring amount from silently coercing to RM0.
 * Empty/blank/whitespace is invalid (Save must be blocked, not defaulted to
 * "0.00"); an explicit "0" typed by the manager IS allowed — only
 * empty/garbage input is blocked. At most 2 decimal places, matching the
 * money columns this snapshots into.
 */
function isValidMoney(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return /^\d+(\.\d{1,2})?$/.test(trimmed);
}

export function SettingDrawer({
  apartmentId,
  open,
  onClose,
  subRows,
  isWholeUnit,
  managementFee,
  ownerAssigned = false,
  onOpenManagementFee,
}: SettingDrawerProps) {
  const canEditBillingSettings = usePermission("billing.charge.edit");
  // PAX per room is EDITOR-editable (PATCH /meter/tenancies/:id/pax is requireRole("editor")),
  // INDEPENDENT of the manager-only bearer-config save/lock below. Only for partition units.
  const canEditPax = usePermission("tenancy.edit");
  const showPaxSection = isWholeUnit === false && (subRows?.length ?? 0) > 0;
  // Electricity rate per room (RM/kWh): edit the room's AircondMeter.ratePerKwh HERE
  // instead of the tenant tracker. Manager-only (PATCH/POST /meter are requireRole
  // "manager"), and applies to WHOLE and partition alike (both have aircond rooms).
  const showRateSection = (subRows?.length ?? 0) > 0;
  // Recurring-charges: flag-ON, cleaning/WiFi amounts are managed by the RecurringSettings editor
  // below — so the legacy "Cleaning recurring amount" input is hidden to avoid two places for one
  // value. Flag-OFF preserves the legacy field (and no editor). The DB column stays vestigial.
  const recurringFlagOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  // Presentation gate (2026-07-27), mirroring recurring-settings.tsx / recurring-dialog.tsx /
  // expenses-dialog.tsx, which already read this flag the same way. This drawer was the ONE
  // nature surface that rendered unconditionally, so with routing off it kept asking the admin
  // to pick Profit/Expense while the Bill ignored the answer. Flag OFF ⇒ Cleaning/WiFi are a
  // plain Owner/Tenant choice and the stored nature is left untouched (never cleared — the
  // value must survive intact if routing is turned back on).
  const natureRoutingOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");
  const queryClient = useQueryClient();
  const queryKey = ["bills-grid", "bearer-config", apartmentId];

  const configQuery = useQuery({
    queryKey,
    queryFn: () => getBearerConfig(apartmentId),
    enabled: open,
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [recurring, setRecurring] = useState<RecurringForm | null>(null);
  // Set on a 409 BEARER_LOCKED response to a Save that started from an
  // (as-fetched) unlocked config — distinct from `dto.isLocked`, which only
  // reflects the state at the last GET.
  const [raceLocked, setRaceLocked] = useState(false);

  useEffect(() => {
    // Seed ONLY on the open transition (form is null exactly once per open —
    // reset to null on close, below) — NOT on every configQuery.data change.
    // A background refetch while the drawer stays open (react-query
    // refetchOnWindowFocus etc.) must never clobber a manager's in-progress
    // edits by re-running formFromDto over fresh server data.
    if (open && configQuery.data && form === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(formFromDto(configQuery.data));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecurring(recurringFromDto(configQuery.data));
    }
  }, [open, configQuery.data, form]);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(null);
      setRecurring(null);
      setRaceLocked(false);
    }
  }, [open]);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  const saveMutation = useMutation({
    mutationFn: async (body: BearerConfigInput) => {
      const res = await setBearerConfig(apartmentId, body);
      // Recurring deltas apply straight from Save — the preview→confirm gate the
      // Recurring-charges editor below uses is DELIBERATELY bypassed here (user decision:
      // "B", apply immediately). Sequenced AFTER the bearer-config write so a rejected
      // config (e.g. BEARER_LOCKED) never leaves a recurring definition applied against
      // settings that were not saved. Only CHANGED kinds are touched.
      if (recurring) {
        const before = configQuery.data ? recurringFromDto(configQuery.data) : null;
        for (const kind of SCALAR_RECURRING_KIND_LIST) {
          const now = recurring[kind];
          const was = before?.[kind];
          const changed = !was || was.ticked !== now.ticked || (now.ticked && was.amount !== now.amount.trim());
          if (!changed) continue;
          if (now.ticked) {
            await applyRecurring(apartmentId, {
              ...(now.definitionId ? { definitionId: now.definitionId } : {}),
              kind,
              name: SCALAR_RECURRING_KINDS[kind].label,
              amount: Number(now.amount).toFixed(2),
              // The definition still carries a bearer to satisfy the schema, but it is NOT
              // authoritative: writeSnapshot stopped writing it, so the drawer's Owner/Tenant
              // toggle above owns that fact (one writer per fact).
              bearer: kind === "CLEANING" || kind === "WIFI" ? "owner" : form!.maintenanceFeeBearer,
              // Nature rides along only when this drawer OWNS it (ungoverned CLEANING/WIFI
              // with a decided value). Otherwise omitted: the API carries the prior
              // revision's decided nature forward on edits, and an undecided create stays
              // the fail-closed 422 under nature-routing instead of half-applying the Save.
              ...(kind === "CLEANING" && !(configQuery.data?.cleaningGoverned ?? false) && form!.cleaningNature !== ""
                ? { nature: form!.cleaningNature }
                : kind === "WIFI" && !(configQuery.data?.wifiGoverned ?? false) && form!.wifiNature !== ""
                  ? { nature: form!.wifiNature }
                  : {}),
              effectiveFromMonth: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`,
              enabled: true,
              confirm: true,
            });
          } else if (now.definitionId) {
            await disableRecurring(apartmentId, now.definitionId);
          }
        }
      }
      return res;
    },
    onSuccess: (res) => {
      // Honest save feedback: billed-but-unpaid months are updated and become re-billable.
      // Only money received or an approved/frozen owner report prevents a current snapshot
      // from moving to the newly selected Owner/Tenant side.
      const locked = res.lockedEntries ?? 0;
      const synced = res.syncedEntries ?? 0;
      if (locked > 0 && synced === 0) {
        toast.error(
          "This month already has a payment or an approved owner report, so its billing side cannot change. The new setting applies to future months.",
        );
      } else if (locked > 0) {
        toast.success("Setting saved. Paid or approved-report months stay unchanged.");
      } else {
        toast.success("Setting saved.");
      }
      setRaceLocked(false);
      queryClient.invalidateQueries({ queryKey }); // bearer-config (own cache)
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // R5: re-derive grid columns live
      onClose();
    },
    onError: (err: ApiError) => {
      if (bearerErrorCode(err) === "BEARER_LOCKED") {
        // The config was locked between our GET and this Save, so the attempt
        // saved NOTHING. Flip the button to "Unlock & save" AND tell the user
        // why — the old silent flip read as "I clicked Save and nothing
        // happened." The next click carries unlock:true and succeeds.
        setRaceLocked(true);
        toast.error("These settings are locked — press “Unlock & save” to apply your changes.");
        return;
      }
      toast.error(err.message);
    },
  });

  const dto = configQuery.data;
  // charge-nature gate: a kind GOVERNED by an enabled recurring definition is owned end-to-end by
  // the Recurring-charges editor (amount + Borne by + Nature). Its controls render here read-only
  // with a pointer, instead of offering a duplicate control whose value would silently lose — the
  // "two cleaning / two WiFi" trap the original hiding was meant to fix, kept fixed.
  const governedCleaning = dto?.cleaningGoverned ?? false;
  const governedWifi = dto?.wifiGoverned ?? false;
  const cleaningAmountValid = form ? isValidMoney(form.cleaningRecurringAmount) : false;
  // The cleaning-amount validity only GATES Save when its input is actually on
  // screen (flag-OFF). Flag-ON the field is hidden — cleaning is managed by the
  // RecurringSettings editor and the seeded value round-trips untouched via
  // normalizeAmount — so gating Save on it would permanently DISABLE "Unlock &
  // save" whenever the seeded value isn't clean money, with NO visible field to
  // fix (the "can't unlock & save" trap the user hit). Only block when the field
  // exists for the manager to correct.
  const cleaningGateBlocks = !recurringFlagOn && !cleaningAmountValid;
  // A ticked row with a missing/invalid amount blocks Save. Without this, Save would apply a
  // recurring charge of RM0 (Number("") === 0) — silently zeroing that row's monthly amount for
  // every open period. Same reasoning as the cleaning-amount guard above.
  const badRecurringKind = recurring ? recurringInvalidKind(recurring) : null;
  const recurringGateBlocks = badRecurringKind !== null;

  function submit(unlock: boolean) {
    // Defense-in-depth beyond the Save button's `disabled`: FormDrawer's
    // <form onSubmit> fires this on Enter-to-submit too, independent of the
    // button's disabled attribute — never let an editor or an invalid
    // (visible) cleaning amount reach the API through that path.
    if (!form || !canEditBillingSettings || cleaningGateBlocks || recurringGateBlocks) return;
    const body: BearerConfigInput = {
      tnbPattern: form.tnbPattern,
      airPattern: form.airPattern,
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: form.maintenanceFeeBearer,
      cleaningRecurringAmount: normalizeAmount(form.cleaningRecurringAmount),
      unlock,
      // charge-nature gate: the "" sentinel round-trips as an EXPLICIT null (clear back to
      // undecided), not as an omitted field — the admin choosing "Not set" is a real decision to
      // un-decide, and must not be silently swallowed into "leave whatever was stored".
      // A GOVERNED kind is omitted entirely: the Recurring-charges editor owns it, and sending a
      // value from here would be a second writer racing the one source of truth.
      ...(governedCleaning ? {} : { cleaningNature: form.cleaningNature === "" ? null : form.cleaningNature }),
      ...(governedWifi ? {} : { wifiNature: form.wifiNature === "" ? null : form.wifiNature }),
    };
    saveMutation.mutate(body);
  }

  // Fields: editors are read-only no matter what (setBearerConfig is
  // manager-only, R26) — managers are ALWAYS editable, never field-disabled
  // by lock state (a manager unlocks by saving, not by a separate step).
  const fieldsDisabled = !canEditBillingSettings;
  // Merge the two locked signals: an already-locked config at last GET
  // (dto.isLocked — the steady state after any successful save) OR a 409
  // race that started from an as-fetched-unlocked config. Either flips a
  // manager's Save into an explicit, audited "Unlock & save".
  const showUnlock = canEditBillingSettings && (Boolean(dto?.isLocked) || raceLocked);

  const warning = !canEditBillingSettings
    ? dto?.isLocked
      ? { variant: "warning" as const, body: "Locked — a manager must unlock to change" }
      : { variant: "warning" as const, body: "Only a manager can change these billing settings." }
    : showUnlock
      ? {
          variant: "warning" as const,
          title: "Locked",
          body: "These settings are locked — saving will perform an audited unlock and re-lock with your changes.",
        }
      : undefined;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title="Unit setting"
      description={
        recurringFlagOn
          ? "Snapshotted onto every future period's entry, and pushed onto any already-open (unbilled) month. A Cleaning/WiFi line with a recurring charge is configured below instead."
          : "These five lines are snapshotted onto every future period's entry — get them right once."
      }
      warning={warning}
      onSubmit={() => submit(showUnlock)}
      submit={{
        label: showUnlock ? "Unlock & save" : "Save",
        pendingLabel: "Saving…",
        variant: "gold",
        pending: saveMutation.isPending,
        disabled: !canEditBillingSettings || !form || cleaningGateBlocks || recurringGateBlocks,
      }}
    >
      {configQuery.isError ? (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn&apos;t load settings.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => configQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : !form ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4">
          {/* Cleaning owner-only + NATURE.
              charge-nature gate (2026-07-27) — these were previously hidden whenever the
              recurring flag was on, on the theory that the RecurringSettings editor below owned
              cleaning/WiFi end-to-end. It only owns them when a definition GOVERNS the month.
              The amount/nature controls remain here, but the bearer is fixed to Owner.
              Exceptional tenant cleaning is entered through Tenant Expenses. */}
          <Field
            label="Cleaning"
            hint={
              governedCleaning
                ? "Amount is fixed by the Cleaning recurring charge below. Cleaning is owner-borne."
                : natureRoutingOn
                  ? "Cleaning is owner-borne. Profit → owner invoice (IVOWN); Expense → owner payout deduction. Use Tenant Expenses for an exceptional tenant cleaning charge."
                  : "Cleaning is owner-borne. Use Tenant Expenses for an exceptional tenant cleaning charge."
            }
          >
            <div className="grid gap-2">
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm font-medium">
                Owner
              </div>
              {natureRoutingOn && (
                <Segmented<NatureValue>
                  ariaLabel="Cleaning nature"
                  value={form.cleaningNature}
                  onChange={(v) => set("cleaningNature", v)}
                  options={NATURE_OPTIONS}
                  disabled={fieldsDisabled || governedCleaning}
                />
              )}
              {recurring && (
                <RecurringTick
                  kind="CLEANING"
                  draft={recurring.CLEANING}
                  disabled={fieldsDisabled}
                  onChange={(next) => setRecurring((prev) => (prev ? { ...prev, CLEANING: next } : prev))}
                />
              )}
            </div>
          </Field>

          <Field label="TNB (electricity)" hint="Who bears this cost — the owner or the tenant.">            <div className="grid gap-2">

              <Segmented<UtilityPatternValue>
                ariaLabel="TNB pattern"
                value={form.tnbPattern}
                onChange={(v) => set("tnbPattern", v)}
                options={utilityOptionsFor(form.tnbPattern)}
                disabled={fieldsDisabled}
              />
              {recurring && (
                <RecurringTick
                  kind="TNB"
                  draft={recurring.TNB}
                  disabled={fieldsDisabled}
                  onChange={(next) => setRecurring((prev) => (prev ? { ...prev, TNB: next } : prev))}
                />
              )}
            </div>
          </Field>

          <Field label="AIR (Air Selangor — water)" hint="Who bears this cost — the owner or the tenant.">            <div className="grid gap-2">

              <Segmented<UtilityPatternValue>
                ariaLabel="AIR pattern"
                value={form.airPattern}
                onChange={(v) => set("airPattern", v)}
                options={utilityOptionsFor(form.airPattern)}
                disabled={fieldsDisabled}
              />
              {recurring && (
                <RecurringTick
                  kind="AIR"
                  draft={recurring.AIR}
                  disabled={fieldsDisabled}
                  onChange={(next) => setRecurring((prev) => (prev ? { ...prev, AIR: next } : prev))}
                />
              )}
            </div>
          </Field>

          {/* WiFi is an owner-only pass-through. Exceptional tenant recovery goes through
              Tenant Expenses rather than a permanent WiFi Tenant column. */}
          <Field
            label="WiFi"
            hint={
              governedWifi
                ? "Amount is fixed by the WiFi recurring charge below. WiFi is owner-borne."
                : natureRoutingOn
                  ? "WiFi is owner-borne. Expense deducts the supplier bill from owner payout; use Tenant Expenses for an exceptional tenant recovery."
                  : "WiFi is owner-borne. Use Tenant Expenses for an exceptional tenant recovery."
            }
          >
            <div className="grid gap-2">
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm font-medium">
                Owner
              </div>
              {natureRoutingOn && (
                <Segmented<NatureValue>
                  ariaLabel="WiFi nature"
                  value={form.wifiNature}
                  onChange={(v) => set("wifiNature", v)}
                  options={NATURE_OPTIONS}
                  disabled={fieldsDisabled || governedWifi}
                />
              )}
              {recurring && (
                <RecurringTick
                  kind="WIFI"
                  draft={recurring.WIFI}
                  disabled={fieldsDisabled}
                  onChange={(next) => setRecurring((prev) => (prev ? { ...prev, WIFI: next } : prev))}
                />
              )}
            </div>
          </Field>

          {badRecurringKind && (
            <p className="text-xs text-destructive" data-testid="recurring-amount-required">
              Enter an amount for the {SCALAR_RECURRING_KINDS[badRecurringKind].label} recurring charge.
            </p>
          )}

          {/* Maintenance is OWNER-BORNE, and there is deliberately NO bearer control here.
              This row used to render an Owner/Tenant Segmented that was hardwired
              `disabled` with a no-op `onChange`, under the same "Who bears this cost"
              hint as the four working rows — a control that looked editable, answered a
              question it could not act on, and silently ignored every click.

              That mattered more than cosmetics: `maintenanceFeeBearer` is NOT
              display-only (the 2026-07-10 spec line saying so is stale, superseded by
              69fc262f). It is live money — computeAllocation pools it into the per-pax
              tenant split when the bearer is "tenant" (meter/compute.ts:132), gives each
              room a `maintenanceShare` (:157), and it drives fundedBy routing
              (service.ts:1452). So the drawer was offering a real money switch that was
              welded shut.

              Decision (2026-08-03): keep maintenance owner-borne and REMOVE the control,
              rather than enable it — enabling would let a manager start charging tenants
              maintenance, which is a billing-policy change nobody asked for. Showing an
              honest read-only line is the fix; the dead toggle was the bug.

              The stored value is NOT dropped: `form.maintenanceFeeBearer` is still seeded
              by formFromDto and still submitted verbatim by submit(), so a unit that
              already carries "tenant" (set before the freeze, or via the API) round-trips
              untouched instead of being silently rewritten to "owner". The Recurring tick
              below stays — it sets the monthly AMOUNT and has always worked. */}
          <Field
            label="Maintenance"
            hint={
              form.maintenanceFeeBearer === "tenant"
                ? "Borne by the tenant. Set outside this drawer — maintenance has no bearer control here."
                : "Borne by the owner. Maintenance is always owner-borne; only its recurring amount is set here."
            }
          >
            <div className="grid gap-2">
              {recurring && (
                <RecurringTick
                  kind="MAINTENANCE"
                  draft={recurring.MAINTENANCE}
                  disabled={fieldsDisabled}
                  onChange={(next) => setRecurring((prev) => (prev ? { ...prev, MAINTENANCE: next } : prev))}
                />
              )}
            </div>
          </Field>

          {/* Legacy cleaning recurring amount — flag-OFF only. Flag-ON this value is managed by the
              RecurringSettings editor below (single source of truth), so the input is hidden to
              stop the "two recurring for cleaning" confusion. The saved value still round-trips
              unchanged (form.cleaningRecurringAmount stays seeded from the DTO). */}
          {!recurringFlagOn && (
            <Field
              label="Cleaning recurring amount (RM)"
              error={canEditBillingSettings && !cleaningAmountValid ? "Enter a cleaning amount" : null}
            >
              <TextInput
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.cleaningRecurringAmount}
                onChange={(e) => set("cleaningRecurringAmount", e.target.value)}
                disabled={fieldsDisabled}
              />
            </Field>
          )}
        </div>
      )}

      <div
        data-testid="management-fee-settings"
        className="mt-2 grid gap-3 rounded-xl border border-amber-300/70 bg-amber-50/40 p-4 dark:border-amber-700/60 dark:bg-amber-950/20"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Management Fee</p>
            <p className="text-xs text-muted-foreground">
              Configure this unit&apos;s percentage, cap, pax deduction, free months and first charge.
              Management services always include 8% SST.
            </p>
          </div>
          <span
            className={
              managementFee?.configured
                ? "rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"
                : "rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700"
            }
          >
            {managementFee?.configured ? "Configured" : "Not configured"}
          </span>
        </div>

        {managementFee?.configured ? (
          <div className="rounded-lg border border-border/70 bg-background/75 px-3 py-2">
            <p className="text-xs text-muted-foreground">Current billing month preview</p>
            <p className="text-base font-bold text-foreground">
              RM {Number(managementFee.total || 0).toLocaleString("en-MY", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              <span className="ml-1 text-xs font-normal text-muted-foreground">including SST</span>
            </p>
            {managementFee.reason ? (
              <p className="mt-1 text-xs text-muted-foreground">{managementFee.reason}</p>
            ) : null}
          </div>
        ) : null}

        {!ownerAssigned ? (
          <Callout variant="warning">Assign an owner to this unit before setting its Management Fee.</Callout>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onOpenManagementFee}
            disabled={!onOpenManagementFee}
          >
            Open Management Fee settings
          </Button>
        )}
      </div>

      {/* PAX-per-room (partition units only): per-room tenant headcount, editor-editable, its own
          save flow via PATCH /meter/tenancies/:id/pax — decoupled from the manager-only bearer Save. */}
      {showPaxSection && <PaxPerRoomSection subRows={subRows!} canEdit={canEditPax} />}

      {/* Electricity rate per room (RM/kWh): manager-only per-room meter-rate editor, so the
          rate that drives amount = (current−previous)×rate is fixable HERE, not only in the
          tenant tracker. Its own per-room save flow (PATCH /meter/:id, or POST /meter for a
          room with no meter yet), decoupled from the bearer Save. */}
      {showRateSection && <RatePerRoomSection subRows={subRows!} canEdit={canEditBillingSettings} open={open} />}

      {/* Recurring-charges (Task 7): settings-controlled recurring fees (cleaning/WiFi/custom).
          Flag-gated; own preview→confirm→apply flow, decoupled from the bearer-config Save above. */}
      {recurringFlagOn && <RecurringSettings apartmentId={apartmentId} />}
    </FormDrawer>
  );
}

/**
 * PAX-per-room section (partition units). One editable row per OCCUPIED room; a vacant room
 * (no active tenancy) shows a "Vacant" marker with no input — pax cannot be set without a
 * tenancy. Each row saves independently via the existing PATCH /meter/tenancies/:id/pax.
 */
function PaxPerRoomSection({ subRows, canEdit }: { subRows: GridSubRow[]; canEdit: boolean }) {
  return (
    <div data-testid="pax-per-room" className="mt-2 grid gap-3 border-t border-border/50 pt-4">
      <div>
        <p className="text-sm font-semibold text-foreground">PAX per room</p>
        <p className="text-xs text-muted-foreground">
          Number of tenants (pax) in each room — drives the per-pax utility split and the owner
          subsidy for partition units. Set this to clear the &ldquo;set the number of tenants (pax)
          on the room first&rdquo; block.
        </p>
      </div>
      {subRows.map((room) =>
        room.tenancyId ? (
          <PaxRoomRow
            key={room.listingId}
            tenancyId={room.tenancyId}
            label={room.partyName ?? "Room"}
            current={room.numberOfPax ?? null}
            canEdit={canEdit}
          />
        ) : (
          <div
            key={room.listingId}
            className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">{room.partyName ?? "Room"}</span>
            <span className="text-xs text-muted-foreground">Vacant — no tenant</span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * One occupied room's pax editor. Seeds from the room's current numberOfPax (blank when unset/0),
 * min 1 / max 50 (mirrors the endpoint's 422 bounds). AUTO-SAVES on blur (Enter blurs the field)
 * ONLY when the value is valid AND differs from the last-saved value — there is NO per-row Save
 * button. This removes the dual-save trap where the drawer's manager-only bottom Save silently
 * ignored a just-typed pax and still reported "Setting saved." (spec
 * 2026-07-21-pax-per-room-autosave). An inline status to the right of the field reflects the last
 * attempt (saving… → Saved ✓, or an error with a Retry affordance) — the inline ✓ REPLACES the
 * old success toast. On success, invalidates the grid root so the row's pax_blocked / ZERO_PAX
 * warning and the preview re-derive live (the hook itself only busts the ["meter"] cache).
 */
type PaxRowError = { kind: "retry" } | { kind: "stale"; message: string };

function PaxRoomRow({
  tenancyId,
  label,
  current,
  canEdit,
}: {
  tenancyId: string;
  label: string;
  current: number | null;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const paxMutation = useSetTenancyPax();
  const initial = current != null && current > 0 ? String(current) : "";
  const [value, setValue] = useState(initial);
  // The last value we actually persisted. `changed` compares against THIS (not the initial seed)
  // so a re-blur straight after a save is a no-op (R1), while a FAILED save leaves the baseline
  // untouched — so a re-blur or Retry still counts as changed and re-attempts (R4).
  const [savedValue, setSavedValue] = useState(initial);
  // Last save-attempt outcome for the inline indicator (R2/R4). "saved" persists until the next
  // edit; "error" carries whether a generic Retry applies or a 404 stale-row refresh message.
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<PaxRowError | null>(null);

  const trimmed = value.trim();
  const n = Number(trimmed);
  // min 1 / max 50 mirror setTenancyPaxSchema (packages/shared/src/schemas/meter.ts) so an
  // out-of-range value is blocked inline instead of round-tripping to a raw 422 toast.
  const valid = /^\d+$/.test(trimmed) && n >= 1 && n <= 50;
  const changed = trimmed !== savedValue;

  function save() {
    // R1: fire ONLY for an editor with a valid, CHANGED value — a blank field (invalid), an
    // unchanged value, or an out-of-range value is a silent no-op (no save, no toast). R6:
    // non-editors never reach here (the field is disabled). The status guard dedupes the
    // blur+click double-fire when Retry is clicked (the input blurs first, then the button click).
    if (!canEdit || !valid || !changed || status === "saving" || paxMutation.isPending) return;
    const attempt = trimmed;
    setStatus("saving");
    setError(null);
    paxMutation.mutate(
      { tenancyId, numberOfPax: n },
      {
        onSuccess: () => {
          // R2: the inline ✓ REPLACES the old success toast (no toast fires). R5: invalidate the
          // grid root so the row's pax_blocked / ZERO_PAX warning and the preview re-derive live
          // (the hook itself only busts ["meter"]). The saved value becomes the new baseline so a
          // re-blur without further edit is a no-op.
          setSavedValue(attempt);
          setStatus("saved");
          setError(null);
          queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
        },
        onError: (e: unknown) => {
          // Preserve the existing error-code read (message !== "TENANCY_NOT_FOUND"). A 404
          // TENANCY_NOT_FOUND (stale room) refreshes the grid so the row re-derives and shows
          // friendly copy; any other failure keeps the typed value and offers an inline Retry
          // (R4). Never a false ✓ — the typed value is always retained.
          const raw = e instanceof Error ? e.message : "";
          if (raw !== "TENANCY_NOT_FOUND") {
            setError({ kind: "retry" });
          } else {
            queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
            setError({
              kind: "stale",
              message: "Couldn’t update pax — the room may have changed. Refreshing.",
            });
          }
          setStatus("error");
        },
      },
    );
  }

  return (
    <Field label={label} error={canEdit && trimmed !== "" && !valid ? "Enter pax (1–50)" : null}>
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          inputMode="numeric"
          min="1"
          max="50"
          step="1"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // A fresh edit clears the last outcome — R2: "Saved ✓" (and any error) persists only
            // until the next edit; "saving…" is left alone (that write is still in flight).
            setStatus((s) => (s === "saving" ? s : "idle"));
            setError(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            // Enter commits by blurring the field, which triggers onBlur → save (R1).
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          disabled={!canEdit}
        />
        <span
          className="min-w-[7rem] text-xs"
          aria-live="polite"
          data-testid={`pax-status-${tenancyId}`}
        >
          {status === "saving" && <span className="text-muted-foreground">saving…</span>}
          {status === "saved" && (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">Saved ✓</span>
          )}
          {status === "error" && error?.kind === "retry" && (
            <span className="text-destructive">
              Couldn’t save —{" "}
              <button
                type="button"
                onClick={save}
                aria-label={`Retry saving pax for ${label}`}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Retry
              </button>
            </span>
          )}
          {status === "error" && error?.kind === "stale" && (
            <span className="text-destructive">{error.message}</span>
          )}
        </span>
      </div>
    </Field>
  );
}

// Same rate shape the shared meter schema enforces (`^\d+(\.\d{1,4})?$`): a non-negative
// number with up to 4 decimals. Validated inline so an obviously-bad value never round-trips.
const RATE_RE = /^\d+(\.\d{1,4})?$/;

/**
 * Electricity-rate-per-room section (manager-only edit). One row per room; the rate is the
 * room's AircondMeter.ratePerKwh — the multiplier behind amount = (current − previous) × rate.
 * Editing here means a manager never has to leave the billing grid for the tenant tracker.
 * Editors see the rates read-only (PATCH/POST /meter are manager-only).
 */
function RatePerRoomSection({ subRows, canEdit, open }: { subRows: GridSubRow[]; canEdit: boolean; open: boolean }) {
  return (
    <div data-testid="rate-per-room" className="mt-2 grid gap-3 border-t border-border/50 pt-4">
      <div>
        <p className="text-sm font-semibold text-foreground">Electricity rate per room (RM/kWh)</p>
        <p className="text-xs text-muted-foreground">
          The per-kWh submeter rate behind each room&rsquo;s aircond amount
          (amount = (current − previous) × rate). Editing it recomputes the amount for the current
          unbilled period; already-billed periods keep their snapshot.
        </p>
      </div>
      {subRows.map((room) => (
        <RoomRateRow
          key={room.listingId}
          listingId={room.listingId}
          label={room.partyName ?? "Room"}
          fallbackRate={room.ratePerKwh}
          rateConfigured={room.rateConfigured}
          canEdit={canEdit}
          open={open}
        />
      ))}
    </div>
  );
}

/**
 * One room's meter-rate editor. Shows the room's current rate (the configured meter's, or the lazy
 * 0.6 default marked "default"); a manager pencil flips it to an inline edit. Save PATCHes the
 * existing meter (optimistic-concurrency via expectedUpdatedAt) or POSTs a new meter for a room that
 * has none yet, then invalidates the grid so the amount re-derives at the new rate.
 */
function RoomRateRow({
  listingId,
  label,
  fallbackRate,
  rateConfigured,
  canEdit,
  open,
}: {
  listingId: string;
  label: string;
  fallbackRate: string;
  rateConfigured: boolean;
  canEdit: boolean;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const meterQuery = useUnitMeter(listingId, open);
  const meter = meterQuery.data ?? null;
  const update = useUpdateMeter(meter?.id ?? "");
  const create = useCreateMeter();
  // null = read-only; a string = editing (seeded from the current rate when the pencil opens).
  const [draft, setDraft] = useState<string | null>(null);

  const displayRate = meter?.ratePerKwh ?? fallbackRate;
  const isDefault = !meter && !rateConfigured;
  const pending = update.isPending || create.isPending;
  const valid = draft != null && RATE_RE.test(draft.trim());

  function save() {
    if (draft == null) return;
    const value = draft.trim();
    if (!RATE_RE.test(value)) return;
    const onSuccess = () => {
      setDraft(null);
      toast.success(`Rate updated for ${label} — the amount will re-derive.`);
      // The mutation hooks bust ["meter"]; the grid amount is derived from the subRow's
      // ratePerKwh, so bust the grid root too or it keeps computing at the OLD rate until reload.
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
    };
    const onError = (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Couldn’t update the rate.");
    if (meter) update.mutate({ ratePerKwh: value, expectedUpdatedAt: meter.updatedAt }, { onSuccess, onError });
    else create.mutate({ unitId: listingId, ratePerKwh: value }, { onSuccess, onError });
  }

  if (draft == null) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm">
        <span className="text-foreground">{label}</span>
        <span className="inline-flex items-center gap-2">
          <span className="font-mono tabular-nums">RM {displayRate}/kWh</span>
          {isDefault && <span className="text-xs text-muted-foreground">(default)</span>}
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setDraft(displayRate)}
              disabled={meterQuery.isLoading}
              aria-label={`Edit electricity rate for ${label}`}
            >
              Edit
            </Button>
          )}
        </span>
      </div>
    );
  }

  return (
    <Field label={label} error={!valid ? "Enter a rate (up to 4 decimals)" : null}>
      <div className="flex items-center gap-2">
        <TextInput
          type="text"
          inputMode="decimal"
          value={draft}
          autoFocus
          aria-label={`Electricity rate per kWh for ${label}`}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />
        <Button type="button" variant="gold" size="sm" disabled={!valid || pending} onClick={save} aria-label={`Save electricity rate for ${label}`}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </Field>
  );
}
