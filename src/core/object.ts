/** A parsed JSON or TOML document, or any of its tables: string keys, unknown values. */
export type PlainObject = Record<string, unknown>;

/** Whether `value` is an object that is neither null nor an array. */
export function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at `path` in `doc`; undefined when a key on the way is missing or holds no object. */
export function valueAt(doc: PlainObject, path: readonly string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}
