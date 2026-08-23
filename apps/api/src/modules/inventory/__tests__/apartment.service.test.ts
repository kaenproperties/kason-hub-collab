import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateApartmentSharedSchema } from "@kason/shared";

const apartmentStore = new Map<string, Record<string, unknown>>();
const listingStore = new Map<string, Record<string, unknown>>();
const roomTypeStore = new Map<string, Record<string, unknown>>();
const partyRoleStore = new Map<string, Record<string, unknown>>();
const carparkStore = new Map<string, Record<string, unknown>>();

/**
 * F5. Honour every filter the owner resolvers issue, on both `listing.findFirst` and
 * `carpark.findFirst`. A double that ignores `organizationId` / `ownerPartyId: { not:
 * null }` / the status filter cannot fail when production drops one of them, which is
 * precisely how the wave-5 I3 bug would have shipped green.
 *
 * `statusKey` is the row's status column: `listingStatus` for Listings, `status` for
 * Carparks. Both are non-nullable Strings, so `{ not: x }` is NULL-safe; `ownerPartyId`
 * is nullable, so `{ not: null }` means "owned rows only".
 */
function rowMatchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
  statusKey: "listingStatus" | "status",
): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.apartmentId !== undefined && row.apartmentId !== where.apartmentId) return false;
  if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
  if (where.listingType !== undefined && row.listingType !== where.listingType) return false;

  // `ownerPartyId: { not: null }` — skip ownerless rows. Absent from the row map
  // (never seeded) counts as ownerless, same as an explicit null.
  const owner = where.ownerPartyId;
  if (owner && typeof owner === "object" && "not" in (owner as object)) {
    if ((owner as { not: unknown }).not === null && row.ownerPartyId == null) return false;
  }

  const s = where[statusKey];
  if (typeof s === "string" && row[statusKey] !== s) return false;
  if (s && typeof s === "object" && row[statusKey] === (s as { not?: string }).not) return false;

  return true;
}

/** `findFirst` without an orderBy returns an arbitrary row; with one it must be stable. */
function firstMatch(
  store: Map<string, Record<string, unknown>>,
  args: { where: Record<string, unknown>; orderBy?: unknown },
  statusKey: "listingStatus" | "status",
) {
  const hits = [...store.values()].filter((r) => rowMatchesWhere(r, args.where ?? {}, statusKey));
  const ordered = args.orderBy
    ? [...hits].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : hits;
  return ordered[0] ?? null;
}

