import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../repository", () => ({
  listBillingDocuments: vi.fn(),
  getBillingDocumentDetail: vi.fn(),
}));
vi.mock("../pdf.service", () => ({
  getBillingDocumentPdfUrl: vi.fn(),
}));
vi.mock("../attachment-url.service", () => ({
  resolveAttachmentUrlService: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(),
  deleteObjectsBestEffort: vi.fn().mockResolvedValue({ deleted: 1, failed: 0 }),
}));

import { billingDocumentsRoutes } from "../routes";
import { listBillingDocuments, getBillingDocumentDetail } from "../repository";
import { getBillingDocumentPdfUrl } from "../pdf.service";
import { resolveAttachmentUrlService } from "../attachment-url.service";
import { deleteObjectsBestEffort } from "../../../lib/storage";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", billingDocumentsRoutes);
  return app;
}

const manager: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editor: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const admin: SessionPayload = { userId: "u3", orgId: "o1", role: "admin", userType: "operator" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
});

describe("billing-documents routes", () => {
  it("canonical 404 while ENABLE_PHASE2_BILLING_DOCS is dark, even for a manager", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    const res = await makeApp(manager).request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("GET / lists with parsed filters (manager)", async () => {
    vi.mocked(listBillingDocuments).mockResolvedValue({ items: [], total: 0 });
    const res = await makeApp(manager).request("/?docType=debit_note&month=2026-07&page=2");
    expect(res.status).toBe(200);
    expect(listBillingDocuments).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ docType: "debit_note", month: "2026-07", page: 2, pageSize: 25 }),
    );
  });

  it("GET / parses a CSV docTypes into an array (Invoices register spans invoice+debit_note)", async () => {
    vi.mocked(listBillingDocuments).mockResolvedValue({ items: [], total: 0 });
    const res = await makeApp(manager).request("/?docTypes=invoice,debit_note");
    expect(res.status).toBe(200);
    expect(listBillingDocuments).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ docTypes: ["invoice", "debit_note"] }),
    );
  });

  it("GET / rejects a docTypes with an invalid member (400)", async () => {
    const res = await makeApp(manager).request("/?docTypes=invoice,bogus");
    expect(res.status).toBe(400);
  });

  it("GET / allows an Operations Admin to view accounting documents", async () => {
    vi.mocked(listBillingDocuments).mockResolvedValue({ items: [], total: 0 });
    const res = await makeApp(editor).request("/");
    expect(res.status).toBe(200);
  });

  it("GET / rejects a malformed query with 400", async () => {
    const res = await makeApp(manager).request("/?month=July");
    expect(res.status).toBe(400);
  });

  it("GET /:id returns 404 for a cross-org/unknown doc", async () => {
    vi.mocked(getBillingDocumentDetail).mockResolvedValue(null);
    const res = await makeApp(manager).request("/33333333-3333-4333-8333-333333333333");
    expect(res.status).toBe(404);
  });

  it("GET /:id/pdf returns the signed url", async () => {
    vi.mocked(getBillingDocumentPdfUrl).mockResolvedValue({ url: "https://signed.example/x.pdf" });
    const res = await makeApp(manager).request("/33333333-3333-4333-8333-333333333333/pdf");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: "https://signed.example/x.pdf" } });
  });

  // Task 7: signed-URL endpoint for expense-line attachments, linkage-guarded
  // by resolveAttachmentUrlService (unit-tested separately in
  // attachment-url.test.ts). This suite only checks route wiring: params
  // passed through + null->404 mapping.
  it("GET /:id/attachments/:attachmentId/url returns the signed url", async () => {
    vi.mocked(resolveAttachmentUrlService).mockResolvedValue({ url: "https://signed.example/att.pdf" });
    const res = await makeApp(manager).request(
      "/33333333-3333-4333-8333-333333333333/attachments/44444444-4444-4444-8444-444444444444/url",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: "https://signed.example/att.pdf" } });
    expect(resolveAttachmentUrlService).toHaveBeenCalledWith(
      "o1",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("GET /:id/attachments/:attachmentId/url returns 404 when the attachment isn't linked to this document (or cross-org)", async () => {
    vi.mocked(resolveAttachmentUrlService).mockResolvedValue(null);
    const res = await makeApp(manager).request(
      "/33333333-3333-4333-8333-333333333333/attachments/44444444-4444-4444-8444-444444444444/url",
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Attachment not found" });
  });

  // P3 review fix (Task 11 Important finding): best-effort orphan cleanup
  // for a refund-proof uploaded before a void request that then
  // failed/was cancelled — see void-charge-dialog.tsx.
  describe("DELETE /refund-proofs", () => {
    it("rejects a foreign-org key with 403 and never touches storage", async () => {
      const res = await makeApp(admin).request("/refund-proofs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "orgs/other-org/refund-proofs/abc.pdf" }),
      });
      expect(res.status).toBe(403);
      expect(deleteObjectsBestEffort).not.toHaveBeenCalled();
    });

    it("allows a manager (accounting workspace, P3 T3 gate replacement)", async () => {
      const res = await makeApp(manager).request("/refund-proofs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "orgs/o1/refund-proofs/abc.pdf" }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects an editor (operations-only, not in the accounting workspace) with 403", async () => {
      const res = await makeApp(editor).request("/refund-proofs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "orgs/o1/refund-proofs/abc.pdf" }),
      });
      expect(res.status).toBe(403);
      expect(deleteObjectsBestEffort).not.toHaveBeenCalled();
    });

    it("rejects a missing key with 400", async () => {
      const res = await makeApp(admin).request("/refund-proofs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(deleteObjectsBestEffort).not.toHaveBeenCalled();
    });

    it("deletes an org-scoped key best-effort (200 even if the object is already gone)", async () => {
      vi.mocked(deleteObjectsBestEffort).mockResolvedValueOnce({ deleted: 0, failed: 0 });
      const res = await makeApp(admin).request("/refund-proofs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "orgs/o1/refund-proofs/abc.pdf" }),
      });
      expect(res.status).toBe(200);
      expect(deleteObjectsBestEffort).toHaveBeenCalledWith(["orgs/o1/refund-proofs/abc.pdf"]);
    });
  });
});
