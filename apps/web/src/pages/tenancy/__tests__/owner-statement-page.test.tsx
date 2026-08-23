// Tests for OwnerStatementPage (Task 2c-3).
//
// Asserts:
//  1. null statementId month → shows the "No statement issued yet" callout and
//     offers NO manual generate/issue control (both are automatic now).
//  2. valid statementId → useStatementSections renders 5 section headings
//     + the correct net-payout amount (RM 2,500.00).
//  3. Print PDF is the primary action and is always available under the
//     live-ledger flag — no issue, no approval, no pdfKey required.
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && npx vitest run owner-statement-page
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock the owner-ledger hooks (data hooks)
import type { MonthlyStatementSummary, YannieSections } from "@/api/owner-ledger";

const mockSections: YannieSections = {
  header: {
    reportMonth: "June 2026",
    propertyName: "KAEN Residences",
    ownerName: "Tan Sri Lim",
    bankName: "Maybank",
    accountHolder: "TAN AH KOW",
    accountNumberMasked: "••••1234",
  },
  apartmentId: null,
  occupancy: {
    rows: [
      {
        unitCode: "A-10-04",
        tenantName: "Ahmad Bin Ali",
        tenancyStart: "2026-01-01",
        tenancyEnd: "2026-12-31",
        monthlyRental: "1500.00",
        depositMonths: 2,
        depositAmount: "3000.00",
        isVacant: false,
      },
    ],
    occupiedCount: 1,
    vacantCount: 0,
    totalMonthlyRental: "1500.00",
  },
  payoutSummary: {
    lines: [
      { label: "Gross Rental", amount: "3000.00" },
      { label: "Management Fee", amount: "-300.00" },
      { label: "Electricity", amount: "-200.00" },
    ],
    netPayoutToOwner: "2500.00",
    depositCollected: "0.00",
  },
  incomeBreakdown: {
    rows: [
      {
        unitCode: "A-10-04",
        tenantName: "Ahmad Bin Ali",
        incomeType: "Monthly",
        billingPeriod: "June 2026",
        amount: "1500.00",
        mgmtFee: "150.00",
        mgmtFeeSst: "12.00",
        paymentStatus: "paid",
      },
    ],
    totalIncome: "3000.00",
    totalMgmtFee: "300.00",
  },
  expenseBreakdown: {
    rows: [
      {
        category: "Electricity (TNB)",
        categoryKey: "utilities_tnb",
        description: "TNB June 2026",
        amount: "200.00",
        sstAmount: "0.00",
        paymentStatus: "paid",
      },
    ],
    totalExpenses: "200.00",
  },
};

const mockSummaryWithStatement: MonthlyStatementSummary = {
  month: "2026-06",
  grossRental: "3000.00",
  totalExpenses: "200.00",
  netPayoutToOwner: "2500.00",
  depositCollected: "0.00",
  statementId: "stmt-abc",
  statementStatus: "draft",
  hasData: true,
};

const mockSummaryNoStatement: MonthlyStatementSummary = {
  month: "2026-05",
  grossRental: "0.00",
  totalExpenses: "0.00",
  netPayoutToOwner: "0.00",
  depositCollected: "0.00",
  statementId: null,
  statementStatus: null,
  hasData: false,
};

// Task 9 — live ledger fixture: posted activity exists (hasData: true) but NO
// statement has been issued yet (statementId: null). With the live-ledger flag
// ON the admin must see these figures WITHOUT clicking "Issue statement".
const mockSummaryLiveNoStatement: MonthlyStatementSummary = {
  month: "2026-07",
  grossRental: "4200.00",
  totalExpenses: "700.00",
  netPayoutToOwner: "3500.00",
  depositCollected: "0.00",
  statementId: null,
  statementStatus: null,
  hasData: true,
};

// Web mirror of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER. Read at render time by
// isPhase2FlagEnabled(), so vi.stubEnv before renderPage flips the branch without
// needing vi.resetModules.
const LIVE_FLAG = "VITE_ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// Mock the owner-billing surface the page still uses. The generate/approve/
// regenerate/send mutations are NOT stubbed any more — the page no longer imports
// them; issuing, approving and sending are automatic (payment hook + month-end
// cron), so there is nothing left on this page to mock them for.
const mockDownloadLivePdf = vi.fn();
// mockPdfKey starts with "mock" so Vitest hoists it above vi.mock's hoisting.
let mockPdfKey: string | null = null;
// mockAttachmentKeys drives the mock statement's attachmentKeys (the bulk-receipt
// storage keys the Supporting Documents panel renders). "mock"-prefixed so Vitest
// hoists it above vi.mock's hoisting, same trick as mockPdfKey.
let mockAttachmentKeys: string[] = [];

