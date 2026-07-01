import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import { ensureDashboardUiBuilt } from "./dashboard-assets.js";
import { handleDashboardRequest, shutdownAllSseStreams } from "./dashboard-http.js";
import { bus, sessionTopic } from "./event-bus.js";
import { TeamworkStore } from "./store.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { getWorktreeDiffStat, getWorktreeHead, isWorktreeDirty } from "./worktrees.js";

const dataDir = process.env.TEAMWORK_DATA_DIR
  ? path.resolve(process.env.TEAMWORK_DATA_DIR)
  : path.join(os.homedir(), ".teamwork");
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.TEAMWORK_DB_PATH
  ? path.resolve(process.env.TEAMWORK_DB_PATH)
  : path.join(dataDir, "teamwork.sqlite");
const uiPort = Number.parseInt(process.env.TEAMWORK_UI_PORT ?? "48741", 10);
const uiHost = process.env.TEAMWORK_UI_HOST ?? "127.0.0.1";
const transportMode = process.env.TEAMWORK_TRANSPORT ?? "http";
const janitorIntervalMs = Number.parseInt(process.env.TEAMWORK_JANITOR_INTERVAL_MS ?? `${15 * 60 * 1000}`, 10);
const janitorTtlHours = Number.parseFloat(process.env.TEAMWORK_SESSION_TTL_HOURS ?? "24");
const worktreeGcEnabled = process.env.TEAMWORK_WORKTREE_GC !== "0";

const store = new TeamworkStore({ dbPath });
const workerSupervisor = new WorkerSupervisor(store, { fakeCliPath: process.env.TEAMWORK_FAKE_CLI_PATH });
const mcp = new McpServer({
  name: "teamwork-mcp",
  version: "0.1.0",
});

registerToolsOn(mcp);

// Map of active HTTP transport sessions so multiple clients share one server process.
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  ensureDashboardUiBuilt();
  if (transportMode === "stdio") {
    const httpServer = createHttpServer();
    await startHttpServer(httpServer);
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    process.stderr.write(`teamwork-mcp ready (stdio)\n`);
    process.stderr.write(`dashboard http://${uiHost}:${uiPort}\n`);
    maybeOpenBrowser(`http://${uiHost}:${uiPort}/`);
  } else {
    const httpServer = createHttpServer();
    await startHttpServer(httpServer);
    startJanitor();
    process.stderr.write(`teamwork-mcp ready (http)\n`);
    process.stderr.write(`mcp endpoint http://${uiHost}:${uiPort}/mcp\n`);
    process.stderr.write(`dashboard http://${uiHost}:${uiPort}\n`);
    maybeOpenBrowser(`http://${uiHost}:${uiPort}/`);
  }
}

function legacyDashboardFilters(url: URL) {
  return {
    projectRoot: url.searchParams.get("project") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    includeCompleted: url.searchParams.get("include")?.split(",").includes("completed") ?? true,
    includeArchived: url.searchParams.get("include")?.split(",").includes("archived") ?? false,
  };
}

function maybeOpenBrowser(url: string): void {
  // Default off in stdio mode — every MCP client attach would otherwise spawn
  // a tab. Opt-in with TEAMWORK_OPEN_BROWSER=1. In http mode we default on
  // unless TEAMWORK_OPEN_BROWSER=0 explicitly suppresses it.
  const flag = process.env.TEAMWORK_OPEN_BROWSER;
  if (flag === "0") return;
  if (transportMode === "stdio" && flag !== "1") return;
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
        child.on("error", (err) => {
          process.stderr.write(`teamwork-mcp: could not auto-open browser: ${err.message}\n`);
        });
        child.unref();
      })
      .catch((err: Error) => {
        process.stderr.write(`teamwork-mcp: browser open failed: ${err.message}\n`);
      });
  } catch (err) {
    process.stderr.write(`teamwork-mcp: browser open threw: ${(err as Error).message}\n`);
  }
}

/** Start the dashboard HTTP server. In stdio mode, gracefully skip if port is taken. In http mode, retry and reclaim. */
async function startHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  const maxAttempts = transportMode === "stdio" ? 1 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(uiPort, uiHost, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        if (transportMode === "stdio") {
          process.stderr.write(
            `dashboard port ${uiPort} already in use, another instance owns it — skipping dashboard\n`
          );
          return;
        }
        if (attempt < maxAttempts) {
          process.stderr.write(
            `port ${uiPort} in use (attempt ${attempt}/${maxAttempts}), retrying...\n`
          );
          try {
            const { execSync } = await import("node:child_process");
            const out = execSync(
              `netstat -ano | findstr "LISTENING" | findstr ":${uiPort}"`,
              { encoding: "utf-8" }
            ).trim();
            const pid = out.split(/\s+/).pop();
            if (pid && /^\d+$/.test(pid)) {
              process.stderr.write(`killing stale PID ${pid}\n`);
              execSync(`taskkill /F /PID ${pid}`, { encoding: "utf-8" });
            }
          } catch {
            // netstat/taskkill may fail — just retry after a short delay
          }
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }
      process.stderr.write(
        `server failed to start on :${uiPort} (${code ?? err}), MCP will continue without UI\n`
      );
      return;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`teamwork-mcp error: ${String(error)}\n`);
  process.exit(1);
});

let shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`teamwork-mcp: ${signal} received, draining SSE streams\n`);
  try { shutdownAllSseStreams(); } catch { /* ignore */ }
  // Give in-flight responses a brief moment to flush before exit.
  setTimeout(() => process.exit(0), 100).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

