# OpenCode Cobuild Session Guide

Use explicit session IDs for every child session.

## Start Child Session

```bash
MODEL="anthropic/claude-sonnet-4-6"
PROMPT="Cobuild task prompt"
opencode run -m "$MODEL" "$PROMPT"
SESSION_ID=$(opencode session list 2>&1 | head -5 | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
echo "$SESSION_ID"
```

## Resume Child Session

```bash
opencode run --session "$SESSION_ID" -m "$MODEL" "Cobuild follow-up for critique, rebuild, or final approval"
```

## Notes

- Never use `--continue` in cobuild workflows.
- Keep one stable `SESSION_ID` per child alias.
- Give each child one explicit worktree path and tell it not to edit outside that worktree.
- The parent agent running the skill handles comparison, decision-making, and the final apply step.
