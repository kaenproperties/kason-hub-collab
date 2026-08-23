import type { LucideIcon } from "lucide-react";
import { Home, Building2, Snowflake, FileText, Wallet, Eye } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { formatDate, formatMoney, formatPeriodMonth } from "@/components/format";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import { cn } from "@/lib/utils";

// Mirrors the API's DraftInvoiceRow (apps/api/.../auto-draft.types.ts). The
// list/detail JSON does NOT include a `currency` field — amounts are MYR
// (formatMoney defaults to MYR). periodMonth is nullable.
// CONTRACT: unitCode/propertyName MUST come back from GET /billing/invoices — the
// queue renders them under every tenant-side row so an admin can tell two rows for
// the same party apart. Null is legitimate ONLY for owner-side rows (no tenancy) or
// an unresolvable unit; a null on a TENANT row means the batched unit join regressed.
export type DraftInvoiceListItem = {
  id: string;
  invoiceNumber: string;
  partyName: string;
  invoiceType: string;
  periodMonth: string | null;
  totalAmount: number;
  status: string;
  updatedAt: string;
  unitCode?: string | null;
  propertyName?: string | null;
};

// ── Invoice-type presentation ────────────────────────────────────────────────
// The API sends raw enum values ("tenant_rental", "owner_statement", …). Users
// should never see those underscores — every surface renders a human label, a
// colour-coded badge, and whether the row is an INVOICE or a STATEMENT.
export type InvoiceTypeMeta = {
  /** Human label incl. the document kind, e.g. "Rental Payment Request" / "Owner Statement". */
  label: string;
  /** Plural for tab headers, e.g. "Rental Payment Requests". */
  plural: string;
  variant: "sky" | "gold" | "emerald" | "outline";
  Icon: LucideIcon;
};

export const INVOICE_TYPE_META: Record<string, InvoiceTypeMeta> = {
  tenant_rental: { label: "Rental Payment Request", plural: "Rental Payment Requests", variant: "sky", Icon: Home },
  tenant_aircon: { label: "Aircon Invoice", plural: "Aircon Invoices", variant: "emerald", Icon: Snowflake },
  owner_statement: { label: "Owner Statement", plural: "Owner Statements", variant: "gold", Icon: Building2 },
  // Move-in deposits. Wallet mirrors the "Deposits & parking" section icon on the
  // edit-unit form, so the same money reads the same across the two surfaces.
  tenant_deposit: { label: "Rental Deposits", plural: "Rental Deposits", variant: "outline", Icon: Wallet },
};

/** Resolve presentation for any invoiceType, prettifying unknown values instead of
 * leaking a raw underscore enum. */
export function invoiceTypeMeta(type: string): InvoiceTypeMeta {
  const known = INVOICE_TYPE_META[type];
  if (known) return known;
  const pretty = type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { label: pretty, plural: `${pretty}s`, variant: "outline", Icon: FileText };
}

/** The type values that get their own tab, in display order. */
export const INVOICE_TYPE_ORDER = ["tenant_rental", "owner_statement", "tenant_aircon", "tenant_deposit"] as const;

