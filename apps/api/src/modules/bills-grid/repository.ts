// Bills & Expenses Grid — data-access layer over the 5 grid tables.
// This module reads/writes ONLY: UnitBillsGridEntry, UnitBillsBearerConfig,
// GridExpense, GridMeterReading, GridAttachment. It NEVER touches
// Charge / OwnerLedgerEntry / UnitUtilityBill (HARD CONSTRAINT).
//
// Central job: race-safe get-or-create of the parent UnitBillsGridEntry for
// (organizationId, apartmentId, periodMonth) INSIDE the caller's $transaction.
// Every child write (GridExpense / GridMeterReading / GridAttachment) carries a
// NON-NULL entryId, so it must resolve-or-create the parent first.
import type { Prisma } from "@prisma/client";
import { SCALAR_RECURRING_KINDS, isScalarRecurringKind, type ScalarRecurringKind } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { bearerDefaultsFor } from "./bearer-defaults";
import { resolveRecurringTarget } from "./period-lock";

export interface EntryCtx {
  orgId: string;
  apartmentId: string;
  periodMonth: Date;
  actorUserId: string;
}

/** The single revision of a definition whose [effectiveFromMonth, effectiveToMonth) range
 * covers `period` (revisions never overlap, R1), or null when `period` precedes the earliest
 * revision (→ the CLEANING/WIFI scalar falls back to the config seed; no CUSTOM line). */
function applicableRevision<R extends { effectiveFromMonth: Date; effectiveToMonth: Date | null }>(revisions: R[], period: Date): R | null {
  const t = period.getTime();
  return (
    revisions.find(
      (r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()),
    ) ?? null
  );
}

/** A CUSTOM recurring line resolved for one apartment-month, BEFORE it is persisted. Shared by
 * getOrCreateEntry (materialize-on-open → a GridEntryRecurringLine child row) and
 * listRecurringLinesService (the dialog's read-time projection for a month whose entry does not
 * exist yet), so the charge shown before a period is opened is exactly what opening it will
 * materialize. */
export type ResolvedCustomRecurringLine = {
  definitionId: string;
  revisionId: string;
  name: string;
  amount: Prisma.Decimal;
  bearer: string;
  nature: string | null; // "expense" | "profit" — the revision's nature carried onto the snapshot (null = legacy → profit)
  category: { id: string; code: string; name: string; family: string };
  target: { resolvedPartyId: string; resolvedTenancyId: string | null; resolvedUnitId: string };
};

/** The recurring config resolved for one apartment-month: the CLEANING/WIFI scalar override an
 * applicable enabled revision dictates (absent ⇒ the caller keeps its config seed) plus every
 * resolvable enabled CUSTOM line. PURE read — writes NOTHING. A CUSTOM line whose owner/tenant
 * target or category cannot resolve is OMITTED (the same fail-closed rule materialize-on-open
 * uses), so projection and materialization never diverge. */
export type ResolvedRecurring = {
  cleaning?: { amount: Prisma.Decimal | string; bearer: string; nature: string | null };
  wifi?: { amount: Prisma.Decimal | string; bearer: string; nature: string | null };
  /** The OTHER scalar kinds (TNB/AIR/MAINTENANCE), ENABLED revisions only — 2026-08-06 fix:
   * a Maintenance def saved before the month was opened never materialized, so the fee was
   * stored-but-never-billed. Deliberately a separate bag from cleaning/wifi: those two keep
   * their legacy disabled→"0.00" contract, while for these kinds a disabled def must leave
   * the entry column NULL (a 0.00 tnbTotalRaw would read as a real zero provider bill). */
  scalars: Partial<Record<Exclude<ScalarRecurringKind, "CLEANING" | "WIFI">, { amount: Prisma.Decimal; bearer: string; nature: string | null }>>;
  customLines: ResolvedCustomRecurringLine[];
};

/** Resolve, for THIS apartment-month, every non-archived definition whose applicable revision
 * (its [from,to) range covers the month) governs it — the single source of truth both
 * materialize-on-open and the dialog read consult. Flag gating + persistence stay with the
 * callers; this is a pure resolver (spec R4). */
