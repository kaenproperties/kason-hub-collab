import { describe, it, expect } from "vitest";
import { resolveDocTitle, DOC_TITLE } from "../pdf.service";

describe("resolveDocTitle (customer-facing payment requests)", () => {
  it("renders 'RENTAL PAYMENT REQUEST' for RB docs regardless of the internal docType", () => {
    // Rent stays a debit_note internally (avoids owner-ledger sign ripple), while the
    // customer-facing title makes clear this is a collection request rather than revenue.
    expect(resolveDocTitle("debit_note", "RB-0001")).toBe("RENTAL PAYMENT REQUEST");
    expect(resolveDocTitle("invoice", "RB-0099")).toBe("RENTAL PAYMENT REQUEST");
  });

  it("uses the current rental request title for legacy IVREN numbers", () => {
    // Pre-rename IVREN-numbered docs stay valid → IVREN kept as a legacy alias in the title map.
    expect(resolveDocTitle("debit_note", "IVREN-0001")).toBe("RENTAL PAYMENT REQUEST");
  });

  it("renders 'EXPENSE PAYMENT REQUEST' for EB docs, never 'INVOICE'", () => {
    // EB is a tenant expense recovery on its own series; docType stays "invoice" internally,
    // but the title must not misclassify a pass-through recovery as company revenue.
    expect(resolveDocTitle("invoice", "EB-0002")).toBe("EXPENSE PAYMENT REQUEST");
    expect(resolveDocTitle("invoice", "EBX-1")).toBe(DOC_TITLE.invoice); // "EB" prefix guard
  });

  it("uses dedicated request titles before falling back to the docType map", () => {
    expect(resolveDocTitle("invoice", "IVTEN-0001")).toBe(DOC_TITLE.invoice);
    expect(resolveDocTitle("debit_note", "DEP-0007")).toBe("PAYMENT REQUEST");
    expect(resolveDocTitle("credit_note", "CN-0001")).toBe(DOC_TITLE.credit_note);
    expect(resolveDocTitle("refund_note", "RN-0001")).toBe(DOC_TITLE.refund_note);
    expect(resolveDocTitle("receipt", "RCPT-0001")).toBe(DOC_TITLE.receipt);
    expect(resolveDocTitle("invoice", "RBX-1")).toBe(DOC_TITLE.invoice); // "RB-" prefix guard
    expect(resolveDocTitle("invoice", "IVRENX-1")).toBe(DOC_TITLE.invoice); // legacy "IVREN-" prefix guard
  });
});
