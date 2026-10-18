import { homedir } from "node:os";
import { dirname } from "node:path";

import { checkStore } from "../core/check.ts";
import type { Check } from "../core/check.ts";
import {
  isIgnoredByGit,
  outermostSuperproject,
  repositoryRoot,
  workTreeRoot,
  worktreePaths,
} from "../core/git.ts";
import { openStore } from "../core/operations.ts";
import { RefusalError } from "../core/refusal.ts";
import { locateStore, MemoryStore, STORE_DIR } from "../core/store.ts";
import type { AdapterContext, AgentStatus } from "./adapter.ts";
import { getAdapter, listAdapters } from "./index.ts";

/**
 * What the check and `mdmem status` report about a project beyond its store: the
 * states that silently break sharing (ADR 0003 has no fallback when hooks do not
 * run). A state that breaks saving or injection and that the user can fix is a
 * check problem: an agent's hook missing or switched off, Claude Code's auto memory
 * still on, mdmem not on PATH. A state that is the user's choice, depends on where
 * status runs, or that mdmem does not read is a status line only: the store not
 * ignored by git, Bob launched below the checkout's root, a submodule of a wired
 * project, folder trust.
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

/**
 * The context `mdmem enable` works in: the working directory's work tree and the
 * project's store. Refused in a repository with no work tree here (a bare
 * repository, or the folder holding one at `<dir>/.git`), where no agent reads the
 * files enable would write, and without a store. Outside git, the store's project
 * directory is wired.
 */
export function enableContext(cwd: string): AdapterContext {
  if (workTreeRoot(cwd) === null && repositoryRoot(cwd) !== null) {
    const worktrees = worktreePaths(cwd).filter(
      (path) => workTreeRoot(path) !== null
    );
    const where =
      worktrees.length > 0
        ? `run it in one of the repository's worktrees (\`git worktree list\`): ${worktrees.join(", ")}`
        : "add a worktree with `git worktree add <path>` and run it there";
    throw new RefusalError(
      `${cwd} is not in a work tree (a bare repository, or the folder holding one), and agents read their files only from a work tree: ${where}`
    );
  }
  return adapterContext(cwd, openStore(cwd));
}

/**
 * The context `mdmem disable` works in, which needs no store: the store's location
 * (a `.memory/` that may not exist), and whether no project holds `cwd` at all (no
 * repository, no store), where disable leaves project files alone.
 */
export function disableContext(cwd: string): {
  ctx: AdapterContext;
  outsideProject: boolean;
} {
  const location = locateStore(cwd);
  return {
    ctx: adapterContext(cwd, new MemoryStore(location.dir)),
    outsideProject: !location.exists && repositoryRoot(cwd) === null,
  };
}

function agentStatuses(ctx: AdapterContext): Promise<AgentStatus[]> {
  return Promise.all(listAdapters().map((adapter) => adapter.status(ctx)));
}

/** The outermost superproject's root and agent statuses when status runs in a submodule, else null. */
async function superprojectStatuses(
  ctx: AdapterContext
): Promise<{ root: string; agents: AgentStatus[] } | null> {
  const root = outermostSuperproject(ctx.cwd);
  if (root === null) {
    return null;
  }
  return {
    root,
    agents: await agentStatuses({ ...ctx, projectRoot: root, cwd: root }),
  };
}

/**
 * Run in a submodule, whose own work tree an agent started here reads, not the
 * superproject's: a warning naming the agents the superproject is wired for and
 * the submodule is not, whose sessions here get none of that wiring.
 */
function submoduleWarnings(
  superproject: { root: string; agents: readonly AgentStatus[] } | null,
  submoduleAgents: readonly AgentStatus[]
): string[] {
  if (superproject === null) {
    return [];
  }
  const unwiredHere = superproject.agents.filter(
    ({ enabled, id }) =>
      enabled &&
      !submoduleAgents.some((status) => status.id === id && status.enabled)
  );
  if (unwiredHere.length === 0) {
    return [];
  }
  const titles = unwiredHere.map(({ title }) => title).join(", ");
  const clauses = unwiredHere
    .flatMap(({ id }) => getAdapter(id)?.submoduleClause ?? [])
    .map((clause) => `; ${clause}`)
    .join("");
  return [
    `This is a submodule of ${superproject.root}, which is wired for ${titles}: an agent started here reads the submodule's own files, not the superproject's, so its sessions get no memory protocol, no index and no mdmem tools${clauses}. Start agents at ${superproject.root}.`,
  ];
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
  /** Status only, as warnings, about the project rather than one agent: status run in a submodule of a wired project. */
  warnings: string[];
}

export async function projectStatus(
  ctx: AdapterContext
): Promise<ProjectStatus> {
  const [check, agents, superproject] = await Promise.all([
    checkStore(ctx.store),
    agentStatuses(ctx),
    superprojectStatuses(ctx),
  ]);
  const wiring = wiringProblems(ctx, agents);
  return {
    // the check counts every memory file, the unparseable ones included
    memoryCount: check.memoryCount - check.unparseable,
    check: withWiring(check, wiring),
    wiringProblems: wiring,
    ignored: isIgnoredByGit(dirname(ctx.store.root), STORE_DIR),
    agents,
    warnings: submoduleWarnings(superproject, agents),
  };
}
