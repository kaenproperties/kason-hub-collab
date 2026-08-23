import type { z } from "zod";
import { getDb, Prisma } from "@kason/db";
import type { InventorySession } from "./inventory.types";
import {
  createListingTx,
  createProperty,
  findListingById,
  findListingTypeConflict,
  findPropertyById,
  findPropertyCodeConflict,
  findPropertyDetail,
  findPropertyStatus,
  findUnitDetail,
  listListings,
  listProperties,
  recomputeReadyNowForProperty,
  replaceVisibilityGrants,
  searchApartments,
  updateListingTx,
  updateProperty,
  updatePropertyPaxDeduction,
} from "./inventory.repository";
import {
  createPropertySchema,
  createUnitSchema,
  updatePropertySchema,
  updateUnitSchema,
} from "./inventory.validation";
import { assertAmenitiesBelongToOrgService } from "./amenities/amenities.service";
import { syncOccupancyTenancy } from "./occupancy-tenancy-sync";
import { draftCatchupForUnit } from "../billing/draft-catchup.hook";
import { createTenancyDepositsForUnit } from "../billing/tenancy-deposits";
import { assertCommissionWritable } from "../tenancy/commission-guard";
// Shared with apartment.service.ts so "who owns this apartment" has exactly ONE
// answer across the create paths and "Edit shared details" (I3).
import {
  resolveApartmentOwnerForConflict,
  resolveApartmentOwnerForInheritance,
} from "./apartment-owner";
import { getUnitGroupMode, resolveRoomTypeKind } from "./listing-mode";
import { recordAudit } from "../../lib/audit";
import { rematerializeOwnerRecentMonths } from "../owner-ledger/unit-month-ledger.remateralize-range";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

/**
 * `readyNow` is a derived boolean. It reflects whether a Listing is bookable
 * to a tenant immediately. The DB column is kept (it's indexed by some
 * portal queries) but its value is computed from the lifecycle columns
 * AND the parent Property status on every write. Clients never set it
 * directly — the input schemas omit it and the service overwrites it.
 *
 * Rule: ready-now requires ALL of:
 *  - propertyStatus    === "active"     (parent Property is operational)
 *  - listingStatus     === "active"     (admin has activated the listing)
 *  - visibilityMode    === "PUBLIC"     (visible to agents)
 *  - occupancyStatus   === "vacant"     (no current tenancy)
 *
 * After the three-table refactor, Listings live exclusively in the
 * approved tree — pending agent submissions are in UnitSubmission. As a
 * result the legacy `sourceFlag` / `sourcingApproved` parameters are gone
 * from this signature (Listings are approved by definition).
 */
export function deriveReadyNow(input: {
  propertyStatus: string;
  listingStatus: string;
  visibilityMode: string;
  occupancyStatus: string;
}): boolean {
  return (
    input.propertyStatus === "active" &&
    input.listingStatus === "active" &&
    input.visibilityMode === "PUBLIC" &&
    input.occupancyStatus === "vacant"
  );
}

// ---- coerce-to-draft when required fields are missing ----------------------

const REQUIRED_FOR_PUBLISH = ["bedrooms", "bathrooms", "rentalRate"] as const;
type RequiredForPublishField = (typeof REQUIRED_FOR_PUBLISH)[number];

/**
 * Inputs may legitimately be incomplete — agents drafting a unit don't
 * always have rentalRate yet. Rule: if a non-draft listing is requested
 * but a required field is missing, COERCE to draft (and force visibility
 * to RESTRICTED for safety) and emit a warning.
 *
 * Note on `bedrooms` / `bathrooms`: these now live on Apartment, not
 * Listing, but the create/update payloads still surface them at the API
 * edge for back-compat (the service strips them before writing). The
 * pre-publish required-fields check therefore continues to enforce them
 * on the inbound payload even though their persisted home moved.
 */
export function coerceToDraftIfIncomplete<T extends {
  listingStatus?: string;
  visibilityMode?: "PUBLIC" | "RESTRICTED";
  bedrooms?: number | null;
  bathrooms?: number | null;
  rentalRate?: number | null;
}>(input: T): {
  effectiveInput: T;
  coerced: boolean;
  missing: ReadonlyArray<RequiredForPublishField>;
} {
  if (!input.listingStatus || input.listingStatus === "draft") {
    return { effectiveInput: input, coerced: false, missing: [] };
  }
  const missing = REQUIRED_FOR_PUBLISH.filter(
    (f) => input[f] === undefined || input[f] === null,
  );
  if (missing.length === 0) {
    return { effectiveInput: input, coerced: false, missing: [] };
  }
  return {
    effectiveInput: { ...input, listingStatus: "draft", visibilityMode: "RESTRICTED" },
    coerced: true,
    missing,
  };
}

/**
 * Service-layer empty-string coercion for nullable String columns. The
 * client form may submit "" when the user clears an optional field; for
 * columns where empty is meaningless (description), persist null so the
 * column nulls out cleanly. Applied at service edges only.
 */
function coerceEmptyStringToNull<T extends Record<string, unknown>>(
  input: T,
  fields: ReadonlyArray<keyof T>,
): T {
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    if (out[f as string] === "") out[f as string] = null;
  }
  return out as T;
}

export async function getInventoryPropertiesService(session: InventorySession) {
  return listProperties(session.orgId);
}

/**
 * Detail-shape Property fetch used by the Edit Property dialog. Returns the
 * full address + pax-deduction so the dialog can hydrate every field instead
 * of relying on placeholder text (which silently nullifies fields on submit).
 */
export async function getInventoryPropertyByIdService(
  session: InventorySession,
  propertyId: string,
) {
  const property = await findPropertyDetail(session.orgId, propertyId);
  if (!property) return { ok: false as const, status: 404, error: "Property not found" };
  return { ok: true as const, status: 200, data: property };
}

export async function getInventoryUnitsService(
  session: InventorySession,
  filters?: { q?: string; status?: string },
) {
  return listListings(session.orgId, filters);
}

export async function searchApartmentsService(
  session: InventorySession,
  filters?: { q?: string },
) {
  return searchApartments(session.orgId, filters);
}

/**
 * Summary counts for the inventory dashboard. After the three-table
 * refactor we count directly off the Apartment + Listing tables instead
 * of materialising the full row sets in memory.
 */
export async function getInventorySummaryService(session: InventorySession) {
  const db = getDb();
  const [propertyCount, listings] = await Promise.all([
    db.property.count({ where: { organizationId: session.orgId } }),
    db.listing.findMany({
      where: {
        organizationId: session.orgId,
        listingStatus: { not: "archived" },
      },
      select: { occupancyStatus: true },
    }),
  ]);

  const occupiedUnits = listings.filter((l) => l.occupancyStatus === "occupied").length;
  return {
    propertyCount,
    unitCount: listings.length,
    occupiedUnits,
    vacantUnits: Math.max(0, listings.length - occupiedUnits),
  };
}

export async function createPropertyService(
  session: InventorySession,
  input: z.infer<typeof createPropertySchema>,
) {
  const conflict = await findPropertyCodeConflict(session.orgId, input.propertyCode);
  if (conflict) return { ok: false as const, status: 409, error: "Property code already exists" };

  const property = await createProperty({
    organizationId: session.orgId,
    ...input,
  });

  return { ok: true as const, status: 201, data: property };
}

export async function updatePropertyService(
  session: InventorySession,
  input: z.infer<typeof updatePropertySchema>,
) {
  const existing = await findPropertyById(session.orgId, input.propertyId);
  if (!existing) return { ok: false as const, status: 404, error: "Property not found" };

  if (input.propertyCode) {
    const conflict = await findPropertyCodeConflict(session.orgId, input.propertyCode, input.propertyId);
    if (conflict) return { ok: false as const, status: 409, error: "Property code already exists" };
  }

  // Snapshot current property.status before mutating so we can decide whether
  // the cascade hook needs to run.
  const beforeStatus = await findPropertyStatus(session.orgId, input.propertyId);

  const { propertyId, ...data } = input;
  await updateProperty(propertyId, data);

  const afterStatus = await findPropertyStatus(session.orgId, propertyId);
  // Cascade: when Property.status flips, every Listing on every Apartment
  // of that property must recompute readyNow in the same logical operation.
  if (beforeStatus !== afterStatus) {
    await recomputeReadyNowForProperty(session.orgId, propertyId, deriveReadyNow);
  }

  return { ok: true as const, status: 200, data: { id: propertyId } };
}

/**
 * Find-or-create the Apartment row that a Listing write should attach to.
 *
 * Pre-refactor, apartment-shared fields lived on every sibling Unit row,
 * fanned out by a separate service. Post-refactor those fields live on a
 * single Apartment row. The admin write surface still accepts them at the
 * API edge for back-compat — when present, we treat them as the canonical
 * value for the (potentially new) Apartment.
 *
 * `listingMode` is derived from the new room's RoomType.kind so the
 * Apartment row gets a sensible default. If we can't resolve a kind for
 * the incoming listingType, we default to PARTITIONED (the more permissive
 * mode — a Whole listing can always be re-flipped later).
 */
async function findOrCreateApartment(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  orgId: string;
  propertyId: string;
  unitCode: string;
  listingType: string;
  shared: {
    bedrooms?: number | null;
    bathrooms?: number | null;
    floor?: number | null;
    floorArea?: number | null;
    amenities?: string[];
    highlights?: string[];
    description?: string | null;
  };
  // Apartment-scoped utility billing mode from the unified modal. Only written
  // when supplied — undefined leaves the DB default (NO_SUBSIDY) on create and
  // leaves an existing apartment's value untouched.
  partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY";
  // Optional per-unit monthly TNB owner cap. A value takes priority for the
  // residual TNB amount. `null` explicitly defers to partitionBillingMode;
  // undefined means the caller made no assertion about this setting.
  tnbSubsidyCapMonthly?: number | null;
  // Actor for the in-tx audit written when an EXISTING apartment's billing mode
  // actually changes (money-adjacent: SUBSIDY vs NO_SUBSIDY drives tenant utility
  // bills). Required so the audit can never be silently dropped.
  actor: { userId: string; role: string };
}): Promise<{ id: string }> {
  const {
    tx,
    orgId,
    propertyId,
    unitCode,
    listingType,
    shared,
    partitionBillingMode,
    tnbSubsidyCapMonthly,
    actor,
  } = args;

  const existing = await tx.apartment.findFirst({
    where: { organizationId: orgId, propertyId, unitCode },
    select: { id: true, partitionBillingMode: true, tnbSubsidyCapMonthly: true },
  });
  if (existing) {
    // I4: `partitionBillingMode` is APARTMENT-scoped and money-adjacent — SUBSIDY vs
    // NO_SUBSIDY drives every tenant's utility bill on this apartment. A room create
    // must never rewrite it: adding one room to a SUBSIDY apartment would otherwise
    // silently flip the utility bill of every tenant already living there.
    //
    // Mirrors the `ownerPartyId` contract exactly (409, nothing written) — the
    // precedent chosen for the analogous apartment-scoped field. `partitionBillingMode`
    // was also the ONLY apartment-shared field a create could mutate on a pre-existing
    // apartment without the `applyToExistingSiblings` opt-in, because
    // `findOrCreateApartment` runs unconditionally on both create paths.
    //
    // Unchanged re-submit (equal value) stays a silent no-op: no write, no audit, no
    // error. Omitted (`undefined`) never reaches the throw — the Excel import
    // (`ensureRoomListing`) always omits it, so this guard cannot fire there.
    //
    // `partitionBillingMode` is a non-nullable enum with a DB default
    // (schema.prisma:270), so `existing.partitionBillingMode` is never null and the
    // comparison needs no NULL handling.
    if (partitionBillingMode !== undefined && partitionBillingMode !== existing.partitionBillingMode) {
      throw apartmentBillingModeConflictError();
    }
    if (tnbSubsidyCapMonthly !== undefined) {
      const existingCapCents = existing.tnbSubsidyCapMonthly == null
        ? null
        : Math.round(Number(existing.tnbSubsidyCapMonthly.toString()) * 100);
      const requestedCapCents = tnbSubsidyCapMonthly == null
        ? null
        : Math.round(tnbSubsidyCapMonthly * 100);
      if (requestedCapCents !== existingCapCents) {
        throw apartmentTnbSubsidyCapConflictError();
      }
    }
    return existing;
  }

  // No apartment yet — derive listingMode from the room's kind. Fall back
  // to PARTITIONED when unknown (legacy types can be flipped later via the
  // mode-flip flow).
  const kind = await resolveRoomTypeKind(orgId, listingType);
  const listingMode: "WHOLE" | "PARTITIONED" =
    kind === "WHOLE" ? "WHOLE" : "PARTITIONED";

  const createdApartment = await tx.apartment.create({
    data: {
      organizationId: orgId,
      propertyId,
      unitCode,
      listingMode,
      bedrooms: shared.bedrooms ?? null,
      bathrooms: shared.bathrooms ?? null,
      floor: shared.floor ?? null,
      floorArea: shared.floorArea ?? null,
      amenities: shared.amenities ?? [],
      highlights: shared.highlights ?? [],
      publishedDescription: shared.description ?? null,
      // Omitted when undefined so the schema default (NO_SUBSIDY) applies.
      ...(partitionBillingMode !== undefined ? { partitionBillingMode } : {}),
      // Null deliberately defers to the apartment's legacy partition billing mode.
      ...(tnbSubsidyCapMonthly !== undefined ? { tnbSubsidyCapMonthly } : {}),
    },
    select: { id: true },
  });

  // R2-5: an initial partitionBillingMode is a client ASSERTION about a
  // money-adjacent column (SUBSIDY vs NO_SUBSIDY drives tenant utility bills), and
  // this create path is the first surface that lets a client set it. Audit it in
  // the SAME tx, mirroring the existing-apartment branch above. Nothing is audited
  // when it is undefined: the client asserted nothing and the DB default applies.
  //
  // F6: this row describes an apartment CREATE, but the action reads
  // `apartment.shared.update` -- an auditor filtering that action sees creation rows
  // among the edits. The action is deliberately NOT renamed (other consumers filter on
  // it); the `diff` carries a `source` discriminator instead, mirroring the `source`
  // key already on the `inventory.owner.propagate` meta.
  if (partitionBillingMode !== undefined || tnbSubsidyCapMonthly !== undefined) {
    const diff: Record<string, unknown> = { source: "unit-create" };
    if (partitionBillingMode !== undefined) diff.partitionBillingMode = partitionBillingMode;
    if (tnbSubsidyCapMonthly !== undefined) {
      diff.tnbSubsidyCapMonthly = tnbSubsidyCapMonthly;
    }
    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "apartment.shared.update",
      entityType: "Apartment",
      entityId: createdApartment.id,
      diff: diff as Prisma.InputJsonValue,
    });
  }

  return createdApartment;
}

