/**
 * PRD-A Task 3 — the create modal must be able to satisfy the server contract
 * that Tasks 1 + 2 introduced.
 *
 * createUnitService now rejects an occupied create that carries no owner
 * (409 UNIT_HAS_NO_OWNER) and one whose `monthlyRent ?? rentalRate` is not
 * > 0 (400 OCCUPANCY_RENT_REQUIRED). The rent guard is NOT flag-gated -- the
 * flag appears only in its explanatory comment -- so both flag states are
 * pinned below. The flag is mocked in every test that depends on it; reading
 * the ambient (unset) env would pass for the wrong reason.
 *
 * Patterns mirror create-rooms-multi-dialog.test.tsx and
 * edit-apartment-dialog.test.tsx: QueryClientProvider + MemoryRouter + mocked
 * apiFetch + mocked sonner.
 */
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Contention headroom, NOT a slow assertion: these userEvent flows each finish
// in ~1s solo but time out at the default 5000ms under suite parallelism (14/14
// pass in isolation; "blocks occupied without tenant" clocked at 1008ms). Raise
// the ceiling for THIS file only — the global vitest config is untouched.
vi.setConfig({ testTimeout: 20000 });

// Mutable so a single file can pin BOTH flag states -- the rent rule on create
// must hold either way.
const flags = vi.hoisted(() => ({ reservationGatedTenancy: false }));
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) =>
    flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY"
      ? flags.reservationGatedTenancy
      : false,
}));

// Keep the REAL ApiError + extractApiError: the error-surfacing tests below
// feed raw wire bodies through the real normaliser, which is the only way to
// prove the top-level-`code` and nested-`code` shapes both reach err.code.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