const dbMock = {
  apartment: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      const matches = [...apartmentStore.values()].filter(
        (a) => (!w.id || a.id === w.id) && (!w.organizationId || a.organizationId === w.organizationId),
      );
      return matches[0] ?? null;
    }),
    update: vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = apartmentStore.get(args.where.id);
        if (!row) throw new Error("Apartment not found in mock");
        const next = { ...row, ...args.data };
        apartmentStore.set(args.where.id, next);
        return next;
      },
    ),
  },
  listing: {
    count: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        apartmentId?: string;
        listingStatus?: { not?: string };
        listingType?: { in?: string[] };
      };
      return [...listingStore.values()].filter((l) => {
        if (w.apartmentId && l.apartmentId !== w.apartmentId) return false;
        if (w.listingStatus?.not && l.listingStatus === w.listingStatus.not) return false;
        if (w.listingType?.in && !w.listingType.in.includes(l.listingType as string)) return false;
        return true;
      }).length;
    }),
    // Used by getUnitGroupMode — filters by an `apartment: { propertyId, unitCode }`
    // relation that resolves through apartmentStore.
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        organizationId?: string;
        listingStatus?: { not?: string };
        apartment?: { propertyId?: string; unitCode?: string };
      };
      return [...listingStore.values()].filter((l) => {
        if (w.organizationId && l.organizationId !== w.organizationId) return false;
        if (w.listingStatus?.not && l.listingStatus === w.listingStatus.not) return false;
        if (w.apartment) {
          const apt = apartmentStore.get(l.apartmentId as string);
          if (!apt) return false;
          if (w.apartment.propertyId && apt.propertyId !== w.apartment.propertyId) return false;
          if (w.apartment.unitCode && apt.unitCode !== w.apartment.unitCode) return false;
        }
        return true;
      });
    }),
    findFirst: vi.fn(async (args: { where: Record<string, unknown>; orderBy?: unknown }) =>
      firstMatch(listingStore, args, "listingStatus"),
    ),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `l-${listingStore.size + 1}`;
      const row = { id, ...args.data };
      listingStore.set(id, row);
      return row;
    }),
    update: vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = listingStore.get(args.where.id);
        if (!row) throw new Error("Listing not found in mock");
        const next = { ...row, ...args.data };
        listingStore.set(args.where.id, next);
        return next;
      },
    ),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const w = args.where as {
          apartmentId?: string;
          organizationId?: string;
          listingStatus?: { not?: string };
        };
        let count = 0;
        for (const [id, row] of listingStore.entries()) {
          if (w.apartmentId && row.apartmentId !== w.apartmentId) continue;
          if (w.organizationId && row.organizationId !== w.organizationId) continue;
          if (w.listingStatus?.not && row.listingStatus === w.listingStatus.not) continue;
          listingStore.set(id, { ...row, ...args.data });
          count++;
        }
        return { count };
      },
    ),
  },
  carpark: {
    // `Carpark.status` is a non-nullable String ("available" | "rented" | "inactive"),
    // so `{ not: "inactive" }` is NULL-safe and selects every live bay.
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const w = args.where as {
          apartmentId?: string;
          organizationId?: string;
          status?: { not?: string };
        };
        let count = 0;
        for (const [id, row] of carparkStore.entries()) {
          if (w.apartmentId && row.apartmentId !== w.apartmentId) continue;
          if (w.organizationId && row.organizationId !== w.organizationId) continue;
          if (w.status?.not && row.status === w.status.not) continue;
          carparkStore.set(id, { ...row, ...args.data });
          count++;
        }
        return { count };
      },
    ),
    findFirst: vi.fn(async (args: { where: Record<string, unknown>; orderBy?: unknown }) =>
      firstMatch(carparkStore, args, "status"),
    ),
  },
  partyRole: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { organizationId?: string; partyId?: string; roleType?: string };
      const matches = [...partyRoleStore.values()].filter(
        (pr) =>
          (!w.organizationId || pr.organizationId === w.organizationId) &&
          (!w.partyId || pr.partyId === w.partyId) &&
          (!w.roleType || pr.roleType === w.roleType),
      );
      return matches[0] ?? null;
    }),
  },
  roomType: {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        organizationId?: string;
        kind?: string;
        isActive?: boolean;
        name?: { in?: string[] };
      };
      return [...roomTypeStore.values()].filter(
        (rt) =>
          (!w.organizationId || rt.organizationId === w.organizationId) &&
          (!w.kind || rt.kind === w.kind) &&
          (w.isActive === undefined || rt.isActive === w.isActive) &&
          (!w.name?.in || w.name.in.includes(rt.name as string)),
      );
    }),
  },
  auditLog: {
    create: vi.fn(async () => undefined),
  },
  $transaction: vi
    .fn()
    .mockImplementation(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: {},
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// F5. `rematerializeOwnerRecentMonths` is the ONLY observable of
// `previousApartmentOwnerPartyId`, and it self-gates on ENABLE_UNIT_MONTH_LEDGER, so
// spy the OUTER call rather than any ledger write.
const rematerializeOwnerRecentMonths = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../owner-ledger/unit-month-ledger.remateralize-range", () => ({
  rematerializeOwnerRecentMonths,
}));

import { flipApartmentModeService, updateApartmentSharedService } from "../apartment.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const PROP = "00000000-0000-0000-0000-000000000002";
const USER = "00000000-0000-0000-0000-000000000010";
const APT = "00000000-0000-0000-0000-000000000aaa";
const session = { orgId: ORG, userId: USER };

