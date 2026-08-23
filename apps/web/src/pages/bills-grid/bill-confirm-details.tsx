import type { GridRow } from "@/api/bills-grid";
import { cn } from "@/lib/utils";
import { formatUnitIdentity } from "./grid-table";
import {
  summarizeBillRow,
  summarizeBillRows,
  type BillConfirmSummaryOptions,
} from "./bill-confirm-summary";

function formatMoney(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  const formatted = Math.abs(amount).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `−RM ${formatted}` : `RM ${formatted}`;
}

export function BillConfirmDetails({
  rows,
  billingPeriod,
  options,
}: {
  rows: GridRow[];
  billingPeriod: string;
  options: BillConfirmSummaryOptions;
}) {
  const overall = summarizeBillRows(rows, options);
  const totalLabel = overall.totalIsComplete ? "Selected total" : "Known subtotal";

  return (
    <>
      <section
        className="my-5 grid grid-cols-2 gap-2 rounded-xl border border-[var(--border)] bg-white p-3 sm:grid-cols-5"
        aria-label="Selected bill totals"
        data-testid="bill-confirm-overview"
      >
        {[
          ["Billing period", billingPeriod],
          ["Units", String(rows.length)],
          [overall.totalIsComplete ? "Tenant charges" : "Known tenant charges", formatMoney(overall.tenantTotal)],
          [overall.totalIsComplete ? "Owner charges" : "Known owner charges", formatMoney(overall.ownerTotal)],
          [totalLabel, formatMoney(overall.total)],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={cn(
              "min-w-0 rounded-lg bg-[var(--page-bg)] px-3 py-2",
              index === 4 && "col-span-2 bg-[var(--navy)] text-white sm:col-span-1",
            )}
          >
            <p className={cn("text-xs font-semibold text-muted-foreground", index === 4 && "text-white/70")}>{label}</p>
            <p className={cn(
              "mt-0.5 truncate text-base font-extrabold tabular-nums text-[var(--navy-text)]",
              index === 4 && "text-[var(--gold-light)]",
            )}>{value}</p>
          </div>
        ))}
      </section>

      <div className="space-y-4" data-testid="bill-confirm-units">
        {rows.map((row) => {
          const summary = summarizeBillRow(row, options);
          const unitIdentity = formatUnitIdentity(row.propertyCode, row.unitCode);
          const hasBlockedLines = summary.lines.some((line) => line.billingState === "blocked");
          const awaitingRebillReview = row.billUtilityPlan?.status === "rebill_review";
          const tnbCapBreakdown = options.includeGridCharges
            && row.billUtilityPlan?.status === "ready"
            && row.billUtilityPlan.subsidyPolicy === "unit_tnb_cap_equal_tenancy"
              ? row.billUtilityPlan.tnbSubsidyBreakdown
              : null;
          return (
            <article
              key={row.apartmentId}
              className="overflow-hidden rounded-xl border border-[var(--border)] bg-white shadow-sm"
              data-testid={`bill-confirm-unit-${row.apartmentId}`}
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--table-header)] px-4 py-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Property Short Form + Unit Number</p>
                  <h3 className="text-[19px] font-extrabold text-[var(--navy-text)]">{unitIdentity}</h3>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {hasBlockedLines ? "Bill subtotal · blocked" : summary.totalIsComplete ? "Unit total" : "Known subtotal"}
                  </p>
                  <p className="text-xl font-extrabold tabular-nums text-[var(--navy-text)]" data-testid={`bill-confirm-unit-total-${row.apartmentId}`}>
                    {formatMoney(summary.total)}
                  </p>
                </div>
              </header>

              {tnbCapBreakdown && (
                <section
                  className="border-b border-blue-200 bg-blue-50/70 px-4 py-3"
                  aria-label={`${unitIdentity} TNB subsidy cap breakdown`}
                  data-testid={`bill-confirm-tnb-cap-${row.apartmentId}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-extrabold text-[var(--navy-text)]">TNB monthly unit subsidy</p>
                      <p className="mt-0.5 text-xs text-slate-600">
                        The residual is the master TNB bill after private-meter electricity. This explanation does not add another charge line.
                      </p>
                    </div>
                    <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs font-bold text-blue-900">
                      Equal split · {tnbCapBreakdown.occupiedRoomCount} occupied {tnbCapBreakdown.occupiedRoomCount === 1 ? "room" : "rooms"}
                    </span>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    {[
                      ["TNB residual", formatMoney(Number(tnbCapBreakdown.residual))],
                      ["Owner monthly cap", formatMoney(Number(tnbCapBreakdown.ownerCap))],
                      ["Owner portion", formatMoney(Number(tnbCapBreakdown.ownerPortion))],
                      ["Tenant excess", formatMoney(Number(tnbCapBreakdown.tenantExcess))],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-blue-100 bg-white px-3 py-2">
                        <dt className="text-xs font-semibold text-slate-500">{label}</dt>
                        <dd className="mt-0.5 font-extrabold tabular-nums text-[var(--navy-text)]">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  {tnbCapBreakdown.allocations.length > 0 && (
                    <div className="mt-3 rounded-lg border border-blue-100 bg-white px-3 py-2">
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Tenant excess by occupied room</p>
                      <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        {tnbCapBreakdown.allocations.map((allocation, index) => {
                          const subRow = (row.subRows ?? []).find((candidate) =>
                            candidate.listingId === allocation.listingId
                            && (!candidate.tenancyId || candidate.tenancyId === allocation.tenancyId),
                          );
                          const tenantLabel = subRow?.partyName?.trim() || `Occupied room ${index + 1}`;
                          return (
                            <li key={`${allocation.listingId}:${allocation.tenancyId}`} className="flex items-center justify-between gap-3">
                              <span className="min-w-0 truncate text-slate-700">{tenantLabel}</span>
                              <span className="shrink-0 font-extrabold tabular-nums text-[var(--navy-text)]">
                                {formatMoney(Number(allocation.amount))}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {summary.lines.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] table-fixed text-sm" aria-label={`${unitIdentity} charge breakdown`}>
                    <thead className="bg-[var(--page-bg)] text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="w-[58%] px-4 py-2 text-left">
                          {hasBlockedLines ? "Charges waiting to bill" : "What will be billed"}
                        </th>
                        <th className="w-[18%] px-2 py-2 text-left">Billed to</th>
                        <th className="w-[24%] px-4 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.lines.map((line) => (
                        <tr key={line.key} className="border-t border-[var(--border)]/70" data-testid={`bill-confirm-line-${row.apartmentId}`}>
                          <td className="px-4 py-2.5 align-top">
                            <p className="font-bold text-[var(--navy-text)]">{line.label}</p>
                            {line.detail && <p className="mt-0.5 text-xs text-muted-foreground">{line.detail}</p>}
                            {line.billingState === "blocked" && (
                              <p className="mt-1 text-xs font-bold text-amber-800">Blocked · not included in this Bill subtotal</p>
                            )}
                          </td>
                          <td className="px-2 py-2.5 align-top">
                            <span className={cn(
                              "inline-flex rounded-full border px-2 py-0.5 text-xs font-bold",
                              line.payer === "tenant"
                                ? "border-blue-200 bg-blue-50 text-blue-800"
                                : "border-amber-300 bg-amber-50 text-amber-900",
                            )}>
                              {line.payer === "tenant" ? "Tenant" : "Owner"}
                            </span>
                          </td>
                          <td className={cn(
                            "px-4 py-2.5 text-right align-top font-extrabold tabular-nums text-[var(--navy-text)]",
                            line.amount < 0 && "text-emerald-700",
                          )}>{formatMoney(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-[var(--navy)] bg-[var(--page-bg)] text-sm font-bold text-[var(--navy-text)]">
                      <tr>
                        <td colSpan={2} className="px-4 pt-2.5 text-right text-muted-foreground">Tenant subtotal</td>
                        <td className="px-4 pt-2.5 text-right tabular-nums">{formatMoney(summary.tenantTotal)}</td>
                      </tr>
                      <tr>
                        <td colSpan={2} className="px-4 pb-2.5 pt-1 text-right text-muted-foreground">Owner subtotal</td>
                        <td className="px-4 pb-2.5 pt-1 text-right tabular-nums">{formatMoney(summary.ownerTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  {awaitingRebillReview
                    ? "Re-Bill line amounts will be determined after the server's paid-line review."
                    : summary.incompleteReasons.length > 0
                    ? "No charge can be issued for this unit until the server preflight issue is resolved."
                    : "No saved charge lines are available for this unit."}
                </p>
              )}

              {summary.detailWarnings.length > 0 && (
                <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700" role="status">
                  {summary.detailWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                </div>
              )}
              {summary.incompleteReasons.length > 0 && (
                <div className="border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900" role="status">
                  <p>Known amounts are shown, but the exact unit total is not available yet.</p>
                  {summary.incompleteReasons.map((reason) => <p key={reason} className="mt-0.5 font-normal">{reason}</p>)}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
