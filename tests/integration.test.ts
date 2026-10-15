import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsAdapter } from "../src/adapters/agents.ts";
import { bobAdapter } from "../src/adapters/bob.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { cursorAdapter } from "../src/adapters/cursor.ts";
import type { AdapterContext } from "../src/adapters/index.ts";
import { reindex } from "../src/core/index.ts";
import { serializeMemory } from "../src/core/memory.ts";
import { MemoryStore } from "../src/core/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const CLAUDE_SETTINGS = ".claude/settings.local.json";

async function tempProject(): Promise<{
  root: string;
  ctx: AdapterContext;
  store: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "memcli-int-"));
  const storeDir = join(root, ".memory");
  const store = new MemoryStore(storeDir);
  // creates .memory + empty index
  await reindex(store);
  return { root, ctx: { projectRoot: root, storeDir, home: root }, store };
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

describe("cli", () => {
  test("init, add, status, enable run end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "memcli-cli-"));
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
      expect(dup.code).not.toBe(0);
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

      const edited = run("edit", "uses-bun");
      expect(edited.code).toBe(0);
      expect(edited.out).toContain("Saved uses-bun.md");

      const doctor = run("doctor");
      expect(doctor.code).toBe(0);
      expect(doctor.out).toContain("no problems");

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
      const editKeep = run("edit", "keep");
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
});
