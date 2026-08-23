import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addMonthsToYm } from "@kason/shared";

const apiFetch = vi.fn();
vi.mock("../../../lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

const LIST = {
  items: [
    { id: "1", invoiceNumber: "TR-1", partyName: "Nurul", invoiceType: "tenant_rental", periodMonth: "2026-07-01", totalAmount: 1200, status: "draft", updatedAt: "2026-07-19T00:00:00Z" },
    { id: "2", invoiceNumber: "TR-2", partyName: "Yuki", invoiceType: "tenant_rental", periodMonth: "2026-07-01", totalAmount: 1100, status: "draft", updatedAt: "2026-07-19T00:00:00Z" },
    { id: "3", invoiceNumber: "OS-1", partyName: "Razak", invoiceType: "owner_statement", periodMonth: "2026-07-01", totalAmount: 0, status: "draft", updatedAt: "2026-07-19T00:00:00Z" },
  ],
  total: 3,
};

const EMPTY = { items: [], total: 0 };

const CONFIG = {
  id: "cfg-1",
  runDayOfMonth: 25,
  billPeriodOffset: 1,
  // null = scheduled auto-billing OFF, which is the shipped default.
  autoBillDayOfMonth: null as number | null,
  dueDayOffset: null,
  includeRent: true,
  includeElectricity: true,
  includeMgmtFee: true,
  includeCleaning: true,
  isActive: true,
  autoApprove: false,
  updatedAt: "2026-07-19T00:00:00Z",
};

/** "YYYY-MM" for today — the page reads the real clock, so expectations derive from it. */
function currentYm(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

/** Mirrors the page's formatYm, so button names can be asserted exactly. */
function ymLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-MY", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Route-aware mock: the page fetches BOTH the invoice queue and the draft config. */
function mockApi(opts: { list?: unknown; config?: unknown; configStatus?: number } = {}) {
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith("/billing/draft-config")) {
      if (opts.configStatus === 404) {
        const e = new Error("not found") as Error & { status: number };
        e.status = 404;
        return Promise.reject(e);
      }
      return Promise.resolve(opts.config ?? CONFIG);
    }
    if (url.startsWith("/billing/draft-runs")) {
      return Promise.resolve({ draftsCreated: 4, draftsSkipped: 1 });
    }
    return Promise.resolve(opts.list ?? LIST);
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  mockApi();
});

async function mount() {
  const { default: DraftApprovalsPage } = await import("../draft-approvals-page");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DraftApprovalsPage />
    </QueryClientProvider>,
  );
}

