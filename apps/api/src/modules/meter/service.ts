import { getDb, Prisma } from "@kason/db";
import {
  COCKPIT_WORKLIST_CAP,
  type BillAttachmentRow,
  type ChargeUtilityBillInput,
  type CockpitResponse,
  type CreateMeterInput,
  type CreateReadingInput,
  type CreateUtilityBillInput,
  type SetTenancyPaxInput,
  type UpdateMeterInput,
  type UpdateReadingInput,
  type UpdateUtilityBillInput,
} from "@kason/shared";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import type { SessionPayload } from "../../lib/auth";
import { withStaleCheck } from "../../lib/optimistic-update";
import { runtimeConfig } from "../../lib/runtime-config";
import { createSignedDownloadUrl, deleteObject, putObject, requireBucket } from "../../lib/storage";
import {
  ComputeError,
  computeAllocation,
  endOfMonthISO,
  periodKey,
  round2,
  type Bearers,
  type BillingMode,
  type PoolComponents,
  type RoomInput,
} from "./compute";
import * as repo from "./repository";
import type { BillRoomRow, DbClient } from "./types";
import {
  resolveUtilitySubsidyPolicy,
  toUtilitySubsidyPolicySnapshot,
} from "./subsidy-policy";
import { syncOwnerLedgerForApartmentMonth } from "../owner-ledger/owner-ledger.sync-hook";
import { assertPeriodOpen } from "../owner-ledger/assert-period-open";
import { assertOwnerBillingReady, OwnerBillingNotReadyError } from "../owner-billing/owner-billing-ready";
import { postMonthlyRentForTenancy } from "../billing/post-monthly-rent";
import { postMonthlyCarparkForTenancy } from "../billing/post-monthly-carpark";
import { issueDocumentsForChargesTx } from "../billing-documents/issue.service";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { creditPostedChargeTx } from "../billing-documents/credit-notes.service";
import { refreshDocumentStatusForCharges } from "../billing-documents/status.service";
import { autoApplyOpenCredits } from "../billing-documents/credit-apply.service";
import type { ProofFile } from "../owner-billing/owner-expense-proof.service";
import { appendProof, deleteProof } from "../owner-billing/owner-expense-proof.repository";

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };
const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

const toMonth = (s: string): Date => new Date(`${s.slice(0, 7)}-01T00:00:00.000Z`);
const num = (s: string | null | undefined, fallback = 0): number => (s == null || s === "" ? fallback : Number(s));

// Money-safety guard: a room with an ACTIVE tenancy but missing/zero pax lands
// in neither "occupied" nor "vacant" in compute, so its aircon is subtracted
// from TNB yet it is never billed → silent revenue leak. Detect those rooms so
// both preview (warn) and charge (block) share the same definition.
function findPaxlessActiveRooms(rooms: BillRoomRow[]): { unitId: string; unitCode: string | null; listingType: string | null }[] {
  return rooms
    .filter((r) => r.tenancy !== null && (r.tenancy.numberOfPax ?? 0) <= 0)
    .map((r) => ({ unitId: r.unitId, unitCode: r.unitCode, listingType: r.listingType }));
}

// ── AircondMeter config ───────────────────────────────────────────────────────
export async function createMeterService(session: SessionPayload, input: CreateMeterInput): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const listing = await repo.findListing(tx, session.orgId, input.unitId);
    if (!listing) return err(404, "UNIT_NOT_FOUND");
    const existing = await repo.findMeterByUnit(tx, session.orgId, input.unitId);
    if (existing) return err(409, "METER_EXISTS");
    const created = await repo.createMeter(tx, {
      organizationId: session.orgId,
      unitId: input.unitId,
      meterNumber: input.meterNumber ?? null,
      ratePerKwh: input.ratePerKwh ?? "0.6000",
      isActive: true,
    });
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.meter.create", entityType: "AircondMeter", entityId: created.id, diff: { after: { unitId: input.unitId, ratePerKwh: input.ratePerKwh ?? "0.6000" } } as unknown as Prisma.InputJsonValue });
    return ok({ id: created.id }, 201);
  });
}

export async function updateMeterService(session: SessionPayload, id: string, input: UpdateMeterInput): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const meter = await repo.getMeter(tx, session.orgId, id);
    if (!meter) return err(404, "METER_NOT_FOUND");
    const updated = await withStaleCheck(() =>
      tx.aircondMeter.update({
        where: { id, organizationId: session.orgId, ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}) },
        data: { ...(input.meterNumber !== undefined ? { meterNumber: input.meterNumber } : {}), ...(input.ratePerKwh !== undefined ? { ratePerKwh: input.ratePerKwh } : {}) },
        select: { id: true },
      }),
    );
    if (updated === null) return err(409, "STALE");
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.meter.update", entityType: "AircondMeter", entityId: id, diff: { before: { meterNumber: meter.meterNumber, ratePerKwh: String(meter.ratePerKwh) }, after: input } as unknown as Prisma.InputJsonValue });
    return ok({ id });
  });
}

export async function setMeterActiveService(session: SessionPayload, id: string, isActive: boolean): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const meter = await repo.getMeter(tx, session.orgId, id);
    if (!meter) return err(404, "METER_NOT_FOUND");
    await tx.aircondMeter.update({ where: { id, organizationId: session.orgId }, data: { isActive } });
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: isActive ? "meter.meter.restore" : "meter.meter.retire", entityType: "AircondMeter", entityId: id });
    return ok({ id });
  });
}

// ── Tenancy pax (billing headcount) ─────────────────────────────────────────
// Mirrors the assign-PIC tenancy mutation (tenant-tracker/service.ts): org-scope
// + verify-then-update + audit, all in ONE $transaction so a failed audit rolls
// the update back. Additive — sets Tenancy.numberOfPax (the per-pax split
// denominator the bill preview/charge reads) so a paxless tenant can be made
// billable inline. Does NOT touch the billing math or any existing reading/bill
// service. No optimistic-concurrency token: pax is a single scalar a manager
// types deliberately, with no stale-overwrite hazard worth a 409 round-trip.
export async function setTenancyPaxService(
  session: SessionPayload,
  tenancyId: string,
  input: SetTenancyPaxInput,
): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const tenancy = await repo.findTenancyInOrg(tx, session.orgId, tenancyId);
    if (!tenancy) return err(404, "TENANCY_NOT_FOUND");

    await tx.tenancy.update({
      where: { id: tenancyId, organizationId: session.orgId },
      data: { numberOfPax: input.numberOfPax },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "meter.tenancy.set_pax",
      entityType: "Tenancy",
      entityId: tenancyId,
      diff: { before: { numberOfPax: tenancy.numberOfPax }, after: { numberOfPax: input.numberOfPax } } as unknown as Prisma.InputJsonValue,
    });

    return ok({ id: tenancyId });
  });
}

