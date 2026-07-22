import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { reindex } from "../src/core/index.ts";
import { MemoryStore } from "../src/core/store.ts";

const SERVER = join(import.meta.dir, "..", "src", "mcp", "server.ts");

describe("mcp server", () => {
  test("write then index round-trips over stdio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memcli-mcp-"));
    const store = new MemoryStore(join(dir, ".memory"));
    await reindex(store); // empty store so the server's findStoreRoot succeeds

    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      cwd: dir,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("memory_write");
      expect(names).toContain("memory_index");

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
});