describe("Draft Approvals — document-type tabs", () => {
  it("renders a tab per document type with counts (2 rentals + 1 statement)", async () => {
    await mount();
    await waitFor(() => screen.getByText("OS-1"));
    expect(screen.getByRole("button", { name: /^All\s*3$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rental Payment Requests\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Owner Statements\s*1/ })).toBeInTheDocument();
  });

  it("selecting Owner Statements filters the table to just owner statements", async () => {
    await mount();
    await waitFor(() => screen.getByText("OS-1"));
    expect(screen.getByText("TR-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Owner Statements\s*1/ }));

    await waitFor(() => expect(screen.queryByText("TR-1")).toBeNull());
    expect(screen.queryByText("TR-2")).toBeNull();
    expect(screen.getByText("OS-1")).toBeInTheDocument();
  });
});

describe("Draft Approvals — advance-billing schedule", () => {
  it("surfaces the run day in the header action", async () => {
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /Schedule: day 25/ })).toBeInTheDocument());
  });

  it("labels the schedule as paused when isActive is false", async () => {
    mockApi({ config: { ...CONFIG, isActive: false } });
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /paused/i })).toBeInTheDocument());
  });

  it("offers setup when no schedule exists yet (404)", async () => {
    mockApi({ configStatus: 404, list: EMPTY });
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/Invoice drafting isn't set up yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Set up billing schedule/i })).toBeInTheDocument();
  });

  it("an empty queue WITH a schedule says nothing is drafted yet, not 'no match'", async () => {
    // The regression this replaces: "No draft invoices match the current filters" sent
    // admins hunting for drafts that had never been generated.
    mockApi({ list: EMPTY });
    await mount();
    await waitFor(() => expect(screen.getByText(/Nothing drafted yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/No invoices match these filters/i)).toBeNull();
  });

  it("Generate targets the CURRENT month — the schedule's offset does not move it", async () => {
    // THE money assertion of this feature. The button used to post
    // currentMonth + billPeriodOffset, so with the default offset of 1 the only
    // Generate control on the page drafted NEXT month and the current month was
    // unreachable: a tenant who moved in mid-month was billed nothing for it.
    mockApi({ list: EMPTY });
    await mount();
    const label = `Generate ${ymLabel(currentYm())} drafts`;
    await waitFor(() => screen.getByRole("button", { name: label }));

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/billing/draft-runs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ periodMonth: currentYm() }),
        }),
      ),
    );
  });

  it("a SECOND Generate still reaches the schedule's month, so advance billing keeps a manual path", async () => {
    // The current-month button must not cost the 25th-for-next-month process its
    // only manual trigger — the nightly cron is not armed in every environment.
    mockApi({ list: EMPTY });
    await mount();
    const next = addMonthsToYm(currentYm(), 1);
    const label = `Generate ${ymLabel(next)} drafts`;
    await waitFor(() => screen.getByRole("button", { name: label }));

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/billing/draft-runs",
        expect.objectContaining({ body: JSON.stringify({ periodMonth: next }) }),
      ),
    );
    expect(next).not.toBe(currentYm());
  });

  it("offset 0 collapses the two Generate buttons into one", async () => {
    // When the schedule already bills the current month the two periods are the
    // same, and rendering the identical button twice is noise.
    mockApi({ list: EMPTY, config: { ...CONFIG, billPeriodOffset: 0 } });
    await mount();
    const label = `Generate ${ymLabel(currentYm())} drafts`;
    await waitFor(() => screen.getByRole("button", { name: label }));

    expect(screen.getAllByRole("button", { name: /Generate .* drafts/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/billing/draft-runs",
        expect.objectContaining({ body: JSON.stringify({ periodMonth: currentYm() }) }),
      ),
    );
  });

  it("the drawer previews the target month and PATCHes the offset", async () => {
    await mount();
    await waitFor(() => screen.getByRole("button", { name: /Schedule: day 25/ }));
    fireEvent.click(screen.getByRole("button", { name: /Schedule: day 25/ }));

    // The preview sentence is the whole point of the drawer.
    // Match the DRAWER's sentence specifically — the header's "Drafted on day 25
    // each month" hint also contains the day, and a looser matcher finds both.
    await waitFor(() =>
      expect(screen.getByText(/On day 25 each month, KAEN/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("radio", { name: "Next month" })).toHaveAttribute("aria-checked", "true");

    // Switch to "Current month" and save — the PATCH must carry billPeriodOffset 0.
    fireEvent.click(screen.getByRole("radio", { name: "Current month" }));
    fireEvent.click(screen.getByRole("button", { name: /Save schedule/i }));

    await waitFor(() => {
      const patch = apiFetch.mock.calls.find(
        ([url, init]) => url === "/billing/draft-config/cfg-1" && (init as { method?: string })?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({
        runDayOfMonth: 25,
        billPeriodOffset: 0,
        // Explicit null, not an omitted key: the drawer's auto-bill checkbox is
        // unticked, and "off" has to be SENT or unticking it could never turn
        // scheduled billing back off once an admin had enabled it.
        autoBillDayOfMonth: null,
        isActive: true,
        expectedUpdatedAt: CONFIG.updatedAt,
      });
    });
  });

  it("turning auto-bill ON sends the day and swaps the 'Drafts only' reassurance", async () => {
    // The callout swap is not cosmetic. "Nothing is sent to tenants
    // automatically. Every draft still needs an admin to approve it" becomes a
    // FALSE statement the moment auto-billing is on, and it sits directly above
    // the Save button that enables it.
    await mount();
    await waitFor(() => screen.getByRole("button", { name: /Schedule: day 25/ }));
    fireEvent.click(screen.getByRole("button", { name: /Schedule: day 25/ }));

    await waitFor(() => expect(screen.getByText(/Drafts only/i)).toBeInTheDocument());
    expect(screen.getByText(/Nothing is sent to tenants automatically/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-bill drafts on a set day/i }));

    // The reassurance is replaced by the consequence.
    await waitFor(() =>
      expect(screen.getByText(/bills tenants without a human check/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Drafts only/i)).not.toBeInTheDocument();

    const dayInput = screen.getByLabelText(/Auto-bill day of month/i);
    fireEvent.change(dayInput, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Save schedule/i }));

    await waitFor(() => {
      const patch = apiFetch.mock.calls.find(
        ([url, init]) => url === "/billing/draft-config/cfg-1" && (init as { method?: string })?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as { body: string }).body)).toMatchObject({
        autoBillDayOfMonth: 1,
      });
    });
  });

  it("blocks Save on an out-of-range auto-bill day, but only while auto-bill is ON", async () => {
    await mount();
    await waitFor(() => screen.getByRole("button", { name: /Schedule: day 25/ }));
    fireEvent.click(screen.getByRole("button", { name: /Schedule: day 25/ }));
    await waitFor(() => screen.getByRole("checkbox", { name: /Auto-bill drafts on a set day/i }));

    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-bill drafts on a set day/i }));
    const dayInput = await screen.findByLabelText(/Auto-bill day of month/i);

    // 31 does not exist in February — the cap is why the day is bounded at 28.
    fireEvent.change(dayInput, { target: { value: "31" } });
    expect(screen.getByRole("button", { name: /Save schedule/i })).toBeDisabled();

    // Unticking must free the form: the bad value is no longer being saved.
    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-bill drafts on a set day/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Save schedule/i })).not.toBeDisabled(),
    );
  });

  it("each Bill period option is announced by its OWN name", async () => {
    // Regression guard: the options were briefly nested inside <Field>, whose <label>
    // wrapper gave EVERY radio the same accessible name ("Bill period Bill period
    // KAEN issues on the 25th…"), leaving screen-reader users unable to tell the
    // choices apart. RadioField names the group, not the options.
    await mount();
    await waitFor(() => screen.getByRole("button", { name: /Schedule: day 25/ }));
    fireEvent.click(screen.getByRole("button", { name: /Schedule: day 25/ }));

    await waitFor(() => expect(screen.getByRole("radiogroup", { name: "Bill period" })).toBeInTheDocument());
    const names = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(names).toEqual(["Next month", "Current month", "In 2 months"]);
    expect(new Set(names).size).toBe(names.length); // every option distinguishable
  });

  it("Generate stays reachable from the header while OTHER drafts are pending", async () => {
    // The catch-up path for a tenancy signed after the run day: previously the only
    // Generate trigger lived inside the EMPTY state, so a queue with pending drafts
    // had no self-serve way to draft the late tenancy (runs are idempotent per
    // tenancy+period — re-running only adds what is missing).
    await mount();
    await waitFor(() => screen.getByText("TR-1")); // queue is non-empty
    const label = `Generate ${ymLabel(currentYm())} drafts`;
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/billing/draft-runs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ periodMonth: currentYm() }),
        }),
      ),
    );
  });

  it("ONE set of Generate controls per state — the empty state keeps its own, the header yields", async () => {
    // Both sets fire the same mutation, so rendering header AND empty-state copies
    // together is four buttons on one screen. The empty state's is the guided one
    // (it carries the explanation), so the header suppresses itself there. The set
    // is 2 (this month + the schedule's month), never 4.
    const countGenerate = () =>
      [...document.querySelectorAll("button")].filter((b) => /Generate .* drafts/i.test(b.textContent ?? "")).length;

    mockApi({ list: EMPTY });
    await mount();
    await waitFor(() => screen.getByText(/Nothing drafted yet/i));
    expect(countGenerate()).toBe(2);

    cleanup();
    mockApi(); // non-empty queue
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    expect(countGenerate()).toBe(2);
  });

  it("the period filter offers UPCOMING months so advance drafts are reachable", async () => {
    // Without this the queue hides every draft the feature creates: a past-months-only
    // filter can never select the month the run day actually bills.
    await mount();
    const nextMonth = addMonthsToYm(currentYm(), 1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: nextMonth })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: currentYm() })).toBeInTheDocument();
  });
});

