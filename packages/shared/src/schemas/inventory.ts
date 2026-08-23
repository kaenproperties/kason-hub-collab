import { z } from "zod";
import { COMMISSION_SST_BEARER, PROPERTY_STATUSES } from "../constants/statuses";
import { partitionBillingModeSchema } from "./utility-billing-config";

export const createPropertySchema = z.object({
  name: z.string().min(1),
  propertyCode: z.string().min(1),
  propertyType: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().min(1),
});

// Portal property submission — same input shape as admin, but the server
// forces sourceFlag=AGENT_SOURCED + sourcingApproved=false + status=pending
// regardless of what's in the body. Server-controlled fields are NOT in this
// schema so a hostile client can't smuggle them in.
export const createPortalPropertySchema = createPropertySchema;
export type CreatePortalPropertyInput = z.infer<typeof createPortalPropertySchema>;

// Portal property submission amendment — same column set as the admin
// update path, but no `propertyId` (URL carries the submission id) and no
// `status` (resubmit forces submissionState back to "pending" server-side).
export const updatePortalPropertySchema = z.object({
  propertyCode: z.string().min(1).max(64),
  proposedName: z.string().min(1).max(255),
  propertyType: z.string().min(1).max(64),
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).nullish(),
  city: z.string().min(1).max(128),
  state: z.string().max(128).nullish(),
  postalCode: z.string().max(32).nullish(),
  country: z.string().min(1).max(128),
});
export type UpdatePortalPropertyInput = z.infer<typeof updatePortalPropertySchema>;

export const updatePropertySchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().min(1).optional(),
  propertyCode: z.string().min(1).optional(),
  propertyType: z.string().min(1).optional(),
  addressLine1: z.string().min(1).optional(),
  // Optional secondary address line — Property table allows null. We accept
  // an empty string from the form and forward it to the repo so it can be
  // stored as-is (the repo's writer normalizes "" → null where appropriate).
  addressLine2: z.string().optional(),
  city: z.string().min(1).optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().min(1).optional(),
  // Admin can flip status directly (e.g. activating an agent-submitted
  // property without going through the source queue). Server-side only —
  // portal callers do not have access to PUT /properties/:id.
  status: z.enum(PROPERTY_STATUSES).optional(),
});

