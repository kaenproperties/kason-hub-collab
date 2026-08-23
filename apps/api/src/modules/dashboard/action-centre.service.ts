import { getDb } from "@kason/db";
import { computeManagementFee } from "@kason/shared";
import type { AdminRole } from "../../lib/rbac";
import { resolveOwnerPayoutForScope } from "../owner-ledger/owner-payout-scope.service";
import type { DashboardSession } from "./dashboard.types";

export type ActionSeverity = "critical" | "warning" | "review";

export type ActionCentreItem = {
  id: string;
  category: "billing" | "collections" | "costs" | "bank" | "payout";
  title: string;
  description: string;
  severity: ActionSeverity;
  count: number;
  amount: number | null;
  href: string;
  cta: string;
  breakdown: ActionBreakdownRow[];
};

export type ActionBreakdownRow = {
  id: string;
  label: string;
  detail: string;
  amount: number | null;
};

const money = (value: unknown) => Number(value?.toString?.() ?? 0);

export async function getActionCentreService(session: DashboardSession) {
  const db = getDb();
  const now = new Date();
  // Billing periods are persisted as UTC month boundaries. Creating these dates at
  // local midnight makes Malaysia/Singapore time serialize as the previous UTC
  // date (for example 1 August becomes 31 July), which shifts Month-End Control
  // and owner-payout checks into the wrong month.
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  const renewalWindowEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 2, now.getDate(), 23, 59, 59, 999));
  const recentTenancyStart = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  const org = session.orgId;

  const [
    savedNotBilled,
    overdue,
    pendingPayments,
    missingCosts,
    submittedClaims,
    reimbursementClaims,
    unmatchedBank,
    reviewBank,
    chargeRequired,
    draftPayouts,
    firstCheckedPayouts,
    renewalReviews,
  ] = await Promise.all([
    db.unitBillsGridEntry.count({
      where: {
        organizationId: org,
        periodMonth: { gte: monthStart, lt: nextMonth },
        billedAt: null,
        OR: [
          { rental: { not: null } }, { cleaning: { not: null } }, { tnbTotalRaw: { not: null } },
          { airSelangorRaw: { not: null } }, { wifi: { not: null } }, { maintenanceFee: { not: null } },
          { expenses: { some: { status: "active" } } }, { recurringLines: { some: {} } },
        ],
      },
    }),
    db.charge.aggregate({
      where: { organizationId: org, status: { in: ["posted", "partially_paid"] }, dueDate: { lt: now }, outstandingAmount: { gt: 0 } },
      _count: { _all: true }, _sum: { outstandingAmount: true },
    }),
    db.payment.aggregate({
      where: { organizationId: org, status: "pending_approval" },
      _count: { _all: true }, _sum: { amount: true },
    }),
    db.gridExpense.aggregate({
      where: { organizationId: org, status: "active", amount: { gt: 0 }, actualCost: null },
      _count: { _all: true }, _sum: { amount: true },
    }),
    db.supplierExpense.aggregate({
      where: { organizationId: org, status: "recorded", approvalStatus: "submitted" },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    db.supplierExpense.aggregate({
      where: { organizationId: org, status: "recorded", approvalStatus: "approved", reimbursementStatus: { in: ["awaiting_reimbursement", "partial"] } },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    db.bankReconciliationTransaction.aggregate({
      where: { organizationId: org, status: "unmatched" }, _count: { _all: true }, _sum: { debit: true, credit: true },
    }),
    db.bankReconciliationTransaction.aggregate({
      where: { organizationId: org, status: "review" }, _count: { _all: true }, _sum: { debit: true, credit: true },
    }),
    db.bankReconciliationTransaction.aggregate({
      where: { organizationId: org, chargeRequired: true }, _count: { _all: true }, _sum: { debit: true },
    }),
    db.invoice.aggregate({
      where: { organizationId: org, invoiceType: "owner_statement", periodMonth: { gte: monthStart, lt: nextMonth }, status: "draft", apartmentId: { not: null } },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    db.invoice.aggregate({
      where: { organizationId: org, invoiceType: "owner_statement", periodMonth: { gte: monthStart, lt: nextMonth }, status: "first_checked", apartmentId: { not: null } },
      _count: { _all: true }, _sum: { totalAmount: true },
    }),
    db.tenancy.findMany({
      where: {
        organizationId: org,
        status: "active",
        endDate: { gte: now, lte: renewalWindowEnd },
        renewalDecision: { in: ["pending", "contacted", "renew"] },
      },
      orderBy: { endDate: "asc" },
      select: {
        id: true, endDate: true, renewalDecision: true,
        tenantParty: { select: { displayName: true } },
        unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
        // Renewal SST is a linked payable child, not a second renewal action.
        charges: { where: { chargeType: "renewal_fee", parentChargeId: null, status: { not: "void" } }, take: 1, select: { id: true } },
      },
    }),
  ]);

  const [
    savedRows,
    overdueRows,
    missingCostRows,
    unmatchedBankRows,
    pendingPaymentRows,
    submittedClaimRows,
    reimbursementClaimRows,
    reviewBankRows,
    chargeRequiredRows,
    draftPayoutRows,
    firstCheckedPayoutRows,
  ] = await Promise.all([
    db.unitBillsGridEntry.findMany({
      where: {
        organizationId: org, periodMonth: { gte: monthStart, lt: nextMonth }, billedAt: null,
        OR: [
          { rental: { not: null } }, { cleaning: { not: null } }, { tnbTotalRaw: { not: null } },
          { airSelangorRaw: { not: null } }, { wifi: { not: null } }, { maintenanceFee: { not: null } },
          { expenses: { some: { status: "active" } } }, { recurringLines: { some: {} } },
        ],
      },
      orderBy: [{ apartment: { property: { name: "asc" } } }, { apartment: { unitCode: "asc" } }],
      select: {
        id: true, rental: true, cleaning: true, tnbTotalRaw: true, airSelangorRaw: true, wifi: true, maintenanceFee: true,
        apartment: { select: { unitCode: true, property: { select: { name: true } } } },
        expenses: { where: { status: "active" }, select: { amount: true } },
        recurringLines: { select: { amount: true } },
      },
    }),
    db.charge.findMany({
      where: { organizationId: org, status: { in: ["posted", "partially_paid"] }, dueDate: { lt: now }, outstandingAmount: { gt: 0 } },
      orderBy: [{ dueDate: "asc" }, { chargeNumber: "asc" }],
      select: {
        id: true, chargeNumber: true, description: true, outstandingAmount: true,
        unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
        sourceGridEntry: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      },
    }),
    db.gridExpense.findMany({
      where: { organizationId: org, status: "active", amount: { gt: 0 }, actualCost: null },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true, description: true, amount: true,
        entry: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      },
    }),
    db.bankReconciliationTransaction.findMany({
      where: { organizationId: org, status: "unmatched" },
      orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
      select: { id: true, transactionDate: true, description: true, debit: true, credit: true, account: { select: { nickname: true, bankName: true } } },
    }),
    db.payment.findMany({
      where: { organizationId: org, status: "pending_approval" },
      orderBy: [{ receivedAt: "asc" }, { paymentNumber: "asc" }],
      select: {
        id: true, paymentNumber: true, amount: true, receivedAt: true, referenceNote: true,
        party: { select: { displayName: true } },
      },
    }),
    db.supplierExpense.findMany({
      where: { organizationId: org, status: "recorded", approvalStatus: "submitted" },
      orderBy: [{ expenseDate: "asc" }, { expenseNumber: "asc" }],
      select: { id: true, expenseNumber: true, claimantName: true, supplierName: true, description: true, totalAmount: true },
    }),
    db.supplierExpense.findMany({
      where: { organizationId: org, status: "recorded", approvalStatus: "approved", reimbursementStatus: { in: ["awaiting_reimbursement", "partial"] } },
      orderBy: [{ expenseDate: "asc" }, { expenseNumber: "asc" }],
      select: { id: true, expenseNumber: true, claimantName: true, supplierName: true, description: true, totalAmount: true, bankCostAllocations: { select: { amount: true } } },
    }),
    db.bankReconciliationTransaction.findMany({
      where: { organizationId: org, status: "review" },
      orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
      select: { id: true, transactionDate: true, description: true, debit: true, credit: true, account: { select: { nickname: true, bankName: true } } },
    }),
    db.bankReconciliationTransaction.findMany({
      where: { organizationId: org, chargeRequired: true },
      orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
      select: { id: true, transactionDate: true, description: true, debit: true, account: { select: { nickname: true, bankName: true } } },
    }),
    db.invoice.findMany({
      where: { organizationId: org, invoiceType: "owner_statement", periodMonth: { gte: monthStart, lt: nextMonth }, status: "draft", apartmentId: { not: null } },
      orderBy: [{ invoiceNumber: "asc" }],
      select: { id: true, invoiceNumber: true, apartmentId: true, ownerPartyId: true, totalAmount: true, ownerParty: { select: { displayName: true } } },
    }),
    db.invoice.findMany({
      where: { organizationId: org, invoiceType: "owner_statement", periodMonth: { gte: monthStart, lt: nextMonth }, status: "first_checked", apartmentId: { not: null } },
      orderBy: [{ invoiceNumber: "asc" }],
      select: { id: true, invoiceNumber: true, apartmentId: true, ownerPartyId: true, totalAmount: true, ownerParty: { select: { displayName: true } } },
    }),
  ]);

  const payoutApartmentIds = [...new Set(
    [...draftPayoutRows, ...firstCheckedPayoutRows]
      .map((row) => row.apartmentId)
      .filter((id): id is string => id != null),
  )];
  const payoutApartments = payoutApartmentIds.length > 0
    ? await db.apartment.findMany({
        where: { organizationId: org, id: { in: payoutApartmentIds } },
        select: { id: true, unitCode: true, property: { select: { name: true } } },
      })
    : [];
  const payoutApartmentById = new Map(payoutApartments.map((row) => [row.id, row]));
  const payoutMonthKey = monthStart.toISOString().slice(0, 7);
  const payoutActor = {
    orgId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role as AdminRole,
  };
  const payoutAmountRows = await Promise.all(
    [...draftPayoutRows, ...firstCheckedPayoutRows].map(async (row) => {
      if (!row.ownerPartyId || !row.apartmentId) return [row.id, money(row.totalAmount)] as const;
      const payout = await resolveOwnerPayoutForScope(
        payoutActor,
        row.ownerPartyId,
        payoutMonthKey,
        row.apartmentId,
      );
      return [row.id, payout ? payout.payableToOwnerC / 100 : money(row.totalAmount)] as const;
    }),
  );
  const payoutAmountByInvoiceId = new Map(payoutAmountRows);

  // Revenue-leakage controls. These are intentionally read-only detectors: the
  // source workflow remains the only place that can create charges.
  const [rentEntries, feeConfigs, currentManagementFees, commissionTenancies] = await Promise.all([
    db.unitBillsGridEntry.findMany({
      where: { organizationId: org, periodMonth: { gte: monthStart, lt: nextMonth }, rental: { gt: 0 } },
      select: {
        id: true, periodMonth: true, rental: true,
        apartment: {
          select: {
            id: true, propertyId: true, unitCode: true, property: { select: { name: true } },
            listings: { where: { ownerPartyId: { not: null }, listingStatus: "active" }, select: { id: true, ownerPartyId: true }, take: 1 },
          },
        },
      },
    }),
    db.managementFeeConfig.findMany({ where: { organizationId: org, isActive: true } }),
    db.charge.findMany({
      where: { organizationId: org, chargeType: "management_fee", billingMonth: { gte: monthStart, lt: nextMonth }, status: { notIn: ["void", "credited", "cancelled"] } },
      select: { unitId: true },
    }),
    db.tenancy.findMany({
      where: { organizationId: org, firstMonthIsCommission: true, startDate: { gte: recentTenancyStart, lt: nextMonth }, status: { in: ["active", "pending"] } },
      select: {
        id: true, startDate: true, monthlyRentAmount: true,
        tenantParty: { select: { displayName: true } },
        unit: { select: { id: true, apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
        charges: { where: { chargeType: "letting_commission", status: { notIn: ["void", "credited", "cancelled"] } }, select: { id: true }, take: 1 },
      },
    }),
  ]);
  const managementFeeUnitIds = new Set(currentManagementFees.map((row) => row.unitId).filter(Boolean));
  const missingManagementFeeBreakdown: ActionBreakdownRow[] = [];
  for (const entry of rentEntries) {
    const listing = entry.apartment.listings[0];
    if (!listing?.ownerPartyId || managementFeeUnitIds.has(listing.id)) continue;
    const eligible = feeConfigs.filter((config) => {
      if (config.ownerPartyId !== listing.ownerPartyId) return false;
      if (config.effectiveFrom && monthStart < config.effectiveFrom) return false;
      if (config.effectiveTo && monthStart > config.effectiveTo) return false;
      return config.apartmentId === entry.apartment.id || (config.apartmentId == null && (config.propertyId == null || config.propertyId === entry.apartment.propertyId));
    });
    const config = eligible.find((row) => row.apartmentId === entry.apartment.id)
      ?? eligible.find((row) => row.apartmentId == null && row.propertyId === entry.apartment.propertyId)
      ?? eligible.find((row) => row.apartmentId == null && row.propertyId == null);
    if (!config) continue;
    if (config.freePeriodStart && config.freePeriodEnd && monthStart >= config.freePeriodStart && monthStart <= config.freePeriodEnd) continue;
    const fee = computeManagementFee({ feeType: config.feeType as "percent" | "fixed" | "cap", feeValue: config.feeValue.toString(), capAmount: config.capAmount?.toString() ?? null, sstPercent: config.sstPercent.toString() }, entry.rental!.toString());
    if (Number(fee.base) <= 0) continue;
    missingManagementFeeBreakdown.push({ id: entry.id, label: `${entry.apartment.property.name} ${entry.apartment.unitCode}`, detail: `Rental RM ${money(entry.rental).toFixed(2)} exists · expected management fee has not been generated`, amount: money(fee.total) });
  }
  const missingCommissionBreakdown: ActionBreakdownRow[] = commissionTenancies.filter((row) => row.charges.length === 0).map((row) => ({
    id: row.id,
    label: `${row.unit.apartment.property.name} ${row.unit.apartment.unitCode}`,
    detail: `${row.tenantParty.displayName} · first month is marked as KAEN letting commission, but no owner commission charge exists`,
    amount: money(row.monthlyRentAmount),
  }));

  // Deposit control: KAEN never retains deposits. The payment projection must
  // create an equal owner-payable Deposit balance for every collected amount.
  const [depositCharges, ownerDepositRows] = await Promise.all([
    db.charge.findMany({
      where: {
        organizationId: org,
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: { notIn: ["void", "credited"] },
        tenancyId: { not: null },
      },
      select: {
        id: true,
        tenancyId: true,
        chargeType: true,
        amount: true,
        outstandingAmount: true,
        unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      },
    }),
    db.deposit.groupBy({
      by: ["tenancyId", "type"],
      where: { organizationId: org, status: "released_to_owner" },
      _sum: { amount: true },
    }),
  ]);
  const payableByLeg = new Map(
    ownerDepositRows.map((row) => [
      `${row.tenancyId}:${row.type}`,
      money(row._sum.amount),
    ]),
  );
  const depositExpectedByLeg = new Map<string, { id: string; label: string; collected: number; type: string }>();
  for (const charge of depositCharges) {
    if (!charge.tenancyId) continue;
    const type = charge.chargeType === "security_deposit" ? "rental" : "utilities";
    const key = `${charge.tenancyId}:${type}`;
    const collected = Math.max(0, money(charge.amount) - money(charge.outstandingAmount));
    const apartment = charge.unit?.apartment;
    const current = depositExpectedByLeg.get(key);
    if (current) current.collected += collected;
    else depositExpectedByLeg.set(key, {
      id: charge.id,
      label: apartment ? `${apartment.property.name} ${apartment.unitCode}` : charge.tenancyId,
      collected,
      type,
    });
  }
  const depositMismatchBreakdown: ActionBreakdownRow[] = [...depositExpectedByLeg.entries()]
    .map(([key, row]) => {
      const payable = payableByLeg.get(key) ?? 0;
      const difference = Math.round((row.collected - payable) * 100) / 100;
      return {
        id: row.id,
        label: row.label,
        detail: `${row.type === "rental" ? "Rental" : "Utilities"} deposit · collected RM ${row.collected.toFixed(2)} · owner payable RM ${payable.toFixed(2)}`,
        amount: difference,
      };
    })
    .filter((row) => Math.abs(row.amount ?? 0) >= 0.01);

  // Move-out control: deposits are held by the owner, not KAEN. An ended
  // tenancy remains actionable until the owner's refundable balance has been
  // recorded as returned (or fully supported by deductions).
  const endedTenanciesWithDeposits = await db.tenancy.findMany({
    where: {
      organizationId: org,
      status: "ended",
      deposits: { some: { status: "released_to_owner", amount: { gt: 0 } } },
    },
    select: {
      id: true,
      depositDeductions: true,
      depositRefundAmount: true,
      tenantParty: { select: { displayName: true } },
      unit: { select: { apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      deposits: {
        where: { status: "released_to_owner" },
        select: { amount: true },
      },
    },
  });
  const depositRefundBreakdown: ActionBreakdownRow[] = endedTenanciesWithDeposits
    .map((row) => {
      const settlement = row.depositDeductions && typeof row.depositDeductions === "object" && !Array.isArray(row.depositDeductions)
        ? row.depositDeductions as Record<string, unknown>
        : {};
      const ownerHeld = row.deposits.reduce((sum, item) => sum + money(item.amount), 0);
      const deductions = money(settlement.deductionAmount);
      const refunded = money(row.depositRefundAmount);
      const outstanding = Math.max(0, Math.round((ownerHeld - deductions - refunded) * 100) / 100);
      return {
        id: row.id,
        label: `${row.unit.apartment.property.name} ${row.unit.apartment.unitCode}`,
        detail: `${row.tenantParty.displayName} · owner-held RM ${ownerHeld.toFixed(2)} · deductions RM ${deductions.toFixed(2)} · refunded RM ${refunded.toFixed(2)}`,
        amount: outstanding,
      };
    })
    .filter((row) => (row.amount ?? 0) >= 0.01);

  const savedBreakdown: ActionBreakdownRow[] = savedRows.map((row) => ({
    id: row.id,
    label: `${row.apartment.property.name} ${row.apartment.unitCode}`,
    detail: "Saved unit charges awaiting Bill",
    amount: [row.rental, row.cleaning, row.tnbTotalRaw, row.airSelangorRaw, row.wifi, row.maintenanceFee, ...row.expenses.map((x) => x.amount), ...row.recurringLines.map((x) => x.amount)].reduce<number>((sum, value) => sum + money(value), 0),
  }));
  const overdueBreakdown: ActionBreakdownRow[] = overdueRows.map((row) => {
    const apartment = row.unit?.apartment ?? row.sourceGridEntry?.apartment;
    return { id: row.id, label: apartment ? `${apartment.property.name} ${apartment.unitCode}` : row.chargeNumber, detail: row.description || row.chargeNumber, amount: money(row.outstandingAmount) };
  });
  const missingCostBreakdown: ActionBreakdownRow[] = missingCostRows.map((row) => ({
    id: row.id, label: `${row.entry.apartment.property.name} ${row.entry.apartment.unitCode}`, detail: row.description, amount: money(row.amount),
  }));
  const unmatchedBankBreakdown: ActionBreakdownRow[] = unmatchedBankRows.map((row) => ({
    id: row.id,
    label: `${row.account.nickname || row.account.bankName} · ${row.transactionDate.toISOString().slice(0, 10)}`,
    detail: row.description,
    amount: money(row.debit) + money(row.credit),
  }));

  const paymentVerificationBreakdown: ActionBreakdownRow[] = pendingPaymentRows.map((row) => ({
    id: row.id,
    label: `${row.paymentNumber} · ${row.party.displayName}`,
    detail: `${row.receivedAt.toISOString().slice(0, 10)}${row.referenceNote ? ` · ${row.referenceNote}` : ""}`,
    amount: money(row.amount),
  }));
  const submittedClaimBreakdown: ActionBreakdownRow[] = submittedClaimRows.map((row) => ({
    id: row.id,
    label: `${row.expenseNumber} · ${row.claimantName || row.supplierName}`,
    detail: row.description || row.supplierName,
    amount: money(row.totalAmount),
  }));
  const reimbursementClaimBreakdown: ActionBreakdownRow[] = reimbursementClaimRows.map((row) => {
    const reimbursed = row.bankCostAllocations.reduce((sum, allocation) => sum + money(allocation.amount), 0);
    const remaining = Math.max(0, Math.round((money(row.totalAmount) - reimbursed) * 100) / 100);
    return {
      id: row.id,
      label: `${row.expenseNumber} · ${row.claimantName || row.supplierName}`,
      detail: `${row.description || row.supplierName} · reimbursed RM ${reimbursed.toFixed(2)}`,
      amount: remaining,
    };
  });
  const reviewBankBreakdown: ActionBreakdownRow[] = reviewBankRows.map((row) => ({
    id: row.id,
    label: `${row.account.nickname || row.account.bankName} · ${row.transactionDate.toISOString().slice(0, 10)}`,
    detail: row.description,
    amount: money(row.debit) + money(row.credit),
  }));
  const chargeRequiredBreakdown: ActionBreakdownRow[] = chargeRequiredRows.map((row) => ({
    id: row.id,
    label: `${row.account.nickname || row.account.bankName} · ${row.transactionDate.toISOString().slice(0, 10)}`,
    detail: `${row.description} · customer or owner charge is still missing`,
    amount: money(row.debit),
  }));
  const payoutBreakdown = (
    rows: typeof draftPayoutRows,
    stage: "First Check" | "final Approval",
  ): ActionBreakdownRow[] => rows.map((row) => {
    const apartment = row.apartmentId ? payoutApartmentById.get(row.apartmentId) : undefined;
    return {
      id: row.id,
      label: apartment ? `${apartment.property.name} ${apartment.unitCode}` : row.invoiceNumber,
      detail: `${row.ownerParty?.displayName ?? "Owner not assigned"} · waiting for ${stage}`,
      amount: payoutAmountByInvoiceId.get(row.id) ?? money(row.totalAmount),
    };
  });
  const draftPayoutBreakdown = payoutBreakdown(draftPayoutRows, "First Check");
  const firstCheckedPayoutBreakdown = payoutBreakdown(firstCheckedPayoutRows, "final Approval");

  const noBreakdown: ActionBreakdownRow[] = [];
  const renewalBreakdown: ActionBreakdownRow[] = renewalReviews.map((row) => ({
    id: row.id,
    label: `${row.unit.apartment.property.name} ${row.unit.apartment.unitCode}`,
    detail:
      row.renewalDecision === "pending"
        ? `${row.tenantParty.displayName} · contact tenant before ${row.endDate?.toISOString().slice(0, 10)}`
        : row.renewalDecision === "contacted"
          ? `${row.tenantParty.displayName} · renewal decision pending`
          : row.charges.length === 0
            ? `${row.tenantParty.displayName} · renewing, agreement fee not charged`
            : `${row.tenantParty.displayName} · renewal is ready for completion`,
    amount: null,
  }));

  const candidates: ActionCentreItem[] = [
    { id: "saved-not-billed", category: "billing", title: "Saved charges not billed", description: "This month's saved unit charges still need billing.", severity: "warning", count: savedNotBilled, amount: savedBreakdown.reduce((sum, row) => sum + (row.amount ?? 0), 0), href: "/billing/tenant-owner-billing", cta: "Open billing", breakdown: savedBreakdown },
    { id: "tenancy-renewals", category: "billing", title: "Tenancy renewals due", description: "Tenancies ending within two months need a tenant decision; renewing tenants must have an agreement fee decision.", severity: renewalReviews.some((row) => row.renewalDecision === "renew" && row.charges.length === 0) ? "critical" : "warning", count: renewalReviews.length, amount: null, href: "/tenancy/tenancies", cta: "Review renewals", breakdown: renewalBreakdown },
    { id: "missing-management-fee", category: "billing", title: "Management fees not generated", description: "Rent exists and the unit has an active management-fee setting, but this month's management-fee charge is missing.", severity: "critical", count: missingManagementFeeBreakdown.length, amount: missingManagementFeeBreakdown.reduce((sum, row) => sum + (row.amount ?? 0), 0), href: "/billing/tenant-owner-billing", cta: "Review billing", breakdown: missingManagementFeeBreakdown },
    { id: "missing-letting-commission", category: "billing", title: "First-month commissions not charged", description: "The tenancy is marked as first-month rent commission, but the corresponding owner commission charge is missing.", severity: "critical", count: missingCommissionBreakdown.length, amount: missingCommissionBreakdown.reduce((sum, row) => sum + (row.amount ?? 0), 0), href: "/tenancy/tenancies", cta: "Review tenancies", breakdown: missingCommissionBreakdown },
    { id: "overdue-tenant", category: "collections", title: "Overdue tenant balances", description: "Posted tenant charges are past their due date and still outstanding.", severity: "critical", count: overdue._count._all, amount: money(overdue._sum.outstandingAmount), href: "/billing/tenant-owner-billing", cta: "Review outstanding", breakdown: overdueBreakdown },
    { id: "payment-verification", category: "collections", title: "Payments awaiting verification", description: "Payment proof has been submitted and needs approval or rejection.", severity: "review", count: pendingPayments._count._all, amount: money(pendingPayments._sum.amount), href: "/accounting/receipts", cta: "Verify payments", breakdown: paymentVerificationBreakdown },
    { id: "deposit-owner-transfer", category: "payout", title: "Deposit custody transfers need attention", description: "Collected deposits must be transferred to the owner for custody without becoming owner income. These records do not match and must be reviewed before payout approval.", severity: "critical", count: depositMismatchBreakdown.length, amount: depositMismatchBreakdown.reduce((sum, row) => sum + Math.abs(row.amount ?? 0), 0), href: "/parties", cta: "Review deposit ledgers", breakdown: depositMismatchBreakdown },
    { id: "deposit-owner-refund", category: "payout", title: "Owner deposit refunds outstanding", description: "These tenants have moved out, but the refundable deposit balance has not yet been recorded as returned by the owner.", severity: "critical", count: depositRefundBreakdown.length, amount: depositRefundBreakdown.reduce((sum, row) => sum + (row.amount ?? 0), 0), href: "/tenancy/tenancies", cta: "Complete deposit settlement", breakdown: depositRefundBreakdown },
    { id: "missing-actual-cost", category: "costs", title: "Actual costs not completed", description: "Customer-facing charges exist but their actual cost has not been recorded.", severity: "critical", count: missingCosts._count._all, amount: money(missingCosts._sum.amount), href: "/billing/tenant-owner-billing", cta: "Add costs", breakdown: missingCostBreakdown },
    { id: "claims-approval", category: "costs", title: "Employee claims awaiting approval", description: "Submitted employee expenses need a manager decision.", severity: "review", count: submittedClaims._count._all, amount: money(submittedClaims._sum.totalAmount), href: "/accounting/employee-expense-claims", cta: "Review claims", breakdown: submittedClaimBreakdown },
    { id: "claims-reimbursement", category: "costs", title: "Approved claims awaiting reimbursement", description: "Approved employee advances have not been fully reimbursed.", severity: "warning", count: reimbursementClaims._count._all, amount: reimbursementClaimBreakdown.reduce((sum, row) => sum + (row.amount ?? 0), 0), href: "/accounting/employee-expense-claims", cta: "Open reimbursements", breakdown: reimbursementClaimBreakdown },
    { id: "bank-unmatched", category: "bank", title: "Unmatched bank transactions", description: "Imported bank movements are not linked to their business purpose.", severity: "warning", count: unmatchedBank._count._all, amount: money(unmatchedBank._sum.debit) + money(unmatchedBank._sum.credit), href: "/accounting/bank-reconciliation", cta: "Reconcile bank", breakdown: unmatchedBankBreakdown },
    { id: "bank-review", category: "bank", title: "Bank transactions needing review", description: "Potential duplicate, sequence or categorisation issues need checking.", severity: "critical", count: reviewBank._count._all, amount: money(reviewBank._sum.debit) + money(reviewBank._sum.credit), href: "/accounting/bank-reconciliation", cta: "Review exceptions", breakdown: reviewBankBreakdown },
    { id: "cost-without-charge", category: "bank", title: "Costs awaiting customer charge", description: "Company money went out, but the related tenant or owner charge is still missing.", severity: "critical", count: chargeRequired._count._all, amount: money(chargeRequired._sum.debit), href: "/accounting/bank-reconciliation", cta: "Create missing charges", breakdown: chargeRequiredBreakdown },
    { id: "payout-first-check", category: "payout", title: "Owner payouts awaiting first check", description: "Draft owner reports require the manager's first checking.", severity: "warning", count: draftPayouts._count._all, amount: money(draftPayouts._sum.totalAmount), href: "/billing/tenant-owner-billing", cta: "Check payouts", breakdown: draftPayoutBreakdown },
    { id: "payout-approval", category: "payout", title: "Owner payouts awaiting approval", description: "First-checked owner reports are ready for final approval.", severity: "review", count: firstCheckedPayouts._count._all, amount: money(firstCheckedPayouts._sum.totalAmount), href: "/billing/tenant-owner-billing", cta: "Approve payouts", breakdown: firstCheckedPayoutBreakdown },
  ];
  const items = candidates.filter((item) => item.count > 0);

  return {
    generatedAt: now.toISOString(),
    periodMonth: monthStart.toISOString(),
    summary: {
      total: items.reduce((sum, item) => sum + item.count, 0),
      critical: items.filter((item) => item.severity === "critical").reduce((sum, item) => sum + item.count, 0),
      warning: items.filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.count, 0),
      review: items.filter((item) => item.severity === "review").reduce((sum, item) => sum + item.count, 0),
    },
    items,
  };
}
