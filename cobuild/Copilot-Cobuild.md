# GitHub Copilot Cobuild Session Guide

Use explicit session IDs for every child session.

## Install / Verify

```bash
npm install -g @github/copilot
copilot --version
```

## Start Child Session

Use programmatic mode (`-p`) and `--share` so Copilot emits a share file name containing the session ID.

```bash
MODEL="gpt-5"
PROMPT="Cobuild task prompt"

OUTPUT=$(copilot -p "$PROMPT" --model "$MODEL" --allow-all-tools --share 2>&1)
echo "$OUTPUT"

# Extract session ID from default share filename: copilot-session-<SESSION_ID>.md
SESSION_ID=$(echo "$OUTPUT" | grep -oE 'copilot-session-[A-Za-z0-9_-]+\.md' | sed -E 's/^copilot-session-([A-Za-z0-9_-]+)\.md$/\1/' | tail -1)
echo "$SESSION_ID"
```

## Resume Child Session

```bash
copilot -p "Cobuild follow-up for critique, rebuild, or final approval" --resume "$SESSION_ID" --model "$MODEL" --allow-all-tools
```

## Fallback If ID Extraction Fails

```bash
# Open session picker, then run /session to display ID in CLI
copilot --resume
```

## Notes

- Prefer explicit `--resume <SESSION-ID>` over `--continue`.
- Keep one stable `SESSION_ID` per child alias.
- Give each child one explicit worktree path and tell it not to edit outside that worktree.
- The parent agent running the skill handles comparison, decision-making, and the final apply step.
