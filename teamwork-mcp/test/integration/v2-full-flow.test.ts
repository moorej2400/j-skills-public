import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  callTool,
  initSession,
  startServer,
  stopServer,
} from "./_harness.js";

describe("teamwork-mcp V2 full flow", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let sid: string;

  before(async () => {
    const s = await startServer();
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
    sid = await initSession("v2-full-flow-client");
  });

  after(() => stopServer(server, tmpDir));

  it("runs a two-phase CLI-worker session through gates, reassignment, finalization, cleanup metadata, and archive hiding", async () => {
    const workspace = path.join(tmpDir, "session-workspace");
    const apiWorktree = path.join(workspace, "worktrees", "api");
    const qaWorktree = path.join(workspace, "worktrees", "qa");
    mkdirSync(apiWorktree, { recursive: true });
    mkdirSync(qaWorktree, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "V2 two-phase flow",
      taskSlug: "v2-two-phase",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Test task prompt for v2-full-flow.",
    }, 200);
    const sessionId = session.sessionId;
    let registeredWorktreeId = "";

    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 201);
    const apiA = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "api-a",
      specialty: "api",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    }, 202);
    const apiB = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "api-b",
      specialty: "api",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    }, 203);

    const registeredWorktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: apiA.agentId,
      path: apiWorktree,
      branch: "tw-api",
      status: "ready",
    }, 204);
    registeredWorktreeId = registeredWorktree.worktreeId;
    const runtimeA = await callTool(sid, "tw_register_runtime", {
      sessionId,
      actorToken: apiA.token,
      agentId: apiA.agentId,
      pid: 8101,
      transport: "codex-cli",
      heartbeatIntervalSeconds: 60,
    }, 205);
    const runtimeB = await callTool(sid, "tw_register_runtime", {
      sessionId,
      actorToken: apiB.token,
      agentId: apiB.agentId,
      pid: 8102,
      transport: "codex-cli",
      heartbeatIntervalSeconds: 60,
    }, 206);
    assert.equal((await callTool(sid, "tw_heartbeat_runtime", {
      sessionId,
      actorToken: apiA.token,
      runtimeId: runtimeA.runtimeId,
    }, 207)).status, "running");

    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Build API contract",
      goal: "Pair on one API contract work item.",
    }, 208);
    const phaseOneWork = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Build contract",
      description: "Implement and verify the shared API contract.",
      status: "assigned",
      assigneeAgentIds: [apiA.agentId, apiB.agentId],
      primaryAssigneeAgentId: apiA.agentId,
    }, 209);
    await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: apiA.token,
      workItemId: phaseOneWork.workItemId,
    }, 210);
    await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: apiB.token,
      workItemId: phaseOneWork.workItemId,
    }, 2101);
    const question = await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: apiA.token,
      target: "agent",
      targetAgentId: apiB.agentId,
      kind: "question",
      body: "Please confirm the response shape before I wire the handler.",
      requiresResponse: true,
      obligationKind: "answer",
      dueStage: "phase",
      relatedWorkItemId: phaseOneWork.workItemId,
    }, 211);
    const answer = await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: apiB.token,
      target: "agent",
      targetAgentId: apiA.agentId,
      kind: "answer",
      body: "Use id, name, and updatedAt.",
      replyToMessageId: question.messageId,
    }, 212);
    await callTool(sid, "tw_ack_messages", {
      sessionId,
      actorToken: apiB.token,
      upToSequence: question.sequence,
    }, 213);
    await callTool(sid, "tw_ack_messages", {
      sessionId,
      actorToken: apiA.token,
      upToSequence: answer.sequence,
    }, 214);
    await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: apiA.token,
      workItemId: phaseOneWork.workItemId,
      resultType: "commit",
      summary: "API contract implemented.",
      commitSha: "1111111",
      verificationSummary: "contract unit tests passed",
    }, 215);
    await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: apiB.token,
      workItemId: phaseOneWork.workItemId,
      resultType: "test-report",
      summary: "Pair review complete.",
      commitSha: "2222222",
      verificationSummary: "review and smoke tests passed",
    }, 216);
    assert.equal((await callTool(sid, "tw_begin_integration", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    }, 217)).lifecycleStage, "integrating");
    await callTool(sid, "tw_record_integration_event", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      sourceBranch: "tw-api",
      targetBranch: "main",
      commitSha: "aaaaaaa",
    }, 218);
    assert.equal((await callTool(sid, "tw_complete_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "API contract merged.",
    }, 219)).lifecycleStage, "planning");

    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 2,
      title: "Verification repair",
      goal: "Reassign a blocked follow-up and integrate it.",
    }, 220);
    const phaseTwoWork = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 2,
      title: "Add verification repair",
      description: "Close the follow-up verification issue.",
      status: "assigned",
      ownerAgentId: apiA.agentId,
    }, 221);
    await callTool(sid, "tw_update_work_item_status", {
      sessionId,
      actorToken: apiA.token,
      workItemId: phaseTwoWork.workItemId,
      status: "blocked",
      note: "Local test environment failed.",
    }, 222);
    await callTool(sid, "tw_reassign_work_item", {
      sessionId,
      actorToken: parent.token,
      workItemId: phaseTwoWork.workItemId,
      assigneeAgentIds: [apiB.agentId],
      primaryAssigneeAgentId: apiB.agentId,
      reason: "Worker A hit an environment blocker.",
    }, 223);
    await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: apiB.token,
      workItemId: phaseTwoWork.workItemId,
    }, 2231);
    await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: apiB.token,
      workItemId: phaseTwoWork.workItemId,
      resultType: "commit",
      summary: "Verification repair complete.",
      commitSha: "3333333",
      verificationSummary: "targeted verification passed",
    }, 224);
    await callTool(sid, "tw_begin_integration", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 2,
    }, 225);
    await callTool(sid, "tw_record_integration_event", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 2,
      kind: "cherry-pick",
      sourceBranch: "tw-api",
      targetBranch: "main",
      commitSha: "bbbbbbb",
    }, 226);
    await callTool(sid, "tw_complete_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 2,
      summary: "Verification repair merged.",
    }, 227);

    await callTool(sid, "tw_begin_finalizing", {
      sessionId,
      actorToken: parent.token,
    }, 228);
    await callTool(sid, "tw_update_runtime", {
      sessionId,
      actorToken: parent.token,
      runtimeId: runtimeA.runtimeId,
      status: "exited",
      exitCode: 0,
    }, 229);
    await callTool(sid, "tw_update_runtime", {
      sessionId,
      actorToken: parent.token,
      runtimeId: runtimeB.runtimeId,
      status: "exited",
      exitCode: 0,
    }, 230);
    rmSync(apiWorktree, { recursive: true, force: true });
    await callTool(sid, "tw_update_worktree", {
      sessionId,
      actorToken: parent.token,
      worktreeId: registeredWorktreeId,
      status: "removed",
    }, 2301);
    const completed = await callTool(sid, "tw_complete_session", {
      sessionId,
      actorToken: parent.token,
      summary: "Two phases integrated and finalized.",
    }, 231);
    assert.equal(completed.status, "completed");
    assert.equal(existsSync(path.join(workspace, "audit-report.md")), true);

    const report = await callTool(sid, "tw_get_audit_report", { sessionId }, 232);
    assert.equal(report.timeline.phaseBoundaries.length, 2);
    assert.equal(report.rollup.resultCount, 3);
    assert.equal(report.rollup.invalidToolCallCount, 0);
    assert.equal(report.rollup.cleanupFailureCount, 0);
    assert.ok("resultToIntegrationDelaySeconds" in report.timeline.phaseBoundaries[0]);
    assert.equal(report.exports.missingSessionExports.length, 0);

    const visibleBeforeArchive = await fetch(`${BASE_URL}/api/sessions?include=completed`);
    const beforeJson = await visibleBeforeArchive.json() as any;
    assert.equal(beforeJson.sessions.some((entry: any) => entry.sessionId === sessionId), true);

    await callTool(sid, "tw_archive_session", {
      sessionId,
      actorToken: parent.token,
      reason: "E2E test archived terminal session.",
    }, 233);
    const defaultDashboard = await fetch(`${BASE_URL}/api/sessions`);
    const defaultJson = await defaultDashboard.json() as any;
    assert.equal(defaultJson.sessions.some((entry: any) => entry.sessionId === sessionId), false);
  });
});
