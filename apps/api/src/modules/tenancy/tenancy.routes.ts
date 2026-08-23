import { Hono } from "hono";
import type { TenancySession } from "./tenancy.types";
import {
  createLandlordTenancySchema,
  createTenancySchema,
  renewTenancySchema,
  cancelRenewalSchema,
  moveOutTenancySchema,
  updateRenewalReviewSchema,
  updateLandlordTenancyStatusSchema,
  updateTenancySchema,
} from "./tenancy.validation";
import {
  createLandlordTenancyService,
  createTenancyService,
  getLandlordTenanciesService,
  syncManagedOwnerAgreementRecordsService,
  getTenanciesService,
  renewTenancyService,
  cancelRenewalService,
  moveOutTenancyService,
  updateRenewalReviewService,
  updateLandlordTenancyStatusService,
  updateTenancyService,
} from "./tenancy.service";
import { requirePermission } from "../../middleware/require-permission";
import { formatZodError } from "../../lib/zod-error-mapper";
import { previewFirstMonthRent, computeFirstMonthCommission } from "./rent-preview";
import { agreementDownload, agreementHistory, applyAgreementTemplate, generateAgreement, getOrCreateAgreement, listAgreementTemplates, previewAgreement, previewAgreementPdf, saveAgreementTemplate, transitionAgreement, updateAgreement } from "./tenancy-agreement.service";
import { applyManagementTemplate, generateManagementAgreement, getOrCreateManagementAgreement, listManagementTemplates, managementAgreementDownload, managementHistory, previewManagementAgreement, previewManagementAgreementPdf, saveManagementTemplate, updateManagementAgreement } from "./property-management-agreement.service";

const tenancyRoutes = new Hono<{ Variables: { session: TenancySession } }>();

tenancyRoutes.get("/management-agreement-templates", requirePermission("agreement.view"), async (c) => c.json({ data: await listManagementTemplates(c.get("session")) }));
tenancyRoutes.post("/management-agreement-templates", requirePermission("agreement.template_manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.name !== "string" || !body.name.trim() || typeof body.contentHtml !== "string") return c.json({ error: "Template name and content are required" }, 400);
  return c.json({ data: await saveManagementTemplate(session, { id: typeof body.id === "string" ? body.id : undefined, name: body.name.trim(), description: typeof body.description === "string" ? body.description : undefined, contentHtml: body.contentHtml, isDefault: body.isDefault === true }) });
});
tenancyRoutes.get("/landlord-tenancies/:id/management-agreement", requirePermission("agreement.view"), async (c) => { const draft = await getOrCreateManagementAgreement(c.get("session"), c.req.param("id")); if (!draft) return c.json({ error: "Owner-property relationship not found" }, 404); return c.json({ data: { draft, history: await managementHistory(c.get("session"), c.req.param("id")) } }); });
tenancyRoutes.put("/management-agreements/:id", requirePermission("agreement.edit"), async (c) => { const session = c.get("session"); const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null; if (typeof body?.contentHtml !== "string" || body.contentHtml.length > 150_000) return c.json({ error: "Agreement content is required" }, 400); const row = await updateManagementAgreement(session, c.req.param("id"), body.contentHtml); return row ? c.json({ data: row }) : c.json({ error: "Editable draft not found" }, 404); });
tenancyRoutes.post("/management-agreements/:id/apply-template", requirePermission("agreement.edit"), async (c) => { const session = c.get("session"); const body = await c.req.json().catch(() => null) as { templateId?: unknown } | null; if (typeof body?.templateId !== "string") return c.json({ error: "Template is required" }, 400); const row = await applyManagementTemplate(session, c.req.param("id"), body.templateId); return row ? c.json({ data: row }) : c.json({ error: "Template or draft not found" }, 404); });
tenancyRoutes.post("/management-agreements/:id/preview", requirePermission("agreement.view"), async (c) => { const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null; if (typeof body?.contentHtml !== "string") return c.json({ error: "Agreement content is required" }, 400); const html = await previewManagementAgreement(c.get("session"), c.req.param("id"), body.contentHtml); return html == null ? c.json({ error: "Agreement not found" }, 404) : c.json({ data: { html } }); });
tenancyRoutes.post("/management-agreements/:id/preview-pdf", requirePermission("agreement.download"), async (c) => { const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null; if (typeof body?.contentHtml !== "string") return c.json({ error: "Agreement content is required" }, 400); const data = await previewManagementAgreementPdf(c.get("session"), c.req.param("id"), body.contentHtml); return data == null ? c.json({ error: "Agreement not found" }, 404) : c.json({ data }); });
tenancyRoutes.post("/management-agreements/:id/generate", requirePermission("agreement.generate"), async (c) => { const session = c.get("session"); const row = await generateManagementAgreement(session, c.req.param("id")); return row ? c.json({ data: row }) : c.json({ error: "Editable draft not found" }, 404); });
tenancyRoutes.get("/management-agreements/:id/download", requirePermission("agreement.download"), async (c) => { const row = await managementAgreementDownload(c.get("session"), c.req.param("id")); return row ? c.json({ data: row }) : c.json({ error: "Generated agreement not found" }, 404); });

