/**
 * Admin Document Templates list page.
 *
 * One card per doc type. Clicking a card navigates to the dedicated edit page
 * at /admin/document-templates/:docType which has a 2-pane layout with a live
 * letterhead preview.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { LayoutTemplate, FileText, ScrollText, Hammer, Receipt, Landmark, Banknote } from "lucide-react";
import {
  listTemplates,
  type DocumentTemplate,
  type DocType,
} from "@/api/document-templates";
import { PageHeader } from "@/components/ui";
import { GlowCard } from "@/components/ui/glow-card";

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

const DOC_TYPE_DESCRIPTION: Record<DocType, string> = {
  reservation_form: "Letterhead for unit reservation agreements",
  rental_commission_claim: "Letterhead for agent commission claims",
  invoice: "Letterhead for tenant invoices and charges",
  renovation_claim: "Letterhead for renovation project claims",
  owner_statement: "Letterhead for owner monthly payout reports and expense deductions",
  credit_note: "Letterhead for credit notes reversing posted documents",
  refund_note: "Letterhead for refund notes recording money returned",
  tenancy_agreement: "Editable master wording used to generate each tenancy agreement",
  property_management_agreement: "Letterhead for editable owner property-management agreements",
};

type GlowColor = "purple" | "blue" | "green" | "orange" | "gold" | "red";

const DOC_TYPE_GLOW: Record<DocType, GlowColor> = {
  reservation_form: "blue",
  rental_commission_claim: "gold",
  invoice: "green",
  renovation_claim: "orange",
  owner_statement: "purple",
  credit_note: "red",
  refund_note: "gold",
  tenancy_agreement: "blue",
  property_management_agreement: "gold",
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

const ICON_BG: Record<GlowColor, string> = {
  purple: "bg-purple-500/10",
  blue: "bg-blue-500/10",
  green: "bg-green-500/10",
  orange: "bg-orange-500/10",
  gold: "bg-amber-500/10",
  red: "bg-red-500/10",
};

const ICON_FG: Record<GlowColor, string> = {
  purple: "text-purple-600 dark:text-purple-400",
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-green-600 dark:text-green-400",
  orange: "text-orange-600 dark:text-orange-400",
  gold: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

function TemplateCard({ template }: { template: DocumentTemplate }) {
  // Defensive fallbacks: if the API ever hands us a docType this page wasn't
  // built for (e.g. a new backend template type), degrade to a generic icon
  // instead of rendering `undefined` and white-screening the whole page.
  const color = DOC_TYPE_GLOW[template.docType] ?? "purple";
  const Icon = DOC_TYPE_ICON[template.docType] ?? FileText;

  return (
    <Link
      to={`/settings/document-templates/${template.docType}`}
      className="w-full text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
    >
      <GlowCard
        glowColor={color}
        className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 transition-all hover:bg-background/60 hover:border-border/80 h-full"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              {DOC_TYPE_DESCRIPTION[template.docType]}
            </p>
            <p className="text-lg font-semibold text-foreground leading-tight">
              {DOC_TYPE_LABEL[template.docType]}
            </p>
            <div className="text-xs text-muted-foreground">
              {template.refPrefix ? (
                <span>
                  Prefix:{" "}
                  <span className="font-mono text-foreground/80">{template.refPrefix}</span>
                </span>
              ) : (
                <em className="not-italic text-muted-foreground/60">Prefix not configured</em>
              )}
            </div>
          </div>
          <div className={`p-3 rounded-xl ${ICON_BG[color]} shrink-0`}>
            <Icon className={`h-6 w-6 ${ICON_FG[color]}`} />
          </div>
        </div>
      </GlowCard>
    </Link>
  );
}

function TemplateCardSkeleton() {
  return (
    <div className="h-[120px] rounded-2xl bg-muted/50 animate-pulse border border-border/30" />
  );
}

export default function DocumentTemplatesPage() {
  const { data: templates = [], isLoading, isError } = useQuery({
    queryKey: ["admin", "document-templates"],
    queryFn: listTemplates,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Document Templates"
        icon={LayoutTemplate}
        description="Configure the letterhead and reference number format used for printed documents per type."
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <TemplateCardSkeleton key={i} />
          ))}
        </div>
      ) : isError ? (
        <p className="text-sm text-rose-600">Failed to load document templates. Please refresh.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/*
            The backend list endpoint returns a row for every backend doc type
            (incl. `owner_statement`, added by M6 owner-billing) and auto-seeds
            missing ones. This page is only designed for the types it has a card
            layout for, so hide anything it doesn't know how to render.
          */}
          {templates
            .filter((tpl) => tpl.docType in DOC_TYPE_ICON)
            .map((tpl) => (
              <TemplateCard key={tpl.docType} template={tpl} />
            ))}
        </div>
      )}
    </div>
  );
}
