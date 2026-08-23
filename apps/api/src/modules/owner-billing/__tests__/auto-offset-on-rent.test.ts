/**
 * autoOffsetOwnerReceivablesForPaidRent — settling the owner's IVOWN lines out of
 * collected rent.
 *
 * The money properties pinned here:
 *   • settles NOTHING when the owner has no available payable (the letting-commission
 *     month) — you cannot write off a receivable against money KAEN does not hold
 *   • KAEN's own fees settle BEFORE third-party costs (the operator's chosen priority)
 *   • a shortfall settles the last line PARTIALLY, never over-allocates
 *   • never throws into the payment path, whatever fails
 *
 * Run:
 *   npx vitest run auto-offset-on-rent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recordOffsetService = vi.hoisted(() => vi.fn());
vi.mock("../../owner-remittance/owner-remittance.service", () => ({ recordOffsetService }));

const computeAvailableOwnerPayableC = vi.hoisted(() => vi.fn());
vi.mock("../../owner-remittance/owner-remittance.repository", () => ({ computeAvailableOwnerPayableC }));

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/audit", () => ({ recordAudit }));

const applyAllocationToChargeTx = vi.hoisted(() => vi.fn());
vi.mock("../../payments/payments.repository", () => ({ applyAllocationToChargeTx }));

const refreshDocumentStatusForCharges = vi.hoisted(() => vi.fn());
vi.mock("../../billing-documents/status.service", () => ({ refreshDocumentStatusForCharges }));

vi.mock("@kason/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@kason/db";
import { autoOffsetOwnerReceivablesForPaidRent } from "../auto-offset-on-rent.hook";

const ORG = "org-1";
const OWNER = "owner-1";
const RENT_CHARGE = "rent-charge-1";
const SERIES_ID = "series-ivown";

const dec = (s: string) => ({ toString: () => s });

/** One open IVOWN line: a BillingDocumentLine + the Charge behind it. */
function line(id: string, chargeId: string, chargeType: string, outstanding: string, issuedAt: string) {
  return {
    row: { id, chargeId, document: { issuedAt: new Date(issuedAt) } },
    charge: { id: chargeId, chargeType, outstandingAmount: dec(outstanding) },
  };
}

