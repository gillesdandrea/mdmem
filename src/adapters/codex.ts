import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { mainCheckoutRoot } from "../core/git.ts";
import { PROMPT_PART, SESSION_START_PARTS } from "../core/hook.ts";
import type { HookPart, HookSite, HookVerdict } from "../core/hook.ts";
import { realDir } from "../core/store.ts";
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
  missingHooksProblem,
  outsideProjectPlan,
  projectOf,
  rootOf,
  scopeStatus,
  unreadableRefusal,
  wiredProject,
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
  configDocument,
  configStatus,
  describePlan,
  hookGroupEntry,
  planConfigs,
  writeConfigs,
} from "./json-config.ts";
import type {
  HookHandler,
  JsonConfigFile,
  JsonEntry,
  PlannedFile,
} from "./json-config.ts";
import { planTomlTable, tomlTableStatus } from "./toml-config.ts";
import type { TomlTableEntry } from "./toml-config.ts";

const ID = "codex";
const TITLE = "Codex CLI";

/** The variable Codex reads its home from. */
export const CODEX_HOME_ENV = "CODEX_HOME";

// Codex CLI is wired in either scope (ADR 0004): two session-start hooks injecting
// the protocol and the index, a UserPromptSubmit hook injecting the per-prompt block,
// and the mdmem MCP server. The global scope writes
// $CODEX_HOME/hooks.json and $CODEX_HOME/config.toml; the project scope, the
// repository's .codex/hooks.json and .codex/config.toml, committed with it (ADR 0003).
// Codex reads a project's .codex/ folders from the launch folder up to the work
// tree's root, a linked worktree's hooks from the main checkout's matching folder,
// and runs a hook only once the user has reviewed it (verified in Codex 0.164.0).
const HOOKS = ".codex/hooks.json";
const CONFIG = ".codex/config.toml";
// Seconds; Codex's default is 600.
const HOOK_TIMEOUT = 10;
const HOOKS_PATH = ["hooks", "SessionStart"];

/** A command handler as Codex takes it. */
function handler(command: string): HookHandler {
  // additionalContextLimit 0 lifts Codex's cap of about 2,500 tokens per context, past
  // which it replaces the context with a preview and a temp-file path.
  return {
    type: "command",
    command,
    timeout: HOOK_TIMEOUT,
    additionalContextLimit: 0,
  };
}

// No matcher: mdmem hook skips a resumed or forked session itself.
function hookEntry(global: boolean): JsonEntry {
  const commands = hookCommands(ID, global);
  return hookGroupEntry(hooksLabel(commands), HOOKS_PATH, {
    hooks: commands.map(handler),
  });
}

/** The UserPromptSubmit group running the prompt part, beside the SessionStart group. */
function promptHookEntry(global: boolean): JsonEntry {
  const command = hookCommand(ID, PROMPT_PART, global);
  // No additionalContextLimit: the per-prompt block stays under Codex's cap.
  return hookGroupEntry(
    promptHookLabel(command),
    ["hooks", "UserPromptSubmit"],
    { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT }] }
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
  return hookGroupEntry(hooksLabel([command]), HOOKS_PATH, {
    hooks: [handler(command)],
  });
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

// mdmem 0.2.0 wrote the project's unmarked group into $CODEX_HOME/hooks.json for both
// scopes; there it speaks in every project, beside each project's own hook.
const UNMARKED_GLOBAL_HOOK = PROJECT_HOOK;

