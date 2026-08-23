import { generateTenancyCodeTx } from "../tenancy/tenancy-code-generator";
import { releaseAssignmentsForTenancyTx } from "../carpark/carpark-assignment.service";
import { createInvoiceTx, recomputeInvoiceTotalTx } from "../billing/auto-draft.repository";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { splitInclusiveSst, TENANCY_AGREEMENT_SST_RATE } from "@kason/shared";

export type SyncOccupancyTenancyParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  orgId: string;
  unit: {
    id: string;
    propertyId: string;
    occupancyStatus: string;
    rentalRate: number | null;
    // Phase-2 owner re-point: a Tenancy may only be materialised for a unit that
    // has an assigned owner (owner now drives money attribution). null → blocked.
    ownerPartyId: string | null;
  };
  incoming: {
    occupancyStatus?: string;
    tenantPartyId?: string;
    moveInDate?: Date;
    moveOutDate?: Date;
    // Explicit rent for a NEW tenancy materialised via the occupancy picker.
    // Under ENABLE_PHASE2_RESERVATION_GATED_TENANCY this is REQUIRED (> 0) --
    // no silent default to unit.rentalRate (R6; that silent inheritance
    // produced the original wrong-rent incident). Flag off: ignored, today's
    // rentalRate-default behaviour wins.
    monthlyRent?: number;
    // First-month-commission toggles (Phase 1, display-only). Persisted onto the
    // tenancy this materialises. On CREATE they default to false/"owner"; on the
    // same-tenant in-place update they are written ONLY when supplied (undefined
    // leaves the stored value untouched). The caller enforces the write-once /
    // editor guard BEFORE the transaction (assertCommissionWritable).
    firstMonthIsCommission?: boolean;
    commissionSstBearer?: "owner" | "kaen";
    tenancyAgreementFeeAmount?: number;
    tenancyAgreementFeeDueDate?: Date;
  };
};

