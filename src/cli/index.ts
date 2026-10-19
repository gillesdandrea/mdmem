#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  WiringPlan,
} from "../adapters/adapter.ts";
import { adapterIds, findAdapters, getAdapter } from "../adapters/index.ts";
import {
  adapterContext,
  checkProject,
  disableContext,
  enableContext,
  projectStatus,
} from "../adapters/report.ts";
import { checkSummary, formatCheck, reindex } from "../core/check.ts";
import { HOOK_AGENTS, HOOK_PARTS, runHook } from "../core/hook.ts";
import { IMPORT_PREFERENCES } from "../core/import.ts";
import type { ImportPreference } from "../core/import.ts";
import { memoryFileFor, MEMORY_TYPES } from "../core/memory.ts";
import type { MemoryType } from "../core/memory.ts";
import {
  assertMemoryPath,
  initStore,
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
import { STORE_DIR, VersionConflictError } from "../core/store.ts";
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

function context(store: MemoryStore): AdapterContext {
  return adapterContext(process.cwd(), store);
}

/** `enable --prefer`'s value, which settles an import conflict. */
function preferOption(
  value: string | boolean | undefined
): ImportPreference | undefined {
  if (value === undefined) {
    return undefined;
  }
  const preference = IMPORT_PREFERENCES.find((p) => p === value);
  return (
    preference ??
    die(`--prefer must be one of: ${IMPORT_PREFERENCES.join(", ")}`)
  );
}

function isMemoryType(value: string | undefined): value is MemoryType {
  return (
    value !== undefined && (MEMORY_TYPES as readonly string[]).includes(value)
  );
}

async function cmdInit(): Promise<void> {
  const { store, created, ignored } = await initStore(process.cwd());
  print(
    created
      ? `Initialized memory store at ${store.root}`
      : `Memory store already exists at ${store.root}`
  );
  if (ignored === false) {
    print(
      `Note: git does not ignore ${STORE_DIR}/; ignoring or committing it is your choice.`
    );
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

  const store = resolveStore();
  const force = values.force ?? false;
  let result: WriteResult;
  try {
    result = await saveMemory(
      store,
      { name, description, type: values.type, body: body.trim() },
      { force }
    );
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
      (id) =>
        getAdapter(id) ??
        die(`unknown agent "${id}". Known: ${adapterIds().join(", ")}`)
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

/** The agent whose import `--prefer` settles. */
const PREFER_AGENT = "claude-code";

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
  // One table for both modes, so an option given to the wrong one gets mdmem's own refusal.
  const { values, positionals } = parseArgs({
    args,
    options: {
      all: { type: "boolean" },
      prefer: { type: "string" },
      global: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (mode === "disable" && values.prefer !== undefined) {
    die("--prefer applies to `mdmem enable` only");
  }
  if (mode === "enable" && values.global !== undefined) {
    die("--global applies to `mdmem disable` only");
  }
  const prefer = preferOption(values.prefer);
  const { adapters, notice } = resolveTargets(values, positionals, mode);
  if (notice !== undefined) {
    print(notice);
  }
  if (prefer !== undefined && !adapters.some(({ id }) => id === PREFER_AGENT)) {
    die(
      `--prefer settles the import of Claude Code's memories, so it applies only when ${PREFER_AGENT} is among the agents enabled`
    );
  }
  const cwd = process.cwd();
  // enable needs a work tree and a store; disable needs neither.
  const { ctx, outsideProject } =
    mode === "enable"
      ? { ctx: enableContext(cwd), outsideProject: false }
      : disableContext(cwd);
  // Plan every agent before writing any, so a refusal leaves every file as it was.
  const plans = await planWiring(adapters, (adapter) =>
    mode === "enable"
      ? adapter.enable(ctx, { prefer })
      : adapter.disable(ctx, { global: values.global, outsideProject })
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

function printAgent(status: AgentStatus): void {
  print(`  ${status.wired ? "✓" : "·"} ${status.title}`);
  for (const { label, file, present } of status.entries) {
    print(`      ${present ? "✓" : "· missing:"} ${label} (${file})`);
  }
  for (const note of status.notes) {
    print(`      ${note}`);
  }
}

async function cmdStatus(): Promise<void> {
  const store = resolveStore();
  const status = await projectStatus(context(store));
  print(`Store: ${store.root}`);
  // Counts the memories that parse; the check's line counts the broken ones.
  print(`Memories: ${status.memoryCount}`);
  print(`Check: ${checkSummary(status.check)}`);
  if (status.ignored === false) {
    print(
      `Note: git does not ignore ${STORE_DIR}/; ignoring or committing it is your choice.`
    );
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
  const check = await checkProject(context(resolveStore()));
  print(formatCheck(check));
  if (check.problems.length > 0) {
    process.exit(1);
  }
}

function cmdConsolidate(): void {
  const store = resolveStore();
  process.stdout.write(getConsolidatePrompt(store.root));
}

/** Run by an agent's session-start hook, never by hand; it always exits 0. */
async function cmdHook(args: string[]): Promise<void> {
  const [agent = "", part = ""] = args;
  const output = await runHook({
    agent,
    part,
    readPayload: async () =>
      process.stdin.isTTY ? "" : await Bun.stdin.text(),
    cwd: process.cwd(),
    // A hook declared outside the project (Codex's) runs only where the project is wired for it.
    projectWired: async (hookAgent, projectRoot) => {
      const check = getAdapter(hookAgent)?.projectWired;
      return check === undefined ? true : await check(projectRoot());
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

  init                      Create .memory/ at the project's root (a repository's main checkout)
  add --type <t> --name <n> --description <d> [--body <text>] [--force]
                            Save a memory (body may be piped via stdin; --force overwrites an existing one,
                            unless it changes while being saved)
  list                      Print the memory index (MEMORY.md)
  read <name>               Print one memory by its name (or <name>.md), or the index (MEMORY.md)
  edit <name>               Edit a copy of a memory in $VISUAL/$EDITOR, then save it back; an invalid
                            edit or one that conflicts is refused and its copy kept
  delete | rm <name>        Remove a memory by its name (or <name>.md)
  search <query>            Find memories containing text
  reindex                   Bring MEMORY.md up to date with the memories, keeping its other lines
  consolidate               Print a prompt that has an agent consolidate the store
  doctor | check            Check the store (parse errors, name≠filename, conflicting types, secrets,
                            long pointers, dangling links, stale index, index over its size limit)
                            and the agents' wiring (a config file it cannot read, a session-start
                            hook missing or switched off, Claude Code's auto memory still on, mdmem
                            not on PATH)
  enable <agent…> | --all [--prefer claude|mdmem]
                            Wire an agent to the shared store, in files meant to be committed;
                            --all wires the agents found on this machine, by their command on
                            PATH (claude, bob, codex) or config directory ($CLAUDE_CONFIG_DIR or
                            ~/.claude, ~/.bob, $CODEX_HOME or ~/.codex)
                            (claude-code: import Claude's memories once, turn its auto memory off,
                            add its session-start hooks and the mdmem MCP server; --prefer settles
                            an import conflict by keeping Claude's file or the store's, and needs
                            claude-code among the agents; bob: add its session-start hooks and the
                            mdmem MCP server; codex: add its session-start hooks to ~/.codex/hooks.json
                            ($CODEX_HOME when set), once per user, and the mdmem MCP server to
                            .codex/config.toml); refused in a bare repository or the folder holding
                            one; an unknown agent, a file that does not parse, a key of mdmem's
                            holding something else (another mcpServers.mdmem, autoMemoryEnabled:
                            true) or an import conflict stops it with no file written
  disable <agent…> | --all [--global]
                            Remove exactly mdmem's entries from an agent's files (leaves the store,
                            needs none); --all takes the agents found on this machine;
                            codex keeps its global hook, then silent in the project, unless
                            --global, which also removes it from ~/.codex/hooks.json (the only
                            change disable makes outside a project)
  status                    Show the store, the check in one line, whether git ignores .memory/, and
                            each agent's wiring, entry by entry, with what mdmem cannot check (folder
                            trust), a warning when Bob would be launched below the checkout's root,
                            and one in a submodule of a wired project, whose wiring agents started
                            in the submodule do not get
  path                      Print the store directory
  mcp                       Run the MCP server over stdio (for agent tool-calls)
  hook <agent> <part>       Run by an agent's session-start hook, not typed by hand: print the
                            memory protocol or the index as context to inject (agent: ${HOOK_AGENTS.join(", ")};
                            part: ${HOOK_PARTS.join(", ")}); prints nothing outside a project with a store,
                            nor for codex where .codex/config.toml does not register the mdmem server

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
  consolidate: () => cmdConsolidate(),
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
