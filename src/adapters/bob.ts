import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMemoryProtocol } from "../core/protocol.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  LinkResult,
} from "./adapter.ts";

const ID = "bob";
const TITLE = "IBM Bob";
// IBM Bob loads always-on rules from .bob/rules/*.md. This dedicated file carries
// the same memory protocol the AGENTS.md adapter installs — we own the whole file,
// so it is written and removed wholesale (no marker block needed).
const RULE_REL = ".bob/rules/memory.md";

export const bobAdapter: Adapter = {
  id: ID,
  title: TITLE,

  async link(ctx: AdapterContext): Promise<LinkResult> {
    const path = join(ctx.projectRoot, RULE_REL);
    const existed = existsSync(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, getMemoryProtocol(), "utf-8");
    return {
      agent: ID,
      title: TITLE,
      actions: [`${existed ? "updated" : "wrote"} ${RULE_REL}`],
    };
  },

  async unlink(ctx: AdapterContext): Promise<LinkResult> {
    const path = join(ctx.projectRoot, RULE_REL);
    if (!existsSync(path)) {
      return { agent: ID, title: TITLE, actions: ["nothing to remove"] };
    }
    await rm(path);
    return { agent: ID, title: TITLE, actions: [`removed ${RULE_REL}`] };
  },

  status(ctx: AdapterContext): Promise<AgentStatus> {
    const linked = existsSync(join(ctx.projectRoot, RULE_REL));
    return Promise.resolve({
      agent: ID,
      title: TITLE,
      linked,
      details: [linked ? `protocol present (${RULE_REL})` : "not installed"],
    });
  },
};
