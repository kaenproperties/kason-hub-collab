import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminFormDrawer } from "../admin-form-drawer";

vi.mock("@/api/users", () => ({
  useCreateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // Added 2026-05-23 — the drawer now sets a Party.uplineId after the User
  // patch lands, so this mutation hook has to exist in the mock surface.
  useSetPartyUpline: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminFormDrawer open mode="create" user={null} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("AdminFormDrawer — password validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects password shorter than 6 characters", async () => {
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/^temporary password$/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));
    expect(await screen.findByText(/at least 6 characters/i)).toBeInTheDocument();
  });

  it("accepts a 6-character password", async () => {
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: "Test User" } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(/^temporary password$/i), { target: { value: "abcd12" } });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));
    expect(screen.queryByText(/at least 6 characters/i)).toBeNull();
  });
});
