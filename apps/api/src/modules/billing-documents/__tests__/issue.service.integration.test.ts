/**
 * issueDocumentTx — transactional issuance core. Real local Postgres.
 * Run: RUN_INTEGRATION=1 npx vitest run src/modules/billing-documents/__tests__/issue.service.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx, DocumentReferenceRequiredError, type IssueDocumentInput } from "../issue.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "13131313-1313-4131-8131-131313131313";
const ACTOR = "14141414-1414-4141-8141-141414141414";
const PARTY = "15151515-1515-4151-8151-151515151515";
const CHARGE = "16161616-1616-4161-8161-161616161616";

let depSeriesId = "";
let cnSeriesId = "";
let rentalCategoryId = "";

async function cleanOrg() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
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
      id: ORG, name: "Issue Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK → User.id (onDelete: Restrict): acting user must exist
  // (recordAudit writes actorUserId = ACTOR — same precedent as
  // utility-billing-config/__tests__/config.integration.test.ts).
  await db.user.create({
    data: {
      id: ACTOR, organizationId: ORG, email: "issuetest@example.test", fullName: "Issue Test Actor",
      status: "active", role: "admin", userType: "operator",
    },
  });
  const dep = await db.documentSeries.create({
    data: { organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  depSeriesId = dep.id;
  const cn = await db.documentSeries.create({
    data: { organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  cnSeriesId = cn.id;
  const rental = await db.chargeCategory.create({
    data: {
      organizationId: ORG, code: "rental", name: "Monthly rental", family: "pay_back_landlord",
      docType: "debit_note", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false,
      ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1,
    },
  });
  rentalCategoryId = rental.id;
}

function baseInput(): IssueDocumentInput {
  return {
    organizationId: ORG,
    docType: "debit_note",
    counterpartyType: "tenant",
    partyId: PARTY,
    billingMonth: "2026-07-01",
    idempotencyKey: "doc:RENT-2026-07-t1",
    lines: [
      { chargeId: CHARGE, categoryId: rentalCategoryId, description: "Monthly rental 2026-07", amount: "980.00", sstRate: "0" },
    ],
    actorUserId: ACTOR,
  };
}

dn("issueDocumentTx — integration", () => {
  beforeEach(async () => {
    await cleanOrg();
    await seed();
  });

  it("mints a DEP number via the first line's category series and computes totals", async () => {
    const db = getDb();
    const res = await db.$transaction((tx) => issueDocumentTx(tx, baseInput()));
    expect(res.documentNumber).toBe("DEP-0001");

    const doc = await db.billingDocument.findUniqueOrThrow({
      where: { id: res.id },
      include: { lines: true },
    });
    expect(doc.docType).toBe("debit_note");
    expect(doc.seriesId).toBe(depSeriesId);
    expect(doc.status).toBe("issued");
    expect(doc.subtotal.toString()).toBe("980");
    expect(doc.sstAmount.toString()).toBe("0");
    expect(doc.total.toString()).toBe("980");
    expect(doc.billingMonth?.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].chargeId).toBe(CHARGE);
    expect(doc.lines[0].sstAmount.toString()).toBe("0");
  });

  it("computes line SST from sstRate (8% of RM250.00 = RM20.00)", async () => {
    const db = getDb();
    const input = baseInput();
    input.idempotencyKey = "doc:MGMT-1";
    input.lines = [
      { chargeId: CHARGE, categoryId: rentalCategoryId, description: "Management fee", amount: "250.00", sstRate: "8" },
    ];
    const res = await db.$transaction((tx) => issueDocumentTx(tx, input));
    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: res.id }, include: { lines: true } });
    expect(doc.subtotal.toString()).toBe("250");
    expect(doc.sstAmount.toString()).toBe("20");
    expect(doc.total.toString()).toBe("270");
    expect(doc.lines[0].sstAmount.toString()).toBe("20");
  });

  it("honours an exact inclusive-SST residual without increasing the gross total", async () => {
    const input = baseInput();
    input.idempotencyKey = "doc:TA-INCLUSIVE-500";
    input.lines = [
      {
        chargeId: CHARGE,
        categoryId: rentalCategoryId,
        description: "Admin and Agreement Fee",
        amount: "462.96",
        sstRate: "8",
        sstAmount: "37.04",
      },
    ];
    const res = await getDb().$transaction((tx) => issueDocumentTx(tx, input));
    const doc = await getDb().billingDocument.findUniqueOrThrow({ where: { id: res.id }, include: { lines: true } });
    expect(doc.subtotal.toFixed(2)).toBe("462.96");
    expect(doc.sstAmount.toFixed(2)).toBe("37.04");
    expect(doc.total.toFixed(2)).toBe("500.00");
    expect(doc.lines[0].sstRate.toFixed(2)).toBe("8.00");
    expect(doc.lines[0].sstAmount.toFixed(2)).toBe("37.04");
  });

  it("dedupes on idempotencyKey — second issue returns the existing document, no second number", async () => {
    const db = getDb();
    const first = await db.$transaction((tx) => issueDocumentTx(tx, baseInput()));
    const second = await db.$transaction((tx) => issueDocumentTx(tx, baseInput()));
    expect(second.id).toBe(first.id);
    expect(second.documentNumber).toBe(first.documentNumber);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it("credit_note without originalDocumentId throws DOCUMENT_REFERENCE_REQUIRED", async () => {
    const db = getDb();
    const input = baseInput();
    input.docType = "credit_note";
    input.seriesCode = "CN";
    input.idempotencyKey = "cn:orphan";
    await expect(db.$transaction((tx) => issueDocumentTx(tx, input))).rejects.toBeInstanceOf(
      DocumentReferenceRequiredError,
    );
  });

  it("credit_note with an original + explicit CN series mints from the CN counter", async () => {
    const db = getDb();
    const original = await db.$transaction((tx) => issueDocumentTx(tx, baseInput()));
    const input = baseInput();
    input.docType = "credit_note";
    input.seriesCode = "CN";
    input.originalDocumentId = original.id;
    input.creditAmount = "0.00";
    input.reason = "posted in error";
    input.idempotencyKey = "cn:RENT-2026-07-t1";
    const cn = await db.$transaction((tx) => issueDocumentTx(tx, input));
    expect(cn.documentNumber).toBe("CN-0001");
    const row = await db.billingDocument.findUniqueOrThrow({ where: { id: cn.id } });
    expect(row.seriesId).toBe(cnSeriesId);
    expect(row.originalDocumentId).toBe(original.id);
    expect(row.reason).toBe("posted in error");
  });

  it("credit_note/refund_note without seriesCode throws SERIES_CODE_REQUIRED", async () => {
    const db = getDb();
    const original = await db.$transaction((tx) => issueDocumentTx(tx, baseInput()));
    const input = baseInput();
    input.docType = "refund_note";
    input.originalDocumentId = original.id;
    input.idempotencyKey = "rn:x";
    await expect(db.$transaction((tx) => issueDocumentTx(tx, input))).rejects.toThrow("SERIES_CODE_REQUIRED");
  });

  it("empty lines throws DOCUMENT_LINES_REQUIRED", async () => {
    const db = getDb();
    const input = baseInput();
    input.lines = [];
    await expect(db.$transaction((tx) => issueDocumentTx(tx, input))).rejects.toThrow("DOCUMENT_LINES_REQUIRED");
  });
});
