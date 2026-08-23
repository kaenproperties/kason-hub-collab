import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthContext, type AuthContextType } from "@/lib/auth";

// Mock react-router-dom to avoid ESM issues in test environment
const mockNavigate = vi.fn();
const routerState = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("react-router-dom", () => ({
  Navigate: (props: { to: string; replace?: boolean }) => {
    mockNavigate(props);
    return <div data-testid="navigate" data-to={props.to} />;
  },
  useLocation: () => ({ pathname: routerState.pathname }),
}));

// Import after mocks are set up
import { ProtectedRoute, requiredPermissionForPath } from "../protected-route";

describe("permission route mapping", () => {
  it("protects the main configurable workspaces with their exact capability", () => {
    expect(requiredPermissionForPath("/billing/tenant-owner-billing")).toBe("billing.view");
    expect(requiredPermissionForPath("/accounting/bank-reconciliation")).toBe("bank.read");
    expect(requiredPermissionForPath("/accounting/profitability")).toBe("profit.view");
    expect(requiredPermissionForPath("/organization/staff")).toBe("roles.manage");
    expect(requiredPermissionForPath("/inventory/units/unit-1")).toBe("portfolio.view");
  });
});

const baseAuth: AuthContextType = {
  user: null,
  setAuth: vi.fn(),
  clearAuth: vi.fn(),
  isAuthenticated: false,
};

function renderWithAuth(ui: React.ReactNode, authValue: AuthContextType) {
  return render(
    <AuthContext.Provider value={authValue}>{ui}</AuthContext.Provider>,
  );
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    routerState.pathname = "/dashboard";
  });

  it("renders children when authenticated as operator", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: { id: "1", fullName: "Test", email: "t@t.com", role: "admin", orgId: "o1", userType: "operator" },
      },
    );

    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });

  it("redirects to /login when not authenticated", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      baseAuth,
    );

    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    const nav = screen.getByTestId("navigate");
    expect(nav.getAttribute("data-to")).toBe("/login");
  });

  it("redirects tenant users to /portal/login", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: { id: "1", fullName: "Tenant", email: "t@t.com", role: "user", orgId: "o1", userType: "tenant" },
      },
    );

    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    const nav = screen.getByTestId("navigate");
    expect(nav.getAttribute("data-to")).toBe("/portal/login");
  });

  it("fails closed on a permission-bound route while permissions are missing", () => {
    routerState.pathname = "/accounting/bank-reconciliation";
    renderWithAuth(
      <ProtectedRoute><div>Bank Content</div></ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: { id: "1", fullName: "Test", email: "t@t.com", role: "manager", orgId: "o1", userType: "operator" },
      },
    );

    expect(screen.queryByText("Bank Content")).not.toBeInTheDocument();
    expect(screen.getByTestId("navigate").getAttribute("data-to")).toBe("/dashboard");
  });

  it("renders a permission-bound route only when the exact permission is present", () => {
    routerState.pathname = "/accounting/bank-reconciliation";
    renderWithAuth(
      <ProtectedRoute><div>Bank Content</div></ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: {
          id: "1",
          fullName: "Test",
          email: "t@t.com",
          role: "editor",
          orgId: "o1",
          userType: "operator",
          permissions: ["bank.read"],
        },
      },
    );

    expect(screen.getByText("Bank Content")).toBeInTheDocument();
  });
});
