import type { FirstMonthPreview, CommissionPreview } from "@kason/shared";

/**
 * Read-only display of the first rent charge the poster will create. The amount
 * comes from the API (which reuses computeProratedRent) so this card can never
 * disagree with what is actually billed -- the formula is never re-implemented
 * in the web bundle.
 *
 * The optional note input is only rendered when a consumer supplies
 * `onNoteChange`; today the assign-tenant surface renders the amount alone
 * (the inventory occupancy write path does not yet carry a note column), so no
 * typed note is silently dropped.
 */
export function FirstMonthPreviewCard({
  preview,
  note,
  onNoteChange,
  commission,
  showNoCommissionNote,
}: {
  preview: FirstMonthPreview | null;
  note?: string;
  onNoteChange?: (next: string) => void;
  commission?: CommissionPreview | null;
  showNoCommissionNote?: boolean;
}) {
  if (!preview) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-white/60 p-3 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-slate-600">First rent to collect for owner · {preview.month}</span>
        <span className="text-lg font-semibold text-slate-900">
          RM {preview.amount.toFixed(2)}
        </span>
      </div>
      {preview.isProrated && (
        <p className="mt-1 text-xs text-slate-500">
          Prorated: {preview.occupiedDays} of {preview.daysInMonth} days.
        </p>
      )}
      {onNoteChange && (
        <label className="mt-3 block text-xs text-slate-600">
          Note (optional)
          <input
            value={note ?? ""}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="pro-rate"
            className="mt-1 w-full rounded-md border border-amber-200 bg-transparent px-2 py-1 text-sm"
          />
        </label>
      )}
      {commission && (
        <div className="mt-3 border-t border-amber-200 pt-2 text-xs text-slate-700">
          <div className="flex items-baseline justify-between">
            <span>KAEN commission · {commission.month}</span>
            <span className="font-semibold">RM {commission.commissionAmount.toFixed(2)}</span>
          </div>
          <div className="flex items-baseline justify-between text-slate-500">
            <span>+ SST (8%){commission.sstBearer === "kaen" ? " · KAEN absorbs" : " · owner bears"}</span>
            <span>RM {commission.sstAmount.toFixed(2)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between font-semibold text-slate-900">
            <span>Commission total</span>
            <span>RM {commission.total.toFixed(2)}</span>
          </div>
        </div>
      )}
      {!commission && showNoCommissionNote && (
        <p className="mt-3 border-t border-amber-200 pt-2 text-xs text-slate-500">
          No full month in this tenancy — no commission.
        </p>
      )}
    </div>
  );
}
