import { Hono } from "hono";
import { z } from "zod";
import type { PartiesSession } from "./parties.types";
import {
  blacklistOwnerSchema,
  blacklistTenantSchema,
  reactivateOwnerSchema,
  reactivateTenantSchema,
  createOwnerSchema,
  createTenantSchema,
  updateOwnerSchema,
  updateTenantSchema,
  createAgentSchema,
  updateAgentSchema,
  blacklistAgentSchema,
  reactivateAgentSchema,
  deactivateAgentSchema,
  activateAgentSchema,
  revokePortalAccessSchema,
  resetPortalPasswordSchema,
  setPartyStatusSchema,
} from "./parties.validation";
import {
  blacklistOwnerService,
  blacklistTenantService,
  reactivateOwnerService,
  reactivateTenantService,
  createOwnerService,
  createPortalAccessService,
  createTenantService,
  getOwnersService,
  getTenantsService,
  getTenantDetailService,
  getOwnerDetailService,
  updateOwnerService,
  updateTenantService,
  getAgentsService,
  listAssignableMembersService,
  createAgentService,
  updateAgentService,
  blacklistAgentService,
  reactivateAgentService,
  deactivateAgentService,
  activateAgentService,
  getAgentDetailService,
  revokePortalAccessService,
  resetPortalPasswordService,
  getAgentHierarchyService,
  getAncestorsService,
  getDownlinesService,
  setUplineService,
  searchTenantsService,
  searchOwnersService,
  setPartyStatusService,
  deletePartyByRoleService,
} from "./parties.service";
import { requirePermission } from "../../middleware/require-permission";
import { formatZodError } from "../../lib/zod-error-mapper";
import { icRevealBodySchema } from "@kason/shared";
import { recordIcRevealService } from "../../lib/ic-reveal";

const partiesRoutes = new Hono<{ Variables: { session: PartiesSession } }>();

// Non-ok service results (409 conflicts, 404s) may carry a `fieldErrors` map so
// the client can turn the offending input red — mirroring the Zod-400 branch,
// which already sends { error, fieldErrors }. Spread it only when present so
// 404s and field-less conflicts keep their lean { error } shape.
function errorBody(result: { error: string; fieldErrors?: Record<string, string> }) {
  return result.fieldErrors
    ? { error: result.error, fieldErrors: result.fieldErrors }
    : { error: result.error };
}

partiesRoutes.get("/owners", requirePermission("party.view"), async (c) => c.json({ data: await getOwnersService(c.get("session")) }));
partiesRoutes.get("/tenants", requirePermission("party.view"), async (c) => c.json({ data: await getTenantsService(c.get("session")) }));
partiesRoutes.get("/tenants/search", requirePermission("party.view"), async (c) => {
  const q = c.req.query("q") ?? undefined;
  const takeRaw = c.req.query("take");
  const take = takeRaw ? Math.min(Math.max(parseInt(takeRaw, 10) || 0, 1), 20) : undefined;
  const result = await searchTenantsService(c.get("session"), q, take);
  return c.json(result);
});

partiesRoutes.get("/owners/search", requirePermission("party.view"), async (c) => {
  const q = c.req.query("q") ?? undefined;
  const takeRaw = c.req.query("take");
  const take = takeRaw ? Math.min(Math.max(parseInt(takeRaw, 10) || 0, 1), 20) : undefined;
  const result = await searchOwnersService(c.get("session"), q, take);
  return c.json(result);
});

// Tenant detail — returns all tenant fields with IC masked.
// Registered after /tenants/search so the literal "search" segment is never
// consumed by the :partyId parameter. Manager+ via the module gate.
partiesRoutes.get("/tenants/:partyId", requirePermission("party.view"), async (c) => {
  const r = await getTenantDetailService(c.get("session"), c.req.param("partyId"));
  return r.ok ? c.json({ data: r.data }, 200) : c.json({ error: r.error }, r.status);
});

// Owner detail — returns all owner fields with IC masked, plus bank info and
// units owned. Registered after /owners/search so the literal "search" segment
// is never consumed by the :partyId parameter. Manager+ via the module gate.
partiesRoutes.get("/owners/:partyId", requirePermission("party.view"), async (c) => {
  const r = await getOwnerDetailService(c.get("session"), c.req.param("partyId"));
  return r.ok ? c.json({ data: r.data }, 200) : c.json({ error: r.error }, r.status);
});

