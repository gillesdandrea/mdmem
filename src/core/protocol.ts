import { readFileSync } from "node:fs";

import { INDEX_MAX_CHARS, POINTER_MAX_CHARS } from "./check.ts";

/**
 * The text mdmem hands to agents lives as editable Markdown under `templates/`, so it
 * can be tuned without touching code:
 *
 * - `memory-protocol.md`, the memory protocol: `mdmem hook <agent> protocol` injects
 *   it at session start.
 * - `consolidate.md`, the consolidation prompt served by `mdmem consolidate` and the
 *   MCP prompt `consolidate`.
 *
 * Both hold `{{placeholder}}`s, filled in when they are rendered, so the index limits
 * they state follow the constants in `check.ts`, and the consolidation prompt's
 * past-sessions source names the agent's session history when its adapter reports one.
 */
type TemplateName = "memory-protocol" | "consolidate";

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

export function getMemoryProtocol(): string {
  return renderTemplate("memory-protocol", indexLimits());
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

/**
 * The consolidation prompt for the memory store at `storeDir`, pointing at the
 * agent's session `history` when it is known.
 */
export function getConsolidatePrompt(
  storeDir: string,
  history?: SessionHistory
): string {
  return renderTemplate("consolidate", {
    store: storeDir,
    past_sessions: pastSessions(history),
    ...indexLimits(),
  });
}
