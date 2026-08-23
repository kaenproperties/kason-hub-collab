// Bills & Expenses Grid — the custom right-click context menu (Excel-Web V2).
// Pure + props-driven, same discipline as grid-table.tsx: no fetch, no store.
// Every action delegates to an EXISTING page callback (copy / clear-by-grain /
// colour-fill / hide-column) — this component adds NO new money-write path.
//
// It replaces the browser's native context menu inside the grid: the page's
// onContextMenu preventDefaults the native menu, fixes the selection (preserve
// if the click was inside it, else collapse to the clicked cell), and mounts
// this at the pointer position. Closes on Escape (via the grid's
// closeTransientPopover), on an outside pointerdown, and on scroll.
import { useEffect, useRef } from "react";
import { Copy, Eraser, PaintBucket, EyeOff, FileText, ReceiptText, BadgeCheck } from "lucide-react";

// Same swatches as the toolbar (grid-toolbar.tsx) — cosmetic localStorage only.
const COLOUR_SWATCHES: Array<{ colour: string; label: string }> = [
  { colour: "#7C3AED", label: "Violet" },
  { colour: "#4338CA", label: "Indigo" },
  { colour: "#C026D3", label: "Fuchsia" },
  { colour: "#92400E", label: "Brown" },
  { colour: "#374151", label: "Charcoal" },
];

export interface GridContextMenuProps {
  x: number;
  y: number;
  // Whether the current selection has cells (gates Copy/Colour/Clear).
  hasSelection: boolean;
  columnLabel: string; // human label of the right-clicked column, for "Hide {col}"
  hasAmount?: boolean;
  invoiceCount?: number;
  receiptCount?: number;
  onUploadInvoice?: () => void;
  onUploadReceipt?: () => void;
  onViewInvoice?: () => void;
  onViewReceipt?: () => void;
  onMarkPaid?: () => void;
  onCopy: () => void;
  onClearContents?: () => void;
  onApplyColour?: (colour: string) => void;
  onHideColumn: () => void;
  onClose: () => void;
}

export function GridContextMenu({
  x,
  y,
  hasSelection,
  columnLabel,
  hasAmount = false,
  invoiceCount = 0,
  receiptCount = 0,
  onUploadInvoice,
  onUploadReceipt,
  onViewInvoice,
  onViewReceipt,
  onMarkPaid,
  onCopy,
  onClearContents,
  onApplyColour,
  onHideColumn,
  onClose,
}: GridContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Dismiss on an outside pointerdown or on scroll (capture) — Escape is handled
  // upstream by the grid keyboard hook's closeTransientPopover.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    // pointerdown on document (capture so it beats the cells' own handlers)
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // Keep the menu on-screen: clamp against the viewport (best-effort; the menu is
  // a fixed 224px-wide card).
  const style: React.CSSProperties = {
    position: "fixed",
    top: Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 220),
    left: Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 232),
    zIndex: 60,
  };

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="grid-context-menu"
      style={style}
      className="w-56 rounded-lg border border-border/60 bg-background/95 p-1 text-sm shadow-xl backdrop-blur-xl"
    >
      {hasAmount && onUploadInvoice && onUploadReceipt && (
        <>
          <button type="button" role="menuitem" onClick={() => run(onUploadInvoice)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60">
            <FileText className="h-4 w-4 text-[var(--gold)]" /> Upload Invoice
          </button>
          <button type="button" role="menuitem" onClick={() => run(onUploadReceipt)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60">
            <ReceiptText className="h-4 w-4 text-[var(--gold)]" /> Upload Receipt
          </button>
          <button type="button" role="menuitem" disabled={!invoiceCount} onClick={() => onViewInvoice && run(onViewInvoice)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 disabled:opacity-40">
            <FileText className="h-4 w-4" /> View Invoice {invoiceCount > 0 ? `(${invoiceCount})` : ""}
          </button>
          <button type="button" role="menuitem" disabled={!receiptCount} onClick={() => onViewReceipt && run(onViewReceipt)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 disabled:opacity-40">
            <ReceiptText className="h-4 w-4" /> View Receipt {receiptCount > 0 ? `(${receiptCount})` : ""}
          </button>
          <button type="button" role="menuitem" disabled={!receiptCount || !onMarkPaid} onClick={() => onMarkPaid && run(onMarkPaid)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-emerald-50 disabled:opacity-40">
            <BadgeCheck className="h-4 w-4 text-emerald-700" /> Mark as Paid
          </button>
          <div className="my-1 h-px bg-border/60" />
        </>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="ctx-copy"
        disabled={!hasSelection}
        onClick={() => run(onCopy)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-primary)] transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Copy className="h-4 w-4 text-muted-foreground" />
        Copy
      </button>
      {onClearContents && <button
        type="button"
        role="menuitem"
        data-testid="ctx-clear"
        disabled={!hasSelection}
        onClick={() => run(onClearContents)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-primary)] transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Eraser className="h-4 w-4 text-muted-foreground" />
        Clear contents
      </button>}

      {onApplyColour && <div className="my-1 h-px bg-border/60" />}

      {onApplyColour && <div className="px-2 py-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <PaintBucket className="h-3.5 w-3.5" />
          Colour
        </div>
        <div className="flex items-center gap-1.5">
          {COLOUR_SWATCHES.map((s) => (
            <button
              key={s.colour}
              type="button"
              aria-label={`Fill selection ${s.label}`}
              data-testid={`ctx-colour-${s.colour}`}
              disabled={!hasSelection}
              onClick={() => run(() => onApplyColour?.(s.colour))}
              style={{ backgroundColor: s.colour }}
              className="h-6 w-6 rounded-full border-2 border-white shadow-sm ring-1 ring-[var(--navy)] transition hover:scale-110 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gold)] disabled:cursor-not-allowed disabled:opacity-65"
            />
          ))}
          <button
            type="button"
            data-testid="ctx-colour-clear"
            disabled={!hasSelection}
            onClick={() => run(() => onApplyColour?.(""))}
            className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>}

      <div className="my-1 h-px bg-border/60" />

      <button
        type="button"
        role="menuitem"
        data-testid="ctx-hide-column"
        onClick={() => run(onHideColumn)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-primary)] transition hover:bg-muted/60"
      >
        <EyeOff className="h-4 w-4 text-muted-foreground" />
        Hide column{columnLabel ? ` · ${columnLabel}` : ""}
      </button>
    </div>
  );
}