const APARTMENT_OWNER_CONFLICT_MESSAGE =
  "This apartment is already owned by another party. Change the owner from Edit shared details.";

/**
 * Marker thrown by the IN-TRANSACTION owner-conflict re-check (R2-4) and mapped
 * back to the same 409 by each create service's catch. Follows the
 * `_occupancyRentRequired` convention (occupancy-tenancy-sync.ts): a PROPERTY on
 * the Error, never a `code` field — `code` is reserved for Prisma's own error
 * codes and the batch catch already branches on `err.code === "P2002"`.
 */
function apartmentOwnerConflictError(): Error {
  return Object.assign(new Error("APARTMENT_OWNER_CONFLICT"), {
    _apartmentOwnerConflict: true as const,
  });
}

function isApartmentOwnerConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _apartmentOwnerConflict?: boolean })._apartmentOwnerConflict === true
  );
}

const APARTMENT_OWNER_UNASSIGNABLE_MESSAGE =
  "This apartment has no rooms or carpark bays for the owner to be assigned to. Add at least one room first.";

/**
 * F2. Thrown by `createUnitsBatchService` when an explicit `shared.ownerPartyId`
 * survived the org+role check and both conflict guards, but there was NOTHING to
 * carry it: no room was created, and the first-owner fan-out matched zero listings
 * and zero bays. The owner would be stored nowhere at all, yet the service used to
 * answer `201 { ids: [], updatedIds: [] }` — accepted by the schema, silently
 * dropped by the service.
 *
 * Same marker-property convention as `apartmentOwnerConflictError`: a PROPERTY on the
 * Error, never a `code` field — `code` is reserved for Prisma's own error codes and
 * the batch catch already branches on `err.code === "P2002"`.
 *
 * Thrown INSIDE the transaction, so the find-or-created Apartment and any
 * `applyToExistingSiblings` shared-field write roll back with it. A request that
 * cannot store its owner stores nothing.
 */
function apartmentOwnerUnassignableError(): Error {
  return Object.assign(new Error("APARTMENT_OWNER_UNASSIGNABLE"), {
    _apartmentOwnerUnassignable: true as const,
  });
}

function isApartmentOwnerUnassignable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _apartmentOwnerUnassignable?: boolean })._apartmentOwnerUnassignable === true
  );
}

const APARTMENT_BILLING_MODE_CONFLICT_MESSAGE =
  "This apartment already uses a different utility billing model. Change it from Edit shared details.";

const APARTMENT_TNB_SUBSIDY_CAP_CONFLICT_MESSAGE =
  "This apartment already uses a different monthly TNB owner subsidy cap. Change it from Edit shared details.";

/**
 * I4. Thrown by `findOrCreateApartment` when a create carries a `partitionBillingMode`
 * that differs from the existing apartment's, and mapped back to a 409 by each create
 * service's catch. Same marker-property convention as `apartmentOwnerConflictError`: a
 * PROPERTY on the Error, never a `code` field — `code` is reserved for Prisma's own
 * error codes and the batch catch already branches on `err.code === "P2002"`.
 */
function apartmentBillingModeConflictError(): Error {
  return Object.assign(new Error("APARTMENT_BILLING_MODE_CONFLICT"), {
    _apartmentBillingModeConflict: true as const,
  });
}

function isApartmentBillingModeConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _apartmentBillingModeConflict?: boolean })._apartmentBillingModeConflict === true
  );
}

function apartmentTnbSubsidyCapConflictError(): Error {
  return Object.assign(new Error("APARTMENT_TNB_SUBSIDY_CAP_CONFLICT"), {
    _apartmentTnbSubsidyCapConflict: true as const,
  });
}

function isApartmentTnbSubsidyCapConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _apartmentTnbSubsidyCapConflict?: boolean })
      ._apartmentTnbSubsidyCapConflict === true
  );
}

/**
 * T2. Thrown INSIDE `createUnitsBatchService`'s transaction when a per-room
 * occupied submission has no owner to attribute the Tenancy to. Mirrors
 * `createUnitService`'s pre-tx `UNIT_HAS_NO_OWNER` guard (409) VERBATIM, but
 * the batch's `effectiveOwnerPartyId` is only known INSIDE the transaction
 * (it depends on the apartment's resolved owner, which itself depends on the
 * in-tx conflict re-check), so this is a marked throw + catch instead of an
 * early return. Same marker-property convention as `apartmentOwnerConflictError`.
 */
function unitHasNoOwnerError(): Error {
  return Object.assign(new Error("UNIT_HAS_NO_OWNER"), {
    _unitHasNoOwner: true as const,
  });
}

function isUnitHasNoOwner(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _unitHasNoOwner?: boolean })._unitHasNoOwner === true
  );
}

/**
 * T2. Thrown INSIDE `createUnitsBatchService`'s transaction when a per-room
 * occupied submission has no positive effective rent
 * (`room.monthlyRent ?? room.rentalRate`). Deliberately reuses the SAME
 * `_occupancyRentRequired` marker property that `syncOccupancyTenancy`'s own
 * internal throw uses (occupancy-tenancy-sync.ts, the
 * ENABLE_PHASE2_RESERVATION_GATED_TENANCY branch) so ONE catch clause below
 * maps BOTH this pre-check and the sync's own flag-gated rejection to the
 * same 400 OCCUPANCY_RENT_REQUIRED response — mirrors createUnitService's C1
 * guard + "Override C" catch exactly.
 */
function occupancyRentRequiredError(): Error {
  return Object.assign(new Error("OCCUPANCY_RENT_REQUIRED"), {
    _occupancyRentRequired: true as const,
  });
}

/**
 * T2 (orphan fix). Thrown INSIDE `createUnitsBatchService`'s transaction when a
 * per-room occupied submission is missing any of the tenancy trio
 * (tenantPartyId / moveInDate / moveOutDate). Mirrors `createUnitService`'s
 * "Finding 2" trio guard (inventory.service.ts ~L1147-1159) VERBATIM: the
 * shared-schema `occupancyTenancyRefiner` early-returns when NONE of the trio
 * fields are present, so a room carrying `occupancyStatus: "occupied"` + a rent
 * but no trio passes zod and would otherwise persist an occupied Listing with
 * NO Tenancy behind it (the orphan). createUnitService rejects that exact
 * payload with a plain-string 400; the batch must too. createUnitService uses a
 * pre-tx `return`, but the batch resolves per-room state INSIDE the transaction,
 * so this is a marked throw carrying the SAME message, mapped back to the same
 * 400 shape by the catch below.
 */
function occupancyTenantRequiredError(missing: string[]): Error {
  return Object.assign(
    new Error(
      `When marking a unit as Occupied, the following are required: ${missing.join(", ")}.`,
    ),
    { _occupancyTenantRequired: true as const },
  );
}

function isOccupancyTenantRequired(err: unknown): err is Error & { _occupancyTenantRequired: true } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _occupancyTenantRequired?: boolean })._occupancyTenantRequired === true
  );
}

/**
 * FIRST owner assignment on an apartment, fanned out exactly the way
 * `updateUnitService` does it: every non-archived sibling Listing + every
 * non-inactive Carpark bay, plus one `inventory.owner.propagate` audit — all in
 * the caller's `tx`.
 *
 * Callers must invoke this ONLY when the apartment had no owner
 * (`resolveApartmentOwnerForInheritance` returned null) and an explicit owner was
 * supplied. Re-pointing an already-owned apartment stays the exclusive job of
 * `updateApartmentSharedService` ("Edit shared details").
 *
 * `triggeredByUnitId` is the created Listing whose payload carried the owner, or
 * null on the batch `rooms: []` path where no row was created.
 *
 * Returns the affected row counts, so callers can tell an assignment that LANDED from
 * one that touched nothing. Two callers need that distinction: F2 (the batch must
 * reject an owner nothing can carry, rather than 201 while discarding it) and F4
 * (only a fan-out that actually moved rows needs the owner's ledger rebuilt).
 */
async function fanOutFirstApartmentOwner(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  orgId: string;
  apartmentId: string;
  ownerPartyId: string;
  triggeredByUnitId: string | null;
  actor: { userId: string; role: string };
}): Promise<{ listingCount: number; carparkCount: number }> {
  const { tx, orgId, apartmentId, ownerPartyId, triggeredByUnitId, actor } = args;

  const fanout = await tx.listing.updateMany({
    where: { apartmentId, organizationId: orgId, listingStatus: { not: "archived" } },
    data: { ownerPartyId },
  });
  const carparkFanout = await tx.carpark.updateMany({
    where: { apartmentId, organizationId: orgId, status: { not: "inactive" } },
    data: { ownerPartyId },
  });

  // Minor 5: a `rooms: []` batch against a BRAND-NEW apartment reaches here with both
  // updateMany calls matching zero rows — there are no siblings yet and no bays — and
  // no row was created either, so the owner ends up stored NOWHERE AT ALL. An
  // `inventory.owner.propagate` audit asserting a propagation that did not happen is
  // a false audit row. Say nothing.
  //
  // `triggeredByUnitId === null` is load-bearing, not belt-and-braces. `listingStatus`
  // is a free string on the create schema, so a create can mint an ARCHIVED Listing;
  // the fan-out's `updateMany` excludes archived rows and matches 0, yet
  // `createListingTx` already stamped the owner onto that row. Suppressing on the two
  // counts alone would erase the only audit trail of a real owner assignment. The
  // owner is unrecorded only when nothing was updated AND nothing was created.
  const counts = { listingCount: fanout.count, carparkCount: carparkFanout.count };
  if (fanout.count === 0 && carparkFanout.count === 0 && triggeredByUnitId === null) return counts;

  await recordAudit(tx, {
    organizationId: orgId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "inventory.owner.propagate",
    entityType: "Apartment",
    entityId: apartmentId,
    // `affectedCount` is LISTINGS only (unchanged -- other consumers read it).
    // `carparkAffectedCount` is additive: without it an auditor cannot tell
    // "no bays on this apartment" from "the carpark fan-out never ran".
    meta: {
      ownerPartyId,
      triggeredByUnitId,
      affectedCount: fanout.count,
      carparkAffectedCount: carparkFanout.count,
    },
  });

  return counts;
}

/**
 * Admin multi-room batch create. One Apartment row (find-or-create) +
 * N Listings as room offers. The apartment-shared fields land on the
 * Apartment row exactly once — fan-out is no longer needed because the
 * shared fields no longer live on every sibling row.
 *
 * Atomic via `$transaction` — partial success is never visible.
 */
/**
 * Enforce the commission write-once/editor guard for an occupancy save that may
 * set the two commission toggles. Mirrors createTenancyService's pre-transaction
 * guard, reusing assertCommissionWritable. `existingTenancy` is the unit's current
 * active tenancy when this save will UPDATE it in place (same tenant) — null when a
 * NEW tenancy will be created (create/batch, or a tenant change). Returns ok when
 * neither commission field is supplied (nothing to guard).
 */
