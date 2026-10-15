# Memory protocol

You have a shared, persistent memory for this project at `.memory/` — a directory
of Markdown facts shared by every agent working here. `.memory/MEMORY.md` is the
index: one line per fact. Treat recording and recalling memory as a habit, not an
afterthought.

## Recall

Before starting work, read `.memory/MEMORY.md` to see what is already known. When a
line looks relevant, open its fact file for the detail. Recalled facts were true
when written — before acting on one that names a file, function, or flag, confirm it
still exists.

## Record

One file, one fact: `.memory/<slug>.md`, where `<slug>` is a short kebab-case name.
Each fact is YAML frontmatter followed by a short body:

    ---
    name: <slug>            # matches the filename
    description: <one line — used to judge relevance from the index>
    metadata:
      type: user | feedback | project | reference
    ---

    <the fact.>

For `feedback` and `project` facts, follow the body with a `**Why:**` line (the
reason it matters) and a `**How to apply:**` line. Link related facts with
`[[other-slug]]`. After you create or change a fact, run `mdmem reindex` so
`MEMORY.md` reflects it.

### Types

- **user** — who the user is: role, expertise, durable preferences.
- **feedback** — how you should work here: corrections and confirmed approaches, with the why.
- **project** — goals, constraints, and state not derivable from the code or git history. Convert relative dates to absolute ones.
- **reference** — pointers to external resources (URLs, dashboards, tickets).

## What is worth saving

Save what is durable and non-obvious — the facts above that would otherwise be
re-learned every session. Before adding one, check the index for an existing fact
that already covers it and update that instead of creating a duplicate.

Keep out what the repository already records — code structure, past fixes, git
history — and anything that only matters to the current conversation.

Never record sensitive personal data: health, political or religious beliefs,
sexual history, financial details, criminal history, or other personally
identifying information — even when shared directly. Omit that part rather than
writing a placeholder.
