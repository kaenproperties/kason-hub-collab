import type { GridRow } from "@/api/bills-grid";

export type BillConfirmPayer = "tenant" | "owner";

export interface BillConfirmLine {
  key: string;
  label: string;
  detail?: string;
  payer: BillConfirmPayer;
  amount: number;
  /** A server preflight failure means the item exists but this Bill attempt cannot issue it. */
  billingState?: "included" | "blocked";
}

export interface BillConfirmRowSummary {
  lines: BillConfirmLine[];
  tenantTotal: number;
  ownerTotal: number;
  total: number;
  /** False when a compatibility payload is missing money needed for an exact total. */
  totalIsComplete: boolean;
  /** Non-money detail gaps (for example an older aggregate-only recurring payload). */
  detailWarnings: string[];
  /** Money gaps that make `total` a known subtotal rather than the final bill total. */
  incompleteReasons: string[];
  utilityPreviewUnavailable: boolean;
}

export interface BillConfirmSummaryOptions {
  /** Itemized grid charges only exist while the billing-documents issuance rail is enabled. */
  includeGridCharges: boolean;
  /** Expenses have their own narrower issuance flag on top of the grid document rail. */
  includeExpenses: boolean;
}

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const sameMoney = (left: number, right: number): boolean => roundMoney(left) === roundMoney(right);

function amountOf(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? roundMoney(amount) : 0;
}

function addLine(
  lines: BillConfirmLine[],
  line: Omit<BillConfirmLine, "amount"> & { amount: string | number | null | undefined },
  includeZero = false,
): void {
  const amount = amountOf(line.amount);
  if (!includeZero && amount === 0) return;
  lines.push({ ...line, amount });
}

/**
 * Builds the read-only confirmation breakdown from the same saved GridRow snapshot already
 * on screen. This never changes Bill selection or the request body; it only explains it.
 *
 * Management fee, owner payout and top-up are deliberately absent: those values belong to
 * the owner ledger and are not minted by this Bill action.
 */
