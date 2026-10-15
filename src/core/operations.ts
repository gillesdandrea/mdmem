import { basename, dirname } from "node:path";

import { reindex } from "./index.ts";
import type { MemoryType } from "./memory.ts";
import {
  memoryFileFor,
  memoryFileName,
  parseMemory,
  parseMemoryFile,
  serializeMemory,
} from "./memory.ts";
import { INDEX_FILE, versionOf } from "./store.ts";
import type { DocumentInfo, MemoryStore } from "./store.ts";

/**
 * Memory-level operations shared by both surfaces (CLI and MCP). They compose the
 * store's file ops with memory (de)serialization and reindexing so the two surfaces
 * can't drift — the CLI and MCP keep only their own argument parsing and output.
 */

/**
 * The memory file a write touched. `indexError` is set when the write landed but
 * MEMORY.md could not be rebuilt (e.g. another memory is unparseable): the write
 * still succeeded, so callers report it, then warn that the index is stale.
 */
export interface WriteResult {
  file: string;
  indexError?: string;
}

/** One line for a stale index, shared so the CLI and MCP say the same thing. */
export function staleIndexWarning(indexError: string): string {
  return `MEMORY.md is stale: ${indexError} (run \`mdmem doctor\`)`;
}

/** Rebuild the index after `file` was written or removed, keeping any failure as a warning. */
export async function reindexAfterWrite(
  store: MemoryStore,
  file: string
): Promise<WriteResult> {
  try {
    await reindex(store);
    return { file };
  } catch (error) {
    return {
      file,
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
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
    throw new Error(`Unknown store "${id}". Valid store ids: ${valid}`);
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
    await reindexAfterWrite(store, INDEX_FILE);
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

/**
 * Serialize + validate a memory, write it, and refresh the index. Returns the file
 * name and any index error. `ifVersion` opts into the store's lost-update guard
 * for read-modify-write.
 */
export async function saveMemory(
  store: MemoryStore,
  input: MemoryInput,
  opts?: { ifVersion?: string }
): Promise<WriteResult> {
  const content = serializeMemory({
    frontmatter: {
      name: input.name,
      description: input.description,
      metadata: { type: input.type },
    },
    body: input.body,
  });
  // Parse-validate before writing so a malformed memory never lands in the store.
  parseMemory(content);
  const file = memoryFileName(input.name);
  await store.create(file, content, opts?.ifVersion);
  return reindexAfterWrite(store, file);
}

export interface SearchHit {
  file: string;
  description: string;
}

/** Memories whose raw text contains `query` (case-insensitive), with their descriptions. */
export async function searchMemories(
  store: MemoryStore,
  query: string
): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const files = await store.listMemoryFiles();
  // Read the memories concurrently, then match them in file order.
  const raws = await Promise.all(
    files.map(async (file) => ({ file, raw: await store.view(file) }))
  );
  const hits: SearchHit[] = [];
  for (const { file, raw } of raws) {
    if (raw.toLowerCase().includes(needle)) {
      hits.push({
        file,
        description: parseMemoryFile(file, raw).frontmatter.description,
      });
    }
  }
  return hits;
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

/** A memory document by its path in the store; the index is generated first if it doesn't exist yet. */
export async function readDocument(
  store: MemoryStore,
  path: string
): Promise<VersionedDocument> {
  let content: string;
  if (isIndexPath(path)) {
    content = await readIndex(store);
  } else if (path.endsWith(".md") && store.exists(path)) {
    content = await store.view(path);
  } else {
    throw new Error(`No memory document at "${path}"`);
  }
  return { content, version: versionOf(content) };
}

/** A write that landed, with the version token of the content it wrote. */
export interface VersionedWriteResult extends WriteResult {
  version: string;
}

/** Refuse a memory write whose path can't hold a memory, before touching the store. */
function assertMemoryPath(path: string): void {
  if (path.includes("/") || path.includes("\\")) {
    throw new Error(
      `Refused "${path}": memories live at the top of the store, and nested files are never indexed or searched; use a path with no directory`
    );
  }
  if (isIndexPath(path)) {
    throw new Error(
      `Refused "${path}": that is the index's path (${INDEX_FILE}), and the index is generated from the memories' frontmatter; write a memory instead`
    );
  }
  if (!path.endsWith(".md")) {
    throw new Error(`Refused "${path}": a memory's path is <name>.md`);
  }
}

/**
 * Write a whole memory document under the store's version guard: `ifVersion` is the
 * version last read or written at `path`, or `new` for a file that must not exist
 * yet. The content must parse as a memory named after its file. Refreshes the index.
 */
export async function writeDocument(
  store: MemoryStore,
  path: string,
  content: string,
  ifVersion: string
): Promise<VersionedWriteResult> {
  assertMemoryPath(path);
  const { name } = parseMemoryFile(path, content).frontmatter;
  const expected = path.slice(0, -".md".length);
  if (name !== expected) {
    throw new Error(
      `Refused "${path}": its name is "${name}", but a memory's name must equal its file name without .md ("${expected}")`
    );
  }
  await store.create(path, content, ifVersion);
  return {
    ...(await reindexAfterWrite(store, path)),
    version: versionOf(content),
  };
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
  if (isIndexPath(path)) {
    throw new Error(
      `Refused "${path}": that is the index's path (${INDEX_FILE}), and the index is generated from the memories' frontmatter, so it cannot be deleted`
    );
  }
  if (!path.endsWith(".md") || !store.exists(path)) {
    throw new Error(`No memory document at "${path}"`);
  }
  await store.remove(path, ifVersion);
  return reindexAfterWrite(store, path);
}

/**
 * Remove a memory by name (a name or `<name>.md`) and refresh the index. Returns the
 * removed file name and any index error, or null if no such memory existed.
 */
export async function removeMemory(
  store: MemoryStore,
  name: string
): Promise<WriteResult | null> {
  const file = memoryFileFor(name);
  if (!store.exists(file)) {
    return null;
  }
  await store.remove(file);
  return reindexAfterWrite(store, file);
}
