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
- **Each agent is wired to the store in its own native way** (`memory link`):
  - **Claude Code** — a `.claude/rules/memory.md` rule (always loaded) plus a
    `SessionStart` hook that injects the index into every session.
  - **Codex CLI** — a memory block merged into the repo-root `AGENTS.md`.
- **Two surfaces, one core:** a CLI for humans/scripts and setup, and an MCP
  server for agents that prefer tool calls.

## Install

```bash
bun install
bun link          # puts `memory` (and `memory-mcp`) on your PATH
```

The Claude Code `SessionStart` hook runs `memory session-start`, so `memory` must
be on your PATH.

## Quickstart

```bash
memory init                 # create .memory/ and gitignore it
memory link --all           # wire up Claude Code + Codex CLI
memory add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."
memory status               # show the store and which agents are linked
```

Now any linked agent sees the memory. When an agent writes a fact file directly,
run `memory reindex` to refresh the index (or let the next `add`/MCP write do it).

## Commands

| Command | Purpose |
|---|---|
| `memory init` | Create `.memory/` in the project and gitignore it |
| `memory add --type <t> --name <n> --description <d> [--body <text>]` | Save a fact (body may be piped on stdin) |
| `memory list` | Print the memory index (`MEMORY.md`) |
| `memory search <query>` | Find facts containing text |
| `memory reindex` | Rebuild `MEMORY.md` from fact frontmatter |
| `memory link <agent…> \| --all` | Wire an agent to the shared store |
| `memory unlink <agent…> \| --all` | Remove an agent's wiring (leaves the store) |
| `memory status` | Show the store and per-agent link status |
| `memory session-start` | Emit the Claude Code `SessionStart` hook payload |

Agents: `claude-code`, `codex-cli`. Fact types: `user`, `feedback`, `project`, `reference`.

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

For agents that call tools instead of reading files, `memory-mcp` exposes
`memory_index`, `memory_search`, `memory_read`, `memory_write`, and
`memory_remove` over stdio.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "memory": { "type": "stdio", "command": "memory-mcp" }
  }
}
```

Codex CLI:

```bash
codex mcp add memory -- memory-mcp
```

## Development

```bash
bun run check      # format:check + lint + typecheck + test
bun test           # tests only
```

Stack: `bun` (runtime, tests), TypeScript 7 (`tsgo`, typecheck), `ultracite`
driving `oxlint` + `oxfmt`.

## Not yet included

Adapters beyond Claude Code and Codex CLI (Cursor, Gemini CLI, Aider, …), a global
cross-project store, and semantic recall. The `Adapter` interface
(`src/adapters/adapter.ts`) is the extension point for new agents.
