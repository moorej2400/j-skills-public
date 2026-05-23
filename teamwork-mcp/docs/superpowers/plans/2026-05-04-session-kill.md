# Session Kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard kill action that stops tracked worker CLIs for one session, marks the session abandoned even when some runtimes are already dead, and exposes the action from the session detail page plus dashboard list rows.

**Architecture:** Add one server-owned HTTP mutation at `/api/v2/sessions/:id/kill` that resolves the parent token internally, stops managed runtimes, then normalizes the session to `abandoned` in a new idempotent store helper. On the client, add one shared kill-action component with a single confirmation dialog, then wire it into the detail header and row surfaces using the existing REST refresh + SSE reconciliation flow.

**Tech Stack:** Node HTTP server, TypeScript, better-sqlite3 store, React 18 + Vite, Radix Dialog, Tailwind v3, Sonner toasts, Node `--test` integration/unit tests.

---

## File Structure Map

- **Create:** `src/dashboard-actions.ts`
  - Server-only orchestration for `kill session` HTTP requests
  - Resolves parent token via `store.getSessionResumePacket()`
  - Computes `stoppedCount` / `alreadyStoppedCount` summary

- **Modify:** `src/store.ts`
  - Add an idempotent helper that marks all agents inactive and sets session status to `abandoned` even when the session is already stale

- **Modify:** `src/dashboard-http.ts`
  - Add `POST /api/v2/sessions/:sessionId/kill`

- **Modify:** `dashboard-ui/src/lib/types.ts`
  - Add `KillSessionResult`

- **Modify:** `dashboard-ui/src/lib/api.ts`
  - Add `killSession(sessionId, signal?)`

- **Create:** `dashboard-ui/src/lib/sessionKill.ts`
  - Pure UI helpers for labels and toast copy so the destructive language stays consistent across list and detail views

- **Create:** `dashboard-ui/src/components/session/SessionKillAction.tsx`
  - Shared button + dialog + pending/error/success handling

- **Modify:** `dashboard-ui/src/components/session/SessionHeader.tsx`
  - Add the detail-page kill action slot

- **Modify:** `dashboard-ui/src/components/dashboard/SessionCard.tsx`
  - Add the row-level kill trigger without breaking row navigation

- **Modify:** `dashboard-ui/src/components/dashboard/SessionsGrid.tsx`
  - Thread the shared kill callback into each primary dashboard row

- **Modify:** `dashboard-ui/src/components/dashboard/RecentSessionsList.tsx`
  - Add the same row-level action for the compact recent-sessions list

- **Modify:** `dashboard-ui/src/pages/DashboardPage.tsx`
  - Provide shared refresh callbacks after a successful kill

- **Modify:** `dashboard-ui/src/pages/SessionPage.tsx`
  - Refresh detail after a successful kill and stop relying on live SSE once the session becomes historical

- **Test:** `test/unit/store-v2.test.ts`
  - Unit coverage for the idempotent abandon helper

- **Test:** `test/integration/dashboard-v2.test.ts`
  - HTTP coverage for `POST /api/v2/sessions/:id/kill`

- **Test:** `test/unit/session-kill-ui.test.ts`
  - Pure UI-copy and label coverage for kill action helpers

### Task 1: Add idempotent store normalization for killed sessions

**Files:**
- Modify: `src/store.ts`
- Test: `test/unit/store-v2.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
test("killSessionFromDashboard abandons stale sessions and inactivates every agent", () => {
  const { store, cleanup, session, parent, workerA, workerB } = setupSession();
  try {
    store.registerRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: workerA.agentId,
      transport: "fake-cli",
      managedByServer: true,
    });
    const runtimeId = store.listRuntimes({ sessionId: session.sessionId }).runtimes[0]!.runtimeId;
    store.updateRuntime({
      sessionId: session.sessionId,
      actorToken: parent.token,
      runtimeId,
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
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npm test -- test/unit/store-v2.test.ts`

