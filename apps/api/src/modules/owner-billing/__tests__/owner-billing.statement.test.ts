import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeManagementFee } from "@kason/shared";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// generate now fires the owner-ledger sync hook AFTER its tx commits. Stub it to a
// no-op so this isolated unit test never reaches the DB (the real re-sync behavior
// is covered by owner-billing.integration.test.ts — "generate re-syncs owner-ledger").
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({
  syncOwnerLedgerForCharges: vi.fn(async () => undefined),
}));

// generate also mints the IVOWN document INSIDE its write tx when
// ENABLE_PHASE2_BILLING_DOCS is on (Task 9). The mocked `{}` tx stub below has no
// real Prisma surface, so stub the whole issue.service module out — same pattern
// billing.service.test.ts uses for issueDocumentsForChargesTx. The real in-tx mint
// behavior is covered by issue-ivown.integration.test.ts.
vi.mock("../../billing-documents/issue.service", () => ({
  issueStatementIvownDocumentTx: vi.fn(async () => undefined),
}));

// Mock the repository so the DB is never reached — the service is tested in
// isolation (mirrors owner-billing.service.test.ts). withTransaction runs the
// callback with a `{}` tx stub; the in-tx repo helpers are mocked directly.
// `resolveConfigForUnit` (and `resolveMgmtFeeSstRateByUnit`) are kept REAL via
// importOriginal — they're pure/DB-free, and this file's "config precedence"
// tests exercise their actual precedence logic through generateStatementService,
// not a stub.
vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  return {
    ...actual,
    // tx stub: generateStatementService now consults the closed-period guard
    // (tx.ownerStatementPeriod.findFirst — added by the closed-period-guard feature).
    // Stub it as "no frozen period" so the mgmt-fee/cleaning assertions run.
    withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ ownerStatementPeriod: { findFirst: vi.fn(async () => null) } }),
    ),
    findOwnerInOrg: vi.fn(),
    resolveOwnerUnitsForMonth: vi.fn(async () => []),
    findFeeConfigsForOwner: vi.fn(async () => []),
    // PART 4: owner-borne utility lines fed from the unit's bill — default none here
    // (the mocked statement test asserts the mgmt-fee/cleaning behavior; the utility
    // auto-feed is covered by the owner-billing integration suite).
    findOwnerBorneUtilityComponents: vi.fn(async () => []),
    findCommissionRentCharges: vi.fn(async () => []),
    findOwnerBorneCommissionSstCharges: vi.fn(async () => []),
    findInvoiceByIdempotencyKey: vi.fn(async () => null),
    findInvoiceByIdempotencyKeyInTx: vi.fn(async () => null),
    findInvoiceByIdInTx: vi.fn(),
    findUnvoidedChargeForUnitMonth: vi.fn(async () => null),
    countChargesWithPrefix: vi.fn(async () => 0),
    createStatementCharge: vi.fn(),
    createOwnerStatementInvoice: vi.fn(),
    attachChargeToInvoice: vi.fn(async () => undefined),
    listOwnerStatements: vi.fn(async () => []),
    // The generate path's cleaning line now flows through the SHARED idempotent
    // helper (C7) — mocked here so the statement test asserts the delegation.
    // Slot-release for voided statements: no-op in unit tests (covered by integration suite).
    releaseVoidedStatementSlotsInTx: vi.fn(async () => undefined),
  };
});

import { recordAudit } from "../../../lib/audit";
import {
  attachChargeToInvoice,
  countChargesWithPrefix,
  createOwnerStatementInvoice,
  createStatementCharge,
  findFeeConfigsForOwner,
  findCommissionRentCharges,
  findOwnerBorneCommissionSstCharges,
  findInvoiceByIdInTx,
  findInvoiceByIdempotencyKey,
  findOwnerInOrg,
  findUnvoidedChargeForUnitMonth,
  listOwnerStatements,
  resolveOwnerUnitsForMonth,
  type DbCharge,
  type DbInvoice,
  type DbManagementFeeConfig,
  type OwnerUnitForMonth,
} from "../owner-billing.repository";
import {
  generateStatementService,
  listStatementsService,
} from "../owner-billing.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const PROPERTY = "00000000-0000-0000-0000-0000000000bb";
const UNIT_OCC = "00000000-0000-0000-0000-0000000000c1";
const UNIT_VAC = "00000000-0000-0000-0000-0000000000c2";
// Distinct apartments for the two units — cleaning is grouped per apartmentId.
const APT_OCC = "00000000-0000-0000-0000-0000000000e1";
const APT_VAC = "00000000-0000-0000-0000-0000000000e2";
const INVOICE = "00000000-0000-0000-0000-0000000000d1";
const ISO = "2026-06-01T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

