import { describe, expect, it } from "vitest";
import { ComputeError } from "../compute";
import {
  resolveUtilitySubsidyPolicy,
  toUtilitySubsidyPolicySnapshot,
} from "../subsidy-policy";

const base = {
  liveMode: "subsidy" as const,
  apartmentTnbSubsidyCap: null,
  organizationSubsidyPerPax: 50,
  billStatus: "draft",
  billBillingMode: "no_subsidy",
  billPolicySnapshot: null,
  billTnbSubsidyCapSnapshot: null,
  billSubsidyPerPax: null,
};

describe("utility subsidy policy resolution", () => {
  it("uses the apartment unit cap for a new unlocked subsidy bill", () => {
    expect(
      resolveUtilitySubsidyPolicy({
        ...base,
        apartmentTnbSubsidyCap: "200.00",
      }),
    ).toEqual({
      mode: "subsidy",
      subsidyPolicy: { kind: "unit_tnb_cap_equal_tenancy", cap: 200 },
    });
  });

  it("preserves the org per-pax policy when the apartment cap is null", () => {
    expect(resolveUtilitySubsidyPolicy(base)).toEqual({
      mode: "subsidy",
      subsidyPolicy: { kind: "legacy_per_pax", amountPerPax: 50 },
    });
  });

  it("keeps a pre-snapshot charged bill on its stored legacy per-pax policy", () => {
    expect(
      resolveUtilitySubsidyPolicy({
        ...base,
        liveMode: "no_subsidy",
        apartmentTnbSubsidyCap: "200.00",
        organizationSubsidyPerPax: 99,
        billStatus: "charged",
        billBillingMode: "subsidy",
        billSubsidyPerPax: "35.00",
      }),
    ).toEqual({
      mode: "subsidy",
      subsidyPolicy: { kind: "legacy_per_pax", amountPerPax: 35 },
    });
  });

  it("reuses a locked unit-cap snapshot even if live config changes", () => {
    expect(
      resolveUtilitySubsidyPolicy({
        ...base,
        liveMode: "no_subsidy",
        apartmentTnbSubsidyCap: "500.00",
        billStatus: "draft",
        billBillingMode: "subsidy",
        billPolicySnapshot: "unit_tnb_cap_equal_tenancy",
        billTnbSubsidyCapSnapshot: "200.00",
      }),
    ).toEqual({
      mode: "subsidy",
      subsidyPolicy: { kind: "unit_tnb_cap_equal_tenancy", cap: 200 },
    });
  });

  it("reuses a locked legacy snapshot instead of the current org rate", () => {
    expect(
      resolveUtilitySubsidyPolicy({
        ...base,
        organizationSubsidyPerPax: 99,
        billBillingMode: "subsidy",
        billPolicySnapshot: "legacy_per_pax",
        billSubsidyPerPax: "45.00",
      }),
    ).toEqual({
      mode: "subsidy",
      subsidyPolicy: { kind: "legacy_per_pax", amountPerPax: 45 },
    });
  });

  it("uses no subsidy policy for an unlocked non-subsidy bill", () => {
    expect(
      resolveUtilitySubsidyPolicy({
        ...base,
        liveMode: "no_subsidy",
        apartmentTnbSubsidyCap: "200.00",
      }),
    ).toEqual({ mode: "no_subsidy", subsidyPolicy: { kind: "none" } });
  });

  it("fails closed for an incomplete locked cap snapshot", () => {
    expect(() =>
      resolveUtilitySubsidyPolicy({
        ...base,
        billBillingMode: "subsidy",
        billPolicySnapshot: "unit_tnb_cap_equal_tenancy",
      }),
    ).toThrowError(ComputeError);
  });

  it("fails closed instead of silently falling back for an invalid live cap", () => {
    expect(() =>
      resolveUtilitySubsidyPolicy({
        ...base,
        apartmentTnbSubsidyCap: "-1.00",
      }),
    ).toThrowError(ComputeError);
  });

  it("serializes the exact cap policy fields locked by a successful post", () => {
    expect(
      toUtilitySubsidyPolicySnapshot({
        kind: "unit_tnb_cap_equal_tenancy",
        cap: 200,
      }),
    ).toEqual({
      subsidyPolicySnapshot: "unit_tnb_cap_equal_tenancy",
      subsidyPerPax: null,
      tnbSubsidyCapSnapshot: "200.00",
    });

    expect(
      toUtilitySubsidyPolicySnapshot({
        kind: "legacy_per_pax",
        amountPerPax: 50,
      }),
    ).toEqual({
      subsidyPolicySnapshot: "legacy_per_pax",
      subsidyPerPax: "50.00",
      tnbSubsidyCapSnapshot: null,
    });
  });
});
