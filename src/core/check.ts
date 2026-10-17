import type { Frontmatter, Memory } from "./memory.ts";
import { memoryFileName, parseMemoryFile } from "./memory.ts";
import { describeSecrets, findSecrets } from "./secrets.ts";
import type { MemoryStore } from "./store.ts";

/**
 * The memory-level view of a store: it loads every memory once, runs the Check
 * (GLOSSARY.md) over the memories and the index, and keeps the index up to date.
 * Agents write memory files, never the index (`MEMORY.md`). mdmem updates the index
 * in place rather than regenerating it (ADR 0001), so a hand edit or an index
 * imported from Claude Code survives: every line that is not a pointer is kept, and
 * an existing pointer keeps its title.
 *
 * A broken memory blocks nothing (ADR 0002,
 * docs/adr/0002-refuse-or-degrade-never-crash.md): it keeps the pointer it has, gets
 * none if it has none, and loading keeps the memories that parse and reports the
 * broken ones beside them.
 */

export const INDEX_FILE = "MEMORY.md";

/**
 * A session-start hook injects the index into each session (ADR 0003), and Claude
 * Code caps the context of one hook entry at about 10,000 characters. mdmem keeps the
 * whole index, every line counted, under 9,500 characters, leaving the hook room for
 * the lines it adds around it.
 */
export const INDEX_MAX_CHARS = 9500;
/** An index at or past this fraction of its limit is near it, and a write warns. */
const INDEX_NEAR_FRACTION = 0.9;
/** Claude Code keeps each pointer to one line under about this many characters. */
export const POINTER_MAX_CHARS = 150;

/** A memory that parsed, with the file it was read from and its raw text. */
export interface LoadedMemory {
  file: string;
  raw: string;
  memory: Memory;
}

/** A memory file that could not be read or parsed, and why, in one line naming the file. */
export interface BrokenMemory {
  file: string;
  /** The file's text, when it could be read. */
  raw?: string;
  problem: string;
}

