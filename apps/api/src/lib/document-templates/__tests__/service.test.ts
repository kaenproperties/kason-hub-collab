// apps/api/src/lib/document-templates/__tests__/service.test.ts

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTemplateForOrgDocType } from "../service";
import * as repo from "../repository";
import { createSignedDownloadUrl } from "../../storage";
import { DEFAULT_HEADER_FIELDS } from "../types";

vi.mock("../repository");

// Mutable per-test mock so each case can set its own cardSettings shape.
let mockOrgCardSettings: { logoKey: string | null; legalEntityName: string | null } | null =
  { logoKey: "logos/org-wide.png", legalEntityName: null };
let mockOrgName = "KAEN Properties";
// When set, the org lookup itself throws — used to prove the tolerate-logo-failure
// catch is scoped ONLY to the logo-resolution line, not the whole function body.
let mockOrgLookupError: Error | null = null;

vi.mock("@kason/db", () => ({
  getDb: () => ({
    organization: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        if (mockOrgLookupError) throw mockOrgLookupError;
        return {
          id: where.id,
          name: mockOrgName,
          cardSettings: mockOrgCardSettings,
        };
      },
    },
  }),
}));
// vi.fn()-wrapped (not a bare async function) so individual tests can override
// the resolved/rejected behavior per-call via mockRejectedValueOnce etc.
vi.mock("../../storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://s3.test/${key}?sig=x`),
}));

