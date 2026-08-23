import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateUnitDialog, type PropertyOption } from "./create-unit-dialog";
import { StatusPill } from "@/components/ui";
import { getStatusTone } from "@/components/format";
import { EditPropertyDialog, type PropertyRowData } from "./edit-property-dialog";
import { type UnitListItem } from "./units-table";
import {
  AddOwnerButton,
  AddTenantButton,
  ApartmentCard,
  EditApartmentButton,
} from "./apartment-card";
import { EditApartmentShell } from "./edit-apartment-shell";
import {
  getApartmentsByProperty,
  type ApartmentSummary,
} from "@/api/inventory-units-batch";
import { isEditableKeyTarget } from "@/lib/dom";
import { isListedToAgents } from "@/lib/listing-status";
import { usePermission } from "@/components/permission-gate";

export type PropertyListItem = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  status: string;
  unitCount: number;
  occupiedUnits: number;
};

export function PropertyRow({
  property,
  units,
  propertyOptions,
  forceExpanded = false,
}: {
  property: PropertyListItem;
  units: UnitListItem[];
  propertyOptions: PropertyOption[];
  forceExpanded?: boolean;
}) {
  const canCreatePortfolio = usePermission("portfolio.create");
  const canEditPortfolio = usePermission("portfolio.edit");
  const canCreateParties = usePermission("party.create");
  const canCreateTenancy = usePermission("tenancy.create");
  const [expandedLocal, setExpanded] = useState(false);
  const expanded = forceExpanded || expandedLocal;

  const propertyRowData: PropertyRowData = {
    id: property.id,
    name: property.name,
    propertyCode: property.propertyCode,
    propertyType: property.propertyType,
  };
  // "Listed" reflects the agent-portal visibility gate:
  // (listingStatus = "active" AND visibilityMode = "PUBLIC"). The schema
  // does not have a "published" listingStatus value — that string was a
  // pre-existing bug that quietly counted zero on every property.
  const listedCount = units.filter((u) => isListedToAgents(u)).length;

  // Phase D — apartment-grouped view. Fetch on first expansion; cache for
  // 30s so collapsing+reopening doesn't re-fetch. The /properties endpoint
  // already supplied `units` (flat) for the legacy table; we now ignore
  // those for rendering and use the apartment grouping. `units` is still
  // referenced for the listedCount / unitCount summary above so the
  // property row's header still shows totals without a second fetch.
  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments", "by-property", property.id],
    queryFn: () => getApartmentsByProperty(property.id),
    enabled: expanded,
    staleTime: 30_000,
  });
  const apartments: ApartmentSummary[] = apartmentsQuery.data ?? [];

  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Ignore clicks that originated on a button/input inside this row.
          const target = e.target as HTMLElement;
          if (target.closest("button, input, select, a, [data-slot='dialog-trigger']")) {
            return;
          }
          setExpanded((v) => !v);
        }}
        onKeyDown={(e) => {
          // Bail when the keystroke originated inside a child form control
          // (e.g. an input rendered by a portalled <Dialog>). Synthetic
          // events still bubble through the React tree even when the DOM
          // target lives in a portal, so without this guard a Space inside
          // an address field would be swallowed by preventDefault() below.
          if (isEditableKeyTarget(e)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="grid cursor-pointer grid-cols-[20px_2fr_90px_1.4fr_90px_70px_70px_minmax(180px,auto)] items-center gap-3 px-4 py-3 transition hover:bg-[var(--page-bg)]"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`size-4 text-[var(--text-muted)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <div className="font-medium text-[var(--text-primary)]">{property.name}</div>
        <div className="font-mono text-sm font-medium text-[var(--text-primary)]">
          {property.propertyCode}
        </div>
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {property.propertyType}
        </div>
        <div>
          <StatusPill tone={getStatusTone(property.status)}>{property.status}</StatusPill>
        </div>
        <div className="text-sm">{property.unitCount}</div>
        <div className="text-sm">{listedCount}</div>
        <div className="flex justify-end gap-1">
          {canCreatePortfolio && <CreateUnitDialog
            properties={propertyOptions}
            defaultPropertyId={property.id}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Add single unit to ${property.name}`}
                title="Add a single unit"
              >
                <Plus className="size-4" />
                Unit
              </Button>
            }
          />}
          {canEditPortfolio && <EditPropertyDialog
            property={propertyRowData}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Edit property"
                title="Edit property"
              >
                <Pencil />
              </Button>
            }
          />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-dashed border-[var(--border)] bg-[var(--page-bg)] px-4 py-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Apartments in this property
            {apartmentsQuery.data
              ? ` (${apartments.length})`
              : apartmentsQuery.isLoading
                ? " (loading…)"
                : ""}
          </div>
          {apartmentsQuery.isLoading && (
            <div className="space-y-2 animate-pulse">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-20 rounded-xl bg-muted" />
              ))}
            </div>
          )}
          {apartmentsQuery.isError && (
            <p className="text-sm text-rose-500">
              Failed to load apartments.{" "}
              <button
                type="button"
                onClick={() => apartmentsQuery.refetch()}
                className="underline"
              >
                Retry
              </button>
            </p>
          )}
          {apartmentsQuery.data && apartments.length === 0 && (
            <p className="text-sm text-[var(--text-muted)]">
              No apartments in this property yet. Use the{" "}
              <strong>+ Unit</strong> button above to add the first one.
            </p>
          )}
          {apartments.map((apt) => {
            // The shell opens on a room and derives the apartment from its unit
            // code, so it needs one room as the entry anchor. An apartment is
            // built by grouping Unit rows, so rooms is never empty in practice —
            // fall back to no Edit trigger rather than fetching /units/undefined.
            const anchorRoom = apt.rooms[0];
            // A partitioned apartment can have a mix of occupied and vacant
            // rooms. Target the first room without a tenant so the shortcut
            // never opens the form on an already occupied sibling.
            const vacantRoom = apt.rooms.find((room) => !room.tenantName);
            return (
              <ApartmentCard
                key={apt.unitCode}
                apartment={apt}
                addTenantTrigger={
                  canCreateTenancy && vacantRoom ? (
                    <EditApartmentShell
                      initialSection="tenant"
                      initialIntent="addTenant"
                      unit={{
                        id: vacantRoom.id,
                        propertyName: property.name,
                        unitCode: apt.unitCode,
                      }}
                      trigger={<AddTenantButton apartmentCode={apt.unitCode} />}
                    />
                  ) : null
                }
                addOwnerTrigger={
                  canEditPortfolio && canCreateParties && !apt.ownerPartyId && anchorRoom ? (
                    <EditApartmentShell
                      initialSection="owner"
                      unit={{
                        id: anchorRoom.id,
                        propertyName: property.name,
                        unitCode: apt.unitCode,
                      }}
                      trigger={<AddOwnerButton apartmentCode={apt.unitCode} />}
                    />
                  ) : null
                }
                editApartmentTrigger={
                  canEditPortfolio && anchorRoom ? (
                    <EditApartmentShell
                      unit={{
                        id: anchorRoom.id,
                        propertyName: property.name,
                        unitCode: apt.unitCode,
                      }}
                      trigger={<EditApartmentButton apartmentCode={apt.unitCode} />}
                    />
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
