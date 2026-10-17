import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Run git in `cwd`, isolated from the user's and the system's git config; throws when it fails. */
export function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=mdmem",
      "-c",
      "user.email=mdmem@example.com",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${proc.stderr.toString()}`
    );
  }
}

/** Create a repository at `dir` (which must exist) on branch main, with one commit. */
export async function gitRepo(dir: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README"), "x\n", "utf-8");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "init");
}
