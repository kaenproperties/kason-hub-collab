import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Prisma mock — mirrors the style in inventory.service.test.ts. getDb() returns
// `prismaMock` on every path. recordAudit is NOT mocked (its real impl writes via
// <client>.auditLog.create), which lets us prove WHICH client the audit landed
// on: the transaction handle, not the bare connection.
//
// R2-6: `prismaMock` and `txMock` must NOT share per-model spy objects. When they
// did (`{ ...prismaMock, auditLog: ... }` shallow-copies the SAME `apartment`
// object), a production bug that issued `apartment.update` on the BARE client
// still satisfied `expect(txMock.apartment.update).toHaveBeenCalled()` — the spy
// was literally the same function. Every "ran inside the tx" assertion was half a
// pin. A fresh spy set per client makes `txMock.apartment.update` and
// `prismaMock.apartment.update` genuinely different `vi.fn()`s, so the negative
// assertion `expect(prismaMock.apartment.update).not.toHaveBeenCalled()` has teeth.
function makeModelSpies() {
  return {
    listing: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    apartment: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    carpark: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    partyRole: {
      findFirst: vi.fn(),
    },
    managementFeeConfig: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };
}

type ModelSpies = ReturnType<typeof makeModelSpies>;

const prismaMock = { ...makeModelSpies(), $transaction: vi.fn() };

// A DISTINCT transaction handle with DISTINCT per-model spies. $transaction hands
// the callback THIS object, so every "ran inside the tx" assertion is real rather
// than tautological: moving a write onto `db` flips the spy and fails the test.
const txMock = makeModelSpies();

vi.mock("@kason/db", () => ({ getDb: () => prismaMock }));

// Full repo surface stubbed so no named import resolves to undefined. Only the
// create-path functions are exercised here.
vi.mock("../inventory.repository", () => ({
  createListingTx: vi.fn(),
  createProperty: vi.fn(),
  findListingById: vi.fn(),
  findListingTypeConflict: vi.fn(),
  findPropertyById: vi.fn(),
  findPropertyCodeConflict: vi.fn(),
  findPropertyDetail: vi.fn(),
  findPropertyStatus: vi.fn(),
  findUnitDetail: vi.fn(),
  listListings: vi.fn(),
  listProperties: vi.fn(),
  recomputeReadyNowForProperty: vi.fn(),
  replaceVisibilityGrants: vi.fn(),
  searchApartments: vi.fn(),
  updateListingTx: vi.fn(),
  updateProperty: vi.fn(),
  updatePropertyPaxDeduction: vi.fn(),
}));

vi.mock("../amenities/amenities.service", () => ({
  assertAmenitiesBelongToOrgService: vi.fn(),
}));

vi.mock("../listing-mode", () => ({
  getUnitGroupMode: vi.fn().mockResolvedValue(null),
  resolveRoomTypeKind: vi.fn().mockResolvedValue(null),
}));

// The unit under test must call this; the mock lets us observe the exact
// arguments and simulate the rent-required throw without touching the DB.
vi.mock("../occupancy-tenancy-sync", () => ({ syncOccupancyTenancy: vi.fn() }));

// F4. `rematerializeOwnerRecentMonths` self-gates on ENABLE_UNIT_MONTH_LEDGER
// (unit-month-ledger.remateralize-range.ts:13), which ships dark — so spying the OUTER
// call, not any ledger write, is what proves the create paths reached writer parity
// with `updateUnitService` and `updateApartmentSharedService`. Mocking the module also
// keeps this file independent of the flag's env state.
const rematerializeOwnerRecentMonths = vi.hoisted(() =>
  // Typed args so `.mock.calls[0]` is a 3-tuple, not `[]` — the F4 assertions
  // destructure (ctx, partyId, anchor) and index [1]. Mirrors the real
  // rematerializeOwnerRecentMonths(ctx, ownerPartyId, anchor) signature.
  vi.fn(async (_ctx: unknown, _partyId: string, _anchor: Date) => undefined),
);
vi.mock("../../owner-ledger/unit-month-ledger.remateralize-range", () => ({
  rematerializeOwnerRecentMonths,
}));

import { createUnitService, createUnitsBatchService } from "../inventory.service";
import { inventoryRoutes } from "../inventory.routes";
import * as repo from "../inventory.repository";
import { assertAmenitiesBelongToOrgService } from "../amenities/amenities.service";
import { syncOccupancyTenancy } from "../occupancy-tenancy-sync";
// Real (unmocked) schemas — Task T2's own tests validate the schema split
// itself (admin batch gains per-room occupancy, portal batch does not).
import { createUnitsBatchSchema, createPortalUnitsBatchSchema } from "@kason/shared";

const mockedRepo = vi.mocked(repo);
const mockedSync = vi.mocked(syncOccupancyTenancy);
const mockedAmenity = vi.mocked(assertAmenitiesBelongToOrgService);

const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "44444444-4444-4444-8444-444444444444";
const TENANT = "33333333-3333-4333-8333-333333333333";
const PROPERTY = "11111111-1111-4111-8111-111111111111";
const session = { orgId: "00000000-0000-4000-8000-000000000000", userId: "u1", role: "admin" };

const occupiedInput = {
  propertyId: PROPERTY,
  unitCode: "A-18-06",
  unitType: "Master",
  depositMonths: 2,
  utilitiesDepositMonths: 1,
  occupancyStatus: "occupied",
  tenantPartyId: TENANT,
  moveInDate: "2026-07-15",
  moveOutDate: "2027-07-14",
  monthlyRent: 3000,
  ownerPartyId: OWNER,
};

/**
 * Program the four owner-evidence scans independently on one client.
 *
 * The two resolvers under test read four distinct row sets:
 *   - ACTIVE listings   (`listingStatus: { not: "archived" }`) — inheritance source
 *   - ACTIVE bays       (`status: { not: "inactive" }`)        — inheritance source
 *   - ARCHIVED listings (`listingStatus: "archived"`)          — conflict evidence only
 *   - INACTIVE bays     (`status: "inactive"`)                 — conflict evidence only
 *
 * F6: dispatching on the status filter alone did NOT pin the query. Every scan is
 * now asserted to carry `organizationId`, `apartmentId`, `ownerPartyId: { not: null }`
 * and a deterministic `orderBy`, and an unrecognised WHERE shape THROWS rather than
 * falling through to `null` — a silent `null` let a mis-filtered scan read as
 * "no evidence" and pass. Which resolver ran is pinned separately by
 * `countConflictTierScans` below.
 */
function assertOwnerScanShape(args: unknown, model: "listing" | "carpark") {
  const a = args as {
    where?: Record<string, unknown>;
    orderBy?: unknown;
  };
  const where = a?.where ?? {};
  expect(where).toMatchObject({
    organizationId: session.orgId,
    apartmentId: expect.any(String),
    ownerPartyId: { not: null },
  });
  // `findFirst` without an orderBy returns an arbitrary row.
  expect(a.orderBy).toEqual({ id: "asc" });
  expect(where[model === "listing" ? "listingStatus" : "status"]).toBeDefined();
}

function stubOwnerScans(
  m: ModelSpies,
  opts: {
    activeListing?: string | null;
    archivedListing?: string | null;
    activeBay?: string | null;
    inactiveBay?: string | null;
  },
) {
  m.listing.findFirst.mockImplementation((args: unknown) => {
    assertOwnerScanShape(args, "listing");
    const status = (args as { where?: { listingStatus?: unknown } })?.where?.listingStatus;
    if (status && typeof status === "object" && (status as { not?: string }).not === "archived") {
      return Promise.resolve(opts.activeListing ? { ownerPartyId: opts.activeListing } : null);
    }
    if (status === "archived") {
      return Promise.resolve(opts.archivedListing ? { ownerPartyId: opts.archivedListing } : null);
    }
    throw new Error(`unexpected listing owner-scan filter: ${JSON.stringify(status)}`);
  });
  m.carpark.findFirst.mockImplementation((args: unknown) => {
    assertOwnerScanShape(args, "carpark");
    const status = (args as { where?: { status?: unknown } })?.where?.status;
    if (status && typeof status === "object" && (status as { not?: string }).not === "inactive") {
      return Promise.resolve(opts.activeBay ? { ownerPartyId: opts.activeBay } : null);
    }
    if (status === "inactive") {
      return Promise.resolve(opts.inactiveBay ? { ownerPartyId: opts.inactiveBay } : null);
    }
    throw new Error(`unexpected carpark owner-scan filter: ${JSON.stringify(status)}`);
  });
}

/**
 * Count the scans only `resolveApartmentOwnerForConflict` performs: the ARCHIVED
 * listing scan and the INACTIVE bay scan. `resolveApartmentOwnerPartyId` never
 * issues either. This is what tells the two resolvers apart at a call site.
 */
