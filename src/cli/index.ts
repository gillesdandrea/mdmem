import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

import packageJson from "../../package.json" with { type: "json" };
import { GLOBAL_HOOK_FLAG } from "../adapters/adapter.ts";
import type {
  Adapter,
  AgentStatus,
  Scope,
  WiringPlan,
} from "../adapters/adapter.ts";
import {
  adapterIds,
  findAdapters,
  getAdapter,
  unknownAgent,
} from "../adapters/index.ts";
import {
  adapterContext,
  checkProject,
  createProjectStore,
  creationLines,
  disableContext,
  enableContext,
  ensureStore,
  formatProjectCheck,
  IGNORE_NOTE,
  locateContext,
  projectStatus,
} from "../adapters/report.ts";
import type { StoreCreation } from "../adapters/report.ts";
import { checkSummary, reindex } from "../core/check.ts";
import { rootIsGitDir } from "../core/git.ts";
import { runHook, stdinPayload } from "../core/hook.ts";
import { memoryFileFor, MEMORY_TYPES } from "../core/memory.ts";
import type { MemoryType } from "../core/memory.ts";
import {
  assertMemoryPath,
  checkMemoryWrite,
  listHomeStores,
  localStoreIgnored,
  memoryCountAt,
  memoryDocument,
  moveStoreDir,
  openStore,
  readDocument,
  readIndex,
  removeMemory,
  saveMemory,
  searchMemories,
  secondStoreDir,
  writeDocument,
  writeProjectFile,
} from "../core/operations.ts";
import type { WriteResult } from "../core/operations.ts";
import { getConsolidatePrompt } from "../core/protocol.ts";
import { RefusalError } from "../core/refusal.ts";
import { sessionsDir } from "../core/session.ts";
import type { Placement } from "../core/store.ts";
import {
  homeStoresDir,
  locateStore,
  locationLine,
  MemoryStore,
  noStoreLine,
  realDir,
  storeAt,
  VersionConflictError,
} from "../core/store.ts";
import { messageOf } from "../core/text.ts";
import { commandHelp, topLevelHelp, unknownCommandHelp } from "./help.ts";

/** Everything on stdin, once it closes: a memory's body or a hook's payload piped in. */
const readStdin = (): Promise<string> => text(process.stdin);

function print(msg = ""): void {
  process.stdout.write(`${msg}\n`);
}

function warn(msg: string): void {
  process.stderr.write(`mdmem: warning: ${msg}\n`);
}

/** The write landed, so say so; its warnings (a broken memory, a stale or full index) are not failures. */
function reportWrite(verb: string, { file, warnings }: WriteResult): void {
  print(`${verb} ${file}`);
  for (const warning of warnings) {
    warn(warning);
  }
}

function die(msg: string): never {
  process.stderr.write(`mdmem: ${msg}\n`);
  process.exit(1);
}

/** The project's store; without one, the refusal reaches `main`, which prints it. */
function resolveStore(): MemoryStore {
  return openStore(process.cwd());
}

/** Print what creating the store did, its lines then its warnings; nothing when it existed. */
function reportCreation(creation: StoreCreation): void {
  for (const line of creationLines(creation)) {
    print(line);
  }
  for (const warning of creation.warnings) {
    warn(warning);
  }
}

function isMemoryType(value: string | undefined): value is MemoryType {
  return (
    value !== undefined && (MEMORY_TYPES as readonly string[]).includes(value)
  );
}

