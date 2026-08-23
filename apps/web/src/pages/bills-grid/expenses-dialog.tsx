// UI Task 6 — tenant/owner expenses, claim-form style, total-only grid cell.
// Consumes the ui-1 client (createExpenses/listExpenses/updateExpense/
// voidExpense). Mirrors the ui-5 SettingDrawer's useAuth manager-gate pattern
// and Callout house primitives; the repeating-row layout mirrors the portal
// claim-items-table.tsx per-row Card pattern (kept lighter here — three fields
// per row, not a multi-section claim).
//
// The editable form renders INLINE inside the caller's sheet (see
// bills-grid-page.tsx) — not behind a button in a nested FormDrawer — so the
// fields are reachable in a single click. The read-only itemised view (eye)
// stays a separate modal, and a successful save/void remounts the form (via a
// key nonce) to reseed from server truth.
//
// bearer is FIXED at create and NEVER editable here — filing to the wrong
// side is fixed by void + recreate, never by mutating a possibly-billed
// month's bearer (see api/bills-grid.ts UpdateExpenseInput doc-comment).
//
// The "party picker (name/unit/phone search)" is a pure CLIENT-SIDE filter
// over caller-supplied `tenancyOptions` — NOT a live org-wide search. The
// ui-1 client's createExpenses needs a `tenancyId` (not a bare Party id), and
// no tenancy-shaped search-by-name endpoint exists yet (the only live
// tenant typeahead, GET /parties/tenants/search, returns Party ids and is
// manager-gated — see parties.repository.ts:searchTenants). Wiring that
// mismatched id type in would be a real (if latent) bug, and standing up a
// new tenancy-search endpoint is outside this UI task's consumed-API list.
// The caller (grid page / tenant record page) already resolves the
// candidate tenancies for this apartment; this component only filters and
// selects among them.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GlowCard } from "@/components/ui/glow-card";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { usePermission } from "@/components/permission-gate";
import { formatMoney } from "@/components/format";
import { cn } from "@/lib/utils";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { useChargeCategories } from "@/api/charge-categories";
import { categoriesForBearer, type ChargeCategoryDto, type SettlementState } from "@kason/shared";
import { parseAmountCell } from "./cell-parser";
import { expenseLockLabel, isExpenseLineLocked } from "./expense-lock";
import { LineAttachments } from "./line-attachments";
import {
  createExpenses,
  listExpenses,
  updateExpense,
  voidExpense,
  GRID_QUERY_KEY_ROOT,
  type ExpenseListItem,
} from "@/api/bills-grid";

export type ExpensesDialogTenancyOption = {
  tenancyId: string;
  partyName: string;
  unitCode?: string | null;
  phone?: string | null;
};

export type ExpensesDialogProps = {
  apartmentId: string;
  periodMonth: string;
  bearer: "tenant" | "owner";
  /** Column that opened the drawer: preselect SST for every newly-added line. */
  defaultWithSST?: boolean;
  /**
   * Reachable-from-a-tenant-record case (brief R-tenant-popup): a
   * pre-resolved tenancy. Skips the picker entirely and auto-fills the name
   * read-only — never re-editable here (same fixed-bearer discipline).
   */
  initialTenancy?: { tenancyId: string; partyName: string };
  /** Candidates for the tenant picker, searched by name/unit/phone (client-side). */
  tenancyOptions?: ExpensesDialogTenancyOption[];
};

type ExpenseNature = "expense" | "profit";

// Task B2 (gridexpense-nature), flag-gated on ENABLE_CHARGE_NATURE_ROUTING: per-row
// Expense/Profit selector, mirroring recurring-settings.tsx's Segmented control +
// vocabulary. Order (Profit, Expense) matches that control and charge-categories-
// section.tsx's dropdown so the vocabulary reads the same across every surface — but
// UNLIKE the recurring editor's DEFAULT_NATURE ("profit", preserving THAT domain's
// pre-feature legacy behavior), a freeform GridExpense row's pre-feature behavior IS
// Expense/EB-routing (Task B1), so backward-compat here means defaulting to Expense.
const NATURE_OPTIONS: SegmentedOption<ExpenseNature>[] = [
  { value: "profit", label: "Profit" },
  { value: "expense", label: "Expense" },
];
const DEFAULT_NATURE: ExpenseNature = "expense";

type EditableRow = {
  key: string;
  /** Existing GridExpense id, or null for a not-yet-persisted row. */
  id: string | null;
  description: string;
  amount: string;
  withSST: boolean;
  actualCost: string;
  costVendor: string;
  costPaymentStatus: "unpaid" | "partial" | "paid";
  costPaymentDate: string;
  costPaymentAccount: string;
  costNotes: string;
  /** T3, flag-gated: classify-only ChargeCategory FK. Never read when the picker flag is dark. */
  chargeCategoryId: string | null;
  /** Task B2, flag-gated: per-row Expense/Profit routing choice (GridExpense.nature).
   * Always a concrete value in local state (Segmented has no unset state) — seeded
   * from server truth for an existing row (rowsFromActive), or DEFAULT_NATURE for a
   * new one. Only reaches the wire when the flag is on (see ExpenseEditForm). */
  nature: ExpenseNature;
  /** Item 1: the line's stored owner (party) snapshot + resolved name, seeded from
   * the ExpenseListItem. Drives the "Expense owner:" grouping for existing lines.
   * Both null on a not-yet-saved row (its owner comes from the picker at save). */
  partyId: string | null;
  partyName: string | null;
  /** Item 1: true when the row was seeded from server truth on mount (→ renders in
   * its owner group); false for a row added this session (→ the "Add expense"
   * section). Distinct from `id`: an auto-created-on-attach row gains an `id`
   * mid-session but stays `seeded:false` so it does NOT jump groups and unmount the
   * input being edited — the regrouping happens cleanly on the next reseed/remount. */
  seeded: boolean;
  /** This line's own settlement state, seeded from the ExpenseListItem. Drives the
   *  per-line edit lock via expense-lock.ts. `undefined` on a not-yet-persisted row
   *  (harmless — `id === null` short-circuits to editable) and on an older cached
   *  payload (locked, fail-closed). */
  settlement?: SettlementState;
};

type RowError = { field: "description" | "amount" | "actualCost" | "costPaymentStatus"; message: string };

let rowSeq = 0;
function newRow(withSST = false): EditableRow {
  rowSeq += 1;
  return { key: `new-${rowSeq}`, id: null, description: "", amount: "", withSST, actualCost: "", costVendor: "", costPaymentStatus: "unpaid", costPaymentDate: "", costPaymentAccount: "", costNotes: "", chargeCategoryId: null, nature: DEFAULT_NATURE, partyId: null, partyName: null, seeded: false };
}

