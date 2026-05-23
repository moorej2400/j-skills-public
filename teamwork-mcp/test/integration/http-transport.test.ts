import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";

import {
  TEST_PORT,
  BASE_URL,
  callTool,
  postMcp,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

const EXPECTED_TOOLS = ["teamwork"];

describe("teamwork-mcp HTTP transport", () => {
  let server: ChildProcess;
  let tmpDir: string;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
  });

  after(() => stopServer(server, tmpDir));

  it("initializes an MCP session and lists the single teamwork dispatcher tool", async () => {
    const sid = await initSession("transport-test");

    const tools = await postMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid
    );
    assert.equal(tools.status, 200);
    const toolNames: string[] = tools.json.result.tools.map((t: any) => t.name);

    assert.deepEqual(toolNames, EXPECTED_TOOLS);
    assert.match(tools.json.result.tools[0].description, /tool_name/);
  });

  it("two clients receive distinct MCP session IDs", async () => {
    const sidA = await initSession("client-a");
    const sidB = await initSession("client-b");
    assert.notEqual(sidA, sidB);
  });

  it("serves dashboard HTML at /", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("text/html"), `expected text/html, got ${ct}`);
    const html = await res.text();
    assert.ok(html.includes("<!DOCTYPE html") || html.includes("<html"));
  });

  it("serves session JSON at /api/sessions", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("application/json"), `expected application/json, got ${ct}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
  });

  it("serves a session audit report at /api/sessions/:id/audit", async () => {
    const sid = await initSession("audit-http-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "HTTP audit session",
      taskSlug: "http-audit",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for http transport.",
    }, 30);
    const sessionId = session.sessionId;

    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/audit`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("application/json"), `expected application/json, got ${ct}`);
    const body = await res.json();
    assert.equal(body.session.sessionId, sessionId);
    assert.equal(body.rollup.workerCount, 0);
  });

  it("serves debug events at /api/debug-events", async () => {
    const res = await fetch(`${BASE_URL}/api/debug-events?limit=10`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("application/json"), `expected application/json, got ${ct}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
  });

  it("DELETE terminates an MCP session", async () => {
    const sid = await initSession("delete-test");

    const del = await fetch(`${BASE_URL}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
    });
    assert.ok([200, 204].includes(del.status), `expected 200 or 204, got ${del.status}`);

    // Subsequent request on the deleted session should fail
    const after = await postMcp(
      { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
      sid
    );
    assert.ok(after.status >= 400, `expected >=400 after delete, got ${after.status}`);
  });

  it("GET /mcp without session ID returns 400", async () => {
    const res = await fetch(`${BASE_URL}/mcp`);
    assert.equal(res.status, 400);
  });
});