function countConflictTierScans(m: ModelSpies): number {
  const archived = m.listing.findFirst.mock.calls.filter(
    ([a]) => (a as { where?: { listingStatus?: unknown } })?.where?.listingStatus === "archived",
  ).length;
  const inactiveBays = m.carpark.findFirst.mock.calls.filter(
    ([a]) => (a as { where?: { status?: unknown } })?.where?.status === "inactive",
  ).length;
  return archived + inactiveBays;
}

/** Apartment `apt-1` already exists, on BOTH clients (pre-tx read + in-tx read). */
function stubExistingApartment(
  partitionBillingMode: string | null = "NO_SUBSIDY",
  tnbSubsidyCapMonthly: number | null = null,
) {
  prismaMock.apartment.findFirst.mockResolvedValue({
    id: "apt-1",
    partitionBillingMode,
    tnbSubsidyCapMonthly,
  });
  txMock.apartment.findFirst.mockResolvedValue({
    id: "apt-1",
    partitionBillingMode,
    tnbSubsidyCapMonthly,
  });
}

function stubDefaults(m: ModelSpies) {
  // Brand-new apartment (no siblings, no inherited owner) by default.
  m.apartment.findFirst.mockResolvedValue(null);
  m.apartment.create.mockResolvedValue({ id: "apt-new" });
  m.apartment.update.mockResolvedValue({ id: "apt-new" });
  m.listing.findFirst.mockResolvedValue(null);
  m.listing.findMany.mockResolvedValue([]);
  m.listing.create.mockResolvedValue({ id: "room-new" });
  m.listing.updateMany.mockResolvedValue({ count: 0 });
  m.carpark.findFirst.mockResolvedValue(null);
  m.carpark.updateMany.mockResolvedValue({ count: 0 });
  // Owner-role check passes by default; overridden per-test for the reject case.
  m.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
  m.managementFeeConfig.updateMany.mockResolvedValue({ count: 0 });
  m.managementFeeConfig.create.mockResolvedValue({ id: "fee-config-1" });
  m.auditLog.create.mockResolvedValue(undefined);
}

/** The audit rows recorded through the tx handle, as `{ action, ... }` objects. */
function txAudits(): Array<Record<string, unknown>> {
  return txMock.auditLog.create.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}

