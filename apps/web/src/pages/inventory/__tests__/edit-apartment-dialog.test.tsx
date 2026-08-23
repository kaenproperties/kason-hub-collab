// Phase D — EditApartmentDialog behaviour.
// Covers delta detection (the exported helper), pre-fill from
// ApartmentSummary, no-change behaviour, the ConfirmAlert flow, and the
// drift banner.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EditApartmentDialog,
  apartmentFormChangedFields,
} from "../edit-apartment-dialog";
import type { ApartmentSummary } from "@/api/inventory-units-batch";

// Mock the batch API client so we can assert what payload is sent.
const createUnitsBatchMock = vi.hoisted(() => vi.fn());
const updateApartmentSharedMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/inventory-units-batch", async () => {
  const actual = await vi.importActual<
    typeof import("@/api/inventory-units-batch")
  >("@/api/inventory-units-batch");
  return {
    ...actual,
    createUnitsBatch: createUnitsBatchMock,
    updateApartmentShared: updateApartmentSharedMock,
  };
});

// apiFetch is used by OwnerSelect (owners/search typeahead). Mock it so
// the owner SET-path test can resolve a search result without a real server.
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));

// Amenity catalog hook — empty array so the combobox renders without
// network. The dialog renders Highlights too which uses TagInput
// (no fetch).
vi.mock("@/hooks/use-amenities", () => ({
  useActiveAmenities: () => ({ data: [], isLoading: false }),
}));

// Sonner toast — silence + capture.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

