import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";

import {
  TEST_PORT,
  callTool,
  createGitWorktreeFixture,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

describe("teamwork-mcp all tools integration", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let sid: string;

  // Shared state across ordered tests
  let sessionId: string;
  let parentToken: string;
  let parentAgentId: string;
  let workerToken: string;
  let workerAgentId: string;
  let workItemAId: string;
  let workItemBId: string;
  let msgSequence: number;
  let resultId: string;
  let worktreeId: string;
  let runtimeId: string;
  let fixture: ReturnType<typeof createGitWorktreeFixture>;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
    sid = await initSession("all-tools-client");
    fixture = createGitWorktreeFixture();
  });

  after(() => {
    stopServer(server, tmpDir);
    fixture.cleanup();
  });

  // ── tw_get_dashboard_url ─────────────────────────────────────
  it("tw_get_dashboard_url returns a valid URL", async () => {
    const result = await callTool(sid, "tw_get_dashboard_url", {}, 100);
    assert.ok(result.url, "should return url field");
    assert.ok(result.url.startsWith("http://"), `expected http:// URL, got ${result.url}`);
    assert.ok(result.url.includes(String(TEST_PORT)));
  });

  it("tw_list_debug_events records redacted MCP tool calls", async () => {
    const result = await callTool(sid, "tw_list_debug_events", { limit: 20 }, 1001);
    assert.ok(result.events.length > 0);
    const dashboardCall = result.events.find((entry: any) => entry.toolName === "tw_get_dashboard_url");
    assert.ok(dashboardCall);
    assert.equal(dashboardCall.eventType, "tool_result");
  });

  // ── tw_create_session ────────────────────────────────────────
  it("tw_create_session creates a new session", async () => {
    const result = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "All-tools test session",
      taskSlug: "all-tools",
      projectRoot: fixture.repoRoot,
      sessionWorkspacePath: fixture.rootDir,
      taskPrompt: "Exercise every teamwork MCP tool in a deterministic integration flow.",
    }, 101);
    assert.ok(result.sessionId, "should return sessionId");
    assert.equal(result.status, "active");
    sessionId = result.sessionId;
  });

  // ── tw_register_agent (parent) ───────────────────────────────
  it("tw_register_agent registers a parent agent", async () => {
    const result = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      responsibility: "Own orchestration, phase decisions, and integration.",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 102);
    assert.ok(result.agentId);
    assert.ok(result.token);
    assert.equal(result.alias, "parent");
    assert.equal(result.role, "parent");
    parentAgentId = result.agentId;
    parentToken = result.token;
  });

  // ── tw_register_agent (worker) ───────────────────────────────
  it("tw_register_agent registers a worker agent", async () => {
    const result = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "frontend",
      specialty: "frontend",
      responsibility: "Own frontend implementation and answer UI integration questions.",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    }, 103);
    assert.ok(result.agentId);
    assert.ok(result.token);
    assert.equal(result.alias, "frontend");
    assert.equal(result.responsibility, "Own frontend implementation and answer UI integration questions.");
    assert.equal(result.role, "worker");
    workerAgentId = result.agentId;
    workerToken = result.token;
  });

  // ── tw_get_session_state ─────────────────────────────────────
  it("tw_get_session_state returns full session summary", async () => {
    const result = await callTool(sid, "tw_get_session_state", { sessionId }, 104);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.title, "All-tools test session");
    assert.equal(result.taskSlug, "all-tools");
    assert.equal(result.projectRoot, fixture.repoRoot);
    assert.equal(result.status, "active");
    assert.equal(result.agents.length, 2);
    assert.equal(
      result.agents.find((a: any) => a.alias === "frontend")?.responsibility,
      "Own frontend implementation and answer UI integration questions."
    );
    const roles = result.agents.map((a: any) => a.role).sort();
    assert.deepEqual(roles, ["parent", "worker"]);
  });

  it("tw_list_agents returns the roster with responsibilities", async () => {
    const result = await callTool(sid, "teamwork", {
      tool_name: "list_agents",
      options: { sessionId },
    }, 1041);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.agents.length, 2);
    const frontend = result.agents.find((a: any) => a.alias === "frontend");
    assert.equal(frontend.agentId, workerAgentId);
    assert.equal(frontend.specialty, "frontend");
    assert.equal(frontend.responsibility, "Own frontend implementation and answer UI integration questions.");
  });

  // ── tw_start_phase ───────────────────────────────────────────
  it("tw_start_phase starts phase 1", async () => {
    const result = await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      title: "Foundation",
      goal: "Build core data models and API endpoints",
    }, 105);
    assert.equal(result.currentPhase.phaseNumber, 1);
    assert.equal(result.currentPhase.title, "Foundation");
    assert.equal(result.currentPhase.goal, "Build core data models and API endpoints");
  });

  // ── tw_upsert_work_item (create item A) ──────────────────────
  it("tw_upsert_work_item creates a work item", async () => {
    const result = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      title: "Create user model",
      description: "Define User schema with validation",
      acceptanceCriteria: "Unit tests pass for User model",
      ownerAgentId: workerAgentId,
      status: "assigned",
    }, 106);
    assert.ok(result.workItemId, "should return workItemId");
    workItemAId = result.workItemId;
  });

  // ── tw_upsert_work_item (create item B with dependency) ──────
  it("tw_upsert_work_item creates a dependent work item", async () => {
    const result = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      title: "Build user form",
      description: "Create React form bound to user model API",
      acceptanceCriteria: "Component renders and submits correctly",
      ownerAgentId: workerAgentId,
      status: "planned",
      dependsOnIds: [workItemAId],
    }, 107);
    assert.ok(result.workItemId);
    workItemBId = result.workItemId;
  });

  // ── tw_list_work_items (all items) ───────────────────────────
  it("tw_list_work_items lists all work items in session", async () => {
    const result = await callTool(sid, "tw_list_work_items", { sessionId }, 108);
    assert.equal(result.workItems.length, 2);
    const titles = result.workItems.map((w: any) => w.title);
    assert.ok(titles.includes("Create user model"));
    assert.ok(titles.includes("Build user form"));
  });

  // ── tw_list_work_items (filter by phase) ─────────────────────
  it("tw_list_work_items filters by phase number", async () => {
    const result = await callTool(sid, "tw_list_work_items", {
      sessionId,
      phaseNumber: 1,
    }, 109);
    assert.equal(result.workItems.length, 2);

    // Phase 99 should return empty
    const empty = await callTool(sid, "tw_list_work_items", {
      sessionId,
      phaseNumber: 99,
    }, 110);
    assert.equal(empty.workItems.length, 0);
  });

  // ── tw_upsert_work_item (update existing) ────────────────────
  it("tw_upsert_work_item updates an existing work item", async () => {
    const result = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parentToken,
      workItemId: workItemAId,
      phaseNumber: 1,
      title: "Create user model (updated)",
      description: "Define User schema with zod validation",
      acceptanceCriteria: "All unit tests pass",
      ownerAgentId: workerAgentId,
      status: "assigned",
    }, 111);
    assert.equal(result.workItemId, workItemAId);

    // Verify the update took effect
    const items = await callTool(sid, "tw_list_work_items", { sessionId, phaseNumber: 1 }, 112);
    const updated = items.workItems.find((w: any) => w.workItemId === workItemAId);
    assert.equal(updated.title, "Create user model (updated)");
    assert.equal(updated.status, "assigned");
  });

  // ── tw_send_message (broadcast) ──────────────────────────────
  it("tw_send_message sends a broadcast message", async () => {
    const result = await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: parentToken,
      target: "broadcast",
      kind: "status",
      body: "Phase 1 work has been assigned.",
    }, 113);
    assert.ok(result.messageId);
    assert.ok(result.sequence >= 1);
    msgSequence = result.sequence;
  });

  // ── tw_send_message (DM) ─────────────────────────────────────
  it("tw_send_message sends a direct message", async () => {
    const result = await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: parentToken,
      target: "agent",
      targetAgentId: workerAgentId,
      kind: "question",
      body: "How is the user model progressing?",
      relatedWorkItemId: workItemAId,
    }, 114);
    assert.ok(result.messageId);
    assert.ok(result.sequence > msgSequence);
    msgSequence = result.sequence;
  });

  // ── tw_list_messages ─────────────────────────────────────────
  it("tw_list_messages returns messages after a sequence", async () => {
    // Worker should see both: broadcast + DM targeted to them
    const workerInbox = await callTool(sid, "tw_list_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 0,
    }, 115);
    assert.equal(workerInbox.messages.length, 2);
    assert.equal(workerInbox.messages[0].body, "Phase 1 work has been assigned.");
    assert.equal(workerInbox.messages[1].body, "How is the user model progressing?");

    const limited = await callTool(sid, "tw_list_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 0,
      limit: 1,
    }, 1151);
    assert.equal(limited.messages.length, 1);
    assert.equal(limited.messages[0].body, "Phase 1 work has been assigned.");

    // After sequence of first message, only the DM should appear
    const partial = await callTool(sid, "tw_list_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: workerInbox.messages[0].sequence,
    }, 116);
    assert.equal(partial.messages.length, 1);
    assert.equal(partial.messages[0].body, "How is the user model progressing?");
  });

  it("tw_wait_for_messages returns immediately when visible messages already exist", async () => {
    const result = await callTool(sid, "tw_wait_for_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 0,
      waitMs: 10,
    }, 1161);
    assert.equal(result.timedOut, false);
    assert.equal(result.messages.length, 2);

    const aliasResult = await callTool(sid, "tw_wait_for_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 9999,
      waitSeconds: 0,
    }, 1162);
    assert.equal(aliasResult.timedOut, true);
    assert.equal(aliasResult.messages.length, 0);
  });

  // ── tw_ack_messages ──────────────────────────────────────────
  it("tw_ack_messages acknowledges messages by message ID", async () => {
    const inbox = await callTool(sid, "tw_list_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 0,
    }, 1163);
    const dm = inbox.messages.find((message: any) => message.body === "How is the user model progressing?");
    assert.ok(dm);
    const result = await callTool(sid, "tw_ack_messages", {
      sessionId,
      actorToken: workerToken,
      messageIds: [dm.messageId],
    }, 117);
    assert.deepEqual(result, { ok: true });

    // Verify via session state that lastAckSequence was updated
    const state = await callTool(sid, "tw_get_session_state", { sessionId }, 118);
    const workerState = state.agents.find((a: any) => a.agentId === workerAgentId);
    assert.equal(workerState.lastAckSequence, msgSequence);
  });

  // ── tw_set_agent_status (self) ───────────────────────────────
  it("tw_set_agent_status changes worker status to blocked", async () => {
    const result = await callTool(sid, "tw_set_agent_status", {
      sessionId,
      actorToken: workerToken,
      status: "blocked",
      note: "Waiting on API contract",
    }, 119);
    assert.deepEqual(result, { ok: true });

    const state = await callTool(sid, "tw_get_session_state", { sessionId }, 120);
    const workerState = state.agents.find((a: any) => a.agentId === workerAgentId);
    assert.equal(workerState.status, "blocked");
    assert.equal(workerState.statusNote, "Waiting on API contract");
  });

  // ── tw_set_agent_status (parent updating worker) ─────────────
  it("tw_set_agent_status allows parent to set worker status to idle standby", async () => {
    const result = await callTool(sid, "tw_set_agent_status", {
      sessionId,
      actorToken: parentToken,
      status: "idle",
      note: "Current slice complete; stay available for specialist questions.",
      targetAgentId: workerAgentId,
    }, 121);
    assert.deepEqual(result, { ok: true });

    const state = await callTool(sid, "tw_get_session_state", { sessionId }, 122);
    const workerState = state.agents.find((a: any) => a.agentId === workerAgentId);
    assert.equal(workerState.status, "idle");
  });

  // ── tw_register_worktree ───────────────────────────────────────
  it("tw_register_worktree stores a worker worktree record", async () => {
    const result = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parentToken,
      agentId: workerAgentId,
      path: fixture.featureWorktree,
      branch: "worker-a",
      baseCommit: "HEAD",
      status: "ready",
    }, 122);
    assert.ok(result.worktreeId);
    assert.equal(result.status, "ready");
    worktreeId = result.worktreeId;
  });

  // ── tw_update_worktree / tw_list_worktrees ────────────────────
  it("tw_update_worktree and tw_list_worktrees expose tracked worktrees", async () => {
    const updated = await callTool(sid, "tw_update_worktree", {
      sessionId,
      actorToken: workerToken,
      worktreeId,
      status: "dirty",
    }, 123);
    assert.deepEqual(updated, { worktreeId, ok: true });

    const listed = await callTool(sid, "tw_list_worktrees", {
      sessionId,
      agentId: workerAgentId,
    }, 124);
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0].worktreeId, worktreeId);
    assert.equal(listed.worktrees[0].status, "dirty");

    const listedWithIgnoredActorToken = await callTool(sid, "teamwork", {
      tool_name: "list_worktrees",
      options: {
        sessionId,
        actorToken: parentToken,
        agentId: workerAgentId,
      },
    }, 1241);
    assert.equal(listedWithIgnoredActorToken.worktrees.length, 1);
  });

  // ── tw_register_runtime / tw_update_runtime / tw_list_runtimes ─
  it("runtime tools keep an idle worker runtime alive until teardown", async () => {
    const registered = await callTool(sid, "tw_register_runtime", {
      sessionId,
      actorToken: workerToken,
      agentId: workerAgentId,
      pid: 4242,
      transport: "copilot-cli",
    }, 125);
    assert.ok(registered.runtimeId);
    assert.equal(registered.status, "running");
    runtimeId = registered.runtimeId;

    const listed = await callTool(sid, "tw_list_runtimes", {
      sessionId,
      agentId: workerAgentId,
    }, 126);
    assert.equal(listed.runtimes.length, 1);
    assert.equal(listed.runtimes[0].runtimeId, runtimeId);
    assert.equal(listed.runtimes[0].status, "running");

    const followup = await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: parentToken,
      target: "agent",
      targetAgentId: workerAgentId,
      kind: "question",
      body: "You are idle now; can you confirm the final payload shape?",
    }, 127);
    assert.ok(followup.sequence > msgSequence);
    msgSequence = followup.sequence;

    const inbox = await callTool(sid, "tw_list_messages", {
      sessionId,
      actorToken: workerToken,
      afterSequence: 2,
    }, 128);
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].body, "You are idle now; can you confirm the final payload shape?");
  });

  // ── tw_inspect_worktree ───────────────────────────────────────
  it("tw_inspect_worktree inspects a real git worktree", async () => {
    const result = await callTool(sid, "tw_inspect_worktree", {
      sessionId,
      worktreeId,
    }, 129);
    assert.equal(result.path, fixture.featureWorktree);
    assert.equal(result.branch, "worker-a");
    assert.equal(result.status, "dirty");
    assert.equal(result.dirty, true);
    assert.ok(typeof result.headCommit === "string" && result.headCommit.length > 0);
  });

  // ── tw_record_result / tw_list_results ────────────────────────
  it("tw_record_result and tw_list_results capture worker handoff details", async () => {
    const claim = await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: workerToken,
      workItemId: workItemAId,
      note: "Starting user model verification.",
    }, 129);
    assert.equal(claim.workItemId, workItemAId);

    const recorded = await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: workerToken,
      workItemId: workItemAId,
      resultType: "test-report",
      summary: "User model implemented and verified in worker worktree.",
      data: "3 targeted integration checks passed",
    }, 130);
    assert.ok(recorded.resultId);
    resultId = recorded.resultId;

    const listed = await callTool(sid, "tw_list_results", {
      sessionId,
      workItemId: workItemAId,
    }, 131);
    assert.equal(listed.results.length, 1);
    assert.equal(listed.results[0].resultId, resultId);
    assert.equal(listed.results[0].agentAlias, "frontend");
    assert.equal(listed.results[0].resultType, "test-report");
    assert.equal(listed.synthesis.resultCount, 1);

    await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: parentToken,
      workItemId: workItemAId,
      resultType: "note",
      summary: "User model implemented and verified in worker worktree via parent fallback capture.",
      data: "Parent-visible fallback result for duplicate clustering.",
    }, 1311);
    const synthesized = await callTool(sid, "tw_list_results", {
      sessionId,
      workItemId: workItemAId,
    }, 1312);
    assert.equal(synthesized.synthesis.resultCount, 2);
    assert.ok(synthesized.synthesis.likelyDuplicateClusters.length >= 1);
  });

  it("tw_update_work_item_status closes deferred work before integration", async () => {
    const result = await callTool(sid, "tw_update_work_item_status", {
      sessionId,
      actorToken: parentToken,
      workItemId: workItemBId,
      status: "canceled",
      note: "Deferred dependent form work outside this phase.",
    }, 1311);
    assert.equal(result.status, "canceled");
  });

  it("tw_ack_messages acknowledges the final phase-boundary DM", async () => {
    const result = await callTool(sid, "tw_ack_messages", {
      sessionId,
      actorToken: workerToken,
      upToSequence: msgSequence,
    }, 1312);
    assert.deepEqual(result, { ok: true });
  });

  // ── tw_record_integration_event / tw_list_integration_events ──
  it("integration event tools record parent-led merge flow", async () => {
    const recorded = await callTool(sid, "tw_record_integration_event", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      kind: "cherry-pick",
      sourceBranch: "worker-a",
      targetBranch: "main",
      commitSha: "abc1234",
      details: "Picked the frontend worker commit into main",
    }, 132);
    assert.ok(recorded.eventId);

    const listed = await callTool(sid, "tw_list_integration_events", {
      sessionId,
      phaseNumber: 1,
    }, 133);
    assert.equal(listed.events.length, 1);
    assert.equal(listed.events[0].kind, "cherry-pick");
    assert.equal(listed.events[0].agentAlias, "parent");
  });

  it("tw_begin_integration moves the phase into integration after work is closed", async () => {
    const result = await callTool(sid, "tw_begin_integration", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
    }, 1331);
    assert.equal(result.lifecycleStage, "integrating");
  });

  // ── tw_create_checkpoint / tw_list_checkpoints ────────────────
  it("checkpoint tools capture a parent-owned phase snapshot", async () => {
    const created = await callTool(sid, "tw_create_checkpoint", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      kind: "manual",
      label: "before-merge",
    }, 134);
    assert.ok(created.checkpointId);

    const listed = await callTool(sid, "tw_list_checkpoints", {
      sessionId,
      phaseNumber: 1,
    }, 135);
    assert.equal(listed.checkpoints.length, 1);
    assert.equal(listed.checkpoints[0].label, "before-merge");
    assert.equal(listed.checkpoints[0].kind, "manual");
    assert.equal(listed.checkpoints[0].snapshot.session.sessionId, sessionId);
  });

  // ── tw_get_audit_report ──────────────────────────────────────
  it("tw_get_audit_report summarizes traffic and lifecycle metrics", async () => {
    const report = await callTool(sid, "tw_get_audit_report", {
      sessionId,
    }, 136);
    assert.equal(report.session.sessionId, sessionId);
    assert.equal(report.rollup.workerCount, 1);
    assert.equal(report.rollup.messageCount, 3);
    assert.equal(report.rollup.directMessageCount, 2);
    assert.equal(report.rollup.activeRuntimeCount, 1);
    assert.equal(report.rollup.resultCount, 2);
    const frontend = report.agents.find((agent: any) => agent.alias === "frontend");
    assert.equal(frontend.currentStatus, "idle");
    assert.equal(frontend.messagesSentCount, 0);
    assert.equal(frontend.messagesReceivedCount, 3);
    assert.equal(frontend.runtimeCount, 1);
    assert.equal(report.pairs.length, 0);
  });

  // ── tw_complete_phase ────────────────────────────────────────
  it("tw_complete_phase completes phase 1", async () => {
    const result = await callTool(sid, "tw_complete_phase", {
      sessionId,
      actorToken: parentToken,
      phaseNumber: 1,
      summary: "Foundation phase complete: models and forms built.",
    }, 137);
    // tw_complete_phase returns session summary
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.status, "active");
  });

  // ── tw_update_runtime (final teardown) ───────────────────────
  it("tw_update_runtime exits the worker runtime during final teardown", async () => {
    const updated = await callTool(sid, "tw_update_runtime", {
      sessionId,
      actorToken: workerToken,
      runtimeId,
      status: "exited",
      exitCode: 0,
    }, 138);
    assert.deepEqual(updated, { runtimeId, ok: true });

    const listed = await callTool(sid, "tw_list_runtimes", {
      sessionId,
      agentId: workerAgentId,
    }, 139);
    assert.equal(listed.runtimes.length, 1);
    assert.equal(listed.runtimes[0].status, "exited");
  });

  it("tw_cleanup_worktree marks the worker worktree removed after filesystem cleanup", async () => {
    const updated = await callTool(sid, "teamwork", {
      tool_name: "cleanup_worktree",
      options: {
        sessionId,
        actorToken: parentToken,
        worktreeId,
      },
    }, 1392);
    assert.equal(updated.worktreeId, worktreeId);
    assert.equal(updated.status, "removed");
  });

  // ── tw_complete_session ──────────────────────────────────────
  it("tw_complete_session completes the session after runtime teardown", async () => {
    const finalizing = await callTool(sid, "tw_begin_finalizing", {
      sessionId,
      actorToken: parentToken,
    }, 1391);
    assert.equal(finalizing.lifecycleStage, "finalizing");

    const result = await callTool(sid, "tw_complete_session", {
      sessionId,
      actorToken: parentToken,
      summary: "All phases completed. Merged to main.",
    }, 140);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.status, "completed");
  });

  it("tw_list_debug_events includes automatic observability events", async () => {
    await callTool(sid, "tw_run_janitor", {
      ttlHours: 24,
      worktreeGc: false,
    }, 1401);

    const result = await callTool(sid, "tw_list_debug_events", {
      sessionId,
      limit: 1000,
    }, 1402);
    const eventTypes = new Set(result.events.map((entry: any) => entry.eventType));
    for (const eventType of [
      "lifecycle_transition",
      "work_item_changed",
      "message_ack",
      "message_ack_gate",
      "worktree_changed",
      "worktree_cleanup",
      "worker_result_recorded",
      "integration_event_recorded",
      "closeout_evaluation",
    ]) {
      assert.ok(eventTypes.has(eventType), `missing debug event type ${eventType}`);
    }

    const globalEvents = await callTool(sid, "tw_list_debug_events", {
      limit: 1000,
    }, 1403);
    assert.ok(globalEvents.events.some((entry: any) => entry.eventType === "janitor_activity"));
  });
});
