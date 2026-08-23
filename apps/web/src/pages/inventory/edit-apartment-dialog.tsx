// EditApartmentDialog — Phase D of 2026-05-13 apartment-aggregation spec.
//
// Lightweight dialog for editing apartment-scoped fields only (no rooms,
// no per-room visibility / in-charge / occupancy). Used from the apartment
// card on the property page. Routes through the existing batch endpoint
// with `rooms: []` + `applyToExistingSiblings: true` so the fan-out path
// is the single source of truth for "edit the whole apartment at once."
//
// Why a separate dialog from CreateRoomsMultiDialog: that one mixes adding
// new rooms with editing shared fields. The apartment card surfaces a
// dedicated "Edit apartment" button for the pure-edit case so admin
// doesn't have to discover the empty-rooms path in the multi-room form.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AmenityCombobox } from "@/components/amenity-combobox";
import { TagInput } from "@/components/tag-input";
import { useActiveAmenities } from "@/hooks/use-amenities";
import {
  createUnitsBatch,
  updateApartmentShared,
  type ApartmentSummary,
  type CreateUnitsBatchSharedFields,
} from "@/api/inventory-units-batch";
import { ListingModeFlipDialog } from "./listing-mode-flip-dialog";
import { Segmented } from "@/components/ui/segmented";
import type { PartitionBillingMode } from "@kason/shared";
import { OwnerSelect } from "./unit-form-fields";
import { OwnerConfirmCard } from "./owner-confirm-card";
import { CarparksSection } from "./carparks-section";

// Form state — mirrors CreateUnitsBatchSharedFields shape but with `floor`
// etc. typed as strings while the form renders (matching the existing
// pattern in unit-form-fields.tsx). Coerced to numbers at submit.
type ApartmentFormState = {
  unitCode: string;
  floor: string;
  bedrooms: string;
  bathrooms: string;
  floorArea: string;
  amenities: string[];
  highlights: string[];
  description: string;
  partitionBillingMode: PartitionBillingMode | null;
  tnbSubsidyCapMonthly: string;
  // Owner — apartment-scoped, fans out to every room server-side
  ownerPartyId: string | null;
  ownerName: string;
  ownerPhone: string | null;
};

function apartmentToForm(apt: ApartmentSummary): ApartmentFormState {
  return {
    unitCode: apt.unitCode,
    floor: apt.floor != null ? String(apt.floor) : "",
    bedrooms: apt.bedrooms != null ? String(apt.bedrooms) : "",
    bathrooms: apt.bathrooms != null ? String(apt.bathrooms) : "",
    floorArea: apt.floorArea != null ? String(apt.floorArea) : "",
    amenities: apt.amenities.map((a) => a.id),
    highlights: apt.highlights,
    description: apt.description ?? "",
    partitionBillingMode: apt.partitionBillingMode ?? null,
    tnbSubsidyCapMonthly:
      apt.tnbSubsidyCapMonthly == null ? "" : String(apt.tnbSubsidyCapMonthly),
    ownerPartyId: apt.ownerPartyId,
    ownerName: apt.ownerName ?? "",
    ownerPhone: apt.ownerPhone,
  };
}

