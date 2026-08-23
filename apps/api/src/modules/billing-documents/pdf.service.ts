// apps/api/src/modules/billing-documents/pdf.service.ts
//
// On-demand BillingDocument PDF. Immutable documents render ONCE: first
// GET renders via htmlToPdf, persists pdfKey (putObject upsert) and every
// later GET just signs the stored object. Letterhead: the (previously
// orphaned) "invoice" DocumentTemplate for invoice/debit_note; the new
// "credit_note"/"refund_note" templates for notes. The self-contained
// letterhead band mirrors owner-ledger-receipt.service.ts (portrait here).

import { getDb } from "@kason/db";
import { ACTIVE_ADJUSTMENT_NOTE_STATUSES, foldTaxLines, formatLineUnitLabel, toCents } from "@kason/shared";
import { buildBillBundlePdf } from "../../lib/bill-bundle";
import { mergePdfs } from "../../lib/document-templates/merge-pdfs";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import type { DocType, ResolvedTemplate } from "../../lib/document-templates/types";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { createSignedDownloadUrl, putObject } from "../../lib/storage";
import { adjustmentSumsByChargeId } from "./adjustment-sums";

export type BillingDocumentPdfModel = {
  docType: "invoice" | "debit_note" | "credit_note" | "refund_note" | "receipt" | "owner_expense_advice" | "proforma";
  title: string;
  documentNumber: string;
  issuedAt: string; // YYYY-MM-DD
  billingMonth: string | null; // "July 2026"
  counterpartyName: string;
  propertyName?: string | null;
  unitCode: string | null;
  reason: string | null;
  originalDocumentNumber: string | null;
  // `unitCode` per line is the per-LINE answer the document-level `unitCode`
  // above cannot give: a combined owner statement spans every unit, so the
  // header reads "—" and only the line can say which unit it bills. Null when
  // the line has no unit (charge-less line, or a charge without a unitId).
  lines: {
    categoryCode?: string | null;
    description: string;
    amount: string;
    sstRate: string;
    sstAmount: string;
    attachmentFilenames: string[];
    unitCode: string | null;
  }[];
  totals: { subtotal: string; sst: string; total: string };
  // Active CN/DN notes issued AGAINST this document. Empty for note docs and
  // unadjusted invoices. When non-empty the template prints one row per note
  // and an Adjusted Total — without this the "immutable render-once" PDF kept
  // showing the pre-adjustment invoice forever (punch list A, 2026-08-06).
  adjustments: { documentNumber: string; docType: "credit_note" | "debit_note"; total: string }[];
  adjustedTotal: string | null;
  /**
   * The supporting bills whose PAGES get appended after the rendered document.
   * Distinct from each line's `attachmentFilenames`, which only names them: an owner
   * who prints an invoice needs the bill itself, not a filename they cannot open.
   *
   * Two sources, deliberately scoped differently (see the "Attachment resolution" block
   * in buildBillingDocumentPdfModel): per-line expense bills, and — on OWNER documents
   * only — the unit-level bills-grid attachments for that apartment+month.
   */
  attachments: { storageKey: string; filename: string }[];
};

export const DOC_TITLE: Record<BillingDocumentPdfModel["docType"], string> = {
  invoice: "INVOICE",
  debit_note: "DEBIT NOTE",
  credit_note: "CREDIT NOTE",
  refund_note: "REFUND NOTE",
  receipt: "RECEIPT",
  owner_expense_advice: "OWNER EXPENSE ADVICE",
  // Titled for what it IS — a request for payment, not a tax document. The whole point
  // of the proforma model is that a tenant can tell a provisional document from the real
  // invoice minted when their money arrives; printing "INVOICE" here would erase exactly
  // the distinction the split exists to create.
  proforma: "PROFORMA INVOICE",
};

/** Series-prefix → customer-facing PDF title, for the series whose customer identity differs
 * from their internal docType. RB (+ legacy IVREN) is a rental payment request; EB (internal docType "invoice" — a tenant
 * expense RECOVERY, not KAEN service revenue) is an expense payment request and must never print "INVOICE"
 * (redesign P2/P4). Matched on the series segment before the first "-", so "RBX-"/"IVRENX-"/"EBX-" do
 * NOT match. */
