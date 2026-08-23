import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { ActionButton, Field, SelectInput, TextInput } from "@/components/form-ui";
import { getApartmentsByProperty } from "@/api/inventory-units-batch";
import type { PropertyListItem } from "@/pages/inventory/property-row";
import type { FirstMonthPreview, CommissionPreview } from "@kason/shared";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { FirstMonthPreviewCard } from "@/pages/tenancy/first-month-preview";
import { tenancyEndDate } from "@/pages/inventory/occupancy-fields";

// Server validation shape from formatZodError (apps/api/src/lib/zod-error-mapper.ts):
// { error: string, fieldErrors: Record<string,string> }. ApiError.data carries the
// raw parsed response body, so pull fieldErrors from there for inline per-field
// display. Duplicated locally (not exported by tenants-action-dialogs.tsx) —
// mirrors that file's shell pattern rather than importing a private helper.
function extractFieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.data && typeof err.data === "object") {
    const body = err.data as { fieldErrors?: Record<string, string> };
    return body.fieldErrors ?? {};
  }
  return {};
}

// Fallback for non-ApiError failures (network drops, thrown TypeErrors) that
// still carry a usable .message via the Error prototype — never crashes,
// never silently no-ops.
function genericMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

type PickableUnit = { unitId: string; apartmentUnitCode: string; unitType: string };

// One row of GET /tenancy/tenancies (listTenancies). Only the fields this
// dialog reads are declared; the endpoint returns more.
type TenancyListRow = {
  id: string;
  tenantPartyId: string;
  status: string;
  propertyName: string;
  unitCode: string;
  monthlyRentAmount: number;
  // Optional for older-API tolerance — an API that predates these being carried
  // on the list row degrades to "not shown", never to a false "No".
  firstMonthIsCommission?: boolean;
  commissionSstBearer?: "owner" | "kaen";
};

