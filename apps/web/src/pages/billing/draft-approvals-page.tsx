/**
 * Draft Approvals queue page (M5 Auto-Draft Invoices).
 * Flag-gated: only reachable when ENABLE_PHASE2_AUTODRAFT is on.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileCheck, ReceiptText, Coins, LayoutGrid, CalendarClock, RefreshCw, Zap } from "lucide-react";
import {
  PageHeader,
  Surface,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { PillBar } from "@/components/ui/pill-bar";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatMoney } from "@/components/format";
import { usePermission } from "@/components/permission-gate";
import {
  DraftApprovalsTable,
  invoiceTypeMeta,
  INVOICE_TYPE_ORDER,
  type DraftInvoiceListItem,
} from "./draft-approvals-table";
import { DraftInvoiceDrawer } from "./draft-invoice-drawer";
import {
  BillingScheduleSheet,
  useDraftConfig,
  targetPeriodFor,
  formatYm,
  currentYm,
} from "./billing-schedule-sheet";

// ─── Types ────────────────────────────────────────────────────────────────────

type InvoiceListResponse = {
  items: DraftInvoiceListItem[];
  total: number;
};

/**
 * POST /billing/invoices/approve-bulk returns the ID ARRAYS, not counts — the
 * service reports exactly which ids it approved and which it skipped. Typing
 * them as numbers made the toast interpolate a comma-joined list of UUIDs, and
 * made `skipped > 0` a comparison against an array that is always false, so a
 * partially-skipped batch reported as a clean success.
 */
