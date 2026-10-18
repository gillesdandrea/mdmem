import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookPart } from "../core/hook.ts";
import {
  formatImport,
  importMarker,
  planClaudeImport,
} from "../core/import.ts";
import { missingHooksProblem, outsideProjectPlan } from "./adapter.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  DisableOptions,
  EnableOptions,
  WiringPlan,
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

const ID = "claude-code";
const TITLE = "Claude Code";

// Claude Code is wired through files committed with the repository (ADR 0003): its
// auto memory off, two session-start hooks injecting the protocol and the index, and
// the mdmem MCP server with permission for its tools.
const SETTINGS = ".claude/settings.json";
// The user's own project settings, which override the committed ones.
const SETTINGS_LOCAL = ".claude/settings.local.json";
const MCP_CONFIG = ".mcp.json";
// A new session, /clear and compaction; never a resume, which already holds the injection.
const HOOK_MATCHER = "startup|clear|compact";
const SERVER = { type: "stdio", command: "mdmem", args: ["mcp"] };
const TOOLS_PERMISSION = "mcp__mdmem";
const AUTO_MEMORY_KEY = "autoMemoryEnabled";
const AUTO_MEMORY_LABEL = `${AUTO_MEMORY_KEY}: false`;
// A true value turns auto memory off whatever the settings say, a false one forces it
// on; Claude Code reads the value trimmed, ignoring case (verified in Claude Code 2.1.302).
const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const ENV_TRUE = new Set(["1", "true", "yes", "on"]);
const ENV_FALSE = new Set(["0", "false", "no", "off"]);
const DISABLE_HOOKS_KEY = "disableAllHooks";

function hookEntry(part: HookPart) {
  const command = `mdmem hook claude-code ${part}`;
  return arrayItemEntry(
    `SessionStart hook "${command}"`,
    ["hooks", "SessionStart"],
    { matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] }
  );
}

const HOOK_ENTRIES = HOOK_PARTS.map(hookEntry);
const HOOK_LABELS = new Set(HOOK_ENTRIES.map(({ label }) => label));

