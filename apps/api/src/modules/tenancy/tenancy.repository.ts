import { getDb } from "@kason/db";

function toNumber(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

export async function listLandlordTenancies(orgId: string) {
  const db = getDb();
  const rows = await db.landlordTenancy.findMany({
    where: { organizationId: orgId },
    include: {
      property: { select: { id: true, name: true } },
      landlord: { select: { id: true, displayName: true } },
    },
    orderBy: [{ startDate: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    landlordId: row.landlordId,
    landlordName: row.landlord.displayName,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate ? row.endDate.toISOString() : null,
    monthlyRent: toNumber(row.monthlyRent) ?? 0,
    depositAmount: toNumber(row.depositAmount),
    status: row.status,
    notes: row.notes,
  }));
}

export async function findProperty(orgId: string, propertyId: string) {
  const db = getDb();
  return db.property.findFirst({ where: { id: propertyId, organizationId: orgId }, select: { id: true } });
}

export async function findOwnerRole(orgId: string, landlordId: string) {
  const db = getDb();
  return db.partyRole.findFirst({
    where: { organizationId: orgId, partyId: landlordId, roleType: "owner" },
    select: { id: true },
  });
}

export async function createLandlordTenancy(params: {
  organizationId: string;
  propertyId: string;
  landlordId: string;
  startDate: Date;
  endDate: Date | null;
  monthlyRent: number;
  depositAmount: number | null;
  status: string;
  notes: string | null;
}) {
  const db = getDb();
  return db.landlordTenancy.create({
    data: params,
    select: { id: true },
  });
}

export async function findLandlordTenancy(orgId: string, landlordTenancyId: string) {
  const db = getDb();
  return db.landlordTenancy.findFirst({
    where: { organizationId: orgId, id: landlordTenancyId },
    select: { id: true },
  });
}

export async function updateLandlordTenancy(landlordTenancyId: string, data: Record<string, unknown>) {
  const db = getDb();
  await db.landlordTenancy.update({ where: { id: landlordTenancyId }, data });
}

export async function listTenancies(orgId: string) {
  const db = getDb();
  const rows = await db.tenancy.findMany({
    where: { organizationId: orgId },
    include: {
      property: { select: { id: true, name: true } },
      unit: { select: { id: true, apartment: { select: { unitCode: true } } } },
      tenantParty: { select: { id: true, displayName: true } },
      charges: {
        where: { chargeType: "renewal_fee", status: { not: "void" } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          chargeNumber: true,
          parentChargeId: true,
          amount: true,
          dueDate: true,
          status: true,
          outstandingAmount: true,
        },
      },
    },
    orderBy: [{ startDate: "desc" }],
  });

  return rows.map((row) => {
    const renewalBase = row.charges.find((charge) => charge.parentChargeId === null);
    const renewalTax = renewalBase
      ? row.charges.find((charge) =>
          charge.parentChargeId === renewalBase.id
          && charge.chargeNumber === `${renewalBase.chargeNumber}-SST`,
        )
      : undefined;
    const renewalAmount = renewalBase
      ? (toNumber(renewalBase.amount) ?? 0) + (renewalTax ? toNumber(renewalTax.amount) ?? 0 : 0)
      : 0;
    const renewalOutstanding = renewalBase
      ? (toNumber(renewalBase.outstandingAmount) ?? 0)
        + (renewalTax ? toNumber(renewalTax.outstandingAmount) ?? 0 : 0)
      : 0;
    const renewalStatus = renewalBase && renewalTax && renewalBase.status !== renewalTax.status
      ? "partially_paid"
      : renewalBase?.status;

    return {
      id: row.id,
      tenancyCode: row.tenancyCode,
      propertyId: row.propertyId,
      propertyName: row.property.name,
      unitId: row.unitId,
      unitCode: row.unit.apartment.unitCode,
      tenantPartyId: row.tenantPartyId,
      tenantName: row.tenantParty.displayName,
      status: row.status,
      billingStatus: row.billingStatus,
      startDate: row.startDate.toISOString(),
      endDate: row.endDate ? row.endDate.toISOString() : null,
      monthlyRentAmount: toNumber(row.monthlyRentAmount) ?? 0,
      // First-month KAEN commission. Additive: carried here so a caller holding a
      // tenancy row (e.g. the Assign-to-Unit dialog reopened for a tenant who is
      // already assigned) can SHOW the stored commission state instead of falling
      // back to a blank form's default `false` — the create-form default reading
      // as "it wasn't saved" is exactly the bug this closes.
      firstMonthIsCommission: row.firstMonthIsCommission,
      commissionSstBearer: row.commissionSstBearer as "owner" | "kaen",
      previousTenancyId: row.previousTenancyId,
      renewalDecision: row.renewalDecision,
      renewalDecisionAt: row.renewalDecisionAt?.toISOString() ?? null,
      renewalContactedAt: row.renewalContactedAt?.toISOString() ?? null,
      renewalNotes: row.renewalNotes,
      renewalFeeCharge: renewalBase
        ? {
            id: renewalBase.id,
            amount: renewalAmount,
            outstandingAmount: renewalOutstanding,
            dueDate: renewalBase.dueDate.toISOString(),
            status: renewalStatus ?? renewalBase.status,
          }
        : null,
    };
  });
}

export async function findUnit(orgId: string, unitId: string) {
  const db = getDb();
  const listing = await db.listing.findFirst({
    where: { id: unitId, organizationId: orgId },
    select: {
      id: true,
      ownerPartyId: true,
      // Deposit basis for createTenancyService's depositAmount derivation. Read
      // here rather than in a second query — this lookup already loads the row.
      depositMonths: true,
      rentalRate: true,
      apartment: { select: { propertyId: true } },
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    propertyId: listing.apartment.propertyId,
    ownerPartyId: listing.ownerPartyId,
    depositMonths: listing.depositMonths == null ? null : Number(listing.depositMonths.toString()),
    rentalRate: listing.rentalRate == null ? null : Number(listing.rentalRate.toString()),
  };
}

export async function findTenantRole(orgId: string, tenantPartyId: string) {
  const db = getDb();
  return db.partyRole.findFirst({ where: { organizationId: orgId, partyId: tenantPartyId, roleType: "tenant" }, select: { id: true } });
}

export async function findTenancyByCode(orgId: string, tenancyCode: string) {
  const db = getDb();
  return db.tenancy.findFirst({ where: { organizationId: orgId, tenancyCode }, select: { id: true } });
}

export async function findReservationRent(orgId: string, reservationId: string) {
  const db = getDb();
  const r = await db.unitReservation.findFirst({
    where: { id: reservationId, organizationId: orgId },
    select: { agreedMonthlyRent: true, tenantPartyId: true, status: true, unitId: true },
  });
  if (!r || r.agreedMonthlyRent == null) return null;
  return { agreedMonthlyRent: r.agreedMonthlyRent.toString(), tenantPartyId: r.tenantPartyId, status: r.status, unitId: r.unitId };
}

export async function findTenancy(orgId: string, tenancyId: string) {
  const db = getDb();
  return db.tenancy.findFirst({
    where: { organizationId: orgId, id: tenancyId },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      tenantPartyId: true,
      status: true,
      startDate: true,
      firstMonthIsCommission: true,
      commissionSstBearer: true,
      depositDeductions: true,
      depositRefundAmount: true,
    },
  });
}

export async function updateTenancy(tenancyId: string, data: Record<string, unknown>) {
  const db = getDb();
  await db.tenancy.update({ where: { id: tenancyId }, data });
}

export function endDateBeforeRenewalStart(newStartDate: Date): Date {
  const previousEndDate = new Date(newStartDate);
  previousEndDate.setUTCDate(previousEndDate.getUTCDate() - 1);
  return previousEndDate;
}

export async function renewTenancyTx(params: {
  existingTenancyId: string;
  newStartDate: Date;
  organizationId: string;
  propertyId: string;
  unitId: string;
  tenantPartyId: string;
  newTenancyCode: string;
  newEndDate: Date | null;
  monthlyRentAmount: number;
}) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // Tenancy dates are inclusive. A renewal that starts on 25 August means the
    // previous agreement ends on 24 August; storing both boundaries as the 25th
    // charges that calendar day twice when the billing grid aggregates the two
    // tenancy records (32/31 of a month). Keep the chain adjacent, never
    // overlapping.
    const previousEndDate = endDateBeforeRenewalStart(params.newStartDate);
    await tx.tenancy.update({
      where: { id: params.existingTenancyId },
      data: { status: "expired", endDate: previousEndDate },
    });

    return tx.tenancy.create({
      data: {
        organizationId: params.organizationId,
        propertyId: params.propertyId,
        unitId: params.unitId,
        tenantPartyId: params.tenantPartyId,
        tenancyCode: params.newTenancyCode,
        status: "active",
        billingStatus: "active",
        startDate: params.newStartDate,
        endDate: params.newEndDate,
        monthlyRentAmount: params.monthlyRentAmount,
        previousTenancyId: params.existingTenancyId,
      },
      select: { id: true },
    });
  });
}
