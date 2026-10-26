import { join, resolve } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookSite } from "../core/hook.ts";
import {
  agentStatus,
  commitLine,
  hookCommands,
  hooksLabel,
  MCP_SERVER,
  MCP_SERVER_IDENTITY,
  missingHooksProblem,
  outsideProjectPlan,
  projectOf,
  rootOf,
  scopeStatus,
  unreadableRefusal,
} from "./adapter.ts";
import type {
  AdapterContext,
  AdapterFor,
  AgentStatus,
  Scope,
  UnreadableFile,
  UserContext,
  WiringEntry,
  WiringPlan,
} from "./adapter.ts";
import {
  hookGroupEntry,
  configStatus,
  describePlan,
  planConfigs,
  writeConfigs,
} from "./json-config.ts";
import type { JsonConfigFile } from "./json-config.ts";
import {
  planTomlTable,
  tomlTableExists,
  tomlTableStatus,
} from "./toml-config.ts";
import type { TomlTableEntry } from "./toml-config.ts";

const ID = "codex";
const TITLE = "Codex CLI";

/** The variable Codex reads its home from. */
export const CODEX_HOME_ENV = "CODEX_HOME";

// Codex CLI's session-start hook is one unmarked entry in $CODEX_HOME/hooks.json in
// both scopes (ADR 0003, ADR 0004): Codex pins a hook's approval to the absolute
// path of the file declaring it, so a hook in each worktree's .codex/hooks.json would
// need approving in every worktree, while one in $CODEX_HOME/hooks.json is approved
// once. The scope is where the mdmem MCP server is registered: $CODEX_HOME/config.toml
// for the global scope, the project's .codex/config.toml, committed with the
// repository and read only in a trusted folder, for the project scope. mdmem hook
// codex prints nothing where neither registers it.
const PROJECT_CONFIG = ".codex/config.toml";
// Seconds; Codex's default is 600.
const HOOK_TIMEOUT = 10;

const commands = hookCommands(ID);

// No matcher: mdmem hook skips a resumed or forked session itself.
// additionalContextLimit 0 lifts Codex's cap of about 2,500 tokens per context, past
// which it replaces the context with a preview and a temp-file path.
const HOOK_GROUP = {
  hooks: commands.map((command) => ({
    type: "command",
    command,
    timeout: HOOK_TIMEOUT,
    additionalContextLimit: 0,
  })),
};

/** The server table in `file`. */
function serverEntry(file: string): TomlTableEntry {
  return {
    label: "[mcp_servers.mdmem]",
    file,
    path: ["mcp_servers", "mdmem"],
    value: MCP_SERVER,
    identity: MCP_SERVER_IDENTITY,
  };
}

const PROJECT_SERVER = serverEntry(PROJECT_CONFIG);

/**
 * Codex's home: CODEX_HOME when set, else ~/.codex. A hook reads it too; whether
 * Codex passes CODEX_HOME to hooks is unverified, so without it ~/.codex is read.
 */
function codexHome({ env, home }: UserContext): string {
  const fromEnv = env[CODEX_HOME_ENV];
  return fromEnv === undefined || fromEnv === ""
    ? join(home, ".codex")
    : resolve(fromEnv);
}

/** The user config's server table, by its absolute path: the global scope's registration. */
function userServer(ctx: UserContext): TomlTableEntry {
  return serverEntry(join(codexHome(ctx), "config.toml"));
}

/** The user-wide hooks file, by its absolute path, shared by both scopes. */
function hooksFile(ctx: UserContext): JsonConfigFile {
  return {
    file: join(codexHome(ctx), "hooks.json"),
    entries: [
      hookGroupEntry(
        hooksLabel(commands),
        ["hooks", "SessionStart"],
        HOOK_GROUP
      ),
    ],
  };
}

/** A server table's status as a wiring entry. */
function serverWiringEntry(
  entry: TomlTableEntry,
  status: { present: boolean; unreadable?: UnreadableFile }
): WiringEntry {
  return {
    label: entry.label,
    file: entry.file,
    present: status.present,
    ...(status.unreadable === undefined ? {} : { unreadable: true }),
  };
}

/** What Codex's project-scope disable says of the hook it leaves. */
async function keptHookLines(
  ctx: AdapterContext,
  root: string,
  serverRemoved: boolean
): Promise<{ kept: string[]; warnings: string[] }> {
  const file = hooksFile(ctx);
  const { entries, unreadable } = await configStatus(root, [file]);
  const warnings = unreadable.map(unreadableRefusal);
  if (!entries.some(({ present }) => present)) {
    return { kept: [], warnings };
  }
  const user = userServer(ctx);
  if (await tomlTableExists(root, user)) {
    return {
      kept: [
        `The hook in ${file.file} stays, and keeps speaking in every project, since ${user.file} registers the mdmem server.`,
      ],
      warnings,
    };
  }
  const removeIt = `\`mdmem disable ${ID}\` removes it.`;
  // A server table other than mdmem's own is kept, and the hook still runs beside it.
  const silenced =
    serverRemoved || !(await tomlTableExists(root, PROJECT_SERVER));
  return {
    kept: [
      silenced
        ? `The hook in ${file.file} stays, and is now silent in this project, whose ${PROJECT_CONFIG} no longer registers the mdmem server. ${removeIt}`
        : `The hook in ${file.file} stays. ${removeIt}`,
    ],
    warnings,
  };
}