type BulkApproveResult = {
  approved: string[];
  skipped: string[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Period-filter options, newest first: `ahead` UPCOMING months, then the current
 * month, then `back` past ones.
 *
 * The upcoming months are not cosmetic. Under advance billing the run day drafts a
 * FUTURE period, so a past-months-only filter would hide every draft the feature
 * creates — the queue would look empty on the 25th precisely when it is fullest.
 */
function periodOptions(ahead: number, back: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = ahead; i >= -back; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// `ahead` matches BILL_PERIOD_OFFSET_MAX so the furthest schedulable period is
// always selectable.
const MONTHS = periodOptions(2, 5);

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "void", label: "Void" },
] as const;

/**
 * "Generate {month} drafts" for ONE period. Module-scoped (not nested in the
 * page) so React keeps the same element type across renders instead of
 * remounting the button on every keystroke elsewhere on the page.
 *
 * Every instance is disabled while ANY generate is in flight — two runs racing
 * on the same org would both open a draft transaction per tenancy — but only the
 * one actually running shows the spinner.
 */
function GenerateButton({
  period,
  pending,
  disabled,
  onGenerate,
  className,
}: {
  period: string;
  pending: boolean;
  disabled: boolean;
  onGenerate: (period: string) => void;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={disabled}
      onClick={() => onGenerate(period)}
    >
      {pending ? (
        <>
          <RefreshCw className="h-4 w-4 animate-spin" /> Generating…
        </>
      ) : (
        <>
          <ReceiptText className="h-4 w-4" />
          Generate {formatYm(period)} drafts
        </>
      )}
    </Button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DraftApprovalsPage() {
  const canManage = usePermission("billing.bill");
  const qc = useQueryClient();

  // Filters
  const [statusFilter, setStatusFilter] = useState<string[]>(["draft"]);
  const [periodFilter, setPeriodFilter] = useState<string[]>([]);
  // Document-type tab (Rent invoices / Owner statements / Aircon invoices).
  const [typeTab, setTypeTab] = useState<string>("all");

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Drawer
  const [drawerInvoiceId, setDrawerInvoiceId] = useState<string | null>(null);

  // Confirm dialog for BOTH issue paths — the ids being confirmed ARE the state,
  // so "Approve selected" and "Issue all" share one dialog, one mutation and one
  // success path instead of drifting into two.
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

  // Billing schedule (DraftConfig) — read-only status here, edited in the drawer.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const configQ = useDraftConfig();
  const config = configQ.data ?? null;
  const canEditSchedule = usePermission("billing.period_manage");
  // The period the NEXT SCHEDULED RUN will draft, per the org's offset (defaults
  // to next month). Distinct from `thisPeriod` on purpose — see below.
  const targetPeriod = targetPeriodFor(config);
  /**
   * The month the admin is standing in, and the DEFAULT target of Generate.
   *
   * These are two different questions and they used to share one answer. The
   * schedule's offset exists so the run day bills the COMING month (KAEN issues
   * on the 25th for the month ahead), but pointing the manual button at the same
   * period meant the current month could not be drafted at all: on 16 Aug the
   * only button on the page generated September. A tenant who moved in on the
   * 12th was never billed for August by any surface.
   */
  const thisPeriod = currentYm();

  // Build query string
  const params = new URLSearchParams();
  if (statusFilter.length === 1) params.set("status", statusFilter[0]);
  if (periodFilter.length === 1) params.set("periodMonth", periodFilter[0]);
  params.set("limit", "200");

  const INVOICE_QK = ["billing", "draft-invoices", statusFilter.join(","), periodFilter.join(",")] as const;

  const invoicesQ = useQuery({
    queryKey: INVOICE_QK,
    queryFn: () =>
      apiFetch<InvoiceListResponse>(`/billing/invoices?${params.toString()}`),
    /**
     * Changing a filter mints a NEW query key, which has no cached data — so the
     * table used to blank out to the loading skeleton and rebuild on every pill
     * click. Against an API that answers in ~400ms that reads as a full page
     * reload for what is conceptually a local narrowing.
     *
     * Keeping the previous rows on screen costs one thing that matters here:
     * `invoices` is then STALE while the new period loads, and this page issues
     * money off it. `showingStale` below is what pays that back — every issue
     * path is closed until the rows on screen are the rows the filters describe.
     */
    placeholderData: keepPreviousData,
  });

  /**
   * True while the rows on screen belong to the PREVIOUS filter. Nothing that
   * turns a draft into a receivable may run in this window: the header would
   * name one period while `issuable.ids` still holds another period's ids, and
   * the POST would be believed.
   */
  const showingStale = invoicesQ.isPlaceholderData;

  // Memoised because `?? []` mints a fresh array every render, which would make
  // every useMemo keyed on `invoices` below recompute on every render.
  const invoices = useMemo(() => invoicesQ.data?.items ?? [], [invoicesQ.data]);

  // ── Type tabs — separate Rent invoices / Owner statements / Aircon invoices ──
  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const inv of invoices) c[inv.invoiceType] = (c[inv.invoiceType] ?? 0) + 1;
    return c;
  }, [invoices]);
  const typeTabs = useMemo(
    () => [
      { value: "all", label: "All", Icon: LayoutGrid, count: invoices.length },
      ...INVOICE_TYPE_ORDER.filter((t) => typeCounts[t]).map((t) => {
        const m = invoiceTypeMeta(t);
        return { value: t as string, label: m.plural, Icon: m.Icon, count: typeCounts[t] };
      }),
    ],
    [invoices.length, typeCounts],
  );
  // Fall back to "all" if the active tab's type is no longer present after a refetch.
  const activeTab = typeTabs.some((t) => t.value === typeTab) ? typeTab : "all";
  const shown = useMemo(
    () => (activeTab === "all" ? invoices : invoices.filter((i) => i.invoiceType === activeTab)),
    [invoices, activeTab],
  );

  function selectTab(value: string) {
    setTypeTab(value);
    setSelectedIds([]); // never carry a selection across a filtered view
  }

  /**
   * The status and period pills clear the selection for the SAME reason the type
   * tab does, and they did not.
   *
   * A hand-ticked set is a list of ids, not a list of rows. Tick three August
   * drafts, then click the July pill: the ids survived into a view that no longer
   * contains them, so the bar read "3 invoice(s) selected · RM0.00" — the total
   * reduces over the rows now in view and finds none — while "Issue selected"
   * still POSTed the three August ids. They are real drafts in a valid state, so
   * approve-bulk approves them: a month the admin had navigated away from goes
   * live, priced at a total the screen showed as zero.
   *
   * Every filter that changes WHICH rows exist now clears the set.
   */
  function selectStatus(value: string[]) {
    setStatusFilter(value);
    setSelectedIds([]);
  }

  function selectPeriod(value: string[]) {
    setPeriodFilter(value);
    setSelectedIds([]);
  }

  // Metrics reflect the ACTIVE tab (amounts are MYR — formatMoney defaults to MYR).
  const pendingCount = shown.filter((i) => i.status === "draft").length;
  const totalAmount = shown.reduce((sum, i) => sum + i.totalAmount, 0);

  // ── Bulk approve ──────────────────────────────────────────────────────────

  const bulkApproveMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<BulkApproveResult>("/billing/invoices/approve-bulk", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (result) => {
      toast.success(
        `Issued ${result.approved.length} document(s)${result.skipped.length > 0 ? `, ${result.skipped.length} skipped (wrong state or changed).` : "."}`,
      );
      setConfirmIds(null);
      setSelectedIds([]);
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
    },
    onError: (err) => {
      setConfirmIds(null);
      toast.error(
        err instanceof ApiError ? err.message : "Bulk approve failed.",
      );
    },
  });

  /**
   * "Issue all" = every DRAFT row in the CURRENT VIEW — the active status/period
   * filters and the document-type tab. What you are looking at is what gets
   * issued, so the Rental-Invoices tab cannot quietly approve owner statements.
   * Already-approved rows in view are excluded: the endpoint would skip them
   * anyway, and counting them would overstate the button.
   */
  const issuable = useMemo(() => {
    const rows = shown.filter((i) => i.status === "draft");
    // ONE pass produces the ids, the money and the period spread. Two memos over
    // the same predicate could drift — a widened filter in one of them would make
    // the button's count and its stated total describe different sets.
    const byPeriod = new Map<string, { count: number; total: number }>();
    for (const r of rows) {
      const key = r.periodMonth ? r.periodMonth.slice(0, 7) : "—";
      const at = byPeriod.get(key) ?? { count: 0, total: 0 };
      at.count += 1;
      at.total += r.totalAmount;
      byPeriod.set(key, at);
    }
    return {
      ids: rows.map((r) => r.id),
      total: rows.reduce((sum, r) => sum + r.totalAmount, 0),
      // Sorted so the breakdown reads chronologically, not in row order.
      periods: [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
  }, [shown]);

  /**
   * The confirmed set is a snapshot; total it from the rows still in view.
   * Set-based, and shared with the selection bar, because the naive
   * `selectedIds.includes(...)` inside JSX is O(n·m) on EVERY render — 200×200
   * scans after a select-all, re-run on any unrelated re-render.
   */
  const totalOf = useCallback(
    (ids: string[] | null) => {
      if (!ids?.length) return 0;
      const inSet = new Set(ids);
      return invoices.reduce((sum, i) => (inSet.has(i.id) ? sum + i.totalAmount : sum), 0);
    },
    [invoices],
  );
  const confirmTotal = useMemo(() => totalOf(confirmIds), [totalOf, confirmIds]);
  const selectedTotal = useMemo(() => totalOf(selectedIds), [totalOf, selectedIds]);
  /** Only the issue-ALL path can span months; a hand-ticked set is the admin's own choice. */
  const confirmSpansMultiplePeriods =
    confirmIds !== null && confirmIds === issuable.ids && issuable.periods.length > 1;

  /**
   * The queue has no pagination and asks for limit=200, so an org with more
   * drafts than that is looking at a truncated list. Saying so is the difference
   * between "issued the month" and "issued the first 200 of the month and
   * believed it was done".
   *
   * `shownOfMatching` compares LIKE WITH LIKE. `invoices.length` is the untabbed
   * fetch, while the set being issued comes from `shown` (tab-narrowed), so
   * quoting the former beside the latter described two different populations in
   * one sentence ("shows 200 of 640 … only the 120 listed here").
   */
  const truncated = (invoicesQ.data?.total ?? 0) > invoices.length;
  const shownOfMatching = { shown: shown.length, fetched: invoices.length, total: invoicesQ.data?.total ?? 0 };

  /**
   * Why is the queue empty? Three causes that need three different answers:
   *  - no_schedule      → no DraftConfig row: nothing has EVER been generated.
   *  - nothing_drafted  → schedule exists but this period has no drafts yet.
   *  - filtered_out     → the filters genuinely exclude everything.
   *
   * `filtered_out` requires the filters to be narrower than the default view, so a
   * default landing on an ungenerated period reads as "nothing drafted", not as a
   * filter problem — that mis-attribution is what sent admins looking for drafts
   * that did not exist.
   */
  const emptyReason: "no_schedule" | "nothing_drafted" | "filtered_out" = useMemo(() => {
    if (configQ.isLoading) return "nothing_drafted";
    if (!config) return "no_schedule";
    const narrowed =
      statusFilter.length !== 1 ||
      statusFilter[0] !== "draft" ||
      (periodFilter.length === 1 && periodFilter[0] !== targetPeriod && periodFilter[0] !== currentYm());
    return narrowed ? "filtered_out" : "nothing_drafted";
  }, [configQ.isLoading, config, statusFilter, periodFilter, targetPeriod]);

  // ── Generate drafts for ONE explicit period ───────────────────────────────
  // Secondary action, never gold: Issue is this page's one primary CTA. Takes the
  // period as an argument so the same mutation serves both the current month and
  // the schedule's month; the run itself is idempotent per tenancy+period, so a
  // re-run only adds what is missing and never re-bills what exists.
  const generateMutation = useMutation({
    mutationFn: (periodMonth: string) =>
      apiFetch<{ draftsCreated: number; draftsSkipped: number }>("/billing/draft-runs", {
        method: "POST",
        body: JSON.stringify({ periodMonth }),
      }),
    onSuccess: (r, periodMonth) => {
      toast.success(
        `${formatYm(periodMonth)}: ${r.draftsCreated} draft(s) created${r.draftsSkipped > 0 ? `, ${r.draftsSkipped} already existed` : ""}.`,
      );
      // Surface the new drafts immediately, even if the filter was on another month.
      setPeriodFilter([periodMonth]);
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not generate drafts."),
  });

  /** Bound once here; declared at module scope so it is not remounted per render. */
  const generateProps = (period: string) => ({
    period,
    pending: generateMutation.isPending && generateMutation.variables === period,
    disabled: generateMutation.isPending,
    onGenerate: (p: string) => generateMutation.mutate(p),
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      <PageHeader
        compact
        icon={FileCheck}
        title="Draft Approvals"
        description="Review auto-generated draft billing documents, adjust dates, then approve."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* TWO periods, because they answer two different questions: THIS
                month is the catch-up an admin needs after a mid-month move-in,
                and the schedule's month is what the run day would have drafted
                (reachable by hand because the nightly cron is not armed in every
                environment). They collapse to one button when the org bills the
                current month anyway (billPeriodOffset 0).

                Suppressed while the "nothing drafted" empty state is showing —
                that state carries its own explained CTAs, and duplicating them
                in the header is a worse answer than one in the right place. */}
            {canManage && config && !(invoices.length === 0 && emptyReason === "nothing_drafted") && (
              <>
                <GenerateButton {...generateProps(thisPeriod)} />
                {targetPeriod !== thisPeriod && <GenerateButton {...generateProps(targetPeriod)} />}
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => setScheduleOpen(true)}>
              <CalendarClock className="h-4 w-4" />
              {config
                ? `Schedule: day ${config.runDayOfMonth}${config.isActive ? "" : " (paused)"}`
                : "Set up schedule"}
            </Button>
          </div>
        }
        metrics={[
          {
            label: "Pending drafts",
            value: String(pendingCount),
            hint: "Awaiting approval",
            icon: ReceiptText,
            glowColor: "purple",
          },
          {
            label: "Total (filtered)",
            value: formatMoney(totalAmount),
            hint: `${shown.length} document(s) in view`,
            icon: Coins,
            glowColor: "gold",
          },
          // Answers "when does this happen, and for which month" without a click —
          // the question whose absence made an empty queue unreadable.
          {
            label: "Next draft covers",
            value: config ? formatYm(targetPeriod) : "—",
            hint: config
              ? config.isActive
                ? `Drafted on day ${config.runDayOfMonth} each month`
                : "Schedule paused"
              : "No schedule yet",
            icon: CalendarClock,
            glowColor: "purple",
          },
          // WHO turns these into real bills. Standing in a queue full of drafts,
          // "does anything charge these automatically?" is the question that
          // decides whether the admin has to come back at all — and getting it
          // wrong in either direction is a money error, so it is on the surface
          // rather than one click into the schedule drawer.
          {
            label: "Billing",
            value: config?.autoBillDayOfMonth == null ? "Manual" : "Automatic",
            hint:
              config?.autoBillDayOfMonth == null
                ? "You issue drafts from this queue"
                : `From day ${config.autoBillDayOfMonth} — no click needed`,
            icon: config?.autoBillDayOfMonth == null ? ReceiptText : Zap,
            glowColor: config?.autoBillDayOfMonth == null ? "purple" : "gold",
          },
        ]}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            Status
          </p>
          {/* Single-select: GET /billing/invoices takes ONE status and ONE
              periodMonth, so picking a second pill replaces the first instead of
              silently dropping the param and showing everything. The page used to
              allow the conflicting state and then apologise for it in a warning
              banner; not offering the state is the better answer. Clicking the
              active pill clears it — that is how "all statuses" stays reachable. */}
          <PillBar
            mode="single"
            ariaLabel="Filter by status"
            options={STATUS_OPTIONS as unknown as Array<{ value: string; label: React.ReactNode }>}
            value={statusFilter}
            onChange={selectStatus}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            Period
          </p>
          <PillBar
            mode="single"
            ariaLabel="Filter by period"
            options={MONTHS.map((m) => ({ value: m, label: m }))}
            value={periodFilter}
            onChange={selectPeriod}
          />
        </div>
      </div>

      {/* Issue bar — manager+. Two ways to issue, both landing on the same
          confirm dialog:
            • SELECTIVE — tick rows, issue exactly those (per-customer issuing).
            • ALL IN VIEW — no ticking at all; issues every draft the current
              filters and tab are showing.
          The selection bar takes over once anything is ticked, so the two never
          compete for the same corner of the screen. */}
      {canManage && showingStale ? (
        /* The rows below still belong to the previous filter. Issuing is closed
           until they don't — see `showingStale`. */
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3">
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            Loading the new filter — showing the previous results. Issuing is paused.
          </span>
        </div>
      ) : canManage && selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <span className="text-sm font-medium text-amber-900 dark:text-amber-100">
            {selectedIds.length} document(s) selected · {formatMoney(selectedTotal)}
          </span>
          <Button variant="gold" size="sm" onClick={() => setConfirmIds(selectedIds)}>
            Issue selected ({selectedIds.length})
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
            Clear
          </Button>
        </div>
      ) : canManage && issuable.ids.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3">
          {/* NAMES the period. With no period filter the queue holds every month
              at once, and under advance billing that means this month's catch-up
              drafts sit beside next month's scheduled ones — "Issue all" would
              turn next month's into live receivables early with nothing on the
              button saying so. */}
          <span className="text-sm text-muted-foreground">
            {issuable.ids.length} draft(s) in view ·{" "}
            {issuable.periods.length === 1
              ? formatYm(issuable.periods[0][0])
              : `${issuable.periods.length} months`}{" "}
            · {formatMoney(issuable.total)}
          </span>
          <Button variant="gold" size="sm" onClick={() => setConfirmIds(issuable.ids)}>
            Issue all {issuable.ids.length} draft(s)
            {issuable.periods.length === 1 ? ` · ${formatYm(issuable.periods[0][0])}` : ""}
          </Button>
          <span className="text-xs text-muted-foreground">
            or tick rows to issue only some
          </span>
        </div>
      ) : null}

      <Surface
        title="Billing document queue"
        description="Grouped by document type. Click a row to open the detail drawer; use checkboxes for bulk approval."
        actions={
          invoicesQ.isLoading ? (
            <span className="text-xs text-muted-foreground">Loading…</span>
          ) : invoicesQ.isError ? (
            <span className="text-xs text-rose-600">Error loading</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {shown.length} shown{invoices.length !== shown.length ? ` of ${invoices.length}` : ""}
            </span>
          )
        }
      >
        <div className="space-y-4">
          {/* Document-type tabs — separate Rent invoices, Owner statements, Aircon. */}
          <div className="flex flex-wrap gap-1 overflow-x-auto border-b border-border/50">
            {typeTabs.map((t) => {
              const active = activeTab === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => selectTab(t.value)}
                  aria-pressed={active}
                  className={cn(
                    "relative -mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition",
                    active
                      ? "border-[#D4AF37] text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <t.Icon className="h-4 w-4" />
                  {t.label}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
                      active
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          {invoicesQ.isLoading ? (
            <div className="space-y-2 animate-pulse py-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 rounded-lg bg-muted" />
              ))}
            </div>
          ) : invoicesQ.isError ? (
            <p className="py-8 text-center text-sm text-rose-600">
              Failed to load invoices. Please refresh the page.
            </p>
          ) : invoices.length === 0 ? (
            /* A truly empty queue has three different causes, and telling them apart
               is the whole point: "no rows match your filters" sent admins hunting for
               drafts that had never been generated at all. */
            emptyReason === "no_schedule" ? (
              <EmptyState
                icon={CalendarClock}
                title="Invoice drafting isn't set up yet"
                description="No billing schedule exists, so no drafts have ever been generated. Set the run day and which month it bills to get started."
              >
                {canEditSchedule && (
                  <Button variant="gold" className="mt-4" onClick={() => setScheduleOpen(true)}>
                    <CalendarClock className="h-4 w-4" />
                    Set up billing schedule
                  </Button>
                )}
              </EmptyState>
            ) : emptyReason === "nothing_drafted" ? (
              <EmptyState
                icon={ReceiptText}
                title="Nothing drafted yet"
                description={
                  config?.isActive
                    ? `The next automatic run is day ${config.runDayOfMonth}, which drafts ${formatYm(targetPeriod)}. Generate a month now to bill it without waiting.`
                    : `The schedule is paused, so no automatic run will happen. Generate a month now — day ${config?.runDayOfMonth ?? 25} would have drafted ${formatYm(targetPeriod)}.`
                }
              >
                {canManage && (
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <GenerateButton {...generateProps(thisPeriod)} />
                    {targetPeriod !== thisPeriod && (
                      <GenerateButton {...generateProps(targetPeriod)} />
                    )}
                  </div>
                )}
              </EmptyState>
            ) : (
              <EmptyState
                icon={FileCheck}
                title="No invoices match these filters"
                description="Nothing matches the selected status and period. Widen the filters to see more."
              />
            )
          ) : (
            /* While the rows are the previous filter's, they are shown but inert:
               dimmed, aria-busy, and not interactive. Ticking a row that is about
               to be replaced would carry an id out of the view it belongs to —
               the same defect `selectStatus`/`selectPeriod` close at the other
               end. Reading stale rows is fine; acting on them is not. */
            <div
              aria-busy={showingStale}
              className={cn(
                "transition-opacity",
                showingStale && "pointer-events-none select-none opacity-50",
              )}
            >
              <DraftApprovalsTable
                invoices={shown}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onRowClick={(id) => setDrawerInvoiceId(id)}
              />
            </div>
          )}
        </div>
      </Surface>

      {/* Billing-schedule drawer — edits the same DraftConfig row as Settings. */}
      <BillingScheduleSheet
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        config={config}
        canWrite={canEditSchedule}
      />

      {/* Detail drawer */}
      <DraftInvoiceDrawer
        invoiceId={drawerInvoiceId}
        onClose={() => setDrawerInvoiceId(null)}
      />

      {/* Issue confirm dialog — shared by "Issue selected" and "Issue all". */}
      <Dialog
        open={confirmIds !== null}
        onOpenChange={(open) => !open && setConfirmIds(null)}
        lockProgress={false}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue {confirmIds?.length ?? 0} document(s)?</DialogTitle>
            <DialogDescription>
              {/* The TOTAL is the point of this dialog: issuing turns these drafts
                  into live receivables, and the amount is what makes that real. */}
              Issuing approves {confirmIds?.length ?? 0} draft document(s) totalling{" "}
              <strong>{formatMoney(confirmTotal)}</strong> and makes their charges live.
              Nothing is emailed — sending is a separate step.
            </DialogDescription>
          </DialogHeader>
          {/* Spanning more than one month is the case that turns "issue this
              month" into "also issue next month's advance drafts", so it is
              named and itemised rather than left to the total. */}
          {confirmSpansMultiplePeriods && (
            <Callout variant="warning" title="This spans more than one month">
              <ul className="space-y-0.5">
                {issuable.periods.map(([period, at]) => (
                  <li key={period}>
                    <strong>{period === "—" ? "No period" : formatYm(period)}</strong> —{" "}
                    {at.count} draft(s), {formatMoney(at.total)}
                  </li>
                ))}
              </ul>
              Under advance billing the run day drafts a FUTURE month, so issuing
              everything here can make next month's rent live early. Pick a single
              period pill to issue one month at a time.
            </Callout>
          )}
          {truncated && (
            <Callout variant="warning">
              {shownOfMatching.shown} of {shownOfMatching.total} matching invoices are
              loaded (the queue fetches at most {shownOfMatching.fetched}). Only the{" "}
              {confirmIds?.length ?? 0} listed here will be issued — narrow the filters and
              repeat for the rest.
            </Callout>
          )}
          <DialogFooter>
            <Button
              variant="gold"
              disabled={bulkApproveMutation.isPending || !confirmIds?.length}
              onClick={() => confirmIds && bulkApproveMutation.mutate(confirmIds)}
            >
              {bulkApproveMutation.isPending
                ? "Issuing…"
                : `Issue ${confirmIds?.length ?? 0} document(s)`}
            </Button>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
