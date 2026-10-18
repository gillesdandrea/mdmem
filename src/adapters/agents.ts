import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getMemoryProtocol } from "../core/protocol.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  WiringResult,
} from "./adapter.ts";
import {
  hasMarkedBlock,
  removeMarkedBlock,
  upsertMarkedBlock,
} from "./util.ts";

const TITLE = "AGENTS.md";
// AGENTS.md is the cross-agent instruction file read by Codex, Cursor, Gemini CLI,
// Aider, and others — one block here reaches every agent that lacks native memory.
const AGENTS_REL = "AGENTS.md";

export const agentsAdapter: Adapter = {
  id: "agents",
  title: TITLE,

  async enable(ctx: AdapterContext): Promise<WiringResult> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    const current = existsSync(path) ? await readFile(path, "utf-8") : "";
    const verb = hasMarkedBlock(current) ? "updated" : "installed";
    await writeFile(
      path,
      upsertMarkedBlock(current, getMemoryProtocol()),
      "utf-8"
    );
    return {
      title: TITLE,
      actions: [`${verb} memory protocol block in ${AGENTS_REL}`],
      warnings: [],
    };
  },

  async disable(ctx: AdapterContext): Promise<WiringResult> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    if (!existsSync(path)) {
      return { title: TITLE, actions: ["nothing to remove"], warnings: [] };
    }
    const next = removeMarkedBlock(await readFile(path, "utf-8"));
    if (next.trim().length === 0) {
      await rm(path);
      return {
        title: TITLE,
        actions: [`removed ${AGENTS_REL} (was only the memory block)`],
        warnings: [],
      };
    }
    await writeFile(path, next, "utf-8");
    return {
      title: TITLE,
      actions: [`removed memory protocol block from ${AGENTS_REL}`],
      warnings: [],
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    const present =
      existsSync(path) && hasMarkedBlock(await readFile(path, "utf-8"));
    return {
      title: TITLE,
      wired: present,
      entries: [{ label: "memory protocol block", file: AGENTS_REL, present }],
      warnings: [],
    };
  },
};
