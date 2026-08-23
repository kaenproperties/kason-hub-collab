// apps/api/src/lib/document-templates/render.ts

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenderPayload } from "./types";

function fmt(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function fmtLong(d: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Layout values target an A4 page rendered by Chromium puppeteer.
// Conventions (MY/UK reservation form research, 2026-05-15):
//   - 8mm section spacing on A4
//   - all-caps section headings with a thin rule (formal contract look)
//   - fee rows as a 2-col table with right-aligned amount + bold total row
//   - applicant-only signature block at the bottom-left (client feedback
//     2026-05-15 dropped the management counter-sign column)
//   - audit footer carrying the digital-sig evidence (DSA 1997)
const CSS = `
  /* Chromium honors @page for the print box. Setting margins here means
     pagination flows naturally; the .page div no longer fights with
     puppeteer's margin defaults. Bottom margin is wider than the others to
     reserve room for the page-number footer rendered by puppeteer's
     headerTemplate/footerTemplate. */
  @page{size:A4;margin:18mm 18mm 22mm 18mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#1f2937;line-height:1.45}
  .page{padding:0}

  /* Header */
  .doc-header{display:grid;grid-template-columns:1fr 2fr 1fr;gap:8mm;align-items:start;margin-bottom:8mm;padding-bottom:5mm;border-bottom:1px solid #d1d5db}
  /* Keep max-height in sync with LOGO_MAX_HEIGHT_MM in
     apps/web/src/lib/pdf-layout-constants.ts (the render snapshot test
     will fail if this literal changes without updating the constant). */
  .zone-left img{max-width:100%;max-height:40mm}
  .zone-center{text-align:center}
  .zone-center h1{font-size:14pt;font-weight:700;margin-bottom:2mm;letter-spacing:0.3pt}
  .zone-center p{font-size:8.5pt;color:#4b5563;line-height:1.4}
  .zone-right{text-align:right}
  .zone-right h2{font-size:11pt;font-weight:700;text-transform:uppercase;letter-spacing:0.5pt;margin-bottom:3mm}
  .zone-right p{font-size:9pt;line-height:1.55;color:#374151}
  .zone-right .ref-label{margin-top:1mm;color:#6b7280;font-size:8.5pt;letter-spacing:0.3pt;text-transform:uppercase}
  .zone-right .ref-value{margin-top:0;margin-bottom:1.5mm;font-size:10pt;font-variant-numeric:tabular-nums}

  /* Body */
  main{margin-top:4mm}
  main section{margin-top:8mm}
  main section:first-child{margin-top:0}
  main h3{
    font-size:9.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.8pt;
    color:#111827;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:1px solid #9ca3af
  }
  main p{font-size:10.5pt;margin:1mm 0;color:#1f2937}
  main p strong{display:inline-block;min-width:44mm;font-weight:600;color:#374151}

  /* Agreement cover sheets are intentionally isolated from the clauses.
     This mirrors the supplied KAEN agreement and prevents clause 1 from
     being squeezed onto the bottom of the title page. */
  .agreement-cover{
    min-height:235mm;display:flex;flex-direction:column;align-items:center;
    justify-content:center;text-align:center;page-break-after:always
  }
  .agreement-cover h1{margin-top:24mm;font-size:20pt;letter-spacing:.5pt}
  .agreement-cover h3{margin-top:10mm;border:0;font-size:11pt}
  .agreement-cover p{font-size:11pt;line-height:1.6}

  /* Fee tables */
  main .fee-table{width:100%;border-collapse:collapse;margin-top:1mm}
  main .fee-table td{padding:1.2mm 0;font-size:10.5pt;border-bottom:1px dotted #e5e7eb}
  main .fee-table td:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  main .fee-table tr:last-child td{border-bottom:none}
  main .fee-total{margin-top:3mm;display:flex;justify-content:space-between;align-items:baseline;
    padding:2mm 0;border-top:2px solid #111827;border-bottom:2px solid #111827;
    font-weight:700;text-transform:uppercase;letter-spacing:0.6pt;font-size:10.5pt}
  main .fee-total .amount{font-variant-numeric:tabular-nums}

  /* Terms list — the OL itself MUST be allowed to break across pages.
     Putting page-break-inside:avoid on the whole list caused Chromium to
     chop the last clause mid-word when the content was taller than A4
     (2026-05-22 client report on the cut-off "stated a..." rendering).
     Per-list-item break-inside:avoid keeps each numbered clause whole
     across the page boundary, which is what we actually want. */
  main ol{padding-left:6mm;margin-top:1mm}
  main ol li{font-size:10pt;margin:1.5mm 0;line-height:1.5;padding-left:1mm;break-inside:avoid;page-break-inside:avoid}

  /* Terms & Conditions starts on its own page — keeps the totals/summary
     and the signature block out of competition for the same page (client
     report 2026-05-22, screenshot 4e429e19). The OL inside still wraps
     across pages thanks to the per-LI break-inside rule above. */
  .tnc-section{page-break-before:always}

  /* Signature block — applicant-only, bottom-right.
     Flex with justify-end pins the 80mm signature column to the right and
     leaves the left side as whitespace. */
  .signature-section{margin-top:12mm;page-break-inside:avoid}
  .sig-grid{display:flex;justify-content:flex-end}
  .sig-grid > .sig-col{width:80mm}
  .sig-col h4{
    font-size:9pt;font-weight:700;text-transform:uppercase;letter-spacing:0.8pt;
    color:#111827;margin-bottom:4mm
  }
  .sig-img-wrap{height:26mm;display:flex;align-items:flex-end;padding-bottom:1mm}
  .sig-img-wrap img{max-width:60mm;max-height:24mm}
  .sig-line{border-bottom:1px solid #111827;margin-top:1mm}
  .sig-fields{width:100%;border-collapse:collapse;margin-top:3mm}
  .sig-fields td{padding:1mm 0;font-size:9pt;vertical-align:top;line-height:1.4}
  .sig-fields td:first-child{width:24mm;font-weight:600;color:#4b5563;letter-spacing:0.3pt}
  .sig-fields td:last-child{color:#111827}
  .audit-footer{margin-top:10mm;padding-top:3mm;border-top:1px solid #e5e7eb;
    font-size:8pt;color:#6b7280;text-align:center;letter-spacing:0.2pt}

  /* Owner payout reports carry more financial detail than the other document
     types. Give the legal entity the full centre width, keep its registered
     name on one line, and use a denser print rhythm so a short expense table is
     not stranded by itself on page two. */
  .doc-owner-statement .doc-header{
    grid-template-columns:18mm minmax(0,1fr) 42mm;gap:4mm;align-items:center;
    margin-bottom:4mm;padding-bottom:3mm;border-bottom:1.5px solid #082f55
  }
  .doc-owner-statement .doc-header.no-logo{grid-template-columns:minmax(0,1fr) 42mm}
  .doc-owner-statement .doc-header.no-logo .zone-left{display:none}
  .doc-owner-statement .zone-left img{max-width:17mm;max-height:17mm}
  .doc-owner-statement .zone-center{text-align:left;min-width:0}
  .doc-owner-statement .zone-center h1{
    color:#082f55;font-size:12pt;line-height:1.2;letter-spacing:.12pt;
    margin-bottom:1mm;white-space:nowrap
  }
  .doc-owner-statement .zone-center p{display:inline;color:#4b5563;font-size:7.5pt;line-height:1.35}
  .doc-owner-statement .zone-center p:not(:last-child)::after{content:"  ·  ";color:#c9a35c}
  .doc-owner-statement .zone-right h2{color:#082f55;font-size:10.5pt;line-height:1.2;margin-bottom:1.5mm}
  .doc-owner-statement .zone-right p{font-size:7.8pt;line-height:1.35}
  .doc-owner-statement .zone-right .ref-label{font-size:7pt;margin-top:0}
  .doc-owner-statement .zone-right .ref-value{font-size:8.5pt;margin-bottom:.7mm}
  .doc-owner-statement main{margin-top:0}
  .doc-owner-statement main section{margin-top:2.3mm;margin-bottom:2.3mm}
  .doc-owner-statement main section:first-child{margin-top:0}
`;

export function renderToHtml(payload: RenderPayload): string {
  const { template, referenceCode, issuedDate, dueDate, bodyHtml, signature } = payload;
  const h = template.headerFields;
  const hasVisibleLogo = h.showLogo && Boolean(template.logoUrl);
  const documentClass = `doc-${template.docType.replace(/_/g, "-")}`;

  const headerElement = React.createElement(
    "header",
    { className: `doc-header ${hasVisibleLogo ? "has-logo" : "no-logo"}` },
    React.createElement(
      "div",
      { className: "zone-left" },
      hasVisibleLogo && template.logoUrl
        ? React.createElement("img", { src: template.logoUrl, alt: "logo" })
        : null,
    ),
    React.createElement(
      "div",
      { className: "zone-center" },
      React.createElement("h1", null, template.orgName),
      h.showRegNo && template.orgRegNo
        ? React.createElement("p", { key: "reg" }, `Reg No: ${template.orgRegNo}`)
        : null,
      h.showSalesTaxId && template.orgSalesTaxId
        ? React.createElement("p", { key: "sales" }, `Sales Tax ID: ${template.orgSalesTaxId}`)
        : null,
      h.showServiceTaxId && template.orgServiceTaxId
        ? React.createElement("p", { key: "svc" }, `Service Tax ID: ${template.orgServiceTaxId}`)
        : null,
      h.showAddress
        ? template.orgAddressLines.map((line, i) =>
            React.createElement("p", { key: `addr-${i}` }, line),
          )
        : null,
      h.showEmail && template.orgEmail
        ? React.createElement("p", { key: "em" }, `Email: ${template.orgEmail}`)
        : null,
      h.showContact && template.orgContact
        ? React.createElement("p", { key: "ct" }, `Contact: ${template.orgContact}`)
        : null,
    ),
    React.createElement(
      "div",
      { className: "zone-right" },
      // Title supports an explicit "\n" line break so per-docType overrides
      // (see service.ts titleOverrides) can force the wrap point — e.g.
      // "Rental Commission\nClaim Form" → "RENTAL COMMISSION" / "CLAIM FORM".
      React.createElement(
        "h2",
        null,
        ...template.title.split("\n").flatMap((line, i) =>
          i === 0
            ? [line]
            : [React.createElement("br", { key: `br-${i}` }), line],
        ),
      ),
      React.createElement(
        "p",
        { key: "ref-label", className: "ref-label" },
        "Reference Number:",
      ),
      React.createElement(
        "p",
        { key: "ref-value", className: "ref-value" },
        React.createElement("strong", null, referenceCode),
      ),
      React.createElement("p", { key: "date" }, `Date: ${fmt(issuedDate)}`),
      dueDate ? React.createElement("p", { key: "due" }, `Due Date: ${fmt(dueDate)}`) : null,
    ),
  );

  const headerHtml = renderToStaticMarkup(headerElement);

  let signatureHtml = "";
  if (signature) {
    const applicantCol = React.createElement(
      "div",
      { className: "sig-col" },
      React.createElement("h4", null, "Signed by the Applicant"),
      React.createElement(
        "div",
        { className: "sig-img-wrap" },
        React.createElement("img", { src: signature.pngDataUrl, alt: "signature" }),
      ),
      React.createElement("div", { className: "sig-line" }),
      React.createElement(
        "table",
        { className: "sig-fields" },
        React.createElement(
          "tbody",
          null,
          React.createElement(
            "tr",
            null,
            React.createElement("td", null, "Name"),
            React.createElement("td", null, signature.typedName),
          ),
          React.createElement(
            "tr",
            null,
            React.createElement("td", null, "Date"),
            React.createElement("td", null, fmtLong(signature.signedAt)),
          ),
        ),
      ),
    );

    const auditFooter = React.createElement(
      "p",
      { className: "audit-footer" },
      `Signed digitally — Signed by: ${signature.typedName} · ${fmtLong(signature.signedAt)} · IP ${signature.ip}`,
    );

    // Applicant block sits in a left-aligned 80mm wrapper (client feedback
     // 2026-05-15 — no management counter-sign; sig stays bottom-left).
    const sigBlock = React.createElement(
      "footer",
      { className: "signature-section" },
      React.createElement("div", { className: "sig-grid" }, applicantCol),
      auditFooter,
    );
    signatureHtml = renderToStaticMarkup(sigBlock);
  }

  return [
    "<!DOCTYPE html>",
    "<html><head><meta charset='utf-8'/>",
    `<style>${CSS}</style></head><body class='${documentClass}'><div class='page'>`,
    headerHtml,
    "<main>",
    bodyHtml,
    "</main>",
    signatureHtml,
    "</div></body></html>",
  ].join("");
}
