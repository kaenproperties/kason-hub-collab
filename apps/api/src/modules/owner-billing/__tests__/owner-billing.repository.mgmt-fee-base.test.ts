/**
 * ⚠️ MONEY — the management-fee base is the rent BILLED for the month.
 *
 * `rentBase` (the tenancy's contracted `monthlyRentAmount`) is NOT a fee base.
 * A tenancy starting mid-month is billed prorated rent, so charging a full
 * month's fee on it over-bills the owner and permanently disagrees with the §5
 * payout deduction, which takes its fee off COLLECTED income.
 *
 * The reported case: rent RM 5.00, tenancy starts 2026-08-17 → rent billed
 * RM 2.42 (15/31 days), but the IVOWN fee was RM 0.50 + RM 0.04 SST = RM 0.54,
 * computed off the full RM 5.00. It must be RM 0.24 + RM 0.02 = RM 0.26.
 *
 * `rentBaseForMonth` must also honour the SAME precedence the rent charge is
 * minted from (resolveMonthlyRentAmount): active RecurringCharge(rent) →
 * reservation.agreedMonthlyRent → tenancy.monthlyRentAmount.
 *
 * Pure unit test — @kason/db is mocked, no Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  listing: { findMany: vi.fn() },
  recurringCharge: { findMany: vi.fn() },
  charge: { findMany: vi.fn() },
};

vi.mock("@kason/db", () => ({ getDb: () => dbMock, Prisma: {} }));

import { resolveOwnerUnitsForMonth } from "../owner-billing.repository";
import { computeManagementFee } from "@kason/shared";

const AUG = new Date(Date.UTC(2026, 7, 1)); // August 2026 — 31 days

/** One owned listing with an active tenancy, in the shape the resolver selects. */
function listingWithTenancy(t: {
  monthlyRentAmount: string;
  startDate: string;
  endDate?: string | null;
  agreedMonthlyRent?: string | null;
}) {
  return {
    id: "unit-1",
    apartment: { id: "apt-1", unitCode: "A-01-01", propertyId: "prop-1" },
    tenancies: [
      {
        id: "tenancy-1",
        monthlyRentAmount: t.monthlyRentAmount,
        startDate: new Date(t.startDate),
        endDate: t.endDate ? new Date(t.endDate) : null,
        status: "active",
        reservation:
          t.agreedMonthlyRent != null ? { agreedMonthlyRent: t.agreedMonthlyRent } : null,
      },
    ],
  };
}

/** A handover month: two tenancies that between them cover the whole month. */
function listingWithHandover() {
  return {
    id: "unit-1",
    apartment: { id: "apt-1", unitCode: "A-01-01", propertyId: "prop-1" },
    tenancies: [
      {
        id: "tenancy-out",
        monthlyRentAmount: "3100.00",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-08-10T00:00:00.000Z"),
        status: "ended",
        reservation: null,
      },
      {
        id: "tenancy-in",
        monthlyRentAmount: "3100.00",
        startDate: new Date("2026-08-11T00:00:00.000Z"),
        endDate: null,
        status: "active",
        reservation: null,
      },
    ],
  };
}

beforeEach(() => {
  dbMock.listing.findMany.mockReset();
  dbMock.recurringCharge.findMany.mockReset();
  dbMock.recurringCharge.findMany.mockResolvedValue([]);
  dbMock.charge.findMany.mockReset();
  dbMock.charge.findMany.mockResolvedValue([]);
});