type Props = {
  invoices: DraftInvoiceListItem[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onRowClick: (id: string) => void;
};

export function DraftApprovalsTable({
  invoices,
  selectedIds,
  onSelectionChange,
  onRowClick,
}: Props) {
  const allSelected = invoices.length > 0 && selectedIds.length === invoices.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < invoices.length;

  function toggleAll() {
    onSelectionChange(allSelected ? [] : invoices.map((inv) => inv.id));
  }

  function toggleRow(id: string) {
    onSelectionChange(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  }

  return (
    <TableWrap>
      <DataTable>
        <TableHead>
          <tr>
            <HeadCell className="w-28">
              <div
                className="flex cursor-pointer items-center gap-2"
                onClick={toggleAll}
              >
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all visible invoices"
                  className="inline-flex size-6 border-2 border-[var(--navy)] bg-white shadow-sm"
                  onClick={(event) => event.stopPropagation()}
                />
                <span>Select</span>
              </div>
            </HeadCell>
            <HeadCell>Document</HeadCell>
            <HeadCell>Billed to</HeadCell>
            <HeadCell className="hidden xl:table-cell">Period</HeadCell>
            <HeadCell className="text-right">Total</HeadCell>
            <HeadCell>Status</HeadCell>
            <HeadCell className="hidden lg:table-cell">Updated</HeadCell>
            <HeadCell className="w-36 text-right">Action</HeadCell>
          </tr>
        </TableHead>
        <tbody>
          {invoices.length === 0 ? (
            <EmptyRow colSpan={8} label="No draft billing documents match the current filters." />
          ) : (
            invoices.map((inv) => {
              const tone =
                PHASE2_STATUS_TONES.invoice[
                  inv.status as keyof typeof PHASE2_STATUS_TONES.invoice
                ] ?? "slate";
              const m = invoiceTypeMeta(inv.invoiceType);
              return (
                <tr
                  key={inv.id}
                  onClick={() => onRowClick(inv.id)}
                  className={cn(
                    "group cursor-pointer border-b border-[var(--border)] transition-colors hover:bg-[var(--table-head)] focus-within:bg-[var(--table-head)]",
                    selectedIds.includes(inv.id) && "bg-[#E7F0F8] shadow-[inset_4px_0_0_var(--navy)]",
                  )}
                  title={`Open ${m.label} ${inv.invoiceNumber}`}
                >
                  <BodyCell className="w-28">
                    <div
                      className="flex cursor-pointer items-center gap-2"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleRow(inv.id);
                      }}
                    >
                      <Checkbox
                        checked={selectedIds.includes(inv.id)}
                        onCheckedChange={() => toggleRow(inv.id)}
                        aria-label={`Select ${m.label} ${inv.invoiceNumber}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex size-6 border-2 border-[var(--navy)] bg-white shadow-sm"
                      />
                      <span className="text-xs font-semibold text-[var(--navy)]">
                        {selectedIds.includes(inv.id) ? "Selected" : "Select"}
                      </span>
                    </div>
                  </BodyCell>
                  {/* Document — states WHAT it is (invoice vs statement) + its code. */}
                  <BodyCell>
                    <div className="flex flex-col items-start gap-1 text-left">
                      <Badge variant={m.variant} className="inline-flex items-center gap-1">
                        <m.Icon className="h-3 w-3" />
                        {m.label}
                      </Badge>
                      <span className="font-mono text-xs text-[var(--text-muted)] transition group-hover:text-[var(--text-primary)]">
                        {inv.invoiceNumber}
                      </span>
                    </div>
                  </BodyCell>
                  {/* Billed to — the TENANT and the UNIT. The name alone cannot identify
                      a row: two tenancies can share a display name, and one tenant can
                      hold several units, so "Demo Tenant" twice was unresolvable. */}
                  <BodyCell>
                    <div className="flex flex-col items-start text-left">
                      <span className="font-medium text-[var(--text-primary)] group-hover:underline">
                        {inv.partyName}
                      </span>
                      {inv.unitCode ? (
                        <span className="text-xs text-[var(--text-muted)]">
                          {inv.unitCode}
                          {inv.propertyName ? ` · ${inv.propertyName}` : ""}
                        </span>
                      ) : null}
                    </div>
                  </BodyCell>
                  <BodyCell className="hidden xl:table-cell tabular-nums text-[var(--text-secondary)]">
                    {formatPeriodMonth(inv.periodMonth)}
                  </BodyCell>
                  <BodyCell className="text-right font-semibold tabular-nums">
                    {formatMoney(inv.totalAmount)}
                  </BodyCell>
                  <BodyCell>
                    <StatusPill tone={tone}>{inv.status}</StatusPill>
                  </BodyCell>
                  <BodyCell className="hidden lg:table-cell whitespace-nowrap text-[var(--text-secondary)]">
                    {formatDate(inv.updatedAt)}
                  </BodyCell>
                  <BodyCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`View details for ${m.label} ${inv.invoiceNumber}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRowClick(inv.id);
                      }}
                      className="border-[var(--navy)] bg-white font-semibold text-[var(--navy)] shadow-sm transition group-hover:bg-[var(--navy)] group-hover:text-white"
                    >
                      <Eye className="h-4 w-4" />
                      View details
                    </Button>
                  </BodyCell>
                </tr>
              );
            })
          )}
        </tbody>
      </DataTable>
    </TableWrap>
  );
}