function makeApartment(overrides: Partial<ApartmentSummary> = {}): ApartmentSummary {
  return {
    id: "apt-test-edit",
    unitCode: "C-12-34",
    floor: 12,
    bedrooms: 3,
    bathrooms: 3,
    floorArea: 1200,
    amenities: [{ id: "a-pool", name: "Pool" }],
    highlights: ["Near KLCC"],
    description: "Sunny apartment",
    rooms: [
      {
        id: "u-master",
        unitType: "Master",
        rentalRate: 1200,
        occupancyStatus: "occupied",
        listingStatus: "active",
        inChargePartyId: null,
      },
      {
        id: "u-medium",
        unitType: "Medium",
        rentalRate: 900,
        occupancyStatus: "vacant",
        listingStatus: "active",
        inChargePartyId: null,
      },
    ],
    hasDrift: false,
    listingMode: null,
    ownerPartyId: null,
    ownerName: null,
    ownerPhone: null,
    underManagement: true,
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("apartmentFormChangedFields — delta detection", () => {
  const baseForm = {
    unitCode: "C-12-34",
    floor: "12",
    bedrooms: "3",
    bathrooms: "3",
    floorArea: "1200",
    amenities: ["a-pool"],
    highlights: ["Near KLCC"],
    description: "Sunny apartment",
    partitionBillingMode: null as null | "SUBSIDY" | "NO_SUBSIDY",
    tnbSubsidyCapMonthly: "",
    ownerPartyId: null as string | null,
    ownerName: "",
    ownerPhone: null as string | null,
  };

  it("returns [] when nothing changed", () => {
    expect(apartmentFormChangedFields(baseForm, baseForm)).toEqual([]);
  });

  it("flags bedrooms when changed", () => {
    expect(
      apartmentFormChangedFields(baseForm, { ...baseForm, bedrooms: "4" }),
    ).toEqual(["bedrooms"]);
  });

  it("flags the apartment monthly TNB subsidy cap when changed", () => {
    expect(
      apartmentFormChangedFields(baseForm, {
        ...baseForm,
        tnbSubsidyCapMonthly: "200.00",
      }),
    ).toEqual(["tnbSubsidyCapMonthly"]);
  });

  it("treats '' ↔ null as NOT a change for scalars", () => {
    const empty = { ...baseForm, floor: "", bedrooms: "", bathrooms: "", floorArea: "" };
    expect(apartmentFormChangedFields(empty, empty)).toEqual([]);
  });

  it("treats whitespace-only description difference as NOT a change", () => {
    expect(
      apartmentFormChangedFields(baseForm, {
        ...baseForm,
        description: "  Sunny apartment  ",
      }),
    ).toEqual([]);
  });

  it("uses set semantics for amenities (reorder ≠ change)", () => {
    expect(
      apartmentFormChangedFields(
        { ...baseForm, amenities: ["x", "y"] },
        { ...baseForm, amenities: ["y", "x"] },
      ),
    ).toEqual([]);
  });

  it("flags amenities when an entry is added or removed", () => {
    expect(
      apartmentFormChangedFields(
        { ...baseForm, amenities: ["x"] },
        { ...baseForm, amenities: ["x", "y"] },
      ),
    ).toEqual(["amenities"]);
  });

  it("uses set semantics for highlights too", () => {
    expect(
      apartmentFormChangedFields(
        { ...baseForm, highlights: ["a", "b"] },
        { ...baseForm, highlights: ["b", "a"] },
      ),
    ).toEqual([]);
  });

  it("reports multiple changed fields at once", () => {
    expect(
      apartmentFormChangedFields(baseForm, {
        ...baseForm,
        bedrooms: "4",
        highlights: ["Near KLCC", "Quiet floor"],
      }).sort(),
    ).toEqual(["bedrooms", "highlights"]);
  });
});

describe("EditApartmentDialog — pre-fill + no-change behaviour", () => {
  it("pre-fills the form fields from the ApartmentSummary on open", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment()}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));
    // Each field is reachable by its label — the form renders
    // `<label><span>Floor</span><Input/></label>` which RTL's
    // getByLabelText resolves to the inner input.
    expect((await screen.findByLabelText("Floor")) as HTMLInputElement).toHaveValue(12);
    expect((screen.getByLabelText("Bedrooms")) as HTMLInputElement).toHaveValue(3);
    expect((screen.getByLabelText("Bathrooms")) as HTMLInputElement).toHaveValue(3);
    expect((screen.getByLabelText("Floor area (sqft)")) as HTMLInputElement).toHaveValue(1200);
    expect((screen.getByLabelText("Description")) as HTMLTextAreaElement).toHaveValue(
      "Sunny apartment",
    );
    // Highlight chip should render
    expect(screen.getByText("Near KLCC")).toBeInTheDocument();
  });

  it("renders 'Edit shared details · {unitCode}' as the dialog title", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment()}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));
    expect(
      await screen.findByText(/Edit shared details · C-12-34/i),
    ).toBeInTheDocument();
  });

  it("clicking Save with no changes shows a toast and does NOT call the mutation", async () => {
    createUnitsBatchMock.mockReset();
    toastMock.info.mockReset();
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment()}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));
    // The Save button is disabled when no fields changed. Sanity-check the
    // disabled state matches the "no-op" behaviour we want.
    const saveBtn = await screen.findByRole("button", { name: /save apartment/i });
    expect(saveBtn).toBeDisabled();
    expect(createUnitsBatchMock).not.toHaveBeenCalled();
  });
});

describe("EditApartmentDialog — fan-out flow", () => {
  it("changing a scalar field → confirmation modal lists the changed field → mutation sends rooms=[] + applyToExistingSiblings=true", async () => {
    createUnitsBatchMock.mockReset();
    createUnitsBatchMock.mockResolvedValue({
      ids: [],
      updatedIds: ["u-master", "u-medium"],
    });
    toastMock.success.mockReset();
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment()}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    // Edit bedrooms 3 → 4 — use label-based lookup to avoid ambiguity with
    // bathrooms (which also has value 3).
    const bedroomsInput = (await screen.findByLabelText("Bedrooms")) as HTMLInputElement;
    await user.clear(bedroomsInput);
    await user.type(bedroomsInput, "4");

    // Submit
    await user.click(screen.getByRole("button", { name: /save apartment/i }));

    // ConfirmAlert title appears
    expect(
      await screen.findByText(/update apartment-level fields\?/i),
    ).toBeInTheDocument();
    // Body lists the changed field name in <strong>. Targeted query
    // because the literal word "bedrooms" also appears as the form label;
    // role+selector here picks the strong-tagged version inside the alert.
    const strongs = screen.getAllByText(/^bedrooms$/i, { selector: "strong" });
    expect(strongs.length).toBeGreaterThan(0);

    // Confirm
    await user.click(screen.getByRole("button", { name: /update apartment/i }));

    expect(createUnitsBatchMock).toHaveBeenCalledTimes(1);
    const payload = createUnitsBatchMock.mock.calls[0]![0];
    expect(payload.rooms).toEqual([]);
    expect(payload.applyToExistingSiblings).toBe(true);
    expect(payload.shared.bedrooms).toBe(4);
    expect(payload.shared.unitCode).toBe("C-12-34");
  });
});

