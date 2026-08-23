// UI Task 5 — SettingDrawer. 5 acceptance rows per the brief. A stateful
// getBearerConfig/setBearerConfig mock (rather than call-order fixtures)
// proves the "cleaning amount" round-trip: Save writes into the same store
// GET reads back from, so reopening genuinely reflects the last Save instead
// of a canned second response.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AuthContext, type User } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { GRID_QUERY_KEY_ROOT, type BearerConfigDto, type GridSubRow } from "@/api/bills-grid";
import { SettingDrawer, type SettingDrawerProps } from "../setting-drawer";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from "sonner";

// PAX-per-room: the per-room pax control saves via useSetTenancyPax (@/api/meter).
// Hoisted mock so tests can assert the mutate call and drive its onSuccess/onError.
// Rate-per-room adds useUnitMeter/useUpdateMeter/useCreateMeter — hoisted alongside so
// tests drive "meter present" vs "no meter yet" and assert PATCH vs POST.
const { mockPaxMutate, mockUpdateMutate, mockCreateMutate, mockUnitMeter } = vi.hoisted(() => ({
  mockPaxMutate: vi.fn(),
  mockUpdateMutate: vi.fn(),
  mockCreateMutate: vi.fn(),
  // Returns the useUnitMeter query result; tests override per case (meter row or null).
  mockUnitMeter: vi.fn(
    (
      _unitId?: string,
      _enabled?: boolean,
    ): { data: { id: string; ratePerKwh: string; updatedAt: string } | null; isLoading: boolean } => ({
      data: null,
      isLoading: false,
    }),
  ),
}));
vi.mock("@/api/meter", () => ({
  useSetTenancyPax: () => ({
    mutate: mockPaxMutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  }),
  useUnitMeter: (unitId: string, enabled: boolean) => mockUnitMeter(unitId, enabled),
  useUpdateMeter: () => ({ mutate: mockUpdateMutate, isPending: false }),
  useCreateMeter: () => ({ mutate: mockCreateMutate, isPending: false }),
}));

// Flag-OFF (the default here) renders the legacy cleaning-amount field. Cleaning/WiFi
// are owner-only in both flag states; flag-ON adds their recurring controls. The recurring
// editor has its own suite (recurring-settings.test.tsx).
// The flag NAME is forwarded (2026-07-27) so a test can distinguish the drawer's two flags:
// ENABLE_PHASE2_BILLING_DOCS (recurring editor) and ENABLE_CHARGE_NATURE_ROUTING (Profit/Expense
// selectors). Existing `mockRecurringFlag.mockReturnValue(x)` calls are unaffected — a vi.fn()
// that ignores its argument still answers every flag identically, exactly as before.
const { mockRecurringFlag } = vi.hoisted(() => ({ mockRecurringFlag: vi.fn() }));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: (flag: string) => mockRecurringFlag(flag) }));
// Flag-ON the drawer renders <RecurringSettings/>, which fires its own recurring API reads — stub
// it so these drawer tests stay focused on the drawer's OWN behavior (hiding + round-trip).
vi.mock("../recurring-settings", () => ({ RecurringSettings: () => <div data-testid="recurring-editor" /> }));

const mockGetBearerConfig = vi.fn();
const mockSetBearerConfig = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    getBearerConfig: (apartmentId: string) => mockGetBearerConfig(apartmentId),
    setBearerConfig: (apartmentId: string, body: unknown) => mockSetBearerConfig(apartmentId, body),
  };
});

function defaultDto(): BearerConfigDto {
  return {
    apartmentId: "apt-1",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "100.00",
    isLocked: false,
    updatedAt: null,
  };
}

