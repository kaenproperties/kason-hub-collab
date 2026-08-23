import { getDb, Prisma } from "@kason/db";
import { chargeDisplayStatus, ownerCounterpartyWhere } from "./charge-classify";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

/** Register pagination (spec §4.8 gap) — omit to get the full unpaginated list. */
export type ChargesPagination = { page: number; pageSize: number };

/** Server-side filters for the charges v2 register (spec §3.4). All optional. */
export type ChargesListFilters = {
  partyId?: string;
  outstandingOnly?: boolean;
  status?: string;
  unitId?: string;
  categoryId?: string;
  counterparty?: "tenant" | "owner";
  month?: string; // bare YYYY-MM
  q?: string;
  economicClassificationStatus?: string;
};

/**
 * Single source of truth for listCharges/countCharges' where clause.
 * Legacy byte-compat: with no filters the where clause stays exactly
 * { organizationId } — the flag-dark pages depend on this response.
 */
function buildChargesWhere(organizationId: string, filters?: ChargesListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { organizationId };
  if (filters?.partyId) where.partyId = filters.partyId;
  if (filters?.status) where.status = filters.status;
  if (filters?.unitId) where.unitId = filters.unitId;
  if (filters?.categoryId) where.categoryId = filters.categoryId;
  if (filters?.economicClassificationStatus) where.economicClassificationStatus = filters.economicClassificationStatus;
  if (filters?.outstandingOnly) {
    where.status = { in: ["posted", "partially_paid"] };
    where.outstandingAmount = { gt: 0 };
  }
  if (filters?.month) {
    const [y, m] = filters.month.split("-").map(Number);
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 1));
    where.OR = [
      { billingMonth: { gte: monthStart, lt: monthEnd } },
      { billingMonth: null, dueDate: { gte: monthStart, lt: monthEnd } },
    ];
  }
  if (filters?.counterparty === "owner") {
    where.AND = [...((where.AND as unknown[]) ?? []), ownerCounterpartyWhere()];
  } else if (filters?.counterparty === "tenant") {
    where.AND = [...((where.AND as unknown[]) ?? []), { NOT: ownerCounterpartyWhere() }];
  }
  if (filters?.q) {
    where.AND = [
      ...((where.AND as unknown[]) ?? []),
      {
        OR: [
          { chargeNumber: { contains: filters.q, mode: "insensitive" } },
          { party: { displayName: { contains: filters.q, mode: "insensitive" } } },
        ],
      },
    ];
  }
  return where;
}

export async function listCharges(
  organizationId: string,
  pagination?: ChargesPagination,
  filters?: ChargesListFilters,
) {
  const db = getDb();
  const where = buildChargesWhere(organizationId, filters);
  const rows = await db.charge.findMany({
    where,
    include: {
      party: { select: { displayName: true } },
      tenancy: { select: { tenancyCode: true } },
      unit: { select: { apartment: { select: { unitCode: true } } } },
      invoice: { select: { invoiceNumber: true, invoiceType: true } },
      events: {
        orderBy: [{ eventAt: "desc" }],
        take: 3,
        select: {
          eventType: true,
          eventAt: true,
          payloadJson: true,
        },
      },
    },
    // `id` tiebreaker keeps skip/take stable across pages when createdAt
    // collides (common with bulk-seeded/same-millisecond rows) — it's a
    // no-op reordering for the no-pagination path since Charge.createdAt
    // ties were already order-undefined there.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(pagination
      ? { skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize }
      : {}),
  });

  // Accounting docs: surface each charge's issued document (id + number). Lines
  // keep a PLAIN chargeId column (no relation), so enrich via one batched lookup
  // (Task 3's findDocumentsByChargeIds — shared with the grouped endpoint).
  const docByCharge = await findDocumentsByChargeIds(rows.map((r) => r.id));

  return rows.map((row) => ({
    id: row.id,
    chargeNumber: row.chargeNumber,
    partyName: row.party.displayName,
    tenancyCode: row.tenancy?.tenancyCode ?? null,
    unitCode: row.unit?.apartment.unitCode ?? null,
    chargeType: row.chargeType,
    description: row.description,
    status: row.status,
    displayStatus: chargeDisplayStatus(row),
    dueDate: row.dueDate.toISOString(),
    billingMonth: row.billingMonth?.toISOString() ?? null,
    amount: toNumber(row.amount),
    outstandingAmount: toNumber(row.outstandingAmount),
    currency: row.currency,
    invoiceNumber: row.invoice?.invoiceNumber ?? null,
    documentId: docByCharge.get(row.id)?.id ?? null,
    documentNumber: docByCharge.get(row.id)?.documentNumber ?? null,
    events: row.events.map((event) => ({
      eventType: event.eventType,
      eventAt: event.eventAt.toISOString(),
      payloadJson: event.payloadJson,
    })),
  }));
}

