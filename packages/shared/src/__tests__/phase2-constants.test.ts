// packages/shared/src/__tests__/phase2-constants.test.ts
import { describe, expect, it } from "vitest";
import { PHASE2_FLAGS } from "../constants/phase2-flags";
import { PHASE2_STATUS_TONES, type StatusTone } from "../constants/phase2-status-tones";

describe("phase2 constants", () => {
  it("registry is count-locked, unique, and all ENABLE_*", () => {
    // 12th flag ENABLE_UNIT_MONTH_LEDGER (PR #100) deliberately kept its
    // non-PHASE2 name when it joined this registry — the shared prefix
    // contract is ENABLE_*, with PHASE2_ for the phase-2 module flags.
    // 21st: ENABLE_SUPPLIER_EXPENSES (accounting-doc redesign P3).
    // (removed 2026-08-16: ENABLE_OWNER_BORNE_DEDUCT — accounting-doc redesign P5.)
    // 22nd: ENABLE_EXPENSE_BILL (accounting-doc redesign P4).
    // 24th: ENABLE_KAEN_OPEX (accounting-doc redesign P6).
    // 25th: ENABLE_OWNER_FUNDING_REQUEST (accounting-doc redesign P7, reshaped).
    // 26th: ENABLE_OWNER_DOC_NUMBERING (accounting-doc redesign P1, OST-/REM- numbering).
    // 28th: ENABLE_CHARGE_NATURE_ROUTING (charge-nature-expense-profit-routing plan, Task 1).
    // 29th: ENABLE_OWNER_STATEMENT_AUTO_ISSUE (month-close auto-issue cron, Task 2).
    // 30th: ENABLE_OWNER_WEB_EXPENSE_HIDE (owner web-only expense filter).
    // (removed 2026-08-16: ENABLE_AUTO_OFFSET_ON_RENT — settling IVOWN lines out of
    //   collected rent is now UNCONDITIONAL, so there is nothing left to gate. While it
    //   existed it defaulted OFF, which meant the deduction KAEN performs in practice
    //   never happened in the system and owners' IVOWN invoices sat Unpaid forever.
    //   NOTE: that flag also reached master WITHOUT bumping this count or the
    //   last-element guard in phase2-flags.test.ts, so master was red on both until a
    //   later merge. Exactly the drift these tripwires exist to catch — and a
    //   reminder that master runs no CI, so the tripwire only fires locally.)
    // newest: ENABLE_OWNER_STATEMENT_AUTO_SEND (month-end send cron — releases the
    //   frozen month's approved statements to owners on the org's configured day).
    //
    // The count lives in ONE constant, and the test name no longer carries it.
    // Both previously drifted independently (the name said 28 while the
    // assertion said 29), which hid the real signal: adding a flag is meant to
    // trip this tripwire so the registry change gets a deliberate look.
    // 30 after REMOVING two (2026-08-16): ENABLE_OWNER_BORNE_DEDUCT and
    // ENABLE_AUTO_OFFSET_ON_RENT. A removal must trip this tripwire exactly as an
    // addition does — see the not.toContain guards below.
    // 31 after ADDING ENABLE_TENANCY_DEPOSIT_DOCS (move-in rental + utilities deposits).
    // 32 after ADDING ENABLE_PROFORMA_INVOICES (pre-issue tenant documents).
    const EXPECTED_FLAG_COUNT = 32;
    expect(PHASE2_FLAGS).toHaveLength(EXPECTED_FLAG_COUNT);
    for (const f of PHASE2_FLAGS) expect(f).toMatch(/^ENABLE_[A-Z0-9_]+$/);
    expect(new Set(PHASE2_FLAGS).size).toBe(EXPECTED_FLAG_COUNT);
    expect(PHASE2_FLAGS).not.toContain("ENABLE_OWNER_BORNE_DEDUCT");
    expect(PHASE2_FLAGS).not.toContain("ENABLE_AUTO_OFFSET_ON_RENT");
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_STATEMENT_AUTO_ISSUE");
    expect(PHASE2_FLAGS).toContain("ENABLE_CHARGE_NATURE_ROUTING");
    expect(PHASE2_FLAGS).toContain("ENABLE_SUPPLIER_EXPENSES");
    expect(PHASE2_FLAGS).toContain("ENABLE_EXPENSE_BILL");
    expect(PHASE2_FLAGS).toContain("ENABLE_KAEN_OPEX");
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_FUNDING_REQUEST");
    expect(PHASE2_FLAGS).toContain("ENABLE_OWNER_DOC_NUMBERING");
    expect(PHASE2_FLAGS).toContain("ENABLE_BILL_EXPENSES_AS_CHARGES");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_SPRINTS");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_UNIT_ANALYTICS");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_BILLING_DOCS");
    expect(PHASE2_FLAGS).toContain("ENABLE_UNIT_MONTH_LEDGER");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_RESERVATION_GATED_TENANCY");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_BILLS_GRID");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT");
    // Phase 3.1 — charge-scoped CREATE credit/debit note (partial amounts).
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_INVOICE_ADJUSTMENTS");
    expect(PHASE2_FLAGS).toContain("ENABLE_PHASE2_OWNER_REMITTANCE");
  });

  it("every tone is a valid StatusPill tone", () => {
    const valid: StatusTone[] = ["slate", "sky", "emerald", "amber", "rose"];
    for (const entity of Object.values(PHASE2_STATUS_TONES)) {
      for (const tone of Object.values(entity)) expect(valid).toContain(tone);
    }
  });

  it("pins the tones the module skills already locked", () => {
    expect(PHASE2_STATUS_TONES.payment.pending_approval).toBe("amber");
    expect(PHASE2_STATUS_TONES.payment.posted).toBe("emerald");
    expect(PHASE2_STATUS_TONES.payment.void).toBe("slate");
    expect(PHASE2_STATUS_TONES.invoice.void).toBe("rose");
    expect(PHASE2_STATUS_TONES.invoice.draft).toBe("slate");
    expect(PHASE2_STATUS_TONES.meterReading.charged).toBe("emerald");
  });

  it("pins the M1 tenant-tracker tones (tenancy + pic)", () => {
    expect(PHASE2_STATUS_TONES.tenancy.active).toBe("emerald");
    expect(PHASE2_STATUS_TONES.tenancy.ended).toBe("slate");
    expect(PHASE2_STATUS_TONES.tenancy.terminated).toBe("slate");
    expect(PHASE2_STATUS_TONES.pic.unassigned).toBe("slate");
    expect(PHASE2_STATUS_TONES.pic.assigned).toBe("sky");
  });

  it("includes unit-utility-bill tones", () => {
    expect(PHASE2_STATUS_TONES.unitUtilityBill).toEqual({ draft: "slate", charged: "emerald", void: "rose" });
  });

  it("includes the sprint tones (planned/active/completed)", () => {
    expect(PHASE2_STATUS_TONES.sprint).toEqual({ planned: "sky", active: "emerald", completed: "slate" });
  });

  it("includes the bills-grid tones (paymentStatus + lock + expense status)", () => {
    expect(PHASE2_STATUS_TONES.billsGridEntry).toEqual({
      unpaid: "slate", pending: "amber", partial: "amber", paid: "emerald",
      draft: "slate", locked: "sky",
    });
    expect(PHASE2_STATUS_TONES.billsGridExpense).toEqual({ active: "emerald", void: "slate" });
  });
});