function txAudit(action: string): Record<string, unknown> | undefined {
  return txAudits().find((a) => a.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction hands the callback the DISTINCT txMock.
  prismaMock.$transaction.mockImplementation(
    (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
  );
  stubDefaults(prismaMock);
  stubDefaults(txMock);
  mockedRepo.findPropertyStatus.mockResolvedValue("active" as never);
  mockedRepo.findListingTypeConflict.mockResolvedValue(null as never);
  mockedRepo.createListingTx.mockResolvedValue({ id: "u-new" } as never);
  mockedRepo.replaceVisibilityGrants.mockResolvedValue(undefined as never);
  mockedAmenity.mockResolvedValue({ ok: true } as never);
  mockedSync.mockReset();
});

describe("createUnitService — occupancy materialisation", () => {
  it("materialises a tenancy inside the create transaction", async () => {
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledTimes(1);
    const arg = mockedSync.mock.calls[0]![0];
    // Money-critical: sync runs on the DISTINCT transaction handle the listing
    // write used, so the Tenancy rolls back with the Listing (no orphan).
    // arg.tx === txMock && arg.tx !== prismaMock is only true when the call sits
    // INSIDE db.$transaction and receives its `tx` — not the bare client.
    expect(arg.tx).toBe(txMock);
    expect(arg.tx).not.toBe(prismaMock);
    expect(mockedRepo.createListingTx.mock.calls[0]![0]).toBe(txMock);
    // The sync attaches to the newly-created listing row.
    expect(arg.unit.id).toBe("u-new");
    expect(arg.unit.propertyId).toBe(PROPERTY);
    // Prior state of a just-created row is vacant, not occupied.
    expect(arg.unit.occupancyStatus).toBe("vacant");
    // Explicit modal owner is threaded to the sync unit AND stamped on the row
    // (B3: the explicit owner is used when the apartment has no owner yet).
    expect(arg.unit.ownerPartyId).toBe(OWNER);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: OWNER }),
    );
    expect(arg.incoming.occupancyStatus).toBe("occupied");
    expect(arg.incoming.tenantPartyId).toBe(TENANT);
    expect(arg.incoming.monthlyRent).toBe(3000);
    // Dates must reach sync as Date objects, not the raw ISO strings.
    expect(arg.incoming.moveInDate).toBeInstanceOf(Date);
    expect(arg.incoming.moveOutDate).toBeInstanceOf(Date);
    // Audits written THROUGH the tx handle, never the bare client. This is a
    // FIRST owner assignment (brand-new apartment), so R2-1's fan-out audit
    // rides alongside the occupancy audit.
    expect(txAudit("inventory.unit.created_occupied")).toBeDefined();
    expect(txAudit("inventory.owner.propagate")).toBeDefined();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  // Acceptance substring: "rejects occupied without an owner"
  it("rejects occupied without an owner (409 UNIT_HAS_NO_OWNER)", async () => {
    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    // Rejected before any write; no sync, no listing, no post-tx side effects.
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedRepo.replaceVisibilityGrants).not.toHaveBeenCalled();
  });

  // Minor: the "existing apartment with NO owner" branch of the 409 guard.
  it("rejects occupied on an existing ownerless apartment (409 UNIT_HAS_NO_OWNER)", async () => {
    stubExistingApartment();
    // No sibling and no bay carries an owner → both resolvers return null.
    stubOwnerScans(prismaMock, {});
    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  // Acceptance substring: "rejects a non-owner party"
  it("rejects a non-owner party (400)", async () => {
    // Valid uuid, but no owner PartyRole for it in this org.
    prismaMock.partyRole.findFirst.mockResolvedValue(null);
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toBe("Assigned party is not an owner");
    // The role check scoped org + party + owner role.
    expect(prismaMock.partyRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: session.orgId,
          partyId: OWNER,
          roleType: "owner",
        }),
      }),
    );
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedRepo.replaceVisibilityGrants).not.toHaveBeenCalled();
  });

  // Acceptance substring: "maps rent-required to 400"
  it("maps rent-required to 400, not a 500", async () => {
    mockedSync.mockRejectedValueOnce(
      Object.assign(new Error("rent required"), { _occupancyRentRequired: true }),
    );
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toEqual(
      expect.objectContaining({ code: "OCCUPANCY_RENT_REQUIRED" }),
    );
    // The throw aborted the transaction, so no post-tx side effect ran.
    expect(mockedRepo.replaceVisibilityGrants).not.toHaveBeenCalled();
  });

  // Finding 2: an occupied create with occupancyStatus="occupied" but NO tenancy
  // trio must be REJECTED (400) exactly like the update path — never persisted as
  // an occupied Listing with no Tenancy behind it.
  it("rejects an occupied create with no tenancy trio (400)", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-19-01",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "occupied",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toBe(
      "When marking a unit as Occupied, the following are required: tenant, move-in date, move-out date.",
    );
    // Nothing written: no listing, no tenancy.
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  // Acceptance substring: "vacant path unchanged"
  it("vacant path unchanged (no sync, no audit)", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-18-07",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(mockedSync).not.toHaveBeenCalled();
    // No owner anywhere → no fan-out, so no audit at all.
    expect(txMock.auditLog.create).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).toHaveBeenCalledTimes(1);
  });

  // Finding 1 (B1): owner is APARTMENT-scoped. Adding a room whose explicit owner
  // DIFFERS from the apartment's existing owner must never silently re-point the
  // apartment — reject 409 APARTMENT_OWNER_CONFLICT and write nothing.
  it("rejects adding a room whose owner differs from the apartment's owner (409 APARTMENT_OWNER_CONFLICT)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: OTHER_OWNER });
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    // Rejected before any write: no listing, no tenancy.
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  // Finding 1 (B2): an explicit owner that MATCHES the apartment's existing owner
  // proceeds — this is not a re-point.
  it("proceeds when the explicit owner matches the apartment's existing owner", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: OWNER }),
    );
    expect(mockedSync.mock.calls[0]![0].unit.ownerPartyId).toBe(OWNER);
    // R2-1: the apartment ALREADY had this owner — not a first assignment, so no
    // fan-out and no propagate audit. Re-pointing stays Edit-shared-details' job.
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  // B10 — no explicit owner, but the apartment already has one (inherited): this
  // SUCCEEDS (not a 409) and sync receives the inherited owner.
  it("materialises with the inherited owner when none is supplied (not a 409)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: "owner-inherited" });
    stubOwnerScans(txMock, { activeListing: "owner-inherited" });
    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0]![0].unit.ownerPartyId).toBe("owner-inherited");
    // Owner-role check is skipped when no explicit owner is supplied.
    expect(prismaMock.partyRole.findFirst).not.toHaveBeenCalled();
    // No explicit owner → nothing to fan out.
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
  });

  it("persists billing mode on the created apartment", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-20-01",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      partitionBillingMode: "SUBSIDY",
    } as never);
    expect(res.ok).toBe(true);
    // R2-6: the apartment is created THROUGH the tx handle, never the bare client.
    expect(txMock.apartment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ partitionBillingMode: "SUBSIDY" }),
      }),
    );
    expect(prismaMock.apartment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R2-1 — explicit owner on create must FAN OUT to ownerless siblings + bays
// ---------------------------------------------------------------------------
describe("createUnitService — R2-1 first-owner fan-out", () => {
  it("fans an explicit owner out to ownerless siblings and active bays, with an audit", async () => {
    // A-12-03 exists with rooms R1,R2 (ownerPartyId=null) and bays (null).
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 3 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 2 });

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(true);

    // Every NON-ARCHIVED sibling receives the owner...
    expect(txMock.listing.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: session.orgId,
        listingStatus: { not: "archived" },
      },
      data: { ownerPartyId: OWNER },
    });
    // ...as does every NON-INACTIVE carpark bay.
    expect(txMock.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: session.orgId,
        status: { not: "inactive" },
      },
      data: { ownerPartyId: OWNER },
    });
    // The fan-out is audited, mirroring updateUnitService.
    expect(txAudit("inventory.owner.propagate")).toEqual(
      expect.objectContaining({
        action: "inventory.owner.propagate",
        entityType: "Apartment",
        entityId: "apt-1",
        meta: expect.objectContaining({
          ownerPartyId: OWNER,
          triggeredByUnitId: "u-new",
          // F5: `affectedCount` is LISTINGS only. Without the bay count an auditor
          // cannot tell whether the carpark fan-out ran at all.
          affectedCount: 3,
          carparkAffectedCount: 2,
        }),
      }),
    );
    // R2-6: the fan-out ran on the tx handle, so it rolls back with the listing.
    expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  // Minor 5 + F2. `rooms: []` against a BRAND-NEW apartment: both updateMany calls
  // match zero rows (no siblings yet, no bays) and no room was created, so the owner
  // is stored NOWHERE AT ALL.
  //
  // Minor 5's half: an `inventory.owner.propagate` audit asserting a propagation that
  // did not happen is a false audit row. Suppressing it is right.
  //
  // F2's half: suppressing the audit and then returning 201 is worse — the owner
  // passed the org+role check and both conflict guards, and was then silently
  // discarded. "Accepted by the schema, dropped by the service" is the exact defect
  // class this task exists to eliminate. Reject instead.
  it("409s APARTMENT_OWNER_UNASSIGNABLE, writing no propagate audit, when nothing can carry the owner", async () => {
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 0 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 0 });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-NEW", ownerPartyId: OWNER },
      rooms: [],
      applyToExistingSiblings: true,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    // `code` is a TOP-LEVEL sibling of `error`, matching APARTMENT_OWNER_CONFLICT.
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_UNASSIGNABLE");
    // The fan-out still RAN (both updateMany calls were issued)...
    expect(txMock.listing.updateMany).toHaveBeenCalled();
    expect(txMock.carpark.updateMany).toHaveBeenCalled();
    // ...it just matched nothing, so it must not claim otherwise.
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  // F2's boundary. `rooms: []` + an explicit owner the apartment ALREADY carries is
  // NOT the discard case: the active siblings hold that owner, so nothing was dropped
  // and 201 is the truthful answer. The first-owner fan-out never runs here
  // (`inheritedOwnerPartyId` is non-null), so "the fan-out moved no rows" is trivially
  // true — which is exactly why the UNASSIGNABLE guard must live INSIDE the
  // first-assignment branch and not be phrased as "zero rows fanned out".
  it("still 201s a rooms:[] batch whose owner the apartment already carries", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "A-12-03", ownerPartyId: OWNER },
      rooms: [],
      applyToExistingSiblings: false,
    } as never);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(201);
    // No FIRST assignment happened, so no fan-out and no propagate audit.
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  // Minor 5, positive half: a fan-out that DID affect rows is still audited. Without
  // this, "never audit" would pass the test above.
  it("still audits a fan-out that affected only carpark bays", async () => {
    stubExistingApartment("NO_SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 0 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 2 });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-BAY", ownerPartyId: OWNER },
      rooms: [],
      applyToExistingSiblings: true,
    } as never);

    expect(res.ok).toBe(true);
    expect(txAudit("inventory.owner.propagate")).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ affectedCount: 0, carparkAffectedCount: 2 }),
      }),
    );
  });

  // Minor 5, the case the `triggeredByUnitId` clause protects: `listingStatus` is a
  // free string on the create schema, so a create can mint an ARCHIVED listing. The
  // fan-out's updateMany excludes archived rows and matches 0 — but createListingTx
  // already stamped the owner onto that row, so the assignment is real and must stay
  // audited. Suppressing on the two counts alone would erase its only trail.
  it("still audits when nothing was updated but a row was created to carry the owner", async () => {
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 0 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 0 });

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-09",
      unitType: "Small",
      bedrooms: 1,
      bathrooms: 1,
      rentalRate: 900,
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      listingStatus: "archived",
      ownerPartyId: OWNER,
    } as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: OWNER, listingStatus: "archived" }),
    );
    expect(txAudit("inventory.owner.propagate")).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          ownerPartyId: OWNER,
          triggeredByUnitId: "u-new",
          affectedCount: 0,
          carparkAffectedCount: 0,
        }),
      }),
    );
  });

  // ------------------------------------------------------------------
  // F4 — a first-owner assignment made through a CREATE must re-materialise the
  // owner's ledger, exactly as the same assignment made through unit-edit
  // (`updateUnitService`) or "Edit shared details" (`updateApartmentSharedService`)
  // already does. Without this, the identical money event has two different ledger
  // outcomes depending on which screen the admin used.
  // ------------------------------------------------------------------
  it("re-materialises the new owner's ledger after a first-owner fan-out (single create)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 3 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 2 });

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(true);

    expect(rematerializeOwnerRecentMonths).toHaveBeenCalledTimes(1);
    const [ctx, partyId, anchor] = rematerializeOwnerRecentMonths.mock.calls[0]!;
    // Mirrors updateUnitService's OwnerBillingActorCtx shape exactly.
    expect(ctx).toEqual({ orgId: session.orgId, actorUserId: session.userId, actorRole: "admin" });
    expect(partyId).toBe(OWNER);
    expect(anchor).toBeInstanceOf(Date);
  });

  it("re-materialises the new owner's ledger after a first-owner fan-out (batch create)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 0 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 2 });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "A-12-03", ownerPartyId: OWNER },
      rooms: [],
      applyToExistingSiblings: true,
    } as never);
    expect(res.ok).toBe(true);

    expect(rematerializeOwnerRecentMonths).toHaveBeenCalledTimes(1);
    expect(rematerializeOwnerRecentMonths.mock.calls[0]![1]).toBe(OWNER);
  });

  // The negative half. A create that assigns no owner, or whose fan-out moved no rows,
  // has moved no money — re-materialising would be a pointless 13-month recompute.
  it("does not re-materialise when no fan-out fired", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });

    // Owner already on the apartment => inherited, not a FIRST assignment.
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(true);
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(rematerializeOwnerRecentMonths).not.toHaveBeenCalled();
  });

  // The archived-create edge: `createListingTx` stamped the owner on the new row, so
  // the assignment is real and stays AUDITED — but both updateMany calls matched zero
  // rows, so no pre-existing row changed hands and no charge moved ledgers. A
  // just-created row carries no charges yet, so there is nothing to rebuild.
  it("does not re-materialise when the fan-out matched zero rows", async () => {
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.updateMany.mockResolvedValue({ count: 0 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 0 });

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-09",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      listingStatus: "archived",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(true);
    // The assignment is still audited (the created row carries the owner)...
    expect(txAudit("inventory.owner.propagate")).toBeDefined();
    // ...but nothing changed hands, so no ledger rebuild.
    expect(rematerializeOwnerRecentMonths).not.toHaveBeenCalled();
  });

  // F6. `findOrCreateApartment` records `action: "apartment.shared.update"` for an
  // Apartment it just CREATED. An auditor filtering that action sees creation rows
  // among the edits. The action stays put (other consumers filter on it); the `diff`
  // carries a `source` discriminator so the two are separable.
  it("discriminates the create-path apartment audit with source: unit-create", async () => {
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "TD-BRAND-NEW",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      partitionBillingMode: "SUBSIDY",
    } as never);
    expect(res.ok).toBe(true);

    const apartmentAudit = txAudit("apartment.shared.update");
    expect(apartmentAudit).toBeDefined();
    expect(apartmentAudit?.diff).toEqual({
      partitionBillingMode: "SUBSIDY",
      source: "unit-create",
    });
  });

  it("does not fan out when the effective owner is null", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R2-3 — inheritance source vs conflict evidence are DIFFERENT scans
// ---------------------------------------------------------------------------
describe("resolveApartmentOwner* — R2-3 inheritance vs conflict evidence", () => {
  it("rejects a differing owner when the only evidence is an ARCHIVED sibling (409)", async () => {
    stubExistingApartment();
    // Nothing active carries an owner; an archived room remembers OTHER_OWNER.
    stubOwnerScans(prismaMock, { archivedListing: OTHER_OWNER });
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  it("rejects a differing owner when the only evidence is an ACTIVE carpark bay (409)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeBay: OTHER_OWNER });
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  it("rejects a differing owner when the only evidence is an INACTIVE bay (409)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { inactiveBay: OTHER_OWNER });
    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
  });

  // F1. A bay is NOT an inheritance source. A bay whose apartment has no owned,
  // non-archived listing is in the same epistemic position as an archived listing:
  // it proves SOMEONE owns the apartment, not WHO. Bays minted before 2ce46923 (the
  // `updateApartmentSharedService` fan-out) and before 7fe7eb65 (which stopped
  // minting bays from archived owners) can hold a stale owner on real data, and no
  // carpark backfill exists — `scripts/backfill-apartment-owner.ts:15` puts carparks
  // explicitly out of scope. Stamping that stale owner onto a new `Listing` then
  // attributes the WHOLE apartment's charges to it (owner-ledger.sync-hook.ts:77-79).
  // Ownerless is the safe direction; ownerless-but-wrong is not.
  it("is born OWNERLESS when the apartment's only owned row is an active bay", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeBay: "owner-bay" });
    stubOwnerScans(txMock, { activeBay: "owner-bay" });
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: null }),
    );
    // The in-tx inheritance read is the ONLY owner scan on this path (no explicit
    // owner ⇒ no conflict re-check), and it must never touch the carpark table.
    expect(txMock.carpark.findFirst).not.toHaveBeenCalled();
  });

  // The load-bearing asymmetry: BOTH fan-out writers exclude archived listings, so
  // an archived row's ownerPartyId can be STALE. It is valid evidence of a
  // CONFLICT but must never be inherited.
  it("NEVER inherits from an archived sibling (stale owner)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { archivedListing: "owner-stale" });
    stubOwnerScans(txMock, { archivedListing: "owner-stale" });
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: null }),
    );
    // A stale owner must not trigger the first-assignment fan-out either.
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Minor 6 — the UNIT_HAS_NO_OWNER guard must read the INHERITANCE resolver.
  //
  // Point it at `resolveApartmentOwnerForConflict` instead and these two flip to
  // ok:true: the conflict resolver reports an owner from an archived listing / an
  // inactive bay, so the guard would wave the create through and the new room would
  // be born ownerless — occupied, with a Tenancy, attributed to nobody.
  // ------------------------------------------------------------------
  it("409s an occupied create whose only owner evidence is an ARCHIVED sibling", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { archivedListing: OTHER_OWNER });
    stubOwnerScans(txMock, { archivedListing: OTHER_OWNER });

    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("409s an occupied create whose only owner evidence is an INACTIVE bay", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { inactiveBay: OTHER_OWNER });
    stubOwnerScans(txMock, { inactiveBay: OTHER_OWNER });

    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  // F1. An ACTIVE bay now joins the archived listing and the inactive bay: evidence
  // that someone owns the apartment, not evidence of who. The guard reads the
  // INHERITANCE resolver ("an owner we would actually stamp"), so a bay-only
  // apartment cannot mint an occupied room. Point the guard at the attributed or
  // conflict resolver and this flips to ok:true — the room would be created
  // occupied, with a Tenancy, carrying a possibly-stale owner.
  it("409s an occupied create whose only owner evidence is an ACTIVE bay", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeBay: OTHER_OWNER });
    stubOwnerScans(txMock, { activeBay: OTHER_OWNER });

    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  // B23 (adversarial audit, finding 6). The positive half: a resolver that returned
  // null in every case would pass both tests above. An ACTIVE owned sibling must
  // satisfy the guard AND be inherited onto the new room's tenancy — that is the
  // "can't occupy the other rooms" bug this machinery exists to prevent.
  it("inherits an ACTIVE sibling's owner instead of 409ing", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, { activeListing: OTHER_OWNER });
    stubOwnerScans(txMock, { activeListing: OTHER_OWNER });

    const { ownerPartyId: _drop, ...noOwner } = occupiedInput;
    const res = await createUnitService(session as never, noOwner as never);

    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0]![0].unit.ownerPartyId).toBe(OTHER_OWNER);
  });

  it("scans deterministically (every findFirst carries a stable orderBy)", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    const scans = [
      ...prismaMock.listing.findFirst.mock.calls,
      ...prismaMock.carpark.findFirst.mock.calls,
      ...txMock.listing.findFirst.mock.calls,
      ...txMock.carpark.findFirst.mock.calls,
    ];
    expect(scans.length).toBeGreaterThan(0);
    for (const [args] of scans) {
      expect(args).toEqual(expect.objectContaining({ orderBy: { id: "asc" } }));
    }
  });
});

