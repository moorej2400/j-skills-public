import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { TeamworkStore } from "../../src/store.js";

function createStore() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "teamwork-mcp-"));
  const dbPath = path.join(tempDir, "teamwork.sqlite");
  const store = new TeamworkStore({ dbPath });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("creates a session, registers agents, and tracks the active phase", () => {
  const { store, cleanup } = createStore();

  try {
    const session = store.createSession({
      parentAlias: "parent",
      title: "Build account settings flow",
      taskSlug: "account-settings",
      projectRoot: "/repo",
    });
    const parent = store.registerAgent({
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    const frontend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "frontend",
      specialty: "frontend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });
    const backend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "backend",
      specialty: "backend",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    });

    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Scaffold endpoint and form",
      goal: "Unlock parallel frontend and backend work.",
    });

    const summary = store.getSessionSummary(session.sessionId);
    assert.equal(summary.currentPhase?.phaseNumber, 1);
    assert.equal(summary.agents.length, 3);
    assert.deepEqual(
      summary.agents.map((agent: { alias: string }) => agent.alias),
      ["parent", "frontend", "backend"]
    );
    assert.equal(summary.status, "active");
  } finally {
    cleanup();
  }
});

test("upserts work items with ownership, dependencies, and per-phase filtering", () => {
  const { store, cleanup } = createStore();

  try {
    const session = store.createSession({
      parentAlias: "parent",
      title: "Build account settings flow",
      taskSlug: "account-settings",
      projectRoot: "/repo",
    });
    const parent = store.registerAgent({
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    const frontend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "frontend",
      specialty: "frontend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });
    const backend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "backend",
      specialty: "backend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });

    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Phase 1",
      goal: "Create the first slice.",
    });

    const apiWork = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Add profile update endpoint",
      description: "Create PATCH /api/profile.",
      acceptanceCriteria: "Integration test passes",
      ownerAgentId: backend.agentId,
      status: "assigned",
    });

    store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Build account form",
      description: "Create settings form bound to API contract.",
      acceptanceCriteria: "Component test passes",
      ownerAgentId: frontend.agentId,
      status: "assigned",
      dependsOnIds: [apiWork.workItemId],
    });

    const phaseOne = store.listWorkItems({ sessionId: session.sessionId, phaseNumber: 1 });
    assert.equal(phaseOne.workItems.length, 2);
    assert.equal(phaseOne.workItems[0]?.ownerAlias, "backend");
    assert.deepEqual(phaseOne.workItems[1]?.dependsOnIds, [apiWork.workItemId]);
  } finally {
    cleanup();
  }
});

test("broadcasts reach all workers while DMs are visible only to sender, target, and parent", () => {
  const { store, cleanup } = createStore();

  try {
    const session = store.createSession({
      parentAlias: "parent",
      title: "Build account settings flow",
      taskSlug: "account-settings",
      projectRoot: "/repo",
    });
    const parent = store.registerAgent({
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    const frontend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "frontend",
      specialty: "frontend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });
    const backend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "backend",
      specialty: "backend",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    });
    const qa = store.registerAgent({
      sessionId: session.sessionId,
      alias: "qa",
      specialty: "qa",
      cli: "copilot",
      model: "gpt-5",
      role: "worker",
    });

    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: frontend.token,
      target: "broadcast",
      kind: "status",
      body: "Frontend form scaffold is ready.",
    });
    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: frontend.token,
      target: "agent",
      targetAgentId: backend.agentId,
      kind: "question",
      body: "Which payload shape are you shipping?",
    });

    const parentView = store.listMessagesSince({
      sessionId: session.sessionId,
      actorToken: parent.token,
      afterSequence: 0,
    });
    const backendView = store.listMessagesSince({
      sessionId: session.sessionId,
      actorToken: backend.token,
      afterSequence: 0,
    });
    const qaView = store.listMessagesSince({
      sessionId: session.sessionId,
      actorToken: qa.token,
      afterSequence: 0,
    });

    assert.equal(parentView.messages.length, 2);
    assert.equal(backendView.messages.length, 2);
    assert.equal(qaView.messages.length, 1);
    assert.equal(qaView.messages[0]?.target, "broadcast");
  } finally {
    cleanup();
  }
});

test("acknowledges messages, updates agent status, and completes the session", () => {
  const { store, cleanup } = createStore();

  try {
    const session = store.createSession({
      parentAlias: "parent",
      title: "Build account settings flow",
      taskSlug: "account-settings",
      projectRoot: "/repo",
    });
    const parent = store.registerAgent({
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    });
    const backend = store.registerAgent({
      sessionId: session.sessionId,
      alias: "backend",
      specialty: "backend",
      cli: "codex",
      model: "gpt-5",
      role: "worker",
    });

    const sent = store.sendMessage({
      sessionId: session.sessionId,
      actorToken: parent.token,
      target: "agent",
      targetAgentId: backend.agentId,
      kind: "status",
      body: "Please run the integration test suite.",
    });

    store.acknowledgeMessages({
      sessionId: session.sessionId,
      actorToken: backend.token,
      upToSequence: sent.sequence,
    });
    store.setAgentStatus({
      sessionId: session.sessionId,
      actorToken: backend.token,
      status: "blocked",
      note: "Waiting on seed data migration.",
    });
    store.completeSession({
      sessionId: session.sessionId,
      actorToken: parent.token,
      summary: "Integrated worker output into main.",
    });

    const backendState = store.getAgentState(backend.agentId);
    const summary = store.getSessionSummary(session.sessionId);

    assert.equal(backendState.lastAckSequence, sent.sequence);
    assert.equal(backendState.status, "blocked");
    assert.equal(summary.status, "completed");
  } finally {
    cleanup();
  }
});

// --- New store method tests ---

