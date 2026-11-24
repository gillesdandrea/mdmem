#!/usr/bin/env bash
# PreToolUse hook: block file edits in the main worktree (Edit/Write/MultiEdit/NotebookEdit),
# and commits on main, pushes to main and `wt merge` into main (Bash).
# Whatever GitHub enforces on origin, it never sees an edit in main/ or a commit on local main:
# this hook stops Claude Code before either. Codex and Bob have no such hook: AGENTS.md alone binds them.
input=$(cat)
cwd=$(jq -r '.cwd // ""' <<<"$input")

block() {
  echo "Blocked: $1. Changes reach main only through a pull request: work in a branch worktree, push the branch, open a pull request (see AGENTS.md)." >&2
  exit 2
}

# File edits: refuse any path under the main worktree, main/ beside the bare repo (see AGENTS.md).
# A plain clone has no main/ beside its .git, so this part never fires there.
# Judged by path, so it holds while main/ is detached, mid-rebase, or holds a nested repository.
file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' <<<"$input")
if [ -n "$file" ]; then
  file="${file/#\~/$HOME}"
  [[ "$file" = /* ]] || file="$cwd/$file"
  d=$(dirname "$file")
  while [ ! -d "$d" ]; do d=$(dirname "$d"); done  # Write may create new directories
  d=$(cd "$d" && pwd -P)
  repo=$(git -C "${CLAUDE_PROJECT_DIR:-$cwd}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  main_wt=$([ -n "$repo" ] && cd "$(dirname "$repo")/main" 2>/dev/null && pwd -P)
  if [ -n "$main_wt" ] && [[ "$d/" == "$main_wt/"* ]]; then
    block "editing $file in the main worktree. Enter a branch worktree first (EnterWorktree with name: <branch>) and edit there"
  fi
  exit 0
fi

cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
grep -qE '(^|[^[:alnum:]_-])(git|wt)([[:space:]]|$)' <<<"$cmd" || exit 0

dirs=("$cwd")
while IFS= read -r d; do
  [ -z "$d" ] && continue
  d=${d#[\"\']}; d=${d%[\"\']}  # cd 'X' and cd "X" name the same directory as cd X
  d="${d/#\~/$HOME}"
  [[ "$d" = /* ]] || d="$cwd/$d"
  dirs+=("$d")
done < <(grep -oE '(^|[;&|[:space:](])(cd|-C)[[:space:]]+[^[:space:];&|]+' <<<"$cmd" | awk '{print $NF}')

hook_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(git -C "$hook_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
slugs() { sed -E 's#//+#/#g; s#(\.git)?/*$##; s#^.*[:/]([^/]+/[^/]+)$#\1#' | tr '[:upper:]' '[:lower:]'; }
slug=$(git -C "$hook_dir" remote get-url origin 2>/dev/null | slugs)
ours() {
  [ -z "$repo" ] || [ "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" = "$repo" ] ||
    { [ -n "$slug" ] && git -C "$1" remote -v 2>/dev/null | awk '{print $2}' | slugs | grep -qxF "$slug"; }
}

on_main=0; any_main=0
for d in "${dirs[@]}"; do
  [ "$(git -C "$d" branch --show-current 2>/dev/null)" = main ] || continue
  any_main=1
  ours "$d" && on_main=1
done
session_hint="Commit and push from a session inside the branch worktree, entered with EnterWorktree, and don't name main/ with cd or -C"
text_hint="If the command only mentions it in text it writes, such as a heredoc, write that text with the Write tool"

if grep -qE '\bgit\b[^;&|]*\bcommit\b' <<<"$cmd" && [ $on_main = 1 ]; then
  block "commit on main. $session_hint. $text_hint"
fi

if grep -qE '\bgit\b[^;&|]*\bpush\b' <<<"$cmd"; then
  args=$(grep -oE '\bpush\b[^;&|]*' <<<"$cmd" | head -1)
  grep -qE '(^|[[:space:]:+])main([[:space:]]|$)' <<<"$args" && block "push to main. $text_hint"
  # Bare `git push` / `git push origin` from main pushes main.
  nonflags=$(awk '{n=0; for (i=2;i<=NF;i++) if ($i !~ /^-/) n++; print n}' <<<"$args")
  [ "$on_main" = 1 ] && [ "$nonflags" -le 1 ] && block "push from main. $session_hint. $text_hint"
  # From any repository on main, a bare push to this repository's URL pushes main too.
  [ "$any_main" = 1 ] && [ "$nonflags" -le 1 ] && [ -n "$slug" ] &&
    grep -oE "[^[:space:];&|<>()\"'\`]+" <<<"$cmd" | slugs | grep -qxF "$slug" && block "push to main. $text_hint"
fi

# `wt merge [TARGET]` defaults to main. Its pre-merge hook refuses that, but --no-hooks skips the hook.
if grep -qE '(^|[^[:alnum:]_-])wt[[:space:]]+merge\b' <<<"$cmd"; then
  args=$(grep -oE '\bwt[[:space:]]+merge\b[^;&|]*' <<<"$cmd" | head -1 | sed -E 's/^wt[[:space:]]+merge//')
  target=$(awk '{for (i=1;i<=NF;i++) {
    if ($i ~ /^(-b|--branch|--stage|--format|--config|--config-set)$/) { i++; continue }
    if ($i !~ /^-/) { print $i; exit } } }' <<<"$args")
  if [ -z "$target" ] || [ "$target" = main ]; then block "wt merge into main. $text_hint"; fi
fi
exit 0
