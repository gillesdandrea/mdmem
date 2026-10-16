# mdmem mirrors Claude Code's memory-store tools

mdmem reproduces Claude Code's memory system: the same vocabulary, the same memory file format, and over MCP the same tools Claude Code uses for its shared memory stores (`memory_list`, `memory_read`, `memory_write`: whole-document writes addressed by path and guarded by a required `if_version`). A `.memory/` store is shared by many agents, which is the case Claude Code serves through tools rather than direct file edits, so agents save through mdmem whenever they can. We chose this over mdmem's earlier structured tools (`memory_write` with `name`, `description`, `type` and `body` fields) so that an agent which knows Claude Code's memory needs nothing new to learn.

## Consequences

- The files stay the source of truth. Direct edits remain legal, `mdmem reindex` repairs the index after them, and `mdmem doctor` reports what they broke.
- The `claude-code` adapter keeps pointing Claude Code's auto memory at the store with `autoMemoryDirectory`. Claude Code edits that directory directly and writes its own pointers, and mdmem cannot route its built-in memory through tools.
- The index is generated from the memories' frontmatter, as Claude Code does for its shared stores, not hand-written as in its private auto memory. A pointer's title is the memory's name, because the format has no title field.
- mdmem adds tools Claude Code lacks: `memory_search`, `memory_check` (the check `mdmem doctor` runs), and `memory_delete` (Claude Code deletes memory files with `rm`).
