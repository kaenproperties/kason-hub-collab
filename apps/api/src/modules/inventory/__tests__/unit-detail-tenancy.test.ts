import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findTenancyHistory = vi.fn();
vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findUnique },
    tenancy: { findMany: findTenancyHistory },
    party: { findMany: vi.fn().mockResolvedValue([]) },
    listingVisibilityGrant: { findMany: vi.fn().mockResolvedValue([]) },
    amenity: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

beforeEach(() => {
  findUnique.mockReset();
  findTenancyHistory.mockReset();
  findTenancyHistory.mockResolvedValue([]);
});

describe("findUnitDetail — activeTenancy", () => {
  it("surfaces the active tenancy when one exists", async () => {
    findUnique.mockResolvedValueOnce({
      id: "u1",
      organizationId: "o1",
      apartmentId: "apt-1",
      listingType: "Medium",
      currency: "MYR",
      occupancyStatus: "occupied",
      listingStatus: "active",
      visibilityMode: "PUBLIC",
      hiddenFromPartyIds: [],
      rentalRate: { toString: () => "2600.00" },
      moveInDate: null,
      readyNow: false,
      sourcingAgentId: null,
      inChargePartyId: null,
      inChargeName: null,
      inChargeParty: null,
      depositMonths: null,
      utilitiesDepositMonths: null,
      accessCardDepositPerPcs: null,
      accessCardQuantity: null,
      parkingQuantity: null,
      parkingNumbers: [],
      photoKeys: [],
      videoKeys: [],
      tenancies: [
        {
          id: "t1",
          startDate: new Date("2026-04-25"),
          endDate: new Date("2026-05-20"),
          tenantPartyId: "party-t1",
          // The tenancy's negotiated rent (Decimal), distinct from the unit's
          // asking rentalRate (2600) — the Edit dialog must show THIS, not the
          // asking rate (the reported wrong-rent bug).
          monthlyRentAmount: { toString: () => "1500.00" },
          tenantParty: {
            displayName: "NURUL IZZAH",
            idType: "nric",
            idNumber: "990101-14-5678",
            primaryPhone: "60123456789",
          },
        },
      ],
      apartment: {
        unitCode: "A-22-05",
        bedrooms: 1,
        bathrooms: { toString: () => "1.0" },
        floor: null,
        floorArea: { toString: () => "180.00" },
        amenities: [],
        highlights: [],
        publishedDescription: null,
        photoKeys: [],
        videoKeys: [],
        property: null,
      },
    });
    const { findUnitDetail } = await import("../inventory.repository");
    const detail = await findUnitDetail("o1", "u1");
    // Must carry the new masked fields — and must NOT expose raw idNumber.
    expect(detail?.activeTenancy).toEqual({
      id: "t1",
      tenantPartyId: "party-t1",
      tenantName: "NURUL IZZAH",
      tenantIdType: "nric",
      tenantIdNumberMasked: "••••5678",
      tenantPhone: "+60 12-345 6789",
      startDate: "2026-04-25",
      endDate: "2026-05-20",
      monthlyRentAmount: 1500,
    });
    // Raw idNumber must never appear in the DTO.
    expect(JSON.stringify(detail?.activeTenancy)).not.toContain("990101-14-5678");
  });

  it("returns activeTenancy=null when the listing has no active tenancy", async () => {
    findUnique.mockResolvedValueOnce({
      id: "u1",
      organizationId: "o1",
      apartmentId: "apt-1",
      listingType: "Medium",
      currency: "MYR",
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
      hiddenFromPartyIds: [],
      rentalRate: null,
      moveInDate: null,
      readyNow: false,
      sourcingAgentId: null,
      inChargePartyId: null,
      inChargeName: null,
      inChargeParty: null,
      depositMonths: null,
      utilitiesDepositMonths: null,
      accessCardDepositPerPcs: null,
      accessCardQuantity: null,
      parkingQuantity: null,
      parkingNumbers: [],
      photoKeys: [],
      videoKeys: [],
      tenancies: [],
      apartment: {
        unitCode: "A-22-05",
        bedrooms: 1,
        bathrooms: { toString: () => "1.0" },
        floor: null,
        floorArea: { toString: () => "180.00" },
        amenities: [],
        highlights: [],
        publishedDescription: null,
        photoKeys: [],
        videoKeys: [],
        property: null,
      },
    });
    const { findUnitDetail } = await import("../inventory.repository");
    const detail = await findUnitDetail("o1", "u1");
    expect(detail?.activeTenancy).toBeNull();
  });
});
