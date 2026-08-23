-- Tenancy agreement services (initial and renewal) are always subject to SST.
-- Existing draft charges inherit the corrected category rate when they are
-- issued. Already-issued accounting documents are intentionally not rewritten.
UPDATE "ChargeCategory"
SET "defaultSstRate" = 8.00
WHERE "code" IN ('tenancy_agreement_fee', 'renewal_fee')
  AND "defaultSstRate" <> 8.00;
