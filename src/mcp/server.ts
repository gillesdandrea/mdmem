import { McpServer } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  GetPromptResult,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  assertStoreId,
  deleteDocument,
  describeStore,
  listDocuments,
  openStore,
  readDocument,
  searchMemories,
  writeDocument,
} from "../core/operations.ts";
import type {
  VersionedDocument,
  VersionedWriteResult,
  WriteResult,
} from "../core/operations.ts";
import { getConsolidatePrompt } from "../core/protocol.ts";
import { RefusalError } from "../core/refusal.ts";
import { versionOf, VersionConflictError } from "../core/store.ts";
import type { MemoryStore } from "../core/store.ts";

/**
 * MCP surface over the shared `.memory/` store, for agents that would rather call
 * tools than read files. It mirrors Claude Code's memory-store tools (memory_list,
 * memory_read, memory_write: whole documents addressed by path, guarded by a required
 * if_version) plus memory_search and memory_delete (docs/adr/0001). The operations
 * live in ../core/operations; writes reindex automatically so the index stays fresh.
 * It also serves the consolidation prompt, as the MCP prompt consolidate.
 */

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function errorText(body: string): CallToolResult {
  return { ...text(body), isError: true };
}

/** The project's store, checked against the caller's store id (omitted means the project's store). */
function resolveStore(id?: string): MemoryStore {
  const store = openStore(process.cwd());
  assertStoreId(store, id);
  return store;
}

const storeParam = z
  .string()
  .optional()
  .describe(
    "the store's id (call memory_list with no arguments to see it); omitted means the project's store"
  );

function storesListing(store: MemoryStore): string {
  const { id, description, writable, index } = describeStore(store);
  return `${id} — ${description} — ${writable ? "writable" : "read-only"} — index: ${index}`;
}

async function documentsListing(
  store: MemoryStore,
  options: { pathPrefix?: string; cursor?: string }
): Promise<string> {
  const { documents, nextCursor } = await listDocuments(store, options);
  if (documents.length === 0) {
    return "No memory documents.";
  }
  const lines = documents.map(
    ({ path, size, updated }) =>
      `${path} — ${size} bytes — updated ${updated.toISOString()}`
  );
  if (nextCursor !== undefined) {
    lines.push(`next cursor: ${nextCursor}`);
  }
  return lines.join("\n");
}

/** A document's content, then its version on a line of its own, so the text carries both. */
function documentResult({
  content,
  version,
}: VersionedDocument): CallToolResult {
  return {
    content: [
      { type: "text", text: content },
      { type: "text", text: `version: ${version}` },
    ],
    structuredContent: { version },
  };
}

/** A write's warnings, one line each, worded once for every write result. */
function warningLines(warnings: readonly string[]): string[] {
  return warnings.map((w) => `Warning: ${w}`);
}

/** The write landed, so it is not an error; its warnings (a stale or full index) ride along. */
function writeText(
  verb: string,
  { file, warnings }: WriteResult
): CallToolResult {
  return text([`${verb} ${file}`, ...warningLines(warnings)].join("\n"));
}

const ifVersionParam = z
  .string()
  .describe(
    "the version token from your most recent memory_read or memory_write of this path, or the literal word new for a file that does not exist yet"
  );

/** Saved: the path, the new version, and the write's warnings (the write itself landed). */
function savedResult({
  file,
  warnings,
  version,
}: VersionedWriteResult): CallToolResult {
  const lines = [
    `Saved ${file}`,
    `version: ${version}`,
    ...warningLines(warnings),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { version },
  };
}

/** A version conflict hands back the document as it is now, so the agent can merge and retry. */
function conflictResult({
  message,
  current,
}: VersionConflictError): CallToolResult {
  if (current === undefined) {
    return {
      content: [
        {
          type: "text",
          text: `${message}. Pass if_version new to create it.`,
        },
      ],
      isError: true,
    };
  }
  const version = versionOf(current);
  return {
    content: [
      {
        type: "text",
        text: `${message}. Its current content and version follow: merge your change into it, then retry with that version.`,
      },
      { type: "text", text: current },
      { type: "text", text: `version: ${version}` },
    ],
    structuredContent: { version },
    isError: true,
  };
}

