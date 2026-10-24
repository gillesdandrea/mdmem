import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { INDEX_FILE, pointerTarget, reindex } from "./check.ts";
import { worktreePaths } from "./git.ts";
import { describeSecrets, findSecrets } from "./secrets.ts";
import type { MemoryStore } from "./store.ts";
import { realDir, STORE_DIR } from "./store.ts";
import { LINE_BREAK_RE, lineEndingOf } from "./text.ts";

/**
 * The one-time import of Claude Code's auto memory into a project's store (ADR 0003,
 * ADR 0004): once Claude Code is wired, its own memory is off, so the memories it
 * already holds for the repository move into `.memory/` when that store is created.
 * The merge is mechanical: it compares files, not meaning, never refuses, and backs
 * an existing store up before it writes. Claude's directories are only read.
 */

/** Where Claude Code's directories are: its config directory comes from the environment, else the home directory. */
export interface ClaudeEnvironment {
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface ImportOptions extends ClaudeEnvironment {
  /** The time the backup is named after. */
  now?: Date;
}

/** A memory file copied into the store, and the Claude memory directory it came from. */
export interface ImportedFile {
  file: string;
  from: string;
}

/** What an import did. Every list is empty, and `backup` unset, when there was nothing to do. */
export interface ImportResult {
  /** The Claude memory directories read, the repository's key first. */
  sources: string[];
  /** Files that were in Claude's directories only, now in the store. */
  copied: ImportedFile[];
  /**
   * Claude's versions of a file that differ from the one the store holds or took
   * (the store's own, else the first Claude directory's): not imported, so they
   * are only in Claude's directories.
   */
  leftBehind: ImportedFile[];
  /** Files held by more than one place with the same content, kept once. */
  collapsed: string[];
  /** Entries of Claude's directories that are not memory files (a regular `*.md` file other than the index), left where they are. */
  skipped: ImportedFile[];
  /** The copy of the store taken before anything was written; unset when nothing was, or the store did not exist when the import was planned. */
  backup?: string;
  /** Whether memories from more than one place now sit together, so a consolidation may find duplicates. */
  merged: boolean;
  /** Warnings the CLI prints as it prints reindex's: a copied file that looks like it holds a secret, and the index's. */
  warnings: string[];
}

/** Claude Code cuts a project key longer than this and appends a hash of the path. */
const KEY_MAX_LENGTH = 200;
const HASH_RADIX = 36;
const HASH_MULTIPLIER = 31;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= CHAR_0 && code <= CHAR_9) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z)
  );
}

