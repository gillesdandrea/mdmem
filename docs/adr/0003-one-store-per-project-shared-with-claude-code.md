# One store per project, shared with Claude Code through its own directory

A project has one memory store, `.memory` at the directory Claude Code uses as the repository's key: the parent of the git common dir, or a bare repository itself. A submodule uses its superproject's store, a linked worktree has none of its own, and without git the store is the first `.memory/` above the working directory. Until Claude Code is wired, `.memory/` is a real directory. Wiring Claude Code merges it into Claude's own auto-memory directory, `~/.claude/projects/<key>/memory/`, and replaces `.memory` with a symlink to it, so Claude reads and saves its own directory natively and mdmem configures nothing in Claude.

We chose this over pointing Claude at `.memory/` with `autoMemoryDirectory`, because that setting takes an absolute path and lives in a gitignored per-checkout file, so every new worktree silently falls back to Claude's private directory. We also chose it over linking Claude's directory to `.memory/`: Claude Code 2.1.302 loads the index through such a link but asks permission for every read and write through it, and only `bypassPermissions` saves (tested 2026-10-17). Claude already maps every worktree of a repository to one directory, so the reverse link covers worktrees with nothing per checkout.

## Consequences

- A project wired for Claude Code cannot commit its memories: `.memory` is a link to a path under the home directory. mdmem never edits `.gitignore`, and wiring refuses while git tracks files under `.memory/`.
- Wiring is a mechanical merge that refuses on a same-file-name conflict, backs both sides up under `~/.claude/projects/<key>/`, and folds in Claude directories left under an older key. Unwiring replaces the link with a copy.
- mdmem must compute Claude's key as Claude does. Moving the repository changes the key and leaves the link dangling; `status` and the check report it, and wiring again re-points it.
- A Claude session started inside a submodule probably saves to the submodule's own Claude directory, not the shared store.
- Other agents may refuse direct file access through a link that leaves their workspace; saves through the mdmem MCP tools are unaffected.
