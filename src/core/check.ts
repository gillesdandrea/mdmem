import type { Frontmatter, Memory } from "./memory.ts";
import { memoryFileName, parseMemoryFile } from "./memory.ts";
import { describeSecrets, findSecrets } from "./secrets.ts";
import type { MemoryStore } from "./store.ts";
import { LINE_BREAK_RE, lineEndingOf, messageOf, oneLine } from "./text.ts";

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

/**
 * The header of the index of a store mdmem creates for the project at `project`:
 * an HTML comment, hidden where Markdown renders, that tells an agent or a person
 * who opens the store's directory what it is and how to use it without the mdmem
 * tools. About 300 characters plus the path, counted in the index's limit. It names
 * the project rather than the placement, so it stays true after a move. Written
 * once, at creation; reindex keeps it as it keeps any line that is not a pointer,
 * and never adds it to a store without one.
 */
export function indexHeader(project: string): string {
  return [
    `<!-- mdmem: this directory is the shared agent memory of the project at ${project}.`,
    "Read this index, then the memory files you need. Save with `mdmem add` or the",
    "mdmem MCP tool memory_write; after editing a file by hand run `mdmem reindex`.",
    "`mdmem status` shows whether your agent is wired, `mdmem --help` the rest. -->",
    "",
  ].join("\n");
}

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

/** A line break, which no pointer's link can hold: a file name with one never gets a pointer. */
const NAME_LINE_BREAK_RE = /[\r\n]/u;

