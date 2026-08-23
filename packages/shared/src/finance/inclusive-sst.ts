import { centsToString, toCents } from "../utils/money-cents";

export type InclusiveSstSplit = {
  base: string;
  sst: string;
  total: string;
};

/**
 * Split a customer-entered SST-inclusive total into a 2dp base and the exact
 * residual SST.  The residual is derived from the entered total (rather than
 * independently rounded) so base + SST always reconciles to the cash amount.
 *
 * Example: RM500.00 inclusive of 8% SST → RM462.96 + RM37.04.
 */
export function splitInclusiveSst(
  grossAmount: string | number,
  sstRatePercent: string | number,
): InclusiveSstSplit {
  const grossCents = toCents(grossAmount, "splitInclusiveSst.grossAmount");
  const rate = Number(sstRatePercent);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error(`splitInclusiveSst: invalid SST rate "${sstRatePercent}"`);
  }
  if (grossCents < 0) {
    throw new Error("splitInclusiveSst: gross amount must not be negative");
  }

  const baseCents = rate === 0
    ? grossCents
    : Math.round((grossCents * 100) / (100 + rate));
  const sstCents = grossCents - baseCents;

  return {
    base: centsToString(baseCents),
    sst: centsToString(sstCents),
    total: centsToString(grossCents),
  };
}
