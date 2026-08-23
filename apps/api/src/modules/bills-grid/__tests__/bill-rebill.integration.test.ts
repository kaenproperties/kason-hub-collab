/**
 * Task 6: bills-grid re-Bill supersede + paid-freeze pre-check (flag-gated).
 *
 * Money-critical. The amend→re-Bill path: a billed+invoiced entry whose amounts
 * were edited is re-Billed, superseding (CANCEL_AND_REPLACE) its prior live
 * tenant+owner invoices and reissuing from the amended amounts. Plus the PAID-
 * FREEZE pre-check: if ANY live invoice has a net-positive settled payment, the
 * re-Bill returns `paid_locked` in the PRE-LOCK block — nothing superseded,
 * billedAt untouched.
 *
 * Mirrors bill-issuance.integration.test.ts's fixture pattern: a dedicated,
 * fully-seeded org (never the shared dev seed), ENABLE_PHASE2_BILLING_DOCS
 * toggled per-test, ordered FK-safe cleanup.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/bill-rebill.integration.test.ts
 *
 * Coverage (behavior-inventory):
 *  • rebill-unpaid  — a billed entry with live UNPAID IVTEN+IVOWN, amend an amount,
 *                     Bill again → prior docs CANCELLED (superseded), fresh docs
 *                     ISSUED, outcome "reinvoiced".
 *  • second-rebill  — re-Bill a row ALREADY re-Billed once (its live invoice is a
 *                     replacement charge) → does NOT throw DOCUMENT_NOT_ISSUED
 *                     (proves the sourceGridEntryId re-stamp) → issues fresh.
 *  • paid-locked    — seed a real PaymentAllocation on a live invoice's charge →
 *                     Bill → outcome "paid_locked", billedAt unchanged, nothing
 *                     superseded, the paid invoice still ISSUED.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, createExpensesService, currentBillingMonthUTC, updateExpenseService, updateLinesService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace so cleanup is org-scoped + total.
const ORG = "b7600000-0000-4000-8000-000000000001";
const USER = "b7600000-0000-4000-8000-000000000002";
const PROP = "b7600000-0000-4000-8000-000000000003";
const APT = "b7600000-0000-4000-8000-000000000004";
const ROOM_A = "b7600000-0000-4000-8000-000000000005";
const ROOM_B = "b7600000-0000-4000-8000-000000000006";
const PARTY_A = "b7600000-0000-4000-8000-000000000007";
const PARTY_B = "b7600000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7600000-0000-4000-8000-000000000009";
const TEN_A = "b7600000-0000-4000-8000-00000000000a";
const TEN_B = "b7600000-0000-4000-8000-00000000000b";
const PAYMENT = "b7600000-0000-4000-8000-00000000000c";
// Fix pass 2 (occupancy fail-closed guard): a mid-period replacement occupant for ROOM_A.
const PARTY_C = "b7600000-0000-4000-8000-00000000000d";
const TEN_C = "b7600000-0000-4000-8000-00000000000e";

// CURRENT org-local month so the previous-period re-Bill guard allows these re-Bills.
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * A PARTITIONED apartment: TWO occupied rooms (each its own tenancy/party, pax 1)
 * + an owner party. Absorbed-TNB (owner-borne > 0) with a tenant-borne wifi pool
 * so a first Bill issues 2 IVTEN + 1 IVOWN. Returns the concurrency token.
 */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG6", slug: "bg6", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg6@example.test", fullName: "BG6 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B6", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B6", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/** Re-read the entry's current concurrency token (post-Bill / post-edit). */
async function tokenFor(): Promise<string> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  return e.updatedAt.toISOString();
}

/**
 * Amend the wifi (tenant-borne) pool DIRECTLY on the entry row (drafts write raw
 * amounts; this simulates a Save between two Bills). Bumps updatedAt so the next
 * Bill's expectedUpdatedAt token is fresh AND the entry is "edited since billedAt".
 */
async function amendWifi(newWifi: string): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi: newWifi } });
}

