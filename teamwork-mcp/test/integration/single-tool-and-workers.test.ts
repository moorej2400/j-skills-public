import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  callTool,
  createFakeCliFixture,
  createNamedCliFixture,
  initSession,
  listTools,
  startServer,
  stopServer,
} from "./_harness.js";

describe("teamwork-mcp single tool API and server-managed workers", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let sid: string;
  let fakeCli: ReturnType<typeof createFakeCliFixture>;

  before(async () => {
    fakeCli = createFakeCliFixture();
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
    });
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
    sid = await initSession("single-tool-workers-client");
  });

  after(() => {
    stopServer(server, tmpDir);
    fakeCli.cleanup();
  });

  it("exposes one documented MCP tool with runtime help", async () => {
    const tools = await listTools(sid);
    assert.deepEqual(tools.map((tool: any) => tool.name), ["teamwork"]);
    assert.match(tools[0].description, /tool_name/);
    assert.match(tools[0].description, /help/);

    const help = await callTool(sid, "teamwork", { tool_name: "help", options: {} }, 301);
    assert.ok(help.operations.includes("create_session"));
    assert.ok(help.operations.includes("get_session_resume_packet"));
    assert.ok(help.operations.includes("plan_launch"));
    assert.ok(help.operations.includes("launch_worker"));
    assert.ok(help.operations.includes("parent_poll_baseline"));
    assert.ok(help.operations.includes("parent_poll"));
    assert.equal("examples" in help, false);

    const launchHelp = await callTool(
      sid,
      "teamwork",
      { tool_name: "help", options: { topic: "launch_worker" } },
      302
    );
    assert.equal(launchHelp.operation, "launch_worker");
    assert.ok(launchHelp.required.includes("sessionId"));
    assert.ok(launchHelp.required.includes("agentId"));
    assert.equal(launchHelp.schema.worktreeId.type, "string");
    assert.equal(launchHelp.schema.phaseNumber.type, "number");

    const resultHelp = await callTool(
      sid,
      "teamwork",
      { tool_name: "help", options: { topic: "record_result" } },
      3021
    );
    assert.match(resultHelp.schema.resultType.type, /"commit"/);
    assert.match(resultHelp.schema.data.type, /string/);
    assert.match(resultHelp.schema.data.type, /object/);

    const claimHelp = await callTool(
      sid,
      "teamwork",
      { tool_name: "help", options: { topic: "claim_work_item" } },
      30211
    );
    assert.equal(claimHelp.operation, "claim_work_item");
    assert.ok(claimHelp.required.includes("workItemId"));

    const createHelp = await callTool(
      sid,
      "teamwork",
      { tool_name: "help", options: { topic: "create_session" } },
      3022
    );
    assert.ok(createHelp.required.includes("taskPrompt"));

    const planHelp = await callTool(
      sid,
      "teamwork",
      { tool_name: "help", options: { topic: "plan_launch" } },
      3023
    );
    assert.equal(planHelp.operation, "plan_launch");
    assert.ok(planHelp.optional.includes("reasoningEffort"));
    assert.ok(planHelp.optional.includes("reasoningEffortOverrides"));

    await assert.rejects(
      () => callTool(sid, "teamwork", { tool_name: "missing_operation", options: {} }, 3030),
      /Unknown teamwork operation/
    );
    await assert.rejects(
      () => callTool(sid, "teamwork", { tool_name: "create_session", options: { title: "Missing fields" } }, 3031),
      /Invalid options for create_session/
    );
    await assert.rejects(
      () => callTool(sid, "teamwork", {
        tool_name: "upsert_work_item",
        options: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          actorToken: "parent",
          phaseNumber: 1,
          title: "Bad assignment",
          description: "Legacy field should fail before it can be ignored.",
          assignedTo: "worker-a",
        },
      }, 3032),
      /assigneeAgentIds/
    );
    await assert.rejects(
      () => callTool(sid, "teamwork", {
        tool_name: "record_result",
        options: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          actorToken: "worker",
          workItemId: "00000000-0000-4000-8000-000000000001",
          resultType: "summary",
          summary: "Bad result type",
        },
      }, 3033),
      /Use "note"/
    );
    const aliasWait = await callTool(sid, "teamwork", {
        tool_name: "wait_for_messages",
        options: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          actorToken: "worker",
          timeoutMs: 1000,
        },
      }, 3034).catch((error) => error);
    assert.match(String(aliasWait), /Unknown actor token|Unknown session|Actor token does not belong|No active session/);
    const messageIdAck = await callTool(sid, "teamwork", {
        tool_name: "ack_messages",
        options: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          actorToken: "worker",
          messageIds: ["00000000-0000-4000-8000-000000000000"],
        },
      }, 3035).catch((error) => error);
    assert.match(String(messageIdAck), /Unknown actor token|Unknown session|Actor token does not belong|No active session/);
    const readOnlyActorToken = await callTool(sid, "teamwork", {
        tool_name: "list_worktrees",
        options: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          actorToken: "worker",
        },
      }, 3036).catch((error) => error);
    assert.match(String(readOnlyActorToken), /Unknown session|No active session/);
  });

  it("blocks worker launch preflight when the session has no workspace path", async () => {
    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Missing workspace preflight",
      taskSlug: "missing-workspace-preflight",
      projectRoot: tmpDir,
      taskPrompt: "Verify plan_launch does not report ready without sessionWorkspacePath.",
    }, 3038);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 3039);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "implementation",
      cli: "fake",
      model: "fake-worker",
      role: "worker",
    }, 3040);
    const worktreePath = path.join(tmpDir, "missing-workspace-preflight", "worker-a");
    mkdirSync(worktreePath, { recursive: true });
    await callTool(sid, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-missing-workspace",
      status: "ready",
    }, 3041);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Launch",
      goal: "Verify workspace preflight.",
    }, 3042);
    const plan = await callTool(sid, "teamwork", {
      tool_name: "plan_launch",
      options: { sessionId: session.sessionId, actorToken: parent.token, phaseNumber: 1 },
    }, 3043);
    assert.equal(plan.readyToLaunch, false);
    assert.ok(plan.blockingIssues.some((issue: string) => issue.includes("sessionWorkspacePath")));
    await assert.rejects(
      () => callTool(sid, "teamwork", {
        tool_name: "launch_phase_workers",
        options: { sessionId: session.sessionId, actorToken: parent.token, phaseNumber: 1 },
      }, 3044),
      /sessionWorkspacePath/
    );
  });

  it("launches a fake CLI worker, sends input, captures output, and stops it during session completion", async () => {
    const workspace = path.join(tmpDir, "server-managed-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Server-managed worker test",
      taskSlug: "server-managed-worker",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify the server can manage fake CLI worker IO.",
    }, 303);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      responsibility: "Own orchestration and integration for the fake launch test.",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 304);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      responsibility: "Own fake worker process behavior and answer fake-runtime questions.",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 305);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-worker-a",
      status: "ready",
    }, 306);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Fake launch",
      goal: "Launch and communicate with a fake worker.",
    }, 307);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Fake work",
      description: "Hold a fake worker process open.",
      status: "assigned",
      ownerAgentId: worker.agentId,
    }, 308);

    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        workItemIds: [workItem.workItemId],
        pairRole: "implementer",
        launchMode: "persistent-stdin",
      },
    }, 309);
    assert.equal(launched.status, "running");
    assert.equal(launched.agentAlias, "worker-a");
    assert.equal(existsSync(path.join(worktreePath, ".teamwork", "WORKER_SHARED_INSTRUCTIONS.md")), true);

    await callTool(sid, "teamwork", {
      tool_name: "send_worker_input",
      options: {
        sessionId,
        actorToken: parent.token,
        runtimeId: launched.runtimeId,
        input: "Please answer this parent follow-up.",
      },
    }, 310);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 20 },
    }, 311);
    assert.ok(log.events.some((entry: any) => entry.stream === "stdout" && entry.text.includes("fake-session-id:worker-a")));
    assert.ok(log.events.some((entry: any) => entry.stream === "prompt" && entry.text.includes("worker prompt stored redacted")));
    assert.ok(log.events.some((entry: any) => entry.stream === "prompt" && entry.text.includes(`WORKSPACE_DIR: ${worktreePath}`)));
    assert.ok(log.events.some((entry: any) => entry.stream === "prompt" && entry.text.includes(`agentId=${worker.agentId}`)));
    assert.ok(log.events.some((entry: any) => entry.stream === "prompt" && entry.text.includes("responsibility=Own fake worker process behavior and answer fake-runtime questions.")));
    assert.ok(log.events.some((entry: any) => entry.stream === "stdout" && entry.text.includes("worker prompt output redacted")));
    assert.ok(log.events.every((entry: any) => !entry.text.includes(worker.token)));
    assert.ok(log.events.some((entry: any) => entry.stream === "stdin" && entry.text.includes("Please answer")));
    assert.ok(log.events.some((entry: any) => entry.stream === "stdout" && entry.text.includes("fake-input:Please answer")));

    const terminalRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(worker.agentId)}/terminal?limit=200`
    );
    assert.equal(terminalRes.status, 200);
    const terminal = await terminalRes.json();
    assert.ok(terminal.chunks.some((entry: any) => entry.stream === "stdout" && entry.chunk.includes("fake-session-id:worker-a")));
    assert.ok(terminal.chunks.some((entry: any) => entry.stream === "stdout" && entry.chunk.includes("fake-input:Please answer")));
    assert.ok(terminal.chunks.some((entry: any) => entry.runtimeId === launched.runtimeId));

    await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
    }, 3111);

    await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Fake worker reported a result.",
      commitSha: "abc1234",
      verificationSummary: "Parent-owned validation pending; worker did not run tests.",
    }, 312);
    const parentPoll = await callTool(sid, "teamwork", {
      tool_name: "parent_poll",
      options: { sessionId, actorToken: parent.token },
    }, 3121);
    assert.equal(parentPoll.readiness.phaseCanBeginIntegration, true);
    assert.equal(parentPoll.readiness.nextSuggestedOperation, "begin_integration");
    assert.equal(parentPoll.workers.find((entry: any) => entry.agentId === worker.agentId)?.status, "idle");
    const parentPollBaseline = await callTool(sid, "teamwork", {
      tool_name: "parent_poll_baseline",
      options: { sessionId, actorToken: parent.token },
    }, 31211);
    assert.equal(parentPollBaseline.readiness.phaseCanBeginIntegration, true);
    assert.equal(parentPollBaseline.readiness.nextSuggestedOperation, "begin_integration");
    assert.equal(parentPollBaseline.counts.workerProcesses.missingResumeIds, 0);
    assert.equal(parentPollBaseline.readiness.hasMissingResumeIds, false);
    assert.deepEqual(parentPollBaseline.agents, [{ alias: "worker-a", status: "idle" }]);
    assert.equal("workers" in parentPollBaseline, false);
    assert.equal("workItems" in parentPollBaseline, false);
    await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: parent.token,
      target: "broadcast",
      kind: "status",
      body: "Stand by for integration.",
    }, 3122);
    await callTool(sid, "tw_begin_integration", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    }, 313);
    await callTool(sid, "tw_record_integration_event", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      sourceBranch: "tw-worker-a",
      targetBranch: "main",
      commitSha: "def5678",
    }, 314);
    await callTool(sid, "tw_complete_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Fake worker phase integrated.",
    }, 315);
    await callTool(sid, "teamwork", {
      tool_name: "stop_worker",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 3151);
    await callTool(sid, "teamwork", {
      tool_name: "cleanup_worktree",
      options: { sessionId, actorToken: parent.token, worktreeId: worktree.worktreeId },
    }, 316);
    const completed = await callTool(sid, "tw_complete_session", {
      sessionId,
      actorToken: parent.token,
      summary: "Completed with server-managed worker teardown.",
    }, 317);
    assert.equal(completed.status, "completed");

    const processes = await callTool(sid, "teamwork", {
      tool_name: "list_worker_processes",
      options: { sessionId, actorToken: parent.token },
    }, 318);
    assert.equal(processes.runtimes[0].status, "exited");
  });

  it("launches a fake CLI worker in PTY mode and accepts dashboard terminal input", async () => {
    const workspace = path.join(tmpDir, "pty-terminal-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "PTY terminal input test",
      taskSlug: "pty-terminal-input",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify dashboard terminal input reaches a server-managed PTY worker.",
    }, 31701);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      responsibility: "Own orchestration for the PTY terminal input test.",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 31702);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake PTY specialist",
      responsibility: "Own fake PTY process behavior.",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 31703);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-pty-worker-a",
      status: "ready",
    }, 31704);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "PTY launch",
      goal: "Launch and type into a fake PTY worker.",
    }, 31705);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "PTY work",
      description: "Hold a fake PTY worker process open.",
      status: "assigned",
      ownerAgentId: worker.agentId,
    }, 31706);

    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        workItemIds: [workItem.workItemId],
        launchMode: "pty",
      },
    }, 31707);
    assert.equal(launched.status, "running");
    assert.equal(launched.launchMode, "pty");
    assert.equal(launched.inputDelivery, "pty");
    assert.equal(launched.stdinWritable, true);

    const resizeRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/runtimes/${encodeURIComponent(launched.runtimeId)}/resize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 100, rows: 30 }),
      }
    );
    assert.equal(resizeRes.status, 200);
    assert.equal((await resizeRes.json()).resized, true);

    const inputRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/runtimes/${encodeURIComponent(launched.runtimeId)}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Dashboard typed\r" }),
      }
    );
    assert.equal(inputRes.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const terminalRes = await fetch(
      `${BASE_URL}/api/v2/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(worker.agentId)}/terminal?limit=200`
    );
    assert.equal(terminalRes.status, 200);
    const terminal = await terminalRes.json();
    assert.ok(terminal.chunks.some((entry: any) => entry.stream === "stdout" && entry.chunk.includes("fake-session-id:worker-a")));
    assert.ok(terminal.chunks.some((entry: any) => entry.stream === "stdout" && entry.chunk.includes("Dashboard typed")));
    assert.equal(terminal.chunks.some((entry: any) => entry.stream === "stdin"), false);

    const log = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 20 },
    }, 31708);
    assert.ok(log.events.some((entry: any) => entry.stream === "stdin" && entry.text.includes("Dashboard typed")));

    await callTool(sid, "teamwork", {
      tool_name: "stop_worker",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 31709);
  });

  it("treats parent-registered external worktree paths as approved cleanup roots", async () => {
    const workspace = path.join(tmpDir, "external-root-session");
    const externalWorktreePath = path.join(tmpDir, "short-root", "worker-a");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(externalWorktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "External worktree cleanup",
      taskSlug: "external-worktree-cleanup",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify external short-root worktrees are tracked for cleanup.",
    }, 31801);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      responsibility: "Own orchestration for external-root cleanup coverage.",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 31802);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      responsibility: "Own the externally rooted worktree slice.",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 31803);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: externalWorktreePath,
      branch: "tw-external-worker",
      status: "ready",
    }, 31804);
    const sessionState = await callTool(sid, "tw_get_session_state", { sessionId }, 31805);
    assert.ok(sessionState.approvedWorktreeRoots.includes(externalWorktreePath));

    const cleanup = await callTool(sid, "teamwork", {
      tool_name: "cleanup_worktree",
      options: { sessionId, actorToken: parent.token, worktreeId: worktree.worktreeId },
    }, 31806);
    assert.equal(cleanup.status, "removed");
    assert.equal(existsSync(externalWorktreePath), false);
  });

  it("previews phase launch options and returns a parent resume packet", async () => {
    const workspace = path.join(tmpDir, "launch-plan-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Launch plan and resume packet",
      taskSlug: "launch-plan-resume",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify launch preflight and parent resume recovery.",
    }, 3181);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      responsibility: "Own orchestration and launch verification.",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 3182);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      responsibility: "Own the preflighted fake worker slice.",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 3183);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-worker-a",
      status: "ready",
    }, 3184);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Preflight",
      goal: "Preview launch before starting a process.",
    }, 3185);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Preflighted work",
      description: "A work item used to verify launch planning.",
      status: "assigned",
      ownerAgentId: worker.agentId,
    }, 3186);
    await callTool(sid, "tw_send_message", {
      sessionId,
      actorToken: worker.token,
      target: "broadcast",
      kind: "status",
      body: "Worker status visible to parent after resume.",
    }, 3187);

    const plan = await callTool(sid, "teamwork", {
      tool_name: "plan_launch",
      options: {
        sessionId,
        actorToken: parent.token,
        phaseNumber: 1,
        agentIds: [worker.agentId],
        launchMode: "persistent-stdin",
        reasoningEffort: "high",
        modelOverrides: { [worker.agentId]: "fake-model-high" },
        workItemIdsByAgentId: { [worker.agentId]: [workItem.workItemId] },
      },
    }, 3188);
    assert.equal(plan.readyToLaunch, true);
    assert.equal(plan.workers[0].alias, "worker-a");
    assert.equal(plan.workers[0].model, "fake-model-high");
    assert.equal(plan.workers[0].reasoningEffort, "high");
    assert.equal(plan.workers[0].worktree.worktreeId, worktree.worktreeId);
    assert.equal(plan.workers[0].workItems[0].workItemId, workItem.workItemId);
    assert.equal(Array.isArray(plan.warnings), true);

    const processesBeforeLaunch = await callTool(sid, "teamwork", {
      tool_name: "list_worker_processes",
      options: { sessionId, actorToken: parent.token },
    }, 3189);
    assert.equal(processesBeforeLaunch.runtimes.length, 0);

    const resumePacket = await callTool(sid, "teamwork", {
      tool_name: "get_session_resume_packet",
      options: { sessionId },
    }, 3190);
    assert.equal(resumePacket.parent.actorToken, parent.token);
    assert.equal(resumePacket.workItems[0].workItemId, workItem.workItemId);
    assert.equal(resumePacket.messages.unreadCount, 1);
    assert.equal(resumePacket.activeRuntimes.length, 0);
  });

  it("binds launch workItemIds to assignment state and allows parent fallback results", async () => {
    const workspace = path.join(tmpDir, "launch-assignment-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Launch assignment binding",
      taskSlug: "launch-assignment-binding",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify launch_worker binds work items before worker result recording.",
    }, 319);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 320);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 321);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-worker-a",
      status: "ready",
    }, 322);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Assignment",
      goal: "Bind work item assignment during launch.",
    }, 323);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Previously unassigned work",
      description: "This item is intentionally created without assignees.",
      status: "planned",
    }, 324);
    const parentFallbackItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Parent fallback capture",
      description: "This remains unassigned so parent fallback result recording is exercised.",
      status: "planned",
    }, 325);

    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        workItemIds: [workItem.workItemId],
        launchMode: "persistent-stdin",
      },
    }, 326);

    const listed = await callTool(sid, "tw_list_work_items", { sessionId, phaseNumber: 1 }, 327);
    const assigned = listed.workItems.find((item: any) => item.workItemId === workItem.workItemId);
    assert.deepEqual(assigned.assigneeAgentIds, [worker.agentId]);
    assert.equal(assigned.status, "assigned");

    await callTool(sid, "tw_claim_work_item", {
      sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
    }, 3271);

    const workerResult = await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
      resultType: "note",
      summary: "Worker result succeeded after launch assignment binding.",
    }, 328);
    assert.ok(workerResult.resultId);

    const parentFallback = await callTool(sid, "tw_record_result", {
      sessionId,
      actorToken: parent.token,
      workItemId: parentFallbackItem.workItemId,
      resultType: "note",
      summary: "Parent captured visible worker output after formal worker result failed.",
      data: { source: "worker-log", runtimeId: launched.runtimeId },
    }, 329);
    assert.ok(parentFallback.resultId);
    const fallbackResults = await callTool(sid, "tw_list_results", { sessionId, workItemId: parentFallbackItem.workItemId }, 3291);
    assert.match(fallbackResults.results[0].data, /worker-log/);

    await callTool(sid, "teamwork", {
      tool_name: "stop_worker",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 330);
  });

  it("provides closeout ack and worktree cleanup helpers without worker-token impersonation", async () => {
    const workspace = path.join(tmpDir, "closeout-helper-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Closeout helper test",
      taskSlug: "closeout-helper",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Verify closeout helpers can ack idle workers and clean worktrees.",
    }, 331);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 332);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "implementation",
      cli: "fake",
      model: "fake-worker",
      role: "worker",
    }, 333);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-closeout-helper",
      status: "ready",
    }, 334);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Closeout",
      goal: "Exercise closeout helper gates.",
    }, 335);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Review-only work",
      description: "No code changes.",
      assigneeAgentIds: [worker.agentId],
      status: "assigned",
    }, 336);
    await callTool(sid, "tw_claim_work_item", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
    }, 3361);

    await callTool(sid, "tw_record_result", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      workItemId: workItem.workItemId,
      resultType: "note",
      summary: "Review-only result recorded.",
      data: { result: "ok" },
    }, 337);
    await callTool(sid, "tw_set_agent_status", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      status: "idle",
      note: "Waiting for closeout.",
    }, 338);
    await callTool(sid, "tw_send_message", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "agent",
      targetAgentId: worker.agentId,
      kind: "system",
      body: "Phase boundary.",
      requiresAck: true,
      dueStage: "phase",
    }, 339);
    await callTool(sid, "tw_begin_integration", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    }, 340);
    const checklist = await callTool(sid, "teamwork", {
      tool_name: "get_closeout_checklist",
      options: { sessionId: session.sessionId, actorToken: parent.token, phaseNumber: 1, stage: "phase" },
    }, 341);
    assert.equal(checklist.diagnostics.counts.unackedBoundaryAgents, 1);

    const acked = await callTool(sid, "teamwork", {
      tool_name: "closeout_ack_workers",
      options: { sessionId: session.sessionId, actorToken: parent.token, stage: "phase" },
    }, 342);
    assert.equal(acked.ackedAgents[0].agentId, worker.agentId);

    await callTool(sid, "tw_record_integration_event", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "cherry-pick",
      details: "No source changes to integrate.",
    }, 343);
    await callTool(sid, "tw_complete_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Closeout helper phase complete.",
    }, 344);

    await assert.rejects(
      () => callTool(sid, "tw_update_worktree", {
        sessionId: session.sessionId,
        actorToken: parent.token,
        worktreeId: worktree.worktreeId,
        status: "removed",
      }, 345),
      /path still exists/
    );
    const cleanup = await callTool(sid, "teamwork", {
      tool_name: "cleanup_worktree",
      options: { sessionId: session.sessionId, actorToken: parent.token, worktreeId: worktree.worktreeId },
    }, 346);
    assert.equal(cleanup.status, "removed");
    assert.equal(existsSync(worktreePath), false);
  });

  it("supports get_worker_log unread tail and full-history modes", async () => {
    const workspace = path.join(tmpDir, "worker-log-modes-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Worker log modes test",
      taskSlug: "worker-log-modes",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Test task prompt for single-tool-and-workers.",
    }, 360);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 361);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 362);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-worker-log-modes",
      status: "ready",
    }, 363);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Log modes",
      goal: "Verify worker log read modes.",
    }, 364);

    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        launchMode: "persistent-stdin",
      },
    }, 365);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const firstRead = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 369);
    assert.equal(firstRead.mode, "new");
    assert.ok(firstRead.events.length > 0);
    assert.ok(firstRead.cursor.nextAfterRuntimeLogId);

    const secondRead = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 370);
    assert.equal(secondRead.events.length, 0);

    const tailRead = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "tail", limit: 5 },
    }, 371);
    assert.equal(tailRead.mode, "tail");
    assert.ok(tailRead.events.length > 0);
    assert.equal(tailRead.cursor.advanced, false);

    const allRead = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all" },
    }, 372);
    assert.equal(allRead.mode, "all");
    assert.equal(allRead.truncated, false);
    assert.equal(allRead.events.length, allRead.totalCount);
    assert.ok(allRead.events.length >= tailRead.events.length);

    const limitedAllRead = await callTool(sid, "teamwork", {
      tool_name: "get_worker_log",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 1 },
    }, 373);
    assert.equal(limitedAllRead.mode, "all");
    assert.equal(limitedAllRead.events.length, 1);
    assert.equal(limitedAllRead.truncated, true);
    assert.ok(limitedAllRead.totalCount > limitedAllRead.events.length);

    await callTool(sid, "teamwork", {
      tool_name: "stop_worker",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 374);
  });

  it("returns a parent poll monitor snapshot through the single teamwork tool", async () => {
    const workspace = path.join(tmpDir, "parent-poll-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Parent poll test",
      taskSlug: "parent-poll",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Test task prompt for single-tool-and-workers.",
    }, 319);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 320);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 321);
    await callTool(sid, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-parent-poll",
      status: "ready",
    }, 322);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Monitor",
      goal: "Verify parent poll aggregation.",
    }, 323);
    await callTool(sid, "tw_upsert_work_item", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Blocked work",
      description: "Needs parent attention.",
      status: "blocked",
      ownerAgentId: worker.agentId,
    }, 324);
    await callTool(sid, "tw_send_message", {
      sessionId: session.sessionId,
      actorToken: worker.token,
      target: "agent",
      targetAgentId: parent.agentId,
      kind: "question",
      body: "Need parent input.",
      requiresResponse: true,
      obligationKind: "answer",
      dueStage: "phase",
    }, 325);

    const poll = await callTool(sid, "teamwork", {
      tool_name: "parent_poll",
      options: { sessionId: session.sessionId, actorToken: parent.token },
    }, 326);

    assert.equal(poll.session.sessionId, session.sessionId);
    assert.equal(poll.workItems.counts.blocked, 1);
    assert.equal(poll.workItems.blockedPreview.length, 1);
    assert.equal(poll.messages.unreadCount, 1);
    assert.equal(poll.messages.unreadPreview.length, 1);
    assert.equal(poll.messages.openObligationCount, 1);
    assert.equal(poll.messages.openObligationPreview.length, 1);
    assert.equal("all" in poll.workItems, false);
    assert.equal("unreadForParent" in poll.messages, false);
    assert.equal(poll.readiness.hasOpenBlockers, true);
    assert.equal(poll.readiness.phaseCanBeginIntegration, false);
    assert.equal("recommendedAction" in poll, false);
  });

  it("requires parent tokens for worker process operations and shows exited runtime metadata", async () => {
    const workspace = path.join(tmpDir, "parent-only-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Parent-only worker operation test",
      taskSlug: "parent-only-worker-operation",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Test task prompt for single-tool-and-workers.",
    }, 330);
    const sessionId = session.sessionId;
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 331);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 332);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-parent-only",
      status: "ready",
    }, 333);
    await callTool(sid, "tw_start_phase", {
      sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Launch",
      goal: "Verify parent-only worker process control.",
    }, 334);

    await assert.rejects(
      () => callTool(sid, "teamwork", {
        tool_name: "launch_worker",
        options: {
          sessionId,
          actorToken: worker.token,
          agentId: worker.agentId,
          worktreeId: worktree.worktreeId,
          phaseNumber: 1,
          launchMode: "persistent-stdin",
        },
      }, 335),
      /Parent token required/
    );

    const launched = await callTool(sid, "teamwork", {
      tool_name: "launch_worker",
      options: {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        worktreeId: worktree.worktreeId,
        phaseNumber: 1,
        launchMode: "persistent-stdin",
      },
    }, 336);
    await callTool(sid, "teamwork", {
      tool_name: "stop_worker",
      options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId },
    }, 337);

    await assert.rejects(
      () => callTool(sid, "teamwork", {
        tool_name: "list_worker_processes",
        options: { sessionId, actorToken: worker.token },
      }, 338),
      /Parent token required/
    );
    const processes = await callTool(sid, "teamwork", {
      tool_name: "list_worker_processes",
      options: { sessionId, actorToken: parent.token },
    }, 339);
    assert.equal(processes.runtimes[0].status, "exited");

    const api = await fetch(`${BASE_URL}/api/sessions`);
    const body = await api.json() as any;
    const dashboardSession = body.sessions.find((entry: any) => entry.sessionId === sessionId);
    assert.equal(dashboardSession.runtimes[0].status, "exited");
    assert.equal(dashboardSession.runtimes[0].launchMode, "persistent-stdin");
    assert.equal(dashboardSession.runtimes[0].managedByServer, true);
  });

  it("launches Copilot through its adapter and restarts with the captured CLI session id", async () => {
    const copilot = createNamedCliFixture(
      "copilot",
      `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write("copilot-args:" + JSON.stringify(args) + "\\n");
