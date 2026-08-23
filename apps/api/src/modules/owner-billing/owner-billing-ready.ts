// apps/api/src/modules/owner-billing/owner-billing-ready.ts
//
// Shared charge-post readiness guard (R2). Resolves the unit being posted to its
// owner + property, then checks for an active ManagementFeeConfig via the SAME
// date-aware selection the ledger engine uses (resolveConfigForUnit), so "not
// ready" ⟺ the engine would compute a zero management fee from a missing config.
import type { DbClient } from "../meter/types";
import { findApartmentOwner, findListingOwner } from "../meter/repository";
import {
  findFeeConfigsForOwner,
  resolveConfigForUnit,
  type OwnerUnitForMonth,
} from "./owner-billing.repository";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

export type OwnerBillingNotReadyCode = "OWNER_NOT_ASSIGNED" | "OWNER_BILLING_NOT_CONFIGURED";

/** Thrown from inside a posting tx; each call-site service maps {status, code} to
 * a Result err(422, code). Mirrors CreditNoteVoidError. */
export class OwnerBillingNotReadyError extends Error {
  public readonly status = 422 as const;
  constructor(public readonly code: OwnerBillingNotReadyCode) {
    super(code);
    this.name = "OwnerBillingNotReadyError";
  }
}

export type OwnerBillingScope =
  | { kind: "apartment"; apartmentId: string }
  | { kind: "listing"; listingId: string | null };

export interface OwnerBillingReadyInput {
  orgId: string;
  scope: OwnerBillingScope;
  /** First-of-month reference the ledger engine passes to resolveConfigForUnit
   * (tracker: the bill period; admin post: the charge's period). */
  asOf: Date;
}

export interface BillingReadiness {
  ownerAssigned: boolean;
  hasActiveConfig: boolean;
  ownerPartyId: string | null;
}

/**
 * Pure readiness read shared by the R2 guard and the R3 readiness endpoint.
 * Returns null ONLY for a listing scope with a null listingId (a non-unit charge —
 * the caller no-ops). Otherwise resolves the unit's owner + property and reports
 * whether an active config resolves for it as of `asOf`.
 */
export async function resolveBillingReadiness(
  db: DbClient,
  input: OwnerBillingReadyInput,
): Promise<BillingReadiness | null> {
  const { orgId, scope, asOf } = input;
  let resolved: { ownerPartyId: string | null; propertyId: string } | null;
  if (scope.kind === "listing") {
    if (scope.listingId === null) return null; // non-unit charge → no-op
    resolved = await findListingOwner(db, orgId, scope.listingId);
  } else {
    resolved = await findApartmentOwner(db, orgId, scope.apartmentId);
  }
  const ownerPartyId = resolved?.ownerPartyId ?? null;
  if (resolved === null || ownerPartyId === null) {
    return { ownerAssigned: false, hasActiveConfig: false, ownerPartyId: null };
  }
  const configs = await findFeeConfigsForOwner(orgId, ownerPartyId);
  // A config-resolution PROBE, not a money row: resolveConfigForUnit keys off
  // propertyId alone, so both rent bases are inert placeholders here.
  const probeUnit: OwnerUnitForMonth = {
    unitId: "", apartmentId: "", unitCode: "", propertyId: resolved.propertyId, occupied: false,
    rentBase: "0", rentBaseForMonth: "0",
    managementFeeRentComponents: [],
  };
  const config = resolveConfigForUnit(configs, probeUnit, asOf);
  return { ownerAssigned: true, hasActiveConfig: config !== null, ownerPartyId };
}

/**
 * R2 guard: throw OwnerBillingNotReadyError when the unit being posted is not
 * billing-ready. Called INSIDE the caller's db.$transaction.
 */
export async function assertOwnerBillingReady(
  db: DbClient,
  input: OwnerBillingReadyInput,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING")) return;
  const readiness = await resolveBillingReadiness(db, input);
  if (readiness === null) return;
  if (!readiness.ownerAssigned) throw new OwnerBillingNotReadyError("OWNER_NOT_ASSIGNED");
  if (!readiness.hasActiveConfig) throw new OwnerBillingNotReadyError("OWNER_BILLING_NOT_CONFIGURED");
}
