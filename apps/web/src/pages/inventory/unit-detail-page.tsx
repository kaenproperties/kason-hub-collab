import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Ruler,
  Wallet,
  User as UserIcon,
  KeyRound as OwnerIcon,
  CalendarCheck,
  Tag,
  Building2,
  Eye,
  EyeOff,
  ListChecks,
  FileText,
  Sparkles,
  Layers,
  Trash2,
  Power,
  PowerOff,
} from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { Card, CardContent } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListingMediaPanel } from "./listing-media-panel";
import { UnitTicketsPanel } from "./unit-tickets-panel";
import { type UnitRowData } from "./edit-unit-dialog";
import { EditApartmentShell } from "./edit-apartment-shell";
import { DeleteUnitDialog } from "./delete-unit-dialog";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { listingLabel, occupancyLabel } from "@/lib/listing-status";

type UnitDetail = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floor: number | null;
  floorArea: number | null;
  rentalRate: number | null;
  currency: string;
  occupancyStatus: string;
  listingStatus: string;
  amenities: { id: string; name: string }[];
  highlights: string[];
  description: string | null;
  photoKeys: string[];
  videoKeys: string[];
  moveInDate: string | null;
  readyNow: boolean;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  hiddenFromAgentNames: string[];
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingAgentId: string | null;
  sourcingAgentName: string | null;
  inChargePartyId: string | null;
  inChargeName: string | null;
  ownerPartyId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  depositMonths: number | null;
  utilitiesDepositMonths: number | null;
  accessCardDepositPerPcs: number | null;
  accessCardQuantity: number | null;
  parkingQuantity: number | null;
  parkingNumbers: string[];
  currentTenancyStartDate: string | null;
  currentTenancyEndDate: string | null;
  // The active Tenancy (tenant ↔ this unit) with the tenant's identity. Already
  // returned by GET /inventory/units/:id (findUnitDetail); the page previously
  // omitted it from this type, so the assigned tenant never rendered.
  // invariant: null means "no active tenancy" (vacant), NOT a regression — an
  // OCCUPIED unit with null here is a data gap (TenantDetailsCard DEV-warns).
  activeTenancy: {
    id: string;
    tenantPartyId: string;
    tenantName: string;
    tenantIdType: string | null;
    tenantIdNumberMasked: string | null;
    tenantPhone: string | null;
    startDate: string;
    endDate: string | null;
    // The tenancy's NEGOTIATED monthly rent — what the tenant actually pays, and
    // what the poster bills. Distinct from the unit's `rentalRate`, which is only
    // the asking rate and is never updated by assigning a tenant. Optional for
    // older-API tolerance; `unitRentDisplay` falls back to the asking rate.
    monthlyRentAmount?: number;
  } | null;
  tenancyHistory?: Array<{
    id: string;
    tenancyCode: string;
    tenantPartyId: string;
    tenantName: string;
    listingLabel: string;
    status: string;
    startDate: string;
    endDate: string | null;
    monthlyRentAmount: number;
  }>;
  property: {
    id: string;
    name: string;
    propertyCode: string;
    city: string | null;
  } | null;
};

function formatRental(amount: number | null, currency: string): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: currency || "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * What the headline "Monthly rental" should say.
 *
 * `rentalRate` is the unit's ASKING rate. Assigning a tenant never updates it —
 * the negotiated figure lives on the Tenancy — so an occupied unit used to
 * headline its stale asking rate (e.g. RM2,200) while the tenant paid RM5. That
 * reads as "the rent I entered was ignored", which is the bug this closes.
 *
 * Occupied + a known tenancy rent ⇒ headline what the tenant PAYS, and keep the
 * asking rate visible (labelled) when the two genuinely differ. Every other case
 * — vacant, no tenancy, or an older API that omits the rent — falls back to the
 * asking rate exactly as before.
 */
