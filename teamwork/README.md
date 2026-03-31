# Teamwork

`teamwork` is a parent-led multi-agent build skill for tasks that should be split across specialized workers instead of having every agent solve the full task independently.

It pairs with `teamwork-mcp` for lightweight realtime coordination:

- one parent orchestrator
- up to four specialized workers
- one worktree per worker per phase
- parent-owned phase-end integration into `main`
- worker-to-worker broadcast and DM messaging through MCP
- worktree registration and git inspection through MCP
- worker result reporting at phase end
- parent-visible phase checkpoints after integration

## Defaults

The skill supports optional env defaults in the skill folder:

- `TEAMWORK_WORKER_POOL`
- `TEAMWORK_MAX_WORKERS`
- `TEAMWORK_OUTPUT_DIR`
- `TEAMWORK_POLL_SECONDS`

Prompt-provided values should override env defaults.

## MCP

This skill expects the `teamwork-mcp` server to be installed and available to the agent using the skill.

The MCP server provides session, phase, work-item, and messaging tools for coordination. It also provides operational helpers for worktree tracking, worker result reporting, and phase checkpoints. These helpers give MCP-level visibility into state that the parent and workers previously managed only through filesystem artifacts — they do not change who orchestrates or integrates.