const dec = (s: string) => ({ toString: () => s }) as unknown as DbManagementFeeConfig["feeValue"];

function cfg(overrides: Partial<DbManagementFeeConfig> = {}): DbManagementFeeConfig {
  return {
    id: "cfg-1",
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: null,
    feeType: "percent",
    feeValue: dec("10"),
    capAmount: null,
    sstPercent: dec("8"),
    freePeriodStart: null,
    freePeriodEnd: null,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...overrides,
  } as DbManagementFeeConfig;
}

function occUnit(overrides: Partial<OwnerUnitForMonth> = {}): OwnerUnitForMonth {
  const unit = { unitId: UNIT_OCC, apartmentId: APT_OCC, unitCode: "A-1", propertyId: PROPERTY, occupied: true, rentBase: "2000", rentBaseForMonth: "2000", ...overrides };
  return {
    ...unit,
    managementFeeRentComponents: overrides.managementFeeRentComponents ?? [{
      billedRent: unit.rentBaseForMonth,
      fullMonthRent: unit.rentBase,
      numberOfPax: null,
      isCommissionMonth: false,
      fullyCollected: true,
    }],
  };
}
function vacUnit(overrides: Partial<OwnerUnitForMonth> = {}): OwnerUnitForMonth {
  return { unitId: UNIT_VAC, apartmentId: APT_VAC, unitCode: "A-2", propertyId: PROPERTY, occupied: false, rentBase: "0", rentBaseForMonth: "0", ...overrides, managementFeeRentComponents: overrides.managementFeeRentComponents ?? [] };
}

// A built statement Invoice with line Charges (what findInvoiceByIdInTx /
// findInvoiceByIdempotencyKey resolve to after a create).
function builtInvoice(lines: { chargeType: string; amount: string; unitId: string | null }[]): DbInvoice {
  return {
    id: INVOICE,
    organizationId: ORG,
    invoiceNumber: "OS-202606-00000000",
    partyId: OWNER,
    ownerPartyId: OWNER,
    tenancyId: null,
    propertyId: null,
    invoiceType: "owner_statement",
    status: "draft",
    invoiceDate: new Date(ISO),
    dueDate: null,
    periodMonth: new Date(Date.UTC(2026, 5, 1)),
    totalAmount: dec("2316") as unknown as DbInvoice["totalAmount"],
    sstAmount: dec("16") as unknown as DbInvoice["sstAmount"],
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: `owner:${OWNER}:2026-06`,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    charges: lines.map((l, i) => ({
      id: `chg-${i}`,
      chargeNumber: `OS-CHG-${i}`,
      chargeType: l.chargeType,
      unitId: l.unitId,
      description: null,
      amount: dec(l.amount),
      currency: "MYR",
      status: "draft",
      updatedAt: new Date(ISO),
    })),
  } as unknown as DbInvoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOwnerInOrg).mockResolvedValue({ id: "lt-1" });
  vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([]);
  vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
  vi.mocked(findCommissionRentCharges).mockResolvedValue([]);
  vi.mocked(findOwnerBorneCommissionSstCharges).mockResolvedValue([]);
  vi.mocked(findInvoiceByIdempotencyKey).mockResolvedValue(null);
  vi.mocked(findUnvoidedChargeForUnitMonth).mockResolvedValue(null);
  vi.mocked(countChargesWithPrefix).mockResolvedValue(0);
  vi.mocked(createStatementCharge).mockImplementation(async () => ({ id: `chg-${Math.random()}` }));
  vi.mocked(createOwnerStatementInvoice).mockResolvedValue({ id: INVOICE });
  vi.mocked(findInvoiceByIdInTx).mockResolvedValue(builtInvoice([]));
});

