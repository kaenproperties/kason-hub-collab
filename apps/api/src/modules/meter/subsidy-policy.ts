import {
  ComputeError,
  type BillingMode,
  type SubsidyPolicy,
} from "./compute";

type ResolveUtilitySubsidyPolicyInput = {
  /** Current policy derived from the apartment. Used only while a bill is unlocked. */
  liveMode: BillingMode;
  apartmentTnbSubsidyCap: unknown;
  organizationSubsidyPerPax: number;
  /** Bill fields form the immutable policy snapshot after a successful post. */
  billStatus: string;
  billBillingMode: unknown;
  billPolicySnapshot: unknown;
  billTnbSubsidyCapSnapshot: unknown;
  billSubsidyPerPax: unknown;
};

export type ResolvedUtilitySubsidyPolicy = {
  mode: BillingMode;
  subsidyPolicy: SubsidyPolicy;
};

export type UtilitySubsidyPolicySnapshot = {
  subsidyPolicySnapshot: SubsidyPolicy["kind"];
  subsidyPerPax: string | null;
  tnbSubsidyCapSnapshot: string | null;
};

/** Exact database values written when a successful post locks the policy. */
export function toUtilitySubsidyPolicySnapshot(
  policy: SubsidyPolicy,
): UtilitySubsidyPolicySnapshot {
  return {
    subsidyPolicySnapshot: policy.kind,
    subsidyPerPax:
      policy.kind === "legacy_per_pax"
        ? policy.amountPerPax.toFixed(2)
        : null,
    tnbSubsidyCapSnapshot:
      policy.kind === "unit_tnb_cap_equal_tenancy"
        ? policy.cap.toFixed(2)
        : null,
  };
}

function isBillingMode(value: unknown): value is BillingMode {
  return value === "whole" || value === "subsidy" || value === "no_subsidy";
}

function optionalNonNegativeMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function requireSnapshotMoney(value: unknown, field: string): number {
  const amount = optionalNonNegativeMoney(value);
  if (amount === null) {
    throw new ComputeError(
      "INVALID_SUBSIDY_POLICY_SNAPSHOT",
      `Missing or invalid ${field} on locked utility bill`,
    );
  }
  return amount;
}

/**
 * Resolve the allocation policy without silently repricing historical bills.
 *
 * New draft bills deliberately follow the apartment's live configuration until
 * they are successfully posted. A posted policy snapshot (including a snapshot
 * retained on a re-opened/rebill row) always wins. Pre-snapshot historical
 * charged/void bills are treated as legacy per-pax bills, using the rate already
 * stored on the bill rather than a newly-added apartment cap.
 */
export function resolveUtilitySubsidyPolicy(
  input: ResolveUtilitySubsidyPolicyInput,
): ResolvedUtilitySubsidyPolicy {
  const explicitSnapshot =
    typeof input.billPolicySnapshot === "string" &&
    input.billPolicySnapshot.length > 0;
  const historicalLocked = input.billStatus !== "draft";
  const locked = explicitSnapshot || historicalLocked;

  const mode = locked
    ? (() => {
        if (!isBillingMode(input.billBillingMode)) {
          throw new ComputeError(
            "INVALID_SUBSIDY_POLICY_SNAPSHOT",
            `Invalid locked billing mode: ${String(input.billBillingMode)}`,
          );
        }
        return input.billBillingMode;
      })()
    : input.liveMode;

  if (explicitSnapshot) {
    if (input.billPolicySnapshot === "none") {
      if (mode === "subsidy") {
        throw new ComputeError(
          "INVALID_SUBSIDY_POLICY_SNAPSHOT",
          "Subsidy billing mode cannot use a none policy snapshot",
        );
      }
      return { mode, subsidyPolicy: { kind: "none" } };
    }

    if (input.billPolicySnapshot === "legacy_per_pax") {
      if (mode !== "subsidy") {
        throw new ComputeError(
          "INVALID_SUBSIDY_POLICY_SNAPSHOT",
          "Legacy per-pax snapshot requires subsidy billing mode",
        );
      }
      return {
        mode,
        subsidyPolicy: {
          kind: "legacy_per_pax",
          amountPerPax: requireSnapshotMoney(
            input.billSubsidyPerPax,
            "subsidyPerPax",
          ),
        },
      };
    }

    if (input.billPolicySnapshot === "unit_tnb_cap_equal_tenancy") {
      if (mode !== "subsidy") {
        throw new ComputeError(
          "INVALID_SUBSIDY_POLICY_SNAPSHOT",
          "Unit TNB cap snapshot requires subsidy billing mode",
        );
      }
      return {
        mode,
        subsidyPolicy: {
          kind: "unit_tnb_cap_equal_tenancy",
          cap: requireSnapshotMoney(
            input.billTnbSubsidyCapSnapshot,
            "tnbSubsidyCapSnapshot",
          ),
        },
      };
    }

    throw new ComputeError(
      "INVALID_SUBSIDY_POLICY_SNAPSHOT",
      `Unknown subsidy policy snapshot: ${String(input.billPolicySnapshot)}`,
    );
  }

  if (mode !== "subsidy") {
    return { mode, subsidyPolicy: { kind: "none" } };
  }

  if (historicalLocked) {
    // Rows charged before policy snapshots existed are permanently legacy. The
    // stored per-pax amount is preferred; the org value is only a compatibility
    // fallback for an unusually old row where that legacy snapshot is null.
    return {
      mode,
      subsidyPolicy: {
        kind: "legacy_per_pax",
        amountPerPax:
          input.billSubsidyPerPax === null ||
          input.billSubsidyPerPax === undefined ||
          input.billSubsidyPerPax === ""
            ? input.organizationSubsidyPerPax
            : requireSnapshotMoney(input.billSubsidyPerPax, "subsidyPerPax"),
      },
    };
  }

  if (
    input.apartmentTnbSubsidyCap !== null &&
    input.apartmentTnbSubsidyCap !== undefined &&
    input.apartmentTnbSubsidyCap !== ""
  ) {
    const apartmentCap = optionalNonNegativeMoney(
      input.apartmentTnbSubsidyCap,
    );
    if (apartmentCap === null) {
      throw new ComputeError(
        "INVALID_SUBSIDY_CAP",
        `Apartment TNB subsidy cap must be non-negative: ${String(input.apartmentTnbSubsidyCap)}`,
      );
    }
    return {
      mode,
      subsidyPolicy: {
        kind: "unit_tnb_cap_equal_tenancy",
        cap: apartmentCap,
      },
    };
  }

  return {
    mode,
    subsidyPolicy: {
      kind: "legacy_per_pax",
      amountPerPax: input.organizationSubsidyPerPax,
    },
  };
}
