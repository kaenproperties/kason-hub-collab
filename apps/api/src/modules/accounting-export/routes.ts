import { Hono } from "hono";
import ExcelJS from "exceljs";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";

const routes = new Hono<{ Variables: { session: SessionPayload } }>();
routes.use("*", requirePermission("accounting.export"));

const money = (value: unknown) => value == null ? null : Number(value);
const iso = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : "";

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width?: number }>, rows: Record<string, unknown>[]) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({ ...column, width: column.width ?? 18 }));
  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(columns.length).letter}1` };
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: "FFF3D493" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: "top", wrapText: true };
  });
  for (const column of sheet.columns) {
    if (/amount|total|subtotal|sst|outstanding|debit|credit|balance/i.test(String(column.key))) {
      column.numFmt = '"RM "#,##0.00;[Red]-"RM "#,##0.00';
    }
  }
}

routes.get("/all-transactions.xlsx", async (c) => {
  const { orgId } = c.get("session");
  const db = getDb();
  const from = c.req.query("from") ? new Date(`${c.req.query("from")}T00:00:00.000Z`) : undefined;
  const to = c.req.query("to") ? new Date(`${c.req.query("to")}T23:59:59.999Z`) : undefined;
  const dateRange = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  const [documents, charges, payments, expenses, ownerLedger, bankTransactions] = await Promise.all([
    db.billingDocument.findMany({
      where: { organizationId: orgId, ...(dateRange ? { issuedAt: dateRange } : {}) },
      orderBy: { issuedAt: "asc" },
      include: { lines: true },
    }),
    db.charge.findMany({
      where: { organizationId: orgId, ...(dateRange ? { createdAt: dateRange } : {}) },
      orderBy: { createdAt: "asc" },
      include: { party: { select: { displayName: true } }, category: { select: { name: true, code: true } }, unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } } },
    }),
    db.payment.findMany({
      where: { organizationId: orgId, ...(dateRange ? { receivedAt: dateRange } : {}) },
      orderBy: { receivedAt: "asc" },
      include: { party: { select: { displayName: true } }, allocations: { include: { charge: { select: { chargeNumber: true, description: true } } } } },
    }),
    db.supplierExpense.findMany({
      where: { organizationId: orgId, ...(dateRange ? { expenseDate: dateRange } : {}) },
      orderBy: { expenseDate: "asc" }, include: { allocations: true },
    }),
    db.ownerLedgerEntry.findMany({
      where: { organizationId: orgId, ...(dateRange ? { transactionDate: dateRange } : {}) },
      orderBy: { transactionDate: "asc" },
    }),
    db.bankReconciliationTransaction.findMany({
      where: { organizationId: orgId, ...(dateRange ? { transactionDate: dateRange } : {}) },
      orderBy: [{ transactionDate: "asc" }, { createdAt: "asc" }],
      include: { account: { select: { bankName: true, nickname: true, maskedAccountNumber: true } } },
    }),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KAEN Properties";
  workbook.created = new Date();

  addSheet(workbook, "Documents", [
    { header: "Issued", key: "issued" }, { header: "Document", key: "number", width: 24 },
    { header: "Type", key: "type" }, { header: "Counterparty", key: "counterparty" },
    { header: "Status", key: "status" }, { header: "Settlement", key: "settlement" },
    { header: "Billing Month", key: "month" }, { header: "Subtotal", key: "subtotal" },
    { header: "SST", key: "sst" }, { header: "Total", key: "total" },
  ], documents.map((d) => ({ issued: iso(d.issuedAt), number: d.documentNumber, type: d.docType, counterparty: d.counterpartyType, status: d.documentStatus, settlement: d.settlementStatus, month: iso(d.billingMonth), subtotal: money(d.subtotal), sst: money(d.sstAmount), total: money(d.total) })));

  addSheet(workbook, "Document Lines", [
    { header: "Document", key: "number", width: 24 }, { header: "Description", key: "description", width: 42 },
    { header: "Charge ID", key: "chargeId", width: 38 }, { header: "Amount", key: "amount" },
    { header: "SST Rate %", key: "sstRate" }, { header: "SST Amount", key: "sstAmount" },
  ], documents.flatMap((d) => d.lines.map((line) => ({ number: d.documentNumber, description: line.description, chargeId: line.chargeId ?? "", amount: money(line.amount), sstRate: money(line.sstRate), sstAmount: money(line.sstAmount) }))));

  addSheet(workbook, "Charges", [
    { header: "Created", key: "created" }, { header: "Charge", key: "number", width: 24 },
    { header: "Party", key: "party", width: 24 }, { header: "Property", key: "property", width: 24 },
    { header: "Unit", key: "unit" }, { header: "Category", key: "category", width: 26 },
    { header: "Description", key: "description", width: 42 }, { header: "Status", key: "status" },
    { header: "Due", key: "due" }, { header: "Amount", key: "amount" }, { header: "Outstanding", key: "outstanding" },
  ], charges.map((x) => ({ created: iso(x.createdAt), number: x.chargeNumber, party: x.party.displayName, property: x.unit?.apartment.property.name ?? "", unit: x.unit?.apartment.unitCode ?? "", category: x.category ? `${x.category.name} (${x.category.code})` : x.chargeType, description: x.description ?? "", status: x.status, due: iso(x.dueDate), amount: money(x.amount), outstanding: money(x.outstandingAmount) })));

  addSheet(workbook, "Payments", [
    { header: "Received", key: "received" }, { header: "Payment", key: "number", width: 24 },
    { header: "Party", key: "party", width: 24 }, { header: "Method", key: "method" }, { header: "Status", key: "status" },
    { header: "Reference", key: "reference", width: 32 }, { header: "Amount", key: "amount" },
  ], payments.map((x) => ({ received: iso(x.receivedAt), number: x.paymentNumber, party: x.party.displayName, method: x.paymentMethod, status: x.status, reference: x.externalReference ?? x.referenceNote ?? "", amount: money(x.amount) })));

  addSheet(workbook, "Payment Allocations", [
    { header: "Payment", key: "payment", width: 24 }, { header: "Allocated", key: "allocated" },
    { header: "Charge", key: "charge", width: 24 }, { header: "Description", key: "description", width: 42 },
    { header: "Amount", key: "amount" },
  ], payments.flatMap((p) => p.allocations.map((a) => ({ payment: p.paymentNumber, allocated: iso(a.allocatedAt), charge: a.charge.chargeNumber, description: a.charge.description ?? "", amount: money(a.allocatedAmount) }))));

  addSheet(workbook, "Supplier Expenses", [
    { header: "Date", key: "date" }, { header: "Expense", key: "number", width: 22 }, { header: "Supplier", key: "supplier", width: 24 },
    { header: "Reference", key: "reference" }, { header: "Description", key: "description", width: 42 },
    { header: "Payment Source", key: "source" }, { header: "Approval", key: "approval" }, { header: "Reimbursement", key: "reimbursement" }, { header: "Total", key: "total" },
  ], expenses.map((x) => ({ date: iso(x.expenseDate), number: x.expenseNumber, supplier: x.supplierName, reference: x.supplierRef ?? "", description: x.description ?? "", source: x.paymentSource, approval: x.approvalStatus, reimbursement: x.reimbursementStatus, total: money(x.totalAmount) })));

  addSheet(workbook, "Expense Allocations", [
    { header: "Expense", key: "expense", width: 22 }, { header: "Bearer", key: "bearer" }, { header: "Description", key: "description", width: 42 },
    { header: "Recovery", key: "recovery" }, { header: "Amount", key: "amount" },
  ], expenses.flatMap((e) => e.allocations.map((a) => ({ expense: e.expenseNumber, bearer: a.borneBy, description: a.description ?? "", recovery: a.recoveryStatus, amount: money(a.amount) }))));

  addSheet(workbook, "Owner Ledger", [
    { header: "Date", key: "date" }, { header: "Month", key: "month" }, { header: "Direction", key: "direction" },
    { header: "Category", key: "category", width: 24 }, { header: "Description", key: "description", width: 42 },
    { header: "Payment Status", key: "paymentStatus" }, { header: "Tax Category", key: "taxCategory" },
    { header: "Amount", key: "amount" }, { header: "SST", key: "sst" },
  ], ownerLedger.map((x) => ({ date: iso(x.transactionDate), month: iso(x.statementMonth), direction: x.direction, category: x.category, description: x.description ?? "", paymentStatus: x.paymentStatus, taxCategory: x.taxCategory, amount: money(x.amount), sst: money(x.sstAmount) })));

  addSheet(workbook, "Bank Transactions", [
    { header: "Date", key: "date" }, { header: "Bank", key: "bank", width: 24 }, { header: "Account", key: "account", width: 22 },
    { header: "Description", key: "description", width: 42 }, { header: "Debit", key: "debit" }, { header: "Credit", key: "credit" },
    { header: "Balance", key: "balance" }, { header: "Status", key: "status" }, { header: "Classification", key: "classification", width: 24 },
    { header: "Match Notes", key: "notes", width: 42 },
  ], bankTransactions.map((x) => ({ date: iso(x.transactionDate), bank: x.account.bankName, account: `${x.account.nickname} ${x.account.maskedAccountNumber ?? ""}`.trim(), description: x.description, debit: money(x.debit), credit: money(x.credit), balance: money(x.balance), status: x.status, classification: x.collectionCategory ?? x.responsibility ?? "", notes: x.matchNotes ?? "" })));

  const bytes = await workbook.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  c.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  c.header("Content-Disposition", `attachment; filename="KAEN-ACCOUNTING-TRANSACTIONS-${stamp}.xlsx"`);
  return c.body(new Uint8Array(bytes));
});

export { routes as accountingExportRoutes };
