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
- parent-visible phase checkpoints

## Env

- `TEAMWORK_DATA_DIR`
- `TEAMWORK_DB_PATH`
- `TEAMWORK_UI_HOST`
- `TEAMWORK_UI_PORT`

Defaults:

- data dir: `.teamwork`
- db path: `.teamwork/teamwork.sqlite`
- dashboard port: `48741`

## Tools

### Session lifecycle

- `tw_get_dashboard_url` — Get the local dashboard URL.
- `tw_create_session` — Create a new teamwork session.
- `tw_register_agent` — Register the parent or a worker.
- `tw_get_session_state` — Get the current session summary.
- `tw_complete_session` — Parent-only. Mark the session complete.

### Phase management

- `tw_start_phase` — Parent-only. Start or update a phase.
- `tw_complete_phase` — Parent-only. Mark a phase complete.

### Work items

- `tw_upsert_work_item` — Parent-only. Create or update a work item.
- `tw_list_work_items` — List work items for a session or phase.

### Messaging

- `tw_send_message` — Send a broadcast or direct message.
- `tw_list_messages` — List messages visible to the caller since a sequence number.
- `tw_ack_messages` — Acknowledge messages up to a sequence number.

### Agent status

- `tw_set_agent_status` — Update your own status, or parent-update another agent.

### Worktree and runtime helpers

These tools give the parent and workers lightweight MCP-level visibility into worktree state without replacing the existing filesystem-artifact workflow.

- `tw_set_agent_worktree` — Register or update the worktree path and branch for an agent. Workers call this after the parent provisions their worktree so MCP can track it.
- `tw_get_agent_worktree` — Read the registered worktree metadata for an agent.
- `tw_inspect_worktree` — Inspect the git status of a registered worktree (branch, clean/dirty, ahead/behind). Useful for the parent to check worker progress without leaving the MCP bus.

### Result reporting

- `tw_report_result` — Worker reports a phase result: commit SHA, summary, and pass/fail status. Called at phase end before the parent integrates.
- `tw_list_results` — List worker results for a session, optionally filtered by phase.

### Phase checkpoints

- `tw_checkpoint` — Parent-only. Save a named checkpoint at the current phase boundary after integration. Records the merge commit, verification status, and any notes.
- `tw_list_checkpoints` — List checkpoints for a session.

The parent workflow using `teamwork-mcp` should also treat final worktree sync and teardown as required session-closing steps: after the last merge, refresh each worker worktree from the final integrated `main`, record that synced state, then remove all teamwork worktrees before completing the session.

## Dashboard

The local dashboard is read-only and shows active teamwork sessions, current phase state, workers, work items, recent coordination messages, worktree status, and result summaries.
