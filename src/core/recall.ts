import {
  currentIndex,
  INDEX_FILE,
  loadMemories,
  memoryPointer,
  POINTER_MAX_CHARS,
  pointerTarget,
} from "./check.ts";
import { rankDocuments } from "./search.ts";
import { snapshotOf } from "./session.ts";
import type { Snapshot } from "./session.ts";
import type { MemoryStore } from "./store.ts";
import { LINE_BREAK_RE, oneLine } from "./text.ts";

/**
 * Recall at each prompt (mdmem-02l.49, decided on mdmem-at1.5): the block the
 * per-prompt hook injects, pointers only, never a memory's body. Its delta lists
 * the memories added, updated or deleted since the session's snapshot; its hits,
 * the memories the prompt's text finds (./search.ts) above the relevance floor and
 * 60% of the top hit's score, not shown as a hit before in the session and not in
 * the delta, at most 5. Each pointer is the index's own line, so the agent sees
 * what it saw at session start. No cache and no persisted index: reading the
 * store and ranking it costs about 0.1 s at 200 memories (mdmem-at1.9).
 */

/** The block stays under this many characters, inside every agent's cap, so Codex needs no additionalContextLimit. */
export const PROMPT_CONTEXT_MAX_CHARS = 4000;
/** The delta lists at most this many memories, then a line counting the rest. */
const DELTA_MAX_LINES = 20;
/** The hits list at most this many memories. */
const HITS_MAX = 5;
/** A hit under this share of the top hit's score is left out. */
const TOP_SHARE = 0.6;

export const DELTA_HEADER = "Memory changes since your last prompt:";
export const HITS_HEADER =
  "Memories that may bear on this prompt, open with memory_read:";

/** What a session last saw, as recall reads it from its session state. */
export interface SeenStore {
  snapshot: Snapshot;
  /** The memories already shown as a hit in the session. */
  shown: readonly string[];
}

/** What recall found for one prompt. */
export interface Recall {
  /** The store's snapshot now, which the session state keeps for the next prompt. */
  snapshot: Snapshot;
  /** The block to inject; empty when there is nothing to say. */
  block: string;
  /** The memories the block shows as hits, which the session state adds to its shown-set. */
  hits: string[];
  /** Why the block is empty, one sentence; undefined when it is not. */
  silence?: string;
}

/** The memories added, updated and deleted between two snapshots, each in file-name order. */
interface Delta {
  added: string[];
  updated: string[];
  deleted: string[];
}

/** A text's length in code points. */
function charCount(text: string): number {
  return [...text].length;
}

