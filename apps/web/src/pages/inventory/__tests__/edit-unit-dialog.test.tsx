import { render, screen, act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EditUnitForm,
  detailToFormState,
  type FetchedUnitDetail,
} from "../edit-unit-dialog";
import {
  blankUnitFormState,
  unitFormToApiPayload,
  UnitFormBody,
} from "../unit-form-fields";
import type { ApartmentSummary } from "@/api/inventory-units-batch";
import { apiFetch } from "@/lib/api-client";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Keep the REAL ApiError (+ extractApiError): edit-unit-dialog's onError does
// `err instanceof ApiError`, so the mock must preserve the class or a rejecting
// mutation surfaces "No ApiError export defined".
vi.mock("@/lib/api-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: vi.fn((url: string) => {
      // The amenity catalog is fetched by useActiveAmenities for the combobox —
      // return the two catalog rows the chip-render test expects.
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) {
        return Promise.resolve({
          data: [
            { id: "p", name: "Pool", organizationId: "o", sortOrder: 0, isActive: true, createdAt: "", updatedAt: "" },
            { id: "g", name: "Pet-friendly", organizationId: "o", sortOrder: 1, isActive: true, createdAt: "", updatedAt: "" },
          ],
        });
      }
      // TenantSelect typeahead — return empty list (no matches needed for render tests)
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ id: "u1" });
    }),
  };
});

// Task 4 — stub the inline media panel so these tests exercise EditUnitForm's
// own render/mount wiring (listingId + seeded keys) without pulling in the
// real ListingMediaPanel → useMediaLimits() → apiFetch("/listings/media/limits")
// chain. vi.mock is file-scoped + hoisted, so this also shields every
// pre-existing test in this file from mounting the real panel.
// The mock also exposes a button that calls the parent's onMediaChanged prop
// directly — this is how the Fix C+D wiring tests drive a server-confirmed
// media change without mounting the real ListingMediaPanel/upload machinery.
vi.mock("../unit-media-step", () => ({
  SingleUnitMediaPanel: (p: {
    listingId: string;
    initialPhotoKeys?: string[];
    onMediaChanged?: (next: { photoKeys: string[]; videoKeys: string[] }) => void;
  }) => (
    <div
      data-testid="edit-media-panel"
      data-listing-id={p.listingId}
      data-photos={(p.initialPhotoKeys ?? []).join(",")}
    >
      {/* type="button" is load-bearing: this mock renders inside EditUnitForm's
          real <form>, so an unqualified <button> (default type="submit")
          would trigger a genuine form submission and mask what this test is
          actually exercising. */}
      <button type="button" onClick={() => p.onMediaChanged?.({ photoKeys: ["p1"], videoKeys: [] })}>
        trigger-media-changed
      </button>
    </div>
  ),
}));