export async function resolveRecurringForPeriod(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  periodMonth: Date,
): Promise<ResolvedRecurring> {
  const out: ResolvedRecurring = { scalars: {}, customLines: [] };
  const defs = await tx.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId, archivedAt: null },
    include: { revisions: true },
  });
  for (const def of defs) {
    const rev = applicableRevision(def.revisions, periodMonth);
    if (!rev) continue;
    if (def.kind === "CLEANING") out.cleaning = { amount: rev.enabled ? rev.amount : "0.00", bearer: rev.bearer, nature: rev.nature };
    else if (def.kind === "WIFI") out.wifi = { amount: rev.enabled ? rev.amount : "0.00", bearer: rev.bearer, nature: rev.nature };
    else if (def.kind !== "CUSTOM" && isScalarRecurringKind(def.kind)) {
      // TNB/AIR/MAINTENANCE — enabled only (see ResolvedRecurring.scalars doc).
      if (rev.enabled) out.scalars[def.kind as Exclude<ScalarRecurringKind, "CLEANING" | "WIFI">] = { amount: rev.amount, bearer: rev.bearer, nature: rev.nature };
    }
    else if (def.kind === "CUSTOM" && rev.enabled) {
      const target = await resolveRecurringTarget(tx, orgId, apartmentId, rev.bearer, periodMonth);
      if (!target) continue; // unresolved owner/tenant → fail-closed marker (no line); billing conflicts
      const cat = rev.categoryId
        ? await tx.chargeCategory.findUnique({ where: { id: rev.categoryId }, select: { id: true, code: true, name: true, family: true } })
        : null;
      if (!cat) continue; // misconfigured category → skip (billing surfaces the conflict)
      out.customLines.push({ definitionId: def.id, revisionId: rev.id, name: def.name, amount: rev.amount, bearer: rev.bearer, nature: rev.nature, category: cat, target });
    }
  }
  return out;
}

/**
 * Pin a period to the first-of-month at UTC midnight, matching the `@db.Date`
 * column (stored on the 1st) and the `@@unique([organizationId, apartmentId,
 * periodMonth])` key. Keying the get-or-create on a raw non-first date would mint
 * a duplicate month entry. Mirrors the meter module's `toMonth` intent for a Date
 * input (meter/service.ts:52 normalises the string form).
 */
export function firstOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Resolve-or-create the per-apartment bearer config. Period-independent.
 *
 * Race-safe INSIDE the caller's interactive transaction: a Postgres unique
 * violation aborts the whole transaction ("current transaction is aborted…"),
 * so the classic try/create → catch-P2002 → refetch idiom is unusable here — the
 * refetch would run in a poisoned transaction. Instead we use `createMany({
 * skipDuplicates })` which compiles to `INSERT … ON CONFLICT DO NOTHING`: it never
 * raises on a concurrent insert, leaving the transaction alive for the follow-up
 * read. On create, the five bearer columns come from the apartment's LISTING-MODE
 * defaults (`bearerDefaultsFor`) — Cleaning/WiFi are owner-borne in both modes and
 * TNB/AIR are "recharged" in both. Every other
 * column still falls back to its Prisma default (cleaningRecurringAmount 0, natures
 * null/undecided). The loser of a concurrent insert writes nothing and reads back the
 * winner's row, so the two can never disagree on the seeded bearers.
 */