/** File-name order by code unit, the same on every machine. */
function byFile(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** A snapshot's memories in file-name order. */
function filesOf(snapshot: Snapshot): string[] {
  return Object.keys(snapshot).toSorted(byFile);
}

function deltaOf(previous: Snapshot, current: Snapshot): Delta {
  return {
    added: filesOf(current).filter((file) => previous[file] === undefined),
    updated: filesOf(current).filter((file) => {
      const before = previous[file];
      return before !== undefined && before.hash !== current[file]?.hash;
    }),
    deleted: filesOf(previous).filter((file) => current[file] === undefined),
  };
}

/** `line` cut to POINTER_MAX_CHARS, so no pointer crowds the others out of the block. */
function clipped(line: string): string {
  const chars = [...line];
  return chars.length <= POINTER_MAX_CHARS
    ? line
    : `${chars.slice(0, POINTER_MAX_CHARS - 1).join("")}…`;
}

/** Each memory's pointer as the index spells it, the first line pointing at it. */
function indexPointers(index: string): Map<string, string> {
  const pointers = new Map<string, string>();
  for (const line of index.split(LINE_BREAK_RE)) {
    const target = pointerTarget(line);
    if (target !== undefined && !pointers.has(target)) {
      pointers.set(target, line.trim());
    }
  }
  return pointers;
}

function overflowLine(count: number): string {
  return `${count} more ${count === 1 ? "memory" : "memories"} changed; memory_read ${INDEX_FILE} for the current index.`;
}

/**
 * The block: the delta's lines, then the hits'. The hits come first in the budget,
 * since nothing else points at them; delta lines past DELTA_MAX_LINES or the
 * budget are counted in one line saying to read the index.
 */
function blockOf(
  deltaLines: readonly string[],
  hitLines: readonly string[]
): string {
  const hits = hitLines.length === 0 ? [] : [HITS_HEADER, ...hitLines];
  if (deltaLines.length === 0) {
    return hits.join("\n");
  }
  const total = deltaLines.length;
  const withKept = (kept: number): string => {
    const rest = total - kept;
    return [
      DELTA_HEADER,
      ...deltaLines.slice(0, kept),
      ...(rest > 0 ? [overflowLine(rest)] : []),
      ...hits,
    ].join("\n");
  };
  for (let kept = Math.min(total, DELTA_MAX_LINES); kept > 0; kept -= 1) {
    const block = withKept(kept);
    if (charCount(block) < PROMPT_CONTEXT_MAX_CHARS) {
      return block;
    }
  }
  return withKept(0);
}

/** Why a prompt's block is empty. */
function silenceOf(
  previous: SeenStore | undefined,
  ranked: number,
  query: string
): string {
  const delta =
    previous === undefined
      ? "the session had no state yet, so mdmem took the store's snapshot for its next prompt"
      : "no memory changed since the session's last prompt";
  let hits = "the prompt holds no word to search for";
  if (ranked > 0) {
    hits =
      "the memories that bear on the prompt were already shown this session";
  } else if (query.trim() !== "") {
    hits = "no memory bears on the prompt";
  }
  return `${delta}, and ${hits}.`;
}

/**
 * The block for one prompt of a session that last saw `previous` (undefined at its
 * first prompt, which gets hits only), with `query`, the prompt's whole text.
 */
export async function recall(
  store: MemoryStore,
  previous: SeenStore | undefined,
  query: string
): Promise<Recall> {
  const snapshot = await snapshotOf(store, previous?.snapshot);
  const delta =
    previous === undefined
      ? { added: [], updated: [], deleted: [] }
      : deltaOf(previous.snapshot, snapshot);
  const { memories } = await loadMemories(store);
  const pointers = indexPointers(await currentIndex(store));
  const parsed = new Map(memories.map((loaded) => [loaded.file, loaded]));
  // The index's line, else the pointer mdmem would write, else, for a memory that does not parse, its file name.
  const pointerOf = (file: string): string => {
    const loaded = parsed.get(file);
    const line =
      pointers.get(file) ??
      (loaded === undefined ? `- ${oneLine(file)}` : memoryPointer(loaded));
    return clipped(line);
  };

  const ranked = rankDocuments(memories, query, {
    stopWords: true,
    floor: true,
  });
  const top = ranked[0]?.score ?? 0;
  const inDelta = new Set([...delta.added, ...delta.updated, ...delta.deleted]);
  const shown = new Set(previous?.shown);
  const hits = ranked
    .filter(({ score }) => score >= TOP_SHARE * top)
    .map(({ document }) => document.file)
    .filter((file) => !(shown.has(file) || inDelta.has(file)))
    .slice(0, HITS_MAX);

  const deltaLines = [
    ...delta.added.map((file) => `${pointerOf(file)} (new)`),
    ...delta.updated.map((file) => `${pointerOf(file)} (updated)`),
    ...delta.deleted.map(
      (file) => `${clipped(`- ${oneLine(file)}`)} (deleted)`
    ),
  ];
  const block = blockOf(deltaLines, hits.map(pointerOf));
  return block === ""
    ? {
        snapshot,
        block,
        hits,
        silence: silenceOf(previous, ranked.length, query),
      }
    : { snapshot, block, hits };
}
