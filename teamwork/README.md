# Teamwork

`teamwork` is a parent-led multi-agent build skill for tasks that should be split across specialized workers instead of having every agent solve the full task independently.

It pairs with `teamwork-mcp` for lightweight realtime coordination:

- one parent orchestrator
- external CLI worker sessions launched and supervised by `teamwork-mcp`
- `solo` mode: one worktree per worker per phase, capped by `TEAMWORK_MAX_WORKERS` for parent-derived worker counts
- `pair` mode: two worker sessions per paired specialty with one shared worktree per pair per phase, capped by `TEAMWORK_MAX_WORKERS` for parent-derived worker counts
- parent-owned phase-end integration into `main`, with any source-edit repair delegated back out to workers
- worker-to-worker broadcast and DM messaging through MCP
- parent phase monitoring through compact `parent_poll`
- parent closeout helpers for boundary acks and worktree cleanup
- required-response message obligations at phase/final boundaries
- idle workers that stay alive and keep polling until final session teardown
- worktree registration and git inspection through MCP
- launch preflight through `plan_launch`
- parent resume/context recovery through `get_session_resume_packet`
- server-managed worker launch, input delivery, logs, restart/stop, and runtime tracking
- worker result reporting at phase end
- session audit reporting and final audit export
- parent-visible phase checkpoints after integration

## Defaults

The skill supports optional env defaults in the skill folder:

- `TEAMWORK_WORKER_POOL`
- `TEAMWORK_MODE`
- `TEAMWORK_MAX_WORKERS`
- `TEAMWORK_OUTPUT_DIR`
- `TEAMWORK_POLL_SECONDS`
- `TEAMWORK_MCP_URL`
- `TEAMWORK_ALLOWED_AGENT_MCPS`
- `TEAMWORK_ALLOWED_SKILLS`
- `TEAMWORK_SESSION_TTL_HOURS`
- `TEAMWORK_WORKTREE_GC`

`TEAMWORK_WORKER_POOL` supports repeated weighted entries and an optional `@reasoning_effort` suffix per entry, for example `copilot:claude-sonnet-4.6@high`.

`TEAMWORK_MODE` supports `solo` and `pair`, and defaults to `solo`.

`TEAMWORK_MAX_WORKERS` defaults to `4`.

`TEAMWORK_ALLOWED_AGENT_MCPS` and `TEAMWORK_ALLOWED_SKILLS` default to blank. Blank means worker agents must use no MCPs or skills except the mandatory `teamwork` MCP. Set comma-separated names only for MCP servers or skills worker agents may use in addition to `teamwork`.

Prompt-provided values should override env defaults.

## MCP

This skill expects the `teamwork-mcp` server to be installed and available to the agent using the skill.

The MCP server should run once over HTTP at `http://127.0.0.1:48741/mcp` with state in `~/.teamwork/teamwork.sqlite`. It exposes one MCP tool, `teamwork({ tool_name, options })`, with `tool_name: "help"` for operation docs. It provides session, phase, work-item, messaging, server-managed worker runtime, audit, dashboard, and cleanup operations. These helpers enforce the existing parent-led flow without changing who orchestrates or integrates. A worker finishing its current slice should become idle and keep polling until final teardown; resume-command CLIs may exit between turns while their server-tracked CLI session remains resumable. The parent should export a final human-readable `audit-report.md`, but the canonical metrics stay in MCP/SQLite. Manual audit files are secondary; final findings must label whether evidence came from formal MCP results, visible worker/runtime logs, or parent fallback capture.

For MCP host configuration, point the host at `teamwork-mcp`'s `npm run mcp:bootstrap` command. The bootstrap starts the singleton server if needed, otherwise it connects to the existing one.

Treat `parent_poll` as the default compact monitor. Use detail tools only when the poll shows a need: `get_worker_log` for one worker's unread/tail/full output, `list_worker_processes` for runtime details, `send_worker_input` for parent follow-up, and `list_messages`/`list_results`/`list_work_items` for focused drill-down. Avoid repeated worker nudges unless polling shows staleness, blocking, crash, drift, or a missing handoff. Opt-in poll output previews are capped line previews and exclude prompt text by default.

Call `plan_launch` before `launch_phase_workers` to verify CLI/model/reasoning/worktree/work-item mapping. Use `get_session_resume_packet` after compaction or interruption to recover parent token, runtime IDs, aliases, work item IDs, and unread state.

Use `get_closeout_checklist` before `complete_phase` or `complete_session`; use `closeout_ack_workers` for idle/resumable worker boundary acks and `cleanup_worktree` so worktrees are marked removed only after filesystem deletion succeeds. Use `get_diagnostic_report` when runtime behavior or closeout state is unclear. It reports worker runtime input capability, captured resume/session export metadata, Copilot `session-state/events.jsonl` diagnostics when available, fallback handoff candidates from stdout/stderr, tool errors, and exact closeout blockers.
