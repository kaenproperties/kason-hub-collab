/**
 * issueStatementIvownDocumentTx — in-transaction IVOWN mint at statement
 * generate. Real local Postgres.
 * Run: RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run src/modules/billing-documents/__tests__/issue-ivown.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { issueStatementIvownDocumentTx } from "../issue.service";
import { generateStatementService } from "../../owner-billing/owner-billing.service";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

/** Helper: run the mint inside a fresh tx, the way generateStatementService does. */
async function mintIvownInTx(orgId: string, actorUserId: string, statementInvoiceId: string) {
  const db = getDb();
  await db.$transaction((tx) => issueStatementIvownDocumentTx(tx, orgId, actorUserId, statementInvoiceId));
}

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "18181818-1818-4181-8181-181818181818";
const PROP = "18180000-0000-4000-8000-000000000001";
const APT = "18180000-0000-4000-8000-000000000002";
const UNIT = "18180000-0000-4000-8000-000000000003";
let actorId = "";
let ownerPartyId = "";
let statementId = "";
let mgmtChargeId = "";
let cleaningChargeId = "";
let commissionChargeId = "";
let commissionSstChargeId = "";

async function cleanOrg() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.invoice.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.managementFeeConfig.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "IVOWN Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  const actor = await db.user.create({
    data: { organizationId: ORG, email: `ivown-actor-${ORG}@test.local`, passwordHash: "x", fullName: "Actor", role: "admin", status: "active" },
  });
  actorId = actor.id;
  const owner = await db.party.create({
    data: { organizationId: ORG, partyType: "owner", displayName: "Dato' Razak", status: "active" },
  });
  ownerPartyId = owner.id;
  // findOwnerInOrg (generateStatementService's org/ownership gate) requires a
  // PartyRole "owner" row, not just Party.partyType.
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: ownerPartyId, roleType: "owner", status: "active" },
  });
  const ivown = await db.documentSeries.create({
    data: { organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "management_fee", name: "Management fee", family: "owner_income",
      docType: "invoice", seriesId: ivown.id, defaultSstRate: "8", eInvoiceEligible: false,
      ledgerCategory: "management_fee", isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "cleaning_owner", name: "Cleaning (owner)", family: "owner_income",
      docType: "invoice", seriesId: ivown.id, defaultSstRate: "0", eInvoiceEligible: false,
      ledgerCategory: "cleaning", isSystem: true, active: true, sortOrder: 2,
    },
  });

  // Property/Apartment/Listing owned by the owner + an all-properties config
  // (sstPercent "8", matching ChargeCategory.defaultSstRate so the hand-seeded
  // 8%-based statement below and the config-sourced mint agree). The IVOWN mint
  // (issueStatementIvownDocumentTx) resolves the mgmt-fee SST rate via
  // resolveMgmtFeeSstRateByUnit(orgId, ownerPartyId, periodMonth), which needs a
  // resolvable {unit, config} pair to look up — without this fixture the mint
  // would (correctly) abort with IVOWN_SST_RATE_UNRESOLVED.
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "IVOWN Test Property", propertyCode: "IVOWN-P1",
      propertyType: "apartment", addressLine1: "1 Test St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-01-01", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit",
      occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId,
    },
  });
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId, propertyId: null, feeType: "percent",
      feeValue: "10", sstPercent: "8", isActive: true,
    },
  });

  const statement = await db.invoice.create({
    data: {
      organizationId: ORG, invoiceNumber: "OS-202607-testowner", partyId: ownerPartyId,
      ownerPartyId, invoiceType: "owner_statement", status: "draft", invoiceDate: new Date(),
      periodMonth: new Date("2026-07-01T00:00:00.000Z"), totalAmount: "1990.00", sstAmount: "20.00",
      currency: "MYR", idempotencyKey: `owner:${ownerPartyId}:2026-07-01`,
    },
    select: { id: true },
  });
  statementId = statement.id;
  const mkStmtCharge = (n: string, type: string, amount: string, description?: string) =>
    db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: n, partyId: ownerPartyId, chargeType: type, status: "draft",
        description,
        dueDate: new Date("2026-07-01T00:00:00.000Z"), amount, currency: "MYR", outstandingAmount: amount,
        attachmentKeys: [], invoiceId: statementId, billingMonth: new Date("2026-07-01T00:00:00.000Z"),
        unitId: UNIT,
      },
      select: { id: true },
    });
  mgmtChargeId = (await mkStmtCharge("OSC-202607-x-0001", "management_fee", "250.00")).id;
  cleaningChargeId = (await mkStmtCharge("OSC-202607-x-0002", "cleaning", "100.00")).id;
  commissionChargeId = (
    await mkStmtCharge("OSC-202607-x-0003", "letting_commission", "1500.00", "Legacy internal commission label")
  ).id;
  commissionSstChargeId = (
    await mkStmtCharge("OSC-202607-x-0004", "letting_commission_sst", "120.00", "Legacy internal SST label")
  ).id;
  // pass-through utility line — must be EXCLUDED from the IVOWN document
  await mkStmtCharge("OSC-202607-x-0005", "tnb", "42.00");
}

