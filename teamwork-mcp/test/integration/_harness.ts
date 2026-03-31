import { spawn, ChildProcess, execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "..", "..", "src", "server.ts");

export let TEST_PORT = 0;
export let BASE_URL = "";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postMcp(
  body: unknown,
  sessionId?: string
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        json: text ? JSON.parse(text) : null,
      };
    } catch (error) {
      lastError = error;
      await sleep(100 * attempt);
    }
  }
  throw lastError;
}

export async function callTool(sid: string, name: string, args: Record<string, any> = {}, id = 10): Promise<any> {
  const res = await postMcp(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    sid
  );
  if (res.json?.error) throw new Error(`Tool ${name} failed: ${JSON.stringify(res.json.error)}`);
  return JSON.parse(res.json.result.content[0].text);
}

export async function initSession(clientName = "test-client"): Promise<string> {
  const init = await postMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  const sid = init.headers.get("mcp-session-id")!;
  await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}

async function allocatePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function startServer(): Promise<{
  server: ChildProcess;
  tmpDir: string;
  waitReady: () => Promise<void>;
}> {
  TEST_PORT = await allocatePort();
  BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  const tmpDir = mkdtempSync(path.join(tmpdir(), "teamwork-mcp-integ-"));
  const server = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    env: {
      ...process.env,
      TEAMWORK_UI_PORT: String(TEST_PORT),
      TEAMWORK_TRANSPORT: "http",
      TEAMWORK_DATA_DIR: tmpDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const waitReady = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10_000);
    server.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("teamwork-mcp ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`server exited before ready: ${code ?? "unknown"}`)));
  });

  return { server, tmpDir, waitReady };
}

export function stopServer(server: ChildProcess, tmpDir: string) {
  server?.kill("SIGTERM");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function createGitWorktreeFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "teamwork-mcp-git-"));
  const repoRoot = path.join(rootDir, "repo");
  const worktreeRoot = path.join(rootDir, "worktrees");
  const featureWorktree = path.join(worktreeRoot, "worker-a");

  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(rootDir, ["init", "--initial-branch=main", repoRoot]);
  runGit(repoRoot, ["config", "user.name", "Teamwork MCP Tests"]);
  runGit(repoRoot, ["config", "user.email", "teamwork-mcp-tests@example.com"]);

  writeFileSync(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "initial fixture"]);
  runGit(repoRoot, ["branch", "worker-a"]);
  runGit(repoRoot, ["worktree", "add", featureWorktree, "worker-a"]);

  writeFileSync(path.join(featureWorktree, "feature.txt"), "local worktree change\n", "utf8");

  return {
    rootDir,
    repoRoot,
    featureWorktree,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
