import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import packageJson from "../package.json" with { type: "json" };
import {
  enableAdvice,
  MCP_SERVER,
  OUTSIDE_PROJECT_LINE,
} from "../src/adapters/adapter.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  Scope,
  WiringEntry,
  WiringPlan,
  WiringResult,
} from "../src/adapters/adapter.ts";
import { bobAdapter } from "../src/adapters/bob.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import {
  adapterContext,
  checkProject,
  projectStatus,
} from "../src/adapters/report.ts";
import { checkSummary, INDEX_MAX_CHARS, reindex } from "../src/core/check.ts";
import {
  HOOK_CONTEXT_MAX_CHARS,
  SESSION_START_PARTS,
} from "../src/core/hook.ts";
import type { HookAgent } from "../src/core/hook.ts";
import { claudeProjectDir, importMarker } from "../src/core/import.ts";
import { projectKey } from "../src/core/key.ts";
import { parseMemory, serializeMemory } from "../src/core/memory.ts";
import {
  getConsolidatePrompt,
  getMemoryProtocol,
} from "../src/core/protocol.ts";
import {
  DELTA_HEADER,
  HITS_HEADER,
  PROMPT_CONTEXT_MAX_CHARS,
} from "../src/core/recall.ts";
import { RefusalError } from "../src/core/refusal.ts";
import type { SessionState } from "../src/core/session.ts";
import { MemoryStore, versionOf } from "../src/core/store.ts";
import { git, gitRepo } from "./git-fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const CLAUDE_SETTINGS = ".claude/settings.json";
const MCP_CONFIG = ".mcp.json";

/** A project with an empty store, and a context whose Claude Code config directory is a temp dir, never the real ~/.claude. */
async function tempProject(): Promise<{
  root: string;
  ctx: AdapterContext;
  store: MemoryStore;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mdmem-int-")));
  const store = new MemoryStore(join(root, ".mdmem"));
  // creates .mdmem + empty index: a local store
  await reindex(store);
  const env = { CLAUDE_CONFIG_DIR: join(root, "claude-config") };
  const home = join(root, "home");
  return {
    root,
    ctx: { project: { root, store }, env, home, cwd: root },
    store,
  };
}

/** A status's entries in `scope`; none when status has no such scope. */
function scopeEntries(status: AgentStatus, scope: Scope): WiringEntry[] {
  return status.scopes.find((found) => found.scope === scope)?.entries ?? [];
}

function projectEntries(status: AgentStatus): WiringEntry[] {
  return scopeEntries(status, "project");
}

function memoryText(name: string, body: string): string {
  return serializeMemory({
    frontmatter: {
      name,
      description: `About ${name}`,
      metadata: { type: "project" },
    },
    body,
  });
}

/** Put a memory in Claude Code's memory directory for the project at `root`. */
async function claudeMemory(
  ctx: AdapterContext,
  root: string,
  file: string,
  content: string
): Promise<void> {
  const dir = join(claudeProjectDir(root, ctx), "memory");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, "utf-8");
}

/** Plan an adapter's enable or disable, then write it. */
async function wire(plan: Promise<WiringPlan>): Promise<WiringResult> {
  const planned = await plan;
  return await planned.write();
}

async function wired(adapter: Adapter, ctx: AdapterContext): Promise<boolean> {
  const status = await adapter.status(ctx);
  return status.wired;
}

async function readText(path: string): Promise<string | undefined> {
  return existsSync(path) ? await readFile(path, "utf-8") : undefined;
}

const HOOK_MATCHER = "startup|clear|compact";
const mdmemHook = (part: string) => ({
  matcher: HOOK_MATCHER,
  hooks: [{ type: "command", command: `mdmem hook claude-code ${part}` }],
});
/** Claude Code's UserPromptSubmit group: no matcher, no timeout. */
const mdmemPromptHook = (suffix = "") => ({
  hooks: [
    { type: "command", command: `mdmem hook claude-code prompt${suffix}` },
  ],
});
const MDMEM_SERVER = { type: "stdio", command: "mdmem", args: ["mcp"] };