/** Org-wide charge count, for the paginated register mode (spec §4.8 gap). Filters MUST mirror listCharges (buildChargesWhere is the single source of truth). */
export async function countCharges(organizationId: string, filters?: ChargesListFilters): Promise<number> {
  const db = getDb();
  return db.charge.count({ where: buildChargesWhere(organizationId, filters) });
}

/** Month-scoped header metrics for the charges v2 page (spec §3.1). */
export async function chargesSummary(organizationId: string, monthStart: Date, monthEnd: Date) {
  const db = getDb();
  const [rows, activeTenancies] = await Promise.all([
    db.charge.findMany({
      where: {
        organizationId,
        OR: [
          { billingMonth: { gte: monthStart, lt: monthEnd } },
          { billingMonth: null, dueDate: { gte: monthStart, lt: monthEnd } },
        ],
      },
      select: { status: true, unitId: true, amount: true, outstandingAmount: true },
    }),
    db.tenancy.findMany({
      where: {
        organizationId,
        status: "active",
        startDate: { lt: monthEnd },
        OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
      },
      select: { unitId: true },
      distinct: ["unitId"],
    }),
  ]);

  const POSTED_LIKE = new Set(["posted", "partially_paid", "paid"]);
  let billedTotal = 0;
  let postedCount = 0;
  let outstandingTotal = 0;
  const billedUnits = new Set<string>();
  for (const r of rows) {
    if (r.status !== "void" && r.status !== "credited") billedTotal += toNumber(r.amount);
    if (r.status === "posted" || r.status === "partially_paid") {
      postedCount += 1;
      outstandingTotal += toNumber(r.outstandingAmount);
    } else if (r.status === "paid") {
      postedCount += 1;
    }
    if (POSTED_LIKE.has(r.status) && r.unitId) billedUnits.add(r.unitId);
  }
  return {
    billedTotal,
    postedCount,
    outstandingTotal,
    unitsBilled: billedUnits.size,
    unitsWithActiveTenancy: activeTenancies.length,
  };
}

export async function findChargeByNumber(organizationId: string, chargeNumber: string) {
  const db = getDb();
  return db.charge.findFirst({
    where: { organizationId, chargeNumber },
    select: { id: true },
  });
}

export async function findChargeById(organizationId: string, chargeId: string) {
  const db = getDb();
  return db.charge.findFirst({
    where: { organizationId, id: chargeId },
    // Union of both callers' needs (shared helper): chargeNumber for the
    // void-dialog GET /charges/:chargeId (R5b); unitId + billingMonth/dueDate
    // for the post-charge readiness guard (billingMonth is the period key,
    // dueDate the fallback). postChargeService/voidChargeService read only
    // `!existing`/`.status`, so extra fields are a no-op for them.
    select: {
      id: true,
      chargeNumber: true,
      chargeType: true,
      status: true,
      parentChargeId: true,
      invoiceId: true,
      sstRate: true,
      unitId: true,
      billingMonth: true,
      dueDate: true,
    },
  });
}

