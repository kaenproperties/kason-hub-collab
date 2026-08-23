import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Hoist mocks before module imports ─────────────────────────────────────────

const mockMutate = vi.hoisted(() => vi.fn());
const mockUseOwnerDetail = vi.hoisted(() => vi.fn());
const mockIsPhase2FlagEnabled = vi.hoisted(() => vi.fn());
const mockUseFeeConfigs = vi.hoisted(() => vi.fn());
const mockEditOwnerDialog = vi.hoisted(() => vi.fn());
const mockDisplayPhone = vi.hoisted(() => vi.fn((raw: string) => `formatted:${raw}`));

vi.mock("@/api/parties-detail", () => ({
  useOwnerDetail: mockUseOwnerDetail,
  useRevealPartyIc: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: mockIsPhase2FlagEnabled,
}));

vi.mock("@/api/owner-billing", () => ({
  useFeeConfigs: mockUseFeeConfigs,
}));
// FeeConfigDrawer is opened by the affordance — stub it so its hooks never run.
const mockFeeConfigDrawer = vi.hoisted(() => vi.fn());
vi.mock("@/pages/settings/sections/owner-billing/fee-config-drawer", () => ({
  FeeConfigDrawer: mockFeeConfigDrawer,
}));
// Properties list fetch (for the drawer's property scope).
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(() => Promise.resolve({ data: [] })),
  API_BASE: "",
  ApiError: class ApiError extends Error {},
}));

// Minimal EditOwnerDialog mock — hoisted so individual tests can override
// the implementation (e.g. to expose a close button for invalidation tests).
vi.mock("@/pages/parties/owners-action-dialogs", () => ({
  EditOwnerDialog: mockEditOwnerDialog,
  BlacklistOwnerDialog: vi.fn(() => null),
  CreateOwnerDialog: vi.fn(() => null),
}));

vi.mock("@/pages/tenancy/tenant-tracker/phone-display", () => ({
  displayPhone: mockDisplayPhone,
}));

vi.mock("../portal-access-section", () => ({
  PortalAccessSection: () => React.createElement("div", null, "portal-access-section"),
}));

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

// ── Imports (after mock declarations) ────────────────────────────────────────

import { OwnerDetailPanel } from "../owner-detail-panel";
import type { OwnerDetail } from "@/api/parties-detail";
import type { FeeConfigRow } from "@/api/owner-billing";
import { getStoredUser } from "@/lib/auth";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE: OwnerDetail = {
  id: "owner-1",
  displayName: "Dato' Razak",
  legalName: "Razak bin Abdullah",
  primaryEmail: "razak@example.com",
  primaryPhone: "+60123456789",
  formattedPhone: "+60 12-345 6789",
  whatsappPhone: "+60123456789",
  idType: "ic",
  idNumberMasked: "••••5678",
  nationality: "MY",
  gender: "male",
  dateOfBirth: "1970-05-15",
  occupation: null,
  employerName: null,
  employerAddress: null,
  monthlyIncome: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  isBlacklisted: false,
  blacklistReason: null,
  status: "active",
  bank: {
    name: "Maybank",
    accountHolder: "Razak bin Abdullah",
    accountNumber: "5123456789",
  },
  unitsOwned: [
    { apartmentId: "apt-1", unitCode: "A-19-02", propertyName: "Amber Court" },
    { apartmentId: "apt-2", unitCode: "A-10-04", propertyName: "Amber Court" },
  ],
  createdAt: "2026-01-15T10:00:00.000Z",
  portalUser: null,
};

