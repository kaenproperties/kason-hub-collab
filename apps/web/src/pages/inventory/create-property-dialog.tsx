import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

type CreatePropertyBody = {
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
};

export function CreatePropertyDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: propertyTypes = [] } = useActivePropertyTypes();
  const [propertyType, setPropertyType] = useState("");

  const mutation = useMutation({
    mutationFn: (body: CreatePropertyBody) =>
      apiFetch("/inventory/properties", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast.success("Property created.");
      setOpen(false);
      // Reset so a reopened dialog starts at the placeholder like every
      // other (FormData-backed) field — otherwise this controlled field
      // alone pre-selects the last-created type while the rest are blank.
      setPropertyType("");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to create property.");
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!propertyType) return;
    const fd = new FormData(e.currentTarget);
    const body: CreatePropertyBody = {
      name: String(fd.get("name") ?? ""),
      propertyCode: String(fd.get("propertyCode") ?? ""),
      propertyType,
      addressLine1: String(fd.get("addressLine1") ?? ""),
      city: String(fd.get("city") ?? ""),
      state: String(fd.get("state") ?? "") || undefined,
      postalCode: String(fd.get("postalCode") ?? "") || undefined,
      country: String(fd.get("country") ?? "Malaysia"),
    };
    mutation.mutate(body);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create property</DialogTitle>
          <DialogDescription>
            Register a new asset before units are attached.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <Field label="Property name">
            <TextInput name="name" required placeholder="Northshore Residence" />
          </Field>
          <Field label="Property Short Form">
            <TextInput name="propertyCode" required placeholder="PR-1024" />
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
            <TextInput name="addressLine1" required placeholder="Jalan Ampang 18" />
          </Field>
          <Field label="City">
            <TextInput name="city" required placeholder="Kuala Lumpur" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="State">
              <TextInput name="state" placeholder="Selangor" />
            </Field>
            <Field label="Postal code">
              <TextInput name="postalCode" placeholder="50450" />
            </Field>
          </div>
          <Field label="Country">
            <TextInput name="country" required defaultValue="Malaysia" />
          </Field>

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create property"}
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
      </DialogContent>
    </Dialog>
  );
}
