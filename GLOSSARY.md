# mdmem

A project's file-based memory, in the same format as Claude Code's auto memory, shared by every coding agent that works on the project.

## Language

### Memory store

**Memory store**:
A project's shared memory: a directory of memory documents, read and written by every agent on the project, in one of two placements.
_Avoid_: memory directory (Claude Code's private auto memory), memory folder, brain

**Placement**:
Where a project's memory store lives: home or local. A property of the project, never of an agent.
_Avoid_: location, mode, scope (an agent's wiring)

**Home store**:
A memory store under `~/.mdmem/`, keyed by its project's path, invisible in the project's tree and never shared through git; the default placement.
_Avoid_: global store, user store

**Local store**:
A memory store at `.mdmem/` in the project's root, created on purpose, which travels with the repository when committed.
_Avoid_: tree store, project store, in-repo store

**Project**:
The unit that owns one memory store: a git repository, every worktree, subdirectory and submodule included; outside git, the working directory itself.
_Avoid_: workspace (an agent's launch folder), repo (when worktrees are meant too)

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
A memory's short identifier, unique in the project and normally equal to its file name without `.md`; a memory written by mdmem always matches its file name.
_Avoid_: slug, id, key

**Description**:
A memory's one-line summary, used to decide relevance during recall.
_Avoid_: summary, hook

**Link**:
A `[[name]]` in a memory's body that refers to another memory, which may not be written yet: such a link marks a memory worth writing, and is not a problem.
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
One line of the index: a memory's title linked to its file, then the memory's description.
_Avoid_: index entry, index line

### Using memory

**Recall**:
Reading the index, then the memories relevant to the work at hand, into an agent's context.
_Avoid_: retrieval, lookup

**Save**:
Writing a new memory, or updating an existing one in place of a duplicate.
_Avoid_: record, remember

**Check**:
A pass over a project that reports every problem with its memory store's memories and index (an unparseable memory, a name that differs from its file name, two memory types that disagree, a secret, an over-long pointer, a stale or over-capacity index) and with its agents' wiring (a session-start hook that will not run, an agent's own memory still on, mdmem missing from PATH), and that notes each link to a memory not written yet. `mdmem doctor` runs a check.
_Avoid_: lint, validation, health check

**Note**:
A check's finding that is not a problem: a link to a memory not written yet. `mdmem doctor` lists each note and still exits 0 when notes are its only findings.
_Avoid_: warning, problem

**Consolidation**:
A reflective pass over a memory store's memories that merges, corrects and prunes them. Claude Code calls one such pass a *dream*.
_Avoid_: cleanup, compaction

### Agents

**Wiring**:
What connects one agent to mdmem in that agent's native way, in one scope, so it recalls and saves in a project's memory store: its session-start hooks and its registration of the mdmem MCP server.
_Avoid_: link (a `[[name]]` in a memory), integration, setup

**Scope**:
Where an agent's wiring lives: global, in the agent's user-wide files, so it applies in every project; or project, in files committed with one repository, so it applies only there.
_Avoid_: mode, level, installation

**Import**:
The one-time copy of the memories an agent kept in its own directories into the project's memory store, when that store is created and the agent is wired with its own memory turned off: Claude Code's auto memory, from each of its memory directories for the repository, which are left untouched.
_Avoid_: migration, sync
