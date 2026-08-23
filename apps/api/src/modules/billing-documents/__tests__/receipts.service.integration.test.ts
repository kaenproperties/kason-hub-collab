/**
 * Real local Postgres. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run \
 *     src/modules/billing-documents/__tests__/receipts.service.integration.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx } from "../issue.service";
import { issueReceiptDocumentTx } from "../receipts.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "a6000000-0000-4000-8000-000000000001";
const USER = "a6000000-0000-4000-8000-000000000002";
const PARTY = "a6000000-0000-4000-8000-000000000003";
const IVTEN = "a6000000-0000-4000-8000-000000000004";
const RCPT = "a6000000-0000-4000-8000-000000000005";
const CAT = "a6000000-0000-4000-8000-000000000006";
const CHARGE_1 = "a6000000-0000-4000-8000-000000000011";
const CHARGE_2 = "a6000000-0000-4000-8000-000000000012";
const ORPHAN_CHARGE = "a6000000-0000-4000-8000-000000000013";
const PAYMENT = "a6000000-0000-4000-8000-000000000020";

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Receipt Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "r@t.test", fullName: "R", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: IVTEN, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
  await db.documentSeries.create({ data: { id: RCPT, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "booking_fee", name: "Booking fee", family: "tenant_income", docType: "invoice", seriesId: IVTEN, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });
  for (const [id, num] of [[CHARGE_1, "BF-1"], [CHARGE_2, "BF-2"], [ORPHAN_CHARGE, "BF-3"]] as const) {
    await db.charge.create({ data: { id, organizationId: ORG, chargeNumber: num, chargeType: "booking_fee", categoryId: CAT, partyId: PARTY, amount: "100.00", outstandingAmount: "0.00", status: "paid", currency: "MYR", dueDate: new Date("2026-07-01") } });
  }
  // One IVTEN invoice documenting CHARGE_1 + CHARGE_2 (ORPHAN_CHARGE stays undocumented).
  await getDb().$transaction((tx) =>
    issueDocumentTx(tx, {
      organizationId: ORG, docType: "invoice", counterpartyType: "tenant", partyId: PARTY,
      idempotencyKey: "doc:BF-invoice",
      lines: [
        { chargeId: CHARGE_1, categoryId: CAT, description: "Booking fee 1", amount: "100.00", sstRate: "0" },
        { chargeId: CHARGE_2, categoryId: CAT, description: "Booking fee 2", amount: "100.00", sstRate: "0" },
      ],
      actorUserId: USER,
    }),
  );
  // A receipt acknowledges the amount actually allocated by this payment, not
  // the invoice face value. Keep this integration fixture aligned with the
  // production payment flow by seeding the payment and its two allocations.
  await db.payment.create({
    data: {
      id: PAYMENT,
      organizationId: ORG,
      paymentNumber: "PAY-RCPT-1",
      partyId: PARTY,
      paymentType: "receipt",
      paymentMethod: "bank_transfer",
      status: "posted",
      amount: "200.00",
      currency: "MYR",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  });
  await db.paymentAllocation.createMany({
    data: [CHARGE_1, CHARGE_2].map((chargeId) => ({
      organizationId: ORG,
      paymentId: PAYMENT,
      chargeId,
      allocatedAmount: "100.00",
      allocatedAt: new Date("2026-07-01T00:00:00.000Z"),
    })),
  });
}

dn("issueReceiptDocumentTx (R8)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("mints one RCPT with paymentId, invoice counterparty, one line per settled charge", async () => {
    const db = getDb();
    const res = await db.$transaction((tx) =>
      issueReceiptDocumentTx(tx, { organizationId: ORG, paymentId: PAYMENT, partyId: PARTY, settledChargeIds: [CHARGE_1, CHARGE_2], actorUserId: USER }),
    );
    expect("documentNumber" in res && res.documentNumber).toBe("RCPT-0001");
    const doc = await db.billingDocument.findFirstOrThrow({ where: { organizationId: ORG, docType: "receipt" }, include: { lines: true } });
    expect(doc.paymentId).toBe(PAYMENT);
    expect(doc.counterpartyType).toBe("tenant");
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines.map((l) => l.chargeId).sort()).toEqual([CHARGE_1, CHARGE_2].sort());
    for (const l of doc.lines) expect(l.categoryId).toBe(CAT);
  });

  it("is idempotent — replay returns the same receipt, no second number", async () => {
    const db = getDb();
    const first = await db.$transaction((tx) => issueReceiptDocumentTx(tx, { organizationId: ORG, paymentId: PAYMENT, partyId: PARTY, settledChargeIds: [CHARGE_1, CHARGE_2], actorUserId: USER }));
    const second = await db.$transaction((tx) => issueReceiptDocumentTx(tx, { organizationId: ORG, paymentId: PAYMENT, partyId: PARTY, settledChargeIds: [CHARGE_1, CHARGE_2], actorUserId: USER }));
    if (!("id" in first) || !("id" in second)) throw new Error("expected both issuances to return a document");
    expect(second.id).toBe(first.id);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "receipt" } })).toBe(1);
  });

  it("skips when no settled charge maps to an invoice/debit_note line", async () => {
    const db = getDb();
    const res = await db.$transaction((tx) => issueReceiptDocumentTx(tx, { organizationId: ORG, paymentId: PAYMENT, partyId: PARTY, settledChargeIds: [ORPHAN_CHARGE], actorUserId: USER }));
    expect(res).toEqual({ skipped: "no_documented_charges" });
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "receipt" } })).toBe(0);
  });
});
