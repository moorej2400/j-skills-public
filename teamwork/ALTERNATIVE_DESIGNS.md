# Alternative Designs

## Next Steps

### Validation Agents At Phase Boundaries

The MVP should stop after the parent integrates worker commits and runs the standard verification needed for that phase.

The first major follow-up design should add validation agents at the end of each phase. Those agents would:

- inspect the integrated `main` state after phase merge
- run focused validation or review passes
- report regressions, missing integration, and risky assumptions before the next phase starts

That is intentionally not part of the first `teamwork` release. The MVP should keep the loop smaller and focus on specialized worker delegation, coordination, integration, and worktree refresh.

### Planning, Review, And Documentation Workflows

These ideas were considered for the main `teamwork` skill, but are deferred to avoid changing the current workflow semantics before the server-backed redesign settles.

Potential future additions:

1. Make high-level teamwork requests self-contained: the parent infers source files, attachments, expected worker artifacts, and the final deliverable from task and repo context.
2. Generalize teamwork beyond implementation to explicitly include code review, planning, documentation, and audit-style tasks.
3. Clarify that parent integration can include synthesizing worker-produced docs, findings, plans, or critiques into the final requested deliverable when the task is not primarily code.
4. Add required source files, attachments, repo areas, and expected artifact/result shape to the standard worker prompt fields.
5. Clarify that PAIR mode defaults to one shared output, but planning, review, comparison, or documentation tasks may use separate draft artifacts when that helps the parent synthesize one final output.

If added later, these should be written as scope/input/output clarifications. They should not add a new workflow, weaken the parent-led phase loop, or change the default PAIR implementation model.
