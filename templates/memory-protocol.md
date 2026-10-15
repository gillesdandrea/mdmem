# Memory protocol

You have a shared, persistent memory for this project at `.memory/` — a directory
of Markdown memories shared by every agent working here. `.memory/MEMORY.md` is the
index: one pointer per memory. Treat saving and recalling memory as a habit, not an
afterthought.

## Recall

Before starting work, read `.memory/MEMORY.md` to see what is already known. When a
pointer looks relevant, open its memory file for the detail. Recalled memories were
true when written — before acting on one that names a file, function, or flag,
confirm it still exists.

## Save

One file, one fact: `.memory/<name>.md`, where `<name>` is the memory's short
kebab-case name. Each memory is YAML frontmatter followed by a short body:

    ---
    name: <name>            # matches the filename
    description: <one line — used to judge relevance from the index>
    metadata:
      type: user | feedback | project | reference
    ---

    <the fact.>

For `feedback` and `project` memories, follow the body with a `**Why:**` line (the
reason it matters) and a `**How to apply:**` line. Link related memories with
`[[name]]`. After you create or change a memory, run `mdmem reindex` so
`MEMORY.md` reflects it.

### Types

- **user** — who the user is: role, expertise, durable preferences.
- **feedback** — how you should work here: corrections and confirmed approaches, with the why.
- **project** — goals, constraints, and state not derivable from the code or git history. Convert relative dates to absolute ones.
- **reference** — pointers to external resources (URLs, dashboards, tickets).

## What is worth saving

Save what is durable and non-obvious — memories of the types above that would
otherwise be re-learned every session. Before adding one, check the index for an
existing memory that already covers it and update that instead of creating a
duplicate.

Keep out what the repository already records — code structure, past fixes, git
history — and anything that only matters to the current conversation.

Never save sensitive personal data: health, political or religious beliefs,
sexual history, financial details, criminal history, or other personally
identifying information — even when shared directly. Omit that part rather than
writing a placeholder.
