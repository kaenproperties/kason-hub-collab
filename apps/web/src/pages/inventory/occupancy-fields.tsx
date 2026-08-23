import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { FirstMonthPreview, CommissionPreview } from "@kason/shared";
import { TextInput } from "@/components/form-ui";
import { apiFetch } from "@/lib/api-client";
import { TenantSelect, type SlimTenant } from "./unit-form-fields";
import { TenantConfirmCard } from "./tenant-confirm-card";
import { FirstMonthPreviewCard } from "../tenancy/first-month-preview";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { Button } from "@/components/ui/button";
import { CreateTenantDialog } from "@/pages/parties/tenants-action-dialogs";
import { usePermission } from "@/components/permission-gate";

export function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="mt-1 text-sm text-red-600">{text}</p>;
}

export type OccupancyFieldErrors = Partial<{
  tenantPartyId: string;
  moveInDate: string;
  moveOutDate: string;
  monthlyRent: string;
}>;

// Server wording, verbatim, so a client-side block and the 400 that would have
// followed it read identically.
const RENT_REQUIRED_MESSAGE =
  "Enter the monthly rent before marking this unit occupied.";

/**
 * A tenancy stated as "1 year" ends on the day before its anniversary.
 * Keeping the calculation in UTC avoids a browser timezone moving the date
 * backwards when the ISO value is written into a date input.
 */
export function tenancyEndDate(startDate: string, years: 1 | 2): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return "";
  const [year, month, day] = startDate.split("-").map(Number);
  const anniversary = new Date(Date.UTC(year + years, month - 1, day));
  anniversary.setUTCDate(anniversary.getUTCDate() - 1);
  return anniversary.toISOString().slice(0, 10);
}

/**
 * How hard the occupied-unit rent rule bites. The create and update paths do
 * NOT share a server rule, so they must not share a client one:
 *
 *  - "none"      updateUnitService, flag off. syncOccupancyTenancy silently
 *                defaults the new tenancy to the unit's rentalRate, so there is
 *                nothing to require.
 *  - "explicit"  updateUnitService, flag ON. The sync demands an explicit
 *                monthlyRent > 0 -- rentalRate is NOT a fallback there.
 *  - "effective" createUnitService, EVERY flag state. Its pre-transaction guard
 *                is `const effectiveRent = input.monthlyRent ?? input.rentalRate`
 *                followed by a 400 OCCUPANCY_RENT_REQUIRED when that is not > 0.
 *                Demanding an explicit monthlyRent here would reject payloads
 *                the server accepts.
 */
export type OccupancyRentRule = "none" | "explicit" | "effective";

type OccupancyValidatable = {
  occupancyStatus: string;
  tenantPartyId: string | null;
  moveInDate: string;
  moveOutDate: string;
  monthlyRent: string;
  rentalRate: string;
};