/** Every memory in a store, in file order: the ones that parse, and the broken ones. */
export interface MemoryLoad {
  memories: LoadedMemory[];
  broken: BrokenMemory[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadOne(
  store: MemoryStore,
  file: string
): Promise<LoadedMemory | BrokenMemory> {
  let raw: string;
  try {
    raw = await store.view(file);
  } catch (error) {
    return { file, problem: messageOf(error) };
  }
  try {
    return { file, raw, memory: parseMemoryFile(file, raw) };
  } catch (error) {
    return { file, raw, problem: messageOf(error) };
  }
}

/** Every memory file in file order, read concurrently, each parsed or broken. */
async function loadFiles(
  store: MemoryStore
): Promise<(LoadedMemory | BrokenMemory)[]> {
  const documents = await store.listFiles();
  const files = documents.filter((file) => file !== INDEX_FILE);
  return await Promise.all(files.map((file) => loadOne(store, file)));
}

function splitLoad(
  entries: readonly (LoadedMemory | BrokenMemory)[]
): MemoryLoad {
  const load: MemoryLoad = { memories: [], broken: [] };
  for (const entry of entries) {
    if ("memory" in entry) {
      load.memories.push(entry);
    } else {
      load.broken.push(entry);
    }
  }
  return load;
}

/** Read every memory once, keeping file order; a broken memory is reported, never thrown. */
export async function loadMemories(store: MemoryStore): Promise<MemoryLoad> {
  return splitLoad(await loadFiles(store));
}

/** What a pointer is made from: a memory's file and its frontmatter. */
interface PointerSource {
  file: string;
  frontmatter: Frontmatter;
}

/** A pointer: one line of the index, a memory's title linked to its file, then its description. */
type Pointer = string;

/** A file name a pointer can link to as it is, with no angle brackets. */
const BARE_TARGET_RE = /^[^\s()<>\\]+$/u;
/** Characters a backslash escapes in a pointer's title (`[]\`) or angle-bracketed target (`<>\`). */
const TITLE_ESCAPED_RE = /[[\]\\]/gu;
const ANGLE_ESCAPED_RE = /[<>\\]/gu;
const WHITESPACE_RE = /\s+/gu;

/** `text` on one line, so a pointer never spans two: every run of whitespace becomes one space. */
function oneLine(text: string): string {
  return text.replaceAll(WHITESPACE_RE, " ").trim();
}

/** A link target for `file` that `matchPointer` reads back as `file`: bare, or in angle brackets. */
function linkTarget(file: string): string {
  return BARE_TARGET_RE.test(file)
    ? file
    : `<${file.replaceAll(ANGLE_ESCAPED_RE, "\\$&")}>`;
}

/**
 * The pointer mdmem writes for a memory: titled with its name, since the format has
 * no title field, and written so that `matchPointer` recognizes it whatever the name
 * and file name hold, or reconciling would append it again on every save.
 */
function pointerLine({ file, frontmatter }: PointerSource): Pointer {
  const title = oneLine(frontmatter.name).replaceAll(TITLE_ESCAPED_RE, "\\$&");
  return `- [${title}](${linkTarget(file)}) — ${oneLine(frontmatter.description)}`;
}

function pointerSource({ file, memory }: LoadedMemory): PointerSource {
  return { file, frontmatter: memory.frontmatter };
}

/**
 * A line that points at a memory file: a list item, bulleted or numbered, opening
 * with a Markdown link whose target is a `<file>.md` with no directory, or `./` before
 * it. The title may hold backslash escapes and
 * balanced brackets; the target is bare, or in angle brackets when it holds spaces,
 * parentheses or backslash escapes. A link to a URL or into a directory is never a
 * pointer, so such a line is kept as it is.
 */
const POINTER_RE =
  /^\s*(?:[-*+]|\d+[.)])\s+\[(?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*\]\((?:<(?<angle>(?:[^<>\n\\]|\\.)+)>|(?<bare>[^()\s<>\\]+))\)/u;
/** A `./` before a target, which still names a file in the store. */
const CURRENT_DIR_RE = /^\.\//u;
/** A backslash escape in an angle-bracketed target: CommonMark escapes ASCII punctuation only. */
const TARGET_ESCAPE_RE = /\\(?<char>[!-/:-@[-`{-~])/gu;

/** Separates a pointer's link from its description. */
const HOOK_DASH = "—";

interface PointerMatch {
  /** The memory file the pointer links to. */
  target: string;
  /** Where the link ends in the line. */
  linkEnd: number;
}

/** The memory file `line` points at, or undefined when it is not a pointer. */
function matchPointer(line: string): PointerMatch | undefined {
  const match = POINTER_RE.exec(line);
  if (match === null) {
    return undefined;
  }
  const { angle, bare } = match.groups ?? {};
  const target = (
    angle?.replaceAll(TARGET_ESCAPE_RE, "$<char>") ?? bare
  )?.replace(CURRENT_DIR_RE, "");
  if (
    target === undefined ||
    !target.endsWith(".md") ||
    target.includes("/") ||
    target.toLowerCase() === INDEX_FILE.toLowerCase()
  ) {
    return undefined;
  }
  return { target, linkEnd: match[0].length };
}

/** The memory file a line of an index points at, or undefined when the line is not a pointer. */
export function pointerTarget(line: string): string | undefined {
  return matchPointer(line)?.target;
}

/** A memory just saved: its file, its description, and its description before the save. */
export interface SavedMemory {
  file: string;
  description: string;
  /** Undefined when the memory is new, or did not parse before. */
  previousDescription?: string;
}

/**
 * The saved memory's pointer: the line and its title are kept, and the text after
 * the dash becomes the new description only when the description changed. A pointer
 * with no dash gets one, followed by the description.
 */
function savedPointer(
  line: string,
  { linkEnd }: PointerMatch,
  { description, previousDescription }: SavedMemory
): Pointer {
  const dash = line.indexOf(HOOK_DASH, linkEnd);
  if (dash === -1) {
    return `${line.trimEnd()} ${HOOK_DASH} ${oneLine(description)}`;
  }
  if (description === previousDescription) {
    return line;
  }
  return `${line.slice(0, dash)}${HOOK_DASH} ${oneLine(description)}`;
}

/** What an index lacks or holds in excess against the memory files, each by file name. */
interface IndexFindings {
  /** Memories that parse and have no pointer. */
  missing: string[];
  /** Pointers to files that do not exist. */
  dangling: string[];
  /** Files with more than one pointer, once each. */
  duplicated: string[];
}

/** An index brought up to date, the files it points at, and what was wrong with it. */
interface Reconciled {
  content: string;
  pointed: ReadonlySet<string>;
  findings: IndexFindings;
}

const LINE_BREAK_RE = /\r?\n/u;

/** The line ending `content` uses: CRLF when it holds one, else LF. */
function lineEndingOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** The lines of `content`, without their endings or the empty one after a final line break. */
function linesOf(content: string): string[] {
  if (content === "") {
    return [];
  }
  const lines = content.split(LINE_BREAK_RE);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Bring the index `current` up to date with the memory files `files`, in place:
 * pointers to missing files are dropped, a file's pointers after its first are
 * dropped, each saved memory's pointer gets its new description, and a memory that
 * parses and has no pointer gets one appended at the end. Every other line is kept.
 */
function reconcileIndex(
  current: string,
  files: ReadonlySet<string>,
  memories: readonly LoadedMemory[],
  saved: readonly SavedMemory[] = []
): Reconciled {
  const kept: string[] = [];
  const pointed = new Set<string>();
  const findings: IndexFindings = { missing: [], dangling: [], duplicated: [] };
  for (const line of linesOf(current)) {
    const pointer = matchPointer(line);
    if (pointer === undefined) {
      kept.push(line);
    } else if (!files.has(pointer.target)) {
      findings.dangling.push(pointer.target);
    } else if (pointed.has(pointer.target)) {
      if (!findings.duplicated.includes(pointer.target)) {
        findings.duplicated.push(pointer.target);
      }
    } else {
      pointed.add(pointer.target);
      const savedHere = saved.find(({ file }) => file === pointer.target);
      kept.push(savedHere ? savedPointer(line, pointer, savedHere) : line);
    }
  }
  for (const loaded of memories) {
    if (!pointed.has(loaded.file)) {
      findings.missing.push(loaded.file);
      kept.push(pointerLine(pointerSource(loaded)));
    }
  }
  const eol = lineEndingOf(current);
  const content = kept.length === 0 ? "" : `${kept.join(eol)}${eol}`;
  return { content, pointed, findings };
}

/** The index's text, or empty when there is none yet. */
async function currentIndex(store: MemoryStore): Promise<string> {
  return store.exists(INDEX_FILE) ? await store.view(INDEX_FILE) : "";
}

/** An index near or over the size a session-start hook can inject. */
interface CapacityReport {
  over: boolean;
  message: string;
}

/** Whether `content`, an index, is near or over its limit; undefined when it is well under. */
function indexCapacity(content: string): CapacityReport | undefined {
  const size = [...content].length;
  if (size < INDEX_MAX_CHARS * INDEX_NEAR_FRACTION) {
    return undefined;
  }
  const over = size > INDEX_MAX_CHARS;
  const consequence = over
    ? "a session-start hook cannot inject all of it"
    : "past it, a session-start hook cannot inject all of it";
  return {
    over,
    message: `${INDEX_FILE} is at ${size.toLocaleString("en-US")} characters, ${over ? "over" : "near"} its ${INDEX_MAX_CHARS.toLocaleString("en-US")}-character limit, the size a session-start hook can inject: ${consequence}. Shorten descriptions, or merge or delete memories.`,
  };
}

/** The warning for a broken memory met while updating the index, saying what became of its pointer. */
function brokenWarning(
  { file, problem }: BrokenMemory,
  pointed: ReadonlySet<string>
): string {
  return pointed.has(file)
    ? `${problem} (it keeps its pointer in ${INDEX_FILE})`
    : `${problem} (it has no pointer in ${INDEX_FILE} until it parses)`;
}

/**
 * Bring the index up to date with the memory files, in place (`reconcileIndex`
 * says how), writing it only when it changes. `saved` is the memory a write just
 * saved, or the memories an import replaced, whose pointers take their new
 * descriptions. Returns a warning for each broken memory, and one for an index near
 * or over its limit.
 */
export async function reindex(
  store: MemoryStore,
  saved?: SavedMemory | readonly SavedMemory[]
): Promise<string[]> {
  const entries = await loadFiles(store);
  const { memories, broken } = splitLoad(entries);
  const current = await currentIndex(store);
  const files = new Set(entries.map(({ file }) => file));
  const savedList = saved === undefined ? [] : [saved].flat();
  const { content, pointed } = reconcileIndex(
    current,
    files,
    memories,
    savedList
  );
  if (content !== current || !store.exists(INDEX_FILE)) {
    await store.create(INDEX_FILE, content);
  }
  const capacity = indexCapacity(content);
  return [
    ...broken.map((entry) => brokenWarning(entry, pointed)),
    ...(capacity ? [capacity.message] : []),
  ];
}

/**
 * `reindex` after a write that already landed: a failure becomes a warning that the
 * index is stale, worded once here so the CLI and MCP say the same thing.
 */
export async function refreshIndex(
  store: MemoryStore,
  saved?: SavedMemory
): Promise<string[]> {
  try {
    return await reindex(store, saved);
  } catch (error) {
    return [
      `${INDEX_FILE} is stale: ${messageOf(error)} (run \`mdmem reindex\`)`,
    ];
  }
}

/** The result of a Check: how many memory files the store holds, and every problem found. */
export interface Check {
  memoryCount: number;
  problems: string[];
}

const LINK_RE = /\[\[(?<name>[a-z0-9_-]+)\]\]/gu;

/** The names a memory's body links to with `[[name]]`. */
function linkNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(LINK_RE)) {
    const name = match.groups?.name;
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/** Problems with one memory file on its own: a secret, then an unparseable memory, or a name that differs from its file name and conflicting types. */
function fileProblems(entry: LoadedMemory | BrokenMemory): string[] {
  const problems: string[] = [];
  // Checked before parsing, so a secret in an unparseable memory is reported too.
  const secrets = entry.raw === undefined ? [] : findSecrets(entry.raw);
  if (secrets.length > 0) {
    problems.push(
      `${entry.file}: looks like it holds a secret at ${describeSecrets(secrets)}`
    );
  }
  if (!("memory" in entry)) {
    problems.push(entry.problem);
    return problems;
  }
  const { name, type, metadata } = entry.memory.frontmatter;
  if (memoryFileName(name) !== entry.file) {
    problems.push(`${entry.file}: name "${name}" ≠ filename`);
  }
  if (
    type !== undefined &&
    metadata?.type !== undefined &&
    type !== metadata.type
  ) {
    problems.push(
      `${entry.file}: metadata.type "${metadata.type}" ≠ type "${type}" — metadata.type wins; remove one`
    );
  }
  return problems;
}

/** Problems with a parsed memory among the others: an over-long pointer, a dangling link. */
function memoryProblems(
  loaded: LoadedMemory,
  known: ReadonlySet<string>
): string[] {
  const problems: string[] = [];
  const pointerChars = [...pointerLine(pointerSource(loaded))].length;
  if (pointerChars > POINTER_MAX_CHARS) {
    problems.push(
      `${loaded.file}: its pointer is ${pointerChars} characters, over ${POINTER_MAX_CHARS} — shorten its description`
    );
  }
  for (const name of linkNames(loaded.memory.body)) {
    if (!known.has(name)) {
      problems.push(`${loaded.file}: dangling [[${name}]]`);
    }
  }
  return problems;
}

/** The ways the index `current` is stale against the memory files, one problem each. */
function staleIndexProblems(
  current: string,
  files: ReadonlySet<string>,
  memories: readonly LoadedMemory[]
): string[] {
  const { missing, dangling, duplicated } = reconcileIndex(
    current,
    files,
    memories
  ).findings;
  const stale = [
    ...missing.map((file) => `no pointer to ${file}`),
    ...dangling.map((file) => `a pointer to ${file}, which does not exist`),
    ...duplicated.map((file) => `more than one pointer to ${file}`),
  ];
  return stale.map(
    (finding) => `${INDEX_FILE} is stale: ${finding} — run \`mdmem reindex\``
  );
}

/** Problems with the index: stale against the memory files, or over its limit. */
async function indexProblems(
  store: MemoryStore,
  files: ReadonlySet<string>,
  memories: readonly LoadedMemory[]
): Promise<string[]> {
  const current = await currentIndex(store);
  const problems = staleIndexProblems(current, files, memories);
  const capacity = indexCapacity(current);
  if (capacity?.over) {
    problems.push(capacity.message);
  }
  return problems;
}

/** Run a Check over the store: every problem with its memories and its index. It never writes. */
export async function checkStore(store: MemoryStore): Promise<Check> {
  const entries = await loadFiles(store);
  const { memories } = splitLoad(entries);
  const files = new Set(entries.map(({ file }) => file));
  // A link resolves to a memory's name or to a memory file's name without .md.
  const known = new Set([
    ...memories.map(({ memory }) => memory.frontmatter.name),
    ...[...files].map((file) => file.slice(0, -".md".length)),
  ]);
  const problems = [
    ...entries.flatMap(fileProblems),
    ...memories.flatMap((loaded) => memoryProblems(loaded, known)),
    ...(await indexProblems(store, files, memories)),
  ];
  return { memoryCount: entries.length, problems };
}

/** The index as a session starts with it, and what the session needs warning of. */
export interface SessionIndex {
  /** The index's text, empty when there is none yet. */
  index: string;
  /** Each unparseable memory, then each way the index is stale, worded as the Check words them. */
  warnings: string[];
}

/**
 * The index and the Check's problems a session-start hook reports beside it: the
 * unparseable memories and a stale index. It never writes, so it creates no index.
 */
export async function sessionIndex(store: MemoryStore): Promise<SessionIndex> {
  const entries = await loadFiles(store);
  const { memories, broken } = splitLoad(entries);
  const files = new Set(entries.map(({ file }) => file));
  const index = await currentIndex(store);
  return {
    index,
    warnings: [
      ...broken.map(({ problem }) => problem),
      ...staleIndexProblems(index, files, memories),
    ],
  };
}

function countMemories(count: number): string {
  return count === 1 ? "1 memory" : `${count} memories`;
}

/** A Check as both surfaces print it: the problems one per line, or the memory count and no problems. */
export function formatCheck({ memoryCount, problems }: Check): string {
  if (problems.length === 0) {
    return `✓ ${countMemories(memoryCount)}, no problems`;
  }
  return [
    `Found ${problems.length} problem(s):`,
    ...problems.map((problem) => `  - ${problem}`),
  ].join("\n");
}
