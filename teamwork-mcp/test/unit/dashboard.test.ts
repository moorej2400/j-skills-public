import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { renderDashboardPage } from "../../src/dashboard.js";
import { TeamworkStore } from "../../src/store.js";

function createStore() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "teamwork-mcp-dashboard-"));
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

test("renders teamwork dashboard cards with phase, workers, work items, and recent traffic", () => {
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

    store.startPhase({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Phase 1",
      goal: "Build the first integrated slice.",
    });
    store.upsertWorkItem({
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Build account form",
      description: "Create the UI for account settings.",
      acceptanceCriteria: "Component test passes",
      ownerAgentId: frontend.agentId,
      status: "assigned",
    });
    store.sendMessage({
      sessionId: session.sessionId,
      actorToken: frontend.token,
      target: "broadcast",
      kind: "status",
      body: "UI scaffold is ready for backend hookup.",
    });

    const html = renderDashboardPage(store.listSessionsForDashboard());

    assert.match(html, /Build account settings flow/);
    assert.match(html, /Phase 1/);
    assert.match(html, /frontend/);
    assert.match(html, /Build account form/);
    assert.match(html, /UI scaffold is ready for backend hookup\./);
    assert.match(html, /Auto-refreshes every 5 seconds\./);
    assert.match(html, /http-equiv="refresh" content="5"/);
  } finally {
    cleanup();
  }
});

test("renders optional worktree, runtime, result, and checkpoint sections when present", () => {
  const html = renderDashboardPage([
    {
      sessionId: "session-1",
      title: "Teamwork MCP rework",
      taskSlug: "teamwork-mcp-rework",
      status: "active",
      currentPhase: {
        phaseNumber: 1,
        title: "Paired planning and implementation",
        goal: "Keep the parent-led workflow while adding operational MCP support.",
      },
      activeAgents: [],
      workItems: [],
      latestMessage: {
        senderAlias: "surface-gpt",
        body: "Dashboard slice is ready for review.",
      },
      worktrees: [
        {
          alias: "surface-gpt",
          status: "ready",
          branch: "tw-phase-01-surface-gpt",
          path: "C:\\repo\\worktrees\\surface-gpt",
        },
      ],
      runtimes: [
        {
          alias: "surface-gpt",
          phaseNumber: 1,
          summary: "Phase packet delivered with worktree path and assigned work item.",
        },
      ],
      results: [
        {
          alias: "surface-gpt",
          status: "passed",
          summary: "npm test succeeded for the dashboard slice.",
        },
      ],
      checkpoints: [
        {
          label: "phase-01 integration",
          status: "completed",
          summary: "Worker commit integrated and worktrees ready for refresh.",
        },
      ],
    },
  ]);

  assert.match(html, /Worktrees/);
  assert.match(html, /Runtime Packets/);
  assert.match(html, /Results/);
  assert.match(html, /Checkpoints/);
  assert.match(html, /tw-phase-01-surface-gpt/);
  assert.match(html, /C:\\repo\\worktrees\\surface-gpt/);
  assert.match(html, /Phase packet delivered with worktree path and assigned work item\./);
  assert.match(html, /npm test succeeded for the dashboard slice\./);
  assert.match(html, /Worker commit integrated and worktrees ready for refresh\./);
});