describe("resolveOwnerUnitsForMonth — rentBaseForMonth (management-fee base)", () => {
  it("prorates a mid-month start: RM 5.00 from Aug 17 → RM 2.42, not RM 5.00", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({ monthlyRentAmount: "5.00", startDate: "2026-08-17T00:00:00.000Z" }),
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);

    // 15 of 31 days: 5.00 × 15/31 = 2.4194 → 2.42
    expect(unit!.rentBaseForMonth).toBe("2.42");
    // …and the contracted figure is still exposed, unchanged, for its own callers.
    expect(unit!.rentBase).toBe("5.00");
  });

  it("the reported invoice: 10% + 8% SST on the prorated base is RM 0.26, not RM 0.54", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({ monthlyRentAmount: "5.00", startDate: "2026-08-17T00:00:00.000Z" }),
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    const cfg = { feeType: "percent" as const, feeValue: "10", capAmount: null, sstPercent: "8" };

    const fee = computeManagementFee(cfg, unit!.rentBaseForMonth);
    expect(fee.base).toBe("0.24");
    expect(fee.sst).toBe("0.02");
    expect(fee.total).toBe("0.26");

    // The bug, pinned: the contracted base is what produced the RM 0.54 invoice.
    expect(computeManagementFee(cfg, unit!.rentBase).total).toBe("0.54");
  });

  it("a full month is untouched — prorated equals contracted (no silent re-pricing)", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({ monthlyRentAmount: "2000.00", startDate: "2026-01-01T00:00:00.000Z" }),
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    expect(unit!.rentBaseForMonth).toBe("2000.00");
    expect(unit!.rentBase).toBe("2000.00");
  });

  it("prorates a mid-month MOVE-OUT too (endDate inside the month)", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({
        monthlyRentAmount: "3100.00",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-08-10T00:00:00.000Z",
      }),
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    // Aug 1–10 inclusive = 10 of 31 days: 3100 × 10/31 = 1000.00
    expect(unit!.rentBaseForMonth).toBe("1000.00");
  });

  it("honours rent precedence: reservation.agreedMonthlyRent outranks tenancy rent", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({
        monthlyRentAmount: "5.00",
        agreedMonthlyRent: "10.00",
        startDate: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    expect(unit!.rentBaseForMonth).toBe("10.00");
  });

  it("honours rent precedence: an active RecurringCharge(rent) outranks both", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      listingWithTenancy({
        monthlyRentAmount: "5.00",
        agreedMonthlyRent: "10.00",
        startDate: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    dbMock.recurringCharge.findMany.mockResolvedValue([
      { tenancyId: "tenancy-1", amount: "20.00" },
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    expect(unit!.rentBaseForMonth).toBe("20.00");

    // Batched, never one query per unit.
    expect(dbMock.recurringCharge.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.recurringCharge.findMany.mock.calls[0]![0].where).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        tenancyId: { in: ["tenancy-1"] },
        chargeType: "rent",
        isActive: true,
      }),
    );
  });

  it("handover month: sums EVERY overlapping tenancy, so the fee is not under-billed", async () => {
    // Aug 1–10 (10/31) + Aug 11–31 (21/31) of RM 3100 = 1000.00 + 2100.00.
    // Taking only the primary tenancy's share would bill the fee on 2100 and
    // silently drop the departing tenant's 1000 — the unit was occupied, and
    // billed, for the whole month.
    dbMock.listing.findMany.mockResolvedValue([listingWithHandover()]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    expect(unit!.rentBaseForMonth).toBe("3100.00");
    expect(unit!.occupied).toBe(true);
  });

  it("a vacant unit has no tenancy → both bases are '0' and no override query runs", async () => {
    dbMock.listing.findMany.mockResolvedValue([
      { id: "unit-2", apartment: { id: "apt-2", unitCode: "A-02", propertyId: "prop-1" }, tenancies: [] },
    ]);

    const [unit] = await resolveOwnerUnitsForMonth("org-1", "owner-1", AUG);
    expect(unit!.occupied).toBe(false);
    expect(unit!.rentBase).toBe("0");
    // 2dp money string (cent-summed across zero tenancies), not the bare "0"
    // `rentBase` carries — both parse to 0 cents for computeManagementFee.
    expect(unit!.rentBaseForMonth).toBe("0.00");
    expect(dbMock.recurringCharge.findMany).not.toHaveBeenCalled();
  });
});
