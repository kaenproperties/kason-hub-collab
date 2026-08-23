import { describe, expect, it, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

describe("navigation uses effective per-user permissions", () => {
  it("an individual block hides a role-default page", async () => {
    vi.stubEnv("VITE_ENABLE_PHASE2_BILLS_GRID", "true");
    const { navSections, canSeeNavItemFor } = await import("../navigation");
    const billing = navSections.flatMap((section) => section.items).find((item) => item.href === "/billing/tenant-owner-billing")!;
    expect(canSeeNavItemFor("manager", billing, [])).toBe(false);
  });

  it("an individual grant shows a page even when the role rank would hide it", async () => {
    vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "true");
    const { navSections, canSeeNavItemFor } = await import("../navigation");
    const profit = navSections.flatMap((section) => section.items).find((item) => item.href === "/accounting/profitability")!;
    expect(canSeeNavItemFor("editor", profit, ["profit.view"])).toBe(true);
  });
});
