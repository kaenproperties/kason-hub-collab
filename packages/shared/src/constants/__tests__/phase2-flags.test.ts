import { describe, it, expect } from "vitest";
import { PHASE2_FLAGS } from "../phase2-flags";

describe("PHASE2_FLAGS", () => {
  it("includes the owner-statement live-ledger flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER");
  });

  it("includes the rent-reclassification flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_RENT_RECLASSIFICATION");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_OWNER_REMITTANCE");
  });

  it("includes the prior-period-adjustment spike flag (R4)", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT");
  });

  it("includes the Phase 3.1 charge-adjustment flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_INVOICE_ADJUSTMENTS");
  });

  it("includes the bill-expenses-as-charges flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_BILL_EXPENSES_AS_CHARGES");
  });

  it("includes the accounting-redesign P3 supplier-expenses flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_SUPPLIER_EXPENSES");
  });

  it("no longer carries the two removed owner-deduction flags", () => {
    // ENABLE_OWNER_BORNE_DEDUCT gated a SECOND way to make an owner bear a grid expense
    // — never invoice them, deduct at ledger-sync time onto an OEA advice. KAEN wants the
    // opposite: the expense SHOWS as an IVOWN line and is netted out of the payout when
    // the rent is collected. ENABLE_AUTO_OFFSET_ON_RENT gated that netting, default OFF,
    // so it never actually happened. Both removed 2026-08-16 — the offset hook is now
    // unconditional and the deduct model is gone.
    //
    // Asserted as ABSENT rather than just deleted, so reintroducing either name is a
    // deliberate act that has to delete this test first.
    expect(PHASE2_FLAGS).not.toContain("ENABLE_OWNER_BORNE_DEDUCT");
    expect(PHASE2_FLAGS).not.toContain("ENABLE_AUTO_OFFSET_ON_RENT");
  });

  it("includes the accounting-redesign P4 expense-bill flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_EXPENSE_BILL");
  });

  it("includes the accounting-redesign P6 kaen-opex flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_KAEN_OPEX");
  });

  it("includes the accounting-redesign P7 owner-funding-request flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_FUNDING_REQUEST");
  });

  it("includes the accounting-redesign P1 owner-doc-numbering flag", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_DOC_NUMBERING");
  });

  it("includes the charge-nature-routing flag (per-charge Expense/Profit routing)", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_CHARGE_NATURE_ROUTING");
  });

  it("includes the owner-statement auto-issue flag (Task 2 — month-close auto-issue cron)", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_STATEMENT_AUTO_ISSUE");
  });

  it("includes the owner web-expense-hide flag (owner web-only expense filter)", () => {
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_WEB_EXPENSE_HIDE");
  });

  // New flags are APPENDED, so the tail is the newest. Update this alongside the
  // count in phase2-constants.test.ts whenever a flag joins the registry.
  it("has the newest flag (proforma invoices) as the last element", () => {
    expect(PHASE2_FLAGS[PHASE2_FLAGS.length - 1]).toBe("ENABLE_PROFORMA_INVOICES");
  });
});