async function commissionGuardForOccupiedSave(
  // `orgId` as well as `role`: assertCommissionWritable scopes its charge and
  // allocation reads by organization. InventorySession supplies both, so every
  // caller already satisfies this.
  session: { role: string; orgId: string },
  supplied: { firstMonthIsCommission?: boolean; commissionSstBearer?: "owner" | "kaen" },
  existingTenancy: { id: string; firstMonthIsCommission: boolean; commissionSstBearer: string } | null,
): Promise<{ ok: true } | { ok: false; status: 403 | 409; error: string; code: string }> {
  const { firstMonthIsCommission: fmc, commissionSstBearer: bearer } = supplied;
  if (fmc === undefined && bearer === undefined) return { ok: true };
  let changing: boolean;
  let tenancyId: string | null;
  if (existingTenancy) {
    tenancyId = existingTenancy.id;
    changing =
      (fmc !== undefined && fmc !== existingTenancy.firstMonthIsCommission) ||
      (bearer !== undefined && bearer !== existingTenancy.commissionSstBearer);
  } else {
    tenancyId = null;
    changing = fmc === true || (bearer !== undefined && bearer !== "owner");
  }
  return assertCommissionWritable(session, changing, tenancyId);
}

export async function createUnitsBatchService(
  session: InventorySession,
  input: import("@kason/shared").CreateUnitsBatchInput,
): Promise<
  | {
      ok: true;
      status: 201;
      data: { ids: string[]; updatedIds: string[] };
    }
  // `code` is a TOP-LEVEL sibling of `error` for structured 409s (Finding 1
  // APARTMENT_OWNER_CONFLICT), matching the createUnitService contract.
  // T2: `error` is also a nested-code object for the 400 OCCUPANCY_RENT_REQUIRED
  // case, mirroring createUnitService's return type — the route (POST
  // /units/batch) already branches on `typeof result.error === "object"` for
  // this exact shape.
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      error: string | { code: string; message: string };
      code?: string;
    }