// ── MeterReading (aircon) ───────────────────────────────────────────────────
export async function createReadingService(session: SessionPayload, input: CreateReadingInput): Promise<Result<{ id: string; previousReading: number; consumption: number; computedAmount: number }>> {
  const db = getDb();
  try {
    return await db.$transaction(async (tx) => {
      // Lazy meter resolution (spec §6.2): a reading can be recorded for a room
      // that has no active meter. Resolve which meter applies and what WRITE it
      // would require (reactivate a retired meter / lazy-create one) WITHOUT
      // writing yet — the meter write is deferred until validation passes so a
      // rejected reading (negative consumption / duplicate) commits no meter
      // write. err() returns rather than throws, so an early write would be
      // committed by the interactive $transaction even on a 4xx.
      let meterId: string;
      let resolvedRate: string;
      // Deferred lazy write (performed only after the consumption guard passes).
      let deferredWrite: { kind: "reactivate"; meterId: string } | { kind: "create" } | null = null;
      const LAZY_RATE = "0.6000";

      const activeMeter = await repo.findActiveMeterByUnit(tx, session.orgId, input.unitId);
      if (activeMeter) {
        // Normal path: active meter exists — no deferred write needed.
        meterId = activeMeter.id;
        resolvedRate = String(activeMeter.ratePerKwh);
      } else {
        // Lazy path: no active meter — check unit validity first.
        const listing = await repo.findListing(tx, session.orgId, input.unitId);
        if (!listing) return err(404, "UNIT_NOT_FOUND");

        const anyMeter = await repo.findMeterByUnit(tx, session.orgId, input.unitId);
        if (anyMeter) {
          // Retired (inactive) meter exists — reactivate it (deferred), don't
          // create a duplicate. Rate resolves from the retired meter as before.
          deferredWrite = { kind: "reactivate", meterId: anyMeter.id };
          meterId = anyMeter.id;
          resolvedRate = String(anyMeter.ratePerKwh);
        } else {
          // No meter row at all — lazy-create a new one (deferred). meterId is
          // assigned after the create runs below.
          deferredWrite = { kind: "create" };
          meterId = "";
          resolvedRate = LAZY_RATE;
        }
      }

      const period = toMonth(input.periodMonth);
      const prior = await repo.findLatestPriorReading(tx, session.orgId, input.unitId, period);
      const previousReading =
        input.previousReading != null
          ? Number(input.previousReading)
          : prior
            ? Number(prior.currentReading)
            : 0;
      const current = Number(input.currentReading);
      const consumption = round2(current - previousReading);
      if (consumption < 0) return err(422, "NEGATIVE_CONSUMPTION");
      const rate = input.ratePerKwh ? Number(input.ratePerKwh) : Number(resolvedRate);
      const computedAmount = round2(consumption * rate);

      // Validation passed — NOW perform the deferred meter write + its audit.
      if (deferredWrite?.kind === "reactivate") {
        await tx.aircondMeter.update({ where: { id: deferredWrite.meterId, organizationId: session.orgId }, data: { isActive: true } });
        await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.meter.restore", entityType: "AircondMeter", entityId: deferredWrite.meterId });
      } else if (deferredWrite?.kind === "create") {
        const created = await repo.createMeter(tx, {
          organizationId: session.orgId,
          unitId: input.unitId,
          meterNumber: null,
          ratePerKwh: LAZY_RATE,
          isActive: true,
        });
        await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.meter.create", entityType: "AircondMeter", entityId: created.id, diff: { after: { unitId: input.unitId, ratePerKwh: LAZY_RATE } } as unknown as Prisma.InputJsonValue });
        meterId = created.id;
      }

      // Create the reading + audit. A duplicate (P2002) throws so the whole tx —
      // including the deferred meter write above — rolls back; the throw escapes
      // $transaction and is converted to 409 below.
      const reading = await repo.createReading(tx, {
        organizationId: session.orgId,
        meterId,
        unitId: input.unitId,
        periodMonth: period,
        previousReading: previousReading.toFixed(2),
        currentReading: current.toFixed(2),
        consumption: consumption.toFixed(2),
        ratePerKwh: rate.toFixed(4),
        computedAmount: computedAmount.toFixed(2),
        imageKey: input.imageKey ?? null,
        status: "submitted",
        submittedBy: session.userId,
      });
      await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.reading.create", entityType: "MeterReading", entityId: reading.id, diff: { after: { unitId: input.unitId, periodMonth: input.periodMonth, previous: previousReading, current, consumption, computedAmount } } as unknown as Prisma.InputJsonValue });
      return ok({ id: reading.id, previousReading, consumption, computedAmount }, 201);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return err(409, "READING_EXISTS");
    throw e;
  }
}

export async function updateReadingService(session: SessionPayload, id: string, input: UpdateReadingInput): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const reading = await repo.getReading(tx, session.orgId, id);
    if (!reading) return err(404, "READING_NOT_FOUND");
    if (reading.status !== "submitted") return err(409, "NOT_EDITABLE");
    const previous = input.previousReading !== undefined ? Number(input.previousReading) : Number(reading.previousReading);
    const current = input.currentReading !== undefined ? Number(input.currentReading) : Number(reading.currentReading);
    const rate = input.ratePerKwh !== undefined ? Number(input.ratePerKwh) : Number(reading.ratePerKwh);
    const consumption = round2(current - previous);
    if (consumption < 0) return err(422, "NEGATIVE_CONSUMPTION");
    const computedAmount = round2(consumption * rate);
    const updated = await withStaleCheck(() =>
      tx.meterReading.update({
        where: { id, organizationId: session.orgId, ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}) },
        data: { previousReading: previous.toFixed(2), currentReading: current.toFixed(2), ratePerKwh: rate.toFixed(4), consumption: consumption.toFixed(2), computedAmount: computedAmount.toFixed(2), ...(input.imageKey !== undefined ? { imageKey: input.imageKey } : {}) },
        select: { id: true },
      }),
    );
    if (updated === null) return err(409, "STALE");
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.reading.update", entityType: "MeterReading", entityId: id, diff: { before: { previous: Number(reading.previousReading), current: Number(reading.currentReading), computed: Number(reading.computedAmount) }, after: { previous, current, computed: computedAmount } } as unknown as Prisma.InputJsonValue });
    return ok({ id });
  });
}

export async function voidReadingService(session: SessionPayload, id: string): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const reading = await repo.getReading(tx, session.orgId, id);
    if (!reading) return err(404, "READING_NOT_FOUND");
    if (reading.status !== "submitted") return err(409, "NOT_VOIDABLE");
    await tx.meterReading.update({ where: { id, organizationId: session.orgId }, data: { status: "void" } });
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.reading.void", entityType: "MeterReading", entityId: id });
    return ok({ id });
  });
}

// ── UnitUtilityBill ─────────────────────────────────────────────────────────
export async function createUtilityBillService(session: SessionPayload, input: CreateUtilityBillInput): Promise<Result<{ id: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const apt = await tx.apartment.findFirst({ where: { organizationId: session.orgId, id: input.apartmentId }, select: { id: true } });
    if (!apt) return err(404, "APARTMENT_NOT_FOUND");
    const period = toMonth(input.periodMonth);
    const existing = await repo.findBillByAptPeriod(tx, session.orgId, input.apartmentId, period);
    if (existing) return err(409, "BILL_EXISTS");
    // Bearer default by apartment mode: a WHOLE unit's single tenant bears ALL
    // utilities (indah/cleaning/wifi too — schema comment @2026-06-18 spec), so
    // these default to "tenant". PARTITIONED (subsidy/no_subsidy) keep "owner"
    // (owner-borne, billed via the owner statement). Explicit input bearers
    // always win (admin per-bill override). The aircond/subsidy/pooling math
    // (compute.ts) is unaffected — only the bearer column written here.
    const modes = await repo.findApartmentModes(tx, session.orgId, input.apartmentId);
    const bearerDefault = modes?.listingMode === "WHOLE" ? "tenant" : "owner";
    const created = await repo.createBill(tx, {
      organizationId: session.orgId,
      apartmentId: input.apartmentId,
      periodMonth: period,
      billingMode: "no_subsidy", // will be resolved from Apartment.partitionBillingMode (done in aircond billing)
      tnbTotal: num(input.tnbTotal).toFixed(2),
      airSelangor: num(input.airSelangor).toFixed(2),
      indahWater: num(input.indahWater).toFixed(2),
      cleaning: num(input.cleaning).toFixed(2),
      wifi: input.wifi ? num(input.wifi).toFixed(2) : null,
      indahWaterBearer: input.indahWaterBearer ?? bearerDefault,
      cleaningBearer: input.cleaningBearer ?? bearerDefault,
      wifiBearer: input.wifiBearer ?? bearerDefault,
      status: "draft",
      notes: input.notes ?? null,
      createdBy: session.userId,
    });
    // PART 1: persist the owner-borne snapshot at DRAFT so the owner-ledger sync
    // surfaces the owner-borne amount this month (before charge). Re-read the
    // freshly-inserted row so the snapshot uses the resolved bearer defaults.
    const draftRow = await repo.getBill(tx, session.orgId, created.id);
    if (draftRow) {
      const snap = await computeOwnerBorneSnapshot(tx, session, draftRow);
      if (snap) await tx.unitUtilityBill.update({ where: { id: created.id, organizationId: session.orgId }, data: snap });
    }
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.utilitybill.create", entityType: "UnitUtilityBill", entityId: created.id, diff: { after: input } as unknown as Prisma.InputJsonValue });
    return ok({ id: created.id }, 201);
  });
}

