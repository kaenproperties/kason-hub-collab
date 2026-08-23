import { describe, it, expect } from "vitest";
import { OWNER_LEDGER_CATEGORIES } from "../schemas/owner-ledger";
import { CLEANING_SST_RATE, SEED_CHARGE_CATEGORIES, SEED_DOCUMENT_SERIES, TENANCY_AGREEMENT_SST_RATE } from "../constants/seed-categories";

describe("SEED_DOCUMENT_SERIES", () => {
  it("seeds the complete supported accounting-document series", () => {
    expect(SEED_DOCUMENT_SERIES.map((s) => s.code)).toEqual(["IVTEN", "IVOWN", "RB", "DEP", "CN", "DN", "RN", "RCPT", "EXP", "EB", "OST", "REM", "OEA", "DEPO", "PI"]);
  });
});

describe("SEED_CHARGE_CATEGORIES", () => {
  it("has unique codes and unique names (mirrors the DB @@uniques)", () => {
    const codes = SEED_CHARGE_CATEGORIES.map((c) => c.code);
    const names = SEED_CHARGE_CATEGORIES.map((c) => c.name);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every ledgerCategory is a REAL OWNER_LEDGER_CATEGORIES value (enum on disk is truth)", () => {
    for (const c of SEED_CHARGE_CATEGORIES) {
      if (c.ledgerCategory !== undefined) {
        expect(OWNER_LEDGER_CATEGORIES).toContain(c.ledgerCategory);
      }
    }
  });

  it("family → docType/series routing follows spec §4.1", () => {
    const seriesCodes = new Set(SEED_DOCUMENT_SERIES.map((s) => s.code));
    for (const c of SEED_CHARGE_CATEGORIES) {
      expect(seriesCodes.has(c.seriesCode)).toBe(true);
      if (c.family === "tenant_income") {
        expect(c.docType).toBe("invoice");
        expect(c.seriesCode).toBe("IVTEN");
      }
      if (c.family === "owner_income") {
        expect(c.docType).toBe("invoice");
        expect(c.seriesCode).toBe("IVOWN");
      }
      if (c.family === "pay_back_landlord") {
        expect(c.docType).toBe("debit_note");
        // Rental Bill (redesign P2): rent + carpark rental carve out to RB.
        // Move-in deposits carve out to DEPO so the "RENTAL DEPOSITS" title cannot
        // leak onto the utility/aircond debit notes that share DEP.
        // Everything else (aircond, utilities, legacy deposits) stays on DEP.
        if (c.code === "rental" || c.code === "carpark") {
          expect(c.seriesCode).toBe("RB");
        } else if (c.code === "tenancy_rental_deposit" || c.code === "tenancy_utility_deposit") {
          expect(c.seriesCode).toBe("DEPO");
        } else {
          expect(c.seriesCode).toBe("DEP");
        }
      }
    }
  });

  it("management and both Cleaning categories carry 8% SST; WiFi pass-through stays 0%", () => {
    const mgmt = SEED_CHARGE_CATEGORIES.find((c) => c.code === "management_fee");
    expect(mgmt).toMatchObject({ family: "owner_income", defaultSstRate: "8", ledgerCategory: "management_fee", isSystem: true });
    const byCode = new Map(SEED_CHARGE_CATEGORIES.map((category) => [category.code, category]));
    expect(CLEANING_SST_RATE).toBe("8");
    expect(byCode.get("cleaning_tenant")?.defaultSstRate).toBe("8");
    expect(byCode.get("cleaning_owner")).toMatchObject({ family: "owner_income", defaultSstRate: "8", ledgerCategory: "cleaning", isSystem: true });
    expect(byCode.get("wifi_tenant")?.defaultSstRate).toBe("0");
    expect(byCode.get("wifi_owner")?.defaultSstRate).toBe("0");
  });

  it("uses the statutory rate to split SST-inclusive initial and renewal TA amounts", () => {
    const byCode = new Map(SEED_CHARGE_CATEGORIES.map((category) => [category.code, category]));
    expect(TENANCY_AGREEMENT_SST_RATE).toBe("8");
    expect(byCode.get("tenancy_agreement_fee")?.defaultSstRate).toBe("8");
    expect(byCode.get("renewal_fee")?.defaultSstRate).toBe("8");
  });

  it("utility ledger mappings use the REAL enum spellings (utilities_tnb/water/wifi/indah_water)", () => {
    const byCode = new Map(SEED_CHARGE_CATEGORIES.map((c) => [c.code, c]));
    expect(byCode.get("utility_tnb")?.ledgerCategory).toBe("utilities_tnb");
    expect(byCode.get("utility_water")?.ledgerCategory).toBe("water");
    expect(byCode.get("utility_wifi")?.ledgerCategory).toBe("wifi");
    expect(byCode.get("utility_indah_water")?.ledgerCategory).toBe("indah_water");
  });

  it("auto-post-consumed codes are isSystem; legacy_other is inactive isSystem", () => {
    const byCode = new Map(SEED_CHARGE_CATEGORIES.map((c) => [c.code, c]));
    for (const code of ["rental", "aircond", "carpark", "utility_tnb", "utility_water", "utility_wifi", "utility_indah_water", "management_fee", "cleaning_owner", "legacy_other"]) {
      expect(byCode.get(code)?.isSystem, code).toBe(true);
    }
    expect(byCode.get("legacy_other")?.active).toBe(false);
    // Composition is asserted by family, not by one hand-maintained total: the bare
    // total drifted silently twice (letting_commission +2, then maintenance +2) because
    // a stale number in a comment costs nothing to be wrong. Grouping means the next
    // category lands in exactly one bucket and the failure names which one moved.
    //   tenant_income      15 — 6 base + Task 3 electricity/water/sewerage/wifi/subsidy
    //                          + recurring_other + other_expense + letting_commission
    //                          + maintenance_tenant (69fc262f, billable Maintenance)
    //   owner_income       10 — 2 base + Task 3 electricity/water/sewerage/wifi
    //                          + recurring_other + other_expense + letting_commission_sst
    //                          + maintenance_owner (69fc262f)
    //   pay_back_landlord  14 — incl. the inactive legacy_other, + the two DEPO
    //                          move-in deposits (tenancy_rental_deposit,
    //                          tenancy_utility_deposit)
    const byFamily = new Map<string, number>();
    for (const c of SEED_CHARGE_CATEGORIES) byFamily.set(c.family, (byFamily.get(c.family) ?? 0) + 1);
    expect(Object.fromEntries(byFamily)).toEqual({ tenant_income: 15, owner_income: 10, pay_back_landlord: 14 });
    expect(SEED_CHARGE_CATEGORIES).toHaveLength(39);
  });
});

