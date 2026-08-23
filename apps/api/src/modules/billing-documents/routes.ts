import { Hono } from "hono";
import { listBillingDocumentsQuery, applyCreditInput, manualInvoiceInput, createCreditNoteInput, chargeAdjustmentInput, voidChargeAdjustmentInput } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import { formatZodError } from "../../lib/zod-error-mapper";
import { billingDocsFlagGate } from "./billing-documents.gate";
import { chargeAdjustmentsFlagGate } from "./charge-adjustment.gate";
import { listBillingDocuments, getBillingDocumentDetail } from "./repository";
import { getPendingPaymentsForDocument } from "./pending-payments.service";
import { getBillingDocumentPdfUrl, renderBillingDocumentPdfFile } from "./pdf.service";
import { resolveAttachmentUrlService } from "./attachment-url.service";
import { applyCreditManuallyService } from "./credit-apply.service";
import { createManualInvoiceService } from "./invoice-create.service";
import { createOverpaymentCreditNoteService } from "./overpayment-cn.service";
import { createChargeAdjustmentService } from "./charge-adjustment.service";
import { voidChargeAdjustmentService } from "./charge-adjustment-void.service";
import { putObject, deleteObjectsBestEffort } from "../../lib/storage";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

const billingDocumentsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Mirrors the gate on /api/payments' multi-pay surfaces — same flag, same 404.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multiPayGate = async (c: any, next: any) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY")) return c.json({ error: "not_found" }, 404);
  await next();
};

// Flag gate FIRST (canonical 404 while dark — before any auth/role logic
// leaks the surface's existence), then manager read for everything.
billingDocumentsRoutes.use("*", billingDocsFlagGate);
// DEVIATION FROM SPEC R4 (intentional, behavior-identical): spec R4 says convert
// apply-credit to `requireWorkspace("accounting")` AND an admin capability check. We
// keep `requireRole("admin")` because it yields the SAME outcome (admin allowed;
// accountant + manager + editor + viewer denied — accountant is absent from
// VALID_ROLES so requireRole("admin") 403s it) with less churn. R3a records
// "apply-credit stays admin-only". refund-proofs gate replacement → P3.

// GET / — the Documents register (Yannie's reconciliation/audit surface).
billingDocumentsRoutes.get("/", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const parsed = listBillingDocumentsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const data = await listBillingDocuments(session.orgId, parsed.data);
  return c.json({ data });
});

// GET /:id — detail with lines + related documents.
billingDocumentsRoutes.get("/:id", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const detail = await getBillingDocumentDetail(session.orgId, c.req.param("id"));
  if (!detail) return c.json({ error: "Document not found" }, 404);
  return c.json({ data: detail });
});

// GET /:id/pending-payments — tenant-submitted transfers awaiting verification
// against this document, each with its slip already signed. Feeds the drawer's
// Pending-verification panel (the register's red dot leads here).
// multiPayGate matches its sibling GET /payments/:id/proof-urls: both read
// tenant-uploaded slips, and both should stay dark while the multi-pay flag is
// off. Without it, turning the flag off leaves this panel rendering cards whose
// Approve/Reject buttons both 404 (those routes ARE gated).
billingDocumentsRoutes.get("/:id/pending-payments", multiPayGate, requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const data = await getPendingPaymentsForDocument(session.orgId, c.req.param("id"));
  if (data === null) return c.json({ error: "Document not found" }, 404);
  return c.json({ data });
});

// GET /:id/attachments/:attachmentId/url — signed URL for an expense-line attachment,
// only when the attachment is genuinely linked to this document (bill-expenses R6).
billingDocumentsRoutes.get("/:id/attachments/:attachmentId/url", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const result = await resolveAttachmentUrlService(session.orgId, c.req.param("id"), c.req.param("attachmentId"));
  if (!result) return c.json({ error: "Attachment not found" }, 404);
  return c.json({ data: result });
});

// GET /:id/pdf — signed URL; renders on demand when pdfKey is null.
billingDocumentsRoutes.get("/:id/pdf", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const result = await getBillingDocumentPdfUrl(session.orgId, c.req.param("id"));
  if (!result) return c.json({ error: "Document not found" }, 404);
  return c.json({ data: result });
});

// Local-storage-independent PDF download. The URL endpoint above points here
// automatically when Supabase is not configured; it is also useful as a stable
// direct-download route for accountants.
billingDocumentsRoutes.get("/:id/pdf-file", requirePermission("accounting.view"), async (c) => {
  const session = c.get("session");
  const result = await renderBillingDocumentPdfFile(session.orgId, c.req.param("id"));
  if (!result) return c.json({ error: "Document not found" }, 404);
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `inline; filename="${result.filename.replace(/["\\\r\n]/g, " ")}"`);
  c.header("Cache-Control", "private, no-store");
  return c.body(new Uint8Array(result.bytes));
});

