// Tenant & Owner Billing — the admin screen (UI Task 10). Integration
// keystone: wires fetchGrid/saveEntry/saveReadings/billRows (ui-1) +
// GridTable/CURRENT_COLUMNS (ui-3) + useGridKeyboard (ui-4) +
// useStagedEdits/GridErrorBoundary (ui-9) + exportGridToXlsx (ui-8) behind one
// toolbar (grid-toolbar.tsx), plus (ui-10c) the three per-apartment surfaces
// below.
//
// NAMING AMENDMENT (binding, user decision): the page title is "Tenant &
// Owner Billing" — NOT "Bills & Expenses".
//
// Scoping note: GridTable (Task 3, frozen — not touched by this task) exposes
// no row-selection affordance (no checkboxes, no wired drag-select/pointer
// events on cells), so Bulk-Bill's target set is every VISIBLE, billable row
// (has a saved entry, not already billed-AND-fully-paid — Task 7, R7) rather
// than a drag-selected subset — there is currently no selection UI to narrow
// it further. Money-critical row-locking (never mutate a row whose money has
// started settling) is instead enforced through `isRowLocked` (row-lock.ts),
// both in the cell-edit guard and the Save translator, independent of the
// (unwired) useGridSelection hook. Billed ALONE does not lock — a
// billed-but-unpaid row is still amendable/re-Billable (spec R7) — but any
// payment against the row does, matching the server's own freeze. This FE gate
// stays advisory: the backend paid-freeze remains authoritative.
//
// <SettingDrawer>/<ExpensesDialog>/<AttachmentsPanel> (R11/R27/attachments,
// ui-5/6/7 — frozen, not modified here): ui-10b added GridTable's
// onOpenSettings/onViewExpenses/onOpenAttachments trigger props (the settings
// gear, the expense eye per bearer, the paperclip); this task (ui-10c) wires
// them to the three surfaces below. SCALE-SAFE: exactly ONE surface mounts at
// a time, on demand, each inside its own controlled Sheet — never inline per
// row/cell (165 units × 2 bearers would otherwise fire ~330
// listExpenses/listAttachments queries on load).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Receipt, X } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { loadCellColours, saveCellColours, loadPref, savePref, type CellColourMap } from "@/lib/view-prefs";
import {
  fetchGrid,
  fetchBillingFundsSummary,
  saveEntry,
  saveReadings,
  billRows,
  GRID_QUERY_KEY_ROOT as QUERY_KEY_ROOT,
  type GridRow,
  type GridSubRow,
  type SaveEntryInput,
  type SaveReadingInput,
  type BillRowResult,
  type BillingFundsSummary,
  type GridBillingCapabilities,
} from "@/api/bills-grid";
import { GridTable, rowHasBillingState, type CellEditHandler, type ExpenseBearer, type RecurringBearer, type SelectionEdges } from "./grid-table";
import { billFailureReason, saveFailureReason } from "./bill-failure-reason";
import { GridErrorBoundary } from "./grid-error-boundary";
import { GridToolbar, type BillingColourFilter, type OwnerPayoutFilter, type GridDisplayMode } from "./grid-toolbar";
import { CURRENT_COLUMNS, type ColumnId } from "./columns";
import { useStagedEdits } from "./use-staged-edits";
import { useGridKeyboard } from "./use-grid-keyboard";
import { useGridSelection, type SelectionCell } from "./use-grid-selection";
import { useGridNav, type CellRef } from "./use-grid-nav";
import { useMultiSelection } from "./use-multi-selection";
import { applyFilters, type ColumnFilters, type DateRange } from "./use-column-filter";
import { visibleUnits } from "./occupancy";
import { exportGridToXlsx } from "./export-xlsx";
import { exportGridPdf, exportPayoutReportsZip, exportPayoutSummaryXlsx } from "./export-options";
import type { GridExportKind } from "./grid-toolbar";
import { SettingDrawer } from "./setting-drawer";
import { ExpensesDialog } from "./expenses-dialog";
import { RecurringDialog } from "./recurring-dialog";
import { AttachmentsPanel } from "./attachments-panel";
import { TenantBillSummaryDialog } from "./tenant-bill-summary-dialog";
import { ActivityLogDrawer } from "./activity-log-drawer";
import { OwnerReportDialog } from "./owner-report-dialog";
import { UnitDocumentsDialog } from "./unit-documents-dialog";
import { BillingSummaryTable } from "./billing-summary-table";
import { BillingSummaryNotes } from "./billing-summary-notes";
import { summarizeStagedByUnit, type SaveSkipReason, type UnitEditSummary } from "./staged-summary";
import { GridContextMenu } from "./grid-context-menu";
import { CellDocumentsDialog, type CellDocumentKind, type CellDocumentTarget } from "./cell-documents-dialog";
import { isCellLocked, isRowLocked } from "./row-lock";
import { isApplicable } from "./cell-applicability";
import { planRectangularCopy, matrixToTsv, countCells } from "./grid-copy";
import { findUnbillableAmounts, type UnbillableRow } from "./unbillable-amounts";
import {
  downloadLiveStatementPdf,
  useAllStatementsForMonth,
  useFeeConfigs,
} from "@/api/owner-billing";
import { getBankReconciliationSummary } from "@/api/bank-reconciliation";
import { usePermission } from "@/components/permission-gate";
import { FeeConfigDrawer } from "@/pages/settings/sections/owner-billing/fee-config-drawer";
import { BillConfirmDetails } from "./bill-confirm-details";

// namespace for view-prefs' localStorage keys (colours + hidden columns) —
// see use-grid-selection.ts's own `NS` constant, must match.
const VIEW_PREFS_NS = "bills-grid";

function rm(value: string): string {
  const amount = Number(value);
  return `RM ${Number.isFinite(amount) ? amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}`;
}

function FundsSummaryPanel({ data, onFillExpense, canViewCosts }: { data?: BillingFundsSummary; onFillExpense: (item: BillingFundsSummary["tenantExpenseActionItems"][number]) => void; canViewCosts: boolean }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  if (!data) return (
    <div className="flex h-16 w-44 items-center justify-center rounded-xl border border-amber-400 bg-amber-50 px-4 text-center text-sm font-semibold text-amber-900 sm:w-56" aria-label="Monthly funds summary unavailable">
      Summary temporarily unavailable
    </div>
  );
  const tone = data.status === "shortfall"
    ? "border-red-500 bg-red-50 text-red-800"
    : data.status === "attention"
      ? "border-amber-500 bg-amber-50 text-amber-900"
      : "border-emerald-500 bg-emerald-50 text-emerald-900";
  const actionItems = data.tenantExpenseActionItems ?? [];
  const actionCount = data.tenantExpenseActionRequiredCount ?? actionItems.length;
  return (<>
    <details className="group relative" data-testid="billing-funds-summary">
      <summary className="relative cursor-pointer list-none overflow-visible rounded-xl border-2 border-[var(--border)] bg-white text-[var(--navy-text)] shadow-sm">
        <span className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 sm:hidden">
          <span><span className="block text-xs font-semibold opacity-75">Outstanding</span><strong className="text-base">Need to collect</strong></span>
          <strong className="whitespace-nowrap text-lg text-[var(--navy-text)]">{rm(data.tenantOutstanding)}</strong>
        </span>
        <span className="hidden grid-cols-4 sm:grid">
          {[
            { label: "To collect", value: data.tenantDue },
            { label: "Received", value: data.tenantCollected, colour: Number(data.tenantCollected) > 0 ? "#00FF00" : undefined },
            { label: "Outstanding", value: data.tenantOutstanding, colour: Number(data.tenantOutstanding) > 0 ? "#FFFF00" : undefined },
            { label: "Management Fee", value: data.managementFee },
          ].map(({ label, value, colour }, index) => (
            <span key={label} className={cn("min-w-32 px-3 py-2", index > 0 && "border-l border-[var(--border)]")} style={colour ? { backgroundColor: colour } : undefined}>
              <span className="block text-xs font-semibold opacity-75">{label}</span>
              <span className="block whitespace-nowrap text-lg font-extrabold text-[var(--navy-text)]">{rm(value)}</span>
            </span>
          ))}
        </span>
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-[min(560px,calc(100vw-2rem))] rounded-xl border border-[var(--border)] bg-white p-4 text-[var(--navy-text)] shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div><p className="text-lg font-bold">Monthly money breakdown</p><p className="text-sm text-[var(--text-secondary)]">To collect, received and outstanding amounts by category</p></div>
          <span className={cn("rounded-full border px-3 py-1 text-sm font-bold", tone)}>{data.status === "safe" ? "Funds healthy" : data.status === "attention" ? "Review funds" : "Payout risk"}</span>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-2">
          {([ ["Total Rental", data.rental], ["Total Deposit", data.deposit] ] as const).map(([label, totals]) => (
            <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--page-bg)] p-3">
              <strong className="text-base text-[var(--navy-text)]">{label}</strong>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-[var(--text-secondary)]">Due</dt><dd className="text-right font-bold">{rm(totals.due)}</dd>
                <dt className="text-[var(--text-secondary)]">Collected</dt><dd className="text-right font-bold">{rm(totals.collected)}</dd>
                <dt className="text-[var(--text-secondary)]">Outstanding</dt><dd className="text-right font-bold">{rm(totals.outstanding)}</dd>
              </dl>
            </div>
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border border-[var(--border)]">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-[var(--table-header)] text-[var(--navy-text)]">
              <tr><th className="w-[40%] px-3 py-2 text-left">Category</th><th className="px-2 py-2 text-right">Due</th><th className="px-2 py-2 text-right">Collected</th><th className="px-3 py-2 text-right">Outstanding</th></tr>
            </thead>
            <tbody>
              {data.tenantBreakdown.map((line) => (
                <tr key={line.key} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-semibold text-[var(--navy-text)]">{line.label}</td>
                  <td className="px-2 py-2 text-right">{rm(line.due)}</td>
                  <td className="px-2 py-2 text-right">{rm(line.collected)}</td>
                  <td className="bg-[#FFFF00] px-3 py-2 text-right font-bold">{rm(line.outstanding)}</td>
                </tr>
              ))}
              {data.tenantBreakdown.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-[var(--text-secondary)]">No tenant charges for this month.</td></tr>}
            </tbody>
            <tfoot className="border-t-2 border-[var(--navy)] bg-[var(--navy)] font-bold text-white">
              <tr><td className="px-3 py-2">Total</td><td className="px-2 py-2 text-right">{rm(data.tenantDue)}</td><td className="px-2 py-2 text-right">{rm(data.tenantCollected)}</td><td className="px-3 py-2 text-right text-[var(--gold-light)]">{rm(data.tenantOutstanding)}</td></tr>
            </tfoot>
          </table>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Tenant expenses charged</span><strong className="block text-base">{rm(data.tenantExpenseCharges)}</strong></div>
          {canViewCosts && <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Direct costs recorded</span><strong className="block text-base">{rm(data.tenantExpenseDirectCosts)}</strong></div>}
          {canViewCosts && <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Gross Margin</span><strong className="block text-base">{rm(data.tenantExpenseGrossMargin)}</strong></div>}
          {canViewCosts && <button type="button" className="rounded-lg bg-orange-50 p-3 text-left transition hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-500" onClick={() => setActionsOpen(true)}>
            <span className="text-orange-800">Cost action required</span><strong className="block text-base text-orange-900">{actionCount} item{actionCount === 1 ? "" : "s"}</strong><small className="text-orange-800">{data.tenantExpenseCostPendingCount ?? 0} missing actual cost · Click to view</small>
          </button>}
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Owner costs to pay</span><strong className="block text-base">{rm(data.ownerExpenses)}</strong></div>
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Management fee before SST</span><strong className="block text-base">{rm(data.managementFeeNonSst)}</strong></div>
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Management fee SST</span><strong className="block text-base">{rm(data.managementFeeSst)}</strong></div>
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Management fee total</span><strong className="block text-base">{rm(data.managementFee)}</strong></div>
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Owner payout balance</span><strong className="block text-base">{rm(data.ownerPayout)}</strong></div>
          <div className={cn("rounded-lg p-3", Number(data.ownerTopUpRequired) > 0 ? "border border-red-400 bg-red-50" : "bg-[var(--page-bg)]")}><span className={Number(data.ownerTopUpRequired) > 0 ? "font-semibold text-red-800" : "text-[var(--text-secondary)]"}>Owner top-up required</span><strong className={cn("block text-base", Number(data.ownerTopUpRequired) > 0 && "text-red-800")}>{rm(data.ownerTopUpRequired)}</strong></div>
          <div className="rounded-lg bg-[var(--page-bg)] p-3"><span className="text-[var(--text-secondary)]">Already collected</span><strong className="block text-base">{rm(data.tenantCollected)}</strong></div>
        </div>
      </div>
    </details>
    <Dialog open={actionsOpen} onOpenChange={setActionsOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Cost action required</DialogTitle></DialogHeader>
        <div className="max-h-[65vh] space-y-2 overflow-y-auto">
          {actionItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--text-secondary)]">All expense costs are completed.</p>
          ) : actionItems.map((item) => (
            <div key={item.expenseId} className="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--page-bg)] p-3 sm:grid-cols-[1.4fr_2fr_1fr_auto] sm:items-center">
              <div><strong className="block text-[var(--navy-text)]">{item.propertyName} {item.unitCode}</strong><span className="text-xs text-[var(--text-secondary)]">Tenant expense</span></div>
              <div><strong className="block text-sm text-[var(--navy-text)]">{item.description}</strong><span className="text-xs text-[var(--text-secondary)]">Charge {rm(item.chargeAmount)}</span></div>
              <div className="text-sm"><span className="block font-semibold text-orange-800">{item.actualCost == null ? "Actual cost missing" : `Cost ${rm(item.actualCost)}`}</span><span className="capitalize text-[var(--text-secondary)]">{item.costPaymentStatus}</span></div>
              <Button type="button" onClick={() => { setActionsOpen(false); onFillExpense(item); }}>Fill now</Button>
            </div>
          ))}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setActionsOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>);
}

/** Collapses each owner|tenant column pair to the SINGLE saveEntry wire field
 * (spec §1 / brief MONEY-CRITICAL #2). `tnbOwner` has no tenant-side sibling
 * (TNB is never tenant-direct — the sub-row meter cols carry that case). */
const OWNER_TENANT_WIRE_FIELD: Partial<Record<ColumnId, keyof SaveEntryInput>> = {
  cleaningOwner: "cleaning",
  cleaningTenant: "cleaning",
  airOwner: "airSelangor",
  airTenant: "airSelangor",
  wifiOwner: "wifi",
  wifiTenant: "wifi",
};
// Task 6: `rental` removed — it is read-only (moved off `entry`, Task 5) and
// MUST never be sent on Save (saveEntrySchema itself no longer accepts it;
// `entry.rental` survives only as a vestigial DB column — see
// packages/shared/src/schemas/bills-grid.ts).
const DIRECT_WIRE_FIELD: Partial<Record<ColumnId, keyof SaveEntryInput>> = {
  tnbOwner: "tnbTotal",
  tnbTenant: "tnbTotal",
  maintenanceFee: "maintenanceFee",
};
// Task 6: `amount` removed — it is read-only/server-derived
// (round2((current-previous)*ratePerKwh)) and MUST never be sent on Save
// (saveReadingsSchema itself no longer accepts it).
const METER_COLUMNS = new Set<string>(["previousKwh", "currentKwh"]);

/**
 * Did this row actually reach a document?
 *
 * ONE definition, because two things now depend on it and they must not drift: the
 * success/failure toast, and which checkboxes clear afterwards. `rebill_confirmation_required`
 * is NOT a success — no mutation happened, the modal is about to ask — so a row waiting on
 * that confirmation keeps its tick and is billed by the confirmed re-Bill.
 */
const isBillSuccess = (r: BillRowResult) =>
  r.outcome === "billed" || r.outcome === "invoiced" || r.outcome === "reinvoiced";
