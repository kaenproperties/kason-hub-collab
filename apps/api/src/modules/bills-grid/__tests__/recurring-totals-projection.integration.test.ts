/**
 * Grid-read Recurring Owner/Tenant TOTALS, unopened-period PROJECTION (sibling of the dialog's
 * recurring-lines-projection). A CUSTOM definition saved in Settings must show in the grid's
 * Recurring totals for a month whose grid entry does not exist yet — before this fix the column
 * read "0.00" until an unrelated save (another column / an expense) first opened the period and
 * materialize-on-open wrote the lines. The projection uses the SAME resolver materialization
 * uses, so the displayed total is exactly what opening the month will write (display == mint).
 *
 * Self-isolated ORG (parallel-safe). Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/recurring-totals-projection.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getOrCreateEntry } from "../repository";
import { projectedRecurringTotalsByApartment } from "../service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c8520000-0000-4000-8000-000000000001";
const USER = "c8520000-0000-4000-8000-000000000002";
const PROP = "c8520000-0000-4000-8000-000000000003";
const APT = "c8520000-0000-4000-8000-000000000004"; // owner + active tenancy
const ROOM = "c8520000-0000-4000-8000-000000000005";
const OWNER_PARTY = "c8520000-0000-4000-8000-000000000006";
const TENANT_PARTY = "c8520000-0000-4000-8000-000000000007";
const TENANCY = "c8520000-0000-4000-8000-000000000008";
const APT_NOTEN = "c8520000-0000-4000-8000-000000000009"; // owner, NO active tenancy
const ROOM2 = "c8520000-0000-4000-8000-00000000000a";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function cleanup() {
  const db = getDb();
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "RT", slug: "rt-proj", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rt-proj@example.test", fullName: "RT", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RTP", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RTP", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-RTP", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  await db.apartment.create({ data: { id: APT_NOTEN, organizationId: ORG, propertyId: PROP, unitCode: "B-RTP", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM2, organizationId: ORG, apartmentId: APT_NOTEN, listingType: "whole_unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
}

async function makeDef(code: string, name: string, apartmentId = APT) {
  return getDb().recurringChargeDefinition.create({ data: { organizationId: ORG, apartmentId, kind: "CUSTOM", code, name, createdBy: USER } });
}
async function makeRev(definitionId: string, amount: string, bearer: string, from: string, enabled = true, categoryId: string | null = null) {
  return getDb().recurringChargeRevision.create({ data: { definitionId, amount, bearer, categoryId, effectiveFromMonth: d(from), effectiveToMonth: null, enabled, createdBy: USER } });
}
async function cats() {
  await ensureChargeCategorySeeds(ORG);
  const db = getDb();
  const owner = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_owner" }, select: { id: true } });
  const tenant = await db.chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code: "recurring_other_tenant" }, select: { id: true } });
  return { owner: owner.id, tenant: tenant.id };
}

dn("bills-grid recurring TOTALS — unopened-period projection", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("projects owner+tenant totals and named items for an apartment whose month entry does not exist", async () => {
    const c = await cats();
    const dOwner = await makeDef("custom-own1", "Gardener");
    await makeRev(dOwner.id, "80.00", "owner", "2026-08-01", true, c.owner);
    const dTenant = await makeDef("custom-ten1", "Laundry");
    await makeRev(dTenant.id, "30.00", "tenant", "2026-08-01", true, c.tenant);

    const map = await projectedRecurringTotalsByApartment(ORG, [APT, APT_NOTEN], d("2026-08-01"));
    expect(map.get(APT)).toEqual({
      ownerTotal: 80,
      ownerCount: 1,
      ownerItems: [{ id: dOwner.id, name: "Gardener", amount: "80.00" }],
      tenantTotal: 30,
      tenantCount: 1,
      tenantItems: [{ id: dTenant.id, name: "Laundry", amount: "30.00" }],
    });
    // No entry was created by the read (PURE projection).
    expect(await getDb().unitBillsGridEntry.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("matches exactly what materialize-on-open then persists (display == mint)", async () => {
    const c = await cats();
    const def = await makeDef("custom-own2", "Gardener");
    await makeRev(def.id, "80.00", "owner", "2026-08-01", true, c.owner);

    const projected = await projectedRecurringTotalsByApartment(ORG, [APT], d("2026-08-01"));
    await getDb().$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: d("2026-08-01"), actorUserId: USER }));
    const lines = await getDb().gridEntryRecurringLine.findMany({ where: { organizationId: ORG } });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.amount)).toBe(projected.get(APT)!.ownerTotal);
    expect(lines[0]!.bearer).toBe("owner");
  });

  it("fail-closed: a tenant-borne line with no active tenancy is NOT projected (same rule as materialize)", async () => {
    const c = await cats();
    const def = await makeDef("custom-ten2", "Laundry", APT_NOTEN);
    await makeRev(def.id, "30.00", "tenant", "2026-08-01", true, c.tenant);
    const map = await projectedRecurringTotalsByApartment(ORG, [APT_NOTEN], d("2026-08-01"));
    expect(map.get(APT_NOTEN)).toBeUndefined();
  });

  it("skips disabled revisions, pre-effective months, and stays empty flag-off", async () => {
    const c = await cats();
    const def = await makeDef("custom-own3", "Gardener");
    await makeRev(def.id, "80.00", "owner", "2026-08-01", false, c.owner);
    expect((await projectedRecurringTotalsByApartment(ORG, [APT], d("2026-08-01"))).size).toBe(0);

    const def2 = await makeDef("custom-own4", "Pool");
    await makeRev(def2.id, "50.00", "owner", "2026-09-01", true, c.owner);
    // August is BEFORE the revision's effective-from → nothing projected for August.
    expect((await projectedRecurringTotalsByApartment(ORG, [APT], d("2026-08-01"))).size).toBe(0);

    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    expect((await projectedRecurringTotalsByApartment(ORG, [APT], d("2026-09-01"))).size).toBe(0);
  });
});
