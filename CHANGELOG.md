# Changelog

All notable changes to mdmem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-24

0.3.0 is the first release of mdmem, on npm as `@gillesdandrea/mdmem`. It
needs Node 22 or later.

### Added

- **One memory per project**, shared by Claude Code, Codex CLI and IBM Bob:
  Markdown memories in Claude Code's format, with an index, `MEMORY.md`. A
  repository shares one store with its worktrees.
- **`mdmem enable --all`** wires the agents found on the machine, once, for
  every project. `--project` wires one repository instead, in files to commit.
  `mdmem disable` removes exactly what `enable` added.
- **The store** is created by the first save, in `~/.mdmem/`.
  `mdmem store local` moves it into the repository, to commit with the code.
- **Recall.** A session starts with the memory protocol and the index.
  `mdmem enable` wires the per-prompt hook: before each prompt, the agent gets
  pointers to the memories that changed and to up to 5 that bear on the prompt.
- **An MCP server** the agents save through: `memory_list`, `memory_read`,
  `memory_write`, `memory_delete`, `memory_search` and `memory_check`. A write
  needs the version from the agent's last read, so two agents do not overwrite
  each other.
- **Search by words**, stemmed, best match first, with `memory_search` and
  `mdmem search`. Quotes require an exact phrase.
- **Import.** A new store imports Claude Code's memories of the project.
  `enable` turns Claude Code's own auto memory off, which would compete with
  the store.
- **Commands for the shell:** `mdmem add`, `read`, `edit`, `delete`, `list`,
  `search`, `reindex` and `path`.
- **`mdmem status` and `mdmem doctor`** show and check the store and each
  agent's wiring. Each problem says how to fix it.
- **`mdmem consolidate`** prints a prompt that has an agent merge, correct and
  prune the store.

The [reference](docs/reference.md) describes each of these.

[Unreleased]: https://github.com/gillesdandrea/mdmem/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/gillesdandrea/mdmem/releases/tag/v0.3.0