> {
  // Property + org gate.
  const propertyStatus = await findPropertyStatus(
    session.orgId,
    input.shared.propertyId,
  );
  if (propertyStatus == null) {
    return { ok: false, status: 404, error: "Property not found" };
  }

  // Cross-org amenity check.
  if (input.shared.amenities && input.shared.amenities.length > 0) {
    const check = await assertAmenitiesBelongToOrgService(
      session.orgId,
      input.shared.amenities,
    );
    if (!check.ok) {
      return { ok: false, status: 400, error: check.error.message };
    }
  }

  // Reject duplicate room types in the payload before we open the txn.
  const types = input.rooms.map((r) => r.unitType.trim());
  const seen = new Set<string>();
  for (const t of types) {
    if (seen.has(t)) {
      return {
        ok: false,
        status: 409,
        error: `Duplicate unit type in submission: ${t}`,
      };
    }
    seen.add(t);
  }

  const normalizedUnitCode = input.shared.unitCode.trim();
  const db = getDb();

  // Pre-flight uniqueness check against existing Listings. Look up the
  // Apartment first (may not exist yet); if it does, see whether any of
  // the requested listingTypes already exist on it.
  if (types.length > 0) {
    const apt = await db.apartment.findFirst({
      where: {
        organizationId: session.orgId,
        propertyId: input.shared.propertyId,
        unitCode: normalizedUnitCode,
      },
      select: { id: true },
    });
    if (apt) {
      const existing = await db.listing.findMany({
        where: {
          apartmentId: apt.id,
          listingType: { in: types },
          listingStatus: { not: "archived" },
        },
        select: { listingType: true },
      });
      if (existing.length > 0) {
        return {
          ok: false,
          status: 409,
          error: `Unit code + types already exist: ${existing.map((e) => e.listingType).join(", ")}`,
        };
      }
    }
  }

  // Owner-role validation (mirrors createUnitService / updateUnitService): a
  // non-null shared owner must belong to an owner in THIS org. Runs BEFORE the
  // transaction so a rejection writes nothing. Prevents mis-attributing a
  // partition apartment's owner-billing revenue to a foreign party.
  if (input.shared.ownerPartyId != null) {
    const ownerRole = await db.partyRole.findFirst({
      where: { organizationId: session.orgId, partyId: input.shared.ownerPartyId, roleType: "owner" },
      select: { id: true },
    });
    if (!ownerRole) {
      return { ok: false, status: 400, error: "Assigned party is not an owner" };
    }

    // Finding 1: owner is APARTMENT-scoped. A batch create must never silently
    // re-point an already-owned apartment to a different party -- re-pointing stays
    // the audited fan-out writer's job (Edit shared details). Resolve the current
    // owner BEFORE the transaction and reject a differing explicit owner; a matching
    // owner or an ownerless apartment proceeds. `code` is a TOP-LEVEL sibling.
    //
    // R2-3: the guard reads the CONFLICT resolver (archived listings + inactive bays
    // included), not the inheritance resolver. The user is never trapped by this
    // 409: creating the rooms with NO owner is still allowed (no explicit owner =>
    // no conflict), after which "Edit shared details" assigns the owner and fans it
    // out across the apartment.
    const existingApt = await db.apartment.findFirst({
      where: {
        organizationId: session.orgId,
        propertyId: input.shared.propertyId,
        unitCode: normalizedUnitCode,
      },
      select: { id: true },
    });
    if (existingApt) {
      const existingOwnerPartyId = await resolveApartmentOwnerForConflict(
        db,
        session.orgId,
        existingApt.id,
      );
      if (existingOwnerPartyId && input.shared.ownerPartyId !== existingOwnerPartyId) {
        return {
          ok: false,
          status: 409,
          code: "APARTMENT_OWNER_CONFLICT",
          error: APARTMENT_OWNER_CONFLICT_MESSAGE,
        };
      }
    }
  }

  // Commission guard, per room. Each batch room materialises a NEW tenancy
  // (existingTenancy = null → editor→403; nothing to lock). Runs BEFORE the
  // transaction so a forbidden room aborts the whole batch with a clean 403.
  for (const room of input.rooms) {
    if (room.occupancyStatus === "occupied") {
      const commissionGuard = await commissionGuardForOccupiedSave(session, room, null);
      if (!commissionGuard.ok) {
        return { ok: false as const, status: commissionGuard.status, error: commissionGuard.error, code: commissionGuard.code };
      }
    }
  }

  // F4. Set to the owner when a FIRST-owner fan-out actually moved rows, so the
  // post-commit re-materialisation below can mirror `updateUnitService` and
  // `updateApartmentSharedService`. Assigned inside the transaction, read after it
  // commits — a ledger rebuild must never ride a transaction that may roll back.
  let firstOwnerFanOutPartyId: string | null = null;

  // Rooms this batch materialised a Tenancy for. Collected inside the
  // transaction, consumed AFTER it commits by the draft catch-up hook — a
  // billing follow-on must never ride a transaction that may roll back.
  let batchManagementFeeOwnerPartyId: string | null = null;
  const occupiedUnitIds: string[] = [];

  const inChargePartyId = input.shared.inChargePartyId ?? null;
  const apartmentShared = {
    bedrooms: input.shared.bedrooms ?? null,
    bathrooms: input.shared.bathrooms ?? null,
    floor: input.shared.floor ?? null,
    floorArea: input.shared.floorArea ?? null,
    amenities: input.shared.amenities ?? [],
    highlights: input.shared.highlights ?? [],
    description: input.shared.description ?? null,
  };

  try {
    const result = await db.$transaction(async (tx) => {
      const updatedIds: string[] = [];

      // Pick the first room's type to drive the Apartment.listingMode default
      // when we have to create one. If `rooms` is empty (apartment-shared-only
      // path with applyToExistingSiblings=true), use a stable fallback by
      // querying any existing sibling's listingType — the apartment already
      // exists in that case, so the default isn't read.
      const firstType = input.rooms[0]?.unitType.trim() ?? "";
      const apartment = await findOrCreateApartment({
        tx,
        orgId: session.orgId,
        propertyId: input.shared.propertyId,
        unitCode: normalizedUnitCode,
        listingType: firstType,
        shared: apartmentShared,
        partitionBillingMode: input.shared.partitionBillingMode,
        tnbSubsidyCapMonthly: input.shared.tnbSubsidyCapMonthly,
        actor: { userId: session.userId, role: session.role },
      });

      // applyToExistingSiblings used to fan out shared fields to every sibling
      // Listing row. In the new model the shared fields live on Apartment, so
      // "fan-out" reduces to a single Apartment update. We surface every
      // touched Listing's id as `updatedIds` for back-compat with the wire
      // shape — every active Listing on this Apartment is "affected" by the
      // shared-fields rewrite.
      if (input.applyToExistingSiblings) {
        await tx.apartment.update({
          where: { id: apartment.id },
          data: {
            bedrooms: apartmentShared.bedrooms,
            bathrooms: apartmentShared.bathrooms,
            floor: apartmentShared.floor,
            floorArea: apartmentShared.floorArea,
            amenities: apartmentShared.amenities,
            highlights: apartmentShared.highlights,
            publishedDescription: apartmentShared.description,
          },
        });

        const siblings = await tx.listing.findMany({
          where: {
            apartmentId: apartment.id,
            listingStatus: { not: "archived" },
          },
          select: { id: true },
        });
        for (const s of siblings) updatedIds.push(s.id);
      }

      // R2-4 (TOCTOU): the pre-transaction guard above ran on a separate
      // connection, before this transaction opened. A concurrent owner assignment
      // landing in that window would otherwise commit a SECOND owner onto the same
      // apartment silently. Re-read the conflict evidence here, immediately before
      // the stamp, and convert a violation into the same 409.
      //
      // TODO(owner-model-redesign): this NARROWS the race, it does not close it.
      // Prisma's default isolation is READ COMMITTED, so a writer committing
      // between this read and our commit is still invisible to us. Only a DB-level
      // constraint makes the invariant airtight -- move the owner onto
      // `Apartment.ownerPartyId` (step 1 of
      // docs/superpowers/specs/2026-07-09-apartment-owner-model-redesign.md).
      if (input.shared.ownerPartyId != null) {
        const concurrentOwnerPartyId = await resolveApartmentOwnerForConflict(
          tx,
          session.orgId,
          apartment.id,
        );
        if (concurrentOwnerPartyId && concurrentOwnerPartyId !== input.shared.ownerPartyId) {
          throw apartmentOwnerConflictError();
        }
      }

      // Apartment-wide owner invariant: rooms added to an already-owned
      // apartment must be born carrying that owner, else they can't be occupied
      // while their siblings can. Resolve once for the whole batch. An explicit
      // owner from the unified modal wins over the inherited one so a partition
      // apartment created from the modal never lands ownerless.
      const inheritedOwnerPartyId = await resolveApartmentOwnerForInheritance(
        tx,
        session.orgId,
        apartment.id,
      );

      // The re-check above and this read are two statements, and under READ
      // COMMITTED each takes a FRESH snapshot. A writer that committed between
      // them was invisible there but is visible HERE. `effectiveOwnerPartyId`
      // below is `??`-biased to the payload, so without this comparison the new
      // rows would be stamped with the payload owner while the siblings hold the
      // concurrent one -- two owners on one apartment, committed silently with no
      // 409 and no fan-out audit. Reject rather than stamp over it.
      if (
        input.shared.ownerPartyId != null &&
        inheritedOwnerPartyId != null &&
        input.shared.ownerPartyId !== inheritedOwnerPartyId
      ) {
        throw apartmentOwnerConflictError();
      }

      const effectiveOwnerPartyId = input.shared.ownerPartyId ?? inheritedOwnerPartyId;

      const created: string[] = [];
      for (const room of input.rooms) {
        // T2: per-room occupancy. A room submitted with occupancyStatus=
        // "occupied" must be born WITH its Tenancy in the SAME transaction as
        // the Listing create -- an "occupied" Listing with no Tenancy behind
        // it is the exact orphan createUnitService's occupied path exists to
        // prevent, and this loop must not reintroduce it per-room. A room
        // with no occupancyStatus (or "vacant") is UNCHANGED from today.
        const roomOccupancyStatus = room.occupancyStatus ?? "vacant";
        const wantsTenancy = roomOccupancyStatus === "occupied";

        // Finding 2 trio guard, ported from createUnitService (~L1147-1159)
        // VERBATIM. The shared refiner (occupancyTenancyRefiner) early-returns
        // when NONE of the trio fields are present, so a room carrying
        // occupancyStatus:"occupied" + a rent but no tenantPartyId/moveInDate/
        // moveOutDate passes zod. Without this, tx.listing.create below would
        // persist an occupied Listing with no Tenancy (the sync is gated on
        // room.tenantPartyId). Fires FIRST -- before the owner + rent gates --
        // matching createUnitService's precedence, and BEFORE tx.listing.create
        // so no orphan row is ever written. The throw rolls back every earlier
        // room + the apartment (atomic).
        if (wantsTenancy) {
          const missing: string[] = [];
          if (!room.tenantPartyId) missing.push("tenant");
          if (!room.moveInDate) missing.push("move-in date");
          if (!room.moveOutDate) missing.push("move-out date");
          if (missing.length > 0) {
            throw occupancyTenantRequiredError(missing);
          }
        }

        // Owner gate, ported from createUnitService's UNIT_HAS_NO_OWNER guard:
        // a Tenancy may only be materialised for a room whose apartment has an
        // assigned owner (owner drives money attribution). effectiveOwnerPartyId
        // is resolved once above for the whole batch -- every room in this
        // apartment gets the same value.
        if (wantsTenancy && !effectiveOwnerPartyId) {
          throw unitHasNoOwnerError();
        }

        // C1, ported from createUnitService: the rent a NEW Tenancy is born
        // with, resolved ONCE before any write. `??`, never `||` -- a
        // deliberate `monthlyRent: 0` must reject, not silently inherit a
        // positive rentalRate.
        const effectiveRent = room.monthlyRent ?? room.rentalRate;
        if (wantsTenancy && !(typeof effectiveRent === "number" && effectiveRent > 0)) {
          throw occupancyRentRequiredError();
        }

        const row = await tx.listing.create({
          data: {
            organizationId: session.orgId,
            apartmentId: apartment.id,
            listingType: room.unitType.trim(),
            occupancyStatus: roomOccupancyStatus,
            listingStatus: "draft",
            ownerPartyId: effectiveOwnerPartyId,
            currency: "MYR",
            visibilityMode: "PUBLIC",
            hiddenFromPartyIds: [],
            readyNow: false,
            inChargePartyId,
            rentalRate: room.rentalRate ?? null,
            depositMonths: room.depositMonths ?? null,
            utilitiesDepositMonths: room.utilitiesDepositMonths ?? null,
            accessCardDepositPerPcs: room.accessCardDepositPerPcs ?? null,
            accessCardQuantity: room.accessCardQuantity ?? null,
            parkingQuantity: room.parkingQuantity ?? null,
            parkingNumbers: room.parkingNumbers ?? [],
          },
          select: { id: true },
        });
        created.push(row.id);

        // Materialise the Tenancy IN THE SAME TRANSACTION as the Listing
        // write, ported from createUnitService's occupied path verbatim.
        // Audit is recorded in the same `tx`.
        if (wantsTenancy && room.tenantPartyId) {
          await syncOccupancyTenancy({
            tx,
            orgId: session.orgId,
            unit: {
              id: row.id,
              propertyId: input.shared.propertyId,
              // Prior state of a just-created row: it had no tenancy, so "vacant".
              occupancyStatus: "vacant",
              // The sync reads `unit.rentalRate` ONLY as the flag-off fallback
              // for a new tenancy's rent, so feeding it `effectiveRent` is what
              // makes the persisted rent equal the audited one.
              rentalRate: effectiveRent ?? null,
              ownerPartyId: effectiveOwnerPartyId,
            },
            incoming: {
              occupancyStatus: "occupied",
              tenantPartyId: room.tenantPartyId,
              moveInDate: room.moveInDate ? new Date(room.moveInDate) : undefined,
              moveOutDate: room.moveOutDate ? new Date(room.moveOutDate) : undefined,
              monthlyRent: room.monthlyRent,
              firstMonthIsCommission: room.firstMonthIsCommission,
              commissionSstBearer: room.commissionSstBearer,
              tenancyAgreementFeeAmount: room.tenancyAgreementFeeAmount,
              tenancyAgreementFeeDueDate: room.tenancyAgreementFeeDueDate ? new Date(room.tenancyAgreementFeeDueDate) : undefined,
            },
          });
          await recordAudit(tx, {
            organizationId: session.orgId,
            actorUserId: session.userId,
            actorRole: session.role,
            action: "inventory.unit.created_occupied",
            entityType: "Listing",
            entityId: row.id,
            // The rent that was actually PERSISTED, not the raw input --
            // mirrors createUnitService's audit meta exactly.
            meta: { tenantPartyId: room.tenantPartyId, monthlyRent: effectiveRent ?? null },
          });
          occupiedUnitIds.push(row.id);
        }
      }

      // R2-1: this batch supplied the apartment's FIRST owner. Stamping only the
      // rows we just created would leave the pre-existing siblings and carpark bays
      // ownerless -- they would 409 UNIT_HAS_NO_OWNER on occupancy while the new
      // rooms occupied fine, and no `inventory.owner.propagate` audit would exist.
      // Fan out exactly as updateUnitService does. On the `rooms: []` path this is
      // what stops the validated `shared.ownerPartyId` being silently discarded.
      //
      // Only on FIRST assignment: when `inheritedOwnerPartyId` is non-null the
      // equality check at the inheritance read (not the earlier re-check, which
      // proved it only at ITS snapshot) established that the payload owner matches
      // it, so every active row carries it. Never re-point -- that stays
      // updateApartmentSharedService's job. The updateMany runs AFTER the creates so
      // the new rows are included in `affectedCount`; they already carry the same
      // owner, so it is idempotent.
      if (input.shared.ownerPartyId != null && inheritedOwnerPartyId == null) {
        const counts = await fanOutFirstApartmentOwner({
          tx,
          orgId: session.orgId,
          apartmentId: apartment.id,
          ownerPartyId: input.shared.ownerPartyId,
          triggeredByUnitId: created[0] ?? null,
          actor: { userId: session.userId, role: session.role },
        });

        // F2: the owner passed the org+role check and both conflict guards, and then
        // landed on NOTHING -- no room was created, no sibling was updated, no bay was
        // updated. `rooms: []` against a brand-new (or all-archived, bay-less)
        // apartment is the shape that gets here. Returning 201 would report success
        // for an owner the service discarded; reject instead. The throw rolls back the
        // find-or-created Apartment too, so the request stores nothing at all.
        //
        // Scoped to the FIRST-assignment branch on purpose. When `inheritedOwnerPartyId`
        // is non-null the fan-out never runs, and a `rooms: []` request naming that same
        // owner is a truthful no-op: the apartment's active rows already carry it. That
        // request must still 201. Widening this check to "the fan-out moved no rows"
        // would 409 it.
        if (counts.listingCount === 0 && counts.carparkCount === 0 && created.length === 0) {
          throw apartmentOwnerUnassignableError();
        }

        // F4: rows changed hands. Their charges now foot to this owner, so the owner's
        // UnitMonthLedger months must be rebuilt -- exactly as they are when the same
        // assignment is made from unit-edit or "Edit shared details". Recorded here,
        // executed after commit.
        if (counts.listingCount > 0 || counts.carparkCount > 0) {
          firstOwnerFanOutPartyId = input.shared.ownerPartyId;
        }
      }

      // Persist the apartment and its management-fee terms in one transaction.
      // Previously the browser made a second POST after creating the rooms; if
      // that request failed, Billing could only show RM0.00 / setup required.
      const managementFeeConfig = input.shared.managementFeeConfig;
      if (managementFeeConfig) {
        if (!effectiveOwnerPartyId) {
          throw unitHasNoOwnerError();
        }
        await tx.managementFeeConfig.updateMany({
          where: {
            organizationId: session.orgId,
            apartmentId: apartment.id,
            isActive: true,
          },
          data: { isActive: false, effectiveTo: new Date() },
        });
        const feeConfig = await tx.managementFeeConfig.create({
          data: {
            organizationId: session.orgId,
            ownerPartyId: effectiveOwnerPartyId,
            propertyId: input.shared.propertyId,
            apartmentId: apartment.id,
            feeType: managementFeeConfig.feeType,
            feeValue: managementFeeConfig.feeValue,
            capAmount: managementFeeConfig.capAmount ?? null,
            sstPercent: "8",
            freePeriodStart: managementFeeConfig.freePeriodStart
              ? new Date(managementFeeConfig.freePeriodStart)
              : null,
            freePeriodEnd: managementFeeConfig.freePeriodEnd
              ? new Date(managementFeeConfig.freePeriodEnd)
              : null,
            firstChargeMonth: managementFeeConfig.firstChargeMonth
              ? new Date(managementFeeConfig.firstChargeMonth)
              : null,
            firstChargeBaseAmount: managementFeeConfig.firstChargeBaseAmount ?? null,
            paxDeductionPerPerson: managementFeeConfig.paxDeductionPerPerson ?? null,
            isActive: true,
          },
          select: { id: true },
        });
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "owner_billing.fee_config.created_with_unit_batch",
          entityType: "ManagementFeeConfig",
          entityId: feeConfig.id,
          meta: { apartmentId: apartment.id, ownerPartyId: effectiveOwnerPartyId },
        });
        batchManagementFeeOwnerPartyId = effectiveOwnerPartyId;
      }

      return { ids: created, updatedIds, apartmentId: apartment.id };
    });

    // F4: post-commit, mirroring `updateUnitService` (inventory.service.ts) and
    // `updateApartmentSharedService` (apartment.service.ts). Only the NEW owner needs a
    // rebuild: this is a FIRST assignment, so by definition no previous owner held these
    // rows. The helper self-gates on ENABLE_UNIT_MONTH_LEDGER and is a no-op while dark.
    if (firstOwnerFanOutPartyId) {
      const sysCtx: OwnerBillingActorCtx = {
        orgId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role as OwnerBillingActorCtx["actorRole"],
      };
      await rematerializeOwnerRecentMonths(sysCtx, firstOwnerFanOutPartyId, new Date());
    }
    if (
      batchManagementFeeOwnerPartyId &&
      batchManagementFeeOwnerPartyId !== firstOwnerFanOutPartyId
    ) {
      const sysCtx: OwnerBillingActorCtx = {
        orgId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role as OwnerBillingActorCtx["actorRole"],
      };
      await rematerializeOwnerRecentMonths(
        sysCtx,
        batchManagementFeeOwnerPartyId,
        new Date(),
      );
    }

    // Post-commit, never-throws: rooms created already-occupied missed this
    // period's draft run — catch each new tenancy up into the approval queue.
    for (const occupiedUnitId of occupiedUnitIds) {
      await draftCatchupForUnit(session, occupiedUnitId);
      await createTenancyDepositsForUnit(session, occupiedUnitId);
    }

    return { ok: true, status: 201, data: result };
  } catch (err: unknown) {
    // R2-4: the in-transaction conflict re-check threw. The transaction has already
    // rolled back, so we return the same 409 the pre-tx guard returns.
    if (isApartmentOwnerConflict(err)) {
      return {
        ok: false,
        status: 409,
        code: "APARTMENT_OWNER_CONFLICT",
        error: APARTMENT_OWNER_CONFLICT_MESSAGE,
      };
    }
    // F2: an explicit owner that nothing could carry. The transaction has already
    // rolled back — no apartment, no shared-field write, no listings, no audit.
    if (isApartmentOwnerUnassignable(err)) {
      return {
        ok: false,
        status: 409,
        code: "APARTMENT_OWNER_UNASSIGNABLE",
        error: APARTMENT_OWNER_UNASSIGNABLE_MESSAGE,
      };
    }
    // I4: `findOrCreateApartment` refused to rewrite an existing apartment's
    // billing mode. The transaction has already rolled back — no apartment update,
    // no shared-field write, no listings.
    if (isApartmentBillingModeConflict(err)) {
      return {
        ok: false,
        status: 409,
        code: "APARTMENT_BILLING_MODE_CONFLICT",
        error: APARTMENT_BILLING_MODE_CONFLICT_MESSAGE,
      };
    }
    if (isApartmentTnbSubsidyCapConflict(err)) {
      return {
        ok: false,
        status: 409,
        code: "APARTMENT_TNB_SUBSIDY_CAP_CONFLICT",
        error: APARTMENT_TNB_SUBSIDY_CAP_CONFLICT_MESSAGE,
      };
    }
    // T2 (orphan fix): a per-room occupied submission was missing part of the
    // tenancy trio. The transaction rolled back, so no orphan occupied Listing
    // was persisted for ANY room. Same plain-string 400 shape and message
    // createUnitService's "Finding 2" guard returns.
    if (isOccupancyTenantRequired(err)) {
      return {
        ok: false,
        status: 400,
        error: err.message,
      };
    }
    // T2: a per-room occupied guard threw inside the loop. The transaction has
    // already rolled back — no apartment, no shared-field write, no listings,
    // no tenancy, no audit for ANY room in this batch (atomic: one room's
    // failure rolls back every room + the apartment). Same 409 shape as
    // createUnitService's pre-tx UNIT_HAS_NO_OWNER guard.
    if (isUnitHasNoOwner(err)) {
      return {
        ok: false,
        status: 409,
        code: "UNIT_HAS_NO_OWNER",
        error: "This unit has no assigned owner. Assign an owner before marking it occupied.",
      };
    }
    // T2 / Override C: either this loop's own effectiveRent pre-check threw, or
    // syncOccupancyTenancy threw its OWN marked error when the reservation-gated
    // flag is on and no explicit rent was supplied for a NEW tenancy. Surface it
    // as a clean 400 instead of letting it reach the global 500 handler — this is
    // a routine validation failure. Same shape as createUnitService's catch.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { _occupancyRentRequired?: boolean })._occupancyRentRequired
    ) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "OCCUPANCY_RENT_REQUIRED",
          message: "Enter the monthly rent before marking this unit occupied.",
        },
      };
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        status: 409,
        error: "Some listing types already exist for this apartment",
      };
    }
    throw err;
  }
}

