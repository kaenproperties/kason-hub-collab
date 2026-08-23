import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DocumentTemplatesPage from "../document-templates-section";
import * as api from "@/api/document-templates";

vi.mock("@/api/document-templates", async () => {
  const actual = await vi.importActual<typeof import("@/api/document-templates")>(
    "@/api/document-templates",
  );
  return { ...actual, listTemplates: vi.fn() };
});

function makeTemplate(docType: string): api.DocumentTemplate {
  return {
    id: `tpl-${docType}`,
    docType: docType as api.DocType,
    title: docType,
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
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DocumentTemplatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DocumentTemplatesPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders owner_statement alongside reservation_form (both known types)", async () => {
    // `owner_statement` was added to KNOWN_DOC_TYPES as part of Task 6 so that
    // the /settings/document-templates page surfaces the owner-billing letterhead
    // editor. Both types should now render without crashing.
    vi.mocked(api.listTemplates).mockResolvedValue([
      makeTemplate("reservation_form"),
      makeTemplate("owner_statement"),
    ]);

    renderPage();

    // Both known types render...
    expect(await screen.findByText("Unit Reservation Form")).toBeInTheDocument();
    expect(screen.getByText("Owner Payout Report")).toBeInTheDocument();
    // ...exactly two cards.
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders a card for every known doc type", async () => {
    vi.mocked(api.listTemplates).mockResolvedValue(
      api.KNOWN_DOC_TYPES.map((t) => makeTemplate(t)),
    );

    renderPage();

    expect(await screen.findByText("Unit Reservation Form")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(api.KNOWN_DOC_TYPES.length);
  });
});
