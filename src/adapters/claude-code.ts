import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  LinkResult,
} from "./adapter.ts";

const ID = "claude-code";
const TITLE = "Claude Code";
// Claude Code's native auto-memory can be relocated with this setting. Pointing it
// at the shared store makes Claude read AND write there natively — no rule or hook
// needed. The value must be an absolute path, so it belongs in the personal,
// auto-gitignored settings file rather than the committed one.
const SETTINGS_REL = ".claude/settings.local.json";
const DIR_KEY = "autoMemoryDirectory";

interface Settings {
  autoMemoryDirectory?: string;
  [key: string]: unknown;
}

async function readSettings(path: string): Promise<Settings> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = await readFile(path, "utf-8");
  if (raw.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  return (parsed ?? {}) as Settings;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export const claudeCodeAdapter: Adapter = {
  id: ID,
  title: TITLE,

  async link(ctx: AdapterContext): Promise<LinkResult> {
    const settingsPath = join(ctx.projectRoot, SETTINGS_REL);
    const settings = await readSettings(settingsPath);
    settings[DIR_KEY] = ctx.storeDir; // Claude requires an absolute path
    await writeJson(settingsPath, settings);
    return {
      agent: ID,
      title: TITLE,
      actions: [
        `set ${DIR_KEY} → ${ctx.storeDir} in ${SETTINGS_REL}`,
        "note: auto-memory is on by default; if disabled, re-enable it via /memory",
      ],
    };
  },

  async unlink(ctx: AdapterContext): Promise<LinkResult> {
    const settingsPath = join(ctx.projectRoot, SETTINGS_REL);
    const settings = await readSettings(settingsPath);
    if (settings[DIR_KEY] === undefined) {
      return { agent: ID, title: TITLE, actions: ["nothing to remove"] };
    }
    delete settings.autoMemoryDirectory;
    await writeJson(settingsPath, settings);
    return {
      agent: ID,
      title: TITLE,
      actions: [`removed ${DIR_KEY} from ${SETTINGS_REL}`],
    };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const settingsPath = join(ctx.projectRoot, SETTINGS_REL);
    const settings = await readSettings(settingsPath);
    const current = settings[DIR_KEY];
    const linked = current === ctx.storeDir;
    let detail: string;
    if (linked) {
      detail = `${DIR_KEY} points at the store`;
    } else if (current === undefined) {
      detail = `${DIR_KEY} not set`;
    } else {
      detail = `${DIR_KEY} set elsewhere (${current})`;
    }
    return { agent: ID, title: TITLE, linked, details: [detail] };
  },
};
