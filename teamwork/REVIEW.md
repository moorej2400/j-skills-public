# Review Instructions

Use this file only for code-review prompts.

## Parent Instructions

- Treat the run as a review task, not an implementation task.
- Give workers the authoritative scope: assigned worktree snapshot, requirements summary, and changed-file list when available.
- Tell workers to review the assigned snapshot only. Do not let them drift into remote branches, old commits, merge-base archaeology, or unrelated repo history unless that is explicitly requested.
- Do not review from a fixed checklist. Review everything.
- When the change touches a special domain, additionally review that domain's behavior and risks.
- When the change includes migrations, explicitly review migration safety and behavior, including idempotency, reversibility, destructive changes, supporting indexes, seed-data safety, and any other schema or data risks introduced by the change.
- When the change includes internationalization work, explicitly review localization behavior, including hardcoded user-facing strings, locale-file completeness, pluralization, locale-aware formatting, and any other translation or rendering issues introduced by the change.
- Treat those prompts as minimum coverage reminders, not the boundary of the review.
- Ask workers for concrete findings with file and line evidence plus impact. Ask them to say so explicitly when a reviewed surface matches scope.

## Worker Instructions

- Review the assigned worktree snapshot only.
- Use the parent-provided brief, file list, and requirements summary as the authoritative scope.
- Do not review from a fixed checklist. Review everything.
- Follow the code and changed behavior wherever it leads inside the assigned scope.
- When the change touches a special domain, additionally review that domain's behavior and risks.
- Treat domain prompts as minimum coverage reminders, not the boundary of the review.
- Report concrete findings with file and line evidence plus impact. If a reviewed surface matches scope, say so explicitly.
- Avoid speculative improvements, style-only notes, and history digging unless the parent explicitly asks for them.
- If the scope is stale, missing, or contradictory, stop and message the parent instead of guessing.
