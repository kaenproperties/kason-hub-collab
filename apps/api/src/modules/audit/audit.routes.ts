import { Hono } from "hono";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission } from "../../middleware/require-permission";
import { listAuditQuery } from "./audit.types";
import { listAudit } from "./audit.service";
import type { AdminRole } from "../../lib/rbac";
import { formatZodError } from "../../lib/zod-error-mapper";

const auditRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Defence-in-depth: route-level gate + service-level atLeast() check.
auditRoutes.use("*", requirePermission("audit.view"));

auditRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = listAuditQuery.safeParse(c.req.query());
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const q = parsed.data;

  try {
    const result = await listAudit({
      orgId: session.orgId,
      role: session.role as AdminRole,
      filters: q,
      page: q.page,
      pageSize: q.pageSize,
    });
    return c.json({
      rows: result.rows,
      total: result.total,
      page: q.page,
      pageSize: q.pageSize,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/forbidden/i.test(message)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    throw err;
  }
});

export { auditRoutes };
