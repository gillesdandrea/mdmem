import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { agentsAdapter } from "../src/adapters/agents.ts";
import { bobAdapter } from "../src/adapters/bob.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { cursorAdapter } from "../src/adapters/cursor.ts";
import type { AdapterContext } from "../src/adapters/index.ts";
import { reindex } from "../src/core/check.ts";
import { HOOK_CONTEXT_MAX_CHARS } from "../src/core/hook.ts";
import { serializeMemory } from "../src/core/memory.ts";
import {
  getConsolidatePrompt,
  getMemoryProtocol,
} from "../src/core/protocol.ts";
import { MemoryStore } from "../src/core/store.ts";
import { git, gitRepo } from "./git-fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const CLAUDE_SETTINGS = ".claude/settings.local.json";

async function tempProject(): Promise<{
  root: string;
  ctx: AdapterContext;
  store: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "mdmem-int-"));
  const storeDir = join(root, ".memory");
  const store = new MemoryStore(storeDir);
  // creates .memory + empty index
  await reindex(store);
  return { root, ctx: { projectRoot: root, storeDir }, store };
}

async function autoMemoryDir(root: string): Promise<string | undefined> {
  const path = join(root, CLAUDE_SETTINGS);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  return (parsed as { autoMemoryDirectory?: string }).autoMemoryDirectory;
}