describe("claude-code wiring", () => {
  test("enable merges mdmem's entries into existing files, keeping the rest byte for byte, and disable takes exactly them out", async () => {
    const { root, ctx } = await tempProject();
    try {
      const otherHook = {
        matcher: "startup",
        hooks: [{ type: "command", command: "echo hi" }],
      };
      const otherPromptHook = {
        hooks: [{ type: "command", command: "echo prompt" }],
      };
      const settings = {
        model: "opus",
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
          ],
          SessionStart: [otherHook],
          UserPromptSubmit: [otherPromptHook],
        },
        permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] },
      };
      const mcp = { mcpServers: { other: { command: "other-server" } } };
      const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
      const mcpText = `${JSON.stringify(mcp, null, 2)}\n`;
      await mkdir(join(root, ".claude"));
      await writeFile(join(root, CLAUDE_SETTINGS), settingsText, "utf-8");
      await writeFile(join(root, MCP_CONFIG), mcpText, "utf-8");

      const enabled = await wire(claudeCodeAdapter.enable(ctx, "project"));
      expect(enabled.actions).toContain(
        `added in ${CLAUDE_SETTINGS}: autoMemoryEnabled: false, SessionStart hook "mdmem hook claude-code protocol", SessionStart hook "mdmem hook claude-code index", UserPromptSubmit hook "mdmem hook claude-code prompt", permissions.allow "mcp__mdmem"`
      );
      const wiredSettings = {
        model: "opus",
        hooks: {
          PreToolUse: settings.hooks.PreToolUse,
          SessionStart: [otherHook, mdmemHook("protocol"), mdmemHook("index")],
          UserPromptSubmit: [otherPromptHook, mdmemPromptHook()],
        },
        permissions: {
          allow: ["Bash(ls:*)", "mcp__mdmem"],
          deny: ["Read(.env)"],
        },
        autoMemoryEnabled: false,
      };
      const wiredMcp = {
        mcpServers: { other: mcp.mcpServers.other, mdmem: MDMEM_SERVER },
      };
      expect(await readText(join(root, CLAUDE_SETTINGS))).toBe(
        `${JSON.stringify(wiredSettings, null, 2)}\n`
      );
      expect(await readText(join(root, MCP_CONFIG))).toBe(
        `${JSON.stringify(wiredMcp, null, 2)}\n`
      );
      const status = await claudeCodeAdapter.status(ctx);
      expect(status.wired).toBe(true);
      expect(projectEntries(status)).toHaveLength(6);

      // a second run changes nothing
      const again = await wire(claudeCodeAdapter.enable(ctx, "project"));
      expect(again.actions).toContain(
        `${CLAUDE_SETTINGS} already holds mdmem's entries`
      );
      expect(await readText(join(root, CLAUDE_SETTINGS))).toBe(
        `${JSON.stringify(wiredSettings, null, 2)}\n`
      );

      await wire(claudeCodeAdapter.disable(ctx, "project"));
      expect(await readText(join(root, CLAUDE_SETTINGS))).toBe(settingsText);
      expect(await readText(join(root, MCP_CONFIG))).toBe(mcpText);
      const after = await claudeCodeAdapter.status(ctx);
      expect(after.wired).toBe(false);
      expect(projectEntries(after).some(({ present }) => present)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable refuses autoMemoryEnabled: true, naming the key, and writes nothing", async () => {
    const { root, ctx } = await tempProject();
    try {
      const settingsText = '{\n  "autoMemoryEnabled": true\n}\n';
      await mkdir(join(root, ".claude"));
      await writeFile(join(root, CLAUDE_SETTINGS), settingsText, "utf-8");

      await expect(claudeCodeAdapter.enable(ctx, "project")).rejects.toThrow(
        new RefusalError(
          `${CLAUDE_SETTINGS}: autoMemoryEnabled holds a value that is not mdmem's, so mdmem will not overwrite it: remove it or set it to false, then run the command again`
        )
      );
      expect(await readText(join(root, CLAUDE_SETTINGS))).toBe(settingsText);
      expect(existsSync(join(root, MCP_CONFIG))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a hook of mdmem's with a timeout added counts as wired, is not added again, and disable removes it", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(claudeCodeAdapter.enable(ctx, "project"));
      const path = join(root, CLAUDE_SETTINGS);
      const settings = JSON.parse((await readText(path)) ?? "{}");
      settings.hooks.SessionStart[0].hooks[0].timeout = 30;
      const edited = `${JSON.stringify(settings, null, 2)}\n`;
      await writeFile(path, edited, "utf-8");

      expect(await wired(claudeCodeAdapter, ctx)).toBe(true);
      await wire(claudeCodeAdapter.enable(ctx, "project"));
      expect(await readText(path)).toBe(edited);

      await wire(claudeCodeAdapter.disable(ctx, "project"));
      expect(existsSync(path)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("global enable writes the user settings, with hooks marked --global, and the user config's server; status shows both scopes, and disable takes exactly them out", async () => {
    const { root, ctx } = await tempProject();
    try {
      const configDir = ctx.env.CLAUDE_CONFIG_DIR ?? "";
      const userSettings = join(configDir, "settings.json");
      const userConfig = join(configDir, ".claude.json");
      const configText = `${JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "o" } } }, null, 2)}\n`;
      await mkdir(configDir, { recursive: true });
      await writeFile(userConfig, configText, "utf-8");

      const enabled = await wire(claudeCodeAdapter.enable(ctx, "global"));
      expect(enabled.actions).toContain(
        `added in ${userSettings}: autoMemoryEnabled: false, SessionStart hook "mdmem hook claude-code protocol --global", SessionStart hook "mdmem hook claude-code index --global", UserPromptSubmit hook "mdmem hook claude-code prompt --global", permissions.allow "mcp__mdmem"`
      );
      expect(JSON.parse((await readText(userSettings)) ?? "{}")).toEqual({
        autoMemoryEnabled: false,
        hooks: {
          SessionStart: ["protocol", "index"].map((part) => ({
            matcher: HOOK_MATCHER,
            hooks: [
              {
                type: "command",
                command: `mdmem hook claude-code ${part} --global`,
              },
            ],
          })),
          UserPromptSubmit: [mdmemPromptHook(" --global")],
        },
        permissions: { allow: ["mcp__mdmem"] },
      });
      expect(JSON.parse((await readText(userConfig)) ?? "{}")).toEqual({
        numStartups: 3,
        mcpServers: { other: { command: "o" }, mdmem: MDMEM_SERVER },
      });
      // no project file is touched
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);
      expect(existsSync(join(root, MCP_CONFIG))).toBe(false);

      const status = await claudeCodeAdapter.status(ctx);
      expect(
        status.scopes.map((one) => [one.scope, one.wired, one.enabled])
      ).toEqual([
        ["global", true, true],
        ["project", false, false],
      ]);
      expect(status.wired).toBe(true);
      expect(status.problems).toEqual([]);
      // the global scope alone has no project notes
      expect(status.notes).toEqual([]);

      await wire(claudeCodeAdapter.disable(ctx, "global"));
      expect(existsSync(userSettings)).toBe(false);
      expect(await readText(userConfig)).toBe(configText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without CLAUDE_CONFIG_DIR, the global scope's server goes in ~/.claude.json, and outside a project status shows the global scope alone", async () => {
    const { root, ctx } = await tempProject();
    try {
      const outside = {
        env: {},
        home: ctx.home,
        cwd: ctx.home,
      };
      await wire(claudeCodeAdapter.enable(outside, "global"));
      expect(
        JSON.parse((await readText(join(ctx.home, ".claude.json"))) ?? "{}")
      ).toEqual({ mcpServers: { mdmem: MDMEM_SERVER } });
      expect(existsSync(join(ctx.home, ".claude/settings.json"))).toBe(true);
      const status = await claudeCodeAdapter.status(outside);
      expect(status.scopes.map(({ scope }) => scope)).toEqual(["global"]);
      expect(status.wired).toBe(true);
      // disable --project outside a project changes nothing
      const project = await wire(claudeCodeAdapter.disable(outside, "project"));
      expect(project.actions).toEqual([OUTSIDE_PROJECT_LINE]);
      expect(await wired(claudeCodeAdapter, outside)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable leaves an existing store and Claude Code's memories alone: the import runs only when a store is created", async () => {
    const { root, ctx, store } = await tempProject();
    try {
      await claudeMemory(ctx, root, "b.md", memoryText("b", "From Claude."));
      const enabled = await wire(claudeCodeAdapter.enable(ctx, "project"));
      expect(enabled.actions.join("\n")).not.toContain("import");
      expect(store.exists("b.md")).toBe(false);
      expect(existsSync(importMarker(store, ctx))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disable deletes a file that held only mdmem's entries, and says the imported memories stay", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(claudeCodeAdapter.enable(ctx, "project"));
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(true);
      expect(existsSync(join(root, MCP_CONFIG))).toBe(true);

      const disabled = await wire(claudeCodeAdapter.disable(ctx, "project"));
      expect(disabled.actions).toContain(
        `deleted ${MCP_CONFIG}: it held only mdmem's entries`
      );
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);
      expect(existsSync(join(root, MCP_CONFIG))).toBe(false);
      expect(disabled.actions.at(-1)).toBe(
        "The memories imported from Claude Code stay in the store."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const BOB_SETTINGS = ".bob/settings.json";
const BOB_MCP = ".bob/mcp.json";
const BOB_HOOK_GROUP = {
  matcher: "^(startup|compact)$",
  hooks: ["protocol", "index"].map((part) => ({
    type: "command",
    command: `mdmem hook bob ${part}`,
    timeout: 10,
  })),
};
/** Bob's UserPromptSubmit group: no matcher, a 10-second timeout. */
const bobPromptGroup = (suffix = "") => ({
  hooks: [
    { type: "command", command: `mdmem hook bob prompt${suffix}`, timeout: 10 },
  ],
});

// Bob's documented hooks shape: strict at every level, so one unknown key voids the block.
const bobCommandHandler = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    timeout: z.number().positive().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
const bobHooks = z.record(
  z.string(),
  z.array(
    z
      .object({
        matcher: z.string().optional(),
        hooks: z.array(bobCommandHandler),
      })
      .strict()
  )
);

describe("bob wiring", () => {
  test("enable merges mdmem's hook group and server into existing files, valid for Bob and idempotent, and disable takes exactly them out", async () => {
    const { root, ctx } = await tempProject();
    try {
      const settings = {
        approval: { autoApprovalEnabled: true },
        hooks: {
          PostToolUse: [
            {
              matcher: "execute_command",
              hooks: [{ type: "command", command: "lint", timeout: 5 }],
            },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo prompt" }] },
          ],
        },
      };
      const mcp = { mcpServers: { other: { command: "other-server" } } };
      const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
      const mcpText = `${JSON.stringify(mcp, null, 2)}\n`;
      await mkdir(join(root, ".bob"));
      await writeFile(join(root, BOB_SETTINGS), settingsText, "utf-8");
      await writeFile(join(root, BOB_MCP), mcpText, "utf-8");

      await wire(bobAdapter.enable(ctx, "project"));
      const wiredSettings = {
        ...settings,
        hooks: {
          ...settings.hooks,
          SessionStart: [...settings.hooks.SessionStart, BOB_HOOK_GROUP],
          UserPromptSubmit: [
            ...settings.hooks.UserPromptSubmit,
            bobPromptGroup(),
          ],
        },
      };
      const wiredMcp = {
        mcpServers: {
          other: mcp.mcpServers.other,
          mdmem: { command: "mdmem", args: ["mcp"] },
        },
      };
      const written = await readText(join(root, BOB_SETTINGS));
      expect(written).toBe(`${JSON.stringify(wiredSettings, null, 2)}\n`);
      expect(
        bobHooks.safeParse(JSON.parse(written ?? "{}").hooks).success
      ).toBe(true);
      expect(await readText(join(root, BOB_MCP))).toBe(
        `${JSON.stringify(wiredMcp, null, 2)}\n`
      );
      expect(await wired(bobAdapter, ctx)).toBe(true);

      // a second run changes nothing
      const again = await wire(bobAdapter.enable(ctx, "project"));
      expect(again.actions).toContain(
        `${BOB_SETTINGS} already holds mdmem's entries`
      );
      expect(again.actions).toContain(
        `${BOB_MCP} already holds mdmem's entries`
      );
      expect(await readText(join(root, BOB_SETTINGS))).toBe(written);
      expect(await readText(join(root, BOB_MCP))).toBe(
        `${JSON.stringify(wiredMcp, null, 2)}\n`
      );

      await wire(bobAdapter.disable(ctx, "project"));
      expect(await readText(join(root, BOB_SETTINGS))).toBe(settingsText);
      expect(await readText(join(root, BOB_MCP))).toBe(mcpText);
      const after = await bobAdapter.status(ctx);
      expect(after.wired).toBe(false);
      expect(projectEntries(after).some(({ present }) => present)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disable deletes a file that held only mdmem's entries", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(bobAdapter.enable(ctx, "project"));
      const status = await bobAdapter.status(ctx);
      expect(
        projectEntries(status).map(({ file, present }) => [file, present])
      ).toEqual([
        [BOB_SETTINGS, true],
        [BOB_SETTINGS, true],
        [BOB_MCP, true],
      ]);

      const disabled = await wire(bobAdapter.disable(ctx, "project"));
      expect(disabled.actions).toContain(
        `deleted ${BOB_MCP}: it held only mdmem's entries`
      );
      expect(existsSync(join(root, BOB_SETTINGS))).toBe(false);
      expect(existsSync(join(root, BOB_MCP))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a hook group and server of mdmem's edited by hand count as wired, are kept by enable, and disable removes them", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(bobAdapter.enable(ctx, "project"));
      const settingsPath = join(root, BOB_SETTINGS);
      const mcpPath = join(root, BOB_MCP);
      const settings = JSON.parse((await readText(settingsPath)) ?? "{}");
      settings.hooks.SessionStart[0].hooks[0].disabled = true;
      settings.hooks.SessionStart[0].hooks[1].timeout = 30;
      const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
      const mcp = {
        mcpServers: { mdmem: { ...MCP_SERVER, alwaysAllow: ["memory_view"] } },
      };
      const mcpText = `${JSON.stringify(mcp, null, 2)}\n`;
      await writeFile(settingsPath, settingsText, "utf-8");
      await writeFile(mcpPath, mcpText, "utf-8");

      expect(await wired(bobAdapter, ctx)).toBe(true);
      await wire(bobAdapter.enable(ctx, "project"));
      expect(await readText(settingsPath)).toBe(settingsText);
      expect(await readText(mcpPath)).toBe(mcpText);

      await wire(bobAdapter.disable(ctx, "project"));
      expect(existsSync(settingsPath)).toBe(false);
      expect(existsSync(mcpPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a hook group missing one of mdmem's handlers is not wired, enable puts back only that handler, and disable removes the one left", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(bobAdapter.enable(ctx, "project"));
      const path = join(root, BOB_SETTINGS);
      const settings = JSON.parse((await readText(path)) ?? "{}");
      settings.hooks.SessionStart[0].hooks.shift();
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

      const status = await bobAdapter.status(ctx);
      expect(status.wired).toBe(false);
      expect(status.problems[0]).toStartWith("IBM Bob: missing SessionStart");
      await wire(bobAdapter.enable(ctx, "project"));
      const restored = JSON.parse((await readText(path)) ?? "{}");
      expect(restored.hooks.SessionStart).toEqual([BOB_HOOK_GROUP]);

      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
      await wire(bobAdapter.disable(ctx, "project"));
      expect(existsSync(path)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disable keeps the user's handler in mdmem's hook group, and the file", async () => {
    const { root, ctx } = await tempProject();
    try {
      await wire(bobAdapter.enable(ctx, "project"));
      const path = join(root, BOB_SETTINGS);
      const settings = JSON.parse((await readText(path)) ?? "{}");
      const mine = { type: "command", command: "echo mine" };
      settings.hooks.SessionStart[0].hooks.push(mine);
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

      await wire(bobAdapter.disable(ctx, "project"));
      const left = { matcher: BOB_HOOK_GROUP.matcher, hooks: [mine] };
      expect(await readText(path)).toBe(
        `${JSON.stringify({ hooks: { SessionStart: [left] } }, null, 2)}\n`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable and disable keep a CRLF .bob/settings.json in CRLF", async () => {
    const { root, ctx } = await tempProject();
    try {
      const settings = join(root, BOB_SETTINGS);
      await mkdir(dirname(settings));
      const before = '{\r\n  "theme": "dark"\r\n}\r\n';
      await writeFile(settings, before, "utf-8");

      await wire(bobAdapter.enable(ctx, "project"));
      const enabled = (await readText(settings)) ?? "";
      expect(enabled).toContain('"hooks"');
      expect(enabled.replaceAll("\r\n", "")).not.toContain("\n");

      await wire(bobAdapter.disable(ctx, "project"));
      expect(await readText(settings)).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("global enable writes Bob's user settings, with hooks marked --global, and its user MCP config, and disable takes them out", async () => {
    const { root, ctx } = await tempProject();
    try {
      const userDir = join(ctx.home, ".bob", "settings");
      await wire(bobAdapter.enable(ctx, "global"));
      const settings = JSON.parse(
        (await readText(join(userDir, "settings.json"))) ?? "{}"
      );
      expect(bobHooks.safeParse(settings.hooks).success).toBe(true);
      expect(
        settings.hooks.SessionStart[0].hooks.map(
          ({ command }: { command: string }) => command
        )
      ).toEqual([
        "mdmem hook bob protocol --global",
        "mdmem hook bob index --global",
      ]);
      expect(settings.hooks.UserPromptSubmit).toEqual([
        bobPromptGroup(" --global"),
      ]);
      expect(
        JSON.parse((await readText(join(userDir, "mcp.json"))) ?? "{}")
      ).toEqual({ mcpServers: { mdmem: MCP_SERVER } });
      expect(existsSync(join(root, ".bob"))).toBe(false);
      const status = await bobAdapter.status(ctx);
      expect(status.scopes.map((one) => [one.scope, one.wired])).toEqual([
        ["global", true],
        ["project", false],
      ]);
      expect(status.warnings).toEqual([]);

      await wire(bobAdapter.disable(ctx, "global"));
      expect(existsSync(join(userDir, "settings.json"))).toBe(false);
      expect(existsSync(join(userDir, "mcp.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const CODEX_CONFIG = ".codex/config.toml";
const CODEX_HOOK_GROUP = {
  hooks: ["protocol", "index"].map((part) => ({
    type: "command",
    command: `mdmem hook codex ${part}`,
    timeout: 10,
    additionalContextLimit: 0,
  })),
};
const CODEX_SECTION =
  '[mcp_servers.mdmem]\ncommand = "mdmem"\nargs = ["mcp"]\n';

// Codex's hooks.json shape (hook_config.rs, deny_unknown_fields): a command handler's documented fields only.
const codexHooksFile = z
  .object({
    hooks: z.record(
      z.string(),
      z.array(
        z.object({
          matcher: z.string().optional(),
          hooks: z.array(
            z
              .object({
                type: z.literal("command"),
                command: z.string().min(1),
                commandWindows: z.string().optional(),
                timeout: z.number().positive().optional(),
                async: z.boolean().optional(),
                statusMessage: z.string().optional(),
                additionalContextLimit: z.number().int().min(0).optional(),
              })
              .strict()
          ),
        })
      )
    ),
  })
  .strict();

const CODEX_HOOKS_FILE = ".codex/hooks.json";
const CODEX_GLOBAL_GROUP = {
  hooks: CODEX_HOOK_GROUP.hooks.map((handler) => ({
    ...handler,
    command: `${handler.command} --global`,
  })),
};
const CODEX_HOOKS = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] },
    ],
    SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
  },
};
const CODEX_HOOKS_TEXT = `${JSON.stringify(CODEX_HOOKS, null, 2)}\n`;
const CODEX_TOML = `# Project Codex settings
model = "gpt-5" # pinned

# servers
[mcp_servers.other]
command = "other" # keep me
args = ["a"]

[profiles.fast]
model = "mini"
`;

/** Codex's UserPromptSubmit group: no matcher, a 10-second timeout, no additionalContextLimit. */
const codexPromptGroup = (suffix = "") => ({
  hooks: [
    {
      type: "command",
      command: `mdmem hook codex prompt${suffix}`,
      timeout: 10,
    },
  ],
});

/** `CODEX_HOOKS` with `group` added to its SessionStart groups, and `promptGroup` as its UserPromptSubmit group when given, as JSON text. */
function codexHooksWith(group: unknown, promptGroup?: unknown): string {
  const hooks = {
    hooks: {
      ...CODEX_HOOKS.hooks,
      SessionStart: [...CODEX_HOOKS.hooks.SessionStart, group],
      ...(promptGroup === undefined ? {} : { UserPromptSubmit: [promptGroup] }),
    },
  };
  return `${JSON.stringify(hooks, null, 2)}\n`;
}

/**
 * A project with the given texts: `hooks` in Codex's home's hooks.json,
 * `projectHooks` and `toml` in the project's .codex/; Codex's home is `codexHome`
 * (as CODEX_HOME), else ~/.codex under the temp home.
 */
async function codexProject(
  codexHome: string | undefined,
  files: { hooks?: string; projectHooks?: string; toml?: string } = {}
): Promise<{ root: string; ctx: AdapterContext; hooksPath: string }> {
  const project = await tempProject();
  const ctx =
    codexHome === undefined
      ? project.ctx
      : { ...project.ctx, env: { ...project.ctx.env, CODEX_HOME: codexHome } };
  const home = codexHome ?? join(ctx.home, ".codex");
  const hooksPath = join(home, "hooks.json");
  if (files.hooks !== undefined) {
    await mkdir(home, { recursive: true });
    await writeFile(hooksPath, files.hooks, "utf-8");
  }
  const projectFiles = [
    [CODEX_HOOKS_FILE, files.projectHooks],
    [CODEX_CONFIG, files.toml],
  ] as const;
  if (projectFiles.some(([, text]) => text !== undefined)) {
    await mkdir(join(project.root, ".codex"));
  }
  await Promise.all(
    projectFiles.map(([file, text]) =>
      text === undefined
        ? undefined
        : writeFile(join(project.root, file), text, "utf-8")
    )
  );
  return { root: project.root, ctx, hooksPath };
}

describe("codex wiring", () => {
  test("enable --project merges the hook group into .codex/hooks.json and the server into .codex/config.toml, keeping the rest, and writes nothing in Codex's home", async () => {
    const { root, ctx, hooksPath } = await codexProject(undefined, {
      projectHooks: CODEX_HOOKS_TEXT,
      toml: CODEX_TOML,
    });
    try {
      const enabled = await wire(codexAdapter.enable(ctx, "project"));
      const hooks = await readText(join(root, CODEX_HOOKS_FILE));
      expect(hooks).toBe(codexHooksWith(CODEX_HOOK_GROUP, codexPromptGroup()));
      expect(codexHooksFile.safeParse(JSON.parse(hooks ?? "{}")).success).toBe(
        true
      );
      const toml = await readText(join(root, CODEX_CONFIG));
      expect(toml).toBe(`${CODEX_TOML}\n${CODEX_SECTION}`);
      expect(Bun.TOML.parse(toml ?? "")).toEqual({
        model: "gpt-5",
        mcp_servers: {
          other: { command: "other", args: ["a"] },
          mdmem: { command: "mdmem", args: ["mcp"] },
        },
        profiles: { fast: { model: "mini" } },
      });
      expect(existsSync(dirname(hooksPath))).toBe(false);
      expect(enabled.actions.at(-1)).toStartWith(
        `Commit ${CODEX_HOOKS_FILE} and ${CODEX_CONFIG}: they wire Codex CLI`
      );
      expect(enabled.warnings).toEqual([]);
      const status = await codexAdapter.status(ctx);
      expect(
        status.scopes.map((one) => [one.scope, one.wired, one.enabled])
      ).toEqual([
        ["global", false, false],
        ["project", true, true],
      ]);
      expect(status.problems).toEqual([]);

      // a second run changes nothing
      const again = await wire(codexAdapter.enable(ctx, "project"));
      expect(again.actions.slice(0, 2)).toEqual([
        `${CODEX_HOOKS_FILE} already holds mdmem's entries`,
        `${CODEX_CONFIG} already holds mdmem's entries`,
      ]);
      expect(await readText(join(root, CODEX_HOOKS_FILE))).toBe(hooks);
      expect(await readText(join(root, CODEX_CONFIG))).toBe(toml);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disable --project removes exactly the project's hook group and server, leaving the global scope's", async () => {
    const { root, ctx, hooksPath } = await codexProject(undefined, {
      projectHooks: CODEX_HOOKS_TEXT,
      toml: CODEX_TOML,
    });
    try {
      await wire(codexAdapter.enable(ctx, "global"));
      await wire(codexAdapter.enable(ctx, "project"));
      const globalHooks = await readText(hooksPath);

      const disabled = await wire(codexAdapter.disable(ctx, "project"));
      expect(disabled.actions).toEqual([
        `removed in ${CODEX_HOOKS_FILE}: SessionStart hooks "mdmem hook codex protocol", "mdmem hook codex index", UserPromptSubmit hook "mdmem hook codex prompt"`,
        `removed in ${CODEX_CONFIG}: [mcp_servers.mdmem]`,
      ]);
      expect(await readText(join(root, CODEX_HOOKS_FILE))).toBe(
        CODEX_HOOKS_TEXT
      );
      expect(await readText(join(root, CODEX_CONFIG))).toBe(CODEX_TOML);
      expect(await readText(hooksPath)).toBe(globalHooks);
      const status = await codexAdapter.status(ctx);
      expect(
        status.scopes.map((one) => [one.scope, one.wired, one.enabled])
      ).toEqual([
        ["global", true, true],
        ["project", false, false],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("global enable writes the --global hook group to hooks.json and the server to config.toml in Codex's home; disable deletes files that held only mdmem's entries", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const codexHome = join(shared, "home");
    const { root, ctx, hooksPath } = await codexProject(codexHome);
    const userConfig = join(codexHome, "config.toml");
    try {
      const enabled = await wire(codexAdapter.enable(ctx, "global"));
      expect(await readText(userConfig)).toBe(CODEX_SECTION);
      expect(JSON.parse((await readText(hooksPath)) ?? "{}")).toEqual({
        hooks: {
          SessionStart: [CODEX_GLOBAL_GROUP],
          UserPromptSubmit: [codexPromptGroup(" --global")],
        },
      });
      expect(existsSync(join(root, ".codex"))).toBe(false);
      expect(enabled.actions.join("\n")).not.toContain("Commit");
      expect(enabled.actions.at(-1)).toBe(
        `Codex asks you once to review the hooks in ${hooksPath} it has not reviewed yet, at its next interactive start or in /hooks; until then it runs none of them, and \`codex exec\` never asks.`
      );
      const status = await codexAdapter.status(ctx);
      expect(
        status.scopes.map((one) => [one.scope, one.wired, one.enabled])
      ).toEqual([
        ["global", true, true],
        ["project", false, false],
      ]);
      expect(status.problems).toEqual([]);

      const disabled = await wire(codexAdapter.disable(ctx, "global"));
      expect(disabled.actions).toEqual([
        `deleted ${hooksPath}: it held only mdmem's entries`,
        `deleted ${userConfig}: it held only mdmem's entries`,
      ]);
      expect(existsSync(userConfig)).toBe(false);
      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("0.2.0's unmarked group in Codex's home is warned of by status and enable --project, and global enable replaces it, saying so", async () => {
    const { root, ctx, hooksPath } = await codexProject(undefined, {
      hooks: codexHooksWith(CODEX_HOOK_GROUP),
    });
    const warning = `${hooksPath} holds mdmem 0.2.0's unmarked hook group, which injects in every project beside the project's own hook — run \`mdmem enable codex\` to replace it with the global scope's, or \`mdmem disable codex\` to remove it`;
    try {
      const before = await codexAdapter.status(ctx);
      expect(before.enabled).toBe(false);
      expect(before.warnings).toEqual([warning]);

      const project = await wire(codexAdapter.enable(ctx, "project"));
      expect(project.warnings).toEqual([warning]);
      expect(await readText(hooksPath)).toBe(codexHooksWith(CODEX_HOOK_GROUP));

      const enabled = await wire(codexAdapter.enable(ctx, "global"));
      expect(await readText(hooksPath)).toBe(
        codexHooksWith(CODEX_GLOBAL_GROUP, codexPromptGroup(" --global"))
      );
      expect(enabled.actions).toContain(
        `replaced mdmem 0.2.0's unmarked hook group in ${hooksPath} with the global scope's, marked --global.`
      );
      const after = await codexAdapter.status(ctx);
      expect(after.warnings).toEqual([]);

      // global disable takes out an unmarked group left beside the marked one
      await writeFile(
        hooksPath,
        `${JSON.stringify({ hooks: { SessionStart: [CODEX_HOOK_GROUP, CODEX_GLOBAL_GROUP] } })}\n`,
        "utf-8"
      );
      await wire(codexAdapter.disable(ctx, "global"));
      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unparseable .codex/config.toml is refused before the hook is written", async () => {
    const { root, ctx } = await codexProject(undefined, {
      toml: "model = \n",
    });
    try {
      const refused = codexAdapter.enable(ctx, "project");
      await expect(refused).rejects.toThrow(RefusalError);
      // One line, as the CLI prints a refusal: toml-patch's caret diagram is left out.
      await expect(refused).rejects.toThrow(
        `${CODEX_CONFIG} is not valid TOML (Error parsing TOML (1, 1): Expected value, reached EOF): fix it, then run the command again`
      );
      expect(existsSync(join(root, CODEX_HOOKS_FILE))).toBe(false);
      expect(await readText(join(root, CODEX_CONFIG))).toBe("model = \n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a server table and hook group of mdmem's edited by hand count as wired, are kept by enable, and disable removes them", async () => {
    const group = {
      hooks: CODEX_HOOK_GROUP.hooks.map((handler) => ({
        ...handler,
        timeout: 30,
      })),
    };
    const promptGroup = {
      hooks: codexPromptGroup().hooks.map((handler) => ({
        ...handler,
        timeout: 30,
      })),
    };
    const hooksText = `${JSON.stringify({ hooks: { SessionStart: [group], UserPromptSubmit: [promptGroup] } }, null, 2)}\n`;
    const toml = `model = "x"\n\n${CODEX_SECTION}startup_timeout_sec = 30\nenv = { FOO = "bar" }\n`;
    const { root, ctx } = await codexProject(undefined, {
      projectHooks: hooksText,
      toml,
    });
    try {
      expect(await wired(codexAdapter, ctx)).toBe(true);
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(join(root, CODEX_HOOKS_FILE))).toBe(hooksText);
      expect(await readText(join(root, CODEX_CONFIG))).toBe(toml);

      await wire(codexAdapter.disable(ctx, "project"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe('model = "x"\n');
      expect(existsSync(join(root, CODEX_HOOKS_FILE))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable refuses a [mcp_servers.mdmem] with another command, naming the file and the table, before the hook is written", async () => {
    const toml =
      '[mcp_servers.mdmem]\ncommand = "bun"\nargs = ["run", "/dev/mdmem/src/cli/index.ts", "mcp"]\n';
    const { root, ctx } = await codexProject(undefined, { toml });
    try {
      await expect(codexAdapter.enable(ctx, "project")).rejects.toThrow(
        new RefusalError(
          `${CODEX_CONFIG}: [mcp_servers.mdmem] holds a value that is not mdmem's, so mdmem will not overwrite it: remove or rename it, or set its command to "mdmem" and its args to ["mcp"], then run the command again`
        )
      );
      expect(existsSync(join(root, CODEX_HOOKS_FILE))).toBe(false);
      expect(await readText(join(root, CODEX_CONFIG))).toBe(toml);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable appends the server in a CRLF config.toml's own line ending", async () => {
    const crlf = 'model = "x"\r\n[a]\r\nb = 1\r\n';
    const { root, ctx } = await codexProject(undefined, { toml: crlf });
    try {
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe(
        `${crlf}\r\n${CODEX_SECTION.replaceAll("\n", "\r\n")}`
      );
      expect(await wired(codexAdapter, ctx)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("enable adds the server to an inline mcp_servers table in place, and disable takes it out", async () => {
    const inline = 'model = "x"\nmcp_servers = { other = { command = "o" } }\n';
    const { root, ctx } = await codexProject(undefined, { toml: inline });
    try {
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe(
        'model = "x"\nmcp_servers = { other = { command = "o" }, mdmem = { command = "mdmem", args = [ "mcp" ] } }\n'
      );
      expect(await wired(codexAdapter, ctx)).toBe(true);

      await wire(codexAdapter.disable(ctx, "project"));
      expect(
        Bun.TOML.parse((await readText(join(root, CODEX_CONFIG))) ?? "")
      ).toEqual({
        model: "x",
        mcp_servers: { other: { command: "o" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status reports the project's files it cannot read as problems, and Codex's home's hooks.json only once the global scope is enabled", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const codexHome = join(shared, "home");
    const { ctx, root, hooksPath } = await codexProject(codexHome, {
      hooks: "{ not json",
      projectHooks: "[]",
      toml: "model = \n",
    });
    const hooksUnreadable = `${hooksPath} is not valid JSON (JSON Parse error: Expected '}')`;
    try {
      const status = await codexAdapter.status(ctx);
      expect(status.enabled).toBe(false);
      // one line each, as the refusal is
      expect(status.problems).toEqual([
        `Codex CLI: ${CODEX_HOOKS_FILE} does not hold a JSON object: fix it, then run the check again`,
        `Codex CLI: ${CODEX_CONFIG} is not valid TOML (Error parsing TOML (1, 1): Expected value, reached EOF): fix it, then run the check again`,
      ]);
      // the hooks file is user-wide: with the global scope not enabled, it is only a warning
      expect(status.warnings).toEqual([
        `${hooksUnreadable}: fix it, then run the command again`,
      ]);

      await writeFile(join(codexHome, "config.toml"), CODEX_SECTION, "utf-8");
      const enabled = await codexAdapter.status(ctx);
      expect(enabled.problems).toContain(
        `Codex CLI: ${hooksUnreadable}: fix it, then run the check again`
      );
      expect(enabled.warnings).toEqual([]);
      // where CODEX_HOME cannot be known, the hooks file stays a warning
      const unknown = await codexAdapter.status({
        ...ctx,
        unknownEnv: ["CODEX_HOME"],
      });
      expect(unknown.problems.join("\n")).not.toContain(hooksPath);
      expect(unknown.warnings).toEqual([
        `${hooksUnreadable}: fix it, then run the command again`,
      ]);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });
});

/**
 * Run the CLI in `root` with `args` and `env` added to this process's environment,
 * capturing its exit code and output. Enable and disable write user-wide files by
 * default, so the home and agent directories are temp folders under `root` unless
 * `env` names others: never the real ~/.claude, ~/.claude.json, ~/.bob or ~/.codex.
 */
function runCliWith(root: string, args: string[], env: Record<string, string>) {
  // bun by its own path, so a test can replace PATH
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      CODEX_HOME: join(root, "codex-home"),
      ...env,
    },
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

/** The end-to-end test spawns about thirty CLI processes in sequence; give it room past bun's 5s default. */
const END_TO_END_TIMEOUT_MS = 30_000;

describe("cli", () => {
  test("the first add in a linked worktree creates the main checkout's home store with its project file, leaving the repository alone", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const repo = join(tmp, "repo");
      await mkdir(repo);
      await gitRepo(repo);
      await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf-8");
      const worktree = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", worktree, "-b", "wt");

      const homeStore = join(worktree, "home", ".mdmem", projectKey(repo));
      const add = runCliWith(
        worktree,
        [
          "add",
          "--type",
          "user",
          "--name",
          "a",
          "--description",
          "d",
          "--body",
          "b",
        ],
        { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
      );
      expect(add.code).toBe(0);
      expect(add.out).toBe(
        `Created the home store at ${homeStore}\nSaved a.md\n`
      );
      expect(existsSync(join(homeStore, "MEMORY.md"))).toBe(true);
      expect(existsSync(join(homeStore, "a.md"))).toBe(true);
      expect(await readFile(join(homeStore, "project"), "utf-8")).toBe(
        `${repo}\n`
      );
      expect(existsSync(join(repo, ".mdmem"))).toBe(false);
      expect(existsSync(join(worktree, ".mdmem"))).toBe(false);
      expect(await readFile(join(repo, ".gitignore"), "utf-8")).toBe(
        "node_modules/\n"
      );

      // enable wires the worktree it runs in, not the main checkout holding the store
      expect(runCli(worktree, "enable", "bob", "--project").code).toBe(0);
      expect(existsSync(join(worktree, ".bob/settings.json"))).toBe(true);
      expect(existsSync(join(repo, ".bob"))).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("without git, the first add creates the working directory's home store, with no walk-up to a store above, saying so", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const home = join(tmp, "home");
      // a local store above the working directory belongs to another project
      await mkdir(join(tmp, "proj", ".mdmem"), { recursive: true });
      const start = join(tmp, "proj", "a", "b");
      await mkdir(start, { recursive: true });
      const homeStore = join(home, ".mdmem", projectKey(start));

      const add = runCliWith(
        start,
        [
          "add",
          "--type",
          "user",
          "--name",
          "a",
          "--description",
          "d",
          "--body",
          "b",
        ],
        { HOME: home }
      );
      expect(add.err).toBe("");
      expect(add.code).toBe(0);
      expect(add.out).toBe(
        `Created the home store at ${homeStore}\nSaved a.md\n`
      );
      expect(existsSync(join(homeStore, "MEMORY.md"))).toBe(true);
      expect(existsSync(join(homeStore, "a.md"))).toBe(true);
      expect(existsSync(join(start, ".mdmem"))).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test(
    "add, status, enable run end-to-end",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mdmem-cli-"));
      try {
        // mdmem on PATH, so the check does not depend on whether this machine linked it
        const bin = join(root, "bin");
        await mkdir(bin);
        await writeFile(join(bin, "mdmem"), "#!/bin/sh\n", "utf-8");
        await chmod(join(bin, "mdmem"), 0o755);
        const run = (...args: string[]) => {
          const proc = Bun.spawnSync(["bun", CLI, ...args], {
            cwd: root,
            // no-op editor, and a Claude Code config directory that is not the real ~/.claude
            env: {
              ...process.env,
              EDITOR: "true",
              VISUAL: "true",
              HOME: join(root, "home"),
              CLAUDE_CONFIG_DIR: join(root, "claude-config"),
              CODEX_HOME: join(root, "codex-home"),
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "",
            },
          });
          return {
            code: proc.exitCode,
            out: proc.stdout.toString(),
            err: proc.stderr.toString(),
          };
        };

        // outside git, the first add creates the working directory's home store
        const storeDir = join(
          root,
          "home",
          ".mdmem",
          projectKey(await realpath(root))
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
        expect(existsSync(join(storeDir, "MEMORY.md"))).toBe(true);
        expect(existsSync(join(storeDir, "uses-bun.md"))).toBe(true);

        const read = run("read", "uses-bun");
        expect(read.code).toBe(0);
        expect(read.out).toContain("Use bun.");

        const readIndex = run("read", "MEMORY.md");
        expect(readIndex.code).toBe(0);
        expect(readIndex.out).toContain("[uses-bun](uses-bun.md)");

        const status = run("status");
        expect(status.code).toBe(0);
        expect(status.out).toStartWith(
          `Store: home, ${storeDir}\nMemories: 1\nCheck: ✓ no problems\n`
        );

        const claude = run("enable", "claude-code", "--project");
        expect(claude.code).toBe(0);
        const settings: unknown = JSON.parse(
          await readFile(join(root, CLAUDE_SETTINGS), "utf-8")
        );
        expect(settings).toMatchObject({ autoMemoryEnabled: false });
        const enabled = run("status");
        expect(enabled.out).toContain("✓ Claude Code (project)\n");
        expect(enabled.out).toContain(
          "      Claude Code runs the project's hooks only in a folder whose trust dialog you accepted"
        );
        expect(enabled.err).toBe("");

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
        expect(doctor.out).toBe(
          `Store: home, ${storeDir}\n✓ 1 memory, no problems\n`
        );
        const check = run("check");
        expect(check.code).toBe(0);
        expect(check.out).toBe(doctor.out);

        const storePath = run("path");
        expect(storePath.code).toBe(0);
        expect(storePath.out).toBe(`${storeDir}\n`);

        const del = run("delete", "uses-bun");
        expect(del.code).toBe(0);
        expect(existsSync(join(storeDir, "uses-bun.md"))).toBe(false);

        // every argument is a word of the query, quoted or not
        run(
          "add",
          "--type",
          "project",
          "--name",
          "deploys-site",
          "--description",
          "We deploy the site",
          "--body",
          "Deploy on push."
        );
        run(
          "add",
          "--type",
          "project",
          "--name",
          "rests-friday",
          "--description",
          "On friday we rest",
          "--body",
          "No deploy on friday."
        );
        const words = run("search", "deploy", "friday");
        expect(words.code).toBe(0);
        expect(words.out).toBe(run("search", "deploy friday").out);
        expect(words.out.split("\n").filter(Boolean)).toHaveLength(2);
        expect(run("search", "friday").out).toBe(
          "rests-friday.md — On friday we rest\n"
        );
        run("delete", "deploys-site");
        run("delete", "rests-friday");

        // a search skips a broken memory and warns of it on stderr
        await writeFile(join(storeDir, "broken.md"), "no frontmatter\n");
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
        expect(existsSync(join(storeDir, "keep.md"))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS
  );

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

  test("delete refuses a nested file under .mdmem/, leaving it in place", async () => {
    await withCliProject(async (root) => {
      await mkdir(join(root, ".mdmem/notes"));
      await writeFile(join(root, ".mdmem/notes/draft.md"), "hi\n");
      const index = await readFile(join(root, ".mdmem/MEMORY.md"), "utf-8");
      const del = runCli(root, "delete", "notes/draft");
      expect(del.code).toBe(1);
      expect(del.out).toBe("");
      expect(del.err).toBe(
        'mdmem: Refused "notes/draft.md": memories live at the top of the store, and nested files are never indexed or searched; use a path with no directory\n'
      );
      expect(existsSync(join(root, ".mdmem/notes/draft.md"))).toBe(true);
      expect(await readFile(join(root, ".mdmem/MEMORY.md"), "utf-8")).toBe(
        index
      );
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
      expect(consolidate.out).toContain(
        "2. **Past sessions** — if you can search your own past sessions and need specific\n   context ("
      );
    });
  });

  test("consolidate --agent claude-code names the project's directory of Claude Code sessions", async () => {
    await withCliProject((root) => {
      const args = ["consolidate", "--agent", "claude-code"];
      const key = root.replaceAll(/[^A-Za-z0-9]/gu, "-");
      const fromEnv = runCliWith(root, args, {
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        CLAUDE_CODE_PROJECT_DIR_NAME: "",
      });
      expect(fromEnv.code).toBe(0);
      expect(fromEnv.out).toContain(
        `2. **Past sessions** — your past sessions are in \`${join(root, "claude-config", "projects", key)}/\`: grep the \`.jsonl\` files there, one per session of this project; when you need specific\n`
      );
      expect(fromEnv.out).not.toContain("if you can search");
      const fromHome = runCliWith(root, args, {
        CLAUDE_CONFIG_DIR: "",
        CLAUDE_CODE_PROJECT_DIR_NAME: "",
      });
      expect(fromHome.out).toContain(
        `\`${join(root, "home", ".claude", "projects", key)}/\``
      );
    });
  });

  test("consolidate --agent codex names Codex's sessions directory and how to keep the project's", async () => {
    await withCliProject((root) => {
      const args = ["consolidate", "--agent", "codex"];
      const fromEnv = runCli(root, ...args);
      expect(fromEnv.code).toBe(0);
      expect(fromEnv.out).toContain(
        `2. **Past sessions** — your past sessions are in \`${join(root, "codex-home", "sessions")}/\`: the \`YYYY/MM/DD/*.jsonl\` files there hold every project's sessions, so grep only those whose first line, a \`session_meta\` record, has a \`cwd\` of \`${root}\` or a folder under it; when you need specific\n`
      );
      const fromHome = runCliWith(root, args, { CODEX_HOME: "" });
      expect(fromHome.out).toContain(
        `\`${join(root, "home", ".codex", "sessions")}/\``
      );
    });
  });

  test("consolidate --agent bob keeps the generic line, and an unknown agent is refused", async () => {
    await withCliProject((root) => {
      const bob = runCli(root, "consolidate", "--agent", "bob");
      expect(bob.code).toBe(0);
      expect(bob.out).toBe(runCli(root, "consolidate").out);
      const nope = runCli(root, "consolidate", "--agent", "nope");
      expect(nope.code).toBe(1);
      expect(nope.out).toBe("");
      expect(nope.err).toBe(
        'mdmem: unknown agent "nope". Known: claude-code, bob, codex\n'
      );
    });
  });

  test("--version, -v, -V and version print mdmem and package.json's version", async () => {
    await withCliProject((root) => {
      for (const flag of ["--version", "-v", "-V", "version"]) {
        const version = runCli(root, flag);
        expect(version.code).toBe(0);
        expect(version.out).toBe(`mdmem ${packageJson.version}\n`);
        expect(version.err).toBe("");
      }
    });
  });

  test("mdmem, -h, --help and help print one page under 35 lines: three groups, one line per command, the glossary's words", async () => {
    await withCliProject((root) => {
      const page = runCli(root);
      expect(page.code).toBe(0);
      for (const args of [["-h"], ["--help"], ["help"]]) {
        expect(runCli(root, ...args).out).toBe(page.out);
      }
      const lines = page.out.trimEnd().split("\n");
      expect(lines.length).toBeLessThan(35);
      for (const heading of [
        "Set up and look after a project:",
        "Work with memories:",
        "Run by the agents, never typed:",
        "Options:",
      ]) {
        expect(lines).toContain(heading);
      }
      const commands = [
        "enable",
        "disable",
        "status",
        "store",
        "doctor",
        "consolidate",
        "add",
        "read",
        "edit",
        "delete",
        "list",
        "search",
        "reindex",
        "path",
        "hook",
        "mcp",
      ];
      for (const command of commands) {
        expect(
          lines.filter((line) => line.startsWith(`  ${command} `))
        ).toHaveLength(1);
      }
      expect(lines.some((line) => line.startsWith("  -v, --version "))).toBe(
        true
      );
      expect(lines.at(-1)).toBe(
        "Use mdmem <command> --help for a command's arguments and flags."
      );
      for (const avoided of ["project files", "MEMORY.md", "lint", "validat"]) {
        expect(page.out).not.toContain(avoided);
      }
    });
  });

  test("help add, add --help and add -h print one page with an example and its refusals", async () => {
    await withCliProject((root, store) => {
      const page = runCli(root, "help", "add");
      expect(page.code).toBe(0);
      expect(page.err).toBe("");
      expect(runCli(root, "add", "--help").out).toBe(page.out);
      expect(runCli(root, "add", "--name", "x", "-h").out).toBe(page.out);
      expect(page.out).toStartWith("Usage: mdmem add ");
      expect(page.out).toContain("Example:\n  mdmem add ");
      expect(page.out).toContain(
        "Refuses when:\n  --type is missing or not a memory type\n"
      );
      expect(page.out).toContain("user, feedback, project, reference");
      // the page is all it did: no memory was saved
      expect(existsSync(join(store.root, "x.md"))).toBe(false);
    });
  });

  test("every command and alias has a page with an example and a Refuses when: block", async () => {
    await withCliProject((root) => {
      for (const command of [
        "enable",
        "disable",
        "status",
        "store",
        "doctor",
        "check",
        "consolidate",
        "add",
        "read",
        "edit",
        "delete",
        "rm",
        "list",
        "search",
        "reindex",
        "path",
        "hook",
        "mcp",
        "version",
      ]) {
        const page = runCli(root, command, "--help");
        expect(page.code).toBe(0);
        expect(page.out).toStartWith("Usage: mdmem ");
        expect(page.out).toContain("\nExample:\n");
        expect(page.out).toContain("\nRefuses when:\n");
      }
      expect(runCli(root, "rm", "-h").out).toBe(
        runCli(root, "delete", "-h").out
      );
      expect(runCli(root, "check", "-h").out).toBe(
        runCli(root, "doctor", "-h").out
      );
    });
  });

  test("search -- -h searches for -h, and -v -h prints version's page", async () => {
    await withCliProject((root) => {
      const search = runCli(root, "search", "--", "-h");
      expect(search.code).toBe(0);
      expect(search.out).toBe('No memories matching "-h".\n');
      expect(runCli(root, "-v", "-h").out).toBe(
        runCli(root, "help", "version").out
      );
    });
  });

  test("enable -h exits 0 and names both scopes and the agents", async () => {
    await withCliProject((root) => {
      const page = runCli(root, "enable", "-h");
      expect(page.code).toBe(0);
      expect(page.out).toContain("\n  global ");
      expect(page.out).toContain("\n  project ");
      expect(page.out).toContain("Agents:\n  claude-code, bob, codex\n");
    });
  });

  test("hook's help, README, the reference, ADR 0004 and the changelog name the per-prompt part enable wires", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "mdmem-help-")));
    try {
      const page = runCli(root, "hook", "--help");
      expect(page.out).toContain("  <part>   protocol, index, prompt\n");
      expect(runCli(root, "enable", "--help").out).toContain("per-prompt");
      const repo = join(import.meta.dir, "..");
      for (const doc of [
        "README.md",
        "docs/reference.md",
        "docs/adr/0004-two-wiring-scopes-store-on-first-save.md",
        "CHANGELOG.md",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- a few files
        const text = (await readText(join(repo, doc))) ?? "";
        expect(text).toContain("per-prompt hook");
      }
      expect((await readText(join(repo, "CHANGELOG.md"))) ?? "").toContain(
        "`mdmem enable` wires the per-prompt hook"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown command, and help of one, exit 1 with a line naming it, the usage line and the footer", async () => {
    await withCliProject((root) => {
      for (const args of [["nope"], ["help", "nope"]]) {
        const unknown = runCli(root, ...args);
        expect(unknown.code).toBe(1);
        expect(unknown.out).toBe("");
        expect(unknown.err).toBe(
          'mdmem: unknown command "nope"\nUsage: mdmem <command> [options]\nUse mdmem <command> --help for a command\'s arguments and flags.\n'
        );
      }
    });
  });

  test("enable --all wires only the agents found on this machine, and naming an agent wires it anyway", async () => {
    await withCliProject(async (root) => {
      // bob is on PATH (with git, which the CLI runs), ~/.codex exists, Claude Code is nowhere
      const bin = join(root, "bin");
      await mkdir(bin);
      const gitPath = Bun.which("git");
      if (gitPath === null) {
        throw new Error("this test needs git on PATH");
      }
      await symlink(gitPath, join(bin, "git"));
      await writeFile(join(bin, "bob"), "#!/bin/sh\n", "utf-8");
      await chmod(join(bin, "bob"), 0o755);
      const home = join(root, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const env = {
        PATH: bin,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        // empty, so Codex's home is ~/.codex
        CODEX_HOME: "",
      };

      const all = runCliWith(root, ["enable", "--all", "--project"], env);
      expect(all.code).toBe(0);
      expect(all.out).toStartWith(
        "Skipped, not found on this machine (no command on PATH, no config directory): claude-code. Name an agent to enable it anyway, as in `mdmem enable claude-code`.\nIBM Bob:\n"
      );
      expect(all.out).toContain("\nCodex CLI:\n");
      expect(existsSync(join(root, ".bob/settings.json"))).toBe(true);
      expect(existsSync(join(root, ".codex/config.toml"))).toBe(true);
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);

      const named = runCliWith(
        root,
        ["enable", "claude-code", "--project"],
        env
      );
      expect(named.code).toBe(0);
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(true);

      // disable --all likewise leaves the wiring of an agent not found
      const off = runCliWith(root, ["disable", "--all", "--project"], env);
      expect(off.code).toBe(0);
      expect(existsSync(join(root, ".bob/settings.json"))).toBe(false);
      expect(existsSync(join(root, ".codex/config.toml"))).toBe(false);
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(true);
    });
  });

  test("enable --all finds Claude Code and Codex by the config directories CLAUDE_CONFIG_DIR and CODEX_HOME name", async () => {
    await withCliProject(async (root) => {
      // neither on PATH, no ~/.claude or ~/.codex: only the directories the environment names exist
      const bin = join(root, "bin");
      await mkdir(bin);
      const gitPath = Bun.which("git");
      if (gitPath === null) {
        throw new Error("this test needs git on PATH");
      }
      await symlink(gitPath, join(bin, "git"));
      await mkdir(join(root, "claude-config"));
      await mkdir(join(root, "codex-home"));
      const env = {
        PATH: bin,
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        CODEX_HOME: join(root, "codex-home"),
      };

      const all = runCliWith(root, ["enable", "--all", "--project"], env);
      expect(all.code).toBe(0);
      expect(all.out).toStartWith(
        "Skipped, not found on this machine (no command on PATH, no config directory): bob. Name an agent to enable it anyway, as in `mdmem enable bob`.\nClaude Code:\n"
      );
      expect(all.out).toContain("\nCodex CLI:\n");
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(true);
      expect(existsSync(join(root, ".codex/config.toml"))).toBe(true);
      expect(existsSync(join(root, ".codex/hooks.json"))).toBe(true);
      expect(existsSync(join(root, "codex-home/hooks.json"))).toBe(false);
      expect(existsSync(join(root, ".bob"))).toBe(false);
    });
  });

  test("enable --all with no agent found says so once and wires nothing", async () => {
    await withCliProject(async (root) => {
      const bin = join(root, "bin");
      await mkdir(bin);
      const gitPath = Bun.which("git");
      if (gitPath === null) {
        throw new Error("this test needs git on PATH");
      }
      await symlink(gitPath, join(bin, "git"));
      const env = {
        PATH: bin,
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      };

      const all = runCliWith(root, ["enable", "--all"], env);
      expect(all.code).toBe(0);
      expect(all.out).toBe(
        "No supported agent found on this machine (no command on PATH, no config directory). Name an agent to enable it anyway, as in `mdmem enable claude-code`.\n"
      );
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);
      expect(existsSync(join(root, ".bob"))).toBe(false);
      expect(existsSync(join(root, ".codex"))).toBe(false);
    });
  });

  test("enable --all refuses agent names given with it", async () => {
    await withCliProject((root) => {
      const enable = runCli(root, "enable", "--all", "cursor");
      expect(enable.code).toBe(1);
      expect(enable.err).toBe("mdmem: give agent names or --all, not both\n");
    });
  });

  test("`enable agents` and `enable cursor` fail as unknown agents", async () => {
    await withCliProject((root) => {
      for (const id of ["agents", "cursor"]) {
        const enable = runCli(root, "enable", id);
        expect(enable.code).toBe(1);
        expect(enable.err).toBe(
          `mdmem: unknown agent "${id}". Known: claude-code, bob, codex\n`
        );
      }
    });
  });

  test("--global and --prefer, gone since the scopes, are refused with what replaced them", async () => {
    await withCliProject((root) => {
      const disable = runCli(root, "disable", "codex", "--global");
      expect(disable.code).toBe(1);
      expect(disable.err).toBe(
        "mdmem: --global is gone: `mdmem disable` acts on the agents' user-wide files by default, and on the repository's with --project\n"
      );
      const enable = runCli(root, "enable", "claude-code", "--prefer", "mdmem");
      expect(enable.code).toBe(1);
      expect(enable.err).toBe(
        "mdmem: --prefer is gone: Claude Code's memories are imported when a store is created, so they meet nothing to conflict with\n"
      );
    });
  });

  test("init, gone since the first write creates the store, is refused with what replaced it", async () => {
    await withCliProject((root) => {
      const init = runCli(root, "init");
      expect(init.code).toBe(1);
      expect(init.err).toBe(
        "mdmem: init is gone: the first memory write (memory_write, `mdmem add`) creates the store, and `mdmem status` shows where\n"
      );
      expect(init.out).toBe("");
    });
  });

  test("disable needs no store: it unwires every agent in a repository that never had one", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      await gitRepo(root);
      const env = {
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      };
      const agents = ["claude-code", "bob", "codex"];
      expect(
        runCliWith(root, ["enable", ...agents, "--project"], env).code
      ).toBe(0);
      // enable --project creates no store, in either placement
      expect(existsSync(join(root, ".mdmem"))).toBe(false);
      expect(existsSync(join(root, "home", ".mdmem"))).toBe(false);

      const disable = runCliWith(
        root,
        ["disable", ...agents, "--project"],
        env
      );
      expect(disable.err).toBe("");
      expect(disable.code).toBe(0);
      for (const file of [
        CLAUDE_SETTINGS,
        MCP_CONFIG,
        ".bob/settings.json",
        ".bob/mcp.json",
        CODEX_CONFIG,
      ]) {
        expect(existsSync(join(root, file))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disable codex outside git removes the global wiring only, and --project there reads only the working directory's files", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const env = {
        HOME: join(tmp, "home"),
        CODEX_HOME: join(tmp, "codex-home"),
      };
      const project = join(tmp, "project");
      await mkdir(project);
      expect(
        runCliWith(
          project,
          [
            "add",
            "--type",
            "user",
            "--name",
            "a",
            "--description",
            "d",
            "--body",
            "b",
          ],
          env
        ).code
      ).toBe(0);
      expect(
        runCliWith(project, ["enable", "codex", "--project"], env).code
      ).toBe(0);
      expect(runCliWith(project, ["enable", "codex"], env).code).toBe(0);
      const hooksPath = join(tmp, "codex-home", "hooks.json");
      const userConfig = join(tmp, "codex-home", "config.toml");
      expect(existsSync(hooksPath)).toBe(true);

      // no repository and no store: the global scope leaves the directory's own .codex/config.toml alone
      const outside = join(tmp, "outside");
      await mkdir(join(outside, ".codex"), { recursive: true });
      const toml = '[mcp_servers.mdmem]\ncommand = "mdmem"\nargs = ["mcp"]\n';
      await writeFile(join(outside, CODEX_CONFIG), toml, "utf-8");
      const disable = runCliWith(outside, ["disable", "codex"], env);
      expect(disable.err).toBe("");
      expect(disable.code).toBe(0);
      expect(disable.out).toBe(
        [
          "Codex CLI:",
          `  deleted ${hooksPath}: it held only mdmem's entries`,
          `  deleted ${userConfig}: it held only mdmem's entries`,
          "",
        ].join("\n")
      );
      expect(existsSync(hooksPath)).toBe(false);
      expect(await readText(join(outside, CODEX_CONFIG))).toBe(toml);
      expect(existsSync(join(project, CODEX_CONFIG))).toBe(true);
      expect(existsSync(join(project, CODEX_HOOKS_FILE))).toBe(true);

      const bob = runCliWith(outside, ["disable", "bob", "--project"], env);
      expect(bob.code).toBe(0);
      expect(bob.out).toBe(
        "IBM Bob:\n  .bob/settings.json holds none of mdmem's entries\n  .bob/mcp.json holds none of mdmem's entries\n"
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("enable refuses an mcpServers.mdmem that runs mdmem another way, writing nothing, and disable leaves it", async () => {
    await withCliProject(async (root) => {
      const env = {
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      };
      const mcp = {
        mcpServers: {
          mdmem: {
            type: "stdio",
            command: "bun",
            args: ["run", "/dev/mdmem/src/cli/index.ts", "mcp"],
          },
        },
      };
      const mcpText = `${JSON.stringify(mcp, null, 2)}\n`;
      await writeFile(join(root, MCP_CONFIG), mcpText, "utf-8");

      const enable = runCliWith(
        root,
        ["enable", "claude-code", "--project"],
        env
      );
      expect(enable.code).toBe(1);
      expect(enable.err).toBe(
        `mdmem: ${MCP_CONFIG}: mcpServers.mdmem holds a value that is not mdmem's, so mdmem will not overwrite it: remove or rename it, or set its command to "mdmem" and its args to ["mcp"], then run the command again\n`
      );
      expect(await readText(join(root, MCP_CONFIG))).toBe(mcpText);
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);

      const disable = runCliWith(
        root,
        ["disable", "claude-code", "--project"],
        env
      );
      expect(disable.code).toBe(0);
      expect(await readText(join(root, MCP_CONFIG))).toBe(mcpText);
    });
  });

  test("enable checks every agent name and plans every agent before writing any", async () => {
    await withCliProject(async (root, store) => {
      const home = join(root, "home");
      const env = {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        CODEX_HOME: join(root, "codex-home"),
      };
      // every agent's config directory exists, so --all finds all three whatever is on PATH
      await Promise.all(
        [join(home, ".bob"), env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].map((dir) =>
          mkdir(dir, { recursive: true })
        )
      );

      const unknown = runCliWith(
        root,
        ["enable", "bob", "cursor", "--project"],
        env
      );
      expect(unknown.code).toBe(1);
      expect(unknown.err).toBe(
        'mdmem: unknown agent "cursor". Known: claude-code, bob, codex\n'
      );
      expect(existsSync(join(root, ".bob"))).toBe(false);

      // a Claude memory the import would copy, and a broken config.toml Codex's plan refuses
      const ctx = { project: { root, store }, env, home, cwd: root };
      await claudeMemory(ctx, root, "note.md", memoryText("note", "Body."));
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, CODEX_CONFIG), "{\n", "utf-8");
      const all = runCliWith(root, ["enable", "--all", "--project"], env);
      expect(all.code).toBe(1);
      expect(all.err).toStartWith(`mdmem: ${CODEX_CONFIG} is not valid TOML (`);
      expect(existsSync(join(root, CLAUDE_SETTINGS))).toBe(false);
      expect(existsSync(join(root, MCP_CONFIG))).toBe(false);
      expect(existsSync(join(root, ".bob"))).toBe(false);
      expect(await readdir(join(home, ".bob"))).toEqual([]);
      expect(await readdir(env.CODEX_HOME)).toEqual([]);
      expect(store.exists("note.md")).toBe(false);
      expect(existsSync(importMarker(store, ctx))).toBe(false);
    });
  });

  test("an agent named twice is wired once", async () => {
    await withCliProject((root) => {
      const env = {
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        CODEX_HOME: join(root, "codex-home"),
      };
      const twice = runCliWith(
        root,
        ["enable", "claude-code", "claude-code", "--project"],
        env
      );
      expect(twice.err).toBe("");
      expect(twice.code).toBe(0);
      expect(twice.out.split("Claude Code:").length).toBe(2);
      expect(twice.out.split("added in .mcp.json").length).toBe(2);

      expect(runCliWith(root, ["enable", "codex"], env).code).toBe(0);
      const disable = runCliWith(root, ["disable", "codex", "codex"], env);
      expect(disable.err).toBe("");
      expect(disable.code).toBe(0);
      expect(disable.out.split("Codex CLI:").length).toBe(2);
      expect(existsSync(join(root, "codex-home", "hooks.json"))).toBe(false);
      expect(existsSync(join(root, "codex-home", "config.toml"))).toBe(false);
    });
  });

  test("enable refuses in a bare repository and in the folder holding one, naming the worktrees", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-cli-")));
    try {
      const source = join(tmp, "source");
      await mkdir(source);
      await gitRepo(source);
      const bare = join(tmp, "x.git");
      git(tmp, "clone", "-q", "--bare", source, bare);
      const container = join(tmp, "c");
      await mkdir(container);
      git(tmp, "clone", "-q", "--bare", source, join(container, ".git"));
      const worktree = join(container, "wt");
      git(container, "worktree", "add", "-q", worktree, "-b", "wt");

      const inBare = runCli(bare, "enable", "bob", "--project");
      expect(inBare.code).toBe(1);
      expect(inBare.err).toBe(
        `mdmem: ${bare} is not in a work tree (a bare repository, or the folder holding one), and agents read their files only from a work tree: add a worktree with \`git worktree add <path>\` and run it there\n`
      );
      const inContainer = runCli(container, "enable", "bob", "--project");
      expect(inContainer.code).toBe(1);
      expect(inContainer.err).toBe(
        `mdmem: ${container} is not in a work tree (a bare repository, or the folder holding one), and agents read their files only from a work tree: run it in one of the repository's worktrees (\`git worktree list\`): ${worktree}\n`
      );
      expect(existsSync(join(bare, ".bob"))).toBe(false);
      expect(existsSync(join(container, ".bob"))).toBe(false);

      // disable still runs there, and the global scope needs no work tree
      const disable = runCli(container, "disable", "bob", "--project");
      expect(disable.err).toBe("");
      expect(disable.code).toBe(0);
      const global = runCli(container, "enable", "bob");
      expect(global.err).toBe("");
      expect(global.code).toBe(0);
      expect(
        existsSync(join(container, "home/.bob/settings/settings.json"))
      ).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

/** Run `mdmem hook <agent> <part> [flags…]` in `cwd` with `payload` on stdin and `env` over the environment, capturing its exit code and output. */
function runHookCli(
  cwd: string,
  part: string,
  payload: unknown,
  agent = "claude-code",
  env: Record<string, string> = {},
  flags: string[] = []
) {
  const proc = Bun.spawnSync(["bun", CLI, "hook", agent, part, ...flags], {
    cwd,
    // agent directories that are not the real ones, which a hook reads to decide whether it speaks
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(cwd, "claude-config"),
      CODEX_HOME: join(cwd, "codex-home"),
      // never the real ~/.cache, where a payload with a session_id has the index part write session state
      XDG_CACHE_HOME: join(cwd, "cache"),
      ...env,
    },
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

/** What `mdmem hook <agent> protocol --global` prints when `file` holds the project's own entry. */
function deferred(file: string) {
  return {
    code: 0,
    out: "",
    err: `mdmem hook printed nothing: this --global entry stays silent because ${file} holds the project's own mdmem hook for the protocol part, which injects it instead.\n`,
  };
}

/** Record in the Claude Code user config in `configDir` whether the trust dialog of `folder` was accepted, as Claude Code does. */
async function recordTrust(
  configDir: string,
  folder: string,
  accepted = true
): Promise<void> {
  const file = join(configDir, ".claude.json");
  const config = (
    existsSync(file) ? JSON.parse(await readFile(file, "utf-8")) : {}
  ) as { projects?: Record<string, unknown> };
  config.projects = {
    ...config.projects,
    [folder]: { hasTrustDialogAccepted: accepted },
  };
  await writeFile(file, JSON.stringify(config), "utf-8");
}

/** The header mdmem writes at the top of MEMORY.md when it creates the store of the project at `root`. */
function storeHeader(root: string): string {
  return [
    `<!-- mdmem: this directory is the shared agent memory of the project at ${root}.`,
    "Read this index, then the memory files you need. Save with `mdmem add` or the",
    "mdmem MCP tool memory_write; after editing a file by hand run `mdmem reindex`.",
    "`mdmem status` shows whether your agent is wired, `mdmem --help` the rest. -->",
    "",
  ].join("\n");
}

/** A SessionStart payload for a new session in `cwd`. */
function startPayload(cwd: string) {
  return { cwd, hook_event_name: "SessionStart", source: "startup" };
}

/** A SessionStart payload in `cwd` from `source`, with `fields` such as session_id and agent_id. */
function sessionPayload(
  cwd: string,
  source: string,
  fields: Record<string, string>
) {
  return { ...startPayload(cwd), source, ...fields };
}

/** The session state the index part wrote to `file`. */
async function readState(file: string): Promise<SessionState> {
  return JSON.parse(await readFile(file, "utf-8")) as SessionState;
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
      expect(injected(hook.out)).toBe(getMemoryProtocol(join(root, ".mdmem")));
    });
  });

  test("the index part names the store's absolute path, then holds the index", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 2);
      const storeDir = join(await realpath(root), ".mdmem");
      const index = await readFile(join(storeDir, "MEMORY.md"), "utf-8");

      const hook = runHookCli(root, "index", startPayload(root));
      expect(hook.code).toBe(0);
      expect(injected(hook.out)).toBe(
        `Store: local, ${storeDir}\n\nMEMORY.md:\n${index.trimEnd()}`
      );
    });
  });

  test("it speaks outside git without a store, naming the home store, and prints nothing on resume or fork, or for another event, saying why on stderr", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const bare = join(tmp, "project");
      await mkdir(bare);
      const env = { HOME: join(tmp, "home") };
      const dir = join(tmp, "home", ".mdmem", projectKey(bare));
      const protocol = runHookCli(
        bare,
        "protocol",
        startPayload(bare),
        "claude-code",
        env
      );
      expect(injected(protocol.out)).toBe(getMemoryProtocol(dir));
      const index = runHookCli(
        bare,
        "index",
        startPayload(bare),
        "claude-code",
        env
      );
      expect(injected(index.out)).toBe(
        `Store: none yet; the first memory_write creates the home store ${dir}/ with MEMORY.md.`
      );
      await withCliProject((root) => {
        const history =
          "and its history already holds what its start injected; start a new session to inject the memory again.";
        for (const [payload, why] of [
          [
            { ...startPayload(root), source: "resume" },
            () => `the session is resumed, ${history}`,
          ],
          [
            { ...startPayload(root), source: "fork" },
            () => `the session is forked, ${history}`,
          ],
          [
            { cwd: root, hook_event_name: "UserPromptSubmit" },
            (part: string) =>
              `the event is UserPromptSubmit; the ${part} part injects only on SessionStart.`,
          ],
          [
            { cwd: root },
            (part: string) =>
              `the payload names no hook_event_name; the ${part} part injects only on SessionStart.`,
          ],
        ] as const) {
          for (const part of SESSION_START_PARTS) {
            expect(runHookCli(root, part, payload)).toEqual({
              code: 0,
              out: "",
              err: `mdmem hook printed nothing: ${why(part)}\n`,
            });
          }
        }
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("with no payload it prints nothing, and stderr shows the piped command that injects here", async () => {
    await withCliProject((root) => {
      const payload = JSON.stringify(startPayload(root));
      for (const flags of [[], ["--global"]]) {
        const command = ["mdmem hook bob index", ...flags].join(" ");
        expect(runHookCli(root, "index", "", "bob", {}, flags)).toEqual({
          code: 0,
          out: "",
          err: `mdmem hook printed nothing: no hook payload on stdin. An agent's session-start hook runs this command with a JSON payload; to see what it would inject here, run: echo '${payload}' | ${command}\n`,
        });
      }
      expect(runHookCli(root, "bar", "", "foo")).toEqual({
        code: 0,
        out: "",
        err: 'mdmem hook printed nothing: no hook payload on stdin, and unknown agent "foo" for mdmem hook (expected claude-code, bob, codex).\n',
      });
    });
  });

  test("a session started by clear or compact gets both parts, as one started by startup does", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const storeDir = join(root, ".mdmem");
      const index = await readFile(join(storeDir, "MEMORY.md"), "utf-8");
      for (const source of ["clear", "compact"]) {
        const payload = { ...startPayload(root), source };
        expect(injected(runHookCli(root, "protocol", payload).out)).toBe(
          getMemoryProtocol(join(root, ".mdmem"))
        );
        expect(injected(runHookCli(root, "index", payload).out)).toBe(
          `Store: local, ${storeDir}\n\nMEMORY.md:\n${index.trimEnd()}`
        );
      }
    });
  });

  test("Bob's and Codex's hooks inject both parts through the CLI, and nothing in a forked Codex session", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const storeDir = join(root, ".mdmem");
      const index = await readFile(join(storeDir, "MEMORY.md"), "utf-8");
      for (const agent of ["bob", "codex"]) {
        const payload = startPayload(root);
        const protocol = runHookCli(root, "protocol", payload, agent);
        expect(protocol.code).toBe(0);
        expect(injected(protocol.out)).toBe(
          getMemoryProtocol(join(root, ".mdmem"))
        );
        const hook = runHookCli(root, "index", payload, agent);
        expect(hook.code).toBe(0);
        expect(injected(hook.out)).toBe(
          `Store: local, ${storeDir}\n\nMEMORY.md:\n${index.trimEnd()}`
        );
      }
      // a forked Codex session gets neither part
      const fork = { ...startPayload(root), source: "fork" };
      for (const part of SESSION_START_PARTS) {
        expect(runHookCli(root, part, fork, "codex")).toEqual({
          code: 0,
          out: "",
          err: "mdmem hook printed nothing: the session is forked, and its history already holds what its start injected; start a new session to inject the memory again.\n",
        });
      }
    });
  });

  test("a payload that does not parse is reported outside git too, and prints nothing for a --global entry beside the project's own", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const bare = join(tmp, "project");
      await mkdir(bare);
      const hook = runHookCli(bare, "index", "[]", "claude-code", {
        HOME: join(tmp, "home"),
      });
      expect(hook.code).toBe(0);
      expect(injected(hook.out)).toBe(
        "mdmem could not load the memory: the hook payload is not a JSON object"
      );
      await withCliProject(async (root) => {
        await mkdir(join(root, ".codex"));
        await writeFile(
          join(root, CODEX_HOOKS_FILE),
          JSON.stringify({ hooks: { SessionStart: [CODEX_HOOK_GROUP] } }),
          "utf-8"
        );
        expect(
          runHookCli(root, "index", "[]", "codex", {}, ["--global"])
        ).toEqual({
          code: 0,
          out: "",
          err: `mdmem hook printed nothing: this --global entry stays silent because ${join(root, CODEX_HOOKS_FILE)} holds the project's own mdmem hook for the index part, which injects it instead.\n`,
        });
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("Codex's global hook speaks where no .codex/hooks.json Codex reads holds the project's entry, and in a linked worktree defers to the main checkout's", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const repo = join(tmp, "repo");
      await mkdir(repo);
      await gitRepo(repo);
      const worktree = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", worktree, "-b", "wt");
      const group = JSON.stringify({
        hooks: { SessionStart: [CODEX_HOOK_GROUP] },
      });
      const global = (cwd: string) =>
        runHookCli(cwd, "protocol", startPayload(cwd), "codex", {}, [
          "--global",
        ]);
      // no project hooks file: the global entry speaks
      expect(injected(global(repo).out)).not.toBe("");
      // a .codex/hooks.json without mdmem's entry does not silence it
      await mkdir(join(repo, ".codex"));
      await writeFile(join(repo, CODEX_HOOKS_FILE), CODEX_HOOKS_TEXT, "utf-8");
      expect(injected(global(repo).out)).not.toBe("");

      await writeFile(join(repo, CODEX_HOOKS_FILE), group, "utf-8");
      expect(global(repo)).toEqual(deferred(join(repo, CODEX_HOOKS_FILE)));
      // the project's own entry always speaks
      expect(
        injected(runHookCli(repo, "protocol", startPayload(repo), "codex").out)
      ).not.toBe("");
      // from a subdirectory, Codex reads every .codex/ up to the root, a nearer one without hooks.json too
      const deep = join(repo, "sub", "deep");
      await mkdir(deep, { recursive: true });
      expect(global(deep)).toEqual(deferred(join(repo, CODEX_HOOKS_FILE)));
      await mkdir(join(repo, "sub", ".codex"));
      expect(global(deep)).toEqual(deferred(join(repo, CODEX_HOOKS_FILE)));

      // a linked worktree without .codex/: Codex reads no project hooks there
      expect(injected(global(worktree).out)).not.toBe("");
      // with one, Codex reads the main checkout's hooks file in its place
      await mkdir(join(worktree, ".codex"));
      await writeFile(
        join(worktree, CODEX_HOOKS_FILE),
        CODEX_HOOKS_TEXT,
        "utf-8"
      );
      expect(global(worktree)).toEqual(deferred(join(repo, CODEX_HOOKS_FILE)));
      await writeFile(join(repo, CODEX_HOOKS_FILE), CODEX_HOOKS_TEXT, "utf-8");
      await writeFile(join(worktree, CODEX_HOOKS_FILE), group, "utf-8");
      expect(injected(global(worktree).out)).not.toBe("");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("a payload cwd in a linked worktree resolves the main checkout's store", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const repo = join(tmp, "repo");
      await mkdir(join(repo, ".mdmem"), { recursive: true });
      await gitRepo(repo);
      const worktree = join(tmp, "wt");
      git(repo, "worktree", "add", "-q", worktree, "-b", "wt");

      // run from elsewhere: the payload's cwd decides
      const hook = runHookCli(tmp, "index", startPayload(worktree));
      expect(injected(hook.out)).toStartWith(
        `Store: local, ${join(repo, ".mdmem")}\n`
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

  test("a near-limit index under the header of a store mdmem created is injected whole", async () => {
    await withCliProject(async (root, store) => {
      await store.create("MEMORY.md", storeHeader(root));
      // 380 pointers under the header: past 90% of the index's limit, and under it
      await seedMemories(store, 380);
      const index = await store.view("MEMORY.md");
      expect(index).toStartWith(storeHeader(root));
      expect([...index].length).toBeGreaterThan(INDEX_MAX_CHARS * 0.9);
      expect([...index].length).toBeLessThanOrEqual(INDEX_MAX_CHARS);

      const context = injected(
        runHookCli(root, "index", startPayload(root)).out
      );
      expect(context).toEndWith(`\n\nMEMORY.md:\n${index.trimEnd()}`);
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
      const store = new MemoryStore(join(root, ".mdmem"));
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

  test("the index part writes the session's state under the cache directory before it prints, a child session's in a file of its own", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 2);
      const home = join(root, "home");
      const env = { HOME: home, XDG_CACHE_HOME: "" };
      const sessions = join(home, ".cache", "mdmem", "sessions");
      const plain = runHookCli(root, "index", startPayload(root), "codex", env);
      // no session_id, no state
      expect(existsSync(sessions)).toBe(false);
      const hook = runHookCli(
        root,
        "index",
        sessionPayload(root, "startup", { session_id: "s1" }),
        "codex",
        env
      );
      expect(hook).toEqual(plain);
      const state = await readState(join(sessions, "codex", "s1.json"));
      const snapshot = Object.fromEntries(
        await Promise.all(
          ["m-0.md", "m-1.md"].map(async (file) => {
            const info = await stat(join(store.root, file));
            const hash = versionOf(await store.view(file));
            return [file, { hash, size: info.size, mtime: info.mtimeMs }];
          })
        )
      );
      expect(state).toEqual({
        version: 1,
        agent: "codex",
        store: store.root,
        snapshot,
        lastInjection: expect.any(String),
        shown: [],
      });

      runHookCli(
        root,
        "index",
        sessionPayload(root, "startup", { session_id: "s1", agent_id: "a1" }),
        "codex",
        env
      );
      expect(
        await readState(join(sessions, "codex", "s1", "a1.json"))
      ).toMatchObject({ agent: "codex", snapshot });

      const xdg = join(root, "xdg");
      runHookCli(
        root,
        "index",
        sessionPayload(root, "startup", { session_id: "s2" }),
        "bob",
        { HOME: home, XDG_CACHE_HOME: xdg }
      );
      expect(existsSync(join(xdg, "mdmem", "sessions", "bob", "s2.json"))).toBe(
        true
      );
      expect(existsSync(join(sessions, "bob"))).toBe(false);

      // an id that is not one path component names no file: the output stays, and stderr says why
      const unsafe = runHookCli(
        root,
        "index",
        sessionPayload(root, "startup", { session_id: "../up" }),
        "codex",
        env
      );
      expect(unsafe.out).toBe(plain.out);
      expect(unsafe.err).toBe(
        'mdmem hook: the payload\'s session_id "../up" cannot name a session file, so it keeps no session state.\n'
      );
      expect(existsSync(join(sessions, "up.json"))).toBe(false);
    });
  });

  test("compact rewrites the session's state and empties its shown hits, and resume leaves it alone", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const file = join(root, "cache", "mdmem", "sessions", "bob", "s1.json");
      const seeded = `${JSON.stringify({
        version: 1,
        agent: "bob",
        store: store.root,
        snapshot: {},
        lastInjection: "2026-10-01T00:00:00.000Z",
        shown: ["m-0.md"],
      })}\n`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, seeded);

      runHookCli(
        root,
        "index",
        sessionPayload(root, "resume", { session_id: "s1" }),
        "bob"
      );
      expect(await readFile(file, "utf-8")).toBe(seeded);

      runHookCli(
        root,
        "index",
        sessionPayload(root, "compact", { session_id: "s1" }),
        "bob"
      );
      const state = await readState(file);
      expect(state.shown).toEqual([]);
      expect(Object.keys(state.snapshot)).toEqual(["m-0.md"]);
      expect(state.lastInjection).not.toBe("2026-10-01T00:00:00.000Z");
    });
  });

  test("writing a session's state removes session files older than 30 days, and the session directories that leaves empty", async () => {
    await withCliProject(async (root) => {
      const sessions = join(root, "cache", "mdmem", "sessions");
      const day = 24 * 60 * 60;
      const now = Date.now() / 1000;
      const aged = async (path: string, days: number) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "{}");
        await utimes(path, now - days * day, now - days * day);
      };
      await aged(join(sessions, "codex", "old.json"), 31);
      await aged(join(sessions, "codex", "parent", "child.json"), 31);
      await aged(join(sessions, "claude-code", "young.json"), 29);

      runHookCli(
        root,
        "index",
        sessionPayload(root, "startup", { session_id: "new" })
      );
      expect(existsSync(join(sessions, "codex", "old.json"))).toBe(false);
      expect(existsSync(join(sessions, "codex", "parent"))).toBe(false);
      expect(existsSync(join(sessions, "claude-code", "young.json"))).toBe(
        true
      );
      expect(existsSync(join(sessions, "claude-code", "new.json"))).toBe(true);
    });
  });

  test("a corrupt session file, one with another schema version, or one naming another store directory, is replaced without being read, and the output is unchanged", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      const file = join(
        root,
        "cache",
        "mdmem",
        "sessions",
        "claude-code",
        "s1.json"
      );
      const payload = sessionPayload(root, "startup", { session_id: "s1" });
      const plain = runHookCli(root, "index", startPayload(root));
      const info = await stat(join(store.root, "m-0.md"));
      const hash = versionOf(await store.view("m-0.md"));
      // read, these files' matching size and mtime would carry their wrong hash over
      const misleading = {
        version: 1,
        agent: "claude-code",
        store: join(root, "elsewhere"),
        snapshot: {
          "m-0.md": { hash: "wrong", size: info.size, mtime: info.mtimeMs },
        },
        lastInjection: "2026-10-01T00:00:00.000Z",
        shown: ["m-0.md"],
      };
      await mkdir(dirname(file), { recursive: true });
      const replaced = async (seeded: string) => {
        await writeFile(file, seeded);
        expect(runHookCli(root, "index", payload)).toEqual(plain);
        const state = await readState(file);
        expect(state.store).toBe(store.root);
        expect(state.snapshot["m-0.md"]?.hash).toBe(hash);
        expect(state.shown).toEqual([]);
      };
      await replaced("{not json");
      await replaced(JSON.stringify(misleading));
      await replaced(
        JSON.stringify({ ...misleading, version: 2, store: store.root })
      );
    });
  });

  test("with no store yet, clear writes a session state naming the home store's directory and an empty snapshot", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-hook-")));
    try {
      const bare = join(tmp, "project");
      await mkdir(bare);
      const home = join(tmp, "home");
      runHookCli(
        bare,
        "index",
        sessionPayload(bare, "clear", { session_id: "s1" }),
        "claude-code",
        { HOME: home }
      );
      const state = await readState(
        join(bare, "cache", "mdmem", "sessions", "claude-code", "s1.json")
      );
      expect(state).toMatchObject({
        store: join(home, ".mdmem", projectKey(bare)),
        snapshot: {},
        shown: [],
      });
      expect(existsSync(join(home, ".mdmem"))).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * A git repository whose store git ignores, with Claude Code, Bob and Codex all
 * enabled from its root, mdmem on PATH and every agent directory under a temp home.
 */
async function wiredRepo(): Promise<{
  root: string;
  ctx: AdapterContext;
  store: MemoryStore;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mdmem-status-")));
  await gitRepo(root);
  // the user's global excludes must not decide whether git ignores .mdmem/
  git(root, "config", "core.excludesFile", "/dev/null");
  await writeFile(join(root, ".gitignore"), ".mdmem/\n", "utf-8");
  const store = new MemoryStore(join(root, ".mdmem"));
  await reindex(store);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "mdmem"), "#!/bin/sh\n", "utf-8");
  await chmod(join(bin, "mdmem"), 0o755);
  const home = join(root, "home");
  const env = {
    PATH: bin,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  };
  const ctx = adapterContext(root, store, env, home);
  for (const adapter of [claudeCodeAdapter, bobAdapter, codexAdapter]) {
    // oxlint-disable-next-line no-await-in-loop -- one adapter at a time, as the CLI wires them
    await wire(adapter.enable(ctx, "project"));
  }
  return { root, ctx, store };
}

/** `fn` on a fresh `wiredRepo`, removed after. */
async function withWiredRepo(
  fn: (repo: Awaited<ReturnType<typeof wiredRepo>>) => Promise<void>
): Promise<void> {
  const repo = await wiredRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
}

/** A UserPromptSubmit payload in `cwd` for the session `sessionId` with `prompt`, and `fields` such as agent_id. */
function promptPayload(
  cwd: string,
  sessionId: string,
  prompt: string,
  fields: Record<string, string> = {}
) {
  return {
    cwd,
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt,
    ...fields,
  };
}

/** The block the prompt part printed, after checking its output is the UserPromptSubmit form, under its cap. */
function promptBlock(hook: { code: number | null; out: string }): string {
  expect(hook.code).toBe(0);
  const parsed = JSON.parse(hook.out) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  const block = parsed.hookSpecificOutput.additionalContext;
  expect([...block].length).toBeLessThan(PROMPT_CONTEXT_MAX_CHARS);
  return block;
}

/** What the prompt part prints when it stays silent for `why`. */
function promptSilence(why: string) {
  return { code: 0, out: "", err: `mdmem hook printed nothing: ${why}\n` };
}

/** Write the project memory `name` with `description` and `body`. */
async function writeMemory(
  store: MemoryStore,
  name: string,
  description: string,
  body = "b"
): Promise<void> {
  await store.create(
    `${name}.md`,
    serializeMemory({
      frontmatter: { name, description, metadata: { type: "project" } },
      body,
    })
  );
}

/** The session file of `agent`'s session `id` under the cache runHookCli gives a project at `root`. */
function promptSessionFile(root: string, id: string, agent = "claude-code") {
  return join(root, "cache", "mdmem", "sessions", agent, `${id}.json`);
}

/** A hooks file holding only the project's own prompt entry of `agent`, its handler with `handler`'s fields. */
function promptProjectEntry(agent: string, handler: Record<string, unknown>) {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: `mdmem hook ${agent} prompt`,
              ...handler,
            },
          ],
        },
      ],
    },
  };
}

/** A 124-character description opening with `word`, which makes a 150-character pointer for a 7-character name. */
function longDescription(word: string): string {
  return `${word} ${"y".repeat(120 - word.length)} end`;
}

const CODEX_REVIEW = "Codex reviews a project hook once per path";
const CODEX_REVIEW_POINTER = `- [codex-hook-review](codex-hook-review.md) — ${CODEX_REVIEW}`;
const REVIEW_PROMPT = "Will Codex review the hook again after I edit it?";
const NOTHING_CHANGED = "no memory changed since the session's last prompt";

describe("prompt hook", () => {
  test("a first prompt writes the baseline and injects hits only; the next injects the delta with its tags, and a 21st change the overflow line", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 2);
      await writeMemory(store, "codex-hook-review", CODEX_REVIEW);
      await reindex(store);
      const first = runHookCli(
        root,
        "prompt",
        promptPayload(root, "s1", REVIEW_PROMPT)
      );
      expect(promptBlock(first)).toBe(
        `${HITS_HEADER}\n${CODEX_REVIEW_POINTER}`
      );
      const baseline = await readState(promptSessionFile(root, "s1"));
      expect(Object.keys(baseline.snapshot).toSorted()).toEqual([
        "codex-hook-review.md",
        "m-0.md",
        "m-1.md",
      ]);
      expect(baseline.shown).toEqual(["codex-hook-review.md"]);

      await writeMemory(store, "added", "A memory written since");
      // a longer description, so the edit changes the file's size whatever its mtime
      await writeMemory(store, "m-0", "d, edited since the last prompt");
      await store.remove("m-1.md");
      await reindex(store);
      const second = runHookCli(
        root,
        "prompt",
        promptPayload(root, "s1", "thanks")
      );
      expect(promptBlock(second)).toBe(
        [
          DELTA_HEADER,
          "- [added](added.md) — A memory written since (new)",
          "- [m-0](m-0.md) — d, edited since the last prompt (updated)",
          "- m-1.md (deleted)",
        ].join("\n")
      );

      await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          writeMemory(store, `n-${String(i).padStart(2, "0")}`, "n")
        )
      );
      await reindex(store);
      const lines = promptBlock(
        runHookCli(root, "prompt", promptPayload(root, "s1", "thanks"))
      ).split("\n");
      expect(lines).toHaveLength(22);
      expect(lines[0]).toBe(DELTA_HEADER);
      expect(lines[20]).toBe("- [n-19](n-19.md) — n (new)");
      expect(lines[21]).toBe(
        "1 more memory changed; memory_read MEMORY.md for the current index."
      );
    });
  });

  test("a hit is injected once per session and never beside its own delta line, and an unrelated prompt injects nothing, saying why", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 2);
      await writeMemory(store, "codex-hook-review", CODEX_REVIEW);
      await reindex(store);
      expect(
        promptBlock(
          runHookCli(root, "prompt", promptPayload(root, "s1", REVIEW_PROMPT))
        )
      ).toBe(`${HITS_HEADER}\n${CODEX_REVIEW_POINTER}`);
      expect(
        runHookCli(root, "prompt", promptPayload(root, "s1", REVIEW_PROMPT))
      ).toEqual(
        promptSilence(
          `${NOTHING_CHANGED}, and the memories that bear on the prompt were already shown this session.`
        )
      );
      expect(
        runHookCli(
          root,
          "prompt",
          promptPayload(root, "s2", "thanks, all good")
        )
      ).toEqual(
        promptSilence(
          "the session had no state yet, so mdmem took the store's snapshot for its next prompt, and no memory bears on the prompt."
        )
      );
      await writeMemory(store, "codex-hook-review", `${CODEX_REVIEW}, again`);
      await reindex(store);
      expect(
        promptBlock(
          runHookCli(root, "prompt", promptPayload(root, "s2", REVIEW_PROMPT))
        )
      ).toBe(`${DELTA_HEADER}\n${CODEX_REVIEW_POINTER}, again (updated)`);
    });
  });

  test("in a store of 16 memories, a hit under the floor and a weak one under 60% of the top are left out, and at most 5 hits are injected", async () => {
    await withCliProject(async (root, store) => {
      const fruits = [
        "apple",
        "banana",
        "cherry",
        "grape",
        "lemon",
        "mango",
        "melon",
        "olive",
        "peach",
        "pear",
        "plum",
        "quince",
        "berry",
      ];
      await Promise.all(
        fruits.map((fruit) =>
          writeMemory(
            store,
            `fruit-${fruit}`,
            `The ${fruit} orchard notes`,
            `Harvest the ${fruit} in autumn.`
          )
        )
      );
      await writeMemory(
        store,
        "codex-hook-review",
        CODEX_REVIEW,
        "Approve it in an interactive session."
      );
      // a weak hit, over the floor but under 60% of the top hit's score
      await writeMemory(
        store,
        "hook-timeouts",
        "Timeouts for agent hooks",
        "Codex waits ten seconds."
      );
      // under the floor: one plain mention of hook in its body
      await writeMemory(
        store,
        "release-steps",
        "How a release goes out",
        "Tag, then publish; a hook runs the tests."
      );
      await reindex(store);
      expect(
        promptBlock(
          runHookCli(root, "prompt", promptPayload(root, "s1", REVIEW_PROMPT))
        )
      ).toBe(`${HITS_HEADER}\n${CODEX_REVIEW_POINTER}`);

      // six memories the prompt matches equally, each by a word of its own
      const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
      await Promise.all(
        words.map((word, i) =>
          writeMemory(store, `deploy-${i}`, `The ${word} pipeline`)
        )
      );
      await reindex(store);
      expect(
        promptBlock(
          runHookCli(
            root,
            "prompt",
            promptPayload(
              root,
              "s2",
              `how do the ${words.join(", ")} pipelines run?`
            )
          )
        ).split("\n")
      ).toEqual([
        HITS_HEADER,
        ...words
          .slice(0, 5)
          .map(
            (word, i) =>
              `- [deploy-${i}](deploy-${i}.md) — The ${word} pipeline`
          ),
      ]);
    });
  });

  test("each silence prints nothing and says why on stderr, and a deferring --global entry leaves the session file untouched", async () => {
    await withCliProject(async (root, store) => {
      await writeMemory(store, "codex-hook-review", CODEX_REVIEW);
      await reindex(store);
      const payload = JSON.stringify(
        promptPayload(
          root,
          "by-hand",
          "what do you remember about this project?"
        )
      );
      expect(runHookCli(root, "prompt", "")).toEqual(
        promptSilence(
          `no hook payload on stdin. An agent's per-prompt hook runs this command with a JSON payload; to see what it would inject here, run: echo '${payload}' | mdmem hook claude-code prompt`
        )
      );
      for (const start of [
        startPayload(root),
        { ...startPayload(root), session_id: "s1" },
      ]) {
        expect(runHookCli(root, "prompt", start)).toEqual(
          promptSilence(
            "the event is SessionStart; the prompt part injects only on UserPromptSubmit."
          )
        );
      }
      const { session_id: _, ...anonymous } = promptPayload(
        root,
        "s1",
        REVIEW_PROMPT
      );
      expect(runHookCli(root, "prompt", anonymous)).toEqual(
        promptSilence(
          "the payload names no session_id, which the prompt part needs to know what the session has already seen."
        )
      );
      expect(existsSync(join(root, "cache", "mdmem"))).toBe(false);

      await mkdir(join(root, "claude-config"), { recursive: true });
      await recordTrust(join(root, "claude-config"), root);
      await mkdir(join(root, ".claude"), { recursive: true });
      await mkdir(join(root, ".bob"), { recursive: true });
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(
        join(root, CLAUDE_SETTINGS),
        JSON.stringify(promptProjectEntry("claude-code", {})),
        "utf-8"
      );
      await writeFile(
        join(root, BOB_SETTINGS),
        JSON.stringify(promptProjectEntry("bob", { timeout: 10 })),
        "utf-8"
      );
      await writeFile(
        join(root, CODEX_HOOKS_FILE),
        JSON.stringify(promptProjectEntry("codex", { timeout: 10 })),
        "utf-8"
      );
      const agents = [
        ["claude-code", CLAUDE_SETTINGS],
        ["bob", BOB_SETTINGS],
        ["codex", CODEX_HOOKS_FILE],
      ] as const;
      // the project's own entry speaks and writes the session's state
      for (const [agent] of agents) {
        promptBlock(
          runHookCli(
            root,
            "prompt",
            promptPayload(root, "s1", REVIEW_PROMPT),
            agent
          )
        );
      }
      const states = agents.map(([agent]) =>
        promptSessionFile(root, "s1", agent)
      );
      const before = await Promise.all(
        states.map((state) => readFile(state, "utf-8"))
      );
      // a change the global entry would record, had it written the state
      await writeMemory(store, "added", "A memory written since");
      for (const [agent, file] of agents) {
        expect(
          runHookCli(
            root,
            "prompt",
            promptPayload(root, "s1", REVIEW_PROMPT),
            agent,
            {},
            ["--global"]
          )
        ).toEqual(
          promptSilence(
            `this --global entry stays silent because ${join(root, file)} holds the project's own mdmem hook for the prompt part, which injects it instead.`
          )
        );
      }
      expect(
        await Promise.all(states.map((state) => readFile(state, "utf-8")))
      ).toEqual(before);
    });
  });

  test("a payload with agent_id is a child session with its own file and its own baseline", async () => {
    await withCliProject(async (root, store) => {
      await writeMemory(store, "codex-hook-review", CODEX_REVIEW);
      await reindex(store);
      expect(
        runHookCli(root, "prompt", promptPayload(root, "s1", "thanks"), "codex")
          .out
      ).toBe("");
      await writeMemory(store, "added", "A memory written since");
      await reindex(store);
      const child = runHookCli(
        root,
        "prompt",
        promptPayload(root, "s1", REVIEW_PROMPT, { agent_id: "a1" }),
        "codex"
      );
      expect(promptBlock(child)).toBe(
        `${HITS_HEADER}\n${CODEX_REVIEW_POINTER}`
      );
      const state = await readState(
        join(root, "cache", "mdmem", "sessions", "codex", "s1", "a1.json")
      );
      expect(state.shown).toEqual(["codex-hook-review.md"]);
      // the parent's state is its own: it still sees the new memory, and the hit the child was shown
      expect(
        promptBlock(
          runHookCli(
            root,
            "prompt",
            promptPayload(root, "s1", REVIEW_PROMPT),
            "codex"
          )
        )
      ).toBe(
        `${DELTA_HEADER}\n- [added](added.md) — A memory written since (new)\n${HITS_HEADER}\n${CODEX_REVIEW_POINTER}`
      );
    });
  });

  test("with 20 delta lines and 5 hits of the longest pointer the check allows, the block stays under 4,000 characters", async () => {
    await withCliProject(async (root, store) => {
      // "- [long-00](long-00.md) — " is 26 characters, so a 124-character description makes a 150-character pointer
      const names = Array.from(
        { length: 20 },
        (_, i) => `long-${String(i).padStart(2, "0")}`
      );
      // five hits the prompt matches equally, each by a word of its own
      const words = ["alpha", "bravo", "charlie", "delta", "echo"];
      await Promise.all([
        ...names.map((name) => writeMemory(store, name, "short")),
        ...words.map((word, i) =>
          writeMemory(store, `hits-0${i}`, longDescription(word))
        ),
      ]);
      await reindex(store);
      expect(
        runHookCli(root, "prompt", promptPayload(root, "s1", "thanks")).out
      ).toBe("");
      await Promise.all(
        names.map((name) => writeMemory(store, name, longDescription("lion")))
      );
      await reindex(store);
      const lines = promptBlock(
        runHookCli(root, "prompt", promptPayload(root, "s1", words.join(" ")))
      ).split("\n");
      const pointers = lines.filter((line) => line.startsWith("- "));
      expect(
        pointers.every(
          (line) => [...line.replace(/ \(updated\)$/u, "")].length === 150
        )
      ).toBe(true);
      const hitsAt = lines.indexOf(HITS_HEADER);
      expect(lines.slice(hitsAt + 1)).toHaveLength(5);
      const kept = lines.slice(1, hitsAt - 1);
      expect(kept.every((line) => line.endsWith(" (updated)"))).toBe(true);
      expect(lines[hitsAt - 1]).toBe(
        `${20 - kept.length} more ${20 - kept.length === 1 ? "memory" : "memories"} changed; memory_read MEMORY.md for the current index.`
      );
    });
  });
});

/** The check's problems for the project of `ctx`. */
async function projectProblems(ctx: AdapterContext): Promise<string[]> {
  const check = await checkProject(ctx);
  return check.problems;
}

const AUTO_MEMORY_CONSEQUENCE =
  "so Claude also saves memories to its own directory, which no other agent reads";

describe("status and check", () => {
  test("a fully wired project with an ignored store has no problems and no warnings, only the trust notes", async () => {
    await withWiredRepo(async ({ ctx }) => {
      expect(await checkProject(ctx)).toMatchObject({ problems: [] });
      const status = await projectStatus(ctx);
      expect(status.ignored).toBe(true);
      expect(status.wiringProblems).toEqual([]);
      expect(
        status.agents.map((agent) => [agent.wired, agent.enabled])
      ).toEqual([
        [true, true],
        [true, true],
        [true, true],
      ]);
      expect(status.agents.flatMap(({ warnings }) => warnings)).toEqual([]);
      expect(status.agents.flatMap(({ notes }) => notes)).toEqual([
        "Claude Code runs the project's hooks only in a folder whose trust dialog you accepted, and connects the .mcp.json server only once you approve it: mdmem does not check either.",
        "IBM Bob runs workspace hooks and MCP servers only in a trusted folder: mdmem does not check whether this one is.",
        "Codex CLI reads .codex/hooks.json and .codex/config.toml only in a trusted folder, and runs a hook only once you have reviewed it in an interactive session (`codex exec` never asks): mdmem does not check either.",
      ]);
    });
  });

  test("status notes a store git does not ignore, and the check leaves it alone", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await rm(join(root, ".gitignore"));
      const status = await projectStatus(ctx);
      expect(status.ignored).toBe(false);
      expect(await checkProject(ctx)).toMatchObject({ problems: [] });
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test("the check reports Claude Code's auto memory forced on by the environment or turned on in the local settings", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      const forced = {
        ...ctx,
        env: { ...ctx.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
      };
      expect(await projectProblems(forced)).toEqual([
        `Claude Code's auto memory is on: CLAUDE_CODE_DISABLE_AUTO_MEMORY=0 in the environment forces it on, ${AUTO_MEMORY_CONSEQUENCE} — unset it`,
      ]);
      // Claude Code reads the value trimmed and ignoring case
      const forcedFalse = {
        ...ctx,
        env: { ...ctx.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: " False" },
      };
      expect(await projectProblems(forcedFalse)).toEqual([
        `Claude Code's auto memory is on: CLAUDE_CODE_DISABLE_AUTO_MEMORY= False in the environment forces it on, ${AUTO_MEMORY_CONSEQUENCE} — unset it`,
      ]);
      await writeFile(
        join(root, ".claude/settings.local.json"),
        '{ "autoMemoryEnabled": true }\n',
        "utf-8"
      );
      expect(await projectProblems(ctx)).toEqual([
        `Claude Code's auto memory is on: .claude/settings.local.json sets autoMemoryEnabled to true, overriding .claude/settings.json, ${AUTO_MEMORY_CONSEQUENCE} — remove it from .claude/settings.local.json`,
      ]);
      // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 turns it off whatever the settings say
      const off = {
        ...ctx,
        env: { ...ctx.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      };
      expect(await projectProblems(off)).toEqual([]);
    });
  });

  test("the check reports Claude Code's auto memory not off in the committed settings, read after the user's settings", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      const settings = join(root, CLAUDE_SETTINGS);
      const { autoMemoryEnabled: _, ...rest } = JSON.parse(
        await readFile(settings, "utf-8")
      ) as Record<string, unknown>;
      await writeFile(settings, JSON.stringify(rest), "utf-8");
      expect(await projectProblems(ctx)).toEqual([
        `Claude Code's auto memory is on: autoMemoryEnabled is not false in .claude/settings.json, ${AUTO_MEMORY_CONSEQUENCE} — run \`mdmem enable claude-code --project\``,
      ]);
      // with the project silent, the user's settings in CLAUDE_CONFIG_DIR decide
      const user = join(ctx.env.CLAUDE_CONFIG_DIR ?? "", "settings.json");
      await mkdir(dirname(user), { recursive: true });
      await writeFile(user, '{ "autoMemoryEnabled": false }\n', "utf-8");
      expect(await projectProblems(ctx)).toEqual([]);
    });
  });

  test("status warns, below the checkout's root, that a Bob launched there reads none of its workspace files", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      const sub = join(root, "src");
      await mkdir(sub);
      const below = adapterContext(sub, store, ctx.env, ctx.home);
      const status = await projectStatus(below);
      const bob = status.agents.find(({ title }) => title === "IBM Bob");
      expect(bob?.warnings).toEqual([
        `IBM Bob reads .bob/settings.json (the session-start hooks) and .bob/mcp.json (the mdmem MCP server) only from its workspace, the folder it is launched in: launched here, below ${root}, it gets no memory protocol, no index and no mdmem tools. Launch Bob at ${root}, or run \`mdmem enable bob\` to wire it in every folder.`,
      ]);
      // where status runs is not a problem with the project
      expect(await checkProject(below)).toMatchObject({ problems: [] });
    });
  });

  test("status does not warn, below the root of a repository wiring Bob in both scopes, since the global wiring reaches a Bob launched there", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      await wire(bobAdapter.enable(ctx, "global"));
      const sub = join(root, "src");
      await mkdir(sub);
      const below = adapterContext(sub, store, ctx.env, ctx.home);
      const bobBelow = async () => {
        const status = await projectStatus(below);
        return status.agents.find(({ title }) => title === "IBM Bob");
      };
      const bob = await bobBelow();
      expect(bob?.scopes.map(({ scope, enabled }) => [scope, enabled])).toEqual(
        [
          ["global", true],
          ["project", true],
        ]
      );
      expect(bob?.warnings).toEqual([]);
      const bothScopes = "IBM Bob is wired in both scopes";
      expect(bob?.notes).toContainEqual(expect.stringContaining(bothScopes));
      // a global scope without the server gives a Bob launched there no mdmem tools
      await rm(join(ctx.home, ".bob", "settings", "mcp.json"));
      const partly = await bobBelow();
      expect(
        partly?.scopes.map((scope) => [scope.scope, scope.enabled, scope.wired])
      ).toEqual([
        ["global", true, false],
        ["project", true, true],
      ]);
      expect(partly?.problems).toEqual([]);
      const belowRoot = (missed: string) =>
        `IBM Bob reads .bob/settings.json (the session-start hooks) and .bob/mcp.json (the mdmem MCP server) only from its workspace, the folder it is launched in: launched here, below ${root}, it gets ${missed}. Launch Bob at ${root}, or run \`mdmem enable bob\` to wire it in every folder.`;
      // the global hooks speak there, so only the tools are missing
      expect(partly?.warnings).toEqual([belowRoot("no mdmem tools")]);
      // a global scope without the hooks starts its sessions without the protocol and the index, a problem as well
      await wire(bobAdapter.enable(ctx, "global"));
      await rm(join(ctx.home, ".bob", "settings", "settings.json"));
      const noHooks = await bobBelow();
      expect(
        noHooks?.scopes.map((scope) => [
          scope.scope,
          scope.enabled,
          scope.wired,
        ])
      ).toEqual([
        ["global", true, false],
        ["project", true, true],
      ]);
      expect(noHooks?.problems).toEqual([expect.stringContaining("hook")]);
      expect(noHooks?.warnings).toEqual([
        belowRoot("no memory protocol and no index"),
      ]);
      // enabled in both scopes but wired in one: no note claims both
      expect(noHooks?.notes).not.toContainEqual(
        expect.stringContaining(bothScopes)
      );
    });
  });

  test("status warns, below the root of a project wiring Claude Code in the project scope alone, that a Claude Code started there reads none of its settings", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      const sub = join(root, "src");
      await mkdir(sub);
      const below = adapterContext(sub, store, ctx.env, ctx.home);
      const claudeWarnings = async (): Promise<string[] | undefined> => {
        const status = await projectStatus(below);
        return status.agents.find(({ title }) => title === "Claude Code")
          ?.warnings;
      };
      const warning = `Claude Code reads .claude/settings.json only from the folder it is started in: started here, below ${root}, it runs none of the project's mdmem hooks, so its sessions start without the memory protocol and the index, and it applies neither the project's autoMemoryEnabled: false nor its permission for the mdmem tools. Start Claude Code at ${root}, or run \`mdmem enable claude-code\` to wire it in every folder.`;
      expect(await claudeWarnings()).toEqual([warning]);
      // at the root there is nothing to warn about
      const atRoot = await projectStatus(ctx);
      expect(
        atRoot.agents.find(({ title }) => title === "Claude Code")?.warnings
      ).toEqual([]);
      // where status runs is not a problem with the project
      expect(await checkProject(below)).toMatchObject({ problems: [] });
      // a global scope without mdmem's hooks runs none below the root either
      const user = join(ctx.env.CLAUDE_CONFIG_DIR ?? "", "settings.json");
      await mkdir(dirname(user), { recursive: true });
      await writeFile(
        user,
        '{ "permissions": { "allow": ["mcp__mdmem"] } }\n',
        "utf-8"
      );
      expect(await claudeWarnings()).toEqual([warning]);
      // the global scope's hooks speak below the root, so wired there too it is fine
      await wire(claudeCodeAdapter.enable(ctx, "global"));
      expect(await claudeWarnings()).toEqual([]);
    });
  });

  test("status warns, in a submodule of a wired project, that agents started there get none of its wiring", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      const library = await realpath(
        await mkdtemp(join(tmpdir(), "mdmem-lib-"))
      );
      try {
        await gitRepo(library);
        git(root, "submodule", "add", "-q", library, "lib");
        const sub = join(root, "lib");
        const inSubmodule = adapterContext(sub, store, ctx.env, ctx.home);
        const status = await projectStatus(inSubmodule);
        expect(status.warnings).toEqual([
          `This is a submodule of ${root}, which is wired for Claude Code, IBM Bob, Codex CLI: an agent started here reads the submodule's own files, not the superproject's, so its sessions get no memory protocol, no index and no mdmem tools; Claude Code applies the submodule's settings, not the superproject's, so mdmem's setting that turns its auto memory off does not apply. Start agents at ${root}.`,
        ]);
        // where status runs is not a problem with the project
        expect(await checkProject(inSubmodule)).toMatchObject({ problems: [] });
        // an agent the submodule is wired for too is not named
        await wire(bobAdapter.enable(inSubmodule, "project"));
        const partly = await projectStatus(inSubmodule);
        expect(partly.warnings).toEqual([
          expect.stringContaining(
            `, which is wired for Claude Code, Codex CLI: `
          ),
        ]);
        // the superproject itself gets no such warning
        const atRoot = await projectStatus(ctx);
        expect(atRoot.warnings).toEqual([]);
      } finally {
        await rm(library, { recursive: true, force: true });
      }
    });
  });

  test("enable in a submodule of a wired project wires the submodule's work tree, with the superproject's store", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      const library = await realpath(
        await mkdtemp(join(tmpdir(), "mdmem-lib-"))
      );
      try {
        await gitRepo(library);
        git(root, "submodule", "add", "-q", library, "lib");
        const sub = join(root, "lib");
        const files = [
          CLAUDE_SETTINGS,
          MCP_CONFIG,
          ".bob/settings.json",
          ".bob/mcp.json",
          CODEX_CONFIG,
        ];
        const before = await Promise.all(
          files.map((file) => readText(join(root, file)))
        );

        const enable = runCliWith(
          sub,
          ["enable", "claude-code", "bob", "codex", "--project"],
          {
            HOME: ctx.home,
            CLAUDE_CONFIG_DIR: join(ctx.home, ".claude"),
            CODEX_HOME: join(ctx.home, ".codex"),
          }
        );
        expect(enable.err).toBe("");
        expect(enable.code).toBe(0);
        for (const file of files) {
          expect(existsSync(join(sub, file))).toBe(true);
        }
        expect(
          await Promise.all(files.map((file) => readText(join(root, file))))
        ).toEqual(before);

        // wired there too, the submodule gets no warning, and its sessions load the superproject's store
        const inSubmodule = adapterContext(sub, store, ctx.env, ctx.home);
        const status = await projectStatus(inSubmodule);
        expect(status.warnings).toEqual([]);
        expect(status.agents.map((agent) => agent.wired)).toEqual([
          true,
          true,
          true,
        ]);
        const hook = runHookCli(sub, "index", startPayload(sub));
        expect(injected(hook.out)).toStartWith(`Store: local, ${store.root}\n`);
      } finally {
        await rm(library, { recursive: true, force: true });
      }
    });
  });

  test("the check reports hooks that will not run: an entry missing, Claude Code's and Bob's hooks off, Codex's project hooks missing", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      const settings = join(root, CLAUDE_SETTINGS);
      const claude = JSON.parse(await readFile(settings, "utf-8")) as {
        hooks: { SessionStart: unknown[] };
      };
      claude.hooks.SessionStart = claude.hooks.SessionStart.slice(1);
      await writeFile(
        settings,
        JSON.stringify({ ...claude, disableAllHooks: true }),
        "utf-8"
      );
      const bob = join(root, BOB_SETTINGS);
      const bobSettings = JSON.parse(await readFile(bob, "utf-8")) as object;
      await writeFile(
        bob,
        JSON.stringify({ ...bobSettings, disableWorkspaceHooks: true }),
        "utf-8"
      );
      await rm(join(root, CODEX_HOOKS_FILE));

      expect(await projectProblems(ctx)).toEqual([
        'Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (.claude/settings.json), so its sessions start without what that hook injects — run `mdmem enable claude-code --project`',
        "Claude Code: .claude/settings.json sets disableAllHooks to true, so Claude Code runs no hooks and its sessions start without the memory protocol and the index — remove it",
        "IBM Bob: .bob/settings.json sets disableWorkspaceHooks to true, so Bob runs none of the workspace's hooks and its sessions start without the memory protocol and the index — remove it",
        `Codex CLI: missing SessionStart hooks "mdmem hook codex protocol", "mdmem hook codex index" (${CODEX_HOOKS_FILE}), UserPromptSubmit hook "mdmem hook codex prompt" (${CODEX_HOOKS_FILE}), so its sessions start without what those hooks inject — run \`mdmem enable codex --project\``,
      ]);
    });
  });

  test("every agent and scope wires the UserPromptSubmit entry: status lists it, the check names it alone when only it is missing, enable adds back only it, and disable keeps the user's own groups and the cache", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      for (const adapter of [claudeCodeAdapter, bobAdapter, codexAdapter]) {
        // oxlint-disable-next-line no-await-in-loop -- one adapter at a time, as the CLI wires them
        await wire(adapter.enable(ctx, "global"));
      }
      const cache = join(ctx.home, ".cache", "mdmem", "sessions");
      await mkdir(cache, { recursive: true });
      const files: Record<HookAgent, Record<Scope, string>> = {
        "claude-code": {
          global: join(ctx.env.CLAUDE_CONFIG_DIR ?? "", "settings.json"),
          project: CLAUDE_SETTINGS,
        },
        bob: {
          global: join(ctx.home, ".bob", "settings", "settings.json"),
          project: BOB_SETTINGS,
        },
        codex: {
          global: join(ctx.env.CODEX_HOME ?? "", "hooks.json"),
          project: CODEX_HOOKS_FILE,
        },
      };
      const userGroup = {
        hooks: [{ type: "command", command: "echo mine" }],
      };
      for (const adapter of [claudeCodeAdapter, bobAdapter, codexAdapter]) {
        for (const scope of ["global", "project"] as const) {
          const file = files[adapter.id][scope];
          const path = scope === "global" ? file : join(root, file);
          const label = `UserPromptSubmit hook "mdmem hook ${adapter.id} prompt${scope === "global" ? " --global" : ""}"`;
          const entryOf = (status: AgentStatus) =>
            scopeEntries(status, scope).find((entry) => entry.label === label);
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          expect(entryOf(await adapter.status(ctx))).toEqual({
            label,
            file,
            present: true,
          });
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          const wiredText = (await readText(path)) ?? "";
          const doc = JSON.parse(wiredText);
          const { UserPromptSubmit: _prompt, ...sessionStartOnly } = doc.hooks;
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          await writeFile(
            path,
            `${JSON.stringify({ ...doc, hooks: sessionStartOnly }, null, 2)}\n`,
            "utf-8"
          );
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          const before = await adapter.status(ctx);
          expect(entryOf(before)?.present).toBe(false);
          expect(before.problems).toContain(
            `${adapter.title}: missing ${label} (${file}), so its sessions are not told at each prompt which memories changed or bear on the prompt${enableAdvice(adapter.id, scope)}`
          );

          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          const enabled = await wire(adapter.enable(ctx, scope));
          expect(enabled.actions).toContain(`added in ${file}: ${label}`);
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          expect(await readText(path)).toBe(wiredText);

          // with the session-start entries missing too, the clause is the generic one
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          await writeFile(
            path,
            `${JSON.stringify({ ...doc, hooks: {} }, null, 2)}\n`,
            "utf-8"
          );
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          const bare = await adapter.status(ctx);
          const missing = bare.problems.find((problem) =>
            problem.includes(`(${file}), so`)
          );
          expect(missing).toContain(label);
          expect(missing).toEndWith(
            `, so its sessions start without what those hooks inject${enableAdvice(adapter.id, scope)}`
          );

          // disable takes out mdmem's group and keeps the user's own
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          await writeFile(
            path,
            `${JSON.stringify(
              {
                ...doc,
                hooks: {
                  ...doc.hooks,
                  UserPromptSubmit: [...doc.hooks.UserPromptSubmit, userGroup],
                },
              },
              null,
              2
            )}\n`,
            "utf-8"
          );
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          await wire(adapter.disable(ctx, scope));
          // oxlint-disable-next-line no-await-in-loop -- one agent and scope at a time
          const left = JSON.parse((await readText(path)) ?? "{}");
          expect(left.hooks).toEqual({ UserPromptSubmit: [userGroup] });
        }
      }
      expect(existsSync(cache)).toBe(true);
    });
  });

  test("the check reports a project config file it cannot read as one problem in place of that file's own, wired or not", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(join(root, CLAUDE_SETTINGS), "{ broken", "utf-8");
      const unreadable = `Claude Code: ${CLAUDE_SETTINGS} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again`;
      expect(await projectProblems(ctx)).toEqual([unreadable]);
      const status = await projectStatus(ctx);
      expect(status.wiringProblems).toEqual([unreadable]);
      expect(status.agents.flatMap(({ warnings }) => warnings)).toEqual([]);

      // a readable local settings file that sets a key still decides, since Claude Code reads it before the broken one
      const local = join(root, ".claude/settings.local.json");
      await writeFile(
        local,
        JSON.stringify({ autoMemoryEnabled: true, disableAllHooks: true }),
        "utf-8"
      );
      expect(await projectProblems(ctx)).toEqual([
        unreadable,
        "Claude Code: .claude/settings.local.json sets disableAllHooks to true, so Claude Code runs no hooks and its sessions start without the memory protocol and the index — remove it",
        `Claude Code's auto memory is on: .claude/settings.local.json sets autoMemoryEnabled to true, overriding .claude/settings.json, ${AUTO_MEMORY_CONSEQUENCE} — remove it from .claude/settings.local.json`,
      ]);

      // with .mcp.json gone the project is no longer wired for Claude Code, and the file is still reported
      await rm(join(root, MCP_CONFIG));
      await rm(local);
      expect(await projectProblems(ctx)).toEqual([unreadable]);

      // an unreadable local settings file is a problem of its own, before the committed one
      await writeFile(local, "[]", "utf-8");
      expect(await projectProblems(ctx)).toEqual([
        "Claude Code: .claude/settings.local.json does not hold a JSON object: fix it, then run the check again",
        unreadable,
      ]);
    });
  });

  test("while a file enable reads cannot be read, the check's other problems say to fix it before running enable", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(
        join(root, CLAUDE_SETTINGS),
        JSON.stringify({ permissions: { allow: ["mcp__mdmem"] } }),
        "utf-8"
      );
      await writeFile(join(root, MCP_CONFIG), "{ broken", "utf-8");
      const problems = [
        `Claude Code: ${MCP_CONFIG} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again`,
        `Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (${CLAUDE_SETTINGS}), SessionStart hook "mdmem hook claude-code index" (${CLAUDE_SETTINGS}), UserPromptSubmit hook "mdmem hook claude-code prompt" (${CLAUDE_SETTINGS}), so its sessions start without what those hooks inject — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
        `Claude Code's auto memory is on: autoMemoryEnabled is not false in ${CLAUDE_SETTINGS}, ${AUTO_MEMORY_CONSEQUENCE} — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
      ];
      const status = await claudeCodeAdapter.status(ctx);
      expect(status.problems).toEqual(problems);
      expect(await projectProblems(ctx)).toEqual(problems);
      const project = await projectStatus(ctx);
      expect(project.wiringProblems).toEqual(problems);
      // No adapter reports two such files today; the advice joins them in order.
      expect(
        enableAdvice("claude-code", "project", [MCP_CONFIG, CLAUDE_SETTINGS])
      ).toBe(
        ` — fix ${MCP_CONFIG} and ${CLAUDE_SETTINGS}, then run \`mdmem enable claude-code --project\``
      );
    });
  });

  test("an unreadable local settings file, which enable does not read, leaves the other problems' enable advice as it is", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      const settings = join(root, CLAUDE_SETTINGS);
      const claude = JSON.parse(await readFile(settings, "utf-8")) as {
        hooks: { SessionStart: unknown[] };
      };
      claude.hooks.SessionStart = claude.hooks.SessionStart.slice(1);
      await writeFile(settings, JSON.stringify(claude), "utf-8");
      await writeFile(join(root, ".claude/settings.local.json"), "[]", "utf-8");
      const status = await claudeCodeAdapter.status(ctx);
      expect(status.problems).toEqual([
        "Claude Code: .claude/settings.local.json does not hold a JSON object: fix it, then run the check again",
        'Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (.claude/settings.json), so its sessions start without what that hook injects — run `mdmem enable claude-code --project`',
      ]);
    });
  });

  test("doctor exits 1 for a Bob settings file it cannot read, in a project never wired for Bob", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await wire(bobAdapter.disable(ctx, "project"));
      await mkdir(join(root, ".bob"), { recursive: true });
      await writeFile(join(root, BOB_SETTINGS), "{ broken", "utf-8");
      const doctor = runCliWith(root, ["doctor"], {
        HOME: ctx.home,
        PATH: ctx.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR ?? "",
        CODEX_HOME: ctx.env.CODEX_HOME ?? "",
      });
      expect(doctor.out).toBe(
        `Store: local, ${join(root, ".mdmem")}\nFound 1 problem(s):\n  - IBM Bob: ${BOB_SETTINGS} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again\n`
      );
      expect(doctor.code).toBe(1);
    });
  });

  test("doctor exits 1 with a one-line problem for a .codex/config.toml it cannot read", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(join(root, CODEX_CONFIG), "model = \n", "utf-8");
      const doctor = runCliWith(root, ["doctor"], {
        HOME: ctx.home,
        PATH: ctx.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR ?? "",
        CODEX_HOME: ctx.env.CODEX_HOME ?? "",
      });
      expect(doctor.out).toBe(
        `Store: local, ${join(root, ".mdmem")}\nFound 1 problem(s):\n  - Codex CLI: ${CODEX_CONFIG} is not valid TOML (Error parsing TOML (1, 1): Expected value, reached EOF): fix it, then run the check again\n`
      );
      expect(doctor.code).toBe(1);
    });
  });

  test("doctor exits 1 and says to fix an unreadable .mcp.json before running enable", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(
        join(root, CLAUDE_SETTINGS),
        JSON.stringify({ permissions: { allow: ["mcp__mdmem"] } }),
        "utf-8"
      );
      await writeFile(join(root, MCP_CONFIG), "{ broken", "utf-8");
      const doctor = runCliWith(root, ["doctor"], {
        HOME: ctx.home,
        PATH: ctx.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR ?? "",
        CODEX_HOME: ctx.env.CODEX_HOME ?? "",
      });
      expect(doctor.out).toBe(
        [
          `Store: local, ${join(root, ".mdmem")}`,
          "Found 3 problem(s):",
          `  - Claude Code: ${MCP_CONFIG} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again`,
          `  - Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (${CLAUDE_SETTINGS}), SessionStart hook "mdmem hook claude-code index" (${CLAUDE_SETTINGS}), UserPromptSubmit hook "mdmem hook claude-code prompt" (${CLAUDE_SETTINGS}), so its sessions start without what those hooks inject — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
          `  - Claude Code's auto memory is on: autoMemoryEnabled is not false in ${CLAUDE_SETTINGS}, ${AUTO_MEMORY_CONSEQUENCE} — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
          "",
        ].join("\n")
      );
      expect(doctor.code).toBe(1);
    });
  });

  test("doctor exits 0 when a link to a memory not written yet is its only finding, and lists it as a note", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      await store.create(
        "uses-bun.md",
        memoryText("uses-bun", "See [[ts7-strict]].")
      );
      await reindex(store);
      const env = {
        HOME: ctx.home,
        PATH: ctx.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR ?? "",
        CODEX_HOME: ctx.env.CODEX_HOME ?? "",
      };
      const doctor = runCliWith(root, ["doctor"], env);
      expect(doctor.out).toBe(
        `Store: local, ${store.root}\n✓ 1 memory, no problems\nnote: uses-bun.md links [[ts7-strict]], not written yet\n`
      );
      expect(doctor.code).toBe(0);
      expect(runCliWith(root, ["status"], env).out).toContain(
        "Check: ✓ no problems, 1 note — `mdmem doctor` lists it\n"
      );
    });
  });

  test("the check reports Claude Code's user settings it cannot read only in a project wired for Claude Code", async () => {
    await withWiredRepo(async ({ ctx }) => {
      const user = join(ctx.env.CLAUDE_CONFIG_DIR ?? "", "settings.json");
      await mkdir(dirname(user), { recursive: true });
      await writeFile(user, "[]", "utf-8");
      expect(await projectProblems(ctx)).toEqual([
        `Claude Code: ${user} does not hold a JSON object: fix it, then run the check again`,
      ]);
      await wire(claudeCodeAdapter.disable(ctx, "project"));
      expect(await projectProblems(ctx)).toEqual([]);
    });
  });

  test("a project at the home directory has the global scope only, and reports Claude Code's settings it cannot read once, as the user's", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(join(root, CLAUDE_SETTINGS), "{ broken", "utf-8");
      const atHome = {
        ...ctx,
        home: root,
        env: { ...ctx.env, CLAUDE_CONFIG_DIR: undefined },
      };
      const status = await claudeCodeAdapter.status(atHome);
      expect(status.scopes.map(({ scope }) => scope)).toEqual(["global"]);
      // the user settings hold none of mdmem's global entries, so Claude Code is not enabled and the file is a warning
      expect(status.problems).toEqual([]);
      expect(status.warnings).toEqual([
        `${join(root, CLAUDE_SETTINGS)} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the command again`,
      ]);
    });
  });

  test("the check reports mdmem missing from PATH while an agent is enabled, and not once none is", async () => {
    await withWiredRepo(async ({ ctx }) => {
      const noMdmem = {
        ...ctx,
        env: { ...ctx.env, PATH: join(ctx.home, "empty") },
      };
      expect(await projectProblems(noMdmem)).toEqual([
        "mdmem is not on PATH, so the session-start hooks and the MCP server wired for Claude Code, IBM Bob, Codex CLI, which run `mdmem`, fail — put it on PATH (`npm i -g mdmem`, or `bun link` in mdmem's checkout)",
      ]);
      for (const adapter of [claudeCodeAdapter, bobAdapter, codexAdapter]) {
        // oxlint-disable-next-line no-await-in-loop -- one adapter at a time, as the CLI unwires them
        await wire(adapter.disable(noMdmem, "project"));
      }
      expect(await checkProject(noMdmem)).toMatchObject({ problems: [] });
    });
  });

  test("status counts the check's problems in one line, wiring included, and doctor lists them", async () => {
    await withWiredRepo(async ({ root, ctx, store }) => {
      await store.create("broken.md", "no frontmatter\n");
      // a memory written without a reindex has no pointer
      await store.create("loose.md", memoryText("loose", "b"));
      const noMdmem = {
        ...ctx,
        env: { ...ctx.env, PATH: join(ctx.home, "empty") },
      };
      const status = await projectStatus(noMdmem);
      expect(status.wiringProblems).toHaveLength(1);
      expect(checkSummary(status.check)).toBe(
        "3 problem(s), among them 1 unparseable memory, a stale MEMORY.md — `mdmem doctor` lists them"
      );
      expect(await projectProblems(noMdmem)).toEqual(status.check.problems);
      expect(existsSync(join(root, ".mdmem/broken.md"))).toBe(true);
    });
  });
});

