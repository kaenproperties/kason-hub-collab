// Bills & Expenses Grid — wide period-row table with nested tenant sub-rows
// and grain discipline (UI Task 3). Pure + props-driven: no fetch, no store.
// The page shell (bills-grid-page.tsx, ui-10) owns data-fetching and wires the
// live staged-edit buffer + hidden-column state; this component only renders
// what it is given.
//
// invariant: `row.entry === null` means "apartment-month never Saved" — a
// legitimate empty state, NOT a regression (§16). `row.bearerConfig` is
// ALWAYS present (server sends defaults when no config row exists) — treating
// it as possibly-absent here would itself be a contract regression.
import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Building2, Paperclip, Eye, History, ReceiptText, ListPlus, FileText, Download, Settings2, CalendarClock } from "lucide-react";
import type { GridRow, GridSubRow } from "@/api/bills-grid";
import { visibleSubRows } from "./occupancy";
import { DataTable, TableHead, StatusPill, EmptyRow } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OwnerDetailPanel } from "@/pages/parties/owner-detail-panel";
import { TenantDetailPanel } from "@/pages/parties/tenant-detail-panel";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import type { StatusTone, SettlementState } from "@kason/shared";
import { isCellLocked, scalarGeneratedAmount, scalarSettingsLock, type GovernableScalarColumn } from "./row-lock";
import { cn } from "@/lib/utils";
import type { ColumnId, GridColumn } from "./columns";
import { settlementBucketForColumn } from "./columns";
import { parseAmountCell } from "./cell-parser";
import { cleaningSeed } from "./cell-seed";
import { isApplicable, showsTenantBorneMark } from "./cell-applicability";
import { projectedOwnerPayout } from "./owner-payout";
// ui-task-10e: pointer/selection/colour extension — `SelectionCell` is the
// hook's (ui-4, use-grid-selection.ts) cell-identity shape. Importing the
// TYPE only keeps this file free of the hook's runtime/state; the page shell
// (bills-grid-page.tsx) owns the actual useGridSelection() instance.
import type { SelectionCell } from "./use-grid-selection";
import type { GridDisplayMode } from "./grid-toolbar";
// Excel-Web V2 (grid-gestures.ts): the SINGLE resolver for pointer/click
// modifiers. `resolvePointerGesture` turns a raw pointerdown into select /
// context / ignore (platform-aware: Cmd=multi on mac, Ctrl+click=right-click on
// mac); `resolveClickMods` gives the same platform-aware {shift,ctrl} for the
// activate click path.
import { resolvePointerGesture, resolveClickMods } from "./grid-gestures";

// Task 9 (R7/R8): a small phone-style count badge — red circle + number,
// hidden entirely at 0 (never renders "0" or NaN). Display-only; reused on
// both the attachment (paperclip) button and the expense (eye) button.
function CountBadge({ count, testId }: { count: number; testId: string }) {
  if (!count || count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-none text-white"
    >
      {count}
    </span>
  );
}

// Task 7 (P5/R7): per-row audit affordance — a small muted icon whose hover
// tooltip reads "Edited by {name} · {local date-time}"; when never edited
// shows a muted "—" with title "Not edited" instead, per Error Handling:
// never a crash or a raw UUID.
//
// Final-review fix pass, FIX 1: the dash gates on `name` ALONE, not `name &&
// at` — `at` (row.entry.updatedAt / subRow.updatedAt) is the Prisma
// `@updatedAt` token, which is ALWAYS non-null on any saved entry, so
// requiring both null would never fire for a saved row. `lastEditedByName`
// is the actual null-able signal (updatedById is a nullable FK with no
// backfill — every pre-existing prod/UAT row has this null while carrying a
// real updatedAt). Spec R7 + Error Handling define the null contract on the
// NAME, not the timestamp.
function AuditIcon({ name, at, onClick, unitCode }: { name: string | null | undefined; at: string | null | undefined; onClick?: () => void; unitCode: string }) {
  const when = at ? new Date(at).toLocaleString() : "";
  const title = name ? `Edited by ${name}${when ? ` · ${when}` : ""}` : "Not edited";
  return (
    <button
      type="button"
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--navy)] transition hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]"
      title={title}
      aria-label={`View activity log for ${unitCode}`}
      data-testid="audit-icon"
      onClick={(event) => { event.stopPropagation(); onClick?.(); }}
    >
      <History className="h-5 w-5" />
    </button>
  );
}

type CellDocumentCounts = { invoice: number; receipt: number };

/** Small, non-interactive filing marks. They are absolutely positioned so the
 * amount remains mathematically centred and never gets pushed or wrapped. */
function CellDocumentMarks({ counts }: { counts?: CellDocumentCounts }) {
  if (!counts || (!counts.invoice && !counts.receipt)) return null;
  return (
    <span className="pointer-events-none absolute bottom-1 left-1 z-20 inline-flex items-center gap-1 rounded bg-white/85 px-1 py-0.5 text-[10px] font-bold leading-none text-[var(--navy)] shadow-sm" aria-label={`${counts.invoice} invoice, ${counts.receipt} receipt`}>
      {counts.invoice > 0 && <span className="inline-flex items-center gap-0.5" title={`${counts.invoice} invoice`}><FileText className="h-3.5 w-3.5" />{counts.invoice > 1 ? counts.invoice : ""}</span>}
      {counts.receipt > 0 && <span className="inline-flex items-center gap-0.5" title={`${counts.receipt} receipt`}><ReceiptText className="h-3.5 w-3.5" />{counts.receipt > 1 ? counts.receipt : ""}</span>}
    </span>
  );
}

function hasNativeTextSelection(): boolean {
  return typeof window !== "undefined" && Boolean(window.getSelection()?.toString());
}

export type ExpenseBearer = "tenant" | "owner";
/** Which recurring cell (Owner / Tenant) opened the recurring dialog — the dialog's line list and
 *  total are scoped to it, exactly as the Expenses dialog is scoped by ExpenseBearer. */
export type RecurringBearer = "tenant" | "owner";

const ENTRY_STATUS_TONES: Record<string, StatusTone> = PHASE2_STATUS_TONES.billsGridEntry;

export type CellKey = string; // apartmentId (unit-grain) or listingId (subRow-grain)
export type SelectionEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean; bottomRight: boolean };

export type CellEditHandler = (cellKey: CellKey, columnId: ColumnId, value: string) => void;

export interface GridTableProps {
  rows: GridRow[];
  columns: GridColumn[];
  displayMode?: GridDisplayMode;
  density?: "comfortable" | "compact";
  canEdit?: boolean;
  onCellEdit?: CellEditHandler;
  onOpenSettings?: (apartmentId: string) => void; // R11 — per-unit bearer drawer
  onConfigureManagementFee?: (apartmentId: string) => void;
  onViewExpenses?: (apartmentId: string, bearer: ExpenseBearer, withSST: boolean) => void;
  onViewRecurring?: (apartmentId: string, bearer: RecurringBearer) => void; // recurring-charges — recurring dialog trigger
  onOpenAttachments?: (apartmentId: string) => void; // attachments panel
  onViewTenantSummary?: (row: GridRow) => void;
  onViewTenantDocuments?: (row: GridRow) => void;
  onViewOwnerReport?: (row: GridRow) => void;
  onDownloadOwnerReport?: (row: GridRow) => void;
  onViewActivity?: (row: GridRow) => void;
  // ui-task-10e (R31 a/c/d, via useGridSelection — ui-4): ALL optional —
  // absent ⇒ every cell renders exactly as before this task (Task-3/ui-10b
  // parity). Wired on the EDITABLE numeric cells only (LockedCell/billed
  // cells never receive these — money guard for ctrl-fill, ui-10f, lives at
  // that layer, not here).
  // Task 3 (Excel mouse-selection V2): the second arg is now a {shift,ctrl}
  // mods object (was a bare ctrlKey boolean). shift extends a rectangle from
  // the anchor; ctrl toggles a cell into a multi-selection; both fold metaKey
  // into ctrl (mac Cmd) exactly as the old ctrlKey||metaKey did.
  onCellPointerDown?: (cell: SelectionCell, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellPointerEnter?: (cell: SelectionCell) => void; // drag-over
  onCellPointerUp?: () => void;
  isCellSelected?: (cellKey: string, columnId: ColumnId) => boolean; // render selection highlight
  selectionEdges?: (cellKey: string, columnId: ColumnId) => SelectionEdges | undefined;
  cellColour?: (cellKey: string, columnId: ColumnId) => string | undefined; // render background colour (localStorage-only, never a calc input)
  // P4 Task 3 (active-cell nav, R5): ALL optional — absent ⇒ byte-identical to
  // today (parity). Wired on EVERY navigable cell (editable inputs AND the
  // read-only value-bearing cells: billed/amount/rental LockedCells, the four
  // expense-total ReadOnlyCells, and the raw inline sub-row rental <td>), so
  // arrow-nav landing on any of them gets an active ring + focus + click.
  isCellActive?: (cellKey: string, columnId: ColumnId) => boolean; // render the active-cell ring (distinct from selection)
  isCellEditing?: (cellKey: string, columnId: ColumnId) => boolean; // true only after typing/F2/double-click
  isCellPendingRebill?: (cellKey: string, columnId: ColumnId) => boolean;
  // Task 3: activate now carries a {shift,ctrl} mods object built from the
  // click event's modifier keys — so a shift/ctrl click extends/toggles the
  // selection via the SAME path instead of collapsing it through the plain
  // onClick. Plain click ⇒ {shift:false, ctrl:false} (unchanged behaviour).
  onCellActivate?: (cellKey: string, columnId: ColumnId, mods: { shift: boolean; ctrl: boolean }) => void; // pointer click → activate
  // Excel-Web V2 — right-click. Wired on EVERY navigable cell (editable +
  // read-only). The page owns the custom context menu: it preventDefaults the
  // native menu, preserves the selection when the click is inside it (else
  // collapses to this cell), and positions the menu at the pointer. OPTIONAL —
  // absent ⇒ no handler, native menu (parity).
  onCellContextMenu?: (cell: { cellKey: string; columnId: ColumnId }, e: React.MouseEvent) => void;
  // Excel-Web V2 — double-click an EDITABLE cell → enter edit mode (caret at the
  // click point; native word-select is suppressed). OPTIONAL — absent ⇒ no
  // handler (parity). Read-only cells never receive this (nothing to edit).
  onCellDoubleClick?: (cellKey: string, columnId: ColumnId) => void;
  // Excel-Web V2 — click a column header to select the whole column (all rows).
  // A SUB-column header passes its one id; a BAND header passes every sub-column
  // id under it (e.g. "TNB" → tnbOwner/previousKwh/currentKwh/amount). `mods`
  // carries platform-aware {shift,ctrl}: plain = replace, ctrl/cmd = add the
  // column(s), shift = extend the column range from the active cell. OPTIONAL —
  // absent ⇒ headers are non-interactive (parity).
  onSelectColumns?: (columnIds: ColumnId[], mods: { shift: boolean; ctrl: boolean }) => void;
  registerCell?: (cellKey: string, columnId: ColumnId, node: HTMLElement | null) => void; // node registry for the page's focus/scroll effect
  // ui-task-10g: the page's OWN `useStagedEdits` buffer (`${cellKey}:${columnId}`
  // -> raw text), so a PROGRAMMATIC stage the page makes on the buffer directly
  // (ctrl-fill via handleCellEdit, ui-9 crash-recovery restoring from
  // sessionStorage) also repaints the <input> here — not just a real keystroke,
  // which only ever reaches GridTable's OWN internal echo state below. OPTIONAL:
  // absent ⇒ byte-identical to today (Task-3/ui-4/ui-10b/e parity — internal-or-seed
  // only, no page buffer consulted at all).
  staged?: Record<string, string>;
  // P4 Task 5 (Esc-revert, Hard Point B): GridTable's internalStaged keystroke
  // echo has TOP display precedence (stagedOrSeed checks it FIRST). So the page's
  // revertActiveEdit must clear BOTH the page buffer (unstage) AND this internal
  // echo — otherwise the typed value stays visible. GridTable exposes its clear
  // capability by calling this registrar (mirrors the cell-node `registerCell`
  // registry) with a stable clearInternalStaged(cellKey, columnId) fn. OPTIONAL:
  // absent ⇒ no registration, byte-identical to today.
  registerClearInternalStaged?: (fn: (cellKey: string, columnId: string) => void) => void;
  // ── Per-unit Bill selection (money-critical) ──────────────────────────────
  // The user picks WHICH units to Bill via a checkbox per row + a select-all in
  // the Unit header. ALL optional — absent ⇒ no checkboxes render (parity with
  // the pre-selection grid; GridTable-only tests that omit these are unaffected).
  // Billing is per-UNIT (apartment): a checked unit bills every occupied room's
  // tenant invoice + the owner invoice as one backend op — there is no per-tenant
  // Bill. `billableApartmentIds` is the page's `billableRows` id-set (entry saved,
  // not yet billed): ONLY these rows get a checkbox, and the header select-all is
  // disabled when the set is empty. `selectedForBill` is the checked subset.
  billableApartmentIds?: ReadonlySet<string>;
  selectedForBill?: ReadonlySet<string>;
  allBillableSelected?: boolean; // header checkbox = checked
  someBillableSelected?: boolean; // header checkbox = indeterminate
  onToggleBillSelection?: (apartmentId: string) => void; // per-row toggle
  onToggleSelectAllForBill?: () => void; // header select-all / clear-all
  // Mirrors the page's "show vacant" view toggle down to the room grain: when
  // explicitly `false`, a partitioned unit hides its vacant (untenanted, dataless)
  // rooms — the same rows `visibleUnits` never gets to filter because they live
  // INSIDE an occupied unit. `undefined` ⇒ no room filtering (parity for
  // GridTable-only tests that don't wire the toggle); `true` ⇒ show every room.
  showVacant?: boolean;
}

// ── band-header grouping ─────────────────────────────────────────────────────

interface BandGroup {
  band: string;
  columns: GridColumn[];
}

/** Groups consecutive columns sharing a `band`, preserving CURRENT_COLUMNS order. Columns with no band (unitCode) are excluded — they get their own rowSpan=2 header cell instead. */
function groupBands(columns: GridColumn[]): BandGroup[] {
  const groups: BandGroup[] = [];
  for (const col of columns) {
    if (!col.band) continue;
    const last = groups[groups.length - 1];
    if (last && last.band === col.band) {
      last.columns.push(col);
    } else {
      groups.push({ band: col.band, columns: [col] });
    }
  }
  return groups;
}

// ── money helpers (display-only; never a calc input) ────────────────────────

function subtractMoney(total: string | null, part: string | null): string {
  const t = total != null ? Number(total) : 0;
  const p = part != null ? Number(part) : 0;
  return (t - p).toFixed(2);
}

/** Round to 2dp, half-away-from-zero via the standard float `* 100 round /
 * 100` idiom — mirrors the server's own round2 (compute.ts). Display-only:
 * the live-preview this feeds is NEVER sent on Save (server is the sole
 * money authority; Task 6 §7). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Task 6: the Amount cell is read-only and now LIVE-PREVIEWS
 * round2((current-previous) x ratePerKwh) whenever both Current/Previous are
 * staged/seeded as parseable numbers — else it falls back to the last
 * stored `subRow.amount`. Negative deltas clamp to 0 (never negative money
 * shown), matching the server's own floor. Pure/display-only. */
function amountPreview(subRow: GridSubRow, prevRaw: string, curRaw: string): string {
  const rate = Number(subRow.ratePerKwh);
  const prev = prevRaw !== "" ? Number(prevRaw) : NaN;
  const cur = curRaw !== "" ? Number(curRaw) : NaN;
  if (Number.isNaN(prev) || Number.isNaN(cur) || Number.isNaN(rate)) {
    return subRow.amount ?? "—";
  }
  const delta = cur - prev;
  return Math.max(0, round2(delta * rate)).toFixed(2);
}

// ui-task-10e: `SelectionCell.value` seeds `sum` (drag-select) in
// useGridSelection — numeric-only per that hook's own contract. Per the
// brief: Number() of the staged/seed string; NaN → null (never a calc input
// itself, purely identifies "is this cell's current text a number").
//
// ui-task-10f fix (Fix 2): an empty/whitespace-only cell must resolve to
// `null`, NOT `0` — `Number("")` is `0`, not `NaN`, so without this guard an
// empty (never-Saved) anchor cell silently identified as "a numeric 0" and
// bills-grid-page.tsx's ctrl-fill staged "0" into every dragged target.
function cellNumericValue(raw: string): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** Seed value for a unit-grain editable cell: the snapshotted entry field, or
 * (cleaning only, R7) the recurring auto-fill amount when nothing was ever
 * Saved. Auto-fill NEVER applies to any column other than cleaning — every
 * other field has no such recurring default in the DTO. `rental` is NOT
 * handled here (Task 6): it moved off `entry` onto `SubRow.rental` and is
 * now read-only, rendered via `LockedCell` in the render loop below instead
 * of through this editable-cell seed path. */
function seedValue(row: GridRow, columnId: ColumnId): string {
  const entry = row.entry;
  switch (columnId) {
    case "cleaningOwner":
    case "cleaningTenant":
      return cleaningSeed(row);
    case "tnbOwner":
    case "tnbTenant":
      return entry?.tnbTotal ?? "";
    case "airOwner":
    case "airTenant":
      return entry?.airSelangor ?? "";
    case "wifiOwner":
    case "wifiTenant":
      return entry?.wifi ?? "";
    case "maintenanceFee":
      return entry?.maintenanceFee ?? "";
    default:
      return "";
  }
}

// ── read-only computed columns (tenant/owner expense totals) ────────────────

function readOnlyValue(row: GridRow, columnId: ColumnId): string {
  switch (columnId) {
    case "tenantExpWithSst":
      return row.expenses.tenant.withSstTotal;
    case "tenantExpNonSst":
      return subtractMoney(row.expenses.tenant.total, row.expenses.tenant.withSstTotal);
    case "ownerExpWithSst":
      return row.expenses.owner.withSstTotal;
    case "ownerExpNonSst":
      return subtractMoney(row.expenses.owner.total, row.expenses.owner.withSstTotal);
    case "agreementFee":
      // A genuine zero-value TA charge is operationally different from no TA
      // charge at all. Keep the zero visible so an admin can spot/correct it;
      // use a dash only when this apartment-month has no TA record.
      if (
        (row.agreementFees?.new.state ?? "none") === "none"
        && (row.agreementFees?.renewal.state ?? "none") === "none"
      ) return "—";
      return (
        Number(row.agreementFees?.new.amount ?? 0)
        + Number(row.agreementFees?.renewal.amount ?? 0)
      ).toFixed(2);
    case "managementFeeSst":
      return row.managementFee?.total ?? "0.00";
    case "ownerRecurring":
      return row.recurring?.owner.total ?? "0.00";
    case "tenantRecurring":
      return row.recurring?.tenant.total ?? "0.00";
    case "ownerPayout":
      return projectedOwnerPayout(row).toFixed(2);
    default:
      return "";
  }
}

// ── editable input cell ──────────────────────────────────────────────────────

/**
 * Partially-paid cells keep a small non-colour marker so they remain distinct
 * from unpaid cells. Fully-paid cells rely on their existing full-cell colour;
 * their former bottom-right green tick was redundant and visually noisy.
 */
function SettlementMarker({ state }: { state: PaintedSettlement }) {
  const paint = SETTLEMENT_PAINT[state];
  if (state === "paid") return <span className="sr-only">{paint.label}</span>;

  return (
    <span
      className={cn("pointer-events-none absolute bottom-0.5 right-0.5 leading-none", paint.tick)}
      data-testid={paint.testId}
    >
      <span aria-hidden="true" className="text-[11px]">{paint.glyph}</span>
      <span className="sr-only">{paint.label}</span>
    </span>
  );
}

/**
 * Corner "T" on a money cell whose cost is borne by the TENANT (2026-08-14, client request).
 *
 * Used by the single-column bands — TNB and Maintenance Fee — where there is no tenant-side
 * column to move the amount into, so the drawer's Owner/Tenant answer would otherwise be
 * invisible in the grid. {@link showsTenantBorneMark} owns WHICH columns qualify. AIR and
 * Cleaning/WiFi are deliberately unmarked: they own both columns, and the amount sitting
 * under one of them already carries the answer.
 *
 * Top-right by request, which also keeps it clear of {@link SettlementMarker} at
 * bottom-right, so a paid tenant-borne cell shows both without collision.
 */
/**
 * The mark answers the SAME question the Setting drawer asks — "who bears this cost" —
 * and nothing more. Deliberately not "recharged to the tenant": `isUtilityTenantBorne`
 * also covers the legacy `manager_advanced` ("KAEN advanced", setting-drawer.tsx:114),
 * where KAEN fronted the payment rather than the owner. Naming the MECHANISM would make
 * the grid assert something the drawer contradicts; naming the BEARER is true for every
 * value in the set, and needs no second per-value map to drift out of sync.
 */
const TENANT_BORNE_LABEL = "Borne by the tenant";

function TenantBorneMark() {
  // `title` lives on the CELL, not here: `pointer-events-none` makes this span
  // un-hit-testable, so a title attribute on it could never render a tooltip.
  // Sky rather than the brand gold — amber-600 is already the "partially paid" ◐ in
  // these same cells (SETTLEMENT_PAINT below), and a gold "T" a few millimetres from an
  // amber ◐ reads as the same family (money state) when it means something else.
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 rounded-[3px] bg-sky-500/15 px-1 text-[9px] font-bold leading-[1.35] text-sky-700 dark:text-sky-300"
      data-testid="tenant-borne-mark"
    >
      <span aria-hidden="true">T</span>
      <span className="sr-only">{TENANT_BORNE_LABEL}</span>
    </span>
  );
}

