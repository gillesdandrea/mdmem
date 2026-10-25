# Changelog

All notable changes to mdmem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The next release is 0.3.0. **Breaking**, for anyone who ran 0.2.0:

- `mdmem enable` without `--project` now writes each agent's user-wide files,
  so the agent is wired in every repository on the machine (the global scope);
  `mdmem enable --project` writes the repository's files, as 0.2.0's `enable`
  did. `mdmem disable` mirrors it, and `disable --global` is gone: in the
  global scope, `mdmem disable codex` removes Codex's hook and its user-wide
  server. A repository 0.2.0 wired keeps working unchanged, as one wired in the
  project scope.
- `enable --prefer` is gone: Claude Code's memories are imported when a store
  is created, which holds nothing they could conflict with, instead of by
  `enable claude-code`. A store that already exists gets no import.
- `mdmem init` is gone: the first memory write (`memory_write`, `mdmem add`)
  creates the store everywhere, at a repository's root or, outside git, in the
  working directory, and `mdmem enable --project` creates it too, in a
  repository or, outside git, in the working directory. `mdmem init` is refused with one line saying so, and
  `mdmem status` says where the store would be.

### Added

- Two wiring scopes (ADR 0004). The global scope writes Claude Code's
  `~/.claude/settings.json` and the top-level `mcpServers` of `~/.claude.json`
  (in `$CLAUDE_CONFIG_DIR` when set), Bob's `~/.bob/settings/settings.json` and
  `~/.bob/settings/mcp.json`, and Codex's `~/.codex/hooks.json` and
  `[mcp_servers.mdmem]` in `~/.codex/config.toml`. Its hook entries run
  `mdmem hook <agent> <part> --global`, which stays silent where the project's
  own entry for that part is present, so a repository wired in both scopes
  gets the protocol and the index once. Codex keeps one hook for both scopes,
  speaking where either config registers the server.
- The store is created on the first save: in a git repository with no
  `.memory/`, the first `memory_write` or `mdmem add` creates it with its
  `MEMORY.md`, reporting its path, what the import copied, and whether git
  ignores it. Until then the session-start hook speaks anyway, its index part
  saying the store does not exist yet, and reads refuse, saying what creates
  it. Outside git the first write creates the store in the working directory,
  and the hook speaks only where one exists.
- `mdmem status`, `mdmem doctor` and `memory_check` work without a store and
  outside any repository, where they report the wiring alone, and list each
  agent's wiring per scope.
- `mdmem version`, `mdmem --version`, `-v` and `-V` print `mdmem <version>`,
  read from `package.json` as the MCP server reads it, so the two report the
  same version.
- `memory_write` says what the write did to the memory's pointer in
  `MEMORY.md`, on a line such as `MEMORY.md: pointer added` and in the
  structured result's `index`: `pointer added`, `pointer updated` (its line
  changed: a new description, or a pointer brought into mdmem's form) or
  `unchanged`, which is also what a write reports when the index could not be
  updated, beside the warning that it is stale.
- `memory_search` and `memory_read` results open with a line naming the store
  that answered, `Store: <id> (<path>)`: the id `memory_list` gives it and its
  directory. `memory_read`'s structured result carries it as `store`, with `id`
  and `path`.
- The memory protocol says to check a claim a memory makes about an external
  tool, library or service before acting on it or repeating it, since a memory
  records what was believed when it was written; to name the path of the memory
  an answer comes from; to load every mdmem tool in one request where the agent
  loads tools on demand; to keep project knowledge in the store where the
  agent keeps a memory of its own; and that a file under `.memory/` reported
  changed on disk right after the agent's own `memory_write` is that write.
- README's "Codex's own memory" section says Codex's own memory stays on
  beside mdmem, and why Claude Code's auto memory is turned off instead.

### Changed

