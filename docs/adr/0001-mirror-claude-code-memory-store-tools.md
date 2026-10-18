# mdmem mirrors Claude Code's memory-store tools

mdmem reproduces Claude Code's memory system: the same vocabulary, the same memory file format, and over MCP the same tools Claude Code uses for its shared memory stores (`memory_list`, `memory_read`, `memory_write`: whole-document writes addressed by path and guarded by a required `if_version`). A `.memory/` store is shared by many agents, which is the case Claude Code serves through tools rather than direct file edits, so agents save through mdmem whenever they can. We chose this over mdmem's earlier structured tools (`memory_write` with `name`, `description`, `type` and `body` fields) so that an agent which knows Claude Code's memory needs nothing new to learn.

## Consequences

- The files stay the source of truth. Direct edits remain legal, `mdmem reindex` repairs the index after them, and `mdmem doctor` reports what they broke.
- In a project using mdmem, Claude Code's own auto memory is off and Claude saves through these tools like every other agent (ADR 0003).
- mdmem updates the index in place rather than regenerating it (amended 2026-10-17), so a hand edit or an imported Claude index survives: it keeps every line it did not write, appends a pointer for a memory that has none, removes pointers to missing files and duplicate pointers, and rewrites only descriptions. A pointer mdmem writes is titled with the memory's name, because the format has no title field; a pointer titled that way, then ` — `, takes its memory's description on every save and `mdmem reindex`, so a direct edit reaches the index (amended 2026-10-18), and any other pointer takes a new description only when a save of its memory through mdmem changes it, or finds no ` — ` on it.
- mdmem reads memories as loosely as Claude Code writes them (any name, `type` at the top level or under `metadata`, unknown fields kept), so imported Claude memories parse, and writes only memories named after their file.
- mdmem adds tools Claude Code lacks: `memory_search`, `memory_check` (the check `mdmem doctor` runs), and `memory_delete` (Claude Code deletes memory files with `rm`).
