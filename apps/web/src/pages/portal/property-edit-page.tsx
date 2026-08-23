// Portal page — agent edits a PropertySubmission they own, typically in
// response to an admin "Needs amendment" note. PATCHes via
// updateOwnPortalProperty; the server flips submissionState back to
// "pending" and clears the amendment note.
//
// Editable only when state ∈ {pending, needs_amendment}. Approved, rejected,
// or withdrawn submissions are terminal — the page renders read-only
// fallback for those (the My Uploads tab doesn't expose an edit link, but
// a hard-typed URL still has to fail gracefully).
//
// Spec: docs/superpowers/specs/2026-05-21-agent-property-amendment-design.md §4.5

import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import {
  getOwnPortalProperty,
  updateOwnPortalProperty,
  withdrawOwnPortalProperty,
  type PortalOwnPropertyDetail,
  type UpdatePortalPropertyPayload,
} from "@/api/portal-inventory";
import { PropertyTypeSelect } from "@/components/property-type-select";
import { usePortalPropertyTypes } from "@/hooks/use-portal-property-types";

type FormState = UpdatePortalPropertyPayload;

function detailToForm(d: PortalOwnPropertyDetail): FormState {
  return {
    propertyCode: d.propertyCode,
    proposedName: d.proposedName,
    propertyType: d.propertyType,
    addressLine1: d.addressLine1,
    addressLine2: d.addressLine2 ?? "",
    city: d.city,
    state: d.state ?? "",
    postalCode: d.postalCode ?? "",
    country: d.country,
  };
}

type ApiError = {
  error?: string;
  fieldErrors?: Record<string, string>;
  blockingUnitIds?: string[];
};

export default function PortalPropertyEditPage() {
  const { submissionId } = useParams<{ submissionId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [blockingUnitIds, setBlockingUnitIds] = useState<string[] | null>(null);
  const [confirmWithdrawOpen, setConfirmWithdrawOpen] = useState(false);

  const query = useQuery({
    queryKey: ["portal-property-submission", submissionId],
    queryFn: () => getOwnPortalProperty(submissionId!),
    enabled: !!submissionId,
    retry: false,
  });

  const { data: propertyTypes = [] } = usePortalPropertyTypes();

  // Prefill from server data on first successful load.
  useEffect(() => {
    if (query.data && form === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setForm(detailToForm(query.data));
    }
  }, [query.data, form]);

  const updateMutation = useMutation({
    mutationFn: (payload: UpdatePortalPropertyPayload) =>
      updateOwnPortalProperty(submissionId!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-my-property-uploads"] });
      queryClient.invalidateQueries({ queryKey: ["portal-property-submission", submissionId] });
      toast.success("Property resubmitted for review");
      navigate("/portal/my-uploads?tab=properties");
    },
    onError: (err: unknown) => {
      const e = err as ApiError;
      toast.error(e?.error ?? "Failed to resubmit property");
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: () => withdrawOwnPortalProperty(submissionId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-my-property-uploads"] });
      toast.success("Property submission withdrawn");
      navigate("/portal/my-uploads?tab=properties");
    },
    onError: (err: unknown) => {
      const e = err as ApiError;
      if (e?.error === "PROPERTY_HAS_PENDING_UNITS" && e.blockingUnitIds) {
        setBlockingUnitIds(e.blockingUnitIds);
      } else {
        toast.error(e?.error ?? "Failed to withdraw");
      }
    },
  });

  if (query.isLoading || (query.data && form === null)) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            This submission no longer exists or has been withdrawn.
          </p>
          <Button variant="ghost" onClick={() => navigate("/portal/my-uploads?tab=properties")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to My Uploads
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!query.data || !form) return null;

  const isEditable =
    query.data.submissionState === "pending" ||
    query.data.submissionState === "needs_amendment";

  function onChange<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    updateMutation.mutate(form);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => navigate("/portal/my-uploads?tab=properties")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>

      {query.data.submissionState === "needs_amendment" && query.data.amendmentNote && (
        <Callout variant="warning" title="Admin requested an amendment">
          {query.data.amendmentNote}
        </Callout>
      )}

      {!isEditable && (
        <Callout variant="info">
          This submission is {query.data.submissionState} and can no longer be
          edited.
        </Callout>
      )}

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader>
          <CardTitle>Edit property submission</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <Field label="Property name">
              <Input
                value={form.proposedName}
                onChange={(e) => onChange("proposedName", e.target.value)}
                required
                disabled={!isEditable}
              />
            </Field>
            <Field label="Property Short Form">
              <Input
                value={form.propertyCode}
                onChange={(e) => onChange("propertyCode", e.target.value)}
                required
                disabled={!isEditable}
              />
            </Field>
            <Field label="Property type">
              <PropertyTypeSelect
                value={form.propertyType}
                onChange={(v) => onChange("propertyType", v)}
                options={propertyTypes}
                disabled={!isEditable}
                className="w-full"
              />
            </Field>
            <Field label="Address line 1">
              <Input
                value={form.addressLine1}
                onChange={(e) => onChange("addressLine1", e.target.value)}
                required
                disabled={!isEditable}
              />
            </Field>
            <Field label="Address line 2">
              <Input
                value={form.addressLine2 ?? ""}
                onChange={(e) => onChange("addressLine2", e.target.value)}
                disabled={!isEditable}
              />
            </Field>
            <Field label="City">
              <Input
                value={form.city}
                onChange={(e) => onChange("city", e.target.value)}
                required
                disabled={!isEditable}
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="State">
                <Input
                  value={form.state ?? ""}
                  onChange={(e) => onChange("state", e.target.value)}
                  disabled={!isEditable}
                />
              </Field>
              <Field label="Postal code">
                <Input
                  value={form.postalCode ?? ""}
                  onChange={(e) => onChange("postalCode", e.target.value)}
                  disabled={!isEditable}
                />
              </Field>
            </div>
            <Field label="Country">
              <Input
                value={form.country}
                onChange={(e) => onChange("country", e.target.value)}
                required
                disabled={!isEditable}
              />
            </Field>

            {isEditable && (
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  type="submit"
                  variant="gold"
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending
                    ? "Submitting…"
                    : query.data.submissionState === "needs_amendment"
                      ? "Resubmit for review"
                      : "Save changes"}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  disabled={withdrawMutation.isPending}
                  onClick={() => setConfirmWithdrawOpen(true)}
                >
                  Withdraw
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <ConfirmAlert
        open={confirmWithdrawOpen}
        onCancel={() => setConfirmWithdrawOpen(false)}
        onConfirm={() => {
          setConfirmWithdrawOpen(false);
          withdrawMutation.mutate();
        }}
        title="Withdraw this property submission?"
        body="You can create a new submission later if needed."
        confirmLabel="Withdraw"
        destructive
      />

      {blockingUnitIds && (
        <Callout variant="danger" title="Cannot withdraw" icon={AlertTriangle}>
          This property has {blockingUnitIds.length} pending unit submission
          {blockingUnitIds.length === 1 ? "" : "s"}. Withdraw those first from
          the Rentals tab, then come back here.
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/portal/my-uploads?tab=rentals")}
            >
              Go to Rentals
            </Button>
          </div>
        </Callout>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}
