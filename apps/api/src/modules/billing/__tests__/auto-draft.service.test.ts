import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ────────────────────────────────────────────────────────────────
// Mirror the commissions.service.test.ts template: getDb() returns fakes whose
// invoiceDraftRun.create/update resolve to rows, and $transaction(fn) invokes
// fn(fakeTx) so the per-tenancy work runs synchronously against a stub tx.
const mockDraftRunCreate = vi.fn();
const mockDraftRunUpdate = vi.fn();
const mockDraftConfigCreate = vi.fn();
const mockDraftConfigUpdate = vi.fn();
const mockInvoiceUpdate = vi.fn();
const mockInvoiceFindFirst = vi.fn();
const mockChargeFindMany = vi.fn();
const mockChargeFindFirst = vi.fn();
const mockChargeUpdate = vi.fn();
// The run-ledger create/update + config create now run INSIDE their own
// db.$transaction(fn) blocks, so the same mock fns must also be reachable on the tx.
const fakeTx = {
  chargeEvent: { create: vi.fn(async () => ({ id: "evt-1" })) },
  draftConfig: { create: mockDraftConfigCreate, update: mockDraftConfigUpdate },
  invoiceDraftRun: { create: mockDraftRunCreate, update: mockDraftRunUpdate },
  invoice: { update: mockInvoiceUpdate, findFirst: mockInvoiceFindFirst },
  charge: { findMany: mockChargeFindMany, findFirst: mockChargeFindFirst, update: mockChargeUpdate },
  // Task 4.2: carpark assignments fetched inside the auto-draft loop. Default to
  // empty so existing tests are unaffected; specific tests may override.
  carparkAssignment: { findMany: vi.fn(async () => []) },
};
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    invoiceDraftRun: { create: mockDraftRunCreate, update: mockDraftRunUpdate },
    $transaction: mockTransaction,
  }),
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, opts: { code: string }) {
        super(message);
        this.name = "PrismaClientKnownRequestError";
        this.code = opts.code;
      }
    },
  },
}));

// Mock withStaleCheck so tests can control whether the guarded update yields a row or null.
const mockWithStaleCheck = vi.fn();
vi.mock("../../../lib/optimistic-update", () => ({
  withStaleCheck: (fn: () => Promise<unknown>) => mockWithStaleCheck(fn),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../post-monthly-rent", () => ({
  resolveMonthlyRentAmount: vi.fn(),
}));

vi.mock("../post-monthly-carpark", () => ({
  carparkChargeNumber: vi.fn((cm: string, id: string) => `CARPARK-${cm}-${id}`),
}));

vi.mock("../auto-draft.repository", () => ({
  firstOfMonthUtc: vi.fn((ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  }),
  compactMonth: vi.fn((ym: string) => ym.replace("-", "")),
  tenantInvoiceNumber: vi.fn((ym: string, id: string) => `TR-${ym.replace("-", "")}-${id.slice(0, 8)}`),
  rentChargeNumber: vi.fn((ym: string, id: string) => `RENT-${ym.replace("-", "")}-${id.slice(0, 8)}`),
  getDraftConfig: vi.fn(),
  createDraftConfig: vi.fn(),
  listTenanciesForPeriod: vi.fn(),
  findExistingDraft: vi.fn(),
  findUnbilledTenantCharges: vi.fn(),
  createInvoiceTx: vi.fn(),
  createRentChargeTx: vi.fn(),
  attachChargeTx: vi.fn(),
  detachChargeTx: vi.fn(),
  recomputeInvoiceTotalTx: vi.fn(),
  listDistinctActiveOwners: vi.fn(),
  listDraftRuns: vi.fn(),
  getDraftRun: vi.fn(),
  listDraftInvoices: vi.fn(),
  getDraftInvoiceWithCharges: vi.fn(),
  toNumber: vi.fn((v: unknown) => Number(v)),
}));

vi.mock("../../../modules/owner-billing/owner-billing.service", () => ({
  generateStatementService: vi.fn(),
}));

// The post-draft handover correction. Mocked here because it drives its own
// Prisma client (this harness's getDb() exposes only invoiceDraftRun), and
// because its behaviour has real-Postgres coverage in
// draft-catchup.integration.test.ts. What THIS suite pins is the wiring: that
// the run calls it once per distinct unit it billed.
vi.mock("../reprorate-rent-drafts", () => ({
  reprorateRentDraftsForPeriod: vi.fn(async () => ({ adjusted: [], lockedStale: [] })),
}));

import { Prisma } from "@kason/db";
import { recordAudit } from "../../../lib/audit";
import {
  attachChargeTx,
  createDraftConfig,
  createInvoiceTx,
  createRentChargeTx,
  detachChargeTx,
  findExistingDraft,
  findUnbilledTenantCharges,
  getDraftConfig,
  getDraftInvoiceWithCharges,
  getDraftRun,
  listTenanciesForPeriod,
  listDistinctActiveOwners,
  listDraftInvoices,
  listDraftRuns,
  recomputeInvoiceTotalTx,
} from "../auto-draft.repository";
import { resolveMonthlyRentAmount } from "../post-monthly-rent";
import { reprorateRentDraftsForPeriod } from "../reprorate-rent-drafts";
import { generateStatementService } from "../../../modules/owner-billing/owner-billing.service";
import {
  approveBulkService,
  approveInvoiceService,
  attachChargeService,
  createDraftConfigService,
  detachChargeService,
  editDraftChargeAmountService,
  editInvoiceDatesService,
  getDraftConfigService,
  getDraftInvoiceService,
  getDraftRunService,
  listDraftInvoicesService,
  listDraftRunsService,
  patchDraftConfigService,
  runAutoDraftInvoices,
  voidInvoiceService,
} from "../auto-draft.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const TENANCY = "8a646609-1111-2222-3333-444455556666";
const PERIOD = "2026-06";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const, triggeredBy: "test" };

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    runDayOfMonth: 1,
    dueDayOffset: null,
    includeRent: true,
    includeElectricity: true,
    includeMgmtFee: false,
    includeCleaning: false,
    autoApprove: false,
    isActive: true,
    ...overrides,
  };
}

