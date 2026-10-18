/**
 * An Adapter wires one agent to the project's memory store in that agent's own
 * files (ADR 0003): its session-start hooks and its registration of the mdmem MCP
 * server, plus whatever else the agent needs (Claude Code: its auto memory off and
 * its memories imported). Each adapter declares its entries; enable adds the
 * missing ones, disable removes exactly mdmem's, and status reports each one.
 * Adapters are the only agent-specific code; everything else is agent-neutral.
 */

import type { ImportPreference } from "../core/import.ts";
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
}

export interface EnableOptions {
  /** Claude Code: which side the import keeps on a same-name conflict between Claude's memories and the store. */
  prefer?: ImportPreference;
}

export interface DisableOptions {
  /** Codex (mdmem-4wz.10): also remove mdmem's handlers from the user-wide hooks file. Ignored by agents with no user-wide entries. */
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

/** One piece of an agent's wiring, in one of its files. */
export interface WiringEntry {
  label: string;
  /** The file holding it, relative to the project root, or absolute when it lives outside the project. */
  file: string;
  present: boolean;
}

export interface AgentStatus {
  title: string;
  /** Every entry is present. */
  wired: boolean;
  /** The project is wired for the agent, wholly or in part: some of mdmem's own entries for the project are present. */
  enabled: boolean;
  entries: WiringEntry[];
  /** What keeps the wiring of an enabled agent from working, as far as mdmem can see: the check reports each one. */
  problems: string[];
  /** Status only, as warnings: a file that could not be read, so its entries count as missing, or a state that depends on where status runs. */
  warnings: string[];
  /** Status only, under the agent: what the agent decides that mdmem cannot read, such as folder trust. */
  notes: string[];
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
  const missing = entries.filter(
    (entry) => hooksIn(entry) > 0 && !entry.present
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
  readonly id: string;
  readonly title: string;
  /** The agent's command: on PATH, it counts the agent as found on this machine for `--all`. */
  readonly command: string;
  /** The agent's config directory, relative to the home directory: when it exists, the agent counts as found too. */
  readonly configDir: string;
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
   * For an agent whose session-start hook is user-wide (Codex), whether the project
   * at `projectRoot` is wired for it: the hook stays silent where it is not.
   * Absent for an agent whose hooks live in the project's own files, which disable
   * removes.
   */
  projectWired?: (projectRoot: string) => Promise<boolean>;
}
