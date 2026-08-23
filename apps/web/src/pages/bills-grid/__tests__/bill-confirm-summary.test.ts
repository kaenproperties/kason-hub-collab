import { describe, expect, it } from "vitest";
import type { GridRow } from "@/api/bills-grid";
import { summarizeBillRow, summarizeBillRows } from "../bill-confirm-summary";

function makeDetailedRow(overrides: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "apt-1",
    unitCode: "A-02-02",
    propertyId: "property-1",
    propertyName: "Kensho Residence",
    propertyCode: "KR",
    entryId: "entry-1",
    preview: {
      allocations: [{
        unitId: "room-1",
        tenancyId: "tenancy-1",
        partyId: "tenant-1",
        pax: 1,
        tnbShare: 100,
        airSelangorShare: 20,
        indahShare: 0,
        wifiShare: 0,
        cleaningShare: 0,
        maintenanceShare: 0,
        grossShareTotal: 120,
        subsidyDeduction: 10,
        computedAmount: 110,
        unitCode: "Room 1",
        listingType: "ROOM",
      }],
      totalAircond: 25,
      leftoverTnb: 100,
      sharedPool: 120,
      totalPax: 1,
      subsidyCovered: 10,
      ownerAttributableAircond: 0,
      ownerBorneUtilities: 190,
      roundingResidual: 0,
      ownerBorneUtilitiesTotal: 190,
    },
    previewError: null,
    billUtilityPlan: {
      status: "ready",
      mode: "subsidy",
      subsidyPerPax: "10.00",
      blockedTenancyIds: [],
      errorCode: null,
      lines: [
        { key: "utility:tenant:room-1:electricity", code: "electricity", label: "Electricity (TNB)", payer: "tenant", amount: "100.00", listingId: "room-1", tenancyId: "tenancy-1" },
        { key: "utility:tenant:room-1:water", code: "water", label: "Water (Air Selangor)", payer: "tenant", amount: "20.00", listingId: "room-1", tenancyId: "tenancy-1" },
        { key: "utility:tenant:room-1:subsidy", code: "subsidy", label: "Subsidy", payer: "tenant", amount: "-10.00", listingId: "room-1", tenancyId: "tenancy-1" },
        { key: "utility:tenant:room-1:private_aircond", code: "private_aircond", label: "Aircond (private meter)", payer: "tenant", amount: "25.00", listingId: "room-1", tenancyId: "tenancy-1" },
        { key: "utility:owner:apt-1:cleaning", code: "cleaning", label: "Cleaning", payer: "owner", amount: "80.00", listingId: "owner-room", tenancyId: null },
        { key: "utility:owner:apt-1:wifi", code: "wifi", label: "WiFi", payer: "owner", amount: "60.00", listingId: "owner-room", tenancyId: null },
        { key: "utility:owner:apt-1:maintenance", code: "maintenance", label: "Maintenance", payer: "owner", amount: "50.00", listingId: "owner-room", tenancyId: null },
      ],
    },
    warnings: [],
    subRows: [{
      listingId: "room-1",
      tenancyId: "tenancy-1",
      partyId: "tenant-1",
      partyName: "Alicia Tan",
      previousKwh: "100.00",
      currentKwh: "150.00",
      amount: "25.00",
      ratePerKwh: "0.5000",
      rateConfigured: true,
      rental: "1200.00",
      rentalBillingState: "saved",
      deposit: "2400.00",
      depositBillingState: "saved",
    }],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: {
      cleaning: "80.00",
      tnbTotal: "150.00",
      airSelangor: "40.00",
      wifi: "60.00",
      maintenanceFee: "50.00",
      readingDate: null,
      paymentStatus: "unpaid",
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      updatedAt: "2026-08-01T00:00:00.000Z",
      lockState: "draft",
    },
    bearerConfig: {
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "0.00",
      isLocked: false,
    },
    expenses: {
      tenant: {
        total: "100.00",
        withSstTotal: "100.00",
        sstTotal: "8.00",
        count: 1,
        items: [{ id: "expense-t", description: "Plumbing repair", amount: "100.00", sst: "8.00", total: "108.00", withSST: true }],
      },
      owner: {
        total: "50.00",
        withSstTotal: "50.00",
        sstTotal: "4.00",
        count: 1,
        items: [{ id: "expense-o", description: "Key replacement", amount: "50.00", sst: "4.00", total: "54.00", withSST: true }],
      },
    },
    managementFee: { nonSst: "999.00", sst: "79.92", total: "1078.92" },
    agreementFees: {
      new: { amount: "120.00", outstanding: "120.00", state: "saved" },
      renewal: { amount: "500.00", outstanding: "500.00", state: "billed-unpaid" },
    },
    pendingTenancyCharges: [
      { id: "rent-1", description: "Rental", kind: "rental", baseAmount: "1200.00", sst: "0.00", total: "1200.00", tenantName: "Alicia Tan" },
      { id: "deposit-1", description: "Deposit", kind: "deposit", baseAmount: "2400.00", sst: "0.00", total: "2400.00", tenantName: "Alicia Tan" },
      { id: "ta-1", description: "TA (WITH SST)", kind: "agreement_fee", baseAmount: "120.00", sst: "0.00", total: "120.00", tenantName: "Alicia Tan" },
    ],
    ownerPayout: "5000.00",
    ownerTopUpRequired: "200.00",
    recurring: {
      tenant: { total: "30.00", count: 1, items: [{ id: "recur-t", name: "Laundry", amount: "30.00" }] },
      owner: { total: "80.00", count: 1, items: [{ id: "recur-o", name: "Gardener", amount: "80.00" }] },
    },
    attachments: [],
    isWholeUnit: false,
    ...overrides,
  } as GridRow;
}

