import { beforeEach, describe, expect, it, vi } from "vitest";

const { issueDocumentTxMock } = vi.hoisted(() => ({ issueDocumentTxMock: vi.fn() }));
vi.mock("../issue.service", () => ({ issueDocumentTx: issueDocumentTxMock }));

import { issueReceiptDocumentTx } from "../receipts.service";

describe("issueReceiptDocumentTx — cash amount", () => {
  beforeEach(() => {
    issueDocumentTxMock.mockReset();
    issueDocumentTxMock.mockResolvedValue({ id: "receipt-1", documentNumber: "RCPT-0001" });
  });

  it("uses this payment's net allocations, not the source documents' full values", async () => {
    const tx = {
      paymentAllocation: {
        findMany: vi.fn().mockResolvedValue([
          { id: "alloc-a", chargeId: "charge-a", allocatedAmount: { toString: () => "50.00" } },
          { id: "alloc-b", chargeId: "charge-b", allocatedAmount: { toString: () => "25.00" } },
        ]),
      },
      paymentAllocationReversal: {
        findMany: vi.fn().mockResolvedValue([
          { originalAllocationId: "alloc-a", amount: { toString: () => "10.00" } },
        ]),
      },
      billingDocumentLine: {
        findMany: vi.fn().mockResolvedValue([
          {
            chargeId: "charge-a", categoryId: "cat", description: "Rental deposit",
            amount: { toString: () => "6000.00" }, sstRate: { toString: () => "0" }, isTax: false,
            document: { docType: "debit_note", counterpartyType: "tenant", apartmentId: "apt", propertyId: "prop", tenancyId: "tenancy", billingMonth: new Date("2026-08-01") },
          },
          {
            chargeId: "charge-b", categoryId: "cat", description: "Utilities deposit",
            amount: { toString: () => "1500.00" }, sstRate: { toString: () => "0" }, isTax: false,
            document: { docType: "debit_note", counterpartyType: "tenant", apartmentId: "apt", propertyId: "prop", tenancyId: "tenancy", billingMonth: new Date("2026-08-01") },
          },
        ]),
      },
      billingDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await issueReceiptDocumentTx(tx as never, {
      organizationId: "org", paymentId: "payment", partyId: "party",
      settledChargeIds: ["charge-a", "charge-b"], actorUserId: "user",
    });

    expect(issueDocumentTxMock).toHaveBeenCalledOnce();
    const input = issueDocumentTxMock.mock.calls[0]![1];
    expect(input.lines).toEqual([
      expect.objectContaining({ chargeId: "charge-a", amount: "40.00", sstRate: "0", isTax: false }),
      expect.objectContaining({ chargeId: "charge-b", amount: "25.00", sstRate: "0", isTax: false }),
    ]);
  });
});
