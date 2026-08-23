import { useState, useEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ActionButton, Field, TextInput } from "@/components/form-ui";
import { PropertyTypeSelect } from "@/components/property-type-select";
import { useActivePropertyTypes } from "@/hooks/use-property-types";

// Slim shape the trigger surface (properties-table) is guaranteed to have.
// Keeping it small means callers don't need to fetch the full Property before
// opening — we hydrate inside the dialog from GET /inventory/properties/:id.
export type PropertyRowData = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
};

// Mirrors GET /inventory/properties/:id (see findPropertyDetail in the
// inventory repository). Local copy so we don't pull server types into the
// SPA bundle.
type FetchedPropertyDetail = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  status: string;
};

type UpdatePropertyBody = {
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  status?: "active" | "inactive" | "pending";
};

export function EditPropertyDialog({
  trigger,
  property,
}: {
  trigger: ReactNode;
  property: PropertyRowData;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  // Fetch the full Property record on open so every field can be pre-populated.
  // Without this, address fields show only `placeholder=` text and submitting
  // unchanged silently sends `undefined` for those columns — operators see the
  // placeholder and assume it's the current value (data-loss footgun).
  const detailQuery = useQuery({
    queryKey: ["inventory", "property", property.id, "edit-form"],
    queryFn: () =>
      apiFetch<{ data: FetchedPropertyDetail }>(`/inventory/properties/${property.id}`),
    enabled: open,
    staleTime: 0,
  });

  const detail = detailQuery.data?.data;

  // Gated on `open` — this dialog is mounted persistently-but-closed (one
  // per property row), so an unconditional fetch here would fire once per
  // row on every properties-list render.
  const { data: propertyTypes = [] } = useActivePropertyTypes({ enabled: open });
  const [propertyType, setPropertyType] = useState("");
  // Seed only on the FIRST detail arrival — this dialog instance is bound to
  // one fixed property (mounted per-row), so `detail` only changes on a
  // refetch of the same property. Re-seeding on every refetch would clobber
  // an admin's unsaved dropdown pick if a concurrent edit triggers a
  // background refetch while the dialog is open (the sibling uncontrolled
  // fields don't have this problem — only this controlled field does).
  const seededPropertyTypeRef = useRef(false);
  useEffect(() => {
    if (detail && !seededPropertyTypeRef.current) {
      setPropertyType(detail.propertyType);
      seededPropertyTypeRef.current = true;
    }
  }, [detail]);

  const mutation = useMutation({
    mutationFn: (body: UpdatePropertyBody) =>
      apiFetch(`/inventory/properties/${property.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast.success("Property updated.");
      setOpen(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update property.");
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!propertyType) return;
    const fd = new FormData(e.currentTarget);
    // We send each field as the form value (NOT `|| undefined`) for required
    // fields — coercing an empty addressLine1 to undefined would silently
    // skip the column on the PUT, and the schema enforces min(1) anyway.
    const addressLine2 = String(fd.get("addressLine2") ?? "");
    const state = String(fd.get("state") ?? "");
    const postalCode = String(fd.get("postalCode") ?? "");
    const status = String(fd.get("status") ?? "");
    const body: UpdatePropertyBody = {
      name: String(fd.get("name") ?? ""),
      propertyCode: String(fd.get("propertyCode") ?? ""),
      propertyType,
      addressLine1: String(fd.get("addressLine1") ?? ""),
      // Optional fields — only include when the operator typed something so
      // we don't write empty strings into nullable columns.
      ...(addressLine2 ? { addressLine2 } : {}),
      city: String(fd.get("city") ?? ""),
      ...(state ? { state } : {}),
      ...(postalCode ? { postalCode } : {}),
      country: String(fd.get("country") ?? ""),
      ...(status === "active" || status === "inactive" || status === "pending"
        ? { status }
        : {}),
    };
    mutation.mutate(body);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit property · {property.name}</DialogTitle>
          <DialogDescription>
            Update the core asset profile. Unit relationships are preserved.
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="space-y-3 py-6">
            <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
            <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
            <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
            <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
            <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
          </div>
        ) : detailQuery.isError || !detail ? (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-400">
            Failed to load property details. Close and reopen to retry.
          </div>
        ) : (
          // `key` on the form forces React to remount inputs once the detail
          // arrives — without this, defaultValue would still bind to the
          // first render's empty values. Re-mounting on detail.id makes the
          // dialog robust to opening, closing, and re-opening on a different
          // property without stale-state leakage.
          <form key={detail.id} onSubmit={onSubmit} className="grid gap-4">
            <Field label="Property name">
              <TextInput name="name" required defaultValue={detail.name} />
            </Field>
            <Field label="Property Short Form">
              <TextInput name="propertyCode" required defaultValue={detail.propertyCode} />
            </Field>
            <Field label="Property type">
              <PropertyTypeSelect
                value={propertyType}
                onChange={setPropertyType}
                options={propertyTypes}
                className="w-full"
              />
            </Field>
            <Field label="Address line 1">
              <TextInput
                name="addressLine1"
                required
                defaultValue={detail.addressLine1}
                placeholder="Jalan Ampang 18"
              />
            </Field>
            <Field label="Address line 2">
              <TextInput
                name="addressLine2"
                defaultValue={detail.addressLine2 ?? ""}
                placeholder="Block A, Level 5 (optional)"
              />
            </Field>
            <Field label="City">
              <TextInput
                name="city"
                required
                defaultValue={detail.city}
                placeholder="Kuala Lumpur"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="State">
                <TextInput
                  name="state"
                  defaultValue={detail.state ?? ""}
                  placeholder="Selangor"
                />
              </Field>
              <Field label="Postal code">
                <TextInput
                  name="postalCode"
                  defaultValue={detail.postalCode ?? ""}
                  placeholder="50450"
                />
              </Field>
            </div>
            <Field label="Country">
              <TextInput
                name="country"
                required
                defaultValue={detail.country}
                placeholder="Malaysia"
              />
            </Field>

            <Field label="Status">
              <select
                name="status"
                defaultValue={detail.status}
                required
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="active">Active</option>
                <option value="pending">Pending review</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>

            <DialogFooter>
              <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
                {mutation.isPending ? "Updating…" : "Update property"}
              </ActionButton>
              <ActionButton
                type="button"
                variant="secondary"
                onClick={() => setOpen(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </ActionButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
