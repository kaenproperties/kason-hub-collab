import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GridRow } from "@/api/bills-grid";
import { BillConfirmDetails } from "../bill-confirm-details";

function unitCapRow(): GridRow {
  return {
    apartmentId: "apt-cap",
    unitCode: "A-02-02",
    propertyId: "property-1",
    propertyName: "Kensho Residence",
    propertyCode: "KR",
    entryId: "entry-cap",
    preview: null,
    previewError: null,
    billUtilityPlan: {
      status: "ready",
      mode: "subsidy",
      subsidyPerPax: "0.00",
      subsidyPolicy: "unit_tnb_cap_equal_tenancy",
      tnbSubsidyCap: "200.00",
      tnbSubsidyBreakdown: {
        residual: "204.00",
        ownerCap: "200.00",
        ownerPortion: "200.00",
        tenantExcess: "4.00",
        occupiedRoomCount: 3,
        allocations: [
          { listingId: "room-A", tenancyId: "ten-A", amount: "1.34" },
          { listingId: "room-B", tenancyId: "ten-B", amount: "1.33" },
          { listingId: "room-C", tenancyId: "ten-C", amount: "1.33" },
        ],
      },
      lines: [
        { key: "A:tnb", code: "electricity", label: "Electricity (TNB)", payer: "tenant", amount: "68.00", listingId: "room-A", tenancyId: "ten-A" },
        { key: "A:subsidy", code: "subsidy", label: "Subsidy", payer: "tenant", amount: "-66.66", listingId: "room-A", tenancyId: "ten-A" },
        { key: "B:tnb", code: "electricity", label: "Electricity (TNB)", payer: "tenant", amount: "68.00", listingId: "room-B", tenancyId: "ten-B" },
        { key: "B:subsidy", code: "subsidy", label: "Subsidy", payer: "tenant", amount: "-66.67", listingId: "room-B", tenancyId: "ten-B" },
        { key: "C:tnb", code: "electricity", label: "Electricity (TNB)", payer: "tenant", amount: "68.00", listingId: "room-C", tenancyId: "ten-C" },
        { key: "C:subsidy", code: "subsidy", label: "Subsidy", payer: "tenant", amount: "-66.67", listingId: "room-C", tenancyId: "ten-C" },
        { key: "A:private", code: "private_aircond", label: "Aircond (private meter)", payer: "tenant", amount: "18.00", listingId: "room-A", tenancyId: "ten-A" },
        { key: "B:private", code: "private_aircond", label: "Aircond (private meter)", payer: "tenant", amount: "30.00", listingId: "room-B", tenancyId: "ten-B" },
        { key: "C:private", code: "private_aircond", label: "Aircond (private meter)", payer: "tenant", amount: "48.00", listingId: "room-C", tenancyId: "ten-C" },
      ],
      blockedTenancyIds: [],
      errorCode: null,
    },
    warnings: [],
    subRows: [
      { listingId: "room-A", tenancyId: "ten-A", partyName: "Tenant A", previousKwh: null, currentKwh: null, amount: "18.00", ratePerKwh: "0.6000", rateConfigured: true, rental: null },
      { listingId: "room-B", tenancyId: "ten-B", partyName: "Tenant B", previousKwh: null, currentKwh: null, amount: "30.00", ratePerKwh: "0.6000", rateConfigured: true, rental: null },
      { listingId: "room-C", tenancyId: "ten-C", partyName: "Tenant C", previousKwh: null, currentKwh: null, amount: "48.00", ratePerKwh: "0.6000", rateConfigured: true, rental: null },
    ],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: {
      cleaning: "0.00",
      tnbTotal: "300.00",
      airSelangor: "0.00",
      wifi: "0.00",
      maintenanceFee: "0.00",
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
      tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
      owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
    },
    pendingTenancyCharges: [],
    attachments: [],
    isWholeUnit: false,
  } as GridRow;
}

describe("BillConfirmDetails TNB cap explanation", () => {
  it("shows the unit identity, owner cap and deterministic tenant excess without double-counting it", () => {
    render(
      <BillConfirmDetails
        rows={[unitCapRow()]}
        billingPeriod="2026-08"
        options={{ includeGridCharges: true, includeExpenses: false }}
      />,
    );

    const unit = screen.getByTestId("bill-confirm-unit-apt-cap");
    expect(within(unit).getByText("Property Short Form + Unit Number")).toBeInTheDocument();
    expect(within(unit).getByRole("heading", { name: "KR A-02-02" })).toBeInTheDocument();

    const breakdown = screen.getByTestId("bill-confirm-tnb-cap-apt-cap");
    expect(breakdown).toHaveTextContent("TNB residualRM 204.00");
    expect(breakdown).toHaveTextContent("Owner monthly capRM 200.00");
    expect(breakdown).toHaveTextContent("Owner portionRM 200.00");
    expect(breakdown).toHaveTextContent("Tenant excessRM 4.00");
    expect(breakdown).toHaveTextContent("Equal split · 3 occupied rooms");
    expect(breakdown).toHaveTextContent("Tenant ARM 1.34");
    expect(breakdown).toHaveTextContent("Tenant BRM 1.33");
    expect(breakdown).toHaveTextContent("Tenant CRM 1.33");

    // Private meter RM18 + RM30 + RM48 remains itemized. The cap card is only an
    // explanation: the six gross-TNB/subsidy lines net to RM4, so the real unit
    // total is RM96 private electricity + RM4 excess = RM100, never RM104.
    expect(within(unit).getAllByText("Aircond (private meter)")).toHaveLength(3);
    expect(screen.getByTestId("bill-confirm-unit-total-apt-cap")).toHaveTextContent("RM 100.00");
  });
});