/** Owner-avatar initials for the per-tenant group header (e.g. "Tan Wei Ming" → "TM").
 *  Legacy/unassigned owners (null name) fall back to a neutral dash. */
function initialsOf(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Sum a group's editable-row amounts for its subtotal, ignoring rows the user
 *  is mid-editing into a non-numeric value (so the header shows a clean figure,
 *  never "NaN MYR"). Empty string coerces to 0, which is the intended running total. */
function sumRowAmounts(rows: EditableRow[]): number {
  return rows.reduce((total, r) => {
    const n = Number(r.amount);
    return total + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/**
 * A locked line's value, rendered as text instead of a control.
 *
 * Deliberately NOT a `disabled` input: a greyed-out input still reads as "a field you
 * could fill in if something changed", and it keeps the value inside a form control that
 * the next refactor could re-enable by accident. Plain text says the value is a record,
 * not an entry field — and it cannot be typed into by any route, including autofill.
 * Height is matched to the sibling inputs so a mixed locked/editable row stays aligned.
 */
function ReadOnlyValue({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex min-h-9 items-center text-sm text-foreground/80 tabular-nums">{children}</p>
  );
}

function rowsFromActive(items: ExpenseListItem[], defaultWithSST = false): EditableRow[] {
  const active = items.filter((i) => i.status === "active");
  if (active.length === 0) return [newRow(defaultWithSST)];
  return active.map((i) => ({
    key: i.id,
    id: i.id,
    description: i.description,
    amount: i.amount,
    withSST: i.withSST,
    actualCost: i.actualCost ?? "",
    costVendor: i.costVendor ?? "",
    costPaymentStatus: i.costPaymentStatus ?? "unpaid",
    costPaymentDate: i.costPaymentDate?.slice(0, 10) ?? "",
    costPaymentAccount: i.costPaymentAccount ?? "",
    costNotes: i.costNotes ?? "",
    // ?? null: a stale/partial ExpenseListItem (e.g. an older cached fixture)
    // must degrade to "no category" rather than seed `undefined`, which would
    // make the dirty-check below fire a spurious PATCH on every untouched row
    // that has a category (original.chargeCategoryId !== undefined is always
    // true even with zero edits).
    chargeCategoryId: i.chargeCategoryId ?? null,
    // Task B2: seed from server truth (null/"expense" both normalize to the same
    // DEFAULT_NATURE — Task B1 treats them identically) so an existing Profit row
    // reloads with Profit selected, not silently reset. A stale/partial fixture
    // with no `nature` field also degrades to DEFAULT_NATURE via the same `!==
    // "profit" → expense` fallback.
    nature: i.nature === "profit" ? "profit" : DEFAULT_NATURE,
    // Item 1: seed the owner snapshot so existing lines group by tenant. `?? null`
    // guards older cached fixtures with no partyName field.
    partyId: i.partyId ?? null,
    partyName: i.partyName ?? null,
    // Deliberately NOT defaulted here. An absent field must stay `undefined` so
    // expenseLockState() can tell "server says this line is unbilled" from "this
    // payload carries no settlement fact at all" and fail CLOSED on the latter.
    // Coercing to "none" here would silently reopen a line we cannot prove is unpaid.
    settlement: i.settlement,
    seeded: true,
  }));
}

/**
 * Expense-line money rule: reuses parseAmountCell's amounts-only gate
 * (rejects `=`/formula/non-numeric), but ZERO — valid for a blank grid cell
 * — is invalid for an expense line (brief: "Zero is invalid for an expense
 * line").
 */
function validateAmount(raw: string): string | null {
  const parsed = parseAmountCell(raw);
  if (!parsed.ok) return parsed.message;
  if (parsed.value <= 0) return "Enter an amount greater than 0";
  return null;
}

function validateRows(rows: EditableRow[], validateInternalCosts: boolean): Record<string, RowError> {
  const errors: Record<string, RowError> = {};
  for (const row of rows) {
    if (!row.description.trim()) {
      errors[row.key] = { field: "description", message: "Description is required" };
      continue;
    }
    const amountError = validateAmount(row.amount);
    if (amountError) errors[row.key] = { field: "amount", message: amountError };
    if (validateInternalCosts && row.actualCost.trim()) {
      const parsedCost = parseAmountCell(row.actualCost);
      if (!parsedCost.ok) errors[row.key] = { field: "actualCost", message: parsedCost.message };
    }
    if (validateInternalCosts && row.costPaymentStatus === "paid" && !row.actualCost.trim()) {
      errors[row.key] = { field: "actualCost", message: "Enter the actual cost (enter 0 if there was no cost)" };
    }
  }
  return errors;
}

export function ExpensesDialog({ apartmentId, periodMonth, bearer, defaultWithSST = false, initialTenancy, tenancyOptions }: ExpensesDialogProps) {
  const canViewCosts = usePermission("cost.view");
  const canCreateCosts = usePermission("cost.create");
  const canEditCosts = usePermission("cost.edit");
  const canVoid = usePermission("billing.rebill");
  const canManageDocuments = usePermission("billing.document_manage");
  const queryClient = useQueryClient();
  const queryKey = ["bills-grid", "expenses", apartmentId, periodMonth, bearer];

  // T3 category picker — flag-gated exactly like charge-form.tsx:79,95. Flag
  // dark: no /charge-categories fetch fires (enabled:false) and the picker is
  // absent below — byte-for-byte the pre-T3 form.
  const flagOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const categoriesQuery = useChargeCategories({ enabled: flagOn });
  const activeCategories = (categoriesQuery.data?.items ?? []).filter((c) => c.active);

  // Task B2 — per-row Expense/Profit selector. Flag OFF: no selector renders below
  // and `nature` never reaches the create/update wire (byte-identical to pre-B2).
  const natureRoutingOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");

  // Silent-drop interlock: the backend only mints Charges for these expenses when
  // ENABLE_BILL_EXPENSES_AS_CHARGES is ON (mintExpenseChargesTx, service.ts). This editor
  // is otherwise gated only on ENABLE_PHASE2_BILLING_DOCS, so with that companion flag OFF an
  // admin can enter expenses that are saved but never billed — they vanish at Bill time with
  // no indication. Surface a warning so the drop is never silent. Gated additionally on
  // `flagOn` (BILLING_DOCS, universally ON in every real environment) purely to keep the
  // banner out of the pre-BILLING_DOCS byte-identical surface the legacy tests exercise.
  const expenseBillingOn = isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES");

  const listQuery = useQuery({
    queryKey,
    queryFn: () => listExpenses({ apartmentId, billingMonth: periodMonth, bearer }),
  });

  const items = listQuery.data?.items ?? [];
  // Grid cell = total only (brief): Σ amount over status === "active" ONLY —
  // void lines are shown in the itemised view but never counted here.
  const activeItems = items.filter((i) => i.status === "active");
  const activeTotal = activeItems.reduce((sum, i) => sum + Number(i.amount), 0);
  const costedItems = activeItems.filter((i) => i.actualCost != null);
  const recordedCost = costedItems.reduce((sum, i) => sum + Number(i.actualCost), 0);
  const recordedMargin = costedItems.reduce((sum, i) => sum + Number(i.amount) - Number(i.actualCost), 0);
  const costActionRequiredCount = activeItems.filter((i) => i.actualCost == null || (i.costPaymentStatus ?? "unpaid") !== "paid").length;

  // "Who owes what" at a glance (tenant bearer): per-owner subtotals from each
  // line's stored owner snapshot, first-seen order — the same grouping key the
  // editable form uses below, so the summary chips and the group headers agree.
  // Owner-bearer sheets have no per-party split, so this stays empty for them.
  const ownerBreakdown: Array<{ partyKey: string; partyName: string | null; total: number; count: number }> = [];
  if (bearer === "tenant") {
    const seen = new Map<string, number>();
    for (const i of activeItems) {
      const key = i.partyId ?? "__unassigned__";
      let gi = seen.get(key);
      if (gi === undefined) {
        gi = ownerBreakdown.length;
        seen.set(key, gi);
        ownerBreakdown.push({ partyKey: key, partyName: i.partyName ?? null, total: 0, count: 0 });
      }
      ownerBreakdown[gi].total += Number(i.amount);
      ownerBreakdown[gi].count += 1;
    }
  }

  const [viewOpen, setViewOpen] = useState(false);
  // Bumped after a successful save/void to remount ExpenseEditForm so it
  // reseeds from the freshly-refetched lines. The editable rows seed on mount
  // ONLY (see ExpenseEditForm), so a remount is how a post-write reset happens
  // without a background refetch clobbering in-progress edits.
  const [formNonce, setFormNonce] = useState(0);

  // R6: refresh the grid cell/badge AND reseed the inline form from server
  // truth. The expenses' own key is awaited so the remount below reads the
  // post-write lines, not the stale pre-write set.
  async function invalidateAndReseed() {
    await queryClient.invalidateQueries({ queryKey }); // expenses own key (await → fresh items)
    queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // refresh grid cell/badge
    setFormNonce((n) => n + 1);
  }

  // Void path: refresh the cell/badge/total but do NOT remount the form — the
  // form drops just the voided row locally (see ExpenseEditForm), so a manager's
  // in-progress edits to OTHER rows survive a void.
  function invalidateOnly() {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
  }

  return (
    <div className="space-y-4">
      {flagOn && !expenseBillingOn && (
        <Callout variant="warning" title="Expenses won't be billed">
          Expense billing is disabled in this environment, so any line added here is saved but will NOT
          appear on an invoice or Expense Bill when you click Bill. Enable ENABLE_BILL_EXPENSES_AS_CHARGES
          to bill these expenses.
        </Callout>
      )}
      {/* Financial summary — the total, plus (tenant bearer) a per-owner
          breakdown so "who owes what" is answered before scrolling into the
          editable lines. Gold glow = financial total (house GlowCard color map). */}
      <GlowCard glowColor="gold" className="p-4 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {bearer === "tenant" ? "Total owed by tenants" : "Total owner expenses"}
            </p>
            <p className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(activeTotal)}</p>
            {activeItems.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {activeItems.length} line{activeItems.length === 1 ? "" : "s"}
                {bearer === "tenant" && ownerBreakdown.length > 0
                  ? ` across ${ownerBreakdown.length} tenant${ownerBreakdown.length === 1 ? "" : "s"}`
                  : ""}
              </p>
            )}
          </div>
          {items.length > 0 && (
            <button
              type="button"
              aria-label="View expense lines"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
              onClick={() => setViewOpen(true)}
            >
              <Eye className="h-4 w-4" />
            </button>
          )}
        </div>

        {canViewCosts && activeItems.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/50 pt-3 text-xs">
            <div><span className="block text-muted-foreground">Direct costs</span><strong className="text-sm tabular-nums">{formatMoney(recordedCost)}</strong></div>
            <div><span className="block text-muted-foreground">Gross Margin</span><strong className="text-sm tabular-nums">{formatMoney(recordedMargin)}</strong></div>
            <div><span className="block text-muted-foreground">Action required</span><strong className={cn("text-sm", costActionRequiredCount > 0 && "text-orange-700")}>{costActionRequiredCount} item{costActionRequiredCount === 1 ? "" : "s"}</strong></div>
          </div>
        )}

        {/* Per-owner chips — only when more than one tenant carries expenses
            (a single owner is already fully described by the total above). */}
        {ownerBreakdown.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3">
            {ownerBreakdown.map((o) => (
              <span
                key={o.partyKey}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/60 px-2.5 py-1 text-xs"
              >
                <span className="text-muted-foreground">{o.partyName ?? "Unassigned"}</span>
                <span className="font-semibold tabular-nums text-foreground">{formatMoney(o.total)}</span>
              </span>
            ))}
          </div>
        )}
      </GlowCard>

      <ExpenseViewDialog open={viewOpen} onClose={() => setViewOpen(false)} items={items} canViewCosts={canViewCosts} />

      {/* The editable form renders directly. The sheet that hosts this widget
          IS the drawer, so gating the form behind a button + a nested
          FormDrawer (its own Sheet) meant two stacked drawers and a second
          click to reach the fields.

          Gated on isPending: ExpenseEditForm seeds its rows on MOUNT (not on
          prop change), so mounting it before listExpenses returns would seed the
          empty pre-fetch set and never show the existing lines. A background
          refetch keeps isPending false, so the form is never unmounted mid-edit.
          NOTE: a FAILED initial fetch also clears isPending with no data → a
          blank "add" form (same exposure as the old items.length trigger);
          surfacing that fetch error is a follow-up, out of scope here. */}
      {listQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ExpenseEditForm
          key={formNonce}
          apartmentId={apartmentId}
          periodMonth={periodMonth}
          bearer={bearer}
          defaultWithSST={defaultWithSST}
          items={items}
          initialTenancy={initialTenancy}
          tenancyOptions={tenancyOptions}
          canViewCosts={canViewCosts}
          canCreateCosts={canCreateCosts}
          canEditCosts={canEditCosts}
          canVoid={canVoid}
          canManageDocuments={canManageDocuments}
          categoryPickerOn={flagOn}
          categories={activeCategories}
          natureRoutingOn={natureRoutingOn}
          onSaved={invalidateAndReseed}
          onVoided={invalidateOnly}
        />
      )}
    </div>
  );
}

