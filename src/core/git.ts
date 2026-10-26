import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Every git call mdmem makes lives here. Each runs `git -C <dir>` synchronously and
 * answers null (or undefined) when git cannot tell: the directory is not in a
 * repository, the command fails, or git is not installed. None of them throws.
 */

interface GitResult {
  code: number | null;
  out: string;
}

function git(cwd: string, args: string[]): GitResult | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return { code: proc.exitCode, out: proc.stdout.toString().trim() };
  } catch {
    // git is not installed, or `cwd` does not exist
    return null;
  }
}

/** The output of a git command that succeeded with some output, else null. */
function gitOutput(cwd: string, args: string[]): string | null {
  const result = git(cwd, args);
  if (result?.code !== 0 || result.out === "") {
    return null;
  }
  return result.out;
}

/** The absolute git common dir of the repository holding `dir` (shared by all its worktrees), else null. */
function gitCommonDir(dir: string): string | null {
  // git prints it relative to `dir` or absolute; resolving it needs no --path-format (git 2.31+).
  const commonDir = gitOutput(dir, ["rev-parse", "--git-common-dir"]);
  return commonDir === null ? null : resolve(dir, commonDir);
}

/** The working tree of the superproject when `dir` is in a submodule, else null. */
function superprojectWorkingTree(dir: string): string | null {
  return gitOutput(dir, ["rev-parse", "--show-superproject-working-tree"]);
}

/** The working tree of the outermost superproject when `dir` is in a submodule (nested ones included), else null. */
export function outermostSuperproject(dir: string): string | null {
  let outermost: string | null = null;
  for (;;) {
    const superproject = superprojectWorkingTree(outermost ?? dir);
    if (superproject === null) {
      return outermost;
    }
    outermost = superproject;
  }
}

/** The top of the work tree holding `dir` (a linked worktree or submodule is its own), else null (a bare repository, or outside git). */
export function workTreeRoot(dir: string): string | null {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

/** The main checkout's work tree when `dir` is in a linked worktree, else null (a main checkout, a submodule, a bare repository, or outside git). */
export function mainCheckoutRoot(dir: string): string | null {
  const commonDir = gitCommonDir(dir);
  const top = workTreeRoot(dir);
  if (commonDir === null || top === null || basename(commonDir) !== ".git") {
    return null;
  }
  // git prints the top with symlinks resolved, and the common dir as reached from `dir`.
  let main = dirname(commonDir);
  try {
    main = realpathSync(main);
  } catch {
    // git just named it, so it exists; keep the path as git gave it
  }
  return main === top ? null : main;
}

/** The git common dir of the repository holding `dir`, its outermost superproject's in a submodule, else null outside git. */
function repositoryGitDir(dir: string): string | null {
  return gitCommonDir(outermostSuperproject(dir) ?? dir);
}

/**
 * The directory that keys the repository holding `dir`, or null outside git. A submodule
 * belongs to its outermost superproject. From there, the key is the parent of the git
 * common dir when that dir is named `.git` (a checkout and all its linked worktrees, or a
 * bare repository at `<dir>/.git`), else the common dir itself (a bare `x.git`).
 */
export function repositoryRoot(dir: string): string | null {
  const commonDir = repositoryGitDir(dir);
  if (commonDir === null) {
    return null;
  }
  return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/**
 * Whether `repositoryRoot(dir)` is the git common dir itself, one not named `.git`
 * (a bare `x.git`, a worktree of one, or a work tree made with --separate-git-dir),
 * so anything at the root sits inside the git directory, in no work tree. False for
 * a git directory named `.git`, bare or not, whose root is its parent, and outside git.
 */
export function rootIsGitDir(dir: string): boolean {
  const commonDir = repositoryGitDir(dir);
  return commonDir !== null && basename(commonDir) !== ".git";
}

/** `git check-ignore` exits 0 when the path is ignored, 1 when it is not, and 128 on an error. */
const CHECK_IGNORE_IGNORED = 0;
const CHECK_IGNORE_NOT_IGNORED = 1;

/**
 * Whether git ignores `path` (relative to the work tree `root`): true or false, or
 * undefined when git cannot tell (no work tree at `root`, such as a bare repository).
 * A pattern with a trailing slash matches only a directory that exists.
 */
export function isIgnoredByGit(
  root: string,
  path: string
): boolean | undefined {
  const result = git(root, ["check-ignore", "-q", path]);
  if (result?.code === CHECK_IGNORE_IGNORED) {
    return true;
  }
  if (result?.code === CHECK_IGNORE_NOT_IGNORED) {
    return false;
  }
  return undefined;
}

const WORKTREE_LINE_PREFIX = "worktree ";

/**
 * The absolute path of every worktree of the repository holding `dir`, as
 * `git worktree list` gives them: the main worktree (a bare repository's own
 * directory) first, then each linked worktree. Empty outside git.
 */
export function worktreePaths(dir: string): string[] {
  const out = gitOutput(dir, ["worktree", "list", "--porcelain"]);
  if (out === null) {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.startsWith(WORKTREE_LINE_PREFIX))
    .map((line) => line.slice(WORKTREE_LINE_PREFIX.length));
}
