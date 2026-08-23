import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
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
import { ActionButton } from "@/components/form-ui";
import { Button } from "@/components/ui/button";
import {
  UnitFormBody,
  unitFormToApiPayload,
  type UnitFormState,
  type UnitFormErrors,
} from "./unit-form-fields";
import { validateOccupancy, type OccupancyFieldErrors } from "./occupancy-fields";
import {
  getApartmentsByProperty,
  updateApartmentShared,
  type ApartmentSummary,
} from "@/api/inventory-units-batch";
import { ListingModeFlipDialog } from "./listing-mode-flip-dialog";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { SingleUnitMediaPanel } from "./unit-media-step";
import { CollapsibleSection } from "./collapsible-section";
import { ArrowLeftRight } from "lucide-react";

/**
 * Server codes that name a control on this form. Mirrors the create dialog's
 * map so an apartment-shared 409 (owner/billing) or a per-unit 400 lands on
 * the offending field instead of a toast the admin must translate.
 */
const SERVER_CODE_TO_FIELD: Record<string, keyof UnitFormErrors> = {
  UNIT_HAS_NO_OWNER: "ownerPartyId",
  APARTMENT_OWNER_CONFLICT: "ownerPartyId",
  OCCUPANCY_RENT_REQUIRED: "monthlyRent",
  APARTMENT_BILLING_MODE_CONFLICT: "partitionBillingMode",
  APARTMENT_TNB_SUBSIDY_CAP_CONFLICT: "tnbSubsidyCapMonthly",
};