function makeDetail(overrides: Partial<FetchedUnitDetail> = {}): FetchedUnitDetail {
  return {
    id: "u1",
    unitCode: "A-18-06",
    unitType: "penthouse",
    bedrooms: 3,
    bathrooms: 2,
    floorArea: 1200,
    rentalRate: 4500,
    currency: "MYR",
    occupancyStatus: "occupied",
    listingStatus: "active",
    // depositMonths + utilitiesDepositMonths are required by the edit form
    // (DepositFields marks both inputs `required`). Existing rows that hydrate
    // through detailToFormState need real values, otherwise native HTML5
    // validation will block the form's `submit` event before zod-level
    // refiners (occupancy trio, etc.) get a chance to run.
    depositMonths: 2,
    utilitiesDepositMonths: 0.5,
    amenities: [
      { id: "p", name: "Pool" },
      { id: "g", name: "Gym" },
    ],
    description: "Sunny corner unit.",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    hiddenFromAgentNames: [],
    grantedPartyIds: [],
    grantedAgentNames: [],
    sourceFlag: "COMPANY",
    inChargePartyId: null,
    inChargeName: null,
    sourcingAgentId: null,
    sourcingAgentName: null,
    property: {
      id: "p1",
      name: "The Sky Residences",
      propertyCode: "SKY",
      city: "Kuala Lumpur",
      hasPaxDeduction: true,
      paxDeductionAmount: 50,
    },
    // Default: occupied unit has an activeTenancy with masked IC/phone so the
    // confirm card renders on mount and the form does not start blank.
    activeTenancy: {
      id: "ten1",
      tenantPartyId: "t1",
      tenantName: "NURUL IZZAH",
      tenantIdType: "nric",
      tenantIdNumberMasked: "••••5678",
      tenantPhone: "+60 12-345 6789",
      startDate: "2026-04-25",
      endDate: "2026-05-20",
    },
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // MemoryRouter is required because the AmenityCombobox renders a <Link>
  // for the "go to Inventory Settings" empty-state callout.
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("detailToFormState", () => {
  it("hydrates every field the dialog renders", () => {
    const f = detailToFormState(makeDetail());
    expect(f).toMatchObject({
      unitCode: "A-18-06",
      unitType: "penthouse",
      bedrooms: "3",
      bathrooms: "2",
      floorArea: "1200",
      rentalRate: "4500",
      occupancyStatus: "occupied",
      listingStatus: "active",
      amenities: ["p", "g"],
      description: "Sunny corner unit.",
      visibilityMode: "PUBLIC",
      sourceFlag: "COMPANY",
      hasPaxDeduction: true,
      paxDeductionAmount: "50",
    });
  });

  it("coerces null numerics and missing description to empty strings (form-friendly)", () => {
    const f = detailToFormState(
      makeDetail({
        bedrooms: null,
        bathrooms: null,
        floorArea: null,
        rentalRate: null,
        description: null,
      }),
    );
    expect(f.bedrooms).toBe("");
    expect(f.bathrooms).toBe("");
    expect(f.floorArea).toBe("");
    expect(f.rentalRate).toBe("");
    expect(f.description).toBe("");
  });

  it("falls back to PUBLIC visibility defaults and no-pax when property is null", () => {
    const f = detailToFormState(makeDetail({ property: null }));
    expect(f.hasPaxDeduction).toBe(false);
    expect(f.paxDeductionAmount).toBe("");
  });
});

describe("Amenities field — wired in both Create and Edit dialogs (Bug #10)", () => {
  // The unit dialog's amenities surface is the AmenityCombobox rendered by
  // UnitFormBody — shared between create-unit-dialog and edit-unit-dialog.
  // This regression test pins the round-trip: blank create form → set IDs →
  // convert to API payload → server echoes catalog rows back on detail fetch
  // → edit form unwraps to IDs again. If a future refactor splits the shared
  // body or drops the amenities field from either schema, this test fails
  // first.
  it("create-unit payload carries amenity IDs through unitFormToApiPayload", () => {
    const form = blankUnitFormState();
    form.unitCode = "A-18-06";
    form.amenities = ["p", "g"];

    const payload = unitFormToApiPayload(form);
    expect(payload.amenities).toEqual(["p", "g"]);
  });

  it("edit-unit unwraps amenity catalog rows to IDs in form state", () => {
    const detail = makeDetail({
      amenities: [
        { id: "p", name: "Pool" },
        { id: "g", name: "Pet-friendly" },
      ],
    });
    const f = detailToFormState(detail);
    expect(f.amenities).toEqual(["p", "g"]);

    // And renders them back into the API payload unchanged on save.
    const payload = unitFormToApiPayload(f);
    expect(payload.amenities).toEqual(["p", "g"]);
  });

  it("EditUnitForm renders the amenity chips into the DOM", async () => {
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({
            amenities: [
              { id: "p", name: "Pool" },
              { id: "g", name: "Pet-friendly" },
            ],
          })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Chip removal buttons carry an aria-label of `Remove ${name}` — using
    // them as the assertion target proves both selected amenities rendered
    // as removable chips inside the AmenityCombobox once useActiveAmenities
    // resolves the catalog.
    expect(await screen.findByLabelText("Remove Pool")).toBeInTheDocument();
    expect(await screen.findByLabelText("Remove Pet-friendly")).toBeInTheDocument();
  });
});

describe("EditUnitForm — occupancy validation", () => {
  it("blocks save with inline errors when Occupied is selected and tenancy trio is empty", async () => {
    const user = userEvent.setup();
    // Override: activeTenancy=null so the form starts blank (no pre-selected tenant,
    // no move-in/out dates). Previously the default makeDetail() had no activeTenancy;
    // now makeDetail() defaults to one, so we explicitly null it here.
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ activeTenancy: null })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );

    // The form starts in "occupied" state with empty tenancy fields.
    // Click save immediately — validation must fire before the mutation.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // All three field-level errors must appear inline.
    // The error now uses tenantPartyId (picker) not tenantName (free-text).
    expect(
      await screen.findByText(/select an existing tenant when occupancy is occupied/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/move-in date is required when occupancy is occupied/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/move-out date is required when occupancy is occupied/i),
    ).toBeInTheDocument();

    // The PUT mutation must NOT have fired.
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/inventory\/units\//),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("EditUnitForm — regression: open → save → reopen keeps fields populated", () => {
  it("renders fields populated from detail on mount", () => {
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail()}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Unit code and bedrooms are concrete textbox values pulled from detail —
    // if the form mounted blank, both would be empty.
    expect(screen.getByDisplayValue("A-18-06")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3")).toBeInTheDocument(); // bedrooms
    expect(screen.getByDisplayValue("Sunny corner unit.")).toBeInTheDocument();
  });

  it("re-mounting with a NEW detail re-initialises form state from the new detail", () => {
    // Simulates the dialog-close → dialog-reopen lifecycle. Each mount must
    // pick up the latest server state via the useState lazy initializer —
    // never via a useEffect that could miss a same-reference data update
    // when react-query's structural sharing collapses identical refetches.
    const { unmount } = render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ unitCode: "OLD-CODE", bedrooms: 1 })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByDisplayValue("OLD-CODE")).toBeInTheDocument();

    act(() => {
      unmount();
    });

    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ unitCode: "NEW-CODE", bedrooms: 5 })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByDisplayValue("NEW-CODE")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    // OLD-CODE must NOT leak through. If the form had used a useState that
    // wasn't lazy-initialised from the new mount's prop, this would fail.
    expect(screen.queryByDisplayValue("OLD-CODE")).not.toBeInTheDocument();
  });
});

// Highlights field — 2026-05-13 apartment-aggregation-and-highlights spec.
// Apartment-scoped free-form chips, distinct from the catalog Amenities.
describe("Highlights field — hydration + payload round-trip", () => {
  it("detailToFormState hydrates highlights from the wire shape", () => {
    const f = detailToFormState(makeDetail({ highlights: ["Near KLCC", "Corner unit"] }));
    expect(f.highlights).toEqual(["Near KLCC", "Corner unit"]);
  });

  it("detailToFormState defaults to [] when the server omits highlights (legacy clients)", () => {
    const detail = makeDetail();
    // makeDetail's default omits highlights — the field is optional on
    // FetchedUnitDetail because older API builds may not surface it.
    delete (detail as { highlights?: string[] }).highlights;
    const f = detailToFormState(detail);
    expect(f.highlights).toEqual([]);
  });

  it("unitFormToApiPayload includes highlights on the wire", () => {
    const form = blankUnitFormState();
    form.unitCode = "A-18-06";
    form.unitType = "studio";
    form.highlights = ["Near KLCC", "Renovated 2025"];
    const payload = unitFormToApiPayload(form);
    expect(payload.highlights).toEqual(["Near KLCC", "Renovated 2025"]);
  });

  it("blankUnitFormState seeds highlights as an empty array", () => {
    expect(blankUnitFormState().highlights).toEqual([]);
  });
});