// Shared field set used by both create + update unit. Keeping it in one place
// so the dialog UI and the repository writer agree on the column list.
const unitWritableFields = {
  unitCode: z.string().min(1).optional(),
  unitType: z.string().min(1).optional(),
  bedrooms: z.coerce.number().int().min(0).optional(),
  bathrooms: z.coerce.number().min(0).optional(),
  rentalRate: z.coerce.number().nonnegative().optional(),
  floor: z.coerce.number().int().optional(),
  floorArea: z.coerce.number().nonnegative().optional(),
  occupancyStatus: z.string().min(1).optional(),
  listingStatus: z.string().min(1).optional(),
  // Owner of the unit — the property owner who receives the management
  // statement. Nullable so admin can CLEAR the owner (e.g. unit sold or
  // reassigned). Optional so a PATCH that touches only rentalRate doesn't
  // have to resend the owner. UUID validated to prevent stale/malformed IDs
  // from reaching the DB foreign key.
  ownerPartyId: z.string().uuid().nullable().optional(),
  inChargePartyId: z.string().uuid().nullable().optional(),
  // Agent who *sourced* the listing — distinct from inChargePartyId (the agent
  // who runs day-to-day on the unit). Drives the "Agent sourced" badge in
  // the inventory explorer (badge gates on `sourcingAgentId != null`). Admin
  // can assign / clear via the edit dialog; the portal variant omits this
  // because the server forces it = session.partyId for agent-uploaded units.
  sourcingAgentId: z.string().uuid().nullable().optional(),
  sourceFlag: z.enum(["COMPANY", "AGENT_SOURCED"]).optional(),
  visibilityMode: z.enum(["PUBLIC", "RESTRICTED"]).optional(),
  // PUBLIC mode: blocklist — units are visible to every agent EXCEPT the
  // ones in this array. Service ignores this field when the unit is
  // RESTRICTED (since the visibility check uses grants instead).
  hiddenFromPartyIds: z.array(z.string().uuid()).optional(),
  // RESTRICTED mode: allowlist — units are visible only to agents in this
  // array (sync'd into ListingVisibilityGrant). Service ignores this field
  // when the unit is PUBLIC (since the visibility check uses
  // hiddenFromPartyIds instead). Replace-set semantics on update.
  grantedPartyIds: z.array(z.string().uuid()).optional(),
  amenities: z.array(z.string().min(1)).optional(),
  // Free-form per-apartment selling points ("Near KLCC", "Corner unit").
  // Apartment-scoped (parallel to amenities); UI never exposes per-room.
  // Per-tag 60 chars, max 10 per apartment. Server dedupes defensively —
  // TagInput already dedupes, but a hostile client could bypass it.
  highlights: z
    .array(z.string().trim().min(1).max(60))
    .max(10)
    .transform((arr) => Array.from(new Set(arr)))
    .optional(),
  description: z.string().nullable().optional(),
  // Pax deduction lives on the parent Property record, not the Unit, but we
  // accept it on the Unit dialog so admins don't have to bounce between two
  // forms. The service layer routes these two fields to a Property update.
  hasPaxDeduction: z.boolean().optional(),
  paxDeductionAmount: z.coerce.number().nonnegative().nullable().optional(),
  // Deposits — depositMonths and utilitiesDepositMonths are required on
  // every CREATE form (see requiredDepositMonths / requiredUtilitiesDepositMonths
  // below, used by createUnitObjectSchema and batchRoomFields). They remain
  // .optional() here because this `unitWritableFields` block is reused by
  // `updateUnitObjectSchema` via spread, and a PATCH that touches only e.g.
  // `rentalRate` must not be forced to resend deposit values.
  // Decimal — the DB column is DECIMAL(4,2), matching utilitiesDepositMonths.
  // Half-month deposits (0.5, 1.5, 2.5) are valid; rounding here would silently
  // re-introduce the bug the user-facing form's step=0.5 input promises to fix.
  depositMonths: z.coerce.number().nonnegative().max(12).optional(),
  utilitiesDepositMonths: z.coerce.number().nonnegative().max(12).optional(),
  accessCardDepositPerPcs: z.coerce.number().nonnegative().max(10_000).optional(),
  accessCardQuantity: z.coerce.number().int().nonnegative().max(20).optional(),
  // Parking — quantity sets count, numbers is the aligned identifier list.
  parkingQuantity: z.coerce.number().int().nonnegative().max(20).optional(),
  parkingNumbers: z.array(z.string().max(40)).max(20).optional(),
  // Occupancy stub fields. Required only when occupancyStatus is being
  // set to "occupied" — enforced by occupancyTenancyRefiner below. The
  // backend uses these to materialize a Tenancy row via syncOccupancyTenancy.
  // Date fields accept ISO date strings; the API coerces with new Date().
  // PICK-EXISTING tenant link. Required (alongside the dates) when the
  // occupancy trio is being edited to "occupied" — see occupancyTenancyRefiner.
  // The backend links this party to the materialized Tenancy (no auto-create).
  tenantPartyId: z.string().uuid().optional(),
  // Retained for back-compat (older clients / import). No longer required when
  // occupied — the picker sends tenantPartyId instead. Ignored on the link path.
  tenantName: z.string().max(200).optional(),
  moveInDate: z.string().date().optional(),
  moveOutDate: z.string().date().optional(),
  // Explicit monthly rent for a NEW tenancy materialised via the occupancy
  // picker. Under ENABLE_PHASE2_RESERVATION_GATED_TENANCY, syncOccupancyTenancy
  // requires this to be a positive number instead of silently defaulting to
  // the unit's rentalRate (see occupancy-tenancy-sync.ts). `.nonnegative()`
  // (not `.positive()`) deliberately allows 0/undefined through this schema so
  // the service layer -- not zod -- is the one that rejects <= 0 with a clean
  // OCCUPANCY_RENT_REQUIRED error. Flag off: ignored.
  monthlyRent: z.coerce.number().nonnegative().optional(),
  tenancyAgreementFeeAmount: z.coerce.number().nonnegative().optional(),
  tenancyAgreementFeeDueDate: z.string().date().optional(),
  // First-month-rent-as-KAEN-commission (Phase 1, display-only). Same shape as
  // createTenancySchema (tenancy.ts:111-112); optional so a PATCH touching only
  // e.g. rentalRate need not resend them. Persisted onto the Tenancy that
  // syncOccupancyTenancy creates/updates. Reused explicitly by
  // createUnitObjectSchema + adminBatchRoomFields (which do NOT spread this block).
  firstMonthIsCommission: z.boolean().optional(),
  commissionSstBearer: z.enum(COMMISSION_SST_BEARER).optional(),
} as const;

