# Consolidate the memory store

You are performing a consolidation — a reflective pass over this project's memory
store, what Claude Code calls a *dream*. Synthesize what you've learned recently into
durable, well-organized memories so that future sessions can orient quickly.

Memory store: `{{store}}`

The memory protocol injected at the start of your session is the source of truth for
the memory format, the memory types, and what to save.

## Scope

Read anything: the code, the git history, your project instruction files. Change only
memory documents in the memory store.

When you are pointed at Claude Code's memory directories because
`mdmem enable claude-code` refused its import, merge each memory they hold into the
store's memory of the same file name, creating it under that file name when the
store has none: `--prefer mdmem` keeps only a store file of the same name. End your
summary by telling the user to run `mdmem enable claude-code --prefer mdmem`, which
keeps the merged files.

Save through the mdmem MCP tools, always: `memory_list` lists the store,
`memory_read` returns a memory document with its version, and `memory_write` and
`memory_delete` take that version as `if_version`. Only when the tools are missing,
edit the memory files directly, then run `mdmem reindex`; a direct write can fail
when the store lies outside your workspace, as it does from a linked worktree or a
sandbox.

---

## Phase 1 — Orient

- List the memory store to see what already exists
- Read the index, `MEMORY.md`, to see every memory's pointer
- Skim the existing memories so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Memories that drifted** — memories that contradict something you see in the
   code now
2. **Past sessions** — if you can search your own past sessions and need specific
   context (e.g., "what was the error message from yesterday's build failure?"),
   search them for narrow terms

Search past sessions only for things you already suspect matter, a few narrow terms
at a time.

## Phase 3 — Consolidate

For each thing worth saving, save a memory in the memory store: update the memory
that already covers it, or write a new one.

Focus on:

- Merging new signal into existing memories rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they
  remain interpretable after time passes
- Deleting contradicted memories — if the code disproves a memory, delete it, or
  correct the memory

## Phase 4 — Prune

mdmem keeps the index up to date from the memories, one pointer per memory:
`- [name](name.md) — description`. It updates the index after every save through
the tools and on `mdmem reindex`, so you shape the index through the memories
alone. Never edit `MEMORY.md`.

Keep the whole index under about {{index_max_chars}} characters, the size a
session-start hook can inject; a save warns as it nears that limit, and
`memory_check` (or `mdmem check`) reports an index over it.

- Shorten the description of any memory whose pointer runs past
  ~{{pointer_max_chars}} characters, and move the detail into its body
  (`memory_check` names them)
- Delete memories that are now stale, wrong, or superseded; their pointers go with
  them
- Resolve contradictions — if two memories disagree, fix the wrong one

## Phase 5 — Reconcile memories against instruction files

Your project instruction files (AGENTS.md, CLAUDE.md, rule files: whichever your
agent loads) are the maintained, checked-in source. For each feedback memory and
project memory, check whether it contradicts an instruction on the same topic:

- **The memory is stale** — the instruction file and the memory describe different
  procedures for the same task. Delete the memory, or rewrite it to agree if it
  carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **The instruction file may be stale** — the memory is clearly dated after the
  instruction file and explicitly corrects it. Leave the instruction file as it is:
  annotate the memory with "contradicts <file> — verify which is current" and list
  it in your summary so the user can update the file.
- **No conflict** — the memory adds detail the instruction files don't cover, or
  narrows one of their rules with a stated reason. Leave it.

A feedback memory's "the user corrected me" framing is not evidence it is newer than
the instruction file — the file may have been updated since.

---

Return a brief summary of what you consolidated, updated, or pruned, listing every
memory you annotated as contradicting an instruction file. If nothing changed (the
memories are already tight), say so.