function seedApartment(listingMode: "WHOLE" | "PARTITIONED") {
  apartmentStore.set(APT, {
    id: APT,
    organizationId: ORG,
    propertyId: PROP,
    unitCode: "A-08-08",
    listingMode,
  });
}

function seedRoomType(id: string, name: string, kind: "WHOLE" | "PARTITION") {
  roomTypeStore.set(id, {
    id,
    organizationId: ORG,
    name,
    kind,
    isActive: true,
    sortOrder: roomTypeStore.size,
  });
}

function seedListing(
  id: string,
  listingType: string,
  listingStatus = "active",
  overrides: Record<string, unknown> = {},
) {
  listingStore.set(id, {
    id,
    apartmentId: APT,
    organizationId: ORG,
    listingType,
    listingStatus,
    ...overrides,
  });
}

/** A carpark bay on APT. `status` drives whether the owner fan-out reaches it. */
function seedCarpark(id: string, status: string, ownerPartyId?: string) {
  carparkStore.set(id, {
    id,
    apartmentId: APT,
    organizationId: ORG,
    propertyId: PROP,
    status,
    ...(ownerPartyId !== undefined ? { ownerPartyId } : {}),
  });
}

const OWNER_PARTY = "00000000-0000-0000-0000-000000000020";
const NON_OWNER_PARTY = "00000000-0000-0000-0000-000000000021";
/** The owner the apartment carried BEFORE this edit re-points it. */
const PREVIOUS_OWNER = "00000000-0000-0000-0000-000000000022";
/** Owned rows in another org, or on archived rows: never a previous-owner answer. */
const FOREIGN_OWNER = "00000000-0000-0000-0000-000000000023";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ff";

/** The partyIds handed to `rematerializeOwnerRecentMonths`, in call order. */
function rematerializedOwners(): unknown[] {
  return rematerializeOwnerRecentMonths.mock.calls.map((c) => (c as unknown[])[1]);
}

function seedOwnerPartyRole(partyId: string = OWNER_PARTY) {
  const id = `pr-${partyRoleStore.size + 1}`;
  partyRoleStore.set(id, { id, organizationId: ORG, partyId, roleType: "owner" });
}

beforeEach(() => {
  apartmentStore.clear();
  listingStore.clear();
  roomTypeStore.clear();
  partyRoleStore.clear();
  carparkStore.clear();
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(
    async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock),
  );
});

