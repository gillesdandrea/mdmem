import { readFileSync } from "node:fs";

import { INDEX_MAX_CHARS, POINTER_MAX_CHARS } from "./check.ts";

/**
 * The text mdmem hands to agents lives as editable Markdown under `templates/`, so it
 * can be tuned without touching code:
 *
 * - `memory-protocol.md`, the memory protocol: `mdmem hook <agent> protocol` injects
 *   it at session start, naming the project's store.
 * - `consolidate.md`, the consolidation prompt served by `mdmem consolidate` and the
 *   MCP prompt `consolidate`.
 *
 * Both hold `{{placeholder}}`s, filled in when they are rendered, so the index limits
 * they state follow the constants in `check.ts`, and the consolidation prompt's
 * past-sessions source names the agent's session history when its adapter reports one.
 */
type TemplateName = "memory-protocol" | "consolidate";

/**
 * The rendered memory protocol's size cap, in code points: about three times Claude
 * Code's own memory block (2,102 characters in its system prompt on 2026-10-21). Every
 * wired agent reads the protocol at every session start, clear and compaction, so it
 * stays near Claude's block plus what mdmem adds: the index rule, the MCP save loop
 * and the no-tools fallback.
 */
export const PROTOCOL_MAX_CHARS = 6000;

const PLACEHOLDER_RE = /\{\{(?<key>[^{}]*)\}\}/gu;

const cache = new Map<TemplateName, string>();

function loadTemplate(name: TemplateName): string {
  let template = cache.get(name);
  if (template === undefined) {
    template = readFileSync(
      new URL(`../../templates/${name}.md`, import.meta.url),
      "utf-8"
    );
    cache.set(name, template);
  }
  return template;
}

/** The template with every placeholder filled in; a placeholder with no value throws. */
function renderTemplate(
  name: TemplateName,
  values: Readonly<Record<string, string>> = {}
): string {
  return loadTemplate(name).replaceAll(PLACEHOLDER_RE, (placeholder, key) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) {
      throw new Error(`templates/${name}.md: no value for ${placeholder}`);
    }
    return value;
  });
}

/** The index limits both templates state. */
function indexLimits(): Record<string, string> {
  return {
    pointer_max_chars: String(POINTER_MAX_CHARS),
    index_max_chars: INDEX_MAX_CHARS.toLocaleString("en-US"),
  };
}

/** The memory protocol for the project whose store is (or will be) at `storeDir`. */
export function getMemoryProtocol(storeDir: string): string {
  return renderTemplate("memory-protocol", {
    store: storeDir,
    ...indexLimits(),
  });
}

/** Where an agent keeps its past sessions of a project, as its adapter reports it to the consolidation prompt. */
export interface SessionHistory {
  /** The directory holding the session files, absolute. */
  dir: string;
  /** How to search it, as one clause after the directory: which files, and how to keep only the project's. */
  search: string;
}

/** The opening of the past-sessions source when the agent's session history is unknown. */
const UNKNOWN_HISTORY = "if you can search your own past sessions and";

/** The opening of the past-sessions source: the template goes on with "need specific context (…)". */
function pastSessions(history: SessionHistory | undefined): string {
  return history === undefined
    ? UNKNOWN_HISTORY
    : `your past sessions are in \`${history.dir}/\`: ${history.search}; when you`;
}

/** The paragraph naming a second store to fold in, after the store's line; empty without one. */
function secondStore(fromDir: string | undefined): string {
  return fromDir === undefined
    ? ""
    : `\n\nA second store to fold in: \`${fromDir}\`. Read each of its memories and merge it into the memory store above, as Phase 3 merges new signal; once every one is merged, delete that store's directory, or ask the user to.`;
}

/**
 * The consolidation prompt for the memory store at `storeDir`, pointing at the
 * agent's session `history` when it is known, and at a second store `fromDir` to
 * fold in when one is given.
 */
export function getConsolidatePrompt(
  storeDir: string,
  history?: SessionHistory,
  fromDir?: string
): string {
  return renderTemplate("consolidate", {
    store: storeDir,
    second_store: secondStore(fromDir),
    past_sessions: pastSessions(history),
    ...indexLimits(),
  });
}
