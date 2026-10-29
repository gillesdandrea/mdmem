import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  checkStore,
  checkSummary,
  formatCheck,
  reindex,
} from "../src/core/check.ts";
import { HOOK_CONTEXT_MAX_CHARS, stdinPayload } from "../src/core/hook.ts";
import {
  claudeProjectDir,
  formatImport,
  importClaudeMemories,
  planClaudeImport,
} from "../src/core/import.ts";
import type { ImportOptions } from "../src/core/import.ts";
import { projectKey } from "../src/core/key.ts";
import { parseMemory, serializeMemory } from "../src/core/memory.ts";
import type { Memory, MemoryType } from "../src/core/memory.ts";
import type { MemoryInput } from "../src/core/operations.ts";
import {
  createStore,
  deleteDocument,
  removeMemory,
  saveMemory,
  searchMemories,
  writeDocument,
} from "../src/core/operations.ts";
import {
  getConsolidatePrompt,
  getMemoryProtocol,
  PROTOCOL_MAX_CHARS,
} from "../src/core/protocol.ts";
import { porterStem, rankDocuments } from "../src/core/search.ts";
import type { SearchDocument, SearchOptions } from "../src/core/search.ts";
import { findSecrets } from "../src/core/secrets.ts";
import { snapshotOf } from "../src/core/session.ts";
import {
  locateStore,
  MemoryStore,
  VersionConflictError,
} from "../src/core/store.ts";
import { git, gitRepo } from "./git-fixture.ts";

const sampleMemory: Memory = {
  frontmatter: {
    name: "prefers-bun",
    description: "Uses bun, not node, for this project",
    metadata: { type: "feedback" },
  },
  body: "Use bun for scripts and tests.\n\n**Why:** the project standardized on it. [[ts7-strict]]",
};

/** The frontmatter `parseMemory` reads from a file holding `frontmatter` and a body. */
function parsedFrontmatter(frontmatter: string) {
  return parseMemory(`---\n${frontmatter}\n---\nbody`).frontmatter;
}

describe("memory", () => {
  test("round-trips through serialize/parse", () => {
    const parsed = parseMemory(serializeMemory(sampleMemory));
    expect(parsed).toEqual(sampleMemory);
  });

  test("saveMemory writes frontmatter in semantic order — name, description, then type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    const store = new MemoryStore(dir);
    await saveMemory(store, {
      name: "prefers-bun",
      description: "Uses bun",
      type: "feedback",
      body: "Use bun.",
    });
    expect(await store.view("prefers-bun.md")).toStartWith(
      "---\nname: prefers-bun\ndescription: Uses bun\nmetadata:\n  type: feedback\n---\n"
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects a file with no frontmatter", () => {
    expect(() => parseMemory("just a body")).toThrow(/frontmatter/u);
  });

  test("parses a memory as loosely as Claude Code writes one", () => {
    expect(
      parsedFrontmatter("name: prefers_bun\ndescription: d\ntype: user")
    ).toEqual({
      name: "prefers_bun",
      description: "d",
      type: "user",
    });
    expect(
      parsedFrontmatter(
        "name: Prefers Bun, always\ndescription: d\nmetadata:\n  type: user"
      ).name
    ).toBe("Prefers Bun, always");
    const both = parsedFrontmatter(
      "name: n\ndescription: d\ntype: user\nmetadata:\n  type: project"
    );
    expect(
      parsedFrontmatter("name: n\ndescription: d\ntype: user\nmetadata:")
    ).toEqual({ name: "n", description: "d", type: "user", metadata: null });
    expect(both).toMatchObject({ type: "user", metadata: { type: "project" } });
    expect(
      parsedFrontmatter(
        "name: n\ndescription: d\nmodified: 2026-10-01\noriginSessionId: abc\nmetadata:\n  type: user\n  node_type: memory"
      )
    ).toEqual({
      name: "n",
      description: "d",
      modified: "2026-10-01",
      originSessionId: "abc",
      metadata: { type: "user", node_type: "memory" },
    });
  });

  test("rejects a memory with no type or an empty name", () => {
    expect(() =>
      parseMemory("---\nname: n\ndescription: d\n---\nbody")
    ).toThrow("a memory type is required");
    expect(() =>
      parseMemory('---\nname: ""\ndescription: d\ntype: user\n---\nbody')
    ).toThrow(/^name:/u);
  });

  test("rejects an unknown memory type", () => {
    const bad = serializeMemory(sampleMemory).replace("feedback", "gossip");
    expect(() => parseMemory(bad)).toThrow();
  });
});

describe("MemoryStore", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("create then view returns the content", async () => {
    await store.create("a.md", "hello");
    expect(await store.view("a.md")).toBe("hello");
  });

  test("ifVersion guard rejects a stale write — protects concurrent writers", async () => {
    await store.create("a.md", "v1");
    const stale = "000000000000";
    await expect(store.create("a.md", "v2", stale)).rejects.toBeInstanceOf(
      VersionConflictError
    );
    const fresh = await store.version("a.md");
    await store.create("a.md", "v2", fresh);
    expect(await store.view("a.md")).toBe("v2");
  });

  test("refuses to escape the store root", async () => {
    await expect(store.view("../secret")).rejects.toThrow(/escapes/u);
  });
});

/** A store whose next write to `path` is preceded by another writer's write of `rival`. */
class RacedStore extends MemoryStore {
  private readonly path: string;
  private readonly rival: string;
  private raced = false;

  constructor(root: string, path: string, rival: string) {
    super(root);
    this.path = path;
    this.rival = rival;
  }

  override async create(
    path: string,
    content: string,
    ifVersion?: string
  ): Promise<void> {
    if (path === this.path && !this.raced) {
      this.raced = true;
      await super.create(path, this.rival);
    }
    await super.create(path, content, ifVersion);
  }
}

/** A memory file's content: `name` with `description`, `type` and `body`. */
function memoryText(
  name: string,
  {
    description = `About ${name}`,
    type = "project",
    body = "b",
  }: { description?: string; type?: MemoryType; body?: string } = {}
): string {
  return serializeMemory({
    frontmatter: { name, description, metadata: { type } },
    body,
  });
}

const noteInput: MemoryInput = {
  name: "note",
  description: "A note",
  type: "project",
  body: "first",
};

