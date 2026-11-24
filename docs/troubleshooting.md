# Troubleshooting

## The agent has no memory

`mdmem enable` succeeding means the files are written, not that memory works.
mdmem cannot check folder trust in any agent, Codex's review of its hooks, or
Claude Code's approval of a project's server. Go down this list in the folder
the agent was started in.

1. **Run `mdmem status`.** It shows each agent's entries in each scope and
   warns of what it can see: a missing hook, a config file that does not parse,
   hooks switched off, Claude Code's auto memory still on, `mdmem` not on PATH,
   and a folder below the root or in a submodule where an agent would miss the
   project's wiring. Each warning says how to fix it. `mdmem doctor` gives the
   same check and exits 1 on a problem.
2. **`mdmem` on PATH.** The hooks and the server run `mdmem`. Without it they
   fail, and the session starts with no memory.
3. **A resumed session.** The hooks print nothing on a resumed or forked
   session, whose history already holds what its start injected. A session
   started before mdmem was wired still lacks it when resumed. Start a new one.
4. **Codex's hook review.** Codex runs a new hook only once you have reviewed
   it in an interactive session, at its next start or in `/hooks`. `codex exec`
   never asks, so a clone nobody reviewed runs no project hook. Codex asks
   again when a `SessionStart` group before mdmem's is added or removed, or
   mdmem's is edited. In a repository wired in both scopes, review the
   project's hooks: the global ones stay silent beside them
   ([Known limitations](#known-limitations)).
5. **Hooks switched off.** In Claude Code, `disableAllHooks: true` in its
   settings. In Bob, `disableWorkspaceHooks: true` in `.bob/settings.json`,
   `disableGlobalHooks: true` in `~/.bob/settings/settings.json`, or
   `"disabled": true` on one of mdmem's hooks, which Bob's Settings writes when
   you switch a hook off. `mdmem status` reports each.
6. **See what the hook injects.** Run `mdmem hook <agent> index` in the folder.
   With no payload it prints nothing, and its stderr line gives the
   `echo … | mdmem hook <agent> index` command that shows what the agent's
   session gets there. Wherever the hook prints nothing, that line says why.

Three more causes apply only to a repository wired with `--project`
([Share the wiring](team.md#share-the-wiring)):

7. **Folder trust.** Claude Code, Bob and Codex run a project's files only in a
   folder you have trusted. Accept the trust dialog. In a repository wired in
   both scopes, an untrusted folder gets no memory in Bob or Codex, because
   their global hooks stay silent beside the project's
   ([Known limitations](#known-limitations)).
8. **Claude Code's server approval.** Claude Code asks each user to approve the
   server in `.mcp.json`. Until then the mdmem tools are missing, and the agent
   writes memory files directly, which its sandbox refuses for a home store.
   Approve the server, then run `mdmem reindex` to bring the index up to date.
9. **Started below the root.** Claude Code and Bob read a project's files only
   from the folder they start in. Started in a subdirectory, they get no
   protocol and no index, Bob gets no mdmem tools, and Claude Code keeps its
   auto memory on unless your user settings turn it off. Start them at the
   root, or wire the global scope.

Hooks that do not run leave an agent with no protocol and no index, and mdmem
has no fallback. Every state `mdmem status` and the check report is listed in
[What status and the check report](reference.md#what-status-and-the-check-report).

## Claude Code still saves to its own memory

`autoMemoryEnabled` is not `false` where Claude Code reads it first:
`.claude/settings.local.json`, then `.claude/settings.json`, then your user
settings. A project's `true` overrides your user settings' `false`. The other
cause is `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to `0`, `false`, `no` or `off`.
`mdmem status` reports both.

## The index is cut short at session start

The hook injects at most 9,500 characters of `MEMORY.md` and tells the agent to
`memory_read` the rest. `mdmem doctor` reports an index near or over that size.
Shorten descriptions, or merge or delete memories, for instance through a
[consolidation](reference.md#consolidation).

## Known limitations

In a repository wired in both scopes, Codex's and Bob's global hooks stay
silent wherever the project's own hooks are present (for Bob, present and not
marked `disabled`), without checking that the agent runs them. Where the agent
does not run them, the session starts with no memory: no protocol, no index,
and nothing in the session says why. `mdmem status` cannot tell whether the
folder is trusted or the hooks reviewed. A repository wired in the global scope
alone has neither gap.

- **Codex: a folder it does not trust, or project hooks nobody has reviewed.**
  Codex runs the hooks in `.codex/hooks.json` only in a trusted folder, and
  only once you have reviewed them in an interactive session. `codex exec`
  never asks. Trust the folder, then start `codex` in the repository and review
  the project's hooks when it asks, or in `/hooks`. Each person reviews them
  once per clone.
- **Bob: a folder it does not trust, or workspace hooks switched off.** Bob
  runs the hooks in `.bob/settings.json` only in a trusted folder, and none at
  all when that file sets `disableWorkspaceHooks: true`, which `mdmem status`
  warns of. Trust the folder in Bob, and remove that setting.

To see the deferral, run `mdmem hook <agent> index --global` in the folder.
Given no payload, it prints on stderr the command that pipes it one. That
command says on stderr that the `--global` entry stays silent because the
project's file holds mdmem's hook.

## Not included yet

A global store shared across projects, and semantic recall.
