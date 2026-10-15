import type { MemoryType } from "./fact.ts";
import { factFileFor, factFileName, parseFact, serializeFact } from "./fact.ts";
import { reindex } from "./index.ts";
import { INDEX_FILE } from "./store.ts";
import type { MemoryStore } from "./store.ts";

/**
 * Fact-level operations shared by both surfaces (CLI and MCP). They compose the
 * store's file ops with fact (de)serialization and reindexing so the two surfaces
 * can't drift — the CLI and MCP keep only their own argument parsing and output.
 */

export interface FactInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * Serialize + validate a fact, write it, and refresh the index. Returns the file
 * name. `ifVersion` opts into the store's lost-update guard for read-modify-write.
 */
export async function saveFact(
  store: MemoryStore,
  input: FactInput,
  opts?: { ifVersion?: string }
): Promise<string> {
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
  await reindex(store);
  return file;
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
      hits.push({ file, description: parseFact(raw).frontmatter.description });
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
 * removed file name, or null if no such fact existed.
 */
export async function removeFact(
  store: MemoryStore,
  id: string
): Promise<string | null> {
  const file = factFileFor(id);
  if (!store.exists(file)) {
    return null;
  }
  await store.remove(file);
  await reindex(store);
  return file;
}
