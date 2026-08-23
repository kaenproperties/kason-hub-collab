// apps/api/src/modules/bills-grid/__tests__/row-dto-mappers.test.ts
// Task 10 — pure-mapper unit tests for the grid read-DTO enrichment
// (propertyId / entry / bearerConfig / expenses / attachments, spec §1).
// Default suite, NO DB: these mappers take plain data in, plain DTOs out.
// `@prisma/client`'s `Prisma.Decimal` is imported directly (NOT via `@kason/db`,
// which vitest.config.ts aliases to a DB-free mock for the default suite) so we
// get a REAL Decimal instance without instantiating a Prisma client.
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { toAttachmentBriefs, toBearerConfigDto, toEntryDto, toExpensesDto, toGridRowDto, toPendingTenancyChargeDto, toRecurringDto } from "../service";

describe("toEntryDto", () => {
  it("returns null for a null entry (never-materialised apartment-month)", () => {
    expect(toEntryDto(null)).toBeNull();
  });

  it("maps a populated entry: wire-name remap (tnbTotalRaw/airSelangorRaw), Decimals->strings, draft lockState, updatedAt ISO", () => {
    const updatedAt = new Date("2026-07-05T10:00:00.000Z");
    const readingDate = new Date("2026-07-03T00:00:00.000Z");
    const dto = toEntryDto({
      cleaning: new Prisma.Decimal("100.00"),
      tnbTotalRaw: new Prisma.Decimal("590.00"),
      airSelangorRaw: new Prisma.Decimal("40.00"),
      wifi: new Prisma.Decimal("80.00"),
      maintenanceFee: new Prisma.Decimal("50.00"),
      readingDate,
      paymentStatus: "unpaid",
      tnbPattern: "recharged",
      airPattern: "absorbed",
      cleaningBearer: "owner",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "owner",
      updatedAt,
      billedAt: null,
    });
    expect(dto).toEqual({
      cleaning: "100",
      tnbTotal: "590", // WIRE NAME, sourced from tnbTotalRaw
      airSelangor: "40", // WIRE NAME, sourced from airSelangorRaw
      wifi: "80",
      maintenanceFee: "50",
      readingDate: "2026-07-03",
      paymentStatus: "unpaid",
      tnbPattern: "recharged",
      airPattern: "absorbed",
      cleaningBearer: "owner",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "owner",
      updatedAt: "2026-07-05T10:00:00.000Z",
      lockState: "draft",
      lastEditedByName: null, // P5: no updatedById on this fixture ⇒ null
    });
  });

  it("(Task 5) GridEntryDto no longer carries `rental` — money moved to SubRowDto.rental", () => {
    const dto = toEntryDto({
      cleaning: new Prisma.Decimal("100.00"),
      tnbTotalRaw: new Prisma.Decimal("590.00"),
      airSelangorRaw: new Prisma.Decimal("40.00"),
      wifi: new Prisma.Decimal("80.00"),
      maintenanceFee: new Prisma.Decimal("50.00"),
      readingDate: null,
      paymentStatus: "unpaid",
      tnbPattern: "recharged",
      airPattern: "absorbed",
      cleaningBearer: "owner",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "owner",
      updatedAt: new Date("2026-07-05T10:00:00.000Z"),
      billedAt: null,
    });
    expect(dto).not.toBeNull();
    expect(dto).not.toHaveProperty("rental");
  });

  it("a non-null billedAt maps to lockState 'locked'", () => {
    const dto = toEntryDto({
      cleaning: null,
      tnbTotalRaw: null,
      airSelangorRaw: null,
      wifi: null,
      maintenanceFee: null,
      readingDate: null,
      paymentStatus: "paid",
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      billedAt: new Date("2026-07-09T00:00:00.000Z"),
    });
    expect(dto?.lockState).toBe("locked");
    // null Decimal fields and null readingDate map through as null, never "null" or NaN.
    expect(dto?.tnbTotal).toBeNull();
    expect(dto?.readingDate).toBeNull();
  });
});