const money = (n: number) =>
  `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AssignTenantToUnitDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: { id: string; displayName: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const [propertyId, setPropertyId] = useState("");
  const [unitId, setUnitId] = useState("");
  // No tenancyCode state: the server mints TEN-{year}-NNNN inside the create
  // transaction, so admins never see or type one.
  const [monthlyRentAmount, setMonthlyRentAmount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Keep the party-page assignment flow financially equivalent to Create
  // Tenancy and the Inventory occupancy flow. A blank value means no TA fee
  // decision; an explicit "0" is deliberately sent so the billing grid can
  // surface an accidental RM0 for review.
  const [tenancyAgreementFeeAmount, setTenancyAgreementFeeAmount] = useState("");
  const [tenancyAgreementFeeDueDate, setTenancyAgreementFeeDueDate] = useState("");
  // No depositAmount field: deposits are derived from the unit's configured
  // depositMonths and posted as their own Rental Deposits document
  // (DEPRENT-/DEPUTIL- charges), so a free-text amount here was a second,
  // conflicting source of truth for the same number.
  // First-month KAEN commission (Phase 1, display-only preview). Gated on the
  // same reservation flag as the unit-editor's OccupancyFields so the two
  // commission surfaces appear/disappear together. Only sent on the POST when
  // checked; createTenancyService persists them (assertCommissionWritable gate:
  // admin/manager only, and locked once the tenancy has been invoiced).
  const [firstMonthIsCommission, setFirstMonthIsCommission] = useState(false);
  const [commissionSstBearer, setCommissionSstBearer] = useState<"owner" | "kaen">("owner");

  const [unitError, setUnitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [bannerError, setBannerError] = useState<string | null>(null);

  function resetAll() {
    setPropertyId("");
    setUnitId("");
    setMonthlyRentAmount("");
    setStartDate("");
    setEndDate("");
    setTenancyAgreementFeeAmount("");
    setTenancyAgreementFeeDueDate("");
    setFirstMonthIsCommission(false);
    setCommissionSstBearer("owner");
    setUnitError(null);
    setFieldErrors({});
    setBannerError(null);
  }

  function handleOpenChange(v: boolean) {
    if (!v) resetAll();
    onOpenChange(v);
  }

  const propertiesQuery = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: PropertyListItem[] }>("/inventory/properties"),
    enabled: open,
  });
  const properties = propertiesQuery.data?.data ?? [];

  // What this tenant is ALREADY assigned to. This dialog is a create-only form
  // whose resetAll() blanks the rent + commission on every close, so reopening it
  // to check a just-saved assignment used to show unticked/empty — indistinguish-
  // able from "it never saved". Read the stored tenancy and show it instead.
  // Same endpoint the Tenancies page uses; no new backend surface.
  const tenanciesQuery = useQuery({
    queryKey: ["tenancy", "tenancies"],
    queryFn: () => apiFetch<{ data: TenancyListRow[] }>("/tenancy/tenancies"),
    enabled: open,
  });
  // Array-guarded, not just `?? []`: this panel is a read-only convenience, so a
  // shape it doesn't recognise (older API, error payload) must degrade to "no
  // panel" — never throw and take the whole Assign dialog down with it.
  const tenancyRows = tenanciesQuery.data?.data;
  const existingTenancies = (Array.isArray(tenancyRows) ? tenancyRows : []).filter(
    (t) => t?.tenantPartyId === tenant.id && t?.status === "active",
  );

  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments-by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId),
    enabled: open && !!propertyId,
  });
  const apartments = apartmentsQuery.data ?? [];

  // Picker filter — vacant + owned. These are exactly the two conditions
  // createTenancyService itself enforces (UNIT_HAS_ACTIVE_TENANCY,
  // UNIT_HAS_NO_OWNER), so the picker can never hide a unit the server would
  // have accepted.
  //
  // `listingStatus` is deliberately NOT filtered. It gates MARKETPLACE
  // PUBLICATION — whether agents can see the listing — not tenantability:
  // `reactivateListing` restores to draft "so they can verify before agents
  // see it", and REQUIRED_FOR_PUBLISH is [bedrooms, bathrooms, rentalRate],
  // i.e. marketing readiness. Every room is born `draft`
  // (inventory.service.ts:958) with no way to create one already `active`, and
  // the tenancy module contains zero listingStatus references. Filtering on
  // `active` therefore made every never-published unit permanently
  // unassignable — the normal state right after creating one — which is what
  // produced the empty picker. Archived rooms are already excluded upstream:
  // the by-property endpoint splits them into `archivedRooms`.
  const pickableUnits: PickableUnit[] = apartments
    .filter((a) => a.ownerPartyId != null)
    .flatMap((a) =>
      a.rooms
        .filter((r) => r.occupancyStatus === "vacant")
        .map((r) => ({ unitId: r.id, apartmentUnitCode: a.unitCode, unitType: r.unitType })),
    );

  // First-month rent + commission preview. Hits the SAME endpoint/formula the
  // poster and the unit-editor use, so the RM shown here can never disagree with
  // what is billed. Fires only once the commission box is checked and rent +
  // start date are present; gated on the reservation flag (flag-dark in prod).
  const commissionFlagOn = isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY");
  const rentNum = Number(monthlyRentAmount);
  const previewEnabled =
    open &&
    commissionFlagOn &&
    firstMonthIsCommission &&
    !!startDate &&
    Number.isFinite(rentNum) &&
    rentNum > 0;
  const previewQuery = useQuery({
    queryKey: [
      "tenancy",
      "rent-preview",
      startDate,
      endDate,
      monthlyRentAmount,
      firstMonthIsCommission,
      commissionSstBearer,
    ],
    enabled: previewEnabled,
    staleTime: 30_000,
    queryFn: () => {
      const qs = new URLSearchParams({ monthlyRent: monthlyRentAmount, startDate });
      if (endDate) qs.set("endDate", endDate);
      qs.set("firstMonthIsCommission", "true");
      qs.set("commissionSstBearer", commissionSstBearer);
      return apiFetch<{ data: FirstMonthPreview; commission: CommissionPreview | null }>(
        `/tenancy/tenancies/rent-preview?${qs.toString()}`,
      );
    },
  });
  const preview = previewEnabled ? previewQuery.data?.data ?? null : null;
  const commission = previewEnabled ? previewQuery.data?.commission ?? null : null;

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/tenancy/tenancies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast.success("Tenant assigned to unit.");
      resetAll();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      // R3 — discriminate the createTenancyService 409s by the
      // PRESENCE/ABSENCE of err.code, never by parsing the message string.
      // CONCURRENT_ACTIVE_TENANCY is the P2002 unique-index race backstop
      // (apps/api/src/modules/tenancy/tenancy-p2002.ts) — a unit-state
      // conflict like the other two, so it routes to the unit picker too.
      if (err instanceof ApiError && err.status === 409) {
        if (
          err.code === "UNIT_HAS_NO_OWNER" ||
          err.code === "UNIT_HAS_ACTIVE_TENANCY" ||
          err.code === "CONCURRENT_ACTIVE_TENANCY"
        ) {
          setUnitError(err.message);
        } else {
          // Everything else — chiefly TENANCY_CODE_TAKEN, the unique-index
          // backstop on the generator's read-then-write. There is no code field
          // to annotate any more, and nothing for the admin to correct: the
          // banner tells them to retry, and the next attempt re-generates.
          setBannerError(err.message);
        }
        return;
      }
      setFieldErrors(extractFieldErrors(err));
      setBannerError(err instanceof ApiError && err.status === 403 ? err.message : genericMsg(err));
    },
  });

  function handlePropertyChange(id: string) {
    setPropertyId(id);
    // A stale unit picked under the previous property must never ride along
    // with a switched propertyId — that would POST a cross-property mismatch.
    setUnitId("");
    setUnitError(null);
  }

  function handleUnitChange(id: string) {
    setUnitId(id);
    setUnitError(null);
  }

  const canSubmit = !!unitId && !!monthlyRentAmount && !!startDate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Defense-in-depth: the submit button is already `disabled` while
    // `submit.isPending`, but guard the mutation itself too so a rapid
    // double-fire (e.g. two synchronous submit events before React re-renders
    // the disabled attribute) can never create two tenancies.
    if (!canSubmit || submit.isPending) return;
    setUnitError(null);
    setFieldErrors({});
    setBannerError(null);
    // Body sent must satisfy createTenancySchema. tenantPartyId is ALWAYS the
    // row's party — never editable. NEVER send reservationId/overwrite/carparks.
    // tenancyCode is deliberately absent: omitting it is what tells the server
    // to generate one (sending "" would be a hard schema error).
    const body: Record<string, unknown> = {
      propertyId,
      unitId,
      tenantPartyId: tenant.id,
      startDate,
      monthlyRentAmount,
    };
    if (endDate) body.endDate = endDate;
    if (tenancyAgreementFeeAmount !== "") {
      body.tenancyAgreementFeeAmount = tenancyAgreementFeeAmount;
      if (tenancyAgreementFeeDueDate) {
        body.tenancyAgreementFeeDueDate = tenancyAgreementFeeDueDate;
      }
    }
    // Only carry the commission fields when actually opted in — leaving them off
    // keeps the server on its default (firstMonthIsCommission=false, owner bears
    // SST) and avoids tripping assertCommissionWritable for a plain assignment.
    if (firstMonthIsCommission) {
      body.firstMonthIsCommission = true;
      body.commissionSstBearer = commissionSstBearer;
    }
    submit.mutate(body);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {tenant.displayName} to a unit</DialogTitle>
          <DialogDescription>
            Pick a vacant, owned unit and set the tenancy terms.
          </DialogDescription>
        </DialogHeader>

        {bannerError && (
          <Callout variant="danger" title="Couldn't assign to unit">
            {bannerError}
          </Callout>
        )}

        {existingTenancies.length > 0 && (
          <Callout
            variant="info"
            title={
              existingTenancies.length === 1
                ? "Already assigned to a unit"
                : `Already assigned to ${existingTenancies.length} units`
            }
          >
            <div data-testid="existing-tenancy-panel" className="space-y-2">
              {existingTenancies.map((t) => (
                <div key={t.id} className="text-sm">
                  <span className="font-medium">
                    {t.propertyName} · {t.unitCode}
                  </span>
                  <span className="mx-2 opacity-60">—</span>
                  <span>{money(t.monthlyRentAmount)}/month</span>
                  {t.firstMonthIsCommission !== undefined && (
                    <span className="mx-2 opacity-60">·</span>
                  )}
                  {t.firstMonthIsCommission !== undefined && (
                    <span>
                      KAEN commission:{" "}
                      <span className="font-medium">
                        {t.firstMonthIsCommission ? "Yes" : "No"}
                      </span>
                      {t.firstMonthIsCommission && t.commissionSstBearer
                        ? ` (${t.commissionSstBearer === "kaen" ? "KAEN absorbs SST" : "owner bears SST"})`
                        : ""}
                    </span>
                  )}
                </div>
              ))}
              <p className="text-xs opacity-80">
                These are the stored values. The form below creates an{" "}
                <em>additional</em> tenancy — to change the terms above, edit the
                unit in Inventory.
              </p>
            </div>
          </Callout>
        )}

        <form onSubmit={handleSubmit} className="grid gap-4">
          <Field label="Property">
            <SelectInput
              value={propertyId}
              onChange={(e) => handlePropertyChange(e.target.value)}
              disabled={propertiesQuery.isLoading}
            >
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          {propertiesQuery.isError && (
            <Callout variant="danger" title="Couldn't load properties">
              <span className="mr-2">Try again.</span>
              <ActionButton
                type="button"
                variant="secondary"
                onClick={() => propertiesQuery.refetch()}
              >
                Retry
              </ActionButton>
            </Callout>
          )}

          {propertyId &&
            (apartmentsQuery.isLoading ? (
              <p className="text-sm text-[var(--text-muted)]">Loading units…</p>
            ) : apartmentsQuery.isError ? (
              <Callout variant="danger" title="Couldn't load units for this property">
                <ActionButton
                  type="button"
                  variant="secondary"
                  onClick={() => apartmentsQuery.refetch()}
                >
                  Retry
                </ActionButton>
              </Callout>
            ) : pickableUnits.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No vacant, owned units in this property.
              </p>
            ) : (
              <Field label="Unit" error={unitError}>
                <SelectInput
                  value={unitId}
                  onChange={(e) => handleUnitChange(e.target.value)}
                >
                  <option value="">Select unit…</option>
                  {pickableUnits.map((u) => (
                    <option key={u.unitId} value={u.unitId}>
                      {u.apartmentUnitCode} — {u.unitType}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            ))}

          <Field label="Monthly rent" error={fieldErrors.monthlyRentAmount}>
            <TextInput
              type="number"
              min={0}
              step="0.01"
              value={monthlyRentAmount}
              onChange={(e) => setMonthlyRentAmount(e.target.value)}
            />
          </Field>
          <Field label="Start date" error={fieldErrors.startDate}>
            <TextInput
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="End date (optional)" error={fieldErrors.endDate}>
            <TextInput
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
          <Field
            label="TA (WITH SST) amount (RM)"
            hint="Enter the final SST-inclusive amount. Leave blank when no fee applies; use 0 for an explicit RM0 decision."
            error={fieldErrors.tenancyAgreementFeeAmount}
          >
            <TextInput
              type="number"
              min={0}
              step="0.01"
              value={tenancyAgreementFeeAmount}
              onChange={(e) => setTenancyAgreementFeeAmount(e.target.value)}
            />
          </Field>
          <Field
            label="Agreement fee due date"
            hint="Leave blank to use the tenancy start date."
            error={fieldErrors.tenancyAgreementFeeDueDate}
          >
            <TextInput
              type="date"
              value={tenancyAgreementFeeDueDate}
              onChange={(e) => setTenancyAgreementFeeDueDate(e.target.value)}
              disabled={tenancyAgreementFeeAmount === ""}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <span className="text-sm font-medium text-[var(--text-primary)]">Set tenancy:</span>
            {([1, 2] as const).map((years) => (
              <Button
                key={years}
                type="button"
                variant="outline"
                size="sm"
                disabled={!startDate}
                onClick={() => setEndDate(tenancyEndDate(startDate, years))}
              >
                {years} Year{years === 1 ? "" : "s"}
              </Button>
            ))}
            {!startDate && (
              <span className="text-xs text-[var(--text-muted)]">Choose the start date first.</span>
            )}
          </div>

          {commissionFlagOn && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={firstMonthIsCommission}
                  onChange={(e) => setFirstMonthIsCommission(e.target.checked)}
                />
                First month rent is KAEN&apos;s commission
              </label>
              {firstMonthIsCommission && (
                <label className="block text-xs text-[var(--text-muted)]">
                  SST bearer
                  <select
                    value={commissionSstBearer}
                    onChange={(e) =>
                      setCommissionSstBearer(e.target.value as "owner" | "kaen")
                    }
                    className="mt-1 block rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-sm text-[var(--text-primary)]"
                  >
                    <option value="owner">Owner bears SST</option>
                    <option value="kaen">KAEN absorbs SST</option>
                  </select>
                </label>
              )}
              {firstMonthIsCommission && (
                <FirstMonthPreviewCard
                  preview={preview}
                  commission={commission}
                  showNoCommissionNote
                />
              )}
            </div>
          )}

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={!canSubmit || submit.isPending}>
              {submit.isPending ? "Assigning…" : "Assign"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => handleOpenChange(false)}
              disabled={submit.isPending}
            >
              Cancel
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
