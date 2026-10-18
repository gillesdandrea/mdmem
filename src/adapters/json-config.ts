import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { RefusalError } from "../core/refusal.ts";
import type { WiringEntry } from "./adapter.ts";

/**
 * mdmem's entries in an agent's JSON config files, merged in and taken out without
 * touching the rest. A file is parsed, changed and written back with the indent
 * it had (two spaces for a new file), its key order, and its final newline kept or
 * left out as it was; a hand-formatted file comes back in that indent, and
 * JSON.stringify normalizes escapes and number forms such as 1.0. A file that is not a JSON object is refused before anything is written.
 */

export type JsonObject = Record<string, unknown>;

/** One mdmem entry in a JSON document: how to tell it is there, add it, and remove exactly it. */
export interface JsonEntry {
  label: string;
  has: (doc: JsonObject) => boolean;
  /** Called only when `has` is false. */
  add: (doc: JsonObject) => void;
  /** Called only when `has` is true; prunes the objects and arrays it leaves empty. */
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isObject(value) && Object.keys(value).length === 0;
}

function valueAt(doc: JsonObject, path: readonly string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
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

/** The entry that sets the key at `path` to `value`; it is mdmem's only while it holds that value. */
export function valueEntry(
  label: string,
  path: readonly string[],
  value: unknown
): JsonEntry {
  const [parentPath, key] = splitPath(path);
  return {
    label,
    has: (doc) => Bun.deepEquals(valueAt(doc, path), value),
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

/** The entry that puts `item` in the array at `path`; every item equal to it is mdmem's. */
export function arrayItemEntry(
  label: string,
  path: readonly string[],
  item: unknown
): JsonEntry {
  const [parentPath, key] = splitPath(path);
  return {
    label,
    has: (doc) => {
      const array = valueAt(doc, path);
      return Array.isArray(array) && array.some((x) => Bun.deepEquals(x, item));
    },
    add: (doc) => {
      const parent = objectAt(doc, parentPath);
      const array = parent[key] ?? [];
      if (!Array.isArray(array)) {
        throw new TypeError(`"${path.join(".")}" is not an array`);
      }
      array.push(structuredClone(item));
      parent[key] = array;
    },
    remove: (doc) => {
      const parent = valueAt(doc, parentPath);
      const array = isObject(parent) ? parent[key] : undefined;
      if (!(isObject(parent) && Array.isArray(array))) {
        return;
      }
      const rest = array.filter((x) => !Bun.deepEquals(x, item));
      if (rest.length > 0) {
        parent[key] = rest;
        return;
      }
      Reflect.deleteProperty(parent, key);
      prune(doc, parentPath);
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new RefusalError(
      `${file} is not valid JSON (${reason}): fix it, then run the command again`,
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

/** `doc` as JSON, with `raw`'s indent and final newline, or a new file's. */
function serialize(doc: JsonObject, raw: string | undefined): string {
  const indent = raw?.match(FIRST_INDENT)?.groups?.indent ?? DEFAULT_INDENT;
  const newline = raw === undefined || raw.length === 0 || raw.endsWith("\n");
  return `${JSON.stringify(doc, null, indent)}${newline ? "\n" : ""}`;
}

function changeEntries(
  file: string,
  doc: JsonObject,
  entries: readonly JsonEntry[],
  mode: "add" | "remove"
): string[] {
  const changed: string[] = [];
  for (const entry of entries) {
    if (entry.has(doc) === (mode === "add")) {
      continue;
    }
    try {
      if (mode === "add") {
        entry.add(doc);
      } else {
        entry.remove(doc);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RefusalError(
        `${file}: ${reason}, so mdmem cannot ${mode} its ${entry.label}: fix it, then run the command again`,
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
 * RefusalError for a file that is not a JSON object, or whose shape is in the way.
 */
export function planConfigs(
  root: string,
  files: readonly JsonConfigFile[],
  mode: "add" | "remove"
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
  mode: "add" | "remove"
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
        return {
          doc: {},
          warning: error instanceof Error ? error.message : String(error),
        };
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
