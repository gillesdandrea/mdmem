#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  parseMemory,
  parseMemoryFile,
} from "../core/memory.ts";
import type { Memory, MemoryType } from "../core/memory.ts";
import {
  readIndex,
  reindexAfterWrite,
  removeMemory,
  saveMemory,
  searchMemories,
} from "../core/operations.ts";
import type { WriteResult } from "../core/operations.ts";
import { getConsolidatePrompt } from "../core/protocol.ts";
import { describeSecrets, findSecrets } from "../core/secrets.ts";
import {
  findProjectRoot,
  findStoreRoot,
  INDEX_FILE,
  MemoryStore,
  STORE_DIR,
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

interface Resolved {
  store: MemoryStore;
  storeDir: string;
  projectRoot: string;
}

function resolveStore(): Resolved {
  const storeDir = findStoreRoot(process.cwd());
  if (!storeDir) {
    die(
      `no ${STORE_DIR}/ found in this directory or any parent — run \`mdmem init\` first`
    );
  }
  return {
    store: new MemoryStore(storeDir),
    storeDir,
    projectRoot: dirname(storeDir),
  };
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
  if (store.exists(memoryFileName(name)) && !values.force) {
    die(
      `a memory named "${name}" already exists — pass --force to overwrite, or \`mdmem delete ${name}\``
    );
  }
  const result = await saveMemory(store, {
    name,
    description,
    type: values.type,
    body: body.trim(),
  });
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
  const file = memoryFileFor(name);
  if (!store.exists(file)) {
    die(`no memory "${name}" (looked for ${file})`);
  }
  print(await store.view(file));
}

async function cmdEdit(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem edit <name>");
  }
  const { store, storeDir } = resolveStore();
  const file = memoryFileFor(name);
  if (!store.exists(file)) {
    die(`no memory "${name}" (looked for ${file})`);
  }
  const fullPath = join(storeDir, file);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    // no $EDITOR — print the path so it can be opened by hand
    print(fullPath);
    return;
  }
  const [cmd, ...editorArgs] = editor.split(" ");
  const proc = Bun.spawnSync([cmd ?? editor, ...editorArgs, fullPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    die(`editor exited with code ${proc.exitCode}`);
  }
  try {
    parseMemory(await store.view(file));
  } catch (error) {
    die(
      `edited memory is invalid, not reindexed — ${error instanceof Error ? error.message : String(error)}`
    );
  }
  reportWrite("Saved", await reindexAfterWrite(store, file));
}

async function cmdDelete(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    die("usage: mdmem delete <name>");
  }
  const { store } = resolveStore();
  const result = await removeMemory(store, name);
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
                            Save a memory (body may be piped via stdin; --force overwrites an existing one)
  list                      Print the memory index (MEMORY.md)
  read <name>               Print one memory by its name (or <name>.md)
  edit <name>               Open a memory in $VISUAL/$EDITOR, reindex on save
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
    // Expected failures (a broken memory, a version conflict) end as one line, not a stack trace.
    die(error instanceof Error ? error.message : String(error));
  }
}

await main();