/** Muted "settled" wash for a fully paid cell — greys the value without hiding it. */
const SETTLED_CELL_CLASS = "relative bg-emerald-50/60 text-muted-foreground dark:bg-emerald-950/20";
/** Amber counterpart for a PARTLY paid cell. Same shape as the paid wash so the two
 * read as one family (money in), distinguished by hue rather than by presence. */
const PARTIAL_CELL_CLASS = "relative bg-amber-50/60 text-muted-foreground dark:bg-amber-950/20";

/** The settlement states that PAINT a cell. "none"/"unpaid" render nothing, so they
 * are excluded from the paint table rather than mapped to a null everyone must
 * null-check. */
type PaintedSettlement = Extract<SettlementState, "partial" | "paid">;

/**
 * Per-state cell affordance: wash, tick colour, glyph and screen-reader label.
 *
 * Keyed as a `Record` over the painted states so adding a state to SettlementState
 * cannot silently fall through to "renders like unpaid" — the union widens and this
 * table stops compiling until the new state is answered.
 *
 * Partial payment keeps a visible "◐" marker. Paid cells keep an sr-only word
 * while their full-cell green state supplies the visible indication.
 */
const SETTLEMENT_PAINT: Record<
  PaintedSettlement,
  { wash: string; tick: string; glyph: string; label: string; testId: string }
> = {
  paid: {
    wash: SETTLED_CELL_CLASS,
    tick: "text-emerald-600 dark:text-emerald-400",
    glyph: "✓",
    label: "Paid",
    testId: "settled-tick",
  },
  partial: {
    wash: PARTIAL_CELL_CLASS,
    tick: "text-amber-600 dark:text-amber-400",
    glyph: "◐",
    label: "Partially paid",
    testId: "partial-tick",
  },
};

/** Narrow a raw settlement state to the painted subset ("none"/"unpaid" ⇒ undefined). */
function painted(state: SettlementState | undefined): PaintedSettlement | undefined {
  return state === "paid" || state === "partial" ? state : undefined;
}

/**
 * Content-led column sizing. Short Owner/Tenant/SST columns should not consume
 * the same space as meter labels, expense actions, or the owner report cell.
 * These are also used as proportional weights in Fit All mode, so the table
 * remains one-page wide without squeezing every column equally.
 */
function preferredColumnWidth(columnId: ColumnId): number {
  switch (columnId) {
    case "previousKwh":
    case "currentKwh":
      return 116;
    case "ownerPayout":
      return 124;
    case "tenantExpNonSst":
    case "tenantExpWithSst":
    case "ownerExpNonSst":
    case "ownerExpWithSst":
      // These cells also carry the document/cost affordances, so they need a little
      // more room than a plain amount but no longer inherit the old oversized width.
      return 96;
    case "rental":
    case "deposit":
      return 86;
    case "agreementFee":
      // Make the SST-inclusive contract explicit without clipping the heading.
      return 116;
    case "amount":
      return 88;
    case "maintenanceFee":
      return 88;
    case "managementFeeSst":
      return 92;
    default:
      // Plain Owner/Tenant money cells: enough for RM-style values and the input
      // border, without the repeated empty gutters that made the matrix very long.
      return 82;
  }
}

type BillingCellState = "saved" | "billed-unpaid" | "paid" | "changed";

const BILLING_STATE_COLOUR: Record<BillingCellState, string> = {
  saved: "#FF8C00",          // saved, never billed — bright orange
  "billed-unpaid": "#FFFF00", // billed, tenant not paid — bright yellow
  paid: "#00FF00",           // paid — fluorescent cyan-green
  changed: "#FF0000",        // changed after billing, saved, needs re-bill — bright red
};

function isDashDisplay(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "—" || trimmed === "-";
}

function hasBillableDisplay(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isDashDisplay(trimmed)) return false;
  const numeric = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/** TA is the deliberate exception to the usual "zero means no data" rule:
 * a saved RM0 TA charge must remain visible in its billing/re-billing state. */
function hasVisibleBillingState(columnId: ColumnId, value: string): boolean {
  if (columnId === "agreementFee") return !isDashDisplay(value) && value.trim() !== "";
  return hasBillableDisplay(value);
}

/** Shared by the renderer and the page-level colour filter so both surfaces use
 * exactly the same automatic billing-state rules. */
export function billingStateForCell(
  row: GridRow,
  cellKey: string,
  columnId: ColumnId,
  isPendingRebill?: (cellKey: string, columnId: ColumnId) => boolean,
): BillingCellState | undefined {
  if (columnId === "agreementFee") {
    const states = [row.agreementFees?.new.state, row.agreementFees?.renewal.state]
      .filter((state): state is "saved" | "billed-unpaid" | "paid" => !!state && state !== "none");
    // One TA cell represents either a new agreement or a renewal. It only turns
    // green when every charge in that cell is fully paid.
    if (states.includes("saved")) return "saved";
    if (states.includes("billed-unpaid")) return "billed-unpaid";
    if (states.includes("paid")) return "paid";
    return undefined;
  }
  if (columnId === "deposit") {
    const subRow = row.subRows.find((candidate) => candidate.listingId === cellKey) ?? row.subRows[0];
    return subRow?.depositBillingState ?? undefined;
  }
  const hasLiveBill = row.billed ?? row.billedAt != null;
  if (columnId === "rental") {
    const subRow = row.subRows.find((candidate) => candidate.listingId === cellKey) ?? row.subRows[0];
    // Real rental invoice state wins. The row-level fallback is kept only for
    // older cached payloads that predate rentalBillingState.
    if (subRow?.rentalBillingState) return subRow.rentalBillingState;
    if (!hasLiveBill) return undefined;
    return row.settlement?.status === "paid" || row.paymentStatus.toLowerCase() === "paid" ? "paid" : "billed-unpaid";
  }
  if (row.entryId == null) return undefined;
  if (isPendingRebill?.(cellKey, columnId)) return "changed";
  if (!hasLiveBill) return "saved";
  const bucket = settlementBucketForColumn(row, columnId);
  if (!bucket || !row.settlement) return undefined;
  const state = row.settlement.rooms?.[cellKey]?.[bucket] ?? row.settlement.cells[bucket];
  if (state === "paid") return "paid";
  if (state === "unpaid" || state === "partial") return "billed-unpaid";
  return undefined;
}

/** TRUE when at least one visible money/data cell in this unit has the requested
 * automatic colour. A match keeps the WHOLE unit row, including its checkbox. */
export function rowHasBillingState(
  row: GridRow,
  target: BillingCellState,
  columns: GridColumn[],
  isPendingRebill?: (cellKey: string, columnId: ColumnId) => boolean,
): boolean {
  const governed = new Set<ColumnId>(["cleaningOwner", "cleaningTenant", "wifiOwner", "wifiTenant", "maintenanceFee"]);
  for (const col of columns) {
    if (col.id === "unitCode" || col.id === "ownerPayout") continue;
    if (col.id === "rental" || col.id === "deposit") {
      for (const sub of row.subRows) {
        const value = col.id === "rental" ? sub.rental : sub.deposit;
        if (value && hasBillableDisplay(value) && billingStateForCell(row, sub.listingId, col.id, isPendingRebill) === target) return true;
      }
      continue;
    }
    if (col.grain === "subRow") {
      for (const sub of row.subRows) {
        const value = sub[col.id as "previousKwh" | "currentKwh" | "amount"];
        if (value && hasBillableDisplay(value) && billingStateForCell(row, sub.listingId, col.id, isPendingRebill) === target) return true;
      }
      continue;
    }
    if (!isApplicable(row, col.id)) continue;
    const generated = governed.has(col.id)
      ? scalarGeneratedAmount(row, col.id as GovernableScalarColumn)
      : "";
    const value = generated || seedValue(row, col.id) || readOnlyValue(row, col.id);
    if (hasVisibleBillingState(col.id, value) && billingStateForCell(row, row.apartmentId, col.id, isPendingRebill) === target) return true;
  }
  return false;
}

const CATEGORY_START_COLUMNS = new Set<ColumnId>([
  "rental", "cleaningOwner", "tnbOwner", "airOwner", "wifiOwner",
  "maintenanceFee", "ownerRecurring", "tenantExpNonSst", "ownerExpNonSst",
  "managementFeeSst", "ownerPayout",
]);
const CATEGORY_END_COLUMNS = new Set<ColumnId>([
  "agreementFee", "cleaningTenant", "amount", "airTenant", "wifiTenant",
  "maintenanceFee", "tenantRecurring", "tenantExpWithSst", "ownerExpWithSst", "managementFeeSst",
  "ownerPayout",
]);

/** Strong vertical borders around a category; inner sub-columns keep normal lines. */
function categoryDividerClass(columnId: ColumnId): string {
  return cn(
    CATEGORY_START_COLUMNS.has(columnId) && "border-l-2 border-l-[var(--navy)]",
    CATEGORY_END_COLUMNS.has(columnId) && "border-r-2 border-r-[var(--navy)]",
  );
}

function billingStateStyle(state: BillingCellState | undefined, value: string, columnId?: ColumnId): React.CSSProperties | undefined {
  return state && (columnId ? hasVisibleBillingState(columnId, value) : hasBillableDisplay(value))
    ? { backgroundColor: BILLING_STATE_COLOUR[state], color: "#082B4F" }
    : undefined;
}

function selectionOutlineStyle(edges?: SelectionEdges): React.CSSProperties | undefined {
  if (!edges) return undefined;
  const green = "#008A3B";
  return { boxShadow: [
    edges.top && `inset 0 3px 0 ${green}`,
    edges.right && `inset -3px 0 0 ${green}`,
    edges.bottom && `inset 0 -3px 0 ${green}`,
    edges.left && `inset 3px 0 0 ${green}`,
  ].filter(Boolean).join(", ") };
}

function SelectionFillHandle({ edges }: { edges?: SelectionEdges }) {
  if (!edges?.bottomRight) return null;
  return <span aria-hidden="true" className="pointer-events-none absolute -bottom-1 -right-1 z-30 h-2.5 w-2.5 border border-white bg-[#008A3B]" />;
}