describe("memory operations", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saveMemory refuses a name that already exists", async () => {
    await saveMemory(store, noteInput);
    await expect(
      saveMemory(store, { ...noteInput, body: "second" })
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.view("note.md")).toContain("first");
  });

  test("saveMemory with force overwrites an existing memory", async () => {
    await saveMemory(store, noteInput);
    await saveMemory(store, { ...noteInput, body: "second" }, { force: true });
    expect(await store.view("note.md")).toContain("second");
  });

  test("saveMemory with force refuses a memory that changed between its read and its write", async () => {
    await saveMemory(store, noteInput);
    const raced = new RacedStore(dir, "note.md", "another writer's note");
    await expect(
      saveMemory(raced, { ...noteInput, body: "second" }, { force: true })
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.view("note.md")).toBe("another writer's note");
  });

  test("removeMemory of a missing memory returns null", async () => {
    expect(await removeMemory(store, "missing")).toBeNull();
  });

  test("deleteDocument refuses a nested path, leaving the file in place", async () => {
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes/draft.md"), "hi\n");
    await expect(
      deleteDocument(
        store,
        "notes/draft.md",
        await store.version("notes/draft.md")
      )
    ).rejects.toThrow(
      'Refused "notes/draft.md": memories live at the top of the store, and nested files are never indexed or searched; use a path with no directory'
    );
    expect(await readFile(join(dir, "notes/draft.md"), "utf-8")).toBe("hi\n");
  });

  test("deleteDocument refuses a path holding a backslash as nested, leaving the file in place", async () => {
    // a legal top-level file name on POSIX, still refused as a write would refuse it
    await writeFile(join(dir, "notes\\draft.md"), "hi\n");
    await expect(
      deleteDocument(
        store,
        "notes\\draft.md",
        await store.version("notes\\draft.md")
      )
    ).rejects.toThrow(
      /^Refused "notes\\draft\.md": memories live at the top of the store/u
    );
    expect(await readFile(join(dir, "notes\\draft.md"), "utf-8")).toBe("hi\n");
  });

  test("removeMemory refuses a nested name before reading, so the file stays and a missing index stays missing", async () => {
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes/draft.md"), "hi\n");
    await expect(removeMemory(store, "notes/draft")).rejects.toThrow(
      /^Refused "notes\/draft\.md": memories live at the top of the store/u
    );
    expect(await readFile(join(dir, "notes/draft.md"), "utf-8")).toBe("hi\n");
    expect(store.exists("MEMORY.md")).toBe(false);
  });

  test("writeDocument accepts a snake_case name equal to its file, stored byte for byte with its extra fields", async () => {
    const content =
      "---\nname: uses_bun\ndescription: Uses bun\nmodified: 2026-10-01\nmetadata:\n  type: feedback\n  node_type: memory\n---\n\nUse bun.\n";
    await writeDocument(store, "uses_bun.md", content, "new");
    expect(await store.view("uses_bun.md")).toBe(content);
  });

  test("writeDocument refuses a name that differs from its file, naming the expected name", async () => {
    const content = memoryText("Uses bun, always");
    await expect(
      writeDocument(store, "uses_bun.md", content, "new")
    ).rejects.toThrow(
      'Refused "uses_bun.md": its name is "Uses bun, always", but a memory\'s name must equal its file name without .md ("uses_bun")'
    );
    expect(store.exists("uses_bun.md")).toBe(false);
  });

  test("writeDocument refuses a file name in neither kebab-case nor snake_case, before comparing the name", async () => {
    await expect(
      writeDocument(store, "My Note.md", memoryText("My Note"), "new")
    ).rejects.toThrow(
      'Refused "My Note.md": mdmem writes only memories named in kebab-case or snake_case (lowercase letters and digits, words joined by - or _), and "My Note" is neither'
    );
    await expect(
      writeDocument(store, "Foo.md", memoryText("foo"), "new")
    ).rejects.toThrow(/"Foo" is neither$/u);
  });

  // Regression test for mdmem-beh.12: memory.md opens MEMORY.md on a case-insensitive filesystem.
  test("a memory named memory is refused by save and remove, on every filesystem", async () => {
    await saveMemory(store, noteInput);
    // With the index gone, a read before the refusal would regenerate it.
    await rm(join(store.root, "MEMORY.md"));
    const named = { ...noteInput, name: "memory" };
    const indexRefusal = /^Refused "memory\.md": that is the index's path/u;
    await expect(saveMemory(store, named)).rejects.toThrow(indexRefusal);
    await expect(saveMemory(store, named, { force: true })).rejects.toThrow(
      indexRefusal
    );
    await expect(removeMemory(store, "memory")).rejects.toThrow(indexRefusal);
    expect(store.exists("MEMORY.md")).toBe(false);
    expect(await store.listFiles()).toEqual(["note.md"]);
  });
});

/** Write `count` project memories named m-0, m-1, … with `description`. */
async function seedMemories(
  store: MemoryStore,
  count: number,
  description = "d"
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      store.create(`m-${i}.md`, memoryText(`m-${i}`, { description }))
    )
  );
}

/** The problems a Check of `store` finds. */
async function problemsOf(store: MemoryStore): Promise<string[]> {
  const { problems } = await checkStore(store);
  return problems;
}

/** An index as Claude Code writes one: a title, sections, titled pointers, prose. */
const CLAUDE_INDEX = [
  "# Project memory",
  "",
  "## How we work",
  "- [Bun, not node](prefers-bun.md) — run everything with bun",
  "",
  "Prose that is not a pointer, linking [a doc](docs/guide.md).",
  "",
].join("\n");

const BROKEN_MEMORY_PROBLEM =
  "broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---`";