const isBillResolved = (r: BillRowResult) => isBillSuccess(r) || r.outcome === "already_billed";

function sortPeriodsDesc(periods: string[]): string[] {
  return [...periods].sort().reverse();
}

/** First-of-month ISO ("YYYY-MM-01"), UTC — matches the `periodMonth` wire format. */
function firstOfMonthIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
/** Shift a "YYYY-MM-01" anchor by whole months (UTC-safe), same output format. */
function addMonthsIso(monthIso: string, delta: number): string {
  const [y, m] = monthIso.split("-").map(Number);
  return firstOfMonthIso(new Date(Date.UTC(y, m - 1 + delta, 1)));
}

/** Splits a staged `${cellKey}:${columnId}` key on the LAST colon — cellKey is
 * always an apartmentId or listingId (both UUIDs, never containing a colon). */
function splitStagedKey(key: string): { cellKey: string; columnId: string } {
  const idx = key.lastIndexOf(":");
  return { cellKey: key.slice(0, idx), columnId: key.slice(idx + 1) };
}

/** "Read what you see" — the DISPLAYED value of a registered grid cell node,
 * trimmed. An editable cell's node is its `<input>` (its live `value`); a
 * read-only cell stamps `data-copy-value` (falling back to textContent). Single
 * source of truth for both Ctrl/Cmd+C copy and the selection-sum readout, so the
 * two never drift. Returns "" when nothing is readable. */
function readCellDisplayString(node: HTMLElement): string {
  const raw = node instanceof HTMLInputElement ? node.value : node.getAttribute("data-copy-value") ?? node.textContent ?? "";
  return raw.trim();
}

// billFailureReason (the per-unit Bill-toast copy) lives in ./bill-failure-reason so
// this file stays component-only for Vite Fast Refresh.