describe("toExpensesDto", () => {
  it("sums tenant.total, tenant.withSstTotal, owner.total, and owner.withSstTotal (withSST rows only, per bearer)", () => {
    const dto = toExpensesDto([
      { bearer: "tenant", amount: new Prisma.Decimal("50.00"), withSST: true },
      { bearer: "tenant", amount: new Prisma.Decimal("30.00"), withSST: false },
      { bearer: "owner", amount: new Prisma.Decimal("20.00"), withSST: true },
      { bearer: "owner", amount: new Prisma.Decimal("15.50"), withSST: false },
    ]);
    expect(dto).toEqual({
      tenant: { total: "80.00", withSstTotal: "50.00", sstTotal: "4.00", count: 2, items: [], nonSstCount: 1, withSstCount: 1, nonSstActionRequiredCount: 1, withSstActionRequiredCount: 1, nonSstGrossMargin: "30.00", withSstGrossMargin: "50.00" },
      owner: { total: "35.50", withSstTotal: "20.00", sstTotal: "1.60", count: 2, items: [], nonSstCount: 1, withSstCount: 1, nonSstActionRequiredCount: 1, withSstActionRequiredCount: 1, nonSstGrossMargin: "15.50", withSstGrossMargin: "20.00" },
    });
  });

  it("an empty array maps to all '0.00' totals", () => {
    expect(toExpensesDto([])).toEqual({
      tenant: { total: "0.00", withSstTotal: "0.00", sstTotal: "0.00", count: 0, items: [], nonSstCount: 0, withSstCount: 0, nonSstActionRequiredCount: 0, withSstActionRequiredCount: 0, nonSstGrossMargin: "0.00", withSstGrossMargin: "0.00" },
      owner: { total: "0.00", withSstTotal: "0.00", sstTotal: "0.00", count: 0, items: [], nonSstCount: 0, withSstCount: 0, nonSstActionRequiredCount: 0, withSstActionRequiredCount: 0, nonSstGrossMargin: "0.00", withSstGrossMargin: "0.00" },
    });
  });

  it("itemizes named expenses and sums SST after rounding each line to cents", () => {
    const dto = toExpensesDto([
      { id: "expense-a", description: "Key copy", bearer: "tenant", amount: new Prisma.Decimal("0.07"), withSST: true },
      { id: "expense-b", description: "Access card", bearer: "tenant", amount: new Prisma.Decimal("0.07"), withSST: true },
      { id: "expense-c", description: "Owner repair", bearer: "owner", amount: new Prisma.Decimal("10.00"), withSST: false },
    ]);

    // RM0.07 × 8% rounds to RM0.01 per invoice line. Summing the two rounded
    // lines yields RM0.02 (different from taxing their RM0.14 aggregate).
    expect(dto.tenant.sstTotal).toBe("0.02");
    expect(dto.tenant.items).toEqual([
      { id: "expense-a", description: "Key copy", amount: "0.07", sst: "0.01", total: "0.08", withSST: true },
      { id: "expense-b", description: "Access card", amount: "0.07", sst: "0.01", total: "0.08", withSST: true },
    ]);
    expect(dto.owner.items).toEqual([
      { id: "expense-c", description: "Owner repair", amount: "10.00", sst: "0.00", total: "10.00", withSST: false },
    ]);
  });

  it("counts cost actions independently per SST cell and clears completed Paid costs including RM0", () => {
    const dto = toExpensesDto([
      { bearer: "tenant", amount: new Prisma.Decimal("120.00"), withSST: false, actualCost: null, costPaymentStatus: "unpaid" },
      { bearer: "tenant", amount: new Prisma.Decimal("100.00"), withSST: true, actualCost: new Prisma.Decimal("0.00"), costPaymentStatus: "paid" },
    ]);
    expect(dto.tenant.nonSstActionRequiredCount).toBe(1);
    expect(dto.tenant.withSstActionRequiredCount).toBe(0);
    expect(dto.tenant.withSstGrossMargin).toBe("100.00");
  });

  it("calculates profit and loss independently for each SST cell", () => {
    const dto = toExpensesDto([
      { bearer: "tenant", amount: new Prisma.Decimal("120.00"), withSST: false, actualCost: new Prisma.Decimal("100.00"), costPaymentStatus: "paid" },
      { bearer: "tenant", amount: new Prisma.Decimal("100.00"), withSST: true, actualCost: new Prisma.Decimal("130.00"), costPaymentStatus: "paid" },
    ]);
    expect(dto.tenant.nonSstGrossMargin).toBe("20.00");
    expect(dto.tenant.withSstGrossMargin).toBe("-30.00");
  });
});

