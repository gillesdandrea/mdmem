import { readFileSync } from "node:fs";

import { INDEX_MAX_CHARS, POINTER_MAX_CHARS } from "./check.ts";

/**
 * The text mdmem hands to agents lives as editable Markdown under `templates/`, so it
 * can be tuned without touching code:
 *
 * - `memory-protocol.md`, the memory protocol: `mdmem hook <agent> protocol` injects
 *   it at session start, and the AGENTS.md, Bob and Cursor adapters install it (re-run
 *   `mdmem enable` after editing it for those).
 * - `consolidate.md`, the consolidation prompt served by `mdmem consolidate` and the
 *   MCP prompt `consolidate`.
 *
 * Both hold `{{placeholder}}`s, filled in when they are rendered, so the index limits
 * they state follow the constants in `check.ts`.
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

/** The consolidation prompt for the memory store at `storeDir`. */
export function getConsolidatePrompt(storeDir: string): string {
  return renderTemplate("consolidate", { store: storeDir, ...indexLimits() });
}
