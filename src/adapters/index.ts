import type { Adapter } from "./adapter.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexCliAdapter } from "./codex-cli.ts";

const REGISTRY: readonly Adapter[] = [claudeCodeAdapter, codexCliAdapter];

export function listAdapters(): readonly Adapter[] {
  return REGISTRY;
}

export function getAdapter(id: string): Adapter | undefined {
  return REGISTRY.find((a) => a.id === id);
}

export function adapterIds(): string[] {
  return REGISTRY.map((a) => a.id);
}

export type {
  Adapter,
  AdapterContext,
  AgentStatus,
  LinkResult,
} from "./adapter.ts";
