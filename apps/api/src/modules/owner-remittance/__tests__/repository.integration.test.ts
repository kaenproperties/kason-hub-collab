/**
 * Task 5 integration tests — owner-remittance repository (real Postgres).
 *
 * Proves the 6 repository functions: lockOwnerPayable, computeAvailableOwnerPayableC,
 * findEntryByIdempotency, insertPayoutEntry, insertRemittanceAllocations,
 * periodRemainingPayableC.
 *
 * Local-DB safety guard mirrors owner-ledger.sync.concurrency.test.ts:28-37 — refuses
 * to run against any non-localhost DATABASE_URL host.
 *
 * Isolation: a FIXED DISJOINT ORG uuid (15-prefix — grep-verified absent from every
 * other integration suite in this repo at authoring time), per-test clean+seed of
 * ONLY this suite's own rows. B11 additionally seeds a second, throwaway "foreign"
 * organization to prove cross-org isolation on periodRemainingPayableC; its rows are
 * swept by the same cleanup() (added to the delete list below) so no special-casing
 * is needed in beforeEach/afterAll.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/repository.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import {
  lockOwnerPayable,
  computeAvailableOwnerPayableC,
  findEntryByIdempotency,
  insertPayoutEntry,
  insertRemittanceAllocations,
  periodRemainingPayableC,
} from "../owner-remittance.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration tests must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from all other integration test suites (grep-verified: no
// existing suite in this repo uses the "15" prefix as of authoring this file).
const ORG = "15000000-0000-4000-8000-0000000000a1";
// createdById/updatedById sentinel — grep-verified a PLAIN column on both
// OwnerLedgerEntry and OwnerRemittanceAllocation (no FK to User), so no real User
// row is required (matches the (C2-c) precedent in owner-ledger.sync.concurrency.test.ts).
const ACTOR = "15000000-0000-4000-8000-0000000000a2";
const OWNER = "15000000-0000-4000-8000-0000000000a4";
const OWNER2 = "15000000-0000-4000-8000-0000000000a5"; // B13 cross-owner isolation
const PROPERTY = "15000000-0000-4000-8000-0000000000a6";
const APARTMENT = "15000000-0000-4000-8000-0000000000a7";
const LISTING = "15000000-0000-4000-8000-0000000000a8";
const TENANT = "15000000-0000-4000-8000-0000000000a9";
const TENANCY = "15000000-0000-4000-8000-0000000000aa";
// A second, throwaway ORGANIZATION for B11's cross-org rejection proof. OwnerStatementPeriod
// DOES carry a real FK to Organization (unlike OwnerLedgerEntry's plain columns), so this
// needs a genuine row, not just a UUID literal.
const OTHER_ORG = "15000000-0000-4000-8000-0000000000c1";

const EFFECTIVE_DATE = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  const otherOrg = { organizationId: OTHER_ORG };
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  // Symmetric OTHER_ORG deletes (same FK-safe order as ORG above) — OTHER_ORG
  // today only ever gets an Organization + OwnerStatementPeriod row (B11), but
  // a future test that also seeds an OTHER_ORG ledger/allocation row must not
  // FK-fail or leak rows across test runs.
  await db.ownerRemittanceAllocation.deleteMany({ where: otherOrg });
  await db.ownerLedgerEntry.deleteMany({ where: otherOrg });
  await db.ownerStatementPeriod.deleteMany({ where: otherOrg });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.organization.deleteMany({ where: { id: OTHER_ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T5 Repository Org",
      slug: "t5-repository-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "T5 Owner", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "T5 Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "T5 Property",
      propertyCode: "T5-P1",
      propertyType: "apartment",
      addressLine1: "1 T5 St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "T5-A-01",
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: LISTING,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "whole_unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER,
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitId: LISTING,
      tenantPartyId: TENANT,
      tenancyCode: "T5-TEN-1",
      startDate: EFFECTIVE_DATE,
      endDate: new Date(Date.UTC(2027, 6, 14)),
      monthlyRentAmount: "1000.00",
      billingStatus: "active",
      status: "active",
    },
  });
}

/** Raw-seed an active OwnerLedgerEntry row — for shapes outside the 6 SUT functions
 *  (income/expense rows aren't payouts; reversal rows are Task 9's writer, which
 *  doesn't exist yet — this simulates its shape so the reversal-aware READ side can
 *  be proven independently of the not-yet-built reversal WRITE side). */
