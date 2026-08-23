import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @kason/db before importing the service so any in-service `getDb()`
// (used by mergeReadyNowInputs, $transaction, and the find-or-create
// apartment path in createUnitService) reaches a stub.
const prismaMock = {
  listing: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  apartment: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  // Required for the apartment-owner fan-out that also propagates to Carpark rows.
  // `findFirst` backs the owner resolvers' bay scans (R2-3): an active bay is an
  // inheritance fallback, an inactive one is conflict evidence. Defaults to
  // undefined => "no bay carries an owner", which is what these tests assume.
  carpark: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  property: {
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  amenity: {
    findMany: vi.fn(),
  },
  roomType: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  partyRole: {
    findFirst: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation((cb: (tx: typeof prismaMock) => Promise<unknown>) =>
    cb(prismaMock),
  ),
};

vi.mock("@kason/db", () => ({
  getDb: () => prismaMock,
}));

vi.mock("../inventory.repository", async () => {
  const actual = await vi.importActual<
    typeof import("../inventory.repository")
  >("../inventory.repository");
  return {
    listProperties: vi.fn(),
    listListings: vi.fn(),
    findPropertyById: vi.fn(),
    findPropertyStatus: vi.fn(),
    findPropertyCodeConflict: vi.fn(),
    createProperty: vi.fn(),
    updateProperty: vi.fn(),
    updatePropertyPaxDeduction: vi.fn(),
    findListingById: vi.fn(),
    findListingTypeConflict: vi.fn(),
    findUnitDetail: vi.fn(),
    createListingTx: vi.fn(),
    updateListing: vi.fn(),
    // updateListingTx must be the actual implementation so the field-mapping
    // whitelist runs and prismaMock.listing.update receives the correct payload.
    updateListingTx: actual.updateListingTx,
    replaceVisibilityGrants: vi.fn(),
    recomputeReadyNowForProperty: vi.fn(),
  };
});

vi.mock("../amenities/amenities.service", () => ({
  assertAmenitiesBelongToOrgService: vi.fn(),
}));

vi.mock("../occupancy-tenancy-sync", () => ({
  syncOccupancyTenancy: vi.fn(),
}));

vi.mock("../listing-mode", () => ({
  getUnitGroupMode: vi.fn().mockResolvedValue(null),
  resolveRoomTypeKind: vi.fn().mockResolvedValue(null),
}));

import {
  createPropertyService,
  getInventorySummaryService,
  updateUnitService,
} from "../inventory.service";

import * as repo from "../inventory.repository";
import { assertAmenitiesBelongToOrgService } from "../amenities/amenities.service";
import * as listingMode from "../listing-mode";

const mockedRepo = vi.mocked(repo);
const mockedAmenityService = vi.mocked({ assertAmenitiesBelongToOrgService });

const session = {
  userId: "u-1",
  orgId: "org-1",
  role: "admin",
};

describe("inventory.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.property.count.mockResolvedValue(2);
    prismaMock.listing.findMany.mockResolvedValue([
      { occupancyStatus: "occupied" },
      { occupancyStatus: "vacant" },
      { occupancyStatus: "occupied" },
    ]);
  });

  it("computes summary from property and listing rows", async () => {
    const summary = await getInventorySummaryService(session);
    expect(summary.propertyCount).toBe(2);
    expect(summary.unitCount).toBe(3);
    expect(summary.occupiedUnits).toBe(2);
    expect(summary.vacantUnits).toBe(1);
  });

  it("blocks duplicate property code", async () => {
    mockedRepo.findPropertyCodeConflict.mockResolvedValueOnce({ id: "dup" } as never);

    const result = await createPropertyService(session, {
      name: "Foo",
      propertyCode: "P-001",
      propertyType: "condo",
      addressLine1: "addr",
      city: "KL",
      country: "MY",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("already exists");
    }
  });
});