// Materializes Unit.occupancyStatus="occupied" into a real Tenancy row.
// Called from updateUnitService inside its transaction. See
// docs/superpowers/plans/2026-05-12-occupancy-tenancy-sync.md for the four
// transition cases this handles.
export async function syncOccupancyTenancy(params: SyncOccupancyTenancyParams) {
  const { tx, orgId, unit, incoming } = params;

  const incomingStatus = incoming.occupancyStatus;
  if (incomingStatus === undefined) return;

  // Going Occupied → not-Occupied: close the active tenancy if any.
  if (incomingStatus !== "occupied") {
    if (unit.occupancyStatus === "occupied") {
      const active = await tx.tenancy.findFirst({
        where: { organizationId: orgId, unitId: unit.id, status: "active" },
        select: { id: true, tenantPartyId: true },
      });
      if (active) {
        await tx.tenancy.update({
          where: { id: active.id },
          data: { status: "ended", endDate: new Date() },
        });
        // Release the ended tenancy's carpark bays in the same tx.
        await releaseAssignmentsForTenancyTx(tx, orgId, active.id, new Date());
      }
    }
    return;
  }

  // Defense-in-depth: the shared/zod refiner enforces this at the API
  // boundary, but any internal caller that bypasses the schema would
  // otherwise hit a confusing crash deep inside Prisma. Throw clearly here.
  if (!incoming.tenantPartyId || !incoming.moveInDate || !incoming.moveOutDate) {
    throw new Error(
      "syncOccupancyTenancy: tenantPartyId, moveInDate, moveOutDate are required when occupancyStatus='occupied'",
    );
  }

  // incomingStatus === "occupied": link by tenantPartyId, then create or
  // update Tenancy. The guard above + the upstream Zod refiner (Task 3)
  // ensure the three fields below are present.
  const tenantPartyId = incoming.tenantPartyId!;
  const moveInDate = incoming.moveInDate!;
  const moveOutDate = incoming.moveOutDate!;

  const reservationGatingOn = isPhase2FlagEnabled("ENABLE_PHASE2_RESERVATION_GATED_TENANCY");

  // PICK-EXISTING ONLY: link the chosen party. Validate it is a tenant in
  // this org — never auto-create. A bad id is a caller bug (the picker only
  // surfaces real tenants) → throw rather than silently create.
  let partyId: string;
  if (reservationGatingOn) {
    // R11: validate by ROLE, not partyType. Party.partyType reflects a
    // party's PRIMARY classification (e.g. "owner") and does not preclude it
    // from also holding a tenant PartyRole -- gating on partyType alone would
    // wrongly reject a valid tenant.
    const tenantRole = await tx.partyRole.findFirst({
      where: { organizationId: orgId, partyId: tenantPartyId, roleType: "tenant" },
      select: { id: true },
    });
    if (!tenantRole) {
      // Self-heal a migration-gap tenant: a party already classified as a tenant
      // (partyType="tenant") that predates the reservation-gated model and never
      // had its tenant PartyRole backfilled. Create the role inline instead of
      // surfacing an opaque 500. A party that is NOT a tenant is a genuine caller
      // bug -> preserve the throw.
      const legitTenant = await tx.party.findFirst({
        where: { id: tenantPartyId, organizationId: orgId, partyType: "tenant" },
        select: { id: true },
      });
      if (!legitTenant) {
        throw new Error(
          `syncOccupancyTenancy: tenantPartyId ${tenantPartyId} does not hold a tenant role in this organization`,
        );
      }
      await tx.partyRole.create({
        data: { organizationId: orgId, partyId: tenantPartyId, roleType: "tenant", status: "active" },
      });
      // Loud diagnostic so a recurrence (e.g. prod flag-flip, a new import) is
      // visible in the logs instead of silently self-healing.
      // eslint-disable-next-line no-console
      console.warn(
        `[occupancy-tenancy-sync] self-healed missing tenant PartyRole for party ${tenantPartyId} (org ${orgId}) — pre-reservation-gated tenant data gap`,
      );
    }
    partyId = tenantPartyId;
  } else {
    const tenantParty = await tx.party.findFirst({
      where: { id: tenantPartyId, organizationId: orgId, partyType: "tenant" },
      select: { id: true },
    });
    if (!tenantParty) {
      throw new Error(
        `syncOccupancyTenancy: tenantPartyId ${tenantPartyId} is not a tenant in this organization`,
      );
    }
    partyId = tenantParty.id;
  }

  const activeTenancy = await tx.tenancy.findFirst({
    where: { organizationId: orgId, unitId: unit.id, status: "active" },
    select: { id: true, tenantPartyId: true },
  });

  // Same tenant + still occupied → in-place update (case 2). Rent is never
  // touched here (it never was) -- only dates change.
  if (activeTenancy && activeTenancy.tenantPartyId === partyId) {
    await tx.tenancy.update({
      where: { id: activeTenancy.id },
      data: {
        startDate: moveInDate,
        endDate: moveOutDate,
        // Only when supplied — a dates-only edit must not disturb stored commission.
        ...(incoming.firstMonthIsCommission !== undefined
          ? { firstMonthIsCommission: incoming.firstMonthIsCommission }
          : {}),
        ...(incoming.commissionSstBearer !== undefined
          ? { commissionSstBearer: incoming.commissionSstBearer }
          : {}),
      },
    });
    return;
  }

  // Owner re-point guard: materialising a NEW Tenancy requires the unit to have an
  // assigned owner (owner now drives money attribution — rent/charges/ledger are
  // attributed via Listing.ownerPartyId). Mirrors the createTenancy / reservation
  // no-owner guards. This blocks ONLY the create path; the same-tenant in-place
  // date edit above (renewal-style) and the import path (which does not route
  // through here) stay exempt. The caller (updateUnitService) pre-checks this and
  // returns a structured 409 UNIT_HAS_NO_OWNER; this throw is defence-in-depth for
  // any internal caller that bypasses that pre-check.
  if (!unit.ownerPartyId) {
    throw new Error(
      "syncOccupancyTenancy: cannot create a tenancy for a unit with no assigned owner. Assign an owner before marking the unit occupied.",
    );
  }

  // R6: a NEW Tenancy is about to be materialised -- checked here (not
  // earlier) so the same-tenant in-place date edit above, which never
  // touches rent, is never forced to resend it.
  let monthlyRent: number;
  if (reservationGatingOn) {
    // No silent default to unit.rentalRate -- that silent inheritance
    // produced the original wrong-rent incident. The caller (picker/admin)
    // must state the rent explicitly.
    if (incoming.monthlyRent == null || incoming.monthlyRent <= 0) {
      throw Object.assign(
        new Error(
          "syncOccupancyTenancy: an explicit monthlyRent > 0 is required when creating a tenancy under ENABLE_PHASE2_RESERVATION_GATED_TENANCY (OCCUPANCY_RENT_REQUIRED; no silent default to the unit's rentalRate)",
        ),
        { _occupancyRentRequired: true as const },
      );
    }
    monthlyRent = incoming.monthlyRent;
  } else {
    monthlyRent = unit.rentalRate ?? 0;
  }

  // Different tenant or no existing tenancy → close old (if any), create new.
  if (activeTenancy) {
    await tx.tenancy.update({
      where: { id: activeTenancy.id },
      data: { status: "ended", endDate: new Date() },
    });
    // Release the ended tenancy's carpark bays in the same tx.
    await releaseAssignmentsForTenancyTx(tx, orgId, activeTenancy.id, new Date());
  }

  const tenancyCode = await generateTenancyCodeTx(tx, orgId);
  const created = await tx.tenancy.create({
    data: {
      organizationId: orgId,
      propertyId: unit.propertyId,
      unitId: unit.id,
      tenantPartyId: partyId,
      tenancyCode,
      status: "active",
      billingStatus: "active",
      startDate: moveInDate,
      endDate: moveOutDate,
      monthlyRentAmount: monthlyRent, // starting default for picker-created tenancies; reservation flow (createTenancyService) sets the negotiated rent
      // Explicit write of the same values the DB @default gives, so a flag-off
      // create (no fields supplied) stays byte-identical to today.
      firstMonthIsCommission: incoming.firstMonthIsCommission ?? false,
      commissionSstBearer: incoming.commissionSstBearer ?? "owner",
    },
    select: { id: true },
  });

  const agreementFee = incoming.tenancyAgreementFeeAmount ?? 0;
  // An explicit zero is a reviewable TA decision, not the absence of a charge.
  // Keep it visible as Saved · not billed in the tenancy start month.
  if (incoming.tenancyAgreementFeeAmount !== undefined && agreementFee >= 0) {
    const dueDate = incoming.tenancyAgreementFeeDueDate ?? moveInDate;
    const periodMonth = new Date(Date.UTC(moveInDate.getUTCFullYear(), moveInDate.getUTCMonth(), 1));
    const idempotencyKey = `tenancy-agreement-fee:${created.id}`;
    const category = await tx.chargeCategory.findFirst({
      where: { organizationId: orgId, code: "tenancy_agreement_fee" }, select: { id: true },
    });
    const invoice = await createInvoiceTx(tx, {
      orgId,
      invoiceNumber: `TAF-${created.id}`,
      partyId,
      tenancyId: created.id,
      propertyId: unit.propertyId,
      invoiceType: "tenant_agreement_fee",
      invoiceDate: new Date(),
      dueDate,
      periodMonth,
      idempotencyKey,
    });
    const split = splitInclusiveSst(agreementFee.toFixed(2), TENANCY_AGREEMENT_SST_RATE);
    const baseCharge = await tx.charge.create({
      data: {
        organizationId: orgId, chargeNumber: `TAF-${created.id}`, tenancyId: created.id,
        unitId: unit.id, partyId, categoryId: category?.id ?? null,
        chargeType: "tenancy_agreement_fee", status: "draft", description: "TA (WITH SST)",
        dueDate, amount: split.base, outstandingAmount: split.base,
        sstRate: split.sst === "0.00" ? "0" : TENANCY_AGREEMENT_SST_RATE,
        currency: "MYR", billingMonth: periodMonth, attachmentKeys: [], invoiceId: invoice.id,
        nature: "profit", revenueRecognition: "manager_revenue", settlementRecipient: "manager",
        commercialPurpose: "SERVICE", taxTreatment: "taxable_service", taxRate: TENANCY_AGREEMENT_SST_RATE,
      },
      select: { id: true },
    });
    if (split.sst !== "0.00") {
      await tx.charge.create({
        data: {
          organizationId: orgId, chargeNumber: `TAF-${created.id}-SST`, tenancyId: created.id,
          unitId: unit.id, partyId, categoryId: category?.id ?? null,
          chargeType: "tenancy_agreement_fee", status: "draft", description: `TA (WITH SST) — SST ${TENANCY_AGREEMENT_SST_RATE}%`,
          dueDate, amount: split.sst, outstandingAmount: split.sst, sstRate: "0",
          currency: "MYR", billingMonth: periodMonth, attachmentKeys: [], invoiceId: invoice.id,
          parentChargeId: baseCharge.id, nature: "profit", revenueRecognition: "manager_revenue", settlementRecipient: "manager",
          commercialPurpose: "SERVICE", taxTreatment: "taxable_service", taxRate: TENANCY_AGREEMENT_SST_RATE,
        },
      });
    }
    await recomputeInvoiceTotalTx(tx, orgId, invoice.id);
  }
}

