# mdmem

Shared, Claude-style file-based memory for any coding agent.

Claude Code has a built-in memory (a `memory/` directory of one-fact-per-file
Markdown with a loaded index). `mdmem` reproduces that and makes **one**
per-project store the shared brain for every coding agent you use — a fact written
by any agent is visible to all of them.

## How it works

- **One store per project:** `./.memory/` — Markdown facts plus a generated
  `MEMORY.md` index. Gitignored by default.
- **The index is derived.** Agents only ever write their own fact files;
  `mdmem reindex` regenerates `MEMORY.md`. No shared file is hand-edited, so
  concurrent agents never conflict over it.
- **Each agent is wired to the store in its own native way** (`mdmem enable`):
  - **Claude Code** (specific) — sets `autoMemoryDirectory` in
    `.claude/settings.local.json` so Claude's *own* memory reads and writes the
    shared store, no rule or hook needed.
  - **AGENTS.md** (`agents`) — a memory-protocol block in the repo-root
    `AGENTS.md`, the instruction file read by Codex, Cursor, Gemini CLI, Aider, and
    others. Its text lives in `templates/memory-protocol.md` and is easy to edit.
  - **IBM Bob** (`bob`) — writes that same protocol to `.bob/rules/memory.md`.
  - **Cursor** (`cursor`) — writes `.cursor/rules/memory.mdc` (Cursor requires the
    `.mdc` extension and `alwaysApply: true` frontmatter to load a rule every session).
- **Two surfaces, one core:** a CLI for humans/scripts and setup, and an MCP
  server for agents that prefer tool calls.

## Install

```bash
bun install
bun link          # puts `mdmem` on your PATH
```

Run `mdmem` from inside your project. The MCP registration below also expects
`mdmem` on your PATH.

## Quickstart

```bash
mdmem init                  # create .memory/ and gitignore it
mdmem enable --all          # wire up Claude Code + the AGENTS.md agents
mdmem add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."
mdmem status                # show the store and which agents are enabled
```

Now any enabled agent sees the memory. When an agent writes a fact file directly,
run `mdmem reindex` to refresh the index (or let the next `add`/MCP write do it).

## Commands

| Command | Purpose |
|---|---|
| `mdmem init` | Create `.memory/` in the project and gitignore it |
| `mdmem add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a fact; refuses an existing slug unless `--force`. Body may also be piped via stdin. |
| `mdmem list` | Print the memory index (`MEMORY.md`) |
| `mdmem read <id>` | Print one fact by its id (slug or `<slug>.md`) |
| `mdmem edit <id>` | Open a fact in `$VISUAL`/`$EDITOR`, reindex on save |
| `mdmem delete` (alias `rm`) `<id>` | Remove a fact by its id (slug or `<slug>.md`) |
| `mdmem search <query>` | Find facts containing text |
| `mdmem reindex` | Rebuild `MEMORY.md` from fact frontmatter |
| `mdmem doctor` | Check the store: parse errors, name≠filename, dangling `[[links]]`, stale index |
| `mdmem enable <agent…> \| --all` | Wire an agent to the shared store |
| `mdmem disable <agent…> \| --all` | Remove an agent's wiring (leaves the store) |
| `mdmem status` | Show the store and per-agent status |
| `mdmem path` | Print the store directory |
| `mdmem mcp` | Run the MCP server over stdio |

Agents: `claude-code`, `agents`, `bob`, `cursor`. Fact types: `user`, `feedback`, `project`, `reference`.

With no `$VISUAL`/`$EDITOR` set, `mdmem edit` prints the fact's path instead of
opening it — edit it by hand, then run `mdmem reindex`.

## Fact format

One file, one fact — `.memory/<slug>.md`:

```markdown
---
name: uses-bun
description: This project uses bun, not node
metadata:
  type: feedback
---

Use bun for scripts and tests.

**Why:** the project standardized on it.
**How to apply:** run everything through bun. [[ts7-strict]]
```

`feedback`/`project` facts add `**Why:**` and `**How to apply:**` lines; link
related facts with `[[other-slug]]`.

## MCP server

For agents that call tools instead of reading files, `mdmem mcp` runs a stdio
server exposing `memory_index`, `memory_search`, `memory_read`, `memory_write`,
and `memory_remove`. `memory_read` also returns each fact's current version; pass
it back as `memory_write`'s `ifVersion` for a safe read-modify-write that rejects a
clobbered concurrent change.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "mdmem": { "type": "stdio", "command": "mdmem", "args": ["mcp"] }
  }
}
```

Codex CLI:

```bash
codex mcp add mdmem -- mdmem mcp
```

## Development

```bash
bun run all:check  # type:check + ultracite check + test (what CI runs)
bun run check      # ultracite check: oxlint + oxfmt
bun run fix        # ultracite fix
bun test           # tests only
```

Stack: `bun` (runtime, tests), TypeScript 7 (`tsc`, typecheck), `ultracite`
driving `oxlint` + `oxfmt`.

## Not yet included

A global cross-project store and semantic recall. Agents that need more than
`AGENTS.md` get their own adapter, as Claude Code, IBM Bob and Cursor do; the
`Adapter` interface (`src/adapters/adapter.ts`) is the extension point for new ones.

## License

[MIT](LICENSE) © Gilles d'Andrea
