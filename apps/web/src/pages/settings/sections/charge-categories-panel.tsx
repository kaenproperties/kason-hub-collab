/**
 * Charge Categories panel — the ChargeCategory registry, rendered INSIDE
 * Settings → Billing Config (billing-config-section.tsx) rather than as its own
 * settings section. This is the single source for the Category dropdown on the
 * bills-grid expense drawer (tenant + owner sheets), the charge form, and the
 * recurring-charge editor.
 *
 * Extracted from the former standalone charge-categories-section.tsx page so the
 * table has exactly one implementation; that route now redirects here.
 *
 * WHAT "REMOVE" MEANS (deliberate, decided 2026-08-03): removal is a DEACTIVATE,
 * never a hard delete. Charge.categoryId, GridExpense.chargeCategoryId,
 * BillingDocumentLine.categoryId and RecurringCharge.categoryId all reference this
 * row with onDelete: SetNull — a real delete would silently strip the classification
 * off charges and already-issued invoice lines, changing the bills-grid P&L split and
 * owner-statement bucketing for CLOSED months with no error anywhere. Deactivating
 * takes the row out of every picker while history keeps its classification, so the
 * button reads "Remove" and the confirm dialog says exactly that.
 *
 * Manager-or-above may add/edit/remove (API: requireRole("manager") on POST /,
 * PATCH /:id and POST /:id/deactivate). Editors get a read-only table.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import {
  BEARER_CATEGORY_FAMILY,
  OWNER_LEDGER_CATEGORIES,
  type CategoryFamily,
  type ChargeCategoryDto,
  type DocumentSeriesDto,
  type OwnerLedgerCategory,
  type ProfitExpense,
} from "@kason/shared";
import {
  useChargeCategories,
  useCreateChargeCategory,
  useDeactivateChargeCategory,
  useDocumentSeries,
  useUpdateChargeCategory,
} from "@/api/charge-categories";
import { Surface } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import { usePermission } from "@/components/permission-gate";
import { formatDate } from "@/components/format";

// ─── Side (bearer) vocabulary ────────────────────────────────────────────────

type CategorySide = keyof typeof BEARER_CATEGORY_FAMILY; // "tenant" | "owner"

const SIDE_LABEL: Record<CategorySide, string> = {
  tenant: "Tenant",
  owner: "Owner",
};

/**
 * Display label for a category's family. `pay_back_landlord` has no bearer side —
 * it is the deposit/rent debit-note family (DEP/RB), maintained by seeds only — so it
 * renders as its own chip rather than being forced into Tenant/Owner.
 */
function sideLabelOf(family: CategoryFamily): string {
  if (family === BEARER_CATEGORY_FAMILY.tenant) return SIDE_LABEL.tenant;
  if (family === BEARER_CATEGORY_FAMILY.owner) return SIDE_LABEL.owner;
  return "Deposits / rent";
}

/** Series each side's new categories are issued on, matching every seeded row of that family. */
const SIDE_SERIES_CODE: Record<CategorySide, string> = {
  tenant: "IVTEN",
  owner: "IVOWN",
};