// ---------------------------------------------------------------------------
// R2-4 — TOCTOU: the guard must be re-run INSIDE the transaction
// ---------------------------------------------------------------------------
describe("createUnitService — R2-4 in-transaction conflict re-check", () => {
  it("rejects with 409 when a concurrent owner assignment lands after the pre-tx check", async () => {
    stubExistingApartment();
    // Pre-transaction: the apartment looks ownerless, so the pre-tx guard passes.
    stubOwnerScans(prismaMock, {});
    // Inside the transaction: a concurrent writer has assigned OTHER_OWNER.
    stubOwnerScans(txMock, { activeListing: OTHER_OWNER });

    const res = await createUnitService(session as never, occupiedInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    // The re-check fires BEFORE the stamp: no listing row, no tenancy, no fan-out.
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    // Post-tx side effects never ran (the transaction threw).
    expect(mockedRepo.replaceVisibilityGrants).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6 — the IN-TX re-check must use the CONFLICT resolver, not the inheritance one
//
// Both resolvers open with the same ACTIVE-listing scan, so a stub that dispatches
// only on the status filter cannot tell them apart: swapping
// `resolveApartmentOwnerForConflict` -> `resolveApartmentOwnerPartyId` inside the
// transaction silently DROPS archived-listing and inactive-bay conflict evidence
// and every test still passed. These tests pin the resolver by the scans that only
// the conflict resolver issues.
// ---------------------------------------------------------------------------
describe("in-transaction re-check — F6 resolver identity", () => {
  it("createUnitService consults the ARCHIVED + INACTIVE conflict tiers inside the tx", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {}); // ownerless everywhere → the tx runs to completion

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
    } as never);
    expect(res.ok).toBe(true);

    // The in-tx guard is `resolveApartmentOwnerForConflict`, which alone scans the
    // archived listings and the inactive bays. Point it at the inheritance resolver
    // and this drops to 0.
    expect(countConflictTierScans(txMock)).toBeGreaterThanOrEqual(2);
  });

  it("createUnitsBatchService consults the ARCHIVED + INACTIVE conflict tiers inside the tx", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-07", ownerPartyId: OWNER },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    } as never);
    expect(res.ok).toBe(true);

    expect(countConflictTierScans(txMock)).toBeGreaterThanOrEqual(2);
  });

  it("the INHERITANCE read never consults the conflict tiers (no owner in payload)", async () => {
    // With no payload owner the in-tx conflict guard is skipped entirely, so the
    // only in-tx scan is the inheritance read — which must NOT touch archived rows.
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(countConflictTierScans(txMock)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F2 — a conflict the transaction CAN SEE must not commit two owners
//
// The in-tx guard (S1) and the inheritance read (S2) are two separate statements.
// Under READ COMMITTED each takes a FRESH snapshot, so a writer that commits
// between them is invisible to S1 but VISIBLE to S2. `effectiveOwnerPartyId` is
// `??`-biased to the payload, so without an equality check at S2 the new rows are
// stamped with the payload owner while the siblings hold the concurrent one —
// committed silently, no 409.
// ---------------------------------------------------------------------------

/**
 * A concurrent transaction commits `owner` BETWEEN S1 and S2.
 *
 * Both S1 (`resolveApartmentOwnerForConflict`) and S2 (`resolveApartmentOwnerPartyId`)
 * open with the same ACTIVE-listing scan. Counting those scans lets us hand S1 an
 * ownerless apartment and S2 the concurrent owner — exactly the READ COMMITTED
 * interleaving, with no reliance on raw call indices across the other three scans.
 */
function stubOwnerAppearsBetweenScans(m: ModelSpies, owner: string) {
  let activeListingScans = 0;
  m.listing.findFirst.mockImplementation((args: unknown) => {
    const status = (args as { where?: { listingStatus?: unknown } })?.where?.listingStatus;
    const isActiveScan =
      status && typeof status === "object" && (status as { not?: string }).not === "archived";
    if (isActiveScan) {
      activeListingScans += 1;
      // 1st = S1's snapshot (ownerless). 2nd = S2's snapshot (owner committed).
      return Promise.resolve(activeListingScans >= 2 ? { ownerPartyId: owner } : null);
    }
    return Promise.resolve(null); // archived scan: no evidence
  });
  m.carpark.findFirst.mockResolvedValue(null);
}

describe("createUnitService — F2 conflict visible at the inheritance read", () => {
  it("rejects with 409 when the owner appears BETWEEN the re-check and the inheritance read", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {}); // pre-tx: ownerless
    stubOwnerAppearsBetweenScans(txMock, OTHER_OWNER);

    const res = await createUnitService(session as never, occupiedInput as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    // The payload owner must never be stamped over a concurrent owner the tx saw.
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    // No silent fan-out and no propagate audit.
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  it("still proceeds when the owner that appears at S2 MATCHES the payload owner", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerAppearsBetweenScans(txMock, OWNER); // same owner — not a conflict

    const res = await createUnitService(session as never, occupiedInput as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.createListingTx).toHaveBeenCalledWith(
      txMock,
      expect.objectContaining({ ownerPartyId: OWNER }),
    );
    // Apartment already owned at S2, so this is NOT a first assignment.
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });
});

describe("createUnitsBatchService — F2 conflict visible at the inheritance read", () => {
  const batchInput = {
    shared: { propertyId: PROPERTY, unitCode: "TD-09", ownerPartyId: OWNER },
    rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
  };

  it("rejects with 409 when the owner appears BETWEEN the re-check and the inheritance read", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerAppearsBetweenScans(txMock, OTHER_OWNER);

    const res = await createUnitsBatchService(session as never, batchInput as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    // No room was stamped with the payload owner over the concurrent one.
    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  it("still proceeds when the owner that appears at S2 MATCHES the payload owner", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerAppearsBetweenScans(txMock, OWNER);

    const res = await createUnitsBatchService(session as never, batchInput as never);

    expect(res.ok).toBe(true);
    expect(txMock.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerPartyId: OWNER }) }),
    );
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R2-5 — initial partitionBillingMode on apartment CREATE must be audited
// ---------------------------------------------------------------------------
describe("findOrCreateApartment — R2-5 audit on the CREATE branch", () => {
  it("audits the client-supplied billing mode when the apartment is created", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-21-01",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      partitionBillingMode: "SUBSIDY",
    } as never);
    expect(res.ok).toBe(true);
    expect(txAudit("apartment.shared.update")).toEqual(
      expect.objectContaining({
        action: "apartment.shared.update",
        entityType: "Apartment",
        entityId: "apt-new",
        diff: expect.objectContaining({ partitionBillingMode: "SUBSIDY" }),
      }),
    );
    // Written through the tx handle, so it rolls back with the apartment.
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("does NOT audit when no billing mode is supplied (DB default applies)", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-21-02",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);
    expect(res.ok).toBe(true);
    expect(txAudit("apartment.shared.update")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I4 — a room create must not silently rewrite an existing apartment's
// partitionBillingMode. SUBSIDY vs NO_SUBSIDY drives every tenant's utility bill
// on that apartment, so a create hitting an existing apartment with a DIFFERENT
// value is rejected exactly the way a differing owner is: 409, nothing written.
// Its canonical writer stays updateApartmentSharedService ("Edit shared details").
// ---------------------------------------------------------------------------
describe("findOrCreateApartment — I4 billing-mode conflict on an existing apartment", () => {
  const BILLING_CONFLICT_MESSAGE =
    "This apartment already uses a different utility billing model. Change it from Edit shared details.";

  // B12.
  it("rejects a differing billing mode on createUnitService (409, nothing written)", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      partitionBillingMode: "NO_SUBSIDY",
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    // `code` is a TOP-LEVEL sibling of `error`, mirroring APARTMENT_OWNER_CONFLICT.
    expect((res as { code?: string }).code).toBe("APARTMENT_BILLING_MODE_CONFLICT");
    expect(res.error).toBe(BILLING_CONFLICT_MESSAGE);
    // The whole transaction rolls back: no mode write, no audit, no listing.
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(txAudit("apartment.shared.update")).toBeUndefined();
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  // B13.
  it("rejects a differing billing mode on createUnitsBatchService (409, nothing written)", async () => {
    stubExistingApartment("SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitsBatchService(session as never, {
      shared: {
        propertyId: PROPERTY,
        unitCode: "TD-01",
        partitionBillingMode: "NO_SUBSIDY",
      },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_BILLING_MODE_CONFLICT");
    expect(res.error).toBe(BILLING_CONFLICT_MESSAGE);
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });

  // B14. An unchanged re-submit is a silent no-op — not an error, not a write.
  it("treats a matching billing mode as a no-op (no write, no audit, no error)", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      partitionBillingMode: "SUBSIDY",
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(txAudit("apartment.shared.update")).toBeUndefined();
  });

  // B14b (adversarial audit, finding 4). The regression hunt: adding a room to an
  // existing apartment WITHOUT mentioning the billing mode is the overwhelmingly
  // common call, and it must never 409 — whatever the apartment already holds.
  it("never fires when partitionBillingMode is omitted, whatever the apartment holds", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(mockedRepo.createListingTx).toHaveBeenCalled();
  });

  // B17 (data-import path). `ensureRoomListing` calls createUnitsBatchService with
  // `shared: { propertyId, unitCode }` — a literal with no partitionBillingMode key
  // and no spread — so the Excel import can never trip this 409. Also covers the
  // `applyToExistingSiblings` shared-field write, which previously committed and
  // must keep committing when the mode is omitted.
  it("lets the import-shaped payload through and still commits the shared-field update", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.findMany.mockResolvedValue([{ id: "r1" }]);

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-03", bedrooms: 4 },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
      applyToExistingSiblings: true,
    } as never);

    expect(res.ok).toBe(true);
    // The shared-field update commits: the guard did not roll it back.
    expect(txMock.apartment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bedrooms: 4 }) }),
    );
    expect(txMock.listing.create).toHaveBeenCalled();
  });

  // B14c (adversarial audit, finding 4, negative half). A DIFFERING mode on the
  // applyToExistingSiblings path rolls the unrelated shared-field write back too:
  // findOrCreateApartment throws before that update is reached.
  it("rolls back the shared-field update when the billing mode conflicts", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.findMany.mockResolvedValue([{ id: "r1" }]);

    const res = await createUnitsBatchService(session as never, {
      shared: {
        propertyId: PROPERTY,
        unitCode: "TD-03",
        bedrooms: 4,
        partitionBillingMode: "NO_SUBSIDY",
      },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
      applyToExistingSiblings: true,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res as { code?: string }).code).toBe("APARTMENT_BILLING_MODE_CONFLICT");
    expect(txMock.apartment.update).not.toHaveBeenCalled();
  });

  // B24 (adversarial audit, finding 7). When a payload conflicts on BOTH owner and
  // billing mode, the pre-transaction owner guard runs first, so the client always
  // sees APARTMENT_OWNER_CONFLICT. Pinned so a reorder cannot silently swap it.
  it("surfaces APARTMENT_OWNER_CONFLICT when owner and billing mode both conflict", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, { activeListing: OTHER_OWNER });
    stubOwnerScans(txMock, { activeListing: OTHER_OWNER });

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
      partitionBillingMode: "NO_SUBSIDY",
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
  });
});