describe("index", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an empty store's index is empty", async () => {
    await reindex(store);
    expect(await store.view("MEMORY.md")).toBe("");
  });

  test("a write keeps a Claude-style index as it is, appending the new memory's pointer", async () => {
    await store.create("prefers-bun.md", serializeMemory(sampleMemory));
    await store.create("MEMORY.md", CLAUDE_INDEX);
    await saveMemory(store, noteInput);
    expect(await store.view("MEMORY.md")).toBe(
      `${CLAUDE_INDEX}- [note](note.md) — A note\n`
    );
  });

  test("saving a memory rewrites its pointer's description only when the description changed", async () => {
    await store.create("prefers-bun.md", serializeMemory(sampleMemory));
    await store.create("MEMORY.md", CLAUDE_INDEX);
    const { version } = await writeDocument(
      store,
      "prefers-bun.md",
      serializeMemory({ ...sampleMemory, body: "Use bun, always." }),
      await store.version("prefers-bun.md")
    );
    expect(await store.view("MEMORY.md")).toBe(CLAUDE_INDEX);

    await writeDocument(
      store,
      "prefers-bun.md",
      serializeMemory({
        ...sampleMemory,
        frontmatter: { ...sampleMemory.frontmatter, description: "Bun only" },
      }),
      version
    );
    expect(await store.view("MEMORY.md")).toBe(
      CLAUDE_INDEX.replace("— run everything with bun", "— Bun only")
    );
  });

  test("saving a memory whose pointer has no description appends one", async () => {
    await store.create("note.md", memoryText("note"));
    await store.create("MEMORY.md", "- [My note](note.md)\n");
    await saveMemory(store, noteInput, { force: true });
    expect(await store.view("MEMORY.md")).toBe(
      "- [My note](note.md) — A note\n"
    );
  });

  test("reindex refreshes the description of a pointer in mdmem's form after a direct edit, and leaves another title's or one without the separator", async () => {
    const hand = "- [hand](hand.md) - Written by hand\n";
    await store.create("note.md", memoryText("note"));
    await store.create("hand.md", memoryText("hand"));
    await store.create("prefers-bun.md", serializeMemory(sampleMemory));
    await store.create(
      "MEMORY.md",
      `- [note](note.md) — About note\n- [Bun, not node](prefers-bun.md) — run everything with bun\n${hand}`
    );
    await store.create(
      "note.md",
      memoryText("note", { description: "Edited by hand" })
    );
    await store.create(
      "prefers-bun.md",
      serializeMemory({
        ...sampleMemory,
        frontmatter: { ...sampleMemory.frontmatter, description: "Bun only" },
      })
    );
    await reindex(store);
    expect(await store.view("MEMORY.md")).toBe(
      `- [note](note.md) — Edited by hand\n- [Bun, not node](prefers-bun.md) — run everything with bun\n${hand}`
    );
    const problems = await problemsOf(store);
    expect(
      problems.filter((problem) => problem.startsWith("MEMORY.md"))
    ).toEqual([]);
  });

  test("saving a memory refreshes another memory's pointer in mdmem's form", async () => {
    await store.create("other.md", memoryText("other"));
    await store.create("MEMORY.md", "- [other](other.md) — old\n");
    await saveMemory(store, noteInput);
    expect(await store.view("MEMORY.md")).toBe(
      "- [other](other.md) — About other\n- [note](note.md) — A note\n"
    );
  });

  test("reindex drops duplicate and dangling pointers, and a delete drops the memory's pointer", async () => {
    await store.create("note.md", memoryText("note"));
    await store.create(
      "MEMORY.md",
      "# Index\n- [Note](note.md) — first\n- [gone](gone.md) — gone\n- [Note again](note.md) — second\n1. [Numbered](./note.md) — third\n"
    );
    await reindex(store);
    expect(await store.view("MEMORY.md")).toBe(
      "# Index\n- [Note](note.md) — first\n"
    );
    await removeMemory(store, "note");
    expect(await store.view("MEMORY.md")).toBe("# Index\n");
  });

  test("reindex recognizes the pointers it writes, whatever the name and file name hold", async () => {
    await store.create("bracket.md", memoryText("[WIP] thing\\ \nnext"));
    await store.create("My Note.md", memoryText("My Note"));
    await store.create("paren(x).md", memoryText("paren(x)"));
    await reindex(store);
    const index = await store.view("MEMORY.md");
    expect(index).toBe(
      [
        "- [My Note](<My Note.md>) — About My Note",
        "- [\\[WIP\\] thing\\\\ next](bracket.md) — About [WIP] thing\\ next",
        "- [paren(x)](<paren(x).md>) — About paren(x)",
        "",
      ].join("\n")
    );
    await reindex(store);
    expect(await store.view("MEMORY.md")).toBe(index);
    const problems = await problemsOf(store);
    expect(problems.filter((problem) => problem.includes("is stale"))).toEqual(
      []
    );
  });

  test("reindex keeps an index's CRLF line endings", async () => {
    await seedMemories(store, 2);
    await store.create("MEMORY.md", "# T\r\n- [M](m-0.md)\r\n");
    await saveMemory(
      store,
      { name: "m-0", description: "new", type: "project", body: "b" },
      { force: true }
    );
    expect(await store.view("MEMORY.md")).toBe(
      "# T\r\n- [M](m-0.md) — new\r\n- [m-1](m-1.md) — d\r\n"
    );
  });

  test("reindex keeps an unparseable memory's pointer, gives none to one without, and warns of both", async () => {
    await store.create("broken.md", "no frontmatter");
    await store.create("z-broken.md", "no frontmatter either");
    await store.create("MEMORY.md", "- [Broken](broken.md) — kept\n");
    expect(await reindex(store)).toEqual([
      `${BROKEN_MEMORY_PROBLEM} (it keeps its pointer in MEMORY.md)`,
      "z-broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---` (it has no pointer in MEMORY.md until it parses)",
    ]);
    expect(await store.view("MEMORY.md")).toBe(
      "- [Broken](broken.md) — kept\n"
    );
  });

  test("a memory file whose name holds a line break gets no pointer and a warning, so the index stays as it is, and is still scanned for secrets", async () => {
    await writeFile(
      join(store.root, "a\nb.md"),
      memoryText("ab", { body: `Key: AKIA${"A".repeat(16)}` }),
      "utf-8"
    );
    const warning =
      '"a\\nb.md": its file name holds a line break, so mdmem skips it and it has no pointer in MEMORY.md — rename it';
    expect(await reindex(store)).toEqual([warning]);
    expect(await reindex(store)).toEqual([warning]);
    // The bug was a save adding the file's pointer again on every write.
    const input: MemoryInput = {
      name: "c",
      description: "d",
      type: "project",
      body: "b",
    };
    await saveMemory(store, input);
    const index = await store.view("MEMORY.md");
    await saveMemory(store, input, { force: true });
    expect(await store.view("MEMORY.md")).toBe(index);
    expect(index).toBe("- [c](c.md) — d\n");
    expect(await problemsOf(store)).toEqual([
      '"a\\nb.md": looks like it holds a secret at line 8 (AWS access key)',
      warning,
    ]);
  });

  test("a store mdmem creates opens its index with a header naming the project, which saves and reindex keep; a store without one gets none", async () => {
    const project = join(dir, "project");
    const created = await createStore(
      new MemoryStore(join(dir, "home-store"), project)
    );
    const header = [
      `<!-- mdmem: this directory is the shared agent memory of the project at ${project}.`,
      "Read this index, then the memory files you need. Save with `mdmem add` or the",
      "mdmem MCP tool memory_write; after editing a file by hand run `mdmem reindex`.",
      "`mdmem status` shows whether your agent is wired, `mdmem --help` the rest. -->",
      "",
    ].join("\n");
    expect(await created.view("MEMORY.md")).toBe(header);
    const input: MemoryInput = {
      name: "c",
      description: "d",
      type: "project",
      body: "b",
    };
    await saveMemory(created, input);
    expect(await reindex(created)).toEqual([]);
    expect(await created.view("MEMORY.md")).toBe(`${header}- [c](c.md) — d\n`);
    expect(await problemsOf(created)).toEqual([]);

    // a store made by hand keeps its index as it is
    await saveMemory(store, input);
    expect(await reindex(store)).toEqual([]);
    expect(await store.view("MEMORY.md")).toBe("- [c](c.md) — d\n");
    expect(await problemsOf(store)).toEqual([]);
  });

  test("a write that brings the index near its limit warns, naming its size and the limit", async () => {
    // 60 pointers of about 147 characters, about 8,860 with their newlines: past 90% of 9,500.
    await seedMemories(store, 59, "x".repeat(127));
    const result = await saveMemory(store, {
      name: "m-59",
      description: "x".repeat(126),
      type: "project",
      body: "b",
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^MEMORY\.md is at [\d,]+ characters, near its 9,500-character limit, the size a session-start hook can inject: past it, a session-start hook cannot inject all of it\. Shorten descriptions, or merge or delete memories\.$/u
      ),
    ]);
  });

  test("search answers from the memories that parse and warns of a broken one", async () => {
    await store.create("broken.md", "no frontmatter about bun");
    await store.create(
      "uses-bun.md",
      memoryText("uses-bun", { body: "Use bun." })
    );
    await store.create(
      "uses-ts.md",
      memoryText("uses-ts", { body: "Use TS." })
    );
    expect(await searchMemories(store, "BUN")).toEqual({
      hits: [{ file: "uses-bun.md", description: "About uses-bun" }],
      warnings: [BROKEN_MEMORY_PROBLEM],
    });
  });
});

/** A document to rank: a memory named `name` with this description and body. */
function searchDoc(name: string, description: string, body: string) {
  return { file: `${name}.md`, raw: memoryText(name, { description, body }) };
}

/** Memories about nothing a search test asks for, so its words are rare enough to rank. */
const FILLERS = ["lint", "format", "release", "editor"].map((topic) =>
  searchDoc(`${topic}-notes`, `Notes on ${topic}`, `Something about ${topic}.`)
);

/** The files of the hits for `query` over `documents`, best first. */
function ranked(
  documents: SearchDocument[],
  query: string,
  options: SearchOptions = {}
): string[] {
  return rankDocuments(documents, query, { stopWords: true, ...options }).map(
    ({ document }) => document.file
  );
}