describe("other_expense fallback categories", () => {
  it("other_expense_tenant routes tenant/IVTEN/invoice", () => {
    const c = SEED_CHARGE_CATEGORIES.find((x) => x.code === "other_expense_tenant");
    expect(c).toMatchObject({ family: "tenant_income", docType: "invoice", seriesCode: "IVTEN" });
  });
  it("other_expense_owner routes owner/IVOWN/invoice", () => {
    const c = SEED_CHARGE_CATEGORIES.find((x) => x.code === "other_expense_owner");
    expect(c).toMatchObject({ family: "owner_income", docType: "invoice", seriesCode: "IVOWN" });
  });
});

describe("letting commission (Phase 2 — first-full-month rent → KAEN Invoice/IVTEN)", () => {
  it("B19: letting_commission routes tenant_income / invoice / IVTEN (KAEN revenue), NOT the rent RB series", () => {
    const c = SEED_CHARGE_CATEGORIES.find((x) => x.code === "letting_commission");
    expect(c).toMatchObject({ family: "tenant_income", docType: "invoice", seriesCode: "IVTEN" });
  });
  it("carries NO tenant SST (the 8% SST is owner-borne → billed separately on IVOWN)", () => {
    const c = SEED_CHARGE_CATEGORIES.find((x) => x.code === "letting_commission");
    expect(c?.defaultSstRate).toBe("0");
  });
  it("B30/Phase 3: letting_commission_sst routes owner_income / invoice / IVOWN (owner-borne SST → owner invoice)", () => {
    const c = SEED_CHARGE_CATEGORIES.find((x) => x.code === "letting_commission_sst");
    expect(c).toMatchObject({ family: "owner_income", docType: "invoice", seriesCode: "IVOWN" });
  });
});
