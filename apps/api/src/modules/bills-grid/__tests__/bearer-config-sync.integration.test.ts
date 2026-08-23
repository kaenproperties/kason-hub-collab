/**
 * Unit-setting drawer save semantics (user rule 2026-08-06): "if unbilled, let the
 * admin change ANYTIME; if already billed, say so — never pretend."
 *
 *  • setBearerConfigService pushes ALL five settings (tnb/air patterns INCLUDED —
 *    the old future-months-only carve-out made the drawer a silent no-op for the
 *    month on screen) onto every syncable open period, and reports the months it
 *    could NOT touch as `lockedEntries` instead of an unqualified success.
 *  • applyRecurringService with nature omitted on an EDIT carries the latest
 *    revision's decided nature forward (it used to silently null it).
 *
 * Real local Postgres only. Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/bearer-config-sync.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { setBearerConfigService } from "../service";
import { applyRecurringService } from "../recurring.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "b5c00000-0000-4000-8000-000000000001";
const USER = "b5c00000-0000-4000-8000-000000000002";
const PROP = "b5c00000-0000-4000-8000-000000000003";
const APT = "b5c00000-0000-4000-8000-000000000004";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const SESSION = { orgId: ORG, userId: USER, role: "manager" };

/** First of the CURRENT month (UTC) — the sync loop only touches periods >= this. */
function currentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const BODY = {
  tnbPattern: "absorbed",
  airPattern: "absorbed",
  cleaningBearer: "owner",
  wifiBearer: "owner",
  maintenanceFeeBearer: "owner",
  cleaningRecurringAmount: "100.00",
  unlock: true,
};

async function cleanup() {
  const db = getDb();
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BC", slug: "bc-sync", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bc@example.test", fullName: "BC", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BC", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-BC", listingMode: "WHOLE" } });
}

async function makeEntry(periodMonth: Date, extra: Record<string, unknown> = {}) {
  return getDb().unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth, createdBy: USER,
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
      ...extra,
    },
  });
}

dn("setBearerConfigService — push-to-open-months semantics", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });
  afterEach(cleanup);

  it("an UNBILLED current month takes the whole save — patterns AND bearers — and reports syncedEntries", async () => {
    const e = await makeEntry(currentMonth());
    const r = await setBearerConfigService(SESSION, APT, BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.syncedEntries).toBe(1);
    expect(r.data.lockedEntries).toBe(0);
    const fresh = await getDb().unitBillsGridEntry.findUniqueOrThrow({ where: { id: e.id } });
    expect(fresh.tnbPattern).toBe("absorbed");
    expect(fresh.airPattern).toBe("absorbed");
    expect(fresh.cleaningBearer).toBe("owner");
    expect(fresh.wifiBearer).toBe("owner");
    expect(fresh.maintenanceFeeBearer).toBe("owner");
  });

  it("a BILLED but unpaid month takes the new bearer settings and can be re-billed", async () => {
    const e = await makeEntry(currentMonth(), { billedAt: new Date() });
    const r = await setBearerConfigService(SESSION, APT, BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.syncedEntries).toBe(1);
    expect(r.data.lockedEntries).toBe(0);
    const fresh = await getDb().unitBillsGridEntry.findUniqueOrThrow({ where: { id: e.id } });
    expect(fresh.tnbPattern).toBe("absorbed");
    expect(fresh.airPattern).toBe("absorbed");
    expect(fresh.cleaningBearer).toBe("owner");
    expect(fresh.wifiBearer).toBe("owner");
    expect(fresh.maintenanceFeeBearer).toBe("owner");
    // The CONFIG also updates, so future months inherit the same answer.
    const cfg = await getDb().unitBillsBearerConfig.findUniqueOrThrow({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
    });
    expect(cfg.cleaningBearer).toBe("owner");
  });

  it("canonicalises a stale client's tenant Cleaning/WiFi save to Owner", async () => {
    const e = await makeEntry(currentMonth());
    const r = await setBearerConfigService(SESSION, APT, {
      ...BODY,
      cleaningBearer: "tenant",
      wifiBearer: "tenant",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const db = getDb();
    const cfg = await db.unitBillsBearerConfig.findUniqueOrThrow({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
    });
    const fresh = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: e.id } });
    expect(cfg.cleaningBearer).toBe("owner");
    expect(cfg.wifiBearer).toBe("owner");
    expect(fresh.cleaningBearer).toBe("owner");
    expect(fresh.wifiBearer).toBe("owner");
  });
});

dn("applyRecurringService — nature copy-forward on edits", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });
  afterEach(cleanup);

  it("an amount edit WITHOUT nature keeps the prior revision's decided nature (no silent null)", async () => {
    const db = getDb();
    const def = await db.recurringChargeDefinition.create({
      data: { organizationId: ORG, apartmentId: APT, kind: "WIFI", code: "wifi", name: "WiFi", createdBy: USER },
    });
    await db.recurringChargeRevision.create({
      data: { definitionId: def.id, amount: "89.00", bearer: "tenant", nature: "profit", effectiveFromMonth: d("2026-01-01"), enabled: true, createdBy: USER },
    });
    const r = await applyRecurringService(SESSION, APT, {
      definitionId: def.id, kind: "WIFI", name: "WiFi", amount: "99.00",
      bearer: "tenant", effectiveFromMonth: "2026-06-01", enabled: true, confirm: true,
    });
    expect(r.ok).toBe(true);
    const latest = await db.recurringChargeRevision.findFirstOrThrow({
      where: { definitionId: def.id },
      orderBy: { effectiveFromMonth: "desc" },
    });
    expect(latest.amount.toFixed(2)).toBe("99.00");
    expect(latest.nature).toBe("profit"); // carried forward, not nulled
  });
});