// Required-on-create versions of the deposit-months fields. Mandated by the
// inventory form spec — every new unit must declare both deposits up front
// (no hidden zeros / silent defaults). The .min(0) lower bound matches the
// unitWritableFields version so half-month deposits (0.5, 1.5) stay valid.
const requiredDepositMonths = z.coerce.number().nonnegative().max(12);
const requiredUtilitiesDepositMonths = z.coerce.number().nonnegative().max(12);

// Apartment-level opt-in to the unit-cap TNB subsidy policy. A numeric value
// takes priority over the legacy partition billing mode. `null` defers to that
// mode: SUBSIDY uses organization per-pax; NO_SUBSIDY provides no subsidy.
// Keep the Decimal(12,2) storage bound at the request edge as well.
const tnbSubsidyCapMonthlySchema = z.preprocess(
  // HTML form posts sometimes carry an empty string. It means "no apartment
  // cap", never RM0; normalize it to the explicit legacy-mode sentinel.
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z.coerce
    .number()
    .nonnegative()
    .max(9_999_999_999.99)
    .nullable()
    .refine(
      (value) =>
        value === null ||
        Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
      "Monthly TNB subsidy cap must have no more than 2 decimal places",
    ),
);

// Cross-field check: tenantPartyId/moveInDate/moveOutDate are required when
// occupancyStatus is "occupied" and any trio field is present. tenantName is
// retained for back-compat but is no longer required. moveOutDate must be
// after moveInDate.
const occupancyTenancyRefiner = (
  data: {
    occupancyStatus?: string;
    tenantPartyId?: string;
    tenantName?: string;
    moveInDate?: string;
    moveOutDate?: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (data.occupancyStatus !== "occupied") return;

  // Pass-through when the payload merely mentions occupancyStatus="occupied"
  // without ANY tenancy field (existing-row updates / import paths must not
  // break). The picker always sends tenantPartyId + dates together.
  const anyTrioPresent =
    data.tenantPartyId !== undefined ||
    data.moveInDate !== undefined ||
    data.moveOutDate !== undefined;
  if (!anyTrioPresent) return;

  if (!data.tenantPartyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Select an existing tenant when occupancy is Occupied",
      path: ["tenantPartyId"],
    });
  }
  if (!data.moveInDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Move-in date is required when occupancy is Occupied",
      path: ["moveInDate"],
    });
  }
  if (!data.moveOutDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Move-out date is required when occupancy is Occupied",
      path: ["moveOutDate"],
    });
  }
  if (data.moveInDate && data.moveOutDate && data.moveOutDate <= data.moveInDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Move-out must be after move-in",
      path: ["moveOutDate"],
    });
  }
};

// Cross-field check for parkingQuantity vs parkingNumbers.length. Empty
// parkingNumbers is allowed (uploader skipped numbering); a populated list
// must match the declared quantity exactly.
const parkingLengthRefiner = (
  data: { parkingQuantity?: number; parkingNumbers?: string[] },
  ctx: z.RefinementCtx,
) => {
  if (data.parkingQuantity == null) return;
  if (!data.parkingNumbers || data.parkingNumbers.length === 0) return;
  if (data.parkingNumbers.length !== data.parkingQuantity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "parkingNumbers length must equal parkingQuantity (or be empty)",
      path: ["parkingNumbers"],
    });
  }
};

