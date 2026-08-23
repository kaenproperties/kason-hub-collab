/**
 * Unit tests for the move-in deposit hook (tenancy-deposits.ts).
 *
 * The subject here is the GATES, not the arithmetic: a deposit that escapes any one of
 * them is real money billed to a tenant who does not owe it. Each gate gets a test that
 * fails CLOSED, and the happy path is pinned to the reported scenario (RM5 tenancy rent
 * ⇒ RM10 + RM2.50, NOT the RM1,500 asking rate's RM3,000 + RM750).
 *
 * DB mock follows the auto-draft.service.test.ts template: getDb() returns fakes and
 * $transaction(fn) invokes fn(fakeTx) so the creating work runs synchronously.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTenancyFindFirst = vi.fn();
const mockTenancyFindMany = vi.fn();
const mockOrgFindUnique = vi.fn();
const mockChargeFindFirst = vi.fn();
// Typed arg so `.mock.calls[i][0].data` is reachable without an unknown-cast dance.
type ChargeCreateArgs = { data: Record<string, unknown> & { amount: string } };
const mockChargeCreate = vi.fn(async (_args: ChargeCreateArgs) => ({ id: "charge-1" }));
const mockCategoryFindMany = vi.fn();
type InvoiceCreateArgs = { data: Record<string, unknown> & { periodMonth?: Date } };
const mockInvoiceCreate = vi.fn(async (_args: InvoiceCreateArgs) => ({ id: "invoice-1" }));
const mockInvoiceFindFirst = vi.fn();
type ExistingCharge = { id: string; chargeNumber: string; status: string };
const mockChargeFindMany = vi.fn(async (): Promise<ExistingCharge[]> => []);
const mockChargeUpdate = vi.fn(async () => ({ id: "charge-1" }));
const mockInvoiceUpdate = vi.fn();
const mockAuditCreate = vi.fn();

const fakeTx = {
  charge: {
    findFirst: mockChargeFindFirst,
    create: mockChargeCreate,
    findMany: mockChargeFindMany,
    update: mockChargeUpdate,
  },
  chargeCategory: { findMany: mockCategoryFindMany },
  chargeEvent: { create: vi.fn(async () => ({ id: "evt-1" })) },
  invoice: { findFirst: mockInvoiceFindFirst, create: mockInvoiceCreate, update: mockInvoiceUpdate },
  auditLog: { create: mockAuditCreate },
};
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    tenancy: { findFirst: mockTenancyFindFirst, findMany: mockTenancyFindMany },
    organization: { findUnique: mockOrgFindUnique },
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

vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("../../charge-categories/seed", () => ({ ensureChargeCategorySeeds: vi.fn(async () => undefined) }));

const mockFlagEnabled = vi.fn((_flag: string) => true);
vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: (f: string) => mockFlagEnabled(f as never),
}));

import { createTenancyDepositsForTenancy } from "../tenancy-deposits";

const CTX = { orgId: "org-1", userId: "user-1", role: "admin" };
// "Now" and the tenancy's start date both sit in Aug 2026, matching the reported flow.
const NOW = new Date("2026-08-17T04:00:00.000Z");

/** A tenancy that passes every gate — individual tests knock ONE prop out. */
function tenancyRow(over: Record<string, unknown> = {}) {
  return {
    id: "tenancy-1",
    unitId: "unit-1",
    tenantPartyId: "party-1",
    propertyId: "property-1",
    startDate: new Date("2026-08-17T00:00:00.000Z"),
    status: "active",
    monthlyRentAmount: { toString: () => "5" },
    previousTenancyId: null,
    unit: {
      id: "unit-1",
      rentalRate: { toString: () => "1500" },
      ownerPartyId: "owner-1",
      depositMonths: { toString: () => "2" },
      utilitiesDepositMonths: { toString: () => "0.5" },
      apartment: { underManagement: true },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlagEnabled.mockReturnValue(true);
  mockOrgFindUnique.mockResolvedValue({ timezone: "Asia/Kuala_Lumpur" });
  mockChargeFindFirst.mockResolvedValue(null);
  mockChargeFindMany.mockResolvedValue([]);
  mockInvoiceFindFirst.mockResolvedValue(null);
  mockCategoryFindMany.mockResolvedValue([
    { id: "cat-rental", code: "tenancy_rental_deposit" },
    { id: "cat-utility", code: "tenancy_utility_deposit" },
  ]);
  mockChargeCreate.mockResolvedValue({ id: "charge-1" });
  mockInvoiceCreate.mockResolvedValue({ id: "invoice-1" });
});

describe("createTenancyDepositsForTenancy — happy path", () => {
  it("prices BOTH deposits off the TENANCY rent, never the listing's asking rate", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toMatchObject({ created: true, invoiceId: "invoice-1" });
    const amounts = mockChargeCreate.mock.calls.map((c) => c[0].data.amount);
    // 2 × RM5 and 0.5 × RM5 — NOT 2 × RM1500 (3000.00) and 0.5 × RM1500 (750.00).
    expect(amounts).toEqual(["10.00", "2.50"]);
    expect(amounts).not.toContain("3000.00");
    expect(amounts).not.toContain("750.00");
  });

  it("classifies deposits as owner-collected, never manager revenue", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());
    await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    for (const call of mockChargeCreate.mock.calls) {
      expect(call[0].data).toMatchObject({
        commercialPurpose: "DEPOSIT",
        revenueRecognition: "third_party_collection",
        settlementRecipient: "owner",
        status: "draft",
        sstRate: "0",
      });
    }
  });

  it("writes deterministic once-per-tenancy charge numbers with no month component", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());
    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toMatchObject({ chargeNumbers: ["DEPRENT-tenancy-1", "DEPUTIL-tenancy-1"] });
  });
});

