---
name: cobuild
description: Use when you want multiple coding-agent CLIs to solve the same implementation task in separate git worktrees, compare competing builds, and converge on one approved final path before applying changes to the main workspace
---

# Cobuild

Use this skill to run a fixed two-pass multi-CLI implementation workflow.

The agent running this skill is the parent orchestrator. The coding-agent CLIs it launches are child sessions. Each child owns one dedicated git worktree and may edit only inside that worktree. The parent is responsible for comparison, critique synthesis, final decision-making, and the final apply step outside the child worktrees.

## Target Routing

Use these references for CLI-specific session commands:

- Codex: [Codex-Cobuild.md](./Codex-Cobuild.md)
- Claude: [Claude-Cobuild.md](./Claude-Cobuild.md)
- Gemini: [Gemini-Cobuild.md](./Gemini-Cobuild.md)
- OpenCode: [OpenCode-Cobuild.md](./OpenCode-Cobuild.md)
- Copilot: [Copilot-Cobuild.md](./Copilot-Cobuild.md)

## Input Contract

Prefer a `SKILL_VARS` block in the task prompt. If `roster` is omitted there, load it from `COBUILD_DEFAULT_ROSTER` in `.env`.

```yaml
SKILL_VARS:
  roster:
    - { alias: "codex-main", cli: "codex", model: "gpt-5" }
    - { alias: "claude-main", cli: "claude", model: "claude-sonnet-4-6" }
  output_dir: ".cobuild"
  allow_hybrid_final: true
  require_rebuild_pass: true
```

Rules:

- Require at least 2 `roster` entries.
- Allow repeated CLI families with different aliases or models.
- Require every roster entry to define `cli` and `model`.
- Allow `alias` to be omitted. If omitted, derive it as `<cli>-<index>`.
- Normalize `cli` against `codex|claude|gemini|opencode|copilot`.
- Prompt-level values win over `.env` defaults.

## Env Defaults

Read defaults from `.env` in this skill folder.

- `COBUILD_DEFAULT_ROSTER`
  Optional semicolon-separated roster fallback in the form `alias:cli:model;...`.
- `COBUILD_OUTPUT_DIR`
  Default artifact root. Default `.cobuild`.
- `COBUILD_REQUIRED_APPROVALS`
  Required final approval policy. Default `all`.
- `COBUILD_ALLOW_HYBRID_FINAL`
  Whether the parent may synthesize a hybrid final direction. Default `true`.
- `COBUILD_REQUIRE_REBUILD_PASS`
  Whether the rebuild pass is required. Default `true`.

## Artifacts

Use a minimal project-scoped workspace:

```text
<output_dir>/<task-slug>/
  roster.md
  implementations.md
  critique.md
  rebuild.md
  decision.md
  final.md
  worktrees/
    <alias>/
```

Artifact intent:

- `roster.md`
  Active child roster, CLI/model mapping, worktree path, and session ID.
- `implementations.md`
  Initial implementation summaries and file references for each child.
- `critique.md`
  Synthesized cross-child critique and reusable ideas.
- `rebuild.md`
  Summary of the rebuild pass and major changes per child.
- `decision.md`
  Parent's proposed final direction plus approval responses from each child.
- `final.md`
  Final applied outcome, verification summary, and unresolved follow-up items.

## Default Flow

Run this exact workflow:

`setup -> build -> critique -> rebuild -> decide -> approve -> apply`

### 1. Setup

- Validate `SKILL_VARS` and load `.env` defaults.
- Create the runtime workspace.
- Create one isolated git worktree per child alias under `worktrees/<alias>/`.
- Create or resume one explicit child session per alias.
- Send every child the same base task prompt, plus:
  - the assigned worktree path
  - an instruction to edit only inside that worktree
  - a reminder that the parent will compare implementations later

### 2. Build

- Each child independently implements the task inside its own worktree.
- Require each child response to include:
  - `Summary`
  - `FilesChanged`
  - `Verification`
  - `Risks`
  - `ReadyForCritique` (`yes` or `no`)
- Record the outputs in `implementations.md`.

### 3. Critique

- Send each child the full implementation comparison packet.
- Require each child to review all implementations, including its own.
- Require this response shape:
  - `StrengthsByImplementation`
  - `WeaknessesByImplementation`
  - `ReusableIdeas`
  - `PreferredBase`
  - `BlockingObjections` (`none` or list)
- Synthesize the results in `critique.md`.

### 4. Rebuild

- Send the critique packet back to every child.
- Require exactly one rebuild pass in the same worktree when `COBUILD_REQUIRE_REBUILD_PASS` is true.
- Require this response shape:
  - `ChangesMade`
  - `KeptFromOriginal`
  - `AdoptedFromPeers`
  - `Verification`
  - `RemainingRisks`
  - `ReadyForFinal` (`yes` or `no`)
- Record the results in `rebuild.md`.

### 5. Decide

- The parent proposes one final direction after the rebuild pass.
- Prefer selecting one child implementation unchanged when one is clearly strongest.
- Allow a hybrid final direction only when the critique and rebuild outputs identify specific superior parts that materially improve the outcome.
- Do not synthesize a hybrid just to split the difference.
- Record the proposed final direction in `decision.md`.

### 6. Approve

- Send the proposed final direction to all children.
- Require this exact response shape:
  - `ApproveFinal` (`yes` or `no`)
  - `BlockingObjections` (`none` or list)
  - `Notes`
- Unanimous approval is required before the parent may apply the final result outside the worktrees.

### 7. Apply

- Apply the final result in the main workspace only when:
  - every valid child returns `ApproveFinal: yes`
  - every valid child returns `BlockingObjections: none`
- Record the final apply result and verification in `final.md`.
- Stop after the first successful final apply.

## Stop Rules

- If any child fails to produce a valid build response, retry once in the same session with explicit missing fields.
- If fewer than 2 valid child outputs remain after retry, stop and report runtime failure.
- If any child returns a blocking objection in the final approval gate, stop without applying a final outside-worktree result.
- If unanimous approval is not reached, report the best candidate, the unresolved objections, and stop.
- Do not add extra critique/rebuild loops in the default flow. For heavier disagreement, see [ALTERNATIVE_DESIGNS.md](./ALTERNATIVE_DESIGNS.md).

## Orchestrator Rules

- The parent agent running the skill is the only orchestrator.
- Do not launch a dedicated merge sub-agent.
- Keep one stable explicit session ID per child alias.
- Do not rely on implicit latest-session behavior for any CLI.
- Do not let children edit the main workspace.
- The parent performs the final outside-worktree apply step after approval, not a child.

## Response Validation

- A child response is valid only when all required headings for the current phase are present.
- `ReadyForCritique`, `ReadyForFinal`, and `ApproveFinal` must be exactly `yes` or `no`.
- `BlockingObjections` must be exactly `none` or a concrete list.
- Retry malformed outputs once. If the retry still fails, exclude that child from the current stage and stop if fewer than 2 valid children remain.
