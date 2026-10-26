import { dirname, join, resolve } from "node:path";

import { mainCheckoutRoot, workTreeRoot } from "../core/git.ts";
import { HOOK_PARTS } from "../core/hook.ts";
import type { HookPart, HookSite, HookVerdict } from "../core/hook.ts";
import {
  claudeConfigDir,
  claudeProjectDir,
  formatImport,
  importMarker,
  planClaudeImport,
  readImportMarker,
  writeImportMarker,
} from "../core/import.ts";
import { isObject } from "../core/object.ts";
import { realDir } from "../core/store.ts";
import {
  agentStatus,
  commitLine,
  enableAdvice,
  globalSilence,
  hookCommand,
  hooksLabel,
  MCP_SERVER,
  MCP_SERVER_IDENTITY,
  missingHooksProblem,
  outsideProjectPlan,
  projectOf,
  rootAbove,
  rootOf,
  scopeStatus,
  wiredProject,
} from "./adapter.ts";
import type {
  AdapterContext,
  AdapterFor,
  AgentStatus,
  ImportContext,
  PlannedMemoryImport,
  ProjectContext,
  Scope,
  UnreadableFile,
  UserContext,
  WiringEntry,
  WiringPlan,
} from "./adapter.ts";
import {
  arrayItemEntry,
  hookGroupEntry,
  configDocument,
  configStatus,
  describePlan,
  planConfigs,
  valueEntry,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile, JsonEntry, JsonObject } from "./json-config.ts";

const ID = "claude-code";
const TITLE = "Claude Code";

// Claude Code is wired in either scope (ADR 0004): its auto memory off, two
// session-start hooks injecting the protocol and the index, and the mdmem MCP server
// with permission for its tools. The global scope writes its user settings and the
// user config holding its user-scope servers; the project scope, files committed
// with the repository (ADR 0003).
const SETTINGS = ".claude/settings.json";
// The user's own project settings, which override the committed ones.
const SETTINGS_LOCAL = ".claude/settings.local.json";
const MCP_CONFIG = ".mcp.json";
// Claude Code's user config: in CLAUDE_CONFIG_DIR when set, else in the home directory.
const USER_CONFIG = ".claude.json";
// A new session, /clear and compaction; never a resume, which already holds the injection.
const HOOK_MATCHER = "startup|clear|compact";
const SERVER = { type: "stdio", ...MCP_SERVER };
const TOOLS_PERMISSION = "mcp__mdmem";
const AUTO_MEMORY_KEY = "autoMemoryEnabled";
const AUTO_MEMORY_LABEL = `${AUTO_MEMORY_KEY}: false`;
// A true value turns auto memory off whatever the settings say, a false one forces it
// on; Claude Code reads the value trimmed, ignoring case (verified in Claude Code 2.1.302).
const AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const ENV_TRUE = new Set(["1", "true", "yes", "on"]);
const ENV_FALSE = new Set(["0", "false", "no", "off"]);
const DISABLE_HOOKS_KEY = "disableAllHooks";

/** The hook entry injecting `part`, the global scope's marked with `--global`. */
function hookEntry(part: HookPart, global: boolean): JsonEntry {
  const command = hookCommand(ID, part, global);
  return hookGroupEntry(hooksLabel([command]), ["hooks", "SessionStart"], {
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command }],
  });
}

const PROJECT_HOOKS = HOOK_PARTS.map((part) => hookEntry(part, false));
const GLOBAL_HOOKS = HOOK_PARTS.map((part) => hookEntry(part, true));
const HOOK_LABELS = new Set(
  [...PROJECT_HOOKS, ...GLOBAL_HOOKS].map(({ label }) => label)
);

/** The entries of a settings file: auto memory off, the hooks, and the tools' permission. */
function settingsEntries(hooks: readonly JsonEntry[]): JsonEntry[] {
  return [
    valueEntry(AUTO_MEMORY_LABEL, [AUTO_MEMORY_KEY], false),
    ...hooks,
    arrayItemEntry(
      `permissions.allow "${TOOLS_PERMISSION}"`,
      ["permissions", "allow"],
      TOOLS_PERMISSION
    ),
  ];
}

const SERVER_ENTRY = valueEntry(
  "mcpServers.mdmem",
  ["mcpServers", "mdmem"],
  SERVER,
  MCP_SERVER_IDENTITY
);

