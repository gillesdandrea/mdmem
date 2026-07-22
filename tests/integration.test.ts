import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { codexCliAdapter } from "../src/adapters/codex-cli.ts";
import type { AdapterContext } from "../src/adapters/index.ts";
import { serializeFact } from "../src/core/fact.ts";
import { reindex } from "../src/core/index.ts";
import { MemoryStore } from "../src/core/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

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

function settingsHasHook(json: string): boolean {
  const parsed: unknown = JSON.parse(json);
  return JSON.stringify(parsed).includes("memory session-start");
}

describe("tracer bullet: shared memory across two agents", () => {
  test("a fact written once is visible through both agents' wiring", async () => {
    const { root, ctx, store } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await codexCliAdapter.link(ctx);

      // Claude Code: always-loaded rule + SessionStart hook into personal settings.
      const rule = await readFile(
        join(root, ".claude/rules/memory.md"),
        "utf-8"
      );
      expect(rule).toContain("Memory protocol");
      const settings = await readFile(
        join(root, ".claude/settings.local.json"),
        "utf-8"
      );
      expect(settingsHasHook(settings)).toBe(true);

      // Codex CLI: protocol block merged into AGENTS.md at the repo root.
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("memory-cli:start");
      expect(agents).toContain("Memory protocol");

      // One agent records a fact; the index (shared by both) reflects it.
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
      const codexStatus = await codexCliAdapter.status(ctx);
      expect(claudeStatus.linked).toBe(true);
      expect(codexStatus.linked).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("linking twice is idempotent — no duplicate hook or block", async () => {
    const { root, ctx } = await tempProject();
    try {
      await claudeCodeAdapter.link(ctx);
      await claudeCodeAdapter.link(ctx);
      await codexCliAdapter.link(ctx);
      await codexCliAdapter.link(ctx);

      const settings: unknown = JSON.parse(
        await readFile(join(root, ".claude/settings.local.json"), "utf-8")
      );
      const sessionStart = (settings as { hooks: { SessionStart: unknown[] } })
        .hooks.SessionStart;
      expect(sessionStart).toHaveLength(1);

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
      await codexCliAdapter.link(ctx);
      await claudeCodeAdapter.unlink(ctx);
      await codexCliAdapter.unlink(ctx);

      expect(existsSync(join(root, ".claude/rules/memory.md"))).toBe(false);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false); // was only our block
      const settings = await readFile(
        join(root, ".claude/settings.local.json"),
        "utf-8"
      );
      expect(settingsHasHook(settings)).toBe(false);

      const claudeAfter = await claudeCodeAdapter.status(ctx);
      const codexAfter = await codexCliAdapter.status(ctx);
      expect(claudeAfter.linked).toBe(false);
      expect(codexAfter.linked).toBe(false);
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
      await codexCliAdapter.link(ctx);
      await codexCliAdapter.unlink(ctx);
      const agents = await readFile(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("Existing guidance.");
      expect(agents).not.toContain("memory-cli:start");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("cli", () => {
  test("init, add, status, session-start run end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "memcli-cli-"));
    await writeFile(join(root, "package.json"), "{}\n", "utf-8"); // deterministic project root
    try {
      const run = (...args: string[]) => {
        const proc = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
        return {
          code: proc.exitCode,
          out: proc.stdout.toString(),
          err: proc.stderr.toString(),
        };
      };

      const init = run("init");
      expect(init.code).toBe(0);
      expect(existsSync(join(root, ".memory/MEMORY.md"))).toBe(true);
      expect(await readFile(join(root, ".gitignore"), "utf-8")).toContain(
        ".memory/"
      );

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

      const status = run("status");
      expect(status.code).toBe(0);
      expect(status.out).toContain("Facts: 1");

      const session = run("session-start");
      expect(session.code).toBe(0);
      const payload: unknown = JSON.parse(session.out);
      expect(
        (payload as { hookSpecificOutput: { hookEventName: string } })
          .hookSpecificOutput.hookEventName
      ).toBe("SessionStart");
      expect(JSON.stringify(payload)).toContain("uses-bun");

      const link = run("link", "codex-cli");
      expect(link.code).toBe(0);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
