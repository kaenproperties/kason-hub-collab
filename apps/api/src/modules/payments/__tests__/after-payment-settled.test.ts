// after-payment-settled.test.ts
//
// This wrapper exists so the six settlement paths in payments.service.ts cannot
// drift apart — a seventh path added later gets ALL follow-ons or none. These tests
// pin the two properties that make it worth existing: every callee fires, and they
// run in dependency order — sync refreshes the ledger the fee is computed from, and
// the auto-offset settles the fee invoice that step just issued against the payable
// that step refreshed. The order is load-bearing, not cosmetic.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

const syncOwnerLedgerForCharges = vi.hoisted(() => vi.fn());
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges }));

const issueMgmtFeeForPaidRent = vi.hoisted(() => vi.fn());
vi.mock("../../owner-billing/mgmt-fee-on-payment.hook", () => ({ issueMgmtFeeForPaidRent }));

const autoOffsetOwnerReceivablesForPaidRent = vi.hoisted(() => vi.fn());
vi.mock("../../owner-billing/auto-offset-on-rent.hook", () => ({ autoOffsetOwnerReceivablesForPaidRent }));

const recordDepositsPayableToOwnerForPaidCharges = vi.hoisted(() => vi.fn());
vi.mock("../../owner-billing/deposit-held-on-payment.hook", () => ({ recordDepositsPayableToOwnerForPaidCharges }));

import { afterPaymentSettled } from "../after-payment-settled";

describe("afterPaymentSettled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    syncOwnerLedgerForCharges.mockImplementation(async () => {
      calls.push("sync");
    });
    issueMgmtFeeForPaidRent.mockImplementation(async () => {
      calls.push("fee");
    });
    recordDepositsPayableToOwnerForPaidCharges.mockImplementation(async () => {
      calls.push("deposit");
    });
    autoOffsetOwnerReceivablesForPaidRent.mockImplementation(async () => {
      calls.push("offset");
    });
  });

  it("runs sync -> fee -> deposit -> offset, in that order", async () => {
    await afterPaymentSettled("org-1", "user-1", "admin", ["ch-1"]);
    // offset LAST is load-bearing: it settles the IVOWN lines the fee step issues,
    // against rent plus the deposit payable projected immediately before it.
    expect(calls).toEqual(["sync", "fee", "deposit", "offset"]);
  });

  it("passes the same org/user/role/chargeIds to both", async () => {
    await afterPaymentSettled("org-1", "user-1", "admin", ["ch-1", "ch-2"]);
    const args = ["org-1", "user-1", "admin", ["ch-1", "ch-2"]];
    expect(syncOwnerLedgerForCharges).toHaveBeenCalledWith(...args);
    expect(issueMgmtFeeForPaidRent).toHaveBeenCalledWith(...args);
    expect(recordDepositsPayableToOwnerForPaidCharges).toHaveBeenCalledWith(...args);
    expect(autoOffsetOwnerReceivablesForPaidRent).toHaveBeenCalledWith(...args);
  });

  it("forwards an empty/missing charge list to both (each owns its own guard)", async () => {
    await afterPaymentSettled("org-1", "user-1", "admin", []);
    expect(syncOwnerLedgerForCharges).toHaveBeenCalledWith("org-1", "user-1", "admin", []);
    expect(issueMgmtFeeForPaidRent).toHaveBeenCalledWith("org-1", "user-1", "admin", []);
    expect(recordDepositsPayableToOwnerForPaidCharges).toHaveBeenCalledWith("org-1", "user-1", "admin", []);
    expect(autoOffsetOwnerReceivablesForPaidRent).toHaveBeenCalledWith("org-1", "user-1", "admin", []);
  });
});
