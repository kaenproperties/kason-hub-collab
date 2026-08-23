// apps/api/src/modules/expenses/expenses.service.ts
// Accounting-document redesign P3 — the internal Expense (EXP-) create service.
// Records a supplier/property cost ONCE (EXP- numbered) with its Borne-By split
// allocations (recoveryStatus defaults "pending"; downstream routing to
// EB-/owner-ledger/KAEN-opex is P4/P5/P6). Money strings are 2-dp decimals.
import { getDb, type Prisma } from "@kason/db";
import { isFullyAllocated, type SupplierExpenseInput } from "@kason/shared";
import { mintDocumentNumberTx } from "../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

// The fallback category for a KAEN operating-expense row whose source allocation has no
// chargeCategoryId, or one that doesn't resolve (chargeCategoryId is a soft reference —
// no DB FK — see supplier-expense.ts). Mirrors the repo-wide OWNER_LEDGER fallback token
// (owner-ledger.sync.ts) so P&L category reporting has one consistent "misc" bucket name.
const KAEN_OPEX_FALLBACK_CATEGORY = "other_expense";

type CreatedAllocation = {
  id: string;
  borneBy: string;
  amount: Prisma.Decimal | string;
  chargeCategoryId: string | null;
  description: string | null;
};

/**
 * P6 — route each borneBy:"kaen" allocation to its own KaenOperatingExpense row (the
 * agency's internal opex ledger; never owner/tenant money). Runs INSIDE the caller's tx
 * so a failure here rolls back the whole SupplierExpense creation. Idempotent on
 * sourceExpenseAllocationId via `@@unique([organizationId, sourceExpenseAllocationId])` +
 * skipDuplicates — safe to re-run for the same allocation id without duplicating a row.
 * tenant/owner allocations are never touched here (P4/P5's concern, already shipped).
 */
