import { describe, it, expect } from "vitest";
import { BILLING_DOC_TYPES } from "../schemas/charge-categories";

describe("BILLING_DOC_TYPES", () => {
  it("includes receipts, owner expense advice and proforma documents", () => {
    expect([...BILLING_DOC_TYPES]).toEqual([
      "invoice", "debit_note", "credit_note", "refund_note", "receipt", "owner_expense_advice", "proforma",
    ]);
  });

  it("does not contain a mis-spelled value", () => {
    expect((BILLING_DOC_TYPES as readonly string[]).includes("reciept")).toBe(false);
  });
});
