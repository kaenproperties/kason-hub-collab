// vi.stubEnv BEFORE importing navigation (it reads import.meta.env at module scope
// via isPhase2FlagEnabled) — use dynamic import per case + vi.resetModules().
// Mirrors navigation-billing.test.ts's stub pattern (P1 T5 precedent).
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

async function loadNav() {
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "true");
  vi.stubEnv("VITE_ENABLE_PHASE2_OWNER_BILLING", "true");
  const mod = await import("../navigation");
  return mod;
}

function accountingItems(navSections: Awaited<ReturnType<typeof loadNav>>["navSections"]) {
  return navSections
    .flatMap((s) => s.items)
    .filter((i) => i.href === "/accounting/invoices" || i.href === "/accounting/receipts");
}

describe("accounting nav section", () => {
  it("uses the business workflow order", async () => {
    const { navSections } = await loadNav();
    const accounting = navSections.find((section) => section.label === "Accounting");
    expect(accounting?.items.map((item) => item.title)).toEqual([
      "Bank Reconciliation",
      "Invoices",
      "Receipts",
      "Employee Claims",
      "Owner Ledger",
      "Owner & Tenant Profitability",
      "Month-End Control",
    ]);
  });

  it("places Owner Ledger under Accounting without renaming or changing its route", async () => {
    const { navSections } = await loadNav();
    const accounting = navSections.find((section) => section.label === "Accounting");
    expect(accounting?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Owner Ledger", href: "/tenancy/owner-ledger", workspace: "accounting" }),
    ]));
    expect(navSections.find((section) => section.label === "Tenancy")?.items.some((item) => item.title === "Owner Ledger") ?? false).toBe(false);
  });
  it("exposes Invoices + Receipts tagged workspace:accounting", async () => {
    const { navSections } = await loadNav();
    const items = accountingItems(navSections);
    expect(items.map((i) => i.href).sort()).toEqual(["/accounting/invoices", "/accounting/receipts"]);
    for (const i of items) expect(i.workspace).toBe("accounting");
  });
  it("uses the resolved accounting permission instead of trusting the role label", async () => {
    const { navSections, canSeeNavItemFor } = await loadNav();
    for (const i of accountingItems(navSections)) {
      expect(canSeeNavItemFor("accountant", i, ["accounting.view"])).toBe(true);
      expect(canSeeNavItemFor("accountant", i, [])).toBe(false);
      expect(canSeeNavItemFor("editor", i, [])).toBe(false);
      expect(canSeeNavItemFor("editor", i, ["accounting.view"])).toBe(true);
    }
  });
});
