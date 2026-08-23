import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { allNavItems, canSeeNavItemFor, hasMinRole } from "./navigation";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";

// ── ⌘K palette query classifiers ─────────────────────────────────────────────
// (The M1 tenant phone-search-to-act section was removed with the Tenant
// Tracker UI 2026-08-06; phone-shape detection stays as the unit-lookup guard.)

/** Strips the common phone separators (spaces, `+`, `-`, parens). */
function stripPhoneSeparators(query: string): string {
  return query.replace(/[\s+\-()]/g, "");
}

/**
 * Phone-shaped = the stripped query is ≥4 chars and ALL digits. A pure-digit
 * string is someone typing a phone number, not a unit code — it is EXCLUDED
 * from the unit lookup below and stays a plain nav-title query.
 */
function isPhoneShaped(stripped: string): boolean {
  return stripped.length >= 4 && /^[0-9]+$/.test(stripped);
}

/**
 * Unit-shaped (P4): ≥2 chars, contains a digit, NOT phone-shaped (phone wins —
 * unit codes mix letters/dashes with digits, e.g. "A-10-04", "B-15").
 */
function isUnitShaped(query: string, strippedDigits: string): boolean {
  const q = query.trim();
  return q.length >= 2 && /\d/.test(q) && !isPhoneShaped(strippedDigits);
}

/**
 * Debounce a changing value before it reaches the unit lookup query. Local
 * copy, matching the existing local-copy precedent (extraction to src/hooks
 * is a follow-up chore).
 */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchCommand() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const role = user?.role;

  const strippedDigits = stripPhoneSeparators(query);

  // ── Unit-code lookup (P4) — manager+ with owner-billing on. Deep-links to
  // the unit workspace. Reuses the ApartmentPicker search endpoint.
  const unitSearchEnabled =
    isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING") && hasMinRole(role, "manager");
  const unitQuery =
    open && unitSearchEnabled && isUnitShaped(query, strippedDigits) ? query.trim() : "";
  const debouncedUnit = useDebounced(unitQuery, 250);
  const unitLookup = useQuery({
    queryKey: ["palette-apartments", debouncedUnit],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; unitCode: string; propertyName: string }> }>(
        `/inventory/apartments?q=${encodeURIComponent(debouncedUnit)}`,
      ),
    enabled: debouncedUnit.length >= 2,
    staleTime: 30_000,
  });
  const unitHits = unitQuery !== "" ? (unitLookup.data?.data ?? []) : [];
  // Loading affordance, same idiom as tenantsSearching — the debounce settling
  // is a plain local re-render, but the async fetch resolving is a
  // react-query external-store notification that a bare "wait N ms" caller
  // can't rely on flushing synchronously; render a placeholder row so the
  // section header is visible the instant the lookup is dispatched, and let
  // callers awaiting the actual hit (e.g. via findBy*) ride out the fetch.
  const unitsSearching =
    unitQuery !== "" &&
    unitHits.length === 0 &&
    (debouncedUnit !== unitQuery || unitLookup.isFetching);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = allNavItems
    .filter((item) => canSeeNavItemFor(role, item, user?.permissions))
    .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));

  function handleNavigate(href: string) {
    setOpen(false);
    navigate(href);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search navigation..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <kbd className="hidden rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] sm:inline">
            ESC
          </kbd>
        </div>
        <ul className="max-h-64 overflow-y-auto py-2">
          {filtered.length === 0 && unitHits.length === 0 && !unitsSearching ? (
            <li className="px-4 py-3 text-sm text-[var(--text-muted)]">No results found.</li>
          ) : (
            filtered.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <button
                    onClick={() => handleNavigate(item.href)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]"
                  >
                    <Icon className="h-4 w-4 text-[var(--text-muted)]" />
                    {item.title}
                  </button>
                </li>
              );
            })
          )}
          {(unitHits.length > 0 || unitsSearching) && (
            <>
              {/* "Units" section (P4) — same <li><button> idiom as nav items. */}
              <li className="mx-4 mt-2 mb-1 border-t border-[var(--border)] pt-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Units
              </li>
              {unitsSearching ? (
                <li className="px-4 py-2.5 text-sm text-[var(--text-muted)]">
                  Searching units…
                </li>
              ) : (
                unitHits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      onClick={() => handleNavigate(`/tenancy/owner-ledger/unit/${hit.id}`)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]"
                    >
                      <Building2 className="h-4 w-4 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate tabular-nums">{hit.unitCode}</span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {hit.propertyName}
                        </span>
                      </span>
                    </button>
                  </li>
                ))
              )}
            </>
          )}
        </ul>
      </div>
    </div>
  );
}
