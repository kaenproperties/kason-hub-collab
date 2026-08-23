// Owner-Billing (M6) — shared Zod input schemas + constant sets.
// Plan: docs/superpowers/plans/2026-06-11-phase2-owner-billing.md (Task A1).
//
// Consumed by the API owner-billing module and the pure finance functions.
// Pure shared package: NO DB, NO API, NO money math here — schemas + constants only.
// Money/percent values travel as 2-dp decimal STRINGS to avoid float drift; the
// deterministic cent math lives in the finance helpers (Tasks B1/B2).

import { z } from "zod";

export const FEE_TYPES = ["percent", "fixed", "cap"] as const;
export const OWNER_STATEMENT_TYPE = "owner_statement" as const;
// Charge types that may appear on an owner statement (admin-entered amounts +
// the cleaning auto-bill). "management_fee" is the SST-bearing line; the rest
// are pass-through expenses with no SST.
export const OWNER_CHARGE_TYPES = [
  "management_fee",
  "cleaning",
  "tnb",
  "water",
  "wifi",
  "maintenance",
  "insurance",
  "assessment_tax",
  "sewerage",
  "cukai_petak",
  "access_card",
  "other",
] as const;

export type FeeType = (typeof FEE_TYPES)[number];
export type OwnerChargeType = (typeof OWNER_CHARGE_TYPES)[number];

// A NON-NEGATIVE money/percent value with at most 2 decimal places (e.g. "200.00", "7.5").
// Every field these schemas guard — feeValue, capAmount, sstPercent, and the
// admin-entered statement amounts — is >= 0 by domain, so no leading minus is
// allowed. The only signed value (the computed net-remittance total) lives in B2/B3 and does
// NOT flow through these input validators.
const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, "expected a non-negative money/percent value");

// Base object shape (pre-refine). Kept separate because Zod 4 forbids
// `.partial()` on a schema that already carries a `.refine()` — the PATCH
// variant derives from this raw object so it stays a plain ZodObject.
const managementFeeConfigShape = z.object({
  ownerPartyId: z.string().uuid(),
  propertyId: z.string().uuid().nullable().optional(), // null = all the owner's properties
  apartmentId: z.string().uuid().nullable().optional(), // unit override; null = property/owner default
  feeType: z.enum(FEE_TYPES),
  feeValue: decimalString, // % when percent/cap, RM when fixed
  capAmount: decimalString.nullable().optional(),
  sstPercent: decimalString.default("8"),
  freePeriodStart: z.string().datetime().nullable().optional(),
  freePeriodEnd: z.string().datetime().nullable().optional(),
  firstChargeMonth: z.string().datetime().nullable().optional(),
  firstChargeBaseAmount: decimalString.nullable().optional(),
  paxDeductionPerPerson: decimalString.nullable().optional(),
  isActive: z.boolean().default(true),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
});

export const managementFeeConfigInput = managementFeeConfigShape.refine(
  (v) => v.feeType !== "cap" || v.capAmount != null,
  {
    message: "capAmount is required when feeType is 'cap'",
    path: ["capAmount"],
  },
);

export const managementFeeConfigPatch = managementFeeConfigShape.partial().extend({
  expectedUpdatedAt: z.string().datetime(), // optimistic concurrency
});

// TWO statement types, distinguished by `apartmentId`:
//   • ABSENT ⇒ the combined "All Units" statement — exactly ONE
//     Invoice(invoiceType='owner_statement', apartmentId=null) per owner per month,
//     covering ALL the owner's units (no partial subset selection).
//   • PRESENT (a valid uuid) ⇒ a per-unit statement scoped to that ONE apartment —
//     an admin/accountant per-unit accounting view (incl. ad-hoc extra charges).
//     Generated explicitly per unit (never auto-spawned) and kept OFF the owner
//     portal, so it can coexist with the combined statement without duplicating it.
// `.strict()` still rejects any OTHER unknown key.
export const generateStatementInput = z
  .object({
    ownerPartyId: z.string().uuid(),
    billingMonth: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
    apartmentId: z.string().uuid().optional(),
  })
  .strict();

// Optional paid-on-behalf metadata (Task 9) — DISPLAY-ONLY. When KAEN settles an
// owner expense (e.g. fire insurance) on the owner's behalf, the admin may record
// who was paid (payeeName), a supplier reference (paidOnBehalfRef), and the payment
// date (paidOnBehalfDate, a calendar date → @db.Date). These are documentation only:
// they NEVER affect the payout math (the expense already deducts via the line/adjust
// amount). Empty string ⇒ omitted (the form sends "" for blank fields).
const paidOnBehalfDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");

export const statementLineInput = z.object({
  chargeType: z.enum(OWNER_CHARGE_TYPES),
  description: z.string().min(1).max(200),
  amount: decimalString,
  payeeName: z.string().min(1).max(200).optional(),
  paidOnBehalfRef: z.string().min(1).max(200).optional(),
  paidOnBehalfDate: paidOnBehalfDateString.optional(),
});

export const statementLinePatch = z
  .object({
    amount: decimalString.optional(),
    description: z.string().min(1).max(200).optional(),
    expectedUpdatedAt: z.string().datetime(),
  })
  // A no-op PATCH carrying only expectedUpdatedAt would still bump Charge.updatedAt
  // (the guarded updateMany) and write an audit row with an empty before/after diff.
  // Require at least one mutable field so a PATCH always represents a real change.
  .refine((v) => v.amount !== undefined || v.description !== undefined, {
    message: "at least one of amount or description is required",
    path: ["amount"],
  });

// `cleaningBillInput` was REMOVED here (2026-08-17) with the owner-settings cleaning
// auto-bill and its manual POST/PATCH/void endpoints. The bills grid is the single
// cleaning issuer: bearer in the unit Setting drawer, amount in the Recurring editor.

export type ManagementFeeConfigInput = z.infer<typeof managementFeeConfigInput>;
export type GenerateStatementInput = z.infer<typeof generateStatementInput>;