function registerToolsOn(server: McpServer) {
  const operations = new Map<string, {
    name: string;
    config: any;
    handler: (input: any) => Promise<ReturnType<typeof jsonResult>> | ReturnType<typeof jsonResult>;
  }>();

  const registerTool = (
    name: string,
    config: any,
    handler: (input: any) => Promise<ReturnType<typeof jsonResult>> | ReturnType<typeof jsonResult>
  ) => {
    // MCP advertises only `teamwork`; keeping operations separate here preserves per-operation validation and debug names.
    const operation = { name, config, handler };
    operations.set(name, operation);
    operations.set(operationName(name), operation);
  };

  registerTool(
    "tw_run_janitor",
    {
      description: "Run the teamwork cleanup janitor immediately. Intended for tests and operator recovery.",
      inputSchema: {
        ttlHours: z.number().nonnegative().optional(),
        worktreeGc: z.boolean().optional(),
      },
    },
    async (input) => jsonResult(store.runJanitor(input))
  );

  registerTool(
    "tw_list_debug_events",
    {
      description: "List detailed MCP debug events, including redacted tool calls and agent-visible payloads.",
      inputSchema: {
        sessionId: z.string().uuid().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (input) => jsonResult(store.listDebugEvents(input))
  );

  registerTool(
    "tw_get_dashboard_url",
    {
      description: "Get the local dashboard URL for the teamwork MCP server.",
    },
    async () => jsonResult({ url: `http://${uiHost}:${uiPort}` })
  );

  registerTool(
    "tw_create_session",
    {
      description: "Create a new teamwork session.",
      inputSchema: {
        parentAlias: z.string().min(1),
        title: z.string().min(1),
        taskSlug: z.string().min(1),
        projectRoot: z.string().min(1),
        sessionWorkspacePath: z.string().min(1).optional(),
        taskPrompt: z.string().min(1),
      },
    },
    async ({ parentAlias, title, taskSlug, projectRoot, sessionWorkspacePath, taskPrompt }) => {
      const out = store.createSession({ parentAlias, title, taskSlug, projectRoot, sessionWorkspacePath, taskPrompt });
      try {
        bus.emit("dashboard:session-list", {
          topic: "dashboard:session-list",
          reason: "session-created",
          sessionId: out.sessionId,
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_register_agent",
    {
      description: "Register the parent or a worker for a teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        alias: z.string().min(1),
        specialty: z.string().min(1),
        responsibility: z.string().min(1).optional(),
        cli: z.string().min(1),
        model: z.string().min(1),
        role: z.enum(["parent", "worker"]),
      },
    },
    async ({ sessionId, alias, specialty, responsibility, cli, model, role }) => {
      const out = store.registerAgent({ sessionId, alias, specialty, responsibility, cli, model, role });
      try {
        bus.emit(sessionTopic(sessionId, "agent"), {
          topic: "agent",
          sessionId,
          agent: out,
        });
        bus.emit("dashboard:session-list", {
          topic: "dashboard:session-list",
          reason: "agent-registered",
          sessionId,
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_get_session_state",
    {
      description: "Get the current teamwork session summary.",
      inputSchema: {
        sessionId: z.string().uuid(),
      },
    },
    async ({ sessionId }) => jsonResult(store.getSessionSummary(sessionId))
  );

  registerTool(
    "tw_get_session_resume_packet",
    {
      description: "Recovery helper for resumed or compacted parent sessions. Returns parent token, current aliases, runtimes, work items, and unread state for one teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        parentAlias: z.string().min(1).optional(),
      },
    },
    async (input) => jsonResult(store.getSessionResumePacket(input))
  );

  registerTool(
    "tw_list_agents",
    {
      description: "List the current teamwork roster, including parent-defined specialties and responsibilities.",
      inputSchema: {
        sessionId: z.string().uuid(),
      },
    },
    async ({ sessionId }) => jsonResult(store.listAgents(sessionId))
  );

  registerTool(
    "tw_parent_poll_baseline",
    {
      description: "Parent-only low-token monitor. Use this for frequent supervision ticks; call parent_poll only when this baseline shows unread messages, blockers, stale/crashed workers, or phase readiness.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        afterSequence: z.number().int().min(0).optional(),
      },
    },
    async (input) => jsonResult(store.parentPollBaseline(input))
  );

  registerTool(
    "tw_parent_poll",
    {
      description: "Parent-only extended monitor. Use parent_poll_baseline for routine frequent ticks; use this for drill-down when baseline shows unread messages, blockers, stale/crashed workers, or phase readiness.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        afterSequence: z.number().int().min(0).optional(),
        includeWorkerOutputTails: z.object({
          runtimeIds: z.array(z.string().uuid()).optional(),
          maxLines: z.number().int().positive().max(10).optional(),
          maxChars: z.number().int().positive().max(2000).optional(),
          streams: z.array(z.enum(["stdout", "stderr", "stdin", "system", "runtime"])).optional(),
        }).optional(),
      },
    },
    async (input) => jsonResult(store.parentPoll(input))
  );

  registerTool(
    "tw_get_audit_report",
    {
      description: "Get an audit report for a teamwork session, including traffic and worker lifecycle metrics.",
      inputSchema: {
        sessionId: z.string().uuid(),
      },
    },
    async ({ sessionId }) => jsonResult(store.getAuditReport(sessionId))
  );

  registerTool(
    "tw_get_diagnostic_report",
    {
      description: "Get a session diagnostic report with runtime observability, fallback handoffs, errors, and closeout blockers.",
      inputSchema: {
        sessionId: z.string().uuid(),
      },
    },
    async ({ sessionId }) => jsonResult(store.getDiagnosticReport(sessionId))
  );

  registerTool(
    "tw_get_closeout_checklist",
    {
      description: "Parent-only closeout checklist showing phase/final blockers and the exact operation order before complete_phase or complete_session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive().optional(),
        stage: z.enum(["phase", "final"]).optional(),
      },
    },
    async (input) => jsonResult(store.getCloseoutChecklist(input))
  );

  registerTool(
    "tw_start_phase",
    {
      description: "Parent-only tool to start or update a teamwork phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        title: z.string().min(1),
        goal: z.string().min(1),
      },
    },
    async ({ sessionId, actorToken, phaseNumber, title, goal }) => {
      store.startPhase({ sessionId, actorToken, phaseNumber, title, goal });
      return jsonResult(store.getSessionSummary(sessionId));
    }
  );

  registerTool(
    "tw_begin_integration",
    {
      description: "Parent-only tool to move the current phase from execution into integration after work items are done.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
      },
    },
    async (input) => jsonResult(store.beginIntegration(input))
  );

  registerTool(
    "tw_complete_phase",
    {
      description: "Parent-only tool to mark a teamwork phase complete.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        summary: z.string().min(1),
      },
    },
    async ({ sessionId, actorToken, phaseNumber, summary }) => {
      store.completePhase({ sessionId, actorToken, phaseNumber, summary });
      return jsonResult(store.getSessionSummary(sessionId));
    }
  );

  registerTool(
    "tw_upsert_work_item",
    {
      description: "Parent-only tool to create or update a work item.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid().optional(),
        phaseNumber: z.number().int().positive(),
        title: z.string().min(1),
        description: z.string().min(1),
        acceptanceCriteria: z.string().min(1).optional(),
        ownerAgentId: z.string().uuid().optional(),
        assigneeAgentIds: z.array(z.string().uuid()).optional(),
        primaryAssigneeAgentId: z.string().uuid().optional(),
        status: z.enum(["planned", "assigned", "in-progress", "blocked", "done", "canceled"]).optional(),
        dependsOnIds: z.array(z.string().uuid()).optional(),
      },
    },
    async (input) => {
      const out = store.upsertWorkItem(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "assignment"), {
          topic: "assignment",
          sessionId: input.sessionId,
          assignment: out,
          reason: "created",
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_list_work_items",
    {
      description: "List work items for a teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        phaseNumber: z.number().int().positive().optional(),
      },
    },
    async ({ sessionId, phaseNumber }) => jsonResult(store.listWorkItems({ sessionId, phaseNumber }))
  );

  registerTool(
    "tw_update_work_item_status",
    {
      description: "Update a work item status. Workers may update only assigned work items.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid(),
        status: z.enum(["planned", "assigned", "in-progress", "blocked", "done", "canceled"]),
        note: z.string().optional(),
      },
    },
    async (input) => {
      const out = store.updateWorkItemStatus(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "assignment"), {
          topic: "assignment",
          sessionId: input.sessionId,
          assignment: out,
          reason: "status-changed",
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_claim_work_item",
    {
      description: "Worker-only tool to explicitly claim one assigned work item as the worker's current focus.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid(),
        note: z.string().optional(),
      },
    },
    async (input) => {
      const out = store.claimWorkItem(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "assignment"), {
          topic: "assignment",
          sessionId: input.sessionId,
          assignment: out,
          reason: "claimed",
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_reassign_work_item",
    {
      description: "Parent-only tool to reassign a work item after a blocker or replacement.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid(),
        assigneeAgentIds: z.array(z.string().uuid()).min(1),
        primaryAssigneeAgentId: z.string().uuid().optional(),
        reason: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.reassignWorkItem(input))
  );

  registerTool(
    "tw_send_message",
    {
      description: "Send a broadcast or direct message in a teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        target: z.enum(["broadcast", "agent"]),
        targetAgentId: z.string().uuid().optional(),
        kind: z.enum(["status", "question", "answer", "handoff", "system"]),
        body: z.string().min(1),
        relatedWorkItemId: z.string().uuid().optional(),
        replyToMessageId: z.string().uuid().optional(),
        requiresResponse: z.boolean().optional(),
        requiresAck: z.boolean().optional(),
        obligationKind: z.string().min(1).optional(),
        dueStage: z.enum(["phase", "final"]).optional(),
      },
    },
    async (input) => {
      const out = store.sendMessage(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "message"), {
          topic: "message",
          kind: "sent",
          sessionId: input.sessionId,
          messageId: out.messageId,
          fromAgentId: out.senderAgentId,
          toAgentIds: out.targetAgentIds,
          deliveryMode: input.target === "agent" ? "direct" : "broadcast",
          createdAt: out.createdAt,
        });
        bus.emit("dashboard:session-list", {
          topic: "dashboard:session-list",
          reason: "session-updated",
          sessionId: input.sessionId,
        });
      } catch {
        /* emit best-effort */
      }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_list_messages",
    {
      description: "Drill-down only: list teamwork messages visible to the current agent since a sequence number. Parent routine monitoring should use parent_poll_baseline.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        afterSequence: z.number().int().min(0).default(0),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ sessionId, actorToken, afterSequence, limit }) =>
      jsonResult(store.listMessagesSince({ sessionId, actorToken, afterSequence, limit }))
  );

  registerTool(
    "tw_wait_for_messages",
    {
      description: "Bounded long-poll for messages visible to the current agent since a sequence number.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        afterSequence: z.number().int().min(0).default(0),
        waitMs: z.number().int().min(0).max(120_000).optional(),
        timeout: z.number().int().min(0).max(120_000).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
        timeoutSeconds: z.number().int().min(0).max(120).optional(),
        waitSeconds: z.number().int().min(0).max(120).optional(),
      },
    },
    async ({ sessionId, actorToken, afterSequence, waitMs, timeout, timeoutMs, timeoutSeconds, waitSeconds }) => {
      const effectiveWaitMs = waitMs
        ?? timeoutMs
        ?? timeout
        ?? (timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000)
        ?? (waitSeconds === undefined ? undefined : waitSeconds * 1000)
        ?? 30_000;
      const deadline = Date.now() + effectiveWaitMs;
      let result = store.listMessagesSince({ sessionId, actorToken, afterSequence });
      while (result.messages.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
        result = store.listMessagesSince({ sessionId, actorToken, afterSequence });
      }
      return jsonResult({ ...result, timedOut: result.messages.length === 0 });
    }
  );

  registerTool(
    "tw_resolve_obligation",
    {
      description: "Parent-only tool to resolve a stale or superseded required-message obligation.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        messageId: z.string().uuid(),
        reason: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.resolveObligation(input))
  );

  registerTool(
    "tw_ack_messages",
    {
      description: "Acknowledge teamwork messages up to a sequence number.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        upToSequence: z.number().int().min(0).optional(),
        messageIds: z.array(z.string().uuid()).optional(),
      },
    },
    async ({ sessionId, actorToken, upToSequence, messageIds }) => {
      store.acknowledgeMessages({ sessionId, actorToken, upToSequence, messageIds });
      return jsonResult({ ok: true });
    }
  );

  registerTool(
    "tw_closeout_ack_workers",
    {
      description: "Parent-only closeout helper to advance boundary ack cursors for idle, done, inactive, or resumable-exited workers without using private worker tokens.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        stage: z.enum(["phase", "final"]).optional(),
        upToSequence: z.number().int().min(0).optional(),
      },
    },
    async (input) => jsonResult(store.closeoutAckWorkers(input))
  );

  registerTool(
    "tw_set_agent_status",
    {
      description: "Update your own status, or parent-update another agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        status: z.enum(["active", "idle", "blocked", "done", "inactive"]),
        note: z.string().optional(),
        targetAgentId: z.string().uuid().optional(),
      },
    },
    async ({ sessionId, actorToken, status, note, targetAgentId }) => {
      store.setAgentStatus({ sessionId, actorToken, status, note, targetAgentId });
      try {
        const agentId = targetAgentId ?? store.tryGetAgentByToken(actorToken)?.agentId ?? "";
        if (agentId) {
          const stateUi = status === "active" ? "busy" : status === "idle" ? "idle" : "stopped";
          bus.emit(sessionTopic(sessionId, "status"), {
            topic: "status",
            sessionId,
            agentId,
            status: { state: stateUi, summary: note, updatedAt: new Date().toISOString() },
          });
          bus.emit("dashboard:session-list", {
            topic: "dashboard:session-list",
            reason: "session-updated",
            sessionId,
          });
        }
      } catch { /* best-effort */ }
      return jsonResult({ ok: true });
    }
  );

  registerTool(
    "tw_register_worktree",
    {
      description: "Register a git worktree for a session agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        agentId: z.string().uuid(),
        path: z.string().min(1),
        branch: z.string().min(1),
        baseCommit: z.string().min(1).optional(),
        status: z.enum(["creating", "ready", "dirty", "merged", "failed", "removed", "cleanup-needed"]).optional(),
      },
    },
    async (input) => jsonResult(store.registerWorktree(input))
  );

  registerTool(
    "tw_update_worktree",
    {
      description: "Update tracked worktree status or branch metadata. Status 'removed' is accepted only after the filesystem path is gone; use cleanup_worktree for server-side cleanup.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        worktreeId: z.string().uuid(),
        status: z.enum(["creating", "ready", "dirty", "merged", "failed", "removed", "cleanup-needed"]).optional(),
        branch: z.string().min(1).optional(),
        baseCommit: z.string().min(1).optional(),
      },
    },
    async (input) => jsonResult(store.updateWorktree(input))
  );

  registerTool(
    "tw_cleanup_worktree",
    {
      description: "Parent-only helper to remove a tracked teamwork worktree from disk and mark it removed only after filesystem deletion succeeds.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        worktreeId: z.string().uuid(),
      },
    },
    async (input) => jsonResult(store.cleanupWorktree(input))
  );

  registerTool(
    "tw_list_worktrees",
    {
      description: "List tracked worktrees for a session or one agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        agentId: z.string().uuid().optional(),
      },
    },
    async (input) => jsonResult(store.listWorktrees(input))
  );

  registerTool(
    "tw_register_runtime",
    {
      description: "Register a running worker runtime for a session agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        agentId: z.string().uuid(),
        pid: z.number().int().positive().optional(),
        transport: z.string().min(1),
        adapter: z.string().min(1).optional(),
        launchMode: z.string().min(1).optional(),
        cliSessionId: z.string().min(1).optional(),
        command: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        managedByServer: z.boolean().optional(),
        stdinWritable: z.boolean().optional(),
        resumeSupported: z.boolean().optional(),
        sessionExportPath: z.string().min(1).optional(),
        otelFilePath: z.string().min(1).optional(),
        heartbeatIntervalSeconds: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const out = store.registerRuntime(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "runtime"), {
          topic: "runtime",
          sessionId: input.sessionId,
          agentId: input.agentId,
          runtime: out,
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_update_runtime",
    {
      description: "Update a runtime status, pid, or exit code.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
        status: z.enum(["running", "exited", "crashed"]).optional(),
        pid: z.number().int().positive().optional(),
        exitCode: z.number().int().optional(),
      },
    },
    async (input) => {
      const out = store.updateRuntime(input);
      try {
        const r = out as { agentId?: string };
        if (r.agentId) {
          bus.emit(sessionTopic(input.sessionId, "runtime"), {
            topic: "runtime",
            sessionId: input.sessionId,
            agentId: r.agentId,
            runtime: out,
          });
        }
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_heartbeat_runtime",
    {
      description: "Heartbeat a running worker runtime so the parent and dashboard can see recent activity.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
      },
    },
    async (input) => {
      const out = store.heartbeatRuntime(input);
      try {
        const agent = store.tryGetAgentByToken(input.actorToken);
        if (agent) {
          bus.emit(sessionTopic(input.sessionId, "heartbeat"), {
            topic: "heartbeat",
            sessionId: input.sessionId,
            agentId: agent.agentId,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_append_output",
    {
      description: "Append a chunk of stdout/stderr so the dashboard terminal panel can replay it. The caller appends only their own output: pass YOUR private actorToken and YOUR own agentId. Cross-agent appends are rejected. Chunks are capped at 64 KiB (UTF-8 boundary) and empty chunks are rejected.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        agentId: z.string().uuid(),
        chunk: z.string().min(1),
      },
    },
    async ({ sessionId, actorToken, agentId, chunk }) => {
      const actor = store.tryGetAgentByToken(actorToken);
      if (!actor || actor.sessionId !== sessionId) {
        return jsonResult({ ok: false, error: "invalid actorToken or session mismatch" });
      }
      // Cross-agent appends are forbidden — every agent owns its own output stream.
      if (actor.agentId !== agentId) {
        return jsonResult({ ok: false, error: "agentId must match actorToken's agent" });
      }
      const out = store.appendWorkerOutput({ sessionId, agentId, chunk });
      try {
        bus.emit(sessionTopic(sessionId, "output"), {
          topic: "output",
          kind: "worker-output",
          sessionId,
          agentId,
          outputId: out.outputId,
          chunk,
          createdAt: out.createdAt,
        });
      } catch { /* best-effort */ }
      return jsonResult({ ok: true, outputId: out.outputId, createdAt: out.createdAt });
    }
  );

  registerTool(
    "tw_list_runtimes",
    {
      description: "List tracked runtimes for a session or one agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        agentId: z.string().uuid().optional(),
      },
    },
    async (input) => jsonResult(store.listRuntimes(input))
  );

  registerTool(
    "tw_record_result",
    {
      description: "Record a work result for a work item.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid(),
        resultType: z.enum(["commit", "artifact", "test-report", "note"]),
        summary: z.string().min(1),
        data: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        commitSha: z.string().min(1).optional(),
        commitShas: z.array(z.string().min(1)).optional(),
        verificationSummary: z.string().min(1).optional(),
      },
    },
    async (input) => {
      const out = store.recordResult(input);
      try {
        bus.emit(sessionTopic(input.sessionId, "result"), {
          topic: "result",
          sessionId: input.sessionId,
          result: out,
        });
        bus.emit("dashboard:session-list", {
          topic: "dashboard:session-list",
          reason: "session-updated",
          sessionId: input.sessionId,
        });
      } catch { /* best-effort */ }
      return jsonResult(out);
    }
  );

  registerTool(
    "tw_list_results",
    {
      description: "Drill-down only: list recorded results for a session or one work item. Parent routine monitoring should use parent_poll_baseline.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workItemId: z.string().uuid().optional(),
      },
    },
    async (input) => jsonResult(store.listResults(input))
  );

  registerTool(
    "tw_record_integration_event",
    {
      description: "Record a parent-led integration event for the current phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        kind: z.enum(["merge", "cherry-pick", "conflict", "resolved", "reverted"]),
        sourceBranch: z.string().optional(),
        targetBranch: z.string().optional(),
        commitSha: z.string().optional(),
        details: z.string().optional(),
      },
    },
    async (input) => jsonResult(store.recordIntegrationEvent(input))
  );

  registerTool(
    "tw_list_integration_events",
    {
      description: "List recorded integration events for a session or one phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        phaseNumber: z.number().int().positive().optional(),
      },
    },
    async (input) => jsonResult(store.listIntegrationEvents(input))
  );

  registerTool(
    "tw_create_checkpoint",
    {
      description: "Create a parent-owned checkpoint snapshot for a phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        kind: z.enum(["phase-start", "phase-end", "manual"]),
        label: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.createCheckpoint(input))
  );

  registerTool(
    "tw_list_checkpoints",
    {
      description: "List stored checkpoints for a session or one phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        phaseNumber: z.number().int().positive().optional(),
      },
    },
    async (input) => jsonResult(store.listCheckpoints(input))
  );

  registerTool(
    "tw_inspect_worktree",
    {
      description: "Inspect git state for a tracked worktree.",
      inputSchema: {
        sessionId: z.string().uuid(),
        worktreeId: z.string().uuid(),
      },
    },
    async ({ sessionId, worktreeId }) => {
      const worktree = store.listWorktrees({ sessionId }).worktrees.find((entry) => entry.worktreeId === worktreeId);
      if (!worktree) {
        throw new Error("Unknown worktree for this session");
      }

      return jsonResult({
        ...worktree,
        headCommit: getWorktreeHead(worktree.path),
        dirty: isWorktreeDirty(worktree.path),
        diffStat: getWorktreeDiffStat(worktree.path),
      });
    }
  );

  registerTool(
    "tw_begin_finalizing",
    {
      description: "Parent-only tool to start final sync, audit, cleanup, and session teardown.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.beginFinalizing(input))
  );

  registerTool(
    "tw_complete_session",
    {
      description: "Parent-only tool to complete a teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        summary: z.string().min(1),
      },
    },
    async ({ sessionId, actorToken, summary }) => {
      workerSupervisor.stopSessionWorkers({ sessionId, actorToken });
      store.completeSession({ sessionId, actorToken, summary });
      return jsonResult(store.getSessionSummary(sessionId));
    }
  );

  registerTool(
    "tw_abandon_session",
    {
      description: "Parent-only tool to explicitly abandon an active teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.abandonSession(input))
  );

  registerTool(
    "tw_archive_session",
    {
      description: "Parent-only tool to hide a completed or abandoned teamwork session from the default dashboard.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.archiveSession(input))
  );

  registerWorkerSupervisorOperations(registerTool);
  registerTeamworkTool(server, operations);
}

function registerWorkerSupervisorOperations(
  registerTool: (
    name: string,
    config: any,
    handler: (input: any) => Promise<ReturnType<typeof jsonResult>> | ReturnType<typeof jsonResult>
  ) => void
) {
  registerTool(
    "plan_launch",
    {
      description: "Parent-only dry-run preview for launch_phase_workers. Shows CLI/model/reasoning/worktree/work items without starting worker processes.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        agentIds: z.array(z.string().uuid()).optional(),
        pairRoles: z.record(z.string().uuid(), z.enum(["implementer", "reviewer-tester"])).optional(),
        launchMode: z.enum(["persistent-stdin", "resume-command", "oneshot", "pty"]).optional(),
        modelOverrides: z.record(z.string().uuid(), z.string().min(1)).optional(),
        reasoningEffort: z.string().min(1).optional(),
        reasoningEffortOverrides: z.record(z.string().uuid(), z.string().min(1)).optional(),
        workItemIdsByAgentId: z.record(z.string().uuid(), z.array(z.string().uuid())).optional(),
      },
    },
    async (input) => jsonResult(workerSupervisor.planLaunch(input))
  );

  registerTool(
    "launch_worker",
    {
      description: "Parent-only operation to launch or resume one server-managed CLI worker.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        agentId: z.string().uuid(),
        worktreeId: z.string().uuid(),
        phaseNumber: z.number().int().positive(),
        workItemIds: z.array(z.string().uuid()).optional(),
        pairRole: z.enum(["implementer", "reviewer-tester"]).optional(),
        launchMode: z.enum(["persistent-stdin", "resume-command", "oneshot", "pty"]).optional(),
        model: z.string().min(1).optional(),
        reasoningEffort: z.string().min(1).optional(),
      },
    },
    async (input) => jsonResult(workerSupervisor.launchWorker(input))
  );

  registerTool(
    "launch_phase_workers",
    {
      description: "Parent-only operation to launch all selected workers for a phase.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        phaseNumber: z.number().int().positive(),
        agentIds: z.array(z.string().uuid()).optional(),
        pairRoles: z.record(z.string().uuid(), z.enum(["implementer", "reviewer-tester"])).optional(),
        launchMode: z.enum(["persistent-stdin", "resume-command", "oneshot", "pty"]).optional(),
        modelOverrides: z.record(z.string().uuid(), z.string().min(1)).optional(),
        reasoningEffort: z.string().min(1).optional(),
        reasoningEffortOverrides: z.record(z.string().uuid(), z.string().min(1)).optional(),
        workItemIdsByAgentId: z.record(z.string().uuid(), z.array(z.string().uuid())).optional(),
      },
    },
    async (input) => jsonResult(workerSupervisor.launchPhaseWorkers(input))
  );

  registerTool(
    "send_worker_input",
    {
      description: "Parent-only operation to send a follow-up instruction or question to a server-managed worker.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
        input: z.string().min(1),
      },
    },
    async (input) => jsonResult(workerSupervisor.sendWorkerInput(input))
  );

  registerTool(
    "restart_worker",
    {
      description: "Parent-only operation to stop and relaunch a server-managed worker.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
        worktreeId: z.string().uuid(),
        phaseNumber: z.number().int().positive(),
        pairRole: z.enum(["implementer", "reviewer-tester"]).optional(),
        launchMode: z.enum(["persistent-stdin", "resume-command", "oneshot", "pty"]).optional(),
      },
    },
    async (input) => jsonResult(workerSupervisor.restartWorker(input))
  );

  registerTool(
    "stop_worker",
    {
      description: "Parent-only operation to stop one server-managed worker.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
      },
    },
    async (input) => jsonResult(workerSupervisor.stopWorker(input))
  );

  registerTool(
    "get_worker_log",
    {
      description: "Parent-only drill-down operation to read unread, tail, or full prompt/stdout/stderr/stdin/runtime events for one worker. Use parent_poll_baseline for routine monitoring.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        runtimeId: z.string().uuid(),
        mode: z.enum(["new", "tail", "all"]).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        afterRuntimeLogId: z.string().uuid().optional(),
      },
    },
    async (input) => jsonResult(workerSupervisor.getWorkerLog(input))
  );

  registerTool(
    "list_worker_processes",
    {
      description: "Parent-only drill-down operation to list server-managed worker processes for a session. Use parent_poll_baseline for routine monitoring.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
      },
    },
    async (input) => jsonResult(workerSupervisor.listWorkerProcesses(input))
  );
}

