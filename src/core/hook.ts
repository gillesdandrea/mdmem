import { resolve } from "node:path";

import { INDEX_FILE, INDEX_MAX_CHARS, sessionIndex } from "./check.ts";
import { workTreeRoot } from "./git.ts";
import { isObject } from "./object.ts";
import type { PlainObject } from "./object.ts";
import { getMemoryProtocol } from "./protocol.ts";
import { locateStore, placementLine, storeAt } from "./store.ts";
import type { MemoryStore, StoreLocation } from "./store.ts";
import { LINE_BREAK_RE, messageOf, oneLine } from "./text.ts";

/**
 * What `mdmem hook <agent> <part> [--global]` prints. Each wired agent runs two
 * session-start hook entries (ADR 0003): one injects the memory protocol, the other
 * the index with the store's path and the Check's warnings. Claude Code caps one
 * entry's context at about 10,000 characters, so each part stays under that.
 *
 * The hook speaks in every directory, git or not, store or not (ADR 0005); in a
 * project with no store yet, the index part names the home store the first
 * memory_write creates. `--global` marks the entries of the global
 * scope, whose agent decides where they stay silent (where the project's own entries
 * run, say).
 *
 * A hook never fails a session (ADR 0002): where it does not speak (no payload, a
 * resumed or forked session, another event, or a silence its agent decides) it prints
 * nothing and says why on stderr, which never reaches the agent's context; any error
 * becomes a one-line context saying why the memory could not be loaded. A payload
 * that does not parse is reported only where the hook would speak from the process's
 * working directory; elsewhere the hook prints nothing.
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

/** The payload read from stdin, which is not empty. */
function parsePayload(text: string): HookPayload {
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

/** Why `value` is not one of `allowed`, or undefined when it is. */
function unknownName(
  value: string,
  allowed: readonly string[],
  what: string
): string | undefined {
  return allowed.includes(value)
    ? undefined
    : `unknown ${what} "${value}" for mdmem hook (expected ${allowed.join(", ")})`;
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(unknownName(value, allowed, what));
  }
  return found;
}

/**
 * The hook payload on stdin, read with `read`. A terminal holds none, so the hook
 * run by hand does not wait on it and says it was given no payload.
 */
