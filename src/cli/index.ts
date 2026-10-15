#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { AdapterContext } from "../adapters/index.ts";
import { adapterIds, getAdapter, listAdapters } from "../adapters/index.ts";
import {
  factFileFor,
  factFileName,
  MEMORY_TYPES,
  parseFact,
} from "../core/fact.ts";
import type { Fact, MemoryType } from "../core/fact.ts";
import { reindex, renderIndex } from "../core/index.ts";
import {
  readIndex,
  removeFact,
  saveFact,
  searchFacts,
} from "../core/operations.ts";
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
  if (store.exists(factFileName(name)) && !values.force) {
    die(
      `a fact named "${name}" already exists — pass --force to overwrite, or \`mdmem delete ${name}\``
    );
  }
  const file = await saveFact(store, {
    name,
    description,
    type: values.type,
    body: body.trim(),
  });
  print(`Saved ${file}`);
}

async function cmdReindex(): Promise<void> {
  const { store } = resolveStore();
  await reindex(store);
  print("Rebuilt MEMORY.md");
}

async function cmdList(): Promise<void> {
  const { store } = resolveStore();
  print(await readIndex(store));
}

async function cmdRead(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) {
    die("usage: mdmem read <id>");
  }
  const { store } = resolveStore();
  const file = factFileFor(id);
  if (!store.exists(file)) {
    die(`no fact "${id}" (looked for ${file})`);
  }
  print(await store.view(file));
}

async function cmdEdit(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) {
    die("usage: mdmem edit <id>");
  }
  const { store, storeDir } = resolveStore();
  const file = factFileFor(id);
  if (!store.exists(file)) {
    die(`no fact "${id}" (looked for ${file})`);
  }
  const fullPath = join(storeDir, file);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    print(fullPath); // no $EDITOR — print the path so it can be opened by hand
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
    parseFact(await store.view(file));
  } catch (error) {
    die(
      `edited fact is invalid, not reindexed — ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await reindex(store);
  print(`Saved ${file}`);
}

async function cmdDelete(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) {
    die("usage: mdmem delete <id>");
  }
  const { store } = resolveStore();
  const file = await removeFact(store, id);
  if (!file) {
    die(`no fact "${id}" (looked for ${factFileFor(id)})`);
  }
  print(`Deleted ${file}`);
}

async function cmdSearch(args: string[]): Promise<void> {
  const [query] = args;
  if (!query) {
    die("usage: mdmem search <query>");
  }
  const { store } = resolveStore();
  const hits = await searchFacts(store, query);
  if (hits.length === 0) {
    print(`No facts matching "${query}".`);
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
    const result =
      mode === "enable" ? await adapter.link(ctx) : await adapter.unlink(ctx);
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

function wikilinkSlugs(body: string): string[] {
  const slugs: string[] = [];
  for (const match of body.matchAll(/\[\[(?<slug>[a-z0-9-]+)\]\]/gu)) {
    const slug = match.groups?.slug;
    if (slug) {
      slugs.push(slug);
    }
  }
  return slugs;
}

async function cmdDoctor(): Promise<void> {
  const { store } = resolveStore();
  const files = await store.listFacts();
  const problems: string[] = [];
  const known = new Set<string>();
  const parsed: { file: string; fact: Fact }[] = [];

  for (const file of files) {
    try {
      const fact = parseFact(await store.view(file));
      known.add(fact.frontmatter.name);
      parsed.push({ file, fact });
      if (factFileName(fact.frontmatter.name) !== file) {
        problems.push(`${file}: name "${fact.frontmatter.name}" ≠ filename`);
      }
    } catch (error) {
      problems.push(
        `${file}: unparseable — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const { file, fact } of parsed) {
    for (const slug of wikilinkSlugs(fact.body)) {
      if (!known.has(slug)) {
        problems.push(`${file}: dangling [[${slug}]]`);
      }
    }
  }

  const fresh = renderIndex(
    parsed.map(({ file, fact }) => ({ file, frontmatter: fact.frontmatter }))
  );
  const current = store.exists(INDEX_FILE) ? await store.view(INDEX_FILE) : "";
  if (current.trim() !== fresh.trim()) {
    problems.push("MEMORY.md is stale — run `mdmem reindex`");
  }

  if (problems.length === 0) {
    print(`✓ ${files.length} fact(s), no problems`);
    return;
  }
  print(`Found ${problems.length} problem(s):`);
  for (const problem of problems) {
    print(`  - ${problem}`);
  }
  process.exit(1);
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
                            Save a fact (body may be piped via stdin; --force overwrites a slug)
  list                      Print the memory index (MEMORY.md)
  read <id>                 Print one fact by its id (slug or <slug>.md)
  edit <id>                 Open a fact in $VISUAL/$EDITOR, reindex on save
  delete | rm <id>          Remove a fact by its id (slug or <slug>.md)
  search <query>            Find facts containing text
  reindex                   Rebuild MEMORY.md from fact frontmatter
  doctor                    Check the store (parse errors, name≠filename, dangling links, stale index)
  enable <agent…> | --all   Wire an agent to the shared store
  disable <agent…> | --all  Remove an agent's wiring
  status                    Show the store and which agents are enabled
  path                      Print the store directory
  mcp                       Run the MCP server over stdio (for agent tool-calls)

Agents: ${adapterIds().join(", ")}
Fact types: ${MEMORY_TYPES.join(", ")}`);
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
  await handler(args);
}

await main();
