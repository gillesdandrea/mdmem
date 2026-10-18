import { homedir } from "node:os";
import { dirname } from "node:path";

import { checkStore } from "../core/check.ts";
import type { Check } from "../core/check.ts";
import { isIgnoredByGit, workTreeRoot } from "../core/git.ts";
import { STORE_DIR } from "../core/store.ts";
import type { MemoryStore } from "../core/store.ts";
import type { AdapterContext, AgentStatus } from "./adapter.ts";
import { listAdapters } from "./index.ts";

/**
 * What the check and `mdmem status` report about a project beyond its store: the
 * states that silently break sharing (ADR 0003 has no fallback when hooks do not
 * run). A state that breaks saving or injection and that the user can fix is a
 * check problem: an agent's hook missing or switched off, Claude Code's auto memory
 * still on, mdmem not on PATH. A state that is the user's choice, depends on where
 * status runs, or that mdmem does not read is a status line only: the store not
 * ignored by git, Bob launched below the checkout's root, folder trust.
 */

/**
 * The context adapters work in from `cwd`: they wire the working directory's own
 * work tree (a linked worktree or submodule, not the checkout holding the store),
 * else the store's project directory.
 */
export function adapterContext(
  cwd: string,
  store: MemoryStore,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): AdapterContext {
  return {
    projectRoot: workTreeRoot(cwd) ?? dirname(store.root),
    store,
    env,
    home,
    cwd,
  };
}

function agentStatuses(ctx: AdapterContext): Promise<AgentStatus[]> {
  return Promise.all(listAdapters().map((adapter) => adapter.status(ctx)));
}

/** mdmem missing from PATH while an agent is enabled: its hooks and MCP server all run `mdmem`. */
function pathProblem(
  ctx: AdapterContext,
  statuses: readonly AgentStatus[]
): string[] {
  const enabled = statuses.filter((status) => status.enabled);
  if (
    enabled.length === 0 ||
    Bun.which("mdmem", { PATH: ctx.env.PATH ?? "" }) !== null
  ) {
    return [];
  }
  const titles = enabled.map(({ title }) => title).join(", ");
  return [
    `mdmem is not on PATH, so the session-start hooks and the MCP server wired for ${titles}, which run \`mdmem\`, fail — put it on PATH (\`bun link\` in mdmem's checkout)`,
  ];
}

/** The problems of the agents' wiring, as the check reports them. */
function wiringProblems(
  ctx: AdapterContext,
  statuses: readonly AgentStatus[]
): string[] {
  return [
    ...statuses.flatMap(({ problems }) => problems),
    ...pathProblem(ctx, statuses),
  ];
}

/** The store's Check with the wiring's problems after its own. */
function withWiring(check: Check, wiring: readonly string[]): Check {
  return { ...check, problems: [...check.problems, ...wiring] };
}

/** Run the check: the store's Check, then the problems of the agents' wiring. It never writes. */
export async function checkProject(ctx: AdapterContext): Promise<Check> {
  const [check, statuses] = await Promise.all([
    checkStore(ctx.store),
    agentStatuses(ctx),
  ]);
  return withWiring(check, wiringProblems(ctx, statuses));
}

/** Everything `mdmem status` reports. */
export interface ProjectStatus {
  /** The memories that parse. */
  memoryCount: number;
  /** The check, wiring included. */
  check: Check;
  /** Of the check's problems, those of the wiring, which status prints as warnings. */
  wiringProblems: string[];
  /** Whether git ignores the store; undefined when git cannot tell. */
  ignored: boolean | undefined;
  agents: AgentStatus[];
}

export async function projectStatus(
  ctx: AdapterContext
): Promise<ProjectStatus> {
  const [check, agents] = await Promise.all([
    checkStore(ctx.store),
    agentStatuses(ctx),
  ]);
  const wiring = wiringProblems(ctx, agents);
  return {
    // the check counts every memory file, the unparseable ones included
    memoryCount: check.memoryCount - check.unparseable,
    check: withWiring(check, wiring),
    wiringProblems: wiring,
    ignored: isIgnoredByGit(dirname(ctx.store.root), STORE_DIR),
    agents,
  };
}