const PROJECT_FILES: readonly JsonConfigFile[] = [
  { file: SETTINGS, entries: settingsEntries(PROJECT_HOOKS) },
  { file: MCP_CONFIG, entries: [SERVER_ENTRY] },
];

/** Claude Code's user settings file, in its config directory. */
function userSettings(ctx: UserContext): string {
  return join(claudeConfigDir(ctx), "settings.json");
}

/** Claude Code's user config, whose top-level mcpServers are its user-scope servers. */
function userConfig({ env, home }: UserContext): string {
  return join(env.CLAUDE_CONFIG_DIR || home, USER_CONFIG);
}

/** The global scope's files, by their absolute paths. */
function globalFiles(ctx: UserContext): JsonConfigFile[] {
  return [
    { file: userSettings(ctx), entries: settingsEntries(GLOBAL_HOOKS) },
    { file: userConfig(ctx), entries: [SERVER_ENTRY] },
  ];
}

/** The scope's files, and the directory relative ones resolve against. */
function scopeFiles(
  ctx: AdapterContext,
  scope: Scope
): { root: string; files: readonly JsonConfigFile[] } {
  return scope === "global"
    ? { root: rootOf(ctx), files: globalFiles(ctx) }
    : { root: projectOf(ctx).root, files: PROJECT_FILES };
}

/** A settings file Claude Code reads, as read: its document, or why it cannot be read. */
interface SettingsFile {
  file: string;
  read: { doc: JsonObject } | { unreadable: UnreadableFile };
}

/**
 * Claude Code's settings files in the order it reads a setting: the local project
 * settings, then the committed ones, then the user's; the user's alone outside a
 * project. A project file that is the user's own, as `~/.claude/settings.json` is at
 * the home directory by default, is read once, as the user's. Managed settings and
 * --settings are not read.
 */
function readSettings(ctx: AdapterContext): Promise<SettingsFile[]> {
  const user = userSettings(ctx);
  const project = ctx.project === undefined ? [] : [SETTINGS_LOCAL, SETTINGS];
  const files = [
    ...project.filter((file) => resolve(rootOf(ctx), file) !== resolve(user)),
    user,
  ];
  return Promise.all(
    files.map(async (file) => ({
      file,
      read: await configDocument(rootOf(ctx), file),
    }))
  );
}

/**
 * A setting as Claude Code reads it first, with the file that sets it; undefined
 * when none does, and "unknown" when a file read before the one setting it cannot
 * be read, which the check reports in place of the setting.
 */
function claudeSetting(
  settings: readonly SettingsFile[],
  key: string
): { file: string; value: unknown } | "unknown" | undefined {
  for (const { file, read } of settings) {
    if ("unreadable" in read) {
      return "unknown";
    }
    const value = read.doc[key];
    if (value !== undefined) {
      return { file, value };
    }
  }
  return undefined;
}

/**
 * Claude Code's auto memory still on, which makes Claude save to its own directory
 * beside the store: forced on by the environment, or autoMemoryEnabled not false
 * where Claude Code reads it first. The fix names the file of the scope enabled,
 * the project's when both are; a project's true overrides the user's false.
 */
function autoMemoryProblem(
  ctx: AdapterContext,
  settings: readonly SettingsFile[],
  enabled: ReadonlySet<Scope>
): string[] {
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
  const setting = claudeSetting(settings, AUTO_MEMORY_KEY);
  if (setting === "unknown" || setting?.value === false) {
    return [];
  }
  if (setting?.file === SETTINGS_LOCAL) {
    return [
      `${on}: ${SETTINGS_LOCAL} sets ${AUTO_MEMORY_KEY} to ${JSON.stringify(setting.value)}, overriding ${SETTINGS}, ${consequence} — remove it from ${SETTINGS_LOCAL}`,
    ];
  }
  const scope = enabled.has("project") ? "project" : "global";
  if (setting?.file === SETTINGS && scope === "global") {
    return [
      `${on}: ${SETTINGS} sets ${AUTO_MEMORY_KEY} to ${JSON.stringify(setting.value)}, overriding ${userSettings(ctx)}, ${consequence} — remove it from ${SETTINGS}`,
    ];
  }
  const file = scope === "project" ? SETTINGS : userSettings(ctx);
  return [
    `${on}: ${AUTO_MEMORY_KEY} is not false in ${file}, ${consequence}${enableAdvice(ID, scope)}`,
  ];
}