describe("GATE — move-in must be the org-local CURRENT month", () => {
  it("refuses a tenancy whose move-in was LAST month, however late it is keyed in", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ startDate: new Date("2026-07-20T00:00:00.000Z") }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "move_in_not_current_month" });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("allows a move-in dated NEXT month for the one-month advance billing window", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ startDate: new Date("2026-09-01T00:00:00.000Z") }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toMatchObject({ created: true, invoiceId: "invoice-1" });
    expect(mockInvoiceCreate.mock.calls[0]?.[0]?.data.periodMonth).toBeDefined();
  });

  it("fails CLOSED when the org has no timezone — never falls back to UTC", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());
    mockOrgFindUnique.mockResolvedValue(null);

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "move_in_not_current_month" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });
});

describe("GATE — the apartment must be under KAEN management", () => {
  it("refuses when underManagement is false", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({
        unit: { ...tenancyRow().unit, apartment: { underManagement: false } },
      }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "not_under_management" });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("refuses when the apartment relation is missing — absent is NOT the column default", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ unit: { ...tenancyRow().unit, apartment: null } }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "not_under_management" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });
});

describe("GATE — flag, owner, renewal, and once-per-tenancy", () => {
  it("is a hard no-op while the flag is dark — not even a tenancy read", async () => {
    mockFlagEnabled.mockReturnValue(false);

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "flag_off" });
    expect(mockTenancyFindFirst).not.toHaveBeenCalled();
  });

  it("refuses an owner-less unit rather than throwing PRINCIPAL_OWNER_REQUIRED at approval", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ unit: { ...tenancyRow().unit, ownerPartyId: null } }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "no_owner_party" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("never charges a RENEWAL a second deposit", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow({ previousTenancyId: "tenancy-0" }));

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "is_renewal" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("skips when a deposit charge already exists — once per tenancy, forever", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());
    mockChargeFindMany.mockResolvedValue([{ id: "existing-charge", chargeNumber: "DEPRENT-tenancy-1", status: "posted" }]);

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "already_created" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });

  it("raises only the recorded leg when utilities months are NULL — never a guessed default", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ unit: { ...tenancyRow().unit, utilitiesDepositMonths: null } }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toMatchObject({ created: true, chargeNumbers: ["DEPRENT-tenancy-1"] });
    const amounts = mockChargeCreate.mock.calls.map((c) => c[0].data.amount);
    // 0.5 is the FORM's default, not a billing default: an un-entered field bills nothing.
    expect(amounts).toEqual(["10.00"]);
  });

  it("raises nothing when the tenancy rent is zero", async () => {
    mockTenancyFindFirst.mockResolvedValue(
      tenancyRow({ monthlyRentAmount: { toString: () => "0" } }),
    );

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toEqual({ created: false, reason: "no_rent_basis" });
    expect(mockChargeCreate).not.toHaveBeenCalled();
  });
});

describe("draft deposit synchronisation after editing a unit", () => {
  it("adds a newly entered utilities deposit to the existing unissued draft", async () => {
    mockTenancyFindFirst.mockResolvedValue(tenancyRow());
    mockInvoiceFindFirst.mockResolvedValue({ id: "invoice-1", status: "draft" });
    mockChargeFindMany.mockResolvedValue([
      { id: "rental-charge", chargeNumber: "DEPRENT-tenancy-1", status: "draft" },
    ]);

    const out = await createTenancyDepositsForTenancy(CTX, "tenancy-1", NOW);

    expect(out).toMatchObject({
      created: true,
      invoiceId: "invoice-1",
      chargeNumbers: ["DEPRENT-tenancy-1", "DEPUTIL-tenancy-1"],
    });
    expect(mockChargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "rental-charge", organizationId: "org-1" },
      data: expect.objectContaining({ amount: "10.00", status: "draft" }),
    }));
    expect(mockChargeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        chargeNumber: "DEPUTIL-tenancy-1",
        amount: "2.50",
        invoiceId: "invoice-1",
      }),
    }));
  });
});