describe("toRecurringDto", () => {
  it("always emits item arrays while accepting legacy totals that do not provide them", () => {
    expect(toRecurringDto({ ownerTotal: 20, ownerCount: 1, tenantTotal: 0, tenantCount: 0 })).toEqual({
      owner: { total: "20.00", count: 1, items: [] },
      tenant: { total: "0.00", count: 0, items: [] },
    });

    expect(toRecurringDto({
      ownerTotal: 80,
      ownerCount: 1,
      ownerItems: [{ id: "definition-1", name: "Gardener", amount: "80.00" }],
      tenantTotal: 30,
      tenantCount: 1,
      tenantItems: [{ id: "line-2", name: "Laundry", amount: "30.00" }],
    })).toEqual({
      owner: { total: "80.00", count: 1, items: [{ id: "definition-1", name: "Gardener", amount: "80.00" }] },
      tenant: { total: "30.00", count: 1, items: [{ id: "line-2", name: "Laundry", amount: "30.00" }] },
    });
  });
});

describe("toPendingTenancyChargeDto", () => {
  it("maps every supported draft charge kind without changing zero-rated amounts", () => {
    const cases = [
      ["rent", "tenant_rental", "rental", "Rental"],
      ["letting_commission", "tenant_rental", "rental", "Rental"],
      ["security_deposit", "tenant_deposit", "deposit", "Deposit"],
      ["utility_deposit", "tenant_deposit", "deposit", "Deposit"],
      ["tenancy_agreement_fee", "tenant_agreement_fee", "agreement_fee", "TA (WITH SST)"],
      ["renewal_fee", "tenant_renewal", "renewal_fee", "Renewal TA (WITH SST)"],
    ] as const;

    for (const [chargeType, invoiceType, kind, fallbackDescription] of cases) {
      expect(toPendingTenancyChargeDto({
        id: `charge-${chargeType}`,
        description: null,
        chargeType,
        chargeStatus: "draft",
        amount: new Prisma.Decimal("0.07"),
        sstRate: new Prisma.Decimal("0"),
        invoiceStatus: "draft",
        invoiceType,
        payer: "tenant",
        tenantName: "Ali bin Ahmad",
      })).toEqual({
        id: `charge-${chargeType}`,
        description: fallbackDescription,
        kind,
        payer: "tenant",
        baseAmount: "0.07",
        sst: "0.00",
        total: "0.07",
        tenantName: "Ali bin Ahmad",
      });
    }
  });

  it("includes carpark and arbitrary attached charges because approval posts the whole draft invoice", () => {
    expect(toPendingTenancyChargeDto({
      id: "carpark-1",
      description: null,
      chargeType: "carpark",
      chargeStatus: "draft",
      amount: new Prisma.Decimal("180.00"),
      sstRate: null,
      categoryName: "Carpark",
      categorySstRate: new Prisma.Decimal("0"),
      invoiceType: "tenant_rental",
      invoiceStatus: "draft",
      payer: "tenant",
      tenantName: "Ali bin Ahmad",
    })).toEqual({
      id: "carpark-1",
      description: "Carpark",
      kind: "carpark",
      payer: "tenant",
      baseAmount: "180.00",
      sst: "0.00",
      total: "180.00",
      tenantName: "Ali bin Ahmad",
    });

    // Charge type does not need to match the containing invoice type: the canonical
    // attach flow permits extras and bulk approval posts every attached draft line.
    expect(toPendingTenancyChargeDto({
      id: "extra-1",
      description: null,
      chargeType: "custom_owner_service",
      chargeStatus: "draft",
      amount: new Prisma.Decimal("50.00"),
      sstRate: null,
      categoryName: "Owner inspection",
      categorySstRate: new Prisma.Decimal("8"),
      invoiceType: "tenant_rental",
      invoiceStatus: "draft",
      payer: "owner",
      tenantName: "Owner Sdn Bhd",
    })).toEqual({
      id: "extra-1",
      description: "Owner inspection",
      kind: "other",
      payer: "owner",
      baseAmount: "50.00",
      sst: "4.00",
      total: "54.00",
      tenantName: "Owner Sdn Bhd",
    });
  });

  it("previews an SST-inclusive TA as its backend base plus exact linked SST", () => {
    expect(toPendingTenancyChargeDto({
      id: "ta-inclusive",
      description: "Tenancy agreement fee",
      chargeType: "tenancy_agreement_fee",
      chargeStatus: "draft",
      amount: new Prisma.Decimal("462.96"),
      sstRate: new Prisma.Decimal("8"),
      categorySstRate: new Prisma.Decimal("8"),
      exactSstAmount: new Prisma.Decimal("37.04"),
      invoiceType: "tenant_agreement_fee",
      invoiceStatus: "draft",
      payer: "tenant",
      tenantName: "Ali bin Ahmad",
    })).toMatchObject({ description: "TA (WITH SST)", baseAmount: "462.96", sst: "37.04", total: "500.00" });

    expect(toPendingTenancyChargeDto({
      id: "ta-rate-fallback",
      description: "Tenancy agreement fee",
      chargeType: "tenancy_agreement_fee",
      chargeStatus: "draft",
      amount: new Prisma.Decimal("462.96"),
      sstRate: null,
      categorySstRate: new Prisma.Decimal("8"),
      invoiceType: "tenant_agreement_fee",
      invoiceStatus: "draft",
      payer: "tenant",
      tenantName: "Ali bin Ahmad",
    })).toMatchObject({ description: "TA (WITH SST)", baseAmount: "462.96", sst: "37.04", total: "500.00" });
  });

  it("excludes issued/detached invoices, disallowed invoice types, and non-draft charges", () => {
    const charge = {
      id: "charge-1",
      description: "Monthly rental",
      chargeType: "rent",
      chargeStatus: "draft",
      amount: new Prisma.Decimal("1200"),
      sstRate: null,
      invoiceType: "tenant_rental",
      payer: "tenant" as const,
      tenantName: null,
    };
    expect(toPendingTenancyChargeDto({ ...charge, invoiceStatus: "issued" })).toBeNull();
    expect(toPendingTenancyChargeDto({ ...charge, invoiceStatus: null })).toBeNull();
    expect(toPendingTenancyChargeDto({ ...charge, invoiceType: "owner_statement", invoiceStatus: "draft" })).toBeNull();
    expect(toPendingTenancyChargeDto({ ...charge, chargeStatus: "posted", invoiceStatus: "draft" })).toBeNull();
  });
});

