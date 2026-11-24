/**
 * A refusal: an operation core will not perform because it would damage the store
 * or lose someone's work (ADR 0002, docs/adr/0002-refuse-or-degrade-never-crash.md).
 * Its message says what was refused and what to do next. Each surface catches it
 * once: the CLI prints the message and exits 1, MCP returns it as an error result.
 */
export class RefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefusalError";
  }
}

/**
 * The refusal of writing mdmem's value at `key` in `file`, which already holds a
 * value that is not mdmem's: overwriting it would lose the user's entry. `fix`
 * says how to make room for mdmem's.
 */
export function heldKeyRefusal(
  file: string,
  key: string,
  fix: string
): RefusalError {
  return new RefusalError(
    `${file}: ${key} holds a value that is not mdmem's, so mdmem will not overwrite it: ${fix}, then run the command again`
  );
}
