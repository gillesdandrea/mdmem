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
  symlink,
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
import { checkSummary, reindex } from "../src/core/check.ts";
import { HOOK_CONTEXT_MAX_CHARS, HOOK_PARTS } from "../src/core/hook.ts";
import { claudeProjectDir, importMarker } from "../src/core/import.ts";
import { projectKey } from "../src/core/key.ts";
import { parseMemory, serializeMemory } from "../src/core/memory.ts";
import {
  getConsolidatePrompt,
  getMemoryProtocol,
} from "../src/core/protocol.ts";
import { RefusalError } from "../src/core/refusal.ts";
import { MemoryStore } from "../src/core/store.ts";
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
const MDMEM_SERVER = { type: "stdio", command: "mdmem", args: ["mcp"] };

describe("claude-code wiring", () => {
  test("enable merges mdmem's entries into existing files, keeping the rest byte for byte, and disable takes exactly them out", async () => {
    const { root, ctx } = await tempProject();
    try {
      const otherHook = {
        matcher: "startup",
        hooks: [{ type: "command", command: "echo hi" }],
      };
      const settings = {
        model: "opus",
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
          ],
          SessionStart: [otherHook],
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
        `added in ${CLAUDE_SETTINGS}: autoMemoryEnabled: false, SessionStart hook "mdmem hook claude-code protocol", SessionStart hook "mdmem hook claude-code index", permissions.allow "mcp__mdmem"`
      );
      const wiredSettings = {
        model: "opus",
        hooks: {
          PreToolUse: settings.hooks.PreToolUse,
          SessionStart: [otherHook, mdmemHook("protocol"), mdmemHook("index")],
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
      expect(projectEntries(status)).toHaveLength(5);

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
        `added in ${userSettings}: autoMemoryEnabled: false, SessionStart hook "mdmem hook claude-code protocol --global", SessionStart hook "mdmem hook claude-code index --global", permissions.allow "mcp__mdmem"`
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

/**
 * A project with the given hooks.json and .codex/config.toml texts, whose Codex
 * home is `codexHome` (as CODEX_HOME), else ~/.codex under the temp home.
 */
async function codexProject(
  codexHome: string | undefined,
  files: { hooks?: string; toml?: string } = {}
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
  if (files.toml !== undefined) {
    await mkdir(join(project.root, ".codex"));
    await writeFile(join(project.root, CODEX_CONFIG), files.toml, "utf-8");
  }
  return { root: project.root, ctx, hooksPath };
}

describe("codex wiring", () => {
  test("enable merges the hook group into the global hooks.json and the server into .codex/config.toml, keeping the rest, and another project finds the hook present", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const codexHome = join(shared, "codex-home");
    const first = await codexProject(codexHome, {
      hooks: CODEX_HOOKS_TEXT,
      toml: CODEX_TOML,
    });
    const second = await codexProject(codexHome);
    try {
      const enabled = await wire(codexAdapter.enable(first.ctx, "project"));
      const wiredHooks = {
        hooks: {
          ...CODEX_HOOKS.hooks,
          SessionStart: [...CODEX_HOOKS.hooks.SessionStart, CODEX_HOOK_GROUP],
        },
      };
      const hooks = await readText(first.hooksPath);
      expect(hooks).toBe(`${JSON.stringify(wiredHooks, null, 2)}\n`);
      expect(codexHooksFile.safeParse(JSON.parse(hooks ?? "{}")).success).toBe(
        true
      );
      const toml = await readText(join(first.root, CODEX_CONFIG));
      expect(toml).toBe(`${CODEX_TOML}\n${CODEX_SECTION}`);
      expect(Bun.TOML.parse(toml ?? "")).toEqual({
        model: "gpt-5",
        mcp_servers: {
          other: { command: "other", args: ["a"] },
          mdmem: { command: "mdmem", args: ["mcp"] },
        },
        profiles: { fast: { model: "mini" } },
      });
      expect(
        enabled.actions.some((a) => a.includes("review the new hook"))
      ).toBe(true);
      expect(await wired(codexAdapter, first.ctx)).toBe(true);

      // a second run changes nothing
      const again = await wire(codexAdapter.enable(first.ctx, "project"));
      expect(again.actions).toContain(
        `${first.hooksPath} already holds mdmem's entries`
      );
      expect(again.actions).toContain(
        `${CODEX_CONFIG} already holds mdmem's entries`
      );
      expect(await readText(first.hooksPath)).toBe(hooks);
      expect(await readText(join(first.root, CODEX_CONFIG))).toBe(toml);

      // another project: the global hook is already there, the project gets its own server
      const other = await wire(codexAdapter.enable(second.ctx, "project"));
      expect(other.actions).toContain(
        `${second.hooksPath} already holds mdmem's entries`
      );
      expect(other.actions.some((a) => a.includes("review the new hook"))).toBe(
        false
      );
      expect(await readText(first.hooksPath)).toBe(hooks);
      expect(await readText(join(second.root, CODEX_CONFIG))).toBe(
        CODEX_SECTION
      );
    } finally {
      await Promise.all(
        [shared, first.root, second.root].map((dir) =>
          rm(dir, { recursive: true, force: true })
        )
      );
    }
  });

  test("disable --project removes the project's server and keeps the hook; disable in the global scope removes the hook too", async () => {
    // no CODEX_HOME: the hook goes in ~/.codex/hooks.json
    const { root, ctx, hooksPath } = await codexProject(undefined, {
      hooks: CODEX_HOOKS_TEXT,
      toml: CODEX_TOML,
    });
    try {
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(hooksPath)).not.toBe(CODEX_HOOKS_TEXT);

      const disabled = await wire(codexAdapter.disable(ctx, "project"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe(CODEX_TOML);
      expect(disabled.actions).toContain(
        `The hook in ${hooksPath} stays, and is now silent in this project, whose ${CODEX_CONFIG} no longer registers the mdmem server. \`mdmem disable codex\` removes it.`
      );
      const status = await codexAdapter.status(ctx);
      expect(
        projectEntries(status).map(({ file, present }) => [file, present])
      ).toEqual([
        [CODEX_CONFIG, false],
        [hooksPath, true],
      ]);

      const global = await wire(codexAdapter.disable(ctx, "global"));
      expect(await readText(hooksPath)).toBe(CODEX_HOOKS_TEXT);
      expect(global.actions.at(-1)).toBe(
        `The hook served the project scope too: in a repository whose ${CODEX_CONFIG} registers the mdmem server, Codex sessions now start without the memory until \`mdmem enable codex --project\` runs there again.`
      );
      const after = await codexAdapter.status(ctx);
      expect(
        after.scopes.flatMap(({ entries }) => entries).some((e) => e.present)
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("global enable registers the server in the user config.toml beside the hook, and the hook then speaks in a project with no config of its own; disable deletes files that held only mdmem's entries", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const codexHome = join(shared, "home");
    const { root, ctx, hooksPath } = await codexProject(codexHome);
    const userConfig = join(codexHome, "config.toml");
    try {
      const enabled = await wire(codexAdapter.enable(ctx, "global"));
      expect(await readText(userConfig)).toBe(CODEX_SECTION);
      expect(existsSync(hooksPath)).toBe(true);
      expect(existsSync(join(root, CODEX_CONFIG))).toBe(false);
      expect(enabled.actions.join("\n")).not.toContain("Commit");
      const status = await codexAdapter.status(ctx);
      expect(
        status.scopes.map((one) => [one.scope, one.wired, one.enabled])
      ).toEqual([
        ["global", true, true],
        ["project", false, false],
      ]);
      expect(status.problems).toEqual([]);

      const disabled = await wire(codexAdapter.disable(ctx, "global"));
      expect(disabled.actions.slice(0, 2)).toEqual([
        `deleted ${userConfig}: it held only mdmem's entries`,
        `deleted ${hooksPath}: it held only mdmem's entries`,
      ]);
      expect(existsSync(userConfig)).toBe(false);
      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("an unparseable .codex/config.toml is refused before the hook is written", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const { root, ctx, hooksPath } = await codexProject(join(shared, "home"), {
      toml: "model = \n",
    });
    try {
      const refused = codexAdapter.enable(ctx, "project");
      await expect(refused).rejects.toThrow(RefusalError);
      // One line, as the CLI prints a refusal: toml-patch's caret diagram is left out.
      await expect(refused).rejects.toThrow(
        `${CODEX_CONFIG} is not valid TOML (Error parsing TOML (1, 1): Expected value, reached EOF): fix it, then run the command again`
      );
      expect(existsSync(hooksPath)).toBe(false);
      expect(await readText(join(root, CODEX_CONFIG))).toBe("model = \n");
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("a server table and global hook group of mdmem's edited by hand count as wired, are kept by enable, and disable removes them", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const group = {
      hooks: CODEX_HOOK_GROUP.hooks.map((handler) => ({
        ...handler,
        timeout: 30,
      })),
    };
    const hooksText = `${JSON.stringify({ hooks: { SessionStart: [group] } }, null, 2)}\n`;
    const toml = `model = "x"\n\n${CODEX_SECTION}startup_timeout_sec = 30\nenv = { FOO = "bar" }\n`;
    const { root, ctx, hooksPath } = await codexProject(join(shared, "home"), {
      hooks: hooksText,
      toml,
    });
    try {
      expect(await wired(codexAdapter, ctx)).toBe(true);
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(hooksPath)).toBe(hooksText);
      expect(await readText(join(root, CODEX_CONFIG))).toBe(toml);

      await wire(codexAdapter.disable(ctx, "project"));
      await wire(codexAdapter.disable(ctx, "global"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe('model = "x"\n');
      expect(existsSync(hooksPath)).toBe(false);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("enable refuses a [mcp_servers.mdmem] with another command, naming the file and the table, before the hook is written", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const toml =
      '[mcp_servers.mdmem]\ncommand = "bun"\nargs = ["run", "/dev/mdmem/src/cli/index.ts", "mcp"]\n';
    const { root, ctx, hooksPath } = await codexProject(join(shared, "home"), {
      toml,
    });
    try {
      await expect(codexAdapter.enable(ctx, "project")).rejects.toThrow(
        new RefusalError(
          `${CODEX_CONFIG}: [mcp_servers.mdmem] holds a value that is not mdmem's, so mdmem will not overwrite it: remove or rename it, or set its command to "mdmem" and its args to ["mcp"], then run the command again`
        )
      );
      expect(existsSync(hooksPath)).toBe(false);
      expect(await readText(join(root, CODEX_CONFIG))).toBe(toml);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("enable appends the server in a CRLF config.toml's own line ending", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const crlf = 'model = "x"\r\n[a]\r\nb = 1\r\n';
    const { root, ctx } = await codexProject(join(shared, "home"), {
      toml: crlf,
    });
    try {
      await wire(codexAdapter.enable(ctx, "project"));
      expect(await readText(join(root, CODEX_CONFIG))).toBe(
        `${crlf}\r\n${CODEX_SECTION.replaceAll("\n", "\r\n")}`
      );
      expect(await wired(codexAdapter, ctx)).toBe(true);
    } finally {
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("enable adds the server to an inline mcp_servers table in place, and disable takes it out", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const inline = 'model = "x"\nmcp_servers = { other = { command = "o" } }\n';
    const { root, ctx } = await codexProject(join(shared, "home"), {
      toml: inline,
    });
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
      await Promise.all(
        [shared, root].map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  test("status reports a config.toml it cannot read as a problem, and a hooks.json only in a project wired for Codex", async () => {
    const shared = await realpath(
      await mkdtemp(join(tmpdir(), "mdmem-codex-"))
    );
    const { ctx, root, hooksPath } = await codexProject(join(shared, "home"), {
      hooks: "{ not json",
      toml: "model = \n",
    });
    const hooksUnreadable = `${hooksPath} is not valid JSON (JSON Parse error: Expected '}')`;
    try {
      const status = await codexAdapter.status(ctx);
      expect(status.enabled).toBe(false);
      // one line, as the refusal is
      expect(status.problems).toEqual([
        `Codex CLI: ${CODEX_CONFIG} is not valid TOML (Error parsing TOML (1, 1): Expected value, reached EOF): fix it, then run the check again`,
      ]);
      // the hooks file is user-wide: a project not wired for Codex only warns of it
      expect(status.warnings).toEqual([
        `${hooksUnreadable}: fix it, then run the command again`,
      ]);

      await writeFile(join(root, CODEX_CONFIG), CODEX_SECTION, "utf-8");
      const enabled = await codexAdapter.status(ctx);
      expect(enabled.problems).toEqual([
        `Codex CLI: ${hooksUnreadable}: fix it, then run the check again`,
      ]);
      expect(enabled.warnings).toEqual([]);
      // where CODEX_HOME cannot be known, the hooks file stays a warning
      const unknown = await codexAdapter.status({
        ...ctx,
        unknownEnv: ["CODEX_HOME"],
      });
      expect(unknown.problems).toEqual([]);
      expect(unknown.warnings).toEqual([
        `${hooksUnreadable}: fix it, then run the command again`,
      ]);

      const disabled = await wire(codexAdapter.disable(ctx, "project"));
      expect(disabled.warnings).toEqual([
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
      expect(existsSync(join(root, "codex-home/hooks.json"))).toBe(true);
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
      const hooksPath = join(tmp, "codex-home", "hooks.json");
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
          `  ${join(tmp, "codex-home", "config.toml")} holds none of mdmem's entries`,
          `  deleted ${hooksPath}: it held only mdmem's entries`,
          `  The hook served the project scope too: in a repository whose ${CODEX_CONFIG} registers the mdmem server, Codex sessions now start without the memory until \`mdmem enable codex --project\` runs there again.`,
          "",
        ].join("\n")
      );
      expect(existsSync(hooksPath)).toBe(false);
      expect(await readText(join(outside, CODEX_CONFIG))).toBe(toml);
      expect(existsSync(join(project, CODEX_CONFIG))).toBe(true);

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

  test("it speaks outside git without a store, naming the home store, and prints nothing on resume or fork, or for another event", async () => {
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
        for (const payload of [
          { ...startPayload(root), source: "resume" },
          { ...startPayload(root), source: "fork" },
          { cwd: root, hook_event_name: "UserPromptSubmit" },
        ]) {
          for (const part of HOOK_PARTS) {
            expect(runHookCli(root, part, payload)).toEqual({
              code: 0,
              out: "",
              err: "",
            });
          }
        }
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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

  test("Bob's and Codex's hooks inject both parts through the CLI, Codex's in a project whose .codex/config.toml registers the server, and nothing in a forked Codex session", async () => {
    await withCliProject(async (root, store) => {
      await seedMemories(store, 1);
      // Codex's hook speaks only where .codex/config.toml registers the server
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, CODEX_CONFIG), CODEX_SECTION, "utf-8");
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
      // the same project wired for Codex: a forked Codex session gets neither part
      const fork = { ...startPayload(root), source: "fork" };
      for (const part of HOOK_PARTS) {
        expect(runHookCli(root, part, fork, "codex")).toEqual({
          code: 0,
          out: "",
          err: "",
        });
      }
    });
  });

  test("a payload that does not parse is reported outside git too, and prints nothing in a project not wired for Codex", async () => {
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
      await withCliProject((root) => {
        expect(runHookCli(root, "index", "[]", "codex")).toEqual({
          code: 0,
          out: "",
          err: "",
        });
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("Codex's global hook prints nothing in a project whose .codex/config.toml does not register the mdmem server", async () => {
    await withCliProject(async (root) => {
      expect(runHookCli(root, "protocol", startPayload(root), "codex")).toEqual(
        { code: 0, out: "", err: "" }
      );

      await mkdir(join(root, ".codex"));
      await writeFile(
        join(root, CODEX_CONFIG),
        '[mcp_servers.mdmem]\ncommand = "mdmem"\nargs = ["mcp"]\n',
        "utf-8"
      );
      const hook = runHookCli(root, "protocol", startPayload(root), "codex");
      expect(hook.code).toBe(0);
      expect(injected(hook.out)).toBe(getMemoryProtocol(join(root, ".mdmem")));

      // a server table the user extended still registers the server
      await writeFile(
        join(root, CODEX_CONFIG),
        '[mcp_servers.mdmem]\ncommand = "mdmem"\nargs = ["mcp"]\nstartup_timeout_sec = 20\n',
        "utf-8"
      );
      const extended = runHookCli(
        root,
        "protocol",
        startPayload(root),
        "codex"
      );
      expect(injected(extended.out)).toBe(
        getMemoryProtocol(join(root, ".mdmem"))
      );

      // disable keeps a table that is not mdmem's own (another command), so the hook is not called silent
      const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex") };
      expect(runCliWith(root, ["enable", "codex", "--project"], env).code).toBe(
        0
      );
      await writeFile(
        join(root, CODEX_CONFIG),
        '[mcp_servers.mdmem]\ncommand = "mdmem-dev"\nargs = ["mcp"]\n',
        "utf-8"
      );
      const disable = runCliWith(root, ["disable", "codex", "--project"], env);
      expect(disable.out).toBe(
        `Codex CLI:\n  ${CODEX_CONFIG} holds none of mdmem's entries\n  The hook in ${join(root, "codex", "hooks.json")} stays. \`mdmem disable codex\` removes it.\n`
      );
    });
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
        "Codex CLI reads .codex/config.toml only in a trusted folder, and runs the hook only once you have reviewed it: mdmem does not check either.",
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
        `IBM Bob reads .bob/settings.json (the session-start hooks) and .bob/mcp.json (the mdmem MCP server) only from its workspace, the folder it is launched in: launched here, below ${root}, it gets no memory protocol, no index and no mdmem tools. Launch Bob at ${root}.`,
      ]);
      // where status runs is not a problem with the project
      expect(await checkProject(below)).toMatchObject({ problems: [] });
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
      const warning = `Claude Code reads .claude/settings.json only from the folder it is started in: started here, below ${root}, it runs neither mdmem hook, so its sessions start without the memory protocol and the index, and it applies neither the project's autoMemoryEnabled: false nor its permission for the mdmem tools. Start Claude Code at ${root}, or run \`mdmem enable claude-code\` to wire it in every folder.`;
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

  test("the check reports hooks that will not run: an entry missing, Claude Code's and Bob's hooks off, Codex's global hook missing", async () => {
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
      const hooksPath = join(ctx.env.CODEX_HOME ?? "", "hooks.json");
      await rm(hooksPath);

      expect(await projectProblems(ctx)).toEqual([
        'Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (.claude/settings.json), so its sessions start without what that hook injects — run `mdmem enable claude-code --project`',
        "Claude Code: .claude/settings.json sets disableAllHooks to true, so Claude Code runs no hooks and its sessions start without the memory protocol and the index — remove it",
        "IBM Bob: .bob/settings.json sets disableWorkspaceHooks to true, so Bob runs none of the workspace's hooks and its sessions start without the memory protocol and the index — remove it",
        `Codex CLI: missing SessionStart hooks "mdmem hook codex protocol", "mdmem hook codex index" (${hooksPath}), so its sessions start without what those hooks inject — run \`mdmem enable codex --project\``,
      ]);
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
        `Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (${CLAUDE_SETTINGS}), SessionStart hook "mdmem hook claude-code index" (${CLAUDE_SETTINGS}), so its sessions start without what those hooks inject — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
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
          `  - Claude Code: missing SessionStart hook "mdmem hook claude-code protocol" (${CLAUDE_SETTINGS}), SessionStart hook "mdmem hook claude-code index" (${CLAUDE_SETTINGS}), so its sessions start without what those hooks inject — fix ${MCP_CONFIG}, then run \`mdmem enable claude-code --project\``,
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

  test("a project at the home directory reports Claude Code's settings it cannot read once, as the project's", async () => {
    await withWiredRepo(async ({ root, ctx }) => {
      await writeFile(join(root, CLAUDE_SETTINGS), "{ broken", "utf-8");
      const atHome = {
        ...ctx,
        home: root,
        env: { ...ctx.env, CLAUDE_CONFIG_DIR: undefined },
      };
      const status = await claudeCodeAdapter.status(atHome);
      expect(status.problems).toEqual([
        `Claude Code: ${CLAUDE_SETTINGS} is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again`,
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
        "mdmem is not on PATH, so the session-start hooks and the MCP server wired for Claude Code, IBM Bob, Codex CLI, which run `mdmem`, fail — put it on PATH (`bun link` in mdmem's checkout)",
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
  test("in a repository with no store, reads refuse, the hooks speak with the index naming the home store, and the first add creates it, importing Claude Code's memories once", async () => {
    await withFreshRepo(async ({ root, home, env }) => {
      const dir = join(home, ".mdmem", projectKey(root));
      const read = runCliWith(root, ["read", "MEMORY.md"], env);
      expect(read.code).toBe(1);
      expect(read.err).toBe(
        `mdmem: No store for this project yet: the first memory write (memory_write, \`mdmem add\`) creates the home store ${dir}\n`
      );

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
      expect(await store.view("MEMORY.md")).toContain("(uses-bun.md)");
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
        `${none}\nFound 1 problem(s):\n  - mdmem is not on PATH, so the session-start hooks and the MCP server wired for IBM Bob, which run \`mdmem\`, fail — put it on PATH (\`bun link\` in mdmem's checkout)\n`
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
        `Store: none yet; the first save creates the home store ${dir}\nCheck: ✓ no problems\n`
      );
      for (const title of ["Claude Code", "IBM Bob", "Codex CLI"]) {
        expect(status.out).toContain(`  ✓ ${title} (global)\n`);
        expect(status.out).toContain(`  ✓ ${title} (project)\n`);
      }

      // the global entries stay silent beside the project's own; Codex has one hook
      const payload = startPayload(root);
      for (const agent of ["claude-code", "bob"]) {
        for (const part of HOOK_PARTS) {
          expect(
            runHookCli(root, part, payload, agent, env, ["--global"]).out
          ).toBe("");
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
      expect(runCliWith(root, addArgs("a"), env).out).toBe("Saved a.md\n");
      expect(existsSync(join(local, "a.md"))).toBe(true);
      expect(existsSync(join(home, ".mdmem"))).toBe(false);
    });
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