describe("search", () => {
  test("Porter stems words as the 1980 algorithm does", () => {
    const stems = {
      caresses: "caress",
      ponies: "poni",
      agreed: "agre",
      hopping: "hop",
      filing: "file",
      happy: "happi",
      relational: "relat",
      generalizations: "gener",
      configuring: "configur",
      configured: "configur",
      adjustment: "adjust",
      controll: "control",
    };
    expect(
      Object.fromEntries(
        Object.keys(stems).map((word) => [word, porterStem(word)])
      )
    ).toEqual(stems);
  });

  test("each word of the query matches on its own, and quoted words must be adjacent", () => {
    const documents = [
      searchDoc("preferred-stack", "The stack", "TypeScript, Bun and React."),
      searchDoc(
        "runtime",
        "Languages",
        "TypeScript is typed. The runtime is Bun."
      ),
      searchDoc(
        "test-status",
        "Suite",
        "The testing of the importer is now complete."
      ),
      ...FILLERS,
    ];
    // TypeScript's part "type" is no hit: frontmatter keys are not indexed (mdmem-02l.52)
    expect(ranked(documents, "TypeScript Bun")).toEqual([
      "preferred-stack.md",
      "runtime.md",
    ]);
    expect(ranked(documents, "testing complete")).toEqual(["test-status.md"]);
    expect(ranked(documents, '"TypeScript Bun"')).toEqual([
      "preferred-stack.md",
    ]);
    expect(ranked(documents, '"typescript bun"')).toEqual([
      "preferred-stack.md",
    ]);
  });

  test("a quoted phrase matches word by word across a compound in either case, and keeps its function words", () => {
    const documents = [
      searchDoc("stack", "Languages", "We use TypeScript daily."),
      searchDoc("auto-memory", "Setting", "Set autoMemoryEnabled to false."),
      searchDoc("hamlet", "A play", "To be, or not to be."),
      ...FILLERS,
    ];
    expect(ranked(documents, '"use TypeScript"')).toEqual(["stack.md"]);
    expect(ranked(documents, '"set autoMemoryEnabled"')).toEqual([
      "auto-memory.md",
    ]);
    expect(ranked(documents, '"autoMemoryEnabled to"')).toEqual([
      "auto-memory.md",
    ]);
    // a compound typed lowercase is one word, as its camelCase whole is in the text
    expect(ranked(documents, '"typescript daily"')).toEqual(["stack.md"]);
    expect(ranked(documents, '"set automemoryenabled to"')).toEqual([
      "auto-memory.md",
    ]);
    // a plain word in a phrase is a word of the text, not a part of a compound
    expect(ranked(documents, '"use script"')).toEqual([]);
    expect(ranked(documents, '"set enabled"')).toEqual([]);
    expect(ranked(documents, '"to be"')).toEqual(["hamlet.md"]);
  });

  test("a version matches in its dotted form and with its digits run together", () => {
    const documents = [
      searchDoc("release", "Claude Code", "Claude Code v2.1.306 shipped."),
      ...FILLERS,
    ];
    expect(ranked(documents, "2.1.306")).toEqual(["release.md"]);
    expect(ranked(documents, "21306")).toEqual(["release.md"]);
  });

  test("a frontmatter line that continues a value keeps its first word", () => {
    const documents = [
      {
        file: "wrapped.md",
        raw: "---\nname: wrapped\ndescription: |\n  Caveat: hooks run twice\nmetadata:\n  type: project\n---\n\nBody.\n",
      },
      ...FILLERS,
    ];
    expect(ranked(documents, "caveat")).toEqual(["wrapped.md"]);
    expect(ranked(documents, "metadata")).toEqual([]);
  });

  test("words match through stemming, the query's raw form, compounds and folded accents", () => {
    const documents = [
      searchDoc("hooks", "Hooks", "The hooks are configured once."),
      searchDoc(
        "auto-memory",
        "A Claude setting",
        "Set autoMemoryEnabled to false."
      ),
      searchDoc("cahier", "Un cahier", "Le cahier de l'élève."),
      ...FILLERS,
    ];
    expect(ranked(documents, "configuring")).toEqual(["hooks.md"]);
    // the compound is indexed whole, unstemmed: the query's raw form finds it
    expect(porterStem("automemoryenabled")).not.toBe("automemoryenabled");
    expect(ranked(documents, "automemoryenabled")).toEqual(["auto-memory.md"]);
    expect(ranked(documents, "memory enabled")).toEqual(["auto-memory.md"]);
    expect(ranked(documents, "élève")).toEqual(["cahier.md"]);
    expect(ranked(documents, "eleve")).toEqual(["cahier.md"]);
  });

  test("a match in the name or description outranks one in the body, more words outrank fewer, and function words alone match nothing", () => {
    const documents = [
      searchDoc("in-body", "Misc", "We deploy the site."),
      searchDoc("checklist", "Deploy checklist", "Run the script."),
      ...FILLERS,
    ];
    expect(ranked(documents, "deploy")).toEqual(["checklist.md", "in-body.md"]);
    const fewer = [
      searchDoc("one-word", "Misc", "We deploy the site."),
      searchDoc("two-words", "Misc", "We deploy the site on friday."),
      ...FILLERS,
    ];
    expect(ranked(fewer, "deploy friday")).toEqual([
      "two-words.md",
      "one-word.md",
    ]);
    expect(ranked(fewer, "we the on")).toEqual([]);
    expect(ranked(fewer, "le la des")).toEqual([]);
  });

  test("AI is a word to find, not a French function word (mdmem-02l.56)", () => {
    const documents = [
      searchDoc("agents", "AI agents", "Notes on AI agents."),
      ...FILLERS,
    ];
    expect(ranked(documents, "AI agents")).toEqual(["agents.md"]);
    expect(ranked(documents, "AI")).toEqual(["agents.md"]);
  });

  test("the floor and the limit drop weak and extra hits, and a search applies neither", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    const store = new MemoryStore(dir);
    const documents = Array.from({ length: 16 }, (_, i) => {
      if (i === 0) {
        return searchDoc("m-0", "Alpha beta", "Alpha beta and gamma.");
      }
      return searchDoc(
        `m-${i}`,
        "d",
        i <= 6 ? "A common word." : "Other text."
      );
    });
    await Promise.all(
      documents.map(({ file, raw }) => store.create(file, raw))
    );
    const query = "alpha beta common";
    const all = rankDocuments(documents, query);
    expect(all).toHaveLength(7);
    // 0.7 × the IDF of a term only one of the 16 memories holds
    const floor = 0.7 * Math.log((16 - 1 + 0.5) / (1 + 0.5));
    expect(rankDocuments(documents, query, { floor: true })).toEqual(
      all.filter(({ score }) => score >= floor)
    );
    expect(ranked(documents, query, { floor: true })).toEqual(["m-0.md"]);
    expect(rankDocuments(documents, query, { limit: 2 })).toEqual(
      all.slice(0, 2)
    );
    expect(rankDocuments(documents, query, { limit: -1 })).toEqual([]);
    // a one-term hit is under the floor, and a search still lists it
    expect(ranked(documents, "common", { floor: true })).toEqual([]);
    const { hits } = await searchMemories(store, "common");
    expect(hits.map(({ file }) => file)).toEqual(ranked(documents, "common"));
    expect(hits).toHaveLength(6);
    await rm(dir, { recursive: true, force: true });
  });
});

const FAKE_AWS_KEY = `AKIA${"A".repeat(16)}`;