// Matches unitFormToApiPayload's `num`: blank and unparseable both read as
// "absent", so `??` chaining below mirrors the server's `??` exactly (a
// deliberate 0 must reject, never fall through to a positive rentalRate).
function parseAmount(s: string): number | undefined {
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The rent rule the CREATE paths must apply, derived from the same flag the
 * server reads.
 *
 * Both create services — `createUnitService` (single unit) and
 * `createUnitsBatchService` (Partition / add-a-room) — hand the RAW
 * `monthlyRent` to `syncOccupancyTenancy` (inventory.service.ts:1525 and :951).
 * Under ENABLE_PHASE2_RESERVATION_GATED_TENANCY that helper throws
 * OCCUPANCY_RENT_REQUIRED unless `monthlyRent > 0` — it will NOT fall back to
 * the unit's advertised `rentalRate`. So with the flag on, "effective" is too
 * permissive on every create path and the operator gets a server 400 for a form
 * the client accepted. Flag off, the sync does take `rentalRate`, and demanding
 * an explicit rent would reject a payload the server would happily take.
 *
 * EditUnitForm already derives its rule this way (edit-unit-dialog.tsx). This
 * exists so the three create call sites cannot drift from it.
 */
export function createRentRule(): OccupancyRentRule {
  return isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY")
    ? "explicit"
    : "effective";
}

/** Shared by CreateUnitDialog and EditUnitDialog — one implementation of the
 *  occupied-unit tenancy rules, parameterised only where the server differs. */
export function validateOccupancy(
  state: OccupancyValidatable,
  { rentRule }: { rentRule: OccupancyRentRule },
): OccupancyFieldErrors {
  if (state.occupancyStatus !== "occupied") return {};
  const out: OccupancyFieldErrors = {};
  if (!state.tenantPartyId)
    out.tenantPartyId = "Select an existing tenant when occupancy is Occupied";
  if (!state.moveInDate)
    out.moveInDate = "Move-in date is required when occupancy is Occupied";
  if (!state.moveOutDate)
    out.moveOutDate = "Move-out date is required when occupancy is Occupied";
  if (state.moveInDate && state.moveOutDate && state.moveOutDate <= state.moveInDate)
    out.moveOutDate = "Move-out must be after move-in";

  if (rentRule !== "none") {
    const explicit = parseAmount(state.monthlyRent);
    const effective =
      rentRule === "explicit" ? explicit : explicit ?? parseAmount(state.rentalRate);
    if (!(typeof effective === "number" && effective > 0)) {
      out.monthlyRent = RENT_REQUIRED_MESSAGE;
    }
  }
  return out;
}

export function OccupancyFields(props: {
  occupancyStatus: string;
  tenantPartyId: string | null;
  tenantName: string;
  tenantIdType: string | null;
  tenantIdNumberMasked: string | null;
  tenantPhone: string | null;
  moveInDate: string;
  moveOutDate: string;
  // Explicit monthly rent for a NEW tenancy materialised via this dialog.
  // On the UPDATE path this is only rendered/required under
  // ENABLE_PHASE2_RESERVATION_GATED_TENANCY -- mirrors syncOccupancyTenancy's
  // server-side rule (no silent inheritance of the unit's rentalRate). Flag
  // off: field hidden, unit.rentalRate continues to be the silent default
  // server-side.
  monthlyRent: string;
  tenancyAgreementFeeAmount?: string;
  tenancyAgreementFeeDueDate?: string;
  // Optional "Start Rental Invoice on" value (Task 1 Tenancy column). The
  // first-month preview is POSTER-FAITHFUL: the auto-draft cron
  // (resolveMonthlyRentAmount -> computeProratedRent) prorates from the move-in
  // date and NEVER reads rentInvoiceStartDate, so the server deliberately
  // IGNORES this value and the previewed month/amount does NOT shift when it is
  // supplied. It is passed through only for forward-compat; wiring an actual
  // invoice-start shift requires teaching the poster first (change both sides
  // together). No UI input is wired here yet.
  rentInvoiceStartDate?: string;
  // The tenant this unit already had when the (Edit) dialog opened -- undefined
  // on Create and when the unit was vacant. Used to suppress the first-month
  // preview on the SAME-tenant in-place edit path: there the server takes
  // occupancy-tenancy-sync case 2, which never re-derives rent from the form,
  // so the poster keeps billing the tenancy's stored (possibly negotiated)
  // monthlyRentAmount -- NOT the asking-rate prefill (u.rentalRate) the form
  // shows. Previewing "First invoice ... RM<asking-rate-prorated>" there would
  // promise an amount the poster never bills, and the first-invoice framing is
  // false on a tenancy whose first invoice was already posted. When the tenant
  // is changed/cleared+repicked the server creates a NEW tenancy from the form
  // rent, so the preview IS accurate and continues to render.
  initialTenantPartyId?: string | null;
  /** CREATE path: render the rent input in every flag state. createUnitService's
   *  OCCUPANCY_RENT_REQUIRED guard is not flag-gated, so hiding the input would
   *  leave the admin unable to satisfy a 400 they cannot see the cause of. */
  showRent?: boolean;
  // First-month commission (Phase 1, display-only -- no money moves). When
  // checked, the rent-preview query also asks the API for a CommissionPreview
  // and the bearer choice is rendered alongside it. The create/edit forms that
  // mount OccupancyFields wire these in a follow-up task; both are optional so
  // no existing mount breaks.
  firstMonthIsCommission?: boolean;
  commissionSstBearer?: "owner" | "kaen";
  onFirstMonthIsCommissionChange?: (next: boolean) => void;
  onCommissionSstBearerChange?: (next: "owner" | "kaen") => void;
  onAgreementFeeChange?: (patch: { tenancyAgreementFeeAmount?: string; tenancyAgreementFeeDueDate?: string }) => void;
  onSelectTenant: (t: SlimTenant) => void;
  onClearTenant: () => void;
  onChange: (patch: Partial<{ moveInDate: string; moveOutDate: string; monthlyRent: string }>) => void;
  errors: OccupancyFieldErrors;
}) {
  const canCreateParty = usePermission("party.create");
  const rentNum = Number(props.monthlyRent);
  // The first-month rent-preview is a Phase-2 surface tied to the same
  // reservation-gating flag as the rent input it reads. Gate the query (and the
  // card below) on it so a flag-off build (client prod) never fires the preview
  // nor renders an unapproved "First invoice ..." card -- e.g. on Edit of a unit
  // occupied a year ago, where moveInDate + rentalRate are prefilled. Read before
  // the hook (pure function, not a hook) so it can feed `enabled`.
  const reservationGatingOn = isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY");
  // Read-only first-month preview. Enabled only with the data needed to compute
  // it; hook is called unconditionally (before any early return) to satisfy the
  // rules of hooks.
  // Same-tenant in-place edit: the unit already had THIS tenant when the dialog
  // opened. The server's occupancy sync takes case 2 (dates-only update, rent
  // untouched). The form now prefills the tenancy's REAL monthlyRentAmount
  // (edit-unit-dialog detailToFormState) -- what the poster actually bills, not
  // the divergent asking rate -- so the first-month / commission preview is
  // accurate and IS shown here (it's the operator's KAEN-commission calc for the
  // tenancy). The rent field itself is read-only on this path (see below): case-2
  // never writes it, so an edit here would be silently discarded.
  const isSameTenantInPlaceEdit =
    !!props.initialTenantPartyId && props.tenantPartyId === props.initialTenantPartyId;
  const previewEnabled =
    reservationGatingOn &&
    props.occupancyStatus === "occupied" &&
    !!props.moveInDate &&
    Number.isFinite(rentNum) &&
    rentNum > 0;
  const previewQuery = useQuery({
    queryKey: [
      "tenancy",
      "rent-preview",
      props.moveInDate,
      props.moveOutDate,
      props.monthlyRent,
      props.rentInvoiceStartDate ?? "",
      props.firstMonthIsCommission ?? false,
      props.commissionSstBearer ?? "owner",
    ],
    enabled: previewEnabled,
    staleTime: 30_000,
    queryFn: () => {
      const qs = new URLSearchParams({
        monthlyRent: props.monthlyRent,
        startDate: props.moveInDate,
      });
      if (props.moveOutDate) qs.set("endDate", props.moveOutDate);
      if (props.rentInvoiceStartDate) qs.set("rentInvoiceStartDate", props.rentInvoiceStartDate);
      if (props.firstMonthIsCommission) qs.set("firstMonthIsCommission", "true");
      if (props.commissionSstBearer) qs.set("commissionSstBearer", props.commissionSstBearer);
      return apiFetch<{ data: FirstMonthPreview; commission: CommissionPreview | null }>(
        `/tenancy/tenancies/rent-preview?${qs.toString()}`,
      );
    },
  });

  if (props.occupancyStatus !== "occupied") return null;
  const preview = previewEnabled ? previewQuery.data?.data ?? null : null;
  const commission = previewEnabled ? previewQuery.data?.commission ?? null : null;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-amber-800">
          Tenancy details
        </p>
        {canCreateParty && !props.tenantPartyId && (
          <CreateTenantDialog
            onCreated={(tenant) =>
              props.onSelectTenant({
                id: tenant.id,
                displayName: tenant.displayName,
                primaryPhone: tenant.primaryPhone ?? null,
                formattedPhone: null,
                idType: tenant.idType ?? null,
                idNumberMasked: null,
              })
            }
            trigger={
              <Button type="button" variant="outline" size="sm">
                <Plus className="h-4 w-4" />
                Create Tenant
              </Button>
            }
          />
        )}
      </div>

      <div className="block">
        <span className="block text-sm font-medium text-slate-700">Tenant</span>
        {props.tenantPartyId ? (
          <TenantConfirmCard
            tenantPartyId={props.tenantPartyId}
            displayName={props.tenantName}
            idType={props.tenantIdType}
            idNumberMasked={props.tenantIdNumberMasked}
            phone={props.tenantPhone}
            onChangeTenant={props.onClearTenant}
          />
        ) : (
          <TenantSelect
            value={null}
            displayName=""
            onSelect={props.onSelectTenant}
            onClear={props.onClearTenant}
          />
        )}
        <FieldError text={props.errors.tenantPartyId} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-sm font-medium text-slate-700">Move-in date</span>
          <TextInput
            type="date"
            value={props.moveInDate}
            onChange={(e) => props.onChange({ moveInDate: e.target.value })}
          />
          <FieldError text={props.errors.moveInDate} />
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-slate-700">Move-out date</span>
          <TextInput
            type="date"
            value={props.moveOutDate}
            onChange={(e) => props.onChange({ moveOutDate: e.target.value })}
          />
          <FieldError text={props.errors.moveOutDate} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label="Tenancy duration shortcuts">
        <span className="text-sm font-medium text-slate-700">Set tenancy:</span>
        {([1, 2] as const).map((years) => (
          <Button
            key={years}
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.moveInDate}
            onClick={() =>
              props.onChange({ moveOutDate: tenancyEndDate(props.moveInDate, years) })
            }
          >
            {years} Year{years === 1 ? "" : "s"}
          </Button>
        ))}
        {!props.moveInDate && (
          <span className="text-xs text-slate-500">Choose the move-in date first.</span>
        )}
      </div>

      {(props.showRent || reservationGatingOn) && (
        <label className="block">
          <span className="block text-sm font-medium text-slate-700">Tenancy monthly rent (RM)</span>
          <TextInput
            type="number"
            min={0}
            step="0.01"
            value={props.monthlyRent}
            onChange={(e) => props.onChange({ monthlyRent: e.target.value })}
            placeholder="2200"
            // Read-only on a same-tenant in-place edit: the occupancy sync's
            // case-2 never re-derives rent, so an edit here is silently discarded.
            // Editable on create / change-tenant, where a NEW tenancy IS made from
            // this value.
            readOnly={isSameTenantInPlaceEdit}
            aria-readonly={isSameTenantInPlaceEdit || undefined}
            className={isSameTenantInPlaceEdit ? "bg-slate-50 text-slate-500" : undefined}
          />
          {isSameTenantInPlaceEdit ? (
            <p className="mt-1 text-xs text-slate-500">
              This tenancy&apos;s current rent — read-only here. Rent isn&apos;t changed
              from this screen.
            </p>
          ) : null}
          <FieldError text={props.errors.monthlyRent} />
        </label>
      )}

      {props.occupancyStatus === "occupied" && !isSameTenantInPlaceEdit && (
        <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <label className="block">
            <span className="block text-sm font-medium text-slate-700">TA (WITH SST) amount (RM)</span>
            <TextInput
              type="number" min={0} step="0.01"
              value={props.tenancyAgreementFeeAmount ?? ""}
              onChange={(e) => props.onAgreementFeeChange?.({ tenancyAgreementFeeAmount: e.target.value })}
              placeholder="0.00"
            />
            <p className="mt-1 text-xs text-slate-500">This is the final SST-inclusive amount on a separate tenant invoice.</p>
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-slate-700">Agreement fee due date</span>
            <TextInput
              type="date"
              value={props.tenancyAgreementFeeDueDate ?? ""}
              onChange={(e) => props.onAgreementFeeChange?.({ tenancyAgreementFeeDueDate: e.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500">Blank uses the tenancy start date.</p>
          </label>
        </div>
      )}

      {reservationGatingOn && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={props.firstMonthIsCommission ?? false}
              onChange={(e) => props.onFirstMonthIsCommissionChange?.(e.target.checked)}
            />
            First month rent is KAEN&apos;s commission
          </label>
          {props.firstMonthIsCommission && (
            <label className="block text-xs text-slate-600">
              SST bearer
              <select
                value={props.commissionSstBearer ?? "owner"}
                onChange={(e) => props.onCommissionSstBearerChange?.(e.target.value as "owner" | "kaen")}
                className="mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="owner">Owner bears SST</option>
                <option value="kaen">KAEN absorbs SST</option>
              </select>
            </label>
          )}
        </div>
      )}
      <FirstMonthPreviewCard
        preview={preview}
        commission={commission}
        showNoCommissionNote={!!props.firstMonthIsCommission}
      />
    </div>
  );
}
