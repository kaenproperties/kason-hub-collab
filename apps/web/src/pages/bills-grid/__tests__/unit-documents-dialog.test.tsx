import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridRow } from "@/api/bills-grid";

const useBillingDocumentsMock = vi.fn((_filters?: unknown) => ({
  data: { data: { items: [], total: 0 } },
  isLoading: false,
  isFetching: false,
  isError: false,
}));

vi.mock("@/api/billing-documents", () => ({
  useBillingDocuments: (filters: unknown) => useBillingDocumentsMock(filters),
  fetchBillingDocumentPdfUrl: vi.fn(),
}));

vi.mock("@/pages/accounting/document-detail-drawer", () => ({
  DocumentDetailDrawer: () => null,
}));

const row = {
  apartmentId: "apt-1",
  propertyName: "Kensho Residence",
  unitCode: "A-02-02",
} as GridRow;

describe("UnitDocumentsDialog document-period filter", () => {
  beforeEach(() => {
    useBillingDocumentsMock.mockClear();
  });

  it("defaults to the grid billing month and can switch between All and another month", async () => {
    const { UnitDocumentsDialog } = await import("../unit-documents-dialog");
    render(<UnitDocumentsDialog row={row} billingMonth="2026-08" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(useBillingDocumentsMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        apartmentId: "apt-1",
        month: "2026-08",
        page: 1,
      }));
    });
    expect(screen.getByText(/August 2026 tenant-facing documents/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(useBillingDocumentsMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("month");
    });
    expect(screen.getByText(/all tenant-facing documents/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter documents by month"), { target: { value: "2026-07" } });
    await waitFor(() => {
      expect(useBillingDocumentsMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        month: "2026-07",
        page: 1,
      }));
    });
    expect(screen.getByText(/July 2026 tenant-facing documents/i)).toBeInTheDocument();
  });
});
