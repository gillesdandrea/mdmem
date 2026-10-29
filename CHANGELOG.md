# Changelog

All notable changes to mdmem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The next release is 0.3.0. **Breaking**, for anyone who ran 0.2.0:

- `mdmem enable` without `--project` now writes each agent's user-wide files,
  so the agent is wired in every repository on the machine (the global scope);
  `mdmem enable --project` writes the repository's files, as 0.2.0's `enable`
  did. `mdmem disable` mirrors it, and `disable --global` is gone. A
  repository 0.2.0 wired for Claude Code or Bob keeps working unchanged, as one
  wired in the project scope.
- Codex's project scope writes its hooks to the repository's
  `.codex/hooks.json`, beside the server in `.codex/config.toml`, and no longer
  to `~/.codex/hooks.json`. A repository 0.2.0 wired for Codex has the server
  but no hooks: run `mdmem enable codex --project` there once and commit
  `.codex/hooks.json`, then review the hooks in an interactive Codex session.
  0.2.0's unmarked hook group in `~/.codex/hooks.json` now injects beside each
  project's own hook: `mdmem enable codex` replaces it with the global scope's
  marked group, saying so, and `mdmem disable codex` removes it; `mdmem status`
  and `mdmem enable codex --project` warn of it.
- `enable --prefer` is gone: Claude Code's memories are imported when a store
  is created, which holds nothing they could conflict with, instead of by
  `enable claude-code`. A store that already exists gets no import.
- `mdmem init` is gone: the first memory write (`memory_write`, `mdmem add`)
  creates the store, in any directory. `mdmem init` is refused with one line
  saying so, and `mdmem status` says where the store would be.
- The store is the home store by default, `~/.mdmem/<key>/`, keyed by the
  project's root path as Claude Code keys its project directories, and `.mdmem/`
  at the root only on purpose, created with `mdmem store local` (ADR 0005).
  `.mdmem/` replaces `.memory/`, which mdmem no longer reads anywhere: rename
  a 0.2.0 store by hand (`mv .memory .mdmem`) to keep it as a local store,
  then run `mdmem store home` for a home store.
- Outside git the working directory is the project, with no walk-up to a store
  above it, and the session-start hook speaks there as in a repository.
- `mdmem enable --project` writes the wiring files only: it no longer creates
  the store, which the first save creates.

### Added

- Two wiring scopes (ADR 0004). The global scope writes Claude Code's
  `~/.claude/settings.json` and the top-level `mcpServers` of `~/.claude.json`
  (in `$CLAUDE_CONFIG_DIR` when set), Bob's `~/.bob/settings/settings.json` and
  `~/.bob/settings/mcp.json`, and Codex's `~/.codex/hooks.json` and
  `[mcp_servers.mdmem]` in `~/.codex/config.toml`. Its hook entries run
  `mdmem hook <agent> <part> --global`, which stays silent where the project's
  own entry for that part is present, so a repository wired in both scopes
  gets the protocol and the index once. Codex's global entries also stay
  silent below the root and in a linked worktree, where Codex reads the
  project's `.codex/hooks.json` too (Codex 0.164.0). Claude Code's global
  entries stay silent only in a folder its `~/.claude.json` records as
  trusted, since it runs the project's hooks nowhere else: in an untrusted
  folder they speak and say why on stderr. A `claude -p` session in an
  untrusted folder gets each part twice.
- `mdmem status` and the check note each agent wired in both scopes; the note
  is not a problem.
- The store is created on the first save: with no store yet, the first
  `memory_write` or `mdmem add` creates the home store with its `MEMORY.md`
  and a `project` file naming the root it serves, reporting its placement and
  path and what the import copied. Until then the session-start hook speaks
  anyway, in every directory, its index part naming the home store the first
  save creates, and reads refuse, saying the same.
- `mdmem store` prints the store's placement and path, `Store: home, <path>` or
  `Store: local, <path>`; `mdmem store local` moves the home store to `.mdmem/`
  at the project's root (or creates an empty local store), and
  `mdmem store home` moves it back, each refusing when the destination already
  holds memories and naming the other store; `mdmem store list` prints every
  home store with its key, project path, memory count, and `project missing`
  when the project's directory is gone.
- `mdmem consolidate --from <dir>`, and the MCP prompt's `from` argument, name a
  second store for the consolidation to fold into the project's, then delete.
- Every line that names the store names its placement: `mdmem status`,
  `mdmem doctor` and `memory_check` open with it, and the hook's index part with
  `Store: home, <path>` or `Store: local, <path>`. The note that git does not
  ignore the store appears for a local store only. `mdmem status` warns when a
  local store hides a home store that holds memories, naming
  `mdmem consolidate --from` to fold them in.
