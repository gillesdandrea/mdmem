# mdmem mirrors Claude Code's memory-store tools

mdmem reproduces Claude Code's memory system: the same vocabulary, the same memory file format, and over MCP the same tools Claude Code uses for its shared memory stores (`memory_list`, `memory_read`, `memory_write`: whole-document writes addressed by path and guarded by a required `if_version`). A `.memory/` store is shared by many agents, which is the case Claude Code serves through tools rather than direct file edits, so agents save through mdmem whenever they can. We chose this over mdmem's earlier structured tools (`memory_write` with `name`, `description`, `type` and `body` fields) so that an agent which knows Claude Code's memory needs nothing new to learn.

## Consequences

- The files stay the source of truth. Direct edits remain legal, `mdmem reindex` repairs the index after them, and `mdmem doctor` reports what they broke.
- Claude Code shares the store through its own auto-memory directory (ADR 0003). It edits that directory directly and writes its own pointers, and mdmem cannot route its built-in memory through tools.
- The index has two writers, Claude Code by hand and mdmem, so mdmem updates it in place rather than regenerating it (amended 2026-10-17): it keeps every line it did not write, appends a pointer for a memory that has none, removes pointers to missing files, and rewrites only the description of a memory it saves. A pointer mdmem writes is titled with the memory's name, because the format has no title field.
- mdmem reads memories as loosely as Claude Code writes them (any name, `type` at the top level or under `metadata`, unknown fields kept) and writes only memories named after their file.
- mdmem adds tools Claude Code lacks: `memory_search`, `memory_check` (the check `mdmem doctor` runs), and `memory_delete` (Claude Code deletes memory files with `rm`).