export async function updateUtilityBillService(session: SessionPayload, id: string, input: UpdateUtilityBillInput): Promise<Result<{ id: string; updatedAt: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const bill = await repo.getBill(tx, session.orgId, id);
    if (!bill) return err(404, "BILL_NOT_FOUND");
    if (bill.status !== "draft") return err(409, "NOT_EDITABLE");
    const data: Prisma.UnitUtilityBillUncheckedUpdateInput = {};
    // The legacy per-pax/proportional billing columns were dropped from
    // UnitUtilityBill (Task 1); only the pool-component amounts are editable now.
    if (input.tnbTotal !== undefined) data.tnbTotal = num(input.tnbTotal).toFixed(2);
    if (input.airSelangor !== undefined) data.airSelangor = num(input.airSelangor).toFixed(2);
    if (input.indahWater !== undefined) data.indahWater = num(input.indahWater).toFixed(2);
    if (input.cleaning !== undefined) data.cleaning = num(input.cleaning).toFixed(2);
    if (input.wifi !== undefined) data.wifi = input.wifi ? num(input.wifi).toFixed(2) : null;
    if (input.indahWaterBearer !== undefined) data.indahWaterBearer = input.indahWaterBearer;
    if (input.cleaningBearer !== undefined) data.cleaningBearer = input.cleaningBearer;
    if (input.wifiBearer !== undefined) data.wifiBearer = input.wifiBearer;
    if (input.notes !== undefined) data.notes = input.notes;
    const updated = await withStaleCheck(() =>
      tx.unitUtilityBill.update({ where: { id, organizationId: session.orgId, ...(input.expectedUpdatedAt ? { updatedAt: new Date(input.expectedUpdatedAt) } : {}) }, data, select: { id: true, updatedAt: true } }),
    );
    if (updated === null) return err(409, "STALE");
    // PART 1: recompute the owner-borne snapshot from the updated draft row so the
    // owner-ledger sync tracks the latest owner-borne amount before charge. A
    // ComputeError (numbers don't reconcile yet) clears the seam back to null.
    // This second write re-bumps updatedAt, so we RETURN the snapshot write's
    // updatedAt (not the pool-edit write's) — the client re-uses it as the next
    // expectedUpdatedAt token, preserving the optimistic-concurrency contract.
    let finalUpdatedAt = updated.updatedAt;
    const draftRow = await repo.getBill(tx, session.orgId, id);
    if (draftRow) {
      const snap = await computeOwnerBorneSnapshot(tx, session, draftRow);
      const snapped = await tx.unitUtilityBill.update({
        where: { id, organizationId: session.orgId },
        data: snap ?? {
          subsidyCovered: null,
          ownerAttributableAircond: null,
          roundingResidual: null,
          ownerBorneUtilities: null,
          ownerBorneUtilitiesTotal: null,
        },
        select: { updatedAt: true },
      });
      finalUpdatedAt = snapped.updatedAt;
    }
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.utilitybill.update", entityType: "UnitUtilityBill", entityId: id, diff: { after: input } as unknown as Prisma.InputJsonValue });
    return ok({ id, updatedAt: finalUpdatedAt.toISOString() });
  });
}

// ── PART 1 (Workstream D): draft-stage owner-borne snapshot ──────────────────
// The owner must see a bill's owner-borne amount at DRAFT (before charge). The
// owner-ledger sync reads UnitUtilityBill.ownerBorneUtilitiesTotal, which today
// is only populated at charge → the owner sees nothing until the bill is charged.
// ownerBorneUtilitiesTotal (+ its breakdown) is a PURE function of the bill's
// pool amounts + bearers + this period's readings (computeAllocation), so we can
// persist it on every draft create/update WITHOUT charging and WITHOUT touching
// the pooling/subsidy math (same compute the charge path runs). A draft whose
// numbers don't yet reconcile (e.g. submetered aircond > TNB) makes compute throw
// a ComputeError; in that case we persist NULLs (the field is "not yet known" —
// the draft save itself must never fail on work-in-progress numbers).
//
// Returns the owner-facing snapshot fields only; the tenant allocations are NOT
// written here (no Charge / UtilityAllocation rows — those remain the charge path).
type OwnerBorneSnapshot = {
  billingMode: BillingMode;
  subsidyPerPax: string | null;
  subsidyCovered: string;
  ownerAttributableAircond: string;
  roundingResidual: string;
  ownerBorneUtilities: string;
  ownerBorneUtilitiesTotal: string;
} | null;

async function computeOwnerBorneSnapshot(
  tx: DbClient,
  session: SessionPayload,
  bill: UtilityBillForCompute,
): Promise<OwnerBorneSnapshot> {
  try {
    const { mode, subsidyPolicy, pool, roomInputs, bearers, privateAircond } = await buildComputeInputs(tx, session, bill);
    const result = computeAllocation(mode, subsidyPolicy, pool, roomInputs, bearers, privateAircond);
    return {
      billingMode: mode,
      subsidyPerPax:
        subsidyPolicy.kind === "legacy_per_pax"
          ? subsidyPolicy.amountPerPax.toFixed(2)
          : null,
      subsidyCovered: result.subsidyCovered.toFixed(2),
      ownerAttributableAircond: result.ownerAttributableAircond.toFixed(2),
      roundingResidual: result.roundingResidual.toFixed(2),
      ownerBorneUtilities: result.ownerBorneUtilities.toFixed(2),
      ownerBorneUtilitiesTotal: result.ownerBorneUtilitiesTotal.toFixed(2),
    };
  } catch (e) {
    // ComputeError (e.g. AIRCON_EXCEEDS_TNB) at draft → leave the seam null; the
    // numbers will reconcile before charge. Any other error is unexpected — rethrow.
    if (e instanceof ComputeError) return null;
    throw e;
  }
}

type UtilityBillForCompute = {
  apartmentId: string;
  periodMonth: Date;
  billingMode: unknown;
  status: string;
  subsidyPolicySnapshot: unknown;
  tnbSubsidyCapSnapshot: unknown;
  subsidyPerPax: unknown;
  tnbTotal: unknown;
  airSelangor: unknown;
  indahWater: unknown;
  wifi: unknown;
  cleaning: unknown;
  indahWaterBearer?: unknown;
  cleaningBearer?: unknown;
  wifiBearer?: unknown;
};

// Shared helper: build mode + pool + RoomInput[] for compute (no writes).
async function buildComputeInputs(
  db: DbClient,
  session: SessionPayload,
  bill: UtilityBillForCompute,
) {
  const rooms = await repo.findBillRooms(db, session.orgId, bill.apartmentId, bill.periodMonth);
  const apt = await repo.findApartmentModes(db, session.orgId, bill.apartmentId);
  // A non-null per-apartment cap is itself an explicit opt-in to the new subsidy
  // policy for a PARTITIONED apartment. Null is the compatibility path and keeps
  // the existing partitionBillingMode + org subsidyPerPax behaviour untouched.
  const liveMode: BillingMode = apt?.listingMode === "WHOLE"
    ? "whole"
    : apt?.tnbSubsidyCapMonthly != null || apt?.partitionBillingMode === "SUBSIDY"
      ? "subsidy"
      : "no_subsidy";
  // Org subsidyPerPax remains the legacy fallback only. A non-null apartment
  // cap opts a NEW/unlocked subsidy bill into the unit-level TNB policy; locked
  // and historical bills are resolved solely from their bill snapshots.
  const mayNeedLegacyRate =
    liveMode === "subsidy" ||
    bill.billingMode === "subsidy" ||
    bill.subsidyPolicySnapshot === "legacy_per_pax";
  const organizationSubsidyPerPax = mayNeedLegacyRate
    ? await repo.findUtilityBillingConfig(db, session.orgId)
    : 0;
  const { mode, subsidyPolicy } = resolveUtilitySubsidyPolicy({
    liveMode,
    apartmentTnbSubsidyCap: apt?.tnbSubsidyCapMonthly ?? null,
    organizationSubsidyPerPax,
    billStatus: bill.status,
    billBillingMode: bill.billingMode,
    billPolicySnapshot: bill.subsidyPolicySnapshot,
    billTnbSubsidyCapSnapshot: bill.tnbSubsidyCapSnapshot,
    billSubsidyPerPax: bill.subsidyPerPax,
  });
  // PARTITIONED units bill private per-room electricity: aircond Σ may exceed the
  // master TNB bill (excess = owner profit). WHOLE (single master meter) does not.
  const privateAircond = mode !== "whole";
  const pool: PoolComponents = {
    tnbTotal: num(String(bill.tnbTotal)),
    airSelangor: num(String(bill.airSelangor)),
    indahWater: num(String(bill.indahWater)),
    wifi: bill.wifi != null ? num(String(bill.wifi)) : 0,
    cleaning: num(String(bill.cleaning)),
    // UnitUtilityBill carries no maintenance fee — that scalar exists only on the bills-grid
    // entry. 0 + owner keeps this path byte-identical to before maintenance became billable.
    maintenance: 0,
  };
  // Indah/cleaning/wifi default to owner-borne (out of the tenant pool); only "tenant" pools them.
  const bearers: Bearers = {
    indahWater: bill.indahWaterBearer === "tenant" ? "tenant" : "owner",
    cleaning: bill.cleaningBearer === "tenant" ? "tenant" : "owner",
    wifi: bill.wifiBearer === "tenant" ? "tenant" : "owner",
    maintenance: "owner", // no maintenance in the meter bill — see the pool comment above
  };
  const roomInputs: RoomInput[] = rooms.map((r) => ({
    unitId: r.unitId,
    tenancyId: r.tenancy?.id ?? null,
    partyId: r.tenancy?.tenantPartyId ?? null,
    pax: r.tenancy?.numberOfPax ?? 0,
    airconCharge: r.reading ? num(r.reading.computedAmount) : 0,
    unitCode: r.unitCode,
    listingType: r.listingType,
  }));
  return { mode, subsidyPolicy, pool, roomInputs, rooms, bearers, privateAircond };
}

