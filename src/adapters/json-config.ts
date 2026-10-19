import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { isObject, valueAt } from "../core/object.ts";
import type { PlainObject } from "../core/object.ts";
import { heldKeyRefusal, RefusalError } from "../core/refusal.ts";
import { lineEndingOf, messageOf } from "../core/text.ts";
import type { KeyIdentity, WiringEntry, WiringMode } from "./adapter.ts";

/**
 * mdmem's entries in an agent's JSON config files, merged in and taken out without
 * touching the rest. A file is parsed, changed and written back with the indent
 * it had (two spaces for a new file), its key order, its line ending (LF, or CRLF
 * when it holds one), and its final newline kept or left out as it was; a
 * hand-formatted file comes back in that indent, and JSON.stringify normalizes
 * escapes and number forms such as 1.0. A file that is not a JSON object is
 * refused before anything is written.
 */

export type JsonObject = PlainObject;

/** A key mdmem would write that holds a value that is not mdmem's, and the fix a refusal names. */
export interface HeldKey {
  key: string;
  fix: string;
}

/** One mdmem entry in a JSON document: how to tell it is there, add it, and remove exactly it. */
export interface JsonEntry {
  label: string;
  has: (doc: JsonObject) => boolean;
  /**
   * Called only when `has` is false: the key the entry would overwrite and the
   * fix to name, when that key holds a value that is not mdmem's; adding is then
   * refused. Undefined when nothing is in the way.
   */
  heldKey?: (doc: JsonObject) => HeldKey | undefined;
  /** Called only when `has` is false. */
  add: (doc: JsonObject) => void;
  /**
   * For an entry of several parts, whether some part is there: removing then
   * takes out what is left. Absent for an entry of one part, which `has` answers.
   */
  hasPart?: (doc: JsonObject) => boolean;
  /** Called only when `hasPart` (else `has`) is true; prunes the objects and arrays it leaves empty. */
  remove: (doc: JsonObject) => void;
}

/** A JSON config file and the entries mdmem keeps in it. */
export interface JsonConfigFile {
  /** Relative to the project root, or absolute for a file outside the project. */
  file: string;
  entries: readonly JsonEntry[];
}

/** A file's planned change: its new text, or null to delete it, and the entries added or removed. */
export interface PlannedFile {
  file: string;
  path: string;
  next: string | null;
  changed: string[];
}

const DEFAULT_INDENT = "  ";
const FIRST_INDENT = /\n(?<indent>[ \t]+)\S/u;

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isObject(value) && Object.keys(value).length === 0;
}

/** The object at `path`, creating the missing ones; a value in the way that is not an object is an error. */
function objectAt(doc: JsonObject, path: readonly string[]): JsonObject {
  let current = doc;
  for (const [i, key] of path.entries()) {
    const next = current[key] ?? {};
    if (!isObject(next)) {
      throw new Error(`"${path.slice(0, i + 1).join(".")}" is not an object`);
    }
    current[key] = next;
    current = next;
  }
  return current;
}

/** Delete the objects along `path` that are empty, deepest first, stopping at the first that is not. */
function prune(doc: JsonObject, path: readonly string[]): void {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const parent = valueAt(doc, path.slice(0, depth - 1));
    const key = path[depth - 1] ?? "";
    if (!(isObject(parent) && isEmpty(parent[key]))) {
      return;
    }
    Reflect.deleteProperty(parent, key);
  }
}

function splitPath(path: readonly string[]): [string[], string] {
  return [path.slice(0, -1), path.at(-1) ?? ""];
}

/** The identity of a plain value: equal to it, and set to it to make room for mdmem's. */
function valueIdentity(value: unknown): KeyIdentity {
  return {
    matches: (found) => Bun.deepEquals(found, value),
    fix: `remove it or set it to ${JSON.stringify(value)}`,
  };
}

/**
 * The entry that sets the key at `path` to `value`; the key is mdmem's while
 * `identity` matches what it holds (by default, while it equals `value`), and
 * adding over another value is refused.
 */
export function valueEntry(
  label: string,
  path: readonly string[],
  value: unknown,
  identity: KeyIdentity = valueIdentity(value)
): JsonEntry {
  const [parentPath, key] = splitPath(path);
  return {
    label,
    has: (doc) => identity.matches(valueAt(doc, path)),
    heldKey: (doc) =>
      valueAt(doc, path) === undefined
        ? undefined
        : { key: path.join("."), fix: identity.fix },
    add: (doc) => {
      objectAt(doc, parentPath)[key] = structuredClone(value);
    },
    remove: (doc) => {
      const parent = valueAt(doc, parentPath);
      if (isObject(parent)) {
        Reflect.deleteProperty(parent, key);
      }
      prune(doc, parentPath);
    },
  };
}

/** Replace the array at `path` by `items`, deleting it, and the objects it leaves empty, when there are none. */
function setItems(
  doc: JsonObject,
  path: readonly string[],
  items: unknown[]
): void {
  const [parentPath, key] = splitPath(path);
  const parent = valueAt(doc, parentPath);
  if (!isObject(parent)) {
    return;
  }
  if (items.length > 0) {
    parent[key] = items;
    return;
  }
  Reflect.deleteProperty(parent, key);
  prune(doc, parentPath);
}

