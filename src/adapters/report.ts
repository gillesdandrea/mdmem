import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { checkStore, formatCheck } from "../core/check.ts";
import type { Check } from "../core/check.ts";
import {
  isIgnoredByGit,
  outermostSuperproject,
  repositoryRoot,
  workTreeRoot,
  worktreePaths,
} from "../core/git.ts";
import { createStore, storeIgnored } from "../core/operations.ts";
import { RefusalError } from "../core/refusal.ts";
import { locateStore, MemoryStore, STORE_DIR } from "../core/store.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  PlannedMemoryImport,
  Scope,
} from "./adapter.ts";
import { getAdapter, listAdapters } from "./index.ts";

/**
 * What the check and `mdmem status` report about a project beyond its store: the
 * states that silently break sharing (ADR 0003 has no fallback when hooks do not
 * run). A state that breaks saving or injection and that the user can fix is a
 * check problem: an agent's hook missing or switched off, Claude Code's auto memory
 * still on, mdmem not on PATH. A state that is the user's choice, depends on where
 * status runs, or that mdmem does not read is a status line only: the store not
 * ignored by git, Bob launched below the checkout's root, a submodule of a wired
 * project, folder trust. Both work without a store and outside any project, where
 * they report the wiring alone (ADR 0004). Here too: the contexts the CLI and the
 * MCP server hand adapters, and the creation of a store on its first write.
 */

/**
 * The context adapters work in from `cwd`, in the project whose store is `store`:
 * they wire the working directory's own work tree (a linked worktree or submodule,
 * not the checkout holding the store), else the store's project directory. Without
 * a store, no project holds `cwd`, and only the global scope applies.
 */
export function adapterContext(
  cwd: string,
  store: MemoryStore | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): AdapterContext {
  return {
    ...(store === undefined
      ? {}
      : { project: { root: workTreeRoot(cwd) ?? dirname(store.root), store } }),
    env,
    home,
    cwd,
  };
}

/**
 * The context of the project holding `cwd`, which needs no store: a repository, or
 * outside git a directory holding a `.memory/`; outside both, no project.
 */
export function locateContext(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): AdapterContext {
  const location = locateStore(cwd);
  const inProject = location.exists || location.inRepository;
  return adapterContext(
    cwd,
    inProject ? new MemoryStore(location.dir) : undefined,
    env,
    home
  );
}

/**
 * The context `mdmem enable` works in. The global scope needs neither a project
 * nor a store. The project scope is refused in a repository with no work tree here
 * (a bare repository, or the folder holding one), where no agent reads the files
 * enable would write; elsewhere its project is the repository or, outside git, the
 * working directory (ADR 0004), whose store it creates once every agent is planned.
 */
export function enableContext(cwd: string, scope: Scope): AdapterContext {
  if (scope === "global") {
    return locateContext(cwd);
  }
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
  const location = locateStore(cwd);
  return adapterContext(cwd, new MemoryStore(location.dir));
}

/** What happened to a project's store on a write: created or not, and what creating it imported. */
export interface StoreCreation {
  store: MemoryStore;
  created: boolean;
  /** Whether git ignores the store; undefined outside a git work tree. */
  ignored: boolean | undefined;
  /** The import's report lines, none when nothing was imported. */
  imported: string[];
  /** The import's warnings: a copied file that looks like it holds a secret, and the index's. */
  warnings: string[];
}

/** The note a creating write adds when git does not ignore the store. */
export const IGNORE_NOTE = `Note: git does not ignore ${STORE_DIR}/; ignoring or committing it is your choice.`;

/** The lines a creating write reports before its own: the store's path, the import's lines, the note when git does not ignore it. */
export function creationLines(creation: StoreCreation): string[] {
  if (!creation.created) {
    return [];
  }
  return [
    `Created the memory store at ${creation.store.root}`,
    ...creation.imported,
    ...(creation.ignored === false ? [IGNORE_NOTE] : []),
  ];
}

/** How an agent imports its own memories into a store being created. */
type MemoryImporter = NonNullable<Adapter["importMemories"]>;

/** The imports of a store created in `ctx`'s project: those of the agents with memories of their own, wired in either scope or in `importFor`. */
async function importers(
  ctx: AdapterContext,
  importFor: readonly string[]
): Promise<MemoryImporter[]> {
  const candidates = listAdapters().filter(
    ({ importMemories }) => importMemories !== undefined
  );
  // An agent about to be wired needs no status: it counts as wired.
  const wired = await Promise.all(
    candidates.map(async (adapter) => {
      if (importFor.includes(adapter.id)) {
        return { adapter, enabled: true };
      }
      const { enabled } = await adapter.status(ctx);
      return { adapter, enabled };
    })
  );
  return wired
    .filter(({ enabled }) => enabled)
    .flatMap(({ adapter }) => adapter.importMemories ?? []);
}

/**
 * The store of the project holding `cwd`, created with an empty index when it does
 * not exist yet (ADR 0004): in a repository at its root, outside git in the working
 * directory. Creating it imports the memories of each agent wired in either scope,
 * or about to be (`importFor`), that kept its own: Claude Code's, once per user and
 * repository.
 */
