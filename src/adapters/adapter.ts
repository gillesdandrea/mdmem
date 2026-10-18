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
}

export interface EnableOptions {
  /** Claude Code: which side the import keeps on a same-name conflict between Claude's memories and the store. */
  prefer?: ImportPreference;
}

export interface DisableOptions {
  /** Codex (mdmem-4wz.10): also remove mdmem's handlers from the user-wide hooks file. Ignored by agents with no user-wide entries. */
  global?: boolean;
}

/** What enable or disable did, as the CLI prints it. */
export interface WiringResult {
  title: string;
  /** One line each; a line may be indented under the one before it. */
  actions: string[];
  /** Printed as warnings: they do not mean the wiring failed. */
  warnings: string[];
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
  entries: WiringEntry[];
  /** A file that could not be read, so its entries count as missing. */
  warnings: string[];
}

export interface Adapter {
  readonly id: string;
  readonly title: string;
  /** The agent's command: on PATH, it counts the agent as found on this machine for `--all`. */
  readonly command: string;
  /** The agent's config directory, relative to the home directory: when it exists, the agent counts as found too. */
  readonly configDir: string;
  /**
   * Add the entries that are missing, merging into the agent's files and leaving
   * their other content as it was; running it again changes nothing. A refusal
   * (an unparseable file, an import conflict) throws a RefusalError before any
   * file is written.
   */
  enable: (
    ctx: AdapterContext,
    options: EnableOptions
  ) => Promise<WiringResult>;
  /** Remove exactly mdmem's entries; a file left holding nothing else is deleted. The store is untouched. */
  disable: (
    ctx: AdapterContext,
    options: DisableOptions
  ) => Promise<WiringResult>;
  status: (ctx: AdapterContext) => Promise<AgentStatus>;
}
