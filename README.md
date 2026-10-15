# mdmem

Shared, Claude-style file-based memory for any coding agent.

Claude Code has a built-in memory (a `memory/` directory of one-fact-per-file
Markdown with a loaded index). `mdmem` reproduces that and makes **one**
per-project memory store shared by every coding agent you use — a memory saved by
any agent is visible to all of them.

## How it works

- **One store per project:** `./.memory/` — Markdown memories plus a generated
  `MEMORY.md` index. Gitignored by default.
- **The index is derived.** Agents only ever write their own memory files;
  `mdmem reindex` regenerates `MEMORY.md`. No shared file is hand-edited, so
  concurrent agents never conflict over it.
- **Each agent is wired to the store in its own native way** (`mdmem enable`):
  - **Claude Code** (specific) — sets `autoMemoryDirectory` in
    `.claude/settings.local.json` so Claude's *own* memory reads and writes the
    shared store, no rule or hook needed.
  - **AGENTS.md** (`agents`) — a memory-protocol block in the repo-root
    `AGENTS.md`, the instruction file read by Codex, Cursor, Gemini CLI, Aider, and
    others. The protocol adapts Claude Code's own memory instructions to the shared
    store: the memory types, when to save and what not to, checking a recalled memory
    before acting on it, and saving through the MCP tools when the agent has them. Its
    text lives in `templates/memory-protocol.md` and is easy to edit.
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

Now any enabled agent sees the memory. When an agent writes a memory file directly,
run `mdmem reindex` to refresh the index (or let the next `add`/MCP write do it).

## Commands

| Command | Purpose |
|---|---|
| `mdmem init` | Create `.memory/` in the project and gitignore it |
| `mdmem add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a memory; refuses an existing name unless `--force`. Body may also be piped via stdin. |
| `mdmem list` | Print the memory index (`MEMORY.md`) |
| `mdmem read <name>` | Print one memory by its name (or `<name>.md`) |
| `mdmem edit <name>` | Open a memory in `$VISUAL`/`$EDITOR`, reindex on save |
| `mdmem delete` (alias `rm`) `<name>` | Remove a memory by its name (or `<name>.md`) |
| `mdmem search <query>` | Find memories containing text |
| `mdmem reindex` | Rebuild `MEMORY.md` from memory frontmatter |
| `mdmem consolidate` | Print the consolidation prompt (see below) |
| `mdmem doctor` | Check the store: parse errors, name≠filename, secrets, pointers over 150 characters, dangling `[[links]]`, stale index, index over Claude Code's read limits |
| `mdmem enable <agent…> \| --all` | Wire an agent to the shared store |
| `mdmem disable <agent…> \| --all` | Remove an agent's wiring (leaves the store) |
| `mdmem status` | Show the store and per-agent status |
| `mdmem path` | Print the store directory |
| `mdmem mcp` | Run the MCP server over stdio |

Agents: `claude-code`, `agents`, `bob`, `cursor`. Memory types: `user`, `feedback`, `project`, `reference`.

With no `$VISUAL`/`$EDITOR` set, `mdmem edit` prints the memory's path instead of
opening it — edit it by hand, then run `mdmem reindex`.

## Memory format

One file, one fact — `.memory/<name>.md`:

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

`feedback`/`project` memories add `**Why:**` and `**How to apply:**` lines; link
related memories with `[[name]]`.

## MCP server

For agents that call tools instead of reading files, `mdmem mcp` runs a stdio
server with the same memory-store tools as Claude Code, plus two of its own:

| Tool | Purpose |
|---|---|
| `memory_list` | With no arguments, list the stores: mdmem serves one, named after the project directory, with `MEMORY.md` as its index. With `store`, list its documents by path, with size and last-updated date. `path_prefix` filters by path; `cursor` continues a long listing. |
| `memory_read` | Read one document by `path` (`prefers-bun.md`, or the index `MEMORY.md`), with its version token. |
| `memory_write` | Write a whole memory document at `path`. The content must be a valid memory whose name matches its file name. `MEMORY.md`, paths inside a directory, and content that looks like it holds a secret are refused. |
| `memory_delete` | Delete a memory document at `path`. `MEMORY.md` is refused. |
| `memory_search` | List the memories containing a query, by path with their description. |

`store` is optional everywhere: leave it out to use the project's store. An
unknown store id is an error that names the valid one. `memory_write` and
`memory_delete` require `if_version`, the version token from your last
`memory_read` or `memory_write` of that path. For a file that doesn't exist yet,
`memory_write` takes the literal `new`. When the document has changed since that
version, or `new` names a file that already exists, the call is rejected and
returns the current content and version, so the agent can merge and retry. Both
tools regenerate `MEMORY.md` afterwards.

The server also serves one prompt, `consolidate` (see below).

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

## Consolidation

Claude Code can run a *dream*: a reflective pass that merges, corrects
and prunes its memories. mdmem runs no agent itself, so it serves that pass as a
prompt for any agent, run when you ask for one. `mdmem consolidate` prints it, and
the MCP server serves it as the prompt `consolidate`:

```bash
codex "$(mdmem consolidate)"
```

The agent orients on the store, looks for memories the code has drifted from,
merges and dates what it learned, deletes stale memories, and reconciles feedback
and project memories with the project's instruction files, which it flags but
never edits. Its text lives in `templates/consolidate.md`.

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