/** A git repository with no store, whose ignore rules are its own, and an isolated home with mdmem on PATH. */
async function freshRepo(): Promise<{
  root: string;
  home: string;
  env: Record<string, string>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mdmem-scope-")));
  await gitRepo(root);
  git(root, "config", "core.excludesFile", "/dev/null");
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "mdmem"), "#!/bin/sh\n", "utf-8");
  await chmod(join(bin, "mdmem"), 0o755);
  return {
    root,
    home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "",
    },
  };
}

/** `fn` on a fresh `freshRepo`, removed after. */
async function withFreshRepo(
  fn: (repo: Awaited<ReturnType<typeof freshRepo>>) => Promise<void>
): Promise<void> {
  const repo = await freshRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
}

describe("scopes and store creation", () => {
  test("in a repository with no store, list and search find no memories, reads refuse, the hooks speak with the index naming the home store, and the first add creates it, importing Claude Code's memories once", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const dir = join(home, ".mdmem", projectKey(root));
      const read = runCliWith(root, ["read", "MEMORY.md"], env);
      expect(read.code).toBe(1);
      expect(read.err).toBe(
        `mdmem: No store for this project yet: the first memory write (memory_write, \`mdmem add\`) creates the home store ${dir}\n`
      );
      // Listing and searching a store not created yet find no memories and create nothing.
      const list = runCliWith(root, ["list"], env);
      expect(list.code).toBe(0);
      expect(list.out).toBe(
        `No memories yet: the first save creates the home store ${dir}\n`
      );
      const search = runCliWith(root, ["search", "bun"], env);
      expect(search.code).toBe(0);
      expect(search.out).toBe('No memories matching "bun".\n');
      expect(existsSync(dir)).toBe(false);

      const before = runCliWith(root, ["status"], env);
      expect(before.out).toStartWith(
        `Store: none yet; the first save creates the home store ${dir}\nCheck: ✓ no problems\n`
      );
      expect(before.out).toContain("  · Claude Code (global)\n");
      expect(before.out).toContain("  · Claude Code (project)\n");
      expect(runCliWith(root, ["doctor"], env).out).toBe(
        `Store: none yet; the first save creates the home store ${dir}\n✓ no problems\n`
      );
      expect(
        runCliWith(root, ["enable", "claude-code", "bob", "codex"], env).code
      ).toBe(0);
      const payload = startPayload(root);
      for (const agent of ["claude-code", "bob", "codex"]) {
        const flags = agent === "codex" ? [] : ["--global"];
        const protocol = runHookCli(
          root,
          "protocol",
          payload,
          agent,
          env,
          flags
        );
        expect(injected(protocol.out)).toBe(getMemoryProtocol(dir));
        const index = runHookCli(root, "index", payload, agent, env, flags);
        expect(injected(index.out)).toBe(
          `Store: none yet; the first memory_write creates the home store ${dir}/ with MEMORY.md.`
        );
      }
      expect(existsSync(dir)).toBe(false);

      const claudeEnv = { env, home };
      await claudeMemory(
        claudeEnv as AdapterContext,
        root,
        "b.md",
        memoryText("b", "From Claude.")
      );
      await claudeMemory(
        claudeEnv as AdapterContext,
        root,
        "MEMORY.md",
        "- [Claude's b](b.md) — From Claude.\n"
      );
      const add = [
        "add",
        "--type",
        "user",
        "--name",
        "uses-bun",
        "--description",
        "Uses bun",
        "--body",
        "Use bun.",
      ];
      const first = runCliWith(root, add, env);
      expect(first.err).toBe("");
      expect(first.code).toBe(0);
      expect(first.out).toStartWith(
        `Created the home store at ${dir}\nCopied into the store:\n    b.md (from `
      );
      expect(first.out).toEndWith("\nSaved uses-bun.md\n");
      expect(first.out).not.toContain("Note: git");
      const store = new MemoryStore(dir, root);
      expect(store.exists("b.md")).toBe(true);
      // the header stays first through the import and the save
      const index = await store.view("MEMORY.md");
      expect(index).toStartWith(storeHeader(root));
      expect(index).toContain("- [Claude's b](b.md) — From Claude.\n");
      expect(index).toContain("(uses-bun.md)");
      expect(existsSync(importMarker(store, claudeEnv))).toBe(true);

      // a store created again does not bring back what the first one imported
      await rm(dir, { recursive: true });
      const again = runCliWith(root, add, env);
      expect(again.out).toBe(
        `Created the home store at ${dir}\nSaved uses-bun.md\n`
      );
      expect(store.exists("b.md")).toBe(false);
    });
  });

  test("a store created by the first add imports a Claude memory whose name differs from its file name under the file name, says so, and doctor passes", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      expect(runCliWith(root, ["enable", "claude-code"], env).code).toBe(0);
      await claudeMemory(
        { env, home } as AdapterContext,
        root,
        "team-lead.md",
        memoryText("Team Lead", "Leads the team.")
      );
      await claudeMemory(
        { env, home } as AdapterContext,
        root,
        "MEMORY.md",
        "- [Team Lead](team-lead.md) — About Team Lead\n"
      );
      const add = runCliWith(
        root,
        [
          "add",
          "--type",
          "user",
          "--name",
          "a",
          "--description",
          "d",
          "--body",
          "b",
        ],
        env
      );
      expect(add.code).toBe(0);
      expect(add.out).toContain(
        'Renamed to match the file name:\n    team-lead.md (was "Team Lead")\n'
      );
      const store = new MemoryStore(
        join(home, ".mdmem", projectKey(root)),
        root
      );
      const stored = parseMemory(await store.view("team-lead.md"));
      expect(stored.frontmatter.name).toBe("team-lead");
      expect(await store.view("MEMORY.md")).toContain(
        "- [Team Lead](team-lead.md) — About Team Lead\n"
      );
      const doctor = runCliWith(root, ["doctor"], env);
      expect(doctor.code).toBe(0);
      expect(doctor.out).toBe(
        `Store: home, ${store.root}\n✓ 2 memories, no problems\n`
      );
    });
  });

  test("a store created where Claude Code is wired in neither scope imports nothing, and a refused add creates no store", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      await claudeMemory(
        { env, home } as AdapterContext,
        root,
        "b.md",
        memoryText("b", "From Claude.")
      );
      const refused = runCliWith(
        root,
        [
          "add",
          "--type",
          "user",
          "--name",
          "Bad Name",
          "--description",
          "d",
          "--body",
          "b",
        ],
        env
      );
      expect(refused.code).toBe(1);
      const dir = join(home, ".mdmem", projectKey(root));
      expect(existsSync(dir)).toBe(false);

      const add = runCliWith(
        root,
        [
          "add",
          "--type",
          "user",
          "--name",
          "a",
          "--description",
          "d",
          "--body",
          "b",
        ],
        env
      );
      expect(add.out).not.toContain("Copied");
      expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);
      expect(existsSync(join(dir, "b.md"))).toBe(false);
    });
  });

  test("enable --project in a repository with no store writes the project files and creates no store; the first add creates the home store, importing Claude Code's memories", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      await claudeMemory(
        { env, home } as AdapterContext,
        root,
        "b.md",
        memoryText("b", "From Claude.")
      );
      const enable = runCliWith(
        root,
        ["enable", "claude-code", "--project"],
        env
      );
      expect(enable.err).toBe("");
      expect(enable.code).toBe(0);
      expect(enable.out).toStartWith(
        "Claude Code:\n  added in .claude/settings.json: "
      );
      expect(existsSync(join(root, MCP_CONFIG))).toBe(true);
      // the user-wide files are untouched, and no store exists yet
      expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
      const dir = join(home, ".mdmem", projectKey(root));
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(root, ".mdmem"))).toBe(false);

      const add = runCliWith(
        root,
        [
          "add",
          "--type",
          "user",
          "--name",
          "a",
          "--description",
          "d",
          "--body",
          "b",
        ],
        env
      );
      expect(add.out).toStartWith(
        `Created the home store at ${dir}\nCopied into the store:\n`
      );
      expect(existsSync(join(dir, "b.md"))).toBe(true);
    });
  });

  test("outside git with no store, the working directory is the project: status and doctor name its home store, status shows both scopes, and enable --project creates no store", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-scope-")));
    try {
      const home = join(tmp, "home");
      const dir = join(tmp, "outside");
      await mkdir(dir);
      const env = {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      };
      const none = `Store: none yet; the first save creates the home store ${join(home, ".mdmem", projectKey(dir))}`;
      expect(runCliWith(dir, ["enable", "bob"], env).code).toBe(0);
      const status = runCliWith(dir, ["status"], env);
      expect(status.code).toBe(0);
      expect(status.out).toStartWith(`${none}\nCheck: `);
      expect(status.out).toContain(
        `  ✓ IBM Bob (global)\n      ✓ SessionStart hooks "mdmem hook bob protocol --global", "mdmem hook bob index --global" (${join(home, ".bob/settings/settings.json")})\n`
      );
      expect(status.out).toContain("  · IBM Bob (project)\n");
      const doctor = runCliWith(dir, ["doctor"], {
        ...env,
        PATH: join(home, "empty"),
      });
      expect(doctor.out).toBe(
        `${none}\nFound 1 problem(s):\n  - mdmem is not on PATH, so the session-start hooks and the MCP server wired for IBM Bob, which run \`mdmem\`, fail — put it on PATH (\`npm i -g mdmem\`, or \`bun link\` in mdmem's checkout)\n`
      );
      expect(doctor.code).toBe(1);
      expect(runCliWith(dir, ["disable", "bob"], env).code).toBe(0);
      const clean = runCliWith(dir, ["doctor"], env);
      expect(clean.out).toBe(`${none}\n✓ no problems\n`);
      expect(clean.code).toBe(0);
      // the project scope outside git: the working directory is the project, and enable writes its files only
      const project = runCliWith(dir, ["enable", "bob", "--project"], env);
      expect(project.code).toBe(0);
      expect(project.out).not.toContain("Created");
      expect(existsSync(join(dir, ".mdmem"))).toBe(false);
      expect(existsSync(join(home, ".mdmem"))).toBe(false);
      expect(existsSync(join(dir, ".bob/settings.json"))).toBe(true);
      expect(runCliWith(dir, ["status"], env).out).toContain(
        "✓ IBM Bob (project)"
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("in the home directory, enable --project and disable --project refuse, pointing to the global scope, and status shows the global scope only", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-scope-")));
    try {
      const home = join(tmp, "home");
      await mkdir(home);
      // the agents' user-wide files where they are by default, so the project's files in the home directory are the same files
      const env = {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      };
      const agents = ["claude-code", "bob", "codex"];
      expect(runCliWith(home, ["enable", ...agents], env).code).toBe(0);
      const userFiles = [
        ".claude/settings.json",
        ".claude.json",
        ".bob/settings/settings.json",
        ".bob/settings/mcp.json",
        ".codex/hooks.json",
        ".codex/config.toml",
      ].map((file) => join(home, file));
      const before = await Promise.all(userFiles.map(readText));
      for (const mode of ["enable", "disable"]) {
        const refused = runCliWith(home, [mode, ...agents, "--project"], env);
        expect(refused.code).toBe(1);
        expect(refused.err).toBe(
          `mdmem: ${home} is your home directory, which the global scope wires (there Claude Code's and Codex's project files are, by default, their user-wide files): run \`mdmem ${mode}\` without --project\n`
        );
      }
      expect(await Promise.all(userFiles.map(readText))).toEqual(before);
      expect(existsSync(join(home, ".bob", "settings.json"))).toBe(false);

      const status = runCliWith(home, ["status"], env);
      expect(status.code).toBe(0);
      for (const title of ["Claude Code", "IBM Bob", "Codex CLI"]) {
        expect(status.out).toContain(`  ✓ ${title} (global)\n`);
      }
      expect(status.out).not.toContain("(project)");

      // Claude Code launched in the home directory still reads ~/.claude/settings.local.json first
      await writeFile(
        join(home, ".claude", "settings.local.json"),
        JSON.stringify({ autoMemoryEnabled: true }),
        "utf-8"
      );
      expect(runCliWith(home, ["doctor"], env).out).toContain(
        `Claude Code's auto memory is on: .claude/settings.local.json sets autoMemoryEnabled to true, overriding .claude/settings.json, ${AUTO_MEMORY_CONSEQUENCE} — remove it from .claude/settings.local.json`
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("a repository wired in both scopes has two status lines per agent and no problem, and injects each part once", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const agents = ["claude-code", "bob", "codex"];
      expect(runCliWith(root, ["enable", ...agents], env).code).toBe(0);
      expect(
        runCliWith(root, ["enable", ...agents, "--project"], env).code
      ).toBe(0);
      const dir = join(home, ".mdmem", projectKey(root));

      const status = runCliWith(root, ["status"], env);
      expect(status.err).toBe("");
      expect(status.out).toStartWith(
        `Store: none yet; the first save creates the home store ${dir}\nCheck: ✓ no problems, 3 notes — \`mdmem doctor\` lists them\n`
      );
      const titles = ["Claude Code", "IBM Bob", "Codex CLI"];
      const notes = titles.map(
        (title) =>
          `${title} is wired in both scopes: where its project hooks run, its global ones stay silent, so a session gets the protocol and the index once.`
      );
      for (const [i, title] of titles.entries()) {
        expect(status.out).toContain(`  ✓ ${title} (global)\n`);
        expect(status.out).toContain(`  ✓ ${title} (project)\n`);
        expect(status.out).toContain(`      ${notes[i]}\n`);
      }
      // the check lists the same notes, which are not problems
      expect(runCliWith(root, ["doctor"], env)).toMatchObject({
        code: 0,
        out: `Store: none yet; the first save creates the home store ${dir}\n✓ no problems\n${notes.map((note) => `note: ${note}\n`).join("")}`,
      });

      // the global entries stay silent beside the project's own, naming its file; Claude Code's only in a folder it records as trusted
      await recordTrust(join(home, ".claude"), root);
      const payload = startPayload(root);
      for (const [agent, settings] of [
        ["claude-code", ".claude/settings.json"],
        ["bob", ".bob/settings.json"],
        ["codex", ".codex/hooks.json"],
      ] as const) {
        for (const part of SESSION_START_PARTS) {
          expect(
            runHookCli(root, part, payload, agent, env, ["--global"])
          ).toEqual({
            code: 0,
            out: "",
            err: `mdmem hook printed nothing: this --global entry stays silent because ${join(root, settings)} holds the project's own mdmem hook for the ${part} part, which injects it instead.\n`,
          });
          expect(
            injected(runHookCli(root, part, payload, agent, env).out)
          ).not.toBe("");
        }
      }

      // below the root, Bob and Claude Code read none of the project's settings, so their global hooks speak there
      const sub = join(root, "src");
      await mkdir(sub);
      for (const agent of ["bob", "claude-code"]) {
        const below = runHookCli(
          sub,
          "protocol",
          startPayload(sub),
          agent,
          env,
          ["--global"]
        );
        expect(injected(below.out)).toBe(getMemoryProtocol(dir));
      }
      // Codex reads .codex/ up to the work tree's root, so its global hook stays silent below it too
      expect(
        runHookCli(sub, "protocol", startPayload(sub), "codex", env, [
          "--global",
        ])
      ).toEqual({
        code: 0,
        out: "",
        err: `mdmem hook printed nothing: this --global entry stays silent because ${join(root, CODEX_HOOKS_FILE)} holds the project's own mdmem hook for the protocol part, which injects it instead.\n`,
      });

      // a project's server registration alone does not silence the global hook
      expect(
        runCliWith(root, ["disable", "claude-code", "--project"], env).code
      ).toBe(0);
      await writeFile(
        join(root, MCP_CONFIG),
        `${JSON.stringify({ mcpServers: { mdmem: MDMEM_SERVER } })}\n`,
        "utf-8"
      );
      expect(
        injected(
          runHookCli(root, "protocol", payload, "claude-code", env, [
            "--global",
          ]).out
        )
      ).toBe(getMemoryProtocol(dir));
    });
  });

  test("Claude Code's global hook beside the project's own speaks, saying why on stderr, until its user config records the folder as trusted", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      expect(runCliWith(root, ["enable", "claude-code"], env).code).toBe(0);
      expect(
        runCliWith(root, ["enable", "claude-code", "--project"], env).code
      ).toBe(0);
      const dir = join(home, ".mdmem", projectKey(root));
      const configDir = join(home, ".claude");
      const hook = (cwd: string) =>
        runHookCli(cwd, "protocol", startPayload(cwd), "claude-code", env, [
          "--global",
        ]);
      const speaks = (cwd: string) => {
        const run = hook(cwd);
        expect(injected(run.out)).toBe(getMemoryProtocol(dir));
        expect(run.err).toBe(
          `mdmem hook: this --global entry injects the protocol part although ${join(cwd, ".claude/settings.json")} holds the project's own mdmem hook for it, because ${join(configDir, ".claude.json")} does not record ${cwd} as trusted and Claude Code runs the project's hooks only in a trusted folder. Once you accept the folder's trust dialog, the project's hook injects it and this entry stays silent.\n`
        );
      };

      // no trust recorded, or the dialog not accepted: the project's hooks do not run, so the global one speaks
      speaks(root);
      await recordTrust(configDir, root, false);
      speaks(root);

      // trusted: the project's hook runs, so the global one stays silent
      await recordTrust(configDir, root);
      expect(hook(root)).toEqual(deferred(join(root, ".claude/settings.json")));

      // the trust record is keyed by the resolved path
      const link = join(root, "home", "link");
      await symlink(root, link);
      expect(hook(link)).toEqual(deferred(join(link, ".claude/settings.json")));

      // a subdirectory holding the project's settings is covered by its work tree root's trust
      const sub = join(root, "src");
      await mkdir(join(sub, ".claude"), { recursive: true });
      await writeFile(
        join(sub, ".claude/settings.json"),
        await readFile(join(root, ".claude/settings.json"), "utf-8"),
        "utf-8"
      );
      expect(hook(sub)).toEqual(deferred(join(sub, ".claude/settings.json")));

      // a linked worktree's trust is recorded under the main checkout's root
      git(root, "add", ".claude/settings.json", ".mcp.json");
      git(root, "commit", "-q", "-m", "wire claude code");
      const worktree = join(root, "home", "wt");
      git(root, "worktree", "add", "-q", worktree);
      expect(hook(worktree)).toEqual(
        deferred(join(worktree, ".claude/settings.json"))
      );
      await recordTrust(configDir, root, false);
      speaks(worktree);

      // the walk stops at the work tree's root: a trusted folder above the repository does not count
      await recordTrust(configDir, dirname(root));
      speaks(root);
    });
  });

  test("the check reports the global scope's missing hook and auto memory with the global fix, and a project's true over the user's false", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      expect(runCliWith(root, ["enable", "claude-code"], env).code).toBe(0);
      const userSettings = join(home, ".claude/settings.json");
      const settings = JSON.parse(await readFile(userSettings, "utf-8")) as {
        hooks: { SessionStart: unknown[] };
        autoMemoryEnabled?: boolean;
      };
      settings.hooks.SessionStart = settings.hooks.SessionStart.slice(1);
      Reflect.deleteProperty(settings, "autoMemoryEnabled");
      await writeFile(userSettings, JSON.stringify(settings), "utf-8");
      const ctx = adapterContext(root, undefined, env, home);
      expect(await projectProblems(ctx)).toEqual([
        `Claude Code: missing SessionStart hook "mdmem hook claude-code protocol --global" (${userSettings}), so its sessions start without what that hook injects — run \`mdmem enable claude-code\``,
        `Claude Code's auto memory is on: autoMemoryEnabled is not false in ${userSettings}, ${AUTO_MEMORY_CONSEQUENCE} — run \`mdmem enable claude-code\``,
      ]);

      expect(runCliWith(root, ["enable", "claude-code"], env).code).toBe(0);
      await mkdir(join(root, ".claude"));
      await writeFile(
        join(root, CLAUDE_SETTINGS),
        '{ "autoMemoryEnabled": true }\n',
        "utf-8"
      );
      const inRepo = adapterContext(
        root,
        new MemoryStore(join(root, ".mdmem")),
        env,
        home
      );
      expect(await projectProblems(inRepo)).toEqual([
        `Claude Code's auto memory is on: ${CLAUDE_SETTINGS} sets autoMemoryEnabled to true, overriding ${userSettings}, ${AUTO_MEMORY_CONSEQUENCE} — remove it from ${CLAUDE_SETTINGS}`,
      ]);
    });
  });
});

