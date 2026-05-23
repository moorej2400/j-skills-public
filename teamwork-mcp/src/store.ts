import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SessionStatus = "active" | "completed" | "abandoned" | "archived";
export type LifecycleStage = "planning" | "executing" | "integrating" | "finalizing";
export type AgentRole = "parent" | "worker";
export type AgentStatus = "active" | "idle" | "blocked" | "done" | "inactive";
export type MessageTarget = "broadcast" | "agent";
export type MessageKind = "status" | "question" | "answer" | "handoff" | "system";
export type WorkItemStatus = "planned" | "assigned" | "in-progress" | "blocked" | "done" | "canceled";
export type PhaseStatus = "active" | "completed";

// --- New types for the additive rework ---
export type WorktreeStatus = "creating" | "ready" | "dirty" | "merged" | "failed" | "removed" | "cleanup-needed";
export type RuntimeStatus = "running" | "exited" | "crashed";
export type WorkerLogReadMode = "new" | "tail" | "all";
export type WorkerOutputTailStream = "stdout" | "stderr" | "stdin" | "system" | "runtime";
export type ResultType = "commit" | "artifact" | "test-report" | "note";
export type IntegrationEventKind = "merge" | "cherry-pick" | "conflict" | "resolved" | "reverted";
export type CheckpointKind = "phase-start" | "phase-end" | "manual";

type SessionRow = {
  id: string;
  title: string;
  task_slug: string;
  project_root: string;
  status: SessionStatus;
  lifecycle_stage: LifecycleStage;
  current_phase_number: number | null;
  current_phase_title: string | null;
  current_phase_goal: string | null;
  required_ack_sequence: number | null;
  final_ack_sequence: number | null;
  session_workspace_path: string | null;
  approved_worktree_roots: string | null;
  completed_summary: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
  archived_at: string | null;
};