vi.mock("@/hooks/use-amenities", () => ({
  useActiveAmenities: () => ({ data: [], isLoading: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Stub the media step so these tests assert the TRANSITION into it (bound ids
// + dialog stays open), not its internals — those are covered by
// unit-media-step.test.tsx directly.
vi.mock("../unit-media-step", () => ({
  CreateUnitMediaStep: (p: { rooms: Array<{ id: string; label: string }>; onDone: () => void }) => (
    <div
      data-testid="create-media-step"
      data-ids={p.rooms.map((r) => r.id).join(",")}
      data-labels={p.rooms.map((r) => r.label).join(",")}
    >
      <button type="button" onClick={p.onDone}>
        Done
      </button>
    </div>
  ),
}));

import { toast } from "sonner";
import { ApiError, extractApiError } from "@/lib/api-client";
import {
  CreateUnitDialog,
  partitionDuplicateError,
} from "../create-unit-dialog";
import { blankUnitFormState, unitFormToApiPayload } from "../unit-form-fields";
import { blankRoom } from "../partition-room-strip";
import type { ApartmentSummary } from "@/api/inventory-units-batch";
import { AuthContext } from "@/lib/auth";

function fixtureApartment(overrides: Partial<ApartmentSummary> = {}): ApartmentSummary {
  return {
    id: "apt-1",
    unitCode: "A-18-06",
    floor: 18,
    bedrooms: 3,
    bathrooms: 2,
    floorArea: 1200,
    amenities: [],
    highlights: [],
    description: null,
    rooms: [],
    hasDrift: false,
    listingMode: "PARTITIONED",
    partitionBillingMode: "SUBSIDY",
    ownerPartyId: "owner-1",
    ownerName: "Ahmad Bin Sulaiman",
    ownerPhone: "+60 12-345 6789",
    underManagement: true,
    ...overrides,
  };
}

// noId is an explicit opt-in for the coerce-to-draft-style degenerate success
// response ({} — no id): every existing caller passes { ok: true } (or omits
// post entirely), so noId stays undefined and the id: "unit-1" default is
// unchanged for them.
type PostOutcome =
  | { ok: true; noId?: true }
  | { ok: false; status: number; body: unknown };

function setupApi(
  opts: {
    apartments?: ApartmentSummary[];
    post?: PostOutcome;
    batchIds?: string[];
    rentPreview?: {
      month: string;
      amount: number;
      occupiedDays: number;
      daysInMonth: number;
      isProrated: boolean;
    };
  } = {},
) {
  const apartments = opts.apartments ?? [];
  const post: PostOutcome = opts.post ?? { ok: true };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(
    (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/commissions/room-types?activeOnly=true") {
        return Promise.resolve({
          data: [
            { id: "rtw", name: "Studio", sortOrder: 0, kind: "WHOLE" },
            { id: "rt1", name: "Master", sortOrder: 1, kind: "PARTITION" },
            { id: "rt2", name: "Medium", sortOrder: 2, kind: "PARTITION" },
          ],
        });
      }
      if (url === "/inventory/units/batch" && init?.method === "POST") {
        const parsed = JSON.parse(init?.body ?? "{}") as {
          rooms?: unknown[];
        };
        // batchIds is an explicit override (e.g. [] for the empty-ids failure
        // path); unset it and the ids still derive from the submitted rooms,
        // exactly as every existing caller already relies on.
        const ids =
          opts.batchIds ?? (parsed.rooms ?? []).map((_, i) => `room-${i + 1}`);
        return Promise.resolve({ data: { ids, updatedIds: [], apartmentId: "apt-batch-1" } });
      }
      if (url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (url.startsWith("/inventory/apartments/by-property/")) {
        return Promise.resolve({ data: apartments });
      }
      if (url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [
            {
              id: "owner-9",
              displayName: "Bob Lee",
              primaryPhone: "+60123456789",
              formattedPhone: "+60 12-345 6789",
            },
          ],
        });
      }
      if (url.startsWith("/parties/assignable")) {
        return Promise.resolve({
          data: [
            {
              id: "agent-9",
              displayName: "Siti Agent",
              partyType: "agent",
              agentLevel: "senior",
            },
          ],
        });
      }
      if (url.startsWith("/parties/tenants/search")) {
        return Promise.resolve({
          data: [
            {
              id: "tenant-9",
              displayName: "Nurul Izzah",
              primaryPhone: "+60127778888",
              formattedPhone: "+60 12-777 8888",
              idType: "nric",
              idNumberMasked: "••••5678",
            },
          ],
        });
      }
      if (url.startsWith("/tenancy/tenancies/rent-preview")) {
        return Promise.resolve({
          data: opts.rentPreview ?? {
            month: "2026-08",
            amount: 3000,
            occupiedDays: 31,
            daysInMonth: 31,
            isProrated: false,
          },
        });
      }
      if (url === "/inventory/units" && init?.method === "POST") {
        if (post.ok) {
          return Promise.resolve(
            post.noId ? {} : { id: "unit-1", apartmentId: "apt-created-1" },
          );
        }
        const { message, code } = extractApiError(post.body, post.status);
        return Promise.reject(new ApiError(message, post.status, code, post.body));
      }
      return Promise.resolve({ data: null });
    },
  );
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <AuthContext.Provider value={{
      user: {
        id: "operator-1",
        fullName: "Test Operator",
        email: "operator@example.test",
        role: "admin",
        orgId: "org-1",
        permissions: ["party.create", "portfolio.create", "tenancy.create"],
      },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    }}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

/** POST bodies sent to /inventory/units, parsed. Excludes the GET typeaheads. */
function postedBodies(): Record<string, unknown>[] {
  return apiFetchMock.mock.calls
    .filter(
      ([url, init]) =>
        url === "/inventory/units" &&
        (init as { method?: string } | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

/** POST bodies sent to the multi-room batch endpoint, parsed. */
function postedBatchBodies(): {
  shared: Record<string, unknown>;
  rooms: unknown[];
}[] {
  return apiFetchMock.mock.calls
    .filter(
      ([url, init]) =>
        url === "/inventory/units/batch" &&
        (init as { method?: string } | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

const group = (name: string | RegExp) => screen.getByRole("group", { name });
const textbox = (name: string) => within(group(name)).getByRole("textbox");
const combobox = (name: string) => within(group(name)).getByRole("combobox");

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  render(
    wrap(
      <CreateUnitDialog
        trigger={<button>New unit</button>}
        properties={[{ id: "p1", name: "The Sky Residences", propertyCode: "SKY" }]}
        defaultPropertyId="p1"
      />,
    ),
  );
  await user.click(screen.getByText("New unit"));
  await screen.findByRole("button", { name: /create unit/i });
}

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /create unit/i }));

/**
 * Fills everything CreateUnitDialog.onSubmit checks BEFORE it reaches the
 * occupancy/owner validation, so those later rules are what a test observes.
 */
async function fillRequired(
  user: ReturnType<typeof userEvent.setup>,
  unitCode = "NEW-1",
) {
  await user.type(textbox("Unit code"), unitCode);
  // The type dropdown is a two-step picker: choose Whole|Partition first, then
  // the type. These contract tests exercise the single-unit POST path, so pick
  // Whole + a WHOLE-kind type ("Studio"). Partition now mounts the per-room
  // strip and routes to the batch endpoint — covered by its own describe.
  await user.click(within(group("Unit type")).getByRole("button", { name: /whole unit/i }));
  await user.selectOptions(combobox("Unit type"), "Studio");
  await user.type(screen.getByLabelText(/rental deposit \(months\)/i), "2");
  await user.type(screen.getByLabelText(/utilities deposit \(months\)/i), "1");
}

async function pickOwner(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
  await user.click(await screen.findByText("Bob Lee"));
}

async function pickTenant(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText(/search existing tenants/i), "Nurul");
  await user.click(await screen.findByText("Nurul Izzah"));
}

/** Occupied + tenant + dates. Rent is left to the caller. */
async function makeOccupied(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(combobox("Lifecycle status"), "occupied");
  await pickTenant(user);
  await user.type(screen.getByLabelText(/move-in date/i), "2026-08-01");
  await user.type(screen.getByLabelText(/move-out date/i), "2027-07-31");
}

beforeEach(() => {
  flags.reservationGatedTenancy = false;
  // Toast mocks live for the whole file; clear call history so per-test
  // toHaveBeenCalledWith assertions never see a prior test's toast.
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  setupApi();
});
afterEach(cleanup);

describe("CreateUnitDialog — owner + billing model", () => {
  it("orders the people workflow as Owner, Tenant, then Agent", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    const ownerSection = document.getElementById("unitsec-owner");
    const tenantSection = document.getElementById("unitsec-listing");
    const agentSection = document.getElementById("unitsec-assign");

    expect(ownerSection).not.toBeNull();
    expect(tenantSection).not.toBeNull();
    expect(agentSection).not.toBeNull();

    expect(
      ownerSection!.compareDocumentPosition(tenantSection!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tenantSection!.compareDocumentPosition(agentSection!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders owner and billing model", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    expect(within(group("Owner")).getByPlaceholderText(/search owners/i)).toBeInTheDocument();
    expect(combobox("Billing model")).toBeInTheDocument();
  });

  it("blocks occupied without tenant", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);

    await user.selectOptions(combobox("Lifecycle status"), "occupied");
    await user.type(screen.getByLabelText(/move-in date/i), "2026-08-01");
    await user.type(screen.getByLabelText(/move-out date/i), "2027-07-31");
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "3000");
    await submit(user);

    expect(
      await screen.findByText(/select an existing tenant when occupancy is occupied/i),
    ).toBeInTheDocument();
    expect(postedBodies()).toHaveLength(0);
  });

  it("sends owner and billing model", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({
      ownerPartyId: "owner-9",
      partitionBillingMode: "SUBSIDY",
    });
  });

  it("creates the unit and its management fee config atomically", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user, "MF-01");
    await pickOwner(user);

    const feeSection = screen.getByText("Management fee setup").closest("section");
    expect(feeSection).not.toBeNull();
    await user.clear(within(feeSection!).getByLabelText("Fee (%)"));
    await user.type(within(feeSection!).getByLabelText("Fee (%)"), "12.5");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({
      ownerPartyId: "owner-9",
      managementFeeConfig: {
      feeType: "percent",
      feeValue: "12.5",
      sstPercent: "8",
      },
    });
    expect(
      apiFetchMock.mock.calls.some(
        ([url, init]) =>
          url === "/owner-billing/fee-configs" &&
          (init as { method?: string } | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("auto-fills the first management fee from prorated move-in rent and persists it", async () => {
    setupApi({
      rentPreview: {
        month: "2026-08",
        amount: 1645.16,
        occupiedDays: 17,
        daysInMonth: 31,
        isProrated: true,
      },
    });
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user, "MF-PRORATE");
    await pickOwner(user);
    await user.selectOptions(combobox("Lifecycle status"), "occupied");
    await pickTenant(user);
    await user.type(screen.getByLabelText(/move-in date/i), "2026-08-15");
    await user.type(screen.getByLabelText(/move-out date/i), "2027-08-14");
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "3000");

    const feeSection = screen.getByText("Management fee setup").closest("section");
    expect(feeSection).not.toBeNull();
    await waitFor(() =>
      expect(
        within(feeSection!).getByLabelText("First charge amount before SST"),
      ).toHaveValue(164.52),
    );
    expect(
      within(feeSection!).getByText(/auto-calculated from the prorated move-in rent/i),
    ).toBeInTheDocument();

    await submit(user);
    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({
      managementFeeConfig: {
        feeType: "percent",
        feeValue: "10",
        firstChargeBaseAmount: "164.52",
        sstPercent: "8",
      },
    });
  });

  it("prefills billing model from the existing apartment", async () => {
    setupApi({ apartments: [fixtureApartment({ partitionBillingMode: "SUBSIDY" })] });
    const user = userEvent.setup();
    await openDialog(user);

    await user.type(textbox("Unit code"), "A-18-06");

    await waitFor(() =>
      expect(combobox("Billing model")).toHaveValue("SUBSIDY"),
    );
  });

  it("omits billing model when untouched", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user); // unit code NEW-1 matches no apartment
    await pickOwner(user);
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).not.toHaveProperty("partitionBillingMode");
  });
});

describe("CreateUnitDialog — rent is required on an occupied create, in EVERY flag state", () => {
  it("blocks occupied with no rent, flag off", async () => {
    flags.reservationGatedTenancy = false;
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await makeOccupied(user);
    await submit(user);

    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    expect(postedBodies()).toHaveLength(0);
  });

  it("blocks occupied with no rent, flag on", async () => {
    flags.reservationGatedTenancy = true;
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await makeOccupied(user);
    await submit(user);

    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    expect(postedBodies()).toHaveLength(0);
  });

  it("sends monthlyRent on an occupied create", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await makeOccupied(user);
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "3000");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({ monthlyRent: 3000 });
  });

  // Flag OFF: syncOccupancyTenancy falls back to the unit's rentalRate for a new
  // tenancy, so a client that demanded an explicit tenancy rent would reject a
  // payload the server accepts. (beforeEach resets the flag to false.)
  it("accepts an occupied create carrying only the unit's rental rate", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.type(within(group(/monthly rental/i)).getByRole("spinbutton"), "2200");
    await makeOccupied(user);
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({ rentalRate: 2200 });
    expect(postedBodies()[0]).not.toHaveProperty("monthlyRent");
  });

  // Flag ON: the mirror of the test above, and the reason createRentRule() exists.
  // createUnitService hands the RAW `input.monthlyRent` to syncOccupancyTenancy
  // (inventory.service.ts:1525), which under the flag throws
  // OCCUPANCY_RENT_REQUIRED instead of falling back to rentalRate. If the client
  // still validated "effective" here, this form would POST and eat a server 400
  // with no field to fix. Block it client-side, on the rent field, with no call.
  it("blocks an occupied create carrying ONLY a rental rate when the flag is on", async () => {
    flags.reservationGatedTenancy = true;
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.type(within(group(/monthly rental/i)).getByRole("spinbutton"), "2200");
    await makeOccupied(user);
    await submit(user);

    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    expect(postedBodies()).toHaveLength(0);
  });
});