function tenancy(overrides: Record<string, unknown> = {}) {
  return {
    id: TENANCY,
    unitId: "unit-1",
    tenantPartyId: "party-1",
    propertyId: "prop-1",
    monthlyRentAmount: { toFixed: () => "1500.00" } as never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The InvoiceDraftRun ledger rows the service creates/updates.
  mockDraftRunCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "run-1",
    ...data,
  }));
  mockDraftRunUpdate.mockImplementation(async () => ({ id: "run-1" }));
  // DraftConfig create now happens on tx inside createDraftConfigService.
  mockDraftConfigCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...configRow(),
    ...data,
  }));
  // Repository defaults: one active tenancy, no existing draft, rent resolves to 1500.
  vi.mocked(getDraftConfig).mockResolvedValue(config() as never);
  vi.mocked(listTenanciesForPeriod).mockResolvedValue([tenancy()] as never);
  vi.mocked(findExistingDraft).mockResolvedValue(null as never);
  vi.mocked(resolveMonthlyRentAmount).mockResolvedValue("1500.00");
  vi.mocked(createInvoiceTx).mockResolvedValue({ id: "inv-1" } as never);
  vi.mocked(createRentChargeTx).mockResolvedValue({ id: "rent-1", amount: "1500.00" } as never);
  vi.mocked(findUnbilledTenantCharges).mockResolvedValue([] as never);
  vi.mocked(recomputeInvoiceTotalTx).mockResolvedValue(1500 as never);
  // Owner defaults: no active owners (keeps existing tenant tests unaffected).
  vi.mocked(listDistinctActiveOwners).mockResolvedValue([] as never);
  // New query service defaults.
  vi.mocked(createDraftConfig).mockResolvedValue(config() as never);
  vi.mocked(getDraftRun).mockResolvedValue(null as never);
  vi.mocked(listDraftRuns).mockResolvedValue({ rows: [], total: 0 } as never);
  vi.mocked(listDraftInvoices).mockResolvedValue({ rows: [], total: 0 } as never);
  vi.mocked(getDraftInvoiceWithCharges).mockResolvedValue(null as never);
  // withStaleCheck default: call the fn and return its result (happy path).
  mockWithStaleCheck.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  // Transition (Task 7) tx-level defaults.
  mockInvoiceUpdate.mockResolvedValue({ id: "inv-1" });
  mockInvoiceFindFirst.mockResolvedValue({ id: "inv-1", status: "draft" });
  mockChargeFindMany.mockResolvedValue([]);
  // `tx.charge.findFirst` now serves TWO callers inside the drafter, and a single
  // blanket default cannot serve both: the attach/detach services want a charge
  // row back, while the drafter's "is this month's rent already billed?" check
  // (a lookup by RENT-{YYYYMM}-{tenancyId}) must find NOTHING or every run test
  // skips before creating anything. Route on the chargeNumber being queried, so
  // the happy path stays "not yet billed" and the transition tests keep their row.
  mockChargeFindFirst.mockImplementation(async (args?: { where?: { chargeNumber?: string } }) =>
    args?.where?.chargeNumber?.startsWith("RENT-")
      ? null
      : { id: "charge-x", invoiceId: null },
  );
  mockChargeUpdate.mockResolvedValue({ id: "charge-1" });
});

describe("runAutoDraftInvoices — no active config", () => {
  it("returns completed 0/0 and records a ledger row with errorText 'no active DraftConfig'", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(null as never);
    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(r.status).toBe("completed");
    expect(r.draftsCreated).toBe(0);
    expect(r.draftsSkipped).toBe(0);
    expect(r.errorText).toBe("no active DraftConfig");

    // A single ledger row created (completed), and no second running row.
    expect(mockDraftRunCreate).toHaveBeenCalledTimes(1);
    expect(mockDraftRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          status: "completed",
          draftsCreated: 0,
          draftsSkipped: 0,
          errorText: "no active DraftConfig",
          triggeredBy: "test",
        }),
      }),
    );
    expect(mockDraftRunUpdate).not.toHaveBeenCalled();
    // The single ledger row is audited as completed with a "no active config" note.
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        action: "billing.draftrun.completed",
        entityType: "InvoiceDraftRun",
        entityId: "run-1",
        meta: expect.objectContaining({ note: "no active config" }),
      }),
    );
    // No tenancy work at all.
    expect(listTenanciesForPeriod).not.toHaveBeenCalled();
    expect(createInvoiceTx).not.toHaveBeenCalled();
  });

  it("treats an INACTIVE config the same as no config", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(config({ isActive: false }) as never);
    const r = await runAutoDraftInvoices(ctx, PERIOD);
    expect(r.status).toBe("completed");
    expect(r.errorText).toBe("no active DraftConfig");
    expect(createInvoiceTx).not.toHaveBeenCalled();
  });
});

