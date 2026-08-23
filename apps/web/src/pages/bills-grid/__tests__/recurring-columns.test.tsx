// Recurring-charges (Task 8) — the read-only recurring summary columns + cleaning/WiFi flipped
// to non-editable. Mirrors grid-table.test.tsx's makeRow harness (valid GridRow shape).
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto } from "@/api/bills-grid";
import { GridTable } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null, tnbTotal: null, airSelangor: null, wifi: null, maintenanceFee: null, readingDate: null,
    paymentStatus: "unpaid", tnbPattern: "recharged", airPattern: "recharged",
    cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z", lockState: "draft", ...partial,
  };
}
function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return { tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner", cleaningRecurringAmount: "0.00", isLocked: false, ...partial };
}
function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1", unitCode: "PV9 A-13-13", propertyId: "PROP1", propertyName: "Sunway Vista",
    entryId: null, preview: null, previewError: null, warnings: [], subRows: [], billedAt: null,
    paymentStatus: "unpaid", priorMonths: [], entry: null, bearerConfig: makeBearerConfig(),
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [], isWholeUnit: false, ...partial,
  };
}

describe("recurring summary columns (Task 8)", () => {
  it("ownerRecurring/tenantRecurring show CUSTOM totals read-only with count badges; cleaning/WiFi excluded", () => {
    const row = makeRow({
      entryId: "E1",
      entry: makeEntry({ cleaning: "100.00", wifi: "50.00" }),
      recurring: { owner: { total: "120.00", count: 2 }, tenant: { total: "30.00", count: 1 } },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} onViewRecurring={() => {}} />);

    // Read-only recurring totals (owner 120 across 2, tenant 30 across 1).
    expect(screen.getByTestId("cell-ownerRecurring")).toHaveTextContent("120.00");
    expect(screen.getByTestId("cell-tenantRecurring")).toHaveTextContent("30.00");
    expect(screen.getByTestId("view-recurring-owner-badge")).toHaveTextContent("2");
    expect(screen.getByTestId("view-recurring-tenant-badge")).toHaveTextContent("1");

    // Recurring cells carry no editable textbox.
    expect(within(screen.getByTestId("cell-ownerRecurring")).queryByRole("textbox")).toBeNull();
    expect(within(screen.getByTestId("cell-tenantRecurring")).queryByRole("textbox")).toBeNull();

    // The recurring totals are NOT the cleaning/WiFi scalars (120/30 ≠ 100/50) — cleaning/WiFi
    // are excluded from these summary cells (R9).
    expect(screen.getByTestId("cell-ownerRecurring")).not.toHaveTextContent("100.00");
  });

  it("shows only owner Cleaning/WiFi columns, read-only when governed by an enabled recurring def", () => {
    const row = makeRow({
      entryId: "E1",
      entry: makeEntry({ cleaning: "100.00", wifi: "50.00", cleaningBearer: "owner", wifiBearer: "owner" }),
      bearerConfig: makeBearerConfig({ cleaningBearer: "owner", wifiBearer: "owner" }),
      cleaningRecurringLocked: true,
      wifiRecurringLocked: true,
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    for (const id of ["cell-cleaningOwner", "cell-wifiOwner"]) {
      expect(within(screen.getByTestId(id)).queryByRole("textbox"), `${id} must be read-only`).toBeNull();
    }
    expect(screen.queryByTestId("cell-cleaningTenant")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cell-wifiTenant")).not.toBeInTheDocument();
  });

  it("governed cell with NO entry (unopened month) shows the GENERATED amount, not '—'", () => {
    const row = makeRow({
      entryId: null,
      entry: null, // month not opened yet → no scalar
      bearerConfig: makeBearerConfig({ cleaningBearer: "owner", wifiBearer: "owner" }),
      cleaningRecurringLocked: true,
      wifiRecurringLocked: true,
      cleaningRecurringAmount: "100.00",
      wifiRecurringAmount: "80.00",
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // Read-only, but shows the generated amount from the recurring def (fix for "– instead of 100").
    expect(within(unitRow).getByTestId("cell-cleaningOwner")).toHaveTextContent("100.00");
    expect(within(unitRow).getByTestId("cell-wifiOwner")).toHaveTextContent("80.00");
    expect(within(unitRow).getByTestId("cell-cleaningOwner").querySelector("input")).toBeNull(); // still read-only
  });

  // 2026-08-06: maintenanceFee joined the governable scalars (client report — a saved
  // Maintenance recurring def neither locked nor showed in the grid until an unrelated
  // save opened the month).
  it("governed Maintenance on an UNOPENED month shows the generated amount read-only", () => {
    const scalarOff = { governed: false, amount: null, definitionId: null };
    const row = makeRow({
      entryId: null,
      entry: null, // month not opened yet — entry.maintenanceFee doesn't exist
      scalarRecurring: {
        CLEANING: scalarOff, WIFI: scalarOff, TNB: scalarOff, AIR: scalarOff,
        MAINTENANCE: { governed: true, amount: "300.00", definitionId: "def-m" },
      },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const cell = screen.getByTestId("cell-maintenanceFee");
    expect(cell).toHaveTextContent("300.00");
    expect(cell.querySelector("input")).toBeNull();
  });

  it("ungoverned Maintenance stays an editable per-month cell (legacy manual column)", () => {
    const scalarOff = { governed: false, amount: null, definitionId: null };
    const row = makeRow({
      entryId: "E1",
      entry: makeEntry(),
      scalarRecurring: { CLEANING: scalarOff, WIFI: scalarOff, TNB: scalarOff, AIR: scalarOff, MAINTENANCE: scalarOff },
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-maintenanceFee").querySelector("input")).not.toBeNull();
  });

  it("fixture WITHOUT scalarRecurring keeps Maintenance editable (absent-flag default inverts cleaning's)", () => {
    const row = makeRow({ entryId: "E1", entry: makeEntry() });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-maintenanceFee").querySelector("input")).not.toBeNull();
  });

  it("cleaning/WiFi cells become EDITABLE when the server says NOT governed (recurringLocked === false)", () => {
    const row = makeRow({
      entryId: "E1",
      entry: makeEntry({ cleaning: "0.00", wifi: "0.00", cleaningBearer: "owner", wifiBearer: "owner" }),
      bearerConfig: makeBearerConfig({ cleaningBearer: "owner", wifiBearer: "owner" }),
      cleaningRecurringLocked: false,
      wifiRecurringLocked: false,
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    const unitRow = screen.getByRole("row", { name: /PV9 A-13-13/ });
    // Owner side is applicable (bearer owner) → an editable textbox appears for the per-month value.
    expect(within(unitRow).getByTestId("cell-cleaningOwner").querySelector("input"), "cleaning editable when ungoverned").not.toBeNull();
    expect(within(unitRow).getByTestId("cell-wifiOwner").querySelector("input"), "wifi editable when ungoverned").not.toBeNull();
  });
});