describe("unitFormToApiPayload — the edit path is untouched by the create opt-ins", () => {
  it("edit payload is unchanged", () => {
    flags.reservationGatedTenancy = false;
    const state = {
      ...blankUnitFormState(),
      occupancyStatus: "occupied",
      tenantPartyId: "t1",
      moveInDate: "2026-04-25",
      moveOutDate: "2026-05-20",
      monthlyRent: "3200",
      ownerPartyId: "o1",
      ownerName: "Ahmad Bin Sulaiman",
      partitionBillingMode: "SUBSIDY",
      tnbSubsidyCapMonthly: "200.00",
    };
    const payload = unitFormToApiPayload(state) as Record<string, unknown>;
    expect("ownerPartyId" in payload).toBe(false);
    expect("monthlyRent" in payload).toBe(false);
    expect("partitionBillingMode" in payload).toBe(false);
    expect("tnbSubsidyCapMonthly" in payload).toBe(false);
  });

  it("emits the apartment-scoped fields only when the create dialog opts in", () => {
    flags.reservationGatedTenancy = false;
    const state = {
      ...blankUnitFormState(),
      occupancyStatus: "occupied",
      tenantPartyId: "t1",
      moveInDate: "2026-04-25",
      moveOutDate: "2026-05-20",
      monthlyRent: "3200",
      ownerPartyId: "o1",
      partitionBillingMode: "SUBSIDY",
      tnbSubsidyCapMonthly: "200.00",
    };
    const payload = unitFormToApiPayload(state, {
      includeOwner: true,
      includeBillingMode: true,
      includeTnbSubsidyCap: true,
      includeRent: true,
    }) as Record<string, unknown>;
    expect(payload.ownerPartyId).toBe("o1");
    expect(payload.partitionBillingMode).toBe("SUBSIDY");
    expect(payload.tnbSubsidyCapMonthly).toBe(200);
    expect(payload.monthlyRent).toBe(3200);
  });

  it("serializes a blank opted-in cap as null to retain the legacy per-pax policy", () => {
    const payload = unitFormToApiPayload(blankUnitFormState(), {
      includeTnbSubsidyCap: true,
    }) as Record<string, unknown>;
    expect(payload.tnbSubsidyCapMonthly).toBeNull();
  });
});

