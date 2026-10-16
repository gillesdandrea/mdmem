import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
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
import { reindex } from "../src/core/index.ts";
import { serializeMemory } from "../src/core/memory.ts";
import { getConsolidatePrompt } from "../src/core/protocol.ts";
import { MemoryStore } from "../src/core/store.ts";

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
  // deterministic project root
  await writeFile(join(root, "package.json"), "{}\n", "utf-8");
  try {
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FAKE_AWS_KEY = `AKIA${"A".repeat(16)}`;

/** Write `count` project memories named m-0, m-1, … with `description`, then reindex. */
async function seedMemories(
  store: MemoryStore,
  count: number,
  description = "d"
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      store.create(
        `m-${i}.md`,
        serializeMemory({
          frontmatter: {
            name: `m-${i}`,
            description,
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
  test("init, add, status, enable run end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdmem-cli-"));
    // deterministic project root
    await writeFile(join(root, "package.json"), "{}\n", "utf-8");
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
      expect(doctor.out).toContain("✓ 1 memory, no problems");

      const storePath = run("path");
      expect(storePath.code).toBe(0);
      expect(storePath.out.trim()).toMatch(/[/\\]\.memory$/u);

      const del = run("delete", "uses-bun");
      expect(del.code).toBe(0);
      expect(existsSync(join(root, ".memory/uses-bun.md"))).toBe(false);

      // a broken memory ends the command with one line, not a stack trace
      await writeFile(join(root, ".memory/broken.md"), "no frontmatter\n");
      const search = run("search", "frontmatter");
      expect(search.code).toBe(1);
      expect(search.err).toBe(
        "mdmem: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---`\n"
      );

      // a broken memory elsewhere doesn't make a write that landed read as failed
      const staleWarning =
        "mdmem: warning: MEMORY.md is stale: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---` (run `mdmem doctor`)\n";
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
      expect(keep.err).toBe(staleWarning);
      const append = await editorScript(root, `printf 'More.\\n' >> "$1"`);
      const editKeep = runEdit(root, append, "keep");
      expect(editKeep.code).toBe(0);
      expect(editKeep.out).toBe("Saved keep.md\n");
      expect(editKeep.err).toBe(staleWarning);
      const dropKeep = run("delete", "keep");
      expect(dropKeep.code).toBe(0);
      expect(dropKeep.out).toBe("Deleted keep.md\n");
      expect(dropKeep.err).toBe(staleWarning);
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

  test("doctor reports a memory that holds a secret, by line and kind", async () => {
    await withCliProject(async (root, store) => {
      await store.create(
        "aws.md",
        serializeMemory({
          frontmatter: {
            name: "aws",
            description: "AWS access",
            metadata: { type: "reference" },
          },
          body: `Key: ${FAKE_AWS_KEY}`,
        })
      );
      await reindex(store);
      const doctor = runCli(root, "doctor");
      expect(doctor.code).toBe(1);
      expect(doctor.out).toContain(
        "aws.md: looks like it holds a secret at line 8 (AWS access key)"
      );
      expect(doctor.out).not.toContain(FAKE_AWS_KEY);
    });
  });

  test("doctor reports a pointer over 150 characters, naming its memory", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1, "x".repeat(140));
      const doctor = runCli(root, "doctor");
      expect(doctor.code).toBe(1);
      expect(doctor.out).toContain(
        "m-0.md: its pointer is 158 characters, over 150 — shorten its description"
      );
    });
  });

  test("doctor reports an index over its line limit", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 200);
      const doctor = runCli(root, "doctor");
      expect(doctor.code).toBe(1);
      expect(doctor.out).toContain(
        "MEMORY.md is at 206 lines, over its 200-line read limit"
      );
    });
  });

  test("doctor reports an index over its byte limit", async () => {
    await withCliProject(async (root, store) => {
      // 160 pointers of about 160 bytes each: past 25,000 bytes, short of 180 lines.
      await seedMemories(store, 160, "x".repeat(140));
      const doctor = runCli(root, "doctor");
      expect(doctor.code).toBe(1);
      expect(doctor.out).toMatch(
        /MEMORY\.md is at \d+ bytes, over its 25000-byte read limit/u
      );
      expect(doctor.out).not.toContain("-line read limit");
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