describe("createUnitsBatchService — owner + billing mode", () => {
  const batchInput = {
    shared: {
      propertyId: PROPERTY,
      unitCode: "TD-01",
      ownerPartyId: OWNER,
      partitionBillingMode: "SUBSIDY",
    },
    rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
  };

  it("persists billing mode on a newly-created apartment", async () => {
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(true);
    expect(txMock.apartment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ partitionBillingMode: "SUBSIDY" }),
      }),
    );
    expect(prismaMock.apartment.create).not.toHaveBeenCalled();
  });

  it("stamps shared.ownerPartyId onto every created listing", async () => {
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(true);
    expect(txMock.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerPartyId: OWNER }),
      }),
    );
    expect(prismaMock.listing.create).not.toHaveBeenCalled();
  });

  it("rejects a shared.ownerPartyId that is not an owner in this org (400)", async () => {
    prismaMock.partyRole.findFirst.mockResolvedValue(null);
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toBe("Assigned party is not an owner");
    // Rejected before the transaction: nothing written on either client.
    expect(txMock.apartment.create).not.toHaveBeenCalled();
    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(prismaMock.apartment.create).not.toHaveBeenCalled();
  });

  // Finding 1 (B4): batch must also reject re-pointing an already-owned apartment.
  it("rejects a batch whose owner differs from the apartment's owner (409 APARTMENT_OWNER_CONFLICT)", async () => {
    stubExistingApartment();
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: OTHER_OWNER });
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    expect(txMock.apartment.create).not.toHaveBeenCalled();
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });

  // I4 (supersedes the former "audits the billing-mode change (update path)" test):
  // a create no longer WRITES an existing apartment's billing mode at all, so there
  // is no change left to audit. It rejects instead. Same fixture, inverted contract.
  it("refuses to rewrite an existing apartment's billing mode (409, no write, no audit)", async () => {
    stubExistingApartment("NO_SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_BILLING_MODE_CONFLICT");
    // Neither client wrote the apartment, and no billing audit was recorded.
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(prismaMock.apartment.update).not.toHaveBeenCalled();
    expect(txAudit("apartment.shared.update")).toBeUndefined();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  // Finding 4 (B9): no update and no audit when the billing mode is unchanged.
  it("does not update or audit billing mode when it is unchanged", async () => {
    stubExistingApartment("SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(true);
    expect(txMock.apartment.update).not.toHaveBeenCalled();
    expect(prismaMock.apartment.update).not.toHaveBeenCalled();
    expect(txMock.auditLog.create).not.toHaveBeenCalled();
  });

  // R2-1, batch scenario 2: `rooms: []` + applyToExistingSiblings. The validated
  // shared owner used to be silently discarded because no rows were created.
  it("fans the owner out on the rooms:[] apartment-shared-only path", async () => {
    stubExistingApartment();
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});
    txMock.listing.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    txMock.listing.updateMany.mockResolvedValue({ count: 2 });
    txMock.carpark.updateMany.mockResolvedValue({ count: 1 });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-02", ownerPartyId: OWNER },
      rooms: [],
      applyToExistingSiblings: true,
    } as never);
    expect(res.ok).toBe(true);

    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(txMock.listing.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: session.orgId,
        listingStatus: { not: "archived" },
      },
      data: { ownerPartyId: OWNER },
    });
    expect(txMock.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: "apt-1",
        organizationId: session.orgId,
        status: { not: "inactive" },
      },
      data: { ownerPartyId: OWNER },
    });
    // No room triggered this fan-out.
    expect(txAudit("inventory.owner.propagate")).toEqual(
      expect.objectContaining({
        entityId: "apt-1",
        meta: expect.objectContaining({
          ownerPartyId: OWNER,
          triggeredByUnitId: null,
          affectedCount: 2,
        }),
      }),
    );
  });

  it("does not fan out when the apartment already carries that owner", async () => {
    // The apartment already holds the batch's billing mode, so the I4 guard is a
    // no-op here and this test stays about the OWNER fan-out.
    stubExistingApartment("SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: OWNER });
    stubOwnerScans(txMock, { activeListing: OWNER });
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(true);
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(txAudit("inventory.owner.propagate")).toBeUndefined();
  });

  // The data-import path (`ensureRoomListing`) calls this service with NO shared
  // owner. It must never fan anything out, whatever the apartment already holds.
  it("does not fan out when no explicit owner is supplied (data-import path)", async () => {
    stubExistingApartment();
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: "owner-x" });
    stubOwnerScans(txMock, { activeListing: "owner-x" });
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "TD-03" },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
      applyToExistingSiblings: false,
    } as never);
    expect(res.ok).toBe(true);
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
    expect(txMock.carpark.updateMany).not.toHaveBeenCalled();
    // The created room still inherits the apartment's owner.
    expect(txMock.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerPartyId: "owner-x" }) }),
    );
  });

  it("R2-4: rejects with 409 when the conflict appears only inside the transaction", async () => {
    // Billing mode matches, so the I4 guard cannot preempt the OWNER 409 under test.
    stubExistingApartment("SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, { activeListing: OTHER_OWNER });
    const res = await createUnitsBatchService(session as never, batchInput as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("APARTMENT_OWNER_CONFLICT");
    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(txMock.listing.updateMany).not.toHaveBeenCalled();
  });
});

