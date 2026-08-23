// Shared field-rendering helpers for the Create + Edit Unit dialogs.
// Lives next to the dialogs (not in /components) because the schema is
// inventory-specific and isn't reused elsewhere.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  X,
  Building2,
  ListChecks,
  Users,
  Eye,
  KeyRound,
  Wallet,
  FileText,
  Percent,
  Plus,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { SelectInput, TextAreaInput, TextInput } from "@/components/form-ui";
import { UnitTypeStep, type UnitMode } from "./unit-type-step";
import { FieldError, OccupancyFields, type OccupancyFieldErrors } from "./occupancy-fields";
import { OwnerConfirmCard } from "./owner-confirm-card";
import { CollapsibleSection } from "./collapsible-section";
import { SectionNav, type SectionNavItem } from "./section-nav";
import { DepositFields } from "@/components/deposit-fields";
import { ParkingFields } from "@/components/parking-fields";
import { AmenityCombobox } from "@/components/amenity-combobox";
import { TagInput } from "@/components/tag-input";
import { useActiveAmenities } from "@/hooks/use-amenities";
import { cn } from "@/lib/utils";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { Button } from "@/components/ui/button";
import { CreateOwnerDialog } from "@/pages/parties/owners-action-dialogs";
import { AgentFormDrawer } from "@/pages/parties/agent-form-drawer";
import { usePermission } from "@/components/permission-gate";

/** Occupancy errors plus the two apartment-scoped fields the create modal owns.
 *  Structurally a superset of OccupancyFieldErrors, so it still passes straight
 *  through to <OccupancyFields errors=…>. */
export type UnitFormErrors = OccupancyFieldErrors &
  Partial<{
    ownerPartyId: string;
    partitionBillingMode: string;
    tnbSubsidyCapMonthly: string;
  }>;

export type UnitFormState = {
  unitCode: string;
  unitType: string;
  // Step-1 choice of the two-step type picker. `null` until the operator
  // picks Whole or Partition (Create), or is inferred from the saved type on
  // Edit. Not sent to the server — it only gates the type dropdown and, in
  // Task 5, whether the partition room strip renders.
  unitMode: UnitMode | null;
  bedrooms: string;
  bathrooms: string;
  floor: string;
  floorArea: string;
  rentalRate: string;
  occupancyStatus: string;
  listingStatus: string;
  inChargePartyId: string | null;
  inChargeName: string;
  // Sourcing agent — distinct from inChargePartyId. Drives the "Agent
  // sourced" badge in the inventory explorer; admin sets/clears via the
  // edit dialog. Null on admin-uploaded units.
  sourcingAgentId: string | null;
  sourcingAgentName: string;
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  visibilityMode: "PUBLIC" | "RESTRICTED";
  // PUBLIC blocklist — agents who should NOT see this listing.
  hiddenFromPartyIds: string[];
  hiddenFromPartyNames: string[];
  // RESTRICTED allowlist — agents who CAN see this listing. Sync'd into
  // ListingVisibilityGrant on save.
  grantedPartyIds: string[];
  grantedPartyNames: string[];
  amenities: string[];
  // Free-form per-apartment selling points ("Near KLCC", "Corner unit").
  // Apartment-scoped — fans out to all sibling rooms when admin edits a room
  // via EditApartmentShell (applyToExistingSiblings). Distinct from amenities,
  // which is catalog-only and feeds the filter facet.
  highlights: string[];
  description: string;
  hasPaxDeduction: boolean;
  paxDeductionAmount: string;
  // Deposits (inventory upload extension) — string-typed to match existing convention
  depositMonths: string;
  utilitiesDepositMonths: string;
  accessCardDepositPerPcs: string;
  accessCardQuantity: string;
  // Parking (inventory upload extension)
  parkingQuantity: string;
  parkingNumbers: string[];
  parkingMonthlyRates: string[];
  // Owner. ownerPartyId drives the payload on the CREATE path (opt-in, see
  // unitFormToApiPayload); ownerName/ownerPhone are display-only. The per-room
  // EDIT dialog still renders this read-only and never sends it — owner is
  // re-pointed only through the audited fan-out in "Edit shared details".
  ownerPartyId: string | null;
  ownerName: string;             // display only (confirm card label)
  ownerPhone: string | null;     // display only (confirm card phone)
  // Apartment-scoped utility billing model. "" means "untouched" — the create
  // payload then OMITS the key entirely, so a room added to an existing
  // apartment inherits that apartment's mode instead of tripping the server's
  // 409 APARTMENT_BILLING_MODE_CONFLICT.
  partitionBillingMode: string;
  // Optional per-apartment monthly TNB owner subsidy cap in RM. Blank defers
  // to the apartment's selected/current legacy partition billing mode.
  tnbSubsidyCapMonthly: string;
  // Apartment-scoped, EDIT-only. Whether KAEN is currently the billing agent
  // for this apartment. Create default is `true` (managed); the toggle only
  // ever renders on the Edit path (showUnderManagement).
  underManagement: boolean;
  // Active tenancy — picker-based (Task 8). tenantPartyId drives the payload;
  // the other fields are display-only (confirm card) and hydrated from activeTenancy on edit.
  tenantPartyId: string | null;
  tenantName: string;             // display only (kept for the confirm card label)
  tenantIdType: string | null;
  tenantIdNumberMasked: string | null;
  tenantPhone: string | null;
  moveInDate: string;
  moveOutDate: string;
  // Explicit monthly rent for a NEW tenancy materialised via the occupancy
  // picker. Only meaningful (rendered/required/sent) under
  // ENABLE_PHASE2_RESERVATION_GATED_TENANCY -- see occupancy-fields.tsx.
  monthlyRent: string;
  tenancyAgreementFeeAmount: string;
  tenancyAgreementFeeDueDate: string;
  // First-month-commission toggles (Phase 1). Rendered only under the same flag
  // as monthlyRent; sent on the occupancy payload; seeded from the active tenancy
  // on edit.
  firstMonthIsCommission: boolean;
  commissionSstBearer: "owner" | "kaen";
};

// Unit-type options come from the Room Types admin (commissions/settings →
// Room Types). The dialog fetches the active list at open time via
// `useActiveRoomTypes`. No hardcoded fallback — if the API fails or returns
// nothing, the dropdown shows only what's actually configured (plus any
// pre-existing value loaded from the row being edited, unsuffixed).
type ActiveRoomType = { id: string; name: string; sortOrder: number; kind: "WHOLE" | "PARTITION" };

function useActiveRoomTypes() {
  return useQuery({
    queryKey: ["inventory-unit-dialog", "room-types"],
    queryFn: () =>
      apiFetch<{ data: ActiveRoomType[] }>("/commissions/room-types?activeOnly=true"),
    staleTime: 60_000,
  });
}

// Listing-status values surfaced in the dialog. Mirrors what the detail page
// renders (draft / active / archived) — the schema accepts any non-empty
// string but we only let the operator pick from this set so we don't land in
// an unknown lifecycle state. "active" is what the repo writes by default
// today; the unit-detail page UI treats both "active" and "published" as
// emerald. We standardize on "active" + "draft" + "archived" here.
export const LISTING_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export const OCCUPANCY_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "vacant", label: "Vacant — ready now" },
  { value: "reserved", label: "Reserved" },
  { value: "occupied", label: "Occupied" },
  { value: "maintenance", label: "Maintenance" },
];

