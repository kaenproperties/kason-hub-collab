// Task 7 — rewires the four property forms (admin create/edit, portal
// create/edit) from free-text propertyType inputs (or, for portal create, a
// hardcoded <select>) to the shared PropertyTypeSelect component, fed by the
// org-scoped catalog hooks (useActivePropertyTypes for admin,
// usePortalPropertyTypes for portal). One describe block per form, each
// proving:
//   (a) the propertyType control is a combobox populated with the mocked
//       catalog option text (proves it's fed by the correct hook)
//   (b) no free-text propertyType textbox remains
//   (c) on the two edit surfaces, an off-catalog current value renders as
//       "{value} (current)" and is selected
//
// Spec: docs/superpowers/specs/2026-07-12-property-type-catalog-design.md (R6)
// Plan: docs/superpowers/plans/2026-07-13-property-type-catalog.md Task 7

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Catalog hooks — distinctive option names (not shared with any legacy /
// hardcoded string anywhere in the four forms) so a passing "option text
// present" assertion can only mean the control is reading from the mock.
// ---------------------------------------------------------------------------
const activePropertyTypesMock = vi.hoisted(() => vi.fn());
const portalPropertyTypesMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-property-types", () => ({
  useActivePropertyTypes: activePropertyTypesMock,
}));
vi.mock("@/hooks/use-portal-property-types", () => ({
  usePortalPropertyTypes: portalPropertyTypesMock,
}));

const ADMIN_CATALOG = [
  { id: "t1", name: "Zzz-Admin-Condo" },
  { id: "t2", name: "Zzz-Admin-Landed" },
];
const PORTAL_CATALOG = [
  { id: "pt1", name: "Zzz-Portal-Condo" },
  { id: "pt2", name: "Zzz-Portal-Landed" },
];

// ---------------------------------------------------------------------------
// Admin forms depend on apiFetch directly (mutation + detail query).
// ---------------------------------------------------------------------------
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));

// ---------------------------------------------------------------------------
// Portal forms depend on @/api/portal-inventory directly.
// ---------------------------------------------------------------------------
const createPortalPropertyMock = vi.hoisted(() => vi.fn());
const getOwnPortalPropertyMock = vi.hoisted(() => vi.fn());
const updateOwnPortalPropertyMock = vi.hoisted(() => vi.fn());
const withdrawOwnPortalPropertyMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/portal-inventory", () => ({
  createPortalProperty: createPortalPropertyMock,
  getOwnPortalProperty: getOwnPortalPropertyMock,
  updateOwnPortalProperty: updateOwnPortalPropertyMock,
  withdrawOwnPortalProperty: withdrawOwnPortalPropertyMock,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreatePropertyDialog } from "@/pages/inventory/create-property-dialog";
import { EditPropertyDialog } from "@/pages/inventory/edit-property-dialog";
import { CreatePropertyDialog as PortalCreatePropertyDialog } from "@/components/portal/create-property-dialog";
import PortalPropertyEditPage from "@/pages/portal/property-edit-page";

function wrapQC(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  activePropertyTypesMock.mockReturnValue({ data: ADMIN_CATALOG });
  portalPropertyTypesMock.mockReturnValue({ data: PORTAL_CATALOG });
});

