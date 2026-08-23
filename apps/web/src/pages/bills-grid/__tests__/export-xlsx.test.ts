// UI Task 8 — programmatic exceljs exporter (merged band headers, compact
// prior strips, empty-grid guard). Pure data module: no JSX, no fetch, no
// store write — builds an ExcelJS.Workbook from the SAME CURRENT_COLUMNS
// source of truth the grid header renders from (columns.ts).
import { describe, expect, it } from "vitest";
import { buildGridWorkbook } from "../export-xlsx";
import { CURRENT_COLUMNS } from "../columns";
import type { GridRow, GridEntryDto, GridBearerConfigDto, PriorMonthStrip } from "@/api/bills-grid";

// ── fixtures (mirrors grid-table.test.tsx's helpers — full valid shapes only,
// never a simplified GridRow that would mask a §16 contract regression) ──────

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null,
    tnbTotal: null,
    airSelangor: null,
    wifi: null,
    maintenanceFee: null,
    readingDate: null,
    paymentStatus: "unpaid",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lockState: "draft",
    ...partial,
  };
}

function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "0.00",
    isLocked: false,
    ...partial,
  };
}

function row(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "PROP1",
    propertyName: "Sunway Vista",
    entryId: null,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: makeEntry(),
    bearerConfig: makeBearerConfig(),
    expenses: { tenant: { total: "0.00", withSstTotal: "0.00", count: 0 }, owner: { total: "0.00", withSstTotal: "0.00", count: 0 } },
    attachments: [],
    // Task 6: grain-lock is now re-based on isWholeUnit (server-derived from
    // Apartment.listingMode), NOT entry.rental (removed). Default false
    // (partitioned) mirrors the old default fixture shape (entry: null /
    // entry.rental: null used to imply partitioned).
    isWholeUnit: false,
    ...partial,
  };
}