/** Java's `String.hashCode` over UTF-16 code units, as a signed 32-bit integer. */
function stringHash(text: string): number {
  let hash = 0;
  // Indexed, not for...of: the hash runs over UTF-16 code units, and for...of yields code points.
  for (let i = 0; i < text.length; i += 1) {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- Java's hash wraps to 32 bits over UTF-16 code units, as Claude Code's does
    hash = (Math.imul(HASH_MULTIPLIER, hash) + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * The name of Claude Code's project directory for `path`. This mirrors Claude Code's
 * own encoding, which is undocumented; verified against Claude Code 2.1.302 with
 * `claude -p`: every UTF-16 code unit that is not an ASCII letter or digit becomes
 * `-` (so `/`, `.`, `_`, spaces and `é` each give one, an emoji two), and a key
 * longer than 200 characters is cut at 200 and followed by `-` and the base-36
 * absolute value of the path's Java-style string hash.
 */
export function claudeProjectKey(path: string): string {
  let key = "";
  // Indexed, not for...of: Claude Code maps UTF-16 code units, and for...of yields code points.
  for (let i = 0; i < path.length; i += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Claude Code replaces each UTF-16 code unit, so an emoji gives two dashes
    key += isAsciiAlphanumeric(path.charCodeAt(i)) ? path[i] : "-";
  }
  if (key.length <= KEY_MAX_LENGTH) {
    return key;
  }
  const hash = Math.abs(stringHash(path)).toString(HASH_RADIX);
  return `${key.slice(0, KEY_MAX_LENGTH)}-${hash}`;
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeConfigDir({
  env = process.env,
  home = homedir(),
}: ClaudeEnvironment): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

/** Claude Code's `projects/` directory, in its config directory. */
function claudeProjectsDir(environment: ClaudeEnvironment): string {
  return join(claudeConfigDir(environment), "projects");
}

/**
 * Claude Code's project directory for the project at `projectRoot`: named by
 * `CLAUDE_CODE_PROJECT_DIR_NAME` when set, else by `claudeProjectKey`.
 */
export function claudeProjectDir(
  projectRoot: string,
  environment: ClaudeEnvironment = {}
): string {
  const env = environment.env ?? process.env;
  const key = env.CLAUDE_CODE_PROJECT_DIR_NAME || claudeProjectKey(projectRoot);
  return join(claudeProjectsDir(environment), key);
}

const CLAUDE_MEMORY_DIR = "memory";

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every Claude memory directory of the repository that exists: the project
 * directory's at the repository's key first, then one per worktree path that Claude
 * keyed on its own (older Claude Code keyed a bare repository's worktree apart).
 */
async function claudeSources(
  projectRoot: string,
  environment: ClaudeEnvironment
): Promise<string[]> {
  const projects = claudeProjectsDir(environment);
  const candidates = [
    join(claudeProjectDir(projectRoot, environment), CLAUDE_MEMORY_DIR),
    ...worktreePaths(projectRoot).map((path) =>
      join(projects, claudeProjectKey(path), CLAUDE_MEMORY_DIR)
    ),
  ];
  const unique = [...new Set(candidates)];
  const exists = await Promise.all(unique.map(isDirectory));
  return unique.filter((_, i) => exists[i]);
}

function isIndexName(file: string): boolean {
  return file.toLowerCase() === INDEX_FILE.toLowerCase();
}

/** What a Claude memory directory holds at its top level, sorted, the index left out. */
interface ClaudeEntries {
  /** Its memory files: regular `*.md` files, as `MemoryStore.listFiles` counts them. */
  files: string[];
  /** Everything else, which the import leaves where it is. */
  skipped: string[];
}

async function claudeEntries(dir: string): Promise<ClaudeEntries> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && isIndexName(entry.name)) {
      continue;
    }
    (entry.isFile() && entry.name.endsWith(".md") ? files : skipped).push(
      entry.name
    );
  }
  return { files, skipped };
}

/** A version of a memory file held by one place. */
interface Copy {
  from: string;
  /** The file's name in that place. */
  file: string;
  raw: string;
}

/**
 * The name files are matched by: macOS and Windows ignore case, so `A.md` and `a.md`
 * are one file there, and copying one would overwrite the other.
 */
function matchKey(file: string): string {
  return file.toLowerCase();
}

const FRONTMATTER_BLOCK_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;
const MODIFIED_LINE_RE = /^[ \t]*modified:.*(?:\r?\n|$)/gmu;

/**
 * `raw` as an import compares it: Claude Code stamps `modified:` in a memory's
 * frontmatter each time it saves, so that line is left out. Nothing else changes.
 */
function comparable(raw: string): string {
  return raw.replace(FRONTMATTER_BLOCK_RE, (block) =>
    block.replaceAll(MODIFIED_LINE_RE, "")
  );
}

function sameMemory(a: string, b: string): boolean {
  return a === b || comparable(a) === comparable(b);
}

/** How one file name is resolved: copied from Claude, or the store's file kept; either way, Claude's other versions are left behind. */
type Resolution =
  | { kind: "copy"; copy: Copy; collapsed: boolean; leftBehind: Copy[] }
  | { kind: "keep"; collapsed: boolean; leftBehind: Copy[] };

/** Claude's copies of one file, with the same content (bar `modified:`) kept once, in source order. */
function distinctCopies(copies: readonly Copy[]): Copy[] {
  const distinct: Copy[] = [];
  for (const copy of copies) {
    if (!distinct.some(({ raw }) => sameMemory(raw, copy.raw))) {
      distinct.push(copy);
    }
  }
  return distinct;
}

function storePath(store: MemoryStore, file: string): string {
  return join(store.root, file);
}

/**
 * Decide what becomes of `file`, held by the store as `stored` (undefined when it
 * is not there) and by Claude's directories as `copies`. The store's file wins,
 * else the first Claude directory's (the repository's own key comes first); every
 * other version is left in Claude's directories, so nothing is lost and nothing
 * refuses: the import runs as a store is created, inside a write that must land.
 */
function resolveFile(
  file: string,
  stored: string | undefined,
  copies: readonly Copy[]
): Resolution {
  const distinct = distinctCopies(copies);
  const [first, ...others] = distinct;
  if (first === undefined) {
    throw new Error(
      `${file}: resolved with no Claude copy; a file is resolved only when some Claude directory holds it`
    );
  }
  const collapsed = copies.length > distinct.length;
  if (stored !== undefined) {
    const leftBehind = distinct.filter((c) => !sameMemory(c.raw, stored));
    return {
      kind: "keep",
      collapsed: collapsed || leftBehind.length < distinct.length,
      leftBehind,
    };
  }
  return { kind: "copy", copy: first, collapsed, leftBehind: others };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * The pointer lines of the sources' indexes that the store's index lacks, in source
 * order, each memory file's first only, and only for files the store will hold.
 */
function newPointerLines(
  storeIndex: string,
  sourceIndexes: readonly (string | undefined)[],
  files: ReadonlySet<string>
): string[] {
  const pointed = new Set<string>();
  for (const line of storeIndex.split(LINE_BREAK_RE)) {
    const target = pointerTarget(line);
    if (target !== undefined) {
      pointed.add(target);
    }
  }
  const lines: string[] = [];
  for (const index of sourceIndexes) {
    for (const line of index?.split(LINE_BREAK_RE) ?? []) {
      const target = pointerTarget(line);
      if (target !== undefined && files.has(target) && !pointed.has(target)) {
        pointed.add(target);
        lines.push(line);
      }
    }
  }
  return lines;
}

/** `index` with `lines` appended, in its own line ending. */
function appendLines(index: string, lines: readonly string[]): string {
  const eol = lineEndingOf(index);
  const head = index === "" || index.endsWith("\n") ? index : `${index}${eol}`;
  return `${head}${lines.map((line) => `${line}${eol}`).join("")}`;
}

/** A timestamp safe in a file name on every filesystem. */
function backupStamp(now: Date): string {
  return now.toISOString().replaceAll(/[:.]/gu, "-");
}

/**
 * Copy the store to `<Claude project dir>/mdmem-backup-<timestamp>/mdmem/`, and
 * return that path; undefined when the store does not exist yet, so holds nothing.
 */
async function backUp(
  store: MemoryStore,
  projectRoot: string,
  options: ImportOptions
): Promise<string | undefined> {
  if (!(await isDirectory(store.root))) {
    return undefined;
  }
  const backup = join(
    claudeProjectDir(projectRoot, options),
    `mdmem-backup-${backupStamp(options.now ?? new Date())}`,
    "mdmem"
  );
  await mkdir(backup, { recursive: true });
  await cp(store.root, backup, { recursive: true });
  return backup;
}

/** What Claude's directories hold. */
interface ClaudeHoldings {
  /** Every memory file, by `matchKey`, with each directory's copy in source order. */
  copiesByKey: Map<string, Copy[]>;
  skipped: ImportedFile[];
}

async function readClaudeDirectories(
  sources: readonly string[]
): Promise<ClaudeHoldings> {
  const listed = await Promise.all(
    sources.map(async (from) => {
      const { files, skipped } = await claudeEntries(from);
      const raws = await Promise.all(
        files.map((file) => readFile(join(from, file), "utf-8"))
      );
      return { from, files, raws, skipped };
    })
  );
  const copiesByKey = new Map<string, Copy[]>();
  const skipped: ImportedFile[] = [];
  for (const { from, files, raws, skipped: others } of listed) {
    for (const [i, file] of files.entries()) {
      const key = matchKey(file);
      const copies = copiesByKey.get(key) ?? [];
      copies.push({ from, file, raw: raws[i] ?? "" });
      copiesByKey.set(key, copies);
    }
    skipped.push(...others.map((file) => ({ file, from })));
  }
  return { copiesByKey, skipped };
}

/** A memory file in the store: its name and text. */
interface Stored {
  file: string;
  raw: string;
}

/** The store's memory files, by `matchKey`, the index left out. */
async function storedMemories(
  store: MemoryStore
): Promise<Map<string, Stored>> {
  const documents = await store.listFiles();
  const files = documents.filter((f) => !isIndexName(f));
  const raws = await Promise.all(files.map((file) => store.view(file)));
  return new Map(
    files.map((file, i) => [matchKey(file), { file, raw: raws[i] ?? "" }])
  );
}

/** A file an import writes: its name in the store, the Claude directory it came from, and its text. */
interface Write extends ImportedFile {
  raw: string;
}

/** What an import will do. */
interface ImportPlan extends Pick<
  ImportResult,
  "copied" | "leftBehind" | "collapsed"
> {
  writes: Write[];
  /** The files whose store version was kept over a differing Claude version. */
  kept: string[];
}

/** Resolve every file Claude's directories hold against the store; nothing is written. */
function planImport(
  copiesByKey: ReadonlyMap<string, Copy[]>,
  stored: ReadonlyMap<string, Stored>
): ImportPlan {
  const plan: ImportPlan = {
    writes: [],
    kept: [],
    copied: [],
    leftBehind: [],
    collapsed: [],
  };
  const byName = [...copiesByKey].toSorted(([a], [b]) => (a < b ? -1 : 1));
  for (const [key, copies] of byName) {
    // A file keeps the store's spelling of its name, else the first Claude directory's.
    const file = stored.get(key)?.file ?? copies[0]?.file ?? key;
    const resolution = resolveFile(file, stored.get(key)?.raw, copies);
    plan.leftBehind.push(
      ...resolution.leftBehind.map(({ from }) => ({ file, from }))
    );
    if (resolution.collapsed) {
      plan.collapsed.push(file);
    }
    if (resolution.kind === "keep") {
      if (resolution.leftBehind.length > 0) {
        plan.kept.push(file);
      }
      continue;
    }
    const imported = { file, from: resolution.copy.from };
    plan.writes.push({ ...imported, raw: resolution.copy.raw });
    plan.copied.push(imported);
  }
  return plan;
}

/** A warning for each written file that looks like it holds a secret: an import copies files as they are. */
function secretWarnings(writes: readonly Write[]): string[] {
  return writes.flatMap(({ file, raw }) => {
    const secrets = findSecrets(raw);
    return secrets.length === 0
      ? []
      : [
          `${file}: imported as it is, and it looks like it holds a secret at ${describeSecrets(secrets)}; remove it before committing ${STORE_DIR}/`,
        ];
  });
}

/** The file, in Claude Code's project directory for the repository, that records an import ran there for this user. */
const IMPORT_MARKER = "mdmem-imported";

/**
 * Where the import of the repository whose store is `store` is recorded as done:
 * next to its backups, so per user and per repository, and outside the store.
 */
export function importMarker(
  store: MemoryStore,
  environment: ClaudeEnvironment = {}
): string {
  // Claude Code keys the physical path, symlinks resolved.
  const projectRoot = realDir(dirname(store.root));
  return join(claudeProjectDir(projectRoot, environment), IMPORT_MARKER);
}

/** What the import marker at `marker` records, trimmed (when the import ran, and into which store); undefined when there is none. */
export async function readImportMarker(
  marker: string
): Promise<string | undefined> {
  if (!existsSync(marker)) {
    return undefined;
  }
  const text = await readFile(marker, "utf-8");
  return text.trim();
}

/** Record at `marker` that the import into `store` ran at `now`. */
export async function writeImportMarker(
  marker: string,
  store: MemoryStore,
  now: Date = new Date()
): Promise<void> {
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, `${now.toISOString()} into ${store.root}\n`, "utf-8");
}

/** An import planned: Claude's directories and the store read, its conflicts refused, nothing written yet. */
export type PlannedImport = () => Promise<ImportResult>;

/**
 * Plan importClaudeMemories: read Claude's directories and the store; the returned
 * function does the writes and reports them. Nothing is written until it is called,
 * and a store that does not exist yet when planned gets no backup.
 */
export async function planClaudeImport(
  store: MemoryStore,
  options: ImportOptions = {}
): Promise<PlannedImport> {
  const projectRoot = realDir(dirname(store.root));
  const sources = await claudeSources(projectRoot, options);
  const { copiesByKey, skipped } = await readClaudeDirectories(sources);
  const stored = await storedMemories(store);
  const existed = await isDirectory(store.root);

  const {
    writes,
    kept: keptFiles,
    ...outcome
  } = planImport(copiesByKey, stored);
  const result: ImportResult = {
    sources,
    ...outcome,
    skipped,
    merged: false,
    warnings: [],
  };

  const storeIndex = (await readIfPresent(storePath(store, INDEX_FILE))) ?? "";
  const sourceIndexes = await Promise.all(
    sources.map((from) => readIfPresent(join(from, INDEX_FILE)))
  );
  // A kept file's pointer comes from the store's version, never Claude's.
  const kept = new Set(keptFiles);
  const files = new Set([
    ...[...stored.values()]
      .map(({ file }) => file)
      .filter((file) => !kept.has(file)),
    ...writes.map(({ file }) => file),
  ]);
  const pointers = newPointerLines(storeIndex, sourceIndexes, files);
  if (writes.length === 0 && pointers.length === 0) {
    return () => Promise.resolve(result);
  }

  return async () => {
    result.backup = existed
      ? await backUp(store, projectRoot, options)
      : undefined;
    for (const { file, raw } of writes) {
      // oxlint-disable-next-line no-await-in-loop -- a few files, written in order
      await store.create(file, raw);
    }
    if (pointers.length > 0) {
      await store.create(INDEX_FILE, appendLines(storeIndex, pointers));
    }
    result.warnings = [...secretWarnings(writes), ...(await reindex(store))];
    const fromSources = new Set(writes.map(({ from }) => from));
    result.merged =
      writes.length > 0 && (stored.size > 0 || fromSources.size > 1);
    return result;
  };
}

/**
 * Import Claude Code's memories for the project whose store is `store` (ADR 0003):
 * the memory directory at the repository's key and every other Claude project
 * directory of the repository's worktrees. A file in one place only is copied, files
 * with the same content (bar Claude's `modified:` stamp) are kept once, and a memory
 * that breaks mdmem's write rules is copied as it is. Of same-name files with
 * different content, the store's is kept, else the first Claude directory's is
 * copied, and the others are reported as left behind. Each source index's pointer
 * lines are appended after the store's, then the index is reconciled as `reindex`
 * does. An existing store is backed up before the first write; with nothing new,
 * nothing is written. Claude's directories are only read.
 */
export async function importClaudeMemories(
  store: MemoryStore,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const write = await planClaudeImport(store, options);
  return await write();
}

function fileList(files: readonly ImportedFile[]): string[] {
  return files.map(({ file, from }) => `    ${file} (from ${from})`);
}

const NOTHING_FOUND =
  "No Claude Code memories for this project: nothing to import.";

/** An import's report as the CLI prints it, one line each; the CLI prints `warnings` itself. */
export function formatImport(result: ImportResult): string[] {
  const wrote = result.backup !== undefined || result.copied.length > 0;
  const found =
    wrote || result.leftBehind.length > 0 || result.collapsed.length > 0;
  const lines: string[] = [];
  if (!found) {
    lines.push(NOTHING_FOUND);
  } else if (!wrote) {
    lines.push(
      result.leftBehind.length > 0
        ? `Nothing to import: ${STORE_DIR}/ keeps its own version of every file that differs.`
        : `Claude Code's memories are already in ${STORE_DIR}/: nothing to import.`
    );
  } else if (result.backup !== undefined) {
    lines.push(`Backed up ${STORE_DIR}/ to ${result.backup}`);
  }
  if (result.copied.length > 0) {
    lines.push(`Copied into ${STORE_DIR}/:`, ...fileList(result.copied));
  }
  if (result.leftBehind.length > 0) {
    lines.push(
      "Other versions, not imported, left in Claude's directories:",
      ...fileList(result.leftBehind)
    );
  }
  if (result.collapsed.length > 0) {
    lines.push(`Identical, kept once: ${result.collapsed.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    lines.push(
      "Not memory files, left in Claude's directories:",
      ...fileList(result.skipped)
    );
  }
  if (!found) {
    return lines;
  }
  const leftOnlyThere = [
    ...(result.leftBehind.length > 0 ? ["the versions not imported"] : []),
    ...(result.skipped.length > 0 ? ["the entries left in them"] : []),
  ];
  lines.push(
    leftOnlyThere.length > 0
      ? `These directories can be deleted once you no longer need ${leftOnlyThere.join(" or ")}, which are nowhere else:`
      : "Claude Code's memories now live in the store; these directories can be deleted:",
    ...result.sources.map((dir) => `    ${dir}`)
  );
  if (result.merged) {
    lines.push(
      "Memories from more than one place were merged: run `mdmem consolidate` to merge duplicates."
    );
  }
  return lines;
}
