import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import { renderDashboardPage } from "./dashboard.js";
import { TeamworkStore } from "./store.js";
import { getWorktreeDiffStat, getWorktreeHead, isWorktreeDirty } from "./worktrees.js";

const dataDir = process.env.TEAMWORK_DATA_DIR
  ? path.resolve(process.env.TEAMWORK_DATA_DIR)
  : path.resolve(process.cwd(), ".teamwork");
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.TEAMWORK_DB_PATH
  ? path.resolve(process.env.TEAMWORK_DB_PATH)
  : path.join(dataDir, "teamwork.sqlite");
const uiPort = Number.parseInt(process.env.TEAMWORK_UI_PORT ?? "48741", 10);
const uiHost = process.env.TEAMWORK_UI_HOST ?? "127.0.0.1";
const transportMode = process.env.TEAMWORK_TRANSPORT ?? "stdio";

const store = new TeamworkStore({ dbPath });
const mcp = new McpServer({
  name: "teamwork-mcp",
  version: "0.1.0",
});

registerToolsOn(mcp);

// Map of active HTTP transport sessions so multiple clients share one server process.
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  if (transportMode === "stdio") {
    const httpServer = createHttpServer();
    await startHttpServer(httpServer);
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    process.stderr.write(`teamwork-mcp ready (stdio)\n`);
    process.stderr.write(`dashboard http://${uiHost}:${uiPort}\n`);
  } else {
    const httpServer = createHttpServer();
    await startHttpServer(httpServer);
    process.stderr.write(`teamwork-mcp ready (http)\n`);
    process.stderr.write(`mcp endpoint http://${uiHost}:${uiPort}/mcp\n`);
    process.stderr.write(`dashboard http://${uiHost}:${uiPort}\n`);
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

function registerToolsOn(server: McpServer) {
  server.registerTool(
    "tw_get_dashboard_url",
    {
      description: "Get the local dashboard URL for the teamwork MCP server.",
    },
    async () => jsonResult({ url: `http://${uiHost}:${uiPort}` })
  );

  server.registerTool(
    "tw_create_session",
    {
      description: "Create a new teamwork session.",
      inputSchema: {
        parentAlias: z.string().min(1),
        title: z.string().min(1),
        taskSlug: z.string().min(1),
        projectRoot: z.string().min(1),
      },
    },
    async ({ parentAlias, title, taskSlug, projectRoot }) =>
      jsonResult(store.createSession({ parentAlias, title, taskSlug, projectRoot }))
  );

  server.registerTool(
    "tw_register_agent",
    {
      description: "Register the parent or a worker for a teamwork session.",
      inputSchema: {
        sessionId: z.string().uuid(),
        alias: z.string().min(1),
        specialty: z.string().min(1),
        cli: z.string().min(1),
        model: z.string().min(1),
        role: z.enum(["parent", "worker"]),
      },
    },
    async ({ sessionId, alias, specialty, cli, model, role }) =>
      jsonResult(store.registerAgent({ sessionId, alias, specialty, cli, model, role }))
  );

  server.registerTool(
    "tw_get_session_state",
    {
      description: "Get the current teamwork session summary.",
      inputSchema: {
        sessionId: z.string().uuid(),
      },
    },
    async ({ sessionId }) => jsonResult(store.getSessionSummary(sessionId))
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
        status: z.enum(["planned", "assigned", "in-progress", "blocked", "done"]).optional(),
        dependsOnIds: z.array(z.string().uuid()).optional(),
      },
    },
    async (input) => jsonResult(store.upsertWorkItem(input))
  );

  server.registerTool(
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

  server.registerTool(
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
      },
    },
    async (input) => jsonResult(store.sendMessage(input))
  );

  server.registerTool(
    "tw_list_messages",
    {
      description: "List teamwork messages visible to the current agent since a sequence number.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        afterSequence: z.number().int().min(0).default(0),
      },
    },
    async ({ sessionId, actorToken, afterSequence }) =>
      jsonResult(store.listMessagesSince({ sessionId, actorToken, afterSequence }))
  );

  server.registerTool(
    "tw_ack_messages",
    {
      description: "Acknowledge teamwork messages up to a sequence number.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        upToSequence: z.number().int().min(0),
      },
    },
    async ({ sessionId, actorToken, upToSequence }) => {
      store.acknowledgeMessages({ sessionId, actorToken, upToSequence });
      return jsonResult({ ok: true });
    }
  );

  server.registerTool(
    "tw_set_agent_status",
    {
      description: "Update your own status, or parent-update another agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        status: z.enum(["active", "blocked", "done", "inactive"]),
        note: z.string().optional(),
        targetAgentId: z.string().uuid().optional(),
      },
    },
    async ({ sessionId, actorToken, status, note, targetAgentId }) => {
      store.setAgentStatus({ sessionId, actorToken, status, note, targetAgentId });
      return jsonResult({ ok: true });
    }
  );

  server.registerTool(
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
        status: z.enum(["creating", "ready", "dirty", "merged", "failed"]).optional(),
      },
    },
    async (input) => jsonResult(store.registerWorktree(input))
  );

  server.registerTool(
    "tw_update_worktree",
    {
      description: "Update a tracked worktree status or branch metadata.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        worktreeId: z.string().uuid(),
        status: z.enum(["creating", "ready", "dirty", "merged", "failed"]).optional(),
        branch: z.string().min(1).optional(),
        baseCommit: z.string().min(1).optional(),
      },
    },
    async (input) => jsonResult(store.updateWorktree(input))
  );

  server.registerTool(
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

  server.registerTool(
    "tw_register_runtime",
    {
      description: "Register a running worker runtime for a session agent.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        agentId: z.string().uuid(),
        pid: z.number().int().positive().optional(),
        transport: z.string().min(1),
      },
    },
    async (input) => jsonResult(store.registerRuntime(input))
  );

  server.registerTool(
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
    async (input) => jsonResult(store.updateRuntime(input))
  );

  server.registerTool(
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

  server.registerTool(
    "tw_record_result",
    {
      description: "Record a work result for a work item.",
      inputSchema: {
        sessionId: z.string().uuid(),
        actorToken: z.string().min(1),
        workItemId: z.string().uuid(),
        resultType: z.enum(["commit", "artifact", "test-report", "note"]),
        summary: z.string().min(1),
        data: z.string().optional(),
      },
    },
    async (input) => jsonResult(store.recordResult(input))
  );

  server.registerTool(
    "tw_list_results",
    {
      description: "List recorded results for a session or one work item.",
      inputSchema: {
        sessionId: z.string().uuid(),
        workItemId: z.string().uuid().optional(),
      },
    },
    async (input) => jsonResult(store.listResults(input))
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
      store.completeSession({ sessionId, actorToken, summary });
      return jsonResult(store.getSessionSummary(sessionId));
    }
  );
}

function createHttpServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing request URL");
      return;
    }

    const url = new URL(req.url, `http://${uiHost}:${uiPort}`);

    // MCP Streamable HTTP endpoint (only in http transport mode)
    if (url.pathname === "/mcp" && transportMode === "http") {
      await handleMcpRequest(req, res);
      return;
    }

    if (url.pathname === "/api/sessions") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ sessions: store.listSessionsForDashboard() }, null, 2));
      return;
    }

    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(renderDashboardPage(store.listSessionsForDashboard()));
      return;
    }

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
