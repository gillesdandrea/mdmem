import { McpServer } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  GetPromptResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import packageJson from "../../package.json" with { type: "json" };
import { CODEX_HOME_ENV } from "../adapters/codex.ts";
import { adapterIds, getAdapter, unknownAgent } from "../adapters/index.ts";
import {
  adapterContext,
  checkProject,
  creationLines,
  ensureStore,
  formatProjectCheck,
  locateContext,
} from "../adapters/report.ts";
import type { StoreCreation } from "../adapters/report.ts";
import { INDEX_CHANGES, INDEX_FILE, POINTER_MAX_CHARS } from "../core/check.ts";
import {
  assertStoreId,
  checkMemoryWrite,
  deleteDocument,
  describeStore,
  listDocuments,
  openStore,
  readDocument,
  searchMemories,
  secondStoreDir,
  writeDocument,
} from "../core/operations.ts";
import type {
  VersionedDocument,
  VersionedWriteResult,
  WriteResult,
} from "../core/operations.ts";
import { getConsolidatePrompt } from "../core/protocol.ts";
import { RefusalError } from "../core/refusal.ts";
import {
  locateStore,
  NEW_FILE_VERSION,
  placementOf,
  PLACEMENTS,
  storeAt,
  versionOf,
  VersionConflictError,
} from "../core/store.ts";
import type { MemoryStore } from "../core/store.ts";
import { messageOf } from "../core/text.ts";

/**
 * MCP surface over the project's shared store, home or local (ADR 0005), for agents that would rather call
 * tools than read files. It mirrors Claude Code's memory-store tools (memory_list,
 * memory_read, memory_write: whole documents addressed by path, guarded by a required
 * if_version) plus memory_search, memory_check and memory_delete (docs/adr/0001). The
 * operations live in ../core/operations and ../core/check; writes update the index
 * automatically, so it stays up to date.
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

/**
 * The project's store for a listing or a search, checked against the caller's store id,
 * and whether it exists: with no store yet, the one the first memory_write creates,
 * which they read as holding no memories and never create.
 */
function locateForReading(id?: string): {
  store: MemoryStore;
  exists: boolean;
} {
  const location = locateStore(process.cwd());
  const store = storeAt(location);
  assertStoreId(store, id);
  return { store, exists: location.exists };
}

/** What a listing or a search adds to a store's line when the store does not exist yet. */
const NOT_CREATED = "not created yet: the first memory_write creates it";

const storeParam = z
  .string()
  .optional()
  .describe(
    "the store's id (call memory_list with no arguments to see it); omitted means the project's store"
  );

/** The store that answered a read, as structured content: its id, placement and directory. */
const storeOutput = z.object({
  id: z.string(),
  placement: z.enum(PLACEMENTS),
  path: z.string(),
});

/** The store that answered a read, by the id memory_list gives it, its placement and its directory. */
function storeRef(store: MemoryStore): z.infer<typeof storeOutput> {
  return {
    id: describeStore(store).id,
    placement: placementOf(store),
    path: store.root,
  };
}

/** The line a search or read result opens with, naming the store that answered and its placement, and whether it is not created yet. */
function storeLine(store: MemoryStore, exists = true): string {
  const { id, placement, path } = storeRef(store);
  return `Store: ${id} (${placement}, ${path})${exists ? "" : `, ${NOT_CREATED}`}`;
}