/** Echoes the router location so "no route change" is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderDrawer(
  role: User["role"],
  overrides: Partial<Omit<SettingDrawerProps, "apartmentId" | "onClose">> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const permissions = role === "manager" || role === "admin"
    ? ["billing.charge.edit", "tenancy.edit"]
    : role === "editor"
      ? ["tenancy.edit"]
      : [];
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role, orgId: "org-1", permissions };
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <MemoryRouter initialEntries={["/bills-grid"]}>
          <SettingDrawer
            apartmentId="apt-1"
            open={overrides.open ?? true}
            onClose={onClose}
            subRows={overrides.subRows}
            isWholeUnit={overrides.isWholeUnit}
            managementFee={overrides.managementFee}
            ownerAssigned={overrides.ownerAssigned}
            onOpenManagementFee={overrides.onOpenManagementFee}
          />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { onClose, queryClient };
}

function sub(overrides: Partial<GridSubRow>): GridSubRow {
  return {
    listingId: "L?", tenancyId: null, partyName: null, previousKwh: null, currentKwh: null,
    amount: null, ratePerKwh: "0.6000", rateConfigured: false, rental: null, updatedAt: null,
    lastEditedByName: null, numberOfPax: null, ...overrides,
  };
}
const ALI = sub({ listingId: "L1", tenancyId: "T1", partyName: "Ali", numberOfPax: 2 });
const SITI_UNSET = sub({ listingId: "L2", tenancyId: "T2", partyName: "Siti", numberOfPax: null });
const VACANT_ROOM = sub({ listingId: "L3", tenancyId: null, partyName: null, numberOfPax: null });

beforeEach(() => {
  vi.clearAllMocks();
  mockRecurringFlag.mockReturnValue(false); // default: legacy flag-OFF form (clearAllMocks keeps impls, so reset explicitly)
});

describe("SettingDrawer", () => {
  it("exposes Management Fee configuration from the unit setting drawer", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    const onOpenManagementFee = vi.fn();

    renderDrawer("manager", {
      ownerAssigned: true,
      managementFee: {
        nonSst: "250.00",
        sst: "20.00",
        total: "270.00",
        configured: true,
        status: "chargeable",
      },
      onOpenManagementFee,
    });

    expect(await screen.findByText("Management Fee")).toBeVisible();
    expect(screen.getByText("Configured")).toBeVisible();
    expect(screen.getByText("RM 270.00")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Management Fee settings" }));
    expect(onOpenManagementFee).toHaveBeenCalledTimes(1);
  });

  it("seeds", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());

    renderDrawer("manager");

    // NO route change occurs — opening the drawer is not a navigation.
    expect(screen.getByTestId("location")).toHaveTextContent("/bills-grid");

    await waitFor(() => expect(screen.getByLabelText("Cleaning recurring amount (RM)")).toHaveValue(100));

    // Query by DOM order/textContent rather than getByRole(..., {name}) — the
    // house Field wraps each Segmented in a <label>, so the browser/jsdom
    // implicitly associates that label's text (which itself recurses into the
    // radiogroup's own aria-label) with the FIRST labelable descendant only,
    // making name-based radio queries ambiguous/wrong for anything past the
    // first option. Reading `aria-checked` off the option in document order
    // sidesteps that and is a more direct proof of "which option is selected".
    function checkedOptionLabel(groupName: string): string | null {
      const group = screen.getByRole("radiogroup", { name: groupName });
      const checked = within(group)
        .getAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true");
      return checked?.textContent ?? null;
    }

    expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "WiFi bearer" })).toBeNull();
    expect(screen.getByText(/Cleaning is owner-borne/)).toBeInTheDocument();
    expect(screen.getByText(/WiFi is owner-borne/)).toBeInTheDocument();
    // Maintenance has NO bearer control (2026-08-03) — it is always owner-borne, and the
    // Segmented that used to sit here was hardwired disabled with a no-op onChange.
    expect(screen.queryByRole("radiogroup", { name: "Maintenance bearer" })).toBeNull();
    // Simplified vocabulary (2026-07-27): the wire value is still "recharged"; the LABEL is
    // now the bearer ("Tenant"), matching the Cleaning/WiFi/Maintenance controls.
    expect(checkedOptionLabel("TNB pattern")).toBe("Tenant");
    expect(checkedOptionLabel("AIR pattern")).toBe("Tenant");

    expect(screen.getByTestId("location")).toHaveTextContent("/bills-grid");
  });

  // Simplified vocabulary (2026-07-27). REPLACES "four patterns (incl. manager_advanced,
  // Task 7/R4)": the shared `utilityPattern` enum still has 4 values and the allocation math
  // still reads all of them — the drawer now only OFFERS the two bearer choices, so every
  // utility row asks the same single question as Cleaning/WiFi/Maintenance.
  it("offers exactly two bearer options — Owner and Tenant", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());

    renderDrawer("manager");

    const tnbGroup = await screen.findByRole("radiogroup", { name: "TNB pattern" });
    const options = within(tnbGroup).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["Owner", "Tenant"]);

    const airGroup = screen.getByRole("radiogroup", { name: "AIR pattern" });
    expect(within(airGroup).getAllByRole("radio").map((o) => o.textContent)).toEqual(["Owner", "Tenant"]);

    // The old KAEN-advanced help text is gone with the option it explained.
    expect(screen.queryAllByText(/KAEN advanced.*paid.*provider/i)).toHaveLength(0);
  });

  // MONEY GUARD: "tenant_direct" means the tenant pays TNB directly and KAEN never bills it.
  // If the drawer dropped that value, the Segmented would render nothing selected and a save
  // could silently convert it to "recharged" — i.e. start billing the tenant for electricity
  // KAEN does not collect. The stored value must stay visible and selected.
  it("keeps a legacy pattern visible and selected instead of silently re-mapping it", async () => {
    mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), tnbPattern: "tenant_direct" });

    renderDrawer("manager");

    const tnbGroup = await screen.findByRole("radiogroup", { name: "TNB pattern" });
    const options = within(tnbGroup).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["Owner", "Tenant", "Tenant pays directly (legacy)"]);

    const checked = options.find((o) => o.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toBe("Tenant pays directly (legacy)");

    // A unit WITHOUT a legacy value is unaffected — no stray third option.
    expect(within(screen.getByRole("radiogroup", { name: "AIR pattern" })).getAllByRole("radio")).toHaveLength(2);
  });

  it("cleaning amount", async () => {
    const stored = defaultDto();
    mockGetBearerConfig.mockImplementation(() => Promise.resolve({ ...stored }));
    mockSetBearerConfig.mockImplementation((_apartmentId: string, body: Record<string, unknown>) => {
      Object.assign(stored, body);
      return Promise.resolve({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });
    });

    const user = userEvent.setup();
    const { onClose } = renderDrawer("manager");

    const amountInput = await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.clear(amountInput);
    await user.type(amountInput, "120");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(mockSetBearerConfig).toHaveBeenCalledWith(
      "apt-1",
      expect.objectContaining({ cleaningRecurringAmount: "120.00" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // Reopen — the stateful store now reflects the save; getBearerConfig
    // must be re-read on reopen and show 120.00.
    mockGetBearerConfig.mockClear();
    renderDrawer("manager");
    await waitFor(() => expect(screen.getByLabelText("Cleaning recurring amount (RM)")).toHaveValue(120));
  });

  // MONEY GUARD for the removed Maintenance bearer control (2026-08-03). Deleting a
  // control must not delete the VALUE behind it: a unit already carrying
  // maintenanceFeeBearer "tenant" (set before the freeze, or through the API) must
  // round-trip untouched on the next Save, not be silently rewritten to "owner" because
  // the drawer no longer renders a widget for it. formFromDto still seeds it and submit()
  // still sends it verbatim — this pins that.
  it("a stored maintenanceFeeBearer round-trips on Save even though the control is gone", async () => {
    mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), maintenanceFeeBearer: "tenant" });
    mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

    const user = userEvent.setup();
    renderDrawer("manager");
    await screen.findByRole("radiogroup", { name: "TNB pattern" });
    // No control for it, and the hint tells the truth about the stored value.
    expect(screen.queryByRole("radiogroup", { name: "Maintenance bearer" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(mockSetBearerConfig).toHaveBeenCalledWith(
      "apt-1",
      expect.objectContaining({ maintenanceFeeBearer: "tenant" }), // NOT coerced to "owner"
    );
  });

  it("locked", async () => {
    mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), isLocked: true });

    renderDrawer("editor");

    expect(await screen.findByText("Locked — a manager must unlock to change")).toBeInTheDocument();

    const tnbGroup = screen.getByRole("radiogroup", { name: "TNB pattern" });
    expect(tnbGroup).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
    expect(screen.getByLabelText("Cleaning recurring amount (RM)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("409", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockRejectedValue(
      new ApiError("BEARER_LOCKED", 409, undefined, { error: "BEARER_LOCKED" }),
    );

    const user = userEvent.setup();
    renderDrawer("manager");

    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The unlock affordance shows AND the user is told WHY the Save saved nothing
    // — the old behavior flipped the button silently, which read as "I clicked
    // Save and nothing happened." The message names the next action to take.
    expect(await screen.findByRole("button", { name: "Unlock & save" })).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Unlock & save"));
  });

  // Fix A regression — the server sets isLocked:true on EVERY successful save
  // (service.ts setBearerConfigService), so "locked" is the steady state
  // after the first save, not a rare race. A manager must be able to edit a
  // steady-state locked config via an audited unlock, or R14's "edit config
  // for future periods" is dead. MUST fail on pre-fix code, where a manager
  // facing a locked config saw the same permanently-disabled, no-Save-button
  // read-only view as an editor.
  it("(Fix A regression) manager + already-locked config stays editable via Unlock & save", async () => {
    mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), isLocked: true });
    mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

    const user = userEvent.setup();
    renderDrawer("manager");

    await screen.findByLabelText("Cleaning recurring amount (RM)");

    // Fields are editable for a manager even though the config is locked —
    // never field-disabled by lock state for a manager.
    const tnbGroup = screen.getByRole("radiogroup", { name: "TNB pattern" });
    expect(tnbGroup).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Cleaning recurring amount (RM)")).not.toBeDisabled();

    expect(
      screen.getByText(
        "These settings are locked — saving will perform an audited unlock and re-lock with your changes.",
      ),
    ).toBeInTheDocument();

    const unlockButton = screen.getByRole("button", { name: "Unlock & save" });
    expect(unlockButton).not.toBeDisabled();

    await user.click(unlockButton);

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(mockSetBearerConfig).toHaveBeenCalledWith(
      "apt-1",
      expect.objectContaining({
        unlock: true,
        tnbPattern: "recharged",
        airPattern: "recharged",
        cleaningBearer: "owner",
        wifiBearer: "owner",
        maintenanceFeeBearer: "owner",
        cleaningRecurringAmount: "100.00",
      }),
    );
  });

  it("(Fix A) editor + unlocked config → read-only with the manager-only message", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());

    renderDrawer("editor");

    // The manager-only message is role-derived (not lock-state derived), so
    // it can render before the GET resolves — wait for the fields to load
    // before asserting on them, same ordering as the "locked" test above.
    await screen.findByLabelText("Cleaning recurring amount (RM)");

    expect(
      screen.getByText("Only a manager can change these billing settings."),
    ).toBeInTheDocument();

    const tnbGroup = screen.getByRole("radiogroup", { name: "TNB pattern" });
    expect(tnbGroup).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Cleaning recurring amount (RM)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  // Fix B — normalizeAmount("") silently coerced an empty field to "0.00",
  // locking RM0 cleaning into every future snapshot. Save must be blocked
  // instead of silently defaulting to zero.
  it("(Fix B) manager clears the cleaning amount → Save is blocked, not zeroed", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

    const user = userEvent.setup();
    renderDrawer("manager");

    const amountInput = await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.clear(amountInput);

    expect(await screen.findByText("Enter a cleaning amount")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mockSetBearerConfig).not.toHaveBeenCalled();

    // Typing a valid amount re-enables Save.
    await user.type(amountInput, "50");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(screen.queryByText("Enter a cleaning amount")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(mockSetBearerConfig).toHaveBeenCalledWith(
      "apt-1",
      expect.objectContaining({ cleaningRecurringAmount: "50.00", unlock: false }),
    );
  });

  // R5 — a saved bearer config must re-derive the grid's owner/tenant columns
  // live (no manual refresh) for UNSAVED months, where isApplicable() falls
  // back to the live bearerConfig. Asserts against the SAME QueryClient
  // instance the drawer renders under, not a fresh one, so this proves the
  // component actually calls invalidateQueries on it.
  it("invalidates the grid root on successful bearer save", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

    const user = userEvent.setup();
    const { queryClient } = renderDrawer("manager");
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  // R5 negative guard — a save that FAILS (BEARER_LOCKED race) must NOT
  // trigger a spurious grid refetch; onError only flips raceLocked to show
  // the "Unlock & save" affordance. Waits for that affordance (proof onError
  // actually ran) before asserting the negative, same pattern as the "409"
  // test above.
  it("does not invalidate the grid on lock (BEARER_LOCKED failure)", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockRejectedValue(
      new ApiError("BEARER_LOCKED", 409, undefined, { error: "BEARER_LOCKED" }),
    );

    const user = userEvent.setup();
    const { queryClient } = renderDrawer("manager");
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("button", { name: "Unlock & save" });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  // Honest save feedback (user rule 2026-08-06): a billed month's snapshot is frozen —
  // the drawer must SAY so instead of toasting an unqualified "Setting saved.".
  it("all open months payment/report locked → error toast explains why the month can't change", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockResolvedValue({
      id: "cfg-1", isLocked: true, updatedAt: "2026-08-06T00:00:00.000Z",
      syncedEntries: 0, lockedEntries: 1,
    });

    const user = userEvent.setup();
    renderDrawer("manager");
    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("payment or an approved owner report"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("mixed locked + open months → success toast notes paid/approved months stay unchanged", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockResolvedValue({
      id: "cfg-1", isLocked: true, updatedAt: "2026-08-06T00:00:00.000Z",
      syncedEntries: 1, lockedEntries: 1,
    });

    const user = userEvent.setup();
    renderDrawer("manager");
    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Paid or approved-report months"));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a fully-syncable save keeps the plain success toast (no scary caveats)", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockSetBearerConfig.mockResolvedValue({
      id: "cfg-1", isLocked: true, updatedAt: "2026-08-06T00:00:00.000Z",
      syncedEntries: 1, lockedEntries: 0,
    });

    const user = userEvent.setup();
    renderDrawer("manager");
    await screen.findByLabelText("Cleaning recurring amount (RM)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Setting saved.");
  });
});

describe("SettingDrawer — PAX per room (partition units)", () => {
  // mockPaxMutate carries per-test implementations (onSuccess/onError drivers); clearAllMocks
  // does NOT reset implementations, so reset it here to prevent cross-test leakage.
  beforeEach(() => mockPaxMutate.mockReset());

  it("(B3) partition unit renders a pax input per occupied room, seeded with current pax", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI, SITI_UNSET, VACANT_ROOM] });

    const section = await screen.findByTestId("pax-per-room");
    expect(within(section).getByText("PAX per room")).toBeInTheDocument();
    expect(within(section).getByLabelText("Ali")).toHaveValue(2); // seeded from numberOfPax
    expect(within(section).getByLabelText("Siti")).toHaveValue(null); // unset → blank input
  });

  it("(B9) a vacant room shows no editable pax input, just a Vacant marker", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI, VACANT_ROOM] });

    const section = await screen.findByTestId("pax-per-room");
    expect(within(section).getByLabelText("Ali")).toBeInTheDocument();
    expect(within(section).getByText(/vacant/i)).toBeInTheDocument();
    // exactly ONE pax input in the section — the occupied room; the vacant one has none
    expect(within(section).getAllByRole("spinbutton")).toHaveLength(1);
  });

  it("(B4) a whole unit renders NO pax section", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("manager", { isWholeUnit: true, subRows: [ALI] });

    await screen.findByLabelText("Cleaning recurring amount (RM)"); // drawer fully loaded
    expect(screen.queryByTestId("pax-per-room")).not.toBeInTheDocument();
    expect(screen.queryByText("PAX per room")).not.toBeInTheDocument();
  });

  // ── Auto-save on blur (spec 2026-07-21-pax-per-room-autosave, R1–R6) ────────────────────────
  // The per-row Save button is GONE — the field saves itself on blur (Enter blurs → save), only
  // when the value is valid AND changed, and an inline status (saving… → Saved ✓ / error) replaces
  // the old success toast. These tests drive mockPaxMutate's captured onSuccess/onError to observe
  // each state. `fireEvent.blur` triggers the input's onBlur (React synthetic blur).

  it("(R1) auto-saves on blur when the value is valid and changed, with THAT room's tenancyId", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    const user = userEvent.setup();
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI, SITI_UNSET] });

    const section = await screen.findByTestId("pax-per-room");
    const siti = within(section).getByLabelText("Siti"); // Siti = T2 (not Ali = T1)
    await user.type(siti, "3");
    fireEvent.blur(siti);

    expect(mockPaxMutate).toHaveBeenCalledTimes(1);
    expect(mockPaxMutate).toHaveBeenCalledWith(
      { tenancyId: "T2", numberOfPax: 3 },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("(R1) blur with an unchanged value fires no save", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI] }); // Ali seeded 2

    const section = await screen.findByTestId("pax-per-room");
    fireEvent.blur(within(section).getByLabelText("Ali")); // value still "2" == last-saved
    expect(mockPaxMutate).not.toHaveBeenCalled();
  });

  it("(R3) an invalid value (0 / 99) fires no save and shows the inline range error", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    const user = userEvent.setup();
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI] }); // seeded 2

    const section = await screen.findByTestId("pax-per-room");
    const ali = within(section).getByLabelText("Ali");

    await user.clear(ali);
    await user.type(ali, "0");
    fireEvent.blur(ali);
    expect(within(section).getByText("Enter pax (1–50)")).toBeInTheDocument();
    expect(mockPaxMutate).not.toHaveBeenCalled();

    await user.clear(ali);
    await user.type(ali, "99"); // above the max mirrors the endpoint's 422 bound
    fireEvent.blur(ali);
    expect(within(section).getByText("Enter pax (1–50)")).toBeInTheDocument();
    expect(mockPaxMutate).not.toHaveBeenCalled();
  });

  it("(R3) clearing a set value and blurring is a no-op that keeps the stored pax (no save, no error)", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    const user = userEvent.setup();
    renderDrawer("manager", { isWholeUnit: false, subRows: [ALI] }); // seeded 2

    const section = await screen.findByTestId("pax-per-room");
    const ali = within(section).getByLabelText("Ali");
    await user.clear(ali);
    fireEvent.blur(ali);

    expect(mockPaxMutate).not.toHaveBeenCalled(); // blank ⇒ no save; the stored value stays 2
    expect(within(section).queryByText("Enter pax (1–50)")).toBeNull(); // blank ⇒ not an error
  });

  it("(R2/R5) a valid save shows saving… then Saved ✓, fires NO success toast, and invalidates the grid", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    // Capture the mutate options WITHOUT resolving so the in-flight "saving…" state is observable.
    let opts: { onSuccess: () => void; onError: (e: unknown) => void } | undefined;
    mockPaxMutate.mockImplementation((_vars, o) => {
      opts = o;
    });
    const user = userEvent.setup();
    const { queryClient } = renderDrawer("manager", { isWholeUnit: false, subRows: [SITI_UNSET] });
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    const section = await screen.findByTestId("pax-per-room");
    const siti = within(section).getByLabelText("Siti");
    await user.type(siti, "2");
    fireEvent.blur(siti);

    // In flight → saving…
    expect(within(section).getByText("saving…")).toBeInTheDocument();

    // Resolve success → Saved ✓ (persists), and the grid re-derives.
    await act(async () => {
      opts!.onSuccess();
    });

    expect(within(section).getByText("Saved ✓")).toBeInTheDocument();
    expect(within(section).queryByText("saving…")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled(); // R2: the inline ✓ REPLACES the success toast
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT }); // R5
  });

  it("(R4) a rejected save shows Couldn't save — Retry, keeps the typed value, and shows no ✓ / no toast", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockPaxMutate.mockImplementation((_vars, o) => o?.onError?.(new Error("Network Error")));
    const user = userEvent.setup();
    renderDrawer("manager", { isWholeUnit: false, subRows: [SITI_UNSET] });

    const section = await screen.findByTestId("pax-per-room");
    const siti = within(section).getByLabelText("Siti");
    await user.type(siti, "4");
    fireEvent.blur(siti);

    expect(within(section).getByText(/Couldn.t save/)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Retry saving pax for Siti" })).toBeInTheDocument();
    expect(within(section).queryByText("Saved ✓")).toBeNull();
    expect(siti).toHaveValue(4); // typed value retained for a re-attempt
    expect(toast.error).not.toHaveBeenCalled(); // inline affordance REPLACES the error toast
  });

  it("(R4/R5) a 404 TENANCY_NOT_FOUND shows the friendly refresh message and invalidates the grid", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockPaxMutate.mockImplementation((_vars, o) => o?.onError?.(new Error("TENANCY_NOT_FOUND")));
    const user = userEvent.setup();
    const { queryClient } = renderDrawer("manager", { isWholeUnit: false, subRows: [SITI_UNSET] });
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    const section = await screen.findByTestId("pax-per-room");
    const siti = within(section).getByLabelText("Siti");
    await user.type(siti, "2");
    fireEvent.blur(siti);

    // Friendly copy inline, not the raw "TENANCY_NOT_FOUND" code, and no generic Retry…
    expect(
      within(section).getByText("Couldn’t update pax — the room may have changed. Refreshing."),
    ).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    // …and the grid is invalidated so the stale row re-derives (spec R4/R5).
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  it("(R6) an editor can edit pax even though the bearer fields are read-only for them", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("editor", { isWholeUnit: false, subRows: [ALI] });

    const section = await screen.findByTestId("pax-per-room");
    expect(within(section).getByLabelText("Ali")).not.toBeDisabled(); // pax editable for editor
    // …while the manager-only bearer control stays disabled for the same editor. The pax section
    // renders before the bearer GET resolves, so wait for the bearer form to load first.
    await screen.findByLabelText("Cleaning recurring amount (RM)");
    expect(screen.getByRole("radiogroup", { name: "TNB pattern" })).toHaveAttribute("aria-disabled", "true");
  });

  it("(R6) a non-editor sees a disabled pax field and no save is ever attempted", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    renderDrawer("viewer", { isWholeUnit: false, subRows: [ALI] }); // role ∉ {editor,manager,admin}

    const section = await screen.findByTestId("pax-per-room");
    const ali = within(section).getByLabelText("Ali");
    expect(ali).toBeDisabled();
    fireEvent.blur(ali); // even if blurred, save() bails for a non-editor
    expect(mockPaxMutate).not.toHaveBeenCalled();
  });

  // Flag-ON adds recurring amount controls while Cleaning/WiFi stay owner-only.
  //
  // ── charge-nature gate (2026-07-27): the FIRST assertion below is INVERTED, deliberately ─────
  // Hiding the selectors whenever the flag was on assumed the recurring editor always owns
  // cleaning/WiFi. It only owns them when a definition GOVERNS the month. For a unit with NO
  // recurring definition — every unit in an org that has never created one — the selectors were
  // hidden while the scalar still billed, off the schema defaults (bearer "owner", nature null ⇒
  // profit): an IVOWN receivable charging the owner for their own WiFi, with no surface anywhere
  // to say otherwise. The controls now render whenever the kind is UNGOVERNED, and go read-only
  // (not absent) when it is governed — so there is still exactly ONE writable source of truth.
  describe("recurring flag ON — cleaning & WiFi move to the recurring editor", () => {
    it("shows owner-only Cleaning/WiFi with Nature when UNGOVERNED, hides the legacy cleaning-amount field, and keeps the recurring controls", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: false, wifiGoverned: false });

      renderDrawer("manager");

      await screen.findByRole("radiogroup", { name: "TNB pattern" }); // form loaded
      expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi bearer" })).toBeNull();
      expect(screen.getByText(/Cleaning is owner-borne/)).toBeInTheDocument();
      expect(screen.getByText(/WiFi is owner-borne/)).toBeInTheDocument();
      expect(screen.getByRole("radiogroup", { name: "Cleaning nature" })).toBeInTheDocument();
      expect(screen.getByRole("radiogroup", { name: "WiFi nature" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Cleaning recurring amount (RM)")).toBeNull();
      // TNB/AIR remain; the recurring editor still renders below. Maintenance keeps its
      // recurring tick but has no bearer control — it is always owner-borne.
      expect(screen.getByRole("radiogroup", { name: "AIR pattern" })).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup", { name: "Maintenance bearer" })).toBeNull();
      expect(screen.getByRole("checkbox", { name: "Maintenance recurring" })).toBeInTheDocument();
      expect(screen.getByTestId("recurring-editor")).toBeInTheDocument();
    });

    it("governed by a recurring definition: nature is read-only and bearer stays owner-only", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: true, wifiGoverned: true });

      renderDrawer("manager");

      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      expect(screen.getByRole("radiogroup", { name: "Cleaning nature" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("radiogroup", { name: "WiFi nature" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi bearer" })).toBeNull();
    });

    // ── charge-nature routing OFF (2026-07-27) ────────────────────────────────────────────────
    // This drawer used to render the Profit/Expense selectors UNCONDITIONALLY — the only nature
    // surface that did. With routing off the Bill ignores nature entirely, so asking the admin to
    // pick one was a control whose answer went nowhere. Owner/Tenant is the whole decision now.
    it("nature routing OFF: Cleaning/WiFi show only the fixed Owner bearer", async () => {
      mockRecurringFlag.mockImplementation((flag: string) => flag !== "ENABLE_CHARGE_NATURE_ROUTING");
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: false, wifiGoverned: false });

      renderDrawer("manager");

      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      expect(screen.queryByRole("radiogroup", { name: "Cleaning nature" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi nature" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi bearer" })).toBeNull();
      expect(screen.getByText(/Cleaning is owner-borne/)).toBeInTheDocument();
      expect(screen.getByText(/WiFi is owner-borne/)).toBeInTheDocument();
    });

    it("nature routing OFF + governed: no nature or tenant-bearer controls render", async () => {
      mockRecurringFlag.mockImplementation((flag: string) => flag !== "ENABLE_CHARGE_NATURE_ROUTING");
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: true, wifiGoverned: true });

      renderDrawer("manager");

      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      expect(screen.queryByRole("radiogroup", { name: "Cleaning nature" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi nature" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "Cleaning bearer" })).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "WiFi bearer" })).toBeNull();
    });

    // ── Recurring tick + amount (2026-07-28) ────────────────────────────────────────────────
    it("every scalar row offers a Recurring tick; ticking reveals an amount input", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: false, wifiGoverned: false });

      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });

      // One per scalar kind — driven off SCALAR_RECURRING_KINDS, so a new kind gains a tick free.
      for (const label of ["Cleaning", "WiFi", "TNB (electricity)", "AIR (Air Selangor — water)", "Maintenance"]) {
        expect(screen.getByRole("checkbox", { name: `${label} recurring` })).toBeInTheDocument();
      }
      // Amount input appears only once ticked.
      expect(screen.queryByLabelText("Cleaning recurring amount")).toBeNull();
      await userEvent.setup().click(screen.getByRole("checkbox", { name: "Cleaning recurring" }));
      expect(screen.getByLabelText("Cleaning recurring amount")).toBeInTheDocument();
    });

    // MONEY GUARD: Number("") === 0, so an empty amount on a ticked row would apply a RM0
    // recurring charge and silently zero that row for every open period.
    it("a ticked row with no amount blocks Save and says which row", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningGoverned: false, wifiGoverned: false });

      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      await userEvent.setup().click(screen.getByRole("checkbox", { name: "TNB (electricity) recurring" }));

      expect(screen.getByTestId("recurring-amount-required")).toHaveTextContent("TNB (electricity)");
      expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    });

    // A governed kind seeds ticked + its amount, so opening the drawer shows the current state.
    it("seeds the tick and amount from the DTO's per-kind record", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({
        ...defaultDto(),
        scalarRecurring: {
          CLEANING: { governed: true, amount: "120.00", definitionId: "def-1" },
          WIFI: { governed: false, amount: null, definitionId: null },
          TNB: { governed: false, amount: null, definitionId: null },
          AIR: { governed: false, amount: null, definitionId: null },
          MAINTENANCE: { governed: false, amount: null, definitionId: null },
        },
      });

      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });

      expect(screen.getByRole("checkbox", { name: "Cleaning recurring" })).toBeChecked();
      expect(screen.getByLabelText("Cleaning recurring amount")).toHaveValue("120.00");
      expect(screen.getByRole("checkbox", { name: "WiFi recurring" })).not.toBeChecked();
    });

    it("sends the chosen natures on Save, and OMITS a governed kind entirely (never a second writer)", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({
        ...defaultDto(), wifiNature: "expense", cleaningNature: "profit",
        wifiGoverned: false, cleaningGoverned: true,
      });
      mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

      const user = userEvent.setup();
      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      await user.click(screen.getByRole("button", { name: /^(Save|Unlock & save)$/ }));

      await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
      const body = mockSetBearerConfig.mock.calls[0][1];
      expect(body.wifiNature).toBe("expense");          // ungoverned → this drawer owns it
      expect("cleaningNature" in body).toBe(false);      // governed → the recurring editor owns it
    });

    it("sends an EXPLICIT null when the admin picks “Not set” (un-deciding is a real choice)", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), wifiNature: "expense", wifiGoverned: false, cleaningGoverned: false });
      mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

      const user = userEvent.setup();
      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });
      await user.click(within(screen.getByRole("radiogroup", { name: "WiFi nature" })).getByText("Not set"));
      await user.click(screen.getByRole("button", { name: /^(Save|Unlock & save)$/ }));

      await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
      // null, NOT omitted — omitted would mean "leave the stored value", silently ignoring the click.
      expect(mockSetBearerConfig.mock.calls[0][1].wifiNature).toBeNull();
    });

    it("converts a legacy tenant Cleaning/WiFi config to the owner-only rule on Save", async () => {
      mockRecurringFlag.mockReturnValue(true);
      mockGetBearerConfig.mockResolvedValue({ ...defaultDto(), cleaningBearer: "tenant", wifiBearer: "tenant" });
      mockSetBearerConfig.mockResolvedValue({ id: "cfg-1", isLocked: true, updatedAt: "2026-07-01T00:00:00.000Z" });

      const user = userEvent.setup();
      renderDrawer("manager");
      await screen.findByRole("radiogroup", { name: "TNB pattern" });

      await user.click(screen.getByRole("button", { name: /^(Save|Unlock & save)$/ }));

      await waitFor(() => expect(mockSetBearerConfig).toHaveBeenCalledTimes(1));
      expect(mockSetBearerConfig.mock.calls[0][1]).toMatchObject({ cleaningBearer: "owner", wifiBearer: "owner" });
    });
  });
});

describe("SettingDrawer — electricity rate per room", () => {
  const CONFIGURED = sub({ listingId: "L1", tenancyId: "T1", partyName: "Ali", ratePerKwh: "0.6000", rateConfigured: true });
  const UNCONFIGURED = sub({ listingId: "L2", tenancyId: "T2", partyName: "Siti", ratePerKwh: "0.6000", rateConfigured: false });

  it("renders one rate row per room; a manager gets an Edit control and unconfigured rooms show (default)", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockUnitMeter.mockReturnValue({ data: null, isLoading: false });
    renderDrawer("manager", { subRows: [CONFIGURED, UNCONFIGURED] });

    const section = await screen.findByTestId("rate-per-room");
    expect(within(section).getAllByText(/RM 0.6000\/kWh/)).toHaveLength(2);
    expect(within(section).getByRole("button", { name: "Edit electricity rate for Ali" })).toBeInTheDocument();
    // UNCONFIGURED (no meter, rateConfigured:false) is flagged as the lazy default.
    expect(within(section).getByText("(default)")).toBeInTheDocument();
  });

  it("an editor sees the rates read-only (no Edit control — PATCH/POST /meter are manager-only)", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockUnitMeter.mockReturnValue({ data: null, isLoading: false });
    renderDrawer("editor", { subRows: [CONFIGURED] });

    const section = await screen.findByTestId("rate-per-room");
    expect(within(section).getByText(/RM 0.6000\/kWh/)).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Edit electricity rate/ })).not.toBeInTheDocument();
  });

  it("saving a room WITH a meter PATCHes it (ratePerKwh + expectedUpdatedAt) and invalidates the grid", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockUnitMeter.mockReturnValue({ data: { id: "M1", ratePerKwh: "0.6000", updatedAt: "2026-07-01T00:00:00.000Z" }, isLoading: false });
    mockUpdateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    const user = userEvent.setup();
    const { queryClient } = renderDrawer("manager", { subRows: [CONFIGURED] });
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    const section = await screen.findByTestId("rate-per-room");
    await user.click(within(section).getByRole("button", { name: "Edit electricity rate for Ali" }));
    const input = within(section).getByLabelText("Electricity rate per kWh for Ali");
    await user.clear(input);
    await user.type(input, "0.8000");
    await user.click(within(section).getByRole("button", { name: "Save electricity rate for Ali" }));

    expect(mockUpdateMutate).toHaveBeenCalledWith(
      { ratePerKwh: "0.8000", expectedUpdatedAt: "2026-07-01T00:00:00.000Z" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
    expect(toast.success).toHaveBeenCalled();
  });

  it("saving a room with NO meter yet POSTs a new meter (unitId + ratePerKwh) instead of PATCHing", async () => {
    mockGetBearerConfig.mockResolvedValue(defaultDto());
    mockUnitMeter.mockReturnValue({ data: null, isLoading: false });
    mockCreateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    const user = userEvent.setup();
    renderDrawer("manager", { subRows: [UNCONFIGURED] });

    const section = await screen.findByTestId("rate-per-room");
    await user.click(within(section).getByRole("button", { name: "Edit electricity rate for Siti" }));
    const input = within(section).getByLabelText("Electricity rate per kWh for Siti");
    await user.clear(input);
    await user.type(input, "0.7500");
    await user.click(within(section).getByRole("button", { name: "Save electricity rate for Siti" }));

    expect(mockCreateMutate).toHaveBeenCalledWith(
      { unitId: "L2", ratePerKwh: "0.7500" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(mockUpdateMutate).not.toHaveBeenCalled();
  });
});