dn("issueStatementIvownDocumentTx — integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    await cleanOrg();
    await seed();
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("issues ONE IVOWN invoice with management, cleaning and exact owner Admin Fee + SST lines", async () => {
    await mintIvownInTx(ORG, actorId, statementId);
    const db = getDb();
    const docs = await db.billingDocument.findMany({ where: { organizationId: ORG }, include: { lines: true } });
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.documentNumber).toBe("IVOWN-0001");
    expect(doc.docType).toBe("invoice");
    expect(doc.counterpartyType).toBe("owner");
    expect(doc.partyId).toBe(ownerPartyId);
    expect(doc.statementInvoiceId).toBe(statementId);
    expect(doc.idempotencyKey).toBe(`ivown:owner:${ownerPartyId}:2026-07-01`);
    expect(doc.lines).toHaveLength(4); // mgmt + cleaning + Admin Fee + its flat SST, NOT tnb
    expect(doc.lines.map((l) => l.chargeId).sort()).toEqual(
      [mgmtChargeId, cleaningChargeId, commissionChargeId, commissionSstChargeId].sort(),
    );
    const byChargeId = new Map(doc.lines.map((line) => [line.chargeId, line]));
    const commission = byChargeId.get(commissionChargeId)!;
    const commissionSst = byChargeId.get(commissionSstChargeId)!;
    expect(commission.description).toBe("Admin Fee (First Month Rental)");
    expect(commission.amount.toString()).toBe("1500");
    expect(commission.sstRate.toString()).toBe("0");
    expect(commissionSst.description).toBe("SST on Admin Fee (First Month Rental)");
    expect(commissionSst.amount.toString()).toBe("120");
    expect(commissionSst.sstRate.toString()).toBe("0");
    const commissionCategory = await db.chargeCategory.findFirstOrThrow({
      where: { organizationId: ORG, code: "letting_commission" },
      select: { id: true },
    });
    const commissionSstCategory = await db.chargeCategory.findFirstOrThrow({
      where: { organizationId: ORG, code: "letting_commission_sst" },
      select: { id: true },
    });
    expect(commission.categoryId).toBe(commissionCategory.id);
    expect(commissionSst.categoryId).toBe(commissionSstCategory.id);
    expect(doc.subtotal.toString()).toBe("1970");
    expect(doc.sstAmount.toString()).toBe("20"); // owner's config sstPercent (8) applied to the 250 mgmt-fee base
    expect(doc.total.toString()).toBe("1990");
  });

  it("re-running the generate dedupes on the ivown: idempotency key", async () => {
    await mintIvownInTx(ORG, actorId, statementId);
    await mintIvownInTx(ORG, actorId, statementId);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // Failure injection note (2026-08-03): this used to force the failure by SQUATTING the next
  // IVOWN number, relying on @@unique(organizationId, documentNumber) to raise P2002. That is
  // no longer fatal — mintDocumentNumberTx now steps over numbers an existing document already
  // holds (see series-numbers.ts; a counter left behind by a partial restore made a unit
  // permanently unbillable). The squat case is asserted directly in the test below. The
  // invariant THIS test exists for — a mint that DOES fail must abort the caller's whole tx —
  // is unchanged, so it now injects a still-fatal mint failure: no IVOWN series to resolve.
  it("a failing mint aborts the caller's tx — companion writes roll back (spec §4.6)", async () => {
    const db = getDb();
    // Strip the management-fee charge's unit, so the per-unit SST rate cannot resolve and the
    // mint aborts with IVOWN_SST_RATE_UNRESOLVED — the §4.6 "never guess an SST rate that could
    // disagree with Invoice.sstAmount" path. Chosen over deleting or renaming the IVOWN series
    // because `ensureChargeCategorySeeds` re-creates series and categories (create-only) on the
    // way in, healing either injection before the mint is ever reached.
    await db.charge.update({ where: { id: mgmtChargeId }, data: { unitId: null } });

    await expect(
      db.$transaction(async (tx) => {
        // Simulate the generate tx: a companion write that must vanish with the rollback.
        await tx.invoice.update({ where: { id: statementId }, data: { totalAmount: "999.99" } });
        await issueStatementIvownDocumentTx(tx, ORG, actorId, statementId);
      }),
    ).rejects.toThrow("IVOWN_SST_RATE_UNRESOLVED"); // propagates — nothing swallowed
    // Nothing issued, and the companion write rolled back.
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: statementId }, select: { totalAmount: true } });
    expect(inv.totalAmount.toString()).not.toBe("999.99");
  });

  // REGRESSION (2026-08-03, reported as A-01-02 "couldn't issue the invoice"): a document
  // occupying the number the counter is about to hand out must NOT kill the issue. It used to
  // raise P2002 inside the caller's tx — for the bills-grid that rolled the whole Bill back as
  // an uncoded `save_failed`, and retrying could never help because the counter increment rolled
  // back too. The mint skips the taken number instead; the document issues on the next free one.
  it("a squatted document number is skipped, not fatal — the mint moves to the next free number", async () => {
    const db = getDb();
    const ivownSeries = await db.documentSeries.findFirstOrThrow({
      where: { organizationId: ORG, code: "IVOWN" },
      select: { id: true },
    });
    await db.billingDocument.create({
      data: {
        organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-0001",
        seriesId: ivownSeries.id, issuedById: actorId, counterpartyType: "owner",
        partyId: ownerPartyId, subtotal: "1.00", sstAmount: "0", total: "1.00",
        idempotencyKey: "squatter",
      },
    });

    await mintIvownInTx(ORG, actorId, statementId);

    const issued = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, statementInvoiceId: statementId },
      select: { documentNumber: true },
    });
    expect(issued.documentNumber).toBe("IVOWN-0002");
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(2);
  });

  it("statement with no income lines mints nothing", async () => {
    const db = getDb();
    await db.charge.deleteMany({
      where: {
        organizationId: ORG,
        chargeType: { in: ["management_fee", "cleaning", "letting_commission", "letting_commission_sst"] },
      },
    });
    await mintIvownInTx(ORG, actorId, statementId);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("flag dark → early-return, no documents", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await mintIvownInTx(ORG, actorId, statementId);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("non-default sstPercent (6%): generateStatementService's IVOWN mint sstAmount equals Invoice.sstAmount, and totals foot", async () => {
    const db = getDb();
    // Own month (2026-08), independent of the hand-seeded 2026-07 statement
    // above — a fresh idempotency slot for a REAL generateStatementService run.
    const billingMonth = "2026-08";

    // Occupy the unit (mgmt fee only charges an active tenancy) and set this
    // owner's config to a NON-default 6% SST. This is exactly the finding's
    // scenario: at the seeded 8% default the old (ChargeCategory.defaultSstRate)
    // and the correct (per-owner config) mechanisms coincidentally agree; at 6%
    // they would diverge if the IVOWN mint still read the category default.
    const tenant = await db.party.create({
      data: { organizationId: ORG, partyType: "individual", displayName: "IVOWN Test Tenant", status: "active" },
    });
    await db.tenancy.create({
      data: {
        organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: tenant.id,
        tenancyCode: "T-IVOWN-01", status: "active", billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000.00",
      },
    });
    await db.managementFeeConfig.updateMany({
      where: { organizationId: ORG, ownerPartyId },
      data: { sstPercent: "6" },
    });

    const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: actorId, actorRole: "admin" };
    const result = await generateStatementService(ctx, { ownerPartyId, billingMonth });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("generateStatementService did not return ok:true");

    // mgmt base = 10% of 1000 rent = 100.00; SST = 6% of 100 = 6.00 (NOT 8.00);
    // cleaning = 100.00 (seeded cleaning charge, no SST); no pass-through lines
    // this month → totalAmount = 100 + 100 + 6 = 206.
    const inv = await db.invoice.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { sstAmount: true, totalAmount: true },
    });
    expect(inv.sstAmount?.toString()).toBe("6");
    expect(inv.totalAmount.toString()).toBe("206");

    const doc = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, statementInvoiceId: result.data.id },
      include: { lines: true },
    });
    expect(doc.lines).toHaveLength(2); // mgmt + cleaning
    expect(doc.subtotal.toString()).toBe("200"); // 100 mgmt base + 100 cleaning
    expect(doc.sstAmount.toString()).toBe("6"); // sourced from the owner's config (6%), not defaultSstRate (8%)
    expect(doc.total.toString()).toBe("206");

    // The mirroring invariant the finding required: the document foots with the
    // statement it mirrors, for a non-default sstPercent.
    expect(doc.sstAmount.toString()).toBe(inv.sstAmount?.toString());
    expect(doc.total.toString()).toBe(inv.totalAmount.toString());
  });
});
