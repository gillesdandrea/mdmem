import { resolve } from "node:path";

import { INDEX_FILE, INDEX_MAX_CHARS, sessionIndex } from "./check.ts";
import { workTreeRoot } from "./git.ts";
import { isObject } from "./object.ts";
import type { PlainObject } from "./object.ts";
import { getMemoryProtocol } from "./protocol.ts";
import { locateStore, MemoryStore } from "./store.ts";
import type { StoreLocation } from "./store.ts";
import { LINE_BREAK_RE, messageOf, oneLine } from "./text.ts";

/**
 * What `mdmem hook <agent> <part> [--global]` prints. Each wired agent runs two
 * session-start hook entries (ADR 0003): one injects the memory protocol, the other
 * the index with the store's path and the Check's warnings. Claude Code caps one
 * entry's context at about 10,000 characters, so each part stays under that.
 *
 * The hook speaks in every git repository, store or not, and outside git only where
 * a store exists (ADR 0004); in a repository with no store yet, the index part says
 * the first memory_write creates it. `--global` marks the entries of the global
 * scope, whose agent decides where they stay silent (where the project's own entries
 * run, say).
 *
 * A hook never fails a session (ADR 0002): where it does not speak, on a resumed or
 * forked session or another event it prints nothing, and any error becomes a one-line
 * context saying why the memory could not be loaded. A payload that does not parse
 * is reported only where the hook would speak from the process's working directory;
 * elsewhere the hook prints nothing.
 */