// ── Read-only itemised view (eye icon) — D7's "separate" view ───────────────

function ExpenseViewDialog({
  open,
  onClose,
  items,
  canViewCosts,
}: {
  open: boolean;
  onClose: () => void;
  items: ExpenseListItem[];
  canViewCosts: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Expense lines</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No expense lines yet.</p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2",
                  item.status !== "active" && "opacity-60",
                )}
              >
                <div>
                  <p className="text-sm text-foreground">{item.description}</p>
                  {canViewCosts && (
                    <p className="text-xs text-muted-foreground">
                      {item.actualCost == null
                        ? "Cost pending"
                        : `Cost ${formatMoney(Number(item.actualCost))} · Margin ${formatMoney(Number(item.amount) - Number(item.actualCost))}`}
                    </p>
                  )}
                  {item.status !== "active" && <p className="text-xs text-rose-500">Void</p>}
                </div>
                <p className="text-sm tabular-nums text-foreground">
                  {formatMoney(Number(item.amount))}
                  {item.withSST ? " (SST)" : ""}
                </p>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Party (tenancy) picker — client-side filter, name/unit/phone ───────────

function TenancyPicker({
  options,
  onSelect,
}: {
  options: ExpensesDialogTenancyOption[];
  onSelect: (t: { tenancyId: string; partyName: string }) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter(
        (o) =>
          o.partyName.toLowerCase().includes(needle) ||
          (o.unitCode ?? "").toLowerCase().includes(needle) ||
          (o.phone ?? "").toLowerCase().includes(needle),
      )
    : options;

  return (
    <div className="space-y-2">
      <TextInput
        aria-label="Search tenant by name, unit or phone"
        placeholder="Search by name, unit or phone"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No matching tenant.</p>
        ) : (
          filtered.map((o) => (
            <button
              key={o.tenancyId}
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/40"
              onClick={() => onSelect({ tenancyId: o.tenancyId, partyName: o.partyName })}
            >
              <span>{o.partyName}</span>
              <span className="text-xs text-muted-foreground">{[o.unitCode, o.phone].filter(Boolean).join(" · ")}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── Editable multi-line popup — create AND edit share this one form ────────

function ExpenseEditForm({
  apartmentId,
  periodMonth,
  bearer,
  defaultWithSST,
  items,
  initialTenancy,
  tenancyOptions,
  canViewCosts,
  canCreateCosts,
  canEditCosts,
  canVoid,
  canManageDocuments,
  categoryPickerOn,
  categories,
  natureRoutingOn,
  onSaved,
  onVoided,
}: {
  apartmentId: string;
  periodMonth: string;
  bearer: "tenant" | "owner";
  defaultWithSST: boolean;
  items: ExpenseListItem[];
  initialTenancy?: { tenancyId: string; partyName: string };
  tenancyOptions?: ExpensesDialogTenancyOption[];
  canViewCosts: boolean;
  canCreateCosts: boolean;
  canEditCosts: boolean;
  canVoid: boolean;
  canManageDocuments: boolean;
  /** T3: ENABLE_PHASE2_BILLING_DOCS flag — when false the picker is absent (no behavior change vs pre-T3). */
  categoryPickerOn: boolean;
  /** T3: active ChargeCategory list for the picker's options (already filtered to active — see ExpensesDialog). */
  categories: ChargeCategoryDto[];
  /** Task B2: ENABLE_CHARGE_NATURE_ROUTING flag — when false the per-row Nature selector
   * is absent and `nature` never reaches the create/update wire (no behavior change vs pre-B2). */
  natureRoutingOn: boolean;
  onSaved: () => void;
  onVoided: () => void;
}) {
  // Rows seed on mount ONLY — there is no open/close edge now the form renders
  // inline. A background listExpenses refetch must never clobber in-progress
  // edits, so the parent remounts this component (via a key) after a successful
  // write to pull server truth. See ExpensesDialog.invalidateAndReseed.
  const [rows, setRows] = useState<EditableRow[]>(() => rowsFromActive(items, defaultWithSST));
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [tenancy, setTenancy] = useState<{ tenancyId: string; partyName: string } | null>(() => {
    if (initialTenancy) return initialTenancy;
    // R4: auto-select when the unit has exactly one active tenant (whole unit, or a
    // partitioned unit with a single occupied room) — no dropdown to fumble. Multi-
    // tenant units start unselected and the existing missingTenancy guard (R5) bites.
    if (bearer === "tenant" && tenancyOptions && tenancyOptions.length === 1) {
      return { tenancyId: tenancyOptions[0].tenancyId, partyName: tenancyOptions[0].partyName };
    }
    return null;
  });
  const [tenancyError, setTenancyError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const newRows = rows.filter((r) => r.id === null);
      const existingRows = rows.filter((r) => r.id !== null);
      // Updates run FIRST, the single createExpenses runs LAST (I-1 fix).
      // Create-first left a window where a later updateExpense failure
      // (e.g. concurrent Bill → 409 ENTRY_LOCKED, or a network drop) left
      // newly-created rows persisted with the dialog still open and those
      // rows still id: null — a Save retry would re-fire createExpenses for
      // the same rows, double-counting them in the active total. With
      // updates first, an update failure aborts the save before anything is
      // created, so there is never an orphan create to duplicate on retry.
      for (const r of existingRows) {
        // Server-truth baseline for the dirty-check. A row present at mount came
        // from rowsFromActive(items) so it IS in `items`. The ONE id-bearing row
        // that is NOT in `items` is one auto-created THIS session by the attach
        // path (ensureRowPersisted writes the id in place without refreshing
        // listQuery) — fall back to its recorded created-value baseline so an edit
        // made after the attach is detected and PATCHed via updateExpense, never a
        // SECOND createExpenses. (Skipping it — the old `if (!original) continue`
        // — silently dropped that money edit.)
        const original = items.find((i) => i.id === r.id) ?? createdBaselinesRef.current.get(r.id as string);
        if (!original) continue;
        // Belt-and-braces with the render lock: a locked line has no editable control, so
        // its values cannot diverge from `original` and the dirty-check below would not
        // fire anyway. Skipping explicitly means a future control added to a locked line
        // (or a stale row left in state across a settlement) can never send a PATCH the
        // server would answer with 409 ENTRY_LOCKED — which, in this all-or-nothing save,
        // would fail the WHOLE batch and lose the admin's edits to the OTHER lines.
        const locked = isExpenseLineLocked(r);
        const normalizedAmount = Number(r.amount).toFixed(2);
        const normalizedActualCost = r.actualCost.trim() ? Number(r.actualCost).toFixed(2) : null;
        // `original.chargeCategoryId ?? null`: degrades a stale/partial fixture's
        // absent key to "no category" instead of comparing against `undefined`,
        // which would make this OR-clause true (and PATCH fire) on every
        // untouched row that happens to have a category set (see rowsFromActive's
        // matching `?? null` coercion above).
        const categoryChanged = (original.chargeCategoryId ?? null) !== r.chargeCategoryId;
        // Task B2: mirrors categoryChanged's normalize-then-compare shape (original.nature
        // may be an ExpenseListItem's raw `string | null` OR a baseline's already-normalized
        // ExpenseNature — normalizing both sides the same way rowsFromActive did keeps the
        // comparison like-for-like). Gated on natureRoutingOn so a flag-OFF save NEVER sends
        // `nature`, even if local state happens to differ from server truth.
        const natureChanged = natureRoutingOn && (original.nature === "profit" ? "profit" : DEFAULT_NATURE) !== r.nature;
        const costChanged = canEditCosts && (
          (original.actualCost ?? null) !== normalizedActualCost ||
          (original.costVendor ?? "") !== r.costVendor.trim() ||
          (original.costPaymentStatus ?? "unpaid") !== r.costPaymentStatus ||
          (original.costPaymentDate?.slice(0, 10) ?? "") !== r.costPaymentDate ||
          (original.costPaymentAccount ?? "") !== r.costPaymentAccount.trim() ||
          (original.costNotes ?? "") !== r.costNotes.trim());
        if (locked && costChanged) {
          // Payments freeze what the customer was charged, not the internal
          // supplier-cost bookkeeping. Send a cost-only patch so the server can
          // preserve the immutable charge while the admin completes actual cost.
          await updateExpense(r.id as string, {
            actualCost: normalizedActualCost,
            costVendor: r.costVendor.trim() || null,
            costPaymentStatus: r.costPaymentStatus,
            costPaymentDate: r.costPaymentDate || null,
            costPaymentAccount: r.costPaymentAccount.trim() || null,
            costNotes: r.costNotes.trim() || null,
          });
          continue;
        }
        if (locked) continue;
        if (
          original.description !== r.description.trim() ||
          original.amount !== normalizedAmount ||
          original.withSST !== r.withSST ||
          categoryChanged ||
          natureChanged ||
          costChanged
        ) {
          await updateExpense(r.id as string, {
            description: r.description.trim(),
            amount: normalizedAmount,
            withSST: r.withSST,
            // Only send chargeCategoryId when it actually changed (GAP 1 fix,
            // T7 review). A row can carry a STALE category id in state — e.g.
            // saved while the category was active, later deactivated; the
            // active-only picker options never re-offer it, so the <select>
            // renders blank while state still holds the old id. Sending that
            // stale id unconditionally would resend it on ANY unrelated
            // description/amount edit, and the API's inactive-category guard
            // (Task 4) 400s the ENTIRE all-or-nothing save on it. Omitting the
            // key when unchanged means the server never re-validates it, so an
            // unrelated edit succeeds; a genuine category change still sends
            // the key and gets validated (correctly rejecting inactive/foreign
            // ids for a NEWLY picked category).
            ...(categoryChanged ? { chargeCategoryId: r.chargeCategoryId } : {}),
            // Same omit-unless-changed discipline for nature (Task B2) — an
            // untouched row never resends it, so a flag-OFF-when-saved / server-null
            // row is never spuriously overwritten.
            ...(natureChanged ? { nature: r.nature } : {}),
            ...(costChanged ? {
              actualCost: normalizedActualCost,
              costVendor: r.costVendor.trim() || null,
              costPaymentStatus: r.costPaymentStatus,
              costPaymentDate: r.costPaymentDate || null,
              costPaymentAccount: r.costPaymentAccount.trim() || null,
              costNotes: r.costNotes.trim() || null,
            } : {}),
          });
        }
      }
      // All-or-nothing at the write step too: new rows go in ONE batched
      // createExpenses call — never one POST per row, never a partial set.
      if (newRows.length > 0) {
        await createExpenses({
          apartmentId,
          billingMonth: periodMonth,
          bearer,
          tenancyId: bearer === "tenant" ? tenancy?.tenancyId : undefined,
          items: newRows.map((r) => ({
            description: r.description.trim(),
            amount: Number(r.amount).toFixed(2),
            withSST: r.withSST,
            // Only include chargeCategoryId when truthy (GAP 2 fix, T7 review):
            // flag-off / no-category creates omit the key entirely, matching
            // the pre-T7 wire shape (the key was previously absent, not null).
            ...(r.chargeCategoryId ? { chargeCategoryId: r.chargeCategoryId } : {}),
            // Task B2: only when the flag is on — flag-OFF creates omit the key
            // entirely (byte-identical wire to pre-B2), even though `r.nature`
            // always holds a concrete local value.
            ...(natureRoutingOn ? { nature: r.nature } : {}),
            ...(canCreateCosts && r.actualCost.trim() ? { actualCost: Number(r.actualCost).toFixed(2) } : {}),
            ...(canCreateCosts && r.costVendor.trim() ? { costVendor: r.costVendor.trim() } : {}),
            ...(canCreateCosts && r.costPaymentStatus !== "unpaid" ? { costPaymentStatus: r.costPaymentStatus } : {}),
            ...(canCreateCosts && r.costPaymentDate ? { costPaymentDate: r.costPaymentDate } : {}),
            ...(canCreateCosts && r.costPaymentAccount.trim() ? { costPaymentAccount: r.costPaymentAccount.trim() } : {}),
            ...(canCreateCosts && r.costNotes.trim() ? { costNotes: r.costNotes.trim() } : {}),
          })),
        });
      }
    },
    onSuccess: () => {
      toast.success("Expense saved.");
      onSaved();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    },
  });

  const voidMutation = useMutation({
    mutationFn: (expenseId: string) => voidExpense(expenseId),
    onSuccess: (_data, expenseId) => {
      toast.success("Expense line voided.");
      // Drop just the voided row locally so in-progress edits to OTHER rows
      // survive (the parent does NOT remount on void). Keep ≥1 row so the form
      // never collapses to an empty state.
      setRows((prev) => {
        const next = prev.filter((r) => r.id !== expenseId);
        return next.length > 0 ? next : [newRow(defaultWithSST)];
      });
      onVoided();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Void failed.");
    },
  });

  function updateRow(key: string, patch: Partial<EditableRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // A1 auto-save-on-attach (spec R7): picking a photo on a not-yet-persisted
  // line single-creates JUST that line (reusing the batch Save's createExpenses
  // body shape exactly — same tenancyId-for-tenant-bearer resolution, no new
  // money mutation) to obtain its id, writes the id IN PLACE (no form remount),
  // and returns it so LineAttachments can upload against it. Returns null when
  // the line can't persist (invalid, missing tenant, or a lock contends), which
  // aborts the upload.
  //
  // R7.4 in-flight lock — a REF (not state) so two SYNCHRONOUS rapid picks can't
  // both read it empty before a re-render flushes; keyed by row.key so distinct
  // lines lock independently.
  const persistingRef = useRef<Set<string>>(new Set());
  // Created-value baseline for rows auto-created THIS session by the attach path.
  // ensureRowPersisted writes the row's id into state in place but never refreshes
  // listQuery, so the created id is NOT in `items`. Without this map the batch
  // save's `items.find(...)` returns undefined for such a row and the row is
  // SKIPPED — a post-attach edit to its amount/description/withSST/category is
  // silently dropped (adversarial-review money bug). Keyed by the new id, holding
  // the exact values just created (same normalization as the create body), so the
  // save's EXISTING dirty-check fires only when the current row differs — no
  // redundant PATCH when nothing changed after the attach.
  const createdBaselinesRef = useRef<Map<string, {
    description: string; amount: string; withSST: boolean; chargeCategoryId: string | null; nature: ExpenseNature;
    actualCost: string | null; costVendor: string | null; costPaymentStatus: "unpaid" | "partial" | "paid";
    costPaymentDate: string | null; costPaymentAccount: string | null; costNotes: string | null;
  }>>(new Map());
  async function ensureRowPersisted(row: EditableRow): Promise<string | null> {
    if (row.id) return row.id; // already persisted
    if (persistingRef.current.has(row.key)) return null; // R7.4 lock (synchronous)
    if (!row.description.trim() || validateAmount(row.amount) !== null) return null; // R7.1 precondition
    if (bearer === "tenant" && !tenancy) return null; // tenant precondition
    persistingRef.current.add(row.key);
    try {
      // Same body shape as the batch saveMutation's create (tenancyId for the
      // tenant bearer; chargeCategoryId key only when truthy — GAP-2 pattern;
      // nature key only when the flag is on — Task B2).
      const res = await createExpenses({
        apartmentId,
        billingMonth: periodMonth,
        bearer,
        tenancyId: bearer === "tenant" ? tenancy?.tenancyId : undefined,
        items: [
          {
            description: row.description.trim(),
            amount: Number(row.amount).toFixed(2),
            withSST: row.withSST,
            ...(row.chargeCategoryId ? { chargeCategoryId: row.chargeCategoryId } : {}),
            ...(natureRoutingOn ? { nature: row.nature } : {}),
            ...(canCreateCosts && row.actualCost.trim() ? { actualCost: Number(row.actualCost).toFixed(2) } : {}),
            ...(canCreateCosts && row.costVendor.trim() ? { costVendor: row.costVendor.trim() } : {}),
            ...(canCreateCosts && row.costPaymentStatus !== "unpaid" ? { costPaymentStatus: row.costPaymentStatus } : {}),
            ...(canCreateCosts && row.costPaymentDate ? { costPaymentDate: row.costPaymentDate } : {}),
            ...(canCreateCosts && row.costPaymentAccount.trim() ? { costPaymentAccount: row.costPaymentAccount.trim() } : {}),
            ...(canCreateCosts && row.costNotes.trim() ? { costNotes: row.costNotes.trim() } : {}),
          },
        ],
      });
      const newId = res.ids[0] ?? null;
      if (newId) {
        updateRow(row.key, { id: newId }); // R7.3 write id IN PLACE — no remount
        // Record the just-created values as this id's server-truth baseline. The
        // shape/normalization MUST match what was sent above (trimmed description,
        // 2-dp amount, chargeCategoryId ?? null, nature) so the save's dirty-check
        // compares current-row vs created-value like-for-like — an untouched row
        // won't PATCH, a later edit will. This is what listQuery would hold if it
        // were refreshed.
        createdBaselinesRef.current.set(newId, {
          description: row.description.trim(),
          amount: Number(row.amount).toFixed(2),
          withSST: row.withSST,
          chargeCategoryId: row.chargeCategoryId ?? null,
          nature: row.nature,
          actualCost: row.actualCost.trim() ? Number(row.actualCost).toFixed(2) : null,
          costVendor: row.costVendor.trim() || null,
          costPaymentStatus: row.costPaymentStatus,
          costPaymentDate: row.costPaymentDate || null,
          costPaymentAccount: row.costPaymentAccount.trim() || null,
          costNotes: row.costNotes.trim() || null,
        });
      }
      return newId;
    } finally {
      persistingRef.current.delete(row.key);
    }
  }

  function addRow() {
    setRows((prev) => [...prev, newRow(defaultWithSST)]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  function handleSubmit() {
    // All-or-nothing (brief): ONE bad line (empty description or an invalid
    // amount) blocks the WHOLE save and highlights the offending line — no
    // partial persist, createExpenses/updateExpense must not fire.
    const errors = validateRows(rows, canCreateCosts || canEditCosts);
    const missingTenancy = bearer === "tenant" && !tenancy && rows.some((r) => r.id === null);
    if (Object.keys(errors).length > 0 || missingTenancy) {
      setRowErrors(errors);
      setTenancyError(missingTenancy ? "Select a tenant before saving" : null);
      return;
    }
    setRowErrors({});
    setTenancyError(null);
    saveMutation.mutate();
  }

  // Item 1: split already-saved lines (grouped by owner) from not-yet-saved ones
  // (the "Add expense" section). Grouping is a pure transform of `rows`; the
  // save/dirty-check logic above operates on `rows` unchanged.
  const newRows = rows.filter((r) => !r.seeded);
  const ownerGroups: Array<{ partyKey: string; partyName: string | null; rows: EditableRow[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const r of rows) {
    if (!r.seeded) continue; // rows added this session render in the Add-expense section
    const key = r.partyId ?? "__unassigned__";
    let gi = groupIndex.get(key);
    if (gi === undefined) {
      gi = ownerGroups.length;
      groupIndex.set(key, gi);
      ownerGroups.push({ partyKey: key, partyName: r.partyName, rows: [] });
    }
    ownerGroups[gi].rows.push(r);
  }

  // "Line N" numbering follows VISUAL order — grouped (seeded) rows top-to-bottom,
  // then the add-expense rows — so a two-tenant unit reads Line 1..N down the sheet
  // instead of the raw server array order, which surfaced as a scrambled "Line 1,
  // Line 4, Line 2, Line 3". Owner-bearer sheets are a flat list and use their own
  // array index in the render below.
  const displayOrder = [...ownerGroups.flatMap((g) => g.rows), ...newRows];
  const displayIndexByKey = new Map(displayOrder.map((r, i) => [r.key, i] as const));

  const renderRowCard = (row: EditableRow, index: number) => {
    const rowError = rowErrors[row.key];
    const canManageThisCost = row.id ? canEditCosts : canCreateCosts;
    // Per-line lock (expense-lock.ts). The server freezes an expense line once money has
    // arrived for its month; until now this dialog rendered live inputs over exactly that
    // money, so an edit looked accepted and then failed on Save with `409 ENTRY_LOCKED`.
    // A locked line renders its values as text with a state pill, and loses Void and
    // attachment-upload — every affordance that would end in a server rejection.
    const locked = isExpenseLineLocked(row);
    const lockLabel = expenseLockLabel(row);
    return (
      <div
        key={row.key}
        className={cn(
          "space-y-2 rounded-lg border border-border/50 bg-background/40 p-3",
          locked && "border-emerald-500/30 bg-emerald-500/5",
        )}
      >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Line {index + 1}
                  </span>
                  <div className="flex items-center gap-2">
                    {lockLabel && (
                      <span
                        data-testid="expense-line-lock"
                        className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600"
                      >
                        {lockLabel}
                      </span>
                    )}
                    {row.id && canVoid && !locked && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-rose-600 hover:text-rose-500"
                        disabled={voidMutation.isPending}
                        onClick={() => voidMutation.mutate(row.id as string)}
                      >
                        Void
                      </Button>
                    )}
                    {row.id === null && (
                      // Trash is limited to un-saved (id === null) rows —
                      // a persisted row only local-dropped from the edit set
                      // would reappear on reopen (misleading). Persisted
                      // rows retire ONLY through the manager-gated Void
                      // control above.
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={`Remove line ${index + 1}`}
                        onClick={() => removeRow(row.key)}
                        disabled={rows.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* One row per line: Category (left, compact) · Nature (Task B2,
                    flag-gated) · Description (widest) · Amount (narrow) · SST.
                    The Category/Nature columns are dropped when their own flag
                    is dark — the two ORIGINAL (no-nature) branches below stay
                    byte-identical strings to pre-B2. Stacks on mobile. */}
                <div
                  className={cn(
                    "grid grid-cols-1 gap-3 sm:items-end",
                    categoryPickerOn && natureRoutingOn && "sm:grid-cols-[1.2fr_1.2fr_4fr_1fr_auto]",
                    categoryPickerOn && !natureRoutingOn && "sm:grid-cols-[1.4fr_4fr_1fr_auto]",
                    !categoryPickerOn && natureRoutingOn && "sm:grid-cols-[1.2fr_4fr_1fr_auto]",
                    !categoryPickerOn && !natureRoutingOn && "sm:grid-cols-[4fr_1fr_auto]",
                  )}
                >
                  {categoryPickerOn && (
                    // Classify-only (spec R3): no "Will issue …" issuance-preview
                    // line here — unlike charge-form.tsx, this picker never routes
                    // a document, it only tags the line for reporting.
                    //
                    // Options are scoped to THIS sheet's bearer (owner sheet → owner-side
                    // categories, tenant sheet → tenant-side) — previously every active
                    // category was listed, so an owner expense line offered "Subsidy
                    // (tenant)". The row's own current category is always kept in the
                    // list (categoriesForBearer's keepIds) so a line saved before this
                    // filter, or under the other bearer, still renders its real category
                    // instead of silently reading as "No category".
                    <Field label="Category">
                      {locked ? (
                        <ReadOnlyValue>
                          {categoriesForBearer(categories, bearer, [row.chargeCategoryId]).find((c) => c.id === row.chargeCategoryId)?.name
                            ?? "No category"}
                        </ReadOnlyValue>
                      ) : (
                      <SelectInput
                        aria-label={`Line ${index + 1} category`}
                        value={row.chargeCategoryId ?? ""}
                        onChange={(e) => updateRow(row.key, { chargeCategoryId: e.target.value || null })}
                      >
                        <option value="">No category</option>
                        {categoriesForBearer(categories, bearer, [row.chargeCategoryId]).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.profitExpense ? `${c.name} · ${c.profitExpense}` : c.name}
                          </option>
                        ))}
                      </SelectInput>
                      )}
                    </Field>
                  )}
                  {natureRoutingOn && (
                    // Task B2: routes this line to the tenant Invoice/owner Invoice as
                    // KAEN revenue (Profit) instead of the default Expense Bill/owner
                    // deduction (Expense) — Task B1 owns the actual routing logic; this
                    // control only picks the per-row value.
                    <Field label="Nature">
                      {locked ? (
                        <ReadOnlyValue>{row.nature === "profit" ? "Profit" : "Expense"}</ReadOnlyValue>
                      ) : (
                      <Segmented<ExpenseNature>
                        size="sm"
                        ariaLabel={`Line ${index + 1} nature`}
                        value={row.nature}
                        onChange={(v) => updateRow(row.key, { nature: v })}
                        options={NATURE_OPTIONS}
                      />
                      )}
                    </Field>
                  )}
                  <Field label="Description" error={rowError?.field === "description" ? rowError.message : null}>
                    {locked ? (
                      <ReadOnlyValue>{row.description}</ReadOnlyValue>
                    ) : (
                    <TextInput
                      aria-label={`Line ${index + 1} description`}
                      value={row.description}
                      onChange={(e) => updateRow(row.key, { description: e.target.value })}
                      placeholder="e.g. Aircond repair"
                    />
                    )}
                  </Field>
                  <Field label="Amount (RM)" error={rowError?.field === "amount" ? rowError.message : null}>
                    {locked ? (
                      <ReadOnlyValue>{row.amount}</ReadOnlyValue>
                    ) : (
                    <TextInput
                      type="text"
                      inputMode="decimal"
                      aria-label={`Line ${index + 1} amount`}
                      value={row.amount}
                      onChange={(e) => updateRow(row.key, { amount: e.target.value })}
                      placeholder="0.00"
                    />
                    )}
                  </Field>
                  <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={row.withSST}
                      disabled={locked}
                      onCheckedChange={(checked) => updateRow(row.key, { withSST: checked === true })}
                      aria-label={`Line ${index + 1} with SST`}
                    />
                    SST
                  </label>
                </div>

                {canViewCosts && <div className="rounded-lg border border-amber-300/70 bg-amber-50/50 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-[var(--navy-text)]">Internal cost tracking</p>
                    {row.actualCost.trim() && row.costPaymentStatus === "paid" ? (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800">
                        Gross Margin: {formatMoney(Number(row.amount || 0) - Number(row.actualCost || 0))}
                      </span>
                    ) : (
                      <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-bold text-orange-800">
                        {!row.actualCost.trim() ? "Enter actual cost" : "Payment follow-up"}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <Field label="Actual cost (RM)" error={rowError?.field === "actualCost" ? rowError.message : null}>
                      <TextInput disabled={!canManageThisCost} type="text" inputMode="decimal" aria-label={`Line ${index + 1} actual cost`} value={row.actualCost} onChange={(e) => updateRow(row.key, { actualCost: e.target.value })} placeholder="Enter 0 if there was no cost" />
                    </Field>
                    <Field label="Vendor / Paid to">
                      <TextInput disabled={!canManageThisCost} aria-label={`Line ${index + 1} cost vendor`} value={row.costVendor} onChange={(e) => updateRow(row.key, { costVendor: e.target.value })} placeholder="Supplier or payee" />
                    </Field>
                    <Field label="Cost payment status" error={rowError?.field === "costPaymentStatus" ? rowError.message : null}>
                      <SelectInput disabled={!canManageThisCost} aria-label={`Line ${index + 1} cost payment status`} value={row.costPaymentStatus} onChange={(e) => updateRow(row.key, { costPaymentStatus: e.target.value as EditableRow["costPaymentStatus"] })}>
                        <option value="unpaid">Unpaid</option><option value="partial">Partially Paid</option><option value="paid">Paid</option>
                      </SelectInput>
                    </Field>
                    <Field label="Payment date">
                      <TextInput disabled={!canManageThisCost} type="date" aria-label={`Line ${index + 1} cost payment date`} value={row.costPaymentDate} onChange={(e) => updateRow(row.key, { costPaymentDate: e.target.value })} />
                    </Field>
                    <Field label="Payment account">
                      <TextInput disabled={!canManageThisCost} aria-label={`Line ${index + 1} cost payment account`} value={row.costPaymentAccount} onChange={(e) => updateRow(row.key, { costPaymentAccount: e.target.value })} placeholder="e.g. Maybank" />
                    </Field>
                    <Field label="Cost remarks">
                      <TextInput disabled={!canManageThisCost} aria-label={`Line ${index + 1} cost remarks`} value={row.costNotes} onChange={(e) => updateRow(row.key, { costNotes: e.target.value })} placeholder="Payment/reference notes" />
                    </Field>
                  </div>
                </div>}

                {/* Per-line attachments (T1, spec R5–R8). canUpload is the A1
                    precondition (a valid line + a tenant for a tenant-bearer
                    sheet); on an unsaved line, picking a photo routes through
                    ensureRowPersisted, which single-creates the line and writes
                    its id in place before uploading. Delete reuses the existing
                    manager-gated route. Coexists with the entry-level month
                    AttachmentsPanel — neither replaces the other.

                    DELIBERATELY still available on a LOCKED line: an attachment is
                    evidence, not money, and the server's ENTRY_LOCKED guards cover
                    create/update/void of the expense itself — not its attachments. Filing
                    the receipt photo for a line that has already been paid is exactly when
                    an admin needs to. Withholding it here would over-lock past the server
                    and cost an upload the API would have accepted. */}
                {canManageDocuments && <LineAttachments
                  expenseId={row.id}
                  apartmentId={apartmentId}
                  canUpload={
                    !!row.description.trim() &&
                    validateAmount(row.amount) === null &&
                    (bearer !== "tenant" || !!tenancy)
                  }
                  uploadHint={
                    !row.description.trim() || validateAmount(row.amount) !== null
                      ? "Add a description and amount to attach"
                      : bearer === "tenant" && !tenancy
                        ? "Select a tenant first"
                        : null
                  }
                  isManager
                  onEnsurePersisted={() => ensureRowPersisted(row)}
                />}
              </div>
    );
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <div className="space-y-4">
        {bearer === "tenant" ? (
          <>
            {/* Item 1 (R2): existing lines grouped by their stored owner. A line
                whose partyId no longer resolves (or is legacy-null) groups under
                "Unassigned"; its owner is read from the record, never re-inferred
                from the unit (R6). */}
            {ownerGroups.map((group) => (
              <div
                key={group.partyKey}
                className="overflow-hidden rounded-lg border border-border/50 bg-background/40"
                data-testid="expense-owner-group"
              >
                {/* Owner header: initials + name + line count on the left, the
                    owner's SUBTOTAL on the right — so each tenant's total reads
                    without summing the lines by eye. The data-testid element holds
                    ONLY "Expense owner: <name>" (the subtotal is a sibling). */}
                <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-xs font-semibold text-amber-600">
                      {initialsOf(group.partyName)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground" data-testid="expense-owner-header">
                        Expense owner: {group.partyName ?? "Unassigned"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {group.rows.length} line{group.rows.length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-bold tabular-nums text-foreground">{formatMoney(sumRowAmounts(group.rows))}</div>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">owes</div>
                  </div>
                </div>
                <div className="space-y-2 p-3">
                  {group.rows.map((row) => renderRowCard(row, displayIndexByKey.get(row.key) ?? 0))}
                </div>
              </div>
            ))}

            {/* Item 1 (R3/R4/R5): new lines are added here; the picker applies the
                selected tenant to them on save. Auto-selected when there is exactly
                one active tenant (R4); required when there are several (R5). */}
            <div className="space-y-3 rounded-lg border border-dashed border-border/50 p-3" data-testid="add-expense-section">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add expense</div>
              <Field label="Tenant" error={tenancyError}>
                {initialTenancy ? (
                  <p className="text-sm text-foreground">{initialTenancy.partyName}</p>
                ) : tenancy ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">{tenancy.partyName}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => setTenancy(null)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <TenancyPicker options={tenancyOptions ?? []} onSelect={setTenancy} />
                )}
              </Field>
              {newRows.map((row) => renderRowCard(row, displayIndexByKey.get(row.key) ?? 0))}
              <Button type="button" variant="outline" onClick={addRow} className="w-full gap-2 border-dashed">
                <Plus className="h-4 w-4" />
                Add line
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-3">
              {rows.map((row, index) => renderRowCard(row, index))}
            </div>
            <Button type="button" variant="outline" onClick={addRow} className="w-full gap-2 border-dashed">
              <Plus className="h-4 w-4" />
              Add line
            </Button>
          </>
        )}

        <Button type="submit" variant="gold" disabled={saveMutation.isPending} className="w-full">
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
