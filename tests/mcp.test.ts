import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { reindex } from "../src/core/index.ts";
import { MemoryStore } from "../src/core/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

describe("mcp server", () => {
  test("write then index round-trips over stdio", async () => {
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

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("memory_write");
      expect(names).toContain("memory_index");
      // Agents read the schema in this order; toEqual on objects would not catch a reorder.
      const writeTool = tools.tools.find((t) => t.name === "memory_write");
      expect(Object.keys(writeTool?.inputSchema.properties ?? {})).toEqual([
        "name",
        "description",
        "type",
        "body",
        "ifVersion",
      ]);

      const write = await client.callTool({
        name: "memory_write",
        arguments: {
          name: "uses-bun",
          description: "Uses bun",
          type: "feedback",
          body: "Use bun.",
        },
      });
      expect(JSON.stringify(write.content)).toContain("Saved uses-bun.md");

      const index = await client.callTool({
        name: "memory_index",
        arguments: {},
      });
      expect(JSON.stringify(index.content)).toContain("uses-bun");
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stale ifVersion write is rejected — this is why memory_read exposes a version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdmem-mcp-"));
    const store = new MemoryStore(join(dir, ".memory"));
    await reindex(store);

    const transport = new StdioClientTransport({
      command: "bun",
      args: [CLI, "mcp"],
      cwd: dir,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const write = (body: string, ifVersion?: string) =>
        client.callTool({
          name: "memory_write",
          arguments: {
            name: "note",
            description: "d",
            type: "project",
            body,
            ifVersion,
          },
        });

      await write("one");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { path: "note" },
      });
      const { version } = read.structuredContent as { version: string };
      expect(version).toBeTruthy();

      // A concurrent writer changes the memory out from under us.
      await write("two");

      // The stale version must be refused, so the concurrent write isn't clobbered.
      const stale = await write("three", version);
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale.content)).toContain("Version conflict");

      const after = await client.callTool({
        name: "memory_read",
        arguments: { path: "note" },
      });
      expect(JSON.stringify(after.content)).toContain("two");
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
