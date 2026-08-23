import { Hono } from "hono";
import type { InventorySession } from "./inventory.types";
import {
  createPropertyService,
  createUnitService,
  createUnitsBatchService,
  getApartmentsByPropertyService,
  getInventoryPropertiesService,
  getInventoryPropertyByIdService,
  getInventorySummaryService,
  getInventoryUnitByIdService,
  getInventoryUnitsService,
  searchApartmentsService,
  updatePropertyService,
  updateUnitService,
} from "./inventory.service";
import { createUnitsBatchSchema } from "@kason/shared";
import {
  createPropertySchema,
  createUnitSchema,
  updatePropertySchema,
  updateUnitSchema,
} from "./inventory.validation";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requirePermission } from "../../middleware/require-permission";

const inventoryRoutes = new Hono<{ Variables: { session: InventorySession } }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

inventoryRoutes.get("/summary", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const data = await getInventorySummaryService(session);
  return c.json({ data });
});

inventoryRoutes.get("/properties", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const data = await getInventoryPropertiesService(session);
  return c.json({ data });
});

inventoryRoutes.post("/properties", requirePermission("portfolio.create"), async (c) => {
  const session = c.get("session");

  const body = await c.req.json();
  const parsed = createPropertySchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await createPropertyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data, result.status as 201);
});

// The legacy `/properties/source-queue`, `/properties/:id/approve`,
// `/properties/:id/reject`, and `/source-queue` (units) routes are
// intentionally removed in this refactor — pending agent submissions now
// live in UnitSubmission / PropertySubmission and surface via the
// submission module's routes. The new routes will be wired in a follow-up
// task (post C-series). This module strictly serves the approved-inventory
// tree (Property + Apartment + Listing).

inventoryRoutes.get("/properties/:propertyId", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const propertyId = c.req.param("propertyId");
  if (!UUID_RE.test(propertyId)) return c.json({ error: "Invalid property id" }, 400);
  const result = await getInventoryPropertyByIdService(session, propertyId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

inventoryRoutes.put("/properties/:propertyId", requirePermission("portfolio.edit"), async (c) => {
  const session = c.get("session");

  const body = await c.req.json();
  const parsed = updatePropertySchema.safeParse({ ...body, propertyId: c.req.param("propertyId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await updatePropertyService(session, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404 | 409);
  return c.json(result.data);
});

inventoryRoutes.get("/units", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const q = c.req.query("q") ?? undefined;
  const status = c.req.query("status") ?? undefined;
  const data = await getInventoryUnitsService(session, { q, status });
  return c.json({ data });
});

inventoryRoutes.get("/units/:id", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Invalid unit id" }, 400);
  const result = await getInventoryUnitByIdService(session, id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Free-text apartment search (label→id) for pickers, e.g. the meter bill
// drawer picks an Apartment by unitCode. Registered BEFORE the longer
// "/apartments/by-property/:propertyId" path; Hono matches static segments so
// the exact "/apartments" never shadows it.
inventoryRoutes.get("/apartments", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const q = c.req.query("q") ?? undefined;
  const data = await searchApartmentsService(session, { q });
  return c.json({ data });
});

// Apartment-grouped view of a property. Used by the property page to
// render rooms grouped under their apartment + by the +Rooms typeahead
// to detect existing apartments when admin adds a new room.
inventoryRoutes.get("/apartments/by-property/:propertyId", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const propertyId = c.req.param("propertyId");
  if (!UUID_RE.test(propertyId)) {
    return c.json({ error: "Invalid property id" }, 400);
  }
  const result = await getApartmentsByPropertyService(session, propertyId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);
  return c.json({ data: result.data });
});

// Admin multi-room batch — atomic create of N rooms sharing one apartment.
// Registered BEFORE POST /units/:unitId so the literal /batch path takes
// priority.
inventoryRoutes.post("/units/batch", requirePermission("portfolio.create"), async (c) => {
  const session = c.get("session");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const parsed = createUnitsBatchSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await createUnitsBatchService(session, parsed.data);
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    // Additively surface a TOP-LEVEL `code` (e.g. the 409 APARTMENT_OWNER_CONFLICT
    // the service returns) so the client can branch on it, matching POST /units.
    // The nested-code 400 branch above is unchanged, and the PUT handler is
    // deliberately left untouched.
    return c.json(
      { error: result.error, ...("code" in result ? { code: result.code } : {}) },
      result.status as 400 | 403 | 404 | 409,
    );
  }
  return c.json({ data: result.data }, result.status as 201);
});

inventoryRoutes.post("/units", requirePermission("portfolio.create"), async (c) => {
  const session = c.get("session");

  const body = await c.req.json();
  const parsed = createUnitSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  // B4 diagnostic: the global error handler logs the exception but loses
  // the request context. Log the full Prisma-aware error shape with the
  // request payload so the cause of "Internal server error" toasts is
  // recoverable from API logs after the user reproduces the failure.
  let result;
  try {
    result = await createUnitService(session, parsed.data);
  } catch (e) {
    const err = e as { name?: string; message?: string; code?: string; meta?: unknown };
    console.error("[inventory.create-unit] service threw", {
      errName: err?.constructor?.name ?? err?.name,
      message: err?.message,
      prismaCode: err?.code,
      prismaMeta: err?.meta,
      orgId: session.orgId,
      userId: session.userId,
      payload: {
        propertyId: parsed.data.propertyId,
        unitCode: parsed.data.unitCode,
        unitType: parsed.data.unitType,
        listingStatus: parsed.data.listingStatus,
      },
    });
    throw e;
  }
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    // Additively surface a TOP-LEVEL `code` (e.g. the 409 UNIT_HAS_NO_OWNER the
    // service returns) so the client can branch on it, matching the other
    // no-owner call sites. The nested-code 400 branch above is unchanged, and
    // the PUT handler is deliberately left untouched.
    return c.json(
      { error: result.error, ...("code" in result ? { code: result.code } : {}) },
      result.status as 400 | 403 | 404 | 409,
    );
  }
  const warnings = result.coercedToDraft
    ? [
        `Saved as Draft — fill ${result.missingFields.join(", ")} to publish.`,
      ]
    : undefined;
  return c.json({ ...result.data, ...(warnings ? { warnings } : {}) }, result.status as 201);
});

inventoryRoutes.put("/units/:unitId", requirePermission("portfolio.edit"), async (c) => {
  const session = c.get("session");

  const body = await c.req.json();
  const parsed = updateUnitSchema.safeParse({ ...body, unitId: c.req.param("unitId") });
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "inventory" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await updateUnitService(session, parsed.data);
  if (!result.ok) {
    if (result.status === 400 && typeof result.error === "object" && result.error !== null && "code" in result.error) {
      return c.json(result.error, 400);
    }
    // Surface a TOP-LEVEL `code` (e.g. COMMISSION_FIELDS_FORBIDDEN/LOCKED) so the
    // web form can branch on it, matching POST /units + /units/batch.
    return c.json(
      { error: result.error, ...("code" in result ? { code: result.code } : {}) },
      result.status as 400 | 403 | 404 | 409,
    );
  }
  const warnings = result.coercedToDraft
    ? [
        `Saved as Draft — fill ${result.missingFields.join(", ")} to publish.`,
      ]
    : undefined;
  return c.json({ ...result.data, ...(warnings ? { warnings } : {}) });
});

export { inventoryRoutes };
