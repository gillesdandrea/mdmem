# mdmem

Shared, Claude-style file-based memory for any coding agent.

Claude Code has a built-in memory (a `memory/` directory of one-fact-per-file
Markdown with a loaded index). `mdmem` reproduces that and makes **one**
per-project memory store shared by every coding agent you use — a memory saved by
any agent is visible to all of them.

## How it works

- **One store per project:** `.memory/` at the project's root, holding Markdown
  memories and a `MEMORY.md` index. In git, the root is the main
  checkout's directory: every linked worktree, subdirectory and submodule uses that
  one store, and a `.memory/` lower down is ignored. A bare repository's root is
  the directory holding it as `.git`, or the bare `x.git` itself. Without git,
  mdmem uses the first `.memory/` walking up from the working directory; under
  your home directory the walk stops before reaching it (run from the home
  directory itself, it still looks there). mdmem never edits `.gitignore`: ignoring or
  committing `.memory/` is your choice, and `mdmem init` says when git does not
  ignore it.
- **mdmem keeps the index up to date from the memories.** Agents only ever write
  their own memory files. After every save or delete through mdmem, and on
  `mdmem reindex`, mdmem updates `MEMORY.md` in place: it appends a pointer for a
  memory that has none, removes pointers to missing files and duplicate pointers,
  and rewrites a pointer's description only when that memory's description
  changed. Every other line (a title, headings, prose, a pointer's own title) is
  kept, so an index written by hand or by Claude Code survives. An empty store has
  an empty index.
- **Each agent is wired to the store in its own native way** (`mdmem enable`):
  - **Claude Code** (`claude-code`): turns Claude's own auto memory off and
    wires it through session-start hooks and the mdmem MCP server, in files
    meant to be committed. See [Claude Code](#claude-code) below.
  - **AGENTS.md** (`agents`) — a memory-protocol block in the repo-root
    `AGENTS.md`, the instruction file read by Codex, Cursor, Gemini CLI, Aider, and
    others. The protocol adapts Claude Code's own memory instructions to the shared
    store: the memory types, when to save and what not to, checking a recalled memory
    before acting on it, and saving through the MCP tools (writing files directly only
    when an agent lacks them). Its text lives in `templates/memory-protocol.md` and is
    easy to edit.
  - **IBM Bob** (`bob`): wires it through session-start hooks and the mdmem
    MCP server, in workspace files meant to be committed. See [IBM Bob](#ibm-bob)
    below.
  - **Cursor** (`cursor`) — writes `.cursor/rules/memory.mdc` (Cursor requires the
    `.mdc` extension and `alwaysApply: true` frontmatter to load a rule every session).
- **Two surfaces, one core:** a CLI for humans/scripts and setup, and an MCP
  server for agents that prefer tool calls.

## Install

```bash
bun install
bun link          # puts `mdmem` on your PATH
```

Run `mdmem` from inside your project. The hooks and MCP server that
`mdmem enable claude-code` and `mdmem enable bob` write (see
[Claude Code](#claude-code) and [IBM Bob](#ibm-bob)) also expect `mdmem` on
your PATH.

## Quickstart

```bash
mdmem init                  # create .memory/ at the project's root
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
| `mdmem init` | Create `.memory/` at the project's root, or report the existing store |
| `mdmem add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a memory; refuses an existing name unless `--force`, and refuses a `--force` overwrite if the memory changes while it is saved. Body may also be piped via stdin. |
| `mdmem list` | Print the memory index (`MEMORY.md`) |
| `mdmem read <name>` | Print one memory by its name (or `<name>.md`), or the index (`MEMORY.md`) |
| `mdmem edit <name>` | Edit a copy of a memory in `$VISUAL`/`$EDITOR`, then save it back and reindex |
| `mdmem delete` (alias `rm`) `<name>` | Remove a memory by its name (or `<name>.md`) |
| `mdmem search <query>` | Find memories containing text |
| `mdmem reindex` | Bring `MEMORY.md` up to date with the memories, keeping its other lines |
| `mdmem consolidate` | Print the consolidation prompt (see below) |
| `mdmem doctor` (alias `check`) | Check the store: parse errors, name≠filename, conflicting types, secrets, pointers over 150 characters, dangling `[[links]]`, stale index (a memory without a pointer, a pointer to a missing file, a duplicate pointer), index over 9,500 characters, the size a session-start hook can inject |
| `mdmem enable <agent…> \| --all [--prefer claude\|mdmem]` | Wire an agent to the shared store; running it again changes nothing. `--prefer` settles a Claude Code import conflict. |
| `mdmem disable <agent…> \| --all` | Remove exactly mdmem's entries from an agent's files (leaves the store) |
| `mdmem status` | Show the store and each agent's wiring, entry by entry (present or missing) |
| `mdmem path` | Print the store directory |
| `mdmem mcp` | Run the MCP server over stdio |
| `mdmem hook <agent> <part>` | Run by an agent's session-start hook, not typed by hand (see below) |

Agents: `claude-code`, `agents`, `bob`, `cursor`. Memory types: `user`, `feedback`, `project`, `reference`.

`mdmem hook` is what the agents' session-start hooks run: `<agent>` is
`claude-code`, `bob` or `codex`, and `<part>` is `protocol` (the memory protocol)
or `index` (a line naming the store's absolute path, the check's warnings for
unparseable memories and a stale index, then `MEMORY.md`). It reads the hook's
JSON payload on stdin, resolves the store from the payload's `cwd` (else the
working directory), and prints the
part as SessionStart context, each under 10,000 characters: warnings past that are
counted instead of listed, and an index over its limit is cut short with a note to
`memory_read` the rest and run a consolidation. It prints nothing outside a
project with a store, on a resumed session, or for any event but SessionStart; empty
stdin counts as an empty payload, so run by hand it prints nothing. It never fails a
session: an error becomes a one-line context saying why the memory
could not be loaded, and it exits 0.

`mdmem edit` saves the copy back the way `add` saves a memory, so an edit that is
not a valid memory, holds a secret, or races another change to the memory is
refused: the store stays as it was, and the command prints where the copy is
kept so the edit is not lost. With no `$VISUAL`/`$EDITOR` set, `mdmem edit`
prints the memory's path instead of opening it — edit it by hand, then run
`mdmem reindex`.

A memory that does not parse locks no one out. `search` and `status` answer
from the memories that do and warn about the broken one on stderr. `reindex` and
every save or delete update the index anyway: the broken memory keeps the pointer
it has, gets none if it has none, and each one is named in a warning. `doctor`
reports it with the store's other problems.

## Claude Code

`mdmem enable claude-code` does three things, in this order:

1. It imports the memories Claude Code kept for the repository
   (`~/.claude/projects/<key>/memory/`, and the directory of each of the
   repository's worktrees) into `.memory/`, backing the store up first. A file
   that exists on both sides with different content stops the command before
   anything is written; it lists each conflict, and `--prefer claude` or
   `--prefer mdmem` settles them. The import runs once per user and repository:
   mdmem records it in `~/.claude/projects/<key>/mdmem-imported`, so a later
   `enable` skips it, neither refusing again over files settled with `--prefer`
   nor bringing back a memory you have deleted since.
2. It merges these entries into `.claude/settings.json`, leaving its other
   keys, and their order and indentation, as they were:
   - `"autoMemoryEnabled": false`, which turns Claude's own memory off for the
     project;
   - two `SessionStart` hooks, matcher `startup|clear|compact`, running
     `mdmem hook claude-code protocol` and `mdmem hook claude-code index`;
   - `"permissions": {"allow": ["mcp__mdmem"]}`, so the mdmem tools run without
     asking.
3. It merges the mdmem server into `.mcp.json`:
   `"mcpServers": {"mdmem": {"type": "stdio", "command": "mdmem", "args": ["mcp"]}}`.

Commit both files: they wire Claude Code for everyone working in the
repository, and everyone then needs `mdmem` on PATH. `mdmem disable claude-code`
removes exactly these entries, along with an object or array they leave empty
(an empty `"permissions": {}` you had before goes too), and deletes a file that
held nothing else; the imported memories stay in `.memory/`. `mdmem status` lists each entry as present
or missing.

Claude Code asks each user to approve a server from a project's `.mcp.json`
before it connects it; until then the mdmem tools are missing and agents fall
back to writing files directly. Approving it in that dialog writes
`"enabledMcpjsonServers": ["mdmem"]` to your `.claude/settings.local.json`. The
same key in the committed `.claude/settings.json` skips the dialog, but only in
a folder whose trust dialog you have accepted: in an untrusted folder Claude Code
ignores the repository's own approval. `mdmem enable` does not write that key.
Checked with `claude mcp list` on Claude Code 2.1.302 against an isolated
config directory, and against the
[settings reference](https://code.claude.com/docs/en/settings-reference): with
the key in the project settings of a trusted folder the server connects; without
it, or in an untrusted folder, it stays pending approval. A `claude -p` run
connects project servers without asking, approved or not.

## IBM Bob

`mdmem enable bob` merges two entries into Bob's workspace files, leaving their
other keys, and their order and indentation, as they were:

- in `.bob/settings.json`, one `SessionStart` hook group, matcher
  `^(startup|compact)$` (a new session and compaction, not a resume), with two
  command handlers, `mdmem hook bob protocol` and `mdmem hook bob index`, each
  with a 10-second timeout. Bob validates hooks strictly, so a single unknown
  key voids the whole `hooks` block: the group holds only documented fields.
- in `.bob/mcp.json`, the mdmem server:
  `"mcpServers": {"mdmem": {"command": "mdmem", "args": ["mcp"]}}`.

Commit both files: they wire Bob for everyone working in the repository, and
everyone then needs `mdmem` on PATH. `mdmem disable bob` removes exactly these
entries, along with an object or array they leave empty, and deletes a file that
held nothing else. `mdmem status` lists each entry as present or missing.

Bob runs workspace hooks and MCP servers only in a trusted folder; in an
untrusted one neither runs. Bob also reads both `.bob/settings.json` (the
hooks) and `.bob/mcp.json` only from its workspace, the folder it was launched
in: launched at a checkout's root it gets the protocol, the index and the mdmem
tools; launched in a subdirectory it has no memory wiring at all.

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

mdmem reads memories as loosely as Claude Code writes them: any non-empty name,
the type under `metadata` or at the top level (`metadata.type` wins when both are
set), and unknown fields, which it keeps. What it writes (`add`, `edit`,
`memory_write`) is strict: the name must equal the file name without `.md`, in
kebab-case or snake_case, so a memory whose name differs from its file must have
its name fixed before mdmem saves it. `doctor` reports a name that differs from
its file name and two types that disagree; a `[[link]]` resolves to a memory's
name or its file name.

## MCP server

For agents that call tools instead of reading files, `mdmem mcp` runs a stdio
server with the same memory-store tools as Claude Code, plus three of its own:

| Tool | Purpose |
|---|---|
| `memory_list` | With no arguments, list the stores: mdmem serves one, named after the project directory, with `MEMORY.md` as its index. With `store`, list its documents by path, with size and last-updated date. `path_prefix` filters by path; `cursor` continues a long listing. |
| `memory_read` | Read one document by `path` (`prefers-bun.md`, or the index `MEMORY.md`), with its version token. |
| `memory_write` | Write a whole memory document at `path`. The content must be a valid memory whose name matches its file name, in kebab-case or snake_case. `MEMORY.md`, paths inside a directory, and content that looks like it holds a secret are refused. |
| `memory_delete` | Delete a memory document at `path`. `MEMORY.md` is refused. |
| `memory_search` | List the memories containing a query, by path with their description. A memory that does not parse is skipped and named in a warning. |
| `memory_check` | Check the store as `mdmem doctor` does, returning the same text: the problems one per line, or the memory count and no problems. |

`store` is optional everywhere: leave it out to use the project's store. An
unknown store id is an error that names the valid one. `memory_write` and
`memory_delete` require `if_version`, the version token from your last
`memory_read` or `memory_write` of that path. For a file that doesn't exist yet,
`memory_write` takes the literal `new`. When the document has changed since that
version, or `new` names a file that already exists, the call is rejected and
returns the current content and version, so the agent can merge and retry. Both
tools update `MEMORY.md` afterwards.

The server also serves one prompt, `consolidate` (see below).

Claude Code: `mdmem enable claude-code` registers it in `.mcp.json` (see
[Claude Code](#claude-code)).

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