// Apartment-scoped delta detection — spec §"shared field changed" rules.
// These tests pin the comparison semantics that drive the fan-out
// confirmation prompt in EditUnitDialog.
describe("apartmentScopedChangedFields", () => {
  // Pull the helper via require so the test stays decoupled from the rest of
  // the dialog's module shape — the function is exported alongside the form.
  // (Defined inline to keep type help.)
  const importHelper = async () => {
    const mod = await import("../edit-unit-dialog");
    return mod.apartmentScopedChangedFields;
  };

  it("returns [] when no apartment-scoped field changed", async () => {
    const fn = await importHelper();
    const base = blankUnitFormState();
    base.bedrooms = "2";
    base.bathrooms = "2";
    base.amenities = ["p", "g"];
    expect(fn(base, base)).toEqual([]);
  });

  it("ignores per-room field changes (rent, occupancy, parking)", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.bedrooms = "2";
    a.rentalRate = "1200";
    a.occupancyStatus = "vacant";
    const b = { ...a, rentalRate: "1500", occupancyStatus: "occupied", parkingQuantity: "2" };
    expect(fn(a, b)).toEqual([]);
  });

  it("treats '' ↔ null as NOT a change for scalar apartment fields", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.bedrooms = "";
    a.floorArea = "";
    const b = { ...a }; // identical
    expect(fn(a, b)).toEqual([]);
  });

  it("flags bedrooms when the value differs", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.bedrooms = "2";
    const b = { ...a, bedrooms: "3" };
    expect(fn(a, b)).toEqual(["bedrooms"]);
  });

  it("trims description before comparison — whitespace-only changes are NOT a change", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.description = "Sunny corner unit.";
    const b = { ...a, description: "  Sunny corner unit.  " };
    expect(fn(a, b)).toEqual([]);
  });

  it("flags description when content (post-trim) differs", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.description = "Sunny corner unit.";
    const b = { ...a, description: "Sunny corner unit with view." };
    expect(fn(a, b)).toEqual(["description"]);
  });

  it("treats amenities as a set — reorder is NOT a change", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.amenities = ["p", "g"];
    const b = { ...a, amenities: ["g", "p"] };
    expect(fn(a, b)).toEqual([]);
  });

  it("flags amenities when an item is added or removed", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.amenities = ["p", "g"];
    const b = { ...a, amenities: ["p"] };
    expect(fn(a, b)).toEqual(["amenities"]);
  });

  it("treats highlights as a set — reorder is NOT a change", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.highlights = ["Near KLCC", "Corner unit"];
    const b = { ...a, highlights: ["Corner unit", "Near KLCC"] };
    expect(fn(a, b)).toEqual([]);
  });

  it("flags highlights when an item is added", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.highlights = ["Near KLCC"];
    const b = { ...a, highlights: ["Near KLCC", "Quiet floor"] };
    expect(fn(a, b)).toEqual(["highlights"]);
  });

  it("can report multiple changed fields at once", async () => {
    const fn = await importHelper();
    const a = blankUnitFormState();
    a.bedrooms = "2";
    a.amenities = ["p"];
    const b = { ...a, bedrooms: "3", amenities: ["p", "g"] };
    expect(fn(a, b).sort()).toEqual(["amenities", "bedrooms"]);
  });
});

// Task 8: tenant picker hydration + payload assertions.
describe("Task 8 — hydration + payload for tenant picker", () => {
  it("hydrates tenantPartyId + masked IC/phone from activeTenancy", () => {
    const f = detailToFormState(makeDetail({
      activeTenancy: {
        id: "ten1", tenantPartyId: "t1", tenantName: "NURUL IZZAH",
        tenantIdType: "nric", tenantIdNumberMasked: "••••5678", tenantPhone: "+60 12-345 6789",
        startDate: "2026-04-25", endDate: "2026-05-20",
      },
    }));
    expect(f).toMatchObject({
      tenantPartyId: "t1", tenantName: "NURUL IZZAH",
      tenantIdType: "nric", tenantIdNumberMasked: "••••5678", tenantPhone: "+60 12-345 6789",
      moveInDate: "2026-04-25", moveOutDate: "2026-05-20",
    });
  });

  it("payload sends tenantPartyId (not tenantName) when occupied", () => {
    const state = { ...blankUnitFormState(), occupancyStatus: "occupied",
      tenantPartyId: "t1", tenantName: "NURUL IZZAH",
      moveInDate: "2026-04-25", moveOutDate: "2026-05-20" };
    const payload = unitFormToApiPayload(state) as Record<string, unknown>;
    expect(payload.tenantPartyId).toBe("t1");
    expect(payload.moveInDate).toBe("2026-04-25");
    expect(payload.moveOutDate).toBe("2026-05-20");
    expect("tenantName" in payload).toBe(false); // name is display-only; not sent
  });

  it("payload omits the tenancy fields when not occupied", () => {
    const state = { ...blankUnitFormState(), occupancyStatus: "vacant", tenantPartyId: "t1" };
    const payload = unitFormToApiPayload(state) as Record<string, unknown>;
    expect("tenantPartyId" in payload).toBe(false);
  });
});

// Final-review Fix 1 flag-off parity: this file does not mock
// @/lib/feature-flags, so isPhase2FlagEnabled reads the real (unset in
// tests) VITE_ENABLE_PHASE2_RESERVATION_GATED_TENANCY env var and returns
// false. The monthlyRent field must stay entirely invisible to the wire in
// that state -- flag-off "mark occupied" keeps sending the same payload as
// before the fix (server still silently defaults to rentalRate). See
// edit-unit-dialog.monthly-rent.test.tsx for the flag-ON coverage.
describe("Fix 1 — monthlyRent flag-off parity", () => {
  it("unitFormToApiPayload omits monthlyRent when occupied (flag off)", () => {
    const state = {
      ...blankUnitFormState(),
      occupancyStatus: "occupied",
      tenantPartyId: "t1",
      moveInDate: "2026-04-25",
      moveOutDate: "2026-05-20",
      monthlyRent: "3200",
    };
    const payload = unitFormToApiPayload(state) as Record<string, unknown>;
    expect("monthlyRent" in payload).toBe(false);
  });

  it("EditUnitForm renders no tenancy-monthly-rent input (flag off)", () => {
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail()}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.queryByLabelText(/tenancy monthly rent/i)).not.toBeInTheDocument();
  });
});