/** `mdmem add` of a user memory named `name`, as `runCliWith` runs it. */
function addArgs(name: string): string[] {
  return [
    "add",
    "--type",
    "user",
    "--name",
    name,
    "--description",
    `About ${name}`,
    "--body",
    "b",
  ];
}

describe("placements", () => {
  test("store local moves the home store into the project, where status, doctor and the hook find it, and store home moves it back", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const homeStore = join(home, ".mdmem", projectKey(root));
      const local = join(root, ".mdmem");
      expect(runCliWith(root, ["store"], env).out).toBe(
        `Store: none yet; the first save creates the home store ${homeStore}\n`
      );
      expect(runCliWith(root, addArgs("a"), env).code).toBe(0);
      expect(runCliWith(root, ["store"], env).out).toBe(
        `Store: home, ${homeStore}\n`
      );
      // the project file is not a memory: the check counts one memory and finds no problem
      expect(existsSync(join(homeStore, "project"))).toBe(true);
      expect(runCliWith(root, ["doctor"], env).out).toBe(
        `Store: home, ${homeStore}\n✓ 1 memory, no problems\n`
      );

      const toLocal = runCliWith(root, ["store", "local"], env);
      expect(toLocal.err).toBe("");
      expect(toLocal.code).toBe(0);
      expect(toLocal.out).toBe(
        [
          `Moved the store from ${homeStore} to ${local}`,
          `Store: local, ${local}`,
          "Note: git does not ignore .mdmem/; ignoring or committing it is your choice.",
          "To move it to the home store: mdmem store home",
          "",
        ].join("\n")
      );
      expect(existsSync(homeStore)).toBe(false);
      expect(existsSync(join(local, "a.md"))).toBe(true);
      const moved = await readFile(join(local, "MEMORY.md"), "utf-8");
      expect(moved).toStartWith(storeHeader(root));
      expect(runCliWith(root, ["status"], env).out).toStartWith(
        `Store: local, ${local}\nMemories: 1\n`
      );
      const index = runHookCli(root, "index", startPayload(root), "bob", env);
      expect(injected(index.out)).toStartWith(`Store: local, ${local}\n`);
      expect(runCliWith(root, ["store", "local"], env).out).toBe(
        `Store: local, ${local}\nAlready local. To move it to the home store: mdmem store home\n`
      );

      const toHome = runCliWith(root, ["store", "home"], env);
      expect(toHome.code).toBe(0);
      expect(toHome.out).toBe(
        [
          `Moved the store from ${local} to ${homeStore}`,
          `Store: home, ${homeStore}`,
          "To move it to the local store: mdmem store local",
          "",
        ].join("\n")
      );
      expect(existsSync(local)).toBe(false);
      expect(await readFile(join(homeStore, "project"), "utf-8")).toBe(
        `${root}\n`
      );
      expect(await readFile(join(homeStore, "MEMORY.md"), "utf-8")).toBe(moved);
      expect(runCliWith(root, ["status"], env).out).toStartWith(
        `Store: home, ${homeStore}\nMemories: 1\n`
      );
    });
  });

  test("with memories in both placements, the local store wins, status warns naming the home store, and store local and store home each refuse naming the other", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const homeStore = join(home, ".mdmem", projectKey(root));
      const local = join(root, ".mdmem");
      expect(runCliWith(root, addArgs("a"), env).code).toBe(0);
      expect(runCliWith(root, ["store", "local"], env).code).toBe(0);
      // a home store made again beside the local one, as a teammate's clone would meet it
      await mkdir(homeStore, { recursive: true });
      await writeFile(
        join(homeStore, "b.md"),
        memoryText("b", "In the home store."),
        "utf-8"
      );

      const status = runCliWith(root, ["status"], env);
      expect(status.out).toStartWith(`Store: local, ${local}\n`);
      expect(status.err).toContain(
        `mdmem: warning: the home store ${homeStore} holds 1 memory too, which no agent reads while the local store ${local} exists: fold them in with \`mdmem consolidate --from ${homeStore}\`\n`
      );
      const toLocal = runCliWith(root, ["store", "local"], env);
      expect(toLocal.code).toBe(1);
      expect(toLocal.err).toBe(
        `mdmem: the local store ${local} already holds memories, and so does the home store ${homeStore}: fold the home store into the local one with \`mdmem consolidate --from ${homeStore}\`, then run this again\n`
      );
      const toHome = runCliWith(root, ["store", "home"], env);
      expect(toHome.code).toBe(1);
      expect(toHome.err).toBe(
        `mdmem: the home store ${homeStore} already holds memories, and so does the local store ${local}: fold the home store into the local one with \`mdmem consolidate --from ${homeStore}\`, then run this again\n`
      );
      expect(existsSync(join(local, "a.md"))).toBe(true);
      expect(existsSync(join(homeStore, "b.md"))).toBe(true);

      const consolidate = runCliWith(
        root,
        ["consolidate", "--from", homeStore],
        env
      );
      expect(consolidate.code).toBe(0);
      expect(consolidate.out).toBe(
        getConsolidatePrompt(local, undefined, homeStore)
      );
      const missing = runCliWith(
        root,
        ["consolidate", "--from", join(root, "nope")],
        env
      );
      expect(missing.code).toBe(1);
      expect(missing.err).toStartWith(
        `mdmem: ${join(root, "nope")} is not a directory`
      );
    });
  });

  test("consolidate --from refuses the project's own store reached through a symlink", async () => {
    await withFreshRepo(async ({ root, env }) => {
      const local = join(root, ".mdmem");
      expect(runCliWith(root, addArgs("a"), env).code).toBe(0);
      expect(runCliWith(root, ["store", "local"], env).code).toBe(0);
      const link = join(root, "link");
      await symlink(local, link);
      const result = runCliWith(root, ["consolidate", "--from", "link"], env);
      expect(result.code).toBe(1);
      expect(result.err).toStartWith(`mdmem: ${link} is this project's store`);
    });
  });

  test("a move writes the project file of a store that has none, and store list shows a home store without one as such", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const homeStore = join(home, ".mdmem", projectKey(root));
      const local = join(root, ".mdmem");
      // a local store renamed by hand from .memory/, with no project file
      await mkdir(local);
      await writeFile(join(local, "a.md"), memoryText("a", "Kept."), "utf-8");
      expect(runCliWith(root, ["store", "home"], env).code).toBe(0);
      expect(await readFile(join(homeStore, "project"), "utf-8")).toBe(
        `${root}\n`
      );
      expect(runCliWith(root, ["store", "list"], env).out).toBe(
        `${projectKey(root)} — ${root} — 1 memory\n`
      );

      await rm(join(homeStore, "project"));
      expect(runCliWith(root, ["store", "list"], env).out).toBe(
        `${projectKey(root)} — no project file — 1 memory\n`
      );
    });
  });

  test("store local with no store creates an empty local store, which the next add uses", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const local = join(root, ".mdmem");
      const created = runCliWith(root, ["store", "local"], env);
      expect(created.code).toBe(0);
      expect(created.out).toBe(
        [
          `Created the local store at ${local}`,
          "Note: git does not ignore .mdmem/; ignoring or committing it is your choice.",
          "To move it to the home store: mdmem store home",
          "",
        ].join("\n")
      );
      expect(await readFile(join(local, "project"), "utf-8")).toBe(`${root}\n`);
      expect(await readFile(join(local, "MEMORY.md"), "utf-8")).toBe(
        storeHeader(root)
      );
      expect(runCliWith(root, addArgs("a"), env).out).toBe("Saved a.md\n");
      expect(await readFile(join(local, "MEMORY.md"), "utf-8")).toStartWith(
        storeHeader(root)
      );
      expect(existsSync(join(local, "a.md"))).toBe(true);
      expect(existsSync(join(home, ".mdmem"))).toBe(false);
    });
  });

  test("store local refuses in a bare x.git and its worktree, where the store would sit in its git directory, and creates the store beside a bare <dir>/.git", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-bare-")));
    try {
      const env = { HOME: join(tmp, "home") };
      const source = join(tmp, "source");
      await mkdir(source);
      await gitRepo(source);
      const bare = join(tmp, "x.git");
      git(tmp, "clone", "-q", "--bare", source, bare);
      const refused = runCliWith(bare, ["store", "local"], env);
      expect(refused.code).toBe(1);
      expect(refused.err).toBe(
        `mdmem: ${join(bare, ".mdmem")} would sit inside the repository's git directory ${bare}, which no work tree holds, so it could never be committed: the project keeps its home store ${join(tmp, "home", ".mdmem", projectKey(bare))}\n`
      );
      expect(existsSync(join(bare, ".mdmem"))).toBe(false);
      // a worktree of x.git is keyed by x.git too, so its local store would sit there as well
      const worktree = join(tmp, "wt");
      git(bare, "worktree", "add", "-q", worktree);
      expect(runCliWith(worktree, ["store", "local"], env)).toMatchObject({
        code: 1,
        err: refused.err,
      });
      expect(existsSync(join(bare, ".mdmem"))).toBe(false);
      // a local store already there, made by hand or by an older mdmem, is the one in use: move it out
      await mkdir(join(bare, ".mdmem"));
      expect(runCliWith(bare, ["store", "local"], env)).toMatchObject({
        code: 1,
        err: `mdmem: the local store ${join(bare, ".mdmem")} sits inside the repository's git directory ${bare}, which no work tree holds, so it can never be committed: move it with \`mdmem store home\`\n`,
      });
      await rm(join(bare, ".mdmem"), { recursive: true });

      const container = join(tmp, "c");
      await mkdir(container);
      git(tmp, "clone", "-q", "--bare", source, join(container, ".git"));
      const created = runCliWith(container, ["store", "local"], env);
      expect(created.err).toBe("");
      expect(created.code).toBe(0);
      expect(existsSync(join(container, ".mdmem", "MEMORY.md"))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("store list prints every home store with its project and memory count, naming one whose project was deleted", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-list-")));
    try {
      const env = { HOME: join(tmp, "home") };
      const kept = join(tmp, "kept");
      const gone = join(tmp, "gone");
      await mkdir(kept);
      await mkdir(gone);
      expect(runCliWith(kept, addArgs("a"), env).code).toBe(0);
      expect(runCliWith(gone, addArgs("a"), env).code).toBe(0);
      expect(runCliWith(gone, addArgs("b"), env).code).toBe(0);
      await rm(gone, { recursive: true });

      const list = runCliWith(kept, ["store", "list"], env);
      expect(list.code).toBe(0);
      expect(list.out).toBe(
        [
          `${projectKey(gone)} — ${gone} — 2 memories, project missing`,
          `${projectKey(kept)} — ${kept} — 1 memory`,
          "",
        ].join("\n")
      );
      expect(runCliWith(tmp, ["store", "nope"], env).err).toBe(
        'mdmem: unknown store action "nope" — usage: mdmem store [local | home | list]\n'
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