describe("CreateUnitDialog — server codes land on the field that caused them", () => {
  it("surfaces UNIT_HAS_NO_OWNER on the owner field", async () => {
    // 409 with `code` as a TOP-LEVEL sibling of `error`.
    setupApi({
      post: {
        ok: false,
        status: 409,
        body: {
          error:
            "This unit has no assigned owner. Assign an owner before marking it occupied.",
          code: "UNIT_HAS_NO_OWNER",
        },
      },
    });
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await makeOccupied(user);
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "3000");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(
      await within(group("Owner")).findByText(/this unit has no assigned owner/i),
    ).toBeInTheDocument();
  });

  it("surfaces OCCUPANCY_RENT_REQUIRED on the rent field", async () => {
    // 400 with `code` NESTED under `error`.
    setupApi({
      post: {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "OCCUPANCY_RENT_REQUIRED",
            message: "Enter the monthly rent before marking this unit occupied.",
          },
        },
      },
    });
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await makeOccupied(user);
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "3000");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
  });

  it("surfaces APARTMENT_BILLING_MODE_CONFLICT on the billing-model control", async () => {
    setupApi({
      post: {
        ok: false,
        status: 409,
        body: {
          error:
            "This apartment already uses a different utility billing model. Change it from Edit shared details.",
          code: "APARTMENT_BILLING_MODE_CONFLICT",
        },
      },
    });
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(
      await within(group("Billing model")).findByText(/change it from edit shared details/i),
    ).toBeInTheDocument();
  });
});

