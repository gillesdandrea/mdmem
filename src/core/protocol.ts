import { readFileSync } from "node:fs";

import {
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  POINTER_MAX_CHARS,
} from "./index.ts";

/**
 * The text mdmem hands to agents lives as editable Markdown under `templates/`, so it
 * can be tuned without touching code:
 *
 * - `memory-protocol.md`, the memory protocol installed into agents that lack native
 *   memory (the AGENTS.md adapter installs it); edit it and re-run `mdmem enable`.
 * - `consolidate.md`, the consolidation prompt served by `mdmem consolidate` and the
 *   MCP prompt `consolidate`.
 *
 * The consolidation prompt holds `{{placeholder}}`s, filled in when it is rendered; the
 * memory protocol is installed as written.
 */
type TemplateName = "memory-protocol" | "consolidate";

const PLACEHOLDER_RE = /\{\{(?<key>[^{}]*)\}\}/gu;

const BYTES_PER_KB = 1000;

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

export function getMemoryProtocol(): string {
  return loadTemplate("memory-protocol");
}

/** The consolidation prompt for the memory store at `storeDir`. */
export function getConsolidatePrompt(storeDir: string): string {
  return renderTemplate("consolidate", {
    store: storeDir,
    pointer_max_chars: String(POINTER_MAX_CHARS),
    index_max_lines: String(INDEX_MAX_LINES),
    index_max_kb: String(INDEX_MAX_BYTES / BYTES_PER_KB),
  });
}
