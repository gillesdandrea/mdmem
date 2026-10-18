import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Adapter, AdapterContext } from "./adapter.ts";
import { bobAdapter } from "./bob.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";

/** The supported agents: only those with session-start hooks (ADR 0003). */
const REGISTRY: readonly Adapter[] = [
  claudeCodeAdapter,
  bobAdapter,
  codexAdapter,
];

export function listAdapters(): readonly Adapter[] {
  return REGISTRY;
}

export function getAdapter(id: string): Adapter | undefined {
  return REGISTRY.find((a) => a.id === id);
}

export function adapterIds(): string[] {
  return REGISTRY.map((a) => a.id);
}

/** An agent is found on this machine when its command is on PATH or its config directory exists under the home directory. */
function isFound(
  adapter: Adapter,
  { env, home }: Pick<AdapterContext, "env" | "home">
): boolean {
  return (
    Bun.which(adapter.command, { PATH: env.PATH ?? "" }) !== null ||
    existsSync(join(home, adapter.configDir))
  );
}

/** The supported agents split into those found on this machine and the rest, each in registry order: what `--all` wires. */
export function findAdapters(ctx: Pick<AdapterContext, "env" | "home">): {
  found: Adapter[];
  notFound: Adapter[];
} {
  const found: Adapter[] = [];
  const notFound: Adapter[] = [];
  for (const adapter of REGISTRY) {
    if (isFound(adapter, ctx)) {
      found.push(adapter);
    } else {
      notFound.push(adapter);
    }
  }
  return { found, notFound };
}

export type {
  Adapter,
  AdapterContext,
  AgentStatus,
  DisableOptions,
  EnableOptions,
  WiringEntry,
  WiringResult,
} from "./adapter.ts";