async function withStore(
  id: string | undefined,
  fn: (store: MemoryStore) => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await fn(resolveStore(id));
  } catch (error) {
    // A refusal (ADR 0002) says what to do next; a version conflict also hands back the current content.
    if (error instanceof VersionConflictError) {
      return conflictResult(error);
    }
    if (error instanceof RefusalError) {
      return errorText(error.message);
    }
    // Anything else, such as a broken memory met while reading the store, is still a result, never a crash.
    return errorText(error instanceof Error ? error.message : String(error));
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "mdmem", version: "0.1.0" });

  server.registerTool(
    "memory_list",
    {
      title: "List memory stores or documents",
      description:
        "List the memory documents in a memory store, sorted by path — each line gives a document's path, size, and last-updated date, but no content (use memory_read for that). Pass store (the store's id) to choose the store, path_prefix to list only the paths that start with it, and the cursor from a previous call to continue a long listing. Call with no arguments at all to list the memory stores available — their ids, a one-line description, whether each is writable or read-only, and the path of each store's index document.",
      inputSchema: z.object({
        store: storeParam,
        path_prefix: z
          .string()
          .optional()
          .describe("list only the documents whose path starts with this"),
        cursor: z
          .string()
          .optional()
          .describe("the next cursor from a previous memory_list call"),
      }),
    },
    ({ store: id, path_prefix: pathPrefix, cursor }) => {
      const noArguments =
        id === undefined && pathPrefix === undefined && cursor === undefined;
      return withStore(id, async (store) =>
        text(
          noArguments
            ? storesListing(store)
            : await documentsListing(store, { pathPrefix, cursor })
        )
      );
    }
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Find the memories in a memory store whose text (name, description or body) contains the query, ignoring case. Each line gives a matching memory document's path and its description; use memory_read for the content.",
      inputSchema: z.object({
        store: storeParam,
        query: z.string().describe("text to search for"),
      }),
    },
    ({ store: id, query }) =>
      withStore(id, async (store) => {
        const hits = await searchMemories(store, query);
        return text(
          hits.length > 0
            ? hits.map((h) => `${h.file} — ${h.description}`).join("\n")
            : `No memories matching "${query}".`
        );
      })
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory document",
      description:
        "Read one memory document by its path in the store — a memory such as prefers-bun.md, or the index, MEMORY.md — and return its content and its version token. Pass that version as if_version to memory_write or memory_delete; the change is then refused if the document changed since you read it.",
      inputSchema: z.object({
        store: storeParam,
        path: z
          .string()
          .describe(
            "the document's path in the store, e.g. prefers-bun.md or MEMORY.md"
          ),
      }),
      outputSchema: z.object({ version: z.string() }),
    },
    ({ store: id, path }) =>
      withStore(id, async (store) =>
        documentResult(await readDocument(store, path))
      )
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write a memory document",
      description:
        "Create or update a memory document with full content, in the memory store named by store (call memory_list with no arguments to see it; omitted means the project's store). Overwrites if the path already exists: content replaces the ENTIRE document — this is not an append or a patch. Include every existing line you intend to keep; any line you omit is deleted. The content is a memory — YAML frontmatter with name, description and metadata.type (user, feedback, project or reference), then the body — and its name must equal the path without .md. MEMORY.md is generated from the memories, so it cannot be written. Use this to save durable knowledge about the project and how to work in it — not transient task state. Always pass if_version: the version token from your most recent memory_read or memory_write of this path, or the literal word new (without quotes) for a file that does not yet exist. The listing shows paths but not version tokens, so for any file already there you must memory_read it first. Writes with if_version=new to an existing path are rejected so you can't overwrite content you haven't seen. Both the rejection and a version conflict return the current content and version so you can merge and retry. The result includes the new version token for follow-up writes. Never write secrets or credentials into a memory — the store is shared with every agent on the project, and content that looks like it holds an API key, token, private key or password is refused.",
      inputSchema: z.object({
        store: storeParam,
        path: z
          .string()
          .describe("the memory's path in the store: <name>.md, no directory"),
        content: z
          .string()
          .describe("the whole document: frontmatter, then the body"),
        if_version: ifVersionParam,
      }),
      outputSchema: z.object({ version: z.string() }),
    },
    ({ store: id, path, content, if_version: ifVersion }) =>
      withStore(id, async (store) =>
        savedResult(await writeDocument(store, path, content, ifVersion))
      )
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a memory document",
      description:
        "Delete a memory document from the memory store named by store (omitted means the project's store), then regenerate the index. Always pass if_version: the version token from your most recent memory_read or memory_write of this path. If the document changed since, the delete is rejected with its current content and version, so you can decide again. MEMORY.md is generated, so it cannot be deleted.",
      inputSchema: z.object({
        store: storeParam,
        path: z
          .string()
          .describe("the memory's path in the store, e.g. prefers-bun.md"),
        if_version: z
          .string()
          .describe(
            "the version token from your most recent memory_read or memory_write of this path"
          ),
      }),
    },
    ({ store: id, path, if_version: ifVersion }) =>
      withStore(id, async (store) =>
        writeText("Deleted", await deleteDocument(store, path, ifVersion))
      )
  );

  server.registerPrompt(
    "consolidate",
    {
      title: "Consolidate memory",
      description:
        "A consolidation pass over the project's memory store: orient on the existing memories, gather recent signal, merge and correct memories, prune stale ones, and reconcile them with the project's instruction files.",
    },
    (): GetPromptResult => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getConsolidatePrompt(resolveStore().root),
          },
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("mdmem MCP server running on stdio\n");
}
