import type { TeamworkStore } from "./store.js";

// Adapts teamwork's domain model into the wire shapes the ported dashboard UI
// expects (mirrors agent-teams/dashboard-ui/src/lib/types.ts). The UI's union
// for status state is {idle,busy,stopped}; teamwork's richer set
// {active,idle,blocked,done,inactive} maps onto it for surface display, with
// the original passed through in `statusRaw` so consumers that care can show it.

const VALID_CLIS = new Set(["codex", "claude", "gemini", "opencode", "copilot"]);

function normalizeCli(cli: string | undefined): string {
  if (!cli) return "claude";
  return VALID_CLIS.has(cli) ? cli : "claude";
}

function mapStatus(state: string): "idle" | "busy" | "stopped" {
  switch (state) {
    case "active":
      return "busy";
    case "idle":
      return "idle";
    case "blocked":
    case "done":
    case "inactive":
    default:
      return "stopped";
  }
}

export class DashboardService {
  constructor(private readonly store: TeamworkStore) {}

  // ---------------------------- session list ----------------------------

  listSessions(opts: { sinceDays?: number; includeStopped?: boolean } = {}): Array<{
    id: string;
    slug: string;
    title: string;
    parentCli: string;
    createdAt: string;
    agentCount: number;
    lastActivityAt: string | null;
    status: string;
    lifecycleStage: string;
    currentPhase?: { phaseNumber: number; title: string; goal: string };
  }> {
    const filterOpts: Parameters<TeamworkStore["listSessionsForDashboard"]>[0] = {
      includeCompleted: opts.includeStopped ?? false,
      includeArchived: opts.includeStopped ?? false,
    };
    if (opts.sinceDays && opts.sinceDays > 0) {
      filterOpts.since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000).toISOString();
    }
    const rows = this.store.listSessionsForDashboard(filterOpts);
    return rows.map((row) => {
      const parent = row.activeAgents.find((a) => a.role === "parent");
      const parentRecord = parent ? this.store.tryGetAgent(parent.agentId) : undefined;
      return {
        id: row.sessionId,
        slug: row.taskSlug,
        title: row.title,
        parentCli: normalizeCli(parentRecord?.cli),
        createdAt: (row as { createdAt?: string }).createdAt ?? row.lastActivityAt,
        agentCount: row.activeAgents.length,
        lastActivityAt: row.lastActivityAt,
        status: row.status,
        lifecycleStage: row.lifecycleStage,
        currentPhase: row.currentPhase,
      };
    });
  }

  // ---------------------------- session detail ----------------------------

  hasSession(sessionId: string): boolean {
    try {
      this.store.getSessionSummary(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  getSessionDetail(sessionId: string): unknown {
    const rows = this.store.listSessionsForDashboard({
      includeCompleted: true,
      includeArchived: true,
      sessionId,
    });
    const row = rows[0];
    if (!row) throw new Error("session not found");

    const summary = this.store.getSessionSummary(sessionId);
    const audit = this.store.getAuditReport(sessionId);
    const latestRuntimeByAgent = new Map(
      this.store.listRuntimes({ sessionId }).runtimes.map((runtime) => [runtime.agentId, runtime])
    );

    const agents = audit.agents.map((rec) => {
      const window = rec.runtimeWindows[rec.runtimeWindows.length - 1];
      const latestRuntime = latestRuntimeByAgent.get(rec.agentId);
      return {
        agentId: rec.agentId,
        sessionId,
        alias: rec.alias,
        specialty: rec.specialty,
        responsibility: rec.responsibility,
        cli: normalizeCli(rec.cli),
        model: rec.model,
        role: rec.role,
        createdAt: rec.createdAt,
        statusRaw: rec.currentStatus,
        status: {
          state: mapStatus(rec.currentStatus),
          summary: rec.currentStatusNote,
          updatedAt: rec.lastSeenAt,
        },
        runtime: window
          ? {
              runtimeId: window.runtimeId,
              lifecycleState:
                window.status === "running"
                  ? "running"
                  : window.status === "crashed"
                  ? "crashed"
                  : "stopped",
              startedAt: window.startedAt,
              updatedAt: window.exitedAt ?? window.startedAt,
              exitedAt: window.exitedAt,
              exitCode: window.exitCode,
              stdinWritable: latestRuntime?.stdinWritable,
              resumeSupported: latestRuntime?.resumeSupported,
              inputDelivery: latestRuntime?.inputDelivery,
              lastOutputAt: latestRuntime?.lastOutputAt,
              runtimeCommand: undefined,
              worktreePath: undefined,
              sessionHandle: window.transport,
            }
          : undefined,
        heartbeat: undefined,
      };
    });

    const parentAgent = audit.agents.find((a) => a.role === "parent");
    const parentCli = normalizeCli(parentAgent?.cli);

    const assignments = row.workItems.map((wi) => ({
      id: wi.workItemId,
      sessionId,
      agentId: wi.primaryAssigneeAgentId ?? wi.ownerAgentId ?? "",
      phase: `phase-${wi.phaseNumber}`,
      phaseNumber: wi.phaseNumber,
      summary: wi.title,
      description: wi.description,
      ownerAlias: wi.ownerAlias,
      assigneeAliases: wi.assigneeAliases,
      activeClaims: wi.activeClaims,
      status: wi.status === "in-progress" ? "in_progress" : wi.status,
      createdAt: summary.createdAt ?? row.lastActivityAt,
      updatedAt: row.lastActivityAt,
    }));

    return {
      session: {
        id: sessionId,
        slug: summary.taskSlug,
        title: summary.title,
        parentCli,
        workerPool: agents
          .filter((a) => a.role === "worker")
          .map((a) => ({ cli: a.cli, model: a.model })),
        createdAt: summary.createdAt ?? row.lastActivityAt,
        status: summary.status,
        lifecycleStage: summary.lifecycleStage,
        terminalReason: row.terminalReason,
        currentPhase: row.currentPhase,
        currentFocus: row.currentFocus,
        openObligationCount: row.openObligationCount,
      },
      agents,
      assignments,
      results: [],
      checkpoints: [],
      phases: audit.timeline.phaseBoundaries ?? [],
      workItems: row.workItems,
      counts: {
        messages: audit.rollup.messageCount,
        results: audit.rollup.resultCount,
        agents: audit.rollup.agentCount,
      },
    };
  }

  // ---------------------------- messages ----------------------------

  listMessagesPage(input: {
    sessionId: string;
    sinceId?: string;
    beforeSequence?: number;
    limit?: number;
  }): {
    messages: Array<{
      id: string;
      sessionId: string;
      fromAgentId: string;
      toAgentId: string;
      deliveryMode: "direct" | "broadcast";
      summary?: string;
      body: string;
      createdAt: string;
      acknowledged: boolean;
      senderAlias: string;
      targetAliases: string[];
      kind: string;
      sequence: number;
      requiresResponse: boolean;
    }>;
    nextSinceId: string | null;
    hasMoreBefore: boolean;
  } {
    const limit = Math.min(Math.max(1, input.limit ?? 200), 1000);
    const sinceSeq = input.sinceId ? Number.parseInt(input.sinceId, 10) || 0 : 0;
    const beforeSequence = input.beforeSequence;
    const rows = this.store.listMessagesForDashboard({
      sessionId: input.sessionId,
      afterSequence: input.sinceId ? sinceSeq : undefined,
      beforeSequence,
      limit,
    });
    const aliasOf = (id: string | undefined) =>
      id ? this.store.tryGetAgent(id)?.alias ?? id.slice(0, 8) : "";
    const messages = rows.map((row) => ({
      id: row.messageId,
      sessionId: input.sessionId,
      fromAgentId: row.senderAgentId,
      toAgentId: row.targetAgentId ?? "",
      deliveryMode: (row.target === "broadcast" ? "broadcast" : "direct") as
        | "direct"
        | "broadcast",
      summary: undefined,
      body: row.body,
      createdAt: row.createdAt,
      // TODO: derive from message_obligations.status when the UI grows an
      // "acknowledged" indicator. Today no component reads this field; mapping
      // from row.requiresAck would be semantically wrong (that flag means
      // "needs ack", not "has been acked").
      acknowledged: false,
      senderAlias: row.senderAlias,
      targetAliases: row.targetAgentId ? [aliasOf(row.targetAgentId)] : [],
      kind: row.kind,
      sequence: row.sequence,
      requiresResponse: row.requiresResponse,
    }));
    const next =
      messages.length === limit ? String(messages[messages.length - 1]!.sequence) : null;
    const firstSequence = messages[0]?.sequence;
    return {
      messages,
      nextSinceId: next,
      hasMoreBefore: firstSequence !== undefined ? firstSequence > 1 : false,
    };
  }

  // ---------------------------- audit ----------------------------

  getAuditReport(sessionId: string): unknown {
    const audit = this.store.getAuditReport(sessionId);
    const summary = this.store.getSessionSummary(sessionId);
    const parentAgent = audit.agents.find((a) => a.role === "parent");
    const parentCli = normalizeCli(parentAgent?.cli);

    return {
      session: {
        id: sessionId,
        slug: summary.taskSlug,
        parentCli,
        createdAt: audit.session.createdAt,
      },
      rollup: {
        workerCount: audit.rollup.workerCount,
        messageCount: audit.rollup.messageCount,
        directMessageCount: audit.rollup.directMessageCount,
        broadcastMessageCount: audit.rollup.broadcastMessageCount,
        assignmentCount: audit.rollup.workItemCount,
        blockedAssignmentCount: 0,
        resultCount: audit.rollup.resultCount,
        checkpointCount: 0,
        statusChangeCount: audit.rollup.statusChangeCount,
        blockedStatusCount: audit.rollup.blockedStatusEventCount,
        runtimeCount: audit.rollup.runtimeCount,
        activeRuntimeCount: audit.rollup.activeRuntimeCount,
        stoppedRuntimeCount: audit.rollup.exitedRuntimeCount,
        crashedRuntimeCount: audit.rollup.crashedRuntimeCount,
        totalRuntimeSeconds: audit.rollup.totalRuntimeSeconds,
        pairSpecialtyCount: audit.rollup.pairSpecialtyCount,
        pairTrafficSpecialtyCount: audit.rollup.pairTrafficSpecialtyCount,
      },
      pairs: audit.pairs ?? [],
      assignments: [],
      agents: audit.agents.map((rec) => ({
        agentId: rec.agentId,
        alias: rec.alias,
        specialty: rec.specialty,
        responsibility: rec.responsibility,
        cli: normalizeCli(rec.cli),
        model: rec.model,
        statusState: mapStatus(rec.currentStatus),
        statusSummary: rec.currentStatusNote,
        createdAt: rec.createdAt,
        lastStatusAt: rec.lastSeenAt,
        lastHeartbeatAt: rec.lastSeenAt,
        sentCount: rec.messagesSentCount,
        receivedCount: rec.messagesReceivedCount,
        directSentCount: rec.directMessagesSentCount,
        broadcastSentCount: rec.broadcastsSentCount,
        directReceivedCount: 0,
        broadcastReceivedCount: 0,
        acknowledgedCount: 0,
        unacknowledgedCount: 0,
        assignmentCount: rec.workItemCount,
        blockedAssignmentCount: 0,
        doneAssignmentCount: 0,
        resultCount: rec.resultCount,
        statusChangeCount: rec.statusChangeCount,
        blockedStatusCount: rec.blockedCount,
        idleStatusCount: rec.idleCount,
        busyStatusCount: (rec as { activeCount?: number }).activeCount ?? 0,
        stoppedStatusCount: rec.doneCount,
        runtimeCount: rec.runtimeCount,
        activeRuntimeCount: rec.activeRuntimeCount,
        stoppedRuntimeCount: rec.exitedRuntimeCount,
        crashedRuntimeCount: rec.crashedRuntimeCount,
        totalRuntimeSeconds: rec.totalRuntimeSeconds,
        firstRuntimeStartedAt: rec.firstRuntimeStartedAt,
        lastRuntimeExitedAt: rec.lastRuntimeExitedAt,
      })),
    };
  }

  // ---------------------------- metrics ----------------------------

  getMetrics(opts: { sinceDays?: number } = {}): {
    sessionsPerDay: Array<{ date: string; count: number }>;
    messagesPerDay: Array<{ date: string; direct: number; broadcast: number }>;
    avgAssignmentDurationSec: number;
    agentUtilization: Array<{ agentId: string; alias: string; busyFraction: number }>;
  } {
    return this.store.getDashboardMetrics({ sinceDays: opts.sinceDays ?? 14 });
  }

  // ---------------------------- worker output ----------------------------

  getWorkerOutput(input: {
    sessionId: string;
    agentId: string;
    sinceId?: number;
    limit?: number;
  }): { chunks: Array<{ id: number; chunk: string; createdAt: string }>; nextSinceId: number | null } {
    const out = this.store.getWorkerOutput(input);
    return {
      chunks: out.chunks.map((c) => ({ id: c.id, chunk: c.chunk, createdAt: c.ts })),
      nextSinceId: out.nextSinceId,
    };
  }

  getAgentTerminalOutput(input: {
    sessionId: string;
    agentId: string;
    sinceId?: number;
    limit?: number;
  }): {
    chunks: Array<{ id: number; runtimeLogId: string; runtimeId: string; stream: string; chunk: string; createdAt: string }>;
    nextSinceId: number | null;
  } {
    const out = this.store.getAgentRuntimeOutput(input);
    return {
      chunks: out.chunks.map((c) => ({
        id: c.id,
        runtimeLogId: c.runtimeLogId,
        runtimeId: c.runtimeId,
        stream: c.stream,
        chunk: c.chunk,
        createdAt: c.ts,
      })),
      nextSinceId: out.nextSinceId,
    };
  }

  appendWorkerOutput(input: { sessionId: string; agentId: string; chunk: string }): {
    outputId: number;
    createdAt: string;
  } {
    return this.store.appendWorkerOutput(input);
  }
}