function registerTeamworkTool(server: McpServer, operations: Map<string, {
  name: string;
  config: any;
  handler: (input: any) => Promise<ReturnType<typeof jsonResult>> | ReturnType<typeof jsonResult>;
}>) {
  const publicOperations = [...new Set([...operations.values()].map((operation) => operationName(operation.name)))].sort();
  server.registerTool(
    "teamwork",
    {
      description: teamworkToolDescription(publicOperations),
      inputSchema: {
        tool_name: z.string().min(1).describe("Operation to run, such as create_session, send_message, launch_worker, or help."),
        options: z.record(z.string(), z.unknown()).default({}).describe("Operation-specific parameters. Use tool_name=help for schemas."),
      },
    },
    async ({ tool_name, options }: { tool_name: string; options?: Record<string, unknown> }) => {
      if (tool_name === "help") {
        return jsonResult(helpPayload(publicOperations, options?.topic as string | undefined, operations));
      }

      const operation = operations.get(tool_name) ?? operations.get(`tw_${tool_name}`);
      if (!operation) {
        throw new Error(`Unknown teamwork operation '${tool_name}'. Valid operations: ${publicOperations.join(", ")}`);
      }

      const rawOptions = options ?? {};
      let parsed: any;
      try {
        parsed = parseOperationOptions(operation, rawOptions);
      } catch (error) {
        store.recordDebugEvent({
          eventType: "validation_error",
          toolName: operation.name,
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
      const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : undefined;
      store.recordDebugEvent({
        sessionId,
        eventType: "tool_call",
        toolName: operation.name,
        payload: redactForDebug(parsed),
      });
      try {
        const result = await operation.handler(parsed);
        store.recordDebugEvent({
          sessionId,
          eventType: "tool_result",
          toolName: operation.name,
          // TODO: summarize large or prompt-bearing tool results before storing routine debug metadata.
          payload: summarizeToolResult(result),
        });
        return result;
      } catch (error) {
        store.recordDebugEvent({
          sessionId,
          eventType: "tool_error",
          toolName: operation.name,
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    }
  );
}

function parseOperationOptions(operation: { name: string; config: any }, options: Record<string, unknown>) {
  if (!operation.config?.inputSchema) return {};
  const opName = operationName(operation.name);
  const normalizedInput = normalizePreParseOptions(opName, options);
  rejectLegacyOrUnknownProneOptions(opName, normalizedInput);
  const schema = z.object(operation.config.inputSchema).strict();
  const result = schema.safeParse(normalizedInput);
  if (!result.success) {
    throw new Error(`Invalid options for ${opName}: ${z.prettifyError(result.error)}`);
  }
  return normalizeParsedOptions(opName, result.data);
}

function normalizePreParseOptions(operation: string, options: Record<string, unknown>) {
  const has = (field: string) => Object.prototype.hasOwnProperty.call(options, field);
  if (operation === "wait_for_messages" && !has("waitMs")) {
    const aliasWaitMs = typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : typeof options.timeout === "number"
        ? options.timeout
        : typeof options.timeoutSeconds === "number"
          ? options.timeoutSeconds * 1000
          : typeof options.waitSeconds === "number"
            ? options.waitSeconds * 1000
            : undefined;
    if (aliasWaitMs !== undefined) return { ...options, waitMs: aliasWaitMs };
  }
  const actorTokenTolerantReadOnlyOperations = new Set([
    "get_session_state",
    "list_agents",
    "list_work_items",
    "list_worktrees",
    "list_results",
    "list_integration_events",
    "list_checkpoints",
  ]);
  if (actorTokenTolerantReadOnlyOperations.has(operation) && Object.prototype.hasOwnProperty.call(options, "actorToken")) {
    const { actorToken: _actorToken, ...rest } = options;
    return rest;
  }
  return options;
}

function rejectLegacyOrUnknownProneOptions(operation: string, options: Record<string, unknown>) {
  const has = (field: string) => Object.prototype.hasOwnProperty.call(options, field);
  if (operation === "upsert_work_item") {
    if (has("assignedTo")) {
      throw new Error("Invalid options for upsert_work_item: use assigneeAgentIds: [workerAgentUuid] instead of assignedTo. assignedTo is not accepted because it cannot be safely mapped from aliases.");
    }
    if (Array.isArray(options.acceptanceCriteria)) {
      throw new Error("Invalid options for upsert_work_item: acceptanceCriteria must be one string, not an array. Join bullet criteria into a single string.");
    }
  }
  if (operation === "record_result") {
    if (options.resultType === "summary") {
      throw new Error('Invalid options for record_result: resultType must be one of "commit" | "artifact" | "test-report" | "note". Use "note" for summaries/reviews.');
    }
  }
  if (operation === "update_work_item_status" && options.status === "complete") {
    throw new Error('Invalid options for update_work_item_status: status "complete" is not valid. Use "done".');
  }
  if (operation === "send_message") {
    if (has("to") || has("recipient") || has("targetAlias") || has("targetAgentAlias")) {
      throw new Error('Invalid options for send_message: use target: "broadcast" or target: "agent" with targetAgentId. Alias/generic target fields are not accepted.');
    }
    if (["analysis", "critique", "challenge"].includes(String(options.kind))) {
      throw new Error('Invalid options for send_message: kind must be one of "status" | "question" | "answer" | "handoff" | "system". Put analysis/critique/challenge wording in body.');
    }
  }
  if (operation === "register_worktree" && options.status === "active") {
    throw new Error('Invalid options for register_worktree: status "active" is not valid. Use "ready" after the worktree exists.');
  }
  if (operation === "wait_for_messages" && (has("timeout") || has("timeoutMs") || has("timeoutSeconds") || has("waitSeconds"))) {
    return;
  }
  if (operation === "launch_worker") {
    if (has("worktreePath") || has("path")) {
      throw new Error("Invalid options for launch_worker: use worktreeId from register_worktree, not a filesystem path.");
    }
  }
}

function normalizeParsedOptions(operation: string, parsed: any) {
  if (operation === "record_result" && parsed.data !== undefined && typeof parsed.data !== "string") {
    return { ...parsed, data: JSON.stringify(parsed.data) };
  }
  if (operation === "wait_for_messages") {
    const waitMs = parsed.waitMs
      ?? parsed.timeoutMs
      ?? parsed.timeout
      ?? (parsed.timeoutSeconds === undefined ? undefined : parsed.timeoutSeconds * 1000)
      ?? (parsed.waitSeconds === undefined ? undefined : parsed.waitSeconds * 1000)
      ?? 30_000;
    const { timeout, timeoutMs, timeoutSeconds, waitSeconds, ...rest } = parsed;
    return { ...rest, waitMs };
  }
  if (operation === "ack_messages") {
    if (parsed.upToSequence === undefined && (!Array.isArray(parsed.messageIds) || parsed.messageIds.length === 0)) {
      throw new Error("Invalid options for ack_messages: provide upToSequence or at least one messageIds entry.");
    }
  }
  return parsed;
}

function operationName(name: string) {
  return name.startsWith("tw_") ? name.slice(3) : name;
}

function teamworkToolDescription(operations: string[]) {
  return [
    "Run teamwork MCP operations through one documented dispatcher.",
    "Input: { tool_name: string, options: object }. options must exactly match the operation schema; unknown fields are rejected.",
    "Groups: session, agents, phases, work items, messages, worker processes, results, audit/debug, help.",
    "Common: create_session, register_agent, list_agents, get_session_resume_packet, start_phase, upsert_work_item, claim_work_item, send_message, wait_for_messages, record_result, parent_poll_baseline, parent_poll, complete_phase, plan_launch, launch_worker, send_worker_input, get_worker_log, get_diagnostic_report, complete_session.",
    "Do not guess legacy fields: use assigneeAgentIds, acceptanceCriteria as string, resultType commit|artifact|test-report|note, status planned|assigned|in-progress|blocked|done|canceled, message kind status|question|answer|handoff|system.",
    "Frequent monitoring must use parent_poll_baseline; call parent_poll only for drill-down when baseline shows attention is needed. Do not build external HTTP/SSE polling scripts against /mcp.",
    "Use tool_name='help' for the operation catalog or help with options.topic for one operation. Help returns exact option fields, required/optional sets, enum values, and examples.",
    ...coreSchemaSnippets(),
    `Available operations: ${operations.join(", ")}`,
  ].join("\n");
}

function helpPayload(operations: string[], topic: string | undefined, registry: Map<string, { name: string; config: any }>) {
  if (!topic) {
    return {
      tool: "teamwork",
      usage: { tool_name: "operation name", options: "operation-specific object" },
      operations,
    };
  }
  const operation = registry.get(topic) ?? registry.get(`tw_${topic}`);
  if (!operation) {
    throw new Error(`Unknown help topic '${topic}'. Valid topics: ${operations.join(", ")}`);
  }
  const shape = operation.config?.inputSchema ?? {};
  return {
    operation: operationName(operation.name),
    description: operation.config?.description ?? "",
    callerRole: callerRoleFor(operationName(operation.name)),
    schema: schemaHelp(shape),
    required: Object.entries(shape)
      .filter(([, schema]) => !isOptionalSchema(schema))
      .map(([name]) => name),
    optional: Object.entries(shape)
      .filter(([, schema]) => isOptionalSchema(schema))
      .map(([name]) => name),
    commonFailureReasons: commonFailureReasons(operationName(operation.name)),
    related: relatedOperations(operationName(operation.name)),
  };
}

function schemaHelp(shape: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(shape).map(([name, schema]) => [
      name,
      {
        type: schemaType(schema),
        required: !isOptionalSchema(schema),
      },
    ])
  );
}

function schemaType(schema: unknown): string {
  const def = schema && typeof schema === "object" && "_def" in schema ? (schema as any)._def : undefined;
  if (!def) return "unknown";
  if (def.type === "optional" || def.type === "default") return schemaType(def.innerType);
  if (def.type === "array") return `${schemaType(def.element)}[]`;
  if (def.type === "union") return def.options.map((option: unknown) => schemaType(option)).join(" | ");
  if (def.type === "enum") return Object.values(def.entries).map((value) => JSON.stringify(value)).join(" | ");
  if (def.type === "number") return "number";
  if (def.type === "boolean") return "boolean";
  if (def.type === "record") return "object";
  return String(def.type ?? "unknown");
}

function coreSchemaSnippets() {
  return [
    'Schemas: register_agent options include sessionId, alias, specialty, responsibility?: string, cli, model, role: "parent"|"worker". Responsibility is parent-defined and should be one or two sentences documenting what that agent owns.',
    'Schemas: upsert_work_item options include sessionId, actorToken, phaseNumber, title, description, acceptanceCriteria?: string, assigneeAgentIds?: uuid[], primaryAssigneeAgentId?: uuid, status?: "planned"|"assigned"|"in-progress"|"blocked"|"done"|"canceled".',
    'Schemas: claim_work_item requires sessionId, actorToken, workItemId. Workers must explicitly claim one assigned work item before recording a result.',
    'Schemas: launch_worker requires sessionId, actorToken, agentId, worktreeId, phaseNumber; workItemIds?: uuid[]; launchMode?: "persistent-stdin"|"resume-command"|"oneshot"|"pty"; model?: string; reasoningEffort?: string.',
    'Schemas: plan_launch and launch_phase_workers require sessionId, actorToken, phaseNumber; optional agentIds, launchMode, modelOverrides, reasoningEffort, reasoningEffortOverrides, workItemIdsByAgentId.',
    'Schemas: record_result requires sessionId, actorToken, workItemId, resultType: "commit"|"artifact"|"test-report"|"note", summary; data?: string|object; commitSha/commitShas and verificationSummary are optional structured fields. Parent fallback captures visible worker output as resultType "note".',
    'Schemas: send_message requires sessionId, actorToken, target: "broadcast"|"agent", kind: "status"|"question"|"answer"|"handoff"|"system", body; targetAgentId required when target is "agent".',
    'Schemas: register_worktree status?: "creating"|"ready"|"dirty"|"merged"|"failed"|"removed"|"cleanup-needed".',
    'Schemas: closeout uses get_closeout_checklist, closeout_ack_workers, cleanup_worktree, record_integration_event, complete_phase, and complete_session in that order when blockers require it. parent_poll_baseline reports closeoutReady when all work is done and the next closeout action is due.',
    'Compatibility: wait_for_messages prefers waitMs, but timeout/timeoutMs/timeoutSeconds/waitSeconds are normalized to waitMs; ack_messages accepts upToSequence or visible messageIds to recover common agent mistakes.',
  ];
}

function isOptionalSchema(schema: unknown) {
  return typeof schema === "object" && schema !== null && "_def" in schema && /(optional|default)/i.test(String((schema as any)._def?.type));
}

function relatedOperations(operation: string) {
  if (operation === "parent_poll_baseline") return ["parent_poll", "get_worker_log", "list_worker_processes", "list_results", "list_messages", "get_session_resume_packet"];
  if (operation === "parent_poll") return ["get_worker_log", "list_worker_processes", "list_results", "list_messages", "get_session_resume_packet"];
  if (operation === "plan_launch") return ["launch_phase_workers", "launch_worker", "register_worktree", "upsert_work_item"];
  if (operation === "claim_work_item") return ["list_work_items", "record_result", "update_work_item_status"];
  if (operation.includes("worker")) return ["register_agent", "register_worktree", "upsert_work_item", "send_message", "parent_poll_baseline"];
  if (operation.includes("message")) return ["wait_for_messages", "ack_messages", "closeout_ack_workers", "resolve_obligation"];
  if (operation.includes("phase")) return ["start_phase", "begin_integration", "record_integration_event", "get_closeout_checklist", "complete_phase"];
  if (operation.includes("session") || operation.includes("closeout")) return ["get_closeout_checklist", "closeout_ack_workers", "cleanup_worktree", "complete_session"];
  return [];
}

function callerRoleFor(operation: string) {
  if (/plan_launch|launch_worker|launch_phase_workers|send_worker_input|restart_worker|stop_worker|get_worker_log|list_worker_processes/.test(operation)) {
    return "parent";
  }
  if (
    /create_session|register_agent|get_session_state|list_|wait_for_messages|send_message|ack_messages|claim_work_item|record_result|update_work_item_status/.test(
      operation
    )
  ) {
    return "parent_or_worker";
  }
  return "parent";
}

function commonFailureReasons(operation: string) {
  const reasons = ["missing required option", "actorToken does not belong to the session"];
  if (operation.includes("worker")) reasons.push("worker has no registered worktree", "CLI adapter is not configured");
  if (operation.includes("phase")) reasons.push("phase gates are not satisfied");
  if (operation.includes("complete")) reasons.push("open work items, obligations, runtimes, or worktrees remain");
  return reasons;
}

function startJanitor() {
  if (janitorIntervalMs <= 0) return;
  setInterval(() => {
    try {
      store.runJanitor({ ttlHours: janitorTtlHours, worktreeGc: worktreeGcEnabled });
    } catch (error) {
      process.stderr.write(`teamwork janitor error: ${String(error)}\n`);
    }
  }, janitorIntervalMs).unref();
}

function createHttpServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing request URL");
      return;
    }

    const url = new URL(req.url, `http://${uiHost}:${uiPort}`);

    if (url.pathname === "/health") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({
        status: "ok",
        pid: process.pid,
        transport: transportMode,
        mcpEndpoint: `http://${uiHost}:${uiPort}/mcp`,
        dashboard: `http://${uiHost}:${uiPort}/`,
      }, null, 2));
      return;
    }

    // MCP Streamable HTTP endpoint (only in http transport mode)
    if (url.pathname === "/mcp" && transportMode === "http") {
      await handleMcpRequest(req, res);
      return;
    }

    if (url.pathname === "/api/sessions") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ sessions: store.listSessionsForDashboard(legacyDashboardFilters(url)) }, null, 2));
      return;
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/audit")) {
      const sessionId = url.pathname.replace("/api/sessions/", "").replace("/audit", "");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      try {
        res.end(JSON.stringify(store.getAuditReport(sessionId), null, 2));
      } catch (error) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: String(error) }, null, 2));
      }
      return;
    }

    if (url.pathname === "/api/debug-events") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({
        events: store.listDebugEvents({
          sessionId: url.searchParams.get("sessionId") ?? undefined,
          limit: Number.parseInt(url.searchParams.get("limit") ?? "200", 10),
        }).events,
      }, null, 2));
      return;
    }

    if (handleDashboardRequest(req, res, url, store, workerSupervisor)) return;

    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not found");
  });
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "GET") {
    if (sessionId && httpTransports.has(sessionId)) {
      await httpTransports.get(sessionId)!.handleRequest(req, res);
      return;
    }
    res.statusCode = 400;
    res.end("Missing or invalid mcp-session-id header");
    return;
  }

  if (req.method === "DELETE") {
    if (sessionId && httpTransports.has(sessionId)) {
      const transport = httpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
      httpTransports.delete(sessionId);
      return;
    }
    res.statusCode = 400;
    res.end("Missing or invalid mcp-session-id header");
    return;
  }

  // POST — either route to existing session or initialize a new one
  if (sessionId && httpTransports.has(sessionId)) {
    await httpTransports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid: string) => {
      httpTransports.set(sid, transport);
    },
  } as any);

  transport.onclose = () => {
    if (transport.sessionId) {
      httpTransports.delete(transport.sessionId);
    }
  };

  // Each HTTP client gets its own McpServer instance sharing the same store
  const clientMcp = new McpServer({
    name: "teamwork-mcp",
    version: "0.1.0",
  });
  registerToolsOn(clientMcp);
  await clientMcp.connect(transport);

  await transport.handleRequest(req, res);
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function redactForDebug(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDebug);
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|key/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactForDebug(nested);
    }
  }
  return redacted;
}

function summarizeToolResult(result: ReturnType<typeof jsonResult>) {
  const text = result.content[0]?.text ?? "";
  if (text.length <= 4000) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return { truncated: true, length: text.length, preview: text.slice(0, 4000) };
}
