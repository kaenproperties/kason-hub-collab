-- TA and renewal-TA form values are final SST-inclusive amounts. The billing
-- document issuer treats a positive rate as tax to add on top of Charge.amount,
-- so these categories must not supply an additional rate.
UPDATE "ChargeCategory"
SET "defaultSstRate" = 0.00
WHERE "code" IN ('tenancy_agreement_fee', 'renewal_fee')
  AND "defaultSstRate" <> 0.00;

-- Correct only mutable, unissued drafts. Issued accounting documents are
-- immutable and must be adjusted through the normal credit/reissue workflow.
UPDATE "Charge" AS charge
SET
  "sstRate" = 0.00,
  "description" = CASE
    WHEN charge."chargeType" = 'tenancy_agreement_fee'
      AND (charge."description" IS NULL OR BTRIM(charge."description") = 'Tenancy agreement fee')
      THEN 'TA (WITH SST)'
    WHEN charge."chargeType" = 'renewal_fee'
      AND (charge."description" IS NULL OR BTRIM(charge."description") = 'Tenancy renewal fee')
      THEN 'Renewal TA (WITH SST)'
    ELSE charge."description"
  END
WHERE charge."chargeType" IN ('tenancy_agreement_fee', 'renewal_fee')
  AND charge."status" = 'draft'
  AND NOT EXISTS (
    SELECT 1
    FROM "BillingDocumentLine" AS line
    WHERE line."chargeId" = charge."id"
  );