describe("CreateUnitDialog — Partition routes to the batch endpoint", () => {
  // Pick Partition in the two-step Unit-type control; the per-room strip then
  // mounts (role="tablist" aria-label="Rooms").
  async function choosePartition(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      within(group("Unit type")).getByRole("button", { name: /partition/i }),
    );
    await screen.findByRole("tablist", { name: "Rooms" });
  }
  const roomTypeSelect = () => within(group("Room type")).getByRole("combobox");
  // Strip inputs live inside a FormField `group`; query the spinbutton within
  // that group (the body-level duplicates are hidden in Partition mode).
  const roomField = (name: string) =>
    within(group(name)).getByRole("spinbutton");
  // Deposits (and Parking) are rendered by the shared <DepositFields>/
  // <ParkingFields> components (same ones the Whole-unit path already uses in
  // unit-form-fields.tsx) — a `<label>`-wrapped input, not a FormField
  // `role="group"`. The Whole-level "Deposits & parking" section is hidden
  // entirely in Partition mode, so this stays unambiguous.
  // Fills the ACTIVE room's required deposits.
  async function fillActiveRoomDeposits(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.type(screen.getByLabelText(/rental deposit \(months\)/i), "2");
    await user.type(screen.getByLabelText(/utilities deposit \(months\)/i), "1");
  }

  it("mounts the Room 1 | + New Room strip when Partition is chosen", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await choosePartition(user);

    const strip = screen.getByRole("tablist", { name: "Rooms" });
    // Room 1 tab + the add-room affordance are both present.
    expect(within(strip).getByRole("tab", { name: /room 1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new room/i })).toBeInTheDocument();
  });

  it("submits two rooms to /inventory/units/batch with shared owner + billing model", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-12-01");
    await choosePartition(user);

    // Room 1 → Master (+ required per-room deposits).
    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    // Add Room 2 (auto-selected) → Medium (+ deposits).
    await user.click(screen.getByRole("button", { name: /new room/i }));
    await user.selectOptions(roomTypeSelect(), "Medium");
    await fillActiveRoomDeposits(user);

    // Apartment-scoped fields entered once in the form body.
    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    await waitFor(() => expect(postedBatchBodies()).toHaveLength(1));
    const body = postedBatchBodies()[0];
    expect(body.rooms).toHaveLength(2);
    // Each room carries the schema-required deposits (batchRoomFields makes
    // both non-optional; a dropped key 400s server-side).
    expect(body.rooms[0]).toMatchObject({ depositMonths: 2, utilitiesDepositMonths: 1 });
    expect(body.rooms[1]).toMatchObject({ depositMonths: 2, utilitiesDepositMonths: 1 });
    expect(body.shared).toMatchObject({
      ownerPartyId: "owner-9",
      partitionBillingMode: "SUBSIDY",
      unitCode: "B-12-01",
    });
    // The single-unit endpoint is NOT used on the Partition path.
    expect(postedBodies()).toHaveLength(0);
  });

  /** Occupies the ACTIVE room via the strip's OWN Occupancy status control —
   *  distinct from the (hidden-in-Partition) top-level Lifecycle status that
   *  `makeOccupied` drives. Rent is left to the caller. */
  async function makeActiveRoomOccupied(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(
      within(group("Occupancy status")).getByRole("combobox"),
      "occupied",
    );
    await pickTenant(user);
    await user.type(screen.getByLabelText(/move-in date/i), "2026-09-01");
    await user.type(screen.getByLabelText(/move-out date/i), "2027-08-31");
  }

  it("includes tenant + dates + rent in the batch payload for a room marked Occupied", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-15-01");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await makeActiveRoomOccupied(user);
    await user.type(screen.getByLabelText(/tenancy monthly rent/i), "2600");
    await pickOwner(user);
    await submit(user);

    await waitFor(() => expect(postedBatchBodies()).toHaveLength(1));
    const body = postedBatchBodies()[0];
    expect(body.rooms[0]).toMatchObject({
      occupancyStatus: "occupied",
      tenantPartyId: "tenant-9",
      moveInDate: "2026-09-01",
      moveOutDate: "2027-08-31",
      monthlyRent: 2600,
    });
  });

  it("omits tenant/dates/rent for a Vacant room, sending occupancyStatus only", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-16-01");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await pickOwner(user);
    await submit(user);

    await waitFor(() => expect(postedBatchBodies()).toHaveLength(1));
    const body = postedBatchBodies()[0];
    expect(body.rooms[0]).toMatchObject({ occupancyStatus: "vacant" });
    expect(body.rooms[0]).not.toHaveProperty("tenantPartyId");
    expect(body.rooms[0]).not.toHaveProperty("moveInDate");
    expect(body.rooms[0]).not.toHaveProperty("moveOutDate");
    expect(body.rooms[0]).not.toHaveProperty("monthlyRent");
  });

  // Regression: an Occupied room left with no rent used to fail SILENTLY — the
  // batch endpoint 400s (OCCUPANCY_RENT_REQUIRED) but the strip's OccupancyFields
  // was passed a hardcoded `errors={{}}`, so nothing rendered and the modal
  // looked frozen. The pre-submit check now blocks it client-side with a visible
  // toast AND a field-level error on the offending room, before any POST.
  it("surfaces a visible error (toast + field) for an Occupied room with no rent — never a silent no-op", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-17-01");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    // Occupied with a tenant + both dates, but NO rent (and no rental rate).
    await makeActiveRoomOccupied(user);
    await pickOwner(user);
    await submit(user);

    // A visible toast naming the room — the frozen-modal symptom is gone.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/occupied/i)),
    );
    // The field-level rent error is threaded into the active room's OccupancyFields.
    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    // Blocked before any network write — neither endpoint is called.
    expect(postedBatchBodies()).toHaveLength(0);
    expect(postedBodies()).toHaveLength(0);
  });

  // Flag-ON twin of the test above, on the BATCH path. createUnitsBatchService
  // hands the RAW `room.monthlyRent` to syncOccupancyTenancy
  // (inventory.service.ts:951), which under the flag will NOT fall back to the
  // room's rentalRate. A room carrying a rent-per-month but no explicit tenancy
  // rent must therefore be blocked here, not 400'd on the server.
  it("blocks an Occupied room carrying ONLY a room rent when the flag is on", async () => {
    flags.reservationGatedTenancy = true;
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-17-02");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await user.type(roomField("Rent (RM/month)"), "1800");
    await makeActiveRoomOccupied(user);
    await pickOwner(user);
    await submit(user);

    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    expect(postedBatchBodies()).toHaveLength(0);
    expect(postedBodies()).toHaveLength(0);
  });

  it("hides the apartment-level Monthly rental + Deposits & parking when Partition is chosen", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // Whole/default: the body-level Monthly rental field is present.
    expect(screen.getByRole("group", { name: /monthly rental/i })).toBeInTheDocument();
    expect(screen.getByText("Deposits & parking")).toBeInTheDocument();

    await choosePartition(user);

    // Partition: the duplicated apartment-level fields are gone — the body-level
    // Monthly rental field and the whole Deposits & parking section are hidden,
    // leaving only the strip's per-room <DepositFields> inputs.
    expect(screen.queryByRole("group", { name: /monthly rental/i })).toBeNull();
    expect(screen.queryByText("Deposits & parking")).toBeNull();
    expect(screen.getByLabelText(/rental deposit \(months\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/utilities deposit \(months\)/i)).toBeInTheDocument();
  });

  it("hides lifecycle, tenant, listing status, sourcing agent, visibility and pax deduction in Partition mode", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await choosePartition(user);

    // Lifecycle + Listing status selects are gone — neither is persisted by the
    // batch endpoint.
    expect(screen.queryByRole("group", { name: /lifecycle status/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /listing status/i })).toBeNull();
    // The occupancy block (and therefore the tenant picker) never mounts.
    expect(screen.queryByPlaceholderText(/search existing tenants/i)).toBeNull();
    // Sourcing agent + the Visibility control are gone.
    expect(screen.queryByRole("group", { name: /sourcing agent/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /visibility/i })).toBeNull();
    // The whole Pax deduction section is gone.
    expect(screen.queryByText("Pax deduction")).toBeNull();
    expect(screen.queryByText(/pax-based rent deduction applies/i)).toBeNull();

    // In charge, Owner and Billing model REMAIN — they are on `shared`.
    expect(screen.getByRole("group", { name: /in charge/i })).toBeInTheDocument();
    expect(
      within(group("Owner")).getByPlaceholderText(/search owners/i),
    ).toBeInTheDocument();
    expect(combobox("Billing model")).toBeInTheDocument();
  });

  // T3: the "Rooms are created as Draft and vacant" note is now FALSE — each
  // room's own Occupancy status/tenant/dates/rent (rendered by the strip) let
  // an admin create a room already Occupied. Pin the callout's removal so a
  // future regression doesn't reintroduce stale, contradictory copy.
  it("does not show the (removed) Draft/vacant explanatory note in Partition mode", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await choosePartition(user);
    expect(
      screen.queryByText(
        /set lifecycle, visibility and tenants on each room after it exists/i,
      ),
    ).toBeNull();
    // The strip's own Occupancy status control is what replaced it.
    expect(screen.getByRole("group", { name: /occupancy status/i })).toBeInTheDocument();
  });

  it("Whole mode keeps every non-persistable control and shows no partition note (regression pin)", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // Whole/default: all controls present.
    expect(screen.getByRole("group", { name: /lifecycle status/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /listing status/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /sourcing agent/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /visibility/i })).toBeInTheDocument();
    expect(screen.getByText("Pax deduction")).toBeInTheDocument();
    // The tenant picker mounts once Lifecycle = Occupied.
    await user.selectOptions(combobox("Lifecycle status"), "occupied");
    expect(
      await screen.findByPlaceholderText(/search existing tenants/i),
    ).toBeInTheDocument();
    // The partition note is NOT shown on the Whole path.
    expect(
      screen.queryByText(
        /set lifecycle, visibility and tenants on each room after it exists/i,
      ),
    ).toBeNull();
  });

  it("blocks a Partition submit when a tenant is set in state, names the tenant, and makes no network call (defence in depth)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-7-01");

    // Assign a tenant while Whole + Occupied, then return to Vacant so ONLY the
    // tenant deviates from its default. Form state persists across the switch to
    // Partition, where the tenant control is hidden — exactly the "future
    // refactor un-hides a field" case this guard defends against.
    await user.selectOptions(combobox("Lifecycle status"), "occupied");
    await pickTenant(user);
    await user.selectOptions(combobox("Lifecycle status"), "vacant");
    await choosePartition(user);

    // A complete room, so the defence-in-depth guard — not a missing-room or
    // missing-deposit check — is what blocks.
    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await pickOwner(user);
    await submit(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/tenant/i)),
    );
    // No call to EITHER endpoint.
    expect(postedBatchBodies()).toHaveLength(0);
    expect(postedBodies()).toHaveLength(0);
  });

  it("blocks a Partition submit when a sourcing agent is set in state, names it, and makes no network call (defence in depth)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-8-01");

    // Pick a sourcing agent while Whole (it also fans out to In-charge), then
    // switch to Partition where the Sourcing-agent control is hidden but the
    // value persists in state. The batch endpoint carries no sourcing field, so
    // submitting would silently demote the agent to in-charge-only and land the
    // rooms COMPANY-sourced — commission-relevant, so block instead.
    await user.type(
      within(group(/sourcing agent/i)).getByPlaceholderText(/search by name/i),
      "Siti",
    );
    await user.click(await screen.findByText("Siti Agent"));
    await choosePartition(user);

    // A complete room, so the defence-in-depth guard — not a missing-room or
    // missing-deposit check — is what blocks.
    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await pickOwner(user);
    await submit(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/sourcing agent/i)),
    );
    expect(postedBatchBodies()).toHaveLength(0);
    expect(postedBodies()).toHaveLength(0);
  });

  it("blocks a Partition submit when the PUBLIC 'Hidden from' list is set, and makes no network call (defence in depth)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-6-01");

    // Visibility stays PUBLIC (default), so the visibilityMode guard passes.
    // Add an agent to the PUBLIC "Hidden from" blocklist while Whole, then flip
    // to Partition where the control is hidden but the list persists. The batch
    // shared body has no visibility fields, so the created rooms would be
    // visible to an agent the admin explicitly hid — block instead.
    await user.type(
      within(group(/hidden from/i)).getByPlaceholderText(/search by name/i),
      "Siti",
    );
    await user.click(await screen.findByText("Siti Agent"));
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    await pickOwner(user);
    await submit(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/hidden from/i)),
    );
    expect(postedBatchBodies()).toHaveLength(0);
    expect(postedBodies()).toHaveLength(0);
  });

  it("hides the top-level Unit type dropdown in Partition mode (types are per-room; the pick would go nowhere)", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // Whole/default: the step-2 type dropdown is present.
    expect(within(group("Unit type")).getByRole("combobox")).toBeInTheDocument();

    await choosePartition(user);

    // Partition: the orphaned top-level dropdown is gone (buildPartitionPayload
    // never maps form.unitType and it seeds no room), leaving only the step-1
    // Whole|Partition mode buttons so the admin can still switch back.
    expect(within(group("Unit type")).queryByRole("combobox")).toBeNull();
    expect(
      within(group("Unit type")).getByRole("button", { name: /partition/i }),
    ).toBeInTheDocument();
  });

  it("blocks a Partition submit when a room is missing its required deposits", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-3-01");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    // Deliberately leave deposits blank.
    await pickOwner(user);
    await submit(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/rental deposit \(months\) is required/i),
      ),
    );
    // The schema-invalid body never reaches the batch endpoint.
    expect(postedBatchBodies()).toHaveLength(0);
  });

  it("blocks a Partition submit when a room has data but no type (no silent drop)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-4-01");
    await choosePartition(user);

    // Room 1 complete.
    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits(user);
    // Room 2: rent entered but type forgotten — must NOT be silently dropped.
    await user.click(screen.getByRole("button", { name: /new room/i }));
    await user.type(roomField("Rent (RM/month)"), "900");
    await pickOwner(user);
    await submit(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/room 2 needs a type/i),
      ),
    );
    expect(postedBatchBodies()).toHaveLength(0);
  });

  it("excludes an already-used sibling type from the next room's options", async () => {
    // The strip prevents entering a within-batch duplicate in the first place:
    // once Room 1 is Master, Room 2's dropdown no longer offers Master. This is
    // the user-facing guarantee; partitionDuplicateError is the submit backstop.
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-9-01");
    await choosePartition(user);

    await user.selectOptions(roomTypeSelect(), "Master");
    await user.click(screen.getByRole("button", { name: /new room/i }));

    const room2 = roomTypeSelect();
    expect(within(room2).queryByRole("option", { name: "Master" })).toBeNull();
    expect(within(room2).getByRole("option", { name: "Medium" })).toBeInTheDocument();
  });

  it("names the duplicate and returns non-null (submit backstop)", () => {
    expect(
      partitionDuplicateError([
        { ...blankRoom(), unitType: "Master" },
        { ...blankRoom(), unitType: "Master" },
      ]),
    ).toMatch(/duplicated:\s*master/i);
    // Distinct types pass; blank rows are ignored, not flagged.
    expect(
      partitionDuplicateError([
        { ...blankRoom(), unitType: "Master" },
        { ...blankRoom(), unitType: "Medium" },
        blankRoom(),
      ]),
    ).toBeNull();
  });

  it("Whole mode still uses the single-unit POST (regression pin)", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "W-1");
    // Pick Whole, then a WHOLE-kind type.
    await user.click(
      within(group("Unit type")).getByRole("button", { name: /whole unit/i }),
    );
    await user.selectOptions(combobox("Unit type"), "Studio");
    await user.type(screen.getByLabelText(/rental deposit \(months\)/i), "2");
    await user.type(screen.getByLabelText(/utilities deposit \(months\)/i), "1");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    expect(postedBodies()[0]).toMatchObject({ unitType: "Studio" });
    // No batch call on the Whole path.
    expect(postedBatchBodies()).toHaveLength(0);
  });
});

