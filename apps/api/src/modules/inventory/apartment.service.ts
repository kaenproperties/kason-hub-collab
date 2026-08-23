import { getDb, Prisma } from "@kason/db";
import { UpdateApartmentSharedInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import {
  ApartmentSharedPatch,
  findApartmentById,
  updateApartmentModeTx,
  updateApartmentSharedTx,
} from "./apartment.repository";
import { getUnitGroupMode } from "./listing-mode";
import { resolveApartmentOwnerAttributed } from "./apartment-owner";
import { rematerializeOwnerRecentMonths } from "../owner-ledger/unit-month-ledger.remateralize-range";

type AdminSession = { orgId: string; userId: string };

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

/**
 * Switch an apartment's listingMode between WHOLE and PARTITIONED.
 *
 * Behaviour:
 *   - Validates the target mode exists in the org via at least one active RoomType
 *     of the right kind. Returns 422 if not.
 *   - Loads the apartment. Returns 404 if missing, 409 if mode already equals target.
 *   - If the target mode has zero existing non-archived Listings on the
 *     apartment, seeds ONE draft Listing using the first active RoomType of the
 *     target kind, so the apartment card has something to show post-flip.
 *   - Updates apartment.listingMode in a single $transaction with the audit row.
 *   - Existing Listings of the OFF-mode kind are NOT archived - they stay in the
 *     DB. They simply don't appear in apartment-mode-filtered queries until the
 *     mode flips back. This is the "no row count growth + data round-trips on
 *     flip-back" semantic from the spec.
 */
export async function flipApartmentModeService(
  session: AdminSession,
  apartmentId: string,
  targetMode: "WHOLE" | "PARTITIONED",
): Promise<Result<{ previousMode: "WHOLE" | "PARTITIONED"; targetMode: "WHOLE" | "PARTITIONED" }>> {
  const db = getDb();

  const apt = await findApartmentById(session.orgId, apartmentId);
  if (!apt) return err(404, "Apartment not found");

  // MIXED is computed from active listings of multiple kinds and is never
  // persisted on the apartment row — but it's exactly the state from which a
  // flip is most meaningful ("resolve to whole / resolve to partitioned").
  // Compare against the computed mode, falling back to the persisted column
  // only when no listings exist yet.
  const computedMode = await getUnitGroupMode(session.orgId, apt.propertyId, apt.unitCode);
  const effectiveCurrent = computedMode ?? apt.listingMode;
  if (computedMode !== "MIXED" && effectiveCurrent === targetMode) {
    return err(409, "MODE_UNCHANGED");
  }

  const neededKind: "WHOLE" | "PARTITION" = targetMode === "WHOLE" ? "WHOLE" : "PARTITION";

  // Look up active RoomTypes of the needed kind.
  const roomTypesOfNeededKind = await db.roomType.findMany({
    where: {
      organizationId: session.orgId,
      kind: neededKind,
      isActive: true,
    },
    orderBy: { sortOrder: "asc" },
    select: { name: true },
  });

  if (roomTypesOfNeededKind.length === 0) {
    return err(422, targetMode === "WHOLE" ? "NO_WHOLE_ROOMTYPE" : "NO_PARTITION_ROOMTYPE");
  }

  // Count existing non-archived Listings on this apartment whose listingType
  // is in the needed-kind set. If zero, we'll seed one so the apartment card
  // isn't empty after the flip.
  const existingTargetListingCount = await db.listing.count({
    where: {
      apartmentId,
      listingStatus: { not: "archived" },
      listingType: { in: roomTypesOfNeededKind.map((rt) => rt.name) },
    },
  });

  return db.$transaction(async (tx) => {
    let seededListingId: string | null = null;
    if (existingTargetListingCount === 0) {
      // Seed a draft Listing using the first active RoomType of the needed kind.
      const seedRoomTypeName = roomTypesOfNeededKind[0]!.name;

      // Media inheritance (spec 2026-05-24):
      //   - WHOLE → PARTITIONED: new room listings start empty (the old
      //     whole-unit photos aren't meaningfully room-attributable).
      //   - PARTITIONED → WHOLE: the new whole listing inherits the deduped
      //     union of all sibling room listings' media. coverPhotoKey is the
      //     first non-null cover encountered in (RoomType.sortOrder asc,
      //     then listingType alphabetical) order so admin doesn't lose data.
      let inheritedPhotoKeys: string[] = [];
      let inheritedVideoKeys: string[] = [];
      let inheritedCoverPhotoKey: string | null = null;
      if (targetMode === "WHOLE") {
        const roomTypeOrder = await tx.roomType.findMany({
          where: { organizationId: session.orgId, kind: "PARTITION" },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { name: true },
        });
        const orderIndex = new Map(roomTypeOrder.map((rt, idx) => [rt.name, idx]));

        const siblingListings = await tx.listing.findMany({
          where: { apartmentId, listingStatus: { not: "archived" } },
          select: {
            listingType: true,
            photoKeys: true,
            videoKeys: true,
            coverPhotoKey: true,
          },
        });
        const sorted = [...siblingListings].sort((a, b) => {
          const ai = orderIndex.get(a.listingType) ?? Number.MAX_SAFE_INTEGER;
          const bi = orderIndex.get(b.listingType) ?? Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return a.listingType.localeCompare(b.listingType);
        });

        const photoSet = new Set<string>();
        const videoSet = new Set<string>();
        for (const sib of sorted) {
          for (const k of sib.photoKeys) photoSet.add(k);
          for (const k of sib.videoKeys) videoSet.add(k);
          if (inheritedCoverPhotoKey === null && sib.coverPhotoKey) {
            inheritedCoverPhotoKey = sib.coverPhotoKey;
          }
        }
        inheritedPhotoKeys = Array.from(photoSet);
        inheritedVideoKeys = Array.from(videoSet);
      }

      // The (apartmentId, listingType) unique constraint may already have an
      // archived row with this listingType - in which case we un-archive it
      // rather than creating a duplicate. Un-archive keeps the archived
      // row's media as-is; admin can edit afterwards.
      const existingArchived = await tx.listing.findFirst({
        where: { apartmentId, listingType: seedRoomTypeName },
        select: { id: true, listingStatus: true },
      });

      if (existingArchived) {
        const updated = await tx.listing.update({
          where: { id: existingArchived.id },
          data: { listingStatus: "draft" },
          select: { id: true },
        });
        seededListingId = updated.id;
      } else {
        const created = await tx.listing.create({
          data: {
            organizationId: session.orgId,
            apartmentId,
            listingType: seedRoomTypeName,
            listingStatus: "draft",
            currency: "MYR",
            occupancyStatus: "vacant",
            photoKeys: inheritedPhotoKeys,
            videoKeys: inheritedVideoKeys,
            coverPhotoKey: inheritedCoverPhotoKey,
          },
          select: { id: true },
        });
        seededListingId = created.id;
      }
    }

    const updated = await updateApartmentModeTx(tx, apartmentId, targetMode);

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: "admin",
      action: "apartment.listing_mode.flip",
      entityType: "Apartment",
      entityId: apartmentId,
      diff: {
        fromMode: apt.listingMode,
        toMode: targetMode,
        seededListingId,
      } as unknown as Prisma.InputJsonValue,
    });

    return ok({
      previousMode: apt.listingMode as "WHOLE" | "PARTITIONED",
      targetMode: updated.listingMode as "WHOLE" | "PARTITIONED",
    });
  });
}

