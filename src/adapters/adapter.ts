/**
 * An Adapter wires one agent to mdmem in that agent's own files, in one of two
 * scopes (ADR 0003, ADR 0004): global, in its user-wide files, so it applies in
 * every project; or project, in files committed with one repository. The wiring is
 * its session-start hooks and its registration of the mdmem MCP server, plus
 * whatever else the agent needs (Claude Code: its auto memory off, and its memories
 * imported when a store is created). Each adapter declares its entries per scope;
 * enable adds the missing ones, disable removes exactly mdmem's, and status reports
 * each one. Adapters are the only agent-specific code; everything else is
 * agent-neutral.
 */

import { isAbsolute } from "node:path";

import { HOOK_PARTS } from "../core/hook.ts";
import type { HookAgent, HookPart, HookSite } from "../core/hook.ts";
import { isObject } from "../core/object.ts";
import type { SessionHistory } from "../core/protocol.ts";
import type { MemoryStore } from "../core/store.ts";

/** Where an agent's wiring lives (GLOSSARY.md): its user-wide files, or one repository's. */
export const SCOPES = ["global", "project"] as const;
export type Scope = (typeof SCOPES)[number];

/** The project an adapter works in. */
export interface ProjectContext {
  /** The work tree whose project files are wired: the working directory's own checkout, else the store's project directory. */
  root: string;
  /** The project's memory store, which may not exist yet. */
  store: MemoryStore;
}

/** What an agent's user-wide files are resolved from. */
export interface UserContext {
  /** The environment agents read their own directories from (`CLAUDE_CONFIG_DIR`, …). */
  env: Record<string, string | undefined>;
  /** The home directory agents keep their user-wide files under. */
  home: string;
}

