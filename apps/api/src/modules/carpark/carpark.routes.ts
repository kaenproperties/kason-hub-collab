// apps/api/src/modules/carpark/carpark.routes.ts
//
// Admin HTTP surface for carpark-bay management. Business logic lives in
// carpark.service.ts and carpark-assignment.service.ts; this file maps
// that logic to URL paths.
//
// Mounted at `/api/carparks` in `app.ts`. Distinct from the inventory
// routes — these are carpark-specific CRUD + assignment ops with their
// own service module and top-level URL prefix.
//
// Spec: docs/superpowers/specs/2026-06-30-carpark-redesign.md

import { Hono } from "hono";
import {
  createCarparkSchema,
  updateCarparkSchema,
  assignCarparkSchema,
} from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import {
  registerCarparkService,
  listCarparksByApartmentService,
  listAvailableCarparksByPropertyService,
  updateCarparkService,
  deactivateCarparkService,
} from "./carpark.service";
import {
  assignCarparksToTenancyService,
  releaseAssignmentService,
} from "./carpark-assignment.service";

const carparkRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// All carpark mutation/listing endpoints require at least manager role
// (matches the listings and apartment modules' mutation gate).
// GET /api/carparks?apartmentId=…
// List all bays for a given apartment.
carparkRoutes.get("/", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const apartmentId = c.req.query("apartmentId") ?? "";
  if (!apartmentId) {
    return c.json({ error: "apartmentId query param is required" }, 400);
  }
  const result = await listCarparksByApartmentService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    apartmentId,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 422);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// GET /api/carparks/available?propertyId=…
// List available bays across a property (used when assigning to a new tenancy).
// Registered BEFORE /:id routes so "available" is not captured as a path param.
carparkRoutes.get("/available", requirePermission("portfolio.view"), async (c) => {
  const session = c.get("session");
  const propertyId = c.req.query("propertyId") ?? "";
  if (!propertyId) {
    return c.json({ error: "propertyId query param is required" }, 400);
  }
  const result = await listAvailableCarparksByPropertyService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    propertyId,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 422);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// POST /api/carparks
// Register a new carpark bay under a given apartment.
carparkRoutes.post("/", requirePermission("portfolio.create"), async (c) => {
  const session = c.get("session");
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createCarparkSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const result = await registerCarparkService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// POST /api/carparks/assign
// Assign one or more bays to a tenancy.
// Registered BEFORE /:id routes so "assign" is not captured as a path param.
carparkRoutes.post("/assign", requirePermission("tenancy.move"), async (c) => {
  const session = c.get("session");
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = assignCarparkSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const result = await assignCarparksToTenancyService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  }
  return c.json({ data: result.data }, result.status as 201);
});

// POST /api/carparks/assignments/:id/release
// End a single active carpark assignment mid-tenancy (admin-initiated).
carparkRoutes.post("/assignments/:id/release", requirePermission("tenancy.move"), async (c) => {
  const session = c.get("session");
  const assignmentId = c.req.param("id");
  const result = await releaseAssignmentService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    assignmentId,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// PATCH /api/carparks/:id
// Update a bay's label, monthly rate, status, or notes.
// Merges path param as carparkId into the parsed body (tenancy.routes.ts:75 pattern).
carparkRoutes.patch("/:id", requirePermission("portfolio.edit"), async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => ({}));
  const parsed = updateCarparkSchema.safeParse({ ...raw, carparkId: id });
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const result = await updateCarparkService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    parsed.data,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// POST /api/carparks/:id/deactivate
// Deactivate a bay. Blocked (409) if the bay has an active assignment.
carparkRoutes.post("/:id/deactivate", requirePermission("portfolio.delete"), async (c) => {
  const session = c.get("session");
  const carparkId = c.req.param("id");
  const result = await deactivateCarparkService(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    carparkId,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

export { carparkRoutes };
