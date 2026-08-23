import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Banknote, FileText, Hammer, ImagePlus, Landmark, LayoutTemplate, Loader2, Receipt, Save, ScrollText, Trash2 } from "lucide-react";
import {
  KNOWN_DOC_TYPES,
  listTemplates,
  uploadTemplateLogo,
  updateTemplate,
  type DocType,
  type DocumentTemplate,
} from "@/api/document-templates";
import {
  getOrganizationProfile,
  updateOrganizationProfile,
} from "@/api/organization";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { COMPANY } from "@/lib/company-info";
import { LetterheadPreview, previewReferenceCode } from "./letterhead-preview";

const DOC_TYPE_LABEL: Record<DocType, string> = {
  reservation_form: "Unit Reservation Form",
  rental_commission_claim: "Rental Commission Claim",
  invoice: "Invoice",
  renovation_claim: "Renovation Claim",
  owner_statement: "Owner Payout Report",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
  tenancy_agreement: "Tenancy Agreement",
  property_management_agreement: "Property Management Agreement",
};

const DOC_TYPE_ICON: Record<DocType, React.ComponentType<{ className?: string }>> = {
  reservation_form: FileText,
  rental_commission_claim: ScrollText,
  invoice: Receipt,
  renovation_claim: Hammer,
  owner_statement: Landmark,
  credit_note: Receipt,
  refund_note: Banknote,
  tenancy_agreement: ScrollText,
  property_management_agreement: ScrollText,
};

// `logoUrl` and `orgName` are server-derived and never sent back on save.
type FormState = Omit<DocumentTemplate, "id" | "docType" | "logoUrl" | "orgName">;

function toFormState(t: DocumentTemplate): FormState {
  return {
    title: t.title,
    refPrefix: t.refPrefix,
    refSeparator: t.refSeparator,
    refPadding: t.refPadding,
    refIncludeYear: t.refIncludeYear,
    headerFields: { ...t.headerFields },
    orgRegNo: t.orgRegNo,
    orgSalesTaxId: t.orgSalesTaxId,
    orgServiceTaxId: t.orgServiceTaxId,
    orgAddressLines: [...t.orgAddressLines],
    orgEmail: t.orgEmail,
    orgContact: t.orgContact,
    logoKey: t.logoKey,
    bodyTemplate: t.bodyTemplate ?? null,
  };
}

function isDocType(value: string | undefined): value is DocType {
  return !!value && (KNOWN_DOC_TYPES as readonly string[]).includes(value);
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
        {label}
      </span>
    </div>
  );
}

