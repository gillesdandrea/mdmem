/**
 * An Adapter wires one agent to the project's memory store in that agent's own
 * files (ADR 0003): its session-start hooks and its registration of the mdmem MCP
 * server, plus whatever else the agent needs (Claude Code: its auto memory off and
 * its memories imported). Each adapter declares its entries; enable adds the
 * missing ones, disable removes exactly mdmem's, and status reports each one.
 * Adapters are the only agent-specific code; everything else is agent-neutral.
 */

import { isAbsolute } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookAgent, HookPart } from "../core/hook.ts";
import type { ImportPreference } from "../core/import.ts";
import { isObject } from "../core/object.ts";
import type { MemoryStore } from "../core/store.ts";

export interface AdapterContext {
  /** The work tree whose agent files are wired: the working directory's own checkout, else the store's project directory. */
  projectRoot: string;
  /** The project's memory store. */
  store: MemoryStore;
  /** The environment agents read their own directories from (`CLAUDE_CONFIG_DIR`, …). */
  env: Record<string, string | undefined>;
  /** The home directory agents keep their user-wide files under. */
  home: string;
  /** The directory mdmem runs in: an agent launched there reads only the files it finds from there. */
  cwd: string;
  /**
   * Variables the agents may read from their own environment that `env` cannot
   * show: the agent that started this process passed it only some of its own
   * (Codex starts the MCP server without `CODEX_HOME`). A state read through one
   * of them cannot be known, so the check does not report it.
   */
  unknownEnv?: readonly string[];
}

export interface EnableOptions {
  /** Claude Code: which side the import keeps on a same-name conflict between Claude's memories and the store. */
  prefer?: ImportPreference;
}

export interface DisableOptions {
  /** Codex: also remove mdmem's handlers from the user-wide hooks file. Ignored by agents with no user-wide entries. */
  global?: boolean;
  /**
   * No project holds the working directory (no repository, no store): leave the
   * project files alone, since the working directory may be one whose agent files
   * are user-wide (the home directory), and act on user-wide entries only.
   */
  outsideProject?: boolean;
}

/** What enable or disable did, as the CLI prints it. */
export interface WiringResult {
  title: string;
  /** One line each; a line may be indented under the one before it. */
  actions: string[];
  /** Printed as warnings: they do not mean the wiring failed. */
  warnings: string[];
}

/**
 * What enable or disable will do: every file read and every refusal raised, nothing
 * written yet. No two adapters write the same file, so one adapter's plan stays
 * valid while another's is written: that is what lets the CLI plan every agent
 * before writing any.
 */
export interface WiringPlan {
  /** Write the planned changes and report them. */
  write: () => Promise<WiringResult>;
}

/** What enable (`add`) or disable (`remove`) does to mdmem's entries. */
export type WiringMode = "add" | "remove";

/** One piece of an agent's wiring, in one of its files. */
export interface WiringEntry {
  label: string;
  /** The file holding it, relative to the project root, or absolute when it lives outside the project. */
  file: string;
  present: boolean;
  /** Its file exists but cannot be read, so the entry counts as missing and the check reports the file instead. */
  unreadable?: boolean;
}

/** An agent config file that exists but cannot be read as the document mdmem expects. */
export interface UnreadableFile {
  /** Relative to the project root, or absolute when it lives outside the project. */
  file: string;
  /** Why, after the file's name: "is not valid JSON (<the parser's reason>)", "does not hold a JSON object", … */
  reason: string;
}

/** The refusal of a file that cannot be read, as enable and disable raise it: fix it, then run the command again. */
export function unreadableRefusal({ file, reason }: UnreadableFile): string {
  return `${file} ${reason}: fix it, then run the command again`;
}

