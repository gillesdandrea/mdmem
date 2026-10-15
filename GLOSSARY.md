# mdmem

A project's file-based memory, in the same format as Claude Code's auto memory, shared by every coding agent that works on the project.

## Language

### Memory store

**Memory store**:
A project's shared memory: the `.memory/` directory of memory documents, read and written by every agent on the project.
_Avoid_: memory directory (Claude Code's private auto memory), memory folder, brain

**Memory document**:
Any file in a memory store, addressed by its path in the store: a memory or the index.
_Avoid_: file (when the store's view is meant)

**Version**:
A token naming a memory document's content as it was read; a write that passes it is refused if the content has changed since.
_Avoid_: etag, revision, hash

### Memories

**Memory**:
One Markdown file holding one fact: frontmatter with a name, a description and a memory type, then a body. Say *memory file* when the file itself is meant; uncountable, *memory* is the whole system ("the project's memory").
_Avoid_: fact (that is what a memory holds), entry, note, topic file

**Name**:
A memory's short kebab-case identifier, unique in the project and equal to its file name without `.md`.
_Avoid_: slug, id, key

**Description**:
A memory's one-line summary, used to decide relevance during recall.
_Avoid_: summary, hook

**Link**:
A `[[name]]` in a memory's body that refers to another memory.
_Avoid_: wikilink, reference (a memory type)

### Memory types

**Memory type**:
The kind of a memory: user, feedback, project or reference.
_Avoid_: category, kind

**User memory**:
A memory about who the user is: role, expertise, preferences.

**Feedback memory**:
A memory of guidance the user gave on how to work, both corrections and confirmed approaches, with the reason.

**Project memory**:
A memory about ongoing work, goals or constraints that the code and git history don't record.
_Avoid_: project memory for the whole set of a project's memories

**Reference memory**:
A memory saying where to find an external resource: a URL, a dashboard, a ticket.

### Index

**Index**:
The `MEMORY.md` file holding one pointer per memory, read at the start of every session. It is an index, not a memory.
_Avoid_: catalog, manifest, table of contents

**Pointer**:
One line of the index: a memory's title linked to its file, then a one-line hook.
_Avoid_: index entry, index line

### Using memory

**Recall**:
Reading the index, then the memories relevant to the work at hand, into an agent's context.
_Avoid_: retrieval, lookup

**Save**:
Writing a new memory, or updating an existing one in place of a duplicate.
_Avoid_: record, remember