process.stdout.write("Fallback handoff summary: reviewed the assigned slice.\\n");
process.stderr.write("Session exported to: C:/tmp/copilot-session-cp_test_session.md\\n");
`
    );
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
      TEAMWORK_COPILOT_BIN: copilot.cliPath,
      TEAMWORK_COPILOT_DISABLE_MCP_SERVERS: "roundtable-v2,windows-mcp",
      PATH: copilot.pathEnv,
    });
    let localServer: ChildProcess | undefined = s.server;
    try {
      await s.waitReady();
      const localSid = await initSession("copilot-adapter-client");
      const workspace = path.join(s.tmpDir, "copilot-session");
      const worktreePath = path.join(workspace, "worktrees", "worker-a");
      mkdirSync(worktreePath, { recursive: true });
      const session = await callTool(localSid, "tw_create_session", {
        parentAlias: "parent",
        title: "Copilot adapter test",
        taskSlug: "copilot-adapter",
        projectRoot: s.tmpDir,
        sessionWorkspacePath: workspace,
        taskPrompt: "Test task prompt for single-tool-and-workers.",
      }, 350);
      const sessionId = session.sessionId;
      const parent = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "parent",
        specialty: "orchestrator",
        cli: "codex",
        model: "gpt-5",
        role: "parent",
      }, 351);
      const worker = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "copilot-a",
        specialty: "copilot specialist",
        cli: "copilot",
        model: "gpt-latest",
        role: "worker",
      }, 352);
      const worktree = await callTool(localSid, "tw_register_worktree", {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        path: worktreePath,
        branch: "tw-copilot-a",
        status: "ready",
      }, 353);
      await callTool(localSid, "tw_start_phase", {
        sessionId,
        actorToken: parent.token,
        phaseNumber: 1,
        title: "Copilot",
        goal: "Verify adapter behavior.",
      }, 354);
      const workItem = await callTool(localSid, "tw_upsert_work_item", {
        sessionId,
        actorToken: parent.token,
        phaseNumber: 1,
        title: "Copilot batch launch",
        description: "Verify launch_phase_workers carries batch reasoning effort into adapter args.",
        status: "assigned",
        ownerAgentId: worker.agentId,
      }, 3541);

      const batchLaunch = await callTool(localSid, "teamwork", {
        tool_name: "launch_phase_workers",
        options: {
          sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          agentIds: [worker.agentId],
          reasoningEffort: "high",
          launchMode: "persistent-stdin",
          workItemIdsByAgentId: { [worker.agentId]: [workItem.workItemId] },
        },
      }, 355);
      const launched = batchLaunch.runtimes[0];
      assert.equal(launched.launchMode, "resume-command");
      assert.equal(launched.stdinWritable, false);
      assert.equal(launched.resumeSupported, true);
      let launchedProcesses: any;
      for (let attempt = 0; attempt < 10; attempt++) {
        launchedProcesses = await callTool(localSid, "teamwork", {
          tool_name: "list_worker_processes",
          options: { sessionId, actorToken: parent.token },
        }, 358 + attempt);
        if (launchedProcesses.runtimes.some((runtime: any) => runtime.cliSessionId === "cp_test_session")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(launchedProcesses.runtimes.some((runtime: any) => runtime.cliSessionId === "cp_test_session"));
      assert.ok(launchedProcesses.runtimes.some((runtime: any) => runtime.sessionExportPath?.includes("copilot-session-cp_test_session.md")));
      assert.ok(launchedProcesses.runtimes.every((runtime: any) => runtime.inputDelivery !== "stdin"));

      await callTool(localSid, "teamwork", {
        tool_name: "send_worker_input",
        options: {
          sessionId,
          actorToken: parent.token,
          runtimeId: launched.runtimeId,
          input: "Please answer this follow-up.",
        },
      }, 368);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const followUpLog = await callTool(localSid, "teamwork", {
        tool_name: "get_worker_log",
        options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 30 },
      }, 369);
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("Please answer this follow-up.")));
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("--resume\",\"cp_test_session")));
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("--reasoning-effort\",\"high")));
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("--additional-mcp-config")));
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("--disable-mcp-server\",\"roundtable-v2")));
      assert.ok(followUpLog.events.some((entry: any) => entry.text.includes("--disable-mcp-server\",\"windows-mcp")));

      const restarted = await callTool(localSid, "teamwork", {
        tool_name: "restart_worker",
        options: {
          sessionId,
          actorToken: parent.token,
          runtimeId: launched.runtimeId,
          worktreeId: worktree.worktreeId,
          phaseNumber: 1,
        },
      }, 356);
      assert.equal(restarted.cliSessionId, "cp_test_session");

      await new Promise((resolve) => setTimeout(resolve, 300));
      const log = await callTool(localSid, "teamwork", {
        tool_name: "get_worker_log",
        options: { sessionId, actorToken: parent.token, runtimeId: restarted.runtimeId, mode: "all", limit: 20 },
      }, 357);
      assert.ok(log.events.some((entry: any) => entry.text.includes("--resume\",\"cp_test_session")));
      const diagnostics = await callTool(localSid, "teamwork", {
        tool_name: "get_diagnostic_report",
        options: { sessionId },
      }, 389);
      assert.ok(diagnostics.handoffs.fallbackCandidates.some((entry: any) => entry.excerpt.includes("Fallback handoff summary")));
      assert.ok(diagnostics.runtimes.some((runtime: any) => runtime.runtimeId === launched.runtimeId && runtime.sessionExportPath?.includes("copilot-session-cp_test_session.md")));
      assert.ok(diagnostics.runtimes.some((runtime: any) =>
        runtime.runtimeId === launched.runtimeId
        && runtime.status === "exited"
        && runtime.logicalStatus === "resumable-idle"
      ));
      const debugEvents = await callTool(localSid, "teamwork", {
        tool_name: "list_debug_events",
        options: { sessionId, limit: 1000 },
      }, 390);
      assert.ok(debugEvents.events.some((entry: any) =>
        entry.eventType === "adapter_capability_decision"
        && entry.payload.cli === "copilot"
        && entry.payload.requestedMode === "persistent-stdin"
        && entry.payload.launchMode === "resume-command"
      ));
    } finally {
      if (localServer) stopServer(localServer, s.tmpDir);
      copilot.cleanup();
    }
  });

  it("marks missing Gemini launches as crashed without killing the server", async () => {
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
      TEAMWORK_GEMINI_BIN: "definitely-missing-gemini-cli",
    });
    let localServer: ChildProcess | undefined = s.server;
    try {
      await s.waitReady();
      const localSid = await initSession("gemini-launch-failure-client");
      const workspace = path.join(s.tmpDir, "gemini-missing-session");
      const worktreePath = path.join(workspace, "worktrees", "worker-a");
      mkdirSync(worktreePath, { recursive: true });

      const session = await callTool(localSid, "tw_create_session", {
        parentAlias: "parent",
        title: "Missing Gemini launch test",
        taskSlug: "missing-gemini-launch",
        projectRoot: s.tmpDir,
        sessionWorkspacePath: workspace,
        taskPrompt: "Verify a missing Gemini binary does not crash the teamwork server.",
      }, 391);
      const sessionId = session.sessionId;
      const parent = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "parent",
        specialty: "orchestrator",
        cli: "codex",
        model: "gpt-5",
        role: "parent",
      }, 392);
      const worker = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "gemini-a",
        specialty: "gemini reviewer",
        cli: "gemini",
        model: "gemini-2.5-pro",
        role: "worker",
      }, 393);
      const worktree = await callTool(localSid, "tw_register_worktree", {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        path: worktreePath,
        branch: "tw-gemini-a",
        status: "ready",
      }, 394);
      await callTool(localSid, "tw_start_phase", {
        sessionId,
        actorToken: parent.token,
        phaseNumber: 1,
        title: "Gemini launch",
        goal: "Keep the server alive when Gemini is unavailable.",
      }, 395);

      const launched = await callTool(localSid, "teamwork", {
        tool_name: "launch_worker",
        options: {
          sessionId,
          actorToken: parent.token,
          agentId: worker.agentId,
          worktreeId: worktree.worktreeId,
          phaseNumber: 1,
          launchMode: "persistent-stdin",
        },
      }, 396);

      let crashedRuntime: any;
      for (let attempt = 0; attempt < 20; attempt++) {
        const processes = await callTool(localSid, "teamwork", {
          tool_name: "list_worker_processes",
          options: { sessionId, actorToken: parent.token },
        }, 397 + attempt);
        crashedRuntime = processes.runtimes.find((runtime: any) => runtime.runtimeId === launched.runtimeId);
        if (crashedRuntime?.status === "crashed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.equal(crashedRuntime?.status, "crashed");

      const log = await callTool(localSid, "teamwork", {
        tool_name: "get_worker_log",
        options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 20 },
      }, 430);
      assert.ok(log.events.some((entry: any) => entry.text.includes("process failed to start")));
      assert.ok(log.events.some((entry: any) => entry.text.includes("definitely-missing-gemini-cli")));

      const poll = await callTool(localSid, "teamwork", {
        tool_name: "parent_poll",
        options: { sessionId, actorToken: parent.token },
      }, 431);
      assert.equal(poll.session.sessionId, sessionId);
    } finally {
      if (localServer) stopServer(localServer, s.tmpDir);
    }
  });

  it("closes stdin for Codex exec launches so workers do not wait for additional piped input", async () => {
    const codex = createNamedCliFixture(
      "codex",
      `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write("codex-args:" + JSON.stringify(args) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("session id: codex_test_session\\n");
  process.stdout.write("codex-stdin-ended\\n");
});
setTimeout(() => process.stdout.write("codex-still-waiting\\n"), 300);
`
    );
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
      TEAMWORK_CODEX_BIN: codex.cliPath,
      PATH: codex.pathEnv,
    });
    let localServer: ChildProcess | undefined = s.server;
    try {
      await s.waitReady();
      const localSid = await initSession("codex-stdin-client");
      const workspace = path.join(s.tmpDir, "codex-stdin-session");
      const worktreePath = path.join(workspace, "worktrees", "worker-a");
      mkdirSync(worktreePath, { recursive: true });
      const session = await callTool(localSid, "tw_create_session", {
        parentAlias: "parent",
        title: "Codex stdin behavior test",
        taskSlug: "codex-stdin",
        projectRoot: s.tmpDir,
        sessionWorkspacePath: workspace,
        taskPrompt: "Test task prompt for single-tool-and-workers.",
      }, 390);
      const sessionId = session.sessionId;
      const parent = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "parent",
        specialty: "orchestrator",
        cli: "codex",
        model: "gpt-5",
        role: "parent",
      }, 391);
      const worker = await callTool(localSid, "tw_register_agent", {
        sessionId,
        alias: "codex-a",
        specialty: "codex specialist",
        cli: "codex",
        model: "gpt-5",
        role: "worker",
      }, 392);
      const worktree = await callTool(localSid, "tw_register_worktree", {
        sessionId,
        actorToken: parent.token,
        agentId: worker.agentId,
        path: worktreePath,
        branch: "tw-codex-a",
        status: "ready",
      }, 393);
      await callTool(localSid, "tw_start_phase", {
        sessionId,
        actorToken: parent.token,
        phaseNumber: 1,
        title: "Codex",
        goal: "Verify stdin closes for codex exec.",
      }, 394);

      const launched = await callTool(localSid, "teamwork", {
        tool_name: "launch_worker",
        options: {
          sessionId,
          actorToken: parent.token,
          agentId: worker.agentId,
          worktreeId: worktree.worktreeId,
          phaseNumber: 1,
          reasoningEffort: "medium",
        },
      }, 395);

      let log: any;
      for (let attempt = 0; attempt < 10; attempt++) {
        log = await callTool(localSid, "teamwork", {
          tool_name: "get_worker_log",
          options: { sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "tail", limit: 30 },
        }, 396 + attempt);
        if (log.events.some((entry: any) => entry.text.includes("codex-stdin-ended"))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(log.events.some((entry: any) => entry.text.includes("codex-stdin-ended")));
      assert.ok(log.events.some((entry: any) => entry.text.includes("--model")));
      assert.ok(log.events.some((entry: any) => entry.text.includes("gpt-5")));
      assert.equal(log.events.some((entry: any) => entry.text.includes("codex-still-waiting")), false);
    } finally {
      if (localServer) stopServer(localServer, s.tmpDir);
      codex.cleanup();
    }
  });

  it("launches and resumes Claude, Gemini, and OpenCode through server-managed adapters", async () => {
    const fixtures = [
      createNamedCliFixture(
        "claude",
        `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write("claude-args:" + JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ session_id: "claude_test_session" }) + "\\n");
