import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2, LayoutGrid, Settings, Sparkles, Tag } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { usePermission } from "@/components/permission-gate";
import { AmenitiesSection } from "./inventory/amenities-section";
import { UnitTypesSection } from "./inventory/unit-types-section";
import { WorkCategoriesSection } from "./inventory/work-categories-section";
import { PropertyTypesSection } from "./inventory/property-types-section";

/**
 * Inventory Settings — org-wide inventory configuration.
 *
 * Tab plumbing matches /commissions/settings and /workspace/renovation-settings:
 * a `?tab=...` query param drives which sub-section is visible, so deep-links
 * work and the back/forward buttons navigate within the page.
 *
 *   1. Amenities   — Org-curated amenity catalog
 *   2. Unit Types  — Global unit-type options (Master / Medium / etc.)
 *
 * Future tabs (e.g. property tags, listing defaults) land here.
 *
 * Read access: any admin role. Write access: manager+ (UI-gated; backend
 * enforces the same rule via RBAC on the mutation routes).
 */

type TabKey = "amenities" | "unit-types" | "categories" | "property-types";
const TAB_KEYS: TabKey[] = ["amenities", "unit-types", "categories", "property-types"];

const TAB_LABELS: Record<TabKey, string> = {
  amenities: "Amenities",
  "unit-types": "Unit Types",
  categories: "Categories",
  "property-types": "Property Types",
};

const TAB_ICONS: Record<TabKey, typeof Sparkles> = {
  amenities: Sparkles,
  "unit-types": LayoutGrid,
  categories: Tag,
  "property-types": Building2,
};

const DEFAULT_TAB: TabKey = "amenities";

function isTabKey(v: string | null): v is TabKey {
  return v != null && (TAB_KEYS as string[]).includes(v);
}

export default function InventorySettingsPage() {
  const canWrite = usePermission("settings.manage");

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: TabKey = isTabKey(rawTab) ? rawTab : DEFAULT_TAB;

  useEffect(() => {
    if (rawTab !== null && !isTabKey(rawTab)) {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
    }
  }, [rawTab, setSearchParams]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Settings"
        description={
          canWrite
            ? "Manage org-wide inventory configuration: amenity catalog, unit types, and more."
            : "Org-wide inventory configuration. Read-only for your role."
        }
        icon={Settings}
      />

      <div
        className="flex flex-wrap gap-1 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
        role="tablist"
        aria-label="Inventory settings tabs"
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

      {tab === "amenities" && <AmenitiesSection canWrite={canWrite} />}
      {tab === "unit-types" && <UnitTypesSection canWrite={canWrite} />}
      {tab === "categories" && <WorkCategoriesSection canWrite={canWrite} />}
      {tab === "property-types" && <PropertyTypesSection canWrite={canWrite} />}
    </div>
  );
}