async function cmdAdd(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      type: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      body: { type: "string" },
      force: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!isMemoryType(values.type)) {
    die(`--type must be one of: ${MEMORY_TYPES.join(", ")}`);
  }
  const name =
    values.name ?? die("--name is required (kebab-case or snake_case)");
  const description = values.description ?? die("--description is required");
  let { body } = values;
  if (body === undefined) {
    body = process.stdin.isTTY ? "" : await readStdin();
  }

  const input = { name, description, type: values.type, body: body.trim() };
  // A refused memory creates no store.
  const { file, content } = memoryDocument(input);
  checkMemoryWrite(file, content);
  const creation = await ensureStore(process.cwd());
  reportCreation(creation);
  const force = values.force ?? false;
  let result: WriteResult;
  try {
    result = await saveMemory(creation.store, input, { force });
  } catch (error) {
    // Without --force the write insists on a new file; with it, a conflict means the memory changed mid-write.
    if (error instanceof VersionConflictError) {
      die(
        force
          ? `the memory "${name}" changed while it was saved, so it was not overwritten — run the command again to overwrite the new version`
          : `a memory named "${name}" already exists — pass --force to overwrite, or \`mdmem delete ${name}\``
      );
    }
    throw error;
  }
  reportWrite("Saved", result);
}

async function cmdReindex(): Promise<void> {
  const store = resolveStore();
  const warnings = await reindex(store);
  print("Updated MEMORY.md");
  for (const warning of warnings) {
    warn(warning);
  }
}

/** A project with no store yet has no memories: listing it says so, and creates nothing. */
async function cmdList(): Promise<void> {
  const location = locateStore(process.cwd());
  if (!location.exists) {
    print(
      `No memories yet: the first save creates the home store ${location.home}`
    );
    return;
  }
  print(await readIndex(storeAt(location)));
}

async function cmdRead(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem read <name>");
  }
  const store = resolveStore();
  const { content } = await readDocument(store, memoryFileFor(name));
  print(content);
}

/** Open `path` in `editor` (a command, possibly with arguments) and wait for it to exit: its exit code, or why it could not run. */
function runEditor(
  editor: string,
  path: string
): { exitCode: number | null; failure?: string } {
  const [cmd = editor, ...editorArgs] = editor.split(" ");
  const proc = spawnSync(cmd, [...editorArgs, path], { stdio: "inherit" });
  if (proc.error !== undefined) {
    return {
      exitCode: null,
      failure: `could not run the editor ${JSON.stringify(cmd)} — ${messageOf(proc.error)}`,
    };
  }
  if (proc.signal !== null) {
    return {
      exitCode: null,
      failure: `the editor was killed by ${proc.signal}`,
    };
  }
  return { exitCode: proc.status };
}

/** End `mdmem edit` on `reason`, printing where the edited copy is kept so the edit is not lost. */
function dieKeepingCopy(reason: string, copy: string): never {
  process.stderr.write(`mdmem: ${reason}\n`);
  die(`your edit is kept at ${copy}`);
}

async function cmdEdit(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem edit <name>");
  }
  const store = resolveStore();
  const file = memoryFileFor(name);
  // Refuse a path no edit could be saved to (such as the index) before opening an editor on it.
  assertMemoryPath(file);
  const { content, version } = await readDocument(store, file);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    // no $EDITOR — print the path so it can be opened by hand
    print(join(store.root, file));
    return;
  }
  // Edit a copy, named <file> so the editor stays in Markdown mode, then write it back under the version read.
  const copyDir = await mkdtemp(join(tmpdir(), "mdmem-"));
  const copy = join(copyDir, basename(file));
  await writeFile(copy, content, "utf-8");
  const { exitCode, failure } = runEditor(editor, copy);
  if (failure !== undefined) {
    dieKeepingCopy(failure, copy);
  }
  if (exitCode !== 0) {
    dieKeepingCopy(`editor exited with code ${exitCode}`, copy);
  }
  let edited: string;
  try {
    edited = await readFile(copy, "utf-8");
  } catch (error) {
    // The editor removed the copy: there is no edit left to keep.
    await rm(copyDir, { recursive: true, force: true });
    die(`could not read the edited copy — ${messageOf(error)}`);
  }
  if (edited === content) {
    await rm(copyDir, { recursive: true, force: true });
    print(`Unchanged ${file}`);
    return;
  }
  let result: WriteResult;
  try {
    result = await writeDocument(store, file, edited, version);
  } catch (error) {
    // The store is untouched; keep the copy so the edit is not lost.
    dieKeepingCopy(messageOf(error), copy);
  }
  await rm(copyDir, { recursive: true, force: true });
  reportWrite("Saved", result);
}

