// apps/api/src/modules/document-templates/service.ts

import { randomUUID } from "node:crypto";
import { getDefaultLogoDataUrl } from "../../lib/document-templates/default-logo";
import * as repo from "../../lib/document-templates/repository";
import { stripWhiteBg } from "../../lib/document-templates/strip-white-bg";
import {
  DEFAULT_HEADER_FIELDS,
  KNOWN_DOC_TYPES,
  type DocType,
} from "../../lib/document-templates/types";
import { createSignedDownloadUrl, putObject } from "../../lib/storage";
import type { z } from "zod";
import type { updateTemplateBodySchema } from "./validation";
import {
  LEGAL_DOCUMENT_PROFILE,
  withLegalDocumentDefaults,
} from "../../lib/document-templates/legal-document-profile";

const DEFAULT_TITLE: Record<DocType, string> = {
  reservation_form: "Unit Reservation Form",
  rental_commission_claim: "Rental Commission Claim Form",
  invoice: "Invoice",
  renovation_claim: "Renovation Claim Form",
  owner_statement: "Owner Payout Report",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
  tenancy_agreement: "Tenancy Agreement",
  property_management_agreement: "Property Management Agreement",
};

// Per-docType title overrides — mirrors lib/document-templates/service.ts.
// Keeps the Settings page preview pane in sync with what the actual PDF
// service emits. The "\n" forces a line break in the rendered <h2>.
const TITLE_OVERRIDES: Partial<Record<DocType, string>> = {
  rental_commission_claim: "Rental Commission\nClaim Form",
  owner_statement: "Owner Payout Report",
};

function applyTitleOverride(row: repo.DocumentTemplateRow): repo.DocumentTemplateRow {
  const override = TITLE_OVERRIDES[row.docType as DocType];
  return override ? { ...row, title: override } : row;
}

export type DocumentTemplateWithLogoUrl = repo.DocumentTemplateRow & {
  logoUrl: string | null;
  orgName: string;
};

async function attachLogoUrl(
  row: repo.DocumentTemplateRow,
): Promise<DocumentTemplateWithLogoUrl> {
  // A logo that can't be resolved must NOT take the template row with it.
  // Both callers below are the admin Settings CRUD surface — they render no
  // document, so degrading to a logoless row is honest and keeps the page
  // usable (it's the only place the admin can re-upload a broken logo). This
  // is deliberately the opposite of lib/document-templates/service.ts, where
  // logo failure stays fatal by default because those callers persist or email
  // the resulting PDF and must never ship a logoless legal/money document.
  //
  // Regression guard: one stale logoKey (object deleted, bucket wiped, row
  // carried over from another org) used to reject out of here and 500 the
  // whole list. reservation_form is first in KNOWN_DOC_TYPES, so a single bad
  // key blanked all 7 cards. See __tests__/service.test.ts.
  let logoUrl: string | null;
  try {
    // When no upload exists, return the same bundled default the PDF renderer
    // uses — keeps the admin live preview visually identical to the rendered
    // PDF so admins aren't fooled by an empty "Logo" placeholder.
    logoUrl = row.logoKey
      ? await createSignedDownloadUrl(row.logoKey)
      : (await getDefaultLogoDataUrl()) || null;
  } catch (error) {
    logoUrl = null;
    console.warn(
      "[document-templates] logo resolution failed; returning template without logo",
      {
        orgId: row.organizationId,
        docType: row.docType,
        logoKey: row.logoKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return withLegalDocumentDefaults({
    ...applyTitleOverride(row),
    logoUrl,
    orgName: LEGAL_DOCUMENT_PROFILE.organizationName,
  });
}

export async function listTemplatesService(
  orgId: string,
): Promise<DocumentTemplateWithLogoUrl[]> {
  const rows = await repo.listTemplates(orgId);
  const byType = new Map(rows.map((r) => [r.docType, r] as const));
  const out: DocumentTemplateWithLogoUrl[] = [];
  for (const docType of KNOWN_DOC_TYPES) {
    const existing = byType.get(docType);
    if (existing) {
      out.push(await attachLogoUrl(existing));
    } else {
      const seeded = await repo.upsertTemplate(orgId, docType, {
        title: DEFAULT_TITLE[docType],
        refPrefix: "",
        refSeparator: "-",
        refPadding: 5,
        refIncludeYear: false,
        headerFields: { ...DEFAULT_HEADER_FIELDS },
        orgRegNo: null,
        orgSalesTaxId: null,
        orgServiceTaxId: null,
        orgAddressLines: [],
        orgEmail: null,
        orgContact: null,
        logoKey: null,
        bodyTemplate: null,
      });
      out.push(await attachLogoUrl(seeded));
    }
  }
  return out;
}

export async function updateTemplateService(
  orgId: string,
  docType: DocType,
  patch: z.infer<typeof updateTemplateBodySchema>,
): Promise<DocumentTemplateWithLogoUrl> {
  // Preserve PATCH semantics: omitting bodyTemplate must keep the stored body.
  // An explicit null is still forwarded by the spread and clears it.
  const row = await repo.upsertTemplate(orgId, docType, patch);
  return attachLogoUrl(row);
}

// Proxy upload: strip white background, persist to Supabase Storage, return
// the storageKey the admin UI then hands to PUT /:docType to save against
// the DocumentTemplate row. Raster inputs always come out as PNG (the strip
// step re-encodes them); SVG inputs are stored as-is.
export async function uploadLogoService(
  orgId: string,
  docType: DocType,
  file: { buf: Buffer; contentType: string },
): Promise<{ storageKey: string }> {
  const processed = await stripWhiteBg(file.buf, file.contentType);
  const isSvg = file.contentType === "image/svg+xml";
  const ext = isSvg ? "svg" : "png";
  const outContentType = isSvg ? "image/svg+xml" : "image/png";
  const storageKey = `org-templates/${orgId}/${docType}/logo-${randomUUID()}.${ext}`;
  await putObject(storageKey, processed, outContentType);
  return { storageKey };
}