export async function createUnitService(
  session: InventorySession,
  input: z.infer<typeof createUnitSchema>,
) {
  // Cross-org isolation invariant: any amenity ID supplied must belong to
  // this org's amenity catalog. Run BEFORE any DB write so a rejection
  // leaves no partial state behind. Skip when amenities is empty/absent.
  if (input.amenities && input.amenities.length > 0) {
    const check = await assertAmenitiesBelongToOrgService(session.orgId, input.amenities);
    if (!check.ok) return { ok: false as const, status: check.status, error: check.error };
  }

  // Fetch the parent property's status in the same logical operation so
  // deriveReadyNow can include it.
  const propertyStatus = await findPropertyStatus(session.orgId, input.propertyId);
  if (propertyStatus == null) {
    return { ok: false as const, status: 404, error: "Property not found" };
  }

  const normalizedUnitCode = input.unitCode.trim();
  const normalizedUnitType = input.unitType.trim();
  const db = getDb();

  // Look up the apartment first to scope the conflict check. The new unique
  // constraint is (apartmentId, listingType) — we still need to compute
  // an apartment id (or absence-of) BEFORE we can check.
  const existingApartment = await db.apartment.findFirst({
    where: {
      organizationId: session.orgId,
      propertyId: input.propertyId,
      unitCode: normalizedUnitCode,
    },
    select: { id: true },
  });
  if (existingApartment) {
    const conflict = await findListingTypeConflict({
      apartmentId: existingApartment.id,
      listingType: normalizedUnitType,
    });
    if (conflict) {
      return {
        ok: false as const,
        status: 409,
        error: "A unit with this code and unit type already exists in this property.",
      };
    }
  }

  // Kind-mismatch guard: reject if the incoming unitType's kind conflicts with
  // the mode already established by sibling listings in this group.
  const attemptedKind = await resolveRoomTypeKind(session.orgId, normalizedUnitType);
  if (attemptedKind) {
    const currentMode = await getUnitGroupMode(session.orgId, input.propertyId, normalizedUnitCode);
    if (currentMode && currentMode !== "MIXED") {
      const required = currentMode === "WHOLE" ? "WHOLE" : "PARTITION";
      if (attemptedKind !== required) {
        return {
          ok: false as const,
          status: 400 as const,
          error: {
            code: "LISTING_MODE_MISMATCH" as const,
            currentMode,
            attemptedKind,
          },
        };
      }
    }
  }

  // Finding 2: an occupied create REQUIRES the full tenancy trio, mirroring
  // updateUnitService's transitioningToOccupied gate (a just-created row is
  // definitionally a vacant->occupied transition). Without this, the shared-schema
  // refiner lets a trio-less `occupancyStatus:"occupied"` payload through and we'd
  // persist an occupied Listing with no Tenancy behind it. Same 400 shape and
  // message as the update path.
  //
  // Scope of that guarantee: this closes the occupied-without-tenancy orphan IN THE
  // TWO CREATE SERVICES (createUnitService, createUnitsBatchService) and in
  // updateUnitService -- NOT repo-wide. `submissions/submission.service.ts` still
  // persists `{ occupancyStatus: "vacant", ...listingPayload }` (the spread lands
  // after the default, so a payload carrying "occupied" wins) and never calls
  // syncOccupancyTenancy. That portal submission-approval path can still create an
  // occupied Listing with no Tenancy; it is pre-existing and out of this task's
  // charter, and needs its own fix.
  if (input.occupancyStatus === "occupied") {
    const missing: string[] = [];
    if (!input.tenantPartyId) missing.push("tenant");
    if (!input.moveInDate) missing.push("move-in date");
    if (!input.moveOutDate) missing.push("move-out date");
    if (missing.length > 0) {
      return {
        ok: false as const,
        status: 400 as const,
        error: `When marking a unit as Occupied, the following are required: ${missing.join(", ")}.`,
      };
    }
    // Commission guard (new unit → no existing tenancy). Editor→403, and there is
    // nothing to lock yet. Runs BEFORE the transaction, mirroring createTenancyService.
    const commissionGuard = await commissionGuardForOccupiedSave(session, input, null);
    if (!commissionGuard.ok) {
      return { ok: false as const, status: commissionGuard.status, error: commissionGuard.error, code: commissionGuard.code };
    }
  }

  // Owner-role validation: a non-null ownerPartyId must belong to an owner in
  // THIS org. A bare z.string().uuid() cannot prove org membership or role, and a
  // foreign partyId here would mis-attribute owner-billing revenue. Mirrors
  // updateUnitService and apartment.service.ts. Runs BEFORE the transaction.
  if (input.ownerPartyId != null) {
    const ownerRole = await db.partyRole.findFirst({
      where: { organizationId: session.orgId, partyId: input.ownerPartyId, roleType: "owner" },
      select: { id: true },
    });
    if (!ownerRole) {
      return { ok: false as const, status: 400 as const, error: "Assigned party is not an owner" };
    }
  }
  if (input.managementFeeConfig && input.ownerPartyId == null) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "Assign an owner before configuring the management fee.",
    };
  }

  // Resolve the apartment's CURRENT owner ONCE, before the transaction, so a
  // rejection returns before the transaction opens. Null for a brand-new /
  // ownerless apartment.
  //
  // R2-3: the two guards below need DIFFERENT scans and must not share one.
  //  - `existingOwnerPartyId` is the INHERITANCE source (active rows only). It
  //    answers "what owner would this room be born with", which is what the
  //    no-owner guard needs. An archived row's owner can be stale, and inheriting
  //    it would stamp a previous landlord onto the new room.
  //  - `conflictOwnerPartyId` is the CONFLICT evidence (archived listings and
  //    inactive bays too). It answers "does anything say this apartment is already
  //    owned", which is what the re-point guard needs.
  const existingOwnerPartyId = existingApartment
    ? await resolveApartmentOwnerForInheritance(db, session.orgId, existingApartment.id)
    : null;
  const conflictOwnerPartyId = existingApartment
    ? await resolveApartmentOwnerForConflict(db, session.orgId, existingApartment.id)
    : null;

  // Finding 1: owner is APARTMENT-scoped ("one landlord per physical apartment").
  // Adding a room must never silently re-point an apartment's owner to a different
  // party -- that would move an apartment's revenue with no audit and no fan-out to
  // the siblings/carpark bays. Re-pointing stays the exclusive job of the audited
  // fan-out writer (updateApartmentSharedService "Edit shared details"). Same
  // owner, or an ownerless apartment, proceeds. `code` is a TOP-LEVEL sibling of
  // `error` (same shape as UNIT_HAS_NO_OWNER; the POST /units route surfaces it).
  //
  // The user is never trapped by this 409: creating the room with NO owner is still
  // allowed (no explicit owner => no conflict), after which "Edit shared details"
  // assigns the owner and fans it out across the apartment.
  if (input.ownerPartyId && conflictOwnerPartyId && input.ownerPartyId !== conflictOwnerPartyId) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "APARTMENT_OWNER_CONFLICT" as const,
      error: APARTMENT_OWNER_CONFLICT_MESSAGE,
    };
  }

  // A Tenancy may only be materialised for a unit with an assigned owner (owner
  // drives money attribution -- rent/charges/ledger are keyed on the owner). The
  // effective owner is the explicit modal value, else the owner already on this
  // apartment (a room added to an owned apartment inherits it). Fires for ANY
  // occupied create (Finding 2). Check BEFORE the transaction so a rejection writes
  // nothing at all. Mirrors updateUnitService's pre-tx UNIT_HAS_NO_OWNER guard;
  // `code` is a TOP-LEVEL sibling of `error`.
  const wantsTenancy = input.occupancyStatus === "occupied";
  if (wantsTenancy && !input.ownerPartyId && !existingOwnerPartyId) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "UNIT_HAS_NO_OWNER" as const,
      error: "This unit has no assigned owner. Assign an owner before marking it occupied.",
    };
  }

  // C1: the rent a NEW Tenancy is born with, resolved ONCE, before any write.
  //
  // `monthlyRent` and `rentalRate` are independently optional on the create schema.
  // With ENABLE_PHASE2_RESERVATION_GATED_TENANCY off (its state in every local .env
  // and in client production) syncOccupancyTenancy takes `unit.rentalRate ?? 0` for a
  // new tenancy, so an occupied create carrying `monthlyRent: 3000` and no
  // `rentalRate` persisted `Tenancy.monthlyRentAmount = 0` while the
  // `inventory.unit.created_occupied` audit recorded 3000 -- a false audit row, the
  // one class of defect that cannot be repaired after the fact.
  //
  // `effectiveRent` is BOTH the value handed to the sync (as `unit.rentalRate`, which
  // that helper reads only as the new tenancy's rent) AND the value the audit
  // records, so the two cannot drift. The explicit `monthlyRent` wins over the
  // advertised `rentalRate`, matching what the flag-ON branch of the sync already
  // does -- otherwise the persisted rent would depend on the flag while the audit did
  // not.
  //
  // `??`, never `||`: a deliberate `monthlyRent: 0` must reject, not silently inherit
  // a positive `rentalRate`.
  //
  // Rejecting rather than defaulting to 0 breaks nothing that previously worked:
  // pre-Task-2 this exact payload produced the occupied-Listing-with-no-Tenancy
  // orphan this task exists to eliminate. The guard sits AFTER the UNIT_HAS_NO_OWNER
  // check on purpose, so a payload violating both still receives today's 409.
  const effectiveRent = input.monthlyRent ?? input.rentalRate;
  if (wantsTenancy && !(typeof effectiveRent === "number" && effectiveRent > 0)) {
    return {
      ok: false as const,
      status: 400 as const,
      error: {
        code: "OCCUPANCY_RENT_REQUIRED" as const,
        message: "Enter the monthly rent before marking this unit occupied.",
      },
    };
  }

  // 1. Coerce to draft when required-for-publish fields are missing.
  // 2. Empty-string coercion for nullable String columns (description).
  const coercion = coerceToDraftIfIncomplete(input);
  const cleaned = coerceEmptyStringToNull(coercion.effectiveInput, ["description"]);

  // Peel off the apartment-shared fields (now on Apartment) and the
  // property-scoped pax-deduction / side-table grant fields. The
  // remaining fields go to the Listing row.
  const {
    hasPaxDeduction,
    paxDeductionAmount,
    grantedPartyIds,
    bedrooms,
    bathrooms,
    floor,
    floorArea,
    amenities,
    highlights,
    description,
    propertyId: _propertyId,
    unitCode: _unitCode,
    unitType: _unitType,
    // Sales-side flag kept in the legacy schema; ignored by the rental write.
    sourceFlag: _sourceFlag,
    tnbSubsidyCapMonthly,
    managementFeeConfig,
    ...listingFields
  } = cleaned;
  void _propertyId; void _unitCode; void _unitType; void _sourceFlag;

  // 3. Derive readyNow from the canonical lifecycle columns. Whatever
  //    the client tried to send for readyNow (the schema doesn't surface
  //    it, but we still defensively recompute) is overwritten here.
  const occupancyStatus = listingFields.occupancyStatus ?? "vacant";
  const listingStatus = listingFields.listingStatus ?? "draft";
  const visibilityMode = listingFields.visibilityMode ?? "PUBLIC";
  const readyNow = deriveReadyNow({
    propertyStatus,
    listingStatus,
    visibilityMode,
    occupancyStatus,
  });

  // F4. Set to the owner when a FIRST-owner fan-out actually moved rows, so the
  // post-commit re-materialisation below can mirror `updateUnitService` and
  // `updateApartmentSharedService`. Assigned inside the transaction, read after it
  // commits — a ledger rebuild must never ride a transaction that may roll back.
  let firstOwnerFanOutPartyId: string | null = null;
  let managementFeeOwnerPartyId: string | null = null;

  // Find-or-create the apartment inside a single transaction with the
  // listing create so partial state is never visible.
  let created: Awaited<ReturnType<typeof createListingTx>>;
  try {
    created = await db.$transaction(async (tx) => {
    const apartment = await findOrCreateApartment({
      tx,
      orgId: session.orgId,
      propertyId: input.propertyId,
      unitCode: normalizedUnitCode,
      listingType: normalizedUnitType,
      shared: { bedrooms, bathrooms, floor, floorArea, amenities, highlights, description },
      partitionBillingMode: input.partitionBillingMode,
      tnbSubsidyCapMonthly,
      actor: { userId: session.userId, role: session.role },
    });

    // R2-4 (TOCTOU): the pre-transaction guard ran on a separate connection before
    // this transaction opened. A concurrent owner assignment landing in that window
    // would otherwise commit a SECOND owner onto the same apartment silently -- no
    // 409, no 500, no rollback. Re-read the conflict evidence here, immediately
    // before the stamp, and convert a violation into the same 409.
    //
    // TODO(owner-model-redesign): this NARROWS the race, it does not close it.
    // Prisma's default isolation is READ COMMITTED, so a writer committing between
    // this read and our commit is still invisible to us. Only a DB-level constraint
    // makes the invariant airtight -- move the owner onto `Apartment.ownerPartyId`
    // (step 1 of
    // docs/superpowers/specs/2026-07-09-apartment-owner-model-redesign.md).
    if (input.ownerPartyId) {
      const concurrentOwnerPartyId = await resolveApartmentOwnerForConflict(
        tx,
        session.orgId,
        apartment.id,
      );
      if (concurrentOwnerPartyId && concurrentOwnerPartyId !== input.ownerPartyId) {
        throw apartmentOwnerConflictError();
      }
    }

    // Apartment-wide owner invariant: a room added to an already-owned
    // apartment must inherit that owner, else it can't be occupied while its
    // siblings can (UNIT_HAS_NO_OWNER). Null when the apartment has no owner yet.
    const inheritedOwnerPartyId = await resolveApartmentOwnerForInheritance(
      tx,
      session.orgId,
      apartment.id,
    );

    // The re-check above and this read are two statements, and under READ COMMITTED
    // each takes a FRESH snapshot. A writer that committed between them was
    // invisible there but is visible HERE. `effectiveOwnerPartyId` below is
    // `??`-biased to the payload, so without this comparison the new row would be
    // stamped with the payload owner while the siblings hold the concurrent one --
    // two owners on one apartment, committed silently with no 409 and no fan-out
    // audit. Reject rather than stamp over it.
    if (
      input.ownerPartyId != null &&
      inheritedOwnerPartyId != null &&
      input.ownerPartyId !== inheritedOwnerPartyId
    ) {
      throw apartmentOwnerConflictError();
    }

    // Explicit owner from the unified modal wins; fall back to the owner already
    // on this apartment (adding a room to an owned apartment).
    const effectiveOwnerPartyId = input.ownerPartyId ?? inheritedOwnerPartyId;

    // Must use the tx-bound variant: `apartment` was just created inside
    // `tx` and is not visible to a fresh `getDb()` connection. The non-tx
    // helper would trigger Unit_apartmentId_fkey (B4 admin-create 500).
    const createdListing = await createListingTx(tx, {
      organizationId: session.orgId,
      apartmentId: apartment.id,
      listingType: normalizedUnitType,
      rentalRate: listingFields.rentalRate,
      occupancyStatus,
      listingStatus,
      ownerPartyId: effectiveOwnerPartyId,
      visibilityMode,
      hiddenFromPartyIds: listingFields.hiddenFromPartyIds,
      inChargePartyId: listingFields.inChargePartyId ?? null,
      depositMonths: listingFields.depositMonths,
      utilitiesDepositMonths: listingFields.utilitiesDepositMonths,
      accessCardDepositPerPcs: listingFields.accessCardDepositPerPcs,
      accessCardQuantity: listingFields.accessCardQuantity,
      parkingQuantity: listingFields.parkingQuantity,
      parkingNumbers: listingFields.parkingNumbers,
      readyNow,
    });

    // R2-1: this create supplied the apartment's FIRST owner. Stamping only the row
    // we just created would leave the pre-existing siblings and carpark bays
    // ownerless -- they would 409 UNIT_HAS_NO_OWNER on occupancy while the new room
    // occupied fine (a half-owned apartment), and no `inventory.owner.propagate`
    // audit would exist. Fan out exactly as updateUnitService does.
    //
    // Only on FIRST assignment: when `inheritedOwnerPartyId` is non-null the
    // equality check at the inheritance read (not the earlier re-check, which proved
    // it only at ITS snapshot) established that the payload owner matches it, so
    // every active row carries it. Never re-point -- that stays
    // updateApartmentSharedService's job. The updateMany runs AFTER the create so the
    // new row is included in `affectedCount`; it already carries the same owner, so
    // it is idempotent.
    if (input.ownerPartyId && inheritedOwnerPartyId == null) {
      const counts = await fanOutFirstApartmentOwner({
        tx,
        orgId: session.orgId,
        apartmentId: apartment.id,
        ownerPartyId: input.ownerPartyId,
        triggeredByUnitId: createdListing.id,
        actor: { userId: session.userId, role: session.role },
      });

      // F4: pre-existing rows changed hands. Their charges now foot to this owner, so
      // the owner's UnitMonthLedger months must be rebuilt -- exactly as they are when
      // the same assignment is made from unit-edit or "Edit shared details". Zero counts
      // means only the just-created row carries the owner (the archived-create edge), and
      // a row created moments ago has no charges to re-attribute. Recorded here, executed
      // after commit.
      if (counts.listingCount > 0 || counts.carparkCount > 0) {
        firstOwnerFanOutPartyId = input.ownerPartyId;
      }
    }

    // The unit and its commercial terms must either both exist or neither
    // exist.  This replaces the former client-side second POST, which could be
    // rejected after the Listing had already committed and was the source of
    // RM0.00 / "Management fee setup required" rows in the Billing grid.
    if (managementFeeConfig && effectiveOwnerPartyId) {
      await tx.managementFeeConfig.updateMany({
        where: {
          organizationId: session.orgId,
          apartmentId: apartment.id,
          isActive: true,
        },
        data: { isActive: false, effectiveTo: new Date() },
      });
      const feeConfig = await tx.managementFeeConfig.create({
        data: {
          organizationId: session.orgId,
          ownerPartyId: effectiveOwnerPartyId,
          propertyId: input.propertyId,
          apartmentId: apartment.id,
          feeType: managementFeeConfig.feeType,
          feeValue: managementFeeConfig.feeValue,
          capAmount: managementFeeConfig.capAmount ?? null,
          // KAEN management fees are always subject to 8% SST.
          sstPercent: "8",
          freePeriodStart: managementFeeConfig.freePeriodStart
            ? new Date(managementFeeConfig.freePeriodStart)
            : null,
          freePeriodEnd: managementFeeConfig.freePeriodEnd
            ? new Date(managementFeeConfig.freePeriodEnd)
            : null,
          firstChargeMonth: managementFeeConfig.firstChargeMonth
            ? new Date(managementFeeConfig.firstChargeMonth)
            : null,
          firstChargeBaseAmount: managementFeeConfig.firstChargeBaseAmount ?? null,
          paxDeductionPerPerson: managementFeeConfig.paxDeductionPerPerson ?? null,
          isActive: true,
        },
        select: { id: true },
      });
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "owner_billing.fee_config.created_with_unit",
        entityType: "ManagementFeeConfig",
        entityId: feeConfig.id,
        meta: { apartmentId: apartment.id, ownerPartyId: effectiveOwnerPartyId },
      });
      managementFeeOwnerPartyId = effectiveOwnerPartyId;
    }

    // Materialise the Tenancy IN THE SAME TRANSACTION as the Apartment + Listing
    // writes, so a failure rolls all three back together -- an "occupied" Listing
    // with no Tenancy behind it (the bug this fixes) is never persistable. Mirrors
    // updateUnitService's occupied path; audit is recorded in the same `tx`.
    if (input.occupancyStatus === "occupied" && input.tenantPartyId) {
      await syncOccupancyTenancy({
        tx,
        orgId: session.orgId,
        unit: {
          id: createdListing.id,
          propertyId: input.propertyId,
          // Prior state of a just-created row: it had no tenancy, so "vacant".
          occupancyStatus: "vacant",
          // C1: the sync reads `unit.rentalRate` ONLY as the flag-off fallback for a
          // new tenancy's rent, so feeding it `effectiveRent` is what makes the
          // persisted rent equal the audited one. `Listing.rentalRate` is written
          // separately by `createListingTx` above and is deliberately unchanged.
          rentalRate: effectiveRent ?? null,
          ownerPartyId: effectiveOwnerPartyId,
        },
        incoming: {
          occupancyStatus: "occupied",
          tenantPartyId: input.tenantPartyId,
          moveInDate: input.moveInDate ? new Date(input.moveInDate) : undefined,
          moveOutDate: input.moveOutDate ? new Date(input.moveOutDate) : undefined,
          monthlyRent: input.monthlyRent,
          firstMonthIsCommission: input.firstMonthIsCommission,
          commissionSstBearer: input.commissionSstBearer,
          tenancyAgreementFeeAmount: input.tenancyAgreementFeeAmount,
          tenancyAgreementFeeDueDate: input.tenancyAgreementFeeDueDate ? new Date(input.tenancyAgreementFeeDueDate) : undefined,
        },
      });
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "inventory.unit.created_occupied",
        entityType: "Listing",
        entityId: createdListing.id,
        // C1: the rent that was actually PERSISTED, not the raw input. Both flag
        // branches of the sync now settle on `effectiveRent`, so this row can never
        // again assert a number the Tenancy does not carry.
        meta: { tenantPartyId: input.tenantPartyId, monthlyRent: effectiveRent ?? null },
      });
    }

    return createdListing;
    });
  } catch (err: unknown) {
    // R2-4: the in-transaction conflict re-check threw. The transaction has already
    // rolled back, so we return the same 409 the pre-tx guard returns.
    if (isApartmentOwnerConflict(err)) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "APARTMENT_OWNER_CONFLICT" as const,
        error: APARTMENT_OWNER_CONFLICT_MESSAGE,
      };
    }
    // I4: `findOrCreateApartment` refused to rewrite an existing apartment's
    // billing mode. The transaction has already rolled back — no apartment update,
    // no listing, no tenancy.
    if (isApartmentBillingModeConflict(err)) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "APARTMENT_BILLING_MODE_CONFLICT" as const,
        error: APARTMENT_BILLING_MODE_CONFLICT_MESSAGE,
      };
    }
    if (isApartmentTnbSubsidyCapConflict(err)) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "APARTMENT_TNB_SUBSIDY_CAP_CONFLICT" as const,
        error: APARTMENT_TNB_SUBSIDY_CAP_CONFLICT_MESSAGE,
      };
    }
    // Override C: syncOccupancyTenancy throws a marked error when the
    // reservation-gated flag is on and no explicit rent was supplied for a NEW
    // tenancy. Surface it as a clean 400 instead of letting it reach the global
    // 500 handler -- this is a routine validation failure. The catch sits
    // OUTSIDE $transaction, so the Apartment + Listing + Tenancy writes are all
    // rolled back before we return. The "no owner" / "not a tenant" defence-in-
    // depth throws stay UNCAUGHT here, matching updateUnitService.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { _occupancyRentRequired?: boolean })._occupancyRentRequired
    ) {
      return {
        ok: false as const,
        status: 400 as const,
        error: {
          code: "OCCUPANCY_RENT_REQUIRED" as const,
          message: "Enter the monthly rent before marking this unit occupied.",
        },
      };
    }
    throw err;
  }

  if (hasPaxDeduction !== undefined || paxDeductionAmount !== undefined) {
    await updatePropertyPaxDeduction(input.propertyId, session.orgId, {
      hasPaxDeduction,
      paxDeductionAmount,
    });
  }

  // Sync ListingVisibilityGrant rows. PUBLIC mode forces an empty
  // allowlist; RESTRICTED mode replace-sets to the provided list.
  if (visibilityMode === "PUBLIC") {
    await replaceVisibilityGrants({
      organizationId: session.orgId,
      listingId: created.id,
      partyIds: [],
      grantedById: session.userId,
    });
  } else if (grantedPartyIds !== undefined) {
    await replaceVisibilityGrants({
      organizationId: session.orgId,
      listingId: created.id,
      partyIds: grantedPartyIds,
      grantedById: session.userId,
    });
  }

  // F4: post-commit, mirroring `updateUnitService` below and
  // `updateApartmentSharedService` (apartment.service.ts). Only the NEW owner needs a
  // rebuild: this is a FIRST assignment, so by definition no previous owner held these
  // rows. The helper self-gates on ENABLE_UNIT_MONTH_LEDGER and is a no-op while dark.
  if (firstOwnerFanOutPartyId) {
    const sysCtx: OwnerBillingActorCtx = {
      orgId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role as OwnerBillingActorCtx["actorRole"],
    };
    await rematerializeOwnerRecentMonths(sysCtx, firstOwnerFanOutPartyId, new Date());
  }
  if (managementFeeOwnerPartyId && managementFeeOwnerPartyId !== firstOwnerFanOutPartyId) {
    const sysCtx: OwnerBillingActorCtx = {
      orgId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role as OwnerBillingActorCtx["actorRole"],
    };
    await rematerializeOwnerRecentMonths(sysCtx, managementFeeOwnerPartyId, new Date());
  }

  // Post-commit, never-throws: a unit created already-occupied missed this
  // period's draft run — catch its new tenancy up into the approval queue.
  if (input.occupancyStatus === "occupied" && input.tenantPartyId) {
    await draftCatchupForUnit(session, created.id);
    await createTenancyDepositsForUnit(session, created.id);
  }

  return {
    ok: true as const,
    status: 201,
    data: created,
    coercedToDraft: coercion.coerced,
    missingFields: coercion.missing as readonly string[],
  };
}

