/**
 * First-month KAEN commission on the "Assign to Unit" dialog.
 *
 * The commission section is gated on ENABLE_PHASE2_RESERVATION_GATED_TENANCY, so
 * @/lib/feature-flags is mocked ON here (mirrors
 * occupancy-fields.commission.test.tsx) — the base assign-dialog test file leaves
 * the flag OFF, which is why the toggle is invisible there. These tests pin the
 * backend↔frontend contract: the fields the endpoint already accepts
 * (firstMonthIsCommission / commissionSstBearer) are actually SENT when opted in,
 * and never sent otherwise.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi, beforeEach } from "vitest";
import { apiFetch } from "@/lib/api-client";
import { getApartmentsByProperty } from "@/api/inventory-units-batch";
import { AssignTenantToUnitDialog } from "../assign-tenant-to-unit-dialog";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("@/api/inventory-units-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/inventory-units-batch")>();
  return { ...actual, getApartmentsByProperty: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const tenant = { id: "tenant-1", displayName: "Daniel Tan" } as const;

const PROPERTY_LIST_OK = {
  data: [
    { id: "prop-1", name: "Sunway", propertyCode: "SW", propertyType: "condo", status: "active", unitCount: 1, occupiedUnits: 0 },
  ],
};

// Fixed preview payload — the arithmetic is covered by rent-preview's own tests;
// here we only assert the wiring (query fires, card renders, payload carries the
// flags), so a canned commission response is sufficient.
const PREVIEW_OK = {
  data: { month: "2026-07", amount: 1500, occupiedDays: 31, daysInMonth: 31, isProrated: false },
  commission: { month: "2026-07", commissionAmount: 1500, sstRate: 0.08, sstAmount: 120, sstBearer: "kaen", total: 1620 },
};

const apt = (over: Partial<import("@/api/inventory-units-batch").ApartmentSummary> = {}) => ({
  id: "apt-1",
  unitCode: "A-1",
  floor: null,
  bedrooms: null,
  bathrooms: null,
  floorArea: null,
  amenities: [],
  highlights: [],
  description: null,
  rooms: [],
  hasDrift: false,
  listingMode: null,
  ownerPartyId: "owner-1",
  ownerName: "Owner",
  ownerPhone: null,
  underManagement: true,
  ...over,
});

const room = (over: Partial<import("@/api/inventory-units-batch").ApartmentRoomSummary> = {}) => ({
  id: "unit-1",
  unitType: "Studio",
  rentalRate: 1000,
  occupancyStatus: "vacant",
  listingStatus: "active",
  inChargePartyId: null,
  ...over,
});

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}
const wrap = (ui: React.ReactNode, client = makeClient()) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(getApartmentsByProperty).mockReset();
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    if (String(url).includes("rent-preview")) return Promise.resolve(PREVIEW_OK);
    if (String(url) === "/inventory/properties") return Promise.resolve(PROPERTY_LIST_OK);
    return Promise.resolve({}); // POST /tenancy/tenancies
  });
  vi.mocked(getApartmentsByProperty).mockResolvedValue([apt({ rooms: [room({ id: "unit-ok" })] })]);
});

async function openPickAndFill(user: ReturnType<typeof userEvent.setup>) {
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);
  await screen.findByRole("option", { name: /Sunway/i });
  await user.selectOptions(screen.getByLabelText(/property/i), "prop-1");
  await user.selectOptions(await screen.findByLabelText(/^unit$/i), "unit-ok");
  fireEvent.change(screen.getByLabelText(/monthly rent/i), { target: { value: "1500" } });
  fireEvent.change(screen.getByLabelText(/^start date$/i), { target: { value: "2026-07-01" } });
}

function postBody() {
  const call = vi.mocked(apiFetch).mock.calls.find(
      ([u, o]) =>
        u === "/tenancy/tenancies" && (o as RequestInit | undefined)?.method === "POST",
    );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string);
}

test("renders the commission toggle when the flag is on", async () => {
  wrap(<AssignTenantToUnitDialog tenant={tenant} open onOpenChange={() => {}} />);
  expect(await screen.findByLabelText(/first month rent is kaen/i)).toBeInTheDocument();
});

test("checked: renders the commission preview and sends the commission fields", async () => {
  const user = userEvent.setup();
  await openPickAndFill(user);
  await user.click(screen.getByLabelText(/first month rent is kaen/i));
  await user.selectOptions(screen.getByLabelText(/sst bearer/i), "kaen");

  // Preview card renders from the (mocked) rent-preview response.
  expect(await screen.findByText(/KAEN commission/i)).toBeInTheDocument();
  expect(screen.getByText(/Commission total/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => {
    const body = postBody();
    expect(body.firstMonthIsCommission).toBe(true);
    expect(body.commissionSstBearer).toBe("kaen");
  });
});

test("unchecked (regression): payload carries neither commission field", async () => {
  const user = userEvent.setup();
  await openPickAndFill(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => {
    const body = postBody();
    expect(body).not.toHaveProperty("firstMonthIsCommission");
    expect(body).not.toHaveProperty("commissionSstBearer");
  });
});

test("sends an explicit TA fee decision, including RM0, in the assignment payload", async () => {
  const user = userEvent.setup();
  await openPickAndFill(user);
  fireEvent.change(screen.getByLabelText(/TA \(WITH SST\) amount/i), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText(/agreement fee due date/i), {
    target: { value: "2026-07-01" },
  });

  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => {
    const body = postBody();
    expect(body.tenancyAgreementFeeAmount).toBe("0");
    expect(body.tenancyAgreementFeeDueDate).toBe("2026-07-01");
  });
});

test("does not invent a TA fee when the assignment leaves it blank", async () => {
  const user = userEvent.setup();
  await openPickAndFill(user);
  await user.click(screen.getByRole("button", { name: /assign/i }));
  await waitFor(() => {
    const body = postBody();
    expect(body).not.toHaveProperty("tenancyAgreementFeeAmount");
    expect(body).not.toHaveProperty("tenancyAgreementFeeDueDate");
  });
});