describe("updateUnitService — cross-org amenity isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findUnique.mockReset();
    prismaMock.listing.update.mockReset();
    prismaMock.property.findFirst.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    // Default: listing lookup succeeds with an org-1 row.
    mockedRepo.findListingById.mockResolvedValue({
      id: "u1",
      organizationId: "org-1",
      apartmentId: "apt-1",
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
      rentalRate: null,
    } as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });
  });

  it("returns 422 when input.amenities includes an ID not in the listing's org; listing UNCHANGED", async () => {
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({
      ok: false,
      status: 422,
      error: { code: "amenity_org_mismatch", message: "missing: a-other-org" },
    });

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      amenities: ["a-other-org"],
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toMatchObject({ code: "amenity_org_mismatch" });
    }
    // CRITICAL: no listing row was mutated.
    expect(prismaMock.listing.update).not.toHaveBeenCalled();
  });

  it("succeeds when all amenity IDs belong to the listing's org", async () => {
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true });
    prismaMock.listing.update.mockResolvedValue({ id: "u1" } as never);

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      amenities: ["a1", "a2"],
    } as never);

    expect(result.ok).toBe(true);
    expect(prismaMock.listing.update).toHaveBeenCalledTimes(1);
  });

  it("skips the cross-org check entirely when amenities is empty (perf optimization)", async () => {
    prismaMock.listing.update.mockResolvedValue({ id: "u1" } as never);

    const { updateUnitService } = await import("../inventory.service");
    await updateUnitService(session, { unitId: "u1", amenities: [] } as never);

    expect(mockedAmenityService.assertAmenitiesBelongToOrgService).not.toHaveBeenCalled();
  });
});

describe("createUnitService — cross-org amenity isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findUnique.mockReset();
    prismaMock.property.findFirst.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.apartment.create.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    mockedRepo.replaceVisibilityGrants.mockResolvedValue(undefined as never);
    // No pre-existing apartment by default — find-or-create takes the create path.
    prismaMock.apartment.findFirst.mockResolvedValue(null);
    prismaMock.apartment.create.mockResolvedValue({ id: "apt-new" });
  });

  it("returns 422 when input.amenities includes an ID not in the session's org; listing NOT created", async () => {
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({
      ok: false,
      status: 422,
      error: { code: "amenity_org_mismatch", message: "missing: a-other-org" },
    });

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      amenities: ["a-other-org"],
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toMatchObject({ code: "amenity_org_mismatch" });
    }
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  it("succeeds when all amenity IDs belong to the session's org", async () => {
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true });
    mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      amenities: ["a1", "a2"],
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  it("skips the cross-org check entirely when amenities is empty (perf optimization)", async () => {
    mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);

    const { createUnitService } = await import("../inventory.service");
    await createUnitService(session, {
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      amenities: [],
    } as never);

    expect(mockedAmenityService.assertAmenitiesBelongToOrgService).not.toHaveBeenCalled();
  });

  it("editor setting commission on an occupied create → 403 COMMISSION_FIELDS_FORBIDDEN, listing NOT created", async () => {
    const editorSession = { ...session, role: "editor" };
    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(editorSession as never, {
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      occupancyStatus: "occupied",
      tenantPartyId: "t1",
      moveInDate: "2026-07-01",
      moveOutDate: "2026-07-31",
      firstMonthIsCommission: true,
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect((result as { code?: string }).code).toBe("COMMISSION_FIELDS_FORBIDDEN");
    }
    // Guard fired PRE-transaction — no listing write happened.
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });
});

describe("createUnitService — apartment owner inheritance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findFirst.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.apartment.create.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    mockedRepo.replaceVisibilityGrants.mockResolvedValue(undefined as never);
    mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true } as never);
    // Existing apartment so find-or-create returns it (owner may live on a sibling).
    prismaMock.apartment.findFirst.mockResolvedValue({ id: "apt-1" });
  });

  it("a room added to an already-owned apartment inherits the owner", async () => {
    // A non-archived sibling already carries the apartment's owner.
    prismaMock.listing.findFirst.mockResolvedValue({ ownerPartyId: "owner-x" });
    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-03-07",
      unitType: "Small",
      amenities: [],
    } as never);
    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerPartyId: "owner-x" }),
    );
  });

  it("a room in an ownerless apartment is created with null owner", async () => {
    prismaMock.listing.findFirst.mockResolvedValue(null);
    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-03-07",
      unitType: "Small",
      amenities: [],
    } as never);
    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerPartyId: null }),
    );
  });
});

