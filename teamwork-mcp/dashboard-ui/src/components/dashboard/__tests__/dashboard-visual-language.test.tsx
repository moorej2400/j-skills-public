import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricsBar } from "@/components/dashboard/MetricsBar";
import { SessionCard } from "@/components/dashboard/SessionCard";
import type { Agent, SessionSummary } from "@/lib/types";

const session: SessionSummary = {
  id: "session-1",
  slug: "teamwork-live-session",
  parentCli: "codex",
  createdAt: "2026-05-05T12:00:00.000Z",
  agentCount: 2,
  lastActivityAt: "2026-05-05T12:16:00.000Z",
  status: "active",
  lifecycleStage: "executing",
  currentPhase: { phaseNumber: 2, title: "Implement", goal: "Ship dashboard polish" },
};

const agents: Agent[] = [
  {
    agentId: "agent-1",
    sessionId: "session-1",
    alias: "Atlas",
    specialty: "UI polish",
    cli: "codex",
    model: "gpt-5.4",
    createdAt: "2026-05-05T12:00:00.000Z",
    status: { state: "busy", updatedAt: "2026-05-05T12:15:00.000Z" },
    role: "worker",
  },
  {
    agentId: "agent-2",
    sessionId: "session-1",
    alias: "Marlow",
    specialty: "Validation",
    cli: "claude",
    model: "claude-sonnet-4.6",
    createdAt: "2026-05-05T12:02:00.000Z",
    status: { state: "idle", updatedAt: "2026-05-05T12:14:00.000Z" },
    role: "worker",
  },
];

describe("dashboard visual language", () => {
  it("gives live session cards distinct operations copy", () => {
    render(
      <MemoryRouter>
        <SessionCard
          session={session}
          agents={agents}
          recentMessageTimestamps={[
            "2026-05-05T12:10:00.000Z",
            "2026-05-05T12:12:00.000Z",
            "2026-05-05T12:15:00.000Z",
          ]}
          lastActivityAt="2026-05-05T12:16:00.000Z"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/agents active/i)).toBeInTheDocument();
    expect(screen.getByText(/last activity/i)).toBeInTheDocument();
    expect(screen.getByText(/currently busy/i)).toBeInTheDocument();
  });

  it("bumps dashboard microcopy without changing the KPI scale", () => {
    const { container } = render(
      <MetricsBar activeSessionCount={4} agentsBusy={7} agentsTotal={11} loading={false} />,
    );

    expect(screen.getByText("Active sessions")).toHaveClass("text-xs");
    expect(screen.getByText(/sessions? live/i)).toHaveClass("text-sm");
    expect(screen.getByText(/of 11 in live sessions/i)).toBeInTheDocument();
    expect(container.querySelector(".text-3xl")).not.toBeNull();
  });
});