describe("runAutoDraftInvoices — normal run", () => {
  it("creates a running InvoiceDraftRun then updates it to completed", async () => {
    const r = await runAutoDraftInvoices(ctx, PERIOD);

    // First create the running ledger row.
    expect(mockDraftRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          status: "running",
          triggeredBy: "test",
        }),
      }),
    );
    // Then update it to completed with the counts.
    expect(mockDraftRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "completed", draftsCreated: 1, draftsSkipped: 0 }),
      }),
    );
    expect(r.status).toBe("completed");
    expect(r.draftsCreated).toBe(1);
    expect(r.runId).toBe("run-1");

    // Run-ledger lifecycle is now audited: started on create, completed on final update.
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        action: "billing.draftrun.started",
        entityType: "InvoiceDraftRun",
        entityId: "run-1",
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        action: "billing.draftrun.completed",
        entityType: "InvoiceDraftRun",
        entityId: "run-1",
        meta: expect.objectContaining({ draftsCreated: 1, draftsSkipped: 0 }),
      }),
    );
  });

  it("creates an invoice + rent charge, recomputes total, audits draft_created — and does NOT fold tenant utility/aircond", async () => {
    // Even with unbilled tenant charges available, the auto-draft must NOT fold them.
    vi.mocked(findUnbilledTenantCharges).mockResolvedValue([{ id: "elec-1", amount: "88.00" }] as never);
    await runAutoDraftInvoices(ctx, PERIOD);

    // Invoice created org-scoped, tenant_rental, with the deterministic idempotency key.
    expect(createInvoiceTx).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        orgId: ORG,
        invoiceType: "tenant_rental",
        tenancyId: TENANCY,
        idempotencyKey: `draft:${TENANCY}:${PERIOD}`,
      }),
    );
    // Rent charge synthesised at the resolved amount.
    expect(resolveMonthlyRentAmount).toHaveBeenCalledWith(fakeTx, ORG, TENANCY, expect.anything());
    expect(createRentChargeTx).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ orgId: ORG, tenancyId: TENANCY, amount: "1500.00", invoiceId: "inv-1" }),
    );
    // Utilities/aircond are NEVER folded: no charge lookup, no attach.
    expect(findUnbilledTenantCharges).not.toHaveBeenCalled();
    expect(attachChargeTx).not.toHaveBeenCalled();
    // Total recomputed and audit written inside the tx.
    expect(recomputeInvoiceTotalTx).toHaveBeenCalledWith(fakeTx, ORG, "inv-1");
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        organizationId: ORG,
        action: "billing.invoice.draft_created",
        entityType: "Invoice",
        entityId: "inv-1",
      }),
    );
    // ChargeEvent rows: ONLY one draft.created (rent). No draft.linked (electricity) event.
    expect(fakeTx.chargeEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("runAutoDraftInvoices — toggle gating", () => {
  it("includeRent:false ⇒ NO tenant draft attempted (no invoice, no rent charge), even with includeElectricity on", async () => {
    // Rent is now the ONLY tenant-side driver; the dead includeElectricity flag never drafts.
    vi.mocked(getDraftConfig).mockResolvedValue(config({ includeRent: false, includeElectricity: true }) as never);
    await runAutoDraftInvoices(ctx, PERIOD);
    expect(createInvoiceTx).not.toHaveBeenCalled();
    expect(createRentChargeTx).not.toHaveBeenCalled();
    expect(resolveMonthlyRentAmount).not.toHaveBeenCalled();
  });

  it("includeElectricity has NO effect: tenant utility/aircond is never folded even when the flag is on", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(config({ includeElectricity: true }) as never);
    // Unbilled tenant charges available — must still NOT be folded.
    vi.mocked(findUnbilledTenantCharges).mockResolvedValue([{ id: "elec-1", amount: "88.00" }] as never);
    await runAutoDraftInvoices(ctx, PERIOD);
    expect(createRentChargeTx).toHaveBeenCalledTimes(1); // rent still drafts
    expect(findUnbilledTenantCharges).not.toHaveBeenCalled();
    expect(attachChargeTx).not.toHaveBeenCalled();
  });

  it("both toggles false ⇒ no tenant drafts attempted at all", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(
      config({ includeRent: false, includeElectricity: false }) as never,
    );
    const r = await runAutoDraftInvoices(ctx, PERIOD);
    expect(listTenanciesForPeriod).not.toHaveBeenCalled();
    expect(createInvoiceTx).not.toHaveBeenCalled();
    expect(r.status).toBe("completed");
    expect(r.draftsCreated).toBe(0);
  });
});

