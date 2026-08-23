-- Management fees are always taxable at 8% SST.  The optional first-charge
-- fields let an operator record a negotiated/prorated starting month and
-- pre-SST amount while retaining the normal recurring rule for later months.
ALTER TABLE "ManagementFeeConfig"
  ADD COLUMN "firstChargeMonth" DATE,
  ADD COLUMN "firstChargeBaseAmount" DECIMAL(10, 2),
  ADD COLUMN "paxDeductionPerPerson" DECIMAL(10, 2);

UPDATE "ManagementFeeConfig"
SET "sstPercent" = 8.00
WHERE "sstPercent" <> 8.00;
