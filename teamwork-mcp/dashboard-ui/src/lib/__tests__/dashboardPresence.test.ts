import { describe, expect, it } from "vitest";
import { countAgentsInLiveSessions, partitionSessions } from "@/lib/dashboardPresence";
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

const completedSession: SessionSummary = {
  ...session,
  id: "completed-session",
  status: "completed",
  lifecycleStage: "finalizing",
};

const worker: Agent = {
  agentId: "agent-1",
  sessionId: "session-1",
  alias: "Atlas",
  specialty: "UI polish",
  cli: "codex",
  model: "gpt-5.4",
  createdAt: "2026-05-05T12:00:00.000Z",
  status: { state: "busy", updatedAt: "2026-05-05T12:15:00.000Z" },
  role: "worker",
};

const idleWorker: Agent = {
  ...worker,
  agentId: "agent-2",
  alias: "Marlow",
  status: { state: "idle", updatedAt: "2026-05-05T12:14:00.000Z" },
};

describe("dashboardPresence", () => {
  it("does not keep terminal sessions live because their parent is active", () => {
    const activeParent: Agent = {
      ...worker,
      agentId: "parent-agent",
      sessionId: completedSession.id,
      alias: "parent",
      role: "parent",
      status: { state: "busy", updatedAt: "2026-05-05T12:20:00.000Z" },
    };

    const { activeSessions, recentSessions } = partitionSessions(
      [completedSession],
      { [completedSession.id]: [activeParent] },
    );

    expect(activeSessions).toHaveLength(0);
    expect(recentSessions).toEqual([completedSession]);
  });

  it("requires a live worker, not just a parent, for Live sessions", () => {
    const activeParentOnly: Agent = {
      ...worker,
      agentId: "parent-only",
      role: "parent",
      status: { state: "busy", updatedAt: "2026-05-05T12:20:00.000Z" },
    };

    const { activeSessions, recentSessions } = partitionSessions(
      [session],
      { [session.id]: [activeParentOnly] },
    );

    expect(activeSessions).toHaveLength(0);
    expect(recentSessions).toEqual([session]);
  });

  it("counts busy agents only within live sessions", () => {
    const staleBusyParent: Agent = {
      ...worker,
      agentId: "stale-parent",
      sessionId: completedSession.id,
      role: "parent",
      status: { state: "busy", updatedAt: "2026-05-05T12:20:00.000Z" },
    };
    const agentsBySession = {
      [session.id]: [worker, idleWorker],
      [completedSession.id]: [staleBusyParent],
    };

    const { activeSessions } = partitionSessions([session, completedSession], agentsBySession);
    const counts = countAgentsInLiveSessions(activeSessions, agentsBySession);

    expect(activeSessions).toEqual([session]);
    expect(counts).toEqual({ agentsBusy: 1, agentsTotal: 2 });
  });

  it("returns zero busy agents when there are no live sessions", () => {
    const staleBusyParent: Agent = {
      ...worker,
      agentId: "stale-parent",
      sessionId: completedSession.id,
      role: "parent",
      status: { state: "busy", updatedAt: "2026-05-05T12:20:00.000Z" },
    };
    const agentsBySession = {
      [completedSession.id]: [staleBusyParent],
    };

    const { activeSessions } = partitionSessions([completedSession], agentsBySession);
    const counts = countAgentsInLiveSessions(activeSessions, agentsBySession);

    expect(activeSessions).toHaveLength(0);
    expect(counts).toEqual({ agentsBusy: 0, agentsTotal: 0 });
  });
});