/** name → machine code: "Aircond service (owner)" → "aircond_service_owner". */
function slugifyCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function CategoryRow({
  category,
  seriesOptions,
  canWrite,
}: {
  category: ChargeCategoryDto;
  seriesOptions: DocumentSeriesDto[];
  canWrite: boolean;
}) {
  const update = useUpdateChargeCategory();
  const deactivate = useDeactivateChargeCategory();
  const [profitExpense, setProfitExpense] = useState<ProfitExpense | "">(category.profitExpense ?? "");
  const [seriesId, setSeriesId] = useState(category.seriesId);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dirty = profitExpense !== (category.profitExpense ?? "") || seriesId !== category.seriesId;

  function save() {
    update.mutate(
      {
        id: category.id,
        profitExpense: profitExpense === "" ? null : profitExpense,
        // Only send seriesId when it actually changed — reassigning the series
        // is a billing-numbering change; leave it untouched on a pure P&L edit.
        ...(seriesId !== category.seriesId ? { seriesId } : {}),
        expectedUpdatedAt: category.updatedAt,
      },
      {
        onSuccess: () => toast.success(`${category.name} updated`),
        // 409 stale token: the hook's onSuccess-invalidation refetches the list
        // on the NEXT success; on error we surface the message and the user
        // retries against the refreshed row.
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to update ${category.name}`),
      },
    );
  }

  function removeCategory() {
    deactivate.mutate(category.id, {
      onSuccess: () => toast.success(`${category.name} removed`),
      // Server-side 409 CATEGORY_IS_SYSTEM lands here if a built-in slips past the
      // disabled button (e.g. a stale list) — surfaced, never swallowed.
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : `Failed to remove ${category.name}`),
    });
  }

  return (
    <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">
      {/* Category name + code */}
      <td className="px-4 py-3.5">
        <p className="font-medium text-foreground">{category.name}</p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{category.code}</p>
      </td>
      {/* Side — which expense sheet offers this category */}
      <td className="w-28 px-4 py-3.5">
        <span className="text-sm text-foreground">{sideLabelOf(category.family)}</span>
      </td>
      {/* Document Series — editable (billing numbering) */}
      <td className="w-40 px-4 py-3.5">
        <SelectInput
          aria-label={`${category.name} document series`}
          value={seriesId}
          disabled={!canWrite}
          onChange={(e) => setSeriesId(e.target.value)}
        >
          {/* Fallback so the current series always shows even before the list loads */}
          {seriesOptions.length === 0 && <option value={seriesId}>{category.seriesCode}</option>}
          {seriesOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </SelectInput>
      </td>
      {/* Profit / Expense — editable */}
      <td className="w-44 px-4 py-3.5">
        <SelectInput
          aria-label={`${category.name} profit or expense`}
          value={profitExpense}
          disabled={!canWrite}
          onChange={(e) => setProfitExpense(e.target.value as ProfitExpense | "")}
        >
          <option value="">—</option>
          <option value="profit">Profit</option>
          <option value="expense">Expense</option>
        </SelectInput>
      </td>
      {/* Status */}
      <td className="w-32 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {category.active ? <Badge variant="emerald">Active</Badge> : <Badge variant="rose">Removed</Badge>}
          {category.isSystem && <Badge variant="outline">Built-in</Badge>}
        </div>
      </td>
      {/* Last Updated */}
      <td className="w-32 px-4 py-3.5 text-xs text-muted-foreground">
        {category.updatedAt ? formatDate(category.updatedAt) : "-"}
      </td>
      {/* Actions */}
      <td className="w-52 px-4 py-3.5 text-right">
        {canWrite ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              // Built-in (isSystem) categories can never be removed: auto-post flows
              // resolve them BY CODE, so taking one out of circulation breaks rent /
              // management-fee / utility posting. Server enforces it too (409
              // CATEGORY_IS_SYSTEM) — this is the matching client-side gate.
              disabled={category.isSystem || !category.active || deactivate.isPending}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
            <Button type="button" size="sm" disabled={!dirty || update.isPending} onClick={save}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}

        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove “{category.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                It stops appearing in the Category dropdown on expense drawers, the charge form and
                recurring charges. Charges and invoices already classified under it keep that
                classification — nothing on a past bill or owner statement changes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction
                render={(props) => (
                  <Button
                    variant="destructive"
                    {...props}
                    onClick={(e) => {
                      removeCategory();
                      props.onClick?.(e);
                    }}
                    disabled={deactivate.isPending}
                  >
                    {deactivate.isPending ? "Removing…" : "Remove category"}
                  </Button>
                )}
              />
              <AlertDialogCancel
                render={(props) => (
                  <Button
                    variant="ghost"
                    {...props}
                    onClick={(e) => {
                      setConfirmRemove(false);
                      props.onClick?.(e);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              />
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}

// ─── Add-category drawer ─────────────────────────────────────────────────────

type AddFormState = {
  side: CategorySide;
  name: string;
  code: string;
  /** True until the user hand-edits `code`; while true, code tracks the name. */
  codeAuto: boolean;
  profitExpense: ProfitExpense | "";
  /** "" = unset → the API stores null and the owner statement buckets it as Other expense. */
  ledgerCategory: OwnerLedgerCategory | "";
  defaultSstRate: string;
};

const EMPTY_ADD_FORM: AddFormState = {
  side: "owner",
  name: "",
  code: "",
  codeAuto: true,
  profitExpense: "expense",
  ledgerCategory: "",
  defaultSstRate: "0",
};

function AddCategorySheet({
  open,
  onOpenChange,
  seriesOptions,
  existing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  seriesOptions: DocumentSeriesDto[];
  existing: ChargeCategoryDto[];
}) {
  const create = useCreateChargeCategory();
  const [form, setForm] = useState<AddFormState>(EMPTY_ADD_FORM);
  const [error, setError] = useState<string | null>(null);

  function patch(next: Partial<AddFormState>) {
    setForm((f) => {
      const merged = { ...f, ...next };
      // Code mirrors the name until the user takes it over.
      if (next.name !== undefined && merged.codeAuto) merged.code = slugifyCode(next.name);
      return merged;
    });
    setError(null);
  }

  const series = seriesOptions.find((s) => s.code === SIDE_SERIES_CODE[form.side]) ?? null;

  function submit() {
    const name = form.name.trim();
    const code = (form.codeAuto ? slugifyCode(name) : form.code.trim()).slice(0, 64);
    if (name.length < 2) return setError("Enter a category name (at least 2 characters).");
    if (!/^[a-z0-9_]{2,64}$/.test(code)) {
      return setError("Code must be 2–64 characters, lowercase letters, numbers and underscores only.");
    }
    if (existing.some((c) => c.code === code)) return setError(`Code “${code}” is already in use.`);
    if (existing.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      return setError(`A category named “${name}” already exists.`);
    }
    // The series row is what makes a category issuable. Seeds create IVTEN/IVOWN for
    // every org, but fail loudly rather than POSTing a body with no seriesId.
    if (!series) {
      return setError(
        `Document series ${SIDE_SERIES_CODE[form.side]} is missing for this organisation — it is needed to issue ${SIDE_LABEL[form.side].toLowerCase()} documents.`,
      );
    }
    // sortOrder 950: after every seeded row (max 900, "Legacy / other") so admin-created
    // categories collect at the bottom of every picker instead of interleaving with the
    // built-ins the seeds deliberately ordered.
    create.mutate(
      {
        code,
        name,
        family: BEARER_CATEGORY_FAMILY[form.side],
        // invoice for both sides: IVTEN (tenant) and IVOWN (owner) are both invoice
        // series. debit_note is reserved for the seeded deposit/rent family.
        docType: "invoice",
        seriesId: series.id,
        defaultSstRate: form.defaultSstRate.trim() === "" ? "0" : form.defaultSstRate.trim(),
        ledgerCategory: form.side === "owner" && form.ledgerCategory ? form.ledgerCategory : null,
        profitExpense: form.profitExpense === "" ? null : form.profitExpense,
        sortOrder: 950,
      },
      {
        onSuccess: () => {
          toast.success(`${name} added`);
          setForm(EMPTY_ADD_FORM);
          onOpenChange(false);
        },
        onError: (err) => setError(err instanceof Error ? err.message : "Failed to add category."),
      },
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setForm(EMPTY_ADD_FORM);
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add charge category</SheetTitle>
          <SheetDescription>
            A new category appears in the Category dropdown on its side&apos;s expense drawer, the
            charge form and recurring charges.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="space-y-4">
            <Field
              label="Side"
              hint="Which expense sheet offers it. Owner categories are issued on IVOWN, tenant on IVTEN."
            >
              <SelectInput
                aria-label="Category side"
                value={form.side}
                onChange={(e) => patch({ side: e.target.value as CategorySide })}
              >
                <option value="owner">Owner — billed to / deducted from the owner</option>
                <option value="tenant">Tenant — billed to the tenant</option>
              </SelectInput>
            </Field>

            <Field label="Name" hint="Shown in every dropdown, e.g. “Pest control (owner)”.">
              <TextInput
                aria-label="Category name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. Pest control (owner)"
              />
            </Field>

            <Field
              label="Code"
              hint="Stable machine key — auto-filled from the name and permanent once saved (the name stays renameable)."
            >
              <TextInput
                aria-label="Category code"
                value={form.code}
                onChange={(e) => patch({ code: e.target.value, codeAuto: false })}
                placeholder="pest_control_owner"
                className="font-mono"
              />
            </Field>

            <Field label="Profit / Expense" hint="Which side of the bills-grid P&L this rolls into.">
              <SelectInput
                aria-label="Profit or expense"
                value={form.profitExpense}
                onChange={(e) => patch({ profitExpense: e.target.value as ProfitExpense | "" })}
              >
                <option value="expense">Expense</option>
                <option value="profit">Profit</option>
                <option value="">— not classified</option>
              </SelectInput>
            </Field>

            {form.side === "owner" && (
              <Field
                label="Owner statement bucket"
                hint="Which line of the owner statement this groups under. Leave unset to fall into Other expense."
              >
                <SelectInput
                  aria-label="Owner statement bucket"
                  value={form.ledgerCategory}
                  onChange={(e) => patch({ ledgerCategory: e.target.value as OwnerLedgerCategory | "" })}
                >
                  <option value="">Other expense (default)</option>
                  {OWNER_LEDGER_CATEGORIES.map((lc) => (
                    <option key={lc} value={lc}>
                      {lc.replace(/_/g, " ")}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            )}

            <Field label="Default SST rate (%)" hint="Leave 0 for a pass-through cost with no service tax.">
              <TextInput
                type="text"
                inputMode="decimal"
                aria-label="Default SST rate"
                value={form.defaultSstRate}
                onChange={(e) => patch({ defaultSstRate: e.target.value })}
                placeholder="0"
              />
            </Field>

            {error && <Callout variant="danger">{error}</Callout>}
          </div>
        </SheetBody>
        <SheetFooter>
          <Button type="button" variant="gold" disabled={create.isPending} onClick={submit}>
            {create.isPending ? "Adding…" : "Add category"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ChargeCategoriesPanel() {
  const canWrite = usePermission("settings.manage");
  const { data, isLoading, isError } = useChargeCategories({ includeInactive: true });
  const { data: seriesData } = useDocumentSeries();
  const [addOpen, setAddOpen] = useState(false);

  const items = data?.items ?? [];
  const seriesOptions = seriesData?.items ?? [];
  const activeCount = items.filter((c) => c.active).length;
  const removedCount = items.length - activeCount;

  return (
    <Surface
      title="Charge categories"
      description="The Category dropdown on expense drawers, the charge form and recurring charges reads this list."
      actions={
        canWrite ? (
          <Button variant="gold" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add category
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg border border-border/30 bg-muted/50" />
      ) : isError ? (
        <Callout variant="danger" title="Couldn't load charge categories">
          Failed to load charge categories. Please refresh.
        </Callout>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">Total: {items.length}</Badge>
            <Badge variant="emerald">Active: {activeCount}</Badge>
            {removedCount > 0 && <Badge variant="rose">Removed: {removedCount}</Badge>}
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Category</th>
                  <th className="w-28 px-4 py-3 font-semibold">Side</th>
                  <th className="w-40 px-4 py-3 font-semibold">Series</th>
                  <th className="w-44 px-4 py-3 font-semibold">Profit / Expense</th>
                  <th className="w-32 px-4 py-3 font-semibold">Status</th>
                  <th className="w-32 px-4 py-3 font-semibold">Last Updated</th>
                  <th className="w-52 px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                      No charge categories.
                    </td>
                  </tr>
                ) : (
                  items.map((c) => (
                    <CategoryRow key={c.id} category={c} seriesOptions={seriesOptions} canWrite={canWrite} />
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Removing a category takes it out of every dropdown; charges and invoices already
            classified under it keep that classification. Built-in categories can be reclassified
            but never removed — auto-post flows resolve them by code. Changing the Series affects
            the numbering of documents issued <em>after</em> the change; existing numbers never
            change.
          </p>
        </div>
      )}

      {canWrite && (
        <AddCategorySheet
          open={addOpen}
          onOpenChange={setAddOpen}
          seriesOptions={seriesOptions}
          existing={items}
        />
      )}
    </Surface>
  );
}