describe("createUnitsBatchService — apartment owner inheritance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findFirst.mockReset();
    prismaMock.listing.findMany.mockReset();
    prismaMock.listing.create.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.apartment.create.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true } as never);
    // Existing apartment, no listing-type conflicts.
    prismaMock.apartment.findFirst.mockResolvedValue({ id: "apt-1" });
    prismaMock.listing.findMany.mockResolvedValue([]);
    prismaMock.listing.create.mockResolvedValue({ id: "room-new" });
  });

  it("new rooms inherit the apartment's existing owner", async () => {
    prismaMock.listing.findFirst.mockResolvedValue({ ownerPartyId: "owner-x" });
    const { createUnitsBatchService } = await import("../inventory.service");
    const result = await createUnitsBatchService(session, {
      shared: { propertyId: "p1", unitCode: "A-03-07", amenities: [] },
      rooms: [{ unitType: "Medium", rentalRate: 1000 }],
    } as never);
    expect(result.ok).toBe(true);
    expect(prismaMock.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerPartyId: "owner-x" }),
      }),
    );
  });

  it("new rooms in an ownerless apartment are created with null owner", async () => {
    prismaMock.listing.findFirst.mockResolvedValue(null);
    const { createUnitsBatchService } = await import("../inventory.service");
    const result = await createUnitsBatchService(session, {
      shared: { propertyId: "p1", unitCode: "A-03-07", amenities: [] },
      rooms: [{ unitType: "Medium", rentalRate: 1000 }],
    } as never);
    expect(result.ok).toBe(true);
    expect(prismaMock.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerPartyId: null }),
      }),
    );
  });
});

describe("createUnitService — listing-mode kind validation", () => {
  const mockedListingMode = vi.mocked(listingMode);

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findUnique.mockReset();
    prismaMock.listing.findMany.mockReset();
    prismaMock.roomType.findMany.mockReset();
    prismaMock.roomType.findFirst.mockReset();
    prismaMock.property.findFirst.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.apartment.create.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    mockedRepo.replaceVisibilityGrants.mockResolvedValue(undefined as never);
    mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true } as never);
    mockedListingMode.getUnitGroupMode.mockResolvedValue(null);
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue(null);
    prismaMock.apartment.findFirst.mockResolvedValue(null);
    prismaMock.apartment.create.mockResolvedValue({ id: "apt-new" });
  });

  it("rejects a PARTITION unitType when sibling group is WHOLE", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("PARTITION");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("WHOLE");

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-01",
      unitType: "Master",
      amenities: [],
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatchObject({
      code: "LISTING_MODE_MISMATCH",
      currentMode: "WHOLE",
      attemptedKind: "PARTITION",
    });
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  it("allows a matching-kind PARTITION unitType in a PARTITIONED group", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("PARTITION");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("PARTITIONED");

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-02",
      unitType: "Medium",
      amenities: [],
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  it("allows any kind when currentMode is null (first listing in group)", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("PARTITION");
    mockedListingMode.getUnitGroupMode.mockResolvedValue(null);

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-03",
      unitType: "Master",
      amenities: [],
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  it("allows any kind when currentMode is MIXED (legacy data — no block)", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("WHOLE");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("MIXED");

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-04",
      unitType: "Studio",
      amenities: [],
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  it("allows any unitType when resolveRoomTypeKind returns null (unknown/legacy type)", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue(null);
    mockedListingMode.getUnitGroupMode.mockResolvedValue("WHOLE");

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-05",
      unitType: "LegacyType",
      amenities: [],
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  it("rejects a WHOLE unitType when sibling group is PARTITIONED", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("WHOLE");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("PARTITIONED");

    const { createUnitService } = await import("../inventory.service");
    const result = await createUnitService(session, {
      propertyId: "p1",
      unitCode: "A-99-06",
      unitType: "Studio",
      amenities: [],
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatchObject({
      code: "LISTING_MODE_MISMATCH",
      currentMode: "PARTITIONED",
      attemptedKind: "WHOLE",
    });
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });
});

describe("updateUnitService — ownerPartyId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.update.mockReset();
    prismaMock.partyRole.findFirst.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    // Default: listing lookup succeeds with an org-1 row.
    mockedRepo.findListingById.mockResolvedValue({
      id: "u1",
      organizationId: "org-1",
      apartmentId: "apt-1",
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "studio",
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
      rentalRate: null,
    } as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });
    prismaMock.listing.update.mockResolvedValue({ id: "u1" } as never);
    // Fan-out: updateMany must return a count for the audit recordAudit meta.
    prismaMock.listing.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.carpark.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.auditLog.create.mockResolvedValue(undefined);
  });

  it("persists ownerPartyId when party has the owner role", async () => {
    // Party is confirmed as an owner in this org.
    prismaMock.partyRole.findFirst.mockResolvedValue({ id: "role-1" });

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      ownerPartyId: "owner-party-1",
    } as never);

    expect(result.ok).toBe(true);
    // Owner is now apartment-scoped — written via updateMany, NOT the single-row update.
    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerPartyId: "owner-party-1" } }),
    );
    // Single-row update must NOT carry ownerPartyId (it is stripped before write).
    const singleRowCalls = prismaMock.listing.update.mock.calls;
    for (const [arg] of singleRowCalls) {
      expect((arg as { data: Record<string, unknown> })?.data?.ownerPartyId).toBeUndefined();
    }
    // Confirm the role check used the correct org + party + roleType.
    expect(prismaMock.partyRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          partyId: "owner-party-1",
          roleType: "owner",
        }),
      }),
    );
  });

  it("returns 400 when ownerPartyId party has no owner role in the org", async () => {
    // Role lookup returns null → not an owner.
    prismaMock.partyRole.findFirst.mockResolvedValue(null);

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      ownerPartyId: "non-owner-party",
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("not an owner");
    }
    // No listing row should be written.
    expect(prismaMock.listing.update).not.toHaveBeenCalled();
  });

  it("allows clearing ownerPartyId (null) without role check and writes null", async () => {
    // partyRole.findFirst must NOT be called when clearing.
    prismaMock.partyRole.findFirst.mockResolvedValue(null);

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      ownerPartyId: null,
    } as never);

    expect(result.ok).toBe(true);
    // Role check skipped.
    expect(prismaMock.partyRole.findFirst).not.toHaveBeenCalled();
    // Null written apartment-wide via updateMany (not the single-row update).
    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerPartyId: null } }),
    );
    // Single-row update must NOT carry ownerPartyId.
    const singleRowCalls = prismaMock.listing.update.mock.calls;
    for (const [arg] of singleRowCalls) {
      expect((arg as { data: Record<string, unknown> })?.data?.ownerPartyId).toBeUndefined();
    }
  });
});