function parseInt0(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function parseNonNeg(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Apartment-scoped delta detection. Mirrors the spec's "shared field
// changed" rules (canonical helper: `apartmentScopedChangedFields` in
// edit-unit-dialog.tsx). Different storage shape, same semantics.
export function apartmentFormChangedFields(
  initial: ApartmentFormState,
  current: ApartmentFormState,
): string[] {
  const changed: string[] = [];
  const scalars: Array<keyof ApartmentFormState> = [
    "bedrooms",
    "bathrooms",
    "floor",
    "floorArea",
  ];
  for (const f of scalars) {
    const a = initial[f] === "" ? null : initial[f];
    const b = current[f] === "" ? null : current[f];
    if (a !== b) changed.push(f);
  }
  if (initial.description.trim() !== current.description.trim()) {
    changed.push("description");
  }
  if (initial.partitionBillingMode !== current.partitionBillingMode) {
    changed.push("partitionBillingMode");
  }
  if (initial.tnbSubsidyCapMonthly !== current.tnbSubsidyCapMonthly) {
    changed.push("tnbSubsidyCapMonthly");
  }
  if (initial.ownerPartyId !== current.ownerPartyId) {
    changed.push("ownerPartyId");
  }
  const setEq = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sortA = [...a].sort();
    const sortB = [...b].sort();
    return sortA.every((v, i) => v === sortB[i]);
  };
  if (!setEq(initial.amenities, current.amenities)) changed.push("amenities");
  if (!setEq(initial.highlights, current.highlights)) changed.push("highlights");
  return changed;
}

function formToSharedPayload(
  state: ApartmentFormState,
  propertyId: string,
): CreateUnitsBatchSharedFields {
  return {
    propertyId,
    unitCode: state.unitCode,
    floor: parseInt0(state.floor),
    bedrooms: parseInt0(state.bedrooms),
    bathrooms: parseNonNeg(state.bathrooms),
    floorArea: parseInt0(state.floorArea),
    amenities: state.amenities,
    highlights: state.highlights,
    description: state.description.trim() === "" ? null : state.description,
    partitionBillingMode: state.partitionBillingMode ?? undefined,
  };
}

export function EditApartmentDialog({
  trigger,
  apartment,
  propertyId,
  propertyName,
}: {
  trigger: ReactNode;
  apartment: ApartmentSummary;
  propertyId: string;
  propertyName: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const amenitiesQuery = useActiveAmenities();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Edit shared details · {apartment.unitCode}
          </DialogTitle>
          <DialogDescription>
            Update shared fields for every room in this apartment under{" "}
            <strong>{propertyName}</strong>. Per-room fields (rent, occupancy,
            parking) stay on each individual room.
          </DialogDescription>
        </DialogHeader>
        {/* Mount the form fresh on each open so the snapshot baseline
            reflects the current apartment state. */}
        {open && (
          <EditApartmentForm
            apartment={apartment}
            propertyId={propertyId}
            amenitiesCatalog={amenitiesQuery.data ?? []}
            amenitiesLoading={amenitiesQuery.isLoading}
            onClose={() => setOpen(false)}
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["inventory"] });
              queryClient.invalidateQueries({
                queryKey: ["inventory", "apartments", "by-property", propertyId],
              });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// Human-readable labels for the apartment-scoped fields surfaced in the
// confirm modal. The key is the raw field name pushed by apartmentFormChangedFields.
// Unmapped keys fall back to the raw key string.
const FIELD_LABELS: Record<string, string> = {
  floor: "Floor",
  bedrooms: "Bedrooms",
  bathrooms: "Bathrooms",
  floorArea: "Floor area",
  amenities: "Amenities",
  highlights: "Highlights",
  description: "Description",
  partitionBillingMode: "Billing model",
  tnbSubsidyCapMonthly: "Monthly TNB owner subsidy cap",
  ownerPartyId: "Owner",
};

function EditApartmentForm({
  apartment,
  propertyId,
  amenitiesCatalog,
  amenitiesLoading,
  onClose,
  onSuccess,
}: {
  apartment: ApartmentSummary;
  propertyId: string;
  amenitiesCatalog: { id: string; name: string }[];
  amenitiesLoading: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState<ApartmentFormState>(() =>
    apartmentToForm(apartment),
  );
  const initialSnapshot = useRef<ApartmentFormState>(form);
  const [confirmFields, setConfirmFields] = useState<string[] | null>(null);
  const [flipOpen, setFlipOpen] = useState<"WHOLE" | "PARTITIONED" | null>(null);

  const currentModeLabel =
    apartment.listingMode === "WHOLE" ? "Whole" :
    apartment.listingMode === "PARTITIONED" ? "Partitioned" :
    apartment.listingMode === "MIXED" ? "Mixed — needs review" :
    "No active listing";

  const changedFields = useMemo(
    // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
    () => apartmentFormChangedFields(initialSnapshot.current, form),
    [form],
  );

  const set = (patch: Partial<ApartmentFormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await createUnitsBatch({
        shared: formToSharedPayload(form, propertyId),
        rooms: [],
        applyToExistingSiblings: true,
      });
      // Apartment-scoped fields (partitionBillingMode, ownerPartyId) are
      // stripped by the batch path — persist them through the dedicated
      // apartment endpoint in one call whenever either changed.
      const apartmentPatch: Parameters<typeof updateApartmentShared>[1] = {};
      if (changedFields.includes("partitionBillingMode") && form.partitionBillingMode) {
        apartmentPatch.partitionBillingMode = form.partitionBillingMode;
      }
      if (changedFields.includes("tnbSubsidyCapMonthly")) {
        apartmentPatch.tnbSubsidyCapMonthly =
          form.tnbSubsidyCapMonthly.trim() === ""
            ? null
            : Number(form.tnbSubsidyCapMonthly);
      }
      if (changedFields.includes("ownerPartyId")) {
        apartmentPatch.ownerPartyId = form.ownerPartyId;
      }
      if (Object.keys(apartmentPatch).length > 0) {
        await updateApartmentShared(apartment.id, apartmentPatch);
      }
      return result;
    },
    onSuccess: (data) => {
      toast.success(
        data.updatedIds.length === 1
          ? "Apartment updated (1 room synced)."
          : `Apartment updated (${data.updatedIds.length} rooms synced).`,
      );
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update apartment.");
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      form.tnbSubsidyCapMonthly.trim() !== "" &&
      (!/^\d+(\.\d{1,2})?$/.test(form.tnbSubsidyCapMonthly.trim()) ||
        Number(form.tnbSubsidyCapMonthly) > 9_999_999_999.99)
    ) {
      toast.error("Enter a nonnegative monthly TNB subsidy cap with no more than 2 decimal places.");
      return;
    }
    if (changedFields.length === 0) {
      toast.info("No changes to save.");
      return;
    }
    setConfirmFields(changedFields);
  }

  const affectedRoomTypes = apartment.rooms.map((r) => r.unitType).join(", ");

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-5">
        {apartment.hasDrift && (
          <Callout variant="warning" title="Drift detected">
            Sibling rooms currently disagree on shared fields. Values below
            come from the earliest-created room ({apartment.rooms[0]?.unitType}).
            Saving will overwrite the drift on every sibling.
          </Callout>
        )}

        <fieldset className="space-y-4 rounded-md border border-border p-4">
          <legend className="px-2 text-sm font-medium">Apartment details</legend>

          <div className="grid items-start gap-4 sm:grid-cols-2 md:grid-cols-4">
            <label className="block">
              <span className="text-xs text-muted-foreground">Floor</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.floor}
                onChange={(e) => set({ floor: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Bedrooms</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.bedrooms}
                onChange={(e) => set({ bedrooms: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Bathrooms</span>
              <Input
                type="number"
                min={0}
                step="0.5"
                value={form.bathrooms}
                onChange={(e) => set({ bathrooms: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Floor area (sqft)
              </span>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.floorArea}
                onChange={(e) => set({ floorArea: e.target.value })}
              />
            </label>
          </div>

          <div className="block">
            <span className="text-xs text-muted-foreground">Amenities</span>
            <p className="text-[11px] text-muted-foreground/80 mb-1">
              Pick from your organization&apos;s catalog. Applies to every
              room in this apartment.
            </p>
            <AmenityCombobox
              value={form.amenities}
              onChange={(amenities) => set({ amenities })}
              catalog={amenitiesCatalog}
              disabled={amenitiesLoading}
            />
          </div>

          <div className="block">
            <span className="text-xs text-muted-foreground">Highlights</span>
            <p className="text-[11px] text-muted-foreground/80 mb-1">
              Free-form selling points — “Near KLCC”, “Corner unit”. Comma or
              Enter to add. Applies to every room in this apartment.
            </p>
            <TagInput
              values={form.highlights}
              onChange={(highlights) => set({ highlights })}
              placeholder="Near KLCC, Corner unit…"
            />
          </div>

          <label className="block">
            <span className="text-xs text-muted-foreground">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </label>
        </fieldset>

        {/* Owner — whole-unit assignment, fans out to every room server-side */}
        <div className="border-t border-border/40 pt-4 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Owner
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Owner of this whole unit — applies to every room. Drives management fee and owner statements.
          </p>
          {form.ownerPartyId ? (
            <OwnerConfirmCard
              ownerId={form.ownerPartyId}
              ownerName={form.ownerName}
              ownerPhone={form.ownerPhone}
              onChange={() => setForm((prev) => ({ ...prev, ownerPartyId: null, ownerName: "", ownerPhone: null }))}
            />
          ) : (
            <OwnerSelect
              value={form.ownerPartyId}
              displayName={form.ownerName}
              onSelect={(o) =>
                setForm((prev) => ({
                  ...prev,
                  ownerPartyId: o.id,
                  ownerName: o.displayName,
                  ownerPhone: o.formattedPhone ?? o.primaryPhone,
                }))
              }
              onClear={() => setForm((prev) => ({ ...prev, ownerPartyId: null, ownerName: "", ownerPhone: null }))}
            />
          )}
        </div>

        {/* Carpark bays — apartment-scoped, self-contained section */}
        <CarparksSection apartmentId={apartment.id} propertyId={propertyId} />

        <div className="border-t border-border/40 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Listing mode
              </div>
              <div className="text-sm font-semibold">{currentModeLabel}</div>
            </div>
            <div className="flex items-center gap-2">
              {apartment.listingMode === "WHOLE" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFlipOpen("PARTITIONED")}
                >
                  Switch to partitioned…
                </Button>
              )}
              {apartment.listingMode === "PARTITIONED" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFlipOpen("WHOLE")}
                >
                  Switch to whole unit…
                </Button>
              )}
              {apartment.listingMode === "MIXED" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setFlipOpen("WHOLE")}
                  >
                    Resolve to whole…
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setFlipOpen("PARTITIONED")}
                  >
                    Resolve to partitioned…
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Partition billing mode — only shown when PARTITIONED */}
        {apartment.listingMode === "PARTITIONED" && (
          <div className="border-t border-border/40 pt-4 space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                Billing model
              </div>
              <Segmented<PartitionBillingMode>
                value={form.partitionBillingMode ?? "NO_SUBSIDY"}
                onChange={(v) => set({ partitionBillingMode: v })}
                ariaLabel="Partition billing model"
                options={[
                  { value: "NO_SUBSIDY", label: "No subsidy" },
                  { value: "SUBSIDY", label: "Subsidy" },
                ]}
              />
            </div>
            <Callout variant="info">
              A monthly TNB cap below takes priority for the unit&apos;s shared TNB
              remainder, even when the legacy billing model is NO_SUBSIDY. If the cap
              is blank, SUBSIDY uses the legacy organization-level per-pax policy;
              NO_SUBSIDY provides no owner subsidy.
            </Callout>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Monthly TNB owner subsidy cap (RM)
              </span>
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={form.tnbSubsidyCapMonthly}
                onChange={(event) =>
                  set({ tnbSubsidyCapMonthly: event.target.value })
                }
                placeholder="e.g. 200.00"
              />
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                Optional, per unit and per month. A value overrides the legacy billing
                mode for the shared TNB remainder. Blank follows that mode: SUBSIDY uses
                per-pax, while NO_SUBSIDY provides no subsidy. Applies after private-meter
                TNB charges are removed.
              </p>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button
            type="submit"
            variant="gold"
            disabled={mutation.isPending || changedFields.length === 0}
          >
            {mutation.isPending ? "Saving…" : "Save apartment"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </form>

      <ListingModeFlipDialog
        open={flipOpen != null}
        onOpenChange={(o) => !o && setFlipOpen(null)}
        apartmentId={apartment.id}
        currentMode={apartment.listingMode}
        targetMode={flipOpen ?? "PARTITIONED"}
        activeListings={apartment.rooms.map((r) => ({
          id: r.id,
          unitType: r.unitType,
          rentalRate: r.rentalRate,
        }))}
      />

      <ConfirmAlert
        open={confirmFields !== null}
        onCancel={() => setConfirmFields(null)}
        onConfirm={() => {
          setConfirmFields(null);
          mutation.mutate();
        }}
        title="Update apartment-level fields?"
        body={
          <span>
            You changed <strong>{confirmFields?.map((f) => FIELD_LABELS[f] ?? f).join(", ") ?? ""}</strong>. This
            will be saved to every room of this apartment
            {affectedRoomTypes ? (
              <>
                {" "}
                (<em>{affectedRoomTypes}</em>)
              </>
            ) : null}
            .
          </span>
        }
        confirmLabel="Update apartment"
      />
    </>
  );
}