- README is a user document: why mdmem exists, install (bun required until
  mdmem is on npm), the quickstart, what happens in each agent and the
  approvals it needs, a team workflow (committing or ignoring `.memory/`,
  several people writing one store, `MEMORY.md` in pull requests, the version
  check) and troubleshooting, starting with "the agent has no memory". The
  reference detail it held (store resolution, the index rules, the commands
  table, what `status` and the check report, each agent's files, the MCP tools,
  the consolidation prompt's session paths) moved to `docs/reference.md`.
- `mdmem --help` is one page of 30 lines: the commands in three groups by who
  runs them (setting up and looking after a project, working with memories,
  run by the agents), each on one line, then `-h, --help` and `-v, --version`.
  Each command has its own page, from `mdmem <command> --help`, `-h` or
  `mdmem help <command>`: its usage, what it does, its options, an example
  and the refusals it can give. `enable` and `disable`'s pages explain both
  scopes and the files each one writes, and list the agents; `add`'s lists
  the memory types. `--help` and `-h` used to fail on a command with a parser
  error. An unknown command, or `mdmem help` of one, prints a line naming it,
  the usage line and where to find a command's help, and exits 1. To search
  for `-h` or `--help`, put `--` before it: `mdmem search -- -h`.
- The import of Claude Code's memories never refuses: when Claude Code's
  directories hold different versions of a file, the repository's own
  directory's version is copied and the others are listed as left in Claude's
  directories.
- The memory protocol injected at session start is less than half its size:
  about 4,800 characters instead of 9,700, and a test holds it at 6,000 at
  most, about three times Claude Code's own memory block, since every wired
  agent reads it at every session start, `/clear` and compaction. It keeps the
  memory format and the four types, the index rule, recall, what to save and
  what not to, the MCP save loop (`if_version` with `new`, and a conflict
  returning the current content and version), the no-tools fallback (read the
  store's files, write a memory then `mdmem reindex`) and consolidation, and
  now names `memory_list` and `memory_check`. Gone are the per-type "when to
  save" and "how to use" guidance, the reply-by-reply save checklist and the
  "ignore memory" and "forget" paragraphs; keeping a memory's name, description
  and type in step with its body moved to the consolidation prompt.

### Fixed

- `memory_read` and `memory_write` no longer hide their content from agents
  that read the structured result, as Claude Code does when a tool declares an
  output schema: the structured result held only the version, so the agent saw
  no content. `memory_read`'s now carries `path`, `content` and `version`;
  `memory_write`'s carries `file`, `version`, `created` (the store's path, the
  import's lines, whether git ignores it) on the write that created the store,
  and `warnings`; a version conflict's carries its message, `path`, the current
  `content` and `version`. The text is unchanged, for clients that read it.
- Claude Code shows each mdmem tool's title: every tool now carries it in
  `annotations.title`, where Claude Code reads it, beside the top-level
  `title`, with `readOnlyHint` on `memory_list`, `memory_search`,
  `memory_check` and `memory_read`, `destructiveHint` and `idempotentHint` on
  `memory_write` and `memory_delete`, and `openWorldHint` false on all six.
- The import of Claude Code's memories rewrites a memory's `name` to its file
  name when the two differ (`team-lead.md` holding `name: Team Lead`), and
  lists each one under "Renamed to match the file name:". Such a memory was
  copied unchanged, so `mdmem doctor` failed right after the import and mdmem
  could not save the memory until its name was fixed by hand. Its title in
  `MEMORY.md` is left as Claude wrote it.
- `mdmem status` warns when it runs below the root of a repository wired for
  Claude Code in the project scope, as it already did for Bob: Claude
  Code reads `.claude/settings.json` only from the folder it is started in, so
  a Claude Code started there runs neither mdmem hook and gets no memory
  protocol and no index. The warning says to start it at the root or wire the
  global scope; a repository whose user settings also hold mdmem's hooks gets
  no warning.

## [0.2.0] - 2026-10-21

The first tagged release. Version 0.1.0 was never tagged, so this release covers
everything since the initial commit.

**Breaking**, for anyone who ran an earlier checkout:

- The project is now mdmem: the command is `mdmem` (the `memory` and `mem`
  commands are gone), and the MCP server registers as `mdmem`.
- One store per repository: `.memory/` at the repository's root, shared by every
  worktree, subdirectory and submodule. `mdmem init` no longer edits
  `.gitignore`.
- Agents are wired by session-start hooks and a project-level MCP server. The
  Cursor and AGENTS.md (`agents`) adapters are gone.
- In a project wired for Claude Code, Claude's auto memory is turned off, and
  its existing memories are imported once.
- The MCP tools were renamed: `memory_index` became `memory_list` and
  `memory_remove` became `memory_delete`. `memory_read`, `memory_write` and
  `memory_delete` take a document's path in the store, such as `prefers-bun.md`,
  not a bare name. `memory_write` takes a whole document instead of separate
  fields. `memory_write` and `memory_delete` require `if_version`, which replaces
  `memory_write`'s optional `ifVersion`.
- "fact" became "memory", and a memory's slug or id became its name.
- There is no migration from earlier installs: re-run `mdmem enable`. mdmem no
  longer reads or removes the wiring earlier versions wrote (the AGENTS.md block,
  `.cursor/rules/memory.mdc`, `.bob/rules/memory.md`, `autoMemoryDirectory` in
  `.claude/settings.local.json`), so delete it by hand.

### Added

- A Codex CLI adapter: `mdmem enable codex` adds a session-start hook to
  `~/.codex/hooks.json` (`$CODEX_HOME/hooks.json` when `CODEX_HOME` is set) and
  the mdmem server to the
  project's `.codex/config.toml`.
- `mdmem hook <agent> <part>`, which agents' session-start hooks run to inject
  the memory protocol and the index, each under 10,000 characters.
- `mdmem enable --prefer claude|mdmem` settles a Claude Code import conflict;
  `mdmem disable codex --global` also removes Codex's global hook.
- `mdmem consolidate [--agent <agent>]` and the MCP prompt `consolidate`: a
  prompt that has an agent merge, correct and prune the store. With
  `--agent claude-code` or `--agent codex` it points at that agent's past
  sessions of the project.
- The MCP tool `memory_check`, the check `mdmem doctor` runs.
- `mdmem doctor` (alias `check`) also checks the agents' wiring: an agent config
  file it cannot read, a session-start hook missing or switched off, Claude
  Code's auto memory still on, `mdmem` not on PATH. It reports conflicting
  memory types, secrets, pointers over 150 characters, and an index over 9,500
  characters.
- Memories that look like they hold a secret are refused.

### Changed

- IBM Bob is wired by session-start hooks in `.bob/settings.json` and the mdmem
  server in `.bob/mcp.json`; Claude Code by `.claude/settings.json` and
  `.mcp.json`. These files are meant to be committed.
- `memory_list` lists documents by path with size and date, and with no
  arguments lists the stores. `memory_write` and `memory_delete` require the
  version from your last read or write; `memory_write` takes `new` for a new
  file. A conflict returns the current content and version. Both refuse a path
  inside a directory.
- The memory protocol follows Claude Code's own memory instructions: when to
  save each type of memory and how to structure it, what not to save, and
  checking a recalled memory before acting on it.
- mdmem updates `MEMORY.md` in place instead of regenerating it, so lines written
  by hand or by Claude Code survive. `mdmem reindex` no longer refuses when a
  memory does not parse.
- Memories are read as loosely as Claude Code writes them and written strictly:
  a saved memory's name must equal its file name, in kebab-case or snake_case.
- A `[[link]]` to a memory not written yet is a note, not a problem.
- `mdmem edit` refuses an invalid or conflicting edit and keeps the copy;
  `mdmem add --force` refuses to overwrite a memory that changes while it is
  saved.
- `mdmem enable --all` and `mdmem disable --all` act on the agents found on this
  machine.
- `mdmem status` shows the check in one line and each agent's wiring entry by
  entry, with warnings for a submodule or a Bob launched below the checkout's
  root.
- `mdmem enable` and `mdmem disable` check every file before writing any, merge
  into the agents' files and remove only mdmem's own entries. `enable` refuses
  in a bare repository; `disable` works without a store.

### Removed

- The Cursor and AGENTS.md (`agents`) adapters. Only agents with session-start
  hooks are supported.
- Claude Code wiring through `autoMemoryDirectory`, and Bob's
  `.bob/rules/memory.md` rule file.
- The `memory` and `mem` commands.

[Unreleased]: https://github.com/gillesdandrea/mdmem/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/gillesdandrea/mdmem/releases/tag/v0.2.0