export function summarizeBillRow(
  row: GridRow,
  options: BillConfirmSummaryOptions,
): BillConfirmRowSummary {
  const lines: BillConfirmLine[] = [];
  const detailWarnings: string[] = [];
  const incompleteReasons: string[] = [];
  const planStatus = options.includeGridCharges && row.entry ? row.billUtilityPlan?.status : undefined;
  const gridPreflightBlocked = planStatus === "pax_blocked" || planStatus === "unavailable";

  if (row.pendingTenancyCharges !== undefined) {
    for (const charge of row.pendingTenancyCharges) {
      const sst = amountOf(charge.sst);
      const payer = charge.payer ?? "tenant";
      const label = charge.kind === "agreement_fee"
        ? "TA (WITH SST)"
        : charge.kind === "renewal_fee"
          ? "Renewal TA (WITH SST)"
          : charge.description;
      addLine(lines, {
        key: `tenancy:${charge.id}`,
        label,
        detail: [
          charge.tenantName?.trim() || (payer === "owner" ? "Owner" : "Tenant"),
          sst > 0 ? `includes RM ${sst.toFixed(2)} SST` : null,
        ].filter(Boolean).join(" · "),
        payer,
        amount: charge.total,
        billingState: gridPreflightBlocked ? "blocked" : "included",
      }, true);
    }
  } else {
    // Rolling-deploy fallback. These aggregate cells cannot distinguish a mixed
    // draft/issued handover or recover per-line SST, so keep them visible but do not
    // present their sum as an exact final bill.
    let hasSavedTenancyFallback = false;
    for (const subRow of row.subRows ?? []) {
      const tenant = subRow.partyName?.trim() || "Tenant";
      if (subRow.rentalBillingState === "saved") {
        hasSavedTenancyFallback = true;
        addLine(lines, {
          key: `rental:${subRow.listingId}`,
          label: "Rental",
          detail: tenant,
          payer: "tenant",
          amount: subRow.rental,
          billingState: gridPreflightBlocked ? "blocked" : "included",
        }, true);
      }
      if (subRow.depositBillingState === "saved") {
        hasSavedTenancyFallback = true;
        addLine(lines, {
          key: `deposit:${subRow.listingId}`,
          label: "Deposit",
          detail: tenant,
          payer: "tenant",
          amount: subRow.deposit,
          billingState: gridPreflightBlocked ? "blocked" : "included",
        }, true);
      }
    }

    if (row.agreementFees?.new.state === "saved") {
      hasSavedTenancyFallback = true;
      addLine(lines, {
        key: "agreement:new",
        label: "TA (WITH SST)",
        detail: "New agreement",
        payer: "tenant",
        amount: row.agreementFees.new.amount,
        billingState: gridPreflightBlocked ? "blocked" : "included",
      }, true);
    }
    if (row.agreementFees?.renewal.state === "saved") {
      hasSavedTenancyFallback = true;
      addLine(lines, {
        key: "agreement:renewal",
        label: "Renewal TA (WITH SST)",
        detail: "Renewal",
        payer: "tenant",
        amount: row.agreementFees.renewal.amount,
        billingState: gridPreflightBlocked ? "blocked" : "included",
      }, true);
    }
    if (hasSavedTenancyFallback) {
      incompleteReasons.push("Exact tenancy draft lines and SST are still loading.");
    }
  }

  let utilityPreviewUnavailable = false;
  if (options.includeGridCharges && row.entry) {
    const plan = row.billUtilityPlan;
    if (plan?.status === "ready") {
      for (const line of plan.lines) {
        const subRow = line.listingId
          ? (row.subRows ?? []).find((candidate) => candidate.listingId === line.listingId)
          : null;
        const tenantDetail = subRow?.partyName?.trim()
          || (line.tenancyId ? "Tenant utility" : "Utility allocation");
        addLine(lines, {
          key: line.key,
          label: line.label,
          detail: line.payer === "tenant" ? tenantDetail : "Owner-borne utility",
          payer: line.payer,
          amount: line.amount,
        });
      }
    } else if (plan?.status !== "not_applicable") {
      utilityPreviewUnavailable = true;
      if (!plan) {
        incompleteReasons.push("The exact server utility plan is unavailable.");
      } else if (plan.status === "pax_blocked") {
        incompleteReasons.push("No charges for this unit will be issued until the affected room occupancy (pax) is fixed.");
      } else if (plan.status === "rebill_review") {
        incompleteReasons.push("Re-Bill charge lines require the server's paid-line review.");
      } else {
        incompleteReasons.push(`No charges for this unit will be issued because the server preflight could not be calculated${plan.errorCode ? ` (${plan.errorCode})` : ""}.`);
      }
    }
  }

  const requiresRebillLineReview = row.billUtilityPlan?.status === "rebill_review";
  // Current server plans only promise fresh grid lines in `ready`. An older payload
  // has no plan, so retain its aggregate compatibility preview but mark it incomplete
  // above. `not_applicable` covers the legacy billed-without-doc short circuit; the
  // server will approve any new tenancy draft but will not mint recurring/expenses.
  const canItemizeFreshGridCharges = row.billUtilityPlan === undefined || row.billUtilityPlan.status === "ready";

  if (options.includeGridCharges && row.entry && !requiresRebillLineReview && canItemizeFreshGridCharges) {
    for (const payer of ["tenant", "owner"] as const) {
      const recurring = row.recurring?.[payer];
      const detailedItems = recurring?.items ?? [];
      const detailedTotal = detailedItems.reduce((total, item) => total + amountOf(item.amount), 0);
      const hasCompleteDetails = detailedItems.length === (recurring?.count ?? 0)
        && sameMoney(detailedTotal, amountOf(recurring?.total));
      if (detailedItems.length > 0 && hasCompleteDetails) {
        for (const item of detailedItems) {
          addLine(lines, {
            key: `recurring:${payer}:${item.id}`,
            label: item.name,
            detail: "Recurring charge",
            payer,
            amount: item.amount,
          });
        }
      } else if ((recurring?.count ?? 0) > 0) {
        addLine(lines, {
          key: `recurring:${payer}:summary`,
          label: `Recurring charges (${recurring!.count} items)`,
          payer,
          amount: recurring!.total,
        });
        detailWarnings.push(`${payer === "tenant" ? "Tenant" : "Owner"} recurring item details are unavailable; the aggregate is shown.`);
      }
    }
  }

  if (options.includeGridCharges && options.includeExpenses && row.entry && !requiresRebillLineReview && canItemizeFreshGridCharges) {
    for (const payer of ["tenant", "owner"] as const) {
      const expenses = row.expenses[payer];
      const detailedItems = expenses.items ?? [];
      const detailedTotal = detailedItems.reduce((total, item) => total + amountOf(item.total), 0);
      const aggregateSst = expenses.sstTotal === undefined ? null : amountOf(expenses.sstTotal);
      const aggregateGross = roundMoney(amountOf(expenses.total) + (aggregateSst ?? 0));
      const hasCompleteDetails = detailedItems.length === expenses.count
        && (aggregateSst === null || sameMoney(detailedTotal, aggregateGross));
      if (detailedItems.length > 0 && hasCompleteDetails) {
        for (const item of detailedItems) {
          const sst = amountOf(item.sst);
          addLine(lines, {
            key: `expense:${payer}:${item.id}`,
            label: item.description,
            detail: sst > 0 ? `Expense · includes RM ${sst.toFixed(2)} SST` : "Expense · no SST",
            payer,
            amount: item.total,
          });
        }
      } else if (expenses.count > 0) {
        // Compatibility fallback for a cached/older GridRow payload without item details.
        // A current payload includes exact per-line SST; the aggregate fallback uses the
        // server-supplied sstTotal when present.
        const sst = aggregateSst ?? 0;
        addLine(lines, {
          key: `expense:${payer}:summary`,
          label: `Expenses (${expenses.count} items)`,
          detail: sst > 0 ? `Includes RM ${sst.toFixed(2)} SST` : undefined,
          payer,
          amount: aggregateGross,
        });
        detailWarnings.push(`${payer === "tenant" ? "Tenant" : "Owner"} expense item details are unavailable; the aggregate is shown.`);
        if (aggregateSst === null && amountOf(expenses.withSstTotal) > 0) {
          incompleteReasons.push(`${payer === "tenant" ? "Tenant" : "Owner"} expense SST is unavailable.`);
        }
      }
    }
  }

  const tenantTotal = roundMoney(lines
    .filter((line) => line.payer === "tenant" && line.billingState !== "blocked")
    .reduce((total, line) => total + line.amount, 0));
  const ownerTotal = roundMoney(lines
    .filter((line) => line.payer === "owner" && line.billingState !== "blocked")
    .reduce((total, line) => total + line.amount, 0));

  return {
    lines,
    tenantTotal,
    ownerTotal,
    total: roundMoney(tenantTotal + ownerTotal),
    totalIsComplete: incompleteReasons.length === 0,
    detailWarnings,
    incompleteReasons,
    utilityPreviewUnavailable,
  };
}

export function summarizeBillRows(
  rows: GridRow[],
  options: BillConfirmSummaryOptions,
): { tenantTotal: number; ownerTotal: number; total: number; totalIsComplete: boolean } {
  return rows.reduce<{ tenantTotal: number; ownerTotal: number; total: number; totalIsComplete: boolean }>(
    (totals, row) => {
      const summary = summarizeBillRow(row, options);
      return {
        tenantTotal: roundMoney(totals.tenantTotal + summary.tenantTotal),
        ownerTotal: roundMoney(totals.ownerTotal + summary.ownerTotal),
        total: roundMoney(totals.total + summary.total),
        totalIsComplete: totals.totalIsComplete && summary.totalIsComplete,
      };
    },
    { tenantTotal: 0, ownerTotal: 0, total: 0, totalIsComplete: true },
  );
}