describe("flipApartmentModeService", () => {
  it("flips WHOLE -> PARTITIONED, seeding a draft Master listing when none exists", async () => {
    seedApartment("WHOLE");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-whole", "Whole Unit");

    const result = await flipApartmentModeService(session, APT, "PARTITIONED");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.previousMode).toBe("WHOLE");
    expect(result.data.targetMode).toBe("PARTITIONED");

    expect(apartmentStore.get(APT)!.listingMode).toBe("PARTITIONED");
    const masters = [...listingStore.values()].filter((l) => l.listingType === "Master");
    expect(masters).toHaveLength(1);
    expect(masters[0]!.listingStatus).toBe("draft");
    expect(listingStore.get("l-whole")!.listingStatus).toBe("active");
  });

  it("flips PARTITIONED -> WHOLE without creating a new row when a Whole listing already exists", async () => {
    seedApartment("PARTITIONED");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-whole", "Whole Unit");
    seedListing("l-master", "Master");

    const initialCount = listingStore.size;
    const result = await flipApartmentModeService(session, APT, "WHOLE");

    expect(result.ok).toBe(true);
    expect(apartmentStore.get(APT)!.listingMode).toBe("WHOLE");
    expect(listingStore.size).toBe(initialCount);
  });

  it("returns 409 MODE_UNCHANGED when target equals current", async () => {
    seedApartment("WHOLE");
    const result = await flipApartmentModeService(session, APT, "WHOLE");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
    expect(result.error).toBe("MODE_UNCHANGED");
  });

  it("returns 422 NO_PARTITION_ROOMTYPE when target kind has no active RoomType", async () => {
    seedApartment("WHOLE");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedListing("l-whole", "Whole Unit");

    const result = await flipApartmentModeService(session, APT, "PARTITIONED");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(422);
    expect(result.error).toBe("NO_PARTITION_ROOMTYPE");
    expect(apartmentStore.get(APT)!.listingMode).toBe("WHOLE");
    expect(listingStore.get("l-whole")!.listingStatus).toBe("active");
  });

  it("returns 422 NO_WHOLE_ROOMTYPE when target kind has no active RoomType", async () => {
    seedApartment("PARTITIONED");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-master", "Master");

    const result = await flipApartmentModeService(session, APT, "WHOLE");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(422);
    expect(result.error).toBe("NO_WHOLE_ROOMTYPE");
  });

  it("flip-flip-flip preserves DB row count (no growth)", async () => {
    seedApartment("WHOLE");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-whole", "Whole Unit");

    await flipApartmentModeService(session, APT, "PARTITIONED");
    const afterFirstFlip = listingStore.size;
    expect(afterFirstFlip).toBe(2); // Whole + new Master

    await flipApartmentModeService(session, APT, "WHOLE");
    expect(listingStore.size).toBe(afterFirstFlip);

    await flipApartmentModeService(session, APT, "PARTITIONED");
    expect(listingStore.size).toBe(afterFirstFlip);

    await flipApartmentModeService(session, APT, "WHOLE");
    expect(listingStore.size).toBe(afterFirstFlip);
  });

  it("returns 404 when apartment doesn't exist", async () => {
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    const result = await flipApartmentModeService(session, "missing-id", "WHOLE");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });

  // B5 regression — MIXED state (computed from listings of multiple kinds)
  // must be switchable to either target. The pre-fix check compared the
  // persisted enum column directly and falsely fired MODE_UNCHANGED.
  it("flips MIXED -> PARTITIONED (computed-mode resolution from MIXED)", async () => {
    // Persisted column says PARTITIONED, but active listings have BOTH kinds —
    // the computed mode is MIXED. Admin wants to "resolve to partitioned".
    seedApartment("PARTITIONED");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-whole", "Whole Unit"); // off-kind, kept active
    seedListing("l-master", "Master");

    const result = await flipApartmentModeService(session, APT, "PARTITIONED");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(apartmentStore.get(APT)!.listingMode).toBe("PARTITIONED");
  });

  it("flips MIXED -> WHOLE (computed-mode resolution from MIXED)", async () => {
    seedApartment("WHOLE");
    seedRoomType("rt-whole", "Whole Unit", "WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-whole", "Whole Unit");
    seedListing("l-master", "Master");

    const result = await flipApartmentModeService(session, APT, "WHOLE");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(apartmentStore.get(APT)!.listingMode).toBe("WHOLE");
  });

  it("returns MODE_UNCHANGED when computed mode (not persisted) equals target", async () => {
    // Persisted=WHOLE, but listings are only PARTITION kind → computed=PARTITIONED.
    // Caller targets PARTITIONED. The old persisted-only check would have passed
    // (WHOLE !== PARTITIONED). New check rejects because computed already
    // matches target — the apartment is already in PARTITIONED state.
    seedApartment("WHOLE");
    seedRoomType("rt-master", "Master", "PARTITION");
    seedListing("l-master", "Master");

    const result = await flipApartmentModeService(session, APT, "PARTITIONED");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
    expect(result.error).toBe("MODE_UNCHANGED");
  });
});

