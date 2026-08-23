import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { GridToolbar } from "../grid-toolbar";
import { CURRENT_COLUMNS } from "../columns";

function makeProps(overrides: Partial<React.ComponentProps<typeof GridToolbar>> = {}): React.ComponentProps<typeof GridToolbar> {
  return {
    periods: ["2026-07-01"], selectedPeriods: ["2026-07-01"], onPeriodsChange: vi.fn(),
    anchorMonth: "2026-07-01", currentBillingMonth: "2026-07-01",
    onStepMonth: vi.fn(), onAnchorMonthChange: vi.fn(),
    properties: [], propertyId: "all", onPropertyChange: vi.fn(),
    dirtyCount: 0, onSave: vi.fn(), canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0, onUndo: vi.fn(), onRedo: vi.fn(), selectedRowCount: 0, onBill: vi.fn(), canBillPeriod: true,
    canExport: false, onExport: vi.fn(),
    columnFilters: {}, onColumnFilterChange: vi.fn(),
    dateRange: { from: null, to: null }, onDateRangeChange: vi.fn(),
    hasSelection: false, onApplyColour: vi.fn(),
    columns: CURRENT_COLUMNS, hiddenColumns: [], onToggleColumn: vi.fn(),
    showVacant: false, onToggleShowVacant: vi.fn(),
    ...overrides,
  };
}

function renderToolbar(overrides: Partial<React.ComponentProps<typeof GridToolbar>> = {}) {
  return render(<GridToolbar {...makeProps(overrides)} />);
}

describe("GridToolbar colour filter", () => {
  it("allows multiple automatic billing colours to be selected together", () => {
    function Harness() {
      const [filters, setFilters] = React.useState<Array<"saved" | "billed-unpaid" | "paid" | "changed">>([]);
      return <GridToolbar {...makeProps({ colourFilters: filters, onColourFiltersChange: setFilters })} />;
    }
    render(<Harness />);
    expect(screen.getByRole("checkbox", { name: "All colours" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Filter colour Yellow/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Filter colour Red/ }));
    expect(screen.getByRole("checkbox", { name: /Filter colour Yellow/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Filter colour Red/ })).toBeChecked();
    expect(screen.getByText("2 colours selected")).toBeInTheDocument();
  });
});

// Regression (punch-list Item 3): in fullscreen the toolbar renders INSIDE the
// grid-region div, which owns a NATIVE keydown listener (useGridKeyboard) that
// intercepts Backspace/Delete and preventDefaults them — making the filter
// inputs impossible to edit. The fix attaches a native stopPropagation listener
// ON each filter input so the keystroke never climbs to the grid. (A React
// onKeyDown would fire too late — native ancestor listeners run first.)
describe("GridToolbar filter inputs — fullscreen keydown isolation", () => {
  function renderInGridRegion() {
    const gridNativeKeydown = vi.fn();
    function Fullscreen() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        const el = ref.current!;
        // Mirror useGridKeyboard: a native ancestor listener that would clear a
        // cell and preventDefault the browser's own Backspace behaviour.
        const handler = (e: KeyboardEvent) => {
          gridNativeKeydown(e.key);
          e.preventDefault();
        };
        el.addEventListener("keydown", handler);
        return () => el.removeEventListener("keydown", handler);
      }, []);
      return (
        <div ref={ref} data-testid="grid-region">
          <GridToolbar {...makeProps()} />
        </div>
      );
    }
    render(<Fullscreen />);
    return { gridNativeKeydown };
  }

  it("Backspace in the unit-code filter does NOT reach the grid's native keydown listener", () => {
    const { gridNativeKeydown } = renderInGridRegion();
    fireEvent.keyDown(screen.getByPlaceholderText("Unit, name, or phone"), { key: "Backspace" });
    expect(gridNativeKeydown).not.toHaveBeenCalled();
  });

  it("Backspace in the date-range inputs does NOT reach the grid's native keydown listener", () => {
    const { gridNativeKeydown } = renderInGridRegion();
    fireEvent.keyDown(screen.getByLabelText("Date range from"), { key: "Backspace" });
    fireEvent.keyDown(screen.getByLabelText("Date range to"), { key: "Backspace" });
    expect(gridNativeKeydown).not.toHaveBeenCalled();
  });

  it("control: a keystroke originating on the grid region itself DOES reach the grid listener (guard is input-scoped, not blanket)", () => {
    const { gridNativeKeydown } = renderInGridRegion();
    fireEvent.keyDown(screen.getByTestId("grid-region"), { key: "Backspace" });
    expect(gridNativeKeydown).toHaveBeenCalledWith("Backspace");
  });

  // Review #1 regression guard: the guard stops ONLY the keys the grid hijacks.
  // Cmd/Ctrl+K (the global search palette) and other non-hijacked keys MUST keep
  // bubbling — a blanket stopPropagation would break global search while a filter
  // input is focused. (The real handler is on `document`, above grid-region, so
  // reaching the grid-region ancestor is a valid proxy for reaching `document`.)
  it("Cmd/Ctrl+K typed in the unit-code filter STILL bubbles past the grid (global search not blocked)", () => {
    const { gridNativeKeydown } = renderInGridRegion();
    fireEvent.keyDown(screen.getByPlaceholderText("Unit, name, or phone"), { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByPlaceholderText("Unit, name, or phone"), { key: "k", ctrlKey: true });
    expect(gridNativeKeydown).toHaveBeenCalledWith("k");
    expect(gridNativeKeydown).toHaveBeenCalledTimes(2);
  });
});