/** `disableAllHooks: true` where Claude Code reads it first drops every hook, mdmem's included. */
function disabledHooksProblem(settings: readonly SettingsFile[]): string[] {
  const setting = claudeSetting(settings, DISABLE_HOOKS_KEY);
  return setting !== "unknown" && setting?.value === true
    ? [
        `${TITLE}: ${setting.file} sets ${DISABLE_HOOKS_KEY} to true, so Claude Code runs no hooks and its sessions start without the memory protocol and the index — remove it`,
      ]
    : [];
}

/**
 * Run below the root of a project wired in the project scope, where a Claude Code
 * started here reads none of the committed settings. The global scope's hooks speak
 * there (ADR 0004), so a project whose user settings hold one of them gets no warning.
 */
function belowRootWarning(
  ctx: AdapterContext,
  project: ProjectContext,
  enabled: ReadonlySet<Scope>,
  globalEntries: readonly WiringEntry[]
): string[] {
  const globalHooks = globalEntries.some(
    ({ label, present }) => present && HOOK_LABELS.has(label)
  );
  const root =
    enabled.has("project") && !globalHooks
      ? rootAbove(ctx, project)
      : undefined;
  return root === undefined
    ? []
    : [
        `${TITLE} reads ${SETTINGS} only from the folder it is started in: started here, below ${root}, it runs neither mdmem hook, so its sessions start without the memory protocol and the index, and it applies neither the project's ${AUTO_MEMORY_LABEL} nor its permission for the mdmem tools. Start ${TITLE} at ${root}, or run \`mdmem enable ${ID}\` to wire it in every folder.`,
      ];
}

/**
 * The folders whose trust record covers `cwd`, as Claude Code 2.1.310 reads them,
 * nearest first: each folder from `cwd` up to its work tree's root (up to the
 * filesystem's root outside git), and the main checkout's root in a linked worktree,
 * which is the key Claude Code records a worktree's trust under. Paths are resolved,
 * as Claude Code keys them. It asks git only past `cwd` itself, the common case.
 *
 * @yields {string} Each folder's resolved path, nearest first.
 */
function* trustKeys(cwd: string): Generator<string> {
  let dir = realDir(cwd);
  yield dir;
  const top = workTreeRoot(cwd);
  const root = top === null ? undefined : realDir(top);
  while (dir !== root && dirname(dir) !== dir) {
    dir = dirname(dir);
    yield dir;
  }
  const main = mainCheckoutRoot(cwd);
  if (main !== null) {
    yield main;
  }
}

/**
 * Whether Claude Code trusts the folder `cwd`: its user config records
 * `hasTrustDialogAccepted: true` under one of the trustKeys. A user config that is
 * missing or cannot be read records no trust.
 */
async function trusted(ctx: UserContext, cwd: string): Promise<boolean> {
  const read = await configDocument(cwd, userConfig(ctx));
  const projects = "doc" in read ? read.doc.projects : undefined;
  if (!isObject(projects)) {
    return false;
  }
  for (const key of trustKeys(cwd)) {
    const project = projects[key];
    if (isObject(project) && project.hasTrustDialogAccepted === true) {
      return true;
    }
  }
  return false;
}

/** A scope is enabled by any of mdmem's entries but autoMemoryEnabled: false, which alone may be the user's own choice. */
function enabledBy(entries: readonly WiringEntry[]): boolean {
  return entries.some(
    ({ label, present }) => present && label !== AUTO_MEMORY_LABEL
  );
}