describe("check", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a clean store has no problems, and its check says how many memories it holds", async () => {
    await seedMemories(store, 2);
    await reindex(store);
    const check = await checkStore(store);
    expect(check).toEqual({
      memoryCount: 2,
      problems: [],
      notes: [],
      unparseable: 0,
      staleIndex: false,
      indexOverLimit: false,
    });
    expect(formatCheck(check)).toBe("✓ 2 memories, no problems");
    expect(checkSummary(check)).toBe("✓ no problems");
  });

  test("reports an unparseable memory", async () => {
    await seedMemories(store, 1);
    await reindex(store);
    await store.create("broken.md", "no frontmatter");
    const check = await checkStore(store);
    expect(check).toEqual({
      memoryCount: 2,
      problems: [BROKEN_MEMORY_PROBLEM],
      notes: [],
      unparseable: 1,
      staleIndex: false,
      indexOverLimit: false,
    });
    expect(formatCheck(check)).toBe(
      `Found 1 problem(s):\n  - ${BROKEN_MEMORY_PROBLEM}`
    );
    expect(checkSummary(check)).toBe(
      "1 problem(s), among them 1 unparseable memory — `mdmem doctor` lists them"
    );
  });

  test("reports a memory whose name differs from its file name", async () => {
    await store.create("note.md", memoryText("other-note"));
    await reindex(store);
    expect(await problemsOf(store)).toEqual([
      'note.md: name "other-note" ≠ filename',
    ]);
  });

  test("reports a memory whose two types differ", async () => {
    await store.create(
      "note.md",
      "---\nname: note\ndescription: d\ntype: user\nmetadata:\n  type: project\n---\nb\n"
    );
    await reindex(store);
    expect(await problemsOf(store)).toEqual([
      'note.md: metadata.type "project" ≠ type "user" — metadata.type wins; remove one',
    ]);
  });

  test("reports a memory that holds a secret, by line and kind, never the secret", async () => {
    await store.create(
      "aws.md",
      memoryText("aws", { body: `Key: ${FAKE_AWS_KEY}` })
    );
    await reindex(store);
    expect(await problemsOf(store)).toEqual([
      "aws.md: looks like it holds a secret at line 8 (AWS access key)",
    ]);
  });

  test("reports a pointer over 150 characters, naming its memory", async () => {
    await seedMemories(store, 1, "x".repeat(140));
    await reindex(store);
    expect(await problemsOf(store)).toEqual([
      "m-0.md: its pointer is 158 characters, over 150 — shorten its description",
    ]);
  });

  test("notes a link that matches neither a memory's name nor a file name as a memory not written yet, not a problem", async () => {
    await store.create("free.md", memoryText("Free-text name"));
    await store.create(
      "note.md",
      memoryText("note", {
        body: "See [[free]] and [[gone_too]], then [[gone_too]] again.",
      })
    );
    await reindex(store);
    const check = await checkStore(store);
    expect(check.problems).toEqual([
      'free.md: name "Free-text name" ≠ filename',
    ]);
    expect(check.notes).toEqual([
      "note.md links [[gone_too]], not written yet",
    ]);
    expect(formatCheck(check)).toBe(
      'Found 1 problem(s):\n  - free.md: name "Free-text name" ≠ filename\nnote: note.md links [[gone_too]], not written yet'
    );
    expect(checkSummary(check)).toBe(
      "1 problem(s), plus 1 note — `mdmem doctor` lists them"
    );
    await store.remove("free.md");
    await reindex(store);
    const notesOnly = await checkStore(store);
    expect(formatCheck(notesOnly)).toBe(
      "✓ 1 memory, no problems\nnote: note.md links [[free]], not written yet\nnote: note.md links [[gone_too]], not written yet"
    );
    expect(checkSummary(notesOnly)).toBe(
      "✓ no problems, 2 notes — `mdmem doctor` lists them"
    );
  });

  test("reports a memory without a pointer, a pointer to a missing file and a duplicate pointer", async () => {
    await seedMemories(store, 2);
    await store.create(
      "MEMORY.md",
      "- [m-0](m-0.md) — d\n- [gone](gone.md) — d\n- [again](m-0.md) — d\n"
    );
    expect(await problemsOf(store)).toEqual([
      "MEMORY.md is stale: no pointer to m-1.md — run `mdmem reindex`",
      "MEMORY.md is stale: a pointer to gone.md, which does not exist — run `mdmem reindex`",
      "MEMORY.md is stale: more than one pointer to m-0.md — run `mdmem reindex`",
    ]);
    expect(checkSummary(await checkStore(store))).toBe(
      "3 problem(s), among them a stale MEMORY.md — `mdmem doctor` lists them"
    );
    await reindex(store);
    expect(await problemsOf(store)).toEqual([]);
  });

  test("reports a pointer titled with its memory's name whose description differs from the memory's, until reindex", async () => {
    await seedMemories(store, 1);
    await store.create("MEMORY.md", "- [m-0](m-0.md) — old\n");
    expect(await problemsOf(store)).toEqual([
      "MEMORY.md is stale: the pointer to m-0.md holds a description other than the memory's — run `mdmem reindex`",
    ]);
    await reindex(store);
    expect(await problemsOf(store)).toEqual([]);
  });

  test("reports an index over 9,500 characters, and none just under", async () => {
    await seedMemories(store, 1);
    await reindex(store);
    const index = await store.view("MEMORY.md");
    const prose = (chars: number) =>
      `${"p".repeat(chars - [...index].length - 1)}\n`;
    await store.create("MEMORY.md", `${index}${prose(9500)}`);
    expect(await problemsOf(store)).toEqual([]);
    await store.create("MEMORY.md", `${index}${prose(9501)}`);
    const check = await checkStore(store);
    expect(checkSummary(check)).toBe(
      "1 problem(s), among them MEMORY.md over its 9,500-character limit — `mdmem doctor` lists them"
    );
    expect(check.problems).toEqual([
      "MEMORY.md is at 9,501 characters, over its 9,500-character limit, the size a session-start hook can inject: a session-start hook cannot inject all of it. Shorten descriptions, or merge or delete memories.",
    ]);
  });
});

/** A home store path as long as a deep project's: the protocol names it, and still fits its cap. */
const LONG_STORE = `/Users/someone/.mdmem/${"-very-long-project-path".repeat(9)}`;

