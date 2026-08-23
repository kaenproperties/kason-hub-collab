import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../../lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

/** The shape GET /billing/invoices/:id actually returns for a tenant rental draft. */
const DETAIL = {
  id: "inv-1",
  invoiceNumber: "TR-202608-94c2f5f2",
  partyName: "Demo Tenant",
  tenancyCode: "TEN-2026-0001",
  invoiceType: "tenant_rental",
  periodMonth: "2026-08-01T00:00:00.000Z",
  invoiceDate: "2026-07-30T00:00:00.000Z",
  dueDate: null,
  totalAmount: 2200,
  sstAmount: null,
  status: "draft",
  updatedAt: "2026-07-30T00:00:00.000Z",
  propertyName: "Kaen Residence",
  unitCode: "A-01-01",
  listingType: "WHOLE",
  charges: [
    {
      id: "c1",
      chargeNumber: "RENT-202608-94c2f5f2-c0bf-4fee-b126-31c1370c5071",
      chargeType: "rent",
      status: "draft",
      amount: 2200,
      description: "Monthly rent",
      billingMonth: "2026-08-01T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(DETAIL);
});

async function mount() {
  const { DraftInvoiceDrawer } = await import("../draft-invoice-drawer");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DraftInvoiceDrawer invoiceId="inv-1" onClose={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => screen.getByText("TR-202608-94c2f5f2"));
}

describe("Draft invoice drawer — which unit, which tenant, which period", () => {
  it("names the property and the unit", async () => {
    // An admin approving money must not have to infer the unit from the invoice number.
    await mount();
    expect(screen.getByText("Property")).toBeInTheDocument();
    expect(screen.getByText("Kaen Residence")).toBeInTheDocument();
    expect(screen.getByText("Unit")).toBeInTheDocument();
    expect(screen.getByText(/A-01-01/)).toBeInTheDocument();
  });

  it("leads the charge row with its description, not the internal key", async () => {
    await mount();
    expect(screen.getByText("Monthly rent")).toBeInTheDocument();
    // The key stays visible (support copies it) but is demoted, never the headline.
    expect(screen.getByText(/^RENT-202608-/)).toBeInTheDocument();
  });

  it("states each charge's OWN period, humanised", async () => {
    // "which is this for? july or aug?" — answered per line, not just in the header.
    await mount();
    expect(screen.getAllByText("Aug 2026").length).toBeGreaterThan(0);
    expect(screen.queryByText("2026-08-01T00:00:00.000Z")).toBeNull();
  });

  it("humanises the invoice type", async () => {
    await mount();
    expect(screen.getByText("Rental Payment Request")).toBeInTheDocument();
    expect(screen.queryByText("tenant_rental")).toBeNull();
  });

  it("degrades to no Property/Unit rows for an owner-side draft", async () => {
    apiFetch.mockResolvedValue({
      ...DETAIL,
      propertyName: null,
      unitCode: null,
      listingType: null,
      tenancyCode: null,
    });
    await mount();
    expect(screen.queryByText("Property")).toBeNull();
    expect(screen.queryByText("Unit")).toBeNull();
  });
});
