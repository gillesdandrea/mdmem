import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse, patch, stringify } from "@decimalturn/toml-patch";

import { RefusalError } from "../core/refusal.ts";
import type { PlannedFile } from "./json-config.ts";

/**
 * One mdmem table in an agent's TOML config file, merged in and taken out without
 * touching the rest, planned as json-config plans a JSON file so the same
 * writeConfigs and describePlan apply. Adding appends the table as its own
 * `[a.b]` section at the end of the file, in the file's line ending, so the
 * user's text is kept byte for byte; removing goes through toml-patch, which
 * keeps other comments and formatting but drops the comment lines directly above
 * the removed table, inside it and after it, and those directly above the table
 * after it, with the blank lines around them. A file that is not valid TOML, or
 * whose shape is in the way, is refused before anything is written.
 */

export interface TomlTableEntry {
  label: string;
  /** Relative to the project root. */
  file: string;
  /** The table's key path, each key a bare TOML key. */
  path: readonly string[];
  /** The table mdmem keeps there; it is mdmem's only while it holds exactly this. */
  value: Record<string, unknown>;
}

type TomlObject = Record<string, unknown>;

function isObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(doc: TomlObject, path: readonly string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function has(doc: TomlObject, entry: TomlTableEntry): boolean {
  return Bun.deepEquals(valueAt(doc, entry.path), entry.value);
}

function parseToml(file: string, raw: string): TomlObject {
  try {
    return parse(raw) as TomlObject;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RefusalError(
      `${file} is not valid TOML (${reason}): fix it, then run the command again`,
      { cause: error }
    );
  }
}

async function readToml(
  root: string,
  file: string
): Promise<{ path: string; raw: string | undefined; doc: TomlObject }> {
  const path = join(root, file);
  const raw = existsSync(path) ? await readFile(path, "utf-8") : undefined;
  return { path, raw, doc: raw === undefined ? {} : parseToml(file, raw) };
}

/** Refuse when a key on the table's path holds something other than a table. */
function checkShape(doc: TomlObject, entry: TomlTableEntry): void {
  for (let depth = 1; depth < entry.path.length; depth += 1) {
    const value = valueAt(doc, entry.path.slice(0, depth));
    if (value !== undefined && !isObject(value)) {
      throw new RefusalError(
        `${entry.file}: "${entry.path.slice(0, depth).join(".")}" is not a table, so mdmem cannot change its ${entry.label}: fix it, then run the command again`
      );
    }
  }
}

/** `raw` with the table appended as its own section, or null when that is not valid TOML (the parent is an inline table, say). */
function appendSection(raw: string, entry: TomlTableEntry): string | null {
  // Match the file's line ending, so a CRLF file does not end up with mixed endings.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let separator = eol;
  if (raw.length === 0 || raw.endsWith(`${eol}${eol}`)) {
    separator = "";
  } else if (!raw.endsWith(eol)) {
    separator = `${eol}${eol}`;
  }
  const section =
    `[${entry.path.join(".")}]\n${stringify(entry.value, { bracketSpacing: false })}`.replaceAll(
      "\n",
      eol
    );
  const next = `${raw}${separator}${section}`;
  try {
    return has(parse(next) as TomlObject, entry) ? next : null;
  } catch {
    return null;
  }
}

/** Take the table out of `doc`, then the tables it leaves empty. */
function removeTable(doc: TomlObject, path: readonly string[]): void {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const parent = valueAt(doc, path.slice(0, depth - 1));
    const key = path[depth - 1] ?? "";
    const value = isObject(parent) ? parent[key] : undefined;
    const emptied = isObject(value) && Object.keys(value).length === 0;
    if (!isObject(parent) || (depth < path.length && !emptied)) {
      return;
    }
    Reflect.deleteProperty(parent, key);
  }
}

/** Set the table at its path in `doc`, creating the tables above it. */
function setTable(doc: TomlObject, entry: TomlTableEntry): void {
  let current = doc;
  for (const key of entry.path.slice(0, -1)) {
    const child = current[key];
    const table = isObject(child) ? child : {};
    current[key] = table;
    current = table;
  }
  current[entry.path.at(-1) ?? ""] = structuredClone(entry.value);
}

/**
 * Plan adding (or removing) the table, reading its file but writing nothing; the
 * file is deleted when removing leaves it blank. Throws a RefusalError for a file
 * that is not valid TOML, or whose shape is in the way.
 */
export async function planTomlTable(
  root: string,
  entry: TomlTableEntry,
  mode: "add" | "remove"
): Promise<PlannedFile> {
  const { path, raw, doc } = await readToml(root, entry.file);
  checkShape(doc, entry);
  const unchanged = { file: entry.file, path, next: raw ?? "", changed: [] };
  if (has(doc, entry) === (mode === "add")) {
    return unchanged;
  }
  if (mode === "add") {
    const text = raw ?? "";
    const appended = appendSection(text, entry);
    if (appended !== null) {
      return { ...unchanged, next: appended, changed: [entry.label] };
    }
    // The document is mutated in place: a clone would turn its dates into plain Dates, which patch rewrites.
    setTable(doc, entry);
    return { ...unchanged, next: patch(text, doc), changed: [entry.label] };
  }
  removeTable(doc, entry.path);
  const next = patch(raw ?? "", doc);
  return {
    ...unchanged,
    next: next.trim().length === 0 ? null : next,
    changed: [entry.label],
  };
}

/** Whether the table is there; a file that cannot be read as TOML holds none, and the warning names it. */
export async function tomlTableStatus(
  root: string,
  entry: TomlTableEntry
): Promise<{ present: boolean; warning?: string }> {
  try {
    const { doc } = await readToml(root, entry.file);
    return { present: has(doc, entry) };
  } catch (error) {
    return {
      present: false,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether a table stands at the entry's path, whatever it holds; a file that cannot be read as TOML holds none. */
export async function tomlTableExists(
  root: string,
  entry: TomlTableEntry
): Promise<boolean> {
  try {
    const { doc } = await readToml(root, entry.file);
    return isObject(valueAt(doc, entry.path));
  } catch {
    return false;
  }
}
