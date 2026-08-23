import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import ExcelJS from "exceljs";
import { Landmark, Upload, Download, Link2, AlertTriangle, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addBankAccount, categorizeBankTransaction, getBankMatchCandidates, getBankReconciliationSummary, importBankTransactions, previewBankTransactions, listBankAccounts, listBankTransactions, type BankAccount, type BankTransaction, type ImportLine, type ImportPreview, type NewUnitCostItem } from "@/api/bank-reconciliation";
import { usePermission } from "@/components/permission-gate";

type Tab = "unmatched" | "matched" | "review";
const KEY = ["bank-reconciliation"] as const;

function parseDate(raw: string): string | null {
  const value = raw.trim();
  const iso = value.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = value.match(/^([0-3]?\d)[-/]([01]?\d)[-/](\d{4})$/);
  return dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
}

function numberValue(raw = ""): number {
  const negative = /^\(.*\)$/.test(raw.trim());
  const parsed = Number(raw.replace(/[(),RM\s]/gi, ""));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : 0;
}

function parseTransactions(text: string): ImportLine[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    const fields = (line.includes("\t") ? line.split("\t") : line.split(",")).map((field) => field.trim().replace(/^"|"$/g, ""));
    const transactionDate = parseDate(fields[0] ?? "");
    if (!transactionDate || !fields[1]) return [];
    const debit = Math.max(0, numberValue(fields[2]));
    const credit = Math.max(0, numberValue(fields[3]));
    return [{ transactionDate, description: fields[1], debit, credit, balance: fields[4] ? numberValue(fields[4]) : undefined }];
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadBankTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Bank Transactions");
  sheet.columns = [
    { header: "Date (DD/MM/YYYY)", key: "date", width: 22 },
    { header: "Description", key: "description", width: 42 },
    { header: "Debit (RM)", key: "debit", width: 18 },
    { header: "Credit (RM)", key: "credit", width: 18 },
    { header: "Bank Balance (RM)", key: "balance", width: 22 },
  ];
  sheet.addRow({ date: "20/08/2026", description: "ABC Furniture - Sofa", debit: 1000, credit: "", balance: 12500 });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFF3D493" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
  sheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 28;
  [3, 4, 5].forEach((column) => { sheet.getColumn(column).numFmt = '"RM" #,##0.00'; });
  const guide = workbook.addWorksheet("Instructions");
  guide.addRows([
    ["KAEN Bank Reconciliation Import Guide"],
    ["1", "Keep the column names and order unchanged."],
    ["2", "Enter money paid out by the company under Debit."],
    ["3", "Enter money received by the company under Credit."],
    ["4", "Use DD/MM/YYYY for Date. Bank Balance should be the balance shown by the bank after that transaction."],
    ["5", "Delete the sample row before uploading your actual transactions."],
  ]);
  guide.getColumn(1).width = 8; guide.getColumn(2).width = 82;
  guide.getRow(1).font = { bold: true, size: 16, color: { argb: "FFF3D493" } };
  guide.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
  guide.mergeCells("A1:B1");
  downloadBlob(new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "KAEN BANK TRANSACTIONS IMPORT TEMPLATE.xlsx");
}

function excelText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return `${String(value.getDate()).padStart(2, "0")}/${String(value.getMonth() + 1).padStart(2, "0")}/${value.getFullYear()}`;
  if (typeof value === "object" && "text" in value) return String(value.text);
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  return String(value);
}

const transferPurposeLabel = (value: BankTransaction["transferPurpose"]) => value ? ({ payroll_funding: "Payroll funding", head_office_funding: "Head office funding", reserve_transfer: "Reserve transfer", tax_funding: "Tax funding", other: "Other" }[value]) : "";
const transactionClassification = (row: BankTransaction) => row.transactionCategory === "internal_bank_transfer" ? "Internal Bank Transfer" : row.transactionCategory === "non_operational_transfer" ? "Transfer Out – Non-Operational" : Number(row.credit) > 0 ? row.collectionCategory?.replaceAll("_", " ") : row.costAllocations.length > 1 ? "Bulk Unit allocation" : row.responsibility;

async function parseExcelTransactions(file: File): Promise<ImportLine[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.getWorksheet("Bank Transactions") ?? workbook.worksheets[0];
  if (!sheet) return [];
  const lines: ImportLine[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const transactionDate = parseDate(excelText(row.getCell(1).value));
    const description = excelText(row.getCell(2).value).trim();
    if (!transactionDate || !description) return;
    lines.push({ transactionDate, description, debit: Math.max(0, numberValue(excelText(row.getCell(3).value))), credit: Math.max(0, numberValue(excelText(row.getCell(4).value))), balance: excelText(row.getCell(5).value) ? numberValue(excelText(row.getCell(5).value)) : undefined });
  });
  return lines;
}

async function exportBankTransactions(rows: BankTransaction[], tab: Tab) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KAEN Properties";
  const sheet = workbook.addWorksheet("Bank Transactions");
  sheet.columns = [
    { header: "Date", key: "date", width: 14 }, { header: "Bank", key: "bank", width: 24 },
    { header: "Account", key: "account", width: 22 }, { header: "Description", key: "description", width: 42 },
    { header: "Debit (RM)", key: "debit", width: 16 }, { header: "Credit (RM)", key: "credit", width: 16 },
    { header: "Bank Balance (RM)", key: "balance", width: 20 }, { header: "Status", key: "status", width: 15 },
    { header: "Classification", key: "classification", width: 34 }, { header: "Destination account", key: "destination", width: 28 }, { header: "Transfer purpose", key: "purpose", width: 24 }, { header: "Unit", key: "unit", width: 30 },
    { header: "Match details", key: "details", width: 70 },
  ];
  rows.forEach((row) => sheet.addRow({
    date: row.transactionDate.slice(0, 10), bank: row.account.bankName,
    account: [row.account.nickname, row.account.maskedAccountNumber].filter(Boolean).join(" · "),
    description: row.description, debit: Number(row.debit) || null, credit: Number(row.credit) || null,
    balance: row.balance == null ? null : Number(row.balance), status: row.status,
    classification: transactionClassification(row), destination: row.destinationAccount, purpose: transferPurposeLabel(row.transferPurpose),
    unit: row.unitLabel,
    details: [
      ...row.collectionAllocations.map((item) => `${item.unitLabel ?? "No unit"} · ${item.chargeNumber} · ${item.category ?? item.chargeType} · RM ${item.amount}`),
      ...row.costAllocations.map((item) => `${item.unitLabel ?? item.reference ?? "No unit"} · ${item.description ?? item.targetType} · RM ${item.amount}`),
      row.matchNotes ?? "",
    ].filter(Boolean).join(" | "),
  }));
  const allocations = workbook.addWorksheet("Match Allocations");
  allocations.columns = [
    { header: "Bank Date", key: "date", width: 14 }, { header: "Bank Description", key: "bankDescription", width: 40 },
    { header: "Direction", key: "direction", width: 14 }, { header: "Unit / Claim", key: "unit", width: 32 },
    { header: "Period", key: "period", width: 14 }, { header: "Document / Charge", key: "reference", width: 24 },
    { header: "Category", key: "category", width: 24 }, { header: "Details", key: "details", width: 42 },
    { header: "Allocated (RM)", key: "amount", width: 18 },
  ];
  rows.forEach((row) => {
    row.collectionAllocations.forEach((item) => allocations.addRow({ date: row.transactionDate.slice(0,10), bankDescription: row.description, direction: "Collection", unit: item.unitLabel, period: item.periodMonth, reference: `${item.paymentNumber} / ${item.chargeNumber}`, category: item.category ?? item.chargeType, details: `${item.partyName} · ${item.description}`, amount: Number(item.amount) }));
    row.costAllocations.forEach((item) => allocations.addRow({ date: row.transactionDate.slice(0,10), bankDescription: row.description, direction: "Cost", unit: item.unitLabel ?? item.reference, period: item.periodMonth, reference: item.reference, category: item.bearer ?? item.targetType, details: item.description, amount: Number(item.amount) }));
  });
  for (const target of [sheet, allocations]) {
    target.views = [{ state: "frozen", ySplit: 1 }];
    target.getRow(1).height = 28;
    target.getRow(1).font = { bold: true, color: { argb: "FFF3D493" } };
    target.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF082F55" } };
    target.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
    target.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: target.columnCount } };
  }
  [5,6,7].forEach((column) => { sheet.getColumn(column).numFmt = '"RM" #,##0.00'; });
  allocations.getColumn(9).numFmt = '"RM" #,##0.00';
  downloadBlob(new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `KAEN BANK RECONCILIATION ${tab.toUpperCase()}.xlsx`);
}

