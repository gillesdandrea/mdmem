import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFact, serializeFact } from "../src/core/fact.ts";
import type { Fact } from "../src/core/fact.ts";
import { reindex, renderIndex } from "../src/core/index.ts";
import { saveFact } from "../src/core/operations.ts";
import {
  findProjectRoot,
  findStoreRoot,
  MemoryStore,
  VersionConflictError,
} from "../src/core/store.ts";

const sampleFact: Fact = {
  frontmatter: {
    name: "prefers-bun",
    description: "Uses bun, not node, for this project",
    metadata: { type: "feedback" },
  },
  body: "Use bun for scripts and tests.\n\n**Why:** the project standardized on it. [[ts7-strict]]",
};

describe("fact", () => {
  test("round-trips through serialize/parse", () => {
    const parsed = parseFact(serializeFact(sampleFact));
    expect(parsed).toEqual(sampleFact);
  });

  test("saveFact writes frontmatter in semantic order — name, description, then type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memcli-"));
    const store = new MemoryStore(dir);
    await saveFact(store, {
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
    expect(() => parseFact("just a body")).toThrow(/frontmatter/u);
  });

  test("rejects a non-kebab-case name — the filename derives from it", () => {
    const bad = serializeFact(sampleFact).replace("prefers-bun", "Prefers Bun");
    expect(() => parseFact(bad)).toThrow();
  });

  test("rejects an unknown memory type — types drive the index sections", () => {
    const bad = serializeFact(sampleFact).replace("feedback", "gossip");
    expect(() => parseFact(bad)).toThrow();
  });
});

describe("MemoryStore", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memcli-"));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("create then view returns the content", async () => {
    await store.create("a.md", "hello");
    expect(await store.view("a.md")).toBe("hello");
  });

  test("strReplace refuses a non-unique match, so edits can't hit the wrong line", async () => {
    await store.create("a.md", "x\nx\n");
    await expect(store.strReplace("a.md", "x", "y")).rejects.toThrow(
      /not unique/u
    );
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

  test("listFacts excludes the generated index", async () => {
    await store.create("one.md", "1");
    await store.create("MEMORY.md", "index");
    expect(await store.listFacts()).toEqual(["one.md"]);
  });
});

describe("index", () => {
  test("renderIndex groups by type in fixed order and omits the index file", () => {
    const out = renderIndex([
      {
        file: "z-fact.md",
        frontmatter: {
          name: "z-fact",
          description: "z",
          metadata: { type: "reference" },
        },
      },
      {
        file: "a-fact.md",
        frontmatter: {
          name: "a-fact",
          description: "a",
          metadata: { type: "user" },
        },
      },
    ]);
    expect(out).toContain("## User");
    expect(out).toContain("## Reference");
    // user section precedes reference section
    expect(out.indexOf("## User")).toBeLessThan(out.indexOf("## Reference"));
    expect(out).toContain("- [a-fact](a-fact.md) — a");
  });

  test("empty store renders a placeholder, not an empty file", () => {
    expect(renderIndex([])).toContain("_No memories yet._");
  });

  test("reindex names a broken fact and its problem in one line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memcli-"));
    const store = new MemoryStore(dir);
    const bad = serializeFact(sampleFact).replace("prefers-bun", "Prefers Bun");
    await store.create("prefers-bun.md", bad);
    await expect(reindex(store)).rejects.toThrow(
      /^prefers-bun\.md: unparseable — name: name must be kebab-case/u
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("reindex writes MEMORY.md derived from fact frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memcli-"));
    const store = new MemoryStore(dir);
    await store.create("prefers-bun.md", serializeFact(sampleFact));
    await reindex(store);
    const index = await store.view("MEMORY.md");
    expect(index).toContain("## Feedback");
    expect(index).toContain("[prefers-bun](prefers-bun.md)");
    // the index never lists itself
    expect(index).not.toContain("[MEMORY]");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("location", () => {
  test("findStoreRoot walks up to an existing .memory, else null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memcli-"));
    expect(findStoreRoot(dir)).toBeNull();
    const store = new MemoryStore(join(dir, ".memory"));
    await store.create("x.md", "x");
    const nested = join(dir, "a", "b");
    expect(findStoreRoot(nested)).toBe(join(dir, ".memory"));
    // mkdtemp dir has no marker -> itself
    expect(findProjectRoot(dir)).toBe(dir);
    await rm(dir, { recursive: true, force: true });
  });
});
