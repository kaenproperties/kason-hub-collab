import { useMemo } from "react";
import type { GridRow } from "@/api/bills-grid";
import type { StagedEdits } from "./use-staged-edits";
import type { ColumnId } from "./columns";
import { gridSubRowValue, gridUnitColumnValue } from "./export-xlsx";

type SummaryColumn = { label: string; ids: ColumnId[] };

const SUMMARY_COLUMNS: SummaryColumn[] = [
  { label: "Rental", ids: ["rental"] },
  { label: "Deposit", ids: ["deposit"] },
  { label: "Cleaning", ids: ["cleaningOwner"] },
  { label: "TNB", ids: ["tnbOwner", "tnbTenant", "amount"] },
  { label: "Water", ids: ["airOwner", "airTenant"] },
  { label: "WiFi", ids: ["wifiOwner"] },
  { label: "Maint Fee", ids: ["maintenanceFee"] },
  { label: "Recurring", ids: ["ownerRecurring", "tenantRecurring"] },
  { label: "Tenant Expenses", ids: ["tenantExpNonSst", "tenantExpWithSst"] },
  { label: "Owner Expenses", ids: ["ownerExpNonSst", "ownerExpWithSst"] },
  { label: "Management Fee", ids: ["managementFeeSst"] },
  { label: "Owner Payout", ids: ["ownerPayout"] },
];

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cellTotal(row: GridRow, columnId: ColumnId, staged: StagedEdits): number {
  if (columnId === "previousKwh" || columnId === "currentKwh") return 0;
  if (columnId === "amount") {
    return row.subRows.reduce((sum, sub) => {
      const key = `${sub.listingId}:${columnId}`;
      return sum + number(Object.prototype.hasOwnProperty.call(staged, key) ? staged[key] : gridSubRowValue(sub, columnId));
    }, 0);
  }
  const key = `${row.apartmentId}:${columnId}`;
  return number(Object.prototype.hasOwnProperty.call(staged, key) ? staged[key] : gridUnitColumnValue(row, columnId));
}

function categoryTotal(rows: GridRow[], column: SummaryColumn, staged: StagedEdits): number {
  return rows.reduce((sum, row) => sum + column.ids.reduce((part, id) => part + cellTotal(row, id, staged), 0), 0);
}

function money(value: number): string {
  return value.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function BillingSummaryTable({ rows, staged }: { rows: GridRow[]; staged: StagedEdits }) {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: GridRow[] }>();
    for (const row of rows) {
      const key = row.propertyId || row.propertyName;
      const group = map.get(key);
      if (group) group.rows.push(row);
      else map.set(key, { name: row.propertyName || "Unknown condo", rows: [row] });
    }
    return Array.from(map.entries());
  }, [rows]);

  if (rows.length === 0) return <div className="rounded-xl border border-[var(--border)] bg-white p-12 text-center text-lg text-muted-foreground">No apartments match the current filters.</div>;

  return (
    <div className="overflow-x-auto rounded-xl border-2 border-[var(--navy)] bg-white shadow-sm" data-testid="billing-summary-table">
      <table className="w-full min-w-[1500px] border-collapse text-[18px]">
        <thead>
          <tr className="bg-[var(--table-header-bg)] text-[var(--navy)]">
            <th className="sticky left-0 z-10 min-w-64 border-r-2 border-[var(--navy)] bg-[var(--table-header-bg)] px-4 py-4 text-left font-extrabold">Condo / Property</th>
            <th className="min-w-24 border-r border-[var(--border)] px-3 py-4 text-center font-extrabold">Units</th>
            {SUMMARY_COLUMNS.map((column) => <th key={column.label} className="min-w-32 border-r border-[var(--border)] px-3 py-4 text-center font-extrabold leading-tight">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.map(([key, group]) => (
            <tr key={key} className="border-t border-[var(--border)] hover:bg-[var(--page-bg)]">
              <th className="sticky left-0 z-[5] border-r-2 border-[var(--navy)] bg-white px-4 py-5 text-left font-extrabold text-[var(--navy)]">{group.name}</th>
              <td className="border-r border-[var(--border)] px-3 py-5 text-center font-bold">{group.rows.length}</td>
              {SUMMARY_COLUMNS.map((column) => <td key={column.label} className="border-r border-[var(--border)] px-3 py-5 text-center font-bold tabular-nums">{money(categoryTotal(group.rows, column, staged))}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-[var(--navy)] text-[var(--gold-light)]">
            <th className="sticky bottom-0 left-0 z-20 bg-[var(--navy)] px-4 py-4 text-left font-extrabold">GRAND TOTAL</th>
            <td className="sticky bottom-0 bg-[var(--navy)] px-3 py-4 text-center font-extrabold">{rows.length}</td>
            {SUMMARY_COLUMNS.map((column) => <td key={column.label} className="sticky bottom-0 bg-[var(--navy)] px-3 py-4 text-center font-extrabold tabular-nums">{money(categoryTotal(rows, column, staged))}</td>)}
          </tr>
        </tfoot>
      </table>
      <div className="border-t border-[var(--border)] bg-[var(--page-bg)] px-4 py-3 text-sm text-muted-foreground">Summary follows the current month and filters. Unsaved cell edits are included so you can check totals before Save.</div>
    </div>
  );
}
