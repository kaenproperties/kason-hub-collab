// Ticket create/edit drawer (M7 Task 9). Mirrors task-drawer's FormDrawer +
// reset-on-open + stay-open-after-create pattern, scoped to one unit's
// tickets. Lifecycle: editable while open/in_progress; resolved/void renders
// read-only with a manager-gated Reopen. Resolve hands off to
// ResolveTicketDialog. Auto-spawn of the paired task is handled server-side;
// there is no client Spawn-task button.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TaskPriority, UpdateTicketInput } from "@kason/shared";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Segmented } from "@/components/ui/segmented";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar } from "@/components/avatar";
import { Field, SelectInput, TextAreaInput, TextInput } from "@/components/form-ui";
import { CategoryCombobox } from "@/components/category-combobox";
import { AttachmentsPanel } from "@/components/attachments-panel";
import { apiFetch } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";
import { useUsers } from "@/api/users";
import {
  ticketAttachmentsKey,
  unitTicketsKey,
  useCreateTicket,
  useRemoveTicketAttachment,
  useReopenTicket,
  useTicketAttachmentUrls,
  useUpdateTicket,
  useVoidTicket,
  type TicketRow,
} from "@/api/tasks";
import { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";
import { ResolveTicketDialog } from "./resolve-ticket-dialog";

type EditableStatus = "open" | "in_progress";

export type TicketDrawerProps = {
  open: boolean;
  onClose: () => void;
  unitId: string;
  /** null = create mode (New Ticket). */
  ticket: TicketRow | null;
};

type FormState = {
  title: string;
  description: string;
  category: string;
  warrantyFlag: boolean;
  status: EditableStatus;
  // Create-only seeds for the auto-spawned board task (same fields as the
  // task drawer's New task form) — the Ticket row itself doesn't store them.
  priority: TaskPriority;
  /** yyyy-mm-dd from <input type="date">; "" = no due date. */
  dueOn: string;
  /** "" = unassigned. */
  assigneeUserId: string;
};

type FormErrors = Partial<Record<"title", string>>;

/**
 * Convert a yyyy-mm-dd date-input value to a Z-normalized ISO datetime.
 * The API's zod `.datetime()` REJECTS offset timestamps, so we anchor the
 * day at UTC midnight explicitly. (Duplicated per dialog file — react-refresh
 * forbids exporting non-component helpers from component files.)
 */
function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

function blankForm(): FormState {
  return {
    title: "",
    description: "",
    category: "",
    warrantyFlag: false,
    status: "open",
    priority: "medium",
    dueOn: "",
    assigneeUserId: "",
  };
}

function formFromTicket(ticket: TicketRow): FormState {
  return {
    title: ticket.title,
    description: ticket.description ?? "",
    category: ticket.category ?? "",
    warrantyFlag: ticket.warrantyFlag,
    // resolved/void hide the status control; "open" is a harmless placeholder.
    status: ticket.status === "in_progress" ? "in_progress" : "open",
    // Spawn seeds are create-only; the edit view never renders or sends them.
    priority: "medium",
    dueOn: "",
    assigneeUserId: "",
  };
}

export function TicketDrawer({ open, onClose, unitId, ticket }: TicketDrawerProps) {
  const qc = useQueryClient();
  const canManage = usePermission("portfolio.edit");

  const usersQuery = useUsers();
  const createTicket = useCreateTicket(unitId);
  const updateTicket = useUpdateTicket(unitId);
  const voidTicket = useVoidTicket(unitId);
  const reopenTicket = useReopenTicket(unitId);

  // Latest server snapshot — seeded from the prop on open, refreshed from
  // every mutation response so the next submit carries a fresh updatedAt
  // (optimistic-concurrency token).
  const [liveTicket, setLiveTicket] = useState<TicketRow | null>(null);
  // Create succeeded this open cycle — drawer stays open in edit view so
  // evidence can be attached immediately.
  const [justCreated, setJustCreated] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  const [form, setForm] = useState<FormState>(blankForm);
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open form snapshot; same pattern as task-drawer.
      setJustCreated(false);
      setResolveOpen(false);
      setLiveTicket(ticket);
      setForm(ticket ? formFromTicket(ticket) : blankForm());
      setErrors({});
    }
    // ticket is captured at open time only; mutations reseed via setLiveTicket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticket?.id]);

  const current = liveTicket ?? ticket;
  const effectiveMode: "create" | "edit" = current ? "edit" : "create";
  const isClosed = current?.status === "resolved" || current?.status === "void";
  const editable = !current || !isClosed;

  const operators = (usersQuery.data?.data ?? []).filter((u) => u.status === "active");

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "title") setErrors((prev) => ({ ...prev, title: undefined }));
  }

  /**
   * Conflict recovery (409 from the updatedAt-in-WHERE check): refetch the
   * unit's ticket list AND reseed this drawer's snapshot so the next submit
   * carries a fresh token. If the reseed fails, close — reopening reloads.
   */
  async function recoverFromConflict(ticketId: string) {
    qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
    try {
      const res = await apiFetch<{ data: TicketRow }>(`/tickets/${ticketId}`);
      setLiveTicket(res.data);
      setForm(formFromTicket(res.data));
    } catch {
      onClose();
    }
  }

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.title.trim()) errs.title = "Title is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (effectiveMode === "create") {
      createTicket.mutate(
        {
          title: form.title.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(form.category.trim() ? { category: form.category.trim() } : {}),
          warrantyFlag: form.warrantyFlag,
          priority: form.priority,
          assigneeUserId: form.assigneeUserId || null,
          dueOn: form.dueOn ? toIsoFromDateInput(form.dueOn) : null,
        },
        {
          onSuccess: (res) => {
            // STAY OPEN — flip to the edit view so evidence can be attached.
            setLiveTicket(res.data);
            setForm(formFromTicket(res.data));
            setJustCreated(true);
          },
          onError: (err) => toast.error(err.message),
        },
      );
      return;
    }

    if (!current) return;
    if (!editable) {
      onClose();
      return;
    }

    // Send only changed fields.
    const patch: Partial<Omit<UpdateTicketInput, "ticketId" | "updatedAt">> = {};
    if (form.title.trim() !== current.title) patch.title = form.title.trim();
    const description = form.description.trim() || null;
    if (description !== current.description) patch.description = description;
    const category = form.category.trim() || null;
    if (category !== current.category) patch.category = category;
    if (form.warrantyFlag !== current.warrantyFlag) patch.warrantyFlag = form.warrantyFlag;
    if (form.status !== current.status) patch.status = form.status;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    updateTicket.mutate(
      { ticketId: current.id, updatedAt: current.updatedAt, ...patch },
      {
        onSuccess: (res) => {
          setLiveTicket(res.data);
          onClose();
        },
        onError: (err) => {
          toast.error(err.message);
          void recoverFromConflict(current.id);
        },
      },
    );
  }

  const isPending = createTicket.isPending || updateTicket.isPending;

  return (
    <>
      <FormDrawer
        open={open}
        onClose={onClose}
        size="lg"
        title={effectiveMode === "create" ? "New ticket" : "Edit ticket"}
        description={
          effectiveMode === "create"
            ? "Raise an issue against this unit."
            : current?.title ?? "Update ticket details."
        }
        onSubmit={handleSubmit}
        submit={{
          label: effectiveMode === "create" ? "Create ticket" : "Save changes",
          pendingLabel: effectiveMode === "create" ? "Creating…" : "Saving…",
          variant: "gold",
          pending: isPending,
          disabled: !editable,
        }}
        secondaryActions={[
          effectiveMode === "edit" && current && editable
            ? {
                label: "Resolve",
                variant: "gold" as const,
                onClick: () => setResolveOpen(true),
              }
            : null,
          effectiveMode === "edit" && current && editable && canManage
            ? {
                label: "Void",
                variant: "destructive" as const,
                pending: voidTicket.isPending,
                pendingLabel: "Voiding…",
                confirm: {
                  title: "Void this ticket?",
                  body: "Voiding marks the ticket as raised in error. Existing history entries stay on the unit. A manager can reopen it later.",
                  confirmLabel: "Void",
                  destructive: true,
                },
                onClick: () =>
                  voidTicket.mutate(
                    { ticketId: current.id, updatedAt: current.updatedAt },
                    {
                      onSuccess: (res) => {
                        toast.success("Ticket voided.");
                        setLiveTicket(res.data);
                        setForm(formFromTicket(res.data));
                      },
                      onError: (err) => {
                        toast.error(err.message);
                        void recoverFromConflict(current.id);
                      },
                    },
                  ),
              }
            : null,
          effectiveMode === "edit" && current && isClosed && canManage
            ? {
                label: "Reopen",
                variant: "outline" as const,
                pending: reopenTicket.isPending,
                pendingLabel: "Reopening…",
                onClick: () =>
                  reopenTicket.mutate(
                    { ticketId: current.id, updatedAt: current.updatedAt },
                    {
                      onSuccess: (res) => {
                        toast.success("Ticket reopened.");
                        setLiveTicket(res.data);
                        setForm(formFromTicket(res.data));
                      },
                      onError: (err) => {
                        toast.error(err.message);
                        void recoverFromConflict(current.id);
                      },
                    },
                  ),
              }
            : null,
        ]}
      >
        <div className="grid gap-4">
          {justCreated && (
            <Callout variant="info">Ticket created — attach evidence below.</Callout>
          )}

          {isClosed && current && (
            <Callout variant="warning">
              {current.status === "resolved" ? "Resolved" : "Void"} — reopen (manager) to edit.
            </Callout>
          )}

          <Field label="Title" error={errors.title}>
            <TextInput
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Water heater not heating"
              required
              disabled={!editable}
              autoFocus={effectiveMode === "create"}
            />
          </Field>

          <Field label="Description">
            <TextAreaInput
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Symptoms, location in the unit, anything the fixer needs…"
              rows={3}
              disabled={!editable}
            />
          </Field>

          {effectiveMode === "create" && (
            <Field label="Priority">
              <Segmented<TaskPriority>
                ariaLabel="Priority"
                value={form.priority}
                onChange={(next) => set("priority", next)}
                size="sm"
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <CategoryCombobox value={form.category} onChange={(v) => set("category", v)} label="Category" hint="Pick a category, or Other for free text." disabled={!editable} />
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <Checkbox
                  aria-label="Warranty item"
                  checked={form.warrantyFlag}
                  onCheckedChange={(checked) => set("warrantyFlag", checked === true)}
                  disabled={!editable}
                />
                <span>Warranty item</span>
              </label>
            </div>
          </div>

          {effectiveMode === "create" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Due date">
                <TextInput
                  type="date"
                  value={form.dueOn}
                  onChange={(e) => set("dueOn", e.target.value)}
                />
              </Field>
              <Field label="Assignee">
                <SelectInput
                  value={form.assigneeUserId}
                  onChange={(e) => set("assigneeUserId", e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {operators.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </SelectInput>
                {(() => {
                  const picked = operators.find((u) => u.id === form.assigneeUserId);
                  return picked ? (
                    <span className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                      <Avatar src={picked.photoUrl} name={picked.fullName} size="sm" />
                      {picked.fullName}
                    </span>
                  ) : null;
                })()}
              </Field>
            </div>
          )}

          {effectiveMode === "edit" && current && editable && (
            <Field label="Status" hint="Saved with your other changes.">
              <Segmented<EditableStatus>
                ariaLabel="Ticket status"
                value={form.status}
                onChange={(next) => set("status", next)}
                size="sm"
                options={[
                  { value: "open", label: "Open" },
                  { value: "in_progress", label: "In progress" },
                ]}
              />
            </Field>
          )}

          {effectiveMode === "edit" && current && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-[var(--text-primary)]">Attachments</span>
              <TicketAttachments unitId={unitId} ticket={current} readOnly={!editable} />
            </div>
          )}
        </div>
      </FormDrawer>

      <ResolveTicketDialog
        open={resolveOpen && !!current}
        onClose={() => setResolveOpen(false)}
        unitId={unitId}
        ticket={current}
        onResolved={() => {
          setResolveOpen(false);
          onClose();
        }}
        onConflict={() => {
          // 409 stale token on resolve: reseed our snapshot — the dialog's
          // `ticket` prop derives from `current`, so the fresh updatedAt flows
          // back down and the retained entry can be re-submitted successfully.
          if (current) void recoverFromConflict(current.id);
        }}
      />
    </>
  );
}

// ─── Attachments (tickets flavor) — thin wrapper over the shared panel ───────
// Owns the ticket-scoped hooks (signed urls, remove mutation, upload queue
// against the ticket mint/complete endpoints); the shared AttachmentsPanel
// renders the drop zone / queue / grid / confirm / lightbox.

function TicketAttachments({
  unitId,
  ticket,
  readOnly,
}: {
  unitId: string;
  ticket: TicketRow;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const urlsQuery = useTicketAttachmentUrls(ticket.id);
  const removeAttachment = useRemoveTicketAttachment(unitId);

  const upload = usePhase2AttachmentUpload({
    mintPath: `/tickets/${ticket.id}/attachments/upload-url`,
    completePath: `/tickets/${ticket.id}/attachments/complete`,
    onUploaded: () => {},
    onCompleted: () => {
      qc.invalidateQueries({ queryKey: ticketAttachmentsKey(ticket.id) });
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
    },
  });

  return (
    <AttachmentsPanel
      entries={urlsQuery.data?.data}
      fallbackKeys={ticket.attachmentKeys}
      upload={upload}
      readOnly={readOnly}
      noun="ticket"
      onRemove={(key) =>
        removeAttachment.mutate(
          { ticketId: ticket.id, key },
          { onError: (err) => toast.error(err.message) },
        )
      }
    />
  );
}