describe("summarizeBillRow", () => {
  it("lists saved tenancy, tenant/owner utilities, recurring and exact SST expenses", () => {
    const summary = summarizeBillRow(makeDetailedRow(), {
      includeGridCharges: true,
      includeExpenses: true,
    });

    expect(summary.lines.map((line) => [line.label, line.payer, line.amount])).toEqual(expect.arrayContaining([
      ["Rental", "tenant", 1200],
      ["Deposit", "tenant", 2400],
      ["TA (WITH SST)", "tenant", 120],
      ["Electricity (TNB)", "tenant", 100],
      ["Water (Air Selangor)", "tenant", 20],
      ["Subsidy", "tenant", -10],
      ["Aircond (private meter)", "tenant", 25],
      ["Cleaning", "owner", 80],
      ["WiFi", "owner", 60],
      ["Maintenance", "owner", 50],
      ["Laundry", "tenant", 30],
      ["Gardener", "owner", 80],
      ["Plumbing repair", "tenant", 108],
      ["Key replacement", "owner", 54],
    ]));
    expect(summary.lines).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 1078.92 }),
      expect.objectContaining({ amount: 5000 }),
      expect.objectContaining({ amount: 200 }),
    ]));
    expect(summary.tenantTotal).toBe(3993);
    expect(summary.ownerTotal).toBe(324);
    expect(summary.total).toBe(4317);
    expect(summary.totalIsComplete).toBe(true);
  });

  it("excludes already billed/paid tenancy cells and every owner-ledger-only value", () => {
    const row = makeDetailedRow({
      entry: null,
      preview: null,
      subRows: [{
        ...makeDetailedRow().subRows[0]!,
        rentalBillingState: "paid",
        depositBillingState: "billed-unpaid",
      }],
      agreementFees: {
        new: { amount: "120.00", outstanding: "0.00", state: "paid" },
        renewal: { amount: "500.00", outstanding: "500.00", state: "billed-unpaid" },
      },
      pendingTenancyCharges: [],
      recurring: undefined,
      expenses: {
        tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
        owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.lines).toEqual([]);
    expect(summary.total).toBe(0);
    expect(summary.totalIsComplete).toBe(true);
  });

  it("lists carpark and attached extra charges with their server-resolved payer", () => {
    const row = makeDetailedRow({
      entry: null,
      pendingTenancyCharges: [
        { id: "carpark-1", description: "Carpark rent", kind: "carpark", payer: "tenant", baseAmount: "180.00", sst: "0.00", total: "180.00", tenantName: "Alicia Tan" },
        { id: "extra-1", description: "Owner inspection", kind: "other", payer: "owner", baseAmount: "50.00", sst: "4.00", total: "54.00", tenantName: "Owner Sdn Bhd" },
      ],
      recurring: undefined,
      expenses: {
        tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
        owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.lines).toEqual([
      expect.objectContaining({ label: "Carpark rent", payer: "tenant", amount: 180 }),
      expect.objectContaining({ label: "Owner inspection", payer: "owner", amount: 54 }),
    ]);
    expect(summary.tenantTotal).toBe(180);
    expect(summary.ownerTotal).toBe(54);
    expect(summary.total).toBe(234);
  });

  it("flags a missing utility preview instead of fabricating utility lines", () => {
    const row = makeDetailedRow({
      preview: null,
      previewError: { code: "PREVIEW_FAILED" },
      billUtilityPlan: undefined,
    });
    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: false });

    expect(summary.utilityPreviewUnavailable).toBe(true);
    expect(summary.lines.some((line) => line.key.startsWith("utility:"))).toBe(false);
    // Saved tenancy charges remain visible even though the separate utility preview failed.
    expect(summary.lines.some((line) => line.label === "Rental")).toBe(true);
    expect(summary.totalIsComplete).toBe(false);
  });

  it("uses the server Bill plan and ignores a conflicting read-only grid preview", () => {
    const row = makeDetailedRow({
      preview: {
        ...makeDetailedRow().preview!,
        allocations: [{ ...makeDetailedRow().preview!.allocations[0]!, tnbShare: 9999, computedAmount: 9999 }],
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: false });
    expect(summary.lines).toContainEqual(expect.objectContaining({ key: "utility:tenant:room-1:electricity", amount: 100 }));
    expect(summary.lines).not.toContainEqual(expect.objectContaining({ amount: 9999 }));
  });

  it("marks a pax-blocked server plan incomplete and never fabricates utility lines", () => {
    const row = makeDetailedRow({
      billUtilityPlan: {
        status: "pax_blocked",
        mode: "no_subsidy",
        subsidyPerPax: "0.00",
        lines: [],
        blockedTenancyIds: ["tenancy-1"],
        errorCode: null,
      },
    });
    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: false });
    expect(summary.lines.some((line) => line.key.startsWith("utility:"))).toBe(false);
    expect(summary.lines.filter((line) => line.key.startsWith("tenancy:"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ billingState: "blocked" })]),
    );
    expect(summary.lines.some((line) => line.key.startsWith("recurring:"))).toBe(false);
    expect(summary.total).toBe(0);
    expect(summary.totalIsComplete).toBe(false);
    expect(summary.incompleteReasons[0]).toMatch(/pax/i);
  });

  it("does not re-list grid recurring or expenses for a legacy billed-without-document row", () => {
    const row = makeDetailedRow({
      billUtilityPlan: {
        status: "not_applicable",
        mode: "whole",
        subsidyPerPax: "0.00",
        lines: [],
        blockedTenancyIds: [],
        errorCode: null,
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.lines.map((line) => line.label)).toEqual([
      "Rental",
      "Deposit",
      "TA (WITH SST)",
    ]);
    expect(summary.total).toBe(3720);
    expect(summary.totalIsComplete).toBe(true);
  });

  it("does not overstate recurring or expenses while a billed row awaits paid-line review", () => {
    const row = makeDetailedRow({
      billUtilityPlan: {
        status: "rebill_review",
        mode: "subsidy",
        subsidyPerPax: "10.00",
        lines: [],
        blockedTenancyIds: [],
        errorCode: null,
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.lines.map((line) => line.label)).toEqual([
      "Rental",
      "Deposit",
      "TA (WITH SST)",
    ]);
    expect(summary.tenantTotal).toBe(3720);
    expect(summary.ownerTotal).toBe(0);
    expect(summary.totalIsComplete).toBe(false);
    expect(summary.incompleteReasons).toContain("Re-Bill charge lines require the server's paid-line review.");
  });

  it("uses exact aggregates instead of silently dropping partial recurring and expense item arrays", () => {
    const row = makeDetailedRow({
      entry: { ...makeDetailedRow().entry!, cleaning: "0.00", wifi: "0.00", maintenanceFee: "0.00" },
      preview: { ...makeDetailedRow().preview!, ownerBorneUtilities: 0, ownerBorneUtilitiesTotal: 0 },
      recurring: {
        tenant: { total: "50.00", count: 2, items: [{ id: "one", name: "One item only", amount: "20.00" }] },
        owner: { total: "0.00", count: 0, items: [] },
      },
      expenses: {
        tenant: {
          total: "150.00",
          withSstTotal: "100.00",
          sstTotal: "8.00",
          count: 2,
          items: [{ id: "one", description: "One expense only", amount: "50.00", sst: "0.00", total: "50.00", withSST: false }],
        },
        owner: { total: "0.00", withSstTotal: "0.00", sstTotal: "0.00", count: 0, items: [] },
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "recurring:tenant:summary", amount: 50 }),
      expect.objectContaining({ key: "expense:tenant:summary", amount: 158 }),
    ]));
    expect(summary.detailWarnings).toHaveLength(2);
    expect(summary.totalIsComplete).toBe(true);
  });

  it("marks an old expense aggregate with missing SST as an incomplete known subtotal", () => {
    const row = makeDetailedRow({
      expenses: {
        tenant: { total: "100.00", withSstTotal: "100.00", count: 1 },
        owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
      },
    });

    const summary = summarizeBillRow(row, { includeGridCharges: true, includeExpenses: true });
    expect(summary.totalIsComplete).toBe(false);
    expect(summary.incompleteReasons).toContain("Tenant expense SST is unavailable.");
  });

  it("aggregates multiple selected units without losing payer subtotals", () => {
    const one = makeDetailedRow();
    const two = makeDetailedRow({ apartmentId: "apt-2", propertyCode: "KR2" });
    expect(summarizeBillRows([one, two], { includeGridCharges: true, includeExpenses: true })).toEqual({
      tenantTotal: 7986,
      ownerTotal: 648,
      total: 8634,
      totalIsComplete: true,
    });
  });
});