describe("templates", () => {
  test("the memory protocol renders every placeholder and stays under one hook entry's cap", () => {
    const protocol = getMemoryProtocol(LONG_STORE);
    expect(protocol).not.toContain("{{");
    expect(protocol).toContain("9,500 characters");
    expect([...protocol].length).toBeLessThan(HOOK_CONTEXT_MAX_CHARS);
  });

  test("the memory protocol stays within its cap, about three times Claude Code's memory block, and keeps its rules", () => {
    const protocol = getMemoryProtocol(LONG_STORE);
    expect([...protocol].length).toBeLessThanOrEqual(PROTOCOL_MAX_CHARS);
    for (const needle of [
      "memory_list",
      "memory_search",
      "memory_check",
      "memory_read",
      "memory_write",
      "memory_delete",
      "`if_version` set to `new`",
      "`user`",
      "`feedback`",
      "`project`",
      "`reference`",
      "`MEMORY.md` is the index",
      "never write it",
      "`mdmem reindex`",
      "returns the current content and version",
    ]) {
      expect(protocol).toContain(needle);
    }
  });

  test.each([
    [
      "check a memory's claim about an external tool",
      "Check a claim it makes about an external tool, library or service before acting on it or repeating it, since a memory records what was believed when it was written.",
    ],
    [
      "load the mdmem tools in one request",
      "If your harness loads tools on demand, load every mdmem tool in one request.",
    ],
    [
      "name the memory an answer comes from",
      "When an answer comes from a memory, name that memory's path in the store, so the user can open or correct it.",
    ],
    [
      "keep project knowledge in the store, and the harness's memory under its own rules",
      "The store is the primary place for what the user wants, what is known about the project and how to work in it, saved without waiting to be asked; a memory your harness keeps of its own holds what is about you and your sessions, under that harness's own rules for when to update it.",
    ],
    [
      "put current instructions and verified facts first, then the store over the harness's memory",
      "The user's current instructions and verified facts take precedence over any memory; on anything about the project, the store takes precedence over older notes in your harness's memory.",
    ],
    [
      "expect the changed-on-disk notice after a memory_write",
      "After your own `memory_write`, your harness may report that a file in the store changed on disk: that is the write you just made, not another edit, and needs no re-read.",
    ],
    [
      "write in the store's directory without the tools, and tell the user when a home store is out of reach",
      "Without the mdmem tools, write `<name>.md` in `/home/u/.mdmem/-p` directly, then run `mdmem reindex`; delete with `mdmem delete <name>`. A home store, under `~/.mdmem/`, lies outside the project: a sandboxed agent may not reach it without the tools, so tell the user when you cannot save there.",
    ],
  ])("the memory protocol says to %s", (_behavior, sentence) => {
    // The template is hard-wrapped, so compare sentences across its line breaks.
    expect(
      getMemoryProtocol("/home/u/.mdmem/-p").replaceAll("\n", " ")
    ).toContain(sentence);
  });

  test("the consolidation prompt renders with no leftover placeholder", () => {
    const prompt = getConsolidatePrompt("/project/.mdmem");
    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("Memory store: `/project/.mdmem`\n\n");
    expect(prompt).not.toContain("second store");
  });

  test("the consolidation prompt with a second store says to merge it in, then delete it", () => {
    const prompt = getConsolidatePrompt(
      "/project/.mdmem",
      undefined,
      "/home/u/.mdmem/-project"
    );
    expect(prompt).toContain(
      "Memory store: `/project/.mdmem`\n\nA second store to fold in: `/home/u/.mdmem/-project`. Read each of its memories and merge it into the memory store above, as Phase 3 merges new signal; once every one is merged, delete that store's directory, or ask the user to.\n"
    );
  });
});

describe("hook", () => {
  test("a terminal on stdin is no payload, and the hook never reads it", async () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve("{}");
    };
    expect(await stdinPayload(true, read)).toBe("");
    expect(reads).toBe(0);
    expect(await stdinPayload(undefined, read)).toBe("{}");
    expect(reads).toBe(1);
  });

  test("a snapshot leaves out a memory removed after the store listed it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdmem-"));
    try {
      const store = new MemoryStore(dir);
      await store.create("kept.md", "x");
      // a concurrent memory_delete between listing and reading
      store.listFiles = () => Promise.resolve(["gone.md", "kept.md"]);
      expect(Object.keys(await snapshotOf(store))).toEqual(["kept.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("secrets", () => {
  test("finds a secret assigned to a prefixed, env-style key", () => {
    const text = [
      ["DB_PASSWORD=", "hunter2", "hunter2"].join(""),
      ["GITHUB_TOKEN=", "abcdef", "123456"].join(""),
      ["AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI", "K7MDENG"].join(""),
    ].join("\n");
    expect(findSecrets(text)).toEqual([
      { line: 1, kind: "secret in an assignment" },
      { line: 2, kind: "secret in an assignment" },
      { line: 3, kind: "secret in an assignment" },
    ]);
  });
  test("leaves paths and hyphenated sk- words alone", () => {
    const text = [
      ["Run from repo root (pwd", ": /Users/me/dev)"].join(""),
      "Use sk-learn-compatible-estimators everywhere",
    ].join("\n");
    expect(findSecrets(text)).toEqual([]);
  });
});

/** Setting up nested submodules spawns many git processes; give it room past bun's 5s default. */
const NESTED_SUBMODULE_TIMEOUT_MS = 20_000;

describe("location", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-loc-")));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Make the directory `parts` under the temp dir and return its path. */
  async function dir(...parts: string[]): Promise<string> {
    const path = join(tmp, ...parts);
    await mkdir(path, { recursive: true });
    return path;
  }

  test("a checkout, its linked worktrees and subdirectories share one store, the home store until a local one exists", async () => {
    const home = await dir("home");
    const repo = await dir("repo");
    await gitRepo(repo);
    git(repo, "worktree", "add", "-q", join(tmp, "wt"), "-b", "wt");
    const deep = await dir("repo", "pkg", "deep");
    // a .mdmem below the root is not the project's
    await dir("repo", "pkg", ".mdmem");
    const homeStore = join(home, ".mdmem", projectKey(repo));
    const starts = [repo, join(tmp, "wt"), deep];

    for (const start of starts) {
      expect(locateStore(start, home)).toEqual({
        root: repo,
        dir: homeStore,
        placement: "home",
        exists: false,
        local: join(repo, ".mdmem"),
        home: homeStore,
      });
    }
    await mkdir(homeStore, { recursive: true });
    for (const start of starts) {
      expect(locateStore(start, home)).toMatchObject({
        dir: homeStore,
        placement: "home",
        exists: true,
      });
    }
    await dir("repo", ".mdmem");
    for (const start of starts) {
      expect(locateStore(start, home)).toMatchObject({
        root: repo,
        dir: join(repo, ".mdmem"),
        placement: "local",
        exists: true,
        home: homeStore,
      });
    }
  });

  test("the home store's key is the one the import reads Claude Code's project directory by", async () => {
    const home = await dir("home");
    const root = await dir("my project_1.x");
    const { home: homeStore } = locateStore(root, home);
    expect(basename(homeStore)).toBe(
      basename(claudeProjectDir(root, { env: {}, home }))
    );
    expect(basename(homeStore)).toBe(projectKey(root));
  });

  test(
    "a submodule, nested or not, uses its outermost superproject's store",
    async () => {
      const inner = await dir("inner");
      await gitRepo(inner);
      const child = await dir("child");
      await gitRepo(child);
      git(child, "submodule", "-q", "add", inner, "inner");
      git(child, "commit", "-q", "-m", "add inner");
      const repo = await dir("repo");
      await gitRepo(repo);
      git(repo, "submodule", "-q", "add", child, "mod");
      git(repo, "submodule", "-q", "update", "--init", "--recursive");
      const inMod = await dir("repo", "mod", "src");

      for (const start of [
        join(repo, "mod"),
        inMod,
        join(repo, "mod", "inner"),
      ]) {
        expect(locateStore(start).root).toBe(repo);
      }
    },
    NESTED_SUBMODULE_TIMEOUT_MS
  );

  test("a bare repository at <dir>/.git keys <dir>, a bare x.git keys itself", async () => {
    const repo = await dir("repo");
    await gitRepo(repo);
    const outer = await dir("outer");
    git(tmp, "clone", "-q", "--bare", repo, join(outer, ".git"));
    git(
      join(outer, ".git"),
      "worktree",
      "add",
      "-q",
      join(outer, "w1"),
      "main"
    );
    git(tmp, "clone", "-q", "--bare", repo, join(tmp, "x.git"));

    expect(locateStore(join(outer, "w1")).root).toBe(outer);
    expect(locateStore(outer).root).toBe(outer);
    expect(locateStore(join(tmp, "x.git")).root).toBe(join(tmp, "x.git"));
  });

  test("without git, the working directory is the project, with no walk-up: two siblings get two home stores", async () => {
    const home = await dir("home");
    // a local store above the working directory is another project's
    await dir("proj", ".mdmem");
    const a = await dir("proj", "a");
    const b = await dir("proj", "b");

    const [inA, inB] = [locateStore(a, home), locateStore(b, home)];
    expect(inA).toEqual({
      root: a,
      dir: join(home, ".mdmem", projectKey(a)),
      placement: "home",
      exists: false,
      local: join(a, ".mdmem"),
      home: join(home, ".mdmem", projectKey(a)),
    });
    expect(inB.root).toBe(b);
    expect(inB.dir).not.toBe(inA.dir);
    await dir("proj", "a", ".mdmem");
    expect(locateStore(a, home)).toMatchObject({
      dir: join(a, ".mdmem"),
      placement: "local",
    });
  });

  test("in the home directory, ~/.mdmem holds the home stores and is never a local store", async () => {
    const home = await dir("home");
    await dir("home", ".mdmem", "-some-project");

    expect(locateStore(home, home)).toMatchObject({
      root: home,
      dir: join(home, ".mdmem", projectKey(home)),
      placement: "home",
      exists: false,
    });
  });
});

