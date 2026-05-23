import { bus, sessionTopic } from "./event-bus.js";
import type { TeamworkStore } from "./store.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";

export type KillSessionResult = {
  sessionId: string;
  status: "abandoned";
  stoppedCount: number;
  alreadyStoppedCount: number;
  agentCount: number;
  terminalReason: string;
};

/**
 * Owns dashboard-triggered destructive actions so the browser never needs the
 * parent actor token required by the MCP lifecycle tools.
 */
export function killSessionFromDashboard(
  store: TeamworkStore,
  workerSupervisor: WorkerSupervisor,
  sessionId: string,
): KillSessionResult {
  const resume = store.getSessionResumePacket({ sessionId });
  const actorToken = resume.parent.actorToken;
  const runtimes = store.listRuntimes({ sessionId }).runtimes;
  const managedRuntimes = runtimes.filter((runtime) => runtime.managedByServer);

  const stopped = workerSupervisor.stopSessionWorkers({ sessionId, actorToken }).stopped;
  const summary = store.killSessionFromDashboard({
    sessionId,
    reason: "Killed from dashboard",
  });
  const refreshedRuntimes = store.listRuntimes({ sessionId }).runtimes;
  const refreshedAgents = store.listAgents(sessionId).agents;
  const emittedAt = new Date().toISOString();

  for (const runtime of refreshedRuntimes) {
    bus.emit(sessionTopic(sessionId, "runtime"), {
      topic: "runtime",
      sessionId,
      agentId: runtime.agentId,
      runtime,
    });
  }

  for (const agent of refreshedAgents) {
    const state =
      agent.status === "active"
        ? "busy"
        : agent.status === "idle"
          ? "idle"
          : "stopped";
    bus.emit(sessionTopic(sessionId, "status"), {
      topic: "status",
      sessionId,
      agentId: agent.agentId,
      status: {
        state,
        summary: agent.statusNote,
        updatedAt: emittedAt,
      },
    });
  }

  bus.emit("dashboard:session-list", {
    topic: "dashboard:session-list",
    reason: "session-updated",
    sessionId,
  });

  return {
    sessionId,
    status: summary.status,
    stoppedCount: stopped.length,
    alreadyStoppedCount: Math.max(managedRuntimes.length - stopped.length, 0),
    agentCount: refreshedAgents.length,
    terminalReason: "Killed from dashboard",
  };
}