- The memory protocol names the store's path for writing memory files without
  the tools, and says that a sandboxed agent may not reach a home store without
  them, so it tells the user.
- `mdmem status`, `mdmem doctor` and `memory_check` work without a store, where
  they report the wiring alone, and list each agent's wiring per scope.
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
  that answered, `Store: <id> (<placement>, <path>)`: the id `memory_list` gives
  it, `home` or `local`, and its directory. `memory_read`'s structured result
  carries it as `store`, with `id`, `placement` and `path`.
- The memory protocol says to check a claim a memory makes about an external
  tool, library or service before acting on it or repeating it, since a memory
  records what was believed when it was written; to name the path of the memory
  an answer comes from; to load every mdmem tool in one request where the agent
  loads tools on demand; that the store is the primary place for project
  knowledge and what the user wants, saved unasked, while a memory the agent's
  harness keeps of its own holds what is about the agent and its sessions,
  under that harness's rules for when to update it; that the user's current
  instructions and verified facts take precedence over any memory, and the
  store over older notes in the harness's memory on anything about the project;
  and that a file in the store reported changed on disk right after the agent's
  own `memory_write` is that write.
- README's "Codex's own memory" section says Codex's own memory stays on
  beside mdmem, and why Claude Code's auto memory is turned off instead.
- `mdmem hook` says on stderr why it printed nothing: no payload on stdin
  (with the `echo … | mdmem hook <agent> <part>` command that shows what it
  would inject in the working directory), an event other than SessionStart, a
  resumed or forked session, or a `--global` entry beside the project's own
  (naming the project's settings or hooks file). Stdout and the exit code are
  unchanged, and stderr never reaches the agent's context.
- A store mdmem creates, on the first memory write or with
  `mdmem store local`, opens its `MEMORY.md` with a header: an HTML comment
  naming the project the store serves and saying how to use the store without
  the mdmem tools, for an agent or a person who opens the directory. `reindex`
  keeps it and never adds it to a store without one; a move keeps it. The
  import of Claude Code's memories into a new store keeps it first.

### Changed

- `memory_search` and `mdmem search` match the words of the query instead of
  the whole query as one piece of text: each word is stemmed and matched on its
  own in a memory's name, description, headings or body, so "TypeScript Bun"
  finds "TypeScript, Bun", "configuring" finds "configured" and
  "memory enabled" finds `autoMemoryEnabled`; accents and case are folded.
  Hits come best match first, ranked as Claude Code ranks its own memories
  (BM25F, a match in the name or description counting most), and every hit is
  listed. Quoted text is required as an exact phrase of whole words. Unlike
  Claude Code, common English and French function words in the query are
  ignored, and frontmatter keys such as `type:` are not matched, only their
  values. The output keeps its shape.
- README is a user document: why mdmem exists, install (bun required until
  mdmem is on npm), the quickstart, what happens in each agent and the
  approvals it needs, where the store lives (home or local), a team workflow
  (sharing the store through git with `mdmem store local`,
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
  `memory_write`'s carries `file`, `version`, `created` (the store's path and
  placement, the import's lines, and for a local store whether git ignores it)
  on the write that created the store,
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
- `mdmem status` no longer warns, below the root of a repository wired for Bob
  in both scopes, that a Bob launched there gets no memory protocol, no index
  and no mdmem tools: the global scope's hooks speak there and its `mcp.json`
  registers the server, so that Bob gets all three.
- Bob's below-root warning names what a partly wired global scope leaves out:
  no mdmem tools when it holds only the hooks, no memory protocol and no index
  when it holds only the server. It used to claim all three were missing. It
  also names `mdmem enable bob` as a fix beside launching Bob at the root.
- `enable --project` and `disable --project` refuse in the home directory and
  say to use the global scope: there Claude Code's and Codex's project files
  are, by default, their user-wide files, so `enable claude-code --project` put
  the project hooks in
  `~/.claude/settings.json`, where every session in every project ran them
  beside the global ones. `mdmem status` in the home directory shows the global
  scope only, instead of listing the same files under both scopes.
- `mdmem store local` refuses in a repository whose git directory is not named
  `.git` (a bare `x.git`, a worktree of one, or a work tree made with
  `--separate-git-dir`), where it created the local store inside the git
  directory, in no work tree and so impossible to commit. It names the home
  store the project keeps. Beside a bare repository at `<dir>/.git`, and outside
  git, it still creates the local store.

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