const FILES: readonly JsonConfigFile[] = [
  {
    file: SETTINGS,
    entries: [
      valueEntry(AUTO_MEMORY_LABEL, [AUTO_MEMORY_KEY], false),
      ...HOOK_ENTRIES,
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

/** The import's report and warnings, once written, and the marker to record when it imported something. */
interface ImportOutcome {
  lines: string[];
  warnings: string[];
  record?: string;
}

/**
 * Plan importing Claude's memories unless this user already did for the
 * repository: the import runs once, so a later enable neither refuses again over
 * files settled with --prefer nor brings back a memory deleted since. A conflict
 * refuses here, before anything is written.
 */
async function planImportOnce(
  ctx: AdapterContext,
  options: EnableOptions
): Promise<() => Promise<ImportOutcome>> {
  const environment = { env: ctx.env, home: ctx.home };
  const marker = await importMarker(ctx.store, environment);
  if (existsSync(marker)) {
    const text = await readFile(marker, "utf-8");
    const recorded = text.trim();
    const when = recorded === "" ? "" : ` (${recorded})`;
    const prefer =
      options.prefer === undefined
        ? ""
        : `, so --prefer ${options.prefer} was not used`;
    const outcome: ImportOutcome = {
      lines: [
        `Claude Code's memories were already imported${when}: skipped the import${prefer}. To import again, delete ${marker} and run \`mdmem enable ${ID}\` again.`,
      ],
      warnings: [],
    };
    return () => Promise.resolve(outcome);
  }
  const write = await planClaudeImport(ctx.store, {
    ...environment,
    prefer: options.prefer,
  });
  return async () => {
    const result = await write();
    return {
      lines: formatImport(result),
      warnings: result.warnings,
      // Nothing to remember when Claude held no memories for the repository.
      record: result.sources.length > 0 ? marker : undefined,
    };
  };
}

/** Claude Code's user settings file, in its config directory. */
function userSettings(ctx: AdapterContext): string {
  return join(
    ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, ".claude"),
    "settings.json"
  );
}

/**
 * A setting as Claude Code reads it first: in the local project settings, then the
 * committed ones, then the user's, with the file that sets it; undefined when none
 * does. Managed settings and --settings are not read.
 */
async function claudeSetting(
  ctx: AdapterContext,
  key: string
): Promise<{ file: string; value: unknown } | undefined> {
  const files = [SETTINGS_LOCAL, SETTINGS, userSettings(ctx)];
  const values = await Promise.all(
    files.map((file) => configValue(ctx.projectRoot, file, [key]))
  );
  const first = values.findIndex((value) => value !== undefined);
  const file = files[first];
  return file === undefined ? undefined : { file, value: values[first] };
}

/**
 * Claude Code's auto memory still on, which makes Claude save to its own directory
 * beside the store: forced on by the environment, or autoMemoryEnabled not false
 * where Claude Code reads it first.
 */
async function autoMemoryProblem(ctx: AdapterContext): Promise<string[]> {
  const on = "Claude Code's auto memory is on";
  const consequence =
    "so Claude also saves memories to its own directory, which no other agent reads";
  const forced = ctx.env[AUTO_MEMORY_ENV]?.trim().toLowerCase();
  if (forced !== undefined && ENV_FALSE.has(forced)) {
    return [
      `${on}: ${AUTO_MEMORY_ENV}=${ctx.env[AUTO_MEMORY_ENV]} in the environment forces it on, ${consequence} — unset it`,
    ];
  }
  if (forced !== undefined && ENV_TRUE.has(forced)) {
    return [];
  }
  const setting = await claudeSetting(ctx, AUTO_MEMORY_KEY);
  if (setting?.value === false) {
    return [];
  }
  if (setting?.file === SETTINGS_LOCAL) {
    return [
      `${on}: ${SETTINGS_LOCAL} sets ${AUTO_MEMORY_KEY} to ${JSON.stringify(setting.value)}, overriding ${SETTINGS}, ${consequence} — remove it from ${SETTINGS_LOCAL}`,
    ];
  }
  return [
    `${on}: ${AUTO_MEMORY_KEY} is not false in ${SETTINGS}, ${consequence} — run \`mdmem enable claude-code\``,
  ];
}

/** `disableAllHooks: true` where Claude Code reads it first drops every hook, mdmem's included. */
async function disabledHooksProblem(ctx: AdapterContext): Promise<string[]> {
  const setting = await claudeSetting(ctx, DISABLE_HOOKS_KEY);
  return setting?.value === true
    ? [
        `${TITLE}: ${setting.file} sets ${DISABLE_HOOKS_KEY} to true, so Claude Code runs no hooks and its sessions start without the memory protocol and the index — remove it`,
      ]
    : [];
}

export const claudeCodeAdapter: Adapter = {
  id: ID,
  command: "claude",
  configDir: ".claude",
  title: TITLE,

  async enable(
    ctx: AdapterContext,
    options: EnableOptions
  ): Promise<WiringPlan> {
    // Read every file and plan the import, so an unparseable file or an import conflict refuses before anything is written.
    const plan = await planConfigs(ctx.projectRoot, FILES, "add");
    const importOnce = await planImportOnce(ctx, options);
    return {
      write: async () => {
        const imported = await importOnce();
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
    };
  },

  async disable(
    ctx: AdapterContext,
    options: DisableOptions
  ): Promise<WiringPlan> {
    if (options.outsideProject) {
      return outsideProjectPlan(TITLE);
    }
    const plan = await planConfigs(ctx.projectRoot, FILES, "remove");
    return {
      write: async () => {
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
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const { entries, warnings } = await configStatus(ctx.projectRoot, FILES);
    // autoMemoryEnabled: false alone may be the user's own choice, not mdmem's wiring.
    const enabled = entries.some(
      ({ label, present }) => present && label !== AUTO_MEMORY_LABEL
    );
    const problems = enabled
      ? [
          ...missingHooksProblem(
            { id: ID, title: TITLE },
            entries,
            ({ label }) => (HOOK_LABELS.has(label) ? 1 : 0)
          ),
          ...(await disabledHooksProblem(ctx)),
          ...(await autoMemoryProblem(ctx)),
        ]
      : [];
    return {
      title: TITLE,
      wired: entries.every(({ present }) => present),
      enabled,
      entries,
      problems,
      warnings,
      notes: enabled
        ? [
            `Claude Code runs the project's hooks only in a folder whose trust dialog you accepted, and connects the ${MCP_CONFIG} server only once you approve it: mdmem does not check either.`,
          ]
        : [],
    };
  },
};