export const claudeCodeAdapter: AdapterFor<typeof ID> = {
  id: ID,
  command: "claude",
  configDir: claudeConfigDir,
  title: TITLE,
  // One directory per project, where Claude Code keeps its memory directory too.
  sessionHistory: ({ projectRoot, env, home }) => ({
    dir: claudeProjectDir(projectRoot, { env, home }),
    search: "grep the `.jsonl` files there, one per session of this project",
  }),

  async enable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    // Read every file first, so an unparseable one refuses before anything is written.
    const { root, files } = scopeFiles(ctx, scope);
    const plan = await planConfigs(root, files, "add");
    const after =
      scope === "project"
        ? commitLine([SETTINGS, MCP_CONFIG], `they wire ${TITLE}`)
        : `${TITLE}'s auto memory is now off in every project, and the first memory saved in a project creates its store, importing the memories ${TITLE} kept for it.`;
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: [...describePlan(plan, "add"), after],
          warnings: [],
        };
      },
    };
  },

  async disable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    if (scope === "project" && ctx.project === undefined) {
      return outsideProjectPlan(TITLE);
    }
    const { root, files } = scopeFiles(ctx, scope);
    const plan = await planConfigs(root, files, "remove");
    const kept =
      scope === "project"
        ? "The memories imported from Claude Code stay in the store."
        : "The memories imported from Claude Code stay in the stores they were imported into.";
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: [...describePlan(plan, "remove"), kept],
          warnings: [],
        };
      },
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const global = await configStatus(rootOf(ctx), globalFiles(ctx));
    const project = wiredProject(ctx);
    const inProject =
      project === undefined
        ? undefined
        : await configStatus(project.root, PROJECT_FILES);
    // The local settings hold none of mdmem's entries, but Claude Code reads them first, at the home directory too.
    const local =
      ctx.project === undefined
        ? undefined
        : await configDocument(ctx.project.root, SETTINGS_LOCAL);
    const scopes = [
      scopeStatus("global", global.entries, enabledBy(global.entries)),
      ...(inProject === undefined
        ? []
        : [
            scopeStatus(
              "project",
              inProject.entries,
              enabledBy(inProject.entries)
            ),
          ]),
    ];
    return agentStatus(
      claudeCodeAdapter,
      {
        scopes,
        unreadable: [
          ...(local !== undefined && "unreadable" in local
            ? [local.unreadable]
            : []),
          ...(inProject?.unreadable ?? []),
          ...global.unreadable,
        ],
        warnings: [],
      },
      async (enabled) => {
        const settings = await readSettings(ctx);
        return {
          problems: [
            ...scopes
              .filter(({ scope }) => enabled.has(scope))
              .flatMap(({ scope, entries }) =>
                missingHooksProblem(claudeCodeAdapter, scope, entries, (e) =>
                  HOOK_LABELS.has(e.label) ? 1 : 0
                )
              ),
            ...disabledHooksProblem(settings),
            ...autoMemoryProblem(ctx, settings, enabled),
          ],
          warnings:
            project === undefined
              ? []
              : belowRootWarning(ctx, project, enabled, global.entries),
          notes: enabled.has("project")
            ? [
                `${TITLE} runs the project's hooks only in a folder whose trust dialog you accepted, and connects the ${MCP_CONFIG} server only once you approve it: mdmem does not check either.`,
              ]
            : [],
        };
      }
    );
  },

  // A global entry stays silent where the project's own entry for its part runs (ADR 0004): Claude Code reads the project's settings only from the folder it was started in, and runs their hooks only once that folder is trusted.
  async hookVerdict(ctx: UserContext, site: HookSite): Promise<HookVerdict> {
    if (!site.global) {
      return undefined;
    }
    const settings = join(site.cwd, SETTINGS);
    const read = await configDocument(site.cwd, SETTINGS);
    if (!("doc" in read && hookEntry(site.part, false).has(read.doc))) {
      return undefined;
    }
    if (await trusted(ctx, site.cwd)) {
      return { silence: globalSilence(settings, site.part) };
    }
    return {
      note: `this --global entry injects the ${site.part} part although ${settings} holds the project's own mdmem hook for it, because ${userConfig(ctx)} does not record ${realDir(site.cwd)} as trusted and Claude Code runs the project's hooks only in a trusted folder. Once you accept the folder's trust dialog, the project's hook injects it and this entry stays silent.`,
    };
  },

  // Once per user and repository: the marker keeps a store created again from bringing back memories deleted since.
  async importMemories(ctx: ImportContext): Promise<PlannedMemoryImport> {
    const environment = { env: ctx.env, home: ctx.home };
    const marker = importMarker(ctx.store, environment);
    if ((await readImportMarker(marker)) !== undefined) {
      return () => Promise.resolve({ lines: [], warnings: [] });
    }
    const write = await planClaudeImport(ctx.store, environment);
    return async () => {
      const result = await write();
      // Nothing to report or remember when Claude held no memories for the repository.
      if (result.sources.length === 0) {
        return { lines: [], warnings: result.warnings };
      }
      await writeImportMarker(marker, ctx.store);
      return { lines: formatImport(result), warnings: result.warnings };
    };
  },

  submoduleClause: `${TITLE} applies the submodule's settings, not the superproject's, so mdmem's setting that turns its auto memory off does not apply`,
};
