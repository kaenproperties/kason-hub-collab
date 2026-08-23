import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// voidStatementLineService's pre-tx active-adjustment guard (seam #3) calls
// getDb() directly (not through the mocked repository above) — stub
// billingDocumentLine.findMany so it resolves to "no active adjustment notes"
// by default, matching every existing fixture here (none seed a
// charge-adjustment note).
vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return {
    ...actual,
    getDb: vi.fn(() => ({ billingDocumentLine: { findMany: vi.fn(async () => []) } })),
  };
});

// Mock the repository so the DB is never reached — the service is tested in
// isolation. withTransaction runs the callback with a `{}` tx stub; the in-tx
// repo helpers are mocked directly (mirrors owner-billing.statement.test.ts).
// `resolveConfigForUnit` is kept REAL (via importOriginal) — it's pure (no DB)
// and owner-billing-sst-rate.resolveMgmtFeeSstRateByUnit (which recomputeTotals's
// SST resolution now goes through) calls it directly.
vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  return {
    ...actual,
    // The `tx` this stub hands to the callback is what assertPeriodOpen (called
    // from insertStatementChargeAndRecompute / updateStatementLineService) reads
    // via `tx.ownerStatementPeriod.findFirst` when ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER
    // is on. `null` = no period row for these fixtures' owner/month → open →
    // assertPeriodOpen no-ops, matching every existing fixture here (none freeze
    // a period). Flag off is unaffected — assertPeriodOpen early-returns before
    // ever reading this.
    withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ ownerStatementPeriod: { findFirst: vi.fn().mockResolvedValue(null) } }),
    ),
    findStatementById: vi.fn(),
    findInvoiceByIdInTx: vi.fn(),
    findChargeInStatement: vi.fn(),
    createLineCharge: vi.fn(),
    updateLineChargeGuarded: vi.fn(),
    voidLineCharge: vi.fn(),
    updateStatementTotals: vi.fn(),
    countChargesWithPrefix: vi.fn(async () => 0),
    // SST-rate resolution for recomputeTotals (surviving mgmt-fee SST). Default to
    // an owner with no units / no configs → SST 0 unless a test overrides them.
    resolveOwnerUnitsForMonth: vi.fn(async () => []),
    findFeeConfigsForOwner: vi.fn(async () => []),
  };
});

import { recordAudit } from "../../../lib/audit";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import {
  countChargesWithPrefix,
  createLineCharge,
  findChargeInStatement,
  findFeeConfigsForOwner,
  findInvoiceByIdInTx,
  findStatementById,
  resolveOwnerUnitsForMonth,
  updateLineChargeGuarded,
  updateStatementTotals,
  voidLineCharge,
  type DbCharge,
  type DbInvoice,
  type DbManagementFeeConfig,
  type OwnerUnitForMonth,
} from "../owner-billing.repository";
import {
  addStatementLineService,
  getStatementService,
  updateStatementLineService,
  voidStatementLineService,
} from "../owner-billing.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const UNIT = "00000000-0000-0000-0000-0000000000c1";
const INVOICE = "00000000-0000-0000-0000-0000000000d1";
const CHARGE = "00000000-0000-0000-0000-0000000000e1";
const ISO = "2026-06-15T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

const dec = (s: string) => ({ toString: () => s }) as unknown as DbCharge["amount"];

function dbCharge(overrides: Partial<DbCharge> = {}): DbCharge {
  return {
    id: CHARGE,
    organizationId: ORG,
    chargeNumber: "OSC-202606-aaaaaaaa-0001",
    tenancyId: null,
    unitId: UNIT,
    partyId: OWNER,
    chargeType: "tnb",
    status: "draft",
    description: "TNB June",
    dueDate: new Date(Date.UTC(2026, 5, 1)),
    postedAt: null,
    amount: dec("120.00"),
    currency: "MYR",
    outstandingAmount: dec("120.00"),
    waivedReason: null,
    cancelledReason: null,
    isDisputed: false,
    disputeReason: null,
    disputeStatus: null,
    disputeResolution: null,
    disputeResolvedAt: null,
    chargeableFrom: null,
    chargeableTo: null,
    lateFeeApplied: false,
    lateFeeAmount: null,
    parentChargeId: null,
    attachmentKeys: [],
    invoiceId: INVOICE,
    approvedBy: null,
    approvedAt: null,
    billingMonth: new Date(Date.UTC(2026, 5, 1)),
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...overrides,
  } as DbCharge;
}

const decConfig = (s: string) => ({ toString: () => s }) as unknown as DbManagementFeeConfig["sstPercent"];