// Bare object schema for create. Kept separate from `createUnitSchema` so
// the portal variant can `.omit(...).strict()` BEFORE we attach the
// .superRefine — `.omit` is a ZodObject-only API, and chaining
// .superRefine returns a ZodEffects which has no .omit.
const unitManagementFeeConfigSchema = z.object({
  feeType: z.enum(["percent", "fixed", "cap"]),
  feeValue: z.string().regex(/^\d+(\.\d{1,2})?$/),
  capAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  sstPercent: z.literal("8"),
  freePeriodStart: z.string().datetime().nullable().optional(),
  freePeriodEnd: z.string().datetime().nullable().optional(),
  firstChargeMonth: z.string().datetime().nullable().optional(),
  firstChargeBaseAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  paxDeductionPerPerson: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
}).refine((value) => value.feeType !== "cap" || value.capAmount != null, {
  message: "capAmount is required when feeType is 'cap'",
  path: ["capAmount"],
});

const createUnitObjectSchema = z.object({
  propertyId: z.string().uuid(),
  // Required on create only.
  unitCode: z.string().min(1),
  unitType: z.string().min(1),
  bedrooms: unitWritableFields.bedrooms,
  bathrooms: unitWritableFields.bathrooms,
  rentalRate: unitWritableFields.rentalRate,
  floor: unitWritableFields.floor,
  floorArea: unitWritableFields.floorArea,
  occupancyStatus: unitWritableFields.occupancyStatus,
  listingStatus: unitWritableFields.listingStatus,
  inChargePartyId: unitWritableFields.inChargePartyId,
  sourcingAgentId: unitWritableFields.sourcingAgentId,
  sourceFlag: unitWritableFields.sourceFlag,
  visibilityMode: unitWritableFields.visibilityMode,
  hiddenFromPartyIds: unitWritableFields.hiddenFromPartyIds,
  grantedPartyIds: unitWritableFields.grantedPartyIds,
  amenities: unitWritableFields.amenities,
  highlights: unitWritableFields.highlights,
  description: unitWritableFields.description,
  hasPaxDeduction: unitWritableFields.hasPaxDeduction,
  paxDeductionAmount: unitWritableFields.paxDeductionAmount,
  depositMonths: requiredDepositMonths,
  utilitiesDepositMonths: requiredUtilitiesDepositMonths,
  accessCardDepositPerPcs: unitWritableFields.accessCardDepositPerPcs,
  accessCardQuantity: unitWritableFields.accessCardQuantity,
  parkingQuantity: unitWritableFields.parkingQuantity,
  parkingNumbers: unitWritableFields.parkingNumbers,
  tenantPartyId: unitWritableFields.tenantPartyId,
  tenantName: unitWritableFields.tenantName,
  moveInDate: unitWritableFields.moveInDate,
  moveOutDate: unitWritableFields.moveOutDate,
  // Apartment-scoped, admin-only. Absent on the portal variant (agents must
  // never set an owner or a billing model — see createPortalUnitSchema.omit).
  // Optional so every existing caller parses unchanged. Non-nullable on create
  // (unlike unitWritableFields.ownerPartyId, which is .nullable() so an UPDATE
  // can CLEAR the owner): on create, "no owner" is expressed by omission.
  ownerPartyId: z.string().uuid().optional(),
  partitionBillingMode: z.enum(["SUBSIDY", "NO_SUBSIDY"]).optional(),
  tnbSubsidyCapMonthly: tnbSubsidyCapMonthlySchema.optional(),
  // Explicit rent for a tenancy materialised at create time. Reuses the same
  // field definition as the update path (unitWritableFields.monthlyRent) so
  // both paths feed syncOccupancyTenancy an identically-shaped value: coerced,
  // .nonnegative() (0 allowed through this schema on purpose), and the SERVICE
  // -- not zod -- rejects <= 0 with a clean OCCUPANCY_RENT_REQUIRED error when
  // ENABLE_PHASE2_RESERVATION_GATED_TENANCY is on. No refiner here by design:
  // packages/shared reads no env, so it cannot flag-gate the requirement.
  monthlyRent: unitWritableFields.monthlyRent,
  tenancyAgreementFeeAmount: unitWritableFields.tenancyAgreementFeeAmount,
  tenancyAgreementFeeDueDate: unitWritableFields.tenancyAgreementFeeDueDate,
  // Commission toggles — createUnitObjectSchema picks fields explicitly (no
  // spread of unitWritableFields), so reuse the same field defs here.
  firstMonthIsCommission: unitWritableFields.firstMonthIsCommission,
  commissionSstBearer: unitWritableFields.commissionSstBearer,
  // Commercial terms are part of the same business action as assigning the
  // owner. Persisting them in the unit-create transaction prevents a managed
  // unit from being created successfully while a second fee-config request
  // fails and leaves the Billing grid permanently at RM0.00.
  managementFeeConfig: unitManagementFeeConfigSchema.optional(),
});