describe("runAutoDraftInvoices — idempotency", () => {
  it("an existing draft ⇒ draftsSkipped++ and createInvoiceTx is NOT called; the retired top-up path folds nothing", async () => {
    vi.mocked(findExistingDraft).mockResolvedValue({ id: "inv-existing", status: "draft" } as never);
    // Late tenant charges exist, but the retired top-up path must NOT fold them.
    vi.mocked(findUnbilledTenantCharges).mockResolvedValue([{ id: "elec-late", amount: "88.00" }] as never);
    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(createInvoiceTx).not.toHaveBeenCalled();
    expect(createRentChargeTx).not.toHaveBeenCalled();
    expect(r.draftsSkipped).toBe(1);
    expect(r.draftsCreated).toBe(0);
    // No top-up: nothing is looked up, attached, or recomputed on the existing draft.
    expect(findUnbilledTenantCharges).not.toHaveBeenCalled();
    expect(attachChargeTx).not.toHaveBeenCalled();
    expect(recomputeInvoiceTotalTx).not.toHaveBeenCalled();
  });

  it("sweeps the PERIOD once, not once per unit it happened to bill", async () => {
    // Two reasons the sweep is period-scoped rather than derived from
    // `listTenanciesForPeriod`'s units:
    //   correctness — a tenancy whose endDate has since moved BEFORE the period
    //     start is not in that list at all, so a unit-derived sweep never reaches
    //     its stale draft;
    //   cost — a unit-derived sweep issued two queries per unit plus a
    //     transaction per invoice on EVERY run, for a synchronous HTTP endpoint.
    vi.mocked(listTenanciesForPeriod).mockResolvedValue([
      tenancy({ id: "t-out" }),
      tenancy({ id: "t-in" }), // same unitId as tenancy()
      tenancy({ id: "t-other", unitId: "unit-2" }),
    ] as never);

    await runAutoDraftInvoices(ctx, PERIOD);

    expect(reprorateRentDraftsForPeriod).toHaveBeenCalledTimes(1);
    expect(reprorateRentDraftsForPeriod).toHaveBeenCalledWith(ctx, PERIOD);
  });

  it("a failing re-proration is reported but never fails a run that drafted real invoices", async () => {
    vi.mocked(reprorateRentDraftsForPeriod).mockRejectedValueOnce(new Error("boom"));

    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(r.status).toBe("completed"); // the drafts that DID land still stand
    expect(r.draftsCreated).toBe(1);
    expect(r.errorText).toContain(`reprorate ${PERIOD}: boom`); // surfaced, not swallowed
  });

  it("includeRent:false skips the re-proration pass entirely", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(config({ includeRent: false }) as never);
    await runAutoDraftInvoices(ctx, PERIOD);
    expect(reprorateRentDraftsForPeriod).not.toHaveBeenCalled();
  });

  it("a rent charge already billed by ANOTHER path is a clean skip, not a P2002 rollback", async () => {
    // "Is this month's rent already issued?" has two answers and the idempotency
    // key only knows one of them. The meter "Post charges" flow mints the same
    // RENT-{YYYYMM}-{tenancyId} as a POSTED charge with no Invoice, so
    // findExistingDraft returns null and the drafter used to walk straight into
    // the Charge unique — correct money via an aborted transaction the caller had
    // to classify. Check-first makes it an ordinary skip.
    vi.mocked(findExistingDraft).mockResolvedValue(null as never);
    mockChargeFindFirst.mockImplementation(async (args?: { where?: { chargeNumber?: string } }) =>
      args?.where?.chargeNumber?.startsWith("RENT-")
        ? { id: "rent-already-posted" }
        : { id: "charge-x", invoiceId: null },
    );

    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(r.draftsSkipped).toBe(1);
    expect(r.draftsCreated).toBe(0);
    expect(r.status).toBe("completed");
    expect(r.errorText).toBeNull(); // NOT reported as a failure
    expect(createInvoiceTx).not.toHaveBeenCalled();
    expect(createRentChargeTx).not.toHaveBeenCalled();
    // Checked BEFORE pricing — no point resolving an amount for a month already billed.
    expect(resolveMonthlyRentAmount).not.toHaveBeenCalled();
  });

  it("an existing draft is a clean skip — never recomputes or mutates the existing invoice", async () => {
    vi.mocked(findExistingDraft).mockResolvedValue({ id: "inv-existing", status: "draft" } as never);
    vi.mocked(findUnbilledTenantCharges).mockResolvedValue([] as never);
    const r = await runAutoDraftInvoices(ctx, PERIOD);
    expect(r.draftsSkipped).toBe(1);
    expect(attachChargeTx).not.toHaveBeenCalled();
    expect(recomputeInvoiceTotalTx).not.toHaveBeenCalled();
  });

  it("a P2002 thrown by createInvoiceTx is counted as skipped and the run still completes", async () => {
    vi.mocked(createInvoiceTx).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002" } as never),
    );
    const r = await runAutoDraftInvoices(ctx, PERIOD);
    expect(r.status).toBe("completed");
    expect(r.draftsSkipped).toBe(1);
    expect(r.draftsCreated).toBe(0);
    expect(r.errorText).toBeNull();
  });

  it("a non-P2002 per-tenancy error is collected, run still completes (since another succeeds)", async () => {
    vi.mocked(listTenanciesForPeriod).mockResolvedValue([
      tenancy({ id: "11111111-aaaa-bbbb-cccc-000000000001" }),
      tenancy({ id: "22222222-aaaa-bbbb-cccc-000000000002" }),
    ] as never);
    // First tenancy blows up with a generic error; second succeeds.
    vi.mocked(createInvoiceTx)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "inv-2" } as never);
    const r = await runAutoDraftInvoices(ctx, PERIOD);
    expect(r.status).toBe("completed");
    expect(r.draftsCreated).toBe(1);
    expect(r.errorText).toContain("boom");
  });
});

describe("runAutoDraftInvoices — no-auto-approve invariant", () => {
  it("never passes approvedBy/approvedAt/status:approved anywhere it writes the invoice", async () => {
    await runAutoDraftInvoices(ctx, PERIOD);
    const invoiceArg = vi.mocked(createInvoiceTx).mock.calls[0]![1] as Record<string, unknown>;
    expect("approvedBy" in invoiceArg).toBe(false);
    expect("approvedAt" in invoiceArg).toBe(false);
    expect(invoiceArg.status).toBeUndefined(); // createInvoiceTx hard-codes status:"draft" in the repo
  });
});

describe("runAutoDraftInvoices — owner statements", () => {
  it("both toggles off (includeMgmtFee:false + includeCleaning:false) ⇒ generateStatementService NOT called, 0 owner statements", async () => {
    // Default config already has both toggles false — just verify.
    vi.mocked(listDistinctActiveOwners).mockResolvedValue(["owner-1", "owner-2"] as never);
    await runAutoDraftInvoices(ctx, PERIOD);
    expect(generateStatementService).not.toHaveBeenCalled();
    // draftsCreated comes only from tenant path (1 tenancy in default setup).
    // Owner counts must not inflate it.
    expect(vi.mocked(listDistinctActiveOwners)).not.toHaveBeenCalled();
  });

  it("toggles on with 2 owners ⇒ generateStatementService called once per owner; 201→created, 200→skipped", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(
      config({ includeMgmtFee: true, includeCleaning: true }) as never,
    );
    const OWNER_1 = "owner-aaaa";
    const OWNER_2 = "owner-bbbb";
    vi.mocked(listDistinctActiveOwners).mockResolvedValue([OWNER_1, OWNER_2] as never);
    // First owner → newly created (201); second owner → already existed (200).
    vi.mocked(generateStatementService)
      .mockResolvedValueOnce({ ok: true, status: 201, data: {} } as never)
      .mockResolvedValueOnce({ ok: true, status: 200, data: {} } as never);

    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(generateStatementService).toHaveBeenCalledTimes(2);
    expect(generateStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      expect.objectContaining({ ownerPartyId: OWNER_1, billingMonth: PERIOD }),
    );
    expect(generateStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      expect.objectContaining({ ownerPartyId: OWNER_2, billingMonth: PERIOD }),
    );
    // Tenant path created 1 (default setup) + owner path created 1 = 2 total.
    expect(r.draftsCreated).toBe(2);
    // Owner path skipped 1.
    expect(r.draftsSkipped).toBe(1);
  });
});

