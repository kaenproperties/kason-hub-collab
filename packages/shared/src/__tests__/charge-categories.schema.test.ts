import { describe, it, expect } from "vitest";
import {
  createChargeCategoryInput,
  updateChargeCategoryInput,
  updateDocumentSeriesInput,
  CATEGORY_FAMILIES,
  BILLING_DOC_TYPES,
} from "../schemas/charge-categories";

const SERIES_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("charge-categories value sets", () => {
  it("locks the contract unions", () => {
    expect(CATEGORY_FAMILIES).toEqual(["tenant_income", "owner_income", "pay_back_landlord"]);
    expect(BILLING_DOC_TYPES).toEqual([
      "invoice", "debit_note", "credit_note", "refund_note", "receipt", "owner_expense_advice", "proforma",
    ]);
  });
});

describe("createChargeCategoryInput", () => {
  it("accepts a minimal valid category", () => {
    const parsed = createChargeCategoryInput.safeParse({
      code: "misc_fee",
      name: "Misc fee",
      family: "tenant_income",
      docType: "invoice",
      seriesId: SERIES_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects non-snake_case codes and credit_note routing", () => {
    expect(createChargeCategoryInput.safeParse({ code: "Misc Fee!", name: "x y", family: "tenant_income", docType: "invoice", seriesId: SERIES_ID }).success).toBe(false);
    expect(createChargeCategoryInput.safeParse({ code: "misc_fee", name: "Misc fee", family: "tenant_income", docType: "credit_note", seriesId: SERIES_ID }).success).toBe(false);
  });

  it("rejects a ledgerCategory outside OWNER_LEDGER_CATEGORIES", () => {
    const parsed = createChargeCategoryInput.safeParse({
      code: "misc_fee",
      name: "Misc fee",
      family: "pay_back_landlord",
      docType: "debit_note",
      seriesId: SERIES_ID,
      ledgerCategory: "utility_tnb", // WRONG spelling — the real enum value is utilities_tnb
    });
    expect(parsed.success).toBe(false);
  });
});

describe("updateChargeCategoryInput / updateDocumentSeriesInput", () => {
  it("requires expectedUpdatedAt and at least one mutable field", () => {
    expect(updateChargeCategoryInput.safeParse({ name: "New name" }).success).toBe(false);
    expect(updateChargeCategoryInput.safeParse({ expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }).success).toBe(false);
    expect(updateChargeCategoryInput.safeParse({ name: "New name", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }).success).toBe(true);
    expect(updateDocumentSeriesInput.safeParse({ expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }).success).toBe(false);
    expect(updateDocumentSeriesInput.safeParse({ prefix: "INV", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }).success).toBe(true);
  });
});