/**
 * RM0 fix fixture: amend BOTH tenant-borne pools (wifi + the recharged airSelangor) to
 * 0 so each occupied room's fresh tenant share computes to exactly RM0, while the
 * owner-borne side (absorbed TNB 300) is untouched. Simulates an admin editing the
 * tenant utilities down to nothing after a first Bill. Bumps updatedAt.
 */
async function amendTenantPoolToZero(): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi: "0.00", airSelangorRaw: "0.00" } });
}

/**
 * Fix pass 2: swap ROOM_A's occupant to a NEW party (PARTY_C / TEN_C) at the SAME
 * pax (1) and SAME amount (no amount edit at all) — simulating a mid-period tenant
 * hand-over after the invoice was already issued. Ends TEN_A, creates TEN_C, and
 * re-points ROOM_A's GridMeterReading to the new tenancy/party. Bumps the entry's
 * updatedAt (a no-amount touch) so the next Bill's expectedUpdatedAt token is fresh.
 * With amounts unchanged, the ONLY thing different is the occupant identity — so a
 * re-Bill that ignored occupancy would return `already_billed` (or reissue to the
 * departed PARTY_A); the guard must return `occupancy_changed` instead.
 */
async function swapRoomAOccupant(): Promise<void> {
  const db = getDb();
  await db.party.create({ data: { id: PARTY_C, organizationId: ORG, displayName: "Tenant C", partyType: "individual", status: "active" } });
  await db.tenancy.update({ where: { id: TEN_A }, data: { status: "ended" } });
  await db.tenancy.create({ data: { id: TEN_C, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_C, tenancyCode: "T-C", status: "active", billingStatus: "current", startDate: new Date("2026-06-15"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const reading = await db.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A } });
  await db.gridMeterReading.update({ where: { id: reading.id }, data: { tenancyId: TEN_C, partyId: PARTY_C } });
  // No-amount touch so the entry's @updatedAt (concurrency token) advances — Prisma
  // bumps @updatedAt on every update(), and re-setting lockedBy changes no money.
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { lockedBy: e.lockedBy } });
}

