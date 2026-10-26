import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { checkStore, formatCheck } from "../core/check.ts";
import type { Check } from "../core/check.ts";
import {
  outermostSuperproject,
  repositoryRoot,
  workTreeRoot,
  worktreePaths,
} from "../core/git.ts";
import {
  createStore,
  localStoreIgnored,
  memoryCountAt,
} from "../core/operations.ts";
import { RefusalError } from "../core/refusal.ts";
import {
  homeStoreOf,
  locateStore,
  noStoreLine,
  placementLine,
  placementOf,
  STORE_DIR,
  storeAt,
} from "../core/store.ts";
import type { MemoryStore, Placement } from "../core/store.ts";
import { bothScopesNote, wiredInBothScopes } from "./adapter.ts";
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
 * project, folder trust. Both work without a store, where they report the wiring
 * alone (ADR 0004). Here too: the contexts the CLI and the MCP server hand adapters,
 * and the creation of a store on its first write (ADR 0005).
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
      : { project: { root: workTreeRoot(cwd) ?? store.project, store } }),
    env,
    home,
    cwd,
  };
}

/**
 * The context of the project holding `cwd`, which needs no store: the repository,
 * or outside git the working directory itself (ADR 0005).
 */
export function locateContext(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): AdapterContext {
  return adapterContext(cwd, storeAt(locateStore(cwd, home)), env, home);
}

/**
 * The context `mdmem enable` works in. The global scope needs neither a project
 * nor a store. The project scope is refused in a repository with no work tree here
 * (a bare repository, or the folder holding one), where no agent reads the files
 * enable would write; elsewhere its project is the repository or, outside git, the
 * working directory. It creates no store (ADR 0005).
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
  return locateContext(cwd);
}

/** What happened to a project's store on a write: created or not, and what creating it imported. */
export interface StoreCreation {
  store: MemoryStore;
  placement: Placement;
  created: boolean;
  /** Whether git ignores a local store; undefined for a home store, or outside a git work tree. */
  ignored: boolean | undefined;
  /** The import's report lines, none when nothing was imported. */
  imported: string[];
  /** The import's warnings: a copied file that looks like it holds a secret, and the index's. */
  warnings: string[];
}

/** The note for a local store git does not ignore. */
export const IGNORE_NOTE = `Note: git does not ignore ${STORE_DIR}/; ignoring or committing it is your choice.`;

/** The lines a creating write reports before its own: the store's placement and path, the import's lines, the note when git does not ignore a local store. */
export function creationLines(creation: StoreCreation): string[] {
  if (!creation.created) {
    return [];
  }
  return [
    `Created the ${creation.placement} store at ${creation.store.root}`,
    ...creation.imported,
    ...(creation.ignored === false ? [IGNORE_NOTE] : []),
  ];
}

/** How an agent imports its own memories into a store being created. */
type MemoryImporter = NonNullable<Adapter["importMemories"]>;

/** The imports of a store created in `ctx`'s project: those of the agents with memories of their own, wired in either scope. */
async function importers(ctx: AdapterContext): Promise<MemoryImporter[]> {
  const candidates = listAdapters().filter(
    ({ importMemories }) => importMemories !== undefined
  );
  const wired = await Promise.all(
    candidates.map(async (adapter) => {
      const { enabled } = await adapter.status(ctx);
      return { adapter, enabled };
    })
  );
  return wired
    .filter(({ enabled }) => enabled)
    .flatMap(({ adapter }) => adapter.importMemories ?? []);
}

/** Whether git ignores `store`: for a local store only, undefined for a home store. */
function storeIgnored(store: MemoryStore): boolean | undefined {
  return placementOf(store) === "local"
    ? localStoreIgnored(store.project)
    : undefined;
}

