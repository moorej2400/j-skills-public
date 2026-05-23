import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASE_URL, startServer, stopServer } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bootstrapEntry = path.resolve(__dirname, "..", "..", "src", "stdio-bootstrap.ts");

describe("stdio bootstrap", () => {
  let server: ChildProcess;
  let tmpDir: string;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
  });

  after(() => stopServer(server, tmpDir));

  it("serves a health check for bootstrap discovery", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.mcpEndpoint, `${BASE_URL}/mcp`);
  });

  it("bridges stdio MCP messages to the existing singleton HTTP server", async () => {
    const bridge = spawn(process.execPath, ["--import", "tsx", bootstrapEntry], {
      env: {
        ...process.env,
        TEAMWORK_MCP_URL: `${BASE_URL}/mcp`,
        TEAMWORK_BOOTSTRAP_START_SERVER: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines: string[] = [];
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk: string) => {
      stdoutLines.push(...chunk.split("\n").filter(Boolean));
    });

    try {
      bridge.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "bootstrap-test", version: "1.0.0" },
        },
      }) + "\n");
      const init = await readJsonLine(stdoutLines);
      assert.equal(init.id, 1);
      assert.equal(init.result.serverInfo.name, "teamwork-mcp");

      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
      const tools = await readJsonLine(stdoutLines);
      assert.equal(tools.id, 2);
      assert.deepEqual(tools.result.tools.map((tool: any) => tool.name), ["teamwork"]);
    } finally {
      bridge.kill("SIGTERM");
    }
  });

  it("starts the singleton HTTP server when none is running", async () => {
    const port = await allocatePort();
    const tmpDataDir = mkdtempSync(path.join(tmpdir(), "teamwork-bootstrap-"));
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const bridge = spawn(process.execPath, ["--import", "tsx", bootstrapEntry], {
      env: {
        ...process.env,
        TEAMWORK_MCP_URL: endpoint,
        TEAMWORK_DATA_DIR: tmpDataDir,
        TEAMWORK_BOOTSTRAP_TIMEOUT_MS: "10000",
        TEAMWORK_OPEN_BROWSER: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines: string[] = [];
    let serverPid: number | undefined;
    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk: string) => {
      stdoutLines.push(...chunk.split("\n").filter(Boolean));
    });

    try {
      bridge.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "bootstrap-start-test", version: "1.0.0" },
        },
      }) + "\n");
      const init = await readJsonLine(stdoutLines, 15_000);
      assert.equal(init.id, 1);
      assert.equal(init.result.serverInfo.name, "teamwork-mcp");

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      serverPid = body.pid;
      assert.equal(body.mcpEndpoint, endpoint);
      assert.notEqual(serverPid, process.pid);
    } finally {
      bridge.kill("SIGTERM");
      if (serverPid) {
        try { process.kill(serverPid, "SIGTERM"); } catch {}
      }
      await removeDirWithRetry(tmpDataDir);
    }
  });
});

async function readJsonLine(lines: string[], timeoutMs = 10_000): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const line = lines.shift();
    if (line) return JSON.parse(line);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for stdio bridge output");
}

async function allocatePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function removeDirWithRetry(dir: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}
