import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Eye, Plus, Search, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { CreatePropertyDialog } from "./create-property-dialog";
import type { PropertyOption } from "./create-unit-dialog";
import { PropertyRow, type PropertyListItem } from "./property-row";
import type { UnitListItem } from "./units-table";
import { InventoryAgentViewTab } from "./agent-view-tab";
import { usePermission } from "@/components/permission-gate";

// ─── Tab plumbing ────────────────────────────────────────────────────────────
//
// Two views over the same inventory:
//   - "admin"  → property → expand → units table. Operator workflow.
//   - "agent"  → card grid + rich filters. Mirrors what an agent sees at
//                /portal/inventory but admin-scoped (every unit, no agent
//                visibility filter). Useful for triage and previewing how
//                listings appear in the portal.
//
// `?view=...` is in the URL so deep-links and back/forward navigate cleanly.
// Same plumbing as /workspace/renovation-settings for consistency.

type ViewKey = "admin" | "agent";
const VIEW_KEYS: ViewKey[] = ["admin", "agent"];

const VIEW_LABELS: Record<ViewKey, string> = {
  admin: "Admin view",
  agent: "Agent view",
};

const VIEW_ICONS: Record<ViewKey, typeof Building2> = {
  admin: Users,
  agent: Eye,
};

function isViewKey(v: string | null): v is ViewKey {
  return v != null && (VIEW_KEYS as string[]).includes(v);
}

const DEFAULT_VIEW: ViewKey = "admin";

// ─── Page ────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "vacant" | "occupied";

const STATUS_PILLS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "vacant", label: "Vacant" },
  { value: "occupied", label: "Occupied" },
];

type InventorySummary = {
  propertyCount: number;
  unitCount: number;
  occupiedUnits: number;
  vacantUnits: number;
};

export default function InventoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get("view");
  const view: ViewKey = isViewKey(rawView) ? rawView : DEFAULT_VIEW;

  useEffect(() => {
    if (rawView !== null && !isViewKey(rawView)) {
      setSearchParams({ view: DEFAULT_VIEW }, { replace: true });
    }
  }, [rawView, setSearchParams]);

  const summary = useQuery({
    queryKey: ["inventory", "summary"],
    queryFn: () => apiFetch<{ data: InventorySummary }>("/inventory/summary"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Properties and unit inventory"
        description="Switch between the operator workflow and the agent's card-grid view of the same units."
        icon={Building2}
        metrics={
          summary.data
            ? [
                { label: "Properties", value: String(summary.data.data.propertyCount), hint: "Tracked portfolio count" },
                { label: "Units", value: String(summary.data.data.unitCount), hint: "All rentable unit records" },
                { label: "Occupied", value: String(summary.data.data.occupiedUnits), hint: "Units with active occupancy" },
                { label: "Vacant", value: String(summary.data.data.vacantUnits), hint: "Units open for placement" },
              ]
            : undefined
        }
      />

      <div
        className="flex flex-wrap gap-1 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
        role="tablist"
        aria-label="Inventory view"
      >
        {VIEW_KEYS.map((key) => {
          const Icon = VIEW_ICONS[key];
          const active = view === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                // Reset URL state cleanly when switching views — agent view
                // owns its own filter params (?q=, ?beds=, etc.) which would
                // be confusing if they hung around on the admin tab.
                setSearchParams({ view: key });
              }}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                active
                  ? "bg-[var(--primary)] text-white shadow-sm"
                  : "text-[var(--text-secondary)] hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {VIEW_LABELS[key]}
            </button>
          );
        })}
      </div>

      {view === "admin" ? <AdminViewTab /> : <InventoryAgentViewTab />}
    </div>
  );
}

// ─── Admin view (property → expand → units table) ──────────────────────────

function AdminViewTab() {
  const canCreatePortfolio = usePermission("portfolio.create");
  const [searchQ, setSearchQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const properties = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: PropertyListItem[] }>("/inventory/properties"),
  });

  const units = useQuery({
    queryKey: ["inventory", "units"],
    queryFn: () => apiFetch<{ data: UnitListItem[] }>("/inventory/units"),
  });

  const propertyOptions = useMemo<PropertyOption[]>(
    () =>
      (properties.data?.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        propertyCode: p.propertyCode,
      })),
    [properties.data],
  );

  const filteredUnits = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    return (units.data?.data ?? []).filter((u) => {
      if (statusFilter !== "all" && u.occupancyStatus !== statusFilter) return false;
      if (q && !`${u.unitCode} ${u.propertyName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [units.data, searchQ, statusFilter]);

  const unitsByPropertyId = useMemo(() => {
    const m = new Map<string, UnitListItem[]>();
    for (const u of filteredUnits) {
      const arr = m.get(u.propertyId) ?? [];
      arr.push(u);
      m.set(u.propertyId, arr);
    }
    return m;
  }, [filteredUnits]);

  const filteredProperties = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const list = properties.data?.data ?? [];
    return list.filter((p) => {
      const propMatches = !q || `${p.name} ${p.propertyCode}`.toLowerCase().includes(q);
      const hasMatchingUnits = (unitsByPropertyId.get(p.id)?.length ?? 0) > 0;
      if (statusFilter !== "all") return hasMatchingUnits;
      return propMatches || hasMatchingUnits;
    });
  }, [properties.data, unitsByPropertyId, searchQ, statusFilter]);

  const anyFilterActive = searchQ.trim() !== "" || statusFilter !== "all";

  const isLoading = properties.isLoading || units.isLoading;
  const hasError = properties.isError || units.isError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load inventory data. Please refresh.
      </p>
    );
  }

  const propertyList = filteredProperties;

  return (
    <Surface
      title="Property register"
      description="Click a unit code to manage its photos and listing."
      actions={
        canCreatePortfolio ? <CreatePropertyDialog
          trigger={
            <Button>
              <Plus /> New Property
            </Button>
          }
        /> : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--page-bg)] px-4 py-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search property name, code, or unit code"
            aria-label="Search inventory"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] pl-8 pr-8 py-1.5 text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--gold)]"
          />
          {searchQ && (
            <button
              type="button"
              onClick={() => setSearchQ("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card-bg)] p-0.5">
          {STATUS_PILLS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setStatusFilter(p.value)}
              aria-pressed={statusFilter === p.value}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                statusFilter === p.value
                  ? "bg-[var(--gold)]/15 text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {propertyList.length} {propertyList.length === 1 ? "property" : "properties"}
        </div>
      </div>
      {propertyList.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
          {anyFilterActive
            ? "No properties match the current filters."
            : canCreatePortfolio
              ? <>No properties yet. Use <strong>+ New Property</strong> above to create one.</>
              : "No properties yet."}
        </p>
      ) : (
        <div>
          <div className="grid grid-cols-[20px_2fr_90px_1.4fr_90px_70px_70px_minmax(180px,auto)] gap-3 border-b border-[var(--border)] bg-[var(--page-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <div></div>
            <div>Property</div>
            <div>Code</div>
            <div>Type</div>
            <div>Status</div>
            <div>Units</div>
            <div>Listed</div>
            <div className="text-right">Actions</div>
          </div>
          {propertyList.map((p) => (
            <PropertyRow
              key={p.id}
              property={p}
              units={unitsByPropertyId.get(p.id) ?? []}
              propertyOptions={propertyOptions}
              forceExpanded={anyFilterActive && (unitsByPropertyId.get(p.id)?.length ?? 0) > 0}
            />
          ))}
        </div>
      )}
    </Surface>
  );
}
