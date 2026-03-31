# j-skills-public

Public subset of my `j-skills` monorepo, limited to the two collaboration skills that are reasonably reusable outside my private setup:

- `cobuild`
- `teamwork`

This repo was created from a fresh snapshot of the private source repo rather than by preserving its history. That keeps the public history clean and avoids accidentally publishing unrelated internal work.

## Included Skills

### `cobuild`

Run multiple coding-agent CLIs against the same implementation task in isolated git worktrees, compare the results, do one critique-and-rebuild pass, and only apply a final direction after unanimous approval from the child sessions.

MCP requirement: none.

### `teamwork`

Run a parent-led implementation workflow where specialized workers each own a worktree, coordinate through an MCP session, and hand clean phase results back to the parent for integration.

MCP requirement: yes. This skill expects a compatible `teamwork-mcp` server.

## Repo Layout

```text
j-skills-public/
  cobuild/
    SKILL.md
    README.md
    .env.template
    *-Cobuild.md
    ALTERNATIVE_DESIGNS.md
  teamwork/
    SKILL.md
    README.md
    .env.template
    *-Teamwork.md
    ALTERNATIVE_DESIGNS.md
```

## Using These Skills

Copy the skill folder you want into the skill location used by your host tool. The included `SKILL.md` files are the source prompts; the `*-Cobuild.md` and `*-Teamwork.md` files are CLI-specific session guides referenced by those skills.

Before running either skill:

- Review the skill folder README.
- Copy `.env.template` to `.env` only if you actually want local defaults.
- Update CLI names, model names, and output directories to match your machine.
- Keep runtime artifacts out of git.

## How To Add a Skill Stub

If you are installing one of these skills into another system repo, use the same stub pattern as `j-skills`: create a folder with the exact same name as the source skill folder, then make its `SKILL.md` a thin redirect back to the canonical source in this repo.

Required stub shape:

```md
---
name: <skill-name>
description: <copy the description from the source skill frontmatter>
---

Read the SKILL.md in full from '/path/to/j-skills-public/<skill-name>/SKILL.md'
```

Rules:

- Keep the folder name exactly the same as this repo.
- Copy the `name` and `description` fields exactly from the source skill frontmatter.
- Treat this repo as the canonical source for the public subset.
- Point the stub back to your local clone of `j-skills-public`, not to an edited duplicate.

Canonical source paths:

- `cobuild` -> `j-skills-public/cobuild/SKILL.md`
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

The original private monorepo uses a local `teamwork-mcp` TypeScript server. That server is not bundled here. If you wire this skill to your own implementation, keep the tool names and semantics compatible with the contract documented in [`teamwork/SKILL.md`](./teamwork/SKILL.md).

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

## Security

- This public repo includes `.env.template` files only. Do not commit real `.env` files.
- Do not commit `.cobuild/`, `.teamwork/`, worktrees, transcripts, or agent runtime packets.
- If your `teamwork` setup uses per-agent auth tokens, treat them as runtime-only values and never store them in the repo.
- Review the CLI-specific guides before use. They contain placeholders and examples, not production-safe defaults.

## Source Review

The public subset was copied from the current `moorej2400/j-skills` `main` branch after pulling the latest version and checking the recent history for the relevant paths:

- `teamwork` was introduced in `69dddde` and materially updated in `a1c0073`
- `cobuild` was introduced in `88e3406`
- top-level MCP setup docs were updated in `532c794` and `a1c0073`

If you want the MCP server code itself public later, publish that as a separate repo with its own install and security docs instead of mixing it into this minimal skill subset.