// Preview — recompute allocations, NO writes.
export async function previewUtilityBillService(session: SessionPayload, id: string): Promise<Result<unknown>> {
  const db = getDb();
  const bill = await repo.getBill(db, session.orgId, id);
  if (!bill) return err(404, "BILL_NOT_FOUND");
  try {
    const { mode, subsidyPolicy, pool, roomInputs, rooms, bearers, privateAircond } = await buildComputeInputs(db, session, bill);
    const paxlessActiveRooms = findPaxlessActiveRooms(rooms);
    const result = computeAllocation(mode, subsidyPolicy, pool, roomInputs, bearers, privateAircond);
    return ok({ billId: id, ...result, subsidyPolicy, paxlessActiveRooms });
  } catch (e) {
    if (e instanceof ComputeError) return err(422, e.code);
    return err(422, "COMPUTE_ERROR");
  }
}

// Mirror a bill's draft attachments into the owner's OwnerExpenseProof store
// (category "supporting") so the evidence an admin attached to justify a bill
// also shows up as the owner's expense proof — REFERENCING the same
// storageKey (no byte copy), so detach/void cleanup stays single-source.
// Idempotent per storageKey: safe to call more than once for the same bill.
// Called post-commit from chargeUtilityBillService, at the same seam as
// syncOwnerLedgerForApartmentMonth, and — like that sync — swallows its own
// errors (never throws) so a mirror hiccup can never roll back or change the
// already-committed charge's return value; it tolerates a no-owner apartment
// the same way the sync does (nothing to mirror, not an error).
export async function mirrorBillAttachmentsToOwner(
  orgId: string,
  actorUserId: string,
  actorRole: string,
  billId: string,
  apartmentId: string,
  periodMonth: Date,
): Promise<void> {
  try {
    const db = getDb();
    const attachments = await repo.listBillAttachments(db, orgId, billId);
    if (attachments.length === 0) return;
    const ownerPartyId = await repo.findApartmentOwnerPartyId(db, orgId, apartmentId);
    if (!ownerPartyId) return; // no owner set → nothing to mirror
    const existing = new Set(
      (
        await db.ownerExpenseProof.findMany({
          where: { organizationId: orgId, ownerPartyId, apartmentId, statementMonth: periodMonth, category: "supporting" },
          select: { storageKey: true },
        })
      ).map((p) => p.storageKey),
    );
    const toMirror = attachments.filter((a) => !existing.has(a.storageKey));
    if (toMirror.length === 0) return; // already mirrored — idempotent no-op
    await db.$transaction(async (tx) => {
      for (const a of toMirror) {
        const proof = await appendProof(tx, {
          orgId,
          ownerPartyId,
          statementMonth: periodMonth,
          apartmentId,
          category: "supporting",
          storageKey: a.storageKey,
          filename: a.filename,
          uploadedById: actorUserId,
        });
        await recordAudit(tx, { organizationId: orgId, actorUserId, actorRole, action: "meter.bill-attachment.mirror", entityType: "OwnerExpenseProof", entityId: proof.id, meta: { billId, storageKey: a.storageKey } as unknown as Prisma.InputJsonValue });
      }
    });
  } catch (e) {
    console.error("[meter] mirrorBillAttachmentsToOwner failed (swallowed):", e);
  }
}

// Reverse of the above — voidUtilityBillService's cleanup seam. Removes only
// the "supporting" proofs THIS bill's attachments mirrored, never the
// UnitUtilityBillAttachment rows or their storage objects — those stay
// (single-source storage, no orphan). Matched by storageKey alone (org +
// category scoped) rather than by (owner, apartment, month): a storageKey is
// a unique server-minted key that maps to exactly one mirrored proof, so this
// stays correct even if the apartment's owner was reassigned between charge
// and void — a fresh owner re-lookup at void time would resolve the NEW
// owner and silently miss (orphan) the OLD owner's proof. Same swallow
// contract as the mirror above: never throws.
async function unmirrorBillAttachmentsFromOwner(
  orgId: string,
  actorUserId: string,
  actorRole: string,
  billId: string,
): Promise<void> {
  try {
    const db = getDb();
    const attachments = await repo.listBillAttachments(db, orgId, billId);
    if (attachments.length === 0) return;
    const storageKeys = attachments.map((a) => a.storageKey);
    const toRemove = await db.ownerExpenseProof.findMany({
      where: { organizationId: orgId, category: "supporting", storageKey: { in: storageKeys } },
      select: { id: true, storageKey: true },
    });
    if (toRemove.length === 0) return;
    await db.$transaction(async (tx) => {
      for (const p of toRemove) {
        await deleteProof(tx, orgId, p.id);
        await recordAudit(tx, { organizationId: orgId, actorUserId, actorRole, action: "meter.bill-attachment.unmirror", entityType: "OwnerExpenseProof", entityId: p.id, meta: { billId, storageKey: p.storageKey } as unknown as Prisma.InputJsonValue });
      }
    });
  } catch (e) {
    console.error("[meter] unmirrorBillAttachmentsFromOwner failed (swallowed):", e);
  }
}

