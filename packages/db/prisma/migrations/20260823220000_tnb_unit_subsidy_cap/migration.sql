-- Opt-in apartment-level TNB subsidy cap. Existing apartments remain NULL and
-- therefore defer to their legacy partition billing mode: SUBSIDY uses the
-- organization-level per-pax policy, while NO_SUBSIDY provides no subsidy.
ALTER TABLE "Apartment"
  ADD COLUMN "tnbSubsidyCapMonthly" DECIMAL(12,2);

ALTER TABLE "Apartment"
  ADD CONSTRAINT "Apartment_tnbSubsidyCapMonthly_check"
  CHECK ("tnbSubsidyCapMonthly" IS NULL OR "tnbSubsidyCapMonthly" >= 0);

-- Freeze the effective policy on both utility-bill stores so later apartment
-- configuration changes cannot re-price an already billed period.
ALTER TABLE "UnitUtilityBill"
  ADD COLUMN "subsidyPolicySnapshot" TEXT,
  ADD COLUMN "tnbSubsidyCapSnapshot" DECIMAL(12,2);

ALTER TABLE "UnitBillsGridEntry"
  ADD COLUMN "subsidyPolicySnapshot" TEXT,
  ADD COLUMN "tnbSubsidyCapSnapshot" DECIMAL(12,2);
