import { getDb } from "@kason/db";
import type { DocumentSeries, Prisma } from "@kason/db";
import { StaleUpdateError } from "../../lib/concurrency-error";
// Pure rent math (zero I/O) — the SAME precedence + proration the rent charge
// itself is minted from. See the ⚠️ MONEY note on resolveOwnerUnitsForMonth.
import { computeProratedRent, pickBaseRent } from "../../lib/rent-math";
// The SHARED period-aware tenancy selector every billing surface uses — never a
// hand-rolled `status:"active"` snapshot (see the ⚠️ MONEY note below).
import { primaryTenancyForPeriod, tenancyPeriodWhere } from "../../lib/tenancy-period";
import {
  centsToString,
  effectiveWindowOverlapsBillingMonth,
  toCents,
  type ManagementFeeRentComponent,
} from "@kason/shared";
import { isCommissionMonth } from "../../lib/commission-month";

export type DbManagementFeeConfig = Prisma.ManagementFeeConfigGetPayload<Record<string, never>>;

/** Filters for the org-scoped fee-config list. Every value is optional. */
export interface FeeConfigFilters {
  ownerPartyId?: string;
  propertyId?: string;
  apartmentId?: string;
  feeType?: string;
  isActive?: boolean;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}

/**
 * Org-scoped owner-in-org check. An owner party is "in this org" iff it carries a
 * PartyRole of roleType "owner" in this org. This DECOUPLES "is an owner" from
 * "currently owns ≥1 unit": an owner with a configured fee but momentarily zero
 * owned listings is still a valid owner to manage. (Previously this was resolved
 * via LandlordTenancy.landlordId; owner→units now resolves per-unit via
 * Listing.ownerPartyId, so the owner-identity check moves to the role.) Returns
 * the role id (or null) — the service maps null → 404.
 */
export async function findOwnerInOrg(
  orgId: string,
  ownerPartyId: string,
): Promise<{ id: string } | null> {
  const db = getDb();
  return db.partyRole.findFirst({
    where: { organizationId: orgId, partyId: ownerPartyId, roleType: "owner" },
    select: { id: true },
  });
}

/**
 * Org-scoped owner-owns-unit check. A unit (Listing) belongs to an owner iff its
 * per-unit `Listing.ownerPartyId` is that owner (the SAME key
 * `resolveOwnerUnitsForMonth` resolves units by). Used by the manual cleaning-bill
 * create to reject a unitId that belongs to a different owner (the generate path
 * derives units owner-scoped, so it can never mis-bind; this closes the same gap
 * for the manual path). Returns the listing id + the unit's propertyId (or null)
 * — the service maps null → 404, and uses propertyId to resolve the owner's config
 * with the SAME property-specific-overrides-all-properties precedence as the
 * generate path (resolveConfigForUnit). The active-tenancy / effective-window
 * filters are deliberately NOT applied here: ownership of the unit by the owner is
 * independent of whether it is currently occupied.
 */
export async function findUnitOwnedByOwner(
  orgId: string,
  ownerPartyId: string,
  unitId: string,
): Promise<{ id: string; propertyId: string; underManagement: boolean } | null> {
  const db = getDb();
  const listing = await db.listing.findFirst({
    where: { id: unitId, organizationId: orgId, ownerPartyId },
    select: { id: true, apartment: { select: { propertyId: true, underManagement: true } } },
  });
  if (!listing) return null;
  return {
    id: listing.id,
    propertyId: listing.apartment.propertyId,
    underManagement: listing.apartment.underManagement,
  };
}

/**
 * Org-scoped property-in-org check. A propertyId on a fee config must be a
 * Property belonging to this org. Returns the property id (or null) — the
 * service maps null → 404.
 */
export async function findPropertyInOrg(
  orgId: string,
  propertyId: string,
): Promise<{ id: string } | null> {
  const db = getDb();
  return db.property.findFirst({
    where: { id: propertyId, organizationId: orgId },
    select: { id: true },
  });
}

/**
 * Insert a ManagementFeeConfig row. Caller passes the org id in `data`
 * (UncheckedCreateInput) so the row is always org-scoped. Runs inside the
 * caller's transaction so the audit row lands atomically alongside it.
 */
export async function createFeeConfig(
  tx: Prisma.TransactionClient,
  data: Prisma.ManagementFeeConfigUncheckedCreateInput,
): Promise<DbManagementFeeConfig> {
  return tx.managementFeeConfig.create({ data });
}

/**
 * Org-scoped list with optional owner/property/feeType/isActive filters and
 * offset pagination. organizationId is ALWAYS in the WHERE — no cross-org leak.
 */
