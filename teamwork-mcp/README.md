# Teamwork MCP

`teamwork-mcp` is a lightweight coordination server for the `teamwork` skill.

It is intentionally smaller than `roundtable-v2-mcp`. It stores:

- teamwork sessions
- parent and worker agents
- dynamic phase state
- work items
- broadcast and DM messages
- acknowledgement cursors
- agent worktree metadata and runtime packets
- worker result reports
- audit rollups derived from messages, runtimes, work items, and status history
- parent-visible phase checkpoints
- enforced lifecycle gates, required-message obligations, heartbeats, and cleanup janitor
- server-managed CLI worker launch, input delivery, runtime logs, restart/stop, and teardown
- detailed debug events for MCP tool calls, visible messages, prompts passed to session creation, phase changes, and results

## Env

- `TEAMWORK_DATA_DIR`
- `TEAMWORK_DB_PATH`
- `TEAMWORK_UI_HOST`
- `TEAMWORK_UI_PORT`
- `TEAMWORK_TRANSPORT`
- `TEAMWORK_SESSION_TTL_HOURS`
- `TEAMWORK_WORKTREE_GC`
- `TEAMWORK_JANITOR_INTERVAL_MS`
- `TEAMWORK_FAKE_CLI_PATH` for tests/development only
- `TEAMWORK_OPEN_BROWSER` — `1` to auto-open the dashboard in the default browser on startup, `0` to suppress. Defaults to on for `http` transport and off for `stdio` (so each MCP client attach doesn't pop a tab).
- `TEAMWORK_DASHBOARD_DIST` — override the static UI directory served at `/`. Defaults to `dashboard-ui/dist/`. If the directory is missing the server falls back to a "UI not built" stub HTML.
- optional adapter binary overrides: `TEAMWORK_CODEX_BIN`, `TEAMWORK_COPILOT_BIN`, `TEAMWORK_CLAUDE_BIN`, `TEAMWORK_GEMINI_BIN`, `TEAMWORK_OPENCODE_BIN`

The dashboard SPA is served at `/`. Run `npm run dashboard:build` once after cloning to build the UI bundle. New JSON endpoints live under `/api/v2/*` and dashboard SSE streams at `/api/v2/sessions/stream` and `/api/v2/sessions/:id/stream`. The legacy `/api/sessions` and `/api/sessions/:id/audit` endpoints are preserved for backwards compatibility.

Defaults:

- transport: `http`
- MCP endpoint: `http://127.0.0.1:48741/mcp`
- data dir: `~/.teamwork`
- db path: `~/.teamwork/teamwork.sqlite`
- dashboard port: `48741`
- session TTL: `24` hours

## Host Setup

Configure AI hosts to run the bootstrap command:

```bash
npm run mcp:bootstrap
```

The bootstrap speaks stdio to the host, checks the singleton HTTP server at `TEAMWORK_MCP_URL` or `http://127.0.0.1:48741/mcp`, starts it if needed, then forwards MCP traffic to that shared server. This keeps one SQLite DB, one dashboard, and one worker supervisor across multiple parents.

## Tool API

The server advertises one MCP tool:

```ts
teamwork({ tool_name: string, options: object })
```

Use `tool_name: "help"` for the operation catalog and `tool_name: "help", options: { topic: "<operation>" }` for required/optional fields.

Operation groups:

- session lifecycle: `create_session`, `get_session_state`, `complete_session`, `abandon_session`, `archive_session`
- phase management: `start_phase`, `begin_integration`, `complete_phase`, `begin_finalizing`
- parent monitoring: `parent_poll` (compact counts and previews by default; no worker log text unless explicitly requested)
- work items: `upsert_work_item`, `update_work_item_status`, `reassign_work_item`, `list_work_items`
- messaging: `send_message`, `list_messages`, `wait_for_messages`, `ack_messages`, `resolve_obligation`
- worktrees: `register_worktree`, `update_worktree`, `list_worktrees`, `inspect_worktree`
- server-managed workers: `plan_launch`, `launch_worker`, `launch_phase_workers`, `send_worker_input`, `restart_worker`, `stop_worker`, `get_worker_log`, `list_worker_processes`
- runtime state: `register_runtime`, `update_runtime`, `heartbeat_runtime`, `list_runtimes`
- results/audit/debug: `record_result`, `list_results`, `get_audit_report`, `get_diagnostic_report`, `list_debug_events`, `run_janitor`

Workers may use `idle` to mean "current slice complete, still alive, still polling." `done` should be reserved for true end-of-run completion or explicit parent-directed teardown, not ordinary mid-session standby.

Server-managed runtimes stay running for the session. `complete_session` stops managed workers during final teardown after phase work, final sync, and worktree cleanup have been recorded.

`oneshot` launch mode is reserved for optional helper runs; normal teamwork roster agents should use resumable or persistent sessions.

Use `parent_poll` for frequent monitoring. Use `get_worker_log` when the poll shows a stale, crashed, or otherwise suspicious worker and you need unread, tail, or full-history output for one runtime. Opt-in poll output previews are capped line previews and exclude prompt text by default.

Server-managed workers record adapter capabilities with each runtime. Non-writable adapters such as Copilot are normalized to resume-command mode, session/export identifiers are captured from stdout and stderr, and `send_worker_input` uses stdin or resume delivery according to the recorded capability. Copilot launches also enable the CLI's file OpenTelemetry exporter with prompt/response content capture disabled; per-runtime files are stored under the session workspace and `get_audit_report` rolls them up into per-session AI Credits, USD cost, and token totals. `get_diagnostic_report` summarizes runtime input state, fallback handoff candidates, tool errors, usage rollups, and closeout blockers.

Use `plan_launch` before `launch_phase_workers` to preview each selected worker's CLI, model, reasoning effort, launch mode, worktree, and phase work items without starting processes. `launch_phase_workers` accepts batch `reasoningEffort` plus per-worker `reasoningEffortOverrides`, `modelOverrides`, and `workItemIdsByAgentId`.

Use `get_session_resume_packet` after parent context compaction or interruption to recover the parent token, current roster aliases, active runtimes, work item IDs, and unread parent message state.

The parent workflow using `teamwork-mcp` should also treat final worktree sync and teardown as required session-closing steps: after the last merge, refresh each worker worktree from the final integrated `main`, record that synced state, shut down the worker runtimes, remove all teamwork worktrees, then complete the session.

## Dashboard

The local dashboard is read-only and defaults to active/recent sessions. Query params can include `?project=<path>`, `?since=<iso>`, and `?include=completed,archived`. It shows lifecycle stage, last activity, workers, work items, recent coordination messages, worktree status, result summaries, and compact audit metrics.

Debug events are available through `list_debug_events` or `GET /api/debug-events?sessionId=<id>&limit=200`. Tool-call logs redact token-like fields. The server logs prompts supplied through `create_session.taskPrompt`, MCP messages, phase/result/status tool payloads, worker process logs, and tool errors/results; it cannot log hidden model chain-of-thought, so agents should put useful rationale in MCP messages, status notes, phase summaries, and result summaries.
