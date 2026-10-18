import { HOOK_PARTS } from "../core/hook.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  WiringResult,
} from "./adapter.ts";
import {
  arrayItemEntry,
  configStatus,
  describePlan,
  planConfigs,
  valueEntry,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile } from "./json-config.ts";

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

const FILES: readonly JsonConfigFile[] = [
  {
    file: SETTINGS,
    entries: [
      arrayItemEntry(
        `SessionStart hooks ${commands.map((command) => `"${command}"`).join(", ")}`,
        ["hooks", "SessionStart"],
        HOOK_GROUP
      ),
    ],
  },
  {
    file: MCP_CONFIG,
    entries: [valueEntry("mcpServers.mdmem", ["mcpServers", "mdmem"], SERVER)],
  },
];

export const bobAdapter: Adapter = {
  id: "bob",
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
    return {
      title: TITLE,
      wired: entries.every(({ present }) => present),
      entries,
      warnings,
    };
  },
};