// Compute & charge — the money path. One $transaction; idempotent on bill.status.
export async function chargeUtilityBillService(session: SessionPayload, id: string, input: ChargeUtilityBillInput): Promise<Result<{ billId: string; utilityCharges: number; aircondCharges: number }>> {
  const db = getDb();
  // Pre-fetch bill fields for post-commit owner-ledger sync (must be outside the tx
  // so they remain accessible after the transaction commits). D-#4: charges are
  // created POSTED (tenant-visible immediately) — sync the ledger afterwards.
  const billMeta = await db.unitUtilityBill.findFirst({
    where: { id, organizationId: session.orgId },
    select: { apartmentId: true, periodMonth: true },
  });
  // Collected inside the tx below (Finding 2): charges that credit auto-apply
  // settled/partially-settled this run, so their DEP documents' status can be
  // refreshed post-commit — same idiom as voidUtilityBillService's affectedChargeIds.
  const autoAppliedChargeIds: string[] = [];
  const result = await db.$transaction(async (tx) => {
    const bill = await repo.getBill(tx, session.orgId, id);
    if (!bill) return err(404, "BILL_NOT_FOUND");
    if (bill.status !== "draft") return err(409, "ALREADY_CHARGED"); // primary idempotency guard

    // R2 guard (spec): refuse to post if this apartment's owner isn't billing-ready
    // (no owner, or no active ManagementFeeConfig). Runs at tx START — before any
    // charge/allocation/rent write — so a rejection rolls back a clean, empty tx.
    // No-op when ENABLE_PHASE2_OWNER_BILLING is dark. The bill's period is the
    // engine's date reference. err() here mirrors the ACTIVE_TENANCY_NO_PAX return.
    try {
      await assertOwnerBillingReady(tx, {
        orgId: session.orgId,
        scope: { kind: "apartment", apartmentId: bill.apartmentId },
        asOf: bill.periodMonth,
      });
    } catch (e) {
      if (e instanceof OwnerBillingNotReadyError) return err(e.status, e.code);
      throw e;
    }

    // R1 (closed-period integrity): posting this bill feeds the owner ledger for
    // bill.periodMonth — owner-borne utilities recorded on UnitUtilityBill AND the
    // month's rent income — via the POST-COMMIT syncOwnerLedgerForApartmentMonth
    // below. If that owner-statement month is FROZEN, the sync-hook's void-only
    // forward-reversal silently DROPS the owner impact, so reject the whole posting
    // IN-TX, BEFORE any charge/rent/allocation write. No-op when the flag is off,
    // the period is open/absent, or no owner is assigned (nothing to freeze).
    const ownerPartyId = await repo.findApartmentOwnerPartyId(tx, session.orgId, bill.apartmentId);
    if (ownerPartyId) {
      await assertPeriodOpen(tx, session.orgId, ownerPartyId, bill.periodMonth);
    }

    let computeInputs: Awaited<ReturnType<typeof buildComputeInputs>>;
    try {
      computeInputs = await buildComputeInputs(tx, session, bill);
    } catch (e) {
      if (e instanceof ComputeError) return err(422, e.code);
      throw e;
    }
    const { mode, subsidyPolicy, pool, roomInputs, rooms, bearers, privateAircond } = computeInputs;

    // Money-safety: refuse to charge if any active tenancy has no pax. The unit
    // cap's TNB denominator is tenancy/room (so preview can still show it), but
    // water and any other tenant-borne utilities remain per-pax. Posting without
    // pax would therefore leak those components. Block before any money write.
    const paxlessActiveRooms = findPaxlessActiveRooms(rooms);
    if (paxlessActiveRooms.length > 0) return err(422, "ACTIVE_TENANCY_NO_PAX");

    let result;
    try {
      result = computeAllocation(mode, subsidyPolicy, pool, roomInputs, bearers, privateAircond);
    } catch (e) {
      if (e instanceof ComputeError) return err(422, e.code);
      return err(422, "COMPUTE_ERROR");
    }
    if (result.allocations.length === 0) return err(422, "NO_OCCUPIED_TENANCY");

    const period = bill.periodMonth;
    const ym = periodKey(period);
    const dueDate = new Date(`${input.dueDate ?? endOfMonthISO(period)}T00:00:00.000Z`);
    const readingByUnit = new Map(rooms.filter((r) => r.reading).map((r) => [r.unitId, r.reading!]));

    // P3 B4: collect this posting's new charge ids per tenancy so open CN credit
    // can auto-apply FIFO inside the SAME tx after all charges exist.
    const newChargeIdsByTenancy = new Map<string, string[]>();
    const trackCharge = (tenancyId: string, chargeId: string) => {
      const list = newChargeIdsByTenancy.get(tenancyId) ?? [];
      list.push(chargeId);
      newChargeIdsByTenancy.set(tenancyId, list);
    };

    let utilityCharges = 0;
    let aircondCharges = 0;
    // Accounting docs (§4.2): collect every charge id this posting creates so ONE
    // DEP debit note per charge can be minted INSIDE this same transaction below.
    const mintChargeIds: string[] = [];
    // The pooled "Shared utilities" charge (one per room) is a SUM of per-utility
    // components — bill it as an accounting statement, one document line per non-zero
    // component, instead of a single lump line. Keyed by the utility charge id; passed
    // to issueDocumentsForChargesTx which asserts Σ(line amounts) === charge amount.
    // Presentation only — the Charge (receivable), owner ledger, and void/credit
    // flows are untouched (they still see ONE utility charge per room).
    const utilityLineBreakdowns = new Map<string, { description: string; amount: string }[]>();
    try {
      for (const a of result.allocations) {
        // utility Charge (all modes) — but NOT when the room's net share is RM0
        // (#9): when an owner's subsidy fully covers the share, computedAmount is
        // 0.00 and minting a "RM0.00 Shared utilities" charge is pure noise (the
        // aircond sibling below is already guarded the same way). Skip the charge
        // at source; the audit allocation is still written after the guard (with
        // chargeId null) so the fully-subsidised split stays traceable. `util` is
        // hoisted (NIT-3) because createAllocation references it after the guard.
        let util: { id: string } | undefined;
        if (a.computedAmount > 0) {
          util = await repo.createChargeTx(tx, {
            organizationId: session.orgId,
            chargeNumber: `UTIL-${ym}-${a.unitId}`,
            tenancyId: a.tenancyId,
            unitId: a.unitId,
            partyId: a.partyId,
            chargeType: "utility",
            status: "posted",
            postedAt: new Date(),
            description: `Shared utilities ${ym}`,
            dueDate,
            amount: a.computedAmount.toFixed(2),
            currency: "MYR",
            outstandingAmount: a.computedAmount.toFixed(2),
            attachmentKeys: [],
            billingMonth: period,
          });
          await repo.createChargeEventTx(tx, { organizationId: session.orgId, chargeId: util.id, eventType: "charge_created", eventAt: new Date(), actorUserId: session.userId, payloadJson: { source: "meter.utilitybill", billId: id, amount: a.computedAmount } as unknown as Prisma.InputJsonValue });
          await repo.createChargeEventTx(tx, { organizationId: session.orgId, chargeId: util.id, eventType: "charge_posted", eventAt: new Date(), actorUserId: session.userId, payloadJson: { previousStatus: "draft", nextStatus: "posted" } as unknown as Prisma.InputJsonValue });
          utilityCharges += 1;
          mintChargeIds.push(util.id);
          trackCharge(a.tenancyId, util.id);

          // Itemize this pooled charge into one document line per non-zero utility
          // component (subsidy is a negative offset line). The shares are the SAME
          // per-utility amounts that sum to `computedAmount` (the charge amount), so
          // the document foots exactly — issueDocumentsForChargesTx re-asserts it.
          // Order is fixed (electricity → water → sewerage → wifi → cleaning →
          // subsidy) so the invoice's line order is stable across postings.
          const utilParts: { description: string; amount: string }[] = [];
          const pushUtilPart = (label: string, amt: number) => {
            if (round2(amt) !== 0) utilParts.push({ description: `${label} ${ym}`, amount: amt.toFixed(2) });
          };
          pushUtilPart("Electricity (TNB)", a.tnbShare);
          pushUtilPart("Water (Air Selangor)", a.airSelangorShare);
          pushUtilPart("Sewerage (Indah Water)", a.indahShare);
          pushUtilPart("WiFi", a.wifiShare);
          pushUtilPart("Cleaning", a.cleaningShare);
          pushUtilPart("Subsidy", -a.subsidyDeduction);
          if (utilParts.length > 0) utilityLineBreakdowns.set(util.id, utilParts);
        }
        // Audit the split for EVERY occupied room, even the fully-subsidised RM0
        // one (status "charged", chargeId null). Downstream is null-safe: the void
        // path guards `if (alloc.chargeId)` and owner-ledger sync filters null
        // chargeIds, so a null-charge allocation never dereferences a missing charge.
        await repo.createAllocation(tx, {
          organizationId: session.orgId,
          billId: id,
          unitId: a.unitId,
          tenancyId: a.tenancyId,
          partyId: a.partyId,
          pax: a.pax,
          tnbShare: a.tnbShare.toFixed(2),
          airSelangorShare: a.airSelangorShare.toFixed(2),
          indahShare: a.indahShare.toFixed(2),
          cleaningShare: a.cleaningShare.toFixed(2),
          wifiShare: a.wifiShare.toFixed(2),
          subsidyDeduction: a.subsidyDeduction.toFixed(2),
          computedAmount: a.computedAmount.toFixed(2),
          chargeId: util?.id ?? null,
          status: "charged",
        });

        // Unified post (spec §10b.1 / §12): posting the bill ALSO posts THIS tenancy's
        // month rent in the SAME transaction. Idempotent + deduped with the auto-draft
        // cron via a shared full-id chargeNumber (a month's rent is never double-posted).
        // The post-commit syncOwnerLedgerForApartmentMonth below then surfaces it as owner income.
        const rentResult = await postMonthlyRentForTenancy(tx, session.orgId, a.tenancyId, period, session.userId);
        // Push unconditionally: a cron-drafted rent flipped draft→posted here
        // (created:false) just became tenant-visible and needs its document too;
        // an already-documented replay dedupes inside the mint (existing-line
        // skip + doc:<chargeNumber> key), and drafts/voids are filtered there.
        mintChargeIds.push(rentResult.chargeId);
        // Credit auto-apply wants charges that became OWED in this run — which is
        // not the same as charges CREATED in this run. A cron-drafted rent has
        // created:false but is a brand-new receivable the moment it flips
        // draft→posted here, and it never had credit applied as a draft (the
        // applier filters to posted/partially_paid). Keying on `created` skipped
        // those permanently, so carried-forward credit never came off the next
        // month's rent. `becameReceivable` covers both routes.
        if (rentResult.becameReceivable) trackCharge(a.tenancyId, rentResult.chargeId);

        // carpark Charge — one per active CarparkAssignment for this tenancy (Task 4.2).
        // Idempotent (check-first on CARPARK-{YYYYMM}-{carparkId}). Same tx as rent.
        const carparkResult = await postMonthlyCarparkForTenancy(tx, session.orgId, a.tenancyId, period, session.userId);
        mintChargeIds.push(...carparkResult.chargeIds);
        for (const cpChargeId of carparkResult.chargeIds) trackCharge(a.tenancyId, cpChargeId);

        // aircond Charge — every occupied room with a submitted unbilled reading
        const reading = readingByUnit.get(a.unitId);
        if (reading && reading.status === "submitted" && reading.chargeId === null) {
          const amt = round2(num(reading.computedAmount));
          if (amt > 0) {
            const ac = await repo.createChargeTx(tx, {
              organizationId: session.orgId,
              chargeNumber: `AC-${ym}-${a.unitId}`,
              tenancyId: a.tenancyId,
              unitId: a.unitId,
              partyId: a.partyId,
              chargeType: "aircond",
              status: "posted",
              postedAt: new Date(),
              description: `Aircond ${ym}`,
              dueDate,
              amount: amt.toFixed(2),
              currency: "MYR",
              outstandingAmount: amt.toFixed(2),
              attachmentKeys: [],
              billingMonth: period,
            });
            await repo.createChargeEventTx(tx, { organizationId: session.orgId, chargeId: ac.id, eventType: "charge_created", eventAt: new Date(), actorUserId: session.userId, payloadJson: { source: "meter.reading", readingId: reading.id, amount: amt } as unknown as Prisma.InputJsonValue });
            await repo.createChargeEventTx(tx, { organizationId: session.orgId, chargeId: ac.id, eventType: "charge_posted", eventAt: new Date(), actorUserId: session.userId, payloadJson: { previousStatus: "draft", nextStatus: "posted" } as unknown as Prisma.InputJsonValue });
            await tx.meterReading.update({ where: { id: reading.id, organizationId: session.orgId }, data: { status: "charged", chargeId: ac.id } });
            aircondCharges += 1;
            mintChargeIds.push(ac.id);
            trackCharge(a.tenancyId, ac.id);
          }
        }
      }
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return err(409, "ALREADY_CHARGED");
      throw e;
    }

    const policySnapshot = toUtilitySubsidyPolicySnapshot(subsidyPolicy);
    await tx.unitUtilityBill.update({
      where: { id, organizationId: session.orgId },
      data: {
        status: "charged",
        billingMode: mode,
        // Lock the exact policy only at the successful posting seam. This update
        // shares the charge/document transaction, so any later failure rolls the
        // snapshot back together with every money row.
        ...policySnapshot,
        subsidyCovered: result.subsidyCovered.toFixed(2),
        ownerAttributableAircond: result.ownerAttributableAircond.toFixed(2),
        roundingResidual: result.roundingResidual.toFixed(2),
        ownerBorneUtilities: result.ownerBorneUtilities.toFixed(2),
        ownerBorneUtilitiesTotal: result.ownerBorneUtilitiesTotal.toFixed(2),
      },
    });
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.utilitybill.compute", entityType: "UnitUtilityBill", entityId: id, diff: { after: { utilityCharges, aircondCharges, subsidyPolicy, ownerAttributableAircond: result.ownerAttributableAircond, subsidyCovered: result.subsidyCovered, roundingResidual: result.roundingResidual } } as unknown as Prisma.InputJsonValue });
    // Accounting docs (§4.2 mint-on-post): ONE DEP debit note per charge this
    // posting created (utility, rent, carpark, aircond) — minted INSIDE this
    // transaction, so a mint failure aborts the posting (§4.6) and no charge
    // is ever visible without its document while the flag is on. Replay-safe
    // (doc:<chargeNumber> idempotency + existing-line skip). Flag off ⇒ this
    // block is skipped entirely — byte-identical legacy posting.
    if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
      await issueDocumentsForChargesTx(tx, mintChargeIds, session.userId, utilityLineBreakdowns);
    }
    // P3 B4 (spec §4.3): open CN credit auto-applies FIFO to the charges just
    // posted, inside this tx (idempotent: check-first on cnapply keys; the
    // posting itself is guarded by bill.status). Flag-dark: nothing happens.
    if (isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) {
      for (const [tenancyId, ids] of newChargeIdsByTenancy) {
        const appliedIds = await autoApplyOpenCredits(tx, session.orgId, tenancyId, ids, session.userId);
        autoAppliedChargeIds.push(...appliedIds);
      }
    }
    return ok({ billId: id, utilityCharges, aircondCharges });
  });
  // Post-commit: sync the owner ledger for the apartment-month just charged (M3 — direct call, no
  // extra findMany). Never throws — the hook wraps the sync in try/catch.
  if (result.ok && billMeta) {
    await syncOwnerLedgerForApartmentMonth(session.orgId, session.userId, session.role, billMeta.apartmentId, billMeta.periodMonth);
    // Task 5: mirror this bill's draft attachments into the owner's supporting
    // proofs now that the charge (and the attachments' final state) is committed.
    await mirrorBillAttachmentsToOwner(session.orgId, session.userId, session.role, id, billMeta.apartmentId, billMeta.periodMonth);
  }
  // Finding 2: freshly-minted charges settled by credit auto-apply above left
  // their DEP documents stuck at 'issued' — refresh (never-throw, self flag-gated).
  if (result.ok && autoAppliedChargeIds.length > 0) {
    await refreshDocumentStatusForCharges(autoAppliedChargeIds);
  }
  return result;
}