describe("getTemplateForOrgDocType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state between tests so prior values don't leak.
    mockOrgCardSettings = { logoKey: "logos/org-wide.png", legalEntityName: null };
    mockOrgName = "KAEN Properties";
    mockOrgLookupError = null;
  });

  it("returns an existing template with resolved org name and logo URL", async () => {
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-1",
      organizationId: "org-1",
      docType: "reservation_form",
      title: "Unit Reservation Form",
      refPrefix: "KAEN RES",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: "1610050-V",
      orgSalesTaxId: null,
      orgServiceTaxId: "W10-2506-32000179",
      orgAddressLines: ["NO. 27-3, Jalan Perdana 10/12"],
      orgEmail: "kaenproperties@gmail.com",
      orgContact: "+601136111763",
      logoKey: "logos/kaen.png",
    });

    const t = await getTemplateForOrgDocType("org-1", "reservation_form");

    expect(t.title).toBe("Unit Reservation Form");
    expect(t.orgName).toBe("KAEN PROPERTIES MANAGEMENT SDN BHD");
    expect(t.logoUrl).toBe("https://s3.test/logos/kaen.png?sig=x");
  });

  it("seeds a default template if none exists", async () => {
    vi.mocked(repo.findTemplate).mockResolvedValueOnce(null);
    vi.mocked(repo.upsertTemplate).mockImplementation(async (orgId, docType, data) => ({
      id: "tpl-new",
      organizationId: orgId,
      docType,
      ...data,
    }));

    const t = await getTemplateForOrgDocType("org-1", "reservation_form");

    expect(repo.upsertTemplate).toHaveBeenCalledTimes(1);
    expect(t.refPrefix).toBe("");
    expect(t.title).toBe("Unit Reservation Form");
    expect(t.headerFields).toEqual(DEFAULT_HEADER_FIELDS);
  });

  it("falls back to org-wide logoKey when template logoKey is null", async () => {
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-2",
      organizationId: "org-1",
      docType: "invoice",
      title: "Invoice",
      refPrefix: "INV",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: true,
      headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: null,
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: null, // no per-template logo
    });

    const t = await getTemplateForOrgDocType("org-1", "invoice");

    // Should use org-wide key from cardSettings.logoKey
    expect(t.logoUrl).toBe("https://s3.test/logos/org-wide.png?sig=x");
  });

  it("uses the fixed registered legal entity name", async () => {
    mockOrgName = "KAEN PROPERTIES MANAGEMENT SDN BHD";
    mockOrgCardSettings = { logoKey: "logos/x.png", legalEntityName: null };
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-1", organizationId: "org-1", docType: "reservation_form",
      title: "Unit Reservation Form", refPrefix: "", refSeparator: "-",
      refPadding: 5, refIncludeYear: false, headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: null, orgSalesTaxId: null, orgServiceTaxId: null,
      orgAddressLines: [], orgEmail: null, orgContact: null, logoKey: null,
    });

    const t = await getTemplateForOrgDocType("org-1", "reservation_form");
    expect(t.orgName).toBe("KAEN PROPERTIES MANAGEMENT SDN BHD");
  });

  it("ignores the now-deprecated legalEntityName when set", async () => {
    // Existing rows may still carry a non-null legalEntityName from before
    // the consolidation — the render path no longer reads it.
    mockOrgName = "KAEN PROPERTIES MANAGEMENT SDN BHD";
    mockOrgCardSettings = {
      logoKey: null,
      legalEntityName: "STALE OVERRIDE THAT SHOULD NOT WIN",
    };
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-2", organizationId: "org-1", docType: "reservation_form",
      title: "Unit Reservation Form", refPrefix: "", refSeparator: "-",
      refPadding: 5, refIncludeYear: false, headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: null, orgSalesTaxId: null, orgServiceTaxId: null,
      orgAddressLines: [], orgEmail: null, orgContact: null, logoKey: null,
    });

    const t = await getTemplateForOrgDocType("org-1", "reservation_form");
    expect(t.orgName).toBe("KAEN PROPERTIES MANAGEMENT SDN BHD");
  });

  it("uses per-template logoKey over org-wide when both are set", async () => {
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-3",
      organizationId: "org-1",
      docType: "invoice",
      title: "Invoice",
      refPrefix: "INV",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: true,
      headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: null,
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/per-template.png",
    });

    const t = await getTemplateForOrgDocType("org-1", "invoice");

    expect(t.logoUrl).toBe("https://s3.test/logos/per-template.png?sig=x");
  });

  // Regression guard for the "silent whole-letterhead collapse" bug, NARROWED to
  // an explicit opt-in: a logo signing/storage hiccup resolves with logoUrl: null
  // (does NOT throw) ONLY when the caller passes { tolerateLogoFailure: true }.
  // Only ONE caller opts in today — owner-ledger-receipt.service.ts's
  // buildOwnerLedgerReceiptPdf, a pure-read, non-persisted, non-portal-visible
  // on-demand PDF. The other 5 of 7 docType callers (commissions.service.ts,
  // reservations/public.routes.ts, reservations/service.ts x2,
  // owner-billing.service.ts — plus billing-documents/pdf.service.ts, which
  // already wraps its own try/catch at the call site) pass no third argument at
  // all, so they keep throwing loudly on a logo failure exactly as before this
  // tolerance existed — see the "propagates" tests below, which are the real
  // regression guard for those callers now that the catch is no longer
  // unconditional.
  it("resolves with logoUrl: null (does not throw) when the logo signer fails AND the caller opts in via tolerateLogoFailure: true; the rest of the letterhead still resolves", async () => {
    const signingError = new Error("S3 signing failed");
    vi.mocked(createSignedDownloadUrl).mockRejectedValueOnce(signingError);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-4",
      organizationId: "org-1",
      docType: "owner_statement",
      title: "Owner Statement",
      refPrefix: "",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS, showLogo: true },
      orgRegNo: "1234567-X",
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/broken.png",
    });

    await expect(
      getTemplateForOrgDocType("org-1", "owner_statement", { tolerateLogoFailure: true }),
    ).resolves.toMatchObject({
      logoUrl: null,
      orgName: "KAEN PROPERTIES MANAGEMENT SDN BHD",
      orgRegNo: "1234567-X",
      orgAddressLines: [
        "No. 27-3, Jalan Perdana 10/12",
        "Pandan Perdana, 55300 Kuala Lumpur",
        "Malaysia",
      ],
      orgEmail: "kaenproperties@gmail.com",
      orgContact: "011-3611 1763",
      title: "Owner Payout Report",
    });

    // Observability: a tolerated failure must be logged, never silent.
    expect(warnSpy).toHaveBeenCalledWith(
      "[document-templates] logo resolution failed; rendering letterhead without logo",
      { orgId: "org-1", docType: "owner_statement", error: signingError },
    );
    warnSpy.mockRestore();
  });

  // THE core safety fix: DEFAULT (no opts) must keep throwing exactly as it did
  // before any logo-tolerance existed. This is the regression guard for the 5
  // callers that rely on getTemplateForOrgDocType failing loudly (commissions,
  // reservations x2, owner-billing — two of which PERSIST/EMAIL the resulting
  // PDF), so a transient logo-signing blip never silently ships a logoless
  // legal/money document.
  it("propagates (throws) when the logo signer fails and no opts are passed (default = loud-fail)", async () => {
    vi.mocked(createSignedDownloadUrl).mockRejectedValueOnce(new Error("S3 signing failed"));
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-5",
      organizationId: "org-1",
      docType: "owner_statement",
      title: "Owner Statement",
      refPrefix: "",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS, showLogo: true },
      orgRegNo: "1234567-X",
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/broken.png",
    });

    await expect(
      getTemplateForOrgDocType("org-1", "owner_statement"),
    ).rejects.toThrow("S3 signing failed");
  });

  it("propagates (throws) when the logo signer fails and tolerateLogoFailure is explicitly false", async () => {
    vi.mocked(createSignedDownloadUrl).mockRejectedValueOnce(new Error("S3 signing failed"));
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-6",
      organizationId: "org-1",
      docType: "owner_statement",
      title: "Owner Statement",
      refPrefix: "",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS, showLogo: true },
      orgRegNo: "1234567-X",
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/broken.png",
    });

    await expect(
      getTemplateForOrgDocType("org-1", "owner_statement", { tolerateLogoFailure: false }),
    ).rejects.toThrow("S3 signing failed");
  });

  // Characterization tests (NOT part of the RED→GREEN cycle — both already hold
  // against the pre-fix code today, since it doesn't read a 3rd argument at all,
  // so there is no delta to force RED on). They lock in two properties the
  // adversarial test-audit flagged as easy to get wrong when adding an opt-in
  // flag; verified instead via a deliberate sabotage spot-check (see report).
  it("tolerateLogoFailure: true does not change the resolved logoUrl when the logo signer succeeds", async () => {
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-7",
      organizationId: "org-1",
      docType: "owner_statement",
      title: "Owner Statement",
      refPrefix: "",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS, showLogo: true },
      orgRegNo: "1234567-X",
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/good.png",
    });

    const t = await getTemplateForOrgDocType("org-1", "owner_statement", {
      tolerateLogoFailure: true,
    });
    expect(t.logoUrl).toBe("https://s3.test/logos/good.png?sig=x");
  });

  it("tolerateLogoFailure: true does not swallow a non-logo failure (org lookup) — the catch is scoped only to logo resolution", async () => {
    mockOrgLookupError = new Error("organization not found");
    vi.mocked(repo.findTemplate).mockResolvedValue({
      id: "tpl-8",
      organizationId: "org-1",
      docType: "owner_statement",
      title: "Owner Statement",
      refPrefix: "",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS, showLogo: true },
      orgRegNo: "1234567-X",
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: "logos/broken.png",
    });

    await expect(
      getTemplateForOrgDocType("org-1", "owner_statement", { tolerateLogoFailure: true }),
    ).rejects.toThrow("organization not found");
  });
});