describe("EditApartmentDialog — drift banner", () => {
  it("renders the drift Callout when hasDrift is true", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({ hasDrift: true })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));
    expect(await screen.findByText(/Drift detected/i)).toBeInTheDocument();
    expect(screen.getByText(/disagree on shared fields/i)).toBeInTheDocument();
  });

  it("does not render the drift Callout when hasDrift is false", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({ hasDrift: false })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));
    // Drift label should be absent.
    expect(screen.queryByText(/Drift detected/i)).not.toBeInTheDocument();
  });
});

describe("EditApartmentDialog — partition billing mode (apartment-scoped field)", () => {
  it("flipping billing model NO_SUBSIDY → SUBSIDY ALSO calls updateApartmentShared(apartment.id, { partitionBillingMode: 'SUBSIDY' })", async () => {
    createUnitsBatchMock.mockReset();
    createUnitsBatchMock.mockResolvedValue({
      ids: [],
      updatedIds: ["u-master", "u-medium"],
    });
    updateApartmentSharedMock.mockReset();
    updateApartmentSharedMock.mockResolvedValue({ data: { id: "apt-test-edit" } });
    toastMock.success.mockReset();
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({
            listingMode: "PARTITIONED",
            partitionBillingMode: "NO_SUBSIDY",
          })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    // The Billing model Segmented control only renders for PARTITIONED.
    // Click the "Subsidy" radio to flip NO_SUBSIDY → SUBSIDY.
    const subsidyOption = await screen.findByRole("radio", { name: /^Subsidy$/i });
    await user.click(subsidyOption);

    // Submit → confirm.
    await user.click(screen.getByRole("button", { name: /save apartment/i }));
    await user.click(
      await screen.findByRole("button", { name: /update apartment/i }),
    );

    // New behaviour: the apartment-scoped endpoint persists the billing mode.
    expect(updateApartmentSharedMock).toHaveBeenCalledTimes(1);
    expect(updateApartmentSharedMock).toHaveBeenCalledWith("apt-test-edit", {
      partitionBillingMode: "SUBSIDY",
    });

    // Existing behaviour preserved: the batch fan-out still fires.
    expect(createUnitsBatchMock).toHaveBeenCalledTimes(1);
  });

  it("saves a monthly TNB owner subsidy cap through the apartment endpoint", async () => {
    createUnitsBatchMock.mockReset();
    createUnitsBatchMock.mockResolvedValue({
      ids: [],
      updatedIds: ["u-master", "u-medium"],
    });
    updateApartmentSharedMock.mockReset();
    updateApartmentSharedMock.mockResolvedValue({ data: { id: "apt-test-edit" } });
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({
            listingMode: "PARTITIONED",
            partitionBillingMode: "SUBSIDY",
            tnbSubsidyCapMonthly: null,
          })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    const capInput = screen.getByRole("spinbutton", {
      name: /monthly tnb owner subsidy cap/i,
    });
    await user.type(capInput, "200.00");
    await user.click(screen.getByRole("button", { name: /save apartment/i }));
    await user.click(
      await screen.findByRole("button", { name: /update apartment/i }),
    );

    expect(updateApartmentSharedMock).toHaveBeenCalledWith("apt-test-edit", {
      tnbSubsidyCapMonthly: 200,
    });
  });

  it("does NOT call updateApartmentShared when only a non-billing field (bedrooms) changed", async () => {
    createUnitsBatchMock.mockReset();
    createUnitsBatchMock.mockResolvedValue({
      ids: [],
      updatedIds: ["u-master", "u-medium"],
    });
    updateApartmentSharedMock.mockReset();
    toastMock.success.mockReset();
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({
            listingMode: "PARTITIONED",
            partitionBillingMode: "NO_SUBSIDY",
          })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    // Change bedrooms only; leave the billing model untouched.
    const bedroomsInput = (await screen.findByLabelText(
      "Bedrooms",
    )) as HTMLInputElement;
    await user.clear(bedroomsInput);
    await user.type(bedroomsInput, "4");

    await user.click(screen.getByRole("button", { name: /save apartment/i }));
    await user.click(
      await screen.findByRole("button", { name: /update apartment/i }),
    );

    expect(createUnitsBatchMock).toHaveBeenCalledTimes(1);
    expect(updateApartmentSharedMock).not.toHaveBeenCalled();
  });
});