// ── Task 6: config + queue + run query services ──────────────────────────────

const CONFIG_ID = "00000000-0000-0000-0000-000000000099";
const ISO = "2026-06-01T00:00:00.000Z";

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    runDayOfMonth: 25,
    dueDayOffset: null,
    includeRent: true,
    includeElectricity: true,
    includeMgmtFee: false,
    includeCleaning: false,
    autoApprove: false,
    isActive: true,
    updatedAt: new Date(ISO),
    ...overrides,
  };
}

describe("getDraftConfigService", () => {
  it("returns 404 when repo returns null (no config yet)", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(null as never);
    const r = await getDraftConfigService(ctx);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("returns 200 with mapped config row when found", async () => {
    vi.mocked(getDraftConfig).mockResolvedValue(configRow() as never);
    const r = await getDraftConfigService(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(CONFIG_ID);
    expect(r.data.runDayOfMonth).toBe(25);
    expect(typeof r.data.updatedAt).toBe("string");
  });
});

describe("createDraftConfigService", () => {
  it("returns 409 when tx create throws P2002 (config already exists)", async () => {
    mockDraftConfigCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002" } as never),
    );
    const r = await createDraftConfigService(ctx, { runDayOfMonth: 25 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    // P2002 must roll the tx back — no audit row.
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("returns 201 with mapped row on success and records billing.draftconfig.created audit in-tx", async () => {
    mockDraftConfigCreate.mockResolvedValue(configRow({ runDayOfMonth: 25 }) as never);
    const r = await createDraftConfigService(ctx, { runDayOfMonth: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(201);
    expect(r.data.runDayOfMonth).toBe(25);
    // The create + audit run inside one db.$transaction.
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockDraftConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG, runDayOfMonth: 25 }) }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        organizationId: ORG,
        action: "billing.draftconfig.created",
        entityType: "DraftConfig",
        entityId: CONFIG_ID,
      }),
    );
  });
});

describe("patchDraftConfigService", () => {
  it("returns 409 when withStaleCheck yields null (stale concurrency)", async () => {
    // withStaleCheck returns null when the guarded update hits P2025 (0 rows matched)
    mockWithStaleCheck.mockResolvedValue(null);
    const r = await patchDraftConfigService(ctx, CONFIG_ID, {
      expectedUpdatedAt: ISO,
      runDayOfMonth: 20,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(mockWithStaleCheck).toHaveBeenCalled();
    // Audit must NOT fire when the stale check rejects
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("returns 200 with patched row and records audit when update succeeds", async () => {
    const updated = configRow({ runDayOfMonth: 20, updatedAt: new Date("2026-06-02T00:00:00.000Z") });
    mockWithStaleCheck.mockResolvedValue(updated);
    const r = await patchDraftConfigService(ctx, CONFIG_ID, {
      expectedUpdatedAt: ISO,
      runDayOfMonth: 20,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.data.runDayOfMonth).toBe(20);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "billing.draftconfig.updated",
        entityType: "DraftConfig",
        entityId: CONFIG_ID,
      }),
    );
  });
});

describe("listDraftRunsService", () => {
  it("returns items + total from repo", async () => {
    const runRow = {
      id: "run-1", periodMonth: new Date(ISO), runDate: new Date(ISO),
      status: "completed", draftsCreated: 3, draftsSkipped: 1,
      errorText: null, triggeredBy: "system:auto-draft", createdAt: new Date(ISO),
    };
    vi.mocked(listDraftRuns).mockResolvedValue({ rows: [runRow], total: 1 } as never);
    const r = await listDraftRunsService(ctx, { limit: 20, offset: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.items).toHaveLength(1);
    expect(r.data.items[0]!.status).toBe("completed");
    expect(typeof r.data.items[0]!.periodMonth).toBe("string");
    // Verify pagination args were passed through
    expect(listDraftRuns).toHaveBeenCalledWith(ORG, expect.objectContaining({ limit: 20, offset: 0 }));
  });
});

describe("getDraftRunService", () => {
  it("returns 404 when repo resolves null (unknown id)", async () => {
    vi.mocked(getDraftRun).mockResolvedValue(null as never);
    const r = await getDraftRunService(ctx, "00000000-0000-0000-0000-000000000000");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("returns 200 with mapped row when found", async () => {
    const runRow = {
      id: "run-1", periodMonth: new Date(ISO), runDate: new Date(ISO),
      status: "completed", draftsCreated: 2, draftsSkipped: 0,
      errorText: null, triggeredBy: "test", createdAt: new Date(ISO),
    };
    vi.mocked(getDraftRun).mockResolvedValue(runRow as never);
    const r = await getDraftRunService(ctx, "run-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe("run-1");
    expect(r.data.draftsCreated).toBe(2);
  });
});

describe("listDraftInvoicesService", () => {
  it("returns mapped items + total and passes pagination args to repo", async () => {
    const invRow = {
      id: "inv-1", invoiceNumber: "TR-202606-aa", invoiceType: "tenant_rental", status: "draft",
      party: { displayName: "Tenant A" }, tenancy: { tenancyCode: "T-001" },
      periodMonth: new Date(ISO), invoiceDate: new Date(ISO), dueDate: null,
      totalAmount: { toString: () => "1500.00" }, sstAmount: null, updatedAt: new Date(ISO),
    };
    vi.mocked(listDraftInvoices).mockResolvedValue({ rows: [invRow], total: 1 } as never);
    const r = await listDraftInvoicesService(ctx, { status: "draft", limit: 20, offset: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.items).toHaveLength(1);
    expect(r.data.items[0]!.status).toBe("draft");
    expect(r.data.items[0]!.partyName).toBe("Tenant A");
    expect(r.data.items.every((i) => i.status === "draft")).toBe(true);
    // Verify pagination + filter args passed through
    expect(listDraftInvoices).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ status: "draft", limit: 20, offset: 0 }),
    );
  });
});

describe("getDraftInvoiceService", () => {
  it("returns 404 when repo resolves null (unknown id)", async () => {
    vi.mocked(getDraftInvoiceWithCharges).mockResolvedValue(null as never);
    const r = await getDraftInvoiceService(ctx, "00000000-0000-0000-0000-000000000000");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("returns 200 with invoice detail including charges when found", async () => {
    const invRow = {
      id: "inv-1", invoiceNumber: "TR-202606-aa", invoiceType: "tenant_rental", status: "draft",
      party: { displayName: "Tenant A" }, tenancy: { tenancyCode: "T-001" },
      periodMonth: new Date(ISO), invoiceDate: new Date(ISO), dueDate: null,
      totalAmount: { toString: () => "1500.00" }, sstAmount: null, updatedAt: new Date(ISO),
      charges: [
        { id: "c-1", chargeNumber: "RENT-202606-aa", chargeType: "rent", status: "draft", amount: { toString: () => "1500.00" }, description: "Monthly rent" },
      ],
    };
    vi.mocked(getDraftInvoiceWithCharges).mockResolvedValue(invRow as never);
    const r = await getDraftInvoiceService(ctx, "inv-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe("inv-1");
    expect(r.data.charges).toHaveLength(1);
    expect(r.data.charges[0]!.chargeType).toBe("rent");
    expect(typeof r.data.charges[0]!.amount).toBe("number");
  });
});

// ── Task 7: invoice transitions (approve / bulk / void / edit-dates / attach / detach) ──

const INVOICE_ID = "00000000-0000-0000-0000-0000000000aa";
const txCtx = { orgId: ORG, actorUserId: ACTOR, actorRole: "manager" as const };

describe("approveInvoiceService", () => {
  it("flips draft → approved, stamps approvedBy/approvedAt, audits (review-only when the billing-docs flag is off)", async () => {
    mockChargeFindMany.mockResolvedValue([{ id: "c-1" }, { id: "c-2" }]);
    const r = await approveInvoiceService(txCtx, INVOICE_ID, ISO);
    expect(r.ok && r.status === 200).toBe(true);

    // update guarded by withStaleCheck with status:"draft" + updatedAt in WHERE.
    expect(mockWithStaleCheck).toHaveBeenCalled();
    const updateArg = mockInvoiceUpdate.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(updateArg.where).toMatchObject({ id: INVOICE_ID, organizationId: ORG, status: "draft" });
    expect(updateArg.where.updatedAt).toBeInstanceOf(Date);
    expect(updateArg.data).toMatchObject({ status: "approved", approvedBy: ACTOR });
    expect(updateArg.data.approvedAt).toBeInstanceOf(Date);

    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ organizationId: ORG, action: "billing.invoice.approved", entityType: "Invoice", entityId: INVOICE_ID }),
    );
    // Billing-docs flag OFF in this unit env → approval is REVIEW-ONLY: charges are
    // not posted here and no charge events are written (mint-on-post preserved — a
    // documented posting happens via the flag-ON path, covered in mint-on-post-invariant).
    expect(fakeTx.chargeEvent.create).not.toHaveBeenCalled();
  });

  it("returns 409 when withStaleCheck yields null (not draft / stale) and does NOT audit", async () => {
    mockWithStaleCheck.mockResolvedValue(null);
    const r = await approveInvoiceService(txCtx, INVOICE_ID, ISO);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(recordAudit).not.toHaveBeenCalled();
    expect(fakeTx.chargeEvent.create).not.toHaveBeenCalled();
  });
});

describe("approveBulkService", () => {
  it("approves only ids whose update matched (draft); non-draft/stale are skipped, batch never throws", async () => {
    // id-1 matches (approved), id-2 yields null (not draft → skipped).
    mockWithStaleCheck
      .mockImplementationOnce(async (fn: () => Promise<unknown>) => fn()) // id-1 ok
      .mockResolvedValueOnce(null); // id-2 skipped
    const r = await approveBulkService(txCtx, ["id-1", "id-2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.approved).toEqual(["id-1"]);
    expect(r.data.skipped).toEqual(["id-2"]);
  });
});

describe("voidInvoiceService", () => {
  it("voids from approved: WHERE constrains status in [draft,approved] + updatedAt; sets status void; audits with reason", async () => {
    mockChargeFindMany.mockResolvedValue([]);
    const r = await voidInvoiceService(txCtx, INVOICE_ID, ISO, "duplicate");
    expect(r.ok && r.status === 200).toBe(true);

    const updateArg = mockInvoiceUpdate.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(updateArg.where).toMatchObject({ id: INVOICE_ID, organizationId: ORG, status: { in: ["draft", "approved"] } });
    expect(updateArg.where.updatedAt).toBeInstanceOf(Date);
    expect(updateArg.data).toMatchObject({ status: "void" });
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ action: "billing.invoice.voided", entityType: "Invoice", entityId: INVOICE_ID, meta: { reason: "duplicate" } }),
    );
  });

  it("voids both draft legs of an inclusive TA pair and never detaches either leg", async () => {
    mockChargeFindMany.mockResolvedValue([
      {
        id: "ta-base", chargeNumber: "TA-1", chargeType: "tenancy_agreement_fee", status: "draft",
        parentChargeId: null, sstRate: { toString: () => "8" },
      },
      {
        id: "ta-tax", chargeNumber: "TA-1-SST", chargeType: "tenancy_agreement_fee", status: "draft",
        parentChargeId: "ta-base", sstRate: { toString: () => "0" },
      },
    ]);

    const r = await voidInvoiceService(txCtx, INVOICE_ID, ISO, "cancelled before issue");

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(mockChargeUpdate).toHaveBeenCalledTimes(2);
    expect(mockChargeUpdate.mock.calls.map((call) => call[0].where.id)).toEqual(["ta-base", "ta-tax"]);
    expect(detachChargeTx).not.toHaveBeenCalled();
  });

  it("refuses an approved/live inclusive TA pair so its document cannot be orphaned", async () => {
    mockChargeFindMany.mockResolvedValue([
      {
        id: "ta-base", chargeNumber: "TA-1", chargeType: "tenancy_agreement_fee", status: "posted",
        parentChargeId: null, sstRate: { toString: () => "8" },
      },
      {
        id: "ta-tax", chargeNumber: "TA-1-SST", chargeType: "tenancy_agreement_fee", status: "posted",
        parentChargeId: "ta-base", sstRate: { toString: () => "0" },
      },
    ]);

    const r = await voidInvoiceService(txCtx, INVOICE_ID, ISO, "wrong amount");

    expect(r).toEqual({
      ok: false,
      status: 409,
      error: "PAIRED_TA_REQUIRES_ACCOUNTING_CORRECTION",
    });
    expect(mockChargeUpdate).not.toHaveBeenCalled();
    expect(detachChargeTx).not.toHaveBeenCalled();
  });

  it("returns 409 when withStaleCheck yields null (wrong state e.g. sent/paid) and does NOT touch charges", async () => {
    mockWithStaleCheck.mockResolvedValue(null);
    const r = await voidInvoiceService(txCtx, INVOICE_ID, ISO);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(mockChargeFindMany).not.toHaveBeenCalled();
    expect(detachChargeTx).not.toHaveBeenCalled();
    expect(mockChargeUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("voids the synthesized rent charge but DETACHES electricity; never deletes; ChargeEvent per affected charge", async () => {
    mockChargeFindMany.mockResolvedValue([
      { id: "rent-1", chargeType: "rent" },
      { id: "elec-1", chargeType: "aircond" },
    ]);
    const r = await voidInvoiceService(txCtx, INVOICE_ID, ISO);
    expect(r.ok).toBe(true);

    // rent → tx.charge.update status:"void"; electricity → detachChargeTx.
    expect(mockChargeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rent-1", organizationId: ORG },
        data: expect.objectContaining({ status: "void" }),
      }),
    );
    expect(detachChargeTx).toHaveBeenCalledWith(fakeTx, ORG, "elec-1");
    // electricity must NOT be voided via charge.update.
    expect(mockChargeUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "elec-1" }) }),
    );
    // Two ChargeEvents (one per affected charge), no deletion anywhere.
    expect(fakeTx.chargeEvent.create).toHaveBeenCalledTimes(2);
    expect("delete" in fakeTx.charge).toBe(false);
  });
});

describe("editInvoiceDatesService", () => {
  it("updates ONLY invoiceDate/dueDate while draft; never amounts; guarded by withStaleCheck; audits", async () => {
    const r = await editInvoiceDatesService(txCtx, INVOICE_ID, {
      invoiceDate: "2026-06-05T00:00:00.000Z",
      dueDate: "2026-06-20T00:00:00.000Z",
      expectedUpdatedAt: ISO,
    });
    expect(r.ok && r.status === 200).toBe(true);

    const updateArg = mockInvoiceUpdate.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(updateArg.where).toMatchObject({ id: INVOICE_ID, organizationId: ORG, status: "draft" });
    expect(updateArg.where.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(updateArg.data).sort()).toEqual(["dueDate", "invoiceDate"]);
    expect("totalAmount" in updateArg.data).toBe(false);
    expect("status" in updateArg.data).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ action: "billing.invoice.dates_edited", entityType: "Invoice", entityId: INVOICE_ID }),
    );
  });

  it("returns 409 when withStaleCheck yields null (not draft / stale)", async () => {
    mockWithStaleCheck.mockResolvedValue(null);
    const r = await editInvoiceDatesService(txCtx, INVOICE_ID, { dueDate: "2026-06-20T00:00:00.000Z", expectedUpdatedAt: ISO });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("editDraftChargeAmountService", () => {
  it("updates a draft charge amount + outstanding, recomputes total, and audits", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft", updatedAt: new Date(ISO) });
    mockChargeFindFirst.mockResolvedValue({
      id: "charge-x", invoiceId: INVOICE_ID, status: "draft", chargeType: "security_deposit",
      amount: { toString: () => "1064.52" },
    });
    vi.mocked(recomputeInvoiceTotalTx).mockResolvedValue(1200);

    const r = await editDraftChargeAmountService(txCtx, INVOICE_ID, "charge-x", {
      amount: 1200,
      expectedUpdatedAt: ISO,
    });

    expect(r).toEqual({ ok: true, status: 200, data: { id: INVOICE_ID, chargeId: "charge-x", totalAmount: 1200 } });
    expect(mockChargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "charge-x", organizationId: ORG },
      data: { amount: "1200.00", outstandingAmount: "1200.00" },
    }));
    expect(recomputeInvoiceTotalTx).toHaveBeenCalledWith(fakeTx, ORG, INVOICE_ID);
    expect(fakeTx.chargeEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: "draft.amount_manually_edited" }),
    }));
    expect(recordAudit).toHaveBeenCalledWith(fakeTx, expect.objectContaining({
      action: "billing.invoice.charge_amount_edited",
    }));
  });

  it("refuses to edit a non-draft invoice", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "approved", updatedAt: new Date(ISO) });
    const r = await editDraftChargeAmountService(txCtx, INVOICE_ID, "charge-x", {
      amount: 1200,
      expectedUpdatedAt: ISO,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(mockChargeUpdate).not.toHaveBeenCalled();
  });

  it("refuses a manual amount edit on an inclusive TA pair", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft", updatedAt: new Date(ISO) });
    mockChargeFindFirst.mockResolvedValue({
      id: "ta-base",
      invoiceId: INVOICE_ID,
      status: "draft",
      amount: { toString: () => "462.96" },
      chargeNumber: "TA-1",
      chargeType: "tenancy_agreement_fee",
      parentChargeId: null,
      sstRate: { toString: () => "8" },
    });

    const r = await editDraftChargeAmountService(txCtx, INVOICE_ID, "ta-base", {
      amount: 500,
      expectedUpdatedAt: ISO,
    });

    expect(r).toEqual({ ok: false, status: 409, error: "PAIRED_TA_EDIT_FROM_TENANCY" });
    expect(mockChargeUpdate).not.toHaveBeenCalled();
  });
});

