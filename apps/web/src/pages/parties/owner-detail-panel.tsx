/**
 * OwnerDetailPanel — expand-in-place detail view for a single owner.
 *
 * Rendered inside a full-width expansion row in the Owners tab
 * (see `owners-table.tsx`). Wraps the shared `PartyDetailPanel` shell
 * and composes DetailField groups:
 *
 *   Identity   — IC (audited reveal via IcRevealField), gender, DOB, nationality
 *   Contact    — email, phone (formattedPhone), WhatsApp
 *   Banking    — bank name, account holder, account number
 *   Portfolio  — units owned codes; when ENABLE_PHASE2_OWNER_BILLING is ON:
 *                compact active management-fee summary + links to statements/ledger;
 *                admins also get a "Set up billing" / "Edit fee" affordance (R1)
 *   Status     — status pill, blacklisted flag + reason, created date
 *
 * The Edit button opens `EditOwnerDialog` (same dialog used from the ⋯ menu).
 * Null fields display "—".
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { StatusPill } from "@/components/ui";
import { formatDate, formatRM, getStatusTone } from "@/components/format";
import { DetailField } from "@/pages/tenancy/tenant-tracker/row-parts";
import { displayPhone } from "@/pages/tenancy/tenant-tracker/phone-display";
import { useOwnerDetail } from "@/api/parties-detail";
import { useFeeConfigs } from "@/api/owner-billing";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { usePermission } from "@/components/permission-gate";
import { apiFetch } from "@/lib/api-client";
import { FeeConfigDrawer } from "@/pages/settings/sections/owner-billing/fee-config-drawer";
import { PartyDetailPanel, IcRevealField } from "./party-detail-panel";
import { EditOwnerDialog } from "./owners-action-dialogs";
import { PortalAccessSection } from "./portal-access-section";
import type { OwnerListItem } from "./owners-table";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Group deduped owned apartments by property so the Portfolio shows each
 * property once with its unit codes listed under it — instead of a flat,
 * property-less run of codes. `unitsOwned` is already deduped + sorted
 * (by property, then unit code) server-side in findUnitsOwned; a Map keeps
 * that insertion order.
 */