tenancyRoutes.get("/agreement-templates", requirePermission("agreement.view"), async (c) => c.json({ data: await listAgreementTemplates(c.get("session")) }));
tenancyRoutes.post("/agreement-templates", requirePermission("agreement.template_manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.name !== "string" || !body.name.trim() || typeof body.contentHtml !== "string") return c.json({ error: "Template name and content are required" }, 400);
  const data = await saveAgreementTemplate(session, { id: typeof body.id === "string" ? body.id : undefined, name: body.name.trim(), description: typeof body.description === "string" ? body.description : undefined, contentHtml: body.contentHtml, isDefault: body.isDefault === true });
  return c.json({ data });
});

tenancyRoutes.get("/tenancies/:tenancyId/agreement", requirePermission("agreement.view"), async (c) => {
  const draft = await getOrCreateAgreement(c.get("session"), c.req.param("tenancyId"));
  if (!draft) return c.json({ error: "Tenancy not found" }, 404);
  const history = await agreementHistory(c.get("session"), c.req.param("tenancyId"));
  return c.json({ data: { draft, history } });
});

tenancyRoutes.put("/agreements/:agreementId", requirePermission("agreement.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null;
  if (typeof body?.contentHtml !== "string" || body.contentHtml.length > 200_000) return c.json({ error: "Agreement content is required" }, 400);
  const row = await updateAgreement(session, c.req.param("agreementId"), body.contentHtml);
  if (!row) return c.json({ error: "Editable draft not found" }, 404);
  return c.json({ data: row });
});

tenancyRoutes.post("/agreements/:agreementId/status", requirePermission("agreement.void"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null) as { status?: unknown } | null;
  if (typeof body?.status !== "string") return c.json({ error: "Agreement status is required" }, 400);
  const row = await transitionAgreement(session, c.req.param("agreementId"), body.status);
  return row ? c.json({ data: row }) : c.json({ error: "Invalid agreement status transition" }, 409);
});

tenancyRoutes.post("/agreements/:agreementId/apply-template", requirePermission("agreement.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null) as { templateId?: unknown } | null;
  if (typeof body?.templateId !== "string") return c.json({ error: "Template is required" }, 400);
  const row = await applyAgreementTemplate(session, c.req.param("agreementId"), body.templateId);
  if (!row) return c.json({ error: "Template or editable draft not found" }, 404);
  return c.json({ data: row });
});

tenancyRoutes.post("/agreements/:agreementId/preview", requirePermission("agreement.view"), async (c) => {
  const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null;
  if (typeof body?.contentHtml !== "string") return c.json({ error: "Agreement content is required" }, 400);
  const html = await previewAgreement(c.get("session"), c.req.param("agreementId"), body.contentHtml);
  if (html == null) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ data: { html } });
});

tenancyRoutes.post("/agreements/:agreementId/preview-pdf", requirePermission("agreement.download"), async (c) => {
  const body = await c.req.json().catch(() => null) as { contentHtml?: unknown } | null;
  if (typeof body?.contentHtml !== "string") return c.json({ error: "Agreement content is required" }, 400);
  const data = await previewAgreementPdf(c.get("session"), c.req.param("agreementId"), body.contentHtml);
  if (!data) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ data });
});

tenancyRoutes.post("/agreements/:agreementId/generate", requirePermission("agreement.generate"), async (c) => {
  const session = c.get("session");
  const row = await generateAgreement(session, c.req.param("agreementId"));
  if (!row) return c.json({ error: "Editable draft not found" }, 404);
  return c.json({ data: row });
});

tenancyRoutes.get("/agreements/:agreementId/download", requirePermission("agreement.download"), async (c) => {
  const row = await agreementDownload(c.get("session"), c.req.param("agreementId"));
  if (!row) return c.json({ error: "Generated agreement not found" }, 404);
  return c.json({ data: row });
});

