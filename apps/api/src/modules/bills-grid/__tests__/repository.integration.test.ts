/**
 * Bills-grid repository — race-safe get-or-create of the parent entry (Task 4).
 *
 * Integration suite (RUN_INTEGRATION=1) against the real local Postgres. Uses the
 * meter module's harness convention (getDb + RUN_INTEGRATION gate + non-local host
 * guard) rather than a bare `new PrismaClient()`: under Prisma 7 the datasource has
 * no `url`, so the client is only constructible through @kason/db's PrismaPg adapter.
 * Self-seeds its own org/property/apartment with fixed disjoint UUIDs (prefix b90a).
 *
 * Run:
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/bills-grid/__tests__/repository.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getOrCreateEntry, resolveBearerConfig } from "../repository";
import { cleanupGridFixtures } from "./cleanup";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const db = getDb();

// Fixed disjoint UUIDs (prefix b90a)
const ORG = "b90a0000-0000-4000-8000-000000000001";
const PROP = "b90a0000-0000-4000-8000-000000000003";
const APT = "b90a0000-0000-4000-8000-000000000004";
/** A PARTITIONED sibling of APT — unit-type bearer defaults are read off listingMode,
 *  so the two modes need two apartments to tell apart. */
const APT_PART = "b90a0000-0000-4000-8000-000000000005";
const ACTOR = "b90a0000-0000-4000-8000-0000000000aa"; // createdBy/actorUserId — plain column, no FK

const PERIOD = new Date("2026-07-01T00:00:00.000Z");

