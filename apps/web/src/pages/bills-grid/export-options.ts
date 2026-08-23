import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { GridRow } from "@/api/bills-grid";
import type { OwnerDetail } from "@/api/parties-detail";
import { API_BASE, apiFetch } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";
import type { GridColumn } from "./columns";
import { buildGridWorkbook } from "./export-xlsx";
import { projectedOwnerPayout } from "./owner-payout";
import { isApplicable } from "./cell-applicability";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function amount(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function periodLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function nonSst(total: string, withSst: string) {
  return amount(total) - amount(withSst);
}

/** One unit per row, retaining every money category plus payout workflow data. */
function payoutSummaryRow(row: GridRow, owner: OwnerDetail | null) {
  const rental = row.subRows.reduce((sum, item) => sum + amount(item.rental), 0);
  const deposit = row.subRows.reduce((sum, item) => sum + amount(item.deposit), 0);
  const cleaning = amount(row.cleaningRecurringAmount ?? row.entry?.cleaning);
  const cleaningOwner = isApplicable(row, "cleaningOwner") ? cleaning : 0;
  const tnb = amount(row.entry?.tnbTotal);
  const tnbTenant = isApplicable(row, "tnbTenant") ? tnb : 0;
  const tnbOwner = isApplicable(row, "tnbOwner") ? tnb : 0;
  const water = amount(row.entry?.airSelangor);
  const waterTenant = isApplicable(row, "airTenant") ? water : 0;
  const waterOwner = isApplicable(row, "airOwner") ? water : 0;
  const wifi = amount(row.wifiRecurringAmount ?? row.entry?.wifi);
  const wifiOwner = isApplicable(row, "wifiOwner") ? wifi : 0;
  const maintenance = amount(row.entry?.maintenanceFee);
  return {
    Property: row.propertyName,
    Unit: row.unitCode,
    Owner: row.ownerName ?? "",
    "Tenant(s)": row.subRows.map((item) => item.partyName).filter(Boolean).join(", "),
    "Bank Name": owner?.bank.name ?? "",
    "Bank Owner Name": owner?.bank.accountHolder ?? "",
    "Bank Account Number": owner?.bank.accountNumber ?? "",
    Rental: rental,
    Deposit: deposit,
    "Cleaning Owner": cleaningOwner,
    "TNB Owner": tnbOwner,
    "TNB Tenant": tnbTenant,
    "Previous Meter (kWh)": row.subRows.map((item) => item.previousKwh).filter((value) => value != null && value !== "").join(", "),
    "Current Meter (kWh)": row.subRows.map((item) => item.currentKwh).filter((value) => value != null && value !== "").join(", "),
    "TNB Meter Amount": row.subRows.reduce((sum, item) => sum + amount(item.amount), 0),
    "Water Owner": waterOwner,
    "Water Tenant": waterTenant,
    "WiFi Owner": wifiOwner,
    "Maintenance Fee": maintenance,
    "Recurring Owner": amount(row.recurring?.owner.total),
    "Recurring Tenant": amount(row.recurring?.tenant.total),
    "Tenant Expenses Non SST": nonSst(row.expenses.tenant.total, row.expenses.tenant.withSstTotal),
    "Tenant Expenses With SST": amount(row.expenses.tenant.withSstTotal),
    "Owner Expenses Non SST": nonSst(row.expenses.owner.total, row.expenses.owner.withSstTotal),
    "Owner Expenses With SST": amount(row.expenses.owner.withSstTotal),
    "TA (WITH SST)": amount(
      String(Number(row.agreementFees?.new.amount ?? 0) + Number(row.agreementFees?.renewal.amount ?? 0)),
    ),
    "Management Fee With SST": amount(row.managementFee?.total),
    "Owner Payout": projectedOwnerPayout(row),
    "Payout Status": row.ownerPartyId ? (row.ownerPayoutStatus ?? "draft") : "No owner",
  };
}

export async function exportGridPdf(rows: GridRow[], columns: GridColumn[], periods: string[], filename: string) {
  const workbook = await buildGridWorkbook(rows, columns, periods);
  const sheet = workbook.worksheets[0];
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [1190, 842];
  const margin = 24;
  const rowHeight = 15;
  const maxColumns = sheet.columnCount;
  const cellWidth = (pageSize[0] - margin * 2) / Math.max(maxColumns, 1);
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (y < margin + rowHeight) { page = pdf.addPage(pageSize); y = pageSize[1] - margin; }
    for (let index = 1; index <= maxColumns; index += 1) {
      const raw = row.getCell(index).text || "";
      const text = raw.length > 20 ? `${raw.slice(0, 19)}…` : raw;
      page.drawText(text, { x: margin + (index - 1) * cellWidth + 2, y: y - 10, size: 5.5, font: rowNumber <= 2 ? bold : font, color: rgb(0.03, 0.17, 0.31), maxWidth: cellWidth - 4 });
      page.drawRectangle({ x: margin + (index - 1) * cellWidth, y: y - rowHeight, width: cellWidth, height: rowHeight, borderWidth: 0.35, borderColor: rgb(0.45, 0.55, 0.65) });
    }
    y -= rowHeight;
  });
  const pdfBytes = await pdf.save();
  const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  download(new Blob([pdfBuffer], { type: "application/pdf" }), filename);
}

