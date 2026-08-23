/**
 * Task 3 — per-utility ChargeCategory seeds (integration).
 *
 * Verifies SEED_CHARGE_CATEGORIES' 9 new utility rows (electricity/water/
 * sewerage/wifi tenant+owner pairs + subsidy_tenant, tenant-only) are seeded
 * by ensureChargeCategorySeeds with correct family/series/docType routing +
 * defaultSstRate, and that re-running the seeder is idempotent (no duplicate
 * rows) — spec R3 / plan Task 3 acceptance table.
 *
 * family is DOCUMENT ROUTING only: every tenant code -> tenant_income/IVTEN/
 * invoice; every owner code -> owner_income/IVOWN/invoice. Never
 * pay_back_landlord (that family requires docType:"debit_note" — see the
 * shared-package invariant test packages/shared/src/__tests__/
 * seed-categories.test.ts). The economics (owner_funds/recovery_of_advance/
 * manager_revenue) are stamped on the Charge by a later task's classifier —
 * NOT tested here.
 *
 * Real local Postgres only (mirrors apps/api/src/modules/charge-categories/
 * __tests__/profit-expense.integration.test.ts's RUN_INTEGRATION + host-guard
 * convention).
 *
 * Run:
 *   set -a; source ./.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     apps/api/src/modules/bills-grid/__tests__/grid-utility-categories.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";
import { SEED_CHARGE_CATEGORIES } from "@kason/shared";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "ca7e0000-0000-4000-8000-000000000001";

const NEW_UTILITY_CODES = [
  "electricity_tenant", "electricity_owner",
  "water_tenant", "water_owner",
  "sewerage_tenant", "sewerage_owner",
  "wifi_tenant", "wifi_owner",
  "subsidy_tenant",
] as const;

async function cleanup() {
  const db = getDb();
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "GridUtilityCategoriesOrg",
      slug: "grid-utility-categories-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function categoryByCode(code: string) {
  const db = getDb();
  return db.chargeCategory.findFirst({
    where: { organizationId: ORG, code },
    include: { series: { select: { code: true } } },
  });
}

dn("per-utility ChargeCategory seeds (Task 3)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });

  it("seeds electricity_tenant/electricity_owner with correct family/series/docType/SST routing", async () => {
    await ensureChargeCategorySeeds(ORG);

    const tenant = await categoryByCode("electricity_tenant");
    const owner = await categoryByCode("electricity_owner");

    expect(tenant).toMatchObject({ family: "tenant_income", docType: "invoice" });
    expect(tenant?.series.code).toBe("IVTEN");
    expect(tenant?.defaultSstRate.toString()).toBe("0");

    expect(owner).toMatchObject({
      family: "owner_income",
      docType: "invoice",
      ledgerCategory: "utilities_tnb",
      isSystem: true,
    });
    expect(owner?.series.code).toBe("IVOWN");
    expect(owner?.defaultSstRate.toString()).toBe("0");
  });

  it("seeds water_tenant/water_owner with correct family/series/docType/SST routing", async () => {
    await ensureChargeCategorySeeds(ORG);

    const tenant = await categoryByCode("water_tenant");
    const owner = await categoryByCode("water_owner");

    expect(tenant).toMatchObject({ family: "tenant_income", docType: "invoice" });
    expect(tenant?.series.code).toBe("IVTEN");
    expect(tenant?.defaultSstRate.toString()).toBe("0");

    expect(owner).toMatchObject({
      family: "owner_income",
      docType: "invoice",
      ledgerCategory: "water",
      isSystem: true,
    });
    expect(owner?.series.code).toBe("IVOWN");
    expect(owner?.defaultSstRate.toString()).toBe("0");
  });

  it("seeds sewerage_tenant/sewerage_owner with correct family/series/docType/SST routing", async () => {
    await ensureChargeCategorySeeds(ORG);

    const tenant = await categoryByCode("sewerage_tenant");
    const owner = await categoryByCode("sewerage_owner");

    expect(tenant).toMatchObject({ family: "tenant_income", docType: "invoice" });
    expect(tenant?.series.code).toBe("IVTEN");
    expect(tenant?.defaultSstRate.toString()).toBe("0");

    expect(owner).toMatchObject({
      family: "owner_income",
      docType: "invoice",
      ledgerCategory: "indah_water",
      isSystem: true,
    });
    expect(owner?.series.code).toBe("IVOWN");
    expect(owner?.defaultSstRate.toString()).toBe("0");
  });

  it("seeds Cleaning at 8% SST while WiFi supplier pass-through stays at 0%", async () => {
    await ensureChargeCategorySeeds(ORG);

    const wifiTenant = await categoryByCode("wifi_tenant");
    const wifiOwner = await categoryByCode("wifi_owner");
    const cleaningTenant = await categoryByCode("cleaning_tenant");
    const cleaningOwner = await categoryByCode("cleaning_owner");

    expect(wifiTenant).toMatchObject({ family: "tenant_income", docType: "invoice" });
    expect(wifiTenant?.series.code).toBe("IVTEN");
    expect(cleaningTenant?.defaultSstRate.toString()).toBe("8");
    expect(wifiTenant?.defaultSstRate.toString()).toBe("0");

    expect(wifiOwner).toMatchObject({
      family: "owner_income",
      docType: "invoice",
      ledgerCategory: "wifi",
      isSystem: true,
    });
    expect(wifiOwner?.series.code).toBe("IVOWN");
    expect(cleaningOwner?.defaultSstRate.toString()).toBe("8");
    expect(wifiOwner?.defaultSstRate.toString()).toBe("0");
  });

  it("seeds subsidy_tenant only (no subsidy_owner — an owner-funded offset shown on the TENANT invoice), lands the org at exactly SEED_CHARGE_CATEGORIES.length, and re-running the seeder creates no duplicate rows", async () => {
    await ensureChargeCategorySeeds(ORG);

    const subsidyTenant = await categoryByCode("subsidy_tenant");
    expect(subsidyTenant).toMatchObject({ family: "tenant_income", docType: "invoice" });
    expect(subsidyTenant?.series.code).toBe("IVTEN");
    expect(subsidyTenant?.defaultSstRate.toString()).toBe("0");

    // Asymmetry: subsidy is tenant-side ONLY — no owner counterpart code exists.
    const subsidyOwner = await categoryByCode("subsidy_owner");
    expect(subsidyOwner).toBeNull();

    const db = getDb();
    // DERIVED, never a literal. The seeder loops SEED_CHARGE_CATEGORIES with no filter, so
    // "how many categories does a fresh org get" IS that array's length — asserting a hand-
    // maintained number instead just re-encodes the same fact somewhere it can rot. It did:
    // this line read 33 while the array held 37 (letting_commission +2, then maintenance +2),
    // and because `master` runs no CI the first thing to execute it would have been a
    // promotion PR. Composition-by-family is asserted in the shared seed-categories test.
    expect(await db.chargeCategory.count({ where: { organizationId: ORG } })).toBe(SEED_CHARGE_CATEGORIES.length);

    const before = await db.chargeCategory.count({ where: { organizationId: ORG, code: { in: [...NEW_UTILITY_CODES] } } });
    expect(before).toBe(NEW_UTILITY_CODES.length); // all 9 new codes exist exactly once

    await ensureChargeCategorySeeds(ORG); // second (sequential) call — must be a no-op

    const after = await db.chargeCategory.count({ where: { organizationId: ORG, code: { in: [...NEW_UTILITY_CODES] } } });
    expect(after).toBe(NEW_UTILITY_CODES.length); // unchanged — no duplicates created
    expect(await db.chargeCategory.count({ where: { organizationId: ORG } })).toBe(SEED_CHARGE_CATEGORIES.length); // total unchanged too
  });

  it("stays race-safe under a TRUE concurrent double-seed (Promise.all) on a fresh org — exactly one row per new code, no unhandled rejection", async () => {
    const db = getDb();
    // Genuinely concurrent — unlike the sequential case above, both calls read
    // the "nothing seeded yet" snapshot before either has written anything, so
    // BOTH attempt every create() and the loser of each per-code race must hit
    // the P2002 catch in ensureChargeCategorySeeds, not the existence-check skip.
    await expect(
      Promise.all([ensureChargeCategorySeeds(ORG), ensureChargeCategorySeeds(ORG)]),
    ).resolves.toBeDefined();

    const count = await db.chargeCategory.count({ where: { organizationId: ORG, code: { in: [...NEW_UTILITY_CODES] } } });
    expect(count).toBe(NEW_UTILITY_CODES.length); // exactly one row per new code — no duplicates from the race
  });
});