function EditableCell({
  columnId,
  value,
  onChange,
  numeric,
  settlement,
  tenantBorne,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  selected,
  selectionEdges,
  colour,
  active,
  editing,
  billingState,
  onActivate,
  onContextMenu,
  onDoubleClick,
  registerCell,
  documentCounts,
}: {
  columnId: ColumnId;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  /** Renders the corner {@link TenantBorneMark}. Display only — it never gates editing. */
  tenantBorne?: boolean;
  /** Server-derived payment state of the live grid charges behind this column.
   * Purely a visual: whether the cell is editable is decided by the ROW lock
   * (row-lock.ts) + the backend paid-freeze, never by this marker. In practice a
   * painted cell is now almost always inside a locked row — a row with any money
   * against it locks entirely — so this renders as an EditableCell only on an
   * unbilled row. */
  settlement?: PaintedSettlement;
  // ui-task-10e: all optional — absent ⇒ no listener attached, no selection
  // marker, no background colour (Task-3/ui-10b parity when the page shell
  // doesn't pass them).
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  selected?: boolean;
  selectionEdges?: SelectionEdges;
  colour?: string;
  // P4 Task 3: active-cell nav. All optional — absent ⇒ no marker, no click
  // handler, no node registration (parity). `registerCell` targets the
  // <input> (focus lands there for editable cells).
  // Task 3 (mouse-selection V2): onActivate now receives the click event so a
  // shift/ctrl click can carry its modifiers up to onCellActivate.
  active?: boolean;
  editing?: boolean;
  billingState?: BillingCellState;
  onActivate?: (e: React.MouseEvent) => void;
  // Excel-Web V2: right-click (context menu) + double-click (enter edit mode).
  // Both optional ⇒ parity when the page doesn't opt in.
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  registerCell?: (node: HTMLElement | null) => void;
  documentCounts?: CellDocumentCounts;
}) {
  // R31 (D11, "amount cells accept no formula"): a numeric cell rejects a
  // FORMULA (leading "=") right here, before it ever reaches the
  // staged-edit buffer — reusing parseAmountCell (cell-parser.ts, ui-4), the
  // same gate expenses-dialog.tsx applies at submit-time. This does NOT
  // hand-roll a stricter "amounts only" rule: partial/in-progress numeric
  // input ("", "-", "1.", "1.5", "0") is never blocked — only a value that
  // STARTS WITH "=" triggers the reject, so normal typing is unaffected.
  // Money stays server-guarded regardless (Save never trusts client input);
  // this only adds the missing inline feedback.
  const [amountError, setAmountError] = useState<string | null>(null);

  function handleChange(next: string) {
    if (numeric && next.trim().startsWith("=")) {
      const parsed = parseAmountCell(next);
      setAmountError(parsed.ok ? null : parsed.message);
      return; // rejected — NOT staged
    }
    setAmountError(null);
    onChange(next);
  }

  // P4 Task 5 (R2, type-to-edit): keep a LOCAL ref to the <input> alongside the
  // page's `registerCell` node registry. The callback ref below fans out to BOTH
  // so the page focus effect (which .focus()es this node) and the select-on-
  // activate effect (which .select()s its text) each get the same element —
  // they COEXIST (Hard Point A): the page focuses, EditableCell selects.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const typeToEditRef = useRef(false);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      registerCell?.(node);
    },
    [registerCell],
  );

  // In Excel selection mode the input may hold DOM focus for keyboard routing,
  // but it remains read-only with a hidden caret. Only edit mode selects the
  // existing value and exposes the normal text caret.
  useEffect(() => {
    if (!active || (editing !== undefined && !editing)) return;

    const input = inputRef.current;
    if (!input) return;

    if (typeToEditRef.current) {
      typeToEditRef.current = false;
      // The first typed character replaces the selected cell value. Place the
      // caret after it so the next character appends, just like Excel.
      requestAnimationFrame(() => {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      });
      return;
    }

    input.select();
  }, [active, editing]);

  const excelMode = editing !== undefined;

  return (
    <td
      className={cn(
        "relative overflow-hidden px-1.5 py-1.5 align-middle text-[18px] text-[var(--text-primary)]",
        categoryDividerClass(columnId),
        numeric && "whitespace-nowrap text-center tabular-nums",
        // Task 3 (mouse-selection V2): the in-range visual is a light --primary
        // TINT FILL — a rectangle of tinted cells reads as one continuous block
        // (the old ring-inset outlined every cell individually, breaking the
        // Excel-style contiguous look). Still gated on `!active`: the active
        // cell keeps its distinct OUTSET ring below and never also paints the
        // tint (so the active cell inside a range stays unambiguous). V2: bumped
        // to /15 so the block reads clearly now that the competing native
        // text-selection (the gold ::selection) is suppressed on the grid.
        selected && "relative",
        // P4 Task 4/6: the active cell reads as a strong SOLID --primary border
        // (Excel active-cell look) — non-inset/outset, high-contrast and, per
        // Fix 1 above, always distinct from the inset --primary selection ring
        // (the selection ring is suppressed on the active cell). active wins the
        // outline whether or not the cell is also in the range.
        active && !selected && "ring-2 ring-[var(--primary)]",
        // Settled wash sits BELOW selection/active in the class order above, so a
        // paid cell that is also selected still reads as selected — payment state
        // must never swallow the gesture feedback the admin is driving.
        settlement && SETTLEMENT_PAINT[settlement].wash,
        // The corner mark is absolutely positioned; without a positioned ancestor it
        // would escape to the nearest one and land on the wrong cell. The settlement
        // washes already carry `relative`, so this only adds it when they don't.
        tenantBorne && "relative",
      )}
      style={Object.assign({}, billingStateStyle(billingState, value) ?? (colour ? { backgroundColor: colour } : undefined), selectionOutlineStyle(selectionEdges))}
      data-testid={`cell-${columnId}`}
      data-copy-value={value}
      // The mark's tooltip: the cell is the hoverable element (the mark itself is
      // pointer-events-none, so a title there would never fire).
      title={tenantBorne ? TENANT_BORNE_LABEL : undefined}
      // `data-settled` stays PAID-ONLY (it is what "this line is done" means to
      // every existing reader); `data-settlement` carries the finer state.
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-selected={selected ? "true" : undefined}
      data-active={active ? "true" : undefined}
      data-billing-state={hasBillableDisplay(value) ? billingState : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
      // Excel-Web V2: double-click enters edit mode with the caret at the click
      // point. preventDefault suppresses the browser's native word/text
      // selection; the page flips edit mode so arrows now move the caret.
      onDoubleClick={
        onDoubleClick
          ? (e) => {
              e.preventDefault();
              inputRef.current?.focus();
              onDoubleClick();
            }
          : undefined
      }
    >
      <input
        ref={setInputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        readOnly={excelMode && !editing}
        onKeyDown={(e) => {
          if (!excelMode || editing || e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key.length === 1 && !e.nativeEvent.isComposing) {
            e.preventDefault();
            typeToEditRef.current = true;
            handleChange(e.key);
            onDoubleClick?.();
          }
        }}
        title={amountError ?? undefined}
        aria-invalid={amountError ? true : undefined}
        // Excel-Web V2: the grid surface sets `user-select:none` to kill native
        // text selection during cell gestures; the input re-enables it
        // (`select-text`) so in-cell caret + text selection works while editing.
        // `selection:` recolours the in-field highlight to the --primary tint so
        // it never reads as the old gold ::selection (the reported "yellow").
        className={cn(
          "box-border block w-full min-w-0 max-w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-1 py-1 text-[clamp(13px,1em,18px)] text-[var(--text-primary)] outline-none transition selection:bg-[var(--primary)]/25 focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]",
          editing === false ? "cursor-cell select-none caret-transparent" : "select-text caret-auto",
          numeric && "whitespace-nowrap text-center tabular-nums",
          amountError && "border-rose-500 focus:ring-rose-400",
        )}
        style={billingStateStyle(billingState, value)}
      />
      {amountError && (
        <span className="mt-0.5 block text-[10px] leading-tight text-rose-600" data-testid={`amount-error-${columnId}`}>
          {amountError}
        </span>
      )}
      {settlement && <SettlementMarker state={settlement} />}
      {tenantBorne && <TenantBorneMark />}
      <CellDocumentMarks counts={documentCounts} />
      <SelectionFillHandle edges={selectionEdges} />
    </td>
  );
}

function LockedCell({
  columnId,
  display,
  numeric,
  settlement,
  tenantBorne,
  active,
  selected,
  selectionEdges,
  billingState,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  onActivate,
  onContextMenu,
  registerCell,
  documentCounts,
}: {
  columnId: ColumnId;
  display: string;
  numeric?: boolean;
  /** Server-derived payment state of the live grid charges behind this column. Visual only. */
  settlement?: PaintedSettlement;
  /** Renders the corner {@link TenantBorneMark}. A billed row is read-only but still
   *  carries the setting it was billed under, so the answer must not vanish here. */
  tenantBorne?: boolean;
  // P4 Task 3: active-cell nav for read-only value-bearing cells (billed
  // cells, `amount`, unit-row `rental`). All optional — absent ⇒ parity. The
  // <td> is the registered/focused node (no input); tabIndex=-1 makes the
  // page focus effect's .focus() land on it.
  // Task 3: onActivate receives the click event so a shift/ctrl click carries
  // its modifiers up to onCellActivate.
  active?: boolean;
  // Excel-Web V2: a read-only cell inside the selected range now paints the
  // same --primary tint as editable cells, so a range spanning read-only cells
  // (amount / billed / rental) reads as ONE solid block. onContextMenu wires the
  // custom right-click menu. Both optional ⇒ parity.
  selected?: boolean;
  selectionEdges?: SelectionEdges;
  billingState?: BillingCellState;
  // Selection (drag start/grow/end) is orthogonal to editing — a read-only cell
  // is selectable/copyable but not editable. Same handler types as EditableCell.
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  onActivate?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  registerCell?: (node: HTMLElement | null) => void;
  documentCounts?: CellDocumentCounts;
}) {
  const dashOnly = isDashDisplay(display);
  return (
    <td
      ref={registerCell}
      className={cn(
        "relative px-2 py-1.5 align-middle text-[18px] text-muted-foreground",
        categoryDividerClass(columnId),
        numeric && !dashOnly && "whitespace-nowrap text-center tabular-nums",
        dashOnly && "bg-transparent text-center align-middle",
        // V2: one bg utility via ternary (no Tailwind bg conflict) — the
        // selection tint when in-range-and-not-active, else the muted lock bg.
        dashOnly ? "bg-transparent" : "bg-muted/60",
        // P4 Task 4: visible SOLID --primary active ring (non-inset), matching
        // EditableCell — see its comment for the visibility rationale.
        selected && "relative",
        active && !selected && "ring-2 ring-[var(--primary)]",
        // Settlement wash last so it overrides the default muted lock bg — but a
        // SELECTED cell keeps the selection tint (the ternary above already won
        // the bg slot, and this only repaints when not selected).
        //
        // This is the branch that answers "locked but GREEN, not grey": a paid cell
        // inside a now-locked row renders here, and the emerald wash beats the
        // `bg-muted/60` lock default, so locking a paid row does not turn it grey.
        settlement && !dashOnly && !selected && SETTLEMENT_PAINT[settlement].wash,
        settlement && !dashOnly && selected && "relative",
        // See EditableCell: the corner mark needs a positioned ancestor of its own.
        tenantBorne && "relative",
      )}
      data-testid={`cell-${columnId}`}
      // See EditableCell: the mark is pointer-events-none, so the cell owns the tooltip.
      title={tenantBorne ? TENANT_BORNE_LABEL : undefined}
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-copy-value={display}
      data-billing-state={hasVisibleBillingState(columnId, display) ? billingState : undefined}
      style={Object.assign({}, billingStateStyle(billingState, display), selectionOutlineStyle(selectionEdges))}
      aria-readonly="true"
      tabIndex={registerCell ? -1 : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
    >
      {display}
      {settlement && !dashOnly && <SettlementMarker state={settlement} />}
      {tenantBorne && <TenantBorneMark />}
      <CellDocumentMarks counts={documentCounts} />
      <SelectionFillHandle edges={selectionEdges} />
    </td>
  );
}

function ReadOnlyCell({
  columnId,
  display,
  numeric,
  settlement,
  onView,
  onSecondary,
  viewLabel,
  viewTestId,
  viewKind = "view",
  ownerReportStatus,
  badgeCount,
  costActionRequired = false,
  costMargin,
  managementFeeReady = false,
  warningText,
  active,
  selected,
  selectionEdges,
  billingState,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  onActivate,
  onContextMenu,
  registerCell,
  documentCounts,
}: {
  columnId: ColumnId;
  display: string;
  numeric?: boolean;
  /** Server-derived payment state of the live grid charges behind this column. Visual only. */
  settlement?: PaintedSettlement;
  onView?: () => void;
  onSecondary?: () => void;
  viewLabel?: string;
  viewTestId?: string;
  viewKind?: "view" | "expense" | "recurring" | "report" | "configure";
  ownerReportStatus?: "draft" | "first_checked" | "approved";
  badgeCount?: number;
  costActionRequired?: boolean;
  /** Completed charged amount minus actual cost for this exact SST cell. */
  costMargin?: number | null;
  /** Management fee becomes collectible only after the related owner rent is collected. */
  managementFeeReady?: boolean;
  warningText?: string;
  // P4 Task 3: active-cell nav for the read-only expense totals. All optional
  // — absent ⇒ parity. The <td> is the registered/focused node; the inner
  // eye-Button (onView) keeps its own onClick and stops propagation so
  // opening the expense drawer never also fires activate.
  // Task 3: onActivate receives the click event so a shift/ctrl click carries
  // its modifiers up to onCellActivate.
  active?: boolean;
  // Excel-Web V2: selection tint + custom right-click menu (see LockedCell).
  selected?: boolean;
  selectionEdges?: SelectionEdges;
  billingState?: BillingCellState;
  // Selection is orthogonal to editing (see LockedCell): the read-only expense/
  // recurring totals are selectable + copyable, never editable.
  onCellPointerDown?: (e: React.PointerEvent<HTMLTableCellElement>) => void;
  onCellPointerEnter?: () => void;
  onCellPointerUp?: () => void;
  onActivate?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  registerCell?: (node: HTMLElement | null) => void;
  documentCounts?: CellDocumentCounts;
}) {
  const dashOnly = isDashDisplay(display);
  const managementSetupOnly = viewKind === "configure" && Boolean(warningText) && Boolean(onView);
  const usesLayeredLayout = Boolean(onView || warningText);
  return (
    <td
      ref={registerCell}
      className={cn(
        "relative overflow-hidden px-1.5 py-1.5 align-middle text-[18px] text-[var(--text-primary)]",
        categoryDividerClass(columnId),
        numeric && !dashOnly && "whitespace-nowrap text-center tabular-nums",
        dashOnly && "bg-transparent text-center align-middle",
        // V2: selection tint when in-range-and-not-active (see LockedCell).
        selected && "relative",
        // P4 Task 4: visible SOLID --primary active ring (non-inset), matching
        // EditableCell — see its comment for the visibility rationale.
        active && !selected && "ring-2 ring-[var(--primary)]",
        // Settlement wash — after selection/active so it never swallows their feedback.
        settlement && !dashOnly && SETTLEMENT_PAINT[settlement].wash,
      )}
      data-testid={`cell-${columnId}`}
      data-settled={settlement === "paid" ? "true" : undefined}
      data-settlement={settlement}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-copy-value={display}
      data-billing-state={hasVisibleBillingState(columnId, display) ? billingState : undefined}
      style={Object.assign(
        {},
        ownerReportStatus ? {
          backgroundColor: ownerReportStatus === "draft" ? "#FF8C00" : ownerReportStatus === "first_checked" ? "#FFFF00" : "#00FF00",
          color: "#082B4F",
        } : managementFeeReady && !dashOnly ? {
          backgroundColor: "#00FF00",
          color: "#082B4F",
        } : billingStateStyle(billingState, display, columnId),
        selectionOutlineStyle(selectionEdges),
      )}
      tabIndex={registerCell ? -1 : undefined}
      onPointerDown={onCellPointerDown}
      onPointerEnter={onCellPointerEnter}
      onPointerUp={onCellPointerUp}
      onClick={(e) => onActivate?.(e)}
      onContextMenu={onContextMenu}
    >
      {usesLayeredLayout ? (
        <div data-testid="readonly-cell-stack" className="contents">
          {/* The amount owns an independent layer covering the complete table
              cell. Bottom actions can therefore never push it upward: it stays
              mathematically centred both horizontally and vertically. */}
          <span
            data-testid="readonly-cell-amount"
            className="pointer-events-none absolute inset-0 z-0 flex min-w-0 items-center justify-center overflow-hidden px-1 text-center tabular-nums"
          >
            <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{display}</span>
          </span>

          {/* One shared bottom rail for every read-only action. The rail is
              independent from the amount layer, centred, and pinned to the
              bottom of the real <td> rather than following normal text flow. */}
          <span
            data-testid="readonly-cell-bottom-rail"
            className="absolute inset-x-0 bottom-1 z-20 flex min-w-0 max-w-full flex-wrap items-end justify-center gap-0.5 px-1"
          >
            {onView && !managementSetupOnly && (
              <span
                data-testid="readonly-cell-actions"
                className="relative inline-flex min-w-0 max-w-full items-center justify-center gap-0.5"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={viewLabel}
                  data-testid={viewTestId}
                  // When the cell is nav-wired (onActivate present), stop the click
                  // from ALSO bubbling to the <td>'s onActivate — opening the
                  // expense drawer must not also move the active cell. Parity: when
                  // onActivate is absent this is exactly the old `onClick={onView}`.
                  onClick={onActivate ? (e) => { e.stopPropagation(); onView?.(); } : onView}
                  className="h-6 w-6 shrink-0 text-[var(--navy)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]"
                >
                  {viewKind === "expense" ? <ReceiptText className="h-4 w-4" /> : viewKind === "recurring" ? <ListPlus className="h-4 w-4" /> : viewKind === "report" ? <FileText className="h-4 w-4" /> : viewKind === "configure" ? <Settings2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                {viewKind === "report" && onSecondary && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="h-6 w-6 shrink-0 text-[var(--navy)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]"
                    aria-label="Download owner income report PDF"
                    data-testid="owner-report-download-btn"
                    onClick={(e) => { e.stopPropagation(); onSecondary(); }}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                {badgeCount != null && <CountBadge count={badgeCount} testId={`${viewTestId}-badge`} />}
              </span>
            )}
            {viewKind === "expense" && costActionRequired && (
              <Button type="button" variant="outline" size="sm" className="h-6 max-w-full min-w-0 overflow-hidden border-orange-500 bg-orange-50 px-1 text-[clamp(9px,0.7vw,12px)] font-extrabold whitespace-nowrap text-orange-900 shadow-sm hover:bg-orange-100" onClick={onActivate ? (e) => { e.stopPropagation(); onView?.(); } : onView}>
                Add Cost
              </Button>
            )}
            {viewKind === "expense" && !costActionRequired && badgeCount != null && badgeCount > 0 && costMargin != null && (
              <span
                data-testid={`${viewTestId}-margin`}
                className={cn(
                  "pointer-events-none h-6 max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-1 py-0.5 text-center text-[clamp(8px,0.65vw,12px)] font-extrabold shadow-sm",
                  costMargin > 0 && "border-emerald-600 bg-emerald-50 text-emerald-800",
                  costMargin < 0 && "border-red-600 bg-red-50 text-red-800",
                  costMargin === 0 && "border-slate-500 bg-slate-50 text-slate-700",
                )}
              >
                {costMargin > 0 ? "Profit" : costMargin < 0 ? "Loss" : "Break-even"} RM{Math.abs(costMargin).toFixed(2)}
              </span>
            )}
            {warningText && (managementSetupOnly ? (
              <button
                type="button"
                className="block h-6 w-fit max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border border-red-500 bg-red-50 px-1.5 text-[11px] font-extrabold leading-tight text-red-800 hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--gold)]"
                onClick={(event) => {
                  event.stopPropagation();
                  onView?.();
                }}
              >
                Set management fee
              </button>
            ) : (
              <span className="block h-6 w-fit max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border border-red-500 bg-red-50 px-1.5 py-0.5 text-[11px] font-extrabold leading-tight text-red-800">
                {warningText}
              </span>
            ))}
          </span>
        </div>
      ) : display}
      {settlement && !dashOnly && <SettlementMarker state={settlement} />}
      <CellDocumentMarks counts={documentCounts} />
      <SelectionFillHandle edges={selectionEdges} />
    </td>
  );
}

// ── GridTable ─────────────────────────────────────────────────────────────

export function GridTable({
  rows,
  columns,
  displayMode = "easy-read",
  density = "comfortable",
  canEdit = true,
  onCellEdit,
  onOpenSettings,
  onConfigureManagementFee,
  onViewExpenses,
  onViewRecurring,
  onOpenAttachments,
  onViewTenantSummary,
  onViewTenantDocuments,
  onViewOwnerReport,
  onDownloadOwnerReport,
  onViewActivity,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  isCellSelected,
  selectionEdges,
  cellColour,
  isCellActive,
  isCellEditing,
  isCellPendingRebill,
  onCellActivate,
  onCellContextMenu,
  onCellDoubleClick,
  onSelectColumns,
  registerCell,
  staged,
  registerClearInternalStaged,
  billableApartmentIds,
  selectedForBill,
  allBillableSelected,
  someBillableSelected,
  onToggleBillSelection,
  onToggleSelectAllForBill,
  showVacant,
}: GridTableProps) {
  const bandGroups = groupBands(columns);
  const propertyGroups = Array.from(
    rows.reduce((groups, row) => {
      const key = row.propertyId || row.propertyName || "unknown";
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { key, name: row.propertyName || "Unknown condo", rows: [row] });
      return groups;
    }, new Map<string, { key: string; name: string; rows: GridRow[] }>()),
  ).map(([, group]) => group);
  const dataColumns = columns.filter((c) => c.band); // everything except unitCode
  const gridSurfaceRef = useRef<HTMLDivElement | null>(null);
  const automaticallyAutoFittedRef = useRef(false);
  const [columnWidthOverrides, setColumnWidthOverrides] = useState<
    Partial<Record<GridDisplayMode, Partial<Record<ColumnId, number>>>>
  >({});

  function columnWidth(columnId: ColumnId): number {
    return columnWidthOverrides[displayMode]?.[columnId]
      ?? initialColumnWidth(columnId, displayMode);
  }

  function setColumnWidth(columnId: ColumnId, width: number) {
    setColumnWidthOverrides((previous) => ({
      ...previous,
      [displayMode]: {
        ...previous[displayMode],
        [columnId]: clampColumnWidth(columnId, width),
      },
    }));
  }

  const tablePixelWidth = columnWidth("unitCode")
    + dataColumns.reduce((total, column) => total + columnWidth(column.id), 0);

  function autoFitColumn(columnId: ColumnId) {
    const surface = gridSurfaceRef.current;
    if (!surface) return;
    const width = autoFitWidthForColumn(surface, columnId, bandGroups, columnWidth);
    setColumnWidth(columnId, width);
  }

  // Excel opens a sheet with every visible column fitted to its real content.
  // Do the same once the first real billing rows have rendered. This is
  // deliberately one-shot per page mount: subsequent Live refreshes must not
  // overwrite widths that the user has manually dragged afterwards.
  useEffect(() => {
    if (displayMode !== "fit-all" || rows.length === 0 || automaticallyAutoFittedRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      const surface = gridSurfaceRef.current;
      if (!surface || automaticallyAutoFittedRef.current) return;

      const groups = groupBands(columns);
      const columnIds: ColumnId[] = [
        "unitCode",
        ...columns.filter((column) => column.band).map((column) => column.id),
      ];
      const currentWidths = columnWidthOverrides[displayMode] ?? {};
      const widthFor = (columnId: ColumnId) => currentWidths[columnId]
        ?? initialColumnWidth(columnId, displayMode);
      const fittedWidths = Object.fromEntries(
        columnIds.map((columnId) => [
          columnId,
          clampColumnWidth(
            columnId,
            autoFitWidthForColumn(surface, columnId, groups, widthFor),
          ),
        ]),
      ) as Partial<Record<ColumnId, number>>;

      automaticallyAutoFittedRef.current = true;
      setColumnWidthOverrides((previous) => ({
        ...previous,
        [displayMode]: {
          ...previous[displayMode],
          ...fittedWidths,
        },
      }));
    });

    return () => window.cancelAnimationFrame(frame);
  }, [columns, columnWidthOverrides, displayMode, rows.length]);

  // Per-cell keystroke-echo buffer: `${cellKey}:${columnId}` -> user-TYPED
  // value. This is GridTable's own internal state, kept separate from the
  // `staged` PROP (the page's useStagedEdits buffer) so a real keystroke
  // always repaints instantly with no page round-trip (R7).
  const [internalStaged, setInternalStaged] = useState<Record<string, string>>({});

  function stageEdit(cellKey: string, columnId: ColumnId, value: string) {
    if (!canEdit) return;
    setInternalStaged((prev) => ({ ...prev, [`${cellKey}:${columnId}`]: value }));
    onCellEdit?.(cellKey, columnId, value);
  }

  // P4 Task 5 (Esc-revert, Hard Point B): expose a stable imperative clear of the
  // internalStaged echo to the page, registered once on mount (like registerCell).
  // Removing the key drops the top-precedence echo so stagedOrSeed falls back to
  // the page buffer (also being unstaged by the page) or the seed — the input
  // then repaints its saved value. Deleting an absent key is a safe no-op.
  const clearInternalStaged = useCallback((cellKey: string, columnId: string) => {
    setInternalStaged((prev) => {
      const key = `${cellKey}:${columnId}`;
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  useEffect(() => {
    registerClearInternalStaged?.(clearInternalStaged);
  }, [registerClearInternalStaged, clearInternalStaged]);

  // ui-task-10g: display precedence is (1) a real keystroke echo — internal,
  // instant, no page round-trip — (2) else the page's OWN staged buffer (the
  // `staged` prop — surfaces ctrl-fill writes and ui-9 crash-recovery, both of
  // which stage directly into the PAGE buffer and never touch
  // `internalStaged`) — (3) else the seed. `staged` is OPTIONAL: when absent,
  // step 2 is skipped entirely — byte-identical to before this task.
  function stagedOrSeed(cellKey: string, columnId: ColumnId, seed: string): string {
    const key = `${cellKey}:${columnId}`;
    if (Object.prototype.hasOwnProperty.call(internalStaged, key)) return internalStaged[key];
    if (staged && Object.prototype.hasOwnProperty.call(staged, key)) return staged[key];
    return seed;
  }

  // Final-review Finding 1: distinguishes "seeded/as-saved" from
  // "staged/being-edited" — same two sources `stagedOrSeed` consults, but
  // WITHOUT the seed fallback. Used by the Amount cell to decide whether to
  // show the stored server snapshot (no staged edit on this row's
  // previousKwh/currentKwh) or the live re-priced preview (admin is actively
  // editing). A staged empty string ("" — user cleared the field) still
  // counts as staged: hasOwnProperty is true, so amountPreview correctly
  // falls back to the stored amount via its own NaN guard rather than this
  // helper masking the edit.
  function isStaged(cellKey: string, columnId: ColumnId): boolean {
    const key = `${cellKey}:${columnId}`;
    if (Object.prototype.hasOwnProperty.call(internalStaged, key)) return true;
    if (staged && Object.prototype.hasOwnProperty.call(staged, key)) return true;
    return false;
  }

  function visibleSubRows(row: GridRow): GridSubRow[] {
    return showVacant ? row.subRows : row.subRows.filter((subRow) => subRow.tenancyId != null);
  }

  /** Totals reflect the currently filtered rows and any staged values visible in the grid. */
  function columnTotal(columnId: ColumnId): string {
    // Meter readings are snapshots, not money; adding meter positions would be misleading.
    if (columnId === "previousKwh" || columnId === "currentKwh") return "—";
    if (
      columnId === "agreementFee"
      && !rows.some((row) =>
        (row.agreementFees?.new.state ?? "none") !== "none"
        || (row.agreementFees?.renewal.state ?? "none") !== "none")
    ) return "—";
    if (columnId === "ownerPayout") {
      return rows.reduce((sum, row) => sum + projectedOwnerPayout(row), 0).toFixed(2);
    }
    let total = 0;
    const add = (raw: string | null | undefined) => {
      if (raw == null || raw === "" || raw === "—") return;
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      total += value;
    };

    for (const row of rows) {
      if (columnId === "rental" || columnId === "deposit") {
        for (const subRow of visibleSubRows(row)) add(columnId === "rental" ? subRow.rental : subRow.deposit);
        continue;
      }
      if (columnId === "amount") {
        // Whole-unit tenancies do not use room-level meter readings, so any
        // legacy reading snapshot must not leak into the visible money total.
        if (row.isWholeUnit) continue;
        for (const subRow of visibleSubRows(row)) {
          const prev = stagedOrSeed(subRow.listingId, "previousKwh", subRow.previousKwh ?? "");
          const cur = stagedOrSeed(subRow.listingId, "currentKwh", subRow.currentKwh ?? "");
          const edited = isStaged(subRow.listingId, "previousKwh") || isStaged(subRow.listingId, "currentKwh");
          add(edited ? amountPreview(subRow, prev, cur) : subRow.amount);
        }
        continue;
      }
      if (["tenantExpNonSst", "tenantExpWithSst", "ownerExpNonSst", "ownerExpWithSst", "agreementFee", "managementFeeSst", "ownerRecurring", "tenantRecurring"].includes(columnId)) {
        add(readOnlyValue(row, columnId));
        continue;
      }
      if (!isApplicable(row, columnId)) continue;
      const seed = seedValue(row, columnId);
      let displayedSeed = seed;
      if (columnId === "cleaningOwner" || columnId === "cleaningTenant" || columnId === "wifiOwner" || columnId === "wifiTenant" || columnId === "maintenanceFee") {
        const governed = scalarSettingsLock(row, columnId);
        const generated = scalarGeneratedAmount(row, columnId);
        displayedSeed = governed === false ? seed : (generated || seed);
      }
      add(stagedOrSeed(row.apartmentId, columnId, displayedSeed));
    }
    // Every remaining column is monetary. A blank monetary total means zero,
    // not "not applicable"; reserve the dash for meter snapshots above.
    return total.toFixed(2);
  }

  return (
    // Task 11 (R4b): NOT <TableWrap> (components/ui.tsx, frozen/shared with
    // other tables) — same visual classes (rounded border), but WITHOUT its
    // own overflow-x-auto. TableWrap's overflow-x-auto forces the browser to
    // also compute overflow-y:auto on it (the standard CSS overflow-x/
    // overflow-y coupling — an axis left "visible" is bumped to "auto" once
    // the other axis is non-visible), which makes TableWrap — not the page's
    // bounded/scrollable grid-region — the nearest ancestor scroll container
    // for position:sticky. TableWrap itself never gets a height constraint
    // of its own, so it never actually scrolls vertically, leaving a sticky
    // top-* header inert against it (empirically verified: the header moved
    // by the full scroll delta, i.e. did not stick, with TableWrap's
    // overflow-x-auto present in the ancestor chain; dropping it here — and
    // letting grid-region own scrolling on both axes directly — settles the
    // header at exactly the scrollport boundary instead, confirming a real
    // pin). Horizontal Unit-column pin is unaffected: grid-region already
    // carries overflow-x-auto unconditionally, so it correctly absorbs the
    // table's horizontal overflow that TableWrap no longer claims.
    // Excel-Web V2: `select-none` on the grid surface kills the browser's native
    // text selection for EVERY pointer gesture (drag/shift/ctrl/double-click) —
    // the reported gold ::selection "yellow highlight" and every other
    // native-selection conflict. The active cell's <input> re-enables it
    // (`select-text`, see EditableCell) so in-cell editing keeps a working caret
    // and text selection.
    <div
      ref={gridSurfaceRef}
      data-density={density}
      data-display-mode={displayMode}
      className={cn(
        "select-none rounded-lg border border-[var(--border)] bg-white dark:bg-card",
        density === "compact" && "[&_tbody_td]:py-1",
        displayMode === "fit-all" && "[&_tbody_td]:px-1 [&_thead_th]:px-1",
      )}
    >
      <DataTable
        className={cn(
          "billing-matrix min-w-0 table-fixed",
          displayMode === "easy-read"
            ? "text-[18px]"
            : "text-[15px] [&_td]:text-[15px] [&_th]:text-[15px] [&_input]:text-[15px]",
        )}
        style={{ width: `${tablePixelWidth}px`, minWidth: `${tablePixelWidth}px` }}
      >
        <colgroup>
          <col data-column-id="unitCode" style={{ width: `${columnWidth("unitCode")}px` }} />
          {dataColumns.map((column) => (
            <col
              key={column.id}
              data-column-id={column.id}
              style={{ width: `${columnWidth(column.id)}px` }}
            />
          ))}
        </colgroup>
        <TableHead>
          <tr>
              <th
                rowSpan={2}
                data-column-id="unitCode"
                className="relative sticky left-0 top-0 z-30 select-text border-r-2 border-r-[var(--navy)] bg-[var(--page-bg)] px-3 py-1 text-center text-[18px] font-bold tracking-normal align-middle"
              >
              <div className="flex items-center justify-center gap-2">
                {/* Select-all: checks every BILLABLE unit at once (indeterminate
                    when only some are). §15 bulk-selection — toggles the visible
                    billable set only, never a silent full-filter select. Disabled
                    when nothing is billable. Absent unless the page wires Bill
                    selection (parity for GridTable-only tests). */}
                {onToggleSelectAllForBill && (
                  <Checkbox
                    aria-label="Select all visible units"
                    data-testid="bill-select-all"
                    checked={!!allBillableSelected}
                    indeterminate={!!someBillableSelected}
                    disabled={!billableApartmentIds || billableApartmentIds.size === 0}
                    onCheckedChange={() => onToggleSelectAllForBill()}
                  />
                )}
                <span>Unit</span>
              </div>
              <ColumnResizeHandle
                columnId="unitCode"
                label="Unit"
                width={columnWidth("unitCode")}
                onResize={setColumnWidth}
                onAutoFit={autoFitColumn}
              />
            </th>
            {bandGroups.map((g) => (
              <th
                key={g.band}
                colSpan={g.columns.length}
                data-testid="band-header"
                data-band-name={g.band}
                // Excel-Web V2: a band header selects EVERY sub-column under it
                // (all rows). cursor-pointer + hover cue when interactive.
                onClick={onSelectColumns ? (e) => { if (!hasNativeTextSelection()) onSelectColumns(g.columns.map((c) => c.id), resolveClickMods(e)); } : undefined}
                title={onSelectColumns ? `Select all ${g.band} columns` : undefined}
                className={cn(
                  "sticky top-0 z-20 h-10 select-text whitespace-nowrap border-x-2 border-b-2 border-x-[var(--navy)] border-b-[var(--navy)] bg-[var(--page-bg)] px-2 py-1 text-center text-[18px] font-bold leading-none tracking-normal align-middle",
                  onSelectColumns && "cursor-pointer transition hover:bg-[var(--primary)]/10",
                )}
              >
                {g.band}
              </th>
            ))}
          </tr>
          <tr>
            {dataColumns.map((c) => (
              <th
                key={c.id}
                data-testid={`col-header-${c.id}`}
                // Excel-Web V2: a sub-column header selects that ONE column (all rows).
                onClick={onSelectColumns ? (e) => { if (!hasNativeTextSelection()) onSelectColumns([c.id], resolveClickMods(e)); } : undefined}
                title={onSelectColumns ? "Select column" : undefined}
                className={cn(
                  "relative sticky top-10 z-20 h-10 select-text whitespace-nowrap bg-[var(--page-bg)] px-2 py-1 text-center text-[18px] font-bold leading-none tracking-normal align-middle border-l border-[var(--border)]",
                  categoryDividerClass(c.id),
                  onSelectColumns && "cursor-pointer transition hover:bg-[var(--primary)]/10",
                )}
              >
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap pr-3">{c.header}</span>
                <ColumnResizeHandle
                  columnId={c.id}
                  label={c.header}
                  width={columnWidth(c.id)}
                  onResize={setColumnWidth}
                  onAutoFit={autoFitColumn}
                />
              </th>
            ))}
          </tr>
        </TableHead>
        <tbody>
          {rows.length === 0 && <EmptyRow colSpan={columns.length} label="No apartments for this period." />}
          {propertyGroups.map((group) => (
            <Fragment key={group.key}>
              <tr data-testid="property-divider" className="border-y-2 border-[var(--gold)] bg-[var(--navy)]">
                <td colSpan={columns.length} className={cn("select-text px-4 text-left text-[18px] font-bold text-[var(--gold-light)]", density === "compact" ? "py-1" : "py-2.5")}>
                  <span className="inline-flex items-center gap-2"><Building2 className="h-5 w-5" />{group.name}</span>
                </td>
              </tr>
              {group.rows.map((row) => (
                <GridUnitRowGroup
                  key={row.apartmentId}
                  row={row}
                  canEdit={canEdit}
                  dataColumns={dataColumns}
                  stagedOrSeed={stagedOrSeed}
                  isStaged={isStaged}
                  stageEdit={stageEdit}
                  onOpenSettings={onOpenSettings}
                  onConfigureManagementFee={onConfigureManagementFee}
                  onViewExpenses={onViewExpenses}
                  onViewRecurring={onViewRecurring}
                  onOpenAttachments={onOpenAttachments}
                  onViewTenantSummary={onViewTenantSummary}
                  onViewTenantDocuments={onViewTenantDocuments}
                  onViewOwnerReport={onViewOwnerReport}
                  onDownloadOwnerReport={onDownloadOwnerReport}
                  onViewActivity={onViewActivity}
                  onCellPointerDown={onCellPointerDown}
                  onCellPointerEnter={onCellPointerEnter}
                  onCellPointerUp={onCellPointerUp}
                  isCellSelected={isCellSelected}
                  selectionEdges={selectionEdges}
                  cellColour={cellColour}
                  isCellActive={isCellActive}
                  isCellEditing={isCellEditing}
                  isCellPendingRebill={isCellPendingRebill}
                  onCellActivate={onCellActivate}
                  onCellContextMenu={onCellContextMenu}
                  onCellDoubleClick={onCellDoubleClick}
                  registerCell={registerCell}
                  selectableForBill={!!billableApartmentIds?.has(row.apartmentId)}
                  selectedForBill={!!selectedForBill?.has(row.apartmentId)}
                  onToggleBillSelection={onToggleBillSelection}
                  showVacant={showVacant}
                  density={density}
                />
              ))}
            </Fragment>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot data-testid="grid-total-row">
            <tr className="border-t-2 border-[var(--gold)] bg-[var(--navy)] text-[var(--gold-light)]">
              <td className="sticky bottom-0 left-0 z-30 border-r-2 border-r-[var(--gold)] bg-[var(--navy)] px-4 py-3 text-center text-[18px] font-extrabold">TOTAL</td>
              {dataColumns.map((column) => (
                <td key={column.id} data-testid={`total-${column.id}`} className={cn("sticky bottom-0 z-20 bg-[var(--navy)] px-2 py-3 text-center text-[18px] font-extrabold tabular-nums", categoryDividerClass(column.id))}>
                  {columnTotal(column.id)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </DataTable>
    </div>
  );
}

// ── one apartment's row(s): unit row + optional nested tenant sub-rows + prior strip ──

export type RenewalSignal = {
  tenancyId: string;
  label: string;
  urgent: boolean;
  tone: "warning" | "danger" | "success" | "neutral";
  days: number;
};

function tenancyEndDays(endDate: string, now: Date): number | null {
  const datePart = endDate.slice(0, 10);
  const end = new Date(`${datePart}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.ceil((end.getTime() - today) / 86_400_000);
}

/**
 * The uploaded KAEN workbook uses genuinely narrow, content-led Excel columns
 * (most money columns are only about 45–60px wide). Fit All mirrors that
 * behaviour with real pixel columns instead of percentage columns that stretch
 * to fill the browser and leave large empty gutters. Easy Read keeps the more
 * generous legacy widths as an optional reading preset.
 */
function compactColumnWidth(columnId: ColumnId): number {
  switch (columnId) {
    case "unitCode":
      return 218;
    case "previousKwh":
    case "currentKwh":
      return 105;
    case "ownerPayout":
      return 84;
    case "tenantExpNonSst":
    case "tenantExpWithSst":
    case "ownerExpNonSst":
    case "ownerExpWithSst":
      return 66;
    case "rental":
      return 60;
    case "deposit":
      return 64;
    case "agreementFee":
      return 116;
    case "amount":
      return 60;
    case "maintenanceFee":
      return 66;
    case "managementFeeSst":
      return 76;
    default:
      return 56;
  }
}

function initialColumnWidth(columnId: ColumnId, displayMode: GridDisplayMode): number {
  if (displayMode === "fit-all") return compactColumnWidth(columnId);
  return columnId === "unitCode" ? 300 : preferredColumnWidth(columnId);
}

const MIN_COLUMN_WIDTH = 42;
const MAX_COLUMN_WIDTH = 420;
const MIN_UNIT_COLUMN_WIDTH = 180;
const MAX_UNIT_COLUMN_WIDTH = 520;

function clampColumnWidth(columnId: ColumnId, width: number): number {
  const min = columnId === "unitCode" ? MIN_UNIT_COLUMN_WIDTH : MIN_COLUMN_WIDTH;
  const max = columnId === "unitCode" ? MAX_UNIT_COLUMN_WIDTH : MAX_COLUMN_WIDTH;
  return Math.max(min, Math.min(max, Math.round(width)));
}

function normalisedAutoFitText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function measuredTextWidth(element: Element, value?: string | null): number {
  const text = normalisedAutoFitText(value ?? element.textContent);
  if (!text) return 0;

  const probe = document.createElement("span");
  const computed = window.getComputedStyle(element);
  Object.assign(probe.style, {
    position: "fixed",
    left: "-10000px",
    top: "-10000px",
    visibility: "hidden",
    whiteSpace: "nowrap",
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    letterSpacing: computed.letterSpacing,
    textTransform: computed.textTransform,
  });
  probe.textContent = text;
  document.body.appendChild(probe);
  const rendered = probe.getBoundingClientRect().width;
  probe.remove();

  // JSDOM has no layout engine. The deterministic fallback keeps the AutoFit
  // interaction testable while real browsers use the exact rendered font.
  return rendered > 0 ? rendered : text.length * 8;
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function horizontalChromeWidth(element: Element, fallback: number): number {
  const computed = window.getComputedStyle(element);
  const measured = cssPixels(computed.paddingLeft)
    + cssPixels(computed.paddingRight)
    + cssPixels(computed.borderLeftWidth)
    + cssPixels(computed.borderRightWidth);
  return Math.max(fallback, measured);
}

/**
 * Returns the OUTER width an Excel-style column needs in order to show its
 * longest visible item without ellipsis. `data-copy-value` remains the clean
 * clipboard value, but AutoFit must also consider controls living beside it
 * (for example "Set management fee", Add Cost and document buttons).
 */
function measuredAutoFitWidth(element: Element): number {
  const copyValue = normalisedAutoFitText(element.getAttribute("data-copy-value"));
  const visibleText = normalisedAutoFitText(element.textContent);
  const explicitContent = element.querySelectorAll('[data-autofit-content="true"]');
  let contentWidth = Math.max(
    measuredTextWidth(element, copyValue),
    copyValue || explicitContent.length > 0 ? 0 : measuredTextWidth(element, visibleText),
  );

  const visibleControls = element.querySelectorAll(
    'button:not([data-column-resize-handle="true"]), input, select, [data-autofit-content="true"]',
  );
  visibleControls.forEach((control) => {
    let controlText = control.textContent;
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      controlText = control.value;
    }
    const controlWidth = measuredTextWidth(control, controlText)
      + horizontalChromeWidth(control, 12);
    contentWidth = Math.max(contentWidth, controlWidth);
  });

  // The header divider sits over the right edge. Reserving its full hit area
  // is what prevents short labels such as OWNER from still ending in "..."
  // immediately after AutoFit.
  const resizeHandleWidth = element.querySelector('[data-column-resize-handle="true"]')
    ? 14
    : 0;
  const safetyPixel = 4;
  return Math.ceil(contentWidth + horizontalChromeWidth(element, 10) + resizeHandleWidth + safetyPixel);
}

function autoFitWidthForColumn(
  surface: HTMLElement,
  columnId: ColumnId,
  bandGroups: BandGroup[],
  widthFor: (columnId: ColumnId) => number,
): number {
  const candidates = Array.from(surface.querySelectorAll(
    columnId === "unitCode"
      ? '[data-column-id="unitCode"]'
      : `[data-testid="col-header-${columnId}"], [data-testid="cell-${columnId}"], [data-testid="total-${columnId}"]`,
  ));
  let longest = candidates.reduce(
    (width, element) => Math.max(width, measuredAutoFitWidth(element)),
    0,
  );

  // A merged Excel category header belongs to the combined width of its
  // children. For one-column categories (Management Fee, Owner Payout, Maint
  // Fee) the sub-column AutoFit must therefore also fit the category title.
  // For multi-column categories, only add the shortfall left after the other
  // child columns have contributed their current widths.
  const group = bandGroups.find((candidate) =>
    candidate.columns.some((column) => column.id === columnId));
  if (group) {
    const bandHeader = Array.from(surface.querySelectorAll<HTMLElement>('[data-band-name]'))
      .find((element) => element.dataset.bandName === group.band);
    if (bandHeader) {
      const siblingWidth = group.columns
        .filter((column) => column.id !== columnId)
        .reduce((total, column) => total + widthFor(column.id), 0);
      longest = Math.max(longest, measuredAutoFitWidth(bandHeader) - siblingWidth);
    }
  }

  return longest;
}

type ColumnResizeHandleProps = {
  columnId: ColumnId;
  label: string;
  width: number;
  onResize: (columnId: ColumnId, width: number) => void;
  onAutoFit: (columnId: ColumnId) => void;
};

function ColumnResizeHandle({
  columnId,
  label,
  width,
  onResize,
  onAutoFit,
}: ColumnResizeHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (typeof event.currentTarget.hasPointerCapture === "function"
      && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
  }

  return (
    <button
      type="button"
      aria-label={`Resize ${label} column`}
      title={`Drag to resize ${label}; double-click to AutoFit`}
      data-testid={`column-resize-${columnId}`}
      data-column-resize-handle="true"
      className="absolute right-0 top-0 z-40 h-full w-3 cursor-col-resize touch-none border-0 bg-transparent p-0 hover:bg-[var(--gold)]/55 focus:bg-[var(--gold)]/55 focus:outline-none"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
        if (typeof event.currentTarget.setPointerCapture === "function") {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        const activeDrag = drag.current;
        if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(columnId, activeDrag.startWidth + event.clientX - activeDrag.startX);
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onAutoFit(columnId);
      }}
    />
  );
}

export function formatTenancyEndDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Compact business identity for the pinned Unit cell. Some legacy imports
 * already stored the property short form at the start of `unitCode`; avoid
 * producing labels such as "PV9 PV9 A-13-13" while newer records render the
 * intended "Property Short Form + Unit Number" format. */
export function formatUnitIdentity(propertyCode: string | null | undefined, unitCode: string): string {
  const shortForm = propertyCode?.trim() ?? "";
  const unit = unitCode.trim();
  if (!shortForm) return unit;
  const shortLower = shortForm.toLocaleLowerCase();
  const unitLower = unit.toLocaleLowerCase();
  if (
    unitLower === shortLower
    || unitLower.startsWith(`${shortLower} `)
    || unitLower.startsWith(`${shortLower}-`)
  ) return unit;
  return `${shortForm} ${unit}`;
}

export function renewalSignalForSubRow(row: GridRow, subRow: GridSubRow, now = new Date()): RenewalSignal | null {
  if (!subRow.tenancyId || !subRow.tenancyEndDate) return null;
  const days = tenancyEndDays(subRow.tenancyEndDate, now);
  if (days == null || days > 60) return null;

  const decision = subRow.renewalDecision ?? "pending";
  const suffix = days >= 0 ? `${days}d left` : `${Math.abs(days)}d overdue`;
  if (decision === "not_renew") {
    return { tenancyId: subRow.tenancyId, label: `Move-out planned · ${suffix}`, urgent: false, tone: "neutral", days };
  }
  if (decision === "contacted") {
    const urgent = days <= 14;
    return { tenancyId: subRow.tenancyId, label: `Renewal answer pending · ${suffix}`, urgent, tone: urgent ? "danger" : "warning", days };
  }
  if (decision === "renew") {
    // RM0 is still an explicit TA fee decision and is deliberately visible for
    // correction; only the absence of a charge means Operations has not added it.
    const feeCreated = (row.agreementFees?.renewal.state ?? "none") !== "none";
    return {
      tenancyId: subRow.tenancyId,
      label: feeCreated ? "Renewal ready to complete" : "Renewal confirmed · add TA fee",
      urgent: !feeCreated,
      tone: feeCreated ? "success" : "warning",
      days,
    };
  }
  const urgent = days <= 30;
  return {
    tenancyId: subRow.tenancyId,
    label: `Ask tenant about renewal · ${suffix}`,
    urgent,
    tone: urgent ? "danger" : "warning",
    days,
  };
}

export function renewalSignalForRow(row: GridRow, now = new Date()): RenewalSignal | null {
  return row.subRows
    .map((subRow) => renewalSignalForSubRow(row, subRow, now))
    .filter((signal): signal is RenewalSignal => signal != null)
    .sort((a, b) => a.days - b.days)[0] ?? null;
}

function TenancyEndControl({ row, subRow }: { row: GridRow; subRow: GridSubRow }) {
  const endDate = formatTenancyEndDate(subRow.tenancyEndDate);
  const signal = renewalSignalForSubRow(row, subRow);
  if (!endDate && !signal) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 not-italic">
      {endDate && (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[var(--gold)]/60 bg-[var(--gold)]/10 px-1.5 py-0.5 text-[12px] font-semibold text-[var(--navy)]"
          title={`Tenancy ends on ${endDate}`}
          data-testid="tenancy-end-date"
        >
          <CalendarClock className="h-3.5 w-3.5 text-[var(--gold)]" aria-hidden="true" />
          Ends {endDate}
        </span>
      )}
      {signal && (
        <a
          href={`/tenancy/tenancies?renewal=${encodeURIComponent(signal.tenancyId)}`}
          className={cn(
            "inline-flex min-h-7 items-center rounded-full border px-2 py-0.5 text-[11px] font-extrabold leading-tight shadow-sm transition hover:-translate-y-px hover:shadow-md",
            signal.tone === "danger" && "border-red-500 bg-red-100 text-red-800",
            signal.tone === "warning" && "border-orange-400 bg-orange-100 text-orange-900",
            signal.tone === "success" && "border-emerald-500 bg-emerald-100 text-emerald-800",
            signal.tone === "neutral" && "border-slate-400 bg-slate-100 text-slate-800",
          )}
          title="Open the renewal follow-up workflow"
          data-testid="renewal-signal"
        >
          {signal.label}
        </a>
      )}
    </span>
  );
}

function GridUnitRowGroup({
  row,
  canEdit,
  dataColumns,
  stagedOrSeed,
  isStaged,
  stageEdit,
  onOpenSettings,
  onConfigureManagementFee,
  onViewExpenses,
  onViewRecurring,
  onOpenAttachments,
  onViewTenantSummary,
  onViewTenantDocuments,
  onViewOwnerReport,
  onDownloadOwnerReport,
  onViewActivity,
  onCellPointerDown,
  onCellPointerEnter,
  onCellPointerUp,
  isCellSelected,
  selectionEdges,
  cellColour,
  isCellActive,
  isCellEditing,
  isCellPendingRebill,
  onCellActivate,
  onCellContextMenu,
  onCellDoubleClick,
  registerCell,
  selectableForBill,
  selectedForBill,
  onToggleBillSelection,
  showVacant,
  density,
}: {
  row: GridRow;
  canEdit: boolean;
  dataColumns: GridColumn[];
  stagedOrSeed: (cellKey: string, columnId: ColumnId, seed: string) => string;
  isStaged: (cellKey: string, columnId: ColumnId) => boolean;
  stageEdit: (cellKey: string, columnId: ColumnId, value: string) => void;
  onOpenSettings?: (apartmentId: string) => void;
  onConfigureManagementFee?: (apartmentId: string) => void;
  onViewExpenses?: (apartmentId: string, bearer: ExpenseBearer, withSST: boolean) => void;
  onViewRecurring?: (apartmentId: string, bearer: RecurringBearer) => void;
  onOpenAttachments?: (apartmentId: string) => void;
  onViewTenantSummary?: (row: GridRow) => void;
  onViewTenantDocuments?: (row: GridRow) => void;
  onViewOwnerReport?: (row: GridRow) => void;
  onDownloadOwnerReport?: (row: GridRow) => void;
  onViewActivity?: (row: GridRow) => void;
  onCellPointerDown?: (cell: SelectionCell, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellPointerEnter?: (cell: SelectionCell) => void;
  onCellPointerUp?: () => void;
  isCellSelected?: (cellKey: string, columnId: ColumnId) => boolean;
  selectionEdges?: (cellKey: string, columnId: ColumnId) => SelectionEdges | undefined;
  cellColour?: (cellKey: string, columnId: ColumnId) => string | undefined;
  isCellActive?: (cellKey: string, columnId: ColumnId) => boolean;
  isCellEditing?: (cellKey: string, columnId: ColumnId) => boolean;
  isCellPendingRebill?: (cellKey: string, columnId: ColumnId) => boolean;
  onCellActivate?: (cellKey: string, columnId: ColumnId, mods: { shift: boolean; ctrl: boolean }) => void;
  onCellContextMenu?: (cell: { cellKey: string; columnId: ColumnId }, e: React.MouseEvent) => void;
  onCellDoubleClick?: (cellKey: string, columnId: ColumnId) => void;
  registerCell?: (cellKey: string, columnId: ColumnId, node: HTMLElement | null) => void;
  // Per-unit Bill selection (see GridTableProps). `selectableForBill` = this row
  // is billable (a checkbox renders); `selectedForBill` = it's checked.
  selectableForBill?: boolean;
  selectedForBill?: boolean;
  onToggleBillSelection?: (apartmentId: string) => void;
  showVacant?: boolean;
  density: "comfortable" | "compact";
}) {
  const [partyPreview, setPartyPreview] = useState<{ id: string; type: "owner" | "tenant"; name: string } | null>(null);
  // R2/R3 (Task 6 re-base): grain-lock is now server-derived via
  // `row.isWholeUnit` (Apartment.listingMode === "WHOLE") — a partitioned
  // apartment nests its readings as tenant-sub-rows; a whole-unit tenancy
  // shows its single reading inline and renders zero nested rows. Replaces
  // the old `subRows.length > 1 || entry.rental == null` heuristic now that
  // entry.rental no longer exists. MUST stay byte-identical to export-xlsx.ts's
  // own `hasNestedSubRows` — a mismatch breaks inline-vs-nested rendering
  // parity between the table and the export.
  const hasNestedSubRows = !row.isWholeUnit;
  const inlineSubRow: GridSubRow | undefined = !hasNestedSubRows ? row.subRows[0] : undefined;
  // Vacant-room fix: a partitioned unit's vacant, dataless rooms are dropped from
  // BOTH the occupancy count and the rendered sub-rows when the page's "show vacant"
  // toggle is off. `showVacant === undefined` (GridTable-only tests that don't wire
  // the toggle) resolves to `true` ⇒ no filtering (byte-parity). Whole units are
  // unaffected — their single reading renders inline, never as a nested room.
  const roomsToRender = visibleSubRows(row.subRows, showVacant ?? true);
  // Task 7 (R2), grammar fix Task 11 — a single occupancy tag on the unit
  // row: "N rooms" (plural) / "1 room" (singular) / "Vacant" (zero rooms,
  // never "0 rooms") for a partitioned apartment, "Whole unit · {tenant}"
  // (or bare "Whole unit" when vacant) for a whole-unit tenancy. Display-only.
  const roomCount = roomsToRender.length;
  const occupancyTag = hasNestedSubRows
    ? roomCount === 0
      ? "Vacant"
      : roomCount === 1
        ? "1 room"
        : `${roomCount} rooms`
    : `Whole unit${inlineSubRow?.partyName ? ` · ${inlineSubRow.partyName}` : ""}`;
  // The row's payment badge. Once the unit-month carries live grid charges, the
  // DERIVED settlement is what shows: the stored `paymentStatus` column is set by hand
  // and is deliberately never advanced by a Bill or a payment, so a tenant who has paid
  // in full still leaves it reading "unpaid" — which is the bug this replaces.
  //
  // `status === "none"` means nothing is billed yet (no live charges), and there the
  // manual column is still the only thing anyone has said about this row, so it is shown
  // unchanged — byte-parity for every un-billed row.
  //
  // "partial" covers BOTH "some of it is paid" and "the tenant paid but the owner has
  // not": the roll-up spans tenant AND owner charges on purpose, so outstanding owner
  // money can never hide behind a green "Paid".
  const settled = row.settlement;
  const isDerived = settled != null && settled.status !== "none";
  const settlementLabel = isDerived
    ? settled.status === "paid"
      ? "Paid"
      : settled.status === "partial"
        ? "Partially paid"
        : "Unpaid"
    : row.paymentStatus;
  const settlementTone = isDerived
    ? (ENTRY_STATUS_TONES[settled.status] ?? "slate")
    : (ENTRY_STATUS_TONES[row.paymentStatus] ?? "slate");
  // Review Minor #5: a billed row's editable inputs are misleading — the page
  // already drops billed edits at the buffer, so the visual must show
  // read-only truthfully. `!= null` catches both null AND undefined, so
  // Task-3 fixtures without `billedAt` are UNAFFECTED (isLocked stays false).
  //
  // The lock predicate now lives in ONE place (row-lock.ts) instead of being
  // hand-copied here, in nav-cells.ts and in bills-grid-page.tsx. It also reads
  // real payment state rather than the manual `paymentStatus` column, so a row
  // with ANY money against it — partial or full — renders read-only, matching
  // the server freeze instead of offering an edit that Save would reject. See
  // row-lock.ts for the full rationale.
  // Cell-grain (R6): partial re-Bill means paying the electricity no longer freezes the
  // WiFi, so the row lock is now coarser than the money it represents. `isCellLocked`
  // starts from the row lock and can only ever UNLOCK a cell whose own bucket is unpaid —
  // it never opens a cell the row lock kept shut.
  const cellLocked = (columnId: ColumnId) => isCellLocked(row, columnId);

  // Re-Bill tag authority: `billRevision > 0` means this live unit-month has
  // actually been re-Billed (superseded + reissued at least once). The FIRST
  // Bill leaves billRevision at 0, so a fresh bill never shows the Re-Bill tag
  // (bug: it used to, keyed on the ambiguous `billedAt != null`, which is set on
  // BOTH the first Bill and a re-Bill). Billed vs Re-Billed are mutually
  // exclusive below — a re-Billed row shows Re-Billed only, never both.
  const hasLiveBill = row.billed ?? row.billedAt != null;
  const needsBill = row.entryId != null && (!hasLiveBill || row.hasUnbilledChanges === true);
  function cellBillingState(cellKey: string, columnId: ColumnId): BillingCellState | undefined {
    return billingStateForCell(row, cellKey, columnId, isCellPendingRebill);
  }

  // ui-task-10e: builds the pointer/selection/colour props for one editable
  // cell (unit-grain, inline subRow, or nested sub-row — all three sites
  // share this). Every field is `undefined` when its corresponding GridTable
  // prop is absent, so EditableCell attaches no listener/marker/colour —
  // parity with Task-3/ui-10b when the page shell doesn't opt in.
  /**
   * The payment state of the live grid charges behind this cell — drives the wash +
   * tick. Folded into the two prop-builders below (rather than passed at each of the
   * ~16 cell call sites) so a newly-added cell cannot silently miss it.
   *
   * A sub-row cell's `cellKey` IS the room's listingId, so the room-grain state is
   * preferred where one exists; unit-grain keys (apartmentId) never appear in `rooms`
   * and fall through to the unit roll-up.
   *
   * "partial" now PAINTS (amber "◐") where it previously rendered as nothing. The old
   * rule — only "paid" marks, because a half-settled line must not read as done — was
   * right that partial ≠ done, but it expressed that by making partial
   * indistinguishable from NOTHING PAID, which is the more misleading of the two. A
   * distinct hue and glyph says "money in, not finished" without ever reading as done.
   */
  function cellSettlement(cellKey: string, columnId: ColumnId): PaintedSettlement | undefined {
    const bucket = settlementBucketForColumn(row, columnId);
    if (!bucket || !row.settlement) return undefined;
    return painted(row.settlement.rooms?.[cellKey]?.[bucket] ?? row.settlement.cells[bucket]);
  }

  function cellDocumentCounts(cellKey: string, columnId: ColumnId): CellDocumentCounts | undefined {
    let invoice = 0;
    let receipt = 0;
    for (const attachment of row.attachments) {
      if (attachment.cellKey !== cellKey || attachment.columnId !== columnId) continue;
      if (attachment.documentKind === "invoice") invoice += 1;
      if (attachment.documentKind === "receipt") receipt += 1;
    }
    return invoice || receipt ? { invoice, receipt } : undefined;
  }

  function editableCellProps(cellKey: string, columnId: ColumnId, rawValue: string) {
    const selCell: SelectionCell = { cellKey, columnId, value: cellNumericValue(rawValue) };
    return {
      settlement: cellSettlement(cellKey, columnId),
      billingState: cellBillingState(cellKey, columnId),
      documentCounts: cellDocumentCounts(cellKey, columnId),
      // Excel-Web V2: resolve the raw pointerdown ONCE, platform-aware. Only a
      // primary-button "select" gesture starts cell selection — a right-click
      // (or macOS Ctrl-click) resolves to "context" and MUST NOT start a
      // left-drag/collapse (the context menu owns it via onContextMenu below);
      // a middle-click resolves to "ignore". `mods.ctrl` is the platform
      // multi-select key (Cmd on macOS, Ctrl elsewhere); Alt is ignored.
      onCellPointerDown: onCellPointerDown
        ? (e: React.PointerEvent<HTMLTableCellElement>) => {
            const g = resolvePointerGesture(e);
            if (g.kind === "select") onCellPointerDown(selCell, g.mods);
          }
        : undefined,
      onCellPointerEnter: onCellPointerEnter ? () => onCellPointerEnter(selCell) : undefined,
      onCellPointerUp,
      selected: isCellSelected?.(cellKey, columnId),
      selectionEdges: selectionEdges?.(cellKey, columnId),
      colour: cellColour?.(cellKey, columnId),
      active: isCellActive?.(cellKey, columnId),
      editing: isCellEditing?.(cellKey, columnId),
      // Task 3 (V2): activate carries the click's modifiers (platform-aware) so a
      // shift/ctrl click extends/toggles the selection instead of collapsing it.
      onActivate: onCellActivate
        ? (e: React.MouseEvent) => onCellActivate(cellKey, columnId, resolveClickMods(e))
        : undefined,
      onContextMenu: onCellContextMenu ? (e: React.MouseEvent) => onCellContextMenu({ cellKey, columnId }, e) : undefined,
      onDoubleClick: canEdit && onCellDoubleClick ? () => onCellDoubleClick(cellKey, columnId) : undefined,
      registerCell: registerCell ? (node: HTMLElement | null) => registerCell(cellKey, columnId, node) : undefined,
    };
  }

  // P4 Task 3 (extended): selection props for the read-only navigable cells
  // (LockedCell / ReadOnlyCell / the raw sub-row rental <td>). Selection is
  // ORTHOGONAL to editing: a read-only price/rental/expense/amount cell can't be
  // EDITED, but it must be SELECTABLE + summable + copyable, so it now carries the
  // SAME pointer-selection wiring as an editable cell (drag start/grow/end +
  // shift/ctrl click). What stays editable-only is EDITING itself — no `<input>`,
  // no `onDoubleClick`→beginEdit, no colour-fill. Money-safe: the sole write
  // consumer of `sel.range`, `onDelete`, no-ops read-only cells (bills-grid-page
  // onDelete step 5). Every field is `undefined` when its GridTable prop is absent
  // ⇒ parity. The selCell carries identities only (no `value`) — the page enriches
  // each committed cell's numeric value from the DOM (readCellDisplayString).
  function readOnlyCellProps(cellKey: string, columnId: ColumnId) {
    const selCell: SelectionCell = { cellKey, columnId };
    return {
      settlement: cellSettlement(cellKey, columnId),
      billingState: cellBillingState(cellKey, columnId),
      documentCounts: cellDocumentCounts(cellKey, columnId),
      // Same platform-aware gesture resolution as editableCellProps: only a
      // primary-button "select" starts a drag; right-click resolves to "context".
      onCellPointerDown: onCellPointerDown
        ? (e: React.PointerEvent<HTMLTableCellElement>) => {
            const g = resolvePointerGesture(e);
            if (g.kind === "select") onCellPointerDown(selCell, g.mods);
          }
        : undefined,
      onCellPointerEnter: onCellPointerEnter ? () => onCellPointerEnter(selCell) : undefined,
      onCellPointerUp,
      active: isCellActive?.(cellKey, columnId),
      // Excel-Web V2: read-only navigable cells paint the same selection tint, so a
      // range that spans them reads as one solid block.
      selected: isCellSelected?.(cellKey, columnId),
      selectionEdges: selectionEdges?.(cellKey, columnId),
      // Task 3 (V2): carry the click's modifiers (platform-aware) up to
      // onCellActivate (same as the editable path) so a shift/ctrl click on a
      // read-only navigable cell extends/toggles the selection.
      onActivate: onCellActivate
        ? (e: React.MouseEvent) => onCellActivate(cellKey, columnId, resolveClickMods(e))
        : undefined,
      onContextMenu: onCellContextMenu ? (e: React.MouseEvent) => onCellContextMenu({ cellKey, columnId }, e) : undefined,
      registerCell: registerCell ? (node: HTMLElement | null) => registerCell(cellKey, columnId, node) : undefined,
    };
  }

  const unitIdentity = formatUnitIdentity(row.propertyCode, row.unitCode);
  const unitIdentityTitle = `${row.propertyName} · ${unitIdentity}`;

  return (
    <Fragment>
      <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">
        <td
          data-column-id="unitCode"
          className={cn("sticky left-0 z-10 select-text border-r-2 border-r-[var(--navy)] bg-[var(--page-bg)] px-4 text-[18px] text-[var(--text-primary)] align-top selection:bg-[var(--primary)]/25", density === "compact" ? "py-1.5" : "py-3")}
        >
          {/* The primary row is a fixed two-track grid: identity + payment
              status on the left, actions on the right. Every unit therefore
              follows the first-row pattern even when names are long or the
              browser is zoomed. Secondary billing warnings use row two. */}
          <div
            data-testid="unit-primary-row"
            data-autofit-content="true"
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5"
          >
          {/* Identity line — the primary scan target. The unit code must read
              on ONE line: `whitespace-nowrap` stops the browser breaking a
              hyphenated code (e.g. "A-08-02") at each "-", and `shrink-0` stops
              it being squeezed when the sticky column is tight. Status pill sits
              beside it; row actions occupy the fixed right track. */}
          <div data-testid="unit-identity-line" data-autofit-content="true" className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-[var(--navy)]">
            {/* Per-unit Bill selection — only billable rows (saved, not yet
                billed) render a checkbox. Billing a checked unit issues ALL its
                tenants' invoices + the owner invoice in one backend op. */}
            {onToggleBillSelection && selectableForBill && (
              <Checkbox
                aria-label={`Select ${row.unitCode}`}
                data-testid={`bill-select-${row.apartmentId}`}
                checked={!!selectedForBill}
                onCheckedChange={() => onToggleBillSelection(row.apartmentId)}
                className="shrink-0"
              />
            )}
            {onOpenSettings ? (
              <button
                type="button"
                data-testid="unit-code-btn"
                aria-label={`Settings for ${row.unitCode}`}
                onClick={() => { if (!hasNativeTextSelection()) onOpenSettings(row.apartmentId); }}
                title={unitIdentityTitle}
                className="min-w-0 select-text truncate whitespace-nowrap rounded font-semibold underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {unitIdentity}
              </button>
            ) : (
              <span className="min-w-0 select-text truncate whitespace-nowrap font-semibold" title={unitIdentityTitle}>
                {unitIdentity}
              </span>
            )}
            <StatusPill tone={settlementTone} testId="entry-payment-pill">
              {settlementLabel}
            </StatusPill>
          </div>
          {/* `contents` lets both children participate in the parent grid. The
              action rail is locked to row one; optional warning badges remain
              on row two and can never push the icons over Owner/Tenant details. */}
          <div
            data-testid="unit-status-actions-row"
            className="contents"
          >
            <span className={cn(
              "col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-2",
              density === "compact" ? "mt-0.5" : "mt-2",
            )}>
              {needsBill && (
                <Badge variant="amber" data-testid="needs-bill-badge">
                  {hasLiveBill ? "Needs Re-Bill" : "Needs Bill"}
                </Badge>
              )}
              {/* R13 — money settled against a proforma line whose tax invoice never got
                  minted. The MONEY IS CORRECT; only the document is missing, which is why
                  this reads "Invoice pending" rather than anything alarming about payment.
                  Repairable via POST /bills-grid/entries/:entryId/graduate-retry. Without
                  this chip the repair path exists but nobody can find it. */}
              {row.graduationPending && (
                <Badge variant="amber" data-testid="graduation-pending-badge">Invoice pending</Badge>
              )}
            </span>
            <span
              data-testid="unit-action-cluster"
              className={cn(
                "col-start-2 row-start-1 grid shrink-0 grid-cols-4 gap-0.5 rounded-lg border border-[var(--border)]/70 bg-[var(--page-bg)]/95 p-0.5 shadow-sm",
                density === "compact" && "[&_button]:h-7 [&_button]:w-7",
              )}
            >
              {onViewTenantDocuments && row.subRows.some((sub) => sub.partyId) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`View invoices and receipts for ${row.unitCode}`}
                  title="Tenant invoices & receipts"
                  data-testid="tenant-documents-btn"
                  onClick={(e) => { e.stopPropagation(); onViewTenantDocuments(row); }}
                  className="text-[var(--navy)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]"
                >
                  <ReceiptText className="h-4 w-4" />
                </Button>
              )}
              {onViewTenantSummary && row.subRows.some((sub) => sub.partyId) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`View tenant bill summary for ${row.unitCode}`}
                  title="View what the tenant sees"
                  data-testid="tenant-bill-summary-btn"
                  onClick={(e) => { e.stopPropagation(); onViewTenantSummary(row); }}
                  className="text-[var(--navy)] hover:text-[var(--gold)]"
                >
                  <Eye className="h-4 w-4" />
                </Button>
              )}
              {row.warnings.length > 0 && (
                <span className="text-xs text-amber-600" title={row.warnings.map((w) => w.code).join(", ")}>
                  ⚠
                </span>
              )}
              {(row.previewError?.code === "AIRCON_EXCEEDS_TNB" || row.previewError?.code === "TNB_UNDERSHOOT") && (
                <span
                  className="text-xs text-red-600"
                  title={
                    row.previewError?.code === "AIRCON_EXCEEDS_TNB"
                      ? "Whole unit: aircond is part of the TNB bill, so it can't be higher than the TNB total. Lower the aircond reading (Current kWh) or raise the TNB total. This amount is auto-calculated and can't be edited."
                      : "The TNB total is just below the aircond total. Raise the TNB total to at least the aircond amount, or lower the aircond reading (Current kWh). This amount is auto-calculated and can't be edited."
                  }
                >
                  ⚠
                </span>
              )}
              {onOpenAttachments && (
                <span className="relative inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    // Names the SCOPE, not just the noun: this opens the unit-level
                    // (owner-only) panel, never the per-line tenant-visible one.
                    aria-label={`Owner unit bills for ${row.unitCode}`}
                    title="Unit bills (owner) — never shown to a tenant"
                    data-testid="attachments-btn"
                    onClick={(e) => { e.stopPropagation(); onOpenAttachments(row.apartmentId); }}
                    className="text-[var(--navy)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <CountBadge count={row.attachments.length} testId="attachment-badge" />
                </span>
              )}
              <AuditIcon
                name={row.entry?.lastEditedByName ?? null}
                at={row.entry?.updatedAt ?? null}
                unitCode={row.unitCode}
                onClick={onViewActivity ? () => onViewActivity(row) : undefined}
              />
            </span>
          </div>
          </div>
          {/* Context lines — occupancy/tenant then the parent property/condo
              name (Item 5: identifies which building a unit belongs to, critical
              under the "All" filter where condos interleave). Both `truncate`
              inside a shared `max-w-*` cap so a long tenant name can't drag the
              sticky column wider (which is what was crushing the code above).
              The occupancy element keeps its exact text — tests assert its
              textContent verbatim ("Whole unit · {name}" / "3 rooms"). */}
          <div className={cn("max-w-[24rem] text-[18px] leading-tight", density === "compact" ? "mt-0 space-y-0" : "mt-1 space-y-0.5")}>
            {/* Whole-unit tenant name lives in this tag ("Whole unit · {name}"). It used to
                `truncate` and got clipped by the narrow unit column — now it WRAPS within the
                capped width so the full tenant name shows without dragging the column wider.
                textContent is unchanged, so the verbatim-tag tests still hold. */}
            {row.isWholeUnit ? (
              <div
                data-testid="unit-occupancy-tag"
                data-autofit-content="true"
                className="whitespace-normal break-words text-[18px] font-semibold leading-tight text-[var(--navy)]"
                title={`Whole unit: ${row.ownerName ?? "—"}`}
              >
                <span className="text-[18px] font-semibold leading-tight text-[var(--navy)]">Whole unit: </span>
                {row.ownerPartyId ? (
                  <button
                    type="button"
                    className="select-text text-[18px] font-semibold leading-tight text-[var(--navy)] underline decoration-[var(--gold)] decoration-2 underline-offset-4 hover:text-[var(--gold)]"
                    onClick={(event) => { event.stopPropagation(); if (!hasNativeTextSelection()) setPartyPreview({ id: row.ownerPartyId!, type: "owner", name: row.ownerName ?? "Owner" }); }}
                  >{row.ownerName ?? "—"}</button>
                ) : <span className="text-[18px] font-semibold leading-tight text-[var(--navy)]">{row.ownerName ?? "—"}</span>}
              </div>
            ) : (
              <div
                data-testid="unit-occupancy-tag"
                data-autofit-content="true"
                className="whitespace-normal break-words text-[18px] text-[var(--navy)]"
                title={occupancyTag}
              >
                {occupancyTag}
              </div>
            )}
            {row.isWholeUnit && inlineSubRow?.partyName && (
              <div data-testid="whole-unit-tenant" data-autofit-content="true" className="flex min-w-0 flex-nowrap items-center gap-x-1.5 whitespace-nowrap text-[18px] font-semibold leading-tight text-[var(--navy)]">
                <span className="inline-flex min-w-0 items-center whitespace-nowrap">
                  <span className="text-[18px] font-semibold leading-tight text-[var(--navy)]">Tenant: </span>
                  {inlineSubRow.partyId ? (
                    <button
                      type="button"
                      className="select-text text-[18px] font-semibold leading-tight text-[var(--navy)] underline decoration-[var(--gold)] decoration-2 underline-offset-4 hover:text-[var(--gold)]"
                      onClick={(event) => { event.stopPropagation(); if (!hasNativeTextSelection()) setPartyPreview({ id: inlineSubRow.partyId!, type: "tenant", name: inlineSubRow.partyName ?? "Tenant" }); }}
                    >{inlineSubRow.partyName}</button>
                  ) : <span className="text-[18px] font-semibold leading-tight text-[var(--navy)]">{inlineSubRow.partyName}</span>}
                </span>
                <TenancyEndControl row={row} subRow={inlineSubRow} />
              </div>
            )}
            {!row.isWholeUnit && row.ownerName && (
              <div
                data-testid="owner-line"
                data-autofit-content="true"
                className="truncate text-[18px] text-[var(--navy)]"
                title={`Owner: ${row.ownerName}`}
              >
                <span className="font-medium text-[var(--navy)]">Owner: </span>
                {row.ownerPartyId ? (
                  <button
                    type="button"
                    className="select-text font-semibold text-[var(--navy)] underline decoration-[var(--gold)] decoration-2 underline-offset-4 hover:text-[var(--gold)]"
                    onClick={(event) => { event.stopPropagation(); if (!hasNativeTextSelection()) setPartyPreview({ id: row.ownerPartyId!, type: "owner", name: row.ownerName ?? "Owner" }); }}
                  >{row.ownerName}</button>
                ) : <span className="font-medium text-[var(--navy)]">{row.ownerName}</span>}
              </div>
            )}
          </div>
        </td>
        {dataColumns.map((col) => {
          if (col.grain === "subRow") {
            // A whole-unit tenancy is billed through the unit-level TNB
            // Owner/Tenant cells. It does not use Previous/Current meter
            // readings, and therefore has no meter-derived Amount either.
            // Keep any legacy saved readings untouched in the database, but
            // make all three cells visibly non-applicable and non-editable.
            if (row.isWholeUnit) {
              return <LockedCell key={col.id} columnId={col.id} display="—" numeric={col.numeric} />;
            }
            // Grain lock (R3): rendered on the unit row ONLY when there are
            // no nested sub-rows to show the reading in — otherwise this cell
            // is a hard lock (the real value lives in the nested rows below).
            if (hasNestedSubRows) {
              return <LockedCell key={col.id} columnId={col.id} display="—" numeric={col.numeric} />;
            }
            const cellKey = inlineSubRow?.listingId ?? row.apartmentId;
            const seed = inlineSubRow?.[col.id as "previousKwh" | "currentKwh" | "amount"] ?? "";
            if (!inlineSubRow) return <LockedCell key={col.id} columnId={col.id} display="—" numeric={col.numeric} />;
            const inlineValue = stagedOrSeed(cellKey, col.id, seed);
            // Task 6: Amount is read-only everywhere — the inline (whole-unit)
            // case live-previews from the SAME staged/seeded Current/Previous
            // this cellKey/row resolves to, so the preview tracks in-progress
            // edits before Save.
            if (col.id === "amount") {
              const prev = stagedOrSeed(cellKey, "previousKwh", inlineSubRow.previousKwh ?? "");
              const cur = stagedOrSeed(cellKey, "currentKwh", inlineSubRow.currentKwh ?? "");
              // Final-review Finding 1: an unedited saved reading shows the
              // STORED snapshot amount (matches the server-computed totals
              // derived from it), NOT a re-computation at the CURRENT rate —
              // the live preview only kicks in once the admin actually
              // stages an edit to THIS row's previousKwh/currentKwh.
              const hasStagedEdit = isStaged(cellKey, "previousKwh") || isStaged(cellKey, "currentKwh");
              const display = hasStagedEdit ? amountPreview(inlineSubRow, prev, cur) : (inlineSubRow.amount ?? "—");
              return (
                <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} {...readOnlyCellProps(cellKey, col.id)} />
              );
            }
            if (cellLocked(col.id)) {
              return <LockedCell key={col.id} columnId={col.id} display={inlineValue} numeric={col.numeric} {...readOnlyCellProps(cellKey, col.id)} />;
            }
            return (
              <EditableCell
                key={col.id}
                columnId={col.id}
                value={inlineValue}
                onChange={(value) => stageEdit(cellKey, col.id, value)}
                numeric={col.numeric}
                {...editableCellProps(cellKey, col.id, inlineValue)}
              />
            );
          }
          if (!col.editable) {
            if (col.id === "ownerPayout") {
              const payout = projectedOwnerPayout(row);
              return (
                <ReadOnlyCell
                  key={col.id}
                  columnId={col.id}
                  display={payout.toFixed(2)}
                  numeric
                  onView={onViewOwnerReport && row.ownerPartyId ? () => onViewOwnerReport(row) : undefined}
                  viewLabel={`View owner monthly report for ${row.unitCode}`}
                  viewTestId="owner-report-btn"
                  viewKind="report"
                  onSecondary={onDownloadOwnerReport && row.ownerPartyId ? () => onDownloadOwnerReport(row) : undefined}
                  ownerReportStatus={row.ownerPartyId ? (row.ownerPayoutStatus ?? "draft") : undefined}
                  warningText={Number(row.ownerTopUpRequired ?? 0) > 0 ? `Top-up RM ${Number(row.ownerTopUpRequired).toFixed(2)}` : undefined}
                  {...readOnlyCellProps(row.apartmentId, col.id)}
                />
              );
            }
            // Recurring-charges (R6 refined; Maintenance joined 2026-08-06): a governable scalar
            // cell is read-only ONLY when an ENABLED recurring def governs it (settings-controlled).
            // When the server explicitly says NOT governed (=== false) — no def, disabled def, or a
            // pre-effective month — the cell is an EDITABLE per-month value again (applicability- +
            // billed-lock-gated), exactly like the legacy grid. Lock + generated amount come from
            // row-lock.ts's shared predicates so keyboard nav can never disagree with the render.
            if (col.id === "cleaningOwner" || col.id === "cleaningTenant" || col.id === "wifiOwner" || col.id === "wifiTenant" || col.id === "maintenanceFee") {
              const applicable = isApplicable(row, col.id);
              const recurringLocked = scalarSettingsLock(row, col.id);
              // Maintenance Fee is the other single-column band, so it is marked here as
              // well as TNB below. Cleaning/WiFi never qualify — showsTenantBorneMark
              // returns false for them, since their amount already moves column.
              const scalarTenantBorne = showsTenantBorneMark(row, col.id);
              if (recurringLocked === false && applicable && !cellLocked(col.id)) {
                const seed = seedValue(row, col.id);
                const unitValue = stagedOrSeed(row.apartmentId, col.id, seed);
                return (
                  <EditableCell
                    key={col.id}
                    columnId={col.id}
                    value={unitValue}
                    onChange={(value) => stageEdit(row.apartmentId, col.id, value)}
                    numeric={col.numeric}
                    tenantBorne={scalarTenantBorne}
                    {...editableCellProps(row.apartmentId, col.id, unitValue)}
                  />
                );
              }
              // Read-only (governed) display: the entry's frozen scalar if present, else the
              // GENERATED amount from the recurring def — so a governed cell shows e.g. 100 even
              // for an unopened month whose entry hasn't been created yet (fixes "– instead of 100").
              const v = seedValue(row, col.id);
              const generated = scalarGeneratedAmount(row, col.id);
              // Governed cell: the GENERATED def amount is authoritative (settings-controlled) and
              // wins over the entry scalar / config seed — so an unopened month shows e.g. 100, and
              // a stale/absent scalar never renders "–". Falls back to the seed only when there is
              // no generated amount (ungoverned-but-undefined-flag fixtures).
              const shown = generated || v || "";
              const display = applicable && shown ? shown : "—";
              return <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} tenantBorne={scalarTenantBorne} {...readOnlyCellProps(row.apartmentId, col.id)} />;
            }
            // Recurring-charges (R9): CUSTOM recurring totals — read-only, count badge, open the
            // read-only itemised dialog (with an "Edit in Unit Settings" action).
            if (col.id === "ownerRecurring" || col.id === "tenantRecurring") {
              const recBearer = col.id === "ownerRecurring" ? "owner" : "tenant";
              return (
                <ReadOnlyCell
                  key={col.id}
                  columnId={col.id}
                  display={readOnlyValue(row, col.id)}
                  numeric={col.numeric}
                  onView={onViewRecurring ? () => onViewRecurring(row.apartmentId, recBearer) : undefined}
                  viewLabel={recBearer === "tenant" ? "View tenant recurring charges" : "View owner recurring charges"}
                  viewTestId={recBearer === "tenant" ? "view-recurring-tenant" : "view-recurring-owner"}
                  viewKind="recurring"
                  badgeCount={recBearer === "tenant" ? (row.recurring?.tenant.count ?? 0) : (row.recurring?.owner.count ?? 0)}
                  {...readOnlyCellProps(row.apartmentId, col.id)}
                />
              );
            }
            const isExpense = ["tenantExpNonSst", "tenantExpWithSst", "ownerExpNonSst", "ownerExpWithSst"].includes(col.id);
            const managementFeeNeedsSetup = col.id === "managementFeeSst" && row.managementFee?.configured === false;
            const expenseWithSst = col.id === "tenantExpWithSst" || col.id === "ownerExpWithSst";
            const bearer: ExpenseBearer = col.id.startsWith("tenantExp") ? "tenant" : "owner";
            // Task 6: Rental is read-only, sourced from the whole-unit
            // tenancy's own sub-row (rental moved off `entry` onto
            // `SubRow.rental`, Task 5) — "—" when unset, mirroring every
            // other LockedCell's empty-value convention.
            if (col.id === "rental" || col.id === "deposit") {
              const display = col.id === "rental"
                ? (row.subRows[0]?.rental ?? "—")
                : (row.subRows[0]?.deposit ?? "—");
              return (
                <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} {...readOnlyCellProps(row.apartmentId, col.id)} />
              );
            }
            return (
              <ReadOnlyCell
                key={col.id}
                columnId={col.id}
                display={readOnlyValue(row, col.id)}
                numeric={col.numeric}
                onView={
                  isExpense && onViewExpenses
                    ? () => onViewExpenses(row.apartmentId, bearer, expenseWithSst)
                    : managementFeeNeedsSetup && onConfigureManagementFee
                      ? () => onConfigureManagementFee(row.apartmentId)
                      : undefined
                }
                viewLabel={managementFeeNeedsSetup ? "Configure management fee" : `${expenseWithSst ? "Add With SST" : "Add Non SST"} ${bearer} expense`}
                viewTestId={managementFeeNeedsSetup ? "configure-management-fee" : bearer === "tenant" ? "view-expenses-tenant" : "view-expenses-owner"}
                viewKind={isExpense ? "expense" : managementFeeNeedsSetup ? "configure" : "view"}
                badgeCount={(() => {
                  if (!isExpense) return 0;
                  const counts = bearer === "tenant" ? row.expenses.tenant : row.expenses.owner;
                  return expenseWithSst
                    ? (counts.withSstCount ?? counts.count)
                    : (counts.nonSstCount ?? Math.max(0, counts.count - (counts.withSstCount ?? 0)));
                })()}
                costActionRequired={(() => {
                  if (!isExpense) return false;
                  const counts = bearer === "tenant" ? row.expenses.tenant : row.expenses.owner;
                  return (expenseWithSst ? (counts.withSstActionRequiredCount ?? 0) : (counts.nonSstActionRequiredCount ?? 0)) > 0;
                })()}
                costMargin={(() => {
                  if (!isExpense) return null;
                  const counts = bearer === "tenant" ? row.expenses.tenant : row.expenses.owner;
                  const raw = expenseWithSst ? counts.withSstGrossMargin : counts.nonSstGrossMargin;
                  if (raw == null) return null;
                  const margin = Number(raw);
                  return Number.isFinite(margin) ? margin : null;
                })()}
                warningText={
                  col.id === "managementFeeSst"
                    ? row.managementFee?.reason
                      ?? (row.managementFee?.configured === false ? "Not configured" : undefined)
                    : undefined
                }
                managementFeeReady={
                  col.id === "managementFeeSst"
                  && (row.managementFee?.status === "chargeable" || row.managementFee?.status === "posted")
                }
                {...readOnlyCellProps(row.apartmentId, col.id)}
              />
            );
          }
          if (col.id !== "unitCode" && !isApplicable(row, col.id)) {
            // Still marked. The one inapplicable case a single-column band has is TNB under
            // "tenant pays directly" — where the tenant unambiguously bears the cost — so
            // dropping the mark here left a bare "—" in precisely the situation the mark
            // exists to explain. It now reads "nothing to enter, the tenant handles it".
            return (
              <LockedCell
                key={col.id}
                columnId={col.id}
                display="—"
                numeric={col.numeric}
                tenantBorne={showsTenantBorneMark(row, col.id)}
              />
            );
          }
          const seed = seedValue(row, col.id);
          const unitValue = stagedOrSeed(row.apartmentId, col.id, seed);
          // Maintenance remains the only single money column that may need a
          // tenant-borne corner mark. TNB now moves between explicit Owner/Tenant columns.
          const tenantBorne = showsTenantBorneMark(row, col.id);
          if (cellLocked(col.id)) {
            return <LockedCell key={col.id} columnId={col.id} display={unitValue} numeric={col.numeric} tenantBorne={tenantBorne} {...readOnlyCellProps(row.apartmentId, col.id)} />;
          }
          return (
            <EditableCell
              key={col.id}
              columnId={col.id}
              value={unitValue}
              onChange={(value) => stageEdit(row.apartmentId, col.id, value)}
              numeric={col.numeric}
              tenantBorne={tenantBorne}
              {...editableCellProps(row.apartmentId, col.id, unitValue)}
            />
          );
        })}
      </tr>

      {hasNestedSubRows &&
        roomsToRender.map((subRow) => (
          <tr
            key={subRow.listingId}
            data-testid="tenant-sub-row"
            data-listing-id={subRow.listingId}
            className="border-b border-[var(--border)] bg-background/30 transition hover:bg-[var(--page-bg)]"
          >
            <td data-column-id="unitCode" className="sticky left-0 z-10 border-r-2 border-r-[var(--navy)] bg-background px-4 py-2 pl-8 text-xs italic text-[var(--navy)]">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5">
                  ↳ {subRow.partyId && subRow.partyName ? (
                    <button
                      type="button"
                      className="not-italic font-semibold text-[var(--navy)] underline decoration-[var(--gold)] decoration-2 underline-offset-4 hover:text-[var(--gold)]"
                      onClick={(event) => { event.stopPropagation(); setPartyPreview({ id: subRow.partyId!, type: "tenant", name: subRow.partyName ?? "Tenant" }); }}
                    >{subRow.partyName}</button>
                  ) : (subRow.partyName ?? "Vacant")}
                  <AuditIcon name={subRow.lastEditedByName ?? null} at={subRow.updatedAt ?? null} unitCode={row.unitCode} />
                </span>
                <TenancyEndControl row={row} subRow={subRow} />
              </span>
            </td>
            {dataColumns.map((col) => {
              if (col.grain !== "subRow") {
                // Off-grain (unit-grain) cell on a tenant sub-row: greyed and
                // non-editable, same as the reciprocal LockedCell (R3). Task 6
                // exception: `rental` now shows THIS room's own value
                // (SubRow.rental) instead of staying blank — per-room rental
                // display on a partitioned apartment's nested rows.
                //
                // P4 Task 3 (site c, reviewer catch): the per-room `rental`
                // cell is a RAW <td> (not a LockedCell/ReadOnlyCell component),
                // so the active-cell wiring is applied inline here — but ONLY
                // for `rental` (the sole navigable off-grain cell, per the Task
                // 1 enumerator); every other off-grain cell renders null and
                // stays byte-identical to before (parity). Keyed on the
                // sub-row's listingId.
                const isNavTenantCharge = col.id === "rental" || col.id === "deposit";
                const tenantChargeNav = isNavTenantCharge ? readOnlyCellProps(subRow.listingId, col.id) : undefined;
                const tenantChargeDisplay = col.id === "rental"
                  ? (subRow.rental ?? "—")
                  : col.id === "deposit"
                    ? (subRow.deposit ?? "—")
                    : null;
                return (
                  <td
                    key={col.id}
                    ref={tenantChargeNav?.registerCell}
                    className={cn(
                      "px-2 py-2 align-middle text-[18px] text-muted-foreground",
                      categoryDividerClass(col.id),
                      col.numeric && "text-center",
                      // V2: selection tint (matches every other navigable cell)
                      // so a range spanning this per-room rental cell reads solid.
                      tenantChargeNav?.selected && "relative",
                      // P4 Task 4: visible SOLID --primary active ring
                      // (non-inset), matching every other navigable cell.
                      tenantChargeNav?.active && !tenantChargeNav?.selected && "ring-2 ring-[var(--primary)]",
                    )}
                    data-testid={`cell-${col.id}`}
                    data-active={tenantChargeNav?.active ? "true" : undefined}
                    data-selected={tenantChargeNav?.selected ? "true" : undefined}
                    data-copy-value={isNavTenantCharge ? (tenantChargeDisplay ?? "") : undefined}
                    data-billing-state={tenantChargeDisplay && hasBillableDisplay(tenantChargeDisplay) ? tenantChargeNav?.billingState : undefined}
                    style={Object.assign(
                      {},
                      tenantChargeDisplay ? billingStateStyle(tenantChargeNav?.billingState, tenantChargeDisplay) : undefined,
                      selectionOutlineStyle(tenantChargeNav?.selectionEdges),
                    )}
                    aria-readonly="true"
                    tabIndex={isNavTenantCharge && tenantChargeNav?.registerCell ? -1 : undefined}
                    onPointerDown={tenantChargeNav?.onCellPointerDown}
                    onPointerEnter={tenantChargeNav?.onCellPointerEnter}
                    onPointerUp={tenantChargeNav?.onCellPointerUp}
                    onClick={tenantChargeNav?.onActivate}
                    onContextMenu={tenantChargeNav?.onContextMenu}
                  >
                    {tenantChargeDisplay}
                    <SelectionFillHandle edges={tenantChargeNav?.selectionEdges} />
                  </td>
                );
              }
              const seed = subRow[col.id as "previousKwh" | "currentKwh" | "amount"] ?? "";
              const subRowValue = stagedOrSeed(subRow.listingId, col.id, seed);
              // Task 6: Amount is read-only everywhere — nested-row case
              // live-previews from THIS sub-row's own staged/seeded
              // Current/Previous.
              if (col.id === "amount") {
                const prev = stagedOrSeed(subRow.listingId, "previousKwh", subRow.previousKwh ?? "");
                const cur = stagedOrSeed(subRow.listingId, "currentKwh", subRow.currentKwh ?? "");
                // Final-review Finding 1: see identical comment at the inline
                // call site above — stored snapshot unless THIS sub-row has a
                // staged previousKwh/currentKwh edit.
                const hasStagedEdit = isStaged(subRow.listingId, "previousKwh") || isStaged(subRow.listingId, "currentKwh");
                const display = hasStagedEdit ? amountPreview(subRow, prev, cur) : (subRow.amount ?? "—");
                return (
                  <LockedCell key={col.id} columnId={col.id} display={display} numeric={col.numeric} {...readOnlyCellProps(subRow.listingId, col.id)} />
                );
              }
              if (cellLocked(col.id)) {
                return <LockedCell key={col.id} columnId={col.id} display={subRowValue} numeric={col.numeric} {...readOnlyCellProps(subRow.listingId, col.id)} />;
              }
              return (
                <EditableCell
                  key={col.id}
                  columnId={col.id}
                  value={subRowValue}
                  onChange={(value) => stageEdit(subRow.listingId, col.id, value)}
                  numeric={col.numeric}
                  {...editableCellProps(subRow.listingId, col.id, subRowValue)}
                />
              );
            })}
          </tr>
        ))}

      {row.priorMonths.map((prior) => (
        <tr
          key={`${row.apartmentId}-prior-${prior.period}`}
          data-testid="prior-month-strip"
          className="border-b border-[var(--border)] text-xs text-muted-foreground"
        >
          <td className="sticky left-0 z-10 border-r-2 border-r-[var(--navy)] bg-[var(--page-bg)] px-4 py-1.5">{prior.period}</td>
          <td className="border-x-2 border-x-[var(--navy)] px-2 py-1.5 text-center">—</td>
          <td colSpan={2} className="border-x-2 border-x-[var(--navy)] px-2 py-1.5" data-testid="prior-cleaning">
            {prior.cleaning ?? "—"}
          </td>
          <td colSpan={5} className="border-x-2 border-x-[var(--navy)] px-2 py-1.5" data-testid="prior-tnb">
            {prior.tnb ?? "—"}
          </td>
          <td colSpan={2} className="border-x-2 border-x-[var(--navy)] px-2 py-1.5" data-testid="prior-air">
            {prior.air ?? "—"}
          </td>
          <td colSpan={2} className="border-x-2 border-x-[var(--navy)] px-2 py-1.5" data-testid="prior-wifi">
            {prior.wifi ?? "—"}
          </td>
          <td colSpan={7} className="border-x-2 border-x-[var(--navy)] px-2 py-1.5" data-testid="prior-others">
            {prior.others}
          </td>
        </tr>
      ))}

      <Dialog open={partyPreview != null} onOpenChange={(open) => { if (!open) setPartyPreview(null); }} lockProgress={false}>
        <DialogContent className="max-w-4xl p-0">
          <DialogHeader className="border-b border-[var(--border)] px-6 py-5">
            <DialogTitle className="text-[22px]">
              {partyPreview?.type === "owner" ? "Owner details" : "Tenant details"} · {partyPreview?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto px-6 py-5 text-[16px]">
            {partyPreview?.type === "owner" && <OwnerDetailPanel partyId={partyPreview.id} />}
            {partyPreview?.type === "tenant" && <TenantDetailPanel partyId={partyPreview.id} />}
          </div>
          <DialogFooter className="border-t border-[var(--border)] px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setPartyPreview(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Fragment>
  );
}
