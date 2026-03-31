# Claude Cobuild Session Guide

Use explicit session IDs for every child session.

## Start Child Session

```bash
MODEL="claude-sonnet-4-6"
PROMPT="Cobuild task prompt"
SESSION_ID=$(uuidgen)
claude -p --session-id "$SESSION_ID" --model "$MODEL" "$PROMPT"
echo "$SESSION_ID"
```

## Resume Child Session

```bash
claude -r "$SESSION_ID" -p --model "$MODEL" "Cobuild follow-up for critique, rebuild, or final approval"
```

## Notes

- Never use `--continue` in cobuild workflows.
- Keep one stable `SESSION_ID` per child alias.
- Give each child one explicit worktree path and tell it not to edit outside that worktree.
- The parent agent running the skill handles comparison, decision-making, and the final apply step.
