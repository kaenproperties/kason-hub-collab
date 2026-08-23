/**
 * Statement lifecycle integration test: approve regenerates the PDF.
 *
 * Tests that approveStatementService, after flipping status to "approved",
 * immediately regenerates the statement PDF so that Invoice.pdfKey is set to a
 * non-null value that differs from any pre-approval key.
 *
 * Storage + Chromium are mocked (putObject, htmlToPdf, etc.) so no real bucket or
 * browser is needed. The DB is a real LOCAL Postgres — the test asserts that
 * setStatementPdfKey wrote the pdfKey into the Invoice row.
 *
 * Run:
 *   cd apps/api
 *   DATABASE_URL="postgresql://…/kason_hub_dev?schema=public" \
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ../../node_modules/.bin/vitest run \
 *       src/modules/owner-billing/__tests__/owner-billing.statement-lifecycle.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// ── External I/O mocks (storage + Chromium) ───────────────────────────────────
// These let regenerateStatementPdf succeed without a real Supabase bucket or
// browser. The putObject mock returns void; the pdfKey is still written to DB by
// the real setStatementPdfKey call inside the transaction.

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  fetchStorageBuffer: vi.fn(async () => Buffer.from("%PDF-attachment")),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub")),
}));

vi.mock("../../../lib/document-templates/render", () => ({
  renderToHtml: vi.fn(() => "<html>stub</html>"),
}));

vi.mock("../../../lib/document-templates/service", () => ({
  getTemplateForOrgDocType: vi.fn(async () => ({ docType: "owner_statement", title: "Owner Statement" })),
}));

vi.mock("../../../lib/document-templates/merge-pdfs", () => ({
  mergePdfs: vi.fn(async (base: Buffer) => base),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import {
  approveStatementService,
  generateStatementService,
  createFeeConfigService,
} from "../owner-billing.service";

// ── Safety guard ──────────────────────────────────────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix lc01; unused by any other suite) ──────────
const ORG   = "1c010000-0000-4000-8000-000000000001";
const USER  = "1c010000-0000-4000-8000-000000000002";
const PARTY = "1c010000-0000-4000-8000-000000000003";
const OWNER = "1c010000-0000-4000-8000-000000000004";
const TENANT = "1c010000-0000-4000-8000-000000000005";
const PROP  = "1c010000-0000-4000-8000-000000000006";
const APT   = "1c010000-0000-4000-8000-000000000007";
const UNIT  = "1c010000-0000-4000-8000-000000000008";
const TEN   = "1c010000-0000-4000-8000-000000000009";

const BILLING_MONTH = "2026-05";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "LC01 Lifecycle Org",
      slug: "lc01-lifecycle-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "LC01 Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "lc01-operator@example.com",
      fullName: "LC01 Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: {
      id: OWNER,
      organizationId: ORG,
      displayName: "LC01 Owner",
      partyType: "individual",
      status: "active",
      bankName: "Maybank",
      bankAccountHolder: "LC01 Owner",
      bankAccountNumber: "514100000001",
    },
  });
  // PartyRole of roleType "owner" is required by findOwnerInOrg.
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROP,
      organizationId: ORG,
      name: "LC01 Property",
      propertyCode: "LC01-P1",
      propertyType: "apartment",
      addressLine1: "1 LC St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "LC-1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APT,
      listingType: "Whole Unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER,
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "LC01 Tenant", partyType: "individual", status: "active" },
  });
  await db.tenancy.create({
    data: {
      id: TEN,
      organizationId: ORG,
      propertyId: PROP,
      unitId: UNIT,
      tenantPartyId: TENANT,
      tenancyCode: "LC01-T1",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "2000",
    },
  });
  await db.landlordTenancy.create({
    data: {
      organizationId: ORG,
      propertyId: PROP,
      landlordId: OWNER,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "2000",
      status: "active",
    },
  });
  // Active 10%/8%-SST management fee config with cleaning auto-bill so PDF has content.
  await createFeeConfigService(ctx, {
    ownerPartyId: OWNER,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

/**
 * Seed and generate a draft statement with at least one charge.
 * Returns the statement id.
 */
