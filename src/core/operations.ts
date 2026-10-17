import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { INDEX_FILE, loadMemories, refreshIndex, reindex } from "./check.ts";
import { isIgnoredByGit } from "./git.ts";
import type { Memory, MemoryType } from "./memory.ts";
import {
  memoryFileFor,
  memoryFileName,
  parseMemoryFile,
  serializeMemory,
} from "./memory.ts";
import { RefusalError } from "./refusal.ts";
import { assertNoSecrets } from "./secrets.ts";
import {
  locateStore,
  MemoryStore,
  NEW_FILE_VERSION,
  STORE_DIR,
  versionOf,
} from "./store.ts";
import type { DocumentInfo } from "./store.ts";

/**
 * Memory-level operations shared by both surfaces (CLI and MCP). They compose the
 * store's file ops with memory (de)serialization and the Check module (./check.ts),
 * which loads the memories and refreshes the index, so the two surfaces can't drift —
 * the CLI and MCP keep only their own argument parsing and output. The document
 * operations (writeDocument, deleteDocument) are the one path by which a memory is
 * written or deleted, and every validation lives there; readDocument reads one memory
 * by its path, and searchMemories searches the memories the Check module loads.
 */

/** The store of the project holding `startDir` (store.ts's locateStore says where it is). */
export function openStore(startDir: string): MemoryStore {
  const location = locateStore(startDir);
  if (!location.exists) {
    throw new RefusalError(
      `No ${STORE_DIR}/ store for this project (looked for ${location.dir}): run \`mdmem init\` in the project first`
    );
  }
  return new MemoryStore(location.dir);
}

/** What `mdmem init` did: the project's store, whether init created it, and whether git ignores it. */
export interface InitResult {
  store: MemoryStore;
  created: boolean;
  /** Whether git ignores the store; undefined outside a git work tree. */
  ignored: boolean | undefined;
}

/**
 * Create the store of the project holding `startDir`, with an empty index, unless it
 * exists. It never edits `.gitignore`: whether to ignore or commit the store is the
 * user's choice, so it only reports whether git ignores it.
 */
export async function initStore(startDir: string): Promise<InitResult> {
  const location = locateStore(startDir);
  const store = new MemoryStore(location.dir);
  if (!location.exists) {
    await mkdir(location.dir, { recursive: true });
    await reindex(store);
  }
  return {
    store,
    created: !location.exists,
    ignored: isIgnoredByGit(location.root, STORE_DIR),
  };
}

/**
 * The memory file a write touched, and the warnings the write leaves: the rebuilt
 * MEMORY.md near or over Claude Code's read limits, or MEMORY.md stale because it
 * could not be rebuilt (e.g. another memory is unparseable). The write landed either
 * way, so callers report it, then each warning. The warnings are worded once here so
 * the CLI and MCP say the same thing.
 */
export interface WriteResult {
  file: string;
  warnings: string[];
}

/** Rebuild the index after `file` was written or removed, keeping any failure as a warning. */
async function reindexAfterWrite(
  store: MemoryStore,
  file: string
): Promise<WriteResult> {
  return { file, warnings: await refreshIndex(store) };
}

/** How many documents one listing page holds; a longer listing continues from a cursor. */
export const STORE_PAGE_SIZE = 50;

/** A memory store as a stores listing shows it. */
export interface StoreInfo {
  id: string;
  description: string;
  writable: boolean;
  index: string;
}

/** mdmem serves one store per project, named after the project directory that holds `.memory/`. */
export function describeStore(store: MemoryStore): StoreInfo {
  const id = basename(dirname(store.root));
  return {
    id,
    description: `Shared memory for ${id}`,
    writable: true,
    index: INDEX_FILE,
  };
}

/** Accept a caller's store id: omitted or the project's store id; anything else names the valid ids. */
export function assertStoreId(
  store: MemoryStore,
  id: string | undefined
): void {
  const valid = describeStore(store).id;
  if (id !== undefined && id !== valid) {
    throw new RefusalError(`Unknown store "${id}". Valid store ids: ${valid}`);
  }
}

