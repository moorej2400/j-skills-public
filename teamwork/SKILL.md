---
name: teamwork
description: Use when a task should be decomposed across specialized external CLI worker agents working in isolated git worktrees with parent-led phase planning, integration, and lightweight realtime coordination. Workers MUST be launched and supervised by teamwork-mcp as CLI processes, not built-in subagents.
---

# Teamwork

Use this skill to run a parent-led implementation workflow where specialized workers collaborate on one shared task through isolated worktrees and a dedicated `teamwork-mcp` session.

This is not a consensus loop and not a “same task, multiple full implementations” skill.

If the teamwork prompt is a code-review prompt, read [REVIEW.md](./REVIEW.md) and follow it in addition to this file. Otherwise skip REVIEW.md.

The parent agent running this skill is the only decision-making orchestrator.
Workers in a teamwork run MUST be external CLI sessions launched through `teamwork-mcp`. The parent MUST NOT use built-in subagents, background subagents, task agents, host-native delegation, or parent-owned shell background tasks as teamwork workers.
The parent owns planning, review, integration, and verification. The server owns CLI worker launch, input delivery, process logs, restart/stop, and final runtime teardown. The parent must not become an extra coder for source-file fixes during the run.
Once launched, a worker session must stay alive for the full teamwork run unless the parent explicitly replaces it after a crash or hard blocker. Finishing the current slice means the worker becomes idle and keeps polling; it does not mean the worker runtime may exit.

## Target Routing

The parent calls the single MCP tool as `teamwork({ tool_name, options })`. Operation options must exactly match the MCP schema; unknown or legacy fields are rejected. Use `tool_name: "help"` when exact option fields are needed, then call the real operation directly.
The parent never builds worker prompt files or launches worker CLIs with shell commands. Provider-specific CLI commands are owned by `teamwork-mcp` adapters.
The parent never builds custom HTTP polling scripts or background shell monitors for teamwork. The `/mcp` endpoint uses MCP transport semantics, not plain ad hoc JSON polling. Frequent monitoring must stay inside `parent_poll`.

## Input Contract

Prefer a `SKILL_VARS` block in the task prompt. If `worker_pool` is omitted there, load it from `TEAMWORK_WORKER_POOL` in `teamwork/.env`.

```yaml
SKILL_VARS:
  mode: "solo"
  worker_pool:
    - { cli: "copilot", model: "claude-sonnet-4.6", reasoning_effort: "high" }
    - { cli: "copilot", model: "gpt-5.4", reasoning_effort: "high" }
  workers:
    - { alias: "frontend", specialty: "frontend", responsibility: "Own UI implementation and ask API/backend workers for endpoint contracts when needed." }
    - { alias: "backend", specialty: "backend", responsibility: "Own server-side behavior and answer data-flow questions for dependent workers." }
    - { alias: "api", specialty: "api", responsibility: "Own API endpoint contracts and answer request/response questions for dependent workers." }
  max_workers: 4
  output_dir: ".teamwork"
  poll_seconds: 30
```

Rules:

- `mode` is optional. Allowed values: `solo|pair`.
- `workers` is optional. If omitted, the parent derives `2-max_workers` specialized workers from the task.
- Worker `specialty` and `responsibility` values are parent-defined for the current task. Do not use a built-in specialty list.
- Worker `responsibility` should be one or two clear sentences documenting what the agent owns and what other agents should ask it about.
- If the user explicitly requests worker specialties or counts, honor that exactly unless impossible. If impossible, stop and surface the constraint instead of silently launching fewer workers.
- An explicit worker count means the exact number of individual worker sessions to launch.
- In `pair` mode, an explicit worker count must be even because each pair uses exactly two worker sessions on one shared specialty slice.
- In `pair` mode, the explicit worker count is the total number of agents for the run, not the number of implementers plus a second set of extra review agents.
- `worker_pool` defines which provider/model combinations the parent may choose from.
- Each `worker_pool` entry may also include `reasoning_effort` when the target host supports it.
- Mixed providers are allowed, but only from the configured pool.
- Normalize `cli` against the server-managed adapters configured for `teamwork-mcp`: `codex|claude|gemini|opencode|copilot`.
- Normalize `reasoning_effort` against `minimal|low|medium|high|xhigh` when present.
- `max_workers` limits only parent-derived worker counts. It does not override an explicit user-requested count.
- Keep one stable child session per worker alias for the full run.
- Launch all planned workers for the current phase concurrently after their worktrees and runtime packets are ready. Do not intentionally stage worker rollout when the phase plan already calls for those workers.
- Prompt-level `mode` wins over `TEAMWORK_MODE`. If neither is set, default to `solo`.