/** `file` as a problem names it: quoted when it holds a line break, so the line break shows as \n and the problem stays on one line. */
function shownFile(file: string): string {
  return NAME_LINE_BREAK_RE.test(file) ? JSON.stringify(file) : file;
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
  if (NAME_LINE_BREAK_RE.test(file)) {
    // Read all the same, so the check still scans it for secrets.
    return {
      file,
      raw,
      problem: `${shownFile(file)}: its file name holds a line break, so mdmem skips it and it has no pointer in ${INDEX_FILE} — rename it`,
    };
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

/** A link target for `file` that `matchPointer` reads back as `file`: bare, or in angle brackets. */
function linkTarget(file: string): string {
  return BARE_TARGET_RE.test(file)
    ? file
    : `<${file.replaceAll(ANGLE_ESCAPED_RE, "\\$&")}>`;
}

/** The title, as a pointer's line spells it, of the pointer mdmem writes for the memory named `name`. */
function pointerTitle(name: string): string {
  return oneLine(name).replaceAll(TITLE_ESCAPED_RE, "\\$&");
}

/**
 * The pointer mdmem writes for a memory: titled with its name, since the format has
 * no title field, and written so that `matchPointer` recognizes it whatever the name
 * and file name hold, or reconciling would append it again on every save.
 */
function pointerLine({ file, frontmatter }: PointerSource): Pointer {
  return `- [${pointerTitle(frontmatter.name)}](${linkTarget(file)}) — ${oneLine(frontmatter.description)}`;
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
  /^\s*(?:[-*+]|\d+[.)])\s+\[(?<title>(?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\((?:<(?<angle>(?:[^<>\n\\]|\\.)+)>|(?<bare>[^()\s<>\\]+))\)/u;
/** A `./` before a target, which still names a file in the store. */
const CURRENT_DIR_RE = /^\.\//u;
/** A backslash escape in an angle-bracketed target: CommonMark escapes ASCII punctuation only. */
const TARGET_ESCAPE_RE = /\\(?<char>[!-/:-@[-`{-~])/gu;

/** Separates a pointer's link from its description. */
const DESCRIPTION_SEPARATOR = "—";

interface PointerMatch {
  /** The memory file the pointer links to. */
  target: string;
  /** The pointer's title as the line spells it, escapes included. */
  title: string;
  /** Where the link ends in the line. */
  linkEnd: number;
}

/** The memory file `line` points at, or undefined when it is not a pointer. */
function matchPointer(line: string): PointerMatch | undefined {
  const match = POINTER_RE.exec(line);
  if (match === null) {
    return undefined;
  }
  const { title = "", angle, bare } = match.groups ?? {};
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
  return { target, title, linkEnd: match[0].length };
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
 * `line`, a pointer whose separator, if any, is at `separator` (-1 when it has none),
 * carrying `description` after it: the line and its title are kept, the text after
 * the separator is replaced when it differs, and a pointer with no separator gets
 * one, followed by the description.
 */
function withDescription(
  line: string,
  separator: number,
  description: string
): Pointer {
  const text = oneLine(description);
  if (separator === -1) {
    return `${line.trimEnd()} ${DESCRIPTION_SEPARATOR} ${text}`;
  }
  if (line.slice(separator + DESCRIPTION_SEPARATOR.length).trim() === text) {
    return line;
  }
  return `${line.slice(0, separator)}${DESCRIPTION_SEPARATOR} ${text}`;
}

/** A pointer kept in the index, and whether it is in mdmem's form with another description. */
interface RefreshedPointer {
  line: Pointer;
  outdated: boolean;
}

/**
 * The pointer `line` with the description it should carry. A pointer in mdmem's form
 * (titled with its memory's name, then the separator) takes the memory's description
 * whenever it differs. Any other pointer takes the saved memory's description only
 * when the save changed it, or when the pointer has no separator.
 */
function refreshedPointer(
  line: string,
  { title, linkEnd }: PointerMatch,
  frontmatter: Frontmatter | undefined,
  saved: SavedMemory | undefined
): RefreshedPointer {
  const separator = line.indexOf(DESCRIPTION_SEPARATOR, linkEnd);
  if (
    separator !== -1 &&
    frontmatter !== undefined &&
    title === pointerTitle(frontmatter.name)
  ) {
    const refreshed = withDescription(line, separator, frontmatter.description);
    return { line: refreshed, outdated: refreshed !== line };
  }
  const unchanged =
    saved === undefined ||
    (separator !== -1 && saved.description === saved.previousDescription);
  return {
    line: unchanged
      ? line
      : withDescription(line, separator, saved.description),
    outdated: false,
  };
}

/** What an index lacks or holds in excess against the memory files, each by file name. */
interface IndexFindings {
  /** Memories that parse and have no pointer. */
  missing: string[];
  /** Pointers to files that do not exist. */
  dangling: string[];
  /** Files with more than one pointer, once each. */
  duplicated: string[];
  /** Files whose pointer is in mdmem's form (`refreshedPointer`) and carries another description. */
  outdated: string[];
}

/** An index brought up to date, the files it points at, what was wrong with it, and the files whose pointer it rewrote. */
interface Reconciled {
  content: string;
  pointed: ReadonlySet<string>;
  findings: IndexFindings;
  rewritten: ReadonlySet<string>;
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
 * dropped, each pointer takes the description `refreshedPointer` gives it, and a
 * memory that parses and has no pointer gets one appended at the end. Every other
 * line is kept.
 */
function reconcileIndex(
  current: string,
  files: ReadonlySet<string>,
  memories: readonly LoadedMemory[],
  saved: readonly SavedMemory[] = []
): Reconciled {
  const kept: string[] = [];
  const pointed = new Set<string>();
  const rewritten = new Set<string>();
  const findings: IndexFindings = {
    missing: [],
    dangling: [],
    duplicated: [],
    outdated: [],
  };
  const byFile = new Map(memories.map((loaded) => [loaded.file, loaded]));
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
      const refreshed = refreshedPointer(
        line,
        pointer,
        byFile.get(pointer.target)?.memory.frontmatter,
        saved.find(({ file }) => file === pointer.target)
      );
      if (refreshed.outdated) {
        findings.outdated.push(pointer.target);
      }
      // Not `outdated`: a pointer outside mdmem's form is rewritten without being outdated.
      if (refreshed.line !== line) {
        rewritten.add(pointer.target);
      }
      kept.push(refreshed.line);
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
  return { content, pointed, findings, rewritten };
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
  if (NAME_LINE_BREAK_RE.test(file)) {
    return problem;
  }
  return pointed.has(file)
    ? `${problem} (it keeps its pointer in ${INDEX_FILE})`
    : `${problem} (it has no pointer in ${INDEX_FILE} until it parses)`;
}

/** What a save did to its memory's pointer in the index, worded as a write reports it. */
export const INDEX_CHANGES = [
  "pointer added",
  "pointer updated",
  "unchanged",
] as const;
export type IndexChange = (typeof INDEX_CHANGES)[number];

/** What reconciling the index did to `file`'s pointer: a memory that does not parse gets none, so its index is unchanged. */
function indexChange(
  file: string,
  { findings, rewritten }: Reconciled
): IndexChange {
  if (findings.missing.includes(file)) {
    return "pointer added";
  }
  return rewritten.has(file) ? "pointer updated" : "unchanged";
}

/** An index update: its warnings, and the index as reconciled. */
interface IndexUpdate {
  warnings: string[];
  reconciled: Reconciled;
}

/** `reindex`, keeping the reconciled index for `refreshIndex` to say what became of a saved memory's pointer. */
async function updateIndex(
  store: MemoryStore,
  saved?: SavedMemory | readonly SavedMemory[]
): Promise<IndexUpdate> {
  const entries = await loadFiles(store);
  const { memories, broken } = splitLoad(entries);
  const current = await currentIndex(store);
  const files = new Set(entries.map(({ file }) => file));
  const savedList = saved === undefined ? [] : [saved].flat();
  const reconciled = reconcileIndex(current, files, memories, savedList);
  const { content, pointed } = reconciled;
  if (content !== current || !store.exists(INDEX_FILE)) {
    await store.create(INDEX_FILE, content);
  }
  const capacity = indexCapacity(content);
  return {
    warnings: [
      ...broken.map((entry) => brokenWarning(entry, pointed)),
      ...(capacity ? [capacity.message] : []),
    ],
    reconciled,
  };
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
  const { warnings } = await updateIndex(store, saved);
  return warnings;
}

/** An index refreshed after a write: its warnings, and what became of the saved memory's pointer. */
export interface IndexRefresh {
  warnings: string[];
  /** Unchanged when nothing was saved, or when the index could not be updated. */
  index: IndexChange;
}

/**
 * `reindex` after a write that already landed, also saying what became of the saved
 * memory's pointer (`IndexRefresh`): a failure becomes a warning that the index is
 * stale, worded once here so the CLI and MCP say the same thing.
 */
export async function refreshIndex(
  store: MemoryStore,
  saved?: SavedMemory
): Promise<IndexRefresh> {
  try {
    const { warnings, reconciled } = await updateIndex(store, saved);
    return {
      warnings,
      index:
        saved === undefined ? "unchanged" : indexChange(saved.file, reconciled),
    };
  } catch (error) {
    return {
      warnings: [
        `${INDEX_FILE} is stale: ${messageOf(error)} (run \`mdmem reindex\`)`,
      ],
      index: "unchanged",
    };
  }
}

/** The result of a Check: how many memory files the store holds, every problem found, and its notes. */
export interface Check {
  memoryCount: number;
  problems: string[];
  /** Findings that are not problems: a link to a memory not written yet. */
  notes: string[];
  /** Of the problems, how many memories do not parse. */
  unparseable: number;
  /** Of the problems, whether the index is stale against the memory files. */
  staleIndex: boolean;
  /** Of the problems, whether the index is over its limit. */
  indexOverLimit: boolean;
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
      `${shownFile(entry.file)}: looks like it holds a secret at ${describeSecrets(secrets)}`
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

/** A parsed memory's problem among the others: an over-long pointer. */
function memoryProblems(loaded: LoadedMemory): string[] {
  const pointerChars = [...pointerLine(pointerSource(loaded))].length;
  return pointerChars > POINTER_MAX_CHARS
    ? [
        `${loaded.file}: its pointer is ${pointerChars} characters, over ${POINTER_MAX_CHARS} — shorten its description`,
      ]
    : [];
}

/** A parsed memory's notes: each memory not written yet that it links, once, which marks one worth writing. */
function memoryNotes(
  loaded: LoadedMemory,
  known: ReadonlySet<string>
): string[] {
  return [...new Set(linkNames(loaded.memory.body))]
    .filter((name) => !known.has(name))
    .map((name) => `${loaded.file} links [[${name}]], not written yet`);
}

/** The ways the index `current` is stale against the memory files, one problem each. */
function staleIndexProblems(
  current: string,
  files: ReadonlySet<string>,
  memories: readonly LoadedMemory[]
): string[] {
  const { missing, dangling, duplicated, outdated } = reconcileIndex(
    current,
    files,
    memories
  ).findings;
  const stale = [
    ...missing.map((file) => `no pointer to ${file}`),
    ...dangling.map((file) => `a pointer to ${file}, which does not exist`),
    ...duplicated.map((file) => `more than one pointer to ${file}`),
    ...outdated.map(
      (file) =>
        `the pointer to ${file} holds a description other than the memory's`
    ),
  ];
  return stale.map(
    (finding) => `${INDEX_FILE} is stale: ${finding} — run \`mdmem reindex\``
  );
}

/** Run a Check over the store: every problem with its memories and its index, and their notes. It never writes. */
export async function checkStore(store: MemoryStore): Promise<Check> {
  const entries = await loadFiles(store);
  const { memories, broken } = splitLoad(entries);
  const files = new Set(entries.map(({ file }) => file));
  // A link resolves to a memory's name or to a memory file's name without .md.
  const known = new Set([
    ...memories.map(({ memory }) => memory.frontmatter.name),
    ...[...files].map((file) => file.slice(0, -".md".length)),
  ]);
  const current = await currentIndex(store);
  const stale = staleIndexProblems(current, files, memories);
  const capacity = indexCapacity(current);
  const indexOverLimit = capacity?.over ?? false;
  const problems = [
    ...entries.flatMap(fileProblems),
    ...memories.flatMap(memoryProblems),
    ...stale,
    ...(indexOverLimit && capacity ? [capacity.message] : []),
  ];
  return {
    memoryCount: entries.length,
    problems,
    notes: memories.flatMap((loaded) => memoryNotes(loaded, known)),
    unparseable: broken.length,
    staleIndex: stale.length > 0,
    indexOverLimit,
  };
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

function countNotes(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}

/**
 * A Check in one line, as `mdmem status` prints it: no problems, or how many, naming
 * the ones that break sharing (unparseable memories, a stale index, an index over
 * its limit), then how many notes, and where to see them all.
 */
export function checkSummary({
  problems,
  notes,
  unparseable,
  staleIndex,
  indexOverLimit,
}: Check): string {
  if (problems.length === 0) {
    if (notes.length === 0) {
      return "✓ no problems";
    }
    const them = notes.length === 1 ? "it" : "them";
    return `✓ no problems, ${countNotes(notes.length)} — \`mdmem doctor\` lists ${them}`;
  }
  const kinds = [
    ...(unparseable > 0
      ? [
          unparseable === 1
            ? "1 unparseable memory"
            : `${unparseable} unparseable memories`,
        ]
      : []),
    ...(staleIndex ? [`a stale ${INDEX_FILE}`] : []),
    ...(indexOverLimit
      ? [
          `${INDEX_FILE} over its ${INDEX_MAX_CHARS.toLocaleString("en-US")}-character limit`,
        ]
      : []),
  ];
  const among = kinds.length === 0 ? "" : `, among them ${kinds.join(", ")}`;
  const plus = notes.length === 0 ? "" : `, plus ${countNotes(notes.length)}`;
  return `${problems.length} problem(s)${among}${plus} — \`mdmem doctor\` lists them`;
}

/**
 * A Check as both surfaces print it: the problems one per line, or the memory count
 * and no problems, then a line for each note.
 */
export function formatCheck({ memoryCount, problems, notes }: Check): string {
  const head =
    problems.length === 0
      ? [`✓ ${countMemories(memoryCount)}, no problems`]
      : [
          `Found ${problems.length} problem(s):`,
          ...problems.map((problem) => `  - ${problem}`),
        ];
  return [...head, ...notes.map((note) => `note: ${note}`)].join("\n");
}
