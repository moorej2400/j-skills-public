# Gemini Cobuild Session Guide

Use explicit session IDs for every child session.

## Start Child Session

```bash
MODEL="gemini-2.5-pro"
PROMPT="Cobuild task prompt"
gemini -m "$MODEL" "$PROMPT"
SESSION_ID=$(gemini --list-sessions 2>&1 | grep -v WARN | grep '^\s*1\.' | grep -oP '\[\K[^\]]+')
echo "$SESSION_ID"
```

## Resume Child Session

```bash
gemini --resume "$SESSION_ID" -m "$MODEL" "Cobuild follow-up for critique, rebuild, or final approval"
```

## Notes

- Never use `--resume latest` or index-only resume.
- Keep one stable `SESSION_ID` per child alias.
- Give each child one explicit worktree path and tell it not to edit outside that worktree.
- The parent agent running the skill handles comparison, decision-making, and the final apply step.
