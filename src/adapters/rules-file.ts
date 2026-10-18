import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMemoryProtocol } from "../core/protocol.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  WiringResult,
} from "./adapter.ts";

interface RulesFileConfig {
  id: string;
  title: string;
  /** Repo-relative path of the dedicated rule file, e.g. ".cursor/rules/memory.mdc". */
  rulePath: string;
  /** Text prepended before the protocol, e.g. Cursor's `.mdc` frontmatter. */
  frontmatter?: string;
}

/**
 * Adapter for an agent that loads always-on rules from a dedicated file it owns
 * entirely (Cursor). The file holds the raw protocol — optionally
 * behind a frontmatter preamble — written and removed wholesale, with no marker
 * block (unlike the shared AGENTS.md).
 */
export function rulesFileAdapter(config: RulesFileConfig): Adapter {
  const { id, title, rulePath, frontmatter } = config;
  const contents = (): string => `${frontmatter ?? ""}${getMemoryProtocol()}`;

  return {
    id,
    title,

    async enable(ctx: AdapterContext): Promise<WiringResult> {
      const path = join(ctx.projectRoot, rulePath);
      const existed = existsSync(path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents(), "utf-8");
      return {
        title,
        actions: [`${existed ? "updated" : "wrote"} ${rulePath}`],
        warnings: [],
      };
    },

    async disable(ctx: AdapterContext): Promise<WiringResult> {
      const path = join(ctx.projectRoot, rulePath);
      if (!existsSync(path)) {
        return { title, actions: ["nothing to remove"], warnings: [] };
      }
      await rm(path);
      return { title, actions: [`removed ${rulePath}`], warnings: [] };
    },

    status(ctx: AdapterContext): Promise<AgentStatus> {
      const present = existsSync(join(ctx.projectRoot, rulePath));
      return Promise.resolve({
        title,
        wired: present,
        entries: [{ label: "memory protocol", file: rulePath, present }],
        warnings: [],
      });
    },
  };
}
