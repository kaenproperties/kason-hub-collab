// Bills & Expenses Grid — the toolbar (UI Task 10). Pure + props-driven, same
// discipline as grid-table.tsx: no fetch, no store, no staged-edit read. The
// page shell (bills-grid-page.tsx) owns all state and passes it in.
import { ChevronDown, Undo2, Redo2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ColumnFilters, DateRange } from "./use-column-filter";
import type { GridColumn } from "./columns";

export type GridExportKind =
  | "data-xlsx" | "data-pdf" | "selected-data-xlsx" | "selected-data-pdf"
  | "payout-zip" | "selected-payout-zip"
  | "payout-summary-xlsx" | "selected-payout-summary-xlsx";

// ui-task-10e (c): a few preset swatches + "clear" (empty string) is enough —
// colour is COSMETIC localStorage only (view-prefs.ts), never a fetch/API/calc
// input (R31c). "Clear" applies "" — GridTable's cellColour?.() falsy-check
// (`colour ? {...} : undefined`) treats "" the same as no colour at all.
const COLOUR_SWATCHES: Array<{ colour: string; label: string }> = [
  { colour: "#7C3AED", label: "Violet" },
  { colour: "#4338CA", label: "Indigo" },
  { colour: "#C026D3", label: "Fuchsia" },
  { colour: "#92400E", label: "Brown" },
  { colour: "#374151", label: "Charcoal" },
];

// The keys the grid's OWN keydown handler (use-grid-keyboard.ts) hijacks for
// cell nav / commit / clear. ONLY these must be stopped from reaching the grid
// when typed inside a filter input; every OTHER key — crucially the global
// Cmd/Ctrl+K search palette (search-command.tsx) and any other document-level
// shortcut — must keep bubbling to `document`.
const GRID_HIJACKED_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Escape",
]);

/**
 * Bug fix — filter inputs unusable (Backspace/Delete/arrows/Enter dead) in
 * fullscreen.
 *
 * In maximized mode this toolbar renders INSIDE the grid-region div, which owns a
 * NATIVE `addEventListener("keydown")` (use-grid-keyboard.ts) that intercepts
 * those keys for cell nav/clear and calls preventDefault. A React `onKeyDown`
 * here would NOT help: React delegates events at the document root, so the grid's
 * native ancestor listener fires FIRST during bubbling — a synthetic
 * stopPropagation runs too late (verified empirically). Attaching a NATIVE
 * listener directly on the input stops the event AT the input, before it can
 * climb to the grid.
 *
 * SELECTIVE (review #1): only the grid-hijacked keys are stopped. A blanket
 * stopPropagation would also swallow Cmd/Ctrl+K (global search) while a filter
 * input is focused. Returns a React-19 ref cleanup so the listener is removed on
 * unmount (and on StrictMode's mount/unmount/mount — no double-attach, #2).
 */
function stopKeydownAtInput(node: HTMLInputElement | null) {
  if (!node) return;
  const handler = (e: KeyboardEvent) => {
    if (GRID_HIJACKED_KEYS.has(e.key)) e.stopPropagation();
  };
  node.addEventListener("keydown", handler);
  return () => node.removeEventListener("keydown", handler);
}

