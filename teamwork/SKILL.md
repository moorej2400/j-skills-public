---
name: teamwork
description: Use when a task should be decomposed across specialized coding agents working in isolated git worktrees with parent-led phase planning, integration, and lightweight realtime coordination.
---

# Teamwork

Use this skill to run a parent-led implementation workflow where specialized workers collaborate on one shared task through isolated worktrees and a dedicated `teamwork-mcp` session.

This is not a consensus loop and not a “same task, multiple full implementations” skill.

The parent agent running this skill is the only orchestrator.

## Target Routing

Use these references for CLI-specific session commands:

- Codex: [Codex-Teamwork.md](./Codex-Teamwork.md)
- Claude: [Claude-Teamwork.md](./Claude-Teamwork.md)
- Gemini: [Gemini-Teamwork.md](./Gemini-Teamwork.md)
- OpenCode: [OpenCode-Teamwork.md](./OpenCode-Teamwork.md)
- Copilot: [Copilot-Teamwork.md](./Copilot-Teamwork.md)

## Input Contract

Prefer a `SKILL_VARS` block in the task prompt. If `worker_pool` is omitted there, load it from `TEAMWORK_WORKER_POOL` in `teamwork/.env`.

```yaml
SKILL_VARS:
  worker_pool:
    - { cli: "copilot", model: "claude-opus-latest", reasoning_effort: "high" }
    - { cli: "copilot", model: "gpt-latest", reasoning_effort: "xhigh" }
  workers:
    - { alias: "frontend", specialty: "frontend" }
    - { alias: "backend", specialty: "backend" }
    - { alias: "api", specialty: "api" }
  max_workers: 6
  output_dir: ".teamwork"
  poll_seconds: 30
```

Rules:

- `workers` is optional. If omitted, the parent derives `2-6` specialized workers from the task.
- If the user explicitly requests worker specialties or counts, honor that unless impossible.
- `worker_pool` defines which provider/model combinations the parent may choose from.
- Each `worker_pool` entry may also include `reasoning_effort` when the target host supports it.
- Mixed providers are allowed, but only from the configured pool.
- Normalize `cli` against `codex|claude|gemini|opencode|copilot`.
- Normalize `reasoning_effort` against `minimal|low|medium|high|xhigh` when present.
- Keep one stable child session per worker alias for the full run.

## Env Defaults

Read defaults from `teamwork/.env` and keep `teamwork/.env.template` in sync with it.

- `TEAMWORK_WORKER_POOL`
  Semicolon-separated provider/model pool in the form `cli:model@reasoning_effort;cli:model@reasoning_effort;...`
  Repeated entries are allowed and act as weighted defaults.
- `TEAMWORK_MAX_WORKERS`
  Default worker cap. Default `6`.
- `TEAMWORK_OUTPUT_DIR`
  Default artifact root. Default `.teamwork`.
- `TEAMWORK_POLL_SECONDS`
  Default worker polling interval. Default `30`.

Prompt-level values win over `.env` defaults.

## Artifacts

Use a project-scoped workspace:

```text
<output_dir>/<task-slug>/
  teamwork-task.md
  roster.md
  merge-log.md
  phases/
    phase-01.md
    phase-02.md
  worktrees/
    <alias>/
```

Artifact intent:

- `teamwork-task.md`
  Canonical task decomposition, worker plan, testing plan, and acceptance criteria.
- `roster.md`
  Alias, specialty, CLI, model, child session ID, MCP agent ID, and current worktree path.
- `phases/phase-NN.md`
  Goal, work items, dependencies, testing expectations, and completion notes for that phase.
- `merge-log.md`
  Parent-owned record of phase-end integration, conflict handling, verification, and worktree refresh.

## Parent Workflow

Run this default flow:

`inspect -> decompose -> assign -> execute phase -> integrate -> refresh -> repeat if needed -> finalize`

Detailed behavior:

1. Load `teamwork/.env`, then apply `SKILL_VARS` overrides.
2. Inspect the task and repo, then write `teamwork-task.md`.
3. Decide whether the task needs one phase or multiple phases. Use phases only when they reduce drift or unlock testing.
4. Choose up to `6` workers from the allowed provider pool.
5. Start or reuse `teamwork-mcp`.
6. Create one teamwork session with `tw_create_session`.
7. Register the parent and every worker with `tw_register_agent`.
8. Create the workspace under `<output_dir>/<task-slug>/` and ensure `.teamwork/` is ignored before creating worktrees there.
9. Create one isolated worktree per worker alias under `worktrees/<alias>/`.
10. Register each worker's worktree path with `tw_set_agent_worktree` so MCP can track it.
11. Write `roster.md` and the current phase file before launching workers.
12. Give every worker the same runtime packet:
    - `WORKSPACE_DIR`
    - `PROJECT_ROOT`
    - `sessionId`
    - `agentId`
    - session auth token if your MCP deployment requires one
    - current phase goal
    - assigned work items
    - full worker roster with specialties
13. Require workers to edit only inside their worktree for the current phase.
14. Require workers to poll MCP roughly every `poll_seconds` seconds when possible.
15. Require workers to test what they can test from their assigned slice and report real results.
16. Optionally use `tw_inspect_worktree` to check worker progress through MCP instead of manual git inspection.
17. At phase end, require each worker to call `tw_report_result` and leave a clean phase commit in its worktree branch.
18. The parent integrates worker commits into `main` by merge or cherry-pick, resolves conflicts, and records the result in `merge-log.md`.
19. After integration, optionally call `tw_checkpoint` to record the merge commit, verification status, and notes in MCP.
20. The parent then refreshes every worker worktree from updated `main` by recreating the worktree at the same alias path on a fresh next-phase branch.
21. Reuse the same child session IDs per alias after refresh.
22. Stop when the planned work and required verification are complete, then write the final state into `teamwork-task.md` and `merge-log.md`.

## Worker Rules

Every worker must:

- stay inside its assigned worktree
- treat its specialty as the primary ownership boundary
- read the current phase file and assigned work items before coding
- register its worktree path with `tw_set_agent_worktree` at session start
- poll MCP for broadcast messages, DMs, and reassignment
- ask the relevant specialist instead of re-exploring another owned area when possible
- run relevant tests from the worktree and report actual results
- call `tw_report_result` with the phase commit SHA and summary before signaling done
- end the phase with a clean commit the parent can integrate

Workers may:

- broadcast status or handoff messages
- DM another worker directly
- ask the parent for reassignment or clarification

Workers must not:

- edit the main workspace
- merge into `main`
- ignore another worker’s ownership boundary without coordination

## MCP Usage

Use `teamwork-mcp` as shared session state for:

- session registration
- current phase state
- worker roster visibility
- work item assignment and status
- broadcast and DM messaging
- agent status and acknowledgement cursors
- worktree path and branch registration (`tw_set_agent_worktree`, `tw_get_agent_worktree`)
- git worktree inspection without leaving MCP (`tw_inspect_worktree`)
- worker result reporting at phase end (`tw_report_result`, `tw_list_results`)
- parent-visible phase checkpoints after integration (`tw_checkpoint`, `tw_list_checkpoints`)

The worktree, result, and checkpoint helpers are operational conveniences. They make the existing parent-led workflow smoother by giving MCP-level visibility into state that was previously only in filesystem artifacts. They do not replace the canonical artifact files (`teamwork-task.md`, `roster.md`, `merge-log.md`, phase files) or change who owns integration.

Use filesystem artifacts for the canonical task plan and phase records. Do not recreate the `roundtable-v2` draft, checkpoint, or issue model here.