describe("findOrCreateApartment — apartment TNB subsidy cap", () => {
  it("persists and audits an opt-in monthly cap on a new apartment", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-21-03",
      unitType: "Master",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      tnbSubsidyCapMonthly: 200,
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.apartment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tnbSubsidyCapMonthly: 200 }),
      }),
    );
    expect(txAudit("apartment.shared.update")).toEqual(
      expect.objectContaining({
        diff: expect.objectContaining({
          tnbSubsidyCapMonthly: 200,
          source: "unit-create",
        }),
      }),
    );
  });

  it("rejects a room create that contradicts an existing apartment cap", async () => {
    stubExistingApartment("SUBSIDY", 200);
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      tnbSubsidyCapMonthly: 100,
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe(
      "APARTMENT_TNB_SUBSIDY_CAP_CONFLICT",
    );
    expect(mockedRepo.createListingTx).not.toHaveBeenCalled();
  });

  it("allows a matching cap without rewriting the apartment", async () => {
    stubExistingApartment("SUBSIDY", 200);
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const matching = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-12-03",
      unitType: "Small",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      tnbSubsidyCapMonthly: 200,
    } as never);
    expect(matching.ok).toBe(true);
    expect(txMock.apartment.update).not.toHaveBeenCalled();
  });
});

describe("unit create — management fee is atomic with the unit", () => {
  const managementFeeConfig = {
    feeType: "cap",
    feeValue: "10",
    capAmount: "250",
    sstPercent: "8",
    freePeriodStart: null,
    freePeriodEnd: null,
    firstChargeMonth: "2026-08-01T00:00:00.000Z",
    firstChargeBaseAmount: null,
    paxDeductionPerPerson: null,
  };

  it("creates the single-unit fee config on the same transaction handle", async () => {
    const res = await createUnitService(session as never, {
      propertyId: PROPERTY,
      unitCode: "A-01-01",
      unitType: "Whole Unit",
      depositMonths: 2,
      utilitiesDepositMonths: 1,
      occupancyStatus: "vacant",
      ownerPartyId: OWNER,
      managementFeeConfig,
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.managementFeeConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        apartmentId: "apt-new",
        ownerPartyId: OWNER,
        feeType: "cap",
        feeValue: "10",
        capAmount: "250",
        sstPercent: "8",
      }),
      select: { id: true },
    });
    expect(prismaMock.managementFeeConfig.create).not.toHaveBeenCalled();
    expect(txAudit("owner_billing.fee_config.created_with_unit")).toEqual(
      expect.objectContaining({ entityId: "fee-config-1" }),
    );
  });

  it("creates the partition fee config on the same transaction handle", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: {
        propertyId: PROPERTY,
        unitCode: "B-01-01",
        ownerPartyId: OWNER,
        partitionBillingMode: "NO_SUBSIDY",
        managementFeeConfig,
      },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    } as never);

    expect(res.ok).toBe(true);
    expect(txMock.managementFeeConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        apartmentId: "apt-new",
        ownerPartyId: OWNER,
        feeType: "cap",
        feeValue: "10",
        capAmount: "250",
        sstPercent: "8",
      }),
      select: { id: true },
    });
    expect(prismaMock.managementFeeConfig.create).not.toHaveBeenCalled();
    expect(txAudit("owner_billing.fee_config.created_with_unit_batch")).toEqual(
      expect.objectContaining({ entityId: "fee-config-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Route Minor — POST /units/batch must surface the TOP-LEVEL `code`
// ---------------------------------------------------------------------------
describe("POST /units/batch — 409 code surfacing", () => {
  function makeApp() {
    const app = new Hono();
    app.use("*", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("session", { ...session, userType: "operator" });
      await next();
    });
    app.route("/", inventoryRoutes);
    return app;
  }

  it("returns the top-level APARTMENT_OWNER_CONFLICT code alongside error", async () => {
    stubExistingApartment();
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, { activeListing: OTHER_OWNER });

    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "TD-04", ownerPartyId: OWNER },
        rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
      }),
    });

    expect(res.status).toBe(409);
    // `code` is a TOP-LEVEL sibling of `error`, not nested inside it.
    expect(await res.json()).toEqual({
      error: "This apartment is already owned by another party. Change the owner from Edit shared details.",
      code: "APARTMENT_OWNER_CONFLICT",
    });
  });

  // B16. Both create routes already spread a TOP-LEVEL `code` when the service
  // returns one, so the new 409 surfaces with NO route change. Asserted on both.
  it("returns the top-level APARTMENT_BILLING_MODE_CONFLICT code from POST /units/batch", async () => {
    stubExistingApartment("SUBSIDY");
    prismaMock.listing.findMany.mockResolvedValue([]);
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "TD-06", partitionBillingMode: "NO_SUBSIDY" },
        rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This apartment already uses a different utility billing model. Change it from Edit shared details.",
      code: "APARTMENT_BILLING_MODE_CONFLICT",
    });
  });

  it("returns the top-level APARTMENT_BILLING_MODE_CONFLICT code from POST /units", async () => {
    stubExistingApartment("SUBSIDY");
    stubOwnerScans(prismaMock, {});
    stubOwnerScans(txMock, {});

    const res = await makeApp().request("/units", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        propertyId: PROPERTY,
        unitCode: "A-12-03",
        unitType: "Small",
        depositMonths: 2,
        utilitiesDepositMonths: 1,
        occupancyStatus: "vacant",
        partitionBillingMode: "NO_SUBSIDY",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This apartment already uses a different utility billing model. Change it from Edit shared details.",
      code: "APARTMENT_BILLING_MODE_CONFLICT",
    });
  });

  it("still returns a bare { error } for a 409 with no code (duplicate unit types)", async () => {
    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "TD-05" },
        rooms: [
          { unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 },
          { unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 },
        ],
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Duplicate unit type in submission: Master",
    });
  });
});

