import { realpath } from "node:fs/promises";

import { HOOK_PARTS } from "../core/hook.ts";
import { missingHooksProblem } from "./adapter.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  WiringResult,
} from "./adapter.ts";
import {
  arrayItemEntry,
  configStatus,
  configValue,
  describePlan,
  planConfigs,
  valueEntry,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile } from "./json-config.ts";

const ID = "bob";
const TITLE = "IBM Bob";

// IBM Bob is wired through workspace files committed with the repository (ADR 0003):
// two session-start hooks injecting the protocol and the index, and the mdmem MCP
// server. Bob runs both only in a trusted folder, and reads .bob/settings.json and
// .bob/mcp.json only from the workspace it was launched in: launched below the
// checkout's root, it has no memory wiring at all.
const SETTINGS = ".bob/settings.json";
const MCP_CONFIG = ".bob/mcp.json";
// Bob's matcher is an unanchored regex on the payload's source (startup, resume or
// compact): a new session and compaction, never a resume, which already holds the
// injection.
const HOOK_MATCHER = "^(startup|compact)$";
// Bob's default, in seconds.
const HOOK_TIMEOUT = 10;
const SERVER = { command: "mdmem", args: ["mcp"] };

const commands = HOOK_PARTS.map((part) => `mdmem hook bob ${part}`);

// Bob validates its hooks strictly: one unknown key voids the whole hooks block, so
// the group holds only documented fields.
const HOOK_GROUP = {
  matcher: HOOK_MATCHER,
  hooks: commands.map((command) => ({
    type: "command",
    command,
    timeout: HOOK_TIMEOUT,
  })),
};

const HOOK_ENTRY = arrayItemEntry(
  `SessionStart hooks ${commands.map((command) => `"${command}"`).join(", ")}`,
  ["hooks", "SessionStart"],
  HOOK_GROUP
);

const FILES: readonly JsonConfigFile[] = [
  {
    file: SETTINGS,
    entries: [HOOK_ENTRY],
  },
  {
    file: MCP_CONFIG,
    entries: [valueEntry("mcpServers.mdmem", ["mcpServers", "mdmem"], SERVER)],
  },
];

/** `disableWorkspaceHooks: true` in the workspace settings drops every workspace hook, mdmem's included. */
async function disabledHooksProblem(ctx: AdapterContext): Promise<string[]> {
  const disabled = await configValue(ctx.projectRoot, SETTINGS, [
    "disableWorkspaceHooks",
  ]);
  return disabled === true
    ? [
        `${TITLE}: ${SETTINGS} sets disableWorkspaceHooks to true, so Bob runs none of the workspace's hooks and its sessions start without the memory protocol and the index — remove it`,
      ]
    : [];
}

/** The real path of `path`, or `path` itself when it cannot be resolved. */
async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Run below the checkout's root, where a Bob launched here reads none of the workspace files. */
async function belowRootWarning(ctx: AdapterContext): Promise<string[]> {
  const [cwd, root] = await Promise.all([
    realOr(ctx.cwd),
    realOr(ctx.projectRoot),
  ]);
  return cwd === root
    ? []
    : [
        `${TITLE} reads ${SETTINGS} (the session-start hooks) and ${MCP_CONFIG} (the mdmem MCP server) only from its workspace, the folder it is launched in: launched here, below ${root}, it gets no memory protocol, no index and no mdmem tools. Launch Bob at ${root}.`,
      ];
}

export const bobAdapter: Adapter = {
  id: ID,
  command: "bob",
  configDir: ".bob",
  title: TITLE,

  async enable(ctx: AdapterContext): Promise<WiringResult> {
    const plan = await planConfigs(ctx.projectRoot, FILES, "add");
    await writeConfigs(plan);
    return {
      title: TITLE,
      actions: [
        ...describePlan(plan, "add"),
        `Commit ${SETTINGS} and ${MCP_CONFIG}: they wire IBM Bob for everyone working in the repository, who then needs mdmem on PATH. Bob runs them only in a trusted folder, and reads them only when launched at the checkout's root: launched in a subdirectory it gets neither the hooks nor the mdmem tools.`,
      ],
      warnings: [],
    };
  },

  async disable(ctx: AdapterContext): Promise<WiringResult> {
    const plan = await planConfigs(ctx.projectRoot, FILES, "remove");
    await writeConfigs(plan);
    return {
      title: TITLE,
      actions: describePlan(plan, "remove"),
      warnings: [],
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const { entries, warnings } = await configStatus(ctx.projectRoot, FILES);
    const enabled = entries.some(({ present }) => present);
    if (!enabled) {
      return {
        title: TITLE,
        wired: false,
        enabled,
        entries,
        problems: [],
        warnings,
        notes: [],
      };
    }
    const [disabledHooks, belowRoot] = await Promise.all([
      disabledHooksProblem(ctx),
      belowRootWarning(ctx),
    ]);
    return {
      title: TITLE,
      wired: entries.every(({ present }) => present),
      enabled,
      entries,
      problems: [
        ...missingHooksProblem(
          { id: ID, title: TITLE },
          entries,
          ({ label }) => (label === HOOK_ENTRY.label ? HOOK_PARTS.length : 0)
        ),
        ...disabledHooks,
      ],
      warnings: [...warnings, ...belowRoot],
      notes: [
        `${TITLE} runs workspace hooks and MCP servers only in a trusted folder: mdmem does not check whether this one is.`,
      ],
    };
  },
};
