import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { OwnerTable } from "./owners-table";
import { CreateOwnerDialog } from "./owners-action-dialogs";
import { PartiesAreaTabs } from "./parties-area-tabs";
import type { OwnerListItem } from "./owners-table";
import { usePermission } from "@/components/permission-gate";

export default function OwnersPage() {
  const canCreateParty = usePermission("party.create");
  const [searchParams] = useSearchParams();
  const focusedPartyId = searchParams.get("partyId");
  const owners = useQuery({
    queryKey: ["owners"],
    queryFn: () => apiFetch<{ data: OwnerListItem[] }>("/parties/owners"),
  });

  if (owners.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <PartiesAreaTabs activeTab="owners" />
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (owners.isError) {
    return (
      <div className="space-y-6">
        <PartiesAreaTabs activeTab="owners" />
        <p className="p-6 text-sm text-rose-600">
          Failed to load owners. Please refresh.
        </p>
      </div>
    );
  }

  const ownerList = owners.data!.data;
  const blacklistedCount = ownerList.filter((o) => o.isBlacklisted).length;
  const ownerMetrics = [
    { label: "Owners", value: ownerList.length },
    { label: "Active", value: ownerList.filter((o) => o.status === "active").length },
    { label: "Blacklisted", value: blacklistedCount },
    { label: "Reachable", value: ownerList.filter((o) => o.primaryEmail || o.primaryPhone).length },
  ];

  return (
    <div className="space-y-3">
      <PartiesAreaTabs activeTab="owners" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--navy-text)]">Owner registry</h1>
          <p className="text-xs text-muted-foreground">Identity, bank details and owner status.</p>
        </div>
        <div className="grid min-w-[420px] grid-cols-4 overflow-hidden rounded-xl border border-[var(--card-border)] bg-card shadow-sm">
          {ownerMetrics.map((metric) => (
            <div key={metric.label} className="border-r border-[var(--card-border)] px-3 py-2 last:border-r-0">
              <p className="text-[11px] text-muted-foreground">{metric.label}</p>
              <p className="text-lg font-bold leading-tight text-[var(--navy-text)]">{metric.value}</p>
            </div>
          ))}
        </div>
      </div>
      <Surface
        title="Owner records"
        description="Role-backed party records with status and screening visibility."
        actions={
          canCreateParty ? <CreateOwnerDialog
            trigger={
              <Button variant="gold">
                <Plus className="size-4" /> New Owner
              </Button>
            }
          /> : undefined
        }
      >
        <OwnerTable owners={ownerList} focusedPartyId={focusedPartyId} />
      </Surface>
    </div>
  );
}
