import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";

export type SessionStatus = "active" | "completed";
export type AgentRole = "parent" | "worker";
export type AgentStatus = "active" | "blocked" | "done" | "inactive";
export type MessageTarget = "broadcast" | "agent";
export type MessageKind = "status" | "question" | "answer" | "handoff" | "system";
export type WorkItemStatus = "planned" | "assigned" | "in-progress" | "blocked" | "done";
export type PhaseStatus = "active" | "completed";

// --- New types for the additive rework ---
export type WorktreeStatus = "creating" | "ready" | "dirty" | "merged" | "failed";
export type RuntimeStatus = "running" | "exited" | "crashed";
export type ResultType = "commit" | "artifact" | "test-report" | "note";
export type IntegrationEventKind = "merge" | "cherry-pick" | "conflict" | "resolved" | "reverted";
export type CheckpointKind = "phase-start" | "phase-end" | "manual";

type SessionRow = {
  id: string;
  title: string;
  task_slug: string;
  project_root: string;
  status: SessionStatus;
  current_phase_number: number | null;
  current_phase_title: string | null;
  current_phase_goal: string | null;
  completed_summary: string | null;
  created_at: string;
  updated_at: string;
};

type AgentRow = {
  id: string;
  session_id: string;
  alias: string;
  specialty: string;
  cli: string;
  model: string;
  role: AgentRole;
  token: string;
  status: AgentStatus;
  status_note: string | null;
  last_ack_sequence: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type WorkItemRow = {
  id: string;
  session_id: string;
  phase_number: number;
  title: string;
  description: string;
  acceptance_criteria: string | null;
  owner_agent_id: string | null;
  status: WorkItemStatus;
  depends_on_ids: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  sequence: number;
  sender_agent_id: string;
  target_type: MessageTarget;
  target_agent_id: string | null;
  kind: MessageKind;
  body: string;
  related_work_item_id: string | null;
  created_at: string;
};

type PhaseRow = {
  id: string;
  session_id: string;
  phase_number: number;
  title: string;
  goal: string;
  status: PhaseStatus;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
};

type WorktreeRow = {
  id: string;
  session_id: string;
  agent_id: string;
  path: string;
  branch: string;
  base_commit: string | null;
  status: WorktreeStatus;
  created_at: string;
  updated_at: string;
};

type RuntimeRow = {
  id: string;
  session_id: string;
  agent_id: string;
  pid: number | null;
  transport: string;
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  status: RuntimeStatus;
  updated_at: string;
};

type ResultRow = {
  id: string;
  session_id: string;
  work_item_id: string;
  agent_id: string;
  result_type: ResultType;
  summary: string;
  data: string | null;
  created_at: string;
};

type IntegrationEventRow = {
  id: string;
  session_id: string;
  phase_number: number;
  kind: IntegrationEventKind;
  source_branch: string | null;
  target_branch: string | null;
  commit_sha: string | null;
  details: string | null;
  agent_id: string;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  session_id: string;
  phase_number: number;
  kind: CheckpointKind;
  label: string;
  snapshot: string;
  created_at: string;
};

export class TeamworkStore {
  private readonly db: Database.Database;

  constructor(options: { dbPath: string }) {
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  close() {
    this.db.close();
  }

  createSession(input: {
    parentAlias: string;
    title: string;
    taskSlug: string;
    projectRoot: string;
  }) {
    const sessionId = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
          current_phase_goal, completed_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, ?, ?)`
      )
      .run(sessionId, input.title, input.taskSlug, input.projectRoot, now, now);

    return {
      sessionId,
      status: "active" as const,
    };
  }

  registerAgent(input: {
    sessionId: string;
    alias: string;
    specialty: string;
    cli: string;
    model: string;
    role: AgentRole;
  }) {
    this.requireSession(input.sessionId);
    const agentId = randomUUID();
    const token = randomBytes(24).toString("hex");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agents (
          id, session_id, alias, specialty, cli, model, role, token, status, status_note,
          last_ack_sequence, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?, ?)`
      )
      .run(
        agentId,
        input.sessionId,
        input.alias,
        input.specialty,
        input.cli,
        input.model,
        input.role,
        token,
        now,
        now,
        now
      );

    return {
      agentId,
      token,
      alias: input.alias,
      specialty: input.specialty,
      role: input.role,
    };
  }

  startPhase(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
    title: string;
    goal: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const existing = this.db
      .prepare(
        `SELECT id FROM phases WHERE session_id = ? AND phase_number = ?`
      )
      .get(input.sessionId, input.phaseNumber) as { id: string } | undefined;
    const now = this.now();

    if (existing) {
      this.db
        .prepare(
          `UPDATE phases
           SET title = ?, goal = ?, status = 'active', completed_at = NULL, summary = NULL
           WHERE id = ?`
        )
        .run(input.title, input.goal, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO phases (
            id, session_id, phase_number, title, goal, status, started_at, completed_at, summary
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL)`
        )
        .run(randomUUID(), input.sessionId, input.phaseNumber, input.title, input.goal, now);
    }

    this.db
      .prepare(
        `UPDATE sessions
         SET current_phase_number = ?, current_phase_title = ?, current_phase_goal = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.phaseNumber, input.title, input.goal, now, input.sessionId);
  }

  completePhase(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
    summary: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const phase = this.requirePhase(input.sessionId, input.phaseNumber);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE phases
         SET status = 'completed', completed_at = ?, summary = ?
         WHERE id = ?`
      )
      .run(now, input.summary, phase.id);
    this.db
      .prepare(
        `UPDATE sessions
         SET updated_at = ?
         WHERE id = ?`
      )
      .run(now, input.sessionId);
  }

  upsertWorkItem(input: {
    sessionId: string;
    actorToken: string;
    workItemId?: string;
    phaseNumber: number;
    title: string;
    description: string;
    acceptanceCriteria?: string;
    ownerAgentId?: string;
    status?: WorkItemStatus;
    dependsOnIds?: string[];
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const owner = input.ownerAgentId ? this.requireAgentById(input.ownerAgentId) : undefined;
    if (owner && owner.session_id !== input.sessionId) {
      throw new Error("Owner agent does not belong to this session");
    }

    const now = this.now();
    const dependsOnIds = JSON.stringify(input.dependsOnIds ?? []);
    const status = input.status ?? "planned";

    if (input.workItemId) {
      this.requireWorkItem(input.workItemId);
      this.db
        .prepare(
          `UPDATE work_items
           SET phase_number = ?, title = ?, description = ?, acceptance_criteria = ?,
               owner_agent_id = ?, status = ?, depends_on_ids = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.phaseNumber,
          input.title,
          input.description,
          input.acceptanceCriteria ?? null,
          input.ownerAgentId ?? null,
          status,
          dependsOnIds,
          now,
          input.workItemId
        );
      return {
        workItemId: input.workItemId,
      };
    }

    const workItemId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO work_items (
          id, session_id, phase_number, title, description, acceptance_criteria,
          owner_agent_id, status, depends_on_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workItemId,
        input.sessionId,
        input.phaseNumber,
        input.title,
        input.description,
        input.acceptanceCriteria ?? null,
        input.ownerAgentId ?? null,
        status,
        dependsOnIds,
        now,
        now
      );

    return {
      workItemId,
    };
  }

  listWorkItems(input: { sessionId: string; phaseNumber?: number }) {
    this.requireSession(input.sessionId);
    const rows = (input.phaseNumber === undefined
      ? this.db
          .prepare(
            `SELECT id, session_id, phase_number, title, description, acceptance_criteria,
                    owner_agent_id, status, depends_on_ids, created_at, updated_at
             FROM work_items
             WHERE session_id = ?
             ORDER BY phase_number ASC, created_at ASC`
          )
          .all(input.sessionId)
      : this.db
          .prepare(
            `SELECT id, session_id, phase_number, title, description, acceptance_criteria,
                    owner_agent_id, status, depends_on_ids, created_at, updated_at
             FROM work_items
             WHERE session_id = ? AND phase_number = ?
             ORDER BY created_at ASC`
          )
          .all(input.sessionId, input.phaseNumber)) as WorkItemRow[];

    return {
      workItems: rows.map((row) => this.mapWorkItem(row)),
    };
  }

  sendMessage(input: {
    sessionId: string;
    actorToken: string;
    target: MessageTarget;
    targetAgentId?: string;
    kind: MessageKind;
    body: string;
    relatedWorkItemId?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    if (input.target === "agent") {
      if (!input.targetAgentId) {
        throw new Error("targetAgentId is required for direct messages");
      }
      const target = this.requireAgentById(input.targetAgentId);
      if (target.session_id !== input.sessionId) {
        throw new Error("Target agent does not belong to this session");
      }
    }

    const messageId = randomUUID();
    const sequence = this.nextSequence(input.sessionId);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO messages (
          id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind, body,
          related_work_item_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        input.sessionId,
        sequence,
        actor.id,
        input.target,
        input.targetAgentId ?? null,
        input.kind,
        input.body,
        input.relatedWorkItemId ?? null,
        now
      );
    this.touchAgent(actor.id);
    this.touchSession(input.sessionId);

    return {
      messageId,
      sequence,
      createdAt: now,
    };
  }

  listMessagesSince(input: {
    sessionId: string;
    actorToken: string;
    afterSequence: number;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const rows = (actor.role === "parent"
      ? this.db
          .prepare(
            `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                    body, related_work_item_id, created_at
             FROM messages
             WHERE session_id = ? AND sequence > ?
             ORDER BY sequence ASC`
          )
          .all(input.sessionId, input.afterSequence)
      : this.db
          .prepare(
            `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                    body, related_work_item_id, created_at
             FROM messages
             WHERE session_id = ?
               AND sequence > ?
               AND (
                 target_type = 'broadcast'
                 OR target_agent_id = ?
                 OR sender_agent_id = ?
               )
             ORDER BY sequence ASC`
          )
          .all(input.sessionId, input.afterSequence, actor.id, actor.id)) as MessageRow[];

    this.touchAgent(actor.id);

    return {
      messages: rows.map((row) => this.mapMessage(row)),
    };
  }

  acknowledgeMessages(input: {
    sessionId: string;
    actorToken: string;
    upToSequence: number;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    this.db
      .prepare(
        `UPDATE agents
         SET last_ack_sequence = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.upToSequence, this.now(), this.now(), actor.id);
  }

  setAgentStatus(input: {
    sessionId: string;
    actorToken: string;
    status: AgentStatus;
    note?: string;
    targetAgentId?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const target = input.targetAgentId ? this.requireAgentById(input.targetAgentId) : actor;
    if (target.session_id !== input.sessionId) {
      throw new Error("Target agent does not belong to this session");
    }
    if (actor.role !== "parent" && actor.id !== target.id) {
      throw new Error("Only the parent may update another agent's status");
    }

    this.db
      .prepare(
        `UPDATE agents
         SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.status, input.note ?? null, this.now(), this.now(), target.id);
    this.touchSession(input.sessionId);
  }

  completeSession(input: {
    sessionId: string;
    actorToken: string;
    summary: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'completed', completed_summary = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.summary, this.now(), input.sessionId);
  }

  // --- Worktree management ---

  registerWorktree(input: {
    sessionId: string;
    actorToken: string;
    agentId: string;
    path: string;
    branch: string;
    baseCommit?: string;
    status?: WorktreeStatus;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const agent = this.requireAgentById(input.agentId);
    if (agent.session_id !== input.sessionId) {
      throw new Error("Agent does not belong to this session");
    }
    const id = randomUUID();
    const now = this.now();
    const status = input.status ?? "creating";
    this.db
      .prepare(
        `INSERT INTO worktrees (id, session_id, agent_id, path, branch, base_commit, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.agentId, input.path, input.branch, input.baseCommit ?? null, status, now, now);
    this.touchSession(input.sessionId);
    return { worktreeId: id, status };
  }

  updateWorktree(input: {
    sessionId: string;
    actorToken: string;
    worktreeId: string;
    status?: WorktreeStatus;
    branch?: string;
    baseCommit?: string;
  }) {
    this.requireActor(input.sessionId, input.actorToken);
    const row = this.db
      .prepare(`SELECT id, session_id FROM worktrees WHERE id = ?`)
      .get(input.worktreeId) as { id: string; session_id: string } | undefined;
    if (!row) throw new Error(`Unknown worktree: ${input.worktreeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Worktree does not belong to this session");

    const now = this.now();
    if (input.status !== undefined) {
      this.db.prepare(`UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?`).run(input.status, now, input.worktreeId);
    }
    if (input.branch !== undefined) {
      this.db.prepare(`UPDATE worktrees SET branch = ?, updated_at = ? WHERE id = ?`).run(input.branch, now, input.worktreeId);
    }
    if (input.baseCommit !== undefined) {
      this.db.prepare(`UPDATE worktrees SET base_commit = ?, updated_at = ? WHERE id = ?`).run(input.baseCommit, now, input.worktreeId);
    }
    this.touchSession(input.sessionId);
    return { worktreeId: input.worktreeId, ok: true };
  }

  getWorktree(worktreeId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, agent_id, path, branch, base_commit, status, created_at, updated_at
         FROM worktrees WHERE id = ?`
      )
      .get(worktreeId) as WorktreeRow | undefined;
    if (!row) throw new Error(`Unknown worktree: ${worktreeId}`);
    return this.mapWorktree(row);
  }

  listWorktrees(input: { sessionId: string; agentId?: string }) {
    this.requireSession(input.sessionId);
    const rows = input.agentId
      ? (this.db
          .prepare(
            `SELECT id, session_id, agent_id, path, branch, base_commit, status, created_at, updated_at
             FROM worktrees WHERE session_id = ? AND agent_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId, input.agentId) as WorktreeRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, agent_id, path, branch, base_commit, status, created_at, updated_at
             FROM worktrees WHERE session_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId) as WorktreeRow[]);
    return { worktrees: rows.map((r) => this.mapWorktree(r)) };
  }

  // --- Runtime tracking ---

  registerRuntime(input: {
    sessionId: string;
    actorToken: string;
    agentId: string;
    pid?: number;
    transport: string;
  }) {
    this.requireActor(input.sessionId, input.actorToken);
    const agent = this.requireAgentById(input.agentId);
    if (agent.session_id !== input.sessionId) {
      throw new Error("Agent does not belong to this session");
    }
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO runtimes (id, session_id, agent_id, pid, transport, started_at, exited_at, exit_code, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'running', ?)`
      )
      .run(id, input.sessionId, input.agentId, input.pid ?? null, input.transport, now, now);
    this.touchSession(input.sessionId);
    return { runtimeId: id, status: "running" as const };
  }

  updateRuntime(input: {
    sessionId: string;
    actorToken: string;
    runtimeId: string;
    status?: RuntimeStatus;
    pid?: number;
    exitCode?: number;
  }) {
    this.requireActor(input.sessionId, input.actorToken);
    const row = this.db
      .prepare(`SELECT id, session_id FROM runtimes WHERE id = ?`)
      .get(input.runtimeId) as { id: string; session_id: string } | undefined;
    if (!row) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Runtime does not belong to this session");

    const now = this.now();
    if (input.status !== undefined) {
      this.db.prepare(`UPDATE runtimes SET status = ?, updated_at = ? WHERE id = ?`).run(input.status, now, input.runtimeId);
      if (input.status === "exited" || input.status === "crashed") {
        this.db.prepare(`UPDATE runtimes SET exited_at = ? WHERE id = ?`).run(now, input.runtimeId);
      }
    }
    if (input.pid !== undefined) {
      this.db.prepare(`UPDATE runtimes SET pid = ?, updated_at = ? WHERE id = ?`).run(input.pid, now, input.runtimeId);
    }
    if (input.exitCode !== undefined) {
      this.db.prepare(`UPDATE runtimes SET exit_code = ?, updated_at = ? WHERE id = ?`).run(input.exitCode, now, input.runtimeId);
    }
    this.touchSession(input.sessionId);
    return { runtimeId: input.runtimeId, ok: true };
  }

  getRuntime(runtimeId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, agent_id, pid, transport, started_at, exited_at, exit_code, status, updated_at
         FROM runtimes WHERE id = ?`
      )
      .get(runtimeId) as RuntimeRow | undefined;
    if (!row) throw new Error(`Unknown runtime: ${runtimeId}`);
    return this.mapRuntime(row);
  }

  listRuntimes(input: { sessionId: string; agentId?: string }) {
    this.requireSession(input.sessionId);
    const rows = input.agentId
      ? (this.db
          .prepare(
            `SELECT id, session_id, agent_id, pid, transport, started_at, exited_at, exit_code, status, updated_at
             FROM runtimes WHERE session_id = ? AND agent_id = ? ORDER BY started_at ASC`
          )
          .all(input.sessionId, input.agentId) as RuntimeRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, agent_id, pid, transport, started_at, exited_at, exit_code, status, updated_at
             FROM runtimes WHERE session_id = ? ORDER BY started_at ASC`
          )
          .all(input.sessionId) as RuntimeRow[]);
    return { runtimes: rows.map((r) => this.mapRuntime(r)) };
  }

  // --- Results ---

  recordResult(input: {
    sessionId: string;
    actorToken: string;
    workItemId: string;
    resultType: ResultType;
    summary: string;
    data?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    this.requireWorkItem(input.workItemId);
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO results (id, session_id, work_item_id, agent_id, result_type, summary, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.workItemId, actor.id, input.resultType, input.summary, input.data ?? null, now);
    this.touchSession(input.sessionId);
    return { resultId: id, createdAt: now };
  }

  getResult(resultId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, result_type, summary, data, created_at
         FROM results WHERE id = ?`
      )
      .get(resultId) as ResultRow | undefined;
    if (!row) throw new Error(`Unknown result: ${resultId}`);
    return this.mapResult(row);
  }

  listResults(input: { sessionId: string; workItemId?: string }) {
    this.requireSession(input.sessionId);
    const rows = input.workItemId
      ? (this.db
          .prepare(
            `SELECT id, session_id, work_item_id, agent_id, result_type, summary, data, created_at
             FROM results WHERE session_id = ? AND work_item_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId, input.workItemId) as ResultRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, work_item_id, agent_id, result_type, summary, data, created_at
             FROM results WHERE session_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId) as ResultRow[]);
    return { results: rows.map((r) => this.mapResult(r)) };
  }

  // --- Integration events ---

  recordIntegrationEvent(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
    kind: IntegrationEventKind;
    sourceBranch?: string;
    targetBranch?: string;
    commitSha?: string;
    details?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO integration_events (id, session_id, phase_number, kind, source_branch, target_branch, commit_sha, details, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, input.sessionId, input.phaseNumber, input.kind,
        input.sourceBranch ?? null, input.targetBranch ?? null,
        input.commitSha ?? null, input.details ?? null,
        actor.id, now
      );
    this.touchSession(input.sessionId);
    return { eventId: id, createdAt: now };
  }

  listIntegrationEvents(input: { sessionId: string; phaseNumber?: number }) {
    this.requireSession(input.sessionId);
    const rows = input.phaseNumber !== undefined
      ? (this.db
          .prepare(
            `SELECT id, session_id, phase_number, kind, source_branch, target_branch, commit_sha, details, agent_id, created_at
             FROM integration_events WHERE session_id = ? AND phase_number = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId, input.phaseNumber) as IntegrationEventRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, phase_number, kind, source_branch, target_branch, commit_sha, details, agent_id, created_at
             FROM integration_events WHERE session_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId) as IntegrationEventRow[]);
    return {
      events: rows.map((r) => this.mapIntegrationEvent(r)),
    };
  }

  // --- Checkpoints ---

  createCheckpoint(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
    kind: CheckpointKind;
    label: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    // Capture a snapshot of the current session state
    const sessionSummary = this.getSessionSummary(input.sessionId);
    const workItems = this.listWorkItems({ sessionId: input.sessionId });
    const worktrees = this.listWorktrees({ sessionId: input.sessionId });
    const snapshot = JSON.stringify({ session: sessionSummary, workItems, worktrees });

    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, phase_number, kind, label, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.phaseNumber, input.kind, input.label, snapshot, now);
    this.touchSession(input.sessionId);
    return { checkpointId: id, createdAt: now };
  }

  getCheckpoint(checkpointId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, phase_number, kind, label, snapshot, created_at
         FROM checkpoints WHERE id = ?`
      )
      .get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new Error(`Unknown checkpoint: ${checkpointId}`);
    return this.mapCheckpoint(row);
  }

  listCheckpoints(input: { sessionId: string; phaseNumber?: number }) {
    this.requireSession(input.sessionId);
    const rows = input.phaseNumber !== undefined
      ? (this.db
          .prepare(
            `SELECT id, session_id, phase_number, kind, label, snapshot, created_at
             FROM checkpoints WHERE session_id = ? AND phase_number = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId, input.phaseNumber) as CheckpointRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, phase_number, kind, label, snapshot, created_at
             FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`
          )
          .all(input.sessionId) as CheckpointRow[]);
    return {
      checkpoints: rows.map((r) => this.mapCheckpoint(r)),
    };
  }

  getSessionSummary(sessionId: string) {
    const session = this.requireSession(sessionId);
    const agents = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, cli, model, role, token, status, status_note,
                last_ack_sequence, last_seen_at, created_at, updated_at
         FROM agents
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(sessionId) as AgentRow[];
    const currentPhase = session.current_phase_number === null
      ? undefined
      : {
          phaseNumber: session.current_phase_number,
          title: session.current_phase_title ?? "",
          goal: session.current_phase_goal ?? "",
        };

    return {
      sessionId: session.id,
      title: session.title,
      taskSlug: session.task_slug,
      projectRoot: session.project_root,
      status: session.status,
      currentPhase,
      agents: agents.map((row) => ({
        agentId: row.id,
        alias: row.alias,
        specialty: row.specialty,
        cli: row.cli,
        model: row.model,
        role: row.role,
        status: row.status,
        statusNote: row.status_note ?? undefined,
        lastAckSequence: row.last_ack_sequence,
      })),
    };
  }

  getAgentState(agentId: string) {
    const agent = this.requireAgentById(agentId);
    return {
      agentId: agent.id,
      alias: agent.alias,
      specialty: agent.specialty,
      role: agent.role,
      status: agent.status,
      note: agent.status_note ?? undefined,
      lastAckSequence: agent.last_ack_sequence,
    };
  }

  listSessionsForDashboard() {
    const sessions = this.db
      .prepare(
        `SELECT id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
                current_phase_goal, completed_summary, created_at, updated_at
         FROM sessions
         ORDER BY updated_at DESC, created_at DESC`
      )
      .all() as SessionRow[];

    return sessions.map((session) => {
      const agents = this.db
        .prepare(
          `SELECT id, session_id, alias, specialty, cli, model, role, token, status, status_note,
                  last_ack_sequence, last_seen_at, created_at, updated_at
           FROM agents
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(session.id) as AgentRow[];
      const workItems = this.db
        .prepare(
          `SELECT id, session_id, phase_number, title, description, acceptance_criteria,
                  owner_agent_id, status, depends_on_ids, created_at, updated_at
           FROM work_items
           WHERE session_id = ?
           ORDER BY phase_number ASC, created_at ASC`
        )
        .all(session.id) as WorkItemRow[];
      const latestMessage = this.db
        .prepare(
          `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind, body,
                  related_work_item_id, created_at
           FROM messages
           WHERE session_id = ?
           ORDER BY sequence DESC
           LIMIT 1`
        )
        .get(session.id) as MessageRow | undefined;
      const worktreeRows = this.db
        .prepare(
          `SELECT id, session_id, agent_id, path, branch, base_commit, status, created_at, updated_at
           FROM worktrees WHERE session_id = ? ORDER BY created_at ASC`
        )
        .all(session.id) as WorktreeRow[];
      const runtimeRows = this.db
        .prepare(
          `SELECT id, session_id, agent_id, pid, transport, started_at, exited_at, exit_code, status, updated_at
           FROM runtimes WHERE session_id = ? AND status = 'running' ORDER BY started_at ASC`
        )
        .all(session.id) as RuntimeRow[];

      return {
        sessionId: session.id,
        title: session.title,
        taskSlug: session.task_slug,
        status: session.status,
        currentPhase: session.current_phase_number === null
          ? undefined
          : {
              phaseNumber: session.current_phase_number,
              title: session.current_phase_title ?? "",
              goal: session.current_phase_goal ?? "",
            },
        activeAgents: agents
          .filter((agent) => agent.status !== "inactive")
          .map((agent) => ({
            agentId: agent.id,
            alias: agent.alias,
            specialty: agent.specialty,
            role: agent.role,
            status: agent.status,
          })),
        workItems: workItems.map((row) => this.mapWorkItem(row)),
        worktrees: worktreeRows.map((row) => this.mapWorktree(row)),
        activeRuntimes: runtimeRows.map((row) => this.mapRuntime(row)),
        latestMessage: latestMessage ? this.mapMessage(latestMessage) : undefined,
      };
    });
  }

  private mapWorkItem(row: WorkItemRow) {
    const owner = row.owner_agent_id ? this.requireAgentById(row.owner_agent_id) : undefined;
    return {
      workItemId: row.id,
      phaseNumber: row.phase_number,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria ?? undefined,
      ownerAgentId: row.owner_agent_id ?? undefined,
      ownerAlias: owner?.alias,
      status: row.status,
      dependsOnIds: JSON.parse(row.depends_on_ids) as string[],
    };
  }

  private mapMessage(row: MessageRow) {
    const sender = this.requireAgentById(row.sender_agent_id);
    return {
      messageId: row.id,
      sequence: row.sequence,
      target: row.target_type,
      targetAgentId: row.target_agent_id ?? undefined,
      kind: row.kind,
      body: row.body,
      senderAgentId: row.sender_agent_id,
      senderAlias: sender.alias,
      relatedWorkItemId: row.related_work_item_id ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapWorktree(row: WorktreeRow) {
    const agent = this.requireAgentById(row.agent_id);
    return {
      worktreeId: row.id,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      path: row.path,
      branch: row.branch,
      baseCommit: row.base_commit ?? undefined,
      status: row.status as WorktreeStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRuntime(row: RuntimeRow) {
    const agent = this.requireAgentById(row.agent_id);
    return {
      runtimeId: row.id,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      pid: row.pid ?? undefined,
      transport: row.transport,
      startedAt: row.started_at,
      exitedAt: row.exited_at ?? undefined,
      exitCode: row.exit_code ?? undefined,
      status: row.status as RuntimeStatus,
      updatedAt: row.updated_at,
    };
  }

  private mapResult(row: ResultRow) {
    const agent = this.requireAgentById(row.agent_id);
    return {
      resultId: row.id,
      workItemId: row.work_item_id,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      resultType: row.result_type as ResultType,
      summary: row.summary,
      data: row.data ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapIntegrationEvent(row: IntegrationEventRow) {
    const agent = this.requireAgentById(row.agent_id);
    return {
      eventId: row.id,
      phaseNumber: row.phase_number,
      kind: row.kind as IntegrationEventKind,
      sourceBranch: row.source_branch ?? undefined,
      targetBranch: row.target_branch ?? undefined,
      commitSha: row.commit_sha ?? undefined,
      details: row.details ?? undefined,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      createdAt: row.created_at,
    };
  }

  private mapCheckpoint(row: CheckpointRow) {
    return {
      checkpointId: row.id,
      phaseNumber: row.phase_number,
      kind: row.kind as CheckpointKind,
      label: row.label,
      snapshot: JSON.parse(row.snapshot),
      createdAt: row.created_at,
    };
  }

  private requireSession(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
                current_phase_goal, completed_summary, created_at, updated_at
         FROM sessions
         WHERE id = ?`
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return row;
  }

  private requireActor(sessionId: string, token: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, cli, model, role, token, status, status_note,
                last_ack_sequence, last_seen_at, created_at, updated_at
         FROM agents
         WHERE token = ?`
      )
      .get(token) as AgentRow | undefined;
    if (!row) {
      throw new Error("Unknown actor token");
    }
    if (row.session_id !== sessionId) {
      throw new Error("Actor token does not belong to this session");
    }
    return row;
  }

  private requireParent(sessionId: string, token: string) {
    const actor = this.requireActor(sessionId, token);
    if (actor.role !== "parent") {
      throw new Error("Parent token required");
    }
    return actor;
  }

  private requireAgentById(agentId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, cli, model, role, token, status, status_note,
                last_ack_sequence, last_seen_at, created_at, updated_at
         FROM agents
         WHERE id = ?`
      )
      .get(agentId) as AgentRow | undefined;
    if (!row) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return row;
  }

  private requirePhase(sessionId: string, phaseNumber: number) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, phase_number, title, goal, status, started_at, completed_at, summary
         FROM phases
         WHERE session_id = ? AND phase_number = ?`
      )
      .get(sessionId, phaseNumber) as PhaseRow | undefined;
    if (!row) {
      throw new Error(`Unknown phase: ${phaseNumber}`);
    }
    return row;
  }

  private requireWorkItem(workItemId: string) {
    const row = this.db
      .prepare(
        `SELECT id FROM work_items WHERE id = ?`
      )
      .get(workItemId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`Unknown work item: ${workItemId}`);
    }
    return row;
  }

  private nextSequence(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
         FROM messages
         WHERE session_id = ?`
      )
      .get(sessionId) as { max_sequence: number };
    return row.max_sequence + 1;
  }

  private touchAgent(agentId: string) {
    this.db
      .prepare(
        `UPDATE agents
         SET last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(this.now(), this.now(), agentId);
  }

  private touchSession(sessionId: string) {
    this.db
      .prepare(
        `UPDATE sessions
         SET updated_at = ?
         WHERE id = ?`
      )
      .run(this.now(), sessionId);
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task_slug TEXT NOT NULL,
        project_root TEXT NOT NULL,
        status TEXT NOT NULL,
        current_phase_number INTEGER,
        current_phase_title TEXT,
        current_phase_goal TEXT,
        completed_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        specialty TEXT NOT NULL,
        cli TEXT NOT NULL,
        model TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        status_note TEXT,
        last_ack_sequence INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, alias)
      );

      CREATE TABLE IF NOT EXISTS phases (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        phase_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary TEXT,
        UNIQUE(session_id, phase_number)
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        phase_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        depends_on_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        sender_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        related_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT,
        status TEXT NOT NULL DEFAULT 'creating',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        pid INTEGER,
        transport TEXT NOT NULL,
        started_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        result_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integration_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        phase_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source_branch TEXT,
        target_branch TEXT,
        commit_sha TEXT,
        details TEXT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        phase_number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private now() {
    return new Date().toISOString();
  }
}
