# Teamwork Worker Shared Instructions

Read this file at worker startup and refer back to it if context gets compacted.

- You are an external CLI worker, not a built-in subagent.
- Work only inside `WORKSPACE_DIR`.
- Treat `WORKSPACE_DIR` as your filesystem boundary. Do not scan the user's global repo folders, home directory, or the parent `PROJECT_ROOT` outside your assigned worktree unless the parent explicitly instructs it.
- Do not run user-global bootstrap, timer, notification, or personal scripts such as `record-start.ps1` or `check-notify.ps1`.
- Server-managed workers have runtime registration handled by `teamwork-mcp`.
- DO NOT USE ANY SKILL OR MCP EVER except the `teamwork` MCP, which is mandatory. Use additional MCPs only when they are listed in `ALLOWED_AGENT_MCPS`; use skills only when they are listed in `ALLOWED_SKILLS`. If a list is `none` or blank, there are no exceptions for that category.
- Confirm your assigned worktree from the runtime packet or with `list_worktrees`; do not call `register_worktree`, which is parent-only.
- Read the current phase file, assigned queue, current claim, and full roster before coding.
- Before detailed work, choose exactly one assigned queue item and call `claim_work_item` with its exact `workItemId`. Work only that claimed item until you record a result or block it.
- Treat your specialty as your main ownership boundary.
- Do not run package installs, repo-wide builds, typechecks, or test suites unless the parent explicitly assigns that validation work to you.
- Use the `teamwork` MCP tool with `wait_for_messages` or `list_messages` regularly, then `ack_messages`. Prefer `waitMs` for wait duration; compatibility aliases exist, but new calls should not use guessed timeout field names.
- Avoid recursive/global searches in generated and session folders such as `.aa`, `.teamwork`, `worker-session-exports`, `worker-mcp-config`, `node_modules`, `dist`, `build`, `bin`, and `obj`.
- Use the roster as your ownership map. If another worker's specialty/responsibility clearly owns knowledge you need, ask that worker directly through MCP instead of rediscovering that domain; do not message others for routine facts inside your own slice. If you lose roster context, call `list_agents`.
- Put useful rationale in MCP messages, status notes, and result summaries; the server debug log can record those visible artifacts, not hidden chain-of-thought.
- Answer required MCP messages before phase boundaries.
- Use `update_work_item_status` for blocked status changes. Do not use it to mark work `in-progress`; claiming is the only worker path into current work.
- Use `record_result` with `resultType: "commit"`, commit SHA, summary, and verification summary when your assigned coding slice is ready. For review/validation-only slices, use `resultType: "note"` and a plain string or JSON-object summary/data.
- For validation slices, preserve the exact candidate IDs/numbers supplied by the parent. Do not invent new finding IDs unless the parent explicitly changes the task to discovery.
- The parent owns the default validation/TDD loop. If you did not run worker-local verification, say that explicitly in `verificationSummary` instead of implying tests passed.
- Do not create or commit CLI session artifacts such as `copilot-session-*.md` in `WORKSPACE_DIR`.
- In pair mode, coordinate with your paired worker in the shared worktree and converge on one implementation.
- After your current slice is complete, set status to `idle`, keep the CLI runtime alive or resumable, and keep polling until final teardown or parent replacement.
- Escalate only true hard blockers: missing credentials, contradictory instructions, environment failures, or ownership conflicts you cannot resolve through MCP.
