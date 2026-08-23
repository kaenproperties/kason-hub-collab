/**
 * Materialize per-unit-month payout figures into UnitMonthLedger.
 *
 * PURE CACHE of resolveOwnerPayoutForScope: fetches the owner's inputs ONCE for
 * the month, then computes each owned apartment's slice with the SAME
 * computeOwnerPayout engine and upserts one row per owned apartment (zero row
 * when the apartment has no ledger rows — parity with the live null→zero).
 * Null-apartment residuals are NOT materialized (read computes them live).
 *
 * Never throws on the money path: callers wrap best-effort (see sync hook).
 */
import { getDb } from "@kason/db";
import { toCents } from "@kason/shared";
import {
  computeOwnerPayout,
  fetchOwnerReceivablePayoutRows,
  findOwnerLedgerRowsForMonth,
} from "../owner-billing/owner-statement-sections";
import {
  findDepositsCollectedInMonth,
  depositWindowEndOfMonth,
} from "../owner-billing/owner-billing.repository";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

export async function materializeOwnerUnitMonths(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string, // "YYYY-MM"
): Promise<{ upserted: number }> {
  if (!/^\d{4}-\d{2}$/.test(month))
    throw new Error(`materializeOwnerUnitMonths: invalid month "${month}" (expected YYYY-MM)`);
  const [y, m] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(y!, m! - 1, 1));
  const monthEnd = depositWindowEndOfMonth(monthStart);
  const db = getDb();

  // 1. Owner-wide inputs, fetched ONCE.
  // Eagerly capture the first query promise before building the Promise.all array
  // so that if a subsequent argument throws synchronously (e.g. in a mocked
  // environment that lacks managementFeeConfig), the first Promise is not left
  // floating with no rejection handler.
  const rowsP = findOwnerLedgerRowsForMonth(ctx, ownerPartyId, monthStart, null);
  void rowsP.catch(() => {}); // guard against unhandled rejection if Promise.all is never reached
  const [rows, feeConfigRows, ownedListings] = await Promise.all([
    rowsP,
    db.managementFeeConfig.findMany({
      where: { organizationId: ctx.orgId, ownerPartyId, isActive: true },
      select: { propertyId: true, apartmentId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, effectiveFrom: true, effectiveTo: true, freePeriodStart: true, freePeriodEnd: true, updatedAt: true },
    }),
    db.listing.findMany({
      where: { organizationId: ctx.orgId, ownerPartyId, listingStatus: { not: "archived" } },
      select: { id: true, apartmentId: true },
    }),
  ]);

  // apartmentId -> owned listing ids (unitIds for deposits)
  const unitIdsByApt = new Map<string, string[]>();
  for (const l of ownedListings) {
    if (!l.apartmentId) continue;
    const arr = unitIdsByApt.get(l.apartmentId) ?? [];
    arr.push(l.id);
    unitIdsByApt.set(l.apartmentId, arr);
  }
  const allUnitIds = ownedListings.map((l) => l.id);
  const deposits = allUnitIds.length > 0
    ? await findDepositsCollectedInMonth(ctx.orgId, allUnitIds, monthStart, monthEnd)
    : [];
  const depositCByUnit = new Map<string, number>();
  for (const d of deposits) depositCByUnit.set(d.unitId, (depositCByUnit.get(d.unitId) ?? 0) + toCents(d.amount, "materializeOwnerUnitMonths"));

  // rows grouped by apartmentId (null-apartment rows excluded — residuals are live).
  const rowsByApt = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.apartmentId) continue;
    const arr = rowsByApt.get(r.apartmentId) ?? [];
    arr.push(r);
    rowsByApt.set(r.apartmentId, arr);
  }

  const feeMaxUpdatedAt = feeConfigRows.reduce<Date | null>((mx, f) => (!mx || f.updatedAt > mx ? f.updatedAt : mx), null);

  // 2. Compute + upsert one row per OWNED apartment (including empty → zero row,
  //    so the read never sees an owned apartment as "missing" and re-triggers sync).
  //    ALWAYS write current figures — NO watermark-based skip. A watermark derived
  //    from surviving inputs regresses whenever an input is REMOVED (a voided
  //    ledger row, a retired fee config), which would strand stale/overstated
  //    figures no backstop can heal. Converging to the live engine on every run
  //    matters more than the rare concurrent-recompute race (healed by the
  //    reconcile cron + the next mutation). sourceMaxUpdatedAt is stored for
  //    observability only.
  const aptIds = [...unitIdsByApt.keys()];

  let upserted = 0;
  for (const aptId of aptIds) {
    const aptRows = rowsByApt.get(aptId) ?? [];
    const aptUnitIds = unitIdsByApt.get(aptId) ?? [];
    const depositCollectedC = aptUnitIds.reduce((acc, uid) => acc + (depositCByUnit.get(uid) ?? 0), 0);

    // Owner-borne bills-grid charges are IVOWN receivables rather than ledger
    // expense rows (the durable XOR in owner-ledger.sync keeps them out of both
    // sources). The live Owner Report / resolveOwnerPayoutForScope includes them
    // through this helper, so the materialized grid cache must do the same. Without
    // it the Owner Payout cell showed Gross Cash In while the report correctly
    // deducted owner expenses.
    const receivableRows = await fetchOwnerReceivablePayoutRows(
      ctx.orgId,
      ownerPartyId,
      monthStart,
      aptId,
      aptRows,
    );
    const payoutRows = [...aptRows, ...receivableRows] as typeof aptRows;

    // Parity with resolveOwnerPayoutForScope. A unit may legitimately have an
    // owner receivable even when it has no income ledger row, so receivables alone
    // must still produce a top-up instead of being materialized as zero.
    const b = payoutRows.length > 0
      ? computeOwnerPayout({ rows: payoutRows, feeConfigRows, depositCollectedC, statementMonth: monthStart })
      : null;

    // Observability only (NOT used to gate the write).
    const rowMax = aptRows.reduce<Date | null>((mx, r) => (!mx || r.updatedAt > mx ? r.updatedAt : mx), null);
    const watermark = [rowMax, feeMaxUpdatedAt].filter(Boolean).reduce<Date>((mx, d) => (d! > mx ? d! : mx), new Date(0));

    await db.unitMonthLedger.upsert({
      where: { organizationId_apartmentId_periodMonth: { organizationId: ctx.orgId, apartmentId: aptId, periodMonth: monthStart } },
      create: {
        organizationId: ctx.orgId, apartmentId: aptId, periodMonth: monthStart, ownerPartyId,
        incomeC: b?.grossRentalC ?? 0, deductibleExpensesC: b?.deductibleExpensesC ?? 0,
        netPayoutC: b?.payableToOwnerC ?? 0, ownerTopUpC: b?.ownerTopUpRequiredC ?? 0, mgmtFeeC: b?.computedMgmtBaseC ?? 0, sstC: b?.computedMgmtSstC ?? 0,
        sourceMaxUpdatedAt: watermark, computedAt: new Date(),
      },
      update: {
        ownerPartyId,
        incomeC: b?.grossRentalC ?? 0, deductibleExpensesC: b?.deductibleExpensesC ?? 0,
        netPayoutC: b?.payableToOwnerC ?? 0, ownerTopUpC: b?.ownerTopUpRequiredC ?? 0, mgmtFeeC: b?.computedMgmtBaseC ?? 0, sstC: b?.computedMgmtSstC ?? 0,
        sourceMaxUpdatedAt: watermark, computedAt: new Date(),
      },
    });
    upserted++;
  }

  // 3. Owner-loss cleanup: delete rows for apartments this owner NO LONGER owns
  //    (e.g. the apartment's owner was cleared to null). Filtered by ownerPartyId,
  //    so an A→B reassignment is untouched here — B's materialize already
  //    overwrote the row to ownerPartyId=B, so it won't match A's cleanup.
  //    When aptIds is empty (owner now owns nothing) all their rows for the month
  //    are removed.
  await db.unitMonthLedger.deleteMany({
    where: {
      organizationId: ctx.orgId,
      periodMonth: monthStart,
      ownerPartyId,
      ...(aptIds.length > 0 ? { apartmentId: { notIn: aptIds } } : {}),
    },
  });

  return { upserted };
}
