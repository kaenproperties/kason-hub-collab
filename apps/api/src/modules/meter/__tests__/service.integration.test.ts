import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import {
  chargeUtilityBillService,
  createReadingService,
  createUtilityBillService,
  getBillingGridService,
  getMeterService,
  getReadingService,
  getUtilityBillService,
  previewUtilityBillService,
  setMeterActiveService,
  setTenancyPaxService,
  updateMeterService,
  updateReadingService,
  updateUtilityBillService,
  voidReadingService,
  voidUtilityBillService,
} from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c2000000-0000-4000-8000-000000000001";
const USER = "c2000000-0000-4000-8000-000000000002";
const PROP = "c2000000-0000-4000-8000-000000000003";
const APT = "c2000000-0000-4000-8000-000000000004";
const ROOM = "c2000000-0000-4000-8000-000000000005";
const PARTY = "c2000000-0000-4000-8000-000000000006";
const TEN = "c2000000-0000-4000-8000-000000000007";
// Additional UUIDs for SUBSIDY and WHOLE tests
const ROOM2 = "c2000000-0000-4000-8000-000000000008";
const PARTY2 = "c2000000-0000-4000-8000-000000000009";
const TEN2 = "c2000000-0000-4000-8000-000000000010";
const sess = { orgId: ORG, userId: USER, role: "manager", userType: "operator" };

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.utilityAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.meterReading.deleteMany({ where: { organizationId: ORG } });
  await db.aircondMeter.deleteMany({ where: { organizationId: ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  // UnitReservation.unit → Listing is onDelete: Restrict → must drop reservations first.
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.utilityBillingConfig.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "M2", slug: "m2", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  // AuditLog.actorUserId FK → User.id (onDelete: Restrict): the acting user must exist.
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "m2@example.test", fullName: "M2 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "PARTITIONED" } });
  // PARTY must be created before ROOM: Listing.ownerPartyId is a FK → Party (onDelete: Restrict).
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY } });

  // ENABLE_PHASE2_OWNER_BILLING gates assertOwnerBillingReady, which refuses to post
  // charges for a unit whose owner has no ACTIVE management-fee config
  // (OwnerBillingNotReadyError -> 422 OWNER_BILLING_NOT_CONFIGURED). The flag is on in
  // this repo's api .env, so without a config every charge-posting test in this file
  // failed on a precondition rather than on the behaviour it was written to check.
  // Seed the minimal config; effectiveFrom/To null = always in window.
  await db.managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: PARTY, feeType: "percent", feeValue: "10.00", isActive: true } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

