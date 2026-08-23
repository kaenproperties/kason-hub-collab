// UI Task 7 — owner attachments panel (per-apartment-month, owner-owned).
//
// Mirrors ui-5 SettingDrawer's useAuth manager-gate pattern (Delete is
// `manager`-gated per api/bills-grid.ts's `requireRole("manager")` on the
// DELETE route — the control is ABSENT for an editor, not merely disabled,
// R26) and its Callout-for-error convention. The dropzone/file-row markup
// mirrors tenant-tracker/bill-workspace/attach-strip.tsx (the closest house
// analogue: a DIRECT multipart upload, not the Phase-2 mint/complete flow) —
// hidden `<input type="file">` queried via `container.querySelector` in
// tests, not a labelled control.
//
// These attachments belong to the OWNER and attach to NO expense line — a
// separate per-unit upload button, entirely decoupled from the tenant/owner
// ExpensesDialog rows next to it on the grid.
//
// Two fail-closed rules drive the mutation wiring below:
//  - Upload writes a row server-side ONLY after a confirmed 2xx (R28). This
//    component NEVER optimistically appends a row on `mutate()` — a failed
//    upload's `onError` never touches the query cache, so no phantom row can
//    appear; only a successful upload invalidates the list query, and the
//    row that then renders is the server's own truth.
//  - Delete is object-first, fail-closed SERVER-side: a genuine storage fault
//    returns 502 ATTACHMENT_DELETE_FAILED and retains the row (no attachment
//    row may ever point at a missing object). The client mirrors that by
//    never optimistically removing a row either — only a successful delete
//    invalidates the list — and shows a per-row "Couldn't remove file —
//    Retry" affordance on that 502 specifically.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Paperclip, Trash2, UploadCloud } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { usePermission } from "@/components/permission-gate";
import { ApiError } from "@/lib/api-client";
import {
  deleteAttachment,
  getAttachmentUrl,
  listAttachments,
  uploadAttachments,
  GRID_QUERY_KEY_ROOT,
  type AttachmentListItem,
} from "@/api/bills-grid";
import { BillLightbox, isImageFilename } from "@/pages/tenancy/owner-statement/bill-lightbox";

export type AttachmentsPanelProps = {
  apartmentId: string;
  periodMonth: string;
};

