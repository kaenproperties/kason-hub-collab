/**
 * The per-room utility allocation line — ONE declaration, shared by the API engine that
 * produces it and the web clients that render it.
 *
 * WHY IT LIVES HERE. This shape was written out by hand in three places: the engine
 * (apps/api/src/modules/meter/compute.ts) and two web copies (apps/web/src/api/bills-grid.ts
 * and apps/web/src/api/meter.ts's PreviewAllocation). When `maintenance` became billable it
 * was added to the engine and to grossShareTotal, but neither web copy declared
 * `maintenanceShare` — so the web could render a per-room breakdown whose parts did not add
 * up to the total it displayed beside them. Nothing failed; the number was just wrong.
 *
 * Three hand-maintained copies of one shape is three chances to disagree. Types cannot be
 * imported across a package boundary unless they LIVE across it, so they live here and both
 * sides import. The web copies are now aliases, not restatements.
 */

/**
 * Every gross per-pax component that makes up a room's share, BEFORE subsidy.
 *
 * The engine derives `grossShareTotal` by SUMMING this record rather than hand-adding its
 * members, so a new component cannot reach `computedAmount` while being left out of the
 * total (or the reverse) — that asymmetry under- or over-bills a tenant with nothing to
 * catch it until a downstream Σ-invariant throws, far from the cause.
 */
export type ShareComponents = {
  /**
   * Gross share of leftover TNB. Legacy/no-subsidy policies allocate it per pax;
   * the unit-cap policy allocates it equally per occupied tenancy/room so its
   * separately-computed tenant excess can be split deterministically to the sen.
   */
  tnbShare: number;
  airSelangorShare: number;
  indahShare: number;
  wifiShare: number;
  cleaningShare: number;
  maintenanceShare: number;
};

export type AllocationLine = ShareComponents & {
  unitId: string;
  tenancyId: string;
  partyId: string;
  pax: number;
  /** Σ of ShareComponents — computed, never hand-listed. */
  grossShareTotal: number;
  /** Owner subsidy applied to this room (legacy per-pax or unit-level TNB cap). */
  subsidyDeduction: number;
  /** Net utility charge = grossShareTotal − subsidyDeduction. */
  computedAmount: number;
  unitCode: string | null;
  listingType: string | null;
};