describe("GridToolbar fullscreen removal", () => {
  it("does not render Fullscreen controls", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: /fullscreen/i })).not.toBeInTheDocument();
  });
});

describe("GridToolbar control alignment", () => {
  it("uses one 40px control height and one bottom baseline across filters, views and actions", () => {
    renderToolbar({
      viewControls: <div data-testid="test-view-control" className="h-10" />,
    });

    const exactHeightControls = [
      screen.getByTestId("anchor-prev-month"),
      screen.getByTestId("anchor-month-input"),
      screen.getByTestId("anchor-next-month"),
      screen.getByRole("combobox", { name: "Categorize" }),
      screen.getByPlaceholderText("Unit, name, or phone"),
      screen.getByLabelText("Filter by colour"),
      screen.getByLabelText("Filter owner payout status"),
      screen.getByLabelText("Date range from"),
      screen.getByLabelText("Date range to"),
      screen.getByTestId("show-vacant-toggle").closest("label")!,
      screen.getByTestId("grid-undo"),
      screen.getByTestId("grid-redo"),
      screen.getByRole("button", { name: "Save" }),
      screen.getByRole("button", { name: "Bill" }),
      screen.getByRole("button", { name: /Export/ }),
    ];

    for (const control of exactHeightControls) {
      expect(control).toHaveClass("h-10");
    }

    expect(screen.getByTestId("hide-column-menu").querySelector("summary")).toHaveClass("h-10");
    expect(screen.getByTestId("grid-view-controls")).toHaveClass("self-end");
    expect(screen.getByTestId("grid-toolbar-actions")).toHaveClass("h-10", "self-end");
  });
});

describe("GridToolbar permission controls", () => {
  it("does not expose edit, save, bill or export actions when the user lacks those permissions", () => {
    renderToolbar({
      canEditAction: false,
      canSaveAction: false,
      canBillAction: false,
      canExportAction: false,
      dirtyCount: 2,
      selectedRowCount: 2,
      canExport: true,
    });

    expect(screen.queryByTestId("colour-fill-swatches")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grid-undo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bill/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Export")).not.toBeInTheDocument();

    // Read-only navigation and filters remain available.
    expect(screen.getByTestId("anchor-month-input")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Unit, name, or phone")).toBeInTheDocument();
  });
});

describe("GridToolbar billing-month navigator", () => {
  it("prev/next arrows step the anchor by ∓1 month", () => {
    const onStepMonth = vi.fn();
    renderToolbar({ onStepMonth });
    fireEvent.click(screen.getByTestId("anchor-prev-month"));
    expect(onStepMonth).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByTestId("anchor-next-month"));
    expect(onStepMonth).toHaveBeenCalledWith(1);
  });

  it("the month input jumps to any month (normalised to first-of-month)", () => {
    const onAnchorMonthChange = vi.fn();
    renderToolbar({ onAnchorMonthChange });
    fireEvent.change(screen.getByTestId("anchor-month-input"), { target: { value: "2026-08" } });
    expect(onAnchorMonthChange).toHaveBeenCalledWith("2026-08-01");
  });

  it("labels a PAST anchor as settled/view-only and offers Jump to current", () => {
    const onAnchorMonthChange = vi.fn();
    renderToolbar({ anchorMonth: "2026-06-01", currentBillingMonth: "2026-07-01", onAnchorMonthChange });
    expect(screen.getByTestId("anchor-status-pill")).toHaveTextContent("Settled");
    fireEvent.click(screen.getByTestId("anchor-jump-current"));
    expect(onAnchorMonthChange).toHaveBeenCalledWith("2026-07-01");
  });

  it("labels a FUTURE anchor as upcoming/prepare", () => {
    renderToolbar({ anchorMonth: "2026-08-01", currentBillingMonth: "2026-07-01" });
    expect(screen.getByTestId("anchor-status-pill")).toHaveTextContent("Upcoming");
  });

  it("on the CURRENT month shows no Jump-to-current and enables Bill", () => {
    renderToolbar({ anchorMonth: "2026-07-01", currentBillingMonth: "2026-07-01", selectedRowCount: 2, canBillPeriod: true });
    expect(screen.queryByTestId("anchor-jump-current")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bill (2)" })).toBeEnabled();
  });

  it("gates Bill off a non-current anchor even with rows selected", () => {
    renderToolbar({ anchorMonth: "2026-06-01", currentBillingMonth: "2026-07-01", selectedRowCount: 2, canBillPeriod: false });
    expect(screen.getByRole("button", { name: "Bill (2)" })).toBeDisabled();
    expect(screen.getByTestId("bill-period-locked")).toBeInTheDocument();
  });
});