// Task 5 — owner (read-only in per-room dialog): hydration + display.
// Owner is set at the apartment level ("Edit shared details"); the per-room
// edit dialog displays it read-only and does NOT write it back on save.
describe("Task 5 — owner read-only: hydration + payload", () => {
  it("detailToFormState hydrates ownerPartyId and ownerName from the detail", () => {
    const f = detailToFormState(
      makeDetail({ ownerPartyId: "o1", ownerName: "Ahmad Bin Sulaiman" }),
    );
    expect(f).toMatchObject({
      ownerPartyId: "o1",
      ownerName: "Ahmad Bin Sulaiman",
    });
  });

  it("detailToFormState defaults ownerPartyId to null when absent", () => {
    const f = detailToFormState(makeDetail({ ownerPartyId: undefined, ownerName: undefined }));
    expect(f.ownerPartyId).toBeNull();
    expect(f.ownerName).toBe("");
  });

  it("unitFormToApiPayload never includes ownerPartyId — owner is not sent from the per-room save", () => {
    // Owner is set at the unit level; the per-room dialog is read-only for owner.
    const stateWithOwner = {
      ...blankUnitFormState(),
      ownerPartyId: "o1",
      ownerName: "Ahmad Bin Sulaiman",
    };
    const payload = unitFormToApiPayload(stateWithOwner) as Record<string, unknown>;
    expect("ownerPartyId" in payload).toBe(false);
  });

  it("unitFormToApiPayload never includes ownerPartyId even when owner is null", () => {
    const stateNoOwner = { ...blankUnitFormState(), ownerPartyId: null, ownerName: "" };
    const payload = unitFormToApiPayload(stateNoOwner) as Record<string, unknown>;
    expect("ownerPartyId" in payload).toBe(false);
  });

  it("EditUnitForm renders owner name read-only when owner is set", async () => {
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ ownerPartyId: "o1", ownerName: "Ahmad Bin Sulaiman" })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Owner name appears as static text (not an input) — verify it's in the DOM.
    expect(await screen.findByText("Ahmad Bin Sulaiman")).toBeInTheDocument();
    // No editable input/button for owner (no search box, no "Change owner" button).
    expect(screen.queryByPlaceholderText(/search owners/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PRD-A Task 3 (G5 = Approach D). The unified Edit modal routes each dirty
// apartment-scoped field to the service that owns it; the per-unit PUT never
// carries ownerPartyId. These are the regression pins the whole approach turns
// on — R5 routing + ordering + the no-owner-key body.
//
// This file's module-level apiFetch mock is a plain vi.fn(); the block below
// installs a routing-aware implementation in beforeEach and restores the plain
// default afterEach, so the earlier per-unit tests are untouched.
// ---------------------------------------------------------------------------

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
    listingMode: "WHOLE",
    partitionBillingMode: "NO_SUBSIDY",
    ownerPartyId: "owner-1",
    ownerName: "Ahmad Bin Sulaiman",
    ownerPhone: "+60 12-000 0000",
    underManagement: true,
    ...overrides,
  };
}

const isUnitPut = (url: unknown, init: unknown) =>
  url === "/inventory/units/u1" &&
  (init as { method?: string } | undefined)?.method === "PUT";
const isSharedPatch = (url: unknown, init: unknown) =>
  typeof url === "string" &&
  url === "/apartments/apt-1/shared" &&
  (init as { method?: string } | undefined)?.method === "PATCH";

/** Indices into apiFetch.mock.calls, in call order. */
function callIndices() {
  const calls = vi.mocked(apiFetch).mock.calls;
  return {
    put: calls.findIndex(([u, i]) => isUnitPut(u, i)),
    patch: calls.findIndex(([u, i]) => isSharedPatch(u, i)),
    putCount: calls.filter(([u, i]) => isUnitPut(u, i)).length,
    patchCount: calls.filter(([u, i]) => isSharedPatch(u, i)).length,
  };
}

function unitPutBody(): Record<string, unknown> {
  const call = vi.mocked(apiFetch).mock.calls.find(([u, i]) => isUnitPut(u, i));
  return JSON.parse((call![1] as { body: string }).body);
}

describe("EditUnitForm — R5 routing (G5 Approach D)", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
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
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.resolve({ id: "u1" });
      return Promise.resolve({ id: "u1" });
    });
  });
  afterEach(() => {
    // Restore the file's plain default so subsequent files are unaffected.
    vi.mocked(apiFetch).mockReset();
  });

  const group = (name: string | RegExp) => screen.getByRole("group", { name });

  function renderEdit(detail: FetchedUnitDetail, apartment: ApartmentSummary) {
    render(
      wrap(
        <EditUnitForm
          detail={detail}
          unitId="u1"
          propertyName="The Sky Residences"
          apartment={apartment}
          onClose={() => {}}
        />,
      ),
    );
  }

  it("rent-only edit issues exactly ONE request and its body has no ownerPartyId", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null, rentalRate: 4500 }),
      fixtureApartment(),
    );

    const rent = within(group(/monthly rental/i)).getByRole("spinbutton");
    await user.clear(rent);
    await user.type(rent, "5000");
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    await waitFor(() => expect(callIndices().putCount).toBe(1));
    const idx = callIndices();
    // Exactly one PUT, zero apartment-shared PATCH — nothing apartment-scoped changed.
    expect(idx.patchCount).toBe(0);
    const body = unitPutBody();
    expect(body).not.toHaveProperty("ownerPartyId");
    expect(body).toMatchObject({ rentalRate: 5000 });
  });

  it("owner-change edit routes to apartment-shared FIRST, then per-unit; PUT body still has no ownerPartyId", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment(),
    );

    // Re-point the owner: the seeded owner shows as a confirm card; change it.
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));

    // Save → the R6 blast-radius confirmation gates the request.
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    const confirmBtn = await screen.findByRole("button", { name: /re-point owner/i });
    expect(callIndices().patchCount).toBe(0); // nothing sent until confirmed
    await user.click(confirmBtn);

    await waitFor(() => expect(callIndices().putCount).toBe(1));
    const idx = callIndices();
    expect(idx.patchCount).toBe(1);
    // R5 ordering: the apartment-shared PATCH is issued BEFORE the per-unit PUT.
    expect(idx.patch).toBeGreaterThanOrEqual(0);
    expect(idx.patch).toBeLessThan(idx.put);

    // The apartment-shared body carries the new owner…
    const patchCall = vi.mocked(apiFetch).mock.calls.find(([u, i]) => isSharedPatch(u, i));
    expect(JSON.parse((patchCall![1] as { body: string }).body)).toMatchObject({
      ownerPartyId: "owner-9",
    });
    // …and the G5 pin holds: the per-unit body NEVER carries ownerPartyId.
    expect(unitPutBody()).not.toHaveProperty("ownerPartyId");
  });

  it("does not issue the per-unit PUT when the apartment-shared call fails", async () => {
    // Abort-on-first-failure (R5): a rejecting apartment-shared call must leave
    // the per-unit PUT unsent.
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [{ id: "owner-9", displayName: "Bob Lee", primaryPhone: "+60123456789", formattedPhone: "+60 12-345 6789" }],
        });
      }
      if (isSharedPatch(url, init)) return Promise.reject(new Error("boom"));
      if (isUnitPut(url, init)) return Promise.resolve({ id: "u1" });
      return Promise.resolve({ id: "u1" });
    });

    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null, ownerPartyId: "owner-1", ownerName: "Ahmad Bin Sulaiman" }),
      fixtureApartment(),
    );

    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    await user.click(await screen.findByRole("button", { name: /re-point owner/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    // The rejecting PATCH aborts the sequence — the per-unit PUT never fires.
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 1 — Important #1: occupied-unit owner-CLEAR must be blocked
  // client-side. Otherwise the apartment-shared PATCH commits an apartment-wide
  // owner wipe FIRST, and only then does the per-unit PUT 409 on
  // UNIT_HAS_NO_OWNER — a destructive partial write. Mirrors create's guard.
  it("blocks an occupied-unit owner-clear before any request — no apartment PATCH, no PUT, inline error", async () => {
    const user = userEvent.setup();
    // makeDetail defaults to occupied WITH a valid activeTenancy, so occupancy
    // validation passes and the OWNER guard is the only thing that can block.
    renderEdit(
      makeDetail({ ownerPartyId: "owner-1", ownerName: "Ahmad Bin Sulaiman" }),
      fixtureApartment(),
    );

    // Clear the owner without picking a replacement.
    await user.click(screen.getByRole("button", { name: /change owner/i }));

    // Submit.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // Blocked with an inline error…
    expect(
      await screen.findByText(/assign an owner before marking this unit occupied/i),
    ).toBeInTheDocument();
    // …the R6 owner confirm must NOT appear (the guard fires before it)…
    expect(
      screen.queryByRole("button", { name: /re-point owner/i }),
    ).not.toBeInTheDocument();
    // …and neither the destructive apartment PATCH nor the per-unit PUT fires.
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 3 — the wave-1 guard only checked the EDITED room's own occupancy.
  // The owner is apartment-scoped, so clearing it commits an apartment-wide wipe
  // (updateApartmentSharedService allows a null owner unconditionally, no
  // occupancy check). The per-unit PUT can't catch it either — its
  // UNIT_HAS_NO_OWNER guard is occupied-only, so a VACANT edited room never
  // 409s. Editing a vacant room whose SIBLING is occupied and clearing the owner
  // must therefore be blocked here, before any request fires.
  it("blocks owner-clear when a sibling room is occupied — no PATCH, no PUT, inline error", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment({
        rooms: [
          { id: "r-self", unitType: "penthouse", rentalRate: 4500, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null },
          { id: "r-sib", unitType: "studio", rentalRate: 1000, occupancyStatus: "occupied", listingStatus: "active", inChargePartyId: null },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    expect(
      await screen.findByText(/assign an owner before clearing it/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /re-point owner/i }),
    ).not.toBeInTheDocument();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 3 — a RESERVED edited room is not "occupied", so the wave-1 guard
  // let its owner be wiped. A reserved room's later reservation→tenancy
  // conversion 409s UNIT_HAS_NO_OWNER, so the wipe must be blocked here too.
  it("blocks owner-clear when the edited room is reserved — no PATCH, no PUT, inline error", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "reserved",
        activeTenancy: null,
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment(),
    );

    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    expect(
      await screen.findByText(/assign an owner before clearing it/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /re-point owner/i }),
    ).not.toBeInTheDocument();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 3 — the guard must NOT over-block: a fully-vacant apartment has no
  // tenancy to orphan, so clearing the owner is legitimate. It still routes
  // through the R6 blast-radius confirm and then the apartment-shared PATCH.
  it("allows owner-clear when the whole apartment is vacant — PATCH clears the owner", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment({
        rooms: [
          { id: "r-self", unitType: "penthouse", rentalRate: 4500, occupancyStatus: "vacant", listingStatus: "active", inChargePartyId: null },
        ],
      }),
    );

    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    // ownerDirty ⇒ the R6 confirm gates the request; confirm it.
    await user.click(await screen.findByRole("button", { name: /re-point owner/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    const patchCall = vi.mocked(apiFetch).mock.calls.find(([u, i]) => isSharedPatch(u, i));
    expect(JSON.parse((patchCall![1] as { body: string }).body)).toMatchObject({
      ownerPartyId: null,
    });
  });

  // FIX WAVE 1 — Important #2: after the apartment-shared PATCH commits but the
  // per-unit PUT fails, a retry must NOT re-fire the owner PATCH (duplicate
  // audit rows + a second ledger re-materialisation) and the R6 confirm must
  // NOT reappear (which would imply a rollback that never happened).
  it("does not re-fire the committed owner PATCH on retry after a per-unit PUT failure", async () => {
    // PATCH succeeds; the per-unit PUT rejects (e.g. a downstream conflict).
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [{ id: "owner-9", displayName: "Bob Lee", primaryPhone: "+60123456789", formattedPhone: "+60 12-345 6789" }],
        });
      }
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.reject(new Error("boom"));
      return Promise.resolve({ id: "u1" });
    });

    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null, ownerPartyId: "owner-1", ownerName: "Ahmad Bin Sulaiman" }),
      fixtureApartment(),
    );

    // First save: change owner, confirm blast radius → PATCH commits, PUT fails.
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    await user.click(await screen.findByRole("button", { name: /re-point owner/i }));
    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    await waitFor(() => expect(callIndices().putCount).toBe(1));

    // Retry: the apartment owner already committed, so the confirm must NOT
    // reappear and the PATCH must NOT fire a second time — only the PUT retries.
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    await waitFor(() => expect(callIndices().putCount).toBe(2));
    expect(callIndices().patchCount).toBe(1); // still exactly one — no duplicate owner PATCH
    expect(
      screen.queryByRole("button", { name: /re-point owner/i }),
    ).not.toBeInTheDocument();
  });

  // FIX WAVE 2 — after the apartment-shared PATCH commits but the per-unit PUT
  // fails, the by-property apartments cache (staleTime 30s in EditUnitDialog)
  // still holds the PRE-PATCH owner. onSuccess (which invalidates it) never
  // runs on the failure path, so a close+reopen within 30s would re-seed the
  // stale owner and a re-do would fire a DUPLICATE PATCH. The mutationFn must
  // invalidate ["inventory","apartments-by-property"] the moment the PATCH
  // commits, mirroring the in-place re-baseline for the reopen path.
  it("invalidates the by-property apartments cache once the owner PATCH commits, even if the per-unit PUT fails", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [{ id: "owner-9", displayName: "Bob Lee", primaryPhone: "+60123456789", formattedPhone: "+60 12-345 6789" }],
        });
      }
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.reject(new Error("boom")); // PUT fails AFTER the PATCH commits
      return Promise.resolve({ id: "u1" });
    });

    // Own the QueryClient so we can watch invalidateQueries. onSuccess never
    // runs here (the PUT rejects), so the ONLY apartments invalidation that can
    // occur is the one the fix issues right after the PATCH commits.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalSpy = vi.spyOn(qc, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <EditUnitForm
            detail={makeDetail({ occupancyStatus: "vacant", activeTenancy: null, ownerPartyId: "owner-1", ownerName: "Ahmad Bin Sulaiman" })}
            unitId="u1"
            propertyName="The Sky Residences"
            apartment={fixtureApartment()}
            onClose={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    await user.click(await screen.findByRole("button", { name: /re-point owner/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    await waitFor(() => expect(callIndices().putCount).toBe(1));

    const invalidatedApartments = invalSpy.mock.calls.some(([arg]) => {
      const key = (arg as { queryKey?: unknown } | undefined)?.queryKey;
      return Array.isArray(key) && key[0] === "inventory" && key[1] === "apartments-by-property";
    });
    expect(invalidatedApartments).toBe(true);
  });

  // FIX WAVE 1 — Important #1: a saved type that is ABSENT from the active Room
  // Types list (deactivated after the unit was saved) is synthesized with a
  // placeholder kind ("WHOLE") so the dropdown can still render the value. That
  // placeholder must NOT drive the two-step picker: inferring from it opens a
  // genuinely partitioned room on "Whole Unit" and locks the partition optgroup.
  // With the fix, neither mode button is pressed — the operator picks a mode.
  it("does not infer the step mode from a deactivated (legacy) unit type", async () => {
    // room-types resolves EMPTY (R5 beforeEach), so the saved "Deluxe" type is
    // not in the active list and is synthesized as a legacy option.
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null, unitType: "Deluxe" }),
      fixtureApartment(),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /whole unit/i }).getAttribute("aria-pressed"),
      ).toBe("false"),
    );
    // …and the partition button is not falsely pressed either.
    expect(
      screen.getByRole("button", { name: /^partition/i }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  // FIX WAVE 1 — Important #2: the two-step picker clears unitType in ONE click
  // (switching Whole↔Partition drops the off-mode selection). Edit's onSubmit
  // must reject an empty unitType BEFORE runSubmit, mirroring the create dialog.
  // Otherwise a save that also re-points the owner COMMITS the apartment-shared
  // PATCH first and only THEN 400s on the per-unit PUT's Zod `unitType:min(1)`,
  // leaving a destructive partial write (owner re-pointed apartment-wide).
  it("blocks save when the unit type was cleared — no owner PATCH, no PUT (partial-commit guard)", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        unitType: "penthouse",
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment(),
    );

    // Re-point the owner (the destructive apartment-scoped write)…
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    // …and clear the unit type in one click by switching mode to Partition.
    await user.click(screen.getByRole("button", { name: /^partition/i }));

    // Save.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // The type guard fires BEFORE runSubmit: the R6 owner confirm never appears
    // and neither the apartment PATCH nor the per-unit PUT is issued.
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Pick a unit type."),
    );
    expect(screen.queryByRole("button", { name: /re-point owner/i })).toBeNull();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 2 — the partial-commit SIBLING the empty-type guard did NOT close.
  // The two-step picker lets an Edit switch step-1 mode and pick an ACTIVE
  // off-apartment-mode type (a Partition type while the apartment is Whole).
  // unitType is now NON-empty, so the empty-type guard passes — but the per-unit
  // PUT would 400 on the server's kind-mismatch guard (LISTING_MODE_MISMATCH),
  // and only AFTER the apartment-shared PATCH has committed the owner re-point
  // (ledgers re-materialised). onSubmit must reject the mode conflict BEFORE
  // runSubmit: apartment.listingMode is the client mirror of the server's
  // sibling-derived currentMode (identical derivation, inventory.service.ts).
  it("blocks save when the picked type conflicts with the apartment's listing mode — no owner PATCH, no PUT", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) {
        // An ACTIVE Whole type (the saved value) and an ACTIVE Partition type.
        return Promise.resolve({
          data: [
            { id: "rt-w", name: "Studio", kind: "WHOLE", sortOrder: 0 },
            { id: "rt-p", name: "Room A", kind: "PARTITION", sortOrder: 1 },
          ],
        });
      }
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [{ id: "owner-9", displayName: "Bob Lee", primaryPhone: "+60123456789", formattedPhone: "+60 12-345 6789" }],
        });
      }
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.resolve({ id: "u1" });
      return Promise.resolve({ id: "u1" });
    });

    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        unitType: "Studio", // ACTIVE Whole type → picker opens on Whole
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment(), // listingMode: "WHOLE"
    );

    // Wait for the room-types query to resolve so the picker opens on Whole
    // (effectiveMode inferred from the ACTIVE "Studio" type) — otherwise the
    // interactions below race the async load.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /whole unit/i }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    // Re-point the owner (the destructive apartment-scoped write)…
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    // …switch the picker to Partition. NOTE: the first click clears the Whole
    // "Studio" (kind mismatch) but the picker's `set` helper spreads a stale
    // state snapshot (unit-form-fields.tsx), so the mode-set and the value-clear
    // issued in the same handler clobber and the mode falls back to null — a
    // pre-existing picker quirk (the real operator clicks again). A second click
    // now enters Partition cleanly (nothing left to clear).
    const partitionBtn = () => screen.getByRole("button", { name: /^partition/i });
    await user.click(partitionBtn());
    await user.click(partitionBtn());
    await waitFor(() =>
      expect(partitionBtn().getAttribute("aria-pressed")).toBe("true"),
    );
    // …and pick an ACTIVE Partition type, so unitType is NON-empty (the
    // empty-type guard no longer applies) but its kind conflicts with the
    // apartment's Whole listing mode.
    const roomA = await screen.findByRole("option", { name: "Room A" });
    await user.selectOptions(roomA.closest("select") as HTMLSelectElement, "Room A");

    // Save.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // The mode-conflict guard fires BEFORE runSubmit: the R6 owner confirm never
    // appears and neither the apartment PATCH nor the per-unit PUT is issued.
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "This apartment is listed as Whole. Switch its Listing mode first, then change the unit type.",
      ),
    );
    expect(screen.queryByRole("button", { name: /re-point owner/i })).toBeNull();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 3 (a) — partial-commit sibling: unitCode edit + owner re-point.
  // The Unit code TextInput is editable in the shared form body, but
  // updateUnitService hard-400s ANY change to it ("unitCode is owned by the
  // parent Apartment…", inventory.service.ts). A typo-fix + owner re-point in
  // one save would commit the apartment-shared PATCH (ledgers re-materialised)
  // and only THEN 400 the per-unit PUT — a destructive partial write. onSubmit
  // must reject a changed unitCode BEFORE runSubmit so no request is issued.
  it("blocks save when the unit code was changed — no owner PATCH, no PUT (partial-commit guard)", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        unitCode: "A-18-06",
        unitType: "penthouse",
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment(),
    );

    // Re-point the owner (the destructive apartment-scoped write)…
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    // …and fix a "typo" in the unit code (server-rejected on this endpoint).
    const code = within(group(/unit code/i)).getByRole("textbox");
    await user.clear(code);
    await user.type(code, "A-18-6");

    // Save.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // The unitCode guard fires BEFORE runSubmit: the R6 owner confirm never
    // appears and neither the apartment PATCH nor the per-unit PUT is issued.
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Unit code belongs to the apartment and can't be changed here. Reset it to A-18-06 before saving.",
      ),
    );
    expect(screen.queryByRole("button", { name: /re-point owner/i })).toBeNull();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });

  // FIX WAVE 3 (b) — partial-commit sibling: duplicate sibling unitType (SAME
  // kind) + owner re-point. Changing this room's type to one a sibling listing
  // already uses 409s on the server's (apartmentId, listingType) conflict check
  // (findListingTypeConflict). Because the duplicate is the SAME kind, neither
  // the empty-type guard nor the mode-conflict guard fires — unitType is
  // non-empty and its kind matches the apartment's mode. onSubmit must reject
  // the collision BEFORE runSubmit: apartment.rooms carries every sibling's id +
  // unitType, so mirror the server's exclude-self conflict check exactly.
  it("blocks save when the picked type duplicates a sibling room's type — no owner PATCH, no PUT", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) {
        // Two ACTIVE Partition types — both valid in a PARTITIONED apartment.
        return Promise.resolve({
          data: [
            { id: "rt-a", name: "Room A", kind: "PARTITION", sortOrder: 0 },
            { id: "rt-b", name: "Room B", kind: "PARTITION", sortOrder: 1 },
          ],
        });
      }
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) return Promise.resolve({ data: [] });
      if (typeof url === "string" && url.startsWith("/parties/owners/search")) {
        return Promise.resolve({
          data: [{ id: "owner-9", displayName: "Bob Lee", primaryPhone: "+60123456789", formattedPhone: "+60 12-345 6789" }],
        });
      }
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.resolve({ id: "u1" });
      return Promise.resolve({ id: "u1" });
    });

    const user = userEvent.setup();
    renderEdit(
      makeDetail({
        occupancyStatus: "vacant",
        activeTenancy: null,
        unitType: "Room A", // this listing (u1) is Room A…
        ownerPartyId: "owner-1",
        ownerName: "Ahmad Bin Sulaiman",
      }),
      fixtureApartment({
        listingMode: "PARTITIONED",
        // …and a SIBLING listing already occupies Room B.
        rooms: [
          {
            id: "u1",
            unitType: "Room A",
            rentalRate: 4500,
            occupancyStatus: "vacant",
            listingStatus: "active",
            inChargePartyId: null,
          },
          {
            id: "u2",
            unitType: "Room B",
            rentalRate: 4500,
            occupancyStatus: "vacant",
            listingStatus: "active",
            inChargePartyId: null,
          },
        ],
      }),
    );

    // Wait for the room-types query so the picker opens on Partition (inferred
    // from the ACTIVE "Room A" type) before we interact.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^partition/i }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    // Re-point the owner (the destructive apartment-scoped write)…
    await user.click(screen.getByRole("button", { name: /change owner/i }));
    await user.type(await screen.findByPlaceholderText(/search owners/i), "Bob");
    await user.click(await screen.findByText("Bob Lee"));
    // …and change this room's type to "Room B" — same kind, so the mode guard
    // stays silent, but it collides with the sibling listing.
    const roomB = await screen.findByRole("option", { name: "Room B" });
    await user.selectOptions(roomB.closest("select") as HTMLSelectElement, "Room B");

    // Save.
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    // The duplicate-type guard fires BEFORE runSubmit: no confirm, no requests.
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Another room in this apartment already uses that unit type. Pick a different type.",
      ),
    );
    expect(screen.queryByRole("button", { name: /re-point owner/i })).toBeNull();
    expect(callIndices().patchCount).toBe(0);
    expect(callIndices().putCount).toBe(0);
  });
});

