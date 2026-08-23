// Settings → Utilities (M2 Aircond/Utility Billing). Admin CRUD for the single
// UtilityBillingConfig row — one subsidyPerPax field.
// Flag-gated: only registered in settings-layout.tsx + router.tsx when
// ENABLE_PHASE2_METER is on. The API mirrors the gate.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Zap } from "lucide-react";
import {
  PageHeader,
  Surface,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { apiFetch, ApiError } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UtilityBillingConfig {
  subsidyPerPax: string;
}

// ─── Query key ────────────────────────────────────────────────────────────────

const CONFIG_QK = ["utility-billing-config"] as const;

// ─── API helpers ──────────────────────────────────────────────────────────────

function fetchConfig(): Promise<UtilityBillingConfig> {
  return apiFetch<UtilityBillingConfig>("/utility-billing-config");
}

function patchConfig(fields: UtilityBillingConfig): Promise<UtilityBillingConfig> {
  return apiFetch<UtilityBillingConfig>("/utility-billing-config", {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function UtilitiesSection() {
  const canWrite = usePermission("settings.manage");
  const qc = useQueryClient();

  // Config query — treat 404 as "no config yet" (show empty form for admin)
  const configQuery = useQuery<UtilityBillingConfig | null, ApiError>({
    queryKey: CONFIG_QK,
    queryFn: async () => {
      try {
        return await fetchConfig();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  const [subsidyPerPax, setSubsidyPerPax] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const config = configQuery.data ?? null;
  // Sync local state on first load
  if (config !== null && subsidyPerPax === null) {
    setSubsidyPerPax(config.subsidyPerPax);
  }
  // If 404 (no config), init with empty string for admin
  if (config === null && subsidyPerPax === null && !configQuery.isLoading && canWrite) {
    setSubsidyPerPax("");
  }

  const patchMutation = useMutation({
    mutationFn: (fields: UtilityBillingConfig) => patchConfig(fields),
    onSuccess: (data) => {
      qc.setQueryData(CONFIG_QK, data);
      setSubsidyPerPax(data.subsidyPerPax);
      setEditing(false);
      toast.success("Utility billing config saved.");
    },
    onError: (err: ApiError) => {
      toast.error(err.message);
    },
  });

  function handleSave() {
    if (subsidyPerPax === null) return;
    patchMutation.mutate({ subsidyPerPax });
  }

  function handleDiscard() {
    setSubsidyPerPax(config ? config.subsidyPerPax : "");
    setEditing(false);
  }

  // ── Render states ──────────────────────────────────────────────────────────

  if (configQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-16 bg-muted rounded-xl" />
        <div className="h-32 bg-muted rounded-xl" />
      </div>
    );
  }

  if (configQuery.isError) {
    return (
      <Callout variant="danger" title="Couldn't load utility billing config">
        Failed to load utility billing config. Please refresh.
      </Callout>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <PageHeader
        title="Utilities"
        icon={Zap}
        description={
          canWrite
            ? "Aircond subsidy rate per pax. Admin only to edit."
            : "Aircond subsidy rate per pax. Read-only for your role."
        }
      />

      <Callout variant="info">
        Owner subsidy deducted per pax from the tenant&apos;s shared-utility share for apartments on
        the SUBSIDY billing model.
      </Callout>

      <Surface
        title="Subsidy rate"
        description="Applied when a partitioned apartment is set to the SUBSIDY billing model."
        actions={
          canWrite ? (
            editing ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={patchMutation.isPending}
                >
                  Discard
                </Button>
                <Button
                  variant="gold"
                  size="sm"
                  onClick={handleSave}
                  disabled={patchMutation.isPending}
                >
                  {patchMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          ) : undefined
        }
      >
        <Field
          label="Subsidy per pax (RM)"
          hint="Amount deducted from each pax's shared-utility share when the SUBSIDY model is active."
        >
          <TextInput
            type="number"
            min={0}
            step="0.01"
            placeholder="e.g. 20.00"
            value={subsidyPerPax ?? ""}
            disabled={!editing}
            onChange={(e) => setSubsidyPerPax(e.target.value)}
          />
        </Field>
      </Surface>
    </div>
  );
}
