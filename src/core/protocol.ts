import { readFileSync } from "node:fs";

/**
 * The memory protocol — the policy text installed into agents that lack native
 * memory (the AGENTS.md adapter installs it). It lives as an editable Markdown
 * file under `templates/` so it can be tuned without touching code; edit it and
 * re-run `memory enable`.
 */
let cached: string | undefined;

export function getMemoryProtocol(): string {
  cached ??= readFileSync(
    new URL("../../templates/memory-protocol.md", import.meta.url),
    "utf-8"
  );
  return cached;
}
