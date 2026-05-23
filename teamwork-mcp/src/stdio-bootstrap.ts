import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * Stdio bootstrap for hosts that only support command-based MCP config.
 *
 * This process is intentionally just a bridge. Workflow state, worker
 * supervision, and the dashboard stay in the singleton HTTP server.
 */
const defaultHost = process.env.TEAMWORK_UI_HOST ?? "127.0.0.1";
const defaultPort = process.env.TEAMWORK_UI_PORT ?? "48741";
const mcpUrl = new URL(process.env.TEAMWORK_MCP_URL ?? `http://${defaultHost}:${defaultPort}/mcp`);
const healthUrl = new URL("/health", mcpUrl);
const dataDir = process.env.TEAMWORK_DATA_DIR
  ? path.resolve(process.env.TEAMWORK_DATA_DIR)
  : path.join(os.homedir(), ".teamwork");
const lockDir = path.join(dataDir, "server-start.lock");
const logsDir = path.join(dataDir, "logs");

await ensureSingletonServer();
await bridgeStdioToHttp();

async function ensureSingletonServer() {
  if (await isHealthy()) return;
  if (process.env.TEAMWORK_BOOTSTRAP_START_SERVER === "0") return;

  mkdirSync(dataDir, { recursive: true });
  if (!tryAcquireStartLock()) {
    await waitForHealth();
    return;
  }

  try {
    if (await isHealthy()) return;
    startServerProcess();
    await waitForHealth();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function bridgeStdioToHttp() {
  const readBuffer = new ReadBuffer();
  let mcpSessionId: string | undefined;
  let queue = Promise.resolve();

  process.stdin.on("data", (chunk: Buffer) => {
    readBuffer.append(chunk);
    while (true) {
      const message = readBuffer.readMessage();
      if (!message) break;
      queue = queue.then(async () => {
        try {
          const response = await forwardMcpMessage(message, mcpSessionId);
          const nextSessionId = response.headers.get("mcp-session-id");
          if (nextSessionId) mcpSessionId = nextSessionId;
          if (response.body) process.stdout.write(serializeMessage(response.body));
        } catch (error) {
          process.stdout.write(serializeMessage(errorResponse(message, error)));
        }
      });
    }
  });

  process.stdin.resume();
}

async function forwardMcpMessage(message: unknown, sessionId?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(body?.error?.message ?? (text || `HTTP ${res.status}`));
  return { headers: res.headers, body };
}

async function isHealthy() {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + Number.parseInt(process.env.TEAMWORK_BOOTSTRAP_TIMEOUT_MS ?? "15000", 10);
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`teamwork-mcp singleton did not become healthy at ${healthUrl.href}`);
}

function startServerProcess() {
  mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "teamwork-mcp.log");
  const logFd = openSync(logPath, "a");
  const serverEntry = fileURLToPath(new URL("./server.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: path.dirname(serverEntry),
    detached: true,
    env: {
      ...process.env,
      TEAMWORK_TRANSPORT: "http",
      TEAMWORK_UI_HOST: mcpUrl.hostname,
      TEAMWORK_UI_PORT: mcpUrl.port || defaultPort,
    },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
}

function tryAcquireStartLock() {
  try {
    // A mkdir lock keeps simultaneous MCP hosts from racing to start duplicate singleton servers.
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function errorResponse(message: any, error: unknown) {
  const response: {
    jsonrpc: "2.0";
    id?: string | number;
    error: { code: number; message: string };
  } = {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: String(error instanceof Error ? error.message : error),
    },
  };
  if (message && typeof message === "object" && "id" in message && message.id !== null) {
    response.id = message.id;
  }
  return response;
}