// =============================================================================
// 1. Admin create dialog — fed by useActivePropertyTypes
// =============================================================================
describe("admin create-property dialog uses PropertyTypeSelect", () => {
  it("renders a combobox populated with the useActivePropertyTypes catalog, no free-text propertyType input", async () => {
    const user = userEvent.setup();
    render(wrapQC(<CreatePropertyDialog trigger={<button>Open create</button>} />));
    await user.click(screen.getByText("Open create"));

    const control = (await screen.findByLabelText("Property type")) as HTMLSelectElement;
    expect(control.tagName).toBe("SELECT");
    expect(screen.getByRole("combobox")).toBe(control);
    expect(within(control).getByText("Zzz-Admin-Condo")).toBeInTheDocument();
    expect(within(control).getByText("Zzz-Admin-Landed")).toBeInTheDocument();

    // (b) the old free-text input (with its "Condominium" placeholder) is gone.
    expect(screen.queryByPlaceholderText("Condominium")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Property type" })).toBeNull();
  });

  it("submits the propertyType selected in the combobox (state), not a stale FormData read", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValue({ data: { id: "prop-new" } });
    render(wrapQC(<CreatePropertyDialog trigger={<button>Open create</button>} />));
    await user.click(screen.getByText("Open create"));

    await user.type(screen.getByLabelText("Property name"), "Test Tower");
    await user.type(screen.getByLabelText("Property Short Form"), "PR-1024");
    await user.selectOptions(screen.getByLabelText("Property type"), "Zzz-Admin-Landed");
    await user.type(screen.getByLabelText("Address line 1"), "Jalan Ampang 18");
    await user.type(screen.getByLabelText("City"), "Kuala Lumpur");

    await user.click(screen.getByRole("button", { name: /create property/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/inventory/properties",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"propertyType":"Zzz-Admin-Landed"'),
        }),
      );
    });
  });
});

// =============================================================================
// 2. Admin edit dialog — fed by useActivePropertyTypes, legacy-preserving
// =============================================================================
describe("admin edit-property dialog uses PropertyTypeSelect", () => {
  const detail = {
    id: "prop-1",
    name: "The Sky Residences",
    propertyCode: "PR-9",
    propertyType: "shophouse", // off-catalog legacy value (plan's own example)
    addressLine1: "Jalan A",
    addressLine2: null,
    city: "Kuala Lumpur",
    state: null,
    postalCode: null,
    country: "Malaysia",
    status: "active",
  };
  const propertyRow = {
    id: "prop-1",
    name: "The Sky Residences",
    propertyCode: "PR-9",
    propertyType: "shophouse",
  };

  function mockDetailAndPut() {
    apiFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === "PUT") return Promise.resolve({ data: { id: "prop-1" } });
      return Promise.resolve({ data: detail });
    });
  }

  it("renders a combobox populated with useActivePropertyTypes, with the off-catalog value as a selected '(current)' option", async () => {
    const user = userEvent.setup();
    mockDetailAndPut();
    render(
      wrapQC(
        <EditPropertyDialog trigger={<button>Open edit</button>} property={propertyRow} />,
      ),
    );
    await user.click(screen.getByText("Open edit"));

    const control = (await screen.findByLabelText("Property type")) as HTMLSelectElement;
    expect(control.tagName).toBe("SELECT");
    expect(control.value).toBe("shophouse");
    expect(within(control).getByText("shophouse (current)")).toBeInTheDocument();
    // Still fed by the mocked active catalog too.
    expect(within(control).getByText("Zzz-Admin-Condo")).toBeInTheDocument();
    expect(within(control).getByText("Zzz-Admin-Landed")).toBeInTheDocument();

    // (b) no free-text propertyType textbox remains.
    expect(screen.queryByRole("textbox", { name: "Property type" })).toBeNull();
  });

  it("submitting unchanged sends propertyType:'shophouse' (read from state, not a stale FormData default)", async () => {
    const user = userEvent.setup();
    mockDetailAndPut();
    render(
      wrapQC(
        <EditPropertyDialog trigger={<button>Open edit</button>} property={propertyRow} />,
      ),
    );
    await user.click(screen.getByText("Open edit"));
    await screen.findByLabelText("Property type");

    await user.click(screen.getByRole("button", { name: /update property/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/inventory/properties/prop-1",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"propertyType":"shophouse"'),
        }),
      );
    });
  });
});

