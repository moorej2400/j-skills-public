# j-skills-public

Public subset of my `j-skills` monorepo, limited to skills that are reasonably reusable outside my private setup:

- `cobuild`
- `frontend-dev-vercel`
- `teamwork`

This repo was created from a fresh snapshot of the private source repo rather than by preserving its history. That keeps the public history clean and avoids accidentally publishing unrelated internal work.

## Included Skills

### `cobuild`

Run multiple coding-agent CLIs against the same implementation task in isolated git worktrees, compare the results, do one critique-and-rebuild pass, and only apply a final direction after unanimous approval from the child sessions.

MCP requirement: none.

### `frontend-dev-vercel`

Design, implement, review, or audit frontend interfaces against a practical checklist based on Vercel's Web Interface Guidelines.

MCP requirement: none.

### `teamwork`

Run a parent-led implementation workflow where specialized workers each own a worktree, coordinate through an MCP session, and hand clean phase results back to the parent for integration.

MCP requirement: yes. This repo includes a compatible `teamwork-mcp` server.

## Repo Layout

```text
j-skills-public/
  cobuild/
    SKILL.md
    README.md
    .env.template
    *-Cobuild.md
    ALTERNATIVE_DESIGNS.md
  frontend-dev-vercel/
    SKILL.md
  teamwork/
    SKILL.md
    README.md
    .env.template
    *-Teamwork.md
    ALTERNATIVE_DESIGNS.md
  teamwork-mcp/
    package.json
    package-lock.json
    tsconfig.json
    src/
    test/
    README.md
```

## Using These Skills

Copy the skill folder you want into the skill location used by your host tool. The included `SKILL.md` files are the source prompts; the `*-Cobuild.md` and `*-Teamwork.md` files are CLI-specific session guides referenced by those skills.

Before running either skill:

- Review the skill folder README.
- Copy `.env.template` to `.env` only if you actually want local defaults.
- Update CLI names, model names, and output directories to match your machine.
- Keep runtime artifacts out of git.

## How To Add a Skill Stub

If you are installing one of these skills into another system repo, create a folder named exactly the same as the corresponding folder in this repo.

Each stub `SKILL.md` should preserve the source skill metadata needed for discovery in the target AI platform, then redirect to the canonical source in this repo. At minimum, copy the source skill's `description` exactly. If the target platform supports or requires additional compatible skill metadata for discovery, include that metadata in the stub as well. Put that metadata in whatever header location the target AI platform expects. In the example below, the `---` lines are the YAML frontmatter delimiter used by hosts that support frontmatter. If the target platform uses a different header format, use that format instead.

Recommended stub shape:

```md
[Add any host-specific compatible skill metadata here if the target platform expects a header before YAML frontmatter]

---
name: <skill-name>
description: <copy the description from the source skill frontmatter>
---

Before following any instruction in this stub, first check the canonical skill header in '/path/to/j-skills-public/<skill-name>/SKILL.md'. If the source skill metadata has changed and this stub is out of date, update this stub to match the current source skill metadata before proceeding.

Then read the SKILL.md in full from '/path/to/j-skills-public/<skill-name>/SKILL.md'
```

Rules:

- Keep the folder name exactly the same as the source skill folder in this repo.
- Copy the source skill `description` exactly into the stub.
- Copy any other compatible skill metadata fields required by the target AI platform, and place them in the header format and location that platform expects, so the host can discover and trigger the stub correctly.
- The stub must tell the AI to first compare the stub header against the canonical skill header and update the stub whenever the source skill metadata changes.
- Treat this repo as the canonical source for the public subset.
- Point the stub back to your local clone of `j-skills-public`, not to an edited duplicate.

The skill metadata is what most systems use for discovery and triggering. If you omit or stale-copy it, the host AI may never know to load the stub.

Canonical source paths:

- `cobuild` -> `j-skills-public/cobuild/SKILL.md`
- `frontend-dev-vercel` -> `j-skills-public/frontend-dev-vercel/SKILL.md`
- `teamwork` -> `j-skills-public/teamwork/SKILL.md`

## MCP Notes

`cobuild` does not require MCP.

`teamwork` expects a lightweight coordination server with the following tool surface:

- Session lifecycle: `tw_get_dashboard_url`, `tw_create_session`, `tw_register_agent`, `tw_get_session_state`, `tw_complete_session`
- Phase management: `tw_start_phase`, `tw_complete_phase`
- Work items: `tw_upsert_work_item`, `tw_list_work_items`
- Messaging: `tw_send_message`, `tw_list_messages`, `tw_ack_messages`
- Agent status: `tw_set_agent_status`
- Worktree helpers: `tw_set_agent_worktree`, `tw_get_agent_worktree`, `tw_inspect_worktree`
- Result reporting: `tw_report_result`, `tw_list_results`
- Checkpoints: `tw_checkpoint`, `tw_list_checkpoints`

This repo now bundles the same `teamwork-mcp` TypeScript server used by the private source repo. If you swap in your own implementation, keep the tool names and semantics compatible with the contract documented in [`teamwork/SKILL.md`](./teamwork/SKILL.md).

Generic host config guidance for a local MCP server:

- Prefer a command-based stdio launch over a manually managed long-running HTTP process.
- Start the server from its own repo directory.
- Prefer repo-local launchers such as `./node_modules/.bin/...`, `npm exec ...`, or `pnpm exec ...`.
- Install dependencies before wiring the host config.

Portable config shape:

```json
{
  "mcpServers": {
    "teamwork": {
      "command": "bash",
      "args": [
        "-lc",
        "cd /absolute/path/to/teamwork-mcp && ./node_modules/.bin/tsx src/server.ts"
      ]
    }
  }
}
```

Install the bundled server dependencies before wiring your host config:

```bash
cd teamwork-mcp && npm install
```

## Security

- This public repo includes `.env.template` files only. Do not commit real `.env` files.
- Do not commit `.cobuild/`, `.teamwork/`, worktrees, transcripts, or agent runtime packets.
- If your `teamwork` setup uses per-agent auth tokens, treat them as runtime-only values and never store them in the repo.
- Review the CLI-specific guides before use. They contain placeholders and examples, not production-safe defaults.

## Source Review

The original collaboration skills were copied from the current `moorej2400/j-skills` `main` branch after pulling the latest version and checking the recent history for the relevant paths:

- `teamwork` was introduced in `69dddde` and materially updated in `a1c0073`
- `cobuild` was introduced in `88e3406`
- top-level MCP setup docs were updated in `532c794` and `a1c0073`

`frontend-dev-vercel` was added directly to this public repo and credits Vercel's Web Interface Guidelines in its skill body.

The bundled `teamwork-mcp` stays intentionally narrow: it exists to support the public `teamwork` skill without requiring a second private checkout.