export async function createCharge(
  params: {
    organizationId: string;
    chargeNumber: string;
    tenancyId?: string | null;
    unitId?: string | null;
    partyId: string;
    chargeType: string;
    categoryId?: string | null;
    description?: string | null;
    dueDate: Date;
    billingMonth?: Date | null;
    amount: number;
    currency: string;
  },
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? getDb();
  return db.charge.create({
    data: {
      organizationId: params.organizationId,
      chargeNumber: params.chargeNumber,
      tenancyId: params.tenancyId ?? null,
      unitId: params.unitId ?? null,
      partyId: params.partyId,
      chargeType: params.chargeType,
      categoryId: params.categoryId ?? null,
      status: "draft",
      description: params.description ?? null,
      dueDate: params.dueDate,
      billingMonth: params.billingMonth ?? null,
      amount: params.amount,
      currency: params.currency,
      outstandingAmount: params.amount,
      attachmentKeys: [],
    },
    select: { id: true },
  });
}

/**
 * Compound duplicate-charge check (Spec2 R1) — an active charge matching
 * (organizationId, unitId, categoryId, billingMonth, amount), excluding
 * void/credited. MUST run inside the same transaction as the create it is
 * guarding (check-first) — the partial unique index from Task 1 is the race
 * backstop, not the primary guard (see createChargeService's P2002 catch).
 */