export interface AgentStatus {
  /** The adapter's id. */
  id: HookAgent;
  title: string;
  /** Every entry is present. */
  wired: boolean;
  /** The project is wired for the agent, wholly or in part: some of mdmem's own entries for the project are present. */
  enabled: boolean;
  entries: WiringEntry[];
  /**
   * What keeps the wiring from working, as far as mdmem can see: the check reports
   * each one. A project file of the agent's that cannot be read is one whether or
   * not the project is enabled for the agent; everything else only when it is.
   */
  problems: string[];
  /** Status only, as warnings: a user-wide file that could not be read while the check leaves it out, or a state that depends on where status runs. */
  warnings: string[];
  /** Status only, under the agent: what the agent decides that mdmem cannot read, such as folder trust. */
  notes: string[];
}

/** The mdmem MCP server, as every agent's config registers it (Claude Code's adds its transport type). */
export const MCP_SERVER = { command: "mdmem", args: ["mcp"] };

/**
 * What makes a value at a key mdmem owns mdmem's, whatever else the user added to
 * it, and how the user makes room for mdmem's when the key holds another value.
 */
export interface KeyIdentity {
  matches: (value: unknown) => boolean;
  /** The fix a refusal of the other value names, such as "remove it or set it to false". */
  fix: string;
}

/** An MCP server entry is mdmem's when it runs MCP_SERVER's command and args; its other fields (type, env, timeouts, …) are the user's. */
export const MCP_SERVER_IDENTITY: KeyIdentity = {
  matches: (value) =>
    isObject(value) &&
    value.command === MCP_SERVER.command &&
    Bun.deepEquals(value.args, MCP_SERVER.args),
  fix: `remove or rename it, or set its command to ${JSON.stringify(MCP_SERVER.command)} and its args to ${JSON.stringify(MCP_SERVER.args)}`,
};

/** The command of the agent's session-start hook that injects `part`. */
export function hookCommand(agent: HookAgent, part: HookPart): string {
  return `mdmem hook ${agent} ${part}`;
}

/** The commands of the agent's session-start hooks, one per part. */
export function hookCommands(agent: HookAgent): string[] {
  return HOOK_PARTS.map((part) => hookCommand(agent, part));
}

/** The label of an entry holding the session-start hooks that run `commands`. */
export function hooksLabel(commands: readonly string[]): string {
  const quoted = commands.map((command) => `"${command}"`).join(", ");
  return `SessionStart ${commands.length === 1 ? "hook" : "hooks"} ${quoted}`;
}

/**
 * The action line of enable telling the user to commit the agent's project files
 * `files`, which `what` ("they wire …"), and what the agent then requires `after`.
 */
export function commitLine(
  files: readonly string[],
  what: string,
  after?: string
): string {
  const tail = after === undefined ? "" : ` ${after}`;
  return `Commit ${files.join(" and ")}: ${what} for everyone working in the repository, who then needs mdmem on PATH.${tail}`;
}

/** What an agent's status holds only when the project is enabled for it. */
export interface EnabledStatus {
  problems: string[];
  /** User-wide files read only for an enabled agent that cannot be read: a problem each, before `problems`. */
  unreadable?: UnreadableFile[];
  /** After the warnings about the agent's files. */
  warnings?: string[];
  notes: string[];
}

/** The check's problem for an agent file that cannot be read: it replaces the problems of the entries and values in it. */
function unreadableProblem(
  adapter: Pick<Adapter, "title">,
  { file, reason }: UnreadableFile
): string {
  return `${adapter.title}: ${file} ${reason}: fix it, then run the check again`;
}

/**
 * An agent's status from its entries: wired when every entry is present, and with
 * the problems, notes and further warnings of `whenEnabled`, which runs only when
 * the project is `enabled` for the agent. Of the `unreadable` files, a project
 * file is a problem whatever `enabled` says, since mdmem cannot tell what it
 * wires; a user-wide file (an absolute path) is one only for an enabled agent, and
 * a warning otherwise.
 */
