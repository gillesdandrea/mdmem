/** Shared helpers for adapters that manage a marked block inside an agent's own file. */

export const BLOCK_START = "<!-- mdmem:start -->";
export const BLOCK_END = "<!-- mdmem:end -->";

/** Insert `block` between markers, replacing an existing marked block if present. */
export function upsertMarkedBlock(content: string, block: string): string {
  const wrapped = `${BLOCK_START}\n${block.trim()}\n${BLOCK_END}`;
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return (
      content.slice(0, start) + wrapped + content.slice(end + BLOCK_END.length)
    );
  }
  const prefix = content.trim().length > 0 ? `${content.trimEnd()}\n\n` : "";
  return `${prefix}${wrapped}\n`;
}

export function removeMarkedBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return content;
  }
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + BLOCK_END.length).trimStart();
  const joined = [before, after].filter(Boolean).join("\n\n");
  return joined.length > 0 ? `${joined}\n` : "";
}

export function hasMarkedBlock(content: string): boolean {
  return content.includes(BLOCK_START) && content.includes(BLOCK_END);
}