function makeFeeConfig(over?: Partial<FeeConfigRow>): FeeConfigRow {
  return {
    id: "fc-1",
    ownerPartyId: "owner-1",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      MemoryRouter,
      {},
      React.createElement(QueryClientProvider, { client: qc }, children),
    );
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OwnerDetailPanel", () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockDisplayPhone.mockImplementation((raw: string) => `formatted:${raw}`);
    mockEditOwnerDialog.mockImplementation(({ open }: { open: boolean }) =>
      open ? React.createElement("div", null, "Edit Owner Dialog") : null,
    );
    // Default: flag OFF, no fee configs
    mockIsPhase2FlagEnabled.mockReturnValue(false);
    mockUseFeeConfigs.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: { items: [], limit: 20, offset: 0 } },
    });
    mockFeeConfigDrawer.mockImplementation(
      ({ open, mode, lockedOwner }: { open: boolean; mode: string; lockedOwner?: { displayName: string } }) =>
        open ? React.createElement("div", null, `drawer:${mode}:${lockedOwner?.displayName ?? ""}`) : null,
    );
    // Reset to the file's default admin role — the manager test overrides this
    // for its own run only; without a reset here, that override would silently
    // leak into whichever test happens to run next.
    vi.mocked(getStoredUser).mockReturnValue({ id: "u1", fullName: "Test", role: "admin" } as never);
  });

  it("renders a loading skeleton while query is pending", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByLabelText("Loading details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit owner/i })).not.toBeInTheDocument();
  });

  it("renders bank name, account holder, and account number from fixture", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("Maybank")).toBeInTheDocument();
    expect(screen.getByText("Razak bin Abdullah")).toBeInTheDocument();
    expect(screen.getByText("5123456789")).toBeInTheDocument();
  });

  it("always renders unitsOwned codes regardless of flag state", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });
    // Flag is OFF (set in beforeEach)

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText(/A-19-02/)).toBeInTheDocument();
    expect(screen.getByText(/A-10-04/)).toBeInTheDocument();
  });

  it("labels units owned with their property name", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Property name must be shown — a bare unit code is ambiguous across
    // properties (the reported "showing unit number ONLY" defect).
    expect(screen.getByText("Amber Court")).toBeInTheDocument();
  });

  it("groups units under one heading per property (property not repeated, codes not duplicated)", () => {
    const multiProp: OwnerDetail = {
      ...FIXTURE,
      unitsOwned: [
        { apartmentId: "apt-1", unitCode: "A-19-02", propertyName: "Amber Court" },
        { apartmentId: "apt-2", unitCode: "A-10-04", propertyName: "Amber Court" },
        { apartmentId: "apt-3", unitCode: "B-02-01", propertyName: "Zen Towers" },
      ],
    };
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: multiProp,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Each property heading appears exactly once (units grouped under it).
    expect(screen.getAllByText("Amber Court")).toHaveLength(1);
    expect(screen.getAllByText("Zen Towers")).toHaveLength(1);
    // All three distinct unit codes are visible.
    expect(screen.getByText(/A-19-02/)).toBeInTheDocument();
    expect(screen.getByText(/A-10-04/)).toBeInTheDocument();
    expect(screen.getByText(/B-02-01/)).toBeInTheDocument();
  });

  it("with ENABLE_PHASE2_OWNER_BILLING ON: renders fee summary and the ledger link", () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseFeeConfigs.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: { items: [makeFeeConfig()], limit: 20, offset: 0 } },
    });
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Fee summary: "10% + 8% SST" from the active config
    expect(screen.getByText(/10%.*8%\s*SST/)).toBeInTheDocument();

    // The Owner Ledger is the only link now — the "Owner Statements" one went
    // with that page, and the ledger is the front door for both.
    expect(screen.getByRole("link", { name: "Owner Ledger" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Owner Statements" })).not.toBeInTheDocument();
  });

  it("with ENABLE_PHASE2_OWNER_BILLING ON + useFeeConfigs error: fee absent, ledger link present", () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseFeeConfigs.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Management fee line ABSENT (fee fetch errored)
    expect(screen.queryByText(/management fee/i)).not.toBeInTheDocument();

    // Ledger link still present (rendered outside OwnerFeeSummary)
    expect(screen.getByRole("link", { name: "Owner Ledger" })).toBeInTheDocument();
  });

  it("with ENABLE_PHASE2_OWNER_BILLING OFF: no fee summary, no links; units still shown", () => {
    mockIsPhase2FlagEnabled.mockReturnValue(false);
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Units still visible
    expect(screen.getByText(/A-19-02/)).toBeInTheDocument();

    // No links
    expect(screen.queryByRole("link", { name: "Owner Statements" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Owner Ledger" })).not.toBeInTheDocument();

    // No fee summary text
    expect(screen.queryByText(/management fee/i)).not.toBeInTheDocument();
  });

  it("clicking Edit Owner button opens EditOwnerDialog", async () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Dialog not open initially
    expect(screen.queryByText("Edit Owner Dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Owner" }));

    await waitFor(() => {
      expect(screen.getByText("Edit Owner Dialog")).toBeInTheDocument();
    });
  });

  it("renders an error alert when query fails", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      error: new Error("Not found"),
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("renders — for null bank fields and 'No units' when unitsOwned is empty", () => {
    const sparse: OwnerDetail = {
      ...FIXTURE,
      bank: { name: null, accountHolder: null, accountNumber: null },
      unitsOwned: [],
    };
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: sparse,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("No units")).toBeInTheDocument();
    // At least some "—" placeholders for null bank fields
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("formats whatsappPhone with displayPhone helper (not raw)", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // displayPhone is mocked to return "formatted:<raw>"; FIXTURE.whatsappPhone = "+60123456789"
    expect(screen.getByText("formatted:+60123456789")).toBeInTheDocument();
  });

  it("closing the Edit dialog invalidates the owner detail query", async () => {
    // Override the dialog mock to expose a close button that triggers onOpenChange(false)
    mockEditOwnerDialog.mockImplementation(
      ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) =>
        open
          ? React.createElement(
              "div",
              null,
              "Edit Owner Dialog",
              React.createElement("button", { onClick: () => onOpenChange(false) }, "Close dialog"),
            )
          : null,
    );

    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        MemoryRouter,
        {},
        React.createElement(QueryClientProvider, { client: qc }, children),
      );

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: Wrapper });

    // Open the dialog
    fireEvent.click(screen.getByRole("button", { name: "Edit Owner" }));
    await waitFor(() => expect(screen.getByText("Edit Owner Dialog")).toBeInTheDocument());

    // Close the dialog via the mock's close button
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["parties", "owners", "owner-1"] }),
      );
    });
  });

  it("renders — for null gender and DOB", () => {
    const noGenderDob: OwnerDetail = {
      ...FIXTURE,
      gender: null,
      dateOfBirth: null,
    };
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: noGenderDob,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    // Both fields must render their label and show "—" (not be absent from DOM)
    expect(screen.getByText("Gender")).toBeInTheDocument();
    expect(screen.getByText("Date of birth")).toBeInTheDocument();
    // Multiple "—" cells; at least two for gender + DOB
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders the masked IC via IcRevealField (Reveal button visible)", () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByText("••••5678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
  });

  it("admin + active config: shows 'Edit fee' and opens the locked drawer in edit mode", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseFeeConfigs.mockReturnValue({ isLoading: false, isError: false, data: { data: { items: [makeFeeConfig()], limit: 20, offset: 0 } } });
    mockUseOwnerDetail.mockReturnValue({ isLoading: false, isError: false, data: FIXTURE, error: null });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    const btn = screen.getByRole("button", { name: /edit fee/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/drawer:edit:Dato' Razak/)).toBeInTheDocument());
  });

  it("admin + no config: shows 'Set up billing' (fee line absent)", () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseFeeConfigs.mockReturnValue({ isLoading: false, isError: false, data: { data: { items: [], limit: 20, offset: 0 } } });
    mockUseOwnerDetail.mockReturnValue({ isLoading: false, isError: false, data: FIXTURE, error: null });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.getByRole("button", { name: /set up billing/i })).toBeInTheDocument();
    expect(screen.queryByText(/management fee/i)).not.toBeInTheDocument();
  });

  it("manager (non-admin): no set-up / edit-fee affordance", async () => {
    const { getStoredUser } = await import("@/lib/auth");
    vi.mocked(getStoredUser).mockReturnValue({ id: "u1", fullName: "M", role: "manager" } as never);
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseFeeConfigs.mockReturnValue({ isLoading: false, isError: false, data: { data: { items: [], limit: 20, offset: 0 } } });
    mockUseOwnerDetail.mockReturnValue({ isLoading: false, isError: false, data: FIXTURE, error: null });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(screen.queryByRole("button", { name: /set up billing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit fee/i })).not.toBeInTheDocument();
  });

  it("renders the Portal Access section", async () => {
    mockUseOwnerDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: FIXTURE,
      error: null,
    });

    render(<OwnerDetailPanel partyId="owner-1" />, { wrapper: makeWrapper() });

    expect(await screen.findByText("portal-access-section")).toBeInTheDocument();
  });
});