/** The array at `path`, created when missing; a value in the way that is not an array is an error. */
function arrayAt(doc: JsonObject, path: readonly string[]): unknown[] {
  const [parentPath, key] = splitPath(path);
  const parent = objectAt(doc, parentPath);
  const array = parent[key] ?? [];
  if (!Array.isArray(array)) {
    throw new TypeError(`"${path.join(".")}" is not an array`);
  }
  parent[key] = array;
  return array;
}

/** The items of the array at `path`; none when it is missing or not an array. */
function itemsAt(doc: JsonObject, path: readonly string[]): unknown[] {
  const array = valueAt(doc, path);
  return Array.isArray(array) ? array : [];
}

/** The entry that puts `item`, a plain value, in the array at `path`; every item equal to it is mdmem's, and the others are the user's. */
export function arrayItemEntry(
  label: string,
  path: readonly string[],
  item: unknown
): JsonEntry {
  const isItem = (value: unknown): boolean => Bun.deepEquals(value, item);
  return {
    label,
    has: (doc) => itemsAt(doc, path).some(isItem),
    add: (doc) => {
      arrayAt(doc, path).push(structuredClone(item));
    },
    remove: (doc) => {
      setItems(
        doc,
        path,
        itemsAt(doc, path).filter((value) => !isItem(value))
      );
    },
  };
}

/** A hook handler as mdmem writes it: the command it runs, beside the agent's other fields (type, timeout, …). */
export interface HookHandler {
  readonly command: string;
  readonly [field: string]: unknown;
}

/** A hook group as mdmem writes it: its handlers, beside the agent's other fields (matcher, …). */
export interface HookGroup {
  readonly hooks: readonly HookHandler[];
  readonly [field: string]: unknown;
}

/** The handlers of a hook group; none for an item that is not one. */
function handlersOf(group: unknown): unknown[] {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
}

/** The command a handler runs; undefined for an item that is not a handler. */
function commandOf(handler: unknown): string | undefined {
  return isObject(handler) && typeof handler.command === "string"
    ? handler.command
    : undefined;
}

/**
 * The entry that puts `group`'s handlers in the hook groups at `path`. A handler
 * is mdmem's when it runs one of `group`'s commands, whatever else the user added
 * to it or to its group (timeout, disabled, matcher, …), and the entry is present
 * while every command is run by a handler, in any group. Adding puts the missing
 * handlers in the group that runs the others, or `group` itself when none does;
 * removing takes mdmem's handlers out and drops a group only once it holds no
 * handler, so the user's handlers stay.
 */
export function hookGroupEntry(
  label: string,
  path: readonly string[],
  group: HookGroup
): JsonEntry {
  const commands = group.hooks.map(({ command }) => command);
  const isMdmems = (handler: unknown): boolean => {
    const command = commandOf(handler);
    return command !== undefined && commands.includes(command);
  };
  const runCommands = (doc: JsonObject): Set<string | undefined> =>
    new Set(
      itemsAt(doc, path).flatMap((item) => handlersOf(item).map(commandOf))
    );
  return {
    label,
    has: (doc) => {
      const run = runCommands(doc);
      return commands.every((command) => run.has(command));
    },
    hasPart: (doc) => {
      const run = runCommands(doc);
      return commands.some((command) => run.has(command));
    },
    add: (doc) => {
      const run = runCommands(doc);
      const groups = arrayAt(doc, path);
      const own = groups.find((item) => handlersOf(item).some(isMdmems));
      if (own === undefined) {
        groups.push(structuredClone(group));
        return;
      }
      const handlers = handlersOf(own);
      for (const [i, handler] of group.hooks.entries()) {
        if (run.has(handler.command)) {
          continue;
        }
        // Before the handler of a later part, so the parts keep mdmem's order.
        const later = new Set(commands.slice(i + 1));
        const at = handlers.findIndex((found) =>
          later.has(commandOf(found) ?? "")
        );
        handlers.splice(
          at === -1 ? handlers.length : at,
          0,
          structuredClone(handler)
        );
      }
    },
    remove: (doc) => {
      const groups = itemsAt(doc, path).flatMap((item) => {
        const handlers = handlersOf(item);
        if (!(isObject(item) && handlers.some(isMdmems))) {
          return [item];
        }
        const rest = handlers.filter((handler) => !isMdmems(handler));
        return rest.length === 0 ? [] : [{ ...item, hooks: rest }];
      });
      setItems(doc, path, groups);
    },
  };
}

interface ReadConfig {
  path: string;
  /** The file's text; undefined when it does not exist. */
  raw: string | undefined;
  doc: JsonObject;
}

function configPath(root: string, file: string): string {
  return isAbsolute(file) ? file : join(root, file);
}