describe("updateUnitService — listing-mode kind validation", () => {
  const mockedListingMode = vi.mocked(listingMode);

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.listing.findUnique.mockReset();
    prismaMock.listing.findMany.mockReset();
    prismaMock.listing.update.mockReset();
    prismaMock.property.findFirst.mockReset();
    prismaMock.apartment.findFirst.mockReset();
    prismaMock.$transaction.mockImplementation(
      (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock),
    );
    mockedRepo.findListingById.mockResolvedValue({
      id: "u1",
      organizationId: "org-1",
      apartmentId: "apt-1",
      propertyId: "p1",
      unitCode: "U-1",
      unitType: "Master",
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
      rentalRate: null,
    } as never);
    mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "draft",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });
    prismaMock.listing.update.mockResolvedValue({ id: "u1" } as never);
    mockedAmenityService.assertAmenitiesBelongToOrgService.mockResolvedValue({ ok: true } as never);
    mockedListingMode.getUnitGroupMode.mockResolvedValue(null);
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue(null);
  });

  it("rejects a unitType change to WHOLE when sibling group is PARTITIONED", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("WHOLE");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("PARTITIONED");

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      unitType: "Studio",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatchObject({
      code: "LISTING_MODE_MISMATCH",
      currentMode: "PARTITIONED",
      attemptedKind: "WHOLE",
    });
    expect(prismaMock.listing.update).not.toHaveBeenCalled();
  });

  it("skips kind validation when unitType is not being changed in the patch", async () => {
    mockedListingMode.resolveRoomTypeKind.mockResolvedValue("WHOLE");
    mockedListingMode.getUnitGroupMode.mockResolvedValue("PARTITIONED");

    const { updateUnitService } = await import("../inventory.service");
    const result = await updateUnitService(session, {
      unitId: "u1",
      rentalRate: 1200,
    } as never);

    expect(result.ok).toBe(true);
    expect(mockedListingMode.resolveRoomTypeKind).not.toHaveBeenCalled();
  });
});

