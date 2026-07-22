# memory-cli

Shared, Claude-style file-based memory for any coding agent.

Claude Code has a built-in memory (a `memory/` directory of one-fact-per-file
Markdown with a loaded index). `memory-cli` reproduces that and makes **one**
per-project store the shared brain for every coding agent you use — a fact written
by any agent is visible to all of them.

## How it works

- **One store per project:** `./.memory/` — Markdown facts plus a generated
  `MEMORY.md` index. Gitignored by default.
- **The index is derived.** Agents only ever write their own fact files;
  `memory reindex` regenerates `MEMORY.md`. No shared file is hand-edited, so
  concurrent agents never conflict over it.
- **Each agent is wired to the store in its own native way** (`memory enable`):
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
bun link          # puts `memory` on your PATH
```

Run `memory` from inside your project. The MCP registration below also expects
`memory` on your PATH.

## Quickstart

```bash
memory init                 # create .memory/ and gitignore it
memory enable --all         # wire up Claude Code + the AGENTS.md agents
memory add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."
memory status               # show the store and which agents are enabled
```

Now any enabled agent sees the memory. When an agent writes a fact file directly,
run `memory reindex` to refresh the index (or let the next `add`/MCP write do it).

## Commands

| Command | Purpose |
|---|---|
| `memory init` | Create `.memory/` in the project and gitignore it |
| `memory add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a fact; refuses an existing slug unless `--force` |
| `memory list` | Print the memory index (`MEMORY.md`) |
| `memory read <id>` | Print one fact by its id (slug) |
| `memory edit <id>` | Open a fact in `$EDITOR`, reindex on save |
| `memory delete <id>` | Remove a fact by its id (slug) |
| `memory search <query>` | Find facts containing text |
| `memory reindex` | Rebuild `MEMORY.md` from fact frontmatter |
| `memory doctor` | Check the store: parse errors, dangling `[[links]]`, stale index |
| `memory enable <agent…> \| --all` | Wire an agent to the shared store |
| `memory disable <agent…> \| --all` | Remove an agent's wiring (leaves the store) |
| `memory status` | Show the store and per-agent status |
| `memory path` | Print the store directory |
| `memory mcp` | Run the MCP server over stdio |

Agents: `claude-code`, `agents`, `bob`, `cursor`. Fact types: `user`, `feedback`, `project`, `reference`.

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

For agents that call tools instead of reading files, `memory mcp` runs a stdio
server exposing `memory_index`, `memory_search`, `memory_read`, `memory_write`,
and `memory_remove`.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "memory": { "type": "stdio", "command": "memory", "args": ["mcp"] }
  }
}
```

Codex CLI:

```bash
codex mcp add memory -- memory mcp
```

## Development

```bash
bun run check      # format:check + lint + typecheck + test
bun test           # tests only
```

Stack: `bun` (runtime, tests), TypeScript 7 (`tsgo`, typecheck), `ultracite`
driving `oxlint` + `oxfmt`.

## Not yet included

Agent-specific adapters for cases where `AGENTS.md` isn't enough (e.g. Cursor's
own rules format), a global cross-project store, and semantic recall. The `Adapter`
interface (`src/adapters/adapter.ts`) is the extension point for new agents.
