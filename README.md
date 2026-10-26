# mdmem

Shared, Claude-style file-based memory for any coding agent.

Claude Code's auto memory is yours alone: one directory per user and per
checkout under `~/.claude/projects/<key>/memory/`, invisible to Codex, Bob and
your teammates, and a linked worktree gets its own. mdmem keeps the same memory
format in one store per project, so every agent you run there (Claude Code,
Codex CLI, IBM Bob) reads and writes one store and every worktree shares it.
The store lives in your home directory, `~/.mdmem/<key>/`, unless you move it
into the project with `mdmem store local` to share it with your teammates
through git. Agents save through a small MCP server rather than by editing
files, because their sandboxes refuse writes outside the working directory,
which is where a home store always is
([ADR 0003](docs/adr/0003-one-store-per-project-injected-by-hooks.md),
[ADR 0005](docs/adr/0005-home-store-by-default-local-store-on-purpose.md)).

- **One store** per project: a repository with its worktrees and
  subdirectories, or outside git the directory you work in.
- **Every agent**: a memory one agent saves is in the others' next session.
- **Claude Code's format**: one Markdown file per fact and a `MEMORY.md` index;
  where Claude Code is wired, its existing memories are imported when the store
  is created.

## Install

mdmem runs on [bun](https://bun.sh), which you need until mdmem is published
on npm:

```bash
git clone https://github.com/gillesdandrea/mdmem.git
cd mdmem
bun install
bun link          # puts `mdmem` on your PATH
```

The agents' hooks and MCP server run `mdmem`, so it has to stay on your PATH.
Everyone who clones a repository wired with `--project` needs it too.

## Quickstart

```bash
mdmem enable --all          # wire the agents found on this machine, once, for every repository
cd ~/dev/my-project         # any project, a git repository or not
mdmem add --type feedback --name uses-bun \
  --description "This project uses bun, not node" \
  --body "Use bun for scripts and tests."   # creates the home store, ~/.mdmem/<key>/
mdmem status                # show the store and each agent's wiring in both scopes
```

Every wired agent now sees the memory, in this repository and its worktrees. An
agent's own first `memory_write` creates the store just as `add` does. Codex
asks you to review its hook once; with `--project`, each agent also needs you
to trust the folder, and Claude Code to approve the project's server; see
[What happens in each agent](#what-happens-in-each-agent).

To wire one repository for everyone who clones it instead, run
`mdmem enable --all --project` in it and commit the files it names.

## Where the store lives

A project's store has one of two placements, and every agent, the hooks, the
MCP server and the CLI find it by the same rule: the local store when
`.mdmem/` exists at the project's root, else the home store.

- **Home store** (the default): `~/.mdmem/<key>/`, where the key is the
  project's root path encoded as Claude Code names its project directories.
  Nothing appears in the repository, and it works in any directory, git or not.
- **Local store**: `.mdmem/` at the repository's root, for a team that commits
  it. `mdmem store local` moves the home store there, and `mdmem store home`
  moves it back; each refuses when the other store already holds memories.

The project's root is the repository, so its worktrees, subdirectories and
submodules share one store; outside git it is the working directory itself.
`mdmem store` prints the placement and path, and `mdmem store list` lists every
home store with its project, flagging one whose project directory is gone.
Both placements hold the same files: the memories, `MEMORY.md`, and a `project`
file naming the root the store serves.

## What happens in each agent

`mdmem enable` wires each agent in its own native way: session-start hooks
inject the memory protocol (how to recall and save memories) and the store's
index, and the mdmem MCP server gives the agent its memory tools. Only agents
with session-start hooks are supported. The wiring goes in one of two scopes:

- **global** (the default): the agent's user-wide files, so it works in every
  repository on your machine with no setup per project;
- **project** (`--project`): files committed with one repository, so everyone
  who clones it is wired.

A repository may be wired in both scopes, by different people: each session
still gets the protocol and the index once, and the agent runs one mdmem
server. Running `enable` again changes nothing, and `mdmem disable` (with
`--project` for the repository's files) removes exactly mdmem's entries and
leaves the store.

| Agent | Global scope writes | `--project` writes | Approvals mdmem cannot give for you |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json`, `~/.claude.json` | `.claude/settings.json`, `.mcp.json` | project scope: trust the folder, approve the project's mdmem server |
| Codex CLI | `~/.codex/hooks.json`, `~/.codex/config.toml` | `.codex/config.toml`, and the hook in `~/.codex/hooks.json`, shared by both scopes | review the hook once; project scope: trust the folder |
| IBM Bob | `~/.bob/settings/settings.json`, `~/.bob/settings/mcp.json` | `.bob/settings.json`, `.bob/mcp.json` | project scope: trust the folder, launch Bob at the repository's root |

With `--project`, commit the files `enable` names. Everyone working in the
repository then needs mdmem on their PATH, and so bun, until mdmem is on npm.

**Claude Code.** `enable claude-code` turns Claude's own auto memory off (on
the whole machine in the global scope, for the repository in the project
scope), adds the two hooks, and allows the mdmem tools so they run without
asking. When the store is created in a project where Claude Code is wired, in
either scope and in either placement, mdmem imports the memories Claude Code
kept for the project and its worktrees, once, and lists what it copied.
`enable` itself creates no store. In the project scope,
Claude Code runs the hooks only once you trust the folder, and connects the
project's server only once you approve it. Details:
[Claude Code](docs/reference.md#claude-code).

**Codex CLI.** The hook lives in `~/.codex/hooks.json` in both scopes, because
Codex ties a hook's approval to the path of the file that declares it: one
global hook is reviewed once, at Codex's next start or in `/hooks`, instead of
once per worktree. The scope is where the server is registered, and the hook
speaks only where your `~/.codex/config.toml` or the project's
`.codex/config.toml` registers it. Details:
[Codex CLI](docs/reference.md#codex-cli).

**IBM Bob.** In the project scope, Bob runs workspace hooks and servers only in
a trusted folder, and reads them only from the folder it was launched in, so
launch it at the repository's root. The global scope has neither limit.
Details: [IBM Bob](docs/reference.md#ibm-bob).

### Codex's own memory

Codex's own memory (`[features] memories`, under `~/.codex/memories/`) stays on
beside mdmem: `mdmem enable codex` does not touch `features.memories`, imports
nothing from it, and the check reports nothing about it. Codex writes that
memory itself after each session, as summaries of its sessions and tasks, so it
does not compete with the store, and turning it off would cost Codex its
continuity. The memory protocol tells Codex to keep what is about itself and its
sessions there and to save everything about the project, how to work in it and
what the user wants to the store. Claude Code's auto memory is different: it
holds facts the agent saves deliberately, in the store's own format, and so
competes with the store. `mdmem enable claude-code` turns it off and imports its
memories once, when the store is created
([ADR 0003](docs/adr/0003-one-store-per-project-injected-by-hooks.md)).

## Team workflow

**Share the store through git with `mdmem store local`.** The home store is
shared by your agents and your worktrees on this machine, not with your
teammates. `mdmem store local` moves it to `.mdmem/` at the repository's root;
commit that directory, and your teammates get the memories with the code and
review changes to them in pull requests. mdmem never edits `.gitignore`;
`mdmem store local` and `mdmem status` say when git does not ignore `.mdmem/`.
A committed local store suits projects without worktrees: each linked worktree
checks out its own copy of `.mdmem/`, which mdmem ignores there, since every
worktree uses the main checkout's store.

**A clone meets a local store.** Once `.mdmem/` exists, every agent uses it, and
a home store a teammate already had for the project is no longer read.
`mdmem status` warns when that home store holds memories, and names the command
that folds them in: `mdmem consolidate --from <home store>`.

**Several people writing one store.** A committed store has no per-person part.
A `user` memory describes whoever's agent saved it, and every teammate's agent
reads it at session start, so in a shared store keep to what holds for everyone:
`feedback`, `project` and `reference` memories.

**mdmem maintains `MEMORY.md`.** mdmem updates the index after every save and
delete, so its changes show up in pull requests beside the memories. When it
conflicts in a merge, keep both sides' lines and run `mdmem reindex`: it drops
duplicate pointers and pointers to deleted memories and adds the missing ones.

**Whose change wins.** On one machine, every save goes through a version check:
an agent writes a memory with the version it last read, and a write over a
newer version is refused with the current content, for the agent to merge and
retry. Between clones, git merges memories like any other file.

**Project-scope wiring and teammates.** The committed files wire every clone,
including a teammate without mdmem: their Claude Code's auto memory is off,
the committed hooks fail without blocking the session, and the committed
servers fail to start (for Codex, only the server is committed). A worktree
checked out from a commit before the wiring is not wired, and `mdmem status`
there says so; the global scope has neither gap.

## Troubleshooting

### The agent has no memory

`mdmem enable` succeeding means the files are written, not that memory works:
it cannot check folder trust in any agent, Codex's review of its hook, or
Claude Code's approval of a project's server. Go down this list in the folder
the agent was started in:

1. **Run `mdmem status`.** It shows each agent's entries in each scope and
   warns of what it can see: a missing hook, a config file that does not parse,
   hooks switched off, Claude Code's auto memory still on, `mdmem` not on PATH,
   and a folder below the root or in a submodule where an agent would miss the
   project's wiring. Each warning says how to fix it. `mdmem doctor` gives the
   same check and exits 1 on a problem.
2. **`mdmem` on PATH.** The hooks and the server run `mdmem`; without it they
   fail, and the session starts with no memory.
3. **Folder trust.** Claude Code, Bob and Codex run a project's files only in a
   folder you have trusted. In the project scope, accept the trust dialog.
4. **Codex's hook review.** Codex runs a new hook only once you have reviewed
   it, at its next start or in `/hooks`, and asks again when a `SessionStart`
   group before mdmem's in `~/.codex/hooks.json` is added or removed, or
   mdmem's is edited.
5. **Claude Code's server approval** (project scope). Claude Code asks each
   user to approve the server in `.mcp.json`; until then the mdmem tools are
   missing, and the agent writes memory files directly, which its sandbox
   refuses for a home store. Approve it, then run `mdmem reindex` to bring the
   index up to date.
6. **Hooks switched off.** `disableAllHooks: true` in Claude Code's settings,
   or `disableWorkspaceHooks: true` in `.bob/settings.json`. `status` reports
   both.
7. **Started below the root** (project scope). Claude Code and Bob read a
   project's files only from the folder they start in, so started in a
   subdirectory they get no protocol and no index, Bob no mdmem tools, and
   Claude Code keeps its auto memory on unless your user settings turn it off.
   Start them at the root, or wire the global scope.
8. **A Codex worktree without `.codex/config.toml`** (project scope). A
   worktree checked out from a commit before the wiring has no
   `.codex/config.toml`, so Codex's hook prints nothing there. Bring the commit
   in, or register the server globally with `mdmem enable codex`.
9. **A resumed session.** The hooks print nothing on a resumed or forked
   session, whose history already holds what its start injected, so a session
   started before mdmem was wired still lacks it when resumed. Start a new one.

Hooks that do not run leave an agent with no protocol and no index, and mdmem
has no fallback. Every state `status` and the check report:
[What status and the check report](docs/reference.md#what-status-and-the-check-report).

### Claude Code still saves to its own memory

`autoMemoryEnabled` is not `false` where Claude Code reads it first
(`.claude/settings.local.json`, then `.claude/settings.json`, then your user
settings), or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is set to `0`, `false`, `no` or
`off`. A project's `true` overrides your user settings' `false`. `mdmem status`
reports it.

### The index is cut short at session start

The hook injects at most 9,500 characters of `MEMORY.md` and tells the agent to
`memory_read` the rest. `mdmem doctor` reports the index near or over that size.
Shorten descriptions, or merge or delete memories, for instance through a
[consolidation](#consolidation).

## Memory format

One file, one fact: `<name>.md` in the store.

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

The types are `user`, `feedback`, `project` and `reference`.
`feedback`/`project` memories add `**Why:**` and `**How to apply:**` lines; link
related memories with `[[name]]`. A link may name a memory not written yet, as
`[[ts7-strict]]` does here: it marks a memory worth writing.

`MEMORY.md` holds one pointer per memory, `- [uses-bun](uses-bun.md) — This
project uses bun, not node`. Agents only write their own memory files, and
mdmem keeps the index up to date after every save or delete through it, keeping
the lines it did not write, so an index written by hand or by Claude Code
survives. When an agent writes a memory file directly, run `mdmem reindex`, or
let the next save do it. mdmem reads memories as loosely as Claude Code writes
them, and writes them strictly: the name must equal the file name. The rules:
[How mdmem keeps the index](docs/reference.md#how-mdmem-keeps-the-index) and
[Memory format](docs/reference.md#memory-format).

## MCP server

`mdmem mcp`, which each agent starts in the session's working directory, serves
the same memory-store tools as Claude Code, `memory_list`, `memory_read`,
`memory_write` and `memory_delete`, plus `memory_search`, `memory_check` and
the prompt `consolidate`. Every write and delete carries the version the agent
last read (`new` for a new memory), and a write over a newer version is refused
with the current content. The first `memory_write` creates the store, in its
home placement unless a local store exists. Each
tool's arguments and results:
[MCP server](docs/reference.md#mcp-server).

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

With an agent named (`--agent`, or the prompt's `agent` argument), the prompt
tells the agent where its past sessions of the project are. With a second store
named (`--from <dir>`, or the prompt's `from` argument), such as a home store a
local one hides, the agent merges its memories into the project's store, then
deletes it. The agent orients
on the store, looks for memories the code has drifted from, merges and dates
what it learned, deletes stale memories, and flags feedback and project
memories that disagree with the project's instruction files, which it never
edits. Where each agent's sessions are:
[Consolidation](docs/reference.md#consolidation).

## Commands

The CLI is for you, your scripts and setup; the MCP server, on the same core,
is for the agents. `mdmem --help` lists the commands by who runs them:
setting up and looking after a project (`enable`, `disable`, `status`,
`store`, `doctor`, `consolidate`), working with memories (`add`, `read`, `edit`,
`delete`, `list`, `search`, `reindex`, `path`), and run by the agents (`hook`,
`mcp`).
`mdmem <command> --help` prints one command's options and refusals. The full
table, store resolution (bare repositories, submodules, outside git) and the
files each agent's wiring writes are in [docs/reference.md](docs/reference.md).

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
