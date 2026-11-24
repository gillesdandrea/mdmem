# Sharing mdmem with a team

A team can share two things through git, separately: the memories, as a local
store, and the wiring, as the project scope. Most teams want the memories. The
wiring is for a team that wants every clone wired without each person running
`mdmem enable`.

## Share the memories

By default a project's store is in your home directory, `~/.mdmem/<key>/`. Your
agents and your worktrees share it; your teammates do not.

```bash
mdmem store local    # moves the store to .mdmem/ at the repository's root
git add .mdmem
git commit -m "Share the project's memory"
```

Your teammates then get the memories with the code, and review changes to them
in pull requests. `mdmem store home` moves the store back.

mdmem never edits `.gitignore`. `mdmem store local` and `mdmem status` say when
git does not ignore `.mdmem/`.

A committed store suits a project without linked worktrees. Each linked
worktree checks out its own copy of `.mdmem/`, which mdmem ignores there,
because every worktree uses the main checkout's store.

### A teammate who already has a home store

Once `.mdmem/` exists, every agent uses it, and a home store a teammate already
had for the project is no longer read. `mdmem status` warns when that home
store holds memories, and names the command that folds them in:
`mdmem consolidate --from <home store>`.

### What to save in a shared store

A committed store has no per-person part. A `user` memory describes whoever's
agent saved it, and every teammate's agent reads it at session start. In a
shared store, keep to what holds for everyone: `feedback`, `project` and
`reference` memories.

### A merge conflict in `MEMORY.md`

mdmem updates the index after every save and delete, so its changes show up in
pull requests beside the memories. When `MEMORY.md` conflicts in a merge, keep
both sides' lines and run `mdmem reindex`. It drops duplicate pointers and
pointers to deleted memories, and adds the missing ones.

### Whose change wins

On one machine, every save goes through a version check. An agent writes a
memory with the version it last read, and a write over a newer version is
refused with the current content, for the agent to merge and retry. Between
clones, git merges memories like any other file.

## Share the wiring

`mdmem enable` writes each agent's user-wide files, so it wires your machine
only. To wire one repository for everyone who clones it, run this in the
repository and commit the files it names:

```bash
mdmem enable --all --project
```

| Agent | Files to commit | What each person still does |
|---|---|---|
| Claude Code | `.claude/settings.json`, `.mcp.json` | Trust the folder, and approve the project's mdmem server |
| Codex CLI | `.codex/hooks.json`, `.codex/config.toml` | Trust the folder, and review the hooks once per clone in an interactive session |
| IBM Bob | `.bob/settings.json`, `.bob/mcp.json` | Trust the folder, and launch Bob at the repository's root |

mdmem cannot give those approvals for anyone, and `mdmem status` cannot see
folder trust or Codex's review.

Before you commit the wiring:

- **Everyone needs `mdmem` on PATH** (`npm install -g @gillesdandrea/mdmem`).
  The committed files wire every clone, including a teammate's without mdmem.
  There, Claude Code's auto memory is off, the hooks fail without blocking the
  session, and the servers fail to start.
- **Claude Code and Bob read a project's files only from the folder they start
  in.** Started in a subdirectory, they get no protocol and no index, Bob gets
  no mdmem tools, and Claude Code keeps its auto memory on unless your user
  settings turn it off. Start them at the root, or wire the global scope too.
- **Codex reviews hooks once per clone, per person.** `codex exec` never asks,
  so a headless session in a clone nobody reviewed runs no hook. Prefer the
  global scope for Codex, unless the team needs the wiring committed and each
  member reviews the project's hooks once. A clone's worktrees share its
  review.
- **A worktree checked out from a commit before the wiring is not wired.**
  `mdmem status` there says so.

`mdmem disable --all --project` removes exactly mdmem's entries from the
repository's files and leaves the store.

### Wired in both scopes

A repository may be wired in both scopes, by different people. Each session
still gets the protocol and the index once, and the agent runs one mdmem
server: the global hooks stay silent where the project's own hooks run.
`mdmem status` notes each agent wired in both scopes.

Claude Code runs a project's hooks only in a folder you have trusted, so its
global hooks speak until you accept the folder's trust dialog. A `claude -p`
session runs the project's hooks in a folder never trusted, so there it gets
each part twice.

Codex and Bob keep their global hooks silent wherever the project's own hooks
are present, whether or not the agent runs them. See
[Known limitations](troubleshooting.md#known-limitations).

The files each scope writes, and how each agent treats them, are in the
reference: [Claude Code](reference.md#claude-code),
[IBM Bob](reference.md#ibm-bob), [Codex CLI](reference.md#codex-cli).
