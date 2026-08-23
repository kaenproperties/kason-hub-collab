import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  ActionButton,
  FeedbackMessage,
  Field,
  FormCard,
  FormGrid,
  SelectInput,
  TextInput,
} from "@/components/form-ui";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { useAvailableCarparksByProperty } from "@/api/carparks";
import { getTenantLinkedReservation } from "@/api/reservations";

type PropertyOption = { id: string; name: string; propertyCode: string };
type UnitOption = { id: string; propertyId: string; propertyName: string; unitCode: string };
type TenantOption = {
  id: string;
  displayName: string;
  /** From GET /parties/tenants — flags that this tenant has a linked
   * reservation. Selecting a tagged tenant triggers an automatic lookup
   * (getTenantLinkedReservation); a settled, still-signed reservation
   * derives the tenancy terms automatically (see
   * ReservationGatedCreateTenancyCard) instead of surfacing a manual
   * reservation picker. */
  hasReservation?: boolean;
};
type TenancyOption = {
  id: string;
  tenancyCode: string;
  tenantName: string;
  propertyName?: string;
  unitCode?: string;
  endDate?: string | null;
  status?: string;
  renewalDecision?: "pending" | "contacted" | "renew" | "not_renew";
};
type ReservationOption = {
  id: string;
  referenceCode: string;
  unitId: string;
  status: string;
  agreedMonthlyRent: string | null;
  /** Only needed by the reservation-gated derive path (T11/R5) to render
   * startDate/endDate read-only; optional so pre-existing callers/fixtures
   * that predate this field still typecheck. */
  proposedMoveIn?: string;
  proposedMoveOut?: string | null;
};
type CarparkEntry = { carparkId: string; monthlyCharge?: string };
type IncumbentInfo = { tenantName: string; endDate: string | null };
// The two-path submit shape for ReservationGatedCreateTenancyCard (T11/R5):
// "convert" targets the reservation-scoped convert route; "manual" targets
// the plain tenancy create route. See that component below.
type SubmitRequest =
  | { kind: "convert"; reservationId: string; body: Record<string, unknown> }
  | { kind: "manual"; body: Record<string, unknown> };

type FeedbackState = { status: "idle" | "success" | "error"; message: string };

const idle: FeedbackState = { status: "idle", message: "" };