function ledgerRowData(
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> &
    Pick<Prisma.OwnerLedgerEntryUncheckedCreateInput, "direction" | "category" | "amount">,
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    statementMonth: EFFECTIVE_DATE,
    transactionDate: EFFECTIVE_DATE,
    paidBy: "kaen",
    status: "active",
    createdById: ACTOR,
    updatedById: ACTOR,
    ...overrides,
  };
}

async function seedIncomeRow(amount: string, category = "rental_income", sstAmount: string | null = null) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category, amount, sstAmount }),
  });
}

async function seedExpenseRow(amount: string, includeInPayout: boolean, sstAmount: string | null = null) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({
      direction: "expense",
      category: includeInPayout ? "management_fee" : "quit_rent",
      amount,
      sstAmount,
      includeInPayout,
    }),
  });
}

async function seedReversalRow(originalId: string, amount: string, idempotencyKey: string) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({
      direction: "payout",
      category: "owner_payout",
      amount,
      includeInPayout: false,
      settlementKind: "OWNER_REMITTANCE",
      idempotencyKey,
      reversalOfEntryId: originalId,
    }),
  });
}

dn("owner-remittance.repository — Task 5 integration", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── computeAvailableOwnerPayableC ─────────────────────────────────────────

  it("(B1) computes available payable — income minus active payout, GC3 locked-tx", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");

    const availableC = await db.$transaction(async (tx) => {
      await lockOwnerPayable(tx, ORG, OWNER);
      const payout = await insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b1-payout",
        requestFingerprint: "b1-fingerprint",
        createdById: ACTOR,
        updatedById: ACTOR,
      });
      expect(payout.id).toBeTruthy();
      return computeAvailableOwnerPayableC(tx, ORG, OWNER);
    });

    expect(availableC).toBe(60000);
  });

  it("(B2) an active reversal on the payout restores available payable", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");

    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b2-payout",
        requestFingerprint: "b2-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );
    await seedReversalRow(payout.id, "400.00", "b2-reversal");

    const availableC = await db.$transaction(async (tx) => {
      await lockOwnerPayable(tx, ORG, OWNER);
      return computeAvailableOwnerPayableC(tx, ORG, OWNER);
    });

    expect(availableC).toBe(100000);
  });

  it("(B8) zero rows ⇒ zero available payable", async () => {
    const availableC = await getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
    expect(availableC).toBe(0);
  });

  it("includes deposits collected for onward transfer in the owner's available payable", async () => {
    const db = getDb();
    await seedIncomeRow("483.87");
    await seedExpenseRow("51.84", true);
    await db.deposit.create({
      data: {
        organizationId: ORG,
        tenancyId: TENANCY,
        partyId: TENANT,
        unitId: LISTING,
        type: "utilities",
        amount: "514.95",
        status: "released_to_owner",
      },
    });

    const availableC = await db.$transaction((tx) =>
      computeAvailableOwnerPayableC(tx, ORG, OWNER),
    );

    // RM483.87 rent - RM51.84 fee + RM514.95 deposit transfer = RM946.98.
    expect(availableC).toBe(94_698);
  });

  it("does not leak another owner's collected deposit into payable", async () => {
    const db = getDb();
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG, displayName: "T5 Owner 2", partyType: "individual", status: "active" },
    });
    await db.listing.update({ where: { id: LISTING }, data: { ownerPartyId: OWNER2 } });
    await db.deposit.create({
      data: {
        organizationId: ORG,
        tenancyId: TENANCY,
        partyId: TENANT,
        unitId: LISTING,
        type: "rental",
        amount: "500.00",
        status: "released_to_owner",
      },
    });

    const availableC = await db.$transaction((tx) =>
      computeAvailableOwnerPayableC(tx, ORG, OWNER),
    );

    expect(availableC).toBe(0);
  });

  it("(B13) does not leak a different owner's rows into payable", async () => {
    const db = getDb();
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG, displayName: "T5 Owner 2", partyType: "individual", status: "active" },
    });
    await seedIncomeRow("1000.00"); // OWNER
    await db.ownerLedgerEntry.create({
      data: ledgerRowData({
        ownerPartyId: OWNER2,
        direction: "income",
        category: "rental_income",
        amount: "500.00",
      }),
    });

    const availableC = await db.$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));

    expect(availableC).toBe(100000); // 1000.00 only — OWNER2's 500.00 must not leak in
  });

  it("(B16) computes payable correctly across mixed income/expense/SST/payout lines", async () => {
    const db = getDb();
    // income 1000.00 + sst 60.00 = 1060.00 credited
    await seedIncomeRow("1000.00", "rental_income", "60.00");
    // expense 200.00 + sst 12.00 = 212.00, includeInPayout:true ⇒ deducted
    await seedExpenseRow("200.00", true, "12.00");
    // expense 150.00, includeInPayout:false ⇒ owner-paid-direct, NOT deducted
    await seedExpenseRow("150.00", false, null);
    // payout 300.00 (no reversal) ⇒ deducted
    await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "300.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "cash",
        idempotencyKey: "b16-payout",
        requestFingerprint: "b16-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    // 106000 − 21200 − 30000 = 54800 (the excluded 150.00 expense never enters the sum)
    const availableC = await db.$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));

    expect(availableC).toBe(54800);
  });

  it("(B19) documents double-reversal double-restore behavior (known asymmetry — Task 9's ALREADY_REVERSED guard is what prevents this in practice; this repository's read side does not itself defend against it)", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "cash",
        idempotencyKey: "b19-payout",
        requestFingerprint: "b19-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );
    await seedReversalRow(payout.id, "400.00", "b19-reversal-1");
    await seedReversalRow(payout.id, "400.00", "b19-reversal-2");

    const availableC = await db.$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));

    // 1000 − 400 + 400 + 400 = 1400.00 — each active reversal independently restores.
    expect(availableC).toBe(140000);
  });

  // ── periodRemainingPayableC ────────────────────────────────────────────────

  it("(B3) period remaining payable subtracts one active allocation", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b3-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "200.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b3-payout",
        requestFingerprint: "b3-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    const remainingC = await db.$transaction(async (tx) => {
      await insertRemittanceAllocations(
        tx,
        ORG,
        payout.id,
        [{ ownerStatementPeriodId: period.id, allocatedAmountC: 20000 }],
        ACTOR,
      );
      return periodRemainingPayableC(tx, ORG, period.id);
    });

    expect(remainingC).toBe(30000);
  });

  it("(B4) a reversed parent payout excludes its allocation", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b4-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "200.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b4-payout",
        requestFingerprint: "b4-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );
    await db.$transaction((tx) =>
      insertRemittanceAllocations(
        tx,
        ORG,
        payout.id,
        [{ ownerStatementPeriodId: period.id, allocatedAmountC: 20000 }],
        ACTOR,
      ),
    );
    await seedReversalRow(payout.id, "200.00", "b4-reversal");

    const remainingC = await db.$transaction((tx) => periodRemainingPayableC(tx, ORG, period.id));

    expect(remainingC).toBe(50000);
  });

  it("(B20) a directly-voided parent payout excludes its allocation (no reversal row) — must agree with computeAvailableOwnerPayableC", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b20-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "200.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b20-payout",
        requestFingerprint: "b20-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );
    await db.$transaction((tx) =>
      insertRemittanceAllocations(
        tx,
        ORG,
        payout.id,
        [{ ownerStatementPeriodId: period.id, allocatedAmountC: 20000 }],
        ACTOR,
      ),
    );
    // Directly void the parent payout — the pre-existing Phase-1 manual-void
    // endpoint's path (status flip only, NO reversal row created). This is the
    // bug this test pins: computeAvailableOwnerPayableC already excludes
    // status:"void" rows and frees this money at the owner level, so
    // periodRemainingPayableC must also exclude this allocation, or the two
    // money reads diverge (period would wrongly report 30000 remaining while
    // the owner ledger says the full 50000 is available again).
    await db.ownerLedgerEntry.update({ where: { id: payout.id }, data: { status: "void" } });

    const remainingC = await db.$transaction((tx) => periodRemainingPayableC(tx, ORG, period.id));

    expect(remainingC).toBe(50000);
  });

  it("(B11) rejects a period belonging to a different organization", async () => {
    const db = getDb();
    await db.organization.create({
      data: {
        id: OTHER_ORG,
        name: "T5 Foreign Org",
        slug: "t5-foreign-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    const foreignPeriod = await db.ownerStatementPeriod.create({
      data: {
        organizationId: OTHER_ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 999900,
        idempotencyKey: "b11-foreign-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });

    // Calling with ORG (not OTHER_ORG) must NOT resolve the foreign period.
    await expect(
      db.$transaction((tx) => periodRemainingPayableC(tx, ORG, foreignPeriod.id)),
    ).rejects.toThrow();
  });

  it("(B12) zero allocations ⇒ full netPayoutC, no NaN", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b12-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });

    const remainingC = await db.$transaction((tx) => periodRemainingPayableC(tx, ORG, period.id));

    expect(remainingC).toBe(50000);
    expect(Number.isNaN(remainingC)).toBe(false);
  });

  // ── findEntryByIdempotency ─────────────────────────────────────────────────

  it("(B5) returns the matching entry's id + fingerprint", async () => {
    const db = getDb();
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "100.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "cash",
        idempotencyKey: "b5-key",
        requestFingerprint: "b5-fingerprint-abc",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    const found = await db.$transaction((tx) => findEntryByIdempotency(tx, ORG, "OWNER_REMITTANCE", "b5-key"));

    expect(found).toEqual({ id: payout.id, requestFingerprint: "b5-fingerprint-abc" });
  });

  it("(B6) returns null for an unknown key", async () => {
    const found = await getDb().$transaction((tx) =>
      findEntryByIdempotency(tx, ORG, "OWNER_REMITTANCE", "no-such-key"),
    );
    expect(found).toBeNull();
  });

  it("(B7) does not cross-match a different settlementKind", async () => {
    const db = getDb();
    await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "100.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "cash",
        idempotencyKey: "b7-shared-key",
        requestFingerprint: "b7-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    const found = await db.$transaction((tx) =>
      findEntryByIdempotency(tx, ORG, "PRE_STATEMENT_REMITTANCE", "b7-shared-key"),
    );

    expect(found).toBeNull();
  });

  it("(B14) still matches a voided payout row", async () => {
    const db = getDb();
    // Raw-seeded (not via insertPayoutEntry) so this test's setup is independent of
    // that function's own correctness — this test is specifically about
    // findEntryByIdempotency's status-agnostic read.
    const seeded = await db.ownerLedgerEntry.create({
      data: ledgerRowData({
        direction: "payout",
        category: "owner_payout",
        amount: "250.00",
        includeInPayout: false,
        settlementKind: "OWNER_REMITTANCE",
        idempotencyKey: "b14-key",
        requestFingerprint: "b14-fp",
      }),
    });
    await db.ownerLedgerEntry.update({ where: { id: seeded.id }, data: { status: "void" } });

    const found = await db.$transaction((tx) => findEntryByIdempotency(tx, ORG, "OWNER_REMITTANCE", "b14-key"));

    expect(found).toEqual({ id: seeded.id, requestFingerprint: "b14-fp" });
  });

  // ── insertPayoutEntry ──────────────────────────────────────────────────────

  it("(B9) writes the spec-mandated payout row shape", async () => {
    const db = getDb();
    const result = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        amount: "75.50",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "b9-key",
        requestFingerprint: "b9-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    const row = await db.ownerLedgerEntry.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    expect(row?.direction).toBe("payout");
    expect(row?.category).toBe("owner_payout");
    expect(row?.paidBy).toBe("kaen");
    expect(row?.includeInPayout).toBe(false);
    expect(row?.taxCategory).toBe("not_applicable");
    expect(row?.status).toBe("active");
    expect(row?.settlementKind).toBe("OWNER_RECEIVABLE_OFFSET");
    // Prisma's Decimal.toString() strips trailing zeros — established, verified
    // convention throughout this codebase's tests (e.g. owner-ledger.sync.test.ts:
    // amount.toString() === "1000" not "1000.00", "300" not "300.00"). The DB
    // column itself is still NUMERIC(12,2) — 75.50 is stored and settles
    // identically to 75.5; this is a JS-side string-formatting fact, not a
    // precision loss.
    expect(row?.amount.toString()).toBe("75.5");
    expect(row?.organizationId).toBe(ORG);
    expect(row?.ownerPartyId).toBe(OWNER);
    expect(row?.propertyId).toBe(PROPERTY);
    expect(row?.idempotencyKey).toBe("b9-key");
    expect(row?.requestFingerprint).toBe("b9-fp");
    expect(row?.reversalOfEntryId).toBeNull();
    expect(row?.paymentMethod).toBeNull(); // not supplied — offsets carry none (R8)
    expect(row?.transactionDate.toISOString().slice(0, 10)).toBe("2026-07-15");
    expect(row?.statementMonth.toISOString().slice(0, 10)).toBe("2026-07-01");
  });

  it("(B15) derives statementMonth correctly at month boundaries", async () => {
    const db = getDb();
    const lastDayOfJuly = new Date(Date.UTC(2026, 6, 31));
    const firstDayOfJan = new Date(Date.UTC(2026, 0, 1));

    const r1 = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "10.00",
        effectiveDate: lastDayOfJuly,
        idempotencyKey: "b15-last-day",
        requestFingerprint: "b15-fp-1",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );
    const r2 = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "10.00",
        effectiveDate: firstDayOfJan,
        idempotencyKey: "b15-first-day",
        requestFingerprint: "b15-fp-2",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    const row1 = await db.ownerLedgerEntry.findUnique({ where: { id: r1.id } });
    const row2 = await db.ownerLedgerEntry.findUnique({ where: { id: r2.id } });

    expect(row1?.statementMonth.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(row1?.transactionDate.toISOString().slice(0, 10)).toBe("2026-07-31");
    expect(row2?.statementMonth.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(row2?.transactionDate.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("(B21) Task 6a: propertyId:null is stored/read back as null and computeAvailableOwnerPayableC counts it exactly once", async () => {
    const db = getDb();
    await seedIncomeRow("1000.00");

    // SAME numbers as B1 (income 1000.00, payout 400.00 ⇒ 60000 available) but
    // with propertyId:null instead of PROPERTY — proves the owner-level payout
    // reduces payable through the IDENTICAL path a property-attributed payout
    // does. computeAvailableOwnerPayableC never reads propertyId at all (it maps
    // rows through rowToLedgerLine → OwnerLedgerLine, which carries no propertyId
    // field), so "exactly once" here is really "not silently dropped" — a bug
    // would show as 100000 (payout ignored), not 120000 (double-subtracted).
    const { payoutId, availableC } = await db.$transaction(async (tx) => {
      await lockOwnerPayable(tx, ORG, OWNER);
      const payout = await insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: null,
        settlementKind: "OWNER_REMITTANCE",
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        paymentMethod: "bank_transfer",
        idempotencyKey: "b21-payout",
        requestFingerprint: "b21-fingerprint",
        createdById: ACTOR,
        updatedById: ACTOR,
      });
      const availableC = await computeAvailableOwnerPayableC(tx, ORG, OWNER);
      return { payoutId: payout.id, availableC };
    });

    // Stored + read back as null — a fresh, independent read outside the writing
    // transaction, not just the in-memory create() result. Not coerced to a
    // nil-UUID sentinel or any other placeholder.
    const row = await db.ownerLedgerEntry.findUnique({ where: { id: payoutId } });
    expect(row?.propertyId).toBeNull();

    // Counted exactly once: 1000.00 − 400.00 = 600.00 (byte-identical formula to B1).
    expect(availableC).toBe(60000);
  });

  // ── insertRemittanceAllocations ────────────────────────────────────────────

  it("(B10) writes allocation rows with correct FKs and amounts", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b10-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "200.00",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "b10-payout",
        requestFingerprint: "b10-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    await db.$transaction((tx) =>
      insertRemittanceAllocations(
        tx,
        ORG,
        payout.id,
        [{ ownerStatementPeriodId: period.id, allocatedAmountC: 20000 }],
        ACTOR,
      ),
    );

    const rows = await db.ownerRemittanceAllocation.findMany({
      where: { organizationId: ORG, payoutEntryId: payout.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerStatementPeriodId).toBe(period.id);
    expect(rows[0]?.allocatedAmountC).toBe(20000);
    expect(rows[0]?.createdById).toBe(ACTOR);
  });

  it("(B17) writes multiple periods' allocations in one call", async () => {
    const db = getDb();
    const periodA = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 10000,
        idempotencyKey: "b17-period-a",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const periodB = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: new Date(Date.UTC(2026, 7, 1)),
        netPayoutC: 20000,
        idempotencyKey: "b17-period-b",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "300.00",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "b17-payout",
        requestFingerprint: "b17-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    await db.$transaction((tx) =>
      insertRemittanceAllocations(
        tx,
        ORG,
        payout.id,
        [
          { ownerStatementPeriodId: periodA.id, allocatedAmountC: 10000 },
          { ownerStatementPeriodId: periodB.id, allocatedAmountC: 20000 },
        ],
        ACTOR,
      ),
    );

    const rows = await db.ownerRemittanceAllocation.findMany({
      where: { organizationId: ORG, payoutEntryId: payout.id },
      orderBy: { allocatedAmountC: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ownerStatementPeriodId).toBe(periodA.id);
    expect(rows[0]?.allocatedAmountC).toBe(10000);
    expect(rows[1]?.ownerStatementPeriodId).toBe(periodB.id);
    expect(rows[1]?.allocatedAmountC).toBe(20000);
  });

  it("(B18) rejects a duplicate period within one batch", async () => {
    const db = getDb();
    const period = await db.ownerStatementPeriod.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: EFFECTIVE_DATE,
        netPayoutC: 50000,
        idempotencyKey: "b18-period",
        sourceMaxUpdatedAt: EFFECTIVE_DATE,
      },
    });
    const payout = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "200.00",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "b18-payout",
        requestFingerprint: "b18-fp",
        createdById: ACTOR,
        updatedById: ACTOR,
      }),
    );

    await expect(
      db.$transaction((tx) =>
        insertRemittanceAllocations(
          tx,
          ORG,
          payout.id,
          [
            { ownerStatementPeriodId: period.id, allocatedAmountC: 10000 },
            { ownerStatementPeriodId: period.id, allocatedAmountC: 5000 },
          ],
          ACTOR,
        ),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  // ── redesign P1: REM- remittance display numbering ──────────────────────────

  it("(P1) writes remittanceNumber when the caller supplies one; defaults null when omitted", async () => {
    const db = getDb();
    const numbered = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_REMITTANCE",
        amount: "80.00",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "p1-numbered",
        requestFingerprint: "p1-fp-numbered",
        createdById: ACTOR,
        updatedById: ACTOR,
        remittanceNumber: "REM-0001",
      }),
    );
    const unnumbered = await db.$transaction((tx) =>
      insertPayoutEntry(tx, {
        orgId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        amount: "40.00",
        effectiveDate: EFFECTIVE_DATE,
        idempotencyKey: "p1-unnumbered",
        requestFingerprint: "p1-fp-unnumbered",
        createdById: ACTOR,
        updatedById: ACTOR,
        // remittanceNumber intentionally omitted — offsets are never numbered.
      }),
    );

    const numberedRow = await db.ownerLedgerEntry.findUnique({ where: { id: numbered.id } });
    const unnumberedRow = await db.ownerLedgerEntry.findUnique({ where: { id: unnumbered.id } });
    expect(numberedRow?.remittanceNumber).toBe("REM-0001");
    expect(unnumberedRow?.remittanceNumber).toBeNull();
  });
});