function rm(value: string | number) { return `RM ${Number(value).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export default function BankReconciliationPage() {
  const [searchParams] = useSearchParams();
  const requestedClaimId = searchParams.get("claim");
  const canImport = usePermission("bank.import");
  const canManageAccounts = usePermission("bank.manage_accounts");
  const canCreateCosts = usePermission("cost.create_from_bank");
  const canExport = usePermission("bank.export");
  const canCategorize = usePermission("bank.categorize");
  const canAllocateCredit = usePermission("bank.allocate_credit");
  const canAllocateDebit = usePermission("bank.allocate_debit");
  const canInternalTransfer = usePermission("bank.internal_transfer");
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("unmatched");
  const [accountId, setAccountId] = useState("all");
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [target, setTarget] = useState<BankTransaction | null>(null);
  const [costTarget, setCostTarget] = useState<BankTransaction | null>(null);
  const [allocationTarget, setAllocationTarget] = useState<BankTransaction | null>(null);
  const [internalTransferTarget, setInternalTransferTarget] = useState<BankTransaction | null>(null);
  const accounts = useQuery({ queryKey: [...KEY, "accounts"], queryFn: listBankAccounts });
  const summary = useQuery({ queryKey: [...KEY, "summary"], queryFn: getBankReconciliationSummary });
  const transactions = useQuery({ queryKey: [...KEY, "transactions", tab, q, accountId], queryFn: () => listBankTransactions(tab, q, accountId === "all" ? "" : accountId) });
  const candidates = useQuery({ queryKey: [...KEY, "candidates"], queryFn: getBankMatchCandidates });
  const rows = transactions.data ?? [];
  const requestedClaim = candidates.data?.employeeClaims.find((claim) => claim.id === requestedClaimId);
  const visibleRows = requestedClaimId ? [...rows].sort((a, b) => Number(b.debit) - Number(a.debit)) : rows;

  return (
    <div className="space-y-5">
      <PageHeader title="Bank Reconciliation" description="Import Maybank or Hong Leong transactions, match actual costs, and catch charges that staff forgot to create." icon={Landmark}
        actions={(canImport || canManageAccounts) ? <div className="flex gap-2">{canManageAccounts && <Button variant="outline" onClick={() => setAccountOpen(true)}>+ Add bank</Button>}{canImport && <Button variant="gold" onClick={() => setImportOpen(true)}><Upload className="mr-2 h-4 w-4" />{accountId === "all" ? "Import transactions" : "Import to selected bank"}</Button>}</div> : undefined} />

      {!canImport && !canCreateCosts && <div className="rounded-xl border border-[#C9A35C] bg-[#FFF8E8] px-4 py-3 text-sm text-[#082B4F]"><strong>Limited access:</strong> You can allocate collections and categorise transactions. Import and actual-cost functions require an additional permission.</div>}

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryCard label="Unmatched transactions" value={summary.data?.unmatched} tone="neutral" />
        <SummaryCard label="Needs review" value={summary.data?.review} tone="warning" />
        <SummaryCard label="Costs awaiting charge" value={summary.data?.chargeRequired} tone="danger" />
        <SummaryCard label="Non-operational transfers" value={summary.data?.nonOperationalTransfers} tone="neutral" />
      </div>

      {requestedClaimId && <div className="rounded-xl border-2 border-[var(--gold)] bg-[#FFF8E8] px-5 py-4 text-[var(--navy-text)] shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-lg">Match employee reimbursement{requestedClaim ? ` · ${requestedClaim.expenseNumber}` : ""}</strong><p className="mt-1 text-sm">{requestedClaim ? `${requestedClaim.claimantName ?? "Employee"} · ${requestedClaim.description ?? "Employee claim"} · Remaining ${rm(Math.max(0, Number(requestedClaim.totalAmount) - Number(requestedClaim.reimbursedAmount)))}` : "This claim is no longer awaiting reimbursement."}</p></div><span className="rounded-lg bg-white px-3 py-2 text-sm font-bold">1. Pay employee → 2. Import bank Debit → 3. Categorise that Debit</span></div>
        {requestedClaim && !rows.some((row) => Number(row.debit) > 0) && <p className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-2 font-semibold text-amber-900">No unmatched bank Debit is available yet. Import the reimbursement payment from the bank first; this claim will then appear automatically under “Match existing costs”.</p>}
      </div>}

      <Surface className="p-3">
        <div className="mb-2 text-sm font-bold uppercase tracking-wide text-[var(--navy-text)]">Bank accounts</div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Bank accounts">
          <Button variant={accountId === "all" ? "default" : "outline"} onClick={() => setAccountId("all")}>All banks</Button>
          {(accounts.data ?? []).map((account) => <div key={account.id} className={`flex overflow-hidden rounded-lg border ${accountId === account.id ? "border-[var(--gold)] shadow-sm" : "border-[var(--border)]"}`}>
            <button type="button" onClick={() => setAccountId(account.id)} className={`min-h-11 px-4 text-left font-semibold ${accountId === account.id ? "bg-[var(--navy)] text-white" : "bg-white text-[var(--navy-text)] hover:bg-[var(--table-header)]"}`}>
              {account.bankName}<span className={`ml-2 text-sm ${accountId === account.id ? "text-[var(--gold-light)]" : "text-muted-foreground"}`}>{account.nickname}{account.maskedAccountNumber ? ` · ${account.maskedAccountNumber}` : ""}</span>
            </button>
            {canImport && <button type="button" title={`Import transactions to ${account.nickname}`} aria-label={`Import transactions to ${account.nickname}`} onClick={() => { setAccountId(account.id); setImportOpen(true); }} className="border-l border-[var(--border)] bg-white px-3 text-[var(--navy-text)] hover:bg-[var(--gold-soft)]"><Upload className="h-4 w-4" /></button>}
          </div>)}
          {!accounts.isLoading && !accounts.data?.length && (canManageAccounts ? <button type="button" onClick={() => setAccountOpen(true)} className="min-h-11 rounded-lg border border-dashed border-[var(--gold)] px-4 font-semibold text-[var(--navy-text)]">Create your first bank account</button> : <p className="px-2 py-3 text-sm text-muted-foreground">Finance has not configured a bank account yet.</p>)}
        </div>
      </Surface>

      <Surface className="overflow-hidden rounded-lg p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
          <div className="flex gap-2" role="tablist">
            {(["unmatched", "matched", "review"] as Tab[]).map((value) => <Button key={value} variant={tab === value ? "default" : "outline"} onClick={() => setTab(value)} className="capitalize">{value}</Button>)}
          </div>
          <div className="flex items-center gap-2">{canExport && <Button variant="outline" disabled={!rows.length} onClick={() => void exportBankTransactions(rows, tab)}><Download className="mr-2 h-4 w-4" />Export Excel</Button>}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description" className="h-11 min-w-80 rounded-lg border border-[var(--input-border)] bg-white px-4 text-[16px] text-[var(--navy-text)]" /></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-[13px] text-[var(--navy-text)]">
            <colgroup><col className="w-[7%]" /><col className="w-[10%]" /><col className="w-[20%]" /><col className="w-[8%]" /><col className="w-[8%]" /><col className="w-[9%]" /><col className="w-[11%]" /><col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[9%]" /></colgroup>
            <thead className="bg-[var(--table-header)] text-[var(--navy-text)]"><tr>{["Date", "Bank", "Description", "Debit", "Credit", "Bank Balance", "Unit", "Classification", "Status", "Action"].map((label) => <th key={label} className="h-16 whitespace-nowrap border border-[var(--border)] px-3 py-3 text-center text-[17px] font-extrabold">{label}</th>)}</tr></thead>
            <tbody>{visibleRows.map((row, index) => <tr key={row.id} className={`${index % 2 ? "bg-[var(--page-bg)]/50" : "bg-white"} hover:bg-[var(--table-header)]/60`}>
              <td className="h-20 whitespace-nowrap border border-[var(--border)] px-4 py-3 text-center font-semibold">{row.transactionDate.slice(0, 10)}</td>
              <td className="h-20 border border-[var(--border)] px-4 py-3 text-center"><div className="whitespace-nowrap font-bold">{row.account.bankName}</div>{row.account.nickname && row.account.nickname !== row.account.bankName && <div className="mt-1 truncate text-sm text-muted-foreground">{row.account.nickname}</div>}</td>
              <td className="h-20 border border-[var(--border)] px-5 py-3 text-left text-[17px] font-semibold leading-snug">{row.description}</td>
              <td className="h-20 whitespace-nowrap border border-[var(--border)] px-4 py-3 text-center text-[17px] font-bold">{Number(row.debit) ? rm(row.debit) : "—"}</td>
              <td className="h-20 whitespace-nowrap border border-[var(--border)] px-4 py-3 text-center text-[17px] font-bold">{Number(row.credit) ? rm(row.credit) : "—"}</td>
              <td className="h-20 whitespace-nowrap border border-[var(--border)] px-4 py-3 text-center text-[17px] font-bold">{row.balance == null ? "—" : rm(row.balance)}</td>
              <td className="h-20 border border-[var(--border)] px-4 py-3 text-center font-semibold">{row.unitLabel || "—"}</td>
              <td className="h-20 border border-[var(--border)] px-4 py-3 text-center font-semibold"><span className="block">{transactionClassification(row) || "—"}</span>{row.transactionCategory === "non_operational_transfer" && <small className="mt-1 block font-normal text-muted-foreground">{transferPurposeLabel(row.transferPurpose)} → {row.destinationAccount}</small>}{row.transactionCategory === "internal_bank_transfer" && <small className="mt-1 block font-normal text-muted-foreground">Paired with {row.destinationAccount}</small>}</td>
              <td className="h-20 border border-[var(--border)] px-3 py-3 text-center"><Status row={row} /></td>
              <td className="h-20 border border-[var(--border)] px-2 py-2 text-center"><div className="flex flex-col items-center gap-1">
                {(row.transactionCategory === "internal_bank_transfer" || row.costAllocations.length > 0 || row.collectionAllocations.length > 0 || (Number(row.debit) > 0 ? (canAllocateDebit || canCategorize) : (canAllocateCredit || canCategorize))) && <Button className="whitespace-nowrap" variant="outline" onClick={() => row.transactionCategory === "internal_bank_transfer" ? setInternalTransferTarget(row) : row.costAllocations.length || row.collectionAllocations.length ? setAllocationTarget(row) : Number(row.debit) > 0 ? setCostTarget(row) : setTarget(row)}><Link2 className="mr-2 h-4 w-4" />{row.transactionCategory === "internal_bank_transfer" ? "View transfer" : row.costAllocations.length || row.collectionAllocations.length ? `View ${row.costAllocations.length + row.collectionAllocations.length} matches` : "Categorise"}</Button>}
                {row.status !== "matched" && canInternalTransfer && <button type="button" className="font-semibold text-blue-700 underline" onClick={() => setInternalTransferTarget(row)}>Internal transfer</button>}
                {row.status !== "matched" && !(Number(row.debit) > 0 ? (canAllocateDebit || canCategorize) : (canAllocateCredit || canCategorize)) && !canInternalTransfer && <span className="text-xs text-muted-foreground">View only</span>}
              </div></td>
            </tr>)}</tbody>
          </table>
          {!transactions.isLoading && rows.length === 0 && <p className="p-10 text-center text-muted-foreground">No {tab} transactions.</p>}
        </div>
      </Surface>

      <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} onSaved={(account) => { setAccountId(account.id); queryClient.invalidateQueries({ queryKey: [...KEY, "accounts"] }); }} />
      <ImportDialog key={`${importOpen}-${accountId}`} open={importOpen} accounts={accounts.data ?? []} initialAccountId={accountId === "all" ? "" : accountId} onClose={() => setImportOpen(false)} onImported={() => { queryClient.invalidateQueries({ queryKey: KEY }); setImportOpen(false); }} />
      <CategoriseDialog key={target?.id ?? "closed"} target={target} candidates={candidates.data} onClose={() => setTarget(null)} onSaved={() => { queryClient.invalidateQueries({ queryKey: KEY }); setTarget(null); }} />
      <CostAllocationDialog key={costTarget?.id ?? "cost-closed"} target={costTarget} candidates={candidates.data} preferredTargetId={requestedClaimId} canCreateCosts={canCreateCosts} onClose={() => setCostTarget(null)} onSaved={() => { queryClient.invalidateQueries({ queryKey: KEY }); setCostTarget(null); }} />
      <AllocationDetailsDialog target={allocationTarget} onClose={() => setAllocationTarget(null)} />
      <InternalTransferDialog target={internalTransferTarget} candidates={candidates.data?.bankTransfers ?? []} onClose={() => setInternalTransferTarget(null)} onSaved={() => { queryClient.invalidateQueries({ queryKey: KEY }); setInternalTransferTarget(null); }} />
    </div>
  );
}

function InternalTransferDialog({ target, candidates, onClose, onSaved }: { target: BankTransaction | null; candidates: Array<{ id: string; transactionDate: string; description: string; debit: string; credit: string; accountId: string; accountLabel: string; status: string }>; onClose: () => void; onSaved: () => void }) {
  const [counterpartTransactionId, setCounterpartTransactionId] = useState("");
  const [notes, setNotes] = useState(target?.matchNotes ?? "");
  const targetDebit = Number(target?.debit ?? 0);
  const targetCredit = Number(target?.credit ?? 0);
  const amount = targetDebit > 0 ? targetDebit : targetCredit;
  const matches = candidates.filter((row) => row.id !== target?.id && row.accountId !== target?.accountId && (targetDebit > 0 ? Number(row.credit) > 0 : Number(row.debit) > 0) && Math.abs((targetDebit > 0 ? Number(row.credit) : Number(row.debit)) - amount) < 0.009);
  const mutation = useMutation({ mutationFn: () => categorizeBankTransaction(target!.id, { transactionCategory: "internal_bank_transfer", counterpartTransactionId, matchNotes: notes }), onSuccess: () => { toast.success("Bank A and Bank B transactions are now paired as one internal transfer."); onSaved(); }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not match internal transfer") });
  return <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Internal Bank Transfer</DialogTitle><DialogDescription>{target?.transactionDate.slice(0, 10)} · {target?.description} · {rm(amount)}</DialogDescription></DialogHeader>{target?.transactionCategory === "internal_bank_transfer" ? <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-5"><b className="text-lg text-[var(--navy-text)]">Already paired</b><p className="mt-2">This is money transferred between company bank accounts. It is not Collection, Revenue, Expense or Owner Payout.</p><p className="mt-2 font-semibold">Other bank: {target.destinationAccount}</p></div> : <div className="space-y-4"><div className="rounded-lg border border-blue-300 bg-blue-50 p-4 text-blue-950"><strong>Accounting treatment:</strong> the Debit and Credit are one cash movement. Pairing them prevents the receiving Credit from being counted as fresh income.</div><label className="block font-semibold">Matching transaction in the other bank<select value={counterpartTransactionId} onChange={(event) => setCounterpartTransactionId(event.target.value)} className="mt-1 h-12 w-full rounded-lg border bg-white px-3"><option value="">Select the same amount in the other bank</option>{matches.map((row) => <option key={row.id} value={row.id}>{row.transactionDate} · {row.accountLabel} · {rm(targetDebit > 0 ? row.credit : row.debit)} · {row.description}</option>)}</select></label>{matches.length === 0 && <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 font-semibold text-amber-900">No opposite transaction with the same amount exists in another imported bank. Import that bank statement first.</div>}<label className="block font-semibold">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className="mt-1 w-full rounded-lg border p-3" /></label></div>}<DialogFooter><Button variant="outline" onClick={onClose}>Close</Button>{target?.transactionCategory !== "internal_bank_transfer" && <Button disabled={!counterpartTransactionId || mutation.isPending} onClick={() => mutation.mutate()}>Match both bank transactions</Button>}</DialogFooter></DialogContent></Dialog>;
}

function AllocationDetailsDialog({ target, onClose }: { target: BankTransaction | null; onClose: () => void }) {
  const total = target ? [...target.costAllocations, ...target.collectionAllocations].reduce((sum, item) => sum + Number(item.amount), 0) : 0;
  const collection = Boolean(target && Number(target.credit) > 0);
  return <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}><DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto"><DialogHeader><DialogTitle>{collection ? "Collection match details" : "Cost allocation details"}</DialogTitle><DialogDescription>{target?.transactionDate.slice(0, 10)} · {target?.description} · {rm(collection ? target?.credit ?? 0 : target?.debit ?? 0)}</DialogDescription></DialogHeader><div className="overflow-x-auto rounded-xl border"><table className="w-full min-w-[850px] table-fixed border-collapse"><thead className="bg-[var(--table-header)]"><tr>{["Unit / Claim", "Month", "Document / Category", "Details", "Allocated amount"].map((heading) => <th key={heading} className="border border-[var(--border)] px-4 py-3 text-center font-extrabold">{heading}</th>)}</tr></thead><tbody>{target?.costAllocations.map((item) => <tr key={item.id}><td className="border p-3 font-bold">{item.unitLabel || item.reference || "—"}</td><td className="border p-3 text-center">{item.periodMonth || "—"}</td><td className="border p-3">{item.bearer || item.targetType}</td><td className="border p-3">{item.description || "—"}</td><td className="border p-3 text-right text-lg font-extrabold">{rm(item.amount)}</td></tr>)}{target?.collectionAllocations.map((item) => <tr key={item.id}><td className="border p-3 font-bold">{item.unitLabel || "—"}</td><td className="border p-3 text-center">{item.periodMonth || "—"}</td><td className="border p-3"><b>{item.chargeNumber}</b><small className="block text-muted-foreground">{item.category || item.chargeType}</small></td><td className="border p-3">{item.partyName}<small className="block text-muted-foreground">{item.description}</small></td><td className="border p-3 text-right text-lg font-extrabold">{rm(item.amount)}</td></tr>)}</tbody><tfoot className="bg-[var(--navy)] text-[var(--gold-light)]"><tr><td colSpan={4} className="border border-[var(--border)] p-3 text-right font-bold">Total matched</td><td className="border border-[var(--border)] p-3 text-right text-lg font-extrabold">{rm(total)}</td></tr></tfoot></table></div><DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter></DialogContent></Dialog>;
}

function SummaryCard({ label, value, tone }: { label: string; value?: { count: number; amount: string }; tone: "neutral" | "warning" | "danger" }) {
  return <div className={`rounded-xl border p-4 shadow-sm ${tone === "danger" ? "border-red-400 bg-red-50" : tone === "warning" ? "border-amber-400 bg-amber-50" : "border-[var(--border)] bg-white"}`}><div className="text-sm font-semibold text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-extrabold text-[var(--navy-text)]">{value?.count ?? 0} <span className="text-lg">· {rm(value?.amount ?? 0)}</span></div></div>;
}

function Status({ row }: { row: BankTransaction }) {
  if (row.chargeRequired) return <span className="inline-flex whitespace-nowrap rounded-full bg-red-100 px-3 py-1 font-bold text-red-800">Charge required</span>;
  if (row.status === "matched") return <span className="inline-flex whitespace-nowrap rounded-full bg-emerald-100 px-3 py-1 font-bold text-emerald-800"><CheckCircle2 className="mr-1 h-4 w-4" />Matched</span>;
  if (row.status === "review") return <span className="inline-flex whitespace-nowrap rounded-full bg-amber-100 px-3 py-1 font-bold text-amber-900"><AlertTriangle className="mr-1 h-4 w-4" />Review</span>;
  return <span className="inline-flex whitespace-nowrap rounded-full bg-slate-100 px-3 py-1 font-bold text-slate-700">Unmatched</span>;
}

function AccountDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (account: BankAccount) => void }) {
  const [bankName, setBankName] = useState<"Maybank" | "Hong Leong Bank" | "Other">("Maybank"); const [nickname, setNickname] = useState(""); const [masked, setMasked] = useState("");
  const mutation = useMutation({ mutationFn: () => addBankAccount({ bankName, nickname, maskedAccountNumber: masked }), onSuccess: (account) => { toast.success("Bank account added."); onSaved(account); onClose(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Could not add account") });
  return <Dialog open={open} onOpenChange={(v) => !v && onClose()}><DialogContent><DialogHeader><DialogTitle>Add bank account</DialogTitle><DialogDescription>Store only a nickname and masked number. Never enter online-banking credentials.</DialogDescription></DialogHeader><div className="space-y-3"><label className="block font-semibold">Bank<select value={bankName} onChange={(e) => setBankName(e.target.value as typeof bankName)} className="mt-1 h-11 w-full rounded-lg border px-3"><option>Maybank</option><option>Hong Leong Bank</option><option>Other</option></select></label><label className="block font-semibold">Account nickname<input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Operations account" className="mt-1 h-11 w-full rounded-lg border px-3" /></label><label className="block font-semibold">Masked account number<input value={masked} onChange={(e) => setMasked(e.target.value)} placeholder="e.g. •••• 1234" className="mt-1 h-11 w-full rounded-lg border px-3" /></label></div><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!nickname || mutation.isPending} onClick={() => mutation.mutate()}>Add account</Button></DialogFooter></DialogContent></Dialog>;
}

function ImportDialog({ open, accounts, initialAccountId, onClose, onImported }: { open: boolean; accounts: Array<{ id: string; bankName: string; nickname: string }>; initialAccountId: string; onClose: () => void; onImported: () => void }) {
  const [accountId, setAccountId] = useState(initialAccountId); const [text, setText] = useState(""); const [excelLines, setExcelLines] = useState<ImportLine[] | null>(null); const [preview, setPreview] = useState<ImportPreview | null>(null); const lines = useMemo(() => excelLines ?? parseTransactions(text), [excelLines, text]);
  const previewMutation = useMutation({ mutationFn: () => previewBankTransactions({ accountId, transactions: lines }), onSuccess: setPreview, onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed") });
  const mutation = useMutation({ mutationFn: () => importBankTransactions({ accountId, source: "paste", transactions: lines }), onSuccess: (r) => { toast.success(`${r.imported} imported · ${r.duplicates} duplicate(s) skipped.`); onImported(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Import failed") });
  const resetPreview = () => setPreview(null);
  return <Dialog open={open} onOpenChange={(v) => !v && onClose()}><DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>Import bank transactions</DialogTitle><DialogDescription>Download the Excel template, fill it in, then upload it here. Debit is money paid out by the company; Credit is money received by the company.</DialogDescription></DialogHeader><div className="flex justify-end"><Button variant="outline" onClick={() => void downloadBankTemplate()}><Download className="mr-2 h-4 w-4" />Download Excel Template</Button></div><select value={accountId} onChange={(e) => { setAccountId(e.target.value); resetPreview(); }} className="h-11 w-full rounded-lg border px-3"><option value="">Select bank account</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.bankName} · {a.nickname}</option>)}</select><input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; resetPreview(); if (file.name.toLowerCase().endsWith(".xlsx")) void parseExcelTransactions(file).then((parsed) => { setExcelLines(parsed); setText(""); }).catch(() => toast.error("Could not read this Excel file.")); else void file.text().then((value) => { setExcelLines(null); setText(value); }); }} className="block w-full rounded-lg border p-3" /><textarea value={text} onChange={(e) => { setExcelLines(null); setText(e.target.value); resetPreview(); }} rows={6} placeholder={'Or paste rows here:\n20/08/2026\tABC Furniture - Sofa\t1000\t\t12500'} className="w-full rounded-lg border p-3 font-mono text-sm" /><p className="font-semibold text-[var(--navy-text)]">{lines.length} valid transaction(s) detected.{excelLines ? " Excel file ready." : ""}</p>{preview && <div className={`rounded-xl border p-4 ${preview.canImport ? "border-emerald-400 bg-emerald-50" : "border-red-400 bg-red-50"}`}><div className="mb-3 flex items-center justify-between"><strong className="text-lg text-[var(--navy-text)]">Import Verification</strong><span className={`rounded-full px-3 py-1 font-bold ${preview.canImport ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>{preview.canImport ? "Ready to import" : "Action required"}</span></div><div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-5"><VerificationMetric label="Rows uploaded" value={preview.total} /><VerificationMetric label="New" value={preview.newCount} tone="good" /><VerificationMetric label="Duplicates" value={preview.duplicates} /><VerificationMetric label="Missing balance" value={preview.missingBalance} tone={preview.missingBalance ? "bad" : "good"} /><VerificationMetric label="Balance breaks" value={preview.balanceBreaks} tone={preview.balanceBreaks ? "bad" : "good"} /></div><p className="mt-3 text-sm font-semibold text-[var(--navy-text)]">Statement order detected: {preview.direction === "newest_first" ? "Newest transaction first" : "Oldest transaction first"}.</p>{!preview.canImport && <p className="mt-2 font-bold text-red-800">Import is blocked. Correct the missing Bank Balance or suspected missing transaction, then upload again.</p>}</div>}<DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="outline" disabled={!accountId || !lines.length || previewMutation.isPending} onClick={() => previewMutation.mutate()}>{previewMutation.isPending ? "Checking…" : "Verify transactions"}</Button><Button disabled={!preview?.canImport || !preview.newCount || mutation.isPending} onClick={() => mutation.mutate()}>Confirm Import ({preview?.newCount ?? 0})</Button></DialogFooter></DialogContent></Dialog>;
}

function VerificationMetric({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" }) {
  return <div className={`rounded-lg border bg-white p-3 ${tone === "bad" ? "border-red-400" : tone === "good" ? "border-emerald-300" : "border-[var(--border)]"}`}><div className="text-sm text-muted-foreground">{label}</div><div className={`text-2xl font-extrabold ${tone === "bad" ? "text-red-700" : "text-[var(--navy-text)]"}`}>{value}</div></div>;
}

function CostAllocationDialog({ target, candidates, preferredTargetId, canCreateCosts, onClose, onSaved }: { target: BankTransaction | null; candidates?: Awaited<ReturnType<typeof getBankMatchCandidates>>; preferredTargetId?: string | null; canCreateCosts: boolean; onClose: () => void; onSaved: () => void }) {
  type DraftUnitCost = NewUnitCostItem & { key: string };
  const currentMonth = new Date().toISOString().slice(0, 7);
  const blankItem = (): DraftUnitCost => ({ key: crypto.randomUUID(), apartmentId: "", billingMonth: currentMonth, bearer: "owner", costType: "tnb", description: "Utility bulk payment", amount: "", withSST: false });
  const targets = useMemo(() => [
    ...(candidates?.expenses ?? []).map((item) => ({ key: `grid_expense:${item.id}`, targetType: "grid_expense" as const, targetId: item.id, label: `${item.periodMonth} · ${item.description}`, detail: `Unit cost · ${rm(item.actualCost ?? item.amount)} · Paid ${rm(item.paidCost)}`, remaining: Math.max(0, Number(item.actualCost ?? item.amount) - Number(item.paidCost)) })),
    ...(candidates?.employeeClaims ?? []).map((item) => ({ key: `employee_claim:${item.id}`, targetType: "employee_claim" as const, targetId: item.id, label: `${item.expenseNumber} · ${item.claimantName ?? "Employee"}`, detail: item.description ?? "Employee claim reimbursement", remaining: Math.max(0, Number(item.totalAmount) - Number(item.reimbursedAmount)) })),
  ].filter((item) => item.remaining > 0.009), [candidates]);
  const [mode, setMode] = useState<"existing" | "new" | "non_operational" | "internal_transfer">(target?.transactionCategory === "internal_bank_transfer" ? "internal_transfer" : target?.transactionCategory === "non_operational_transfer" ? "non_operational" : "existing");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const preferred = targets.find((item) => item.targetType === "employee_claim" && item.targetId === preferredTargetId);
    if (!preferred || Number(target?.debit ?? 0) <= 0) return {};
    return { [preferred.key]: Math.min(preferred.remaining, Number(target?.debit ?? 0)).toFixed(2) };
  });
  const [unitItems, setUnitItems] = useState<DraftUnitCost[]>([blankItem()]);
  const [notes, setNotes] = useState("");
  const [destinationAccount, setDestinationAccount] = useState(target?.destinationAccount ?? "");
  const [transferPurpose, setTransferPurpose] = useState<NonNullable<BankTransaction["transferPurpose"]>>(target?.transferPurpose ?? "payroll_funding");
  const [counterpartTransactionId, setCounterpartTransactionId] = useState("");
  const transferCandidates = (candidates?.bankTransfers ?? []).filter((row) => row.id !== target?.id && row.accountId !== target?.accountId && Number(row.credit) > 0 && Math.abs(Number(row.credit) - Number(target?.debit ?? 0)) < 0.009);
  const allocations = targets.flatMap((item) => { const value = Number(amounts[item.key] ?? 0); return value > 0 ? [{ targetType: item.targetType, targetId: item.targetId, allocatedAmount: value.toFixed(2) }] : []; });
  const validUnitItems = unitItems.filter((item) => item.apartmentId && item.description.trim() && Number(item.amount) > 0).map(({ key: _key, ...item }) => ({ ...item, amount: Number(item.amount).toFixed(2) }));
  const total = mode === "existing" ? allocations.reduce((sum, item) => sum + Number(item.allocatedAmount), 0) : mode === "new" ? validUnitItems.reduce((sum, item) => sum + Number(item.amount), 0) : Number(target?.debit ?? 0);
  const remaining = Number(target?.debit ?? 0) - total;
  const invalid = mode === "existing" ? targets.some((item) => Number(amounts[item.key] ?? 0) - item.remaining > 0.009) : mode === "new" ? validUnitItems.length !== unitItems.length : mode === "internal_transfer" ? !counterpartTransactionId : !destinationAccount.trim();
  const mutation = useMutation({ mutationFn: () => categorizeBankTransaction(target!.id, mode === "internal_transfer" ? { transactionCategory: "internal_bank_transfer", counterpartTransactionId, matchNotes: notes } : mode === "non_operational" ? { transactionCategory: "non_operational_transfer", destinationAccount: destinationAccount.trim(), transferPurpose, matchNotes: notes } : { responsibility: "company", matchNotes: notes, ...(mode === "existing" ? { costAllocations: allocations } : { unitCostItems: validUnitItems }) }), onSuccess: () => { toast.success(mode === "internal_transfer" ? "Both bank transactions were paired as an internal transfer." : mode === "non_operational" ? "Transfer classified as non-operational." : mode === "existing" ? `Debit allocated across ${allocations.length} existing cost item(s).` : `Created and paid ${validUnitItems.length} Unit cost item(s).`); onSaved(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Could not classify bank Debit") });
  const updateUnitItem = (key: string, patch: Partial<DraftUnitCost>) => setUnitItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  return <Dialog open={!!target} onOpenChange={(value) => !value && onClose()}><DialogContent className="max-h-[94vh] max-w-6xl overflow-y-auto"><DialogHeader><DialogTitle>Allocate bank Debit</DialogTitle><DialogDescription>{target?.description} · {rm(target?.debit ?? 0)}. Split one bulk bank payment across multiple Units.</DialogDescription></DialogHeader>
    <div className="flex flex-wrap gap-2"><Button type="button" variant={mode === "existing" ? "default" : "outline"} onClick={() => setMode("existing")}>Match existing costs</Button>{canCreateCosts && <Button type="button" variant={mode === "new" ? "default" : "outline"} onClick={() => setMode("new")}>Create Unit cost items</Button>}<Button type="button" variant={mode === "non_operational" ? "default" : "outline"} onClick={() => setMode("non_operational")}>Transfer Out – Non-Operational</Button></div>
    {mode === "non_operational" ? <div className="space-y-4 rounded-xl border border-emerald-300 bg-emerald-50 p-5"><div><h3 className="text-xl font-extrabold text-[var(--navy-text)]">Money moved outside Property Management operations</h3><p className="mt-1 text-sm text-emerald-900">This Debit reduces this bank account balance, but is excluded from Unit costs, Owner Payout, company fees and Property Management profit calculations.</p></div><div className="grid gap-4 md:grid-cols-2"><label className="font-semibold">Destination account<input value={destinationAccount} onChange={(e) => setDestinationAccount(e.target.value)} placeholder="e.g. Payroll account · Maybank 1234" className="mt-1 h-11 w-full rounded-lg border bg-white px-3" /></label><label className="font-semibold">Transfer purpose<select value={transferPurpose} onChange={(e) => setTransferPurpose(e.target.value as typeof transferPurpose)} className="mt-1 h-11 w-full rounded-lg border bg-white px-3"><option value="payroll_funding">Payroll funding</option><option value="head_office_funding">Head office / other department funding</option><option value="reserve_transfer">Reserve transfer</option><option value="tax_funding">Tax funding</option><option value="other">Other non-operational transfer</option></select></label></div><div className="rounded-lg border border-emerald-300 bg-white p-4 text-center"><small className="block text-muted-foreground">Bank Debit classified</small><b className="text-2xl text-[var(--navy-text)]">{rm(target?.debit ?? 0)}</b></div></div> :
    <div className="rounded-xl border border-[var(--border)] bg-[var(--page-bg)] p-3"><div className="mb-3 flex items-center justify-between"><div><strong className="text-lg">{mode === "existing" ? "Existing cost allocations" : "New Unit cost allocations"}</strong>{mode === "new" && <p className="text-sm text-muted-foreground">Each item becomes a paid Billing expense and stays linked to this bank transaction.</p>}</div><b className={Math.abs(remaining) < 0.009 ? "text-emerald-700" : "text-amber-800"}>{rm(Math.abs(remaining))} {remaining >= 0 ? "remaining" : "over"}</b></div>
      {mode === "existing" ? <div className="max-h-[48vh] space-y-2 overflow-y-auto">{targets.map((item) => <label key={item.key} className="grid grid-cols-[1fr_140px] items-center gap-3 rounded-lg border bg-white p-3"><span className="min-w-0"><b className="block truncate text-[var(--navy-text)]">{item.label}</b><small className="block text-muted-foreground">{item.detail} · Outstanding {rm(item.remaining)}</small></span><input type="number" min="0" max={item.remaining} step="0.01" value={amounts[item.key] ?? ""} onChange={(e) => setAmounts((current) => ({ ...current, [item.key]: e.target.value }))} placeholder="0.00" className="h-11 rounded-lg border px-3 text-right text-lg font-bold" /></label>)}{targets.length === 0 && <p className="py-8 text-center text-muted-foreground">No unpaid Unit Costs or approved Employee Claims.</p>}</div> : <div className="overflow-x-auto rounded-lg border bg-white"><table className="w-full min-w-[1100px] table-fixed border-collapse"><thead className="bg-[var(--table-header)]"><tr>{["Unit", "Month", "Category", "Paid for", "Description", "SST", "Amount", ""].map((heading) => <th key={heading} className="border border-[var(--border)] px-3 py-3 text-center font-extrabold">{heading}</th>)}</tr></thead><tbody>{unitItems.map((item) => <tr key={item.key}><td className="border p-2"><select value={item.apartmentId} onChange={(e) => updateUnitItem(item.key, { apartmentId: e.target.value })} className="h-10 w-full rounded-lg border px-2"><option value="">Select Unit</option>{candidates?.apartments.map((apartment) => <option key={apartment.id} value={apartment.id}>{apartment.label}</option>)}</select></td><td className="border p-2"><input type="month" value={item.billingMonth} onChange={(e) => updateUnitItem(item.key, { billingMonth: e.target.value })} className="h-10 w-full rounded-lg border px-2" /></td><td className="border p-2"><select value={item.costType} onChange={(e) => updateUnitItem(item.key, { costType: e.target.value as DraftUnitCost["costType"] })} className="h-10 w-full rounded-lg border px-2"><option value="tnb">TNB</option><option value="water">Water</option><option value="wifi">WiFi</option><option value="cleaning">Cleaning</option><option value="maintenance">Maintenance Fee</option><option value="recurring">Recurring</option><option value="repair">Repair</option><option value="other">Other</option></select></td><td className="border p-2"><select value={item.bearer} onChange={(e) => updateUnitItem(item.key, { bearer: e.target.value as "owner" | "tenant" })} className="h-10 w-full rounded-lg border px-2"><option value="owner">Owner</option><option value="tenant">Tenant</option></select></td><td className="border p-2"><input value={item.description} onChange={(e) => updateUnitItem(item.key, { description: e.target.value })} className="h-10 w-full rounded-lg border px-2" /></td><td className="border p-2 text-center"><input type="checkbox" checked={item.withSST} onChange={(e) => updateUnitItem(item.key, { withSST: e.target.checked })} className="h-5 w-5" /></td><td className="border p-2"><input type="number" min="0.01" step="0.01" value={item.amount} onChange={(e) => updateUnitItem(item.key, { amount: e.target.value })} placeholder="0.00" className="h-10 w-full rounded-lg border px-2 text-right font-bold" /></td><td className="border p-2 text-center"><Button type="button" size="icon" variant="ghost" disabled={unitItems.length === 1} onClick={() => setUnitItems((current) => current.filter((row) => row.key !== item.key))}><Trash2 className="h-4 w-4" /></Button></td></tr>)}</tbody></table><div className="p-3"><Button type="button" variant="outline" onClick={() => setUnitItems((current) => [...current, blankItem()])}><Plus className="mr-2 h-4 w-4" />Add Unit item</Button></div></div>}
      {invalid && <p className="mt-2 font-bold text-red-800">Complete every row and make sure no allocation exceeds its unpaid balance.</p>}<div className="mt-3 grid grid-cols-3 overflow-hidden rounded-lg border bg-white text-center"><div className="p-3"><small className="block text-muted-foreground">Bank Debit</small><b className="text-lg">{rm(target?.debit ?? 0)}</b></div><div className="border-x p-3"><small className="block text-muted-foreground">Allocated</small><b className="text-lg">{rm(total)}</b></div><div className={Math.abs(remaining) < 0.009 ? "bg-emerald-100 p-3" : "bg-amber-100 p-3"}><small className="block text-muted-foreground">Difference</small><b className="text-lg">{rm(remaining)}</b></div></div></div>}
    <label className="block font-semibold">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border p-3" /></label><DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={mode === "non_operational" ? invalid || mutation.isPending : total <= 0 || Math.abs(remaining) >= 0.009 || invalid || mutation.isPending} onClick={() => mutation.mutate()}>{mode === "non_operational" ? "Confirm transfer classification" : "Confirm allocations"}</Button></DialogFooter></DialogContent></Dialog>;
}

function CategoriseDialog({ target, candidates, onClose, onSaved }: { target: BankTransaction | null; candidates?: Awaited<ReturnType<typeof getBankMatchCandidates>>; onClose: () => void; onSaved: () => void }) {
  const isCollection = Number(target?.credit ?? 0) > 0 && Number(target?.debit ?? 0) === 0;
  const [apartmentId, setApartmentId] = useState("");
  const [partyId, setPartyId] = useState("");
  const [responsibility, setResponsibility] = useState<"tenant" | "owner" | "company" | "pending">("pending");
  const [collectionMode, setCollectionMode] = useState<"outstanding" | "owner_payment" | "management_fee" | "other">("outstanding");
  const [expenseId, setExpenseId] = useState("");
  const [notes, setNotes] = useState("");
  const [manualAllocation, setManualAllocation] = useState(false);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const expenses = (candidates?.expenses ?? []).filter((expense) => !apartmentId || expense.apartmentId === apartmentId).filter((expense) => responsibility === "pending" || responsibility === "company" || expense.bearer === responsibility);
  const amount = isCollection ? target?.credit ?? 0 : target?.debit ?? 0;
  const unitCharges = useMemo(() => (candidates?.collectionCharges ?? []).filter((charge) => charge.apartmentId === apartmentId), [apartmentId, candidates?.collectionCharges]);
  const parties = useMemo(() => [...new Map(unitCharges.map((charge) => [charge.partyId, { id: charge.partyId, name: charge.partyName }])).values()], [unitCharges]);
  const effectivePartyId = partyId || (parties.length === 1 ? parties[0].id : "");
  const eligibleCharges = useMemo(() => {
    return unitCharges
      .filter((charge) => charge.partyId === effectivePartyId)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  }, [effectivePartyId, unitCharges]);
  const allocationPlan = useMemo(() => {
    let remaining = Number(amount ?? 0);
    const allocations: Array<{ chargeId: string; allocatedAmount: string }> = [];
    for (const charge of eligibleCharges) {
      if (remaining <= 0.009) break;
      const allocated = Math.min(remaining, Number(charge.outstandingAmount));
      if (allocated > 0.009) allocations.push({ chargeId: charge.id, allocatedAmount: allocated.toFixed(2) });
      remaining = Math.max(0, remaining - allocated);
    }
    return { allocations, remaining };
  }, [amount, eligibleCharges]);
  const chosenPlan = useMemo(() => {
    if (!manualAllocation) return allocationPlan;
    const allocations = eligibleCharges.flatMap((charge) => {
      const value = Number(manualAmounts[charge.id] ?? 0);
      return value > 0 ? [{ chargeId: charge.id, allocatedAmount: value.toFixed(2) }] : [];
    });
    const allocated = allocations.reduce((sum, row) => sum + Number(row.allocatedAmount), 0);
    return { allocations, remaining: Number(amount ?? 0) - allocated };
  }, [allocationPlan, amount, eligibleCharges, manualAllocation, manualAmounts]);
  const manualInvalid = manualAllocation && eligibleCharges.some((charge) => Number(manualAmounts[charge.id] ?? 0) - Number(charge.outstandingAmount) > 0.009);
  const chosenTypes = new Set(chosenPlan.allocations.map((allocation) => eligibleCharges.find((charge) => charge.id === allocation.chargeId)?.chargeType.toLowerCase() ?? ""));
  const derivedCategory: NonNullable<BankTransaction["collectionCategory"]> = chosenTypes.size > 1 ? "other" : [...chosenTypes][0]?.includes("deposit") ? "deposit" : [...chosenTypes][0]?.includes("rent") ? "rental" : "tenant_expense";
  const collectionCategory = collectionMode === "outstanding" ? derivedCategory : collectionMode;
  const mutation = useMutation({
    mutationFn: () => categorizeBankTransaction(target!.id, {
      apartmentId: apartmentId || null,
      responsibility: isCollection ? null : responsibility,
      collectionCategory: isCollection ? collectionCategory : null,
      gridExpenseId: isCollection ? null : expenseId || null,
      matchNotes: notes,
      allocations: isCollection && collectionMode === "outstanding" && Math.abs(chosenPlan.remaining) < 0.009 ? chosenPlan.allocations : undefined,
    }),
    onSuccess: () => { toast.success(isCollection && collectionMode === "outstanding" ? `Credit allocated across ${chosenPlan.allocations.length} bill item(s).` : isCollection ? "Collection categorised." : expenseId ? "Bank cost linked to the expense." : responsibility === "tenant" ? "Charge-required task created." : "Cost categorised."); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not categorise"),
  });
  const allocationInvalid = !apartmentId || !effectivePartyId || chosenPlan.allocations.length === 0 || Math.abs(chosenPlan.remaining) >= 0.009 || manualInvalid;
  const disabled = mutation.isPending || (isCollection ? (collectionMode === "outstanding" ? allocationInvalid : collectionMode === "management_fee" && !apartmentId) : responsibility !== "company" && !apartmentId);
  const displayedCharges = manualAllocation ? eligibleCharges : allocationPlan.allocations.map((plan) => eligibleCharges.find((charge) => charge.id === plan.chargeId)!).filter(Boolean);

  return <Dialog key={target?.id ?? "none"} open={!!target} onOpenChange={(v) => !v && onClose()}>
    <DialogContent className="max-h-[94vh] max-w-5xl overflow-y-auto">
      <DialogHeader><DialogTitle>{isCollection ? "Allocate bank Credit" : "Categorise cost payment"}</DialogTitle><DialogDescription>{target?.description} · {rm(amount)} · {isCollection ? "Money received by company" : "Money paid by company"}</DialogDescription></DialogHeader>
      <div className="space-y-4">
        {isCollection && <label className="block font-semibold">Collection action<select value={collectionMode} onChange={(e) => { setCollectionMode(e.target.value as typeof collectionMode); setManualAmounts({}); }} className="mt-1 h-11 w-full rounded-lg border px-3"><option value="outstanding">Allocate to tenant outstanding bills</option><option value="owner_payment">Owner Payment / Top-up</option><option value="management_fee">Management Fee Collection</option><option value="other">Other Collection</option></select></label>}
        <label className="block font-semibold">Property / Unit {isCollection && collectionMode !== "outstanding" && <span className="font-normal text-muted-foreground">(optional except Management Fee)</span>}<select value={apartmentId} onChange={(e) => { setApartmentId(e.target.value); setPartyId(""); setExpenseId(""); setManualAmounts({}); }} className="mt-1 h-11 w-full rounded-lg border px-3"><option value="">No unit selected</option>{candidates?.apartments.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
        {isCollection ? <>
          {collectionMode === "outstanding" && apartmentId && <>
            <label className="block font-semibold">Tenant / payer<select value={effectivePartyId} onChange={(e) => { setPartyId(e.target.value); setManualAmounts({}); }} className="mt-1 h-11 w-full rounded-lg border px-3"><option value="">Select tenant / payer</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
            <div className={`rounded-xl border p-4 ${Math.abs(chosenPlan.remaining) < 0.009 && chosenPlan.allocations.length && !manualInvalid ? "border-emerald-400 bg-emerald-50" : "border-amber-400 bg-amber-50"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-lg text-[var(--navy-text)]">Outstanding bill allocation</strong><p className="text-sm text-muted-foreground">Rental, deposits, utilities and tenant expenses are shown together.</p></div><Button type="button" variant="outline" onClick={() => { setManualAllocation((value) => !value); setManualAmounts(Object.fromEntries(allocationPlan.allocations.map((row) => [row.chargeId, row.allocatedAmount]))); }}>{manualAllocation ? "Use oldest first" : "Adjust manually"}</Button></div>
              <div className="mt-3 overflow-x-auto rounded-lg border bg-white"><table className="w-full min-w-[820px] table-fixed border-collapse text-sm"><thead className="bg-[var(--table-header)]"><tr>{["Category / Bill", "Description", "Due date", "Original", "Outstanding", "Allocate"].map((heading) => <th key={heading} className="border border-[var(--border)] px-3 py-2 text-center font-extrabold">{heading}</th>)}</tr></thead><tbody>{displayedCharges.map((charge) => { const planned = allocationPlan.allocations.find((row) => row.chargeId === charge.id)?.allocatedAmount ?? "0.00"; return <tr key={charge.id}><td className="border border-[var(--border)] p-3"><b className="block">{charge.categoryName || charge.chargeType}</b><small>{charge.chargeNumber}</small></td><td className="border border-[var(--border)] p-3"><b>{charge.description || charge.chargeType}</b><small className="block text-muted-foreground">{charge.unitLabel} · {charge.partyName}</small></td><td className="border border-[var(--border)] p-3 text-center">{charge.dueDate}</td><td className="border border-[var(--border)] p-3 text-right font-semibold">{rm(charge.originalAmount)}</td><td className="border border-[var(--border)] p-3 text-right font-bold">{rm(charge.outstandingAmount)}</td><td className="border border-[var(--border)] p-2 text-right">{manualAllocation ? <input type="number" min="0" max={charge.outstandingAmount} step="0.01" value={manualAmounts[charge.id] ?? ""} placeholder="0.00" onChange={(e) => setManualAmounts((current) => ({ ...current, [charge.id]: e.target.value }))} className="h-10 w-full rounded-lg border px-3 text-right font-bold" /> : <b>{rm(planned)}</b>}</td></tr>; })}</tbody></table>{eligibleCharges.length === 0 && <p className="p-8 text-center text-muted-foreground">No outstanding bills found for this tenant and Unit.</p>}</div>
              <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-lg border bg-white text-center"><div className="p-3"><small className="block text-muted-foreground">Bank Credit</small><b className="text-lg">{rm(amount)}</b></div><div className="border-x p-3"><small className="block text-muted-foreground">Allocated</small><b className="text-lg">{rm(Number(amount) - chosenPlan.remaining)}</b></div><div className={`p-3 ${Math.abs(chosenPlan.remaining) < 0.009 ? "bg-emerald-100" : "bg-amber-100"}`}><small className="block text-muted-foreground">Remaining</small><b className="text-lg">{rm(chosenPlan.remaining)}</b></div></div>
              {Math.abs(chosenPlan.remaining) >= 0.009 && <p className="mt-2 font-bold text-amber-900">{chosenPlan.remaining > 0 ? `${rm(chosenPlan.remaining)} has no matching bill yet. Create the missing bill before confirming.` : `Allocation exceeds the bank Credit by ${rm(Math.abs(chosenPlan.remaining))}.`}</p>}{manualInvalid && <p className="mt-2 font-bold text-red-800">An allocation exceeds that bill&apos;s outstanding amount.</p>}
            </div>
          </>}
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-emerald-900"><strong>Safety rule:</strong> allocations may cover many bill categories, but they must belong to the same tenant and selected Unit. The total must equal this bank Credit.</div>
        </> : <>
          <label className="block font-semibold">Who should bear this cost?<select value={responsibility} onChange={(e) => { setResponsibility(e.target.value as typeof responsibility); setExpenseId(""); }} className="mt-1 h-11 w-full rounded-lg border px-3"><option value="pending">Pending decision</option><option value="tenant">Tenant</option><option value="owner">Owner</option><option value="company">Company</option></select></label>
          <label className="block font-semibold">Link existing expense (optional)<select value={expenseId} onChange={(e) => setExpenseId(e.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3"><option value="">No matching expense yet</option>{expenses.map((expense) => <option key={expense.id} value={expense.id}>{expense.periodMonth} · {expense.description} · Charge {rm(expense.amount)}</option>)}</select></label>{responsibility === "tenant" && !expenseId && <div className="rounded-lg border border-red-300 bg-red-50 p-3 font-semibold text-red-800">Saving this will create a “Tenant charge required” task for the selected unit.</div>}
        </>}
        <label className="block font-semibold">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border p-3" /></label>
      </div>
      <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={disabled} onClick={() => mutation.mutate()}>{isCollection && collectionMode === "outstanding" ? "Confirm Credit allocations" : "Save categorisation"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
