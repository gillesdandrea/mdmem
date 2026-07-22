import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MEMORY_PROTOCOL } from "../core/protocol.ts";
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

const ID = "codex-cli";
const TITLE = "Codex CLI";
// Codex merges AGENTS.md from repo root down to the cwd; the repo-root file is
// loaded for every session, so the protocol lives there.
const AGENTS_REL = "AGENTS.md";

export const codexCliAdapter: Adapter = {
  id: ID,
  title: TITLE,

  async link(ctx: AdapterContext): Promise<LinkResult> {
    const path = join(ctx.projectRoot, AGENTS_REL);
    const current = existsSync(path) ? await readFile(path, "utf-8") : "";
    await writeFile(path, upsertMarkedBlock(current, MEMORY_PROTOCOL), "utf-8");
    const verb = hasMarkedBlock(current) ? "updated" : "installed";
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
      details: [
        linked
          ? `memory protocol present in ${AGENTS_REL}`
          : "memory protocol not installed",
      ],
    };
  },
};
