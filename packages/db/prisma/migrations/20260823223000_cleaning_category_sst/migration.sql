-- Cleaning amounts are entered as the pre-SST service amount. Future charges
-- must add 8% SST (RM100 -> RM108). This changes category configuration only;
-- immutable issued document lines and historical charges are not rewritten.
-- WiFi is intentionally excluded because its grid value is the supplier's
-- already-gross pass-through amount.
UPDATE "ChargeCategory"
SET
  "defaultSstRate" = 8,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" IN ('cleaning_owner', 'cleaning_tenant')
  AND "defaultSstRate" IS DISTINCT FROM 8;
