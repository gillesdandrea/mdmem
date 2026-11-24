# mdmem

mdmem gives coding agents (Claude Code, Codex, IBM Bob) one memory per project, through a CLI and an MCP server. It is written in TypeScript, developed with bun, and published for Node 22 or later.

## Checks

`bun run all:check` is the gate, and what CI runs: types, lint and format, tests, and the test of the hook that guards `main`. A change is done when it exits 0. `bun run fix` applies what oxlint and oxfmt can fix.

## Code

oxlint and oxfmt, through Ultracite, own style; the `ultracite` skill holds its rules. Beyond what they check:

- `src/` runs on Node with no bun: use Node APIs. `bun run build` refuses a Bun API.
- `templates/` is copied verbatim into users' instruction files.
- A CLI error, warning or refusal states the cause, then the fix as its own sentence in the imperative.
- Text a person reads (README, `docs/`, the changelog, CLI output) goes through the `write-better` skill. Text an agent reads (this file, `docs/agents/`, `templates/`, the MCP tool descriptions) goes through `writing-for-agents`.

## Git workflow

Every change reaches `main` through a pull request on `gillesdandrea/mdmem`, squash-merged on GitHub. Nothing is committed on `main`, pushed to it, or merged into it locally. In a plain clone, that means: commit on a branch, push the branch, open a pull request.

The maintainer's workspace is `mdmem.wt/`, managed with worktrunk (`wt`): a bare repository in `.git/`, the `main/` worktree, and one worktree per branch beside it, with `/` in a branch name turned into `-`. Beads, skills and workflows live at its root, outside every worktree. `main/` stays read-only: each change happens in its branch worktree, from the first edit. Claude Code sessions start in `main/` and enter the branch worktree themselves. Codex and Bob sessions start in a branch worktree the maintainer created; a Codex or Bob session whose working directory is `main/` stops and tells the user.

| Stage | Command |
|---|---|
| Update `main` | `wt pull-main`: fast-forwards `main/`, then rebuilds its `dist/` |
| Start a change | Claude Code: `wt pull-main`, then `EnterWorktree` with `name: <branch>`. Codex and Bob: the session already runs in `mdmem.wt/<branch>/`; work there |
| Check | `bun run all:check`, in the branch worktree |
| Publish | `git push -u origin <branch>`, then `gh pr create` |
| Merge | `gh pr merge <number> --squash`, once CI's `check` passes |
| After the merge | [After a merge](docs/agents/git-workflow.md#after-a-merge) |

In Claude Code, `.claude/hooks/protect-main.sh` blocks edits in `main/`, commits on `main`, pushes to `main` and `wt merge` into `main`. It sees the Edit and Write tools, not shell writes (`sed -i`, `>`): make those in the branch worktree too. Codex and Bob have no such hook.

Read [docs/agents/git-workflow.md](docs/agents/git-workflow.md) before you stack a branch on another, rebase with `wt sync`, clean up after a merge, give helpers worktrees of their own, or when a `wt` command stops for approval.

## Agent skills

### Issue tracker

Issues live as beads, managed with the `bd` CLI, in a database outside the git tree, not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each applied as a bead label with the same name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