/** The supported agents, in the order mdmem lists them: only those with session-start hooks. The adapter registry is built from this list. */
export const HOOK_AGENTS = ["claude-code", "bob", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export const HOOK_PARTS = ["protocol", "index"] as const;
export type HookPart = (typeof HOOK_PARTS)[number];

/** Claude Code replaces a hook entry's context longer than about this with a file path; each part stays under it. */
export const HOOK_CONTEXT_MAX_CHARS = 10_000;

const SESSION_START = "SessionStart";
/** A resumed or forked (Codex) session's history already holds what its start injected. */
const SKIPPED_SOURCES: ReadonlySet<string | undefined> = new Set([
  "resume",
  "fork",
]);

/** The fields of a hook payload mdmem reads; all three agents send them. */
interface HookPayload {
  cwd?: string;
  hookEventName?: string;
  source?: string;
}

/** A text's length in code points, the measure check.ts holds the index limit to. */
function charCount(text: string): number {
  return [...text].length;
}

function stringField(object: PlainObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

/** The payload read from stdin; empty stdin is an empty payload. */
function parsePayload(text: string): HookPayload {
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the hook payload is not JSON (${messageOf(error)})`, {
      cause: error,
    });
  }
  if (!isObject(parsed)) {
    throw new Error("the hook payload is not a JSON object");
  }
  return {
    cwd: stringField(parsed, "cwd"),
    hookEventName: stringField(parsed, "hook_event_name"),
    source: stringField(parsed, "source"),
  };
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(
      `unknown ${what} "${value}" for mdmem hook (expected ${allowed.join(", ")})`
    );
  }
  return found;
}

/** The SessionStart output, in the form every supported agent takes. */
function sessionStartOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: SESSION_START,
      additionalContext: context,
    },
  });
}

function warningLine(warning: string): string {
  return `Warning: ${oneLine(warning)}`;
}

function omittedLine(count: number): string {
  return warningLine(
    `${count} more warning${count === 1 ? "" : "s"} left out; memory_check lists them all.`
  );
}

/**
 * The heading of an index cut short to `kept` of its `total` lines, saying what to do
 * about it: a consolidation only when the index is `overLimit`, since a long store path
 * can leave less room than the limit.
 */
function cutHeading(kept: number, total: number, overLimit: boolean): string {
  const fix = overLimit
    ? `, and run a consolidation to bring it under ${INDEX_MAX_CHARS.toLocaleString("en-US")} characters`
    : "";
  return `${INDEX_FILE}, cut short (${kept} of ${total} lines): memory_read ${INDEX_FILE} for the rest${fix}.`;
}

/**
 * The index under its heading: whole when it fits in `budget` characters, else the
 * lines that fit, under a heading that says it was cut short and what to do.
 */
function indexBlock(index: string, budget: number): string {
  const text = index.trimEnd();
  if (text === "") {
    return `${INDEX_FILE} is empty.`;
  }
  if (charCount(text) <= budget) {
    return `${INDEX_FILE}:\n${text}`;
  }
  const lines = text.split(LINE_BREAK_RE);
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + charCount(line) + (kept.length > 0 ? 1 : 0);
    if (next > budget) {
      break;
    }
    kept.push(line);
    size = next;
  }
  const overLimit = charCount(text) > INDEX_MAX_CHARS;
  return [cutHeading(kept.length, lines.length, overLimit), ...kept].join("\n");
}

function assemble(head: readonly string[], block: string): string {
  return `${head.join("\n")}\n\n${block}`;
}

/**
 * The index part: a line naming the store's absolute path, the Check's warnings one
 * line each, then the index, all under HOOK_CONTEXT_MAX_CHARS. The index is cut to
 * its limit; warnings that would push the text over are left out and counted.
 */
async function indexContext(store: MemoryStore): Promise<string> {
  const header = `Memory store: ${store.root}`;
  const { index, warnings } = await sessionIndex(store);
  const lines = warnings.map(warningLine);
  // The text stays strictly under the cap.
  const max = HOOK_CONTEXT_MAX_CHARS - 1;
  // Leave room for the header, an omitted-warnings line, the separators and the block's heading.
  const indexLines = index.split(LINE_BREAK_RE).length;
  const headroom = charCount(
    assemble(
      [header, omittedLine(lines.length)],
      `${cutHeading(indexLines, indexLines, true)}\n`
    )
  );
  const block = indexBlock(index, Math.min(INDEX_MAX_CHARS, max - headroom));
  for (let kept = lines.length; kept > 0; kept -= 1) {
    const head =
      kept === lines.length
        ? [header, ...lines]
        : [header, ...lines.slice(0, kept), omittedLine(lines.length - kept)];
    const text = assemble(head, block);
    if (charCount(text) <= max) {
      return text;
    }
  }
  const head =
    lines.length === 0 ? [header] : [header, omittedLine(lines.length)];
  return assemble(head, block);
}

/** Where a hook runs, as the agent's adapter weighs whether it speaks there. */
export interface HookSite {
  /** The session's directory, from the payload's cwd. */
  cwd: string;
  /** The session's work tree, else the store's project directory; it runs git, so call it only when needed. */
  projectRoot: () => string;
  part: HookPart;
  /** Whether the hook entry is the global scope's (`--global`). */
  global: boolean;
}

/** What `mdmem hook` is asked to do, and where. */
export interface HookRequest {
  /** The agent whose hook runs; one of HOOK_AGENTS. */
  agent: string;
  /** What to inject; one of HOOK_PARTS. */
  part: string;
  /** Whether the hook entry carries `--global`, the global scope's marker. */
  global: boolean;
  /** Reads the hook payload, the JSON the agent sends on stdin. */
  readPayload: () => Promise<string>;
  /** Where to resolve the store when the payload names no cwd or does not parse. */
  cwd: string;
  /**
   * Whether the agent's hook speaks at `site`, in a project where a hook may speak:
   * a global entry stays silent where the project's own entries run, and Codex's
   * one hook where no config registers the mdmem server.
   */
  speaks: (agent: HookAgent, site: HookSite) => Promise<boolean>;
}

/** Where the store of a session in `cwd` is, or undefined where the hook stays silent. */
async function sessionStore(
  request: HookRequest,
  cwd: string
): Promise<StoreLocation | undefined> {
  const location = locateStore(cwd);
  // Outside git, only an existing store makes a project (ADR 0004).
  if (!(location.exists || location.inRepository)) {
    return undefined;
  }
  const agent = oneOf(request.agent, HOOK_AGENTS, "agent");
  const part = oneOf(request.part, HOOK_PARTS, "part");
  // The work tree as `mdmem enable --project` wires it: the session's own, else the project's directory.
  const projectRoot = (): string => workTreeRoot(cwd) ?? location.root;
  const speaks = await request.speaks(agent, {
    cwd,
    projectRoot,
    part,
    global: request.global,
  });
  return speaks ? location : undefined;
}

/** The index part in a repository with no store yet. */
export function noStoreYetContext(dir: string): string {
  return `Memory store: none yet; the first memory_write creates ${dir}/ with ${INDEX_FILE}.`;
}

/** The context to inject, or undefined when the hook stays silent. */
async function hookContext(request: HookRequest): Promise<string | undefined> {
  const text = await request.readPayload();
  let payload: HookPayload;
  try {
    payload = parsePayload(text);
  } catch (error) {
    // With no payload to name the session's directory, the process's stands in: the error is reported only where the hook would have spoken.
    if ((await sessionStore(request, request.cwd)) === undefined) {
      return undefined;
    }
    throw error;
  }
  if (
    payload.hookEventName !== SESSION_START ||
    SKIPPED_SOURCES.has(payload.source)
  ) {
    return undefined;
  }
  const location = await sessionStore(
    request,
    resolve(request.cwd, payload.cwd ?? ".")
  );
  if (location === undefined) {
    return undefined;
  }
  if (request.part === "protocol") {
    return getMemoryProtocol();
  }
  return location.exists
    ? await indexContext(new MemoryStore(location.dir))
    : noStoreYetContext(location.dir);
}

/**
 * What `mdmem hook` prints on stdout: the agent's SessionStart output carrying the
 * part's context, or an empty string when the hook stays silent. It never throws:
 * an error becomes a one-line context saying the memory could not be loaded, and why.
 */
export async function runHook(request: HookRequest): Promise<string> {
  try {
    const context = await hookContext(request);
    return context === undefined ? "" : sessionStartOutput(context);
  } catch (error) {
    return sessionStartOutput(
      `mdmem could not load the memory: ${oneLine(messageOf(error))}`
    );
  }
}
