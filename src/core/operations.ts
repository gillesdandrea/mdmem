import type { MemoryType } from "./fact.ts";
import {
  factFileFor,
  factFileName,
  parseFact,
  parseFactFile,
  serializeFact,
} from "./fact.ts";
import { reindex } from "./index.ts";
import { INDEX_FILE } from "./store.ts";
import type { MemoryStore } from "./store.ts";

/**
 * Fact-level operations shared by both surfaces (CLI and MCP). They compose the
 * store's file ops with fact (de)serialization and reindexing so the two surfaces
 * can't drift — the CLI and MCP keep only their own argument parsing and output.
 */

/**
 * The fact file a write touched. `indexError` is set when the write landed but
 * MEMORY.md could not be rebuilt (e.g. another fact is unparseable): the write
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

async function reindexAfterWrite(
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

export interface FactInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * Serialize + validate a fact, write it, and refresh the index. Returns the file
 * name and any index error. `ifVersion` opts into the store's lost-update guard
 * for read-modify-write.
 */
export async function saveFact(
  store: MemoryStore,
  input: FactInput,
  opts?: { ifVersion?: string }
): Promise<WriteResult> {
  const content = serializeFact({
    frontmatter: {
      name: input.name,
      description: input.description,
      metadata: { type: input.type },
    },
    body: input.body,
  });
  // Parse-validate before writing so a malformed fact never lands in the store.
  parseFact(content);
  const file = factFileName(input.name);
  await store.create(file, content, opts?.ifVersion);
  return reindexAfterWrite(store, file);
}

export interface SearchHit {
  file: string;
  description: string;
}

/** Facts whose raw text contains `query` (case-insensitive), with their descriptions. */
export async function searchFacts(
  store: MemoryStore,
  query: string
): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const files = await store.listFacts();
  // Read the facts concurrently, then match them in file order.
  const raws = await Promise.all(
    files.map(async (file) => ({ file, raw: await store.view(file) }))
  );
  const hits: SearchHit[] = [];
  for (const { file, raw } of raws) {
    if (raw.toLowerCase().includes(needle)) {
      hits.push({
        file,
        description: parseFactFile(file, raw).frontmatter.description,
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
 * Remove a fact by id (slug or `<slug>.md`) and refresh the index. Returns the
 * removed file name and any index error, or null if no such fact existed.
 */
export async function removeFact(
  store: MemoryStore,
  id: string
): Promise<WriteResult | null> {
  const file = factFileFor(id);
  if (!store.exists(file)) {
    return null;
  }
  await store.remove(file);
  return reindexAfterWrite(store, file);
}
