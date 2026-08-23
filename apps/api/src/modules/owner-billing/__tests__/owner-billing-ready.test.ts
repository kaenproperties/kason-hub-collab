// apps/api/src/modules/owner-billing/__tests__/owner-billing-ready.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../meter/repository", () => ({
  findListingOwner: vi.fn(),
  findApartmentOwner: vi.fn(),
}));
vi.mock("../owner-billing.repository", async (orig) => {
  const actual = await orig<typeof import("../owner-billing.repository")>();
  return { ...actual, findFeeConfigsForOwner: vi.fn() };
});
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled: vi.fn() }));

import { findApartmentOwner, findListingOwner } from "../../meter/repository";
import { findFeeConfigsForOwner } from "../owner-billing.repository";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import {
  OwnerBillingNotReadyError,
  assertOwnerBillingReady,
  resolveBillingReadiness,
} from "../owner-billing-ready";

const tx = {} as never;
const ASOF = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

// Minimal DbManagementFeeConfig fixture (resolveConfigForUnit reads isActive,
// effectiveFrom/To, propertyId; the money fields are irrelevant to selection).
function cfg(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cfg", organizationId: "o", ownerPartyId: "owner", propertyId: null,
    feeType: "percent", feeValue: "10", capAmount: null, sstPercent: "8",
    freePeriodStart: null, freePeriodEnd: null,
    isActive: true, effectiveFrom: null, effectiveTo: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isPhase2FlagEnabled).mockReturnValue(true);
});

describe("resolveBillingReadiness / assertOwnerBillingReady", () => {
  it("resolves (no throw) when the owner has an active config", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg()]);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).resolves.toBeUndefined();
  });

  it("throws OWNER_NOT_ASSIGNED when the unit has no owner", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: null, propertyId: "P" });
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).rejects.toMatchObject({ status: 422, code: "OWNER_NOT_ASSIGNED" });
  });

  it("throws OWNER_BILLING_NOT_CONFIGURED when the owner has no active config", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).rejects.toBeInstanceOf(OwnerBillingNotReadyError);
  });

  it("is a no-op for a listing scope with a null listingId (non-unit charge)", async () => {
    const r = await resolveBillingReadiness(tx, { orgId: "o", scope: { kind: "listing", listingId: null }, asOf: ASOF });
    expect(r).toBeNull();
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "listing", listingId: null }, asOf: ASOF }),
    ).resolves.toBeUndefined();
    expect(findListingOwner).not.toHaveBeenCalled();
  });

  it("is a no-op (no throw) when ENABLE_PHASE2_OWNER_BILLING is off, even with no owner", async () => {
    vi.mocked(isPhase2FlagEnabled).mockReturnValue(false);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).resolves.toBeUndefined();
    expect(findApartmentOwner).not.toHaveBeenCalled();
  });

  it("selects the property-specific config over the all-properties default", async () => {
    vi.mocked(findListingOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({ id: "all", propertyId: null }),
      cfg({ id: "specific", propertyId: "P" }),
    ]);
    const r = await resolveBillingReadiness(tx, { orgId: "o", scope: { kind: "listing", listingId: "L" }, asOf: ASOF });
    expect(r).toEqual({ ownerAssigned: true, hasActiveConfig: true, ownerPartyId: "owner" });
  });

  // Adversarial-audit additions (money-code review before GREEN work started).
  it("treats an owner with only inactive configs as not configured", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ isActive: false }), cfg({ id: "cfg2", isActive: false })]);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).rejects.toMatchObject({ code: "OWNER_BILLING_NOT_CONFIGURED" });
  });

  it("treats a not-yet-effective config (effectiveFrom after asOf) as not configured", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    const future = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01, after ASOF (2026-06-01)
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ effectiveFrom: future })]);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).rejects.toMatchObject({ code: "OWNER_BILLING_NOT_CONFIGURED" });
  });

  it("accepts a config that starts later within the prorated billing month", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    const midMonth = new Date(Date.UTC(2026, 5, 25)); // 2026-06-25, still part of June billing
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ effectiveFrom: midMonth })]);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).resolves.toBeUndefined();
  });

  it("picks the matching property-specific config among several for different properties", async () => {
    vi.mocked(findListingOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P2" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({ id: "all", propertyId: null }),
      cfg({ id: "p1-specific", propertyId: "P1" }),
      cfg({ id: "p2-specific", propertyId: "P2" }),
    ]);
    const r = await resolveBillingReadiness(tx, { orgId: "o", scope: { kind: "listing", listingId: "L" }, asOf: ASOF });
    expect(r).toEqual({ ownerAssigned: true, hasActiveConfig: true, ownerPartyId: "owner" });
  });

  it("propagates a resolver error unchanged instead of mapping it to OwnerBillingNotReadyError", async () => {
    vi.mocked(findApartmentOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    const dbError = new Error("connection reset");
    vi.mocked(findFeeConfigsForOwner).mockRejectedValue(dbError);
    await expect(
      assertOwnerBillingReady(tx, { orgId: "o", scope: { kind: "apartment", apartmentId: "A" }, asOf: ASOF }),
    ).rejects.toBe(dbError);
  });

  // Sabotage-discovered gap: B6/B9 both include an all-properties (propertyId:null)
  // fallback config, so a broken propertyId-threading bug in the probe unit is
  // masked (the fallback still resolves hasActiveConfig:true). These two tests
  // have NO all-properties fallback, so the result only comes out right if the
  // resolved unit's propertyId is threaded into the probe EXACTLY.
  it("matches a property-specific config for the SAME property (no all-properties fallback)", async () => {
    vi.mocked(findListingOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ id: "p-specific", propertyId: "P" })]);
    const r = await resolveBillingReadiness(tx, { orgId: "o", scope: { kind: "listing", listingId: "L" }, asOf: ASOF });
    expect(r).toEqual({ ownerAssigned: true, hasActiveConfig: true, ownerPartyId: "owner" });
  });

  it("does not match a property-specific config for a DIFFERENT property (no all-properties fallback)", async () => {
    vi.mocked(findListingOwner).mockResolvedValue({ ownerPartyId: "owner", propertyId: "P" });
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ id: "other-property", propertyId: "OTHER" })]);
    const r = await resolveBillingReadiness(tx, { orgId: "o", scope: { kind: "listing", listingId: "L" }, asOf: ASOF });
    expect(r).toEqual({ ownerAssigned: true, hasActiveConfig: false, ownerPartyId: "owner" });
  });
});