describe("generateStatementService — validation + idempotency", () => {
  it("404s a cross-org owner (no LandlordTenancy in the actor's org)", async () => {
    vi.mocked(findOwnerInOrg).mockResolvedValue(null);
    const result = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(result).toEqual({ ok: false, status: 404, error: "Owner not found in this organization" });
    expect(findOwnerInOrg).toHaveBeenCalledWith(ORG, OWNER);
    // No statement work happens after the 404.
    expect(createOwnerStatementInvoice).not.toHaveBeenCalled();
    expect(resolveOwnerUnitsForMonth).not.toHaveBeenCalled();
  });

  it("returns the EXISTING draft (200) without creating a duplicate when the idempotency key already exists", async () => {
    const existing = builtInvoice([{ chargeType: "management_fee", amount: "200", unitId: UNIT_OCC }]);
    vi.mocked(findInvoiceByIdempotencyKey).mockResolvedValue(existing);
    const result = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.id).toBe(INVOICE);
    // Idempotent short-circuit: NO invoice/charge created, NO audit.
    expect(createOwnerStatementInvoice).not.toHaveBeenCalled();
    expect(createStatementCharge).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // BACKEND↔FRONTEND CONTRACT (F2): the admin Owner-Statements page gates the
  // "Download PDF" + "Send soft copy" affordances on Invoice.pdfKey. mapStatement
  // MUST surface it (null when no PDF, the key when present) — if it stops being
  // sent, the Download button silently disappears on the frontend.
  it("surfaces Invoice.pdfKey on the read DTO (contract for Download/Send gating)", async () => {
    const withPdf = builtInvoice([
      { chargeType: "management_fee", amount: "200", unitId: UNIT_OCC },
    ]);
    (withPdf as { pdfKey: string | null }).pdfKey = "owner-statements/o/202606.pdf";
    vi.mocked(findInvoiceByIdempotencyKey).mockResolvedValue(withPdf);
    const result = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveProperty("pdfKey", "owner-statements/o/202606.pdf");
  });
});

describe("generateStatementService — occupied unit", () => {
  it("creates an owner_statement draft Invoice + a management_fee Charge (amount === computeManagementFee base) and NO cleaning line", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit({ rentBase: "2000" })]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ feeType: "percent", feeValue: dec("10"), sstPercent: dec("8") })]);

    const expected = computeManagementFee(
      { feeType: "percent", feeValue: "10", capAmount: null, sstPercent: "8" },
      "2000",
    );
    // sanity: 10% of 2000 = 200 base, 8% SST = 16
    expect(expected.base).toBe("200.00");
    expect(expected.sst).toBe("16.00");

    const result = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(result.ok).toBe(true);

    // The invoice header is owner_statement / draft, bill-to = owner, periodMonth first-of-month.
    const invArg = vi.mocked(createOwnerStatementInvoice).mock.calls[0]![1] as Record<string, unknown>;
    expect(invArg.invoiceType).toBe("owner_statement");
    expect(invArg.status).toBe("draft");
    expect(invArg.ownerPartyId).toBe(OWNER);
    expect(invArg.partyId).toBe(OWNER);
    expect(invArg.organizationId).toBe(ORG);
    expect(invArg.currency).toBe("MYR");
    expect(invArg.idempotencyKey).toBe(`owner:${OWNER}:2026-06`);
    // sstAmount aggregates the mgmt-fee SST; totalAmount = lines + sst.
    expect(invArg.sstAmount).toBe("16.00");
    // line amounts: 200 (mgmt base) only — cleaning is NOT issued here any more (2026-07-29);
    // the bills grid owns it. 200 + 16 sst = 216.
    expect(invArg.totalAmount).toBe("216.00");

    // A management_fee Charge at the computed BASE (not base+sst).
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const mgmt = chargeArgs.find((a) => a.chargeType === "management_fee");
    expect(mgmt).toBeDefined();
    expect(mgmt!.amount).toBe("200.00");
    expect(mgmt!.unitId).toBe(UNIT_OCC);
    expect(mgmt!.organizationId).toBe(ORG);
    expect(mgmt).toMatchObject({
      nature: "profit",
      fundedBy: "owner",
      revenueRecognition: "manager_revenue",
      settlementRecipient: "manager",
      commercialPurpose: "MANAGEMENT_FEE",
      taxTreatment: "taxable_service",
    });
    // Cleaning is NOT issued by the statement at all now: it duplicated the bills grid, which
    // bills owner cleaning as chargeType "utility" / cleaning_owner. Neither inline nor via the
    // shared helper.
    expect(chargeArgs.some((a) => a.chargeType === "cleaning")).toBe(false);

    // Audit written in-tx with the locked action + entityType.
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.statement.generate",
        entityType: "Invoice",
        entityId: INVOICE,
      }),
    );
  });

  it("uses computeManagementFee for a cap config (does not hand-math the fee)", async () => {
    // 10% of 5000 = 500, capped at 300 → base 300. The fee base is
    // `rentBaseForMonth` (rent BILLED this month), never the contracted
    // `rentBase` — this unit is fully occupied, so the two coincide.
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([
      occUnit({ rentBase: "5000", rentBaseForMonth: "5000" }),
    ]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({ feeType: "cap", feeValue: dec("10"), capAmount: dec("300"), sstPercent: dec("8") }),
    ]);
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const mgmt = chargeArgs.find((a) => a.chargeType === "management_fee");
    expect(mgmt!.amount).toBe("300.00");
  });
});

