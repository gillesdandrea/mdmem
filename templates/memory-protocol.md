# Memory protocol

This project has a persistent, file-based memory: the memory store at `.memory/`, a
directory of Markdown memories shared by every agent that works here. Build it up over
time, so that future sessions, yours or another agent's, start with a complete picture
of who the user is, how they want to work with you, what to avoid and what to repeat,
and the context behind the work.

When the user explicitly asks you to save something ("remember that…"), save it at
once as whichever memory type fits best. When they ask you to forget something, find
the memory that holds it and remove that part; delete the memory when nothing else in
it remains.

## Memory types

### user

Who the user is: role, goals, responsibilities, knowledge, durable preferences.

- **When to save:** when you learn any detail about the user's role, preferences,
  responsibilities or knowledge.
- **How to use:** when your work should be shaped by the user's profile. Explain code
  at the level and in the terms they will find most useful; leave out what they
  already know.

### feedback

Guidance the user gave on how to approach work: both what to avoid and what to keep
doing. Save confirmations as well as corrections: an agent that keeps only corrections
avoids past mistakes but drifts away from approaches the user already approved, and
grows overly cautious.

- **When to save:** whenever the user corrects your approach ("no, not that", "stop
  doing X") or confirms a non-obvious one ("yes, exactly", "keep doing that", or
  accepting an unusual choice without pushback). Corrections are easy to notice;
  confirmations are quiet, so watch for them. Save what applies beyond the current
  session, especially what is surprising or not obvious from the code.
- **How to use:** let these memories guide your work, so the user never has to give
  the same guidance twice.
- **Body:** lead with the rule, then a `**Why:**` line (the reason the user gave,
  often a past incident or a strong preference) and a `**How to apply:**` line (when
  and where the rule applies). The why lets you judge edge cases instead of following
  the rule blindly.

### project

Ongoing work, goals, initiatives, bugs or incidents that the code and git history
don't record.

- **When to save:** when you learn who is doing what, why, or by when. This changes
  quickly, so keep these memories current. Convert relative dates to absolute ones
  ("Thursday" becomes `2026-03-05`), so the memory still reads correctly later.
- **How to use:** to understand the motivation and constraints behind a request, and
  to make better-informed suggestions.
- **Body:** lead with the fact or decision, then a `**Why:**` line (the motivation:
  a constraint, deadline or stakeholder request) and a `**How to apply:**` line (how
  it should shape your suggestions). Project memories go stale fast; the why tells a
  later reader whether one still matters.

### reference

Where to find information that lives outside the project: a URL, a dashboard, a
ticket tracker, a chat channel.

- **When to save:** when you learn about a resource in an external system and what it
  is for, such as which tracker project holds the bugs.
- **How to use:** when the user mentions an external system, or the answer may live in
  one.

## What not to save

- Code patterns, conventions, architecture, file paths or project structure: reading
  the project gives the current version.
- Git history, recent changes, who changed what: `git log` and `git blame` are
  authoritative.
- Debugging solutions and fix recipes: the fix is in the code, its context in the
  commit message.
- Anything your project instruction files (`AGENTS.md`, `CLAUDE.md`, rule files)
  already say.
- Ephemeral task state: work in progress, temporary decisions, the current
  conversation.
- Secrets and credentials: API keys, tokens, private keys, passwords. Every agent on
  the project reads the store. `memory_write` and `mdmem add` refuse content that
  looks like a secret, and `mdmem doctor` reports one in a memory file written
  directly.
- Sensitive personal data: health, political or religious beliefs, sexual history,
  financial details, criminal history, or other personally identifying information,
  even when the user shares it directly. Leave that part out rather than writing a
  placeholder.

These exclusions hold even when the user asks you to save. Asked to save a list of
pull requests or a summary of activity, ask what was surprising or non-obvious about
it: that is the part worth keeping.

## Memory, plans and tasks

A memory serves future sessions. Information that matters only to the current
session belongs elsewhere:

- To agree an approach with the user before a non-trivial change, use your plan, not
  a memory; when your approach changes, update the plan.
- To break the current work into steps and track progress, use your task list, not a
  memory.
- Without a plan or a task list, say it in your reply instead.

## Format

One memory per file: `.memory/<name>.md`, where `<name>` is the memory's short
kebab-case name (`short-summaries`, `staging-deploy-freeze`), unique in the project. Each
memory is YAML frontmatter followed by its body:

```markdown
---
name: short-summaries
description: End a task with a few-line summary, not a recap of the diff
metadata:
  type: feedback
---

End each task with a summary of a few lines: what changed and what is left.

**Why:** the user reads the diff themselves; a long recap repeats it.
**How to apply:** after every change, lead with the outcome and skip the
file-by-file walk-through.
```

- `name` equals the file name without `.md`.
- `description` is one specific line: it decides whether a later session opens the
  memory.
- `metadata.type` is `user`, `feedback`, `project` or `reference`.
- A link, `[[name]]`, in the body refers to another memory.

Organize memories by topic, not by date. Keep the name, description and type in step
with the body as it changes.

## The index

`.memory/MEMORY.md` is the index, one pointer per memory, in this form:
`- [name](name.md) — description`. mdmem keeps it up to date from the memories: it
adds a pointer for a new memory, removes the pointer of a deleted one, and updates
a pointer's description when the memory's description changes. Never write or edit
`MEMORY.md`, and never put memory content in it: shape the index only through the
memories.

Agents read the index at the start of every session, and the whole index must stay
under about {{index_max_chars}} characters. Keep each description short enough that
its pointer stays under ~{{pointer_max_chars}} characters; put the detail in the
body.

## Save

Save in the same reply as the correction, confirmation or discovery that prompted
it, not at the end of the session: a session can end at any turn.

Before writing a new memory, check the index and `memory_search` (or `mdmem search`)
for one that already covers the subject, and update that memory instead of adding a
duplicate. Update or delete a memory that turns out to be wrong or outdated.

With the mdmem tools (`memory_list`, `memory_read`, `memory_write`, `memory_search`,
`memory_delete`), save through them; the store is shared, and the tools guard each
write against another agent's:

- **New memory:** `memory_write` the whole document at `<name>.md` with `if_version`
  set to `new`.
- **Update:** `memory_read` the memory, then `memory_write` the whole updated
  document with the version it returned as `if_version`. The content replaces the
  entire document: keep every line you mean to keep.
- **Delete:** `memory_read` the memory, then `memory_delete` it with that version.
- **Conflict:** when another agent changed the memory since you read it, the call is
  refused and returns the current content and version. Merge your change into that
  content and retry with the new version.

Without the tools, write `.memory/<name>.md` directly, then run `mdmem reindex` so the
index reflects it. Delete a memory with `mdmem delete <name>`.

## Recall

Read `.memory/MEMORY.md` before starting work, and open a memory whose pointer bears
on the task. Recall memory also when the user refers to earlier work, and always when
they ask you to check or recall what you know. When the user says to ignore memory,
work as if the index were empty: don't apply, cite or mention what the memories say.

A memory was true when it was written. Use it as context about that moment, and check
it before you act on it:

- A memory that names a file: check that the file exists.
- A memory that names a function or flag: search the code for it.
- Before the user acts on a recommendation drawn from memory: verify it first.

"The memory says X exists" is not "X exists now." A memory that summarizes the state
of the repository is frozen at the time it was written; for current state, read the
code or `git log`. When a memory conflicts with what you observe, trust the
observation, and update or delete the stale memory.

## Consolidation

When the user asks for a consolidation, a pass that merges, corrects and prunes the
store's memories, follow the MCP prompt `consolidate`, or the output of
`mdmem consolidate`.