/**
 * Update apartment-shared fields. Single Apartment row write - no fan-out.
 * Use this for the "Edit shared details" dialog.
 */
export async function updateApartmentSharedService(
  session: AdminSession,
  apartmentId: string,
  input: UpdateApartmentSharedInput,
): Promise<Result<{ id: string }>> {
  const apt = await findApartmentById(session.orgId, apartmentId);
  if (!apt) return err(404, "Apartment not found");

  // Build the patch from only the keys explicitly present in the input,
  // so undefined fields never clobber existing data.
  const data: ApartmentSharedPatch = {};
  if (input.bedrooms !== undefined) data.bedrooms = input.bedrooms;
  if (input.bathrooms !== undefined) data.bathrooms = input.bathrooms;
  if (input.floorArea !== undefined) data.floorArea = input.floorArea;
  if (input.floor !== undefined) data.floor = input.floor;
  if (input.facing !== undefined) data.facing = input.facing;
  if (input.furnishingLevel !== undefined) data.furnishingLevel = input.furnishingLevel;
  if (input.amenities !== undefined) data.amenities = input.amenities;
  if (input.highlights !== undefined) data.highlights = input.highlights;
  if (input.publishedDescription !== undefined) data.publishedDescription = input.publishedDescription;
  if (input.publishedTitle !== undefined) data.publishedTitle = input.publishedTitle;
  if (input.partitionBillingMode !== undefined) data.partitionBillingMode = input.partitionBillingMode;
  if (input.tnbSubsidyCapMonthly !== undefined) {
    data.tnbSubsidyCapMonthly = input.tnbSubsidyCapMonthly;
  }
  if (input.underManagement !== undefined) data.underManagement = input.underManagement;

  const db = getDb();

  // Owner-role validation: reject a non-null ownerPartyId that does not
  // belong to an owner in this org. Clearing (null) is always allowed.
  if (input.ownerPartyId != null) {
    const ownerRole = await db.partyRole.findFirst({
      where: { organizationId: session.orgId, partyId: input.ownerPartyId, roleType: "owner" },
      select: { id: true },
    });
    if (!ownerRole) {
      return err(400, "Assigned party is not an owner");
    }
  }

  // Hoisted out of the transaction for the post-commit re-materialisation below.
  // `undefined` means "the owner was not being changed", which is distinct from `null`
  // ("changed, and there was no previous owner") — the guard below relies on both.
  let previousApartmentOwnerPartyId: string | null | undefined = undefined;

  const txResult = await db.$transaction(async (tx) => {
    const updated = await updateApartmentSharedTx(tx, apartmentId, data);

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: "admin",
      action: "apartment.shared.update",
      entityType: "Apartment",
      entityId: apartmentId,
      diff: data as unknown as Prisma.InputJsonValue,
    });

    // Apartment-scoped owner fan-out. Two writes, both in this tx: every
    // non-archived sibling Listing, then every non-inactive Carpark bay.
    // Mirrors the updateUnitService fan-out so the apartment endpoint is the
    // sole canonical writer for apartment-level owner assignment.
    if (input.ownerPartyId !== undefined) {
      // Capture the previous owner. The owner lives on the apartment's ROWS
      // (Listing.ownerPartyId, and since the bay fan-out also Carpark.ownerPartyId),
      // never on the Apartment row, so this is a scan.
      //
      // I3: use a canonical resolver rather than a local `findFirst`. The old probe read
      // Listings only, with no `ownerPartyId: { not: null }` filter and no `orderBy`, so
      // it answered `null` for an apartment that DOES have a previous owner whenever the
      // arbitrary row it picked was an ownerless sibling, or whenever the apartment's
      // only owned row was a carpark bay. A `null` here makes the re-materialisation
      // below skip the OLD owner, leaving that owner's ledger holding income for rows
      // that have since been re-pointed away.
      //
      // F1: the ATTRIBUTED resolver, which keeps the carpark-bay tier — NOT the
      // inheritance resolver, which dropped it. This asks "whose ledger currently holds
      // this apartment's income", not "whom may I stamp on a new row". A bay-only
      // apartment's charges DO foot to the bay's owner (owner-ledger.sync-hook.ts), so
      // that owner's ledger must be rebuilt when the apartment is re-pointed away from
      // them. Pointing this probe at `resolveApartmentOwnerForInheritance` silently
      // reopens exactly that leak.
      //
      // F3: resolved INSIDE the transaction, immediately before the `updateMany` that
      // overwrites what it just read. It used to run on the bare `db` client before
      // `$transaction` opened, so a concurrent re-point committing in that window made
      // this name a party that was no longer the previous owner — and the
      // re-materialisation below then rebuilt the WRONG owner's ledger while the true
      // previous owner kept income for rows since re-pointed away.
      //
      // TODO(owner-model-redesign): this NARROWS the race, it does not close it. Prisma's
      // default isolation is READ COMMITTED, so every statement takes a FRESH snapshot: a
      // writer committing between this read and the `updateMany` two lines down is still
      // invisible to us. And `rematerializeOwnerRecentMonths` runs AFTER commit, so a
      // crash in between leaves BOTH owners' ledgers stale regardless of placement. Both
      // residuals are pre-existing; only the placement is fixed here. Only a DB-level
      // constraint makes the invariant airtight -- move the owner onto
      // `Apartment.ownerPartyId` (step 1 of
      // docs/superpowers/specs/2026-07-09-apartment-owner-model-redesign.md).
      previousApartmentOwnerPartyId = await resolveApartmentOwnerAttributed(
        tx,
        session.orgId,
        apartmentId,
      );

      const fanout = await tx.listing.updateMany({
        where: {
          apartmentId,
          organizationId: session.orgId,
          listingStatus: { not: "archived" },
        },
        data: { ownerPartyId: input.ownerPartyId },
      });
      // A bay's owner mirrors the apartment's (schema.prisma:459) and
      // owner-ledger.sync-hook.ts:153 attributes a bay's charges through it.
      // Without this, re-pointing an owner here left bays on the PREVIOUS owner
      // and their charges kept footing to that owner's ledger.
      const carparkFanout = await tx.carpark.updateMany({
        where: {
          apartmentId,
          organizationId: session.orgId,
          status: { not: "inactive" },
        },
        data: { ownerPartyId: input.ownerPartyId },
      });
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: "admin",
        action: "inventory.owner.propagate",
        entityType: "Apartment",
        entityId: apartmentId,
        meta: {
          ownerPartyId: input.ownerPartyId ?? null,
          // LISTINGS only (unchanged); the bay count is additive -- see
          // `fanOutFirstApartmentOwner` in inventory.service.ts.
          affectedCount: fanout.count,
          carparkAffectedCount: carparkFanout.count,
          source: "apartment-shared",
        },
      });
    }

    return ok({ id: updated.id });
  });

  // Re-materialize UnitMonthLedger for old and new owner when the owner changed.
  if (input.ownerPartyId !== undefined && input.ownerPartyId !== previousApartmentOwnerPartyId) {
    const sysCtx = { orgId: session.orgId, actorUserId: session.userId, actorRole: "admin" as const };
    if (previousApartmentOwnerPartyId) await rematerializeOwnerRecentMonths(sysCtx, previousApartmentOwnerPartyId, new Date());
    if (input.ownerPartyId) await rematerializeOwnerRecentMonths(sysCtx, input.ownerPartyId, new Date());
  }

  return txResult;
}
