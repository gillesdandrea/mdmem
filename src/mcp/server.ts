import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { factFileFor, MEMORY_TYPES } from "../core/fact.ts";
import {
  readIndex,
  removeFact,
  saveFact,
  searchFacts,
  staleIndexWarning,
} from "../core/operations.ts";
import type { WriteResult } from "../core/operations.ts";
import { findStoreRoot, MemoryStore, versionOf } from "../core/store.ts";

/**
 * MCP surface over the shared `.memory/` store, for agents that would rather call
 * tools than read files. It exposes ergonomic fact-level operations (shared with the
 * CLI via ../core/operations); writes reindex automatically so the index stays fresh.
 */

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function resolveStore(): MemoryStore {
  const dir = findStoreRoot(process.cwd());
  if (!dir) {
    throw new Error(
      "No .memory/ store found — run `mdmem init` in the project first."
    );
  }
  return new MemoryStore(dir);
}

/** The write landed, so it is not an error; a stale index rides along as a warning. */
function writeText(
  verb: string,
  { file, indexError }: WriteResult
): CallToolResult {
  return text(
    indexError === undefined
      ? `${verb} ${file}`
      : `${verb} ${file}\nWarning: ${staleIndexWarning(indexError)}`
  );
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

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "mdmem", version: "0.1.0" });

  server.registerTool(
    "memory_index",
    {
      title: "Read memory index",
      description:
        "Return the project's memory index (MEMORY.md): one line per stored fact. Read this first to recall what is already known.",
      inputSchema: z.object({}),
    },
    () => withStore(async (store) => text(await readIndex(store)))
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Find facts whose text (name, description, or body) contains the query anywhere.",
      inputSchema: z.object({
        query: z.string().describe("Text to search for"),
      }),
    },
    ({ query }) =>
      withStore(async (store) => {
        const hits = await searchFacts(store, query);
        return text(
          hits.length > 0
            ? hits.map((h) => `${h.file} — ${h.description}`).join("\n")
            : `No facts matching "${query}".`
        );
      })
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a fact",
      description:
        "Return one fact's full content, plus its current version. Pass that version back to memory_write's `ifVersion` to make a safe read-modify-write that won't clobber a concurrent change.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Fact slug or file name, e.g. prefers-bun or prefers-bun.md"
          ),
      }),
      outputSchema: z.object({ version: z.string() }),
    },
    ({ path }) =>
      withStore(async (store) => {
        const content = await store.view(factFileFor(path));
        return {
          content: [{ type: "text", text: content }],
          structuredContent: { version: versionOf(content) },
        };
      })
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write a fact",
      description:
        "Create or overwrite a fact and refresh the index. Use kebab-case names. For feedback/project facts, include **Why:** and **How to apply:** lines in the body. Pass `ifVersion` (from memory_read) to reject the write if the fact changed since you read it.",
      inputSchema: z.object({
        name: z.string().describe("kebab-case slug; also the filename"),
        description: z.string().describe("one-line summary shown in the index"),
        type: z
          .enum(MEMORY_TYPES)
          .describe("user | feedback | project | reference"),
        body: z.string().describe("the fact"),
        ifVersion: z
          .string()
          .optional()
          .describe(
            "version from a prior memory_read; the write is rejected if the fact changed since"
          ),
      }),
    },
    ({ name, description, type, body, ifVersion }) =>
      withStore(async (store) => {
        const result = await saveFact(
          store,
          { name, description, type, body },
          { ifVersion }
        );
        return writeText("Saved", result);
      })
  );

  server.registerTool(
    "memory_remove",
    {
      title: "Remove a fact",
      description: "Delete a fact by name and refresh the index.",
      inputSchema: z.object({
        name: z.string().describe("kebab-case slug of the fact to remove"),
      }),
    },
    ({ name }) =>
      withStore(async (store) => {
        const result = await removeFact(store, name);
        return result
          ? writeText("Removed", result)
          : text(`No fact named "${name}".`);
      })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("mdmem MCP server running on stdio\n");
}
