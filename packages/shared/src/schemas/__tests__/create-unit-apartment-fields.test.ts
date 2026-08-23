import { describe, it, expect } from "vitest";
import {
  createUnitSchema,
  createPortalUnitSchema,
  createUnitsBatchSchema,
  createPortalUnitsBatchSchema,
  updateApartmentSharedSchema,
} from "../inventory";

const base = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitCode: "A-18-06",
  unitType: "Master",
  depositMonths: 2,
  utilitiesDepositMonths: 1,
};

describe("createUnitSchema — apartment-scoped fields", () => {
  it("accepts owner, billing mode, and a nonnegative monthly TNB subsidy cap", () => {
    const parsed = createUnitSchema.parse({
      ...base,
      ownerPartyId: "22222222-2222-4222-8222-222222222222",
      partitionBillingMode: "SUBSIDY",
      tnbSubsidyCapMonthly: 200,
    });
    expect(parsed.ownerPartyId).toBe("22222222-2222-4222-8222-222222222222");
    expect(parsed.partitionBillingMode).toBe("SUBSIDY");
    expect(parsed.tnbSubsidyCapMonthly).toBe(200);
  });

  it("accepts null as the explicit legacy per-pax policy and rejects negative caps", () => {
    expect(createUnitSchema.parse({ ...base, tnbSubsidyCapMonthly: null }).tnbSubsidyCapMonthly)
      .toBeNull();
    expect(createUnitSchema.parse({ ...base, tnbSubsidyCapMonthly: "" }).tnbSubsidyCapMonthly)
      .toBeNull();
    expect(createUnitSchema.safeParse({ ...base, tnbSubsidyCapMonthly: -0.01 }).success)
      .toBe(false);
    expect(updateApartmentSharedSchema.safeParse({ tnbSubsidyCapMonthly: -1 }).success)
      .toBe(false);
  });

  it("accepts occupied with monthlyRent", () => {
    const parsed = createUnitSchema.parse({
      ...base,
      occupancyStatus: "occupied",
      tenantPartyId: "33333333-3333-4333-8333-333333333333",
      moveInDate: "2026-07-15",
      moveOutDate: "2027-07-14",
      monthlyRent: 3000,
    });
    expect(parsed.monthlyRent).toBe(3000);
  });

  // Pins the deliberate .nonnegative() (not .positive()) choice: 0 passes THIS
  // schema so the flag-gated service (syncOccupancyTenancy) is the single place
  // that rejects rent <= 0 with a clean OCCUPANCY_RENT_REQUIRED error -- mirrors
  // unitWritableFields.monthlyRent used by the update path.
  it("accepts occupied with monthlyRent 0", () => {
    const parsed = createUnitSchema.parse({
      ...base,
      occupancyStatus: "occupied",
      tenantPartyId: "33333333-3333-4333-8333-333333333333",
      moveInDate: "2026-07-15",
      moveOutDate: "2027-07-14",
      monthlyRent: 0,
    });
    expect(parsed.monthlyRent).toBe(0);
  });

  // Flag-off parity: byte-for-byte the payload the client sends when
  // ENABLE_PHASE2_RESERVATION_GATED_TENANCY is off (unit-form-fields.tsx omits
  // monthlyRent entirely). The shared schema MUST accept it -- the rent rule is
  // enforced server-side in syncOccupancyTenancy, which is flag-gated. Regression
  // guard: expected to PASS from the very first run (no schema-level rent rule).
  it("accepts occupied without monthlyRent", () => {
    const result = createUnitSchema.safeParse({
      ...base,
      occupancyStatus: "occupied",
      tenantPartyId: "33333333-3333-4333-8333-333333333333",
      moveInDate: "2026-07-15",
      moveOutDate: "2027-07-14",
    });
    expect(result.success).toBe(true);
  });

  // Permission boundary: an agent may never set an apartment's owner, its
  // billing model, or an explicit rent. createPortalUnitSchema is .strict(), so
  // these become unrecognized keys (rejected) rather than silently dropped. We
  // verify the FULL admin-only set -- a typo omitting any one from Step 6's
  // .omit({...}) would leave it a known field that slips past .strict().
  it("portal schema strips ownerPartyId, partitionBillingMode, TNB cap, and monthlyRent", () => {
    const result = createPortalUnitSchema.safeParse({
      ...base,
      ownerPartyId: "22222222-2222-4222-8222-222222222222",
      partitionBillingMode: "SUBSIDY",
      tnbSubsidyCapMonthly: 200,
      monthlyRent: 3000,
    });
    for (const key of ["ownerPartyId", "partitionBillingMode", "tnbSubsidyCapMonthly", "monthlyRent"]) {
      if (result.success) {
        expect(key in result.data).toBe(false);
      } else {
        const mentioned = result.error.issues.some(
          (i) =>
            i.path.includes(key) ||
            (i.code === "unrecognized_keys" && i.keys.includes(key)),
        );
        expect(mentioned).toBe(true);
      }
    }
  });

  it("batch shared accepts owner, billing mode, and monthly TNB subsidy cap", () => {
    const parsed = createUnitsBatchSchema.parse({
      shared: {
        propertyId: base.propertyId,
        unitCode: "TD-01",
        ownerPartyId: "22222222-2222-4222-8222-222222222222",
        partitionBillingMode: "SUBSIDY",
        tnbSubsidyCapMonthly: 200,
      },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    });
    expect(parsed.shared.ownerPartyId).toBe("22222222-2222-4222-8222-222222222222");
    expect(parsed.shared.partitionBillingMode).toBe("SUBSIDY");
    expect(parsed.shared.tnbSubsidyCapMonthly).toBe(200);
  });

  // Permission boundary on the PORTAL batch path. We pin the invariant on BOTH
  // admin-only apartment fields: ownerPartyId AND partitionBillingMode (the
  // latter decides SUBSIDY vs NO_SUBSIDY -- who bears the electricity subsidy, a
  // money field). TODAY the real mechanism is a silent STRIP, not a rejection:
  // batchSharedFields is left untouched and is NOT .strict(), so an agent's
  // unknown key on `shared` is dropped and the parse SUCCEEDS with the key
  // absent (the outer .strict() guards only top-level keys and does not recurse
  // into the nested `shared`). This guard deliberately covers BOTH mechanisms so
  // it can never pass vacuously:
  //   - success  => neither admin-only field survived into `result.data.shared`
  //                 (catches a future DRY refactor that hoists either field onto
  //                 batchSharedFields -- its shared home -- which would make this
  //                 AGENT path parse-AND-PRESERVE the agent's billing model);
  //   - failure  => the rejection must actually NAME these keys (a nested
  //                 .strict() would emit code "unrecognized_keys" with the
  //                 offending key in issue.keys), so an unrelated new required
  //                 field on batchRoomFields can't turn this green by accident.
  it("portal batch rejects ownerPartyId", () => {
    const adminOnly = ["ownerPartyId", "partitionBillingMode", "tnbSubsidyCapMonthly"] as const;
    const result = createPortalUnitsBatchSchema.safeParse({
      shared: {
        propertyId: base.propertyId,
        unitCode: "TD-01",
        ownerPartyId: "22222222-2222-4222-8222-222222222222",
        partitionBillingMode: "SUBSIDY",
        tnbSubsidyCapMonthly: 200,
      },
      rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
    });
    if (result.success) {
      for (const key of adminOnly) {
        expect(key in result.data.shared).toBe(false);
      }
    } else {
      for (const key of adminOnly) {
        const named = result.error.issues.some(
          (i) =>
            i.path.includes(key) ||
            (i.code === "unrecognized_keys" && i.keys.includes(key)),
        );
        expect(named).toBe(true);
      }
    }
  });
});

