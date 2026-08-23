import { describe, expect, it } from "vitest";
import {
  billingDocumentFilename,
  resolveEconomicDocTitle,
  type BillingDocumentPdfModel,
} from "../pdf.service";

function model(overrides: Partial<BillingDocumentPdfModel> = {}): BillingDocumentPdfModel {
  return {
    docType: "invoice",
    title: "INVOICE",
    documentNumber: "IVOWN-0001",
    issuedAt: "2026-08-20",
    billingMonth: "August 2026",
    counterpartyName: "Owner",
    propertyName: "KENSHO",
    unitCode: "A-13-01",
    reason: null,
    originalDocumentNumber: null,
    lines: [{ categoryCode: "management_fee", description: "Management fee", amount: "250.00", sstRate: "8", sstAmount: "20.00", attachmentFilenames: [], unitCode: "A-13-01" }],
    totals: { subtotal: "250.00", sst: "20.00", total: "270.00" },
    adjustments: [],
    adjustedTotal: null,
    attachments: [],
    ...overrides,
  };
}

describe("economic billing-document names", () => {
  it("uses Invoice + description + condo + unit for management fees", () => {
    expect(billingDocumentFilename(model())).toBe("Invoice Property Management Fee KENSHO A-13-01.pdf");
  });

  it("uses owner-facing Admin Fee filenames without relabelling legacy tenant commission documents", () => {
    const commissionLine = {
      categoryCode: "letting_commission",
      description: "Internal commission description",
      amount: "1500.00",
      sstRate: "0",
      sstAmount: "0.00",
      attachmentFilenames: [],
      unitCode: "A-13-01",
    };
    expect(billingDocumentFilename(model({ lines: [commissionLine] })))
      .toBe("Invoice Admin Fee (First Month Rental) KENSHO A-13-01.pdf");
    expect(billingDocumentFilename(model({ documentNumber: "IVTEN-0001", lines: [commissionLine] })))
      .toBe("Invoice Rental Commission KENSHO A-13-01.pdf");
  });

  it("uses the owner-facing Admin Fee wording for the SST filename", () => {
    expect(billingDocumentFilename(model({
      lines: [{
        categoryCode: "letting_commission_sst",
        description: "Internal commission SST description",
        amount: "120.00",
        sstRate: "0",
        sstAmount: "0.00",
        attachmentFilenames: [],
        unitCode: "A-13-01",
      }],
    }))).toBe("Invoice SST on Admin Fee (First Month Rental) KENSHO A-13-01.pdf");
  });

  it("does not title pure pass-through utilities as an invoice", () => {
    expect(resolveEconomicDocTitle("invoice", "IVTEN-0001", ["electricity_tenant", "water_tenant"]))
      .toBe("UTILITY PAYMENT REQUEST");
  });

  it("uses a statement when revenue and pass-through lines share one document", () => {
    expect(resolveEconomicDocTitle("invoice", "IVTEN-0001", ["cleaning_tenant", "electricity_tenant"]))
      .toBe("MONTHLY BILLING STATEMENT");
  });

  it("uses dedicated request titles for rental and refundable deposits", () => {
    expect(resolveEconomicDocTitle("debit_note", "RB-0001", ["rental"]))
      .toBe("RENTAL PAYMENT REQUEST");
    expect(resolveEconomicDocTitle("debit_note", "DEPO-0001", ["tenancy_rental_deposit"]))
      .toBe("DEPOSIT REQUEST");
  });
});
