// UI Task 10 — the admin screen (month selector, Categorize filter, Save,
// bulk Bill with per-row manifest toast, Export). Integration keystone: wires
// fetchGrid/saveEntry/saveReadings/billRows (ui-1) + GridTable/CURRENT_COLUMNS
// (ui-3) + useGridKeyboard (ui-4) + useStagedEdits/GridErrorBoundary (ui-9) +
// exportGridToXlsx (ui-8) together behind one toolbar (ui-10).
//
// MONEY-CRITICAL, verified below: the bulk-Bill handler locks a row ONLY when
// its own `outcome === "billed"` (never `res.ok` — the endpoint is always a
// 200 manifest, partial success is normal); the toast pluralises on the
// FAILURE count; Save collapses owner|tenant column pairs into the single
// saveEntry wire field and routes sub-row meter columns to saveReadings by
// listingId; Export receives only the post-filter VISIBLE rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import type { GridRow, GridResponse, PriorMonthStrip, BillRowResult } from "@/api/bills-grid";
import { stagedKey } from "../use-staged-edits";
import { AuthContext, type User } from "@/lib/auth";

// View preferences are mocked so display/density/hidden-column tests do not
// touch real localStorage. Fullscreen itself has since been removed.
const savePref = vi.fn();
const loadPref = vi.fn((_ns: string, _key: string, fallback: unknown) => fallback);
// ui-task-10e: (c) colour-fill is localStorage-only via loadCellColours/saveCellColours
// (view-prefs.ts). Mocked here (not exercised against real localStorage) so "colour fill
// persists" can assert the exact saveCellColours call without touching real storage;
// loadCellColours returns an empty map so useGridSelection's setColour merge starts clean.
const saveCellColours = vi.fn();
const loadCellColours = vi.fn((_ns: string) => ({}) as Record<string, string>);
vi.mock("@/lib/view-prefs", () => ({
  loadPref: (...args: [string, string, unknown]) => loadPref(...args),
  savePref: (...args: [string, string, unknown]) => savePref(...args),
  loadCellColours: (...args: [string]) => loadCellColours(...args),
  saveCellColours: (...args: [string, Record<string, string>]) => saveCellColours(...args),
}));

const fetchGrid = vi.fn();
const saveEntry = vi.fn();
const saveReadings = vi.fn();
const billRows = vi.fn();
const getBearerConfig = vi.fn();
const listExpenses = vi.fn();
const listAttachments = vi.fn();

vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    fetchGrid: (...args: unknown[]) => fetchGrid(...args),
    saveEntry: (...args: unknown[]) => saveEntry(...args),
    saveReadings: (...args: unknown[]) => saveReadings(...args),
    billRows: (...args: unknown[]) => billRows(...args),
    getBearerConfig: (...args: unknown[]) => getBearerConfig(...args),
    listExpenses: (...args: unknown[]) => listExpenses(...args),
    listAttachments: (...args: unknown[]) => listAttachments(...args),
  };
});

