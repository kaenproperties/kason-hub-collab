// Admin typed client for the multi-room batch endpoint. Mirrors the
// portal client's shape (apps/web/src/api/portal-inventory.ts) but hits
// /api/inventory/units/batch and is gated on the admin session.
import { apiFetch } from "@/lib/api-client";

export type CreateUnitsBatchSharedFields = {
  propertyId: string;
  unitCode: string;
  floor?: number;
  bedrooms?: number;
  bathrooms?: number;
  floorArea?: number;
  amenities?: string[];
  // Per-apartment free-form selling points; rendered alongside amenities
  // but not subject to the org catalog gate. Fans out to sibling rows
  // on applyToExistingSiblings=true.
  highlights?: string[];
  description?: string | null;
  inChargePartyId?: string | null;
  // Apartment-scoped, admin-only. The admin batch schema
  // (createUnitsBatchSchema) declares both on its `shared`; the portal batch
  // schema does not, so an agent can never set an apartment's owner or its
  // billing model. The unified create modal routes a Partition submission
  // here and puts the apartment owner on `shared`.
  ownerPartyId?: string;
  partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY" | null;
  /** Null defers to partitionBillingMode; a value takes priority for residual TNB. */
  tnbSubsidyCapMonthly?: number | null;
  managementFeeConfig?: {
    feeType: "percent" | "fixed" | "cap";
    feeValue: string;
    capAmount?: string | null;
    sstPercent: "8";
    freePeriodStart?: string | null;
    freePeriodEnd?: string | null;
    firstChargeMonth?: string | null;
    firstChargeBaseAmount?: string | null;
    paxDeductionPerPerson?: string | null;
  };
};

export type CreateUnitsBatchRoom = {
  unitType: string;
  rentalRate?: number;
  depositMonths?: number;
  utilitiesDepositMonths?: number;
  accessCardDepositPerPcs?: number;
  accessCardQuantity?: number;
  parkingQuantity?: number;
  parkingNumbers?: string[];
  // Admin-only per-room occupancy, mirroring `adminBatchRoomFields` in
  // packages/shared/src/schemas/inventory.ts. This is the ADMIN batch client;
  // the portal client (portal-inventory.ts) mirrors `batchRoomFields` and must
  // never carry these — an agent may not mark a room occupied or set a tenant.
  occupancyStatus?: string;
  tenantPartyId?: string;
  moveInDate?: string;
  moveOutDate?: string;
  monthlyRent?: number;
};

export type CreateUnitsBatchPayload = {
  shared: CreateUnitsBatchSharedFields;
  rooms: CreateUnitsBatchRoom[];
  // Opt-in fan-out: server rewrites apartment-scoped fields on every
  // existing sibling. Admin path has no ownership restriction.
  applyToExistingSiblings?: boolean;
};

export async function createUnitsBatch(
  body: CreateUnitsBatchPayload,
): Promise<{ ids: string[]; updatedIds: string[]; apartmentId: string }> {
  const res = await apiFetch<{
    data: { ids: string[]; updatedIds: string[]; apartmentId: string };
  }>("/inventory/units/batch", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.data;
}

/** PATCH /api/apartments/:id/shared — apartment-scoped fields the batch path can't set
 *  (e.g. partitionBillingMode, ownerPartyId). Manager-gated server-side. */
export async function updateApartmentShared(
  apartmentId: string,
  body: {
    partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY";
    tnbSubsidyCapMonthly?: number | null;
    ownerPartyId?: string | null;
    underManagement?: boolean;
  },
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(`/apartments/${apartmentId}/shared`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// Wire shape of GET /inventory/apartments/by-property/:propertyId.
// Mirrors the server's ApartmentSummary in inventory.service.ts.
export type ApartmentRoomSummary = {
  id: string;
  unitType: string;
  rentalRate: number | null;
  occupancyStatus: string | null;
  listingStatus: string;
  inChargePartyId: string | null;
  tenantPartyId?: string | null;
  tenantName?: string | null;
  tenancyStartDate?: string | null;
  tenancyEndDate?: string | null;
};

export type ApartmentSummary = {
  id: string;
  unitCode: string;
  floor: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  amenities: { id: string; name: string }[];
  highlights: string[];
  description: string | null;
  /** LIVE rooms only — archived rooms are excluded, as every consumer
   *  (listing mode, drift, owner resolution, room tabs) means live. */
  rooms: ApartmentRoomSummary[];
  /** Deactivated rooms. Optional so older cached payloads (and the many test
   *  fixtures that build an ApartmentSummary by hand) stay assignable. */
  archivedRooms?: ApartmentRoomSummary[];
  hasDrift: boolean;
  listingMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
  partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY" | null;
  /** Null defers to partitionBillingMode; a value takes priority for residual TNB. */
  tnbSubsidyCapMonthly?: number | null;
  // invariant: present whenever the apartment has an assigned owner — null = no owner yet
  ownerPartyId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  // R7 — whether KAEN is currently acting as billing agent for this apartment.
  // REQUIRED (not optional): the admin by-property endpoint always returns it.
  // Making it required forces every fixture to set a real boolean instead of
  // silently defaulting via `?? true` at the read site.
  underManagement: boolean;
};

export async function getApartmentsByProperty(
  propertyId: string,
): Promise<ApartmentSummary[]> {
  const res = await apiFetch<{ data: ApartmentSummary[] }>(
    `/inventory/apartments/by-property/${propertyId}`,
  );
  return res.data;
}

/**
 * POST /listings/:id/reactivate — un-archive a deactivated room, back to
 * `draft` (never straight to `active`: admin republishes through the normal
 * status transition so they can verify before agents see it). Server requires
 * manager+ and 409s when the listing is not archived.
 */
export async function reactivateListing(listingId: string): Promise<{ id: string }> {
  const res = await apiFetch<{ data: { id: string } }>(
    `/listings/${listingId}/reactivate`,
    { method: "POST" },
  );
  return res.data;
}
