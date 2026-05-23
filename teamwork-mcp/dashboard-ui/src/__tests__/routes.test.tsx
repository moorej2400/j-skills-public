import { MemoryRouter, useLocation } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "@/routes";

vi.mock("@/lib/api", () => ({
  getMetrics: vi.fn().mockResolvedValue({ sessionsPerDay: [], messagesPerDay: [] }),
  getSessionDetail: vi.fn(),
  isAbortError: vi.fn().mockReturnValue(false),
  listSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/sse", () => ({
  useDashboardStream: vi.fn(),
  useSseHealth: vi.fn().mockReturnValue("connected"),
}));

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output aria-label="current path">{location.pathname}</output>;
}

describe("routes", () => {
  it("opens the sessions list at /sessions without redirecting away from the sidebar target", () => {
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByLabelText("current path")).toHaveTextContent("/sessions");
  });
});
