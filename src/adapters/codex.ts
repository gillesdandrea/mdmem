import { join, resolve } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  DisableOptions,
  WiringResult,
} from "./adapter.ts";
import {
  arrayItemEntry,
  configStatus,
  describePlan,
  planConfigs,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile } from "./json-config.ts";
import { planTomlTable, tomlTableStatus } from "./toml-config.ts";
import type { TomlTableEntry } from "./toml-config.ts";

const TITLE = "Codex CLI";

// Codex CLI's session-start hook is global (ADR 0003): Codex pins a hook's approval
// to the absolute path of the file declaring it, so a hook in each worktree's
// .codex/hooks.json would need approving in every worktree, while one in
// $CODEX_HOME/hooks.json is approved once. mdmem hook prints nothing outside a
// project with a store, so the global hook is silent elsewhere. The mdmem MCP
// server is registered per project, in .codex/config.toml committed with the
// repository, which Codex reads only in a trusted folder.
const MCP_CONFIG = ".codex/config.toml";
// Seconds; Codex's default is 600.
const HOOK_TIMEOUT = 10;

const commands = HOOK_PARTS.map((part) => `mdmem hook codex ${part}`);

// No matcher: mdmem hook skips a resumed session itself. additionalContextLimit 0
// lifts Codex's cap of about 2,500 tokens per context, past which it replaces the
// context with a preview and a temp-file path.
const HOOK_GROUP = {
  hooks: commands.map((command) => ({
    type: "command",
    command,
    timeout: HOOK_TIMEOUT,
    additionalContextLimit: 0,
  })),
};

const SERVER_ENTRY: TomlTableEntry = {
  label: "[mcp_servers.mdmem]",
  file: MCP_CONFIG,
  path: ["mcp_servers", "mdmem"],
  value: { command: "mdmem", args: ["mcp"] },
};

/** Codex's home: CODEX_HOME when set, else ~/.codex. */
function codexHome(ctx: AdapterContext): string {
  const fromEnv = ctx.env.CODEX_HOME;
  return fromEnv === undefined || fromEnv === ""
    ? join(ctx.home, ".codex")
    : resolve(fromEnv);
}

/** The user-wide hooks file, by its absolute path. */
function hooksFile(ctx: AdapterContext): JsonConfigFile {
  return {
    file: join(codexHome(ctx), "hooks.json"),
    entries: [
      arrayItemEntry(
        `SessionStart hooks ${commands.map((command) => `"${command}"`).join(", ")}`,
        ["hooks", "SessionStart"],
        HOOK_GROUP
      ),
    ],
  };
}

export const codexAdapter: Adapter = {
  id: "codex",
  title: TITLE,

  async enable(ctx: AdapterContext): Promise<WiringResult> {
    // Plan both files before writing either, so an unparseable one refuses with nothing written.
    const file = hooksFile(ctx);
    const hooks = await planConfigs(ctx.projectRoot, [file], "add");
    const server = await planTomlTable(ctx.projectRoot, SERVER_ENTRY, "add");
    const plan = [...hooks, server];
    await writeConfigs(plan);
    const review = hooks.some(({ changed }) => changed.length > 0)
      ? [
          `Codex asks you once to review the new hook in ${file.file}, at its next start or in /hooks: trust it, and it runs in every project, printing nothing outside a project with a store.`,
        ]
      : [];
    return {
      title: TITLE,
      actions: [
        ...describePlan(plan, "add"),
        ...review,
        `Commit ${MCP_CONFIG}: it registers the mdmem MCP server for everyone working in the repository, who then needs mdmem on PATH. Codex reads it only in a trusted folder.`,
      ],
      warnings: [],
    };
  },

  async disable(
    ctx: AdapterContext,
    options: DisableOptions
  ): Promise<WiringResult> {
    const file = hooksFile(ctx);
    const hooks = options.global
      ? await planConfigs(ctx.projectRoot, [file], "remove")
      : [];
    const server = await planTomlTable(ctx.projectRoot, SERVER_ENTRY, "remove");
    const plan = [server, ...hooks];
    await writeConfigs(plan);
    const kept: string[] = [];
    const warnings: string[] = [];
    if (!options.global) {
      const { entries, warnings: unread } = await configStatus(
        ctx.projectRoot,
        [file]
      );
      warnings.push(...unread);
      if (entries.some(({ present }) => present)) {
        kept.push(
          `The global hook in ${file.file} stays: it prints nothing outside a project with a store. \`mdmem disable codex --global\` removes it.`
        );
      }
    }
    return {
      title: TITLE,
      actions: [...describePlan(plan, "remove"), ...kept],
      warnings,
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const server = await tomlTableStatus(ctx.projectRoot, SERVER_ENTRY);
    const hooks = await configStatus(ctx.projectRoot, [hooksFile(ctx)]);
    const entries = [
      { label: SERVER_ENTRY.label, file: MCP_CONFIG, present: server.present },
      ...hooks.entries,
    ];
    return {
      title: TITLE,
      wired: entries.every(({ present }) => present),
      entries,
      warnings: [
        ...(server.warning === undefined ? [] : [server.warning]),
        ...hooks.warnings,
      ],
    };
  },
};
