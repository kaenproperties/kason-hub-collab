import { getDb, type Prisma } from "@kason/db";
import type { BillRoomRow, DbClient } from "./types";

// ── AircondMeter ─────────────────────────────────────────────────────────────
export async function findMeterByUnit(db: DbClient, orgId: string, unitId: string) {
  return db.aircondMeter.findFirst({ where: { organizationId: orgId, unitId } });
}
export async function findActiveMeterByUnit(db: DbClient, orgId: string, unitId: string) {
  return db.aircondMeter.findFirst({ where: { organizationId: orgId, unitId, isActive: true } });
}
export async function findListing(db: DbClient, orgId: string, unitId: string) {
  return db.listing.findFirst({ where: { organizationId: orgId, id: unitId }, select: { id: true, apartmentId: true, updatedAt: true } });
}
// Org-scoped tenancy lookup for the inline pax (billing-headcount) write. Returns
// the current numberOfPax so the audit row can record before/after.
export async function findTenancyInOrg(db: DbClient, orgId: string, tenancyId: string) {
  return db.tenancy.findFirst({ where: { organizationId: orgId, id: tenancyId }, select: { id: true, numberOfPax: true } });
}
export async function createMeter(db: DbClient, data: Prisma.AircondMeterUncheckedCreateInput) {
  return db.aircondMeter.create({ data, select: { id: true } });
}
// Label include (frontend §16): the meter/reading lists render the room by its
// apartment unitCode + listingType, so the query MUST carry that relation.
const UNIT_LABEL_INCLUDE = { unit: { select: { listingType: true, apartment: { select: { unitCode: true } } } } } as const;