describe("CreateUnitDialog — two-phase media step", () => {
  it("whole create shows the media step bound to the returned id and stays open", async () => {
    setupApi(); // POST resolves the harness default { id: "unit-1" }
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    const step = await screen.findByTestId("create-media-step");
    expect(step.getAttribute("data-ids")).toBe("unit-1");
  });

  it("whole create with no id closes without a media step", async () => {
    setupApi({ post: { ok: true, noId: true } }); // POST resolves {}
    const user = userEvent.setup();
    await openDialog(user);
    await fillRequired(user);
    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    await waitFor(() => expect(postedBodies()).toHaveLength(1));
    // Closed exactly as today: the dialog itself unmounts (Base UI removes
    // DialogContent when open=false), so NEITHER the form NOR a media step
    // is in the tree.
    await waitFor(() => {
      expect(screen.queryByTestId("create-media-step")).toBeNull();
      expect(screen.queryByRole("button", { name: /^create unit$/i })).toBeNull();
    });
  });

  it("partition create shows one tab per created room", async () => {
    setupApi(); // batch derives room-1..room-N from the submitted rooms
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-20-01");
    await user.click(
      within(group("Unit type")).getByRole("button", { name: /partition/i }),
    );
    await screen.findByRole("tablist", { name: "Rooms" });

    const roomTypeSelect = () => within(group("Room type")).getByRole("combobox");
    const fillActiveRoomDeposits = async () => {
      await user.type(screen.getByLabelText(/rental deposit \(months\)/i), "2");
      await user.type(screen.getByLabelText(/utilities deposit \(months\)/i), "1");
    };

    await user.selectOptions(roomTypeSelect(), "Master");
    await fillActiveRoomDeposits();
    await user.click(screen.getByRole("button", { name: /new room/i }));
    await user.selectOptions(roomTypeSelect(), "Medium");
    await fillActiveRoomDeposits();

    await pickOwner(user);
    await user.selectOptions(combobox("Billing model"), "SUBSIDY");
    await submit(user);

    const step = await screen.findByTestId("create-media-step");
    expect(step.getAttribute("data-ids")).toBe("room-1,room-2");
    // Labels come from variables.rooms[i]?.unitType (create-unit-dialog.tsx),
    // not the returned ids — locks the untested label-derivation seam.
    expect(step.getAttribute("data-labels")).toBe("Master,Medium");
  });

  it("partition create with empty ids closes", async () => {
    setupApi({ batchIds: [] }); // batch resolves { ids: [] }
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(textbox("Unit code"), "B-21-01");
    await user.click(
      within(group("Unit type")).getByRole("button", { name: /partition/i }),
    );
    await screen.findByRole("tablist", { name: "Rooms" });

    await user.selectOptions(within(group("Room type")).getByRole("combobox"), "Master");
    await user.type(screen.getByLabelText(/rental deposit \(months\)/i), "2");
    await user.type(screen.getByLabelText(/utilities deposit \(months\)/i), "1");
    await pickOwner(user);
    await submit(user);

    await waitFor(() => expect(postedBatchBodies()).toHaveLength(1));
    await waitFor(() => {
      expect(screen.queryByTestId("create-media-step")).toBeNull();
      expect(screen.queryByRole("button", { name: /^create unit$/i })).toBeNull();
    });
  });
});