// Apartment-scoped delta detection — spec §"On submit, detect shared field
// changed" (2026-05-13 apartment-aggregation-and-highlights design).
// Returns the list of apartment-scoped fields that changed between the
// dialog's initial snapshot and the current form state. Empty list ⇒ no
// fan-out needed; non-empty ⇒ confirmation prompt + applyToExistingSiblings.
//
// Comparison rules (from the spec):
//   - Scalars (bedrooms/bathrooms/floor/floorArea): strict equality after
//     coercing empty-string ↔ null. "" ↔ null is NOT a change.
//   - description: trim both sides; null ↔ "" after trim is NOT a change.
//   - amenities, highlights: set semantics — sort then compare. Reorder is
//     NOT a change. Add/remove IS.
export function apartmentScopedChangedFields(
  initial: UnitFormState,
  current: UnitFormState,
): string[] {
  const changed: string[] = [];
  const scalarFields: Array<keyof UnitFormState> = [
    "bedrooms",
    "bathrooms",
    "floor",
    "floorArea",
  ];
  for (const f of scalarFields) {
    const a = initial[f] === "" ? null : initial[f];
    const b = current[f] === "" ? null : current[f];
    if (a !== b) changed.push(f);
  }
  if ((initial.description ?? "").trim() !== (current.description ?? "").trim()) {
    changed.push("description");
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

// Minimal row data the trigger surface (units-table, unit-detail header) is
// guaranteed to have. Keeping this small means upstream callers don't have to
// fetch the full Unit before opening the dialog — we hydrate inside.
export type UnitRowData = {
  id: string;
  propertyName: string;
  unitCode: string;
  // The fields below are kept for backwards compat with existing call sites
  // (units-table, unit-detail-page) but we no longer rely on them — the
  // dialog refetches the full unit detail on open.
  unitType?: string;
  occupancyStatus?: string;
  listingStatus?: string;
  rentalRate?: number | null;
};

// The shape of GET /inventory/units/:id we depend on. Mirrors `UnitDetail` on
// the API side. We keep a local copy (instead of importing from the API) to
// avoid leaking server types into the SPA bundle.
export type FetchedUnitDetail = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floor?: number | null;
  floorArea: number | null;
  rentalRate: number | null;
  currency: string;
  occupancyStatus: string;
  listingStatus: string;
  // The detail GET returns amenities as catalog rows ({id, name}); the form
  // state below stores just the IDs (string[]) so the PUT payload sends back
  // catalog UUIDs the API expects. detailToFormState unwraps to IDs.
  amenities: { id: string; name: string }[];
  // Per-apartment free-form selling points. Stored verbatim on the wire
  // (no catalog gate) and hydrated as a string[] into UnitFormState.highlights.
  highlights?: string[];
  description: string | null;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  hiddenFromAgentNames: string[];
  grantedPartyIds: string[];
  grantedAgentNames: string[];
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  inChargePartyId: string | null;
  inChargeName: string | null;
  sourcingAgentId: string | null;
  sourcingAgentName: string | null;
  property: {
    id: string;
    name: string;
    propertyCode: string;
    city: string | null;
    hasPaxDeduction: boolean;
    paxDeductionAmount: number | null;
  } | null;
  // Deposits + parking (inventory upload extension). All optional — older API
  // builds may omit these; the form treats null/undefined as "blank".
  depositMonths?: number | null;
  utilitiesDepositMonths?: number | null;
  accessCardDepositPerPcs?: number | null;
  accessCardQuantity?: number | null;
  parkingQuantity?: number | null;
  parkingNumbers?: string[];
  // Per-listing media. Already returned by GET /inventory/units/:id
  // (inventory.repository.ts findUnitDetail); optional here for older-API
  // tolerance, matching the deposits/parking fields above. Surfaced so the
  // inline edit media panel seeds from existing media instead of hiding it.
  photoKeys?: string[];
  videoKeys?: string[];
  // Owner assignment (Task 5). Returned by GET /inventory/units/:id when an
  // owner is assigned. null means no owner yet; undefined means older API.
  ownerPartyId?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  tnbSubsidyCapMonthly?: number | null;
  // Active tenancy stub for prefill when reopening an Occupied unit.
  // null means no active tenancy; undefined means older API (treat as null).
  activeTenancy?: {
    id: string;
    tenantPartyId: string;
    tenantName: string;
    tenantIdType: string | null;
    tenantIdNumberMasked: string | null;
    tenantPhone: string | null;
    startDate: string;
    endDate: string | null;
    firstMonthIsCommission?: boolean;
    commissionSstBearer?: "owner" | "kaen";
    // The tenancy's negotiated monthly rent (RM). Optional for older-API
    // tolerance; when present it is the authoritative prefill for the rent
    // field (the unit's rentalRate is only the asking-rate fallback).
    monthlyRentAmount?: number;
  } | null;
};

export function detailToFormState(u: FetchedUnitDetail): UnitFormState {
  // Contract guard: if the server returns ownerPartyId without ownerName the
  // confirm card can't render the owner's name — warn in dev so the backend
  // team knows they need to join the owner name on the detail endpoint.
  if (import.meta.env.DEV && u.ownerPartyId && !u.ownerName) {
    console.warn(`[inventory] unit ${u.id} has ownerPartyId but no ownerName`);
  }
  return {
    unitCode: u.unitCode,
    unitType: u.unitType,
    // `null` = let UnitFormBody infer the step-1 mode from the saved type's
    // RoomTypeOption.kind; the operator is never forced to re-pick on Edit.
    unitMode: null,
    bedrooms: u.bedrooms != null ? String(u.bedrooms) : "",
    bathrooms: u.bathrooms != null ? String(u.bathrooms) : "",
    floor: u.floor != null ? String(u.floor) : "",
    floorArea: u.floorArea != null ? String(u.floorArea) : "",
    rentalRate: u.rentalRate != null ? String(u.rentalRate) : "",
    occupancyStatus: u.occupancyStatus || "vacant",
    listingStatus: u.listingStatus || "draft",
    inChargePartyId: u.inChargePartyId,
    inChargeName: u.inChargeName ?? "",
    sourcingAgentId: u.sourcingAgentId,
    sourcingAgentName: u.sourcingAgentName ?? "",
    sourceFlag: u.sourceFlag,
    visibilityMode: u.visibilityMode,
    hiddenFromPartyIds: u.hiddenFromPartyIds,
    hiddenFromPartyNames: u.hiddenFromAgentNames,
    grantedPartyIds: u.grantedPartyIds ?? [],
    grantedPartyNames: u.grantedAgentNames ?? [],
    amenities: (u.amenities ?? []).map((a) => a.id),
    highlights: u.highlights ?? [],
    description: u.description ?? "",
    hasPaxDeduction: u.property?.hasPaxDeduction ?? false,
    paxDeductionAmount:
      u.property?.paxDeductionAmount != null ? String(u.property.paxDeductionAmount) : "",
    depositMonths: u.depositMonths != null ? String(u.depositMonths) : "",
    utilitiesDepositMonths:
      u.utilitiesDepositMonths != null ? String(u.utilitiesDepositMonths) : "",
    accessCardDepositPerPcs:
      u.accessCardDepositPerPcs != null ? String(u.accessCardDepositPerPcs) : "",
    accessCardQuantity:
      u.accessCardQuantity != null ? String(u.accessCardQuantity) : "",
    parkingQuantity: u.parkingQuantity != null ? String(u.parkingQuantity) : "",
    parkingNumbers: u.parkingNumbers ?? [],
    // Standalone Carpark rates are managed by CarparksSection. The legacy
    // listing payload has labels only, so no rate can be hydrated here.
    parkingMonthlyRates: [],
    ownerPartyId: u.ownerPartyId ?? null,
    ownerName: u.ownerName ?? "",
    ownerPhone: u.ownerPhone ?? null,
    // Apartment-scoped; the unit detail GET does not carry it. Seeded blank
    // here ("" = untouched) and overwritten from the matched apartment in
    // EditUnitForm, so "dirty" is measured against the apartment's real mode.
    partitionBillingMode: "",
    tnbSubsidyCapMonthly:
      u.tnbSubsidyCapMonthly == null ? "" : String(u.tnbSubsidyCapMonthly),
    // Placeholder — the EditUnitForm initializer overrides this from the
    // matched apartment (the unit detail GET does not carry underManagement).
    underManagement: true,
    tenantPartyId: u.activeTenancy?.tenantPartyId ?? null,
    tenantName: u.activeTenancy?.tenantName ?? "",
    tenantIdType: u.activeTenancy?.tenantIdType ?? null,
    tenantIdNumberMasked: u.activeTenancy?.tenantIdNumberMasked ?? null,
    tenantPhone: u.activeTenancy?.tenantPhone ?? null,
    moveInDate: u.activeTenancy?.startDate ?? "",
    moveOutDate: u.activeTenancy?.endDate ?? "",
    // Prefer the ACTIVE TENANCY's negotiated rent so a reopened occupied unit
    // shows what the poster actually bills (e.g. a negotiated RM1,500), not the
    // unit's asking rentalRate (RM2,200) -- the original wrong-rent display bug.
    // The rentalRate is only the fallback: no active tenancy (create/vacant), or
    // an older API that omits the tenancy rent. Still editable, not authoritative;
    // see occupancy-fields.tsx / syncOccupancyTenancy for the no-silent-default
    // rule this prefill feeds on the create path.
    monthlyRent:
      u.activeTenancy?.monthlyRentAmount != null
        ? String(u.activeTenancy.monthlyRentAmount)
        : u.rentalRate != null
          ? String(u.rentalRate)
          : "",
    tenancyAgreementFeeAmount: "",
    tenancyAgreementFeeDueDate: "",
    // Seed from the stored tenancy so a save doesn't wipe a stored `true`.
    firstMonthIsCommission: u.activeTenancy?.firstMonthIsCommission ?? false,
    commissionSstBearer: u.activeTenancy?.commissionSstBearer ?? "owner",
  };
}

// Form lives in its own component so it mounts/unmounts with DialogContent.
// `useState`'s lazy initializer pulls the detail snapshot exactly once per
// open — never via a `useEffect([data])` derived-state pattern, which silently
// fails to re-fire when react-query's structural sharing returns the previous
// data reference (e.g. after a no-op save). That failure mode let the form
// open blank and submit blanks back to the server, wiping fields. See
// tasks/lessons.md (2026-04-27).
export function EditUnitForm({
  detail,
  unitId,
  propertyName,
  apartment = null,
  initialIntent,
  onClose,
  onSaved,
  trailingSlot = null,
}: {
  detail: FetchedUnitDetail;
  unitId: string;
  propertyName: string;
  // The apartment this room belongs to (matched by unit code). Null in the
  // degraded case where the apartments lookup failed / found no match — owner
  // + billing model + listing mode are apartment-scoped, so they are only
  // editable when it is present. Optional so pre-existing per-unit tests that
  // render this form directly keep their old (per-unit-only) behaviour.
  apartment?: ApartmentSummary | null;
  /** Shortcut intent. Add Tenant starts the unsaved form in Occupied mode so
   *  the tenancy fields are immediately visible; Cancel still changes nothing. */
  initialIntent?: "addTenant";
  onClose: () => void;
  // Optional post-save hook. When the multi-room EditApartmentShell mounts this
  // form per room-tab, it passes onSaved so a successful save does NOT close the
  // whole apartment dialog (the shell stays open so the admin can edit the next
  // room). When omitted (the single-unit EditUnitDialog), a save calls onClose
  // exactly as before — behaviour-preserving. Cancel always calls onClose.
  onSaved?: () => void;
  // Apartment-scoped sections (archived rooms, carparks) that must render BELOW
  // the room fields but ABOVE the sticky save bar, INSIDE this <form>.
  //
  // Why inside: the save bar is `position: sticky`, and a sticky box only stays
  // pinned while its CONTAINING BLOCK is in view — here, this <form>. When
  // EditApartmentShell rendered those sections as siblings AFTER the form, the
  // form's bottom edge passed the scrollport before the content ran out, so the
  // bar un-pinned and stranded mid-dialog with the Carparks row beneath it (it
  // read as a stray divider, not a footer). Hosting them inside the form
  // extends the containing block to the end of the scrollable content, so the
  // bar stays pinned to the dialog's bottom edge the whole way down and nothing
  // ever renders below it.
  //
  // Safe to nest: carparks-section.tsx / ArchivedRoomsSection use type="button"
  // on every control and contain no <form>, so neither submits this one nor
  // nests a form. Omitted by the single-unit EditUnitDialog, where the form is
  // already the last element and the bar pinned correctly — that path is
  // untouched. Regression: e2e/tests/edit-apartment-sticky-save-bar.e2e.ts.
  trailingSlot?: ReactNode;
}) {
  const [form, setForm] = useState<UnitFormState>(() => {
    const detailBase = detailToFormState(detail);
    const base = initialIntent === "addTenant"
      ? { ...detailBase, occupancyStatus: "occupied" }
      : detailBase;
    if (!apartment) return base;
    // Owner + billing model are authoritative on the APARTMENT row, not the
    // listing. Seed them from it so the controls show the apartment's current
    // values and "dirty" is measured against the apartment, not the listing's
    // fanned-out copy.
    return {
      ...base,
      partitionBillingMode: apartment.partitionBillingMode ?? "",
      tnbSubsidyCapMonthly:
        apartment.tnbSubsidyCapMonthly == null
          ? ""
          : String(apartment.tnbSubsidyCapMonthly),
      ownerPartyId: apartment.ownerPartyId,
      ownerName: apartment.ownerName ?? base.ownerName,
      ownerPhone: apartment.ownerPhone,
      // DIRECT — no `?? true`. ApartmentSummary.underManagement is required,
      // so this is always a real boolean from the server.
      underManagement: apartment.underManagement,
    };
  });
  const [errors, setErrors] = useState<UnitFormErrors>({});
  const queryClient = useQueryClient();
  // Snapshot of the dialog's initial state — the baseline for apartment-scoped
  // field changes (fan-out) AND for owner / billing dirtiness (routing).
  // Captured via useRef so a re-render from setForm doesn't drift it.
  const initialForm = useRef<UnitFormState>(form);
  // null = no prompt. "owner" = R6 blast-radius confirm; "siblings" = the
  // existing shared-field fan-out confirm.
  const [confirm, setConfirm] = useState<"owner" | "siblings" | null>(null);
  // Listing-mode flip target — opens the existing structural flip dialog,
  // which carries its own R6a confirmation and issues POST /:id/flip-mode.
  const [flipOpen, setFlipOpen] = useState<"WHOLE" | "PARTITIONED" | null>(null);

  const apartmentChanged = useMemo(
    // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
    () => apartmentScopedChangedFields(initialForm.current, form),
    [form],
  );

  function validate(state: UnitFormState): OccupancyFieldErrors {
    // Mirrors the server's syncOccupancyTenancy rule: under
    // ENABLE_PHASE2_RESERVATION_GATED_TENANCY, an explicit monthlyRent > 0
    // is required for a NEW tenancy materialised here -- no silent
    // inheritance of the unit's rentalRate (that silent default produced
    // the original wrong-rent incident). Flag off: server still defaults to
    // rentalRate, so no client-side requirement either.
    //
    // EXCEPT a same-tenant in-place edit: the server takes occupancy-sync case-2,
    // which NEVER writes rent, so requiring rent > 0 here would soft-lock every
    // save (e.g. a photo-only edit) for a legacy 0-rent tenancy -- with no way to
    // clear it, since the rent field is read-only on that path. Rent is required
    // only when a NEW tenancy will be materialised (change-tenant / create).
    const sameTenant =
      !!initialForm.current.tenantPartyId &&
      state.tenantPartyId === initialForm.current.tenantPartyId;
    const flagOn = isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY");
    return validateOccupancy(state, {
      rentRule: flagOn && !sameTenant ? "explicit" : "none",
    });
  }

  const ownerDirty =
    // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
    !!apartment && form.ownerPartyId !== initialForm.current.ownerPartyId;
  const billingDirty =
    !!apartment &&
    // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
    form.partitionBillingMode !== initialForm.current.partitionBillingMode &&
    form.partitionBillingMode !== "";
  const tnbSubsidyCapDirty =
    !!apartment &&
    // eslint-disable-next-line react-hooks/refs -- dirty-check baseline, same as billingDirty
    form.tnbSubsidyCapMonthly !== initialForm.current.tnbSubsidyCapMonthly;
  const underManagementDirty =
    // intentional: initialForm is the dirty-check baseline ref for EditUnitForm (same
    // pattern as ownerDirty/billingDirty above). It must stay a ref — lifting it to state
    // is a money-critical no-go (R5 owner/billing routing + R6 confirm). Reading .current
    // here only computes a dirty flag; it does not gate rendering.
    // eslint-disable-next-line react-hooks/refs
    !!apartment && form.underManagement !== initialForm.current.underManagement;

  // Open-time tenancy rent — the baseline UnitFormBody restores when the initial
  // tenant is RE-PICKED after "Change tenant" (onSelectTenant), so the read-only
  // field shows the tenancy's real rent, not the asking-rate reset. Derived from
  // the detail PROP (render-safe, no ref read) and mirrors detailToFormState's
  // same-tenant prefill. undefined when the unit opened vacant (no initial tenant
  // to re-pick), so the restore branch never fires there.
  const initialMonthlyRent =
    detail.activeTenancy?.monthlyRentAmount != null
      ? String(detail.activeTenancy.monthlyRentAmount)
      : undefined;

  const mutation = useMutation({
    mutationFn: async (opts: { applyToExistingSiblings: boolean }) => {
      // R5 routing. Apartment-scoped owner + billing model go to the dedicated
      // apartment endpoint FIRST. If it throws, the per-unit PUT never fires
      // (abort-on-first-failure) — the awaited call rejects out of here.
      if (
        apartment &&
        (ownerDirty || billingDirty || tnbSubsidyCapDirty || underManagementDirty)
      ) {
        const patch: {
          partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY";
          tnbSubsidyCapMonthly?: number | null;
          ownerPartyId?: string | null;
          underManagement?: boolean;
        } = {};
        if (billingDirty && form.partitionBillingMode) {
          patch.partitionBillingMode = form.partitionBillingMode as
            | "SUBSIDY"
            | "NO_SUBSIDY";
        }
        if (tnbSubsidyCapDirty) {
          patch.tnbSubsidyCapMonthly =
            form.tnbSubsidyCapMonthly.trim() === ""
              ? null
              : Number(form.tnbSubsidyCapMonthly);
        }
        if (ownerDirty) patch.ownerPartyId = form.ownerPartyId;
        if (underManagementDirty) patch.underManagement = form.underManagement;
        await updateApartmentShared(apartment.id, patch);
        // The apartment scope COMMITTED. Re-baseline the owner/billing fields so
        // that if the per-unit PUT below fails, a retry does NOT re-fire this
        // PATCH (which would duplicate the audit + re-materialise the ledgers a
        // second time) and the R6 owner confirm does NOT reappear (implying a
        // rollback that never happened). Only owner/billing are re-baselined —
        // the apartmentChanged fan-out fields ride the per-unit PUT, so they
        // stay dirty until that call succeeds.
        initialForm.current = {
          ...initialForm.current,
          ownerPartyId: form.ownerPartyId,
          ownerName: form.ownerName,
          ownerPhone: form.ownerPhone,
          partitionBillingMode: form.partitionBillingMode,
          tnbSubsidyCapMonthly: form.tnbSubsidyCapMonthly,
          underManagement: form.underManagement,
        };
        // The by-property apartments cache (EditUnitDialog, staleTime 30s) now
        // lags this committed PATCH — it still holds the pre-PATCH owner/billing.
        // If the per-unit PUT below fails, onSuccess never runs to refresh it, so
        // a close+reopen within the staleTime would re-seed the STALE owner and a
        // re-do would fire a DUPLICATE PATCH (extra audit row + a second ledger
        // re-materialisation). Invalidate here — the reopen-path twin of the
        // in-place re-baseline above. Prefix key matches every propertyId.
        queryClient.invalidateQueries({
          queryKey: ["inventory", "apartments-by-property"],
        });
      }
      // R5.4 — the per-unit body NEVER carries ownerPartyId: NO opts here, so
      // unitFormToApiPayload omits it (and billing model). This is the G5 pin.
      const body: Record<string, unknown> = unitFormToApiPayload(form);
      if (opts.applyToExistingSiblings) body.applyToExistingSiblings = true;
      return apiFetch<{ id?: string; warnings?: string[] }>(
        `/inventory/units/${unitId}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: async (response) => {
      // Await the dialog's own refetch so the next open sees fresh server
      // state — closes the rapid-reopen race where cache lags the save.
      await queryClient.invalidateQueries({
        queryKey: ["inventory", "unit", unitId, "edit-form"],
      });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      if (response?.warnings && response.warnings.length > 0) {
        toast.warning(response.warnings.join(" "));
      } else {
        toast.success("Unit updated.");
      }
      // Multi-room shell passes onSaved to stay open on the current room; the
      // single-unit dialog passes only onClose and closes as before.
      (onSaved ?? onClose)();
    },
    onError: (err: Error) => {
      if (err instanceof ApiError) {
        if (err.code === "LISTING_MODE_MISMATCH") {
          const data = err.data as { currentMode?: string; attemptedKind?: string } | null;
          const current = data?.currentMode === "PARTITIONED" ? "Partitioned" : "Whole";
          const attempted = data?.attemptedKind === "WHOLE" ? "Whole" : "Partitioned";
          toast.error(
            `This room is currently ${current}. The unit type you picked is a ${attempted} type — switch the apartment's Listing mode below first, then change the unit type.`,
            { duration: 8000 },
          );
          return;
        }
        // R10 — surface owner/billing conflicts on the offending control.
        const field = err.code ? SERVER_CODE_TO_FIELD[err.code] : undefined;
        if (field) {
          setErrors((prev) => ({ ...prev, [field]: err.message }));
          return;
        }
      }
      toast.error(err.message || "Failed to update unit.");
    },
  });

  // Staged submit: owner confirm (R6) → shared-field fan-out confirm → run.
  // Each stage re-enters with the prior confirmation recorded, so a save that
  // touches both only fires the request once both are accepted.
  function runSubmit(stage: { ownerConfirmed: boolean; applyToExistingSiblings: boolean }) {
    if (ownerDirty && !stage.ownerConfirmed) {
      setConfirm("owner");
      return;
    }
    if (apartmentChanged.length > 0 && !stage.applyToExistingSiblings) {
      setConfirm("siblings");
      return;
    }
    setConfirm(null);
    mutation.mutate({ applyToExistingSiblings: stage.applyToExistingSiblings });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.unitCode.trim()) {
      toast.error("Unit code is required.");
      return;
    }
    // Mirror the create dialog's unitType pre-check. The two-step picker clears
    // unitType in ONE click (switching Whole↔Partition drops an off-mode
    // selection), so an empty type is a click away on Edit too. Block HERE —
    // before runSubmit — otherwise a save that also re-points the owner would
    // COMMIT the apartment-shared PATCH first and only THEN 400 on the per-unit
    // PUT's Zod `unitType: min(1)`, leaving a destructive partial write.
    if (!form.unitType) {
      toast.error("Pick a unit type.");
      return;
    }
    if (
      form.tnbSubsidyCapMonthly.trim() !== "" &&
      (!/^\d+(\.\d{1,2})?$/.test(form.tnbSubsidyCapMonthly.trim()) ||
        Number(form.tnbSubsidyCapMonthly) > 9_999_999_999.99)
    ) {
      setErrors((prev) => ({
        ...prev,
        tnbSubsidyCapMonthly:
          "Enter a nonnegative RM amount with no more than 2 decimal places.",
      }));
      return;
    }
    // FIX WAVE 2 — the partial-commit SIBLING the empty-type guard above did not
    // close. The two-step picker lets an Edit switch step-1 mode and pick an
    // ACTIVE off-apartment-mode type (e.g. a Partition type while the apartment's
    // listing mode is Whole). unitType is then NON-empty, so the guard above
    // passes — but unitFormToApiPayload always emits unitType, so the per-unit
    // PUT reaches the server and 400s on its kind-mismatch guard
    // (LISTING_MODE_MISMATCH), and only AFTER the apartment-shared PATCH has
    // already COMMITTED the owner re-point (ledgers re-materialised): the exact
    // destructive partial write the empty-type guard prevents. Changing a room's
    // mode against the apartment is a STRUCTURAL flip (the Listing-mode flip
    // dialog / flip-mode endpoint), never a per-unit type write. Pre-check the
    // same rule the server enforces — apartment.listingMode is the client mirror
    // of the server's sibling-derived getUnitGroupMode (identical derivation,
    // inventory.service.ts) — and block BEFORE runSubmit so no request is issued.
    // Only fires on a definite (non-MIXED, non-null) apartment mode the operator
    // explicitly contradicted via the picker (form.unitMode set); an untouched
    // owner-only edit leaves form.unitMode null and is never blocked.
    if (
      apartment &&
      form.unitMode &&
      (apartment.listingMode === "WHOLE" || apartment.listingMode === "PARTITIONED") &&
      form.unitMode !== apartment.listingMode
    ) {
      const current = apartment.listingMode === "WHOLE" ? "Whole" : "Partitioned";
      toast.error(
        `This apartment is listed as ${current}. Switch its Listing mode first, then change the unit type.`,
      );
      return;
    }
    // FIX WAVE 3 — two more partial-commit siblings of the SAME hazard class the
    // empty-type + mode-conflict guards close: a per-unit PUT that hard-fails on
    // the server, but only AFTER the apartment-shared PATCH has already COMMITTED
    // the owner re-point (ledgers re-materialised). Both are pre-checkable from
    // state the dialog already holds; block BEFORE runSubmit so no request fires.
    //
    // (a) unitCode is owned by the parent Apartment. updateUnitService hard-400s
    // ANY change to it via this endpoint (inventory.service.ts: "unitCode is
    // owned by the parent Apartment…"), yet the Unit code TextInput is editable
    // in the shared form body. detail.unitCode is the saved value, so an
    // untouched code compares equal and never blocks — only a real edit does.
    if (form.unitCode.trim() !== detail.unitCode) {
      toast.error(
        `Unit code belongs to the apartment and can't be changed here. Reset it to ${detail.unitCode} before saving.`,
      );
      return;
    }
    // (b) changing this room's type to one a SIBLING listing already uses 409s on
    // the server's (apartmentId, listingType) conflict check
    // (findListingTypeConflict, exclude-self on unitId). Because the duplicate is
    // the SAME kind, neither the empty-type nor the mode-conflict guard fires.
    // apartment.rooms carries every sibling's id + unitType (by-property wire
    // shape), so mirror the server's exclude-self check exactly. Gated on an
    // actual type change so drift data (two siblings already sharing a type)
    // can't false-block an owner-only edit.
    if (
      apartment &&
      form.unitType !== detail.unitType &&
      apartment.rooms.some((r) => r.id !== unitId && r.unitType === form.unitType)
    ) {
      toast.error(
        "Another room in this apartment already uses that unit type. Pick a different type.",
      );
      return;
    }
    const occErrors: UnitFormErrors = validate(form);
    // Occupied ⇒ owner required. When the owner is editable (apartment present)
    // and the admin cleared it, block HERE — before runSubmit. Otherwise the
    // apartment-shared PATCH would COMMIT an apartment-wide owner wipe first and
    // only THEN would the per-unit PUT 409 on UNIT_HAS_NO_OWNER, leaving a
    // destructive partial write. Mirrors the create dialog's pre-check.
    if (apartment && form.occupancyStatus === "occupied" && !form.ownerPartyId) {
      occErrors.ownerPartyId = "Assign an owner before marking this unit occupied.";
    }
    // FIX WAVE 3 — the guard above only covers the EDITED room's own occupancy.
    // But the owner is apartment-scoped, so clearing it fans an owner WIPE across
    // every room: updateApartmentSharedService allows a null owner unconditionally
    // (no occupancy check), and the per-unit PUT can't backstop it — its
    // UNIT_HAS_NO_OWNER guard is occupied-only, so a vacant/reserved edited room
    // never 409s. A wipe while any room is occupied/reserved orphans that room's
    // ledger attribution and 409s its later reservation→tenancy conversion. So
    // when the owner is actually being CLEARED, block if the edited room is
    // occupied/reserved OR any sibling room is. (Complete enforcement belongs
    // server-side — deferred to the apartment-owner-model redesign spec; this is
    // the client-side defence-in-depth door the unified modal opened.)
    if (
      apartment &&
      ownerDirty &&
      !form.ownerPartyId &&
      !occErrors.ownerPartyId // don't stomp the occupied-room message above
    ) {
      const apartmentHasActiveRoom =
        form.occupancyStatus === "occupied" ||
        form.occupancyStatus === "reserved" ||
        apartment.rooms.some(
          (r) => r.occupancyStatus === "occupied" || r.occupancyStatus === "reserved",
        );
      if (apartmentHasActiveRoom) {
        occErrors.ownerPartyId =
          "This apartment has an occupied or reserved room. Assign an owner before clearing it.";
      }
    }
    setErrors(occErrors);
    if (Object.keys(occErrors).length > 0) return;
    runSubmit({ ownerConfirmed: false, applyToExistingSiblings: false });
  }

  const modeLabel =
    apartment?.listingMode === "WHOLE"
      ? "Whole"
      : apartment?.listingMode === "PARTITIONED"
        ? "Partitioned"
        : apartment?.listingMode === "MIXED"
          ? "Mixed — needs review"
          : "No active listing";

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-4">
        <UnitFormBody
          state={form}
          setState={setForm}
          showSectionNav
          showPropertySelect={false}
          showOwner
          ownerEditable={!!apartment}
          showBillingModel={!!apartment}
          showUnderManagement={!!apartment}
          propertyPlaceholderName={propertyName}
          // The active tenant captured at open time. Drives OccupancyFields'
          // same-tenant preview suppression (poster's case-2 in-place edit
          // ignores the form rent). Use the ref baseline, not `form`, so the
          // signal stays stable if the admin edits and reverts the tenant.
          // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
          initialTenantPartyId={initialForm.current.tenantPartyId}
          initialMonthlyRent={initialMonthlyRent}
          errors={errors}
        />

        <SingleUnitMediaPanel
          listingId={unitId}
          initialPhotoKeys={detail.photoKeys ?? []}
          initialVideoKeys={detail.videoKeys ?? []}
          onMediaChanged={(next) => {
            // C — keep the edit-form detail cache in sync so a later room-tab
            // remount (EditApartmentShell) re-seeds the panel from fresh
            // keys, not the stale pre-change snapshot (ghost tile).
            queryClient.setQueryData<{ data: FetchedUnitDetail }>(
              ["inventory", "unit", unitId, "edit-form"],
              (old) =>
                old
                  ? { ...old, data: { ...old.data, photoKeys: next.photoKeys, videoKeys: next.videoKeys } }
                  : old,
            );
            // D — refresh SP-1 inventory card counts even if the admin
            // closes without Save (media commits to the server independently
            // of the form save).
            queryClient.invalidateQueries({ queryKey: ["inventory"] });
          }}
        />

        {apartment && (
          <CollapsibleSection
            title="Listing mode"
            summary={modeLabel}
            icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
            defaultOpen={apartment.listingMode === "MIXED"}
          >
            <div className="flex flex-wrap items-center gap-2">
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
            <p className="text-xs text-muted-foreground/80">
              Whole vs Partition applies to the whole apartment. Switching parks
              off-mode listings (they stay in the database and return if you
              switch back) and may seed a fresh draft listing.
            </p>
          </CollapsibleSection>
        )}

        {/* Apartment-scoped sections, hosted inside the form so the sticky save
            bar below stays the LAST element and keeps its pin. See trailingSlot. */}
        {trailingSlot}

        {/* Sticky save bar — pinned to the dialog's bottom edge so a one-field
            edit no longer needs a scroll to the end. Stays opaque so scrolled
            fields don't show through. The submit button remains INSIDE this
            <form>, so every existing submit guard fires unchanged.

            Bleeding over DialogContent's p-6 uses TWO DIFFERENT levers, and the
            distinction is load-bearing:
              - horizontal: `-mx-6`, a negative MARGIN. Correct — the sticky
                axis is vertical, so a horizontal margin only affects flow.
              - vertical: `-bottom-6`, the sticky OFFSET. A negative bottom
                margin is WRONG here and was the original bug: a sticky box's
                pinned position resolves against its MARGIN box, so
                `bottom-0 -mb-6` pinned the bar's margin edge to the scrollport
                bottom and left its VISIBLE edge 24px high — an empty
                translucent strip that scrolling fields bled through. The same
                `-mb-6` also dragged the next sibling up under this bar's opaque
                z-10 band: in EditApartmentShell the footer is NOT the last
                element (ArchivedRoomsSection + CarparksSection follow it), so
                the Carparks row was sliced in half.
            `-bottom-6` moves the pinned box without touching flow, which is the
            same lever 40046c3e used to kill the identical "space bar" at the
            modal's TOP edge. Regression:
            e2e/tests/edit-apartment-sticky-save-bar.e2e.ts. */}
        <DialogFooter className="sticky -bottom-6 z-10 -mx-6 border-t border-border/50 bg-background/95 px-6 py-4 backdrop-blur-xl">
          <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Updating…" : "Update unit"}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </ActionButton>
        </DialogFooter>
      </form>

      {apartment && (
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
      )}

      <ConfirmAlert
        open={confirm === "owner"}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          runSubmit({ ownerConfirmed: true, applyToExistingSiblings: false })
        }
        title="Re-point this apartment's owner?"
        body={
          <span>
            Changing the owner re-points <strong>every room in this apartment</strong>{" "}
            and <strong>every active carpark bay</strong> to{" "}
            <strong>{form.ownerName || "the new owner"}</strong>, and re-materialises
            both the previous and the new owner&apos;s ledgers. This applies
            immediately.
          </span>
        }
        confirmLabel="Re-point owner"
      />

      <ConfirmAlert
        open={confirm === "siblings"}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          runSubmit({ ownerConfirmed: true, applyToExistingSiblings: true })
        }
        title="Update apartment-level fields?"
        body={
          <span>
            You changed <strong>{apartmentChanged.join(", ")}</strong>. These fields
            apply to the whole apartment, so the change will also be saved to every
            other room in this apartment that shares the same unit code.
          </span>
        }
        confirmLabel="Update apartment + this room"
      />
    </>
  );
}

