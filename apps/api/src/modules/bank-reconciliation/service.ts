import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { recordAndAllocatePaymentService } from "../payments/payments.service";

const db = getDb();

export type ReconActor = { orgId: string; userId: string; role: string };

function money(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

function fingerprint(input: { transactionDate: string; description: string; reference?: string; debit?: number; credit?: number }) {
  return createHash("sha256").update([
    input.transactionDate.slice(0, 10),
    input.description.trim().replace(/\s+/g, " ").toLowerCase(),
    (input.reference ?? "").trim().toLowerCase(),
    Number(input.debit ?? 0).toFixed(2),
    Number(input.credit ?? 0).toFixed(2),
  ].join("|")).digest("hex");
}

export async function listAccounts(actor: ReconActor) {
  return db.bankReconciliationAccount.findMany({ where: { organizationId: actor.orgId, active: true }, orderBy: [{ bankName: "asc" }, { nickname: "asc" }] });
}

export async function createAccount(actor: ReconActor, input: { bankName: string; nickname: string; maskedAccountNumber?: string }) {
  return db.$transaction(async (tx) => {
    const row = await tx.bankReconciliationAccount.create({ data: { organizationId: actor.orgId, bankName: input.bankName, nickname: input.nickname, maskedAccountNumber: input.maskedAccountNumber || null, createdById: actor.userId } });
    await recordAudit(tx, { organizationId: actor.orgId, actorUserId: actor.userId, actorRole: actor.role, action: "bank_reconciliation.account.create", entityType: "BankReconciliationAccount", entityId: row.id, meta: { bankName: row.bankName, nickname: row.nickname } });
    return row;
  });
}

export async function importTransactions(actor: ReconActor, input: { accountId: string; source: "manual" | "paste" | "csv"; transactions: Array<{ transactionDate: string; description: string; reference?: string; debit?: number; credit?: number; balance?: number }> }) {
  const account = await db.bankReconciliationAccount.findFirst({ where: { id: input.accountId, organizationId: actor.orgId, active: true } });
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");
  const verification = await previewImport(actor, { accountId: input.accountId, transactions: input.transactions });
  if (!verification.canImport) throw new Error("IMPORT_VERIFICATION_FAILED");
  const batch = randomUUID();
  const data = input.transactions.map((line) => ({
    organizationId: actor.orgId,
    accountId: input.accountId,
    transactionDate: new Date(`${line.transactionDate.slice(0, 10)}T00:00:00.000Z`),
    description: line.description.trim(),
    reference: line.reference?.trim() || null,
    debit: line.debit ?? 0,
    credit: line.credit ?? 0,
    balance: line.balance ?? null,
    source: input.source,
    importBatchKey: batch,
    fingerprint: fingerprint(line),
  }));
  const result = await db.bankReconciliationTransaction.createMany({ data, skipDuplicates: true });
  return { imported: result.count, duplicates: data.length - result.count, batch };
}

export async function previewImport(actor: ReconActor, input: { accountId: string; transactions: Array<{ transactionDate: string; description: string; reference?: string; debit?: number; credit?: number; balance?: number }> }) {
  const account = await db.bankReconciliationAccount.findFirst({ where: { id: input.accountId, organizationId: actor.orgId, active: true } });
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");
  const fingerprints = input.transactions.map(fingerprint);
  const existing = await db.bankReconciliationTransaction.findMany({ where: { organizationId: actor.orgId, accountId: input.accountId, fingerprint: { in: fingerprints } }, select: { fingerprint: true } });
  const duplicateSet = new Set(existing.map((row) => row.fingerprint));
  // Detect both transactions that already exist in the database and repeated
  // rows inside the current paste/CSV batch.  Without the second check the
  // preview could claim every pasted row was new while createMany silently
  // skipped an in-batch duplicate at import time.
  const seenFingerprints = new Set(duplicateSet);
  const rows = input.transactions.map((line, index) => {
    const rowFingerprint = fingerprints[index];
    const duplicate = seenFingerprints.has(rowFingerprint);
    seenFingerprints.add(rowFingerprint);
    return {
      index,
      fingerprint: rowFingerprint,
      duplicate,
      hasBalance: line.balance != null && Number.isFinite(Number(line.balance)),
      balanceBreak: false,
    };
  });
  const comparablePairs: Array<{ index: number; ascending: boolean; descending: boolean }> = [];
  for (let index = 1; index < input.transactions.length; index += 1) {
    const previous = input.transactions[index - 1]; const current = input.transactions[index];
    if (previous.balance == null || current.balance == null) continue;
    const ascendingExpected = Number(previous.balance) + Number(current.credit ?? 0) - Number(current.debit ?? 0);
    const descendingExpected = Number(current.balance) + Number(previous.credit ?? 0) - Number(previous.debit ?? 0);
    comparablePairs.push({ index, ascending: Math.abs(Number(current.balance) - ascendingExpected) < 0.011, descending: Math.abs(Number(previous.balance) - descendingExpected) < 0.011 });
  }
  const ascendingMatches = comparablePairs.filter((pair) => pair.ascending).length;
  const descendingMatches = comparablePairs.filter((pair) => pair.descending).length;
  const direction = descendingMatches > ascendingMatches ? "newest_first" : "oldest_first";
  for (const pair of comparablePairs) {
    if (!(direction === "newest_first" ? pair.descending : pair.ascending)) rows[pair.index].balanceBreak = true;
  }
  const missingBalance = rows.filter((row) => !row.hasBalance).length;
  const balanceBreaks = rows.filter((row) => row.balanceBreak).length;
  const duplicates = rows.filter((row) => row.duplicate).length;
  return { rows, total: rows.length, newCount: rows.length - duplicates, duplicates, missingBalance, balanceBreaks, direction, canImport: rows.length > 0 && missingBalance === 0 && balanceBreaks === 0 };
}

export async function listTransactions(actor: ReconActor, input: { status?: string; q?: string; accountId?: string }) {
  const rows = await db.bankReconciliationTransaction.findMany({
    where: {
      organizationId: actor.orgId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.status && input.status !== "all" ? { status: input.status } : {}),
      ...(input.q ? { OR: [{ description: { contains: input.q, mode: "insensitive" } }, { reference: { contains: input.q, mode: "insensitive" } }] } : {}),
    },
    include: { account: { select: { bankName: true, nickname: true, maskedAccountNumber: true } }, costAllocations: { select: { id: true, amount: true, gridExpense: { select: { apartmentId: true, periodMonth: true, bearer: true, description: true } }, supplierExpense: { select: { expenseNumber: true, claimantName: true, description: true } } } } },
    orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  const apartmentIds = [...new Set(rows.flatMap((row) => [row.apartmentId, ...row.costAllocations.map((allocation) => allocation.gridExpense?.apartmentId)].filter((value): value is string => !!value)))];
  const apartments = await db.apartment.findMany({ where: { organizationId: actor.orgId, id: { in: apartmentIds } }, select: { id: true, unitCode: true, property: { select: { name: true } } } });
  const apartmentMap = new Map(apartments.map((row) => [row.id, `${row.property.name} ${row.unitCode}`]));
  const paymentIds = rows.map((row) => row.linkedPaymentId).filter((id): id is string => Boolean(id));
  const payments = paymentIds.length ? await db.payment.findMany({
    where: { organizationId: actor.orgId, id: { in: paymentIds } },
    select: {
      id: true,
      paymentNumber: true,
      party: { select: { displayName: true } },
      allocations: {
        select: {
          id: true,
          allocatedAmount: true,
          charge: {
            select: {
              chargeNumber: true,
              chargeType: true,
              description: true,
              billingMonth: true,
              category: { select: { name: true } },
              unit: { select: { apartmentId: true, apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
            },
          },
        },
        orderBy: { allocatedAt: "asc" },
      },
    },
  }) : [];
  const paymentMap = new Map(payments.map((payment) => [payment.id, payment]));
  return rows.map((row) => {
    const linkedPayment = row.linkedPaymentId ? paymentMap.get(row.linkedPaymentId) : undefined;
    return { ...row, debit: money(row.debit), credit: money(row.credit), balance: row.balance == null ? null : money(row.balance), unitLabel: row.apartmentId ? apartmentMap.get(row.apartmentId) ?? null : null, costAllocations: row.costAllocations.map((allocation) => ({ id: allocation.id, amount: money(allocation.amount), targetType: allocation.gridExpense ? "grid_expense" : "employee_claim", unitLabel: allocation.gridExpense ? apartmentMap.get(allocation.gridExpense.apartmentId) ?? null : null, periodMonth: allocation.gridExpense?.periodMonth.toISOString().slice(0, 7) ?? null, bearer: allocation.gridExpense?.bearer ?? null, description: allocation.gridExpense?.description ?? allocation.supplierExpense?.description ?? null, reference: allocation.supplierExpense ? `${allocation.supplierExpense.expenseNumber} · ${allocation.supplierExpense.claimantName ?? "Employee"}` : null })), collectionAllocations: linkedPayment?.allocations.map((allocation) => ({ id: allocation.id, amount: money(allocation.allocatedAmount), paymentNumber: linkedPayment.paymentNumber, partyName: linkedPayment.party.displayName, chargeNumber: allocation.charge.chargeNumber, chargeType: allocation.charge.chargeType, category: allocation.charge.category?.name ?? null, description: allocation.charge.description, periodMonth: allocation.charge.billingMonth?.toISOString().slice(0, 7) ?? null, unitLabel: allocation.charge.unit?.apartment ? `${allocation.charge.unit.apartment.property.name} ${allocation.charge.unit.apartment.unitCode}` : null })) ?? [] };
  });
}

export async function listMatchCandidates(actor: ReconActor) {
  const [apartments, expenses, employeeClaims, collectionCharges, bankTransfers] = await Promise.all([
    db.apartment.findMany({ where: { organizationId: actor.orgId, underManagement: true }, select: { id: true, unitCode: true, property: { select: { name: true } } }, orderBy: [{ property: { name: "asc" } }, { unitCode: "asc" }] }),
    db.gridExpense.findMany({ where: { organizationId: actor.orgId, status: "active" }, select: { id: true, apartmentId: true, periodMonth: true, bearer: true, description: true, amount: true, actualCost: true, costPaymentStatus: true, bankCostAllocations: { select: { amount: true } } }, orderBy: { updatedAt: "desc" }, take: 1000 }),
    db.supplierExpense.findMany({ where: { organizationId: actor.orgId, status: "recorded", paymentSource: "employee_advance", approvalStatus: "approved", reimbursementStatus: { not: "paid" } }, select: { id: true, expenseNumber: true, claimantName: true, description: true, totalAmount: true, reimbursementStatus: true, bankCostAllocations: { select: { amount: true } } }, orderBy: { expenseDate: "asc" }, take: 1000 }),
    db.charge.findMany({
      where: {
        organizationId: actor.orgId,
        status: { notIn: ["void", "credited", "cancelled"] },
        outstandingAmount: { gt: 0 },
        unit: { is: { apartment: { underManagement: true } } },
      },
      select: {
        id: true,
        chargeNumber: true,
        partyId: true,
        chargeType: true,
        description: true,
        dueDate: true,
        amount: true,
        outstandingAmount: true,
        party: { select: { displayName: true } },
        category: { select: { name: true } },
        unit: { select: { apartmentId: true, apartment: { select: { unitCode: true, property: { select: { name: true } } } } } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 5000,
    }),
    db.bankReconciliationTransaction.findMany({ where: { organizationId: actor.orgId, status: { in: ["unmatched", "review"] }, linkedPaymentId: null }, select: { id: true, accountId: true, transactionDate: true, description: true, debit: true, credit: true, status: true, account: { select: { bankName: true, nickname: true, maskedAccountNumber: true } } }, orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }], take: 1000 }),
  ]);
  return {
    apartments: apartments.map((row) => ({ id: row.id, label: `${row.property.name} ${row.unitCode}` })),
    expenses: expenses.map((row) => ({ ...row, amount: money(row.amount), actualCost: row.actualCost == null ? null : money(row.actualCost), paidCost: money(row.bankCostAllocations.reduce((sum, item) => sum + Number(item.amount), 0)), periodMonth: row.periodMonth.toISOString().slice(0, 7), bankCostAllocations: undefined })),
    employeeClaims: employeeClaims.map((row) => ({ ...row, totalAmount: money(row.totalAmount), reimbursedAmount: money(row.bankCostAllocations.reduce((sum, item) => sum + Number(item.amount), 0)), bankCostAllocations: undefined })),
    collectionCharges: collectionCharges.map((row) => ({
      id: row.id,
      chargeNumber: row.chargeNumber,
      apartmentId: row.unit?.apartmentId ?? null,
      partyId: row.partyId,
      partyName: row.party.displayName,
      unitLabel: row.unit?.apartment ? `${row.unit.apartment.property.name} ${row.unit.apartment.unitCode}` : null,
      chargeType: row.chargeType,
      categoryName: row.category?.name ?? null,
      description: row.description,
      dueDate: row.dueDate.toISOString().slice(0, 10),
      originalAmount: money(row.amount),
      outstandingAmount: money(row.outstandingAmount),
    })),
    bankTransfers: bankTransfers.map((row) => ({ id: row.id, accountId: row.accountId, transactionDate: row.transactionDate.toISOString().slice(0, 10), description: row.description, debit: money(row.debit), credit: money(row.credit), status: row.status, accountLabel: [row.account.bankName, row.account.nickname, row.account.maskedAccountNumber].filter(Boolean).join(" · ") })),
  };
}

export async function categorizeTransaction(actor: ReconActor, id: string, input: { apartmentId?: string | null; responsibility?: "tenant" | "owner" | "company" | "pending" | null; collectionCategory?: "rental" | "deposit" | "tenant_expense" | "owner_payment" | "management_fee" | "other" | "pending" | null; transactionCategory?: "non_operational_transfer" | "internal_bank_transfer" | null; counterpartTransactionId?: string; destinationAccount?: string | null; transferPurpose?: "payroll_funding" | "head_office_funding" | "reserve_transfer" | "tax_funding" | "other" | null; gridExpenseId?: string | null; matchNotes?: string; allocations?: Array<{ chargeId: string; allocatedAmount: string }>; costAllocations?: Array<{ targetType: "grid_expense" | "employee_claim"; targetId: string; allocatedAmount: string }>; unitCostItems?: Array<{ apartmentId: string; billingMonth: string; bearer: "owner" | "tenant"; costType: "tnb" | "water" | "wifi" | "cleaning" | "maintenance" | "recurring" | "repair" | "other"; description: string; amount: string; withSST: boolean }> }) {
  const updated = await db.$transaction(async (tx) => {
    const existing = await tx.bankReconciliationTransaction.findFirst({ where: { id, organizationId: actor.orgId } });
    if (!existing) throw new Error("TRANSACTION_NOT_FOUND");
    if (input.transactionCategory === "internal_bank_transfer") {
      if (existing.linkedPaymentId) throw new Error("INTERNAL_TRANSFER_HAS_POSTED_PAYMENT");
      if (!input.counterpartTransactionId || input.counterpartTransactionId === id) throw new Error("INTERNAL_TRANSFER_COUNTERPART_REQUIRED");
      const counterpart = await tx.bankReconciliationTransaction.findFirst({ where: { id: input.counterpartTransactionId, organizationId: actor.orgId }, include: { account: { select: { bankName: true, nickname: true, maskedAccountNumber: true } } } });
      if (!counterpart) throw new Error("INTERNAL_TRANSFER_COUNTERPART_NOT_FOUND");
      if (counterpart.linkedPaymentId) throw new Error("INTERNAL_TRANSFER_HAS_POSTED_PAYMENT");
      if (counterpart.accountId === existing.accountId) throw new Error("INTERNAL_TRANSFER_DIFFERENT_BANK_REQUIRED");
      const existingAmount = Number(existing.debit) > 0 ? Number(existing.debit) : Number(existing.credit);
      const counterpartAmount = Number(counterpart.debit) > 0 ? Number(counterpart.debit) : Number(counterpart.credit);
      const oppositeDirection = (Number(existing.debit) > 0 && Number(counterpart.credit) > 0) || (Number(existing.credit) > 0 && Number(counterpart.debit) > 0);
      if (!oppositeDirection || Math.abs(existingAmount - counterpartAmount) > 0.009) throw new Error("INTERNAL_TRANSFER_AMOUNT_OR_DIRECTION_MISMATCH");
      if (counterpart.status === "matched" && counterpart.transactionCategory !== "internal_bank_transfer") throw new Error("INTERNAL_TRANSFER_COUNTERPART_ALREADY_MATCHED");
      const pairId = existing.internalTransferPairId ?? counterpart.internalTransferPairId ?? randomUUID();
      const existingAccount = await tx.bankReconciliationAccount.findUnique({ where: { id: existing.accountId }, select: { bankName: true, nickname: true, maskedAccountNumber: true } });
      const existingLabel = existingAccount ? [existingAccount.bankName, existingAccount.nickname, existingAccount.maskedAccountNumber].filter(Boolean).join(" · ") : "Other company bank";
      const counterpartLabel = [counterpart.account.bankName, counterpart.account.nickname, counterpart.account.maskedAccountNumber].filter(Boolean).join(" · ");
      const common = { status: "matched", apartmentId: null, responsibility: null, collectionCategory: null, transactionCategory: "internal_bank_transfer", transferPurpose: null, gridExpenseId: null, chargeRequired: false, internalTransferPairId: pairId, matchNotes: input.matchNotes?.trim() || null, categorizedById: actor.userId, categorizedAt: new Date() } as const;
      await tx.bankCostAllocation.deleteMany({ where: { organizationId: actor.orgId, bankTransactionId: { in: [id, counterpart.id] } } });
      await tx.bankReconciliationTransaction.update({ where: { id }, data: { ...common, destinationAccount: counterpartLabel } });
      await tx.bankReconciliationTransaction.update({ where: { id: counterpart.id }, data: { ...common, destinationAccount: existingLabel } });
      await recordAudit(tx, { organizationId: actor.orgId, actorUserId: actor.userId, actorRole: actor.role, action: "bank_reconciliation.transaction.match_internal_transfer", entityType: "BankReconciliationTransaction", entityId: id, meta: { pairId, counterpartTransactionId: counterpart.id, amount: existingAmount } });
      return tx.bankReconciliationTransaction.findUniqueOrThrow({ where: { id } });
    }
    if (input.transactionCategory === "non_operational_transfer") {
      if (Number(existing.debit) <= 0 || Number(existing.credit) > 0) throw new Error("NON_OPERATIONAL_TRANSFER_MUST_BE_DEBIT");
      if (!input.destinationAccount?.trim() || !input.transferPurpose) throw new Error("NON_OPERATIONAL_TRANSFER_DETAILS_REQUIRED");
      if (input.apartmentId || input.gridExpenseId || input.allocations?.length || input.costAllocations?.length || input.unitCostItems?.length) throw new Error("INVALID_NON_OPERATIONAL_TRANSFER");
      await tx.bankCostAllocation.deleteMany({ where: { organizationId: actor.orgId, bankTransactionId: id } });
      const nonOperational = await tx.bankReconciliationTransaction.update({
        where: { id },
        data: {
          status: "matched", apartmentId: null, responsibility: null, collectionCategory: null,
          transactionCategory: "non_operational_transfer", destinationAccount: input.destinationAccount.trim(),
          transferPurpose: input.transferPurpose, gridExpenseId: null, chargeRequired: false,
          matchNotes: input.matchNotes?.trim() || null, categorizedById: actor.userId, categorizedAt: new Date(),
        },
      });
      await recordAudit(tx, { organizationId: actor.orgId, actorUserId: actor.userId, actorRole: actor.role, action: "bank_reconciliation.transaction.categorize_non_operational_transfer", entityType: "BankReconciliationTransaction", entityId: id, meta: { transactionCategory: input.transactionCategory, destinationAccount: input.destinationAccount.trim(), transferPurpose: input.transferPurpose } });
      return nonOperational;
    }
    let expense = null;
    if (input.gridExpenseId) {
      expense = await tx.gridExpense.findFirst({ where: { id: input.gridExpenseId, organizationId: actor.orgId, status: "active" } });
      if (!expense) throw new Error("EXPENSE_NOT_FOUND");
      if (input.apartmentId && expense.apartmentId !== input.apartmentId) throw new Error("EXPENSE_UNIT_MISMATCH");
    }
    const generatedCostAllocations: Array<{ targetType: "grid_expense"; targetId: string; allocatedAmount: string }> = [];
    if (input.unitCostItems?.length) {
      if (Number(existing.debit) <= 0 || Number(existing.credit) > 0) throw new Error("INVALID_COST_ALLOCATIONS");
      const itemTotal = input.unitCostItems.reduce((sum, item) => sum + Number(item.amount), 0);
      const existingTotal = (input.costAllocations ?? []).reduce((sum, item) => sum + Number(item.allocatedAmount), 0);
      if (Math.abs(itemTotal + existingTotal - Number(existing.debit)) > 0.009) throw new Error("COST_ALLOCATION_MUST_EQUAL_DEBIT");
      const account = await tx.bankReconciliationAccount.findUnique({ where: { id: existing.accountId }, select: { bankName: true } });
      for (const item of input.unitCostItems) {
        const apartment = await tx.apartment.findFirst({ where: { id: item.apartmentId, organizationId: actor.orgId, underManagement: true }, select: { id: true } });
        if (!apartment) throw new Error("UNIT_NOT_FOUND");
        const periodMonth = new Date(`${item.billingMonth}-01T00:00:00.000Z`);
        const nextMonth = new Date(Date.UTC(periodMonth.getUTCFullYear(), periodMonth.getUTCMonth() + 1, 1));
        let tenancy: { id: string; tenantPartyId: string } | null = null;
        if (item.bearer === "tenant") {
          tenancy = await tx.tenancy.findFirst({
            where: { organizationId: actor.orgId, unit: { apartmentId: item.apartmentId }, startDate: { lt: nextMonth }, OR: [{ endDate: null }, { endDate: { gte: periodMonth } }] },
            orderBy: [{ startDate: "desc" }, { id: "asc" }],
            select: { id: true, tenantPartyId: true },
          });
          if (!tenancy) throw new Error("TENANCY_NOT_FOUND");
        }
        const entry = await tx.unitBillsGridEntry.upsert({
          where: { organizationId_apartmentId_periodMonth: { organizationId: actor.orgId, apartmentId: item.apartmentId, periodMonth } },
          update: {},
          create: { organizationId: actor.orgId, apartmentId: item.apartmentId, periodMonth, createdBy: actor.userId },
          select: { id: true },
        });
        const label = item.costType === "tnb" ? "TNB" : item.costType === "wifi" ? "WiFi" : item.costType === "maintenance" ? "Maintenance Fee" : item.costType[0].toUpperCase() + item.costType.slice(1);
        const row = await tx.gridExpense.create({
          data: {
            organizationId: actor.orgId, entryId: entry.id, apartmentId: item.apartmentId, periodMonth,
            bearer: item.bearer, nature: "expense", description: `${label} · ${item.description.trim()}`,
            amount: item.amount, withSST: item.withSST, actualCost: item.amount,
            costVendor: existing.description, costPaymentStatus: "paid", costPaymentDate: existing.transactionDate,
            costPaymentAccount: account?.bankName ?? "Bank", costNotes: input.matchNotes?.trim() || `Created from bank transaction ${existing.reference ?? existing.id}`,
            partyId: tenancy?.tenantPartyId ?? null, tenancyId: tenancy?.id ?? null, createdBy: actor.userId,
          },
        });
        generatedCostAllocations.push({ targetType: "grid_expense", targetId: row.id, allocatedAmount: Number(item.amount).toFixed(2) });
      }
    }
    const allCostAllocations = [...(input.costAllocations ?? []), ...generatedCostAllocations];
    const apartmentId = allCostAllocations.length ? null : input.apartmentId ?? expense?.apartmentId ?? null;
    const isCollection = Number(existing.credit) > 0 && Number(existing.debit) === 0;
    const responsibility = isCollection ? null : input.responsibility ?? "pending";
    const collectionCategory = isCollection ? input.collectionCategory ?? "pending" : null;
    const chargeRequired = !isCollection && responsibility === "tenant" && !expense;
    const wantsPayment = isCollection && (input.allocations?.length ?? 0) > 0;
    const wantsCostAllocation = !isCollection && allCostAllocations.length > 0;
    const status = isCollection ? (collectionCategory === "pending" || wantsPayment ? "review" : "matched") : wantsCostAllocation ? "matched" : (responsibility === "pending" || chargeRequired ? "review" : "matched");
    const updated = await tx.bankReconciliationTransaction.update({ where: { id }, data: { apartmentId, responsibility, collectionCategory, transactionCategory: null, destinationAccount: null, transferPurpose: null, internalTransferPairId: null, gridExpenseId: isCollection ? null : expense?.id ?? null, chargeRequired, status, matchNotes: input.matchNotes?.trim() || null, categorizedById: actor.userId, categorizedAt: new Date() } });
    if (allCostAllocations.length && Number(existing.debit) > 0) {
      const uniqueTargets = new Set(allCostAllocations.map((item) => `${item.targetType}:${item.targetId}`));
      if (uniqueTargets.size !== allCostAllocations.length) throw new Error("INVALID_COST_ALLOCATIONS");
      const allocationTotal = allCostAllocations.reduce((sum, item) => sum + Number(item.allocatedAmount), 0);
      if (Math.abs(allocationTotal - Number(existing.debit)) > 0.009) throw new Error("COST_ALLOCATION_MUST_EQUAL_DEBIT");
      const gridIds = allCostAllocations.filter((item) => item.targetType === "grid_expense").map((item) => item.targetId);
      const claimIds = allCostAllocations.filter((item) => item.targetType === "employee_claim").map((item) => item.targetId);
      const [gridTargets, claimTargets] = await Promise.all([
        tx.gridExpense.findMany({ where: { organizationId: actor.orgId, id: { in: gridIds }, status: "active" }, select: { id: true, actualCost: true } }),
        tx.supplierExpense.findMany({ where: { organizationId: actor.orgId, id: { in: claimIds }, status: "recorded", paymentSource: "employee_advance" }, select: { id: true, totalAmount: true, approvalStatus: true } }),
      ]);
      if (gridTargets.length !== gridIds.length || claimTargets.length !== claimIds.length) throw new Error("COST_TARGET_NOT_FOUND");
      if (claimTargets.some((item) => item.approvalStatus !== "approved")) throw new Error("CLAIM_NOT_APPROVED");
      const priorOnTransaction = await tx.bankCostAllocation.count({ where: { organizationId: actor.orgId, bankTransactionId: existing.id } });
      if (priorOnTransaction) throw new Error("INVALID_COST_ALLOCATIONS");
      for (const allocation of allCostAllocations) {
        const alreadyPaid = await tx.bankCostAllocation.aggregate({ where: { organizationId: actor.orgId, ...(allocation.targetType === "grid_expense" ? { gridExpenseId: allocation.targetId } : { supplierExpenseId: allocation.targetId }) }, _sum: { amount: true } });
        const targetTotal = allocation.targetType === "grid_expense" ? gridTargets.find((item) => item.id === allocation.targetId)?.actualCost : claimTargets.find((item) => item.id === allocation.targetId)?.totalAmount;
        if (targetTotal != null && Number(alreadyPaid._sum.amount ?? 0) + Number(allocation.allocatedAmount) - Number(targetTotal) > 0.009) throw new Error("INVALID_COST_ALLOCATIONS");
      }
      await tx.bankCostAllocation.createMany({ data: allCostAllocations.map((item) => ({ organizationId: actor.orgId, bankTransactionId: existing.id, ...(item.targetType === "grid_expense" ? { gridExpenseId: item.targetId } : { supplierExpenseId: item.targetId }), amount: item.allocatedAmount, createdById: actor.userId })) });
      for (const target of gridTargets) {
        const paid = await tx.bankCostAllocation.aggregate({ where: { organizationId: actor.orgId, gridExpenseId: target.id }, _sum: { amount: true } });
        const paidAmount = Number(paid._sum.amount ?? 0);
        const actualCost = target.actualCost == null ? paidAmount : Number(target.actualCost);
        await tx.gridExpense.update({ where: { id: target.id }, data: { actualCost, costPaymentStatus: paidAmount + 0.009 >= actualCost ? "paid" : "partial", costPaymentDate: existing.transactionDate, costVendor: existing.description, costPaymentAccount: (await tx.bankReconciliationAccount.findUnique({ where: { id: existing.accountId } }))?.bankName ?? "Bank" } });
      }
      for (const target of claimTargets) {
        const paid = await tx.bankCostAllocation.aggregate({ where: { organizationId: actor.orgId, supplierExpenseId: target.id }, _sum: { amount: true } });
        const paidAmount = Number(paid._sum.amount ?? 0);
        await tx.supplierExpense.update({ where: { id: target.id }, data: { reimbursementStatus: paidAmount + 0.009 >= Number(target.totalAmount) ? "paid" : "partial" } });
      }
    } else if (expense && Number(existing.debit) > 0) {
      const linked = await tx.bankReconciliationTransaction.aggregate({ where: { organizationId: actor.orgId, gridExpenseId: expense.id, status: "matched" }, _sum: { debit: true } });
      await tx.gridExpense.update({ where: { id: expense.id }, data: { actualCost: linked._sum.debit ?? 0, costVendor: existing.description, costPaymentStatus: "paid", costPaymentDate: existing.transactionDate, costPaymentAccount: `${(await tx.bankReconciliationAccount.findUnique({ where: { id: existing.accountId } }))?.bankName ?? "Bank"}`, costNotes: input.matchNotes?.trim() || `Matched from bank transaction ${existing.reference ?? existing.id}` } });
    }
    await recordAudit(tx, { organizationId: actor.orgId, actorUserId: actor.userId, actorRole: actor.role, action: "bank_reconciliation.transaction.categorize", entityType: "BankReconciliationTransaction", entityId: id, meta: { apartmentId, responsibility, collectionCategory, gridExpenseId: isCollection ? null : expense?.id ?? null, costAllocations: allCostAllocations, generatedUnitCostItems: input.unitCostItems ?? [], chargeRequired, status } });
    return { ...updated, debit: money(updated.debit), credit: money(updated.credit) };
  });

  if (Number(updated.credit) > 0 && input.allocations?.length) {
    const charges = await db.charge.findMany({
      where: { organizationId: actor.orgId, id: { in: input.allocations.map((a) => a.chargeId) } },
      select: { id: true, partyId: true, unit: { select: { apartmentId: true } } },
    });
    const partyIds = new Set(charges.map((row) => row.partyId));
    if (charges.length !== input.allocations.length || partyIds.size !== 1) throw new Error("INVALID_COLLECTION_ALLOCATIONS");
    if (updated.apartmentId && charges.some((row) => row.unit?.apartmentId !== updated.apartmentId)) throw new Error("COLLECTION_UNIT_MISMATCH");
    const allocationTotal = input.allocations.reduce((sum, row) => sum + Number(row.allocatedAmount), 0);
    if (Math.abs(allocationTotal - Number(updated.credit)) > 0.009) throw new Error("COLLECTION_ALLOCATION_MUST_EQUAL_CREDIT");
    const paymentResult = await recordAndAllocatePaymentService(
      { orgId: actor.orgId, userId: actor.userId, role: actor.role as "admin" },
      {
        paymentNumber: `BANK-${updated.id.slice(0, 8).toUpperCase()}`,
        partyId: [...partyIds][0]!,
        paymentType: updated.collectionCategory === "deposit" ? "deposit" : updated.collectionCategory === "rental" ? "rental_payment" : "utility_payment",
        paymentMethod: "bank_transfer",
        currency: "MYR",
        receivedAt: updated.transactionDate.toISOString(),
        referenceNote: input.matchNotes?.trim() || `Bank reconciliation: ${updated.description}`,
        externalReference: updated.reference ?? updated.fingerprint,
        idempotencyKey: updated.id,
        allocations: input.allocations,
      },
    );
    if (!paymentResult.ok) throw new Error(`PAYMENT_RECORD_FAILED:${paymentResult.error}`);
    const linked = await db.bankReconciliationTransaction.update({
      where: { id: updated.id },
      data: { linkedPaymentId: paymentResult.data.id, status: "matched" },
    });
    return { ...linked, debit: money(linked.debit), credit: money(linked.credit) };
  }
  return updated;
}

export async function reconciliationSummary(actor: ReconActor) {
  const [unmatched, review, chargeRequired, nonOperationalTransfers] = await Promise.all([
    db.bankReconciliationTransaction.aggregate({ where: { organizationId: actor.orgId, status: "unmatched" }, _count: true, _sum: { debit: true, credit: true } }),
    db.bankReconciliationTransaction.aggregate({ where: { organizationId: actor.orgId, status: "review" }, _count: true, _sum: { debit: true, credit: true } }),
    db.bankReconciliationTransaction.aggregate({ where: { organizationId: actor.orgId, chargeRequired: true }, _count: true, _sum: { debit: true, credit: true } }),
    db.bankReconciliationTransaction.aggregate({ where: { organizationId: actor.orgId, transactionCategory: "non_operational_transfer" }, _count: true, _sum: { debit: true, credit: true } }),
  ]);
  const movementTotal = (summary: { _sum: { debit: unknown; credit: unknown } }) => money(Number(summary._sum.debit ?? 0) + Number(summary._sum.credit ?? 0));
  return {
    unmatched: { count: unmatched._count, amount: movementTotal(unmatched) },
    review: { count: review._count, amount: movementTotal(review) },
    chargeRequired: { count: chargeRequired._count, amount: movementTotal(chargeRequired) },
    nonOperationalTransfers: { count: nonOperationalTransfers._count, amount: movementTotal(nonOperationalTransfers) },
  };
}