const updateUnitObjectSchema = z.object({
  unitId: z.string().uuid(),
  ...unitWritableFields,
  // Opt-in fan-out on single-unit edit: when true AND any apartment-scoped
  // field (bedrooms/bathrooms/floor/floorArea/amenities/highlights/description)
  // is in the payload, the server propagates those changes to every
  // sibling of this apartment in the same transaction. Closes the "single
  // unit edit re-creates drift" gap (spec §6). Default false → existing
  // single-row PUT behaviour unchanged. Plain optional (no Zod .default()
  // here) so the inferred input type stays compatible with callers that
  // don't pass the flag.
  applyToExistingSiblings: z.boolean().optional(),
});

export const createUnitSchema = createUnitObjectSchema
  .superRefine(parkingLengthRefiner)
  .superRefine(occupancyTenancyRefiner);

export const updateUnitSchema = updateUnitObjectSchema
  .superRefine(parkingLengthRefiner)
  .superRefine(occupancyTenancyRefiner);

// Portal variant of createUnitSchema. Strips fields the agent must NOT
// control directly:
//   - inChargePartyId   (server forces = session.partyId, per spec §3.1)
//   - sourceFlag        (server forces = "AGENT_SOURCED", per spec §3.2)
//   - hiddenFromPartyIds + grantedPartyIds (admin-only visibility ops)
//   - hasPaxDeduction + paxDeductionAmount (Property-scoped, admin only)
// The portal route rejects any payload that includes these fields.
export const createPortalUnitSchema = createUnitObjectSchema
  .omit({
    inChargePartyId: true,
    sourcingAgentId: true,
    sourceFlag: true,
    hiddenFromPartyIds: true,
    grantedPartyIds: true,
    hasPaxDeduction: true,
    paxDeductionAmount: true,
    // Apartment-scoped admin-only fields — an agent must never set an owner, a
    // billing model, or an explicit rent on a unit they upload. .strict() below
    // turns any of these into a rejected unrecognized key.
    ownerPartyId: true,
    partitionBillingMode: true,
    tnbSubsidyCapMonthly: true,
    monthlyRent: true,
    managementFeeConfig: true,
    // Override below — portal accepts EITHER propertyId (existing approved
    // Property) OR propertySubmissionId (agent's own pending property) with
    // XOR refinement.
    propertyId: true,
  })
  .extend({
    propertyId: z.string().uuid().optional(),
    // Agent attaches a unit submission to their own pending property — the
    // approval cascade rewrites these child rows to the real propertyId
    // when admin approves the property.
    propertySubmissionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasProperty = !!data.propertyId;
    const hasSubmission = !!data.propertySubmissionId;
    if (hasProperty === hasSubmission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of propertyId (approved property) or propertySubmissionId (own pending property).",
        path: ["propertyId"],
      });
    }
  })
  .superRefine(parkingLengthRefiner)
  .superRefine(occupancyTenancyRefiner);

// Portal variant of updateUnitSchema. Same fields stripped + unitId
// retained so the route can target the row by id.
// Strips `applyToExistingSiblings` — portal fan-out goes exclusively
// through the batch endpoint (which has the ownership gate). If we ever
// expose single-unit fan-out to the portal, mirror the gate here.
export const updatePortalUnitSchema = updateUnitObjectSchema
  .omit({
    inChargePartyId: true,
    sourcingAgentId: true,
    ownerPartyId: true,
    sourceFlag: true,
    applyToExistingSiblings: true,
    hiddenFromPartyIds: true,
    grantedPartyIds: true,
    hasPaxDeduction: true,
    paxDeductionAmount: true,
  })
  .strict()
  .superRefine(parkingLengthRefiner)
  .superRefine(occupancyTenancyRefiner);

