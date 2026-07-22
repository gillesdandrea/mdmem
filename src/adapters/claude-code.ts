import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MEMORY_PROTOCOL } from "../core/protocol.ts";
import type {
  Adapter,
  AdapterContext,
  AgentStatus,
  LinkResult,
} from "./adapter.ts";

const ID = "claude-code";
const TITLE = "Claude Code";
const RULE_REL = ".claude/rules/memory.md";
// Personal, auto-gitignored settings — the hook assumes the CLI is on PATH, so it
// must not be committed onto teammates who may not have it installed.
const SETTINGS_REL = ".claude/settings.local.json";
const HOOK_COMMAND = "memory session-start";

interface HookLeaf {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookLeaf[];
  type?: string;
  command?: string;
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/** Match our hook whether it is written flat or wrapped in a `hooks` array. */
function entryHasCommand(entry: HookEntry, command: string): boolean {
  if (entry.command?.includes(command)) {
    return true;
  }
  return (entry.hooks ?? []).some((leaf) => leaf.command?.includes(command));
}

function buildEntry(command: string): HookEntry {
  return { hooks: [{ type: "command", command }] };
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

function ruleContent(): string {
  return `${MEMORY_PROTOCOL}`;
}

async function sessionStartInstalled(settingsPath: string): Promise<boolean> {
  if (!existsSync(settingsPath)) {
    return false;
  }
  const settings = await readSettings(settingsPath);
  return (settings.hooks?.SessionStart ?? []).some((e) =>
    entryHasCommand(e, HOOK_COMMAND)
  );
}

export const claudeCodeAdapter: Adapter = {
  id: ID,
  title: TITLE,

  async link(ctx: AdapterContext): Promise<LinkResult> {
    const actions: string[] = [];

    const rulePath = join(ctx.projectRoot, RULE_REL);
    await mkdir(dirname(rulePath), { recursive: true });
    await writeFile(rulePath, ruleContent(), "utf-8");
    actions.push(`wrote ${RULE_REL} (memory protocol)`);

    const settingsPath = join(ctx.projectRoot, SETTINGS_REL);
    const settings = await readSettings(settingsPath);
    settings.hooks ??= {};
    const list = (settings.hooks.SessionStart ??= []);
    if (list.some((e) => entryHasCommand(e, HOOK_COMMAND))) {
      actions.push(`SessionStart hook already present in ${SETTINGS_REL}`);
    } else {
      list.push(buildEntry(HOOK_COMMAND));
      actions.push(
        `added SessionStart hook to ${SETTINGS_REL} (loads MEMORY.md each session)`
      );
    }
    await writeJson(settingsPath, settings);
    actions.push(
      "note: the hook runs `memory session-start`, so the CLI must be on PATH"
    );

    return { agent: ID, title: TITLE, actions };
  },

  async unlink(ctx: AdapterContext): Promise<LinkResult> {
    const actions: string[] = [];

    const rulePath = join(ctx.projectRoot, RULE_REL);
    if (existsSync(rulePath)) {
      await rm(rulePath);
      actions.push(`removed ${RULE_REL}`);
    }

    const settingsPath = join(ctx.projectRoot, SETTINGS_REL);
    if (existsSync(settingsPath)) {
      const settings = await readSettings(settingsPath);
      const list = settings.hooks?.SessionStart;
      if (list) {
        const kept = list.filter((e) => !entryHasCommand(e, HOOK_COMMAND));
        if (kept.length !== list.length && settings.hooks) {
          if (kept.length > 0) {
            settings.hooks.SessionStart = kept;
          } else {
            delete settings.hooks.SessionStart;
          }
          await writeJson(settingsPath, settings);
          actions.push(`removed SessionStart hook from ${SETTINGS_REL}`);
        }
      }
    }

    if (actions.length === 0) {
      actions.push("nothing to remove");
    }
    return { agent: ID, title: TITLE, actions };
  },

  async status(ctx: AdapterContext): Promise<AgentStatus> {
    const rulePresent = existsSync(join(ctx.projectRoot, RULE_REL));
    const hookPresent = await sessionStartInstalled(
      join(ctx.projectRoot, SETTINGS_REL)
    );
    return {
      agent: ID,
      title: TITLE,
      linked: rulePresent && hookPresent,
      details: [
        rulePresent
          ? `protocol rule present (${RULE_REL})`
          : "protocol rule missing",
        hookPresent
          ? "SessionStart hook installed"
          : "SessionStart hook missing",
      ],
    };
  },
};