// ---------------------------------------------------------------------------
// Task T2 — batch accepts per-room occupancy. An occupied room in a batch
// submission must materialise its Tenancy in the SAME transaction as the
// Listing create, guarded exactly like createUnitService's occupied path
// (UNIT_HAS_NO_OWNER / OCCUPANCY_RENT_REQUIRED), while a vacant room in the
// same batch stays byte-for-byte unchanged.
// ---------------------------------------------------------------------------
describe("createUnitsBatchService — per-room occupancy (T2)", () => {
  // No rentalRate on purpose: effectiveRent must come from monthlyRent alone
  // unless a test explicitly overrides this.
  const occupiedRoom = {
    unitType: "Master",
    depositMonths: 2,
    utilitiesDepositMonths: 1,
    occupancyStatus: "occupied",
    tenantPartyId: TENANT,
    moveInDate: "2026-07-15",
    moveOutDate: "2027-07-14",
    monthlyRent: 1800,
  };
  const vacantRoom = {
    unitType: "Single",
    depositMonths: 2,
    utilitiesDepositMonths: 1,
  };

  it("materialises exactly one Tenancy for an occupied room inside the batch transaction", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-01", ownerPartyId: OWNER },
      rooms: [occupiedRoom],
    } as never);

    expect(res.ok).toBe(true);
    // Exactly ONE sync call == exactly one Tenancy materialised for this batch.
    expect(mockedSync).toHaveBeenCalledTimes(1);
    const arg = mockedSync.mock.calls[0]![0];
    // Money-critical: sync runs on the DISTINCT transaction handle the listing
    // write used, so the Tenancy rolls back with the Listing (no orphan).
    expect(arg.tx).toBe(txMock);
    expect(arg.tx).not.toBe(prismaMock);
    expect(arg.unit.id).toBe("room-new");
    expect(arg.unit.propertyId).toBe(PROPERTY);
    // Prior state of a just-created row is vacant, not occupied.
    expect(arg.unit.occupancyStatus).toBe("vacant");
    expect(arg.unit.ownerPartyId).toBe(OWNER);
    expect(arg.incoming.occupancyStatus).toBe("occupied");
    expect(arg.incoming.tenantPartyId).toBe(TENANT);
    // startDate = moveInDate: syncOccupancyTenancy (tested separately in
    // occupancy-tenancy-sync.test.ts) writes Tenancy.startDate = incoming.moveInDate
    // verbatim, so pinning this argument IS pinning the persisted startDate.
    expect(arg.incoming.moveInDate).toEqual(new Date("2026-07-15"));
    expect(arg.incoming.moveOutDate).toEqual(new Date("2027-07-14"));
    expect(arg.incoming.monthlyRent).toBe(1800);
    expect(txAudit("inventory.unit.created_occupied")).toEqual(
      expect.objectContaining({
        entityType: "Listing",
        entityId: "room-new",
        meta: { tenantPartyId: TENANT, monthlyRent: 1800 },
      }),
    );
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("a FUTURE move-in date is passed through unchanged, never overridden to today", async () => {
    // Invariant (see plan docs/superpowers/plans/2026-07-10-inventory-full-edit-and-room-tenant.md):
    // Tenancy.startDate anchors proration; a future moveInDate must reach the
    // sync verbatim so the (separately-tested) billing path bills RM0 this
    // month. This test proves the plumbing does not defeat that guarantee by
    // silently defaulting to the creation date.
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-01B", ownerPartyId: OWNER },
      rooms: [{ ...occupiedRoom, moveInDate: "2030-01-01", moveOutDate: "2031-01-01" }],
    } as never);

    expect(res.ok).toBe(true);
    expect(mockedSync.mock.calls[0]![0].incoming.moveInDate).toEqual(new Date("2030-01-01"));
  });

  it("a vacant room in the same batch as an occupied room is unaffected (draft/vacant, no Tenancy)", async () => {
    txMock.listing.create
      .mockResolvedValueOnce({ id: "room-a" })
      .mockResolvedValueOnce({ id: "room-b" });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-02", ownerPartyId: OWNER },
      rooms: [occupiedRoom, vacantRoom],
    } as never);

    expect(res.ok).toBe(true);
    // Only the occupied room (room-a) triggers a sync call.
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0]![0].unit.id).toBe("room-a");
    // The vacant room (room-b) is created exactly as today: draft + vacant.
    expect(txMock.listing.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ occupancyStatus: "vacant", listingStatus: "draft" }),
      }),
    );
    expect(txAudit("inventory.unit.created_occupied")).toEqual(
      expect.objectContaining({ entityId: "room-a" }),
    );
  });

  it("rejects an occupied room when the apartment has no owner (409 UNIT_HAS_NO_OWNER)", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-03" }, // no ownerPartyId
      rooms: [occupiedRoom],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    // Rejected before the write for this room: no sync, no listing row.
    expect(mockedSync).not.toHaveBeenCalled();
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });

  it("rolls back the whole batch when a LATER room's occupancy guard fails (atomicity)", async () => {
    txMock.listing.create.mockResolvedValueOnce({ id: "room-a" });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-04" }, // no owner
      rooms: [
        vacantRoom, // room 1: vacant, creates fine (no owner needed)
        occupiedRoom, // room 2: occupied but the apartment has no owner -> throws
      ],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER");
    // Room 1's create WAS attempted inside the SAME transaction as room 2's
    // failure. A real Prisma $transaction rolls the whole callback back
    // together when it throws, so room 1 never actually persists even though
    // this mock recorded the call -- the service must not report success.
    expect(txMock.listing.create).toHaveBeenCalledTimes(1);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("rejects an occupied room with a non-positive effective rent (400 OCCUPANCY_RENT_REQUIRED)", async () => {
    // `??`, never `||`: an explicit monthlyRent: 0 must reject, not silently
    // fall through to some other default.
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-05", ownerPartyId: OWNER },
      rooms: [{ ...occupiedRoom, monthlyRent: 0 }],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toEqual(expect.objectContaining({ code: "OCCUPANCY_RENT_REQUIRED" }));
    expect(mockedSync).not.toHaveBeenCalled();
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });

  // ORPHAN GUARD (adversarial money review, Critical). occupancyTenancyRefiner
  // early-returns when NONE of the trio fields are present, so a room carrying
  // occupancyStatus:"occupied" + a rent but NO tenantPartyId/moveInDate/
  // moveOutDate PASSES the schema. Owner is present here, so UNIT_HAS_NO_OWNER
  // cannot be what rejects it -- this pins the ported Finding-2 trio guard.
  // Without it, tx.listing.create would persist an occupied Listing with no
  // Tenancy and no created_occupied audit (the orphan). Mirrors
  // createUnitService's "rejects an occupied create with no tenancy trio (400)".
  it("rejects an occupied room with a rent but NO tenancy trio — orphan guard (400, nothing persisted)", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-ORPHAN", ownerPartyId: OWNER },
      rooms: [
        {
          unitType: "Master",
          depositMonths: 2,
          utilitiesDepositMonths: 1,
          occupancyStatus: "occupied",
          monthlyRent: 1800,
          // tenantPartyId, moveInDate, moveOutDate ALL omitted on purpose.
        },
      ],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    // Same plain-string message createUnitService's Finding 2 guard returns.
    expect(res.error).toBe(
      "When marking a unit as Occupied, the following are required: tenant, move-in date, move-out date.",
    );
    // The orphan never reached the DB: no listing row, no tenancy sync, no audit.
    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    expect(txAudit("inventory.unit.created_occupied")).toBeUndefined();
  });

  // The orphan guard's atomicity half: a LATER occupied room missing its trio
  // rolls back an EARLIER room that already created. A real Prisma $transaction
  // rolls the whole callback back together on throw, so the service must not
  // report success even though the mock recorded room 1's create call.
  it("rolls back an earlier room when a LATER occupied room fails the trio guard (atomic)", async () => {
    txMock.listing.create.mockResolvedValueOnce({ id: "room-a" });

    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-ORPHAN2", ownerPartyId: OWNER },
      rooms: [
        { unitType: "Single", depositMonths: 2, utilitiesDepositMonths: 1 }, // vacant, creates
        {
          unitType: "Master",
          depositMonths: 2,
          utilitiesDepositMonths: 1,
          occupancyStatus: "occupied",
          monthlyRent: 1800,
          // no trio -> the guard throws before room 2's tx.listing.create
        },
      ],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toBe(
      "When marking a unit as Occupied, the following are required: tenant, move-in date, move-out date.",
    );
    // Only room 1's create was attempted; room 2 threw before its own create.
    expect(txMock.listing.create).toHaveBeenCalledTimes(1);
    expect(mockedSync).not.toHaveBeenCalled();
    expect(txAudit("inventory.unit.created_occupied")).toBeUndefined();
  });

  // A PARTIAL trio (tenant present, one date missing) is rejected by the schema
  // refiner itself (anyTrioPresent is true), so it never reaches the service --
  // but the service-layer guard is defence-in-depth and must ALSO reject it if
  // called directly. Pins that the ported guard counts each missing field.
  it("rejects an occupied room with a PARTIAL trio (400, lists only the missing fields)", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-ORPHAN3", ownerPartyId: OWNER },
      rooms: [
        {
          unitType: "Master",
          depositMonths: 2,
          utilitiesDepositMonths: 1,
          occupancyStatus: "occupied",
          tenantPartyId: TENANT,
          moveInDate: "2026-07-15",
          monthlyRent: 1800,
          // moveOutDate omitted
        },
      ],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toBe(
      "When marking a unit as Occupied, the following are required: move-out date.",
    );
    expect(txMock.listing.create).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  // "Flag OFF" equivalent at this call site: no explicit monthlyRent, only
  // rentalRate. effectiveRent falls back to rentalRate and the room proceeds;
  // syncOccupancyTenancy's OWN flag-off branch (tested in
  // occupancy-tenancy-sync.test.ts) would then take unit.rentalRate as the
  // tenancy's rent.
  it("falls back to rentalRate when no explicit monthlyRent is supplied", async () => {
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-06", ownerPartyId: OWNER },
      rooms: [
        {
          unitType: "Master",
          depositMonths: 2,
          utilitiesDepositMonths: 1,
          occupancyStatus: "occupied",
          tenantPartyId: TENANT,
          moveInDate: "2026-07-15",
          moveOutDate: "2027-07-14",
          rentalRate: 2200,
        },
      ],
    } as never);

    expect(res.ok).toBe(true);
    const arg = mockedSync.mock.calls[0]![0];
    // effectiveRent (monthlyRent ?? rentalRate) feeds unit.rentalRate...
    expect(arg.unit.rentalRate).toBe(2200);
    // ...but the RAW incoming.monthlyRent stays undefined, exactly mirroring
    // createUnitService's C1 contract (the explicit field, not the resolved
    // one, is what the flag-on branch of the sync inspects).
    expect(arg.incoming.monthlyRent).toBeUndefined();
  });

  // "Flag ON" equivalent at this call site: syncOccupancyTenancy itself is
  // mocked in this file, so its internal isPhase2FlagEnabled branching is out
  // of scope here (covered by occupancy-tenancy-sync.test.ts and
  // occupancy-sync-rent-role.integration.test.ts). What THIS test proves is
  // that createUnitsBatchService's catch maps the sync's `_occupancyRentRequired`
  // marker to the same clean 400 createUnitService's catch does — mirrors
  // createUnitService's own "maps rent-required to 400, not a 500" test.
  it("maps syncOccupancyTenancy's rent-required rejection to 400, not a 500", async () => {
    mockedSync.mockRejectedValueOnce(
      Object.assign(new Error("rent required"), { _occupancyRentRequired: true }),
    );
    const res = await createUnitsBatchService(session as never, {
      shared: { propertyId: PROPERTY, unitCode: "T2-07", ownerPartyId: OWNER },
      rooms: [occupiedRoom],
    } as never);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toEqual(expect.objectContaining({ code: "OCCUPANCY_RENT_REQUIRED" }));
  });
});