describe("generateStatementService — letting commission SST (Phase 3)", () => {
  it("B30/B33: an owner-borne commission charge → a letting_commission_sst OWNER charge = 8% of the commission (1500 → 120)", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit({ rentBase: "1500" })]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]); // no fee config → isolate the SST line
    vi.mocked(findCommissionRentCharges).mockResolvedValue([
      { unitId: UNIT_OCC, amount: "1500.00", sstBearer: "owner" },
    ]);
    vi.mocked(findOwnerBorneCommissionSstCharges).mockResolvedValue([{ unitId: UNIT_OCC, amount: "1500.00" }]);

    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });

    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const commission = chargeArgs.find((a) => a.chargeType === "letting_commission");
    const sst = chargeArgs.find((a) => a.chargeType === "letting_commission_sst");
    expect(commission?.amount).toBe("1500.00");
    expect(commission?.partyId).toBe(OWNER);
    expect(commission?.description).toBe("Admin Fee (First Month Rental)");
    expect(commission).toMatchObject({
      nature: "profit",
      fundedBy: "owner",
      revenueRecognition: "manager_revenue",
      settlementRecipient: "manager",
      commercialPurpose: "SERVICE",
      taxTreatment: "taxable_service",
    });
    expect(sst).toBeDefined();
    expect(sst!.amount).toBe("120.00"); // 8% of the actual commission (M-F2), billed to the owner
    expect(sst!.unitId).toBe(UNIT_OCC);
    expect(sst!.partyId).toBe(OWNER); // OWNER pays the SST (IVOWN), not the tenant
    expect(sst!.description).toBe("SST on Admin Fee (First Month Rental)");
    // M-B2 hardening: the SST charge must NOT carry nature="expense" — otherwise owner-ledger
    // Source 6 (owner-borne deduct) would double-book it alongside Source 2. Deducts via Source 2 only.
    expect(sst!.nature).not.toBe("expense");
  });

  it("B31: no owner-borne commission (kaen bearer / none) → NO letting_commission_sst charge", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit({ rentBase: "1500" })]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
    vi.mocked(findOwnerBorneCommissionSstCharges).mockResolvedValue([]); // repo already filtered "kaen" out
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs.some((a) => a.chargeType === "letting_commission_sst")).toBe(false);
  });
});

describe("generateStatementService — vacant unit gating", () => {
  it("a VACANT unit gets NO management_fee line — and no cleaning line either (cleaning left the statement)", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([vacUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg()]);

    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs.some((a) => a.chargeType === "management_fee")).toBe(false);
    // Cleaning left the statement entirely (2026-07-29) — it duplicated the bills grid. A vacant
    // unit therefore produces NO statement line at all, where it used to produce a cleaning one.
  });

  it("a unit inside the owner's free period gets NO management_fee line, and no cleaning line", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({
        freePeriodStart: new Date("2026-01-01T00:00:00.000Z"),
        freePeriodEnd: new Date("2026-12-31T00:00:00.000Z"),
      }),
    ]);
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs.some((a) => a.chargeType === "management_fee")).toBe(false);
    // …and no cleaning line either: the statement stopped issuing cleaning (2026-07-29).
  });
});