export async function voidUtilityBillService(
  session: SessionPayload,
  id: string,
  input?: { reason?: string },
): Promise<Result<{ id: string }>> {
  const db = getDb();
  const billingDocsOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const reason = input?.reason ?? "Utility bill voided";
  // Pre-fetch for the post-commit owner-ledger sync — same idiom as
  // chargeUtilityBillService above (must survive the tx scope).
  const billMeta = await db.unitUtilityBill.findFirst({
    where: { id, organizationId: session.orgId },
    select: { apartmentId: true, periodMonth: true },
  });
  const affectedChargeIds: string[] = [];
  const result = await db.$transaction(async (tx) => {
    const bill = await repo.getBillWithAllocations(tx, session.orgId, id);
    if (!bill) return err(404, "BILL_NOT_FOUND");
    if (bill.status === "void") return err(409, "ALREADY_VOID");
    // Void the bill's charges + allocations + flip readings back, then the bill.
    // Flag ON: each affected DEP document gets its OWN CN (LHDN: one CN
    // references one original), charge → credited, outstanding ZEROED (fixes the
    // pre-P3 gap). Flag OFF: byte-identical legacy status flip.
    for (const alloc of bill.allocations) {
      if (alloc.chargeId) {
        affectedChargeIds.push(alloc.chargeId);
        if (billingDocsOn) {
          await creditPostedChargeTx(tx, {
            organizationId: session.orgId,
            chargeId: alloc.chargeId,
            reason,
            actorUserId: session.userId,
            actorRole: session.role,
          });
        } else {
          await tx.charge.update({ where: { id: alloc.chargeId, organizationId: session.orgId }, data: { status: "void" } });
        }
      }
      await tx.utilityAllocation.update({ where: { id: alloc.id, organizationId: session.orgId }, data: { status: "void" } });
    }
    // Reverse aircond charges raised from this period's charged readings of this apartment.
    const readings = await tx.meterReading.findMany({ where: { organizationId: session.orgId, periodMonth: bill.periodMonth, status: "charged", unit: { apartmentId: bill.apartmentId } }, select: { id: true, chargeId: true } });
    for (const r of readings) {
      if (r.chargeId) {
        affectedChargeIds.push(r.chargeId);
        if (billingDocsOn) {
          await creditPostedChargeTx(tx, {
            organizationId: session.orgId,
            chargeId: r.chargeId,
            reason,
            actorUserId: session.userId,
            actorRole: session.role,
          });
        } else {
          await tx.charge.update({ where: { id: r.chargeId, organizationId: session.orgId }, data: { status: "void" } });
        }
      }
      await tx.meterReading.update({ where: { id: r.id, organizationId: session.orgId }, data: { status: "void", chargeId: null } });
    }
    await tx.unitUtilityBill.update({ where: { id, organizationId: session.orgId }, data: { status: "void" } });
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.utilitybill.void", entityType: "UnitUtilityBill", entityId: id, diff: { after: { reason: input?.reason ?? null, affectedCharges: affectedChargeIds.length } } as unknown as Prisma.InputJsonValue });
    return ok({ id });
  });
  // Post-commit (flag-INDEPENDENT bug fix, spec §4.5): no void path re-synced the
  // owner ledger before P3, leaving orphaned active rows. Never throws.
  if (result.ok && billMeta) {
    await syncOwnerLedgerForApartmentMonth(session.orgId, session.userId, session.role, billMeta.apartmentId, billMeta.periodMonth);
    // Task 5: un-mirror this bill's supporting proofs — the attachments themselves
    // (and their storage objects) stay; only the owner-side mirror is removed.
    await unmirrorBillAttachmentsFromOwner(session.orgId, session.userId, session.role, id);
    if (billingDocsOn && affectedChargeIds.length > 0) {
      await refreshDocumentStatusForCharges(affectedChargeIds);
    }
  }
  return result;
}