// P3: manual invoice create (R11). Mints posted Charge rows + issues one
// category-routed BillingDocument (invoice/debit_note) per line, all in one
// transaction. Module gate above is already requireWorkspace("accounting");
// this per-route gate is belt-and-braces + explicit.
billingDocumentsRoutes.post("/invoices", requirePermission("accounting.issue"), async (c) => {
  const parsed = manualInvoiceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  const result = await createManualInvoiceService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, 201);
});

// P4: manual overpayment Credit Note (R12). Accounting workspace only; the
// accountantScope allow-list (accountant-scope.ts) also grants this exact
// tuple. Delegates to the row-locked, idempotent service.
billingDocumentsRoutes.post("/credit-notes", requirePermission("accounting.issue"), async (c) => {
  const parsed = createCreditNoteInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  const result = await createOverpaymentCreditNoteService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data }, 201);
});

// Phase 3.1: charge-scoped CREATE credit/debit note (partial amounts),
// TENANT-ONLY. Own flag gate (ENABLE_PHASE2_INVOICE_ADJUSTMENTS, layered on
// top of the module-wide ENABLE_PHASE2_BILLING_DOCS gate above) + accounting
// workspace, mirroring the P4 credit-notes route's per-route gate style.
billingDocumentsRoutes.post("/charge-adjustments", chargeAdjustmentsFlagGate, requirePermission("accounting.issue"), async (c) => {
  const parsed = chargeAdjustmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  const result = await createChargeAdjustmentService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data }, 201);
});

// Phase 4.1: VOID a charge-scoped credit/debit note (Phase 3.1's create path),
// tenant-only, safe-default BLOCK. Reuses chargeAdjustmentsFlagGate (both
// ENABLE_PHASE2_BILLING_DOCS and ENABLE_PHASE2_INVOICE_ADJUSTMENTS gates) —
// mirrors the /charge-adjustments route's per-route gate style.
billingDocumentsRoutes.post("/:id/void", chargeAdjustmentsFlagGate, requirePermission("accounting.void"), async (c) => {
  const parsed = voidChargeAdjustmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  const result = await voidChargeAdjustmentService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    c.req.param("id"),
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json({ data: result.data });
});

// P3 (spec §4.3): manual Apply-credit escape hatch — apply an open CN balance
// to an older outstanding charge, or split differently than the FIFO auto-apply.
billingDocumentsRoutes.post("/:id/apply-credit", requirePermission("accounting.issue"), async (c) => {
  const parsed = applyCreditInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const session = c.get("session");
  const result = await applyCreditManuallyService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    c.req.param("id"),
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json({ data: result.data });
});

// P3: refund transfer-slip upload. Server-minted key + putObject — the void
// dialog uploads FIRST, then sends the returned key as refund.proofKey.
billingDocumentsRoutes.post("/refund-proofs", requirePermission("accounting.void"), async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid form body" }, 400);
  const entry = form.get("file") ?? form.get("files");
  if (!(entry instanceof File)) return c.json({ error: "Missing file field" }, 400);
  const session = c.get("session");
  const safeName = entry.name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const key = `orgs/${session.orgId}/refund-proofs/${crypto.randomUUID()}-${safeName}`;
  await putObject(key, Buffer.from(await entry.arrayBuffer()), (entry.type || "application/octet-stream").toLowerCase());
  return c.json({ data: { key } }, 201);
});

// P3 (review fix, Task 11 Important finding): best-effort orphan cleanup for
// a refund-proof object uploaded above but never actually submitted with the
// void request (upload happens before the void call — a failed/cancelled
// void otherwise leaves an orphan in storage; project no-orphan-storage
// rule). No DB row backs these keys, so "ownership" is enforced purely by
// the org-scoped key prefix minted above — reject any key that doesn't
// start with this org's prefix (403) before touching storage. Delete itself
// is best-effort: 200 even if the object is already gone.
billingDocumentsRoutes.delete("/refund-proofs", requirePermission("accounting.void"), async (c) => {
  const body = await c.req.json().catch(() => null);
  const key = body && typeof (body as Record<string, unknown>).key === "string" ? ((body as Record<string, unknown>).key as string) : null;
  if (!key) return c.json({ error: "Missing key" }, 400);
  const session = c.get("session");
  const prefix = `orgs/${session.orgId}/refund-proofs/`;
  if (!key.startsWith(prefix)) {
    return c.json({ error: "Key does not belong to this organization" }, 403);
  }
  await deleteObjectsBestEffort([key]);
  return c.json({ data: { ok: true } });
});

export { billingDocumentsRoutes };