// Task 8 — under-management toggle. EDIT-only checkbox that dispatches
// { underManagement: false } on the SAME apartment-shared PATCH as
// owner/billing. Mirrors the billing-model field's dirty-tracking + routing
// exactly, but is a DEDICATED showUnderManagement prop (not showBillingModel)
// so the create dialog never renders it.
describe("Task 8 — under-management toggle", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/inventory/amenities")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/commissions/room-types")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.startsWith("/parties/tenants/search")) {
        return Promise.resolve({ data: [] });
      }
      if (isSharedPatch(url, init)) return Promise.resolve({ data: { id: "apt-1" } });
      if (isUnitPut(url, init)) return Promise.resolve({ id: "u1" });
      return Promise.resolve({ id: "u1" });
    });
  });
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  function renderEdit(detail: FetchedUnitDetail, apartment: ApartmentSummary) {
    render(
      wrap(
        <EditUnitForm
          detail={detail}
          unitId="u1"
          propertyName="The Sky Residences"
          apartment={apartment}
          onClose={() => {}}
        />,
      ),
    );
  }

  it("flip-and-save: toggling under-management off issues an apartment PATCH containing ONLY underManagement:false", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null }),
      fixtureApartment({ underManagement: true }),
    );

    const toggle = await screen.findByRole("checkbox", {
      name: /this apartment is under kaen management/i,
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await user.click(screen.getByRole("button", { name: /update unit/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    const patchCall = vi.mocked(apiFetch).mock.calls.find(([u, i]) => isSharedPatch(u, i));
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body).toEqual({ underManagement: false });
  });

  it("untouched-omitted: an apartment PATCH triggered by an unrelated apartment-scoped field change omits underManagement", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null }),
      fixtureApartment({ underManagement: true, partitionBillingMode: "NO_SUBSIDY" }),
    );

    const billingSelect = within(
      screen.getByRole("group", { name: /billing model/i }),
    ).getByRole("combobox");
    await user.selectOptions(billingSelect, "SUBSIDY");
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    const patchCall = vi.mocked(apiFetch).mock.calls.find(([u, i]) => isSharedPatch(u, i));
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body).not.toHaveProperty("underManagement");
    expect(body).toMatchObject({ partitionBillingMode: "SUBSIDY" });
  });

  it("saves the monthly TNB owner subsidy cap through the apartment PATCH", async () => {
    const user = userEvent.setup();
    renderEdit(
      makeDetail({ occupancyStatus: "vacant", activeTenancy: null }),
      fixtureApartment({
        partitionBillingMode: "SUBSIDY",
        tnbSubsidyCapMonthly: null,
      }),
    );

    const capInput = within(
      screen.getByRole("group", {
        name: /monthly tnb owner subsidy cap/i,
      }),
    ).getByRole("spinbutton");
    await user.type(capInput, "200.00");
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    await waitFor(() => expect(callIndices().patchCount).toBe(1));
    const patchCall = vi.mocked(apiFetch).mock.calls.find(([u, i]) =>
      isSharedPatch(u, i),
    );
    const body = JSON.parse((patchCall![1] as { body: string }).body);
    expect(body).toEqual({ tnbSubsidyCapMonthly: 200 });
  });

  it("create-omission: UnitFormBody without showUnderManagement does not render the toggle", () => {
    render(
      wrap(
        <UnitFormBody
          state={blankUnitFormState()}
          setState={() => {}}
          showPropertySelect={false}
        />,
      ),
    );
    expect(screen.queryByText(/under management/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /this apartment is under kaen management/i }),
    ).not.toBeInTheDocument();
  });
});