async function seedDraftStatementWithCharges(): Promise<string> {
  const res = await generateStatementService(ctx, {
    ownerPartyId: OWNER,
    billingMonth: BILLING_MONTH,
  });
  if (!res.ok) throw new Error(`generateStatementService failed: ${JSON.stringify(res)}`);
  expect(res.data.lines.length).toBeGreaterThanOrEqual(1);
  return res.data.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

dn("approveStatementService — PDF regeneration (integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("regenerates the PDF when a statement is approved", async () => {
    const statementId = await seedDraftStatementWithCharges();
    const db = getDb();

    // Capture pdfKey BEFORE approve — should be null (never generated yet).
    const before = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { pdfKey: true },
    });

    const res = await approveStatementService(ctx, statementId);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // DB-level assertions: the approved Invoice must now carry a non-null pdfKey
    // that differs from any prior value (freshly generated by regenerateStatementPdf
    // called at the end of approveStatementService).
    const after = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { status: true, pdfKey: true },
    });
    expect(after.status).toBe("approved");
    expect(after.pdfKey).not.toBeNull();
    expect(after.pdfKey).not.toBe(before.pdfKey ?? null); // freshly (re)generated
  });
});

// redesign P1 — OST- statement display numbering, against a REAL local Postgres
// (proves the ReferenceSequence upsert + the new nullable column actually work
// end-to-end, not just against the mocked-tx surface in
// owner-billing.statement-status.test.ts).
dn("approveStatementService — OST- statement numbering (redesign P1, integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seedBase();
    delete process.env.ENABLE_OWNER_DOC_NUMBERING;
  });

  afterAll(async () => {
    await cleanup();
    delete process.env.ENABLE_OWNER_DOC_NUMBERING;
  });

  it("mints OST-<seq> on approve (flag ON); a pre-approval regenerate never burns one; re-approve keeps the SAME number", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    const statementId = await seedDraftStatementWithCharges();
    const db = getDb();

    // Pre-approval: draft, no number yet.
    const draftRow = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { statementNumber: true, status: true },
    });
    expect(draftRow.status).toBe("draft");
    expect(draftRow.statementNumber).toBeNull();

    // Regenerate (idempotent re-call for the SAME owner/month, flag still ON):
    // same draft, still no number burned.
    const regen = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(regen.ok).toBe(true);
    if (regen.ok) expect(regen.data.id).toBe(statementId);
    const afterRegen = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { statementNumber: true },
    });
    expect(afterRegen.statementNumber).toBeNull();

    // This legacy owner-combined statement is approved directly. Per-unit
    // statements use the separate First Check → Approval lifecycle tests.
    const approveRes = await approveStatementService(ctx, statementId);
    expect(approveRes.ok, JSON.stringify(approveRes)).toBe(true);
    const afterApprove = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { statementNumber: true, status: true },
    });
    expect(afterApprove.status).toBe("approved");
    expect(afterApprove.statementNumber).toMatch(/^OST-\d{4,}$/);

    // Re-approve (already approved) — 409, no re-mint, number unchanged.
    const reApprove = await approveStatementService(ctx, statementId);
    expect(reApprove.ok).toBe(false);
    if (!reApprove.ok) expect(reApprove.status).toBe(409);
    const afterReApprove = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { statementNumber: true },
    });
    expect(afterReApprove.statementNumber).toBe(afterApprove.statementNumber);
  });

  it("(flag OFF) approve leaves statementNumber null", async () => {
    // ENABLE_OWNER_DOC_NUMBERING intentionally left unset (default OFF; beforeEach forces dark).
    const statementId = await seedDraftStatementWithCharges();
    const res = await approveStatementService(ctx, statementId);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const db = getDb();
    const row = await db.invoice.findUniqueOrThrow({
      where: { id: statementId },
      select: { statementNumber: true, status: true },
    });
    expect(row.status).toBe("approved");
    expect(row.statementNumber).toBeNull();
  });
});