export async function exportPayoutReportsZip(rows: GridRow[], billingMonth: string, filename: string) {
  const eligible = rows.filter((row) => row.ownerPartyId);
  if (!eligible.length) throw new Error("No owner payout reports to export.");
  const zip = new JSZip();
  const token = getAdminToken();
  for (const row of eligible) {
    const qs = new URLSearchParams({ ownerPartyId: row.ownerPartyId!, billingMonth, apartmentId: row.apartmentId });
    const response = await fetch(`${API_BASE}/owner-billing/statements/live-pdf?${qs}`, { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!response.ok) throw new Error(`Could not export payout report for ${row.propertyName} ${row.unitCode}.`);
    zip.file(safeFilename(`${row.propertyName} ${row.unitCode} ${periodLabel(billingMonth)} OWNER INCOME REPORT.pdf`).toUpperCase(), await response.blob());
  }
  download(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), filename);
}

export async function exportPayoutSummaryXlsx(rows: GridRow[], billingMonth: string, filename: string) {
  if (!rows.length) throw new Error("Nothing to export.");
  const ownerIds = [...new Set(rows.map((row) => row.ownerPartyId).filter((id): id is string => !!id))];
  const owners = new Map<string, OwnerDetail>();
  await Promise.all(ownerIds.map(async (id) => {
    const response = await apiFetch<{ data: OwnerDetail }>(`/parties/owners/${id}`);
    owners.set(id, response.data);
  }));
  const records = rows.map((row) => payoutSummaryRow(row, row.ownerPartyId ? owners.get(row.ownerPartyId) ?? null : null));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Payout Summary");
  const headers = Object.keys(records[0]);
  sheet.addRow([`OWNER PAYOUT SUMMARY · ${periodLabel(billingMonth).toUpperCase()}`]);
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.addRow(headers);
  records.forEach((record) => sheet.addRow(headers.map((header) => record[header as keyof typeof record])));
  sheet.views = [{ state: "frozen", ySplit: 2, xSplit: 2 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFF3D493" }, size: 16 };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
  sheet.getRow(2).font = { bold: true, color: { argb: "FF082B4F" } };
  sheet.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDFE9F3" } };
  sheet.columns.forEach((column, index) => { column.width = index < 7 ? 24 : 17; });
  for (let rowIndex = 3; rowIndex <= sheet.rowCount; rowIndex += 1) {
    for (let columnIndex = 8; columnIndex <= headers.length - 1; columnIndex += 1) {
      if (!headers[columnIndex - 1].includes("Meter (kWh)")) sheet.getRow(rowIndex).getCell(columnIndex).numFmt = '"RM" #,##0.00';
    }
  }
  const total = sheet.addRow(headers.map((header, index) => index < 7 || header.includes("Meter (kWh)") || header === "Payout Status" ? (index === 0 ? "TOTAL" : "") : { formula: `SUM(${sheet.getColumn(index + 1).letter}3:${sheet.getColumn(index + 1).letter}${sheet.rowCount})` }));
  total.font = { bold: true, color: { argb: "FFF3D493" } };
  total.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
  download(new Blob([await workbook.xlsx.writeBuffer()], { type: XLSX_MIME }), filename);
}