describe("Draft Approvals — single-select filters", () => {
  it("picking a second period REPLACES the first instead of conflicting", async () => {
    // The page used to allow a two-value selection the API cannot express, drop
    // the query param, show every row, and then apologise in a warning banner.
    await mount();
    await waitFor(() => screen.getByText("TR-1"));

    const thisMonth = screen.getByRole("button", { name: currentYm() });
    const nextMonth = screen.getByRole("button", { name: addMonthsToYm(currentYm(), 1) });

    fireEvent.click(thisMonth);
    await waitFor(() => expect(thisMonth).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(nextMonth);
    await waitFor(() => expect(nextMonth).toHaveAttribute("aria-pressed", "true"));
    expect(thisMonth).toHaveAttribute("aria-pressed", "false");
  });

  it("the 'multiple values selected' warning is gone — the state it warned about is unreachable", async () => {
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    fireEvent.click(screen.getByRole("button", { name: currentYm() }));
    fireEvent.click(screen.getByRole("button", { name: addMonthsToYm(currentYm(), 1) }));
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));

    await waitFor(() => expect(screen.queryByText(/Multiple values selected/i)).toBeNull());
  });

  it("clicking the ACTIVE pill clears it, so 'no filter' stays reachable", async () => {
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    const draft = screen.getByRole("button", { name: "Draft" });
    expect(draft).toHaveAttribute("aria-pressed", "true"); // default filter

    fireEvent.click(draft);
    await waitFor(() => expect(draft).toHaveAttribute("aria-pressed", "false"));
  });
});