## Env Defaults

Read defaults from `teamwork/.env` and keep `teamwork/.env.template` in sync with it.

- `TEAMWORK_WORKER_POOL`
  Semicolon-separated provider/model pool in the form `cli:model@reasoning_effort;cli:model@reasoning_effort;...`
  Repeated entries are allowed and act as weighted defaults.
- `TEAMWORK_MODE`
  Default teamwork mode. Allowed values: `solo|pair`. Default `solo`.
- `TEAMWORK_MAX_WORKERS`
  Default worker cap. Default `4`.
- `TEAMWORK_OUTPUT_DIR`
  Default artifact root. Default `.teamwork`.
- `TEAMWORK_POLL_SECONDS`
  Default worker polling interval. Default `30`.
- `TEAMWORK_MCP_URL`
  Singleton MCP endpoint. Default `http://127.0.0.1:48741/mcp`.
- `TEAMWORK_ALLOWED_AGENT_MCPS`
  Comma-separated MCP server names worker agents may use in addition to the mandatory `teamwork` MCP. Default blank means none.
- `TEAMWORK_ALLOWED_SKILLS`
  Comma-separated skill names worker agents may use. Default blank means none.
- `TEAMWORK_SESSION_TTL_HOURS`
  Server janitor TTL for abandoned active sessions. Default `24`.
- `TEAMWORK_WORKTREE_GC`
  Enable server worktree cleanup for terminal sessions. Default `1`.

Prompt-level values win over `.env` defaults.

## Modes

### Solo Mode

`solo` is the default mode.

- Use the existing teamwork pattern: one worker per specialty.
- Each worker gets its own worktree for the phase.
- The parent decomposes work across specialists and integrates their commits at phase end.

### Pair Mode

Use `pair` only when the prompt explicitly asks for paired workers on the same task slices.

- Keep the same specialty decomposition as `solo`, but assign two workers to each specialty instead of one.
- Treat the two workers in a pair as the complete pair for that specialty slice. Do not create an additional review-stage worker outside the pair unless the user explicitly asks for extra review agents beyond the pair count.
- Give both workers in a pair the same specialty, the same phase goal, and the same assigned work items.
- Point both workers in a pair at the same worktree path for that specialty during the phase.
- Treat the pair as collaborators inside one implementation, not as two independent reimplementations.
- Default the pair to complementary roles inside that shared implementation: one primary implementer and one reviewer/tester who checks diffs, adds coverage, and challenges assumptions before handoff.
- Require paired workers to use `teamwork-mcp` to coordinate, challenge assumptions, check each other's work, and converge on one shared implementation in the shared worktree.
- Paired workers may also coordinate with other specialties through `teamwork-mcp` for cross-boundary questions and handoffs.
- Use distinct aliases for the two workers in a pair, such as `<specialty>-a` and `<specialty>-b`, while keeping the shared specialty explicit in the roster and runtime packet.

## Artifacts

Use a project-scoped workspace:

```text
<output_dir>/<task-slug>/
  teamwork-task.md
  roster.md
  merge-log.md
  audit-report.md
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
  Parent-owned record of phase-end integration, conflict handling, verification, worktree refresh, and final cleanup.
- `audit-report.md`
  Parent-owned human-readable export of the final MCP audit report for the session. The canonical audit data stays in `teamwork-mcp`. Manual findings are secondary and must label whether each fact came from formal MCP results, visible worker/runtime logs, or parent fallback capture.

## Standard Worker Prompt

The worker prompt is owned by this file and assembled by `teamwork-mcp`.
Shared worker rules live in [WORKER_SHARED_INSTRUCTIONS.md](./WORKER_SHARED_INSTRUCTIONS.md); `teamwork-mcp` copies that file into each worker worktree at `.teamwork/WORKER_SHARED_INSTRUCTIONS.md` and embeds the essential rules in the launch prompt.

The server builds one standardized worker prompt for every worker session from the registered session, roster, phase, work items, worktree, and shared worker rules. The parent supplies the assignment context through `launch_worker` or `launch_phase_workers`.

Required worker prompt fields:

- `WORKSPACE_DIR`
- `PROJECT_ROOT`
- `TEAMWORK_MCP_URL`
- `ALLOWED_AGENT_MCPS`
- `ALLOWED_SKILLS`
- `sessionId`
- `agentId`
- private token
- current phase goal
- assigned queue
- current claimed work item, when one already exists
- full worker roster with specialties
- full worker roster with agent IDs, specialties, and parent-defined responsibilities
- assigned worker alias
- assigned specialty
- `PAIR_ROLE` when running in `pair` mode
- explicit standby rule for post-slice idle behavior
- path to the worktree-local `.teamwork/WORKER_SHARED_INSTRUCTIONS.md`

Standard worker prompt requirements:

- Tell the worker to edit only inside `WORKSPACE_DIR`.
- Tell the worker to read `.teamwork/WORKER_SHARED_INSTRUCTIONS.md` before doing phase work, but also include the essential rules inline so a path issue cannot block startup.
- Tell the worker that server-managed sessions have runtime registration handled by `teamwork-mcp`.
- Tell the worker: "DO NOT USE ANY SKILL OR MCP EVER except the teamwork MCP, which is mandatory." Additional MCPs are allowed only when listed in `ALLOWED_AGENT_MCPS`; skills are allowed only when listed in `ALLOWED_SKILLS`; blank/none means no exceptions.
- Tell the worker to use `wait_for_messages` or `list_messages` through the `teamwork` tool for messages and reassignment.
- Tell the worker to choose exactly one assigned queue item, call `claim_work_item` with its exact `workItemId`, and focus only on that claimed item until it records a result or blocks it.
- Tell the worker to use the roster as its ownership map, call `list_agents` only if it loses roster context, and ask another worker directly only when that worker's specialty/responsibility clearly owns knowledge needed for the current slice.
- Tell the worker not to stop for ordinary ambiguity and to make reasonable decisions from the prompt, repo, and ownership boundary.
- Tell the worker to escalate only true hard blockers such as missing credentials, contradictory instructions, or environment failures it cannot unblock itself.
- Tell the worker to run only focused verification for its assigned slice, not the whole repo/app test suite. If it wrote or changed tests, it should run those specific tests and any directly related build/typecheck needed to validate its changes.
- Tell the worker to call `record_result` with commit SHA and summary before leaving its current claimed slice.
- Tell the worker that once its current slice is complete it must set its agent status to `idle`, keep the CLI session alive, and continue polling for specialist questions, reassignment, and pair coordination until the parent completes the session or explicitly replaces that worker.
- In `pair` mode, tell the worker its `PAIR_ROLE` explicitly.

`PAIR_ROLE` semantics:

- `implementer`: primary coder for the shared specialty slice
- `reviewer-tester`: reviews diffs, adds or extends tests, challenges risky assumptions, and validates the shared work before handoff

## Parent Workflow

Run this default flow:

`inspect -> decompose -> assign`

Then run the phase loop until no further phase is needed:

`execute phase -> integrate -> refresh`

Then finish:

`final sync -> cleanup -> finalize`

Detailed behavior:

1. Load `teamwork/.env`, then apply `SKILL_VARS` overrides.
2. Inspect the task and repo, then write `teamwork-task.md`.
3. Decide whether the task needs one phase or multiple phases. Use phases only when they reduce drift or unlock testing.
4. If the user gave an explicit worker count or explicit worker roster, launch that exact set unless impossible. Otherwise derive up to `max_workers` workers from the allowed provider pool.
5. Start or reuse the singleton HTTP `teamwork-mcp` server at `http://127.0.0.1:48741/mcp`.
6. Create one teamwork session with `teamwork({ tool_name: "create_session", options })`, including the session workspace path when available.
   `taskPrompt` is required. Include the original user request so the server debug log has the run context.
7. Register the parent and every worker with `register_agent`.
8. Create the workspace under `<output_dir>/<task-slug>/` and ensure `.teamwork/` is ignored before creating worktrees there.
9. Create worktrees according to the selected mode:
   - `solo`: create one isolated worktree per worker alias under `worktrees/<alias>/`
   - `pair`: create one shared worktree per specialty under `worktrees/<specialty>/` and point both paired workers at that path