describe("tracer bullet: shared memory across agents", () => {
  test("a memory saved once is reachable through both agents' wiring", async () => {
    const { root, ctx, store } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await agentsAdapter.link(ctx);

      // Claude: its native memory is pointed at the shared store (absolute path).
      expect(await autoMemoryDir(root)).toBe(ctx.storeDir);

      // AGENTS.md: protocol block merged in at the repo root.
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("mdmem:start");
      expect(agents).toContain("Memory protocol");

      // One agent saves a memory; the shared index reflects it.
      await store.create(
        "prefers-bun.md",
        serializeMemory({
          frontmatter: {
            name: "prefers-bun",
            description: "Uses bun",
            metadata: { type: "feedback" },
          },
          body: "Use bun.\n\n**Why:** standardized. **How to apply:** run scripts with bun.",
        })
      );
      await reindex(store);
      const index = await readFile(join(root, ".memory/MEMORY.md"), "utf-8");
      expect(index).toContain("[prefers-bun](prefers-bun.md)");

      const claudeStatus = await claudeCodeAdapter.status(ctx);
      const agentsStatus = await agentsAdapter.status(ctx);
      expect(claudeStatus.linked).toBe(true);
      expect(agentsStatus.linked).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("linking twice is idempotent", async () => {
    const { root, ctx } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await claudeCodeAdapter.link(ctx);
      await agentsAdapter.link(ctx);
      await agentsAdapter.link(ctx);

      expect(await autoMemoryDir(root)).toBe(ctx.storeDir);
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      // exactly one marker
      expect(agents.split("mdmem:start")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unlink removes all wiring cleanly", async () => {
    const { root, ctx } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await agentsAdapter.link(ctx);
      await claudeCodeAdapter.unlink(ctx);
      await agentsAdapter.unlink(ctx);

      expect(await autoMemoryDir(root)).toBeUndefined();
      // was only our block
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);

      const claudeStatus = await claudeCodeAdapter.status(ctx);
      const agentsStatus = await agentsAdapter.status(ctx);
      expect(claudeStatus.linked).toBe(false);
      expect(agentsStatus.linked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unlink preserves unrelated AGENTS.md content", async () => {
    const { root, ctx } = await tempProject();
    try {
      await writeFile(
        join(root, "AGENTS.md"),
        "# Project\n\nExisting guidance.\n",
        "utf-8"
      );
      await agentsAdapter.link(ctx);
      await agentsAdapter.unlink(ctx);
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("Existing guidance.");
      expect(agents).not.toContain("mdmem:start");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude unlink leaves other settings untouched", async () => {
    const { root, ctx } = await tempProject();
    try {
      const path = join(root, CLAUDE_SETTINGS);
      await claudeCodeAdapter.link(ctx);
      // simulate a pre-existing personal setting alongside ours
      const withExtra: unknown = {
        ...(JSON.parse(await readFile(path, "utf-8")) as object),
        theme: "dark",
      };
      await writeFile(path, JSON.stringify(withExtra), "utf-8");
      await claudeCodeAdapter.unlink(ctx);
      const after: unknown = JSON.parse(await readFile(path, "utf-8"));
      expect((after as { theme?: string }).theme).toBe("dark");
      expect(
        (after as { autoMemoryDirectory?: string }).autoMemoryDirectory
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bob adapter installs and removes .bob/rules/memory.md", async () => {
    const { root, ctx } = await tempProject();
    try {
      await bobAdapter.link(ctx);
      const rule = await readFile(join(root, ".bob/rules/memory.md"), "utf-8");
      expect(rule).toContain("Memory protocol");
      const linkedStatus = await bobAdapter.status(ctx);
      expect(linkedStatus.linked).toBe(true);

      await bobAdapter.unlink(ctx);
      expect(existsSync(join(root, ".bob/rules/memory.md"))).toBe(false);
      const unlinkedStatus = await bobAdapter.status(ctx);
      expect(unlinkedStatus.linked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cursor adapter installs .cursor/rules/memory.mdc with always-apply frontmatter", async () => {
    const { root, ctx } = await tempProject();
    try {
      await cursorAdapter.link(ctx);
      const rule = await readFile(
        join(root, ".cursor/rules/memory.mdc"),
        "utf-8"
      );
      expect(rule).toContain("alwaysApply: true");
      expect(rule).toContain("Memory protocol");
      const linkedStatus = await cursorAdapter.status(ctx);
      expect(linkedStatus.linked).toBe(true);

      await cursorAdapter.unlink(ctx);
      expect(existsSync(join(root, ".cursor/rules/memory.mdc"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Run the CLI in `root` with `args` and `env` added to this process's environment, capturing its exit code and output. */
function runCliWith(root: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/** Run the CLI in `root`, capturing its exit code and output. */
function runCli(root: string, ...args: string[]) {
  return runCliWith(root, args, {});
}

/** An editor for `mdmem edit`: a shell script in `root` that runs `command` on the file it is given as $1. */
async function editorScript(root: string, command: string): Promise<string> {
  const path = join(root, "editor.sh");
  await writeFile(path, `#!/bin/sh\n${command}\n`, "utf-8");
  await chmod(path, 0o755);
  return path;
}

/** Run `mdmem edit <name>` in `root` with `editor` as $VISUAL. */
function runEdit(root: string, editor: string, name: string) {
  return runCliWith(root, ["edit", name], { VISUAL: editor });
}

const EDIT_KEPT_RE = /your edit is kept at (?<copy>\S+)\n$/u;

/** A project with an initialized store, removed after `fn`. */
async function withCliProject(
  fn: (root: string, store: MemoryStore) => Promise<void> | void
): Promise<void> {
  const { root, store } = await tempProject();
  try {
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FAKE_AWS_KEY = `AKIA${"A".repeat(16)}`;

/** Write `count` project memories named m-0, m-1, …, then reindex. */
async function seedMemories(store: MemoryStore, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      store.create(
        `m-${i}.md`,
        serializeMemory({
          frontmatter: {
            name: `m-${i}`,
            description: "d",
            metadata: { type: "project" },
          },
          body: "b",
        })
      )
    )
  );
  await reindex(store);
}

describe("cli", () => {
  test("init in a linked worktree creates the store at the main checkout's root, leaving .gitignore alone", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const repo = join(tmp, "repo");
      await mkdir(repo);
      await gitRepo(repo);
      await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf-8");
      const worktree = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", worktree, "-b", "wt");

      // the user's global excludes must not decide whether git ignores .memory/
      const init = runCliWith(worktree, ["init"], {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      });
      expect(init.code).toBe(0);
      expect(init.out).toBe(
        [
          `Initialized memory store at ${join(repo, ".memory")}`,
          "Note: git does not ignore .memory/; ignoring or committing it is your choice.",
          "Next: `mdmem enable --all` to wire up your agents.",
          "",
        ].join("\n")
      );
      expect(existsSync(join(repo, ".memory/MEMORY.md"))).toBe(true);
      expect(existsSync(join(worktree, ".memory"))).toBe(false);
      expect(await readFile(join(repo, ".gitignore"), "utf-8")).toBe(
        "node_modules/\n"
      );

      // enable wires the worktree it runs in, not the main checkout holding the store
      expect(runCli(worktree, "enable", "agents").code).toBe(0);
      expect(existsSync(join(worktree, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("without git, init stops its walk before $HOME and creates the store in the working directory", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const home = join(tmp, "home");
      await mkdir(join(home, ".memory"), { recursive: true });
      const start = join(home, "a", "b");
      await mkdir(start, { recursive: true });

      const init = runCliWith(start, ["init"], { HOME: home });
      expect(init.code).toBe(0);
      expect(init.out).toStartWith(
        `Initialized memory store at ${join(start, ".memory")}\n`
      );
      expect(existsSync(join(start, ".memory/MEMORY.md"))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("init, add, status, enable run end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdmem-cli-"));
    try {
      const run = (...args: string[]) => {
        const proc = Bun.spawnSync(["bun", CLI, ...args], {
          cwd: root,
          // no-op editor
          env: { ...process.env, EDITOR: "true", VISUAL: "true" },
        });
        return {
          code: proc.exitCode,
          out: proc.stdout.toString(),
          err: proc.stderr.toString(),
        };
      };

      const init = run("init");
      expect(init.code).toBe(0);
      expect(existsSync(join(root, ".memory/MEMORY.md"))).toBe(true);

      const add = run(
        "add",
        "--type",
        "feedback",
        "--name",
        "uses-bun",
        "--description",
        "Uses bun",
        "--body",
        "Use bun."
      );
      expect(add.code).toBe(0);
      expect(existsSync(join(root, ".memory/uses-bun.md"))).toBe(true);

      const read = run("read", "uses-bun");
      expect(read.code).toBe(0);
      expect(read.out).toContain("Use bun.");

      const readIndex = run("read", "MEMORY.md");
      expect(readIndex.code).toBe(0);
      expect(readIndex.out).toContain("[uses-bun](uses-bun.md)");

      const status = run("status");
      expect(status.code).toBe(0);
      expect(status.out).toContain("Memories: 1");

      const enable = run("enable", "agents");
      expect(enable.code).toBe(0);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(true);

      const claude = run("enable", "claude-code");
      expect(claude.code).toBe(0);
      // absolute path to the store (spawned cwd may resolve /var → /private/var)
      expect(await autoMemoryDir(root)).toMatch(/[/\\]\.memory$/u);

      // add refuses to clobber an existing name without --force
      const dup = run(
        "add",
        "--type",
        "feedback",
        "--name",
        "uses-bun",
        "--description",
        "again",
        "--body",
        "x"
      );
      expect(dup.code).toBe(1);
      expect(dup.err).toBe(
        'mdmem: a memory named "uses-bun" already exists — pass --force to overwrite, or `mdmem delete uses-bun`\n'
      );
      const forced = run(
        "add",
        "--type",
        "feedback",
        "--name",
        "uses-bun",
        "--description",
        "again",
        "--body",
        "x",
        "--force"
      );
      expect(forced.code).toBe(0);

      // the no-op editor leaves the memory as it was
      const edited = run("edit", "uses-bun");
      expect(edited.code).toBe(0);
      expect(edited.out).toBe("Unchanged uses-bun.md\n");

      const doctor = run("doctor");
      expect(doctor.code).toBe(0);
      expect(doctor.out).toBe("✓ 1 memory, no problems\n");
      const check = run("check");
      expect(check.code).toBe(0);
      expect(check.out).toBe(doctor.out);

      const storePath = run("path");
      expect(storePath.code).toBe(0);
      expect(storePath.out.trim()).toMatch(/[/\\]\.memory$/u);

      const del = run("delete", "uses-bun");
      expect(del.code).toBe(0);
      expect(existsSync(join(root, ".memory/uses-bun.md"))).toBe(false);

      // a search skips a broken memory and warns of it on stderr
      await writeFile(join(root, ".memory/broken.md"), "no frontmatter\n");
      const search = run("search", "frontmatter");
      expect(search.code).toBe(0);
      expect(search.out).toBe('No memories matching "frontmatter".\n');
      expect(search.err).toBe(
        "mdmem: warning: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---`\n"
      );

      // a broken memory elsewhere doesn't make a write that landed read as failed
      const brokenWarning =
        "mdmem: warning: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---` (it has no pointer in MEMORY.md until it parses)\n";
      const keep = run(
        "add",
        "--type",
        "user",
        "--name",
        "keep",
        "--description",
        "k",
        "--body",
        "k"
      );
      expect(keep.code).toBe(0);
      expect(keep.out).toBe("Saved keep.md\n");
      expect(keep.err).toBe(brokenWarning);
      const append = await editorScript(root, `printf 'More.\\n' >> "$1"`);
      const editKeep = runEdit(root, append, "keep");
      expect(editKeep.code).toBe(0);
      expect(editKeep.out).toBe("Saved keep.md\n");
      expect(editKeep.err).toBe(brokenWarning);
      const dropKeep = run("delete", "keep");
      expect(dropKeep.code).toBe(0);
      expect(dropKeep.out).toBe("Deleted keep.md\n");
      expect(dropKeep.err).toBe(brokenWarning);
      expect(existsSync(join(root, ".memory/keep.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("edit refuses an invalid memory, leaving the store untouched and keeping the edit", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const before = await store.view("m-0.md");
      const breaks = await editorScript(root, `echo 'no frontmatter' > "$1"`);
      const edit = runEdit(root, breaks, "m-0");
      expect(edit.code).toBe(1);
      expect(edit.err).toStartWith(
        "mdmem: m-0.md: unparseable — Memory file is missing YAML frontmatter"
      );
      expect(await store.view("m-0.md")).toBe(before);
      const copy = edit.err.match(EDIT_KEPT_RE)?.groups?.copy ?? "";
      expect(copy).toMatch(/[/\\]mdmem-[^/\\]+[/\\]m-0\.md$/u);
      expect(await readFile(copy, "utf-8")).toBe("no frontmatter\n");
      await rm(dirname(copy), { recursive: true, force: true });
    });
  });

  test("edit refuses the index before opening an editor, and keeps the copy when the editor fails", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const marker = join(root, "editor-ran");
      const touches = await editorScript(root, `touch "${marker}"`);
      const index = runEdit(root, touches, "MEMORY.md");
      expect(index.code).toBe(1);
      expect(index.err).toStartWith(
        'mdmem: Refused "MEMORY.md": that is the index\'s path'
      );
      expect(existsSync(marker)).toBe(false);

      const fails = await editorScript(root, `echo 'half' > "$1"; exit 3`);
      const edit = runEdit(root, fails, "m-0");
      expect(edit.code).toBe(1);
      expect(edit.err).toStartWith("mdmem: editor exited with code 3\n");
      const copy = edit.err.match(EDIT_KEPT_RE)?.groups?.copy ?? "";
      expect(await readFile(copy, "utf-8")).toBe("half\n");
      await rm(dirname(copy), { recursive: true, force: true });
    });
  });

  test("add refuses a secret, naming its line and kind but never the secret", async () => {
    await withCliProject((root, store) => {
      const add = runCli(
        root,
        "add",
        "--type",
        "reference",
        "--name",
        "aws",
        "--description",
        "AWS access",
        "--body",
        `Key: ${FAKE_AWS_KEY}`
      );
      expect(add.code).toBe(1);
      expect(add.err).toContain("(AWS access key)");
      expect(add.err).not.toContain(FAKE_AWS_KEY);
      expect(store.exists("aws.md")).toBe(false);
    });
  });

  test("consolidate prints the consolidation prompt with the store's path", async () => {
    await withCliProject(async (root, store) => {
      const consolidate = runCli(root, "consolidate");
      expect(consolidate.code).toBe(0);
      // The CLI resolves its working directory, so the tmpdir symlink is resolved too.
      const storeDir = await realpath(store.root);
      expect(consolidate.out).toBe(getConsolidatePrompt(storeDir));
      expect(consolidate.out).toContain(`Memory store: \`${storeDir}\``);
      expect(consolidate.out).toContain("## Phase 5 — Reconcile");
    });
  });
});

/** Run `mdmem hook <agent> <part>` in `cwd` with `payload` on stdin, capturing its exit code and output. */
function runHookCli(cwd: string, part: string, payload: unknown) {
  const proc = Bun.spawnSync(["bun", CLI, "hook", "claude-code", part], {
    cwd,
    stdin: Buffer.from(
      typeof payload === "string" ? payload : JSON.stringify(payload)
    ),
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/** A SessionStart payload for a new session in `cwd`. */
function startPayload(cwd: string) {
  return { cwd, hook_event_name: "SessionStart", source: "startup" };
}

/** The context `mdmem hook` printed, after checking its output is the SessionStart form. */
function injected(out: string): string {
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const context = parsed.hookSpecificOutput.additionalContext;
  expect([...context].length).toBeLessThan(HOOK_CONTEXT_MAX_CHARS);
  return context;
}

/** Write `count` memory files with no frontmatter, each a warning in the index part. */
async function seedBroken(store: MemoryStore, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      store.create(`broken-${i}.md`, "no frontmatter")
    )
  );
}

/** An index over its limit: every line kept by reindex, since none is a pointer. */
function oversizedIndex(): string {
  return Array.from(
    { length: 200 },
    (_, i) => `Line ${i}: ${"x".repeat(60)}\n`
  ).join("");
}

describe("hook", () => {
  test("the protocol part injects the rendered memory protocol", async () => {
    await withCliProject((root) => {
      const hook = runHookCli(root, "protocol", startPayload(root));
      expect(hook.code).toBe(0);
      expect(injected(hook.out)).toBe(getMemoryProtocol());
    });
  });

  test("the index part names the store's absolute path, then holds the index", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 2);
      const storeDir = join(await realpath(root), ".memory");
      const index = await readFile(join(storeDir, "MEMORY.md"), "utf-8");

      const hook = runHookCli(root, "index", startPayload(root));
      expect(hook.code).toBe(0);
      expect(injected(hook.out)).toBe(
        `Memory store: ${storeDir}\n\nMEMORY.md:\n${index.trimEnd()}`
      );
    });
  });

  test("it prints nothing without a store, on resume, or for another event", async () => {
    const bare = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      expect(runHookCli(bare, "index", startPayload(bare))).toEqual({
        code: 0,
        out: "",
        err: "",
      });
      await withCliProject((root) => {
        for (const payload of [
          { ...startPayload(root), source: "resume" },
          { cwd: root, hook_event_name: "UserPromptSubmit" },
        ]) {
          expect(runHookCli(root, "protocol", payload)).toEqual({
            code: 0,
            out: "",
            err: "",
          });
        }
      });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("a payload cwd in a linked worktree resolves the main checkout's store", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const repo = join(tmp, "repo");
      await mkdir(join(repo, ".memory"), { recursive: true });
      await gitRepo(repo);
      const worktree = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", worktree, "-b", "wt");

      // run from elsewhere: the payload's cwd decides
      const hook = runHookCli(tmp, "index", startPayload(worktree));
      expect(injected(hook.out)).toStartWith(
        `Memory store: ${join(repo, ".memory")}\n`
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("the index part warns of a broken memory and a stale index, one line each", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      await store.create("broken.md", "no\nfrontmatter");
      await store.create(
        "late.md",
        serializeMemory({
          frontmatter: {
            name: "late",
            description: "d",
            metadata: { type: "project" },
          },
          body: "b",
        })
      );

      const context = injected(
        runHookCli(root, "index", startPayload(root)).out
      );
      expect(context.split("\n").slice(1, 4)).toEqual([
        "Warning: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---`",
        "Warning: MEMORY.md is stale: no pointer to late.md — run `mdmem reindex`",
        "",
      ]);
    });
  });

  test("warnings past the size limit are counted, not listed", async () => {
    await withCliProject(async (root, store) => {
      // an index near its limit leaves room for only a few warnings
      await seedMemories(store, 370);
      await seedBroken(store, 40);

      const context = injected(
        runHookCli(root, "index", startPayload(root)).out
      );
      const warnings = context
        .split("\n")
        .filter((line) => line.startsWith("Warning: broken-"));
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.length).toBeLessThan(40);
      expect(context).toContain(
        `Warning: ${40 - warnings.length} more warnings left out; memory_check lists them all.`
      );
      // the index itself is whole
      expect(context).toContain("\n\nMEMORY.md:\n- [m-0](m-0.md) — d\n");
      expect(context).toEndWith("- [m-99](m-99.md) — d");
    });
  });

  test("an index over its limit is cut short, with warnings, under the size limit", async () => {
    await withCliProject(async (root, store) => {
      await store.create("MEMORY.md", oversizedIndex());
      await seedBroken(store, 40);

      const context = injected(
        runHookCli(root, "index", startPayload(root)).out
      );
      expect(context).toMatch(
        /\nMEMORY\.md, cut short \(\d+ of 200 lines\): memory_read MEMORY\.md for the rest, and run a consolidation to bring it under 9,500 characters\.\nLine 0: /u
      );
      expect(context).toContain("more warnings left out");
    });
  });

  test("an index under its limit cut only to fit a long store path asks for no consolidation", async () => {
    const base = await mkdtemp(join(tmpdir(), "mdmem-int-"));
    try {
      const root = join(base, "d".repeat(200), "e".repeat(200));
      const store = new MemoryStore(join(root, ".memory"));
      await reindex(store);
      // 150 lines of 62 characters: 9,449 characters, under the index limit
      const index = Array.from(
        { length: 150 },
        (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(58)}\n`
      ).join("");
      await writeFile(join(store.root, "MEMORY.md"), index);

      const context = injected(
        runHookCli(root, "index", startPayload(root)).out
      );
      expect(context).toMatch(
        /\n\nMEMORY\.md, cut short \(\d+ of 150 lines\): memory_read MEMORY\.md for the rest\.\n000 /u
      );
      expect(context).not.toContain("consolidation");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("an internal error becomes a one-line context, and the hook exits 0", async () => {
    await withCliProject(async (root, store) => {
      const garbled = runHookCli(root, "index", "{not json");
      expect(garbled.code).toBe(0);
      expect(injected(garbled.out)).toStartWith(
        "mdmem could not load the memory: the hook payload is not JSON"
      );

      await rm(join(store.root, "MEMORY.md"));
      await mkdir(join(store.root, "MEMORY.md"));

      const hook = runHookCli(root, "index", startPayload(root));
      expect(hook.code).toBe(0);
      expect(hook.err).toBe("");
      const context = injected(hook.out);
      expect(context).toStartWith("mdmem could not load the memory: ");
      expect(context).not.toContain("\n");
      expect(context).not.toContain("    at ");
    });
  });
});