export async function getInventoryUnitByIdService(
  session: InventorySession,
  unitId: string,
) {
  const unit = await findUnitDetail(session.orgId, unitId);
  if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  return { ok: true as const, status: 200, data: unit };
}

export async function updateUnitService(
  session: InventorySession,
  input: z.infer<typeof updateUnitSchema>,
) {
  // Cross-org isolation invariant: any amenity ID supplied must belong to
  // this org's amenity catalog.
  if (input.amenities && input.amenities.length > 0) {
    const check = await assertAmenitiesBelongToOrgService(session.orgId, input.amenities);
    if (!check.ok) return { ok: false as const, status: check.status, error: check.error };
  }

  const existing = await findListingById(session.orgId, input.unitId);
  if (!existing) return { ok: false as const, status: 404, error: "Unit not found" };

  // unitCode rename / re-parenting is no longer something this surface does.
  // unitCode lives on Apartment; the dialog cannot move a Listing to a new
  // Apartment via this endpoint. We tolerate the field in the payload (the
  // legacy schema still includes it) and assert the trimmed value matches
  // the parent Apartment's unitCode before continuing.
  const nextUnitCode =
    input.unitCode !== undefined ? input.unitCode.trim() : existing.unitCode;
  const nextUnitType =
    input.unitType !== undefined ? input.unitType.trim() : existing.unitType;

  if (input.unitCode !== undefined && nextUnitCode !== existing.unitCode) {
    return {
      ok: false as const,
      status: 400,
      error:
        "unitCode is owned by the parent Apartment and cannot be changed via this endpoint.",
    };
  }

  // listingType change → conflict check on (apartmentId, listingType).
  if (input.unitType !== undefined && nextUnitType !== existing.unitType) {
    const conflict = await findListingTypeConflict({
      apartmentId: existing.apartmentId,
      listingType: nextUnitType,
      excludeListingId: input.unitId,
    });
    if (conflict) {
      return {
        ok: false as const,
        status: 409,
        error: "A unit with this code and unit type already exists in this property.",
      };
    }
  }

  // Kind-mismatch guard: only runs when the patch includes a new unitType.
  if (input.unitType !== undefined) {
    const attemptedKind = await resolveRoomTypeKind(session.orgId, nextUnitType);
    if (attemptedKind) {
      const currentMode = await getUnitGroupMode(
        session.orgId,
        existing.propertyId,
        nextUnitCode,
      );
      if (currentMode && currentMode !== "MIXED") {
        const required = currentMode === "WHOLE" ? "WHOLE" : "PARTITION";
        if (attemptedKind !== required) {
          return {
            ok: false as const,
            status: 400 as const,
            error: {
              code: "LISTING_MODE_MISMATCH" as const,
              currentMode,
              attemptedKind,
            },
          };
        }
      }
    }
  }

  // Coerce-to-draft / empty-string-to-null at the service layer.
  const coercion = coerceToDraftIfIncomplete(input);
  const cleaned = coerceEmptyStringToNull(coercion.effectiveInput, ["description"]);

  // Split off the property-scoped pax-deduction fields, side-table
  // grantedPartyIds, apartment-shared fields, and the tenancy stub.
  const {
    unitId,
    hasPaxDeduction,
    paxDeductionAmount,
    grantedPartyIds,
    applyToExistingSiblings,
    bedrooms,
    bathrooms,
    floor,
    floorArea,
    amenities,
    highlights,
    description,
    // Sales-side flag kept in the legacy schema; ignored by the rental write.
    sourceFlag: _sourceFlag,
    ...listingData
  } = cleaned;
  void _sourceFlag;

  // Persist the trimmed listingType when included in the patch.
  if (input.unitType !== undefined) listingData.unitType = nextUnitType;

  // Derive readyNow from the merged effective state.
  const merged = await mergeReadyNowInputs({
    orgId: session.orgId,
    listingId: unitId,
    propertyId: existing.propertyId,
    incoming: {
      occupancyStatus: listingData.occupancyStatus,
      listingStatus: listingData.listingStatus,
      visibilityMode: listingData.visibilityMode,
    },
  });
  const readyNow = deriveReadyNow(merged);

  // Peel tenancy stub fields off the patch — they don't belong on the Listing row.
  const {
    tenantPartyId,
    tenantName, // still peeled off so it never lands on the Listing row
    moveInDate: tenancyMoveIn,
    moveOutDate: tenancyMoveOut,
    monthlyRent: occupancyMonthlyRent,
    ...listingColumnData
  } = listingData as Record<string, unknown> & {
    tenantPartyId?: string;
    tenantName?: string;
    moveInDate?: string;
    moveOutDate?: string;
    monthlyRent?: number;
  };

  // Transition gate: when going FROM non-occupied TO occupied via the
  // admin dialog, the trio is required.
  const transitioningToOccupied =
    input.occupancyStatus === "occupied" && existing.occupancyStatus !== "occupied";
  if (transitioningToOccupied) {
    const missing: string[] = [];
    if (typeof tenantPartyId !== "string" || !tenantPartyId) missing.push("tenant");
    if (typeof tenancyMoveIn !== "string" || !tenancyMoveIn) missing.push("move-in date");
    if (typeof tenancyMoveOut !== "string" || !tenancyMoveOut) missing.push("move-out date");
    if (missing.length > 0) {
      return {
        ok: false as const,
        status: 400,
        error: `When marking a unit as Occupied, the following are required: ${missing.join(", ")}.`,
      };
    }
  }

  // Map back-compat "unitType" -> Listing.listingType + drop unknown keys
  // before forwarding to the repo writer. The repo whitelist guards the
  // column write — we just need the right key name here.
  const repoColumnPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(listingColumnData)) {
    if (k === "unitType") repoColumnPatch.listingType = v;
    else repoColumnPatch[k] = v;
  }

  // Owner-role validation: reject a non-null ownerPartyId that does not
  // belong to an owner in this org. Clearing (null) is always allowed.
  const incomingOwnerPartyId =
    repoColumnPatch.ownerPartyId !== undefined
      ? (repoColumnPatch.ownerPartyId as string | null)
      : undefined;

  // Owner is APARTMENT-scoped (one landlord per physical apartment). Never let
  // it ride the single-row column write — strip it here so the apartment-wide
  // updateMany below is the sole writer.
  delete repoColumnPatch.ownerPartyId;

  const db = getDb();

  if (incomingOwnerPartyId != null) {
    const ownerRole = await db.partyRole.findFirst({
      where: { organizationId: session.orgId, partyId: incomingOwnerPartyId, roleType: "owner" },
      select: { id: true },
    });
    if (!ownerRole) {
      return { ok: false as const, status: 400, error: "Assigned party is not an owner" };
    }
  }

  // Owner re-point guard: a unit cannot be marked Occupied (which materialises a
  // Tenancy whose rent/charges/ledger are attributed via Listing.ownerPartyId)
  // unless it has an assigned owner. The effective owner is the incoming value when
  // the patch sets it, else the unit's current owner. Mirrors the createTenancy /
  // reservation UNIT_HAS_NO_OWNER contract so the admin gets a clean 409 (the
  // syncOccupancyTenancy throw is the in-tx defence-in-depth behind this).
  if (input.occupancyStatus === "occupied") {
    const effectiveOwnerPartyId =
      incomingOwnerPartyId !== undefined ? incomingOwnerPartyId : existing.ownerPartyId;
    if (!effectiveOwnerPartyId) {
      return {
        ok: false as const,
        status: 409,
        code: "UNIT_HAS_NO_OWNER" as const,
        error: "This unit has no assigned owner. Assign an owner before marking it occupied.",
      };
    }

    // Commission guard — only when the save actually carries a commission field
    // (else no read, no guard: an occupancy edit that doesn't touch commission is
    // byte-identical to before). Resolve the active tenancy so a same-tenant
    // in-place edit checks the write-once lock against it; a tenant change /
    // newly-occupied unit materialises a NEW tenancy → null. Pre-tx.
    if (input.firstMonthIsCommission !== undefined || input.commissionSstBearer !== undefined) {
      const activeTenancy = await db.tenancy.findFirst({
        where: { organizationId: session.orgId, unitId: existing.id, status: "active" },
        select: { id: true, tenantPartyId: true, firstMonthIsCommission: true, commissionSstBearer: true },
      });
      const sameTenant =
        activeTenancy != null && typeof tenantPartyId === "string" && activeTenancy.tenantPartyId === tenantPartyId;
      const commissionGuard = await commissionGuardForOccupiedSave(
        session,
        input,
        sameTenant ? activeTenancy : null,
      );
      if (!commissionGuard.ok) {
        return { ok: false as const, status: commissionGuard.status, error: commissionGuard.error, code: commissionGuard.code };
      }
    }
  }

  try {
    await db.$transaction(async (tx) => {
      await updateListingTx(tx, unitId, { ...repoColumnPatch, readyNow });

      // Apartment-scoped owner: propagate to EVERY non-archived sibling Listing
      // so a partitioned apartment can never hold two owners.
      if (incomingOwnerPartyId !== undefined) {
        const fanout = await tx.listing.updateMany({
          where: {
            apartmentId: existing.apartmentId,
            organizationId: session.orgId,
            listingStatus: { not: "archived" },
          },
          data: { ownerPartyId: incomingOwnerPartyId },
        });
        // Propagate the same owner to every active carpark bay on this apartment.
        // A bay must never hold a stale owner (spec line 54), and this also
        // backfills bays registered before the apartment had an owner assigned.
        const carparkFanout = await tx.carpark.updateMany({
          where: {
            apartmentId: existing.apartmentId,
            organizationId: session.orgId,
            status: { not: "inactive" },
          },
          data: { ownerPartyId: incomingOwnerPartyId },
        });
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "inventory.owner.propagate",
          entityType: "Apartment",
          entityId: existing.apartmentId,
          meta: {
            ownerPartyId: incomingOwnerPartyId ?? null,
            triggeredByUnitId: unitId,
            // LISTINGS only (unchanged); the bay count is additive -- see
            // `fanOutFirstApartmentOwner`.
            affectedCount: fanout.count,
            carparkAffectedCount: carparkFanout.count,
          },
        });
      }

      if (input.occupancyStatus !== undefined) {
        await syncOccupancyTenancy({
          tx,
          orgId: session.orgId,
          unit: {
            id: existing.id,
            propertyId: existing.propertyId,
            occupancyStatus: existing.occupancyStatus ?? "vacant",
            rentalRate: existing.rentalRate != null ? Number(existing.rentalRate) : null,
            // Effective owner after this update: incoming value when the patch sets
            // it (incl. clearing to null), else the unit's current owner. The
            // pre-transaction 409 guard above already blocks occupied+no-owner; this
            // feeds the in-tx defence-in-depth guard the same effective value.
            ownerPartyId:
              incomingOwnerPartyId !== undefined ? incomingOwnerPartyId : existing.ownerPartyId,
          },
          incoming: {
            occupancyStatus: input.occupancyStatus,
            tenantPartyId: typeof tenantPartyId === "string" ? tenantPartyId : undefined,
            moveInDate: typeof tenancyMoveIn === "string" ? new Date(tenancyMoveIn) : undefined,
            moveOutDate: typeof tenancyMoveOut === "string" ? new Date(tenancyMoveOut) : undefined,
            monthlyRent: typeof occupancyMonthlyRent === "number" ? occupancyMonthlyRent : undefined,
            firstMonthIsCommission: input.firstMonthIsCommission,
            commissionSstBearer: input.commissionSstBearer,
            tenancyAgreementFeeAmount: input.tenancyAgreementFeeAmount,
            tenancyAgreementFeeDueDate: input.tenancyAgreementFeeDueDate ? new Date(input.tenancyAgreementFeeDueDate) : undefined,
          },
        });
      }

      // Apartment-shared field writes. In the legacy schema these fanned out
      // to every sibling Unit row; now they target the parent Apartment once.
      // The patch only touches Apartment when at least one shared field is
      // present in the inbound payload (preserves the pre-refactor behaviour
      // of "no shared keys in patch → don't mutate the shared row").
      const apartmentScopedPatch: Record<string, unknown> = {};
      if (bedrooms !== undefined) apartmentScopedPatch.bedrooms = bedrooms;
      if (bathrooms !== undefined) apartmentScopedPatch.bathrooms = bathrooms;
      if (floor !== undefined) apartmentScopedPatch.floor = floor;
      if (floorArea !== undefined) apartmentScopedPatch.floorArea = floorArea;
      if (amenities !== undefined) apartmentScopedPatch.amenities = amenities;
      if (highlights !== undefined) apartmentScopedPatch.highlights = highlights;
      if (description !== undefined) {
        apartmentScopedPatch.publishedDescription = description ?? null;
      }
      // Honor `applyToExistingSiblings` for back-compat: in the legacy schema
      // it was the explicit fan-out toggle. In the new model the shared fields
      // live on Apartment, so a shared-field write is ALWAYS apartment-wide.
      // We treat applyToExistingSiblings as opt-in to the apartment update —
      // when missing, only the listing's own column patch lands. This matches
      // the spec's "Apartment owns shared fields" semantics while preserving
      // the old call-site contract that a single-row edit is room-scoped by
      // default.
      if (applyToExistingSiblings && Object.keys(apartmentScopedPatch).length > 0) {
        await tx.apartment.update({
          where: { id: existing.apartmentId },
          data: apartmentScopedPatch,
        });
      }
    });
  } catch (err: unknown) {
    // R6: syncOccupancyTenancy throws a marked error (defence-in-depth) when
    // ENABLE_PHASE2_RESERVATION_GATED_TENANCY is on and the patch omits an
    // explicit monthlyRent > 0 for a NEW tenancy. Surface it as a clean 400
    // instead of letting it fall through to the global 500 handler -- this
    // is a routine, expected validation failure (unlike the "not a tenant" /
    // "no owner" defence-in-depth throws, which stay uncaught here, matching
    // their pre-existing behaviour).
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { _occupancyRentRequired?: boolean })._occupancyRentRequired
    ) {
      return {
        ok: false as const,
        status: 400 as const,
        error: {
          code: "OCCUPANCY_RENT_REQUIRED" as const,
          message: "Enter the monthly rent before marking this unit occupied.",
        },
      };
    }
    throw err;
  }

  if (hasPaxDeduction !== undefined || paxDeductionAmount !== undefined) {
    await updatePropertyPaxDeduction(existing.propertyId, session.orgId, {
      hasPaxDeduction,
      paxDeductionAmount,
    });
  }

  // Sync ListingVisibilityGrant rows.
  if (merged.visibilityMode === "PUBLIC") {
    await replaceVisibilityGrants({
      organizationId: session.orgId,
      listingId: unitId,
      partyIds: [],
      grantedById: session.userId,
    });
  } else if (grantedPartyIds !== undefined) {
    await replaceVisibilityGrants({
      organizationId: session.orgId,
      listingId: unitId,
      partyIds: grantedPartyIds,
      grantedById: session.userId,
    });
  }

  // Re-materialize UnitMonthLedger for old and new owner when the owner changed.
  if (incomingOwnerPartyId !== undefined) {
    const previousOwnerPartyId = existing.ownerPartyId;
    if (incomingOwnerPartyId !== previousOwnerPartyId) {
      const sysCtx: OwnerBillingActorCtx = {
        orgId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role as OwnerBillingActorCtx["actorRole"],
      };
      if (previousOwnerPartyId) await rematerializeOwnerRecentMonths(sysCtx, previousOwnerPartyId, new Date());
      if (incomingOwnerPartyId) await rematerializeOwnerRecentMonths(sysCtx, incomingOwnerPartyId, new Date());
    }
  }

  // Post-commit, never-throws. Two jobs, and it must run for BOTH occupancy
  // directions:
  //  • occupied — a save that materialised a NEW tenancy (assign-tenant from
  //    /inventory after this period's draft run) missed the run's cohort; catch
  //    the unit's tenancies up into the approval queue.
  //  • NOT occupied — this is how an admin records a move-out from Inventory,
  //    and syncOccupancyTenancy's not-occupied branch ends the tenancy with
  //    today's endDate. That edit is precisely what makes the month's existing
  //    draft stale, so gating the hook on "occupied" meant the one path that
  //    CREATES the staleness was the only path that never corrected it. The
  //    unit-keyed hook re-prorates even when no active tenancy remains.
  //
  // It still cannot revise a draft UPWARD past what the tenancy now owes, and it
  // never touches an approved/posted charge — that stays a credit note.
  await draftCatchupForUnit(session, unitId);
  // The edit-unit save is how an admin assigns a tenant to an existing unit — the
  // reported flow. Safe to fire on EVERY save: an existing tenancy already holds its
  // deposit (skipped `already_created`), a vacated unit has no active tenancy to
  // resolve, and a backdated move-in is refused by the current-month gate.
  await createTenancyDepositsForUnit(session, unitId);

  return {
    ok: true as const,
    status: 200,
    data: { id: unitId },
    coercedToDraft: coercion.coerced,
    missingFields: coercion.missing as readonly string[],
  };
}

