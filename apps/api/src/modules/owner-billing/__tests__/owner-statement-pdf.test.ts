import { describe, it, expect } from "vitest";
import { buildYanniePdfHtml } from "../owner-statement-pdf";
import type { YannieSections } from "../owner-statement-sections";

// ─── PV9 fixture for buildYanniePdfHtml ───────────────────────────────────────

const PV9_SECTIONS: YannieSections = {
  header: {
    reportMonth: "June 2026",
    propertyName: "Park Villa 9",
    ownerName: "Ahmad bin Razali",
    bankName: "Maybank",
    accountHolder: "Ahmad bin Razali",
    accountNumberMasked: "••••1234",
  },
  apartmentId: null,
  occupancy: {
    rows: [
      {
        unitCode: "PV9-10-04",
        tenantName: "Lim Wei Jie",
        tenancyStart: "2026-01-01",
        tenancyEnd: "2026-12-31",
        monthlyRental: "2000.00",
        depositMonths: 2,
        depositAmount: "0.00",
        isVacant: false,
      },
    ],
    occupiedCount: 1,
    vacantCount: 0,
    totalMonthlyRental: "2000.00",
  },
  payoutSummary: {
    lines: [
      { label: "Total Income Collected", amount: "2000.00" },
      { label: "Add: Deposit Collected", amount: "0.00", isNonIncome: true },
      { label: "Gross Cash In", amount: "2000.00" },
      { label: "Less: Total Expenses", amount: "-400.00" },
      { label: "Total Payout to Owner", amount: "1600.00", isTotal: true },
    ],
    netPayoutToOwner: "1600.00",
    depositCollected: "0.00",
    depositHeld: "0.00",
  },
  incomeBreakdown: {
    rows: [
      {
        unitCode: "PV9-10-04",
        tenantName: "Lim Wei Jie",
        incomeType: "Monthly",
        billingPeriod: "June 2026",
        amount: "2000.00",
        chargedAmount: "2000.00",
        mgmtFee: "200.00",
        mgmtFeeSst: "16.00",
        paymentStatus: "paid",
        detail: null,
        isPassThrough: false,
        isInformational: false,
      },
    ],
    totalIncome: "2000.00",
    passThroughIncome: "0.00",
    totalMgmtFee: "216.00",
  },
  expenseBreakdown: {
    rows: [
      {
        category: "Management Fee",
        categoryKey: "management_fee",
        description: "KAEN management fee (per income line)",
        amount: "200.00",
        sstAmount: "16.00",
        paymentStatus: "paid",
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
      },
      {
        category: "Electricity (TNB)",
        categoryKey: "utilities_tnb",
        description: "June meter",
        amount: "184.00",
        sstAmount: "0.00",
        paymentStatus: "paid",
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
      },
    ],
    totalExpenses: "400.00",
  },
};

