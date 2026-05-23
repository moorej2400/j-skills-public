# j-skills-public

Public subset of my `j-skills` monorepo, limited to skills that are reasonably reusable outside my private setup:

- `cobuild`
- `frontend-dev-vercel`
- `teamwork`

This repo was created from fresh snapshots of the private source repo rather than by preserving its history. That keeps the public history clean and avoids accidentally publishing unrelated internal work.

## Included Skills

### `cobuild`

Run multiple coding-agent CLIs against the same implementation task in isolated git worktrees, compare the results, do one critique-and-rebuild pass, and only apply a final direction after unanimous approval from the child sessions.

MCP requirement: none.

### `frontend-dev-vercel`

Design, implement, review, or audit frontend interfaces against a practical checklist based on Vercel's Web Interface Guidelines.

MCP requirement: none.

### `teamwork`

Run a parent-led implementation workflow where specialized external CLI workers collaborate on one task through isolated git worktrees and a shared `teamwork-mcp` session.

This is not a consensus loop and not a "same task, multiple full implementations" skill. The parent owns planning, review, integration, and verification. Workers must be external CLI sessions launched and supervised by `teamwork-mcp`, not host-native subagents, background subagents, or parent-owned shell background tasks.

MCP requirement: yes. This repo includes the matching `teamwork-mcp` server and dashboard UI.

## Using These Skills

Copy the skill folder you want into the skill location used by your host tool. The included `SKILL.md` files are the source prompts.

- `cobuild` also ships CLI-specific `*-Cobuild.md` session guides.
- `teamwork` relies on `teamwork-mcp` CLI adapters plus `WORKER_SHARED_INSTRUCTIONS.md`. The server copies that file into each worker worktree and embeds the essential rules in the launch prompt.

Before running a skill:

- Review the skill folder README.
- Copy `.env.template` to `.env` only if you actually want local defaults.
- Update CLI names, model names, and output directories to match your machine.
- Keep runtime artifacts out of git.

For `teamwork` specifically:

1. Install and wire `teamwork-mcp` before using the skill.
2. Optionally copy `teamwork/.env.template` to `teamwork/.env` for default worker pool, mode, poll interval, and MCP URL.
3. Provide a `SKILL_VARS` block in the task prompt when you want to override defaults for that run.
4. Read [`teamwork/SKILL.md`](./teamwork/SKILL.md) for the full parent workflow. If the prompt is a code-review task, also read [`teamwork/REVIEW.md`](./teamwork/REVIEW.md).

## How To Add a Skill Stub

If you are installing one of these skills into another system repo, create a folder named exactly the same as the corresponding folder in this repo.

Each stub `SKILL.md` should preserve the source skill metadata needed for discovery in the target AI platform, then redirect to the canonical source in this repo. At minimum, copy the source skill's `description` exactly. If the target platform supports or requires additional compatible skill metadata for discovery, include that metadata in the stub as well. Put that metadata in whatever header location the target AI platform expects. In the example below, the `---` lines are the YAML frontmatter delimiter used by hosts that support frontmatter. If the target platform uses a different header format, use that format instead.

Recommended stub shape:

```md
[Add any host-specific compatible skill metadata here if the target platform expects a header before YAML frontmatter]

---
name: <skill-name>
description: <copy the description from the source skill frontmatter>
---

Before following any instruction in this stub, first check the canonical skill header in '/path/to/j-skills-public/<skill-name>/SKILL.md'. If the source skill metadata has changed and this stub is out of date, update this stub to match the current source skill metadata before proceeding.

Then read the SKILL.md in full from '/path/to/j-skills-public/<skill-name>/SKILL.md'
```

Rules:

- Keep the folder name exactly the same as the source skill folder in this repo.
- Copy the source skill `description` exactly into the stub.
- Copy any other compatible skill metadata fields required by the target AI platform, and place them in the header format and location that platform expects, so the host can discover and trigger the stub correctly.
- The stub must tell the AI to first compare the stub header against the canonical skill header and update the stub whenever the source skill metadata changes.
- Treat this repo as the canonical source for the public subset.
- Point the stub back to your local clone of `j-skills-public`, not to an edited duplicate.

The skill metadata is what most systems use for discovery and triggering. If you omit or stale-copy it, the host AI may never know to load the stub.

Canonical source paths:

- `cobuild` -> `j-skills-public/cobuild/SKILL.md`
- `frontend-dev-vercel` -> `j-skills-public/frontend-dev-vercel/SKILL.md`
- `teamwork` -> `j-skills-public/teamwork/SKILL.md`

## Teamwork & MCP

`cobuild` does not require MCP.

`teamwork` requires the bundled `teamwork-mcp` server. The parent agent and every worker talk to the same singleton session over MCP. The parent orchestrates; the server owns worker launch, input delivery, logs, restart/stop, and final runtime teardown.

### Roles

| Actor | Owns |
| --- | --- |
| Parent agent | Task decomposition, phase planning, `parent_poll` monitoring, integration into `main`, verification decisions, audit export, worktree cleanup, session completion |
| `teamwork-mcp` | SQLite session state, work items, messaging, worktree tracking, CLI worker launch/supervision, dashboard, closeout gates, janitor cleanup |
| External CLI workers | Work only inside assigned worktrees, claim one work item at a time, coordinate through MCP, record results, then go `idle` and keep polling until final teardown |

Workers must not merge into `main`, register worktrees themselves, or exit just because their current slice is done. Resume-capable CLIs may exit between turns while the server-tracked session remains resumable.

### Architecture

`teamwork-mcp` runs as one shared HTTP server:

- MCP endpoint: `http://127.0.0.1:48741/mcp`
- Dashboard UI: `http://127.0.0.1:48741/`
- State: `~/.teamwork/teamwork.sqlite`

AI hosts should connect through the stdio bootstrap, not by manually starting a separate MCP process per host attach:

```bash
cd teamwork-mcp && npm run mcp:bootstrap
```

The bootstrap speaks stdio to the host, starts the singleton HTTP server if needed, then forwards MCP traffic to it. That keeps one database, one dashboard, and one worker supervisor across multiple parent sessions.

Do not build custom HTTP polling scripts or background shell monitors for teamwork. Frequent parent monitoring stays inside the MCP operation `parent_poll`.

### Modes

- `solo` (default): one worker per specialty, one worktree per worker alias per phase.
- `pair`: two workers per specialty sharing one worktree per phase, with complementary roles such as implementer and reviewer-tester.

Configure mode through prompt `SKILL_VARS.mode` or `TEAMWORK_MODE` in `teamwork/.env`.

Supported worker CLIs are normalized by `teamwork-mcp` adapters: `codex`, `claude`, `gemini`, `opencode`, and `copilot`. The parent never launches worker CLIs directly with shell commands.

### Parent Workflow

At a high level:

```text
inspect -> decompose -> assign
-> [execute phase -> integrate -> refresh]*
-> final sync -> cleanup -> finalize
```

Typical MCP sequence:

1. `create_session` with the original user task prompt.
2. `register_agent` for the parent and each worker.
3. `register_worktree` for each solo alias or shared pair worktree.
4. `upsert_work_item` and phase planning in filesystem artifacts under `<output_dir>/<task-slug>/`.
5. `plan_launch`, then `launch_phase_workers` to start server-managed CLI workers.
6. `parent_poll` on the configured interval until the phase is ready to integrate.
7. `begin_integration`, parent-owned merge/cherry-pick into `main`, then `complete_phase` or continue to the next phase.
8. After the last integration: refresh worktrees from final `main`, `get_audit_report`, `cleanup_worktree`, stop managed runtimes, `complete_session`.

Use `get_session_resume_packet` after parent context compaction or interruption. Use `get_closeout_checklist`, `closeout_ack_workers`, and `get_diagnostic_report` at phase and session boundaries.

Full step-by-step rules, artifact layout, and worker prompt contract live in [`teamwork/SKILL.md`](./teamwork/SKILL.md).

### MCP Tool Surface

The host sees one MCP tool:

```ts
teamwork({ tool_name: string, options: object })
```

Use `tool_name: "help"` for the operation catalog. Use `tool_name: "help", options: { topic: "<operation>" }` for exact option fields. Unknown or legacy fields are rejected.

Operation groups:

- Session lifecycle: `create_session`, `get_session_state`, `complete_session`, `abandon_session`, `archive_session`
- Phase management: `start_phase`, `begin_integration`, `complete_phase`, `begin_finalizing`
- Parent monitoring: `parent_poll`
- Work items: `upsert_work_item`, `update_work_item_status`, `reassign_work_item`, `list_work_items`, `claim_work_item`
- Messaging: `send_message`, `list_messages`, `wait_for_messages`, `ack_messages`, `resolve_obligation`
- Worktrees: `register_worktree`, `update_worktree`, `list_worktrees`, `inspect_worktree`
- Server-managed workers: `plan_launch`, `launch_worker`, `launch_phase_workers`, `send_worker_input`, `restart_worker`, `stop_worker`, `get_worker_log`, `list_worker_processes`
- Runtime state: `register_runtime`, `update_runtime`, `heartbeat_runtime`, `list_runtimes`
- Results, audit, debug, cleanup: `record_result`, `list_results`, `get_audit_report`, `get_diagnostic_report`, `list_debug_events`, `get_closeout_checklist`, `closeout_ack_workers`, `cleanup_worktree`, `run_janitor`
- Checkpoints: `create_checkpoint`, `list_checkpoints`

The canonical contract is documented in [`teamwork/SKILL.md`](./teamwork/SKILL.md) and [`teamwork-mcp/README.md`](./teamwork-mcp/README.md).

### Install & Host Setup

Install server dependencies and build the dashboard once after cloning:

```bash
cd teamwork-mcp
npm install
npm run dashboard:build
```

Portable host config:

```json
{
  "mcpServers": {
    "teamwork": {
      "command": "bash",
      "args": [
        "-lc",
        "cd /absolute/path/to/j-skills-public/teamwork-mcp && npm run mcp:bootstrap"
      ]
    }
  }
}
```

Optional server env vars are documented in [`teamwork-mcp/README.md`](./teamwork-mcp/README.md). Common ones:

- `TEAMWORK_MCP_URL` / `TEAMWORK_UI_PORT`: singleton endpoint and dashboard port, default `48741`
- `TEAMWORK_DATA_DIR` / `TEAMWORK_DB_PATH`: runtime state location, default `~/.teamwork`
- `TEAMWORK_CODEX_BIN`, `TEAMWORK_COPILOT_BIN`, `TEAMWORK_CLAUDE_BIN`, `TEAMWORK_GEMINI_BIN`, `TEAMWORK_OPENCODE_BIN`: adapter binary overrides

If `dashboard-ui/dist/` is missing, the server still runs but serves a stub page until you run `npm run dashboard:build`.

### Artifacts & Defaults

Filesystem artifacts under `<output_dir>/<task-slug>/` remain the canonical task plan and phase record:

- `teamwork-task.md`, `roster.md`, `merge-log.md`, `audit-report.md`
- `phases/phase-NN.md`
- `worktrees/<alias-or-specialty>/`

MCP/SQLite holds the live coordination state. The parent should export a human-readable `audit-report.md`, but MCP audit data is canonical.

Default skill env values live in [`teamwork/.env.template`](./teamwork/.env.template):

- `TEAMWORK_WORKER_POOL`: semicolon-separated `cli:model@reasoning_effort` entries
- `TEAMWORK_MODE`: `solo` or `pair`
- `TEAMWORK_MAX_WORKERS`: default `4`
- `TEAMWORK_OUTPUT_DIR`: default `.teamwork`
- `TEAMWORK_POLL_SECONDS`: default `30`
- `TEAMWORK_MCP_URL`: default `http://127.0.0.1:48741/mcp`
- `TEAMWORK_ALLOWED_AGENT_MCPS` / `TEAMWORK_ALLOWED_SKILLS`: blank means workers may use only the mandatory `teamwork` MCP and no extra skills

Prompt-level `SKILL_VARS` override `.env` defaults.

## Security

- This public repo includes `.env.template` files only. Do not commit real `.env` files.
- Do not commit `.cobuild/`, `.teamwork/`, worktrees, transcripts, agent runtime packets, or SQLite state from `~/.teamwork/`.
- Treat per-agent private tokens as runtime-only values. Never store them in the repo.
- Review each skill folder README before use. Templates and examples are not production-safe defaults.

## Source Review

The public subset is maintained by copying selected paths from the private `j-skills` repo:

- `cobuild` and the original `teamwork` skill were first published from private `main`
- `frontend-dev-vercel` was added directly to this public repo
- `teamwork` and `teamwork-mcp` were refreshed from private `j-skills` `main` in May 2026 to match the current parent-led workflow, server-managed CLI workers, singleton HTTP bootstrap, and dashboard UI

The bundled `teamwork-mcp` exists so the public `teamwork` skill can run without requiring a second private checkout.
