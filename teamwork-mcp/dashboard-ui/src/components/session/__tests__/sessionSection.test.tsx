import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSessionSection, parseSection, isSessionSection } from "@/lib/sessionSection";

afterEach(cleanup);

function Probe() {
  const { section, agentParam, setSection, setAgent, setSectionAndAgent } = useSessionSection();
  const location = useLocation();
  return (
    <div>
      <span data-testid="section">{section}</span>
      <span data-testid="agent">{agentParam ?? ""}</span>
      <span data-testid="search">{location.search}</span>
      <button onClick={() => setSection("kanban")}>kanban</button>
      <button onClick={() => setSection("overview")}>overview</button>
      <button onClick={() => setAgent("agent-1")}>set-agent</button>
      <button onClick={() => setAgent(null)}>clear-agent</button>
      <button onClick={() => setSectionAndAgent("terminal", "agent-2")}>jump</button>
    </div>
  );
}

describe("useSessionSection", () => {
  it("parses + falls back to default", () => {
    expect(isSessionSection("kanban")).toBe(true);
    expect(isSessionSection("nope")).toBe(false);
    expect(parseSection(undefined, "overview")).toBe("overview");
    expect(parseSection("terminal", "overview")).toBe("terminal");
  });

  it("reflects ?section and ?agent params", () => {
    render(
      <MemoryRouter initialEntries={["/sessions/x?section=terminal&agent=agent-7"]}>
        <Routes>
          <Route path="/sessions/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("section").textContent).toBe("terminal");
    expect(screen.getByTestId("agent").textContent).toBe("agent-7");
  });

  it("setSection writes the query param (and omits it for the default)", () => {
    render(
      <MemoryRouter initialEntries={["/sessions/x"]}>
        <Routes>
          <Route path="/sessions/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("section").textContent).toBe("overview");
    act(() => {
      screen.getByText("kanban").click();
    });
    expect(screen.getByTestId("search").textContent).toContain("section=kanban");

    act(() => {
      screen.getByText("overview").click();
    });
    expect(screen.getByTestId("search").textContent).not.toContain("section=");
  });

  it("setAgent toggles agent param", () => {
    render(
      <MemoryRouter initialEntries={["/sessions/x"]}>
        <Routes>
          <Route path="/sessions/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => {
      screen.getByText("set-agent").click();
    });
    expect(screen.getByTestId("search").textContent).toContain("agent=agent-1");
    act(() => {
      screen.getByText("clear-agent").click();
    });
    expect(screen.getByTestId("search").textContent).not.toContain("agent=");
  });

  it("setSectionAndAgent updates both at once", () => {
    render(
      <MemoryRouter initialEntries={["/sessions/x"]}>
        <Routes>
          <Route path="/sessions/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => {
      screen.getByText("jump").click();
    });
    const search = screen.getByTestId("search").textContent ?? "";
    expect(search).toContain("section=terminal");
    expect(search).toContain("agent=agent-2");
  });
});
