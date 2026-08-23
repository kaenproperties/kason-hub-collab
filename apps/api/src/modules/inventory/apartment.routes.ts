// apps/api/src/modules/inventory/apartment.routes.ts
//
// Admin HTTP surface for apartment-level mutations. The business logic
// lives in `apartment.service.ts`; this file maps that logic to URL paths.
//
// Mounted at `/api/apartments` in `app.ts`. Distinct from the
// `/api/inventory/apartments/by-property/:id` listing route, which lives
// on the inventory router — these are mutating ops, with their own
// service module and a top-level URL prefix to match.
//
// Spec: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md
//       §Admin apartment ops

import { Hono } from "hono";
import { updateApartmentSharedSchema } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import {
  flipApartmentModeService,
  updateApartmentSharedService,
} from "./apartment.service";

const apartmentRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Both flip-mode and shared-edit are manager+ ops (matches the listings
// module's mutation gate).
apartmentRoutes.use("*", requirePermission("portfolio.edit"));

// POST /api/apartments/:id/flip-mode
// Body: { targetMode: "WHOLE" | "PARTITIONED" }
apartmentRoutes.post("/:id/flip-mode", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req
    .json<{ targetMode?: string }>()
    .catch(() => ({}) as { targetMode?: string });
  const targetMode = body.targetMode;
  if (targetMode !== "WHOLE" && targetMode !== "PARTITIONED") {
    return c.json(
      { error: "targetMode required: WHOLE | PARTITIONED" },
      400,
    );
  }
  const result = await flipApartmentModeService(
    { orgId: session.orgId, userId: session.userId },
    id,
    targetMode,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409 | 422);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// PATCH /api/apartments/:id/shared
// Body: UpdateApartmentSharedInput (all fields optional; only keys present are written).
apartmentRoutes.patch("/:id/shared", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateApartmentSharedSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const result = await updateApartmentSharedService(
    { orgId: session.orgId, userId: session.userId },
    id,
    parsed.data,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404);
  }
  return c.json({ data: result.data }, result.status as 200);
});

export { apartmentRoutes };
