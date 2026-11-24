import { join } from "node:path";

import { HOOK_PARTS, PROMPT_PART, SESSION_START_PARTS } from "../core/hook.ts";
import type { HookPart, HookSite, HookVerdict } from "../core/hook.ts";
import {
  agentStatus,
  commitLine,
  globalSilence,
  hookCommand,
  hookCommands,
  hooksLabel,
  promptHookLabel,
  MCP_SERVER,
  MCP_SERVER_IDENTITY,
  missedParts,
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
  ProjectContext,
  Scope,
  ScopeStatus,
  UserContext,
  WiringEntry,
  WiringPlan,
} from "./adapter.ts";
import {
  hookGroupEntry,
  configDocument,
  configStatus,
  describePlan,
  planConfigs,
  valueEntry,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile, JsonEntry, JsonObject } from "./json-config.ts";

const ID = "bob";
const TITLE = "IBM Bob";

// IBM Bob is wired in either scope (ADR 0004): two session-start hooks injecting the
// protocol and the index, a UserPromptSubmit hook injecting the per-prompt block, and
// the mdmem MCP server. The global scope writes its user
// settings and the user MCP config `bob mcp add -s global` writes; the project scope,
// workspace files committed with the repository (ADR 0003), which Bob runs only in a
// trusted folder and reads only from the workspace it was launched in: launched below
// the checkout's root, it gets none of them.
const SETTINGS = ".bob/settings.json";
const MCP_CONFIG = ".bob/mcp.json";
// Bob's matcher is an unanchored regex on the payload's source (startup, resume or
// compact): a new session and compaction, never a resume, which already holds the
// injection.
const HOOK_MATCHER = "^(startup|compact)$";
// Bob's default, in seconds.
const HOOK_TIMEOUT = 10;

/** A command handler as Bob takes it. */
function handler(command: string): {
  type: string;
  command: string;
  timeout: number;
} {
  return { type: "command", command, timeout: HOOK_TIMEOUT };
}

// Bob validates its hooks strictly: one unknown key voids the whole hooks block, so
// the group holds only documented fields.
function hookEntry(global: boolean): JsonEntry {
  const commands = hookCommands(ID, global);
  return hookGroupEntry(hooksLabel(commands), ["hooks", "SessionStart"], {
    matcher: HOOK_MATCHER,
    hooks: commands.map(handler),
  });
}

/** The UserPromptSubmit group running the prompt part, beside the SessionStart group. */
function promptHookEntry(global: boolean): JsonEntry {
  const command = hookCommand(ID, PROMPT_PART, global);
  // No matcher, which Bob's schema makes optional.
  return hookGroupEntry(
    promptHookLabel(command),
    ["hooks", "UserPromptSubmit"],
    { hooks: [handler(command)] }
  );
}

const PROJECT_HOOK = hookEntry(false);
const GLOBAL_HOOK = hookEntry(true);
const PROJECT_PROMPT_HOOK = promptHookEntry(false);
const GLOBAL_PROMPT_HOOK = promptHookEntry(true);

/** The project entry of one part, which a global entry of that part defers to. */
function projectPartEntry(part: HookPart): JsonEntry {
  if (part === PROMPT_PART) {
    return PROJECT_PROMPT_HOOK;
  }
  const command = hookCommand(ID, part);
  return hookGroupEntry(hooksLabel([command]), ["hooks", "SessionStart"], {
    matcher: HOOK_MATCHER,
    hooks: [handler(command)],
  });
}

const SERVER_ENTRY = valueEntry(
  "mcpServers.mdmem",
  ["mcpServers", "mdmem"],
  MCP_SERVER,
  MCP_SERVER_IDENTITY
);

const PROJECT_FILES: readonly JsonConfigFile[] = [
  { file: SETTINGS, entries: [PROJECT_HOOK, PROJECT_PROMPT_HOOK] },
  { file: MCP_CONFIG, entries: [SERVER_ENTRY] },
];

/** A scope is enabled by any of mdmem's entries. */
function enabledBy(entries: readonly { present: boolean }[]): boolean {
  return entries.some(({ present }) => present);
}