vi.mock("@/api/owner-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-billing")>();
  return {
    ...actual,
    fetchStatementPdfUrl: vi.fn().mockResolvedValue("https://example.com/statement.pdf"),
    // Live PDF render — streams bytes in production; stubbed so Print PDF never
    // hits the network here.
    downloadLiveStatementPdf: (args: unknown) => mockDownloadLivePdf(args),
    // B3 per-expense proof hooks — stubbed so the Expense Breakdown's Bill column
    // renders without hitting the network (no proofs ⇒ each row shows "Attach bill").
    useExpenseProofs: () => ({ data: undefined, isLoading: false }),
    useAttachExpenseProof: () => ({ mutate: vi.fn(), isPending: false }),
    useDetachExpenseProof: () => ({ mutate: vi.fn(), isPending: false }),
    useStatement: (_id: string | null) => ({
      data: _id
        ? {
            data: {
              id: "stmt-abc",
              invoiceNumber: "OS-202606-00000000",
              invoiceType: "owner_statement",
              status: "draft",
              ownerPartyId: "owner-1",
              partyId: "owner-1",
              periodMonth: "2026-06-01T00:00:00.000Z",
              invoiceDate: "2026-06-01T00:00:00.000Z",
              dueDate: null,
              currency: "MYR",
              totalAmount: "2500.00",
              sstAmount: "0.00",
              pdfKey: mockPdfKey,
              attachmentKeys: mockAttachmentKeys,
              lines: [],
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          }
        : undefined,
      isLoading: false,
    }),
  };
});

vi.mock("@/api/owner-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-ledger")>();
  return {
    ...actual,
    useOwnerMonthlySummaries: (ownerPartyId: unknown) => ({
      data: {
        data: {
          items:
            ownerPartyId === "owner-1"
              ? [mockSummaryWithStatement, mockSummaryNoStatement, mockSummaryLiveNoStatement]
              : [],
        },
      },
      isLoading: false,
    }),
    useStatementSections: (statementId: unknown) => ({
      data: statementId === "stmt-abc" ? { data: mockSections } : undefined,
      isLoading: false,
      isError: false,
    }),
    // LIVE 5-section fetch (flag on, no statement issued). Returns the SAME
    // YannieSections shape for the live no-statement month (owner-1 / 2026-07).
    useLiveStatementSections: (ownerPartyId: unknown, billingMonth: unknown) => ({
      data:
        ownerPartyId === "owner-1" && billingMonth === "2026-07"
          ? { data: mockSections }
          : undefined,
      isLoading: false,
      isError: false,
    }),
  };
});