dn("bills-grid re-Bill supersede + paid-freeze (Task 6)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("rebill-unpaid: amend an amount + Bill again supersedes prior IVTEN+IVOWN and reissues, outcome reinvoiced", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → live IVTEN×2 + IVOWN.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const firstDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true } });
    const firstDocIds = new Set(firstDocs.map((d) => d.id));
    expect(firstDocIds.size).toBe(3);

    // Amend the wifi pool (raises the tenant split), then re-Bill.
    await amendWifi("240.00");
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("reinvoiced");
    expect(res.tenantInvoiceIds).toHaveLength(2);
    expect(res.ownerInvoiceIds).toHaveLength(1);

    // The three original docs are all CANCELLED (superseded).
    const originals = await db.billingDocument.findMany({ where: { id: { in: [...firstDocIds] } }, select: { id: true, documentStatus: true, supersededByDocumentId: true } });
    for (const d of originals) {
      expect(d.documentStatus).toBe("CANCELLED");
      expect(d.supersededByDocumentId).toBeTruthy();
    }
    // The fresh docs are ISSUED, distinct from the originals, and are the returned ids.
    const freshIds = [...(res.tenantInvoiceIds ?? []), ...(res.ownerInvoiceIds ?? [])];
    expect(freshIds).toHaveLength(3);
    for (const id of freshIds) expect(firstDocIds.has(id)).toBe(false);
    const fresh = await db.billingDocument.findMany({ where: { id: { in: freshIds } }, select: { id: true, documentStatus: true } });
    for (const d of fresh) expect(d.documentStatus).toBe("ISSUED");

    // Exactly 3 live (ISSUED) docs remain; the entry stays billed + invoiced.
    const live = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(live).toBe(3);
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.billedAt).not.toBeNull();
    expect(entry.invoicedAt).not.toBeNull();
  });

  it("rebill-amount-to-zero: a room whose fresh tenant share drops to RM0 is VOIDED (no RM0 invoice reissued); owner still reissues", async () => {
    // Regression lock for the final-money RM0 finding: the supersede loop must mirror
    // the first-issuance RM0 guard — a charge whose freshly-recomputed amount is 0 gets
    // its ORIGINAL invoice CANCELLED with NO replacement (never a spurious RM0 ISSUED
    // invoice in the tenant's register), and is omitted from the returned ids.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → 2 tenant IVTEN (>0) + 1 owner IVOWN.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const firstTenant = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED", counterpartyType: "tenant" }, select: { id: true } });
    expect(firstTenant).toHaveLength(2);
    const firstTenantIds = new Set(firstTenant.map((d) => d.id));

    // Amend BOTH tenant pools to 0 → each room's fresh tenant share is RM0 (owner-borne unchanged).
    await amendTenantPoolToZero();
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("reinvoiced");

    // RM0 tenant rooms are VOIDED, NOT reissued: no fresh tenant id returned…
    expect(res.tenantInvoiceIds ?? []).toHaveLength(0);
    // …the 2 original tenant docs are CANCELLED…
    const origTenant = await db.billingDocument.findMany({ where: { id: { in: [...firstTenantIds] } }, select: { documentStatus: true } });
    for (const d of origTenant) expect(d.documentStatus).toBe("CANCELLED");
    // …and NO new ISSUED tenant invoice exists (the RM0 bug would leave 2 RM0 IVTEN here).
    const liveTenant = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED", counterpartyType: "tenant" } });
    expect(liveTenant).toBe(0);

    // The owner side (owner-borne unchanged) still reissues normally: exactly 1 live doc.
    expect(res.ownerInvoiceIds).toHaveLength(1);
    const liveTotal = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(liveTotal).toBe(1);
  });

  it("second-rebill: re-Bill a row already re-Billed once does NOT hit DOCUMENT_NOT_ISSUED and issues fresh (proves the re-stamp)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // Bill → rebill once (the live charges are now replacements).
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    await amendWifi("240.00");
    const second = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.results[0].outcome).toBe("reinvoiced");

    // SECOND re-Bill: the live invoices are replacement charges. Without the
    // re-stamp of sourceGridEntryId onto the replacement, the live-charge lookup
    // would find only the CANCELLED original and cancelAndReplaceDocumentTx would
    // throw DOCUMENT_NOT_ISSUED → this row's save_failed.
    await amendWifi("360.00");
    const third = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const res = third.data.results[0];
    expect(res.outcome).toBe("reinvoiced"); // NOT save_failed
    expect(res.tenantInvoiceIds).toHaveLength(2);
    expect(res.ownerInvoiceIds).toHaveLength(1);

    // Exactly 3 live docs; all superseded generations are CANCELLED.
    const live = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(live).toBe(3);
    // Each live charge is (still) tagged to the entry — the re-stamp held. Post-Task-5
    // itemization the 3 live docs carry 5 COMPONENT charges (ROOM_A/ROOM_B each: water +
    // wifi = 4 tenant; owner: absorbed electricity = 1), NOT one charge per doc — so what
    // this proves is that EVERY live component (not a magic count) is tagged to the entry,
    // which is what mintItemizedCharges' sourceGridEntryId stamp guarantees on each re-mint.
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    const liveLines = await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED" } }, select: { chargeId: true } });
    const liveChargeIds = liveLines.map((l) => l.chargeId).filter((x): x is string => !!x);
    const liveCharges = await db.charge.findMany({ where: { id: { in: liveChargeIds } }, select: { sourceGridEntryId: true } });
    expect(liveCharges).toHaveLength(5);
    for (const c of liveCharges) expect(c.sourceGridEntryId).toBe(entry.id);
  });

  it("paid-blocked: a paid entry blocks re-Bill → rebill_blocked_payment_exists, nothing superseded/reversed", async () => {
    // Rule 4: ANY active tenant payment (partial or full) blocks the whole re-Bill; the
    // grid never reverses received money (accounting reversal is used instead). This test
    // settles every live grid charge, then confirms the re-Bill is denied.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → live docs.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    // Settle the WHOLE entry: one posted payment allocating EVERY live charge's full amount.
    const liveLines = await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED" } }, select: { chargeId: true } });
    const liveChargeIds = [...new Set(liveLines.map((l) => l.chargeId).filter((x): x is string => !!x))];
    const liveCharges = await db.charge.findMany({ where: { id: { in: liveChargeIds } }, select: { id: true, partyId: true, amount: true } });
    expect(liveCharges.length).toBeGreaterThanOrEqual(3);
    const total = liveCharges.reduce((s, c) => s + Number(c.amount), 0);
    await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B6-1", partyId: liveCharges[0].partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: total.toFixed(2), currency: "MYR", receivedAt: new Date() } });
    for (const c of liveCharges) {
      await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: c.id, allocatedAmount: c.amount, allocatedAt: new Date() } });
    }

    const entryBefore = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    const billedAtBefore = entryBefore.billedAt;

    // Amend + re-Bill → the fully-paid freeze fires BEFORE any supersede/reversal.
    await amendWifi("240.00");
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("rebill_blocked_payment_exists");

    // Nothing superseded/reversed: all 3 original docs still ISSUED; billedAt unchanged.
    const live = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(live).toBe(3);
    const cancelled = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } });
    expect(cancelled).toBe(0);
    const entryAfter = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entryAfter.billedAt?.getTime()).toBe(billedAtBefore?.getTime());
    expect(entryAfter.invoicedAt).not.toBeNull();
    // Every allocation still intact; nothing reversed.
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(liveCharges.length);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("expense + bearer writes: ALLOWED while billed-but-unpaid, REFUSED once money arrives (2026-08-17 unlock)", async () => {
    // Both halves of the new rule against ONE document-backed fixture. Before this change
    // the first half was impossible: createExpensesService and updateLinesService returned
    // 409 ENTRY_LOCKED the instant `billedAt` was stamped, so a late expense on a month
    // nobody had paid had nowhere to go. The guard now reads real payment — the same fact
    // re-Bill's own block reads — so "the write was accepted" implies "a re-Bill can carry it".
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();
    const key = { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } };

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    // ── Billed, no money yet → both writes ALLOWED (this is the unlock) ──
    const unpaidEntry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: key });
    const okLines = await updateLinesService(session, unpaidEntry.id, {
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
      expectedUpdatedAt: unpaidEntry.updatedAt.toISOString(),
    });
    expect(okLines.ok).toBe(true);
    const afterOpenLines = await db.unitBillsGridEntry.findUniqueOrThrow({ where: key });
    // Rolling deploy/stale-client defence: the wire schema still accepts the old
    // tenant values, but every new editable snapshot is canonicalized owner-only.
    expect(afterOpenLines.cleaningBearer).toBe("owner");
    expect(afterOpenLines.wifiBearer).toBe("owner");

    const okExpense = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "late repair", amount: "80.00", withSST: false }],
    });
    expect(okExpense.ok).toBe(true);
    if (!okExpense.ok) return;

    // updateExpenseService's guard moved too. Without this its ONLY coverage would be the
    // refusal below — a guard whose allowed direction is never exercised can be wrong in the
    // expensive direction (locked when it should not be) and no test would notice.
    const edited = await updateExpenseService(session, okExpense.data.ids[0], { amount: "95.00" });
    expect(edited.ok).toBe(true);
    expect(Number((await db.gridExpense.findUniqueOrThrow({ where: { id: okExpense.data.ids[0] } })).amount)).toBe(95);

    // ── Settle every live charge: money has now arrived ──
    const liveLines = await db.billingDocumentLine.findMany({
      where: { document: { organizationId: ORG, documentStatus: "ISSUED" } },
      select: { chargeId: true },
    });
    const liveChargeIds = [...new Set(liveLines.map((l) => l.chargeId).filter((x): x is string => !!x))];
    const liveCharges = await db.charge.findMany({ where: { id: { in: liveChargeIds } }, select: { id: true, partyId: true, amount: true } });
    expect(liveCharges.length).toBeGreaterThanOrEqual(3);
    const total = liveCharges.reduce((s, c) => s + Number(c.amount), 0);
    await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B6-LOCK", partyId: liveCharges[0].partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: total.toFixed(2), currency: "MYR", receivedAt: new Date() } });
    for (const c of liveCharges) {
      await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: c.id, allocatedAmount: c.amount, allocatedAt: new Date() } });
    }

    // ── Money present → both writes REFUSED, and nothing is written ──
    const expensesBefore = await db.gridExpense.count({ where: { organizationId: ORG } });
    const paidEntry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: key });

    const blockedExpense = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "too late", amount: "10.00", withSST: false }],
    });
    expect(blockedExpense.ok).toBe(false);
    if (!blockedExpense.ok) {
      expect(blockedExpense.status).toBe(409);
      expect(blockedExpense.error).toBe("ENTRY_LOCKED");
    }
    // The count assertion is the one that matters: a 409 with a stray row written would be
    // the money-relevant failure, and createExpensesService calls getOrCreateEntry first.
    expect(await db.gridExpense.count({ where: { organizationId: ORG } })).toBe(expensesBefore);

    const blockedLines = await updateLinesService(session, paidEntry.id, {
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
      expectedUpdatedAt: paidEntry.updatedAt.toISOString(),
    });
    expect(blockedLines.ok).toBe(false);
    if (!blockedLines.ok) {
      expect(blockedLines.status).toBe(409);
      expect(blockedLines.error).toBe("ENTRY_LOCKED");
    }
    const afterBlocked = await db.unitBillsGridEntry.findUniqueOrThrow({ where: key });
    expect(afterBlocked.cleaningBearer).toBe(paidEntry.cleaningBearer);
    expect(afterBlocked.wifiBearer).toBe(paidEntry.wifiBearer);
  });

  it("stale-atomicity: a re-Bill with a STALE expectedUpdatedAt supersedes NOTHING (relock precedes the loop; zero docs cancelled/minted)", async () => {
    // The CRITICAL fix (#1). A Prisma interactive $transaction COMMITS on a returned
    // value and rolls back ONLY on a throw — so if the supersede loop runs BEFORE the
    // stale relock, `return { outcome: "stale" }` would COMMIT N cancels + N reissues
    // while the caller is told "nothing happened, retry". The relock must run BEFORE
    // the loop (or throw), so a stale token leaves ZERO docs cancelled and ZERO fresh.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → 3 live docs.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    // Capture the CURRENT (post-Bill) token — this is what a client would hold.
    const staleToken = await tokenFor();

    // A concurrent Save lands: amend the wifi pool (a REAL edit → fresh amounts DIFFER
    // from live, so the supersede loop WOULD run) AND it bumps updatedAt, so the
    // staleToken captured above is now STALE.
    await amendWifi("240.00");

    // Re-Bill with the STALE token. Fresh amounts differ (loop is not idempotency-
    // short-circuited); the relock finds 0 rows.
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: staleToken, confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // stale OR save_failed (throw-fallback maps to save_failed) — either is a clean
    // "nothing committed" signal; a `reinvoiced` here would be the atomicity bug.
    expect(["stale", "save_failed"]).toContain(r.data.results[0].outcome);

    // THE INVARIANT: zero docs cancelled, still exactly 3 live (the originals), and
    // NO fresh docs were minted. Under the pre-fix order this FAILS (3 CANCELLED + 3
    // fresh committed despite the `stale` return).
    const cancelled = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } });
    expect(cancelled).toBe(0);
    const live = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(live).toBe(3);
    const totalDocs = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT } });
    expect(totalDocs).toBe(3); // no fresh docs minted at all

    // The entry's billedAt/invoicedAt are unchanged from the first Bill (the stale
    // relock wrote nothing). No re-stamped/credited replacement charges.
    const entry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entry.invoicedAt).not.toBeNull();
    const creditedCharges = await db.charge.count({ where: { organizationId: ORG, status: "credited" } });
    expect(creditedCharges).toBe(0);
  });

  it("unedited-no-op: re-Bill with NO intervening edit is a pure already_billed (zero supersede); an edited re-Bill still supersedes", async () => {
    // The IMPORTANT fix (#2): deterministic amount-based idempotency. An unedited
    // billed+invoiced entry re-Billed must be a no-op (`already_billed`) — no cancel,
    // no reissue — because every fresh amount equals its live charge's amount.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → 3 live docs.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const firstDocIds = new Set((await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true } })).map((d) => d.id));
    expect(firstDocIds.size).toBe(3);

    // Re-Bill with NO edit (fresh token, but amounts unchanged) → already_billed no-op.
    const noop = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.data.results[0].outcome).toBe("already_billed");

    // Nothing superseded, nothing minted: still exactly the SAME 3 ISSUED docs.
    const afterNoop = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true, documentStatus: true } });
    expect(afterNoop).toHaveLength(3);
    for (const d of afterNoop) {
      expect(d.documentStatus).toBe("ISSUED");
      expect(firstDocIds.has(d.id)).toBe(true); // the very same docs — no reissue
    }
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } })).toBe(0);

    // But an EDITED re-Bill still supersedes → reinvoiced (idempotency is NOT a freeze).
    await amendWifi("240.00");
    const edited = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.data.results[0].outcome).toBe("reinvoiced");
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } })).toBe(3);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
  });

  it("tenancy-swap-refused: a mid-period occupant change (same amount) fails closed → occupancy_changed, invoice UNCHANGED", async () => {
    // Fix pass 2 — the RED for the occupancy fail-closed guard. First Bill a
    // partitioned room to PARTY_A; swap that room's reading/tenancy to PARTY_C at the
    // SAME pax/amount; re-Bill. Under the pre-guard code the amount is identical, so
    // the amount-idempotency no-op returns `already_billed` (or the loop reissues to
    // the DEPARTED PARTY_A) — either way the live invoice stays billed to the wrong
    // party. The guard MUST refuse with `occupancy_changed` and write NOTHING.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    // First Bill → 3 live docs (IVTEN×2 + IVOWN). ROOM_A's tenant charge is billed to PARTY_A.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const firstDocIds = new Set((await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true } })).map((d) => d.id));
    expect(firstDocIds.size).toBe(3);

    // Capture ROOM_A's live tenant charge — it must stay billed to PARTY_A, untouched.
    const roomACharge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceGridEntryId: { not: null }, unitId: ROOM_A }, select: { id: true, partyId: true, tenancyId: true, amount: true } });
    expect(roomACharge.partyId).toBe(PARTY_A);
    const entryBefore = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    const billedAtBefore = entryBefore.billedAt;

    // Mid-period hand-over: ROOM_A now occupied by PARTY_C at the SAME pax/amount.
    await swapRoomAOccupant();

    // Re-Bill → the occupancy-change guard fires PRE-LOCK, before the no-op and the loop.
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("occupancy_changed"); // NOT already_billed, NOT reinvoiced

    // FAIL-CLOSED invariant: nothing written. Zero cancels, zero fresh docs — the same
    // 3 originals still ISSUED; billedAt unchanged; no credited/superseded charges.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT } })).toBe(3); // no fresh doc minted
    expect(await db.charge.count({ where: { organizationId: ORG, status: "credited" } })).toBe(0);

    // ROOM_A's live invoice is UNCHANGED — still billed to the DEPARTED PARTY_A (the
    // guard refused to touch it; it was NOT silently already_billed'd into a reissue,
    // and NOT reissued to the wrong party).
    const roomAAfter = await db.charge.findUniqueOrThrow({ where: { id: roomACharge.id }, select: { partyId: true, tenancyId: true, amount: true, status: true, sourceGridEntryId: true } });
    expect(roomAAfter.partyId).toBe(PARTY_A);
    expect(roomAAfter.tenancyId).toBe(TEN_A);
    expect(roomAAfter.status).not.toBe("credited");
    expect(roomAAfter.sourceGridEntryId).toBe(entryBefore.id);

    // billedAt unchanged (the guard returned pre-lock).
    const entryAfter = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
    expect(entryAfter.billedAt?.getTime()).toBe(billedAtBefore?.getTime());
    expect(entryAfter.invoicedAt).not.toBeNull();
  });
});