export const codexAdapter: AdapterFor<typeof ID> = {
  id: ID,
  command: "codex",
  configDir: codexHome,
  title: TITLE,
  // Not split by project: a session file's first line, its session_meta record, holds the cwd it ran in.
  sessionHistory: ({ projectRoot, env, home }) => ({
    dir: join(codexHome({ env, home }), "sessions"),
    search: `the \`YYYY/MM/DD/*.jsonl\` files there hold every project's sessions, so grep only those whose first line, a \`session_meta\` record, has a \`cwd\` of \`${projectRoot}\` or a folder under it`,
  }),

  async enable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    const root = scope === "project" ? projectOf(ctx).root : rootOf(ctx);
    const server = scope === "project" ? PROJECT_SERVER : userServer(ctx);
    // Plan both files before writing either, so an unparseable one refuses with nothing written.
    const file = hooksFile(ctx);
    const hooks = await planConfigs(root, [file], "add");
    const serverPlan = await planTomlTable(root, server, "add");
    const plan = [...hooks, serverPlan];
    return {
      write: async () => {
        await writeConfigs(plan);
        const review = hooks.some(({ changed }) => changed.length > 0)
          ? [
              `Codex asks you once to review the new hook in ${file.file}, at its next start or in /hooks: trust it, and it runs in every project, printing nothing where neither ${userServer(ctx).file} nor the project's ${PROJECT_CONFIG} registers the mdmem server.`,
            ]
          : [];
        const commit =
          scope === "project"
            ? [
                commitLine(
                  [PROJECT_CONFIG],
                  "it registers the mdmem MCP server",
                  "Codex reads it only in a trusted folder."
                ),
              ]
            : [];
        return {
          title: TITLE,
          actions: [...describePlan(plan, "add"), ...review, ...commit],
          warnings: [],
        };
      },
    };
  },

  async disable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    if (scope === "project" && ctx.project === undefined) {
      return outsideProjectPlan(TITLE);
    }
    if (scope === "project") {
      const { root } = projectOf(ctx);
      const server = await planTomlTable(root, PROJECT_SERVER, "remove");
      const { kept, warnings } = await keptHookLines(
        ctx,
        root,
        server.changed.length > 0
      );
      return {
        write: async () => {
          await writeConfigs([server]);
          return {
            title: TITLE,
            actions: [...describePlan([server], "remove"), ...kept],
            warnings,
          };
        },
      };
    }
    const root = rootOf(ctx);
    const server = await planTomlTable(root, userServer(ctx), "remove");
    const hooks = await planConfigs(root, [hooksFile(ctx)], "remove");
    const plan = [server, ...hooks];
    // The one hook serves the project scope too.
    const shared = hooks.some(({ changed }) => changed.length > 0)
      ? [
          `The hook served the project scope too: in a repository whose ${PROJECT_CONFIG} registers the mdmem server, Codex sessions now start without the memory until \`mdmem enable ${ID} --project\` runs there again.`,
        ]
      : [];
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: [...describePlan(plan, "remove"), ...shared],
          warnings: [],
        };
      },
    };
  },

  // Any mdmem server table counts, extra keys included: Codex then runs that server.
  async hookSilence(
    ctx: UserContext,
    site: HookSite
  ): Promise<string | undefined> {
    const root = site.projectRoot();
    const user = userServer(ctx);
    if (
      (await tomlTableExists(root, user)) ||
      (await tomlTableExists(root, PROJECT_SERVER))
    ) {
      return undefined;
    }
    return `neither ${user.file} nor ${join(root, PROJECT_CONFIG)} registers the mdmem server, and Codex's hook speaks only where one does: run \`mdmem enable ${ID}\` to register it for every project, or \`mdmem enable ${ID} --project\` for this one.`;
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const root = rootOf(ctx);
    const user = userServer(ctx);
    const hooks = await configStatus(root, [hooksFile(ctx)]);
    const userStatus = await tomlTableStatus(root, user);
    const { project } = ctx;
    const projectStatus =
      project === undefined
        ? undefined
        : await tomlTableStatus(project.root, PROJECT_SERVER);
    // The hook alone wires no scope: it is shared by both, and by every project.
    const scopes = [
      scopeStatus(
        "global",
        [serverWiringEntry(user, userStatus), ...hooks.entries],
        userStatus.present
      ),
      ...(projectStatus === undefined
        ? []
        : [
            scopeStatus(
              "project",
              [
                serverWiringEntry(PROJECT_SERVER, projectStatus),
                ...hooks.entries,
              ],
              projectStatus.present
            ),
          ]),
    ];
    // Without CODEX_HOME, the user files read may not be the ones Codex reads, so they stay status warnings.
    const userKnown = !ctx.unknownEnv?.includes(CODEX_HOME_ENV);
    const userUnreadable = [
      ...hooks.unreadable,
      ...(userStatus.unreadable === undefined ? [] : [userStatus.unreadable]),
    ];
    const unreadable = [
      ...(projectStatus?.unreadable === undefined
        ? []
        : [projectStatus.unreadable]),
      ...(userKnown ? userUnreadable : []),
    ];
    const warnings = userKnown ? [] : userUnreadable.map(unreadableRefusal);
    return agentStatus(
      codexAdapter,
      { scopes, unreadable, warnings },
      (enabled) => ({
        // One hook for both scopes, reported once, with the global scope's fix when it is enabled.
        problems: userKnown
          ? missingHooksProblem(
              codexAdapter,
              enabled.has("global") ? "global" : "project",
              hooks.entries,
              () => HOOK_PARTS.length
            )
          : [],
        notes: [
          enabled.has("project")
            ? `${TITLE} reads ${PROJECT_CONFIG} only in a trusted folder, and runs the hook only once you have reviewed it: mdmem does not check either.`
            : `${TITLE} runs the hook only once you have reviewed it: mdmem does not check that.`,
        ],
      })
    );
  },
};
