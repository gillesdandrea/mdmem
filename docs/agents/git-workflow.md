# Git workflow in the mdmem.wt workspace

The rules every session needs are in `AGENTS.md`. This page holds the cases only some sessions reach: stacked branches, rebasing, cleaning up after a merge, helpers, and worktrunk's approvals.

## Worktrees

- Codex and Bob have no `EnterWorktree`: the maintainer creates each of their worktrees, stacked ones included, and starts the session inside it. The `EnterWorktree` and `ExitWorktree` steps on this page are Claude Code's.
- worktrunk puts a worktree beside `.git/` through the `worktree-path` template in the user's `~/.config/worktrunk/config.toml`. The template applies to every repository: for a bare repository in a folder ending in `.wt`, it puts the worktrees beside `.git/`.
- A new worktree gets what git does not carry, from the `pre-start` hook in `.config/wt.toml`: `node_modules/`, and in `mdmem.wt/` the links `.claude/workflows` and `.agents/skills` to the root's folders. The hook blocks, so both are done when the session enters the worktree.
- `EnterWorktree` goes through worktrunk only when the worktrunk Claude Code plugin is loaded. It is installed at user scope (`wt config plugins claude install`) and loads when a session starts. If `EnterWorktree` returns a path under `.claude/worktrees/`, the plugin is not loaded: leave with `ExitWorktree` and `remove`, and tell the user the session needs a restart.
- To enter a worktree that already exists, use `EnterWorktree` with `path`. Claude Code may ask the user to approve that call; the user can type `/cd <path>` instead.
- Leave a worktree with `ExitWorktree` and `keep`, then remove it with `wt remove`. `ExitWorktree` with `remove` is refused for a worktree that worktrunk made.
- Inside a worktree, Claude Code keeps the session on it: it refuses `git -C <other worktree>`, `cd <other worktree> && git …`, and edits outside the worktree. `gh`, `bd` and `wt` run as usual. Read another branch by name, for example `git diff main..<branch>`.

## Approvals

worktrunk runs this project's hooks and aliases only once the user has approved them. It stores the approvals in `~/.config/worktrunk/approvals.toml`, under `[projects."github.com/gillesdandrea/mdmem"]`, and asks again when a command in `.config/wt.toml` changes.

When a `wt` command stops with "needs approval" or "Cannot prompt for approval", stop and ask the user to run `wt config approvals add` in `mdmem.wt/main`, where they read each command before approving it. Approving is the user's decision, so leave `--yes` to them.

## Updating main

- The `main/` worktree stays on `main` and only moves by fast-forward, through `wt pull-main` or `wt sync -u`. `wt pull-main` also runs `bun install` and `bun run build` in `main/`: `bun link` points the `mdmem` on the maintainer's `PATH` at `main/dist/`, and every agent's hooks call it.
- If `wt pull-main` cannot run, run its commands from a session in `main/`: `git fetch --prune origin && git merge --ff-only origin/main && bun install --frozen-lockfile && bun run build`. A session inside a branch worktree cannot, because Claude Code refuses `git -C` at another worktree.

## Stacked branches and rebasing

`wt sync` comes from worktrunk-sync (the `wt-sync` binary). It rebases worktree branches onto `main`, or onto their parent for a stacked branch. Several worktrees are usually open at once; rebase each one when its own work reaches a stopping point, not on every merge into `main`.

| Stage | Command |
|---|---|
| Start a branch stacked on another | Claude Code: `wt switch -c <child> -b <parent> --no-cd`, then `EnterWorktree` with `path: <worktree>` |
| Publish it | `git push -u origin <child>`, then `gh pr create --base <parent>` |
| Rebase onto the latest `main` | `wt sync -u` from that worktree (`-n` previews, `-p` pushes) |
| See worktrees and branches | `wt list --branches --remotes` |

- `wt sync` rebases only the stack of the worktree it runs in: the branch, its parents and its children. Run it in the worktree you work in, without `-a`, unless asked.
- After the stack's parent is squash-merged, preview with `-n` first: the children still carry the parent's commits, which `main` now holds as one squash commit, so their rebase may conflict.
- `wt sync` stops at the first conflict. Resolve it in that worktree by the logic and meaning of both sides, not only the markers; then `git rebase --continue` (or `--abort`) and run `wt sync` again. Its summary lists any branch it did not rebase.

## Helpers

- A helper works in the lead's worktree by default. A subagent inherits the lead's directory and cannot call `EnterWorktree`, so a reviewer, an investigator, or a single helper that writes code needs no worktree of its own. The lead does not write there while a helper that writes is running.
- Helpers that write in parallel get a worktree each: start each with the `Agent` tool's `isolation: "worktree"`. Such a helper starts from the tip of `main`, not from the lead's branch, on a branch named `agent-<id>`. When it finishes, merge its branch from the lead's worktree (`git merge agent-<id>`), remove its worktree with `wt remove agent-<id>`, then delete the branch with `git branch -d agent-<id>`, which succeeds once the lead's branch holds its commits.

## After a merge

A squash merge puts one new commit on `main`, so the branch's own commits never appear there. `wt remove` and `wt sync -P` still recognize the branch as merged by its content, but only once local `main` has the squash commit.

1. If the session is inside the merged branch's worktree, leave it: `ExitWorktree` with `keep`.
2. `wt pull-main`. It also prunes the deleted `origin/<branch>`, which the plain fetch in `wt sync` does not.
3. `wt remove --foreground <branch>`. It removes the branch's worktree, and the branch when it adds nothing to `main`. Other worktrees are left alone.
4. If it kept the branch, delete it with `git branch -D <branch>` only after one of these checks passes:
   - `gh pr view <branch> --json state,headRefOid` shows `"state":"MERGED"`, and its `headRefOid` equals `git rev-parse <branch>`: no local commit came after the pull request.
   - `git rev-parse <branch>^{tree}` equals `git rev-parse origin/main^{tree}`.

   If neither passes, keep the branch and ask.
5. `wt list --branches --remotes` shows no row for the branch. If `origin/<branch>` is still listed, delete it with `git push origin --delete <branch>`.

## The local guards

- `.config/wt.toml` has a `pre-merge` hook that refuses `wt merge` into `main`.
- `.claude/hooks/protect-main.sh` stops Claude Code from committing on `main`, pushing to `main`, and running `wt merge` into `main`, `--no-hooks` included. It counts the session's directory and every directory the command names with `cd` or `-C`, so from a session in `main/`, every command holding a git commit or a bare `git push` is blocked. Commits and bare pushes are judged by repository: from a session in a branch worktree, a commit in an unrelated repository passes. `git push … main` and `wt merge` into `main` are refused in any repository. It also blocks Edit, Write, MultiEdit and NotebookEdit on files in `main/`. `.claude/hooks/protect-main.test.sh` is its test, part of `bun run all:check`.
