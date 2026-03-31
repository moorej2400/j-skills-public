# Alternative Designs

## Next Steps

### Validation Agents At Phase Boundaries

The MVP should stop after the parent integrates worker commits and runs the standard verification needed for that phase.

The first major follow-up design should add validation agents at the end of each phase. Those agents would:

- inspect the integrated `main` state after phase merge
- run focused validation or review passes
- report regressions, missing integration, and risky assumptions before the next phase starts

That is intentionally not part of the first `teamwork` release. The MVP should keep the loop smaller and focus on specialized worker delegation, coordination, integration, and worktree refresh.