export function unitRentDisplay(unit: {
  occupancyStatus: string;
  rentalRate: number | null;
  currency: string;
  activeTenancy: { monthlyRentAmount?: number } | null;
}): { value: string; detail: string } {
  const tenancyRent = unit.activeTenancy?.monthlyRentAmount;
  if (unit.occupancyStatus === "occupied" && tenancyRent != null) {
    const askingDiffers = unit.rentalRate != null && unit.rentalRate !== tenancyRent;
    return {
      value: formatRental(tenancyRent, unit.currency),
      detail: askingDiffers
        ? `tenant pays · asking ${formatRental(unit.rentalRate, unit.currency)}`
        : "tenant pays",
    };
  }
  return { value: formatRental(unit.rentalRate, unit.currency), detail: "asking rate" };
}

function listingTone(status: string): "emerald" | "amber" | "rose" | "default" {
  if (status === "published") return "emerald";
  if (status === "draft") return "amber";
  if (status === "archived") return "rose";
  return "default";
}

export default function UnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canDelete = usePermission("portfolio.delete");
  const canDeactivate = usePermission("portfolio.edit");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const deactivate = useMutation({
    mutationFn: async () => {
      return apiFetch<{ data: { id: string } }>(`/listings/${id}/deactivate`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      toast.success("Listing deactivated.");
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["inventory", "unit", id] });
    },
    onError: (err: Error) => {
      // The API returns a 409 with a DeactivationReport (blockers list)
      // when validation fails. ApiError.data carries the parsed body.
      if (err instanceof ApiError && err.status === 409) {
        const report = (err.data as { error?: { blockers?: Array<{ reason: string; count: number }> } })?.error;
        const blockers = report?.blockers ?? [];
        if (blockers.length > 0) {
          const messages = blockers.map((b) => {
            if (b.reason === "active_tenancy") return `${b.count} active tenancy`;
            if (b.reason === "open_reservation") return `${b.count} open reservation`;
            return `${b.count} ${b.reason}`;
          });
          toast.error(`Cannot deactivate — listing has ${messages.join(" + ")}. End or cancel them first.`);
          return;
        }
      }
      toast.error(err.message || "Failed to deactivate");
    },
  });

  const reactivate = useMutation({
    mutationFn: async () => {
      return apiFetch<{ data: { id: string } }>(`/listings/${id}/reactivate`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      toast.success("Listing reactivated — now in Draft. Edit + publish when ready.");
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["inventory", "unit", id] });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to reactivate"),
  });

  const unitQuery = useQuery({
    queryKey: ["inventory", "unit", id],
    queryFn: () => apiFetch<{ data: UnitDetail }>(`/inventory/units/${id}`),
    enabled: !!id,
    // Don't retry on 404 — the unit was deleted in another tab.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  if (unitQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 w-64 bg-muted rounded" />
        <div className="h-16 bg-muted rounded-xl" />
        <div className="h-96 bg-muted rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="h-64 bg-muted rounded-xl" />
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </div>
    );
  }

  if (unitQuery.isError) {
    const notFound = unitQuery.error instanceof ApiError && unitQuery.error.status === 404;
    return (
      <div className="space-y-4">
        <Link
          to="/inventory"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to inventory
        </Link>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {notFound
                ? "This unit no longer exists."
                : "Failed to load unit details. Please try again."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const unit = unitQuery.data?.data;
  if (!unit) return null;

  const onMediaKeysChange = (next: { photoKeys?: string[]; videoKeys?: string[] }) => {
    queryClient.setQueryData<{ data: UnitDetail } | undefined>(
      ["inventory", "unit", id],
      (prev) =>
        prev
          ? {
              data: {
                ...prev.data,
                photoKeys: next.photoKeys ?? prev.data.photoKeys,
                videoKeys: next.videoKeys ?? prev.data.videoKeys,
              },
            }
          : prev,
    );
  };

  const editableUnit: UnitRowData = {
    id: unit.id,
    propertyName: unit.property?.name ?? "Unknown property",
    unitCode: unit.unitCode,
    unitType: unit.unitType,
    occupancyStatus: unit.occupancyStatus,
    listingStatus: unit.listingStatus,
    rentalRate: unit.rentalRate,
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-muted-foreground">
        <Link to="/inventory" className="hover:text-foreground">Inventory</Link>
        <span className="mx-2">›</span>
        {unit.property ? (
          <span>{unit.property.name}</span>
        ) : (
          <span>Unknown property</span>
        )}
        <span className="mx-2">›</span>
        <span className="text-foreground font-medium">{unit.unitCode}</span>
      </nav>

      {/* Header */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl md:text-3xl font-bold text-foreground font-mono">
                {unit.unitCode}
              </h1>
              <Badge variant={listingTone(unit.listingStatus)}>{listingLabel(unit.listingStatus)}</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {unit.property?.name ?? "Unknown property"} · {unit.unitType} ·{" "}
              {unitRentDisplay(unit).value} · {occupancyLabel(unit.occupancyStatus)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <EditApartmentShell
              unit={editableUnit}
              trigger={
                <Button variant="outline" size="lg">Edit details</Button>
              }
            />
            {canDeactivate && unit.listingStatus !== "archived" && (
              <Button
                variant="outline"
                size="lg"
                disabled={deactivate.isPending}
                onClick={() => setDeactivateOpen(true)}
              >
                <PowerOff className="h-4 w-4 mr-1.5" />
                {deactivate.isPending ? "Deactivating…" : "Deactivate"}
              </Button>
            )}
            {canDeactivate && unit.listingStatus === "archived" && (
              <Button
                variant="outline"
                size="lg"
                disabled={reactivate.isPending}
                onClick={() => reactivate.mutate()}
              >
                <Power className="h-4 w-4 mr-1.5" />
                {reactivate.isPending ? "Reactivating…" : "Reactivate"}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                size="lg"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Delete
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Replaces a window.confirm (banned by the no-restricted-syntax rule —
          it is unstyled, unthemeable and blocks the main thread). Same copy,
          same guard: the mutation only fires on explicit confirmation. Sits
          OUTSIDE the canDelete block — this confirms Deactivate, not Delete. */}
      <ConfirmAlert
        open={deactivateOpen}
        onCancel={() => setDeactivateOpen(false)}
        onConfirm={() => {
          setDeactivateOpen(false);
          deactivate.mutate();
        }}
        title="Deactivate this listing?"
        body={
          <span>
            It stays in the database — charges, tenancies and history are all
            preserved — but is hidden from inventory. You can reactivate it later.
          </span>
        }
        confirmLabel="Deactivate"
        destructive
      />

      {canDelete && (
        <DeleteUnitDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          unitId={unit.id}
          onDeleted={() => {
            queryClient.invalidateQueries({ queryKey: ["inventory"] });
            navigate("/inventory");
          }}
        />
      )}

      {/* Photos & videos hero */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-[18px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
              Photos & videos
            </span>
            <span className="text-xs text-muted-foreground">
              · {unit.photoKeys.length} photos · {unit.videoKeys.length} videos
            </span>
          </div>
          <ListingMediaPanel
            listingId={unit.id}
            photoKeys={unit.photoKeys}
            videoKeys={unit.videoKeys}
            onPhotoKeysChange={(next) => onMediaKeysChange({ photoKeys: next })}
            onVideoKeysChange={(next) => onMediaKeysChange({ videoKeys: next })}
          />
        </CardContent>
      </Card>

      {/* Unit details — stat grid + secondary row */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-5">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-[16px] rounded-sm bg-muted-foreground/60" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Unit details
            </span>
          </div>

          {/* Key metrics grid — GlowCards w/ pointer-tracking glow per anatomy spec */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat
              glowColor="blue"
              icon={<BedDouble className="h-6 w-6 text-sky-400" />}
              iconBg="bg-sky-500/10"
              label="Bedrooms"
              value={unit.bedrooms != null ? String(unit.bedrooms) : "—"}
              detail={unit.bedrooms === 1 ? "room" : "rooms"}
            />
            <Stat
              glowColor="green"
              icon={<Bath className="h-6 w-6 text-emerald-400" />}
              iconBg="bg-emerald-500/10"
              label="Bathrooms"
              value={unit.bathrooms != null ? String(unit.bathrooms) : "—"}
              detail={unit.bathrooms === 1 ? "full bath" : "full baths"}
            />
            <Stat
              glowColor="purple"
              icon={<Ruler className="h-6 w-6 text-violet-400" />}
              iconBg="bg-violet-500/10"
              label="Floor area"
              value={unit.floorArea != null ? String(unit.floorArea) : "—"}
              detail="sqft"
            />
            <Stat
              glowColor="gold"
              icon={<Wallet className="h-6 w-6 text-amber-400" />}
              iconBg="bg-amber-500/10"
              label="Monthly rental"
              value={unitRentDisplay(unit).value}
              detail={unitRentDisplay(unit).detail}
            />
          </div>

          {/* Secondary row — full-width soft cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <MetaRow
              icon={<Tag className="h-4 w-4" />}
              label="Unit type"
              value={<span className="capitalize">{unit.unitType}</span>}
            />
            <MetaRow
              icon={<Layers className="h-4 w-4" />}
              label="Floor"
              value={
                unit.floor != null ? (
                  <span className="font-medium">Level {unit.floor}</span>
                ) : (
                  <span className="text-muted-foreground italic">Not set</span>
                )
              }
            />
            <MetaRow
              icon={<CalendarCheck className="h-4 w-4" />}
              label="Ready"
              value={
                unit.readyNow ? (
                  <Badge variant="emerald">Ready now</Badge>
                ) : unit.moveInDate ? (
                  <span>
                    Move-in <span className="font-medium">{unit.moveInDate.slice(0, 10)}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">Not set</span>
                )
              }
            />
            <MetaRow
              icon={<UserIcon className="h-4 w-4" />}
              label="In charge"
              value={
                unit.inChargeName ? (
                  <span className="font-medium">{unit.inChargeName}</span>
                ) : (
                  <span className="text-muted-foreground italic">Unassigned</span>
                )
              }
            />
            <MetaRow
              icon={<OwnerIcon className="h-4 w-4" />}
              label="Owner"
              value={
                unit.ownerName ? (
                  <span className="font-medium">
                    {unit.ownerPartyId ? (
                      <Link
                        to={`/parties/owners?partyId=${encodeURIComponent(unit.ownerPartyId)}`}
                        className="underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
                      >
                        {unit.ownerName}
                      </Link>
                    ) : unit.ownerName}
                    {unit.ownerPhone ? (
                      <span className="ml-2 font-mono text-muted-foreground">
                        {unit.ownerPhone}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">No owner assigned</span>
                )
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Listing & visibility */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-5">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-[16px] rounded-sm bg-blue-500/80" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-blue-400">
              Listing & visibility
            </span>
          </div>

          {/* Top row — status + visibility + source */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <MetaRow
              icon={<ListChecks className="h-4 w-4" />}
              label="Status"
              value={<Badge variant={listingTone(unit.listingStatus)}>{listingLabel(unit.listingStatus)}</Badge>}
            />
            <MetaRow
              icon={unit.visibilityMode === "PUBLIC" ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              label="Visibility"
              value={
                unit.visibilityMode === "PUBLIC" ? (
                  <Badge variant="emerald">Public</Badge>
                ) : (
                  <Badge variant="amber">Restricted</Badge>
                )
              }
            />
            <MetaRow
              icon={<Building2 className="h-4 w-4" />}
              label="Source"
              value={
                // Post three-table refactor (2026-05-19): Listings are approved
                // by definition — the old Pending/Approved badge read a column
                // that no longer ships from the API, so it pinned to "Pending"
                // forever. Use sourcingAgentId as the truth signal: when set,
                // the unit is agent-sourced and the agent's name is shown
                // inline; otherwise it's a company listing.
                unit.sourcingAgentId == null ? (
                  <span>Company listing</span>
                ) : (
                  <span>
                    Agent sourced
                    {unit.sourcingAgentName ? ` — ${unit.sourcingAgentName}` : ""}
                  </span>
                )
              }
            />
          </div>

          {/* Hidden-from chips */}
          <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <EyeOff className="h-3.5 w-3.5" />
              Hidden from
            </div>
            {unit.hiddenFromAgentNames.length === 0 ? (
              <span className="text-sm text-muted-foreground italic">No agents — visible to all</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {unit.hiddenFromAgentNames.map((name) => (
                  <Badge key={name} variant="rose">{name}</Badge>
                ))}
              </div>
            )}
          </div>

          {/* Amenities chips */}
          <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <ListChecks className="h-3.5 w-3.5" />
              Amenities
            </div>
            {unit.amenities.length === 0 ? (
              <span className="text-sm text-muted-foreground italic">None listed</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {unit.amenities.map((a) => (
                  <Badge key={a.id} variant="outline" className="capitalize">{a.name}</Badge>
                ))}
              </div>
            )}
          </div>

          {/* Highlights chips — free-form per-apartment selling points,
              distinct from the catalog-based Amenities above. */}
          <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <Sparkles className="h-3.5 w-3.5" />
              Highlights
            </div>
            {(unit.highlights ?? []).length === 0 ? (
              <span className="text-sm text-muted-foreground italic">No highlights yet — add via "Edit details".</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {unit.highlights.map((h) => (
                  <Badge key={h} variant="outline">{h}</Badge>
                ))}
              </div>
            )}
          </div>

          {/* Description */}
          <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <FileText className="h-3.5 w-3.5" />
              Description
            </div>
            {unit.description ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">{unit.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No description yet — add one via "Edit details".</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Deposits & parking */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-5">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-[16px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#D4AF37]">
              Deposits & parking
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Rental deposit</div>
              <div>
                {unit.depositMonths != null
                  ? `${unit.depositMonths} ${unit.depositMonths > 1 ? "months" : "month"}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Utilities deposit</div>
              <div>
                {unit.utilitiesDepositMonths != null
                  ? `${unit.utilitiesDepositMonths} ${unit.utilitiesDepositMonths > 1 ? "months" : "month"}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Access cards</div>
              <div>{unit.accessCardQuantity != null ? `${unit.accessCardQuantity} pc(s)` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Access card / pc</div>
              <div>{unit.accessCardDepositPerPcs != null ? `RM ${unit.accessCardDepositPerPcs.toLocaleString()}` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Parking</div>
              <div>{unit.parkingQuantity != null ? `${unit.parkingQuantity} spot(s)` : "—"}</div>
            </div>
            {unit.parkingNumbers.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Parking numbers</div>
                <div className="font-mono">{unit.parkingNumbers.join(", ")}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tenant — the occupying tenant's identity + lease window. Driven by the
          active Tenancy (present even for open-ended leases), replacing the old
          date-only card that hid whenever endDate was null. */}
      <TenantDetailsCard
        tenancy={unit.activeTenancy}
        occupancyStatus={unit.occupancyStatus}
        unitId={unit.id}
      />

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-[3px] h-[16px] rounded-sm bg-[#C9A35C]" />
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#082B4F]">Tenancy history</span>
          </div>
          {(unit.tenancyHistory ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No tenancy history yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[#9DAFC1]">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-[#DFE9F3] text-[#082B4F]">
                  <tr><th className="px-3 py-2 text-left">Tenancy</th><th className="px-3 py-2 text-left">Tenant</th><th className="px-3 py-2 text-left">Listing</th><th className="px-3 py-2 text-left">Period</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-right">Monthly rent</th></tr>
                </thead>
                <tbody>
                  {(unit.tenancyHistory ?? []).map((item) => (
                    <tr key={item.id} className="border-t border-[#9DAFC1]">
                      <td className="px-3 py-2 font-semibold">{item.tenancyCode}</td>
                      <td className="px-3 py-2"><Link className="font-semibold text-[#082F55] underline decoration-[#C9A35C] underline-offset-4" to={`/parties/tenants?partyId=${encodeURIComponent(item.tenantPartyId)}`}>{item.tenantName}</Link></td>
                      <td className="px-3 py-2">{item.listingLabel}</td>
                      <td className="px-3 py-2">{item.startDate} – {item.endDate ?? "Present"}</td>
                      <td className="px-3 py-2"><Badge variant="outline">{item.status}</Badge></td>
                      <td className="px-3 py-2 text-right font-bold">{formatRental(item.monthlyRentAmount, unit.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {isPhase2FlagEnabled("ENABLE_PHASE2_TASKS") && unit && (
        <UnitTicketsPanel unitId={unit.id} />
      )}
    </div>
  );
}

function Stat({
  glowColor,
  icon,
  iconBg,
  label,
  value,
  detail,
}: {
  glowColor: "blue" | "green" | "purple" | "gold" | "orange" | "red";
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <GlowCard
      glowColor={glowColor}
      className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
            {label}
          </p>
          <p className="text-3xl font-bold text-foreground tabular-nums truncate">{value}</p>
          {detail && (
            <p className="text-xs text-muted-foreground truncate">{detail}</p>
          )}
        </div>
        <div className={`p-3 rounded-xl ${iconBg} shrink-0`}>{icon}</div>
      </div>
    </GlowCard>
  );
}

// The tenant currently occupying this unit. Driven by the active Tenancy
// (tenant ↔ unit), NOT by inChargeParty (staff PIC) or ownerParty. Gated on the
// tenancy's presence — not on endDate — so open-ended leases (endDate null)
// still show, which is the case the old date-only card silently hid.
export function TenantDetailsCard({
  tenancy,
  occupancyStatus,
  unitId,
}: {
  tenancy: UnitDetail["activeTenancy"];
  occupancyStatus: string;
  unitId: string;
}) {
  if (!tenancy) {
    // Contract guard (frontend §16): an OCCUPIED unit with no active tenancy is
    // the data gap the user feels as "I assigned a tenant but see nothing".
    if (occupancyStatus === "occupied" && import.meta.env.DEV) {
      console.warn(`[inventory] unit ${unitId} is occupied but the detail DTO carries no activeTenancy`);
    }
    return null;
  }
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardContent className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <div className="w-[3px] h-[16px] rounded-sm bg-blue-500/80" />
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-blue-400">
            Tenant
          </span>
        </div>

        {/* Tenant identity */}
        <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-blue-400 shrink-0" />
            <Link
              to={`/parties/tenants?partyId=${encodeURIComponent(tenancy.tenantPartyId)}`}
              className="text-sm font-semibold text-foreground underline decoration-[var(--gold)] underline-offset-4 hover:text-[var(--gold)]"
            >
              {tenancy.tenantName}
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Phone</div>
              <div className="font-mono">{tenancy.tenantPhone ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                {tenancy.tenantIdType ? tenancy.tenantIdType.toUpperCase() : "ID"}
              </div>
              <div className="font-mono">{tenancy.tenantIdNumberMasked ?? "—"}</div>
            </div>
          </div>
        </div>

        {/* Lease window */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Move-in</div>
            <div>{tenancy.startDate}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Expected move-out</div>
            <div>{tenancy.endDate ?? "Open-ended"}</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground italic">
          Scheduled lease end. We don&apos;t auto-close tenancies — ops adjusts manually when leases roll.
        </p>
      </CardContent>
    </Card>
  );
}

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        {icon}
        {label}
      </div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}
