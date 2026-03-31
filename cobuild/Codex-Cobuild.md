# Codex Cobuild Session Guide

Use explicit session IDs for every child session.

## Start Child Session

```bash
MODEL="gpt-5"
PROMPT="Cobuild task prompt"

# If your cod build supports model override, include: -m \"$MODEL\"
OUTPUT=$(cod exec -c hide_agent_reasoning=true -c model_reasoning_effort=low "$PROMPT" 2>&1)
echo "$OUTPUT"
SESSION_ID=$(echo "$OUTPUT" | grep "session id:" | awk '{print $3}')
echo "$SESSION_ID"
```

## Resume Child Session

```bash
cod exec resume "$SESSION_ID" "Cobuild follow-up for critique, rebuild, or final approval"
```

## Notes

- Never use implicit latest-session behavior.
- Keep one stable `SESSION_ID` per child alias.
- Give each child one explicit worktree path and tell it not to edit outside that worktree.
- The parent agent running the skill handles comparison, decision-making, and the final apply step.
