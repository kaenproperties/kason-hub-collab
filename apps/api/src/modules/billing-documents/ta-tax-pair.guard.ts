import type { Prisma } from "@kason/db";

const PAIRED_TA_CHARGE_TYPES = new Set(["tenancy_agreement_fee", "renewal_fee"]);

/**
 * True only for the new gross-inclusive TA / renewal representation:
 *
 *   base (tenancy_agreement_fee | renewal_fee)
 *     -> exact child `${base.chargeNumber}-SST`
 *
 * The lookup accepts either member of the pair.  Deliberately do not infer a
 * pair from chargeType, parentChargeId, or an `-SST` suffix alone: legacy TA
 * charges are single-line receivables and must remain correctable.
 */
export async function isExactTaTaxPairCharge(
  tx: Prisma.TransactionClient,
  organizationId: string,
  chargeId: string,
): Promise<boolean> {
  const requested = await tx.charge.findFirst({
    where: { id: chargeId, organizationId },
    select: { id: true, chargeNumber: true, chargeType: true, parentChargeId: true },
  });
  if (!requested) return false;

  // The requested charge is the exact SST child of a qualifying TA base.
  if (requested.parentChargeId) {
    const parent = await tx.charge.findFirst({
      where: { id: requested.parentChargeId, organizationId },
      select: { id: true, chargeNumber: true, chargeType: true },
    });
    if (
      parent &&
      PAIRED_TA_CHARGE_TYPES.has(parent.chargeType) &&
      requested.chargeNumber === `${parent.chargeNumber}-SST`
    ) {
      return true;
    }
  }

  // The requested charge is a qualifying base with its exact linked SST child.
  if (!PAIRED_TA_CHARGE_TYPES.has(requested.chargeType)) return false;
  const child = await tx.charge.findFirst({
    where: {
      organizationId,
      parentChargeId: requested.id,
      chargeNumber: `${requested.chargeNumber}-SST`,
    },
    select: { id: true },
  });
  return child !== null;
}
