# Cobuild

`cobuild` is a multi-CLI implementation skill for situations where you want several coding agents to tackle the same task independently before converging on one approved final path.

## Default Flow

The default flow is intentionally simple:

1. The parent loads the configured child roster.
2. Each child gets its own git worktree.
3. All children build the same task independently.
4. All children critique the full implementation set.
5. All children get one rebuild pass in their own worktree.
6. The parent proposes one final direction.
7. All children must approve that final direction.
8. The parent applies the final result outside the worktrees.

## Why Worktrees Matter

Each child works in its own isolated git worktree. That keeps implementations from colliding, makes comparison straightforward, and lets the parent inspect competing approaches before deciding what survives.

## Base Versus Hybrid

The parent should prefer picking one strong implementation when one is clearly better than the rest. Hybrid synthesis is allowed, but only when the critique and rebuild outputs show a materially better combined path. The goal is not compromise for its own sake.

## Approval Gate

The final outside-worktree apply step requires unanimous child approval. If any child still reports a blocking objection, the run stops and the parent reports the disagreement instead of forcing a final merge.

## Alternative Design

The default `cobuild` flow does not loop indefinitely. If you need a heavier disagreement-resolution path, see [ALTERNATIVE_DESIGNS.md](./ALTERNATIVE_DESIGNS.md).
