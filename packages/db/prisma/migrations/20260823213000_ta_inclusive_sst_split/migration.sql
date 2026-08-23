-- TA / renewal values are entered as a FINAL SST-inclusive total. Preserve that
-- gross receivable while making the accounting split explicit:
--   RM500.00 gross = RM462.96 base Charge + RM37.04 linked SST Charge.
--
-- Only mutable, unpaid, undocumented drafts are converted. Issued documents are
-- immutable and remain for the normal credit/cancel/reissue workflow.

UPDATE "ChargeCategory"
SET "defaultSstRate" = 8.00
WHERE "code" IN ('tenancy_agreement_fee', 'renewal_fee')
  AND "defaultSstRate" <> 8.00;

WITH candidates AS (
  SELECT
    charge.*,
    ROUND(charge."amount" / 1.08, 2) AS "baseAmount",
    charge."amount" - ROUND(charge."amount" / 1.08, 2) AS "taxAmount"
  FROM "Charge" AS charge
  WHERE charge."chargeType" IN ('tenancy_agreement_fee', 'renewal_fee')
    AND charge."status" = 'draft'
    AND charge."parentChargeId" IS NULL
    AND COALESCE(charge."sstRate", 0.00) = 0.00
    AND charge."amount" > 0.00
    AND charge."outstandingAmount" = charge."amount"
    AND charge."invoiceId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Invoice" AS invoice
      WHERE invoice."id" = charge."invoiceId"
        AND invoice."organizationId" = charge."organizationId"
        AND invoice."status" = 'draft'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "BillingDocumentLine" AS line WHERE line."chargeId" = charge."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "PaymentAllocation" AS allocation WHERE allocation."chargeId" = charge."id"
    )
)
INSERT INTO "Charge" (
  "id", "organizationId", "chargeNumber", "tenancyId", "unitId", "categoryId",
  "partyId", "chargeType", "status", "description", "dueDate", "amount",
  "currency", "outstandingAmount", "parentChargeId", "attachmentKeys", "invoiceId",
  "billingMonth", "sstRate", "nature", "fundedBy", "revenueRecognition",
  "settlementRecipient", "taxTreatment", "taxRate", "commercialPurpose",
  "nonBillable", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), candidate."organizationId", candidate."chargeNumber" || '-SST',
  candidate."tenancyId", candidate."unitId", candidate."categoryId", candidate."partyId",
  candidate."chargeType", 'draft',
  COALESCE(candidate."description", 'TA (WITH SST)') || ' — SST 8%',
  candidate."dueDate", candidate."taxAmount", candidate."currency", candidate."taxAmount",
  candidate."id", candidate."attachmentKeys", candidate."invoiceId", candidate."billingMonth",
  0.00, candidate."nature", candidate."fundedBy", candidate."revenueRecognition",
  candidate."settlementRecipient", 'taxable_service', 8.00,
  COALESCE(candidate."commercialPurpose", 'SERVICE'), candidate."nonBillable",
  candidate."createdAt", NOW()
FROM candidates AS candidate
WHERE candidate."taxAmount" > 0.00
ON CONFLICT ("organizationId", "chargeNumber") DO NOTHING;

WITH candidates AS (
  SELECT
    charge."id",
    charge."organizationId",
    charge."chargeNumber",
    charge."amount",
    ROUND(charge."amount" / 1.08, 2) AS "baseAmount"
  FROM "Charge" AS charge
  WHERE charge."chargeType" IN ('tenancy_agreement_fee', 'renewal_fee')
    AND charge."status" = 'draft'
    AND charge."parentChargeId" IS NULL
    AND COALESCE(charge."sstRate", 0.00) = 0.00
    AND charge."amount" > 0.00
    AND charge."outstandingAmount" = charge."amount"
    AND charge."invoiceId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Invoice" AS invoice
      WHERE invoice."id" = charge."invoiceId"
        AND invoice."organizationId" = charge."organizationId"
        AND invoice."status" = 'draft'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "BillingDocumentLine" AS line WHERE line."chargeId" = charge."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "PaymentAllocation" AS allocation WHERE allocation."chargeId" = charge."id"
    )
)
UPDATE "Charge" AS charge
SET
  "amount" = candidate."baseAmount",
  "outstandingAmount" = candidate."baseAmount",
  "sstRate" = 8.00,
  "taxTreatment" = 'taxable_service',
  "taxRate" = 8.00,
  "commercialPurpose" = COALESCE(charge."commercialPurpose", 'SERVICE'),
  "updatedAt" = NOW()
FROM candidates AS candidate
WHERE charge."id" = candidate."id"
  AND EXISTS (
    SELECT 1
    FROM "Charge" AS sibling
    WHERE sibling."organizationId" = candidate."organizationId"
      AND sibling."chargeNumber" = candidate."chargeNumber" || '-SST'
      AND sibling."parentChargeId" = candidate."id"
  );

-- The draft Invoice is a review container. Re-foot it from the now split pair
-- so the displayed total remains exactly the originally entered gross amount.
UPDATE "Invoice" AS invoice
SET "totalAmount" = totals."totalAmount", "updatedAt" = NOW()
FROM (
  SELECT charge."invoiceId", COALESCE(SUM(charge."amount"), 0.00) AS "totalAmount"
  FROM "Charge" AS charge
  WHERE charge."invoiceId" IS NOT NULL AND charge."status" <> 'void'
  GROUP BY charge."invoiceId"
) AS totals
WHERE invoice."id" = totals."invoiceId"
  AND invoice."status" = 'draft'
  AND invoice."invoiceType" IN ('tenant_agreement_fee', 'tenant_renewal');

-- A category default is only a fallback. Historical/unsafe-to-convert single
-- Charges must explicitly remain zero-rated so a later document-heal cannot
-- reinterpret their already-entered gross amount as a base and add another 8%.
-- Issued BillingDocumentLine snapshots remain immutable.
UPDATE "Charge" AS charge
SET "sstRate" = 0.00, "updatedAt" = NOW()
WHERE charge."chargeType" IN ('tenancy_agreement_fee', 'renewal_fee')
  AND charge."parentChargeId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Charge" AS sibling
    WHERE sibling."organizationId" = charge."organizationId"
      AND sibling."parentChargeId" = charge."id"
      AND sibling."chargeNumber" = charge."chargeNumber" || '-SST'
  )
  AND (charge."sstRate" IS NULL OR charge."sstRate" <> 0.00);