// Audited unmasked-IC reveal — non-flag-gated (Inventory is always-on, unlike
// the tenant-tracker reveal which sits behind ENABLE_PHASE2_TENANT_TRACKER).
// Reuses the shared lib/ic-reveal service so the audit row (one per reveal, in
// the same tx) is identical to the tracker path. Manager+ via the module gate.
partiesRoutes.post("/:partyId/ic-reveal", requirePermission("party.sensitive.view"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  const parsed = icRevealBodySchema.safeParse({ ...(body ?? {}), partyId: c.req.param("partyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await recordIcRevealService(session, parsed.data.partyId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data, result.status as 200);
});

partiesRoutes.post("/owners", requirePermission("party.create"), async (c) => {
  const session = c.get("session");
  const parsed = createOwnerSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createOwnerService(session, parsed.data);
  if (!result.ok) return c.json(errorBody(result), result.status as 409);
  return c.json(result.data, result.status as 201);
});

partiesRoutes.put("/owners/:partyId", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const parsed = updateOwnerSchema.safeParse({ ...(await c.req.json()), partyId: c.req.param("partyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateOwnerService(session, parsed.data);
  if (!result.ok) return c.json(errorBody(result), result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/owners/:partyId/blacklist", requirePermission("party.blacklist"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = blacklistOwnerSchema.safeParse({ partyId: c.req.param("partyId"), reason: body.reason });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await blacklistOwnerService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/tenants", requirePermission("party.create"), async (c) => {
  const session = c.get("session");
  const parsed = createTenantSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createTenantService(session, parsed.data);
  if (!result.ok) return c.json(errorBody(result), result.status as 409);
  return c.json(result.data, result.status as 201);
});

partiesRoutes.put("/tenants/:partyId", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const parsed = updateTenantSchema.safeParse({ ...(await c.req.json()), partyId: c.req.param("partyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateTenantService(session, parsed.data);
  if (!result.ok) return c.json(errorBody(result), result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/tenants/:partyId/blacklist", requirePermission("party.blacklist"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = blacklistTenantSchema.safeParse({ partyId: c.req.param("partyId"), reason: body.reason });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await blacklistTenantService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/tenants/:partyId/reactivate", requirePermission("party.blacklist"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = reactivateTenantSchema.safeParse({ partyId: c.req.param("partyId"), note: body.note, status: body.status });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await reactivateTenantService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/owners/:partyId/reactivate", requirePermission("party.blacklist"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = reactivateOwnerSchema.safeParse({ partyId: c.req.param("partyId"), note: body.note, status: body.status });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await reactivateOwnerService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json(result.data);
});

partiesRoutes.post("/tenants/:partyId/set-status", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = setPartyStatusSchema.safeParse({ partyId: c.req.param("partyId"), status: body.status });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await setPartyStatusService(session, "tenant", parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json(result.data);
});

partiesRoutes.post("/owners/:partyId/set-status", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = setPartyStatusSchema.safeParse({ partyId: c.req.param("partyId"), status: body.status });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await setPartyStatusService(session, "owner", parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json(result.data);
});

const portalAccessSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(1),
});

partiesRoutes.post("/:partyId/portal-access", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const parsed = portalAccessSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createPortalAccessService(
    { orgId: session.orgId },
    c.req.param("partyId"),
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json(result.data, 201);
});

// Allowed agentLevel values for query-param filters. Kept in one place so we
// can't accidentally let clients inject arbitrary SQL-ish values into the
// Prisma `in` filter via excludeLevel / onlyLevel.
const VALID_AGENT_LEVELS = new Set(["leader", "pre_leader", "new_agent"]);
function parseLevelList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  const safe = values.filter((v) => VALID_AGENT_LEVELS.has(v));
  return safe.length > 0 ? safe : undefined;
}

partiesRoutes.get("/agents", requirePermission("roles.manage"), async (c) => {
  const q = c.req.query("q") ?? undefined;
  const takeRaw = c.req.query("take");
  const take = takeRaw ? Math.min(Math.max(parseInt(takeRaw, 10) || 0, 1), 100) : undefined;
  const teamLeaderId = c.req.query("teamLeaderId") ?? undefined;
  const teamScope = c.req.query("teamScope") === "indirect" ? "indirect" : "direct";
  const excludeLevel = parseLevelList(c.req.query("excludeLevel"));
  const onlyLevel = parseLevelList(c.req.query("onlyLevel"));
  const data = await getAgentsService(c.get("session"), {
    q, take, teamLeaderId, teamScope, excludeLevel, onlyLevel,
  });
  return c.json({ data });
});

// Typeahead for ANY assignable org member (agents + managers + admins +
// super-admins). The Unit "in-charge" + "hidden from" pickers use this so
// non-agent staff can be selected — Unit.inChargePartyId is FK→Party.id and
// accepts any partyType.
partiesRoutes.get("/assignable", requirePermission("portfolio.view"), async (c) => {
  const q = c.req.query("q") ?? undefined;
  const takeRaw = c.req.query("take");
  const take = takeRaw ? Math.min(Math.max(parseInt(takeRaw, 10) || 0, 1), 50) : undefined;
  // Comma-separated allow-list. The Unit dialog narrows the Sourcing-agent
  // picker to `partyType=agent` and the In-charge picker to
  // `partyType=agent,individual`, so tenants/owners stop leaking into the
  // pickers (client report 2026-05-22). Empty list = original behaviour.
  const partyTypesRaw = c.req.query("partyType") ?? c.req.query("partyTypes") ?? "";
  const partyTypes = partyTypesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result = await listAssignableMembersService(
    c.get("session"),
    q,
    take,
    partyTypes.length > 0 ? partyTypes : undefined,
  );
  return c.json(result);
});

partiesRoutes.get("/agents/hierarchy", requirePermission("roles.manage"), async (c) => {
  const raw = c.req.query("includeDeactivated");
  const includeDeactivated = raw === "1" || raw === "true";
  const data = await getAgentHierarchyService(c.get("session"), { includeDeactivated });
  return c.json({ data });
});

// Generic upline edit for any party that legitimately sits in the org tree
// (agents + staff individuals). Used by the admin drawer to place
// managers/editors in the reporting chain. Body: { uplineId: string | null }.
partiesRoutes.put("/:partyId/upline", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const partyId = c.req.param("partyId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const newUplineId =
    body && typeof body === "object" && "uplineId" in body
      ? (body as { uplineId: string | null }).uplineId
      : undefined;
  if (newUplineId !== null && typeof newUplineId !== "string") {
    return c.json({ error: "uplineId must be a string or null" }, 400);
  }
  const result = await setUplineService(session, partyId, newUplineId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404);
  return c.json({ ok: true, updatedAt: result.updatedAt });
});

partiesRoutes.get("/agents/:partyId/ancestors", requirePermission("roles.manage"), async (c) => {
  const data = await getAncestorsService(c.get("session"), c.req.param("partyId"));
  return c.json({ data });
});

partiesRoutes.get("/agents/:partyId/downlines", requirePermission("roles.manage"), async (c) => {
  const depth = c.req.query("depth") === "all" ? "all" : "1";
  const data = await getDownlinesService(c.get("session"), c.req.param("partyId"), depth);
  return c.json({ data });
});

partiesRoutes.post("/agents", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const parsed = createAgentSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createAgentService(session, parsed.data);
  // 409 path covers OrgCardSettingsNotConfiguredError when caller supplied
  // a `title` but the org has not yet configured E-Namecard settings.
  if (!result.ok) return c.json({ error: result.error }, result.status as 409);
  return c.json(result.data, result.status as 201);
});

partiesRoutes.put("/agents/:partyId", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const parsed = updateAgentSchema.safeParse({ ...(await c.req.json()), partyId: c.req.param("partyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await updateAgentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  // Flat-shape response (matches the established PUT pattern in this module).
  // `restructured` is added at top level only when present, so old clients
  // that ignore the field stay compatible.
  const restructured = "restructured" in result ? result.restructured : undefined;
  return c.json({
    ...result.data,
    ...(restructured ? { restructured } : {}),
  });
});

partiesRoutes.post("/agents/:partyId/blacklist", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = blacklistAgentSchema.safeParse({ partyId: c.req.param("partyId"), reason: body.reason, updatedAt: body.updatedAt });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await blacklistAgentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.post("/agents/:partyId/reactivate", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = reactivateAgentSchema.safeParse({
    partyId: c.req.param("partyId"),
    note: body.note,
    updatedAt: body.updatedAt,
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await reactivateAgentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.post("/agents/:partyId/deactivate", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = deactivateAgentSchema.safeParse({
    partyId: c.req.param("partyId"),
    note: body.note,
    updatedAt: body.updatedAt,
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await deactivateAgentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.post("/agents/:partyId/activate", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = activateAgentSchema.safeParse({
    partyId: c.req.param("partyId"),
    note: body.note,
    updatedAt: body.updatedAt,
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await activateAgentService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.get("/agents/:partyId", requirePermission("roles.manage"), async (c) => {
  const session = c.get("session");
  const result = await getAgentDetailService(session, c.req.param("partyId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

partiesRoutes.delete("/:partyId/portal-access", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => ({}));
  const parsed = revokePortalAccessSchema.safeParse({
    partyId: c.req.param("partyId"),
    updatedAt: body.updatedAt,
  });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await revokePortalAccessService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.post("/:partyId/reset-portal-password", requirePermission("party.edit"), async (c) => {
  const session = c.get("session");
  const partyId = c.req.param("partyId");
  const parsed = resetPortalPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "parties" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await resetPortalPasswordService(session, partyId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404);
  return c.json({ ok: true, message: "Portal password reset." });
});

partiesRoutes.delete("/tenants/:partyId", requirePermission("important_record.delete"), async (c) => {
  const result = await deletePartyByRoleService(c.get("session"), "tenant", c.req.param("partyId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

partiesRoutes.delete("/owners/:partyId", requirePermission("important_record.delete"), async (c) => {
  const result = await deletePartyByRoleService(c.get("session"), "owner", c.req.param("partyId"));
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

export { partiesRoutes };
