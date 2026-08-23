import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncOccupancyTenancy } from "../occupancy-tenancy-sync";

vi.mock("../../tenancy/tenancy-code-generator", () => ({
  generateTenancyCodeTx: vi.fn().mockResolvedValue("TEN-2026-0001"),
}));

const buildTx = () => ({
  party: {
    // findFirst now validates the LINK target (partyType=tenant, same org).
    findFirst: vi.fn().mockResolvedValue({ id: "party-link", partyType: "tenant" }),
    create: vi.fn(), // must NEVER be called now (pick-existing only)
  },
  tenancy: {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "tenancy-new" }),
    update: vi.fn().mockResolvedValue({ id: "tenancy-existing" }),
  },
  // Auto-release hook (Task 3.3): ending a tenancy releases its carpark bays via
  // releaseAssignmentsForTenancyTx (tx.carparkAssignment.findMany → tx.carpark.update).
  // No active assignments here, so the release is a no-op.
  carparkAssignment: {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  },
  carpark: {
    update: vi.fn(),
  },
  chargeCategory: {
    findFirst: vi.fn().mockResolvedValue({ id: "cat-ta" }),
  },
  invoice: {
    create: vi.fn().mockResolvedValue({ id: "invoice-ta" }),
    update: vi.fn(),
  },
  charge: {
    create: vi.fn().mockResolvedValue({ id: "ta-base" }),
    findMany: vi.fn().mockResolvedValue([{ amount: "462.96" }, { amount: "37.04" }]),
  },
});