export interface DocumentPage {
  documents: DocumentInfo[];
  /** Set when more documents follow: pass it back as `cursor` to continue. */
  nextCursor?: string;
}

/**
 * One page of the store's memory documents, sorted by path. The store is flat, so
 * `pathPrefix` filters top-level names; `cursor` is the last path of the previous page.
 * A missing index is generated first, as `readDocument` does, so the listing shows it;
 * if it can't be generated (a memory is unparseable), the rest is still listed.
 */
export async function listDocuments(
  store: MemoryStore,
  { pathPrefix = "", cursor }: { pathPrefix?: string; cursor?: string } = {}
): Promise<DocumentPage> {
  if (!store.exists(INDEX_FILE)) {
    await refreshIndex(store);
  }
  const all = await store.listDocuments();
  const matching = all.filter(
    ({ path }) =>
      path.startsWith(pathPrefix) && (cursor === undefined || path > cursor)
  );
  const documents = matching.slice(0, STORE_PAGE_SIZE);
  return matching.length > documents.length
    ? { documents, nextCursor: documents.at(-1)?.path }
    : { documents };
}

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface SearchHit {
  file: string;
  description: string;
}

/** A search's hits, and a warning for each broken memory it could not search. */
export interface SearchResult {
  hits: SearchHit[];
  warnings: string[];
}

/**
 * The memories whose raw text contains `query` (case-insensitive), with their
 * descriptions, in file order. It answers from the memories that parse; each broken
 * one is a warning, not a failure (ADR 0002).
 */
export async function searchMemories(
  store: MemoryStore,
  query: string
): Promise<SearchResult> {
  const needle = query.toLowerCase();
  const { memories, broken } = await loadMemories(store);
  const hits = memories
    .filter(({ raw }) => raw.toLowerCase().includes(needle))
    .map(({ file, memory }) => ({
      file,
      description: memory.frontmatter.description,
    }));
  return { hits, warnings: broken.map(({ problem }) => problem) };
}

/** The index text, generating it first if it doesn't exist yet. */
export async function readIndex(store: MemoryStore): Promise<string> {
  if (!store.exists(INDEX_FILE)) {
    await reindex(store);
  }
  return store.view(INDEX_FILE);
}

/**
 * Whether `path` names the index. The match ignores case: on a case-insensitive
 * filesystem (macOS, Windows) `memory.md` opens `MEMORY.md`, so a write or delete
 * there would reach the index.
 */
function isIndexPath(path: string): boolean {
  return path.toLowerCase() === INDEX_FILE.toLowerCase();
}

/** A memory document's content and the version token naming it. */
export interface VersionedDocument {
  content: string;
  version: string;
}

/** `readDocument`, but null when no document is at `path`. */
async function findDocument(
  store: MemoryStore,
  path: string
): Promise<VersionedDocument | null> {
  let content: string;
  if (isIndexPath(path)) {
    content = await readIndex(store);
  } else if (path.endsWith(".md") && store.exists(path)) {
    content = await store.view(path);
  } else {
    return null;
  }
  return { content, version: versionOf(content) };
}

/** A memory document by its path in the store; the index is generated first if it doesn't exist yet. */
export async function readDocument(
  store: MemoryStore,
  path: string
): Promise<VersionedDocument> {
  const document = await findDocument(store, path);
  if (!document) {
    throw new RefusalError(`No memory document at "${path}"`);
  }
  return document;
}

/** A write that landed, with the version token of the content it wrote. */
export interface VersionedWriteResult extends WriteResult {
  version: string;
}