// ── Bill attachments (tenant-tracker draft-bill uploads) ────────────────────
// Files a manager attaches to a DRAFT UnitUtilityBill in the bill workspace
// (e.g. the TNB/AirSelangor PDF backing the numbers). Draft-only: attach AND
// detach both reject with BILL_NOT_EDITABLE once the bill is charged/void, so
// attachments are frozen (no add/remove) from charge time onward — Task 5
// mirrors them into the owner's supporting proofs at charge time, and an
// unguarded post-charge detach would delete storage out from under that
// mirrored proof (orphaning it). Mirrors owner-expense-proof.service.ts's
// mime/size gate and server-minted-key idiom (that module's `fileError`/
// `mintKey` aren't exported, so the same small gate is reimplemented here —
// every upload-accepting module in this codebase keeps its own local copy
// rather than sharing one).
const BILL_ATTACHMENT_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function fileError(file: ProofFile): string | null {
  const ext = BILL_ATTACHMENT_EXT_BY_MIME[file.mimeType.toLowerCase()];
  if (!ext) return "UNSUPPORTED_FILE_TYPE";
  if (file.content.length > runtimeConfig.limits.photoMaxBytes) return "FILE_TOO_LARGE";
  return null;
}

// Server-minted key under utility-bills/<apartmentId>/<uuid>.<ext> — the client
// never picks the storage path.
function mintBillKey(apartmentId: string, file: ProofFile): string {
  const ext = BILL_ATTACHMENT_EXT_BY_MIME[file.mimeType.toLowerCase()] ?? "bin"; // unreachable — fileError already rejected unknown mimes
  return `utility-bills/${apartmentId}/${randomUUID()}.${ext}`;
}

export async function attachBillAttachmentsService(session: SessionPayload, billId: string, files: ProofFile[]): Promise<Result<BillAttachmentRow[]>> {
  if (files.length === 0) return err(400, "NO_FILES");
  for (const f of files) {
    const e = fileError(f);
    if (e) return err(400, e);
  }
  const db = getDb();
  const bill = await repo.getUtilityBillMeta(db, session.orgId, billId);
  if (!bill) return err(404, "BILL_NOT_FOUND");
  if (bill.status !== "draft") return err(409, "BILL_NOT_EDITABLE");

  // Persist bytes (server-named keys) before the DB tx — storage isn't
  // transactional, so every row created below already has real bytes behind it.
  const staged: { key: string; file: ProofFile }[] = [];
  for (const f of files) {
    const key = mintBillKey(bill.apartmentId, f);
    await putObject(key, f.content, f.mimeType.toLowerCase());
    staged.push({ key, file: f });
  }

  const rows = await db.$transaction(async (tx) => {
    const out: { id: string; filename: string; createdAt: Date; storageKey: string }[] = [];
    for (const { key, file } of staged) {
      const row = await repo.createBillAttachmentTx(tx, { organizationId: session.orgId, billId, storageKey: key, filename: file.filename, uploadedById: session.userId });
      await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.bill-attachment.attach", entityType: "UnitUtilityBillAttachment", entityId: row.id, meta: { billId, storageKey: key } as unknown as Prisma.InputJsonValue });
      out.push({ id: row.id, filename: row.filename, createdAt: row.createdAt, storageKey: key });
    }
    return out;
  });

  // Sign URLs for the response after the tx commits.
  const data = await Promise.all(rows.map(async (r) => ({ id: r.id, filename: r.filename, createdAt: r.createdAt.toISOString(), url: await createSignedDownloadUrl(r.storageKey) })));
  return ok(data, 201);
}

export async function listBillAttachmentsService(session: SessionPayload, billId: string): Promise<Result<BillAttachmentRow[]>> {
  const rows = await repo.listBillAttachments(getDb(), session.orgId, billId);
  const data = await Promise.all(rows.map(async (r) => ({ id: r.id, filename: r.filename, createdAt: r.createdAt.toISOString(), url: await createSignedDownloadUrl(r.storageKey) })));
  return ok(data, 200);
}

export async function detachBillAttachmentService(session: SessionPayload, attachmentId: string): Promise<Result<void>> {
  const db = getDb();
  const row = await repo.getBillAttachment(db, session.orgId, attachmentId);
  if (!row) return err(404, "ATTACHMENT_NOT_FOUND");

  // Draft-only guard (mirrors attachBillAttachmentsService's own check): once
  // the bill is charged/void, Task 5 has mirrored this attachment into the
  // owner's supporting proofs — deleting it here would delete the storage
  // object that mirrored proof still references (orphan). Block before either
  // delete runs.
  const bill = await repo.getUtilityBillMeta(db, session.orgId, row.billId);
  if (!bill) return err(404, "BILL_NOT_FOUND");
  if (bill.status !== "draft") return err(409, "BILL_NOT_EDITABLE");

  // No-orphan (storage-first): delete the bucket object BEFORE the row, so a
  // storage object can never outlive its DB reference. If the delete throws,
  // the row is untouched — the detach is safely retryable rather than leaving
  // a row that points at a byte that's already gone.
  await deleteObject(requireBucket(), row.storageKey);

  await db.$transaction(async (tx) => {
    await repo.deleteBillAttachment(tx, session.orgId, attachmentId);
    await recordAudit(tx, { organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role, action: "meter.bill-attachment.detach", entityType: "UnitUtilityBillAttachment", entityId: attachmentId, meta: { storageKey: row.storageKey } as unknown as Prisma.InputJsonValue });
  });
  return ok(undefined, 200);
}

// ── List/detail (read) services ─────────────────────────────────────────────
function page<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1].id : null };
}

// Flatten the relation include into a flat display label the web table renders
// (frontend §16: list endpoint MUST return the label, not just the raw FK).
// Strips the nested relation so the DTO stays flat and back-compatible.
export function flattenUnitLabel<T extends { unit?: { listingType: string | null; apartment: { unitCode: string } | null } | null }>(row: T) {
  const { unit, ...rest } = row;
  return { ...rest, apartmentUnitCode: unit?.apartment?.unitCode ?? null, listingType: unit?.listingType ?? null };
}
export function flattenApartmentLabel<T extends { apartment?: { unitCode: string } | null }>(row: T) {
  const { apartment, ...rest } = row;
  return { ...rest, apartmentUnitCode: apartment?.unitCode ?? null };
}