describe("EditApartmentDialog — owner assignment", () => {
  beforeEach(() => {
    createUnitsBatchMock.mockReset();
    updateApartmentSharedMock.mockReset();
    apiFetchMock.mockReset();
    toastMock.success.mockReset();
    createUnitsBatchMock.mockResolvedValue({ ids: [], updatedIds: ["u-master", "u-medium"] });
    updateApartmentSharedMock.mockResolvedValue({ data: { id: "apt-test-edit" } });
    // Default apiFetch for any owner search — returns one owner named "Bob Lee".
    apiFetchMock.mockResolvedValue({
      data: [
        { id: "owner-bob", displayName: "Bob Lee", primaryPhone: "+60111222333", formattedPhone: "+60111222333" },
      ],
    });
  });

  it("CLEAR path — clicking 'Change owner' and confirming sends ownerPartyId: null", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({ ownerPartyId: "owner-alice", ownerName: "Alice Tan", ownerPhone: "+60199887766" })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    // The owner confirm card should show "Alice Tan" with a "Change owner" button.
    expect(await screen.findByText("Alice Tan")).toBeInTheDocument();

    // Click "Change owner" — clears the owner and shows the typeahead instead.
    await user.click(screen.getByRole("button", { name: /change owner/i }));

    // Alice's name should no longer appear as an owner card.
    expect(screen.queryByText("Alice Tan")).not.toBeInTheDocument();

    // Save → confirm.
    await user.click(screen.getByRole("button", { name: /save apartment/i }));
    await user.click(await screen.findByRole("button", { name: /update apartment/i }));

    // updateApartmentShared must have been called with ownerPartyId: null.
    expect(updateApartmentSharedMock).toHaveBeenCalledTimes(1);
    expect(updateApartmentSharedMock).toHaveBeenCalledWith(
      "apt-test-edit",
      expect.objectContaining({ ownerPartyId: null }),
    );
  });

  it("SET path — selecting an owner via typeahead and confirming sends ownerPartyId", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditApartmentDialog
          apartment={makeApartment({ ownerPartyId: null, ownerName: null, ownerPhone: null })}
          propertyId="p1"
          propertyName="The Sky Residences"
          trigger={<button>Open</button>}
        />,
      ),
    );
    await user.click(screen.getByText("Open"));

    // Type in the owner search input to trigger the typeahead.
    const searchInput = await screen.findByPlaceholderText(/search owners/i);
    await user.type(searchInput, "Bob");

    // Wait for the dropdown item to appear (apiFetch resolved to Bob Lee).
    const bobOption = await screen.findByText("Bob Lee");
    await user.click(bobOption);

    // Save → confirm.
    await user.click(screen.getByRole("button", { name: /save apartment/i }));
    await user.click(await screen.findByRole("button", { name: /update apartment/i }));

    // updateApartmentShared must have been called with the selected owner's id.
    expect(updateApartmentSharedMock).toHaveBeenCalledTimes(1);
    expect(updateApartmentSharedMock).toHaveBeenCalledWith(
      "apt-test-edit",
      expect.objectContaining({ ownerPartyId: "owner-bob" }),
    );
  });
});
