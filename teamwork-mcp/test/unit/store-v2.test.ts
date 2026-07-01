import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";

import { TeamworkStore } from "../../src/store.js";

function createStore() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "teamwork-mcp-v2-"));
  const dbPath = path.join(tempDir, "teamwork.sqlite");
  const store = new TeamworkStore({ dbPath });
  return {
    store,
    tempDir,
    cleanup() {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function setupSession() {
  const harness = createStore();
  const session = harness.store.createSession({
    parentAlias: "parent",
    title: "V2 teamwork session",
    taskSlug: "v2-teamwork",
    projectRoot: "/repo",
    sessionWorkspacePath: path.join(harness.tempDir, "session"),
  });
  const parent = harness.store.registerAgent({
    sessionId: session.sessionId,
    alias: "parent",
    specialty: "orchestrator",
    cli: "codex",
    model: "gpt-5",
    role: "parent",
  });
  const workerA = harness.store.registerAgent({
    sessionId: session.sessionId,
    alias: "api-a",
    specialty: "api",
    cli: "codex",
    model: "gpt-5",
    role: "worker",
  });
  const workerB = harness.store.registerAgent({
    sessionId: session.sessionId,
    alias: "api-b",
    specialty: "api",
    cli: "codex",
    model: "gpt-5",
    role: "worker",
  });
  return { ...harness, session, parent, workerA, workerB };
}

function claimWorkItem(store: TeamworkStore, sessionId: string, worker: { token: string }, workItemId: string) {
  store.claimWorkItem({
    sessionId,
    actorToken: worker.token,
    workItemId,
  });
}

test("phase lifecycle is inferred by tools and gates phase completion", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "API contract",
      goal: "Build and verify the API contract.",
    });
    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "executing");

    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Implement endpoint",
      description: "Add the contract endpoint.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId, workerB.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });

    assert.throws(
      () =>
        store.beginIntegration({
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
        }),
      /work items are not done/
    );

    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    claimWorkItem(store, session.sessionId, workerB, workItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Implemented endpoint.",
      commitSha: "abc1234",
      verificationSummary: "unit tests passed",
    });
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      workItemId: workItem.workItemId,
      resultType: "test-report",
      summary: "Reviewed endpoint.",
      commitSha: "def5678",
      verificationSummary: "review and integration tests passed",
    });

    store.beginIntegration({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    });
    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "integrating");

    assert.throws(
      () =>
        store.completePhase({
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          summary: "No integration event yet.",
        }),
      /integration event/
    );

    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      sourceBranch: "tw-api",
      targetBranch: "main",
      commitSha: "9999999",
    });
    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "API contract integrated.",
    });

    const summary = store.getSessionSummary(session.sessionId);
    assert.equal(summary.lifecycleStage, "planning");
    assert.equal(summary.currentPhase, undefined);
    assert.equal(store.listCheckpoints({ sessionId: session.sessionId }).checkpoints.length, 1);
  } finally {
    cleanup();
  }
});

test("killSessionFromDashboard abandons stale sessions and inactivates every agent", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerA.agentId,
      transport: "fake-cli",
      managedByServer: true,
    });
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "crashed",
      exitCode: 1,
    });

    const result = store.killSessionFromDashboard({
      sessionId: session.sessionId,
      reason: "Killed from dashboard",
    });

    assert.equal(result.status, "abandoned");
    assert.equal(store.getSessionSummary(session.sessionId).status, "abandoned");
    assert.equal(store.getAgent(workerA.agentId).status, "inactive");
    assert.equal(store.getAgent(workerB.agentId).status, "inactive");
    assert.equal(store.getAgent(parent.agentId).status, "inactive");
  } finally {
    cleanup();
  }
});