describe("toExpensesDto — active expense count (R8)", () => {
  it("counts active lines per bearer, totals unchanged", () => {
    const dto = toExpensesDto([
      { bearer: "tenant", amount: new Prisma.Decimal("10.00"), withSST: true },
      { bearer: "tenant", amount: new Prisma.Decimal("5.00"), withSST: false },
      { bearer: "owner", amount: new Prisma.Decimal("7.00"), withSST: false },
    ]);
    expect(dto.tenant.count).toBe(2);
    expect(dto.owner.count).toBe(1);
    expect(dto.tenant.total).toBe("15.00");
    expect(dto.owner.total).toBe("7.00");
  });

  it("empty array → zero counts (no NaN)", () => {
    const dto = toExpensesDto([]);
    expect(dto.tenant.count).toBe(0);
    expect(dto.owner.count).toBe(0);
  });

  it("a bearer value outside tenant/owner is excluded from both count and total (mirrors the existing total-exclusion branch)", () => {
    const dto = toExpensesDto([
      { bearer: "tenant", amount: new Prisma.Decimal("10.00"), withSST: false },
      { bearer: "unknown", amount: new Prisma.Decimal("999.00"), withSST: true },
    ]);
    expect(dto.tenant.count).toBe(1);
    expect(dto.owner.count).toBe(0);
    expect(dto.tenant.total).toBe("10.00");
    expect(dto.owner.total).toBe("0.00");
  });
});

