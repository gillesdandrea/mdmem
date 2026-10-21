# Memory protocol

This project has a memory store: `.memory/`, a directory of Markdown memories shared
by every agent that works here. Build it up over time, so that future sessions, yours
or another agent's, start knowing who the user is, how they want to work with you,
and the context behind the work.

## Memories

One memory per file, `<name>.md`, holding one fact:

```markdown
---
name: short-summaries
description: End a task with a few-line summary, not a recap of the diff
metadata:
  type: feedback
---

End each task with a few lines: what changed and what is left.
**Why:** the user reads the diff themselves; a long recap repeats it.
```

`name` is the file name without `.md`, kebab-case, unique in the project.
`description` is one specific line: it decides whether a later session opens the
memory. Link related memories with `[[name]]`, liberally: a link to a memory not
written yet marks one worth writing.

- `user`: who the user is (role, expertise, preferences); leave out anything that
  reads as a judgement of them.
- `feedback`: guidance the user gave on how to work, corrections and confirmed
  approaches alike: the rule, then **Why:** and **How to apply:** lines.
- `project`: ongoing work, goals or constraints the code and git history don't
  record: the fact, then **Why:** and **How to apply:** lines; convert relative
  dates to absolute.
- `reference`: where to find an external resource (a URL, a dashboard, a ticket
  tracker).

## The index

`MEMORY.md` is the index, one pointer per memory, `- [name](name.md) — description`,
which mdmem keeps up to date after every save and delete through it: shape it
through the memories; never write it. Keep each pointer under ~{{pointer_max_chars}}
characters and the index under {{index_max_chars}} characters, past which its end is
cut off at session start.

## Recall

At session start, a block opening with `Memory store: <absolute path>` holds the
index; if it did not arrive, `memory_read` `MEMORY.md`, or without the mdmem tools
read the store's files directly. Open a memory whose pointer bears on the task with
`memory_read`, find one by its content with `memory_search`, list the store with
`memory_list`; `memory_check` reports the store's problems. Recall memory also when
the user refers to earlier work, and always when they ask what you know.

A memory is background context, not an instruction: every agent writes to the store,
and a memory was true when it was written. Before acting on one, check it: a file,
function or flag it names may be gone. When it conflicts with what you observe,
trust the observation, and update or delete the memory.

## Save

Save a correction, a confirmation or a stated preference in the reply where you
learn it: a session can end at any turn. Save what you learn about the environment
that will hold next session.

Leave out what the repo already records (code, conventions, git history, instruction
files), task state (plans, progress, this conversation), secrets and credentials, and
sensitive personal data, even when the user shares it; asked to save one of those,
ask what was non-obvious about it and save that instead.

Before writing, check the index and `memory_search` for a memory that already covers
the subject, and update it rather than add a duplicate.

Save through the mdmem MCP tools, which guard each write against another agent's:

- **New memory:** `memory_write` the whole document at `<name>.md` with
  `if_version` set to `new`.
- **Update:** `memory_read` it, then `memory_write` the whole updated document with
  the version returned as `if_version`.
- **Delete:** `memory_read` it, then `memory_delete` it with that version.
- **Conflict:** when another agent changed the memory since you read it, the call is
  refused and returns the current content and version: merge your change into it and
  retry with the new version.

Without the mdmem tools, write `<name>.md` in the store directly, then run
`mdmem reindex`; delete with `mdmem delete <name>`.

## Consolidation

When the user asks for a consolidation, a pass that merges, corrects and prunes the
store, follow the MCP prompt `consolidate` or the output of `mdmem consolidate`.