const SERIES_DOC_TITLE: Record<string, string> = {
  RB: "RENTAL PAYMENT REQUEST",
  IVREN: "RENTAL PAYMENT REQUEST",
  EB: "EXPENSE PAYMENT REQUEST",
  OEA: "OWNER EXPENSE ADVICE",
  // Move-in deposits. Its OWN series precisely so this title cannot leak onto the
  // utility/aircond debit notes that share DEP (see seed-categories.ts).
  DEPO: "DEPOSIT REQUEST",
  DEP: "PAYMENT REQUEST",
  PI: "PAYMENT REQUEST",
};

const PASS_THROUGH_CATEGORY_CODES = new Set([
  "electricity_tenant", "electricity_owner", "water_tenant", "water_owner",
  "sewerage_tenant", "sewerage_owner", "wifi_tenant", "wifi_owner",
  "utility_tnb", "utility_water", "utility_wifi", "utility_indah_water",
]);
const DEPOSIT_CATEGORY_CODES = new Set([
  "security_deposit", "utility_deposit", "tenancy_rental_deposit",
  "tenancy_utility_deposit", "carpark_deposit", "access_card_deposit",
]);

export function resolveEconomicDocTitle(
  docType: BillingDocumentPdfModel["docType"],
  documentNumber: string,
  categoryCodes: readonly (string | null | undefined)[],
): string {
  if (["credit_note", "refund_note", "receipt", "owner_expense_advice"].includes(docType)) {
    return resolveDocTitle(docType, documentNumber);
  }
  const prefix = documentNumber.split("-", 1)[0];
  if (SERIES_DOC_TITLE[prefix]) return SERIES_DOC_TITLE[prefix];
  const codes = [...new Set(categoryCodes.filter((code): code is string => Boolean(code)))];
  if (codes.length === 0) return resolveDocTitle(docType, documentNumber);
  if (codes.every((code) => DEPOSIT_CATEGORY_CODES.has(code))) return "DEPOSIT REQUEST";
  if (codes.every((code) => PASS_THROUGH_CATEGORY_CODES.has(code))) return "UTILITY PAYMENT REQUEST";
  if (codes.some((code) => PASS_THROUGH_CATEGORY_CODES.has(code))) return "MONTHLY BILLING STATEMENT";
  return resolveDocTitle(docType, documentNumber);
}

const DESCRIPTION_LABELS: Record<string, string> = {
  management_fee: "Property Management Fee",
  letting_commission: "Rental Commission",
  letting_commission_sst: "SST on Admin Fee (First Month Rental)",
  rental: "Monthly Rental",
  carpark: "Carpark Rental",
  tenancy_rental_deposit: "Rental Deposit",
  tenancy_utility_deposit: "Utilities Deposit",
  security_deposit: "Security Deposit",
  utility_deposit: "Utilities Deposit",
  electricity_tenant: "Electricity",
  electricity_owner: "Electricity",
  water_tenant: "Water",
  water_owner: "Water",
  wifi_tenant: "WiFi",
  wifi_owner: "WiFi",
};

function safeFilenamePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
}
function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function billingDocumentFilename(model: BillingDocumentPdfModel): string {
  const categoryCodes = [...new Set(model.lines.map((line) => line.categoryCode).filter((code): code is string => Boolean(code)))];
  const isOwnerInvoice = model.documentNumber.split("-", 1)[0] === "IVOWN";
  const labels = [...new Set(categoryCodes
    .map((code) => code === "letting_commission" && isOwnerInvoice
      ? "Admin Fee (First Month Rental)"
      : DESCRIPTION_LABELS[code])
    .filter((label): label is string => Boolean(label)))];
  const description = labels.length === 1
    ? labels[0]
    : model.lines.length === 1
      ? titleCase(model.lines[0].description.replace(/\([^)]*\)/g, "").trim())
      : "Multiple Charges";
  const parts = [titleCase(model.title), description, model.propertyName, model.unitCode]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map(safeFilenamePart);
  return `${parts.join(" ")}.pdf`;
}

/** Customer-facing document title. A series with its own identity (SERIES_DOC_TITLE) wins over
 * the internal docType; every other doc uses the docType title map. */
export function resolveDocTitle(docType: BillingDocumentPdfModel["docType"], documentNumber: string): string {
  const seriesPrefix = documentNumber.split("-", 1)[0];
  if (SERIES_DOC_TITLE[seriesPrefix]) return SERIES_DOC_TITLE[seriesPrefix];
  return DOC_TITLE[docType];
}