describe("attachChargeService", () => {
  it("returns 404 when the invoice is missing", async () => {
    mockInvoiceFindFirst.mockResolvedValue(null);
    const r = await attachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(attachChargeTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the invoice exists but is NOT draft", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "approved" });
    const r = await attachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(attachChargeTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the charge already has an invoiceId (already attached)", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft" });
    mockChargeFindFirst.mockResolvedValue({ id: "charge-x", invoiceId: "other-invoice" });
    const r = await attachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(attachChargeTx).not.toHaveBeenCalled();
  });

  it("attaches an unlinked charge to a draft invoice: attachChargeTx + recompute + ChargeEvent(draft.linked) + audit", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft" });
    mockChargeFindFirst.mockResolvedValue({ id: "charge-x", invoiceId: null });
    const r = await attachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok && r.status === 200).toBe(true);
    expect(attachChargeTx).toHaveBeenCalledWith(fakeTx, ORG, "charge-x", INVOICE_ID);
    expect(recomputeInvoiceTotalTx).toHaveBeenCalledWith(fakeTx, ORG, INVOICE_ID);
    expect(fakeTx.chargeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: "draft.linked", chargeId: "charge-x" }) }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ action: "billing.invoice.charge_attached", entityType: "Invoice", entityId: INVOICE_ID }),
    );
  });
});