export async function agentStatus(
  adapter: Pick<Adapter, "id" | "title">,
  {
    entries,
    enabled,
    unreadable,
    warnings,
  }: {
    entries: WiringEntry[];
    enabled: boolean;
    unreadable: readonly UnreadableFile[];
    warnings: string[];
  },
  whenEnabled: () => EnabledStatus | Promise<EnabledStatus>
): Promise<AgentStatus> {
  const more: EnabledStatus = enabled
    ? await whenEnabled()
    : { problems: [], notes: [] };
  const reported = (file: UnreadableFile): boolean =>
    enabled || !isAbsolute(file.file);
  return {
    id: adapter.id,
    title: adapter.title,
    wired: entries.every(({ present }) => present),
    enabled,
    entries,
    problems: [
      ...[...unreadable.filter(reported), ...(more.unreadable ?? [])].map(
        (file) => unreadableProblem(adapter, file)
      ),
      ...more.problems,
    ],
    warnings: [
      ...unreadable.filter((file) => !reported(file)).map(unreadableRefusal),
      ...warnings,
      ...(more.warnings ?? []),
    ],
    notes: more.notes,
  };
}

/**
 * The problem of an enabled agent whose session-start hooks are missing: its
 * sessions start without the protocol, the index or both. `hooksIn` says how many
 * hooks an entry holds, 0 for an entry that is not a hook.
 */
export function missingHooksProblem(
  adapter: Pick<Adapter, "id" | "title">,
  entries: readonly WiringEntry[],
  hooksIn: (entry: WiringEntry) => number
): string[] {
  // An entry in a file that cannot be read is reported as that file instead.
  const missing = entries.filter(
    (entry) => hooksIn(entry) > 0 && !entry.present && !entry.unreadable
  );
  if (missing.length === 0) {
    return [];
  }
  const where = missing.map(({ label, file }) => `${label} (${file})`);
  const injected =
    missing.reduce((count, entry) => count + hooksIn(entry), 0) === 1
      ? "what that hook injects"
      : "what those hooks inject";
  return [
    `${adapter.title}: missing ${where.join(", ")}, so its sessions start without ${injected} — run \`mdmem enable ${adapter.id}\``,
  ];
}

/** What disable says of an agent's project files when no project holds the working directory, so it leaves them alone. */
export const OUTSIDE_PROJECT_LINE =
  "not in a project (no repository, no store here), so no project files were changed: run the command in the project's checkout";

/** The plan of disabling an agent with no user-wide entries outside a project: it changes nothing. */
export function outsideProjectPlan(title: string): WiringPlan {
  const result: WiringResult = {
    title,
    actions: [OUTSIDE_PROJECT_LINE],
    warnings: [],
  };
  return { write: () => Promise.resolve(result) };
}

export interface Adapter {
  readonly id: HookAgent;
  readonly title: string;
  /** The agent's command: on PATH, it counts the agent as found on this machine for `--all`. */
  readonly command: string;
  /** The agent's config directory, as the agent resolves it from the environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): when it exists, the agent counts as found too. */
  readonly configDir: (ctx: Pick<AdapterContext, "env" | "home">) => string;
  /**
   * Plan adding the entries that are missing, merging into the agent's files and
   * leaving their other content as it was; running it again changes nothing. A
   * refusal (an unparseable file, an import conflict) throws a RefusalError while
   * planning, before any file is written.
   */
  enable: (ctx: AdapterContext, options: EnableOptions) => Promise<WiringPlan>;
  /** Plan removing exactly mdmem's entries; a file left holding nothing else is deleted. The store is untouched. */
  disable: (
    ctx: AdapterContext,
    options: DisableOptions
  ) => Promise<WiringPlan>;
  status: (ctx: AdapterContext) => Promise<AgentStatus>;
  /**
   * What an agent started in a submodule of a project wired for it misses beyond
   * the protocol, the index and the tools: a clause of status's submodule warning.
   */
  readonly submoduleClause?: string;
  /**
   * For an agent whose session-start hook is user-wide (Codex), whether the project
   * at `projectRoot` is wired for it: the hook stays silent where it is not.
   * Absent for an agent whose hooks live in the project's own files, which disable
   * removes.
   */
  projectWired?: (projectRoot: string) => Promise<boolean>;
}

/** The adapter of agent `K`: its id is `K` itself, so a registry keyed by agent can check each key against its adapter. */
export type AdapterFor<K extends HookAgent> = Adapter & { readonly id: K };