describe("EditUnitForm — inline media panel", () => {
  it("mounts SingleUnitMediaPanel bound to unitId, seeded from detail media", () => {
    const detail = makeDetail({ id: "u1", photoKeys: ["p1"] });
    render(wrap(<EditUnitForm detail={detail} unitId="u1" propertyName="P" onClose={() => {}} />));
    const panel = screen.getByTestId("edit-media-panel");
    expect(panel.getAttribute("data-listing-id")).toBe("u1");
    expect(panel.getAttribute("data-photos")).toBe("p1");
  });

  it("does not crash when detail omits media fields", () => {
    const detail = makeDetail({ id: "u9" }); // no photoKeys/videoKeys
    render(wrap(<EditUnitForm detail={detail} unitId="u9" propertyName="P" onClose={() => {}} />));
    expect(screen.getByTestId("edit-media-panel").getAttribute("data-photos")).toBe("");
  });

  // R4/R1 per-room isolation — THIS is the authoritative isolation proof
  // (Traceability R4 + Acceptance R1 cite it). Two forms for distinct rooms
  // bind distinct panel listingIds; combined with Task 1's local-per-panel
  // state, one room's media can never read/write another's.
  it("binds two rooms' panels to distinct listingIds (per-room isolation)", () => {
    render(
      wrap(
        <>
          <EditUnitForm detail={makeDetail({ id: "r1" })} unitId="r1" propertyName="P" onClose={() => {}} />
          <EditUnitForm detail={makeDetail({ id: "r2" })} unitId="r2" propertyName="P" onClose={() => {}} />
        </>,
      ),
    );
    const ids = screen.getAllByTestId("edit-media-panel").map((n) => n.getAttribute("data-listing-id")).sort();
    expect(ids).toEqual(["r1", "r2"]);
  });
});