describe("buildYanniePdfHtml", () => {
  it("renders all 5 section headings and the correct net payout string", () => {
    const html = buildYanniePdfHtml(PV9_SECTIONS);

    // Section 1 — Header
    expect(html).toContain("Owner &amp; Payout Details");
    expect(html).toContain("Ahmad bin Razali");
    expect(html).toContain("Park Villa 9");
    expect(html).toContain("••••1234");

    // Section 2 — Occupancy
    expect(html).toContain("Occupancy");

    // Section 3 — Payout Summary
    expect(html).toContain("Payout Summary");
    expect(html).toContain("Additions (+)");
    expect(html).toContain("Deductions (−)");
    expect(html).toContain('class="deduction-row"');
    expect(html).toContain("− RM 400.00");

    // Section 4 — Income Breakdown
    expect(html).toContain("Owner Income Breakdown");

    // Section 5 — Expense Deductions
    expect(html).toContain("Expense Deductions");

    // Formal, owner-facing wording and casing.
    expect(html).toContain("Property Management Fee");
    expect(html).toContain("Property Management Fee (Per Income Line)");
    expect(html).toContain("Management Fee (RM)");
    expect(html).toContain(">Paid<");
    expect(html).not.toContain("Mgmt");
    expect(html).not.toContain("KAEN management fee");
    expect(html).not.toContain(">paid<");

    // Net payout value (1600.00 → formatted)
    expect(html).toContain("1,600.00");
  });

  it("renders the paid-on-behalf sub-line on an expense that carries payee metadata (Task 9)", () => {
    // Default fixture rows carry null payee metadata → no "Paid on behalf" note.
    expect(buildYanniePdfHtml(PV9_SECTIONS)).not.toContain("Paid on behalf");

    // Attach payee metadata to the TNB expense row → the note renders inline.
    const withPayee: YannieSections = {
      ...PV9_SECTIONS,
      expenseBreakdown: {
        ...PV9_SECTIONS.expenseBreakdown,
        rows: PV9_SECTIONS.expenseBreakdown.rows.map((r) =>
          r.categoryKey === "utilities_tnb"
            ? { ...r, payeeName: "Allianz", paidOnBehalfRef: "INV-1", paidOnBehalfDate: "2026-06-15" }
            : r,
        ),
      },
    };
    const html = buildYanniePdfHtml(withPayee);
    expect(html).toContain("Paid on behalf — Allianz");
    expect(html).toContain("Reference INV-1");
    expect(html).toContain("2026-06-15");
  });

  it("renders a CLEAN statement body — all 5 headings, but NO receipt images and NO receipts list", () => {
    // The statement PDF is now a clean 5-section summary: bills/receipts live
    // separately (proof pack / per-expense bills), never embedded or appended
    // here. buildYanniePdfHtml takes ONE arg and emits no receipt markup.
    const html = buildYanniePdfHtml(PV9_SECTIONS);

    // All 5 section headings still present…
    expect(html).toContain("Owner &amp; Payout Details");
    expect(html).toContain("Occupancy");
    expect(html).toContain("Payout Summary");
    expect(html).toContain("Owner Income Breakdown");
    expect(html).toContain("Expense Deductions");

    // …but never a receipt-image figure, a receipts list, or a receipt heading.
    expect(html).not.toContain('class="receipt-image"');
    expect(html).not.toContain("Attached Receipts");
    expect(html).not.toContain("attached separately");
  });

  it("HTML-escapes all dynamic interpolations including ownerName with XSS payload", () => {
    const maliciousSections: YannieSections = {
      ...PV9_SECTIONS,
      header: {
        ...PV9_SECTIONS.header,
        ownerName: "O'Malley <script>alert(1)</script>",
      },
    };
    const html = buildYanniePdfHtml(maliciousSections);

    // The escaped form must appear
    expect(html).toContain("&lt;script&gt;");
    // The raw tag must NOT survive
    expect(html).not.toContain("<script>");
  });

  it("renders a vacant unit with '—' for tenant name and 'Vacant' for status", () => {
    const sectionsWithVacant: YannieSections = {
      ...PV9_SECTIONS,
      occupancy: {
        rows: [
          ...PV9_SECTIONS.occupancy.rows,
          {
            unitCode: "PV9-10-05",
            tenantName: null,
            tenancyStart: null,
            tenancyEnd: null,
            monthlyRental: "0.00",
            depositMonths: null,
            depositAmount: "0.00",
            isVacant: true,
          },
        ],
        occupiedCount: 1,
        vacantCount: 1,
        totalMonthlyRental: "2000.00",
      },
    };
    const html = buildYanniePdfHtml(sectionsWithVacant);

    // Vacant unit row appears with unit code
    expect(html).toContain("PV9-10-05");
    // isVacant=true renders "Vacant" (not "Occupied")
    expect(html).toContain("Vacant");
    // tenantName=null renders "—" via the ?? fallback
    expect(html).toContain("—");
  });

  it("renders a NEGATIVE net payout (expenses > income) with its leading minus", () => {
    // Expenses (1434.56) exceed income (200.00) → owner owes; net is negative.
    const negativeSections: YannieSections = {
      ...PV9_SECTIONS,
      payoutSummary: {
        lines: [
          { label: "Total Income Collected", amount: "200.00" },
          { label: "Less: Total Expenses", amount: "-1434.56" },
          { label: "Total Payout to Owner", amount: "-1234.56", isTotal: true },
        ],
        netPayoutToOwner: "-1234.56",
        depositCollected: "0.00",
        depositHeld: "0.00",
      },
    };

    const html = buildYanniePdfHtml(negativeSections);

    // formatRM(-1234.56) → "RM -1,234.56": the leading "-" and en-MY thousands
    // grouping must both survive (never an unsigned 1,234.56).
    expect(html).toContain("-1,234.56");
    expect(html).not.toContain("RM 1,234.56");
  });

  // §5 prints the note-ADJUSTED amount. A PDF is the document an owner keeps and
  // reconciles against their inbox, so an expense that a credit note moved must name
  // it — §4 has carried the same sentence beside the income line since 2026-08-07.
  describe("an expense row a credit/debit note moved", () => {
    function withNote(adjustmentNote: string | null): YannieSections {
      return {
        ...PV9_SECTIONS,
        expenseBreakdown: {
          ...PV9_SECTIONS.expenseBreakdown,
          rows: PV9_SECTIONS.expenseBreakdown.rows.map((r) =>
            r.categoryKey === "utilities_tnb" ? { ...r, adjustmentNote } : r,
          ),
        },
      };
    }

    it("prints the note beside the row, without displacing its description", () => {
      const html = buildYanniePdfHtml(withNote("Credit note -RM 16.00"));

      expect(html).toContain("Credit note -RM 16.00");
      expect(html).toContain("June meter");
    });

    it("prints both directions rather than a netted figure", () => {
      const html = buildYanniePdfHtml(
        withNote("Debit note +RM 80.00 · Credit note -RM 30.00"),
      );

      expect(html).toContain("Debit note +RM 80.00");
      expect(html).toContain("Credit note -RM 30.00");
    });

    it("prints nothing for an un-adjusted row", () => {
      // Every row in the base fixture is note-free — no stray empty note div.
      const html = buildYanniePdfHtml(PV9_SECTIONS);

      expect(html).not.toContain("Credit note");
      expect(html).not.toContain("Debit note");
    });
  });
});
