import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTenancyService, renewTenancyService, updateTenancyService } from "../tenancy.service";
import * as repo from "../tenancy.repository";
import * as carparkAssignmentSvc from "../../carpark/carpark-assignment.service";

vi.mock("../tenancy.repository", () => ({
  listLandlordTenancies: vi.fn(),
  findProperty: vi.fn(),
  findOwnerRole: vi.fn(),
  createLandlordTenancy: vi.fn(),
  findLandlordTenancy: vi.fn(),
  updateLandlordTenancy: vi.fn(),
  listTenancies: vi.fn(),
  findUnit: vi.fn(),
  findTenantRole: vi.fn(),
  findTenancyByCode: vi.fn(),
  findTenancy: vi.fn(),
  updateTenancy: vi.fn(),
  renewTenancyTx: vi.fn(),
  findReservationRent: vi.fn(),
}));

// Mock @kason/db so getDb().$transaction can be controlled. EVERY create path
// now opens a transaction (tenancy row + Unit-occupancy flip must be atomic), so
// each create test supplies a mockTx with `tenancy.create` + `listing.updateMany`.
//
// findFirst: T9's active-tenancy guard (assertNoActiveTenancyTx) now reads
// via getDb() before every create. Defaults to undefined (falsy, "no active
// tenancy") so every pre-existing test below is unaffected -- only the T9
// overwrite integration suite seeds a real incumbent.
const mockTenancyDb = {
  tenancy: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockTenancyDb),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

// Mock assignCarparksTx so tenancy service tests can control carpark outcomes
// without re-testing the full carpark assignment logic (which has its own suite).
vi.mock("../../carpark/carpark-assignment.service", () => ({
  assignCarparksTx: vi.fn(),
  releaseAssignmentsForTenancyTx: vi.fn(),
}));

vi.mock("../../billing/draft-catchup.hook", () => ({
  draftCatchupForTenancy: vi.fn().mockResolvedValue({ drafted: [] }),
}));
vi.mock("../../billing/tenancy-deposits", () => ({
  createTenancyDepositsForTenancy: vi.fn(),
}));
vi.mock("../../charge-categories/seed", () => ({
  ensureChargeCategorySeeds: vi.fn(),
}));

// The TEN-{year}-NNNN generator has its own suite (tenancy-code-generator.test.ts);
// here we only care THAT createTenancyService delegates to it, and that the code
// it returns reaches tenancy.create.
const generateTenancyCodeTx = vi.hoisted(() => vi.fn(async () => "TEN-2026-0007"));
vi.mock("../tenancy-code-generator", () => ({ generateTenancyCodeTx }));

const mockedRepo = vi.mocked(repo);
const mockedCarparkSvc = vi.mocked(carparkAssignmentSvc);
const session = { userId: "u1", orgId: "o1", role: "admin" };

