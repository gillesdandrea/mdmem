#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { AdapterContext } from "../adapters/index.ts";
import { adapterIds, getAdapter, listAdapters } from "../adapters/index.ts";
import {
  indexCapacity,
  pointerLine,
  POINTER_MAX_CHARS,
  reindex,
  renderIndex,
} from "../core/index.ts";
import {
  memoryFileFor,
  memoryFileName,
  MEMORY_TYPES,
  parseMemoryFile,
} from "../core/memory.ts";
import type { Memory, MemoryType } from "../core/memory.ts";
import {
  assertMemoryPath,
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
import { describeSecrets, findSecrets } from "../core/secrets.ts";
import {
  findProjectRoot,
  findStoreRoot,
  INDEX_FILE,
  MemoryStore,
  STORE_DIR,
  VersionConflictError,
} from "../core/store.ts";

function print(msg = ""): void {
  process.stdout.write(`${msg}\n`);
}

function warn(msg: string): void {
  process.stderr.write(`mdmem: warning: ${msg}\n`);
}

/** The write landed, so say so; its warnings (a stale or full index) are not failures. */
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Resolved {
  store: MemoryStore;
  storeDir: string;
  projectRoot: string;
}

/** The project's store; without one, the refusal reaches `main`, which prints it. */
function resolveStore(): Resolved {
  const store = openStore(process.cwd());
  return { store, storeDir: store.root, projectRoot: dirname(store.root) };
}

function context(resolved: Resolved): AdapterContext {
  return {
    projectRoot: resolved.projectRoot,
    storeDir: resolved.storeDir,
  };
}

function isMemoryType(value: string | undefined): value is MemoryType {
  return (
    value !== undefined && (MEMORY_TYPES as readonly string[]).includes(value)
  );
}

async function ensureGitignore(root: string): Promise<boolean> {
  const path = join(root, ".gitignore");
  const line = `${STORE_DIR}/`;
  const current = existsSync(path) ? await readFile(path, "utf-8") : "";
  if (current.split(/\r?\n/u).some((l) => l.trim() === line)) {
    return false;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${prefix}${line}\n`);
  return true;
}

async function cmdInit(): Promise<void> {
  const existing = findStoreRoot(process.cwd());
  if (existing) {
    print(`Memory store already exists at ${existing}`);
    return;
  }
  const root = findProjectRoot(process.cwd());
  const storeDir = join(root, STORE_DIR);
  await mkdir(storeDir, { recursive: true });
  const store = new MemoryStore(storeDir);
  await reindex(store);
  const ignored = await ensureGitignore(root);
  print(`Initialized memory store at ${storeDir}`);
  if (ignored) {
    print(`Added ${STORE_DIR}/ to .gitignore`);
  }
  print("Next: `mdmem enable --all` to wire up your agents.");
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
  const name = values.name ?? die("--name is required (kebab-case)");
  const description = values.description ?? die("--description is required");
  let { body } = values;
  if (body === undefined) {
    body = process.stdin.isTTY ? "" : await Bun.stdin.text();
  }

  const { store } = resolveStore();
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
  const { store } = resolveStore();
  const index = await reindex(store);
  print("Rebuilt MEMORY.md");
  for (const { message } of indexCapacity(index)) {
    warn(message);
  }
}

async function cmdList(): Promise<void> {
  const { store } = resolveStore();
  print(await readIndex(store));
}

async function cmdRead(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem read <name>");
  }
  const { store } = resolveStore();
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
  const { store, storeDir } = resolveStore();
  const file = memoryFileFor(name);
  // Refuse a path no edit could be saved to (such as the index) before opening an editor on it.
  assertMemoryPath(file);
  const { content, version } = await readDocument(store, file);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    // no $EDITOR — print the path so it can be opened by hand
    print(join(storeDir, file));
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
  const { store } = resolveStore();
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
  const { store } = resolveStore();
  const hits = await searchMemories(store, query);
  if (hits.length === 0) {
    print(`No memories matching "${query}".`);
    return;
  }
  for (const hit of hits) {
    print(`${hit.file} — ${hit.description}`);
  }
}

function resolveTargets(
  values: { all?: boolean },
  positionals: string[]
): string[] {
  if (values.all) {
    return adapterIds();
  }
  if (positionals.length === 0) {
    die(`specify agent(s) or --all. Known: ${adapterIds().join(", ")}`);
  }
  return positionals;
}

async function cmdLink(
  args: string[],
  mode: "enable" | "disable"
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { all: { type: "boolean" } },
    allowPositionals: true,
  });
  const resolved = resolveStore();
  const ctx = context(resolved);
  for (const id of resolveTargets(values, positionals)) {
    const adapter = getAdapter(id);
    if (!adapter) {
      die(`unknown agent "${id}". Known: ${adapterIds().join(", ")}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- writes stay in argument order, and an unknown agent stops the run before later ones are touched
    const result = await (mode === "enable"
      ? adapter.link(ctx)
      : adapter.unlink(ctx));
    print(`${result.title}:`);
    for (const action of result.actions) {
      print(`  - ${action}`);
    }
  }
}

async function cmdStatus(): Promise<void> {
  const resolved = resolveStore();
  print(`Store: ${resolved.storeDir}`);
  const memories = await resolved.store.listMemoryFiles();
  print(`Memories: ${memories.length}`);
  print("Agents:");
  const ctx = context(resolved);
  const statuses = await Promise.all(
    listAdapters().map((adapter) => adapter.status(ctx))
  );
  for (const status of statuses) {
    print(
      `  ${status.linked ? "✓" : "·"} ${status.title} — ${status.details.join("; ")}`
    );
  }
}

function countMemories(count: number): string {
  return count === 1 ? "1 memory" : `${count} memories`;
}

function linkNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(/\[\[(?<name>[a-z0-9-]+)\]\]/gu)) {
    const name = match.groups?.name;
    if (name) {
      names.push(name);
    }
  }
  return names;
}