// =============================================================================
// 3. Portal create dialog — fed by usePortalPropertyTypes (hardcoded array removed)
// =============================================================================
describe("portal create-property dialog uses PropertyTypeSelect", () => {
  it("renders a combobox populated with usePortalPropertyTypes; the old hardcoded options are gone", () => {
    render(
      wrapQC(
        <PortalCreatePropertyDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />,
      ),
    );

    const control = screen.getByLabelText(/property type/i) as HTMLSelectElement;
    expect(control.tagName).toBe("SELECT");
    expect(screen.getByRole("combobox")).toBe(control);
    expect(within(control).getByText("Zzz-Portal-Condo")).toBeInTheDocument();
    expect(within(control).getByText("Zzz-Portal-Landed")).toBeInTheDocument();

    // (b) the deleted PROPERTY_TYPE_OPTIONS hardcoded labels are gone.
    expect(screen.queryByText("Service Residence")).toBeNull();
    expect(screen.queryByText("Shoplot")).toBeNull();
    expect(screen.queryByText("Condominium")).toBeNull();

    // emptyForm.propertyType changed from "condo" to "" — nothing pre-selected.
    expect(control.value).toBe("");
  });

  it("submits the propertyType selected from the mocked catalog on create", async () => {
    const user = userEvent.setup();
    createPortalPropertyMock.mockResolvedValue({ id: "prop-portal-1" });
    const onCreated = vi.fn();
    render(
      wrapQC(
        <PortalCreatePropertyDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />,
      ),
    );

    await user.type(screen.getByLabelText(/property name/i), "New Tower");
    await user.type(screen.getByLabelText(/property short form/i), "PT-1");
    await user.selectOptions(screen.getByLabelText(/property type/i), "Zzz-Portal-Landed");
    await user.type(screen.getByLabelText(/address line 1/i), "Jalan Y");
    await user.type(screen.getByLabelText(/^city/i), "Kuala Lumpur");

    await user.click(screen.getByRole("button", { name: /submit for approval/i }));

    await waitFor(() => {
      expect(createPortalPropertyMock).toHaveBeenCalledWith(
        expect.objectContaining({ propertyType: "Zzz-Portal-Landed" }),
      );
    });
  });
});

// =============================================================================
// 4. Portal edit page — fed by usePortalPropertyTypes, legacy-preserving
// =============================================================================
describe("portal edit-property page uses PropertyTypeSelect", () => {
  const detail = {
    id: "sub-1",
    propertyCode: "TC-001",
    proposedName: "The Capers, Sentul",
    propertyType: "Bungalow", // off-catalog legacy value
    addressLine1: "1 Jalan Sentul",
    addressLine2: null,
    city: "Kuala Lumpur",
    state: null,
    postalCode: null,
    country: "Malaysia",
    submissionState: "pending" as const,
    amendmentNote: null,
    approvedPropertyId: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
  };

  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/portal/properties/sub-1/edit"]}>
          <Routes>
            <Route
              path="/portal/properties/:submissionId/edit"
              element={<PortalPropertyEditPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("renders a combobox populated with usePortalPropertyTypes, with the off-catalog value as a selected '(current)' option", async () => {
    getOwnPortalPropertyMock.mockResolvedValue(detail);

    renderPage();

    const control = (await screen.findByLabelText("Property type")) as HTMLSelectElement;
    expect(control.tagName).toBe("SELECT");
    expect(control.value).toBe("Bungalow");
    expect(within(control).getByText("Bungalow (current)")).toBeInTheDocument();
    expect(within(control).getByText("Zzz-Portal-Condo")).toBeInTheDocument();
    expect(within(control).getByText("Zzz-Portal-Landed")).toBeInTheDocument();

    // (b) no free-text propertyType textbox remains.
    expect(screen.queryByRole("textbox", { name: "Property type" })).toBeNull();
  });

  it("disables the control when the submission is not editable (approved)", async () => {
    getOwnPortalPropertyMock.mockResolvedValue({ ...detail, submissionState: "approved" });

    renderPage();

    const control = (await screen.findByLabelText("Property type")) as HTMLSelectElement;
    expect(control).toBeDisabled();
  });
});