describe("toBearerConfigDto", () => {
  // Cleaning and WiFi are owner-only grid costs for every listing mode. Exceptional
  // tenant recoveries are entered as Tenant Expenses instead of a permanent column.
  it("returns the exact getBearerConfigService defaults when no config row exists — WHOLE", () => {
    expect(toBearerConfigDto(null, "WHOLE")).toEqual({
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      // 2026-08-17: was "100.00". A never-configured unit must NOT start with a phantom
      // recurring cleaning amount — getOrCreateEntry freezes this seed onto the month's
      // entry, so it was billable, and it competed with the grid's own Recurring editor.
      // 0 is the disabled sentinel. Must equal DEFAULT_CLEANING_RECURRING_AMOUNT and the
      // Prisma @default on UnitBillsBearerConfig.cleaningRecurringAmount.
      cleaningRecurringAmount: "0.00",
      isLocked: false,
      // charge-nature gate (2026-07-27): the seeded default is UNDECIDED, never "profit" — a
      // default here would silently re-create the assumption the bill-time gate exists to remove.
      cleaningNature: null,
      wifiNature: null,
      // Governance is a caller-supplied overlay; omitted ⇒ ungoverned ⇒ drawer controls editable.
      cleaningGoverned: false,
      wifiGoverned: false,
      // Every scalar kind defaults to un-ticked with no amount. Listing all five here is
      // deliberate: if a kind is added to SCALAR_RECURRING_KINDS this assertion fails, which is
      // the reminder that the drawer gains a row and the grid gains a lockable cell.
      scalarRecurring: {
        CLEANING: { governed: false, amount: null, definitionId: null },
        WIFI: { governed: false, amount: null, definitionId: null },
        TNB: { governed: false, amount: null, definitionId: null },
        AIR: { governed: false, amount: null, definitionId: null },
        MAINTENANCE: { governed: false, amount: null, definitionId: null },
      },
    });
  });

  // A PARTITIONED unit's cleaning + WiFi are shared common-area costs the owner carries,
  // so they start OWNER-borne. TNB/AIR stay "recharged" in BOTH modes: the partitioned
  // excess→owner spread is engine-side (computeAllocation's privateAircond clamp), NOT a
  // bearer. Setting TNB "absorbed" here would mean "owner eats it, tenant billed nothing".
  it("returns the PARTITIONED defaults when no config row exists — cleaning/WiFi owner, TNB/AIR still tenant", () => {
    const dto = toBearerConfigDto(null, "PARTITIONED");
    expect(dto.cleaningBearer).toBe("owner");
    expect(dto.wifiBearer).toBe("owner");
    expect(dto.tnbPattern).toBe("recharged");
    expect(dto.airPattern).toBe("recharged");
    expect(dto.maintenanceFeeBearer).toBe("owner");
  });

  // The nature gate is INDEPENDENT of the bearer defaults: seeding a bearer must never
  // seed a nature. An undecided nature is what makes the Bill fail closed instead of
  // silently booking a scalar as manager profit, in BOTH modes.
  it("seeds no nature in either mode — a bearer default is not a nature decision", () => {
    for (const mode of ["WHOLE", "PARTITIONED"]) {
      const dto = toBearerConfigDto(null, mode);
      expect(dto.cleaningNature).toBeNull();
      expect(dto.wifiNature).toBeNull();
    }
  });

  // An unrecognised mode must not throw and takes the same owner-only defaults.
  it("falls back to WHOLE for an unresolved listing mode", () => {
    expect(toBearerConfigDto(null, "").cleaningBearer).toBe("owner");
  });

  it("carries the caller's governance overlay through, for EVERY scalar kind", () => {
    const gov = {
      CLEANING: { governed: true, amount: "120.00", definitionId: "def-1" },
      WIFI: { governed: false, amount: null, definitionId: null },
      TNB: { governed: true, amount: "200.00", definitionId: "def-1" },
      AIR: { governed: false, amount: null, definitionId: null },
      MAINTENANCE: { governed: false, amount: null, definitionId: null },
    };
    const dto = toBearerConfigDto(null, "WHOLE", gov);
    // Legacy projections still work…
    expect(dto.cleaningGoverned).toBe(true);
    expect(dto.wifiGoverned).toBe(false);
    // …and the full per-kind record (tick + amount) reaches the drawer.
    expect(dto.scalarRecurring.CLEANING).toEqual({ governed: true, amount: "120.00", definitionId: "def-1" });
    expect(dto.scalarRecurring.TNB).toEqual({ governed: true, amount: "200.00", definitionId: "def-1" });
    expect(dto.scalarRecurring.MAINTENANCE).toEqual({ governed: false, amount: null, definitionId: null });
  });

  // A SAVED config always wins over the unit-type default — passed "PARTITIONED" here
  // deliberately, with tenant-borne cleaning/WiFi stored: an admin's explicit choice must
  // never be re-defaulted by the unit's listing mode. This is what keeps the change
  // non-retroactive for every unit that has already been configured.
  it("a present config passes through, with cleaningRecurringAmount toFixed(2)", () => {
    const dto = toBearerConfigDto({
      tnbPattern: "absorbed",
      airPattern: "tenant_direct",
      cleaningBearer: "tenant",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "tenant",
      cleaningRecurringAmount: new Prisma.Decimal("120"),
      isLocked: true,
      cleaningNature: "profit",
      wifiNature: "expense",
    }, "PARTITIONED");
    expect(dto).toEqual({
      tnbPattern: "absorbed",
      airPattern: "tenant_direct",
      cleaningBearer: "tenant",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "tenant",
      cleaningRecurringAmount: "120.00",
      isLocked: true,
      cleaningNature: "profit",
      wifiNature: "expense",
      cleaningGoverned: false,
      wifiGoverned: false,
      scalarRecurring: {
        CLEANING: { governed: false, amount: null, definitionId: null },
        WIFI: { governed: false, amount: null, definitionId: null },
        TNB: { governed: false, amount: null, definitionId: null },
        AIR: { governed: false, amount: null, definitionId: null },
        MAINTENANCE: { governed: false, amount: null, definitionId: null },
      },
    });
  });

  // The MIRROR of the test above, and the one that matters most in practice: a WHOLE
  // unit whose admin deliberately chose OWNER for cleaning and WiFi — "it's a default,
  // not a must; sometimes a whole unit is owner too". The listing-mode default for WHOLE
  // is TENANT, so if the default were ever applied on top of a stored config this is the
  // exact case that would silently flip an owner-borne cost onto the tenant.
  it("a WHOLE unit explicitly set to OWNER stays OWNER — the tenant default never overrides a stored choice", () => {
    const dto = toBearerConfigDto({
      tnbPattern: "absorbed",       // TNB pushed back to owner-absorbed
      airPattern: "absorbed",       // water too
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: new Prisma.Decimal("100"),
      isLocked: true,
      cleaningNature: null,
      wifiNature: null,
    }, "WHOLE");
    expect(dto.cleaningBearer).toBe("owner");
    expect(dto.wifiBearer).toBe("owner");
    expect(dto.tnbPattern).toBe("absorbed");
    expect(dto.airPattern).toBe("absorbed");
  });

  // …and the reverse for a partition unit: PARTITIONED defaults cleaning/WiFi to OWNER,
  // so an admin who chose TENANT must keep it. Both directions must be free.
  it("a PARTITIONED unit explicitly set to TENANT stays TENANT", () => {
    const dto = toBearerConfigDto({
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "tenant",
      wifiBearer: "tenant",
      maintenanceFeeBearer: "tenant",
      cleaningRecurringAmount: new Prisma.Decimal("100"),
      isLocked: true,
      cleaningNature: null,
      wifiNature: null,
    }, "PARTITIONED");
    expect(dto.cleaningBearer).toBe("tenant");
    expect(dto.wifiBearer).toBe("tenant");
    expect(dto.maintenanceFeeBearer).toBe("tenant");
  });

  it("normalises an ABSENT nature (pre-migration row) to null, never to a nature", () => {
    const dto = toBearerConfigDto({
      tnbPattern: "recharged",
      airPattern: "recharged",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: new Prisma.Decimal("100"),
      isLocked: false,
    }, "WHOLE");
    expect(dto.cleaningNature).toBeNull();
    expect(dto.wifiNature).toBeNull();
  });
});