/** An all-properties, active fee config carrying an SST percent (for the rate map). */
function feeConfig(sstPercent: string): DbManagementFeeConfig {
  return {
    sstPercent: decConfig(sstPercent),
    propertyId: null,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
  } as unknown as DbManagementFeeConfig;
}

/** A resolved owner unit (only unitId + propertyId matter for the SST-rate map). */
function ownerUnit(unitId: string): OwnerUnitForMonth {
  return {
    unitId,
    apartmentId: `apt-${unitId}`,
    unitCode: "A-1",
    propertyId: "prop-1",
    occupied: true,
    rentBase: "2000",
    rentBaseForMonth: "2000",
    managementFeeRentComponents: [{
      billedRent: "2000",
      fullMonthRent: "2000",
      numberOfPax: null,
      isCommissionMonth: false,
      fullyCollected: true,
    }],
  };
}

// A statement Invoice with line Charges. `status` defaults to "draft" so adds /
// edits are allowed; pass status:"approved" to exercise the post-approve rules.
function statement(
  status: string,
  lines: Partial<DbCharge>[],
  inv: Partial<DbInvoice> = {},
): DbInvoice {
  return {
    id: INVOICE,
    organizationId: ORG,
    invoiceNumber: "OS-202606-aaaaaaaa",
    partyId: OWNER,
    ownerPartyId: OWNER,
    tenancyId: null,
    propertyId: null,
    invoiceType: "owner_statement",
    status,
    invoiceDate: new Date(ISO),
    dueDate: null,
    periodMonth: new Date(Date.UTC(2026, 5, 1)),
    totalAmount: dec("120.00") as unknown as DbInvoice["totalAmount"],
    sstAmount: dec("0.00") as unknown as DbInvoice["sstAmount"],
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: `owner:${OWNER}:2026-06`,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...inv,
    charges: lines.map((l, i) => dbCharge({ id: `chg-${i}`, ...l })),
  } as unknown as DbInvoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(countChargesWithPrefix).mockResolvedValue(0);
  // Default: owner has no resolvable units/configs → recomputed mgmt-fee SST is 0.
  // Tests that exercise a mgmt-fee line override these two below.
  vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([]);
  vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
  // This file mocks withTransaction's tx as a bare `{}` stub and never exercises
  // the void→CN path (issueStatementCreditNoteTx talks to raw Prisma tx methods
  // this stub doesn't implement) — that flag-on behavior has dedicated coverage
  // in statement-void-cn.integration.test.ts against a real DB. Force dark here
  // so a full-suite run with ENABLE_PHASE2_BILLING_DOCS=1 set globally doesn't
  // leak into this file's void tests.
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
});

describe("getStatementService", () => {
  it("returns the statement + lines + attachmentKeys for an in-org id", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", [{ chargeType: "tnb", amount: dec("120.00"), unitId: UNIT }], {
        attachmentKeys: ["receipts/a.pdf"],
      }),
    );
    const result = await getStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.id).toBe(INVOICE);
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.lines[0]!.amount).toBe("120.00");
    expect(result.data.attachmentKeys).toEqual(["receipts/a.pdf"]);
    expect(findStatementById).toHaveBeenCalledWith(ORG, INVOICE);
  });

  it("404s a cross-org / unknown statement id", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await getStatementService(ctx, INVOICE);
    expect(result).toEqual({ ok: false, status: 404, error: "Statement not found" });
  });
});

