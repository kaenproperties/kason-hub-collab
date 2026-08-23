/**
 * Fix 1 (go-live blocker, final-review): T10 made syncOccupancyTenancy
 * require an explicit `monthlyRent > 0` when marking a unit occupied under
 * ENABLE_PHASE2_RESERVATION_GATED_TENANCY, but the web occupancy dialog
 * never collected or sent it -- so flag-on "mark unit occupied" 400s
 * (OCCUPANCY_RENT_REQUIRED) every time. This file pins the <OccupancyFields>
 * rendering half of the fix with the flag mocked ON; the existing
 * occupancy-fields.test.tsx (unmocked, flag effectively off in the test env)
 * covers flag-off parity.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn().mockResolvedValue({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OccupancyFields } from "../occupancy-fields";
import { apiFetch } from "@/lib/api-client";
import { AuthContext } from "@/lib/auth";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <AuthContext.Provider value={{
      user: {
        id: "operator-1",
        fullName: "Test Operator",
        email: "operator@example.test",
        role: "admin",
        orgId: "org-1",
        permissions: ["party.create"],
      },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    }}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </AuthContext.Provider>
  );
}

const base = {
  occupancyStatus: "occupied" as const,
  tenantPartyId: null, tenantName: "", tenantIdType: null,
  tenantIdNumberMasked: null, tenantPhone: null,
  moveInDate: "", moveOutDate: "", monthlyRent: "",
  onSelectTenant: vi.fn(), onClearTenant: vi.fn(), onChange: vi.fn(), errors: {},
};

describe("<OccupancyFields> — monthly rent (flag ON)", () => {
  it("renders a monthly-rent input alongside move-in/move-out", () => {
    render(wrap(<OccupancyFields {...base} monthlyRent="4500" />));
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(4500);
  });

  it("calls onChange with the new monthlyRent value on edit", () => {
    const onChange = vi.fn();
    render(wrap(<OccupancyFields {...base} monthlyRent="4500" onChange={onChange} />));
    fireEvent.change(screen.getByLabelText(/tenancy monthly rent/i), { target: { value: "5000" } });
    expect(onChange).toHaveBeenCalledWith({ monthlyRent: "5000" });
  });

  it("shows the monthlyRent error text", () => {
    render(
      wrap(
        <OccupancyFields
          {...base}
          errors={{ monthlyRent: "Enter the monthly rent before marking this unit occupied." }}
        />,
      ),
    );
    expect(
      screen.getByText("Enter the monthly rent before marking this unit occupied."),
    ).toBeInTheDocument();
  });

  // Companion to occupancy-fields.test.tsx's flag-off guard: with the flag ON and
  // the data present, the preview query DOES fire and the card renders -- proving
  // the flag gate does not over-suppress the feature it protects.
  it("fires the first-month rent-preview query and renders the card when the flag is on", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? { data: { month: "2026-07", amount: 1645.16, occupiedDays: 17, daysInMonth: 31, isProrated: true } }
          : { data: [] },
      ) as never,
    );
    render(wrap(<OccupancyFields {...base} moveInDate="2026-07-15" monthlyRent="3000" />));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining("rent-preview")),
    );
    expect(await screen.findByText(/first rent to collect for owner/i)).toBeTruthy();
  });

  // B13 — the fix now prefills the tenancy's REAL rent (edit-unit-dialog
  // detailToFormState), so on a same-tenant edit the preview computes on what the
  // poster actually bills and MUST render: it is the operator's first-month /
  // KAEN-commission calculation for the existing tenancy. (Previously suppressed
  // while the form showed the divergent asking rate — that divergence is now
  // fixed at the source, so the guard is retired.)
  it("fires the preview and renders the card when editing the SAME existing tenant", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? { data: { month: "2026-07", amount: 1645.16, occupiedDays: 17, daysInMonth: 31, isProrated: true } }
          : { data: [] },
      ) as never,
    );
    vi.mocked(apiFetch).mockClear();
    render(
      wrap(
        <OccupancyFields
          {...base}
          tenantPartyId="tenant-1"
          tenantName="Alice"
          initialTenantPartyId="tenant-1"
          moveInDate="2026-07-15"
          moveOutDate="2027-07-14"
          monthlyRent="3000"
        />,
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining("rent-preview")),
    );
    expect(await screen.findByText(/first rent to collect for owner/i)).toBeTruthy();
  });

  // B9 — the rent field is server-inert on a same-tenant in-place edit
  // (occupancy-tenancy-sync case-2 never writes monthlyRentAmount), so it is
  // read-only: it shows the real rent without implying an edit here takes effect.
  // Rent for an existing tenancy is corrected via the tenancy editor, not here.
  it("renders the rent field read-only when editing the SAME existing tenant", () => {
    render(
      wrap(
        <OccupancyFields
          {...base}
          tenantPartyId="tenant-1"
          tenantName="Alice"
          initialTenantPartyId="tenant-1"
          moveInDate="2026-07-15"
          moveOutDate="2027-07-14"
          monthlyRent="1500"
        />,
      ),
    );
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveAttribute("readonly");
  });

  // No over-restriction: swapping in a DIFFERENT tenant creates a NEW tenancy
  // from the form's rent, so the field stays EDITABLE and the preview renders.
  it("keeps the rent field editable and renders the preview for a DIFFERENT tenant", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? { data: { month: "2026-07", amount: 1645.16, occupiedDays: 17, daysInMonth: 31, isProrated: true } }
          : { data: [] },
      ) as never,
    );
    render(
      wrap(
        <OccupancyFields
          {...base}
          tenantPartyId="tenant-2"
          tenantName="Bob"
          initialTenantPartyId="tenant-1"
          moveInDate="2026-07-15"
          monthlyRent="3000"
        />,
      ),
    );
    expect(screen.getByLabelText(/tenancy monthly rent/i)).not.toHaveAttribute("readonly");
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining("rent-preview")),
    );
    expect(await screen.findByText(/first rent to collect for owner/i)).toBeTruthy();
  });
});