// Multi-room batch submission. A single apartment ("B-08-08" at Sunway
// Artessa) often gets sub-let as multiple rooms (Master / Medium / Single)
// — each is its own Unit row sharing propertyId + unitCode but differing
// on unitType. Lets the agent fill the shared metadata ONCE and add N
// rooms in one submission. Server creates all N rows atomically — partial
// success would leave the agent's portfolio half-uploaded.
const batchSharedFields = z.object({
  propertyId: z.string().uuid(),
  unitCode: z.string().min(1),
  floor: unitWritableFields.floor,
  bedrooms: unitWritableFields.bedrooms,
  bathrooms: unitWritableFields.bathrooms,
  floorArea: unitWritableFields.floorArea,
  amenities: unitWritableFields.amenities,
  highlights: unitWritableFields.highlights,
  description: unitWritableFields.description,
});

// Cross-field check shared by both batch schemas: at least one room must
// be added, OR the caller must opt into the fan-out path
// (applyToExistingSiblings=true, which targets existing sibling rows).
// Without this, an empty rooms array would be a silent no-op.
const batchRoomsOrFanoutRefiner = (
  data: { rooms: unknown[]; applyToExistingSiblings?: boolean },
  ctx: z.RefinementCtx,
) => {
  if (data.rooms.length === 0 && !data.applyToExistingSiblings) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "rooms must contain at least one entry, or applyToExistingSiblings must be true (apartment-shared-fields-only update)",
      path: ["rooms"],
    });
  }
};

// Bare (pre-refine) per-room object for the multi-room batch. Kept separate
// from `batchRoomFields` / `adminBatchRoomFields` for the SAME reason
// `createUnitObjectSchema` is kept apart from `createUnitSchema` above:
// `.extend()` is a ZodObject-only API, and it is lost the moment
// `.superRefine()` turns the schema into a ZodEffects. The admin batch schema
// needs to `.extend(...)` this bare shape with per-room occupancy BEFORE any
// refiner is attached.
const batchRoomObjectFields = z.object({
  unitType: z.string().min(1),
  rentalRate: unitWritableFields.rentalRate,
  depositMonths: requiredDepositMonths,
  utilitiesDepositMonths: requiredUtilitiesDepositMonths,
  accessCardDepositPerPcs: unitWritableFields.accessCardDepositPerPcs,
  accessCardQuantity: unitWritableFields.accessCardQuantity,
  parkingQuantity: unitWritableFields.parkingQuantity,
  parkingNumbers: unitWritableFields.parkingNumbers,
});

// Portal-safe per-room shape — NO occupancy/tenant fields. Consumed directly
// by `createPortalUnitsBatchSchema` below. Agents may never set a tenant or
// mark a room occupied on a batch submission (mirrors the admin-only
// ownerPartyId/partitionBillingMode split on `batchSharedFields` a few lines
// down) — do NOT add occupancy fields here; add them to
// `adminBatchRoomFields` instead.
const batchRoomFields = batchRoomObjectFields.strict().superRefine(parkingLengthRefiner);

// Admin-only per-room shape (Task T2): adds per-room occupancy so a batch
// create can materialize a Tenancy per occupied room, one row at a time,
// exactly like a single-unit occupied create. Reuses the SAME field
// definitions (unitWritableFields) and the SAME cross-field refiner
// (occupancyTenancyRefiner) as createUnitSchema, so an occupied room in a
// batch submission is validated identically to a single-unit occupied
// create: occupied requires tenantPartyId + moveInDate + moveOutDate, and
// moveOut > moveIn. Consumed ONLY by `createUnitsBatchSchema` (admin) —
// never by the portal batch schema.
const adminBatchRoomFields = batchRoomObjectFields
  .extend({
    occupancyStatus: unitWritableFields.occupancyStatus,
    tenantPartyId: unitWritableFields.tenantPartyId,
    tenantName: unitWritableFields.tenantName,
    moveInDate: unitWritableFields.moveInDate,
    moveOutDate: unitWritableFields.moveOutDate,
    monthlyRent: unitWritableFields.monthlyRent,
    tenancyAgreementFeeAmount: unitWritableFields.tenancyAgreementFeeAmount,
    tenancyAgreementFeeDueDate: unitWritableFields.tenancyAgreementFeeDueDate,
    // Commission toggles per room — adminBatchRoomFields is .strict(), so the
    // keys must be declared here or the batch payload is rejected.
    firstMonthIsCommission: unitWritableFields.firstMonthIsCommission,
    commissionSstBearer: unitWritableFields.commissionSstBearer,
  })
  .strict()
  .superRefine(parkingLengthRefiner)
  .superRefine(occupancyTenancyRefiner);

