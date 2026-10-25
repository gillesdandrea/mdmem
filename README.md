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
  committing `.memory/` is your choice, and the command that creates the store
  says when git does not ignore it. Committing it suits projects without
  worktrees: each linked worktree would also check out a copy of `.memory/`,
  which mdmem ignores there. To keep `.memory/` out of every repository at once,
  add it to your global gitignore (`git config --global core.excludesFile`).
- **The store is created on the first save.** In a git repository with no
  `.memory/` yet, the first memory write (`memory_write` from an agent, or
  `mdmem add`) creates it, with its `MEMORY.md`, and says so. Until then, reads
  (`mdmem read`, `memory_read`, …) refuse and say what creates it. Outside git
  only `mdmem init` creates a store, since a save in a folder such as `~/dev`
  would make a store that every repository later created under it no longer
  sees.
- **mdmem keeps the index up to date from the memories.** Agents only ever write
  their own memory files. After every save or delete through mdmem, and on
  `mdmem reindex`, mdmem updates `MEMORY.md` in place: it appends a pointer for a
  memory that has none, removes pointers to missing files and duplicate pointers,
  and keeps descriptions current: a pointer in mdmem's form (titled with its
  memory's name, then ` — `) takes the memory's description whenever it differs,
  so a direct edit reaches the index; any other pointer (written by hand or by
  Claude Code) takes a new description only when a save of its memory through
  mdmem changes it, or finds no ` — ` on it. Every other line (a title,
  headings, prose, a pointer's own title) is kept, so an index written by hand or by Claude Code survives. An empty store has
  an empty index.
- **Each agent is wired to the store in its own native way** (`mdmem enable`),
  through session-start hooks that inject the memory protocol and the index,
  and the mdmem MCP server, in one of two scopes:
  - **global** (the default): in the agent's user-wide files, so it works in
    every repository on your machine with no setup per project;
  - **project** (`--project`): in files committed with one repository, so
    everyone who clones it is wired.

  A repository may be wired in both scopes, by different people: each session
  still gets the protocol and the index once, and the agent runs one mdmem
  server. mdmem supports these agents, all of which have session-start hooks;
  agents without them are not supported:
  - **Claude Code** (`claude-code`): turns Claude's own auto memory off and
    wires it through session-start hooks and the mdmem MCP server. See
    [Claude Code](#claude-code) below.
  - **IBM Bob** (`bob`): wires it through session-start hooks and the mdmem
    MCP server. See [IBM Bob](#ibm-bob) below.
  - **Codex CLI** (`codex`): wires it through one session-start hook in your
    own `~/.codex/hooks.json`, in both scopes, and the mdmem MCP server in your
    `~/.codex/config.toml` or the project's `.codex/config.toml`. See
    [Codex CLI](#codex-cli) below.

  The memory protocol adapts Claude Code's own memory instructions to the shared
  store: the memory format and types, what to save and what not to, checking a
  recalled memory before acting on it, and saving through the MCP tools (writing
  files directly only when an agent lacks them). Its text lives in
  `templates/memory-protocol.md` and is easy to edit; a test keeps it at 6,000
  characters at most, about three times Claude Code's own memory block, since
  every wired agent reads it at every session start, `/clear` and compaction.
- **Two surfaces, one core:** a CLI for humans/scripts and setup, and an MCP
  server for agents that prefer tool calls.

## Install

```bash
bun install
bun link          # puts `mdmem` on your PATH
```

The hooks and MCP server that `mdmem enable claude-code`, `mdmem enable bob`
and `mdmem enable codex` write (see [Claude Code](#claude-code),
[IBM Bob](#ibm-bob) and [Codex CLI](#codex-cli)) also expect `mdmem` on your
PATH.

## Quickstart

```bash
mdmem enable --all          # wire the agents found on this machine, once, for every repository
cd ~/dev/my-project         # any git repository
mdmem add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."   # creates .memory/ at the repository's root
mdmem status                # show the store and each agent's wiring in both scopes
```

Now every wired agent sees the memory, in this repository and its worktrees. An
agent's own first `memory_write` creates the store just as `add` does. When an
agent writes a memory file directly, run `mdmem reindex` to refresh the index
(or let the next `add`/MCP write do it).

To wire one repository for everyone who clones it instead, run
`mdmem enable --all --project` in it and commit the files it names.

## Commands

| Command | Purpose |
|---|---|
| `mdmem init` | Create `.memory/` at the project's root, or report the existing store; the only way to create one outside git |
| `mdmem add --type <t> --name <n> --description <d> [--body <text>] [--force]` | Save a memory, creating the store first in a repository that has none; refuses an existing name unless `--force`, and refuses a `--force` overwrite if the memory changes while it is saved. Body may also be piped via stdin. |
| `mdmem list` | Print the memory index (`MEMORY.md`) |
| `mdmem read <name>` | Print one memory by its name (or `<name>.md`), or the index (`MEMORY.md`) |
| `mdmem edit <name>` | Edit a copy of a memory in `$VISUAL`/`$EDITOR`, then save it back and reindex |
| `mdmem delete` (alias `rm`) `<name>` | Remove a memory by its name (or `<name>.md`) |
| `mdmem search <query>` | Find memories containing text |
| `mdmem reindex` | Bring `MEMORY.md` up to date with the memories, keeping its other lines |
| `mdmem consolidate [--agent <agent>]` | Print the consolidation prompt; `--agent` points it at that agent's past sessions of the project (see below) |
| `mdmem doctor` (alias `check`) | Check the store: parse errors, name≠filename, conflicting types, secrets, pointers over 150 characters, stale index (a memory without a pointer, a pointer to a missing file, a duplicate pointer, a pointer in mdmem's form, titled with its memory's name then ` — `, whose description differs from the memory's), index over 9,500 characters, the size a session-start hook can inject; and the agents' wiring in both scopes (see [What status and the check report](#what-status-and-the-check-report)); with no store, or outside any project, the wiring alone. Exits 1 on a problem. A `[[link]]` to a memory not written yet is a note, not a problem: doctor lists it (`note: uses-bun.md links [[ts7-strict]], not written yet`) and exits 0 when notes are its only finding |
| `mdmem enable <agent…> \| --all [--project]` | Wire an agent in its user-wide files (the global scope), or with `--project` in the repository's files, creating the store if it is missing; running it again changes nothing. `--all` wires the agents found on this machine (see below). |
| `mdmem disable <agent…> \| --all [--project]` | Remove exactly mdmem's entries from an agent's user-wide files, or with `--project` from the repository's (leaves the store); `--all` takes the agents found on this machine. Needs no store. |
| `mdmem status` | Show the store (or that there is none yet), the check in one line, and each agent's wiring in each scope, entry by entry (present or missing), with the warnings and notes below; outside any project, the global scope alone |
| `mdmem path` | Print the store directory |
| `mdmem version` (also `--version`, `-v`, `-V`) | Print `mdmem` and its version, the one the MCP server reports |
| `mdmem mcp` | Run the MCP server over stdio |
| `mdmem hook <agent> <part> [--global]` | Run by an agent's session-start hook, not typed by hand (see below) |

Agents: `claude-code`, `bob`, `codex`. Memory types: `user`, `feedback`, `project`, `reference`.

`--all` counts an agent as found on this machine when its command is on PATH
(`claude`, `bob`, `codex`) or its config directory exists (`~/.claude`, or
`$CLAUDE_CONFIG_DIR` when set; `~/.bob`; `~/.codex`, or `$CODEX_HOME` when
set), and prints the agents it skipped. Naming an agent wires
it whether it is found or not. `disable --all` likewise acts only on the agents
found, so wiring for an agent not on this machine stays until you name it.
`--all` and agent names do not combine.

`enable` and `disable` check every agent name and read every file they would
change before writing any: an unknown agent or a file that does not parse stops
the command with no file written. The global scope runs anywhere and needs no
store. `enable --project` runs in a work tree, or in a project without git that
has a store; in a bare repository, or the folder holding one as `.git`, it
refuses and names the repository's worktrees, since agents read their files
only from a work tree. In a repository with no store it creates one, as the
first save would. `disable` needs no store, so it works after `.memory/` was
deleted; `disable --project` outside any project (no repository, no store)
changes nothing, since the directory may be one whose agent files are
user-wide, such as your home. mdmem 0.2.0's `enable --prefer` and
`disable --global` are refused, naming what replaced them.

`mdmem hook` is what the agents' session-start hooks run: `<agent>` is
`claude-code`, `bob` or `codex`, and `<part>` is `protocol` (the memory protocol)
or `index` (a line naming the store's absolute path, the check's warnings for
unparseable memories and a stale index, then `MEMORY.md`). It reads the hook's
JSON payload on stdin, resolves the store from the payload's `cwd` (else the
working directory), and prints the
part as SessionStart context, each under 10,000 characters: warnings past that are
counted instead of listed, and an index over its limit is cut short with a note to
`memory_read` the rest and run a consolidation. It speaks in every git
repository, store or not: with no store yet, the index part is the line
`Memory store: none yet; the first memory_write creates <repository>/.memory/ with MEMORY.md.`
Outside git it speaks only where a store exists. `--global` marks the global
scope's hook entries: a global entry prints nothing where the project's own
entry for the same part is present (a project's server registration alone does
not count), so a repository wired in both scopes gets each part once. Codex's
one hook prints nothing where neither your `~/.codex/config.toml` nor the
project's `.codex/config.toml` registers the mdmem server. The hook also prints
nothing on a resumed or forked session, or for any event but SessionStart;
empty stdin counts as an empty payload, so run by hand it prints nothing. A
payload that is not a JSON object is reported only where the hook would speak
from the working directory; elsewhere it prints nothing. It never fails a
session: an error becomes a one-line context saying why the memory could not
be loaded, and it exits 0.

`mdmem edit` saves the copy back the way `add` saves a memory, so an edit that is
not a valid memory, holds a secret, or races another change to the memory is
refused: the store stays as it was, and the command prints where the copy is
kept so the edit is not lost. With no `$VISUAL`/`$EDITOR` set, `mdmem edit`
prints the memory's path instead of opening it — edit it by hand, then run
`mdmem reindex`.

A memory that does not parse locks no one out. `search` answers from the
memories that do and warns about the broken one on stderr; `status` counts the
memories that do and counts the broken ones in its `Check:` line. `reindex` and
every save or delete update the index anyway: the broken memory keeps the pointer
it has, gets none if it has none, and each one is named in a warning. `doctor`
reports it with the store's other problems.

## What status and the check report

Hooks that do not run leave an agent without the protocol and the index, and
mdmem has no fallback, so `mdmem status` and the check (`mdmem doctor`,
`memory_check`) report the states that silently break sharing. Both read each
agent's wiring in both scopes, and work without a store and outside any
project, where they report the wiring alone. An agent counts as enabled in a
scope when some of mdmem's entries there are present (for Codex, its server
registration), and as wired when every entry of at least one scope is present;
a repository wired in both scopes is two `status` lines, not a problem. A state that
breaks saving or injection and that you can fix is a check problem: `doctor`
lists it and exits 1, and `status` prints it as a warning.

- An agent's config file that exists but cannot be read: not valid JSON or
  TOML, or JSON that is not an object. A project file (`.claude/settings.json`,
  `.claude/settings.local.json`, `.mcp.json`, `.bob/settings.json`,
  `.bob/mcp.json`, `.codex/config.toml`) is reported whether or not the agent
  is enabled, since mdmem cannot tell what it wires. A user-wide file (Claude
  Code's user settings and `.claude.json`, Bob's `~/.bob/settings/` files,
  Codex's `hooks.json` and `config.toml`) is reported only for an agent enabled
  in some scope; otherwise `status` warns of it, and `memory_check` called from
  Codex leaves Codex's out as it leaves out its hook below. The problem names
  the file and why it cannot be read, and replaces the missing entries and
  other problems that file would give: fix it, then run the check again.
  `mdmem enable` reads every file holding a scope's entries and refuses any
  that cannot be read, so while one cannot be read, the agent's other problems
  that `enable` fixes in that scope say to fix that file first. It does not
  read `.claude/settings.local.json`: while only that cannot be read, the
  agent's other problems still say to run `mdmem enable`.
- A session-start hook missing in a scope the agent is enabled in, the fix
  naming that scope's command (`mdmem enable <agent>`, or with `--project`),
  including Codex's one hook in `hooks.json` when either config registers the
  server. `memory_check` called from Codex leaves Codex's user files out unless
  `CODEX_HOME` reaches the server: Codex starts MCP servers with only a few
  environment variables (`HOME`, `PATH` and the like, not `CODEX_HOME`), so the
  server cannot tell where Codex's home is. Listing it in the server's table,
  as `env_vars = ["CODEX_HOME"]` under `[mcp_servers.mdmem]`, brings the check
  back. `mdmem doctor` and `mdmem status` always check it.
- Bob's workspace hooks switched off: `disableWorkspaceHooks: true` in
  `.bob/settings.json`.
- Claude Code's hooks switched off: `disableAllHooks: true` where Claude Code
  reads it first, as below.
- Claude Code's auto memory still on where Claude Code is enabled:
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to `0`, `false`, `no` or `off` in the
  environment, or `autoMemoryEnabled`
  not `false` where Claude Code reads it first (`.claude/settings.local.json`,
  then `.claude/settings.json`, then your user settings). A project's `true`
  overrides your user settings' `false`, so the global scope reports it too.
  Managed settings are not read.
- `mdmem` not on PATH while an agent is wired: its hooks and MCP server run it.

The rest are `status` lines only, because they are your choice, depend on where
`status` runs, or are something mdmem does not read:

- `Check:`, the check in one line: no problems, or how many, naming unparseable
  memories, a stale `MEMORY.md` and a `MEMORY.md` over its limit, then how many
  notes (links to memories not written yet).
- A note when git does not ignore `.memory/`. mdmem never edits `.gitignore`.
- A warning when `status` runs below the checkout's root of a project wired for
  Bob: a Bob launched there reads neither `.bob/settings.json` nor
  `.bob/mcp.json`, so it gets no protocol, no index and no mdmem tools.
- A warning when `status` runs in a submodule of a project whose files wire an
  agent that the submodule's files do not. The submodule shares the project's store, but
  an agent started there reads the submodule's own files, so it gets no
  protocol, no index and no mdmem tools, and Claude Code applies the
  submodule's settings, not the project's, so mdmem's setting that turns its
  auto memory off does not apply there.
- A note under each agent enabled in the project scope on folder trust, which
  decides whether its project files run, and for Codex on its one-time review
  of the hook: mdmem checks neither.

## Claude Code

`mdmem enable claude-code` merges these entries into Claude Code's files,
leaving their other keys, and their order and indentation, as they were. The
global scope writes your user settings, `~/.claude/settings.json`, and your user
config, `~/.claude.json` (both in `$CLAUDE_CONFIG_DIR` when it is set);
`--project` writes the repository's `.claude/settings.json` and `.mcp.json`.

- In the settings:
  - `"autoMemoryEnabled": false`, which turns Claude's own memory off: on the
    whole machine in the global scope, for the repository in the project scope;
  - two `SessionStart` hooks, matcher `startup|clear|compact`, running
    `mdmem hook claude-code protocol` and `mdmem hook claude-code index`, each
    followed by `--global` in the global scope;
  - `"permissions": {"allow": ["mcp__mdmem"]}`, so the mdmem tools run without
    asking.
- The mdmem server,
  `"mcpServers": {"mdmem": {"type": "stdio", "command": "mdmem", "args": ["mcp"]}}`,
  at the top level of `~/.claude.json` (Claude Code's user-scope servers), or in
  `.mcp.json`.

When a store is created in a repository where Claude Code is enabled in either
scope, by the first save, `mdmem init` or `mdmem enable --project`, mdmem
imports the memories Claude Code kept for the repository
(`~/.claude/projects/<key>/memory/`, and the directory of each of the
repository's worktrees) into it, and the creating command lists what it copied.
A memory held by one directory is copied, identical ones are kept once, and
when two directories hold different versions of a file, the repository's own
directory's version is copied and the others are listed as left in Claude's
directories, which mdmem never changes. A memory whose `name` differs from its
file name (`team-lead.md` holding `name: Team Lead`) is stored with the file name
as its name, so `mdmem doctor` passes, and is listed under "Renamed to match the
file name:"; its title in `MEMORY.md` stays as Claude wrote it. A memory that
does not parse, or whose name the import cannot rewrite, is copied as it is, and
`mdmem doctor` reports it. The import runs once per user and repository: mdmem
records it in `~/.claude/projects/<key>/mdmem-imported`, so a store created
again after you delete `.memory/` does not bring back memories you had deleted.
Delete the marker to import again the next time a store is created. An existing
store gets no import.

With `--project`, commit both files: they wire Claude Code for everyone working
in the repository, and everyone then needs `mdmem` on PATH.
`mdmem disable claude-code` (with `--project` for the repository's files)
removes exactly these entries, along with an object or array they leave empty
(an empty `"permissions": {}` you had before goes too), and deletes a file that
held nothing else; the imported memories stay in `.memory/`. `mdmem status`
lists each entry of each scope as present or missing.

A hook stays mdmem's while it runs mdmem's command, and the server while it runs
`mdmem mcp`, so a field you add to either (a hook's `timeout`, say) counts as
wired, is kept by `enable` and goes with the entry on `disable`. A handler of
your own in mdmem's hook group stays: `disable` takes out only mdmem's handlers,
and the group goes once it holds no other. A key holding something else, such
as an `mcpServers.mdmem` running another command (`bun run …/src/cli/index.ts
mcp` included) or `"autoMemoryEnabled": true`, makes `enable` refuse before it
writes anything, naming the file and the key; `disable` leaves that key alone.

Claude Code ignores the `permissions.allow` entry in `.claude/settings.json`,
and runs the project's hooks, only once you accept the folder's trust dialog.
The global hooks stay silent where the project's own entries are present, so
in an untrusted folder wired in both scopes neither speaks until you trust it.
Claude Code reads `.claude/settings.json` only from the folder it is started
in, so started in a subdirectory it runs none of the project scope's hooks. The
global hooks stay silent only where that folder holds the project's own
entries, so a Claude Code started in a subdirectory of a repository wired in
both scopes still gets them.

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
connects project servers without asking, approved or not. A repository wired
in both scopes runs one mdmem server: the user-scope one until the folder is
trusted and the project's server approved, then the project's; both run
`mdmem mcp`.

## IBM Bob

`mdmem enable bob` merges two entries into Bob's files, leaving their other
keys, and their order and indentation, as they were: in the global scope its
user files `~/.bob/settings/settings.json` and `~/.bob/settings/mcp.json` (the
file `bob mcp add -s global` writes), and with `--project` its workspace files
`.bob/settings.json` and `.bob/mcp.json`.

- In the settings, one `SessionStart` hook group, matcher
  `^(startup|compact)$` (a new session and compaction, not a resume), with two
  command handlers, `mdmem hook bob protocol` and `mdmem hook bob index`, each
  followed by `--global` in the global scope and with a 10-second timeout. Bob
  validates hooks strictly, so a single unknown key voids the whole `hooks`
  block: the group holds only documented fields.
- In the MCP config, the mdmem server:
  `"mcpServers": {"mdmem": {"command": "mdmem", "args": ["mcp"]}}`.

With `--project`, commit both files: they wire Bob for everyone working in the
repository, and everyone then needs `mdmem` on PATH. `mdmem disable bob` (with
`--project` for the workspace files) removes exactly these entries, along with an object or array they leave empty, and deletes a file that
held nothing else. `mdmem status` lists each entry as present or missing.
Entries you edit stay mdmem's, as for Claude Code: a handler you set `disabled`
or give another `timeout` in, or an `alwaysAllow` added to the server, is kept by
`enable`, and an `mcpServers.mdmem` running another command makes it refuse.

Bob runs workspace hooks and MCP servers only in a trusted folder; in an
untrusted one neither runs. Bob also reads both `.bob/settings.json` (the
hooks) and `.bob/mcp.json` only from its workspace, the folder it was launched
in: launched at a checkout's root it gets the protocol, the index and the mdmem
tools; launched in a subdirectory it has none of the project scope's wiring.
The global scope has neither limit, and its hooks stay silent only where the
folder Bob was launched in holds the workspace's own entries, so a Bob launched
in a subdirectory of a repository wired in both scopes still gets them.

## Codex CLI

`mdmem enable codex` merges two entries, leaving the files' other content as it
was:

- in `~/.codex/hooks.json` (`$CODEX_HOME/hooks.json` when `CODEX_HOME` is set),
  in both scopes,
  one `SessionStart` hook group with no matcher, holding two command handlers,
  `mdmem hook codex protocol` and `mdmem hook codex index`, each with a
  10-second timeout and `"additionalContextLimit": 0`. Without that limit,
  Codex replaces a hook context over about 2,500 tokens with a preview and the
  path of a temporary file. `mdmem hook` skips a resumed or forked session
  itself.
- the mdmem server, in your `~/.codex/config.toml` (`$CODEX_HOME/config.toml`)
  in the global scope, or with `--project` in the project's
  `.codex/config.toml`:

  ```toml
  [mcp_servers.mdmem]
  command = "mdmem"
  args = ["mcp"]
  ```

  mdmem appends this table at the end of the file, so the rest of the file is
  kept byte for byte. When that would not be valid TOML (the file defines
  `mcp_servers` as an inline table), mdmem adds the server to that table in
  place instead. A `[mcp_servers.mdmem]` running `mdmem mcp` is mdmem's whatever
  else you add to it (`env`, `env_vars`, `startup_timeout_sec`); one running
  another command makes `enable` refuse, naming the file and the table, and
  `disable` leaves it.

The hook is global because Codex ties a hook's approval to the absolute path of
the file that declares it: a hook in each worktree's `.codex/hooks.json` would
need approving in every worktree. Codex asks you to review the new hook once, at
its next start or in `/hooks`. Codex also ties the approval to the group's
position in `hooks.SessionStart` and to its content, so adding or removing a
`SessionStart` group before mdmem's in that file, or editing mdmem's, makes
Codex ask again; an edited group still runs mdmem's commands, so `enable` does
not add a second one.
Once trusted, it runs in every project and
worktree, and the scope is where the server is registered: the hook speaks
where your `~/.codex/config.toml` or the project's `.codex/config.toml`
registers it, and prints nothing elsewhere. The hook reads `$CODEX_HOME` when
Codex passes it, else `~/.codex`; whether Codex passes `CODEX_HOME` to hooks is
unverified. Running `mdmem enable codex --project` in another project finds the
hook already there and adds only that project's server.

With `--project`, commit `.codex/config.toml`: it registers the server for
everyone working in the repository, and everyone then needs `mdmem` on PATH.
Codex reads a project's `.codex/config.toml` only in a folder you have trusted,
and trusting it for one run with a `-c` override does not count; in an
untrusted one the mdmem tools are missing and agents fall back to writing files
directly.

`mdmem disable codex --project` removes the project's server, deleting
`.codex/config.toml` when nothing else is left in it, and keeps the hook, which
is then silent in that project unless your `~/.codex/config.toml` registers the
server. `mdmem disable codex` removes the server from your
`~/.codex/config.toml` and mdmem's handlers from `~/.codex/hooks.json`,
deleting either file when it held nothing else; repositories wired with
`--project` then need `mdmem enable codex --project` again to get the hook
back. Removing a server table also drops the comment lines written directly
above it, inside it or after it, and those directly above the table that
follows it, with the blank lines around them. `mdmem status` lists each
scope's server and the hook, each present or missing.

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
related memories with `[[name]]`. A link may name a memory not written yet, as
`[[ts7-strict]]` does here: it marks a memory worth writing.

mdmem reads memories as loosely as Claude Code writes them: any non-empty name,
the type under `metadata` or at the top level (`metadata.type` wins when both are
set), and unknown fields, which it keeps. What it writes (`add`, `edit`,
`memory_write`) is strict: the name must equal the file name without `.md`, in
kebab-case or snake_case, so a memory whose name differs from its file must have
its name fixed before mdmem saves it. `doctor` reports a name that differs from
its file name and two types that disagree; a `[[link]]` resolves to a memory's
name or its file name, and one that resolves to neither is a note.

## MCP server

For agents that call tools instead of reading files, `mdmem mcp` runs a stdio
server with the same memory-store tools as Claude Code, plus three of its own:

| Tool | Purpose |
|---|---|
| `memory_list` | With no arguments, list the stores: mdmem serves one, named after the project directory, with `MEMORY.md` as its index. With `store`, list its documents by path, with size and last-updated date. `path_prefix` filters by path; `cursor` continues a long listing. |
| `memory_read` | Read one document by `path` (`uses-bun.md`, or the index `MEMORY.md`), with its version token. The structured result carries the same: `path`, `content` and `version`. |
| `memory_write` | Write a whole memory document at `path`. The content must be a valid memory whose name matches its file name, in kebab-case or snake_case. `MEMORY.md`, paths inside a directory, and content that looks like it holds a secret are refused. In a git repository with no store, the first write creates it, and its result opens with the lines `mdmem add` prints for that. A line says what the write did to the memory's pointer in `MEMORY.md`: `pointer added`, `pointer updated` or `unchanged`. The structured result carries what the text says: `file`, `version`, `index` (what became of that pointer), `created` (the store's path, the import's lines, whether git ignores it) on the write that created the store, and `warnings`. |
| `memory_delete` | Delete a memory document at `path`. `MEMORY.md` and paths inside a directory are refused. |
| `memory_search` | List the memories containing a query, by path with their description. A memory that does not parse is skipped and named in a warning. |
| `memory_check` | Check the store and the agents' wiring as `mdmem doctor` does, returning the same text: the problems one per line, or the memory count and no problems; with no store yet, the wiring alone. |

`store` is optional everywhere: leave it out to use the project's store. An
unknown store id is an error that names the valid one. Every tool but
`memory_write` and `memory_check` refuses while the store does not exist,
saying what creates it. `memory_write` and
`memory_delete` require `if_version`, the version token from your last
`memory_read` or `memory_write` of that path. For a file that doesn't exist yet,
`memory_write` takes the literal `new`. When the document has changed since that
version, or `new` names a file that already exists, the call is rejected and
returns the current content and version, in the text and the structured result
(`message`, `path`, `content`, `version`), so the agent can merge and retry. Both
tools update `MEMORY.md` afterwards.

Each tool also carries its title in its annotations, where Claude Code reads
it, with hints for the client: `memory_list`, `memory_search`, `memory_check`
and `memory_read` are read-only; `memory_write` and `memory_delete` are
destructive (they replace or remove a whole document) and idempotent (a repeated
call fails on its `if_version`); none reaches past the project's store.

The server also serves one prompt, `consolidate` (see below).

Claude Code: `mdmem enable claude-code` registers it in `~/.claude.json`, or
with `--project` in `.mcp.json` (see [Claude Code](#claude-code)).

IBM Bob: `mdmem enable bob` registers it in `~/.bob/settings/mcp.json`, or with
`--project` in `.bob/mcp.json` (see [IBM Bob](#ibm-bob)).

Codex CLI: `mdmem enable codex` registers it in `~/.codex/config.toml`, or with
`--project` in `.codex/config.toml` (see [Codex CLI](#codex-cli)).

Each agent starts the server in the session's working directory, in either
scope, so the server finds the store of the repository the session runs in.

## Consolidation

Claude Code can run a *dream*: a reflective pass that merges, corrects
and prunes its memories. mdmem runs no agent itself, so it serves that pass as a
prompt for any agent, run when you ask for one. `mdmem consolidate` prints it, and
the MCP server serves it as the prompt `consolidate`:

```bash
codex "$(mdmem consolidate --agent codex)"
```

With `--agent` (the prompt's `agent` argument over MCP), the prompt tells the agent
where its past sessions of the project are and how to search them:

- `claude-code`: the `.jsonl` files in the project's directory under
  `$CLAUDE_CONFIG_DIR/projects/` (`~/.claude/projects/` when unset), one per session.
  The directory is named `$CLAUDE_CODE_PROJECT_DIR_NAME` when that is set, as
  Claude Code names it.
- `codex`: the `.jsonl` files under `$CODEX_HOME/sessions/` (`~/.codex/sessions/`
  when unset), which hold every project's sessions, so the agent keeps only those
  whose first-line `session_meta` record has a `cwd` in the project. Codex starts
  the MCP server without `CODEX_HOME`, so the MCP prompt names `~/.codex/sessions/`
  unless `CODEX_HOME` is passed to the server; `mdmem consolidate` reads
  `CODEX_HOME` from your shell.
- `bob`, or no agent: a generic line telling the agent to search its own past
  sessions if it can.

An unknown agent is refused.

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

A global cross-project store and semantic recall.

## License

[MIT](LICENSE) © Gilles d'Andrea