async function routeKaenOperatingExpensesTx(
  tx: Prisma.TransactionClient,
  ctx: ExpenseActorCtx,
  allocations: CreatedAllocation[],
  expenseDate: Date,
): Promise<void> {
  const kaenAllocations = allocations.filter((a) => a.borneBy === "kaen");
  if (kaenAllocations.length === 0) return;

  // Batched + org-scoped on purpose: a per-allocation lookup would (a) N+1 the transaction
  // and (b) risk resolving a same-id category row from ANOTHER org. Deliberately NOT
  // filtered on `active`: a deactivated category's name is still valid provenance for a
  // past cost.
  const categoryIds = [
    ...new Set(kaenAllocations.map((a) => a.chargeCategoryId).filter((id): id is string => id !== null)),
  ];
  const categoryMap = new Map<string, string>();
  if (categoryIds.length > 0) {
    const categories = await tx.chargeCategory.findMany({
      where: { organizationId: ctx.orgId, id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    for (const c of categories) categoryMap.set(c.id, c.name);
  }

  await tx.kaenOperatingExpense.createMany({
    data: kaenAllocations.map((a) => ({
      organizationId: ctx.orgId,
      sourceExpenseAllocationId: a.id,
      category: (a.chargeCategoryId && categoryMap.get(a.chargeCategoryId)) || KAEN_OPEX_FALLBACK_CATEGORY,
      description: a.description ?? null,
      amount: a.amount,
      expenseDate,
      createdById: ctx.actorUserId,
    })),
    skipDuplicates: true,
  });
}

export type ExpenseActorCtx = {
  orgId: string;
  actorUserId: string;
  actorRole: string;
  ip?: string;
  userAgent?: string;
};

export class ExpenseError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = "ExpenseError";
  }
}

export async function createSupplierExpenseService(
  ctx: ExpenseActorCtx,
  input: SupplierExpenseInput,
): Promise<{ id: string; expenseNumber: string }> {
  // Defense-in-depth (review panel 2026-07-22): the route already zod-validates the
  // split, but this SERVICE is the writer — re-assert the invariant so no non-route
  // caller (a future PATCH / repair / batch) can persist a mis-split. See
  // supplier-expense.ts isFullyAllocated.
  if (!isFullyAllocated(input.totalAmount, input.allocations)) {
    throw new ExpenseError(400, "ALLOCATIONS_NOT_FULLY_ALLOCATED");
  }
  const db = getDb();
  await ensureChargeCategorySeeds(ctx.orgId); // guarantees the EXP series exists (own connection)
  return db.$transaction(async (tx) => {
    const series = await tx.documentSeries.findFirst({
      where: { organizationId: ctx.orgId, code: "EXP" },
    });
    if (!series) throw new ExpenseError(500, "EXP_SERIES_NOT_FOUND");
    const expenseNumber = await mintDocumentNumberTx(tx, ctx.orgId, series, new Date());
    const expenseDate = new Date(`${input.expenseDate}T00:00:00.000Z`);
    const created = await tx.supplierExpense.create({
      data: {
        organizationId: ctx.orgId,
        expenseNumber,
        supplierName: input.supplierName,
        supplierRef: input.supplierRef ?? null,
        expenseDate,
        totalAmount: input.totalAmount,
        propertyId: input.propertyId ?? null,
        apartmentId: input.apartmentId ?? null,
        unitId: input.unitId ?? null,
        description: input.description ?? null,
        paymentSource: input.paymentSource ?? "company_bank",
        claimantName: input.claimantName ?? null,
        costPurpose: input.costPurpose ?? "unit_specific",
        approvalStatus: input.paymentSource === "employee_advance" ? "submitted" : "approved",
        reimbursementStatus: input.paymentSource === "employee_advance" ? "awaiting_approval" : "not_applicable",
        notes: input.notes ?? null,
        createdById: ctx.actorUserId,
        allocations: {
          create: input.allocations.map((a) => ({
            organizationId: ctx.orgId,
            borneBy: a.borneBy,
            amount: a.amount,
            partyId: a.partyId ?? null,
            tenancyId: a.tenancyId ?? null,
            chargeCategoryId: a.chargeCategoryId ?? null,
            description: a.description ?? null,
          })),
        },
        ...(input.costPurpose === "unit_specific" && input.apartmentId ? {
          costAssignments: { create: [{ organizationId: ctx.orgId, apartmentId: input.apartmentId, amount: input.totalAmount, description: input.description ?? null, assignedById: ctx.actorUserId }] },
        } : {}),
      },
      select: {
        id: true,
        expenseNumber: true,
        allocations: {
          select: { id: true, borneBy: true, amount: true, chargeCategoryId: true, description: true },
        },
      },
    });

    if (isPhase2FlagEnabled("ENABLE_KAEN_OPEX") && input.paymentSource !== "employee_advance") {
      await routeKaenOperatingExpensesTx(tx, ctx, created.allocations, expenseDate);
    }

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "expenses.create",
      entityType: "SupplierExpense",
      entityId: created.id,
      meta: {
        expenseNumber: created.expenseNumber,
        total: input.totalAmount,
        allocations: input.allocations.length,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // Reconstruct the public shape — `select` above also pulls back `allocations` for
    // the KAEN-opex routing above; callers/tests must see only {id, expenseNumber}.
    return { id: created.id, expenseNumber: created.expenseNumber };
  });
}

export async function listSupplierExpensesService(
  ctx: ExpenseActorCtx,
  options?: { ownOnly?: boolean },
) {
  const db = getDb();
  const rows = await db.supplierExpense.findMany({
    where: {
      organizationId: ctx.orgId,
      status: "recorded",
      ...(options?.ownOnly ? { createdById: ctx.actorUserId } : {}),
    },
    include: {
      allocations: true,
      costAssignments: true,
      bankCostAllocations: { select: { amount: true } },
    },
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
    take: 1000,
  });
  return rows.map((row) => {
    const assigned = row.costAssignments.reduce((sum, item) => sum + Number(item.amount), 0);
    const reimbursed = row.bankCostAllocations.reduce((sum, item) => sum + Number(item.amount), 0);
    return {
      ...row,
      totalAmount: row.totalAmount.toFixed(2),
      allocatedCost: assigned.toFixed(2),
      unallocatedCost: Math.max(0, Number(row.totalAmount) - assigned).toFixed(2),
      reimbursedAmount: reimbursed.toFixed(2),
      allocations: row.allocations.map((item) => ({ ...item, amount: item.amount.toFixed(2) })),
      costAssignments: row.costAssignments.map((item) => ({ ...item, amount: item.amount.toFixed(2) })),
    };
  });
}

export async function approveEmployeeClaimService(ctx: ExpenseActorCtx, id: string) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const current = await tx.supplierExpense.findFirst({ where: { id, organizationId: ctx.orgId, paymentSource: "employee_advance", status: "recorded" }, include: { allocations: { select: { id: true, borneBy: true, amount: true, chargeCategoryId: true, description: true } } } });
    if (!current) throw new ExpenseError(404, "CLAIM_NOT_FOUND");
    if (current.approvalStatus !== "submitted") throw new ExpenseError(409, "CLAIM_NOT_SUBMITTED");
    await routeKaenOperatingExpensesTx(tx, ctx, current.allocations, current.expenseDate);
    const row = await tx.supplierExpense.update({ where: { id }, data: { approvalStatus: "approved", reimbursementStatus: "awaiting_reimbursement", approvedById: ctx.actorUserId, approvedAt: new Date() } });
    await recordAudit(tx, { organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole, action: "employee_claim.approve", entityType: "SupplierExpense", entityId: id, meta: { amount: current.totalAmount.toFixed(2), claimantName: current.claimantName }, ip: ctx.ip, userAgent: ctx.userAgent });
    return { ...row, totalAmount: row.totalAmount.toFixed(2) };
  });
}