export function AttachmentsPanel({ apartmentId, periodMonth }: AttachmentsPanelProps) {
  const canManageDocuments = usePermission("billing.document_manage");
  const queryClient = useQueryClient();
  const queryKey = ["bills-grid", "attachments", apartmentId, periodMonth];
  const inputRef = useRef<HTMLInputElement | null>(null);

  const listQuery = useQuery({
    queryKey,
    queryFn: () => listAttachments(apartmentId, periodMonth),
    enabled: canManageDocuments,
  });
  const items = listQuery.data?.items ?? [];

  // Item 4 — inline preview so the admin can SEE what was uploaded (catch a wrong
  // file). Clicking a filename opens BillLightbox (image → <img>, PDF → <iframe>);
  // prev/next cycle the list. The signed URL is minted lazily per active
  // attachment (short-lived) — never eagerly for the whole list.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const activeItem = previewIndex !== null ? (items[previewIndex] ?? null) : null;
  const previewQuery = useQuery({
    queryKey: ["bills-grid", "attachment-url", activeItem?.id],
    queryFn: () => getAttachmentUrl(activeItem!.id),
    enabled: activeItem != null,
  });
  // Review #3: a failed URL fetch (e.g. the row was deleted between list-render
  // and click → 404) must not leave an open-but-blank viewer with no cue. Toast
  // and close instead of rendering an empty lightbox.
  useEffect(() => {
    if (previewQuery.isError && previewIndex !== null) {
      toast.error("Couldn't open the attachment.");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a query-result transition (preview-URL fetch error) with a toast + viewer-close; there is no non-effect place to observe this async settle.
      setPreviewIndex(null);
    }
  }, [previewQuery.isError, previewIndex]);

  // Retained ONLY so "Retry" can resubmit the exact same file set — never
  // read to decide what renders (the row list above is server-truth only).
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadAttachments(apartmentId, periodMonth, files),
    onSuccess: () => {
      setPendingFiles(null);
      toast.success("File uploaded.");
      queryClient.invalidateQueries({ queryKey }); // attachments own key
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // R6: refresh grid cell/badge
    },
    onError: (_err: unknown, files: File[]) => {
      setPendingFiles(files);
    },
  });

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    uploadMutation.mutate(Array.from(list));
  }

  // Set on a 502 ATTACHMENT_DELETE_FAILED for a specific row — distinct from
  // a toast because the row itself must stay visible with an inline Retry,
  // not just a transient notification.
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: string) => deleteAttachment(apartmentId, attachmentId),
    onSuccess: (_data: { ok: true }, attachmentId: string) => {
      if (deleteFailedId === attachmentId) setDeleteFailedId(null);
      toast.success("Attachment removed.");
      queryClient.invalidateQueries({ queryKey }); // attachments own key
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // R6: refresh grid cell/badge
    },
    onError: (err: unknown, attachmentId: string) => {
      if (err instanceof ApiError && err.status === 502) {
        setDeleteFailedId(attachmentId);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    },
  });

  if (!canManageDocuments) return null;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-primary" />
          Unit bills (owner)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* SCOPE DISCLOSURE. These files carry `expenseId: null`, and BOTH the PDF
            model builder (pdf.service source B) and the pdfKey invalidator
            (attachment-pdf-invalidation) gate that source on
            `counterpartyType === "owner"` — so a file uploaded here can never reach a
            tenant invoice or proforma, not even after a re-Bill. That is deliberate (a
            unit-level bill covers the WHOLE unit, i.e. other tenants' consumption), but
            the panel used to be labelled only "Attachments" and said nothing, so an
            admin filing a TNB bill here reasonably expected the tenant to see it. The
            note names the destination AND the control that does reach a tenant. */}
        <Callout variant="info" title="Owner-only">
          These are the unit&apos;s own supplier bills for this month. They appear on the
          owner&apos;s invoice and statement — never on a tenant&apos;s invoice or proforma.
          To put a receipt on a tenant&apos;s bill, attach it to that expense line in
          Expenses instead.
        </Callout>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <Button
          type="button"
          variant="gold"
          size="sm"
          disabled={uploadMutation.isPending}
          onClick={() => inputRef.current?.click()}
          className="gap-2"
        >
          <UploadCloud className="h-4 w-4" />
          {uploadMutation.isPending ? "Uploading…" : "Upload"}
        </Button>

        {uploadMutation.isError && (
          <Callout variant="danger">
            <div className="flex items-center justify-between gap-3">
              <span>Upload failed — Retry</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => pendingFiles && uploadMutation.mutate(pendingFiles)}
              >
                Retry
              </Button>
            </div>
          </Callout>
        )}

        {items.length > 0 ? (
          <ul className="space-y-1.5">
            {items.map((item, index) => (
              <AttachmentRow
                key={item.id}
                item={item}
                canDelete={canManageDocuments}
                deleting={deleteMutation.isPending && deleteMutation.variables === item.id}
                deleteFailed={deleteFailedId === item.id}
                onPreview={() => setPreviewIndex(index)}
                onDelete={() => deleteMutation.mutate(item.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No attachments yet.</p>
        )}
      </CardContent>

      <BillLightbox
        open={activeItem != null}
        index={previewIndex}
        total={items.length}
        url={previewQuery.data?.downloadUrl}
        label={activeItem?.filename ?? ""}
        isImage={activeItem ? activeItem.contentType.startsWith("image/") || isImageFilename(activeItem.filename) : false}
        onClose={() => setPreviewIndex(null)}
        onPrev={() => setPreviewIndex((i) => (i === null ? null : (i - 1 + items.length) % items.length))}
        onNext={() => setPreviewIndex((i) => (i === null ? null : (i + 1) % items.length))}
      />
    </Card>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────
// Mirrors attach-strip.tsx's AttachmentRow: icon + filename + a right-aligned
// action. Delete replaces the strip's unconditional remove button with an
// `isManager` gate — the ONLY structural difference from the house pattern.

function AttachmentRow({
  item,
  canDelete,
  deleting,
  deleteFailed,
  onPreview,
  onDelete,
}: {
  item: AttachmentListItem;
  canDelete: boolean;
  deleting: boolean;
  deleteFailed: boolean;
  onPreview: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={onPreview}
          title={`Preview ${item.filename}`}
          className="min-w-0 flex-1 truncate text-left text-sm text-foreground underline-offset-2 hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded"
        >
          {item.filename}
        </button>
        {canDelete && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Delete ${item.filename}`}
            disabled={deleting}
            onClick={onDelete}
            className="text-rose-600 hover:text-rose-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {deleteFailed && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn&apos;t remove file — Retry</span>
            <Button type="button" variant="outline" size="sm" onClick={onDelete}>
              Retry
            </Button>
          </div>
        </Callout>
      )}
    </li>
  );
}
