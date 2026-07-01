import type { Agent, SessionSummary } from "@/lib/types";

// Active vs recent partition. Only active sessions with a live worker promote
// to Live; completed/abandoned/archived sessions always move to Recent even if
// their parent agent remains active in the store.
export function partitionSessions(
  sessions: SessionSummary[],
  agentsBySession: Record<string, Agent[]>,
): { activeSessions: SessionSummary[]; recentSessions: SessionSummary[] } {
  const active: SessionSummary[] = [];
  const recent: SessionSummary[] = [];
  for (const s of sessions) {
    if ((s.status ?? "active") !== "active") {
      recent.push(s);
      continue;
    }
    const agents = agentsBySession[s.id] ?? [];
    const hasLiveWorker = agents.some(
      (a) => a.role !== "parent" && a.status.state !== "stopped",
    );
    if (hasLiveWorker) {
      active.push(s);
    } else {
      recent.push(s);
    }
  }
  return { activeSessions: active, recentSessions: recent };
}

/** Count busy/total agents only within sessions classified as live. */
export function countAgentsInLiveSessions(
  activeSessions: SessionSummary[],
  agentsBySession: Record<string, Agent[]>,
): { agentsBusy: number; agentsTotal: number } {
  let busy = 0;
  let total = 0;
  for (const session of activeSessions) {
    const agents = agentsBySession[session.id] ?? [];
    total += agents.length;
    for (const agent of agents) {
      if (agent.status.state === "busy") busy += 1;
    }
  }
  return { agentsBusy: busy, agentsTotal: total };
}
