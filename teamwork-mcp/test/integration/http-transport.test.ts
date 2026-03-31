import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";

import {
  TEST_PORT,
  BASE_URL,
  postMcp,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

const EXPECTED_TOOLS = [
  "tw_get_dashboard_url",
  "tw_create_session",
  "tw_register_agent",
  "tw_get_session_state",
  "tw_start_phase",
  "tw_complete_phase",
  "tw_upsert_work_item",
  "tw_list_work_items",
  "tw_send_message",
  "tw_list_messages",
  "tw_ack_messages",
  "tw_set_agent_status",
  "tw_register_worktree",
  "tw_update_worktree",
  "tw_list_worktrees",
  "tw_register_runtime",
  "tw_update_runtime",
  "tw_list_runtimes",
  "tw_record_result",
  "tw_list_results",
  "tw_record_integration_event",
  "tw_list_integration_events",
  "tw_create_checkpoint",
  "tw_list_checkpoints",
  "tw_inspect_worktree",
  "tw_complete_session",
];

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

  it(`initializes an MCP session and lists all ${EXPECTED_TOOLS.length} tools`, async () => {
    const sid = await initSession("transport-test");

    const tools = await postMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sid
    );
    assert.equal(tools.status, 200);
    const toolNames: string[] = tools.json.result.tools.map((t: any) => t.name);

    assert.equal(toolNames.length, EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length} tools, got ${toolNames.length}`);
    for (const name of EXPECTED_TOOLS) {
      assert.ok(toolNames.includes(name), `missing tool: ${name}`);
    }
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
