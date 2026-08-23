import { describe, expect, it } from "vitest";
import { Prisma } from "@kason/db";
import {
  buildGridBillUtilityPlan,
  billRoomsFromLoaded,
  resolveGridTnbSubsidy,
} from "../service";

const dec = (value: number) => new Prisma.Decimal(String(value));

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    apartmentId: "apt-1",
    tnbTotalRaw: dec(100),
    airSelangorRaw: dec(20),
    cleaning: dec(0),
    wifi: dec(0),
    maintenanceFee: dec(0),
    cleaningNature: null,
    wifiNature: null,
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    billedAt: null,
    invoicedAt: null,
    ...overrides,
  } as Parameters<typeof buildGridBillUtilityPlan>[0]["entry"];
}

const defaults = {
  partitionBillingMode: "NO_SUBSIDY",
  subsidyPerPax: 0,
  billingDocuments: true,
  ownerListingId: "owner-room",
} as const;

describe("billRoomsFromLoaded", () => {
  it("uses the loaded readings to synthesize the exact WHOLE Bill room without I/O", () => {
    const shaped = billRoomsFromLoaded(
      [
        { unitId: "raw-a", tenancyId: null, partyId: null, pax: 0, airconCharge: 12 },
        { unitId: "raw-b", tenancyId: null, partyId: null, pax: 0, airconCharge: 8 },
      ],
      true,
      { tenancyId: "ten-1", partyId: "party-1", unitId: "whole-room" },
    );

    expect(shaped).toEqual({
      rooms: [{ unitId: "whole-room", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 20 }],
      blockedTenancyIds: [],
    });
  });
});