test("required messages create obligations and phase-boundary ack gates", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Message gates",
      goal: "Exercise required response handling.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Answer contract question",
      description: "Resolve the required question.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    const question = store.sendMessage({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      target: "agent",
      targetAgentId: workerB.agentId,
      kind: "question",
      body: "Which endpoint shape should I use?",
      relatedWorkItemId: workItem.workItemId,
      requiresResponse: true,
      obligationKind: "answer",
      dueStage: "phase",
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Implemented using known contract.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    store.beginIntegration({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    });

    assert.throws(
      () =>
        store.completePhase({
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          summary: "Should fail while required question is unresolved.",
        }),
      /open obligations/
    );

    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      target: "agent",
      targetAgentId: workerA.agentId,
      kind: "answer",
      body: "Use the documented v2 payload.",
      replyToMessageId: question.messageId,
    });
    store.acknowledgeMessages({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      upToSequence: question.sequence,
    });
    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      commitSha: "9999999",
    });
    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Required question resolved.",
    });

    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "planning");
  } finally {
    cleanup();
  }
});

test("parent poll aggregates phase monitor state without choosing the next action", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Monitor loop",
      goal: "Expose parent polling state.",
    });
    const doneItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Completed slice",
      description: "Already done.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Blocked slice",
      description: "Needs parent decision.",
      status: "blocked",
      ownerAgentId: workerB.agentId,
    });
    claimWorkItem(store, session.sessionId, workerA, doneItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: doneItem.workItemId,
      resultType: "commit",
      summary: "Completed.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerB.agentId,
      transport: "codex-cli",
      managedByServer: true,
      heartbeatIntervalSeconds: 30,
    });
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "crashed",
      exitCode: 1,
    });
    store.recordRuntimeLog({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      agentId: workerB.agentId,
      stream: "stdout",
      text: "first output line\nsecond output line",
    });
    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      target: "agent",
      targetAgentId: parent.agentId,
      kind: "question",
      body: "Need a parent decision.",
      requiresResponse: true,
      obligationKind: "answer",
      dueStage: "phase",
    });

    const poll = store.parentPoll({
      sessionId: session.sessionId,
      actorToken: parent.token,
      includeWorkerOutputTails: { runtimeIds: [runtime.runtimeId], maxLines: 1 },
    });

    assert.equal(poll.session.sessionId, session.sessionId);
    assert.equal(poll.currentPhase?.phaseNumber, 1);
    assert.equal(poll.workItems.counts.done, 1);
    assert.equal(poll.workItems.counts.blocked, 1);
    assert.equal(poll.results.count, 1);
    assert.equal(poll.results.recent.length, 1);
    assert.equal(poll.workerProcesses.counts.crashed, 1);
    assert.ok(poll.workerProcesses.attention.some((entry) => entry.runtimeId === runtime.runtimeId));
    assert.equal(poll.messages.unreadCount, 1);
    assert.equal(poll.messages.unreadPreview.length, 1);
    assert.equal(poll.messages.openObligationCount, 1);
    assert.equal(poll.messages.openObligationPreview.length, 1);
    assert.equal(poll.workerOutputTails?.[0]?.lines.length, 1);
    assert.equal(poll.workerOutputTails?.[0]?.lines[0]?.text, "second output line");
    assert.equal("all" in poll.workItems, false);
    assert.equal("all" in poll.results, false);
    assert.equal("unreadForParent" in poll.messages, false);
    assert.equal(poll.blockers.workItems.length, 1);
    assert.equal(poll.readiness.allWorkItemsDone, false);
    assert.equal(poll.readiness.hasOpenBlockers, true);
    assert.equal(poll.readiness.hasUnreadParentMessages, true);
    assert.equal(poll.readiness.hasRequiredOpenObligations, true);
    assert.equal(poll.readiness.hasCrashedWorkers, true);
    assert.equal(poll.readiness.phaseCanBeginIntegration, false);
    assert.equal("recommendedAction" in poll, false);
  } finally {
    cleanup();
  }
});