/** The parts an entry's hooks inject: the session-start parts for the SessionStart group, the prompt part for the UserPromptSubmit group, none for the server. */
function partsIn({ label }: { label: string }): readonly HookPart[] {
  if (label === PROJECT_HOOK.label || label === GLOBAL_HOOK.label) {
    return SESSION_START_PARTS;
  }
  return label === PROJECT_PROMPT_HOOK.label ||
    label === GLOBAL_PROMPT_HOOK.label
    ? [PROMPT_PART]
    : [];
}

/** Whether an entry is the SessionStart group, which injects the protocol and the index. */
function isSessionStartGroup(entry: { label: string }): boolean {
  return partsIn(entry).some((part) => part !== PROMPT_PART);
}

/** Whether an entry is the mdmem MCP server. */
function isServer(entry: { label: string }): boolean {
  return entry.label === SERVER_ENTRY.label;
}

/** Bob's user settings directory. */
function userDir({ home }: UserContext): string {
  return join(home, ".bob", "settings");
}

/** Bob's user settings, which hold the global scope's hooks. */
function userSettings(ctx: UserContext): string {
  return join(userDir(ctx), "settings.json");
}

/** The global scope's files, by their absolute paths. */
function globalFiles(ctx: UserContext): JsonConfigFile[] {
  return [
    {
      file: userSettings(ctx),
      entries: [GLOBAL_HOOK, GLOBAL_PROMPT_HOOK],
    },
    { file: join(userDir(ctx), "mcp.json"), entries: [SERVER_ENTRY] },
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

/** A scope's settings file, which holds its hooks: relative to `root`, or absolute for the user settings. */
interface ScopeSettings {
  root: string;
  file: string;
  global: boolean;
}

/** The key that drops every hook of a scope, mdmem's included, when a scope's settings file sets it to true, and what the sessions then miss. */
function hooksOffKey(global: boolean): { key: string; consequence: string } {
  return global
    ? {
        key: "disableGlobalHooks",
        consequence:
          "runs none of the global hooks and its sessions get the memory protocol and the index only in a workspace that wires them",
      }
    : {
        key: "disableWorkspaceHooks",
        consequence:
          "runs none of the workspace's hooks and its sessions start without the memory protocol and the index",
      };
}

/** mdmem's hooks in a scope's settings that every handler running them marks `disabled: true`, as Bob's Settings does for a hook switched off: Bob skips them. */
function disabledHandlersProblem(
  doc: JsonObject,
  { file, global }: ScopeSettings
): string[] {
  const entries = global
    ? [GLOBAL_HOOK, GLOBAL_PROMPT_HOOK]
    : [PROJECT_HOOK, PROJECT_PROMPT_HOOK];
  const off = new Set(
    entries.flatMap((entry) => entry.disabledCommands?.(doc) ?? [])
  );
  const parts = HOOK_PARTS.filter((part) =>
    off.has(hookCommand(ID, part, global))
  );
  if (parts.length === 0) {
    return [];
  }
  const starting = parts
    .filter((part) => part !== PROMPT_PART)
    .map((part) => hookCommand(ID, part, global));
  const labels = [
    ...(starting.length > 0 ? [hooksLabel(starting)] : []),
    ...(parts.includes(PROMPT_PART)
      ? [promptHookLabel(hookCommand(ID, PROMPT_PART, global))]
      : []),
  ];
  const them = parts.length === 1 ? "it" : "them";
  return [
    `${TITLE}: ${file} marks ${labels.join(" and ")} disabled, so Bob skips ${them} and ${missedParts(parts)}. Remove "disabled": true from ${them}, or switch ${them} back on in Bob's Settings.`,
  ];
}

/**
 * The scope's settings switching mdmem's hooks off: `disableGlobalHooks` in the
 * user settings or `disableWorkspaceHooks` in the workspace's drops every hook of
 * that scope, and a handler marked disabled drops itself. A settings file that
 * cannot be read yields nothing here: configStatus reports it.
 */
async function hooksOffProblems(settings: ScopeSettings): Promise<string[]> {
  const read = await configDocument(settings.root, settings.file);
  if (!("doc" in read)) {
    return [];
  }
  const { key, consequence } = hooksOffKey(settings.global);
  return [
    ...(read.doc[key] === true
      ? [
          `${TITLE}: ${settings.file} sets ${key} to true, so Bob ${consequence}. Remove that setting.`,
        ]
      : []),
    ...disabledHandlersProblem(read.doc, settings),
  ];
}

/** What a Bob launched below the root misses, given what the global scope holds: its session-start hooks, its server, or neither. */
function missedBelowRoot(present: readonly WiringEntry[]): string {
  if (present.some(isSessionStartGroup)) {
    return "no mdmem tools";
  }
  return present.some(isServer)
    ? "no memory protocol and no index"
    : "no memory protocol, no index and no mdmem tools";
}

/** Run below the checkout's root, where a Bob launched here reads none of the workspace files: it gets the wiring only from the global scope, and all of it only when that scope holds both the session-start hooks and the server. */
function belowRootWarning(
  ctx: AdapterContext,
  project: ProjectContext,
  globalScope: ScopeStatus | undefined
): string[] {
  const present = globalScope?.entries.filter((entry) => entry.present) ?? [];
  const covered = present.some(isSessionStartGroup) && present.some(isServer);
  const root = covered ? undefined : rootAbove(ctx, project);
  return root === undefined
    ? []
    : [
        `${TITLE} reads ${SETTINGS} (the session-start hooks) and ${MCP_CONFIG} (the mdmem MCP server) only from its workspace, the folder it is launched in. Launched here, below ${root}, it gets ${missedBelowRoot(present)}. Launch Bob at ${root}, or run \`mdmem enable ${ID}\` to wire it in every folder.`,
      ];
}

export const bobAdapter: AdapterFor<typeof ID> = {
  id: ID,
  command: "bob",
  configDir: ({ home }) => join(home, ".bob"),
  title: TITLE,

  async enable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    const { root, files } = scopeFiles(ctx, scope);
    const plan = await planConfigs(root, files, "add");
    const after =
      scope === "project"
        ? [
            commitLine(
              [SETTINGS, MCP_CONFIG],
              `they wire ${TITLE}`,
              "Bob runs them only in a trusted folder, and reads them only when launched at the checkout's root: launched in a subdirectory it gets neither the hooks nor the mdmem tools."
            ),
          ]
        : [];
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: describePlan(plan, "add"),
          notes: after,
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
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: describePlan(plan, "remove"),
          notes: [],
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
      bobAdapter,
      {
        scopes,
        unreadable: [...(inProject?.unreadable ?? []), ...global.unreadable],
        warnings: [],
      },
      async (enabled) => {
        const workspace =
          project !== undefined && enabled.has("project") ? project : undefined;
        const settings: ScopeSettings[] = [
          ...(enabled.has("global")
            ? [{ root: rootOf(ctx), file: userSettings(ctx), global: true }]
            : []),
          ...(workspace === undefined
            ? []
            : [{ root: workspace.root, file: SETTINGS, global: false }]),
        ];
        const hooksOff = await Promise.all(settings.map(hooksOffProblems));
        return {
          problems: [
            ...scopes
              .filter(({ scope }) => enabled.has(scope))
              .flatMap(({ scope, entries }) =>
                missingHooksProblem(bobAdapter, scope, entries, partsIn)
              ),
            ...hooksOff.flat(),
          ],
          warnings:
            workspace === undefined
              ? []
              : belowRootWarning(
                  ctx,
                  workspace,
                  scopes.find(({ scope }) => scope === "global")
                ),
          notes:
            workspace === undefined
              ? []
              : [
                  `${TITLE} runs workspace hooks and MCP servers only in a trusted folder: mdmem does not check whether this one is.`,
                ],
        };
      }
    );
  },

  // A global entry stays silent where the workspace's own entry for its part runs (ADR 0004): Bob reads the workspace files only from the folder it was launched in, and skips a handler marked disabled.
  async hookVerdict(_ctx: UserContext, site: HookSite): Promise<HookVerdict> {
    if (!site.global) {
      return undefined;
    }
    const read = await configDocument(site.cwd, SETTINGS);
    const entry = projectPartEntry(site.part);
    const runs =
      "doc" in read &&
      entry.has(read.doc) &&
      (entry.disabledCommands?.(read.doc) ?? []).length === 0;
    return runs
      ? { silence: globalSilence(join(site.cwd, SETTINGS), site.part) }
      : undefined;
  },
};
