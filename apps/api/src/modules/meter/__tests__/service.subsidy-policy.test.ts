import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

vi.mock("../repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository")>();
  return {
    ...actual,
    getBill: vi.fn(),
    findBillRooms: vi.fn(),
    findApartmentModes: vi.fn(),
    findUtilityBillingConfig: vi.fn(),
  };
});

import { getDb } from "@kason/db";
import * as repo from "../repository";
import { previewUtilityBillService } from "../service";

const ORG = "c2400000-0000-4000-8000-000000000001";
const USER = "c2400000-0000-4000-8000-000000000002";
const APT = "c2400000-0000-4000-8000-000000000003";
const session = {
  orgId: ORG,
  userId: USER,
  role: "manager" as const,
  userType: "operator" as const,
};

const getBill = vi.mocked(repo.getBill);
const findBillRooms = vi.mocked(repo.findBillRooms);
const findApartmentModes = vi.mocked(repo.findApartmentModes);
const findUtilityBillingConfig = vi.mocked(repo.findUtilityBillingConfig);

const draftBill = {
  id: "bill-1",
  organizationId: ORG,
  apartmentId: APT,
  periodMonth: new Date("2026-08-01T00:00:00.000Z"),
  billingMode: "no_subsidy",
  subsidyPolicySnapshot: null,
  tnbSubsidyCapSnapshot: null,
  subsidyPerPax: null,
  tnbTotal: "300.00",
  airSelangor: "0.00",
  indahWater: "0.00",
  cleaning: "0.00",
  wifi: null,
  indahWaterBearer: "owner",
  cleaningBearer: "owner",
  wifiBearer: "owner",
  status: "draft",
};

function room(
  suffix: string,
  airconAmount: number,
  pax = 1,
) {
  return {
    unitId: `room-${suffix}`,
    occupancyStatus: "occupied",
    unitCode: `A-${suffix}`,
    listingType: "room",
    tenancy: {
      id: `tenancy-${suffix}`,
      tenantPartyId: `party-${suffix}`,
      numberOfPax: pax,
    },
    reading: {
      id: `reading-${suffix}`,
      computedAmount: airconAmount.toFixed(2),
      consumption: "0.00",
      status: "submitted",
      chargeId: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDb).mockReturnValue({} as never);
  getBill.mockResolvedValue(draftBill as never);
  findUtilityBillingConfig.mockResolvedValue(50);
});

describe("previewUtilityBillService subsidy-policy integration", () => {
  it("treats a non-null apartment cap as policy opt-in and splits RM4 by active tenancy", async () => {
    findApartmentModes.mockResolvedValue({
      listingMode: "PARTITIONED",
      // The cap itself opts in even when the old mode is NO_SUBSIDY.
      partitionBillingMode: "NO_SUBSIDY",
      tnbSubsidyCapMonthly: "200.00",
    } as never);
    findBillRooms.mockResolvedValue([
      room("A", 18),
      room("B", 30, 5),
      room("C", 48, 2),
    ] as never);

    const response = await previewUtilityBillService(session, draftBill.id);
    expect(response.ok).toBe(true);
    const data = (response as {
      data: {
        leftoverTnb: number;
        subsidyCovered: number;
        subsidyPolicy: { kind: string; cap: number };
        allocations: { unitId: string; computedAmount: number }[];
      };
    }).data;

    expect(data.leftoverTnb).toBe(204);
    expect(data.subsidyCovered).toBe(200);
    expect(data.subsidyPolicy).toEqual({
      kind: "unit_tnb_cap_equal_tenancy",
      cap: 200,
    });
    expect(data.allocations.map((row) => [row.unitId, row.computedAmount])).toEqual([
      ["room-A", 1.34],
      ["room-B", 1.33],
      ["room-C", 1.33],
    ]);
  });

  it("keeps an old charged null-policy bill on its stored legacy rate", async () => {
    getBill.mockResolvedValue({
      ...draftBill,
      billingMode: "subsidy",
      status: "charged",
      subsidyPerPax: "35.00",
      tnbTotal: "100.00",
    } as never);
    findApartmentModes.mockResolvedValue({
      listingMode: "PARTITIONED",
      partitionBillingMode: "NO_SUBSIDY",
      tnbSubsidyCapMonthly: "200.00",
    } as never);
    findUtilityBillingConfig.mockResolvedValue(99);
    findBillRooms.mockResolvedValue([room("A", 0)] as never);

    const response = await previewUtilityBillService(session, draftBill.id);
    expect(response.ok).toBe(true);
    const data = (response as {
      data: {
        subsidyPolicy: { kind: string; amountPerPax: number };
        allocations: { computedAmount: number; subsidyDeduction: number }[];
      };
    }).data;

    expect(data.subsidyPolicy).toEqual({
      kind: "legacy_per_pax",
      amountPerPax: 35,
    });
    expect(data.allocations[0]).toMatchObject({
      computedAmount: 65,
      subsidyDeduction: 35,
    });
  });
});
