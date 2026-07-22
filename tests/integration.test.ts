import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsAdapter } from "../src/adapters/agents.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import type { AdapterContext } from "../src/adapters/index.ts";
import { serializeFact } from "../src/core/fact.ts";
import { reindex } from "../src/core/index.ts";
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
  await reindex(store); // creates .memory + empty index
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
  test("a fact written once is reachable through both agents' wiring", async () => {
    const { root, ctx, store } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await agentsAdapter.link(ctx);

      // Claude: its native memory is pointed at the shared store (absolute path).
      expect(await autoMemoryDir(root)).toBe(ctx.storeDir);

      // AGENTS.md: protocol block merged in at the repo root.
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("memory-cli:start");
      expect(agents).toContain("Memory protocol");

      // One agent records a fact; the shared index reflects it.
      await store.create(
        "prefers-bun.md",
        serializeFact({
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
      expect(agents.split("memory-cli:start")).toHaveLength(2); // exactly one marker
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
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false); // was only our block

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
      expect(agents).not.toContain("memory-cli:start");
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
});

describe("cli", () => {
  test("init, add, status, enable run end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "memcli-cli-"));
    await writeFile(join(root, "package.json"), "{}\n", "utf-8"); // deterministic project root
    try {
      const run = (...args: string[]) => {
        const proc = Bun.spawnSync(["bun", CLI, ...args], {
          cwd: root,
          env: { ...process.env, EDITOR: "true", VISUAL: "true" }, // no-op editor
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
      expect(status.out).toContain("Facts: 1");

      const enable = run("enable", "agents");
      expect(enable.code).toBe(0);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(true);

      const claude = run("enable", "claude-code");
      expect(claude.code).toBe(0);
      // absolute path to the store (spawned cwd may resolve /var → /private/var)
      expect(await autoMemoryDir(root)).toMatch(/[/\\]\.memory$/u);

      // add refuses to clobber an existing slug without --force
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