export async function stdinPayload(
  isTTY: boolean | undefined,
  read: () => Promise<string>
): Promise<string> {
  return isTTY === true ? "" : await read();
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
 * The index part: a line naming the store's placement and absolute path, the Check's warnings one
 * line each, then the index, all under HOOK_CONTEXT_MAX_CHARS. The index is cut to
 * its limit; warnings that would push the text over are left out and counted.
 */
async function indexContext(store: MemoryStore): Promise<string> {
  const header = placementLine(store);
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
   * Why the agent's hook stays silent at `site`, one line naming the file that
   * decides it, or undefined where it speaks: a global entry stays silent where the
   * project's own entries run, and Codex's one hook where no config registers the
   * mdmem server.
   */
  silence: (agent: HookAgent, site: HookSite) => Promise<string | undefined>;
}

/** What `mdmem hook` prints: the output for stdout, and why it stayed silent, for stderr. */
export interface HookResult {
  /** The SessionStart output, or an empty string when the hook stays silent. */
  stdout: string;
  /** Why the hook printed nothing, one line; undefined when it spoke. */
  silence?: string;
}

/** The session's store, or why the hook stays silent there. */
type SessionStore = { location: StoreLocation } | { silence: string };

/** Where the store of a session in `cwd` is, or why the hook stays silent there. */
async function sessionStore(
  request: HookRequest,
  cwd: string
): Promise<SessionStore> {
  const location = locateStore(cwd);
  const agent = oneOf(request.agent, HOOK_AGENTS, "agent");
  const part = oneOf(request.part, HOOK_PARTS, "part");
  // The work tree as `mdmem enable --project` wires it: the session's own, else the project's directory.
  const projectRoot = (): string => workTreeRoot(cwd) ?? location.root;
  const silence = await request.silence(agent, {
    cwd,
    projectRoot,
    part,
    global: request.global,
  });
  return silence === undefined ? { location } : { silence };
}

/** The index part in a project with no store yet. */
export function noStoreYetContext(location: StoreLocation): string {
  return `Store: none yet; the first memory_write creates the home store ${location.home}/ with ${INDEX_FILE}.`;
}

/** `text` quoted for a POSIX shell. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Why a hook given no payload printed nothing, with the command that shows what it would inject in `request.cwd`, or the unknown agent or part it names. */
function noPayloadSilence(request: HookRequest): string {
  // A command with an unknown agent or part would fail once piped, so the hint names the mistake instead.
  const unknown =
    unknownName(request.agent, HOOK_AGENTS, "agent") ??
    unknownName(request.part, HOOK_PARTS, "part");
  if (unknown !== undefined) {
    return `no hook payload on stdin, and ${unknown}.`;
  }
  const payload = JSON.stringify({
    cwd: request.cwd,
    hook_event_name: SESSION_START,
    source: "startup",
  });
  const command = [
    "mdmem hook",
    request.agent,
    request.part,
    ...(request.global ? ["--global"] : []),
  ].join(" ");
  return `no hook payload on stdin. An agent's session-start hook runs this command with a JSON payload; to see what it would inject here, run: echo ${shellQuote(payload)} | ${command}`;
}

/** Why a hook printed nothing for `payload`'s event or source, or undefined when the hook may speak. */
function eventSilence(payload: HookPayload): string | undefined {
  if (payload.hookEventName === undefined) {
    return `the payload names no hook_event_name; mdmem injects only on ${SESSION_START}.`;
  }
  if (payload.hookEventName !== SESSION_START) {
    return `the event is ${payload.hookEventName}; mdmem injects only on ${SESSION_START}.`;
  }
  if (SKIPPED_SOURCES.has(payload.source)) {
    const how = payload.source === "fork" ? "forked" : "resumed";
    return `the session is ${how}, and its history already holds what its start injected; start a new session to inject the memory again.`;
  }
  return undefined;
}

/** The context to inject, or why the hook stays silent. */
async function hookContext(
  request: HookRequest
): Promise<{ context: string } | { silence: string }> {
  const text = await request.readPayload();
  if (text.trim() === "") {
    return { silence: noPayloadSilence(request) };
  }
  let payload: HookPayload;
  try {
    payload = parsePayload(text);
  } catch (error) {
    // With no payload to name the session's directory, the process's stands in: the error is reported only where the hook would have spoken.
    const site = await sessionStore(request, request.cwd);
    if ("silence" in site) {
      return site;
    }
    throw error;
  }
  const skipped = eventSilence(payload);
  if (skipped !== undefined) {
    return { silence: skipped };
  }
  const site = await sessionStore(
    request,
    resolve(request.cwd, payload.cwd ?? ".")
  );
  if ("silence" in site) {
    return site;
  }
  const { location } = site;
  if (request.part === "protocol") {
    return { context: getMemoryProtocol(location.dir) };
  }
  return {
    context: location.exists
      ? await indexContext(storeAt(location))
      : noStoreYetContext(location),
  };
}

/**
 * What `mdmem hook` prints: on stdout, the agent's SessionStart output carrying the
 * part's context, or an empty string when the hook stays silent, with the reason
 * for stderr. It never throws: an error becomes a one-line context saying the
 * memory could not be loaded, and why.
 */
export async function runHook(request: HookRequest): Promise<HookResult> {
  try {
    const result = await hookContext(request);
    return "silence" in result
      ? { stdout: "", silence: result.silence }
      : { stdout: sessionStartOutput(result.context) };
  } catch (error) {
    return {
      stdout: sessionStartOutput(
        `mdmem could not load the memory: ${oneLine(messageOf(error))}`
      ),
    };
  }
}
