import { MemoryRouter, useLocation } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAudit, getMetrics, getSessionDetail, listSessions } from "@/lib/api";
import { AppRoutes } from "@/routes";
import type { SessionDetail, SessionSummary } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  getMetrics: vi.fn().mockResolvedValue({
    sessionsPerDay: [],
    messagesPerDay: [],
    avgAssignmentDurationSec: 0,
    agentUtilization: [],
  }),
  getSessionDetail: vi.fn(),
  getAudit: vi.fn().mockResolvedValue({
    session: {
      id: "live-1",
      slug: "active-skill-work",
      parentCli: "codex",
      createdAt: "2026-06-01T12:00:00.000Z",
    },
    rollup: {
      workerCount: 1,
      messageCount: 0,
      directMessageCount: 0,
      broadcastMessageCount: 0,
      assignmentCount: 0,
      blockedAssignmentCount: 0,
      resultCount: 0,
      checkpointCount: 0,
      statusChangeCount: 0,
      blockedStatusCount: 0,
      runtimeCount: 0,
      activeRuntimeCount: 0,
      stoppedRuntimeCount: 0,
      crashedRuntimeCount: 0,
      totalRuntimeSeconds: 0,
      copilotAiCredits: 0,
      copilotCostUsd: 0,
      copilotInputTokens: 0,
      copilotOutputTokens: 0,
      copilotUsageRuntimeCount: 0,
      pairSpecialtyCount: 0,
      pairTrafficSpecialtyCount: 0,
    },
    usage: {
      copilot: {
        source: "copilot-otel-file",
        note: "",
        sourceCount: 0,
        totals: {
          aiCredits: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          turnCount: 0,
          spanCount: 0,
          chatSpanCount: 0,
        },
        runtimes: [],
      },
    },
    pairs: [],
    assignments: [],
    agents: [],
  }),
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

const liveSession: SessionSummary = {
  id: "live-1",
  slug: "active-skill-work",
  parentCli: "codex",
  createdAt: "2026-06-01T12:00:00.000Z",
  agentCount: 1,
  lastActivityAt: "2026-06-01T12:05:00.000Z",
  status: "active",
};

const pastSession: SessionSummary = {
  id: "past-1",
  slug: "finished-skill-work",
  parentCli: "codex",
  createdAt: "2026-06-01T10:00:00.000Z",
  agentCount: 1,
  lastActivityAt: "2026-06-01T10:30:00.000Z",
  status: "completed",
};

function detailFor(session: SessionSummary): SessionDetail {
  return {
    session: {
      id: session.id,
      slug: session.slug,
      parentCli: session.parentCli,
      workerPool: [],
      createdAt: session.createdAt,
      status: session.status,
    },
    agents: session.status === "active"
      ? [
          {
            agentId: "agent-1",
            sessionId: session.id,
            alias: "Atlas",
            specialty: "UI polish",
            cli: "codex",
            model: "gpt-5.4",
            createdAt: session.createdAt,
            status: { state: "busy", updatedAt: session.lastActivityAt ?? session.createdAt },
            role: "worker",
          },
        ]
      : [],
    assignments: [],
    workItems: [],
    phases: [],
    results: [],
    checkpoints: [],
    counts: { messages: 0, results: 0, agents: session.status === "active" ? 1 : 0 },
  };
}

describe("routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAudit).mockResolvedValue({
      session: {
        id: "live-1",
        slug: "active-skill-work",
        parentCli: "codex",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
      rollup: {
        workerCount: 1,
        messageCount: 0,
        directMessageCount: 0,
        broadcastMessageCount: 0,
        assignmentCount: 0,
        blockedAssignmentCount: 0,
        resultCount: 0,
        checkpointCount: 0,
        statusChangeCount: 0,
        blockedStatusCount: 0,
        runtimeCount: 0,
        activeRuntimeCount: 0,
        stoppedRuntimeCount: 0,
        crashedRuntimeCount: 0,
        totalRuntimeSeconds: 0,
        copilotAiCredits: 0,
        copilotCostUsd: 0,
        copilotInputTokens: 0,
        copilotOutputTokens: 0,
        copilotUsageRuntimeCount: 0,
        pairSpecialtyCount: 0,
        pairTrafficSpecialtyCount: 0,
      },
      usage: {
        copilot: {
          source: "copilot-otel-file",
          note: "",
          sourceCount: 0,
          totals: {
            aiCredits: 0,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            turnCount: 0,
            spanCount: 0,
            chatSpanCount: 0,
          },
          runtimes: [],
        },
      },
      pairs: [],
      assignments: [],
      agents: [],
    });
    vi.mocked(getMetrics).mockResolvedValue({
      sessionsPerDay: [],
      messagesPerDay: [],
      avgAssignmentDurationSec: 0,
      agentUtilization: [],
    });
    vi.mocked(getSessionDetail).mockImplementation((id) => {
      const session = [liveSession, pastSession].find((s) => s.id === id) ?? liveSession;
      return Promise.resolve(detailFor(session));
    });
    vi.mocked(listSessions).mockResolvedValue([]);
  });

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

  it("shows only current and past session lists on /sessions, without stats", async () => {
    vi.mocked(listSessions).mockResolvedValue([liveSession, pastSession]);

    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect((await screen.findAllByText("active-skill-work")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Recent sessions")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("finished-skill-work").length).toBeGreaterThan(0);

    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(getMetrics).not.toHaveBeenCalled();
    expect(screen.queryByText("Sessions per day")).not.toBeInTheDocument();
    expect(screen.queryByText("Messages per day")).not.toBeInTheDocument();
  });
});
