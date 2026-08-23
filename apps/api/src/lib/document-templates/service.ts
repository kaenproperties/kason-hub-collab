// apps/api/src/lib/document-templates/service.ts

import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../storage";
import { getDefaultLogoDataUrl } from "./default-logo";
import * as repo from "./repository";
import type { DocType, ResolvedTemplate } from "./types";
import { DEFAULT_HEADER_FIELDS } from "./types";
import {
  LEGAL_DOCUMENT_PROFILE,
  withLegalDocumentDefaults,
} from "./legal-document-profile";

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

/** Legal entity printed on every financial/customer document. */
export const LEGAL_DOCUMENT_ORG_NAME = LEGAL_DOCUMENT_PROFILE.organizationName;

async function resolveLogoUrl(effectiveLogoKey: string | null): Promise<string | null> {
  return effectiveLogoKey
    ? await createSignedDownloadUrl(effectiveLogoKey)
    : (await getDefaultLogoDataUrl()) || null;
}

export async function getTemplateForOrgDocType(
  orgId: string,
  docType: DocType,
  opts?: { tolerateLogoFailure?: boolean },
): Promise<ResolvedTemplate> {
  let row = await repo.findTemplate(orgId, docType);
  if (!row) {
    row = await repo.upsertTemplate(orgId, docType, {
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
  }

  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      name: true,
      cardSettings: { select: { logoKey: true } },
    },
  });

  const effectiveLogoKey = row.logoKey ?? org.cardSettings?.logoKey ?? null;
  // A logo signing/storage hiccup CAN be tolerated (letterhead renders without a
  // logo) but ONLY for callers that explicitly opt in via tolerateLogoFailure —
  // this is NOT the default. Most callers persist or email the resulting PDF
  // (owner statement regenerate, reservation customer-sign, commission claims,
  // etc.), so a transient logo-signing blip must still fail the whole call
  // loudly for them rather than silently shipping a logoless legal/money
  // document. Today only owner-ledger-receipt.service.ts's
  // buildOwnerLedgerReceiptPdf opts in — it's a pure-read, on-demand PDF that is
  // never persisted or portal-visible, so a missing logo there is low-stakes.
  let logoUrl: string | null;
  if (opts?.tolerateLogoFailure === true) {
    try {
      logoUrl = await resolveLogoUrl(effectiveLogoKey);
    } catch (error) {
      logoUrl = null;
      console.warn(
        "[document-templates] logo resolution failed; rendering letterhead without logo",
        { orgId, docType, error },
      );
    }
  } else {
    logoUrl = await resolveLogoUrl(effectiveLogoKey);
  }

  // The workspace/trading name can remain "KAEN Properties", but formal
  // documents must always identify the registered legal entity exactly.
  const orgName = LEGAL_DOCUMENT_ORG_NAME;

  // Per-docType title overrides. Some docTypes have a fixed brand title that
  // the admin Settings UI deliberately doesn't expose as editable — the
  // override here is the single source of truth, regardless of any value
  // sitting in the DB. The "\n" forces a line break in the rendered <h2>
  // (see render.ts and letterhead-preview.tsx — both split on \n and emit
  // <br>). Keep mixed-case here; CSS handles the uppercase transform.
  const titleOverrides: Partial<Record<DocType, string>> = {
    rental_commission_claim: "Rental Commission\nClaim Form",
    owner_statement: "Owner Payout Report",
  };
  const effectiveTitle = titleOverrides[docType] ?? row.title;

  return withLegalDocumentDefaults({
    id: row.id,
    organizationId: row.organizationId,
    docType: row.docType as DocType,
    title: effectiveTitle,
    refPrefix: row.refPrefix,
    refSeparator: row.refSeparator,
    refPadding: row.refPadding,
    refIncludeYear: row.refIncludeYear,
    headerFields: row.headerFields,
    orgName,
    orgRegNo: row.orgRegNo,
    orgSalesTaxId: row.orgSalesTaxId,
    orgServiceTaxId: row.orgServiceTaxId,
    orgAddressLines: row.orgAddressLines,
    orgEmail: row.orgEmail,
    orgContact: row.orgContact,
    logoUrl,
    bodyTemplate: row.bodyTemplate,
  });
}
