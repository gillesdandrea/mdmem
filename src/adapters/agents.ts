import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getMemoryProtocol } from "../core/protocol.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  LinkResult,
} from "./adapter.ts";
import {
  hasMarkedBlock,
  removeMarkedBlock,
  upsertMarkedBlock,
} from "./util.ts";

const ID = "agents";
const TITLE = "AGENTS.md";
// AGENTS.md is the cross-agent instruction file read by Codex, Cursor, Gemini CLI,
// Aider, and others — one block here reaches every agent that lacks native memory.
const AGENTS_REL = "AGENTS.md";

export const agentsAdapter: Adapter = {
  id: ID,
  title: TITLE,

  async link(ctx: AdapterContext): Promise<LinkResult> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    const current = existsSync(path) ? await readFile(path, "utf-8") : "";
    const verb = hasMarkedBlock(current) ? "updated" : "installed";
    await writeFile(
      path,
      upsertMarkedBlock(current, getMemoryProtocol()),
      "utf-8"
    );
    return {
      agent: ID,
      title: TITLE,
      actions: [`${verb} memory protocol block in ${AGENTS_REL}`],
    };
  },

  async unlink(ctx: AdapterContext): Promise<LinkResult> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    if (!existsSync(path)) {
      return { agent: ID, title: TITLE, actions: ["nothing to remove"] };
    }
    const next = removeMarkedBlock(await readFile(path, "utf-8"));
    if (next.trim().length === 0) {
      await rm(path);
      return {
        agent: ID,
        title: TITLE,
        actions: [`removed ${AGENTS_REL} (was only the memory block)`],
      };
    }
    await writeFile(path, next, "utf-8");
    return {
      agent: ID,
      title: TITLE,
      actions: [`removed memory protocol block from ${AGENTS_REL}`],
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    const linked =
      existsSync(path) && hasMarkedBlock(await readFile(path, "utf-8"));
    return {
      agent: ID,
      title: TITLE,
      linked,
      details: [linked ? "protocol block present" : "not installed"],
    };
  },
};