describe("commission fields on the unit schemas", () => {
  it("accepts firstMonthIsCommission + commissionSstBearer on create", () => {
    const parsed = createUnitSchema.parse({
      ...base,
      occupancyStatus: "occupied",
      tenantPartyId: "22222222-2222-4222-8222-222222222222",
      moveInDate: "2026-07-01",
      moveOutDate: "2026-07-31",
      monthlyRent: 1200,
      firstMonthIsCommission: true,
      commissionSstBearer: "kaen",
    }) as Record<string, unknown>;
    expect(parsed.firstMonthIsCommission).toBe(true);
    expect(parsed.commissionSstBearer).toBe("kaen");
  });

  it("rejects a bad commissionSstBearer enum", () => {
    const res = createUnitSchema.safeParse({
      ...base,
      firstMonthIsCommission: true,
      commissionSstBearer: "nope",
    });
    expect(res.success).toBe(false);
  });

  it("accepts the fields on a batch room (adminBatchRoomFields is .strict())", () => {
    const res = createUnitsBatchSchema.safeParse({
      shared: { propertyId: base.propertyId, unitCode: base.unitCode },
      rooms: [
        {
          unitType: "Master",
          depositMonths: 2,
          utilitiesDepositMonths: 1,
          firstMonthIsCommission: true,
          commissionSstBearer: "owner",
        },
      ],
    });
    expect(res.success).toBe(true);
  });
});