describe("syncOccupancyTenancy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("vacant → occupied: links the chosen tenantPartyId; NEVER creates a Party", async () => {
    const tx = buildTx();
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-05-20"),
      },
    });
    expect(tx.party.create).not.toHaveBeenCalled();
    expect(tx.party.findFirst).toHaveBeenCalledWith({
      where: { id: "party-link", organizationId: "org-1", partyType: "tenant" },
      select: { id: true },
    });
    expect(tx.tenancy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1", propertyId: "prop-1", unitId: "unit-1",
        tenantPartyId: "party-link", tenancyCode: "TEN-2026-0001",
        status: "active", billingStatus: "active",
        startDate: new Date("2026-04-25"), endDate: new Date("2026-05-20"),
        monthlyRentAmount: 2600,
      }),
      select: { id: true },
    });
  });

  it("occupied → occupied (same tenant, edited dates): in-place update", async () => {
    const tx = buildTx();
    tx.tenancy.findFirst.mockResolvedValueOnce({ id: "tenancy-existing", tenantPartyId: "party-link" });
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "occupied", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-06-20"),
      },
    });
    expect(tx.tenancy.create).not.toHaveBeenCalled();
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-existing" },
      data: expect.objectContaining({ startDate: new Date("2026-04-25"), endDate: new Date("2026-06-20") }),
    });
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-existing" },
      data: expect.not.objectContaining({ monthlyRentAmount: expect.anything() }),
    });
  });

  it("occupied → occupied (different tenant): closes old, creates new linked tenancy", async () => {
    const tx = buildTx();
    tx.tenancy.findFirst.mockResolvedValueOnce({ id: "tenancy-old", tenantPartyId: "party-old" });
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "occupied", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-06-01"), moveOutDate: new Date("2026-12-01"),
      },
    });
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-old" }, data: expect.objectContaining({ status: "ended" }),
    });
    expect(tx.tenancy.create).toHaveBeenCalled();
  });

  it("rejects a tenantPartyId that is not a tenant in this org (no create, throws)", async () => {
    const tx = buildTx();
    tx.party.findFirst.mockResolvedValueOnce(null); // not found as a tenant in org
    await expect(
      syncOccupancyTenancy({
        tx: tx as any, orgId: "org-1",
        unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
        incoming: {
          occupancyStatus: "occupied", tenantPartyId: "party-link",
          moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-05-20"),
        },
      }),
    ).rejects.toThrow(/tenant/i);
    expect(tx.party.create).not.toHaveBeenCalled();
    expect(tx.tenancy.create).not.toHaveBeenCalled();
  });

  it("vacant → occupied with NO owner on the unit: blocks the create, throws", async () => {
    const tx = buildTx();
    await expect(
      syncOccupancyTenancy({
        tx: tx as any, orgId: "org-1",
        unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: null },
        incoming: {
          occupancyStatus: "occupied", tenantPartyId: "party-link",
          moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-05-20"),
        },
      }),
    ).rejects.toThrow(/no assigned owner/i);
    // No tenancy is created for an owner-less unit.
    expect(tx.tenancy.create).not.toHaveBeenCalled();
  });

  it("occupied → vacant: closes active tenancy, no link lookup", async () => {
    const tx = buildTx();
    tx.tenancy.findFirst.mockResolvedValueOnce({ id: "tenancy-active", tenantPartyId: "p" });
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "occupied", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: { occupancyStatus: "vacant" },
    });
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-active" }, data: expect.objectContaining({ status: "ended" }),
    });
    expect(tx.party.findFirst).not.toHaveBeenCalled();
    expect(tx.tenancy.create).not.toHaveBeenCalled();
  });

  it("create persists the commission fields onto the new tenancy", async () => {
    const tx = buildTx();
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-05-20"),
        firstMonthIsCommission: true, commissionSstBearer: "kaen",
      },
    });
    expect(tx.tenancy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ firstMonthIsCommission: true, commissionSstBearer: "kaen" }),
      select: { id: true },
    });
  });

  it("create defaults commission to false/owner when not supplied", async () => {
    const tx = buildTx();
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-05-20"),
      },
    });
    expect(tx.tenancy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ firstMonthIsCommission: false, commissionSstBearer: "owner" }),
      select: { id: true },
    });
  });

  it("keeps the SST-inclusive initial TA amount unchanged in the tenancy start month", async () => {
    const tx = buildTx();
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2027-04-24"),
        tenancyAgreementFeeAmount: 500,
      },
    });

    expect(tx.charge.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chargeType: "tenancy_agreement_fee",
        description: "TA (WITH SST)",
        amount: "462.96",
        outstandingAmount: "462.96",
        sstRate: "8",
        billingMonth: new Date("2026-04-01T00:00:00.000Z"),
      }),
      select: { id: true },
    });
    expect(tx.charge.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chargeNumber: "TAF-tenancy-new-SST",
        chargeType: "tenancy_agreement_fee",
        description: "TA (WITH SST) — SST 8%",
        amount: "37.04",
        outstandingAmount: "37.04",
        sstRate: "0",
        parentChargeId: "ta-base",
        billingMonth: new Date("2026-04-01T00:00:00.000Z"),
      }),
    });
  });

  it("same-tenant edit updates commission when supplied", async () => {
    const tx = buildTx();
    tx.tenancy.findFirst.mockResolvedValueOnce({ id: "tenancy-existing", tenantPartyId: "party-link" });
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "occupied", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-06-20"),
        firstMonthIsCommission: true,
      },
    });
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-existing" },
      data: expect.objectContaining({ firstMonthIsCommission: true }),
    });
  });

  it("same-tenant dates-only edit leaves stored commission untouched", async () => {
    const tx = buildTx();
    tx.tenancy.findFirst.mockResolvedValueOnce({ id: "tenancy-existing", tenantPartyId: "party-link" });
    await syncOccupancyTenancy({
      tx: tx as any, orgId: "org-1",
      unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "occupied", rentalRate: 2600, ownerPartyId: "owner-1" },
      incoming: {
        occupancyStatus: "occupied", tenantPartyId: "party-link",
        moveInDate: new Date("2026-04-25"), moveOutDate: new Date("2026-06-20"),
      },
    });
    expect(tx.tenancy.update).toHaveBeenCalledWith({
      where: { id: "tenancy-existing" },
      data: expect.not.objectContaining({ firstMonthIsCommission: expect.anything() }),
    });
  });

  it("throws when occupied but tenantPartyId/dates missing", async () => {
    const tx = buildTx();
    await expect(
      syncOccupancyTenancy({
        tx: tx as any, orgId: "org-1",
        unit: { id: "unit-1", propertyId: "prop-1", occupancyStatus: "vacant", rentalRate: 2600, ownerPartyId: "owner-1" },
        incoming: { occupancyStatus: "occupied" },
      }),
    ).rejects.toThrow(/tenantPartyId, moveInDate, moveOutDate are required/);
    expect(tx.party.create).not.toHaveBeenCalled();
  });
});
