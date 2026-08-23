import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Collaborator mocks (paths are test-file-relative).
const mintDocumentNumberTx = vi.fn();
const ensureChargeCategorySeeds = vi.fn();
const recordAudit = vi.fn();
const documentSeriesFindFirst = vi.fn();
const supplierExpenseCreate = vi.fn();
const supplierExpenseFindMany = vi.fn();
const chargeCategoryFindMany = vi.fn();
const kaenOperatingExpenseCreateMany = vi.fn();

vi.mock("../../../lib/reference-codes/series-numbers", () => ({
  mintDocumentNumberTx: (...a: unknown[]) => mintDocumentNumberTx(...a),
}));
vi.mock("../../charge-categories/seed", () => ({
  ensureChargeCategorySeeds: (...a: unknown[]) => ensureChargeCategorySeeds(...a),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    supplierExpense: { findMany: (...a: unknown[]) => supplierExpenseFindMany(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        documentSeries: { findFirst: (...a: unknown[]) => documentSeriesFindFirst(...a) },
        supplierExpense: { create: (...a: unknown[]) => supplierExpenseCreate(...a) },
        chargeCategory: { findMany: (...a: unknown[]) => chargeCategoryFindMany(...a) },
        kaenOperatingExpense: { createMany: (...a: unknown[]) => kaenOperatingExpenseCreateMany(...a) },
        auditLog: { create: vi.fn() },
      }),
  }),
}));

import { createSupplierExpenseService, ExpenseError, listSupplierExpensesService } from "../expenses.service";

const CTX = { orgId: "org-1", actorUserId: "user-1", actorRole: "editor" };
const goodInput = {
  supplierName: "ABC Plumbing",
  expenseDate: "2026-07-22",
  totalAmount: "400.00",
  allocations: [
    { borneBy: "tenant" as const, amount: "120.00" },
    { borneBy: "owner" as const, amount: "280.00" },
  ],
};

describe("listSupplierExpensesService permission scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supplierExpenseFindMany.mockResolvedValue([]);
  });

  it("limits a claim creator to claims they created", async () => {
    await listSupplierExpensesService(CTX, { ownOnly: true });

    expect(supplierExpenseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          status: "recorded",
          createdById: "user-1",
        },
      }),
    );
  });

  it("does not apply creator filtering to users allowed to view all claims or costs", async () => {
    await listSupplierExpensesService(CTX, { ownOnly: false });

    expect(supplierExpenseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", status: "recorded" },
      }),
    );
  });
});

describe("createSupplierExpenseService (P3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENABLE_KAEN_OPEX;
    documentSeriesFindFirst.mockResolvedValue({ id: "series-exp", code: "EXP", prefix: "EXP", padding: 4, includeYear: false });
    mintDocumentNumberTx.mockResolvedValue("EXP-0001");
    supplierExpenseCreate.mockResolvedValue({ id: "exp-1", expenseNumber: "EXP-0001" });
    chargeCategoryFindMany.mockResolvedValue([]);
    kaenOperatingExpenseCreateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    delete process.env.ENABLE_KAEN_OPEX;
  });

  it("re-asserts the split invariant (rejects a mis-split BEFORE any DB write)", async () => {
    const bad = { ...goodInput, allocations: [{ borneBy: "tenant" as const, amount: "120.00" }] }; // Σ=120 ≠ 400
    await expect(createSupplierExpenseService(CTX, bad)).rejects.toMatchObject({
      name: "ExpenseError",
      status: 400,
      code: "ALLOCATIONS_NOT_FULLY_ALLOCATED",
    });
    expect(supplierExpenseCreate).not.toHaveBeenCalled();
  });

  it("mints an EXP- number and creates the expense with its allocations", async () => {
    const res = await createSupplierExpenseService(CTX, goodInput);
    expect(res).toEqual({ id: "exp-1", expenseNumber: "EXP-0001" });
    expect(ensureChargeCategorySeeds).toHaveBeenCalledWith("org-1");
    expect(mintDocumentNumberTx).toHaveBeenCalledTimes(1);
    const createArg = supplierExpenseCreate.mock.calls[0][0];
    expect(createArg.data.expenseNumber).toBe("EXP-0001");
    expect(createArg.data.organizationId).toBe("org-1");
    expect(createArg.data.allocations.create).toHaveLength(2);
    expect(createArg.data.allocations.create[0]).toMatchObject({ borneBy: "tenant", amount: "120.00" });
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the EXP series is missing", async () => {
    documentSeriesFindFirst.mockResolvedValue(null);
    await expect(createSupplierExpenseService(CTX, goodInput)).rejects.toMatchObject({
      name: "ExpenseError",
      status: 500,
      code: "EXP_SERIES_NOT_FOUND",
    });
    expect(supplierExpenseCreate).not.toHaveBeenCalled();
  });
});