export async function listMeters(orgId: string, where: Prisma.AircondMeterWhereInput, take: number, cursorId?: string) {
  return getDb().aircondMeter.findMany({
    where: { ...where, organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: UNIT_LABEL_INCLUDE,
  });
}
export async function getMeter(db: DbClient, orgId: string, id: string) {
  return db.aircondMeter.findFirst({ where: { organizationId: orgId, id } });
}

// ── MeterReading ────────────────────────────────────────────────────────────
export async function findLatestPriorReading(db: DbClient, orgId: string, unitId: string, periodMonth: Date) {
  return db.meterReading.findFirst({
    where: { organizationId: orgId, unitId, periodMonth: { lt: periodMonth } },
    orderBy: { periodMonth: "desc" },
    select: { currentReading: true },
  });
}
export async function createReading(db: DbClient, data: Prisma.MeterReadingUncheckedCreateInput) {
  return db.meterReading.create({ data });
}
export async function getReading(db: DbClient, orgId: string, id: string) {
  return db.meterReading.findFirst({ where: { organizationId: orgId, id } });
}
export async function listReadings(orgId: string, where: Prisma.MeterReadingWhereInput, take: number, cursorId?: string) {
  return getDb().meterReading.findMany({
    where: { ...where, organizationId: orgId },
    orderBy: [{ periodMonth: "desc" }, { id: "asc" }],
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: UNIT_LABEL_INCLUDE,
  });
}

// ── UnitUtilityBill ─────────────────────────────────────────────────────────
export async function findBillByAptPeriod(db: DbClient, orgId: string, apartmentId: string, periodMonth: Date) {
  return db.unitUtilityBill.findFirst({ where: { organizationId: orgId, apartmentId, periodMonth } });
}
export async function createBill(db: DbClient, data: Prisma.UnitUtilityBillUncheckedCreateInput) {
  return db.unitUtilityBill.create({ data });
}
export async function getBill(db: DbClient, orgId: string, id: string) {
  return db.unitUtilityBill.findFirst({ where: { organizationId: orgId, id } });
}
// Thin projection for the attachment gate (attach only needs to know the bill
// exists, which apartment it belongs to, and whether it's still draft) — avoids
// pulling every UnitUtilityBill column just to check status.
export async function getUtilityBillMeta(db: DbClient, orgId: string, id: string) {
  return db.unitUtilityBill.findFirst({ where: { organizationId: orgId, id }, select: { id: true, apartmentId: true, status: true } });
}
export async function getBillWithAllocations(db: DbClient, orgId: string, id: string) {
  return db.unitUtilityBill.findFirst({
    where: { organizationId: orgId, id },
    include: { allocations: { orderBy: { createdAt: "asc" } } },
  });
}
export async function listBills(orgId: string, where: Prisma.UnitUtilityBillWhereInput, take: number, cursorId?: string) {
  return getDb().unitUtilityBill.findMany({
    where: { ...where, organizationId: orgId },
    orderBy: [{ periodMonth: "desc" }, { id: "asc" }],
    take: take + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: { apartment: { select: { unitCode: true } } },
  });
}

// Build the per-room rows for compute: every room of the apartment (no carpark
// Listings exist in the new model), its ACTIVE tenancy (if any), and its reading
// for the period (if any).
export async function findBillRooms(db: DbClient, orgId: string, apartmentId: string, periodMonth: Date): Promise<BillRoomRow[]> {
  const rooms = await db.listing.findMany({
    where: { organizationId: orgId, apartmentId },
    select: {
      id: true,
      occupancyStatus: true,
      listingType: true,
      apartment: { select: { unitCode: true } },
      tenancies: {
        where: { organizationId: orgId, status: "active" },
        select: { id: true, tenantPartyId: true, numberOfPax: true },
        orderBy: { startDate: "desc" },
        take: 1,
      },
    },
  });
  const readings = await db.meterReading.findMany({
    where: { organizationId: orgId, periodMonth, unitId: { in: rooms.map((r) => r.id) } },
    select: { id: true, unitId: true, computedAmount: true, consumption: true, status: true, chargeId: true },
  });
  const byUnit = new Map(readings.map((r) => [r.unitId, r]));
  return rooms.map((r) => {
    const reading = byUnit.get(r.id);
    return {
      unitId: r.id,
      occupancyStatus: r.occupancyStatus,
      unitCode: r.apartment?.unitCode ?? null,
      listingType: r.listingType ?? null,
      tenancy: r.tenancies[0] ? { id: r.tenancies[0].id, tenantPartyId: r.tenancies[0].tenantPartyId, numberOfPax: r.tenancies[0].numberOfPax } : null,
      reading: reading ? { id: reading.id, computedAmount: String(reading.computedAmount), consumption: String(reading.consumption), status: reading.status, chargeId: reading.chargeId } : null,
    };
  });
}

// Per-apartment billing-grid: all rooms with tenancy, active meter, and this
// period's reading. Used by getBillingGridService (read-only; separate from
// findBillRooms which is used by compute and MUST NOT change shape).
export async function findBillingGridRooms(db: DbClient, orgId: string, apartmentId: string, periodMonth: Date) {
  const rooms = await db.listing.findMany({
    where: { organizationId: orgId, apartmentId },
    select: {
      id: true,
      listingType: true,
      apartment: { select: { unitCode: true } },
      tenancies: {
        where: { organizationId: orgId, status: "active" },
        select: {
          id: true,
          numberOfPax: true,
          tenantParty: { select: { displayName: true } },
        },
        orderBy: { startDate: "desc" },
        take: 1,
      },
      aircondMeters: {
        where: { organizationId: orgId, isActive: true },
        select: { id: true, ratePerKwh: true, meterNumber: true },
        take: 1,
      },
    },
  });

  const readings = await db.meterReading.findMany({
    where: {
      organizationId: orgId,
      periodMonth,
      unitId: { in: rooms.map((r) => r.id) },
      status: { not: "void" },
    },
    select: { id: true, unitId: true, previousReading: true, currentReading: true, consumption: true, computedAmount: true, status: true },
  });
  const byUnit = new Map(readings.map((r) => [r.unitId, r]));

  return rooms.map((r) => {
    const tenancy = r.tenancies[0] ?? null;
    const meterRaw = r.aircondMeters[0] ?? null;
    const reading = byUnit.get(r.id) ?? null;
    return {
      unitId: r.id,
      unitCode: r.apartment?.unitCode ?? null,
      listingType: r.listingType ?? null,
      tenancy: tenancy ? { id: tenancy.id, numberOfPax: tenancy.numberOfPax } : null,
      tenantName: tenancy?.tenantParty?.displayName ?? null,
      meter: meterRaw ? { id: meterRaw.id, ratePerKwh: String(meterRaw.ratePerKwh), meterNumber: meterRaw.meterNumber } : null,
      currentReading: reading
        ? {
            id: reading.id,
            previousReading: String(reading.previousReading),
            currentReading: String(reading.currentReading),
            consumption: String(reading.consumption),
            computedAmount: String(reading.computedAmount),
            status: reading.status as "submitted" | "charged",
          }
        : null,
    };
  });
}

// ── Month cockpit (portfolio-wide per-period aggregation, §4.1/§4.6) ─────────
// Three read-only queries feed the cockpit; the service folds them into the
// counts + worklist. NOTE: occupancy is defined as ">=1 active Tenancy on the
// room" (the tracker's definition, ROOM_SCOPE/ACTIVE), NOT the denormalized
// Listing.occupancyStatus column — they can drift.
export type CockpitRoomRow = {
  unitId: string;
  apartmentId: string;
  unitCode: string | null; // parent apartment's unitCode (display label)
  occupied: boolean; // has >=1 active tenancy
};
export type CockpitBillRow = { apartmentId: string; status: string };

// All rooms in the org, each flagged occupied (>=1 active tenancy).
export async function findCockpitRooms(db: DbClient, orgId: string): Promise<CockpitRoomRow[]> {
  const rooms = await db.listing.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      apartmentId: true,
      apartment: { select: { unitCode: true } },
      _count: { select: { tenancies: { where: { status: "active" } } } },
    },
  });
  return rooms.map((r) => ({
    unitId: r.id,
    apartmentId: r.apartmentId,
    unitCode: r.apartment?.unitCode ?? null,
    occupied: r._count.tenancies > 0,
  }));
}