export function blankUnitFormState(): UnitFormState {
  return {
    unitCode: "",
    // Empty default forces the operator to pick from the org's active Room
    // Types instead of silently lazy-defaulting to "apartment" — which used to
    // ghost-render as "apartment (legacy)" whenever the active list didn't
    // contain that value.
    unitType: "",
    unitMode: null,
    bedrooms: "",
    bathrooms: "",
    floor: "",
    floorArea: "",
    rentalRate: "",
    occupancyStatus: "vacant",
    listingStatus: "draft",
    inChargePartyId: null,
    inChargeName: "",
    sourcingAgentId: null,
    sourcingAgentName: "",
    sourceFlag: "COMPANY",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    hiddenFromPartyNames: [],
    grantedPartyIds: [],
    grantedPartyNames: [],
    amenities: [],
    highlights: [],
    description: "",
    hasPaxDeduction: false,
    paxDeductionAmount: "",
    depositMonths: "",
    utilitiesDepositMonths: "",
    accessCardDepositPerPcs: "",
    accessCardQuantity: "",
    parkingQuantity: "",
    parkingNumbers: [],
    parkingMonthlyRates: [],
    ownerPartyId: null,
    ownerName: "",
    ownerPhone: null,
    partitionBillingMode: "",
    tnbSubsidyCapMonthly: "",
    underManagement: true,
    tenantPartyId: null,
    tenantName: "",
    tenantIdType: null,
    tenantIdNumberMasked: null,
    tenantPhone: null,
    moveInDate: "",
    moveOutDate: "",
    monthlyRent: "",
    tenancyAgreementFeeAmount: "",
    tenancyAgreementFeeDueDate: "",
    firstMonthIsCommission: false,
    commissionSstBearer: "owner",
  };
}

// Inline section header — mirrors the colored vertical bar + uppercase label
// used on unit-detail-page.tsx so the dialog feels like a continuation of the
// detail surface rather than a generic shadcn modal.
export function FormSectionHeader({
  title,
  tone = "muted",
  icon,
}: {
  title: string;
  tone?: "gold" | "blue" | "muted" | "rose";
  /** Optional leading glyph, rendered in the tone colour before the label. */
  icon?: ReactNode;
}) {
  const barClass =
    tone === "gold"
      ? "bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]"
      : tone === "blue"
        ? "bg-blue-500/80"
        : tone === "rose"
          ? "bg-rose-500/80"
          : "bg-muted-foreground/60";
  const textClass =
    tone === "gold"
      ? "text-[#D4AF37]"
      : tone === "blue"
        ? "text-blue-400"
        : tone === "rose"
          ? "text-rose-400"
          : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2">
      <div className={cn("w-[3px] h-[16px] rounded-sm", barClass)} />
      {icon && <span className={cn("flex shrink-0 items-center", textClass)}>{icon}</span>}
      <span className={cn("text-[10px] font-bold uppercase tracking-[0.14em]", textClass)}>
        {title}
      </span>
    </div>
  );
}

export function FormSection({
  title,
  tone,
  icon,
  id,
  children,
}: {
  title: string;
  tone?: "gold" | "blue" | "muted" | "rose";
  icon?: ReactNode;
  /** Anchor id for the sticky SectionNav jump-to. */
  id?: string;
  children: ReactNode;
}) {
  return (
    // scroll-mt clears the sticky SectionNav so a jump doesn't tuck the header
    // under the pinned pill bar. Harmless when no nav is present.
    <div
      id={id}
      className="scroll-mt-20 rounded-xl border border-border/50 bg-background/40 px-4 py-4 space-y-4"
    >
      <FormSectionHeader title={title} tone={tone} icon={icon} />
      <div className="grid gap-4">{children}</div>
    </div>
  );
}

