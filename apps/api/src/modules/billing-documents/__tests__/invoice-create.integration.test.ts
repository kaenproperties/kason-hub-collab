/**
 * createManualInvoiceService — manual invoice create (P3 T5, R11). Real local
 * Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/invoice-create.integration.test.ts
 *
 * Seed pattern mirrors issue-for-charges.integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { createManualInvoiceService } from "../invoice-create.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "18181818-1818-4181-8181-181818181818";
let actorId = "";
let tenantPartyId = "";
let rentalCategoryId = "";
let managementCategoryId = "";
let apartmentId = "";
let listingId = "";

async function cleanOrg() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
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
      id: ORG, name: "P3 T5 Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  const actor = await db.user.create({
    data: {
      organizationId: ORG, email: `p3-t5-actor-${ORG}@test.local`, passwordHash: "x",
      fullName: "Actor", role: "admin", status: "active",
    },
  });
  actorId = actor.id;
  const party = await db.party.create({
    data: { organizationId: ORG, partyType: "tenant", displayName: "Tenant A", status: "active" },
  });
  tenantPartyId = party.id;
  const dep = await db.documentSeries.create({
    data: { organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  const rental = await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "rental", name: "Monthly rental", family: "pay_back_landlord",
      docType: "debit_note", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false,
      ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1,
    },
  });
  rentalCategoryId = rental.id;
  const management = await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "management_fee", name: "Property management fee", family: "owner_income",
      docType: "invoice", seriesId: dep.id, defaultSstRate: "8", eInvoiceEligible: true,
      ledgerCategory: "management_fee_income", isSystem: true, active: true, sortOrder: 2,
    },
  });
  managementCategoryId = management.id;
  const property = await db.property.create({
    data: {
      organizationId: ORG, name: "Profitability Condo", propertyCode: "PROFIT-C",
      propertyType: "Condominium", addressLine1: "1 Test Road", city: "Kuala Lumpur",
      country: "Malaysia", status: "active", publishStatus: "draft",
    },
  });
  const apartment = await db.apartment.create({
    data: { organizationId: ORG, propertyId: property.id, unitCode: "A-01-01", listingMode: "WHOLE" },
  });
  apartmentId = apartment.id;
  const listing = await db.listing.create({
    data: {
      organizationId: ORG, apartmentId: apartment.id, listingType: "Whole unit",
      occupancyStatus: "vacant", listingStatus: "active", currency: "MYR",
    },
  });
  listingId = listing.id;
}

dn("createManualInvoiceService", () => {
  beforeEach(async () => {
    await cleanOrg();
    await seed();
  });
  afterEach(async () => {
    await cleanOrg();
  });

  it("mints a posted charge + a debit_note document for a pay_back_landlord line", async () => {
    const db = getDb();
    const session = { orgId: ORG, userId: actorId, role: "accountant" };
    const res = await createManualInvoiceService(session, {
      counterpartyType: "tenant",
      partyId: tenantPartyId,
      billingMonth: "2026-07",
      lines: [{ description: "Manual rent", categoryId: rentalCategoryId, amount: "100.00" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.chargeIds).toHaveLength(1);
      const charge = await db.charge.findUnique({ where: { id: res.data.chargeIds[0] }, select: { status: true } });
      expect(charge?.status).toBe("posted");
      const doc = await db.billingDocument.findUnique({ where: { id: res.data.documents[0].id }, select: { docType: true } });
      expect(doc?.docType).toBe("debit_note");
    }
  });

  it("rolls back on an unknown category (no charge, no document)", async () => {
    const session = { orgId: ORG, userId: actorId, role: "accountant" };
    const before = await getDb().charge.count({ where: { organizationId: session.orgId } });
    const res = await createManualInvoiceService(session, {
      counterpartyType: "tenant",
      partyId: tenantPartyId,
      billingMonth: "2026-07",
      lines: [{ description: "x", categoryId: "00000000-0000-4000-8000-000000000000", amount: "10.00" }],
    });
    expect(res).toEqual({ ok: false, status: 400, error: "CATEGORY_NOT_FOUND" });
    const after = await getDb().charge.count({ where: { organizationId: session.orgId } });
    expect(after).toBe(before);
  });

  it("attributes a manual management fee to its whole unit and stamps manager revenue", async () => {
    const db = getDb();
    const session = { orgId: ORG, userId: actorId, role: "accountant" };
    const res = await createManualInvoiceService(session, {
      counterpartyType: "owner",
      partyId: tenantPartyId,
      apartmentId,
      billingMonth: "2026-07",
      lines: [{ description: "July management fee", categoryId: managementCategoryId, amount: "100.00" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const charge = await db.charge.findUnique({
      where: { id: res.data.chargeIds[0] },
      select: {
        unitId: true, nature: true, fundedBy: true, revenueRecognition: true,
        settlementRecipient: true, commercialPurpose: true, taxTreatment: true,
      },
    });
    expect(charge).toMatchObject({
      unitId: listingId,
      nature: "profit",
      fundedBy: "owner",
      revenueRecognition: "manager_revenue",
      settlementRecipient: "manager",
      commercialPurpose: "MANAGEMENT_FEE",
      taxTreatment: "taxable_service",
    });
    const document = await db.billingDocument.findUnique({
      where: { id: res.data.documents[0].id },
      select: { propertyId: true, apartmentId: true, listingId: true },
    });
    expect(document).toEqual(expect.objectContaining({ apartmentId, listingId }));
    expect(document?.propertyId).toBeTruthy();
  });
});