async function cmdDoctor(): Promise<void> {
  const { store } = resolveStore();
  const files = await store.listMemoryFiles();
  const problems: string[] = [];
  const known = new Set<string>();
  const parsed: { file: string; memory: Memory }[] = [];

  for (const file of files) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the read sits inside the per-file try so a failed read is reported as a problem, not thrown
      const raw = await store.view(file);
      // Checked before parsing, so a secret in an unparseable memory is reported too.
      const secrets = findSecrets(raw);
      if (secrets.length > 0) {
        problems.push(
          `${file}: looks like it holds a secret at ${describeSecrets(secrets)}`
        );
      }
      const memory = parseMemoryFile(file, raw);
      known.add(memory.frontmatter.name);
      parsed.push({ file, memory });
      if (memoryFileName(memory.frontmatter.name) !== file) {
        problems.push(`${file}: name "${memory.frontmatter.name}" ≠ filename`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const { file, memory } of parsed) {
    const pointerChars = [
      ...pointerLine({ file, frontmatter: memory.frontmatter }),
    ].length;
    if (pointerChars > POINTER_MAX_CHARS) {
      problems.push(
        `${file}: its pointer is ${pointerChars} characters, over ${POINTER_MAX_CHARS} — shorten its description`
      );
    }
    for (const name of linkNames(memory.body)) {
      if (!known.has(name)) {
        problems.push(`${file}: dangling [[${name}]]`);
      }
    }
  }

  const fresh = renderIndex(
    parsed.map(({ file, memory }) => ({
      file,
      frontmatter: memory.frontmatter,
    }))
  );
  const current = store.exists(INDEX_FILE) ? await store.view(INDEX_FILE) : "";
  if (current.trim() !== fresh.trim()) {
    problems.push("MEMORY.md is stale — run `mdmem reindex`");
  }
  for (const { over, message } of indexCapacity(fresh)) {
    if (over) {
      problems.push(message);
    }
  }

  if (problems.length === 0) {
    print(`✓ ${countMemories(files.length)}, no problems`);
    return;
  }
  print(`Found ${problems.length} problem(s):`);
  for (const problem of problems) {
    print(`  - ${problem}`);
  }
  process.exit(1);
}

function cmdConsolidate(): void {
  const { store } = resolveStore();
  process.stdout.write(getConsolidatePrompt(store.root));
}

function cmdPath(): void {
  const { storeDir } = resolveStore();
  print(storeDir);
}

function usage(): void {
  print(`mdmem — shared, Claude-style memory for any coding agent

Usage: mdmem <command> [options]

  init                      Create .memory/ in this project and gitignore it
  add --type <t> --name <n> --description <d> [--body <text>] [--force]
                            Save a memory (body may be piped via stdin; --force overwrites an existing one,
                            unless it changes while being saved)
  list                      Print the memory index (MEMORY.md)
  read <name>               Print one memory by its name (or <name>.md), or the index (MEMORY.md)
  edit <name>               Edit a copy of a memory in $VISUAL/$EDITOR, then save it back; an invalid
                            edit or one that conflicts is refused and its copy kept
  delete | rm <name>        Remove a memory by its name (or <name>.md)
  search <query>            Find memories containing text
  reindex                   Rebuild MEMORY.md from memory frontmatter
  consolidate               Print a prompt that has an agent consolidate the store
  doctor                    Check the store (parse errors, name≠filename, secrets, long pointers,
                            dangling links, stale index, index over its read limits)
  enable <agent…> | --all   Wire an agent to the shared store
  disable <agent…> | --all  Remove an agent's wiring
  status                    Show the store and which agents are enabled
  path                      Print the store directory
  mcp                       Run the MCP server over stdio (for agent tool-calls)

Agents: ${adapterIds().join(", ")}
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
  consolidate: () => cmdConsolidate(),
  enable: (args) => cmdLink(args, "enable"),
  disable: (args) => cmdLink(args, "disable"),
  status: () => cmdStatus(),
  path: () => cmdPath(),
  mcp: runMcp,
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
