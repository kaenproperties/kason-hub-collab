import type { GridRow } from "@/api/bills-grid";
import { useLiveStatementSections, useOwnerMonthlySummaries, useStatementSections } from "@/api/owner-ledger";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatementSectionHeader } from "@/pages/tenancy/owner-statement/statement-section-header";
import { StatementSectionOccupancy } from "@/pages/tenancy/owner-statement/statement-section-occupancy";
import { StatementSectionPayoutSummary } from "@/pages/tenancy/owner-statement/statement-section-payout-summary";
import { StatementSectionIncome } from "@/pages/tenancy/owner-statement/statement-section-income";
import { StatementSectionExpenses } from "@/pages/tenancy/owner-statement/statement-section-expenses";
import { useApproveStatement, useFirstCheckStatement, useGenerateStatement, useStatementApprovalPreflight } from "@/api/owner-billing";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { usePermission } from "@/components/permission-gate";

export function OwnerReportDialog({ row, month, onClose }: { row: GridRow | null; month: string; onClose: () => void }) {
  const canFirstCheck = usePermission("owner_report.first_check");
  const canFinalApprove = usePermission("owner_report.final_approve");
  const ownerPartyId = row?.ownerPartyId ?? undefined;
  const apartmentId = row?.apartmentId;
  const summaries = useOwnerMonthlySummaries(ownerPartyId, apartmentId);
  const monthSummary = summaries.data?.data.items.find((item) => item.month === month);
  const statementId = monthSummary?.statementId ?? undefined;
  const statementStatus = monthSummary?.statementStatus ?? "draft";
  const [localStatement, setLocalStatement] = useState<{ id: string; status: string } | null>(null);
  // Reset optimistic state when the dialog is reused for another unit/month.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setLocalStatement(null), [row?.apartmentId, month]);
  const effectiveStatementId = localStatement?.id ?? statementId;
  const effectiveStatementStatus = localStatement?.status ?? statementStatus;
  const generate = useGenerateStatement();
  const firstCheck = useFirstCheckStatement();
  const approve = useApproveStatement();
  const preflight = useStatementApprovalPreflight(effectiveStatementId);
  const issued = useStatementSections(effectiveStatementId);
  const live = useLiveStatementSections(effectiveStatementId ? undefined : ownerPartyId, effectiveStatementId ? undefined : month, apartmentId);
  const sections = issued.data?.data ?? live.data?.data;
  const totalPayoutToOwner = sections?.payoutSummary.lines.find(
    (line) => line.label === "Total Payout to Owner",
  )?.amount ?? sections?.payoutSummary.netPayoutToOwner;
  const loading = summaries.isLoading || issued.isLoading || live.isLoading;
  const failed = summaries.isError || issued.isError || live.isError;
  const changingStatus = generate.isPending || firstCheck.isPending || approve.isPending;

  async function markFirstChecked() {
    if (!row || !ownerPartyId) return;
    try {
      const id = statementId ?? (await generate.mutateAsync({ ownerPartyId, billingMonth: month, apartmentId: row.apartmentId })).data.id;
      const checked = await firstCheck.mutateAsync(id);
      setLocalStatement({ id: checked.data.id, status: checked.data.status });
      toast.success("Owner payout marked First Checked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not mark this report First Checked");
    }
  }

  async function markApproved() {
    if (!effectiveStatementId) return;
    try {
      const approved = await approve.mutateAsync(effectiveStatementId);
      setLocalStatement({ id: approved.data.id, status: approved.data.status });
      toast.success("Owner payout approved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not approve this owner payout");
    }
  }

  return (
    <Dialog open={row != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1200px)] max-w-none overflow-y-auto p-5 sm:p-7">
        <DialogHeader>
          <DialogTitle className="text-2xl text-[var(--navy-text)]">
            Owner Monthly Report · {row?.propertyName} {row?.unitCode}
          </DialogTitle>
          <p className="text-base text-[var(--text-secondary)]">
            {month} · Preview of the report available to this owner
          </p>
        </DialogHeader>

        {!ownerPartyId ? (
          <div className="rounded-xl border border-amber-400 bg-amber-50 p-6 text-center text-base font-semibold text-amber-900">
            No owner is assigned to this unit yet.
          </div>
        ) : loading && !sections ? (
          <div className="space-y-4 py-4 animate-pulse">
            <div className="h-28 rounded-xl bg-[var(--page-bg)]" />
            <div className="h-40 rounded-xl bg-[var(--page-bg)]" />
            <div className="h-48 rounded-xl bg-[var(--page-bg)]" />
          </div>
        ) : failed && !sections ? (
          <div className="rounded-xl border border-red-400 bg-red-50 p-6 text-center text-base font-semibold text-red-800">
            Could not load this owner report. The unit may not have posted owner-ledger activity for this month yet.
          </div>
        ) : sections ? (
          <div className="space-y-5 pt-2" data-testid="owner-report-sections">
            <StatementSectionHeader data={sections.header} />
            <StatementSectionOccupancy data={sections.occupancy} />
            <StatementSectionPayoutSummary data={sections.payoutSummary} />
            <StatementSectionIncome data={sections.incomeBreakdown} />
            <StatementSectionExpenses
              data={sections.expenseBreakdown}
              ownerPartyId={ownerPartyId}
              statementMonth={month}
              apartmentId={sections.apartmentId}
              editable={false}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--page-bg)] p-8 text-center text-base text-[var(--text-secondary)]">
            No owner report activity is available for this unit and month yet.
          </div>
        )}
        {ownerPartyId && sections && (
          <div className="sticky bottom-0 space-y-3 border-t border-[var(--border)] bg-white/95 pt-4 backdrop-blur">
            {effectiveStatementId && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--page-bg)] p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <strong className="text-base text-[var(--navy-text)]">Owner Payout Safety Check</strong>
                  <span className="text-sm font-bold text-[var(--navy-text)]">
                    Total cash payout RM {preflight.data?.data.totalPayoutToOwner ?? totalPayoutToOwner}
                  </span>
                </div>
                {preflight.isLoading ? (
                  <p className="text-sm text-[var(--text-secondary)]">Checking payout safety…</p>
                ) : preflight.isError ? (
                  <p className="font-semibold text-red-700">Safety checks could not be loaded. Approval is disabled.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {preflight.data?.data.checks.map((check) => (
                      <div
                        key={check.code}
                        className={`rounded-lg border px-3 py-2 ${check.status === "block" ? "border-red-400 bg-red-50" : check.status === "warning" ? "border-amber-400 bg-amber-50" : "border-emerald-400 bg-emerald-50"}`}
                      >
                        <div className="flex gap-2">
                          <span aria-hidden>{check.status === "block" ? "●" : check.status === "warning" ? "▲" : "✓"}</span>
                          <div>
                            <p className="font-bold text-[var(--navy-text)]">{check.label}</p>
                            <p className="text-sm text-[var(--text-secondary)]">{check.detail}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end">
            {effectiveStatementStatus === "first_checked" ? (
              canFinalApprove ? <Button className="min-h-12 px-6 text-lg font-bold" disabled={changingStatus || preflight.isLoading || preflight.isError || preflight.data?.data.canApprove === false} onClick={() => void markApproved()}>
                {approve.isPending ? "Approving…" : "Approved"}
              </Button> : <span className="rounded-lg border border-amber-400 bg-amber-50 px-5 py-3 font-bold text-amber-900">First Checked · Waiting for final approval</span>
            ) : !["approved", "sent", "paid"].includes(effectiveStatementStatus) && canFirstCheck ? (
              <Button className="min-h-12 px-6 text-lg font-bold" disabled={changingStatus || (!!effectiveStatementId && (preflight.isLoading || preflight.isError || preflight.data?.data.canFirstCheck === false))} onClick={() => void markFirstChecked()}>
                {changingStatus ? "Saving…" : "First Checked"}
              </Button>
            ) : ["approved", "sent", "paid"].includes(effectiveStatementStatus) ? (
              <span className="rounded-lg border border-emerald-600 bg-[#00FF00] px-5 py-3 text-lg font-extrabold text-[var(--navy-text)]">Approved</span>
            ) : (
              <span className="rounded-lg border border-[var(--border)] bg-[var(--page-bg)] px-5 py-3 font-semibold text-[var(--text-secondary)]">View only</span>
            )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
