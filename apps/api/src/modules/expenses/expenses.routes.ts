// apps/api/src/modules/expenses/expenses.routes.ts
// Accounting-document redesign P3 — POST /api/expenses (internal Expense, EXP-).
// Thin plumbing: flag-gate (canonical 404 while ENABLE_SUPPLIER_EXPENSES is dark,
// BEFORE auth — owner-remittance.routes.ts:32-35 precedent) → requireRole(editor)
// → zod parse → createSupplierExpenseService → forward the service's {status,code}.
import { Hono } from "hono";
import type { Context } from "hono";
import { supplierExpenseInput } from "@kason/shared";
import { z } from "zod";
import type { SessionPayload } from "../../lib/auth";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireAnyPermission, requirePermission, userHasPermission } from "../../middleware/require-permission";
import { getActorHeaders } from "../../lib/actor-ctx";
import { approveEmployeeClaimService, assignSharedCostService, createSupplierExpenseService, ExpenseError, listSupplierExpensesService, type ExpenseActorCtx } from "./expenses.service";

const expensesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

type ExpensesCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: ExpensesCtx): ExpenseActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: session.role, ip, userAgent };
}

expensesRoutes.get("/", requireAnyPermission("claim.create", "claim.view_all", "cost.view"), async (c) => {
  const session = c.get("session");
  const [canViewAllClaims, canViewCosts] = await Promise.all([
    userHasPermission(session, "claim.view_all"),
    userHasPermission(session, "cost.view"),
  ]);
  return c.json({
    data: await listSupplierExpensesService(actor(c), {
      ownOnly: !canViewAllClaims && !canViewCosts,
    }),
  });
});

expensesRoutes.post("/", requirePermission("claim.create"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = supplierExpenseInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const data = await createSupplierExpenseService(actor(c), parsed.data);
    return c.json({ data }, 201);
  } catch (e) {
    if (e instanceof ExpenseError) return c.json({ error: e.code }, e.status as 400 | 500);
    throw e;
  }
});

expensesRoutes.post("/:id/approve", requirePermission("claim.approve"), async (c) => {
  try { return c.json({ data: await approveEmployeeClaimService(actor(c), c.req.param("id")) }); }
  catch (e) { if (e instanceof ExpenseError) return c.json({ error: e.code }, e.status as 404 | 409); throw e; }
});

const assignmentInput = z.object({ apartmentId: z.string().uuid(), gridExpenseId: z.string().uuid().nullable().optional(), amount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((value) => Number(value) > 0), description: z.string().max(500).nullable().optional() });
expensesRoutes.post("/:id/assignments", requirePermission("cost.create"), async (c) => {
  const parsed = assignmentInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_assignment", details: parsed.error.flatten() }, 400);
  try { return c.json({ data: await assignSharedCostService(actor(c), c.req.param("id"), parsed.data) }, 201); }
  catch (e) { if (e instanceof ExpenseError) return c.json({ error: e.code }, e.status as 404 | 409); throw e; }
});

export { expensesRoutes };