export async function ensureStore(
  cwd: string,
  {
    env = process.env,
    home = homedir(),
    importFor = [],
  }: {
    env?: Record<string, string | undefined>;
    home?: string;
    importFor?: readonly string[];
  } = {}
): Promise<StoreCreation> {
  const location = locateStore(cwd);
  const store = new MemoryStore(location.dir);
  const none = { imported: [], warnings: [] };
  if (location.exists) {
    return { store, created: false, ignored: storeIgnored(location), ...none };
  }
  const ctx = adapterContext(cwd, store, env, home);
  // Planned before the store exists, so the import takes no backup of it.
  const imports = await importers(ctx, importFor);
  const plans: PlannedMemoryImport[] = await Promise.all(
    imports.map((importMemories) => importMemories({ store, env, home }))
  );
  await createStore(location);
  const imported: string[] = [];
  const warnings: string[] = [];
  for (const write of plans) {
    // oxlint-disable-next-line no-await-in-loop -- one agent's import at a time, into one store
    const result = await write();
    imported.push(...result.lines);
    warnings.push(...result.warnings);
  }
  return {
    store,
    created: true,
    ignored: storeIgnored(location),
    imported,
    warnings,
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
  if (root === null || ctx.project === undefined) {
    return null;
  }
  return {
    root,
    agents: await agentStatuses({
      ...ctx,
      project: { ...ctx.project, root },
      cwd: root,
    }),
  };
}

/** Whether the agent is wired, wholly or in part, in the project scope. */
function projectEnabled(status: AgentStatus): boolean {
  return status.scopes.some(
    ({ scope, enabled }) => scope === "project" && enabled
  );
}

/**
 * Run in a submodule, whose own work tree an agent started here reads, not the
 * superproject's: a warning naming the agents the superproject's files wire and
 * the submodule's do not, whose sessions here get none of that wiring.
 */
function submoduleWarnings(
  superproject: { root: string; agents: readonly AgentStatus[] } | null,
  submoduleAgents: readonly AgentStatus[]
): string[] {
  if (superproject === null) {
    return [];
  }
  const unwiredHere = superproject.agents.filter(
    (agent) =>
      projectEnabled(agent) &&
      !submoduleAgents.some(
        (status) => status.id === agent.id && projectEnabled(status)
      )
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

/** The Check of a project with no store, or of no project: nothing in it. */
const NO_STORE_CHECK: Check = {
  memoryCount: 0,
  problems: [],
  notes: [],
  unparseable: 0,
  staleIndex: false,
  indexOverLimit: false,
};

/** A project's check, wiring included, and whether it had a store to check. */
export interface ProjectCheck extends Check {
  hasStore: boolean;
}

/** The project's store, when it exists. */
function existingStore(ctx: AdapterContext): MemoryStore | undefined {
  const store = ctx.project?.store;
  return store !== undefined && existsSync(store.root) ? store : undefined;
}

/** The store's Check with the wiring's problems after its own; without a store, the wiring's alone. */
async function withWiring(
  store: MemoryStore | undefined,
  wiring: readonly string[]
): Promise<ProjectCheck> {
  const check = store === undefined ? NO_STORE_CHECK : await checkStore(store);
  return {
    ...check,
    problems: [...check.problems, ...wiring],
    hasStore: store !== undefined,
  };
}

/** Run the check: the store's Check, then the problems of the agents' wiring. It never writes. */
export async function checkProject(ctx: AdapterContext): Promise<ProjectCheck> {
  const statuses = await agentStatuses(ctx);
  return withWiring(existingStore(ctx), wiringProblems(ctx, statuses));
}

/** A ProjectCheck as both surfaces print it; without a store, its first line says so. */
export function formatProjectCheck(check: ProjectCheck): string {
  if (check.hasStore || check.problems.length > 0) {
    return formatCheck(check);
  }
  // A check with no store has no notes: they are about memories.
  return "✓ no memory store yet, no problems";
}

/** Everything `mdmem status` reports. */
export interface ProjectStatus {
  /** The project's store directory, and whether it exists; undefined outside any project. */
  store?: { dir: string; exists: boolean };
  /** The memories that parse. */
  memoryCount: number;
  /** The check, wiring included. */
  check: ProjectCheck;
  /** Of the check's problems, those of the wiring, which status prints as warnings. */
  wiringProblems: string[];
  /** Whether git ignores the store; undefined when git cannot tell or there is no store. */
  ignored: boolean | undefined;
  agents: AgentStatus[];
  /** Status only, as warnings, about the project rather than one agent: status run in a submodule of a wired project. */
  warnings: string[];
}

export async function projectStatus(
  ctx: AdapterContext
): Promise<ProjectStatus> {
  const store = existingStore(ctx);
  const [agents, superproject] = await Promise.all([
    agentStatuses(ctx),
    superprojectStatuses(ctx),
  ]);
  const wiring = wiringProblems(ctx, agents);
  const check = await withWiring(store, wiring);
  return {
    ...(ctx.project === undefined
      ? {}
      : {
          store: {
            dir: ctx.project.store.root,
            exists: store !== undefined,
          },
        }),
    // the check counts every memory file, the unparseable ones included
    memoryCount: check.memoryCount - check.unparseable,
    check,
    wiringProblems: wiring,
    ignored:
      store === undefined
        ? undefined
        : isIgnoredByGit(dirname(store.root), STORE_DIR),
    agents,
    warnings: submoduleWarnings(superproject, agents),
  };
}
