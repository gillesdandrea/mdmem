#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  factFileName,
  MEMORY_TYPES,
  parseFact,
  serializeFact,
} from "../core/fact.ts";
import { reindex } from "../core/index.ts";
import { findStoreRoot, INDEX_FILE, MemoryStore } from "../core/store.ts";

/**
 * MCP surface over the shared `.memory/` store, for agents that would rather call
 * tools than read files. It exposes ergonomic fact-level operations (the CLI keeps
 * the raw six-op filesystem); writes reindex automatically so the index stays fresh.
 */

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function resolveStore(): MemoryStore {
  const dir = findStoreRoot(process.cwd());
  if (!dir) {
    throw new Error(
      "No .memory/ store found — run `memory init` in the project first."
    );
  }
  return new MemoryStore(dir);
}

async function withStore(
  fn: (store: MemoryStore) => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await fn(resolveStore());
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

const server = new McpServer({ name: "memory", version: "0.1.0" });

server.registerTool(
  "memory_index",
  {
    title: "Read memory index",
    description:
      "Return the project's memory index (MEMORY.md): one line per stored fact. Read this first to recall what is already known.",
    inputSchema: {},
  },
  () =>
    withStore(async (store) => {
      if (!store.exists(INDEX_FILE)) {
        await reindex(store);
      }
      return text(await store.view(INDEX_FILE));
    })
);

server.registerTool(
  "memory_search",
  {
    title: "Search memory",
    description:
      "Find facts whose name, description, or body contains the query text.",
    inputSchema: { query: z.string().describe("Text to search for") },
  },
  ({ query }) =>
    withStore(async (store) => {
      const needle = query.toLowerCase();
      const lines: string[] = [];
      for (const file of await store.listFacts()) {
        const raw = await store.view(file);
        if (raw.toLowerCase().includes(needle)) {
          lines.push(`${file} — ${parseFact(raw).frontmatter.description}`);
        }
      }
      return text(
        lines.length > 0 ? lines.join("\n") : `No facts matching "${query}".`
      );
    })
);

server.registerTool(
  "memory_read",
  {
    title: "Read a fact",
    description: "Return the full content of one fact file.",
    inputSchema: {
      path: z.string().describe("Fact file name, e.g. prefers-bun.md"),
    },
  },
  ({ path }) => withStore(async (store) => text(await store.view(path)))
);

server.registerTool(
  "memory_write",
  {
    title: "Write a fact",
    description:
      "Create or overwrite a fact and refresh the index. Use kebab-case names. For feedback/project facts, include **Why:** and **How to apply:** lines in the body.",
    inputSchema: {
      name: z.string().describe("kebab-case slug; also the filename"),
      description: z.string().describe("one-line summary shown in the index"),
      type: z
        .enum(MEMORY_TYPES)
        .describe("user | feedback | project | reference"),
      body: z.string().describe("the fact"),
    },
  },
  ({ name, description, type, body }) =>
    withStore(async (store) => {
      const content = serializeFact({
        frontmatter: { name, description, metadata: { type } },
        body,
      });
      parseFact(content); // validate before writing
      await store.create(factFileName(name), content);
      await reindex(store);
      return text(`Saved ${factFileName(name)}`);
    })
);

server.registerTool(
  "memory_remove",
  {
    title: "Remove a fact",
    description: "Delete a fact by name and refresh the index.",
    inputSchema: {
      name: z.string().describe("kebab-case slug of the fact to remove"),
    },
  },
  ({ name }) =>
    withStore(async (store) => {
      const file = factFileName(name);
      if (!store.exists(file)) {
        return text(`No fact named "${name}".`);
      }
      await store.remove(file);
      await reindex(store);
      return text(`Removed ${file}`);
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("memory MCP server running on stdio\n");