10. Register each worker's worktree path with `register_worktree` so MCP can track it.
11. Write `roster.md` and the current phase file before launching workers.
12. Ensure the registered session, roster, phase, work items, and worktrees give the server enough context for each worker runtime packet:
    - `WORKSPACE_DIR`
    - `PROJECT_ROOT`
    - `sessionId`
    - `agentId`
    - private token
    - current phase goal
    - assigned queue
    - current claimed work item, when one already exists
    - full worker roster with specialties
    - assigned worker alias
    - assigned specialty
    - `PAIR_ROLE` when in `pair` mode
13. Before launching a phase, call `plan_launch` with the same worker selection/options you intend to pass to `launch_phase_workers`. Confirm the previewed CLI, model, reasoning effort, worktree, and work item mapping match the plan. If anything is wrong, fix the roster, worktrees, work items, or launch options before starting processes.
14. Ask the server to launch every planned worker for the phase concurrently with `launch_phase_workers`, or use `launch_worker` for an explicit replacement. This MUST be a server-managed CLI process/session launch, never a built-in subagent launch. In `pair` mode, pass each worker's `PAIR_ROLE` through `pairRoles` or `pairRole`. Use `reasoningEffort` for one batch-wide effort or `reasoningEffortOverrides`/`modelOverrides` for per-worker launch overrides.
15. After launch, the parent MUST monitor with `parent_poll` roughly every `poll_seconds` seconds until each active work item has a result, blocker, or reassignment decision. Do not wait indefinitely without polling MCP state. Do not create PowerShell, Python, curl, direct HTTP, or background shell monitors for `/mcp`.
16. Treat `parent_poll` as the default compact phase monitor. Use detail tools only when the poll shows a need: `get_worker_log` for one worker's unread/tail/full output, `list_worker_processes` for runtime details, `send_worker_input` for parent follow-up, `get_diagnostic_report` for runtime/closeout diagnostics, and `list_messages`/`list_results`/`list_work_items` for focused drill-down. Opt-in poll output previews are capped line previews and exclude prompt text by default.
17. If a parent session resumes after context compaction, interruption, or lost IDs/tokens, call `get_session_resume_packet` with the `sessionId` before issuing token-gated operations. Use the packet's parent token, active runtime IDs, aliases, work item IDs, and unread message state as the recovery source of truth.
18. If `parent_poll.readiness.hasUnreadParentMessages`, read/respond before continuing. If it reports stale/crashed workers or blockers, inspect logs and explicitly restart, reassign, replace, or pause the affected work. Avoid repeated worker nudges or status prompts unless `parent_poll` shows staleness, blocking, crash, drift, or a missing handoff.
19. When `parent_poll.readiness.allWorkItemsDone` is true, stop waiting and move to integration.
20. The server captures worker prompts, visible output, errors, final responses, runtime status, and logs; the parent can inspect them with `get_worker_log` and `list_worker_processes`.
21. Require workers to poll MCP roughly every `poll_seconds` seconds when possible.
22. Require workers to run only focused verification for their assigned slice and report real results. Workers must not run the full repo/app test suite unless the parent explicitly assigns that as the slice.
23. Optionally use `inspect_worktree` to check worker progress through MCP instead of manual git inspection.
24. At phase end, require each coding worker to leave a clean phase commit in its worktree branch, then call `record_result` with `resultType: "commit"`, `commitSha`, and `verificationSummary`. Review-only or validation-only workers use `resultType: "note"`. If a worker produced useful visible output but could not record a formal result, the parent may capture that output with `record_result` as a parent fallback using `resultType: "note"` and `data` as a string or JSON object that names the source log/runtime.
25. The parent calls `begin_integration`, reviews worker outputs, diffs, and verification results, then integrates worker commits into `main` by merge or cherry-pick without becoming a source-code fixer.
26. If integration needs source-file edits, merge-conflict resolution beyond trivial command-level integration, or any verification repair, the parent creates a repair work item and delegates that work to a worker or paired workers. The parent reviews the repair result but does not hand-code the source fix locally.
27. If another phase is needed, the parent refreshes worker worktrees from updated `main`, writes the next phase file, and repeats the phase loop:
    - `solo`: recreate each worker worktree at the same alias path on a fresh next-phase branch
    - `pair`: recreate each shared specialty worktree once, then re-point both paired workers at it