function setupSessionWithWorker() {
  const { store, cleanup } = createStore();
  const session = store.createSession({
    parentAlias: "parent",
    title: "Test session",
    taskSlug: "test",
    projectRoot: "/repo",
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
  store.startPhase({
    sessionId: session.sessionId,
    actorToken: parent.token,
    phaseNumber: 1,
    title: "Phase 1",
    goal: "Implement backend.",
  });
  return { store, cleanup, session, parent, worker };
}

test("registers, lists, and updates worktrees for agents", () => {
  const { store, cleanup, session, parent, worker } = setupSessionWithWorker();
  try {
    const wt = store.registerWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: "/repo/.worktrees/worker-a",
      branch: "tw-worker-a",
      baseCommit: "abc123",
      status: "ready",
    });
    assert.ok(wt.worktreeId);
    assert.equal(wt.status, "ready");

    const listed = store.listWorktrees({ sessionId: session.sessionId });
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0]?.branch, "tw-worker-a");
    assert.equal(listed.worktrees[0]?.agentAlias, "worker-a");

    store.updateWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      worktreeId: wt.worktreeId,
      status: "dirty",
    });
    const fetched = store.getWorktree(wt.worktreeId);
    assert.equal(fetched.status, "dirty");
  } finally {
    cleanup();
  }
});

test("registers and updates runtimes with exit tracking", () => {
  const { store, cleanup, session, parent, worker } = setupSessionWithWorker();
  try {
    const rt = store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      pid: 12345,
      transport: "stdio",
    });
    assert.ok(rt.runtimeId);
    assert.equal(rt.status, "running");

    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId: rt.runtimeId,
      status: "exited",
      exitCode: 0,
    });
    const fetched = store.getRuntime(rt.runtimeId);
    assert.equal(fetched.status, "exited");
    assert.equal(fetched.exitCode, 0);
    assert.ok(fetched.exitedAt);

    const listed = store.listRuntimes({ sessionId: session.sessionId });
    assert.equal(listed.runtimes.length, 1);
  } finally {
    cleanup();
  }
});

test("records and lists results for work items", () => {
  const { store, cleanup, session, parent, worker } = setupSessionWithWorker();
  try {
    const wi = store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Implement API",
      description: "Build the REST endpoint.",
      ownerAgentId: worker.agentId,
      status: "in-progress",
    });

    const result = store.recordResult({
      sessionId: session.sessionId,
      actorToken: worker.token,
      workItemId: wi.workItemId,
      resultType: "commit",
      summary: "Added PATCH /api/profile endpoint",
      data: JSON.stringify({ sha: "def456", filesChanged: 3 }),
    });
    assert.ok(result.resultId);

    const fetched = store.getResult(result.resultId);
    assert.equal(fetched.resultType, "commit");
    assert.equal(fetched.agentAlias, "worker-a");
    assert.deepEqual(JSON.parse(fetched.data!), { sha: "def456", filesChanged: 3 });

    const listed = store.listResults({ sessionId: session.sessionId, workItemId: wi.workItemId });
    assert.equal(listed.results.length, 1);
  } finally {
    cleanup();
  }
});

test("records and lists integration events with optional phase filtering", () => {
  const { store, cleanup, session, parent } = setupSessionWithWorker();
  try {
    const evt1 = store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "merge",
      sourceBranch: "tw-worker-a",
      targetBranch: "main",
      commitSha: "abc123",
      details: "Clean merge, no conflicts.",
    });
    assert.ok(evt1.eventId);

    store.recordIntegrationEvent({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "conflict",
      sourceBranch: "tw-worker-b",
      targetBranch: "main",
      details: "Conflict in src/store.ts.",
    });

    const all = store.listIntegrationEvents({ sessionId: session.sessionId });
    assert.equal(all.events.length, 2);
    assert.equal(all.events[0]?.kind, "merge");
    assert.equal(all.events[1]?.kind, "conflict");

    const phase1Only = store.listIntegrationEvents({ sessionId: session.sessionId, phaseNumber: 1 });
    assert.equal(phase1Only.events.length, 2);
  } finally {
    cleanup();
  }
});

test("creates, fetches, and lists checkpoints with session snapshots", () => {
  const { store, cleanup, session, parent, worker } = setupSessionWithWorker();
  try {
    store.registerWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: "/repo/.worktrees/worker-a",
      branch: "tw-worker-a",
    });

    const cp = store.createCheckpoint({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      kind: "phase-start",
      label: "Phase 1 kickoff",
    });
    assert.ok(cp.checkpointId);

    const fetched = store.getCheckpoint(cp.checkpointId);
    assert.equal(fetched.kind, "phase-start");
    assert.equal(fetched.label, "Phase 1 kickoff");
    assert.ok(fetched.snapshot.session);
    assert.ok(fetched.snapshot.worktrees);

    const listed = store.listCheckpoints({ sessionId: session.sessionId });
    assert.equal(listed.checkpoints.length, 1);
  } finally {
    cleanup();
  }
});

test("dashboard listing includes worktrees and active runtimes", () => {
  const { store, cleanup, session, parent, worker } = setupSessionWithWorker();
  try {
    store.registerWorktree({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: "/repo/.worktrees/worker-a",
      branch: "tw-worker-a",
      status: "ready",
    });
    store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      pid: 99999,
      transport: "stdio",
    });

    const dashboard = store.listSessionsForDashboard();
    assert.equal(dashboard.length, 1);
    const s = dashboard[0]!;
    assert.equal(s.worktrees.length, 1);
    assert.equal(s.worktrees[0]?.branch, "tw-worker-a");
    assert.equal(s.activeRuntimes.length, 1);
    assert.equal(s.activeRuntimes[0]?.pid, 99999);
  } finally {
    cleanup();
  }
});
