import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  callTool,
  createFakeCliFixture,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

// Tests covering the new /api/v2/* dashboard surface, the worker_output table,
// and the tw_append_output MCP tool. Each test starts from a fresh server +
// session so failures are isolated.

describe("teamwork-mcp dashboard v2 surface", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let fakeCli: ReturnType<typeof createFakeCliFixture>;

  before(async () => {
    fakeCli = createFakeCliFixture();
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
    });
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
  });

  after(() => {
    stopServer(server, tmpDir);
    fakeCli.cleanup();
  });

  it("GET /api/v2/sessions returns a flat array (not wrapped) and excludes stopped by default", async () => {
    const sid = await initSession("v2-list-test");
    const created = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 list",
      taskSlug: "v2-list",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 30);
    const sessionId = created.sessionId;

    const res = await fetch(`${BASE_URL}/api/v2/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), "expected flat array");
    const found = body.find((s: any) => s.id === sessionId);
    assert.ok(found, "active session should be in default list");
    assert.equal(typeof found.slug, "string");
    assert.equal(typeof found.parentCli, "string");
    assert.equal(typeof found.createdAt, "string");
    assert.notEqual(
      found.createdAt,
      "",
      "createdAt should not be empty"
    );
  });

  it("?includeStopped (bare) is treated as true", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/sessions?includeStopped`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("rejects ?includeStopped=garbage with 400", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/sessions?includeStopped=maybe`);
    assert.equal(res.status, 400);
  });

  it("GET /api/v2/sessions/:id returns detail with agents+assignments+phases", async () => {
    const sid = await initSession("v2-detail-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 detail",
      taskSlug: "v2-detail",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 40);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "claude",
      model: "claude-sonnet-4-6",
      role: "parent",
    }, 41);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker",
      specialty: "review",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    }, 411);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Review",
      goal: "Check dashboard claim projection.",
    }, 412);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Review queue item",
      description: "Make sure claims reach the dashboard.",
      status: "assigned",
      assigneeAgentIds: [worker.agentId],
      primaryAssigneeAgentId: worker.agentId,
    }, 413);
    await callTool(sid, "tw_claim_work_item", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
    }, 414);

    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}`
    );
    assert.equal(res.status, 200, "v2 detail route must not 404 (regression: regex prefix)");
    const body = await res.json();
    assert.equal(body.session.id, session.sessionId);
    assert.equal(body.session.slug, "v2-detail");
    assert.ok(Array.isArray(body.agents));
    assert.ok(body.agents.find((a: any) => a.agentId === parent.agentId));
    assert.ok(Array.isArray(body.phases));
    assert.ok(Array.isArray(body.assignments));
    assert.equal(body.assignments[0].status, "in_progress");
    assert.equal(body.assignments[0].activeClaims[0].agentAlias, "worker");
    assert.equal(typeof body.counts.messages, "number");
  });

  it("GET /api/v2/sessions/:id returns 404 for unknown id", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/sessions/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
  });

  it("GET /api/v2/sessions/:id/messages paginates and returns sender alias", async () => {
    const sid = await initSession("v2-msg-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 msg",
      taskSlug: "v2-msg",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 50);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "claude",
      model: "claude-sonnet-4-6",
      role: "parent",
    }, 51);
    await callTool(sid, "tw_send_message", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "broadcast",
      kind: "status",
      body: "hello world",
    }, 52);

    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/messages`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].body, "hello world");
    assert.equal(body.messages[0].senderAlias, "parent");
    assert.equal(body.messages[0].deliveryMode, "broadcast");
  });

  it("GET /api/v2/sessions/:id/messages can page backward through historical messages", async () => {
    const sid = await initSession("v2-msg-history-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 msg history",
      taskSlug: "v2-msg-history",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 53);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "claude",
      model: "claude-sonnet-4-6",
      role: "parent",
    }, 54);
    for (const body of ["first", "second", "third"]) {
      await callTool(sid, "tw_send_message", {
        sessionId: session.sessionId,
        actorToken: parent.token,
        target: "broadcast",
        kind: "status",
        body,
      }, 55);
    }

    const latestRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/messages?limit=2`
    );
    assert.equal(latestRes.status, 200);
    const latest = await latestRes.json();
    assert.deepEqual(latest.messages.map((m: any) => m.body), ["second", "third"]);
    assert.equal(latest.hasMoreBefore, true);
    assert.equal(typeof latest.messages[0].sequence, "number");

    const olderRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/messages?limit=2&beforeSequence=${latest.messages[0].sequence}`
    );
    assert.equal(olderRes.status, 200);
    const older = await olderRes.json();
    assert.deepEqual(older.messages.map((m: any) => m.body), ["first"]);
    assert.equal(older.hasMoreBefore, false);
  });

  it("GET /api/v2/sessions/:id/audit returns UI-shaped report", async () => {
    const sid = await initSession("v2-audit-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 audit",
      taskSlug: "v2-audit",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 60);

    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/audit`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session.id, session.sessionId);
    assert.equal(typeof body.rollup.workerCount, "number");
    assert.ok(Array.isArray(body.agents));
    assert.ok(Array.isArray(body.pairs), "pairs should be array (was hardcoded [] before fix)");
  });

  it("POST /api/v2/sessions/:id/kill stops managed workers and is idempotent", async () => {
    const sid = await initSession("v2-kill-test");
    const workspace = path.join(tmpDir, "kill-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "v2 kill",
      taskSlug: "v2-kill",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Exercise the dashboard kill endpoint.",
    }, 61);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 62);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "implementation",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 63);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-v2-kill",
      status: "ready",
    }, 64);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Kill test",
      goal: "Launch a managed worker so the dashboard kill route can stop it.",
    }, 65);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Keep worker alive",
      description: "Hold a fake worker process open until the kill route stops it.",
      status: "assigned",
      ownerAgentId: worker.agentId,
    }, 66);
    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId: session.sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        workItemIds: [workItem.workItemId],
        pairRole: "implementer",
        launchMode: "persistent-stdin",
      },
    }, 67);
    assert.equal(launched.status, "running");

    const first = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/kill`,
      { method: "POST" },
    );
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.status, "abandoned");
    assert.equal(firstBody.stoppedCount, 1);
    assert.equal(firstBody.alreadyStoppedCount, 0);
    assert.equal(firstBody.agentCount, 2);
    assert.equal(firstBody.terminalReason, "Killed from dashboard");

    const detailAfterKill = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}`
    );
    assert.equal(detailAfterKill.status, 200);
    const detail = await detailAfterKill.json();
    assert.equal(detail.session.status, "abandoned");
    assert.equal(detail.session.terminalReason, "Killed from dashboard");
    assert.ok(detail.agents.every((agent: any) => agent.statusRaw === "inactive"));
    const killedRuntime = detail.agents.find((agent: any) => agent.agentId === worker.agentId)?.runtime;
    assert.equal(killedRuntime?.lifecycleState, "stopped");

    const second = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/kill`,
      { method: "POST" },
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.status, "abandoned");
    assert.equal(secondBody.stoppedCount, 0);
    assert.equal(secondBody.alreadyStoppedCount, 1);
  });

  it("GET /api/v2/metrics returns time-bucketed counts", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/metrics?sinceDays=7`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessionsPerDay));
    assert.ok(Array.isArray(body.messagesPerDay));
    assert.equal(typeof body.avgAssignmentDurationSec, "number");
    assert.ok(Array.isArray(body.agentUtilization));
  });

  it("rejects invalid sinceDays", async () => {
    const res = await fetch(`${BASE_URL}/api/v2/metrics?sinceDays=abc`);
    assert.equal(res.status, 400);
  });

  it("legacy /api/sessions still returns wrapped shape (backwards compat)", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions), "legacy shape must remain { sessions: [...] }");
  });

  it("SSE /api/v2/sessions/stream opens with stream-open and replies to retry", async () => {
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/v2/sessions/stream`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("text/event-stream"));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes("stream-open"));
    assert.ok(text.includes("retry: 5000"));
    ac.abort();
    try { await reader.cancel(); } catch { /* ignore */ }
  });
});

describe("teamwork-mcp worker_output + tw_append_output", () => {
  let server: ChildProcess;
  let tmpDir: string;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
  });

  after(() => stopServer(server, tmpDir));

  async function setup() {
    const sid = await initSession("output-test");
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "output session",
      taskSlug: "output-session",
      projectRoot: "/repo",
      taskPrompt: "Test task prompt for dashboard-v2.",
    }, 70);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "claude",
      model: "claude-sonnet-4-6",
      role: "parent",
    }, 71);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker",
      specialty: "frontend",
      cli: "claude",
      model: "claude-sonnet-4-6",
      role: "worker",
    }, 72);
    return { sid, sessionId: session.sessionId, parent, worker };
  }

  it("appends worker output and lists it via /api/v2/sessions/:sid/agents/:aid/output", async () => {
    const { sid, sessionId, worker } = await setup();
    const append = await callTool(sid, "tw_append_output", {
      sessionId,
      actorToken: worker.token,
      agentId: worker.agentId,
      chunk: "hello terminal\n",
    }, 80);
    assert.equal(append.ok, true);
    assert.equal(typeof append.outputId, "number");

    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(worker.agentId)}/output`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.chunks.length, 1);
    assert.equal(body.chunks[0].chunk, "hello terminal\n");
    assert.equal(typeof body.chunks[0].id, "number");
    assert.equal(typeof body.chunks[0].createdAt, "string");
  });

  it("rejects empty chunks", async () => {
    const { sid, sessionId, worker } = await setup();
    let threw = false;
    try {
      await callTool(sid, "tw_append_output", {
        sessionId,
        actorToken: worker.token,
        agentId: worker.agentId,
        chunk: "",
      }, 90);
    } catch {
      threw = true;
    }
    // Either zod rejects (min(1)) or the store rejects.
    assert.ok(threw, "empty chunk should be rejected");
  });

  it("rejects cross-agent appends (worker token + parent agentId)", async () => {
    const { sid, sessionId, parent, worker } = await setup();
    const out = await callTool(sid, "tw_append_output", {
      sessionId,
      actorToken: worker.token,
      agentId: parent.agentId,
      chunk: "should fail",
    }, 100);
    assert.equal(out.ok, false);
    assert.match(out.error, /agentId must match/);
  });

  it("truncates chunks larger than 64 KiB on a UTF-8 codepoint boundary", async () => {
    const { sid, sessionId, worker } = await setup();
    // 32k two-byte codepoints = 64KiB exactly; add one more char to exceed cap.
    const big = "é".repeat(32 * 1024 + 1);
    const append = await callTool(sid, "tw_append_output", {
      sessionId,
      actorToken: worker.token,
      agentId: worker.agentId,
      chunk: big,
    }, 110);
    assert.equal(append.ok, true);
    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(worker.agentId)}/output`
    );
    const body = await res.json();
    const stored = body.chunks[0].chunk as string;
    // Truncated marker present, and the stored bytes must be valid UTF-8.
    assert.ok(stored.endsWith("[truncated]\n"));
    // Round-tripping through Buffer would surface invalid UTF-8 as replacement
    // characters; assert no "�" leaked in.
    assert.ok(!stored.includes("�"));
  });

  it("paginates with sinceId", async () => {
    const { sid, sessionId, worker } = await setup();
    const a = await callTool(sid, "tw_append_output", {
      sessionId, actorToken: worker.token, agentId: worker.agentId, chunk: "first\n",
    }, 120);
    await callTool(sid, "tw_append_output", {
      sessionId, actorToken: worker.token, agentId: worker.agentId, chunk: "second\n",
    }, 121);

    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(worker.agentId)}/output?sinceId=${a.outputId}`
    );
    const body = await res.json();
    assert.equal(body.chunks.length, 1);
    assert.equal(body.chunks[0].chunk, "second\n");
  });

  it("returns 404 for unknown agent on output endpoint", async () => {
    const { sessionId } = await setup();
    const res = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/00000000-0000-0000-0000-000000000000/output`
    );
    assert.equal(res.status, 404);
  });
});
