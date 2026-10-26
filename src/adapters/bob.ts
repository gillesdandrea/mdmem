import { join } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookPart, HookSite } from "../core/hook.ts";
import {
  agentStatus,
  commitLine,
  globalSilence,
  hookCommand,
  hookCommands,
  hooksLabel,
  MCP_SERVER,
  MCP_SERVER_IDENTITY,
  missingHooksProblem,
  outsideProjectPlan,
  projectOf,
  rootAbove,
  rootOf,
  scopeStatus,
} from "./adapter.ts";
import type {
  AdapterContext,
  AdapterFor,
  AgentStatus,
  ProjectContext,
  Scope,
  ScopeStatus,
  UserContext,
  WiringPlan,
} from "./adapter.ts";
import {
  hookGroupEntry,
  configDocument,
  configStatus,
  configValue,
  describePlan,
  planConfigs,
  valueEntry,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile, JsonEntry } from "./json-config.ts";

const ID = "bob";
const TITLE = "IBM Bob";

// IBM Bob is wired in either scope (ADR 0004): two session-start hooks injecting the
// protocol and the index, and the mdmem MCP server. The global scope writes its user
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

/** The project entry of one part, which a global entry of that part defers to. */
function projectPartEntry(part: HookPart): JsonEntry {
  const command = hookCommand(ID, part);
  return hookGroupEntry(hooksLabel([command]), ["hooks", "SessionStart"], {
    matcher: HOOK_MATCHER,
    hooks: [handler(command)],
  });
}

const PROJECT_HOOK = hookEntry(false);
const GLOBAL_HOOK = hookEntry(true);

const SERVER_ENTRY = valueEntry(
  "mcpServers.mdmem",
  ["mcpServers", "mdmem"],
  MCP_SERVER,
  MCP_SERVER_IDENTITY
);

const PROJECT_FILES: readonly JsonConfigFile[] = [
  { file: SETTINGS, entries: [PROJECT_HOOK] },
  { file: MCP_CONFIG, entries: [SERVER_ENTRY] },
];

/** A scope is enabled by any of mdmem's entries. */
function enabledBy(entries: readonly { present: boolean }[]): boolean {
  return entries.some(({ present }) => present);
}

/** How many hooks an entry holds: both parts for a hook group, none for the server. */
function hooksIn({ label }: { label: string }): number {
  return label === PROJECT_HOOK.label || label === GLOBAL_HOOK.label
    ? HOOK_PARTS.length
    : 0;
}

/** Bob's user settings directory. */
function userDir({ home }: UserContext): string {
  return join(home, ".bob", "settings");
}

/** The global scope's files, by their absolute paths. */
function globalFiles(ctx: UserContext): JsonConfigFile[] {
  return [
    { file: join(userDir(ctx), "settings.json"), entries: [GLOBAL_HOOK] },
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

/** `disableWorkspaceHooks: true` in the workspace settings drops every workspace hook, mdmem's included; a settings file that cannot be read is reported as such. */
async function disabledHooksProblem(
  project: ProjectContext
): Promise<string[]> {
  const disabled = await configValue(project.root, SETTINGS, [
    "disableWorkspaceHooks",
  ]);
  return "value" in disabled && disabled.value === true
    ? [
        `${TITLE}: ${SETTINGS} sets disableWorkspaceHooks to true, so Bob runs none of the workspace's hooks and its sessions start without the memory protocol and the index — remove it`,
      ]
    : [];
}

/** Run below the checkout's root, where a Bob launched here reads none of the workspace files: it gets the wiring only from a global scope that holds both the hooks and the server. */
function belowRootWarning(
  ctx: AdapterContext,
  project: ProjectContext,
  globalScope: ScopeStatus | undefined
): string[] {
  const root =
    globalScope?.wired === true ? undefined : rootAbove(ctx, project);
  return root === undefined
    ? []
    : [
        `${TITLE} reads ${SETTINGS} (the session-start hooks) and ${MCP_CONFIG} (the mdmem MCP server) only from its workspace, the folder it is launched in: launched here, below ${root}, it gets no memory protocol, no index and no mdmem tools. Launch Bob at ${root}.`,
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
          actions: [...describePlan(plan, "add"), ...after],
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
          warnings: [],
        };
      },
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const global = await configStatus(rootOf(ctx), globalFiles(ctx));
    const { project } = ctx;
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
        return {
          problems: [
            ...scopes
              .filter(({ scope }) => enabled.has(scope))
              .flatMap(({ scope, entries }) =>
                missingHooksProblem(bobAdapter, scope, entries, hooksIn)
              ),
            ...(workspace === undefined
              ? []
              : await disabledHooksProblem(workspace)),
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

  // A global entry stays silent where the workspace's own entry for its part runs (ADR 0004): Bob reads the workspace files only from the folder it was launched in.
  async hookSilence(
    _ctx: UserContext,
    site: HookSite
  ): Promise<string | undefined> {
    if (!site.global) {
      return undefined;
    }
    const read = await configDocument(site.cwd, SETTINGS);
    return "doc" in read && projectPartEntry(site.part).has(read.doc)
      ? globalSilence(join(site.cwd, SETTINGS), site.part)
      : undefined;
  },
};
