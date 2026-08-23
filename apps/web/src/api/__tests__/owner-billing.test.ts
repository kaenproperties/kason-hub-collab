// owner-billing.ts — React-Query mutation tests for useGenerateStatement (BUG2).
//
// The per-month owner-statement page derives its statementId from
// useOwnerMonthlySummaries (["owner-monthly-summaries", ownerPartyId]) and reads
// useStatementSections (["statement-sections", statementId]) + the owner-ledger
// (OWNER_LEDGER_KEY). Generating a statement MUST invalidate ALL of those (plus
// OWNER_STATEMENTS_KEY) or the page shows "No statement generated" until a manual
// refresh. Follows the renderHook + fetch-mock precedent in owner-ledger-sections.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Auth mock (required by the api-client import chain) ──────────────────────
vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import {
  useGenerateStatement,
  useAllActiveFeeConfigs,
  OWNER_STATEMENTS_KEY,
  type OwnerStatementRow,
  type FeeConfigRow,
} from "../owner-billing";
import { OWNER_LEDGER_KEY } from "../owner-ledger";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = () => globalThis.fetch as ReturnType<typeof vi.fn>;

// ── Fixture ──────────────────────────────────────────────────────────────────

const statementFixture: OwnerStatementRow = {
  id: "stmt-gen-1",
  invoiceNumber: "OS-202606-owner123",
  invoiceType: "owner_statement",
  status: "draft",
  ownerPartyId: "owner-1",
  partyId: "owner-1",
  periodMonth: "2026-06-01T00:00:00.000Z",
  invoiceDate: "2026-06-01T00:00:00.000Z",
  dueDate: null,
  currency: "MYR",
  totalAmount: "316.00",
  sstAmount: "16.00",
  pdfKey: null,
  attachmentKeys: [],
  lines: [],
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

// ── useGenerateStatement ──────────────────────────────────────────────────────

describe("useGenerateStatement", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs /owner-billing/statements and returns the new statement on success", async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ data: statementFixture }));

    const qc = makeQueryClient();
    const { result } = renderHook(() => useGenerateStatement(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ ownerPartyId: "owner-1", billingMonth: "2026-06" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/owner-billing/statements");
    expect(init.method).toBe("POST");
    expect(result.current.data?.data.id).toBe("stmt-gen-1");
  });

  it("on success invalidates the per-month page's keys: monthly-summaries + statement-sections + owner-ledger (and statements)", async () => {
    fetchMock().mockResolvedValueOnce(makeResponse({ data: statementFixture }));

    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(() => useGenerateStatement(), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ ownerPartyId: "owner-1", billingMonth: "2026-06" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The exact prefix keys the per-month statement page reads. Prefix form so a
    // partial match invalidates every ownerPartyId / statementId variant.
    const invalidatedKeys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidatedKeys).toContain(JSON.stringify(OWNER_STATEMENTS_KEY)); // ["owner-statements"]
    expect(invalidatedKeys).toContain(JSON.stringify(["owner-monthly-summaries"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["statement-sections"]));
    expect(invalidatedKeys).toContain(JSON.stringify(OWNER_LEDGER_KEY)); // ["owner-ledger"]
  });
});

// ── useAllActiveFeeConfigs (Task 7 / R4) ──────────────────────────────────────
// Backs the Settings owner-readiness overview. The list endpoint caps limit at
// 100, so this hook pages client-side until a short page is returned. Proves the
// paging loop itself (not exercised by the component test, which only ever
// stubs a single short page).

function makeRow(i: number): FeeConfigRow {
  return {
    id: `cfg-${i}`,
    ownerPartyId: `owner-${i}`,
    propertyId: null,
    feeType: "percent",
    feeValue: "10",
    capAmount: null,
    sstPercent: "8",
    firstChargeMonth: null,
    firstChargeBaseAmount: null,
    paxDeductionPerPerson: null,
    freePeriodStart: null,
    freePeriodEnd: null,
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("useAllActiveFeeConfigs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pages until a short page is returned and flattens all items", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 5 }, (_, i) => makeRow(100 + i));
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ data: { items: page1, limit: 100, offset: 0 } }))
      .mockResolvedValueOnce(makeResponse({ data: { items: page2, limit: 100, offset: 100 } }));

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAllActiveFeeConfigs(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(105);
    expect(fetchMock().mock.calls).toHaveLength(2);
    const [firstUrl] = fetchMock().mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock().mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain("isActive=true");
    expect(firstUrl).toContain("offset=0");
    expect(secondUrl).toContain("offset=100");
  });
});
