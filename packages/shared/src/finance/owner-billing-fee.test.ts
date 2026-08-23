import { describe, it, expect } from "vitest";
import {
  computeManagementFee,
  computeManagementFeeRentBase,
  effectiveWindowOverlapsBillingMonth,
  isInFreePeriod,
  shouldChargeMgmtFee,
} from "./owner-billing-fee";

const cfg = (o: Partial<Parameters<typeof computeManagementFee>[0]>) =>
  ({ feeType: "percent", feeValue: "10", capAmount: null, sstPercent: "8", ...o }) as Parameters<
    typeof computeManagementFee
  >[0];

describe("computeManagementFee", () => {
  it("percent: 10% of RM2000 rent → base 200, SST 16, total 216, effective 10.8%", () => {
    const r = computeManagementFee(cfg({}), "2000");
    expect(r.base).toBe("200.00");
    expect(r.sst).toBe("16.00");
    expect(r.total).toBe("216.00");
    expect(r.effectivePercentLabel).toBe("10.8%");
  });

  it("percent 7% → effective 7.56%", () => {
    expect(computeManagementFee(cfg({ feeValue: "7" }), "2000").effectivePercentLabel).toBe("7.56%");
  });

  it("fixed: flat RM250 regardless of rent → base 250, SST 20, total 270", () => {
    const r = computeManagementFee(cfg({ feeType: "fixed", feeValue: "250" }), "5000");
    expect(r.base).toBe("250.00");
    expect(r.sst).toBe("20.00");
    expect(r.total).toBe("270.00");
  });

  it("fixed: effectivePercentLabel shows the per-row SST percent, not a combined %", () => {
    const r = computeManagementFee(cfg({ feeType: "fixed", feeValue: "250" }), "5000");
    expect(r.effectivePercentLabel).toBe("8% SST");
  });

  it("cap: min(10% of 3000=300, cap 250) → base 250, SST 20, total 270", () => {
    const r = computeManagementFee(cfg({ feeType: "cap", feeValue: "10", capAmount: "250" }), "3000");
    expect(r.base).toBe("250.00");
    expect(r.total).toBe("270.00");
  });

  it("cap: when %×rent is below the cap, the % wins (per-owner cap, no hardcoded threshold)", () => {
    const r = computeManagementFee(cfg({ feeType: "cap", feeValue: "10", capAmount: "250" }), "2000");
    expect(r.base).toBe("200.00"); // 200 < 250 cap
  });

  it("rounds half-up to cents deterministically (200.155 → 200.16)", () => {
    const r = computeManagementFee(cfg({ feeValue: "10" }), "2001.55");
    expect(r.base).toBe("200.16"); // 200.155 → 200.16
  });

  it("does not hardcode the SST rate — a per-row 6% SST is honoured", () => {
    const r = computeManagementFee(cfg({ sstPercent: "6" }), "2000");
    expect(r.base).toBe("200.00");
    expect(r.sst).toBe("12.00");
    expect(r.total).toBe("212.00");
    expect(r.effectivePercentLabel).toBe("10.6%"); // 10 * 1.06
  });

  it("cap effective label uses the percent feeValue (combined with SST), not the cap amount", () => {
    const r = computeManagementFee(cfg({ feeType: "cap", feeValue: "10", capAmount: "250" }), "3000");
    expect(r.effectivePercentLabel).toBe("10.8%");
  });
});

describe("isInFreePeriod", () => {
  it("free-period zeroes the fee within [start,end]", () => {
    expect(
      isInFreePeriod("2026-03", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: "2026-06-30T00:00:00Z" }),
    ).toBe(true);
    expect(
      isInFreePeriod("2026-07", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: "2026-06-30T00:00:00Z" }),
    ).toBe(false);
  });

  it("is inclusive of the boundary months", () => {
    // first-of-month for "2026-01" is 2026-01-01 == start → inside
    expect(
      isInFreePeriod("2026-01", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: "2026-06-30T00:00:00Z" }),
    ).toBe(true);
    // first-of-month for "2026-06" is 2026-06-01 <= 2026-06-30 end → inside
    expect(
      isInFreePeriod("2026-06", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: "2026-06-30T00:00:00Z" }),
    ).toBe(true);
  });

  it("is false before the start month", () => {
    expect(
      isInFreePeriod("2025-12", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: "2026-06-30T00:00:00Z" }),
    ).toBe(false);
  });

  it("returns false when either bound is null", () => {
    expect(isInFreePeriod("2026-03", { freePeriodStart: null, freePeriodEnd: "2026-06-30T00:00:00Z" })).toBe(false);
    expect(isInFreePeriod("2026-03", { freePeriodStart: "2026-01-01T00:00:00Z", freePeriodEnd: null })).toBe(false);
    expect(isInFreePeriod("2026-03", { freePeriodStart: null, freePeriodEnd: null })).toBe(false);
  });
});