const exportGridToXlsx = vi.fn();
vi.mock("../export-xlsx", () => ({ exportGridToXlsx: (...args: unknown[]) => exportGridToXlsx(...args) }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import BillsGridPage from "../bills-grid-page";
import { billFailureReason, saveFailureReason } from "../bill-failure-reason";

// The Bill-action toast copy (billFailureReason). AIRCON_EXCEEDS_TNB can ONLY fire
// for a WHOLE unit — partitioned private aircond is exempt (its Σ may exceed TNB,
// excess = owner profit) — so the copy names the whole-unit cause plainly instead
// of the old ambiguous "aircon charges exceed the TNB total — check the readings".
describe("billFailureReason — aircond-vs-TNB Bill-toast copy", () => {
  const r = (code: NonNullable<BillRowResult["code"]>): BillRowResult => ({
    apartmentId: "A-11-11",
    outcome: "compute_error",
    code,
  });

  it("AIRCON_EXCEEDS_TNB tells the admin it's a whole unit and how to fix it", () => {
    const msg = billFailureReason(r("AIRCON_EXCEEDS_TNB"));
    expect(msg).toContain("whole unit");
    expect(msg).toMatch(/aircon is part of the TNB bill/i);
    expect(msg).toMatch(/lower the aircon reading|raise the TNB total/i);
  });

  it("TNB_UNDERSHOOT gives near-equal guidance without claiming whole unit", () => {
    const msg = billFailureReason(r("TNB_UNDERSHOOT"));
    expect(msg).not.toMatch(/whole unit/i);
    expect(msg).toMatch(/TNB total is just below the aircon total/i);
  });
});

// Per-unit Save/reading failure copy (saveFailureReason). handleSave reports each
// unit's own failure via Promise.allSettled, so a rejected row never hides behind a
// bare code and never masquerades as a save.
describe("saveFailureReason — per-unit Save error copy", () => {
  it("APARTMENT_NOT_FOUND explains a stale/removed unit and to refresh", () => {
    const msg = saveFailureReason("APARTMENT_NOT_FOUND");
    expect(msg).toMatch(/unit not found/i);
    expect(msg).toMatch(/refresh/i);
  });
  it("ENTRY_LOCKED names MONEY RECEIVED as the reason — not 'billed' — and points to the adjustment process", () => {
    // 2026-08-17: the server guard changed from `billedAt` to real payment, so a
    // billed-but-unpaid month is amendable. The copy must not claim being billed is the
    // reason, or an admin reads a solvable state as a dead end.
    const msg = saveFailureReason("ENTRY_LOCKED");
    expect(msg).toMatch(/money has already been received/i);
    expect(msg).not.toMatch(/billed and fully paid/i);
    expect(msg).toMatch(/adjustment/i);
  });
  it("falls back to the raw code rather than a vague message", () => {
    expect(saveFailureReason("SOME_NEW_CODE")).toBe("SOME_NEW_CODE");
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<GridRow> & { apartmentId: string; unitCode: string }): GridRow {
  return {
    propertyId: "p1",
    propertyName: "Sunway Vista",
    entryId: `${overrides.apartmentId}-entry`,
    preview: null,
    previewError: null,
    warnings: [],
    // Task 6: this fixture's single subRow is a whole-unit tenancy (mirrors
    // the pre-Task-6 default, which was inline because entry.rental was
    // non-null with exactly 1 subRow under the OLD grain-lock heuristic) —
    // `isWholeUnit: true` below re-bases that same default onto the new
    // server-derived authority field. `rental` now lives HERE, not on entry.
    subRows: [
      {
        listingId: `${overrides.apartmentId}-room-1`,
        tenancyId: `${overrides.apartmentId}-ten-1`,
        partyName: "Tenant",
        previousKwh: "100.00",
        currentKwh: "150.00",
        amount: "25.00",
        ratePerKwh: "0.5000",
        rateConfigured: true,
        rental: "1200.00",
      },
    ],
    isWholeUnit: true,
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: {
      cleaning: "80.00",
      tnbTotal: "150.00",
      airSelangor: "40.00",
      wifi: "60.00",
      maintenanceFee: "50.00",
      readingDate: null,
      paymentStatus: "unpaid",
      // OWNER-borne TNB ("absorbed") on purpose: this page suite uses tnbOwner as
      // its generic editable unit-grain anchor. Recharged TNB correctly moves the
      // input to tnbTenant (covered by cell-applicability/grid-table tests).
      tnbPattern: "absorbed",
      // OWNER-borne AIR ("absorbed") on purpose: several tests below use airOwner as a
      // convenient EDITABLE anchor cell, and since 2026-08-14 the AIR bearer decides
      // which of the two AIR columns renders (cell-applicability.ts). Tenant-borne AIR
      // would move the editable cell to airTenant and those anchors would vanish.
      airPattern: "absorbed",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      updatedAt: "2026-07-01T00:00:00.000Z",
      lockState: "draft",
    },
    bearerConfig: {
      tnbPattern: "absorbed", // see entry above
      airPattern: "absorbed", // see entry above
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "80.00",
      isLocked: false,
    },
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [],
    ...overrides,
  };
}

function gridResponse(rows: GridRow[], periods: string[] = ["2026-07-01"]): GridResponse {
  return { period: periods[0], periods, rows };
}

// ui-task-10f: a row with a distinct, controllable `tnbTotal` value (and
// optional `billedAt`) — the ctrl-fill tests need several unbilled apartments
// with DIFFERENT starting values so a fill's write is unambiguous. Task 6:
// this used to vary `rental` (the generic "any editable unit-grain money
// column" test target) — rental is now read-only/removed from Save, so these
// generic editable-cell mechanics (drag-select/ctrl-fill/colour-fill/hide-
// column) are retargeted onto owner-borne `tnbOwner`/`tnbTotal`, structurally
// identical (unit-grain, editable, numeric, direct-wire SaveEntryInput field).
function tnbRow(apartmentId: string, unitCode: string, tnbTotal: string, billedAt: string | null = null): GridRow {
  return makeRow({
    apartmentId,
    unitCode,
    billedAt,
    entry: {
      cleaning: "80.00",
      tnbTotal,
      airSelangor: "40.00",
      wifi: "60.00",
      maintenanceFee: "50.00",
      readingDate: null,
      paymentStatus: "unpaid",
      tnbPattern: "absorbed",
      airPattern: "absorbed", // see makeRow above
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      updatedAt: "2026-07-01T00:00:00.000Z",
      lockState: "draft",
    },
  });
}

// SettingDrawer/ExpensesDialog/AttachmentsPanel (mounted from ui-10c) all call
// useAuth() unconditionally (SettingDrawer is always-mounted, just closed) —
// house pattern per month-cockpit.test.tsx: wrap with a real AuthContext
// rather than mocking @/lib/auth wholesale. role: "manager" so none of the
// manager-gated affordances are hidden by the auth check itself.
const TEST_USER: User = {
  id: "u1",
  fullName: "Admin",
  email: "a@x.test",
  role: "manager",
  orgId: "org-1",
  // The production UI is capability-based. Keep this integration fixture explicit so
  // the suite tests the billing controls instead of accidentally hiding them because
  // an old role-only fixture omitted the resolved permission list.
  permissions: [
    "cost.view",
    "billing.charge.edit",
    "billing.save",
    "billing.bill",
    "billing.export",
    "billing.document_manage",
    "management_fee.configure",
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={{ user: TEST_USER, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <MemoryRouter initialEntries={["/billing/tenant-owner-billing"]}>
          <BillsGridPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

/**
 * Bill is now selection-gated: the button is disabled until at least one unit
 * is checked. This clicks the header select-all (checks every billable unit),
 * then clicks Bill. After selection the button reads "Bill (N)", so it is
 * matched on the `/^bill/i` prefix rather than the exact `/^bill$/i`.
 */
function selectAllAndBill() {
  fireEvent.click(screen.getByTestId("bill-select-all"));
  fireEvent.click(screen.getByRole("button", { name: /^bill/i }));
  const confirm = screen.queryByTestId("bill-confirm-btn");
  if (confirm) fireEvent.click(confirm);
}

beforeEach(() => {
  fetchGrid.mockReset();
  saveEntry.mockReset();
  saveReadings.mockReset();
  billRows.mockReset();
  exportGridToXlsx.mockReset();
  getBearerConfig.mockReset();
  listExpenses.mockReset();
  listAttachments.mockReset();
  savePref.mockClear();
  loadPref.mockClear();
  saveCellColours.mockClear();
  loadCellColours.mockClear();
  // Defaults so an on-demand surface that DOES get opened resolves cleanly;
  // individual tests override with a specific fixture-matching value.
  getBearerConfig.mockResolvedValue({
    apartmentId: "apt-1",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "80.00",
    isLocked: false,
    updatedAt: null,
  });
  listExpenses.mockResolvedValue({ items: [], total: "0.00" });
  listAttachments.mockResolvedValue({ items: [] });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BillsGridPage", () => {
  it("renders the H1 'Tenant & Owner Billing'", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Tenant & Owner Billing" })).toBeInTheDocument();
  });

  it("month selector", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })], ["2026-07-01", "2026-06-01"]),
    );
    renderPage();

    // fresh mount → exactly 1 month (latest) selected
    await waitFor(() => {
      expect(screen.getByTestId("period-chip-2026-07-01")).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByTestId("period-chip-2026-06-01")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByTestId("selected-period")).toHaveLength(1);

    // adding June widens July-leftmost, June-right
    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));

    await waitFor(() => {
      const selected = screen.getAllByTestId("selected-period");
      expect(selected).toHaveLength(2);
      expect(selected[0]).toHaveTextContent("2026-07-01");
      expect(selected[1]).toHaveTextContent("2026-06-01");
    });
  });

  it("billing-month navigator: next month allows confirmed advance Bill; farther months stay gated", async () => {
    // Server answers with whatever anchor was asked for; the FIRST (default,
    // param-less) call defines the current month = 2026-07-01.
    fetchGrid.mockImplementation((params?: { period?: string }) => {
      const period = params?.period ?? "2026-07-01";
      return Promise.resolve(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })], [period]));
    });
    renderPage();
    await screen.findByText("A-1");

    // On the current month: no "Jump to current", and the period is billable.
    await waitFor(() => {
      expect(screen.getByTestId("anchor-status-pill")).toHaveTextContent("Current");
    });
    expect(screen.queryByTestId("anchor-jump-current")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bill-period-locked")).not.toBeInTheDocument();

    // Navigate forward to August → refetch for that exact anchor (single month).
    fireEvent.change(screen.getByTestId("anchor-month-input"), { target: { value: "2026-08" } });
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledWith({ period: "2026-08-01", months: 1 });
    });

    // The immediately following month is Upcoming but eligible for advance Bill.
    await waitFor(() => {
      expect(screen.getByTestId("anchor-status-pill")).toHaveTextContent("Upcoming");
    });
    expect(screen.queryByTestId("bill-period-locked")).not.toBeInTheDocument();
    billRows.mockResolvedValue({ results: [{ apartmentId: "apt-1", outcome: "invoiced" }] });
    fireEvent.click(screen.getByTestId("bill-select-apt-1"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (1)" }));
    expect(await screen.findByRole("heading", { name: "Confirm advance Bill" })).toBeInTheDocument();
    const advanceUnits = screen.getByTestId("bill-confirm-units");
    expect(within(advanceUnits).getByRole("heading", { name: "A-1" })).toBeInTheDocument();
    expect(advanceUnits).toHaveTextContent("Property Short Form + Unit Number");
    expect(screen.getByText(/Due date/)).toHaveTextContent("2026-08-01");
    expect(billRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("advance-bill-confirm-btn"));
    await waitFor(() => expect(billRows).toHaveBeenCalledWith(expect.objectContaining({ period: "2026-08-01" })));

    // Two months ahead is preparation-only and remains blocked.
    fireEvent.change(screen.getByTestId("anchor-month-input"), { target: { value: "2026-09" } });
    await waitFor(() => expect(fetchGrid).toHaveBeenCalledWith({ period: "2026-09-01", months: 1 }));
    expect(screen.getByTestId("bill-period-locked")).toBeInTheDocument();

    // Jump-to-current still returns to July.
    fireEvent.click(screen.getByTestId("anchor-jump-current"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledWith({ period: "2026-07-01", months: 1 });
    });
  }, 15_000);

  it("property filter", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1", propertyId: "p1", propertyName: "Sunway Vista" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2", propertyId: "p1", propertyName: "Sunway Vista" }),
        makeRow({ apartmentId: "apt-3", unitCode: "B-1", propertyId: "p2", propertyName: "Impiana Residency" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    expect(screen.getByText("A-2")).toBeInTheDocument();
    expect(screen.getByText("B-1")).toBeInTheDocument();

    // mounts "All"
    const select = screen.getByLabelText("Categorize") as HTMLSelectElement;
    expect(select.value).toBe("all");
    const options = within(select).getAllByRole("option");
    expect(options[0]).toHaveTextContent("All");

    // Fix (final review): Categorize shows the property NAME, not the raw
    // propertyId UUID — and the dropdown value the option carries is still
    // the id (filtering below still targets it), deduped across the two
    // p1 rows.
    const optionLabels = options.slice(1).map((o) => o.textContent);
    expect(optionLabels).toEqual(["Impiana Residency", "Sunway Vista"]);
    const p1Option = options.find((o) => (o as HTMLOptionElement).value === "p1") as HTMLOptionElement;
    expect(p1Option).toHaveTextContent("Sunway Vista");

    // selecting a propertyId scopes visible rows — filtering is still BY ID.
    fireEvent.change(select, { target: { value: "p1" } });

    await waitFor(() => {
      expect(screen.queryByText("B-1")).not.toBeInTheDocument();
    });
    expect(screen.getByText("A-1")).toBeInTheDocument();
    expect(screen.getByText("A-2")).toBeInTheDocument();
  });

  it("save is explicit", async () => {
    // Task 6: rental is read-only now — this exercises the same
    // explicit-Save-not-auto-save mechanic against tnbOwner instead (still
    // editable, direct-wire like rental used to be).
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();

    await screen.findByText("A-1");
    const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");

    fireEvent.change(tnbInput, { target: { value: "1500" } });
    fireEvent.blur(tnbInput);
    // The page has NO timer-based auto-save (Save is an explicit button
    // click; there is no debounce/setTimeout wired to blur) — proving "blur
    // alone issues no request" only needs a deterministic flush of whatever
    // micro/macrotasks blur queued, not a fake clock advance. A short real
    // macrotask flush is deterministic under CPU contention in a way
    // fake-timers + advanceTimersByTimeAsync is not: that combination races
    // real promises scheduled by React/react-query under load and flaked
    // ~1-in-4 runs under vitest's default parallel file execution.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(saveEntry).not.toHaveBeenCalled();

    // Save is a distinct control from Bill
    const saveButton = screen.getByRole("button", { name: /^save/i });
    const billButton = screen.getByRole("button", { name: /^bill$/i });
    expect(saveButton).not.toBe(billButton);

    // De-flake: the earlier change+blur stages asynchronously (React state
    // update), so a click that races ahead of it can find dirtyCount still 0
    // and no-op the Save (saveEntry never called — a ~1-in-16 flake under
    // parallel load). Wait for the edit to actually register — the button's
    // own "Save (N)" label is the staged-count signal — BEFORE clicking.
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));

    fireEvent.click(saveButton);
    // Task 3 (P1): Save now opens a confirmation dialog first — Confirm
    // delegates to the unchanged persist path exercised below.
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => {
      expect(saveEntry).toHaveBeenCalledTimes(1);
    });
    expect(saveEntry).toHaveBeenCalledWith(
      "apt-1",
      expect.objectContaining({ period: "2026-07-01", tnbTotal: "1500" }),
    );
  });

  // MONEY: the staged buffer is restored from sessionStorage verbatim, so it can
  // carry cellKeys for apartments that no longer exist (unit deleted elsewhere,
  // DB reset, restored crash-recovery snapshot). translateStaged used the
  // unit-grain cellKey AS the apartmentId with no existence check — unlike the
  // meter branch right above it, which has always dropped an unknown listingId —
  // so a phantom apartment became a real saveEntry call.
  it("never fires a saveEntry for a staged apartmentId that is not in rows", async () => {
    sessionStorage.setItem(
      stagedKey("2026-07-01"),
      JSON.stringify({ "apt-GONE:tnbOwner": "300", "apt-1:tnbOwner": "1500" }),
    );
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();

    await screen.findByText("A-1");
    const saveButton = screen.getByRole("button", { name: /^save/i });
    // Same de-flake the "save is explicit" test documents above: the restored
    // buffer registers asynchronously (period settles after the grid fetch), so
    // a click that races ahead finds dirtyCount 0 and no-ops the Save. The
    // button's own "Save (N)" label is the staged-count signal — wait on it.
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (2)"));

    fireEvent.click(saveButton);
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    // The live unit still saves — a stale sibling key must not block real work.
    expect(saveEntry).toHaveBeenCalledWith("apt-1", expect.objectContaining({ tnbTotal: "1500" }));
    expect(saveEntry.mock.calls.map((c: unknown[]) => c[0])).not.toContain("apt-GONE");

    // Leave no staged key behind — this file's sessionStorage is shared across
    // its tests and beforeEach does not clear it.
    sessionStorage.removeItem(stagedKey("2026-07-01"));
  });

  // MONEY (review finding 2, 2026-08-14): the owner|tenant column pairs collapse to ONE
  // wire field, so a value staged on the side the bearer setting has since hidden is
  // invisible on screen yet still reaches Save. Reachable path: stage an AIR amount while
  // the unit is owner-borne, open the Unit setting drawer and switch AIR to Tenant — the
  // drawer invalidates the grid query but never clears the staged buffer — then Save. The
  // admin reads the Tenant cell (seeded from the SAVED entry) and writes the stale staged
  // number instead. Same guard family as the phantom-apartment drop above: what the admin
  // cannot see, Save must not write. Pre-existing for cleaning/wifi, whose columns have
  // always switched; the AIR fix made it reachable there too.
  it("never saves a staged edit on a column the bearer setting has since hidden", async () => {
    const base = makeRow({ apartmentId: "apt-1", unitCode: "A-1" });
    const tenantBorneAir = {
      ...base,
      entry: { ...base.entry!, airPattern: "recharged", airSelangor: "30.00" },
      bearerConfig: { ...base.bearerConfig, airPattern: "recharged" },
    };
    sessionStorage.setItem(
      stagedKey("2026-07-01"),
      JSON.stringify({ "apt-1:airOwner": "40", "apt-1:tnbOwner": "1500" }),
    );
    fetchGrid.mockResolvedValue(gridResponse([tenantBorneAir]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();

    await screen.findByText("A-1");
    // The Owner cell is inapplicable, so the admin sees no AIR value on that side at all.
    expect(within(screen.getAllByTestId("cell-airOwner")[0]).queryByRole("textbox")).toBeNull();

    const saveButton = screen.getByRole("button", { name: /^save/i });
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (2)"));
    fireEvent.click(saveButton);
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    const [, patch] = saveEntry.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch).not.toHaveProperty("airSelangor"); // the invisible 40 is dropped
    expect(patch).toMatchObject({ tnbTotal: "1500" }); // real work still saves

    sessionStorage.removeItem(stagedKey("2026-07-01"));
  });

  // The guard above drops the edit from the WIRE. These two pin that it is never dropped
  // SILENTLY — the first version reported "Saved." and wiped the buffer, so an amount the
  // Confirm dialog had just promised to write vanished with no signal anywhere.
  it("tells the admin which staged cells the bearer setting has made unsavable", async () => {
    const base = makeRow({ apartmentId: "apt-1", unitCode: "A-1" });
    const tenantBorneAir = {
      ...base,
      entry: { ...base.entry!, airPattern: "recharged", airSelangor: "30.00" },
      bearerConfig: { ...base.bearerConfig, airPattern: "recharged" },
    };
    sessionStorage.setItem(
      stagedKey("2026-07-01"),
      JSON.stringify({ "apt-1:airOwner": "40", "apt-1:tnbOwner": "1500" }),
    );
    fetchGrid.mockResolvedValue(gridResponse([tenantBorneAir]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();

    await screen.findByText("A-1");
    const saveButton = screen.getByRole("button", { name: /^save/i });
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (2)"));
    fireEvent.click(saveButton);

    // The dialog must not present the dropped cell as something it is about to write.
    const list = await screen.findByTestId("save-confirm-list");
    expect(within(list).getByTestId("save-confirm-skipped-airOwner")).toHaveTextContent(/won't be saved/i);
    // The savable sibling is still listed plainly.
    expect(within(list).queryByTestId("save-confirm-skipped-tnbOwner")).toBeNull();

    sessionStorage.removeItem(stagedKey("2026-07-01"));
  });

  it("says so instead of no-oping when EVERY staged edit is on a hidden side", async () => {
    const base = makeRow({ apartmentId: "apt-1", unitCode: "A-1" });
    const tenantBorneAir = {
      ...base,
      entry: { ...base.entry!, airPattern: "recharged", airSelangor: "30.00" },
      bearerConfig: { ...base.bearerConfig, airPattern: "recharged" },
    };
    sessionStorage.setItem(stagedKey("2026-07-01"), JSON.stringify({ "apt-1:airOwner": "40" }));
    fetchGrid.mockResolvedValue(gridResponse([tenantBorneAir]));
    renderPage();

    await screen.findByText("A-1");
    const saveButton = screen.getByRole("button", { name: /^save/i });
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
    fireEvent.click(saveButton);
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    // No request, and the admin is TOLD — the bare `return` left "Save (1)" lit with the
    // unload guard armed and no explanation, so the button looked simply broken.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(saveEntry).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)![0])).toMatch(/nothing to save/i);

    sessionStorage.removeItem(stagedKey("2026-07-01"));
  });

  // This file's shared fixtures pin AIR owner-borne so `airOwner` stays the editable
  // anchor its selection/nav tests rely on — but tenant-borne is the SEEDED DEFAULT for
  // both listing modes, so that is the configuration most production units are actually
  // in. One page-level test runs the real default end to end.
  it("saves the water bill typed into the Tenant column on a default (tenant-borne) unit", async () => {
    const base = makeRow({ apartmentId: "apt-1", unitCode: "A-1" });
    const defaultUnit = {
      ...base,
      entry: { ...base.entry!, airPattern: "recharged", airSelangor: "30.00" },
      bearerConfig: { ...base.bearerConfig, airPattern: "recharged" },
    };
    fetchGrid.mockResolvedValue(gridResponse([defaultUnit]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();

    await screen.findByText("A-1");
    const airTenantInput = within(screen.getAllByTestId("cell-airTenant")[0]).getByRole("textbox");
    expect(airTenantInput).toHaveValue("30.00"); // seeded from the same wire field

    fireEvent.change(airTenantInput, { target: { value: "45" } });
    fireEvent.blur(airTenantInput);

    const saveButton = screen.getByRole("button", { name: /^save/i });
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
    fireEvent.click(saveButton);
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    // Both AIR columns collapse to the SAME wire field — typing on the tenant side must
    // reach `airSelangor` exactly as the owner side always did.
    expect(saveEntry).toHaveBeenCalledWith("apt-1", expect.objectContaining({ airSelangor: "45" }));
  });

  it("honors a cleared meter reading instead of reverting to the old value", async () => {
    // Meter readings belong to partitioned-room rows. Whole-unit rows correctly
    // render Previous/Current/Amount as non-applicable locked cells.
    fetchGrid.mockResolvedValue(gridResponse([makeRow({
      apartmentId: "apt-1",
      unitCode: "A-1",
      isWholeUnit: false,
    })]));
    saveReadings.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText("A-1");
    const roomRow = screen.getByTestId("tenant-sub-row");
    const previousKwhInput = within(roomRow).getByTestId("cell-previousKwh").querySelector("input")!;
    fireEvent.change(previousKwhInput, { target: { value: "" } });
    fireEvent.blur(previousKwhInput);

    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    // Task 3 (P1): confirm the dialog before the write.
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => {
      expect(saveReadings).toHaveBeenCalledTimes(1);
    });
    // Task 6 (B6, money-critical): the reading payload carries previousKwh
    // and currentKwh but NEVER `amount` — amount is server-derived
    // (round2((current-previous)*ratePerKwh)); saveReadingsSchema itself no
    // longer accepts the field (packages/shared/src/schemas/bills-grid.ts).
    const [, , sentReadings] = saveReadings.mock.calls[0];
    expect(sentReadings[0]).toEqual(
      expect.objectContaining({
        listingId: "apt-1-room-1",
        previousKwh: null,
        currentKwh: "150.00",
      }),
    );
    expect(sentReadings[0]).not.toHaveProperty("amount");
  });

  it('"Save omits amount/rental" (Task 6, B6+B7, money-critical): a Current-kwh edit\'s saveReadings body has no "amount" key and saveEntry never carries "rental"', async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({
      apartmentId: "apt-1",
      unitCode: "A-1",
      isWholeUnit: false,
    })]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    saveReadings.mockResolvedValue({ results: [] });
    renderPage();

    await screen.findByText("A-1");
    // Stage an edit on a column that DOES still translate to saveEntry
    // (tnbOwner) AND a meter edit (currentKwh) so both call sites fire.
    const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
    fireEvent.change(tnbInput, { target: { value: "999" } });
    const roomRow = screen.getByTestId("tenant-sub-row");
    const currentKwhInput = within(roomRow).getByTestId("cell-currentKwh").querySelector("input")!;
    fireEvent.change(currentKwhInput, { target: { value: "200" } });

    await waitFor(() => expect(screen.getByRole("button", { name: /^save/i })).toHaveTextContent("Save (2)"));
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    // Task 3 (P1): confirm the dialog before the write.
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => {
      expect(saveEntry).toHaveBeenCalledTimes(1);
      expect(saveReadings).toHaveBeenCalledTimes(1);
    });

    const [, entryPatch] = saveEntry.mock.calls[0];
    expect(entryPatch).not.toHaveProperty("rental");

    const [, , sentReadings] = saveReadings.mock.calls[0];
    expect(sentReadings[0]).not.toHaveProperty("amount");
    expect(sentReadings[0]).toEqual(expect.objectContaining({ currentKwh: "200" }));
  });

  it("Save partial failure (allSettled, not Promise.all): fires ALL calls, reports each failed unit honestly + credits the saved ones, never a false 'Saved.'", async () => {
    fetchGrid.mockResolvedValue(gridResponse([
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
    ]));
    // apt-1 saves; apt-2 rejects with a raw server code. The OLD Promise.all would have
    // shown a blanket "APARTMENT_NOT_FOUND" and hidden that apt-1 had already saved.
    saveEntry.mockImplementation((aptId: string) =>
      aptId === "apt-2"
        ? Promise.reject(new Error("APARTMENT_NOT_FOUND"))
        : Promise.resolve({ id: "e", updatedAt: "2026-07-02T00:00:00.000Z" }));
    saveReadings.mockResolvedValue({ results: [] });
    renderPage();

    await screen.findByText("A-1");
    fireEvent.change(within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox"), { target: { value: "111" } });
    fireEvent.change(within(screen.getAllByTestId("cell-tnbOwner")[1]).getByRole("textbox"), { target: { value: "222" } });

    await waitFor(() => expect(screen.getByRole("button", { name: /^save/i })).toHaveTextContent("Save (2)"));
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => {
      expect(saveEntry).toHaveBeenCalledTimes(2); // BOTH fired — not short-circuited on the first rejection
      expect(toast.error).toHaveBeenCalled();
    });
    const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
    expect(title).toMatch(/Saved 1 unit/);        // credits the row that saved…
    expect(title).toMatch(/1 couldn't save/);     // …while naming the count that failed
    expect((opts as { description: string }).description).toMatch(/A-2: unit not found/i);
    expect(toast.success).not.toHaveBeenCalled(); // never a false success on partial failure
  });

  it("toasts when Bill's billRows call rejects", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    billRows.mockRejectedValue(new Error("network"));
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
  }, 15_000);

  it("guards Save against writing while the grid shows a placeholder (stale) period", async () => {
    // FINDING (ui-10c fix, Part A investigation): the ORIGINAL version of
    // this test only WIDENED the fetch window (added June while July stayed
    // periods[0] / selectedPeriods[0]) and asserted that in-flight window
    // blocked Save via `isPlaceholderData`. Under the corrected invariant
    // (`showingStalePeriod = currentPeriod !== lastGood.period`) that exact
    // scenario is DELIBERATELY no longer "stale" — the requested period
    // never actually changed (`toggledDesc` always keeps the latest period
    // at index 0, so adding an older month can never move
    // `selectedPeriods[0]`), so `currentPeriod` stays equal to
    // `lastGood.period` throughout and a months-only refetch must NOT block
    // Save (this is the exact "does not false-block a same-period
    // months-change refetch" case the fix brief calls out). Verified
    // empirically: re-running the old scenario against the new invariant
    // makes `saveReadings` fire (guard no longer trips) — the old test was
    // unknowingly exercising an over-broad guard, not a genuine period race.
    //
    // Reproducing REAL staleness needs an actual period SWITCH (not a
    // widen): select June (widen to July+June), THEN deselect July, leaving
    // ONLY June selected, while June's own fetch is still pending —
    // `lastGood.period` lags at "2026-07-01" until that fetch resolves,
    // while `currentPeriod` is already "2026-06-01". Deselecting July must
    // happen SECOND (leaving a non-empty selection at every step): the page
    // has a default-select effect (`if (selectedPeriods.length === 0 &&
    // periods.length > 0) setSelectedPeriods([periods[0]])`) that silently
    // RESTORES July the instant the selection would go empty — deselecting
    // July first (when it's the only selected period) round-trips right
    // back to July-only before the next click, so the click sequence must
    // never pass through zero selected periods.
    // `useStagedEdits` is period-keyed, so an edit staged for July is
    // dropped the instant `currentPeriod` becomes June; the only way to get
    // `dirtyCount > 0` in a genuinely stale window is to seed June's OWN
    // staged-edits storage directly — simulating a user who staged an edit
    // for June in an earlier session and returns to it while June's fetch
    // is still racing.
    const rows = [makeRow({ apartmentId: "apt-1", unitCode: "A-1" })];
    sessionStorage.setItem(stagedKey("2026-06-01"), JSON.stringify({ "apt-1-room-1:previousKwh": "999" }));
    fetchGrid.mockResolvedValueOnce(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
    // The widen fetch is ALSO a manually-controlled deferred promise (not
    // mockResolvedValueOnce) so the test can explicitly resolve it inside an
    // `act()` and be certain its full resolution → query-state-update →
    // re-render chain has landed before the next click — a bare `waitFor` on
    // the call count is not a reliable signal here (the queryFn is invoked
    // SYNCHRONOUSLY when the queryKey changes, so the call-count assertion
    // can already be true before the promise itself has even settled).
    let resolveWiden: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveWiden = resolve;
      }),
    );
    let resolveJuneFetch: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveJuneFetch = resolve;
      }),
    );
    renderPage();

    await screen.findByText("A-1");
    // Settle the page's cascading default-select effect first — see the
    // identical comment in the ui-10c surface-guard tests below for why this
    // is required before the first period-chip click.
    await waitFor(() => {
      expect(screen.getByTestId("period-chip-2026-07-01")).toHaveAttribute("aria-pressed", "true");
    });

    // widen to July+June first …
    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(2);
    });
    // … resolve it and let every resulting microtask (state update,
    // notifyManager, re-render) fully settle before the next click …
    await act(async () => {
      resolveWiden?.(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // … THEN narrow to June-only — the genuine period switch; its fetch is
    // the deferred one queued above, so it stays pending through the Save click.
    fireEvent.click(screen.getByTestId("period-chip-2026-07-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(3);
    });

    // June's fetch is still pending → lastGood.period is still "2026-07-01"
    // while currentPeriod is now "2026-06-01": genuinely stale, and June's
    // seeded staged edit gives dirtyCount > 0 (Save enabled).
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    // Save only OPENS the confirm dialog (Task 3); the write itself is only
    // ATTEMPTED on Confirm — must click through so `handleSave`'s
    // `showingStalePeriod` guard is actually exercised, not bypassed.
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    expect(saveReadings).not.toHaveBeenCalled();
    expect(saveEntry).not.toHaveBeenCalled();

    // let the deferred fetch resolve so the test doesn't leave a dangling query
    resolveJuneFetch?.(gridResponse(rows, ["2026-06-01"]));
    sessionStorage.removeItem(stagedKey("2026-06-01"));
  });

  it("rule 3: rebill_confirmation_required opens the confirm modal (with invoice numbers) and Confirm re-Bills with confirmRebill", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    // First Bill click → server asks for confirmation (existing live invoices).
    billRows.mockResolvedValueOnce({
      results: [{ apartmentId: "apt-1", outcome: "rebill_confirmation_required", existingTenantInvoiceNumber: "IVTEN-0004", existingOwnerInvoiceNumber: "IVOWN-0006" }],
    });
    renderPage();
    await screen.findByText("A-1");
    selectAllAndBill();

    // The confirm-void-and-reissue modal appears, naming the invoices to be voided.
    await screen.findByTestId("rebill-confirm-list");
    expect(screen.getByText(/IVTEN-0004/)).toBeInTheDocument();
    expect(screen.getByText(/IVOWN-0006/)).toBeInTheDocument();

    // Confirm → Bill is re-called with confirmRebill:true for that row.
    billRows.mockResolvedValueOnce({ results: [{ apartmentId: "apt-1", outcome: "reinvoiced" }] });
    fireEvent.click(screen.getByTestId("rebill-confirm-btn"));
    await waitFor(() => {
      const lastArgs = billRows.mock.calls.at(-1)![0] as { rows: Array<{ confirmRebill?: boolean }> };
      expect(lastArgs.rows[0].confirmRebill).toBe(true);
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("billed n of m", async () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      makeRow({ apartmentId: `apt-${i + 1}`, unitCode: `A-${i + 1}` }),
    );
    const billedIds = rows.slice(0, 8).map((r) => r.apartmentId);
    const failedOutcomes = ["stale", "compute_error", "no_entry"];
    fetchGrid.mockResolvedValueOnce(gridResponse(rows));
    billRows.mockResolvedValue({
      results: rows.map((r, i) => ({
        apartmentId: r.apartmentId,
        outcome: billedIds.includes(r.apartmentId) ? "billed" : failedOutcomes[i - 8],
      })),
    });
    // Keep the post-Bill response available for every invalidation/refetch;
    // a one-shot second value made a later refresh resolve `undefined`.
    fetchGrid.mockResolvedValue(
      gridResponse(
        rows.map((r) =>
          billedIds.includes(r.apartmentId)
            ? { ...r, billedAt: "2026-07-15T00:00:00.000Z", paymentStatus: "paid" }
            : r,
        ),
      ),
    );
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Header is the toast title; the per-unit reasons ride in sonner's `description`.
    // The server forwards a stable code for compute/issuance failures; the FE maps
    // outcome+code → a human, ACTIONABLE reason.
    {
      const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
      const desc = String((opts as { description?: unknown } | undefined)?.description ?? "");
      expect(String(title)).toContain("Billed 8 of 11 — 3 need attention");
      expect(desc).toContain("A-9: changed since you loaded it");
      expect(desc).toContain("A-10: utility amounts");
      expect(desc).toContain("A-11: nothing saved");
    }
    // StatusPill normalizes its visible label to sentence case. Scope this to
    // the row payment pills so per-cell settlement screen-reader text cannot
    // accidentally affect the manifest count.
    await waitFor(() => {
      const labels = screen.getAllByTestId("entry-payment-pill").map((pill) => pill.textContent);
      expect(labels.filter((label) => label === "Paid")).toHaveLength(8);
      expect(labels.filter((label) => label === "Unpaid")).toHaveLength(3);
    });
  }, 15_000);

  it("export wiring", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1", propertyId: "p1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2", propertyId: "p1" }),
        makeRow({ apartmentId: "apt-3", unitCode: "B-1", propertyId: "p2" }),
      ]),
    );
    exportGridToXlsx.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText("A-1");
    fireEvent.change(screen.getByLabelText("Categorize"), { target: { value: "p1" } });
    await waitFor(() => expect(screen.queryByText("B-1")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export entire data (Excel)" }));

    await waitFor(() => expect(exportGridToXlsx).toHaveBeenCalledTimes(1));
    const [exportedRows] = exportGridToXlsx.mock.calls[0];
    expect(exportedRows).toHaveLength(2);
    expect(exportedRows.map((r: GridRow) => r.apartmentId).sort()).toEqual(["apt-1", "apt-2"]);
  });

  it("billed none", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      makeRow({ apartmentId: "apt-3", unitCode: "A-3" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-1", outcome: "stale" },
        { apartmentId: "apt-2", outcome: "compute_error" },
        { apartmentId: "apt-3", outcome: "no_entry" },
      ],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    {
      const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
      const desc = String((opts as { description?: unknown } | undefined)?.description ?? "");
      expect(String(title)).toContain("Billed 0 of 3 — 3 need attention");
      expect(desc).toContain("A-1: changed since you loaded it");
      expect(desc).toContain("A-2: utility amounts");
      expect(desc).toContain("A-3: nothing saved");
    }
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("entry-payment-pill")).toHaveLength(3);
    for (const pill of screen.getAllByTestId("entry-payment-pill")) {
      expect(pill).toHaveTextContent("Unpaid");
    }
  });

  it("un-checks the units that billed, and leaves the failed one checked", async () => {
    // Reported: after a successful Bill the row stayed ticked.
    //
    // Nothing ever cleared `selectedForBill` — the un-check was implicit, relying on the
    // billed row dropping out of `billableRows` on the refetch. It does not drop out: a
    // billed-but-unpaid row is still amendable (R7), and with partial re-Bill on, a SETTLED
    // row is deliberately kept billable too. So the tick simply survived, and the next Bill
    // click would silently re-bill the same unit.
    //
    // A failed row must stay checked — that is the documented retry affordance.
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-1", outcome: "billed" },
        { apartmentId: "apt-2", outcome: "stale" },
      ],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId("bill-select-apt-1")).toHaveAttribute("aria-checked", "false");
    });
    expect(screen.getByTestId("bill-select-apt-2")).toHaveAttribute("aria-checked", "true");
  });

  it("billed plural", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      makeRow({ apartmentId: "apt-3", unitCode: "A-3" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-1", outcome: "billed" },
        { apartmentId: "apt-2", outcome: "billed" },
        { apartmentId: "apt-3", outcome: "stale" },
      ],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    {
      const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
      const desc = String((opts as { description?: unknown } | undefined)?.description ?? "");
      expect(String(title)).toContain("Billed 2 of 3 — 1 needs attention");
      expect(desc).toContain("A-3: changed since you loaded it");
    }
  });

  // Bug fix: a tenant-bearer GridExpense with an unresolvable tenancy previously killed
  // the WHOLE unit's Bill with a generic "couldn't issue the invoice" message. The mint
  // resolver now falls back gracefully in most cases, but when it's genuinely
  // unattributable the admin needs an ACTIONABLE reason, not the generic fallback.
  it("save_failed with EXPENSE_TENANT_UNRESOLVED shows the tenant-linking reason", async () => {
    const rows = [makeRow({ apartmentId: "apt-1", unitCode: "A-1" })];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [{ apartmentId: "apt-1", outcome: "save_failed", code: "EXPENSE_TENANT_UNRESOLVED" }],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
    const desc = String((opts as { description?: unknown } | undefined)?.description ?? "");
    expect(desc).toContain("a tenant expense isn't linked to a tenant");
  });

  // Regression: with ENABLE_PHASE2_BILLING_DOCS on, a successful Bill mints
  // invoices and returns `invoiced` (first issuance) or `reinvoiced` (re-Bill
  // supersede) — NOT the legacy `billed`. Both stamp billedAt and must count as
  // success, else every real invoiced Bill mis-reports "N needs attention".
  it("counts invoiced + reinvoiced outcomes as success (no false 'needs attention')", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-1", outcome: "invoiced", tenantInvoiceIds: ["iv-1"], ownerInvoiceIds: ["iv-o1"] },
        { apartmentId: "apt-2", outcome: "reinvoiced", tenantInvoiceIds: ["iv-2"], ownerInvoiceIds: [] },
      ],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Billed 2 of 2");
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("mixes invoiced success with a genuine failure in the tally", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      makeRow({ apartmentId: "apt-3", unitCode: "A-3" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-1", outcome: "invoiced", tenantInvoiceIds: ["iv-1"], ownerInvoiceIds: [] },
        { apartmentId: "apt-2", outcome: "reinvoiced", tenantInvoiceIds: ["iv-2"], ownerInvoiceIds: [] },
        { apartmentId: "apt-3", outcome: "pax_blocked" },
      ],
    });
    renderPage();

    await screen.findByText("A-1");
    selectAllAndBill();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    {
      const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1)!;
      const desc = String((opts as { description?: unknown } | undefined)?.description ?? "");
      expect(String(title)).toContain("Billed 2 of 3 — 1 needs attention");
      expect(desc).toContain("A-3: set the number of tenants");
    }
    expect(toast.success).not.toHaveBeenCalled();
  });

  // ── Per-unit Bill selection ─────────────────────────────────────────────────
  it("disables Bill until a unit is checked, and labels it with the count", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    renderPage();

    await screen.findByText("A-1");
    // Nothing checked → button reads "Bill" and is disabled; no request possible.
    expect(screen.getByRole("button", { name: /^bill$/i })).toBeDisabled();

    // Check one unit → enabled, relabelled "Bill (1)".
    fireEvent.click(screen.getByTestId("bill-select-apt-1"));
    expect(screen.getByRole("button", { name: /^bill \(1\)$/i })).toBeEnabled();
    expect(billRows).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps Deposit-only and TA-only saved drafts selectable when Rental is already paid", async () => {
    const depositOnly = makeRow({
      apartmentId: "apt-deposit",
      unitCode: "A-3-03",
      entryId: null,
      entry: null,
      billedAt: "2026-07-05T00:00:00.000Z",
      paymentStatus: "paid",
      subRows: [{
        listingId: "listing-deposit",
        tenancyId: "tenancy-deposit",
        partyName: "Tenant Deposit",
        previousKwh: null,
        currentKwh: null,
        amount: null,
        ratePerKwh: "0.5000",
        rateConfigured: true,
        rental: "483.87",
        rentalBillingState: "paid",
        deposit: "7500.00",
        depositBillingState: "saved",
      }],
      agreementFees: {
        new: { amount: "0.00", outstanding: "0.00", state: "none" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
      },
    });
    const taOnly = makeRow({
      apartmentId: "apt-ta",
      unitCode: "A-3-04",
      entryId: null,
      entry: null,
      billedAt: "2026-07-05T00:00:00.000Z",
      paymentStatus: "paid",
      subRows: [{
        listingId: "listing-ta",
        tenancyId: "tenancy-ta",
        partyName: "Tenant TA",
        previousKwh: null,
        currentKwh: null,
        amount: null,
        ratePerKwh: "0.5000",
        rateConfigured: true,
        rental: "483.87",
        rentalBillingState: "paid",
        deposit: null,
        depositBillingState: null,
      }],
      agreementFees: {
        new: { amount: "500.00", outstanding: "500.00", state: "saved" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
      },
    });
    fetchGrid.mockResolvedValue(gridResponse([depositOnly, taOnly]));
    billRows.mockResolvedValue({
      results: [
        { apartmentId: "apt-deposit", outcome: "invoiced", tenantInvoiceIds: ["deposit-doc"], ownerInvoiceIds: [] },
        { apartmentId: "apt-ta", outcome: "invoiced", tenantInvoiceIds: ["ta-doc"], ownerInvoiceIds: [] },
      ],
    });
    renderPage();

    await screen.findByText("A-3-03");
    expect(screen.getByTestId("bill-select-apt-deposit")).toBeInTheDocument();
    expect(screen.getByTestId("bill-select-apt-ta")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("bill-select-all"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (2)" }));
    fireEvent.click(await screen.findByTestId("bill-confirm-btn"));

    await waitFor(() => expect(billRows).toHaveBeenCalledWith({
      period: "2026-07-01",
      rows: [
        { apartmentId: "apt-deposit", expectedUpdatedAt: "rental-draft" },
        { apartmentId: "apt-ta", expectedUpdatedAt: "rental-draft" },
      ],
    }));
  }, 15_000);

  it("uses the exact pending draft list for carpark-only selection and ignores detached orange charges", async () => {
    const carparkOnly = makeRow({
      apartmentId: "apt-carpark",
      unitCode: "A-3-05",
      entryId: null,
      entry: null,
      billed: true,
      billedAt: "2026-07-05T00:00:00.000Z",
      subRows: [{
        ...makeRow({ apartmentId: "source", unitCode: "source" }).subRows[0]!,
        listingId: "listing-carpark",
        tenancyId: "tenancy-carpark",
        rental: null,
        rentalBillingState: null,
      }],
      pendingTenancyCharges: [{
        id: "carpark-draft",
        description: "Carpark rent",
        kind: "carpark",
        payer: "tenant",
        baseAmount: "180.00",
        sst: "0.00",
        total: "180.00",
        tenantName: "Tenant Carpark",
      }],
    });
    const detachedRental = makeRow({
      apartmentId: "apt-detached",
      unitCode: "A-3-06",
      entryId: null,
      entry: null,
      subRows: [{
        ...makeRow({ apartmentId: "source", unitCode: "source" }).subRows[0]!,
        listingId: "listing-detached",
        tenancyId: "tenancy-detached",
        rental: "900.00",
        rentalBillingState: "saved",
      }],
      // Current server says no attached draft will be approved. The orange aggregate
      // is still useful cell state but must not create a misleading Bill checkbox.
      pendingTenancyCharges: [],
    });
    fetchGrid.mockResolvedValue(gridResponse([carparkOnly, detachedRental]));
    renderPage();

    await screen.findByText("A-3-05");
    expect(screen.getByTestId("bill-select-apt-carpark")).toBeInTheDocument();
    expect(screen.queryByTestId("bill-select-apt-detached")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("bill-select-apt-carpark"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (1)" }));
    const unit = await screen.findByTestId("bill-confirm-unit-apt-carpark");
    expect(within(unit).getByText("Carpark rent")).toBeInTheDocument();
    expect(screen.getByTestId("bill-confirm-unit-total-apt-carpark")).toHaveTextContent("RM 180.00");
  }, 15_000);

  it("bills only the checked unit, not the whole billable set", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      makeRow({ apartmentId: "apt-3", unitCode: "A-3" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    billRows.mockResolvedValue({
      results: [{ apartmentId: "apt-2", outcome: "invoiced", tenantInvoiceIds: ["iv-2"], ownerInvoiceIds: [] }],
    });
    renderPage();

    await screen.findByText("A-2");
    // Check ONLY apt-2, then Bill.
    fireEvent.click(screen.getByTestId("bill-select-apt-2"));
    fireEvent.click(screen.getByRole("button", { name: /^bill/i }));

    // First issuance is always explicit: no API call until confirmation.
    expect(await screen.findByRole("heading", { name: "Confirm Bill" })).toBeInTheDocument();
    expect(screen.getByTestId("bill-confirm-units")).toHaveTextContent("A-2");
    expect(screen.getByTestId("bill-confirm-units")).not.toHaveTextContent("A-1");
    expect(billRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("bill-confirm-btn"));

    await waitFor(() => expect(billRows).toHaveBeenCalledTimes(1));
    // Exactly one row on the wire — apt-2 — never apt-1/apt-3.
    expect(billRows).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [expect.objectContaining({ apartmentId: "apt-2" })] }),
    );
    expect(toast.success).toHaveBeenCalledWith("Billed 1 of 1");
  });

  it("shows Property Short Form + Unit Number and itemizes the selected unit's saved charges", async () => {
    const detailed = makeRow({
      apartmentId: "apt-detail",
      unitCode: "A-02-02",
      propertyName: "Kensho Residence",
      propertyCode: "KR",
      subRows: [{
        listingId: "apt-detail-room-1",
        tenancyId: "apt-detail-ten-1",
        partyName: "Alicia Tan",
        previousKwh: "100.00",
        currentKwh: "150.00",
        amount: "25.00",
        ratePerKwh: "0.5000",
        rateConfigured: true,
        rental: "1200.00",
        rentalBillingState: "saved",
        deposit: "2400.00",
        depositBillingState: "saved",
      }],
      agreementFees: {
        new: { amount: "120.00", outstanding: "120.00", state: "saved" },
        renewal: { amount: "0.00", outstanding: "0.00", state: "none" },
      },
      pendingTenancyCharges: [
        { id: "rent-detail", description: "Rental", kind: "rental", baseAmount: "1200.00", sst: "0.00", total: "1200.00", tenantName: "Alicia Tan" },
        { id: "deposit-detail", description: "Deposit", kind: "deposit", baseAmount: "2400.00", sst: "0.00", total: "2400.00", tenantName: "Alicia Tan" },
        { id: "ta-detail", description: "TA (WITH SST)", kind: "agreement_fee", baseAmount: "120.00", sst: "0.00", total: "120.00", tenantName: "Alicia Tan" },
      ],
    });
    fetchGrid.mockResolvedValue(gridResponse([detailed]));
    renderPage();

    await screen.findByText("KR A-02-02");
    fireEvent.click(screen.getByTestId("bill-select-apt-detail"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (1)" }));

    const unit = await screen.findByTestId("bill-confirm-unit-apt-detail");
    expect(within(unit).getByRole("heading", { name: "KR A-02-02" })).toBeInTheDocument();
    expect(unit).not.toHaveTextContent("Kensho Residence");
    expect(within(unit).getByText("Rental")).toBeInTheDocument();
    expect(within(unit).getByText("Deposit")).toBeInTheDocument();
    expect(within(unit).getByText("TA (WITH SST)")).toBeInTheDocument();
    expect(unit).not.toHaveTextContent(/includes RM .* SST/);
    expect(within(unit).getAllByText("Tenant")).toHaveLength(3);
    expect(screen.getByTestId("bill-confirm-overview")).toHaveTextContent("RM 3,720.00");
    expect(screen.getByTestId("bill-confirm-unit-total-apt-detail")).toHaveTextContent("RM 3,720.00");
    expect(billRows).not.toHaveBeenCalled();
  }, 15_000);

  it("does not present unresolved paid Re-Bill lines as part of a mixed selection subtotal", async () => {
    const fresh = makeRow({
      apartmentId: "apt-fresh",
      unitCode: "A-05-01",
      propertyCode: "KR",
      pendingTenancyCharges: [{
        id: "fresh-rent",
        description: "Fresh rental",
        kind: "rental",
        payer: "tenant",
        baseAmount: "900.00",
        sst: "0.00",
        total: "900.00",
        tenantName: "Fresh Tenant",
      }],
      billUtilityPlan: {
        status: "not_applicable",
        mode: "whole",
        subsidyPerPax: "0.00",
        lines: [],
        blockedTenancyIds: [],
        errorCode: null,
      },
    });
    const awaitingReview = makeRow({
      apartmentId: "apt-review",
      unitCode: "A-05-02",
      propertyCode: "KR",
      billed: true,
      billedAt: "2026-07-05T00:00:00.000Z",
      pendingTenancyCharges: [],
      billUtilityPlan: {
        status: "rebill_review",
        mode: "whole",
        subsidyPerPax: "0.00",
        lines: [],
        blockedTenancyIds: [],
        errorCode: null,
      },
      recurring: {
        tenant: { total: "100.00", count: 1, items: [{ id: "paid-recurring", name: "Already-paid recurring", amount: "100.00" }] },
        owner: { total: "0.00", count: 0, items: [] },
      },
      expenses: {
        tenant: {
          total: "50.00",
          withSstTotal: "0.00",
          sstTotal: "0.00",
          count: 1,
          items: [{ id: "paid-expense", description: "Already-paid expense", amount: "50.00", sst: "0.00", total: "50.00", withSST: false }],
        },
        owner: { total: "0.00", withSstTotal: "0.00", sstTotal: "0.00", count: 0, items: [] },
      },
    });
    fetchGrid.mockResolvedValue({
      ...gridResponse([fresh, awaitingReview]),
      billingCapabilities: { billingDocuments: true, expensesAsCharges: true },
    });
    renderPage();

    await screen.findByText("KR A-05-01");
    fireEvent.click(screen.getByTestId("bill-select-all"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (2)" }));

    const reviewUnit = await screen.findByTestId("bill-confirm-unit-apt-review");
    expect(within(reviewUnit).queryByText("Already-paid recurring")).not.toBeInTheDocument();
    expect(within(reviewUnit).queryByText("Already-paid expense")).not.toBeInTheDocument();
    expect(within(reviewUnit).getByText("Re-Bill line amounts will be determined after the server's paid-line review.")).toBeInTheDocument();
    expect(screen.getByTestId("bill-confirm-overview")).toHaveTextContent("Known subtotal");
    expect(screen.getByTestId("bill-confirm-overview")).toHaveTextContent("RM 900.00");
  }, 15_000);

  it("uses server billing capabilities so a flag-skewed client never promises disabled grid charges", async () => {
    const row = makeRow({
      apartmentId: "apt-server-flags",
      unitCode: "A-04-01",
      propertyCode: "KR",
      pendingTenancyCharges: [
        { id: "rent-server", description: "Rental", kind: "rental", baseAmount: "900.00", sst: "0.00", total: "900.00", tenantName: "Alicia Tan" },
      ],
      recurring: {
        tenant: { total: "30.00", count: 1, items: [{ id: "recur-disabled", name: "Disabled recurring", amount: "30.00" }] },
        owner: { total: "0.00", count: 0, items: [] },
      },
      expenses: {
        tenant: {
          total: "50.00",
          withSstTotal: "0.00",
          sstTotal: "0.00",
          count: 1,
          items: [{ id: "expense-disabled", description: "Disabled expense", amount: "50.00", sst: "0.00", total: "50.00", withSST: false }],
        },
        owner: { total: "0.00", withSstTotal: "0.00", sstTotal: "0.00", count: 0, items: [] },
      },
    });
    fetchGrid.mockResolvedValue({
      ...gridResponse([row]),
      billingCapabilities: { billingDocuments: false, expensesAsCharges: false },
    });
    renderPage();

    await screen.findByText("KR A-04-01");
    fireEvent.click(screen.getByTestId("bill-select-apt-server-flags"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (1)" }));

    const unit = await screen.findByTestId("bill-confirm-unit-apt-server-flags");
    expect(screen.getByText(/Approve saved tenancy drafts/)).toBeInTheDocument();
    expect(within(unit).getByText("Rental")).toBeInTheDocument();
    expect(within(unit).queryByText("Disabled recurring")).not.toBeInTheDocument();
    expect(within(unit).queryByText("Disabled expense")).not.toBeInTheDocument();
    expect(screen.getByTestId("bill-confirm-unit-total-apt-server-flags")).toHaveTextContent("RM 900.00");
  }, 15_000);

  it("Cancel on first-Bill confirmation keeps saved data unbilled", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();
    await screen.findByText("A-1");
    fireEvent.click(screen.getByTestId("bill-select-apt-1"));
    fireEvent.click(screen.getByRole("button", { name: "Bill (1)" }));
    await screen.findByRole("heading", { name: "Confirm Bill" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(billRows).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Confirm Bill" })).not.toBeInTheDocument();
  });

  it("select-all checks every billable unit and clears on a second click", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
      makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      makeRow({ apartmentId: "apt-3", unitCode: "A-3" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    renderPage();

    await screen.findByText("A-1");
    const selectAll = screen.getByTestId("bill-select-all");

    fireEvent.click(selectAll); // check all 3
    expect(screen.getByRole("button", { name: /^bill \(3\)$/i })).toBeEnabled();

    fireEvent.click(selectAll); // clear all
    expect(screen.getByRole("button", { name: /^bill$/i })).toBeDisabled();
  });

  it("renders no Bill checkbox for an already-billed AND fully-paid unit", async () => {
    const rows = [
      makeRow({ apartmentId: "apt-1", unitCode: "A-1" }), // billable
      makeRow({ apartmentId: "apt-2", unitCode: "A-2", billedAt: "2026-07-15T00:00:00.000Z", paymentStatus: "paid" }),
    ];
    fetchGrid.mockResolvedValue(gridResponse(rows));
    renderPage();

    await screen.findByText("A-2");
    expect(screen.getByTestId("bill-select-apt-1")).toBeInTheDocument();
    expect(screen.queryByTestId("bill-select-apt-2")).toBeNull();
  });

  // Task 7 (spec R7 — unlock predicate): a billed-but-not-fully-paid unit must
  // regain its Bill checkbox (re-Bill/amend), unlike the genuinely paid unit
  // above. Covers unpaid/pending/partial in one test since all three exercise
  // the same "not paid" branch of the predicate.
  it("renders a Bill checkbox for a billed-but-unpaid unit (re-Bill/amend, R7)", async () => {
    for (const paymentStatus of ["unpaid", "pending", "partial"] as const) {
      const rows = [
        makeRow({ apartmentId: "apt-1", unitCode: "A-1", billedAt: "2026-07-15T00:00:00.000Z", paymentStatus }),
      ];
      fetchGrid.mockReset();
      fetchGrid.mockResolvedValue(gridResponse(rows));
      const { unmount } = renderPage();

      await screen.findByText("A-1");
      expect(screen.getByTestId("bill-select-apt-1")).toBeInTheDocument();
      unmount();
    }
  });

  it("export disabled", async () => {
    fetchGrid.mockResolvedValue(gridResponse([]));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Nothing to export")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^export$/i })).toBeDisabled();
    expect(exportGridToXlsx).not.toHaveBeenCalled();
  });

  it("load failure banner", async () => {
    fetchGrid.mockResolvedValueOnce(
      gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })], ["2026-07-01", "2026-06-01"]),
    );
    fetchGrid.mockRejectedValueOnce(new Error("network down"));
    renderPage();

    await screen.findByText("A-1");

    // trigger a second fetch (adding June widens the fetch window) that fails
    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load bills")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // never blank — last-known rows stay visible
    expect(screen.getByText("A-1")).toBeInTheDocument();
  });

  it("error boundary", async () => {
    // Suppress the expected React error-boundary console.error noise.
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem(stagedKey("2026-07-01"), JSON.stringify({ "apt-1:rental": "999" }));

    const badRow = makeRow({ apartmentId: "apt-1", unitCode: "A-1" });
    // @ts-expect-error — deliberately malformed to force a render throw inside GridTable
    badRow.subRows = undefined;
    fetchGrid.mockResolvedValue(gridResponse([badRow]));
    renderPage();

    expect(await screen.findByRole("button", { name: /reload grid/i })).toBeInTheDocument();
    expect(sessionStorage.getItem(stagedKey("2026-07-01"))).toBe(
      JSON.stringify({ "apt-1:rental": "999" }),
    );
  });

  // ── ui-10c: per-apartment surfaces (SettingDrawer/ExpensesDialog/AttachmentsPanel) ──

  it("opens settings drawer", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(getBearerConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("unit-code-btn"));

    await waitFor(() => {
      expect(getBearerConfig).toHaveBeenCalledWith("apt-1");
    });
    expect(await screen.findByText("Unit setting")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByText("Unit setting")).not.toBeInTheDocument();
    });
  });

  it("opens tenant expenses", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(listExpenses).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add Non SST tenant expense" }));

    await waitFor(() => {
      expect(listExpenses).toHaveBeenCalledWith({
        apartmentId: "apt-1",
        billingMonth: "2026-07-01",
        bearer: "tenant",
      });
    });
    expect(await screen.findByText("Tenant expenses")).toBeInTheDocument();
  });

  it("opens owner expenses", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    fireEvent.click(screen.getByRole("button", { name: "Add Non SST owner expense" }));

    await waitFor(() => {
      expect(listExpenses).toHaveBeenCalledWith({
        apartmentId: "apt-1",
        billingMonth: "2026-07-01",
        bearer: "owner",
      });
    });
    expect(await screen.findByText("Owner expenses")).toBeInTheDocument();
  });

  it("expenses gets tenancyOptions", async () => {
    const occupiedRow = makeRow({
      apartmentId: "apt-1",
      unitCode: "A-1",
      subRows: [
        {
          listingId: "apt-1-room-1",
          tenancyId: "ten-1",
          partyName: "Alice Wong",
          previousKwh: "100.00",
          currentKwh: "150.00",
          amount: "25.00",
          ratePerKwh: "0.5000",
          rateConfigured: true,
          rental: "1200.00",
        },
      ],
    });
    fetchGrid.mockResolvedValue(gridResponse([occupiedRow]));
    renderPage();

    await screen.findByText("A-1");
    fireEvent.click(screen.getByRole("button", { name: "Add Non SST tenant expense" }));
    await screen.findByText("Tenant expenses");

    // The inline form renders on open, so the tenant picker is present with no
    // second click. tenancyOptions is non-empty: the occupied room's tenant is a
    // selectable option, NOT the empty-picker "No matching tenant." block.
    expect(await screen.findByRole("button", { name: /Alice Wong/ })).toBeInTheDocument();
    expect(screen.queryByText("No matching tenant.")).not.toBeInTheDocument();
  });

  it("opens attachments", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(listAttachments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("attachments-btn"));

    await waitFor(() => {
      expect(listAttachments).toHaveBeenCalledWith("apt-1", "2026-07-01");
    });
    // AttachmentsPanel's own empty state confirms it (not just the Sheet's) mounted.
    expect(await screen.findByText("No attachments yet.")).toBeInTheDocument();
  });

  it("one at a time — surfaces mount only on demand, never per row on grid load", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");
    expect(listExpenses).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Add Non SST tenant expense" })[0]);

    await waitFor(() => {
      expect(listExpenses).toHaveBeenCalledTimes(1);
    });
    expect(listExpenses).toHaveBeenCalledWith({
      apartmentId: "apt-1",
      billingMonth: "2026-07-01",
      bearer: "tenant",
    });
  });

  // ── ui-10c fix (Adversarial Finding 1): guard the two PERIOD-DEPENDENT
  // surfaces against the stale-period window; settings stays open (it's
  // period-independent). Same genuine-period-switch technique as "guards
  // Save" above: widen to July+June first (resolves normally), THEN
  // deselect July leaving ONLY June selected, keeping June's own fetch
  // pending — currentPeriod ("2026-06-01") diverges from lastGood.period
  // ("2026-07-01") for as long as that fetch is in flight. Deselecting July
  // must happen SECOND (never passing through zero selected periods) — the
  // page's default-select effect silently restores July the instant the
  // selection would go empty. ─────────────────────────────────────────────

  it("stale period blocks opening expenses", async () => {
    // Reproduces the bug: a click on the Tenant-Expenses eye during a
    // genuine period-switch race must NOT open the surface — otherwise
    // ExpensesDialog mounts with periodMonth = currentPeriod (June, the NEW
    // month) while tenancyOptionsFor reads lastGood.rows (July, the OLD
    // month) — an expense filed under the wrong month, attributed to the
    // wrong party's tenancy.
    const rows = [makeRow({ apartmentId: "apt-1", unitCode: "A-1" })];
    fetchGrid.mockResolvedValueOnce(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
    // The widen fetch is a manually-controlled deferred promise (not
    // mockResolvedValueOnce) so we can explicitly resolve it inside an
    // `act()` and be certain its full resolution → query-state-update →
    // re-render chain has landed before the next click — a bare `waitFor` on
    // the call count is not a reliable signal (the queryFn is invoked
    // SYNCHRONOUSLY when the queryKey changes, so the call-count assertion
    // can already be true before the promise itself has even settled).
    let resolveWiden: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveWiden = resolve;
      }),
    );
    let resolveJuneFetch: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveJuneFetch = resolve;
      }),
    );
    renderPage();

    await screen.findByText("A-1");
    // Settle the page's OWN cascading default-select effect (setLastGood →
    // periods memo recomputes → the `selectedPeriods.length === 0` effect
    // fires `setSelectedPeriods([periods[0]])`) before touching any period
    // chip. `findByText("A-1")` only confirms rows rendered from
    // `lastGood.rows`; it does NOT guarantee that SECOND, cascading effect
    // pass has also committed — observed racy otherwise: clicking June while
    // `selectedPeriods` is still `[]` toggles it to `["2026-06-01"]` ALONE
    // (not a July+June widen), corrupting the rest of the sequence. Same
    // synchronization the "month selector" test above uses.
    await waitFor(() => {
      expect(screen.getByTestId("period-chip-2026-07-01")).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(2);
    });
    // resolve the widen fetch and let every resulting microtask (state
    // update, notifyManager, re-render) fully settle before the next click
    await act(async () => {
      resolveWiden?.(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("period-chip-2026-07-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(3);
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Non SST tenant expense" }));

    // guarded: the Sheet never opens, no query fires
    expect(screen.queryByText("Tenant expenses")).not.toBeInTheDocument();
    expect(listExpenses).not.toHaveBeenCalled();

    resolveJuneFetch?.(gridResponse(rows, ["2026-06-01"]));
  });

  it("stale period blocks opening attachments", async () => {
    // Same race, the attachments paperclip: AttachmentsPanel would otherwise
    // mount with periodMonth = currentPeriod (June) — a bill uploaded there
    // gets attached to the wrong month.
    const rows = [makeRow({ apartmentId: "apt-1", unitCode: "A-1" })];
    fetchGrid.mockResolvedValueOnce(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
    // The widen fetch is a manually-controlled deferred promise (not
    // mockResolvedValueOnce) so we can explicitly resolve it inside an
    // `act()` and be certain its full resolution → query-state-update →
    // re-render chain has landed before the next click — a bare `waitFor` on
    // the call count is not a reliable signal (the queryFn is invoked
    // SYNCHRONOUSLY when the queryKey changes, so the call-count assertion
    // can already be true before the promise itself has even settled).
    let resolveWiden: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveWiden = resolve;
      }),
    );
    let resolveJuneFetch: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveJuneFetch = resolve;
      }),
    );
    renderPage();

    await screen.findByText("A-1");
    // Settle the page's OWN cascading default-select effect (setLastGood →
    // periods memo recomputes → the `selectedPeriods.length === 0` effect
    // fires `setSelectedPeriods([periods[0]])`) before touching any period
    // chip. `findByText("A-1")` only confirms rows rendered from
    // `lastGood.rows`; it does NOT guarantee that SECOND, cascading effect
    // pass has also committed — observed racy otherwise: clicking June while
    // `selectedPeriods` is still `[]` toggles it to `["2026-06-01"]` ALONE
    // (not a July+June widen), corrupting the rest of the sequence. Same
    // synchronization the "month selector" test above uses.
    await waitFor(() => {
      expect(screen.getByTestId("period-chip-2026-07-01")).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(2);
    });
    // resolve the widen fetch and let every resulting microtask (state
    // update, notifyManager, re-render) fully settle before the next click
    await act(async () => {
      resolveWiden?.(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("period-chip-2026-07-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(3);
    });

    fireEvent.click(screen.getByTestId("attachments-btn"));

    // guarded: the Sheet never opens (AttachmentsPanel's own empty state,
    // not just the grid's always-present "Attachments" column label, is the
    // reliable it-mounted signal — see "opens attachments" above), no query fires
    expect(screen.queryByText("No attachments yet.")).not.toBeInTheDocument();
    expect(listAttachments).not.toHaveBeenCalled();

    resolveJuneFetch?.(gridResponse(rows, ["2026-06-01"]));
  });

  it("settings stays openable during a stale-period window (period-independent)", async () => {
    // SettingDrawer keys off getBearerConfig(apartmentId) with no period in
    // its cache key — it must NOT be blocked by showingStalePeriod.
    const rows = [makeRow({ apartmentId: "apt-1", unitCode: "A-1" })];
    fetchGrid.mockResolvedValueOnce(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
    // The widen fetch is a manually-controlled deferred promise (not
    // mockResolvedValueOnce) so we can explicitly resolve it inside an
    // `act()` and be certain its full resolution → query-state-update →
    // re-render chain has landed before the next click — a bare `waitFor` on
    // the call count is not a reliable signal (the queryFn is invoked
    // SYNCHRONOUSLY when the queryKey changes, so the call-count assertion
    // can already be true before the promise itself has even settled).
    let resolveWiden: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveWiden = resolve;
      }),
    );
    let resolveJuneFetch: ((value: GridResponse) => void) | undefined;
    fetchGrid.mockReturnValueOnce(
      new Promise<GridResponse>((resolve) => {
        resolveJuneFetch = resolve;
      }),
    );
    renderPage();

    await screen.findByText("A-1");
    // Settle the page's OWN cascading default-select effect (setLastGood →
    // periods memo recomputes → the `selectedPeriods.length === 0` effect
    // fires `setSelectedPeriods([periods[0]])`) before touching any period
    // chip. `findByText("A-1")` only confirms rows rendered from
    // `lastGood.rows`; it does NOT guarantee that SECOND, cascading effect
    // pass has also committed — observed racy otherwise: clicking June while
    // `selectedPeriods` is still `[]` toggles it to `["2026-06-01"]` ALONE
    // (not a July+June widen), corrupting the rest of the sequence. Same
    // synchronization the "month selector" test above uses.
    await waitFor(() => {
      expect(screen.getByTestId("period-chip-2026-07-01")).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.click(screen.getByTestId("period-chip-2026-06-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(2);
    });
    // resolve the widen fetch and let every resulting microtask (state
    // update, notifyManager, re-render) fully settle before the next click
    await act(async () => {
      resolveWiden?.(gridResponse(rows, ["2026-07-01", "2026-06-01"]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("period-chip-2026-07-01"));
    await waitFor(() => {
      expect(fetchGrid).toHaveBeenCalledTimes(3);
    });

    fireEvent.click(screen.getByTestId("unit-code-btn"));

    await waitFor(() => {
      expect(getBearerConfig).toHaveBeenCalledWith("apt-1");
    });
    expect(await screen.findByText("Unit setting")).toBeInTheDocument();

    resolveJuneFetch?.(gridResponse(rows, ["2026-06-01"]));
  });

  // ── ui-10d: column/date filters + bounded grid scrolling ──────────────────

  it("column filter narrows rows", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([
        makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
        makeRow({ apartmentId: "apt-2", unitCode: "A-2" }),
        makeRow({ apartmentId: "apt-3", unitCode: "B-1" }),
      ]),
    );
    exportGridToXlsx.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText("A-1");
    expect(screen.getByText("A-2")).toBeInTheDocument();
    expect(screen.getByText("B-1")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "A-" } });

    await waitFor(() => {
      expect(screen.queryByText("B-1")).not.toBeInTheDocument();
    });
    expect(screen.getByText("A-1")).toBeInTheDocument();
    expect(screen.getByText("A-2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export entire data (Excel)" }));

    await waitFor(() => expect(exportGridToXlsx).toHaveBeenCalledTimes(1));
    const [exportedRows] = exportGridToXlsx.mock.calls[0];
    expect((exportedRows as GridRow[]).map((r) => r.apartmentId).sort()).toEqual(["apt-1", "apt-2"]);
  });

  it("date range narrows export periods", async () => {
    const row = makeRow({
      apartmentId: "apt-1",
      unitCode: "A-1",
      priorMonths: [
        { period: "2026-06-01", cleaning: "80.00", tnb: "150.00", air: "40.00", wifi: "60.00", others: "50.00" },
        { period: "2026-05-01", cleaning: "80.00", tnb: "150.00", air: "40.00", wifi: "60.00", others: "50.00" },
      ],
    });
    fetchGrid.mockResolvedValue(gridResponse([row], ["2026-07-01", "2026-06-01", "2026-05-01"]));
    exportGridToXlsx.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText("A-1");

    fireEvent.change(screen.getByLabelText("Date range from"), { target: { value: "2026-06" } });

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export entire data (Excel)" }));

    await waitFor(() => expect(exportGridToXlsx).toHaveBeenCalledTimes(1));
    const [exportedRows, , exportedPeriods] = exportGridToXlsx.mock.calls[0];
    expect(exportedPeriods).toEqual(["2026-07-01", "2026-06-01"]);
    expect(
      (exportedRows as GridRow[])[0].priorMonths.map((p: PriorMonthStrip) => p.period),
    ).toEqual(["2026-06-01"]);
  });

  it("empty filter disables export", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(screen.getByRole("button", { name: /^export$/i })).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "ZZZ-NO-MATCH" } });

    await waitFor(() => {
      expect(screen.getByText("Nothing to export")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^export$/i })).toBeDisabled();
    expect(screen.queryByText("A-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));
    expect(exportGridToXlsx).not.toHaveBeenCalled();
  });

  it("does not render the retired Fullscreen controls", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(screen.queryByRole("button", { name: /fullscreen/i })).not.toBeInTheDocument();
  });

  it("does not retain the retired fullscreen overlay, zoom, or preference", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(screen.getByTestId("grid-region").className).not.toMatch(/fixed|inset-0/);
    expect(screen.getByTestId("grid-region").getAttribute("style") ?? "").not.toMatch(/zoom/);
    expect(loadPref).not.toHaveBeenCalledWith("bills-grid", "maximized", expect.anything());
    expect(savePref).not.toHaveBeenCalledWith("bills-grid", "maximized", expect.anything());
  });

  it("keeps one filter toolbar outside the bounded grid region", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const region = screen.getByTestId("grid-region");
    const toolbar = screen.getByTestId("grid-toolbar");
    expect(screen.getAllByTestId("grid-toolbar")).toHaveLength(1);
    expect(region.contains(toolbar)).toBe(false);
    expect(within(toolbar).getByLabelText("Categorize")).toBeInTheDocument();
  });

  it("grid-region stays bounded and owns both scroll axes", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const region = screen.getByTestId("grid-region");
    expect(region.className).toContain("overflow-x-auto");
    expect(region.className).toContain("overflow-y-auto");
    expect(region.className).toMatch(/max-h-/);
  });

  it("uses a structural grid-scroll wrapper instead of a nested competing scroller", async () => {
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    const region = screen.getByTestId("grid-region");
    expect(within(region).getByTestId("grid-scroll")).toHaveClass("contents");
  });

  // ── ui-task-10e: drag-select (a), colour-fill (c), hide-column (d) via useGridSelection ──

  it("drag-select shows count and sum", async () => {
    // Task 4 (converted): a mouse drag now selects the RECTANGLE between the two
    // endpoints, not the linear pointer path. pointerdown row0/cleaningOwner +
    // pointerenter row1/tnbOwner (a diagonal) selects the whole 2-row ×
    // 2-column BLOCK — {cleaningOwner, tnbOwner} × {row0, row1} = 4 cells — even
    // though the path only touched the two opposite corners. Cleaning is a
    // read-only recurring value and owner-borne TNB is editable, so this also
    // proves a mixed read-only/editable rectangle. The count badge therefore
    // reads "Count 4" (the block, not the 2-cell path). Sum reads the Σ of the
    // four cells' DISPLAYED numeric values: cleaning 80 + 80 and tnbOwner 20 +
    // 40 = 220.00. The page enriches each selected cell's value from its
    // live DOM node ("read what you see", same source as copy) so the geometric
    // rectangle carries real numbers, not just identities.
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "20.00"),
        tnbRow("apt-2", "A-2", "40.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // no drag in progress yet — no badge
    expect(screen.queryByTestId("selection-badge")).not.toBeInTheDocument();

    const topLeft = screen.getAllByTestId("cell-cleaningOwner")[0]; // row0
    const bottomRight = screen.getAllByTestId("cell-tnbOwner")[1]; // row1, adjacent column

    fireEvent.pointerDown(topLeft);
    fireEvent.pointerEnter(bottomRight);

    // The 2×2 rectangle = 4 cells (proves the block, not the 2-corner path).
    expect(await screen.findByText("Count 4")).toBeInTheDocument();
    // 80 + 80 (cleaningOwner) + 20 + 40 (tnbOwner) = 220.00 — the sum reflects
    // the selected cells' values instead of the old identity-only 0.00.
    expect(screen.getByText("Sum 220.00")).toBeInTheDocument();
  });

  it("Shift+arrow keyboard range sums the selected cells", async () => {
    // The keyboard Shift+arrow producer (nav.extendRange) also builds the range
    // from NavCell identities only. Like the mouse drag, the badge must sum the
    // DISPLAYED values of the extended range — here two tnbOwner cells (20 + 40).
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "20.00"),
        tnbRow("apt-2", "A-2", "40.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // Seat the active cell on row0/tnbOwner (a click routes through the mouse
    // producer), then extend down one row with Shift+ArrowDown → 2 cells.
    const anchor = screen.getAllByTestId("cell-tnbOwner")[0];
    fireEvent.pointerDown(anchor);
    fireEvent.pointerUp(anchor);
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "ArrowDown", shiftKey: true });

    expect(await screen.findByText("Count 2")).toBeInTheDocument();
    expect(screen.getByText("Sum 60.00")).toBeInTheDocument();
  });

  it("sum includes read-only value cells spanned by the drag rectangle", async () => {
    // A drag rectangle spans READ-ONLY cells between its editable endpoints, and
    // those cells must contribute to the sum too. Their displayed number is read
    // from `data-copy-value` (they are <td>s, not <input>s) — NOT textContent,
    // which can carry a count badge. Whole-unit meter cells now correctly show
    // non-applicable dashes, so use adjacent cleaningOwner (read-only 80) and
    // tnbOwner (editable 20): two selected cells, sum 100.00.
    fetchGrid.mockResolvedValue(gridResponse([tnbRow("apt-1", "A-1", "20.00")]));
    renderPage();

    await screen.findByText("A-1");

    const topLeft = screen.getByTestId("cell-cleaningOwner");
    const bottomRight = screen.getByTestId("cell-tnbOwner");
    fireEvent.pointerDown(topLeft);
    fireEvent.pointerEnter(bottomRight);

    expect(await screen.findByText("Count 2")).toBeInTheDocument();
    expect(screen.getByText("Sum 100.00")).toBeInTheDocument();
  });

  it("drag STARTING on a read-only Rental (price) cell selects and sums it", async () => {
    // The Rental/price column is read-only (admin can't edit it) but MUST still be
    // selectable + copyable. A drag that STARTS on a read-only cell (rental[row0])
    // and grows to rental[row1] must select both — read-only cells now carry the
    // same pointer-selection handlers as editable cells. Each row's rental is the
    // fixture's whole-unit tenancy rental "1200.00" → 2 cells, sum 2400.00.
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "20.00"),
        tnbRow("apt-2", "A-2", "40.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    const rental0 = screen.getAllByTestId("cell-rental")[0];
    const rental1 = screen.getAllByTestId("cell-rental")[1];
    fireEvent.pointerDown(rental0); // drag STARTS on a read-only cell
    fireEvent.pointerEnter(rental1);

    // Both read-only rental cells are now in the selection (paint the tint)…
    await waitFor(() => expect(screen.getAllByTestId("cell-rental")[0]).toHaveAttribute("data-selected", "true"));
    expect(screen.getAllByTestId("cell-rental")[1]).toHaveAttribute("data-selected", "true");
    // …and the badge counts + sums them (1200 + 1200 = 2400.00).
    expect(screen.getByText("Count 2")).toBeInTheDocument();
    expect(screen.getByText("Sum 2400.00")).toBeInTheDocument();
  });

  it("selected read-only Rental cells are copyable (Ctrl/Cmd+C)", async () => {
    // The admin must be able to COPY the read-only price column. Select two rental
    // cells (drag) and Ctrl+C → the clipboard TSV carries their displayed values.
    fetchGrid.mockResolvedValue(
      gridResponse([tnbRow("apt-1", "A-1", "20.00"), tnbRow("apt-2", "A-2", "40.00")]),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();

    await screen.findByText("A-1");

    fireEvent.pointerDown(screen.getAllByTestId("cell-rental")[0]);
    fireEvent.pointerEnter(screen.getAllByTestId("cell-rental")[1]);
    await waitFor(() => expect(screen.getAllByTestId("cell-rental")[0]).toHaveAttribute("data-selected", "true"));

    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "c", ctrlKey: true });

    // Copy produced a clipboard payload of the two read-only rentals (1200 each).
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("1200.00\n1200.00");
  });

  it("Delete over a selected read-only Rental cell never mutates it (money-safety)", async () => {
    // Read-only cells are selectable, but Delete must NOT stage or save them:
    // rental is not a meter/entry-wire field, so onDelete no-ops it (step 5). If it
    // mutated, a staged edit would flip Save to "Save (1)" / enabled.
    fetchGrid.mockResolvedValue(gridResponse([tnbRow("apt-1", "A-1", "20.00")]));
    renderPage();

    await screen.findByText("A-1");

    fireEvent.pointerDown(screen.getByTestId("cell-rental")); // single read-only cell selected
    await waitFor(() => expect(screen.getByTestId("cell-rental")).toHaveAttribute("data-selected", "true"));

    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "Delete" });

    const saveButton = screen.getByRole("button", { name: /^save/i });
    expect(saveButton).toHaveTextContent(/^Save$/); // no "(N)" → no staged edit created
    expect(saveButton).toBeDisabled(); // dirtyCount stayed 0
    expect(screen.getByTestId("cell-rental")).toHaveAttribute("data-copy-value", "1200.00"); // value intact
    expect(saveEntry).not.toHaveBeenCalled();
  });

  // ── Undo/redo over the staged buffer (in-memory; never a server write) ──────────

  it("Cmd/Ctrl+Z reverts a typed edit and disables Undo; Redo re-applies (R1/R2/R3/R11)", async () => {
    fetchGrid.mockResolvedValue(gridResponse([tnbRow("apt-1", "A-1", "20.00")]));
    renderPage();
    await screen.findByText("A-1");

    const undoBtn = screen.getByTestId("grid-undo");
    const redoBtn = screen.getByTestId("grid-redo");
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).toBeDisabled();

    const input = () => within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    fireEvent.change(input(), { target: { value: "99" } });
    await waitFor(() => expect(undoBtn).not.toBeDisabled());
    expect(input()).toHaveValue("99");

    // Undo (Ctrl is the platform command key in the non-mac test env)
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(input()).toHaveValue("20.00")); // reverted to the saved seed (echo cleared — R11)
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).not.toBeDisabled();

    // Redo
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(input()).toHaveValue("99"));
    expect(saveEntry).not.toHaveBeenCalled(); // R7 — no server write across undo/redo
  });

  it("toolbar Undo button reverts the last edit (R3)", async () => {
    fetchGrid.mockResolvedValue(gridResponse([tnbRow("apt-1", "A-1", "20.00")]));
    renderPage();
    await screen.findByText("A-1");

    const input = () => within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    fireEvent.change(input(), { target: { value: "77" } });
    await waitFor(() => expect(screen.getByTestId("grid-undo")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("grid-undo"));
    await waitFor(() => expect(input()).toHaveValue("20.00"));
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it("a multi-cell Delete is ONE undo step — Cmd/Ctrl+Z restores every cleared cell (R6)", async () => {
    fetchGrid.mockResolvedValue(
      gridResponse([tnbRow("apt-1", "A-1", "20.00"), tnbRow("apt-2", "A-2", "40.00")]),
    );
    renderPage();
    await screen.findByText("A-1");

    const in0 = () => within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
    const in1 = () => within(screen.getAllByTestId("cell-tnbOwner")[1]).getByRole("textbox");
    fireEvent.change(in0(), { target: { value: "99" } });
    fireEvent.change(in1(), { target: { value: "88" } });
    await waitFor(() => expect(screen.getByTestId("grid-undo")).not.toBeDisabled());

    // Select both tnbOwner cells (drag) then Delete → clears both in one batch.
    fireEvent.pointerDown(screen.getAllByTestId("cell-tnbOwner")[0]);
    fireEvent.pointerEnter(screen.getAllByTestId("cell-tnbOwner")[1]);
    await waitFor(() => expect(screen.getAllByTestId("cell-tnbOwner")[0]).toHaveAttribute("data-selected", "true"));
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "Delete" });
    await waitFor(() => expect(in0()).toHaveValue("20.00")); // both cleared to seed
    expect(in1()).toHaveValue("40.00");

    // ONE undo restores BOTH typed values (proves the Delete grouped into one step).
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(in0()).toHaveValue("99"));
    expect(in1()).toHaveValue("88");
    expect(saveEntry).not.toHaveBeenCalled(); // R7
  });

  it("Save resets the undo history (R8)", async () => {
    fetchGrid.mockResolvedValue(gridResponse([tnbRow("apt-1", "A-1", "20.00")]));
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    renderPage();
    await screen.findByText("A-1");

    const input = within(screen.getByTestId("cell-tnbOwner")).getByRole("textbox");
    fireEvent.change(input, { target: { value: "1500" } });
    const saveButton = screen.getByRole("button", { name: /^save/i });
    await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
    expect(screen.getByTestId("grid-undo")).not.toBeDisabled();

    fireEvent.click(saveButton);
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));

    // After Save, the buffer + history reset → Undo disabled.
    await waitFor(() => expect(screen.getByTestId("grid-undo")).toBeDisabled());
    expect(screen.getByTestId("grid-redo")).toBeDisabled();
  });

  // ── Task 4 (Excel MOUSE selection V2): useMultiSelection wired into the page.
  // ctrl-drag FILL is retired (ctrl = add-range multi-select); a mouse drag now
  // selects the RECTANGLE between the two endpoints, not the linear path. ─────

  it("drag selects the full block", async () => {
    // Four unit rows so a diagonal drag spans a real row×column rectangle. A
    // pointerdown on (row0, tnbOwner) then pointerenter on (row3,
    // maintenanceFee) must paint EVERY cell inside that rectangle
    // data-selected — the block, not just the two touched cells. (Recurring-
    // charges R9: cleaning/WiFi are read-only, so the rectangle's editable
    // left edge is tnbOwner, not cleaningOwner.)
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "50.00"),
        tnbRow("apt-2", "A-2", "20.00"),
        tnbRow("apt-3", "A-3", "30.00"),
        tnbRow("apt-4", "A-4", "40.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // Rectangle corners: top-left = row0 tnbOwner, bottom-right = row3
    // maintenanceFee. tnbOwner and maintenanceFee bracket a span of unit-grain
    // columns, so the rectangle is unambiguous.
    const topLeft = screen.getAllByTestId("cell-tnbOwner")[0];
    const bottomRight = screen.getAllByTestId("cell-maintenanceFee")[3];

    fireEvent.pointerDown(topLeft);
    fireEvent.pointerEnter(bottomRight);

    // Every corner + interior column of the block is selected, across all four
    // rows — proving the RECTANGLE was filled, not the linear drag path. Assert
    // the owner-side / non-bearer columns inside the rectangle: the fixture's
    // bearers are all "owner", so the tenant-side cells (cleaningTenant/
    // airTenant/wifiTenant) are INAPPLICABLE and render no cell — an
    // applicability quirk, not a selection failure. wifiOwner is a read-only
    // recurring cell now but still navigable, so it joins the selected block.
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-tnbOwner")[0]).toHaveAttribute("data-selected", "true");
    });
    for (const col of ["tnbOwner", "airOwner", "wifiOwner", "maintenanceFee"]) {
      const cells = screen.getAllByTestId(`cell-${col}`);
      for (let r = 0; r < 4; r++) {
        expect(cells[r]).toHaveAttribute("data-selected", "true");
      }
    }
  });

  it("ctrl+click adds non-contiguous", async () => {
    // Select one cell, then ctrl-click a FAR cell (different row + column).
    // ctrl toggle-ADDS (retired fill) — both cells must stay data-selected
    // (a non-contiguous multi-selection), and the earlier cell must NOT be
    // clobbered by the ctrl-click's own onClick fall-through.
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "50.00"),
        tnbRow("apt-2", "A-2", "20.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // cleaning/WiFi are read-only now, so the editable "first" cell is tnbOwner.
    const first = screen.getAllByTestId("cell-tnbOwner")[0]; // row0
    const far = screen.getAllByTestId("cell-maintenanceFee")[1]; // row1, far column

    // Plain select the first cell (pointerdown + release).
    fireEvent.pointerDown(first);
    fireEvent.pointerUp(first);
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-tnbOwner")[0]).toHaveAttribute("data-selected", "true");
    });

    // Ctrl-click the far cell: pointerdown carries the ctrl bit (the selection
    // path); a real click also fires onClick, which must bail on ctrl.
    fireEvent.pointerDown(far, { ctrlKey: true });
    fireEvent.click(far, { ctrlKey: true });
    fireEvent.pointerUp(far);

    // BOTH cells carry data-selected — the ctrl-add did not collapse the first.
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-maintenanceFee")[1]).toHaveAttribute("data-selected", "true");
    });
    expect(screen.getAllByTestId("cell-tnbOwner")[0]).toHaveAttribute("data-selected", "true");
  });

  it("delete over multi skips billed", async () => {
    // MONEY (re-homes the retired "ctrl-fill excludes a billed apartment's cell"
    // — 1488): a mouse rectangle that SPANS a billed apartment's row includes
    // that billed cell in `sel.range` by identity (rectBetween keeps read-only
    // cells). Delete over that multi-selection must SKIP the billed cell (guarded
    // by its OWNING apartment via billedApartmentIds/resolveApartmentId) and
    // stage the clear ONLY for the unbilled meter cells — so a subsequent Save
    // fires saveReadings for the unbilled apartments and NEVER for the billed
    // one. Meter editing belongs to partitioned-room rows, so these three rows
    // explicitly opt out of the shared whole-unit fixture. apt-2 is seeded
    // already-billed and paid; the drag runs down the nested Current-meter
    // column, sweeping its locked cell into the range.
    fetchGrid.mockResolvedValue(
      gridResponse([
        { ...tnbRow("apt-1", "A-1", "50.00"), isWholeUnit: false },
        // Task 7 (R7): billed alone no longer locks — paymentStatus "paid" is
        // required too, so this fixture stays a genuine (excluded/skipped) lock case.
        { ...tnbRow("apt-2", "A-2", "20.00", "2026-07-15T00:00:00.000Z"), isWholeUnit: false, paymentStatus: "paid" }, // BILLED + PAID
        { ...tnbRow("apt-3", "A-3", "30.00"), isWholeUnit: false },
      ]),
    );
    saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
    saveReadings.mockResolvedValue({ ok: true });
    renderPage();

    await screen.findByText("A-1");

    // Select the actual nested-room meter cells, not the unit-row placeholders.
    // apt-2 is a read-only LockedCell in the rectangle's interior.
    const roomRows = screen.getAllByTestId("tenant-sub-row");
    const firstCurrent = within(roomRows[0]).getByTestId("cell-currentKwh");
    const lastCurrent = within(roomRows[2]).getByTestId("cell-currentKwh");
    fireEvent.pointerDown(firstCurrent);
    fireEvent.pointerEnter(lastCurrent);
    fireEvent.pointerUp(lastCurrent);

    // The rectangle swept ALL THREE nested currentKwh cells into sel.range — including
    // the billed apt-2's (rectBetween keeps read-only cells by identity). The
    // count badge counts every selected cell, so "Count 3" proves the billed
    // cell entered sel.range — the exact cell Delete must now skip. (The billed
    // cell renders as a LockedCell, which carries no data-selected attribute, so
    // the count badge is the observable proxy for its membership.)
    expect(await screen.findByText("Count 3")).toBeInTheDocument();

    // Delete over the multi-selection.
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "Delete" });

    // Exactly the two UNBILLED meter clears staged (apt-1 + apt-3); apt-2 skipped.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save/i })).toHaveTextContent("Save (2)");
    });

    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    fireEvent.click(await screen.findByTestId("save-confirm-btn"));

    await waitFor(() => {
      expect(saveReadings).toHaveBeenCalledTimes(2);
    });
    // saveReadings fired for the two unbilled apartments only …
    expect(saveReadings).toHaveBeenCalledWith("apt-1", expect.anything(), expect.anything());
    expect(saveReadings).toHaveBeenCalledWith("apt-3", expect.anything(), expect.anything());
    // … and NEVER for the billed apartment (neither reading nor entry write).
    expect(saveReadings).not.toHaveBeenCalledWith("apt-2", expect.anything(), expect.anything());
    expect(saveEntry).not.toHaveBeenCalledWith("apt-2", expect.anything());
  });

  it("shift-click extends without clobbering", async () => {
    // The mods-guard's SHIFT branch (distinct from ctrl): a shift-click extends
    // the selection and is OWNED by the pointer-down path — the plain onClick
    // must BAIL on shift (mods.shift), never fire a bare set-active that would
    // collapse the prior selection to the just-clicked cell. Select
    // row0/cleaningOwner, then shift-click a far cell → BOTH stay selected (the
    // shift-click added it via the committed set, and its onClick did not
    // clobber the anchor). A mid-drag shift-EXTEND across a rectangle is the
    // Shift+arrow / held-drag path; a discrete shift-CLICK after a completed
    // selection simply adds the clicked cell without collapsing.
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "50.00"),
        tnbRow("apt-2", "A-2", "20.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // cleaning/WiFi are read-only now, so the editable anchor is airOwner.
    const anchor = screen.getAllByTestId("cell-airOwner")[0]; // row0
    fireEvent.pointerDown(anchor);
    fireEvent.pointerUp(anchor);
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-airOwner")[0]).toHaveAttribute("data-selected", "true");
    });

    const far = screen.getAllByTestId("cell-tnbOwner")[1]; // row1, other column
    fireEvent.pointerDown(far, { shiftKey: true });
    fireEvent.click(far, { shiftKey: true });
    fireEvent.pointerUp(far);

    // BOTH cells stay selected — the shift-click added the far cell and its
    // onClick did NOT collapse the anchor (the reviewer-flagged clobber, shift
    // branch).
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-tnbOwner")[1]).toHaveAttribute("data-selected", "true");
    });
    expect(screen.getAllByTestId("cell-airOwner")[0]).toHaveAttribute("data-selected", "true");
  });

  it("arrow collapses a multi-selection", async () => {
    // A plain arrow move after a mouse multi-select routes through
    // multiSel.collapseTo(nav.active), which clears the hook's committed + open
    // rect AND sel.range — so the next gesture starts fresh, not re-growing the
    // stale committed set. Build a ctrl-add multi-selection (2 disjoint cells),
    // arrow away to collapse, then start a NEW plain drag on a THIRD cell: the
    // originally-committed cells must NOT reappear (they'd leak back if the
    // collapse only cleared sel.range, not the hook's committed ref).
    fetchGrid.mockResolvedValue(
      gridResponse([
        tnbRow("apt-1", "A-1", "50.00"),
        tnbRow("apt-2", "A-2", "20.00"),
        tnbRow("apt-3", "A-3", "30.00"),
      ]),
    );
    renderPage();

    await screen.findByText("A-1");

    // Build a 2-cell ctrl-add multi-selection: row0/airOwner + row1/tnbOwner.
    // (cleaning/WiFi are read-only now, so airOwner is the editable anchor.)
    const c0 = screen.getAllByTestId("cell-airOwner")[0];
    fireEvent.pointerDown(c0);
    fireEvent.pointerUp(c0);
    const t1 = screen.getAllByTestId("cell-tnbOwner")[1];
    fireEvent.pointerDown(t1, { ctrlKey: true });
    fireEvent.pointerUp(t1);
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-airOwner")[0]).toHaveAttribute("data-selected", "true");
    });
    expect(screen.getAllByTestId("cell-tnbOwner")[1]).toHaveAttribute("data-selected", "true");

    // Plain arrow — collapses the whole multi-selection to the new active cell.
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "ArrowDown" });
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-airOwner")[0]).not.toHaveAttribute("data-selected", "true");
    });

    // New plain drag on a fresh single cell (row2/maintenanceFee): the prior
    // committed cells must stay cleared — only the freshly dragged cell selects.
    const m2 = screen.getAllByTestId("cell-maintenanceFee")[2];
    fireEvent.pointerDown(m2);
    fireEvent.pointerUp(m2);
    await waitFor(() => {
      expect(screen.getAllByTestId("cell-maintenanceFee")[2]).toHaveAttribute("data-selected", "true");
    });
    // The originally-committed cells did NOT re-materialize.
    expect(screen.getAllByTestId("cell-airOwner")[0]).not.toHaveAttribute("data-selected", "true");
    expect(screen.getAllByTestId("cell-tnbOwner")[1]).not.toHaveAttribute("data-selected", "true");
  });

  it("colour fill persists", async () => {
    // Task 6: rental is read-only (no pointer handlers) — colour-fill is
    // exercised against tnbOwner (still editable) instead.
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");

    const tnbCell = screen.getByTestId("cell-tnbOwner");
    // no selection yet — swatches disabled
    expect(screen.getByTestId("colour-swatch-#7C3AED")).toBeDisabled();

    fireEvent.pointerDown(tnbCell);
    fireEvent.pointerUp(tnbCell);

    expect(screen.getByTestId("colour-swatch-#7C3AED")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("colour-swatch-#7C3AED"));

    await waitFor(() => {
      expect(saveCellColours).toHaveBeenCalledWith(
        "bills-grid",
        expect.objectContaining({ "apt-1:tnbOwner:2026-07-01": "#7C3AED" }),
      );
    });
    expect(screen.getByTestId("cell-tnbOwner").style.backgroundColor).not.toBe("");
  });

  it("hide column", async () => {
    // Task 6: rental is still a real column (read-only), so hide-column
    // mechanics are unaffected — this test is unchanged in intent, just
    // re-verified it still passes with rental as a LockedCell.
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    expect(screen.getAllByTestId("cell-rental").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("column-toggle-rental"));

    await waitFor(() => {
      expect(screen.queryByTestId("cell-rental")).toBeNull();
    });
    // other columns are untouched
    expect(screen.getAllByTestId("cell-cleaningOwner").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("column-toggle-rental"));

    await waitFor(() => {
      expect(screen.getAllByTestId("cell-rental").length).toBeGreaterThan(0);
    });
  });

  // ── crash-recovery (ui-9): the page's useStagedEdits buffer repaints the
  // <input> on mount. Task 4 retired the ctrl-DRAG FILL tests that used to
  // precede this (ctrl now = add-range multi-select, no write — covered by
  // "ctrl-drag adds range not fill" in excel-affordances.test.tsx and
  // "ctrl+click adds non-contiguous" above); crash-recovery is unrelated to
  // the pointer path and stays. ─────────────────────────────────────────────

  it("recovered buffer is visible — a pre-seeded staged-edits buffer repaints the input on mount (ui-9 crash recovery)", async () => {
    sessionStorage.setItem(stagedKey("2026-07-01"), JSON.stringify({ "apt-1:tnbOwner": "999" }));
    fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
    renderPage();

    await screen.findByText("A-1");
    // fixture's seed tnbTotal is "150.00" — the recovered "999" must win. Task 6: rental itself is now read-only/removed from Save (no <input>), so this crash-recovery repaint check retargets to tnbOwner (still editable).
    // The recovery cascade (fetchGrid resolves -> default-select effect ->
    // useStagedEdits resyncs to the fetched period -> GridTable remounts and
    // reads the resynced buffer) settles asynchronously AFTER "A-1" renders
    // from lastGood.rows, so this must retry via waitFor rather than assert
    // synchronously (flaky under parallel/full-suite load otherwise).
    await waitFor(() => {
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      expect(tnbInput).toHaveValue("999");
    });
  });

  // ── Task 3 (P1): Save confirmation dialog — Save OPENS a confirmation
  // listing affected units before any network write; Cancel is fully inert;
  // Confirm delegates to the unchanged handleSave persist path. ────────────
  describe("Save confirmation dialog", () => {
    it("clicking Save opens a confirmation listing the affected unit(s) and does NOT write yet", async () => {
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));

      fireEvent.click(saveButton);

      const list = await screen.findByTestId("save-confirm-list");
      expect(within(list).getByText("A-1")).toBeInTheDocument();

      // No write yet — the dialog only DEFERS handleSave.
      expect(saveEntry).not.toHaveBeenCalled();
    });

    it("Cancel is fully inert — no network write, staged buffer unchanged", async () => {
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      await screen.findByTestId("save-confirm-list");
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByTestId("save-confirm-list")).not.toBeInTheDocument();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(saveEntry).not.toHaveBeenCalled();
      // staged buffer unchanged — dirty count still reflects the un-saved edit
      expect(screen.getByRole("button", { name: /^save/i })).toHaveTextContent("Save (1)");
    });

    it("summary MARKS a paid apartment's staged edit as unsavable, and Save skips it (P1 review Finding B)", async () => {
      // apt-2 arrives ALREADY billed + paid, with a staged edit pre-seeded in
      // sessionStorage (an edit staged before the row was paid in an earlier
      // session/tab, or a race with a payment).
      //
      // Finding B's invariant is "the preview must never promise a write handleSave
      // skips", and it still holds exactly — Save must not touch apt-2. What changed is
      // HOW: the unit is now listed and MARKED rather than hidden.
      //
      // Hiding stopped being viable once the lock went per-cell. A settled unit can now
      // carry savable cells beside frozen ones, so dropping the whole unit would hide
      // real pending work — the settled-month dead end this suite's sibling file
      // (paid-month-amend.test.tsx) covers. Marking is also what this module already
      // does for every other unsavable case: a deleted unit (`unresolved`) and a
      // bearer-stranded cell are both shown and labelled, never silently omitted.
      sessionStorage.setItem(stagedKey("2026-07-01"), JSON.stringify({ "apt-2:tnbOwner": "999" }));
      fetchGrid.mockResolvedValue(
        gridResponse([
          makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
          // Task 7 (R7): billed alone no longer locks — paid required too.
          { ...tnbRow("apt-2", "A-2", "20.00", "2026-07-15T00:00:00.000Z"), paymentStatus: "paid" },
        ]),
      );
      saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (2)"));
      fireEvent.click(saveButton);

      const list = await screen.findByTestId("save-confirm-list");
      expect(within(list).getByText("A-1")).toBeInTheDocument();
      // Listed — but labelled with the RIGHT reason. "already paid" and "setting changed"
      // are not interchangeable: the second would send the admin to the Unit settings
      // drawer to fix a setting that was never wrong.
      expect(within(list).getByText("A-2")).toBeInTheDocument();
      const a2 = within(list).getByTestId("save-confirm-unit-A-2");
      expect(within(a2).getByTestId("save-confirm-skipped-tnbOwner"))
        .toHaveTextContent(/already paid, won't be saved/i);
      // Only A-1 is counted as a real pending write.
      expect(screen.getByText(/About to save changes to 1 unit/i)).toBeInTheDocument();

      // THE money assertion Finding B exists for, unchanged: apt-2 never reaches the wire.
      fireEvent.click(screen.getByTestId("save-confirm-btn"));
      await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
      expect(saveEntry).toHaveBeenCalledWith("apt-1", expect.objectContaining({ tnbTotal: "1500" }));
      expect(saveEntry).not.toHaveBeenCalledWith("apt-2", expect.anything());

      sessionStorage.removeItem(stagedKey("2026-07-01"));
    });

    // Task 7 (spec R7 — unlock predicate): the mirror image of the test above
    // — a billed-but-UNPAID apartment's staged edit must be INCLUDED in the
    // summary (billedApartmentIds no longer excludes it), and Save must
    // actually persist it, since R7 unlocks a billed-unpaid row for amend/re-Bill.
    it("summary includes a billed-but-unpaid apartment's staged edit, and Save persists it (R7 unlock)", async () => {
      sessionStorage.setItem(stagedKey("2026-07-01"), JSON.stringify({ "apt-2:tnbOwner": "999" }));
      fetchGrid.mockResolvedValue(
        gridResponse([
          makeRow({ apartmentId: "apt-1", unitCode: "A-1" }),
          // billed but UNPAID (tnbRow's default paymentStatus) — must unlock per R7.
          tnbRow("apt-2", "A-2", "20.00", "2026-07-15T00:00:00.000Z"),
        ]),
      );
      saveEntry.mockResolvedValue({ id: "entry-2", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      const list = await screen.findByTestId("save-confirm-list");
      expect(within(list).getByText("A-2")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("save-confirm-btn"));
      await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
      expect(saveEntry).toHaveBeenCalledWith(
        "apt-2",
        expect.objectContaining({ period: "2026-07-01", tnbTotal: "999" }),
      );

      sessionStorage.removeItem(stagedKey("2026-07-01"));
    });

    it("Confirm delegates to the existing persist path — saveEntry fires and a Saved toast shows", async () => {
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      await screen.findByTestId("save-confirm-list");
      fireEvent.click(screen.getByTestId("save-confirm-btn"));

      await waitFor(() => {
        expect(saveEntry).toHaveBeenCalledTimes(1);
      });
      expect(saveEntry).toHaveBeenCalledWith(
        "apt-1",
        expect.objectContaining({ period: "2026-07-01", tnbTotal: "1500" }),
      );
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Saved.");
      });
    });

    it("names the exact changed cell + value, not a bare count", async () => {
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      const unit = await screen.findByTestId("save-confirm-unit-A-1");
      expect(within(unit).getByText("TNB Owner")).toBeInTheDocument();
      expect(within(unit).getByText("1500")).toBeInTheDocument();
    });

    it("per-unit Clear discards only that unit's unsaved edits — no write; clearing the last unit closes the dialog", async () => {
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      saveEntry.mockResolvedValue({ id: "entry-1", updatedAt: "2026-07-02T00:00:00.000Z" });
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      fireEvent.change(tnbInput, { target: { value: "1500" } });

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      await screen.findByTestId("save-confirm-list");
      fireEvent.click(screen.getByTestId("save-confirm-clear-A-1"));

      // Last unit cleared → dialog closes, nothing written, buffer emptied
      // (Save button falls back to the disabled clean state).
      await waitFor(() => {
        expect(screen.queryByTestId("save-confirm-list")).not.toBeInTheDocument();
      });
      expect(saveEntry).not.toHaveBeenCalled();
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /^save/i });
        expect(btn).toBeDisabled();
        expect(btn).not.toHaveTextContent("(1)");
      });
    });

    it("per-unit Clear also reverts the typed value IN the grid cell, not just the drawer buffer", async () => {
      // Regression: Clear unstaged the page buffer but left GridTable's
      // internalStaged keystroke echo (top display precedence) painting the
      // typed value, so the cell kept showing "1500" after Clear.
      fetchGrid.mockResolvedValue(gridResponse([makeRow({ apartmentId: "apt-1", unitCode: "A-1" })]));
      renderPage();

      await screen.findByText("A-1");
      const tnbInput = within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox");
      expect(tnbInput).toHaveValue("150.00"); // makeRow seed (saved value)
      fireEvent.change(tnbInput, { target: { value: "1500" } });
      expect(tnbInput).toHaveValue("1500");

      const saveButton = screen.getByRole("button", { name: /^save/i });
      await waitFor(() => expect(saveButton).toHaveTextContent("Save (1)"));
      fireEvent.click(saveButton);

      await screen.findByTestId("save-confirm-list");
      fireEvent.click(screen.getByTestId("save-confirm-clear-A-1"));

      // The grid cell repaints its SAVED value (150.00) — the echo is cleared
      // too, so the typed "1500" is gone from the <input>, not just the drawer.
      await waitFor(() => {
        expect(within(screen.getAllByTestId("cell-tnbOwner")[0]).getByRole("textbox")).toHaveValue("150.00");
      });
    });
  });
});