function storesListing(store: MemoryStore, exists: boolean): string {
  const { id, description, writable, index } = describeStore(store);
  const created = exists ? "" : ` (${NOT_CREATED})`;
  return `${id} — ${description}${created} — ${writable ? "writable" : "read-only"} — index: ${index}`;
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

/**
 * What memory_read returns as structured content: the store that answered, and the
 * document. A client that shows the agent the structured content instead of the text
 * blocks (Claude Code, when a tool declares an output schema) must still see the whole
 * document.
 */
const documentOutput = z.object({
  store: storeOutput,
  path: z.string(),
  content: z.string(),
  version: z.string(),
});

/** The store that answered, the document's content, then its version, each in a text block of its own; the structured content carries them too. */
function documentResult(
  store: MemoryStore,
  path: string,
  { content, version }: VersionedDocument
): CallToolResult {
  return {
    content: [
      { type: "text", text: storeLine(store) },
      { type: "text", text: content },
      { type: "text", text: `version: ${version}` },
    ],
    structuredContent: { store: storeRef(store), path, content, version },
  };
}

/** A result's warnings (a write's, or a search's broken memories), one line each, worded once. */
function warningLines(warnings: readonly string[]): string[] {
  return warnings.map((w) => `Warning: ${w}`);
}

/** The write landed, so it is not an error; its warnings (a broken memory, a stale or full index) ride along. */
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

/**
 * What memory_write returns as structured content, one field per kind of line its
 * text holds: the path and new version, what the write did to the memory's pointer in
 * MEMORY.md, what creating the store did when the write created it (its path, the
 * import's lines, whether git ignores it), and every warning.
 */
const savedOutput = z.object({
  file: z.string(),
  version: z.string(),
  index: z.enum(INDEX_CHANGES),
  created: z
    .object({
      store: z.string(),
      placement: z.enum(PLACEMENTS),
      imported: z.array(z.string()),
      ignored: z.boolean().optional(),
    })
    .optional(),
  warnings: z.array(z.string()),
});

/** Saved: what creating the store did, if the write created it, then the path, the new version, what became of its pointer in MEMORY.md, and the write's warnings (the write itself landed). */
function savedResult(
  { file, warnings, version, index }: VersionedWriteResult,
  creation: StoreCreation
): CallToolResult {
  const lines = [
    ...creationLines(creation),
    ...warningLines(creation.warnings),
    `Saved ${file}`,
    `version: ${version}`,
    `${INDEX_FILE}: ${index}`,
    ...warningLines(warnings),
  ];
  const created = creation.created
    ? {
        store: creation.store.root,
        placement: creation.placement,
        imported: creation.imported,
        ignored: creation.ignored,
      }
    : undefined;
  const output: z.infer<typeof savedOutput> = {
    file,
    version,
    index,
    ...(created === undefined ? {} : { created }),
    warnings: [...creation.warnings, ...warnings],
  };
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: output,
  };
}

/** A version conflict hands back the document as it is now, in the text and the structured content, so the agent can merge and retry. */
function conflictResult({
  message,
  path,
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
    structuredContent: { message, path, content: current, version },
    isError: true,
  };
}

/** `fn`'s result, every refusal and error it throws turned into an error result. */
async function asResult(
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    // A refusal (ADR 0002) says what to do next; a version conflict also hands back the current content.
    if (error instanceof VersionConflictError) {
      return conflictResult(error);
    }
    if (error instanceof RefusalError) {
      return errorText(error.message);
    }
    // Anything else, such as a file the store cannot read, is still a result, never a crash.
    return errorText(messageOf(error));
  }
}

/** `fn` on the project's store, which must exist: reading or deleting a document refuses until the first memory_write creates it. */
function withStore(
  id: string | undefined,
  fn: (store: MemoryStore) => Promise<CallToolResult>
): Promise<CallToolResult> {
  return asResult(() => fn(resolveStore(id)));
}

/** What a tool does to the store: only reads it, or changes it. */
type ToolKind = "read" | "change";

/**
 * A tool's title and annotations, the title written once: the spec's place for a title
 * is the top level, but Claude Code reads annotations.title. Every hint is set, so no
 * client falls back on a default: a read-only tool changes nothing; a write or delete
 * replaces or removes a whole document, and the same call cannot land twice, since
 * its if_version no longer matches. No tool reaches past the project's store.
 */
function titled(
  title: string,
  kind: ToolKind
): { title: string; annotations: ToolAnnotations } {
  const changes = kind === "change";
  return {
    title,
    annotations: {
      title,
      readOnlyHint: !changes,
      destructiveHint: changes,
      idempotentHint: changes,
      openWorldHint: false,
    },
  };
}

/** The name Codex CLI gives its MCP client (codex-rs/codex-mcp, rust-v0.160.0). */
const CODEX_CLIENT = "codex-mcp-client";

/**
 * The variables of the agents' environment this server cannot see, by the client
 * that started it. Codex starts a stdio server with a cleared environment holding
 * only HOME, PATH and a few more (codex-rs/rmcp-client DEFAULT_ENV_VARS,
 * rust-v0.160.0), so without CODEX_HOME here its own CODEX_HOME is unknown.
 */
