import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";

import {
  callTool,
  createGitWorktreeFixture,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

describe("teamwork-mcp multi-client", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let sidA: string;
  let sidB: string;
  let fixture: ReturnType<typeof createGitWorktreeFixture>;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
    sidA = await initSession("client-a");
    sidB = await initSession("client-b");
    fixture = createGitWorktreeFixture();
  });

  after(() => {
    stopServer(server, tmpDir);
    fixture.cleanup();
  });

  it("Client B sees session created by Client A via tw_get_session_state", async () => {
    const created = await callTool(sidA, "tw_create_session", {
      parentAlias: "parent-a",
      title: "Multi-client test",
      taskSlug: "multi-client",
      projectRoot: "/tmp/multi",
    }, 20);
    assert.ok(created.sessionId, "should return sessionId");

    const state = await callTool(sidB, "tw_get_session_state", {
      sessionId: created.sessionId,
    }, 21);
    assert.equal(state.title, "Multi-client test");
    assert.equal(state.status, "active");
  });

  it("Client A registers parent, Client B registers worker — both visible in state", async () => {
    const session = await callTool(sidA, "tw_create_session", {
      parentAlias: "orchestrator",
      title: "Agent registration test",
      taskSlug: "agent-reg",
      projectRoot: "/tmp/reg",
    }, 30);

    const parent = await callTool(sidA, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "orchestrator",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 31);
    assert.equal(parent.role, "parent");

    const worker = await callTool(sidB, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "frontend",
      specialty: "frontend",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    }, 32);
    assert.equal(worker.role, "worker");

    const state = await callTool(sidA, "tw_get_session_state", {
      sessionId: session.sessionId,
    }, 33);
    assert.equal(state.agents.length, 2);
    const aliases = state.agents.map((a: any) => a.alias).sort();
    assert.deepEqual(aliases, ["frontend", "orchestrator"]);
  });

  it("Client A (parent) starts phase, Client B sees phase state", async () => {
    const session = await callTool(sidA, "tw_create_session", {
      parentAlias: "parent",
      title: "Phase visibility test",
      taskSlug: "phase-vis",
      projectRoot: "/tmp/vis",
    }, 40);

    const parent = await callTool(sidA, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 41);

    await callTool(sidA, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Scaffold",
      goal: "Set up project skeleton",
    }, 42);

    const state = await callTool(sidB, "tw_get_session_state", {
      sessionId: session.sessionId,
    }, 43);
    assert.equal(state.currentPhase.phaseNumber, 1);
    assert.equal(state.currentPhase.title, "Scaffold");
    assert.equal(state.currentPhase.goal, "Set up project skeleton");
  });

  it("cross-client messaging: A broadcasts, B receives via tw_list_messages", async () => {
    const session = await callTool(sidA, "tw_create_session", {
      parentAlias: "parent",
      title: "Messaging test",
      taskSlug: "msg-test",
      projectRoot: "/tmp/msg",
    }, 50);

    const parent = await callTool(sidA, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 51);

    const worker = await callTool(sidB, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-b",
      specialty: "backend",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    }, 52);

    const sent = await callTool(sidA, "tw_send_message", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "broadcast",
      kind: "status",
      body: "Phase 1 is starting now.",
    }, 53);
    assert.ok(sent.messageId);
    assert.ok(sent.sequence >= 1);

    const inbox = await callTool(sidB, "tw_list_messages", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      afterSequence: 0,
    }, 54);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].body, "Phase 1 is starting now.");
    assert.equal(inbox.messages[0].target, "broadcast");
  });

  it("cross-client worktree, runtime, result, and checkpoint flows stay visible", async () => {
    const session = await callTool(sidA, "tw_create_session", {
      parentAlias: "parent",
      title: "Runtime visibility test",
      taskSlug: "runtime-vis",
      projectRoot: fixture.repoRoot,
    }, 60);

    const parent = await callTool(sidA, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 61);

    const worker = await callTool(sidB, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-b",
      specialty: "backend",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    }, 62);

    await callTool(sidA, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Runtime setup",
      goal: "Seed runtime and inspect the linked worktree",
    }, 63);

    const worktree = await callTool(sidA, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: fixture.featureWorktree,
      branch: "worker-a",
      baseCommit: "HEAD",
      status: "ready",
    }, 64);
    assert.ok(worktree.worktreeId);

    const runtime = await callTool(sidB, "tw_register_runtime", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      agentId: worker.agentId,
      pid: 3001,
      transport: "copilot-cli",
    }, 65);
    assert.ok(runtime.runtimeId);

    const worktreeState = await callTool(sidA, "tw_inspect_worktree", {
      sessionId: session.sessionId,
      worktreeId: worktree.worktreeId,
    }, 66);
    assert.equal(worktreeState.branch, "worker-a");
    assert.equal(worktreeState.dirty, true);

    const result = await callTool(sidB, "tw_record_result", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      workItemId: await (async () => {
        const item = await callTool(sidA, "tw_upsert_work_item", {
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          title: "Implement runtime wiring",
          description: "Wire the runtime helpers into the server flow.",
          ownerAgentId: worker.agentId,
          status: "assigned",
        }, 67);
        return item.workItemId;
      })(),
      resultType: "note",
      summary: "Worker recorded runtime wiring progress.",
      data: "ready for parent review",
    }, 68);
    assert.ok(result.resultId);

    const checkpoints = await callTool(sidA, "tw_create_checkpoint", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "manual",
      label: "runtime-visible",
    }, 69);
    assert.ok(checkpoints.checkpointId);

    const listed = await callTool(sidA, "tw_list_results", {
      sessionId: session.sessionId,
    }, 70);
    assert.equal(listed.results.length, 1);
  });
});
