// Portal-side modal for an agent to submit a new Property. The submission
// lands in the admin source queue (status=pending, sourcingApproved=false).
// On success the parent receives the new property id so it can be
// auto-selected in the unit-create form's property picker.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createPortalProperty,
  type CreatePortalPropertyPayload,
} from "@/api/portal-inventory";
import { PropertyTypeSelect } from "@/components/property-type-select";
import { usePortalPropertyTypes } from "@/hooks/use-portal-property-types";

// Minimum field set required for a new property submission. Mirrors the
// shared `createPortalPropertySchema` so client + server agree.
const emptyForm: CreatePortalPropertyPayload = {
  name: "",
  propertyCode: "",
  propertyType: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "Malaysia",
};

export type CreatePropertyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called with the new property id on successful submit so the caller can
  // immediately auto-select it in the unit picker.
  onCreated: (propertyId: string) => void;
};

export function CreatePropertyDialog({
  open,
  onOpenChange,
  onCreated,
}: CreatePropertyDialogProps) {
  const [form, setForm] = useState<CreatePortalPropertyPayload>(emptyForm);
  const { data: propertyTypes = [] } = usePortalPropertyTypes();

  const create = useMutation({
    mutationFn: () => createPortalProperty(form),
    onSuccess: (data) => {
      toast.success("Property submitted — admin will review it shortly.");
      onCreated(data.id);
      setForm(emptyForm);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to submit property");
    },
  });

  const canSubmit =
    form.name.trim() !== "" &&
    form.propertyCode.trim() !== "" &&
    form.propertyType.trim() !== "" &&
    form.addressLine1.trim() !== "" &&
    form.city.trim() !== "" &&
    form.country.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            New property
          </DialogTitle>
          <DialogDescription>
            Your submission lands in the admin source queue. You can still
            select this property for unit uploads while it's awaiting review.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !create.isPending) create.mutate();
          }}
          className="space-y-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">Property name *</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Sunway Artessa"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Property Short Form *</span>
              <Input
                value={form.propertyCode}
                onChange={(e) =>
                  setForm({ ...form, propertyCode: e.target.value.trim() })
                }
                placeholder="e.g. PR123"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-muted-foreground">Property type *</span>
            <PropertyTypeSelect
              value={form.propertyType}
              onChange={(v) => setForm({ ...form, propertyType: v })}
              options={propertyTypes}
              className="mt-1 w-full"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted-foreground">Address line 1 *</span>
            <Input
              value={form.addressLine1}
              onChange={(e) =>
                setForm({ ...form, addressLine1: e.target.value })
              }
              placeholder="Street + building name"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted-foreground">Address line 2</span>
            <Input
              value={form.addressLine2}
              onChange={(e) =>
                setForm({ ...form, addressLine2: e.target.value })
              }
              placeholder="Optional"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">City *</span>
              <Input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="e.g. Petaling Jaya"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">State</span>
              <Input
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                placeholder="e.g. Selangor"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Postal code</span>
              <Input
                value={form.postalCode}
                onChange={(e) =>
                  setForm({ ...form, postalCode: e.target.value })
                }
                placeholder="e.g. 47500"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-muted-foreground">Country *</span>
            <Input
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
            />
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || create.isPending}>
              {create.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