// ---------------------------------------------------------------------------
// Task T2 — schema split integrity: the admin batch schema gains per-room
// occupancy; the portal batch schema (createPortalUnitsBatchSchema) must
// stay byte-for-byte unchanged. Agents may never set a tenant or owner on a
// batch submission.
// ---------------------------------------------------------------------------
describe("createUnitsBatchSchema / createPortalUnitsBatchSchema — T2 split integrity", () => {
  const occupiedRoomPayload = {
    unitType: "Master",
    depositMonths: 2,
    utilitiesDepositMonths: 1,
    occupancyStatus: "occupied",
    tenantPartyId: TENANT,
    moveInDate: "2026-07-15",
    moveOutDate: "2027-07-14",
    monthlyRent: 1800,
  };

  it("createUnitsBatchSchema (admin) accepts an occupied room with tenant + dates + rent", () => {
    const parsed = createUnitsBatchSchema.safeParse({
      shared: { propertyId: PROPERTY, unitCode: "ADMIN-T2", ownerPartyId: OWNER },
      rooms: [occupiedRoomPayload],
    });
    expect(parsed.success).toBe(true);
  });

  it("createUnitsBatchSchema (admin) rejects an occupied room missing tenantPartyId", () => {
    const { tenantPartyId: _drop, ...noTenant } = occupiedRoomPayload;
    const parsed = createUnitsBatchSchema.safeParse({
      shared: { propertyId: PROPERTY, unitCode: "ADMIN-T2B", ownerPartyId: OWNER },
      rooms: [noTenant],
    });
    expect(parsed.success).toBe(false);
  });

  it("createUnitsBatchSchema (admin) rejects moveOutDate <= moveInDate for an occupied room", () => {
    const parsed = createUnitsBatchSchema.safeParse({
      shared: { propertyId: PROPERTY, unitCode: "ADMIN-T2C", ownerPartyId: OWNER },
      rooms: [{ ...occupiedRoomPayload, moveOutDate: occupiedRoomPayload.moveInDate }],
    });
    expect(parsed.success).toBe(false);
  });

  // The load-bearing regression guard: `batchRoomFields` (portal) must NOT
  // have gained the occupancy fields the admin schema now carries.
  it("createPortalUnitsBatchSchema REJECTS a room carrying occupancy/tenant fields", () => {
    const parsed = createPortalUnitsBatchSchema.safeParse({
      shared: { propertyId: PROPERTY, unitCode: "PORTAL-T2" },
      rooms: [occupiedRoomPayload],
    });
    expect(parsed.success).toBe(false);
  });

  // The portal schema's ordinary (non-occupancy) shape is untouched by the split.
  it("createPortalUnitsBatchSchema still accepts an ordinary room (no occupancy fields)", () => {
    const parsed = createPortalUnitsBatchSchema.safeParse({
      shared: { propertyId: PROPERTY, unitCode: "PORTAL-T2B" },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task T2 — POST /units/batch surfaces the schema's occupancyTenancyRefiner
// as a clean 400 (never reaches the service).
// ---------------------------------------------------------------------------
describe("POST /units/batch — occupied room validation (T2)", () => {
  function makeApp() {
    const app = new Hono();
    app.use("*", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set("session", { ...session, userType: "operator" });
      await next();
    });
    app.route("/", inventoryRoutes);
    return app;
  }

  it("400s an occupied room missing tenantPartyId", async () => {
    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "T2-ROUTE-01", ownerPartyId: OWNER },
        rooms: [
          {
            unitType: "Master",
            depositMonths: 2,
            utilitiesDepositMonths: 1,
            occupancyStatus: "occupied",
            moveInDate: "2026-07-15",
            moveOutDate: "2027-07-14",
            monthlyRent: 1800,
            // tenantPartyId omitted on purpose
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors?: Record<string, string> };
    expect(body.fieldErrors?.["rooms.0.tenantPartyId"]).toBeDefined();
    // Never reached the service.
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });

  it("surfaces the top-level UNIT_HAS_NO_OWNER code for an occupied room on an ownerless apartment", async () => {
    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "T2-ROUTE-02" }, // no owner
        rooms: [
          {
            unitType: "Master",
            depositMonths: 2,
            utilitiesDepositMonths: 1,
            occupancyStatus: "occupied",
            tenantPartyId: TENANT,
            moveInDate: "2026-07-15",
            moveOutDate: "2027-07-14",
            monthlyRent: 1800,
          },
        ],
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This unit has no assigned owner. Assign an owner before marking it occupied.",
      code: "UNIT_HAS_NO_OWNER",
    });
  });

  // ORPHAN GUARD end-to-end: occupancyStatus:"occupied" + rent + NO trio PASSES
  // the schema (occupancyTenancyRefiner early-returns when no trio field is
  // present), so it reaches the service, which rejects it with the ported
  // Finding-2 plain-string 400. Proves the orphan cannot slip through the route.
  it("400s an occupied room with a rent but NO trio (schema passes; service orphan guard fires)", async () => {
    const res = await makeApp().request("/units/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shared: { propertyId: PROPERTY, unitCode: "T2-ROUTE-03", ownerPartyId: OWNER },
        rooms: [
          {
            unitType: "Master",
            depositMonths: 2,
            utilitiesDepositMonths: 1,
            occupancyStatus: "occupied",
            monthlyRent: 1800,
            // no tenantPartyId / moveInDate / moveOutDate
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "When marking a unit as Occupied, the following are required: tenant, move-in date, move-out date.",
    });
    // No orphan Listing was written.
    expect(txMock.listing.create).not.toHaveBeenCalled();
  });
});