describe("buildGridBillUtilityPlan", () => {
  it("uses the synthesized WHOLE room for pooled utilities and private aircond", () => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ cleaning: dec(15), wifi: dec(5), cleaningBearer: "tenant", wifiBearer: "tenant" }),
      rawRooms: [{ unitId: "raw-room", tenancyId: null, partyId: null, pax: 0, airconCharge: 10 }],
      isWholeUnit: true,
      activeTenancy: { tenancyId: "ten-1", partyId: "party-1", unitId: "whole-room" },
    });

    expect(plan.status).toBe("ready");
    expect(plan.mode).toBe("whole");
    expect(plan.lines.map((line) => [line.code, line.payer, line.amount, line.listingId])).toEqual([
      ["electricity", "tenant", "90.00", "whole-room"],
      ["water", "tenant", "20.00", "whole-room"],
      ["wifi", "tenant", "5.00", "whole-room"],
      ["cleaning", "tenant", "15.00", "whole-room"],
      ["private_aircond", "tenant", "10.00", "whole-room"],
    ]);
  });

  it("uses the configured SUBSIDY rate per pax and keeps each room's negative offset + private meter", () => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ tnbTotalRaw: dec(120), airSelangorRaw: dec(30) }),
      rawRooms: [
        { unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 10 },
        { unitId: "room-2", tenancyId: "ten-2", partyId: "party-2", pax: 2, airconCharge: 20 },
      ],
      isWholeUnit: false,
      partitionBillingMode: "SUBSIDY",
      activeTenancy: null,
      subsidyPerPax: 35,
    });

    expect(plan.status).toBe("ready");
    expect(plan.mode).toBe("subsidy");
    expect(plan.subsidyPerPax).toBe("35.00");
    expect(plan.lines.map((line) => [line.listingId, line.code, line.amount])).toEqual([
      ["room-1", "electricity", "30.00"],
      ["room-1", "water", "10.00"],
      ["room-1", "subsidy", "-35.00"],
      ["room-2", "electricity", "60.00"],
      ["room-2", "water", "20.00"],
      ["room-2", "subsidy", "-70.00"],
      ["room-1", "private_aircond", "10.00"],
      ["room-2", "private_aircond", "20.00"],
    ]);
  });

  it("explains the unit TNB cap without adding a second monetary line", () => {
    const resolvedSubsidy = resolveGridTnbSubsidy({
      isWholeUnit: false,
      partitionBillingMode: "SUBSIDY",
      subsidyPerPax: 50,
      apartmentTnbSubsidyCap: 200,
      billedAt: null,
      subsidyPolicySnapshot: null,
      tnbSubsidyCapSnapshot: null,
    });
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ tnbTotalRaw: dec(300), airSelangorRaw: dec(0) }),
      rawRooms: [
        { unitId: "room-A", tenancyId: "ten-A", partyId: "party-A", pax: 1, airconCharge: 18 },
        { unitId: "room-B", tenancyId: "ten-B", partyId: "party-B", pax: 1, airconCharge: 30 },
        { unitId: "room-C", tenancyId: "ten-C", partyId: "party-C", pax: 1, airconCharge: 48 },
      ],
      isWholeUnit: false,
      partitionBillingMode: "SUBSIDY",
      activeTenancy: null,
      subsidyPerPax: 50,
      resolvedSubsidy,
    });

    expect(plan).toMatchObject({
      status: "ready",
      subsidyPolicy: "unit_tnb_cap_equal_tenancy",
      tnbSubsidyCap: "200.00",
      tnbSubsidyBreakdown: {
        residual: "204.00",
        ownerCap: "200.00",
        ownerPortion: "200.00",
        tenantExcess: "4.00",
        occupiedRoomCount: 3,
        allocations: [
          { listingId: "room-A", tenancyId: "ten-A", amount: "1.34" },
          { listingId: "room-B", tenancyId: "ten-B", amount: "1.33" },
          { listingId: "room-C", tenancyId: "ten-C", amount: "1.33" },
        ],
      },
    });
    // The breakdown is informational: the only persisted-money preview remains
    // the existing gross electricity + negative subsidy component pair.
    expect(plan.lines.filter((line) => line.code === "electricity")).toHaveLength(3);
    expect(plan.lines.filter((line) => line.code === "subsidy")).toHaveLength(3);
    expect(plan.lines.some((line) => line.code === "tnb_cap_excess")).toBe(false);
  });

  it("still lists private aircond when subsidy reduces the pooled allocation to RM0", () => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ tnbTotalRaw: dec(5), airSelangorRaw: dec(10) }),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 5 }],
      isWholeUnit: false,
      partitionBillingMode: "SUBSIDY",
      activeTenancy: null,
      subsidyPerPax: 50,
    });

    expect(plan.status).toBe("ready");
    expect(plan.lines).toEqual([
      expect.objectContaining({ code: "private_aircond", amount: "5.00", listingId: "room-1" }),
    ]);
  });

  it("mirrors tenant-direct skips and owner raw/bearer components", () => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({
        tnbTotalRaw: dec(100),
        airSelangorRaw: dec(30),
        cleaning: dec(20),
        wifi: dec(10),
        tnbPattern: "absorbed",
        airPattern: "tenant_direct",
        cleaningBearer: "owner",
        wifiBearer: "tenant",
      }),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 0 }],
      isWholeUnit: false,
      activeTenancy: null,
    });

    expect(plan.status).toBe("ready");
    expect(plan.lines.map((line) => [line.code, line.payer, line.amount])).toEqual([
      ["wifi", "tenant", "10.00"],
      ["electricity", "owner", "100.00"],
      ["cleaning", "owner", "20.00"],
    ]);
  });

  it.each([
    { pax: 0, partyId: "party-1" },
    { pax: -1, partyId: "party-1" },
    { pax: 2, partyId: null },
  ])("returns pax_blocked for an active room excluded by Bill's occupied predicate (%o)", ({ pax, partyId }) => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry(),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId, pax, airconCharge: 0 }],
      isWholeUnit: false,
      activeTenancy: null,
    });

    expect(plan).toMatchObject({ status: "pax_blocked", lines: [], blockedTenancyIds: ["ten-1"], errorCode: null });
  });

  it("surfaces compute/invariant/owner blockers instead of an exact-looking line total", () => {
    const computeError = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ tnbTotalRaw: dec(10), airSelangorRaw: dec(0) }),
      rawRooms: [{ unitId: "raw", tenancyId: null, partyId: null, pax: 0, airconCharge: 30 }],
      isWholeUnit: true,
      activeTenancy: { tenancyId: "ten-1", partyId: "party-1", unitId: "whole-room" },
    });
    expect(computeError).toMatchObject({ status: "unavailable", errorCode: "AIRCON_EXCEEDS_TNB", lines: [] });

    const absorbedError = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ tnbTotalRaw: dec(0), tnbPattern: "absorbed" }),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 0 }],
      isWholeUnit: false,
      activeTenancy: null,
    });
    expect(absorbedError).toMatchObject({ status: "unavailable", errorCode: "ABSORBED_REQUIRES_OWNER_BORNE", lines: [] });

    const ownerError = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ cleaning: dec(20), cleaningBearer: "owner" }),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 0 }],
      isWholeUnit: false,
      activeTenancy: null,
      ownerListingId: null,
    });
    expect(ownerError).toMatchObject({ status: "unavailable", errorCode: "OWNER_UNRESOLVED", lines: [] });
  });

  it("does not claim fresh exact lines for a component-aware re-Bill", () => {
    const plan = buildGridBillUtilityPlan({
      ...defaults,
      entry: entry({ billedAt: new Date("2026-08-10T00:00:00.000Z"), invoicedAt: new Date("2026-08-10T00:00:00.000Z") }),
      rawRooms: [{ unitId: "room-1", tenancyId: "ten-1", partyId: "party-1", pax: 1, airconCharge: 0 }],
      isWholeUnit: false,
      activeTenancy: null,
    });

    expect(plan).toMatchObject({ status: "rebill_review", lines: [], errorCode: null });
  });
});

