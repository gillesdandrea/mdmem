/** Text helpers shared by the CLI, the MCP server, the core modules and the adapters' config files. */

/** A line break, LF or CRLF: what splits a text into its lines. */
export const LINE_BREAK_RE = /\r?\n/u;

const WHITESPACE_RE = /\s+/gu;

/** The message of a thrown value: an Error's message, else the value as a string. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `text` on one line: every run of whitespace becomes one space. */
export function oneLine(text: string): string {
  return text.replaceAll(WHITESPACE_RE, " ").trim();
}

/** The line ending `content` uses: CRLF when it holds one, else LF. */
export function lineEndingOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