test("parent poll baseline returns only minimal supervision state", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Monitor loop",
      goal: "Expose low-context parent polling state.",
    });
    const doneItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Completed slice",
      description: "Already done.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Blocked slice",
      description: "Needs parent decision.",
      status: "blocked",
      ownerAgentId: workerB.agentId,
    });
    claimWorkItem(store, session.sessionId, workerA, doneItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: doneItem.workItemId,
      resultType: "commit",
      summary: "Completed with a verbose result summary that baseline must not return.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerB.agentId,
      transport: "codex-cli",
      managedByServer: true,
      heartbeatIntervalSeconds: 30,
    });
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "crashed",
      exitCode: 1,
    });
    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      target: "agent",
      targetAgentId: parent.agentId,
      kind: "question",
      body: "Need a detailed parent decision that baseline must not return.",
      requiresResponse: true,
      obligationKind: "answer",
      dueStage: "phase",
    });

    const baseline = store.parentPollBaseline({
      sessionId: session.sessionId,
      actorToken: parent.token,
    });
    const full = store.parentPoll({ sessionId: session.sessionId, actorToken: parent.token });
    const baselineJson = JSON.stringify(baseline);

    assert.deepEqual(baseline.agents, [
      { alias: "api-a", status: "idle" },
      { alias: "api-b", status: "active" },
    ]);
    assert.equal(baseline.session.sessionId, session.sessionId);
    assert.equal(baseline.session.currentPhaseNumber, 1);
    assert.equal(baseline.counts.workItems.done, 1);
    assert.equal(baseline.counts.workItems.blocked, 1);
    assert.equal(baseline.counts.messages.unreadParentMessages, 1);
    assert.equal(baseline.counts.messages.openObligations, 1);
    assert.equal(baseline.counts.workerProcesses.crashed, 1);
    assert.equal(baseline.readiness.hasOpenBlockers, true);
    assert.equal(baseline.readiness.hasUnreadParentMessages, true);
    assert.equal(baseline.readiness.hasCrashedWorkers, true);
    assert.equal("workers" in baseline, false);
    assert.equal("workItems" in baseline, false);
    assert.equal("messages" in baseline, false);
    assert.equal("results" in baseline, false);
    assert.equal("blockers" in baseline, false);
    assert.equal(baselineJson.includes("Completed slice"), false);
    assert.equal(baselineJson.includes("verbose result summary"), false);
    assert.equal(baselineJson.includes("detailed parent decision"), false);
    assert.equal(baselineJson.includes(runtime.runtimeId), false);
    assert.equal(baselineJson.includes(workerB.agentId), false);
    assert.equal(baselineJson.includes(workerB.token), false);
    assert.ok(baselineJson.length < JSON.stringify(full).length / 2);
  } finally {
    cleanup();
  }
});

test("runtime log reads default to unread events per parent/runtime cursor", () => {
  const { store, cleanup, session, parent, workerA } = setupSession();
  try {
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerA.agentId,
      transport: "copilot-cli",
      managedByServer: true,
      heartbeatIntervalSeconds: 30,
    });
    store.recordRuntimeLog({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      agentId: workerA.agentId,
      stream: "stdout",
      text: "line one",
    });
    store.recordRuntimeLog({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      agentId: workerA.agentId,
      stream: "stdout",
      text: "line two",
    });

    const firstRead = store.readRuntimeLogs({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      parentAgentId: parent.agentId,
    });
    assert.deepEqual(firstRead.events.map((event) => event.text), ["line one", "line two"]);
    assert.equal(firstRead.cursor.advanced, true);

    const secondRead = store.readRuntimeLogs({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      parentAgentId: parent.agentId,
    });
    assert.equal(secondRead.events.length, 0);

    store.recordRuntimeLog({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      agentId: workerA.agentId,
      stream: "stdout",
      text: "line three",
    });

    const thirdRead = store.readRuntimeLogs({
      sessionId: session.sessionId,
      runtimeId: runtime.runtimeId,
      parentAgentId: parent.agentId,
    });
    assert.deepEqual(thirdRead.events.map((event) => event.text), ["line three"]);
  } finally {
    cleanup();
  }
});