export function EditUnitDialog({
  trigger,
  unit,
}: {
  trigger: ReactNode;
  unit: UnitRowData;
}) {
  const [open, setOpen] = useState(false);

  // Fetch full detail when the dialog opens — guarantees every field is
  // hydrated, including ones the trigger row doesn't carry (bedrooms,
  // bathrooms, amenities, description, in-charge agent, etc.).
  // refetchOnWindowFocus: false prevents a focus event from refetching mid-
  // edit and stomping the user's draft via the form's mounted instance.
  const detailQuery = useQuery({
    queryKey: ["inventory", "unit", unit.id, "edit-form"],
    queryFn: () => apiFetch<{ data: FetchedUnitDetail }>(`/inventory/units/${unit.id}`),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const detail = detailQuery.data?.data;
  const propertyName = detail?.property?.name ?? unit.propertyName;
  const propertyId = detail?.property?.id;

  // Apartment context for the unified modal. The unit detail GET does not
  // carry apartmentId / listingMode / partitionBillingMode, so — web-only,
  // no backend change — we reuse the by-property list and match on unit code.
  // Owner + billing model + listing mode route through this apartment on save.
  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments-by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId as string),
    enabled: open && !!propertyId,
    staleTime: 30_000,
  });

  const matchedApartment = useMemo(() => {
    if (!detail) return null;
    const code = detail.unitCode.trim().toLowerCase();
    return (
      (apartmentsQuery.data ?? []).find(
        (a) => a.unitCode.trim().toLowerCase() === code,
      ) ?? null
    );
  }, [apartmentsQuery.data, detail]);

  // Only mount the form once BOTH the detail and the apartment lookup have
  // settled — the form seeds owner/billing from the apartment in its lazy
  // initializer, so mounting early would seed against stale/absent context.
  // No property on the detail (edge) ⇒ nothing to look up, mount immediately.
  const apartmentsReady = !detail
    ? false
    : !propertyId
      ? true
      : apartmentsQuery.isFetched;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      {/* pt-0 (not p-6's top): the scroll container must have NO top padding,
          otherwise the sticky SectionNav below locks 24px BELOW the modal's top
          edge (top:0 pins to the content box, past the padding), leaving a
          translucent 24px band through which scrolled fields bleed — the "space
          bar". The header restores that breathing room with its own pt-6. */}
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto pt-0">
        <DialogHeader className="pt-6">
          <DialogTitle>
            Edit unit · {propertyName} · <span className="font-mono">{unit.unitCode}</span>
          </DialogTitle>
          <DialogDescription>
            Revise unit attributes, lifecycle state, and visibility. Changes save together.
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isError ? (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-400">
            Failed to load unit details. Close and reopen to retry.
          </div>
        ) : detailQuery.isLoading || !detail || !apartmentsReady ? (
          <div className="space-y-4 py-8">
            <div className="h-32 bg-muted/40 rounded-xl animate-pulse" />
            <div className="h-48 bg-muted/40 rounded-xl animate-pulse" />
            <div className="h-24 bg-muted/40 rounded-xl animate-pulse" />
          </div>
        ) : (
          <EditUnitForm
            detail={detail}
            unitId={unit.id}
            propertyName={propertyName}
            apartment={matchedApartment}
            onClose={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