async function cmdDelete(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem delete <name>");
  }
  const store = resolveStore();
  let result: WriteResult | null;
  try {
    result = await removeMemory(store, name);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      die(
        error.current === undefined
          ? `no memory "${name}" (looked for ${memoryFileFor(name)}): it was deleted while this command ran`
          : `the memory "${name}" changed while it was deleted, so it was kept — run the command again to delete the new version`
      );
    }
    throw error;
  }
  if (!result) {
    die(`no memory "${name}" (looked for ${memoryFileFor(name)})`);
  }
  reportWrite("Deleted", result);
}

async function cmdSearch(args: string[]): Promise<void> {
  // A leading `--` lets the query be -h or --help, which main otherwise takes as asking for help.
  // Every argument is a word of the query, so an unquoted query of several words searches them all.
  const query = (args[0] === "--" ? args.slice(1) : args).join(" ").trim();
  if (!query) {
    die("usage: mdmem search <word>...");
  }
  // With no store yet, the store the first save creates holds nothing to find.
  const store = storeAt(locateStore(process.cwd()));
  const { hits, warnings } = await searchMemories(store, query);
  if (hits.length === 0) {
    print(`No memories matching "${query}".`);
  }
  for (const hit of hits) {
    print(`${hit.file} — ${hit.description}`);
  }
  for (const warning of warnings) {
    warn(warning);
  }
}

/** The agents to wire, and a line to print about the ones `--all` skipped. */
interface Targets {
  adapters: Adapter[];
  notice?: string;
}

/**
 * The agents to wire: those named, every name checked before any agent is planned,
 * or with `--all` the supported agents found on this machine.
 */
function resolveTargets(
  values: { all?: boolean },
  positionals: string[],
  mode: "enable" | "disable"
): Targets {
  if (!values.all) {
    if (positionals.length === 0) {
      die(`specify agent(s) or --all. Known: ${adapterIds().join(", ")}`);
    }
    // A name given twice is wired once: every plan reads the files as they are now.
    const adapters = [...new Set(positionals)].map(
      (id) => getAdapter(id) ?? die(unknownAgent(id))
    );
    return { adapters };
  }
  if (positionals.length > 0) {
    die("give agent names or --all, not both");
  }
  const { found, notFound } = findAdapters({
    env: process.env,
    home: homedir(),
  });
  const ids = notFound.map(({ id }) => id);
  const nameOne = `Name an agent to ${mode} it anyway, as in \`mdmem ${mode} ${ids[0]}\`.`;
  if (found.length === 0) {
    return {
      adapters: [],
      notice: `No supported agent found on this machine (no command on PATH, no config directory). ${nameOne}`,
    };
  }
  return {
    adapters: found,
    notice:
      notFound.length > 0
        ? `Skipped, not found on this machine (no command on PATH, no config directory): ${ids.join(", ")}. ${nameOne}`
        : undefined,
  };
}

/** Plan every agent's enable or disable; the first refusal, in the agents' order, stops the run. */
async function planWiring(
  adapters: readonly Adapter[],
  plan: (adapter: Adapter) => Promise<WiringPlan>
): Promise<WiringPlan[]> {
  const settled = await Promise.allSettled(adapters.map(plan));
  return settled.map((outcome) => {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    return outcome.value;
  });
}