export async function assignSharedCostService(ctx: ExpenseActorCtx, id: string, input: { apartmentId: string; gridExpenseId?: string | null; amount: string; description?: string | null }) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const expense = await tx.supplierExpense.findFirst({ where: { id, organizationId: ctx.orgId, status: "recorded" }, include: { costAssignments: { select: { amount: true } } } });
    if (!expense) throw new ExpenseError(404, "EXPENSE_NOT_FOUND");
    // Unit-specific employee claims may be linked straight to the exact open grid
    // cost during creation; shared-material claims can be allocated gradually.
    if (!['shared_materials', 'unit_specific'].includes(expense.costPurpose)) throw new ExpenseError(409, "COST_NOT_ASSIGNABLE_TO_UNIT");
    const apartment = await tx.apartment.findFirst({ where: { id: input.apartmentId, organizationId: ctx.orgId } });
    if (!apartment) throw new ExpenseError(404, "APARTMENT_NOT_FOUND");
    if (input.gridExpenseId) {
      const line = await tx.gridExpense.findFirst({ where: { id: input.gridExpenseId, organizationId: ctx.orgId, apartmentId: input.apartmentId, status: "active" } });
      if (!line) throw new ExpenseError(409, "GRID_EXPENSE_MISMATCH");
    }
    const assigned = expense.costAssignments.reduce((sum, item) => sum + Number(item.amount), 0);
    if (assigned + Number(input.amount) - Number(expense.totalAmount) > 0.009) throw new ExpenseError(409, "ASSIGNMENT_EXCEEDS_UNALLOCATED_COST");
    const row = await tx.supplierExpenseCostAssignment.create({ data: { organizationId: ctx.orgId, supplierExpenseId: id, apartmentId: input.apartmentId, gridExpenseId: input.gridExpenseId ?? null, amount: input.amount, description: input.description ?? null, assignedById: ctx.actorUserId } });
    if (input.gridExpenseId) {
      const currentLine = await tx.gridExpense.findUniqueOrThrow({ where: { id: input.gridExpenseId }, select: { actualCost: true } });
      await tx.gridExpense.update({ where: { id: input.gridExpenseId }, data: { actualCost: Number(currentLine.actualCost ?? 0) + Number(input.amount), costPaymentStatus: "paid", costVendor: expense.supplierName, costPaymentDate: expense.expenseDate, costPaymentAccount: expense.paymentSource === "employee_advance" ? `Employee advance · ${expense.claimantName ?? "Employee"}` : "Shared materials pool" } });
    }
    await recordAudit(tx, { organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole, action: "shared_cost.assign", entityType: "SupplierExpense", entityId: id, meta: { apartmentId: input.apartmentId, amount: input.amount, gridExpenseId: input.gridExpenseId ?? null }, ip: ctx.ip, userAgent: ctx.userAgent });
    return { ...row, amount: row.amount.toFixed(2) };
  });
}
