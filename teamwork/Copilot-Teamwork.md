# GitHub Copilot Teamwork Session Guide

Use explicit session IDs for every worker session.

## Install / Verify

```bash
npm install -g @github/copilot
copilot --version
```

## Start Worker Session

```bash
WORKSPACE_DIR="<output_dir>/<task-slug>/worktrees/<alias>"
PROJECT_ROOT="<real code directory>"
MODEL="gpt-5"

PROMPT=$(cat <<EOF
Teamwork worker workspace: $WORKSPACE_DIR
Project root: $PROJECT_ROOT
MCP session id: <session-id>
Your agent id: <agent-id>
Your session auth token (runtime only, never commit): <agent-token>
Current phase: <phase-number> - <phase-title>
Your specialty: <specialty>
Your assigned work items: <summary>
Other workers and specialties: <roster-summary>
Edit only inside $WORKSPACE_DIR for this phase.
Register your worktree with tw_set_agent_worktree at session start.
Poll the teamwork MCP regularly for broadcast messages, DMs, and reassignment.
Ask the relevant specialist when you need owned-area knowledge.
At phase end, call tw_report_result with your commit SHA and summary, then leave a clean commit.
EOF
)

cd "$WORKSPACE_DIR"
OUTPUT=$(copilot -p "$PROMPT" --model "$MODEL" --allow-all-tools --share 2>&1)
echo "$OUTPUT"
SESSION_ID=$(echo "$OUTPUT" | grep -oE 'copilot-session-[A-Za-z0-9_-]+\.md' | sed -E 's/^copilot-session-([A-Za-z0-9_-]+)\.md$/\1/' | tail -1)
echo "$SESSION_ID"
```

## Resume Worker Session

```bash
cd "$WORKSPACE_DIR"
copilot -p "Continue the current teamwork phase from $WORKSPACE_DIR." --resume "$SESSION_ID" --model "$MODEL" --allow-all-tools
```

## Fallback If ID Extraction Fails

```bash
cd "$WORKSPACE_DIR"
copilot --resume
```

## Notes

- Prefer explicit `--resume <SESSION-ID>` over `--continue`.
- Keep one stable `SESSION_ID` per worker alias.
- Start and resume from the same worktree path for the current phase.
- The parent may recreate the worktree between phases, so always trust the latest runtime packet.
- Workers should call `tw_report_result` before signaling done so the parent can review results through MCP.
