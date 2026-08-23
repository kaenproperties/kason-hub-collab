import { useState } from "react";
import { Download, Eye, FileText, Loader2, ReceiptText } from "lucide-react";
import type { BillingDocumentListItem } from "@kason/shared";
import { useBillingDocuments, fetchBillingDocumentPdfUrl } from "@/api/billing-documents";
import { formatRM } from "@/components/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import { DocumentDetailDrawer } from "@/pages/accounting/document-detail-drawer";
import { documentKindLabel, statusMeta } from "@/pages/accounting/document-helpers";
import type { GridRow } from "@/api/bills-grid";

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function displayMonth(value: string): string {
  if (!/^\d{4}-\d{2}$/.test(value)) return "Selected month";
  return new Intl.DateTimeFormat("en-MY", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${value}-01T00:00:00.000Z`),
  );
}

type UnitDocumentsDialogProps = {
  row: GridRow | null;
  billingMonth: string;
  onClose: () => void;
};

export function UnitDocumentsDialog({ row, billingMonth, onClose }: UnitDocumentsDialogProps) {
  const [selectedDoc, setSelectedDoc] = useState<BillingDocumentListItem | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [periodMode, setPeriodMode] = useState<"month" | "all">("month");
  const [selectedMonth, setSelectedMonth] = useState(billingMonth);
  const query = useBillingDocuments(row ? {
    apartmentId: row.apartmentId,
    counterpartyType: "tenant",
    docTypes: ["invoice", "debit_note", "proforma", "receipt", "credit_note", "refund_note"],
    ...(periodMode === "month" && selectedMonth ? { month: selectedMonth } : {}),
    page,
    pageSize: 50,
  } : undefined);
  const documents = query.data?.data.items ?? [];
  const total = query.data?.data.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));

  async function download(doc: BillingDocumentListItem) {
    setDownloadingId(doc.id);
    try {
      const url = await fetchBillingDocumentPdfUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't download this document.");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <>
      <Dialog open={row != null} onOpenChange={(open) => { if (!open) onClose(); }} lockProgress={false}>
        <DialogContent className="max-w-6xl p-0 text-base">
          <DialogHeader className="border-b border-[var(--border)] px-6 py-5">
            <DialogTitle className="flex items-center gap-3 text-2xl text-[var(--navy)]">
              <FileText className="h-6 w-6 text-[var(--gold)]" />
              Tenant invoices & receipts
            </DialogTitle>
            <p className="text-base text-muted-foreground">
              {row ? `${row.propertyName} ${row.unitCode}` : ""} · {periodMode === "all" ? "all tenant-facing documents" : `${displayMonth(selectedMonth)} tenant-facing documents`}
            </p>
          </DialogHeader>

          <div className="px-6 pb-2">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--page-bg)] px-4 py-3">
              <div>
                <p className="font-semibold text-[var(--navy)]">Document period</p>
                <p className="text-sm text-muted-foreground">Choose a billing month, or show this tenant's complete document history.</p>
              </div>
              <div className="flex items-end gap-2">
                <label className="grid gap-1 text-sm font-semibold text-[var(--navy)]">
                  Month
                  <input
                    aria-label="Filter documents by month"
                    type="month"
                    value={selectedMonth}
                    onClick={() => {
                      setPeriodMode("month");
                      setPage(1);
                    }}
                    onChange={(event) => {
                      setSelectedMonth(event.target.value);
                      setPeriodMode("month");
                      setPage(1);
                    }}
                    className={`h-10 min-w-44 rounded-lg border bg-white px-3 text-base font-medium text-[var(--navy)] outline-none focus:ring-2 focus:ring-[var(--gold)] ${periodMode === "month" ? "border-[var(--gold)] shadow-sm" : "border-[var(--border)]"}`}
                  />
                </label>
                <Button
                  type="button"
                  variant={periodMode === "all" ? "default" : "outline"}
                  aria-pressed={periodMode === "all"}
                  className="h-10 px-5"
                  onClick={() => {
                    setPeriodMode("all");
                    setPage(1);
                  }}
                >
                  All
                </Button>
              </div>
            </div>
            {query.isLoading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading documents…</div>
            ) : query.isError ? (
              <div className="my-6 rounded-lg border border-red-300 bg-red-50 p-5 text-red-700">Couldn't load this unit's invoices and receipts.</div>
            ) : documents.length === 0 ? (
              <div className="my-6 rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-muted-foreground">
                {periodMode === "all"
                  ? "No invoices or receipts have been issued for this tenant/unit yet."
                  : `No invoices or receipts were issued for ${displayMonth(selectedMonth)}.`}
              </div>
            ) : (
              <div className="max-h-[62vh] overflow-y-auto rounded-xl border border-[var(--border)]">
                <table className="w-full table-fixed border-collapse text-[16px]">
                  <thead className="sticky top-0 z-10 bg-[var(--table-header-bg)] text-[var(--navy)]">
                    <tr>
                      <th className="w-[13%] px-4 py-3 text-left">Date</th>
                      <th className="w-[18%] px-4 py-3 text-left">Document</th>
                      <th className="w-[16%] px-4 py-3 text-left">Tenant</th>
                      <th className="w-[17%] px-4 py-3 text-left">Number</th>
                      <th className="w-[15%] px-3 py-3 text-center">Status</th>
                      <th className="w-[13%] px-3 py-3 text-right">Amount</th>
                      <th className="w-[10%] px-3 py-3 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((doc) => {
                      const status = statusMeta(doc).primary.label;
                      return (
                        <tr key={doc.id} className="border-t border-[var(--border)] bg-white hover:bg-[var(--page-bg)]">
                          <td className="px-4 py-4">{displayDate(doc.issuedAt)}</td>
                          <td className="px-4 py-4 font-semibold">{doc.docType === "receipt" ? <ReceiptText className="mr-2 inline h-5 w-5 text-emerald-700" /> : <FileText className="mr-2 inline h-5 w-5 text-[var(--gold)]" />}{documentKindLabel(doc.docType, doc.documentNumber)}</td>
                          <td className="break-words px-4 py-4 font-semibold text-[var(--navy)]">{doc.partyName}</td>
                          <td className="break-words px-4 py-4 font-mono">{doc.documentNumber}</td>
                          <td className="px-3 py-4 text-center"><span className="inline-flex max-w-full whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--page-bg)] px-2.5 py-1 text-sm font-semibold leading-none">{status}</span></td>
                          <td className="whitespace-nowrap px-3 py-4 text-right align-middle font-bold tabular-nums text-[var(--navy)]">{formatRM(Number(doc.total))}</td>
                          <td className="px-3 py-4 align-middle"><div className="flex items-center justify-center gap-1 whitespace-nowrap">
                            <Button type="button" variant="ghost" size="icon-lg" title="View details" aria-label={`View ${doc.documentNumber}`} onClick={() => setSelectedDoc(doc)}><Eye className="h-5 w-5" /></Button>
                            <Button type="button" variant="ghost" size="icon-lg" title="Download PDF" aria-label={`Download ${doc.documentNumber}`} disabled={downloadingId === doc.id} onClick={() => { void download(doc); }}>{downloadingId === doc.id ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}</Button>
                          </div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {total > 0 && <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>{total} document{total === 1 ? "" : "s"} · Page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
                <Button type="button" variant="outline" disabled={page >= pageCount || query.isFetching} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</Button>
              </div>
            </div>}
          </div>
          <DialogFooter className="border-t border-[var(--border)] px-6 py-4"><Button type="button" variant="outline" size="lg" onClick={onClose}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <DocumentDetailDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} />
    </>
  );
}