test("work item ownership gates status updates, result recording, and reassignment", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Ownership gates",
      goal: "Keep worker writes scoped.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Scoped implementation",
      description: "Only the owner should report this.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });

    assert.throws(
      () =>
        store.updateWorkItemStatus({
          sessionId: session.sessionId,
          actorToken: workerB.token,
          workItemId: workItem.workItemId,
          status: "in-progress",
        }),
      /assigned worker/
    );
    assert.throws(
      () =>
        store.recordResult({
          sessionId: session.sessionId,
          actorToken: workerB.token,
          workItemId: workItem.workItemId,
          resultType: "commit",
          summary: "Wrong worker result.",
          commitSha: "bad",
          verificationSummary: "not run",
        }),
      /assigned worker/
    );
    assert.throws(
      () =>
        store.recordResult({
          sessionId: session.sessionId,
          actorToken: parent.token,
          workItemId: workItem.workItemId,
          resultType: "commit",
          summary: "Parent should not report worker-owned implementation.",
          commitSha: "parent",
          verificationSummary: "not applicable",
        }),
      /Parent fallback results/
    );
    const fallback = store.recordResult({
      sessionId: session.sessionId,
      actorToken: parent.token,
      workItemId: workItem.workItemId,
      resultType: "note",
      summary: "Parent captured visible worker output as a fallback note.",
    });
    assert.ok(fallback.resultId);

    store.reassignWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      workItemId: workItem.workItemId,
      assigneeAgentIds: [workerB.agentId],
      primaryAssigneeAgentId: workerB.agentId,
      reason: "Worker A hit a hard blocker.",
    });
    claimWorkItem(store, session.sessionId, workerB, workItem.workItemId);
    const result = store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Completed after reassignment.",
      commitSha: "abc1234",
      verificationSummary: "unit tests passed",
    });

    assert.ok(result.resultId);
    assert.equal(store.listWorkItems({ sessionId: session.sessionId }).workItems[0]?.status, "done");
  } finally {
    cleanup();
  }
});

test("workers explicitly claim one assigned work item before recording a result", () => {
  const { store, cleanup, session, parent, workerA } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Explicit claims",
      goal: "Keep one current worker focus.",
    });
    const first = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Review first slice",
      description: "Audit the first slice.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });
    const second = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Review second slice",
      description: "Audit the second slice.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });

    assert.throws(
      () =>
        store.updateWorkItemStatus({
          sessionId: session.sessionId,
          actorToken: workerA.token,
          workItemId: first.workItemId,
          status: "in-progress",
        }),
      /claim_work_item/
    );
    assert.throws(
      () =>
        store.recordResult({
          sessionId: session.sessionId,
          actorToken: workerA.token,
          workItemId: first.workItemId,
          resultType: "note",
          summary: "Tried to report without claiming.",
        }),
      /active claim/
    );

    const claim = store.claimWorkItem({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: first.workItemId,
      note: "Starting the first review.",
    });
    assert.equal(claim.workItemId, first.workItemId);
    assert.equal(claim.agentId, workerA.agentId);

    const sameClaim = store.claimWorkItem({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: first.workItemId,
    });
    assert.equal(sameClaim.claimId, claim.claimId);

    assert.throws(
      () =>
        store.claimWorkItem({
          sessionId: session.sessionId,
          actorToken: workerA.token,
          workItemId: second.workItemId,
        }),
      /already has an active claim/
    );

    const afterClaim = store.listWorkItems({ sessionId: session.sessionId }).workItems;
    assert.equal(afterClaim.find((item) => item.workItemId === first.workItemId)?.status, "in-progress");
    assert.equal(afterClaim.find((item) => item.workItemId === first.workItemId)?.activeClaims.length, 1);

    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: first.workItemId,
      resultType: "note",
      summary: "First review complete.",
    });

    const afterResult = store.listWorkItems({ sessionId: session.sessionId }).workItems;
    assert.equal(afterResult.find((item) => item.workItemId === first.workItemId)?.status, "done");
    assert.equal(afterResult.find((item) => item.workItemId === first.workItemId)?.activeClaims.length, 0);
    assert.equal(afterResult.find((item) => item.workItemId === second.workItemId)?.status, "assigned");
  } finally {
    cleanup();
  }
});