/**
 * Tenancy→Unit occupancy sync — the REVERSE of syncOccupancyTenancy's Unit→Tenancy
 * direction. When a NEW active Tenancy is materialised DIRECTLY (createTenancyService
 * / the Assign-to-Unit dialog / the tenancy-create forms), the Unit's own occupancy
 * columns must be brought into step in the SAME transaction, or the Unit keeps reading
 * occupancyStatus="vacant" with an active tenant on it — the two sources of truth
 * diverge (the reported Assign-to-Unit bug). The edit-unit path does not need this: it
 * writes the Listing itself (via updateUnitService) and only DERIVES the Tenancy.
 *
 * Sets occupied + move-in + readyNow=false. readyNow is an app-derived column
 * (deriveReadyNow, inventory.service.ts): "occupied" ⇒ never ready-now, so a literal
 * false is always correct here and needs no Property/visibility lookup. Deliberately
 * does NOT touch listingStatus / visibilityMode (occupancy and listing are separate
 * axes — product decision) nor vacantSince (read-only everywhere).
 *
 * Org-scoped via updateMany so a foreign-org unitId can never be flipped even by a
 * caller that skipped the upstream findUnit org-check; count!==1 throws and rolls the
 * whole transaction back (atomic: no tenancy row without its Unit flip).
 */
export async function markUnitOccupiedForTenancyTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  unitId: string,
  moveInDate: Date,
): Promise<void> {
  const res = await tx.listing.updateMany({
    where: { id: unitId, organizationId: orgId },
    data: { occupancyStatus: "occupied", moveInDate, readyNow: false },
  });
  if (res.count !== 1) {
    throw new Error(
      `markUnitOccupiedForTenancyTx: expected to occupy exactly 1 unit (${unitId}), updated ${res.count}`,
    );
  }
}
