import { useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  Calculator,
  Coins,
  Percent,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { usePermission } from "@/components/permission-gate";
import { useCommissionSettings } from "@/hooks/use-commission-settings";
import { PageHeader } from "@/components/ui";
import { Callout } from "@/components/ui/callout";
import { TierMappingsSection } from "./commission/tier-mappings-section";
import { TaTiersSection } from "./commission/ta-tiers-section";
import { LevelThresholdsSection } from "./commission/level-thresholds-section";

/**
 * Commission & Tenancy-Agreement settings — tabbed admin console.
 *
 * Tab plumbing matches /workspace/renovation-settings: a `?tab=...` query
 * param drives which sub-section is visible, so deep-links work and the
 * back/forward buttons navigate within the page.
 *
 *   1. Commission %     — Agent Tier Mappings (per claim type × agent level)
 *   2. TA Tiers         — Tenancy-agreement tier bands (rental → company min)
 *   3. Auto-Promotion   — Cumulative RM thresholds that auto-promote agents
 *
 * Sales Claim Defaults moved to /workspace/renovation-settings (S&R Settings,
 * "Sales Defaults" tab). Renovation Stages moved to the same page's
 * "Pipeline Stages" tab.
 *
 * Read access: Manager+. Write access: Admin (`role === "admin"`). Write
 * gating is UI-only; the backend enforces the same rules.
 */

type TabKey = "tiers" | "ta" | "promotion";
const TAB_KEYS: TabKey[] = ["tiers", "ta", "promotion"];

const TAB_LABELS: Record<TabKey, string> = {
  tiers: "Commission %",
  ta: "TA Tiers",
  promotion: "Auto-Promotion",
};

const TAB_ICONS: Record<TabKey, typeof Percent> = {
  tiers: Percent,
  ta: Coins,
  promotion: TrendingUp,
};

const DEFAULT_TAB: TabKey = "tiers";

function isTabKey(v: string | null): v is TabKey {
  return v != null && (TAB_KEYS as string[]).includes(v);
}

export default function CommissionSettingsPage() {
  const { data, isLoading, isError } = useCommissionSettings();
  const canWrite = usePermission("settings.manage");

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const rawTab = searchParams.get("tab");
  const tab: TabKey = isTabKey(rawTab) ? rawTab : DEFAULT_TAB;

  useEffect(() => {
    if (rawTab === "rooms") {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
      toast.info("Room Types moved", {
        description: "Find them under Inventory Settings → Unit Types.",
        action: {
          label: "Open",
          onClick: () => navigate("/settings/inventory"),
        },
      });
      return;
    }
    if (rawTab !== null && !isTabKey(rawTab)) {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
    }
  }, [rawTab, setSearchParams, navigate]);

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-16 bg-muted rounded-xl" />
        <div className="h-12 bg-muted rounded-xl" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Callout variant="danger" title="Couldn't load settings">
        Failed to load commission settings. Please refresh.
      </Callout>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Commission & Tenancy-Agreement Settings"
        description={
          canWrite
            ? "Commission %, TA tiers, and promotion thresholds. Edits save inline."
            : "Commission %, TA tiers, and promotion thresholds. Read-only for your role."
        }
        icon={Calculator}
      />

      <div
        className="flex flex-wrap gap-1 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
        role="tablist"
        aria-label="Commission settings tabs"
      >
        {TAB_KEYS.map((key) => {
          const Icon = TAB_ICONS[key];
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSearchParams({ tab: key })}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                active
                  ? "bg-[var(--primary)] text-white shadow-sm"
                  : "text-[var(--text-secondary)] hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {TAB_LABELS[key]}
            </button>
          );
        })}
      </div>

      {tab === "tiers" && <TierMappingsSection mappings={data.tierMappings} canWrite={canWrite} />}
      {tab === "ta" && <TaTiersSection tiers={data.taTiers} canWrite={canWrite} />}
      {tab === "promotion" && <LevelThresholdsSection thresholds={data.levelThresholds} canWrite={canWrite} />}
    </div>
  );
}