describe("updateUnitService — apartment-scoped owner", () => {
  const existingMaster = {
    id: "unit-master",
    organizationId: "org-1",
    apartmentId: "apt-1",
    propertyId: "prop-1",
    unitCode: "A-10-04",
    unitType: "Master",
    occupancyStatus: "vacant",
    listingStatus: "listed",
    // `as const` keeps the literal from widening to `string` so the fixture
    // matches the repo's `visibilityMode: $Enums.VisibilityMode` field.
    visibilityMode: "PUBLIC" as const,
    rentalRate: null,
    ownerPartyId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // mergeReadyNowInputs reads the current listing + property.
    prismaMock.listing.findUnique.mockResolvedValue({
      occupancyStatus: "vacant",
      listingStatus: "listed",
      visibilityMode: "PUBLIC",
    });
    prismaMock.property.findFirst.mockResolvedValue({ status: "active" });
    // Owner-role validation passes by default.
    prismaMock.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
    mockedRepo.findListingById.mockResolvedValue(existingMaster);
    // Fan-out updateMany returns a count; audit create resolves void.
    prismaMock.listing.updateMany.mockResolvedValue({ count: 3 });
    // Carpark fan-out: active bays on the apartment must also get the new owner.
    prismaMock.carpark.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.auditLog.create.mockResolvedValue(undefined);
  });

  it("propagates a set owner to every non-archived sibling listing", async () => {
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: "owner-x",
    });
    expect(result.ok).toBe(true);
    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: "org-1",
        listingStatus: { not: "archived" },
      },
      data: { ownerPartyId: "owner-x" },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    // Owner must NOT also be written to the single row via updateListingTx.
    const singleRowCalls = prismaMock.listing.update.mock.calls;
    for (const [arg] of singleRowCalls) {
      expect(arg?.data?.ownerPartyId).toBeUndefined();
    }
  });

  it("propagates a cleared owner (null) to all siblings", async () => {
    mockedRepo.findListingById.mockResolvedValue({
      ...existingMaster,
      ownerPartyId: "owner-x",
    });
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: null,
    });
    expect(result.ok).toBe(true);
    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: "org-1",
        listingStatus: { not: "archived" },
      },
      data: { ownerPartyId: null },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it("rejects a non-owner party and does not propagate", async () => {
    prismaMock.partyRole.findFirst.mockResolvedValue(null);
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: "not-an-owner",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
  });

  it("does not touch owner when ownerPartyId is absent from the patch", async () => {
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      listingStatus: "listed",
    });
    expect(result.ok).toBe(true);
    expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.carpark.updateMany).not.toHaveBeenCalled();
  });

  it("propagates a set owner to active carpark bays on the apartment", async () => {
    // This tests spec line-54: changing an apartment's owner must also update
    // its Carpark rows so a bay never holds a stale ownerPartyId.
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: "owner-new",
    });
    expect(result.ok).toBe(true);
    // Listing fan-out must still happen.
    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerPartyId: "owner-new" } }),
    );
    // Carpark fan-out: skips inactive bays, applies to all others.
    expect(prismaMock.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: "org-1",
        status: { not: "inactive" },
      },
      data: { ownerPartyId: "owner-new" },
    });
  });

  it("propagates a cleared owner (null) to active carpark bays", async () => {
    mockedRepo.findListingById.mockResolvedValue({
      ...existingMaster,
      ownerPartyId: "owner-old",
    });
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: null,
    });
    expect(result.ok).toBe(true);
    expect(prismaMock.carpark.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerPartyId: null } }),
    );
  });

  // F5: the propagate audit must record how many BAYS it touched, not just
  // listings. `affectedCount` alone cannot distinguish "no bays on this
  // apartment" from "the carpark fan-out silently did nothing".
  it("records both the listing and the carpark affected counts on the propagate audit", async () => {
    const result = await updateUnitService(session, {
      unitId: "unit-master",
      ownerPartyId: "owner-x",
    });
    expect(result.ok).toBe(true);

    const auditArg = prismaMock.auditLog.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .find((d: any) => d?.action === "inventory.owner.propagate");
    expect(auditArg).toBeDefined();
    expect(auditArg.meta).toMatchObject({
      ownerPartyId: "owner-x",
      triggeredByUnitId: "unit-master",
      affectedCount: 3, // listing.updateMany → { count: 3 }
      carparkAffectedCount: 1, // carpark.updateMany → { count: 1 }
    });
  });
});

