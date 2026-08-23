export type InventorySession = {
  userId: string;
  orgId: string;
  role: string;
};

export type InventorySummary = {
  propertyCount: number;
  // Despite the legacy name, `unitCount` now counts approved Listings (one
  // Listing == one commercial offer / room). Renaming would cascade through
  // the web layer; we keep the wire name and redefine the semantics here.
  unitCount: number;
  occupiedUnits: number;
  vacantUnits: number;
};

// Detail shape used by the admin unit-edit dialog. Now hydrated from a
// Listing row joined to its parent Apartment (apartment-shared fields are
// the source of truth on Apartment; per-room fields live on Listing).
//
// The wire-facing field names are kept stable across the migration so the
// SPA edit dialog continues to function without a parallel rewrite:
//   - `unitCode` comes from Apartment.unitCode
//   - `unitType` comes from Listing.listingType (renamed)
//   - apartment-shared fields (bedrooms, bathrooms, etc.) come from
//     Apartment, not Listing
//   - sourcing fields no longer exist on Listing — sourcingApproved is gone
//     (Listings are approved by definition); sourcingAgentId stays as a
//     denormalised lineage column on Listing
export type UnitDetail = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floor: number | null;
  floorArea: number | null;
  rentalRate: number | null;
  currency: string;
  occupancyStatus: string;
  listingStatus: string;
  amenities: { id: string; name: string }[];
  highlights: string[];
  description: string | null;
  photoKeys: string[];
  videoKeys: string[];
  moveInDate: string | null;
  readyNow: boolean;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  hiddenFromAgentNames: string[];
  grantedPartyIds: string[];
  grantedAgentNames: string[];
  // Lineage — null when the Listing is admin-created. Non-null Listings
  // came from an approved UnitSubmission, or were admin-assigned via the
  // edit dialog's "Sourcing agent" picker.
  sourcingAgentId: string | null;
  sourcingAgentName: string | null;
  inChargePartyId: string | null;
  inChargeName: string | null;
  ownerPartyId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  /** Null defers to partitionBillingMode; a value takes priority for residual TNB. */
  tnbSubsidyCapMonthly: number | null;
  property: {
    id: string;
    name: string;
    propertyCode: string;
    city: string | null;
    hasPaxDeduction: boolean;
    paxDeductionAmount: number | null;
  } | null;
  depositMonths: number | null;
  utilitiesDepositMonths: number | null;
  accessCardDepositPerPcs: number | null;
  accessCardQuantity: number | null;
  parkingQuantity: number | null;
  parkingNumbers: string[];
  activeTenancy: {
    id: string;
    tenantPartyId: string;
    tenantName: string;
    tenantIdType: string | null;
    tenantIdNumberMasked: string | null;
    tenantPhone: string | null;
    startDate: string;
    endDate: string | null;
    // The tenancy's negotiated monthly rent (RM). Surfaced so the Edit-unit
    // dialog can prefill it instead of the unit's asking rentalRate.
    monthlyRentAmount: number;
  } | null;
  tenancyHistory: Array<{
    id: string;
    tenancyCode: string;
    tenantPartyId: string;
    tenantName: string;
    listingLabel: string;
    status: string;
    startDate: string;
    endDate: string | null;
    monthlyRentAmount: number;
  }>;
  currentTenancyStartDate: string | null;
  currentTenancyEndDate: string | null;
};
