# mdmem reference

The detail behind the [README](../README.md): where the store is, how mdmem
keeps the index, the memory format, every command, what `mdmem status` and the
check report, the files each agent's wiring writes, the MCP tools, and what the
consolidation prompt tells an agent.

To share a store or the wiring through git, see
[Sharing mdmem with a team](team.md). For an agent with no memory, see
[Troubleshooting](troubleshooting.md).

## Where the store is

A project has one store. It holds the Markdown memories, the `MEMORY.md` index
and a `project` file naming the root the store serves. The `project` file is
not a memory: the check and the listings skip it.

The store has one of two placements
([ADR 0005](adr/0005-home-store-by-default-local-store-on-purpose.md)):

- **The home store**, the default: `~/.mdmem/<key>/`. The key is the project's
  root path with every character that is not an ASCII letter or digit turned
  into `-`, as Claude Code names its directories under `~/.claude/projects/`.
  A key over 200 characters is cut and followed by a hash.
- **The local store**: `.mdmem/` at the project's root, created only on purpose
  with `mdmem store local`, for a team that commits it.

The hooks, the MCP server and the CLI resolve the store by one rule: the local
store when `<root>/.mdmem/` exists, else the home store. The root is:

- **In git**, the main checkout's directory, the parent of the git common dir.
  Every linked worktree, subdirectory and submodule uses that one store, and a
  `.mdmem/` lower down is ignored. A bare repository's root is the directory
  holding it as `.git`, or the bare `x.git` itself.
- **Without git**, the working directory itself, with no walk-up. A session in
  a subdirectory is its own project, with its own home store, as in Claude
  Code. In your home directory, `~/.mdmem` holds the home stores, so the home
  directory's project always has a home store.

### Before the first save

The first save creates the store. With no store yet, the first memory write
(`memory_write` from an agent, or `mdmem add`) creates the home store, with its
`MEMORY.md` and `project` file, and says so.

Until then, listing and searching find no memories, and `mdmem list` names the
home store the first save creates. Reading, editing or deleting a memory
refuses, as do `mdmem path`, `mdmem reindex` and `mdmem consolidate`; each
refusal names that home store. `mdmem status`, `mdmem store` and the hook name
it too.

### Moving the store

`mdmem store` prints `Store: home, <path>`, `Store: local, <path>`, or
`Store: none yet; the first save creates the home store <path>`.

`mdmem store local` moves the home store to `<root>/.mdmem/`, or creates an
empty local store when there is none. `mdmem store home` moves a local store
back. A move writes the store's `project` file, naming this project's root, and
prints both paths, the new store line and the command that moves the store
back. When the store is already there, or `mdmem store local` creates it, the
command prints one path and that command.

Both refuse when the destination already holds memories, and name the other
store. Fold one into the other first, with `mdmem consolidate --from <dir>`. A
destination that holds no memories, only its index, is replaced.

`mdmem store local` also refuses in two places, where the project keeps its
home store:

- In the home directory, where `~/.mdmem` holds the home stores.
- In a repository whose root is its git directory, one not named `.git`: a bare
  `x.git`, a worktree of one, or a work tree made with `--separate-git-dir`.
  `.mdmem/` there would be in no work tree, so it could never be committed.

Beside a bare repository at `<dir>/.git`, the local store is `<dir>/.mdmem/`.

`mdmem store list` prints every home store, one line each: its key, the project
its `project` file names (or `no project file`), its memory count, and
`project missing` when that directory no longer exists. mdmem never deletes a
home store on its own.

When both placements hold memories, the local store wins. `mdmem status` warns
that the home store's memories go unread, and names the command that folds them
in.

mdmem never edits `.gitignore`: ignoring or committing a local store is your
choice. `mdmem store local` and `mdmem status` say when git does not ignore
`.mdmem/`. Committing it suits projects without worktrees, because each linked
worktree would also check out a copy of `.mdmem/`, which mdmem ignores there.

## How mdmem keeps the index

Agents only ever write their own memory files. After every save or delete
through mdmem, and on `mdmem reindex`, mdmem updates `MEMORY.md` in place:

- It appends a pointer for a memory that has none, and removes pointers to
  missing files and duplicate pointers.
- It keeps descriptions current. A pointer in mdmem's form (titled with its
  memory's name, then ` — `) takes the memory's description whenever it
  differs, so a direct edit reaches the index. Any other pointer, written by
  hand or by Claude Code, takes a new description only when a save of its
  memory through mdmem changes it, or finds no ` — ` on it.
