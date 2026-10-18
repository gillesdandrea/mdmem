import { existsSync } from "node:fs";

import { HOOK_AGENTS } from "../core/hook.ts";
import type { HookAgent } from "../core/hook.ts";
import type { Adapter, AdapterContext, AdapterFor } from "./adapter.ts";
import { bobAdapter } from "./bob.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";

// Keyed by agent, each key checked against its adapter's id.
const ADAPTERS: { readonly [K in HookAgent]: AdapterFor<K> } = {
  "claude-code": claudeCodeAdapter,
  bob: bobAdapter,
  codex: codexAdapter,
};

/** The supported agents, in HOOK_AGENTS' order: only those with session-start hooks (ADR 0003). */
const REGISTRY: readonly Adapter[] = HOOK_AGENTS.map((id) => ADAPTERS[id]);

export function listAdapters(): readonly Adapter[] {
  return REGISTRY;
}

export function getAdapter(id: string): Adapter | undefined {
  const agent = HOOK_AGENTS.find((known) => known === id);
  return agent === undefined ? undefined : ADAPTERS[agent];
}

export function adapterIds(): string[] {
  return REGISTRY.map((a) => a.id);
}

/** An agent is found on this machine when its command is on PATH or its config directory, where the environment puts it, exists. */
function isFound(
  adapter: Adapter,
  ctx: Pick<AdapterContext, "env" | "home">
): boolean {
  return (
    Bun.which(adapter.command, { PATH: ctx.env.PATH ?? "" }) !== null ||
    existsSync(adapter.configDir(ctx))
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