export interface AdapterContext extends UserContext {
  /** The project holding the working directory; undefined outside any project (no repository, no store), where only the global scope applies. */
  project?: ProjectContext;
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

/** The project of a context that must have one: project-scope wiring is planned only in a project. */
export function projectOf(ctx: AdapterContext): ProjectContext {
  if (ctx.project === undefined) {
    throw new Error(
      `${ctx.cwd} is in no project; project-scope wiring is planned only in one`
    );
  }
  return ctx.project;
}

/** The directory project files resolve against: the project's work tree, else the working directory (only absolute files are read there). */
export function rootOf(ctx: AdapterContext): string {
  return ctx.project?.root ?? ctx.cwd;
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

/** An agent's wiring in one scope. */
export interface ScopeStatus {
  scope: Scope;
  /** Every entry of the scope is present. */
  wired: boolean;
  /** The agent is wired in this scope, wholly or in part: some of mdmem's own entries of the scope are present. */
  enabled: boolean;
  entries: WiringEntry[];
}

export interface AgentStatus {
  /** The adapter's id. */
  id: HookAgent;
  title: string;
  /** Every entry of at least one scope is present. */
  wired: boolean;
  /** Some scope is enabled for the agent. */
  enabled: boolean;
  /** The global scope, then the project scope when status runs in a project. */
  scopes: ScopeStatus[];
  /**
   * What keeps the wiring from working, as far as mdmem can see: the check reports
   * each one. A project file of the agent's that cannot be read is one whether or
   * not the agent is enabled; everything else only when some scope is.
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

/** The marker of a global hook entry, which project entries leave out so a 0.2.0 repository needs no migration (ADR 0004). */
export const GLOBAL_HOOK_FLAG = "--global";

/** The command of the agent's session-start hook that injects `part`; a global entry's carries GLOBAL_HOOK_FLAG. */
export function hookCommand(
  agent: HookAgent,
  part: HookPart,
  global = false
): string {
  return `mdmem hook ${agent} ${part}${global ? ` ${GLOBAL_HOOK_FLAG}` : ""}`;
}

/** The commands of the agent's session-start hooks, one per part. */
export function hookCommands(agent: HookAgent, global = false): string[] {
  return HOOK_PARTS.map((part) => hookCommand(agent, part, global));
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

/** What an agent's status holds only when some scope is enabled for it. */
export interface EnabledStatus {
  problems: string[];
  /** User-wide files read only for an enabled agent that cannot be read: a problem each, before `problems`. */
  unreadable?: UnreadableFile[];
  /** After the warnings about the agent's files. */
  warnings?: string[];
  notes: string[];
}

/** The command that wires `agent` in `scope`. */
export function enableCommand(agent: HookAgent, scope: Scope): string {
  return `mdmem enable ${agent}${scope === "project" ? " --project" : ""}`;
}

/**
 * How a check problem that `mdmem enable <agent>` fixes in `scope` ends; while
 * files that enable refuses on cannot be read, it says to fix them first.
 */
export function enableAdvice(
  agent: HookAgent,
  scope: Scope,
  fixFirst: readonly string[] = []
): string {
  const fix =
    fixFirst.length === 0 ? "" : `fix ${fixFirst.join(" and ")}, then `;
  return ` — ${fix}run \`${enableCommand(agent, scope)}\``;
}

/** The check's problem for an agent file that cannot be read: it replaces the problems of the entries and values in it. */
function unreadableProblem(
  adapter: Pick<Adapter, "title">,
  { file, reason }: UnreadableFile
): string {
  return `${adapter.title}: ${file} ${reason}: fix it, then run the check again`;
}

/**
 * An agent's status from its scopes: wired when every entry of some scope is
 * present, and with the problems, notes and further warnings of `whenEnabled`,
 * which runs only when some scope is enabled and gets those scopes. Of the
 * `unreadable` files, a project file is a problem whatever is enabled, since mdmem
 * cannot tell what it wires; a user-wide file (an absolute path) is one only for an
 * enabled agent, and a warning otherwise. While a file holding a scope's entries,
 * which enable reads and refuses on, cannot be read, each other problem ending in
 * that scope's `enableAdvice` says to fix that file first.
 */
export async function agentStatus(
  adapter: Pick<Adapter, "id" | "title">,
  {
    scopes,
    unreadable,
    warnings,
  }: {
    scopes: ScopeStatus[];
    unreadable: readonly UnreadableFile[];
    warnings: string[];
  },
  whenEnabled: (
    enabled: ReadonlySet<Scope>
  ) => EnabledStatus | Promise<EnabledStatus>
): Promise<AgentStatus> {
  const enabledScopes = new Set(
    scopes.filter(({ enabled }) => enabled).map(({ scope }) => scope)
  );
  const enabled = enabledScopes.size > 0;
  const more: EnabledStatus = enabled
    ? await whenEnabled(enabledScopes)
    : { problems: [], notes: [] };
  const reported = (file: UnreadableFile): boolean =>
    enabled || !isAbsolute(file.file);
  const unreadableProblems = [
    ...unreadable.filter(reported),
    ...(more.unreadable ?? []),
  ];
  const problems = more.problems.map((problem) => {
    for (const { scope, entries } of scopes) {
      const advice = enableAdvice(adapter.id, scope);
      if (!problem.endsWith(advice)) {
        continue;
      }
      const entryFiles = new Set(entries.map(({ file }) => file));
      const refusedByEnable = unreadableProblems
        .map(({ file }) => file)
        .filter((file) => entryFiles.has(file));
      return refusedByEnable.length === 0
        ? problem
        : `${problem.slice(0, -advice.length)}${enableAdvice(adapter.id, scope, refusedByEnable)}`;
    }
    return problem;
  });
  return {
    id: adapter.id,
    title: adapter.title,
    wired: scopes.some((scope) => scope.wired),
    enabled,
    scopes,
    problems: [
      ...unreadableProblems.map((file) => unreadableProblem(adapter, file)),
      ...problems,
    ],
    warnings: [
      ...unreadable.filter((file) => !reported(file)).map(unreadableRefusal),
      ...warnings,
      ...(more.warnings ?? []),
    ],
    notes: more.notes,
  };
}

/** A scope's status from its entries: wired when every one is present, enabled as the adapter decides. */
export function scopeStatus(
  scope: Scope,
  entries: WiringEntry[],
  enabled: boolean
): ScopeStatus {
  return {
    scope,
    wired: entries.every(({ present }) => present),
    enabled,
    entries,
  };
}

/**
 * The problem of an enabled agent whose session-start hooks are missing: its
 * sessions start without the protocol, the index or both. `hooksIn` says how many
 * hooks an entry holds, 0 for an entry that is not a hook.
 */
export function missingHooksProblem(
  adapter: Pick<Adapter, "id" | "title">,
  scope: Scope,
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
    `${adapter.title}: missing ${where.join(", ")}, so its sessions start without ${injected}${enableAdvice(adapter.id, scope)}`,
  ];
}

/** What `disable --project` says of an agent's project files when no project holds the working directory, so it leaves them alone. */
export const OUTSIDE_PROJECT_LINE =
  "not in a project (no repository, no store here), so no project files were changed: run the command in the project's checkout";

/** The plan of `disable --project` outside a project: it changes nothing. */
export function outsideProjectPlan(title: string): WiringPlan {
  const result: WiringResult = {
    title,
    actions: [OUTSIDE_PROJECT_LINE],
    warnings: [],
  };
  return { write: () => Promise.resolve(result) };
}

/** What an agent's own memories are imported for: a store being created, and where the agent keeps its directories. */
export interface ImportContext extends UserContext {
  store: MemoryStore;
}

/** An import planned, nothing written yet: writing it returns the lines to report (none when nothing was imported) and the warnings. */
export type PlannedMemoryImport = () => Promise<{
  lines: string[];
  warnings: string[];
}>;

export interface Adapter {
  readonly id: HookAgent;
  readonly title: string;
  /** The agent's command: on PATH, it counts the agent as found on this machine for `--all`. */
  readonly command: string;
  /** The agent's config directory, as the agent resolves it from the environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): when it exists, the agent counts as found too. */
  readonly configDir: (ctx: UserContext) => string;
  /**
   * Plan adding the scope's entries that are missing, merging into the agent's
   * files and leaving their other content as it was; running it again changes
   * nothing. The project scope needs `ctx.project`. A refusal (an unparseable
   * file, a key holding another value) throws a RefusalError while planning,
   * before any file is written.
   */
  enable: (ctx: AdapterContext, scope: Scope) => Promise<WiringPlan>;
  /**
   * Plan removing exactly mdmem's entries of the scope; a file left holding nothing
   * else is deleted. The store is untouched. The project scope outside a project
   * changes nothing.
   */
  disable: (ctx: AdapterContext, scope: Scope) => Promise<WiringPlan>;
  /** Both scopes' entries, the project's only in a project. */
  status: (ctx: AdapterContext) => Promise<AgentStatus>;
  /**
   * What an agent started in a submodule of a project wired for it misses beyond
   * the protocol, the index and the tools: a clause of status's submodule warning.
   */
  readonly submoduleClause?: string;
  /**
   * Whether the agent's session-start hook speaks at `site`, a project where a hook
   * may speak: a global entry stays silent where the project's own entries run.
   * Absent for an agent whose hook always speaks there.
   */
  hookSpeaks?: (ctx: UserContext, site: HookSite) => Promise<boolean>;
  /**
   * Plan importing the memories the agent kept in its own directories into a store
   * being created, for an agent wired in either scope with its own memory off.
   * Absent for an agent with nothing to import.
   */
  importMemories?: (ctx: ImportContext) => Promise<PlannedMemoryImport>;
  /**
   * Where the agent keeps its past sessions of the project at `projectRoot`, and how
   * to search them, as the consolidation prompt names them: its directories resolved
   * from the environment, as `configDir` resolves them. Absent for an agent whose
   * history is not files to grep (Bob's database), which keeps the prompt's generic line.
   */
  readonly sessionHistory?: (
    ctx: UserContext & { projectRoot: string }
  ) => SessionHistory;
}

/** The adapter of agent `K`: its id is `K` itself, so a registry keyed by agent can check each key against its adapter. */
export type AdapterFor<K extends HookAgent> = Adapter & { readonly id: K };