function Section({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/50 bg-background/40 p-5 backdrop-blur-xl">
      <SectionHeader label={label} />
      {description && (
        <p className="mb-4 text-xs text-muted-foreground">{description}</p>
      )}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function LogoUploader({
  docType,
  currentLogoUrl,
  currentLogoKey,
  onChange,
}: {
  docType: DocType;
  currentLogoUrl: string | null;
  currentLogoKey: string | null;
  onChange: (key: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the freshly-picked file optimistically (data URL) while the upload
  // round-trips. Once the parent saves and re-fetches, currentLogoUrl reflects
  // the uploaded file via signed URL — the data URL is no longer needed.
  const displaySrc = previewDataUrl ?? currentLogoUrl ?? "/logo.png";
  const isUsingDefault = !previewDataUrl && !currentLogoUrl && !currentLogoKey;

  async function handlePick(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file (PNG, JPG, WebP, or SVG).");
      return;
    }
    if (file.size > 2_000_000) {
      setError("Logo must be 2 MB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setPreviewDataUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);

    setUploading(true);
    try {
      const { storageKey } = await uploadTemplateLogo(docType, file);
      onChange(storageKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setPreviewDataUrl(null);
    } finally {
      setUploading(false);
    }
  }

  function handleRemove() {
    setPreviewDataUrl(null);
    onChange(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 rounded-xl border border-border/50 bg-background/40 p-4">
        <div className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/40 bg-white">
          <img
            src={displaySrc}
            alt={isUsingDefault ? "KAEN Properties default logo" : "Reservation form logo"}
            className="max-h-full max-w-full object-contain"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {isUsingDefault ? "Using bundled default" : currentLogoKey ? "Custom logo uploaded" : "Pending save"}
          </p>
          <p className="mt-1 text-sm text-foreground">
            {isUsingDefault
              ? "KAEN Properties branded letterhead. Upload your own to override."
              : "This logo prints on every reservation PDF and the customer-facing sign page."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handlePick(f);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="gap-2"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              {currentLogoKey || previewDataUrl ? "Replace logo" : "Upload logo"}
            </Button>
            {(currentLogoKey || previewDataUrl) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                className="gap-2 text-rose-600 hover:text-rose-700"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <Callout variant="danger" title="Upload failed">
          {error}
        </Callout>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        PNG, JPG, WebP, or SVG. Max 2 MB. The image is rendered at up to 40 mm tall —
        a square or landscape logo around 240 × 240 px works best.
      </p>
    </div>
  );
}

function FieldRow({
  toggleLabel,
  toggleChecked,
  onToggle,
  inputAriaLabel,
  inputValue,
  onInputChange,
  placeholder,
}: {
  toggleLabel: string;
  toggleChecked: boolean;
  onToggle: (v: boolean) => void;
  inputAriaLabel: string;
  inputValue: string;
  onInputChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(8rem,9rem)_1fr] items-center gap-3">
      <Checkbox
        checked={toggleChecked}
        onCheckedChange={(v) => onToggle(Boolean(v))}
        aria-label={`Show ${toggleLabel}`}
      />
      <label className="text-sm font-medium text-foreground/85">{toggleLabel}</label>
      <Input
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
        placeholder={placeholder}
        aria-label={inputAriaLabel}
        disabled={!toggleChecked}
        className={!toggleChecked ? "opacity-50" : undefined}
      />
    </div>
  );
}

export default function EditTemplatePage() {
  const { docType } = useParams();
  const qc = useQueryClient();

  // Narrowed once, up front. The "unknown template type" bail-out below MUST
  // sit after every hook: it used to sit here, above ten of them, so a docType
  // that changed validity while this page stayed mounted (navigating between
  // /settings/document-templates/:docType routes) changed the hook count
  // between renders and blew up with "Rendered more hooks than during the
  // previous render". Hooks now run unconditionally and the bail-out is a
  // pure render-time branch. Null means "not a known DocType".
  const validDocType = isDocType(docType) ? docType : null;

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["admin", "document-templates"],
    queryFn: listTemplates,
  });

  const template = useMemo(
    () => templates.find((t) => t.docType === validDocType) ?? null,
    [templates, validDocType],
  );

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (template) setForm(toFormState(template));
  }, [template]);

  // The printed company name lives on Organization.name — same field the
  // Organisation Profile page edits, so both surfaces share one truth and
  // an edit here updates the letterhead on every reservation PDF + e-namecard
  // immediately. Inlined so the admin doesn't need to navigate to a separate
  // page to fix a typo on the reservation PDF.
  const orgProfileQuery = useQuery({
    queryKey: ["organization", "profile"],
    queryFn: getOrganizationProfile,
  });
  const updateOrgProfile = useMutation({
    mutationFn: updateOrganizationProfile,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["organization", "profile"] });
      void qc.invalidateQueries({ queryKey: ["admin", "document-templates"] });
    },
  });
  const [companyNameDraft, setCompanyNameDraft] = useState<string>("");
  const [companyNameLoaded, setCompanyNameLoaded] = useState(false);
  useEffect(() => {
    if (orgProfileQuery.data && !companyNameLoaded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setCompanyNameDraft(orgProfileQuery.data.name);
      setCompanyNameLoaded(true);
    }
  }, [orgProfileQuery.data, companyNameLoaded]);

  const saveMutation = useMutation({
    // validDocType is non-null for every render that can reach the Save
    // control — the bail-out below returns before that UI exists — but this
    // hook is now created unconditionally, so reject rather than assert.
    mutationFn: (payload: FormState) => {
      if (!validDocType) return Promise.reject(new Error("Unknown template type"));
      return updateTemplate(validDocType, payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "document-templates"] });
    },
  });

  // Every hook above runs unconditionally; this bail-out is safe here.
  if (!validDocType) {
    return (
      <div className="space-y-4 p-6">
        <p className="text-sm text-rose-600">Unknown template type: {docType}</p>
        <Link to="/settings/document-templates" className={cn(buttonVariants({ variant: "ghost" }), "gap-2")}>
          <ArrowLeft className="h-4 w-4" />
          Back to templates
        </Link>
      </div>
    );
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }
  function setHeaderField(
    key: keyof FormState["headerFields"],
    value: boolean,
  ) {
    setForm((prev) =>
      prev
        ? { ...prev, headerFields: { ...prev.headerFields, [key]: value } }
        : prev,
    );
  }

  function handleSave() {
    if (!form) return;
    const normalizedAddressLines = form.orgAddressLines
      .map((s) => s.trim())
      .filter((s, i, arr) => s.length > 0 || arr.slice(i + 1).some((x) => x.trim().length > 0));
    saveMutation.mutate({ ...form, orgAddressLines: normalizedAddressLines });
    // Persist the company-name draft alongside the template save when it
    // diverges from what's on disk. Same Organization.name the Organisation
    // Profile page edits — single source of truth for every document.
    const persistedName = orgProfileQuery.data?.name ?? "";
    if (companyNameDraft.trim() && companyNameDraft.trim() !== persistedName.trim()) {
      updateOrgProfile.mutate({ name: companyNameDraft.trim() });
    }
  }

  if (isLoading || !form || !template) {
    return (
      <div className="space-y-6 p-1">
        <div className="h-12 animate-pulse rounded-lg bg-muted/40" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-muted/40" />
            ))}
          </div>
          <div className="h-[520px] animate-pulse rounded-2xl bg-muted/40" />
        </div>
      </div>
    );
  }

  const Icon = DOC_TYPE_ICON[validDocType];
  const refCodePreview = previewReferenceCode(
    form.refPrefix || "PREFIX",
    form.refSeparator,
    form.refPadding,
    form.refIncludeYear,
  );

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/settings/document-templates"
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Document Templates
          </Link>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            <Icon className="h-7 w-7 text-primary" />
            {DOC_TYPE_LABEL[validDocType]}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Edit the letterhead and reference number format. The preview on the right updates as you type.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveMutation.isError && (
            <span className="text-xs text-rose-600">Save failed — try again.</span>
          )}
          {saveMutation.isSuccess && (
            <span className="text-xs text-emerald-600">Saved.</span>
          )}
          <Button
            type="button"
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {/* 2-pane layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]">
        {/* LEFT: form */}
        <div className="space-y-5">
          <Section label="Document">
            {validDocType === "rental_commission_claim" ? (
              // Title is fixed for this docType — managed centrally so the
              // wrap point ("Rental Commission" / "Claim Form") is consistent
              // for every org. See service.ts titleOverrides.
              <Callout variant="info" title="Title is fixed">
                The title for this document is locked to <strong>Rental Commission Claim Form</strong> and isn&apos;t editable. The letterhead and downloaded PDF always show this exact title.
              </Callout>
            ) : validDocType === "owner_statement" ? (
              // Title is fixed for owner_statement — the same letterhead is
              // reused for both the monthly owner statement (portrait) and the
              // per-expense receipt (landscape). The backend sets the title on
              // render; editing it here has no effect. See service.ts titleOverrides.
              <Callout variant="info" title="Title is fixed">
                The title for this document is set automatically by the system (e.g. <strong>Owner Payout Report</strong> or <strong>Invoice</strong>) and isn&apos;t editable here. The letterhead logo, organisation details, and contact info below apply to both.
              </Callout>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor="doc-title" className="text-xs font-medium text-muted-foreground">
                  Title (shown in top-right of the letterhead)
                </label>
                <Input
                  id="doc-title"
                  aria-label="title"
                  value={form.title}
                  onChange={(e) => setField("title", e.target.value)}
                />
              </div>
            )}
          </Section>

          {validDocType === "tenancy_agreement" && (
            <Section
              label="Master agreement wording"
              description="This is the company master template. A separate editable draft is created for every tenancy, so special terms never change the master or another tenant's agreement."
            >
              <textarea
                aria-label="Tenancy agreement master template"
                value={form.bodyTemplate ?? ""}
                onChange={(e) => setField("bodyTemplate", e.target.value || null)}
                className="min-h-[520px] w-full resize-y rounded-xl border border-input bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground outline-none focus:ring-2 focus:ring-[#C9A35C]"
                placeholder="Leave blank to use KAEN's built-in tenancy agreement template."
              />
              <div className="rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                Available placeholders: {"{{tenant_name}}"}, {"{{tenant_id}}"}, {"{{owner_name}}"}, {"{{owner_id}}"}, {"{{property_name}}"}, {"{{unit_number}}"}, {"{{property_address}}"}, {"{{start_date}}"}, {"{{end_date}}"}, {"{{monthly_rent}}"}, {"{{rental_deposit}}"}, {"{{tenancy_code}}"}.
              </div>
            </Section>
          )}

          <Section
            label="Reference Number"
            description="The auto-generated reference printed on every issued document."
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_auto]">
              <div className="space-y-1.5">
                <label htmlFor="refPrefix" className="text-xs font-medium text-muted-foreground">
                  Prefix
                </label>
                <Input
                  id="refPrefix"
                  aria-label="Prefix"
                  value={form.refPrefix}
                  onChange={(e) => setField("refPrefix", e.target.value)}
                  placeholder="e.g. KAEN RES"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="refPadding" className="text-xs font-medium text-muted-foreground">
                  Padding (digits)
                </label>
                <Input
                  id="refPadding"
                  type="number"
                  aria-label="Padding (digits)"
                  value={form.refPadding}
                  onChange={(e) =>
                    setField("refPadding", Math.max(1, parseInt(e.target.value, 10) || 1))
                  }
                />
              </div>
              <label className="flex cursor-pointer items-end gap-2 pb-1.5 text-sm text-foreground/85">
                <Checkbox
                  checked={form.refIncludeYear}
                  onCheckedChange={(v) => setField("refIncludeYear", Boolean(v))}
                  aria-label="Include year"
                />
                <span>Include year</span>
              </label>
            </div>
            <div className="rounded-md border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Sample next code: </span>
              <span className="font-mono font-semibold text-foreground">{refCodePreview}</span>
            </div>
          </Section>

          <Section
            label="Letterhead — Identity"
            description="Toggle off any line you don't want printed on the document."
          >
            <div className="space-y-1.5">
              <label htmlFor="companyName" className="text-xs font-medium text-muted-foreground">
                Company name (printed in bold at the top of every document)
              </label>
              <Input
                id="companyName"
                aria-label="Company name"
                value={COMPANY.legalName}
                readOnly
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Fixed legal entity name used on every formal document.
              </p>
            </div>
            <FieldRow
              toggleLabel="Reg No"
              toggleChecked={form.headerFields.showRegNo}
              onToggle={(v) => setHeaderField("showRegNo", v)}
              inputAriaLabel="Reg No"
              inputValue={form.orgRegNo ?? ""}
              onInputChange={(v) => setField("orgRegNo", v || null)}
              placeholder="e.g. 1610050-V"
            />
            <FieldRow
              toggleLabel="Sales Tax ID"
              toggleChecked={form.headerFields.showSalesTaxId}
              onToggle={(v) => setHeaderField("showSalesTaxId", v)}
              inputAriaLabel="Sales Tax ID"
              inputValue={form.orgSalesTaxId ?? ""}
              onInputChange={(v) => setField("orgSalesTaxId", v || null)}
              placeholder="e.g. w10-2506-32000179"
            />
            <FieldRow
              toggleLabel="Service Tax ID"
              toggleChecked={form.headerFields.showServiceTaxId}
              onToggle={(v) => setHeaderField("showServiceTaxId", v)}
              inputAriaLabel="Service Tax ID"
              inputValue={form.orgServiceTaxId ?? ""}
              onInputChange={(v) => setField("orgServiceTaxId", v || null)}
              placeholder="e.g. W10-2506-32000179"
            />
          </Section>

          <Section label="Letterhead — Contact">
            <FieldRow
              toggleLabel="Email"
              toggleChecked={form.headerFields.showEmail}
              onToggle={(v) => setHeaderField("showEmail", v)}
              inputAriaLabel="Email"
              inputValue={form.orgEmail ?? ""}
              onInputChange={(v) => setField("orgEmail", v || null)}
              placeholder="kaenproperties@gmail.com"
            />
            <FieldRow
              toggleLabel="Contact"
              toggleChecked={form.headerFields.showContact}
              onToggle={(v) => setHeaderField("showContact", v)}
              inputAriaLabel="Contact"
              inputValue={form.orgContact ?? ""}
              onInputChange={(v) => setField("orgContact", v || null)}
              placeholder="+601136111763"
            />
          </Section>

          <Section
            label="Letterhead — Address"
            description="Up to 4 lines. Empty trailing lines are dropped when saving."
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground/85">
              <Checkbox
                checked={form.headerFields.showAddress}
                onCheckedChange={(v) => setHeaderField("showAddress", Boolean(v))}
                aria-label="Show address"
              />
              <span>Show address block</span>
            </label>
            <div className="grid grid-cols-1 gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Input
                  key={`addr-${i}`}
                  placeholder={`Address line ${i + 1}`}
                  aria-label={`Address line ${i + 1}`}
                  value={form.orgAddressLines[i] ?? ""}
                  onChange={(e) => {
                    const next = [...form.orgAddressLines];
                    next[i] = e.target.value;
                    setField("orgAddressLines", next);
                  }}
                  disabled={!form.headerFields.showAddress}
                  className={!form.headerFields.showAddress ? "opacity-50" : undefined}
                />
              ))}
            </div>
          </Section>

          <Section
            label="Letterhead — Logo"
            description="The logo prints in the top-left of the letterhead. Leave blank to use the bundled KAEN Properties default."
          >
            <LogoUploader
              docType={validDocType}
              currentLogoUrl={template.logoUrl}
              currentLogoKey={form.logoKey}
              onChange={(key) => setField("logoKey", key)}
            />
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground/85">
              <Checkbox
                checked={form.headerFields.showLogo}
                onCheckedChange={(v) => setHeaderField("showLogo", Boolean(v))}
                aria-label="Show logo"
              />
              <span>Show logo on letterhead</span>
            </label>
          </Section>
        </div>

        {/* RIGHT: sticky live preview */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-border/50 bg-background/40 p-5 backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <LayoutTemplate className="h-4 w-4 text-[#D4AF37]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
                  Live preview
                </span>
              </div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                A4 portrait
              </span>
            </div>
            <LetterheadPreview
              template={form}
              orgName={COMPANY.legalName}
              logoUrl={template.logoUrl}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              The legal company name is fixed. The logo comes from your global
              Organisation Settings.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