export async function listFeeConfigs(
  orgId: string,
  filters: FeeConfigFilters,
  page: Pagination,
): Promise<DbManagementFeeConfig[]> {
  const db = getDb();
  return db.managementFeeConfig.findMany({
    where: {
      organizationId: orgId,
      ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
      ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
      ...(filters.apartmentId ? { apartmentId: filters.apartmentId } : {}),
      ...(filters.feeType ? { feeType: filters.feeType } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    skip: page.offset,
  });
}

/**
 * Fetch a single fee config by id, org-scoped via findFirst({id, organizationId}).
 * A row belonging to another org resolves to null → the service maps that to 404
 * (never leak the row's existence).
 */
export async function getFeeConfig(
  orgId: string,
  id: string,
): Promise<DbManagementFeeConfig | null> {
  const db = getDb();
  return db.managementFeeConfig.findFirst({
    where: { id, organizationId: orgId },
  });
}

/** In-transaction org-scoped re-read — used to return the fresh row after a guarded write. */
async function getFeeConfigInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<DbManagementFeeConfig | null> {
  return tx.managementFeeConfig.findFirst({ where: { id, organizationId: orgId } });
}

/**
 * Optimistic-concurrency guarded update: the WHERE carries both the org scope
 * and the expected `updatedAt`. `count === 0` means the row was modified (or
 * deleted) since the caller's read — surfaced as StaleUpdateError → 409.
 * Mirrors tasks' updateTaskGuarded.
 */
export async function updateFeeConfigGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  expectedUpdatedAt: string,
  data: Prisma.ManagementFeeConfigUncheckedUpdateManyInput,
): Promise<DbManagementFeeConfig> {
  const result = await tx.managementFeeConfig.updateMany({
    where: { id, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await getFeeConfigInTx(tx, orgId, id);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Retire/restore toggle: org-scoped isActive flip. Uses updateMany so the org id
 * is enforced in the WHERE (a cross-org id touches zero rows → 404 at the service,
 * which pre-reads). Returns the fresh row.
 */
export async function setFeeConfigActive(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  isActive: boolean,
): Promise<DbManagementFeeConfig> {
  const result = await tx.managementFeeConfig.updateMany({
    where: { id, organizationId: orgId },
    data: { isActive },
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await getFeeConfigInTx(tx, orgId, id);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

// ─── Owner statement (C4) ──────────────────────────────────────────────────

/**
 * One resolved owner unit for a billing month. Mirrors the owner-portal
 * financials resolution shape (portal.financials.repository.ts): owner → owned
 * non-archived listings (keyed per-unit by Listing.ownerPartyId) → active tenancy
 * for the month.
 *
 * - `occupied` is true iff the unit has an active Tenancy (financials treats a
 *   unit as occupied via its active tenancy; we keep the SAME predicate so the
 *   two surfaces never diverge — `status:"active"`, take 1).
 * - `rentBase` is the active tenancy's `monthlyRentAmount` (2dp string) — the
 *   EXACT source financials uses for a unit's `expectedRent`. A vacant unit has
 *   `rentBase: "0"`. This is the CONTRACTED full-month figure: it is NOT what a
 *   mid-month tenancy is billed, so it is NOT a management-fee base.
 * - `rentBaseForMonth` is the rent actually BILLED for `month` — the same
 *   precedence + proration the rent charge itself is minted from. THIS is the
 *   management-fee base (see the ⚠️ MONEY note on the resolver below).
 * - `apartmentId` is the owning `Apartment.id` (a partitioned apartment has MANY
 *   Listing rows sharing one apartmentId; a whole apartment has one). The
 *   statement groups CLEANING per apartmentId (one cleaning charge per physical
 *   apartment) while management fee stays per-unit.
 */
export interface OwnerUnitForMonth {
  unitId: string;
  apartmentId: string;
  unitCode: string;
  propertyId: string;
  occupied: boolean;
  rentBase: string;
  rentBaseForMonth: string;
  /** Per-tenancy rent facts. The service applies the fee rule selected for this
   * owner/property/unit, including its optional per-pax deduction. Keeping raw
   * components here avoids an old property-level setting silently overriding a
   * negotiated unit-specific fee rule. */
  managementFeeRentComponents: ManagementFeeRentComponent[];
}

/**
 * Resolve the owner's units for a billing month, keyed per-unit by
 * Listing.ownerPartyId (owner money is attributed per-unit, NOT per-property via
 * LandlordTenancy). EVERY query is org-scoped via the
 * {ownerPartyId, organizationId} predicate (a cross-org owner resolves to an empty
 * set; the service has already 404'd via findOwnerInOrg before this is called).
 * Returns ALL owned listings — including VACANT ones (rentBase "0") — so a free
 * unit still carries its management-fee/cleaning line.
 *
 * The active-tenancy filter is `status:"active"` (NOT date-bounded) to match the
 * financials repository exactly. The rent base is the tenancy's
 * `monthlyRentAmount`, the same column financials reads for `expectedRent`.
 *
 * ⚠️ MONEY — `rentBaseForMonth` vs `rentBase`. The management fee used to be
 * taken off `rentBase`, the CONTRACTED monthly rent. That over-billed every
 * mid-month tenancy: a RM 5.00 tenancy starting on the 17th is billed RM 2.42
 * rent (15/31 days) but was charged a fee on the full RM 5.00 — RM 0.50 + SST
 * instead of RM 0.24 + SST.
 *
 * ⚠️ It does NOT make the invoice and the payout deduction agree in general.
 * §5's "KAEN Service Fee" (computeOwnerPayout) takes its fee off the ledger's
 * COLLECTED cash; `rentBaseForMonth` is rent BILLED. They coincide only when the
 * month is collected in full — late, partial or unpaid rent still yields two
 * different figures for the same fee. Narrowing that gap is a separate decision
 * (bill-basis vs cash-basis fee); do not assume it is closed.
 *
 * `rentBaseForMonth` reproduces the rent charge's OWN amount
 * via the shared pure helpers `pickBaseRent` + `computeProratedRent`
 * (lib/rent-math.ts — the same precedence resolveMonthlyRentAmount applies:
 * active RecurringCharge(rent) → reservation.agreedMonthlyRent → tenancy
 * .monthlyRentAmount, then mid-month proration). Both are exported from
 * `lib/rent-math.ts` precisely so a non-writer module can reuse the math
 * without importing the money-writing `billing/post-monthly-rent.ts`.
 * A vacant unit has no tenancy → "0", exactly as before.
 *
 * By default (opts absent/falsy) the query is GATED to `underManagement: true`
 * apartments — this is the correct behavior for statement generation
 * (generateStatementService line-planning) and the cleaning unit picker
 * (listOwnerUnitsService), both of which must hide un-managed apartments.
 * `opts.includeUnmanaged` lifts that gate; it exists ONLY for the SST-rate
 * resolver (owner-billing-sst-rate.ts resolveMgmtFeeSstRateByUnit), which feeds
 * the POST-generation SST recompute (voidStatementLineService /
 * addAdjustmentLineService / updateStatementLineService → recomputeTotals) and
 * the IVOWN document mint. Those callers must reproduce the SST rate for lines
 * that were ALREADY generated, regardless of the unit's CURRENT management
 * status — gating them would silently zero a surviving management_fee line's
 * SST (recompute) or throw IVOWN_SST_RATE_UNRESOLVED (mint) once an apartment is
 * flipped un-managed after a statement exists.
 */
export async function resolveOwnerUnitsForMonth(
  orgId: string,
  ownerPartyId: string,
  month: Date,
  opts?: { includeUnmanaged?: boolean },
): Promise<OwnerUnitForMonth[]> {
  const db = getDb();
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId,
      organizationId: orgId,
      listingStatus: { not: "archived" },
      ...(opts?.includeUnmanaged ? {} : { apartment: { underManagement: true } }),
    },
    select: {
      id: true,
      apartment: {
        select: {
          id: true,
          unitCode: true,
          propertyId: true,
        },
      },
      tenancies: {
        // Period OVERLAP, not `status:"active"` — the shared selector every
        // billing surface uses (lib/tenancy-period.ts). `status:"active"` is a
        // snapshot of NOW: generating August's statement in September picked
        // the NEXT tenant (who had not moved in yet), whose occupancy does not
        // intersect August at all, so the fee base prorated to 0.00 and August's
        // fee silently vanished. Overlap selects whoever actually occupied the
        // month, closed tenancies included.
        where: tenancyPeriodWhere(month),
        select: {
          id: true,
          monthlyRentAmount: true,
          startDate: true,
          endDate: true,
          status: true,
          numberOfPax: true,
          firstMonthIsCommission: true,
          reservation: { select: { agreedMonthlyRent: true } },
        },
      },
    },
    orderBy: { apartment: { unitCode: "asc" } },
  });

  // Top of resolveMonthlyRentAmount's precedence: an active RecurringCharge(rent)
  // overrides both the reservation and the tenancy. Batched over every resolved
  // tenancy — one query, never one per unit.
  const tenancyIds = ownedListings
    .flatMap((l) => l.tenancies.map((t) => t.id))
    .filter((id): id is string => id != null);
  const rentOverrideByTenancyId = new Map<string, number>();
  if (tenancyIds.length > 0) {
    const overrides = await db.recurringCharge.findMany({
      where: {
        organizationId: orgId,
        tenancyId: { in: tenancyIds },
        chargeType: "rent",
        isActive: true,
      },
      select: { tenancyId: true, amount: true },
    });
    for (const o of overrides) {
      if (o.tenancyId == null || rentOverrideByTenancyId.has(o.tenancyId)) continue;
      rentOverrideByTenancyId.set(o.tenancyId, Number(o.amount.toString()));
    }
  }

  // Management fees are owner charges and only become payable after the owner's
  // ordinary rent for the month has been fully collected.  Read the live rental
  // charges once for all tenancies; commission rent is deliberately excluded by
  // the economic rule below even though it is tenant-facing "first month rent".
  const rentCharges = tenancyIds.length > 0
    ? await db.charge.findMany({
        where: {
          organizationId: orgId,
          tenancyId: { in: tenancyIds },
          billingMonth: month,
          chargeType: { in: ["rent", "letting_commission"] },
          status: { notIn: ["void", "credited"] },
        },
        select: { tenancyId: true, chargeType: true, outstandingAmount: true },
      })
    : [];
  const ordinaryRentChargesByTenancy = new Map<string, typeof rentCharges>();
  for (const charge of rentCharges) {
    if (!charge.tenancyId || charge.chargeType !== "rent") continue;
    const rows = ordinaryRentChargesByTenancy.get(charge.tenancyId) ?? [];
    rows.push(charge);
    ordinaryRentChargesByTenancy.set(charge.tenancyId, rows);
  }

  const units: OwnerUnitForMonth[] = [];
  for (const listing of ownedListings) {
    // `rentBase` follows the month's PRIMARY tenancy (longest occupancy) — the
    // same collapse every one-tenant-per-row surface uses.
    const primaryTenancy = primaryTenancyForPeriod(listing.tenancies, month);
    const rentBase = primaryTenancy ? primaryTenancy.monthlyRentAmount.toString() : "0";

    // …but the FEE base sums EVERY tenancy that occupied the month. In a handover
    // month the unit is billed two prorated rents that together cover it, and the
    // fee is owed on both — taking only the primary's share would under-bill.
    let rentBaseForMonthC = 0;
    const managementFeeRentComponents: ManagementFeeRentComponent[] = [];
    for (const t of listing.tenancies) {
      const picked = pickBaseRent(
        rentOverrideByTenancyId.get(t.id) ?? null,
        t.reservation?.agreedMonthlyRent != null ? Number(t.reservation.agreedMonthlyRent) : null,
        Number(t.monthlyRentAmount),
      );
      const billedRent = computeProratedRent(picked, t.startDate, t.endDate, month);
      rentBaseForMonthC += toCents(
        billedRent.toFixed(2),
        "resolveOwnerUnitsForMonth.rentBaseForMonth",
      );

      const ordinaryCharges = ordinaryRentChargesByTenancy.get(t.id) ?? [];
      managementFeeRentComponents.push({
        billedRent: billedRent.toFixed(2),
        fullMonthRent: picked.toFixed(2),
        numberOfPax: t.numberOfPax,
        isCommissionMonth: isCommissionMonth(t, month),
        fullyCollected:
          ordinaryCharges.length > 0 &&
          ordinaryCharges.every((charge) => Number(charge.outstandingAmount) <= 0.005),
      });
    }
    const rentBaseForMonth = centsToString(rentBaseForMonthC);

    units.push({
      unitId: listing.id,
      apartmentId: listing.apartment.id,
      unitCode: listing.apartment.unitCode,
      propertyId: listing.apartment.propertyId,
      occupied: primaryTenancy != null,
      rentBase,
      rentBaseForMonth,
      managementFeeRentComponents,
    });
  }
  return units;
}

/**
 * One owner-borne utility component to auto-feed as a statement line (PART 4).
 * `chargeType` is a STATEMENT_CATEGORY_MAP key so the owner-ledger sync maps it to
 * the right category; `amount` is a 2dp money string; `unitId` is the listing the
 * line is attributed to.
 */
export interface OwnerBorneUtilityComponent {
  unitId: string;
  chargeType: "tnb" | "wifi" | "sewerage";
  amount: string; // 2dp string
}

/**
 * Resolve the owner-borne utility components to auto-feed onto a statement, from
 * each owned unit's UnitUtilityBill for the period (PART 4 / Workstream D).
 *
 * The statement previously only carried mgmt-fee + cleaning; the owner-borne
 * utilities the unit's bill computed (M2 → M6 seam) had to be added by hand. This
 * derives them from the bill's STORED owner-borne breakdown — no recompute — and
 * maps each to a statement-line chargeType:
 *   • indah water, when owner-borne (indahWaterBearer="owner")  → "sewerage" (indah_water)
 *   • wifi, when owner-borne (wifiBearer="owner")               → "wifi"
 *   • the owner-borne ELECTRICITY = ownerAttributableAircond (vacant-room aircond)
 *     + subsidyCovered (owner subsidy) + roundingResidual (owner absorbs)
 *                                                              → "tnb" (utilities_tnb)
 * Only components > 0 produce a line. The bill's owner-borne CLEANING is
 * deliberately NOT emitted here — cleaning stays the dedicated config/cleaning
 * path (which already produces a cleaning line), so the two never double-count on
 * the same unit+month chargeType.
 *
 * Air Selangor is always tenant-pooled (never owner-borne), so it is never fed.
 * Bills are matched by the owned unit's apartmentId + first-of-month period;
 * a unit whose apartment has no bill for the period contributes nothing. Only
 * NON-void bills are considered. Org-scoped throughout.
 */
/** Phase 3: owner-borne (commissionSstBearer="owner") letting_commission charges for these units
 * in the month — the SST base. Returns unitId + the charge amount so the statement bills 8% of what
 * was ACTUALLY billed to the tenant (M-F2). "kaen" bearer + non-commission months yield nothing. */
export async function findCommissionRentCharges(
  orgId: string,
  unitIds: string[],
  firstOfMonth: Date,
): Promise<{ unitId: string; amount: string; sstBearer: string }[]> {
  if (unitIds.length === 0) return [];
  const rows = await getDb().charge.findMany({
    where: {
      organizationId: orgId,
      unitId: { in: unitIds },
      // The tenant-facing rail always remains rent. The tenancy agreement tells
      // us whether this particular month's owner rent is retained by KAEN.
      chargeType: "rent",
      billingMonth: firstOfMonth,
      status: { notIn: ["void", "credited"] },
    },
    select: {
      unitId: true,
      amount: true,
      tenancy: {
        select: {
          startDate: true,
          endDate: true,
          firstMonthIsCommission: true,
          commissionSstBearer: true,
        },
      },
    },
  });
  return rows.flatMap((r) =>
    r.unitId !== null && r.tenancy?.firstMonthIsCommission === true &&
      isCommissionMonth({
        startDate: r.tenancy.startDate,
        endDate: r.tenancy.endDate,
        firstMonthIsCommission: r.tenancy.firstMonthIsCommission,
      }, firstOfMonth)
      ? [{ unitId: r.unitId, amount: r.amount.toString(), sstBearer: r.tenancy.commissionSstBearer }]
      : [],
  );
}

export async function findOwnerBorneCommissionSstCharges(
  orgId: string,
  unitIds: string[],
  firstOfMonth: Date,
): Promise<{ unitId: string; amount: string }[]> {
  const rows = await findCommissionRentCharges(orgId, unitIds, firstOfMonth);
  return rows
    .filter((row) => row.sstBearer === "owner")
    .map(({ unitId, amount }) => ({ unitId, amount }));
}

export async function findOwnerBorneUtilityComponents(
  orgId: string,
  unitIds: string[],
  firstOfMonth: Date,
): Promise<OwnerBorneUtilityComponent[]> {
  if (unitIds.length === 0) return [];
  const db = getDb();
  // listingId → apartmentId for the owned units (the bill is keyed by apartment).
  const listings = await db.listing.findMany({
    where: { organizationId: orgId, id: { in: unitIds } },
    select: { id: true, apartmentId: true },
  });
  const apartmentToUnit = new Map<string, string>();
  for (const l of listings) {
    // One bill per apartment+period; attribute its owner-borne lines to a single
    // owned unit of that apartment (first wins — deterministic by query order).
    if (!apartmentToUnit.has(l.apartmentId)) apartmentToUnit.set(l.apartmentId, l.id);
  }
  const apartmentIds = [...apartmentToUnit.keys()];
  if (apartmentIds.length === 0) return [];

  const bills = await db.unitUtilityBill.findMany({
    where: {
      organizationId: orgId,
      apartmentId: { in: apartmentIds },
      periodMonth: firstOfMonth,
      status: { not: "void" },
    },
    select: {
      apartmentId: true,
      indahWater: true,
      indahWaterBearer: true,
      wifi: true,
      wifiBearer: true,
      ownerAttributableAircond: true,
      subsidyCovered: true,
      roundingResidual: true,
    },
  });

  const components: OwnerBorneUtilityComponent[] = [];
  const n = (v: { toString(): string } | null | undefined): number =>
    v == null ? 0 : Number(v.toString());
  for (const bill of bills) {
    const unitId = apartmentToUnit.get(bill.apartmentId);
    if (!unitId) continue;

    // indah water — only when owner bears it.
    const indah = bill.indahWaterBearer === "owner" ? n(bill.indahWater) : 0;
    if (indah > 0) components.push({ unitId, chargeType: "sewerage", amount: indah.toFixed(2) });

    // wifi — only when owner bears it.
    const wifi = bill.wifiBearer === "owner" ? n(bill.wifi) : 0;
    if (wifi > 0) components.push({ unitId, chargeType: "wifi", amount: wifi.toFixed(2) });

    // owner-borne electricity = vacant-aircond + owner subsidy + rounding residual.
    const electricity =
      Math.round(
        (n(bill.ownerAttributableAircond) + n(bill.subsidyCovered) + n(bill.roundingResidual)) * 100,
      ) / 100;
    if (electricity > 0) components.push({ unitId, chargeType: "tnb", amount: electricity.toFixed(2) });
  }
  return components;
}

/**
 * All management-fee configs for an owner in this org (org-scoped). The service
 * resolves per-unit precedence in memory: unit > property > owner default.
 */
export async function findFeeConfigsForOwner(
  orgId: string,
  ownerPartyId: string,
): Promise<DbManagementFeeConfig[]> {
  const db = getDb();
  return db.managementFeeConfig.findMany({
    where: { organizationId: orgId, ownerPartyId },
  });
}

/**
 * Resolve the management-fee config that applies to one unit. A config whose
 * apartmentId === the unit's apartmentId overrides its property config, which
 * overrides the all-properties default. Only `isActive` configs whose effective window (if set)
 * overlaps the billing month are eligible. Returns null when none applies → that
 * unit gets no auto mgmt-fee / cleaning lines.
 *
 * THE canonical resolver — the generate path (owner-billing.service.ts), the
 * statement SST recompute (below), and the IVOWN document mint
 * (billing-documents/issue.service.ts) all call this SAME function so a
 * mgmt-fee amount/SST/document can never be derived from a different config
 * than the one that produced the statement line.
 */
export function resolveConfigForUnit(
  configs: DbManagementFeeConfig[],
  unit: OwnerUnitForMonth,
  firstOfMonth: Date,
): DbManagementFeeConfig | null {
  const eligible = configs.filter((c) => {
    if (!c.isActive) return false;
    if (!effectiveWindowOverlapsBillingMonth(firstOfMonth, c)) return false;
    return (
      c.apartmentId === unit.apartmentId ||
      (c.apartmentId == null && (c.propertyId === null || c.propertyId === unit.propertyId))
    );
  });
  if (eligible.length === 0) return null;
  // Unit-specific override beats property-specific, then the owner default.
  return (
    eligible.find((c) => c.apartmentId === unit.apartmentId) ??
    eligible.find((c) => c.apartmentId == null && c.propertyId === unit.propertyId) ??
    eligible.find((c) => c.apartmentId == null && c.propertyId === null) ??
    null
  );
}

/** Validate a unit-scoped fee config without trusting a client-supplied owner/property. */
export async function findApartmentOwnedByOwner(
  orgId: string,
  ownerPartyId: string,
  apartmentId: string,
): Promise<{ id: string; propertyId: string } | null> {
  const db = getDb();
  const apartment = await db.apartment.findFirst({
    where: {
      id: apartmentId,
      organizationId: orgId,
      listings: { some: { organizationId: orgId, ownerPartyId, listingStatus: { not: "archived" } } },
    },
    select: { id: true, propertyId: true },
  });
  return apartment;
}

/**
 * unitId → sstPercent (decimal string, e.g. "8" or "6") for units with a
 * resolvable config. Populated by `resolveMgmtFeeSstRateByUnit`
 * (owner-billing-sst-rate.ts) — kept here as a type-only export so callers
 * across modules share one shape without importing the orchestrator.
 */
export type SstRateByUnit = Map<string, string>;

export type DbInvoice = Prisma.InvoiceGetPayload<{ include: { charges: true } }>;

/**
 * THE ONE deterministic idempotency-key builder for an owner-statement INVOICE —
 * LOAD-BEARING, shared source of truth (Task 6, Deliverable C). Both
 * `generateStatementService` (owner-billing.service — mints the Invoice) AND the
 * freeze service (owner-statement-period.service — looks the Invoice up to attach
 * the frozen period's PDF) call THIS function, so the two can never drift. A drift
 * here would silently leave every frozen period without a PDF (the freeze's lookup
 * would miss the Invoice generate created).
 *
 * DELIBERATELY DISTINCT from the frozen period's key (buildStatementPeriodKey, the
 * `ownerstmt:` prefix): the Invoice uses the `owner:` prefix. A falsy apartmentId
 * (null / undefined / "") is combined scope — the SAME truthiness the generate path
 * historically used inline, preserved byte-for-byte.
 *
 *   combined (no apartmentId): owner:<owner>:<YYYY-MM>
 *   per-unit (apartmentId set): owner:<owner>:<YYYY-MM>:<apartmentId>
 */
export function buildOwnerStatementInvoiceKey(
  ownerPartyId: string,
  billingMonth: string,
  apartmentId?: string | null,
): string {
  return apartmentId
    ? `owner:${ownerPartyId}:${billingMonth}:${apartmentId}`
    : `owner:${ownerPartyId}:${billingMonth}`;
}

/**
 * Org-scoped idempotency read. Returns the existing owner-statement Invoice
 * (with its line Charges) for {organizationId, idempotencyKey}, or null.
 */
export async function findInvoiceByIdempotencyKey(
  orgId: string,
  idempotencyKey: string,
): Promise<DbInvoice | null> {
  const db = getDb();
  return db.invoice.findFirst({
    where: { organizationId: orgId, idempotencyKey },
    include: { charges: true },
  });
}

/** In-transaction org-scoped idempotency re-read (race defence after a P2002). */
export async function findInvoiceByIdempotencyKeyInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  idempotencyKey: string,
): Promise<DbInvoice | null> {
  return tx.invoice.findFirst({
    where: { organizationId: orgId, idempotencyKey },
    include: { charges: true },
  });
}

/** In-tx org-scoped re-read of a statement Invoice by id (returns lines). */
export async function findInvoiceByIdInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<DbInvoice | null> {
  return tx.invoice.findFirst({
    where: { id, organizationId: orgId },
    include: { charges: true },
  });
}

/**
 * No-double-bill guard: is there already an un-voided Charge of this
 * chargeType for this unit + billingMonth in this org? Used before adding a
 * management-fee / cleaning line so a re-run (or a later cron/manual path) can
 * never double-create. Org-scoped + status not "void".
 */
export async function findUnvoidedChargeForUnitMonth(
  tx: Prisma.TransactionClient,
  args: { orgId: string; unitId: string; billingMonth: Date; chargeType: string },
): Promise<{ id: string } | null> {
  return tx.charge.findFirst({
    where: {
      organizationId: args.orgId,
      unitId: args.unitId,
      billingMonth: args.billingMonth,
      chargeType: args.chargeType,
      status: { not: "void" },
    },
    select: { id: true },
  });
}

/**
 * Allocate the next monotonic suffix for a per-org, per-prefix sequence
 * (chargeNumber). Counts existing rows whose chargeNumber starts with the
 * prefix and returns count+1; the caller zero-pads. Runs in-tx so the count is
 * consistent with the inserts that follow in the same transaction.
 */
export async function countChargesWithPrefix(
  tx: Prisma.TransactionClient,
  orgId: string,
  prefix: string,
): Promise<number> {
  return tx.charge.count({
    where: { organizationId: orgId, chargeNumber: { startsWith: prefix } },
  });
}

/** Create one statement line Charge in-tx. Caller supplies org id + chargeNumber. */
export async function createStatementCharge(
  tx: Prisma.TransactionClient,
  data: Prisma.ChargeUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.charge.create({ data, select: { id: true } });
}

// The cleaning-Charge repository helpers (EnsureCleaningChargeArgs, ensureCleaningCharge,
// findCleaningChargeById, updateCleaningChargeGuarded, voidCleaningCharge) were REMOVED
// 2026-08-17 with the manual cleaning-bill endpoints and the owner-settings
// cleaningAutoBill that fed them. Nothing called them once both issuers were gone (the
// automatic one went 2026-07-29). The bills grid is the single cleaning issuer.
// Existing chargeType:"cleaning" Charges are untouched and still render.


/** Create the owner-statement Invoice header in-tx. */
export async function createOwnerStatementInvoice(
  tx: Prisma.TransactionClient,
  data: Prisma.InvoiceUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.invoice.create({ data, select: { id: true } });
}

/**
 * Grow an EXISTING statement Invoice's totals by the amounts just appended to it
 * (append mode — see generateStatementService's `appendToExistingDraft`).
 *
 * Used when a later rent payment in the same month adds another unit's mgmt-fee
 * charge to a statement that already exists: the charges are attached, so the
 * invoice header must move with them or the Invoice total silently under-states
 * the charges hanging off it.
 *
 * Increments rather than recomputes: the caller knows exactly what it wrote this
 * pass (the no-double-bill probe already dropped anything pre-existing), so a
 * recompute would risk double-counting lines written by an earlier pass.
 * Org-scoped, and status-guarded to `draft` as a second line of defence — an
 * approved/sent/paid statement must never have its total moved underneath it.
 */
export async function addToStatementInvoiceTotalsInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  addTotal: string,
  addSst: string,
): Promise<number> {
  const res = await tx.invoice.updateMany({
    where: { id: invoiceId, organizationId: orgId, status: "draft" },
    data: {
      totalAmount: { increment: addTotal },
      sstAmount: { increment: addSst },
    },
  });
  return res.count;
}

/** Attach an existing Charge to a statement Invoice (org-scoped update). */
export async function attachChargeToInvoice(
  tx: Prisma.TransactionClient,
  orgId: string,
  chargeId: string,
  invoiceId: string,
): Promise<void> {
  await tx.charge.updateMany({
    where: { id: chargeId, organizationId: orgId },
    data: { invoiceId },
  });
}

/** Filters for the org-scoped owner-statement list. */
export interface StatementFilters {
  ownerPartyId?: string;
  status?: string;
  /** First-of-month Date for the periodMonth filter. */
  periodMonth?: Date;
}

/**
 * Org-scoped owner-statement list (invoiceType "owner_statement"), with optional
 * owner/status/periodMonth filters + offset paging. organizationId is ALWAYS in
 * the WHERE. Returns the Invoice headers with their line Charges.
 */
export async function listOwnerStatements(
  orgId: string,
  filters: StatementFilters,
  page: Pagination,
): Promise<DbInvoice[]> {
  const db = getDb();
  return db.invoice.findMany({
    where: {
      organizationId: orgId,
      invoiceType: "owner_statement",
      ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.periodMonth ? { periodMonth: filters.periodMonth } : {}),
    },
    include: { charges: true },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    skip: page.offset,
  });
}

// ─── Owner statement detail + line add/edit/void (C5) ───────────────────────

export type DbCharge = Prisma.ChargeGetPayload<Record<string, never>>;

/**
 * Org-scoped statement detail read (non-tx). Returns the owner-statement Invoice
 * (with its line Charges) for {id, organizationId} or null. invoiceType is pinned
 * to "owner_statement" so a tenant invoice id resolves to null (→ 404) — never
 * leak another invoice family through this owner-billing surface.
 */
export async function findStatementById(
  orgId: string,
  id: string,
): Promise<DbInvoice | null> {
  const db = getDb();
  return db.invoice.findFirst({
    where: { id, organizationId: orgId, invoiceType: "owner_statement" },
    include: { charges: true },
  });
}

/**
 * In-tx org-scoped re-read of a single line Charge that belongs to a specific
 * statement Invoice. organizationId AND invoiceId are both in the WHERE so a
 * cross-org charge id, or a charge from a different statement, resolves to null.
 */
export async function findChargeInStatement(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  chargeId: string,
): Promise<DbCharge | null> {
  return tx.charge.findFirst({
    where: { id: chargeId, organizationId: orgId, invoiceId },
  });
}

/** Create one statement line Charge in-tx, returning the full row (for recompute + audit). */
export async function createLineCharge(
  tx: Prisma.TransactionClient,
  data: Prisma.ChargeUncheckedCreateInput,
): Promise<DbCharge> {
  return tx.charge.create({ data });
}

/**
 * Optimistic-concurrency guarded line-Charge update: the WHERE carries the org
 * scope, the owning invoiceId, and the expected `updatedAt`. `count === 0` means
 * the row was modified (or deleted) since the caller's read — surfaced as
 * StaleUpdateError → 409. Mirrors updateFeeConfigGuarded.
 */
export async function updateLineChargeGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  chargeId: string,
  expectedUpdatedAt: string,
  data: Prisma.ChargeUncheckedUpdateManyInput,
): Promise<DbCharge> {
  const result = await tx.charge.updateMany({
    where: {
      id: chargeId,
      organizationId: orgId,
      invoiceId,
      updatedAt: new Date(expectedUpdatedAt),
    },
    data,
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findChargeInStatement(tx, orgId, invoiceId, chargeId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Void a statement line Charge (status → "void"), org-scoped + invoice-scoped via
 * updateMany. Returns the fresh row. Voiding is allowed even after the statement
 * is approved (the only line mutation that is) — the service recomputes totals to
 * exclude the now-voided line.
 */
export async function voidLineCharge(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  chargeId: string,
): Promise<DbCharge> {
  const result = await tx.charge.updateMany({
    where: { id: chargeId, organizationId: orgId, invoiceId },
    data: { status: "void" },
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findChargeInStatement(tx, orgId, invoiceId, chargeId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Persist recomputed statement totals (org-scoped + invoice-scoped). Used after a
 * line add/edit/void to keep Invoice.totalAmount (and sstAmount) in lock-step with
 * the un-voided child Charges. Returns the fresh Invoice with its lines.
 */
export async function updateStatementTotals(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  totals: { totalAmount: string; sstAmount: string },
): Promise<DbInvoice> {
  await tx.invoice.updateMany({
    where: { id: invoiceId, organizationId: orgId, invoiceType: "owner_statement" },
    data: { totalAmount: totals.totalAmount, sstAmount: totals.sstAmount },
  });
  const fresh = await findInvoiceByIdInTx(tx, orgId, invoiceId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

// ─── Owner statement status transitions (C8) ────────────────────────────────

/**
 * Optimistic-concurrency guarded owner-statement status transition. The WHERE
 * carries the org scope, the owner_statement invoiceType pin, AND the expected
 * `updatedAt`; `count === 0` means the row changed (or is cross-org / not an
 * owner statement) since the caller's pre-read — surfaced as StaleUpdateError →
 * the service maps it to 409 with the EXACT "Record changed — reloaded" body.
 *
 * The legal-transition check (draft→approved, any-non-paid→void, approved→sent)
 * lives in the service, which pre-reads the current status; this helper only
 * enforces the concurrency token + org/type scope. Returns the fresh Invoice
 * (with its line Charges) for the response DTO. Mirrors updateStatementTotals'
 * updateMany-then-re-read idiom.
 *
 * `extraData` lets the caller stamp first-class provenance columns alongside the
 * status flip in the SAME guarded write — the approve transition uses it to set
 * Invoice.approvedBy/approvedAt (mirrors commissions' approve idiom), so those
 * columns are no longer left permanently null after a real approval.
 */
export async function transitionStatementStatusGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  expectedUpdatedAt: string,
  nextStatus: string,
  extraData: Prisma.InvoiceUpdateManyMutationInput = {},
): Promise<DbInvoice> {
  const result = await tx.invoice.updateMany({
    where: {
      id: invoiceId,
      organizationId: orgId,
      invoiceType: "owner_statement",
      updatedAt: new Date(expectedUpdatedAt),
    },
    data: { status: nextStatus, ...extraData },
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findInvoiceByIdInTx(tx, orgId, invoiceId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Org-scoped DocumentSeries lookup by code, in-tx (redesign P1: OST- statement
 * numbering). Mirrors the ad hoc `tx.documentSeries.findFirst` idiom already
 * used elsewhere for a series-code lookup (expenses.service.ts's EXP mint,
 * owner-remittance.service.ts's REM mint) — wrapped as a named helper here only
 * because this module already routes every in-tx Prisma call through one (the
 * file's own established convention, not a new pattern).
 */
export async function findDocumentSeriesInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  code: string,
): Promise<DocumentSeries | null> {
  return tx.documentSeries.findFirst({ where: { organizationId: orgId, code } });
}

// ─── Bulk receipt attach/detach (C6) ────────────────────────────────────────
// Statement-level receipts live on Invoice.attachmentKeys; line-level receipts
// live on the owning Charge.attachmentKeys. Both are read-modify-written INSIDE
// the caller's transaction (the service reads the current array via
// findStatementByIdInTx, computes the next array, then calls these), and every
// write is org-scoped + invoice-scoped via updateMany. A detach NEVER deletes the
// Charge row — only the key is filtered out of its attachmentKeys.

/** In-tx org-scoped re-read of a statement Invoice (+ its line Charges) by id. */
export async function findStatementByIdInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<DbInvoice | null> {
  return tx.invoice.findFirst({
    where: { id, organizationId: orgId, invoiceType: "owner_statement" },
    include: { charges: true },
  });
}

/**
 * Append receipt keys to an owner-statement Invoice.attachmentKeys (org-scoped +
 * invoiceType-pinned). The caller passes the already-merged next array; this
 * persists it and re-reads the fresh Invoice with its lines.
 */
export async function appendInvoiceAttachmentKeys(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  nextKeys: string[],
): Promise<DbInvoice> {
  await tx.invoice.updateMany({
    where: { id: invoiceId, organizationId: orgId, invoiceType: "owner_statement" },
    data: { attachmentKeys: nextKeys },
  });
  const fresh = await findInvoiceByIdInTx(tx, orgId, invoiceId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Append receipt keys to a line Charge.attachmentKeys (org-scoped + invoice-scoped
 * so a charge from another statement / org touches zero rows). The caller passes
 * the already-merged next array; returns the fresh Charge.
 */
export async function appendChargeAttachmentKeys(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  chargeId: string,
  nextKeys: string[],
): Promise<DbCharge> {
  const result = await tx.charge.updateMany({
    where: { id: chargeId, organizationId: orgId, invoiceId },
    data: { attachmentKeys: nextKeys },
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findChargeInStatement(tx, orgId, invoiceId, chargeId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Remove a single receipt key from an owner-statement Invoice.attachmentKeys
 * (org-scoped + invoiceType-pinned). The caller passes the already-filtered next
 * array; returns the fresh Invoice with its lines.
 */
export async function detachInvoiceAttachmentKey(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  nextKeys: string[],
): Promise<DbInvoice> {
  await tx.invoice.updateMany({
    where: { id: invoiceId, organizationId: orgId, invoiceType: "owner_statement" },
    data: { attachmentKeys: nextKeys },
  });
  const fresh = await findInvoiceByIdInTx(tx, orgId, invoiceId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Remove a single receipt key from a line Charge.attachmentKeys (org-scoped +
 * invoice-scoped). The Charge row is NEVER deleted — only the key is filtered out.
 * The caller passes the already-filtered next array; returns the fresh Charge.
 */
export async function detachChargeAttachmentKey(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  chargeId: string,
  nextKeys: string[],
): Promise<DbCharge> {
  const result = await tx.charge.updateMany({
    where: { id: chargeId, organizationId: orgId, invoiceId },
    data: { attachmentKeys: nextKeys },
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findChargeInStatement(tx, orgId, invoiceId, chargeId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

// ─── Task 2a-3: Deposit aggregation for Payout Summary ──────────────────────

/**
 * The last representable instant (23:59:59.999 UTC) of the calendar month that
 * contains `monthAnchor` — i.e. `firstOfNextMonth − 1 ms`. This is THE shared
 * END-OF-DAY-INCLUSIVE upper bound for a deposit-collection window
 * (`findDepositsCollectedInMonth`, queried with an inclusive `lte`).
 *
 * Why it exists (M-C1): a Deposit's `createdAt` is a full timestamp, but a naive
 * month upper bound of `Date.UTC(y, m, 0)` is MIDNIGHT (00:00:00 UTC) of the last
 * calendar day. A deposit created later that same day — e.g. 15:00 MYT = 07:00
 * UTC, a normal Malaysian business-day collection — is then `> that bound` and
 * gets wrongly pushed into month N+1. Bounding by the LAST instant of the month
 * counts a last-day deposit in the month it was actually collected.
 *
 * COHERENCE: every deposit-window caller — assembleYannieStatement (the
 * statement/PDF), getOwnerMonthsService (the `/months` card), and the
 * resolveOwnerBalance period window — MUST compute the upper bound via THIS one
 * helper so the three surfaces can never drift. The value is also byte-identical
 * to resolveOwnerBalance's brought-forward bound `firstOfMonth(fromMonth) − 1 ms`
 * for the following month, so consecutive deposit windows tile with no gap and no
 * overlap and `carriedForward(N) === broughtForward(N+1)`.
 *
 * Only the UTC year + month of `monthAnchor` are read; its day/time are ignored,
 * so callers may pass any Date inside the target month (e.g. its first-of-month).
 */
export function depositWindowEndOfMonth(monthAnchor: Date): Date {
  return new Date(
    Date.UTC(monthAnchor.getUTCFullYear(), monthAnchor.getUTCMonth() + 1, 1) - 1,
  );
}

/**
 * Aggregate Deposit rows collected (created) in the given month window for the
 * owner's units. Used for Yannie's Payout Summary "Deposit Collected (non-income)"
 * line — deposits are cash-in but are NOT income (they are liabilities to refund).
 *
 * The window is [monthStart, monthEnd] INCLUSIVE on `createdAt`. Callers MUST
 * derive `monthEnd` from `depositWindowEndOfMonth` (the end-of-day-inclusive last
 * instant of the month) so a deposit created any time on the last calendar day is
 * attributed to that month — see M-C1.
 *
 * Returns one entry per row: { unitId, type, amount (2dp string) }.
 *
 * Counts ONLY deposit cash released/payable to the owner (status =
 * "released_to_owner"). The payment projection writes each partial collection
 * as an append-only delta, so instalments contribute in the month received and
 * reversals contribute a negative correction in the month reversed.
 *
 * For what KAEN is holding (a balance, not a month's cash-in), use
 * `findDepositsHeldForUnits` — that figure is display-only and enters no total.
 *
 * Returns an empty array when unitIds is empty (short-circuit, no query).
 *
 * Org-scoped throughout (organizationId in WHERE).
 */
export async function findDepositsCollectedInMonth(
  orgId: string,
  unitIds: string[],
  monthStart: Date,
  monthEnd: Date,
): Promise<Array<{ unitId: string; type: string; amount: string }>> {
  if (unitIds.length === 0) return [];
  const db = getDb();
  const rows = await db.deposit.findMany({
    where: {
      organizationId: orgId,
      unitId: { in: unitIds },
      createdAt: { gte: monthStart, lte: monthEnd },
      status: "released_to_owner",
    },
    select: { unitId: true, type: true, amount: true },
  });
  return rows.map((r) => ({
    unitId: r.unitId,
    type: r.type,
    amount: Number(r.amount.toString()).toFixed(2),
  }));
}

/**
 * Deposits KAEN currently HOLDS for these units.
 *
 * A BALANCE, not a month's activity — so there is deliberately NO date window:
 * the figure persists for exactly as long as the status does. That is what makes
 * the owner statement's "Deposit held by KAEN" memo line reappear every month
 * until the deposit is released or refunded, with no repeat logic anywhere.
 *
 * Display-only. This figure enters NO total: not income, not an expense, and not
 * Gross Cash In (unlike "Add: Deposit Collected", which is non-income but IS
 * summed). Never pass it to computeOwnerPayout.
 *
 * Returns one entry per row: { unitId, type, amount (2dp string) }.
 * Returns an empty array when unitIds is empty (short-circuit, no query).
 * Served by the existing @@index([organizationId, status]).
 *
 * Org-scoped throughout (organizationId in WHERE).
 */
export async function findDepositsHeldForUnits(
  orgId: string,
  unitIds: string[],
): Promise<Array<{ unitId: string; type: string; amount: string }>> {
  if (unitIds.length === 0) return [];
  const db = getDb();
  const rows = await db.deposit.findMany({
    where: {
      organizationId: orgId,
      unitId: { in: unitIds },
      status: "held",
    },
    select: { unitId: true, type: true, amount: true },
  });
  return rows.map((r) => ({
    unitId: r.unitId,
    type: r.type,
    amount: Number(r.amount.toString()).toFixed(2),
  }));
}

// ─── Statement PDF regenerate (D1) ──────────────────────────────────────────

/**
 * Collect the attachment storage keys on the owner's ACTIVE OwnerLedgerEntry
 * rows for a statement month — the per-ledger-entry half of the statement PDF
 * proof bundle (scanned bills / receipts folded into the soft copy). Org-scoped;
 * returns `[]` when the owner has none. `periodMonth` is normalized to
 * first-of-month UTC to match how ledger rows store `statementMonth` (the
 * SAME grouping key assembleYannieStatement queries on). Keys are returned
 * as-collected (possibly with duplicates); the caller de-duplicates against the
 * statement-level Invoice.attachmentKeys.
 */
export async function findOwnerLedgerAttachmentKeysForMonth(
  orgId: string,
  ownerPartyId: string,
  periodMonth: Date,
): Promise<string[]> {
  const db = getDb();
  const monthStart = new Date(
    Date.UTC(periodMonth.getUTCFullYear(), periodMonth.getUTCMonth(), 1),
  );
  const rows = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      statementMonth: monthStart,
      status: "active",
    },
    select: { attachmentKeys: true },
  });
  return rows.flatMap((r) => r.attachmentKeys ?? []);
}

/**
 * Release the unique (idempotencyKey, invoiceNumber) slots held by any VOIDED
 * owner-statement Invoice for the given owner+month, so a fresh statement can
 * be created with the same canonical key and number.
 *
 * The voided row is KEPT as a terminal audit record — its idempotencyKey is
 * set to null and its invoiceNumber is mangled to `<orig>-V-<id8>` so the
 * unique constraints are freed. Must run INSIDE the same write tx, BEFORE the
 * new Invoice create.
 */
export async function releaseVoidedStatementSlotsInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  idempotencyKey: string,
  invoiceNumber: string,
): Promise<void> {
  const voids = await tx.invoice.findMany({
    where: {
      organizationId: orgId,
      status: "void",
      OR: [{ idempotencyKey }, { invoiceNumber }],
    },
    select: { id: true, invoiceNumber: true },
  });
  for (const v of voids) {
    await tx.invoice.update({
      where: { id: v.id },
      data: {
        idempotencyKey: null,
        invoiceNumber: `${v.invoiceNumber}-V-${v.id.slice(0, 8)}`,
      },
    });
  }
}

/**
 * Persist the rendered soft-copy PDF storage key on an owner-statement Invoice
 * (org-scoped + invoiceType-pinned via updateMany). Re-generating overwrites a
 * prior key (the object at the same Storage path is replaced upstream). Returns
 * the fresh Invoice with its lines. Mirrors updateStatementTotals' idiom.
 */
export async function setStatementPdfKey(
  tx: Prisma.TransactionClient,
  orgId: string,
  invoiceId: string,
  pdfKey: string,
): Promise<DbInvoice> {
  await tx.invoice.updateMany({
    where: { id: invoiceId, organizationId: orgId, invoiceType: "owner_statement" },
    data: { pdfKey },
  });
  const fresh = await findInvoiceByIdInTx(tx, orgId, invoiceId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}