describe("addStatementLineService", () => {
  it("adds a line to a DRAFT statement → 200 + total recomputed (lines + sst)", async () => {
    // Draft with one existing tnb line of 120; add a 80 water line → total 200.
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", [{ chargeType: "tnb", amount: dec("120.00"), unitId: UNIT }]),
    );
    vi.mocked(createLineCharge).mockResolvedValue(
      dbCharge({ id: "new-line", chargeType: "water", amount: dec("80.00"), description: "Water June" }),
    );
    vi.mocked(updateStatementTotals).mockResolvedValue(
      statement(
        "draft",
        [
          { chargeType: "tnb", amount: dec("120.00"), unitId: UNIT },
          { id: "new-line", chargeType: "water", amount: dec("80.00"), unitId: UNIT },
        ],
        { totalAmount: dec("200.00") as unknown as DbInvoice["totalAmount"] },
      ),
    );

    const result = await addStatementLineService(ctx, INVOICE, {
      chargeType: "water",
      description: "Water June",
      amount: "80.00",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.totalAmount).toBe("200.00");

    // The created Charge is org-scoped, owner-billed, invoice-linked, billingMonth
    // from the invoice period, status "draft" (matches the generate path's
    // child-Charge lifecycle — NOT the Tenancy/User "active" lifecycle).
    const createArg = vi.mocked(createLineCharge).mock.calls[0]![1] as Record<string, unknown>;
    expect(createArg.organizationId).toBe(ORG);
    expect(createArg.invoiceId).toBe(INVOICE);
    expect(createArg.partyId).toBe(OWNER);
    expect(createArg.chargeType).toBe("water");
    expect(createArg.amount).toBe("80.00");
    expect(createArg.status).toBe("draft");
    expect(createArg.billingMonth).toEqual(new Date(Date.UTC(2026, 5, 1)));

    // Totals persisted: 120 + 80 = 200 (no mgmt-fee line ⇒ sst unchanged at 0).
    const totalsArg = vi.mocked(updateStatementTotals).mock.calls[0]![3] as {
      totalAmount: string;
      sstAmount: string;
    };
    expect(totalsArg.totalAmount).toBe("200.00");
    expect(totalsArg.sstAmount).toBe("0.00");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.statement.line.add",
        entityType: "Charge",
        entityId: "new-line",
      }),
    );
  });

  it("adding a line to a NON-draft (approved) statement → 409, no write", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("approved", []));
    const result = await addStatementLineService(ctx, INVOICE, {
      chargeType: "tnb",
      description: "TNB",
      amount: "10.00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(createLineCharge).not.toHaveBeenCalled();
    expect(updateStatementTotals).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("404s adding a line to a cross-org / unknown statement", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await addStatementLineService(ctx, INVOICE, {
      chargeType: "tnb",
      description: "TNB",
      amount: "10.00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("updateStatementLineService", () => {
  it("PATCH amount with a STALE expectedUpdatedAt → 409 with the EXACT message", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", [{ id: CHARGE, chargeType: "tnb", amount: dec("120.00"), unitId: UNIT }]),
    );
    vi.mocked(findChargeInStatement).mockResolvedValue(dbCharge());
    vi.mocked(updateLineChargeGuarded).mockRejectedValue(new StaleUpdateError());

    const result = await updateStatementLineService(ctx, INVOICE, CHARGE, {
      amount: "999.00",
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("Record changed — reloaded");
  });

  it("PATCH amount on a DRAFT line recomputes the invoice total", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", [{ id: CHARGE, chargeType: "tnb", amount: dec("120.00"), unitId: UNIT }]),
    );
    vi.mocked(findChargeInStatement).mockResolvedValue(dbCharge({ amount: dec("120.00") }));
    vi.mocked(updateLineChargeGuarded).mockResolvedValue(dbCharge({ amount: dec("300.00") }));
    vi.mocked(updateStatementTotals).mockResolvedValue(
      statement(
        "draft",
        [{ id: CHARGE, chargeType: "tnb", amount: dec("300.00"), unitId: UNIT }],
        { totalAmount: dec("300.00") as unknown as DbInvoice["totalAmount"] },
      ),
    );

    const result = await updateStatementLineService(ctx, INVOICE, CHARGE, {
      amount: "300.00",
      expectedUpdatedAt: ISO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalAmount).toBe("300.00");
    // recompute reflects the NEW amount (300), not the pre-edit 120.
    const totalsArg = vi.mocked(updateStatementTotals).mock.calls[0]![3] as { totalAmount: string };
    expect(totalsArg.totalAmount).toBe("300.00");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.statement.line.update", entityType: "Charge" }),
    );
  });

  it("PATCH on a NON-draft statement → 409 before touching the line", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("approved", [{ id: CHARGE, chargeType: "tnb", amount: dec("120.00") }]),
    );
    const result = await updateStatementLineService(ctx, INVOICE, CHARGE, {
      amount: "1.00",
      expectedUpdatedAt: ISO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(updateLineChargeGuarded).not.toHaveBeenCalled();
  });

  it("404s a line id that is not on the statement", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft", []));
    vi.mocked(findChargeInStatement).mockResolvedValue(null);
    const result = await updateStatementLineService(ctx, INVOICE, CHARGE, {
      amount: "1.00",
      expectedUpdatedAt: ISO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("voidStatementLineService", () => {
  it("voids a line → status void + totals recomputed EXCLUDING the voided line", async () => {
    // Two lines (120 + 80 = 200); void the 80 → total drops to 120.
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", [
        { id: CHARGE, chargeType: "tnb", amount: dec("120.00") },
        { id: "other", chargeType: "water", amount: dec("80.00") },
      ]),
    );
    vi.mocked(findChargeInStatement).mockResolvedValue(dbCharge({ id: "other", amount: dec("80.00") }));
    vi.mocked(voidLineCharge).mockResolvedValue(dbCharge({ id: "other", status: "void", amount: dec("80.00") }));
    vi.mocked(updateStatementTotals).mockResolvedValue(
      statement(
        "draft",
        [
          { id: CHARGE, chargeType: "tnb", amount: dec("120.00") },
          { id: "other", chargeType: "water", amount: dec("80.00"), status: "void" },
        ],
        { totalAmount: dec("120.00") as unknown as DbInvoice["totalAmount"] },
      ),
    );

    const result = await voidStatementLineService(ctx, INVOICE, "other");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(voidLineCharge).toHaveBeenCalledWith(expect.anything(), ORG, INVOICE, "other");
    // The voided line's 80 is excluded → 120 remains.
    const totalsArg = vi.mocked(updateStatementTotals).mock.calls[0]![3] as { totalAmount: string };
    expect(totalsArg.totalAmount).toBe("120.00");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.statement.line.void", entityType: "Charge" }),
    );
  });

  it("voiding the mgmt-fee line removes its SST too → total 100.00, sst 0.00 (no stranded SST)", async () => {
    // Worked example from the integration seed: mgmt base 200 (8% SST = 16) +
    // cleaning 100, sstAmount 16, total 316. Voiding the mgmt-fee line must drop
    // BOTH its 200 base AND its 16 SST → surviving = cleaning 100, sst 0 → 100.00.
    // (Regression for the stranded-SST defect: a verbatim-preserved sstAmount would
    // have yielded 116.00 here.)
    vi.mocked(findStatementById).mockResolvedValue(
      statement(
        "approved",
        [
          { id: "mgmt", chargeType: "management_fee", amount: dec("200.00"), unitId: UNIT },
          { id: "clean", chargeType: "cleaning", amount: dec("100.00"), unitId: UNIT },
        ],
        {
          sstAmount: dec("16.00") as unknown as DbInvoice["sstAmount"],
          totalAmount: dec("316.00") as unknown as DbInvoice["totalAmount"],
        },
      ),
    );
    // The owner's unit resolves to an 8% SST config (drives the recompute).
    vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([ownerUnit(UNIT)]);
    vi.mocked(findFeeConfigsForOwner).mockResolvedValue([feeConfig("8")]);
    vi.mocked(findChargeInStatement).mockResolvedValue(
      dbCharge({ id: "mgmt", chargeType: "management_fee", amount: dec("200.00"), unitId: UNIT }),
    );
    vi.mocked(voidLineCharge).mockResolvedValue(
      dbCharge({ id: "mgmt", chargeType: "management_fee", status: "void", amount: dec("200.00"), unitId: UNIT }),
    );
    vi.mocked(updateStatementTotals).mockResolvedValue(
      statement("approved", [{ id: "clean", chargeType: "cleaning", amount: dec("100.00"), unitId: UNIT }], {
        totalAmount: dec("100.00") as unknown as DbInvoice["totalAmount"],
      }),
    );

    const result = await voidStatementLineService(ctx, INVOICE, "mgmt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The EXACT persisted totals: the voided mgmt line's base AND SST are excluded.
    const totalsArg = vi.mocked(updateStatementTotals).mock.calls[0]![3] as {
      totalAmount: string;
      sstAmount: string;
    };
    expect(totalsArg.totalAmount).toBe("100.00");
    expect(totalsArg.sstAmount).toBe("0.00");
  });

  it("voids a line even on an APPROVED statement (allowed post-approve)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("approved", [{ id: CHARGE, chargeType: "tnb", amount: dec("120.00") }]),
    );
    vi.mocked(findChargeInStatement).mockResolvedValue(dbCharge());
    vi.mocked(voidLineCharge).mockResolvedValue(dbCharge({ status: "void" }));
    vi.mocked(updateStatementTotals).mockResolvedValue(
      statement("approved", [{ id: CHARGE, chargeType: "tnb", amount: dec("120.00"), status: "void" }], {
        totalAmount: dec("0.00") as unknown as DbInvoice["totalAmount"],
      }),
    );

    const result = await voidStatementLineService(ctx, INVOICE, CHARGE);
    expect(result.ok).toBe(true);
    expect(voidLineCharge).toHaveBeenCalled();
  });

  it("404s voiding a line that is not on the statement", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft", []));
    vi.mocked(findChargeInStatement).mockResolvedValue(null);
    const result = await voidStatementLineService(ctx, INVOICE, CHARGE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