import OwnerStatementPage from "../owner-statement-page";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage(ownerPartyId: string, month: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tenancy/owners/${ownerPartyId}/statements/${month}`]}>
        <Routes>
          <Route
            path="/tenancy/owners/:ownerPartyId/statements/:month"
            element={<OwnerStatementPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Same page via the PER-UNIT route, which carries an apartmentId param. */
function renderPerUnitPage(ownerPartyId: string, apartmentId: string, month: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[
          `/tenancy/owners/${ownerPartyId}/units/${apartmentId}/statements/${month}`,
        ]}
      >
        <Routes>
          <Route
            path="/tenancy/owners/:ownerPartyId/units/:apartmentId/statements/:month"
            element={<OwnerStatementPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPdfKey = null;
  mockAttachmentKeys = [];
  // Default the live-ledger flag OFF so the pre-existing suites exercise the
  // current (Generate-gated) behavior. Flag-ON tests re-stub "true" per case.
  vi.stubEnv(LIVE_FLAG, "false");
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OwnerStatementPage — null statementId", () => {
  it("shows a 'No statement issued yet' state when statementId is null", () => {
    renderPage("owner-1", "2026-05");
    expect(screen.getByText(/No statement issued yet/i)).toBeTruthy();
  });

  // The manual issuer is gone everywhere: the mgmt fee is minted by the payment
  // hook when rent settles, and the month's final statement by the month-end
  // cron. A manual Generate was a no-op at best and, on a part-paid month, billed
  // the fee off CONTRACTED rent against a ledger that deducts off COLLECTED.
  it("offers no manual Generate / Issue control when statementId is null", () => {
    renderPage("owner-1", "2026-05");
    expect(screen.queryByRole("button", { name: /Generate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Issue/i })).toBeNull();
  });
});

describe("OwnerStatementPage — 5-section render", () => {
  it("renders all 5 section headings when statementId is set", () => {
    renderPage("owner-1", "2026-06");

    // Section titles render inside CardTitle (a div, not an h2).
    // Use getByText to verify each section is present in the document.
    // Section 1: Statement Details / Header
    expect(screen.getByText(/Statement Details/i)).toBeTruthy();
    // Section 2: Occupancy
    expect(screen.getByText(/^Occupancy$/i)).toBeTruthy();
    // Section 3: Payout Summary
    expect(screen.getByText(/Payout Summary/i)).toBeTruthy();
    // Section 4: Income Breakdown
    expect(screen.getByText(/Income Breakdown/i)).toBeTruthy();
    // Section 5: Expense Breakdown
    expect(screen.getByText(/Expense Breakdown/i)).toBeTruthy();
  });

  it("renders the correct net payout amount from sections data", () => {
    renderPage("owner-1", "2026-06");
    // netPayoutToOwner = "2500.00" → formatRM → "RM 2,500.00"
    expect(screen.getAllByText(/RM 2,500\.00/)[0]).toBeTruthy();
  });

  it("separates payout additions from red, explicitly signed deductions", () => {
    renderPage("owner-1", "2026-06");
    expect(screen.getByText("Additions (+)")).toBeInTheDocument();
    expect(screen.getByText("Deductions (−)")).toBeInTheDocument();
    const deduction = screen.getByText("− RM 300.00");
    expect(deduction).toHaveClass("text-red-700");
  });

  it("shows the owner name in the header section", () => {
    renderPage("owner-1", "2026-06");
    expect(screen.getByText("Tan Sri Lim")).toBeTruthy();
  });

  it("shows the masked account number in the header section", () => {
    renderPage("owner-1", "2026-06");
    expect(screen.getByText("••••1234")).toBeTruthy();
  });

  it("renders the income table row with a status Badge", () => {
    renderPage("owner-1", "2026-06");
    // A-10-04 appears in both occupancy + income sections — use getAllByText
    const unitCells = screen.getAllByText("A-10-04");
    expect(unitCells.length).toBeGreaterThan(0);
    // Income type badge "Monthly" is visible in the income table
    expect(screen.getByText("Monthly")).toBeTruthy();
  });

  it("renders paymentStatus StatusPill for income rows", () => {
    renderPage("owner-1", "2026-06");
    // mockSections.incomeBreakdown.rows[0].paymentStatus === "paid"
    expect(screen.getAllByText("paid").length).toBeGreaterThan(0);
  });

  it("shows the View issued PDF button when pdfKey is set", () => {
    mockPdfKey = "statements/owner-1/2026-06.pdf";
    renderPage("owner-1", "2026-06");
    expect(screen.getByRole("button", { name: /View issued PDF/i })).toBeTruthy();
  });

  it("does NOT show the View issued PDF button when pdfKey is null", () => {
    // mockPdfKey is null (reset in beforeEach)
    renderPage("owner-1", "2026-06");
    expect(screen.queryByRole("button", { name: /View issued PDF/i })).toBeNull();
  });
});

describe("OwnerStatementPage — per-expense bills (bulk Supporting Documents panel retired)", () => {
  // NOTE: native matchers only (getByText / queryByText / getAllByText / toBeNull /
  // toBeTruthy). The worktree vitest run does NOT register jest-dom, so
  // toBeInTheDocument is unavailable here; these assertions hold with or without it.

  it("retires the bulk 'Supporting Documents' panel + receipt dropzone", () => {
    // Even with a statement-level attachment present, the old one-pile panel is gone.
    mockAttachmentKeys = ["statements/owner-1/2026-06/tnb-june.pdf"];
    renderPage("owner-1", "2026-06");

    // The bulk receipt panel + its dropzone are retired in favour of per-row bills.
    expect(screen.queryByText("Supporting Documents")).toBeNull();
    expect(screen.queryByText(/Click or drop receipts to upload/i)).toBeNull();
  });

  it("surfaces per-expense bills in the Expense Breakdown (Bill column + Attach bill)", () => {
    renderPage("owner-1", "2026-06");

    // The Expense Breakdown now carries a per-row Bill column; with no proof attached
    // (stubbed empty) each expense row shows the admin "Attach bill" affordance.
    expect(screen.getByText("Bill")).toBeTruthy();
    expect(screen.getAllByText("Attach bill").length).toBeGreaterThan(0);
  });
});

// ─── Task 9 — live ledger view (flag ON) ────────────────────────────────────
//
// The admin's original pain point: to SEE a month's numbers they had to click
// "Generate", because the whole view was gated on statementId. With the
// live-ledger flag ON, summaryRow's live figures render whenever hasData is true,
// with NO "No statement generated" gate; the empty state only appears when there
// is genuinely no posted activity; and the primary button becomes "Issue
// statement" (the statement is a product, not a prerequisite to viewing).
describe("OwnerStatementPage — live ledger view (flag ON)", () => {
  it("renders live figures without the 'Generate to see' gate (hasData:true, statementId:null)", () => {
    vi.stubEnv(LIVE_FLAG, "true");
    renderPage("owner-1", "2026-07");

    // Live net payout is visible even though no statement has been issued.
    // netPayoutToOwner = "3500.00" → formatRM → "RM 3,500.00"
    expect(screen.getAllByText(/RM 3,500\.00/)[0]).toBeTruthy();
    // Gross rental + total expenses render alongside it.
    expect(screen.getByText(/RM 4,200\.00/)).toBeTruthy();
    expect(screen.getByText(/RM 700\.00/)).toBeTruthy();

    // The old Generate-to-see gate is GONE.
    expect(screen.queryByText(/No statement has been generated/i)).toBeNull();
    expect(screen.queryByText(/No statement generated/i)).toBeNull();
  });

  it("shows a 'No activity this month' empty state when there is no posted data", () => {
    vi.stubEnv(LIVE_FLAG, "true");
    // 2026-05 → hasData:false, statementId:null
    renderPage("owner-1", "2026-05");

    expect(screen.getByText(/No activity this month/i)).toBeTruthy();
    // Not the old "No statement generated" callout.
    expect(screen.queryByText(/No statement generated/i)).toBeNull();
  });

  it("makes 'Print PDF' the primary action when the flag is on", () => {
    vi.stubEnv(LIVE_FLAG, "true");
    renderPage("owner-1", "2026-07");

    // Print is unconditional — it renders live from the ledger, so it needs no
    // issued statement, no approval and no pdfKey.
    expect(screen.getByRole("button", { name: /Print PDF/i })).toBeTruthy();
    // The manual money actions are gone.
    expect(screen.queryByRole("button", { name: /^Generate$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Issue statement/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send/i })).toBeNull();
  });

  // Viewing the FULL 5-section detail requires nothing at all. With the flag on
  // + no statementId, the live sections (computed from the posted ledger) render
  // the SAME 5 section sub-components, with no gate and no issue step — and
  // Print PDF hands you those exact figures.
  it("renders the full 5-section detail LIVE (flag on, no statement issued)", () => {
    vi.stubEnv(LIVE_FLAG, "true");
    renderPage("owner-1", "2026-07");

    // All 5 section headings render from useLiveStatementSections — no Invoice.
    expect(screen.getByText(/Statement Details/i)).toBeTruthy();
    expect(screen.getByText(/^Occupancy$/i)).toBeTruthy();
    expect(screen.getByText(/Payout Summary/i)).toBeTruthy();
    expect(screen.getByText(/Income Breakdown/i)).toBeTruthy();
    expect(screen.getByText(/Expense Breakdown/i)).toBeTruthy();

    // No gate of any kind, and the PDF is reachable without issuing.
    expect(screen.queryByText(/No statement generated/i)).toBeNull();
    expect(screen.queryByText(/No statement issued yet/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Print PDF/i })).toBeTruthy();
  });
});

// ─── Print PDF — the always-available working copy ────────────────────────────
// The whole point of the button: the admin pulls the statement PDF whenever they
// want, with no issue step, no approval and no stored artifact. It renders the
// figures AS THEY STAND, so it must work on a month with nothing issued at all.

describe("OwnerStatementPage — Print PDF", () => {
  it("downloads the LIVE pdf for the combined scope (no apartmentId) with no statement issued", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    renderPage("owner-1", "2026-07");

    fireEvent.click(screen.getByRole("button", { name: /Print PDF/i }));

    await waitFor(() => expect(mockDownloadLivePdf).toHaveBeenCalledTimes(1));
    // No apartmentId key at all ⇒ the API omits it ⇒ combined statement.
    expect(mockDownloadLivePdf).toHaveBeenCalledWith({
      ownerPartyId: "owner-1",
      billingMonth: "2026-07",
    });
  });

  it("scopes the download to the apartment on the per-unit route", async () => {
    vi.stubEnv(LIVE_FLAG, "true");
    renderPerUnitPage("owner-1", "apt-9", "2026-07");

    fireEvent.click(screen.getByRole("button", { name: /Print PDF/i }));

    await waitFor(() => expect(mockDownloadLivePdf).toHaveBeenCalledTimes(1));
    expect(mockDownloadLivePdf).toHaveBeenCalledWith({
      ownerPartyId: "owner-1",
      billingMonth: "2026-07",
      apartmentId: "apt-9",
    });
  });

  it("is offered even when a statement HAS been issued — alongside the formal copy", () => {
    vi.stubEnv(LIVE_FLAG, "true");
    mockPdfKey = "statements/owner-1/2026-06.pdf";
    renderPage("owner-1", "2026-06");

    // Two DIFFERENT documents: the live working copy and the issued owner copy.
    expect(screen.getByRole("button", { name: /Print PDF/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /View issued PDF/i })).toBeTruthy();
  });

  it("hides Print PDF when the live-ledger flag is off (the endpoint 404s)", () => {
    // Flag defaults to "false" in beforeEach.
    renderPage("owner-1", "2026-06");
    expect(screen.queryByRole("button", { name: /Print PDF/i })).toBeNull();
  });
});
