#!/usr/bin/env bash
# usage: protect-main.test.sh [-v] [path to protect-main.sh]
# Prints the failing cases and a summary line; -v prints every case. Requires git and jq.
# Expected codes are Claude Code PreToolUse hook exits: 0 lets the tool call run, 2 blocks it.
set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY

verbose=0; SOURCE=
for arg in "$@"; do
  case $arg in
    -v) verbose=1 ;;
    *) SOURCE=$arg ;;
  esac
done
[ -n "$SOURCE" ] || SOURCE=$(dirname "$0")/protect-main.sh
[ -f "$SOURCE" ] || { echo "no hook at $SOURCE" >&2; exit 1; }

TMP=$(cd "$(mktemp -d)" && pwd -P) || exit 1
trap 'rm -rf "$TMP"' EXIT
if git -C "$TMP" rev-parse --git-dir >/dev/null 2>&1; then
  echo "temporary directory $TMP is inside a git repository" >&2; exit 1
fi

OWNER=acme; NAME=widget; SLUG=$OWNER/$NAME
URL="https://github.com/$SLUG.git"; ORIGIN=$URL
WS=$TMP/ws; MAIN=$WS/main; BRANCH=$WS/work
HOOK=$MAIN/.claude/hooks/protect-main.sh
g() { git -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
{
  g init -q -b main "$TMP/seed" &&
    g -C "$TMP/seed" commit -q --allow-empty -m init &&
    g clone -q --bare "$TMP/seed" "$WS/.git" &&
    g -C "$WS/.git" remote set-url origin "$URL" &&
    g -C "$WS/.git" worktree add -q "$MAIN" main &&
    g -C "$WS/.git" worktree add -q -b work "$BRANCH" main &&
    mkdir -p "$(dirname "$HOOK")" && cp "$SOURCE" "$HOOK" && chmod +x "$HOOK"
} >/dev/null 2>&1 || { echo "could not build the workspace replica in $TMP" >&2; exit 1; }

OUTSIDE=$TMP/repos; mkdir -p "$OUTSIDE"
{
  git init -q -b main "$OUTSIDE/scratch-main" &&
    git init -q -b other "$OUTSIDE/scratch-other" &&
    git init -q -b main "$OUTSIDE/other-project" && git -C "$OUTSIDE/other-project" remote add origin "https://github.com/someone/other-project.git" &&
    git init -q -b main "$OUTSIDE/clone-main" && git -C "$OUTSIDE/clone-main" remote add origin "$ORIGIN" &&
    git init -q -b work "$OUTSIDE/clone-work" && git -C "$OUTSIDE/clone-work" remote add origin "$ORIGIN" &&
    git init -q -b main "$OUTSIDE/clone-ssh" && git -C "$OUTSIDE/clone-ssh" remote add origin "git@github.com:$SLUG.git" &&
    git init -q -b main "$OUTSIDE/clone-upper" && git -C "$OUTSIDE/clone-upper" remote add origin "https://github.com/$(tr '[:lower:]' '[:upper:]' <<<"$SLUG")" &&
    git init -q -b main "$OUTSIDE/second-remote" && git -C "$OUTSIDE/second-remote" remote add gh "git@github.com:$SLUG.git" &&
    mkdir -p "$OUTSIDE/not-a-repo" "$OUTSIDE/loose" && cp "$HOOK" "$OUTSIDE/loose/protect-main.sh" &&
    g clone -q "$TMP/seed" "$OUTSIDE/plain" && g -C "$OUTSIDE/plain" remote set-url origin "$URL" &&
    mkdir -p "$OUTSIDE/plain/.claude/hooks" && cp "$HOOK" "$OUTSIDE/plain/.claude/hooks/protect-main.sh" &&
    g clone -q "$TMP/seed" "$OUTSIDE/plain-work" && g -C "$OUTSIDE/plain-work" remote set-url origin "$URL" &&
    g -C "$OUTSIDE/plain-work" switch -q -c work &&
    mkdir -p "$OUTSIDE/plain-work/.claude/hooks" && cp "$HOOK" "$OUTSIDE/plain-work/.claude/hooks/protect-main.sh"
} >/dev/null 2>&1 || { echo "could not build the scratch repositories in $OUTSIDE" >&2; exit 1; }

pass=0; fail=0; H=$HOOK; PROJECT=$MAIN; current_group=; group_shown=0
group() {
  current_group=$1; group_shown=0
  [ "$verbose" = 1 ] && echo "$1"
}
bash_case() {
  local want=$1 label=$2 cwd=$3 command=$4 must_say=${5:-}
  local got out payload
  payload=$(jq -n --arg cwd "$cwd" --arg c "$command" '{cwd:$cwd,tool_input:{command:$c}}')
  if [ "$PROJECT" = UNSET ]; then out=$(env -u CLAUDE_PROJECT_DIR "$H" <<<"$payload" 2>&1 >/dev/null); got=$?
  else out=$(CLAUDE_PROJECT_DIR="$PROJECT" "$H" <<<"$payload" 2>&1 >/dev/null); got=$?; fi
  if [ -n "$must_say" ] && [[ "$out" != *"$must_say"* ]]; then got="$got(message lacks '$must_say')"; fi
  report "$want" "$got" "$label"
}
edit_case() {
  local want=$1 label=$2 cwd=$3 file=$4
  local got
  jq -n --arg cwd "$cwd" --arg f "$file" '{cwd:$cwd,tool_input:{file_path:$f}}' \
    | CLAUDE_PROJECT_DIR="$PROJECT" "$H" >/dev/null 2>&1; got=$?
  report "$want" "$got" "$label"
}
report() {
  if [ "$1" = "$2" ]; then
    pass=$((pass+1))
    [ "$verbose" = 1 ] && printf 'PASS  want=%s got=%s  %s\n' "$1" "$2" "$3"
  else
    fail=$((fail+1))
    if [ "$verbose" = 0 ] && [ "$group_shown" = 0 ]; then echo "$current_group"; group_shown=1; fi
    printf 'FAIL  want=%s got=%s  %s\n' "$1" "$2" "$3"
  fi
  return 0
}

group "# Session inside a branch worktree: the normal way to work"
bash_case 0 "commit"                                            "$BRANCH" 'git commit -m x'
bash_case 0 "add and commit in one command"                     "$BRANCH" 'git add -A && git commit -m x'
bash_case 0 "push -u origin branch"                             "$BRANCH" 'git push -u origin some-branch'
bash_case 0 "bare push"                                         "$BRANCH" 'git push'
bash_case 0 "cd to a scratch repo on main: commit (hcty-32t)"   "$BRANCH" "cd $OUTSIDE/scratch-main && git commit --allow-empty -m x"
bash_case 0 "-C a scratch repo on main: commit (hcty-32t)"      "$BRANCH" "git -C $OUTSIDE/scratch-main commit --allow-empty -m x"
bash_case 0 "cd to another project on main: commit"             "$BRANCH" "cd $OUTSIDE/other-project && git commit --allow-empty -m x"
bash_case 0 "commit message in quotes that mentions cd ../main"   "$BRANCH" 'git commit -m "cd ../main before wt pull-main"'
bash_case 0 "commit message in a heredoc that mentions cd ../main in backticks" "$BRANCH" "git commit -F - <<'E'
Run \`cd ../main && wt pull-main\` after a merge.
E"
bash_case 2 "subshell cd to the main worktree: commit"         "$BRANCH" "(cd $MAIN && git commit -m x)"
bash_case 2 "command substitution cd to the main worktree: push" "$BRANCH" "echo \$(cd $MAIN && git push)"
bash_case 2 "cd to the main worktree: commit"                   "$BRANCH" "cd $MAIN && git commit -m x"
bash_case 2 "-C the main worktree: commit"                      "$BRANCH" "git -C $MAIN commit -m x"
bash_case 2 "quoted cd to the main worktree: commit"            "$BRANCH" "cd \"$MAIN\" && git commit -m x"
bash_case 2 "relative cd ../main: commit"                       "$BRANCH" 'cd ../main && git commit -m x'
bash_case 2 "scratch commit, then main worktree commit"         "$BRANCH" "cd $OUTSIDE/scratch-main && git commit --allow-empty -m x; cd $MAIN && git commit -m x"
bash_case 2 "-C the main worktree: bare push"                   "$BRANCH" "git -C $MAIN push"
bash_case 2 "push origin main"                                  "$BRANCH" 'git push origin main'
bash_case 2 "push origin HEAD:main"                             "$BRANCH" 'git push origin HEAD:main'
bash_case 2 "wt merge"                                          "$BRANCH" 'wt merge'
bash_case 2 "wt merge main --no-hooks"                          "$BRANCH" 'wt merge main --no-hooks'

group "# Session in main/: reading and updating main work, commits and bare pushes do not"
bash_case 0 "git status"                                        "$MAIN" 'git status'
bash_case 0 "wt pull-main"                                      "$MAIN" 'wt pull-main'
bash_case 0 "the fast-forward fallback from CLAUDE.md"          "$MAIN" 'git fetch --prune origin && git merge --ff-only origin/main'
bash_case 0 "-C a branch worktree: status"                      "$MAIN" "git -C $BRANCH status"
bash_case 0 "cd to a branch worktree: push -u origin branch"    "$MAIN" "cd $BRANCH && git push -u origin some-branch"
bash_case 2 "commit"                                            "$MAIN" 'git commit -m x' "EnterWorktree"
bash_case 2 "bare push"                                         "$MAIN" 'git push'
bash_case 2 "push origin"                                       "$MAIN" 'git push origin'
bash_case 2 "wt merge"                                          "$MAIN" 'wt merge'
bash_case 2 "commit, then cd elsewhere (hcty-xni)"              "$MAIN" 'git commit -m x && cd /tmp'
bash_case 2 "-C a branch worktree log, then commit (hcty-xni)"  "$MAIN" "git -C $BRANCH log -1; git commit -m x"
bash_case 2 "-C a branch worktree status, then push (hcty-xni)" "$MAIN" "git -C $BRANCH status; git push"
bash_case 2 "-C a scratch repo status, then push (review finding)" "$MAIN" "git -C $OUTSIDE/scratch-main status; git push"
bash_case 2 "cd to a branch worktree: commit (now needs EnterWorktree)" "$MAIN" "cd $BRANCH && git commit -m x" "EnterWorktree"
bash_case 2 "cd to a scratch repo on main: commit (session is in main/)" "$MAIN" "cd $OUTSIDE/scratch-main && git commit --allow-empty -m x"
bash_case 2 "text that mentions a commit: block names the Write tool" "$MAIN" "cat > /tmp/note.md <<'E'
run git commit -m x
E" "Write tool"

group "# Session in another repository: only this repository is guarded"
bash_case 0 "scratch repo on main: commit"                      "$OUTSIDE/scratch-main"  'git commit --allow-empty -m x'
bash_case 0 "scratch repo on main: bare push"                   "$OUTSIDE/scratch-main"  'git push'
bash_case 0 "scratch repo on another branch: commit"            "$OUTSIDE/scratch-other" 'git commit --allow-empty -m x'
bash_case 0 "another project on main: commit"                   "$OUTSIDE/other-project" 'git commit --allow-empty -m x'
bash_case 2 "another project: push origin main (judged by its arguments)" "$OUTSIDE/other-project" 'git push origin main'
bash_case 2 "another project: wt merge (judged without the repository)"   "$OUTSIDE/other-project" 'wt merge'
bash_case 2 "clone of the same origin on main: commit"          "$OUTSIDE/clone-main"    'git commit --allow-empty -m x'
bash_case 2 "clone of the same origin on main: bare push"       "$OUTSIDE/clone-main"    'git push'
bash_case 2 "clone with the SSH form of the origin on main: commit" "$OUTSIDE/clone-ssh" 'git commit --allow-empty -m x'
bash_case 2 "clone with an upper-case origin on main: commit"   "$OUTSIDE/clone-upper"   'git commit --allow-empty -m x'
bash_case 0 "clone of the same origin on a branch: commit"      "$OUTSIDE/clone-work"    'git commit --allow-empty -m x'
bash_case 2 "repo on main with this repository as remote gh: push gh" "$OUTSIDE/second-remote" 'git push gh'

group "# A bare push to this repository's URL from any repository on main"
bash_case 2 "push URL"                                          "$OUTSIDE/scratch-main"  "git push $URL"
bash_case 2 "push URL, then a redirect"                         "$OUTSIDE/scratch-main"  "git push $URL</dev/null"
bash_case 2 "push URL in a subshell"                            "$OUTSIDE/scratch-main"  "(git push $URL)"
bash_case 2 "push URL in quotes"                                "$OUTSIDE/scratch-main"  "git push \"$URL\""
bash_case 2 "push URL with a doubled slash"                     "$OUTSIDE/scratch-main"  "git push https://github.com/$OWNER//$NAME.git"
bash_case 2 "remote add URL, then force push"                   "$OUTSIDE/scratch-main"  "git remote add x $URL && git push -f x"
bash_case 0 "push URL with a branch refspec"                    "$OUTSIDE/scratch-main"  "git push $URL some-branch"
bash_case 0 "push another URL"                                  "$OUTSIDE/scratch-main"  'git push https://github.com/someone/other-project.git'
bash_case 0 "bare push while the command names a workspace path" "$OUTSIDE/scratch-main" "ls $MAIN/.. ; git push"

group "# Identity comes from the hook's own repository, and fails closed"
PROJECT=UNSET
bash_case 2 "CLAUDE_PROJECT_DIR unset, session in a scratch repo, -C main worktree: commit" "$OUTSIDE/scratch-main" "git -C $MAIN commit -m x"
bash_case 0 "CLAUDE_PROJECT_DIR unset, scratch repo on main: commit" "$OUTSIDE/scratch-main" 'git commit --allow-empty -m x'
PROJECT=$OUTSIDE/not-a-repo
bash_case 2 "CLAUDE_PROJECT_DIR is not a repository, session in main/: commit" "$MAIN" 'git commit -m x'
bash_case 0 "CLAUDE_PROJECT_DIR is not a repository, scratch repo on main: commit" "$OUTSIDE/scratch-main" 'git commit --allow-empty -m x'
PROJECT=$MAIN; H=$OUTSIDE/loose/protect-main.sh
bash_case 2 "hook copied outside any repository, scratch repo on main: commit (every directory counts)" "$OUTSIDE/scratch-main" 'git commit --allow-empty -m x'
H=$HOOK

group "# File edits are judged by path"
edit_case 2 "edit a file under the main worktree"               "$BRANCH" "$MAIN/CLAUDE.md"
edit_case 0 "edit a file under a branch worktree"               "$MAIN"   "$BRANCH/CLAUDE.md"

group "# A plain clone, with no main/ beside its .git: commits and pushes on main are blocked, edits are not"
PLAIN=$OUTSIDE/plain; PLAIN_WORK=$OUTSIDE/plain-work
PROJECT=$PLAIN; H=$PLAIN/.claude/hooks/protect-main.sh
bash_case 2 "plain clone on main: commit"                       "$PLAIN" 'git commit -m x'
bash_case 2 "plain clone on main: bare push"                    "$PLAIN" 'git push'
bash_case 0 "plain clone on main: git status"                   "$PLAIN" 'git status'
edit_case 0 "plain clone on main: edit a file"                  "$PLAIN" "$PLAIN/AGENTS.md"
PROJECT=$PLAIN_WORK; H=$PLAIN_WORK/.claude/hooks/protect-main.sh
bash_case 0 "plain clone on a branch: commit"                   "$PLAIN_WORK" 'git commit -m x'
bash_case 0 "plain clone on a branch: push -u origin work"      "$PLAIN_WORK" 'git push -u origin work'
bash_case 2 "plain clone on a branch: push origin main"         "$PLAIN_WORK" 'git push origin main'
PROJECT=$MAIN; H=$HOOK

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
