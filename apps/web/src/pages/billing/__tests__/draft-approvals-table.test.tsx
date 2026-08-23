import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DraftApprovalsTable, invoiceTypeMeta, type DraftInvoiceListItem } from "../draft-approvals-table";

const rows: DraftInvoiceListItem[] = [
  { id: "1", invoiceNumber: "TR-202607-1a93", partyName: "Nurul Izzah", invoiceType: "tenant_rental", periodMonth: "2026-07-01", totalAmount: 1200, status: "draft", updatedAt: "2026-07-19T00:00:00Z" },
  { id: "2", invoiceNumber: "OS-202607-5eb9", partyName: "Dato' Razak", invoiceType: "owner_statement", periodMonth: "2026-07-01", totalAmount: 0, status: "draft", updatedAt: "2026-07-19T00:00:00Z" },
];

describe("invoiceTypeMeta", () => {
  it("maps enum values to human labels stating invoice vs statement (no underscores)", () => {
    expect(invoiceTypeMeta("tenant_rental").label).toBe("Rental Payment Request");
    expect(invoiceTypeMeta("owner_statement").label).toBe("Owner Statement");
    expect(invoiceTypeMeta("tenant_aircon").label).toBe("Aircon Invoice");
  });

  it("prettifies an unknown type instead of leaking the raw underscore enum", () => {
    const m = invoiceTypeMeta("some_future_type");
    expect(m.label).toBe("Some Future Type");
    expect(m.label).not.toContain("_");
  });
});

describe("DraftApprovalsTable", () => {
  it("states each row's document kind as a readable badge and shows its code", () => {
    render(
      <DraftApprovalsTable invoices={rows} selectedIds={[]} onSelectionChange={() => {}} onRowClick={() => {}} />,
    );
    // Readable kind labels (answers "is it an invoice or a statement?").
    expect(screen.getByText("Rental Payment Request")).toBeInTheDocument();
    expect(screen.getByText("Owner Statement")).toBeInTheDocument();
    // The document code is still shown.
    expect(screen.getByText("TR-202607-1a93")).toBeInTheDocument();
    expect(screen.getByText("OS-202607-5eb9")).toBeInTheDocument();
    // The raw underscore enum never reaches the DOM.
    expect(screen.queryByText("tenant_rental")).toBeNull();
    expect(screen.queryByText("owner_statement")).toBeNull();
  });
});

describe("row identity — which unit, which tenant", () => {
  it("shows the unit under the party so same-name rows are distinguishable", () => {
    // "Demo Tenant" twice was unresolvable: one party can hold several units, and two
    // tenancies can share a display name.
    render(
      <DraftApprovalsTable
        invoices={[
          { ...rows[0], id: "a", invoiceNumber: "TR-202608-1", unitCode: "A-01-01", propertyName: "Kaen Residence" },
          { ...rows[0], id: "b", invoiceNumber: "TR-202608-2", unitCode: "B-02-07", propertyName: "Kaen Residence" },
        ]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        onRowClick={() => {}}
      />,
    );
    expect(screen.getByText(/A-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/B-02-07/)).toBeInTheDocument();
  });

  it("humanises the period column", () => {
    render(
      <DraftApprovalsTable
        invoices={[{ ...rows[0], periodMonth: "2026-08-01T00:00:00.000Z" }]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        onRowClick={() => {}}
      />,
    );
    expect(screen.getByText("Aug 2026")).toBeInTheDocument();
  });

  it("omits the unit line when there is none (owner-side row)", () => {
    render(
      <DraftApprovalsTable
        invoices={[{ ...rows[0], unitCode: null, propertyName: null }]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        onRowClick={() => {}}
      />,
    );
    expect(screen.queryByText(/A-01-01/)).toBeNull();
  });
});
