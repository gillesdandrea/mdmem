#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

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
  creationLines,
  enableContext,
  ensureStore,
  formatProjectCheck,
  IGNORE_NOTE,
  locateContext,
  projectStatus,
} from "../adapters/report.ts";
import type { StoreCreation } from "../adapters/report.ts";
import { checkSummary, reindex } from "../core/check.ts";
import { HOOK_AGENTS, HOOK_PARTS, runHook } from "../core/hook.ts";
import { memoryFileFor, MEMORY_TYPES } from "../core/memory.ts";
import type { MemoryType } from "../core/memory.ts";
import {
  assertMemoryPath,
  checkMemoryWrite,
  memoryDocument,
  openStore,
  readDocument,
  readIndex,
  removeMemory,
  saveMemory,
  searchMemories,
  writeDocument,
} from "../core/operations.ts";
import type { WriteResult } from "../core/operations.ts";
import { getConsolidatePrompt } from "../core/protocol.ts";
import { RefusalError } from "../core/refusal.ts";
import type { MemoryStore } from "../core/store.ts";
import { VersionConflictError } from "../core/store.ts";
import { messageOf } from "../core/text.ts";

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

async function cmdInit(): Promise<void> {
  // The one way to create a store outside git (ADR 0004).
  const { store, created, ignored, imported, warnings } = await ensureStore(
    process.cwd(),
    { outsideGit: true }
  );
  print(
    created
      ? `Initialized memory store at ${store.root}`
      : `Memory store already exists at ${store.root}`
  );
  for (const line of imported) {
    print(line);
  }
  for (const warning of warnings) {
    warn(warning);
  }
  if (ignored === false) {
    print(IGNORE_NOTE);
  }
  if (created) {
    print("Next: `mdmem enable --all` to wire up your agents.");
  }
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
    body = process.stdin.isTTY ? "" : await Bun.stdin.text();
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

async function cmdList(): Promise<void> {
  const store = resolveStore();
  print(await readIndex(store));
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

/** Open `path` in `editor` (a command, possibly with arguments), wait for it to exit, and return its exit code. */
function runEditor(editor: string, path: string): number | null {
  const [cmd, ...editorArgs] = editor.split(" ");
  const proc = Bun.spawnSync([cmd ?? editor, ...editorArgs, path], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode;
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
  const exitCode = runEditor(editor, copy);
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
  const [query] = args;
  if (!query) {
    die("usage: mdmem search <query>");
  }
  const store = resolveStore();
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
  // The project scope of enable needs a work tree, and creates a missing store; nothing else needs a store.
  const ctx =
    mode === "enable" ? enableContext(cwd, scope) : locateContext(cwd);
  // Plan every agent before writing any, so a refusal leaves every file as it was.
  const plans = await planWiring(adapters, (adapter) =>
    mode === "enable" ? adapter.enable(ctx, scope) : adapter.disable(ctx, scope)
  );
  if (mode === "enable" && scope === "project" && adapters.length > 0) {
    reportCreation(
      await ensureStore(cwd, { importFor: adapters.map(({ id }) => id) })
    );
  }
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
  if (status.store === undefined) {
    print(
      "Store: none (no repository, and no .memory/ here or above): `mdmem init` creates one"
    );
  } else if (status.store.exists) {
    print(`Store: ${status.store.dir}`);
    // Counts the memories that parse; the check's line counts the broken ones.
    print(`Memories: ${status.memoryCount}`);
  } else {
    print(
      `Store: none yet; the first memory write (memory_write, \`mdmem add\`) creates ${status.store.dir}`
    );
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
    options: { agent: { type: "string" } },
    allowPositionals: false,
  });
  const adapter =
    values.agent === undefined
      ? undefined
      : (getAdapter(values.agent) ?? die(unknownAgent(values.agent)));
  const store = resolveStore();
  const { project, env, home } = adapterContext(process.cwd(), store);
  const history =
    project === undefined
      ? undefined
      : adapter?.sessionHistory?.({ projectRoot: project.root, env, home });
  process.stdout.write(getConsolidatePrompt(store.root, history));
}

/** Run by an agent's session-start hook, never by hand; it always exits 0. */
async function cmdHook(args: string[]): Promise<void> {
  const [agent = "", part = "", ...flags] = args;
  const output = await runHook({
    agent,
    part,
    global: flags.includes(GLOBAL_HOOK_FLAG),
    readPayload: async () =>
      process.stdin.isTTY ? "" : await Bun.stdin.text(),
    cwd: process.cwd(),
    // The agent decides where its hook stays silent: a global entry beside the project's own, Codex's where no config registers the server.
    speaks: async (hookAgent, site) => {
      const speaks = getAdapter(hookAgent)?.hookSpeaks;
      return speaks === undefined
        ? true
        : await speaks({ env: process.env, home: homedir() }, site);
    },
  });
  if (output !== "") {
    print(output);
  }
}

function cmdPath(): void {
  const store = resolveStore();
  print(store.root);
}

function usage(): void {
  print(`mdmem — shared, Claude-style memory for any coding agent

Usage: mdmem <command> [options]

  init                      Create .memory/ at the project's root (a repository's main checkout), and
                            import Claude Code's memories into it when Claude Code is wired; the only
                            way to create a store outside git
  add --type <t> --name <n> --description <d> [--body <text>] [--force]
                            Save a memory (body may be piped via stdin; --force overwrites an existing one,
                            unless it changes while being saved); in a repository with no store yet,
                            the first save creates it, as memory_write does
  list                      Print the memory index (MEMORY.md)
  read <name>               Print one memory by its name (or <name>.md), or the index (MEMORY.md)
  edit <name>               Edit a copy of a memory in $VISUAL/$EDITOR, then save it back; an invalid
                            edit or one that conflicts is refused and its copy kept
  delete | rm <name>        Remove a memory by its name (or <name>.md)
  search <query>            Find memories containing text
  reindex                   Bring MEMORY.md up to date with the memories, keeping its other lines
  consolidate [--agent <agent>]
                            Print a prompt that has an agent consolidate the store; --agent points
                            it at that agent's past sessions of the project (claude-code: its
                            project directory in $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects;
                            codex: the sessions in $CODEX_HOME/sessions or ~/.codex/sessions whose
                            cwd is the project; bob keeps the generic line)
  doctor | check            Check the store (parse errors, name≠filename, conflicting types, secrets,
                            long pointers, stale index, index over its size limit) and the agents'
                            wiring in both scopes (a config file it cannot read, a session-start hook
                            missing or switched off, Claude Code's auto memory still on, mdmem not on
                            PATH); with no store, or outside any project, the wiring alone; exits 1
                            on a problem; a [[link]] to a memory not written yet is a note
  enable <agent…> | --all [--project]
                            Wire an agent to mdmem in the user-wide files it reads in every project
                            (the global scope), or with --project in the repository's files, meant
                            to be committed, creating its store if missing (refused in a bare
                            repository or the folder holding one, and outside git without a store);
                            --all wires the agents found on this machine, by their command on PATH
                            (claude, bob, codex) or config directory ($CLAUDE_CONFIG_DIR or ~/.claude,
                            ~/.bob, $CODEX_HOME or ~/.codex)
                            (claude-code: turn its auto memory off, add its session-start hooks, the
                            mdmem MCP server and its tools' permission, in ~/.claude/settings.json and
                            ~/.claude.json ($CLAUDE_CONFIG_DIR when set), or .claude/settings.json and
                            .mcp.json; bob: its session-start hooks and the mdmem MCP server, in
                            ~/.bob/settings/settings.json and ~/.bob/settings/mcp.json, or
                            .bob/settings.json and .bob/mcp.json; codex: its session-start hooks in
                            ~/.codex/hooks.json ($CODEX_HOME when set) in both scopes, and the mdmem
                            MCP server in ~/.codex/config.toml or .codex/config.toml); an unknown
                            agent, a file that does not parse or a key of mdmem's holding something
                            else (another mcpServers.mdmem, autoMemoryEnabled: true) stops it with no
                            file written
  disable <agent…> | --all [--project]
                            Remove exactly mdmem's entries from an agent's user-wide files, or with
                            --project from the repository's (leaves the store, needs none); --all
                            takes the agents found on this machine; codex's hook serves both scopes,
                            so the global scope removes it and --project keeps it
  status                    Show the store (or that there is none yet), the check in one line,
                            whether git ignores .memory/, and each agent's wiring in each scope, entry
                            by entry, with what mdmem cannot check (folder trust), a warning when Bob
                            would be launched below the checkout's root, and one in a submodule of a
                            project whose files wire agents that agents started in the submodule do
                            not get; outside any project, the global scope alone
  path                      Print the store directory
  mcp                       Run the MCP server over stdio (for agent tool-calls)
  hook <agent> <part> [--global]
                            Run by an agent's session-start hook, not typed by hand: print the
                            memory protocol or the index as context to inject (agent: ${HOOK_AGENTS.join(", ")};
                            part: ${HOOK_PARTS.join(", ")}); speaks in every git repository, the index
                            saying when no store exists yet, and outside git only where a store
                            exists; a --global entry is silent where the project's own entry runs,
                            and codex's where neither ~/.codex/config.toml nor .codex/config.toml
                            registers the mdmem server

Agents: ${adapterIds().join(", ")} (only agents with session-start hooks are supported)
Memory types: ${MEMORY_TYPES.join(", ")}`);
}

const runMcp = async (): Promise<void> => {
  // Dynamic import so normal CLI commands never pay the MCP SDK load cost.
  const { startMcpServer } = await import("../mcp/server.ts");
  await startMcpServer();
};

const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  init: () => cmdInit(),
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
  path: () => cmdPath(),
  mcp: runMcp,
  hook: (args) => cmdHook(args),
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    usage();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    die(`unknown command "${command}". Run \`mdmem help\`.`);
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