describe("getApartmentsByPropertyService — owner resolution", () => {
  const PROP_ID = "prop-owner-test";
  const APT_ID = "apt-owner-test";
  const OWNER_PARTY_ID = "party-owner-1";

  // Minimal stub for a non-archived listing with owner
  function makeListingWithOwner(id: string) {
    return {
      id,
      listingType: "Whole Unit",
      rentalRate: null,
      occupancyStatus: "vacant",
      listingStatus: "active",
      inChargePartyId: null,
      ownerPartyId: OWNER_PARTY_ID,
      ownerParty: { displayName: "Alice Tan", primaryPhone: "+60123456789" },
      tenancies: [] as Array<{
        tenantPartyId: string;
        tenantParty: { displayName: string };
        startDate: Date;
        endDate: Date | null;
      }>,
    };
  }

  function makeListingNoOwner(id: string) {
    return {
      id,
      listingType: "Whole Unit",
      rentalRate: null,
      occupancyStatus: "vacant",
      listingStatus: "active",
      inChargePartyId: null,
      ownerPartyId: null,
      ownerParty: null,
      tenancies: [] as Array<{
        tenantPartyId: string;
        tenantParty: { displayName: string };
        startDate: Date;
        endDate: Date | null;
      }>,
    };
  }

  function makeApartment(
    listings: Array<
      | ReturnType<typeof makeListingWithOwner>
      | ReturnType<typeof makeListingNoOwner>
    >,
  ) {
    return {
      id: APT_ID,
      organizationId: "org-1",
      propertyId: PROP_ID,
      unitCode: "A-10-04",
      floor: 10,
      bedrooms: 3,
      bathrooms: 2,
      floorArea: 900,
      amenities: [],
      highlights: [],
      publishedDescription: null,
      listingMode: "WHOLE",
      partitionBillingMode: "NO_SUBSIDY",
      tnbSubsidyCapMonthly: null,
      underManagement: true,
      listings,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Property must exist for the service to proceed.
    prismaMock.property.findFirst.mockResolvedValue({ id: PROP_ID });
    // No amenities or room types needed for these tests.
    prismaMock.amenity.findMany.mockResolvedValue([]);
    prismaMock.roomType.findMany.mockResolvedValue([]);
    // Archived rooms are fetched by a separate listing.findMany (the `listings`
    // include excludes them). Owner resolution reads only the LIVE listings, so
    // these tests default it empty; the archivedRooms tests below override it.
    prismaMock.listing.findMany.mockResolvedValue([]);
  });

  it("surfaces ownerPartyId / ownerName / ownerPhone from first non-archived listing with an owner", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingWithOwner("l-1")]),
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(
      session,
      PROP_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const apt = result.data[0];
    expect(apt).toBeDefined();
    expect(apt!.ownerPartyId).toBe(OWNER_PARTY_ID);
    expect(apt!.ownerName).toBe("Alice Tan");
    expect(apt!.ownerPhone).toBe("+60123456789");
  });

  it("returns null owner fields when no listing carries an ownerPartyId", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingNoOwner("l-2")]),
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(
      session,
      PROP_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const apt = result.data[0];
    expect(apt).toBeDefined();
    expect(apt!.ownerPartyId).toBeNull();
    expect(apt!.ownerName).toBeNull();
    expect(apt!.ownerPhone).toBeNull();
  });

  it("returns null owner fields when the apartment has no listings at all", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([makeApartment([])]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(
      session,
      PROP_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const apt = result.data[0];
    expect(apt).toBeDefined();
    expect(apt!.ownerPartyId).toBeNull();
    expect(apt!.ownerName).toBeNull();
    expect(apt!.ownerPhone).toBeNull();
  });

  it("surfaces the apartment monthly TNB subsidy cap as a wire number", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      { ...makeApartment([]), tnbSubsidyCapMonthly: "200.00" },
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.tnbSubsidyCapMonthly).toBe(200);
  });

  it("surfaces owner from a non-null listing when first listing has no owner (find-first-non-null traversal)", async () => {
    // First listing has ownerPartyId=null; second has a real owner.
    // The resolver must scan past position-0 and surface the first non-null hit.
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([
        makeListingNoOwner("l-null"),
        makeListingWithOwner("l-owner"),
      ]),
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(
      session,
      PROP_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const apt = result.data[0];
    expect(apt).toBeDefined();
    expect(apt!.ownerPartyId).toBe(OWNER_PARTY_ID);
    expect(apt!.ownerName).toBe("Alice Tan");
    expect(apt!.ownerPhone).toBe("+60123456789");
  });

  it("returns 404 when property does not belong to the org", async () => {
    prismaMock.property.findFirst.mockResolvedValue(null);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(
      session,
      "nonexistent-prop",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });

  // archivedRooms — deactivated rooms are excluded from `rooms` (every consumer
  // of that field means LIVE rooms) but must still be reachable so admin can
  // restore one. They also keep their listingType reserved in the
  // (apartmentId, listingType) unique index, so the SPA needs them to exclude
  // those types from "add a room".
  function makeArchivedListing(id: string, listingType: string) {
    return {
      id,
      apartmentId: APT_ID,
      listingType,
      rentalRate: null,
      occupancyStatus: "vacant",
      listingStatus: "archived",
      inChargePartyId: null,
    };
  }

  it("surfaces archived rooms under archivedRooms, keeping them out of rooms", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingWithOwner("live-1")]),
    ]);
    prismaMock.listing.findMany.mockResolvedValue([
      makeArchivedListing("arch-1", "Medium"),
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const apt = result.data[0]!;
    expect(apt.rooms.map((r) => r.id)).toEqual(["live-1"]);
    expect(apt.archivedRooms?.map((r) => r.unitType)).toEqual(["Medium"]);
  });

  it("returns an empty archivedRooms when the apartment has none", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingWithOwner("live-1")]),
    ]);
    prismaMock.listing.findMany.mockResolvedValue([]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.archivedRooms).toEqual([]);
  });

  it("buckets archived rooms by apartment — never leaks another apartment's", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingWithOwner("live-1")]),
    ]);
    prismaMock.listing.findMany.mockResolvedValue([
      makeArchivedListing("arch-1", "Medium"),
      { ...makeArchivedListing("arch-other", "Small"), apartmentId: "apt-somewhere-else" },
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.archivedRooms?.map((r) => r.id)).toEqual(["arch-1"]);
  });

  it("does not let an archived listing's owner leak into owner resolution", async () => {
    // Owner is resolved from the `listings` include (live only). An archived
    // row's owner can be STALE — valid conflict evidence, never a valid
    // inheritance source.
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingNoOwner("live-1")]),
    ]);
    prismaMock.listing.findMany.mockResolvedValue([
      { ...makeArchivedListing("arch-1", "Medium"), ownerPartyId: "party-stale" },
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.ownerPartyId).toBeNull();
  });

  it("surfaces tenantName from the active tenancy on a room", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([
        {
          ...makeListingWithOwner("l-1"),
          tenancies: [{
            tenantPartyId: "tenant-bob",
            tenantParty: { displayName: "Bob Lim" },
            startDate: new Date("2026-08-01T00:00:00.000Z"),
            endDate: null,
          }],
        },
      ]),
    ]);
    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.rooms[0]!.tenantName).toBe("Bob Lim");
  });

  it("returns null tenantName when the room has no active tenancy", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([{ ...makeListingNoOwner("l-2"), tenancies: [] }]),
    ]);
    const { getApartmentsByPropertyService } = await import("../inventory.service");
    const result = await getApartmentsByPropertyService(session, PROP_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data[0]!.rooms[0]!.tenantName).toBeNull();
  });

  it("query shape — requests only the active tenancy, newest first, take 1", async () => {
    prismaMock.apartment.findMany.mockResolvedValue([
      makeApartment([makeListingWithOwner("l-1")]),
    ]);

    const { getApartmentsByPropertyService } = await import("../inventory.service");
    await getApartmentsByPropertyService(session, PROP_ID);

    const arg = prismaMock.apartment.findMany.mock.calls[0]![0] as {
      include: { listings: { select: { tenancies?: { where: unknown; orderBy: unknown; take: number } } } };
    };
    const t = arg.include.listings.select.tenancies;
    expect(t).toBeDefined();
    expect(t?.where).toEqual({ status: "active" });
    expect(t?.orderBy).toEqual({ startDate: "desc" });
    expect(t?.take).toBe(1);
  });
});
