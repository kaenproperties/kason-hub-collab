import { describe, it, expect } from "vitest";
import { renderToHtml } from "../render";
import { DEFAULT_HEADER_FIELDS, type ResolvedTemplate } from "../types";

const TEMPLATE: ResolvedTemplate = {
  id: "tpl-1",
  organizationId: "org-1",
  docType: "reservation_form",
  title: "Unit Reservation Form",
  refPrefix: "KAEN RES",
  refSeparator: "-",
  refPadding: 5,
  refIncludeYear: false,
  headerFields: { ...DEFAULT_HEADER_FIELDS, showSalesTaxId: false, showRegNo: true },
  orgName: "KAEN Properties",
  orgRegNo: "1610050-V",
  orgSalesTaxId: null,
  orgServiceTaxId: "W10-2506-32000179",
  orgAddressLines: ["NO. 27-3, Jalan Perdana 10/12", "Pandan Perdana, 55300 Kuala Lumpur"],
  orgEmail: "kaenproperties@gmail.com",
  orgContact: "+601136111763",
  logoUrl: "https://s3/logo.png",
};

describe("renderToHtml", () => {
  it("renders all three header zones", () => {
    const html = renderToHtml({
      template: TEMPLATE,
      referenceCode: "KAEN RES-00001",
      issuedDate: new Date("2026-05-13T00:00:00Z"),
      bodyHtml: "<p>Body</p>",
    });

    expect(html).toContain("KAEN Properties");
    expect(html).toContain("Unit Reservation Form");
    expect(html).toContain("KAEN RES-00001");
    expect(html).toContain("Reg No: 1610050-V");
    expect(html).toContain("<p>Body</p>");
  });

  it("omits hidden header fields", () => {
    const html = renderToHtml({
      template: TEMPLATE,
      referenceCode: "KAEN RES-00002",
      issuedDate: new Date("2026-05-13T00:00:00Z"),
      bodyHtml: "",
    });

    expect(html).not.toContain("Sales Tax ID");
    expect(html).toContain("Service Tax ID");
  });

  it("includes signature block when provided", () => {
    const html = renderToHtml({
      template: TEMPLATE,
      referenceCode: "KAEN RES-00003",
      issuedDate: new Date("2026-05-13T00:00:00Z"),
      bodyHtml: "",
      signature: {
        pngDataUrl: "data:image/png;base64,iVBORw0KGgoAAA",
        typedName: "John Doe",
        signedAt: new Date("2026-05-14T00:00:00Z"),
        ip: "1.2.3.4",
      },
    });

    expect(html).toContain("Signed by: John Doe");
    expect(html).toContain("data:image/png;base64,iVBORw0KGgoAAA");
    expect(html).toContain("IP 1.2.3.4");
  });

  it("renders the owner payout report with the full legal name and company details", () => {
    const html = renderToHtml({
      template: {
        ...TEMPLATE,
        docType: "owner_statement",
        title: "Owner Payout Report",
        orgName: "KAEN PROPERTIES MANAGEMENT SDN BHD",
        orgAddressLines: [
          "No. 27-3, Jalan Perdana 10/12",
          "Pandan Perdana, 55300 Kuala Lumpur",
          "Malaysia",
        ],
        orgContact: "011-3611 1763",
        logoUrl: null,
      },
      referenceCode: "OWNER-202608-A0303",
      issuedDate: new Date("2026-08-23T00:00:00Z"),
      bodyHtml: "<section><h3>Owner &amp; Payout Details</h3></section>",
    });

    expect(html).toContain("<body class='doc-owner-statement'>");
    expect(html).toContain("<h1>KAEN PROPERTIES MANAGEMENT SDN BHD</h1>");
    expect(html).toContain("No. 27-3, Jalan Perdana 10/12");
    expect(html).toContain("Pandan Perdana, 55300 Kuala Lumpur");
    expect(html).toContain("Email: kaenproperties@gmail.com");
    expect(html).toContain("Contact: 011-3611 1763");
    expect(html).toContain("Owner Payout Report");
  });

  // Visual regression: keeps the rendered HTML byte-stable so any future
  // unintended layout/style change shows up as a snapshot diff in PR review.
  // Update via `npx vitest -u` ONLY after eyeballing the new PDF.
  it("matches the locked-in layout snapshot", () => {
    const html = renderToHtml({
      template: { ...TEMPLATE, logoUrl: null },
      referenceCode: "KAEN RES-99999",
      issuedDate: new Date("2026-05-13T00:00:00Z"),
      dueDate: new Date("2026-05-20T00:00:00Z"),
      bodyHtml: "<section><h3>Body</h3><p>Hello</p></section>",
      signature: {
        pngDataUrl: "data:image/png;base64,SIGSTUB",
        typedName: "Snapshot Signer",
        signedAt: new Date("2026-05-14T00:00:00Z"),
        ip: "9.9.9.9",
      },
    });
    expect(html).toMatchSnapshot();
  });
});