describe("autoOffsetOwnerReceivablesForPaidRent", () => {
  let dbMock: Record<string, unknown>;

  /**
   * `alreadyExpensedChargeIds` may name a charge id (the ledger deducted exactly the
   * charge amount — the ordinary case) or pass an explicit ledger amount, for the
   * case where an adjustment made the two diverge.
   */
  function setupDb(
    lines: ReturnType<typeof line>[],
    rentPaid = true,
    alreadyExpensedChargeIds: (string | { chargeId: string; amount: string })[] = [],
    depositFundCharges: { id: string; unit: { ownerPartyId: string }; carpark: null }[] = [],
  ) {
    const expensed = alreadyExpensedChargeIds.map((e) =>
      typeof e === "string"
        ? {
            sourceChargeId: e,
            // Source 2 books the expense FROM the charge amount, so they match.
            amount: dec(lines.find((l) => l.charge.id === e)?.charge.outstandingAmount.toString() ?? "0"),
          }
        : { sourceChargeId: e.chargeId, amount: dec(e.amount) },
    );
    dbMock = {
      ownerLedgerEntry: {
        findMany: vi.fn(async () => expensed),
      },
      charge: {
        findMany: vi.fn(async ({ where }: { where: { chargeType?: string | { in?: string[] } } }) => {
          // Trigger calls: fully-paid rent, then posted deposit funds. Remaining call:
          // the charges behind the open IVOWN lines.
          if (where.chargeType === "rent") {
            return rentPaid ? [{ id: RENT_CHARGE, unit: { ownerPartyId: OWNER }, carpark: null }] : [];
          }
          if (typeof where.chargeType === "object" && where.chargeType?.in?.includes("security_deposit")) {
            return depositFundCharges;
          }
          return lines.map((l) => l.charge);
        }),
      },
      organization: { findFirst: vi.fn(async () => ({ defaultCurrency: "MYR" })) },
      documentSeries: { findFirst: vi.fn(async () => ({ id: SERIES_ID })) },
      billingDocumentLine: { findMany: vi.fn(async () => lines.map((l) => l.row)) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        typeof fn === "function" ? fn({}) : undefined,
      ),
    };
    (getDb as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    recordOffsetService.mockResolvedValue({ ok: true, status: 201, data: { id: "entry-1" } });
    computeAvailableOwnerPayableC.mockResolvedValue(100_000); // RM 1,000.00 payable
    applyAllocationToChargeTx.mockImplementation(async (_tx, _org, chargeId) => ({
      exceeded: false as const,
      chargeId,
      newOutstanding: 0,
      becamePaid: true,
    }));
  });

  // ── Trigger gating ─────────────────────────────────────────────────────────

  it("runs UNCONDITIONALLY — no feature flag can switch the deduction off", async () => {
    // ENABLE_AUTO_OFFSET_ON_RENT was removed (2026-08-16). While it existed it defaulted
    // OFF, so the netting KAEN performs in practice never happened in the system and
    // owners' IVOWN invoices sat Unpaid forever. Setting the old name must now change
    // nothing — asserted explicitly so a reintroduced gate fails here.
    process.env.ENABLE_AUTO_OFFSET_ON_RENT = "false";
    try {
      setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
      await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
      expect(recordOffsetService).toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_AUTO_OFFSET_ON_RENT;
    }
  });

  it("does nothing when no charge ids are supplied", async () => {
    setupDb([]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", []);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("does nothing when the settled charges include no fully-paid rent", async () => {
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")], /* rentPaid */ false);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", ["some-utility-charge"]);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("uses a partial deposit collection as owner payout funds", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(51_495); // RM514.95 deposit collected
    setupDb(
      [line("l1", "wifi-owner", "wifi", "143.50", "2026-08-01")],
      /* rentPaid */ false,
      [],
      [{ id: "deposit-charge", unit: { ownerPartyId: OWNER }, carpark: null }],
    );

    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", ["deposit-charge"]);

    expect(recordOffsetService).toHaveBeenCalledTimes(1);
    expect(recordOffsetService.mock.calls[0]![1].lineAllocations).toEqual([
      { billingDocumentLineId: "l1", allocatedAmount: "143.50" },
    ]);
  });

  it("does nothing when the owner owes nothing", async () => {
    setupDb([]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  // ── MONEY: the payable cap ─────────────────────────────────────────────────

  it("MONEY: settles nothing when available payable is zero (letting-commission month)", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(0);
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("MONEY: settles nothing when the owner is in deficit (negative payable)", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(-24_000);
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("MONEY: never allocates more than the available payable", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(50_000); // RM 500 available
    setupDb([
      line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
      line("l2", "c2", "expense", "400.00", "2026-08-01"),
    ]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    const total = input.lineAllocations.reduce(
      (s: number, l: { allocatedAmount: string }) => s + Number(l.allocatedAmount),
      0,
    );
    expect(total).toBeCloseTo(500, 2);
  });

  it("MONEY: never allocates more than a line's own outstanding", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(100_000); // plenty
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    expect(input.lineAllocations).toEqual([
      { billingDocumentLineId: "l1", allocatedAmount: "300.00" },
    ]);
  });

  it("MONEY: a shortfall settles the LAST line partially, in priority order", async () => {
    computeAvailableOwnerPayableC.mockResolvedValue(40_000); // RM 400 against RM 700 owed
    setupDb([
      line("l2", "c2", "expense", "400.00", "2026-08-01"),
      line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
    ]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    // Mgmt fee (KAEN's own) fully settled first, the expense absorbs the shortfall.
    expect(input.lineAllocations).toEqual([
      { billingDocumentLineId: "l1", allocatedAmount: "300.00" },
      { billingDocumentLineId: "l2", allocatedAmount: "100.00" },
    ]);
  });

  it("MONEY: skips a line whose charge is already fully settled", async () => {
    setupDb([
      line("l1", "c1", "management_fee", "0.00", "2026-08-01"),
      line("l2", "c2", "expense", "200.00", "2026-08-01"),
    ]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    expect(input.lineAllocations).toEqual([
      { billingDocumentLineId: "l2", allocatedAmount: "200.00" },
    ]);
  });

  // ── MONEY: the double-deduct guard ─────────────────────────────────────────
  //
  // The regression that shipped and had to be fixed. A management-fee charge is
  // ALREADY booked as an owner-ledger expense by Source 2, which deducts it from the
  // payout. Offsetting it too consumed payable a second time: the owner was charged
  // the management fee twice. Only charges NOT already expensed may be offset.

  it("MONEY: never offsets a charge that is already an owner-ledger expense", async () => {
    setupDb(
      [
        line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
        line("l2", "c2", "expense", "800.00", "2026-08-01"),
      ],
      true,
      ["c1"], // the mgmt fee is already a ledger expense
    );
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    // RM 800 (the owner expenses), NOT RM 1,100.
    expect(input.lineAllocations).toEqual([
      { billingDocumentLineId: "l2", allocatedAmount: "800.00" },
    ]);
  });

  it("MONEY: consumes no payable when EVERY open line is already a ledger expense", async () => {
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")], true, ["c1"]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  // ── MONEY: payable-NEUTRAL settlement (the other half of the guard) ─────────
  //
  // Identifying an already-expensed charge is only half the job. Source 2 has
  // ALREADY deducted the management fee from the payout, so KAEN has in substance
  // been paid — but nothing ever settled the Charge, so the IVOWN invoice read
  // "Unpaid" forever while the owner's payout was already net of it. That is the
  // exact case this module's header describes ("an owner with three units saw
  // three permanently-unpaid management-fee invoices").
  //
  // These lines must therefore be SETTLED — through the ordinary charge rail, with
  // NO payout entry, so the paperwork catches up without touching the payable a
  // second time. Consuming payable here is the double-deduct the guard above
  // prevents; settling nothing is the stuck invoice. Both are wrong; this is the
  // narrow correct path between them.

  it("MONEY: settles an already-expensed mgmt fee on the charge rail, consuming NO payable", async () => {
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")], true, ["c1"]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    // Settled — full outstanding, in RINGGIT (the rail's unit), against the owner.
    expect(applyAllocationToChargeTx).toHaveBeenCalledTimes(1);
    const [, org, chargeId, amount, partyId] = applyAllocationToChargeTx.mock.calls[0]!;
    expect([org, chargeId, amount, partyId]).toEqual([ORG, "c1", 300, OWNER]);
    // …and NOT through the payable-consuming rail.
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("MONEY: settles ledger-backed lines even when the payable is zero", async () => {
    // The letting-commission month: KAEN owes the owner nothing, so nothing may be
    // OFFSET. The fee was still deducted by Source 2 though, so its paperwork must
    // still settle — a payable-neutral settlement needs no payable.
    computeAvailableOwnerPayableC.mockResolvedValue(0);
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")], true, ["c1"]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    expect(applyAllocationToChargeTx).toHaveBeenCalledTimes(1);
    expect(recordOffsetService).not.toHaveBeenCalled();
  });

  it("MONEY: caps the settlement at the expense the ledger actually booked", async () => {
    // An adjustment shrank the ledger deduction to RM 120 while the charge still
    // owes RM 300. Only RM 120 was ever deducted from the payout, so only RM 120
    // may be settled here — the rest is a real receivable, not paperwork.
    setupDb(
      [line("l1", "c1", "management_fee", "300.00", "2026-08-01")],
      true,
      [{ chargeId: "c1", amount: "120.00" }],
    );
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    expect(applyAllocationToChargeTx.mock.calls[0]![3]).toBe(120);
  });

  it("MONEY: both halves run — expensed lines settle, un-expensed lines offset", async () => {
    setupDb(
      [
        line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
        line("l2", "c2", "expense", "800.00", "2026-08-01"),
      ],
      true,
      ["c1"],
    );
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    expect(applyAllocationToChargeTx.mock.calls.map((c) => c[2])).toEqual(["c1"]);
    expect(recordOffsetService.mock.calls[0]![1].lineAllocations).toEqual([
      { billingDocumentLineId: "l2", allocatedAmount: "800.00" },
    ]);
  });

  // The document's list-view status is a PERSISTED projection (BillingDocument.status +
  // settlementStatus), not something derived on read. Settling the Charge alone left the
  // detail view reading "Paid" (it derives live from charges) while every list still read
  // "Unpaid" from the stale column. Every other settlement rail refreshes it — the offset
  // rail at owner-remittance.service.ts:904, all six payment paths, CN/DN, meter. This one
  // has to as well, or the money is right and the document lies about it.

  it("refreshes the document status projection after a payable-neutral settlement", async () => {
    setupDb(
      [
        line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
        line("l2", "c2", "management_fee", "150.00", "2026-08-01"),
      ],
      true,
      ["c1", "c2"],
    );
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    // ONE call carrying BOTH settled charges — the projection is per-document, and both
    // lines can sit on the same invoice. Refreshing per-line would re-derive it twice.
    expect(refreshDocumentStatusForCharges).toHaveBeenCalledTimes(1);
    expect(refreshDocumentStatusForCharges.mock.calls[0]![0].sort()).toEqual(["c1", "c2"]);
  });

  it("does not refresh when nothing was settled", async () => {
    setupDb([line("l1", "c1", "expense", "800.00", "2026-08-01")]); // offset rail only
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(refreshDocumentStatusForCharges).not.toHaveBeenCalled();
  });

  it("refreshes only the charges that actually settled, not the ones that failed", async () => {
    applyAllocationToChargeTx.mockImplementation(async (_tx, _org, chargeId) => {
      if (chargeId === "c1") throw new Error("stale");
      return { exceeded: false as const, chargeId, newOutstanding: 0, becamePaid: true };
    });
    setupDb(
      [
        line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
        line("l2", "c2", "management_fee", "150.00", "2026-08-01"),
      ],
      true,
      ["c1", "c2"],
    );
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    expect(refreshDocumentStatusForCharges.mock.calls[0]![0]).toEqual(["c2"]);
  });

  it("a settlement failure is audited and never thrown into the payment path", async () => {
    applyAllocationToChargeTx.mockRejectedValue(new Error("stale"));
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")], true, ["c1"]);

    await expect(
      autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]),
    ).resolves.toBeUndefined();
    expect(recordAudit).toHaveBeenCalled();
  });

  // ── Priority ordering ──────────────────────────────────────────────────────

  it("settles management fee, then letting-commission SST, then third-party costs", async () => {
    setupDb([
      line("l3", "c3", "utility", "100.00", "2026-08-01"),
      line("l2", "c2", "letting_commission_sst", "240.00", "2026-08-02"),
      line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
    ]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    expect(input.lineAllocations.map((l: { billingDocumentLineId: string }) => l.billingDocumentLineId))
      .toEqual(["l1", "l2", "l3"]);
  });

  it("within a priority band, the oldest document settles first", async () => {
    setupDb([
      line("l2", "c2", "management_fee", "120.00", "2026-08-05"),
      line("l1", "c1", "management_fee", "300.00", "2026-08-01"),
    ]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    expect(input.lineAllocations.map((l: { billingDocumentLineId: string }) => l.billingDocumentLineId))
      .toEqual(["l1", "l2"]);
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it("derives a well-formed UUID idempotency key", async () => {
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    const input = recordOffsetService.mock.calls[0]![1];
    expect(input.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("the same rent settlement replays the SAME key; a different one gets its own", async () => {
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    const first = recordOffsetService.mock.calls[0]![1].idempotencyKey;

    recordOffsetService.mockClear();
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    expect(recordOffsetService.mock.calls[0]![1].idempotencyKey).toBe(first);

    // A SECOND unit's rent settling in the same month must NOT replay the first
    // offset — that would silently settle nothing for the second unit.
    recordOffsetService.mockClear();
    dbMock.charge = {
      findMany: vi.fn(async ({ where }: { where: { chargeType?: string } }) =>
        where.chargeType === "rent"
          ? [{ id: "rent-charge-2", unit: { ownerPartyId: OWNER }, carpark: null }]
          : [{ id: "c1", chargeType: "management_fee", outstandingAmount: dec("300.00") }],
      ),
    };
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", ["rent-charge-2"]);
    expect(recordOffsetService.mock.calls[0]![1].idempotencyKey).not.toBe(first);
  });

  it("a later top-up on the same line gets a new key when its allocation amount changes", async () => {
    setupDb([line("l1", "c1", "wifi", "300.00", "2026-08-01")]);
    computeAvailableOwnerPayableC.mockResolvedValueOnce(3_203); // first partial: RM32.03
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);
    const partialKey = recordOffsetService.mock.calls[0]![1].idempotencyKey;

    recordOffsetService.mockClear();
    computeAvailableOwnerPayableC.mockResolvedValueOnce(11_147); // later deposit top-up
    await autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]);

    expect(recordOffsetService.mock.calls[0]![1].idempotencyKey).not.toBe(partialKey);
  });

  // ── Failure containment ────────────────────────────────────────────────────

  it("records an audit marker when the offset service rejects, and does NOT throw", async () => {
    recordOffsetService.mockResolvedValue({ ok: false, status: 409, error: "OFFSET_EXCEEDS_PAYABLE" });
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);

    await expect(
      autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]),
    ).resolves.toBeUndefined();

    expect(recordAudit).toHaveBeenCalled();
    const audited = recordAudit.mock.calls[0]![1];
    expect(audited.action).toBe("owner-billing.auto_offset.failed");
    expect(audited.meta.reason).toBe("OFFSET_EXCEEDS_PAYABLE");
  });

  it("swallows a thrown error — a failed settlement must never roll back a payment", async () => {
    recordOffsetService.mockRejectedValue(new Error("boom"));
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);

    await expect(
      autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]),
    ).resolves.toBeUndefined();
    expect(recordAudit).toHaveBeenCalled();
  });

  it("survives the audit write itself failing", async () => {
    recordOffsetService.mockRejectedValue(new Error("boom"));
    recordAudit.mockRejectedValue(new Error("audit down"));
    setupDb([line("l1", "c1", "management_fee", "300.00", "2026-08-01")]);

    await expect(
      autoOffsetOwnerReceivablesForPaidRent(ORG, "u1", "admin", [RENT_CHARGE]),
    ).resolves.toBeUndefined();
  });
});