describe("bills-grid export", () => {
  it("omits the removed Cleaning Tenant and WiFi Tenant columns", async () => {
    expect(CURRENT_COLUMNS.map((column) => column.id)).not.toContain("cleaningTenant");
    expect(CURRENT_COLUMNS.map((column) => column.id)).not.toContain("wifiTenant");

    const wb = await buildGridWorkbook([row()], CURRENT_COLUMNS, ["2026-07-01"]);
    const ws = wb.getWorksheet("Tenant & Owner Billing")!;
    const headers = ws.getRow(2).values as unknown[];
    expect(headers.filter((value) => value === "Tenant")).toHaveLength(3);
  });

  it("band headers: TNB spans previousKwh..amount as a merged range", async () => {
    const wb = await buildGridWorkbook([row({ apartmentId: "a1", unitCode: "PV9 A-13-13" })], CURRENT_COLUMNS, ["2026-07-01"]);
    const ws = wb.getWorksheet("Tenant & Owner Billing")!;
    const merges = (ws.model as { merges?: string[] }).merges ?? [];
    const tnbStart = CURRENT_COLUMNS.findIndex((column) => column.id === "tnbOwner") + 1;
    const tnbCell = `${ws.getColumn(tnbStart).letter}1`;
    expect(merges.some((m) => m.startsWith(`${tnbCell}:`))).toBe(true);
    expect(ws.getCell(tnbCell).value).toBe("TNB");
  });

  it("month strips: 3 periods → one current band + two compact prior strips", async () => {
    const priorMonths: PriorMonthStrip[] = [
      { period: "2026-06-01", cleaning: "50.00", tnb: "120.00", air: "30.00", wifi: "60.00", others: "10.00" },
      { period: "2026-05-01", cleaning: "45.00", tnb: "110.00", air: "28.00", wifi: "55.00", others: "8.00" },
    ];
    const wb = await buildGridWorkbook(
      [row({ apartmentId: "a1", unitCode: "PV9 A-13-13", priorMonths })],
      CURRENT_COLUMNS,
      ["2026-07-01", "2026-06-01", "2026-05-01"],
    );
    const ws = wb.getWorksheet("Tenant & Owner Billing")!;

    // Row 3 = the current-period unit row (unitCode in column A).
    expect(ws.getCell(3, 1).value).toBe("PV9 A-13-13");

    // Two compact prior-strip rows follow, latest-first, one per prior
    // period, carrying the five PRIOR_MONTH_COLUMNS values (cleaning/tnb/
    // air/wifi/others) — never rental, meter columns, or an owner/tenant
    // split (R5).
    expect(ws.getCell(4, 1).value).toBe("2026-06-01");
    expect(ws.getCell(4, 2).value).toBe("50.00"); // cleaning
    expect(ws.getCell(4, 4).value).toBe("120.00"); // tnb
    expect(ws.getCell(4, 8).value).toBe("30.00"); // air
    expect(ws.getCell(4, 10).value).toBe("60.00"); // wifi
    expect(ws.getCell(4, 12).value).toBe("10.00"); // others

    expect(ws.getCell(5, 1).value).toBe("2026-05-01");
    expect(ws.getCell(5, 4).value).toBe("110.00");

    // No third data/strip row for this single-apartment fixture.
    expect(ws.getCell(6, 1).value).toBeNull();

    const merges = (ws.model as { merges?: string[] }).merges ?? [];
    expect(merges.some((m) => m.startsWith("D4:"))).toBe(true); // prior TNB strip is a merged 4-col range
  });

  it("empty grid: buildGridWorkbook refuses zero rows so the button can disable", async () => {
    await expect(buildGridWorkbook([], CURRENT_COLUMNS, ["2026-07-01"])).rejects.toThrow(/Nothing to export/);
  });

  it("worksheet is named 'Tenant & Owner Billing' (page deliverable — user amendment)", async () => {
    const wb = await buildGridWorkbook([row()], CURRENT_COLUMNS, ["2026-07-01"]);
    expect(wb.worksheets).toHaveLength(1);
    expect(wb.worksheets[0].name).toBe("Tenant & Owner Billing");
  });

  // user decision — export mirrors the on-screen view (was: export dropped
  // the R7 auto-fill, showing blank where the screen showed the recurring
  // default) ──────────────────────────────────────────────────────────────
  it("export mirrors on-screen cleaning: an unsaved month seeds cleaningOwner from bearerConfig.cleaningRecurringAmount, not blank", async () => {
    const wb = await buildGridWorkbook(
      [
        row({
          apartmentId: "a1",
          unitCode: "PV9 A-13-13",
          entry: null, // never Saved — no entry.cleaning to read
          bearerConfig: makeBearerConfig({ cleaningRecurringAmount: "100.00", cleaningBearer: "owner" }),
        }),
      ],
      CURRENT_COLUMNS,
      ["2026-07-01"],
    );
    const ws = wb.getWorksheet("Tenant & Owner Billing")!;
    const cleaningOwner = CURRENT_COLUMNS.findIndex((column) => column.id === "cleaningOwner") + 1;
    expect(ws.getCell(3, cleaningOwner).value).toBe(100);
  });

  it("export mirrors on-screen cleaning: a saved entry.cleaning still wins over the recurring default", async () => {
    const wb = await buildGridWorkbook(
      [
        row({
          apartmentId: "a1",
          unitCode: "PV9 A-13-13",
          entry: makeEntry({ cleaning: "80.00", cleaningBearer: "owner" }),
          bearerConfig: makeBearerConfig({ cleaningRecurringAmount: "100.00", cleaningBearer: "owner" }),
        }),
      ],
      CURRENT_COLUMNS,
      ["2026-07-01"],
    );
    const ws = wb.getWorksheet("Tenant & Owner Billing")!;
    const cleaningOwner = CURRENT_COLUMNS.findIndex((column) => column.id === "cleaningOwner") + 1;
    expect(ws.getCell(3, cleaningOwner).value).toBe(80);
  });

  // Review finding 7: the AIR bearer split is the whole point of the export's
  // `isUtilityTenantBorne` call — before 2026-08-14 this file kept its own copy of the
  // old `=== "tenant_direct"` literal, which is exactly how it drifted from the screen.
  // Derived from CURRENT_COLUMNS rather than a hard-coded index so inserting a column
  // cannot silently re-point these assertions at a neighbour.
  describe("AIR bearer split — the sheet must agree with the screen", () => {
    const colOf = (id: string) => CURRENT_COLUMNS.findIndex((c) => c.id === id) + 1;
    const DATA_ROW = 3;

    async function airCellsFor(airPattern: string) {
      const wb = await buildGridWorkbook(
        [
          row({
            apartmentId: "a1",
            unitCode: "PV9 A-13-13",
            entry: makeEntry({ airSelangor: "40.00", airPattern }),
            bearerConfig: makeBearerConfig({ airPattern }),
          }),
        ],
        CURRENT_COLUMNS,
        ["2026-07-01"],
      );
      const ws = wb.getWorksheet("Tenant & Owner Billing")!;
      return {
        owner: ws.getCell(DATA_ROW, colOf("airOwner")).value,
        tenant: ws.getCell(DATA_ROW, colOf("airTenant")).value,
      };
    }

    it('Tenant ("recharged") exports under the Tenant column', async () => {
      expect(await airCellsFor("recharged")).toEqual({ owner: null, tenant: 40 });
    });

    it('Owner ("absorbed") exports under the Owner column', async () => {
      expect(await airCellsFor("absorbed")).toEqual({ owner: 40, tenant: null });
    });

    it("never exports the same water bill on both sides", async () => {
      for (const p of ["absorbed", "recharged", "tenant_direct", "manager_advanced"]) {
        const cells = await airCellsFor(p);
        expect([cells.owner, cells.tenant].filter((v) => v != null), `airPattern=${p}`).toHaveLength(1);
      }
    });

    // The screen greys the TNB cell to "—" under "tenant pays directly" (the Bill discards
    // anything typed there — shapeUtilityPool zeroes the pool and the mint skips the
    // component), but the export emitted the amount anyway: a sheet claiming a TNB figure
    // for a unit where the grid shows none. Same missed gate the AIR hunk above fixed.
    it('tnbOwner: "tenant_direct" exports nothing, matching the greyed cell', async () => {
      const wb = await buildGridWorkbook(
        [
          row({
            apartmentId: "a1",
            unitCode: "PV9 A-13-13",
            entry: makeEntry({ tnbTotal: "500.00", tnbPattern: "tenant_direct" }),
            bearerConfig: makeBearerConfig({ tnbPattern: "tenant_direct" }),
          }),
        ],
        CURRENT_COLUMNS,
        ["2026-07-01"],
      );
      const ws = wb.getWorksheet("Tenant & Owner Billing")!;
      expect(ws.getCell(DATA_ROW, colOf("tnbOwner")).value).toBeNull();
    });

    it("exports TNB under exactly the active Owner/Tenant bearer column", async () => {
      for (const tnbPattern of ["absorbed", "recharged"]) {
        const wb = await buildGridWorkbook(
          [
            row({
              apartmentId: "a1",
              unitCode: "PV9 A-13-13",
              entry: makeEntry({ tnbTotal: "500.00", tnbPattern }),
              bearerConfig: makeBearerConfig({ tnbPattern }),
            }),
          ],
          CURRENT_COLUMNS,
          ["2026-07-01"],
        );
        const ws = wb.getWorksheet("Tenant & Owner Billing")!;
        const ownerValue = ws.getCell(DATA_ROW, colOf("tnbOwner")).value;
        const tenantValue = ws.getCell(DATA_ROW, colOf("tnbTenant")).value;
        expect([ownerValue, tenantValue], `tnbPattern=${tnbPattern}`).toEqual(
          tnbPattern === "absorbed" ? [500, null] : [null, 500],
        );
      }
    });
  });
});