// unitIds of this org's non-void MeterReadings for the period (a read = a
// non-void reading; the @@unique[(org,unit,period)] makes this at most one/unit).
export async function findCockpitReadUnitIds(db: DbClient, orgId: string, periodMonth: Date): Promise<Set<string>> {
  const rows = await db.meterReading.findMany({
    where: { organizationId: orgId, periodMonth, status: { not: "void" } },
    select: { unitId: true },
  });
  return new Set(rows.map((r) => r.unitId));
}

// This org's UnitUtilityBills for the period (one per apartment per period via
// @@unique[(org,apartment,period)]); the service maps apartmentId → status.
export async function findCockpitBills(db: DbClient, orgId: string, periodMonth: Date): Promise<CockpitBillRow[]> {
  return db.unitUtilityBill.findMany({
    where: { organizationId: orgId, periodMonth },
    select: { apartmentId: true, status: true },
  });
}

// ── Apartment billing-mode helpers ──────────────────────────────────────────
export async function findApartmentModes(db: DbClient, orgId: string, apartmentId: string) {
  return db.apartment.findFirst({
    where: { organizationId: orgId, id: apartmentId },
    select: {
      listingMode: true,
      partitionBillingMode: true,
      tnbSubsidyCapMonthly: true,
    },
  });
}

export async function findUtilityBillingConfig(db: DbClient, orgId: string) {
  const row = await db.utilityBillingConfig.findFirst({ where: { organizationId: orgId }, select: { subsidyPerPax: true } });
  return row ? Number(row.subsidyPerPax) : 50;
}

// Apartment → owner resolution (Task 5's mirror-on-post seam). Behavior-identical
// extraction of owner-ledger.sync-hook's inline lookup: the FIRST non-archived
// listing (room) that carries an ownerPartyId — every room of one apartment
// shares one owner (propagate-on-set in updateUnitService), so any one of them
// resolves it. Returns null when the apartment has no owner set yet.
export async function findApartmentOwnerPartyId(db: DbClient, orgId: string, apartmentId: string): Promise<string | null> {
  const apt = await db.apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: { listings: { where: { listingStatus: { not: "archived" } }, select: { ownerPartyId: true } } },
  });
  return apt?.listings.find((l) => l.ownerPartyId)?.ownerPartyId ?? null;
}