/** Where the agents' user-wide files and the home stores are. */
export interface UserOptions {
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * Create `store`, which does not exist yet, for the project of `cwd`, with its
 * project file and an index holding only its header (check.ts's indexHeader).
 * Creating it imports the memories of each agent wired in either scope that kept
 * its own: Claude Code's, once per user and project.
 */
export async function createProjectStore(
  cwd: string,
  store: MemoryStore,
  { env = process.env, home = homedir() }: UserOptions = {}
): Promise<StoreCreation> {
  const ctx = adapterContext(cwd, store, env, home);
  // Planned before the store exists, so the import takes no backup of it.
  const imports = await importers(ctx);
  const plans: PlannedMemoryImport[] = await Promise.all(
    imports.map((importMemories) => importMemories({ store, env, home }))
  );
  await createStore(store);
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
    placement: placementOf(store),
    created: true,
    ignored: storeIgnored(store),
    imported,
    warnings,
  };
}

/**
 * The store of the project holding `cwd`, created when it does not exist yet as
 * `createProjectStore` creates it: the store the rule names, so the home store
 * unless a local one exists (ADR 0005).
 */
export async function ensureStore(
  cwd: string,
  options: UserOptions = {}
): Promise<StoreCreation> {
  const location = locateStore(cwd, options.home ?? homedir());
  const store = storeAt(location);
  if (location.exists) {
    return {
      store,
      placement: location.placement,
      created: false,
      ignored: storeIgnored(store),
      imported: [],
      warnings: [],
    };
  }
  return await createProjectStore(cwd, store, options);
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

/** The notes of the agents' wiring, as the check reports them: each agent wired in both scopes. */
function wiringNotes(statuses: readonly AgentStatus[]): string[] {
  return statuses
    .filter(wiredInBothScopes)
    .map(({ title }) => bothScopesNote(title));
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

/** A project's check, wiring included, whether it had a store to check, and the store's line. */
export interface ProjectCheck extends Check {
  hasStore: boolean;
  /** The store's placement and path, or the home store the first save creates; undefined with no project. */
  storeLine?: string;
}

/** The project's store, when it exists. */
function existingStore(ctx: AdapterContext): MemoryStore | undefined {
  const store = ctx.project?.store;
  return store !== undefined && existsSync(store.root) ? store : undefined;
}

/** The line naming the project's store: its placement and path, or the home store the first save creates. */
function projectStoreLine(ctx: AdapterContext): string | undefined {
  const store = ctx.project?.store;
  if (store === undefined) {
    return undefined;
  }
  return existsSync(store.root)
    ? placementLine(store)
    : noStoreLine(store.root);
}

/** The store's Check with the wiring's problems and notes after its own; without a store, the wiring's alone. */
async function withWiring(
  ctx: AdapterContext,
  store: MemoryStore | undefined,
  wiring: readonly string[],
  notes: readonly string[]
): Promise<ProjectCheck> {
  const check = store === undefined ? NO_STORE_CHECK : await checkStore(store);
  const storeLine = projectStoreLine(ctx);
  return {
    ...check,
    problems: [...check.problems, ...wiring],
    notes: [...check.notes, ...notes],
    hasStore: store !== undefined,
    ...(storeLine === undefined ? {} : { storeLine }),
  };
}

/** Run the check: the store's Check, then the problems of the agents' wiring. It never writes. */
export async function checkProject(ctx: AdapterContext): Promise<ProjectCheck> {
  const statuses = await agentStatuses(ctx);
  return withWiring(
    ctx,
    existingStore(ctx),
    wiringProblems(ctx, statuses),
    wiringNotes(statuses)
  );
}

/** A ProjectCheck as both surfaces print it: the store's line, then the check; without a store, no problems or notes but the wiring's. */
export function formatProjectCheck(check: ProjectCheck): string {
  // Without a store there are no memories to count.
  const body =
    check.hasStore || check.problems.length > 0
      ? formatCheck(check)
      : ["✓ no problems", ...check.notes.map((note) => `note: ${note}`)].join(
          "\n"
        );
  return check.storeLine === undefined ? body : `${check.storeLine}\n${body}`;
}

/** Everything `mdmem status` reports. */
export interface ProjectStatus {
  /** The project's store, its placement and whether it exists; undefined only for a context with no project. */
  store?: { dir: string; placement: Placement; exists: boolean };
  /** The memories that parse. */
  memoryCount: number;
  /** The check, wiring included. */
  check: ProjectCheck;
  /** Of the check's problems, those of the wiring, which status prints as warnings. */
  wiringProblems: string[];
  /** Whether git ignores a local store; undefined when git cannot tell, for a home store, or with no store. */
  ignored: boolean | undefined;
  agents: AgentStatus[];
  /** Status only, as warnings, about the project rather than one agent: memories in the home store a local store hides, status run in a submodule of a wired project. */
  warnings: string[];
}

/**
 * A local store hides the project's home store (ADR 0005): a warning naming the home
 * store when it holds memories, and how to fold them into the local one.
 */
async function hiddenHomeStoreWarnings(
  ctx: AdapterContext,
  store: MemoryStore | undefined
): Promise<string[]> {
  if (store === undefined || placementOf(store) !== "local") {
    return [];
  }
  const homeStore = homeStoreOf(store.project, ctx.home);
  const count = await memoryCountAt(homeStore);
  if (count === 0) {
    return [];
  }
  const memories = count === 1 ? "1 memory" : `${count} memories`;
  return [
    `the home store ${homeStore} holds ${memories} too, which no agent reads while the local store ${store.root} exists: fold them in with \`mdmem consolidate --from ${homeStore}\``,
  ];
}

export async function projectStatus(
  ctx: AdapterContext
): Promise<ProjectStatus> {
  const store = existingStore(ctx);
  const [agents, superproject, hidden] = await Promise.all([
    agentStatuses(ctx),
    superprojectStatuses(ctx),
    hiddenHomeStoreWarnings(ctx, store),
  ]);
  const wiring = wiringProblems(ctx, agents);
  const check = await withWiring(ctx, store, wiring, wiringNotes(agents));
  return {
    ...(ctx.project === undefined
      ? {}
      : {
          store: {
            dir: ctx.project.store.root,
            placement: placementOf(ctx.project.store),
            exists: store !== undefined,
          },
        }),
    // the check counts every memory file, the unparseable ones included
    memoryCount: check.memoryCount - check.unparseable,
    check,
    wiringProblems: wiring,
    ignored: store === undefined ? undefined : storeIgnored(store),
    agents,
    warnings: [...hidden, ...submoduleWarnings(superproject, agents)],
  };
}