describe("Draft Approvals — issuing", () => {
  it("offers a one-click issue-all for every draft in view, with the total", async () => {
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    // 3 drafts in LIST: 1200 + 1100 + 0.
    expect(screen.getByRole("button", { name: /Issue all 3 draft\(s\)/i })).toBeInTheDocument();
    expect(screen.getByText(/3 draft\(s\) in view/i)).toBeInTheDocument();
  });

  it("issue-all POSTs exactly the ids in view — the type tab narrows it", async () => {
    // The tab is a real filter, not decoration: issuing from Rental Invoices must
    // not silently approve the owner statement sitting in the All tab.
    await mount();
    await waitFor(() => screen.getByText("OS-1"));
    fireEvent.click(screen.getByRole("button", { name: /Rental Payment Requests\s*2/ }));

    await waitFor(() => screen.getByRole("button", { name: /Issue all 2 draft\(s\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Issue all 2 draft\(s\)/i }));

    await waitFor(() => screen.getByRole("button", { name: /^Issue 2 invoice\(s\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Issue 2 invoice\(s\)$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/billing/invoices/approve-bulk",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["1", "2"] }) }),
      ),
    );
  });

  it("the confirm dialog states the money that is about to go live", async () => {
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    fireEvent.click(screen.getByRole("button", { name: /Issue all 3 draft\(s\)/i }));

    // 1200 + 1100 + 0, through the app's formatMoney ("RM 2,300"). Scoped to the
    // dialog: the issue bar behind it states the same total, which is the point.
    await waitFor(() => screen.getByRole("dialog"));
    expect(within(screen.getByRole("dialog")).getByText(/RM 2,300/)).toBeInTheDocument();
  });

  it("warns when the view is truncated, so 'issue all' cannot read as 'issued the month'", async () => {
    // The queue asks for limit=200 and has no pagination. Issuing 200 of 640 and
    // reporting success is how a month silently goes half-billed.
    //
    // The count quoted must be the one that is ISSUED. It used to quote the
    // untabbed fetch beside the tab-narrowed issue set, so a single sentence
    // described two different populations ("shows 200 of 640 … only the 120
    // listed here"). Asserted from the Rental-Invoices tab, where shown (2) and
    // fetched (3) genuinely differ.
    mockApi({ list: { items: LIST.items, total: 640 } });
    await mount();
    await waitFor(() => screen.getByText("OS-1"));
    fireEvent.click(screen.getByRole("button", { name: /Rental Payment Requests\s*2/ }));
    await waitFor(() => screen.getByRole("button", { name: /Issue all 2 draft\(s\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Issue all 2 draft\(s\)/i }));

    await waitFor(() => screen.getByRole("dialog"));
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("2 of 640 matching invoices are loaded");
    expect(text).toContain("Only the 2 listed here will be issued");
  });

  it("names the period on the issue-all button, so next month's advance drafts are not issued blind", async () => {
    // With no period pill selected the queue holds EVERY month at once, and
    // under advance billing that means this month's catch-up drafts sit beside
    // next month's scheduled ones. An unlabelled "Issue all" turned the latter
    // into live receivables early.
    const thisMonth = `${currentYm()}-01T00:00:00Z`;
    mockApi({
      list: {
        items: [
          { ...LIST.items[0], periodMonth: thisMonth },
          { ...LIST.items[1], periodMonth: thisMonth },
        ],
        total: 2,
      },
    });
    await mount();
    await waitFor(() => screen.getByText("TR-1"));

    expect(
      screen.getByRole("button", { name: new RegExp(`Issue all 2 draft\\(s\\).*${ymLabel(currentYm())}`) }),
    ).toBeInTheDocument();
  });

  it("itemises the months when issue-all spans more than one", async () => {
    const next = addMonthsToYm(currentYm(), 1);
    mockApi({
      list: {
        items: [
          { ...LIST.items[0], periodMonth: `${currentYm()}-01T00:00:00Z` },
          { ...LIST.items[1], periodMonth: `${next}-01T00:00:00Z` },
        ],
        total: 2,
      },
    });
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    // The bar says "2 months" rather than naming one of them.
    expect(screen.getByText(/2 months/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Issue all 2 draft\(s\)/i }));
    await waitFor(() => screen.getByRole("dialog"));

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("This spans more than one month");
    expect(text).toContain(ymLabel(currentYm()));
    expect(text).toContain(ymLabel(next));
  });

  it("a hand-ticked selection is NOT second-guessed with the multi-month warning", async () => {
    // Ticking rows across months is a deliberate choice; only the blanket
    // issue-all needs the warning.
    const next = addMonthsToYm(currentYm(), 1);
    mockApi({
      list: {
        items: [
          { ...LIST.items[0], periodMonth: `${currentYm()}-01T00:00:00Z` },
          { ...LIST.items[1], periodMonth: `${next}-01T00:00:00Z` },
        ],
        total: 2,
      },
    });
    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select all visible/i }));

    await waitFor(() => screen.getByRole("button", { name: /Issue selected \(2\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Issue selected \(2\)/i }));

    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").textContent ?? "").not.toContain("spans more than one month");
  });

  it("reports the SKIPPED count from the id arrays the endpoint returns", async () => {
    // approve-bulk returns { approved: string[], skipped: string[] }. Typed as
    // numbers, the toast interpolated a comma-joined list of UUIDs and the
    // `skipped > 0` array comparison was always false, so a partially-skipped
    // batch reported as a clean success.
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/billing/draft-config")) return Promise.resolve(CONFIG);
      if (url === "/billing/invoices/approve-bulk") {
        return Promise.resolve({ approved: ["1", "2"], skipped: ["3"] });
      }
      return Promise.resolve(LIST);
    });
    const toastModule = await import("sonner");
    const success = vi.spyOn(toastModule.toast, "success");

    await mount();
    await waitFor(() => screen.getByText("TR-1"));
    fireEvent.click(screen.getByRole("button", { name: /Issue all 3 draft\(s\)/i }));
    await waitFor(() => screen.getByRole("button", { name: /^Issue 3 invoice\(s\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Issue 3 invoice\(s\)$/i }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(expect.stringContaining("Issued 2 invoice(s), 1 skipped")),
    );
    success.mockRestore();
  });
});

describe("Draft Approvals — a selection never outlives the view it was made in", () => {
  it("changing the PERIOD clears a hand-ticked selection", async () => {
    // Tick a row, then navigate to another month. The ids are August's; the view
    // is July's. Left alone, the bar reads "1 invoice(s) selected · RM0.00" (the
    // total reduces over rows now in view and finds none) while Issue selected
    // still POSTs the August id — and approve-bulk approves it, because it is a
    // real draft in a valid state. A month the admin navigated away from goes live.
    await mount();
    await waitFor(() => screen.getByText("TR-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: /Select .*TR-1/i }));
    expect(await screen.findByText(/1 invoice\(s\) selected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: currentYm() }));

    await waitFor(() =>
      expect(screen.queryByText(/invoice\(s\) selected/i)).not.toBeInTheDocument(),
    );
  });

  it("changing the STATUS clears it too", async () => {
    await mount();
    await waitFor(() => screen.getByText("TR-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: /Select .*TR-1/i }));
    expect(await screen.findByText(/1 invoice\(s\) selected/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));

    await waitFor(() =>
      expect(screen.queryByText(/invoice\(s\) selected/i)).not.toBeInTheDocument(),
    );
  });

  it("pauses issuing while the previous filter's rows are still on screen", async () => {
    // keepPreviousData holds the old rows so the table doesn't blank on every
    // pill click. The cost is that `issuable.ids` is momentarily the OLD period's
    // ids while the header names the new one — so every issue path closes until
    // the rows and the filters agree.
    let releaseSecondFetch: (v: unknown) => void = () => {};
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/billing/draft-config")) return Promise.resolve(CONFIG);
      if (url.startsWith("/billing/draft-runs")) return Promise.resolve({ draftsCreated: 0, draftsSkipped: 0 });
      // First list call resolves; the second hangs until we release it.
      if (apiFetch.mock.calls.filter((c) => String(c[0]).startsWith("/billing/invoices")).length > 1) {
        return new Promise((res) => { releaseSecondFetch = res; });
      }
      return Promise.resolve(LIST);
    });

    await mount();
    await waitFor(() => screen.getByRole("button", { name: /Issue all 3 draft\(s\)/i }));

    fireEvent.click(screen.getByRole("button", { name: currentYm() }));

    // Old rows still readable, but the issue path is gone and says why.
    await waitFor(() => screen.getByText(/Issuing is paused/i));
    expect(screen.queryByRole("button", { name: /Issue all/i })).not.toBeInTheDocument();
    expect(screen.getByText("TR-1")).toBeInTheDocument();

    releaseSecondFetch(LIST);
    await waitFor(() => screen.getByRole("button", { name: /Issue all 3 draft\(s\)/i }));
    expect(screen.queryByText(/Issuing is paused/i)).not.toBeInTheDocument();
  });
});
