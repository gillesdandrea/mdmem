# Changelog

All notable changes to mdmem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
