import type { Prisma } from "@kason/db";
import { describe, expect, it, vi } from "vitest";
import { isExactTaTaxPairCharge } from "../ta-tax-pair.guard";

type Row = {
  id: string;
  organizationId: string;
  chargeNumber: string;
  chargeType: string;
  parentChargeId: string | null;
};

function txWith(rows: Row[]): Prisma.TransactionClient {
  const findFirst = vi.fn(async (args: { where: Partial<Row> }) => {
    const where = args.where;
    return (
      rows.find(
        (row) =>
          (where.id === undefined || row.id === where.id) &&
          (where.organizationId === undefined || row.organizationId === where.organizationId) &&
          (where.parentChargeId === undefined || row.parentChargeId === where.parentChargeId) &&
          (where.chargeNumber === undefined || row.chargeNumber === where.chargeNumber),
      ) ?? null
    );
  });
  return { charge: { findFirst } } as unknown as Prisma.TransactionClient;
}

const base: Row = {
  id: "base",
  organizationId: "org",
  chargeNumber: "TAF-tenancy",
  chargeType: "tenancy_agreement_fee",
  parentChargeId: null,
};
const child: Row = {
  id: "child",
  organizationId: "org",
  chargeNumber: "TAF-tenancy-SST",
  chargeType: "tenancy_agreement_fee",
  parentChargeId: "base",
};

describe("isExactTaTaxPairCharge", () => {
  it("recognizes both the base and the exact linked SST child", async () => {
    expect(await isExactTaTaxPairCharge(txWith([base, child]), "org", "base")).toBe(true);
    expect(await isExactTaTaxPairCharge(txWith([base, child]), "org", "child")).toBe(true);
  });

  it("recognizes the same representation for a renewal fee", async () => {
    const renewal = { ...base, id: "renewal", chargeNumber: "RENEW-tenancy", chargeType: "renewal_fee" };
    const tax = {
      ...child,
      id: "renewal-tax",
      parentChargeId: renewal.id,
      chargeNumber: `${renewal.chargeNumber}-SST`,
      chargeType: "renewal_fee",
    };
    expect(await isExactTaTaxPairCharge(txWith([renewal, tax]), "org", renewal.id)).toBe(true);
  });

  it("does not block an explicit legacy single-line TA charge", async () => {
    expect(await isExactTaTaxPairCharge(txWith([base]), "org", base.id)).toBe(false);
  });

  it("does not infer a pair from a generic parent link or a non-exact child number", async () => {
    const lookalike = { ...child, chargeNumber: "TAF-tenancy-tax" };
    expect(await isExactTaTaxPairCharge(txWith([base, lookalike]), "org", base.id)).toBe(false);
    expect(await isExactTaTaxPairCharge(txWith([base, lookalike]), "org", lookalike.id)).toBe(false);
  });

  it("does not block an exact-looking pair for a non-TA charge type", async () => {
    const expense = { ...base, chargeType: "expense", chargeNumber: "EXP-1" };
    const tax = { ...child, parentChargeId: expense.id, chargeNumber: "EXP-1-SST", chargeType: "expense" };
    expect(await isExactTaTaxPairCharge(txWith([expense, tax]), "org", expense.id)).toBe(false);
    expect(await isExactTaTaxPairCharge(txWith([expense, tax]), "org", tax.id)).toBe(false);
  });
});