// A flat label/control row. Reuses the Field semantics from form-ui but with
// a tighter visual rhythm tuned for the dialog density.
//
// Rendered as <div role="group" aria-labelledby={…}> rather than <label> so
// composite widgets (AmenityCombobox, AgentMultiSelect, DepositFields) — which
// contain their own buttons — don't trigger HTML5 label-auto-activation. A
// <label> wrapping multiple buttons fires the first labelable descendant on
// any non-button click, which surfaced as "clicking anywhere removes the
// first amenity chip".
export function FormField({
  label,
  hint,
  children,
  className,
  action,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className={cn("grid gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
        {action}
      </div>
      {children}
      {hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
    </div>
  );
}

// ---- Assignable-member typeahead ------------------------------------------

// Rows returned by GET /parties/assignable. Includes non-agent staff (admins,
// managers, super-admins) — the Unit "in-charge" FK + visibility-grant FK
// both target Party.id regardless of partyType, so the picker should surface
// anyone in the org.
type SlimAssignable = {
  id: string;
  displayName: string;
  legalName?: string | null;
  agentLevel?: string | null;
  partyType?: string | null;
  // Operator parties (admin/manager/editor/viewer) come back with their
  // concrete User.role here. Null for non-operator parties (agents,
  // tenants, owners) — they have no linked User row.
  role?: string | null;
};

// Tiny role-hint label rendered under the displayName in the dropdown so the
// operator can tell who they're picking. For partyType=agent we surface the
// `agentLevel` (or just "agent" if unset); for operator parties (admin /
// manager / editor / viewer) we surface User.role; for anyone else we fall
// back to the partyType verbatim.
function assignableSubLabel(row: SlimAssignable): string {
  if (row.partyType === "agent") {
    return row.agentLevel || "agent";
  }
  if (row.role) return row.role;
  return row.partyType ?? "";
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AgentSelect({
  value,
  displayName,
  onSelect,
  onClear,
  placeholder,
  // Optional partyType allow-list. Sourcing-agent picker passes ["agent"]
  // so admins/managers stop showing as eligible sourcing agents; in-charge
  // picker passes ["agent","individual"] so tenants/owners are excluded
  // (client report 2026-05-22).
  allowedPartyTypes,
}: {
  value: string | null;
  displayName: string;
  onSelect: (id: string, displayName: string) => void;
  onClear: () => void;
  placeholder?: string;
  allowedPartyTypes?: ReadonlyArray<string>;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  const partyTypesParam =
    allowedPartyTypes && allowedPartyTypes.length > 0
      ? `&partyType=${encodeURIComponent(allowedPartyTypes.join(","))}`
      : "";

  const results = useQuery({
    queryKey: [
      "assignable-typeahead-unit-dialog",
      debouncedQ,
      allowedPartyTypes?.join(",") ?? "",
    ],
    queryFn: () =>
      apiFetch<{ data: SlimAssignable[] }>(
        `/parties/assignable?q=${encodeURIComponent(debouncedQ)}&take=20${partyTypesParam}`,
      ),
    enabled: open && debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = results.data?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={value ? displayName : q}
            readOnly={!!value}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (!value) setOpen(true);
            }}
            placeholder={placeholder ?? "Search by name…"}
            className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {open && !value && debouncedQ.length >= 1 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches found.</div>
          )}
          {options.map((a) => {
            const sub = assignableSubLabel(a);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onSelect(a.id, a.displayName);
                  setOpen(false);
                  setQ("");
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <div className="font-medium">{a.displayName}</div>
                {sub && (
                  <div className="text-xs text-muted-foreground capitalize">{sub.replace(/_/g, " ")}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Multi-select for "Hidden from" agents — same dropdown UX, but selections
// stack as removable chips and the input clears between picks.
export function AgentMultiSelect({
  selectedIds,
  selectedNames,
  onChange,
}: {
  selectedIds: string[];
  selectedNames: string[];
  onChange: (next: { ids: string[]; names: string[] }) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  const results = useQuery({
    queryKey: ["assignable-multi-typeahead-unit-dialog", debouncedQ],
    queryFn: () =>
      apiFetch<{ data: SlimAssignable[] }>(
        `/parties/assignable?q=${encodeURIComponent(debouncedQ)}&take=20`,
      ),
    enabled: open && debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = (results.data?.data ?? []).filter((a) => !selectedIds.includes(a.id));

  function remove(id: string) {
    const idx = selectedIds.indexOf(id);
    if (idx === -1) return;
    const ids = [...selectedIds];
    const names = [...selectedNames];
    ids.splice(idx, 1);
    names.splice(idx, 1);
    onChange({ ids, names });
  }

  return (
    <div ref={containerRef} className="relative space-y-2">
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id, i) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/30 px-2 py-0.5 text-xs"
            >
              {selectedNames[i] ?? id.slice(0, 8)}
              <button
                type="button"
                onClick={() => remove(id)}
                aria-label="Remove"
                className="hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search by name…"
          className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
      </div>
      {open && debouncedQ.length >= 1 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No more matches.</div>
          )}
          {options.map((a) => {
            const sub = assignableSubLabel(a);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onChange({
                    ids: [...selectedIds, a.id],
                    names: [...selectedNames, a.displayName],
                  });
                  setOpen(false);
                  setQ("");
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <div className="font-medium">{a.displayName}</div>
                {sub && (
                  <div className="text-xs text-muted-foreground capitalize">{sub.replace(/_/g, " ")}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- TenantSelect typeahead ------------------------------------------------

// Rows from GET /parties/tenants/search. Always masked — idNumberMasked is
// "••••1234" or null; the raw IC is never in this payload.
export type SlimTenant = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  formattedPhone: string | null;
  idType: string | null;
  idNumberMasked: string | null;
};

function tenantSubLabel(t: SlimTenant): string {
  const parts: string[] = [];
  if (t.idNumberMasked) parts.push(`${t.idType ? `${t.idType} ` : ""}${t.idNumberMasked}`);
  if (t.formattedPhone ?? t.primaryPhone) parts.push((t.formattedPhone ?? t.primaryPhone)!);
  return parts.join(" · ");
}

export function TenantSelect({
  value,
  displayName,
  onSelect,
  onClear,
  placeholder,
}: {
  value: string | null;
  displayName: string;
  onSelect: (tenant: SlimTenant) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  const results = useQuery({
    queryKey: ["tenant-typeahead-unit-dialog", debouncedQ],
    queryFn: () =>
      apiFetch<{ data: SlimTenant[] }>(
        `/parties/tenants/search?q=${encodeURIComponent(debouncedQ)}&take=20`,
      ),
    enabled: open && debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = results.data?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={value ? displayName : q}
            readOnly={!!value}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (!value) setOpen(true);
            }}
            placeholder={placeholder ?? "Search existing tenants by name…"}
            className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {open && !value && debouncedQ.length >= 1 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No matching tenant. Create the tenant in Parties first.
            </div>
          )}
          {options.map((t) => {
            const sub = tenantSubLabel(t);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  onSelect(t);
                  setOpen(false);
                  setQ("");
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <div className="font-medium">{t.displayName}</div>
                {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- OwnerSelect typeahead -------------------------------------------------

// Rows from GET /parties/owners/search. No IC in the payload — owners are not
// IC-verified at assignment time.
export type SlimOwner = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  formattedPhone: string | null;
};

export function OwnerSelect({
  value,
  displayName,
  onSelect,
  onClear,
  placeholder,
}: {
  value: string | null;
  displayName: string;
  onSelect: (owner: SlimOwner) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  const results = useQuery({
    queryKey: ["owner-typeahead-unit-dialog", debouncedQ],
    queryFn: () =>
      apiFetch<{ data: SlimOwner[] }>(
        `/parties/owners/search?q=${encodeURIComponent(debouncedQ)}&take=20`,
      ),
    enabled: open && debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = results.data?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={value ? displayName : q}
            readOnly={!!value}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (!value) setOpen(true);
            }}
            placeholder={placeholder ?? "Search owners by name…"}
            className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {open && !value && debouncedQ.length >= 1 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No matching owner. Create the owner in Parties first.
            </div>
          )}
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                onSelect(o);
                setOpen(false);
                setQ("");
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
            >
              <div className="font-medium">{o.displayName}</div>
              {(o.formattedPhone ?? o.primaryPhone) && (
                <div className="text-xs text-muted-foreground">
                  {o.formattedPhone ?? o.primaryPhone}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Render shared form body ----------------------------------------------

// `propertyOptions` is only required by the Create dialog (the property is
// fixed for Edit). When undefined the property selector is rendered as a
// read-only label.
export function UnitFormBody({
  state,
  setState,
  propertyOptions,
  selectedPropertyId,
  onSelectProperty,
  propertyPlaceholderName,
  showPropertySelect,
  showOwner = false,
  initialTenantPartyId,
  initialMonthlyRent,
  ownerEditable = false,
  allowCreateAgent = false,
  showBillingModel = false,
  showUnderManagement = false,
  alwaysShowRent = false,
  partitionFieldsInStrip = false,
  onModeChange,
  showSectionNav = false,
  errors,
}: {
  state: UnitFormState;
  setState: (next: UnitFormState) => void;
  propertyOptions?: { id: string; name: string; propertyCode: string }[];
  selectedPropertyId?: string;
  onSelectProperty?: (id: string) => void;
  propertyPlaceholderName?: string;
  showPropertySelect: boolean;
  /** Render the Owner field at all. */
  showOwner?: boolean;
  /** EDIT-only: the tenant the unit already had when the dialog opened. Drives
   *  OccupancyFields' same-tenant read-only rent + the re-pick rent restore
   *  (onSelectTenant below). Omitted on create. */
  initialTenantPartyId?: string | null;
  /** EDIT-only: the tenancy's rent captured at open. Restored when the initial
   *  tenant is RE-PICKED after "Change tenant" (an undo), so the read-only field
   *  shows the tenancy's real rent, not the asking-rate reset. Omitted on
   *  create. */
  initialMonthlyRent?: string;
  /** Make the Owner field an editable picker rather than a read-only card.
   *  CREATE only: createUnitService persists ownerPartyId and refuses an
   *  occupied create without an owner. The per-room EDIT dialog leaves this
   *  off — its payload never carries ownerPartyId, so an editable control
   *  there would silently drop the admin's choice. */
  ownerEditable?: boolean;
  /** CREATE-only: allow the operator to create a missing sourcing agent in
   * place and select it immediately. */
  allowCreateAgent?: boolean;
  /** Show the apartment Billing model control (SUBSIDY | NO_SUBSIDY). */
  showBillingModel?: boolean;
  /** EDIT-only: show the "Under management" toggle. A DEDICATED prop — never
   *  derived from showBillingModel — so the create dialog (which passes
   *  showBillingModel bare) never renders this apartment-scoped, edit-only
   *  control. */
  showUnderManagement?: boolean;
  /** Render the tenancy rent input regardless of the reservation flag. */
  alwaysShowRent?: boolean;
  /** The host renders a per-room strip (Create → Partition) that owns rent,
   *  deposits, access cards and parking PER ROOM. When true, this body hides
   *  its own apartment-level "Monthly rental" field and "Deposits & parking"
   *  section whenever the effective mode is PARTITIONED — otherwise the admin
   *  sees two competing sets of the same inputs and the body's set is silently
   *  ignored on submit (buildPartitionPayload sources those from the strip's
   *  rooms[]). The Edit dialog leaves this OFF: it has no strip, so its
   *  top-level fields ARE how a single partitioned room's rent/deposits are
   *  edited. */
  partitionFieldsInStrip?: boolean;
  /** Report the effective step-1 mode (Whole | Partition | null) to the host
   *  dialog so it can branch — e.g. the Create dialog renders the per-room
   *  strip and routes submit to the batch endpoint when this is "PARTITIONED".
   *  Derived here (an explicit pick wins, else inferred from the saved type)
   *  so the host never re-derives it. Pass a stable setter to avoid a loop. */
  onModeChange?: (mode: UnitMode | null) => void;
  /** Render the sticky section jump-nav at the top of the form (edit hosts). */
  showSectionNav?: boolean;
  errors?: UnitFormErrors;
}) {
  const canCreateParty = usePermission("party.create");
  const set = (patch: Partial<UnitFormState>) => setState({ ...state, ...patch });

  // Fetch active room types so the Unit Type dropdown reflects what super-admin
  // configured under /commissions/settings → Room Types. Falls back to the
  // legacy hardcoded list if the request fails or returns nothing, so the
  // dialog is never blocked from opening.
  const roomTypesQuery = useActiveRoomTypes();
  // Org-curated amenity catalog. Surface only active amenities here so
  // deactivated catalog rows are not selectable; existing units that already
  // reference a deactivated amenity continue to render via the chip path
  // (they're still in form state by ID and the GET hydrates them).
  const amenitiesQuery = useActiveAmenities();
  // activeRoomTypes: sorted list from the API — shape matches RoomTypeOption
  // so it can be passed directly to UnitTypeSelect.
  // If the row being edited carries a unitType value that is no longer in
  // the active Room Types list (e.g. admin deactivated "studio" after some
  // units were already saved with it), prepend it verbatim — no "(legacy)"
  // suffix — so the dropdown shows the saved value and doesn't silently
  // reset it on next save.
  const activeRoomTypes = useMemo(() => {
    const dynamic = (roomTypesQuery.data?.data ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (state.unitType && !dynamic.some((r) => r.name === state.unitType)) {
      // Deactivated type: synthesize a minimal RoomTypeOption so the dropdown
      // can render the saved value. Its real kind was lost when it left the
      // active Room Types list, so `kind` here is a placeholder ("WHOLE") used
      // ONLY to satisfy the option shape and slot the value under one optgroup.
      // It must NOT drive mode inference — effectiveMode below detects the
      // synthetic `legacy-` id and refuses to guess the step/lock from it.
      return [
        { id: `legacy-${state.unitType}`, name: state.unitType, sortOrder: -1, kind: "WHOLE" as const },
        ...dynamic,
      ];
    }
    return dynamic;
  }, [roomTypesQuery.data, state.unitType]);

  // Effective step-1 mode. An explicit choice (state.unitMode) always wins.
  // Otherwise, on Edit the unit already carries a type — infer the mode from
  // its RoomTypeOption.kind so the picker opens on the correct step without
  // forcing a re-pick. `null` (Create, nothing chosen yet) keeps the dropdown
  // disabled.
  const effectiveMode: UnitMode | null = useMemo(() => {
    if (state.unitMode) return state.unitMode;
    if (!state.unitType) return null;
    const match = activeRoomTypes.find((o) => o.name === state.unitType);
    // A deactivated/legacy type is synthesized (id `legacy-…`) with a
    // placeholder kind — its real kind was lost when it left the active Room
    // Types list. Guessing would mislabel the step-1 highlight AND wrongly lock
    // the off-mode optgroup (a partitioned room shown as "Whole", partition
    // types locked). Return null: the saved value still renders, no group is
    // falsely locked, and the operator picks a mode explicitly to change it.
    if (!match || match.id.startsWith("legacy-")) return null;
    return match.kind === "PARTITION" ? "PARTITIONED" : "WHOLE";
  }, [state.unitMode, state.unitType, activeRoomTypes]);

  // Surface the derived mode to the host dialog. onModeChange is expected to
  // be a stable state setter, so this only fires when the mode actually flips.
  useEffect(() => {
    onModeChange?.(effectiveMode);
  }, [effectiveMode, onModeChange]);

  // Partition + host-strip: the per-room strip owns rent/deposits/cards/parking,
  // so suppress this body's apartment-level duplicates to avoid two competing
  // input sets (the body's would be silently dropped on submit).
  const hidePerRoomFields = partitionFieldsInStrip && effectiveMode === "PARTITIONED";
  // Sibling gate to hidePerRoomFields (same predicate — CREATE-only via
  // partitionFieldsInStrip, and only when PARTITIONED). The batch endpoint
  // persists ONLY shared apartment fields + per-room rent/deposits/cards/parking.
  // Lifecycle, the tenant/occupancy block, listing status, sourcing agent, the
  // derived Source, visibility + its audience, and pax deduction have nowhere to
  // go — so they are HIDDEN (not disabled) here rather than rendered as controls
  // whose values the submit path silently discards. In charge, Owner and Billing
  // model stay: they ARE on `shared`.
  const hidePartitionOrphanFields = hidePerRoomFields;
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  const parsedDeductionInvalid = useMemo(() => {
    if (!state.hasPaxDeduction) return false;
    if (state.paxDeductionAmount === "") return true;
    const n = Number(state.paxDeductionAmount);
    return Number.isNaN(n) || n < 0;
  }, [state.hasPaxDeduction, state.paxDeductionAmount]);

  // Sections the jump-nav can land on — only those actually rendered. In the
  // edit hosts (the only ones that pass showSectionNav) hidePartitionOrphanFields
  // is always false, so all of these are present.
  const navItems = useMemo<SectionNavItem[]>(() => {
    const items: SectionNavItem[] = [{ id: "unitsec-basic", label: "Basics" }];
    if (showOwner || showBillingModel || showUnderManagement)
      items.push({ id: "unitsec-owner", label: "Ownership" });
    if (!hidePartitionOrphanFields) items.push({ id: "unitsec-listing", label: "Listing" });
    items.push({ id: "unitsec-assign", label: "Assignment" });
    if (!hidePartitionOrphanFields) items.push({ id: "unitsec-visibility", label: "Visibility" });
    if (!hidePerRoomFields) items.push({ id: "unitsec-deposits", label: "Deposits" });
    items.push({ id: "unitsec-desc", label: "Description" });
    return items;
  }, [
    hidePartitionOrphanFields,
    hidePerRoomFields,
    showOwner,
    showBillingModel,
    showUnderManagement,
  ]);

  return (
    <div className="space-y-4">
      {showSectionNav && <SectionNav items={navItems} />}
      {/* Section: Basic info */}
      <FormSection
        title="Basic info"
        tone="gold"
        id="unitsec-basic"
        icon={<Building2 className="h-3.5 w-3.5" />}
      >
        {/* Property + Unit code: two single-line controls, so they share a row
            and land on the same baseline. */}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {showPropertySelect && propertyOptions && (
            <FormField label="Property">
              <SelectInput
                value={selectedPropertyId ?? ""}
                onChange={(e) => onSelectProperty?.(e.target.value)}
                required
              >
                <option value="">Select property</option>
                {propertyOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.propertyCode})
                  </option>
                ))}
              </SelectInput>
            </FormField>
          )}
          {!showPropertySelect && propertyPlaceholderName && (
            <FormField label="Property">
              <div className="min-h-10 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {propertyPlaceholderName}
              </div>
            </FormField>
          )}
          <FormField label="Unit code">
            <TextInput
              value={state.unitCode}
              onChange={(e) => set({ unitCode: e.target.value })}
              placeholder="A-18-06"
              required
            />
          </FormField>
        </div>
        {/* Unit type owns a full-width row. Its two mode cards are themselves a
            2-col grid and the type dropdown sits beneath them — a 3-row-tall
            block. Pairing that with a 1-row input stretched the input's cell and
            left the dropdown floating in a column with nothing to align to. */}
        <FormField label="Unit type">
          <UnitTypeStep
            value={state.unitType}
            mode={effectiveMode}
            onChange={(next) => set({ unitType: next })}
            onModeChange={(next) => set({ unitMode: next })}
            options={activeRoomTypes}
            disabled={roomTypesQuery.isLoading}
            // Partition + host-strip: per-room types live in the strip, so the
            // top-level type dropdown is orphaned — hide it (mode buttons stay).
            hideTypeSelect={hidePerRoomFields}
          />
        </FormField>
        {/* items-start: stop the outer grid from vertically stretching cells.
            Without it, fields with hints (Floor, Floor area) push the row
            taller, and CSS grid centers the no-hint inputs (Bedrooms,
            Bathrooms) into the extra vertical space — inputs land on
            different baselines across the row. */}
        <div className="grid items-start gap-4 sm:grid-cols-2 md:grid-cols-4">
          <FormField label="Floor" hint="Level the unit sits on, e.g. 18.">
            <TextInput
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              value={state.floor}
              onChange={(e) => set({ floor: e.target.value })}
              placeholder="18"
            />
          </FormField>
          <FormField
            label="Bedrooms"
            hint={
              state.listingStatus !== "draft"
                ? "Required to publish — leave blank to save as Draft."
                : undefined
            }
          >
            <TextInput
              type="number"
              min={0}
              step="1"
              value={state.bedrooms}
              onChange={(e) => set({ bedrooms: e.target.value })}
              placeholder="0"
            />
          </FormField>
          <FormField
            label="Bathrooms"
            hint={
              state.listingStatus !== "draft"
                ? "Required to publish — leave blank to save as Draft."
                : undefined
            }
          >
            <TextInput
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              value={state.bathrooms}
              onChange={(e) => set({ bathrooms: e.target.value })}
              placeholder="0"
            />
          </FormField>
          <FormField label="Floor area" hint="sqft">
            <TextInput
              type="number"
              min={0}
              step="1"
              value={state.floorArea}
              onChange={(e) => set({ floorArea: e.target.value })}
              placeholder="850"
            />
          </FormField>
        </div>
        {/* Partition (Create): rent is captured per room in the strip below, so
            this apartment-level field is hidden to avoid a duplicate the submit
            path ignores. */}
        {/* Labelled "(asking rate)" on purpose. This is the LISTING rate and is
            never changed by assigning a tenant — the negotiated figure lives on
            the Tenancy and is edited as "Tenancy monthly rent (RM)" in the
            Tenancy details box below. Two fields both called "Monthly rental"
            is what made an occupied unit look like it had ignored the rent the
            operator keyed in. Kept "Monthly rental" in the label so existing
            accessible-name queries (create-unit-dialog tests) still match. */}
        {!hidePerRoomFields && (
          <FormField
            label="Monthly rental (asking rate)"
            hint={
              state.listingStatus !== "draft"
                ? "RM per month · the listing's asking rate, not the tenant's negotiated rent · required to publish — leave blank to save as Draft."
                : "RM per month · the listing's asking rate, not the tenant's negotiated rent"
            }
          >
            <TextInput
              type="number"
              min={0}
              step="0.01"
              value={state.rentalRate}
              onChange={(e) => set({ rentalRate: e.target.value })}
              placeholder="2200"
            />
          </FormField>
        )}
      </FormSection>

      {/* People are intentionally ordered Owner → Tenant → Agent on Create Unit.
          The owner is the apartment-level commercial principal, the tenant is
          assigned next, and the sourcing/in-charge agent follows after that.
          Keeping this as real DOM order also makes keyboard Tab navigation match
          the visible workflow instead of merely reordering the cards with CSS. */}
      {(showOwner || showBillingModel || showUnderManagement) && (
      <FormSection
        title="Ownership & billing"
        tone="gold"
        id="unitsec-owner"
        icon={<KeyRound className="h-3.5 w-3.5" />}
      >
        {/* Owner — apartment-scoped. Editable on create (the payload carries it
            and an occupied create is refused without one); read-only on the
            per-room edit dialog, where owner is re-pointed only through the
            audited fan-out in "Edit shared details". */}
        {showOwner && (
          <FormField
            label="Owner"
            action={
              canCreateParty && ownerEditable && !state.ownerPartyId ? (
                <CreateOwnerDialog
                  onCreated={(owner) =>
                    set({
                      ownerPartyId: owner.id,
                      ownerName: owner.displayName,
                      ownerPhone: owner.primaryPhone ?? null,
                    })
                  }
                  trigger={
                    <Button type="button" variant="outline" size="sm">
                      <Plus className="h-4 w-4" />
                      Create Owner
                    </Button>
                  }
                />
              ) : null
            }
            hint={
              ownerEditable
                ? "Owner of the whole apartment — applies to every room. Required before a room may be marked Occupied. Drives management fee and owner statements."
                : 'Set for the whole unit in "Edit shared details". Drives management fee and owner statements.'
            }
          >
            {ownerEditable ? (
              state.ownerPartyId ? (
                <OwnerConfirmCard
                  ownerId={state.ownerPartyId}
                  ownerName={state.ownerName}
                  ownerPhone={state.ownerPhone}
                  onChange={() => set({ ownerPartyId: null, ownerName: "", ownerPhone: null })}
                />
              ) : (
                <OwnerSelect
                  value={state.ownerPartyId}
                  displayName={state.ownerName}
                  onSelect={(o) =>
                    set({
                      ownerPartyId: o.id,
                      ownerName: o.displayName,
                      ownerPhone: o.formattedPhone ?? o.primaryPhone,
                    })
                  }
                  onClear={() => set({ ownerPartyId: null, ownerName: "", ownerPhone: null })}
                />
              )
            ) : state.ownerPartyId ? (
              <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
                <p className="text-sm font-medium text-foreground">{state.ownerName}</p>
                {state.ownerPhone && (
                  <p className="mt-0.5 text-xs font-mono text-muted-foreground">{state.ownerPhone}</p>
                )}
              </div>
            ) : (
              <p className="text-sm italic text-muted-foreground">
                No owner assigned — set it in "Edit shared details".
              </p>
            )}
            <FieldError text={errors?.ownerPartyId} />
          </FormField>
        )}
        {/* Billing model — apartment-scoped and money-adjacent. The blank option
            is the default: it omits the key from the payload so an added room
            inherits the apartment's existing mode rather than colliding with it
            (409 APARTMENT_BILLING_MODE_CONFLICT). */}
        {showBillingModel && (
          <>
            <FormField
              label="Billing model"
              hint="Applies to the whole apartment. An entered TNB cap takes priority for residual TNB. With a blank cap, Subsidy uses legacy per-pax and No subsidy provides none."
            >
              <SelectInput
                value={state.partitionBillingMode}
                onChange={(e) => set({ partitionBillingMode: e.target.value })}
              >
                <option value="">Use the apartment&apos;s current setting</option>
                <option value="NO_SUBSIDY">No subsidy</option>
                <option value="SUBSIDY">Subsidy</option>
              </SelectInput>
              <FieldError text={errors?.partitionBillingMode} />
            </FormField>
            <FormField
              label="Monthly TNB owner subsidy cap (RM)"
              hint="Optional, per unit and per month. An entered cap overrides the billing model for residual TNB. Blank uses the selected/current model: Subsidy = legacy per-pax; No subsidy = none. Applies after private-meter charges."
            >
              <TextInput
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={state.tnbSubsidyCapMonthly}
                onChange={(e) => set({ tnbSubsidyCapMonthly: e.target.value })}
                placeholder="e.g. 200.00"
              />
              <FieldError text={errors?.tnbSubsidyCapMonthly} />
            </FormField>
          </>
        )}
        {/* Under management — EDIT-only. Dedicated showUnderManagement gate
            (never showBillingModel): the create dialog passes showBillingModel
            bare, so reusing it here would leak this apartment-scoped toggle
            onto the create form, which has no such concept yet. */}
        {showUnderManagement && (
          <FormField
            label="Under management"
            hint="When off, KAEN stops acting as the billing agent for this apartment: no management-fee charges, no auto cleaning bills, and it drops from the owner's statements and portal financials. Existing records are unchanged."
          >
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={state.underManagement}
                onChange={(e) => set({ underManagement: e.target.checked })}
                className="h-4 w-4 rounded border-[var(--input-border)] accent-[var(--primary)]"
              />
              <span className="text-sm text-foreground">This apartment is under KAEN management</span>
            </label>
          </FormField>
        )}
      </FormSection>
      )}

      {/* Section: Listing status + tenancy. Gated to !hidePartitionOrphanFields
          — Partition-create hides these (the batch endpoint has nowhere to put
          them). OccupancyFields self-renders its amber "Tenancy details" box
          only when Occupied, so otherwise this is just the two status selects. */}
      {!hidePartitionOrphanFields && (
      <FormSection
        title="Listing status"
        tone="blue"
        id="unitsec-listing"
        icon={<ListChecks className="h-3.5 w-3.5" />}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Lifecycle status">
            <SelectInput
              value={state.occupancyStatus}
              onChange={(e) => set({ occupancyStatus: e.target.value })}
            >
              {OCCUPANCY_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Listing status">
            <SelectInput
              value={state.listingStatus}
              onChange={(e) => set({ listingStatus: e.target.value })}
            >
              {LISTING_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </FormField>
        </div>
        {state.occupancyStatus !== "occupied" && !state.tenantPartyId && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <div>
              <p className="font-semibold text-[var(--navy)]">Tenant moving into this unit?</p>
              <p className="text-sm text-[var(--text-secondary)]">Add the tenant and tenancy details before creating the unit.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-[var(--gold)] bg-white font-bold"
              onClick={() => set({ occupancyStatus: "occupied" })}
            >
              <Plus className="h-4 w-4" /> Add tenant now
            </Button>
          </div>
        )}
        <OccupancyFields
          occupancyStatus={state.occupancyStatus}
          tenantPartyId={state.tenantPartyId}
          tenantName={state.tenantName}
          tenantIdType={state.tenantIdType}
          tenantIdNumberMasked={state.tenantIdNumberMasked}
          tenantPhone={state.tenantPhone}
          moveInDate={state.moveInDate}
          moveOutDate={state.moveOutDate}
          monthlyRent={state.monthlyRent}
          tenancyAgreementFeeAmount={state.tenancyAgreementFeeAmount}
          tenancyAgreementFeeDueDate={state.tenancyAgreementFeeDueDate}
          firstMonthIsCommission={state.firstMonthIsCommission}
          commissionSstBearer={state.commissionSstBearer}
          onFirstMonthIsCommissionChange={(next) => set({ firstMonthIsCommission: next })}
          onCommissionSstBearerChange={(next) => set({ commissionSstBearer: next })}
          initialTenantPartyId={initialTenantPartyId}
          showRent={alwaysShowRent}
          onSelectTenant={(t) =>
            set({
              tenantPartyId: t.id,
              tenantName: t.displayName,
              tenantIdType: t.idType,
              tenantIdNumberMasked: t.idNumberMasked,
              tenantPhone: t.formattedPhone ?? t.primaryPhone,
              // Re-picking the INITIAL tenant (an "undo" of Change tenant) restores
              // the tenancy's real rent that onClearTenant reset to the asking rate,
              // so the now-read-only field shows the actual rent — not the asking
              // rate for the existing tenant. Only fires for the same tenant the
              // dialog opened with; a genuinely different tenant keeps the asking-
              // rate reset (a NEW tenancy is materialised from it).
              ...(initialTenantPartyId &&
              t.id === initialTenantPartyId &&
              initialMonthlyRent != null
                ? { monthlyRent: initialMonthlyRent }
                : {}),
            })
          }
          onAgreementFeeChange={(patch) => set(patch)}
          onClearTenant={() =>
            set({
              tenantPartyId: null,
              tenantName: "",
              tenantIdType: null,
              tenantIdNumberMasked: null,
              tenantPhone: null,
              // Reset rent to the unit's asking rate. On the same-tenant view the
              // field was prefilled with the OUTGOING tenant's negotiated rent;
              // without this reset, picking a new tenant would silently create the
              // new tenancy at the previous tenant's rate (cross-tenant rate
              // bleed). The neutral asking rate is the pre-existing default the
              // operator adjusts for the new tenant.
              //
              // KNOWN MINOR EDGE: if the operator clears and then RE-PICKS the same
              // (initial) tenant — an "undo" — the field is now the asking rate and
              // goes read-only again showing that rate, not the tenancy's real rent
              // (onSelectTenant doesn't restore it). Display-only: the same-tenant
              // save takes occupancy-sync case-2, which ignores rent, so the stored
              // rent is untouched. Closing it fully means threading the initial rent
              // to restore on re-pick — deferred as not worth the blast radius here.
              monthlyRent: state.rentalRate,
            })
          }
          onChange={(patch) => set(patch)}
          errors={errors ?? {}}
        />
      </FormSection>
      )}

      {/* Section: Assignment & source. In charge is a shared apartment field and
          stays visible in Partition mode; the sourcing agent and the derived
          Source are gated (orphaned on the batch endpoint). */}
      <FormSection
        title="Assignment & source"
        tone="blue"
        id="unitsec-assign"
        icon={<Users className="h-3.5 w-3.5" />}
      >
        {/* Sourcing agent FIRST. When the admin picks one and the in-charge
            is still blank, fan it out to in-charge as a sensible default —
            the agent who brought the listing in usually runs it too. They
            can still override in-charge below. The Source label below is
            DERIVED from these two fields — there is no "switch to company"
            override because a listing assigned to an agent is, by
            definition, agent-sourced (client clarification 2026-05-22). */}
        {!hidePartitionOrphanFields && (
          <FormField
            label="Sourcing agent"
            action={
              allowCreateAgent ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setCreateAgentOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Create Agent
                </Button>
              ) : null
            }
            hint="Agent who brought in this listing. Only agent-role parties are eligible."
          >
            <AgentSelect
              value={state.sourcingAgentId}
              displayName={state.sourcingAgentName}
              allowedPartyTypes={["agent"]}
              onSelect={(id, name) =>
                set(
                  state.inChargePartyId === null
                    ? {
                        sourcingAgentId: id,
                        sourcingAgentName: name,
                        inChargePartyId: id,
                        inChargeName: name,
                      }
                    : { sourcingAgentId: id, sourcingAgentName: name },
                )
              }
              onClear={() => set({ sourcingAgentId: null, sourcingAgentName: "" })}
            />
          </FormField>
        )}
        {/* In charge — kept in Partition mode: it IS a `shared` apartment field. */}
        <FormField label="In charge" hint="Agent or editor+ staff. Defaults to the Sourcing agent when one is set.">
          <AgentSelect
            value={state.inChargePartyId}
            displayName={state.inChargeName}
            allowedPartyTypes={["agent", "individual"]}
            onSelect={(id, name) => set({ inChargePartyId: id, inChargeName: name })}
            onClear={() => set({ inChargePartyId: null, inChargeName: "" })}
          />
        </FormField>
        {/* Source — derived from the sourcing agent; gated (orphaned on batch). */}
        {!hidePartitionOrphanFields && (
          <FormField label="Source" hint="Agent-sourced only when a Sourcing agent is assigned. In-charge does not affect this — even if In-charge is an agent.">
            <div
              data-testid="source-derived"
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground"
            >
              {state.sourcingAgentId !== null ? (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-sky-500" />
                  Agent sourced
                </>
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
                  Company listing
                </>
              )}
            </div>
          </FormField>
        )}
      </FormSection>

      {allowCreateAgent && (
        <AgentFormDrawer
          open={createAgentOpen}
          mode="create"
          agent={null}
          onClose={() => setCreateAgentOpen(false)}
          onCreated={(agent) =>
            set(
              state.inChargePartyId === null
                ? {
                    sourcingAgentId: agent.id,
                    sourcingAgentName: agent.displayName,
                    inChargePartyId: agent.id,
                    inChargeName: agent.displayName,
                  }
                : { sourcingAgentId: agent.id, sourcingAgentName: agent.displayName },
            )
          }
        />
      )}

      {/* Section: Visibility & audience. Gated (orphaned on the batch endpoint). */}
      {!hidePartitionOrphanFields && (
      <FormSection
        title="Visibility & audience"
        tone="blue"
        id="unitsec-visibility"
        icon={<Eye className="h-3.5 w-3.5" />}
      >
        <FormField label="Visibility" hint="Who can see this listing.">
          <SelectInput
            value={state.visibilityMode}
            onChange={(e) =>
              set({ visibilityMode: e.target.value as UnitFormState["visibilityMode"] })
            }
          >
            <option value="PUBLIC">Public — every agent sees it (with optional exceptions)</option>
            <option value="RESTRICTED">Restricted — invisible to all agents until granted</option>
          </SelectInput>
        </FormField>
        {state.visibilityMode === "PUBLIC" ? (
          <FormField
            label="Hidden from (optional)"
            hint="These agents won't see this listing. Everyone else will."
          >
            <AgentMultiSelect
              selectedIds={state.hiddenFromPartyIds}
              selectedNames={state.hiddenFromPartyNames}
              onChange={({ ids, names }) =>
                set({ hiddenFromPartyIds: ids, hiddenFromPartyNames: names })
              }
            />
          </FormField>
        ) : (
          <FormField
            label="Visible to"
            hint="Only these agents will see this listing. Leaving empty means nobody can see it."
          >
            <AgentMultiSelect
              selectedIds={state.grantedPartyIds}
              selectedNames={state.grantedPartyNames}
              onChange={({ ids, names }) =>
                set({ grantedPartyIds: ids, grantedPartyNames: names })
              }
            />
          </FormField>
        )}
      </FormSection>
      )}
      {/* Section: Pax deduction — hidden on the Partition create path; the
          batch endpoint has no per-room pax-deduction field. */}
      {!hidePartitionOrphanFields && (
      <CollapsibleSection
        title="Pax deduction"
        tone="rose"
        icon={<Percent className="h-3.5 w-3.5" />}
        defaultOpen={state.hasPaxDeduction}
        summary={
          state.hasPaxDeduction
            ? state.paxDeductionAmount
              ? `RM ${state.paxDeductionAmount} per pax`
              : "On"
            : "Off — no per-pax deduction"
        }
      >
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.hasPaxDeduction}
            onChange={(e) => set({ hasPaxDeduction: e.target.checked })}
            className="mt-1 h-4 w-4 rounded border-[var(--input-border)] accent-[var(--primary)]"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">Pax-based rent deduction applies</span>
            <span className="block text-xs text-muted-foreground">
              When enabled, commissions are calculated on rental net of (pax × deduction). Property-scoped
              setting — applies to every unit in this property.
            </span>
          </span>
        </label>
        {state.hasPaxDeduction && (
          <FormField label="Deduction per pax" hint="RM subtracted from monthly rental, per occupant.">
            <TextInput
              type="number"
              min={0}
              step="0.01"
              value={state.paxDeductionAmount}
              onChange={(e) => set({ paxDeductionAmount: e.target.value })}
              placeholder="50"
              className={parsedDeductionInvalid ? "border-rose-500/60 focus:ring-rose-500/40" : undefined}
            />
          </FormField>
        )}
      </CollapsibleSection>
      )}

      {/* Section: Deposits & parking (inventory upload extension).
          Partition (Create): deposits, access cards and parking are per-room and
          live on the strip below, so this apartment-level section is hidden to
          avoid a duplicate the submit path ignores. */}
      {!hidePerRoomFields && (
      <FormSection
        title="Deposits & parking"
        tone="gold"
        id="unitsec-deposits"
        icon={<Wallet className="h-3.5 w-3.5" />}
      >
        <DepositFields
          rentalRate={state.rentalRate === "" ? null : Number(state.rentalRate)}
          // Occupied ⇒ deposits follow the TENANCY's rent, not the asking rate.
          // `state.monthlyRent` is the same field the first-invoice/commission preview
          // prices off (seeded from activeTenancy.monthlyRentAmount), so the deposit rows
          // and that card can no longer quote two different rents for one tenant.
          // Non-occupied, blank, or non-numeric ⇒ undefined ⇒ asking-rate basis, unchanged.
          tenancyMonthlyRent={
            state.occupancyStatus === "occupied" &&
            state.monthlyRent !== "" &&
            Number.isFinite(Number(state.monthlyRent))
              ? Number(state.monthlyRent)
              : undefined
          }
          depositMonths={state.depositMonths === "" ? null : Number(state.depositMonths)}
          utilitiesDepositMonths={
            state.utilitiesDepositMonths === "" ? null : Number(state.utilitiesDepositMonths)
          }
          accessCardDepositPerPcs={
            state.accessCardDepositPerPcs === "" ? null : Number(state.accessCardDepositPerPcs)
          }
          accessCardQuantity={
            state.accessCardQuantity === "" ? null : Number(state.accessCardQuantity)
          }
          onChange={(patch) => {
            const next: Partial<UnitFormState> = {};
            if (patch.depositMonths !== undefined) {
              next.depositMonths =
                patch.depositMonths === null ? "" : String(patch.depositMonths);
            }
            if (patch.utilitiesDepositMonths !== undefined) {
              next.utilitiesDepositMonths =
                patch.utilitiesDepositMonths === null
                  ? ""
                  : String(patch.utilitiesDepositMonths);
            }
            if (patch.accessCardDepositPerPcs !== undefined) {
              next.accessCardDepositPerPcs =
                patch.accessCardDepositPerPcs === null
                  ? ""
                  : String(patch.accessCardDepositPerPcs);
            }
            if (patch.accessCardQuantity !== undefined) {
              next.accessCardQuantity =
                patch.accessCardQuantity === null ? "" : String(patch.accessCardQuantity);
            }
            set(next);
          }}
        />
        <ParkingFields
          parkingQuantity={state.parkingQuantity === "" ? null : Number(state.parkingQuantity)}
          parkingNumbers={state.parkingNumbers}
          monthlyRates={state.parkingMonthlyRates}
          onChange={(patch) =>
            set({
              parkingQuantity:
                patch.parkingQuantity === null ? "" : String(patch.parkingQuantity),
              parkingNumbers: patch.parkingNumbers,
              parkingMonthlyRates: patch.monthlyRates ?? state.parkingMonthlyRates,
            })
          }
        />
      </FormSection>
      )}

      {/* Section: Description & amenities */}
      <FormSection
        title="Description & amenities"
        id="unitsec-desc"
        icon={<FileText className="h-3.5 w-3.5" />}
      >
        <FormField label="Amenities" hint="Pick from your organization's catalog.">
          <AmenityCombobox
            value={state.amenities}
            onChange={(amenities) => set({ amenities })}
            catalog={amenitiesQuery.data ?? []}
            disabled={amenitiesQuery.isLoading}
          />
        </FormField>
        <FormField
          label="Highlights"
          hint="Free-form selling points specific to this apartment — “Near KLCC”, “Corner unit”, “Renovated 2025”. Visible on listing cards, included in search. For standardized features like Pool or Gym, use Amenities above."
        >
          <TagInput
            values={state.highlights}
            onChange={(highlights) => set({ highlights })}
            placeholder="Near KLCC, Corner unit…"
          />
        </FormField>
        <FormField label="Description">
          <TextAreaInput
            value={state.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Sunny corner unit with panoramic city view…"
            rows={4}
          />
        </FormField>
      </FormSection>
    </div>
  );
}

/**
 * Opt-ins for fields only the CREATE dialog may send. They default to off, so
 * `unitFormToApiPayload(state)` — the call the per-room EDIT dialog makes —
 * emits exactly the payload it emitted before these fields existed.
 *
 * Owner and billing model are apartment-scoped: PUT /units/:id ignores neither
 * safely, and re-pointing either belongs to the audited fan-out writer behind
 * "Edit shared details". Rent is flag-gated on update and unconditional on
 * create, so it cannot be a single shared branch either.
 */
export type UnitFormPayloadOptions = {
  includeOwner?: boolean;
  includeBillingMode?: boolean;
  includeTnbSubsidyCap?: boolean;
  includeRent?: boolean;
};

// Convert form state to API payload. Used by both Create + Edit submit
// handlers — keeps the string-vs-number coercion in one place.
export function unitFormToApiPayload(
  state: UnitFormState,
  options: UnitFormPayloadOptions = {},
) {
  const num = (s: string): number | undefined => {
    if (s === "") return undefined;
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  };
  // Bedroom/bathroom/floor-area are room counts and square-feet — integers.
  // Round here so a stray decimal (paste, legacy data, manual typing past the
  // step constraint) doesn't propagate into storage.
  const numInt = (s: string): number | undefined => {
    const n = num(s);
    return n === undefined ? undefined : Math.round(n);
  };
  return {
    unitCode: state.unitCode,
    unitType: state.unitType,
    bedrooms: numInt(state.bedrooms),
    bathrooms: numInt(state.bathrooms),
    floor: numInt(state.floor),
    floorArea: numInt(state.floorArea),
    rentalRate: num(state.rentalRate),
    occupancyStatus: state.occupancyStatus || undefined,
    listingStatus: state.listingStatus || undefined,
    inChargePartyId: state.inChargePartyId,
    sourcingAgentId: state.sourcingAgentId,
    // Source is DERIVED solely from sourcingAgentId. In-charge is a
    // separate concept (who manages the listing day-to-day) and may be an
    // editor / admin / manager / agent; it does NOT drive Source. Client
    // clarification 2026-05-24: a listing is "Agent sourced" iff a
    // Sourcing-agent is assigned — even an agent in-charge keeps the
    // listing as Company unless someone is also named as the sourcing
    // agent. The backend ignores this field on write (`void _sourceFlag`)
    // and re-derives on read from row.sourcingAgentId, so this client-side
    // value is purely informational.
    sourceFlag: state.sourcingAgentId !== null ? "AGENT_SOURCED" : "COMPANY",
    visibilityMode: state.visibilityMode,
    // Send each list in the mode that uses it; force the other to [] so a
    // mode flip clears the stale audience from the previous mode.
    hiddenFromPartyIds:
      state.visibilityMode === "PUBLIC" ? state.hiddenFromPartyIds : [],
    grantedPartyIds:
      state.visibilityMode === "RESTRICTED" ? state.grantedPartyIds : [],
    amenities: state.amenities,
    highlights: state.highlights,
    description: state.description || null,
    hasPaxDeduction: state.hasPaxDeduction,
    paxDeductionAmount: state.hasPaxDeduction ? num(state.paxDeductionAmount) ?? null : null,
    // Deposits — undefined when blank so the server schema's optional() leaves
    // the column null rather than coercing 0. Rental deposit supports half
    // months (DECIMAL(4,2) in the DB) — must NOT round through numInt or 2.5
    // gets silently flipped to 3 on save.
    depositMonths: num(state.depositMonths),
    utilitiesDepositMonths: num(state.utilitiesDepositMonths),
    accessCardDepositPerPcs: num(state.accessCardDepositPerPcs),
    accessCardQuantity: numInt(state.accessCardQuantity),
    // Parking — quantity may be undefined; numbers always sends an array (so a
    // user clearing the list wipes the column instead of leaving stale values).
    parkingQuantity: numInt(state.parkingQuantity),
    parkingNumbers: state.parkingNumbers,
    // Tenancy — only sent when occupancyStatus is "occupied" so a status
    // change to "vacant" doesn't accidentally persist stale tenant data.
    // tenantName is display-only (confirm card); only the id goes on the wire.
    ...(state.occupancyStatus === "occupied"
      ? {
          tenantPartyId: state.tenantPartyId ?? undefined,
          moveInDate: state.moveInDate,
          moveOutDate: state.moveOutDate,
          // Explicit rent for a NEW tenancy. On UPDATE this is only sent under
          // the flag (mirrors syncOccupancyTenancy's server-side gate; flag off
          // the server's rentalRate-default behaviour stays byte-identical to
          // pre-fix). On CREATE it is always sent: createUnitService resolves
          // `monthlyRent ?? rentalRate` and rejects a non-positive result in
          // every flag state.
          ...(options.includeRent ||
          isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY")
            ? { monthlyRent: num(state.monthlyRent) }
            : {}),
          tenancyAgreementFeeAmount: num(state.tenancyAgreementFeeAmount),
          tenancyAgreementFeeDueDate: state.tenancyAgreementFeeDueDate || undefined,
          // Commission toggles — gated on the same flag as the checkbox that
          // sets them (flag off → checkbox absent → nothing sent → server keeps
          // its false/owner defaults, byte-identical to today).
          ...(isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY")
            ? {
                firstMonthIsCommission: state.firstMonthIsCommission,
                commissionSstBearer: state.commissionSstBearer,
              }
            : {}),
        }
      : {}),
    // Apartment-scoped, create-only. The per-room save path omits both: owner
    // is re-pointed exclusively through "Edit shared details", and a billing
    // model left untouched ("") must not collide with the apartment's own.
    ...(options.includeOwner ? { ownerPartyId: state.ownerPartyId ?? undefined } : {}),
    ...(options.includeBillingMode && state.partitionBillingMode
      ? { partitionBillingMode: state.partitionBillingMode }
      : {}),
    ...(options.includeTnbSubsidyCap
      ? {
          tnbSubsidyCapMonthly:
            state.tnbSubsidyCapMonthly.trim() === ""
              ? null
              : num(state.tnbSubsidyCapMonthly),
        }
      : {}),
  };
}