export interface GridToolbarProps {
  periods: string[];
  selectedPeriods: string[];
  onPeriodsChange: (next: string[]) => void; // R6 latest FIRST
  // ── Billing-month anchor navigator ─────────────────────────────────────────
  // The anchor is the PRIMARY (billable) month the grid is centred on. Unlike the
  // multi-month "History" chips above — which only ever list the server's loaded
  // window — the anchor can move to ANY month: a past month to review what was
  // billed, or a future month to prepare ahead. `currentBillingMonth` is the
  // server's OWN current period (captured from the first, default fetch), so the
  // status pill + Bill gate never depend on the browser clock.
  anchorMonth: string; // "YYYY-MM-01" (empty only before the first load)
  currentBillingMonth: string; // "YYYY-MM-01" | "" (unknown until first load)
  onStepMonth: (delta: number) => void; // prev/next arrows (±1 month)
  onAnchorMonthChange: (monthIso: string) => void; // month <input> + jump-to-current
  properties: Array<{ id: string; name: string }>;
  propertyId: string | "all";
  onPropertyChange: (next: string | "all") => void; // R29 "Categorize", default "all"
  dirtyCount: number;
  onSave: () => void; // R23 Save enabled only when dirtyCount > 0
  canEditAction?: boolean;
  canSaveAction?: boolean;
  canBillAction?: boolean;
  canExportAction?: boolean;
  // Excel-Web V2 — undo/redo over the staged edit buffer. In-memory only; undo/redo
  // never issue a server write. Buttons disable when the respective stack is empty.
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  onUndo: () => void;
  onRedo: () => void;
  selectedRowCount: number; // # of units the user CHECKED for billing (not all billable)
  onBill: () => void; // R25 Bill enabled only when a unit is selected (> 0)
  // Bill is available for the current and immediately following billing month.
  // Past and farther-future periods remain blocked; the server repeats this guard.
  canBillPeriod: boolean;
  canExport: boolean;
  onExport: (kind: GridExportKind) => void; // R30 false on zero visible rows
  selectedExportCount?: number;
  // R31(e) — column/date filter, crossed with the property filter above.
  columnFilters: ColumnFilters;
  onColumnFilterChange: (columnId: string, value: string) => void;
  colourFilters?: BillingColourFilter[];
  onColourFiltersChange?: (next: BillingColourFilter[]) => void;
  ownerPayoutFilters?: OwnerPayoutFilter[];
  onOwnerPayoutFiltersChange?: (next: OwnerPayoutFilter[]) => void;
  displayMode?: GridDisplayMode;
  onDisplayModeChange?: (next: GridDisplayMode) => void;
  dateRange: DateRange;
  onDateRangeChange: (next: DateRange) => void;
  // R31(c) — colour-fill. Swatches enabled only while a drag-select range is
  // active; the page shell resolves `sel.range` into cell writes via
  // useGridSelection().setColour before calling back up here.
  hasSelection: boolean;
  onApplyColour: (colour: string) => void;
  // R31(d) — hide-column. `columns` is the full CURRENT_COLUMNS list (Export
  // still needs the unfiltered set — see bills-grid-page.tsx); only columns
  // carrying a `band` (data columns) are hideable, unitCode never is.
  columns: GridColumn[];
  hiddenColumns: string[];
  onToggleColumn: (id: string) => void;
  // Task 2 (P3) — vacant filter. Default hidden (see bills-grid-page.tsx's
  // `loadPref(..., "showVacant", false)`); a vacant unit carrying a saved
  // entry (owner charges) is never hidden regardless of this toggle — see
  // occupancy.ts's `visibleUnits` money-safety guard.
  showVacant: boolean;
  onToggleShowVacant: () => void;
  viewControls?: ReactNode;
}

/** Inserts `period` into `selectedPeriods` (toggling it out if already present)
 * and sorts DESCENDING so the latest always renders/lands at index 0 (R6) —
 * regardless of click order, `selectedPeriods[0]` stays the latest period the
 * page shell keys its staged-edit buffer / grid remount under. */
function toggledDesc(selected: string[], period: string): string[] {
  const next = selected.includes(period) ? selected.filter((p) => p !== period) : [...selected, period];
  return [...next].sort().reverse();
}

// Inline chevrons (no-emoji rule): stroke-only SVG that inherits `currentColor`,
// so they theme with the button text in both light and dark.
function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Classify the anchor against the server's current month for the status pill. */
function periodStatusOf(anchorMonth: string, currentBillingMonth: string):
  | { tone: "current" | "past" | "future"; label: string }
  | null {
  if (!anchorMonth || !currentBillingMonth) return null;
  const cmp = anchorMonth.localeCompare(currentBillingMonth);
  if (cmp === 0) return { tone: "current", label: "Current" };
  if (cmp < 0) return { tone: "past", label: "Settled · view only" };
  const [year, month] = currentBillingMonth.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  if (anchorMonth === nextMonth) return { tone: "future", label: "Upcoming · advance billing" };
  return { tone: "future", label: "Upcoming · prepare" };
}

export type BillingColourFilter = "saved" | "billed-unpaid" | "paid" | "changed";
export type OwnerPayoutFilter = "draft" | "first_checked" | "approved";
export type GridDisplayMode = "easy-read" | "fit-all";

const BILLING_COLOUR_FILTERS: Array<{ value: BillingColourFilter; label: string; colour: string }> = [
  { value: "saved", label: "Orange · Saved, not billed", colour: "#FF8C00" },
  { value: "billed-unpaid", label: "Yellow · Billed, unpaid", colour: "#FFFF00" },
  { value: "paid", label: "Green · Paid", colour: "#00FF00" },
  { value: "changed", label: "Red · Changed, re-bill", colour: "#FF0000" },
];
const OWNER_PAYOUT_FILTERS: Array<{ value: OwnerPayoutFilter; label: string; colour: string }> = [
  { value: "draft", label: "Orange · Draft", colour: "#FF8C00" },
  { value: "first_checked", label: "Yellow · First Checked", colour: "#FFFF00" },
  { value: "approved", label: "Green · Approved", colour: "#00FF00" },
];