async function seed() {
  await db.organization.create({ data: { id: ORG, name: "Bills-Grid Repo Org", slug: "bills-grid-repo-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BG1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_PART, organizationId: ORG, propertyId: PROP, unitCode: "A-2", listingMode: "PARTITIONED" } });
}

dn("bills-grid repository — get-or-create", () => {
  beforeAll(async () => {
    // Clean slate in FK-safe order (grid rows before the apartment they Restrict).
    await cleanupGridFixtures(db, ORG);
    await db.apartment.deleteMany({ where: { organizationId: ORG } });
    await db.property.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await seed();
  });

  // Teardown ORDER is load-bearing: the entry's .apartment FK is onDelete: Restrict,
  // so grid rows MUST die before the apartment. cleanupGridFixtures then apt→prop→org.
  afterAll(async () => {
    await cleanupGridFixtures(db, ORG);
    await db.apartment.deleteMany({ where: { organizationId: ORG } });
    await db.property.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
  });

  // The CREATE half of the unit-type defaults. Its READ twin is toBearerConfigDto /
  // getBearerConfigService (row-dto-mappers.test.ts) — if these two ever disagree, the
  // drawer shows an admin one bearer while the entry snapshot silently bills the other.
  it("config from WHOLE defaults when absent — cleaning/WiFi start OWNER-borne", async () => {
    const cfg = await db.$transaction((tx) => resolveBearerConfig(tx, { orgId: ORG, apartmentId: APT }));
    expect(cfg.tnbPattern).toBe("recharged");
    expect(cfg.airPattern).toBe("recharged");
    expect(cfg.cleaningBearer).toBe("owner");
    expect(cfg.wifiBearer).toBe("owner");
    expect(cfg.maintenanceFeeBearer).toBe("owner");
    expect(String(cfg.cleaningRecurringAmount)).toBe("100");
  });

  // PARTITIONED cleaning/WiFi are shared common-area costs the owner carries. TNB/AIR
  // stay "recharged" in BOTH modes — the excess→owner spread is engine-side
  // (computeAllocation's privateAircond clamp), never expressed as a bearer here.
  it("config from PARTITIONED defaults when absent — cleaning/WiFi start OWNER-borne, TNB/AIR still tenant", async () => {
    const cfg = await db.$transaction((tx) => resolveBearerConfig(tx, { orgId: ORG, apartmentId: APT_PART }));
    expect(cfg.cleaningBearer).toBe("owner");
    expect(cfg.wifiBearer).toBe("owner");
    expect(cfg.tnbPattern).toBe("recharged");
    expect(cfg.airPattern).toBe("recharged");
  });

  // Non-retroactive READ: a historical config is returned untouched. The explicit
  // bearer-config SAVE path is what converts future/open snapshots to owner-only.
  it("an existing config is returned untouched — the listing-mode default never overwrites an admin's choice", async () => {
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT_PART } },
      create: { organizationId: ORG, apartmentId: APT_PART, cleaningBearer: "tenant", wifiBearer: "tenant" },
      update: { cleaningBearer: "tenant", wifiBearer: "tenant" },
    });
    const cfg = await db.$transaction((tx) => resolveBearerConfig(tx, { orgId: ORG, apartmentId: APT_PART }));
    expect(cfg.cleaningBearer).toBe("tenant"); // NOT re-defaulted to PARTITIONED's "owner"
    expect(cfg.wifiBearer).toBe("tenant");
  });

  // The MIRROR of the test above, and the case that actually bites: a WHOLE unit whose
  // admin deliberately set cleaning/WiFi to OWNER. WHOLE's default is TENANT, so this is
  // where a stray re-seed would silently move an owner-borne cost onto the tenant.
  // "It's a default, not a must — sometimes a whole unit is owner too."
  it("a WHOLE unit explicitly set to OWNER is returned untouched — the tenant default never wins", async () => {
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      create: { organizationId: ORG, apartmentId: APT, cleaningBearer: "owner", wifiBearer: "owner", tnbPattern: "absorbed" },
      update: { cleaningBearer: "owner", wifiBearer: "owner", tnbPattern: "absorbed" },
    });
    const cfg = await db.$transaction((tx) => resolveBearerConfig(tx, { orgId: ORG, apartmentId: APT }));
    expect(cfg.cleaningBearer).toBe("owner"); // NOT re-defaulted to WHOLE's "tenant"
    expect(cfg.wifiBearer).toBe("owner");
    expect(cfg.tnbPattern).toBe("absorbed");
  });

  // End of the chain: the admin's OVERRIDE (not the listing-mode default) is what lands
  // on the period entry, which is the row the Bill actually reads. A default that leaked
  // in here would bill the tenant regardless of what the drawer showed.
  it("the admin's override — not the listing-mode default — is what the entry snapshot carries", async () => {
    const period = new Date("2026-11-01T00:00:00.000Z");
    await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: period } });
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      create: { organizationId: ORG, apartmentId: APT, cleaningBearer: "owner", wifiBearer: "owner" },
      update: { cleaningBearer: "owner", wifiBearer: "owner" },
    });
    const e = await db.$transaction((tx) =>
      getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: period, actorUserId: ACTOR }),
    );
    expect(e.cleaningBearer).toBe("owner");
    expect(e.wifiBearer).toBe("owner");
  });

  it("snapshot: creating the entry copies the five line settings and seeds cleaning", async () => {
    // Config = absorbed/120. upsert (not update) so this passes standalone (an isolated
    // `-t "snapshot"` run) as well as chained after "config from defaults".
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      create: { organizationId: ORG, apartmentId: APT, tnbPattern: "absorbed", cleaningRecurringAmount: "120" },
      update: { tnbPattern: "absorbed", cleaningRecurringAmount: "120" },
    });
    const e = await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: PERIOD, actorUserId: ACTOR }));
    expect(e.tnbPattern).toBe("absorbed");
    expect(String(e.cleaning)).toBe("120");
    expect(e.billedAt).toBeNull();
    expect(e.paymentStatus).toBe("unpaid");
  });

  it("idempotent: a second call returns the same row and does not re-snapshot", async () => {
    // Self-seed the precondition (an entry snapshotted from an "absorbed" config) so the
    // isolated `-t "idempotent"` run passes too; in the chained run the entry already exists.
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      create: { organizationId: ORG, apartmentId: APT, tnbPattern: "absorbed", cleaningRecurringAmount: "120" },
      update: { tnbPattern: "absorbed" },
    });
    await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: PERIOD, actorUserId: ACTOR }));
    // Flip the config AFTER the entry exists — the entry's snapshot must NOT change.
    await db.unitBillsBearerConfig.update({ where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } }, data: { tnbPattern: "recharged" } });
    const e = await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: PERIOD, actorUserId: ACTOR }));
    expect(e.tnbPattern).toBe("absorbed"); // NOT retro-mutated by the config change
    expect(await db.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } })).toBe(1);
  });

  it("P2002: two racing creates yield exactly one row and neither throws", async () => {
    const p2 = new Date("2026-08-01T00:00:00.000Z");
    await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: p2 } });
    const call = () => db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: p2, actorUserId: ACTOR }));
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.id).toBe(b.id);
    expect(await db.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT, periodMonth: p2 } })).toBe(1);
  });

  it("normalize: a non-first-of-month periodMonth keys on the 1st (no duplicate month entry)", async () => {
    const mid = new Date("2026-09-15T00:00:00.000Z");
    const later = new Date("2026-09-20T00:00:00.000Z");
    const first = new Date("2026-09-01T00:00:00.000Z");
    await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: first } });
    const a = await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: mid, actorUserId: ACTOR }));
    expect(a.periodMonth.toISOString()).toBe(first.toISOString()); // pinned to the 1st
    const b = await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: later, actorUserId: ACTOR }));
    expect(b.id).toBe(a.id); // same month → same row, not a second entry
    expect(await db.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT, periodMonth: first } })).toBe(1);
  });

  it("Restrict FK: deleting the apartment while an entry points at it is rejected (teardown order matters)", async () => {
    // Proves the "before cleanupGridFixtures → FK violation" half of the acceptance row.
    // The "after → succeeds" half is exercised by this suite's afterAll, which runs
    // cleanupGridFixtures first and then deletes the apartment without error.
    const p4 = new Date("2026-10-01T00:00:00.000Z");
    await db.$transaction((tx) => getOrCreateEntry(tx, { orgId: ORG, apartmentId: APT, periodMonth: p4, actorUserId: ACTOR }));
    await expect(db.apartment.delete({ where: { id: APT } })).rejects.toThrow();
    expect(await db.apartment.count({ where: { id: APT } })).toBe(1); // still present
  });
});