describe("resolveGridTnbSubsidy", () => {
  it("adopts and prepares a snapshot for a new unit-cap row", () => {
    expect(resolveGridTnbSubsidy({
      isWholeUnit: false,
      // A cap is an explicit opt-in; it must not require the old mode toggle too.
      partitionBillingMode: "NO_SUBSIDY",
      subsidyPerPax: 50,
      apartmentTnbSubsidyCap: 200,
      billedAt: null,
      subsidyPolicySnapshot: null,
      tnbSubsidyCapSnapshot: null,
    })).toMatchObject({
      mode: "subsidy",
      computePolicy: { kind: "unit_tnb_cap_equal_tenancy", cap: 200 },
      policy: "unit_tnb_cap_equal_tenancy",
      tnbSubsidyCap: 200,
      snapshotOnBill: { policy: "unit_tnb_cap_equal_tenancy", cap: 200 },
    });
  });

  it("keeps a historical billed null-snapshot row on legacy per-pax", () => {
    expect(resolveGridTnbSubsidy({
      isWholeUnit: false,
      // The live setting changed after the historical Bill; null snapshot is the
      // compatibility marker and must not silently remove its legacy subsidy.
      partitionBillingMode: "NO_SUBSIDY",
      subsidyPerPax: 50,
      apartmentTnbSubsidyCap: 200,
      billedAt: new Date("2026-08-01T00:00:00.000Z"),
      subsidyPolicySnapshot: null,
      tnbSubsidyCapSnapshot: null,
    })).toMatchObject({
      computePolicy: { kind: "legacy_per_pax", amountPerPax: 50 },
      policy: "legacy_per_pax",
      tnbSubsidyCap: null,
      snapshotOnBill: null,
    });
  });

  it("locks policy markers for new legacy and no-subsidy partitioned rows", () => {
    expect(resolveGridTnbSubsidy({
      isWholeUnit: false,
      partitionBillingMode: "SUBSIDY",
      subsidyPerPax: 50,
      apartmentTnbSubsidyCap: null,
      billedAt: null,
      subsidyPolicySnapshot: null,
      tnbSubsidyCapSnapshot: null,
    }).snapshotOnBill).toEqual({ policy: "legacy_per_pax", cap: null });

    expect(resolveGridTnbSubsidy({
      isWholeUnit: false,
      partitionBillingMode: "NO_SUBSIDY",
      subsidyPerPax: 50,
      apartmentTnbSubsidyCap: null,
      billedAt: null,
      subsidyPolicySnapshot: null,
      tnbSubsidyCapSnapshot: null,
    }).snapshotOnBill).toEqual({ policy: "none", cap: null });
  });

  it("uses the frozen cap on re-Bill even after apartment settings change", () => {
    expect(resolveGridTnbSubsidy({
      isWholeUnit: false,
      partitionBillingMode: "NO_SUBSIDY",
      subsidyPerPax: 75,
      apartmentTnbSubsidyCap: 250,
      billedAt: new Date("2026-08-01T00:00:00.000Z"),
      subsidyPolicySnapshot: "unit_tnb_cap_equal_tenancy",
      tnbSubsidyCapSnapshot: 200,
    })).toMatchObject({
      mode: "subsidy",
      computePolicy: { kind: "unit_tnb_cap_equal_tenancy", cap: 200 },
      tnbSubsidyCap: 200,
      snapshotOnBill: null,
    });
  });
});
