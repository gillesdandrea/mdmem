import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { INDEX_FILE } from "./check.ts";
import { versionOf } from "./store.ts";
import type { MemoryStore } from "./store.ts";

/**
 * Session state (GLOSSARY.md): what mdmem keeps about one agent session between
 * prompts, outside the store, decided on mdmem-at1.6. One JSON file per session
 * under the sessions directory, `<agent>/<session_id>.json`, or
 * `<agent>/<session_id>/<agent_id>.json` for a child session. It holds the store
 * directory it was taken from, the snapshot of the store's memories, the last
 * injection time and the hits already shown.
 *
 * It is a cache a session can lose (ADR 0002): a file that cannot be read or
 * parsed, has another schema version, or names another store directory than the
 * one resolved now reads as absent. Writes go through a temp file and a rename, so
 * a reader never sees half a file and the last writer wins.
 */

/** The schema version a session file carries; a file with another one reads as absent. */
export const SESSION_STATE_VERSION = 1;

/** Session files older than this, by mtime, are removed when the session-start hook writes a new one. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An id usable as one path component: no separator, never `.` or `..`. */
const SAFE_ID_RE = /^[\w-][\w.-]*$/u;

const snapshotEntrySchema = z.object({
  hash: z.string(),
  size: z.number(),
  mtime: z.number(),
});

const sessionStateSchema = z.object({
  version: z.literal(SESSION_STATE_VERSION),
  agent: z.string(),
  store: z.string(),
  snapshot: z.record(z.string(), snapshotEntrySchema),
  lastInjection: z.string(),
  shown: z.array(z.string()),
});

/** A memory as a snapshot records it: its content hash (versionOf), with size and mtime to skip re-hashing an unchanged file. */
export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

/** What a session last saw of its store (GLOSSARY.md): each memory's file name and what it held then. */
export type Snapshot = Record<string, SnapshotEntry>;

export type SessionState = z.infer<typeof sessionStateSchema>;

/** Whether `error` says a file or directory is not there. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Which session a state file belongs to: the agent, its session id, and the child session's agent id when there is one. */
interface SessionKey {
  agent: string;
  sessionId: string;
  agentId?: string;
}

/** The sessions directory: `$XDG_CACHE_HOME/mdmem/sessions` when that is set to an absolute path, else `~/.cache/mdmem/sessions`. */
export function sessionsDir(
  env: Record<string, string | undefined>,
  home: string
): string {
  const xdg = env.XDG_CACHE_HOME;
  // The XDG spec ignores an empty or relative value.
  const cache =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg)
      ? xdg
      : join(home, ".cache");
  return join(cache, "mdmem", "sessions");
}

/** Why `key` cannot name a session file, or undefined when it can. */
export function unusableKey(key: SessionKey): string | undefined {
  for (const [field, id] of [
    ["session_id", key.sessionId],
    ["agent_id", key.agentId],
  ] as const) {
    if (id !== undefined && !SAFE_ID_RE.test(id)) {
      return `the payload's ${field} ${JSON.stringify(id)} cannot name a session file`;
    }
  }
  return undefined;
}

/** The session file of `key` in the sessions directory `dir`; call unusableKey first. */
export function sessionFile(dir: string, key: SessionKey): string {
  const session = join(dir, key.agent, key.sessionId);
  return key.agentId === undefined
    ? `${session}.json`
    : join(session, `${key.agentId}.json`);
}

/**
 * The store's memories as a snapshot, keyed by file name, the index left out. A
 * memory whose size and mtime match `previous` keeps its hash there unread, and
 * one removed while the snapshot is taken is left out.
 */
export async function snapshotOf(
  store: MemoryStore,
  previous: Snapshot = {}
): Promise<Snapshot> {
  const listed = await store.listFiles();
  const files = listed.filter((file) => file !== INDEX_FILE);
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, SnapshotEntry] | undefined> => {
      try {
        const info = await stat(join(store.root, file));
        const known = previous[file];
        const unchanged =
          known !== undefined &&
          known.size === info.size &&
          known.mtime === info.mtimeMs;
        const hash = unchanged ? known.hash : versionOf(await store.view(file));
        return [file, { hash, size: info.size, mtime: info.mtimeMs }];
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

/** The session state in `file` taken from the store directory `storeDir`, or undefined when it is missing, unreadable, unparseable or another store's. */
export async function readSessionState(
  file: string,
  storeDir: string
): Promise<SessionState | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
  const result = sessionStateSchema.safeParse(parsed);
  return result.success && result.data.store === storeDir
    ? result.data
    : undefined;
}

/** Write `text` to `file` atomically: a temp file beside it, then a rename. */
async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf-8");
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Write `state` to `file` atomically: a temp file beside it, then a rename. A
 * child session's directory that another hook's pruning removed between the
 * mkdir and the write is made again, once.
 */
export async function writeSessionState(
  file: string,
  state: SessionState
): Promise<void> {
  const text = `${JSON.stringify(state, undefined, 2)}\n`;
  try {
    await writeAtomically(file, text);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await writeAtomically(file, text);
  }
}

/** Remove what is older than SESSION_MAX_AGE_MS below `dir`, and the directories that leaves empty; true when `dir` is left empty. */
async function pruneDir(dir: string, before: number): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const kept = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          if (await pruneDir(path, before)) {
            await rmdir(path);
            return false;
          }
          return true;
        }
        const info = await stat(path);
        if (info.mtimeMs < before) {
          await rm(path, { force: true });
          return false;
        }
      } catch {
        // Another hook pruning at the same time, or a file it cannot remove: leave it.
      }
      return true;
    })
  );
  return kept.every((stays) => !stays);
}

/**
 * Remove the session files in the sessions directory `dir` older than
 * SESSION_MAX_AGE_MS by mtime at `now`, and the session directories that leaves
 * empty. It never throws: what it cannot remove stays.
 */
export async function pruneSessions(dir: string, now: number): Promise<void> {
  const before = now - SESSION_MAX_AGE_MS;
  let agents;
  try {
    agents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // The agents' directories stay; below them, the old files and the session directories they leave empty go.
  await Promise.all(
    agents
      .filter((entry) => entry.isDirectory())
      .map((entry) => pruneDir(join(dir, entry.name), before))
  );
}
