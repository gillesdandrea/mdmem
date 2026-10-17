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

/** The top of the work tree holding `dir` (a linked worktree or submodule is its own), else null (a bare repository, or outside git). */
export function workTreeRoot(dir: string): string | null {
  return gitOutput(dir, ["rev-parse", "--show-toplevel"]);
}

/**
 * The directory that keys the repository holding `dir`, or null outside git. A submodule
 * belongs to its outermost superproject. From there, the key is the parent of the git
 * common dir when that dir is named `.git` (a checkout and all its linked worktrees, or a
 * bare repository at `<dir>/.git`), else the common dir itself (a bare `x.git`).
 */
export function repositoryRoot(dir: string): string | null {
  let top = dir;
  for (;;) {
    const superproject = superprojectWorkingTree(top);
    if (superproject === null) {
      break;
    }
    top = superproject;
  }
  const commonDir = gitCommonDir(top);
  if (commonDir === null) {
    return null;
  }
  return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
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