/**
 * Merge incoming lifecycle column patches with the row's current values
 * so deriveReadyNow can be evaluated. Callers pass any subset of the
 * three Listing-level columns; the rest is read from the DB.
 */
async function mergeReadyNowInputs(args: {
  orgId: string;
  listingId: string;
  propertyId: string;
  incoming: {
    occupancyStatus?: string;
    listingStatus?: string;
    visibilityMode?: string;
  };
}): Promise<{
  propertyStatus: string;
  listingStatus: string;
  visibilityMode: string;
  occupancyStatus: string;
}> {
  const db = getDb();
  const [listing, property] = await Promise.all([
    db.listing.findUnique({
      where: { id: args.listingId },
      select: { occupancyStatus: true, listingStatus: true, visibilityMode: true },
    }),
    db.property.findFirst({
      where: { id: args.propertyId, organizationId: args.orgId },
      select: { status: true },
    }),
  ]);
  return {
    propertyStatus: property?.status ?? "active",
    listingStatus: args.incoming.listingStatus ?? listing?.listingStatus ?? "draft",
    visibilityMode: args.incoming.visibilityMode ?? listing?.visibilityMode ?? "PUBLIC",
    occupancyStatus: args.incoming.occupancyStatus ?? listing?.occupancyStatus ?? "vacant",
  };
}

