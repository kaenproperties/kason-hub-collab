/**
 * Draft Invoice Drawer
 * Shows full invoice detail, editable dates, read-only charge line items, and Approve.
 * Opens when an admin clicks a row in the DraftApprovalsTable.
 *
 * Deliberately APPROVE-ONLY. The drawer carries no charge add, no charge remove
 * and no void: an approver reads what they are about to bill and either approves
 * it or leaves it. Corrections belong upstream (bills grid / charges) before the
 * draft run — not on the screen whose one job is to say yes.
 *
 * The endpoints still exist and are still role-guarded; they simply have no UI
 * here any more:
 *   DELETE /billing/invoices/:id/charges/:chargeId
 *   POST   /billing/invoices/:id/void
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, CheckCircle, Pencil, ReceiptText, X } from "lucide-react";
import { PHASE2_STATUS_TONES } from "@kason/shared";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GlowCard } from "@/components/ui/glow-card";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { formatMoney, formatPeriodMonth, prettyEnumLabel } from "@/components/format";
import { invoiceTypeMeta } from "./draft-approvals-table";
import { apiFetch, ApiError } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";

// ─── Types ────────────────────────────────────────────────────────────────────
// Mirrors the API's DraftChargeLine (apps/api/.../auto-draft.types.ts):
//   { id, chargeNumber, chargeType, status, amount, description }
// `id` IS the Charge.id — there is no junction table; Charge.invoiceId is the
// direct FK.

type InvoiceCharge = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  status: string;
  amount: number;
  description: string | null;
  billingMonth: string | null;
};

// Mirrors the API's DraftInvoiceDetail (DraftInvoiceRow & { charges }).
// CONTRACT: unitCode/propertyName/listingType MUST be returned by
// GET /billing/invoices/:id — the drawer renders Property and Unit from them on every
// tenant-side draft. They are nullable only for owner-side drafts (no tenancy) and for
// a unit that cannot be resolved; a null on a tenant draft means the join regressed.
type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  partyName: string;
  tenancyCode: string | null;
  invoiceType: string;
  periodMonth: string | null;
  invoiceDate: string;
  dueDate: string | null;
  totalAmount: number;
  sstAmount: number | null;
  status: string;
  updatedAt: string;
  unitCode: string | null;
  propertyName: string | null;
  listingType: string | null;
  charges: InvoiceCharge[];
};

// ─── Query ────────────────────────────────────────────────────────────────────

function fetchInvoice(id: string): Promise<InvoiceDetail> {
  return apiFetch<InvoiceDetail>(`/billing/invoices/${id}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

// ─── Sub-component: Confirm Dialog ────────────────────────────────────────────

function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = "default",
  onConfirm,
  pending,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive" | "gold";
  onConfirm: () => void;
  pending: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} lockProgress={false}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            variant={confirmVariant}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Processing…" : confirmLabel}
          </Button>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Drawer ──────────────────────────────────────────────────────────────

type Props = {
  invoiceId: string | null;
  onClose: () => void;
};

export function DraftInvoiceDrawer({ invoiceId, onClose }: Props) {
  const canEditDraft = usePermission("billing.charge.edit");
  const canApproveDraft = usePermission("billing.bill");
  const qc = useQueryClient();

  // Local edit state for dates
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [datesDirty, setDatesDirty] = useState(false);
  const [editingChargeId, setEditingChargeId] = useState<string | null>(null);
  const [editedAmount, setEditedAmount] = useState("");

  // Dialog state
  const [approveOpen, setApproveOpen] = useState(false);

  const isOpen = !!invoiceId;

  const invoiceQ = useQuery({
    queryKey: ["billing", "invoice", invoiceId],
    queryFn: () => fetchInvoice(invoiceId!),
    enabled: !!invoiceId,
  });

  // Sync date inputs from fresh query data (v5 removed onSuccess from useQuery)
  useEffect(() => {
    if (invoiceQ.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setInvoiceDate(toDateInputValue(invoiceQ.data.invoiceDate));
      setDueDate(toDateInputValue(invoiceQ.data.dueDate));
      setDatesDirty(false);
      setEditingChargeId(null);
      setEditedAmount("");
    }
  }, [invoiceQ.data]);

  const inv = invoiceQ.data;
  const invoiceTone =
    inv
      ? (PHASE2_STATUS_TONES.invoice[
          inv.status as keyof typeof PHASE2_STATUS_TONES.invoice
        ] ?? "slate")
      : "slate";

  // ── Save dates ────────────────────────────────────────────────────────────

  const saveDatesMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/billing/invoices/${invoiceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          invoiceDate: invoiceDate || undefined,
          dueDate: dueDate || undefined,
          expectedUpdatedAt: inv!.updatedAt,
        }),
      }),
    onSuccess: () => {
      toast.success("Dates updated.");
      setDatesDirty(false);
      void qc.invalidateQueries({ queryKey: ["billing", "invoice", invoiceId] });
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Failed to save dates.";
      toast.error(msg);
    },
  });

  const saveAmountMutation = useMutation({
    mutationFn: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
      apiFetch(`/billing/invoices/${invoiceId}/charges/${chargeId}/amount`, {
        method: "PATCH",
        body: JSON.stringify({ amount, expectedUpdatedAt: inv!.updatedAt }),
      }),
    onSuccess: () => {
      toast.success("Charge amount updated.");
      setEditingChargeId(null);
      setEditedAmount("");
      void qc.invalidateQueries({ queryKey: ["billing", "invoice", invoiceId] });
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update amount.");
    },
  });

  // ── Approve ───────────────────────────────────────────────────────────────

  const approveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/billing/invoices/${invoiceId}/approve`, {
        method: "POST",
        body: JSON.stringify({ expectedUpdatedAt: inv!.updatedAt }),
      }),
    onSuccess: () => {
      toast.success("Invoice approved.");
      setApproveOpen(false);
      void qc.invalidateQueries({ queryKey: ["billing", "invoice", invoiceId] });
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
      onClose();
    },
    onError: (err) => {
      setApproveOpen(false);
      toast.error(
        err instanceof ApiError ? err.message : "Failed to approve invoice.",
      );
    },
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <Sheet
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent size="full">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5 text-primary" />
              {inv ? inv.invoiceNumber : "Invoice Detail"}
            </SheetTitle>
            <SheetDescription>
              {inv
                ? `${inv.partyName} · ${invoiceTypeMeta(inv.invoiceType).label}${inv.periodMonth ? ` · ${formatPeriodMonth(inv.periodMonth)}` : ""}`
                : "Loading…"}
            </SheetDescription>
          </SheetHeader>

          <SheetBody className="space-y-6">
            {invoiceQ.isLoading && (
              <div className="space-y-4 animate-pulse">
                <div className="h-24 rounded-xl bg-muted" />
                <div className="h-40 rounded-xl bg-muted" />
                <div className="h-24 rounded-xl bg-muted" />
              </div>
            )}

            {invoiceQ.isError && (
              <p className="text-sm text-rose-600">
                Failed to load invoice. Please close and try again.
              </p>
            )}

            {inv && (
              <>
                {/* ── Status + identity ── */}
                <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <StatusPill tone={invoiceTone}>{inv.status}</StatusPill>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Party</span>
                    <span className="text-sm font-medium text-foreground">{inv.partyName}</span>
                  </div>
                  {/* WHICH property / WHICH unit — an admin approving money should not
                      have to infer this from the invoice number. */}
                  {inv.propertyName && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Property</span>
                      <span className="text-sm font-medium text-foreground">{inv.propertyName}</span>
                    </div>
                  )}
                  {inv.unitCode && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Unit</span>
                      <span className="text-sm font-medium text-foreground">
                        {inv.unitCode}
                        {inv.listingType === "ROOM" ? (
                          <span className="ml-1 text-xs text-muted-foreground">(room)</span>
                        ) : null}
                      </span>
                    </div>
                  )}
                  {inv.tenancyCode && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Tenancy</span>
                      <span className="text-sm font-medium text-foreground">{inv.tenancyCode}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Type</span>
                    <span className="text-sm text-foreground">{invoiceTypeMeta(inv.invoiceType).label}</span>
                  </div>
                  {inv.periodMonth && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Period</span>
                      <span className="text-sm text-foreground">{formatPeriodMonth(inv.periodMonth)}</span>
                    </div>
                  )}
                </div>

                {/* ── Editable dates ── */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Dates</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Invoice Date">
                      <TextInput
                        type="date"
                        disabled={!canEditDraft}
                        value={invoiceDate}
                        onChange={(e) => {
                          setInvoiceDate(e.target.value);
                          setDatesDirty(true);
                        }}
                      />
                    </Field>
                    <Field
                      label="Due Date"
                      hint="Set or leave unchanged — clearing not supported."
                    >
                      <TextInput
                        type="date"
                        disabled={!canEditDraft}
                        value={dueDate}
                        onChange={(e) => {
                          setDueDate(e.target.value);
                          setDatesDirty(true);
                        }}
                      />
                    </Field>
                  </div>
                  {canEditDraft && datesDirty && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saveDatesMutation.isPending}
                      onClick={() => saveDatesMutation.mutate()}
                    >
                      {saveDatesMutation.isPending ? "Saving…" : "Save dates"}
                    </Button>
                  )}
                </div>

                {/* ── Charges — READ-ONLY. This is the evidence for the Approve
                     decision, not an editing surface. ── */}
                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Charges</h3>
                    {canEditDraft && inv.status === "draft" && inv.charges.some((c) => c.status === "draft") && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Draft amounts may be adjusted for approved exceptions before issuing. The total updates automatically.
                      </p>
                    )}
                  </div>

                  <TableWrap>
                    <DataTable className="w-full table-fixed">
                      <TableHead>
                        <tr>
                          {/* Description leads: "Monthly rent" is what an admin reads.
                              The chargeNumber is an internal key (RENT-202608-<uuid>) and
                              is demoted to a subtitle so it stays copyable for support
                              without dominating the row. */}
                          <HeadCell className="w-[34%]">Charge</HeadCell>
                          <HeadCell className="w-[17%] whitespace-nowrap">Type</HeadCell>
                          <HeadCell className="w-[13%] whitespace-nowrap">Period</HeadCell>
                          <HeadCell className="w-[12%] whitespace-nowrap">Status</HeadCell>
                          <HeadCell className="w-[24%] whitespace-nowrap text-right">Amount</HeadCell>
                        </tr>
                      </TableHead>
                      <tbody>
                        {/* colSpan 5 = Charge, Type, Period, Status, Amount. */}
                        {inv.charges.length === 0 ? (
                          <EmptyRow colSpan={5} label="No charges attached yet." />
                        ) : (
                          inv.charges.map((c) => {
                            const chargeTone =
                              PHASE2_STATUS_TONES.charge[
                                c.status as keyof typeof PHASE2_STATUS_TONES.charge
                              ] ?? "slate";
                            return (
                              <Row key={c.id}>
                                <BodyCell className="font-medium">
                                  <span className="block text-foreground">
                                    {c.description ?? prettyEnumLabel(c.chargeType)}
                                  </span>
                                  <span
                                    className="block font-mono text-[10px] text-muted-foreground truncate max-w-[220px]"
                                    title={c.chargeNumber}
                                  >
                                    {c.chargeNumber}
                                  </span>
                                </BodyCell>
                                <BodyCell className="whitespace-nowrap [overflow-wrap:normal]">
                                  {prettyEnumLabel(c.chargeType)}
                                </BodyCell>
                                <BodyCell className="whitespace-nowrap [overflow-wrap:normal]">
                                  {formatPeriodMonth(c.billingMonth)}
                                </BodyCell>
                                <BodyCell className="whitespace-nowrap [overflow-wrap:normal]">
                                  <StatusPill tone={chargeTone}>{c.status}</StatusPill>
                                </BodyCell>
                                <BodyCell className="whitespace-nowrap text-right tabular-nums">
                                  {editingChargeId === c.id ? (
                                    <div className="flex min-w-[190px] items-center justify-end gap-1.5">
                                      <TextInput
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={editedAmount}
                                        aria-label={`Manual amount for ${c.description ?? c.chargeNumber}`}
                                        onChange={(event) => setEditedAmount(event.target.value)}
                                        className="h-9 w-28 text-right"
                                      />
                                      <Button
                                        type="button"
                                        size="icon-sm"
                                        aria-label="Save manual amount"
                                        disabled={
                                          saveAmountMutation.isPending ||
                                          editedAmount === "" ||
                                          !Number.isFinite(Number(editedAmount)) ||
                                          Number(editedAmount) < 0
                                        }
                                        onClick={() => saveAmountMutation.mutate({ chargeId: c.id, amount: Number(editedAmount) })}
                                      >
                                        <Check className="h-4 w-4" />
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label="Cancel amount edit"
                                        onClick={() => {
                                          setEditingChargeId(null);
                                          setEditedAmount("");
                                        }}
                                      >
                                        <X className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-end gap-2">
                                      <span className="whitespace-nowrap">{formatMoney(c.amount)}</span>
                                      {canEditDraft && inv.status === "draft" && c.status === "draft" && (
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          onClick={() => {
                                            setEditingChargeId(c.id);
                                            setEditedAmount(c.amount.toFixed(2));
                                          }}
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                          Edit
                                        </Button>
                                      )}
                                    </div>
                                  )}
                                </BodyCell>
                              </Row>
                            );
                          })
                        )}
                      </tbody>
                    </DataTable>
                  </TableWrap>
                </div>

                {/* ── Totals ── */}
                <GlowCard glowColor="gold" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Total</span>
                      <span className="text-xl font-bold text-foreground">
                        {formatMoney(inv.totalAmount)}
                      </span>
                    </div>
                    {inv.sstAmount != null && inv.sstAmount > 0 && (
                      <Callout variant="info" title="SST included">
                        {formatMoney(inv.sstAmount)} SST is included in the total above.
                      </Callout>
                    )}
                  </div>
                </GlowCard>
              </>
            )}
          </SheetBody>

          {/* Footer: approve for managers; close for everyone. No destructive action. */}
          <SheetFooter>
            {canApproveDraft && inv && (
              <Button
                variant="gold"
                onClick={() => setApproveOpen(true)}
                disabled={inv.status !== "draft"}
              >
                <CheckCircle className="h-4 w-4" />
                Approve
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Approve confirm */}
      {inv && (
        <ConfirmActionDialog
          open={approveOpen}
          onOpenChange={setApproveOpen}
          title="Approve invoice?"
          description={`Approve ${inv.invoiceNumber} for ${inv.partyName}. The invoice will move to "approved" — it will NOT be sent automatically.`}
          confirmLabel="Approve"
          confirmVariant="gold"
          onConfirm={() => approveMutation.mutate()}
          pending={approveMutation.isPending}
        />
      )}
    </>
  );
}