test("paired workers can share a claimed work item and complete it after both results", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Pair claims",
      goal: "Let a pair share the same current slice.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Shared implementation",
      description: "Implement and review one shared slice.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId, workerB.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });

    const firstClaim = store.claimWorkItem({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
    });
    const secondClaim = store.claimWorkItem({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      workItemId: workItem.workItemId,
    });
    assert.notEqual(secondClaim.claimId, firstClaim.claimId);
    assert.equal(
      store.listWorkItems({ sessionId: session.sessionId }).workItems[0]?.activeClaims.length,
      2
    );

    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Implemented shared slice.",
      commitSha: "abc1234",
      verificationSummary: "unit tests passed",
    });
    const afterFirstResult = store.listWorkItems({ sessionId: session.sessionId }).workItems[0];
    assert.equal(afterFirstResult?.status, "in-progress");
    assert.equal(afterFirstResult?.activeClaims.length, 1);

    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      workItemId: workItem.workItemId,
      resultType: "test-report",
      summary: "Reviewed shared slice.",
      commitSha: "def5678",
      verificationSummary: "review passed",
    });
    const afterSecondResult = store.listWorkItems({ sessionId: session.sessionId }).workItems[0];
    assert.equal(afterSecondResult?.status, "done");
    assert.equal(afterSecondResult?.activeClaims.length, 0);
  } finally {
    cleanup();
  }
});

test("parent poll flags claimed work whose runtime crashed without releasing the claim", () => {
  const { store, cleanup, session, parent, workerA } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Claim attention",
      goal: "Surface interrupted current work.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Current task",
      description: "This task is being worked.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });
    const claim = store.claimWorkItem({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
    });
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerA.agentId,
      pid: 12345,
      transport: "codex-cli",
      managedByServer: true,
    });
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "crashed",
      exitCode: 1,
    });

    const poll = store.parentPoll({ sessionId: session.sessionId, actorToken: parent.token });
    assert.equal(poll.workItems.claimAttention.length, 1);
    assert.equal(poll.workItems.claimAttention[0]?.claimId, claim.claimId);
    assert.equal(store.listWorkItems({ sessionId: session.sessionId }).workItems[0]?.activeClaims.length, 1);
  } finally {
    cleanup();
  }
});

test("blocking a shared claimed item releases all active claims on that item", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Pair blocker",
      goal: "Blocked shared work should not leave stale current focus.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Blocked pair task",
      description: "Both workers claimed this before a blocker appeared.",
      status: "assigned",
      assigneeAgentIds: [workerA.agentId, workerB.agentId],
      primaryAssigneeAgentId: workerA.agentId,
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    claimWorkItem(store, session.sessionId, workerB, workItem.workItemId);

    store.updateWorkItemStatus({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      status: "blocked",
      note: "Need parent input.",
    });

    const blocked = store.listWorkItems({ sessionId: session.sessionId }).workItems[0];
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.activeClaims.length, 0);
  } finally {
    cleanup();
  }
});

test("required ack obligations block phase completion until acked or parent-resolved", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Ack obligations",
      goal: "Ack requirements should be explicit blockers.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Do ack-gated work",
      description: "Complete a small slice.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    const ackRequired = store.sendMessage({
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "agent",
      targetAgentId: workerB.agentId,
      kind: "system",
      body: "Ack the phase-boundary notice.",
      requiresAck: true,
      obligationKind: "ack",
      dueStage: "phase",
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Work complete.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    store.beginIntegration({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    });
    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      commitSha: "9999999",
    });

    assert.throws(
      () =>
        store.completePhase({
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          summary: "Should fail while required ack is open.",
        }),
      /open obligations/
    );

    store.acknowledgeMessages({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      upToSequence: ackRequired.sequence,
    });
    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Ack requirement satisfied.",
    });
    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "planning");
  } finally {
    cleanup();
  }
});