export const createPortalUnitsBatchSchema = z
  .object({
    shared: batchSharedFields,
    // Cap at 20 to keep one submission bounded — covers any realistic
    // sub-let scenario and gives a generous upper bound for atomic insert.
    // Loosened from .min(1) to .min(0) so the apartment-shared-fields-only
    // update path (applyToExistingSiblings=true with no new rooms) is
    // expressible. The cross-field refiner below rejects rooms=[] unless
    // the caller opts in to fan-out.
    rooms: z.array(batchRoomFields).min(0).max(20),
    // Opt-in flag for the fan-out path: when true, the server updates the
    // shared fields on every existing sibling row of the apartment
    // (matched by propertyId + unitCode). Portal: also enforces that the
    // caller owns every existing sibling (inChargePartyId === session.partyId).
    applyToExistingSiblings: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine(batchRoomsOrFanoutRefiner);

export type CreatePortalUnitsBatchInput = z.infer<
  typeof createPortalUnitsBatchSchema
>;

// Admin variant of the multi-room batch. Same shape as the portal version,
// but the server treats every row as admin-created (sourceFlag="COMPANY",
// sourcingApproved=true) and the schema doesn't strip inChargePartyId —
// admin may set it explicitly per submission. Per-room admin-only fields
// (visibilityMode, grants) are NOT here; advanced overrides happen via the
// per-unit edit dialog after the batch lands.
export const createUnitsBatchSchema = z
  .object({
    shared: batchSharedFields.extend({
      inChargePartyId: unitWritableFields.inChargePartyId,
      // Apartment-scoped, admin-only. Declared HERE (on the admin batch's
      // shared) and NOT on batchSharedFields, so the portal batch schema --
      // which consumes batchSharedFields directly -- never gains them: an agent
      // may never set an apartment's owner or its billing model.
      ownerPartyId: z.string().uuid().optional(),
      partitionBillingMode: z.enum(["SUBSIDY", "NO_SUBSIDY"]).optional(),
      tnbSubsidyCapMonthly: tnbSubsidyCapMonthlySchema.optional(),
      managementFeeConfig: unitManagementFeeConfigSchema.optional(),
    }),
    // Admin-only per-room shape — carries occupancy/tenant fields the portal
    // batch (`createPortalUnitsBatchSchema`, above) deliberately does not.
    rooms: z.array(adminBatchRoomFields).min(0).max(20),
    applyToExistingSiblings: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine(batchRoomsOrFanoutRefiner);

export type CreateUnitsBatchInput = z.infer<typeof createUnitsBatchSchema>;

// Apartment-level shared-field update schema.
// Used by PATCH /api/apartments/:id/shared. All fields are optional —
// the route only writes the keys present in the payload.
export const updateApartmentSharedSchema = z.object({
  bedrooms: z.number().int().min(0).nullable().optional(),
  bathrooms: z.number().min(0).nullable().optional(),
  floorArea: z.number().min(0).nullable().optional(),
  floor: z.number().int().nullable().optional(),
  facing: z.string().nullable().optional(),
  furnishingLevel: z.string().nullable().optional(),
  amenities: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  publishedDescription: z.string().nullable().optional(),
  publishedTitle: z.string().nullable().optional(),
  partitionBillingMode: partitionBillingModeSchema.optional(),
  tnbSubsidyCapMonthly: tnbSubsidyCapMonthlySchema.optional(),
  // Owner of the apartment — propagated to every non-archived sibling listing
  // so a partitioned apartment can never hold two owners. Mirrors the
  // ownerPartyId field at listing level (updateUnitSchema ~line 77).
  ownerPartyId: z.string().uuid().nullable().optional(),
  underManagement: z.boolean().optional(),
});

export type UpdateApartmentSharedInput = z.infer<typeof updateApartmentSharedSchema>;
