/**
 * Task 6: StatementSectionIncome — tests for charged amount display.
 *
 * Uses plain vitest/chai assertions (toHaveTextContent / toBeInTheDocument are
 * not reliably available in this worktree's vitest+jsdom setup).
 *
 * Run:
 *   cd .../six-ux-fixes/apps/web
 *   <repo>/node_modules/.bin/vitest run src/pages/tenancy/__tests__/statement-section-income.test.tsx
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import { StatementSectionIncome } from "@/pages/tenancy/owner-statement/statement-section-income";
import type { YannieSections } from "@/api/owner-ledger";

type IncomeData = YannieSections["incomeBreakdown"];

function makeRow(overrides: Partial<IncomeData["rows"][number]> = {}): IncomeData["rows"][number] {
  return {
    unitCode: "A-10-04",
    tenantName: "Ahmad Bin Ali",
    incomeType: "Monthly",
    billingPeriod: "June 2026",
    amount: "500.00",
    mgmtFee: "0.00",
    mgmtFeeSst: "0.00",
    paymentStatus: "paid",
    ...overrides,
  };
}

function renderIncome(rows: IncomeData["rows"]) {
  const data: IncomeData = {
    rows,
    totalIncome: rows.reduce((acc, r) => acc + Number(r.amount), 0).toFixed(2),
    totalMgmtFee: "0.00",
  };
  return render(<StatementSectionIncome data={data} />);
}

describe("StatementSectionIncome — Task 6: charged amount display", () => {
  it("unpaid row: primary cell shows chargedAmount (RM 500.00), NOT collected 0.00", () => {
    renderIncome([
      makeRow({ amount: "0.00", chargedAmount: "500.00", paymentStatus: "pending" }),
    ]);
    const cell = screen.getByTestId("income-row-charged-0");
    expect(cell.textContent).toContain("500.00");
    // Must NOT show RM 0.00 as the primary figure
    expect(cell.textContent).not.toBe("RM 0.00");
  });

  it("unpaid row: PENDING pill is rendered", () => {
    renderIncome([
      makeRow({ amount: "0.00", chargedAmount: "500.00", paymentStatus: "pending" }),
    ]);
    // getByText throws if not found — presence check
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("unpaid row: muted 'Collected RM 0.00' secondary is rendered", () => {
    renderIncome([
      makeRow({ amount: "0.00", chargedAmount: "500.00", paymentStatus: "pending" }),
    ]);
    const secondary = screen.getByTestId("income-row-collected-0");
    expect(secondary).toBeTruthy();
    expect(secondary.textContent).toContain("0.00");
    expect(secondary.textContent?.toLowerCase()).toContain("collected");
  });

  it("partial row: primary shows chargedAmount; secondary shows partial collected", () => {
    renderIncome([
      makeRow({ amount: "250.00", chargedAmount: "500.00", paymentStatus: "partial" }),
    ]);
    const primary = screen.getByTestId("income-row-charged-0");
    expect(primary.textContent).toContain("500.00");

    const secondary = screen.getByTestId("income-row-collected-0");
    expect(secondary.textContent).toContain("250.00");
  });

  it("paid row: primary shows chargedAmount; no secondary collected line", () => {
    renderIncome([
      makeRow({ amount: "500.00", chargedAmount: "500.00", paymentStatus: "paid" }),
    ]);
    const primary = screen.getByTestId("income-row-charged-0");
    expect(primary.textContent).toContain("500.00");

    // No secondary line for paid rows
    expect(screen.queryByTestId("income-row-collected-0")).toBeNull();
  });

  it("legacy row (no chargedAmount): falls back to amount for primary display", () => {
    // chargedAmount absent (old API response before Task 6) — graceful degradation
    renderIncome([
      makeRow({ amount: "500.00", paymentStatus: "paid" }),
    ]);
    const primary = screen.getByTestId("income-row-charged-0");
    expect(primary.textContent).toContain("500.00");
  });

  it("footer label includes 'collected' to distinguish from per-row charged amounts", () => {
    renderIncome([makeRow({ amount: "500.00", chargedAmount: "500.00", paymentStatus: "paid" })]);
    // The footer cell should say "Total income collected" (not just "Total income")
    const footer = screen.getByText(/total income collected/i);
    expect(footer).toBeTruthy();
  });

  // ── T6-web parity with PDF: no "Collected" line when charged === collected ──────

  it("pending row where chargedAmount === amount: no secondary 'Collected' line (PDF parity)", () => {
    // Both amounts are 500 — showing "Collected RM 500" under "RM 500" is redundant.
    renderIncome([
      makeRow({ amount: "500.00", chargedAmount: "500.00", paymentStatus: "pending" }),
    ]);
    // Primary still shows the charged amount
    const primary = screen.getByTestId("income-row-charged-0");
    expect(primary.textContent).toContain("500.00");
    // Secondary must be absent (amounts are identical)
    expect(screen.queryByTestId("income-row-collected-0")).toBeNull();
  });

  it("pending row where chargedAmount !== amount: secondary 'Collected' line IS rendered", () => {
    // 500 charged, only 250 collected — the distinction is meaningful.
    renderIncome([
      makeRow({ amount: "250.00", chargedAmount: "500.00", paymentStatus: "pending" }),
    ]);
    const secondary = screen.getByTestId("income-row-collected-0");
    expect(secondary).toBeTruthy();
    expect(secondary.textContent).toContain("250.00");
  });
});

// ── Informational rows (letting commission) ──────────────────────────────────
//
// A commission-month statement used to render as RM 0.00 income beside an
// unexplained owner-borne SST deduction: owner-ledger.sync.ts wrote a row saying
// the first month's rent was retained by KAEN, but §4 dropped every direction that
// was not income/expense, so no surface ever showed it.
describe("StatementSectionIncome — informational (letting commission) rows", () => {
  const informationalRow = () =>
    makeRow({
      incomeType: "Admin Fee (First Month Rental)",
      amount: "3000.00",
      chargedAmount: "3000.00",
      paymentStatus: "paid",
      detail: "First month rental retained by KAEN as Admin Fee",
      isInformational: true,
    });

  it("renders the retained-by-KAEN note so a blank commission month is explained", () => {
    renderIncome([informationalRow()]);
    expect(screen.getByText("Admin Fee (First Month Rental)")).toBeTruthy();
    expect(screen.queryByText("Letting Commission")).toBeNull();
    const note = screen.getByTestId("income-row-informational-0");
    expect(note.textContent).toContain("Retained by KAEN");
  });

  it("shows the ledger's own explanation as the row detail", () => {
    renderIncome([informationalRow()]);
    expect(screen.getByText(/first month rental retained by kaen/i)).toBeTruthy();
  });

  it("renders the amount MUTED, never in the income green — it is not owner earnings", () => {
    renderIncome([informationalRow()]);
    const cell = screen.getByTestId("income-row-charged-0");
    expect(cell.className).toContain("text-muted-foreground");
    expect(cell.className).not.toContain("emerald");
  });

  it("an ordinary income row is still green (guards against the muting leaking)", () => {
    renderIncome([makeRow({ amount: "500.00", chargedAmount: "500.00" })]);
    const cell = screen.getByTestId("income-row-charged-0");
    expect(cell.className).toContain("emerald");
  });

  it("carries no management fee — a fee here would bill rent the owner never received", () => {
    renderIncome([informationalRow()]);
    const row = screen.getByTestId("income-row-charged-0").closest("tr")!;
    // Both money columns after the amount are the em-dash placeholder, not a figure.
    expect(row.textContent).not.toContain("240.00");
  });

  it("is NOT counted in Total income collected", () => {
    // Footer total is supplied by the API (already excludes informational rows);
    // this pins that the component renders the supplied total verbatim rather than
    // re-summing the rows it was handed.
    const data: IncomeData = {
      rows: [informationalRow()],
      totalIncome: "0.00",
      totalMgmtFee: "0.00",
    };
    render(<StatementSectionIncome data={data} />);
    const footerRow = screen.getByText(/total income collected/i).closest("tr")!;
    expect(footerRow.textContent).toContain("RM 0.00");
    expect(footerRow.textContent).not.toContain("3,000.00");
  });
});

// The partition aircond spread — Σ per-room submeters collected above the master TNB
// bill. It shares isInformational:true with letting commission (muted, outside every
// total) but means the OPPOSITE thing about the payout, which is what these pin.
describe("StatementSectionIncome — Extra Electricity (partition aircond spread)", () => {
  const extraElectricityRow = () =>
    makeRow({
      incomeType: "Extra Electricity",
      tenantName: null,
      amount: "50.00",
      chargedAmount: "50.00",
      paymentStatus: "paid",
      detail: "Aircond submeters collected above the TNB bill",
      isInformational: true,
    });

  // THE point of the branch. "Retained by KAEN" would be a lie here: the spread is the
  // owner's and already reached them, as Aircond Fee minus the master TNB expense.
  it("says the money is already in the payout — never 'Retained by KAEN'", () => {
    renderIncome([extraElectricityRow()]);
    const note = screen.getByTestId("income-row-informational-0");
    expect(note.textContent).toContain("Already included in your payout");
    expect(note.textContent).not.toContain("Retained by KAEN");
  });

  // Muted for the same reason as commission: it must not read as a SECOND payment on
  // top of the Aircond Fee row the owner can see just above it.
  it("renders the amount MUTED, so it never reads as extra earnings on top of Aircond Fee", () => {
    renderIncome([extraElectricityRow()]);
    const cell = screen.getByTestId("income-row-charged-0");
    expect(cell.className).toContain("text-muted-foreground");
    expect(cell.className).not.toContain("emerald");
  });

  // Both kinds can appear in one month; each must keep its own copy.
  it("keeps each informational kind's copy distinct when both are present", () => {
    const commission = makeRow({
      incomeType: "Admin Fee (First Month Rental)",
      amount: "3000.00",
      chargedAmount: "3000.00",
      isInformational: true,
    });
    renderIncome([commission, extraElectricityRow()]);
    expect(screen.getByTestId("income-row-informational-0").textContent).toContain("Retained by KAEN");
    expect(screen.getByTestId("income-row-informational-1").textContent).toContain("Already included");
  });
});