export function GridToolbar({
  periods,
  selectedPeriods,
  onPeriodsChange,
  anchorMonth,
  currentBillingMonth,
  onStepMonth,
  onAnchorMonthChange,
  properties,
  propertyId,
  onPropertyChange,
  dirtyCount,
  onSave,
  canEditAction = true,
  canSaveAction = true,
  canBillAction = true,
  canExportAction = true,
  canUndo,
  canRedo,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
  selectedRowCount,
  onBill,
  canBillPeriod,
  canExport,
  onExport,
  selectedExportCount = 0,
  columnFilters,
  onColumnFilterChange,
  colourFilters = [],
  onColourFiltersChange = () => {},
  ownerPayoutFilters = [],
  onOwnerPayoutFiltersChange = () => {},
  displayMode = "easy-read",
  onDisplayModeChange,
  dateRange,
  onDateRangeChange,
  hasSelection,
  onApplyColour,
  columns,
  hiddenColumns,
  onToggleColumn,
  showVacant,
  onToggleShowVacant,
  viewControls,
}: GridToolbarProps) {
  const hideableColumns = columns.filter((c) => c.band);
  const periodStatus = periodStatusOf(anchorMonth, currentBillingMonth);
  const toolbarShellRef = useRef<HTMLDivElement>(null);
  const toolbarContentRef = useRef<HTMLDivElement>(null);
  const [toolbarScale, setToolbarScale] = useState(1);

  // Browser zoom changes the CSS viewport width. Measure the one-line strip's
  // true unscaled width and fit it exactly inside the toolbar instead of using
  // guessed breakpoints (which could still clip Save/Bill/Export at some zoom
  // levels). ResizeObserver also catches sidebar/window and label-size changes.
  useLayoutEffect(() => {
    const shell = toolbarShellRef.current;
    const content = toolbarContentRef.current;
    if (!shell || !content) return;
    const fit = () => {
      const available = Math.max(1, shell.clientWidth - 24); // p-3 on both sides
      const required = Math.max(1, content.scrollWidth);
      const next = Math.min(1, available / required);
      setToolbarScale((current) => Math.abs(current - next) < 0.002 ? current : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(shell);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={toolbarShellRef}
      data-testid="grid-toolbar"
      // `relative z-40`: the toolbar's backdrop-blur already opens its own
      // stacking context, which TRAPS the Columns "Show/Hide" dropdown (absolute
      // z-20) inside it — so bumping the dropdown's own z-index can never lift it
      // above the grid's sticky thead (z-20/z-30 in grid-table.tsx, promoted to
      // the page-root stacking context because grid-region isn't one). Raising
      // the whole toolbar to z-40 (> the header's z-30) is the only fix that lets
      // the dropdown paint over the header.
      className="relative z-40 overflow-hidden rounded-lg border border-border/50 bg-background/60 p-3 shadow-xl backdrop-blur-xl"
    >
      <div
        ref={toolbarContentRef}
        className="flex w-full flex-nowrap items-end justify-between gap-3 origin-top-left"
        style={{ transform: `scale(${toolbarScale})` }}
      >
      <div className="flex shrink-0 flex-nowrap items-end gap-3">
        {/* Billing-month navigator — anchor the grid to ANY month: step with the
            arrows, or jump with the month picker. Past months are read/review;
            a future month is for preparing ahead. The status pill + "Jump to
            current" keep the admin oriented; Bill is gated to the current month. */}
        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Billing period</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous month"
              data-testid="anchor-prev-month"
              onClick={() => onStepMonth(-1)}
              className="grid h-10 w-10 place-items-center rounded-md border border-[var(--border)] text-muted-foreground outline-none transition hover:bg-muted/40 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            >
              <ChevronLeft />
            </button>
            <input
              type="month"
              ref={stopKeydownAtInput}
              aria-label="Billing month"
              data-testid="anchor-month-input"
              value={anchorMonth ? anchorMonth.slice(0, 7) : ""}
              onChange={(e) => {
                if (e.target.value) onAnchorMonthChange(`${e.target.value}-01`);
              }}
              className="h-10 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-base text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            />
            <button
              type="button"
              aria-label="Next month"
              data-testid="anchor-next-month"
              onClick={() => onStepMonth(1)}
              className="grid h-10 w-10 place-items-center rounded-md border border-[var(--border)] text-muted-foreground outline-none transition hover:bg-muted/40 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            >
              <ChevronRight />
            </button>
            {periodStatus && (
              <span
                data-testid="anchor-status-pill"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  periodStatus.tone === "current" && "bg-[var(--primary)]/10 text-[var(--primary)]",
                  periodStatus.tone === "past" && "border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                  periodStatus.tone === "future" && "border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
                )}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {periodStatus.label}
              </span>
            )}
            {periodStatus && periodStatus.tone !== "current" && currentBillingMonth && (
              <button
                type="button"
                data-testid="anchor-jump-current"
                onClick={() => onAnchorMonthChange(currentBillingMonth)}
                className="rounded-md px-1.5 py-1 text-xs font-medium text-[var(--primary)] underline-offset-2 outline-none transition hover:underline focus:ring-2 focus:ring-[var(--ring)]"
              >
                Jump to current
              </button>
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor="bills-grid-property-filter"
            className="mb-1 block text-sm font-medium text-muted-foreground"
          >
            Categorize
          </label>
          <select
            id="bills-grid-property-filter"
            value={propertyId}
            onChange={(e) => onPropertyChange(e.target.value)}
            className="h-10 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-base text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          >
            <option value="all">All</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* History strips — the extra past months loaded alongside the anchor.
            Only shown when a multi-month window is loaded (the default single-
            month view has nothing to toggle); the navigator above owns the anchor. */}
        {periods.length > 1 && (
        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">History</span>
          <div className="flex flex-wrap gap-1.5">
            {periods.map((p) => {
              const active = selectedPeriods.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  data-testid={`period-chip-${p}`}
                  aria-pressed={active}
                  onClick={() => onPeriodsChange(toggledDesc(selectedPeriods, p))}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition",
                    active
                      ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "border-[var(--border)] text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {p}
                </button>
              );
            })}
          </div>
          {selectedPeriods.length > 0 && (
            <div className="mt-1 flex gap-1.5">
              {selectedPeriods.map((p) => (
                <span key={p} data-testid="selected-period" className="text-[10px] text-muted-foreground">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
        )}

        <div>
          <label htmlFor="bills-grid-unitcode-filter" className="mb-1 block text-sm font-medium text-muted-foreground">
            Filter
          </label>
          <input
            id="bills-grid-unitcode-filter"
            ref={stopKeydownAtInput}
            type="text"
            placeholder="Unit, name, or phone"
            aria-label="Filter by unit code, owner/tenant name, or phone"
            value={columnFilters.unitCode ?? ""}
            onChange={(e) => onColumnFilterChange("unitCode", e.target.value)}
            className="h-10 w-56 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-base text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Filter by colour</span>
          <details className="relative" data-testid="colour-filter-menu">
            <summary aria-label="Filter by colour" className="flex h-10 min-w-52 cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-base text-[var(--text-primary)] outline-none transition hover:bg-muted/40 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]">
              <span>{colourFilters.length === 0 ? "All colours" : `${colourFilters.length} colour${colourFilters.length === 1 ? "" : "s"} selected`}</span>
              <span aria-hidden="true" className="text-xs">▼</span>
            </summary>
            <div className="absolute z-50 mt-1 w-72 space-y-1 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] p-2 shadow-xl">
              <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-muted/40">
                <input type="checkbox" aria-label="All colours" checked={colourFilters.length === 0} onChange={() => onColourFiltersChange([])} />
                <span>All colours</span>
              </label>
              {BILLING_COLOUR_FILTERS.map((option) => (
                <label key={option.value} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-muted/40">
                  <input
                    type="checkbox"
                    aria-label={`Filter colour ${option.label}`}
                    checked={colourFilters.includes(option.value)}
                    onChange={() => onColourFiltersChange(colourFilters.includes(option.value)
                      ? colourFilters.filter((value) => value !== option.value)
                      : [...colourFilters, option.value])}
                  />
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-sm border border-[var(--border)]" style={{ backgroundColor: option.colour }} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </details>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Owner payout status</span>
          <details className="relative" data-testid="owner-payout-filter-menu">
            <summary aria-label="Filter owner payout status" className="flex h-10 min-w-52 cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-base text-[var(--text-primary)] outline-none transition hover:bg-muted/40 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]">
              <span>{ownerPayoutFilters.length === 0 ? "All payout statuses" : `${ownerPayoutFilters.length} status${ownerPayoutFilters.length === 1 ? "" : "es"} selected`}</span>
              <span aria-hidden="true" className="text-xs">▼</span>
            </summary>
            <div className="absolute z-50 mt-1 w-64 space-y-1 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] p-2 shadow-xl">
              <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-muted/40">
                <input type="checkbox" aria-label="All payout statuses" checked={ownerPayoutFilters.length === 0} onChange={() => onOwnerPayoutFiltersChange([])} />
                <span>All payout statuses</span>
              </label>
              {OWNER_PAYOUT_FILTERS.map((option) => (
                <label key={option.value} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--text-primary)] hover:bg-muted/40">
                  <input
                    type="checkbox"
                    aria-label={`Filter owner payout ${option.label}`}
                    checked={ownerPayoutFilters.includes(option.value)}
                    onChange={() => onOwnerPayoutFiltersChange(ownerPayoutFilters.includes(option.value)
                      ? ownerPayoutFilters.filter((value) => value !== option.value)
                      : [...ownerPayoutFilters, option.value])}
                  />
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-sm border border-[var(--border)]" style={{ backgroundColor: option.colour }} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </details>
        </div>

        {onDisplayModeChange && (
          <div>
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Table view</span>
            <div className="flex h-10 overflow-hidden rounded-md border border-[var(--input-border)] bg-[var(--card-bg)]">
              <button type="button" aria-pressed={displayMode === "easy-read"} onClick={() => onDisplayModeChange("easy-read")} className={cn("px-3 text-sm font-semibold transition", displayMode === "easy-read" ? "bg-[var(--navy)] text-white" : "hover:bg-muted/50")}>Easy Read</button>
              <button type="button" aria-pressed={displayMode === "fit-all"} onClick={() => onDisplayModeChange("fit-all")} className={cn("border-l border-[var(--input-border)] px-3 text-sm font-semibold transition", displayMode === "fit-all" ? "bg-[var(--navy)] text-white" : "hover:bg-muted/50")}>Fit All</button>
            </div>
          </div>
        )}

        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Date range</span>
          <div className="flex items-center gap-1.5">
            <input
              type="month"
              ref={stopKeydownAtInput}
              aria-label="Date range from"
              value={dateRange.from ? dateRange.from.slice(0, 7) : ""}
              onChange={(e) =>
                onDateRangeChange({ ...dateRange, from: e.target.value ? `${e.target.value}-01` : null })
              }
              className="h-10 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-base text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <input
              type="month"
              ref={stopKeydownAtInput}
              aria-label="Date range to"
              value={dateRange.to ? dateRange.to.slice(0, 7) : ""}
              onChange={(e) =>
                onDateRangeChange({ ...dateRange, to: e.target.value ? `${e.target.value}-01` : null })
              }
              className="h-10 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-base text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Columns</span>
          <details className="relative" data-testid="hide-column-menu">
            <summary className="flex h-10 cursor-pointer list-none items-center rounded-md border border-[var(--border)] px-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted/40">
              {hiddenColumns.length > 0 ? `Hidden (${hiddenColumns.length})` : "Show/Hide"}
            </summary>
            <div className="absolute z-20 mt-1 max-h-64 w-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/50 bg-background/95 p-2 shadow-xl backdrop-blur-xl">
              {hideableColumns.map((col) => {
                const hidden = hiddenColumns.includes(col.id);
                return (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-[var(--text-primary)] hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      data-testid={`column-toggle-${col.id}`}
                      checked={!hidden}
                      onChange={() => onToggleColumn(col.id)}
                    />
                    <span>
                      {col.band} · {col.header}
                    </span>
                  </label>
                );
              })}
            </div>
          </details>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-muted-foreground">Vacant</span>
          <label className="flex h-10 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-sm font-medium text-muted-foreground">
            <input type="checkbox" data-testid="show-vacant-toggle" checked={showVacant} onChange={onToggleShowVacant} />
            Show vacant
          </label>
        </div>
      </div>

      {viewControls && (
        <div data-testid="grid-view-controls" className="flex min-w-fit shrink-0 items-end justify-center self-end">
          {viewControls}
        </div>
      )}

      <div data-testid="grid-toolbar-actions" className="flex h-10 shrink-0 flex-nowrap items-center gap-2 self-end">
        {canEditAction && <div className="flex h-10 items-center gap-1" data-testid="colour-fill-swatches">
          <span className="text-sm font-medium text-muted-foreground">Colour</span>
          {COLOUR_SWATCHES.map((s) => (
            <button
              key={s.colour}
              type="button"
              aria-label={`Fill selection ${s.label}`}
              data-testid={`colour-swatch-${s.colour}`}
              disabled={!hasSelection}
              onClick={() => onApplyColour(s.colour)}
              style={{ backgroundColor: s.colour }}
              className="h-7 w-7 rounded-full border-2 border-white shadow-sm ring-1 ring-[var(--navy)] transition hover:scale-110 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gold)] disabled:cursor-not-allowed disabled:opacity-65"
            />
          ))}
          <button
            type="button"
            data-testid="colour-swatch-clear"
            disabled={!hasSelection}
            onClick={() => onApplyColour("")}
            className="h-10 rounded-md border border-[var(--border)] px-3 py-0 text-sm text-muted-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>}
        {canEditAction && <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="default"
            className="h-10 w-10 p-0"
            data-testid="grid-undo"
            aria-label="Undo"
            disabled={!canUndo}
            title={canUndo ? `Undo (${undoDepth})` : "Nothing to undo"}
            onClick={onUndo}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            className="h-10 w-10 p-0"
            data-testid="grid-redo"
            aria-label="Redo"
            disabled={!canRedo}
            title={canRedo ? `Redo (${redoDepth})` : "Nothing to redo"}
            onClick={onRedo}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>}
        {canSaveAction && <Button type="button" variant="gold" size="lg" className="h-10 px-4 text-lg" disabled={dirtyCount === 0} onClick={onSave}>
          {dirtyCount > 0 ? `Save (${dirtyCount})` : "Save"}
        </Button>}
        {canBillAction && <div className="flex h-10 items-end">
          <Button
            type="button"
            variant="gold"
            size="lg"
            className="h-10 px-4 text-lg"
            disabled={selectedRowCount === 0 || !canBillPeriod}
            onClick={onBill}
            title={!canBillPeriod ? "Only the current or next billing month can be billed" : undefined}
          >
            {selectedRowCount > 0 ? `Bill (${selectedRowCount})` : "Bill"}
          </Button>
          {!canBillPeriod && (
            <span data-testid="bill-period-locked" className="sr-only">
              Only current or next month can be billed
            </span>
          )}
        </div>}
        {canExportAction && <div className="flex h-10 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger disabled={!canExport} className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--gold)] bg-white px-4 text-lg font-semibold text-[var(--navy)] shadow-sm hover:bg-[var(--gold)]/10 disabled:opacity-50">
              Export <ChevronDown className="h-5 w-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 p-2 text-base">
              <div className="px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Billing data</div>
              <DropdownMenuItem className="py-2.5 text-base" onClick={() => onExport("data-xlsx")}>Export entire data (Excel)</DropdownMenuItem>
              <DropdownMenuItem className="py-2.5 text-base" onClick={() => onExport("data-pdf")}>Export entire data (PDF)</DropdownMenuItem>
              <DropdownMenuItem disabled={selectedExportCount === 0} className="py-2.5 text-base" onClick={() => onExport("selected-data-xlsx")}>Export selected data (Excel)</DropdownMenuItem>
              <DropdownMenuItem disabled={selectedExportCount === 0} className="py-2.5 text-base" onClick={() => onExport("selected-data-pdf")}>Export selected data (PDF)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Owner payout reports</div>
              <DropdownMenuItem className="py-2.5 text-base" onClick={() => onExport("payout-zip")}>Export entire payout reports (PDF ZIP)</DropdownMenuItem>
              <DropdownMenuItem disabled={selectedExportCount === 0} className="py-2.5 text-base" onClick={() => onExport("selected-payout-zip")}>Export selected payout reports (PDF ZIP)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Payout summary with bank details</div>
              <DropdownMenuItem className="py-2.5 text-base" onClick={() => onExport("payout-summary-xlsx")}>Export entire summary payout report (Excel)</DropdownMenuItem>
              <DropdownMenuItem disabled={selectedExportCount === 0} className="py-2.5 text-base" onClick={() => onExport("selected-payout-summary-xlsx")}>Export selected summary payout report (Excel)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!canExport && <span className="text-xs text-muted-foreground">Nothing to export</span>}
        </div>}
      </div>
      </div>
    </div>
  );
}