// ---- Apartment-by-property aggregation -------------------------------------
//
// Apartments are first-class rows now (no more grouping by unitCode in the
// service). We query Apartments + their filtered Listings directly and
// pass the result through to the wire shape unchanged. listingMode comes
// from the Apartment row; `hasDrift` is now always false (single row =
// no drift possible). Both fields are kept on the wire to spare the SPA a
// parallel rewrite.

export type ApartmentRoomSummary = {
  id: string;
  unitType: string;
  rentalRate: number | null;
  occupancyStatus: string | null;
  listingStatus: string;
  inChargePartyId: string | null;
  tenantPartyId?: string | null;
  tenantName?: string | null;
  tenancyStartDate?: string | null;
  tenancyEndDate?: string | null;
};

export type ApartmentSummary = {
  id: string;
  unitCode: string;
  floor: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  amenities: { id: string; name: string }[];
  highlights: string[];
  description: string | null;
  /** LIVE rooms only. Every consumer of this field — listing-mode derivation,
   *  drift, owner resolution, the SPA's room tabs — means live rooms. */
  rooms: ApartmentRoomSummary[];
  /** Deactivated rooms, so the admin SPA can show and restore them, and can
   *  exclude their (still-reserved) listingTypes when adding a room. Optional
   *  for the same reason as partitionBillingMode below: the PORTAL apartment
   *  builder assigns to this same type and must never surface archived rooms
   *  to agents. The admin builder always sets it. */
  archivedRooms?: ApartmentRoomSummary[];
  hasDrift: boolean;
  listingMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
  // Optional to mirror the SPA's ApartmentSummary (apps/web/.../inventory-units-batch.ts)
  // and to avoid forcing the unrelated portal apartment builder (which assigns to
  // this same type) to provide it. The admin builder below always sets it.
  partitionBillingMode?: "SUBSIDY" | "NO_SUBSIDY" | null;
  /** Null defers to partitionBillingMode; a value takes priority for residual TNB. */
  tnbSubsidyCapMonthly?: number | null;
  // Optional for the same reason as partitionBillingMode above: the admin
  // builder always sets these, but the portal apartment builder (which assigns
  // to this same type) does not select or surface owner contact info to
  // sourcing agents, so it omits them.
  ownerPartyId?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  underManagement?: boolean;
};

export async function getApartmentsByPropertyService(
  session: InventorySession,
  propertyId: string,
): Promise<
  | { ok: true; status: 200; data: ApartmentSummary[] }
  | { ok: false; status: 404; error: string }
> {
  const db = getDb();
  const property = await db.property.findFirst({
    where: { id: propertyId, organizationId: session.orgId },
    select: { id: true },
  });
  if (!property) {
    return { ok: false, status: 404, error: "Property not found" };
  }
  const [apartments, amenities, roomTypes, archivedListings] = await Promise.all([
    db.apartment.findMany({
      where: { organizationId: session.orgId, propertyId },
      include: {
        listings: {
          where: { listingStatus: { not: "archived" } },
          select: {
            id: true,
            listingType: true,
            rentalRate: true,
            occupancyStatus: true,
            listingStatus: true,
            inChargePartyId: true,
            ownerPartyId: true,
            ownerParty: {
              select: { displayName: true, primaryPhone: true },
            },
            tenancies: {
              where: { status: "active" },
              orderBy: { startDate: "desc" },
              take: 1,
              select: {
                tenantPartyId: true,
                startDate: true,
                endDate: true,
                tenantParty: { select: { displayName: true } },
              },
            },
          },
          orderBy: { listingType: "asc" },
        },
      },
      orderBy: { unitCode: "asc" },
    }),
    db.amenity.findMany({
      where: { organizationId: session.orgId },
      select: { id: true, name: true },
    }),
    db.roomType.findMany({
      where: { organizationId: session.orgId },
      select: { name: true, kind: true },
    }),
    // Archived (deactivated) rooms, fetched separately because the `listings`
    // include above deliberately excludes them — every consumer of `rooms`
    // (listing mode, drift, owner resolution, room tabs) means LIVE rooms.
    // Surfaced under `archivedRooms` so admin can see and restore a room they
    // deactivated; POST /listings/:id/reactivate is the write path.
    db.listing.findMany({
      where: {
        organizationId: session.orgId,
        listingStatus: "archived",
        apartment: { propertyId, organizationId: session.orgId },
      },
      select: {
        id: true,
        apartmentId: true,
        listingType: true,
        rentalRate: true,
        occupancyStatus: true,
        listingStatus: true,
        inChargePartyId: true,
      },
      orderBy: { listingType: "asc" },
    }),
  ]);

  const archivedByApartment = new Map<string, typeof archivedListings>();
  for (const l of archivedListings) {
    const bucket = archivedByApartment.get(l.apartmentId) ?? [];
    bucket.push(l);
    archivedByApartment.set(l.apartmentId, bucket);
  }

  const amenityCatalog = new Map(amenities.map((a) => [a.id, a.name]));
  const kindByName = new Map(
    roomTypes.map((r) => [r.name, r.kind as "WHOLE" | "PARTITION"]),
  );

  const data: ApartmentSummary[] = apartments.map((apt) => {
    // The Apartment.listingMode column is the source of truth — but if a
    // legacy apartment row has listings that all share one kind we can
    // report MIXED only when the rooms disagree with the column. Because
    // the new model serialises the column as one of {WHOLE, PARTITIONED},
    // MIXED only surfaces when callers compute it from active listings;
    // we surface it here for back-compat with the old wire shape so the
    // SPA's drift-warning UI can still fire.
    const roomKinds = new Set<"WHOLE" | "PARTITION">();
    for (const r of apt.listings) {
      const k = kindByName.get(r.listingType);
      if (k) roomKinds.add(k);
    }
    let listingMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
    if (roomKinds.size === 0) {
      // No identified kinds → fall back to the Apartment column.
      listingMode = apt.listingMode as "WHOLE" | "PARTITIONED";
    } else if (roomKinds.size > 1) {
      listingMode = "MIXED";
    } else {
      listingMode = roomKinds.has("WHOLE") ? "WHOLE" : "PARTITIONED";
    }

    // Resolve owner from the first non-archived listing that carries one.
    // All non-archived listings share one owner by invariant; take the first hit.
    const ownerListing = apt.listings.find((l) => l.ownerPartyId != null) ?? null;

    return {
      id: apt.id,
      unitCode: apt.unitCode,
      floor: apt.floor,
      bedrooms: apt.bedrooms,
      bathrooms: apt.bathrooms == null ? null : Number(apt.bathrooms),
      floorArea: apt.floorArea == null ? null : Number(apt.floorArea),
      amenities: apt.amenities.map((id) => ({
        id,
        name: amenityCatalog.get(id) ?? id,
      })),
      highlights: apt.highlights,
      description: apt.publishedDescription,
      rooms: apt.listings.map((l) => ({
        id: l.id,
        unitType: l.listingType,
        rentalRate: l.rentalRate == null ? null : Number(l.rentalRate),
        occupancyStatus: l.occupancyStatus,
        listingStatus: l.listingStatus,
        inChargePartyId: l.inChargePartyId,
        tenantPartyId: l.tenancies?.[0]?.tenantPartyId ?? null,
        tenantName: l.tenancies?.[0]?.tenantParty?.displayName ?? null,
        tenancyStartDate: l.tenancies?.[0]?.startDate.toISOString().slice(0, 10) ?? null,
        tenancyEndDate: l.tenancies?.[0]?.endDate?.toISOString().slice(0, 10) ?? null,
      })),
      archivedRooms: (archivedByApartment.get(apt.id) ?? []).map((l) => ({
        id: l.id,
        unitType: l.listingType,
        rentalRate: l.rentalRate == null ? null : Number(l.rentalRate),
        occupancyStatus: l.occupancyStatus,
        listingStatus: l.listingStatus,
        inChargePartyId: l.inChargePartyId,
      })),
      // Single Apartment row → no fan-out drift possible.
      hasDrift: false,
      listingMode,
      // Apartment.partitionBillingMode is non-nullable in the schema
      // (@default(NO_SUBSIDY)); the `include` query returns it on every row.
      // Typed nullable on the wire for forward-compat with the SPA shape.
      partitionBillingMode: apt.partitionBillingMode,
      tnbSubsidyCapMonthly:
        apt.tnbSubsidyCapMonthly == null ? null : Number(apt.tnbSubsidyCapMonthly),
      underManagement: apt.underManagement,
      ownerPartyId: ownerListing?.ownerPartyId ?? null,
      ownerName: ownerListing?.ownerParty?.displayName ?? null,
      ownerPhone: ownerListing?.ownerParty?.primaryPhone ?? null,
    };
  });

  return { ok: true, status: 200, data };
}