/** The global hook group, replacing 0.2.0's unmarked one in the same file. */
const GLOBAL_HOOK_MIGRATING: JsonEntry = {
  ...GLOBAL_HOOK,
  has: (doc) =>
    GLOBAL_HOOK.has(doc) && !(UNMARKED_GLOBAL_HOOK.hasPart?.(doc) ?? false),
  add: (doc) => {
    if (UNMARKED_GLOBAL_HOOK.hasPart?.(doc) ?? false) {
      UNMARKED_GLOBAL_HOOK.remove(doc);
    }
    if (!GLOBAL_HOOK.has(doc)) {
      GLOBAL_HOOK.add(doc);
    }
  },
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

/** Codex's home: CODEX_HOME when set, else ~/.codex. */
function codexHome({ env, home }: UserContext): string {
  const fromEnv = env[CODEX_HOME_ENV];
  return fromEnv === undefined || fromEnv === ""
    ? join(home, ".codex")
    : resolve(fromEnv);
}

/** A scope's files: the hooks file and the server's config, relative for the project's, absolute for the global scope's. */
interface CodexFiles {
  root: string;
  hooks: string;
  server: TomlTableEntry;
}

function scopeFiles(ctx: AdapterContext, scope: Scope): CodexFiles {
  if (scope === "project") {
    return {
      root: projectOf(ctx).root,
      hooks: HOOKS,
      server: serverEntry(CONFIG),
    };
  }
  const home = codexHome(ctx);
  return {
    root: rootOf(ctx),
    hooks: join(home, "hooks.json"),
    server: serverEntry(join(home, "config.toml")),
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

/** Whether the global hooks file holds 0.2.0's unmarked group; false when it cannot be read. */
async function holdsUnmarkedGroup(
  root: string,
  file: string
): Promise<boolean> {
  const read = await configDocument(root, file);
  return "doc" in read && (UNMARKED_GLOBAL_HOOK.hasPart?.(read.doc) ?? false);
}

/** What to do about 0.2.0's unmarked group left in the global hooks file `file`. */
function unmarkedGroupWarning(file: string): string {
  return `${file} holds mdmem 0.2.0's unmarked hook group, which injects in every project beside the project's own hook — run \`mdmem enable ${ID}\` to replace it with the global scope's, or \`mdmem disable ${ID}\` to remove it`;
}

/** A scope's files that cannot be read: its hooks file's and its config's. */
function scopeUnreadable(
  hooks: { unreadable: UnreadableFile[] },
  server: { unreadable?: UnreadableFile }
): UnreadableFile[] {
  return [
    ...hooks.unreadable,
    ...(server.unreadable === undefined ? [] : [server.unreadable]),
  ];
}

/** Whether `path` is a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The hooks files Codex reads for a session in `cwd`: each folder from `cwd` up to
 * the work tree's root `root` that holds a .codex directory gives one, read in a
 * linked worktree from the main checkout's matching folder.
 */
function sessionHooksFiles(cwd: string, root: string): string[] {
  const top = realDir(root);
  const start = realDir(cwd);
  const inside = start === top || start.startsWith(`${top}${sep}`);
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (!inside || dir === top || dir === dirname(dir)) {
      break;
    }
  }
  const main = mainCheckoutRoot(start);
  return dirs
    .filter((dir) => isDirectory(join(dir, ".codex")))
    .map((dir) =>
      main === null ? join(dir, HOOKS) : join(main, relative(top, dir), HOOKS)
    )
    .filter((file) => existsSync(file));
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
    const { root, hooks, server } = scopeFiles(ctx, scope);
    const global = scope === "global";
    const globalHooks = scopeFiles(ctx, "global").hooks;
    const unmarked = await holdsUnmarkedGroup(rootOf(ctx), globalHooks);
    // Plan both files before writing either, so an unparseable one refuses with nothing written.
    const hooksPlan = await planConfigs(
      root,
      [
        {
          file: hooks,
          entries: global
            ? [GLOBAL_HOOK_MIGRATING, GLOBAL_PROMPT_HOOK]
            : [PROJECT_HOOK, PROJECT_PROMPT_HOOK],
        },
      ],
      "add"
    );
    const plan: PlannedFile[] = [
      ...hooksPlan,
      await planTomlTable(root, server, "add"),
    ];
    const hooksChanged = hooksPlan.some(({ changed }) => changed.length > 0);
    const after: string[] = [];
    if (!global) {
      after.push(
        commitLine(
          [HOOKS, CONFIG],
          `they wire ${TITLE}`,
          "Codex reads them only in a trusted folder, and runs the hooks only once each person has reviewed them in an interactive session (`codex exec` never asks), once per clone: its worktrees share the review."
        )
      );
    }
    if (global && unmarked) {
      after.push(
        `replaced mdmem 0.2.0's unmarked hook group in ${hooks} with the global scope's, marked --global.`
      );
    }
    if (global && hooksChanged) {
      after.push(
        `Codex asks you once to review the hooks in ${hooks} it has not reviewed yet, at its next interactive start or in /hooks; until then it runs none of them, and \`codex exec\` never asks.`
      );
    }
    return {
      write: async () => {
        await writeConfigs(plan);
        return {
          title: TITLE,
          actions: [...describePlan(plan, "add"), ...after],
          warnings:
            !global && unmarked ? [unmarkedGroupWarning(globalHooks)] : [],
        };
      },
    };
  },

  async disable(ctx: AdapterContext, scope: Scope): Promise<WiringPlan> {
    if (scope === "project" && ctx.project === undefined) {
      return outsideProjectPlan(TITLE);
    }
    const { root, hooks, server } = scopeFiles(ctx, scope);
    // The global scope also takes out 0.2.0's unmarked group, which its file may still hold.
    const entries =
      scope === "global"
        ? [GLOBAL_HOOK, GLOBAL_PROMPT_HOOK, UNMARKED_GLOBAL_HOOK]
        : [PROJECT_HOOK, PROJECT_PROMPT_HOOK];
    const plan = [
      ...(await planConfigs(root, [{ file: hooks, entries }], "remove")),
      await planTomlTable(root, server, "remove"),
    ];
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

  // A global entry stays silent where a project hooks file Codex reads for the session holds the project's own entry for its part (ADR 0004).
  async hookVerdict(_ctx: UserContext, site: HookSite): Promise<HookVerdict> {
    if (!site.global) {
      return undefined;
    }
    const entry = projectPartEntry(site.part);
    for (const file of sessionHooksFiles(site.cwd, site.projectRoot())) {
      // oxlint-disable-next-line no-await-in-loop -- a few files, the nearest first
      const read = await configDocument(site.cwd, file);
      if ("doc" in read && entry.has(read.doc)) {
        return { silence: globalSilence(file, site.part) };
      }
    }
    return undefined;
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const global = scopeFiles(ctx, "global");
    const globalFiles: JsonConfigFile[] = [
      { file: global.hooks, entries: [GLOBAL_HOOK, GLOBAL_PROMPT_HOOK] },
    ];
    const globalHooks = await configStatus(global.root, globalFiles);
    const globalServer = await tomlTableStatus(global.root, global.server);
    const project = wiredProject(ctx);
    const inProject =
      project === undefined
        ? undefined
        : {
            hooks: await configStatus(project.root, [
              { file: HOOKS, entries: [PROJECT_HOOK, PROJECT_PROMPT_HOOK] },
            ]),
            server: await tomlTableStatus(project.root, serverEntry(CONFIG)),
          };
    const scopes = [
      {
        scope: "global" as const,
        entries: [
          ...globalHooks.entries,
          serverWiringEntry(global.server, globalServer),
        ],
      },
      ...(inProject === undefined
        ? []
        : [
            {
              scope: "project" as const,
              entries: [
                ...inProject.hooks.entries,
                serverWiringEntry(serverEntry(CONFIG), inProject.server),
              ],
            },
          ]),
    ].map(({ scope, entries }) =>
      scopeStatus(
        scope,
        entries,
        entries.some(({ present }) => present)
      )
    );
    // Without CODEX_HOME, the user files read may not be the ones Codex reads, so they stay status warnings.
    const userKnown = !ctx.unknownEnv?.includes(CODEX_HOME_ENV);
    const userUnreadable = scopeUnreadable(globalHooks, globalServer);
    const projectUnreadable =
      inProject === undefined
        ? []
        : scopeUnreadable(inProject.hooks, inProject.server);
    const unmarked =
      userKnown && (await holdsUnmarkedGroup(global.root, global.hooks));
    return agentStatus(
      codexAdapter,
      {
        scopes,
        unreadable: [
          ...projectUnreadable,
          ...(userKnown ? userUnreadable : []),
        ],
        warnings: [
          ...(userKnown ? [] : userUnreadable.map(unreadableRefusal)),
          ...(unmarked ? [unmarkedGroupWarning(global.hooks)] : []),
        ],
      },
      (enabled) => ({
        problems: scopes
          .filter(
            ({ scope }) =>
              enabled.has(scope) && (scope === "project" || userKnown)
          )
          .flatMap(({ scope, entries }) =>
            missingHooksProblem(codexAdapter, scope, entries, partsIn)
          ),
        notes: [
          enabled.has("project")
            ? `${TITLE} reads ${HOOKS} and ${CONFIG} only in a trusted folder, and runs a hook only once you have reviewed it in an interactive session (\`codex exec\` never asks): mdmem does not check either.`
            : `${TITLE} runs a hook only once you have reviewed it in an interactive session (\`codex exec\` never asks): mdmem does not check that.`,
        ],
      })
    );
  },
};
