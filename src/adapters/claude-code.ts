import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookPart } from "../core/hook.ts";
import {
  formatImport,
  importClaudeMemories,
  importMarker,
} from "../core/import.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  EnableOptions,
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

const TITLE = "Claude Code";

// Claude Code is wired through files committed with the repository (ADR 0003): its
// auto memory off, two session-start hooks injecting the protocol and the index, and
// the mdmem MCP server with permission for its tools.
const SETTINGS = ".claude/settings.json";
const MCP_CONFIG = ".mcp.json";
// A new session, /clear and compaction; never a resume, which already holds the injection.
const HOOK_MATCHER = "startup|clear|compact";
const SERVER = { type: "stdio", command: "mdmem", args: ["mcp"] };
const TOOLS_PERMISSION = "mcp__mdmem";

function hookEntry(part: HookPart) {
  const command = `mdmem hook claude-code ${part}`;
  return arrayItemEntry(
    `SessionStart hook "${command}"`,
    ["hooks", "SessionStart"],
    { matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] }
  );
}

const FILES: readonly JsonConfigFile[] = [
  {
    file: SETTINGS,
    entries: [
      valueEntry("autoMemoryEnabled: false", ["autoMemoryEnabled"], false),
      ...HOOK_PARTS.map(hookEntry),
      arrayItemEntry(
        `permissions.allow "${TOOLS_PERMISSION}"`,
        ["permissions", "allow"],
        TOOLS_PERMISSION
      ),
    ],
  },
  {
    file: MCP_CONFIG,
    entries: [valueEntry("mcpServers.mdmem", ["mcpServers", "mdmem"], SERVER)],
  },
];

/**
 * Import Claude's memories unless this user already did for the repository: the
 * import runs once, so a later enable neither refuses again over files settled with
 * --prefer nor brings back a memory deleted since. Returns the report and warnings.
 */
async function importOnce(
  ctx: AdapterContext,
  options: EnableOptions
): Promise<{ lines: string[]; warnings: string[]; record?: string }> {
  const environment = { env: ctx.env, home: ctx.home };
  const marker = await importMarker(ctx.store, environment);
  if (existsSync(marker)) {
    const text = await readFile(marker, "utf-8");
    const recorded = text.trim();
    return {
      lines: [
        `Claude Code's memories were already imported (${recorded || marker}): skipped the import.`,
      ],
      warnings: [],
    };
  }
  const result = await importClaudeMemories(ctx.store, {
    ...environment,
    prefer: options.prefer,
  });
  return {
    lines: formatImport(result),
    warnings: result.warnings,
    // Nothing to remember when Claude held no memories for the repository.
    record: result.sources.length > 0 ? marker : undefined,
  };
}

export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  title: TITLE,

  async enable(
    ctx: AdapterContext,
    options: EnableOptions
  ): Promise<WiringResult> {
    // Read every file first, so an unparseable one is refused before the import writes.
    const plan = await planConfigs(ctx.projectRoot, FILES, "add");
    const imported = await importOnce(ctx, options);
    // Recorded before the config files, so a failed write leaves the import done once.
    if (imported.record !== undefined) {
      await mkdir(dirname(imported.record), { recursive: true });
      await writeFile(
        imported.record,
        `${new Date().toISOString()} into ${ctx.store.root}\n`,
        "utf-8"
      );
    }
    await writeConfigs(plan);
    return {
      title: TITLE,
      actions: [
        ...imported.lines,
        ...describePlan(plan, "add"),
        `Commit ${SETTINGS} and ${MCP_CONFIG}: they wire Claude Code for everyone working in the repository, who then needs mdmem on PATH.`,
      ],
      warnings: imported.warnings,
    };
  },

  async disable(ctx: AdapterContext): Promise<WiringResult> {
    const plan = await planConfigs(ctx.projectRoot, FILES, "remove");
    await writeConfigs(plan);
    return {
      title: TITLE,
      actions: [
        ...describePlan(plan, "remove"),
        "The memories imported from Claude Code stay in the store.",
      ],
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
