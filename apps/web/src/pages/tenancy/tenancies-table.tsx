import { useEffect, useState } from "react";
import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney, getStatusTone } from "@/components/format";
import { TenancyAgreementButton } from "./tenancy-agreement-workspace";
import { daysUntilTenancyEnd, RenewalWorkflowDialog } from "./renewal-workflow-dialog";
import { CancelRenewalDialog } from "./cancel-renewal-dialog";
import { usePermission } from "@/components/permission-gate";

export type TenancyListItem = {
  id: string;
  tenancyCode: string;
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitCode: string;
  tenantPartyId: string;
  tenantName: string;
  status: string;
  billingStatus: string;
  startDate: string;
  endDate: string | null;
  monthlyRentAmount: number;
  depositAmount: number | null;
  previousTenancyId: string | null;
  renewalDecision?: "pending" | "contacted" | "renew" | "not_renew";
  renewalNotes?: string | null;
  renewalFeeCharge?: { id: string; amount: number; status: string } | null;
};

export function TenancyTable({ tenancies, initialRenewalTenancyId }: { tenancies: TenancyListItem[]; initialRenewalTenancyId?: string | null }) {
  const [renewalTenancy, setRenewalTenancy] = useState<TenancyListItem | null>(null);
  const [cancelTenancy, setCancelTenancy] = useState<TenancyListItem | null>(null);
  const canCancelRenewal = usePermission("tenancy.cancel_renewal");
  useEffect(() => {
    // This prop is an imperative deep-link request; mirror it into the dialog state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialRenewalTenancyId) setRenewalTenancy(tenancies.find((row) => row.id === initialRenewalTenancyId) ?? null);
  }, [initialRenewalTenancyId, tenancies]);
  const columns = [
    {
      key: "tenancyCode",
      label: "Tenancy",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.tenancyCode,
      render: (row: TenancyListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.tenancyCode}</span>
      ),
    },
    {
      key: "tenantName",
      label: "Tenant",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.tenantName,
      render: (row: TenancyListItem) => row.tenantName,
    },
    {
      key: "propertyUnit",
      label: "Property / Unit",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.propertyName,
      render: (row: TenancyListItem) => `${row.propertyName} · ${row.unitCode}`,
    },
    {
      key: "startDate",
      label: "Start",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.startDate,
      render: (row: TenancyListItem) => formatDate(row.startDate),
    },
    {
      key: "endDate",
      label: "End",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.endDate ?? "",
      render: (row: TenancyListItem) => formatDate(row.endDate),
    },
    {
      key: "monthlyRentAmount",
      label: "Rent",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.monthlyRentAmount,
      render: (row: TenancyListItem) => formatMoney(row.monthlyRentAmount),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.status,
      render: (row: TenancyListItem) => (
        <StatusPill tone={getStatusTone(row.status)}>{row.status}</StatusPill>
      ),
    },
    {
      key: "renewal",
      label: "Renewal",
      render: (row: TenancyListItem) => {
        if (row.previousTenancyId && row.status === "active" && new Date(row.startDate).getTime() > Date.now()) {
          return canCancelRenewal ? (
            <div className="space-y-2">
              <StatusPill tone="emerald">Renewal created</StatusPill>
              <div className="text-xs text-[var(--text-secondary)]">Starts {formatDate(row.startDate)}</div>
              <Button type="button" size="sm" variant="destructive" onClick={() => setCancelTenancy(row)}>Cancel renewal</Button>
            </div>
          ) : <StatusPill tone="emerald">Renewal created</StatusPill>;
        }
        if (row.status !== "active" || !row.endDate) return "—";
        const decision = row.renewalDecision ?? "pending";
        const daysLeft = daysUntilTenancyEnd(row.endDate);
        const text = decision === "not_renew" ? "Not renewing" : decision === "renew" ? "Renewing" : decision === "contacted" ? "Contacted" : "Pending contact";
        return (
          <div className="space-y-2">
            <StatusPill tone={decision === "renew" ? "emerald" : decision === "not_renew" ? "slate" : "amber"}>{text}</StatusPill>
            {daysLeft != null && daysLeft <= 60 && <div className="text-xs font-bold text-amber-700">{daysLeft >= 0 ? `${daysLeft} days left` : `${Math.abs(daysLeft)} days overdue`}</div>}
            {decision === "renew" && (
              <div className="text-xs text-[var(--text-secondary)]">
                {row.renewalFeeCharge ? `Fee RM ${row.renewalFeeCharge.amount.toFixed(2)} · ${row.renewalFeeCharge.status}` : "Agreement fee not charged"}
              </div>
            )}
            <Button type="button" size="sm" variant={daysLeft != null && daysLeft <= 60 ? "gold" : "outline"} onClick={() => setRenewalTenancy(row)}>Renewal action</Button>
          </div>
        );
      },
    },
    {
      key: "agreement",
      label: "Agreement",
      render: (row: TenancyListItem) => <TenancyAgreementButton tenancy={row} />,
    },
    {
      key: "chain",
      label: "Chain",
      render: (row: TenancyListItem) =>
        row.previousTenancyId
          ? `renewal of ${row.previousTenancyId.slice(0, 8)}...`
          : "root tenancy",
    },
  ];

  return (
    <>
    <EnhancedDataTable
      data={tenancies}
      columns={columns}
      searchPlaceholder="Search tenancies..."
      searchKeys={["tenancyCode", "tenantName", "propertyName", "unitCode"]}
      emptyMessage="No tenancies yet. Create one below."
    />
    <RenewalWorkflowDialog tenancy={renewalTenancy} open={!!renewalTenancy} onOpenChange={(open) => { if (!open) setRenewalTenancy(null); }} />
    <CancelRenewalDialog tenancy={cancelTenancy} open={!!cancelTenancy} onOpenChange={(open) => { if (!open) setCancelTenancy(null); }} />
    </>
  );
}