dn("M2 service (integration)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("compute-&-charge creates a utility charge for the occupied tenant and is idempotent", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.35" }); // 0→40.35 @0.6 = 24.21
    expect(rd.ok).toBe(true);
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.21", airSelangor: "6.50", cleaning: "100.00" });
    expect(bill.ok).toBe(true);
    const billId = (bill as { data: { id: string } }).data.id;

    const preview = await previewUtilityBillService(sess, billId);
    expect(preview.ok).toBe(true);

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    expect((charged as { data: { utilityCharges: number; aircondCharges: number } }).data).toEqual({ billId, utilityCharges: 1, aircondCharges: 1 });

    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.map((c) => c.chargeType).sort()).toEqual(["aircond", "rent", "utility"]);
    // Unified post (T-rent): the month's rent is posted alongside utilities. No reservation
    // on TEN here → amount falls back to Tenancy.monthlyRentAmount (1000); full-id chargeNumber.
    const rent = charges.find((c) => c.chargeType === "rent")!;
    expect(rent.status).toBe("posted");
    expect(Number(rent.amount)).toBe(1000);
    expect(rent.chargeNumber).toBe(`RENT-202606-${TEN}`);

    // idempotent: re-charge a charged bill → 409, and rent is NOT duplicated.
    const again = await chargeUtilityBillService(sess, billId, {});
    expect(again.ok).toBe(false);
    expect((again as { status: number }).status).toBe(409);
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "rent" } })).toBe(1);
  });

  it("T-rent: an existing cron-made DRAFT rent flips to posted on bill-post (no duplicate)", async () => {
    const db = getDb();
    // Simulate the auto-draft cron having drafted June rent FIRST (same full-id chargeNumber).
    await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: `RENT-202606-${TEN}`, tenancyId: TEN, unitId: ROOM, partyId: PARTY,
        chargeType: "rent", status: "draft", description: "Monthly rent", dueDate: new Date("2026-06-01"),
        amount: "1234.00", currency: "MYR", outstandingAmount: "1234.00", attachmentKeys: [], billingMonth: new Date("2026-06-01"),
      },
    });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "10.00", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    const rents = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(rents.length).toBe(1); // flipped in place — not duplicated
    expect(rents[0].status).toBe("posted");
    expect(Number(rents[0].amount)).toBe(1234); // amount preserved on flip, never rewritten
  });

  it("bearer: cleaning defaults owner-borne (off tenant bill); toggle to tenant pools it", async () => {
    type Prev = { allocations: { cleaningShare: number; computedAmount: number }[]; ownerBorneUtilities: number };
    // Default (owner): cleaning 100 stays OFF the tenant bill; tenant pays only airSelangor.
    const ownerBill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-11-01", tnbTotal: "0.00", airSelangor: "10.00", cleaning: "100.00" });
    const ownerPrev = await previewUtilityBillService(sess, (ownerBill as { data: { id: string } }).data.id);
    const ownerData = (ownerPrev as { data: Prev }).data;
    expect(ownerData.allocations[0].cleaningShare).toBe(0);
    expect(ownerData.allocations[0].computedAmount).toBe(10);
    expect(ownerData.ownerBorneUtilities).toBe(100);
    // Toggle cleaning → tenant: now pooled to the tenant; owner-borne drops to 0.
    const tenantBill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-12-01", tnbTotal: "0.00", airSelangor: "10.00", cleaning: "100.00", cleaningBearer: "tenant" });
    const tenantPrev = await previewUtilityBillService(sess, (tenantBill as { data: { id: string } }).data.id);
    const tenantData = (tenantPrev as { data: Prev }).data;
    expect(tenantData.allocations[0].cleaningShare).toBe(100);
    expect(tenantData.allocations[0].computedAmount).toBe(110);
    expect(tenantData.ownerBorneUtilities).toBe(0);
  });

  it("422 when no occupied tenancy", async () => {
    const db = getDb();
    await db.tenancy.updateMany({ where: { organizationId: ORG }, data: { status: "ended" } });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-07-01", tnbTotal: "10.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(false);
    expect((charged as { status: number }).status).toBe(422);
  });

  it("422 ACTIVE_TENANCY_NO_PAX: active tenancy with null pax blocks charge and writes no Charge rows", async () => {
    const db = getDb();
    // Active tenancy exists but its pax is unknown (null) → would silently leak.
    await db.tenancy.updateMany({ where: { organizationId: ORG }, data: { numberOfPax: null } });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-08-01", tnbTotal: "10.00", airSelangor: "6.50", cleaning: "100.00" });
    expect(bill.ok).toBe(true);
    const billId = (bill as { data: { id: string } }).data.id;

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(false);
    expect((charged as { status: number }).status).toBe(422);
    expect((charged as { error: string }).error).toBe("ACTIVE_TENANCY_NO_PAX");

    // No partial work: zero Charge rows created.
    const charges = await db.charge.count({ where: { organizationId: ORG } });
    expect(charges).toBe(0);
    const allocations = await db.utilityAllocation.count({ where: { organizationId: ORG } });
    expect(allocations).toBe(0);

    // Preview surfaces the offending room so the UI can warn before charging —
    // now with the human label (frontend §16), not a bare unitId.
    const preview = await previewUtilityBillService(sess, billId);
    expect(preview.ok).toBe(true);
    expect((preview as { data: { paxlessActiveRooms: { unitId: string; unitCode: string | null; listingType: string | null }[] } }).data.paxlessActiveRooms).toEqual([
      { unitId: ROOM, unitCode: "A-1", listingType: "room" },
    ]);
  });

  // Replaces the old KWH_OVERSHOOT test (that error no longer exists in the new compute engine).
  // The new compute engine uses computeAllocation which doesn't have KWH_OVERSHOOT.
  // Instead, verify SUBSIDY mode: two occupied rooms (2pax + 1pax) with aircond readings
  // of 30/10, tnbTotal=60, airSelangor=150, subsidyPerPax=50.
  // leftoverTnb = 60-40 = 20; pool = 20+150 = 170; totalPax = 3
  // room1 (2pax): gross = 170/3*2 ≈ 113.33; deduction = min(113.33, 100) = 100; net = 13.33
  // room2 (1pax): gross = 170/3*1 ≈ 56.67; deduction = min(56.67, 50) = 50; net = 6.67
  // subsidyCovered = 150; 4 charges: 2 utility + 2 aircond
  it("SUBSIDY mode: two rooms (2pax+1pax), tnbTotal=60, airSelangor=150, subsidyPerPax=50 → correct net allocations + subsidyCovered", async () => {
    const db = getDb();
    // Reconfigure the apartment to SUBSIDY mode and add config row
    await db.apartment.update({ where: { id: APT }, data: { partitionBillingMode: "SUBSIDY" } });
    await db.utilityBillingConfig.create({ data: { organizationId: ORG, subsidyPerPax: "50.00" } });
    // Add second room + party + tenancy (2 pax)
    await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT, listingType: "medium", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
    await db.party.create({ data: { id: PARTY2, organizationId: ORG, displayName: "Tenant2", partyType: "individual", status: "active" } });
    await db.tenancy.create({ data: { id: TEN2, organizationId: ORG, propertyId: PROP, unitId: ROOM2, tenantPartyId: PARTY2, tenancyCode: "T-2", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1200.00", numberOfPax: 2 } });
    // Meters + readings: ROOM=1pax reading 10→aircond 10*0.6=6?, ROOM2=2pax reading 30→aircond 30*0.6=18?
    // We want aircond amounts 10 and 30 respectively. At rate 0.6: 10/0.6≈16.67 kWh, 30/0.6=50 kWh.
    // Easier: just set ratePerKwh such that consumption=reading amount directly.
    // Use rate=1.0000: currentReading=10 → computedAmount=10; currentReading=30 → computedAmount=30.
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "1.0000", isActive: true } });
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM2, ratePerKwh: "1.0000", isActive: true } });
    // ROOM (1 pax) = aircond 10; ROOM2 (2 pax) = aircond 30
    const rd1 = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-09-01", currentReading: "10.00" });
    expect(rd1.ok).toBe(true);
    const rd2 = await createReadingService(sess, { unitId: ROOM2, periodMonth: "2026-09-01", currentReading: "30.00" });
    expect(rd2.ok).toBe(true);

    // Bill: tnbTotal=60, airSelangor=150 (totalAircond=40, leftoverTnb=20, pool=170)
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-09-01", tnbTotal: "60.00", airSelangor: "150.00" });
    expect(bill.ok).toBe(true);
    const billId = (bill as { data: { id: string } }).data.id;

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    const chargeData = (charged as { data: { billId: string; utilityCharges: number; aircondCharges: number } }).data;
    expect(chargeData.utilityCharges).toBe(2);
    expect(chargeData.aircondCharges).toBe(2);

    // Verify allocations
    const allocs = await db.utilityAllocation.findMany({ where: { organizationId: ORG }, orderBy: { pax: "asc" } });
    expect(allocs.length).toBe(2);
    // ROOM (1 pax): gross ≈ 56.67, deduction=50, net=6.67
    const alloc1 = allocs.find((a) => a.pax === 1)!;
    expect(Number(alloc1.computedAmount)).toBeCloseTo(6.67, 1);
    expect(Number(alloc1.subsidyDeduction)).toBeCloseTo(50, 1);
    // ROOM2 (2 pax): gross ≈ 113.33, deduction=100, net=13.33
    const alloc2 = allocs.find((a) => a.pax === 2)!;
    expect(Number(alloc2.computedAmount)).toBeCloseTo(13.33, 1);
    expect(Number(alloc2.subsidyDeduction)).toBeCloseTo(100, 1);

    // Verify bill snapshot fields
    const billRow = await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } });
    expect(billRow.billingMode).toBe("subsidy");
    expect(billRow.subsidyPolicySnapshot).toBe("legacy_per_pax");
    expect(Number(billRow.subsidyPerPax)).toBe(50);
    expect(billRow.tnbSubsidyCapSnapshot).toBeNull();
    expect(Number(billRow.subsidyCovered)).toBeCloseTo(150, 1);
    // M6 seam: owner-borne = subsidyCovered(150) + 0 vacant aircond + 0 residual
    expect(Number(billRow.ownerBorneUtilitiesTotal)).toBeCloseTo(150, 1);
    expect(Number(billRow.roundingResidual)).toBe(0);

    // 4 charges total: 2 utility + 2 aircond
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    // Unified post: one rent charge per active tenancy alongside the utility/aircond charges.
    expect(charges.map((c) => c.chargeType).sort()).toEqual(["aircond", "aircond", "rent", "rent", "utility", "utility"]);
  });

  it("private partition: submetered aircond > TNB is billable — the room's private submeter posts in full (owner profit)", async () => {
    // APT is PARTITIONED (seed): each room bills its OWN private submeter, decoupled
    // from the master TNB bill. Reading 100 @0.6 = RM60 aircond while TNB is only 10.
    // Old model rejected this (AIRCON_EXCEEDS_TNB); the private model bills the RM60 in
    // full — owner pays TNB 10, recovers 60 → RM50 owner profit — and the leftover-TNB
    // pool clamps to 0 (no negative pool).
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-10-01", currentReading: "100.00" });
    expect(rd.ok).toBe(true);
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-10-01", tnbTotal: "10.00", airSelangor: "6.50", cleaning: "100.00" });
    expect(bill.ok).toBe(true);
    const billId = (bill as { data: { id: string } }).data.id;

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    expect((charged as { data: { aircondCharges: number } }).data.aircondCharges).toBe(1);

    // The private aircond submeter is billed to the tenant at its FULL RM60, despite
    // exceeding the RM10 TNB total.
    const aircond = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "aircond" } });
    expect(aircond.amount.toString()).toBe("60");
  });

  // ── updateMeterService ──────────────────────────────────────────────────────
  it("updateMeterService: persists rate + number and writes meter.meter.update audit; stale expectedUpdatedAt → 409 STALE", async () => {
    const db = getDb();
    const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, meterNumber: "OLD-1", ratePerKwh: "0.6000", isActive: true } });

    const upd = await updateMeterService(sess, meter.id, { ratePerKwh: "0.55", meterNumber: "NEW-9" });
    expect(upd.ok).toBe(true);

    const after = await db.aircondMeter.findFirstOrThrow({ where: { id: meter.id } });
    expect(Number(after.ratePerKwh)).toBe(0.55); // stored as Decimal(.,4); compare numerically
    expect(after.meterNumber).toBe("NEW-9");

    const audit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.meter.update", entityId: meter.id } });
    expect(audit).not.toBeNull();

    // stale optimistic-lock: a wrong expectedUpdatedAt must 409 and not mutate.
    const stale = await updateMeterService(sess, meter.id, { meterNumber: "STALE", expectedUpdatedAt: new Date("2000-01-01T00:00:00.000Z").toISOString() });
    expect(stale.ok).toBe(false);
    expect((stale as { status: number }).status).toBe(409);
    expect((stale as { error: string }).error).toBe("STALE");
    const unchanged = await db.aircondMeter.findFirstOrThrow({ where: { id: meter.id } });
    expect(unchanged.meterNumber).toBe("NEW-9"); // STALE write did not land
  });

  // ── setMeterActiveService ───────────────────────────────────────────────────
  it("setMeterActiveService: retire → isActive=false + retire audit; restore → isActive=true + restore audit", async () => {
    const db = getDb();
    const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });

    const retired = await setMeterActiveService(sess, meter.id, false);
    expect(retired.ok).toBe(true);
    expect((await db.aircondMeter.findFirstOrThrow({ where: { id: meter.id } })).isActive).toBe(false);
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.meter.retire", entityId: meter.id } })).not.toBeNull();

    const restored = await setMeterActiveService(sess, meter.id, true);
    expect(restored.ok).toBe(true);
    expect((await db.aircondMeter.findFirstOrThrow({ where: { id: meter.id } })).isActive).toBe(true);
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.meter.restore", entityId: meter.id } })).not.toBeNull();
  });

  // ── updateReadingService ────────────────────────────────────────────────────
  it("updateReadingService: recomputes consumption/computedAmount + audit; after charge → 409 NOT_EDITABLE", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const created = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" }); // 0→40 @0.6 = 24.00
    expect(created.ok).toBe(true);
    const readingId = (created as { data: { id: string } }).data.id;

    // update currentReading 40 → 50: consumption 50, computed 50*0.6 = 30.00
    const upd = await updateReadingService(sess, readingId, { currentReading: "50.00" });
    expect(upd.ok).toBe(true);
    const row = await db.meterReading.findFirstOrThrow({ where: { id: readingId } });
    expect(Number(row.consumption)).toBe(50);
    expect(Number(row.computedAmount)).toBe(30); // recomputed at the meter's 0.6 rate
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.reading.update", entityId: readingId } })).not.toBeNull();

    // charge the bill so the reading flips submitted → charged.
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "30.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    expect((await db.meterReading.findFirstOrThrow({ where: { id: readingId } })).status).toBe("charged");

    // a charged reading is no longer editable.
    const blocked = await updateReadingService(sess, readingId, { currentReading: "60.00" });
    expect(blocked.ok).toBe(false);
    expect((blocked as { status: number }).status).toBe(409);
    expect((blocked as { error: string }).error).toBe("NOT_EDITABLE");
  });

  // ── editable previousReading (admin-supplied opening / override) ─────────────
  it("createReadingService: supplied previousReading drives consumption, not the auto-lookup", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    // First reading with an explicit opening read: prev 70, current 100 → Δ30 @0.6 = 18.00
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "100.00", previousReading: "70.00" });
    expect(rd.ok).toBe(true);
    const data = (rd as { data: { previousReading: number; consumption: number; computedAmount: number } }).data;
    expect(data.previousReading).toBe(70);
    expect(data.consumption).toBe(30);
    expect(data.computedAmount).toBe(18);
    const row = await db.meterReading.findFirstOrThrow({ where: { organizationId: ORG, unitId: ROOM } });
    expect(Number(row.previousReading)).toBe(70);
    expect(Number(row.consumption)).toBe(30);
    expect(Number(row.computedAmount)).toBe(18);
  });

  it("createReadingService: omitting previousReading keeps the auto-lookup → 0 default", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "100.00" });
    expect(rd.ok).toBe(true);
    const row = await db.meterReading.findFirstOrThrow({ where: { organizationId: ORG, unitId: ROOM } });
    expect(Number(row.previousReading)).toBe(0);
    expect(Number(row.consumption)).toBe(100);
  });

  it("createReadingService: supplied previousReading > current → 422 NEGATIVE_CONSUMPTION", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "50.00", previousReading: "70.00" });
    expect(rd.ok).toBe(false);
    expect((rd as { status: number }).status).toBe(422);
    expect((rd as { error: string }).error).toBe("NEGATIVE_CONSUMPTION");
    // nothing persisted
    expect(await db.meterReading.findFirst({ where: { organizationId: ORG, unitId: ROOM } })).toBeNull();
  });

  it("updateReadingService: changing previousReading recomputes consumption + amount", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    // create with auto prev=0, current=40 → consumption 40
    const created = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const readingId = (created as { data: { id: string } }).data.id;
    // correct the opening read to 10: current 40, prev 10 → Δ30 @0.6 = 18.00
    const upd = await updateReadingService(sess, readingId, { previousReading: "10.00" });
    expect(upd.ok).toBe(true);
    const row = await db.meterReading.findFirstOrThrow({ where: { id: readingId } });
    expect(Number(row.previousReading)).toBe(10);
    expect(Number(row.consumption)).toBe(30);
    expect(Number(row.computedAmount)).toBe(18);
  });

  it("updateReadingService: previousReading edit on a CHARGED reading → 409 NOT_EDITABLE", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const created = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const readingId = (created as { data: { id: string } }).data.id;
    // charge it via the bill flow so the reading flips submitted → charged.
    // airSelangor is always tenant-borne, so this guarantees a tenant allocation
    // regardless of the indah/cleaning/wifi owner-borne defaults (PR #72).
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "6.50", cleaning: "0" });
    await chargeUtilityBillService(sess, (bill as { data: { id: string } }).data.id, {});
    expect((await db.meterReading.findFirstOrThrow({ where: { id: readingId } })).status).toBe("charged");
    const blocked = await updateReadingService(sess, readingId, { previousReading: "5.00" });
    expect(blocked.ok).toBe(false);
    expect((blocked as { status: number }).status).toBe(409);
    expect((blocked as { error: string }).error).toBe("NOT_EDITABLE");
  });

  // ── voidReadingService ──────────────────────────────────────────────────────
  it("voidReadingService: submitted → void + audit; charged → 409 NOT_VOIDABLE; unknown → 404 READING_NOT_FOUND", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });

    // unknown id → 404
    const missing = await voidReadingService(sess, "c2000000-0000-4000-8000-0000000000ff");
    expect(missing.ok).toBe(false);
    expect((missing as { status: number }).status).toBe(404);
    expect((missing as { error: string }).error).toBe("READING_NOT_FOUND");

    // submitted → void
    const created = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const readingId = (created as { data: { id: string } }).data.id;
    const voided = await voidReadingService(sess, readingId);
    expect(voided.ok).toBe(true);
    expect((await db.meterReading.findFirstOrThrow({ where: { id: readingId } })).status).toBe("void");
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.reading.void", entityId: readingId } })).not.toBeNull();

    // a charged reading is NOT voidable (must go via bill-void reversal).
    const r2 = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-07-01", currentReading: "90.00" }); // prev=40 (voided still counts as prior) → consumption 50 @0.6 = 30
    const r2Id = (r2 as { data: { id: string } }).data.id;
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-07-01", tnbTotal: "30.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);
    expect((await db.meterReading.findFirstOrThrow({ where: { id: r2Id } })).status).toBe("charged");

    const notVoidable = await voidReadingService(sess, r2Id);
    expect(notVoidable.ok).toBe(false);
    expect((notVoidable as { status: number }).status).toBe(409);
    expect((notVoidable as { error: string }).error).toBe("NOT_VOIDABLE");
  });

  // ── getUtilityBillService (detail) ──────────────────────────────────────────
  it("getUtilityBillService: returns the bill WITH allocations after charge; unknown id → 404", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    const got = await getUtilityBillService(sess, billId);
    expect(got.ok).toBe(true);
    const detail = (got as { data: { id: string; status: string; allocations: unknown[] } }).data;
    expect(detail.id).toBe(billId);
    expect(detail.status).toBe("charged");
    expect(Array.isArray(detail.allocations)).toBe(true);
    expect(detail.allocations.length).toBe(1); // one occupied tenant

    const missing = await getUtilityBillService(sess, "c2000000-0000-4000-8000-0000000000fe");
    expect(missing.ok).toBe(false);
    expect((missing as { status: number }).status).toBe(404);
  });

  // ── updateUtilityBillService ────────────────────────────────────────────────
  it("updateUtilityBillService: draft amounts persist; updating a CHARGED bill → 409 NOT_EDITABLE", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;

    // draft → editable
    const upd = await updateUtilityBillService(sess, billId, { airSelangor: "9.90", cleaning: "120.00", notes: "edited" });
    expect(upd.ok).toBe(true);
    const row = await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } });
    expect(Number(row.airSelangor)).toBe(9.9);
    expect(Number(row.cleaning)).toBe(120);
    expect(row.notes).toBe("edited");
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.utilitybill.update", entityId: billId } })).not.toBeNull();

    // charge it, then a further edit must be blocked.
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);
    const blocked = await updateUtilityBillService(sess, billId, { cleaning: "200.00" });
    expect(blocked.ok).toBe(false);
    expect((blocked as { status: number }).status).toBe(409);
    expect((blocked as { error: string }).error).toBe("NOT_EDITABLE");
    // the charged bill's amount did NOT change.
    expect(Number((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).cleaning)).toBe(120);
  });

  // Bug fix: the optimistic-concurrency token must be REFRESHED on every save.
  // updateUtilityBillService bumps updatedAt on each successful PATCH, so it must
  // RETURN the new updatedAt; the client re-uses it as the next expectedUpdatedAt.
  // Without this, a second consecutive save (typing again / "Preview split") sends
  // the original (now stale) token → 0 rows match → bogus 409 "STALE" in the same tab.
  it("updateUtilityBillService: returns the bumped updatedAt; re-using it allows the next save; the original token is rejected as STALE", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "0.00", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;

    // t0 = the bill's updatedAt at hydration (what the client first seeds its ref with).
    const t0 = (await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).updatedAt.toISOString();

    // First save with the hydration token → ok, and the service returns the bumped token t1.
    const first = await updateUtilityBillService(sess, billId, { airSelangor: "1.00", expectedUpdatedAt: t0 });
    expect(first.ok).toBe(true);
    const t1 = (first as { data: { id: string; updatedAt: string } }).data.updatedAt;
    expect(t1).toBeDefined();
    expect(t1).not.toBe(t0); // the row was bumped — the old token is now stale.

    // Second save re-using the RETURNED token t1 → ok (this is the bug fix; a stale
    // t0 here would 409). Re-read the persisted amount to prove it actually wrote.
    const second = await updateUtilityBillService(sess, billId, { airSelangor: "2.00", expectedUpdatedAt: t1 });
    expect(second.ok).toBe(true);
    expect(Number((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).airSelangor)).toBe(2);

    // Re-using the ORIGINAL (genuinely stale) token t0 → still rejected as STALE.
    const stale = await updateUtilityBillService(sess, billId, { airSelangor: "3.00", expectedUpdatedAt: t0 });
    expect(stale.ok).toBe(false);
    expect((stale as { status: number }).status).toBe(409);
    expect((stale as { error: string }).error).toBe("STALE");
    // The rejected write did NOT persist.
    expect(Number((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).airSelangor)).toBe(2);
  });

  // ── voidUtilityBillService (full reversal) ──────────────────────────────────
  it("voidUtilityBillService: bill → void, allocations → void, charges → void/credited, charged reading reversed", async () => {
    const db = getDb();
    // P3 Task 4: when ENABLE_PHASE2_BILLING_DOCS is on, the charges minted by
    // chargeUtilityBillService's posting tx each get a debit-note document, so
    // voidUtilityBillService's cascade credits them via a CN (status
    // "credited", outstanding zeroed) instead of the legacy plain "void" —
    // see void-bill-cn.integration.test.ts for the dedicated flag-on coverage.
    // This test's ambient env decides which path runs; assert accordingly so
    // it stays correct whether or not the flag is set for a given invocation.
    const billingDocsOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" }); // 24.00 aircon
    const readingId = (rd as { data: { id: string } }).data.id;
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    // pre-void sanity: charges + allocation + reading are live.
    expect(await db.charge.count({ where: { organizationId: ORG, status: "void" } })).toBe(0);
    const allocIds = (await db.utilityAllocation.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((a) => a.id);
    expect(allocIds.length).toBe(1);

    const voided = await voidUtilityBillService(sess, billId);
    expect(voided.ok).toBe(true);

    // bill → void
    expect((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).status).toBe("void");
    // allocations → void
    const allocs = await db.utilityAllocation.findMany({ where: { organizationId: ORG } });
    expect(allocs.length).toBe(1);
    expect(allocs.every((a) => a.status === "void")).toBe(true);
    // every UTILITY + AIRCOND Charge raised by this bill → void (flag off) or
    // credited via a per-document CN (flag on, P3 Task 4). The unified-post RENT
    // charge has its own lifecycle (the tenant still owes the month's rent), so voiding
    // the utility bill must NOT touch it — it stays posted either way.
    const charges = await db.charge.findMany({ where: { organizationId: ORG } });
    expect(charges.length).toBe(3); // utility + aircond + rent
    const utilAircond = charges.filter((c) => c.chargeType !== "rent");
    expect(utilAircond.length).toBe(2);
    if (billingDocsOn) {
      expect(utilAircond.every((c) => c.status === "credited")).toBe(true);
      expect(utilAircond.every((c) => Number(c.outstandingAmount.toString()) === 0)).toBe(true);
      // Strengthen: a CN document was actually issued against each credited charge.
      const creditedChargeIds = utilAircond.map((c) => c.id);
      const cns = await db.billingDocument.findMany({
        where: { organizationId: ORG, docType: "credit_note", lines: { some: { chargeId: { in: creditedChargeIds } } } },
        include: { lines: true },
      });
      expect(cns.length).toBe(utilAircond.length); // one CN per affected document (Plan 2: one doc per charge)
      const cnChargeIds = new Set(cns.flatMap((cn) => cn.lines.map((l) => l.chargeId)));
      for (const id of creditedChargeIds) expect(cnChargeIds.has(id)).toBe(true);
    } else {
      expect(utilAircond.every((c) => c.status === "void")).toBe(true);
    }
    expect(charges.find((c) => c.chargeType === "rent")!.status).toBe("posted");
    // the charged reading is reversed: status void + chargeId cleared
    const reading = await db.meterReading.findFirstOrThrow({ where: { id: readingId } });
    expect(reading.status).toBe("void");
    expect(reading.chargeId).toBeNull();
    // audit row
    expect(await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.utilitybill.void", entityId: billId } })).not.toBeNull();
  });

  // ── UtilityAllocation create assertion ──────────────────────────────────────
  it("compute-&-charge: creates one UtilityAllocation per occupied tenant, each with non-null chargeId + status charged", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.35" }); // 24.21 aircon
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.21", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    // exactly one occupied tenant in the seed → exactly one allocation.
    const occupied = await db.tenancy.count({ where: { organizationId: ORG, status: "active" } });
    expect(occupied).toBe(1);
    const allocCount = await db.utilityAllocation.count({ where: { organizationId: ORG } });
    expect(allocCount).toBe(occupied);

    const allocs = await db.utilityAllocation.findMany({ where: { organizationId: ORG } });
    // NIT-2 (B3 #9): an allocation's chargeId is non-null only when the room's net
    // utility is > 0. A fully-subsidised (RM0) room keeps its audit allocation with
    // chargeId null (see "zero utility mints no charge" below). This fixture's single
    // room is always > 0 (net 6.50), so the non-null branch is genuinely exercised.
    expect(allocs.every((a) => Number(a.computedAmount) > 0)).toBe(true);
    for (const a of allocs) {
      if (Number(a.computedAmount) > 0) expect(a.chargeId).not.toBeNull();
      expect(a.status).toBe("charged");
    }
  });

  // ── B3 (#9): RM0 shared-utility charge is no longer minted, allocation kept ──
  it("zero utility mints no charge but keeps allocation (subsidy fully covers the share)", async () => {
    const db = getDb();
    // SUBSIDY mode with a per-pax subsidy generous enough to fully cover the room's share.
    await db.apartment.update({ where: { id: APT }, data: { partitionBillingMode: "SUBSIDY" } });
    await db.utilityBillingConfig.create({ data: { organizationId: ORG, subsidyPerPax: "50.00" } });
    // Aircond reading 6.00 (rate 1.0 → currentReading 6) proves the aircond charge still
    // mints even though the shared-utility net is 0.
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "1.0000", isActive: true } });
    const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "6.00" });
    expect(rd.ok).toBe(true);
    // tnbTotal 6 == totalAircond 6 → leftoverTnb 0; pool = airSelangor 10; gross 10;
    // subsidyDeduction = min(10, 50*1pax) = 10 → net computedAmount 0.
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "6.00", airSelangor: "10.00" });
    const billId = (bill as { data: { id: string } }).data.id;

    // Preview confirms the room's net utility is exactly 0 (fully subsidised).
    const preview = await previewUtilityBillService(sess, billId);
    expect((preview as { data: { allocations: { computedAmount: number }[] } }).data.allocations[0].computedAmount).toBe(0);

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    const data = (charged as { data: { utilityCharges: number; aircondCharges: number } }).data;
    // No RM0 utility charge minted; the aircond (6.00) still is.
    expect(data.utilityCharges).toBe(0);
    expect(data.aircondCharges).toBe(1);

    // NO utility Charge row for this room …
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "utility" } })).toBe(0);
    // … but rent AND aircond charges ARE created (independent of the util charge).
    const rent = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(rent).not.toBeNull();
    expect(rent!.status).toBe("posted");
    const aircond = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "aircond" } });
    expect(aircond).not.toBeNull();

    // The audit allocation is preserved: chargeId null + computedAmount 0.00, status charged.
    const allocs = await db.utilityAllocation.findMany({ where: { organizationId: ORG } });
    expect(allocs.length).toBe(1);
    expect(allocs[0].chargeId).toBeNull();
    expect(allocs[0].computedAmount.toFixed(2)).toBe("0.00");
    expect(allocs[0].status).toBe("charged");
  });

  it("positive utility unchanged: computedAmount > 0 still mints the utility charge + allocation", async () => {
    const db = getDb();
    // no_subsidy (seed default): single occupied room, positive net utility.
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.00", airSelangor: "6.50", cleaning: "100.00" });
    const billId = (bill as { data: { id: string } }).data.id;

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);
    expect((charged as { data: { utilityCharges: number } }).data.utilityCharges).toBe(1);

    // utility Charge minted exactly as before: net = leftoverTnb 24 + airSelangor 6.50 = 30.50 (cleaning owner-borne).
    const util = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "utility" } });
    expect(util).not.toBeNull();
    expect(Number(util!.amount)).toBe(30.5);

    // allocation carries the real chargeId + status charged (unchanged behaviour).
    const allocs = await db.utilityAllocation.findMany({ where: { organizationId: ORG } });
    expect(allocs.length).toBe(1);
    expect(allocs[0].chargeId).toBe(util!.id);
    expect(allocs[0].status).toBe("charged");
    expect(Number(allocs[0].computedAmount)).toBe(30.5);
  });

  // ── org-scope isolation ─────────────────────────────────────────────────────
  it("org-scope: a getter called with a DIFFERENT orgId → 404 (cross-org isolation)", async () => {
    const db = getDb();
    const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "10.00" });
    const billId = (bill as { data: { id: string } }).data.id;

    const otherSess = { ...sess, orgId: "c2000000-0000-4000-8000-0000000000aa" };

    // same id, foreign org → not found (no leakage across tenants).
    const meterCross = await getMeterService(otherSess, meter.id);
    expect(meterCross.ok).toBe(false);
    expect((meterCross as { status: number }).status).toBe(404);

    const billCross = await getUtilityBillService(otherSess, billId);
    expect(billCross.ok).toBe(false);
    expect((billCross as { status: number }).status).toBe(404);

    // and the owning org still sees them (proves the entities really exist).
    expect((await getMeterService(sess, meter.id)).ok).toBe(true);
    expect((await getUtilityBillService(sess, billId)).ok).toBe(true);
  });

  // ── getReadingService (detail) ──────────────────────────────────────────────
  it("getReadingService: returns the reading; unknown id → 404 READING_NOT_FOUND", async () => {
    const db = getDb();
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    const created = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.00" });
    expect(created.ok).toBe(true);
    const readingId = (created as { data: { id: string } }).data.id;

    const got = await getReadingService(sess, readingId);
    expect(got.ok).toBe(true);
    const detail = (got as { data: { id: string; unitId: string; status: string } }).data;
    expect(detail.id).toBe(readingId);
    expect(detail.unitId).toBe(ROOM);
    expect(detail.status).toBe("submitted");

    const missing = await getReadingService(sess, "c2000000-0000-4000-8000-0000000000fd");
    expect(missing.ok).toBe(false);
    expect((missing as { status: number }).status).toBe(404);
    expect((missing as { error: string }).error).toBe("READING_NOT_FOUND");
  });

  // ── createReadingService: lazy meter-create (spec §6.2) ────────────────────
  const UNKNOWN_UNIT = "c2000000-0000-4000-8000-0000000000ff";

  it("lazy-create: reading on a meterless room lazily creates a meter (rate 0.6000, null meterNumber) and returns 201", async () => {
    const db = getDb();
    // No meter pre-created — the seed only creates the listing (ROOM, a normal room)

    const result = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-11-01", currentReading: "50.00" });
    expect(result.ok).toBe(true);
    expect((result as { status: number }).status).toBe(201);

    // A meter must now exist for the room
    const meter = await db.aircondMeter.findFirst({ where: { organizationId: ORG, unitId: ROOM } });
    expect(meter).not.toBeNull();
    expect(Number(meter!.ratePerKwh)).toBe(0.6);
    expect(meter!.meterNumber).toBeNull();
    expect(meter!.isActive).toBe(true);

    // The reading itself must exist and point to the lazily-created meter
    const readingId = (result as { data: { id: string } }).data.id;
    const reading = await db.meterReading.findFirstOrThrow({ where: { id: readingId } });
    expect(reading.meterId).toBe(meter!.id);
    expect(Number(reading.currentReading)).toBe(50);
    expect(reading.status).toBe("submitted");
  });

  it("lazy-create: meterless unknown unit → 404 UNIT_NOT_FOUND", async () => {
    const result = await createReadingService(sess, { unitId: UNKNOWN_UNIT, periodMonth: "2026-11-01", currentReading: "10.00" });
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(404);
    expect((result as { error: string }).error).toBe("UNIT_NOT_FOUND");
  });

  it("lazy-create: both audits (meter.meter.create + meter.reading.create) written in the same tx", async () => {
    const db = getDb();
    const auditsBefore = await db.auditLog.count({ where: { organizationId: ORG } });

    const result = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-11-01", currentReading: "30.00" });
    expect(result.ok).toBe(true);

    const meter = await db.aircondMeter.findFirstOrThrow({ where: { organizationId: ORG, unitId: ROOM } });
    const readingId = (result as { data: { id: string } }).data.id;

    const meterAudit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.meter.create", entityId: meter.id } });
    expect(meterAudit).not.toBeNull();

    const readingAudit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.reading.create", entityId: readingId } });
    expect(readingAudit).not.toBeNull();

    // exactly 2 new audit rows (one per action)
    const auditsAfter = await db.auditLog.count({ where: { organizationId: ORG } });
    expect(auditsAfter - auditsBefore).toBe(2);
  });

  // ── getBillingGridService ───────────────────────────────────────────────────
  const ROOM2_BG = "c2000000-0000-4000-8000-000000000021";
  const METER_BG = "c2000000-0000-4000-8000-000000000022";
  const ORG_B = "c2000000-0000-4000-8000-0000000000bb";

  dn("getBillingGridService (integration)", () => {
    beforeEach(async () => { await cleanup(); await seed(); });

    it("returns one row per room with meter+prevReading", async () => {
      const db = getDb();
      // Create meter for the main ROOM
      const meter = await db.aircondMeter.create({ data: { id: METER_BG, organizationId: ORG, unitId: ROOM, meterNumber: "M-001", ratePerKwh: "0.6000", isActive: true } });
      // Create a prior reading (Dec 2025)
      await db.meterReading.create({ data: { organizationId: ORG, meterId: meter.id, unitId: ROOM, periodMonth: new Date("2025-12-01T00:00:00.000Z"), previousReading: "0.00", currentReading: "30.00", consumption: "30.00", ratePerKwh: "0.6000", computedAmount: "18.00", status: "submitted", submittedBy: USER } });
      // Create a current-period reading (Jan 2026)
      const currentRd = await db.meterReading.create({ data: { organizationId: ORG, meterId: meter.id, unitId: ROOM, periodMonth: new Date("2026-01-01T00:00:00.000Z"), previousReading: "30.00", currentReading: "50.00", consumption: "20.00", ratePerKwh: "0.6000", computedAmount: "12.00", status: "submitted", submittedBy: USER } });

      const result = await getBillingGridService(sess, APT, "2026-01-01");
      expect(result.ok).toBe(true);
      const data = (result as { data: { rooms: unknown[]; apartment: unknown; period: string; bill: unknown } }).data;

      // Only the one seeded ROOM appears
      expect(data.rooms.length).toBe(1);
      const room = data.rooms[0] as Record<string, unknown>;
      expect(room.unitId).toBe(ROOM);
      expect(room.occupied).toBe(true);
      expect(room.tenantName).toBe("Tenant");
      expect(room.pax).toBe(1);
      expect(room.meter).toMatchObject({ id: METER_BG, meterNumber: "M-001" });
      expect(Number(room.previousReading)).toBe(30); // from Dec 2025 reading (Decimal serialised by Prisma)
      const cr = room.currentReading as Record<string, unknown>;
      expect(cr.id).toBe(currentRd.id);
      expect(Number(cr.currentReading)).toBe(50);
      expect(Number(cr.consumption)).toBe(20);
      expect(Number(cr.computedAmount)).toBe(12);
      expect(cr.status).toBe("submitted");
      // Task 9 D1: ownerPartyId resolves from ROOM.ownerPartyId (seed sets it to PARTY).
      expect(data.apartment).toMatchObject({ id: APT, unitCode: "A-1", ownerPartyId: PARTY });
      expect(data.period).toBe("2026-01-01");
      expect(data.bill).toBeNull();
    });

    it("apartment.ownerPartyId is null when no room in the apartment has an owner set", async () => {
      const db = getDb();
      const APT_NO_OWNER = "c2000000-0000-4000-8000-000000000023";
      const ROOM_NO_OWNER = "c2000000-0000-4000-8000-000000000024";
      await db.apartment.create({ data: { id: APT_NO_OWNER, organizationId: ORG, propertyId: PROP, unitCode: "A-9", listingMode: "WHOLE" } });
      // ownerPartyId intentionally omitted — mirrors attachment.mirror.integration.test.ts's "no-owner apartment" fixture.
      await db.listing.create({ data: { id: ROOM_NO_OWNER, organizationId: ORG, apartmentId: APT_NO_OWNER, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });

      const result = await getBillingGridService(sess, APT_NO_OWNER, "2026-06-01");
      expect(result.ok).toBe(true);
      const data = (result as { data: { apartment: { ownerPartyId: string | null } } }).data;
      expect(data.apartment.ownerPartyId).toBeNull();
    });

    it("room with no meter: meter=null, previousReading=null", async () => {
      // ROOM has no meter in this test (seed creates no meter)
      const result = await getBillingGridService(sess, APT, "2026-06-01");
      expect(result.ok).toBe(true);
      const data = (result as { data: { rooms: unknown[] } }).data;
      expect(data.rooms.length).toBe(1);
      const room = data.rooms[0] as Record<string, unknown>;
      expect(room.meter).toBeNull();
      expect(room.previousReading).toBeNull();
      expect(room.currentReading).toBeNull();
    });

    it("existing draft bill for the period → .bill non-null; no bill → .bill null", async () => {
      // no bill: already tested in the first test
      // Create a draft bill
      const billResult = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "50.00" });
      expect(billResult.ok).toBe(true);
      const billId = (billResult as { data: { id: string } }).data.id;

      const result = await getBillingGridService(sess, APT, "2026-06-01");
      expect(result.ok).toBe(true);
      const data = (result as { data: { bill: unknown } }).data;
      // bill.method dropped (Task 1): billing-grid bill is { id, status } only.
      expect(data.bill).toMatchObject({ id: billId, status: "draft" });
    });

    it("unknown apartmentId → 404 APARTMENT_NOT_FOUND", async () => {
      const result = await getBillingGridService(sess, "c2000000-0000-4000-8000-0000000099ff", "2026-06-01");
      expect(result.ok).toBe(false);
      expect((result as { status: number }).status).toBe(404);
      expect((result as { error: string }).error).toBe("APARTMENT_NOT_FOUND");
    });

    it("org-scope: caller from org B cannot read org A's apartment → 404", async () => {
      const otherSess = { ...sess, orgId: ORG_B };
      const result = await getBillingGridService(otherSess, APT, "2026-06-01");
      expect(result.ok).toBe(false);
      expect((result as { status: number }).status).toBe(404);
      expect((result as { error: string }).error).toBe("APARTMENT_NOT_FOUND");
    });

    it("billing grid returns the reading's STORED previousReading (override round-trips)", async () => {
      const db = getDb();
      const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
      // Prior period (May) establishes the auto-chain expectation = its current (30).
      await db.meterReading.create({ data: { organizationId: ORG, meterId: meter.id, unitId: ROOM, periodMonth: new Date("2026-05-01T00:00:00.000Z"), previousReading: "0.00", currentReading: "30.00", consumption: "30.00", ratePerKwh: "0.6000", computedAmount: "18.00", status: "submitted", submittedBy: USER } });
      // Current period (June) created with an OVERRIDE prev of 25 (≠ chain 30).
      await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "50.00", previousReading: "25.00" });

      const grid = await getBillingGridService(sess, APT, "2026-06-01");
      expect(grid.ok).toBe(true);
      const room = (grid as { data: { rooms: Array<Record<string, unknown>> } }).data.rooms.find((r) => r.unitId === ROOM)!;
      // top-level previousReading = prior-period auto-chain value (expected baseline)
      expect(Number(room.previousReading)).toBe(30);
      const cr = room.currentReading as Record<string, unknown>;
      // stored prev on THIS reading = the override
      expect(Number(cr.previousReading)).toBe(25);
      expect(Number(cr.consumption)).toBe(25); // 50 − 25
    });
  });

  // ── lazy-create: retired meter is REACTIVATED (Defect 1 fix) ─────────────
  it("lazy-create: reading on a room with a RETIRED meter reactivates it (not a 500) and returns 201", async () => {
    const db = getDb();
    const ROOM2 = "c2000000-0000-4000-8000-000000000011";
    await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT, listingType: "studio", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR" } });

    // Create + retire a meter explicitly
    const meterRow = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM2, ratePerKwh: "0.6500", isActive: false } });

    // Service must NOT 500 or throw; it must reactivate the retired meter and record the reading.
    const result = await createReadingService(sess, { unitId: ROOM2, periodMonth: "2026-12-01", currentReading: "30.00" });
    expect(result.ok).toBe(true);
    expect((result as { status: number }).status).toBe(201);

    // The same meter row is now active — no new meter created
    const allMeters = await db.aircondMeter.findMany({ where: { organizationId: ORG, unitId: ROOM2 } });
    expect(allMeters.length).toBe(1);
    expect(allMeters[0].id).toBe(meterRow.id);
    expect(allMeters[0].isActive).toBe(true);

    // Reading exists and is linked to the (reactivated) meter
    const readingId = (result as { data: { id: string } }).data.id;
    const reading = await db.meterReading.findFirstOrThrow({ where: { id: readingId } });
    expect(reading.meterId).toBe(meterRow.id);
    expect(reading.status).toBe("submitted");

    // Reactivation was audited inside the same tx (meter.meter.update action mirrors setMeterActiveService/restore)
    const reactivateAudit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.meter.restore", entityId: meterRow.id } });
    expect(reactivateAudit).not.toBeNull();

    // Reading audit also written
    const readingAudit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.reading.create", entityId: readingId } });
    expect(readingAudit).not.toBeNull();
  });

  it("lazy-create rollback: genuine tx failure (forced) leaves no partial state", async () => {
    const db = getDb();
    // Strategy: ROOM3 starts meterless. We lazy-create successfully (happy path)
    // so there IS a meter for this unit. Then we try to insert a DUPLICATE reading
    // for the SAME period → the MeterReading unique constraint (unitId + periodMonth)
    // fires inside $transaction → tx aborts → second reading is never committed.
    // This verifies that createReading is inside the tx and rolls back on failure.
    const ROOM3 = "c2000000-0000-4000-8000-000000000012";
    await db.listing.create({ data: { id: ROOM3, organizationId: ORG, apartmentId: APT, listingType: "studio", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR" } });

    // Happy path: lazy-creates meter + reading for ROOM3, period 2026-12-01.
    const first = await createReadingService(sess, { unitId: ROOM3, periodMonth: "2026-12-01", currentReading: "20.00" });
    expect(first.ok).toBe(true);
    const readingCountBefore = await db.meterReading.count({ where: { organizationId: ORG, unitId: ROOM3 } });

    // Duplicate reading for same period → caught as 409 READING_EXISTS (not a throw).
    const dup = await createReadingService(sess, { unitId: ROOM3, periodMonth: "2026-12-01", currentReading: "25.00" });
    expect(dup.ok).toBe(false);
    expect((dup as { status: number }).status).toBe(409);
    expect((dup as { error: string }).error).toBe("READING_EXISTS");

    // No second reading was committed — still only the original one.
    const readingCountAfter = await db.meterReading.count({ where: { organizationId: ORG, unitId: ROOM3 } });
    expect(readingCountAfter).toBe(readingCountBefore);
  });

  // ── tx ordering: a REJECTED reading must NOT commit a meter write ──────────
  // Regression: the lazy path reactivated/created the meter BEFORE the negative-
  // consumption guard. Because err() returns (not throws), the interactive
  // $transaction COMMITTED the meter write even though the caller saw a 422 →
  // a retired meter was silently reactivated + a misleading restore audit was
  // written, while no reading was recorded. The fix defers the meter write
  // until AFTER validation passes, so any rejection leaves zero meter writes.
  it("tx ordering: negative consumption on a RETIRED meter → 422, meter stays retired, no restore audit, no reading", async () => {
    const db = getDb();
    const ROOM_R = "c2000000-0000-4000-8000-000000000013";
    await db.listing.create({ data: { id: ROOM_R, organizationId: ORG, apartmentId: APT, listingType: "studio", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR" } });

    // Create a meter, give it a PRIOR reading (Nov 2026, current=100), then RETIRE it.
    const meterRow = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM_R, ratePerKwh: "0.6000", isActive: true } });
    await db.meterReading.create({ data: { organizationId: ORG, meterId: meterRow.id, unitId: ROOM_R, periodMonth: new Date("2026-11-01T00:00:00.000Z"), previousReading: "0.00", currentReading: "100.00", consumption: "100.00", ratePerKwh: "0.6000", computedAmount: "60.00", status: "submitted", submittedBy: USER } });
    const retired = await setMeterActiveService(sess, meterRow.id, false);
    expect(retired.ok).toBe(true);

    const restoreAuditsBefore = await db.auditLog.count({ where: { organizationId: ORG, action: "meter.meter.restore", entityId: meterRow.id } });
    const readingsBefore = await db.meterReading.count({ where: { organizationId: ORG, unitId: ROOM_R, periodMonth: new Date("2026-12-01T00:00:00.000Z") } });

    // Dec 2026 reading LOWER than the Nov prior (100 → 80) ⇒ consumption −20 ⇒ 422.
    const result = await createReadingService(sess, { unitId: ROOM_R, periodMonth: "2026-12-01", currentReading: "80.00" });
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(422);
    expect((result as { error: string }).error).toBe("NEGATIVE_CONSUMPTION");

    // The meter must still be RETIRED — the rejected reading committed no meter write.
    const meterAfter = await db.aircondMeter.findFirst({ where: { organizationId: ORG, unitId: ROOM_R } });
    expect(meterAfter!.isActive).toBe(false);

    // No new restore audit was written for it.
    const restoreAuditsAfter = await db.auditLog.count({ where: { organizationId: ORG, action: "meter.meter.restore", entityId: meterRow.id } });
    expect(restoreAuditsAfter).toBe(restoreAuditsBefore);

    // No reading was recorded for the rejected period.
    const readingsAfter = await db.meterReading.count({ where: { organizationId: ORG, unitId: ROOM_R, periodMonth: new Date("2026-12-01T00:00:00.000Z") } });
    expect(readingsAfter).toBe(readingsBefore);
  });

  // P2002 variant: a valid reading that collides with an existing one for the
  // period must roll back the deferred meter reactivation too (tx aborts).
  it("tx ordering: duplicate reading on a RETIRED meter → 409 READING_EXISTS and the meter stays retired", async () => {
    const db = getDb();
    const ROOM_D = "c2000000-0000-4000-8000-000000000014";
    await db.listing.create({ data: { id: ROOM_D, organizationId: ORG, apartmentId: APT, listingType: "loft", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR" } });

    // Meter + an EXISTING reading for Dec 2026, then RETIRE the meter.
    const meterRow = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM_D, ratePerKwh: "0.6000", isActive: true } });
    await db.meterReading.create({ data: { organizationId: ORG, meterId: meterRow.id, unitId: ROOM_D, periodMonth: new Date("2026-12-01T00:00:00.000Z"), previousReading: "0.00", currentReading: "100.00", consumption: "100.00", ratePerKwh: "0.6000", computedAmount: "60.00", status: "submitted", submittedBy: USER } });
    const retired = await setMeterActiveService(sess, meterRow.id, false);
    expect(retired.ok).toBe(true);

    // A VALID second reading (consumption ≥ 0) for the SAME period → P2002 on insert.
    const dup = await createReadingService(sess, { unitId: ROOM_D, periodMonth: "2026-12-01", currentReading: "120.00" });
    expect(dup.ok).toBe(false);
    expect((dup as { status: number }).status).toBe(409);
    expect((dup as { error: string }).error).toBe("READING_EXISTS");

    // The reactivation rolled back with the tx — the meter is still retired.
    const meterAfter = await db.aircondMeter.findFirst({ where: { organizationId: ORG, unitId: ROOM_D } });
    expect(meterAfter!.isActive).toBe(false);

    // Still exactly the one original reading for the period.
    const readingCount = await db.meterReading.count({ where: { organizationId: ORG, unitId: ROOM_D, periodMonth: new Date("2026-12-01T00:00:00.000Z") } });
    expect(readingCount).toBe(1);
  });

  // ── PART 1 (Workstream D): owner-borne total persisted at DRAFT ───────────
  // The owner must see the bill's owner-borne amount at DRAFT (before charge),
  // so the owner-ledger sync (which reads UnitUtilityBill.ownerBorneUtilitiesTotal)
  // surfaces it this month. ownerBorneUtilitiesTotal is a PURE calc (computeAllocation),
  // so we persist it on create + on every draft update — WITHOUT changing the
  // pooling/subsidy math and WITHOUT flipping the bill out of draft.
  it("PART1 draft visibility: createUtilityBillService persists ownerBorneUtilitiesTotal at DRAFT (bill still draft)", async () => {
    const db = getDb();
    // Owner-borne cleaning 100 (default owner bearer) + airSelangor 10 to tenant.
    // No aircond reading → totalAircond 0, leftoverTnb 0. ownerBorneUtilities = 100.
    const bill = await createUtilityBillService(sess, {
      apartmentId: APT,
      periodMonth: "2026-06-01",
      tnbTotal: "0.00",
      airSelangor: "10.00",
      cleaning: "100.00",
    });
    expect(bill.ok).toBe(true);
    const billId = (bill as { data: { id: string } }).data.id;

    const row = await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } });
    // Bill stays DRAFT — the draft-stage compute persists the seam field only.
    expect(row.status).toBe("draft");
    // owner-borne total visible at draft = ownerBorneUtilities (cleaning 100).
    expect(row.ownerBorneUtilitiesTotal).not.toBeNull();
    expect(Number(row.ownerBorneUtilitiesTotal)).toBeCloseTo(100, 2);
    expect(Number(row.ownerBorneUtilities)).toBeCloseTo(100, 2);
  });

  it("PART1 draft visibility: updateUtilityBillService recomputes ownerBorneUtilitiesTotal on a draft edit", async () => {
    const db = getDb();
    const bill = await createUtilityBillService(sess, {
      apartmentId: APT,
      periodMonth: "2026-06-01",
      tnbTotal: "0.00",
      airSelangor: "10.00",
      cleaning: "100.00",
    });
    const billId = (bill as { data: { id: string } }).data.id;
    expect(Number((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).ownerBorneUtilitiesTotal)).toBeCloseTo(100, 2);

    // Bump the owner-borne cleaning to 250 → owner-borne total tracks it at draft.
    const upd = await updateUtilityBillService(sess, billId, { cleaning: "250.00" });
    expect(upd.ok).toBe(true);
    const row = await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } });
    expect(row.status).toBe("draft");
    expect(Number(row.ownerBorneUtilitiesTotal)).toBeCloseTo(250, 2);
  });

  it("WHOLE draft visibility: a draft whose compute would throw (aircond>TNB) saves with null owner total (no draft-save failure)", async () => {
    const db = getDb();
    // WHOLE unit — one tenant, one master meter — so submetered aircond > TNB is a
    // genuine data-entry error that still throws AIRCON_EXCEEDS_TNB at compute (the
    // private-partition exemption does NOT apply). Reading 100 @0.6 = 60 aircond, TNB
    // only 10 → compute throws. The DRAFT save must still succeed (work-in-progress),
    // leaving ownerBorneUtilitiesTotal null until the numbers reconcile.
    await db.apartment.update({ where: { id: APT }, data: { listingMode: "WHOLE" } });
    await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
    await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "100.00" });
    const bill = await createUtilityBillService(sess, {
      apartmentId: APT,
      periodMonth: "2026-06-01",
      tnbTotal: "10.00",
      airSelangor: "6.50",
      cleaning: "100.00",
    });
    expect(bill.ok).toBe(true);
    const row = await db.unitUtilityBill.findFirstOrThrow({ where: { id: (bill as { data: { id: string } }).data.id } });
    expect(row.status).toBe("draft");
    expect(row.ownerBorneUtilitiesTotal).toBeNull();
  });

  // ── setTenancyPaxService (Bug A inline pax) ───────────────────────────────
  it("setTenancyPax updates Tenancy.numberOfPax and writes an audit row", async () => {
    const db = getDb();
    const before = await db.tenancy.findUniqueOrThrow({ where: { id: TEN } });
    expect(before.numberOfPax).toBe(1); // seeded

    const r = await setTenancyPaxService(sess, TEN, { numberOfPax: 4 });
    expect(r.ok).toBe(true);
    expect((r as { data: { id: string } }).data.id).toBe(TEN);

    const after = await db.tenancy.findUniqueOrThrow({ where: { id: TEN } });
    expect(after.numberOfPax).toBe(4);

    const audit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.tenancy.set_pax", entityId: TEN } });
    expect(audit).not.toBeNull();
  });

  it("setTenancyPax 404s for a tenancy in another org and writes NO audit row", async () => {
    const db = getDb();
    const r = await setTenancyPaxService({ ...sess, orgId: "c2000000-0000-4000-8000-0000000000ff" }, TEN, { numberOfPax: 3 });
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(404);

    // The real tenancy is untouched and no set_pax audit was written.
    const ten = await db.tenancy.findUniqueOrThrow({ where: { id: TEN } });
    expect(ten.numberOfPax).toBe(1);
    const audit = await db.auditLog.findFirst({ where: { organizationId: ORG, action: "meter.tenancy.set_pax", entityId: TEN } });
    expect(audit).toBeNull();
  });

  // ── NFR C1: draft create must NOT auto-sync the owner ledger ─────────────
  // Draft edits are too frequent (~8 syncs per bill key-in) and the owner-ledger
  // month view materialises on-demand when the admin opens it. Sync fires only on
  // charge (M3) and payment (T4), never on save-draft (C1 revert of Task 2).
  it("creating a draft utility bill does NOT materialise owner-ledger rows (no draft sync)", async () => {
    const db = getDb();
    await db.tenancy.updateMany({ where: { organizationId: ORG }, data: { status: "ended" } });
    const created = await createUtilityBillService(sess, {
      apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "200",
      airSelangor: "30", indahWater: "0", cleaning: "0",
    } as any);
    expect(created.ok).toBe(true);
    const rows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, statementMonth: new Date("2026-06-01T00:00:00.000Z") },
    });
    expect(rows.length).toBe(0); // no sync at draft — owner sees month only after charge/payment
  });

  // ── Owner-ledger sync (ENABLE_PHASE2_OWNER_BILLING) ─────────────────────────
  // These two cases assert the owner-ledger sync-hook (owner-ledger.sync-hook.ts),
  // which is flag-gated. The other cases in this file must run flag-OFF (the flag-on
  // R2 readiness gate, assertOwnerBillingReady, would 422 their charge posts because
  // they don't seed a ManagementFeeConfig). So scope the flag to JUST these two via
  // vi.stubEnv, and seed the owner's active config so the charge post passes the gate.
  describe("owner-ledger sync (flag-on: ENABLE_PHASE2_OWNER_BILLING)", () => {
    beforeEach(async () => {
      vi.stubEnv("ENABLE_PHASE2_OWNER_BILLING", "1");
      // R2 readiness (owner-billing-ready.ts): the owner (ROOM.ownerPartyId = PARTY)
      // must have an active ManagementFeeConfig covering the bill period, else
      // chargeUtilityBillService returns 422 OWNER_BILLING_NOT_CONFIGURED. propertyId
      // null = applies to all the owner's properties; no effective window = always eligible.
      await getDb().managementFeeConfig.create({
        data: { organizationId: ORG, ownerPartyId: PARTY, propertyId: null, feeType: "percent", feeValue: "10.00", isActive: true },
      });
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("T-rent: posting uses the reservation's agreedMonthlyRent and surfaces it as owner rent income", async () => {
      const db = getDb();
      // Link a reservation whose agreedMonthlyRent (980) must win over monthlyRentAmount (1000).
      const RESV = "c2000000-0000-4000-8000-0000000000a1";
      await db.unitReservation.create({
        data: {
          id: RESV, organizationId: ORG, referenceCode: "R-rent", issuedByPartyId: PARTY, expiresAt: new Date("2027-01-01"),
          publicToken: "tok-meter-rent", propertyId: PROP, unitId: ROOM, proposedMoveIn: new Date("2026-06-01"),
          reservationDeposit: "0.00", documentationFee: "0.00", rentalDeposit: "0.00", utilityDeposit: "0.00", accessCardDeposit: "0.00",
          agreedMonthlyRent: "980.00",
        },
      });
      await db.tenancy.update({ where: { id: TEN }, data: { reservationId: RESV } });

      const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "10.00", cleaning: "100.00" });
      const billId = (bill as { data: { id: string } }).data.id;
      expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

      const rent = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
      expect(rent.status).toBe("posted");
      expect(Number(rent.amount)).toBe(980); // agreedMonthlyRent, not 1000

      // Owner ledger (owner = ROOM.ownerPartyId = PARTY) surfaces the rent as an income
      // line for June, tied to the rent charge. (The row's `amount` is collected-to-date —
      // 0 while unpaid; income realizes on payment via the T4 payment sync.)
      const income = await db.ownerLedgerEntry.findMany({
        where: { organizationId: ORG, statementMonth: new Date("2026-06-01"), category: "rental_income" },
      });
      expect(income.length).toBe(1);
      expect(income[0].sourceChargeId).toBe(rent.id);
      expect(income[0].includeInPayout).toBe(true);
      expect(income[0].paymentStatus).toBe("pending"); // posted but unpaid
    });

    it("charging a bill posts tenant-visible charges and the owner ledger shows pending", async () => {
      const db = getDb();
      await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
      const rd = await createReadingService(sess, { unitId: ROOM, periodMonth: "2026-06-01", currentReading: "40.35" }); // 0→40.35 @0.6 = 24.21
      expect(rd.ok).toBe(true);
      const bill = await createUtilityBillService(sess, { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "24.21", airSelangor: "6.50", cleaning: "100.00" });
      expect(bill.ok).toBe(true);
      const billId = (bill as { data: { id: string } }).data.id;

      const res = await chargeUtilityBillService(sess, billId, {} as any);
      expect(res.ok).toBe(true);

      // one-action post: charges must be "posted" immediately (D-#4), NOT "draft".
      const charges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: { in: ["utility", "aircond"] } } });
      expect(charges.every((c) => c.status === "posted")).toBe(true);

      // owner-ledger must have at least one row for June-2026 (cleaning is owner-borne → expense row).
      const led = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, statementMonth: new Date("2026-06-01") } });
      expect(led.length).toBeGreaterThan(0);
    });
  });
});