// P6 — KAEN operating-expense ledger routing. borneBy:"kaen" allocations ALSO create a
// KaenOperatingExpense row (same tx, idempotent on sourceExpenseAllocationId) when
// ENABLE_KAEN_OPEX is ON. tenant/owner allocations are never routed here (P4/P5's concern).
describe("createSupplierExpenseService — KAEN opex routing (P6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENABLE_KAEN_OPEX;
    documentSeriesFindFirst.mockResolvedValue({ id: "series-exp", code: "EXP", prefix: "EXP", padding: 4, includeYear: false });
    mintDocumentNumberTx.mockResolvedValue("EXP-0002");
    chargeCategoryFindMany.mockResolvedValue([]);
    kaenOperatingExpenseCreateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    delete process.env.ENABLE_KAEN_OPEX;
  });

  const kaenInput = {
    supplierName: "Acme Software",
    expenseDate: "2026-07-22",
    totalAmount: "150.00",
    allocations: [{ borneBy: "kaen" as const, amount: "150.00" }],
  };

  it("routes a kaen allocation to the KAEN opex ledger when the flag is ON", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-kaen-1",
      expenseNumber: "EXP-0002",
      allocations: [
        {
          id: "alloc-kaen-1",
          borneBy: "kaen",
          amount: "150.00",
          chargeCategoryId: null,
          description: null,
          // partyId/tenancyId present on the DB-returned row to prove routing ignores them
          // (KaenOperatingExpense has no such fields — an exact toEqual below would fail
          // if they leaked through).
          partyId: "party-x",
          tenancyId: "tenancy-x",
        },
      ],
    });

    await createSupplierExpenseService(CTX, kaenInput);

    expect(kaenOperatingExpenseCreateMany).toHaveBeenCalledTimes(1);
    const arg = kaenOperatingExpenseCreateMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toEqual([
      {
        organizationId: "org-1",
        sourceExpenseAllocationId: "alloc-kaen-1",
        category: "other_expense",
        description: null,
        amount: "150.00",
        expenseDate: new Date("2026-07-22T00:00:00.000Z"),
        createdById: "user-1",
      },
    ]);
  });

  it("does not touch the kaen-opex ledger when no allocation is kaen-borne", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-1",
      expenseNumber: "EXP-0001",
      allocations: [
        { id: "alloc-tenant-1", borneBy: "tenant", amount: "120.00", chargeCategoryId: null, description: null },
        { id: "alloc-owner-1", borneBy: "owner", amount: "280.00", chargeCategoryId: null, description: null },
      ],
    });

    await createSupplierExpenseService(CTX, goodInput);

    expect(kaenOperatingExpenseCreateMany).not.toHaveBeenCalled();
  });

  it("resolves the category name from chargeCategoryId when it exists (even if the category is inactive)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-kaen-2",
      expenseNumber: "EXP-0002",
      allocations: [
        { id: "alloc-kaen-2", borneBy: "kaen", amount: "150.00", chargeCategoryId: "cat-1", description: "Zoom subscription" },
      ],
    });
    // active:false in the real row — the resolver deliberately does not filter on `active`,
    // proven below by the exact where-clause match (no `active` key).
    chargeCategoryFindMany.mockResolvedValue([{ id: "cat-1", name: "Software Subscriptions" }]);

    await createSupplierExpenseService(CTX, kaenInput);

    expect(chargeCategoryFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["cat-1"] } },
      select: { id: true, name: true },
    });
    const arg = kaenOperatingExpenseCreateMany.mock.calls[0][0];
    expect(arg.data[0]).toMatchObject({
      sourceExpenseAllocationId: "alloc-kaen-2",
      category: "Software Subscriptions",
      description: "Zoom subscription",
    });
  });

  it("falls back to other_expense when chargeCategoryId is set but does not resolve (dangling soft reference)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-kaen-3",
      expenseNumber: "EXP-0002",
      allocations: [
        { id: "alloc-kaen-3", borneBy: "kaen", amount: "150.00", chargeCategoryId: "cat-dangling", description: null },
      ],
    });
    chargeCategoryFindMany.mockResolvedValue([]); // no row matches — dangling id, never throws

    await createSupplierExpenseService(CTX, kaenInput);

    expect(chargeCategoryFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["cat-dangling"] } },
      select: { id: true, name: true },
    });
    const arg = kaenOperatingExpenseCreateMany.mock.calls[0][0];
    expect(arg.data[0]).toMatchObject({ sourceExpenseAllocationId: "alloc-kaen-3", category: "other_expense" });
  });

  it("routes only the kaen allocations out of a mixed split, batching the category lookup into one call", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-mixed-1",
      expenseNumber: "EXP-0002",
      allocations: [
        { id: "alloc-tenant-1", borneBy: "tenant", amount: "100.00", chargeCategoryId: null, description: null },
        { id: "alloc-owner-1", borneBy: "owner", amount: "100.00", chargeCategoryId: null, description: null },
        { id: "alloc-kaen-a", borneBy: "kaen", amount: "50.00", chargeCategoryId: "cat-a", description: null },
        { id: "alloc-kaen-b", borneBy: "kaen", amount: "50.00", chargeCategoryId: "cat-b", description: null },
      ],
    });
    chargeCategoryFindMany.mockResolvedValue([
      { id: "cat-a", name: "Bank Charges" },
      { id: "cat-b", name: "Office Rent" },
    ]);

    await createSupplierExpenseService(CTX, {
      ...kaenInput,
      totalAmount: "300.00",
      allocations: [
        { borneBy: "tenant" as const, amount: "100.00" },
        { borneBy: "owner" as const, amount: "100.00" },
        { borneBy: "kaen" as const, amount: "50.00" },
        { borneBy: "kaen" as const, amount: "50.00" },
      ],
    });

    expect(chargeCategoryFindMany).toHaveBeenCalledTimes(1);
    const arg = kaenOperatingExpenseCreateMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((d: { sourceExpenseAllocationId: string }) => d.sourceExpenseAllocationId).sort()).toEqual([
      "alloc-kaen-a",
      "alloc-kaen-b",
    ]);
    expect(arg.data.find((d: { category: string }) => d.category === "Bank Charges")).toBeTruthy();
    expect(arg.data.find((d: { category: string }) => d.category === "Office Rent")).toBeTruthy();
  });

  it("still records a zero-amount kaen allocation (not silently dropped)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-zero-1",
      expenseNumber: "EXP-0002",
      allocations: [{ id: "alloc-kaen-zero", borneBy: "kaen", amount: "0.00", chargeCategoryId: null, description: null }],
    });

    await createSupplierExpenseService(CTX, { ...kaenInput, totalAmount: "0.00", allocations: [{ borneBy: "kaen" as const, amount: "0.00" }] });

    expect(kaenOperatingExpenseCreateMany).toHaveBeenCalledTimes(1);
    const arg = kaenOperatingExpenseCreateMany.mock.calls[0][0];
    expect(arg.data).toEqual([
      {
        organizationId: "org-1",
        sourceExpenseAllocationId: "alloc-kaen-zero",
        category: "other_expense",
        description: null,
        amount: "0.00",
        expenseDate: new Date("2026-07-22T00:00:00.000Z"),
        createdById: "user-1",
      },
    ]);
  });

  it("does nothing when ENABLE_KAEN_OPEX is off, even with a categorized kaen allocation present", async () => {
    // process.env.ENABLE_KAEN_OPEX intentionally left unset (default OFF, per beforeEach).
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-kaen-4",
      expenseNumber: "EXP-0002",
      allocations: [
        { id: "alloc-kaen-4", borneBy: "kaen", amount: "150.00", chargeCategoryId: "cat-1", description: null },
      ],
    });

    await createSupplierExpenseService(CTX, kaenInput);

    expect(chargeCategoryFindMany).not.toHaveBeenCalled();
    expect(kaenOperatingExpenseCreateMany).not.toHaveBeenCalled();
  });

  it("propagates a kaen-opex insert failure instead of swallowing it (same-tx atomicity)", async () => {
    process.env.ENABLE_KAEN_OPEX = "true";
    supplierExpenseCreate.mockResolvedValue({
      id: "exp-kaen-5",
      expenseNumber: "EXP-0002",
      allocations: [{ id: "alloc-kaen-5", borneBy: "kaen", amount: "150.00", chargeCategoryId: null, description: null }],
    });
    kaenOperatingExpenseCreateMany.mockRejectedValue(new Error("db unavailable"));

    await expect(createSupplierExpenseService(CTX, kaenInput)).rejects.toThrow("db unavailable");
    // The audit row must not be written after a failed opex insert in the same tx.
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
