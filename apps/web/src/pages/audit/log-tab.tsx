import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { usePermission } from "@/components/permission-gate";
import {
  PageHeader,
  Surface,
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatDateTimeMY } from "@/components/format";
import { filterControlClass } from "@/components/list-filter-bar";

export type AuditLogRow = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceName: string | null;
  createdAt: string;
};

type AuditLogResponse = {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
};

type Filters = {
  entityType: string;
  actorUserId: string;
  action: string;
  from: string; // date input value (YYYY-MM-DD), converted to ISO on the fly
  to: string;
};

const PAGE_SIZE = 50;

function toIsoFrom(date: string): string | undefined {
  if (!date) return undefined;
  // date input yields YYYY-MM-DD; anchor at start of day UTC.
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toIsoTo(date: string): string | undefined {
  if (!date) return undefined;
  // Anchor "to" at end of day UTC for inclusive semantics.
  const d = new Date(`${date}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default function AuditLogPage() {
  const canViewAudit = usePermission("audit.view");

  const [filters, setFilters] = useState<Filters>({
    entityType: "",
    actorUserId: "",
    action: "",
    from: "",
    to: "",
  });
  const [page, setPage] = useState(1);

  // Build query params from filters. Only include non-empty values.
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    if (filters.entityType.trim()) params.set("entityType", filters.entityType.trim());
    if (filters.actorUserId.trim()) params.set("actorUserId", filters.actorUserId.trim());
    if (filters.action.trim()) params.set("action", filters.action.trim());
    const fromIso = toIsoFrom(filters.from);
    const toIso = toIsoTo(filters.to);
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    return params.toString();
  }, [filters, page]);

  const audit = useQuery<AuditLogResponse>({
    queryKey: ["audit-log", queryString],
    queryFn: () => apiFetch<AuditLogResponse>(`/audit-log?${queryString}`),
    enabled: canViewAudit,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  // Manager+ gate — inline check. A project-wide RoleGate will replace this later (T2.3).
  if (!canViewAudit) {
    return (
      <div className="space-y-6">
        <PageHeader title="Audit log" description="Rolling 10-day history of admin actions." />
        <Surface>
          <div className="py-10 text-center">
            <p className="text-sm font-semibold text-[var(--text-primary)]">Forbidden</p>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              You do not have permission to view the audit log.
            </p>
          </div>
        </Surface>
      </div>
    );
  }

  const rows = audit.data?.rows ?? [];
  const total = audit.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIdx = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(page * PAGE_SIZE, total);

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  function resetFilters() {
    setFilters({ entityType: "", actorUserId: "", action: "", from: "", to: "" });
    setPage(1);
  }

  const hasActiveFilters =
    filters.entityType !== "" ||
    filters.actorUserId !== "" ||
    filters.action !== "" ||
    filters.from !== "" ||
    filters.to !== "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Rolling 10-day history of admin actions across this organization. Manager+ only. Times shown in Malaysia time (GMT+8)."
        metrics={[
          { label: "Total records", value: String(total), hint: "Matching current filters" },
          { label: "Page", value: `${page} / ${totalPages}`, hint: `${PAGE_SIZE} rows per page` },
          {
            label: "Showing",
            value: total === 0 ? "0" : `${startIdx}–${endIdx}`,
            hint: "Range on this page",
          },
        ]}
      />

      <Surface
        title="Filter records"
        description="Server-side filtering. Dates are treated as inclusive day ranges (UTC)."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Entity type
            </span>
            <input
              type="text"
              value={filters.entityType}
              onChange={(e) => update("entityType", e.target.value)}
              placeholder="claim, agent, tenancy…"
              className={filterControlClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Actor user id
            </span>
            <input
              type="text"
              value={filters.actorUserId}
              onChange={(e) => update("actorUserId", e.target.value)}
              placeholder="UUID"
              className={filterControlClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Action
            </span>
            <input
              type="text"
              value={filters.action}
              onChange={(e) => update("action", e.target.value)}
              placeholder="claim.approve…"
              className={filterControlClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              From
            </span>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => update("from", e.target.value)}
              className={filterControlClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              To
            </span>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => update("to", e.target.value)}
              className={filterControlClass}
            />
          </label>
        </div>
        {hasActiveFilters && (
          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Reset filters
            </Button>
          </div>
        )}
      </Surface>

      <Surface
        title="Log entries"
        description="Ordered newest first. Retention is 10 days; older entries are purged nightly."
      >
        {audit.isLoading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          </div>
        ) : audit.isError ? (
          <p className="p-6 text-sm text-rose-600">Failed to load audit log. Please refresh.</p>
        ) : (
          <>
            <TableWrap>
              <DataTable>
                <TableHead>
                  <tr>
                    <HeadCell>When</HeadCell>
                    <HeadCell>Actor</HeadCell>
                    <HeadCell>Action</HeadCell>
                    <HeadCell>Entity</HeadCell>
                    <HeadCell>Device</HeadCell>
                    <HeadCell>IP</HeadCell>
                  </tr>
                </TableHead>
                <tbody>
                  {rows.length === 0 ? (
                    <EmptyRow colSpan={6} label="No audit entries match the current filters." />
                  ) : (
                    rows.map((r) => (
                      <Row key={r.id}>
                        <BodyCell className="whitespace-nowrap text-[var(--text-secondary)]">
                          {formatDateTimeMY(r.createdAt)}
                        </BodyCell>
                        <BodyCell>
                          <div className="flex flex-col gap-1">
                            <span className="text-[var(--text-primary)]" title={r.actorUserId}>
                              {r.actorName ?? r.actorUserId.slice(0, 8)}
                            </span>
                            <StatusPill
                              tone={
                                r.actorRole === "admin"
                                  ? "amber"
                                  : r.actorRole === "manager"
                                    ? "sky"
                                    : "slate"
                              }
                            >
                              {r.actorRole}
                            </StatusPill>
                          </div>
                        </BodyCell>
                        <BodyCell className="font-mono text-xs">{r.action}</BodyCell>
                        <BodyCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                              {r.entityType}
                            </span>
                            <span className="text-[var(--text-secondary)]" title={r.entityId}>
                              {r.entityName ?? r.entityId.slice(0, 8)}
                            </span>
                          </div>
                        </BodyCell>
                        <BodyCell className="text-xs text-[var(--text-secondary)]">
                          <span title={r.userAgent ?? undefined}>{r.deviceName ?? "—"}</span>
                        </BodyCell>
                        <BodyCell className="font-mono text-xs text-[var(--text-secondary)]">
                          {r.ip ?? "—"}
                        </BodyCell>
                      </Row>
                    ))
                  )}
                </tbody>
              </DataTable>
            </TableWrap>

            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-[var(--text-muted)]">
                {total === 0 ? "No records" : `Showing ${startIdx}–${endIdx} of ${total}`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || audit.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <span className="text-xs text-[var(--text-secondary)]">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || audit.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Surface>
    </div>
  );
}