export async function findActiveDuplicateCharge(
  tx: Prisma.TransactionClient,
  organizationId: string,
  k: { unitId: string; categoryId: string; billingMonth: Date; amount: number },
): Promise<{ id: string } | null> {
  return tx.charge.findFirst({
    where: {
      organizationId,
      unitId: k.unitId,
      categoryId: k.categoryId,
      billingMonth: k.billingMonth,
      // Round IDENTICALLY to how Charge.amount is stored (payment-guard parity,
      // Spec2 R9): amount is numeric(12,2), and the create path hands Prisma a
      // raw JS number for a Decimal column, which Postgres rounds half-up on
      // write (e.g. 100.005 -> 100.01). createChargeSchema.amount is
      // z.string().min(1) (no dp cap), so a 3dp amount is API/tracker-reachable;
      // a raw-float where value (100.005) never equals the stored 2dp row, so
      // the check-first missed it and the 409 lost existingChargeId (the DB
      // partial index still blocked the double-charge on the stored 2dp value).
      // Prisma.Decimal walks the same decimal-string + half-up pipeline Postgres
      // uses, so query-time rounding matches store-time rounding for any input.
      // Rounding mode is passed EXPLICITLY (not the ambient Prisma.Decimal
      // .rounding default) because that default is global mutable state shared
      // by every other Decimal user in the codebase.
      amount: new Prisma.Decimal(k.amount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      status: { notIn: ["void", "credited"] },
    },
    select: { id: true },
  });
}

/** Org-scoped category lookup for create-time enforcement (accounting-docs P1). */
export async function findChargeCategoryForCreate(organizationId: string, categoryId: string) {
  const db = getDb();
  return db.chargeCategory.findFirst({
    where: { organizationId, id: categoryId },
    select: { id: true, active: true, code: true },
  });
}

export async function updateChargeStatus(params: {
  chargeId: string;
  status: string;
  postedAt?: Date | null;
  cancelledReason?: string | null;
  outstandingAmount?: number;
}) {
  const db = getDb();
  await db.charge.update({
    where: { id: params.chargeId },
    data: {
      status: params.status,
      ...(params.postedAt !== undefined ? { postedAt: params.postedAt } : {}),
      ...(params.cancelledReason !== undefined ? { cancelledReason: params.cancelledReason } : {}),
      ...(params.outstandingAmount !== undefined ? { outstandingAmount: params.outstandingAmount } : {}),
    },
  });
}

/**
 * Month-scoped fetch for the grouped register (charges v2 §3.2/§3.3).
 * Window mirrors chargeBillingMonth(): billingMonth is the period key, with a
 * dueDate fallback for legacy/manual rows where billingMonth is null.
 * monthEnd is EXCLUSIVE. KAEN scale ≈ 400 charges/month — unpaginated by design.
 */
export async function listChargesForMonth(organizationId: string, monthStart: Date, monthEnd: Date) {
  const db = getDb();
  return db.charge.findMany({
    where: {
      organizationId,
      OR: [
        { billingMonth: { gte: monthStart, lt: monthEnd } },
        { billingMonth: null, dueDate: { gte: monthStart, lt: monthEnd } },
      ],
    },
    include: {
      party: { select: { displayName: true } },
      tenancy: { select: { tenancyCode: true } },
      unit: { select: { apartment: { select: { id: true, unitCode: true, property: { select: { name: true } } } } } },
      carpark: { select: { label: true } },
      category: { select: { name: true, family: true } },
      invoice: { select: { id: true, invoiceNumber: true, status: true, invoiceType: true } },
    },
    orderBy: [{ chargeNumber: "asc" }],
  });
}

/** First non-CN/RN, non-proforma BillingDocument (id + number) per charge — grouped/list enrich.
 *
 * A DENYLIST, which is why `proforma` had to be named here explicitly rather than being
 * excluded for free the way it is from every `docType: { in: [...] }` allowlist. This
 * answers "which document is this charge on?" for the charges and payments lists, taking
 * the EARLIEST issued document per charge — and a proforma is issued at Bill time, strictly
 * before the invoice graduated from it at payment time. Left unnamed, every paid charge
 * would report its provisional PI- number instead of the real IVTEN- tax invoice the money
 * actually settled, on exactly the screens an admin uses to reconcile a payment. */
export async function findDocumentsByChargeIds(chargeIds: string[]) {
  if (chargeIds.length === 0) return new Map<string, { id: string; documentNumber: string }>();
  const db = getDb();
  const lines = await db.billingDocumentLine.findMany({
    where: { chargeId: { in: chargeIds } },
    select: { chargeId: true, document: { select: { id: true, documentNumber: true, docType: true } } },
    orderBy: { document: { issuedAt: "asc" } },
  });
  const byCharge = new Map<string, { id: string; documentNumber: string }>();
  for (const l of lines) {
    // Query is scoped to `chargeId: { in: chargeIds }` (real charge UUIDs), so a
    // null chargeId (R12a overpayment-CN lines) can never match here — narrow
    // defensively rather than assert.
    if (l.chargeId === null) continue;
    if (
      l.document.docType === "credit_note"
      || l.document.docType === "refund_note"
      || l.document.docType === "proforma"
    ) continue;
    if (!byCharge.has(l.chargeId)) byCharge.set(l.chargeId, { id: l.document.id, documentNumber: l.document.documentNumber });
  }
  return byCharge;
}

/** IVOWN invoice document per owner statement (batched, for statement group headers). */
export async function findIvownDocsByInvoiceIds(invoiceIds: string[]) {
  if (invoiceIds.length === 0) return new Map<string, { id: string; documentNumber: string }>();
  const db = getDb();
  const docs = await db.billingDocument.findMany({
    where: { statementInvoiceId: { in: invoiceIds }, docType: "invoice" },
    select: { id: true, documentNumber: true, statementInvoiceId: true },
  });
  const byInvoice = new Map<string, { id: string; documentNumber: string }>();
  for (const d of docs) {
    if (d.statementInvoiceId && !byInvoice.has(d.statementInvoiceId)) {
      byInvoice.set(d.statementInvoiceId, { id: d.id, documentNumber: d.documentNumber });
    }
  }
  return byInvoice;
}

export async function createChargeEvent(
  params: {
    organizationId: string;
    chargeId: string;
    eventType: string;
    actorUserId: string;
    payload?: unknown;
  },
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? getDb();
  await db.chargeEvent.create({
    data: {
      organizationId: params.organizationId,
      chargeId: params.chargeId,
      eventType: params.eventType,
      eventAt: new Date(),
      actorUserId: params.actorUserId,
      payloadJson: (params.payload as object | undefined) ?? {},
    },
  });
}