async function cmdWiring(
  args: string[],
  mode: "enable" | "disable"
): Promise<void> {
  // The options 0.2.0 took are kept only to say what replaced them.
  const { values, positionals } = parseArgs({
    args,
    options: {
      all: { type: "boolean" },
      project: { type: "boolean" },
      global: { type: "boolean" },
      prefer: { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.global !== undefined) {
    die(
      `--global is gone: \`mdmem ${mode}\` acts on the agents' user-wide files by default, and on the repository's with --project`
    );
  }
  if (values.prefer !== undefined) {
    die(
      "--prefer is gone: Claude Code's memories are imported when a store is created, so they meet nothing to conflict with"
    );
  }
  const scope: Scope = values.project ? "project" : "global";
  const { adapters, notice } = resolveTargets(values, positionals, mode);
  if (notice !== undefined) {
    print(notice);
  }
  const cwd = process.cwd();
  // The project scope of enable needs a work tree; neither command needs a store, nor creates one.
  const ctx =
    mode === "enable" ? enableContext(cwd, scope) : disableContext(cwd, scope);
  // Plan every agent before writing any, so a refusal leaves every file as it was.
  const plans = await planWiring(adapters, (adapter) =>
    mode === "enable" ? adapter.enable(ctx, scope) : adapter.disable(ctx, scope)
  );
  for (const plan of plans) {
    // oxlint-disable-next-line no-await-in-loop -- writes stay in argument order
    const result = await plan.write();
    print(`${result.title}:`);
    for (const action of result.actions) {
      print(`  ${action}`);
    }
    for (const warning of result.warnings) {
      warn(warning);
    }
  }
}

/** An agent's wiring, one line per scope with its entries under it, then the agent's notes. */
function printAgent(status: AgentStatus): void {
  for (const { scope, wired, entries } of status.scopes) {
    print(`  ${wired ? "✓" : "·"} ${status.title} (${scope})`);
    for (const { label, file, present } of entries) {
      print(`      ${present ? "✓" : "· missing:"} ${label} (${file})`);
    }
  }
  for (const note of status.notes) {
    print(`      ${note}`);
  }
}

async function cmdStatus(): Promise<void> {
  const status = await projectStatus(locateContext(process.cwd()));
  const { store } = status;
  if (store?.exists === true) {
    print(`Store: ${store.placement}, ${store.dir}`);
    // Counts the memories that parse; the check's line counts the broken ones.
    print(`Memories: ${status.memoryCount}`);
  } else if (store !== undefined) {
    print(noStoreLine(store.dir));
  }
  print(`Check: ${checkSummary(status.check)}`);
  if (status.ignored === false) {
    print(IGNORE_NOTE);
  }
  print("Agents:");
  for (const agent of status.agents) {
    printAgent(agent);
  }
  for (const warning of [
    ...status.agents.flatMap(({ warnings }) => warnings),
    ...status.warnings,
  ]) {
    warn(warning);
  }
  for (const problem of status.wiringProblems) {
    warn(problem);
  }
}

async function cmdDoctor(): Promise<void> {
  const check = await checkProject(locateContext(process.cwd()));
  print(formatProjectCheck(check));
  if (check.problems.length > 0) {
    process.exit(1);
  }
}

function cmdConsolidate(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { agent: { type: "string" }, from: { type: "string" } },
    allowPositionals: false,
  });
  const adapter =
    values.agent === undefined
      ? undefined
      : (getAdapter(values.agent) ?? die(unknownAgent(values.agent)));
  const store = resolveStore();
  const from =
    values.from === undefined
      ? undefined
      : secondStoreDir(process.cwd(), values.from, store);
  const { project, env, home } = adapterContext(process.cwd(), store);
  const history =
    project === undefined
      ? undefined
      : adapter?.sessionHistory?.({ projectRoot: project.root, env, home });
  process.stdout.write(getConsolidatePrompt(store.root, history, from));
}

const STORE_USAGE = "usage: mdmem store [local | home | list]";

function otherPlacement(placement: Placement): Placement {
  return placement === "local" ? "home" : "local";
}

/** The line after a store's placement changed or was confirmed: the command that moves it to the other placement. */
function reverseLine(placement: Placement): string {
  const other = otherPlacement(placement);
  return `To move it to the ${other} store: mdmem store ${other}`;
}

/** Print the local store's ignore note when git does not ignore it. */
function printIgnoreNote(root: string): void {
  if (localStoreIgnored(root) === false) {
    print(IGNORE_NOTE);
  }
}

/**
 * Move the project's store to the placement `to` (ADR 0005): a directory move,
 * refused when the destination already holds memories. With no store at all,
 * \`store local\` creates an empty local one.
 */
async function moveStore(to: Placement): Promise<void> {
  const cwd = process.cwd();
  const location = locateStore(cwd);
  const [from, dest] =
    to === "local"
      ? [location.home, location.local]
      : [location.local, location.home];
  if (to === "local" && realDir(location.local) === realDir(homeStoresDir())) {
    die(
      `${location.local} holds the home stores, so the home directory's project keeps its home store ${location.home}: run \`mdmem store local\` in a project`
    );
  }
  if (to === "local" && rootIsGitDir(cwd)) {
    const localExists = location.exists && location.placement === "local";
    die(
      localExists
        ? `the local store ${location.local} sits inside the repository's git directory ${location.root}, which no work tree holds, so it can never be committed: move it with \`mdmem store home\``
        : `${location.local} would sit inside the repository's git directory ${location.root}, which no work tree holds, so it could never be committed: the project keeps its home store ${location.home}`
    );
  }
  const fromExists = location.exists && location.placement !== to;
  const sourceExists = to === "local" ? existsSync(from) : fromExists;
  if (!sourceExists) {
    if (to === "local" && !location.exists) {
      reportCreation(
        await createProjectStore(cwd, new MemoryStore(dest, location.root))
      );
      print(reverseLine(to));
      return;
    }
    print(locationLine(location));
    print(
      `Already ${location.exists ? location.placement : "home"}. ${reverseLine(to)}`
    );
    return;
  }
  const [fromCount, destCount] = await Promise.all([
    memoryCountAt(from),
    memoryCountAt(dest),
  ]);
  if (destCount > 0 && fromCount > 0) {
    die(
      `the ${to} store ${dest} already holds memories, and so does the ${otherPlacement(to)} store ${from}: fold the home store into the local one with \`mdmem consolidate --from ${location.home}\`, then run this again`
    );
  }
  if (destCount > 0 && to === "local") {
    // The local store is used, and the home store holds nothing to move.
    print(locationLine(location));
    print(`Already local. ${reverseLine(to)}`);
    return;
  }
  if (destCount > 0) {
    die(
      `the home store ${dest} already holds memories, and the local store ${from}, which agents use while it exists, holds none: delete ${from} to use the home store`
    );
  }
  await moveStoreDir(from, dest);
  // A store renamed by hand, or a local store committed from another clone, names no project or another one.
  await writeProjectFile(new MemoryStore(dest, location.root));
  print(`Moved the store from ${from} to ${dest}`);
  print(`Store: ${to}, ${dest}`);
  if (to === "local") {
    printIgnoreNote(location.root);
  }
  print(reverseLine(to));
}

/** Print every home store: its key, the project its project file names, its memory count, and whether that project is gone. */
async function listStores(): Promise<void> {
  const stores = await listHomeStores();
  if (stores.length === 0) {
    print(`No home stores in ${homeStoresDir()}.`);
    return;
  }
  for (const { key, project, projectMissing, memoryCount } of stores) {
    const memories = memoryCount === 1 ? "1 memory" : `${memoryCount} memories`;
    const missing = projectMissing ? ", project missing" : "";
    print(`${key} — ${project ?? "no project file"} — ${memories}${missing}`);
  }
}

async function cmdStore(args: string[]): Promise<void> {
  const [action, ...extra] = args;
  if (extra.length > 0) {
    die(STORE_USAGE);
  }
  if (action === undefined) {
    print(locationLine(locateStore(process.cwd())));
    return;
  }
  if (action === "local" || action === "home") {
    await moveStore(action);
    return;
  }
  if (action === "list") {
    await listStores();
    return;
  }
  die(`unknown store action "${action}" — ${STORE_USAGE}`);
}

/** Run by an agent's hooks, never by hand; it always exits 0. */
async function cmdHook(args: string[]): Promise<void> {
  const [agent = "", part = "", ...flags] = args;
  const { stdout, silence, note, stateProblem } = await runHook({
    agent,
    part,
    global: flags.includes(GLOBAL_HOOK_FLAG),
    readPayload: () => stdinPayload(process.stdin.isTTY, readStdin),
    cwd: process.cwd(),
    // The agent decides where its global entry stays silent: beside the project's own.
    verdict: async (hookAgent, site) => {
      const hookVerdict = getAdapter(hookAgent)?.hookVerdict;
      return hookVerdict === undefined
        ? undefined
        : await hookVerdict({ env: process.env, home: homedir() }, site);
    },
    sessionsDir: sessionsDir(process.env, homedir()),
  });
  if (stdout !== "") {
    print(stdout);
  }
  // stderr never reaches the agent's context: it tells whoever runs the hook by hand why it printed nothing, or why it spoke beside the project's own hook.
  if (silence !== undefined) {
    process.stderr.write(`mdmem hook printed nothing: ${silence}\n`);
  }
  for (const line of [note, stateProblem]) {
    if (line !== undefined) {
      process.stderr.write(`mdmem hook: ${line}\n`);
    }
  }
}

function cmdPath(): void {
  const store = resolveStore();
  print(store.root);
}

/** The version package.json declares, the one the MCP server reports too. */
function cmdVersion(): void {
  print(`mdmem ${packageJson.version}`);
}

const runMcp = async (): Promise<void> => {
  // Dynamic import so normal CLI commands never pay the MCP SDK load cost.
  const { startMcpServer } = await import("../mcp/server.ts");
  await startMcpServer();
};

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  // Gone since the first save creates the store everywhere; kept only to say so.
  init: () =>
    die(
      "init is gone: the first memory write (memory_write, `mdmem add`) creates the store, and `mdmem status` shows where"
    ),
  add: (args) => cmdAdd(args),
  list: () => cmdList(),
  read: (args) => cmdRead(args),
  edit: (args) => cmdEdit(args),
  delete: (args) => cmdDelete(args),
  rm: (args) => cmdDelete(args),
  search: (args) => cmdSearch(args),
  reindex: () => cmdReindex(),
  doctor: () => cmdDoctor(),
  check: () => cmdDoctor(),
  consolidate: (args) => cmdConsolidate(args),
  enable: (args) => cmdWiring(args, "enable"),
  disable: (args) => cmdWiring(args, "disable"),
  status: () => cmdStatus(),
  store: (args) => cmdStore(args),
  path: () => cmdPath(),
  version: () => cmdVersion(),
  "--version": () => cmdVersion(),
  "-v": () => cmdVersion(),
  "-V": () => cmdVersion(),
  mcp: runMcp,
  hook: (args) => cmdHook(args),
};

/** Whether `args` ask for help, before any `--` that ends the options. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.some((arg) => HELP_FLAGS.has(arg));
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);
  // `mdmem help <command>` is `mdmem <command> --help`; bare, it is the top-level page.
  const named = first === "help" ? rest[0] : first;
  if (named === undefined || named === "help" || HELP_FLAGS.has(named)) {
    print(topLevelHelp());
    return;
  }
  const args = first === "help" ? ["--help"] : rest;
  const handler = COMMANDS[named];
  if (!handler) {
    process.stderr.write(`${unknownCommandHelp(named)}\n`);
    process.exit(1);
  }
  // Help is taken before any option parsing, so no parser's wording reaches the user.
  const page = asksForHelp(args) ? commandHelp(named) : undefined;
  if (page !== undefined) {
    print(page);
    return;
  }
  try {
    await handler(args);
  } catch (error) {
    // A refusal (ADR 0002) ends as its one line, which says what to do next.
    if (error instanceof RefusalError) {
      die(error.message);
    }
    // Anything else, such as a broken memory met while reading the store, also ends as one line, not a stack trace.
    die(messageOf(error));
  }
}

await main();