28. Reuse the same server-tracked child session IDs per alias after refresh when the CLI adapter supports resume.
29. If a worker escalates a true hard blocker mid-phase, the parent must explicitly choose one of these actions in the phase record before continuing that slice: reassign the work, replace the blocked worker, or pause the work item.
30. Do not terminate an idle worker just because its current slice is complete while other workers are still active. Session teardown happens only after the parent reaches final integration and cleanup.
31. After the last integration into `main`, do one final refresh pass so every worker worktree is recreated from the finished `main` and matches the final integrated state.
32. Verify that each refreshed worktree is up to date with the final `main`, then record the final sync state in `merge-log.md` and `teamwork-task.md`.
33. Pull `get_audit_report`, write a concise human-readable export to `audit-report.md`, and use the MCP report as the canonical source for session metrics and traffic history. Keep manual audit notes secondary: every final finding or worker outcome must state its evidence source as one of `formal MCP result`, `visible worker/runtime log`, or `parent fallback capture`. Use `get_diagnostic_report` for Copilot host-side diagnostics; when available it includes `session-state/events.jsonl` data instead of buffered VS Code debug logs.
34. Remove every teamwork worktree created for the session with `cleanup_worktree` so no worker worktree paths remain under `<output_dir>/<task-slug>/worktrees/`. Do not mark a worktree `removed` until filesystem deletion has actually succeeded.
35. Shut down worker runtimes only as part of final teardown. For server-managed workers, `complete_session` stops running managed runtimes before completing the session.
36. Stop only after the planned work, required verification, final sync, audit export, worker teardown, and worktree cleanup are complete.

## Worker Rules

Every worker must:

- stay inside its assigned worktree
- avoid global user scripts and scans outside `WORKSPACE_DIR`
- treat its specialty as the primary ownership boundary
- read the current phase file, assigned queue, current claim, and full roster before coding
- rely on the server for runtime registration when launched by `teamwork-mcp`
- confirm/list its registered worktree instead of registering worktrees itself
- poll MCP for broadcast messages, DMs, and reassignment with `wait_for_messages` or `list_messages`
- in `pair` mode, actively coordinate with the paired worker sharing the same specialty and worktree
- keep moving on reasonable assumptions instead of stopping for ordinary ambiguity
- use the roster as the ownership map, call `list_agents` if roster context is lost, and ask the relevant specialist directly only when their specialty/responsibility clearly owns knowledge needed for the current slice
- before detailed work, claim exactly one assigned queue item with `claim_work_item` and focus only on that claimed item
- run focused verification from the worktree and report actual results; do not run the full repo/app test suite unless the parent explicitly assigns full-suite validation
- for coding work, leave a clean commit and call `record_result` with `resultType: "commit"`, the phase commit SHA, and summary before leaving the current slice
- for review/validation-only work, call `record_result` with `resultType: "note"`
- enter `idle` standby after current-slice completion and keep the runtime alive or resumable so other workers can still ask specialist questions or request help
- end the phase with a clean commit the parent can integrate without terminating the worker runtime

Workers may:

- broadcast status or handoff messages
- DM another worker directly
- ask the parent for reassignment or escalation on true hard blockers such as missing credentials, contradictory instructions, or environment failures they cannot unblock themselves

Workers must not:

- edit the main workspace
- merge into `main`
- ignore another worker’s ownership boundary without coordination
- terminate the worker runtime just because the current assigned slice is complete while the session is still active
- stop and wait for clarification on routine implementation choices the prompt or repo context can answer
- call `register_worktree`
- create or commit CLI session artifacts such as `copilot-session-*.md`

## MCP Usage

Use the single `teamwork` MCP tool as shared session state. Call it as `teamwork({ tool_name, options })`; use `tool_name: "help"` for the operation catalog and exact option fields. Do not guess or use legacy field names.

High-use operation schema reminders:

- `upsert_work_item`: use `assigneeAgentIds: [workerAgentUuid]`, not `assignedTo`; `acceptanceCriteria` is a single string.
- `launch_worker`: requires `worktreeId` from `register_worktree` and `phaseNumber`; pass `workItemIds` as UUIDs when assigning a slice.
- `plan_launch`: dry-run preview before `launch_phase_workers`; verify CLI, model, reasoning effort, worktree, and work item mapping before starting workers.
- `launch_phase_workers`: accepts batch `reasoningEffort` plus `reasoningEffortOverrides`, `modelOverrides`, and `workItemIdsByAgentId` for per-worker launch control.
- `get_session_resume_packet`: recovery helper after compaction/resume; returns the parent token, active runtimes, aliases, work item IDs, and unread state for the session.
- `claim_work_item`: workers must pass the exact `workItemId` they are claiming. There is no implicit "next" claim behavior.
- `record_result`: `resultType` is `commit|artifact|test-report|note`; `data` may be a string or JSON object; use `commitSha`, `commitShas`, and `verificationSummary` for structured commit handoffs. Parent fallback result capture must use `resultType: "note"`.
- `update_work_item_status`: status is `planned|assigned|in-progress|blocked|done|canceled`; use `done`, not `complete`; workers must use `claim_work_item` instead of setting `in-progress` directly.
- `register_agent`: include parent-defined `specialty` and `responsibility`; `responsibility` should be one or two sentences explaining what this agent owns.
- `list_agents`: returns the current roster with agent IDs, aliases, specialties, responsibilities, CLI/model, role, and status.
- `send_message`: `target` is `broadcast|agent`; `kind` is `status|question|answer|handoff|system`.
- `register_worktree`: status is `creating|ready|dirty|merged|failed|removed|cleanup-needed`; use `ready`, not `active`.
- `get_closeout_checklist`: use before `complete_phase` and `complete_session`; it orders record integration event, obligation resolution, boundary acks, runtime stop, worktree cleanup, and completion.
- `closeout_ack_workers`: parent-only helper to advance boundary acks for idle/done/inactive or resumable-exited workers without using private worker tokens.
- `cleanup_worktree`: removes a tracked worktree and marks it `removed` only after filesystem deletion succeeds.

Use `teamwork-mcp` for:

- session registration
- current phase state
- worker roster visibility
- worker responsibility visibility through `list_agents`
- work item assignment and status
- broadcast and DM messaging, including required-response obligations
- agent status and acknowledgement cursors
- lifecycle transitions (`begin_integration`, `complete_phase`, `begin_finalizing`, `complete_session`)
- parent phase monitoring through compact `parent_poll`
- launch preflight through `plan_launch`
- parent resume/context recovery through `get_session_resume_packet`
- worktree path and branch registration (`register_worktree`, `list_worktrees`)
- git worktree inspection without leaving MCP (`inspect_worktree`)
- worker result reporting at phase end (`record_result`, `list_results`)
- closeout gates and cleanup (`get_closeout_checklist`, `closeout_ack_workers`, `cleanup_worktree`)
- server-managed worker launch, direct input, logs, restart/stop (`launch_worker`, `launch_phase_workers`, `send_worker_input`, `get_worker_log`, `restart_worker`, `stop_worker`)
- session audit reporting (`get_audit_report`)
- debug review after the run (`list_debug_events`)
- parent-visible phase checkpoints after integration (`create_checkpoint`, `list_checkpoints`)

The worktree, result, and checkpoint helpers are operational conveniences. They make the existing parent-led workflow smoother by giving MCP-level visibility into state that was previously only in filesystem artifacts. They do not replace the canonical artifact files (`teamwork-task.md`, `roster.md`, `merge-log.md`, phase files) or change who owns integration.

Session teardown is part of the workflow. A teamwork run is not complete until the parent has refreshed each worker worktree to the final integrated `main`, recorded that synced state, shut down the worker runtimes, and removed every teamwork worktree created for the session.

Use filesystem artifacts for the canonical task plan and phase records. Do not recreate the `roundtable-v2` draft, checkpoint, or issue model here.

For later skill refinement, use `list_debug_events` or `/api/debug-events` to review redacted MCP tool calls, user prompt context passed to `create_session`, agent-visible messages, phase changes, worker process logs, result summaries, and errors. Hidden model chain-of-thought is not available to the server; agents should record useful rationale in MCP messages, status notes, phase summaries, and result summaries.