export async function resolveBearerConfig(
  tx: Prisma.TransactionClient,
  ctx: { orgId: string; apartmentId: string },
) {
  const key = {
    organizationId_apartmentId: { organizationId: ctx.orgId, apartmentId: ctx.apartmentId },
  };
  const existing = await tx.unitBillsBearerConfig.findUnique({ where: key });
  if (existing) return existing;

  // Unit-type defaults, NOT the bare Prisma column defaults. This is the CREATE half of
  // the pair — getBearerConfigService/toBearerConfigDto is the read half, and both must
  // resolve through `bearerDefaultsFor` or they disagree: the drawer would show the
  // admin one value while the entry this config is snapshotted into bills another.
  // Org-scoped so a cross-org apartmentId can never leak a listing mode.
  const apt = await tx.apartment.findFirst({
    where: { id: ctx.apartmentId, organizationId: ctx.orgId },
    select: { listingMode: true },
  });
  await tx.unitBillsBearerConfig.createMany({
    data: [{ organizationId: ctx.orgId, apartmentId: ctx.apartmentId, ...bearerDefaultsFor(apt?.listingMode) }],
    skipDuplicates: true,
  });
  return tx.unitBillsBearerConfig.findUniqueOrThrow({ where: key });
}

/**
 * Resolve-or-create the parent UnitBillsGridEntry for (org, apartment, periodMonth).
 *
 * On CREATE it snapshots the five line settings + seeds `cleaning` from the config
 * (R14). Thereafter the ENTRY is authoritative for that period. A later config edit
 * deliberately updates open/billed-unpaid snapshots through setBearerConfigService,
 * but never a period with received money or a frozen owner report. A created entry is
 * NOT billed: `billedAt` stays null, `paymentStatus` stays the "unpaid" column default.
 *
 * Race: two concurrent child-writes to a never-Saved month both fall through the
 * findUnique miss. Rather than a throwing INSERT (which would hit the
 * @@unique([organizationId, apartmentId, periodMonth]) constraint and abort the
 * caller's transaction → a 500 on the "click row → expenses popup" path), we use
 * `createMany({ skipDuplicates })` (ON CONFLICT DO NOTHING): the loser's insert is a
 * no-op — it never re-snapshots — and both callers read back the winner's row.
 */