/** Refuse a memory write whose path can't hold a memory, before touching the store. */
export function assertMemoryPath(path: string): void {
  if (path.includes("/") || path.includes("\\")) {
    throw new RefusalError(
      `Refused "${path}": memories live at the top of the store, and nested files are never indexed or searched; use a path with no directory`
    );
  }
  if (isIndexPath(path)) {
    throw new RefusalError(
      `Refused "${path}": that is the index's path (${INDEX_FILE}), and the index is generated from the memories' frontmatter; write a memory instead`
    );
  }
  if (!path.endsWith(".md")) {
    throw new RefusalError(`Refused "${path}": a memory's path is <name>.md`);
  }
}

/** Parse the content of a write; content that is not a memory is refused. */
function parseWrittenMemory(path: string, content: string): Memory {
  try {
    return parseMemoryFile(path, content);
  } catch (error) {
    throw new RefusalError(
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
      }
    );
  }
}

/**
 * Write a whole memory document under the store's version guard: `ifVersion` is the
 * version last read or written at `path`, or `new` for a file that must not exist
 * yet. The content must parse as a memory named after its file and hold no secret.
 * Refreshes the index.
 */
export async function writeDocument(
  store: MemoryStore,
  path: string,
  content: string,
  ifVersion: string
): Promise<VersionedWriteResult> {
  assertMemoryPath(path);
  const { name } = parseWrittenMemory(path, content).frontmatter;
  const expected = path.slice(0, -".md".length);
  if (name !== expected) {
    throw new RefusalError(
      `Refused "${path}": its name is "${name}", but a memory's name must equal its file name without .md ("${expected}")`
    );
  }
  assertNoSecrets(path, content);
  await store.create(path, content, ifVersion);
  return {
    ...(await reindexAfterWrite(store, path)),
    version: versionOf(content),
  };
}

/** Refuse deleting the index, before touching the store. */
function assertNotIndexDelete(path: string): void {
  if (isIndexPath(path)) {
    throw new RefusalError(
      `Refused "${path}": that is the index's path (${INDEX_FILE}), and the index is generated from the memories' frontmatter, so it cannot be deleted`
    );
  }
}

/**
 * Delete a memory document under the store's version guard (`ifVersion` as in
 * `writeDocument`) and refresh the index. The index itself cannot be deleted.
 */
export async function deleteDocument(
  store: MemoryStore,
  path: string,
  ifVersion: string
): Promise<WriteResult> {
  assertNotIndexDelete(path);
  if (!path.endsWith(".md") || !store.exists(path)) {
    throw new RefusalError(`No memory document at "${path}"`);
  }
  await store.remove(path, ifVersion);
  return reindexAfterWrite(store, path);
}

/**
 * Save a memory at `<name>.md` through `writeDocument`, which validates it and
 * refreshes the index. Without `force`, an existing memory is refused with a
 * VersionConflictError. With `force`, it is overwritten under the version read
 * just before, so a change made in between is refused the same way, not lost.
 */
export async function saveMemory(
  store: MemoryStore,
  input: MemoryInput,
  { force = false }: { force?: boolean } = {}
): Promise<WriteResult> {
  const file = memoryFileName(input.name);
  const content = serializeMemory({
    frontmatter: {
      name: input.name,
      description: input.description,
      metadata: { type: input.type },
    },
    body: input.body,
  });
  // Refuse the path before the read, which would regenerate a missing index.
  assertMemoryPath(file);
  const current = force ? await findDocument(store, file) : null;
  return writeDocument(
    store,
    file,
    content,
    current?.version ?? NEW_FILE_VERSION
  );
}

/**
 * Remove a memory by name (a name or `<name>.md`) through `deleteDocument`, under
 * the version read just before, and refresh the index. Returns the removed file
 * name and the write's warnings, or null if no such memory existed.
 */
export async function removeMemory(
  store: MemoryStore,
  name: string
): Promise<WriteResult | null> {
  const file = memoryFileFor(name);
  // Refuse the index before the read, which would regenerate it if missing.
  assertNotIndexDelete(file);
  const current = await findDocument(store, file);
  if (!current) {
    return null;
  }
  return deleteDocument(store, file, current.version);
}