function getFormData(e: React.FormEvent<HTMLFormElement>): Record<string, string> {
  const fd = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

export function TenancyForms({
  properties,
  units,
  tenants,
  tenancies,
  reservations = [],
  initialReservationId = "",
}: {
  properties: PropertyOption[];
  units: UnitOption[];
  tenants: TenantOption[];
  tenancies: TenancyOption[];
  reservations?: ReservationOption[];
  initialReservationId?: string;
}) {
  const queryClient = useQueryClient();
  const reservationGatedTenancyEnabled = isPhase2FlagEnabled(
    "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
  );

  // ── Create Tenancy ────────────────────────────────────────────────────────
  const [createFeedback, setCreateFeedback] = useState<FeedbackState>(idle);
  const createTenancy = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/tenancy/tenancies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCreateFeedback({ status: "success", message: "Tenancy created." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
    },
    onError: (err: Error) => {
      setCreateFeedback({ status: "error", message: err.message });
    },
  });

  // "Start from reservation" prefill. The Unit select drives which reservations
  // are offerable (same unit, with a recorded agreed rent). Picking one sources
  // the monthly rent from the reservation (read-only) and passes reservationId
  // so the backend uses the reservation's agreedMonthlyRent verbatim.
  const reservationsWithRent = reservations.filter((r) => r.agreedMonthlyRent != null);
  const initialReservation = reservationsWithRent.find((r) => r.id === initialReservationId);
  const [selectedUnitId, setSelectedUnitId] = useState<string>(initialReservation?.unitId ?? "");
  const [selectedReservationId, setSelectedReservationId] = useState<string>(
    initialReservation ? initialReservation.id : "",
  );
  const reservationsForUnit = reservationsWithRent.filter(
    (r) => !selectedUnitId || r.unitId === selectedUnitId,
  );
  const selectedReservation =
    reservationsForUnit.find((r) => r.id === selectedReservationId) ?? null;
  const reservationRent = selectedReservation?.agreedMonthlyRent ?? "";

  // Derive the selected unit so the carpark picker can scope bays to the
  // unit's building (same property).
  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;
  const selectedPropertyId = selectedUnit?.propertyId;

  // ── Carparks picker ──────────────────────────────────────────────────────
  // Each added entry carries the bay id and an optional charge override; the
  // backend falls back to the bay's own monthlyRate when omitted.
  const [carparks, setCarparks] = useState<CarparkEntry[]>([]);
  const [selectedBayId, setSelectedBayId] = useState("");
  const [bayCharge, setBayCharge] = useState("");

  const availableCarparksQuery = useAvailableCarparksByProperty(selectedPropertyId);
  // Guard: data shape varies when the mock or API returns a non-array (e.g.
  // during tests where the default mock isn't carpark-shaped).
  const rawBays = availableCarparksQuery.data?.data;
  const availableBays = Array.isArray(rawBays) ? rawBays : [];
  // Filter out bays already added to prevent duplicates.
  const unpickedBays = availableBays.filter(
    (b) => !carparks.some((c) => c.carparkId === b.id),
  );

  // ── Renew Tenancy ─────────────────────────────────────────────────────────
  const [renewFeedback, setRenewFeedback] = useState<FeedbackState>(idle);
  const renewTenancy = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/tenancies/${id}/renew`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setRenewFeedback({ status: "success", message: "Tenancy renewed." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
    },
    onError: (err: Error) => {
      setRenewFeedback({ status: "error", message: err.message });
    },
  });

  // ── Update Tenancy Status ─────────────────────────────────────────────────
  const [statusFeedback, setStatusFeedback] = useState<FeedbackState>(idle);
  const updateStatus = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/tenancies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setStatusFeedback({ status: "success", message: "Tenancy status updated." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
    },
    onError: (err: Error) => {
      setStatusFeedback({ status: "error", message: err.message });
    },
  });

  const [renewalReviewFeedback, setRenewalReviewFeedback] = useState<FeedbackState>(idle);
  const updateRenewalReview = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/tenancies/${id}/renewal-review`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setRenewalReviewFeedback({ status: "success", message: "Renewal follow-up saved." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
      queryClient.invalidateQueries({ queryKey: ["action-centre"] });
    },
    onError: (err: Error) => setRenewalReviewFeedback({ status: "error", message: err.message }),
  });

  const [moveOutFeedback, setMoveOutFeedback] = useState<FeedbackState>(idle);
  const moveOutTenancy = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/tenancies/${id}/move-out`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setMoveOutFeedback({ status: "success", message: "Move-out completed. The old tenancy remains in history and the unit is now vacant." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (err: Error) => setMoveOutFeedback({ status: "error", message: err.message }),
  });
  const [depositSettlementFeedback, setDepositSettlementFeedback] = useState<FeedbackState>(idle);
  const updateDepositSettlement = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/tenancies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setDepositSettlementFeedback({ status: "success", message: "Owner deposit settlement updated." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
      queryClient.invalidateQueries({ queryKey: ["action-centre"] });
    },
    onError: (err: Error) => setDepositSettlementFeedback({ status: "error", message: err.message }),
  });

  return (
    <div className="grid gap-6">
      <FormGrid className="xl:grid-cols-2">
        {/* Create Tenancy — two-path form under the flag (T11/R3-R5/R7):
            tagged tenant + a still-signed reservation for the chosen unit
            derives startDate/endDate/monthlyRentAmount read-only and posts
            the convert-to-tenancy route; otherwise this falls back to plain
            manual entry against /tenancy/tenancies. Flag off renders the
            untouched legacy card below. */}
        {reservationGatedTenancyEnabled ? (
          <ReservationGatedCreateTenancyCard
            properties={properties}
            units={units}
            tenants={tenants}
          />
        ) : (
        <FormCard
          title="Create tenancy"
          description="Open a tenancy from property and unit to tenant."
          onSubmit={(e) => {
            e.preventDefault();
            setCreateFeedback(idle);
            const body: Record<string, unknown> = { ...getFormData(e) };
            // The picker is a UI-only control; never part of the API payload.
            delete body.reservationPicker;
            if (selectedReservation) {
              // Rent comes from the reservation server-side; never send a
              // competing monthlyRentAmount, and pass the reservation link.
              delete body.monthlyRentAmount;
              body.reservationId = selectedReservation.id;
            } else {
              delete body.reservationId;
            }
            if (carparks.length > 0) {
              body.carparks = carparks;
            }
            createTenancy.mutate(body);
          }}
        >
          <Field label="Property">
            <SelectInput name="propertyId" required>
              <option value="">Select property</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.propertyCode})
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Unit">
            <SelectInput
              name="unitId"
              required
              value={selectedUnitId}
              onChange={(e) => {
                setSelectedUnitId(e.target.value);
                // The picked reservation may no longer belong to the new unit.
                setSelectedReservationId("");
                // Reset carpark picks — bays scope to this unit's building.
                setCarparks([]);
                setSelectedBayId("");
                setBayCharge("");
              }}
            >
              <option value="">Select unit</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.propertyName} · {u.unitCode}
                </option>
              ))}
            </SelectInput>
          </Field>
          {/* Carparks picker — lists available bays in the selected unit's building */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              Carparks (optional)
            </span>
            <div className="grid gap-2">
              <div className="flex gap-2">
                <SelectInput
                  aria-label="Select carpark bay"
                  value={selectedBayId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedBayId(id);
                    const bay = unpickedBays.find((b) => b.id === id);
                    setBayCharge(bay?.monthlyRate ?? "");
                  }}
                  disabled={!selectedPropertyId || unpickedBays.length === 0}
                  className="w-auto flex-1"
                >
                  <option value="">
                    {!selectedPropertyId
                      ? "Pick a unit first"
                      : availableCarparksQuery.isLoading
                      ? "Loading bays…"
                      : unpickedBays.length === 0
                      ? "No available bays"
                      : "Select bay"}
                  </option>
                  {unpickedBays.map((bay) => (
                    <option key={bay.id} value={bay.id}>
                      {bay.label} · {bay.ownerName ?? "No owner"} · RM {bay.monthlyRate}
                    </option>
                  ))}
                </SelectInput>
                <TextInput
                  aria-label="Monthly charge override"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Rate"
                  value={bayCharge}
                  onChange={(e) => setBayCharge(e.target.value)}
                  className="w-28"
                />
                <ActionButton
                  type="button"
                  variant="secondary"
                  disabled={!selectedBayId}
                  onClick={() => {
                    if (!selectedBayId) return;
                    setCarparks((prev) => [
                      ...prev,
                      {
                        carparkId: selectedBayId,
                        ...(bayCharge ? { monthlyCharge: bayCharge } : {}),
                      },
                    ]);
                    setSelectedBayId("");
                    setBayCharge("");
                  }}
                >
                  Add bay
                </ActionButton>
              </div>
              {carparks.length > 0 && (
                <ul className="grid gap-1">
                  {carparks.map((c) => {
                    const bay = availableBays.find((b) => b.id === c.carparkId);
                    return (
                      <li
                        key={c.carparkId}
                        className="flex items-center justify-between rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] px-3 py-2 text-sm"
                      >
                        <span className="text-[var(--text-primary)]">
                          {bay?.label ?? c.carparkId}
                          {" · RM "}
                          {c.monthlyCharge ?? bay?.monthlyRate ?? "—"}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-rose-500 hover:text-rose-700"
                          onClick={() =>
                            setCarparks((prev) =>
                              prev.filter((x) => x.carparkId !== c.carparkId),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          {reservationsWithRent.length > 0 && (
            <Field label="Source from reservation (optional)">
              <SelectInput
                name="reservationPicker"
                value={selectedReservationId}
                onChange={(e) => setSelectedReservationId(e.target.value)}
                disabled={!selectedUnitId}
              >
                <option value="">
                  {selectedUnitId
                    ? reservationsForUnit.length > 0
                      ? "No reservation — enter rent manually"
                      : "No reservation for this unit"
                    : "Pick a unit first"}
                </option>
                {reservationsForUnit.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.referenceCode} · RM {r.agreedMonthlyRent} · {r.status}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
          <Field label="Tenant">
            <SelectInput name="tenantPartyId" required>
              <option value="">Select tenant</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </SelectInput>
          </Field>
          {/* No tenancy-code input: the server mints TEN-{year}-NNNN inside the
              create transaction. getFormData only reads rendered inputs, so the
              POST body simply omits tenancyCode — which is the signal to
              generate. The code is shown on the tenancies table once created. */}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Start date">
              <TextInput name="startDate" type="date" required />
            </Field>
            <Field label="End date">
              <TextInput name="endDate" type="date" />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Monthly rent"
              hint={
                selectedReservation
                  ? `Sourced from reservation ${selectedReservation.referenceCode}`
                  : undefined
              }
            >
              {selectedReservation ? (
                <TextInput
                  key="rent-sourced"
                  name="monthlyRentAmount"
                  type="text"
                  value={reservationRent}
                  readOnly
                  aria-readonly
                />
              ) : (
                <TextInput
                  key="rent-manual"
                  name="monthlyRentAmount"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  required
                />
              )}
            </Field>
            <Field label="Deposit amount">
              <TextInput
                name="depositAmount"
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="TA (WITH SST) amount (RM)"
              hint="Enter the final SST-inclusive amount. This creates a separate draft invoice to the tenant."
            >
              <TextInput name="tenancyAgreementFeeAmount" type="number" min={0} step="0.01" defaultValue="0" />
            </Field>
            <Field label="Agreement fee due date" hint="Leave blank to use the tenancy start date.">
              <TextInput name="tenancyAgreementFeeDueDate" type="date" />
            </Field>
          </div>
          <Field label="Billing status">
            <SelectInput name="billingStatus" defaultValue="active">
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="pending">pending</option>
            </SelectInput>
          </Field>
          <ActionButton type="submit" variant="primary" disabled={createTenancy.isPending}>
            {createTenancy.isPending ? "Creating…" : "Create tenancy"}
          </ActionButton>
          <FeedbackMessage status={createFeedback.status} message={createFeedback.message} />
        </FormCard>
        )}

        <FormCard
          title="Renewal follow-up"
          description="Two months before the tenancy ends, record whether the tenant has been contacted and their decision."
          onSubmit={(e) => {
            e.preventDefault();
            setRenewalReviewFeedback(idle);
            const data = getFormData(e);
            const { tenancyId, ...body } = data;
            if (!tenancyId) {
              setRenewalReviewFeedback({ status: "error", message: "Select a tenancy." });
              return;
            }
            updateRenewalReview.mutate({ id: tenancyId, body });
          }}
        >
          <Callout variant="info" title="Renewal control">
            Selecting Renew does not create the new tenancy yet. Complete the Renew tenancy form after terms and the tenant agreement fee are confirmed.
          </Callout>
          <Field label="Active tenancy">
            <SelectInput name="tenancyId" required>
              <option value="">Select tenancy</option>
              {tenancies.filter((t) => !t.status || t.status === "active").map((t) => (
                <option key={t.id} value={t.id}>
                  {t.propertyName && t.unitCode ? `${t.propertyName} ${t.unitCode} · ` : ""}{t.tenantName}{t.endDate ? ` · ends ${t.endDate.slice(0, 10)}` : ""}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Follow-up status">
            <SelectInput name="decision" defaultValue="contacted" required>
              <option value="pending">Not contacted yet</option>
              <option value="contacted">Contacted · awaiting decision</option>
              <option value="renew">Tenant wants to renew</option>
              <option value="not_renew">Tenant will not renew</option>
            </SelectInput>
          </Field>
          <Field label="Notes">
            <TextInput name="notes" placeholder="Contact method, agreed terms, reason, next follow-up…" />
          </Field>
          <ActionButton type="submit" variant="secondary" disabled={updateRenewalReview.isPending}>
            {updateRenewalReview.isPending ? "Saving…" : "Save follow-up"}
          </ActionButton>
          <FeedbackMessage status={renewalReviewFeedback.status} message={renewalReviewFeedback.message} />
        </FormCard>

        {/* Renew Tenancy */}
        <FormCard
          title="Renew tenancy"
          description="Roll a tenancy forward with new dates and rent terms."
          onSubmit={(e) => {
            e.preventDefault();
            setRenewFeedback(idle);
            const data = getFormData(e);
            const { tenancyId, ...body } = data;
            if (!tenancyId) {
              setRenewFeedback({ status: "error", message: "Select a tenancy." });
              return;
            }
            renewTenancy.mutate({ id: tenancyId, body });
          }}
        >
          <Field label="Tenancy">
            <SelectInput name="tenancyId" required>
              <option value="">Select tenancy</option>
              {tenancies.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.tenancyCode} · {t.tenantName}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="New tenancy code">
            <TextInput name="newTenancyCode" placeholder="New tenancy code" required />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="New start date">
              <TextInput name="newStartDate" type="date" required />
            </Field>
            <Field label="New end date">
              <TextInput name="newEndDate" type="date" />
            </Field>
          </div>
          <Field label="New monthly rent">
            <TextInput
              name="monthlyRentAmount"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              required
            />
          </Field>
          <Field
            label="Renewal TA (WITH SST) amount (RM)"
            hint="Enter the final SST-inclusive amount. Use 0 when no fee applies; it will appear as Saved · not billed for review."
          >
            <TextInput name="renewalFeeAmount" type="number" min={0} step="0.01" defaultValue="0" required />
          </Field>
          <Field
            label="Renewal fee due date"
            hint="Choose when the tenant must pay. Leave blank to use the renewed tenancy start date."
          >
            <TextInput name="renewalFeeDueDate" type="date" />
          </Field>
          <ActionButton type="submit" variant="secondary" disabled={renewTenancy.isPending}>
            {renewTenancy.isPending ? "Renewing…" : "Trigger renewal"}
          </ActionButton>
          <FeedbackMessage status={renewFeedback.status} message={renewFeedback.message} />
        </FormCard>
      </FormGrid>

      {/* Update Tenancy Status */}
      <div className="max-w-2xl">
        <FormCard
          title="Update tenancy status"
          description="Close, end, or pause an active tenancy chain."
          onSubmit={(e) => {
            e.preventDefault();
            setStatusFeedback(idle);
            const data = getFormData(e);
            const { tenancyId, ...body } = data;
            if (!tenancyId) {
              setStatusFeedback({ status: "error", message: "Select a tenancy." });
              return;
            }
            updateStatus.mutate({ id: tenancyId, body });
          }}
        >
          <Field label="Tenancy">
            <SelectInput name="tenancyId" required>
              <option value="">Select tenancy</option>
              {tenancies.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.tenancyCode} · {t.tenantName}
                </option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Status">
              <SelectInput name="status">
                <option value="">No change</option>
                <option value="active">active</option>
                <option value="ended">ended</option>
                <option value="terminated">terminated</option>
              </SelectInput>
            </Field>
            <Field label="Billing status">
              <SelectInput name="billingStatus">
                <option value="">No change</option>
                <option value="active">active</option>
                <option value="pending">pending</option>
                <option value="paused">paused</option>
                <option value="closed">closed</option>
              </SelectInput>
            </Field>
          </div>
          <Field label="End date">
            <TextInput name="endDate" type="date" />
          </Field>
          <ActionButton type="submit" variant="danger" disabled={updateStatus.isPending}>
            {updateStatus.isPending ? "Updating…" : "Update status"}
          </ActionButton>
          <FeedbackMessage status={statusFeedback.status} message={statusFeedback.message} />
        </FormCard>
      </div>

      <div className="max-w-2xl">
        <FormCard
          title="Complete tenant move-out"
          description="Ends billing, releases parking and records the deposit amount the owner must refund to the tenant."
          onSubmit={(e) => {
            e.preventDefault();
            setMoveOutFeedback(idle);
            const data = getFormData(e);
            const { tenancyId, ...body } = data;
            if (!tenancyId) {
              setMoveOutFeedback({ status: "error", message: "Select the tenancy that is moving out." });
              return;
            }
            moveOutTenancy.mutate({ id: tenancyId, body });
          }}
        >
          <Callout variant="warning" title="Actual handover only">
            A future notice should stay active until handover. Complete this step on the tenant&apos;s actual final occupied date.
          </Callout>
          <Callout variant="warning" title="Owner holds the deposit in custody">
            The deposit remains refundable tenant money, not owner income. Enter KAEN-approved tenant deductions and the amount the owner has directly refunded. A deduction becomes a paid Tenant Expense and is deducted from the next Owner Payout for KAEN.
          </Callout>
          <Field label="Active tenancy">
            <SelectInput name="tenancyId" required>
              <option value="">Select tenancy</option>
              {tenancies.map((t) => (
                <option key={t.id} value={t.id}>{t.tenancyCode} · {t.tenantName}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Actual move-out date">
            <TextInput name="moveOutDate" type="date" required />
          </Field>
          <Field label="Move-out notes">
            <TextInput name="moveOutNotes" placeholder="Keys returned, inspection notes, transferring to Unit B, etc." />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="KAEN-approved tenant deductions (RM)">
              <TextInput name="depositDeductionAmount" type="number" min="0" step="0.01" defaultValue="0.00" />
            </Field>
            <Field label="Deposit already refunded by owner (RM)">
              <TextInput name="depositRefundedAmount" type="number" min="0" step="0.01" defaultValue="0.00" />
            </Field>
          </div>
          <Field label="Owner refund date">
            <TextInput name="depositRefundDate" type="date" />
          </Field>
          <Field label="Deposit settlement notes">
            <TextInput name="depositSettlementNotes" placeholder="Damage deductions, owner transfer reference, tenant acknowledgement, etc." />
          </Field>
          <ActionButton type="submit" variant="danger" disabled={moveOutTenancy.isPending}>
            {moveOutTenancy.isPending ? "Completing…" : "Complete Move Out"}
          </ActionButton>
          <FeedbackMessage status={moveOutFeedback.status} message={moveOutFeedback.message} />
        </FormCard>
      </div>

      <div className="max-w-2xl">
        <FormCard
          title="Update owner deposit settlement"
          description="Use this after move-out when the owner later refunds the tenant. The outstanding reminder clears automatically once fully settled."
          onSubmit={(e) => {
            e.preventDefault();
            setDepositSettlementFeedback(idle);
            const data = getFormData(e);
            const { tenancyId, ...body } = data;
            if (!tenancyId) {
              setDepositSettlementFeedback({ status: "error", message: "Select an ended tenancy." });
              return;
            }
            updateDepositSettlement.mutate({ id: tenancyId, body });
          }}
        >
          <Callout variant="warning" title="Owner refund record">
            This records money returned by the owner. It is not a KAEN-held deposit payment.
          </Callout>
          <Field label="Ended tenancy">
            <SelectInput name="tenancyId" required>
              <option value="">Select ended tenancy</option>
              {tenancies.filter((t) => t.status && t.status !== "active").map((t) => (
                <option key={t.id} value={t.id}>{t.tenancyCode} · {t.tenantName}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Total refunded by owner to date (RM)">
            <TextInput name="depositRefundedAmount" type="number" min="0" step="0.01" defaultValue="0.00" />
          </Field>
          <Field label="Latest refund date">
            <TextInput name="depositRefundDate" type="date" />
          </Field>
          <Field label="Settlement notes">
            <TextInput name="depositSettlementNotes" placeholder="Refund reference, deductions agreed by tenant, supporting document, etc." />
          </Field>
          <ActionButton type="submit" disabled={updateDepositSettlement.isPending}>
            {updateDepositSettlement.isPending ? "Saving…" : "Save Deposit Settlement"}
          </ActionButton>
          <FeedbackMessage status={depositSettlementFeedback.status} message={depositSettlementFeedback.message} />
        </FormCard>
      </div>
    </div>
  );
}

// ── Reservation-gated create tenancy (T13/R3-R5/R7) ─────────────────────────
//
// Two paths, chosen by whether the SELECTED TENANT has their OWN signed,
// not-yet-converted reservation (T13/R5 — replaces T11's free-pick
// reservation select, which let an admin apply reservation R (applicant X)'s
// dates/rent onto an unrelated tenant Y; the convert route only checks the
// target has a "tenant" role, so nothing else caught that mismatch):
//   - Selecting a tagged tenant (`hasReservation`) fetches that tenant's own
//     linked reservation via getTenantLinkedReservation. A resolved
//     reservation → "derived" mode: startDate/endDate/monthlyRentAmount are
//     read-only (sourced from the reservation's own proposedMoveIn/
//     proposedMoveOut/agreedMonthlyRent) and DISABLED, so they're never part
//     of the submitted FormData at all — the backend
//     (convertReservationToTenancy) derives them itself from THAT
//     reservation; a disabled field can't leak a stale/tampered client date
//     into the request. Submits POST /admin/reservations/:id/convert-to-tenancy
//     with THAT reservation's id.
//   - `null` (tagged but no currently-derivable reservation — already
//     converted / not signed / unlinked) or an untagged tenant → manual
//     entry, same shape as the legacy card, POSTs /tenancy/tenancies.
//
// Carpark bays: reuses the SAME useAvailableCarparksByProperty hook as the
// legacy card (scoped to the selected unit's property) and includes
// `carparks` in BOTH submit bodies — both routes accept it server-side, and
// the gated path must not silently drop carpark assignment (reviewer
// Important #1 from the T11 report).
function ReservationGatedCreateTenancyCard({
  properties,
  units,
  tenants,
}: {
  properties: PropertyOption[];
  units: UnitOption[];
  tenants: TenantOption[];
}) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<FeedbackState>(idle);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [overlap, setOverlap] = useState<{
    incumbent: IncumbentInfo;
    retry: SubmitRequest;
  } | null>(null);

  const selectedTenant = tenants.find((t) => t.id === selectedTenantId) ?? null;
  const isTaggedTenant = !!selectedTenant?.hasReservation;
  // Only fetch for a tenant tagged hasReservation — an untagged tenant has no
  // linked reservation by construction, so skip the round trip entirely.
  const linkedReservationQuery = useQuery({
    queryKey: ["reservations", "linked-to-tenant", selectedTenantId],
    queryFn: () => getTenantLinkedReservation(selectedTenantId),
    enabled: !!selectedTenantId && isTaggedTenant,
  });
  // Money-safety (T13 review, paused-state fix): `.data` is `undefined` on
  // EVERY not-yet-settled state — loading, error, idle, AND React Query v5's
  // `fetchStatus: 'paused'` (an enabled query whose fetch never ran/parked a
  // retry because the browser is offline — the production QueryClient's
  // default `networkMode: 'online'`, see apps/web/src/main.tsx, has no
  // override). While paused, `isFetching`/`isError`/`isSuccess` all read
  // `false`, so a gate built only from `isFetching`/`isError` (as this used
  // to be) reads "not loading, not errored" and — via the `.data ?? null`
  // fallback — collapses straight to "no reservation": a tagged tenant with
  // a real signed reservation silently drops to editable manual entry with
  // submit enabled while offline. Rather than enumerate fetch states (and
  // risk missing the next one), block on the one state that's actually
  // safe: the lookup SETTLED SUCCESSFULLY, with a genuine reservation or a
  // genuine null. Loading, error, paused, and idle are ALL blocking,
  // uniformly — no `isFetching` in this gate.
  const reservationSettled = linkedReservationQuery.isSuccess;
  const reservationLookupBlocked = isTaggedTenant && !reservationSettled;
  // Kept separate from `reservationLookupBlocked` only to pick the Callout
  // variant/copy (danger + Retry-first vs info) — it does not loosen the
  // gate above.
  const reservationLookupError = isTaggedTenant && linkedReservationQuery.isError;
  const derivedReservation =
    isTaggedTenant && reservationSettled ? linkedReservationQuery.data ?? null : null;

  // Derive the selected unit so the carpark picker can scope bays to the
  // unit's building (same property) — mirrors the legacy card.
  const selectedUnit = units.find((u) => u.id === selectedUnitId) ?? null;
  const selectedPropertyId = selectedUnit?.propertyId;

  // ── Carparks picker ──────────────────────────────────────────────────────
  const [carparks, setCarparks] = useState<CarparkEntry[]>([]);
  const [selectedBayId, setSelectedBayId] = useState("");
  const [bayCharge, setBayCharge] = useState("");

  const availableCarparksQuery = useAvailableCarparksByProperty(selectedPropertyId);
  const rawBays = availableCarparksQuery.data?.data;
  const availableBays = Array.isArray(rawBays) ? rawBays : [];
  const unpickedBays = availableBays.filter(
    (b) => !carparks.some((c) => c.carparkId === b.id),
  );

  const submit = useMutation({
    mutationFn: (req: SubmitRequest) =>
      req.kind === "convert"
        ? apiFetch(`/admin/reservations/${req.reservationId}/convert-to-tenancy`, {
            method: "POST",
            body: JSON.stringify(req.body),
          })
        : apiFetch("/tenancy/tenancies", { method: "POST", body: JSON.stringify(req.body) }),
    onSuccess: () => {
      setFeedback({ status: "success", message: "Tenancy created." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
      setOverlap(null);
    },
    onError: (err: Error, req) => {
      if (err instanceof ApiError && err.status === 409 && err.code === "UNIT_HAS_ACTIVE_TENANCY") {
        const data = err.data as { incumbent?: IncumbentInfo } | undefined;
        setOverlap({
          incumbent: data?.incumbent ?? { tenantName: "current tenant", endDate: null },
          retry: req,
        });
        return;
      }
      setFeedback({ status: "error", message: err.message });
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Defense in depth alongside the disabled submit button (e.g. an Enter
    // keypress in a text field, or a submit event fired directly on the
    // form): never submit while the tagged tenant's reservation lookup
    // hasn't settled successfully — loading, errored, AND paused/idle all
    // block here.
    if (reservationLookupBlocked) return;
    setFeedback(idle);
    const raw = getFormData(e);

    if (derivedReservation) {
      // Derived path — dates/rent are never read from the form (the
      // startDate/endDate/monthlyRentAmount inputs are `disabled` below, so
      // FormData never contains them regardless).
      submit.mutate({
        kind: "convert",
        reservationId: derivedReservation.id,
        body: {
          tenantPartyId: raw.tenantPartyId,
          // tenancyCode omitted on purpose — convertReservationToTenancy
          // generates it. There is no input to read one from any more.
          ...(carparks.length > 0 ? { carparks } : {}),
        },
      });
    } else {
      submit.mutate({
        kind: "manual",
        body: { ...raw, ...(carparks.length > 0 ? { carparks } : {}) },
      });
    }
  }

  function handleConfirmOverwrite() {
    if (!overlap) return;
    const { retry } = overlap;
    submit.mutate({ ...retry, body: { ...retry.body, overwrite: true } });
  }

  return (
    <FormCard
      title="Create tenancy"
      description="Open a tenancy from property and unit to tenant. A tenant's own signed reservation derives terms automatically."
      onSubmit={onSubmit}
    >
      <Field label="Property">
        <SelectInput name="propertyId" required>
          <option value="">Select property</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.propertyCode})
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="Unit">
        <SelectInput
          name="unitId"
          required
          value={selectedUnitId}
          onChange={(e) => {
            setSelectedUnitId(e.target.value);
            // Reset carpark picks — bays scope to this unit's building.
            setCarparks([]);
            setSelectedBayId("");
            setBayCharge("");
          }}
        >
          <option value="">Select unit</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.propertyName} · {u.unitCode}
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="Tenant">
        <SelectInput
          name="tenantPartyId"
          required
          value={selectedTenantId}
          onChange={(e) => setSelectedTenantId(e.target.value)}
        >
          <option value="">Select tenant</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
              {t.hasReservation ? " — has reservation" : ""}
            </option>
          ))}
        </SelectInput>
      </Field>
      {/* Carparks picker — lists available bays in the selected unit's building */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Carparks (optional)
        </span>
        <div className="grid gap-2">
          <div className="flex gap-2">
            <SelectInput
              aria-label="Select carpark bay"
              value={selectedBayId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedBayId(id);
                const bay = unpickedBays.find((b) => b.id === id);
                setBayCharge(bay?.monthlyRate ?? "");
              }}
              disabled={!selectedPropertyId || unpickedBays.length === 0}
              className="w-auto flex-1"
            >
              <option value="">
                {!selectedPropertyId
                  ? "Pick a unit first"
                  : availableCarparksQuery.isLoading
                  ? "Loading bays…"
                  : unpickedBays.length === 0
                  ? "No available bays"
                  : "Select bay"}
              </option>
              {unpickedBays.map((bay) => (
                <option key={bay.id} value={bay.id}>
                  {bay.label} · {bay.ownerName ?? "No owner"} · RM {bay.monthlyRate}
                </option>
              ))}
            </SelectInput>
            <TextInput
              aria-label="Monthly charge override"
              type="number"
              min={0}
              step="0.01"
              placeholder="Rate"
              value={bayCharge}
              onChange={(e) => setBayCharge(e.target.value)}
              className="w-28"
            />
            <ActionButton
              type="button"
              variant="secondary"
              disabled={!selectedBayId}
              onClick={() => {
                if (!selectedBayId) return;
                setCarparks((prev) => [
                  ...prev,
                  {
                    carparkId: selectedBayId,
                    ...(bayCharge ? { monthlyCharge: bayCharge } : {}),
                  },
                ]);
                setSelectedBayId("");
                setBayCharge("");
              }}
            >
              Add bay
            </ActionButton>
          </div>
          {carparks.length > 0 && (
            <ul className="grid gap-1">
              {carparks.map((c) => {
                const bay = availableBays.find((b) => b.id === c.carparkId);
                return (
                  <li
                    key={c.carparkId}
                    className="flex items-center justify-between rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] px-3 py-2 text-sm"
                  >
                    <span className="text-[var(--text-primary)]">
                      {bay?.label ?? c.carparkId}
                      {" · RM "}
                      {c.monthlyCharge ?? bay?.monthlyRate ?? "—"}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-rose-500 hover:text-rose-700"
                      onClick={() =>
                        setCarparks((prev) => prev.filter((x) => x.carparkId !== c.carparkId))
                      }
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {/* Both branches below carry a Retry affordance — the blocked state
          must never become a permanent dead-end. For the non-error branch,
          `fetchStatus === "paused"` (offline / a parked retry, see the
          reservationSettled comment above) gets its own copy so the admin
          understands WHY nothing is happening, rather than reading a
          "checking" message that never resolves while offline. Retrying a
          paused query just re-pauses until connectivity returns (React
          Query auto-resumes on reconnect) — that's expected, not a bug. */}
      {reservationLookupBlocked && !reservationLookupError && (
        <Callout
          variant="info"
          title={
            linkedReservationQuery.fetchStatus === "paused"
              ? "Waiting to verify this tenant's reservation"
              : "Checking for a signed reservation…"
          }
        >
          <div className="flex items-center justify-between gap-3">
            <span>
              {linkedReservationQuery.fetchStatus === "paused"
                ? "We can't reach the server right now (you appear to be offline). Submitting stays disabled until this tenant's reservation status can be confirmed."
                : "Looking up this tenant's linked reservation. Submitting is disabled until this finishes, so manual terms can't be entered ahead of a reservation that should have derived them."}
            </span>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => linkedReservationQuery.refetch()}
            >
              Retry
            </ActionButton>
          </div>
        </Callout>
      )}
      {reservationLookupError && (
        <Callout variant="danger" title="Couldn't check for a signed reservation">
          <div className="flex items-center justify-between gap-3">
            <span>
              We couldn't confirm whether this tenant has a signed reservation, so submitting
              is disabled rather than risk manual terms overriding one.
            </span>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => linkedReservationQuery.refetch()}
            >
              Retry
            </ActionButton>
          </div>
        </Callout>
      )}
      {derivedReservation && (
        <Callout variant="info" title="Terms derived from reservation">
          Dates and monthly rent for {derivedReservation.referenceCode} are set automatically
          from this tenant's own signed reservation and can't be edited here.
        </Callout>
      )}
      {/* No tenancy-code input — server-generated on both paths: the manual
          create via createTenancyService, the derived path via
          convertReservationToTenancy's own `?? generate`. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Start date">
          <TextInput
            key={derivedReservation ? `derived-start-${derivedReservation.id}` : "manual-start"}
            name="startDate"
            type="date"
            required={!derivedReservation}
            disabled={!!derivedReservation}
            defaultValue={derivedReservation?.proposedMoveIn?.slice(0, 10) ?? ""}
          />
        </Field>
        <Field label="End date">
          <TextInput
            key={derivedReservation ? `derived-end-${derivedReservation.id}` : "manual-end"}
            name="endDate"
            type="date"
            disabled={!!derivedReservation}
            defaultValue={derivedReservation?.proposedMoveOut?.slice(0, 10) ?? ""}
          />
        </Field>
      </div>
      <div className={derivedReservation ? "grid gap-4" : "grid gap-4 md:grid-cols-2"}>
        <Field
          label="Monthly rent"
          hint={
            derivedReservation
              ? `Sourced from reservation ${derivedReservation.referenceCode}`
              : undefined
          }
        >
          <TextInput
            key={derivedReservation ? `derived-rent-${derivedReservation.id}` : "manual-rent"}
            name="monthlyRentAmount"
            type={derivedReservation ? "text" : "number"}
            min={derivedReservation ? undefined : 0}
            step={derivedReservation ? undefined : "0.01"}
            placeholder={derivedReservation ? undefined : "0.00"}
            required={!derivedReservation}
            disabled={!!derivedReservation}
            defaultValue={derivedReservation?.agreedMonthlyRent ?? ""}
          />
        </Field>
        {/* Deposit amount and billing status aren't accepted by the convert
            route (ConvertInput has no such fields) — hidden in derived mode
            rather than shown disabled, which would misleadingly imply they
            still apply. */}
        {!derivedReservation && (
          <Field label="Deposit amount">
            <TextInput name="depositAmount" type="number" min={0} step="0.01" placeholder="0.00" />
          </Field>
        )}
      </div>
      {!derivedReservation && (
        <Field label="Billing status">
          <SelectInput name="billingStatus" defaultValue="active">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="pending">pending</option>
          </SelectInput>
        </Field>
      )}
      <ActionButton
        type="submit"
        variant="primary"
        disabled={submit.isPending || reservationLookupBlocked}
      >
        {submit.isPending ? "Creating…" : "Create tenancy"}
      </ActionButton>
      <FeedbackMessage status={feedback.status} message={feedback.message} />

      <ConfirmAlert
        open={!!overlap}
        onCancel={() => setOverlap(null)}
        onConfirm={handleConfirmOverwrite}
        title="Unit already has an active tenancy"
        body={
          overlap ? (
            <>
              This unit is currently assigned to <strong>{overlap.incumbent.tenantName}</strong>
              {overlap.incumbent.endDate
                ? ` (ends ${overlap.incumbent.endDate.slice(0, 10)})`
                : ""}
              . Confirming will end that tenancy and assign the new one.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Overwrite and assign"
        destructive
      />
    </FormCard>
  );
}
