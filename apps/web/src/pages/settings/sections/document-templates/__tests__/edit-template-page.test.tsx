import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EditTemplatePage from "../edit-template-page";
import * as api from "@/api/document-templates";

vi.mock("@/api/document-templates", async () => {
  const actual = await vi.importActual<typeof import("@/api/document-templates")>(
    "@/api/document-templates",
  );
  return {
    ...actual,
    listTemplates: vi.fn(),
    updateTemplate: vi.fn(),
  };
});

// The template editor now also reads/writes Organization.name so admins
// can fix the printed company name without leaving this page. Stub the
// API so the React Query inside the editor doesn't fire real fetches.
vi.mock("@/api/organization", () => ({
  getOrganizationProfile: vi.fn(async () => ({ id: "o1", name: "Test Organisation" })),
  updateOrganizationProfile: vi.fn(async (input: { name: string }) => ({
    id: "o1",
    name: input.name,
  })),
}));

const BASE: api.DocumentTemplate = {
  id: "tpl-1",
  docType: "reservation_form",
  title: "Unit Reservation Form",
  refPrefix: "",
  refSeparator: "-",
  refPadding: 5,
  refIncludeYear: false,
  headerFields: {
    showLogo: true,
    showRegNo: true,
    showSalesTaxId: false,
    showServiceTaxId: true,
    showAddress: true,
    showEmail: true,
    showContact: true,
  },
  orgName: "Test Organisation",
  orgRegNo: null,
  orgSalesTaxId: null,
  orgServiceTaxId: null,
  orgAddressLines: [],
  orgEmail: null,
  orgContact: null,
  logoKey: null,
  logoUrl: null,
};

function renderPage(template: api.DocumentTemplate = BASE) {
  vi.mocked(api.listTemplates).mockResolvedValue([template]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/admin/document-templates/${template.docType}`]}>
        <Routes>
          <Route path="/admin/document-templates/:docType" element={<EditTemplatePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EditTemplatePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a live preview of the reference code", async () => {
    renderPage();
    const prefixInput = await screen.findByLabelText(/^Prefix$/);
    await userEvent.clear(prefixInput);
    await userEvent.type(prefixInput, "KAEN RES");
    // Code appears in both the form's preview chip and the letterhead preview.
    const matches = await screen.findAllByText(/KAEN RES-00001/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("shows year segment when 'include year' is checked", async () => {
    renderPage();
    const prefixInput = await screen.findByLabelText(/^Prefix$/);
    await userEvent.type(prefixInput, "RES");
    await userEvent.click(screen.getByRole("checkbox", { name: /include year/i }));
    const matches = await screen.findAllByText(/RES-\d{4}-00001/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("calls updateTemplate on save", async () => {
    vi.mocked(api.updateTemplate).mockResolvedValue({ ...BASE, refPrefix: "RES" });
    renderPage();
    const prefixInput = await screen.findByLabelText(/^Prefix$/);
    await userEvent.type(prefixInput, "RES");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.updateTemplate).toHaveBeenCalledWith(
        "reservation_form",
        expect.objectContaining({ refPrefix: "RES" }),
      ),
    );
  });

  it("renders existing address lines and accepts a new 3rd line", async () => {
    const template = { ...BASE, orgAddressLines: ["Line 1", "Line 2"] };
    vi.mocked(api.updateTemplate).mockResolvedValue({ ...template });
    renderPage(template);

    expect(await screen.findByLabelText(/address line 1/i)).toHaveValue("Line 1");
    expect(screen.getByLabelText(/address line 2/i)).toHaveValue("Line 2");
    expect(screen.getByLabelText(/address line 3/i)).toHaveValue("");

    await userEvent.type(screen.getByLabelText(/address line 3/i), "Line 3");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateTemplate).toHaveBeenCalledWith(
        "reservation_form",
        expect.objectContaining({ orgAddressLines: ["Line 1", "Line 2", "Line 3"] }),
      ),
    );
  });

  it("strips trailing empty address lines on save", async () => {
    const template = { ...BASE, orgAddressLines: ["Line 1"] };
    vi.mocked(api.updateTemplate).mockResolvedValue({ ...template });
    renderPage(template);

    await screen.findByLabelText(/address line 1/i);
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateTemplate).toHaveBeenCalledWith(
        "reservation_form",
        expect.objectContaining({ orgAddressLines: ["Line 1"] }),
      ),
    );
  });

  it("renders the fixed legal Company name used on the printed letterhead", async () => {
    renderPage();
    const companyInput = await screen.findByLabelText(/^Company name$/);
    expect(companyInput).toBeInTheDocument();
    expect(companyInput).toHaveValue("KAEN PROPERTIES MANAGEMENT SDN BHD");
    expect(companyInput).toHaveAttribute("readonly");
  });

  it("disables an org field input when its visibility toggle is off", async () => {
    const template: api.DocumentTemplate = {
      ...BASE,
      headerFields: { ...BASE.headerFields, showSalesTaxId: false, showRegNo: true },
    };
    renderPage(template);
    const salesInput = await screen.findByLabelText(/^Sales Tax ID$/);
    const regInput = screen.getByLabelText(/^Reg No$/);
    expect(salesInput).toBeDisabled();
    expect(regInput).not.toBeDisabled();
  });

  it("shows the fixed-title Callout mentioning Owner Payout Report for owner_statement", async () => {
    const template: api.DocumentTemplate = {
      ...BASE,
      docType: "owner_statement",
      title: "Owner Statement",
    };
    renderPage(template);
    await screen.findByText(/Title is fixed/i);
    expect(screen.getAllByText(/Owner Payout Report/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Expense Receipt")).not.toBeInTheDocument();
  });
});