async function readConfig(root: string, file: string): Promise<ReadConfig> {
  const path = configPath(root, file);
  const raw = existsSync(path) ? await readFile(path, "utf-8") : undefined;
  if (raw === undefined || raw.trim().length === 0) {
    return { path, raw, doc: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RefusalError(
      `${file} is not valid JSON (${messageOf(error)}): fix it, then run the command again`,
      { cause: error }
    );
  }
  if (!isObject(parsed)) {
    throw new RefusalError(
      `${file} does not hold a JSON object: fix it, then run the command again`
    );
  }
  return { path, raw, doc: parsed };
}

/** `doc` as JSON, with `raw`'s indent, line ending and final newline, or a new file's. */
function serialize(doc: JsonObject, raw: string | undefined): string {
  const indent = raw?.match(FIRST_INDENT)?.groups?.indent ?? DEFAULT_INDENT;
  const newline = raw === undefined || raw.length === 0 || raw.endsWith("\n");
  // JSON.stringify escapes the line breaks inside strings, so every one left is the layout's.
  const eol = lineEndingOf(raw ?? "");
  const text = JSON.stringify(doc, null, indent).replaceAll("\n", eol);
  return `${text}${newline ? eol : ""}`;
}

function changeEntries(
  file: string,
  doc: JsonObject,
  entries: readonly JsonEntry[],
  mode: WiringMode
): string[] {
  const changed: string[] = [];
  for (const entry of entries) {
    const present =
      mode === "add" ? entry.has(doc) : (entry.hasPart ?? entry.has)(doc);
    if (present === (mode === "add")) {
      continue;
    }
    const held = mode === "add" ? entry.heldKey?.(doc) : undefined;
    if (held !== undefined) {
      throw heldKeyRefusal(file, held.key, held.fix);
    }
    try {
      if (mode === "add") {
        entry.add(doc);
      } else {
        entry.remove(doc);
      }
    } catch (error) {
      throw new RefusalError(
        `${file}: ${messageOf(error)}, so mdmem cannot ${mode} its ${entry.label}: fix it, then run the command again`,
        { cause: error }
      );
    }
    changed.push(entry.label);
  }
  return changed;
}

/**
 * Plan adding (or removing) every entry of `files`, reading each file but writing
 * none; a file is deleted when removing leaves it an empty object. Throws a
 * RefusalError for a file that is not a JSON object, whose shape is in the way,
 * or where adding would overwrite a value that is not mdmem's.
 */
export function planConfigs(
  root: string,
  files: readonly JsonConfigFile[],
  mode: WiringMode
): Promise<PlannedFile[]> {
  return Promise.all(
    files.map(async ({ file, entries }) => {
      const { path, raw, doc } = await readConfig(root, file);
      const changed = changeEntries(file, doc, entries, mode);
      const deleted =
        mode === "remove" &&
        raw !== undefined &&
        isEmpty(doc) &&
        changed.length > 0;
      return {
        file,
        path,
        next: deleted ? null : serialize(doc, raw),
        changed,
      };
    })
  );
}

/** Write the files a plan changes, and delete the ones it empties. */
export async function writeConfigs(
  plan: readonly PlannedFile[]
): Promise<void> {
  for (const { path, next, changed } of plan) {
    if (changed.length === 0) {
      continue;
    }
    if (next === null) {
      // oxlint-disable-next-line no-await-in-loop -- a few files, written in order
      await rm(path);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few files, written in order
    await mkdir(dirname(path), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- a few files, written in order
    await writeFile(path, next, "utf-8");
  }
}

/** One line per planned file, saying what enable ("add") or disable ("remove") did to it. */
export function describePlan(
  plan: readonly PlannedFile[],
  mode: WiringMode
): string[] {
  return plan.map(({ file, next, changed }) => {
    if (changed.length === 0) {
      return mode === "add"
        ? `${file} already holds mdmem's entries`
        : `${file} holds none of mdmem's entries`;
    }
    if (next === null) {
      return `deleted ${file}: it held only mdmem's entries`;
    }
    return `${mode === "add" ? "added" : "removed"} in ${file}: ${changed.join(", ")}`;
  });
}

/** Each entry of `files`, present or not; a file that cannot be read as a JSON object holds none, and a warning names it. */
export async function configStatus(
  root: string,
  files: readonly JsonConfigFile[]
): Promise<{ entries: WiringEntry[]; warnings: string[] }> {
  const read = await Promise.all(
    files.map(async ({ file }) => {
      try {
        const { doc } = await readConfig(root, file);
        return { doc };
      } catch (error) {
        return { doc: {}, warning: messageOf(error) };
      }
    })
  );
  const entries = files.flatMap(({ file, entries: fileEntries }, i) =>
    fileEntries.map((entry) => ({
      label: entry.label,
      file,
      present: entry.has(read[i]?.doc ?? {}),
    }))
  );
  const warnings = read.flatMap(({ warning }) =>
    warning === undefined ? [] : [warning]
  );
  return { entries, warnings };
}

/** The value at `path` in a JSON config file; undefined when the file or the key is missing, or the file cannot be read as a JSON object. */
export async function configValue(
  root: string,
  file: string,
  path: readonly string[]
): Promise<unknown> {
  try {
    const { doc } = await readConfig(root, file);
    return valueAt(doc, path);
  } catch {
    return undefined;
  }
}