// Guard resolvers (owner-billing-ready.ts). One-hop lookups returning the unit's
// ownerPartyId + its propertyId — the two facts the charge-post readiness guard
// needs. Sibling to findApartmentOwnerPartyId (kept as-is: mirror path relies on
// its string|null return). listingStatus "archived" is excluded for the apartment
// resolver, matching findApartmentOwnerPartyId + resolveOwnerUnitsForMonth.
export async function findListingOwner(
  db: DbClient,
  orgId: string,
  listingId: string,
): Promise<{ ownerPartyId: string | null; propertyId: string } | null> {
  const listing = await db.listing.findFirst({
    where: { id: listingId, organizationId: orgId },
    select: { ownerPartyId: true, apartment: { select: { propertyId: true } } },
  });
  if (!listing) return null;
  return { ownerPartyId: listing.ownerPartyId, propertyId: listing.apartment.propertyId };
}

export async function findApartmentOwner(
  db: DbClient,
  orgId: string,
  apartmentId: string,
): Promise<{ ownerPartyId: string | null; propertyId: string } | null> {
  const apt = await db.apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: {
      propertyId: true,
      listings: { where: { listingStatus: { not: "archived" } }, select: { ownerPartyId: true } },
    },
  });
  if (!apt) return null;
  return {
    ownerPartyId: apt.listings.find((l) => l.ownerPartyId)?.ownerPartyId ?? null,
    propertyId: apt.propertyId,
  };
}

// ── UtilityAllocation ───────────────────────────────────────────────────────
export async function createAllocation(db: DbClient, data: Prisma.UtilityAllocationUncheckedCreateInput) {
  return db.utilityAllocation.create({ data, select: { id: true } });
}
export async function getAllocation(db: DbClient, orgId: string, id: string) {
  return db.utilityAllocation.findFirst({ where: { organizationId: orgId, id } });
}

// ── Charge + ChargeEvent (created INSIDE the compute transaction) ────────────
export async function createChargeTx(tx: Prisma.TransactionClient, data: Prisma.ChargeUncheckedCreateInput) {
  return tx.charge.create({ data, select: { id: true } });
}
export async function createChargeEventTx(tx: Prisma.TransactionClient, data: Prisma.ChargeEventUncheckedCreateInput) {
  return tx.chargeEvent.create({ data });
}

// ── UnitUtilityBillAttachment ────────────────────────────────────────────────
export async function createBillAttachment(
  db: DbClient,
  data: { organizationId: string; billId: string; storageKey: string; filename: string; uploadedById: string },
) {
  return db.unitUtilityBillAttachment.create({
    data,
    select: { id: true, filename: true, storageKey: true, createdAt: true },
  });
}

// tx-scoped alias — self-documents call sites that MUST run inside the attach
// transaction (mirrors createChargeTx/createChargeEventTx below).
export async function createBillAttachmentTx(
  tx: Prisma.TransactionClient,
  data: { organizationId: string; billId: string; storageKey: string; filename: string; uploadedById: string },
) {
  return createBillAttachment(tx, data);
}

export async function listBillAttachments(db: DbClient, organizationId: string, billId: string) {
  return db.unitUtilityBillAttachment.findMany({
    where: { organizationId, billId },
    orderBy: { createdAt: "asc" },
    select: { id: true, storageKey: true, filename: true, createdAt: true },
  });
}

export async function getBillAttachment(db: DbClient, organizationId: string, id: string) {
  return db.unitUtilityBillAttachment.findFirst({ where: { id, organizationId }, select: { id: true, billId: true, storageKey: true } });
}

export async function deleteBillAttachment(db: DbClient, organizationId: string, id: string) {
  await db.unitUtilityBillAttachment.deleteMany({ where: { id, organizationId } });
}
