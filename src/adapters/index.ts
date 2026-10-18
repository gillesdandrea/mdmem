import type { Adapter } from "./adapter.ts";
import { agentsAdapter } from "./agents.ts";
import { bobAdapter } from "./bob.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { cursorAdapter } from "./cursor.ts";

const REGISTRY: readonly Adapter[] = [
  claudeCodeAdapter,
  agentsAdapter,
  bobAdapter,
  codexAdapter,
  cursorAdapter,
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

export type {
  Adapter,
  AdapterContext,
  AgentStatus,
  DisableOptions,
  EnableOptions,
  WiringEntry,
  WiringResult,
} from "./adapter.ts";