export default function BillsGridPage() {
  const queryClient = useQueryClient();
  const canViewCosts = usePermission("cost.view");
  const canEditCharges = usePermission("billing.charge.edit");
  const canSaveBilling = usePermission("billing.save");
  const canBillTenants = usePermission("billing.bill");
  const canExportBilling = usePermission("billing.export");
  const canManageDocuments = usePermission("billing.document_manage");
  const canConfigureManagementFee = usePermission("management_fee.configure");
  // Multi-user live view: keep polling state outside the query callback so an
  // in-progress local edit can pause incoming snapshots before they overwrite
  // what the current user is typing.
  const dirtyCountRef = useRef(0);

  // ── period selection (R6) — `selectedPeriods` is UI state for the toolbar;
  // the query itself only changes params once the user actively picks a
  // period (periodOverride), never on the auto-default-select effect below —
  // that avoids an immediate, redundant second fetch of the exact period the
  // server just gave us as its default. ──────────────────────────────────────
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);
  const [periodOverride, setPeriodOverride] = useState<{ period: string; months: number } | null>(null);

  const gridQuery = useQuery({
    queryKey: [...QUERY_KEY_ROOT, periodOverride?.period ?? "default", periodOverride?.months ?? 1],
    queryFn: () =>
      fetchGrid(periodOverride ? { period: periodOverride.period, months: periodOverride.months } : {}),
    placeholderData: (prev) => prev,
    refetchInterval: () => (dirtyCountRef.current === 0 ? 1_000 : false),
    refetchIntervalInBackground: true,
  });

  // Error Handling #1: a rejected query's `data` is undefined — keep our own
  // last-known-good snapshot so the grid never blanks out under the banner.
  const [lastGood, setLastGood] = useState<{
    rows: GridRow[];
    periods: string[];
    period: string;
    billingCapabilities?: GridBillingCapabilities;
  }>({
    rows: [],
    periods: [],
    period: "",
  });
  useEffect(() => {
    if (gridQuery.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional derived-state sync: persist the last-known-good snapshot so the grid never blanks under the error banner (Error Handling #1).
      setLastGood({
        rows: gridQuery.data.rows,
        periods: gridQuery.data.periods,
        period: gridQuery.data.period,
        billingCapabilities: gridQuery.data.billingCapabilities,
      });
    }
  }, [gridQuery.data]);

  const periods = useMemo(() => sortPeriodsDesc(lastGood.periods), [lastGood.periods]);

  useEffect(() => {
    if (selectedPeriods.length === 0 && periods.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: default the selection to the latest period once the periods list loads.
      setSelectedPeriods([periods[0]]);
    }
  }, [periods, selectedPeriods.length]);

  // The server's default anchor (the FIRST, unparameterised fetch) IS the org's
  // current billing month. Capture it ONCE so the toolbar can label past/upcoming
  // months and gate Bill to the current month — WITHOUT a browser-clock read that
  // would drift from the server's timezone authority (and would break the
  // time-agnostic tests). The first resolved response always belongs to the
  // periodOverride-null request fired on mount.
  const [serverCurrentMonth, setServerCurrentMonth] = useState<string>("");
  useEffect(() => {
    if (serverCurrentMonth === "" && gridQuery.data?.period) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot capture of the server's current month from the initial default fetch.
      setServerCurrentMonth(gridQuery.data.period);
    }
  }, [gridQuery.data, serverCurrentMonth]);

  const currentPeriod = selectedPeriods[0] ?? lastGood.period;
  const statementMonth = currentPeriod.slice(0, 7);
  const ownerStatementsQuery = useAllStatementsForMonth(statementMonth);
  const fundsSummaryQuery = useQuery({
    queryKey: ["bills-grid", "funds-summary", currentPeriod],
    queryFn: () => fetchBillingFundsSummary(currentPeriod),
    enabled: currentPeriod !== "",
    retry: 1,
    refetchInterval: () => (dirtyCountRef.current === 0 ? 1_000 : false),
    refetchIntervalInBackground: true,
  });
  const bankReconSummaryQuery = useQuery({ queryKey: ["bank-reconciliation", "summary"], queryFn: getBankReconciliationSummary, retry: false });

  // The anchor shown/navigated in the toolbar. Falls back to the server's current
  // month until the first selection lands.
  const anchorMonth = currentPeriod || serverCurrentMonth;
  // Advance billing: the current month and exactly the next month may be billed.
  // The server-provided month remains the timezone authority; farther future months
  // stay preparation-only, and the API independently enforces the same window.
  const nextBillingMonth = serverCurrentMonth ? addMonthsIso(serverCurrentMonth, 1) : "";
  const canBillSelectedPeriod =
    anchorMonth !== "" && serverCurrentMonth !== ""
    && (anchorMonth === serverCurrentMonth || anchorMonth === nextBillingMonth);
  const isAdvanceBillingMonth = anchorMonth !== "" && anchorMonth === nextBillingMonth;

  function handlePeriodsChange(next: string[]) {
    setSelectedPeriods(next);
    if (next.length > 0) setPeriodOverride({ period: next[0], months: next.length });
  }

  // Move the anchor to ANY month (past to review, future to prepare). Resets to a
  // single-month view; the History chips can widen it again from the default month.
  function handleAnchorMonthChange(monthIso: string) {
    if (!monthIso) return;
    setSelectedPeriods([monthIso]);
    setPeriodOverride({ period: monthIso, months: 1 });
  }

  // ── property "Categorize" filter (R29/D13) — CLIENT-SIDE over lastGood.rows,
  // never re-queries the server. properties are derived from the rows
  // themselves (no separate properties-list endpoint in this task's consumed
  // API surface); each row now carries its own propertyName (fix, final
  // review) so the dropdown shows a real name, not the raw propertyId. ─────
  const [propertyId, setPropertyId] = useState<string>("all");
  const properties = useMemo(() => {
    // Fix (final review): Categorize now shows the property NAME
    // (r.propertyName), not the raw propertyId UUID — dedupe by id; rows
    // sharing a propertyId share the name, so the first row wins.
    const byId = new Map<string, string>();
    for (const r of lastGood.rows) {
      if (!byId.has(r.propertyId)) byId.set(r.propertyId, r.propertyName);
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [lastGood.rows]);
  const visibleRows = useMemo(
    () => (propertyId === "all" ? lastGood.rows : lastGood.rows.filter((r) => r.propertyId === propertyId)),
    [lastGood.rows, propertyId],
  );

  // ── column/date filter (R31e) — an Excel-style per-column value filter
  // CROSSED with a date range over the month strips, layered AFTER the
  // property "Categorize" filter above. Feeds GridTable + Export +
  // billableRows/canExport TOGETHER so a filtered view can never export the
  // unfiltered set. ───────────────────────────────────────────────────────
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const handleColumnFilterChange = useCallback((columnId: string, value: string) => {
    setColumnFilters((prev) => ({ ...prev, [columnId]: value }));
  }, []);

  const filtered = useMemo(
    () => applyFilters(visibleRows, periods, columnFilters, dateRange),
    [visibleRows, periods, columnFilters, dateRange],
  );
  const displayPeriods = filtered.periods;
  // Narrow each row's prior-month strips to the date-filtered period set too
  // — a user who narrowed the date range must see (and export) only matching
  // strips, not the full unfiltered history.
  const displayRows = useMemo(
    () =>
      filtered.rows.map((row) => ({
        ...row,
        priorMonths: row.priorMonths.filter((p) => displayPeriods.includes(p.period)),
      })),
    [filtered.rows, displayPeriods],
  );

  // ── vacant filter (Task 2, P3) — default HIDDEN, persisted via view-prefs.
  // occupied-first ordering always applies; a vacant unit carrying a saved
  // entry (owner charges) is never hidden regardless of the toggle
  // (money-safety — see occupancy.ts). `orderedRows` is the LAST derived set
  // and feeds GridTable + billableRows + canExport/export TOGETHER so a
  // hidden unit can never be bulk-billed or exported. ─────────────────────
  const [showVacant, setShowVacant] = useState<boolean>(() => loadPref(VIEW_PREFS_NS, "showVacant", false));
  const toggleShowVacant = useCallback(() => {
    setShowVacant((on) => {
      savePref(VIEW_PREFS_NS, "showVacant", !on);
      return !on;
    });
  }, []);
  const statementsByApartment = useMemo(() => {
    const map = new Map<string, { id: string; status: "draft" | "first_checked" | "approved" }>();
    for (const statement of ownerStatementsQuery.data ?? []) {
      if (!statement.apartmentId || statement.status === "void") continue;
      const status = statement.status === "first_checked"
        ? "first_checked"
        : (["approved", "sent", "paid"].includes(statement.status) ? "approved" : "draft");
      map.set(statement.apartmentId, { id: statement.id, status });
    }
    return map;
  }, [ownerStatementsQuery.data]);
  const occupancyRows = useMemo(() => visibleUnits(displayRows, showVacant).map((row) => {
    const statement = statementsByApartment.get(row.apartmentId);
    return { ...row, ownerPayoutStatus: statement?.status ?? "draft", ownerStatementId: statement?.id ?? null };
  }), [displayRows, showVacant, statementsByApartment]);

  const downloadOwnerReport = useCallback(async (row: GridRow) => {
    if (!row.ownerPartyId) return;
    const [year, month] = statementMonth.split("-").map(Number);
    const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month - 1, 1))).toUpperCase();
    const rawName = `${row.propertyName} ${row.unitCode} ${monthName} ${String(year).slice(-2)} OWNER INCOME REPORT.pdf`.toUpperCase();
    const filename = rawName.replace(/[\\/:*?"<>|]/g, "-");
    try {
      await downloadLiveStatementPdf({ ownerPartyId: row.ownerPartyId, billingMonth: statementMonth, apartmentId: row.apartmentId }, filename);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download owner income report");
    }
  }, [statementMonth]);

  // ── staged edits (ui-9). Resyncs on [period] internally — a key-based
  // remount isn't required (either is safe per the brief). ──────────────────
  const { staged, stage, unstage, clear, dirtyCount, undo, redo, runBatch, canUndo, canRedo, undoDepth, redoDepth } =
    useStagedEdits(currentPeriod);
  useEffect(() => {
    dirtyCountRef.current = dirtyCount;
  }, [dirtyCount]);

  // ── mouse selection (Excel V2, Task 4): `sel` (useGridSelection) is now a
  // pure CONSUMER surface here — the page reads `sel.range`/`sel.count`/`sel.sum`
  // and calls `sel.selectCells` (via useMultiSelection below) / `sel.setColour`
  // / `sel.hideColumn`, but no longer drives the retired ctrl-fill path — its
  // accretive drag methods (`onPointerDown`/`onPointerMove`/`onPointerUp`)
  // were removed from the hook in Task 5; only the pure `fill()` stays
  // parked. `useMultiSelection` (constructed after `nav`, its
  // rectBetween/setActive inputs) is the sole PRODUCER of `sel.range` on the
  // pointer path. ─────────────────────────────────────────────────────────────
  const sel = useGridSelection();
  // Colour is COSMETIC localStorage only (view-prefs.ts) — never a
  // fetch/API/calc input (R31c). Namespaced "bills-grid" like every other
  // view-prefs consumer in this module (matches use-grid-selection.ts's own
  // internal NS for hiddenColumns).
  const [cellColours, setCellColours] = useState(() => loadCellColours(VIEW_PREFS_NS));
  const [pendingRebillCells, setPendingRebillCells] = useState<Set<string>>(() => new Set());
  const [colourFilters, setColourFilters] = useState<BillingColourFilter[]>([]);
  const [ownerPayoutFilters, setOwnerPayoutFilters] = useState<OwnerPayoutFilter[]>([]);
  const [gridDisplayMode, setGridDisplayMode] = useState<GridDisplayMode>(() => loadPref(VIEW_PREFS_NS, "displayMode", "fit-all"));
  const changeGridDisplayMode = useCallback((next: GridDisplayMode) => {
    setGridDisplayMode(next);
    savePref(VIEW_PREFS_NS, "displayMode", next);
  }, []);
  const [colourUndo, setColourUndo] = useState<CellColourMap[]>([]);
  const [colourRedo, setColourRedo] = useState<CellColourMap[]>([]);
  const visibleColumns = useMemo(
    () => CURRENT_COLUMNS.filter((c) => !sel.hiddenColumns.includes(c.id)),
    [sel.hiddenColumns],
  );
  const orderedRows = useMemo(() => {
    return occupancyRows.filter((row) => {
      const billingMatches = colourFilters.length === 0 || colourFilters.some((filter) => rowHasBillingState(
        row, filter, CURRENT_COLUMNS,
        (cellKey, columnId) => pendingRebillCells.has(`${currentPeriod}:${cellKey}:${columnId}`),
      ));
      const payoutMatches = ownerPayoutFilters.length === 0
        || ownerPayoutFilters.includes(row.ownerPayoutStatus ?? "draft");
      return billingMatches && payoutMatches;
    });
  }, [colourFilters, ownerPayoutFilters, occupancyRows, pendingRebillCells, currentPeriod]);

  // ── P4: Excel-style keyboard nav (Task 2 hook + Task 3 render wiring). The
  // active cell is nav state only — NO money write, NO DOM (the hook is pure);
  // this page owns the DOM registry + focus/scroll effect. Placed AFTER
  // orderedRows/visibleColumns/currentPeriod (its inputs) so it never
  // references a still-in-TDZ binding. `cellNodes` maps `${cellKey}:${columnId}`
  // → the registered <input>/<td> node so the focus effect can .focus() +
  // scrollIntoView the active cell. ─────────────────────────────────────────
  const nav = useGridNav({ rows: orderedRows, columns: visibleColumns, currentPeriod });
  const selectedCellKeys = useMemo(() => new Set(sel.range.map((cell) => `${cell.cellKey}:${cell.columnId}`)), [sel.range]);
  const selectionEdges = useCallback((cellKey: string, columnId: ColumnId): SelectionEdges | undefined => {
    const ownKey = `${cellKey}:${columnId}`;
    if (!selectedCellKeys.has(ownKey)) return undefined;
    const rowIndex = nav.navRows.findIndex((row) => row.cells.some((cell) => cell.cellKey === cellKey && cell.columnId === columnId));
    const columnIds = visibleColumns.filter((column) => column.band).map((column) => column.id);
    const columnIndex = columnIds.indexOf(columnId);
    const hasAt = (ri: number, ci: number) => {
      const cell = nav.navRows[ri]?.cells.find((candidate) => candidate.columnId === columnIds[ci]);
      return !!cell && selectedCellKeys.has(`${cell.cellKey}:${cell.columnId}`);
    };
    const top = !hasAt(rowIndex - 1, columnIndex);
    const bottom = !hasAt(rowIndex + 1, columnIndex);
    const left = !hasAt(rowIndex, columnIndex - 1);
    const right = !hasAt(rowIndex, columnIndex + 1);
    return { top, right, bottom, left, bottomRight: bottom && right };
  }, [nav.navRows, selectedCellKeys, visibleColumns]);
  const cellNodes = useRef(new Map<string, HTMLElement>());
  const registerCell = useCallback((cellKey: string, columnId: string, node: HTMLElement | null) => {
    const k = `${cellKey}:${columnId}`;
    if (node) cellNodes.current.set(k, node);
    else cellNodes.current.delete(k);
  }, []);

  // ── selection sum (readout) ──────────────────────────────────────────────────
  // The geometric selection producers (`rectBetween` for the mouse drag,
  // `extendRange` for Shift+arrow) build `SelectionCell`s from `NavCell`, which
  // carries only identities (cellKey/columnId) — no per-cell numeric value. Left
  // as-is, `useGridSelection.sum` reduces every cell as non-numeric → the badge
  // reads "Sum 0.00" no matter what is selected. `selectCellsWithValues` enriches
  // each committed cell with its DISPLAYED number, read the SAME drift-free way as
  // Ctrl/Cmd+C copy (the registered node's input value, else its `data-copy-value`
  // / textContent) — "sum what you see", captured at selection-commit time. This
  // is a pure display readout: NO money write, NO calc input (it only seeds
  // `SelectionCell.value`, which the hook sums numeric-only).
  const readCellNumericValue = useCallback((cellKey: string, columnId: string): number | null => {
    const node = cellNodes.current.get(`${cellKey}:${columnId}`);
    if (!node) return null;
    const raw = readCellDisplayString(node);
    if (raw === "" || raw === "—") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }, []);
  const commitSelection = sel.selectCells; // stable (useGridSelection's useCallback)
  const selectCellsWithValues = useCallback(
    (cells: SelectionCell[]) =>
      commitSelection(cells.map((c) => ({ ...c, value: readCellNumericValue(c.cellKey, c.columnId) }))),
    [commitSelection, readCellNumericValue],
  );

  // ── Excel-Web V2 — cell edit mode ────────────────────────────────────────────
  // `editingCellKey` is the cell being edited IN-PLACE (entered via double-click
  // or F2). Edit mode is active only while it EQUALS the active cell, so moving
  // the active cell (arrow / click / Enter-Tab commit) auto-exits edit with no
  // effect-ordering race. While editing, the grid releases arrows/Home/End/
  // Delete/caret/text-select and Cmd+A/Cmd+C back to the browser so the field
  // behaves like a normal text input (user requirement); NOT editing = Excel
  // navigation mode (arrows move cells, Delete clears-by-grain, Cmd+A/C are grid
  // ops). Escape clears it explicitly (revertActiveEdit). Typing does NOT enter
  // edit mode — type-to-replace stays in navigation mode (delete-by-grain intact).
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null);
  const activeCellKey = nav.active ? `${nav.active.cellKey}:${nav.active.columnId}` : null;
  const editing = editingCellKey != null && editingCellKey === activeCellKey;
  const beginEdit = useCallback((key?: string) => {
    if (!canEditCharges) return;
    setEditingCellKey(key ?? activeCellKey);
  }, [activeCellKey, canEditCharges]);

  // ── Excel MOUSE selection (V2, Task 4): the selection PRODUCER. A mouse
  // pointerdown opens a rectangle (rectBetween), drag-enter grows it, ctrl
  // toggle-ADDS a cell/rect (no longer a FILL), shift extends from the anchor;
  // every gesture writes the deduped union to `sel.range` via `sel.selectCells`.
  // It also drives `nav.setActiveByCell` on the landing cell so the active ring
  // tracks the drag. NO money write lives here — `onDelete` (unchanged) is the
  // sole consumer of the `sel.range` this produces; the retired ctrl-fill write
  // path is gone. ─────────────────────────────────────────────────────────────
  const multiSel = useMultiSelection({
    rectBetween: nav.rectBetween,
    // useMultiSelection types `setActive`'s columnId as plain `string` (grain-
    // agnostic, like useGridSelection); nav.setActiveByCell narrows it to
    // `ColumnId`. Bridge with a widening wrapper — every columnId reaching here
    // originated from a real ColumnId (a rendered cell), so the narrowing at the
    // call boundary is sound.
    setActive: (cellKey, columnId) => nav.setActiveByCell(cellKey, columnId as ColumnId),
    // Enrich each committed cell with its displayed numeric value so the count/sum
    // badge sums real numbers (see selectCellsWithValues) — identity-only before.
    selectCells: selectCellsWithValues,
  });
  // GridTable wires pointer handlers ONLY on editable cells (grid-table.tsx), so
  // a release OFF any cell (grid edge / unit-name column / a locked cell /
  // header) never runs onCellPointerUp. A window-level pointerup/pointercancel
  // listener finalizes the open rect on ANY release, not just on-cell ones —
  // otherwise a drag released off-cell would leave the rect open, so the next
  // gesture would keep growing it. Ordering: a native `pointerup` dispatched on
  // a cell bubbles through React's delegated dispatch (where the cell's own
  // onCellPointerUp runs) BEFORE it reaches `window`, and onPointerUp is
  // idempotent (folding an already-null rect is a no-op), so the two never
  // conflict.
  useEffect(() => {
    const endDrag = () => multiSel.onPointerUp();
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [multiSel]);

  // Focus + scroll the active cell whenever nav.active changes (arrow-move or
  // click-activate). scrollIntoView keeps a keyboard-driven active cell on
  // screen; .focus() lands on the registered node (an <input> for editable
  // cells, a tabIndex=-1 <td> for read-only ones — Task 3 render wiring).
  useEffect(() => {
    if (!nav.active) return;
    const node = cellNodes.current.get(`${nav.active.cellKey}:${nav.active.columnId}`);
    if (node) {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (node instanceof HTMLInputElement) node.focus();
      else node.focus?.();
    }
  }, [nav.active]);

  // Partial re-Bill. Read once here and shared by every consumer below, so the write
  // gates and the Bill-selection gate can never disagree about which world they are in.
  const partialRebillOn = isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES");
  const billingDocumentsOn = lastGood.billingCapabilities?.billingDocuments
    ?? isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const billExpensesOn = lastGood.billingCapabilities?.expensesAsCharges
    ?? (billingDocumentsOn && isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES"));
  const listingToApartment = useMemo(() => {
    const map = new Map<string, { apartmentId: string; subRow: GridSubRow }>();
    for (const row of lastGood.rows) {
      // Defensive: this aggregation runs at the page level, OUTSIDE
      // GridErrorBoundary — it must never itself crash the page on a
      // malformed `subRows` (that's exactly the contract regression
      // GridErrorBoundary exists to catch, one layer further in, inside
      // GridTable's own render).
      for (const sr of row.subRows ?? []) map.set(sr.listingId, { apartmentId: row.apartmentId, subRow: sr });
    }
    return map;
  }, [lastGood.rows]);

  // Every apartment the grid currently knows about, BY id. The staged buffer is
  // restored verbatim from sessionStorage, so it can carry cellKeys for
  // apartments that no longer exist (a unit deleted by someone else, a DB
  // reset, a restored crash-recovery snapshot). Those keys must never become a
  // save task. Empty means "rows not loaded / fetch failed", NOT "no apartments
  // exist" — every consumer must skip the check in that case rather than treat
  // all staged work as stale.
  //
  // A Map rather than a Set of ids: translateStaged needs the ROW itself to ask
  // `isApplicable` whether a staged column is still the active bearer side, and one
  // derived structure serving both guards cannot fall out of step with itself.
  const rowByApartmentId = useMemo(
    () => new Map(lastGood.rows.map((r) => [r.apartmentId, r] as const)),
    [lastGood.rows],
  );

  // Money guard (period-switch race). The grid always RENDERS lastGood.rows
  // (belonging to lastGood.period); every period-scoped write or on-demand
  // surface open targets currentPeriod. They agree in steady state (the
  // server returns period = periods[0], and the page defaults
  // selectedPeriods to periods[0]) and diverge ONLY while a month switch is
  // in flight OR has failed (lastGood still holds the old month under the
  // "Couldn't load bills — Retry" banner). This is the exact staleness
  // invariant — it covers the in-flight AND the failed-fetch case, and does
  // NOT false-block a same-period months-change refetch (isPlaceholderData
  // did, and also missed the failed-fetch case).
  const showingStalePeriod = currentPeriod !== lastGood.period;

  /** Resolves a cell's OWNING apartmentId — a unit-grain cellKey IS the
   * apartmentId; a sub-row (meter) cellKey is a listingId, resolved via
   * listingToApartment. Shared by handleCellEdit's money-lock check below —
   * lock state lives on the OWNING apartment, never on the listingId itself
   * (the ui-4 F2 hazard). */
  const resolveApartmentId = useCallback(
    (cellKey: string): string => listingToApartment.get(cellKey)?.apartmentId ?? cellKey,
    [listingToApartment],
  );

  /**
   * "This cell is FROZEN money — no write may reach it." THE write-side lock, gating the
   * edit chokepoint (handleCellEdit), the Delete/clear guard (onDelete), the Save
   * translator and the Save preview.
   *
   * It calls `isCellLocked` — the SAME predicate grid-table.tsx renders with and
   * nav-cells.ts navigates by — because the two must agree exactly. When they disagree
   * the page either silently drops edits on cells that still look editable, or (worse)
   * accepts edits on cells the render froze.
   *
   * They DID disagree, and that is the bug this replaced. Slice 3 narrowed the lock from
   * the row to the cell on the read surfaces only; every gate here still tested a
   * row-grain `billedApartmentIds` set built from `isRowLocked`. So on a settled month the
   * grid drew a live <input> over each never-charged cell and then swallowed every
   * keystroke into a no-op: nothing staged, `dirtyCount` stayed 0, and the Save button
   * never lit. The admin had no way to tell a working cell from a dead one.
   *
   * Grain matters twice over. The apartment is resolved via `resolveApartmentId` (a
   * sub-row cellKey is a listingId, absent from any row map — the ui-4 F2 hazard), and
   * the COLUMN is passed through, because a paid electricity bill must no longer freeze
   * the WiFi cell beside it.
   *
   * An unknown row is NOT locked: "rows not loaded" is not "settled", the same reading
   * the old set took (`billedApartmentIds.has(x)` on an empty set was false) and the same
   * one the phantom-apartment guard in translateStaged takes.
   */
  const isCellWriteLocked = useCallback(
    (cellKey: string, columnId: ColumnId): boolean => {
      const row = rowByApartmentId.get(resolveApartmentId(cellKey));
      return row ? isCellLocked(row, columnId) : false;
    },
    [rowByApartmentId, resolveApartmentId],
  );

  /**
   * "Save will NOT write this staged cell, and here is WHY." THE one rule, called by both
   * consumers — `translateStaged` when it builds the wire patch, and the Confirm-save
   * preview when it lists what is about to happen. Two copies of this question is
   * precisely how the preview came to promise a write the save silently dropped.
   *
   * Two reasons, and the preview says which:
   *  • "locked" — the cell's own settlement bucket carries money. `handleCellEdit` refuses
   *    to stage such a cell, so this is the RACE path: a payment that landed after the
   *    value was typed, or a buffer restored from sessionStorage across one. Checked
   *    FIRST — a frozen cell is not "a setting changed", and telling the admin it was
   *    would be a false explanation on a money screen.
   *  • "bearer" — a bearer change made AFTER the value was typed. The owner|tenant column
   *    pairs collapse to ONE wire field while the staged buffer is keyed by column, so an
   *    edit can end up on a side the unit's current setting no longer bills. Deliberately
   *    asked against the RAW cellKey: applicability is a unit-grain question, so a
   *    sub-row (meter) cellKey resolves to no row and is never flagged.
   *
   * An unknown row is NOT skipped — "rows not loaded" is not "stale", the same reading the
   * phantom-apartment guard takes.
   */
  const stagedCellSkipReason = useCallback(
    (cellKey: string, columnId: ColumnId): SaveSkipReason | null => {
      if (isCellWriteLocked(cellKey, columnId)) return "locked";
      const row = rowByApartmentId.get(cellKey);
      return row && !isApplicable(row, columnId) ? "bearer" : null;
    },
    [isCellWriteLocked, rowByApartmentId],
  );

  const handleCellEdit: CellEditHandler = useCallback(
    (cellKey, columnId, value) => {
      if (!canEditCharges) return;
      // Never stage an edit while the grid is showing a stale (placeholder)
      // period — the displayed row belongs to the period being replaced.
      if (showingStalePeriod) return;
      // Fail-closed: never stage an edit against money that has already been paid.
      // Per CELL, matching the render exactly — see isCellWriteLocked above.
      if (isCellWriteLocked(cellKey, columnId)) return;
      stage(cellKey, columnId, value);
    },
    [stage, isCellWriteLocked, showingStalePeriod, canEditCharges],
  );

  // P4 Task 5 (R3, commit-and-move): Enter commits + moves DOWN, Tab commits +
  // moves RIGHT; Shift inverts to up/left. The value is ALREADY staged by typing
  // (input onChange → handleCellEdit chokepoint) — commit is STAGE-ONLY + MOVE
  // and NEVER calls saveEntry/saveReadings (Save stays the explicit persist
  // step, R9). Pure nav.move, no write path.
  const onCommitMove = useCallback(
    (dir: "down" | "right", shift: boolean) =>
      nav.move(dir === "down" ? (shift ? "up" : "down") : (shift ? "left" : "right")),
    [nav],
  );

  // P4 Task 5 (R4, Esc-revert): revert the active cell's in-progress edit to its
  // saved/seed value and STAY in nav (never dismiss the grid). Two writes are
  // needed because GridTable's own internalStaged keystroke-echo has TOP display
  // precedence over the page `staged` buffer: clearing ONLY the page buffer
  // (unstage) leaves the typed value visible. So revert BOTH — the page buffer
  // (unstage) AND GridTable's internal echo (clearInternalStaged, registered via
  // the ref below like the cell-node registry). A no active cell ⇒ safe no-op.
  const clearInternalStagedRef = useRef<((cellKey: string, columnId: string) => void) | null>(null);
  const registerClearInternalStaged = useCallback((fn: (cellKey: string, columnId: string) => void) => {
    clearInternalStagedRef.current = fn;
  }, []);
  const revertActiveEdit = useCallback(() => {
    const a = nav.active;
    if (!a) return;
    unstage(a.cellKey, a.columnId); // page buffer
    clearInternalStagedRef.current?.(a.cellKey, a.columnId); // GridTable echo (top precedence)
    setEditingCellKey(null); // Escape exits edit mode too (Excel-Web V2)
  }, [nav.active, unstage]);

  // Excel-Web V2 — undo/redo (in-memory only, NEVER a server write). `undo`/`redo`
  // rewrite the staged buffer and return the affected cell keys; for each, we clear
  // GridTable's own internalStaged keystroke echo (top display precedence) so the
  // restored staged value is what shows — exactly the revertActiveEdit sync, applied
  // to every cell the step touched.
  const applyEchoClear = useCallback((keys: string[]) => {
    for (const k of keys) {
      const { cellKey, columnId } = splitStagedKey(k);
      clearInternalStagedRef.current?.(cellKey, columnId);
    }
  }, []);
  const onUndo = useCallback(() => {
    const previous = colourUndo.at(-1);
    if (previous) {
      setColourUndo((history) => history.slice(0, -1));
      setColourRedo((history) => [...history, cellColours]);
      setCellColours(previous);
      saveCellColours(VIEW_PREFS_NS, previous);
      return;
    }
    applyEchoClear(undo());
  }, [colourUndo, cellColours, undo, applyEchoClear]);
  const onRedo = useCallback(() => {
    const next = colourRedo.at(-1);
    if (next) {
      setColourRedo((history) => history.slice(0, -1));
      setColourUndo((history) => [...history, cellColours]);
      setCellColours(next);
      saveCellColours(VIEW_PREFS_NS, next);
      return;
    }
    applyEchoClear(redo());
  }, [colourRedo, cellColours, redo, applyEchoClear]);

  // P4 Task 7 (R9/R10, MONEY-CRITICAL): Delete/Backspace clear-by-grain. Targets
  // are the whole Shift-range when one exists, else the single active cell (else
  // nothing). Each target is cleared BY GRAIN, and EVERY write routes through the
  // handleCellEdit chokepoint (which re-guards billed + stale by OWNING
  // apartment) — this handler NEVER calls stage/saveEntry/saveReadings directly:
  //   1. Frozen money (isCellWriteLocked, per CELL) → SKIP first, so a locked cell
  //      never even shows the saved-money cue and never reaches a write. Per cell,
  //      not per row: on a part-paid month Delete must still clear the cells whose
  //      own bucket carries no money. Owning-apartment resolution lives inside the
  //      predicate because a sub-row (meter) cellKey is a listingId absent from the
  //      row map — resolving by raw cellKey would let a settled meter cell through
  //      (the ui-4 F2 hazard).
  //   2. Meter cell (columnId ∈ METER_COLUMNS) → handleCellEdit(cellKey, "") —
  //      stages an empty string; translateStaged maps "" on a meter column to
  //      null, so Save persists a null reading (amount then server-derives null).
  //   3. Uncommitted staged edit (`${cellKey}:${columnId}` in `staged`) →
  //      unstage — revert to the saved value (Task 5 buffer op).
  //   4. Saved entry money cell (editable, not meter, not currently staged) →
  //      NO-OP + a single cue. It must NOT stage "" — translateStaged DROPS an
  //      empty entry-money value (never sends `money: ""`), so staging "" would
  //      SILENTLY fail to persist the clear (money-misleading). "Type 0" is the
  //      explicit path to zero a saved amount.
  //   5. Read-only cells (rental/amount/expense totals) → no-op (nothing to
  //      clear; they aren't meter, aren't entry-money, and carry no staged edit).
  // The cue fires at most ONCE per Delete, not per cell.
  const onDelete = useCallback(() => {
    if (!canEditCharges) return;
    const targets: { cellKey: string; columnId: string }[] = sel.range.length
      ? sel.range.map((c) => ({ cellKey: c.cellKey, columnId: c.columnId }))
      : nav.active
        ? [{ cellKey: nav.active.cellKey, columnId: nav.active.columnId }]
        : [];
    let cued = false;
    // Group every buffer mutation this Delete makes into ONE undo step, so a single
    // Cmd+Z restores the whole cleared selection (R6). runBatch calls fn synchronously.
    runBatch(() => {
    for (const { cellKey, columnId } of targets) {
      // 1. Frozen money → skip (per cell). handleCellEdit re-guards this too,
      // but skipping here also suppresses the saved-money cue for a locked cell.
      if (isCellWriteLocked(cellKey, columnId as ColumnId)) continue;
      // 2. Meter → stage "" (Save nulls it) via the guarded chokepoint. Also
      // clear GridTable's internalStaged keystroke echo (top display
      // precedence): if the admin had just TYPED into this meter cell, that
      // echo would otherwise keep painting the typed value over the staged "".
      // clearInternalStaged is display-only (no stage/save) — the staged "" set
      // by handleCellEdit remains the authoritative buffer value Save reads.
      if (METER_COLUMNS.has(columnId)) {
        handleCellEdit(cellKey, columnId as ColumnId, "");
        clearInternalStagedRef.current?.(cellKey, columnId);
        continue;
      }
      // 3. Uncommitted staged edit → revert to saved. Like revertActiveEdit
      // (Task 5, Hard Point B): clear BOTH the page buffer (unstage) AND
      // GridTable's own internalStaged keystroke echo, which has TOP display
      // precedence — unstaging the page buffer alone would leave the typed
      // value still painted in the <input>. clearInternalStaged is display-only
      // (no stage/save), so this stays within the "no direct write" rule.
      if (Object.prototype.hasOwnProperty.call(staged, `${cellKey}:${columnId}`)) {
        unstage(cellKey, columnId);
        clearInternalStagedRef.current?.(cellKey, columnId);
        continue;
      }
      // 4. Saved entry money cell → no-op + a single cue (NEVER a silent "").
      const isEntryMoney =
        OWNER_TENANT_WIRE_FIELD[columnId as ColumnId] != null || DIRECT_WIRE_FIELD[columnId as ColumnId] != null;
      if (isEntryMoney && !cued) {
        toast.info("Delete won't clear a saved amount. Type 0 to set it to zero.");
        cued = true;
      }
      // 5. Read-only cells fall through → no-op.
    }
    });
  }, [sel.range, nav.active, isCellWriteLocked, handleCellEdit, staged, unstage, runBatch, canEditCharges]);

  // P4 Task 6 (R7): a plain arrow move must COLLAPSE any Shift-range down to the
  // single DESTINATION cell. `nav.move` is a state update, so the landing cell
  // isn't readable synchronously inside onArrow — instead onArrow arms this flag
  // and the collapse runs in the effect below, once `nav.active` has advanced to
  // the new cell. Reading it post-move keeps the selection ring on the cell the
  // arrow actually landed on (never the pre-move origin).
  const collapseOnNextActiveRef = useRef(false);
  // Route the collapse through `multiSel.collapseTo` (Task 4) rather than a bare
  // `sel.selectCells` — collapseTo clears the hook's OWN committed + open-rect
  // state as well as `sel.range`, so a plain arrow move after a mouse multi-
  // select genuinely drops the whole prior selection (not just its flat
  // `sel.range` projection, which a stale committed rect would immediately
  // re-materialize on the next gesture). Depends on `multiSel` (a stable memo);
  // the guard makes the per-render re-run inert until a plain move arms the ref.
  useEffect(() => {
    if (!collapseOnNextActiveRef.current) return;
    collapseOnNextActiveRef.current = false;
    multiSel.collapseTo(nav.active ?? null);
  }, [nav.active, multiSel]);

  // ── Excel-Web V2 — colour fill (shared by the toolbar swatches AND the custom
  // right-click menu). COSMETIC localStorage only (view-prefs.ts) — never a
  // fetch/API/calc input (R31c). Extracted so the toolbar and context menu stay
  // in sync from ONE definition. ──────────────────────────────────────────────
  const applyColourToSelection = useCallback(
    (colour: string) => {
      if (sel.range.length === 0) return;
      const previous = cellColours;
      const next = sel.setColour(
        sel.range.map((c) => ({ cellKey: c.cellKey, columnId: c.columnId, periodMonth: currentPeriod })),
        colour,
      );
      if (JSON.stringify(next) === JSON.stringify(previous)) return;
      setColourUndo((history) => [...history, previous]);
      setColourRedo([]);
      setCellColours(next);
      // Toolbar/context-menu clicks move focus away from the grid. Return it to
      // the active cell so the very next Ctrl/Cmd+Z is still grid-owned.
      if (nav.active) {
        requestAnimationFrame(() => cellNodes.current.get(`${nav.active!.cellKey}:${nav.active!.columnId}`)?.focus());
      }
    },
    [sel, currentPeriod, cellColours, nav.active],
  );

  // ── Excel-Web V2 — Ctrl/Cmd+A: select every navigable cell ───────────────────
  // Replaces the browser's "select all page text". Routes through
  // multiSel.selectAll so the producer hook's committed/rect state stays
  // consistent (a following gesture recomputes from a clean union).
  const handleSelectAll = useCallback(() => {
    const cells = nav.navRows.flatMap((r) => r.cells.map((c) => ({ cellKey: c.cellKey, columnId: c.columnId })));
    multiSel.selectAll(cells);
  }, [nav.navRows, multiSel]);

  // ── Excel-Web V2 — click a column header to select the whole column ──────────
  // A sub-column header passes its one id; a band header passes all its
  // sub-column ids. Plain = replace the selection with the column's cells;
  // Ctrl/Cmd = ADD the column (non-contiguous); Shift = extend the column RANGE
  // from the active cell's column to the clicked column(s). Active moves to the
  // top cell of the (first) selected column, like Excel.
  const handleSelectColumns = useCallback(
    (columnIds: ColumnId[], mods: { shift: boolean; ctrl: boolean }) => {
      const order = visibleColumns.filter((c) => c.band).map((c) => c.id);
      let targetIds: string[] = columnIds;
      if (mods.shift && nav.active) {
        const anchorIdx = order.indexOf(nav.active.columnId);
        const clickedIdxs = columnIds.map((id) => order.indexOf(id)).filter((i) => i >= 0);
        if (anchorIdx >= 0 && clickedIdxs.length > 0) {
          const lo = Math.min(anchorIdx, ...clickedIdxs);
          const hi = Math.max(anchorIdx, ...clickedIdxs);
          targetIds = order.slice(lo, hi + 1);
        }
      }
      const set = new Set(targetIds);
      const cells = nav.navRows.flatMap((r) =>
        r.cells.filter((c) => set.has(c.columnId)).map((c) => ({ cellKey: c.cellKey, columnId: c.columnId })),
      );
      if (cells.length === 0) return;
      if (mods.ctrl) multiSel.addCells(cells);
      else multiSel.selectAll(cells);
      // Active → the top cell of the first selected column (Excel: header click
      // seats the active cell at the column top). cells[0] is navRows-ordered.
      nav.setActiveByCell(cells[0].cellKey, cells[0].columnId as ColumnId);
    },
    [visibleColumns, nav, multiSel],
  );

  // ── Excel-Web V2 — Ctrl/Cmd+C: copy ONE rectangular range as TSV ─────────────
  // Only ever called in NAVIGATION mode — the keyboard hook releases Cmd+C to the
  // browser while EDITING a cell (so in-field text copy still works). Returns TRUE
  // when the grid produced the clipboard payload (caller preventDefaults native
  // copy); FALSE to defer to the browser (nothing selected). A non-contiguous
  // selection shows a cue and copies nothing, but still returns TRUE so a native
  // "copy empty" never clobbers the clipboard. Cell VALUES are read from the live
  // DOM (the registered node): the input's value for editable cells, the
  // `data-copy-value` attr for read-only cells — "copy what you see", with no
  // re-derivation of the display logic here.
  const handleCopy = useCallback((): boolean => {
    // Header/unit labels opt back into native text selection. If words are
    // highlighted, browser copy wins over an older Excel-cell selection.
    if (window.getSelection()?.toString()) return false;
    const dataColumns = visibleColumns.filter((c) => c.band);
    const plan = planRectangularCopy(nav.navRows, dataColumns, sel.range);
    if (plan.status === "empty") return false; // nothing selected → native copy
    if (plan.status === "noncontiguous") {
      toast.info("Copy supports a single rectangular range. Select one range to copy.");
      return true; // handled (suppress native), nothing copied
    }
    const matrix = plan.matrix!;
    const tsv = matrixToTsv(matrix, (c) => {
      const node = cellNodes.current.get(`${c.cellKey}:${c.columnId}`);
      if (!node) return "";
      const trimmed = readCellDisplayString(node); // same "read what you see" source as the sum readout
      return trimmed === "—" ? "" : trimmed; // normalise the read-only empty dash
    });
    void navigator.clipboard?.writeText?.(tsv)?.catch?.(() => {});
    const n = countCells(matrix);
    toast.success(`Copied ${n} cell${n === 1 ? "" : "s"}`);
    return true;
  }, [visibleColumns, nav.navRows, sel.range]);

  // ── Excel-Web V2 — custom right-click context menu ───────────────────────────
  // `ctxMenu` holds the pointer position + the right-clicked cell (null = closed).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cellKey: string; columnId: ColumnId } | null>(null);
  const [cellDocumentsTarget, setCellDocumentsTarget] = useState<CellDocumentTarget | null>(null);
  const closeContextMenu = useCallback(() => setCtxMenu(null), []);

  const contextCell = useMemo(() => {
    if (!ctxMenu) return null;
    const row = lastGood.rows.find((candidate) => candidate.apartmentId === ctxMenu.cellKey || candidate.subRows.some((sub) => sub.listingId === ctxMenu.cellKey));
    if (!row) return null;
    const column = CURRENT_COLUMNS.find((candidate) => candidate.id === ctxMenu.columnId);
    const documents = row.attachments.filter((attachment) => attachment.cellKey === ctxMenu.cellKey && attachment.columnId === ctxMenu.columnId);
    return {
      row,
      columnLabel: column ? [column.band, column.header].filter(Boolean).join(" · ") : ctxMenu.columnId,
      invoiceCount: documents.filter((attachment) => attachment.documentKind === "invoice").length,
      receiptCount: documents.filter((attachment) => attachment.documentKind === "receipt").length,
      hasAmount: Math.abs(readCellNumericValue(ctxMenu.cellKey, ctxMenu.columnId) ?? 0) > 0.005,
    };
  }, [ctxMenu, lastGood.rows, readCellNumericValue]);

  const openCellDocuments = useCallback((kind: CellDocumentKind) => {
    if (!ctxMenu || !contextCell) return;
    setCellDocumentsTarget({
      apartmentId: contextCell.row.apartmentId,
      cellKey: ctxMenu.cellKey,
      columnId: ctxMenu.columnId,
      periodMonth: currentPeriod,
      unitLabel: `${contextCell.row.propertyName} ${contextCell.row.unitCode}`,
      columnLabel: contextCell.columnLabel,
      initialKind: kind,
    });
  }, [ctxMenu, contextCell, currentPeriod]);
  const handleCellContextMenu = useCallback(
    (cell: { cellKey: string; columnId: ColumnId }, e: React.MouseEvent) => {
      e.preventDefault(); // grid owns right-click — suppress the native menu
      // Preserve the selection when the right-click lands INSIDE it; otherwise
      // collapse to the clicked cell (Excel Web) — never start a left-drag.
      const inSelection = sel.range.some((c) => c.cellKey === cell.cellKey && c.columnId === cell.columnId);
      if (!inSelection) {
        multiSel.collapseTo(cell as CellRef);
        nav.setActiveByCell(cell.cellKey, cell.columnId);
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, cellKey: cell.cellKey, columnId: cell.columnId });
    },
    [sel.range, multiSel, nav],
  );

  // P4 Task 4 (R15): grid-container keyboard nav. `onArrow` routes the four
  // arrows to nav.move (which edge-stops and column-preserves per Task 2) — the
  // page's focus/scroll effect above then lands focus on the newly-active cell.
  // Task 6: a plain arrow also COLLAPSES any Shift-range (R7, via the flag +
  // effect above); Shift+arrow EXTENDS a rectangular selection from the anchor
  // into sel.range (onRange → nav.extendRange). Escape (R32) still cancels the
  // active cell edit / closes a transient popover, never the grid itself. Task 5
  // wires `cancelActiveEdit` → revertActiveEdit (single-cell revert) and adds
  // `onCommitMove` (Enter/Tab). Cmd/Ctrl+K and every other key fall through
  // untouched so the layout-level search still opens (scope guard).
  const gridKeyboardRef = useGridKeyboard({
    onArrow: (dir) => {
      collapseOnNextActiveRef.current = true;
      nav.move(dir);
    },
    onRange: (dir) => selectCellsWithValues(nav.extendRange(dir)),
    onCommitMove,
    onDelete,
    // Excel-Web V2: edit-mode gate + type-to-edit + grid-aware Cmd+A / Cmd+C.
    isEditing: () => editing,
    onBeginEdit: beginEdit,
    onSelectAll: handleSelectAll,
    onCopy: handleCopy,
    onUndo,
    onRedo,
    cancelActiveEdit: revertActiveEdit,
    // Escape closes the custom context menu FIRST (transient popover), before it
    // would fall through to cancel the active cell edit.
    closeTransientPopover: () => {
      if (ctxMenu) {
        setCtxMenu(null);
        return true;
      }
      return false;
    },
  });

  // ── Save translation (MONEY-CRITICAL #2) ────────────────────────────────────
  function translateStaged() {
    const entryPatches = new Map<string, Record<string, string>>();
    const readingPatches = new Map<string, Map<string, Record<string, string | null>>>();

    for (const [key, raw] of Object.entries(staged)) {
      const { cellKey, columnId } = splitStagedKey(key);
      const trimmed = raw.trim();

      // MONEY: a cell whose own settlement bucket carries money never reaches the wire.
      // ABOVE the meter branch on purpose — a reading re-prices the tenant's electricity
      // (row-lock.ts maps previousKwh/currentKwh to `tnbTenant`), so a guard placed after
      // it would leave exactly the settled readings unguarded. handleCellEdit already
      // refuses to stage these, so this is the race/restored-buffer path — and the ONE
      // place a stale buffer meets fresh settlement.
      if (isCellWriteLocked(cellKey, columnId as ColumnId)) continue;

      if (METER_COLUMNS.has(columnId)) {
        const meta = listingToApartment.get(cellKey);
        if (!meta) continue; // stray/unknown listing — never guess an owning apartment
        const perApartment = readingPatches.get(meta.apartmentId) ?? new Map();
        const perListing = perApartment.get(cellKey) ?? {};
        perListing[columnId] = trimmed === "" ? null : trimmed;
        perApartment.set(cellKey, perListing);
        readingPatches.set(meta.apartmentId, perApartment);
        continue;
      }

      // A unit-grain cellKey IS the apartmentId — but only if that apartment
      // still exists. Same guard the meter branch above applies to an unknown
      // listingId ("never guess an owning apartment"): without it a staged key
      // left over in sessionStorage from a deleted unit becomes a real
      // saveEntry call against a phantom apartment, which the server rejects
      // and which shows up in the Confirm-save preview as a bare UUID.
      // `size === 0` means rows have not loaded — skip the check rather than
      // silently discard every pending edit.
      if (rowByApartmentId.size > 0 && !rowByApartmentId.has(cellKey)) continue;

      // MONEY: what the admin cannot SEE, Save must not write. `airOwner`/`airTenant`
      // (and the cleaning/wifi pairs) collapse to ONE wire field, so a value staged on
      // the side a bearer change has since made inapplicable is invisible on screen yet
      // would still be persisted — overwriting the value the admin is actually looking
      // at in the sibling cell. Nothing upstream can catch it: the Unit setting drawer
      // refetches the grid but has no handle on the staged buffer, and the buffer is keyed
      // by column, not by wire field — so THIS is the chokepoint that has to notice. Same
      // shape as the phantom-apartment guard above, and likewise skipped when rows have
      // not loaded, since "no rows" means unknown, not stale.
      if (stagedCellSkipReason(cellKey, columnId as ColumnId)) continue;

      const wireField = OWNER_TENANT_WIRE_FIELD[columnId as ColumnId] ?? DIRECT_WIRE_FIELD[columnId as ColumnId];
      if (!wireField || trimmed === "") continue; // unmapped/read-only column, or a blank edit — never send `money: ""`
      const patch = entryPatches.get(cellKey) ?? {};
      patch[wireField] = trimmed;
      entryPatches.set(cellKey, patch);
    }

    return { entryPatches, readingPatches };
  }

  async function handleSave() {
    if (!canSaveBilling || !canEditCharges) return;
    // Same guard as handleCellEdit: a dirty edit staged BEFORE the period
    // switch started must not be flushed while the grid is still showing the
    // stale (placeholder) period's rows — that write would resolve untouched
    // fields from the wrong period's meta.subRow.
    if (dirtyCount === 0 || !currentPeriod || showingStalePeriod) return;
    const { entryPatches, readingPatches } = translateStaged();

    // Each task carries its owning apartmentId so a per-unit result survives
    // Promise.allSettled below. The calls fire eagerly and the server persists
    // each INDEPENDENTLY — a single rejection must never mask the units that saved.
    //
    // No per-APARTMENT lock filter here any more, deliberately. It used to drop every
    // patch belonging to a settled unit, which is what made a legitimate amendment
    // unsavable; `translateStaged` now filters per CELL, so a settled unit arrives here
    // carrying only its unfrozen fields — and a unit whose every staged cell is frozen
    // produces no patch at all, so it never becomes a task in the first place.
    const tasks: { apartmentId: string; run: () => Promise<unknown> }[] = [];
    for (const [apartmentId, patch] of entryPatches.entries()) {
      tasks.push({ apartmentId, run: () => saveEntry(apartmentId, { period: currentPeriod, ...patch } as SaveEntryInput) });
    }
    for (const [apartmentId, perListing] of readingPatches.entries()) {
      const readings: SaveReadingInput[] = Array.from(perListing.entries()).map(([listingId, patch]) => {
        const meta = listingToApartment.get(listingId)!;
        return {
          listingId,
          tenancyId: meta.subRow.tenancyId,
          partyId: null,
          previousKwh: "previousKwh" in patch ? patch.previousKwh : meta.subRow.previousKwh,
          currentKwh: "currentKwh" in patch ? patch.currentKwh : meta.subRow.currentKwh,
          // Task 6: `amount` deliberately OMITTED — saveReadingsSchema no
          // longer accepts it (server-derived, Task 5); sending it would be
          // dead weight the server's own zod parse strips anyway, but
          // omitting it here keeps the wire body honest.
        };
      });
      tasks.push({ apartmentId, run: () => saveReadings(apartmentId, currentPeriod, readings) });
    }
    if (tasks.length === 0) {
      // Everything staged resolved to nothing writable. Since the bearer guard in
      // translateStaged, the reachable cause is routine — every staged edit sits on a
      // column the unit's current setting no longer bills (previously this needed a
      // deleted apartment). A bare `return` left "Save (N)" lit and the beforeunload guard
      // armed with no explanation, so the button simply looked broken and clicking again
      // could never help. The buffer is deliberately NOT cleared: those are the admin's
      // typed amounts, and discarding them here would be the silent loss all over again.
      toast.error("Nothing to save — every pending edit is on a cell that's already been paid, or on a column this unit's current setting no longer bills. Check the Save dialog: it marks each one with the reason.");
      return;
    }

    // allSettled, NOT Promise.all: the old Promise.all rejected on the FIRST failed
    // call and surfaced its raw code as a blanket "Save failed" — while the other
    // in-flight calls had ALREADY persisted server-side, the staged buffer was never
    // cleared, and the grid never refetched ("error, but it still saved").
    const results = await Promise.allSettled(tasks.map((t) => t.run()));
    const failedByApt = new Map<string, string>();
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        const apt = tasks[i].apartmentId;
        if (!failedByApt.has(apt)) failedByApt.set(apt, res.reason instanceof Error ? res.reason.message : "save failed");
      }
    });

    if (failedByApt.size === 0) {
      setPendingRebillCells((previous) => {
        const next = new Set(previous);
        for (const key of Object.keys(staged)) {
          const { cellKey } = splitStagedKey(key);
          const owner = lastGood.rows.find((row) => row.apartmentId === cellKey || row.subRows.some((sub) => sub.listingId === cellKey));
          if (owner && (owner.billed === true || owner.billedAt != null)) next.add(`${currentPeriod}:${key}`);
        }
        return next;
      });
      clear(); // full success — also resets the undo history (R8)
      toast.success("Saved.");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOT });
      return;
    }

    // Partial failure: an apartment counts as saved only if EVERY one of its calls
    // fulfilled. Drop ONLY the saved units' staged edits (keep failed ones so nothing
    // the server rejected is silently lost), then ALWAYS refetch so the grid shows the
    // true server state — never leave a saved row looking unsaved or vice versa.
    const succeededApts = new Set(tasks.map((t) => t.apartmentId).filter((apt) => !failedByApt.has(apt)));
    // Recompute the per-unit staged summary locally — do NOT read the `saveSummary`
    // memo in this async handler (capturing it here defeats React-Compiler memoization
    // preservation: react-hooks/preserve-manual-memoization). Same pure derivation.
    const savedUnits = summarizeStagedByUnit(staged, lastGood.rows, undefined, stagedCellSkipReason);
    runBatch(() => {
      for (const unit of savedUnits) {
        if (!succeededApts.has(unit.apartmentId)) continue;
        for (const c of unit.cells) {
          // Clear ONLY what was actually written. `translateStaged` drops frozen and
          // bearer-stranded cells, so unstaging them alongside their saved siblings
          // would discard a typed amount the server never received — the silent money
          // loss this module's guards exist to prevent, arriving from the other end.
          if (c.skipped) continue;
          unstage(c.cellKey, c.columnId);
          clearInternalStagedRef.current?.(c.cellKey, c.columnId);
        }
      }
    });
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOT });

    // Honest per-unit report — translate each raw code to a human reason.
    const unitCodeByApt = new Map(lastGood.rows.map((r): [string, string] => [r.apartmentId, r.unitCode]));
    const detail = [...failedByApt.entries()].slice(0, 5)
      .map(([apt, raw]) => `${unitCodeByApt.get(apt) ?? apt}: ${saveFailureReason(raw)}`)
      .join(" · ");
    const more = failedByApt.size > 5 ? ` · +${failedByApt.size - 5} more` : "";
    const savedN = succeededApts.size;
    toast.error(
      savedN > 0
        ? `Saved ${savedN} unit${savedN === 1 ? "" : "s"} — ${failedByApt.size} couldn't save`
        : `Couldn't save ${failedByApt.size} unit${failedByApt.size === 1 ? "" : "s"}`,
      { description: `${detail}${more}` },
    );
  }

  // ── Save confirmation gate (Task 3, P1) — MONEY-CRITICAL: the toolbar's
  // Save button OPENS this dialog instead of writing immediately; Confirm
  // delegates to the UNCHANGED handleSave above (same guards, same persist
  // path). Cancel is fully inert — it only flips confirmingSave back to
  // false, never touches `staged` or fires a network call. `saveSummary` is
  // a PURE derivation (summarizeStagedByUnit) over the same `staged`/
  // `orderedRows` Save itself will read — never a separate source of truth. ─
  const [confirmingSave, setConfirmingSave] = useState(false);
  // Rule 3: re-Bill confirmation modal state — set when a Bill returns
  // `rebill_confirmation_required` (existing live invoices for the period). Confirm
  // re-calls Bill with confirmRebill:true; Cancel is fully inert (clears the state).
  const [rebillConfirm, setRebillConfirm] = useState<{
    rows: { apartmentId: string; expectedUpdatedAt: string }[];
    items: {
      unitCode: string;
      tenant: string | null;
      owner: string | null;
      /** R7: lines the re-Bill LEAVES ALONE because they are already paid. */
      kept: { description: string; amount: number; documentNumber: string | null }[];
    }[];
  } | null>(null);
  // tenant_direct silent-drop warning (2026-07-27): units whose typed TNB / AIR amount the Bill
  // is about to DISCARD because that utility is "Tenant pays directly". Purely informational —
  // Confirm proceeds unchanged; the point is that the drop stops being invisible.
  const [unbillableConfirm, setUnbillableConfirm] = useState<UnbillableRow[] | null>(null);
  const [billConfirm, setBillConfirm] = useState(false);
  const [advanceBillConfirm, setAdvanceBillConfirm] = useState(false);
  // lastGood.rows (not orderedRows): mirrors handleSave exactly (P1 review Finding B) —
  // handleSave resolves owning apartments via lastGood.rows, so the preview must use the
  // same input or it shows a raw id for a unit filtered out of the visible orderedRows.
  //
  // The per-APARTMENT exclusion set is gone with the row-grain lock. Exclusion is now
  // per CELL and flows through `stagedCellSkipReason` — the SAME predicate translateStaged
  // consults — so a settled unit still appears here, listing its writable cells as pending
  // and marking the frozen ones. Excluding the whole unit is what used to hide a
  // legitimate amendment from its own confirmation dialog.
  const saveSummary = useMemo(
    () => summarizeStagedByUnit(staged, lastGood.rows, undefined, stagedCellSkipReason),
    [staged, lastGood.rows, stagedCellSkipReason],
  );
  // Units the Confirm dialog can honestly promise to write. Excludes stale groups whose
  // apartment is gone AND groups whose every remaining cell sits on a bearer side the
  // current setting no longer bills — translateStaged drops both, so counting either
  // promises a save that never happens.
  const savableSummaryCount = useMemo(
    () => saveSummary.filter((u) => !u.unresolved && u.cells.some((c) => !c.skipped)).length,
    [saveSummary],
  );
  async function handleConfirmedSave() {
    setConfirmingSave(false);
    await handleSave(); // unchanged persist path + guards
  }
  // Per-unit Clear (Confirm-save preview): discard THIS unit's UNSAVED staged
  // edits so Save skips it — a pure buffer revert down the SAME path as
  // Esc/Delete, never a server write, grouped as ONE undo step so a mis-click
  // is a single Cmd+Z. Each cell needs BOTH reverts: `unstage` drops the page
  // buffer, and `clearInternalStaged` drops GridTable's keystroke echo — which
  // has TOP display precedence (grid-table.tsx stagedOrSeed), so without it the
  // <input> keeps painting the typed value even though the buffer is clean.
  // When it empties the last unit, close the dialog: handleSave's
  // `dirtyCount === 0` guard would otherwise no-op against an empty preview,
  // leaving a dead "Confirm save" on screen.
  function clearUnitEdits(unit: UnitEditSummary) {
    runBatch(() => {
      for (const c of unit.cells) {
        unstage(c.cellKey, c.columnId);
        clearInternalStagedRef.current?.(c.cellKey, c.columnId); // drop GridTable's top-precedence keystroke echo
      }
    });
    if (saveSummary.length <= 1) setConfirmingSave(false);
  }

  // ── Bill selection (MONEY-CRITICAL #1) ──────────────────────────────────────
  // `billableRows` is the SELECTABLE universe: every VISIBLE row with either a saved grid
  // entry OR an orange saved tenant draft (Rental, Deposit or TA) that the server could
  // still bill. A billed-but-
  // UNPAID row stays billable (amend + re-Bill, spec R7).
  //
  // A SETTLED row depends on partial re-Bill, and the flag is the whole difference:
  //
  //  • Flag OFF — excluded, as before. `rebillSupersedeTx` blocks on any active
  //    non-reversed allocation (service.ts, `activePaidByChargeId.size > 0 &&
  //    !partialRebillOn`), so the checkbox would promise a Bill guaranteed to come back a
  //    per-unit failure — the same lie the editable-looking cells were telling.
  //
  //  • Flag ON — included. That guard now carries `&& !partialRebillOn`, so the server
  //    withholds the paid lines and re-mints the rest onto a fresh proforma. Excluding
  //    the row here was the second half of the settled-month dead end: the admin could
  //    add the expense (createExpensesService's entry-wide ENTRY_LOCKED is flag-gated
  //    off, so the server accepts it) and then had no control anywhere on the page to
  //    get it onto a document. A late charge that can be recorded but never billed is
  //    worse than one that is refused outright.
  //
  // The server keeps its own guards for the cases the client cannot predict — a
  // part-settled charge, or a re-Bill whose fresh figures would move an already-paid
  // component. Those surface as a per-unit manifest reason, which is the honest outcome:
  // a Bill that might be refused for a stated reason beats a Bill that cannot be attempted.
  //
  // "Visible" includes the column/date filter (ui-10d), not just the property
  // filter, so a filtered-out row can never be selected or billed. The user then
  // CHECKS which units to Bill (a checkbox per unit + a select-all in the Unit
  // header); Bill acts on the checked subset ONLY — never the whole set — so a
  // stray click can't mass-bill.
  const billableRows = useMemo(
    () => orderedRows.filter((r) => {
      // Current payloads expose the exact attached draft charges that this action will
      // approve, including carpark/manual extras. Use that authoritative list so an
      // attached carpark-only invoice remains selectable and a detached orange cell does
      // not promise a Bill that the server cannot perform. Aggregate cell states are only
      // a rolling-deploy fallback for an older cached/API payload.
      const hasSavedTenancyCharge = r.pendingTenancyCharges !== undefined
        ? r.pendingTenancyCharges.length > 0
        : (r.subRows ?? []).some(
            (subRow) => subRow.rentalBillingState === "saved" || subRow.depositBillingState === "saved",
          ) || r.agreementFees?.new.state === "saved" || r.agreementFees?.renewal.state === "saved";
      // A row lock protects an already-settled GRID entry from being rewritten. It must
      // not hide the Bill checkbox for a separate orange tenancy draft: Rental,
      // Deposit and TA are approved through their own canonical draft rails after the
      // grid result. This is the common move-in shape where Rental is already green
      // while Deposit/TA were added later and are still orange.
      const gridEntryCanBill = r.entry != null && (partialRebillOn || !isRowLocked(r));
      return hasSavedTenancyCharge || gridEntryCanBill;
    }),
    [orderedRows, partialRebillOn],
  );
  const billableApartmentIds = useMemo(() => new Set(billableRows.map((row) => row.apartmentId)), [billableRows]);

  // Checked units. Raw ids persist across filter/refetch; every USE below
  // intersects with the current `billableRows`, so (a) a filtered-out or
  // just-billed unit is never billed even if its id lingers in the set, and
  // (b) a unit that bills successfully leaves `billableRows` on the post-Bill
  // refetch and thus auto-unchecks, while one that fails stays billable → stays
  // checked, ready for retry.
  const [selectedForBill, setSelectedForBill] = useState<Set<string>>(() => new Set());
  const selectedBillableRows = useMemo(
    () => billableRows.filter((r) => selectedForBill.has(r.apartmentId)),
    [billableRows, selectedForBill],
  );
  const selectedVisibleRows = useMemo(() => billableRows.filter((row) => selectedForBill.has(row.apartmentId)), [billableRows, selectedForBill]);
  const allBillableSelected = billableRows.length > 0 && selectedVisibleRows.length === billableRows.length;
  const someBillableSelected = selectedVisibleRows.length > 0 && !allBillableSelected;

  const toggleBillSelection = useCallback((apartmentId: string) => {
    setSelectedForBill((prev) => {
      const next = new Set(prev);
      if (next.has(apartmentId)) next.delete(apartmentId);
      else next.add(apartmentId);
      return next;
    });
  }, []);
  // Select-all is scoped to the currently billable+visible set (§15 bulk-select):
  // if every billable unit is already checked, clear them; otherwise add all.
  const toggleSelectAllForBill = useCallback(() => {
    setSelectedForBill((prev) => {
      const everyBillableChecked = billableRows.length > 0 && billableRows.every((r) => prev.has(r.apartmentId));
      const next = new Set(prev);
      for (const r of billableRows) {
        if (everyBillableChecked) next.delete(r.apartmentId);
        else next.add(r.apartmentId);
      }
      return next;
    });
  }, [billableRows]);

  // Reset the Bill selection when the period changes — a unit checked for July
  // must never stay checked (and silently billable) after switching to June.
  // Uses React's "adjust state during render on a changed value" pattern (NOT a
  // setState-in-effect, which the project's react-hooks lint forbids): track the
  // period the current selection belongs to and clear when it moves. React
  // re-renders immediately with the reset set, before children paint.
  const [selectionPeriod, setSelectionPeriod] = useState(currentPeriod);
  if (selectionPeriod !== currentPeriod) {
    setSelectionPeriod(currentPeriod);
    setSelectedForBill(new Set());
  }

  // Success = a row that actually issued/reissued (or the legacy lock-only `billed`).
  // Every OTHER terminal outcome is a row that needs attention; `rebill_confirmation_required`
  // is handled separately (it opens the modal, never counted as a failure).
  /**
   * Clear the tick on every unit that actually billed, leaving the rest checked.
   *
   * The un-check used to be implicit: a billed unit was expected to drop out of
   * `billableRows` on the refetch, and `selectedBillableRows` intersects with that set. It
   * does not drop out — a billed-but-unpaid row stays amendable (R7), and with partial
   * re-Bill a SETTLED row is deliberately kept billable too — so the tick survived a
   * successful Bill and the next click would silently bill the same unit again.
   *
   * Failures stay checked ON PURPOSE: that is the retry affordance the selection set was
   * documented to provide.
   */
  function deselectBilled(results: BillRowResult[]) {
    const billed = results.filter(isBillResolved).map((r) => r.apartmentId);
    if (billed.length === 0) return;
    const billedSet = new Set(billed);
    setPendingRebillCells((previous) => {
      const next = new Set(previous);
      for (const key of previous) {
        const stagedKey = key.slice(key.indexOf(":") + 1);
        const { cellKey } = splitStagedKey(stagedKey);
        const owner = lastGood.rows.find((row) => row.apartmentId === cellKey || row.subRows.some((sub) => sub.listingId === cellKey));
        if (owner && billedSet.has(owner.apartmentId)) next.delete(key);
      }
      return next;
    });
    setSelectedForBill((prev) => {
      const next = new Set(prev);
      for (const id of billed) next.delete(id);
      return next;
    });
  }

  function reportBillResults(results: BillRowResult[], labelByApartment: ReadonlyMap<string, string>) {
    const succeeded = results.filter(isBillSuccess);
    const unchanged = results.filter((r) => r.outcome === "already_billed");
    const failures = results.filter((r) => !isBillResolved(r));
    if (results.length === 0) return;
    if (unchanged.length === results.length) {
      toast.info(`${unchanged.length === 1 ? "Unit is" : `${unchanged.length} units are`} already up to date — nothing new to Bill`);
      return;
    }
    if (failures.length === 0) {
      toast.success(`Billed ${succeeded.length} of ${results.length}${unchanged.length ? ` · ${unchanged.length} already up to date` : ""}`);
      return;
    }
    const verb = failures.length === 1 ? "needs" : "need";
    const detail = failures
      .slice(0, 5)
      .map((r) => `${labelByApartment.get(r.apartmentId) ?? r.apartmentId}: ${billFailureReason(r)}`)
      .join(" · ");
    const more = failures.length > 5 ? ` · +${failures.length - 5} more` : "";
    toast.error(`Billed ${succeeded.length} of ${results.length} — ${failures.length} ${verb} attention`, {
      description: `${detail}${more}`,
    });
  }

  /** tenant_direct silent-drop warning: surface typed amounts the Bill will discard, then bill. */
  function handleBill() {
    if (!canBillTenants) return;
    if (selectedBillableRows.length === 0 || !currentPeriod) return;
    const unbillable = findUnbillableAmounts(selectedBillableRows);
    if (unbillable.length > 0) { setUnbillableConfirm(unbillable); return; }
    continueToBill();
  }

  function continueToBill() {
    if (isAdvanceBillingMonth) {
      setAdvanceBillConfirm(true);
      return;
    }
    // A first issuance must never happen from one click. A unit can already have
    // grid documents and still acquire a fresh tenancy draft (Deposit/TA/carpark/
    // manually attached charge); that new money needs this detailed confirmation
    // before the existing Re-Bill guard runs. Aggregate states are only the rolling
    // fallback for an older payload without the authoritative pending list.
    const needsDetailedConfirmation = selectedBillableRows.some((row) => {
      const hasPendingTenancyDraft = row.pendingTenancyCharges !== undefined
        ? row.pendingTenancyCharges.length > 0
        : (row.subRows ?? []).some(
            (subRow) => subRow.rentalBillingState === "saved" || subRow.depositBillingState === "saved",
          ) || row.agreementFees?.new.state === "saved" || row.agreementFees?.renewal.state === "saved";
      return !row.billed || hasPendingTenancyDraft;
    });
    if (needsDetailedConfirmation) {
      setBillConfirm(true);
      return;
    }
    void runBill();
  }

  async function runBill() {
    if (!canBillTenants) return;
    // Bill the CHECKED subset only (selectedBillableRows already intersects the
    // checked ids with the visible billable set — never a filtered-out unit).
    if (selectedBillableRows.length === 0 || !currentPeriod) return;
    const rows = selectedBillableRows.map((r) => ({ apartmentId: r.apartmentId, expectedUpdatedAt: r.entry?.updatedAt ?? "rental-draft" }));
    const labelByApartment = new Map(selectedBillableRows.map((r) => [r.apartmentId, r.unitCode]));
    const tokenByApartment = new Map(selectedBillableRows.map((r) => [r.apartmentId, r.entry?.updatedAt ?? "rental-draft"]));
    try {
      // POST …/bill answers 200 with a per-row manifest EVEN WHEN rows fail — there is no
      // 422. Rows with existing live invoices come back `rebill_confirmation_required` (NO
      // mutation) → open the confirm-void-and-reissue modal instead of counting them failed.
      const { results } = await billRows({ period: currentPeriod, rows });
      const confirmNeeded = results.filter((r) => r.outcome === "rebill_confirmation_required");
      const rest = results.filter((r) => r.outcome !== "rebill_confirmation_required");
      reportBillResults(rest, labelByApartment);
      deselectBilled(rest);
      if (confirmNeeded.length > 0) {
        setRebillConfirm({
          rows: confirmNeeded.map((r) => ({ apartmentId: r.apartmentId, expectedUpdatedAt: tokenByApartment.get(r.apartmentId) ?? "" })),
          items: confirmNeeded.map((r) => ({
            unitCode: labelByApartment.get(r.apartmentId) ?? r.apartmentId,
            tenant: r.existingTenantInvoiceNumber ?? null,
            owner: r.existingOwnerInvoiceNumber ?? null,
            kept: r.keptPaidLines ?? [],
          })),
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Billing failed — no rows were billed.");
    } finally {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOT });
    }
  }

  // Rule 3: the admin confirmed the void-and-reissue → re-call Bill with confirmRebill:true
  // for exactly the rows that needed confirmation. The server re-checks every guard
  // (previous-period / payment) in-tx, so this can still be denied server-side.
  async function handleConfirmedRebill() {
    const pending = rebillConfirm;
    if (!pending || !currentPeriod) return;
    setRebillConfirm(null);
    const labelByApartment = new Map(pending.rows.map((r, i) => [r.apartmentId, pending.items[i]?.unitCode ?? r.apartmentId]));
    try {
      const { results } = await billRows({ period: currentPeriod, rows: pending.rows.map((r) => ({ ...r, confirmRebill: true })) });
      reportBillResults(results, labelByApartment);
      deselectBilled(results);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-Bill failed.");
    } finally {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOT });
    }
  }

  // ── Export (R30) — fully-filtered (property + column/date) rows ONLY: a
  // user who filtered must never export the unfiltered set. ─────────────────
  const canExport = orderedRows.length > 0;
  async function handleExport(kind: GridExportKind) {
    if (!canExportBilling || !canExport) return;
    const selected = selectedVisibleRows;
    const useSelected = kind.startsWith("selected-");
    const exportRows = useSelected ? selected : orderedRows;
    if (useSelected && exportRows.length === 0) {
      toast.error("Select at least one unit first.");
      return;
    }
    const month = currentPeriod ?? anchorMonth.slice(0, 7);
    const scope = useSelected ? "SELECTED" : "ENTIRE";
    try {
      if (kind === "data-xlsx" || kind === "selected-data-xlsx") {
        await exportGridToXlsx(exportRows, CURRENT_COLUMNS, displayPeriods, `${scope} BILLING DATA ${month}.xlsx`);
      } else if (kind === "data-pdf" || kind === "selected-data-pdf") {
        await exportGridPdf(exportRows, CURRENT_COLUMNS, displayPeriods, `${scope} BILLING DATA ${month}.pdf`);
      } else if (kind === "payout-zip" || kind === "selected-payout-zip") {
        await exportPayoutReportsZip(exportRows, month, `${scope} OWNER PAYOUT REPORTS ${month}.zip`);
      } else {
        await exportPayoutSummaryXlsx(exportRows, month, `${scope} OWNER PAYOUT SUMMARY ${month}.xlsx`);
      }
      toast.success(`Export ready · ${exportRows.length} unit${exportRows.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed — nothing was downloaded.");
    }
  }

  // ── Per-apartment surfaces (R11 settings / R27 expense eye / attachments) ──
  // SCALE-SAFE: exactly ONE surface mounts at a time, on demand — never inline
  // per row/cell (165 units × 2 bearers would otherwise fire ~330 queries on
  // load). SettingDrawer is itself an always-controlled drawer (open/onClose);
  // ExpensesDialog/AttachmentsPanel are inline, self-fetching widgets with no
  // open/onClose of their own, so each is wrapped in its own controlled Sheet
  // and only ever mounted (via `{target && <Component .../>}`) once a trigger
  // sets its target — never unconditionally.
  const [settingsApt, setSettingsApt] = useState<string | null>(null);
  // PAX-per-room: the open apartment's grid row supplies its rooms + whole/partition
  // discriminator to the Setting drawer (which renders the per-room pax section only
  // for partition units). null until a settings trigger fires.
  const settingsRow = settingsApt ? (lastGood.rows.find((r) => r.apartmentId === settingsApt) ?? null) : null;
  const [managementFeeApt, setManagementFeeApt] = useState<string | null>(null);
  const managementFeeRow = managementFeeApt
    ? (lastGood.rows.find((r) => r.apartmentId === managementFeeApt) ?? null)
    : null;
  // Opening Unit setting preloads the exact per-unit Management Fee config. This
  // lets the shared fee drawer safely choose Edit for an existing unit rule and
  // Create only when the unit genuinely has no override, instead of accidentally
  // creating duplicates every time a configured unit is opened.
  const unitFeeConfigQuery = useFeeConfigs(
    {
      apartmentId: settingsApt ?? undefined,
      isActive: "true",
      limit: 100,
    },
    {
      enabled: canConfigureManagementFee && settingsApt != null && Boolean(settingsRow?.ownerPartyId),
    },
  );
  const exactUnitFeeConfig = settingsApt
    ? (unitFeeConfigQuery.data?.data.items.find((config) => config.apartmentId === settingsApt) ?? null)
    : null;
  const [expensesTarget, setExpensesTarget] = useState<{ apartmentId: string; bearer: ExpenseBearer; withSST: boolean } | null>(null);
  // Bearer-scoped like expensesTarget above — the Owner and Tenant recurring cells open the SAME
  // dialog, so it has to know which one was clicked or it lists both bearers' lines.
  const [recurringTarget, setRecurringTarget] = useState<{ apartmentId: string; bearer: RecurringBearer } | null>(null);
  const [attachmentsApt, setAttachmentsApt] = useState<string | null>(null);
  const [tenantSummaryRow, setTenantSummaryRow] = useState<GridRow | null>(null);
  const [tenantDocumentsRow, setTenantDocumentsRow] = useState<GridRow | null>(null);
  const [ownerReportRow, setOwnerReportRow] = useState<GridRow | null>(null);
  const [activityRow, setActivityRow] = useState<GridRow | null>(null);
  const [billingView, setBillingView] = useState<"overview" | "detailed" | "summary">("detailed");
  const [rowDensity, setRowDensity] = useState<"comfortable" | "compact">(() =>
    loadPref(VIEW_PREFS_NS, "rowDensity", "compact"),
  );

  const changeRowDensity = (next: "comfortable" | "compact") => {
    setRowDensity(next);
    savePref(VIEW_PREFS_NS, "rowDensity", next);
  };

  /** Candidate tenants for the ExpensesDialog party picker (tenant bearer
   * only) — derived from the TARGET apartment's own occupied sub-rows, never
   * an org-wide search (no such endpoint is in this task's API surface). */
  function tenancyOptionsFor(apartmentId: string) {
    const row = lastGood.rows.find((r) => r.apartmentId === apartmentId);
    return (row?.subRows ?? [])
      .filter((sr) => sr.tenancyId != null)
      .map((sr) => ({ tenancyId: sr.tenancyId as string, partyName: sr.partyName ?? "—" }));
  }

  const billingViewControls = (
    <div className="flex h-10 flex-nowrap items-end justify-center gap-2" aria-label="Billing and table views">
      <div className="inline-flex gap-1" role="tablist" aria-label="Billing view">
        {(["overview", "detailed", "summary"] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={billingView === view}
            onClick={() => setBillingView(view)}
            className={cn(
              "h-10 rounded-md border border-[var(--gold)] px-3 text-[15px] font-extrabold capitalize transition",
              billingView === view ? "bg-[var(--navy)] text-[var(--gold-light)] shadow-sm" : "bg-white text-[var(--navy)] hover:bg-[var(--gold)]/10",
            )}
          >
            {view}
          </button>
        ))}
      </div>
      {billingView === "detailed" && (
        <div className="flex h-10 items-center gap-2 border-l border-[var(--border)] pl-3" aria-label="Table view controls">
          <span className="whitespace-nowrap text-[13px] font-bold text-muted-foreground">Table view</span>
          <div className="inline-flex h-10 items-center gap-0.5 rounded-md border border-[var(--border)] bg-white p-0.5" role="group" aria-label="Row density">
            {(["compact", "comfortable"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => changeRowDensity(mode)}
                aria-pressed={rowDensity === mode}
                className={cn("h-9 rounded px-2 text-[13px] font-bold capitalize", rowDensity === mode ? "bg-[var(--navy)] text-[var(--gold-light)]" : "text-[var(--navy)] hover:bg-[var(--gold)]/10")}
              >{mode}</button>
            ))}
            <span aria-hidden="true" className="mx-1 h-6 w-px bg-[var(--border)]" />
            {(["easy-read", "fit-all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => changeGridDisplayMode(mode)}
                aria-pressed={gridDisplayMode === mode}
                className={cn("h-9 rounded px-2 text-[13px] font-bold", gridDisplayMode === mode ? "bg-[var(--navy)] text-[var(--gold-light)]" : "text-[var(--navy)] hover:bg-[var(--gold)]/10")}
              >{mode === "easy-read" ? "Easy Read" : "Fit All"}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const toolbar = (
    <GridToolbar
      periods={periods}
      selectedPeriods={selectedPeriods}
      onPeriodsChange={handlePeriodsChange}
      anchorMonth={anchorMonth}
      currentBillingMonth={serverCurrentMonth}
      onStepMonth={(delta) => {
        if (anchorMonth) handleAnchorMonthChange(addMonthsIso(anchorMonth, delta));
      }}
      onAnchorMonthChange={handleAnchorMonthChange}
      properties={properties}
      propertyId={propertyId}
      onPropertyChange={setPropertyId}
      dirtyCount={dirtyCount}
      onSave={() => setConfirmingSave(true)}
      canEditAction={canEditCharges}
      canSaveAction={canSaveBilling && canEditCharges}
      canBillAction={canBillTenants}
      canExportAction={canExportBilling}
      canUndo={canUndo || colourUndo.length > 0}
      canRedo={canRedo || colourRedo.length > 0}
      undoDepth={undoDepth + colourUndo.length}
      redoDepth={redoDepth + colourRedo.length}
      onUndo={onUndo}
      onRedo={onRedo}
      selectedRowCount={selectedBillableRows.length}
      onBill={() => handleBill()}
      canBillPeriod={canBillSelectedPeriod}
      canExport={canExport}
      onExport={(kind) => void handleExport(kind)}
      selectedExportCount={selectedVisibleRows.length}
      columnFilters={columnFilters}
      onColumnFilterChange={handleColumnFilterChange}
      colourFilters={colourFilters}
      onColourFiltersChange={setColourFilters}
      ownerPayoutFilters={ownerPayoutFilters}
      onOwnerPayoutFiltersChange={setOwnerPayoutFilters}
      dateRange={dateRange}
      onDateRangeChange={setDateRange}
      hasSelection={sel.range.length > 0}
      onApplyColour={applyColourToSelection}
      columns={CURRENT_COLUMNS}
      hiddenColumns={sel.hiddenColumns}
      onToggleColumn={sel.hideColumn}
      showVacant={showVacant}
      onToggleShowVacant={toggleShowVacant}
      viewControls={billingViewControls}
    />
  );

  const billingLegend = (
    <div
      data-testid="billing-colour-legend"
      aria-label="Cell colour status guide"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm font-medium text-[var(--navy-text)]"
    >
      <span className="font-bold">Cell status:</span>
      {[
        { colour: "transparent", label: "No data" },
        { colour: "#FF8C00", label: "Saved · not billed" },
        { colour: "#FFFF00", label: "Billed · unpaid" },
        { colour: "#00FF00", label: "Paid" },
        { colour: "#FF0000", label: "Changed · re-bill" },
      ].map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 rounded-sm border border-[var(--border)]"
            style={{ backgroundColor: item.colour }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenant & Owner Billing"
        description="Save owner and tenant charges for the period, then Bill once everything checks out."
        icon={Receipt}
        actions={<div className="flex items-stretch gap-2">
          {(bankReconSummaryQuery.data?.chargeRequired.count ?? 0) > 0 && (
            <button type="button" onClick={() => window.location.assign("/accounting/bank-reconciliation")} className="rounded-xl border border-red-500 bg-red-50 px-4 text-left text-red-900 shadow-sm">
              <span className="block text-xs font-bold uppercase">Costs awaiting charge</span>
              <span className="block text-lg font-extrabold">{bankReconSummaryQuery.data!.chargeRequired.count} item · RM {Number(bankReconSummaryQuery.data!.chargeRequired.amount).toFixed(2)}</span>
            </button>
          )}
          <FundsSummaryPanel data={fundsSummaryQuery.data} canViewCosts={canViewCosts} onFillExpense={(item) => setExpensesTarget({ apartmentId: item.apartmentId, bearer: "tenant", withSST: item.withSST })} />
        </div>}
      />

      <div className="-mt-3 rounded-lg border border-[var(--border)] bg-white px-3 py-2 shadow-sm dark:bg-card">
        {billingLegend}
      </div>

      {gridQuery.isError && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn&apos;t load bills</span>
            <Button type="button" variant="outline" size="sm" onClick={() => gridQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Callout>
      )}

      {toolbar}

      {billingView === "overview" ? (
        <BillingSummaryTable rows={orderedRows} staged={staged} />
      ) : billingView === "summary" ? (
        <BillingSummaryNotes rows={orderedRows} period={currentPeriod} />
      ) : (
      <div
        ref={gridKeyboardRef}
        data-testid="grid-region"
        className={cn(rowDensity === "compact" ? "max-h-[78vh]" : "max-h-[70vh]", "overflow-x-auto overflow-y-auto")}
      >
        {/* (a) drag-select indicator — floating badge near the grid, not the
            toolbar (per brief). `sel.sum` is the hook's NUMERIC-ONLY sum. */}
        {sel.count > 1 && (
          <div
            data-testid="selection-badge"
            className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border/50 bg-background/90 px-4 py-2 text-sm shadow-xl backdrop-blur-xl"
          >
            <span>Count {sel.count}</span>
            <span>Sum {sel.sum.toFixed(2)}</span>
          </div>
        )}
        <div
          data-testid="grid-scroll"
          className="contents"
        >
          <GridErrorBoundary onReload={() => void gridQuery.refetch()}>
          <GridTable
            // ui-task-10-keyfix: remount GridTable per period. GridTable owns
            // an internal keystroke-echo buffer (`internalStaged`) that its
            // stagedOrSeed resolver checks BEFORE the page's `staged` prop or
            // the seed (see ui-task-10g comment above). Without a key tied to
            // the period, a value typed in one month's cell survives in that
            // internal buffer and is still shown after switching to a
            // different month — display-only contamination (Save stays
            // period-correct via useStagedEdits(currentPeriod) below). Keying
            // on currentPeriod forces a fresh GridTable (fresh internalStaged)
            // on every period switch; `staged`/cellColours/sel stay page-level
            // and are unaffected by the remount.
            key={currentPeriod}
            rows={orderedRows}
            columns={visibleColumns}
            displayMode={gridDisplayMode}
            density={rowDensity}
            canEdit={canEditCharges}
            // Mirrors the unit-level vacant filter down to the room grain so a
            // partitioned unit's vacant rooms hide/show with the same toggle.
            showVacant={showVacant}
            onCellEdit={canEditCharges ? handleCellEdit : undefined}
            // ui-task-10g: the page's OWN useStagedEdits buffer, so a
            // programmatic stage that never goes through GridTable's internal
            // keystroke echo (ctrl-fill via handleCellEdit above, ui-9
            // crash-recovery restoring from sessionStorage on mount) also
            // repaints the <input> — display-only, Save already reads this
            // same `staged` object unchanged.
            staged={staged}
            // Task 4 (Excel MOUSE selection V2): drive the selection PRODUCER
            // (useMultiSelection). onCellPointerDown forwards the {shift,ctrl}
            // mods VERBATIM — the hook resolves CTRL-before-SHIFT precedence
            // internally (mods.ctrl is already `ctrlKey || metaKey`, computed by
            // grid-table's editableCellProps). ctrl now TOGGLE-ADDS a cell/rect
            // (the retired ctrl-fill is gone — no money write on any pointer
            // path); drag-enter grows the open rect; release finalizes it.
            // `cell` arrives as a SelectionCell (columnId typed `string`, plus a
            // numeric `value`); the hook wants a CellRef (columnId: ColumnId).
            // Every cell here is a rendered navigable cell, so its columnId is a
            // real ColumnId — the widening cast is sound.
            onCellPointerDown={(cell, mods) => multiSel.onCellPointerDown(cell as CellRef, mods)}
            onCellPointerEnter={(cell) => multiSel.onCellPointerEnter(cell as CellRef)}
            onCellPointerUp={() => multiSel.onPointerUp()}
            isCellSelected={(cellKey, columnId) =>
              sel.range.some((c) => c.cellKey === cellKey && c.columnId === columnId)
            }
            selectionEdges={selectionEdges}
            cellColour={(cellKey, columnId) => cellColours[`${cellKey}:${columnId}:${currentPeriod}`]}
            // P4 Task 3: active-cell nav wiring — render the active ring
            // (distinct from selection), activate on click, and register each
            // navigable cell's DOM node for the focus/scroll effect above.
            isCellActive={(cellKey, columnId) => nav.isActive(cellKey, columnId)}
            isCellEditing={(cellKey, columnId) => editingCellKey === `${cellKey}:${columnId}`}
            isCellPendingRebill={(cellKey, columnId) => pendingRebillCells.has(`${currentPeriod}:${cellKey}:${columnId}`)}
            // Task 4: a shift/ctrl click is OWNED by the pointer-down path
            // (multiSel.onCellPointerDown extends/toggles the selection there).
            // The plain onClick must therefore NOT also fire a bare set-active,
            // which would COLLAPSE the multi-selection the modified click just
            // built (setActiveByCell resets the nav shift-anchor, and a plain
            // set-active would drop the just-built multi-selection) — bail on
            // any modifier and only set-active for a truly plain click.
            onCellActivate={(cellKey, columnId, mods) => {
              if (mods.shift || mods.ctrl) return;
              nav.setActiveByCell(cellKey, columnId);
            }}
            // Excel-Web V2: right-click → custom context menu (preserves the
            // selection when inside it, else activates the clicked cell); the
            // handler preventDefaults the native menu.
            onCellContextMenu={handleCellContextMenu}
            // Excel-Web V2: double-click an editable cell → enter edit mode. The
            // preceding click already activated the cell; setActiveByCell keeps it
            // robust, then beginEdit flips arrows/caret to in-field editing.
            onCellDoubleClick={canEditCharges ? (cellKey, columnId) => {
              nav.setActiveByCell(cellKey, columnId);
              beginEdit(`${cellKey}:${columnId}`);
            } : undefined}
            // Excel-Web V2: click a column/band header → select the whole column.
            onSelectColumns={handleSelectColumns}
            registerCell={registerCell}
            // P4 Task 5 (Esc-revert, Hard Point B): register GridTable's own
            // internalStaged-clear so revertActiveEdit can drop the top-precedence
            // keystroke echo alongside unstaging the page buffer — otherwise the
            // typed value stays visible after Escape.
            registerClearInternalStaged={registerClearInternalStaged}
            // Per-unit Bill selection (money-critical): the page owns the checked
            // set + the billable universe; GridTable renders a checkbox on each
            // billable row and a tri-state select-all in the Unit header. Bill
            // acts on `selectedBillableRows` (checked ∩ billable) only.
            billableApartmentIds={billableApartmentIds}
            selectedForBill={selectedForBill}
            allBillableSelected={allBillableSelected}
            someBillableSelected={someBillableSelected}
            onToggleBillSelection={canBillTenants ? toggleBillSelection : undefined}
            onToggleSelectAllForBill={canBillTenants ? toggleSelectAllForBill : undefined}
            // onOpenSettings stays UNGUARDED — SettingDrawer keys off
            // getBearerConfig(apartmentId), with no period in its cache key, so
            // it is period-INDEPENDENT and safe to open during a stale window.
            onOpenSettings={(apartmentId) => setSettingsApt(apartmentId)}
            onConfigureManagementFee={canConfigureManagementFee ? (apartmentId) => {
              const row = lastGood.rows.find((candidate) => candidate.apartmentId === apartmentId);
              if (!row?.ownerPartyId) {
                toast.error("Assign an owner to this unit before configuring its management fee.");
                return;
              }
              setManagementFeeApt(apartmentId);
            } : undefined}
            // onViewExpenses/onOpenAttachments are period-scoped opens
            // (ExpensesDialog/AttachmentsPanel fetch by periodMonth =
            // currentPeriod while tenancyOptionsFor reads lastGood.rows) — a
            // stale-window click must not open either, or an expense/bill
            // gets filed under the NEW month attributed to the OLD month's
            // tenant/rows.
            onViewExpenses={(apartmentId, bearer, withSST) => {
              if (showingStalePeriod) return;
              setExpensesTarget({ apartmentId, bearer, withSST });
            }}
            onViewRecurring={(apartmentId, bearer) => {
              if (showingStalePeriod) return;
              setRecurringTarget({ apartmentId, bearer });
            }}
            onOpenAttachments={(apartmentId) => {
              if (showingStalePeriod) return;
              setAttachmentsApt(apartmentId);
            }}
            onViewTenantSummary={(row) => {
              if (showingStalePeriod) return;
              setTenantSummaryRow(row);
            }}
            onViewTenantDocuments={(row) => {
              if (showingStalePeriod) return;
              setTenantDocumentsRow(row);
            }}
            onViewOwnerReport={(row) => {
              if (showingStalePeriod) return;
              setOwnerReportRow(row);
            }}
            onDownloadOwnerReport={(row) => { void downloadOwnerReport(row); }}
            onViewActivity={(row) => {
              if (showingStalePeriod) return;
              setActivityRow(row);
            }}
          />
          </GridErrorBoundary>
        </div>
      </div>
      )}

      <SettingDrawer
        apartmentId={settingsApt ?? ""}
        open={settingsApt != null}
        onClose={() => setSettingsApt(null)}
        subRows={settingsRow?.subRows}
        isWholeUnit={settingsRow?.isWholeUnit}
        managementFee={settingsRow?.managementFee}
        ownerAssigned={Boolean(settingsRow?.ownerPartyId)}
        onOpenManagementFee={
          canConfigureManagementFee &&
          settingsApt != null &&
          settingsRow?.ownerPartyId &&
          (settingsRow.managementFee?.configured === false ||
            (settingsRow.managementFee?.configured === true && unitFeeConfigQuery.isSuccess))
            ? () => setManagementFeeApt(settingsApt)
            : undefined
        }
      />

      {managementFeeRow?.ownerPartyId && (
        <FeeConfigDrawer
          open={managementFeeApt != null}
          onClose={() => {
            setManagementFeeApt(null);
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOT });
          }}
          mode={managementFeeApt === settingsApt && exactUnitFeeConfig ? "edit" : "create"}
          config={managementFeeApt === settingsApt ? exactUnitFeeConfig ?? undefined : undefined}
          owners={[{
            id: managementFeeRow.ownerPartyId,
            displayName: managementFeeRow.ownerName ?? "Owner",
          }]}
          lockedOwner={{
            id: managementFeeRow.ownerPartyId,
            displayName: managementFeeRow.ownerName ?? "Owner",
          }}
          properties={[{
            id: managementFeeRow.propertyId,
            name: managementFeeRow.propertyName,
          }]}
          units={[{
            apartmentId: managementFeeRow.apartmentId,
            unitCode: managementFeeRow.unitCode,
            propertyName: managementFeeRow.propertyName,
          }]}
          initialUnit={{
            apartmentId: managementFeeRow.apartmentId,
            unitCode: managementFeeRow.unitCode,
            propertyName: managementFeeRow.propertyName,
          }}
        />
      )}

      <TenantBillSummaryDialog row={tenantSummaryRow} onClose={() => setTenantSummaryRow(null)} />
      <UnitDocumentsDialog
        key={`${tenantDocumentsRow?.apartmentId ?? "closed"}:${statementMonth}`}
        row={tenantDocumentsRow}
        billingMonth={statementMonth}
        onClose={() => setTenantDocumentsRow(null)}
      />
      <OwnerReportDialog row={ownerReportRow} month={statementMonth} onClose={() => setOwnerReportRow(null)} />
      <ActivityLogDrawer row={activityRow} onClose={() => setActivityRow(null)} />
      <CellDocumentsDialog
        key={cellDocumentsTarget ? `${cellDocumentsTarget.cellKey}:${cellDocumentsTarget.columnId}:${cellDocumentsTarget.initialKind}` : "closed"}
        target={cellDocumentsTarget}
        onClose={() => setCellDocumentsTarget(null)}
        onRecordPayment={() => {
          setCellDocumentsTarget(null);
          toast.info("Receipt saved. Record and allocate the actual payment to update Paid or Partial Paid correctly.");
          window.location.assign("/billing/payments");
        }}
      />

      {recurringTarget && (
        <RecurringDialog
          // Keyed by bearer too — switching from the Owner cell to the Tenant cell must remount
          // rather than reuse the previous bearer's rendered list.
          key={`${recurringTarget.apartmentId}:${recurringTarget.bearer}`}
          apartmentId={recurringTarget.apartmentId}
          periodMonth={currentPeriod}
          bearer={recurringTarget.bearer}
          open={recurringTarget != null}
          onClose={() => setRecurringTarget(null)}
          onEditInSettings={(id) => setSettingsApt(id)}
        />
      )}

      <Sheet
        open={expensesTarget != null}
        onOpenChange={(open) => {
          if (!open) setExpensesTarget(null);
        }}
      >
        <SheetContent size="xl">
          <SheetHeader>
            <SheetTitle>{expensesTarget?.bearer === "owner" ? "Owner" : "Tenant"} expenses</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {expensesTarget && (
              <ExpensesDialog
                // remount per target so exactly one listExpenses query fires
                key={`${expensesTarget.apartmentId}:${expensesTarget.bearer}:${expensesTarget.withSST}`}
                apartmentId={expensesTarget.apartmentId}
                periodMonth={currentPeriod}
                bearer={expensesTarget.bearer}
                defaultWithSST={expensesTarget.withSST}
                tenancyOptions={tenancyOptionsFor(expensesTarget.apartmentId)}
              />
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet
        open={attachmentsApt != null}
        onOpenChange={(open) => {
          if (!open) setAttachmentsApt(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            {/* Scope in the FIRST thing read on open — the panel inside carries the
                full owner-only note, but a drawer titled just "Attachments" already
                set the wrong expectation before the reader got that far. */}
            <SheetTitle>Unit bills (owner)</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {attachmentsApt && (
              // remount per target, symmetric with ExpensesDialog's key above
              // (refactor-proofing; the modal gate already forces unmount today)
              <AttachmentsPanel key={attachmentsApt} apartmentId={attachmentsApt} periodMonth={currentPeriod} />
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Task 3 (P1) — Save confirmation. Cancel: onOpenChange(false) below
          only flips confirmingSave, never touches `staged`/fires a write.
          Confirm: handleConfirmedSave delegates to the unchanged handleSave
          (its own dirtyCount/currentPeriod/showingStalePeriod guards still
          apply — this dialog only DEFERS the call, never bypasses them). */}
      <Sheet open={confirmingSave} onOpenChange={(open) => { if (!open) setConfirmingSave(false); }}>
        <SheetContent size="lg">
          <SheetHeader className="p-7"><SheetTitle className="text-2xl">Confirm save</SheetTitle></SheetHeader>
          <SheetBody className="p-7 text-[18px]">
            <p className="mb-5 text-[18px] leading-relaxed text-muted-foreground">
              {/* Count only what will actually be written. A stale (unresolved)
                  group is listed below so it can be cleared, but counting it
                  here would promise a save that handleSave never performs. */}
              About to save changes to {savableSummaryCount} unit
              {savableSummaryCount === 1 ? "" : "s"}:
            </p>
            <ul className="mb-6 space-y-4 text-[18px]" data-testid="save-confirm-list">
              {saveSummary.map((u) => (
                <li key={u.apartmentId} className="rounded-lg border border-[var(--border)] px-4 py-4" data-testid={`save-confirm-unit-${u.unitCode}`}>
                  <div className="flex items-center justify-between gap-2">
                    {u.unresolved ? (
                      // Stale sessionStorage key: this apartment is gone, so
                      // handleSave drops it. Say that, rather than printing the
                      // bare id where a unit code belongs and letting it look
                      // like a unit that will be written.
                      <span className="font-medium text-amber-700 dark:text-amber-400">
                        Unit no longer exists — won&apos;t be saved
                      </span>
                    ) : (
                      <span className="font-mono text-[20px] font-bold text-[var(--navy-text)]">{u.unitCode}</span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="default"
                      className="text-[16px] text-muted-foreground hover:text-destructive"
                      data-testid={`save-confirm-clear-${u.unitCode}`}
                      title={
                        u.unresolved
                          ? "Discard these stale edits — the unit they belong to no longer exists"
                          : `Discard the unsaved changes for ${u.unitCode} (won't be saved)`
                      }
                      onClick={() => clearUnitEdits(u)}
                    >
                      <X /> Clear
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {u.cells.map((c) => (
                      <li key={`${c.cellKey}:${c.columnId}`} className="flex items-baseline justify-between gap-5 leading-relaxed">
                        <span className="text-muted-foreground">
                          {c.label}
                          {/* Save will drop this cell. Saying so here is the whole point:
                              listing it as a pending write and then reporting "Saved."
                              would lose the amount with no signal at all. The REASON is
                              carried through from the same predicate translateStaged
                              consults — "already paid" must not be reported as a changed
                              setting, or the admin goes hunting in the Unit drawer for a
                              setting that was never wrong. */}
                          {c.skipped && (
                            <span
                              className="ml-1.5 text-amber-700 dark:text-amber-400"
                              data-testid={`save-confirm-skipped-${c.columnId}`}
                            >
                              {c.skipReason === "locked"
                                ? "— already paid, won't be saved"
                                : "— setting changed, won't be saved"}
                            </span>
                          )}
                        </span>
                        <span className={cn("font-mono text-[20px] font-semibold tabular-nums text-[var(--navy-text)]", c.skipped && "line-through text-muted-foreground")}>
                          {c.value === "" ? <em className="text-muted-foreground not-italic">cleared</em> : c.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" size="lg" className="h-12 px-5 text-[18px]" onClick={() => setConfirmingSave(false)}>Cancel</Button>
              <Button type="button" variant="gold" size="lg" className="h-12 px-5 text-[18px]" data-testid="save-confirm-btn" onClick={() => void handleConfirmedSave()}>
                Confirm save
              </Button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Rule 3 — re-Bill confirmation. Opens when a Bill returns
          `rebill_confirmation_required` (existing live invoices). Cancel only clears the
          state; Confirm re-Bills (confirmRebill:true) — the server re-checks every guard. */}
      <Sheet open={rebillConfirm != null} onOpenChange={(open) => { if (!open) setRebillConfirm(null); }}>
        <SheetContent>
          <SheetHeader><SheetTitle>Re-Bill existing invoices?</SheetTitle></SheetHeader>
          <SheetBody>
            <p className="mb-3 text-sm text-muted-foreground">
              This billing period has already been invoiced. Continuing will <strong>void the existing unpaid
              tenant and owner invoices</strong> and create new invoices using the latest saved billing values.
              {rebillConfirm?.items.some((u) => u.kept.length > 0)
                ? " Lines the tenant has already paid are kept exactly as they are."
                : ""}
            </p>
            <ul className="mb-4 space-y-2 text-sm" data-testid="rebill-confirm-list">
              {rebillConfirm?.items.map((u) => (
                <li key={u.unitCode} className="rounded border px-2 py-1.5">
                  <div className="font-mono font-medium">{u.unitCode}</div>
                  {u.tenant ? <div className="text-muted-foreground">Tenant invoice: {u.tenant}</div> : null}
                  {u.owner ? <div className="text-muted-foreground">Owner invoice: {u.owner}</div> : null}
                  {/* R7: without this an admin cannot tell that a paid line survives —
                      the numbers above alone read as "everything here is being voided". */}
                  {u.kept.length > 0 ? (
                    <div className="mt-1.5 space-y-0.5" data-testid="rebill-kept-lines">
                      {u.kept.map((k, i) => (
                        <div key={i} className="text-xs text-emerald-600">
                          Keeping {k.description} · {k.amount.toFixed(2)} · paid
                          {k.documentNumber ? ` · ${k.documentNumber}` : ""}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRebillConfirm(null)}>Cancel</Button>
              <Button type="button" variant="gold" data-testid="rebill-confirm-btn" onClick={() => void handleConfirmedRebill()}>
                Confirm re-Bill
              </Button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* tenant_direct silent-drop warning — opens BEFORE the Bill call when a selected unit
          carries a typed TNB / AIR amount that "Tenant pays directly" makes unbillable. It
          reports, it does not block: recording the provider's figure while the tenant settles
          it directly is legitimate. Cancel is fully inert; Confirm bills exactly as before. */}
      <Sheet open={unbillableConfirm != null} onOpenChange={(open) => { if (!open) setUnbillableConfirm(null); }}>
        <SheetContent>
          <SheetHeader><SheetTitle>Some typed amounts won&apos;t be billed</SheetTitle></SheetHeader>
          <SheetBody>
            <p className="mb-3 text-sm text-muted-foreground">
              These utilities are set to <strong>&ldquo;Tenant pays directly&rdquo;</strong>, so the tenant settles
              them with the provider and the grid never charges them. The amounts below are kept on the
              row for reference but will <strong>not</strong> appear on any invoice or Expense Bill.
              To recharge them instead, change the unit&apos;s TNB / AIR setting to
              &ldquo;Owner pays, recharge tenants&rdquo;.
            </p>
            <ul className="mb-4 space-y-2 text-sm" data-testid="unbillable-confirm-list">
              {unbillableConfirm?.map((u) => (
                <li key={u.unitCode} className="rounded border px-2 py-1.5">
                  <div className="font-mono font-medium">{u.unitCode}</div>
                  <div className="text-muted-foreground">{u.items.join(" · ")}</div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setUnbillableConfirm(null)}>Cancel</Button>
              <Button
                type="button"
                variant="gold"
                data-testid="unbillable-confirm-btn"
                onClick={() => { setUnbillableConfirm(null); continueToBill(); }}
              >
                Bill anyway
              </Button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet open={billConfirm} onOpenChange={setBillConfirm}>
        <SheetContent size="lg">
          <SheetHeader><SheetTitle>Confirm Bill</SheetTitle></SheetHeader>
          <SheetBody>
            <Callout
              variant="warning"
              title={billingDocumentsOn ? "Issue bills to the selected units?" : "Approve saved tenancy drafts?"}
            >
              {billingDocumentsOn
                ? "Confirming will create the listed saved charges and make them visible in the relevant outstanding balances."
                : "The server's grid-document rail is disabled. Only the listed saved tenancy drafts will be approved; utility, recurring and expense lines will not be issued by this action."}
            </Callout>
            <BillConfirmDetails
              rows={selectedBillableRows}
              billingPeriod={anchorMonth.slice(0, 7)}
              options={{ includeGridCharges: billingDocumentsOn, includeExpenses: billExpensesOn }}
            />
            <p className="mt-4 text-sm text-muted-foreground">
              Only saved values are included. Final documents still follow the normal server validation and paid-line protection. Cancel leaves all data saved but unbilled.
            </p>
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="gold"
              size="lg"
              data-testid="bill-confirm-btn"
              onClick={() => { setBillConfirm(false); void runBill(); }}
            >
              Confirm Bill
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={() => setBillConfirm(false)}>Cancel</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={advanceBillConfirm} onOpenChange={setAdvanceBillConfirm}>
        <SheetContent size="lg">
          <SheetHeader><SheetTitle>Confirm advance Bill</SheetTitle></SheetHeader>
          <SheetBody>
            <Callout variant="warning" title="You are billing next month in advance">
              The bill will be issued now and will appear in the tenant&apos;s outstanding balance immediately.
            </Callout>
            <BillConfirmDetails
              rows={selectedBillableRows}
              billingPeriod={anchorMonth.slice(0, 7)}
              options={{ includeGridCharges: billingDocumentsOn, includeExpenses: billExpensesOn }}
            />
            <p className="mt-4 text-sm font-semibold text-[var(--navy-text)]">
              Due date <span className="tabular-nums">{anchorMonth}</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Only saved values will be billed. Utilities without entered data will not be invented or estimated.
            </p>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" size="lg" onClick={() => setAdvanceBillConfirm(false)}>Cancel</Button>
              <Button
                type="button"
                variant="gold"
                size="lg"
                data-testid="advance-bill-confirm-btn"
                onClick={() => { setAdvanceBillConfirm(false); void runBill(); }}
              >
                Confirm advance Bill
              </Button>
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Excel-Web V2 — custom right-click context menu. Positioned at the
          pointer; every action delegates to an existing page callback (copy /
          clear-by-grain / colour / hide-column) so it adds no new money path. */}
      {ctxMenu && (
        <GridContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSelection={sel.range.length > 0}
          columnLabel={(() => {
            const col = CURRENT_COLUMNS.find((c) => c.id === ctxMenu.columnId);
            return col ? [col.band, col.header].filter(Boolean).join(" · ") : "";
          })()}
          hasAmount={contextCell?.hasAmount}
          invoiceCount={contextCell?.invoiceCount}
          receiptCount={contextCell?.receiptCount}
          onUploadInvoice={canManageDocuments ? () => openCellDocuments("invoice") : undefined}
          onUploadReceipt={canManageDocuments ? () => openCellDocuments("receipt") : undefined}
          onViewInvoice={canManageDocuments ? () => openCellDocuments("invoice") : undefined}
          onViewReceipt={canManageDocuments ? () => openCellDocuments("receipt") : undefined}
          onMarkPaid={canManageDocuments ? () => openCellDocuments("receipt") : undefined}
          onCopy={() => void handleCopy()}
          onClearContents={canEditCharges ? onDelete : undefined}
          onApplyColour={canEditCharges ? applyColourToSelection : undefined}
          onHideColumn={() => sel.hideColumn(ctxMenu.columnId)}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