type AgentRow = {
  id: string;
  session_id: string;
  alias: string;
  specialty: string;
  responsibility: string;
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

type WorkItemClaimRow = {
  id: string;
  session_id: string;
  work_item_id: string;
  agent_id: string;
  claimed_at: string;
  released_at: string | null;
  release_reason: string | null;
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
  reply_to_message_id: string | null;
  requires_response: number;
  requires_ack: number;
  obligation_kind: string | null;
  due_stage: string | null;
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
  adapter: string | null;
  launch_mode: string | null;
  cli_session_id: string | null;
  command: string | null;
  cwd: string | null;
  managed_by_server: number;
  stdin_writable: number;
  resume_supported: number;
  session_export_path: string | null;
  last_output_at: string | null;
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  status: RuntimeStatus;
  last_seen_at: string;
  heartbeat_interval_seconds: number | null;
  stale_after_seconds: number | null;
  updated_at: string;
};

type RuntimeLogRow = {
  id: string;
  session_id: string;
  runtime_id: string;
  agent_id: string;
  stream: string;
  text: string;
  created_at: string;
};

type RuntimeHandoffCandidateRow = {
  id: string;
  session_id: string;
  runtime_id: string;
  agent_id: string;
  summary: string;
  excerpt: string;
  has_formal_result: number;
  session_export_path: string | null;
  created_at: string;
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

type AgentStatusEventRow = {
  id: string;
  session_id: string;
  agent_id: string;
  changed_by_agent_id: string | null;
  from_status: string | null;
  to_status: string;
  note: string | null;
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
    sessionWorkspacePath?: string;
    taskPrompt?: string;
  }) {
    const sessionId = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
          current_phase_goal, completed_summary, lifecycle_stage, required_ack_sequence,
          final_ack_sequence, session_workspace_path, approved_worktree_roots, task_prompt, terminal_reason, created_at, updated_at,
          completed_at, abandoned_at, archived_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, 'planning', NULL, NULL, ?, '[]', ?, NULL, ?, ?, NULL, NULL, NULL)`
      )
      .run(sessionId, input.title, input.taskSlug, input.projectRoot, input.sessionWorkspacePath ?? null, input.taskPrompt ?? null, now, now);

    return {
      sessionId,
      status: "active" as const,
      lifecycleStage: "planning" as const,
    };
  }

  recordDebugEvent(input: {
    sessionId?: string;
    actorAgentId?: string;
    eventType: string;
    toolName?: string;
    payload?: unknown;
  }) {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO debug_events (
          id, session_id, actor_agent_id, event_type, tool_name, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.sessionId ?? null,
        input.actorAgentId ?? null,
        input.eventType,
        input.toolName ?? null,
        JSON.stringify(input.payload ?? null),
        now
      );
    return { ok: true, createdAt: now };
  }

  listDebugEvents(input: { sessionId?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const rows = input.sessionId
      ? this.db
          .prepare(
            `SELECT id, session_id, actor_agent_id, event_type, tool_name, payload, created_at
             FROM debug_events
             WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`
          )
          .all(input.sessionId, limit)
      : this.db
          .prepare(
            `SELECT id, session_id, actor_agent_id, event_type, tool_name, payload, created_at
             FROM debug_events
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?`
          )
          .all(limit);
    return {
      events: (rows as Array<{
        id: string;
        session_id: string | null;
        actor_agent_id: string | null;
        event_type: string;
        tool_name: string | null;
        payload: string | null;
        created_at: string;
      }>).map((row) => ({
        debugEventId: row.id,
        sessionId: row.session_id ?? undefined,
        actorAgentId: row.actor_agent_id ?? undefined,
        eventType: row.event_type,
        toolName: row.tool_name ?? undefined,
        payload: row.payload ? JSON.parse(row.payload) : undefined,
        createdAt: row.created_at,
      })),
    };
  }

  registerAgent(input: {
    sessionId: string;
    alias: string;
    specialty: string;
    responsibility?: string;
    cli: string;
    model: string;
    role: AgentRole;
  }) {
    this.requireSession(input.sessionId);
    this.assertAllowedCli(input.cli);
    const agentId = randomUUID();
    const token = randomBytes(24).toString("hex");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agents (
          id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
          last_ack_sequence, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, ?, ?, ?)`
      )
      .run(
        agentId,
        input.sessionId,
        input.alias,
        input.specialty,
        input.responsibility?.trim() ?? "",
        input.cli,
        input.model,
        input.role,
        token,
        now,
        now,
        now
      );
    this.recordAgentStatusEvent({
      sessionId: input.sessionId,
      agentId,
      toStatus: "active",
    });

    return {
      agentId,
      token,
      alias: input.alias,
      specialty: input.specialty,
      responsibility: input.responsibility?.trim() ?? "",
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
    this.requireActiveSession(input.sessionId);
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
         SET current_phase_number = ?, current_phase_title = ?, current_phase_goal = ?,
             lifecycle_stage = 'executing', updated_at = ?
         WHERE id = ?`
      )
      .run(input.phaseNumber, input.title, input.goal, now, input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_start_phase",
      payload: {
        lifecycleStage: "executing",
        phaseNumber: input.phaseNumber,
        title: input.title,
        phaseCreated: !existing,
      },
    });
  }

  beginIntegration(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireActiveSession(input.sessionId);
    if (session.current_phase_number !== input.phaseNumber) {
      throw new Error("Cannot begin integration for a phase that is not current");
    }
    this.assertPhaseWorkItemsDone(input.sessionId, input.phaseNumber);
    const sequence = this.currentMaxSequence(input.sessionId);
    this.db
      .prepare(
        `UPDATE sessions
         SET lifecycle_stage = 'integrating', required_ack_sequence = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(sequence, this.now(), input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_begin_integration",
      payload: {
        lifecycleStage: "integrating",
        phaseNumber: input.phaseNumber,
        requiredAckSequence: sequence,
      },
    });
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "message_ack_gate",
      toolName: "tw_begin_integration",
      payload: {
        gate: "phase",
        requiredAckSequence: sequence,
        phaseNumber: input.phaseNumber,
      },
    });
    return { ok: true, lifecycleStage: "integrating" as const, requiredAckSequence: sequence };
  }

  completePhase(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber: number;
    summary: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    let session = this.requireActiveSession(input.sessionId);
    if (session.lifecycle_stage !== "integrating") {
      const diagnostics = this.getCloseoutDiagnostics({
        sessionId: input.sessionId,
        phaseNumber: input.phaseNumber,
        stage: "phase",
      });
      if (diagnostics.counts.openWorkItems > 0) {
        throw this.closeoutError("Cannot continue while phase work items are not done", diagnostics);
      }
      const sequence = this.currentMaxSequence(input.sessionId);
      this.db
        .prepare(
          `UPDATE sessions
           SET lifecycle_stage = 'integrating', required_ack_sequence = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(sequence, this.now(), input.sessionId);
      this.recordDebugEvent({
        sessionId: input.sessionId,
        eventType: "lifecycle_transition",
        toolName: "tw_complete_phase",
        payload: {
          lifecycleStage: "integrating",
          phaseNumber: input.phaseNumber,
          requiredAckSequence: sequence,
          reason: "auto_begin_integration",
        },
      });
      this.recordDebugEvent({
        sessionId: input.sessionId,
        eventType: "message_ack_gate",
        toolName: "tw_complete_phase",
        payload: {
          gate: "phase",
          requiredAckSequence: sequence,
          phaseNumber: input.phaseNumber,
          reason: "auto_begin_integration",
        },
      });
      session = this.requireActiveSession(input.sessionId);
    }
    if (session.current_phase_number !== input.phaseNumber) {
      throw new Error("Cannot complete a phase that is not current");
    }
    const phase = this.requirePhase(input.sessionId, input.phaseNumber);
    this.runSafeCloseoutHealing({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      phaseNumber: input.phaseNumber,
      stage: "phase",
    });
    const diagnostics = this.getCloseoutDiagnostics({
      sessionId: input.sessionId,
      phaseNumber: input.phaseNumber,
      stage: "phase",
    });
    if (
      diagnostics.counts.openWorkItems > 0
      || diagnostics.counts.openObligations > 0
      || diagnostics.counts.unackedBoundaryAgents > 0
    ) {
      throw this.closeoutError("Cannot complete phase while closeout blockers remain", diagnostics);
    }
    const integrationCount = this.db
      .prepare(`SELECT COUNT(*) AS count FROM integration_events WHERE session_id = ? AND phase_number = ?`)
      .get(input.sessionId, input.phaseNumber) as { count: number };
    if (integrationCount.count === 0) {
      throw this.closeoutError(
        "Cannot complete phase before recording an integration event",
        { ...diagnostics, recommendedOperations: ["record_integration_event", ...diagnostics.recommendedOperations] }
      );
    }
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
         SET lifecycle_stage = 'planning', current_phase_number = NULL, current_phase_title = NULL,
             current_phase_goal = NULL, required_ack_sequence = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(now, input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_complete_phase",
      payload: {
        lifecycleStage: "planning",
        completedPhaseNumber: input.phaseNumber,
      },
    });
    this.createCheckpointInternal({
      sessionId: input.sessionId,
      phaseNumber: input.phaseNumber,
      kind: "phase-end",
      label: `Phase ${input.phaseNumber} complete`,
    });
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
    assigneeAgentIds?: string[];
    primaryAssigneeAgentId?: string;
    status?: WorkItemStatus;
    dependsOnIds?: string[];
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const owner = input.ownerAgentId ? this.requireAgentById(input.ownerAgentId) : undefined;
    if (owner && owner.session_id !== input.sessionId) {
      throw new Error("Owner agent does not belong to this session");
    }
    const assigneeAgentIds = input.assigneeAgentIds ?? (input.ownerAgentId ? [input.ownerAgentId] : []);
    this.validateAssignees(input.sessionId, assigneeAgentIds, input.primaryAssigneeAgentId ?? input.ownerAgentId);

    const now = this.now();
    const dependsOnIds = JSON.stringify(input.dependsOnIds ?? []);
    const status = input.status ?? "planned";

    if (input.workItemId) {
      this.requireWorkItem(input.workItemId);
      const previous = this.requireWorkItemRow(input.workItemId);
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
      this.replaceWorkItemAssignees(
        input.workItemId,
        assigneeAgentIds,
        input.primaryAssigneeAgentId ?? input.ownerAgentId ?? assigneeAgentIds[0]
      );
      this.touchSession(input.sessionId);
      this.recordDebugEvent({
        sessionId: input.sessionId,
        eventType: "work_item_changed",
        toolName: "tw_upsert_work_item",
        payload: {
          workItemId: input.workItemId,
          action: "updated",
          phaseNumber: input.phaseNumber,
          previousStatus: previous.status,
          status,
          ownerAgentId: input.ownerAgentId,
          assigneeAgentIds,
          primaryAssigneeAgentId: input.primaryAssigneeAgentId ?? input.ownerAgentId ?? assigneeAgentIds[0],
        },
      });
      return { workItemId: input.workItemId };
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
    this.replaceWorkItemAssignees(
      workItemId,
      assigneeAgentIds,
      input.primaryAssigneeAgentId ?? input.ownerAgentId ?? assigneeAgentIds[0]
    );
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "work_item_changed",
      toolName: "tw_upsert_work_item",
      payload: {
        workItemId,
        action: "created",
        phaseNumber: input.phaseNumber,
        status,
        ownerAgentId: input.ownerAgentId,
        assigneeAgentIds,
        primaryAssigneeAgentId: input.primaryAssigneeAgentId ?? input.ownerAgentId ?? assigneeAgentIds[0],
      },
    });

    return {
      workItemId,
    };
  }

  updateWorkItemStatus(input: {
    sessionId: string;
    actorToken: string;
    workItemId: string;
    status: WorkItemStatus;
    note?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const workItem = this.requireWorkItemRow(input.workItemId);
    if (workItem.session_id !== input.sessionId) {
      throw new Error("Work item does not belong to this session");
    }
    if (actor.role !== "parent" && !this.isAssignedToWorkItem(input.workItemId, actor.id)) {
      throw new Error("Only the parent or an assigned worker may update this work item");
    }
    if (actor.role !== "parent" && input.status === "in-progress") {
      throw new Error("Workers must use claim_work_item before starting work");
    }
    if (actor.role !== "parent" && input.status === "done") {
      throw new Error("Workers must use record_result to complete work items");
    }
    if (actor.role !== "parent" && input.status !== "blocked") {
      throw new Error("Worker status transition is not allowed");
    }
    const previousStatus = workItem.status;
    this.db
      .prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`)
      .run(input.status, this.now(), input.workItemId);
    if (input.status !== "in-progress") {
      this.releaseActiveClaimsForWorkItem({
        workItemId: input.workItemId,
        agentIds: actor.role === "parent" || input.status === "blocked" ? undefined : [actor.id],
        reason: input.status,
      });
    }
    this.touchAgent(actor.id);
    this.touchSession(input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "work_item_changed",
      toolName: "tw_update_work_item_status",
      payload: {
        workItemId: input.workItemId,
        action: "status_changed",
        previousStatus,
        status: input.status,
        note: input.note,
      },
    });
    return { workItemId: input.workItemId, status: input.status };
  }

  claimWorkItem(input: {
    sessionId: string;
    actorToken: string;
    workItemId: string;
    note?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    if (actor.role !== "worker") {
      throw new Error("Only worker agents may claim work items");
    }
    const workItem = this.requireWorkItemRow(input.workItemId);
    if (workItem.session_id !== input.sessionId) {
      throw new Error("Work item does not belong to this session");
    }
    if (!this.isAssignedToWorkItem(input.workItemId, actor.id)) {
      throw new Error("Only an assigned worker may claim this work item");
    }
    if (!["assigned", "in-progress"].includes(workItem.status)) {
      throw new Error(`Cannot claim a work item with status '${workItem.status}'`);
    }

    const currentClaim = this.getActiveClaimForAgent(input.sessionId, actor.id);
    if (currentClaim) {
      // A worker chooses priority explicitly; the server never advances to a different queued item on its behalf.
      if (currentClaim.work_item_id === input.workItemId) {
        return this.mapWorkItemClaim(currentClaim);
      }
      throw new Error(
        `Worker already has an active claim on work item ${currentClaim.work_item_id}; finish, block, or reassign it before claiming another`
      );
    }

    const now = this.now();
    const claimId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO work_item_claims (
          id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(claimId, input.sessionId, input.workItemId, actor.id, now);
    this.db.prepare(`UPDATE work_items SET status = 'in-progress', updated_at = ? WHERE id = ?`).run(now, input.workItemId);
    this.touchAgent(actor.id);
    this.touchSession(input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "work_item_changed",
      toolName: "tw_claim_work_item",
      payload: {
        workItemId: input.workItemId,
        claimId,
        action: "claimed",
        previousStatus: workItem.status,
        status: "in-progress",
        note: input.note,
      },
    });

    return this.mapWorkItemClaim(this.requireWorkItemClaimRow(claimId));
  }

  reassignWorkItem(input: {
    sessionId: string;
    actorToken: string;
    workItemId: string;
    assigneeAgentIds: string[];
    primaryAssigneeAgentId?: string;
    reason: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const workItem = this.requireWorkItemRow(input.workItemId);
    if (workItem.session_id !== input.sessionId) {
      throw new Error("Work item does not belong to this session");
    }
    this.validateAssignees(input.sessionId, input.assigneeAgentIds, input.primaryAssigneeAgentId);
    this.replaceWorkItemAssignees(input.workItemId, input.assigneeAgentIds, input.primaryAssigneeAgentId ?? input.assigneeAgentIds[0]);
    this.releaseActiveClaimsForWorkItem({ workItemId: input.workItemId, reason: "reassigned" });
    const previousStatus = workItem.status;
    this.db
      .prepare(
        `UPDATE work_items
         SET owner_agent_id = ?, status = 'assigned', updated_at = ?
         WHERE id = ?`
      )
      .run(input.primaryAssigneeAgentId ?? input.assigneeAgentIds[0] ?? null, this.now(), input.workItemId);
    this.touchSession(input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "work_item_changed",
      toolName: "tw_reassign_work_item",
      payload: {
        workItemId: input.workItemId,
        action: "reassigned",
        previousStatus,
        status: "assigned",
        assigneeAgentIds: input.assigneeAgentIds,
        primaryAssigneeAgentId: input.primaryAssigneeAgentId ?? input.assigneeAgentIds[0],
        reason: input.reason,
      },
    });
    return { workItemId: input.workItemId, status: "assigned" as const };
  }

  ensureWorkItemsAssignedToAgent(input: {
    sessionId: string;
    actorToken: string;
    agentId: string;
    workItemIds: string[];
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireSession(input.sessionId);
    const agent = this.requireAgentById(input.agentId);
    if (agent.session_id !== input.sessionId) {
      throw new Error("Agent does not belong to this session");
    }
    if (agent.role !== "worker") {
      throw new Error("Work items can only be assigned to workers");
    }

    const assigned: Array<{ workItemId: string; assigneeAgentIds: string[] }> = [];
    const now = this.now();
    for (const workItemId of input.workItemIds) {
      const workItem = this.requireWorkItemRow(workItemId);
      if (workItem.session_id !== input.sessionId) {
        throw new Error("Work item does not belong to this session");
      }
      const existing = this.getWorkItemAssignees(workItemId);
      if (existing.some((assignee) => assignee.agentId === input.agentId)) {
        assigned.push({ workItemId, assigneeAgentIds: existing.map((assignee) => assignee.agentId) });
        continue;
      }

      const assigneeAgentIds = [...existing.map((assignee) => assignee.agentId), input.agentId];
      const primaryAssigneeAgentId = existing.find((assignee) => assignee.isPrimary)?.agentId ?? input.agentId;
      this.validateAssignees(input.sessionId, assigneeAgentIds, primaryAssigneeAgentId);
      this.replaceWorkItemAssignees(workItemId, assigneeAgentIds, primaryAssigneeAgentId);
      const status = workItem.status === "planned" ? "assigned" : workItem.status;
      this.db.prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, workItemId);
      this.recordDebugEvent({
        sessionId: input.sessionId,
        actorAgentId: input.agentId,
        eventType: "work_item_changed",
        toolName: "worker_supervisor.launch_worker",
        payload: {
          workItemId,
          action: "launch_assignment_bound",
          previousStatus: workItem.status,
          status,
          assigneeAgentIds,
          primaryAssigneeAgentId,
        },
      });
      assigned.push({ workItemId, assigneeAgentIds });
    }
    this.touchAgent(input.agentId);
    this.touchSession(input.sessionId);
    return { assigned };
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
    replyToMessageId?: string;
    requiresResponse?: boolean;
    requiresAck?: boolean;
    obligationKind?: string;
    dueStage?: "phase" | "final";
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
          related_work_item_id, reply_to_message_id, requires_response, requires_ack,
          obligation_kind, due_stage, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.replyToMessageId ?? null,
        input.requiresResponse ? 1 : 0,
        input.requiresAck ? 1 : 0,
        input.obligationKind ?? null,
        input.dueStage ?? null,
        now
      );
    if (input.replyToMessageId) {
      const resolved = this.db
        .prepare(
          `UPDATE message_obligations
           SET status = 'resolved', resolved_by_message_id = ?, resolved_at = ?
           WHERE question_message_id = ? AND session_id = ? AND status = 'open'`
        )
        .run(messageId, now, input.replyToMessageId, input.sessionId).changes;
      if (resolved > 0) {
        this.recordDebugEvent({
          sessionId: input.sessionId,
          actorAgentId: actor.id,
          eventType: "obligation_resolved",
          toolName: "tw_send_message",
          payload: {
            questionMessageId: input.replyToMessageId,
            resolvedByMessageId: messageId,
            resolvedCount: resolved,
          },
        });
      }
    }
    if (input.requiresResponse || input.requiresAck) {
      if (input.target !== "agent" || !input.targetAgentId) {
        throw new Error("Required messages must be direct messages");
      }
      this.db
        .prepare(
          `INSERT INTO message_obligations (
            id, session_id, question_message_id, from_agent_id, to_agent_id, kind, due_stage,
            status, created_at, resolved_by_message_id, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)`
        )
        .run(
          randomUUID(),
          input.sessionId,
          messageId,
          actor.id,
          input.targetAgentId,
          input.obligationKind ?? (input.requiresAck ? "ack" : "answer"),
          input.dueStage ?? "phase",
          now
        );
      this.recordDebugEvent({
        sessionId: input.sessionId,
        actorAgentId: actor.id,
        eventType: "obligation_created",
        toolName: "tw_send_message",
        payload: {
          messageId,
          fromAgentId: actor.id,
          toAgentId: input.targetAgentId,
          kind: input.obligationKind ?? (input.requiresAck ? "ack" : "answer"),
          dueStage: input.dueStage ?? "phase",
          sequence,
        },
      });
    }
    this.touchAgent(actor.id);
    this.touchSession(input.sessionId);

    return {
      messageId,
      sequence,
      createdAt: now,
      senderAgentId: actor.id,
      targetAgentIds: input.targetAgentId ? [input.targetAgentId] : [],
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
                    body, related_work_item_id, reply_to_message_id, requires_response,
                    requires_ack, obligation_kind, due_stage, created_at
             FROM messages
             WHERE session_id = ? AND sequence > ?
             ORDER BY sequence ASC`
          )
          .all(input.sessionId, input.afterSequence)
      : this.db
          .prepare(
            `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                    body, related_work_item_id, reply_to_message_id, requires_response,
                    requires_ack, obligation_kind, due_stage, created_at
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
    const now = this.now();
    this.db
      .prepare(
        `UPDATE agents
         SET last_ack_sequence = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.upToSequence, now, now, actor.id);
    const resolved = this.db
      .prepare(
        `UPDATE message_obligations
         SET status = 'resolved', resolved_at = ?
         WHERE session_id = ? AND to_agent_id = ? AND kind = 'ack' AND status = 'open'
           AND question_message_id IN (
             SELECT id FROM messages WHERE session_id = ? AND sequence <= ?
            )`
      )
      .run(now, input.sessionId, actor.id, input.sessionId, input.upToSequence).changes;
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "message_ack",
      toolName: "tw_ack_messages",
      payload: {
        agentId: actor.id,
        upToSequence: input.upToSequence,
        resolvedAckObligations: resolved,
      },
    });
    this.touchSession(input.sessionId);
  }

  closeoutAckWorkers(input: {
    sessionId: string;
    actorToken: string;
    stage?: "phase" | "final";
    upToSequence?: number;
  }) {
    const parent = this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireSession(input.sessionId);
    const stage = input.stage ?? (session.lifecycle_stage === "finalizing" ? "final" : "phase");
    const boundarySequence = input.upToSequence
      ?? (stage === "final" ? session.final_ack_sequence : session.required_ack_sequence)
      ?? this.currentMaxSequence(input.sessionId);
    if (boundarySequence <= 0) return { ok: true, upToSequence: boundarySequence, ackedAgents: [] };

    const workers = this.db
      .prepare(
        `SELECT id, alias, status, last_ack_sequence AS lastAckSequence
         FROM agents
         WHERE session_id = ? AND role = 'worker'`
      )
      .all(input.sessionId) as Array<{ id: string; alias: string; status: AgentStatus; lastAckSequence: number }>;
    const runtimes = this.listRuntimes({ sessionId: input.sessionId }).runtimes;
    const now = this.now();
    const ackedAgents = [];
    for (const worker of workers) {
      if (worker.lastAckSequence >= boundarySequence) continue;
      if (!this.canParentCloseoutAckWorker(worker, runtimes.filter((runtime) => runtime.agentId === worker.id))) continue;
      const visibleCount = this.visibleMessageCountForAgent(input.sessionId, worker.id, worker.lastAckSequence, boundarySequence);
      if (visibleCount === 0) continue;
      this.db
        .prepare(
          `UPDATE agents
           SET last_ack_sequence = ?, last_seen_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(boundarySequence, now, now, worker.id);
      const resolvedAckObligations = this.resolveAckObligationsForAgent(input.sessionId, worker.id, boundarySequence, now);
      ackedAgents.push({
        agentId: worker.id,
        alias: worker.alias,
        previousAckSequence: worker.lastAckSequence,
        upToSequence: boundarySequence,
        resolvedAckObligations,
      });
    }
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: parent.id,
      eventType: "message_ack",
      toolName: "tw_closeout_ack_workers",
      payload: {
        stage,
        upToSequence: boundarySequence,
        ackedAgents,
      },
    });
    this.touchSession(input.sessionId);
    return { ok: true, stage, upToSequence: boundarySequence, ackedAgents };
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

    const previousStatus = target.status;

    this.db
      .prepare(
        `UPDATE agents
         SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.status, input.note ?? null, this.now(), this.now(), target.id);
    this.recordAgentStatusEvent({
      sessionId: input.sessionId,
      agentId: target.id,
      changedByAgentId: actor.id,
      fromStatus: previousStatus,
      toStatus: input.status,
      note: input.note,
    });
    this.touchSession(input.sessionId);
  }

  resolveObligation(input: {
    sessionId: string;
    actorToken: string;
    messageId: string;
    reason: string;
  }) {
    const actor = this.requireParent(input.sessionId, input.actorToken);
    const now = this.now();
    const changes = this.db
      .prepare(
        `UPDATE message_obligations
         SET status = 'resolved', resolved_at = ?
         WHERE session_id = ? AND question_message_id = ? AND status = 'open'`
      )
      .run(now, input.sessionId, input.messageId).changes;
    if (changes === 0) {
      throw new Error("No open obligation for message");
    }
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "obligation_resolved",
      toolName: "tw_resolve_obligation",
      payload: { messageId: input.messageId, reason: input.reason },
    });
    this.touchSession(input.sessionId);
    return { ok: true, resolvedAt: now };
  }

  completeSession(input: {
    sessionId: string;
    actorToken: string;
    summary: string;
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireActiveSession(input.sessionId);
    if (session.current_phase_number !== null) {
      throw this.closeoutError(
        "Cannot complete session while a phase is still active",
        this.getCloseoutDiagnostics({ sessionId: input.sessionId, phaseNumber: session.current_phase_number, stage: "phase" })
      );
    }
    if (session.lifecycle_stage !== "finalizing") {
      this.beginFinalizing({ sessionId: input.sessionId, actorToken: input.actorToken });
    }
    const refreshed = this.requireSession(input.sessionId);
    this.runSafeCloseoutHealing({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      stage: "final",
    });
    const diagnostics = this.getCloseoutDiagnostics({ sessionId: input.sessionId, stage: "final" });
    if (
      diagnostics.counts.openWorkItems > 0
      || diagnostics.counts.openObligations > 0
      || diagnostics.counts.unackedBoundaryAgents > 0
      || diagnostics.counts.worktreesNeedingCleanup > 0
      || diagnostics.counts.runtimesBlocking > 0
    ) {
      throw this.closeoutError("Cannot complete session while closeout blockers remain", {
        ...diagnostics,
        session: { ...diagnostics.session, lifecycleStage: refreshed.lifecycle_stage },
      });
    }
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'completed', lifecycle_stage = 'finalizing', completed_summary = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.summary, this.now(), this.now(), input.sessionId);
    this.db
      .prepare(`UPDATE agents SET status = 'inactive', updated_at = ? WHERE session_id = ? AND role = 'worker'`)
      .run(this.now(), input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_complete_session",
      payload: {
        status: "completed",
        lifecycleStage: "finalizing",
      },
    });
    this.writeAuditReport(input.sessionId);
  }

  beginFinalizing(input: { sessionId: string; actorToken: string }) {
    this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireActiveSession(input.sessionId);
    if (session.current_phase_number !== null) {
      throw new Error("Cannot begin finalizing while a phase is still active");
    }
    const sequence = this.currentMaxSequence(input.sessionId);
    this.db
      .prepare(
        `UPDATE sessions
         SET lifecycle_stage = 'finalizing', final_ack_sequence = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(sequence, this.now(), input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_begin_finalizing",
      payload: {
        lifecycleStage: "finalizing",
        finalAckSequence: sequence,
      },
    });
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "message_ack_gate",
      toolName: "tw_begin_finalizing",
      payload: {
        gate: "final",
        requiredAckSequence: sequence,
      },
    });
    return { ok: true, lifecycleStage: "finalizing" as const, finalAckSequence: sequence };
  }

  abandonSession(input: { sessionId: string; actorToken: string; reason: string }) {
    this.requireParent(input.sessionId, input.actorToken);
    this.requireSession(input.sessionId);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'abandoned', terminal_reason = ?, abandoned_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(input.reason, now, now, input.sessionId);
    this.db.prepare(`UPDATE agents SET status = 'inactive', updated_at = ? WHERE session_id = ?`).run(now, input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_abandon_session",
      payload: {
        status: "abandoned",
        reason: input.reason,
      },
    });
    return { ok: true, status: "abandoned" as const };
  }

  // Dashboard kill is server-owned and must normalize stale sessions too, so it
  // intentionally does not require the session to still be "active".
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
      payload: {
        status: "abandoned",
        reason: input.reason,
      },
    });
    return { sessionId: input.sessionId, status: "abandoned" as const };
  }

  archiveSession(input: { sessionId: string; actorToken: string; reason: string }) {
    this.requireParent(input.sessionId, input.actorToken);
    this.requireSession(input.sessionId);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'archived', terminal_reason = ?, archived_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.reason, now, now, input.sessionId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "lifecycle_transition",
      toolName: "tw_archive_session",
      payload: {
        status: "archived",
        reason: input.reason,
      },
    });
    return { ok: true, status: "archived" as const };
  }

  runJanitor(input: { ttlHours?: number; worktreeGc?: boolean } = {}) {
    const ttlHours = input.ttlHours ?? 24;
    const worktreeGc = input.worktreeGc ?? true;
    const now = this.now();
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    const abandoned = this.db
      .prepare(
        `UPDATE sessions
         SET status = 'abandoned', terminal_reason = 'TTL janitor abandoned stale active session',
             abandoned_at = ?, updated_at = ?
         WHERE status = 'active' AND updated_at <= ?`
      )
      .run(now, now, cutoff).changes;
    this.recordDebugEvent({
      eventType: "janitor_activity",
      toolName: "tw_run_janitor",
      payload: {
        action: "stale_session_scan",
        ttlHours,
        cutoff,
        abandoned,
      },
    });

    let removedWorktrees = 0;
    let skippedWorktrees = 0;
    if (worktreeGc) {
      const rows = this.db
        .prepare(
          `SELECT worktrees.id, worktrees.path, worktrees.status, sessions.status AS sessionStatus,
                  sessions.session_workspace_path AS sessionWorkspacePath, sessions.approved_worktree_roots AS approvedWorktreeRoots
           FROM worktrees
           JOIN sessions ON sessions.id = worktrees.session_id
           WHERE sessions.status IN ('completed', 'abandoned', 'archived')
              AND worktrees.status NOT IN ('removed', 'cleanup-needed')`
        )
        .all() as Array<{
          id: string;
          path: string;
          status: WorktreeStatus;
          sessionStatus: SessionStatus;
          sessionWorkspacePath: string | null;
          approvedWorktreeRoots: string | null;
        }>;

      for (const row of rows) {
        if (!this.canJanitorRemoveWorktree(row.path, row.sessionWorkspacePath, row.approvedWorktreeRoots)) {
          skippedWorktrees += 1;
          this.db.prepare(`UPDATE worktrees SET status = 'cleanup-needed', updated_at = ? WHERE id = ?`).run(now, row.id);
          this.recordDebugEvent({
            eventType: "worktree_cleanup",
            toolName: "tw_run_janitor",
            payload: {
              worktreeId: row.id,
              path: row.path,
              fromStatus: row.status,
              toStatus: "cleanup-needed",
              reason: "outside_session_workspace",
            },
          });
          continue;
        }
        if (row.sessionStatus === "abandoned" && row.status === "dirty") {
          skippedWorktrees += 1;
          this.db.prepare(`UPDATE worktrees SET status = 'cleanup-needed', updated_at = ? WHERE id = ?`).run(now, row.id);
          this.recordDebugEvent({
            eventType: "worktree_cleanup",
            toolName: "tw_run_janitor",
            payload: {
              worktreeId: row.id,
              path: row.path,
              fromStatus: row.status,
              toStatus: "cleanup-needed",
              reason: "abandoned_dirty_worktree",
            },
          });
          continue;
        }
        try {
          if (existsSync(row.path)) {
            this.removePathWithRetries(row.path);
          }
          if (existsSync(row.path)) {
            throw new Error("path still exists after removal attempt");
          }
          removedWorktrees += 1;
          this.db.prepare(`UPDATE worktrees SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, row.id);
          this.recordDebugEvent({
            eventType: "worktree_cleanup",
            toolName: "tw_run_janitor",
            payload: {
              worktreeId: row.id,
              path: row.path,
              fromStatus: row.status,
              toStatus: "removed",
              reason: "janitor_removed_terminal_worktree",
            },
          });
        } catch (error) {
          skippedWorktrees += 1;
          this.db.prepare(`UPDATE worktrees SET status = 'cleanup-needed', updated_at = ? WHERE id = ?`).run(now, row.id);
          this.recordDebugEvent({
            eventType: "worktree_cleanup",
            toolName: "tw_run_janitor",
            payload: {
              worktreeId: row.id,
              path: row.path,
              fromStatus: row.status,
              toStatus: "cleanup-needed",
              reason: "janitor_remove_failed",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    this.recordDebugEvent({
      eventType: "janitor_activity",
      toolName: "tw_run_janitor",
      payload: {
        action: "completed",
        ttlHours,
        worktreeGc,
        abandoned,
        removedWorktrees,
        skippedWorktrees,
      },
    });
    return { abandoned, removedWorktrees, skippedWorktrees };
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
    const session = this.requireSession(input.sessionId);
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
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "worktree_changed",
      toolName: "tw_register_worktree",
      payload: {
        worktreeId: id,
        agentId: input.agentId,
        path: input.path,
        branch: input.branch,
        baseCommit: input.baseCommit,
        status,
        action: "registered",
      },
    });
    const resolvedPath = path.resolve(input.path);
    if (this.rememberApprovedWorktreeRoot(session, input.sessionId, resolvedPath)) {
      this.recordDebugEvent({
        sessionId: input.sessionId,
        eventType: "worktree_changed",
        toolName: "tw_register_worktree",
        payload: {
          worktreeId: id,
          approvedCleanupRoot: resolvedPath,
          reason: "parent_registered_external_worktree",
        },
      });
    }
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
      .prepare(`SELECT id, session_id, path, branch, base_commit, status FROM worktrees WHERE id = ?`)
      .get(input.worktreeId) as { id: string; session_id: string; path: string; branch: string; base_commit: string | null; status: WorktreeStatus } | undefined;
    if (!row) throw new Error(`Unknown worktree: ${input.worktreeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Worktree does not belong to this session");
    if (input.status === "removed" && existsSync(row.path)) {
      throw new Error("Cannot mark worktree removed while its path still exists. Use cleanup_worktree or remove it first.");
    }

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
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: input.status === "removed" || input.status === "cleanup-needed" ? "worktree_cleanup" : "worktree_changed",
      toolName: "tw_update_worktree",
      payload: {
        worktreeId: input.worktreeId,
        previousStatus: row.status,
        status: input.status ?? row.status,
        previousBranch: row.branch,
        branch: input.branch ?? row.branch,
        previousBaseCommit: row.base_commit ?? undefined,
        baseCommit: input.baseCommit ?? row.base_commit ?? undefined,
        action: "updated",
      },
    });
    return { worktreeId: input.worktreeId, ok: true };
  }

  cleanupWorktree(input: {
    sessionId: string;
    actorToken: string;
    worktreeId: string;
  }) {
    const parent = this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireSession(input.sessionId);
    const row = this.db
      .prepare(`SELECT id, session_id, path, status FROM worktrees WHERE id = ?`)
      .get(input.worktreeId) as { id: string; session_id: string; path: string; status: WorktreeStatus } | undefined;
    if (!row) throw new Error(`Unknown worktree: ${input.worktreeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Worktree does not belong to this session");
    if (!this.canJanitorRemoveWorktree(row.path, session.session_workspace_path, session.approved_worktree_roots)) {
      this.db.prepare(`UPDATE worktrees SET status = 'cleanup-needed', updated_at = ? WHERE id = ?`).run(this.now(), row.id);
      throw new Error("Refusing to remove worktree outside the session worktrees directory");
    }

    const now = this.now();
    try {
      if (existsSync(row.path)) {
        this.removePathWithRetries(row.path);
      }
      if (existsSync(row.path)) {
        throw new Error("path still exists after removal attempt");
      }
      this.db.prepare(`UPDATE worktrees SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, row.id);
      this.recordDebugEvent({
        sessionId: input.sessionId,
        actorAgentId: parent.id,
        eventType: "worktree_cleanup",
        toolName: "tw_cleanup_worktree",
        payload: {
          worktreeId: row.id,
          path: row.path,
          fromStatus: row.status,
          toStatus: "removed",
          reason: "parent_cleanup_succeeded",
        },
      });
      this.touchSession(input.sessionId);
      return { worktreeId: row.id, status: "removed" as const, removed: true };
    } catch (error) {
      this.db.prepare(`UPDATE worktrees SET status = 'cleanup-needed', updated_at = ? WHERE id = ?`).run(now, row.id);
      this.recordDebugEvent({
        sessionId: input.sessionId,
        actorAgentId: parent.id,
        eventType: "worktree_cleanup",
        toolName: "tw_cleanup_worktree",
        payload: {
          worktreeId: row.id,
          path: row.path,
          fromStatus: row.status,
          toStatus: "cleanup-needed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.touchSession(input.sessionId);
      throw error;
    }
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

  requireParentActor(input: { sessionId: string; actorToken: string }) {
    const actor = this.requireParent(input.sessionId, input.actorToken);
    return {
      agentId: actor.id,
      alias: actor.alias,
      role: actor.role,
    };
  }

  // --- Runtime tracking ---

  registerRuntime(input: {
    sessionId: string;
    actorToken: string;
    agentId: string;
    pid?: number;
    transport: string;
    heartbeatIntervalSeconds?: number;
    adapter?: string;
    launchMode?: string;
    cliSessionId?: string;
    command?: string;
    cwd?: string;
    managedByServer?: boolean;
    stdinWritable?: boolean;
    resumeSupported?: boolean;
    sessionExportPath?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const agent = this.requireAgentById(input.agentId);
    this.assertCliRuntimeTransport(input.transport);
    if (agent.session_id !== input.sessionId) {
      throw new Error("Agent does not belong to this session");
    }
    if (actor.role !== "parent" && actor.id !== agent.id) {
      throw new Error("Workers may only register their own runtime");
    }
    const activeRuntime = this.db
      .prepare(`SELECT id FROM runtimes WHERE session_id = ? AND agent_id = ? AND status = 'running' LIMIT 1`)
      .get(input.sessionId, input.agentId) as { id: string } | undefined;
    if (activeRuntime) {
      throw new Error("Agent already has an active runtime");
    }
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO runtimes (
          id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id, command, cwd,
          managed_by_server, stdin_writable, resume_supported, session_export_path, last_output_at, started_at, exited_at, exit_code, status,
          last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.pid ?? null,
        input.transport,
        input.adapter ?? null,
        input.launchMode ?? null,
        input.cliSessionId ?? null,
        input.command ?? null,
        input.cwd ?? null,
        input.managedByServer ? 1 : 0,
        input.stdinWritable ? 1 : 0,
        input.resumeSupported ? 1 : 0,
        input.sessionExportPath ?? null,
        now,
        now,
        input.heartbeatIntervalSeconds ?? null,
        input.heartbeatIntervalSeconds ? input.heartbeatIntervalSeconds * 3 : null,
        now
      );
    this.touchAgent(agent.id);
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

  updateRuntimeMetadata(input: {
    sessionId: string;
    runtimeId: string;
    cliSessionId?: string;
    sessionExportPath?: string;
    stdinWritable?: boolean;
    resumeSupported?: boolean;
  }) {
    const row = this.db
      .prepare(`SELECT id, session_id FROM runtimes WHERE id = ?`)
      .get(input.runtimeId) as { id: string; session_id: string } | undefined;
    if (!row) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Runtime does not belong to this session");
    const now = this.now();
    if (input.cliSessionId !== undefined) {
      this.db
        .prepare(`UPDATE runtimes SET cli_session_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.cliSessionId, now, input.runtimeId);
    }
    if (input.sessionExportPath !== undefined) {
      this.db
        .prepare(`UPDATE runtimes SET session_export_path = ?, updated_at = ? WHERE id = ?`)
        .run(input.sessionExportPath, now, input.runtimeId);
    }
    if (input.stdinWritable !== undefined) {
      this.db
        .prepare(`UPDATE runtimes SET stdin_writable = ?, updated_at = ? WHERE id = ?`)
        .run(input.stdinWritable ? 1 : 0, now, input.runtimeId);
    }
    if (input.resumeSupported !== undefined) {
      this.db
        .prepare(`UPDATE runtimes SET resume_supported = ?, updated_at = ? WHERE id = ?`)
        .run(input.resumeSupported ? 1 : 0, now, input.runtimeId);
    }
    this.touchSession(input.sessionId);
    return { runtimeId: input.runtimeId, ok: true };
  }

  heartbeatRuntime(input: {
    sessionId: string;
    actorToken: string;
    runtimeId: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const row = this.db
      .prepare(`SELECT id, session_id, agent_id, status FROM runtimes WHERE id = ?`)
      .get(input.runtimeId) as { id: string; session_id: string; agent_id: string; status: RuntimeStatus } | undefined;
    if (!row) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    if (row.session_id !== input.sessionId) throw new Error("Runtime does not belong to this session");
    if (actor.role !== "parent" && actor.id !== row.agent_id) {
      throw new Error("Workers may only heartbeat their own runtime");
    }
    const now = this.now();
    this.db.prepare(`UPDATE runtimes SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(now, now, input.runtimeId);
    this.touchAgent(row.agent_id);
    this.touchSession(input.sessionId);
    return { runtimeId: input.runtimeId, status: row.status, lastSeenAt: now };
  }

  getRuntime(runtimeId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id,
                command, cwd, managed_by_server, stdin_writable, resume_supported, session_export_path,
                last_output_at, started_at, exited_at, exit_code, status,
                last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
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
            `SELECT id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id,
                    command, cwd, managed_by_server, stdin_writable, resume_supported, session_export_path,
                    last_output_at, started_at, exited_at, exit_code, status,
                    last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
             FROM runtimes WHERE session_id = ? AND agent_id = ? ORDER BY started_at ASC`
          )
          .all(input.sessionId, input.agentId) as RuntimeRow[])
      : (this.db
          .prepare(
            `SELECT id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id,
                    command, cwd, managed_by_server, stdin_writable, resume_supported, session_export_path,
                    last_output_at, started_at, exited_at, exit_code, status,
                    last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
             FROM runtimes WHERE session_id = ? ORDER BY started_at ASC`
          )
          .all(input.sessionId) as RuntimeRow[]);
    return { runtimes: rows.map((r) => this.mapRuntime(r)) };
  }

  recordRuntimeLog(input: {
    sessionId: string;
    runtimeId: string;
    agentId: string;
    stream: string;
    text: string;
  }) {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO runtime_logs (id, session_id, runtime_id, agent_id, stream, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), input.sessionId, input.runtimeId, input.agentId, input.stream, input.text, now);
    this.db
      .prepare(`UPDATE runtimes SET last_output_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, now, input.runtimeId);
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: input.agentId,
      eventType: "runtime_io",
      toolName: "worker_supervisor",
      payload: { runtimeId: input.runtimeId, stream: input.stream, text: input.text.slice(0, 2000) },
    });
    this.touchAgent(input.agentId);
    this.touchSession(input.sessionId);
    return { ok: true, createdAt: now, outputId: Number(result.lastInsertRowid) };
  }

  getAgentRuntimeOutput(input: {
    sessionId: string;
    agentId: string;
    sinceId?: number;
    limit?: number;
    streams?: string[];
  }): {
    chunks: Array<{ id: number; runtimeLogId: string; runtimeId: string; stream: string; ts: string; chunk: string }>;
    nextSinceId: number | null;
  } {
    this.requireSession(input.sessionId);
    const agent = this.getAgent(input.agentId);
    if (agent.sessionId !== input.sessionId) throw new Error("agent does not belong to session");
    const limit = Math.min(Math.max(1, input.limit ?? 1000), 5000);
    const sinceId = input.sinceId ?? 0;
    const streams = input.streams?.length ? input.streams : ["stdout", "stderr", "system"];
    const placeholders = streams.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT rowid AS output_id, id, runtime_id, stream, text, created_at
         FROM runtime_logs
         WHERE session_id = ?
           AND agent_id = ?
           AND rowid > ?
           AND stream IN (${placeholders})
         ORDER BY rowid ASC
         LIMIT ?`
      )
      .all(input.sessionId, input.agentId, sinceId, ...streams, limit) as Array<{
        output_id: number;
        id: string;
        runtime_id: string;
        stream: string;
        text: string;
        created_at: string;
      }>;
    const chunks = rows.map((row) => ({
      id: row.output_id,
      runtimeLogId: row.id,
      runtimeId: row.runtime_id,
      stream: row.stream,
      ts: row.created_at,
      chunk: row.text,
    }));
    return {
      chunks,
      nextSinceId: chunks.length === limit ? chunks[chunks.length - 1]!.id : null,
    };
  }

  readRuntimeLogs(input: {
    sessionId: string;
    runtimeId: string;
    parentAgentId: string;
    mode?: WorkerLogReadMode;
    limit?: number;
    afterRuntimeLogId?: string;
  }) {
    this.requireSession(input.sessionId);
    this.requireAgentById(input.parentAgentId);
    const runtime = this.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");

    const mode = input.mode ?? "new";
    const explicitLimit = input.limit !== undefined;
    const limit = explicitLimit
      ? Math.max(1, Math.min(input.limit ?? 50, 1000))
      : mode === "all"
        ? undefined
        : 50;
    const storedCursor = mode === "new" && !input.afterRuntimeLogId
      ? ((this.db
          .prepare(
            `SELECT after_runtime_log_id
             FROM runtime_log_cursors
             WHERE session_id = ? AND parent_agent_id = ? AND runtime_id = ?`
          )
          .get(input.sessionId, input.parentAgentId, input.runtimeId) as
          | { after_runtime_log_id: string | null }
          | undefined)?.after_runtime_log_id ?? undefined)
      : undefined;
    const usedAfterRuntimeLogId = mode === "new"
      ? input.afterRuntimeLogId ?? storedCursor
      : undefined;
    const orderClause = mode === "tail" ? "rowid DESC" : "rowid ASC";
    const afterClause = usedAfterRuntimeLogId
      ? `AND rowid > COALESCE((
           SELECT rowid
           FROM runtime_logs
           WHERE session_id = ? AND runtime_id = ? AND id = ?
         ), 0)`
      : "";
    const limitClause = limit === undefined ? "" : " LIMIT ?";
    const queryParams: unknown[] = [input.sessionId, input.runtimeId];
    if (usedAfterRuntimeLogId) {
      queryParams.push(input.sessionId, input.runtimeId, usedAfterRuntimeLogId);
    }
    const totalCount = (this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_logs
         WHERE session_id = ?
           AND runtime_id = ?
           ${afterClause}`
      )
      .get(...queryParams) as { count: number }).count;
    const rows = this.db
      .prepare(
        `SELECT id, session_id, runtime_id, agent_id, stream, text, created_at
         FROM runtime_logs
         WHERE session_id = ?
           AND runtime_id = ?
           ${afterClause}
         ORDER BY ${orderClause}
         ${limitClause}`
      )
      .all(...queryParams, ...(limit === undefined ? [] : [limit])) as RuntimeLogRow[];
    const orderedRows = mode === "tail" ? rows.reverse() : rows;
    const events = orderedRows.map((row) => ({
      runtimeLogId: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      agentId: row.agent_id,
      stream: row.stream,
      text: row.text,
      createdAt: row.created_at,
    }));
    const nextAfterRuntimeLogId = events.at(-1)?.runtimeLogId ?? usedAfterRuntimeLogId;
    const advanced = mode === "new"
      && !input.afterRuntimeLogId
      && nextAfterRuntimeLogId !== usedAfterRuntimeLogId;
    if (advanced) {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO runtime_log_cursors (
             session_id, parent_agent_id, runtime_id, after_runtime_log_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, parent_agent_id, runtime_id)
           DO UPDATE SET after_runtime_log_id = excluded.after_runtime_log_id, updated_at = excluded.updated_at`
        )
        .run(input.sessionId, input.parentAgentId, input.runtimeId, nextAfterRuntimeLogId, now, now);
    }

    return {
      mode,
      events,
      totalCount,
      returnedCount: events.length,
      truncated: limit !== undefined && events.length < totalCount,
      cursor: {
        usedAfterRuntimeLogId,
        nextAfterRuntimeLogId,
        advanced,
      },
    };
  }

  listRuntimeLogs(input: { sessionId: string; runtimeId: string; limit?: number }) {
    this.requireSession(input.sessionId);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const rows = this.db
      .prepare(
        `SELECT id, session_id, runtime_id, agent_id, stream, text, created_at
         FROM runtime_logs
         WHERE session_id = ? AND runtime_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(input.sessionId, input.runtimeId, limit) as RuntimeLogRow[];
    return {
      events: rows.reverse().map((row) => ({
        runtimeLogId: row.id,
        sessionId: row.session_id,
        runtimeId: row.runtime_id,
        agentId: row.agent_id,
        stream: row.stream,
        text: row.text,
        createdAt: row.created_at,
      })),
    };
  }

  captureRuntimeHandoffCandidate(input: { sessionId: string; runtimeId: string; agentId: string }) {
    const runtime = this.getRuntime(input.runtimeId);
    if (runtime.sessionId !== input.sessionId) throw new Error("Runtime does not belong to this session");
    const rows = this.db
      .prepare(
        `SELECT stream, text, created_at
         FROM runtime_logs
         WHERE session_id = ?
           AND runtime_id = ?
           AND stream IN ('stdout', 'stderr')
         ORDER BY rowid DESC
         LIMIT 20`
      )
      .all(input.sessionId, input.runtimeId) as Array<{ stream: string; text: string; created_at: string }>;
    const excerpt = rows
      .reverse()
      .map((row) => row.text.trim())
      .filter(Boolean)
      .join("\n")
      .slice(-4000)
      .trim();
    if (!excerpt) return { captured: false, reason: "no runtime output" };
    const hasFormalResult = (this.db
      .prepare(`SELECT COUNT(*) AS count FROM results WHERE session_id = ? AND agent_id = ?`)
      .get(input.sessionId, input.agentId) as { count: number }).count > 0;
    const summary = this.summarizeRuntimeHandoffExcerpt(excerpt);
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO runtime_handoff_candidates (
           id, session_id, runtime_id, agent_id, summary, excerpt, has_formal_result, session_export_path, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_id)
         DO UPDATE SET summary = excluded.summary,
                       excerpt = excluded.excerpt,
                       has_formal_result = excluded.has_formal_result,
                       session_export_path = excluded.session_export_path,
                       created_at = excluded.created_at`
      )
      .run(
        id,
        input.sessionId,
        input.runtimeId,
        input.agentId,
        summary,
        excerpt,
        hasFormalResult ? 1 : 0,
        runtime.sessionExportPath ?? null,
        now
      );
    return { captured: true, runtimeId: input.runtimeId, hasFormalResult };
  }

  listRuntimeHandoffCandidates(input: { sessionId: string }) {
    this.requireSession(input.sessionId);
    const rows = this.db
      .prepare(
        `SELECT id, session_id, runtime_id, agent_id, summary, excerpt, has_formal_result, session_export_path, created_at
         FROM runtime_handoff_candidates
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(input.sessionId) as RuntimeHandoffCandidateRow[];
    return {
      handoffs: rows.map((row) => {
        const agent = this.requireAgentById(row.agent_id);
        return {
          handoffId: row.id,
          runtimeId: row.runtime_id,
          agentId: row.agent_id,
          agentAlias: agent.alias,
          summary: row.summary,
          excerpt: row.excerpt,
          hasFormalResult: Boolean(row.has_formal_result),
          sessionExportPath: row.session_export_path ?? undefined,
          createdAt: row.created_at,
        };
      }),
    };
  }

  markServerManagedRuntimesCrashed() {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT id, session_id, agent_id
         FROM runtimes
         WHERE managed_by_server = 1 AND status = 'running'`
      )
      .all() as Array<{ id: string; session_id: string; agent_id: string }>;
    for (const row of rows) {
      this.db
        .prepare(`UPDATE runtimes SET status = 'crashed', exited_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, row.id);
      this.recordRuntimeLog({
        sessionId: row.session_id,
        runtimeId: row.id,
        agentId: row.agent_id,
        stream: "system",
        text: "Server restarted before this managed worker process could be observed; marking runtime crashed.",
      });
    }
    return { crashed: rows.length };
  }

  getAgent(agentId: string) {
    const agent = this.requireAgentById(agentId);
    return {
      agentId: agent.id,
      sessionId: agent.session_id,
      alias: agent.alias,
      specialty: agent.specialty,
      cli: agent.cli,
      model: agent.model,
      role: agent.role,
      status: agent.status,
      token: agent.token,
    };
  }

  // --- Results ---

  recordResult(input: {
    sessionId: string;
    actorToken: string;
    workItemId: string;
    resultType: ResultType;
    summary: string;
    data?: string | Record<string, unknown>;
    commitSha?: string;
    commitShas?: string[];
    verificationSummary?: string;
  }) {
    const actor = this.requireActor(input.sessionId, input.actorToken);
    const workItem = this.requireWorkItemRow(input.workItemId);
    if (workItem.session_id !== input.sessionId) {
      throw new Error("Work item does not belong to this session");
    }
    if (actor.role === "parent" && input.resultType !== "note") {
      throw new Error("Parent fallback results must use resultType 'note'");
    }
    if (actor.role !== "parent" && !this.isAssignedToWorkItem(input.workItemId, actor.id)) {
      throw new Error("Only the parent or an assigned worker may record this work item result");
    }
    if (actor.role !== "parent") {
      const activeClaim = this.getActiveClaimForAgent(input.sessionId, actor.id);
      if (!activeClaim || activeClaim.work_item_id !== input.workItemId) {
        throw new Error("Workers must have an active claim on a work item before recording its result");
      }
    }
    if ((input.commitSha || input.commitShas || input.verificationSummary) && !input.verificationSummary) {
      throw new Error("verificationSummary is required for structured worker results");
    }
    const id = randomUUID();
    const now = this.now();
    const data = this.serializeResultData(input.data ?? {
      commitSha: input.commitSha,
      commitShas: input.commitShas ?? (input.commitSha ? [input.commitSha] : undefined),
      verificationSummary: input.verificationSummary,
    });
    this.db
      .prepare(
        `INSERT INTO results (id, session_id, work_item_id, agent_id, result_type, summary, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.workItemId, actor.id, input.resultType, input.summary, data, now);
    if (actor.role !== "parent") {
      const allAssigneesReported = this.assigneesHaveResults(input.workItemId);
      this.releaseActiveClaimsForWorkItem({
        workItemId: input.workItemId,
        agentIds: [actor.id],
        reason: "result-recorded",
      });
      if (allAssigneesReported) {
        this.db.prepare(`UPDATE work_items SET status = 'done', updated_at = ? WHERE id = ?`).run(now, input.workItemId);
        this.recordDebugEvent({
          sessionId: input.sessionId,
          actorAgentId: actor.id,
          eventType: "work_item_changed",
          toolName: "tw_record_result",
          payload: {
            workItemId: input.workItemId,
            action: "auto_completed_after_results",
            previousStatus: workItem.status,
            status: "done",
          },
        });
      }
      this.maybeAutoIdleWorker(input.sessionId, actor.id, now);
    }
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "worker_result_recorded",
      toolName: "tw_record_result",
      payload: {
        resultId: id,
        workItemId: input.workItemId,
        resultType: input.resultType,
      },
    });
    this.touchAgent(actor.id);
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

  parentPoll(input: {
    sessionId: string;
    actorToken: string;
    afterSequence?: number;
    includeWorkerOutputTails?: {
      runtimeIds?: string[];
      maxLines?: number;
      maxChars?: number;
      streams?: WorkerOutputTailStream[];
    };
  }) {
    const parent = this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireSession(input.sessionId);
    const summary = this.getSessionSummary(input.sessionId);
    const workItems = this.listWorkItems({ sessionId: input.sessionId }).workItems;
    const results = this.listResults({ sessionId: input.sessionId }).results;
    const runtimes = this.listRuntimes({ sessionId: input.sessionId }).runtimes;
    const afterSequence = input.afterSequence ?? parent.last_ack_sequence;
    const unreadForParent = this.listMessagesSince({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      afterSequence,
    }).messages;
    const openObligations = this.listOpenObligations(input.sessionId);
    const latestSequence = this.currentMaxSequence(input.sessionId);
    const currentPhaseNumber = session.current_phase_number ?? undefined;
    const currentPhaseWorkItems = currentPhaseNumber === undefined
      ? workItems
      : workItems.filter((item) => item.phaseNumber === currentPhaseNumber);
    const currentPhaseWorkItemIds = new Set(currentPhaseWorkItems.map((item) => item.workItemId));
    const blockedWorkItems = workItems.filter((item) => item.status === "blocked");
    const blockedAgents = summary.agents.filter((agent) => agent.status === "blocked");
    const workerProcesses = runtimes.filter((runtime) => runtime.managedByServer);
    const staleWorkerProcesses = workerProcesses.filter((runtime) => this.isRuntimeStale(runtime));
    const crashedWorkerProcesses = workerProcesses.filter((runtime) => runtime.status === "crashed");
    const statusGroups = this.groupWorkItemsByStatus(workItems);
    const staleRuntimeIds = new Set(staleWorkerProcesses.map((runtime) => runtime.runtimeId));
    const isResumableExit = (runtime: (typeof workerProcesses)[number]) =>
      runtime.status === "exited"
      && (runtime.launchMode === "resume-command" || Boolean(runtime.cliSessionId));
    const runtimeNeedsAttention = (runtime: (typeof workerProcesses)[number]) =>
      runtime.status === "crashed"
      || staleRuntimeIds.has(runtime.runtimeId)
      || (runtime.status === "exited" && !isResumableExit(runtime));
    const runtimesByAgent = new Map(workerProcesses.map((runtime) => [runtime.agentId, runtime]));
    const activeClaims = this.listActiveClaimsForSession(input.sessionId);
    const claimAttention = activeClaims
      .map((claim) => ({ claim, runtime: runtimesByAgent.get(claim.agentId) }))
      .filter(({ runtime }) => runtime ? runtimeNeedsAttention(runtime) : false)
      .map(({ claim, runtime }) => ({
        claimId: claim.claimId,
        workItemId: claim.workItemId,
        agentId: claim.agentId,
        agentAlias: claim.agentAlias,
        claimedAt: claim.claimedAt,
        runtimeStatus: runtime?.status,
        lastSeenAt: runtime?.lastSeenAt,
      }));
    const allCurrentWorkItemsDone = currentPhaseWorkItems.length > 0
      && currentPhaseWorkItems.every((item) => item.status === "done" || item.status === "canceled");
    const integrationEventCount = currentPhaseNumber === undefined
      ? 0
      : (this.db
          .prepare(`SELECT COUNT(*) AS count FROM integration_events WHERE session_id = ? AND phase_number = ?`)
          .get(input.sessionId, currentPhaseNumber) as { count: number }).count;
    const currentPhaseResults = results.filter((result) => currentPhaseWorkItemIds.has(result.workItemId));
    const latestCurrentPhaseResultAt = currentPhaseResults.at(-1)?.createdAt;
    const hasOpenBlockers = blockedWorkItems.length > 0 || blockedAgents.length > 0;
    const hasRequiredOpenObligations = openObligations.length > 0;
    const unackedBoundaryAgents = this.countUnackedBoundaryAgents(session);
    const allCurrentWorkItemsHaveResults = currentPhaseWorkItems.length > 0
      && currentPhaseWorkItems.every((item) => currentPhaseResults.some((result) => result.workItemId === item.workItemId));
    const phaseReadyForIntegration = session.status === "active"
      && session.lifecycle_stage === "executing"
      && allCurrentWorkItemsDone
      && allCurrentWorkItemsHaveResults
      && !hasOpenBlockers
      && !hasRequiredOpenObligations
      && staleWorkerProcesses.length === 0
      && crashedWorkerProcesses.length === 0;
    const staleParentThresholdSeconds = 180;
    const readyForIntegrationSeconds = phaseReadyForIntegration && latestCurrentPhaseResultAt
      ? this.durationSeconds(latestCurrentPhaseResultAt, this.now())
      : undefined;
    const workerOutputTails = input.includeWorkerOutputTails
      ? this.buildWorkerOutputTails({
          sessionId: input.sessionId,
          parentAgentId: parent.id,
          workerProcesses,
          ...input.includeWorkerOutputTails,
        })
      : undefined;

    // Keep orchestration with the parent agent; this aggregate reports facts and readiness flags only.
    return {
      session: {
        sessionId: summary.sessionId,
        status: summary.status,
        lifecycleStage: summary.lifecycleStage,
        taskSlug: summary.taskSlug,
        title: summary.title,
      },
      currentPhase: summary.currentPhase,
      workers: summary.agents.filter((agent) => agent.role === "worker"),
      workerProcesses: {
        counts: {
          all: workerProcesses.length,
          running: workerProcesses.filter((runtime) => runtime.status === "running").length,
          idle: summary.agents.filter((agent) => agent.role === "worker" && agent.status === "idle").length,
          stale: staleWorkerProcesses.length,
          crashed: crashedWorkerProcesses.length,
          exited: workerProcesses.filter((runtime) => runtime.status === "exited").length,
        },
        attention: workerProcesses
          .filter((runtime) => runtimeNeedsAttention(runtime))
          .slice(0, 5)
          .map((runtime) => ({
            runtimeId: runtime.runtimeId,
            agentId: runtime.agentId,
            agentAlias: runtime.agentAlias,
            status: runtime.status,
            launchMode: runtime.launchMode,
            cliSessionId: runtime.cliSessionId,
            lastOutputAt: runtime.lastOutputAt,
            lastSeenAt: runtime.lastSeenAt,
            exitCode: runtime.exitCode,
          })),
      },
      workItems: {
        counts: {
          all: workItems.length,
          planned: statusGroups.planned.length,
          assigned: statusGroups.assigned.length,
          inProgress: statusGroups["in-progress"].length,
          blocked: statusGroups.blocked.length,
          done: statusGroups.done.length,
          canceled: statusGroups.canceled.length,
          activeClaims: activeClaims.length,
        },
        currentPhaseCount: currentPhaseWorkItems.length,
        currentPhasePreview: currentPhaseWorkItems.slice(0, 5).map((item) => ({
          workItemId: item.workItemId,
          phaseNumber: item.phaseNumber,
          title: item.title,
          status: item.status,
          ownerAlias: item.ownerAlias,
          assigneeAliases: item.assigneeAliases,
        })),
        blockedPreview: blockedWorkItems.slice(0, 5).map((item) => ({
          workItemId: item.workItemId,
          phaseNumber: item.phaseNumber,
          title: item.title,
          ownerAlias: item.ownerAlias,
          assigneeAliases: item.assigneeAliases,
        })),
        claimAttention,
      },
      results: {
        count: results.length,
        recent: results.slice(-5).map((result) => ({
          resultId: result.resultId,
          workItemId: result.workItemId,
          agentAlias: result.agentAlias,
          resultType: result.resultType,
          summary: result.summary,
          createdAt: result.createdAt,
        })),
      },
      messages: {
        afterSequence,
        latestSequence,
        unreadCount: unreadForParent.length,
        unreadPreview: unreadForParent.slice(0, 5).map((message) => ({
          messageId: message.messageId,
          sequence: message.sequence,
          senderAlias: message.senderAlias,
          kind: message.kind,
          bodyPreview: message.body.slice(0, 160),
          requiresResponse: message.requiresResponse,
          requiresAck: message.requiresAck,
        })),
        openObligationCount: openObligations.length,
        openObligationPreview: openObligations.slice(0, 5),
        unackedBoundaryAgents,
      },
      workerOutputTails,
      blockers: {
        workItems: blockedWorkItems,
        agents: blockedAgents,
      },
      readiness: {
        allWorkItemsDone: allCurrentWorkItemsDone,
        allRequiredResultsRecorded: allCurrentWorkItemsHaveResults,
        hasOpenBlockers,
        hasUnreadParentMessages: unreadForParent.length > 0,
        hasRequiredOpenObligations,
        hasCrashedWorkers: crashedWorkerProcesses.length > 0,
        hasStaleWorkers: staleWorkerProcesses.length > 0,
        phaseCanBeginIntegration: phaseReadyForIntegration,
        phaseCanComplete: session.status === "active"
          && session.lifecycle_stage === "integrating"
          && allCurrentWorkItemsDone
          && !hasRequiredOpenObligations
          && unackedBoundaryAgents === 0
          && integrationEventCount > 0,
        readyForIntegrationSince: phaseReadyForIntegration ? latestCurrentPhaseResultAt : undefined,
        readyForIntegrationSeconds: readyForIntegrationSeconds === undefined
          ? undefined
          : Number(readyForIntegrationSeconds.toFixed(3)),
        staleParentThresholdSeconds,
        staleParentAttention: phaseReadyForIntegration
          && readyForIntegrationSeconds !== undefined
          && readyForIntegrationSeconds >= staleParentThresholdSeconds,
        nextSuggestedOperation: phaseReadyForIntegration
          ? "begin_integration"
          : session.status === "active"
            && session.lifecycle_stage === "integrating"
            && allCurrentWorkItemsDone
            && !hasRequiredOpenObligations
            && unackedBoundaryAgents === 0
            && integrationEventCount > 0
            ? "complete_phase"
            : undefined,
      },
    };
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
    this.recordDebugEvent({
      sessionId: input.sessionId,
      actorAgentId: actor.id,
      eventType: "integration_event_recorded",
      toolName: "tw_record_integration_event",
      payload: {
        eventId: id,
        phaseNumber: input.phaseNumber,
        kind: input.kind,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        commitSha: input.commitSha,
      },
    });
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
    return this.createCheckpointInternal(input);
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

  getAuditReport(sessionId: string) {
    const session = this.requireSession(sessionId);
    const now = this.now();
    const agents = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
                last_ack_sequence, last_seen_at, created_at, updated_at
         FROM agents
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(sessionId) as AgentRow[];
    const messages = this.db
      .prepare(
        `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                body, related_work_item_id, reply_to_message_id, requires_response,
                requires_ack, obligation_kind, due_stage, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY sequence ASC`
      )
      .all(sessionId) as MessageRow[];
    const runtimes = this.db
      .prepare(
        `SELECT id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id,
                command, cwd, managed_by_server, stdin_writable, resume_supported, session_export_path,
                last_output_at, started_at, exited_at, exit_code, status,
                last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
         FROM runtimes
         WHERE session_id = ?
         ORDER BY started_at ASC`
      )
      .all(sessionId) as RuntimeRow[];
    const results = this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, result_type, summary, data, created_at
         FROM results
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as ResultRow[];
    const workItems = this.db
      .prepare(
        `SELECT id, session_id, phase_number, title, description, acceptance_criteria,
                owner_agent_id, status, depends_on_ids, created_at, updated_at
         FROM work_items
         WHERE session_id = ?
         ORDER BY phase_number ASC, created_at ASC`
      )
      .all(sessionId) as WorkItemRow[];
    const phases = this.db
      .prepare(
        `SELECT id, session_id, phase_number, title, goal, status, started_at, completed_at, summary
         FROM phases
         WHERE session_id = ?
         ORDER BY phase_number ASC`
      )
      .all(sessionId) as PhaseRow[];
    const statusEvents = this.db
      .prepare(
        `SELECT id, session_id, agent_id, changed_by_agent_id, from_status, to_status, note, created_at
         FROM agent_status_events
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as AgentStatusEventRow[];
    const debugEvents = this.db
      .prepare(
        `SELECT id, session_id, actor_agent_id, event_type, tool_name, payload, created_at
         FROM debug_events
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<{
        id: string;
        session_id: string | null;
        actor_agent_id: string | null;
        event_type: string;
        tool_name: string | null;
        payload: string | null;
        created_at: string;
      }>;

    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const metricsByAgent = new Map(
      agents.map((agent) => [
        agent.id,
        {
          agentId: agent.id,
          alias: agent.alias,
          specialty: agent.specialty,
          responsibility: agent.responsibility,
          role: agent.role,
          cli: agent.cli,
          model: agent.model,
          currentStatus: agent.status,
          currentStatusNote: agent.status_note ?? undefined,
          lastSeenAt: agent.last_seen_at,
          createdAt: agent.created_at,
          lastAckSequence: agent.last_ack_sequence,
          messagesSentCount: 0,
          messagesReceivedCount: 0,
          broadcastsSentCount: 0,
          directMessagesSentCount: 0,
          questionsSentCount: 0,
          answersSentCount: 0,
          responsesSentCount: 0,
          handoffsSentCount: 0,
          statusMessagesSentCount: 0,
          systemMessagesSentCount: 0,
          firstSentAt: undefined as string | undefined,
          lastSentAt: undefined as string | undefined,
          firstReceivedAt: undefined as string | undefined,
          lastReceivedAt: undefined as string | undefined,
          statusChangeCount: 0,
          activeCount: 0,
          blockedCount: 0,
          idleCount: 0,
          doneCount: 0,
          runtimeCount: 0,
          activeRuntimeCount: 0,
          exitedRuntimeCount: 0,
          crashedRuntimeCount: 0,
          firstRuntimeStartedAt: undefined as string | undefined,
          lastRuntimeExitedAt: undefined as string | undefined,
          totalRuntimeSeconds: 0,
          runtimeWindows: [] as Array<{
            runtimeId: string;
            transport: string;
            pid?: number;
            status: RuntimeStatus;
            startedAt: string;
            exitedAt?: string;
            exitCode?: number;
            durationSeconds: number;
          }>,
          resultCount: 0,
          workItemCount: 0,
        },
      ])
    );

    for (const workItem of workItems) {
      if (!workItem.owner_agent_id) continue;
      const metrics = metricsByAgent.get(workItem.owner_agent_id);
      if (metrics) {
        metrics.workItemCount += 1;
      }
    }

    for (const message of messages) {
      const senderMetrics = metricsByAgent.get(message.sender_agent_id);
      if (senderMetrics) {
        senderMetrics.messagesSentCount += 1;
        if (message.target_type === "broadcast") {
          senderMetrics.broadcastsSentCount += 1;
        } else {
          senderMetrics.directMessagesSentCount += 1;
        }
        if (message.kind === "question") senderMetrics.questionsSentCount += 1;
        if (message.kind === "answer") {
          senderMetrics.answersSentCount += 1;
          senderMetrics.responsesSentCount += 1;
        }
        if (message.kind === "handoff") senderMetrics.handoffsSentCount += 1;
        if (message.kind === "status") senderMetrics.statusMessagesSentCount += 1;
        if (message.kind === "system") senderMetrics.systemMessagesSentCount += 1;
        senderMetrics.firstSentAt ??= message.created_at;
        senderMetrics.lastSentAt = message.created_at;
      }

      for (const agent of agents) {
        if (agent.id === message.sender_agent_id) continue;
        const isReceived =
          message.target_type === "broadcast" ||
          message.target_agent_id === agent.id;
        if (!isReceived) continue;
        const recipientMetrics = metricsByAgent.get(agent.id);
        if (!recipientMetrics) continue;
        recipientMetrics.messagesReceivedCount += 1;
        recipientMetrics.firstReceivedAt ??= message.created_at;
        recipientMetrics.lastReceivedAt = message.created_at;
      }
    }

    for (const runtime of runtimes) {
      const metrics = metricsByAgent.get(runtime.agent_id);
      if (!metrics) continue;
      const durationSeconds = this.durationSeconds(runtime.started_at, runtime.exited_at ?? now);
      metrics.runtimeCount += 1;
      metrics.totalRuntimeSeconds += durationSeconds;
      metrics.firstRuntimeStartedAt ??= runtime.started_at;
      if (runtime.status === "running") metrics.activeRuntimeCount += 1;
      if (runtime.status === "exited") metrics.exitedRuntimeCount += 1;
      if (runtime.status === "crashed") metrics.crashedRuntimeCount += 1;
      if (runtime.exited_at) {
        metrics.lastRuntimeExitedAt = runtime.exited_at;
      }
      metrics.runtimeWindows.push({
        runtimeId: runtime.id,
        transport: runtime.transport,
        pid: runtime.pid ?? undefined,
        status: runtime.status as RuntimeStatus,
        startedAt: runtime.started_at,
        exitedAt: runtime.exited_at ?? undefined,
        exitCode: runtime.exit_code ?? undefined,
        durationSeconds,
      });
    }

    for (const result of results) {
      const metrics = metricsByAgent.get(result.agent_id);
      if (metrics) {
        metrics.resultCount += 1;
      }
    }

    for (const event of statusEvents) {
      const metrics = metricsByAgent.get(event.agent_id);
      if (!metrics) continue;
      if (event.from_status !== null) {
        metrics.statusChangeCount += 1;
      }
      if (event.to_status === "active") metrics.activeCount += 1;
      if (event.to_status === "blocked") metrics.blockedCount += 1;
      if (event.to_status === "idle") metrics.idleCount += 1;
      if (event.to_status === "done") metrics.doneCount += 1;
    }

    const pairGroups = new Map<string, AgentRow[]>();
    for (const agent of agents) {
      if (agent.role !== "worker") continue;
      const existing = pairGroups.get(agent.specialty) ?? [];
      existing.push(agent);
      pairGroups.set(agent.specialty, existing);
    }

    const pairMetrics = Array.from(pairGroups.entries())
      .filter(([, specialtyAgents]) => specialtyAgents.length >= 2)
      .map(([specialty, specialtyAgents]) => {
        const agentIds = new Set(specialtyAgents.map((agent) => agent.id));
        const directMessages = messages.filter((message) => {
          if (message.target_type !== "agent" || !message.target_agent_id) return false;
          return agentIds.has(message.sender_agent_id) && agentIds.has(message.target_agent_id);
        });

        return {
          specialty,
          agents: specialtyAgents.map((agent) => ({
            agentId: agent.id,
            alias: agent.alias,
          })),
          directMessageCount: directMessages.length,
          hasPairTraffic: directMessages.length > 0,
          firstMessageAt: directMessages[0]?.created_at,
          lastMessageAt: directMessages.at(-1)?.created_at,
        };
      });

    const workerCount = agents.filter((agent) => agent.role === "worker").length;
    const parentCount = agents.filter((agent) => agent.role === "parent").length;
    const blockedWorkers = agents.filter(
      (agent) => agent.role === "worker" && agent.status === "blocked"
    ).length;
    const idleWorkers = agents.filter(
      (agent) => agent.role === "worker" && agent.status === "idle"
    ).length;
    const doneWorkers = agents.filter(
      (agent) => agent.role === "worker" && agent.status === "done"
    ).length;
    const broadcastMessageCount = messages.filter((message) => message.target_type === "broadcast").length;
    const directMessageCount = messages.length - broadcastMessageCount;
    const runtimeCount = runtimes.length;
    const activeRuntimeCount = runtimes.filter((runtime) => runtime.status === "running").length;
    const exitedRuntimeCount = runtimes.filter((runtime) => runtime.status === "exited").length;
    const crashedRuntimeCount = runtimes.filter((runtime) => runtime.status === "crashed").length;
    const totalRuntimeSeconds = runtimes.reduce(
      (sum, runtime) => sum + this.durationSeconds(runtime.started_at, runtime.exited_at ?? now),
      0
    );
    const statusChangeCount = statusEvents.filter((event) => event.from_status !== null).length;
    const blockedStatusEventCount = statusEvents.filter((event) => event.to_status === "blocked").length;
    const invalidToolCallCount = debugEvents.filter((event) => event.event_type === "tool_error").length;
    const cleanupFailureCount = debugEvents.filter((event) => {
      if (event.event_type !== "worktree_cleanup") return false;
      const payload = this.parseDebugPayload(event.payload);
      return payload?.toStatus === "cleanup-needed";
    }).length;
    const managedRuntimeExports = runtimes.filter((runtime) => runtime.managed_by_server);
    const missingSessionExports = managedRuntimeExports.filter(
      (runtime) => runtime.status !== "running" && !runtime.session_export_path
    );
    const firstRuntimeStartedAt = runtimes[0]?.started_at;
    const latestResultAt = results.at(-1)?.created_at;
    const finalizationStartedAt = debugEvents.find(
      (event) => event.event_type === "lifecycle_transition"
        && event.tool_name === "tw_begin_finalizing"
        && this.parseDebugPayload(event.payload)?.lifecycleStage === "finalizing"
    )?.created_at;
    const phaseBoundaries = phases.map((phase) => {
      const phaseWorkItemIds = new Set(
        workItems.filter((item) => item.phase_number === phase.phase_number).map((item) => item.id)
      );
      const phaseLatestResultAt = results
        .filter((result) => phaseWorkItemIds.has(result.work_item_id))
        .at(-1)?.created_at;
      const phaseIntegrationStartedAt = debugEvents.find((event) => {
        if (event.event_type !== "lifecycle_transition") return false;
        const payload = this.parseDebugPayload(event.payload);
        return payload?.lifecycleStage === "integrating" && payload?.phaseNumber === phase.phase_number;
      })?.created_at;
      return {
        phaseNumber: phase.phase_number,
        title: phase.title,
        goal: phase.goal,
        status: phase.status,
        startedAt: phase.started_at,
        completedAt: phase.completed_at ?? undefined,
        summary: phase.summary ?? undefined,
        latestResultAt: phaseLatestResultAt,
        integrationStartedAt: phaseIntegrationStartedAt,
        resultToIntegrationDelaySeconds: phaseLatestResultAt && phaseIntegrationStartedAt
          ? Number(this.durationSeconds(phaseLatestResultAt, phaseIntegrationStartedAt).toFixed(3))
          : undefined,
      };
    });

    return {
      session: {
        sessionId: session.id,
        title: session.title,
        taskSlug: session.task_slug,
        projectRoot: session.project_root,
        status: session.status,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        completedAt: session.completed_at ?? undefined,
        completedSummary: session.completed_summary ?? undefined,
      },
      rollup: {
        agentCount: agents.length,
        parentCount,
        workerCount,
        workItemCount: workItems.length,
        runtimeCount,
        activeRuntimeCount,
        exitedRuntimeCount,
        crashedRuntimeCount,
        totalRuntimeSeconds,
        messageCount: messages.length,
        broadcastMessageCount,
        directMessageCount,
        resultCount: results.length,
        invalidToolCallCount,
        cleanupFailureCount,
        missingSessionExportCount: missingSessionExports.length,
        blockedStatusEventCount,
        statusChangeCount,
        blockedWorkerCount: blockedWorkers,
        idleWorkerCount: idleWorkers,
        doneWorkerCount: doneWorkers,
        pairSpecialtyCount: pairMetrics.length,
        pairTrafficSpecialtyCount: pairMetrics.filter((pair) => pair.hasPairTraffic).length,
        workerExecutionStartedAt: firstRuntimeStartedAt,
        latestResultAt,
        workerExecutionWindowSeconds: firstRuntimeStartedAt && latestResultAt
          ? Number(this.durationSeconds(firstRuntimeStartedAt, latestResultAt).toFixed(3))
          : undefined,
        finalizationStartedAt,
        finalCloseoutDurationSeconds: finalizationStartedAt && session.completed_at
          ? Number(this.durationSeconds(finalizationStartedAt, session.completed_at).toFixed(3))
          : undefined,
      },
      timeline: {
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        completedAt: session.completed_at ?? undefined,
        firstMessageAt: messages[0]?.created_at,
        lastMessageAt: messages.at(-1)?.created_at,
        phaseBoundaries,
      },
      pairs: pairMetrics,
      agents: Array.from(metricsByAgent.values()).map((metrics) => ({
        ...metrics,
        totalRuntimeSeconds: Number(metrics.totalRuntimeSeconds.toFixed(3)),
        runtimeWindows: metrics.runtimeWindows.map((window) => ({
          ...window,
          durationSeconds: Number(window.durationSeconds.toFixed(3)),
        })),
      })),
      exports: {
        expectedManagedRuntimeCount: managedRuntimeExports.length,
        runtimesWithSessionExport: managedRuntimeExports.length - missingSessionExports.length,
        missingSessionExports: missingSessionExports.map((runtime) => ({
          runtimeId: runtime.id,
          agentId: runtime.agent_id,
          agentAlias: agentById.get(runtime.agent_id)?.alias,
          status: runtime.status,
        })),
      },
    };
  }

  getCloseoutDiagnostics(input: { sessionId: string; phaseNumber?: number; stage?: "phase" | "final" }) {
    const session = this.requireSession(input.sessionId);
    const openWorkItems = this.listWorkItems({ sessionId: input.sessionId }).workItems
      .filter((item) =>
        item.status !== "done"
        && item.status !== "canceled"
        && (input.phaseNumber === undefined || item.phaseNumber === input.phaseNumber)
      )
      .map((item) => ({
        workItemId: item.workItemId,
        phaseNumber: item.phaseNumber,
        title: item.title,
        status: item.status,
        ownerAlias: item.ownerAlias,
        assigneeAliases: item.assigneeAliases,
      }));
    const openObligations = this.listOpenObligations(input.sessionId)
      .filter((obligation) => input.stage === undefined || obligation.dueStage === input.stage || obligation.dueStage === "final");
    const boundarySequence = input.stage === "final"
      ? session.final_ack_sequence ?? 0
      : session.required_ack_sequence ?? 0;
    const unackedBoundaryAgents = boundarySequence > 0
      ? this.unackedBoundaryAgents(input.sessionId, boundarySequence)
      : [];
    const worktreesNeedingCleanup = input.stage === "final"
      ? this.listWorktrees({ sessionId: input.sessionId }).worktrees
          .filter((worktree) => worktree.status !== "removed")
          .map((worktree) => ({
            worktreeId: worktree.worktreeId,
            agentAlias: worktree.agentAlias,
            path: worktree.path,
            status: worktree.status,
          }))
      : [];
    const runtimesBlocking = input.stage === "final"
      ? this.listRuntimes({ sessionId: input.sessionId }).runtimes
          .filter((runtime) => runtime.status === "running")
          .map((runtime) => ({
            runtimeId: runtime.runtimeId,
            agentAlias: runtime.agentAlias,
            status: runtime.status,
            inputDelivery: runtime.inputDelivery,
            cliSessionId: runtime.cliSessionId,
            lastSeenAt: runtime.lastSeenAt,
          }))
      : [];
    const recommendedOperations = [];
    if (openObligations.length > 0) recommendedOperations.push("resolve_obligation", "send_message");
    if (unackedBoundaryAgents.length > 0) recommendedOperations.push("ack_messages");
    if (openWorkItems.length > 0) recommendedOperations.push("claim_work_item", "update_work_item_status", "record_result");
    if (worktreesNeedingCleanup.length > 0) recommendedOperations.push("cleanup_worktree");
    if (runtimesBlocking.length > 0) recommendedOperations.push("stop_worker");

    const diagnostics = {
      session: {
        sessionId: session.id,
        status: session.status,
        lifecycleStage: session.lifecycle_stage,
        currentPhaseNumber: session.current_phase_number ?? undefined,
      },
      phaseNumber: input.phaseNumber,
      stage: input.stage,
      blockers: {
        openWorkItems,
        openObligations,
        unackedBoundaryAgents,
        worktreesNeedingCleanup,
        runtimesBlocking,
      },
      counts: {
        openWorkItems: openWorkItems.length,
        openObligations: openObligations.length,
        unackedBoundaryAgents: unackedBoundaryAgents.length,
        worktreesNeedingCleanup: worktreesNeedingCleanup.length,
        runtimesBlocking: runtimesBlocking.length,
      },
      recommendedOperations: [...new Set(recommendedOperations)],
    };
    this.recordDebugEvent({
      sessionId: input.sessionId,
      eventType: "closeout_evaluation",
      toolName: "closeout_diagnostics",
      payload: {
        phaseNumber: input.phaseNumber,
        stage: input.stage,
        counts: diagnostics.counts,
        recommendedOperations: diagnostics.recommendedOperations,
      },
    });
    return diagnostics;
  }

  getCloseoutChecklist(input: {
    sessionId: string;
    actorToken: string;
    phaseNumber?: number;
    stage?: "phase" | "final";
  }) {
    this.requireParent(input.sessionId, input.actorToken);
    const session = this.requireSession(input.sessionId);
    const stage = input.stage ?? (session.lifecycle_stage === "finalizing" || session.current_phase_number === null ? "final" : "phase");
    const phaseNumber = input.phaseNumber ?? session.current_phase_number ?? undefined;
    const diagnostics = this.getCloseoutDiagnostics({ sessionId: input.sessionId, phaseNumber, stage });
    const checklist = stage === "phase"
      ? [
          {
            step: "record_worker_results",
            operation: "record_result",
            status: diagnostics.counts.openWorkItems === 0 ? "complete" : "blocked",
            note: "Workers with code changes should record resultType \"commit\" with commitSha and verificationSummary. Parent fallback captures visible output as resultType \"note\" only when a worker could not record formally.",
          },
          {
            step: "begin_integration",
            operation: "begin_integration",
            status: session.lifecycle_stage === "integrating" ? "complete" : diagnostics.counts.openWorkItems === 0 ? "ready" : "blocked",
          },
          {
            step: "record_integration_event",
            operation: "record_integration_event",
            status: this.integrationEventCount(input.sessionId, phaseNumber) > 0 ? "complete" : "needed",
          },
          {
            step: "resolve_obligations",
            operation: "resolve_obligation/send_message",
            status: diagnostics.counts.openObligations === 0 ? "complete" : "blocked",
          },
          {
            step: "ack_boundary_messages",
            operation: "closeout_ack_workers",
            status: diagnostics.counts.unackedBoundaryAgents === 0 ? "complete" : "needed",
          },
          {
            step: "complete_phase",
            operation: "complete_phase",
            status: diagnostics.counts.openWorkItems === 0
              && diagnostics.counts.openObligations === 0
              && diagnostics.counts.unackedBoundaryAgents === 0
              && this.integrationEventCount(input.sessionId, phaseNumber) > 0
              ? "ready"
              : "blocked",
          },
        ]
      : [
          {
            step: "resolve_obligations",
            operation: "resolve_obligation/send_message",
            status: diagnostics.counts.openObligations === 0 ? "complete" : "blocked",
          },
          {
            step: "ack_boundary_messages",
            operation: "closeout_ack_workers",
            status: diagnostics.counts.unackedBoundaryAgents === 0 ? "complete" : "needed",
          },
          {
            step: "stop_worker_runtimes",
            operation: "stop_worker",
            status: diagnostics.counts.runtimesBlocking === 0 ? "complete" : "blocked",
          },
          {
            step: "remove_worktrees",
            operation: "cleanup_worktree",
            status: diagnostics.counts.worktreesNeedingCleanup === 0 ? "complete" : "blocked",
            note: "cleanup_worktree marks removed only after filesystem deletion succeeds.",
          },
          {
            step: "complete_session",
            operation: "complete_session",
            status: diagnostics.counts.openWorkItems === 0
              && diagnostics.counts.openObligations === 0
              && diagnostics.counts.unackedBoundaryAgents === 0
              && diagnostics.counts.worktreesNeedingCleanup === 0
              && diagnostics.counts.runtimesBlocking === 0
              ? "ready"
              : "blocked",
          },
        ];
    return { stage, phaseNumber, diagnostics, checklist };
  }

  getDiagnosticReport(sessionId: string) {
    const audit = this.getAuditReport(sessionId);
    const summary = this.getSessionSummary(sessionId);
    const runtimeHandoffs = this.listRuntimeHandoffCandidates({ sessionId }).handoffs;
    const debugErrors = this.listDebugEvents({ sessionId, limit: 500 }).events
      .filter((event) => event.eventType === "tool_error")
      .map((event) => ({
        eventId: event.debugEventId,
        toolName: event.toolName,
        payload: event.payload,
        createdAt: event.createdAt,
      }));
    const runtimes = this.listRuntimes({ sessionId }).runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      agentId: runtime.agentId,
      agentAlias: runtime.agentAlias,
      adapter: runtime.adapter,
      launchMode: runtime.launchMode,
      status: runtime.status,
      stdinWritable: runtime.stdinWritable,
      resumeSupported: runtime.resumeSupported,
      inputDelivery: runtime.inputDelivery,
      cliSessionId: runtime.cliSessionId,
      sessionExportPath: runtime.sessionExportPath,
      exitCode: runtime.exitCode,
      startedAt: runtime.startedAt,
      exitedAt: runtime.exitedAt,
      lastSeenAt: runtime.lastSeenAt,
      lastOutputAt: runtime.lastOutputAt,
    }));
    const workersWithFormalResults = new Set(audit.agents.filter((agent) => agent.resultCount > 0).map((agent) => agent.agentId));
    return {
      session: audit.session,
      generatedAt: this.now(),
      rollup: audit.rollup,
      runtimeExports: audit.exports,
      closeout: this.getCloseoutDiagnostics({
        sessionId,
        phaseNumber: summary.currentPhase?.phaseNumber,
        stage: summary.lifecycleStage === "finalizing" ? "final" : "phase",
      }),
      runtimes,
      copilotSessionEvents: this.collectCopilotSessionEvents(runtimes),
      handoffs: {
        formalWorkerResultCount: workersWithFormalResults.size,
        fallbackCandidates: runtimeHandoffs,
        fallbackWithoutFormalResult: runtimeHandoffs.filter((handoff) => !handoff.hasFormalResult),
      },
      errors: debugErrors,
      invariants: {
        runtimesMissingResumeIds: runtimes.filter((runtime) => runtime.resumeSupported && !runtime.cliSessionId),
        unsupportedInputRuntimes: runtimes.filter((runtime) => runtime.inputDelivery === "unsupported"),
      },
    };
  }

  getSessionSummary(sessionId: string) {
    const session = this.requireSession(sessionId);
    const agents = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
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
      lifecycleStage: session.lifecycle_stage,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      terminalReason: session.terminal_reason ?? undefined,
      requiredAckSequence: session.required_ack_sequence ?? undefined,
      finalAckSequence: session.final_ack_sequence ?? undefined,
      sessionWorkspacePath: session.session_workspace_path ?? undefined,
      approvedWorktreeRoots: this.sessionCleanupRoots(session),
      currentPhase,
      agents: agents.map((row) => ({
        agentId: row.id,
        alias: row.alias,
        specialty: row.specialty,
        responsibility: row.responsibility,
        cli: row.cli,
        model: row.model,
        role: row.role,
        status: row.status,
        statusNote: row.status_note ?? undefined,
        lastAckSequence: row.last_ack_sequence,
      })),
    };
  }

  getSessionResumePacket(input: { sessionId: string; parentAlias?: string }) {
    const session = this.requireSession(input.sessionId);
    const parent = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
                last_ack_sequence, last_seen_at, created_at, updated_at
         FROM agents
         WHERE session_id = ? AND role = 'parent'
           AND (? IS NULL OR alias = ?)
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`
      )
      .get(input.sessionId, input.parentAlias ?? null, input.parentAlias ?? null) as AgentRow | undefined;
    if (!parent) {
      throw new Error(input.parentAlias
        ? `No parent agent found for alias '${input.parentAlias}'`
        : "No parent agent found for this session");
    }
    const summary = this.getSessionSummary(input.sessionId);
    const workItems = this.listWorkItems({ sessionId: input.sessionId }).workItems;
    const runtimes = this.listRuntimes({ sessionId: input.sessionId }).runtimes;
    const latestSequence = this.currentMaxSequence(input.sessionId);
    const unread = this.listMessagesSince({
      sessionId: input.sessionId,
      actorToken: parent.token,
      afterSequence: parent.last_ack_sequence,
    }).messages;
    const isResumableExit = (runtime: (typeof runtimes)[number]) =>
      runtime.status === "exited"
      && (runtime.launchMode === "resume-command" || Boolean(runtime.cliSessionId));

    return {
      session: {
        sessionId: session.id,
        status: session.status,
        lifecycleStage: session.lifecycle_stage,
        taskSlug: session.task_slug,
        title: session.title,
        projectRoot: session.project_root,
        sessionWorkspacePath: session.session_workspace_path ?? undefined,
        approvedWorktreeRoots: this.sessionCleanupRoots(session),
        currentPhase: summary.currentPhase,
      },
      parent: {
        agentId: parent.id,
        alias: parent.alias,
        actorToken: parent.token,
        lastAckSequence: parent.last_ack_sequence,
      },
      agents: summary.agents.map((agent) => ({
        agentId: agent.agentId,
        alias: agent.alias,
        specialty: agent.specialty,
        responsibility: agent.responsibility,
        cli: agent.cli,
        model: agent.model,
        role: agent.role,
        status: agent.status,
      })),
      workItems: workItems.map((item) => ({
        workItemId: item.workItemId,
        phaseNumber: item.phaseNumber,
        title: item.title,
        status: item.status,
        ownerAgentId: item.ownerAgentId,
        ownerAlias: item.ownerAlias,
        assigneeAgentIds: item.assigneeAgentIds,
        assigneeAliases: item.assigneeAliases,
      })),
      runtimes,
      activeRuntimes: runtimes.filter((runtime) => runtime.status === "running" || isResumableExit(runtime)),
      messages: {
        latestSequence,
        parentLastAckSequence: parent.last_ack_sequence,
        unreadCount: unread.length,
        unreadPreview: unread.slice(0, 10).map((message) => ({
          messageId: message.messageId,
          sequence: message.sequence,
          senderAlias: message.senderAlias,
          kind: message.kind,
          bodyPreview: message.body.slice(0, 200),
          requiresResponse: message.requiresResponse,
          requiresAck: message.requiresAck,
        })),
      },
      openObligations: this.listOpenObligations(input.sessionId),
      nextSuggestedOperations: [
        "parent_poll",
        "list_worker_processes",
        "get_worker_log",
        "list_results",
        "get_closeout_checklist",
      ],
    };
  }

  listAgents(sessionId: string) {
    const summary = this.getSessionSummary(sessionId);
    return { sessionId, agents: summary.agents };
  }

  getAgentState(agentId: string) {
    const agent = this.requireAgentById(agentId);
    return {
      agentId: agent.id,
      alias: agent.alias,
      specialty: agent.specialty,
      responsibility: agent.responsibility,
      role: agent.role,
      status: agent.status,
      note: agent.status_note ?? undefined,
      lastAckSequence: agent.last_ack_sequence,
    };
  }

  listSessionsForDashboard(input: {
    projectRoot?: string;
    since?: string;
    includeCompleted?: boolean;
    includeArchived?: boolean;
    statuses?: SessionStatus[];
    sessionId?: string;
  } = {}) {
    const since = input.since ?? new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const sessions = this.db
      .prepare(
        `SELECT id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
                current_phase_goal, completed_summary, lifecycle_stage, required_ack_sequence,
                final_ack_sequence, session_workspace_path, terminal_reason, created_at, updated_at,
                completed_at, abandoned_at, archived_at
         FROM sessions
         WHERE (? IS NULL OR project_root = ?)
           AND (? IS NULL OR id = ?)
            AND (
              ? = 1
              OR status = 'active'
              OR (
                status = 'abandoned'
                AND EXISTS (
                  SELECT 1 FROM worktrees
                  WHERE worktrees.session_id = sessions.id
                    AND worktrees.status = 'cleanup-needed'
                )
              )
              OR (? = 1 AND status = 'completed' AND updated_at >= ?)
              OR (? = 1 AND status = 'archived')
            )
            AND (
              ? = 1
             OR status != 'archived'
           )
         ORDER BY updated_at DESC, created_at DESC`
      )
      .all(
        input.projectRoot ?? null,
        input.projectRoot ?? null,
        input.sessionId ?? null,
        input.sessionId ?? null,
        input.sessionId ? 1 : 0,
        input.includeCompleted === false ? 0 : 1,
        since,
        input.includeArchived ? 1 : 0,
        input.includeArchived ? 1 : 0
      ) as SessionRow[];

    return sessions.map((session) => {
      const audit = this.getAuditReport(session.id);
      const agents = this.db
        .prepare(
          `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
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
                  related_work_item_id, reply_to_message_id, requires_response, requires_ack,
                  obligation_kind, due_stage, created_at
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
          `SELECT id, session_id, agent_id, pid, transport, adapter, launch_mode, cli_session_id,
                  command, cwd, managed_by_server, stdin_writable, resume_supported, session_export_path,
                  last_output_at, started_at, exited_at, exit_code, status,
                  last_seen_at, heartbeat_interval_seconds, stale_after_seconds, updated_at
           FROM runtimes WHERE session_id = ? ORDER BY started_at DESC`
        )
        .all(session.id) as RuntimeRow[];
      const runtimes = runtimeRows.map((row) => this.mapRuntime(row));

      return {
        sessionId: session.id,
        title: session.title,
        taskSlug: session.task_slug,
        status: session.status,
        lifecycleStage: session.lifecycle_stage,
        lastActivityAt: session.updated_at,
        createdAt: session.created_at,
        terminalReason: session.terminal_reason ?? undefined,
        currentFocus: this.deriveCurrentFocus(session),
        openObligationCount: this.countOpenObligations(session.id),
        unackedBoundaryCount: this.countUnackedBoundaryAgents(session),
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
        runtimes,
        activeRuntimes: runtimes.filter((runtime) => runtime.status === "running"),
        latestMessage: latestMessage ? this.mapMessage(latestMessage) : undefined,
        auditSummary: {
          workerCount: audit.rollup.workerCount,
          messageCount: audit.rollup.messageCount,
          directMessageCount: audit.rollup.directMessageCount,
          activeRuntimeCount: audit.rollup.activeRuntimeCount,
          blockedStatusEventCount: audit.rollup.blockedStatusEventCount,
          pairTrafficSpecialtyCount: audit.rollup.pairTrafficSpecialtyCount,
        },
      };
    });
  }

  private mapWorkItem(row: WorkItemRow) {
    const owner = row.owner_agent_id ? this.requireAgentById(row.owner_agent_id) : undefined;
    const assignees = this.getWorkItemAssignees(row.id);
    return {
      workItemId: row.id,
      phaseNumber: row.phase_number,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptance_criteria ?? undefined,
      ownerAgentId: row.owner_agent_id ?? undefined,
      ownerAlias: owner?.alias,
      assigneeAgentIds: assignees.map((assignee) => assignee.agentId),
      assigneeAliases: assignees.map((assignee) => assignee.alias),
      primaryAssigneeAgentId: assignees.find((assignee) => assignee.isPrimary)?.agentId ?? row.owner_agent_id ?? undefined,
      status: row.status,
      activeClaims: this.getActiveClaimsForWorkItem(row.id).map((claim) => this.mapWorkItemClaim(claim)),
      dependsOnIds: JSON.parse(row.depends_on_ids) as string[],
    };
  }

  private mapWorkItemClaim(row: WorkItemClaimRow) {
    const agent = this.requireAgentById(row.agent_id);
    return {
      claimId: row.id,
      sessionId: row.session_id,
      workItemId: row.work_item_id,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      claimedAt: row.claimed_at,
      releasedAt: row.released_at ?? undefined,
      releaseReason: row.release_reason ?? undefined,
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
      replyToMessageId: row.reply_to_message_id ?? undefined,
      requiresResponse: Boolean(row.requires_response),
      requiresAck: Boolean(row.requires_ack),
      obligationKind: row.obligation_kind ?? undefined,
      dueStage: row.due_stage ?? undefined,
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
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentAlias: agent.alias,
      pid: row.pid ?? undefined,
      transport: row.transport,
      adapter: row.adapter ?? undefined,
      launchMode: row.launch_mode ?? undefined,
      cliSessionId: row.cli_session_id ?? undefined,
      command: row.command ?? undefined,
      cwd: row.cwd ?? undefined,
      managedByServer: Boolean(row.managed_by_server),
      stdinWritable: Boolean(row.stdin_writable),
      resumeSupported: Boolean(row.resume_supported),
      inputDelivery: row.launch_mode === "pty"
        ? "pty"
        : row.stdin_writable
          ? "stdin"
          : row.resume_supported
          ? "resume-command"
          : "unsupported",
      sessionExportPath: row.session_export_path ?? undefined,
      lastOutputAt: row.last_output_at ?? undefined,
      startedAt: row.started_at,
      exitedAt: row.exited_at ?? undefined,
      exitCode: row.exit_code ?? undefined,
      status: row.status as RuntimeStatus,
      lastSeenAt: row.last_seen_at,
      heartbeatIntervalSeconds: row.heartbeat_interval_seconds ?? undefined,
      staleAfterSeconds: row.stale_after_seconds ?? undefined,
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

  private groupWorkItemsByStatus(workItems: ReturnType<TeamworkStore["mapWorkItem"]>[]) {
    const groups: Record<WorkItemStatus, typeof workItems> = {
      planned: [],
      assigned: [],
      "in-progress": [],
      blocked: [],
      done: [],
      canceled: [],
    };
    for (const item of workItems) {
      groups[item.status].push(item);
    }
    return groups;
  }

  private isRuntimeStale(runtime: ReturnType<TeamworkStore["mapRuntime"]>) {
    if (runtime.status !== "running" || !runtime.staleAfterSeconds) return false;
    return Date.now() - Date.parse(runtime.lastSeenAt) > runtime.staleAfterSeconds * 1000;
  }

  private summarizeRuntimeHandoffExcerpt(excerpt: string) {
    const lines = excerpt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const marker = lines.find((line) =>
      /\b(summary|result|findings?|completed|no issues?|handoff|verification)\b/i.test(line)
    );
    return (marker ?? lines.at(-1) ?? "Runtime output captured").slice(0, 240);
  }

  private buildWorkerOutputTails(input: {
    sessionId: string;
    parentAgentId: string;
    workerProcesses: ReturnType<TeamworkStore["mapRuntime"]>[];
    runtimeIds?: string[];
    maxLines?: number;
    maxChars?: number;
    streams?: WorkerOutputTailStream[];
  }) {
    const maxLines = Math.max(1, Math.min(input.maxLines ?? 5, 10));
    const maxChars = Math.max(1, Math.min(input.maxChars ?? 1000, 2000));
    const requestedRuntimeIds = input.runtimeIds?.length
      ? input.runtimeIds
      : input.workerProcesses.map((runtime) => runtime.runtimeId);
    const runtimeIdSet = new Set(input.workerProcesses.map((runtime) => runtime.runtimeId));
    const streamSet = new Set(input.streams?.length ? input.streams : ["stdout", "stderr", "stdin", "system"]);
    if (streamSet.has("runtime")) streamSet.add("system");
    streamSet.delete("prompt");

    return requestedRuntimeIds
      .filter((runtimeId) => runtimeIdSet.has(runtimeId))
      .map((runtimeId) => {
        const runtime = input.workerProcesses.find((entry) => entry.runtimeId === runtimeId);
        const log = this.readRuntimeLogs({
          sessionId: input.sessionId,
          runtimeId,
          parentAgentId: input.parentAgentId,
          mode: "tail",
          limit: 100,
        });
        const lines = log.events
          .filter((event) => streamSet.has(event.stream))
          .flatMap((event) =>
            event.text
              .split(/\r?\n/)
              .filter((line) => line.length > 0)
              .map((line) => ({
                runtimeLogId: event.runtimeLogId,
                stream: event.stream,
                text: line,
                createdAt: event.createdAt,
              }))
          )
          .slice(-maxLines);
        let remainingChars = maxChars;
        const cappedLines = [];
        for (const line of lines) {
          if (remainingChars <= 0) break;
          const text = line.text.length > remainingChars ? line.text.slice(0, remainingChars) : line.text;
          cappedLines.push({ ...line, text });
          remainingChars -= text.length;
        }
        return {
          runtimeId,
          agentId: runtime?.agentId,
          agentAlias: runtime?.agentAlias,
          mode: "tail" as const,
          totalEventCount: log.totalCount,
          lines: cappedLines,
          truncated: log.truncated || cappedLines.length < lines.length,
        };
      });
  }

  private listOpenObligations(sessionId: string) {
    const rows = this.db
      .prepare(
        `SELECT message_obligations.id AS obligationId,
                message_obligations.question_message_id AS messageId,
                message_obligations.from_agent_id AS fromAgentId,
                from_agent.alias AS fromAlias,
                message_obligations.to_agent_id AS toAgentId,
                to_agent.alias AS toAlias,
                message_obligations.kind AS kind,
                message_obligations.due_stage AS dueStage,
                message_obligations.created_at AS createdAt
         FROM message_obligations
         JOIN agents AS from_agent ON from_agent.id = message_obligations.from_agent_id
         JOIN agents AS to_agent ON to_agent.id = message_obligations.to_agent_id
         WHERE message_obligations.session_id = ? AND message_obligations.status = 'open'
         ORDER BY message_obligations.created_at ASC`
      )
      .all(sessionId) as Array<{
        obligationId: string;
        messageId: string;
        fromAgentId: string;
        fromAlias: string;
        toAgentId: string;
        toAlias: string;
        kind: string;
        dueStage: string;
        createdAt: string;
      }>;
    return rows;
  }

  private createCheckpointInternal(input: {
    sessionId: string;
    phaseNumber: number;
    kind: CheckpointKind;
    label: string;
  }) {
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

  private requireSession(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT id, title, task_slug, project_root, status, current_phase_number, current_phase_title,
                current_phase_goal, completed_summary, lifecycle_stage, required_ack_sequence,
                final_ack_sequence, session_workspace_path, approved_worktree_roots, terminal_reason, created_at, updated_at,
                completed_at, abandoned_at, archived_at
         FROM sessions
         WHERE id = ?`
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return row;
  }

  private requireActiveSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new Error(`Session is ${session.status}, not active`);
    }
    return session;
  }

  private requireActor(sessionId: string, token: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
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
        `SELECT id, session_id, alias, specialty, responsibility, cli, model, role, token, status, status_note,
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

  private requireWorkItemRow(workItemId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, phase_number, title, description, acceptance_criteria,
                owner_agent_id, status, depends_on_ids, created_at, updated_at
         FROM work_items WHERE id = ?`
      )
      .get(workItemId) as WorkItemRow | undefined;
    if (!row) {
      throw new Error(`Unknown work item: ${workItemId}`);
    }
    return row;
  }

  private validateAssignees(sessionId: string, assigneeAgentIds: string[], primaryAssigneeAgentId?: string) {
    if (assigneeAgentIds.length === 0) return;
    const uniqueIds = new Set(assigneeAgentIds);
    if (uniqueIds.size !== assigneeAgentIds.length) {
      throw new Error("Duplicate work item assignee");
    }
    for (const agentId of assigneeAgentIds) {
      const agent = this.requireAgentById(agentId);
      if (agent.session_id !== sessionId) {
        throw new Error("Assigned agent does not belong to this session");
      }
      if (agent.role !== "worker") {
        throw new Error("Work items can only be assigned to workers");
      }
    }
    if (primaryAssigneeAgentId && !uniqueIds.has(primaryAssigneeAgentId)) {
      throw new Error("Primary assignee must be included in assigneeAgentIds");
    }
  }

  private replaceWorkItemAssignees(workItemId: string, assigneeAgentIds: string[], primaryAssigneeAgentId?: string) {
    this.db.prepare(`DELETE FROM work_item_assignees WHERE work_item_id = ?`).run(workItemId);
    const insert = this.db.prepare(
      `INSERT INTO work_item_assignees (work_item_id, agent_id, is_primary, assigned_at)
       VALUES (?, ?, ?, ?)`
    );
    const now = this.now();
    for (const agentId of assigneeAgentIds) {
      insert.run(workItemId, agentId, agentId === primaryAssigneeAgentId ? 1 : 0, now);
    }
  }

  private getWorkItemAssignees(workItemId: string) {
    const rows = this.db
      .prepare(
        `SELECT wia.agent_id AS agentId, agents.alias AS alias, wia.is_primary AS isPrimary
         FROM work_item_assignees wia
         JOIN agents ON agents.id = wia.agent_id
         WHERE wia.work_item_id = ?
         ORDER BY wia.is_primary DESC, wia.assigned_at ASC`
      )
      .all(workItemId) as Array<{ agentId: string; alias: string; isPrimary: number }>;
    return rows.map((row) => ({
      agentId: row.agentId,
      alias: row.alias,
      isPrimary: Boolean(row.isPrimary),
    }));
  }

  private isAssignedToWorkItem(workItemId: string, agentId: string) {
    const count = this.db
      .prepare(`SELECT COUNT(*) AS count FROM work_item_assignees WHERE work_item_id = ? AND agent_id = ?`)
      .get(workItemId, agentId) as { count: number };
    return count.count > 0;
  }

  private assigneesHaveResults(workItemId: string) {
    const assignees = this.getWorkItemAssignees(workItemId);
    if (assignees.length === 0) return true;
    for (const assignee of assignees) {
      const count = this.db
        .prepare(`SELECT COUNT(*) AS count FROM results WHERE work_item_id = ? AND agent_id = ?`)
        .get(workItemId, assignee.agentId) as { count: number };
      if (count.count === 0) return false;
    }
    return true;
  }

  private requireWorkItemClaimRow(claimId: string) {
    const row = this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
         FROM work_item_claims WHERE id = ?`
      )
      .get(claimId) as WorkItemClaimRow | undefined;
    if (!row) throw new Error("Unknown work item claim");
    return row;
  }

  private getActiveClaimForAgent(sessionId: string, agentId: string) {
    return this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
         FROM work_item_claims
         WHERE session_id = ? AND agent_id = ? AND released_at IS NULL
         ORDER BY claimed_at ASC
         LIMIT 1`
      )
      .get(sessionId, agentId) as WorkItemClaimRow | undefined;
  }

  private getActiveClaimsForWorkItem(workItemId: string) {
    return this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
         FROM work_item_claims
         WHERE work_item_id = ? AND released_at IS NULL
         ORDER BY claimed_at ASC`
      )
      .all(workItemId) as WorkItemClaimRow[];
  }

  private listActiveClaimsForSession(sessionId: string) {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
         FROM work_item_claims
         WHERE session_id = ? AND released_at IS NULL
         ORDER BY claimed_at ASC`
      )
      .all(sessionId) as WorkItemClaimRow[];
    return rows.map((row) => this.mapWorkItemClaim(row));
  }

  private releaseActiveClaimsForWorkItem(input: { workItemId: string; agentIds?: string[]; reason: string }) {
    const now = this.now();
    const claims = this.getActiveClaimsForWorkItem(input.workItemId).filter((claim) =>
      input.agentIds ? input.agentIds.includes(claim.agent_id) : true
    );
    for (const claim of claims) {
      this.db
        .prepare(`UPDATE work_item_claims SET released_at = ?, release_reason = ? WHERE id = ?`)
        .run(now, input.reason, claim.id);
    }
  }

  private assertPhaseWorkItemsDone(sessionId: string, phaseNumber: number) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM work_items
         WHERE session_id = ? AND phase_number = ? AND status NOT IN ('done', 'canceled')`
      )
      .get(sessionId, phaseNumber) as { count: number };
    if (row.count > 0) {
      throw new Error("Cannot continue while phase work items are not done");
    }
  }

  private assertNoOpenWorkItems(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM work_items
         WHERE session_id = ? AND status NOT IN ('done', 'canceled')`
      )
      .get(sessionId) as { count: number };
    if (row.count > 0) {
      throw new Error("Cannot complete session while work items are still open");
    }
  }

  private assertWorktreesCleaned(sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM worktrees
         WHERE session_id = ? AND status NOT IN ('removed', 'cleanup-needed')`
      )
      .get(sessionId) as { count: number };
    if (row.count > 0) {
      throw new Error("Cannot complete session while registered worktrees still need cleanup");
    }
  }

  private assertNoOpenObligations(sessionId: string, dueStage: "phase" | "final") {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM message_obligations
         WHERE session_id = ? AND status = 'open' AND due_stage IN (?, 'final')`
      )
      .get(sessionId, dueStage) as { count: number };
    if (row.count > 0) {
      throw new Error("Cannot continue while there are open obligations");
    }
  }

  private assertAckGate(sessionId: string, sequence: number) {
    if (sequence <= 0) return;
    const agents = this.db
      .prepare(
        `SELECT id, last_ack_sequence AS lastAckSequence
         FROM agents
         WHERE session_id = ? AND role = 'worker' AND status != 'inactive'`
      )
      .all(sessionId) as Array<{ id: string; lastAckSequence: number }>;
    for (const agent of agents) {
      if (agent.lastAckSequence >= sequence) continue;
      const unreadVisible = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages
           WHERE session_id = ?
             AND sequence <= ?
             AND sequence > ?
             AND sender_agent_id != ?
             AND (target_type = 'broadcast' OR target_agent_id = ?)`
        )
        .get(sessionId, sequence, agent.lastAckSequence, agent.id, agent.id) as { count: number };
      if (unreadVisible.count > 0) {
        throw new Error("Cannot continue until active agents acknowledge boundary messages");
      }
    }
  }

  private canParentCloseoutAckWorker(
    worker: { status: AgentStatus },
    runtimes: Array<{
      status: RuntimeStatus;
      launchMode?: string;
      cliSessionId?: string;
      resumeSupported?: boolean;
    }>
  ) {
    if (["idle", "done", "inactive"].includes(worker.status)) return true;
    if (runtimes.length === 0) return false;
    return runtimes.every((runtime) =>
      runtime.status !== "running"
      && (
        runtime.resumeSupported
        || runtime.launchMode === "resume-command"
        || Boolean(runtime.cliSessionId)
      )
    );
  }

  private visibleMessageCountForAgent(sessionId: string, agentId: string, afterSequence: number, upToSequence: number) {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE session_id = ?
           AND sequence <= ?
           AND sequence > ?
           AND sender_agent_id != ?
           AND (target_type = 'broadcast' OR target_agent_id = ?)`
      )
      .get(sessionId, upToSequence, afterSequence, agentId, agentId) as { count: number }).count;
  }

  private resolveAckObligationsForAgent(sessionId: string, agentId: string, upToSequence: number, now: string) {
    return this.db
      .prepare(
        `UPDATE message_obligations
         SET status = 'resolved', resolved_at = ?
         WHERE session_id = ? AND to_agent_id = ? AND kind = 'ack' AND status = 'open'
           AND question_message_id IN (
             SELECT id FROM messages WHERE session_id = ? AND sequence <= ?
            )`
      )
      .run(now, sessionId, agentId, sessionId, upToSequence).changes;
  }

  private integrationEventCount(sessionId: string, phaseNumber?: number) {
    if (phaseNumber === undefined) return 0;
    return (this.db
      .prepare(`SELECT COUNT(*) AS count FROM integration_events WHERE session_id = ? AND phase_number = ?`)
      .get(sessionId, phaseNumber) as { count: number }).count;
  }

  private serializeResultData(data: string | Record<string, unknown>) {
    return typeof data === "string" ? data : JSON.stringify(data);
  }

  private parseApprovedWorktreeRoots(raw: string | null) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }

  private cleanupRootsForSessionData(sessionWorkspacePath: string | null, approvedWorktreeRoots: string | null) {
    const roots = new Set<string>();
    if (sessionWorkspacePath) {
      roots.add(path.resolve(sessionWorkspacePath, "worktrees"));
    }
    for (const root of this.parseApprovedWorktreeRoots(approvedWorktreeRoots)) {
      roots.add(path.resolve(root));
    }
    return Array.from(roots);
  }

  private sessionCleanupRoots(session: Pick<SessionRow, "session_workspace_path" | "approved_worktree_roots">) {
    return this.cleanupRootsForSessionData(session.session_workspace_path, session.approved_worktree_roots);
  }

  private rememberApprovedWorktreeRoot(
    session: Pick<SessionRow, "session_workspace_path" | "approved_worktree_roots">,
    sessionId: string,
    worktreePath: string
  ) {
    const resolvedPath = path.resolve(worktreePath);
    const defaultRoots = this.cleanupRootsForSessionData(session.session_workspace_path, null);
    if (defaultRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`))) {
      return false;
    }
    const roots = new Set(this.parseApprovedWorktreeRoots(session.approved_worktree_roots));
    if (roots.has(resolvedPath)) return false;
    roots.add(resolvedPath);
    this.db
      .prepare(`UPDATE sessions SET approved_worktree_roots = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(Array.from(roots)), this.now(), sessionId);
    return true;
  }

  private maybeAutoIdleWorker(sessionId: string, agentId: string, now: string) {
    const agent = this.requireAgentById(agentId);
    if (agent.status === "idle" || agent.status === "inactive") return;
    const hasOpenAssignedWork = this.listWorkItems({ sessionId }).workItems.some(
      (item) =>
        item.assigneeAgentIds.includes(agentId)
        && item.status !== "done"
        && item.status !== "canceled"
    );
    if (hasOpenAssignedWork) return;
    const openObligations = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM message_obligations
         WHERE session_id = ? AND to_agent_id = ? AND status = 'open'`
      )
      .get(sessionId, agentId) as { count: number };
    if (openObligations.count > 0) return;
    // Idle means "ready for follow-up" here, not "gone": the worker already handed off
    // its current slice and should no longer look active in parent polling.
    this.db
      .prepare(
        `UPDATE agents
         SET status = 'idle', status_note = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run("Awaiting parent follow-up or teardown after result handoff.", now, now, agentId);
    this.recordAgentStatusEvent({
      sessionId,
      agentId,
      changedByAgentId: agentId,
      fromStatus: agent.status,
      toStatus: "idle",
      note: "Auto-idled after result handoff with no remaining assigned work.",
    });
  }

  private runSafeCloseoutHealing(input: {
    sessionId: string;
    actorToken: string;
    stage: "phase" | "final";
    phaseNumber?: number;
  }) {
    const acked = this.closeoutAckWorkers({
      sessionId: input.sessionId,
      actorToken: input.actorToken,
      stage: input.stage,
    });
    let cleanedWorktrees = 0;
    if (input.stage === "final") {
      const session = this.requireSession(input.sessionId);
      for (const worktree of this.listWorktrees({ sessionId: input.sessionId }).worktrees.filter(
        (entry) => entry.status !== "removed"
          && this.canJanitorRemoveWorktree(entry.path, session.session_workspace_path, session.approved_worktree_roots)
      )) {
        try {
          const result = this.cleanupWorktree({
            sessionId: input.sessionId,
            actorToken: input.actorToken,
            worktreeId: worktree.worktreeId,
          });
          if (result.removed) cleanedWorktrees += 1;
        } catch {
          // cleanupWorktree already records the failure and leaves a deterministic blocker.
        }
      }
    }
    if (acked.ackedAgents.length > 0 || cleanedWorktrees > 0) {
      this.recordDebugEvent({
        sessionId: input.sessionId,
        eventType: "closeout_evaluation",
        toolName: "closeout_auto_heal",
        payload: {
          stage: input.stage,
          autoAckedAgents: acked.ackedAgents.length,
          cleanedWorktrees,
        },
      });
    }
  }

  private removePathWithRetries(targetPath: string) {
    const candidates = [targetPath, this.longPath(targetPath)];
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const candidate of candidates) {
        try {
          if (existsSync(candidate)) {
            rmSync(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
          }
          if (!existsSync(targetPath)) return;
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (lastError) throw lastError;
  }

  private longPath(targetPath: string) {
    if (process.platform !== "win32") return targetPath;
    const resolved = path.resolve(targetPath);
    if (resolved.startsWith("\\\\?\\")) return resolved;
    if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
    return `\\\\?\\${resolved}`;
  }

  private collectCopilotSessionEvents(runtimes: Array<{
    runtimeId: string;
    agentAlias?: string;
    adapter?: string;
    cliSessionId?: string;
    sessionExportPath?: string;
  }>) {
    return runtimes
      .filter((runtime) => runtime.adapter === "copilot" && runtime.cliSessionId)
      .map((runtime) => {
        const eventsPath = this.findCopilotEventsPath(runtime.cliSessionId!, runtime.sessionExportPath);
        return {
          runtimeId: runtime.runtimeId,
          agentAlias: runtime.agentAlias,
          cliSessionId: runtime.cliSessionId,
          eventsPath,
          tail: eventsPath ? this.readTextTail(eventsPath, 32_000) : undefined,
          note: eventsPath
            ? "Source is Copilot session-state/events.jsonl, which is more reliable for live host-side diagnostics than VS Code debug logs."
            : "No Copilot session-state/events.jsonl file found for this runtime.",
        };
      });
  }

  private findCopilotEventsPath(cliSessionId: string, sessionExportPath?: string) {
    const directCandidates = [
      path.join(os.homedir(), ".copilot", "session-state", cliSessionId, "events.jsonl"),
      path.join(os.homedir(), ".copilot", "session-state", `${cliSessionId}.jsonl`),
      sessionExportPath ? path.join(path.dirname(sessionExportPath), "events.jsonl") : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    for (const candidate of directCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    return this.findFileUnder(path.join(os.homedir(), ".copilot", "session-state"), cliSessionId, "events.jsonl", 4, 500);
  }

  private findFileUnder(root: string, needle: string, fileName: string, maxDepth: number, maxEntries: number) {
    if (!existsSync(root) || maxDepth < 0 || maxEntries <= 0) return undefined;
    let remaining = maxEntries;
    const visit = (dir: string, depth: number): string | undefined => {
      if (remaining <= 0 || depth < 0) return undefined;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return undefined;
      }
      for (const entry of entries) {
        if (remaining-- <= 0) return undefined;
        const fullPath = path.join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isFile() && entry === fileName && fullPath.includes(needle)) return fullPath;
        if (stat.isDirectory()) {
          const found = visit(fullPath, depth - 1);
          if (found) return found;
        }
      }
      return undefined;
    };
    return visit(root, maxDepth);
  }

  private readTextTail(filePath: string, maxChars: number) {
    try {
      const text = readFileSync(filePath, "utf8");
      return text.length > maxChars ? text.slice(-maxChars) : text;
    } catch {
      return undefined;
    }
  }

  private parseDebugPayload(payload: string | null) {
    if (!payload) return undefined;
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private closeoutError(message: string, diagnostics: unknown) {
    const counts = (diagnostics as { counts?: Record<string, number> })?.counts ?? {};
    const labels = [];
    if ((counts.openWorkItems ?? 0) > 0) labels.push("open work items");
    if ((counts.openObligations ?? 0) > 0) labels.push("open obligations");
    if ((counts.unackedBoundaryAgents ?? 0) > 0) labels.push("acknowledge boundary messages");
    if ((counts.worktreesNeedingCleanup ?? 0) > 0) labels.push("worktree cleanup");
    if ((counts.runtimesBlocking ?? 0) > 0) labels.push("worker runtimes are still running");
    const reason = labels.length ? ` Blockers: ${labels.join(", ")}.` : "";
    const error = new Error(`${message}.${reason} Diagnostics: ${JSON.stringify(diagnostics)}`);
    (error as Error & { diagnostics?: unknown }).diagnostics = diagnostics;
    return error;
  }

  private currentMaxSequence(sessionId: string) {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM messages WHERE session_id = ?`)
      .get(sessionId) as { max_sequence: number };
    return row.max_sequence;
  }

  private assertAllowedCli(cli: string) {
    if (!["codex", "claude", "gemini", "opencode", "copilot", "fake"].includes(cli)) {
      throw new Error(`Worker agents must use an approved external CLI, got ${cli}`);
    }
  }

  private assertCliRuntimeTransport(transport: string) {
    if ((!/cli|stdio/i.test(transport)) || /subagent|sub-agent|built-in|builtin|task/i.test(transport)) {
      throw new Error(`Worker runtimes must be external CLI transports, got ${transport}`);
    }
  }

  private canJanitorRemoveWorktree(
    worktreePath: string,
    sessionWorkspacePath: string | null,
    approvedWorktreeRoots: string | null = null
  ) {
    const target = path.resolve(worktreePath);
    return this.cleanupRootsForSessionData(sessionWorkspacePath, approvedWorktreeRoots).some(
      (root) => target === root || target.startsWith(`${root}${path.sep}`)
    );
  }

  private writeAuditReport(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.session_workspace_path) return;
    const report = this.getAuditReport(sessionId);
    mkdirSync(session.session_workspace_path, { recursive: true });
    const lines = [
      `# Teamwork Audit Report`,
      ``,
      `Session: ${report.session.title}`,
      `Status: ${report.session.status}`,
      `Updated: ${report.session.updatedAt}`,
      ``,
      `## Rollup`,
      ``,
      `- Workers: ${report.rollup.workerCount}`,
      `- Work items: ${report.rollup.workItemCount}`,
      `- Messages: ${report.rollup.messageCount}`,
      `- Results: ${report.rollup.resultCount}`,
      `- Active runtimes: ${report.rollup.activeRuntimeCount}`,
      `- Block events: ${report.rollup.blockedStatusEventCount}`,
      ``,
      `## Agents`,
      ``,
      ...report.agents.map((agent: any) =>
        `- ${agent.alias} (${agent.role}, ${agent.specialty}): ${agent.currentStatus}; ${agent.messageCount ?? agent.messagesSentCount} sent, ${agent.messagesReceivedCount} received, ${agent.resultCount} results`
      ),
      ``,
    ];
    writeFileSync(path.join(session.session_workspace_path, "audit-report.md"), `${lines.join("\n")}\n`, "utf8");
  }

  private deriveCurrentFocus(session: SessionRow) {
    const obligations = this.countOpenObligations(session.id);
    if (obligations > 0) return `Waiting on ${obligations} required response${obligations === 1 ? "" : "s"}`;
    if (session.status !== "active") return session.status;
    if (session.lifecycle_stage === "executing") {
      const openWork = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM work_items
           WHERE session_id = ? AND status NOT IN ('done', 'canceled')`
        )
        .get(session.id) as { count: number };
      return openWork.count > 0 ? `Workers executing ${openWork.count} open item${openWork.count === 1 ? "" : "s"}` : "Execution ready for integration";
    }
    if (session.lifecycle_stage === "integrating") return "Parent integration";
    if (session.lifecycle_stage === "finalizing") return "Final sync and cleanup";
    return "Planning next phase";
  }

  private countOpenObligations(sessionId: string) {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM message_obligations WHERE session_id = ? AND status = 'open'`)
      .get(sessionId) as { count: number };
    return row.count;
  }

  private countUnackedBoundaryAgents(session: SessionRow) {
    const sequence = session.lifecycle_stage === "finalizing"
      ? session.final_ack_sequence
      : session.required_ack_sequence;
    if (!sequence) return 0;
    const agents = this.db
      .prepare(
        `SELECT id, last_ack_sequence AS lastAckSequence
         FROM agents
         WHERE session_id = ? AND role = 'worker' AND status != 'inactive'`
      )
      .all(session.id) as Array<{ id: string; lastAckSequence: number }>;
    let count = 0;
    for (const agent of agents) {
      if (agent.lastAckSequence >= sequence) continue;
      const unreadVisible = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages
           WHERE session_id = ?
             AND sequence <= ?
             AND sequence > ?
             AND sender_agent_id != ?
             AND (target_type = 'broadcast' OR target_agent_id = ?)`
        )
        .get(session.id, sequence, agent.lastAckSequence, agent.id, agent.id) as { count: number };
      if (unreadVisible.count > 0) count += 1;
    }
    return count;
  }

  private unackedBoundaryAgents(sessionId: string, sequence: number) {
    const agents = this.db
      .prepare(
        `SELECT id, alias, last_ack_sequence AS lastAckSequence
         FROM agents
         WHERE session_id = ? AND role = 'worker' AND status != 'inactive'`
      )
      .all(sessionId) as Array<{ id: string; alias: string; lastAckSequence: number }>;
    const unacked = [];
    for (const agent of agents) {
      if (agent.lastAckSequence >= sequence) continue;
      const unreadVisible = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM messages
           WHERE session_id = ?
             AND sequence <= ?
             AND sequence > ?
             AND sender_agent_id != ?
             AND (target_type = 'broadcast' OR target_agent_id = ?)`
        )
        .get(sessionId, sequence, agent.lastAckSequence, agent.id, agent.id) as { count: number };
      if (unreadVisible.count > 0) {
        unacked.push({
          agentId: agent.id,
          agentAlias: agent.alias,
          lastAckSequence: agent.lastAckSequence,
          requiredSequence: sequence,
        });
      }
    }
    return unacked;
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

  private recordAgentStatusEvent(input: {
    sessionId: string;
    agentId: string;
    changedByAgentId?: string;
    fromStatus?: string;
    toStatus: string;
    note?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO agent_status_events (
          id, session_id, agent_id, changed_by_agent_id, from_status, to_status, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.agentId,
        input.changedByAgentId ?? null,
        input.fromStatus ?? null,
        input.toStatus,
        input.note ?? null,
        this.now()
      );
  }

  private durationSeconds(startedAt: string, endedAt: string) {
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
    return Math.max(0, durationMs) / 1000;
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

  // -----------------------------------------------------------------------
  // Dashboard helpers — these bypass the actor-token gating because the
  // dashboard is a single-user local read-only surface. Do not expose these
  // through MCP tools; route writes through the standard token-gated paths.
  // -----------------------------------------------------------------------

  tryGetAgent(agentId: string) {
    const row = this.db
      .prepare(`SELECT id, alias, specialty, responsibility, cli, model, role FROM agents WHERE id = ?`)
      .get(agentId) as {
        id: string;
        alias: string;
        specialty: string;
        responsibility: string;
        cli: string;
        model: string;
        role: string;
      } | undefined;
    if (!row) return undefined;
    return {
      agentId: row.id,
      alias: row.alias,
      specialty: row.specialty,
      responsibility: row.responsibility,
      cli: row.cli,
      model: row.model,
      role: row.role,
    };
  }

  tryGetAgentByToken(token: string) {
    const row = this.db
      .prepare(`SELECT id, session_id, alias, role FROM agents WHERE token = ?`)
      .get(token) as { id: string; session_id: string; alias: string; role: string } | undefined;
    if (!row) return undefined;
    return { agentId: row.id, sessionId: row.session_id, alias: row.alias, role: row.role };
  }

  listMessagesForDashboard(input: {
    sessionId: string;
    afterSequence?: number;
    beforeSequence?: number;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(1, input.limit ?? 200), 1000);
    let rows: MessageRow[];
    if (input.beforeSequence !== undefined) {
      rows = this.db
        .prepare(
          `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                  body, related_work_item_id, reply_to_message_id, requires_response,
                  requires_ack, obligation_kind, due_stage, created_at
           FROM messages
           WHERE session_id = ? AND sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(input.sessionId, input.beforeSequence, limit) as MessageRow[];
      rows.reverse();
    } else if (input.afterSequence !== undefined) {
      rows = this.db
        .prepare(
          `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                  body, related_work_item_id, reply_to_message_id, requires_response,
                  requires_ack, obligation_kind, due_stage, created_at
           FROM messages
           WHERE session_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`
        )
        .all(input.sessionId, input.afterSequence, limit) as MessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT id, session_id, sequence, sender_agent_id, target_type, target_agent_id, kind,
                  body, related_work_item_id, reply_to_message_id, requires_response,
                  requires_ack, obligation_kind, due_stage, created_at
           FROM messages
           WHERE session_id = ?
           ORDER BY sequence DESC
           LIMIT ?`
        )
        .all(input.sessionId, limit) as MessageRow[];
      rows.reverse();
    }
    return rows.map((row) => this.mapMessage(row));
  }

  getDashboardMetrics(input: { sinceDays?: number } = {}) {
    const sinceDays = Math.max(1, input.sinceDays ?? 14);
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const sessionsPerDay = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
         FROM sessions
         WHERE created_at >= ?
         GROUP BY date
         ORDER BY date ASC`
      )
      .all(cutoff) as Array<{ date: string; count: number }>;

    const messagesPerDay = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date,
                SUM(CASE WHEN target_type = 'agent' THEN 1 ELSE 0 END) AS direct,
                SUM(CASE WHEN target_type = 'broadcast' THEN 1 ELSE 0 END) AS broadcast
         FROM messages
         WHERE created_at >= ?
         GROUP BY date
         ORDER BY date ASC`
      )
      .all(cutoff) as Array<{ date: string; direct: number; broadcast: number }>;

    const agentRows = this.db
      .prepare(
        `SELECT a.id AS agentId, a.alias AS alias,
                COALESCE(SUM(CASE WHEN ase.to_status = 'active' THEN 1 ELSE 0 END), 0) AS busyEvents,
                COALESCE(COUNT(ase.id), 0) AS totalEvents
         FROM agents a
         LEFT JOIN agent_status_events ase ON ase.agent_id = a.id AND ase.created_at >= ?
         GROUP BY a.id
         ORDER BY a.created_at DESC
         LIMIT 25`
      )
      .all(cutoff) as Array<{ agentId: string; alias: string; busyEvents: number; totalEvents: number }>;

    const agentUtilization = agentRows.map((row) => ({
      agentId: row.agentId,
      alias: row.alias,
      busyFraction: row.totalEvents > 0 ? row.busyEvents / row.totalEvents : 0,
    }));

    return {
      sessionsPerDay,
      messagesPerDay,
      avgAssignmentDurationSec: 0,
      agentUtilization,
    };
  }

  appendWorkerOutput(input: { sessionId: string; agentId: string; chunk: string }): {
    outputId: number;
    createdAt: string;
  } {
    if (!input.chunk || input.chunk.length === 0) {
      throw new Error("chunk must be non-empty");
    }
    let chunk = input.chunk;
    const MAX_CHUNK_BYTES = 64 * 1024;
    if (Buffer.byteLength(chunk, "utf8") > MAX_CHUNK_BYTES) {
      const buf = Buffer.from(chunk, "utf8");
      let end = MAX_CHUNK_BYTES;
      while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      chunk = buf.subarray(0, end).toString("utf8") + "\n[truncated]\n";
    }
    const agentRow = this.db
      .prepare(`SELECT session_id FROM agents WHERE id = ?`)
      .get(input.agentId) as { session_id: string } | undefined;
    if (!agentRow) throw new Error("agent does not belong to session");
    if (agentRow.session_id !== input.sessionId) {
      throw new Error("agent does not belong to session");
    }
    const createdAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO worker_output (session_id, agent_id, ts, chunk) VALUES (?, ?, ?, ?)`
      )
      .run(input.sessionId, input.agentId, createdAt, chunk);
    return { outputId: Number(result.lastInsertRowid), createdAt };
  }

  getWorkerOutput(input: { sessionId: string; agentId: string; sinceId?: number; limit?: number }): {
    chunks: Array<{ id: number; ts: string; chunk: string }>;
    nextSinceId: number | null;
  } {
    const limit = Math.min(Math.max(1, input.limit ?? 500), 2000);
    const sinceId = input.sinceId ?? 0;
    const agentRow = this.db
      .prepare(`SELECT session_id FROM agents WHERE id = ?`)
      .get(input.agentId) as { session_id: string } | undefined;
    if (!agentRow || agentRow.session_id !== input.sessionId) {
      throw new Error("agent does not belong to session");
    }
    const rows = this.db
      .prepare(
        `SELECT id, ts, chunk FROM worker_output
         WHERE agent_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(input.agentId, sinceId, limit) as Array<{ id: number; ts: string; chunk: string }>;
    const next = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { chunks: rows, nextSinceId: next };
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task_slug TEXT NOT NULL,
        project_root TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle_stage TEXT NOT NULL DEFAULT 'planning',
        current_phase_number INTEGER,
        current_phase_title TEXT,
        current_phase_goal TEXT,
        required_ack_sequence INTEGER,
        final_ack_sequence INTEGER,
        session_workspace_path TEXT,
        approved_worktree_roots TEXT NOT NULL DEFAULT '[]',
        task_prompt TEXT,
        completed_summary TEXT,
        terminal_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        abandoned_at TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        specialty TEXT NOT NULL,
        responsibility TEXT NOT NULL DEFAULT '',
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
        reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        requires_response INTEGER NOT NULL DEFAULT 0,
        requires_ack INTEGER NOT NULL DEFAULT 0,
        obligation_kind TEXT,
        due_stage TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS message_obligations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        question_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        due_stage TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS work_item_assignees (
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        is_primary INTEGER NOT NULL DEFAULT 0,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (work_item_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS work_item_claims (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        claimed_at TEXT NOT NULL,
        released_at TEXT,
        release_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS work_item_claims_active_agent_idx
        ON work_item_claims(session_id, agent_id)
        WHERE released_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS work_item_claims_active_item_agent_idx
        ON work_item_claims(work_item_id, agent_id)
        WHERE released_at IS NULL;

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
        adapter TEXT,
        launch_mode TEXT,
        cli_session_id TEXT,
        command TEXT,
        cwd TEXT,
        managed_by_server INTEGER NOT NULL DEFAULT 0,
        stdin_writable INTEGER NOT NULL DEFAULT 0,
        resume_supported INTEGER NOT NULL DEFAULT 0,
        session_export_path TEXT,
        last_output_at TEXT,
        started_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        last_seen_at TEXT NOT NULL DEFAULT '',
        heartbeat_interval_seconds INTEGER,
        stale_after_seconds INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_log_cursors (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
        after_runtime_log_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, parent_agent_id, runtime_id)
      );

      CREATE TABLE IF NOT EXISTS runtime_handoff_candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        has_formal_result INTEGER NOT NULL DEFAULT 0,
        session_export_path TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(runtime_id)
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

      CREATE TABLE IF NOT EXISTS agent_status_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        changed_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS debug_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        actor_agent_id TEXT,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        payload TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_output (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        chunk TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_output_agent_idx ON worker_output(agent_id, id);
      CREATE INDEX IF NOT EXISTS worker_output_session_idx ON worker_output(session_id, id);
    `);
    this.migrate();
  }

  private migrate() {
    this.ensureColumn("sessions", "lifecycle_stage", "TEXT NOT NULL DEFAULT 'planning'");
    this.ensureColumn("sessions", "required_ack_sequence", "INTEGER");
    this.ensureColumn("sessions", "final_ack_sequence", "INTEGER");
    this.ensureColumn("sessions", "session_workspace_path", "TEXT");
    this.ensureColumn("sessions", "approved_worktree_roots", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("sessions", "task_prompt", "TEXT");
    this.ensureColumn("sessions", "terminal_reason", "TEXT");
    this.ensureColumn("sessions", "completed_at", "TEXT");
    this.ensureColumn("sessions", "abandoned_at", "TEXT");
    this.ensureColumn("sessions", "archived_at", "TEXT");
    this.ensureColumn("agents", "responsibility", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("messages", "reply_to_message_id", "TEXT REFERENCES messages(id) ON DELETE SET NULL");
    this.ensureColumn("messages", "requires_response", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "requires_ack", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "obligation_kind", "TEXT");
    this.ensureColumn("messages", "due_stage", "TEXT");
    this.ensureColumn("runtimes", "last_seen_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("runtimes", "heartbeat_interval_seconds", "INTEGER");
    this.ensureColumn("runtimes", "stale_after_seconds", "INTEGER");
    this.ensureColumn("runtimes", "adapter", "TEXT");
    this.ensureColumn("runtimes", "launch_mode", "TEXT");
    this.ensureColumn("runtimes", "cli_session_id", "TEXT");
    this.ensureColumn("runtimes", "command", "TEXT");
    this.ensureColumn("runtimes", "cwd", "TEXT");
    this.ensureColumn("runtimes", "managed_by_server", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runtimes", "stdin_writable", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runtimes", "resume_supported", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runtimes", "session_export_path", "TEXT");
    this.ensureColumn("runtimes", "last_output_at", "TEXT");
    this.db.prepare(`UPDATE sessions SET approved_worktree_roots = '[]' WHERE approved_worktree_roots IS NULL`).run();
    this.db.prepare(`UPDATE runtimes SET last_seen_at = updated_at WHERE last_seen_at = ''`).run();
    this.backfillLegacyInProgressClaims();
  }

  private ensureColumn(table: string, column: string, ddl: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  private backfillLegacyInProgressClaims() {
    // Older sessions used bare in-progress status. Backfill claims only when the item has explicit assignees, preserving
    // the new "current work belongs to a worker" invariant without inventing unassigned claim ownership.
    const rows = this.db
      .prepare(
        `SELECT wi.id AS work_item_id, wi.session_id, wi.updated_at, wia.agent_id
         FROM work_items wi
         JOIN work_item_assignees wia ON wia.work_item_id = wi.id
         WHERE wi.status = 'in-progress'
           AND NOT EXISTS (
             SELECT 1 FROM work_item_claims wic
             WHERE wic.work_item_id = wi.id
               AND wic.agent_id = wia.agent_id
               AND wic.released_at IS NULL
           )`
      )
      .all() as Array<{ work_item_id: string; session_id: string; updated_at: string; agent_id: string }>;
    for (const row of rows) {
      if (this.getActiveClaimForAgent(row.session_id, row.agent_id)) continue;
      this.db
        .prepare(
          `INSERT INTO work_item_claims (
            id, session_id, work_item_id, agent_id, claimed_at, released_at, release_reason
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(randomUUID(), row.session_id, row.work_item_id, row.agent_id, row.updated_at);
    }
  }

  private now() {
    return new Date().toISOString();
  }
}