describe("toGridRowDto", () => {
  // Default (non-integration) suite: @kason/db is aliased to the DB-free mock
  // (db = {}), so `entry: null` (subRowsFor short-circuits before touching
  // prisma) and `priors: []` (priorStripsFor's loop never runs) keep this a
  // TRUE pure-mapper test with zero real DB calls.
  it("emits both the property display name and business short form from the apartment's property relation", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "WHOLE" },
      [],
      null,
      null,
      null,
      [],
      [],
      null,
    );
    expect(dto.propertyName).toBe("Sunway Vista");
    expect(dto.propertyCode).toBe("SV");
    expect(dto.propertyId).toBe("prop1");
    expect(dto.unitCode).toBe("A-1-1");
    // Task 8: an unsaved (entry: null) row is never invoiced and never paid.
    expect(dto.invoicedAt).toBeNull();
    expect(dto.hasPaidInvoice).toBe(false);
    expect(dto.pendingTenancyCharges).toEqual([]);
    expect(dto.billUtilityPlan).toEqual({
      status: "not_applicable",
      mode: null,
      subsidyPerPax: "0.00",
      subsidyPolicy: null,
      tnbSubsidyCap: null,
      tnbSubsidyBreakdown: null,
      lines: [],
      blockedTenancyIds: [],
      errorCode: null,
    });
  });

  // The fix: a unit shows its real rooms + tenant names IMMEDIATELY, before any
  // meter reading is keyed. entry:null (never Saved) → no readings → subRowsFor
  // resolves purely from the batch-loaded rooms, touching no DB (mock db = {}).
  it("surfaces the apartment's real rooms as sub-rows with tenant names + rate/rental even with no readings saved", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "PARTITIONED" },
      [
        { listingId: "L1", tenancyId: "T1", partyName: "Ali bin Ahmad", partyPhone: "012-3456789", ratePerKwh: "0.5500", rateConfigured: true, rental: "1800.00", numberOfPax: null },
        { listingId: "L2", tenancyId: null, partyName: null, partyPhone: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, numberOfPax: null }, // vacant room
      ],
      null, // entry: apartment-month never Saved
      null,
      null,
      [],
      [],
      null,
    );
    // P5: real rooms with no reading ⇒ updatedAt/lastEditedByName both null. Tenant phone passes through.
    expect(dto.subRows).toEqual([
      { listingId: "L1", tenancyId: "T1", partyId: null, partyName: "Ali bin Ahmad", partyPhone: "012-3456789", tenancyEndDate: null, renewalDecision: null, previousKwh: null, currentKwh: null, amount: null, ratePerKwh: "0.5500", rateConfigured: true, rental: "1800.00", rentalBillingState: null, deposit: null, depositBillingState: null, updatedAt: null, lastEditedByName: null, numberOfPax: null },
      { listingId: "L2", tenancyId: null, partyId: null, partyName: null, partyPhone: null, tenancyEndDate: null, renewalDecision: null, previousKwh: null, currentKwh: null, amount: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, rentalBillingState: null, deposit: null, depositBillingState: null, updatedAt: null, lastEditedByName: null, numberOfPax: null },
    ]);
  });

  // Billing contacts: the unit owner's NAME rides on the row (display + search). Owner phone
  // is intentionally not surfaced.
  it("surfaces the owner name on the row when resolved, null otherwise", async () => {
    const apt = { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "PARTITIONED" };
    const withOwner = await toGridRowDto(
      "org1", apt, [], null, null, null, [], [], null,
      undefined, undefined, undefined, undefined, undefined,
      { name: "Tan Ah Kow" },
    );
    expect(withOwner.ownerName).toBe("Tan Ah Kow");

    const noOwner = await toGridRowDto("org1", apt, [], null, null, null, [], [], null);
    expect(noOwner.ownerName).toBeNull();
  });

  // (Task 5) GridRowDto.isWholeUnit — the FE grain-lock's replacement signal now
  // that entry.rental is gone: apt.listingMode === "WHOLE".
  it("(Task 5) isWholeUnit is true when apt.listingMode is WHOLE", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "WHOLE" },
      [],
      null,
      null,
      null,
      [],
      [],
      null,
    );
    expect(dto.isWholeUnit).toBe(true);
  });

  it("(Task 5) isWholeUnit is false when apt.listingMode is PARTITIONED", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "PARTITIONED" },
      [],
      null,
      null,
      null,
      [],
      [],
      null,
    );
    expect(dto.isWholeUnit).toBe(false);
  });

  // (Task 5, B17) an apartment with ZERO listings: isWholeUnit still computed
  // correctly from listingMode alone (independent of room count), subRows is an
  // empty array, and toGridRowDto does not throw.
  it("(Task 5) an apartment with zero listings still computes isWholeUnit and yields empty subRows, no crash", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "WHOLE" },
      [], // zero rooms
      null,
      null,
      null,
      [],
      [],
      null,
    );
    expect(dto.isWholeUnit).toBe(true);
    expect(dto.subRows).toEqual([]);
  });

  // (Task 5, B9) orphan-reading rows (a reading whose listingId is not among the
  // apartment's current rooms) default their new fields — never inherit a real
  // room's rate/rental by accident.
  it("(Task 5) an orphan-reading sub-row defaults ratePerKwh/rateConfigured/rental (no batched room to draw from)", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "PARTITIONED" },
      [], // no current rooms — the reading below is an orphan
      {
        id: "entry1",
        cleaning: null,
        tnbTotalRaw: null,
        airSelangorRaw: null,
        wifi: null,
        maintenanceFee: null,
        readingDate: null,
        paymentStatus: "unpaid",
        tnbPattern: "recharged",
        airPattern: "recharged",
        cleaningBearer: "owner",
        wifiBearer: "owner",
        maintenanceFeeBearer: "owner",
        updatedAt: new Date("2026-07-05T10:00:00.000Z"),
        billedAt: null,
        readings: [
          { id: "r1", listingId: "L-ORPHAN", tenancyId: null, partyId: null, previousKwh: null, currentKwh: null, amount: null } as never,
        ],
        expenses: [],
        attachments: [],
      } as never,
      null,
      null,
      [],
      [],
      null,
    );
    // P5: this orphan-reading fixture carries no updatedAt/updatedById ⇒ both null.
    expect(dto.subRows).toEqual([
      { listingId: "L-ORPHAN", tenancyId: null, partyId: null, partyName: null, partyPhone: null, tenancyEndDate: null, renewalDecision: null, previousKwh: null, currentKwh: null, amount: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, rentalBillingState: null, deposit: null, depositBillingState: null, updatedAt: null, lastEditedByName: null, numberOfPax: null },
    ]);
  });

  // PAX-per-room: each room's sub-row surfaces its active tenancy's numberOfPax
  // so the bills-grid Setting drawer can show + edit per-room pax for partition
  // units (clears the A-13-07 / pax_blocked charge guard). Occupied → tenancy
  // pax; vacant (tenancyId null) → null. Additive read-only field.
  it("(pax-per-room) surfaces each room's numberOfPax on its sub-row — occupied → tenancy pax, vacant → null", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "Sunway Vista", propertyCode: "SV", listingMode: "PARTITIONED" },
      [
        { listingId: "L1", tenancyId: "T1", partyName: "Ali bin Ahmad", partyPhone: "011-2223333", ratePerKwh: "0.5500", rateConfigured: true, rental: "1800.00", numberOfPax: 3 },
        { listingId: "L2", tenancyId: null, partyName: null, partyPhone: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, numberOfPax: null }, // vacant room
      ],
      null,
      null,
      null,
      [],
      [],
      null,
    );
    expect(dto.subRows.find((s) => s.listingId === "L1")!.numberOfPax).toBe(3);
    expect(dto.subRows.find((s) => s.listingId === "L2")!.numberOfPax).toBeNull();
  });

  // Review Finding 1 (money-correctness): the sub-row's numberOfPax MUST correspond to the
  // SAME tenancy as its (resolved) tenancyId — the one the bill uses and the drawer writes to.
  // When a reading pins a DIFFERENT tenancy than the room's active one (mid-period turnover
  // before re-keying), tenancyId resolves to the reading snapshot, so numberOfPax must NOT be
  // the active tenancy's pax (that would make the pax editor display one tenancy's value while
  // writing to another). It resolves to null here (the snapshot tenancy's pax is unknown at
  // this layer) — never the active tenancy's headcount.
  it("(pax-per-room, Finding 1) a room whose reading snapshots a DIFFERENT tenancy reports numberOfPax null, not the active tenancy's pax", async () => {
    const dto = await toGridRowDto(
      "org1",
      { id: "apt1", unitCode: "A-1-1", propertyId: "prop1", propertyName: "PV", propertyCode: "PV", listingMode: "PARTITIONED" },
      [{ listingId: "L1", tenancyId: "T-ACTIVE", partyName: "New Tenant", partyPhone: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, numberOfPax: 5 }],
      {
        id: "entry1", cleaning: null, tnbTotalRaw: null, airSelangorRaw: null, wifi: null, maintenanceFee: null,
        readingDate: null, paymentStatus: "unpaid", tnbPattern: "recharged", airPattern: "recharged",
        cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
        updatedAt: new Date("2026-07-05T10:00:00.000Z"), billedAt: null,
        readings: [{ id: "r1", listingId: "L1", tenancyId: "T-SNAPSHOT", partyId: null, previousKwh: null, currentKwh: null, amount: null } as never],
        expenses: [], attachments: [],
      } as never,
      null,
      null,
      [],
      [],
      null,
    );
    const sub = dto.subRows.find((s) => s.listingId === "L1")!;
    expect(sub.tenancyId).toBe("T-SNAPSHOT"); // reading snapshot wins (the tenancy billed + written to)
    expect(sub.numberOfPax).toBeNull(); // NOT 5 — never the active tenancy's pax against the snapshot tenancy
  });
});

describe("toAttachmentBriefs", () => {
  it("maps {id, filename} and drops every other column", () => {
    const briefs = toAttachmentBriefs([
      { id: "att1", filename: "tnb-bill.pdf", contentType: "application/pdf", sizeBytes: 1234, storageKey: "k1", uploadedBy: "u1", createdAt: new Date() },
      { id: "att2", filename: "water-bill.pdf", contentType: "application/pdf", sizeBytes: 999, storageKey: "k2", uploadedBy: "u1", createdAt: new Date() },
    ] as never);
    expect(briefs).toEqual([
      { id: "att1", filename: "tnb-bill.pdf" },
      { id: "att2", filename: "water-bill.pdf" },
    ]);
  });

  it("an empty array maps to an empty array", () => {
    expect(toAttachmentBriefs([])).toEqual([]);
  });
});
