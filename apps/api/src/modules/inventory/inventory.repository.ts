import { getDb } from "@kason/db";
import type { UnitDetail } from "./inventory.types";
import { shapeAmenities } from "../portal/listings/portal.listings.repository";
import { maskIdNumber } from "../../lib/ic-reveal";
import { formatMyPhoneDisplay, readPhoneAnyFormat } from "@kason/shared";

function toNumber(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

/**
 * List properties in an org with derived counts.
 *
 * Counts now come from the Apartment + Listing tree. Wire names are kept
 * for back-compat:
 *   - `unitCount` is the total number of non-archived Listings across all
 *     apartments of the property.
 *   - `occupiedUnits` is the subset of `unitCount` whose occupancyStatus is
 *     "occupied".
 *
 * Pending agent submissions are physically NOT in this tree (they live in
 * UnitSubmission), so there is no EXCLUDE-style filter — any row visible
 * via this query is already approved by construction.
 */
export async function listProperties(organizationId: string) {
  const db = getDb();
  const properties = await db.property.findMany({
    where: { organizationId },
    include: {
      apartments: {
        select: {
          listings: {
            where: { listingStatus: { not: "archived" } },
            select: { occupancyStatus: true },
          },
        },
      },
    },
    orderBy: [{ name: "asc" }],
  });

  return properties.map((property) => {
    const listings = property.apartments.flatMap((a) => a.listings);
    return {
      id: property.id,
      name: property.name,
      propertyCode: property.propertyCode,
      propertyType: property.propertyType,
      status: property.status,
      unitCount: listings.length,
      occupiedUnits: listings.filter((l) => l.occupancyStatus === "occupied").length,
    };
  });
}

/**
 * Flat inventory grid — returns every non-archived Listing in the org with
 * its parent Apartment + Property joined for the address fields. Used by
 * the inventory page's main grid view.
 *
 * Apartment-mode filtering (only show listings whose RoomType.kind matches
 * the parent Apartment.listingMode) is deliberately NOT applied here — the
 * flat grid shows everything. Per-apartment mode filtering happens in
 * `getApartmentsByPropertyService`.
 */
export async function listListings(
  organizationId: string,
  filters?: { q?: string; status?: string },
) {
  const db = getDb();
  const q = filters?.q?.trim();
  const status = filters?.status?.trim();

  const listings = await db.listing.findMany({
    where: {
      organizationId,
      listingStatus: { not: "archived" },
      ...(status ? { occupancyStatus: status } : {}),
      ...(q
        ? {
            OR: [
              {
                apartment: {
                  unitCode: { contains: q, mode: "insensitive" },
                },
              },
              {
                apartment: {
                  property: { name: { contains: q, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    },
    include: {
      apartment: {
        select: {
          unitCode: true,
          propertyId: true,
          property: {
            select: { id: true, name: true, propertyCode: true },
          },
        },
      },
    },
    orderBy: [{ apartment: { unitCode: "asc" } }],
    take: 100,
  });

  return listings.map((listing) => ({
    id: listing.id,
    propertyId: listing.apartment.property.id,
    propertyName: listing.apartment.property.name,
    propertyCode: listing.apartment.property.propertyCode,
    unitCode: listing.apartment.unitCode,
    unitType: listing.listingType,
    occupancyStatus: listing.occupancyStatus,
    listingStatus: listing.listingStatus,
    visibilityMode: listing.visibilityMode,
    readyNow: listing.readyNow,
    rentalRate: toNumber(listing.rentalRate),
    currency: listing.currency,
  }));
}

/**
 * Free-text apartment search for label→id pickers (e.g. the meter bill drawer
 * picks an Apartment by its unitCode). Mirrors `listListings` filtering but
 * returns DISTINCT apartments (one row per A-08-02), not one row per room.
 */
export async function searchApartments(
  organizationId: string,
  filters?: { q?: string },
) {
  const db = getDb();
  const q = filters?.q?.trim();
  const apartments = await db.apartment.findMany({
    where: {
      organizationId,
      ...(q
        ? {
            OR: [
              { unitCode: { contains: q, mode: "insensitive" } },
              { property: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: { id: true, unitCode: true, property: { select: { name: true } } },
    orderBy: [{ unitCode: "asc" }],
    take: 50,
  });
  return apartments.map((a) => ({ id: a.id, unitCode: a.unitCode, propertyName: a.property.name }));
}

export async function findPropertyById(organizationId: string, propertyId: string) {
  const db = getDb();
  return db.property.findFirst({
    where: { id: propertyId, organizationId },
    select: { id: true },
  });
}

/**
 * Returns the parent Property's `status` column for a given (org, propertyId).
 * Used by createUnitService / updateUnitService to feed deriveReadyNow with
 * the parent's lifecycle. Returns null when the property doesn't exist or
 * doesn't belong to the org (org-isolation gate).
 */
export async function findPropertyStatus(
  organizationId: string,
  propertyId: string,
): Promise<string | null> {
  const db = getDb();
  const row = await db.property.findFirst({
    where: { id: propertyId, organizationId },
    select: { status: true },
  });
  return row?.status ?? null;
}

/**
 * Cascade hook: when a Property's status flips, recompute `readyNow` for
 * every Listing on every Apartment of that property. SYNC implementation
 * — runs in the same logical operation as the property update.
 *
 * The `derive` callback is the canonical deriveReadyNow implementation,
 * injected by the service so the repo doesn't import the domain logic.
 */
export async function recomputeReadyNowForProperty(
  organizationId: string,
  propertyId: string,
  derive: (input: {
    propertyStatus: string;
    listingStatus: string;
    visibilityMode: string;
    occupancyStatus: string;
  }) => boolean,
): Promise<number> {
  const db = getDb();
  const property = await db.property.findFirst({
    where: { id: propertyId, organizationId },
    select: { status: true },
  });
  if (!property) return 0;

  const listings = await db.listing.findMany({
    where: {
      organizationId,
      apartment: { propertyId },
    },
    select: {
      id: true,
      occupancyStatus: true,
      listingStatus: true,
      visibilityMode: true,
      readyNow: true,
    },
  });

  let updated = 0;
  for (const l of listings) {
    const next = derive({
      propertyStatus: property.status,
      listingStatus: l.listingStatus,
      visibilityMode: l.visibilityMode,
      occupancyStatus: l.occupancyStatus,
    });
    if (next !== l.readyNow) {
      await db.listing.update({
        where: { id: l.id },
        data: { readyNow: next },
      });
      updated += 1;
    }
  }
  return updated;
}

/**
 * Full Property record for the Edit Property dialog. We surface every column
 * the dialog renders so the form can pre-fill instead of showing placeholder
 * text — placeholders mislead operators into thinking the existing value is
 * already in the input, then the form silently submits undefined.
 */
export async function findPropertyDetail(organizationId: string, propertyId: string) {
  const db = getDb();
  const p = await db.property.findFirst({
    where: { id: propertyId, organizationId },
    select: {
      id: true,
      name: true,
      propertyCode: true,
      propertyType: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      status: true,
      hasPaxDeduction: true,
      paxDeductionAmount: true,
    },
  });
  if (!p) return null;
  return {
    ...p,
    paxDeductionAmount:
      p.paxDeductionAmount != null ? Number(p.paxDeductionAmount.toString()) : null,
  };
}

export async function findPropertyCodeConflict(organizationId: string, propertyCode: string, excludePropertyId?: string) {
  const db = getDb();
  return db.property.findFirst({
    where: {
      organizationId,
      propertyCode,
      ...(excludePropertyId ? { id: { not: excludePropertyId } } : {}),
    },
    select: { id: true },
  });
}

export async function createProperty(params: {
  organizationId: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
}) {
  const db = getDb();
  return db.property.create({
    data: {
      organizationId: params.organizationId,
      name: params.name,
      propertyCode: params.propertyCode,
      propertyType: params.propertyType,
      addressLine1: params.addressLine1,
      addressLine2: params.addressLine2 ?? null,
      city: params.city,
      state: params.state ?? null,
      postalCode: params.postalCode ?? null,
      country: params.country,
      status: "active",
      publishStatus: "draft",
    },
    select: { id: true },
  });
}

export async function updateProperty(propertyId: string, data: Record<string, unknown>) {
  const db = getDb();
  await db.property.update({
    where: { id: propertyId },
    data,
  });
}

/**
 * Identity lookup for a Listing. Returns the columns the service needs to
 * run conflict checks and derive readyNow.  We hydrate the parent
 * Apartment's propertyId + unitCode so the service layer has a complete
 * identity tuple without a second round-trip.
 */
export async function findListingById(organizationId: string, listingId: string) {
  const db = getDb();
  const listing = await db.listing.findFirst({
    where: { id: listingId, organizationId },
    select: {
      id: true,
      organizationId: true,
      apartmentId: true,
      listingType: true,
      occupancyStatus: true,
      listingStatus: true,
      visibilityMode: true,
      rentalRate: true,
      ownerPartyId: true,
      apartment: {
        select: { propertyId: true, unitCode: true },
      },
    },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    organizationId: listing.organizationId,
    apartmentId: listing.apartmentId,
    propertyId: listing.apartment.propertyId,
    unitCode: listing.apartment.unitCode,
    unitType: listing.listingType,
    occupancyStatus: listing.occupancyStatus,
    listingStatus: listing.listingStatus,
    visibilityMode: listing.visibilityMode,
    rentalRate: listing.rentalRate,
    ownerPartyId: listing.ownerPartyId,
  };
}

/**
 * Conflict check for (apartmentId, listingType). The DB-level unique key
 * is exactly this tuple — no propertyId/unitCode here (those live on
 * Apartment).
 */
export async function findListingTypeConflict(params: {
  apartmentId: string;
  listingType: string;
  excludeListingId?: string;
}) {
  const db = getDb();
  return db.listing.findFirst({
    where: {
      apartmentId: params.apartmentId,
      listingType: params.listingType,
      ...(params.excludeListingId ? { id: { not: params.excludeListingId } } : {}),
    },
    select: { id: true },
  });
}

// CreateListingDbInput — every field this layer writes to a Listing row.
// Apartment-shared fields (bedrooms, photos, amenities) are NOT here —
// those live on Apartment and are written via the apartment.repository.
//
// `description` and `highlights` were apartment-shared in the old schema
// but the create surface still accepts them at the request edge for legacy
// callers; the service strips them before reaching this repo.
export type CreateListingDbInput = {
  organizationId: string;
  apartmentId: string;
  listingType: string;
  rentalRate?: number;
  occupancyStatus?: string;
  listingStatus?: string;
  inChargePartyId?: string | null;
  visibilityMode?: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds?: string[];
  sourcingAgentId?: string | null;
  ownerPartyId?: string | null;
  // readyNow is derived server-side and passed in by the service layer.
  readyNow?: boolean;
  // Deposits + parking (per-Listing offer-side).
  depositMonths?: number;
  utilitiesDepositMonths?: number;
  accessCardDepositPerPcs?: number;
  accessCardQuantity?: number;
  parkingQuantity?: number;
  parkingNumbers?: string[];
};

// Tx-bound only — every Listing insert in this codebase happens inside a
// transaction that just inserted (or found) the parent Apartment row. A
// fresh-connection variant would not see that uncommitted parent and would
// trigger Unit_apartmentId_fkey (admin "Create unit" 500 / B4). If a
// future non-transactional caller appears, wrap a single $transaction
// around it at the call site — do NOT add a non-tx helper here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createListingTx(tx: any, params: CreateListingDbInput) {
  return tx.listing.create({
    data: {
      organizationId: params.organizationId,
      apartmentId: params.apartmentId,
      listingType: params.listingType,
      rentalRate: params.rentalRate ?? null,
      occupancyStatus: params.occupancyStatus ?? "vacant",
      listingStatus: params.listingStatus ?? "draft",
      inChargePartyId: params.inChargePartyId ?? null,
      // Owner is apartment-scoped: a new room must be born carrying the
      // apartment's current owner (resolved by the service layer) so it can be
      // occupied like its siblings. Omitting this column let rooms added after
      // owner-assignment stay ownerless → UNIT_HAS_NO_OWNER on occupy.
      ownerPartyId: params.ownerPartyId ?? null,
      visibilityMode: params.visibilityMode ?? "PUBLIC",
      hiddenFromPartyIds: params.hiddenFromPartyIds ?? [],
      sourcingAgentId: params.sourcingAgentId ?? null,
      currency: "MYR",
      readyNow: params.readyNow ?? false,
      depositMonths: params.depositMonths ?? null,
      utilitiesDepositMonths: params.utilitiesDepositMonths ?? null,
      accessCardDepositPerPcs: params.accessCardDepositPerPcs ?? null,
      accessCardQuantity: params.accessCardQuantity ?? null,
      parkingQuantity: params.parkingQuantity ?? null,
      parkingNumbers: params.parkingNumbers ?? [],
    },
    select: { id: true },
  });
}

// UpdateListingDbInput — the patchable subset of CreateListingDbInput. We
// deliberately enumerate every column the dialog is allowed to write so
// adding a field to the Zod schema doesn't silently start writing it.
export type UpdateListingDbInput = Partial<Omit<CreateListingDbInput, "organizationId" | "apartmentId">>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function updateListingTx(tx: any, listingId: string, data: UpdateListingDbInput) {
  const payload: Record<string, unknown> = {};
  if (data.listingType !== undefined) payload.listingType = data.listingType;
  if (data.rentalRate !== undefined) payload.rentalRate = data.rentalRate ?? null;
  if (data.occupancyStatus !== undefined) payload.occupancyStatus = data.occupancyStatus;
  if (data.listingStatus !== undefined) payload.listingStatus = data.listingStatus;
  if (data.inChargePartyId !== undefined) payload.inChargePartyId = data.inChargePartyId ?? null;
  if (data.visibilityMode !== undefined) payload.visibilityMode = data.visibilityMode;
  if (data.hiddenFromPartyIds !== undefined) payload.hiddenFromPartyIds = data.hiddenFromPartyIds;
  if (data.sourcingAgentId !== undefined) payload.sourcingAgentId = data.sourcingAgentId ?? null;
  if (data.ownerPartyId !== undefined) payload.ownerPartyId = data.ownerPartyId ?? null;
  if (data.depositMonths !== undefined) payload.depositMonths = data.depositMonths ?? null;
  if (data.utilitiesDepositMonths !== undefined) {
    payload.utilitiesDepositMonths = data.utilitiesDepositMonths ?? null;
  }
  if (data.accessCardDepositPerPcs !== undefined) {
    payload.accessCardDepositPerPcs = data.accessCardDepositPerPcs ?? null;
  }
  if (data.accessCardQuantity !== undefined) {
    payload.accessCardQuantity = data.accessCardQuantity ?? null;
  }
  if (data.parkingQuantity !== undefined) payload.parkingQuantity = data.parkingQuantity ?? null;
  if (data.parkingNumbers !== undefined) payload.parkingNumbers = data.parkingNumbers;
  // readyNow is set ONLY by the service layer — never trusted from a
  // direct call site.
  if (data.readyNow !== undefined) payload.readyNow = data.readyNow;

  await tx.listing.update({
    where: { id: listingId },
    data: payload,
  });
}

export async function updateListing(listingId: string, data: UpdateListingDbInput) {
  const db = getDb();
  await updateListingTx(db, listingId, data);
}

export async function updatePropertyPaxDeduction(
  propertyId: string,
  organizationId: string,
  data: { hasPaxDeduction?: boolean; paxDeductionAmount?: number | null },
) {
  const db = getDb();
  const payload: Record<string, unknown> = {};
  if (data.hasPaxDeduction !== undefined) payload.hasPaxDeduction = data.hasPaxDeduction;
  if (data.paxDeductionAmount !== undefined) {
    payload.paxDeductionAmount = data.paxDeductionAmount ?? null;
  }
  if (Object.keys(payload).length === 0) return;
  await db.property.updateMany({
    where: { id: propertyId, organizationId },
    data: payload,
  });
}

/**
 * Listing detail for the admin edit dialog. Reads from Listing, joins
 * Apartment for the apartment-shared fields, and joins Apartment.property
 * for the address fields.
 *
 * The wire shape (`UnitDetail`) is intentionally backward-compatible with
 * the old Unit-detail wire so the SPA edit dialog doesn't need a parallel
 * rewrite. Apartment-shared values are surfaced directly under the
 * top-level fields (bedrooms, bathrooms, etc.) even though they physically
 * live on the joined Apartment row.
 */
export async function findUnitDetail(
  organizationId: string,
  listingId: string,
): Promise<UnitDetail | null> {
  const db = getDb();
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    include: {
      apartment: {
        select: {
          unitCode: true,
          bedrooms: true,
          bathrooms: true,
          floor: true,
          floorArea: true,
          amenities: true,
          highlights: true,
          publishedDescription: true,
          tnbSubsidyCapMonthly: true,
          property: {
            select: {
              id: true,
              name: true,
              propertyCode: true,
              city: true,
              hasPaxDeduction: true,
              paxDeductionAmount: true,
            },
          },
        },
      },
      inChargeParty: { select: { id: true, displayName: true } },
      ownerParty: { select: { displayName: true, primaryPhone: true } },
      sourcingAgent: { select: { id: true, displayName: true } },
      tenancies: {
        where: { status: "active" },
        orderBy: { startDate: "desc" },
        take: 1,
        select: {
          id: true,
          startDate: true,
          endDate: true,
          tenantPartyId: true,
          // The tenancy's negotiated monthly rent — the Edit-unit dialog must
          // prefill THIS (not the unit's asking rentalRate) when reopening an
          // occupied unit, so the shown rent matches what the poster bills.
          monthlyRentAmount: true,
          firstMonthIsCommission: true,
          commissionSstBearer: true,
          tenantParty: {
            select: { displayName: true, idType: true, idNumber: true, primaryPhone: true },
          },
        },
      },
    },
  });
  if (!listing || listing.organizationId !== organizationId) return null;

  // Apartment-wide history: a whole-unit listing may later be partitioned (or
  // vice versa), so limiting history to the currently opened Listing would
  // hide earlier legitimate tenancies from the same physical apartment.
  const tenancyHistoryRows = await db.tenancy.findMany({
    where: {
      organizationId,
      unit: { apartmentId: listing.apartmentId },
    },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      tenancyCode: true,
      tenantPartyId: true,
      status: true,
      startDate: true,
      endDate: true,
      monthlyRentAmount: true,
      tenantParty: { select: { displayName: true } },
      unit: { select: { listingType: true } },
    },
  });

  // Resolve hiddenFromPartyIds → agent names. Skip the round-trip when empty.
  let hiddenFromAgentNames: string[] = [];
  if (listing.hiddenFromPartyIds.length > 0) {
    const parties = await db.party.findMany({
      where: {
        organizationId,
        id: { in: listing.hiddenFromPartyIds },
      },
      select: { id: true, displayName: true },
    });
    const byId = new Map(parties.map((p) => [p.id, p.displayName]));
    hiddenFromAgentNames = listing.hiddenFromPartyIds
      .map((id) => byId.get(id))
      .filter((n): n is string => Boolean(n));
  }

  // ListingVisibilityGrant rows → agent names + ids. Empty when the listing
  // is PUBLIC (the service forces a clear in that case). The FK column is
  // still named `unitId` at the schema level (Listing's @@map preserves the
  // physical table) — only the Prisma client model rename happened.
  const grantRows = await db.listingVisibilityGrant.findMany({
    where: { unitId: listingId, organizationId },
    select: { partyId: true, party: { select: { displayName: true } } },
    orderBy: { grantedAt: "asc" },
  });
  const grantedPartyIds: string[] = grantRows.map((g) => g.partyId);
  const grantedAgentNames: string[] = grantRows.map((g) => g.party?.displayName ?? "");

  // Org's amenity catalog (ALL — incl. inactive — for display).
  const amenityRows = await db.amenity.findMany({
    where: { organizationId },
    select: { id: true, name: true },
  });
  const amenityCatalog = new Map(amenityRows.map((a) => [a.id, a.name]));

  const apartment = listing.apartment;
  const property = apartment.property;
  return {
    id: listing.id,
    unitCode: apartment.unitCode,
    unitType: listing.listingType,
    bedrooms: apartment.bedrooms,
    bathrooms: apartment.bathrooms != null ? Number(apartment.bathrooms.toString()) : null,
    floor: apartment.floor,
    floorArea: apartment.floorArea != null ? Number(apartment.floorArea.toString()) : null,
    rentalRate: listing.rentalRate != null ? Number(listing.rentalRate.toString()) : null,
    currency: listing.currency,
    occupancyStatus: listing.occupancyStatus,
    listingStatus: listing.listingStatus,
    amenities: shapeAmenities(apartment.amenities, amenityCatalog),
    highlights: apartment.highlights,
    description: apartment.publishedDescription ?? null,
    photoKeys: listing.photoKeys,
    videoKeys: listing.videoKeys,
    moveInDate: listing.moveInDate ? listing.moveInDate.toISOString() : null,
    readyNow: listing.readyNow,
    visibilityMode: listing.visibilityMode as "PUBLIC" | "RESTRICTED",
    hiddenFromPartyIds: listing.hiddenFromPartyIds,
    hiddenFromAgentNames,
    grantedPartyIds,
    grantedAgentNames,
    sourcingAgentId: listing.sourcingAgentId,
    sourcingAgentName: listing.sourcingAgent?.displayName ?? null,
    inChargePartyId: listing.inChargePartyId,
    inChargeName: listing.inChargeParty?.displayName ?? listing.inChargeName ?? null,
    ownerPartyId: listing.ownerPartyId,
    ownerName: listing.ownerParty?.displayName ?? null,
    ownerPhone: listing.ownerParty?.primaryPhone ?? null,
    tnbSubsidyCapMonthly:
      apartment.tnbSubsidyCapMonthly == null
        ? null
        : Number(apartment.tnbSubsidyCapMonthly.toString()),
    property: property
      ? {
          id: property.id,
          name: property.name,
          propertyCode: property.propertyCode,
          city: property.city ?? null,
          hasPaxDeduction: property.hasPaxDeduction,
          paxDeductionAmount:
            property.paxDeductionAmount != null
              ? Number(property.paxDeductionAmount.toString())
              : null,
        }
      : null,
    depositMonths:
      listing.depositMonths != null
        ? Number(listing.depositMonths.toString())
        : null,
    utilitiesDepositMonths:
      listing.utilitiesDepositMonths != null
        ? Number(listing.utilitiesDepositMonths.toString())
        : null,
    accessCardDepositPerPcs:
      listing.accessCardDepositPerPcs != null
        ? Number(listing.accessCardDepositPerPcs.toString())
        : null,
    accessCardQuantity: listing.accessCardQuantity ?? null,
    parkingQuantity: listing.parkingQuantity ?? null,
    parkingNumbers: listing.parkingNumbers,
    activeTenancy: listing.tenancies[0]
      ? (() => {
          const t = listing.tenancies[0];
          const canonical = readPhoneAnyFormat(t.tenantParty.primaryPhone);
          return {
            id: t.id,
            tenantPartyId: t.tenantPartyId,
            tenantName: t.tenantParty.displayName,
            tenantIdType: t.tenantParty.idType,
            tenantIdNumberMasked: maskIdNumber(t.tenantParty.idNumber),
            tenantPhone: canonical ? formatMyPhoneDisplay(canonical) : canonical,
            startDate: t.startDate.toISOString().slice(0, 10),
            endDate: t.endDate?.toISOString().slice(0, 10) ?? null,
            // Decimal(12,2), non-null in schema → always a real number here.
            monthlyRentAmount: Number(t.monthlyRentAmount.toString()),
            firstMonthIsCommission: t.firstMonthIsCommission,
            commissionSstBearer: t.commissionSstBearer as "owner" | "kaen",
          };
        })()
      : null,
    tenancyHistory: tenancyHistoryRows.map((t) => ({
      id: t.id,
      tenancyCode: t.tenancyCode,
      tenantPartyId: t.tenantPartyId,
      tenantName: t.tenantParty.displayName,
      listingLabel: t.unit.listingType,
      status: t.status,
      startDate: t.startDate.toISOString().slice(0, 10),
      endDate: t.endDate?.toISOString().slice(0, 10) ?? null,
      monthlyRentAmount: Number(t.monthlyRentAmount.toString()),
    })),
    currentTenancyStartDate:
      listing.tenancies[0]?.startDate?.toISOString() ?? null,
    currentTenancyEndDate:
      listing.tenancies[0]?.endDate?.toISOString() ?? null,
  };
}

/**
 * Replace-set the ListingVisibilityGrant rows for a listing. Used by the
 * service when an admin saves a RESTRICTED listing's "Visible to" list.
 *
 * Atomicity: the delete + insert MUST happen inside a single transaction
 * so a concurrent grant change can't leave the listing with a half-applied
 * allowlist.
 *
 * Pass `partyIds=[]` to clear all grants (e.g. when the operator flips
 * the listing back to PUBLIC).
 */
export async function replaceVisibilityGrants(args: {
  organizationId: string;
  listingId: string;
  partyIds: string[];
  grantedById: string;
}): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.listingVisibilityGrant.deleteMany({
      where: { unitId: args.listingId, organizationId: args.organizationId },
    });
    if (args.partyIds.length === 0) return;
    await tx.listingVisibilityGrant.createMany({
      data: args.partyIds.map((partyId) => ({
        organizationId: args.organizationId,
        unitId: args.listingId,
        partyId,
        grantedById: args.grantedById,
      })),
      skipDuplicates: true,
    });
  });
}

