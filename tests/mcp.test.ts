import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { reindex } from "../src/core/index.ts";
import { serializeMemory } from "../src/core/memory.ts";
import { STORE_PAGE_SIZE } from "../src/core/operations.ts";
import { MemoryStore } from "../src/core/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const NEXT_CURSOR_RE = /next cursor: (?<cursor>\S+)/u;

interface Session {
  client: Client;
  store: MemoryStore;
  /** The id mdmem gives the project's store: the project directory's name. */
  storeId: string;
}

/** Run `fn` against an mdmem MCP server started in a fresh project with an empty store. */
async function withServer(fn: (session: Session) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mdmem-mcp-"));
  const store = new MemoryStore(join(dir, ".memory"));
  // empty store so the server's findStoreRoot succeeds
  await reindex(store);
  const transport = new StdioClientTransport({
    command: "bun",
    args: [CLI, "mcp"],
    cwd: dir,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await fn({ client, store, storeId: basename(dir) });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");
}

/** A valid memory file's content for `name`. */
function memory(name: string, body: string): string {
  return serializeMemory({
    frontmatter: {
      name,
      description: `About ${name}`,
      metadata: { type: "project" },
    },
    body,
  });
}

function write(
  client: Client,
  path: string,
  content: string,
  ifVersion: string
) {
  return client.callTool({
    name: "memory_write",
    arguments: { path, content, if_version: ifVersion },
  });
}

function versionOfResult(result: { structuredContent?: unknown }): string {
  return (result.structuredContent as { version: string }).version;
}

describe("mcp server", () => {
  test("write then list round-trips over stdio", async () => {
    await withServer(async ({ client, storeId }) => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("memory_write");
      expect(names).toContain("memory_list");
      expect(names).toContain("memory_delete");
      expect(names).not.toContain("memory_index");
      expect(names).not.toContain("memory_remove");
      // Agents read the schema in this order; toEqual on objects would not catch a reorder.
      const writeTool = tools.tools.find((t) => t.name === "memory_write");
      expect(Object.keys(writeTool?.inputSchema.properties ?? {})).toEqual([
        "store",
        "path",
        "content",
        "if_version",
      ]);
      const deleteTool = tools.tools.find((t) => t.name === "memory_delete");
      expect(Object.keys(deleteTool?.inputSchema.properties ?? {})).toEqual([
        "store",
        "path",
        "if_version",
      ]);

      const saved = await write(
        client,
        "uses-bun.md",
        memory("uses-bun", "Use bun."),
        "new"
      );
      expect(textOf(saved)).toContain("Saved uses-bun.md");

      const list = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId },
      });
      expect(textOf(list)).toContain("uses-bun.md");
    });
  });

  test("memory_list with no arguments lists the project's one store", async () => {
    await withServer(async ({ client, storeId }) => {
      const list = await client.callTool({
        name: "memory_list",
        arguments: {},
      });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toBe(
        `${storeId} — Shared memory for ${storeId} — writable — index: MEMORY.md`
      );
    });
  });

  test("memory_list with a store lists its documents by path, size and date, index included, no content", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await store.create("b.md", "bbbb");
      await store.create("a.md", "body-text");
      const { mtime: updated } = await stat(join(store.root, "b.md"));

      const list = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId },
      });
      const lines = textOf(list).split("\n");
      expect(lines.map((line) => line.split(" — ")[0])).toEqual([
        "MEMORY.md",
        "a.md",
        "b.md",
      ]);
      expect(lines[2]).toBe(
        `b.md — 4 bytes — updated ${updated.toISOString()}`
      );
      expect(textOf(list)).not.toContain("body-text");
    });
  });

  test("memory_list with a store lists MEMORY.md even before it is generated", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await store.remove("MEMORY.md");
      const list = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId },
      });
      expect(textOf(list)).toStartWith("MEMORY.md — ");
      expect(store.exists("MEMORY.md")).toBe(true);
    });
  });

  test("memory_list's path_prefix narrows the listing", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await store.create("proj-a.md", "a");
      await store.create("proj-b.md", "b");
      await store.create("user-x.md", "x");

      const list = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId, path_prefix: "proj-" },
      });
      expect(
        textOf(list)
          .split("\n")
          .map((line) => line.split(" — ")[0])
      ).toEqual(["proj-a.md", "proj-b.md"]);
    });
  });

  test("memory_list's cursor continues a listing longer than one page", async () => {
    await withServer(async ({ client, store, storeId }) => {
      // With MEMORY.md, the store holds one page plus two documents.
      const names = Array.from(
        { length: STORE_PAGE_SIZE + 1 },
        (_, i) => `m-${String(i).padStart(3, "0")}.md`
      );
      await Promise.all(names.map((name) => store.create(name, "x")));

      const first = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId },
      });
      const firstText = textOf(first);
      const cursor = firstText.match(NEXT_CURSOR_RE)?.groups?.cursor;
      expect(cursor).toBeDefined();
      expect(firstText.split("\n")).toHaveLength(STORE_PAGE_SIZE + 1);

      const second = await client.callTool({
        name: "memory_list",
        arguments: { store: storeId, cursor },
      });
      const secondText = textOf(second);
      expect(secondText).not.toMatch(NEXT_CURSOR_RE);
      expect(
        secondText.split("\n").map((line) => line.split(" — ")[0])
      ).toEqual(names.slice(-2));
    });
  });

  test("memory_list refuses an unknown store id, naming the valid ones", async () => {
    await withServer(async ({ client, storeId }) => {
      const list = await client.callTool({
        name: "memory_list",
        arguments: { store: "nope" },
      });
      expect(list.isError).toBe(true);
      expect(textOf(list)).toContain('Unknown store "nope"');
      expect(textOf(list)).toContain(storeId);
    });
  });

  test("memory_read returns a document's content and version by path", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await store.create("prefers-bun.md", "Use bun.");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { store: storeId, path: "prefers-bun.md" },
      });
      const { version } = read.structuredContent as { version: string };
      expect(version).toBe(await store.version("prefers-bun.md"));
      // The version is in the text too, for agents that ignore structuredContent.
      expect(textOf(read)).toBe(`Use bun.\nversion: ${version}`);
    });
  });

  test("memory_read reads the index at MEMORY.md, generating it when missing", async () => {
    await withServer(async ({ client, store }) => {
      await store.remove("MEMORY.md");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { path: "MEMORY.md" },
      });
      expect(read.isError).toBeFalsy();
      expect(textOf(read)).toContain("# Memory index");
      expect(versionOfResult(read)).toBe(await store.version("MEMORY.md"));
    });
  });

  test("memory_read refuses a bare name, naming the missing path", async () => {
    await withServer(async ({ client, store }) => {
      await store.create("prefers-bun.md", "Use bun.");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { path: "prefers-bun" },
      });
      expect(read.isError).toBe(true);
      expect(textOf(read)).toContain('"prefers-bun"');
    });
  });

  test("a stale if_version write is rejected with the current content and version", async () => {
    await withServer(async ({ client, store }) => {
      await write(client, "note.md", memory("note", "one"), "new");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { path: "note.md" },
      });
      const version = versionOfResult(read);

      // A concurrent writer changes the memory out from under us.
      await store.create("note.md", memory("note", "two"));

      // The stale version must be refused, so the concurrent write isn't clobbered.
      const stale = await write(
        client,
        "note.md",
        memory("note", "three"),
        version
      );
      expect(stale.isError).toBe(true);
      expect(textOf(stale)).toContain("Version conflict");
      // The rejection hands back what is there now, so the agent can merge and retry.
      expect(textOf(stale)).toContain(memory("note", "two"));
      expect(textOf(stale)).toContain(
        `version: ${await store.version("note.md")}`
      );
      expect(await store.view("note.md")).toBe(memory("note", "two"));
    });
  });

  test("memory_write without if_version is refused", async () => {
    await withServer(async ({ client, store }) => {
      const result = await client.callTool({
        name: "memory_write",
        arguments: { path: "note.md", content: memory("note", "one") },
      });
      expect(result.isError).toBe(true);
      expect(store.exists("note.md")).toBe(false);
    });
  });

  test("memory_write's content replaces the whole document and the result carries the new version", async () => {
    await withServer(async ({ client, store }) => {
      const first = await write(
        client,
        "note.md",
        memory("note", "line one\n\nline two"),
        "new"
      );
      expect(versionOfResult(first)).toBe(await store.version("note.md"));

      const second = await write(
        client,
        "note.md",
        memory("note", "line three"),
        versionOfResult(first)
      );
      expect(second.isError).toBeFalsy();
      expect(await store.view("note.md")).toBe(memory("note", "line three"));
      const version = await store.version("note.md");
      expect(versionOfResult(second)).toBe(version);
      expect(textOf(second)).toContain(`version: ${version}`);
    });
  });

  test("memory_write with if_version new on an existing path is rejected with the current content and version", async () => {
    await withServer(async ({ client, store }) => {
      await store.create("note.md", memory("note", "already here"));
      const result = await write(
        client,
        "note.md",
        memory("note", "mine"),
        "new"
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(memory("note", "already here"));
      expect(textOf(result)).toContain(
        `version: ${await store.version("note.md")}`
      );
      expect(await store.view("note.md")).toBe(memory("note", "already here"));
    });
  });

  test("memory_write refuses content that does not parse as a memory, with the parse errors", async () => {
    await withServer(async ({ client, store }) => {
      const result = await write(
        client,
        "note.md",
        "---\nname: note\nmetadata:\n  type: project\n---\n\nNo description.\n",
        "new"
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("description");
      expect(store.exists("note.md")).toBe(false);
    });
  });

  test("memory_write refuses a memory whose name is not its file name", async () => {
    await withServer(async ({ client, store }) => {
      const result = await write(
        client,
        "note.md",
        memory("other-name", "x"),
        "new"
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('"other-name"');
      expect(store.exists("note.md")).toBe(false);
    });
  });

  test("memory_write refuses the index path: the index is generated", async () => {
    await withServer(async ({ client, store }) => {
      const before = await store.view("MEMORY.md");
      const result = await write(
        client,
        "MEMORY.md",
        "# hand-written",
        await store.version("MEMORY.md")
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("generated");
      expect(await store.view("MEMORY.md")).toBe(before);
    });
  });

  test("memory_write refuses the index path in any letter case, since memory.md opens MEMORY.md on a case-insensitive filesystem", async () => {
    await withServer(async ({ client, store }) => {
      const before = await store.view("MEMORY.md");
      const result = await write(
        client,
        "memory.md",
        memory("memory", "x"),
        await store.version("MEMORY.md")
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("the index is generated");
      expect(await store.view("MEMORY.md")).toBe(before);
    });
  });

  test("memory_write refuses a path with a directory, since nested files are never indexed", async () => {
    await withServer(async ({ client, store }) => {
      const result = await write(
        client,
        "sub/note.md",
        memory("note", "x"),
        "new"
      );
      expect(result.isError).toBe(true);
      expect(store.exists("sub/note.md")).toBe(false);
    });
  });

  test("memory_write regenerates the index, warning when that fails", async () => {
    await withServer(async ({ client, store }) => {
      await write(client, "note.md", memory("note", "x"), "new");
      expect(await store.view("MEMORY.md")).toContain("[note](note.md)");

      // Another memory is unparseable, so the index can't be rebuilt; the write still lands.
      await store.create("broken.md", "no frontmatter");
      const result = await write(
        client,
        "other.md",
        memory("other", "y"),
        "new"
      );
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Warning: MEMORY.md is stale");
      expect(store.exists("other.md")).toBe(true);
    });
  });

  test("memory_delete deletes a document at its version and regenerates the index", async () => {
    await withServer(async ({ client, store, storeId }) => {
      const saved = await write(client, "note.md", memory("note", "x"), "new");
      const result = await client.callTool({
        name: "memory_delete",
        arguments: {
          store: storeId,
          path: "note.md",
          if_version: versionOfResult(saved),
        },
      });
      expect(result.isError).toBeFalsy();
      expect(store.exists("note.md")).toBe(false);
      expect(await store.view("MEMORY.md")).not.toContain("note.md");
    });
  });

  test("memory_delete with a stale if_version is rejected with the current content and version", async () => {
    await withServer(async ({ client, store }) => {
      const saved = await write(
        client,
        "note.md",
        memory("note", "one"),
        "new"
      );
      // A concurrent writer changes the memory after we last saw it.
      await store.create("note.md", memory("note", "two"));

      const result = await client.callTool({
        name: "memory_delete",
        arguments: { path: "note.md", if_version: versionOfResult(saved) },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Version conflict");
      expect(textOf(result)).toContain(memory("note", "two"));
      expect(textOf(result)).toContain(
        `version: ${await store.version("note.md")}`
      );
      expect(store.exists("note.md")).toBe(true);
    });
  });

  test("memory_delete refuses the index path", async () => {
    await withServer(async ({ client, store }) => {
      const result = await client.callTool({
        name: "memory_delete",
        arguments: {
          path: "MEMORY.md",
          if_version: await store.version("MEMORY.md"),
        },
      });
      expect(result.isError).toBe(true);
      expect(store.exists("MEMORY.md")).toBe(true);
    });
  });

  test("memory_delete refuses the index path in any letter case", async () => {
    await withServer(async ({ client, store }) => {
      const before = await store.view("MEMORY.md");
      const result = await client.callTool({
        name: "memory_delete",
        arguments: {
          path: "memory.md",
          if_version: await store.version("MEMORY.md"),
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("the index is generated");
      expect(await store.view("MEMORY.md")).toBe(before);
    });
  });

  test("memory_search lists matching memory documents by path with their description", async () => {
    await withServer(async ({ client, storeId }) => {
      await write(client, "uses-bun.md", memory("uses-bun", "Use bun."), "new");
      await write(client, "uses-ts.md", memory("uses-ts", "Use TS."), "new");

      const result = await client.callTool({
        name: "memory_search",
        arguments: { store: storeId, query: "bun" },
      });
      expect(textOf(result)).toBe("uses-bun.md — About uses-bun");
    });
  });
});