describe("updateApartmentSharedService — partitionBillingMode", () => {
  it("persists partitionBillingMode SUBSIDY on the apartment row", async () => {
    seedApartment("WHOLE");

    const result = await updateApartmentSharedService(session, APT, {
      partitionBillingMode: "SUBSIDY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.id).toBe(APT);
    expect(apartmentStore.get(APT)!.partitionBillingMode).toBe("SUBSIDY");
  });

  it("persists partitionBillingMode NO_SUBSIDY on the apartment row", async () => {
    seedApartment("WHOLE");
    // Seed with existing SUBSIDY value
    apartmentStore.set(APT, { ...apartmentStore.get(APT)!, partitionBillingMode: "SUBSIDY" });

    const result = await updateApartmentSharedService(session, APT, {
      partitionBillingMode: "NO_SUBSIDY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(apartmentStore.get(APT)!.partitionBillingMode).toBe("NO_SUBSIDY");
  });

  it("omitting partitionBillingMode leaves existing value unchanged", async () => {
    seedApartment("WHOLE");
    apartmentStore.set(APT, { ...apartmentStore.get(APT)!, partitionBillingMode: "SUBSIDY" });

    const result = await updateApartmentSharedService(session, APT, {});

    expect(result.ok).toBe(true);
    // partitionBillingMode was not in the patch — existing value must be untouched
    expect(apartmentStore.get(APT)!.partitionBillingMode).toBe("SUBSIDY");
  });

  it("returns 404 when apartment not found", async () => {
    const result = await updateApartmentSharedService(session, "does-not-exist", {
      partitionBillingMode: "SUBSIDY",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });
});

describe("updateApartmentSharedService — monthly TNB subsidy cap", () => {
  it("persists a per-unit monthly cap and can clear it back to legacy policy", async () => {
    seedApartment("PARTITIONED");

    const setResult = await updateApartmentSharedService(session, APT, {
      tnbSubsidyCapMonthly: 200,
    });
    expect(setResult.ok).toBe(true);
    expect(apartmentStore.get(APT)!.tnbSubsidyCapMonthly).toBe(200);

    const clearResult = await updateApartmentSharedService(session, APT, {
      tnbSubsidyCapMonthly: null,
    });
    expect(clearResult.ok).toBe(true);
    expect(apartmentStore.get(APT)!.tnbSubsidyCapMonthly).toBeNull();
  });

  it("omitting the cap leaves the existing policy unchanged", async () => {
    seedApartment("PARTITIONED");
    apartmentStore.set(APT, {
      ...apartmentStore.get(APT)!,
      tnbSubsidyCapMonthly: 200,
    });

    const result = await updateApartmentSharedService(session, APT, {
      bedrooms: 3,
    });
    expect(result.ok).toBe(true);
    expect(apartmentStore.get(APT)!.tnbSubsidyCapMonthly).toBe(200);
  });
});

describe("updateApartmentSharedService — underManagement", () => {
  // B3: present-key write — the value must land on the apartment row.
  it("sets underManagement on the apartment row when present", async () => {
    seedApartment("WHOLE");

    const result = await updateApartmentSharedService(session, APT, {
      underManagement: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(apartmentStore.get(APT)!.underManagement).toBe(false);
  });

  // B4: present-key semantics — omitting the field must leave any existing
  // value on the row untouched, never clobber it with undefined.
  it("omitting underManagement leaves existing value unchanged", async () => {
    seedApartment("WHOLE");
    apartmentStore.set(APT, { ...apartmentStore.get(APT)!, underManagement: true });

    const result = await updateApartmentSharedService(session, APT, {
      bedrooms: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(apartmentStore.get(APT)!.underManagement).toBe(true);
  });
});

describe("updateApartmentSharedSchema — underManagement", () => {
  // B1: the schema must not silently strip a recognized boolean field.
  it("accepts underManagement boolean and preserves it in the parsed output", () => {
    const result = updateApartmentSharedSchema.safeParse({ underManagement: false });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.underManagement).toBe(false);
  });

  // B2: a non-boolean value must fail validation, not be coerced or stripped.
  it("rejects non-boolean underManagement", () => {
    const result = updateApartmentSharedSchema.safeParse({ underManagement: "yes" });
    expect(result.success).toBe(false);
  });
});

describe("updateApartmentSharedService — owner fan-out", () => {
  it("(a) setting ownerPartyId fans out via listing.updateMany scoped to apartment+org+non-archived and records the propagate audit", async () => {
    seedApartment("PARTITIONED");
    seedOwnerPartyRole();
    seedListing("l-room-1", "Master");
    seedListing("l-room-2", "Room 2");
    seedListing("l-archived", "Room 3", "archived");

    const { recordAudit: mockAudit } = await import("../../../lib/audit");

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // All non-archived listings should have ownerPartyId set
    expect(listingStore.get("l-room-1")!.ownerPartyId).toBe(OWNER_PARTY);
    expect(listingStore.get("l-room-2")!.ownerPartyId).toBe(OWNER_PARTY);
    // Archived listing should NOT be updated
    expect(listingStore.get("l-archived")!.ownerPartyId).toBeUndefined();

    // updateMany must have been called with the correct where clause
    expect(dbMock.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          apartmentId: APT,
          organizationId: ORG,
          listingStatus: { not: "archived" },
        }),
        data: { ownerPartyId: OWNER_PARTY },
      }),
    );

    // The propagate audit must be recorded (second audit call after apartment.shared.update)
    const auditCalls = (mockAudit as ReturnType<typeof vi.fn>).mock.calls;
    const propagateCall = auditCalls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.action === "inventory.owner.propagate",
    );
    expect(propagateCall).toBeDefined();
    const propagateMeta = propagateCall?.[1] as Record<string, unknown>;
    expect(propagateMeta?.meta).toMatchObject({
      ownerPartyId: OWNER_PARTY,
      source: "apartment-shared",
    });
  });

  it("(b) non-owner party returns 400 and no fan-out occurs", async () => {
    seedApartment("WHOLE");
    // NON_OWNER_PARTY has no partyRole entry, so partyRole.findFirst returns null
    seedListing("l-whole", "Whole Unit");

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: NON_OWNER_PARTY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(400);
    expect(result.error).toBe("Assigned party is not an owner");

    // No fan-out should happen
    expect(dbMock.listing.updateMany).not.toHaveBeenCalled();
  });

  it("(c) clearing ownerPartyId to null fans out null to non-archived listings", async () => {
    seedApartment("WHOLE");
    seedListing("l-whole", "Whole Unit");
    // Pre-seed the owner
    listingStore.set("l-whole", { ...listingStore.get("l-whole")!, ownerPartyId: OWNER_PARTY });

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Listing should have ownerPartyId cleared to null
    expect(listingStore.get("l-whole")!.ownerPartyId).toBeNull();

    // updateMany must have been called with null owner
    expect(dbMock.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ownerPartyId: null },
      }),
    );

    // partyRole.findFirst should NOT be called for null (clearing is always allowed)
    expect(dbMock.partyRole.findFirst).not.toHaveBeenCalled();
  });

  it("(d) absent ownerPartyId causes no updateMany call", async () => {
    seedApartment("WHOLE");
    seedListing("l-whole", "Whole Unit");

    const result = await updateApartmentSharedService(session, APT, {
      partitionBillingMode: "NO_SUBSIDY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // No owner field in payload — must not fan out
    expect(dbMock.listing.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Carpark fan-out.
//
// `Carpark.ownerPartyId` mirrors the apartment's `Listing.ownerPartyId`
// (schema.prisma:459) and owner-ledger.sync-hook.ts:153 attributes a bay's
// charges through it. Before this fan-out existed, re-pointing an owner from
// "Edit shared details" updated the listings but left every bay on the PREVIOUS
// owner, so that apartment's carpark charges kept footing to the wrong ledger.
// ---------------------------------------------------------------------------
describe("updateApartmentSharedService — carpark fan-out", () => {
  it("(e) setting ownerPartyId fans out to every non-inactive bay, skipping inactive ones", async () => {
    seedApartment("PARTITIONED");
    seedOwnerPartyRole();
    seedListing("l-room-1", "Master");
    seedCarpark("cp-available", "available");
    seedCarpark("cp-rented", "rented");
    seedCarpark("cp-inactive", "inactive");

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Byte-identical to updateUnitService's where-clause (inventory.service.ts).
    expect(dbMock.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: APT,
        organizationId: ORG,
        status: { not: "inactive" },
      },
      data: { ownerPartyId: OWNER_PARTY },
    });

    // Live bays take the new owner...
    expect(carparkStore.get("cp-available")!.ownerPartyId).toBe(OWNER_PARTY);
    expect(carparkStore.get("cp-rented")!.ownerPartyId).toBe(OWNER_PARTY);
    // ...inactive bays are deliberately out of scope.
    expect(carparkStore.get("cp-inactive")!.ownerPartyId).toBeUndefined();
  });

  // F5: `affectedCount` counts LISTINGS only. The bay count must be recorded too,
  // otherwise the audit trail cannot show the carpark fan-out ever ran.
  it("(e2) records carparkAffectedCount on the propagate audit", async () => {
    seedApartment("PARTITIONED");
    seedOwnerPartyRole();
    seedListing("l-room-1", "Master");
    seedCarpark("cp-available", "available");
    seedCarpark("cp-rented", "rented");
    seedCarpark("cp-inactive", "inactive"); // excluded from the fan-out

    const { recordAudit: mockAudit } = await import("../../../lib/audit");
    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });
    expect(result.ok).toBe(true);

    const propagateCall = (mockAudit as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) =>
        (call[1] as Record<string, unknown>)?.action === "inventory.owner.propagate",
    );
    expect(propagateCall).toBeDefined();
    expect((propagateCall?.[1] as Record<string, unknown>)?.meta).toMatchObject({
      ownerPartyId: OWNER_PARTY,
      source: "apartment-shared",
      affectedCount: 1, // one non-archived listing
      carparkAffectedCount: 2, // available + rented, NOT inactive
    });
  });

  // F3. The previous-owner resolve used to run on the BARE client, before
  // `db.$transaction` opened. Under READ COMMITTED a concurrent re-point committing in
  // that window makes `previousApartmentOwnerPartyId` name a party that is no longer the
  // previous owner, so `rematerializeOwnerRecentMonths` rebuilds the WRONG owner's
  // ledger and the true previous owner keeps income for rows since re-pointed away.
  // Both create paths already re-read their owner evidence inside the transaction; this
  // path — rewritten in the same commit — did not.
  it("(f) issues the previous-owner resolve AND the fan-out on the transaction client, not the bare client", async () => {
    seedApartment("WHOLE");
    seedOwnerPartyRole();
    seedListing("l-whole", "Whole Unit");

    // A tx handle with spies DISTINCT from dbMock's. If both shared one spy, the
    // "ran inside the transaction" assertion below would prove nothing.
    const txDouble = {
      apartment: { update: vi.fn(async () => ({ id: APT })) },
      listing: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      carpark: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    };
    dbMock.$transaction.mockImplementation(
      async (cb: (tx: typeof dbMock) => Promise<unknown>) =>
        cb(txDouble as unknown as typeof dbMock),
    );

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // The previous-owner probe reads the same snapshot the fan-out overwrites.
    expect(txDouble.listing.findFirst).toHaveBeenCalled();
    expect(dbMock.listing.findFirst).not.toHaveBeenCalled();
    expect(dbMock.carpark.findFirst).not.toHaveBeenCalled();

    // The fan-out rides the same tx as the listing fan-out, so it rolls back with it.
    expect(txDouble.listing.updateMany).toHaveBeenCalled();
    expect(txDouble.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: APT,
        organizationId: ORG,
        status: { not: "inactive" },
      },
      data: { ownerPartyId: OWNER_PARTY },
    });
    expect(dbMock.carpark.updateMany).not.toHaveBeenCalled();
  });

  it("(g) a shared-fields-only edit does not touch bays", async () => {
    seedApartment("WHOLE");
    seedListing("l-whole", "Whole Unit");
    seedCarpark("cp-available", "available");

    const result = await updateApartmentSharedService(session, APT, {
      partitionBillingMode: "NO_SUBSIDY",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(dbMock.carpark.updateMany).not.toHaveBeenCalled();
    expect(carparkStore.get("cp-available")!.ownerPartyId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F5 — the previous-owner probe now routes through a resolver, so this file's
  // doubles must honour the filters that resolver issues. They did not: `listing
  // .findFirst` ignored `organizationId`, `ownerPartyId: { not: null }`,
  // `listingStatus` and `orderBy`, and `carpark.findFirst` was `async () => null`,
  // inspecting no arguments at all. A regression that dropped any of those filters --
  // the exact wave-5 I3 bug -- left every test in this file green.
  // -------------------------------------------------------------------------
  it("(i) never reads the previous owner from ANOTHER org's listing on the same apartment", async () => {
    seedApartment("WHOLE");
    seedOwnerPartyRole();
    // A row that is owned, active, and on this apartmentId -- but belongs to a
    // different organization. Org isolation is the ONLY thing excluding it.
    seedListing("l-foreign", "Whole Unit", "active", {
      organizationId: OTHER_ORG,
      ownerPartyId: FOREIGN_OWNER,
    });

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    // This apartment had NO previous owner in this org. Reading the foreign row would
    // rebuild a stranger's ledger and skip nobody's -- a cross-tenant ledger write.
    expect(rematerializedOwners()).toEqual([OWNER_PARTY]);
  });

  it("(j) reads the previous owner from an active BAY when no listing carries one", async () => {
    seedApartment("WHOLE");
    seedOwnerPartyRole();
    seedListing("l-ownerless", "Whole Unit"); // active, but ownerPartyId undefined
    seedCarpark("cp-available", "available", PREVIOUS_OWNER);

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    // The bay tier of `resolveApartmentOwnerAttributed`. Point the probe at
    // `resolveApartmentOwnerForInheritance` and the previous owner reads null, so the
    // old owner's ledger is never rebuilt and keeps income for the re-pointed bay.
    expect(rematerializedOwners()).toEqual([PREVIOUS_OWNER, OWNER_PARTY]);
  });

  it("(k) skips an ownerless sibling and an archived sibling to find the owned, active one", async () => {
    seedApartment("WHOLE");
    seedOwnerPartyRole();
    seedListing("l-1-ownerless", "Whole Unit");
    seedListing("l-2-archived", "Master", "archived", { ownerPartyId: FOREIGN_OWNER });
    seedListing("l-3-owned", "Room 2", "active", { ownerPartyId: PREVIOUS_OWNER });

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: OWNER_PARTY,
    });

    expect(result.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([PREVIOUS_OWNER, OWNER_PARTY]);
  });

  it("(h) clearing ownerPartyId to null also clears it on non-inactive bays", async () => {
    seedApartment("WHOLE");
    seedListing("l-whole", "Whole Unit");
    seedCarpark("cp-available", "available", OWNER_PARTY);
    seedCarpark("cp-inactive", "inactive", OWNER_PARTY);

    const result = await updateApartmentSharedService(session, APT, {
      ownerPartyId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(dbMock.carpark.updateMany).toHaveBeenCalledWith({
      where: {
        apartmentId: APT,
        organizationId: ORG,
        status: { not: "inactive" },
      },
      data: { ownerPartyId: null },
    });

    // This is the case that previously stranded a bay on a stale owner.
    expect(carparkStore.get("cp-available")!.ownerPartyId).toBeNull();
    expect(carparkStore.get("cp-inactive")!.ownerPartyId).toBe(OWNER_PARTY);
  });
});