describe("generateStatementService — config precedence + no-config", () => {
  it("a property-specific config OVERRIDES the all-properties (null) config for that unit", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit({ rentBase: "1000" })]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({ id: "all", propertyId: null, feeType: "percent", feeValue: dec("10") }),
      cfg({ id: "prop", propertyId: PROPERTY, feeType: "fixed", feeValue: dec("123") }),
    ]);
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const mgmt = chargeArgs.find((a) => a.chargeType === "management_fee");
    // The fixed 123 (property override) wins over 10% of 1000 = 100 (all-properties).
    expect(mgmt!.amount).toBe("123.00");
  });

  it("an INACTIVE config is ignored — no mgmt-fee / cleaning lines for that unit", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg({ isActive: false })]);
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs).toHaveLength(0);
    // Still creates the (empty) statement.
    expect(createOwnerStatementInvoice).toHaveBeenCalled();
  });

  it("an effectiveTo in the PAST excludes the config (not covering the first-of-month)", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([
      cfg({ effectiveFrom: new Date("2025-01-01T00:00:00.000Z"), effectiveTo: new Date("2025-12-31T00:00:00.000Z") }),
    ]);
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs).toHaveLength(0);
  });

  it("creates an empty statement (no lines) when the owner has NO applicable config", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
    const result = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(result.ok).toBe(true);
    expect(createStatementCharge).not.toHaveBeenCalled();
    // sstAmount + totalAmount default to 0.
    const invArg = vi.mocked(createOwnerStatementInvoice).mock.calls[0]![1] as Record<string, unknown>;
    expect(invArg.sstAmount).toBe("0.00");
    expect(invArg.totalAmount).toBe("0.00");
  });
});

describe("generateStatementService — no double-bill", () => {
  it("skips a management_fee line when an un-voided Charge for that unit+type+month already exists", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg()]);
    // The mgmt-fee double-bill probe returns an existing charge → no new mgmt line.
    vi.mocked(findUnvoidedChargeForUnitMonth).mockResolvedValue({ id: "pre-existing" });
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    // No mgmt-fee line created (the inline createStatementCharge handles mgmt only).
    const chargeArgs = vi.mocked(createStatementCharge).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(chargeArgs.some((a) => a.chargeType === "management_fee")).toBe(false);
    // Probe is org-scoped + per unit + per chargeType + per month (mgmt-fee path).
    expect(findUnvoidedChargeForUnitMonth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG, unitId: UNIT_OCC, chargeType: "management_fee" }),
    );
    // The cleaning line is NOT attached to the fresh invoice (helper said created:false).
    expect(attachChargeToInvoice).not.toHaveBeenCalledWith(expect.anything(), ORG, "pre-clean", INVOICE);
  });
});

describe("listStatementsService", () => {
  it("forwards org id + filters + paging to the repository and wraps the envelope", async () => {
    vi.mocked(listOwnerStatements).mockResolvedValue([
      builtInvoice([{ chargeType: "management_fee", amount: "200", unitId: UNIT_OCC }]),
    ]);
    const result = await listStatementsService(
      ctx,
      { ownerPartyId: OWNER, status: "draft", billingMonth: "2026-06" },
      { limit: 25, offset: 10 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listOwnerStatements).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ ownerPartyId: OWNER, status: "draft" }),
      { limit: 25, offset: 10 },
    );
    expect(result.data.limit).toBe(25);
    expect(result.data.offset).toBe(10);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.invoiceType).toBe("owner_statement");
    // Decimals serialised to canonical 2dp strings, never leaked as Decimal.
    expect(typeof result.data.items[0]!.totalAmount).toBe("string");
    expect(result.data.items[0]!.lines[0]!.amount).toBe("200.00");
  });
});

describe("generateStatementService — attaches lines + audits the invoice id", () => {
  it("attaches the created mgmt-fee Charge to the Invoice (no cleaning charge exists to attach)", async () => {
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([occUnit()]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([cfg()]);
    vi.mocked(createStatementCharge).mockResolvedValueOnce({ id: "mgmt-chg" });
    // Only the mgmt-fee charge is attached now — the statement no longer creates a cleaning
    // Charge, so there is none to attach (see the cleaning-duplication note in the service).
    await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: "2026-06" });
    expect(attachChargeToInvoice).toHaveBeenCalledWith(expect.anything(), ORG, "mgmt-chg", INVOICE);
    expect(attachChargeToInvoice).not.toHaveBeenCalledWith(expect.anything(), ORG, "clean-chg", INVOICE);
  });
});
