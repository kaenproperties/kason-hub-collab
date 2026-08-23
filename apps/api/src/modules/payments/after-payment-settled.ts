/**
 * The single post-commit follow-on for every payment path.
 *
 * SIX things must happen after money settles, and they must happen at EVERY settlement
 * point: the owner ledger re-syncs, a fully-paid rent charge issues the owner's management
 * fee, that fee is netted off what KAEN now holds for the owner, a fully-paid deposit
 * charge records the deposit KAEN now holds, a proforma's paid lines graduate into a real
 * invoice, and that invoice gets its receipt. payments.service.ts has six such points
 * (record, bulk, allocate, reallocate, confirm, portal). Six places that must agree about a
 * list of follow-ons is the drift shape this repo has been bitten by before — a seventh
 * settlement path added later would silently get the ledger sync and NOT the fee,
 * under-billing the owner with nothing to notice it.
 *
 * So the grouping lives here, structurally, and the call sites call one function.
 *
 * That is exactly the drift receipt issuance had already suffered when this file was
 * written: `issueReceiptForPayment` was wired into ONE call site (the admin Record
 * Payment form) and left out of this grouping, so a tenant paying by FPX in the portal
 * settled through postPaymentService → here, and no receipt was ever minted. Both it
 * and graduation now live in this list so no path can skip them again.
 *
 * ORDER MATTERS within the owner-funds chain, and each step depends on the one before:
 *   1. ledger sync — so rental_income reflects the cash just received (it books the
 *      COLLECTED amount), which is what the owner's payable is computed from.
 *   2. fee issue — re-syncs its own charges. Reversing 1 and 2 would compute a fee
 *      against a stale ledger row.
 *   3. deposit payable — projects every partial/full deposit collection into the
 *      amount transferable to the owner. It is not income, but it is owner money.
 *   4. auto-offset — settles open IVOWN lines against the payable refreshed by steps
 *      1 and 3. It MUST run after the deposit projection; otherwise the screen can
 *      show the deposit inside Owner Payout while owner expenses remain yellow.
 *   5. graduation — mints the real invoice from the proforma lines this payment paid.
 *   6. receipt — acknowledges that invoice. MUST run after step 5: issueReceiptDocumentTx
 *      only recognises lines on an invoice/debit_note, so with no graduated invoice yet
 *      it skips and no receipt is ever created.
 *
 * Steps 1-4 run on EVERY call. Steps 5-6 need a single owning payment and are skipped
 * without one — see the `payment` parameter. Step 4 is deliberately BEFORE that guard:
 * it takes only `chargeIds`, and moving it after would silently stop recording deposits on
 * the void and reverse-allocation paths, which is a behaviour change nobody asked for.
 *
 * All six callees own the same contract — out of the caller's transaction, after
 * it commits, swallowing every error with a durable audit marker — so this wrapper
 * adds no error handling of its own. None can roll back the money tx.
 */
import { syncOwnerLedgerForCharges } from "../owner-ledger/owner-ledger.sync-hook";
import { issueMgmtFeeForPaidRent } from "../owner-billing/mgmt-fee-on-payment.hook";
import { autoOffsetOwnerReceivablesForPaidRent } from "../owner-billing/auto-offset-on-rent.hook";
import { recordDepositsPayableToOwnerForPaidCharges } from "../owner-billing/deposit-held-on-payment.hook";
import { graduateProformaForPayment } from "../billing-documents/graduation.hook";
import { issueReceiptForPayment } from "../billing-documents/receipt.issue-hook";

export async function afterPaymentSettled(
  orgId: string,
  userId: string,
  role: string,
  chargeIds: string[] | null | undefined,
  /**
   * The payment whose settlement triggered this, when there is exactly one.
   *
   * Optional because two call sites move money WITHOUT one: updatePaymentStatusService
   * (a void, which restores outstanding rather than settling it) and
   * reverseAllocationService (money going the other way). Neither should mint a document,
   * so they pass nothing and steps 5 and 6 are skipped. Every path that genuinely settles
   * money against one payment passes it — leaving one out is exactly the drift this file
   * exists to prevent, and receipt issuance had already suffered it once.
   *
   * `paidChargeIds` is the subset settled IN FULL. Graduation uses it rather than
   * `chargeIds`, because a partial allocation must not mint a full-value tax invoice.
   */
  payment?: { paymentId: string; partyId: string; paidChargeIds: string[] },
): Promise<void> {
  await syncOwnerLedgerForCharges(orgId, userId, role, chargeIds);
  await issueMgmtFeeForPaidRent(orgId, userId, role, chargeIds);
  // Deposit is non-income, but every amount collected is payable to the owner and
  // may fund owner-borne expenses. Project it before calculating available payout.
  await recordDepositsPayableToOwnerForPaidCharges(orgId, userId, role, chargeIds);
  await autoOffsetOwnerReceivablesForPaidRent(orgId, userId, role, chargeIds);
  if (!payment) return;
  await graduateProformaForPayment(orgId, userId, role, payment.paymentId, payment.partyId, payment.paidChargeIds);
  await issueReceiptForPayment(orgId, userId, role, payment.paymentId, payment.partyId, chargeIds);
}
