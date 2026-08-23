import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TenantTable } from "./tenants-table";
import { CreateTenantDialog } from "./tenants-action-dialogs";
import { PartiesAreaTabs } from "./parties-area-tabs";
import type { TenantListItem } from "./tenants-table";
import { usePermission } from "@/components/permission-gate";

export default function TenantsPage() {
  const canCreateParty = usePermission("party.create");
  const [searchParams] = useSearchParams();
  const focusedPartyId = searchParams.get("partyId");
  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => apiFetch<{ data: TenantListItem[] }>("/parties/tenants"),
  });

  if (tenants.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <PartiesAreaTabs activeTab="tenants" />
        {/* Header band */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="h-7 w-48 rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-4 w-72 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          </div>
          <div className="h-9 w-32 rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
        {/* Metric strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
        {/* Table block */}
        <div className="h-96 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (tenants.isError) {
    return (
      <div className="space-y-6">
        <PartiesAreaTabs activeTab="tenants" />
        <p className="p-6 text-sm text-rose-600">
          Failed to load tenants. Please refresh.
        </p>
      </div>
    );
  }

  const tenantList = tenants.data!.data;
  const activeCount = tenantList.filter((t) => t.status === "active").length;
  const blacklistedCount = tenantList.filter((t) => t.isBlacklisted).length;
  const withOccupationCount = tenantList.filter((t) => t.occupation).length;

  const metrics = [
    {
      label: "Tenants",
      value: tenantList.length,
    },
    {
      label: "Active",
      value: activeCount,
    },
    {
      label: "Blacklisted",
      value: blacklistedCount,
    },
    {
      label: "With occupation",
      value: withOccupationCount,
    },
  ];

  return (
    <div className="space-y-3">
      <PartiesAreaTabs activeTab="tenants" />

      {/* Compact header band */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tenant registry</h1>
          <p className="text-xs text-muted-foreground">
            Identity, tenancy and tenant status.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid min-w-[420px] grid-cols-4 overflow-hidden rounded-xl border border-[var(--card-border)] bg-card shadow-sm">
            {metrics.map((metric) => (
              <div key={metric.label} className="border-r border-[var(--card-border)] px-3 py-2 last:border-r-0">
                <p className="text-[11px] text-muted-foreground">{metric.label}</p>
                <p className="text-lg font-bold leading-tight text-[var(--navy-text)]">{metric.value}</p>
              </div>
            ))}
          </div>
          {canCreateParty && <CreateTenantDialog
            trigger={
              <Button variant="gold">
                <Plus className="size-4" /> New Tenant
              </Button>
            }
          />}
        </div>
      </div>

      {/* Glass table card */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden py-0">
        <TenantTable tenants={tenantList} focusedPartyId={focusedPartyId} />
      </Card>
    </div>
  );
}