test("parent can resolve stale required-response obligations explicitly", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Resolve obligation",
      goal: "Parent waiver should unblock superseded required questions.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Work with stale question",
      description: "Complete work despite superseded question.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    const required = store.sendMessage({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      target: "agent",
      targetAgentId: workerB.agentId,
      kind: "question",
      body: "This question will be superseded.",
      requiresResponse: true,
      obligationKind: "decision",
      dueStage: "phase",
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Work complete.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    store.beginIntegration({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
    });
    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      commitSha: "9999999",
    });

    assert.throws(
      () =>
        store.completePhase({
          sessionId: session.sessionId,
          actorToken: parent.token,
          phaseNumber: 1,
          summary: "Should fail before parent resolves.",
        }),
      /open obligations/
    );

    store.resolveObligation({
      sessionId: session.sessionId,
      actorToken: parent.token,
      messageId: required.messageId,
      reason: "Superseded by parent integration decision.",
    });
    store.acknowledgeMessages({
      sessionId: session.sessionId,
      actorToken: workerB.token,
      upToSequence: required.sequence,
    });
    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Parent resolved stale obligation.",
    });
    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "planning");
  } finally {
    cleanup();
  }
});

test("direct phase completion self-heals a fresh boundary ack cutoff for idle workers", () => {
  const { store, cleanup, session, parent, workerA } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Direct complete",
      goal: "Direct completion should not bypass ack freshness.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Complete before direct phase end",
      description: "Finish a small work item.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Work complete.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "agent",
      targetAgentId: workerA.agentId,
      kind: "system",
      body: "Read before phase closes.",
    });
    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      commitSha: "9999999",
    });

    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Direct completion auto-healed the idle boundary ack.",
    });
    assert.equal(store.getSessionSummary(session.sessionId).lifecycleStage, "planning");
  } finally {
    cleanup();
  }
});

test("runtime registration enforces one active runtime per alias and heartbeat recency", () => {
  const { store, cleanup, session, parent, workerA } = setupSession();
  try {
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      agentId: workerA.agentId,
      pid: 123,
      transport: "codex-cli",
      heartbeatIntervalSeconds: 60,
    });

    assert.throws(
      () =>
        store.registerRuntime({
          sessionId: session.sessionId,
          actorToken: workerA.token,
          agentId: workerA.agentId,
          pid: 124,
          transport: "codex-cli",
        }),
      /active runtime/
    );

    const heartbeat = store.heartbeatRuntime({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      runtimeId: runtime.runtimeId,
    });
    assert.equal(heartbeat.status, "running");
    assert.ok(heartbeat.lastSeenAt);

    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "crashed",
      exitCode: 1,
    });
    const replacement = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      agentId: workerA.agentId,
      pid: 125,
      transport: "codex-cli",
    });
    assert.ok(replacement.runtimeId);
  } finally {
    cleanup();
  }
});

test("agent and runtime registration reject non-CLI worker transports", () => {
  const { store, cleanup, session, workerA } = setupSession();
  try {
    assert.throws(
      () =>
        store.registerAgent({
          sessionId: session.sessionId,
          alias: "bad-worker",
          specialty: "invalid",
          cli: "subagent",
          model: "gpt-5",
          role: "worker",
        }),
      /CLI/
    );
    assert.throws(
      () =>
        store.registerRuntime({
          sessionId: session.sessionId,
          actorToken: workerA.token,
          agentId: workerA.agentId,
          pid: 999,
          transport: "built-in-subagent",
        }),
      /CLI/
    );
  } finally {
    cleanup();
  }
});