describe("computeManagementFeeRentBase", () => {
  it("uses the billed rent unchanged when no per-pax deduction is configured", () => {
    expect(computeManagementFeeRentBase([
      {
        billedRent: "1500.00",
        fullMonthRent: "3000.00",
        numberOfPax: 2,
        isCommissionMonth: false,
        fullyCollected: true,
      },
    ], null)).toEqual({ eligibleRentBase: "1500.00", fullyCollected: true, reason: null });
  });

  it("applies an optional per-pax deduction using the same rent proration ratio", () => {
    expect(computeManagementFeeRentBase([
      {
        billedRent: "500.00",
        fullMonthRent: "1000.00",
        numberOfPax: 2,
        isCommissionMonth: false,
        fullyCollected: true,
      },
    ], "50")).toEqual({ eligibleRentBase: "450.00", fullyCollected: true, reason: null });
  });

  it("excludes commission-month rent because it is not owner rental income", () => {
    expect(computeManagementFeeRentBase([
      {
        billedRent: "3000.00",
        fullMonthRent: "3000.00",
        numberOfPax: 1,
        isCommissionMonth: true,
        fullyCollected: true,
      },
    ], "0")).toEqual({
      eligibleRentBase: "0.00",
      fullyCollected: false,
      reason: "commission_month",
    });
  });

  it("keeps the forecast base but blocks collection until all included rent is collected", () => {
    expect(computeManagementFeeRentBase([
      {
        billedRent: "2000.00",
        fullMonthRent: "2000.00",
        numberOfPax: 1,
        isCommissionMonth: false,
        fullyCollected: false,
      },
    ], null)).toEqual({
      eligibleRentBase: "2000.00",
      fullyCollected: false,
      reason: "rent_not_collected",
    });
  });
});

describe("effectiveWindowOverlapsBillingMonth", () => {
  it("includes a config that starts part-way through the prorated first month", () => {
    expect(
      effectiveWindowOverlapsBillingMonth("2026-08", {
        effectiveFrom: "2026-08-25T00:00:00.000Z",
        effectiveTo: null,
      }),
    ).toBe(true);
  });

  it("includes a config that ends part-way through the final month", () => {
    expect(
      effectiveWindowOverlapsBillingMonth(new Date("2026-08-01T00:00:00.000Z"), {
        effectiveFrom: null,
        effectiveTo: new Date("2026-08-24T23:59:59.999Z"),
      }),
    ).toBe(true);
  });

  it("excludes configs wholly before or after the billing month", () => {
    expect(
      effectiveWindowOverlapsBillingMonth("2026-08", {
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveTo: null,
      }),
    ).toBe(false);
    expect(
      effectiveWindowOverlapsBillingMonth("2026-08", {
        effectiveFrom: null,
        effectiveTo: "2026-07-31T23:59:59.999Z",
      }),
    ).toBe(false);
  });
});

describe("shouldChargeMgmtFee", () => {
  it("no active tenancy ⇒ no fee", () => {
    expect(shouldChargeMgmtFee({ hasActiveTenancy: false, inFreePeriod: false })).toBe(false);
    expect(shouldChargeMgmtFee({ hasActiveTenancy: true, inFreePeriod: false })).toBe(true);
  });

  it("free-period suppresses the fee even with an active tenancy", () => {
    expect(shouldChargeMgmtFee({ hasActiveTenancy: true, inFreePeriod: true })).toBe(false);
  });

  it("no tenancy + free-period ⇒ still no fee", () => {
    expect(shouldChargeMgmtFee({ hasActiveTenancy: false, inFreePeriod: true })).toBe(false);
  });
});
