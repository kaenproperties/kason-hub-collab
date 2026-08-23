import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from "@/lib/api-client";
import type { FeeConfigRow } from "@/api/owner-billing";
import OwnerBillingSettingsPage from "../owner-billing-section";

const apiFetchMock = vi.mocked(apiFetch);

const owners = [
  { id: "owner-1", displayName: "Tan Sri Lim" },
  { id: "owner-2", displayName: "Datuk Wong" },
];

function activeCfg(over: Partial<FeeConfigRow>): FeeConfigRow {
  return {
    id: "cfg-1", ownerPartyId: "owner-1", propertyId: null, feeType: "percent", feeValue: "10",
    capAmount: null, sstPercent: "8", firstChargeMonth: null, firstChargeBaseAmount: null,
    paxDeductionPerPerson: null, freePeriodStart: null, freePeriodEnd: null,
    isActive: true, effectiveFrom: null, effectiveTo: null, createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z", ...over,
  };
}

function stub(activeConfigs: FeeConfigRow[]) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/parties/owners") return Promise.resolve({ data: owners }) as ReturnType<typeof apiFetch>;
    if (path.startsWith("/inventory/properties")) return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    if (path.startsWith("/owner-billing/fee-configs")) {
      return Promise.resolve({ data: { items: activeConfigs, limit: 100, offset: 0 } }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <OwnerBillingSettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

// The PageHeader description ("...Set up an owner's fee...") and the info Callout
// ("...Set up billing") both contain the substring "Set up", so plain-text /set
// up/i queries are ambiguous against the whole page. Scope status-badge lookups
// to the owner-row list itself (data-testid="owner-billing-list").
function ownerList(): HTMLElement {
  return screen.getByTestId("owner-billing-list");
}

describe("OwnerBillingSettingsPage (read-only overview)", () => {
  it("shows Set up (with fee) for owner-1 and Missing for owner-2", async () => {
    stub([activeCfg({ ownerPartyId: "owner-1" })]);
    renderPage();
    const owner1Name = await screen.findByText("Tan Sri Lim");
    const owner2Name = screen.getByText("Datuk Wong");
    // Bind each status label to its OWN owner's row (not just "present somewhere
    // on the page") — the row is the nearest ancestor <a>, since each owner is
    // rendered as one Link containing both its name and its status.
    const owner1Row = owner1Name.closest("a") as HTMLElement;
    const owner2Row = owner2Name.closest("a") as HTMLElement;
    expect(within(owner1Row).getByText(/set up/i)).toBeInTheDocument();
    expect(within(owner1Row).queryByText(/missing/i)).not.toBeInTheDocument();
    expect(within(owner2Row).getByText(/missing/i)).toBeInTheDocument();
    expect(within(owner2Row).queryByText(/set up/i)).not.toBeInTheDocument();
  });

  it("links each owner row to the owner detail", async () => {
    stub([activeCfg({ ownerPartyId: "owner-1" })]);
    renderPage();
    await screen.findByText("Tan Sri Lim");
    const links = screen.getAllByRole("link");
    expect(links.some((a) => a.getAttribute("href") === "/parties/owners")).toBe(true);
  });

  it("has no write controls (New / Edit / Retire / Restore)", async () => {
    stub([activeCfg({ ownerPartyId: "owner-1" })]);
    renderPage();
    await screen.findByText("Tan Sri Lim");
    expect(screen.queryByRole("button", { name: /new fee config/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Edit$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Retire$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Restore$/)).not.toBeInTheDocument();
  });

  it("shows a loading state (not Missing) while fee configs are still paging in", async () => {
    // Owners resolves quickly; fee-configs is still in flight (useAllActiveFeeConfigs
    // can still be paging). The overview must show a loading state, not flash
    // "Missing" for every owner before configByOwner is populated.
    let resolveConfigs!: (v: unknown) => void;
    const configsPromise = new Promise((resolve) => {
      resolveConfigs = resolve;
    });
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/parties/owners") return Promise.resolve({ data: owners }) as ReturnType<typeof apiFetch>;
      if (path.startsWith("/owner-billing/fee-configs")) return configsPromise as ReturnType<typeof apiFetch>;
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    });

    renderPage();

    expect(await screen.findByTestId("owner-billing-loading")).toBeInTheDocument();
    expect(screen.queryByText(/missing/i)).not.toBeInTheDocument();

    // Resolve fee-configs (owner-1 set up, owner-2 not) and confirm the page
    // moves on to the real rows — proves the assertion above wasn't just
    // "nothing rendered yet at all".
    resolveConfigs({
      data: { items: [activeCfg({ ownerPartyId: "owner-1" })], limit: 100, offset: 0 },
    });
    expect(await screen.findByText("Datuk Wong")).toBeInTheDocument();
    const owner2Row = screen.getByText("Datuk Wong").closest("a") as HTMLElement;
    expect(within(owner2Row).getByText(/missing/i)).toBeInTheDocument();
    expect(screen.queryByTestId("owner-billing-loading")).not.toBeInTheDocument();
  });

  it("shows the danger Callout when a load fails", async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === "/parties/owners") return Promise.reject(new Error("network down"));
      return Promise.resolve({ data: { items: [], limit: 100, offset: 0 } }) as ReturnType<
        typeof apiFetch
      >;
    });
    renderPage();
    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
    // No editing controls exist to fail on the error path either.
    expect(screen.queryByRole("button", { name: /new fee config/i })).not.toBeInTheDocument();
  });

  it("falls back to the raw fee value when computeManagementFee throws (malformed cap config)", async () => {
    // feeType "cap" with capAmount: null makes computeManagementFee throw
    // ('capAmount is required when feeType is "cap"') — the row must still
    // render "Set up" via a defensive fallback, never crash the page.
    stub([
      activeCfg({ ownerPartyId: "owner-1", feeType: "cap", feeValue: "15", capAmount: null }),
    ]);
    renderPage();
    expect(await screen.findByText("Tan Sri Lim")).toBeInTheDocument();
    expect(within(ownerList()).getByText(/set up/i)).toBeInTheDocument();
    expect(within(ownerList()).getByText("15")).toBeInTheDocument();
  });

  it("shows the first config's summary when an owner has two active configs", async () => {
    // owner-1 carries an all-properties default (listed first) plus a
    // property-scoped override (listed second) — both active. The overview
    // must pick a single, deterministic config (the first-resolved one) rather
    // than silently showing whichever the map-building loop visited last.
    stub([
      activeCfg({ id: "cfg-first", ownerPartyId: "owner-1", propertyId: null, feeType: "percent", feeValue: "10", sstPercent: "8" }),
      activeCfg({ id: "cfg-second", ownerPartyId: "owner-1", propertyId: "prop-1", feeType: "fixed", feeValue: "500", sstPercent: "8" }),
    ]);
    renderPage();
    expect(await screen.findByText("Tan Sri Lim")).toBeInTheDocument();
    expect(within(ownerList()).getByText(/10% \+ 8% SST/)).toBeInTheDocument();
    expect(within(ownerList()).queryByText(/RM500/)).not.toBeInTheDocument();
  });
});