Expected: FAIL with `store.killSessionFromDashboard is not a function` or equivalent missing-helper failure.

- [ ] **Step 3: Write the minimal store helper**

```ts
killSessionFromDashboard(input: { sessionId: string; reason: string }) {
  this.requireSession(input.sessionId);
  const now = this.now();
  this.db
    .prepare(
      `UPDATE sessions
       SET status = 'abandoned',
           terminal_reason = ?,
           abandoned_at = COALESCE(abandoned_at, ?),
           updated_at = ?
       WHERE id = ?`
    )
    .run(input.reason, now, now, input.sessionId);
  this.db
    .prepare(
      `UPDATE agents
       SET status = 'inactive',
           status_note = ?,
           updated_at = ?
       WHERE session_id = ?`
    )
    .run("Killed from dashboard", now, input.sessionId);
  this.recordDebugEvent({
    sessionId: input.sessionId,
    eventType: "lifecycle_transition",
    toolName: "dashboard_kill_session",
    payload: { status: "abandoned", reason: input.reason },
  });
  return { sessionId: input.sessionId, status: "abandoned" as const };
}
```

- [ ] **Step 4: Run the unit test again**

Run: `npm test -- test/unit/store-v2.test.ts`

Expected: PASS for the new `killSessionFromDashboard` case.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/unit/store-v2.test.ts
git commit -m "feat: add idempotent dashboard kill session state"
```

### Task 2: Add the HTTP kill endpoint and prove it stops a live fake worker

**Files:**
- Create: `src/dashboard-actions.ts`
- Modify: `src/dashboard-http.ts`
- Test: `test/integration/dashboard-v2.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
describe("teamwork-mcp dashboard session kill", () => {
  let server: ChildProcess;
  let tmpDir: string;
  let sid: string;
  let fakeCli: ReturnType<typeof createFakeCliFixture>;

  before(async () => {
    fakeCli = createFakeCliFixture();
    const s = await startServer({ TEAMWORK_FAKE_CLI_PATH: fakeCli.cliPath });
    server = s.server;
    tmpDir = s.tmpDir;
    await s.waitReady();
    sid = await initSession("dashboard-kill-client");
  });

  after(() => {
    stopServer(server, tmpDir);
    fakeCli.cleanup();
  });

  it("POST /api/v2/sessions/:id/kill stops managed workers and is idempotent", async () => {
    const workspace = path.join(tmpDir, "kill-session");
    const worktreePath = path.join(workspace, "worktrees", "worker-a");
    mkdirSync(worktreePath, { recursive: true });

    const session = await callTool(sid, "tw_create_session", {
      parentAlias: "parent",
      title: "Kill route test",
      taskSlug: "kill-route",
      projectRoot: tmpDir,
      sessionWorkspacePath: workspace,
      taskPrompt: "Exercise dashboard kill.",
    }, 701);
    const parent = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "parent",
      specialty: "orchestrator",
      cli: "codex",
      model: "gpt-5",
      role: "parent",
    }, 702);
    const worker = await callTool(sid, "tw_register_agent", {
      sessionId: session.sessionId,
      alias: "worker-a",
      specialty: "fake specialist",
      cli: "fake",
      model: "fake-model",
      role: "worker",
    }, 703);
    const worktree = await callTool(sid, "tw_register_worktree", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      agentId: worker.agentId,
      path: worktreePath,
      branch: "kill-route-worker",
      status: "ready",
    }, 704);
    await callTool(sid, "tw_start_phase", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Kill phase",
      goal: "Launch a fake worker and kill it from HTTP.",
    }, 705);
    const workItem = await callTool(sid, "tw_upsert_work_item", {
      sessionId: session.sessionId,
      actorToken: parent.token,
      phaseNumber: 1,
      title: "Hold fake worker open",
      description: "Exercise kill endpoint.",
      status: "assigned",
      ownerAgentId: worker.agentId,
    }, 706);
    await callTool(sid, "teamwork", {
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
    }, 707);

    const killRes = await fetch(`${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/kill`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(killRes.status, 200);
    const killBody = await killRes.json();
    assert.equal(killBody.status, "abandoned");
    assert.equal(killBody.stoppedCount, 1);

    const secondKillRes = await fetch(`${BASE_URL}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/kill`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(secondKillRes.status, 200);
    const secondKillBody = await secondKillRes.json();
    assert.equal(secondKillBody.status, "abandoned");
    assert.equal(secondKillBody.alreadyStoppedCount >= 1, true);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test -- test/integration/dashboard-v2.test.ts`

Expected: FAIL with `405 method not allowed` or `404 not found` for the new kill route.

- [ ] **Step 3: Implement the server-owned endpoint**

```ts
// src/dashboard-actions.ts
export async function killSessionFromDashboard(
  store: TeamworkStore,
  workerSupervisor: WorkerSupervisor,
  sessionId: string,
) {
  const resume = store.getSessionResumePacket({ sessionId });
  const actorToken = resume.parent.actorToken;
  const runtimes = store.listRuntimes({ sessionId }).runtimes;
  const running = runtimes.filter((runtime) => runtime.managedByServer && runtime.status === "running");

  const stopped = workerSupervisor.stopSessionWorkers({ sessionId, actorToken }).stopped;
  const summary = store.killSessionFromDashboard({
    sessionId,
    reason: "Killed from dashboard",
  });

  return {
    sessionId,
    status: summary.status,
    stoppedCount: stopped.length,
    alreadyStoppedCount: Math.max(runtimes.length - stopped.length, 0),
    agentCount: resume.agents.length,
    terminalReason: "Killed from dashboard",
  };
}
```

```ts
// src/dashboard-http.ts
const killMatch = pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/kill$/);
if (killMatch) {
  if (req.method !== "POST") { methodNotAllowed(res, "POST"); return true; }
  const sessionId = decodeURIComponent(killMatch[1] ?? "");
  if (!sessionId) { badRequest(res, "missing session id"); return true; }
  try {
    sendJson(res, 200, await killSessionFromDashboard(store, workerSupervisor, sessionId));
  } catch {
    notFound(res, "session not found");
  }
  return true;
}
```

- [ ] **Step 4: Run the integration test again**

Run: `npm test -- test/integration/dashboard-v2.test.ts`

Expected: PASS for the new kill-route coverage.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-actions.ts src/dashboard-http.ts test/integration/dashboard-v2.test.ts
git commit -m "feat: add dashboard session kill endpoint"
```

### Task 3: Add shared client helpers and mutation API

**Files:**
- Modify: `dashboard-ui/src/lib/types.ts`
- Modify: `dashboard-ui/src/lib/api.ts`
- Create: `dashboard-ui/src/lib/sessionKill.ts`
- Test: `test/unit/session-kill-ui.test.ts`

- [ ] **Step 1: Write the failing UI-helper test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { getSessionKillLabel, formatKillToast } from "../../dashboard-ui/src/lib/sessionKill.ts";

test("session kill helpers keep labels and toast copy consistent", () => {
  assert.equal(getSessionKillLabel("active"), "Kill session");
  assert.equal(getSessionKillLabel("completed"), "Force abandon");
  assert.equal(
    formatKillToast({
      sessionId: "sid",
      status: "abandoned",
      stoppedCount: 1,
      alreadyStoppedCount: 2,
      agentCount: 4,
      terminalReason: "Killed from dashboard",
    }),
    "Session abandoned. Stopped 1 runtime; 2 were already stopped."
  );
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npm test -- test/unit/session-kill-ui.test.ts`

Expected: FAIL with missing module or missing exported helpers.

- [ ] **Step 3: Add the client-side kill contract**

```ts
// dashboard-ui/src/lib/types.ts
export type KillSessionResult = {
  sessionId: string;
  status: "abandoned";
  stoppedCount: number;
  alreadyStoppedCount: number;
  agentCount: number;
  terminalReason: string;
};
```

```ts
// dashboard-ui/src/lib/api.ts
async function getJson<T>(url: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
    signal,
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return (await res.json()) as T;
}

export function killSession(id: string, signal?: AbortSignal): Promise<KillSessionResult> {
  return getJson<KillSessionResult>(
    `/api/v2/sessions/${encodeURIComponent(id)}/kill`,
    signal,
    { method: "POST" },
  );
}
```

```ts
// dashboard-ui/src/lib/sessionKill.ts
import type { KillSessionResult, Session["status"] } from "./types";

export function getSessionKillLabel(status: Session["status"] | undefined): string {
  return status === "active" ? "Kill session" : "Force abandon";
}

export function formatKillToast(result: KillSessionResult): string {
  return `Session abandoned. Stopped ${result.stoppedCount} runtime; ${result.alreadyStoppedCount} were already stopped.`;
}
```

- [ ] **Step 4: Run the new UI-helper test**

Run: `npm test -- test/unit/session-kill-ui.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard-ui/src/lib/types.ts dashboard-ui/src/lib/api.ts dashboard-ui/src/lib/sessionKill.ts test/unit/session-kill-ui.test.ts
git commit -m "feat: add dashboard session kill client contract"
```

### Task 4: Wire the shared kill action into detail and list surfaces

**Files:**
- Create: `dashboard-ui/src/components/session/SessionKillAction.tsx`
- Modify: `dashboard-ui/src/components/session/SessionHeader.tsx`
- Modify: `dashboard-ui/src/components/dashboard/SessionCard.tsx`
- Modify: `dashboard-ui/src/components/dashboard/SessionsGrid.tsx`
- Modify: `dashboard-ui/src/components/dashboard/RecentSessionsList.tsx`
- Modify: `dashboard-ui/src/pages/DashboardPage.tsx`
- Modify: `dashboard-ui/src/pages/SessionPage.tsx`

- [ ] **Step 1: Write the minimal shared action component**

```tsx
export function SessionKillAction({
  sessionId,
  status,
  onSuccess,
  variant = "detail",
}: {
  sessionId: string;
  status: Session["status"] | undefined;
  onSuccess?: () => void | Promise<void>;
  variant?: "detail" | "row";
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = getSessionKillLabel(status);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      const result = await killSession(sessionId);
      toast.success(formatKillToast(result));
      setOpen(false);
      await onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not kill session");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant={variant === "detail" ? "destructive" : "ghost"} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            Stop tracked worker CLIs, mark all agents inactive, and set this session to abandoned.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={pending}>
            {pending ? "Stopping session..." : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount it in the detail header**

```tsx
// dashboard-ui/src/components/session/SessionHeader.tsx
type Props = {
  detail: SessionDetail;
  onKillSuccess?: () => void | Promise<void>;
};

<div className="flex items-start justify-between gap-3">
  <div className="space-y-1">
    {/* existing title + slug + badges */}
  </div>
  <SessionKillAction
    sessionId={session.id}
    status={session.status}
    onSuccess={onKillSuccess}
    variant="detail"
  />
</div>
```

- [ ] **Step 3: Mount it in both row surfaces without breaking navigation**

```tsx
// dashboard-ui/src/components/dashboard/SessionCard.tsx
export type SessionCardProps = {
  session: SessionSummary;
  agents: Agent[];
  recentMessageTimestamps: string[];
  lastActivityAt?: string;
  onKilled?: (sessionId: string) => void | Promise<void>;
  index?: number;
  tabIndex?: number;
  linkRef?: (el: HTMLAnchorElement | null) => void;
  onFocus?: (e: React.FocusEvent<HTMLAnchorElement>) => void;
};

<div
  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
  onClick={(event) => event.preventDefault()}
>
  <SessionKillAction
    sessionId={session.id}
    status={session.status}
    onSuccess={() => onKilled?.(session.id)}
    variant="row"
  />
</div>
```

```tsx
// dashboard-ui/src/components/dashboard/SessionsGrid.tsx
export type SessionsGridProps = {
  sessions: SessionSummary[];
  agentsBySession: Record<string, Agent[]>;
  recentMessagesBySession: Record<string, string[]>;
  lastActivityBySession: Record<string, string | undefined>;
  onKilled?: (sessionId: string) => void | Promise<void>;
  loading?: boolean;
};

<SessionCard
  key={session.id}
  index={idx}
  session={session}
  agents={agentsBySession[session.id] ?? []}
  recentMessageTimestamps={recentMessagesBySession[session.id] ?? []}
  lastActivityAt={lastActivityBySession[session.id]}
  onKilled={onKilled}
  tabIndex={item.tabIndex}
  linkRef={item.ref as (el: HTMLAnchorElement | null) => void}
  onFocus={item.onFocus as (e: React.FocusEvent<HTMLAnchorElement>) => void}
/>
```

```tsx
// dashboard-ui/src/components/dashboard/RecentSessionsList.tsx
export function RecentSessionsList({
  sessions,
  onKilled,
}: {
  sessions: SessionSummary[];
  onKilled?: (sessionId: string) => void | Promise<void>;
}): JSX.Element | null {

<div className="flex items-center gap-2">
  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
    {relativeTime(session.createdAt, nowMs)}
  </span>
  <div onClick={(event) => event.preventDefault()}>
    <SessionKillAction
      sessionId={session.id}
      status={session.status}
      onSuccess={() => onKilled?.(session.id)}
      variant="row"
    />
  </div>
</div>
```

- [ ] **Step 4: Refresh list/detail state after a successful kill**

```ts
// dashboard-ui/src/pages/DashboardPage.tsx
const refreshAllSessions = () =>
  Promise.allSettled(
    Object.values(summariesMap).map((summary) => getSessionDetail(summary.id).then((detail) => mergeDetail(detail)))
  ).then(() =>
    listSessions({ includeStopped: true, sinceDays: 14 }).then((summaries) => setSummaries(summaries))
  );
```

```ts
// dashboard-ui/src/pages/SessionPage.tsx
const refreshCurrentSession = useCallback(() => {
  if (!sessionId) return Promise.resolve();
  return getSessionDetail(sessionId).then((d) => mergeDetail(d));
}, [sessionId, mergeDetail]);

<SessionHeader detail={detail} onKillSuccess={refreshCurrentSession} />
```

```tsx
// dashboard-ui/src/pages/DashboardPage.tsx
<SessionsGrid
  sessions={activeSessions}
  agentsBySession={agentsBySession}
  recentMessagesBySession={recentMessagesBySession}
  lastActivityBySession={lastActivityBySession}
  loading={loading}
  onKilled={() => refreshAllSessions()}
/>

<RecentSessionsList sessions={recentSessions} onKilled={() => refreshAllSessions()} />
```

- [ ] **Step 5: Run the full verification set**

Run:

```bash
npm test -- test/unit/store-v2.test.ts
npm test -- test/integration/dashboard-v2.test.ts
cd dashboard-ui && npm run build
cd .. && npm run build
```

Expected:

- new store test passes
- new dashboard HTTP kill-route test passes
- dashboard UI build passes without type errors
- root build passes

- [ ] **Step 6: Commit**

```bash
git add \
  dashboard-ui/src/components/session/SessionKillAction.tsx \
  dashboard-ui/src/components/session/SessionHeader.tsx \
  dashboard-ui/src/components/dashboard/SessionCard.tsx \
  dashboard-ui/src/components/dashboard/SessionsGrid.tsx \
  dashboard-ui/src/components/dashboard/RecentSessionsList.tsx \
  dashboard-ui/src/pages/DashboardPage.tsx \
  dashboard-ui/src/pages/SessionPage.tsx
git commit -m "feat: wire dashboard session kill controls"
```