describe("detachChargeService", () => {
  it("returns 404 when the invoice is missing", async () => {
    mockInvoiceFindFirst.mockResolvedValue(null);
    const r = await detachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(detachChargeTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the invoice exists but is NOT a draft (cannot strip a charge off an approved invoice)", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "approved" });
    const r = await detachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    if (r.ok) return;
    expect(r.error).toMatch(/not a draft/i);
    expect(detachChargeTx).not.toHaveBeenCalled();
    expect(recomputeInvoiceTotalTx).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when the charge is missing", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft" });
    mockChargeFindFirst.mockResolvedValue(null);
    const r = await detachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(detachChargeTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the charge belongs to a DIFFERENT invoice (cross-invoice corruption guard)", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft" });
    // charge is attached to invoice B, not the path invoice (INVOICE_ID = A).
    mockChargeFindFirst.mockResolvedValue({ id: "charge-x", invoiceId: "other-invoice-b" });
    const r = await detachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    if (r.ok) return;
    expect(r.error).toMatch(/not attached to this invoice/i);
    // Must NOT detach B's charge nor recompute A.
    expect(detachChargeTx).not.toHaveBeenCalled();
    expect(recomputeInvoiceTotalTx).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("calls detachChargeTx + recompute, emits ChargeEvent(draft.unlinked), audits, and never deletes", async () => {
    mockInvoiceFindFirst.mockResolvedValue({ id: INVOICE_ID, status: "draft" });
    // Charge belongs to THIS invoice → happy path.
    mockChargeFindFirst.mockResolvedValue({ id: "charge-x", invoiceId: INVOICE_ID });
    const r = await detachChargeService(txCtx, INVOICE_ID, "charge-x");
    expect(r.ok && r.status === 200).toBe(true);
    expect(detachChargeTx).toHaveBeenCalledWith(fakeTx, ORG, "charge-x");
    expect(recomputeInvoiceTotalTx).toHaveBeenCalledWith(fakeTx, ORG, INVOICE_ID);
    expect(fakeTx.chargeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: "draft.unlinked", chargeId: "charge-x" }) }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({ action: "billing.invoice.charge_detached", entityType: "Invoice", entityId: INVOICE_ID }),
    );
    expect("delete" in fakeTx.charge).toBe(false);
  });
});