// Fix C+D wiring — SP-2 review Findings C+D. EditUnitForm supplies
// onMediaChanged to SingleUnitMediaPanel so a server-confirmed media change
// (a) re-seeds the edit-form query cache (so a later room-tab remount picks
// up fresh keys, not a stale snapshot) and (b) invalidates the SP-1
// inventory list cache (so card counts refresh even if the admin closes
// without clicking Save — media commits to the server independently of the
// form's own mutation).
describe("EditUnitForm — onMediaChanged wiring (Fix C+D)", () => {
  function renderWithClient(qc: QueryClient, detail: FetchedUnitDetail, unitId = "u1") {
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <EditUnitForm detail={detail} unitId={unitId} propertyName="P" onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("patches the edit-form query cache with the new keys, preserving other detail fields", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const detail = makeDetail({ id: "u1", unitCode: "A-18-06", photoKeys: ["old-p"], videoKeys: ["old-v"] });
    qc.setQueryData(["inventory", "unit", "u1", "edit-form"], { data: detail });

    renderWithClient(qc, detail);
    await user.click(screen.getByText("trigger-media-changed"));

    const cached = qc.getQueryData<{ data: FetchedUnitDetail }>(["inventory", "unit", "u1", "edit-form"]);
    expect(cached?.data.photoKeys).toEqual(["p1"]);
    expect(cached?.data.videoKeys).toEqual([]);
    // Untouched fields survive the patch — proves a spread merge, not a
    // wholesale cache replacement.
    expect(cached?.data.unitCode).toBe("A-18-06");
  });

  it("invalidates the inventory list cache on a server-confirmed media change", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const detail = makeDetail({ id: "u1", photoKeys: [] });
    qc.setQueryData(["inventory", "unit", "u1", "edit-form"], { data: detail });
    const invalSpy = vi.spyOn(qc, "invalidateQueries");

    renderWithClient(qc, detail);
    await user.click(screen.getByText("trigger-media-changed"));

    expect(invalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["inventory"] }),
    );
  });

  it("does not throw when no edit-form cache entry exists yet", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const detail = makeDetail({ id: "u1", photoKeys: [] });
    // No qc.setQueryData seed here — the cache entry is absent.
    renderWithClient(qc, detail);

    await expect(user.click(screen.getByText("trigger-media-changed"))).resolves.not.toThrow();
    expect(qc.getQueryData(["inventory", "unit", "u1", "edit-form"])).toBeUndefined();
  });
});