test("finalization self-heals safe worktree cleanup before session completion", () => {
  const { store, tempDir, cleanup, session, parent, workerA } = setupSession();
  try {
    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Finalize",
      goal: "Complete a short run.",
    });
    const workItem = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Do the work",
      description: "Finish the work.",
      status: "assigned",
      ownerAgentId: workerA.agentId,
    });
    claimWorkItem(store, session.sessionId, workerA, workItem.workItemId);
    const runtime = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      agentId: workerA.agentId,
      pid: 321,
      transport: "codex-cli",
    });
    store.recordResult({
      sessionId: session.sessionId,
      actorToken: workerA.token,
      workItemId: workItem.workItemId,
      resultType: "commit",
      summary: "Work complete.",
      commitSha: "abc1234",
      verificationSummary: "tests passed",
    });
    store.beginIntegration({ sessionId: session.sessionId, actorToken: parent.token, phaseNumber: 1 });
    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      commitSha: "9999999",
    });
    store.completePhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      summary: "Integrated.",
    });
    store.beginFinalizing({ sessionId: session.sessionId, actorToken: parent.token });
    assert.throws(
      () =>
        store.completeSession({
          sessionId: session.sessionId,
          actorToken: parent.token,
          summary: "Should fail while runtime runs.",
        }),
      /worker runtimes/
    );
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: runtime.runtimeId,
      status: "exited",
      exitCode: 0,
    });
    const worktreePath = path.join(tempDir, "session", "worktrees", "api-a");
    mkdirSync(worktreePath, { recursive: true });
    const worktree = store.registerWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerA.agentId,
      path: worktreePath,
      branch: "tw-api-a",
      status: "ready",
    });
    store.completeSession({
      sessionId: session.sessionId,
      actorToken: parent.token,
      summary: "Completed after self-healed finalization cleanup.",
    });
    assert.equal(existsSync(worktreePath), false);
    assert.equal(store.listWorktrees({ sessionId: session.sessionId }).worktrees[0]?.status, "removed");
    assert.equal(store.getSessionSummary(session.sessionId).status, "completed");
    assert.equal(existsSync(path.join(tempDir, "session", "audit-report.md")), true);

    const abandoned = store.createSession({
      parentAlias: "parent",
      title: "Abandoned session",
      taskSlug: "abandoned",
      projectRoot: "/repo",
    });
    const abandonedParent = store.registerAgent({
      sessionId: abandoned.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    store.abandonSession({
      sessionId: abandoned.sessionId,
      actorToken: abandonedParent.token,
      reason: "Manual stop.",
    });

    const dashboard = store.listSessionsForDashboard();
    assert.equal(dashboard.some((entry: any) => entry.sessionId === abandoned.sessionId), false);
    assert.equal(dashboard.some((entry: any) => entry.sessionId === session.sessionId), true);
    store.archiveSession({
      sessionId: abandoned.sessionId,
      actorToken: abandonedParent.token,
      reason: "No longer relevant.",
    });
    assert.equal(store.listSessionsForDashboard({ includeArchived: true }).length >= 2, true);
  } finally {
    cleanup();
  }
});

test("janitor abandons stale active sessions and removes safe terminal worktrees", () => {
  const { store, tempDir, cleanup } = createStore();
  try {
    const workspace = path.join(tempDir, "safe-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });
    const session = store.createSession({
      parentAlias: "parent",
      title: "Stale session",
      taskSlug: "stale",
      projectRoot: "/repo",
      sessionWorkspacePath: workspace,
    });
    const parent = store.registerAgent({
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    const worker = store.registerAgent({
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "backend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });
    store.registerWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "tw-worker-a",
      status: "ready",
    });

    const result = store.runJanitor({ ttlHours: 0, worktreeGc: true });

    assert.equal(result.abandoned, 1);
    assert.equal(result.removedWorktrees, 1);
    assert.equal(store.getSessionSummary(session.sessionId).status, "abandoned");
    assert.equal(existsSync(worktreePath), false);
    assert.equal(store.listWorktrees({ sessionId: session.sessionId }).worktrees[0]?.status, "removed");
  } finally {
    cleanup();
  }
});