describe("tenancy.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("releases carpark bays in one transaction when a tenancy is ended", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-end", propertyId: "p1", unitId: "u1", status: "active" } as never);
    const mockTx = { tenancy: { update: vi.fn() } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));

    const res = await updateTenancyService(session, { tenancyId: "ten-end", status: "ended", endDate: "2026-06-30" } as never);

    expect(res.ok).toBe(true);
    expect(mockTenancyDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.tenancy.update).toHaveBeenCalledTimes(1);
    expect(mockedCarparkSvc.releaseAssignmentsForTenancyTx).toHaveBeenCalledWith(
      mockTx, "o1", "ten-end", expect.any(Date),
    );
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
  });

  it("does NOT release or open a transaction for a non-terminal status update", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-x", propertyId: "p1", unitId: "u1", status: "active" } as never);

    const res = await updateTenancyService(session, { tenancyId: "ten-x", billingStatus: "overdue" } as never);

    expect(res.ok).toBe(true);
    expect(mockedRepo.updateTenancy).toHaveBeenCalledTimes(1);
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
    expect(mockedCarparkSvc.releaseAssignmentsForTenancyTx).not.toHaveBeenCalled();
  });

  it("generates the tenancy code inside the transaction when the caller omits one", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    const mockTx = { tenancy: { create: vi.fn(async () => ({ id: "ten-gen" })) }, listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
      startDate: "2026-01-01", monthlyRentAmount: "2000",
    } as never);

    expect(res.ok).toBe(true);
    // Generated against the SAME tx the insert runs in — a max-scan that
    // straddled a commit boundary could hand out a code another writer took.
    expect(generateTenancyCodeTx).toHaveBeenCalledWith(mockTx, "o1");
    expect(mockTx.tenancy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenancyCode: "TEN-2026-0007" }) }),
    );
  });

  it("skips the duplicate-code precheck when no code is supplied", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    const mockTx = { tenancy: { create: vi.fn(async () => ({ id: "ten-nodup" })) }, listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
      startDate: "2026-01-01", monthlyRentAmount: "2000",
    } as never);

    // findTenancyByCode(orgId, undefined) would compile to a Prisma findFirst
    // with NO tenancyCode filter, matching the org's first tenancy and 409-ing
    // "Tenancy code already exists" on a perfectly valid create. Never call it.
    expect(mockedRepo.findTenancyByCode).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("still honours an explicitly supplied tenancy code", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = { tenancy: { create: vi.fn(async () => ({ id: "ten-explicit" })) }, listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "TEN-MANUAL-9",
      startDate: "2026-01-01", monthlyRentAmount: "2000",
    } as never);

    expect(res.ok).toBe(true);
    expect(generateTenancyCodeTx).not.toHaveBeenCalled();
    expect(mockedRepo.findTenancyByCode).toHaveBeenCalledWith("o1", "TEN-MANUAL-9");
    expect(mockTx.tenancy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenancyCode: "TEN-MANUAL-9" }) }),
    );
  });

  it("keeps the SST-inclusive initial TA amount unchanged on direct tenancy creation", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    mockTenancyDb.tenancy.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "ten-ta",
        tenantPartyId: "t1",
        propertyId: "p1",
        unitId: "u1",
        startDate: new Date("2026-04-25T00:00:00.000Z"),
      });

    const createTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-ta" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const feeTx = {
      invoice: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "invoice-ta" }),
        update: vi.fn(),
      },
      chargeCategory: { findFirst: vi.fn().mockResolvedValue({ id: "cat-ta" }) },
      charge: {
        create: vi.fn().mockResolvedValue({ id: "ta-base" }),
        findMany: vi.fn().mockResolvedValue([{ amount: "462.96" }, { amount: "37.04" }]),
      },
    };
    mockTenancyDb.$transaction
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(createTx))
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(feeTx));

    const res = await createTenancyService(session, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-TA",
      startDate: "2026-04-25",
      monthlyRentAmount: "3000",
      tenancyAgreementFeeAmount: "500",
      tenancyAgreementFeeDueDate: "2026-04-25",
    } as never);

    expect(res.ok).toBe(true);
    expect(feeTx.charge.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chargeType: "tenancy_agreement_fee",
        description: "TA (WITH SST)",
        amount: "462.96",
        outstandingAmount: "462.96",
        sstRate: "8",
        billingMonth: new Date("2026-04-01T00:00:00.000Z"),
      }),
      select: { id: true },
    });
    expect(feeTx.charge.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chargeNumber: "TAF-ten-ta-SST",
        chargeType: "tenancy_agreement_fee",
        description: "TA (WITH SST) — SST 8%",
        amount: "37.04",
        outstandingAmount: "37.04",
        sstRate: "0",
        parentChargeId: "ta-base",
        billingMonth: new Date("2026-04-01T00:00:00.000Z"),
      }),
    });
  });

  it("blocks tenancy creation when the unit has no owner", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: null } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-1",
      startDate: "2026-01-01", monthlyRentAmount: "2000",
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.status).toBe(409); expect((res as { code?: string }).code).toBe("UNIT_HAS_NO_OWNER"); }
    // A rejected create writes nothing: no transaction opens, so the unit is
    // never flipped occupied (B6).
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid monthly rent on create tenancy", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);

    const res = await createTenancyService(session, {
      propertyId: "p1",
      unitId: "22222222-2222-2222-2222-222222222222",
      tenantPartyId: "33333333-3333-3333-3333-333333333333",
      tenancyCode: "TN-001",
      startDate: "2026-01-01",
      monthlyRentAmount: "0",
      billingStatus: "active",
      depositAmount: "",
      endDate: "",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("sources monthlyRentAmount from the reservation and marks the unit occupied (B9)", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    mockedRepo.findReservationRent.mockResolvedValueOnce({ agreedMonthlyRent: "2200" } as never);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-1" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));
    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-1",
      startDate: "2026-01-01", reservationId: "res-1",
    } as never);
    expect(res.ok).toBe(true);
    expect(mockTx.tenancy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ monthlyRentAmount: 2200, reservationId: "res-1" }) }),
    );
    // Reservation-sourced create still flips the unit occupied (B9).
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    expect(mockTx.listing.updateMany.mock.calls[0][0].data.occupancyStatus).toBe("occupied");
  });

  // ---------------------------------------------------------------------------
  // Wave-2 #1 + #3: the rent-invoice fields must be PERSISTED (not silently
  // dropped), and rentInvoiceStartDate must be stored as UTC midnight of the
  // calendar day, immune to the input's offset/format.
  // ---------------------------------------------------------------------------

  it("persists rentInvoiceStartDate (UTC calendar day) and firstMonthRentNote on create", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    // Setting an invoice schedule routes create through a $transaction so the
    // write + its money-adjacent audit row are atomic (Wave-2 review #2).
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-inv" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-INV",
      startDate: "2026-07-15", monthlyRentAmount: "3000",
      // Offset-bearing form: `new Date(value)` would be 2026-07-31T16:00Z (July),
      // so this assertion fails unless the calendar day is stored.
      rentInvoiceStartDate: "2026-08-01T00:00:00+08:00",
      firstMonthRentNote: "pro-rate",
    } as never);

    expect(res.ok).toBe(true);
    const arg = mockTx.tenancy.create.mock.calls[0][0].data as { rentInvoiceStartDate: Date | null; firstMonthRentNote: string | null };
    expect(arg.firstMonthRentNote).toBe("pro-rate");
    expect(arg.rentInvoiceStartDate).toBeInstanceOf(Date);
    expect(arg.rentInvoiceStartDate!.getTime()).toBe(Date.UTC(2026, 7, 1));
    // Plain-with-schedule create also flips the unit occupied in the same tx (B3).
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    expect(mockTx.listing.updateMany.mock.calls[0][0].data.occupancyStatus).toBe("occupied");
  });

  it("records an in-transaction audit when a create sets the rent-invoice schedule", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-aud" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-AUD",
      startDate: "2026-07-15", monthlyRentAmount: "3000",
      rentInvoiceStartDate: "2026-08-01", firstMonthRentNote: "pro-rate",
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.tenancy.create).toHaveBeenCalledTimes(1);
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = mockTx.auditLog.create.mock.calls[0][0].data as { action: string; entityType: string; entityId: string };
    expect(auditData.action).toBe("tenancy.invoice_schedule_set");
    expect(auditData.entityType).toBe("Tenancy");
    expect(auditData.entityId).toBe("ten-aud");
  });

  // Wave-2 review #1: the schema refiner only enforces invoice-start >= move-in
  // when startDate is ISO-leading; a non-ISO startDate ("July 1, 2026") makes the
  // refiner skip the cross-field check, so a pre-move-in invoice start could slip
  // through on the API. The service MUST re-check against the parsed move-in.
  it("rejects a create whose rentInvoiceStartDate precedes a non-ISO move-in date", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-BAD",
      startDate: "July 1, 2026", monthlyRentAmount: "3000",
      rentInvoiceStartDate: "1990-01-01",
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    // A rejected create writes nothing: no transaction opens (B6).
    expect(mockTenancyDb.$transaction).not.toHaveBeenCalled();
  });

  it("stores null rentInvoiceStartDate and note when omitted on create", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-plain" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-PLAIN",
      startDate: "2026-07-15", monthlyRentAmount: "3000",
    } as never);

    expect(mockTx.tenancy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ rentInvoiceStartDate: null, firstMonthRentNote: null }) }),
    );
  });

  // ---------------------------------------------------------------------------
  // Bug fix: creating an active Tenancy must also mark the Unit occupied, or the
  // Unit keeps reading occupancyStatus="vacant" with an active tenant on it (the
  // Assign-to-Unit dialog + tenancy-create forms hit exactly this). The unit sync
  // must land in the SAME transaction as the tenancy create.
  // ---------------------------------------------------------------------------

  it("marks the unit occupied (occupancyStatus/moveInDate/readyNow) on a plain create", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-occ" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-OCC",
      startDate: "2026-07-01", monthlyRentAmount: "1200",
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockTx.listing.updateMany.mock.calls[0][0] as {
      where: { id: string; organizationId: string };
      data: { occupancyStatus: string; moveInDate: Date; readyNow: boolean };
    };
    // Org-scoped write (B8): the WHERE carries organizationId so the helper can
    // never flip a foreign-org unit, even when reached by a future caller that
    // skips the upstream findUnit org-check.
    expect(arg.where.id).toBe("u1");
    expect(arg.where.organizationId).toBe("o1");
    expect(arg.data.occupancyStatus).toBe("occupied");
    expect(arg.data.readyNow).toBe(false);
    expect(arg.data.moveInDate).toBeInstanceOf(Date);
    expect(arg.data.moveInDate.getTime()).toBe(new Date("2026-07-01").getTime());
  });

  it("marks the unit occupied on a carpark-attached create (B2)", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-cp" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockTenancyDb.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
    mockedCarparkSvc.assignCarparksTx.mockResolvedValueOnce({ ok: true, status: 201, data: { assignmentIds: ["a1"] } } as never);

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-CP-OCC",
      startDate: "2026-07-01", monthlyRentAmount: "1200", carparks: [{ carparkId: "cp-1" }],
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockTx.listing.updateMany.mock.calls[0][0] as { where: { organizationId: string }; data: { occupancyStatus: string } };
    expect(arg.where.organizationId).toBe("o1");
    expect(arg.data.occupancyStatus).toBe("occupied");
  });

  it("flips the unit occupied immediately even for a future-dated move-in (no clamp-to-today) (B5)", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "ten-fut" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-FUT",
      startDate: "2027-12-31", monthlyRentAmount: "1200",
    } as never);

    expect(res.ok).toBe(true);
    const arg = mockTx.listing.updateMany.mock.calls[0][0] as { data: { occupancyStatus: string; moveInDate: Date } };
    expect(arg.data.occupancyStatus).toBe("occupied");
    expect(arg.data.moveInDate.getTime()).toBe(new Date("2027-12-31").getTime());
  });

  it("overwrite create marks the unit occupied with the NEW tenancy's move-in (not the superseded end) (B4)", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    // Outer pre-tx read sees an incumbent → routes into the overwrite branch.
    mockTenancyDb.tenancy.findFirst.mockResolvedValueOnce({ id: "inc-1", tenantPartyId: "old", startDate: new Date("2026-06-01") } as never);
    const mockTx = {
      tenancy: {
        // In-tx read also sees the incumbent → it gets closed, then the new tenancy is created.
        findFirst: vi.fn().mockResolvedValue({ id: "inc-1", tenantPartyId: "old", startDate: new Date("2026-06-01") }),
        update: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: "ten-ow" }),
      },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-OW",
      // Incoming move-in PRECEDES the incumbent's start, so supersededEndDate clamps
      // UP to 2026-06-01 — the unit's moveInDate must still be the NEW start.
      startDate: "2026-05-01", monthlyRentAmount: "1200", overwrite: true,
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockTx.listing.updateMany.mock.calls[0][0] as { data: { occupancyStatus: string; moveInDate: Date } };
    expect(arg.data.occupancyStatus).toBe("occupied");
    expect(arg.data.moveInDate.getTime()).toBe(new Date("2026-05-01").getTime());
  });

  it("overwrite create still marks the unit occupied when the incumbent vanished mid-tx (stale-read race) (B4b)", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    // Outer read sees an incumbent (→ overwrite branch)…
    mockTenancyDb.tenancy.findFirst.mockResolvedValueOnce({ id: "inc-1", tenantPartyId: "old", startDate: new Date("2026-06-01") } as never);
    const mockTx = {
      // …but the in-tx re-read finds it already gone. The create still runs, so the
      // unit flip MUST still fire (else the bug is resurrected on this path).
      tenancy: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(), create: vi.fn().mockResolvedValue({ id: "ten-ow2" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await createTenancyService(session, {
      propertyId: "p1", unitId: "u1", tenantPartyId: "t1", tenancyCode: "T-OW2",
      startDate: "2026-07-01", monthlyRentAmount: "1200", overwrite: true,
    } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.tenancy.update).not.toHaveBeenCalled(); // no incumbent to close
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
    expect(mockTx.listing.updateMany.mock.calls[0][0].data.occupancyStatus).toBe("occupied");
  });

  it("persists rentInvoiceStartDate as a UTC calendar-day Date on update", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-u", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active", startDate: new Date(Date.UTC(2026, 6, 15)) } as never);
    // Writing the invoice schedule routes update through a $transaction so the
    // write + its money-adjacent audit row are atomic (Wave-2 review #2).
    const mockTx = { tenancy: { update: vi.fn() }, auditLog: { create: vi.fn() } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await updateTenancyService(session, { tenancyId: "ten-u", rentInvoiceStartDate: "2026-08-01T00:00:00+08:00" } as never);

    expect(res.ok).toBe(true);
    const updateArg = mockTx.tenancy.update.mock.calls[0][0] as { data: { rentInvoiceStartDate: Date } };
    expect(updateArg.data.rentInvoiceStartDate).toBeInstanceOf(Date);
    expect(updateArg.data.rentInvoiceStartDate.getTime()).toBe(Date.UTC(2026, 7, 1));
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
  });

  it("clears rentInvoiceStartDate when null is sent on update", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-c", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active", startDate: new Date(Date.UTC(2026, 6, 15)) } as never);
    const mockTx = { tenancy: { update: vi.fn() }, auditLog: { create: vi.fn() } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    await updateTenancyService(session, { tenancyId: "ten-c", rentInvoiceStartDate: null } as never);

    const updateArg = mockTx.tenancy.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data).toMatchObject({ rentInvoiceStartDate: null });
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
  });

  // Wave-2 #2: the update payload carries no startDate, so the schema cannot
  // enforce invoice-start >= move-in. The service MUST re-check against the
  // stored Tenancy.startDate before writing, or a money-path bug (rent invoiced
  // for pre-move-in months) slips through.
  it("rejects an update whose rentInvoiceStartDate precedes the stored move-in", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-bad", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active", startDate: new Date(Date.UTC(2026, 7, 1)) } as never);

    const res = await updateTenancyService(session, { tenancyId: "ten-bad", rentInvoiceStartDate: "1990-01-01" } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(mockedRepo.updateTenancy).not.toHaveBeenCalled();
  });

  it("allows an update whose rentInvoiceStartDate equals the stored move-in day", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({ id: "ten-eq", propertyId: "p1", unitId: "u1", tenantPartyId: "t1", status: "active", startDate: new Date(Date.UTC(2026, 7, 1)) } as never);
    const mockTx = { tenancy: { update: vi.fn() }, auditLog: { create: vi.fn() } };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: any) => fn(mockTx));

    const res = await updateTenancyService(session, { tenancyId: "ten-eq", rentInvoiceStartDate: "2026-08-01" } as never);

    expect(res.ok).toBe(true);
    expect(mockTx.tenancy.update).toHaveBeenCalledTimes(1);
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("rejects renewal when new code duplicates", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "t1",
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "party1",
      status: "active",
    } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce({ id: "dup" } as never);

    const res = await renewTenancyService(session, {
      tenancyId: "11111111-1111-1111-1111-111111111111",
      newTenancyCode: "TN-NEW",
      newStartDate: "2026-02-01",
      newEndDate: "",
      monthlyRentAmount: "1000",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("keeps the SST-inclusive renewal TA amount unchanged in the renewed tenancy start month", async () => {
    mockedRepo.findTenancy.mockResolvedValueOnce({
      id: "ten-old",
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "tenant-1",
      status: "active",
    } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);
    mockedRepo.renewTenancyTx.mockResolvedValueOnce({ id: "ten-renewed" } as never);

    const mockTx = {
      invoice: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "invoice-renewal" }),
        update: vi.fn(),
      },
      chargeCategory: { findFirst: vi.fn().mockResolvedValue({ id: "cat-renewal" }) },
      charge: {
        create: vi.fn().mockResolvedValue({ id: "renewal-base" }),
        findMany: vi.fn().mockResolvedValue([{ amount: "324.07" }, { amount: "25.93" }]),
      },
    };
    mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));

    const res = await renewTenancyService(session, {
      tenancyId: "ten-old",
      newTenancyCode: "TEN-2027-0001",
      newStartDate: "2027-08-25",
      newEndDate: "2028-08-24",
      monthlyRentAmount: "3000",
      renewalFeeAmount: "350",
      renewalFeeDueDate: "2027-08-25",
    });

    expect(res.ok).toBe(true);
    expect(mockTx.charge.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chargeType: "renewal_fee",
        description: "Renewal TA (WITH SST)",
        amount: "324.07",
        outstandingAmount: "324.07",
        sstRate: "8",
        billingMonth: new Date("2027-08-01T00:00:00.000Z"),
      }),
      select: { id: true },
    });
    expect(mockTx.charge.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chargeNumber: "RENEW-ten-renewed-SST",
        chargeType: "renewal_fee",
        description: "Renewal TA (WITH SST) — SST 8%",
        amount: "25.93",
        outstandingAmount: "25.93",
        sstRate: "0",
        parentChargeId: "renewal-base",
        billingMonth: new Date("2027-08-01T00:00:00.000Z"),
      }),
    });
  });

  // ---------------------------------------------------------------------------
  // Atomic carpark attachment on create
  // ---------------------------------------------------------------------------

  it("creates a tenancy and attaches a carpark bay atomically when carparks is provided", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);

    // $transaction runs the callback with a tx that creates the tenancy row
    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "new-ten-1" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockTenancyDb.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

    // assignCarparksTx succeeds
    mockedCarparkSvc.assignCarparksTx.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { assignmentIds: ["assign-1"] },
    } as never);

    const res = await createTenancyService(session, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-CP-1",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
      carparks: [{ carparkId: "cp-1" }],
    } as never);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ id: "new-ten-1" });
    expect(mockedCarparkSvc.assignCarparksTx).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ orgId: "o1" }),
      "new-ten-1",
      "p1",
      [{ carparkId: "cp-1" }],
    );
  });

  it("rolls back (no tenancy row) and returns 422 when the carpark bay belongs to a different building", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);

    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "new-ten-1" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockTenancyDb.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

    // assignCarparksTx reports wrong building
    mockedCarparkSvc.assignCarparksTx.mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: "CARPARK_WRONG_BUILDING",
    } as never);

    const res = await createTenancyService(session, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-CP-2",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
      carparks: [{ carparkId: "cp-bad-building" }],
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.error).toBe("CARPARK_WRONG_BUILDING");
    }
    // Atomicity (B7): the unit-occupancy flip ran INSIDE the same transaction
    // (before the carpark throw), so a real DB rolls it back together with the
    // tenancy row — the unit is never left occupied without its tenancy.
    expect(mockTx.listing.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rolls back (no tenancy row) and returns 409 when the carpark bay is already rented", async () => {
    mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
    mockedRepo.findUnit.mockResolvedValueOnce({ id: "u1", propertyId: "p1", ownerPartyId: "owner-1" } as never);
    mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
    mockedRepo.findTenancyByCode.mockResolvedValueOnce(null);

    const mockTx = {
      tenancy: { create: vi.fn().mockResolvedValue({ id: "new-ten-1" }) },
      listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockTenancyDb.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

    // assignCarparksTx reports already rented
    mockedCarparkSvc.assignCarparksTx.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "CARPARK_ALREADY_RENTED",
    } as never);

    const res = await createTenancyService(session, {
      propertyId: "p1",
      unitId: "u1",
      tenantPartyId: "t1",
      tenancyCode: "T-CP-3",
      startDate: "2026-01-01",
      monthlyRentAmount: "2000",
      carparks: [{ carparkId: "cp-rented" }],
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toBe("CARPARK_ALREADY_RENTED");
    }
  });

  // ── depositAmount derivation ───────────────────────────────────────────────
  // The Assign-to-Unit dialog no longer carries a free-text deposit box (it was a
  // second, conflicting source of truth for a number the unit already defines).
  // The owner statement still reads Tenancy.depositAmount to show the deposit and
  // to back-compute depositMonths, so the server derives it from the unit's
  // recorded depositMonths x the tenancy rent -- the SAME basis
  // tenancy-deposits.ts bills the DEPRENT charge on.
  describe("depositAmount derivation from the unit", () => {
    function seedUnit(over: Record<string, unknown> = {}) {
      mockedRepo.findProperty.mockResolvedValueOnce({ id: "p1" } as never);
      mockedRepo.findUnit.mockResolvedValueOnce({
        id: "u1", propertyId: "p1", ownerPartyId: "owner-1",
        depositMonths: 2, rentalRate: 1800, ...over,
      } as never);
      mockedRepo.findTenantRole.mockResolvedValueOnce({ id: "r1" } as never);
      const mockTx = {
        tenancy: { create: vi.fn(async () => ({ id: "ten-dep" })) },
        listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      mockTenancyDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(mockTx));
      return mockTx;
    }

    it("derives depositAmount from depositMonths x the tenancy rent when none is supplied", async () => {
      const mockTx = seedUnit();

      const res = await createTenancyService(session, {
        propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
        startDate: "2026-01-01", monthlyRentAmount: "2200",
      } as never);

      expect(res.ok).toBe(true);
      // 2 x 2200 -- the tenancy rent, NOT the unit's 1800 asking rate.
      expect(mockTx.tenancy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ depositAmount: 4400 }) }),
      );
    });

    it("an explicitly supplied depositAmount still wins", async () => {
      const mockTx = seedUnit();

      const res = await createTenancyService(session, {
        propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
        startDate: "2026-01-01", monthlyRentAmount: "2200", depositAmount: "999",
      } as never);

      expect(res.ok).toBe(true);
      expect(mockTx.tenancy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ depositAmount: 999 }) }),
      );
    });

    it("leaves depositAmount null when the unit records no depositMonths", async () => {
      // Mirrors tenancy-deposits.ts: a null is NOT defaulted to 2. Inventing a
      // figure nobody keyed in would show the owner a deposit that was never
      // agreed, and would not match the DEPRENT charge (which is not raised).
      const mockTx = seedUnit({ depositMonths: null });

      const res = await createTenancyService(session, {
        propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
        startDate: "2026-01-01", monthlyRentAmount: "2200",
      } as never);

      expect(res.ok).toBe(true);
      expect(mockTx.tenancy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ depositAmount: null }) }),
      );
    });

    it("leaves depositAmount null when depositMonths is zero", async () => {
      const mockTx = seedUnit({ depositMonths: 0 });

      const res = await createTenancyService(session, {
        propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
        startDate: "2026-01-01", monthlyRentAmount: "2200",
      } as never);

      expect(res.ok).toBe(true);
      expect(mockTx.tenancy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ depositAmount: null }) }),
      );
    });

    it("round-trips through the owner statement's months back-computation", async () => {
      // owner-statement-sections.ts recovers months as
      // round(depositAmount / monthlyRentAmount). Deriving from the RENTAL leg
      // only keeps that exact: 4400 / 2200 -> 2. Folding the utilities leg in
      // would make it report 3.
      const mockTx = seedUnit({ depositMonths: 2, utilitiesDepositMonths: 0.5 });

      await createTenancyService(session, {
        propertyId: "p1", unitId: "u1", tenantPartyId: "t1",
        startDate: "2026-01-01", monthlyRentAmount: "2200",
      } as never);

      const [firstCall] = mockTx.tenancy.create.mock.calls as unknown as [
        [{ data: { depositAmount: number } }],
      ];
      const { depositAmount } = firstCall[0].data;
      expect(depositAmount).toBe(4400);
      expect(Math.round(depositAmount / 2200)).toBe(2);
    });
  });
});