export const LETTERHEAD_DOC_TYPE: Record<BillingDocumentPdfModel["docType"], DocType> = {
  invoice: "invoice",
  debit_note: "invoice", // §4.1: the orphaned 'invoice' letterhead covers tenant Invoice/DN
  credit_note: "credit_note",
  refund_note: "refund_note",
  receipt: "invoice", // R6 DECISION: receipts REUSE the invoice letterhead (no dedicated template)
  // OEA reuses the invoice letterhead exactly as receipt does — KNOWN_DOC_TYPES
  // (document-templates/types.ts) has no OEA entry and needs none.
  owner_expense_advice: "invoice",
  // Reuses the invoice letterhead, same as receipt/OEA above: KNOWN_DOC_TYPES
  // (document-templates/types.ts) has no proforma entry and needs none — the letterhead
  // is org branding, and the title (DOC_TITLE) is what distinguishes the document.
  proforma: "invoice",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function monthLabel(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function money2dp(v: { toString(): string }): string {
  const n = parseFloat(v.toString());
  return Number.isNaN(n) ? "0.00" : n.toFixed(2);
}

function renderLetterheadBand(template: ResolvedTemplate | null, title: string): string {
  if (!template) return "";
  const h = template.headerFields;
  const logoHtml =
    h.showLogo && template.logoUrl
      ? `<img src="${esc(template.logoUrl)}" alt="logo" style="max-width:100%;max-height:26mm">`
      : "";
  const centerLines: string[] = [`<div class="lh-org-name">${esc(template.orgName)}</div>`];
  if (h.showRegNo && template.orgRegNo) centerLines.push(`<div class="lh-meta">Reg No: ${esc(template.orgRegNo)}</div>`);
  if (h.showSalesTaxId && template.orgSalesTaxId) centerLines.push(`<div class="lh-meta">Sales Tax ID: ${esc(template.orgSalesTaxId)}</div>`);
  if (h.showServiceTaxId && template.orgServiceTaxId) centerLines.push(`<div class="lh-meta">Service Tax ID: ${esc(template.orgServiceTaxId)}</div>`);
  if (h.showAddress) for (const line of template.orgAddressLines) centerLines.push(`<div class="lh-meta">${esc(line)}</div>`);
  if (h.showEmail && template.orgEmail) centerLines.push(`<div class="lh-meta">Email: ${esc(template.orgEmail)}</div>`);
  if (h.showContact && template.orgContact) centerLines.push(`<div class="lh-meta">Contact: ${esc(template.orgContact)}</div>`);
  return `
<div class="lh-band">
  <div class="lh-logo">${logoHtml}</div>
  <div class="lh-center">${centerLines.join("")}</div>
  <div class="lh-title">${esc(title)}</div>
</div>`;
}

/** Pure — exported for unit tests (no Chromium). */
export function renderBillingDocumentHtml(model: BillingDocumentPdfModel, template: ResolvedTemplate | null): string {
  const rows = model.lines
    .map((l, i) => {
      // Filenames only — no embedded images (spec R7).
      const attachmentsHtml = l.attachmentFilenames.length
        ? `<div class="line-attachments">${l.attachmentFilenames
            .map((f) => `<div class="att-file">Attachment: ${esc(f)}</div>`)
            .join("")}</div>`
        : "";
      // Which unit this line bills — printed under the description so the
      // 4-column layout is untouched. Only rendered when the line HAS a unit.
      const unitHtml = l.unitCode ? `<div class="line-unit">${esc(l.unitCode)}</div>` : "";
      return `
      <tr>
        <td style="text-align:center">${i + 1}</td>
        <td>${esc(l.description)}${unitHtml}${attachmentsHtml}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">RM ${esc(l.amount)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">RM ${esc(l.sstAmount)}</td>
      </tr>`.trim();
    })
    .join("\n      ");

  const refBlock = model.originalDocumentNumber
    ? `<div class="ref-line">Original document: ${esc(model.originalDocumentNumber)}</div>`
    : "";
  const reasonBlock = model.reason ? `<div class="ref-line">Reason: ${esc(model.reason)}</div>` : "";

  const css = `
    @page { size: A4; margin: 15mm 14mm 18mm 14mm }
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #1f2937; line-height: 1.45 }
    .lh-band { display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: start; column-gap: 6mm; padding-bottom: 4mm; border-bottom: 1px solid #d1d5db; margin-bottom: 5mm }
    .lh-logo { min-width: 20mm }
    .lh-center { text-align: center }
    .lh-org-name { font-size: 11pt; font-weight: 700; margin-bottom: 1mm }
    .lh-meta { font-size: 8pt; color: #4b5563; line-height: 1.4 }
    .lh-title { font-size: 12pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5pt; text-align: right; white-space: nowrap; padding-top: 1mm }
    .standalone-title { font-size: 14pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5pt; margin-bottom: 4mm }
    .info-block { display: flex; justify-content: space-between; margin-bottom: 6mm }
    .info-left .info-row { margin-bottom: 1.5mm }
    .info-left .info-label { font-size: 8pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.3pt; display: inline-block; width: 24mm }
    .info-left .info-value { font-weight: 600 }
    .info-right { text-align: right }
    .info-right .doc-no { font-size: 11pt; font-weight: 700 }
    .info-right .doc-date { font-size: 8pt; color: #6b7280; margin-top: 1mm }
    .ref-line { font-size: 9pt; color: #4b5563; margin-bottom: 1.5mm }
    table { width: 100%; border-collapse: collapse; margin-top: 2mm }
    thead tr { background: #f3f4f6 }
    th { text-align: left; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5pt; padding: 2mm 3mm; border-bottom: 2px solid #d1d5db }
    td { padding: 1.8mm 3mm; border-bottom: 1px solid #e5e7eb; vertical-align: top }
    tbody tr:last-child td { border-bottom: none }
    .line-unit { margin-top: 0.6mm; font-size: 8pt; color: #4b5563; font-weight: 600 }
    .line-attachments { margin-top: 1mm }
    .att-file { font-size: 7.5pt; color: #6b7280 }
    .totals { margin-top: 5mm; border-top: 2px solid #111827; padding-top: 3mm }
    .totals-row { display: flex; justify-content: flex-end; gap: 18mm; margin-bottom: 1.5mm }
    .totals-row .tot-label { font-size: 8pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4pt; min-width: 42mm; text-align: right }
    .totals-row .tot-value { font-size: 9.5pt; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 24mm; text-align: right; padding-right: 3mm }
    .totals-row.grand .tot-label { font-size: 9.5pt; font-weight: 700; color: #111827 }
    .totals-row.grand .tot-value { font-size: 11.5pt; font-weight: 700 }
    .doc-footer { margin-top: 8mm; border-top: 1px solid #d1d5db; padding-top: 3mm; font-size: 7.5pt; color: #6b7280 }
  `;

  const letterheadHtml = renderLetterheadBand(template, model.title);
  const standaloneTitle = template ? "" : `<div class="standalone-title">${esc(model.title)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>${esc(model.title)}</title><style>${css}</style></head>
<body>
  ${letterheadHtml}
  ${standaloneTitle}
  <div class="info-block">
    <div class="info-left">
      <div class="info-row"><span class="info-label">Bill To</span><span class="info-value">${esc(model.counterpartyName)}</span></div>
      ${model.unitCode ? `<div class="info-row"><span class="info-label">Unit</span><span class="info-value">${esc(model.unitCode)}</span></div>` : ""}
      ${model.billingMonth ? `<div class="info-row"><span class="info-label">Period</span><span class="info-value">${esc(model.billingMonth)}</span></div>` : ""}
    </div>
    <div class="info-right">
      <div class="doc-no">${esc(model.documentNumber)}</div>
      <div class="doc-date">Date: ${esc(model.issuedAt)}</div>
    </div>
  </div>
  ${refBlock}
  ${reasonBlock}
  <table>
    <thead>
      <tr>
        <th style="text-align:center;width:8mm">#</th>
        <th>Description</th>
        <th style="text-align:right;width:30mm">Amount</th>
        <th style="text-align:right;width:24mm">Tax</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <div class="totals">
    <div class="totals-row"><span class="tot-label">Sub Total</span><span class="tot-value">RM ${esc(model.totals.subtotal)}</span></div>
    <div class="totals-row"><span class="tot-label">Sales &amp; Service Tax</span><span class="tot-value">RM ${esc(model.totals.sst)}</span></div>
    <div class="totals-row${model.adjustments.length ? "" : " grand"}"><span class="tot-label">Total</span><span class="tot-value">RM ${esc(model.totals.total)}</span></div>
    ${model.adjustments
      .map(
        (a) =>
          `<div class="totals-row"><span class="tot-label">${a.docType === "debit_note" ? "Debit Note" : "Credit Note"} ${esc(a.documentNumber)}</span><span class="tot-value">${a.docType === "debit_note" ? "+" : "−"} RM ${esc(a.total)}</span></div>`,
      )
      .join("\n    ")}
    ${model.adjustedTotal !== null ? `<div class="totals-row grand"><span class="tot-label">Adjusted Total</span><span class="tot-value">RM ${esc(model.adjustedTotal)}</span></div>` : ""}
  </div>
  <div class="doc-footer">
    <div>This is a computer-generated document. No signature required.</div>
  </div>
</body>
</html>`;
}

/** Load doc + context → model. Returns null when the doc is not in this org. */
export async function buildBillingDocumentPdfModel(orgId: string, documentId: string): Promise<BillingDocumentPdfModel | null> {
  const db = getDb();
  const doc = await db.billingDocument.findFirst({
    where: { id: documentId, organizationId: orgId },
    include: { lines: true },
  });
  if (!doc) return null;
  const party = await db.party.findFirst({ where: { id: doc.partyId, organizationId: orgId }, select: { displayName: true } });
  const apartment = doc.apartmentId
    ? await db.apartment.findFirst({
        where: { id: doc.apartmentId, organizationId: orgId },
        select: { unitCode: true, property: { select: { name: true } } },
      })
    : null;
  const original = doc.originalDocumentId
    ? await db.billingDocument.findFirst({ where: { id: doc.originalDocumentId, organizationId: orgId }, select: { documentNumber: true } })
    : null;

  // Attachment resolution. Produces BOTH the per-line filename list (bill-expenses R7,
  // unchanged) and `attachments` — the bills whose pages the PDF appends.
  //
  // Two sources with DELIBERATELY different scoping:
  //
  //  A. Per-line expense bills — charge.sourceGridExpenseId → GridAttachment. Safe for
  //     either counterparty: if the charge is a line on this document, this party is
  //     being billed for that expense, so its supporting bill is theirs to see.
  //
  //  B. Unit-level bills-grid attachments (GridAttachment.expenseId = null) for this
  //     apartment + month — OWNER DOCUMENTS ONLY. These are the owner's own supplier
  //     bills: the grid's Attachments panel states they "belong to the OWNER and attach
  //     to NO expense line". Appending them to a TENANT invoice would hand the tenant
  //     the owner's paperwork, so counterpartyType gates source B and nothing else.
  //     Scoping needs both apartmentId and billingMonth; without either we cannot say
  //     which month's bills belong here, so we fetch none rather than guess.
  const filenamesByLine = new Map<string, string[]>();
  const attachments: { storageKey: string; filename: string }[] = [];
  const seenAttachmentIds = new Set<string>();
  const pushAttachment = (a: { id: string; storageKey: string; filename: string }) => {
    if (seenAttachmentIds.has(a.id)) return; // two lines can share one expense's bill
    seenAttachmentIds.add(a.id);
    attachments.push({ storageKey: a.storageKey, filename: a.filename });
  };

  const docChargeIds = [...new Set(doc.lines.map((l) => l.chargeId).filter((x): x is string => x !== null))];
  if (isPhase2FlagEnabled("ENABLE_BILL_EXPENSES_AS_CHARGES") && docChargeIds.length) {
    const expCharges = await db.charge.findMany({
      where: { organizationId: orgId, id: { in: docChargeIds }, sourceGridExpenseId: { not: null } },
      select: { id: true, sourceGridExpenseId: true },
    });
    const expenseIdByCharge = new Map(expCharges.map((c) => [c.id, c.sourceGridExpenseId!]));
    const expenseIds = [...new Set(expCharges.map((c) => c.sourceGridExpenseId!))];
    if (expenseIds.length) {
      const atts = await db.gridAttachment.findMany({
        where: { organizationId: orgId, expenseId: { in: expenseIds } },
        select: { id: true, filename: true, storageKey: true, expenseId: true },
        orderBy: { createdAt: "asc" },
      });
      const byExpense = new Map<string, string[]>();
      for (const a of atts) {
        if (!a.expenseId) continue;
        const arr = byExpense.get(a.expenseId) ?? [];
        arr.push(a.filename);
        byExpense.set(a.expenseId, arr);
        pushAttachment(a);
      }
      for (const l of doc.lines) {
        if (!l.chargeId) continue;
        const expId = expenseIdByCharge.get(l.chargeId);
        if (expId) filenamesByLine.set(l.id, byExpense.get(expId) ?? []);
      }
    }
  }

  // Source B — unit-level grid attachments, OWNER documents only. See the leak note above.
  if (
    doc.counterpartyType === "owner" &&
    doc.apartmentId &&
    doc.billingMonth &&
    isPhase2FlagEnabled("ENABLE_GRID_BILLS_ON_OWNER_STATEMENT")
  ) {
    const unitLevel = await db.gridAttachment.findMany({
      where: {
        organizationId: orgId,
        apartmentId: doc.apartmentId,
        periodMonth: doc.billingMonth,
        expenseId: null,
      },
      select: { id: true, filename: true, storageKey: true },
      orderBy: { createdAt: "asc" },
    });
    for (const a of unitLevel) pushAttachment(a);
  }

  // Per-line unit identity — the same resolution the drawer uses
  // (getBillingDocumentDetail), through the SAME shared formatter, so the PDF
  // an owner receives can never label a line differently from the screen.
  // Runs unconditionally (not flag-gated) and AFTER the attachment lookup, which
  // owns its own charge query.
  const unitCodeByCharge = new Map<string, string | null>();
  // Tax sibling → the base charge it taxes. Selected on the query that ALREADY runs
  // for unit identity, so folding the SST line out of the PDF costs no round-trip.
  const parentChargeIdByCharge = new Map<string, string | null>();
  const categoryCodeByCharge = new Map<string, string | null>();
  if (docChargeIds.length) {
    const unitCharges = await db.charge.findMany({
      where: { organizationId: orgId, id: { in: docChargeIds } },
      select: {
        id: true,
        parentChargeId: true,
        category: { select: { code: true } },
        unit: { select: { listingType: true, apartment: { select: { unitCode: true, listingMode: true } } } },
      },
    });
    for (const c of unitCharges) {
      unitCodeByCharge.set(c.id, formatLineUnitLabel(c.unit));
      parentChargeIdByCharge.set(c.id, c.parentChargeId);
      categoryCodeByCharge.set(c.id, c.category?.code ?? null);
    }
  }

  // Active CN/DN notes against THIS document — the render must reflect them
  // (and charge-adjustment.service clears pdfKey on issue/void so a stale
  // cached render never survives an adjustment). Notes never carry notes.
  let adjustments: BillingDocumentPdfModel["adjustments"] = [];
  let adjustedTotal: string | null = null;
  if (doc.docType !== "credit_note" && doc.docType !== "debit_note") {
    const notes = await db.billingDocument.findMany({
      where: {
        organizationId: orgId,
        originalDocumentId: doc.id,
        docType: { in: ["credit_note", "debit_note"] },
        documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
      },
      select: { documentNumber: true, docType: true, total: true },
      orderBy: { issuedAt: "asc" },
    });
    if (notes.length) {
      adjustments = notes.map((n) => ({
        documentNumber: n.documentNumber,
        docType: n.docType as "credit_note" | "debit_note",
        total: money2dp(n.total),
      }));
      const adjustedCents = notes.reduce(
        (cents, n) =>
          cents + (n.docType === "debit_note" ? 1 : -1) * toCents(n.total.toString(), "pdf.adjustedTotal"),
        toCents(money2dp(doc.total), "pdf.docTotal"),
      );
      adjustedTotal = (adjustedCents / 100).toFixed(2);
    }
  }

  // Fold the SST sibling out of the printed lines, through the SAME shared helper the
  // screen uses — so the PDF a tenant or owner RECEIVES can never show a different set
  // of lines from the drawer. The sibling's amount is tax the base line already carries
  // in its SST column; printing it again made the Amount column sum to `total` while
  // the Subtotal underneath read lower, and showed the same RM twice.
  //
  // `adjustments` MUST be supplied here. foldTaxLines refuses to fold a line whose charge
  // (or whose base's charge) carries an active note — but `doc.lines` are raw Prisma rows
  // and BillingDocumentLine has no such relation, so passing them straight through left
  // that guard permanently inert on this path: the drawer, reading the DTO, would KEEP an
  // adjusted tax line while this PDF silently dropped it. That is exactly the screen/PDF
  // divergence this shared helper exists to make impossible, so the per-charge note sums
  // are resolved here (one batched query over charges already collected) and handed in.
  const pdfAdjustmentSums = await adjustmentSumsByChargeId(db, orgId, docChargeIds);
  const visibleLines = foldTaxLines(
    doc.lines.map((l) => {
      const sums = l.chargeId ? pdfAdjustmentSums.get(l.chargeId) : undefined;
      return {
        ...l,
        taxParentChargeId: l.isTax && l.chargeId ? (parentChargeIdByCharge.get(l.chargeId) ?? null) : null,
        // Presence + length is all foldTaxLines reads; the sums themselves are carried so
        // a future printed breakdown has them without another round trip.
        adjustments: sums && (sums.debitCents > 0 || sums.creditCents > 0) ? [sums] : [],
      };
    }),
  );

  const docType = doc.docType as BillingDocumentPdfModel["docType"];
  const renderedLines = visibleLines.map((l) => ({
    categoryCode: l.chargeId ? (categoryCodeByCharge.get(l.chargeId) ?? null) : null,
    description: l.description,
    amount: money2dp(l.amount),
    sstRate: l.sstRate.toString(),
    sstAmount: money2dp(l.sstAmount),
    attachmentFilenames: filenamesByLine.get(l.id) ?? [],
    unitCode: l.chargeId ? (unitCodeByCharge.get(l.chargeId) ?? null) : null,
  }));
  return {
    docType,
    title: resolveEconomicDocTitle(docType, doc.documentNumber, renderedLines.map((line) => line.categoryCode)),
    documentNumber: doc.documentNumber,
    issuedAt: doc.issuedAt.toISOString().slice(0, 10),
    billingMonth: doc.billingMonth ? monthLabel(doc.billingMonth) : null,
    counterpartyName: party?.displayName ?? "—",
    propertyName: apartment?.property.name ?? null,
    unitCode: apartment?.unitCode ?? null,
    reason: doc.reason,
    originalDocumentNumber: original?.documentNumber ?? null,
    lines: renderedLines,
    totals: { subtotal: money2dp(doc.subtotal), sst: money2dp(doc.sstAmount), total: money2dp(doc.total) },
    adjustments,
    adjustedTotal,
    attachments,
  };
}

/**
 * Append the supporting bills' pages after the rendered document, degrading to the
 * document alone if anything in the bundle/merge path fails. Never throws.
 *
 * `degraded` says the reader is holding LESS than the document should carry: bills
 * were expected and none of their pages made it. The caller uses it to decide
 * whether this render may be CACHED — see getBillingDocumentPdfUrl. A document with
 * no attachments at all is complete, not degraded.
 */
async function appendBillsOrDocumentAlone(
  documentPdf: Buffer,
  attachments: readonly { storageKey: string; filename: string }[],
  documentId: string,
): Promise<{ bytes: Buffer; degraded: boolean }> {
  if (attachments.length === 0) return { bytes: documentPdf, degraded: false };
  try {
    const bundle = await buildBillBundlePdf(attachments, `billing-document ${documentId}`);
    // A null bundle counts as DEGRADED, not as a settled answer. The bundler skips
    // per BILL, so a storage outage surfaces here as "every bill skipped" → null,
    // never as a throw — treating null as final is exactly how a transient outage
    // would get frozen into the cache.
    if (!bundle) {
      // eslint-disable-next-line no-console
      console.warn(
        `[billing-documents] pdf: no bill pages readable for ${documentId} (${attachments.length} expected); serving the document alone, NOT caching`,
      );
      return { bytes: documentPdf, degraded: true };
    }
    return { bytes: await mergePdfs(documentPdf, [Buffer.from(bundle)]), degraded: false };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[billing-documents] pdf: appending bills failed for ${documentId}; serving the document alone: ${(err as Error)?.message ?? err}`,
    );
    return { bytes: documentPdf, degraded: true };
  }
}

/**
 * Signed URL for the document PDF; renders + persists pdfKey on first call.
 * Returns null when the document is not in this org.
 */
export async function getBillingDocumentPdfUrl(orgId: string, documentId: string): Promise<{ url: string; filename?: string } | null> {
  const db = getDb();
  const doc = await db.billingDocument.findFirst({
    where: { id: documentId, organizationId: orgId },
    select: { id: true, pdfKey: true, docType: true },
  });
  if (!doc) return null;
  const model = await buildBillingDocumentPdfModel(orgId, documentId);
  if (!model) return null;
  const filename = billingDocumentFilename(model);
  // Local development deliberately has no Supabase credentials. PDF rendering
  // itself is fully local, so do not make a storage account a prerequisite for
  // testing or downloading accounting documents. The companion route streams
  // the exact same rendered bytes directly from this API process.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_STORAGE_BUCKET) {
    return { url: `/api/billing-documents/${documentId}/pdf-file`, filename };
  }
  // Old cached PDFs predate the economic document titles. Regenerate them once so
  // an existing Rental/Utility/Deposit document does not keep printing "INVOICE".
  if (doc.pdfKey?.includes("/economic-title-v1/")) {
    return { url: await createSignedDownloadUrl(doc.pdfKey, { filename }), filename };
  }
  let template: ResolvedTemplate | null = null;
  try {
    template = await getTemplateForOrgDocType(orgId, LETTERHEAD_DOC_TYPE[model.docType]);
  } catch {
    // Non-fatal — render without a letterhead band.
  }
  const pdf = await htmlToPdf(renderBillingDocumentHtml(model, template));

  // Append the supporting bills' PAGES after the document itself. Listing a
  // filename under a line told the reader a bill exists without ever giving it to
  // them; an owner printing an invoice needs the bill. Same bundler the owner
  // proof pack uses, so both are equally miss-resilient and equally bounded — a
  // bill whose bytes are gone is skipped, never fatal, and the document still
  // renders. No attachments (or none readable) ⇒ bytes are unchanged.
  //
  // The try/catch is load-bearing, not defensive habit: the bundler degrades per BILL
  // (a missing object is skipped) but `mergePdfs` loads its BASE un-guarded, and one
  // unexpected throw anywhere in here would turn a working invoice download into a 500.
  // The document is the thing the reader came for; losing its appended evidence is a
  // degradation, losing the document is an outage.
  const { bytes: withBills, degraded } = await appendBillsOrDocumentAlone(
    Buffer.from(pdf),
    model.attachments,
    doc.id,
  );

  const pdfKey = `billing-documents/${orgId}/economic-title-v1/${doc.id}.pdf`;
  await putObject(pdfKey, Buffer.from(withBills), "application/pdf");

  // A DEGRADED render is served but never cached. Persisting pdfKey here would
  // turn a transient storage/pdf-lib blip into a PERMANENT loss: every later
  // download short-circuits on `doc.pdfKey` at the top of this function, so the
  // owner would keep receiving an invoice missing its supporting bills, silently,
  // with nothing to indicate they were dropped. The only existing invalidation
  // (invalidateDocumentPdfsForAttachment) fires when an attachment is added or
  // removed — it cannot know a render failed.
  //
  // Leaving pdfKey null costs one re-render on the next download, which is an
  // already-supported path (that invalidator nulls pdfKey routinely). Cheap
  // insurance against silently serving incomplete evidence for a payout.
  if (degraded) return { url: await createSignedDownloadUrl(pdfKey, { filename }), filename };

  // Immutable content — pdfKey is a cache, not a money field. Two GETs can
  // race on an un-rendered doc and both render + try to persist; a plain
  // `update` here would be last-write-wins. The conditional updateMany
  // (guarded on pdfKey: null) makes exactly one writer "win" the row —
  // if we lose (count === 0), a concurrent render already won: re-read and
  // return the WINNER's signed url instead of overwriting it. The storage
  // object at our own deterministic key was simply written twice with
  // near-identical content — harmless, we just discard our own key.
  const written = await db.billingDocument.updateMany({
    where: { id: doc.id, pdfKey: doc.pdfKey },
    data: { pdfKey },
  });
  if (written.count === 0) {
    const winner = await db.billingDocument.findFirst({
      where: { id: doc.id },
      select: { pdfKey: true },
    });
    if (winner?.pdfKey) {
      return { url: await createSignedDownloadUrl(winner.pdfKey, { filename }), filename };
    }
  }
  return { url: await createSignedDownloadUrl(pdfKey, { filename }), filename };
}

/** Render-and-stream fallback used when object storage is unavailable locally. */
export async function renderBillingDocumentPdfFile(
  orgId: string,
  documentId: string,
): Promise<{ bytes: Buffer; filename: string } | null> {
  const model = await buildBillingDocumentPdfModel(orgId, documentId);
  if (!model) return null;
  let template: ResolvedTemplate | null = null;
  try {
    template = await getTemplateForOrgDocType(orgId, LETTERHEAD_DOC_TYPE[model.docType]);
  } catch {
    // A missing letterhead must not prevent the accountant from obtaining the
    // underlying document. The body remains complete and clearly titled.
  }
  const rendered = Buffer.from(await htmlToPdf(renderBillingDocumentHtml(model, template)));
  const { bytes } = await appendBillsOrDocumentAlone(rendered, model.attachments, documentId);
  return { bytes: Buffer.from(bytes), filename: billingDocumentFilename(model) };
}