export async function getOrCreateEntry(tx: Prisma.TransactionClient, ctx: EntryCtx) {
  const periodMonth = firstOfMonthUTC(ctx.periodMonth);
  const key = {
    organizationId_apartmentId_periodMonth: {
      organizationId: ctx.orgId,
      apartmentId: ctx.apartmentId,
      periodMonth,
    },
  };

  // Fast path: the entry already exists → return it untouched. Config changes are
  // applied explicitly by setBearerConfigService, where payment/report locks can be
  // checked and the UI can report whether this particular period was updated.
  const existing = await tx.unitBillsGridEntry.findUnique({ where: key });
  if (existing) return existing;

  const cfg = await resolveBearerConfig(tx, { orgId: ctx.orgId, apartmentId: ctx.apartmentId });

  // ── Materialize-on-open (recurring-charges, spec R4). Flag-OFF ⇒ the exact legacy
  // single-scalar seed below (cleaning = config amount, no def read, no child rows) —
  // byte-identical. Flag-ON ⇒ resolve, for THIS period, every non-archived definition whose
  // applicable revision covers the month: CLEANING/WIFI overwrite the scalar + bearer, CUSTOM
  // become GridEntryRecurringLine child rows. A period BEFORE a def's earliest revision has no
  // applicable revision → the scalar falls back to the config seed (never rewrites earlier
  // months, Open Question 1). A CUSTOM target that cannot resolve is NOT materialized (no
  // wrong-party line) — billing surfaces it as a conflict, never a silent drop (R4/R5).
  const flagOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  let cleaning: Prisma.Decimal | string = cfg.cleaningRecurringAmount; // R7 auto-fill seed (legacy default)
  const cleaningBearer = cfg.cleaningBearer;
  // charge-nature-routing Fix 2 — from the CLEANING/WIFI revision when one governs (below).
  // charge-nature gate (2026-07-27): the SEED is now the unit-setting default rather than a hard
  // null, so a month opened AFTER the admin decided in the Unit setting drawer is born decided.
  // Still null when they have not decided — which is the state the bill-time gate fails closed on.
  let cleaningNature: string | null = cfg.cleaningNature;
  let wifi: Prisma.Decimal | string | undefined;
  const wifiBearer = cfg.wifiBearer;
  let wifiNature: string | null = cfg.wifiNature;
  let customToMaterialize: ResolvedCustomRecurringLine[] = [];
  // 2026-08-06: TNB/AIR/MAINTENANCE governed amounts seed their entry money column on open
  // (keyed via SCALAR_RECURRING_KINDS — the one place that mapping lives). Without this, a
  // Maintenance def saved before the month was opened never materialized: applyRecurring only
  // syncs entries that already exist, so the fee was stored-but-never-billed.
  const scalarSeeds: Record<string, Prisma.Decimal> = {};
  if (flagOn) {
    const resolved = await resolveRecurringForPeriod(tx, ctx.orgId, ctx.apartmentId, periodMonth);
    for (const [kind, s] of Object.entries(resolved.scalars)) {
      if (s) scalarSeeds[SCALAR_RECURRING_KINDS[kind as keyof typeof SCALAR_RECURRING_KINDS].entryAmountField] = s.amount;
    }
    // One writer per fact (2026-07-27): a governing revision fixes the AMOUNT and NATURE,
    // but the BEARER always belongs to the Unit-setting drawer's config. Reading
    // rev.bearer here was the missed half of that contract — a stale revision (written
    // before a bearer flip) out-voted the saved config on every materialize, so future
    // months were born with the reverted owner/tenant. cfg.cleaningBearer/cfg.wifiBearer
    // (seeded above) stay authoritative. CUSTOM lines keep their revision bearer — they
    // have no config-side control.
    if (resolved.cleaning) { cleaning = resolved.cleaning.amount; cleaningNature = resolved.cleaning.nature; }
    if (resolved.wifi) { wifi = resolved.wifi.amount; wifiNature = resolved.wifi.nature; }
    customToMaterialize = resolved.customLines;
  }

  await tx.unitBillsGridEntry.createMany({
    data: [
      {
        organizationId: ctx.orgId,
        apartmentId: ctx.apartmentId,
        periodMonth,
        tnbPattern: cfg.tnbPattern,
        airPattern: cfg.airPattern,
        cleaningBearer,
        wifiBearer,
        maintenanceFeeBearer: cfg.maintenanceFeeBearer,
        cleaning,
        cleaningNature, // Fix 2 — the governing CLEANING revision's nature, else the unit-setting default
        // `wifi` (the AMOUNT) is still written only when a WIFI definition governs — a bare scalar
        // is typed per month, so seeding an amount here would invent money. `wifiNature` is written
        // UNCONDITIONALLY: it is the admin's standing routing decision, not an amount, and gating it
        // on `wifi !== undefined` would drop the seeded default for exactly the bare-scalar unit the
        // bill-time gate would then block (charge-nature gate, 2026-07-27).
        wifiNature,
        ...(wifi !== undefined ? { wifi } : {}),
        // TNB/AIR/MAINTENANCE governed seeds (empty object flag-off / ungoverned — see above).
        ...scalarSeeds,
        createdBy: ctx.actorUserId,
        // billedAt omitted → null (editable draft); paymentStatus → "unpaid" default.
      },
    ],
    skipDuplicates: true,
  });
  const entry = await tx.unitBillsGridEntry.findUniqueOrThrow({ where: key });

  if (flagOn && customToMaterialize.length > 0) {
    const lineData: Prisma.GridEntryRecurringLineCreateManyInput[] = customToMaterialize.map((l) => ({
      organizationId: ctx.orgId,
      gridEntryId: entry.id,
      definitionId: l.definitionId,
      revisionId: l.revisionId,
      name: l.name,
      amount: l.amount,
      bearer: l.bearer,
      nature: l.nature,
      categoryId: l.category.id,
      categoryCode: l.category.code,
      categoryName: l.category.name,
      categoryFamily: l.category.family,
      resolvedPartyId: l.target.resolvedPartyId,
      resolvedTenancyId: l.target.resolvedTenancyId,
      resolvedUnitId: l.target.resolvedUnitId,
      effectiveMonth: periodMonth,
      kind: "CUSTOM",
    }));
    await tx.gridEntryRecurringLine.createMany({ data: lineData, skipDuplicates: true });
  }
  return entry;
}