`
      ),
      createNamedCliFixture(
        "gemini",
        `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write("gemini-args:" + JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ type: "init", session_id: "gemini_test_session" }) + "\\n");
`
      ),
      createNamedCliFixture(
        "opencode",
        `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write("opencode-args:" + JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify({ sessionID: "opencode_test_session" }) + "\\n");
`
      ),
    ];
    const expectedResumeFlags: Record<string, string> = {
      claude: "--resume\",\"claude_test_session",
      gemini: "--resume\",\"gemini_test_session",
      opencode: "--session\",\"opencode_test_session",
    };
    const pathEnv = `${fixtures.map((fixture) => fixture.rootDir).join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`;
    const s = await startServer({
      TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath,
      TEAMWORK_CLAUDE_BIN: fixtures[0].cliPath,
      TEAMWORK_GEMINI_BIN: fixtures[1].cliPath,
      TEAMWORK_OPENCODE_BIN: fixtures[2].cliPath,
      PATH: pathEnv,
    });
    let localServer: ChildProcess | undefined = s.server;
    try {
      await s.waitReady();
      const localSid = await initSession("multi-adapter-client");
      for (const [index, cli] of ["claude", "gemini", "opencode"].entries()) {
        const workspace = path.join(s.tmpDir, `${cli}-adapter-session`);
        const worktreePath = path.join(workspace, "worktrees", `${cli}-worker`);
        mkdirSync(worktreePath, { recursive: true });
        const session = await callTool(localSid, "tw_create_session", {
          parentAlias: "parent",
          title: `${cli} adapter test`,
          taskSlug: `${cli}-adapter`,
          projectRoot: s.tmpDir,
          sessionWorkspacePath: workspace,
          taskPrompt: "Test task prompt for single-tool-and-workers.",
        }, 600 + index * 30);
        const parent = await callTool(localSid, "tw_register_agent", {
          sessionId: session.sessionId,
          alias: "parent",
          specialty: "orchestrator",
          cli: "codex",
          model: "gpt-5",
          role: "parent",
        }, 601 + index * 30);
        const worker = await callTool(localSid, "tw_register_agent", {
          sessionId: session.sessionId,
          alias: `${cli}-a`,
          specialty: `${cli} specialist`,
          cli,
          model: `${cli}-model`,
          role: "worker",
        }, 602 + index * 30);
        const worktree = await callTool(localSid, "tw_register_worktree", {
          sessionId: session.sessionId,
          actorToken: parent.token,
          agentId: worker.agentId,
          path: worktreePath,
          branch: `tw-${cli}-a`,
          status: "ready",
        }, 603 + index * 30);
        await callTool(localSid, "tw_start_phase", {
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          title: `${cli} adapter`,
          goal: "Verify launch and resume adapter behavior.",
        }, 604 + index * 30);

        const launched = await callTool(localSid, "teamwork", {
          tool_name: "launch_worker",
          options: {
            sessionId: session.sessionId,
            actorToken: parent.token,
            agentId: worker.agentId,
            worktreeId: worktree.worktreeId,
            phaseNumber: 1,
          },
        }, 605 + index * 30);

        let processes: any;
        for (let attempt = 0; attempt < 10; attempt++) {
          processes = await callTool(localSid, "teamwork", {
            tool_name: "list_worker_processes",
            options: { sessionId: session.sessionId, actorToken: parent.token },
          }, 606 + index * 30 + attempt);
          if (processes.runtimes.some((runtime: any) => runtime.cliSessionId === `${cli}_test_session`)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(processes.runtimes.some((runtime: any) => runtime.cliSessionId === `${cli}_test_session`));

        await callTool(localSid, "teamwork", {
          tool_name: "send_worker_input",
          options: {
            sessionId: session.sessionId,
            actorToken: parent.token,
            runtimeId: launched.runtimeId,
            input: `Follow up for ${cli}.`,
          },
        }, 620 + index * 30);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const log = await callTool(localSid, "teamwork", {
          tool_name: "get_worker_log",
          options: { sessionId: session.sessionId, actorToken: parent.token, runtimeId: launched.runtimeId, mode: "all", limit: 40 },
        }, 621 + index * 30);
        assert.ok(log.events.some((entry: any) => entry.text.includes(`${cli}-args:`)));
        assert.ok(log.events.some((entry: any) => entry.text.includes(`--model\",\"${cli}-model`)));
        assert.ok(log.events.some((entry: any) => entry.text.includes(expectedResumeFlags[cli])));
        assert.ok(log.events.some((entry: any) => entry.text.includes(`${cli}_test_session`)));
        assert.ok(log.events.some((entry: any) => entry.text.includes(`Follow up for ${cli}.`)));
      }
    } finally {
      if (localServer) stopServer(localServer, s.tmpDir);
      fixtures.forEach((fixture) => fixture.cleanup());
    }
  });

});