describe("runAutoDraftInvoices — nothing to bill for the period", () => {
  // B12 — a tenancy that did not occupy the period prorates to 0.00. The cron must
  // not mint a RM0.00 rent charge (nor the empty tenant_rental invoice that carries
  // it): postMonthlyRentForTenancy already guards this exact case, and the cron
  // silently did not. A replacement tenancy starting after the billed month is the
  // real-world trigger.
  it("skips zero-amount rent instead of minting an RM0 charge", async () => {
    vi.mocked(resolveMonthlyRentAmount).mockResolvedValue("0.00");

    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(createRentChargeTx).not.toHaveBeenCalled();
    expect(createInvoiceTx).not.toHaveBeenCalled();
    expect(r.draftsCreated).toBe(0);
    expect(r.draftsSkipped).toBe(1);
    expect(r.status).toBe("completed");
  });

  it("still bills a tenancy whose prorated rent is a partial month", async () => {
    vi.mocked(resolveMonthlyRentAmount).mockResolvedValue("993.55");

    const r = await runAutoDraftInvoices(ctx, PERIOD);

    expect(createRentChargeTx).toHaveBeenCalledTimes(1);
    expect(createRentChargeTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: "993.55" }),
    );
    expect(r.draftsCreated).toBe(1);
  });
});
