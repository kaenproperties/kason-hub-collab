import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  bankReconciliationAccount: {
    findFirst: vi.fn(),
  },
  bankReconciliationTransaction: {
    findMany: vi.fn(),
  },
}));

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(),
}));

vi.mock("../../payments/payments.service", () => ({
  recordAndAllocatePaymentService: vi.fn(),
}));

import { previewImport } from "../service";

describe("bank reconciliation import preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.bankReconciliationAccount.findFirst.mockResolvedValue({ id: "bank-1" });
    dbMock.bankReconciliationTransaction.findMany.mockResolvedValue([]);
  });

  it("marks a repeated row inside the same import batch as a duplicate", async () => {
    const line = {
      transactionDate: "2026-08-18",
      description: "Tenant transfer",
      debit: 0,
      credit: 0,
      balance: 1000,
    };

    const result = await previewImport(
      { orgId: "org-1", userId: "user-1", role: "admin" },
      { accountId: "bank-1", transactions: [line, { ...line }] },
    );

    expect(result.rows.map((row) => row.duplicate)).toEqual([false, true]);
    expect(result.duplicates).toBe(1);
    expect(result.newCount).toBe(1);
  });

  it("continues to mark rows that already exist in the account", async () => {
    const actor = { orgId: "org-1", userId: "user-1", role: "admin" };
    const input = {
      accountId: "bank-1",
      transactions: [{
        transactionDate: "2026-08-18",
        description: "Tenant transfer",
        debit: 0,
        credit: 0,
        balance: 1000,
      }],
    };
    const initialPreview = await previewImport(actor, input);
    dbMock.bankReconciliationTransaction.findMany.mockResolvedValue([
      { fingerprint: initialPreview.rows[0].fingerprint },
    ]);

    const result = await previewImport(
      actor,
      input,
    );

    expect(result.duplicates).toBe(1);
    expect(result.newCount).toBe(0);
  });
});
