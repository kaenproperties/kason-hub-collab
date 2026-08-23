// Types
export * from "./types/allocation";
export * from "./types/inventory";
export * from "./types/billing";
export * from "./types/parties";
export * from "./types/tenancy";
export * from "./types/communications";

// Schemas
export * from "./schemas/inventory";
export * from "./schemas/billing";
export * from "./schemas/parties";
export * from "./schemas/tenancy";
export * from "./schemas/communications";
export * from "./schemas/portal";
export * from "./schemas/commissions";
export * from "./schemas/level-thresholds";
export * from "./schemas/ta-tiers";
export * from "./schemas/commission-settings";
export * from "./schemas/deal-audit";
export * from "./schemas/existing-claims-on-key";
export * from "./schemas/tenant-tracker";
export * from "./schemas/meter";
export * from "./schemas/utility-billing-config";
export * from "./schemas/auto-draft";
export * from "./schemas/supplier-expense";

// Phone — utilities and Zod schemas (canonical "60XXXXXXXXX")
export {
  normalizeMyPhone,
  isValidMyPhone,
  formatMyPhoneDisplay,
  readPhoneAnyFormat,
} from "./utils/phone";
export { phoneSchema, optionalPhoneSchema } from "./schemas/phone";

// Constants
export * from "./constants/statuses";
export * from "./constants/roles";
export * from "./constants/currencies";
export * from "./constants/payment-enums";

export * from "./deposits";

export * from "./utils/money-cents";
export * from "./billing/adjustment-target-lines";
export * from "./billing/cash-allocation";
export * from "./billing/derive-document-badges";
export * from "./billing/fold-tax-lines";
export * from "./billing/fold-payable-tax-siblings";
export * from "./billing/line-unit-label";
export * from "./billing/note-lifecycle";
export * from "./billing/tenant-visibility";
export * from "./utils/prorate";
export * from "./utils/billing-month";
export * from "./utils/billing-schedule";

export * from "./constants/phase2-flags";
export * from "./constants/ticket-categories";
export * from "./constants/phase2-status-tones";
export * from "./schemas/tasks";
export * from "./schemas/sprints";
export * from "./schemas/owner-billing";
export * from "./finance/owner-billing-fee";
export * from "./finance/inclusive-sst";
export * from "./finance/owner-statement-totals";
export * from "./finance/owner-net-payout";
export * from "./schemas/data-import";
export * from "./schemas/analytics";
export * from "./schemas/owner-ledger";
export * from "./schemas/carpark";
export * from "./schemas/charge-categories";
export * from "./constants/seed-categories";
export * from "./constants/document-classification";
export * from "./constants/series-mapping";
export * from "./constants/scalar-recurring";
export * from "./constants/bill-outcomes";
export * from "./schemas/billing-documents";
export * from "./schemas/bills-grid";
export * from "./schemas/manual-invoice";
export * from "./schemas/owner-remittance";
export * from "./schemas/closed-period";
export * from "./schemas/owner-funding-request";