function groupUnitsByProperty(
  units: { unitCode: string; propertyName: string }[],
): { propertyName: string; unitCodes: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const u of units) {
    const codes = groups.get(u.propertyName) ?? [];
    codes.push(u.unitCode);
    groups.set(u.propertyName, codes);
  }
  return [...groups.entries()].map(([propertyName, unitCodes]) => ({ propertyName, unitCodes }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OwnerDetailPanel({ partyId }: { partyId: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isLoading, isError, data, error } = useOwnerDetail(partyId, true);
  const isOwnerBilling = isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING");

  // Project OwnerDetail → OwnerListItem for EditOwnerDialog.
  // Only built when data is loaded; null while loading or on error.
  const ownerForDialog: OwnerListItem | null = data
    ? {
        id: data.id,
        displayName: data.displayName,
        legalName: data.legalName,
        primaryEmail: data.primaryEmail,
        primaryPhone: data.primaryPhone,
        formattedPhone: data.formattedPhone,
        nationality: data.nationality,
        status: data.status,
        isBlacklisted: data.isBlacklisted,
        createdAt: data.createdAt,
        bankName: data.bank.name,
        bankAccountHolder: data.bank.accountHolder,
        bankAccountNumber: data.bank.accountNumber,
        idType: data.idType,
        // Detail endpoint returns masked IC only (raw IC never leaves the server except
        // via the audited reveal). The Edit dialog has no IC field, so pass null — never
        // the masked string, which must not be mistaken for a real IC.
        idNumber: null,
        blacklistReason: data.blacklistReason,
        // deletable is a list-endpoint field (server-computed). The Edit dialog
        // within the detail panel never deletes, so we pass false safely.
        deletable: false,
      }
    : null;

  const errorMsg = isError
    ? error instanceof Error
      ? error.message
      : "Failed to load owner details"
    : null;

  return (
    <>
      <PartyDetailPanel
        loading={isLoading}
        error={errorMsg}
        onEdit={() => setEditOpen(true)}
        editLabel="Edit Owner"
      >
        {data && (
          <>
            {/* ── Identity ───────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Identity
              </p>
              <div className="grid grid-cols-2 gap-3">
                <IcRevealField partyId={partyId} masked={data.idNumberMasked} />
                <DetailField label="Gender">{data.gender ?? "—"}</DetailField>
                <DetailField label="Date of birth">
                  {data.dateOfBirth ? formatDate(data.dateOfBirth) : "—"}
                </DetailField>
                <DetailField label="Nationality">{data.nationality ?? "—"}</DetailField>
              </div>
            </div>

            {/* ── Contact ────────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Contact
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Email">{data.primaryEmail ?? "—"}</DetailField>
                <DetailField label="Phone">{data.formattedPhone ?? "—"}</DetailField>
                <DetailField label="WhatsApp">
                  {data.whatsappPhone ? displayPhone(data.whatsappPhone) : "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Employment ─────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Employment
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Occupation">{data.occupation ?? "—"}</DetailField>
                <DetailField label="Employer">{data.employerName ?? "—"}</DetailField>
                <DetailField label="Employer address">
                  {data.employerAddress ?? "—"}
                </DetailField>
                <DetailField label="Monthly income">
                  {data.monthlyIncome != null
                    ? formatRM(parseFloat(data.monthlyIncome))
                    : "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Emergency ──────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Emergency contact
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Name">{data.emergencyContactName ?? "—"}</DetailField>
                <DetailField label="Phone">{data.emergencyContactPhone ?? "—"}</DetailField>
                <DetailField label="Relation">
                  {data.emergencyContactRelation ?? "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Banking ────────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Banking
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Bank">{data.bank.name ?? "—"}</DetailField>
                <DetailField label="Account holder">{data.bank.accountHolder ?? "—"}</DetailField>
                <DetailField label="Account number">{data.bank.accountNumber ?? "—"}</DetailField>
              </div>
            </div>

            {/* ── Portfolio ──────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Portfolio
              </p>
              <div className="space-y-2">
                <DetailField label="Units owned">
                  {data.unitsOwned.length > 0 ? (
                    <div className="space-y-1.5">
                      {groupUnitsByProperty(data.unitsOwned).map((g) => (
                        <div key={g.propertyName}>
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {g.propertyName}
                          </span>
                          <span className="block text-sm text-foreground">
                            {g.unitCodes.join(", ")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    "No units"
                  )}
                </DetailField>
                {isOwnerBilling && (
                  <>
                    <OwnerFeeSummary
                      partyId={partyId}
                      ownerName={data.displayName}
                      units={data.unitsOwned}
                    />
                    {/* The "Owner Statements" link went with that page — the
                        Owner Ledger below is the front door for both now. */}
                    <div className="flex gap-4 text-sm">
                      <Link
                        to={`/tenancy/owner-ledger/${partyId}`}
                        className="text-[var(--gold)] hover:underline"
                      >
                        Owner Ledger
                      </Link>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Portal Access ───────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Portal Access
              </p>
              <PortalAccessSection
                partyId={partyId}
                kind="owner"
                portalUser={data.portalUser}
                defaultEmail={data.primaryEmail}
                defaultFullName={data.displayName}
              />
            </div>

            {/* ── Status ─────────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Status
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Status">
                  <StatusPill tone={getStatusTone(data.status)}>{data.status}</StatusPill>
                </DetailField>
                <DetailField label="Blacklisted">
                  <StatusPill tone={data.isBlacklisted ? "rose" : "emerald"}>
                    {data.isBlacklisted ? "yes" : "no"}
                  </StatusPill>
                </DetailField>
                {data.isBlacklisted && data.blacklistReason && (
                  <DetailField label="Blacklist reason">{data.blacklistReason}</DetailField>
                )}
                <DetailField label="Created">{formatDate(data.createdAt)}</DetailField>
              </div>
            </div>
          </>
        )}
      </PartyDetailPanel>

      {/* EditOwnerDialog — rendered outside PartyDetailPanel so it isn't
          inside the detail grid; open state is controlled by the Edit button. */}
      {ownerForDialog && (
        <EditOwnerDialog
          owner={ownerForDialog}
          open={editOpen}
          onOpenChange={(open) => {
            if (!open) {
              void queryClient.invalidateQueries({ queryKey: ["parties", "owners", partyId] });
            }
            setEditOpen(open);
          }}
        />
      )}
    </>
  );
}

// ── OwnerFeeSummary ───────────────────────────────────────────────────────────

/**
 * Compact active management-fee summary for the Portfolio group, plus an
 * admin-only "Set up billing" / "Edit fee" affordance (R1).
 *
 * Only rendered when `ENABLE_PHASE2_OWNER_BILLING` is ON (caller's gate). The
 * fee line hides itself when there is no active config or the fetch errors;
 * it's expressed as "{value}% + {sst}% SST" for percent-type configs or
 * "RM {value} + {sst}% SST" for fixed-type configs.
 *
 * Admins (`getStoredUser()?.role === "admin"`) additionally see a button —
 * "Edit fee" when an active config exists, "Set up billing" otherwise — that
 * opens the existing `FeeConfigDrawer` with the owner pre-selected and locked
 * (`lockedOwner`), so the write can never be misattributed to another owner.
 * Managers see the read-only summary only. The write still flows through the
 * existing admin-gated POST/PATCH /owner-billing/fee-configs endpoints.
 */
function OwnerFeeSummary({
  partyId,
  ownerName,
  units,
}: {
  partyId: string;
  ownerName: string;
  units: { apartmentId: string; unitCode: string; propertyName: string }[];
}) {
  const { data, isError } = useFeeConfigs({ ownerPartyId: partyId, isActive: "true" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"create" | "edit">("create");
  const canConfigureManagementFee = usePermission("management_fee.configure");
  const activeConfigs = !isError ? data?.data?.items?.filter((c) => c.isActive) ?? [] : [];
  const activeConfig = activeConfigs.find((c) => !c.apartmentId) ?? activeConfigs[0];
  const unitConfigCount = activeConfigs.filter((c) => Boolean(c.apartmentId)).length;

  // Properties for the drawer's per-property override escape hatch. Only
  // fetched for admins (the only ones who can open the drawer).
  const propertiesQuery = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/inventory/properties"),
    enabled: canConfigureManagementFee,
  });

  const feeLabel = activeConfig
    ? activeConfig.feeType === "percent"
      ? `${activeConfig.feeValue}%${activeConfig.sstPercent ? ` + ${activeConfig.sstPercent}% SST` : ""}`
      : activeConfig.feeType === "fixed"
        ? `RM ${activeConfig.feeValue}${activeConfig.sstPercent ? ` + ${activeConfig.sstPercent}% SST` : ""}`
        : activeConfig.feeValue
    : null;

  return (
    <div className="space-y-1.5">
      {feeLabel && <DetailField label="Management fee default">{feeLabel}</DetailField>}
      {unitConfigCount > 0 && (
        <DetailField label="Unit fee overrides">{unitConfigCount}</DetailField>
      )}
      {canConfigureManagementFee && (
        <>
          <button
            type="button"
            onClick={() => {
              setDrawerMode(activeConfig ? "edit" : "create");
              setDrawerOpen(true);
            }}
            className="text-sm text-[var(--gold)] hover:underline"
          >
            {activeConfig ? "Edit fee" : "Set up billing"}
          </button>
          {activeConfig && units.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setDrawerMode("create");
                setDrawerOpen(true);
              }}
              className="ml-3 text-sm text-[var(--gold)] hover:underline"
            >
              Add unit fee
            </button>
          )}
          <FeeConfigDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            mode={drawerMode}
            config={drawerMode === "edit" ? activeConfig : undefined}
            owners={[]}
            properties={(propertiesQuery.data?.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
            units={units}
            lockedOwner={{ id: partyId, displayName: ownerName }}
          />
        </>
      )}
    </div>
  );
}