// A recorded fixture: the keys Claude Code 2.1.302 gave these paths in a real
// `claude -p` run, made where that run happened. The assertions are pure functions
// of the strings, so no such directory is needed; the long keys' hashes depend on
// the whole path, which is why the paths are kept as they were.
const PROBE_DIR =
  "/private/tmp/claude-501/-Users-gilles-dev-gillesdandrea-mdmem/d3ecf71b-9e90-4787-a0b7-1df9538cf0b6/scratchpad";
const PROBE_KEY =
  "-private-tmp-claude-501--Users-gilles-dev-gillesdandrea-mdmem-d3ecf71b-9e90-4787-a0b7-1df9538cf0b6-scratchpad";

function claudeMemoryText(
  name: string,
  description: string,
  extra = ""
): string {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project${extra}\n---\n\nBody of ${name}.\n`;
}

async function put(dir: string, file: string, content: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, "utf-8");
}

/** Every file directly in `dir`, by name, with its content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files = await readdir(dir);
  const sorted = files.toSorted();
  const contents = await Promise.all(
    sorted.map((file) => readFile(join(dir, file), "utf-8"))
  );
  return Object.fromEntries(sorted.map((file, i) => [file, contents[i] ?? ""]));
}

describe("import from Claude Code", () => {
  let tmp = "";
  let repo = "";
  let home = "";
  let store: MemoryStore;
  let options: ImportOptions;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "mdmem-import-")));
    repo = join(tmp, "repo");
    home = join(tmp, "home");
    await mkdir(repo);
    await gitRepo(repo);
    store = new MemoryStore(join(repo, ".mdmem"));
    await reindex(store);
    options = { home, env: {} };
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** The Claude memory directory of `path`'s key under the temp home. */
  function claudeDir(path = repo): string {
    return join(home, ".claude", "projects", projectKey(path), "memory");
  }

  test("the key mirrors Claude Code's encoding, and the environment can override the directory and the key", () => {
    expect(projectKey("/private/tmp/x/main")).toBe("-private-tmp-x-main");
    expect(projectKey("/srv/repos/bare.git")).toBe("-srv-repos-bare-git");
    expect(projectKey(`${PROBE_DIR}/key probe_a.b~c+d@e(f)#é`)).toBe(
      `${PROBE_KEY}-key-probe-a-b-c-d-e-f---`
    );
    expect(projectKey(`${PROBE_DIR}/emo😀x`)).toBe(`${PROBE_KEY}-emo--x`);
    // Over 200 characters: cut, then a hash, positive and negative before Math.abs.
    expect(
      projectKey(`${PROBE_DIR}/longprobe/${"a".repeat(124)}/${"b".repeat(44)}`)
    ).toBe(`${PROBE_KEY}-longprobe-${"a".repeat(80)}-xi76tx`);
    expect(projectKey(`${PROBE_DIR}/longneg0/${"c".repeat(150)}`)).toBe(
      `${PROBE_KEY}-longneg0-${"c".repeat(81)}-tpx2ye`
    );

    expect(claudeProjectDir("/w/p", { home: "/h", env: {} })).toBe(
      "/h/.claude/projects/-w-p"
    );
    expect(
      claudeProjectDir("/w/p", {
        home: "/h",
        env: {
          CLAUDE_CONFIG_DIR: "/cfg",
          CLAUDE_CODE_PROJECT_DIR_NAME: "mine",
        },
      })
    ).toBe("/cfg/projects/mine");
  });

  test("copies files found only in Claude's directory, as they are, and keeps identical ones once, ignoring Claude's modified stamp", async () => {
    expect(await importClaudeMemories(store, options)).toMatchObject({
      sources: [],
      copied: [],
    });

    await store.create("shared.md", claudeMemoryText("shared", "Both have it"));
    await put(
      claudeDir(),
      "shared.md",
      claudeMemoryText(
        "shared",
        "Both have it",
        "\n  modified: 2026-10-03T21:25:42.279Z"
      )
    );
    const loose = claudeMemoryText("Loose Name", "Breaks the write rules");
    await put(claudeDir(), "Loose Name.md", loose);

    const result = await importClaudeMemories(store, options);

    expect(result.copied).toEqual([
      { file: "Loose Name.md", from: claudeDir() },
    ]);
    expect(result.collapsed).toEqual(["shared.md"]);
    expect(result.merged).toBe(true);
    expect(await store.view("Loose Name.md")).toBe(loose);
    expect(await store.view("shared.md")).toBe(
      claudeMemoryText("shared", "Both have it")
    );
  });

  test("rewrites a copied memory's name to its file name and reports it, leaving the index's title and a memory that does not parse as they are", async () => {
    const lead = claudeMemoryText("Team Lead", "Leads the team");
    await put(claudeDir(), "team-lead.md", lead);
    await put(claudeDir(), "2024.md", claudeMemoryText("Year", "The year"));
    await put(claudeDir(), "broken.md", "No frontmatter here.\n");
    await put(
      claudeDir(),
      "MEMORY.md",
      "- [Team Lead](team-lead.md) — Leads the team\n"
    );

    const result = await importClaudeMemories(store, options);

    expect(result.renamed).toEqual([
      { file: "2024.md", from: claudeDir(), name: "Year" },
      { file: "team-lead.md", from: claudeDir(), name: "Team Lead" },
    ]);
    expect(await store.view("team-lead.md")).toBe(
      lead.replace("name: Team Lead", "name: team-lead")
    );
    // A name YAML would read as a number is quoted.
    expect(await store.view("2024.md")).toContain('\nname: "2024"\n');
    expect(await store.view("broken.md")).toBe("No frontmatter here.\n");
    expect(await store.view("MEMORY.md")).toContain(
      "- [Team Lead](team-lead.md) — Leads the team\n"
    );
    expect(formatImport(result)).toContain("Renamed to match the file name:");
    expect(formatImport(result)).toContain(
      '    team-lead.md (was "Team Lead")'
    );
  });

  test("of same-name files with different content, keeps the store's and reports Claude's as left behind, its pointer not taken", async () => {
    await store.create("a.md", claudeMemoryText("a", "Store's a"));
    await store.create("MEMORY.md", "");
    await put(claudeDir(), "a.md", claudeMemoryText("a", "Claude's a"));
    // The same file on a filesystem that ignores case.
    await put(claudeDir(), "MEMORY.md", "- [A](a.md) — Claude's pointer\n");

    const result = await importClaudeMemories(store, options);

    expect(result.copied).toEqual([]);
    expect(result.leftBehind).toEqual([{ file: "a.md", from: claudeDir() }]);
    expect(await store.view("a.md")).toBe(claudeMemoryText("a", "Store's a"));
    // Claude's pointer describes Claude's version, so a kept file does not take it.
    expect(await store.view("MEMORY.md")).toBe("");
    expect(formatImport(result)).toEqual([
      "Nothing to import: the store keeps its own version of every file that differs.",
      "Other versions, not imported, left in Claude's directories:",
      `    a.md (from ${claudeDir()})`,
      "These directories can be deleted once you no longer need the versions not imported, which are nowhere else:",
      `    ${claudeDir()}`,
    ]);
    expect(await readdir(dirname(claudeDir()))).toEqual(["memory"]);
  });

  test("folds in a worktree's own Claude key; of two keys that disagree, the repository's is copied and the worktree's left behind", async () => {
    const worktree = join(tmp, "wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "wt");
    await put(claudeDir(), "a.md", claudeMemoryText("a", "From the key"));
    await put(
      claudeDir(worktree),
      "b.md",
      claudeMemoryText("b", "From the worktree")
    );
    await put(claudeDir(), "c.md", claudeMemoryText("c", "One"));
    await put(claudeDir(worktree), "c.md", claudeMemoryText("c", "Two"));

    const result = await importClaudeMemories(store, options);

    expect(result.sources).toEqual([claudeDir(), claudeDir(worktree)]);
    expect(result.copied).toEqual([
      { file: "a.md", from: claudeDir() },
      { file: "b.md", from: claudeDir(worktree) },
      { file: "c.md", from: claudeDir() },
    ]);
    expect(result.leftBehind).toEqual([
      { file: "c.md", from: claudeDir(worktree) },
    ]);
    expect(await store.view("c.md")).toBe(claudeMemoryText("c", "One"));
    expect(formatImport(result)).toContain(`    ${claudeDir(worktree)}`);
  });

  test("a store that does not exist yet when the import is planned gets no backup", async () => {
    const fresh = new MemoryStore(join(tmp, "fresh", ".mdmem"));
    await mkdir(dirname(fresh.root));
    await put(
      join(
        home,
        ".claude",
        "projects",
        projectKey(dirname(fresh.root)),
        "memory"
      ),
      "a.md",
      claudeMemoryText("a", "A")
    );
    const write = await planClaudeImport(fresh, options);
    await reindex(fresh);
    const result = await write();
    expect(result.backup).toBeUndefined();
    expect(fresh.exists("a.md")).toBe(true);
    expect(formatImport(result)[0]).toBe("Copied into the store:");
  });

  test("honours CLAUDE_CONFIG_DIR and CLAUDE_CODE_PROJECT_DIR_NAME for the sources and the backup", async () => {
    await store.create("mine.md", claudeMemoryText("mine", "Mine"));
    const config = join(tmp, "config");
    const named = join(config, "projects", "named", "memory");
    await put(named, "a.md", claudeMemoryText("a", "From the named key"));
    // Ignored: the home directory's ~/.claude is not where Claude Code keeps it.
    await put(claudeDir(), "b.md", claudeMemoryText("b", "Under the home"));

    const result = await importClaudeMemories(store, {
      ...options,
      env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "named" },
      now: new Date("2026-10-17T16:45:03.123Z"),
    });

    expect(result.sources).toEqual([named]);
    expect(result.copied).toEqual([{ file: "a.md", from: named }]);
    expect(result.backup).toBe(
      join(dirname(named), "mdmem-backup-2026-10-17T16-45-03-123Z", "mdmem")
    );
    expect(store.exists("b.md")).toBe(false);
  });

  test("reads the key of the store's real path when it is reached through a symlink", async () => {
    const link = join(tmp, "link");
    await symlink(repo, link);
    await put(claudeDir(), "a.md", claudeMemoryText("a", "At the real key"));

    const result = await importClaudeMemories(
      new MemoryStore(join(link, ".mdmem")),
      options
    );

    expect(result.copied).toEqual([{ file: "a.md", from: claudeDir() }]);
  });

  test("reports what it leaves in Claude's directories and the secrets it copies", async () => {
    await put(claudeDir(), "notes.txt", "Not a memory");
    const empty = await importClaudeMemories(store, options);
    expect(formatImport(empty)).toEqual([
      "No Claude Code memories for this project: nothing to import.",
      "Not memory files, left in Claude's directories:",
      `    notes.txt (from ${claudeDir()})`,
    ]);

    await put(
      claudeDir(),
      "key.md",
      claudeMemoryText("key", "Holds a key").replace(
        "Body of key.",
        ["api_key = ", "abcdef", "123456"].join("")
      )
    );
    const result = await importClaudeMemories(store, options);

    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^key\.md: imported unredacted, .* secret at line 8/u
      ),
    ]);
    expect(formatImport(result)).toContain(
      "These directories can be deleted once you no longer need the entries left in them, which are nowhere else:"
    );
  });

  test("the index keeps the store's lines and gains Claude's pointer lines, reconciled", async () => {
    await store.create("mine.md", claudeMemoryText("mine", "Mine"));
    await store.create("MEMORY.md", "# Mine\n\n- [My title](mine.md) — mine\n");
    await put(claudeDir(), "theirs.md", claudeMemoryText("theirs", "Theirs"));
    await put(
      claudeDir(),
      "bare.md",
      claudeMemoryText("bare", "No pointer in Claude's index")
    );
    await put(
      claudeDir(),
      "MEMORY.md",
      "# Claude\n- [Their title](theirs.md) — their hook\n- [Gone](gone.md) — dangling\n- [Dup](mine.md) — theirs\n"
    );

    await importClaudeMemories(store, options);

    expect(await store.view("MEMORY.md")).toBe(
      "# Mine\n\n- [My title](mine.md) — mine\n- [Their title](theirs.md) — their hook\n- [bare](bare.md) — No pointer in Claude's index\n"
    );
  });

  test("backs the store up first, never changes Claude's directory, and a second run does nothing", async () => {
    await store.create("mine.md", claudeMemoryText("mine", "Mine"));
    await reindex(store);
    const original = await snapshot(store.root);
    await put(claudeDir(), "theirs.md", claudeMemoryText("theirs", "Theirs"));
    await put(claudeDir(), "MEMORY.md", "- [theirs](theirs.md) — Theirs\n");
    const claudeBefore = await snapshot(claudeDir());

    const first = await importClaudeMemories(store, {
      ...options,
      now: new Date("2026-10-17T16:45:03.123Z"),
    });

    expect(first.backup).toBe(
      join(
        dirname(claudeDir()),
        "mdmem-backup-2026-10-17T16-45-03-123Z",
        "mdmem"
      )
    );
    expect(await snapshot(first.backup ?? "")).toEqual(original);
    expect(await snapshot(claudeDir())).toEqual(claudeBefore);
    const imported = await snapshot(store.root);

    const second = await importClaudeMemories(store, options);

    expect(second.copied).toEqual([]);
    expect(second.backup).toBeUndefined();
    expect(await snapshot(store.root)).toEqual(imported);
    expect(formatImport(second)[0]).toContain("nothing to import");
    expect(await readdir(dirname(claudeDir()))).toHaveLength(2);
  });
});