export async function listMetersService(session: SessionPayload, q: { propertyId?: string; unitId?: string; isActive?: boolean; cursor?: string; limit: number }): Promise<Result<unknown>> {
  const where: Prisma.AircondMeterWhereInput = {};
  if (q.unitId) where.unitId = q.unitId;
  if (q.isActive !== undefined) where.isActive = q.isActive;
  if (q.propertyId) where.unit = { apartment: { propertyId: q.propertyId } };
  const rows = await repo.listMeters(session.orgId, where, q.limit, q.cursor);
  const p = page(rows, q.limit);
  return ok({ data: p.data.map(flattenUnitLabel), nextCursor: p.nextCursor });
}
export async function getMeterService(session: SessionPayload, id: string): Promise<Result<unknown>> {
  const m = await repo.getMeter(getDb(), session.orgId, id);
  return m ? ok(m) : err(404, "METER_NOT_FOUND");
}
export async function listReadingsService(session: SessionPayload, q: { periodMonth?: string; unitId?: string; status: string; cursor?: string; limit: number }): Promise<Result<unknown>> {
  const where: Prisma.MeterReadingWhereInput = {};
  if (q.unitId) where.unitId = q.unitId;
  if (q.periodMonth) where.periodMonth = toMonth(q.periodMonth);
  if (q.status !== "all") where.status = q.status;
  const rows = await repo.listReadings(session.orgId, where, q.limit, q.cursor);
  const p = page(rows, q.limit);
  return ok({ data: p.data.map(flattenUnitLabel), nextCursor: p.nextCursor });
}
export async function getReadingService(session: SessionPayload, id: string): Promise<Result<unknown>> {
  const r = await repo.getReading(getDb(), session.orgId, id);
  return r ? ok(r) : err(404, "READING_NOT_FOUND");
}
export async function listUtilityBillsService(session: SessionPayload, q: { propertyId?: string; apartmentId?: string; periodMonth?: string; status: string; cursor?: string; limit: number }): Promise<Result<unknown>> {
  const where: Prisma.UnitUtilityBillWhereInput = {};
  if (q.apartmentId) where.apartmentId = q.apartmentId;
  if (q.periodMonth) where.periodMonth = toMonth(q.periodMonth);
  if (q.status !== "all") where.status = q.status;
  // q.method filter removed: UnitUtilityBill.method column dropped in Task 1
  if (q.propertyId) where.apartment = { propertyId: q.propertyId };
  const rows = await repo.listBills(session.orgId, where, q.limit, q.cursor);
  const p = page(rows, q.limit);
  return ok({ data: p.data.map(flattenApartmentLabel), nextCursor: p.nextCursor });
}
export async function getUtilityBillService(session: SessionPayload, id: string): Promise<Result<unknown>> {
  const b = await repo.getBillWithAllocations(getDb(), session.orgId, id);
  return b ? ok(b) : err(404, "BILL_NOT_FOUND");
}
export async function getAllocationService(session: SessionPayload, id: string): Promise<Result<unknown>> {
  const a = await repo.getAllocation(getDb(), session.orgId, id);
  return a ? ok(a) : err(404, "ALLOCATION_NOT_FOUND");
}

// ── Billing Grid ─────────────────────────────────────────────────────────────
export async function getBillingGridService(session: SessionPayload, apartmentId: string, period?: string): Promise<Result<unknown>> {
  const db = getDb();
  // 1. Resolve period to UTC first-of-month
  const periodMonth = period
    ? toMonth(period)
    : (() => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)); })();
  // 2. Load apartment with org-scope check
  const apt = await db.apartment.findFirst({
    where: { organizationId: session.orgId, id: apartmentId },
    select: { id: true, unitCode: true, listingMode: true, property: { select: { name: true } } },
  });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");
  // 2b. Resolve the apartment's owner (Task 9 D1: gates the workspace's
  // Generate-statement action). Reuses the same lookup as the bill-attachment
  // mirror (Task 5) — one landlord per physical apartment; null when unassigned.
  const ownerPartyId = await repo.findApartmentOwnerPartyId(db, session.orgId, apartmentId);
  // 3. Load rooms with tenancy + meter + current-period readings
  const rooms = await repo.findBillingGridRooms(db, session.orgId, apartmentId, periodMonth);
  // 4. Prior readings per room (N+1 acceptable for ≤12 rooms per brief)
  const roomsWithPrev = await Promise.all(
    rooms.map(async (r) => {
      const prior = r.meter ? await repo.findLatestPriorReading(db, session.orgId, r.unitId, periodMonth) : null;
      return { ...r, previousReading: prior ? String(prior.currentReading) : null };
    }),
  );
  // 5. Load this period's UnitUtilityBill
  const bill = await repo.findBillByAptPeriod(db, session.orgId, apartmentId, periodMonth);
  // 6. Format period string (YYYY-MM-DD)
  const periodStr = periodMonth.toISOString().slice(0, 10);
  return ok({
    apartment: { id: apt.id, unitCode: apt.unitCode, propertyName: apt.property?.name ?? null, listingMode: apt.listingMode, ownerPartyId },
    period: periodStr,
    rooms: roomsWithPrev.map((r) => ({
      unitId: r.unitId,
      unitCode: r.unitCode,
      listingType: r.listingType,
      occupied: r.tenancy !== null,
      tenantName: r.tenantName ?? null,
      tenancyId: r.tenancy?.id ?? null,
      pax: r.tenancy?.numberOfPax ?? null,
      meter: r.meter,
      previousReading: r.previousReading,
      currentReading: r.currentReading,
    })),
    // bill.method dropped (Task 1): BillingGridResponse.bill is { id, status } | null.
    bill: bill ? { id: bill.id, status: bill.status as "draft" | "charged" | "void" } : null,
  });
}

// ── Month cockpit (portfolio-wide per-period progress + worklist, §4.1/§4.6) ──
// Read-only aggregation; no mutations, no audit. Definitions (confirmed against
// the data model + spec — see CockpitResponse doc in @kason/shared):
//   readings.total = occupied rooms; readings.done = those with a non-void
//     reading this period.
//   bills.total / charged.total = apartments with >=1 occupied room (the
//     billable set); bills.drafted = those with ANY bill this period;
//     charged.done = those whose bill is status "charged".
//   worklist.occupiedUnread = occupied rooms with no reading (capped, full count
//     kept); vacantWithReading = non-occupied rooms WITH a reading (anomaly).
export async function getCockpitService(session: SessionPayload, period?: string): Promise<Result<CockpitResponse>> {
  const db = getDb();
  // Resolve period to UTC first-of-month — same rule as getBillingGridService.
  const periodMonth = period
    ? toMonth(period)
    : (() => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)); })();

  const [rooms, readUnitIds, bills] = await Promise.all([
    repo.findCockpitRooms(db, session.orgId),
    repo.findCockpitReadUnitIds(db, session.orgId, periodMonth),
    repo.findCockpitBills(db, session.orgId, periodMonth),
  ]);

  const occupiedRooms = rooms.filter((r) => r.occupied);
  const vacantRooms = rooms.filter((r) => !r.occupied);

  // readings: occupied rooms vs. those with a non-void reading this period.
  const readingsTotal = occupiedRooms.length;
  const readingsDone = occupiedRooms.filter((r) => readUnitIds.has(r.unitId)).length;

  // billable apartments = distinct apartmentIds that have >=1 occupied room.
  const billableApartmentIds = new Set(occupiedRooms.map((r) => r.apartmentId));
  const billsTotal = billableApartmentIds.size;
  // Bill status per apartment for the period (one bill/apt/period). Restrict to
  // the billable set so a stray bill on an all-vacant apartment can't push
  // `drafted`/`done` above the denominator.
  const billStatusByApt = new Map(bills.map((b) => [b.apartmentId, b.status]));
  let billsDrafted = 0;
  let chargedDone = 0;
  for (const aptId of billableApartmentIds) {
    const status = billStatusByApt.get(aptId);
    if (status !== undefined) billsDrafted += 1; // any bill (draft|charged|void) = "drafted"
    if (status === "charged") chargedDone += 1;
  }

  // worklist: occupied-unread (to fix) + vacant-with-reading (anomaly).
  const occupiedUnreadAll = occupiedRooms.filter((r) => !readUnitIds.has(r.unitId));
  const vacantWithReadingAll = vacantRooms.filter((r) => readUnitIds.has(r.unitId));

  return ok({
    period: periodMonth.toISOString().slice(0, 10),
    readings: { done: readingsDone, total: readingsTotal },
    bills: { drafted: billsDrafted, total: billsTotal },
    charged: { done: chargedDone, total: billsTotal },
    worklist: {
      occupiedUnread: occupiedUnreadAll
        .slice(0, COCKPIT_WORKLIST_CAP)
        .map((r) => ({ unitId: r.unitId, unitCode: r.unitCode, apartmentId: r.apartmentId })),
      occupiedUnreadCount: occupiedUnreadAll.length,
      vacantWithReading: vacantWithReadingAll
        .slice(0, COCKPIT_WORKLIST_CAP)
        .map((r) => ({ unitId: r.unitId, unitCode: r.unitCode })),
      vacantWithReadingCount: vacantWithReadingAll.length,
    },
  });
}
