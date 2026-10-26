/**
 * The project key, shared by the store's resolution (./store.ts) and the import of
 * Claude Code's memories (./import.ts). It imports nothing of mdmem's, so neither
 * module imports the other through it.
 */

/** Claude Code cuts a project key longer than this and appends a hash of the path. */
const KEY_MAX_LENGTH = 200;
const HASH_RADIX = 36;
const HASH_MULTIPLIER = 31;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= CHAR_0 && code <= CHAR_9) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z)
  );
}

/** Java's `String.hashCode` over UTF-16 code units, as a signed 32-bit integer. */
function stringHash(text: string): number {
  let hash = 0;
  // Indexed, not for...of: the hash runs over UTF-16 code units, and for...of yields code points.
  for (let i = 0; i < text.length; i += 1) {
    // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- Java's hash wraps to 32 bits over UTF-16 code units, as Claude Code's does
    hash = (Math.imul(HASH_MULTIPLIER, hash) + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * The key of the project at `path`: the name of its home store under `~/.mdmem/`
 * (ADR 0005) and of Claude Code's project directory under `~/.claude/projects/`.
 * It is mdmem's own key, so a change in Claude Code's encoding never moves a store;
 * today the two agree. It mirrors Claude Code's encoding, which is undocumented;
 * verified against Claude Code 2.1.302 with
 * `claude -p`: every UTF-16 code unit that is not an ASCII letter or digit becomes
 * `-` (so `/`, `.`, `_`, spaces and `é` each give one, an emoji two), and a key
 * longer than 200 characters is cut at 200 and followed by `-` and the base-36
 * absolute value of the path's Java-style string hash.
 */
export function projectKey(path: string): string {
  let key = "";
  // Indexed, not for...of: Claude Code maps UTF-16 code units, and for...of yields code points.
  for (let i = 0; i < path.length; i += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Claude Code replaces each UTF-16 code unit, so an emoji gives two dashes
    key += isAsciiAlphanumeric(path.charCodeAt(i)) ? path[i] : "-";
  }
  if (key.length <= KEY_MAX_LENGTH) {
    return key;
  }
  const hash = Math.abs(stringHash(path)).toString(HASH_RADIX);
  return `${key.slice(0, KEY_MAX_LENGTH)}-${hash}`;
}
