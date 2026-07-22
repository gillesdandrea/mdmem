#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { AdapterContext } from "../adapters/index.ts";
import { adapterIds, getAdapter, listAdapters } from "../adapters/index.ts";
import {
  factFileName,
  MEMORY_TYPES,
  parseFact,
  serializeFact,
} from "../core/fact.ts";
import type { MemoryType } from "../core/fact.ts";
import { reindex } from "../core/index.ts";
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

function die(msg: string): never {
  process.stderr.write(`memory: ${msg}\n`);
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
      `no ${STORE_DIR}/ found in this directory or any parent — run \`memory init\` first`
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
    home: homedir(),
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
  print("Next: `memory link --all` to wire up your agents.");
}

async function cmdAdd(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      type: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      body: { type: "string" },
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
  const file = factFileName(name);
  if (store.exists(file)) {
    die(
      `a fact named "${name}" already exists — edit ${file} or choose another name`
    );
  }
  const content = serializeFact({
    frontmatter: { name, description, metadata: { type: values.type } },
    body: body.trim(),
  });
  // Parse-validate before writing so a malformed fact never lands in the store.
  parseFact(content);
  await store.create(file, content);
  await reindex(store);
  print(`Saved ${file}`);
}

async function cmdReindex(): Promise<void> {
  const { store } = resolveStore();
  await reindex(store);
  print("Rebuilt MEMORY.md");
}

async function cmdList(): Promise<void> {
  const { store } = resolveStore();
  if (!store.exists(INDEX_FILE)) {
    await reindex(store);
  }
  print(await store.view(INDEX_FILE));
}

async function cmdSearch(args: string[]): Promise<void> {
  const [query] = args;
  if (!query) {
    die("usage: memory search <query>");
  }
  const { store } = resolveStore();
  const needle = query.toLowerCase();
  let hits = 0;
  for (const file of await store.listFacts()) {
    const raw = await store.view(file);
    if (raw.toLowerCase().includes(needle)) {
      const { frontmatter } = parseFact(raw);
      print(`${file} — ${frontmatter.description}`);
      hits += 1;
    }
  }
  if (hits === 0) {
    print(`No facts matching "${query}".`);
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

async function cmdLink(args: string[], mode: "link" | "unlink"): Promise<void> {
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
    const result =
      mode === "link" ? await adapter.link(ctx) : await adapter.unlink(ctx);
    print(`${result.title}:`);
    for (const action of result.actions) {
      print(`  - ${action}`);
    }
  }
}

async function cmdStatus(): Promise<void> {
  const resolved = resolveStore();
  print(`Store: ${resolved.storeDir}`);
  const facts = await resolved.store.listFacts();
  print(`Facts: ${facts.length}`);
  print("Agents:");
  const ctx = context(resolved);
  for (const adapter of listAdapters()) {
    const status = await adapter.status(ctx);
    print(
      `  ${status.linked ? "✓" : "·"} ${status.title} — ${status.details.join("; ")}`
    );
  }
}

async function cmdSessionStart(): Promise<void> {
  // Emitted by the Claude Code SessionStart hook: injects the memory index as
  // additionalContext so a fresh session starts already aware of what is known.
  const storeDir = findStoreRoot(process.cwd());
  let index = "_No memory store found._";
  if (storeDir) {
    const store = new MemoryStore(storeDir);
    if (store.exists(INDEX_FILE)) {
      index = await store.view(INDEX_FILE);
    }
  }
  const preamble =
    "Shared project memory (.memory/). Index follows; open a fact file for detail.\n\n";
  const additionalContext = `${preamble}${index}`.slice(0, 24_000);
  print(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    })
  );
}

function usage(): void {
  print(`memory — shared, Claude-style memory for any coding agent

Usage: memory <command> [options]

  init                      Create .memory/ in this project and gitignore it
  add --type <t> --name <n> --description <d> [--body <text>]
                            Save a fact (body may be piped on stdin)
  list                      Print the memory index (MEMORY.md)
  search <query>            Find facts containing text
  reindex                   Rebuild MEMORY.md from fact frontmatter
  link <agent…> | --all     Wire an agent to the shared store
  unlink <agent…> | --all   Remove an agent's wiring
  status                    Show the store and which agents are linked
  session-start             Emit the Claude SessionStart hook payload

Agents: ${adapterIds().join(", ")}
Fact types: ${MEMORY_TYPES.join(", ")}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "init": {
      await cmdInit();
      break;
    }
    case "add": {
      await cmdAdd(args);
      break;
    }
    case "list": {
      await cmdList();
      break;
    }
    case "search": {
      await cmdSearch(args);
      break;
    }
    case "reindex": {
      await cmdReindex();
      break;
    }
    case "link": {
      await cmdLink(args, "link");
      break;
    }
    case "unlink": {
      await cmdLink(args, "unlink");
      break;
    }
    case "status": {
      await cmdStatus();
      break;
    }
    case "session-start": {
      await cmdSessionStart();
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      usage();
      break;
    }
    default: {
      die(`unknown command "${command}". Run \`memory help\`.`);
    }
  }
}

await main();