function unknownEnv(client: string | undefined): string[] {
  const codexHome = process.env[CODEX_HOME_ENV];
  return client === CODEX_CLIENT &&
    (codexHome === undefined || codexHome === "")
    ? [CODEX_HOME_ENV]
    : [];
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "mdmem", version: packageJson.version });

  server.registerTool(
    "memory_list",
    {
      ...titled("List memory stores or documents", "read"),
      description:
        "List the memory documents in a memory store, sorted by path — each line gives a document's path, size, and last-updated date, but no content (use memory_read for that). Pass store (the store's id) to choose the store, path_prefix to list only the paths that start with it, and the cursor from a previous call to continue a long listing. Call with no arguments at all to list the memory stores available — their ids, a one-line description, whether each is writable or read-only, and the path of each store's index document. With no store yet, the project has no memories: the listing has no documents, and the store's line says the first memory_write creates it.",
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
    // With no store yet, it lists no memories and creates nothing.
    ({ store: id, path_prefix: pathPrefix, cursor }) =>
      asResult(async () => {
        const { store, exists } = locateForReading(id);
        if (
          id === undefined &&
          pathPrefix === undefined &&
          cursor === undefined
        ) {
          return text(storesListing(store, exists));
        }
        return text(
          exists
            ? await documentsListing(store, { pathPrefix, cursor })
            : "No memory documents."
        );
      })
  );

  server.registerTool(
    "memory_search",
    {
      ...titled("Search memory", "read"),
      description:
        "Find the memories whose name, description, headings or body hold the words of the query, each word stemmed and matched on its own, best match first; quote text to require it as an exact phrase; common function words are ignored. The result opens with a line naming the store that answered, Store: <id> (<placement>, <path>), its placement home or local; each line after it gives a matching memory document's path and its description; use memory_read for the content. A memory that does not parse is skipped, and a 'Warning: ' line after the hits names it. With no store yet, the project has no memories: nothing matches, and the store's line says the first memory_write creates it.",
      inputSchema: z.object({
        store: storeParam,
        query: z
          .string()
          .describe(
            "words to find, each matched on its own; quote an exact phrase"
          ),
      }),
    },
    // With no store yet, it finds nothing and creates nothing.
    ({ store: id, query }) =>
      asResult(async () => {
        const { store, exists } = locateForReading(id);
        const { hits, warnings } = await searchMemories(store, query);
        const lines =
          hits.length > 0
            ? hits.map((h) => `${h.file} — ${h.description}`)
            : [`No memories matching "${query}".`];
        // An unparseable memory is skipped and reported, not a failure (ADR 0002).
        return text(
          [storeLine(store, exists), ...lines, ...warningLines(warnings)].join(
            "\n"
          )
        );
      })
  );

  server.registerTool(
    "memory_check",
    {
      ...titled("Check a memory store and the agents' wiring", "read"),
      description: `Check a memory store for problems with its memories and its index: an unparseable memory, a name that differs from its file name, a metadata.type and a type that disagree, a secret, a pointer over ${POINTER_MAX_CHARS} characters, a stale index (a memory without a pointer, a pointer to a missing file, a duplicate pointer, or a pointer titled with its memory's name whose description differs from the memory's), or an index over the size a session-start hook can inject; and with the agents' wiring, user-wide and the project's: an agent's config file that cannot be read (a project file always, a user-wide one only for an agent wired in either scope, and Codex's global hooks.json only when CODEX_HOME reaches this server), an agent's hooks missing (session-start or per-prompt) or switched off (Codex's global hooks only when CODEX_HOME reaches this server, which Codex does not pass by default), Claude Code's auto memory still on, or mdmem not on PATH. A [[link]] to a memory not written yet is a note, not a problem: it marks a memory worth writing; so is an agent wired in both scopes, whose global hooks stay silent where its project hooks run. With no store yet, it checks the wiring alone. Returns the problems one per line, or a line with the memory count saying there are none, then a note: line for each note. Problems are findings, not errors: fix a memory with memory_write or memory_delete, and any memory_write or memory_delete also brings a stale index up to date; tell the user about a wiring problem, which the line says how to fix.`,
      inputSchema: z.object({ store: storeParam }),
    },
    // Without a store, it checks the wiring alone (ADR 0004).
    ({ store: id }) =>
      asResult(async () => {
        assertStoreId(storeAt(locateStore(process.cwd())), id);
        return text(
          formatProjectCheck(
            await checkProject({
              ...locateContext(process.cwd()),
              unknownEnv: unknownEnv(server.server.getClientVersion()?.name),
            })
          )
        );
      })
  );

  server.registerTool(
    "memory_read",
    {
      ...titled("Read a memory document", "read"),
      description:
        "Read one memory document by its path in the store — a memory such as prefers-bun.md, or the index, MEMORY.md — and return a line naming the store that answered, Store: <id> (<placement>, <path>), then the document's content, then its version token on a line of its own. Pass that version as if_version to memory_write or memory_delete; the change is then refused if the document changed since you read it.",
      inputSchema: z.object({
        store: storeParam,
        path: z
          .string()
          .describe(
            "the document's path in the store, e.g. prefers-bun.md or MEMORY.md"
          ),
      }),
      outputSchema: documentOutput,
    },
    ({ store: id, path }) =>
      withStore(id, async (store) =>
        documentResult(store, path, await readDocument(store, path))
      )
  );

  server.registerTool(
    "memory_write",
    {
      ...titled("Write a memory document", "change"),
      description:
        "Create or update a memory document with full content, in the memory store named by store (call memory_list with no arguments to see it; omitted means the project's store). With no store yet, the first memory_write creates it, the home store under ~/.mdmem/ unless the project has a local .mdmem/, and the result says which. Overwrites if the path already exists: content replaces the ENTIRE document — this is not an append or a patch. Include every existing line you intend to keep; any line you omit is deleted. The content is a memory — YAML frontmatter with name, description and metadata.type (user, feedback, project or reference), then the body — and its name must equal the path without .md, in kebab-case or snake_case. mdmem keeps MEMORY.md up to date from the memories, so it cannot be written. Use this to save durable knowledge about the project and how to work in it — not transient task state. Always pass if_version: the version token from your most recent memory_read or memory_write of this path, or the literal word new (without quotes) for a file that does not yet exist. The listing shows paths but not version tokens, so for any file already there you must memory_read it first. Writes with if_version=new to an existing path are rejected so you can't overwrite content you haven't seen. Both the rejection and a version conflict return the current content and version so you can merge and retry. The result includes the new version token for follow-up writes, and what the write did to the memory's pointer in MEMORY.md: pointer added, pointer updated or unchanged. Never write secrets or credentials into a memory — the store is shared with every agent on the project, and content that looks like it holds an API key, token, private key or password is refused.",
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
      outputSchema: savedOutput,
    },
    // The first write creates the store the rule names, the home store unless a local one exists (ADR 0005); a refused one creates nothing.
    ({ store: id, path, content, if_version: ifVersion }) =>
      asResult(async () => {
        const location = locateStore(process.cwd());
        assertStoreId(storeAt(location), id);
        checkMemoryWrite(path, content);
        // With no store, no document exists yet, so only a write with if_version new can succeed.
        if (!location.exists && ifVersion !== NEW_FILE_VERSION) {
          throw new VersionConflictError(
            path,
            undefined,
            "the file does not exist"
          );
        }
        const creation = await ensureStore(process.cwd());
        return savedResult(
          await writeDocument(creation.store, path, content, ifVersion),
          creation
        );
      })
  );

  server.registerTool(
    "memory_delete",
    {
      ...titled("Delete a memory document", "change"),
      description:
        "Delete a memory document from the memory store named by store (omitted means the project's store), then update the index. Always pass if_version: the version token from your most recent memory_read or memory_write of this path. If the document changed since, the delete is rejected with its current content and version, so you can decide again. mdmem keeps MEMORY.md up to date from the memories, so it cannot be deleted.",
      inputSchema: z.object({
        store: storeParam,
        path: z
          .string()
          .describe(
            "the memory's path in the store, with no directory, e.g. prefers-bun.md"
          ),
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
        "A consolidation pass over the project's memory store: orient on the existing memories, gather recent signal, merge and correct memories, prune stale ones, and reconcile them with the project's instruction files. Pass agent to point it at that agent's past sessions of the project, and from to fold a second store into this one.",
      argsSchema: z.object({
        agent: z
          .string()
          .optional()
          .describe(
            `the agent running the pass (${adapterIds().join(", ")}): the prompt names where its past sessions of the project are`
          ),
        from: z
          .string()
          .optional()
          .describe(
            "the directory of a second store to fold into this one, such as the home store a local store hides"
          ),
      }),
    },
    ({ agent, from }): GetPromptResult => {
      const adapter = agent === undefined ? undefined : getAdapter(agent);
      if (agent !== undefined && adapter === undefined) {
        throw new Error(unknownAgent(agent));
      }
      const store = resolveStore();
      const fromDir =
        from === undefined
          ? undefined
          : secondStoreDir(process.cwd(), from, store);
      const { project, env, home } = adapterContext(process.cwd(), store);
      const history =
        project === undefined
          ? undefined
          : adapter?.sessionHistory?.({ projectRoot: project.root, env, home });
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: getConsolidatePrompt(store.root, history, fromDir),
            },
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("mdmem MCP server running on stdio\n");
}
