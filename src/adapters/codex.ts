import { join, resolve } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import {
  agentStatus,
  commitLine,
  hookCommands,
  hooksLabel,
  MCP_SERVER,
  MCP_SERVER_IDENTITY,
  missingHooksProblem,
  OUTSIDE_PROJECT_LINE,
  unreadableRefusal,
} from "./adapter.ts";
import type {
  AdapterContext,
  AdapterFor,
  AgentStatus,
  DisableOptions,
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

// Codex CLI's session-start hook is global (ADR 0003): Codex pins a hook's approval
// to the absolute path of the file declaring it, so a hook in each worktree's
// .codex/hooks.json would need approving in every worktree, while one in
// $CODEX_HOME/hooks.json is approved once. The mdmem MCP server is registered per
// project, in .codex/config.toml committed with the repository, which Codex reads
// only in a trusted folder; that registration is what wires a project for Codex, so
// mdmem hook codex prints nothing in a work tree without it, as it prints nothing
// outside a project with a store.
const MCP_CONFIG = ".codex/config.toml";
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

const SERVER_ENTRY: TomlTableEntry = {
  label: "[mcp_servers.mdmem]",
  file: MCP_CONFIG,
  path: ["mcp_servers", "mdmem"],
  value: MCP_SERVER,
  identity: MCP_SERVER_IDENTITY,
};

/** Codex's home: CODEX_HOME when set, else ~/.codex. */
function codexHome({
  env,
  home,
}: Pick<AdapterContext, "env" | "home">): string {
  const fromEnv = env[CODEX_HOME_ENV];
  return fromEnv === undefined || fromEnv === ""
    ? join(home, ".codex")
    : resolve(fromEnv);
}

/** The user-wide hooks file, by its absolute path. */
function hooksFile(ctx: AdapterContext): JsonConfigFile {
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

export const codexAdapter: AdapterFor<typeof ID> = {
  id: ID,
  command: "codex",
  configDir: codexHome,
  title: TITLE,

  async enable(ctx: AdapterContext): Promise<WiringPlan> {
    // Plan both files before writing either, so an unparseable one refuses with nothing written.
    const file = hooksFile(ctx);
    const hooks = await planConfigs(ctx.projectRoot, [file], "add");
    const server = await planTomlTable(ctx.projectRoot, SERVER_ENTRY, "add");
    const plan = [...hooks, server];
    return {
      write: async () => {
        await writeConfigs(plan);
        const review = hooks.some(({ changed }) => changed.length > 0)
          ? [
              `Codex asks you once to review the new hook in ${file.file}, at its next start or in /hooks: trust it, and it runs in every project, printing nothing where ${MCP_CONFIG} does not register the mdmem server or no store exists.`,
            ]
          : [];
        return {
          title: TITLE,
          actions: [
            ...describePlan(plan, "add"),
            ...review,
            commitLine(
              [MCP_CONFIG],
              "it registers the mdmem MCP server",
              "Codex reads it only in a trusted folder."
            ),
          ],
          warnings: [],
        };
      },
    };
  },

  async disable(
    ctx: AdapterContext,
    options: DisableOptions
  ): Promise<WiringPlan> {
    const file = hooksFile(ctx);
    const hooks = options.global
      ? await planConfigs(ctx.projectRoot, [file], "remove")
      : [];
    // Outside a project only the global hook is mdmem's to remove.
    const server = options.outsideProject
      ? []
      : [await planTomlTable(ctx.projectRoot, SERVER_ENTRY, "remove")];
    const plan = [...server, ...hooks];
    const kept: string[] = [];
    const warnings: string[] = [];
    if (!options.global) {
      const { entries, unreadable } = await configStatus(ctx.projectRoot, [
        file,
      ]);
      warnings.push(...unreadable.map(unreadableRefusal));
      const removeIt = `\`mdmem disable ${ID} --global\` removes it.`;
      // A server table other than mdmem's own is kept, and the hook still runs beside it.
      const silenced =
        !options.outsideProject &&
        (server[0]?.changed.length !== 0 ||
          !(await tomlTableExists(ctx.projectRoot, SERVER_ENTRY)));
      if (entries.some(({ present }) => present)) {
        kept.push(
          silenced
            ? `The global hook in ${file.file} stays, and is now silent in this project, whose ${MCP_CONFIG} no longer registers the mdmem server. ${removeIt}`
            : `The global hook in ${file.file} stays. ${removeIt}`
        );
      }
    }
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: [
            // With --global outside a project, the hook is all there is to remove.
            ...(options.outsideProject && !options.global
              ? [OUTSIDE_PROJECT_LINE]
              : []),
            ...describePlan(plan, "remove"),
            ...kept,
          ],
          warnings,
        };
      },
    };
  },

  // Any mdmem server table counts, extra keys included: Codex then runs that server.
  projectWired: (projectRoot: string): Promise<boolean> =>
    tomlTableExists(projectRoot, SERVER_ENTRY),

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const server = await tomlTableStatus(ctx.projectRoot, SERVER_ENTRY);
    const hooks = await configStatus(ctx.projectRoot, [hooksFile(ctx)]);
    const entries = [
      {
        label: SERVER_ENTRY.label,
        file: MCP_CONFIG,
        present: server.present,
        ...(server.unreadable === undefined ? {} : { unreadable: true }),
      },
      ...hooks.entries,
    ];
    // The global hook alone does not wire this project: it is shared by every project.
    const enabled = server.present;
    // Without CODEX_HOME, the hooks file read may not be the one Codex reads, so it stays a status warning.
    const hooksKnown = !ctx.unknownEnv?.includes(CODEX_HOME_ENV);
    const unreadable = [
      ...(server.unreadable === undefined ? [] : [server.unreadable]),
      ...(hooksKnown ? hooks.unreadable : []),
    ];
    const warnings = hooksKnown ? [] : hooks.unreadable.map(unreadableRefusal);
    return agentStatus(
      codexAdapter,
      { entries, enabled, unreadable, warnings },
      () => ({
        problems: hooksKnown
          ? missingHooksProblem(
              codexAdapter,
              hooks.entries,
              () => HOOK_PARTS.length
            )
          : [],
        notes: [
          `${TITLE} reads ${MCP_CONFIG} only in a trusted folder, and runs the global hook only once you have reviewed it: mdmem does not check either.`,
        ],
      })
    );
  },
};