// Read-only first-month rent preview. A pure calculation (no DB read, no
// mutation) that reuses computeProratedRent so the admin sees exactly what the
// poster will charge. Optional query params; a missing/invalid date yields a
// 400 rather than a surprising number.
tenancyRoutes.get("/tenancies/rent-preview", requirePermission("tenancy.view"), (c) => {
  const q = c.req.query();
  const rent = Number(q.monthlyRent);
  if (!q.startDate || !Number.isFinite(rent) || rent < 0) {
    return c.json({ error: "monthlyRent (>= 0) and startDate are required" }, 400);
  }
  const startDate = new Date(q.startDate);
  if (Number.isNaN(startDate.getTime())) return c.json({ error: "Invalid startDate" }, 400);
  const endDate = q.endDate ? new Date(q.endDate) : null;
  if (endDate && Number.isNaN(endDate.getTime())) return c.json({ error: "Invalid endDate" }, 400);
  const rentInvoiceStartDate = q.rentInvoiceStartDate ? new Date(q.rentInvoiceStartDate) : null;
  if (rentInvoiceStartDate && Number.isNaN(rentInvoiceStartDate.getTime())) {
    return c.json({ error: "Invalid rentInvoiceStartDate" }, 400);
  }
  const preview = previewFirstMonthRent({ monthlyRent: rent, startDate, endDate, rentInvoiceStartDate });
  const isCommission = q.firstMonthIsCommission === "true";
  const sstBearer = q.commissionSstBearer === "kaen" ? "kaen" : "owner";
  const commission = computeFirstMonthCommission({ monthlyRent: rent, startDate, endDate, isCommission, sstBearer });
  return c.json({ data: preview, commission });
});

tenancyRoutes.get("/landlord-tenancies", requirePermission("tenancy.view"), async (c) => {
  const data = await getLandlordTenanciesService(c.get("session"));
  return c.json({ data });
});

tenancyRoutes.post("/landlord-tenancies/sync-managed", requirePermission("tenancy.edit"), async (c) => {
  const session = c.get("session");
  return c.json({ data: await syncManagedOwnerAgreementRecordsService(session) });
});

tenancyRoutes.post("/landlord-tenancies", requirePermission("tenancy.create"), async (c) => {
  const session = c.get("session");
  const parsed = createLandlordTenancySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createLandlordTenancyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json(result.data, result.status as 201);
});

tenancyRoutes.put("/landlord-tenancies/:landlordTenancyId/status", requirePermission("tenancy.edit"), async (c) => {
  const session = c.get("session");
  const parsed = updateLandlordTenancyStatusSchema.safeParse({ ...(await c.req.json()), landlordTenancyId: c.req.param("landlordTenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateLandlordTenancyStatusService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

tenancyRoutes.get("/tenancies", requirePermission("tenancy.view"), async (c) => {
  const data = await getTenanciesService(c.get("session"));
  return c.json({ data });
});

tenancyRoutes.post("/tenancies", requirePermission("tenancy.create"), async (c) => {
  const session = c.get("session");
  const parsed = createTenancySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createTenancyService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      {
        error: result.error,
        ...("code" in result ? { code: result.code } : {}),
        ...("incumbent" in result && result.incumbent ? { incumbent: result.incumbent } : {}),
        ...("existingTenancyId" in result ? { existingTenancyId: result.existingTenancyId } : {}),
      },
      result.status as 400 | 403 | 404 | 409 | 422,
    );
  }
  return c.json(result.data, result.status as 201);
});

tenancyRoutes.put("/tenancies/:tenancyId", requirePermission("tenancy.edit"), async (c) => {
  const session = c.get("session");
  const parsed = updateTenancySchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateTenancyService(session, parsed.data);
  if (!result.ok) {
    return c.json(
      { error: result.error, ...("code" in result ? { code: result.code } : {}) },
      result.status as 400 | 403 | 404 | 409 | 422,
    );
  }
  return c.json(result.data);
});

tenancyRoutes.post("/tenancies/:tenancyId/renew", requirePermission("tenancy.renew"), async (c) => {
  const session = c.get("session");
  const parsed = renewTenancySchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await renewTenancyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data, result.status as 201);
});

tenancyRoutes.post("/tenancies/:tenancyId/cancel-renewal", requirePermission("tenancy.cancel_renewal"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = cancelRenewalSchema.safeParse({ ...body, tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const result = await cancelRenewalService(c.get("session"), parsed.data);
    if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
    return c.json({ data: result.data });
  } catch (error) {
    if (error instanceof Error && error.message === "PREVIOUS_TENANCY_NOT_FOUND") {
      return c.json({ error: "The original tenancy record could not be restored" }, 409);
    }
    throw error;
  }
});

tenancyRoutes.post("/tenancies/:tenancyId/move-out", requirePermission("tenancy.move"), async (c) => {
  const session = c.get("session");
  const parsed = moveOutTenancySchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await moveOutTenancyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data);
});

tenancyRoutes.put("/tenancies/:tenancyId/renewal-review", requirePermission("tenancy.renew"), async (c) => {
  const session = c.get("session");
  const parsed = updateRenewalReviewSchema.safeParse({ ...(await c.req.json()), tenancyId: c.req.param("tenancyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "tenancy" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateRenewalReviewService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

export { tenancyRoutes };