- It keeps every other line (a title, headings, prose, a pointer's own title),
  so an index written by hand or by Claude Code survives.

When an agent writes a memory file directly, run `mdmem reindex` to refresh the
index, or let the next `add` or MCP write do it.

### The header of a new index

A store mdmem creates, on the first memory write or with `mdmem store local`,
opens its index with a header. It is an HTML comment, hidden where Markdown
renders, for an agent or a person who opens the directory without the mdmem
tools:

```markdown
<!-- mdmem: this directory is the shared agent memory of the project at /path/to/project.
Read this index, then the memory files you need. Save with `mdmem add` or the
mdmem MCP tool memory_write; after editing a file by hand run `mdmem reindex`.
`mdmem status` shows whether your agent is wired, `mdmem --help` the rest. -->
```

The session-start hook leaves the header out of what it injects, since a wired
session already holds the memory protocol. In the file, the header counts
toward the index's 9,500 characters. mdmem writes it once.
`reindex` keeps it like any other line and never adds it to a store without
one, and a move between placements keeps it.

### A memory that does not parse

A memory that does not parse locks no one out:

- `search` answers from the memories that do parse, and warns about the broken
  one on stderr.
- `status` counts the memories that parse, and counts the broken ones in its
  `Check:` line.
- `reindex` and every save or delete update the index anyway. The broken
  memory keeps the pointer it has, gets none if it has none, and is named in a
  warning.
- `doctor` reports it with the store's other problems.

## Memory format

The format is Claude Code's: one fact per file, `<name>.md` in the store, with
frontmatter holding `name`, `description` and the type.

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

The types are `user`, `feedback`, `project` and `reference`. `feedback` and
`project` memories add `**Why:**` and `**How to apply:**` lines. Link related
memories with `[[name]]`. A link may name a memory not written yet, as
`[[ts7-strict]]` does here: it marks a memory worth writing.

`MEMORY.md` holds one pointer per memory:
`- [uses-bun](uses-bun.md) — This project uses bun, not node`.

mdmem reads memories as loosely as Claude Code writes them: any non-empty name,
the type under `metadata` or at the top level (`metadata.type` wins when both
are set), and unknown fields, which it keeps.

What mdmem writes (`add`, `edit`, `memory_write`) is strict: the name must
equal the file name without `.md`, in kebab-case or snake_case. A memory whose
name differs from its file must have its name fixed before mdmem saves it.

`doctor` reports a name that differs from its file name, and two types that
disagree. A `[[link]]` resolves to a memory's name or its file name; one that
resolves to neither is a note.

## Commands

The CLI is for you, your scripts and setup. The MCP server, on the same core,
is for the agents. `mdmem --help` lists the commands by who runs them:

- setting up and looking after a project: `enable`, `disable`, `status`,
  `store`, `doctor`, `consolidate`;
- working with memories: `add`, `read`, `edit`, `delete`, `list`, `search`,
  `reindex`, `path`;
- run by the agents: `hook`, `mcp`.

`mdmem <command> --help` (or `-h`, or `mdmem help <command>`) prints one
command's usage, options, an example and the refusals it can give.

To save a memory from the shell:

```bash
mdmem add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."
```

| Command | Purpose |
|---|---|
| `mdmem add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a memory. The body may also be piped on stdin. With no store yet, `add` creates one first: the home store, unless a local store exists. It refuses an existing name unless `--force`, and refuses a `--force` overwrite if the memory changes while it is saved. |
| `mdmem list` | Print the memory index, `MEMORY.md`. |
| `mdmem read <name>` | Print one memory by its name (or `<name>.md`), or the index (`MEMORY.md`). |
| `mdmem edit <name>` | Edit a copy of a memory in `$VISUAL` or `$EDITOR`, then save it back and reindex (see [mdmem edit](#mdmem-edit)). |
| `mdmem delete` (alias `rm`) `<name>` | Remove a memory by its name (or `<name>.md`). |
| `mdmem search <word>...` | Find the memories whose name, description, headings or body hold the words of the query, best match first. The arguments are the words, quoted or not. Each word is stemmed and matched on its own; quote text to require it as an exact phrase; common function words are ignored. |
| `mdmem reindex` | Bring `MEMORY.md` up to date with the memories, keeping its other lines. |
| `mdmem consolidate [--agent <agent>] [--from <dir>]` | Print the consolidation prompt. `--agent` points it at that agent's past sessions of the project, `--from` at a second store to fold in (see [Consolidation](#consolidation)). |
| `mdmem doctor` (alias `check`) | Check the store and the agents' wiring in both scopes, and exit 1 on a problem (see [mdmem doctor](#mdmem-doctor)). |
| `mdmem enable <agent…> \| --all [--project]` | Wire an agent in its user-wide files (the global scope), or with `--project` in the repository's files. It creates no store, and running it again changes nothing. `--all` wires the agents found on this machine (see [enable and disable](#enable-and-disable)). |
| `mdmem disable <agent…> \| --all [--project]` | Remove exactly mdmem's entries from an agent's user-wide files, or with `--project` from the repository's. It leaves the store and needs none. `--all` takes the agents found on this machine. |
| `mdmem status` | Show the store and its placement (or the home store the first save creates), the check in one line, and each agent's wiring in each scope, entry by entry (present or missing), with the warnings and notes below. A scope with no entry present is one line, `not wired`. |
| `mdmem store [local \| home \| list]` | Print the store's placement and path, move it to the other placement, or list every home store (see [Moving the store](#moving-the-store)). |
| `mdmem path` | Print the store directory, home or local. |
| `mdmem version` (also `--version`, `-v`, `-V`) | Print `mdmem` and its version, the one the MCP server reports. |
| `mdmem mcp` | Run the MCP server over stdio. |
| `mdmem hook <agent> <part> [--global]` | Run by an agent's hooks, not typed by hand (see [mdmem hook](#mdmem-hook)). |

Agents: `claude-code`, `bob`, `codex`. Memory types: `user`, `feedback`,
`project`, `reference`.

### mdmem doctor

`mdmem doctor` prints a line naming the store and its placement, then its
findings. With no store, it checks the wiring alone. It exits 1 on a problem.

In the store, a problem is:

- a memory that does not parse;
- a name that differs from its file name;
- two types that disagree;
- a secret;
- a pointer over 150 characters;
- a stale index: a memory without a pointer, a pointer to a missing file, a
  duplicate pointer, or a pointer in mdmem's form (titled with its memory's
  name, then ` — `) whose description differs from the memory's;
- an index over 9,500 characters, the size a session-start hook can inject.

In the wiring, the problems are those listed in
[What status and the check report](#what-status-and-the-check-report).

Two findings are notes, not problems: a `[[link]]` to a memory not written yet,
and an agent wired in both scopes. `doctor` lists each note
(`note: uses-bun.md links [[ts7-strict]], not written yet`) and exits 0 when
notes are its only findings.

### enable and disable

`mdmem enable` wires each agent in its own native way:

- two session-start hooks inject the memory protocol and the store's index;
- a per-prompt hook points the agent, before each prompt, at the memories that
  changed or bear on it;
- the mdmem MCP server gives the agent its memory tools.

Only agents with session-start hooks are supported. The wiring goes in one of
two scopes
([ADR 0004](adr/0004-two-wiring-scopes-store-on-first-save.md)):

- **global**, the default: the agent's user-wide files, so it works in every
  repository on your machine with no setup per project;
- **project**, with `--project`: files committed with one repository, so
  everyone who clones it is wired.

| Agent | Global scope writes | `--project` writes | Approvals mdmem cannot give for you |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json`, `~/.claude.json` | `.claude/settings.json`, `.mcp.json` | project scope: trust the folder, approve the project's mdmem server |
| Codex CLI | `~/.codex/hooks.json`, `~/.codex/config.toml` | `.codex/hooks.json`, `.codex/config.toml` | review the hooks once (project scope: once per clone, interactively); project scope: trust the folder |
| IBM Bob | `~/.bob/settings/settings.json`, `~/.bob/settings/mcp.json` | `.bob/settings.json`, `.bob/mcp.json` | project scope: trust the folder, launch Bob at the repository's root |

**Which agents `--all` takes.** `--all` counts an agent as found on this
machine when its command is on PATH (`claude`, `bob`, `codex`) or its config
directory exists: `~/.claude`, or `$CLAUDE_CONFIG_DIR` when set; `~/.bob`;
`~/.codex`, or `$CODEX_HOME` when set. It prints the agents it skipped. Naming
an agent wires it whether it is found or not. `disable --all` likewise acts
only on the agents found, so wiring for an agent not on this machine stays
until you name it. `--all` and agent names do not combine.

**Nothing is written on a refusal.** `enable` and `disable` check every agent
name and read every file they would change before writing any. An unknown agent
or a file that does not parse stops the command with no file written.

**Where each scope runs.** The global scope runs anywhere. `enable --project`
runs in a work tree, or outside git in the working directory, which is then the
project. It refuses in two places:

- In a bare repository, or the folder holding one as `.git`. It names the
  repository's worktrees, since agents read their files only from a work tree.
- In your home directory, which the global scope wires: there Claude Code's and
  Codex's project files are, by default, the global scope's own.
  `enable --project` and `disable --project` say to run the command without
  `--project`, and `mdmem status` shows the global scope only.

**No store needed.** Neither command creates a store, and `disable` needs none,
so it works after the store was deleted.

**The hook entries.** Each scope's wiring holds three hook entries per agent,
in the same file:

- two on SessionStart, running `mdmem hook <agent> protocol` and
  `mdmem hook <agent> index`;
- the per-prompt hook on UserPromptSubmit, running `mdmem hook <agent> prompt`.

In the global scope each command is followed by `--global`. Every agent gets
all three, and none can be left out. `mdmem status` lists the prompt entry as
`UserPromptSubmit hook "mdmem hook <agent> prompt"`, and an agent counts as
wired in a scope only with all three present. A wiring made before the prompt
entry existed shows it missing; running `mdmem enable` again adds only that
entry. `disable` removes it with the rest, and leaves the session state under
`~/.cache/mdmem` as it is.

**Both scopes.** A repository may be wired in both scopes, by different people.
Each session still gets the protocol and the index once, and the agent runs one
mdmem server.

### mdmem hook

`mdmem hook <agent> <part>` is what the agents' hooks run. `<agent>` is
`claude-code`, `bob` or `codex`. `<part>` is one of:

- `protocol`: the memory protocol.
- `index`: a line naming the store's placement and absolute path
  (`Store: home, <path>` or `Store: local, <path>`), the check's warnings for
  unparseable memories and a stale index, then `MEMORY.md`.
- `prompt`: the per-prompt block, described below.

The hook reads the agent's JSON payload on stdin, resolves the store from the
payload's `cwd` (else the working directory), and prints the part as context on
its event:

- SessionStart for `protocol` and `index`, each under 10,000 characters.
  Warnings past that size are counted instead of listed. An index over its
  limit is cut short, with a note to `memory_read` the rest and tell the user
  that a consolidation is due.
- UserPromptSubmit for `prompt`, under 4,000 characters.

The hook speaks in every directory, git or not, store or not. With no store
yet, the index part is the line
`Store: none yet; the first memory_write creates the home store <path>/ with MEMORY.md.`

**`--global`.** `--global` marks the global scope's hook entries. A global
entry prints nothing where the project's own entry for the same part is
present, so a repository wired in both scopes gets each part once. A project's
server registration alone does not count. Claude Code's global entry prints
nothing there only in a folder Claude Code trusts (see
[Trust, subdirectories and server approval](#trust-subdirectories-and-server-approval)).
Elsewhere it speaks, since the project's hooks do not run, and says why on
stderr.

**When the hook prints nothing.** The hook prints nothing:

- on a resumed or forked session;
- for any event but its part's own;
- with no payload on stdin, as when it is run by hand;
- as a global entry beside the project's own;
- for the `prompt` part, when the payload has no `session_id`, or the prompt
  has nothing to say.

Each time, it writes one line on stderr saying why, which never reaches the
agent's context. With no payload, that line gives the
`echo '<payload>' | mdmem hook <agent> <part>` command that shows what the hook
would inject in the working directory. For a global entry, it names the
project's settings or hooks file. Where Claude Code's global entry speaks
beside the project's own in a folder it does not trust, it writes one line on
stderr too, naming the user config that records no trust for the folder.

**Errors.** A payload that is not a JSON object is reported where the hook
would speak from the working directory, which is everywhere but where its
agent's silences apply. The hook never fails a session: an error becomes a
one-line context saying why the memory could not be loaded, and it exits 0.

#### The session's state

Where the index part speaks for a payload with a `session_id`, it first writes
the session's state, a cache the `prompt` part reads. The file is
`$XDG_CACHE_HOME/mdmem/sessions/<agent>/<session_id>.json` when
`XDG_CACHE_HOME` is set to an absolute path, else under
`~/.cache/mdmem/sessions/`. A child session whose payload carries `agent_id`
gets `<agent>/<session_id>/<agent_id>.json`.

The file names the store's directory and holds:

- a snapshot of its memories: each file's content hash, size and mtime, the
  index left out;
- the injection time;
- the hits already shown, none at the start.

A session started by startup, clear or compact gets a fresh file. A resumed one
keeps its own, since the hook is silent then. A file that cannot be read or
parsed, or that names another store's directory (after `mdmem store local` or
`mdmem store home`), is replaced without being read.

Each of the index part's writes removes the session files older than 30 days by
mtime, and the session directories that leaves empty. Nothing else prunes the
directory. It lies outside every store, so `mdmem store list` never sees it. A
state the hook cannot write leaves its output as it is, with one line on stderr
saying why.

#### The per-prompt block

The `prompt` part runs before each user prompt, on UserPromptSubmit, and
injects pointers only, never a memory's body. `mdmem enable` wires it in every
agent and scope, under `hooks.UserPromptSubmit` (see each agent's section
below).

The part reads the session's state, compares the store with its snapshot (by
size and mtime, then by content hash), and searches the store with the
payload's `prompt` text. It prints
`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<block>"}}`,
the same for all three agents. The block has two sections, each left out when
it has nothing to say:

```
Memory changes since your last prompt:
- [codex-hook-review](codex-hook-review.md) — Codex reviews a project hook once per path (new)
- old-note.md (deleted)
Memories that may bear on this prompt, open with memory_read:
- [workflow-run-records](workflow-run-records.md) — where Workflow runs persist
```

- **The changes** list each memory added (new), updated (updated) or deleted
  (deleted, as its file name) since the session's last prompt, at most 20, then
  one line counting the rest and saying to `memory_read` `MEMORY.md`.
- **The hits** are the memories the search of `memory_search` finds for the
  prompt's whole text, with its stop list, above a relevance floor, and at 60%
  of the top hit's score or more. A memory already shown as a hit in the
  session, or listed in the changes, is left out. At most 5 remain.
- **Each pointer** is the index's own line for the memory, else the line
  `reindex` would write, cut to 150 characters.
- **The block** stays under 4,000 characters. Change lines that do not fit
  beside the hits are counted in the last line of the changes.

A session's first prompt with no state file takes the store's snapshot and gets
hits only. That includes a child session's, whose payload carries `agent_id`.
Each prompt writes the state, the new snapshot and the hits it shows, before
printing, even when it prints nothing.

The part prints nothing, and says why on stderr, in three cases:

- the payload names no `session_id`;
- its `--global` entry defers to the project's own `prompt` entry, by the rule
  above;
- nothing changed and no memory bears on the prompt.

Only the last case writes the state. A `session_id` that cannot name a file
leaves the part injecting hits only, with one line on stderr. With no store
yet, the part prints nothing and writes a state naming the home store to come,
with an empty snapshot.

The part keeps no cache and no index between prompts: reading and ranking the
store takes about 0.1 s at 200 memories.

### mdmem edit

`mdmem edit` saves the copy back the way `add` saves a memory. An edit that is
not a valid memory, holds a secret, or races another change to the memory is
refused: the store stays as it was, and the command prints where the copy is
kept, so the edit is not lost.

With no `$VISUAL` or `$EDITOR` set, `mdmem edit` prints the memory's path
instead of opening it. Edit the file by hand, then run `mdmem reindex`.

## The memory protocol

The memory protocol is what the `protocol` hook injects. It adapts Claude
Code's own memory instructions to the shared store. It covers:

- the memory format and types, and what to save and what not to;
- checking a recalled memory before acting on it, and checking any claim it
  makes about an external tool, library or service before acting on it or
  repeating it;
- naming the memory an answer comes from;
- saving through the MCP tools, and writing files directly only when an agent
  lacks them;
- loading every mdmem tool in one request, where the agent loads tools on
  demand;
- the store as the primary place for project knowledge and what the user wants,
  saved unasked, while a memory the agent's harness keeps of its own holds what
  is about the agent and its sessions, under that harness's rules for when to
  update it;
- precedence: the user's current instructions and verified facts over any
  memory, and the store over older notes in the harness's memory on anything
  about the project;
- a changed-on-disk notice for a file in the store right after a
  `memory_write`: it is that write.

It also names the store's path, for writing memory files without the tools, and
says that a sandboxed agent may not reach a home store without them, in which
case the agent tells the user.

The text lives in `templates/memory-protocol.md` and is easy to edit. A test
keeps it at 6,000 characters at most, about three times Claude Code's own
memory block, since every wired agent reads it at every session start, `/clear`
and compaction.

## What status and the check report

Hooks that do not run leave an agent without the protocol and the index, and
mdmem has no fallback. So `mdmem status` and the check (`mdmem doctor`,
`memory_check`) report the states that silently break sharing.

Both read each agent's wiring in both scopes. They work without a store and
outside any project, where they report the wiring alone.

An agent counts as **enabled** in a scope when some of mdmem's entries there
are present, and as **wired** when every entry of at least one scope is
present. An agent wired in both scopes is a note, not a problem. It appears
under the agent in `status` and among the check's notes, and `doctor` lists it
and exits 0: where the agent's project hooks run, its global ones stay silent,
so a session gets the protocol and the index once.

### Problems

A state that breaks saving or injection, and that you can fix, is a check
problem: `doctor` lists it and exits 1, and `status` prints it as a warning.

- **An agent's config file that exists but cannot be read**: not valid JSON or
  TOML, or JSON that is not an object. The problem names the file and why it
  cannot be read, and replaces the missing entries and other problems that file
  would give. Fix it, then run the check again.
  - A project file is reported whether or not the agent is enabled, since
    mdmem cannot tell what it wires: `.claude/settings.json`,
    `.claude/settings.local.json`, `.mcp.json`, `.bob/settings.json`,
    `.bob/mcp.json`, `.codex/hooks.json`, `.codex/config.toml`.
  - A user-wide file is reported only for an agent enabled in some scope;
    otherwise `status` warns of it. These are Claude Code's user settings and
    `.claude.json`, Bob's `~/.bob/settings/` files, and Codex's `hooks.json`
    and `config.toml`. `memory_check` called from Codex leaves Codex's out, as
    it leaves out its global hooks below.
  - `mdmem enable` reads every file holding a scope's entries and refuses any
    that cannot be read. So while one cannot be read, the agent's other
    problems that `enable` fixes in that scope say to fix that file first.
    `enable` does not read `.claude/settings.local.json`: while only that file
    cannot be read, the agent's other problems still say to run `mdmem enable`.
- **A hook missing in a scope the agent is enabled in.** The fix names that
  scope's command: `mdmem enable <agent>`, or with `--project`. When the prompt
  entry is the only one missing, as in a wiring made before it existed, the
  problem says the agent's sessions are not told at each prompt which memories
  changed or bear on the prompt. When a session-start entry is missing too, it
  says they start without what those hooks inject.

  `memory_check` called from Codex leaves Codex's user files out unless
  `CODEX_HOME` reaches the server. Codex starts MCP servers with only a few
  environment variables (`HOME`, `PATH` and the like, not `CODEX_HOME`), so the
  server cannot tell where Codex's home is. Listing it in the server's table,
  as `env_vars = ["CODEX_HOME"]` under `[mcp_servers.mdmem]`, brings the check
  back. `mdmem doctor` and `mdmem status` always check it.
- **Bob's hooks switched off**: `disableWorkspaceHooks: true` in
  `.bob/settings.json` where Bob is enabled in the project scope,
  `disableGlobalHooks: true` in `~/.bob/settings/settings.json` where it is
  enabled in the global scope, or `"disabled": true` on one of mdmem's handlers
  in either file, which Bob's Settings writes when you switch a hook off. The
  problem says to remove the setting or the flag.
- **Claude Code's hooks switched off**: `disableAllHooks: true` where Claude
  Code reads it first, as below.
- **Claude Code's auto memory still on** where Claude Code is enabled:
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to `0`, `false`, `no` or `off` in the
  environment, or `autoMemoryEnabled` not `false` where Claude Code reads it
  first (`.claude/settings.local.json`, then `.claude/settings.json`, then your
  user settings). A project's `true` overrides your user settings' `false`, so
  the global scope reports it too. Managed settings are not read.
- **`mdmem` not on PATH** while an agent is wired: its hooks and MCP server run
  it.

### Status lines only

The rest are `status` lines only, because they are your choice, depend on where
`status` runs, or are something mdmem does not read:

- **`Check:`**, the check in one line: no problems, or how many, naming
  unparseable memories, a stale `MEMORY.md` and a `MEMORY.md` over its limit,
  then how many notes (links to memories not written yet, and agents wired in
  both scopes).
- **A note when git does not ignore a local store's `.mdmem/`.** mdmem never
  edits `.gitignore`, and a home store needs no note.
- **A warning when a local store hides a home store that holds memories.** No
  agent reads them while `.mdmem/` exists, and the warning names
  `mdmem consolidate --from <home store>`.
- **A warning below the root of a project wired for Bob in the project scope**,
  unless the global scope holds both its session-start hooks and its server. A
  Bob launched there reads neither `.bob/settings.json` nor `.bob/mcp.json`, so
  it gets only what the global scope holds. The warning names what is missing:
  no mdmem tools when the global scope holds the session-start hooks but not
  the server, no protocol and no index when it holds the server but not the
  session-start hooks, and all three when it holds neither. Whether the global
  scope holds its per-prompt hook makes no difference to this warning. It says
  to launch Bob at the root or run `mdmem enable bob`.
- **A warning below the root of a project wired for Claude Code in the project
  scope**, with neither of mdmem's session-start hooks in your user settings. A
  Claude Code started there does not read the project's
  `.claude/settings.json`, so it gets no protocol and no index, and keeps its
  auto memory on unless your user settings turn it off.
- **A warning in a submodule of a project whose files wire an agent that the
  submodule's files do not.** The submodule shares the project's store, but an
  agent started there reads the submodule's own files, so it gets no protocol,
  no index and no mdmem tools. Claude Code applies the submodule's settings,
  not the project's, so mdmem's setting that turns its auto memory off does not
  apply there.
- **A note under each agent enabled in the project scope on folder trust**,
  which decides whether its project files run, and under Codex in either scope
  on its review of the hooks. mdmem checks neither.

## Claude Code

`mdmem enable claude-code` merges these entries into Claude Code's files,
leaving their other keys, and their order and indentation, as they were. The
global scope writes your user settings, `~/.claude/settings.json`, and your
user config, `~/.claude.json` (both in `$CLAUDE_CONFIG_DIR` when it is set).
`--project` writes the repository's `.claude/settings.json` and `.mcp.json`.

- In the settings:
  - `"autoMemoryEnabled": false`, which turns Claude's own memory off: on the
    whole machine in the global scope, for the repository in the project scope;
  - two `SessionStart` hooks, matcher `startup|clear|compact`, running
    `mdmem hook claude-code protocol` and `mdmem hook claude-code index`, each
    followed by `--global` in the global scope;
  - one `UserPromptSubmit` hook with no matcher, which the event does not
    support, running `mdmem hook claude-code prompt` (`--global` in the global
    scope);
  - `"permissions": {"allow": ["mcp__mdmem"]}`, so the mdmem tools run without
    asking.
- The mdmem server,
  `"mcpServers": {"mdmem": {"type": "stdio", "command": "mdmem", "args": ["mcp"]}}`,
  at the top level of `~/.claude.json` (Claude Code's user-scope servers), or
  in `.mcp.json`.

`mdmem disable claude-code` (with `--project` for the repository's files)
removes exactly these entries, along with an object or array they leave empty
(an empty `"permissions": {}` you had before goes too), and deletes a file that
held nothing else. The imported memories stay in the store. `mdmem status`
lists each entry of each scope as present or missing.

**Entries you edit stay mdmem's.** A hook stays mdmem's while it runs mdmem's
command, and the server while it runs `mdmem mcp`. A field you add to either (a
hook's `timeout`, say) counts as wired, is kept by `enable` and goes with the
entry on `disable`. A handler of your own in mdmem's hook group stays:
`disable` takes out only mdmem's handlers, and the group goes once it holds no
other.

**A key holding something else makes `enable` refuse** before it writes
anything, naming the file and the key. Examples are an `mcpServers.mdmem`
running another command (`bun run …/src/cli/index.ts mcp` included) or
`"autoMemoryEnabled": true`. `disable` leaves that key alone.

### Importing Claude Code's memories

mdmem imports the memories Claude Code kept for a project when the project's
store is created, by the first save or by `mdmem store local`, in either
placement, where Claude Code is enabled in either scope. The creating command
lists what it copied.

The sources are `~/.claude/projects/<key>/memory/` and the directory of each of
the repository's worktrees, which mdmem never changes:

- A memory held by one directory is copied.
- Identical memories are kept once.
- When two directories hold different versions of a file, the version in the
  repository's own directory is copied, and the others are listed as left in
  Claude's directories.

A memory whose `name` differs from its file name (`team-lead.md` holding
`name: Team Lead`) is stored with the file name as its name, so `mdmem doctor`
passes. It is listed under "Renamed to match the file name:", and its title in
`MEMORY.md` stays as Claude wrote it. A memory that does not parse, or whose
name the import cannot rewrite, is copied as it is, and `mdmem doctor` reports
it.

The import runs once per user and repository. mdmem records it in
`~/.claude/projects/<key>/mdmem-imported`, so a store created again after you
delete the store does not bring back memories you had deleted. Delete the
marker to import again the next time a store is created. An existing store gets
no import.

### Trust, subdirectories and server approval

**Trust.** Claude Code runs the project's hooks, and honors the
`permissions.allow` entry in `.claude/settings.json`, only once you accept the
folder's trust dialog. It records that trust in your user config,
`~/.claude.json` (in `$CLAUDE_CONFIG_DIR` when it is set), as
`hasTrustDialogAccepted: true` under `projects` and the folder's resolved path.

The global hooks stay silent where the project's own entries are present and
the folder is trusted. Trust counts under the folder's own path, any folder
above it up to its work tree's root (up to `/` outside git), or, in a linked
worktree, the main checkout's root, where Claude Code 2.1.310 records a
worktree's trust.

In an untrusted folder wired in both scopes, the global hooks speak instead,
saying on stderr that the project's hooks wait for trust. Once you accept the
dialog, the project's hooks speak and the global ones stay silent. A
`claude -p` run executes the project's hooks in a folder never trusted, so a
headless session there gets each part twice.

**Subdirectories.** Claude Code reads `.claude/settings.json` only from the
folder it is started in. Started in a subdirectory, it runs none of the project
scope's hooks, and `mdmem status` run there warns about it. The global hooks
stay silent only where that folder holds the project's own entries, so a Claude
Code started in a subdirectory of a repository wired in both scopes still gets
them, and `status` does not warn.

**Server approval.** Claude Code asks each user to approve a server from a
project's `.mcp.json` before it connects it. Until then the mdmem tools are
missing, and agents fall back to writing files directly. Approving the server
in that dialog writes `"enabledMcpjsonServers": ["mdmem"]` to your
`.claude/settings.local.json`.

The same key in the committed `.claude/settings.json` skips the dialog, but
only in a folder whose trust dialog you have accepted: in an untrusted folder
Claude Code ignores the repository's own approval. `mdmem enable` does not
write that key. A `claude -p` run connects project servers without asking,
approved or not.

This was checked with `claude mcp list` on Claude Code 2.1.302 against an
isolated config directory, and against the
[settings reference](https://code.claude.com/docs/en/settings-reference). With
the key in the project settings of a trusted folder, the server connects.
Without it, or in an untrusted folder, it stays pending approval.

**One server.** A repository wired in both scopes runs one mdmem server: the
user-scope one until the folder is trusted and the project's server approved,
then the project's. Both run `mdmem mcp`.

## IBM Bob

`mdmem enable bob` merges three entries into Bob's files, leaving their other
keys, and their order and indentation, as they were. The global scope writes
Bob's user files, `~/.bob/settings/settings.json` and
`~/.bob/settings/mcp.json` (the file `bob mcp add -s global` writes).
`--project` writes its workspace files, `.bob/settings.json` and
`.bob/mcp.json`.

- In the settings, one `SessionStart` hook group, matcher
  `^(startup|compact)$` (a new session and compaction, not a resume), with two
  command handlers, `mdmem hook bob protocol` and `mdmem hook bob index`, each
  followed by `--global` in the global scope and with a 10-second timeout. Bob
  validates hooks strictly, so a single unknown key voids the whole `hooks`
  block: the group holds only documented fields.
- In the settings too, one `UserPromptSubmit` hook group with no matcher and
  one command handler, `mdmem hook bob prompt` (`--global` in the global
  scope), with a 10-second timeout.
- In the MCP config, the mdmem server:
  `"mcpServers": {"mdmem": {"command": "mdmem", "args": ["mcp"]}}`.

`mdmem disable bob` (with `--project` for the workspace files) removes exactly
these entries, along with an object or array they leave empty, and deletes a
file that held nothing else. `mdmem status` lists each entry as present or
missing.

Entries you edit stay mdmem's, as for Claude Code. A handler you set `disabled`
or give another `timeout`, or an `alwaysAllow` added to the server, is kept by
`enable`. An `mcpServers.mdmem` running another command makes `enable` refuse.
Bob skips a handler marked `"disabled": true`, so `mdmem status` reports it as
a problem.

**Trust and the workspace.** Bob runs workspace hooks and MCP servers only in a
trusted folder; in an untrusted one neither runs. Bob also reads both
`.bob/settings.json` (the hooks) and `.bob/mcp.json` only from its workspace,
the folder it was launched in. Launched at a checkout's root, it gets the
protocol, the index and the mdmem tools. Launched in a subdirectory, it has
none of the project scope's wiring.

The global scope has neither limit. Its hooks stay silent only where the folder
Bob was launched in holds the workspace's own entry for their part, not marked
`disabled`. So a Bob launched in a subdirectory of a repository wired in both
scopes still gets them.

Where the workspace's entries are present, the global hooks stay silent even in
a folder Bob does not trust, which runs none of them, so that folder gets no
memory: see [Known limitations](troubleshooting.md#known-limitations).

## Codex CLI

`mdmem enable codex` merges three entries into Codex's files, leaving their
other content as it was. The global scope writes `~/.codex/hooks.json` and
`~/.codex/config.toml` (under `$CODEX_HOME` when it is set). `--project` writes
the repository's `.codex/hooks.json` and `.codex/config.toml`.

- In the hooks file, one `SessionStart` hook group with no matcher, holding two
  command handlers, `mdmem hook codex protocol` and `mdmem hook codex index`,
  each followed by `--global` in the global scope and with a 10-second timeout
  and `"additionalContextLimit": 0`. Without that limit, Codex replaces a hook
  context over about 2,500 tokens with a preview and the path of a temporary
  file. `mdmem hook` skips a resumed or forked session itself.
- In the hooks file too, one `UserPromptSubmit` hook group with no matcher and
  one command handler, `mdmem hook codex prompt` (`--global` in the global
  scope), with a 10-second timeout and no `additionalContextLimit`: the
  per-prompt block stays under 4,000 characters, below Codex's cap.
- In the config, the mdmem server:

  ```toml
  [mcp_servers.mdmem]
  command = "mdmem"
  args = ["mcp"]
  ```

  mdmem appends this table at the end of the file, so the rest of the file is
  kept byte for byte. When that would not be valid TOML (the file defines
  `mcp_servers` as an inline table), mdmem adds the server to that table in
  place instead. A `[mcp_servers.mdmem]` running `mdmem mcp` is mdmem's
  whatever else you add to it (`env`, `env_vars`, `startup_timeout_sec`). One
  running another command makes `enable` refuse, naming the file and the table,
  and `disable` leaves it.

`mdmem disable codex` (with `--project` for the repository's files) removes
exactly these entries and deletes a file that held nothing else. Removing a
server table also drops the comment lines written directly above it, inside it
or after it, and those directly above the table that follows it, with the blank
lines around them. `mdmem status` lists each entry as present or missing.

**The hook review.** Codex runs a hook only once you have reviewed it, at its
next interactive start or in `/hooks`. `codex exec` never asks, and runs no
hook you have not reviewed.

Codex ties the review to the path of the hooks file, to the group's position in
`hooks.SessionStart` and to its content. So adding or removing a `SessionStart`
group before mdmem's, or editing mdmem's, makes Codex ask again. An edited
group still runs mdmem's commands, so `enable` does not add a second one. The
prompt hook is a new handler, so a wiring that gains it asks for one more
review per hooks file.

The global hooks are reviewed once per machine. The project's are reviewed once
per clone: in a linked worktree Codex reads the hooks from the main checkout's
`.codex/hooks.json`, whose review it shares, and only when the worktree's own
commit has a `.codex/` folder (Codex 0.164.0).

**Trust and subdirectories.** Codex reads a project's `.codex/` folders only in
a folder you have trusted, and trusting it for one run with a `-c` override
does not count. In an untrusted folder the project scope's hooks and server are
missing. Unless the global scope is wired, the mdmem tools are then missing,
and agents fall back to writing files directly.

Codex reads those folders from the folder it was started in up to the work
tree's root, so the project scope works in any subdirectory.

**Both scopes.** The global entries stay silent wherever one of those hooks
files holds the project's own entry for their part. A repository wired in both
scopes gets each part once where Codex runs the project's hooks. The global
entries stay silent even where it does not, in a folder it does not trust or
before their review, so the session gets no memory there: see
[Known limitations](troubleshooting.md#known-limitations). When the user config
and the project's both register the server, Codex runs the project's.

### Codex's own memory

Codex's own memory (`[features] memories`, under `~/.codex/memories/`) stays on
beside mdmem. `mdmem enable codex` does not touch `features.memories`, imports
nothing from it, and the check reports nothing about it.

Codex writes that memory itself after each session, as summaries of its
sessions and tasks. It does not compete with the store, and turning it off
would cost Codex its continuity. The memory protocol tells Codex to keep there
what is about itself and its sessions, and to save to the store everything
about the project, how to work in it and what the user wants. When Codex's
memory and the store disagree, the user's current instructions and verified
facts come first, then the store over older notes in Codex's memory on anything
about the project.

Claude Code's auto memory is different. It holds facts the agent saves
deliberately, in the store's own format, and so competes with the store.
`mdmem enable claude-code` turns it off and imports its memories once, when the
store is created.
[ADR 0003](adr/0003-one-store-per-project-injected-by-hooks.md) records both
decisions.

## MCP server

`mdmem mcp` runs a stdio server with the same memory-store tools as Claude
Code, plus three of its own. Agents save through it rather than by editing
files, because their sandboxes refuse writes outside the working directory,
which is where a home store always is
([ADR 0003](adr/0003-one-store-per-project-injected-by-hooks.md)).

| Tool | Purpose |
|---|---|
| `memory_list` | With no arguments, list the stores: mdmem serves one, named after the project directory. Its description names its placement and directory, with `MEMORY.md` as its index. With `store`, list its documents by path, with size and last-updated date. `path_prefix` filters by path; `cursor` continues a long listing. |
| `memory_read` | Read one document by `path` (`uses-bun.md`, or the index `MEMORY.md`), with its version token. The result opens with a line naming the store that answered, `Store: <id> (<placement>, <path>)`: the id `memory_list` gives it, `home` or `local`, and its directory. The structured result carries the same: `store` (`id`, `placement` and `path`), `path`, `content` and `version`. |
| `memory_write` | Write a whole memory document at `path`. The content must be a valid memory whose name matches its file name, in kebab-case or snake_case. `MEMORY.md`, paths inside a directory, and content that looks like it holds a secret are refused. With no store yet, the first write creates the home store, and its result opens with the lines `mdmem add` prints for that. A line says what the write did to the memory's pointer in `MEMORY.md`: `pointer added`, `pointer updated` or `unchanged`. The structured result carries what the text says: `file`, `version`, `index` (what became of that pointer), `warnings`, and, on the write that created the store, `created` (the store's path and placement, the import's lines, and for a local store whether git ignores it). |
| `memory_delete` | Delete a memory document at `path`. `MEMORY.md` and paths inside a directory are refused. |
| `memory_search` | Find the memories whose name, description, headings or body hold the words of the query, best match first. Each word is stemmed and matched on its own; quote text to require it as an exact phrase; common function words are ignored. A memory's frontmatter is matched on its values, not its keys (`name:`, `type:`), so `type` matches only a memory whose values, headings or body hold it. The result lists the memories by path with their description, after the same `Store: <id> (<placement>, <path>)` line as `memory_read`. A memory that does not parse is skipped and named in a warning. |
| `memory_check` | Check the store and the agents' wiring as `mdmem doctor` does, returning the same text: a line naming the store and its placement, then the problems one per line, or the memory count and no problems. With no store yet, it checks the wiring alone. |

**The store argument.** `store` is optional everywhere: leave it out to use the
project's store. An unknown store id is an error that names the valid one.

**Before the first save.** `memory_list` and `memory_search` read a store not
created yet as empty, and say that the first `memory_write` creates it.
`memory_read` and `memory_delete` refuse until then, saying what creates it.

**Versions.** `memory_write` and `memory_delete` require `if_version`, the
version token from your last `memory_read` or `memory_write` of that path. For
a file that does not exist yet, `memory_write` takes the literal `new`. When
the document has changed since that version, or `new` names a file that already
exists, the call is rejected and returns the current content and version, in
the text and the structured result (`message`, `path`, `content`, `version`),
so the agent can merge and retry. Both tools update `MEMORY.md` afterwards.

**Annotations.** Each tool carries its title in its annotations, where Claude
Code reads it, with hints for the client. `memory_list`, `memory_search`,
`memory_check` and `memory_read` are read-only. `memory_write` and
`memory_delete` are destructive (they replace or remove a whole document) and
idempotent (a repeated call fails on its `if_version`). None reaches past the
project's store.

The server also serves one prompt, `consolidate` (see
[Consolidation](#consolidation)).

`mdmem enable` registers the server for each agent:

| Agent | Global scope | `--project` |
|---|---|---|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| IBM Bob | `~/.bob/settings/mcp.json` | `.bob/mcp.json` |
| Codex CLI | `~/.codex/config.toml` | `.codex/config.toml` |

Each agent starts the server in the session's working directory, in either
scope, so the server finds the store of the project the session runs in.

## Consolidation

Claude Code can run a *dream*: a reflective pass that merges, corrects and
prunes its memories. mdmem runs no agent itself, so it serves that pass as a
prompt for any agent, run when you ask for one:

- over MCP, as the prompt `consolidate`, which Claude Code lists as
  `/mcp__mdmem__consolidate`;
- from the shell, with `mdmem consolidate --agent <agent>`, which prints the
  prompt for you to pass to an agent:

  ```bash
  codex "$(mdmem consolidate --agent codex)"
  ```

Both give the same text. The agent orients on the store, looks for memories the
code has drifted from, merges and dates what it learned, deletes stale
memories, and reconciles feedback and project memories with the project's
instruction files, which it flags but never edits. The text lives in
`templates/consolidate.md`.

**`--agent`** (the prompt's `agent` argument over MCP) makes the prompt tell
the agent where its past sessions of the project are and how to search them:

- `claude-code`: the `.jsonl` files in the project's directory under
  `$CLAUDE_CONFIG_DIR/projects/` (`~/.claude/projects/` when unset), one per
  session. The directory is named `$CLAUDE_CODE_PROJECT_DIR_NAME` when that is
  set, as Claude Code names it.
- `codex`: the `.jsonl` files under `$CODEX_HOME/sessions/`
  (`~/.codex/sessions/` when unset). They hold every project's sessions, so the
  agent keeps only those whose first-line `session_meta` record has a `cwd` in
  the project. Codex starts the MCP server without `CODEX_HOME`, so the MCP
  prompt names `~/.codex/sessions/` unless `CODEX_HOME` is passed to the
  server; `mdmem consolidate` reads `CODEX_HOME` from your shell.
- `bob`, or no agent: a generic line telling the agent to search its own past
  sessions if it can.

**`--from <dir>`** (the prompt's `from` argument over MCP) names a second
store, such as a home store a local one hides. The prompt tells the agent to
merge each of its memories into the project's store, then delete that store's
directory or ask you to. `--from` must name a directory other than the
project's store.

An unknown agent is refused, and `mdmem consolidate` refuses while there is no
store yet.
