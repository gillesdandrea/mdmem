import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { IGNORE_NOTE } from "../src/adapters/report.ts";
import { reindex } from "../src/core/check.ts";
import { HOOK_PARTS } from "../src/core/hook.ts";
import { claudeProjectDir } from "../src/core/import.ts";
import { projectKey } from "../src/core/key.ts";
import { serializeMemory } from "../src/core/memory.ts";
import { STORE_PAGE_SIZE } from "../src/core/operations.ts";
import { getConsolidatePrompt } from "../src/core/protocol.ts";
import { MemoryStore } from "../src/core/store.ts";
import { gitRepo } from "./git-fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const NEXT_CURSOR_RE = /next cursor: (?<cursor>\S+)/u;

interface Session {
  client: Client;
  store: MemoryStore;
  /** The id mdmem gives the project's store: the project directory's name. */
  storeId: string;
}

/** A server environment whose home and agent config directories are temp folders under `dir`. */
function tempHomeEnv(dir: string): Record<string, string> {
  const home = join(dir, "home");
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  };
}

/**
 * Run `fn` against an mdmem MCP server started in a fresh project with an empty
 * store, by a client named `clientName`, with `env` over the SDK's default
 * environment (else `tempHomeEnv`, so the server never reads the real ~/.claude,
 * ~/.bob or ~/.codex). An `env` replaces `tempHomeEnv` whole, and the SDK's
 * default environment carries the real HOME, so an `env` must set HOME itself.
 */
async function withServer(
  fn: (session: Session) => Promise<void>,
  {
    clientName = "test",
    env,
    setup,
  }: {
    clientName?: string;
    env?: (dir: string) => Record<string, string>;
    /** Prepares the project instead of the default empty store: a repository with no store, say. */
    setup?: (dir: string) => Promise<void>;
  } = {}
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mdmem-mcp-")));
  const store = new MemoryStore(join(dir, ".mdmem"));
  // an empty store for the server to open, unless the test prepares its own project
  await (setup === undefined ? reindex(store) : setup(dir));
  const transport = new StdioClientTransport({
    // bun by its own path, so a test can replace PATH
    command: process.execPath,
    args: [CLI, "mcp"],
    cwd: dir,
    env: (env ?? tempHomeEnv)(dir),
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  try {
    await client.connect(transport);
    await fn({ client, store, storeId: basename(dir) });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The home store of the project at `dir`, under the temp home `tempHomeEnv` gives the server. */
function homeStoreOf(dir: string): MemoryStore {
  return new MemoryStore(join(dir, "home", ".mdmem", projectKey(dir)), dir);
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");
}

/** A server environment with a temp home holding no ~/.codex/hooks.json, and no CODEX_HOME. */
const codexlessEnv = (dir: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: join(dir, "home"),
});

/** Register the mdmem server for Codex in the session's project, then whether memory_check reports Codex's global hook missing. */
async function codexHookProblem({ client, store }: Session): Promise<boolean> {
  const project = dirname(store.root);
  await mkdir(join(project, ".codex"));
  await writeFile(
    join(project, ".codex/config.toml"),
    '[mcp_servers.mdmem]\ncommand = "mdmem"\nargs = ["mcp"]\n',
    "utf-8"
  );
  const result = await client.callTool({ name: "memory_check", arguments: {} });
  return textOf(result).includes("Codex CLI: missing SessionStart hooks");
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

/** The memory note with `description`, so a test can change its description alone. */
function noteDescribed(description: string): string {
  return serializeMemory({
    frontmatter: { name: "note", description, metadata: { type: "project" } },
    body: "x",
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

/** Claude Code's global hook entry for `part`, as `mdmem enable claude-code` writes it. */
function globalClaudeHook(part: string): object {
  return {
    matcher: "startup|clear|compact",
    hooks: [
      { type: "command", command: `mdmem hook claude-code ${part} --global` },
    ],
  };
}

/** A repository with no store, under a home where Claude Code is wired globally and holds a memory of its own for it, with mdmem on PATH. */
async function unstoredRepo(dir: string): Promise<void> {
  await gitRepo(dir);
  const env = tempHomeEnv(dir);
  // Claude Code wired globally: its auto memory off in the user settings, and a memory of its own for the repository
  const config = env.CLAUDE_CONFIG_DIR ?? "";
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      autoMemoryEnabled: false,
      hooks: { SessionStart: HOOK_PARTS.map(globalClaudeHook) },
      permissions: { allow: ["mcp__mdmem"] },
    }),
    "utf-8"
  );
  // mdmem on PATH beside git, so the check does not depend on this machine
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "mdmem"), "#!/bin/sh\n", "utf-8");
  await chmod(join(dir, "bin", "mdmem"), 0o755);
  const memories = join(
    claudeProjectDir(dir, { env, home: env.HOME }),
    "memory"
  );
  await mkdir(memories, { recursive: true });
  await writeFile(join(memories, "b.md"), memory("b", "From Claude."), "utf-8");
}

describe("mcp server", () => {
  test("write then list round-trips over stdio", async () => {
    await withServer(async ({ client, storeId }) => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("memory_write");
      expect(names).toContain("memory_list");
      expect(names).toContain("memory_delete");
      expect(names).toContain("memory_check");
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
      // Claude Code reads a tool's title from annotations.title, so each tool carries it there too, with every hint set.
      const readOnly = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      };
      const changes = {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      };
      const hints: Record<string, object> = {
        memory_list: readOnly,
        memory_search: readOnly,
        memory_check: readOnly,
        memory_read: readOnly,
        memory_write: changes,
        memory_delete: changes,
      };
      expect(names.toSorted()).toEqual(Object.keys(hints).toSorted());
      for (const tool of tools.tools) {
        expect(tool.title).toBeString();
        expect(tool.annotations).toEqual({
          title: tool.title,
          ...hints[tool.name],
        });
      }

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
    await withServer(async ({ client, store, storeId }) => {
      const list = await client.callTool({
        name: "memory_list",
        arguments: {},
      });
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toBe(
        `${storeId} — Shared memory for ${storeId}, the local store ${store.root} — writable — index: MEMORY.md`
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

  test("memory_list with a store lists MEMORY.md even before it is created", async () => {
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

  test("memory_read names the store that answered, then returns a document's content and version by path", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await store.create("prefers-bun.md", "Use bun.");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { store: storeId, path: "prefers-bun.md" },
      });
      const version = await store.version("prefers-bun.md");
      // The structured content carries the whole document: Claude Code shows the agent only it.
      expect(read.structuredContent).toEqual({
        store: { id: storeId, placement: "local", path: store.root },
        path: "prefers-bun.md",
        content: "Use bun.",
        version,
      });
      // The text carries them too, for agents that ignore structuredContent.
      expect(textOf(read)).toBe(
        `Store: ${storeId} (local, ${store.root})\nUse bun.\nversion: ${version}`
      );
    });
  });

  test("memory_read reads the index at MEMORY.md, creating it when missing", async () => {
    await withServer(async ({ client, store }) => {
      await store.create("note.md", memory("note", "x"));
      await store.remove("MEMORY.md");
      const read = await client.callTool({
        name: "memory_read",
        arguments: { path: "MEMORY.md" },
      });
      expect(read.isError).toBeFalsy();
      expect(textOf(read)).toContain("- [note](note.md) — About note\n");
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
      expect(stale.structuredContent).toEqual({
        message:
          'Version conflict on "note.md": the file changed since it was read',
        path: "note.md",
        content: memory("note", "two"),
        version: await store.version("note.md"),
      });
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
      expect(second.structuredContent).toEqual({
        file: "note.md",
        version,
        index: "unchanged",
        warnings: [],
      });
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

  test("memory_write refuses the index path: mdmem keeps the index up to date", async () => {
    await withServer(async ({ client, store }) => {
      const before = await store.view("MEMORY.md");
      const result = await write(
        client,
        "MEMORY.md",
        "# hand-written",
        await store.version("MEMORY.md")
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("mdmem keeps the index up to date");
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
      expect(textOf(result)).toContain("mdmem keeps the index up to date");
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

  test("memory_write refuses a secret, naming its line and kind but never the secret", async () => {
    await withServer(async ({ client, store }) => {
      const token = `ghp_${"a".repeat(36)}`;
      const content = memory(
        "deploy",
        `Deploy with the CLI.\n\nToken: ${token}`
      );
      const line = content.split("\n").findIndex((l) => l.includes(token)) + 1;
      const result = await write(client, "deploy.md", content, "new");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`line ${line} (GitHub token)`);
      expect(textOf(result)).not.toContain(token);
      expect(store.exists("deploy.md")).toBe(false);
    });
  });

  test("memory_write updates the index, warning of a broken memory", async () => {
    await withServer(async ({ client, store }) => {
      await write(client, "note.md", memory("note", "x"), "new");
      expect(await store.view("MEMORY.md")).toContain("[note](note.md)");

      // Another memory is unparseable: it gets no pointer, and the write warns of it.
      await store.create("broken.md", "no frontmatter");
      const result = await write(
        client,
        "other.md",
        memory("other", "y"),
        "new"
      );
      expect(result.isError).toBeFalsy();
      const warning =
        "broken.md: unparseable — Memory file is missing YAML frontmatter delimited by `---` (it has no pointer in MEMORY.md until it parses)";
      expect(textOf(result)).toContain(`Warning: ${warning}`);
      expect(result.structuredContent).toEqual({
        file: "other.md",
        version: await store.version("other.md"),
        index: "pointer added",
        warnings: [warning],
      });
      expect(await store.view("MEMORY.md")).toBe(
        "- [note](note.md) — About note\n- [other](other.md) — About other\n"
      );
    });
  });

  test("memory_write says what it did to the memory's pointer in MEMORY.md: added, updated or unchanged", async () => {
    await withServer(async ({ client }) => {
      const added = await write(client, "note.md", noteDescribed("One"), "new");
      expect(textOf(added)).toContain("\nMEMORY.md: pointer added");
      const same = await write(
        client,
        "note.md",
        `${noteDescribed("One")}More.\n`,
        versionOfResult(added)
      );
      expect(textOf(same)).toContain("\nMEMORY.md: unchanged");
      const updated = await write(
        client,
        "note.md",
        noteDescribed("Two"),
        versionOfResult(same)
      );
      expect(textOf(updated)).toContain("\nMEMORY.md: pointer updated");
      expect(
        [added, same, updated].map(
          (result) => (result.structuredContent as { index: string }).index
        )
      ).toEqual(["pointer added", "unchanged", "pointer updated"]);
    });
  });

  test("memory_delete deletes a document at its version and updates the index", async () => {
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
      expect(textOf(result)).toContain("mdmem keeps the index up to date");
      expect(await store.view("MEMORY.md")).toBe(before);
    });
  });

  test("memory_delete refuses a nested path, leaving the file in place", async () => {
    await withServer(async ({ client, store }) => {
      await mkdir(join(store.root, "notes"));
      await writeFile(join(store.root, "notes/draft.md"), "hi\n");
      const result = await client.callTool({
        name: "memory_delete",
        arguments: {
          path: "notes/draft.md",
          if_version: await store.version("notes/draft.md"),
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        "memories live at the top of the store, and nested files are never indexed or searched"
      );
      expect(store.exists("notes/draft.md")).toBe(true);
    });
  });

  test("memory_search names the store that answered, then lists matching memory documents by path with their description", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await write(client, "uses-bun.md", memory("uses-bun", "Use bun."), "new");
      await write(client, "uses-ts.md", memory("uses-ts", "Use TS."), "new");

      const result = await client.callTool({
        name: "memory_search",
        arguments: { store: storeId, query: "bun" },
      });
      expect(textOf(result)).toBe(
        `Store: ${storeId} (local, ${store.root})\nuses-bun.md — About uses-bun`
      );
    });
  });

  test("memory_search answers from the memories that parse and appends a warning for a broken one", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await write(client, "uses-bun.md", memory("uses-bun", "Use bun."), "new");
      await store.create("broken.md", "no frontmatter, but bun");

      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "bun" },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(
        `Store: ${storeId} (local, ${store.root})\nuses-bun.md — About uses-bun\nWarning: broken.md: unparseable — Memory file is missing YAML frontmatter delimited by \`---\``
      );
    });
  });

  test("memory_check on a clean store reports no problems with the memory count", async () => {
    await withServer(async ({ client, store, storeId }) => {
      await write(client, "uses-bun.md", memory("uses-bun", "Use bun."), "new");

      const result = await client.callTool({
        name: "memory_check",
        arguments: { store: storeId },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(
        `Store: local, ${store.root}\n✓ 1 memory, no problems`
      );
    });
  });

  test("memory_check reports a problem as a finding, not an error, and a link to a memory not written yet as a note", async () => {
    await withServer(async ({ client, store }) => {
      await write(
        client,
        "uses-bun.md",
        memory("uses-bun", "Use bun. See [[gone]]."),
        "new"
      );
      await write(
        client,
        "long.md",
        serializeMemory({
          frontmatter: {
            name: "long",
            description: "x".repeat(150),
            metadata: { type: "project" },
          },
          body: "Body.",
        }),
        "new"
      );

      const result = await client.callTool({
        name: "memory_check",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(
        `Store: local, ${store.root}\nFound 1 problem(s):\n  - long.md: its pointer is 170 characters, over 150 — shorten its description\nnote: uses-bun.md links [[gone]], not written yet`
      );
    });
  });

  test("memory_check under Codex, which does not pass CODEX_HOME, leaves out Codex's global hook unless CODEX_HOME reaches the server", async () => {
    await withServer(
      async (session) => {
        expect(await codexHookProblem(session)).toBe(true);
      },
      { env: codexlessEnv }
    );
    await withServer(
      async (session) => {
        expect(await codexHookProblem(session)).toBe(false);
      },
      { clientName: "codex-mcp-client", env: codexlessEnv }
    );
    // CODEX_HOME passed to the server, as env_vars can: the hook is checked there
    await withServer(
      async (session) => {
        expect(await codexHookProblem(session)).toBe(true);
      },
      {
        clientName: "codex-mcp-client",
        env: (dir) => ({
          ...codexlessEnv(dir),
          CODEX_HOME: join(dir, "codex"),
        }),
      }
    );
  });

  test("memory_check reports an agent config file it cannot read, leaving out Codex's global hooks file under Codex without CODEX_HOME", async () => {
    await withServer(async ({ client, store }) => {
      const project = dirname(store.root);
      await mkdir(join(project, ".claude"));
      await writeFile(
        join(project, ".claude/settings.json"),
        "{ broken",
        "utf-8"
      );
      const result = await client.callTool({
        name: "memory_check",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(
        `Store: local, ${store.root}\nFound 1 problem(s):\n  - Claude Code: .claude/settings.json is not valid JSON (JSON Parse error: Expected '}'): fix it, then run the check again`
      );
    });
    await withServer(
      async (session) => {
        const codexDir = join(dirname(session.store.root), "home/.codex");
        await mkdir(codexDir, { recursive: true });
        await writeFile(join(codexDir, "hooks.json"), "{ broken", "utf-8");
        expect(await codexHookProblem(session)).toBe(false);
        const result = await session.client.callTool({
          name: "memory_check",
          arguments: {},
        });
        expect(textOf(result)).not.toContain("hooks.json");
      },
      { clientName: "codex-mcp-client", env: codexlessEnv }
    );
  });

  test("the prompt consolidate is listed and returns the consolidation prompt for the store", async () => {
    await withServer(async ({ client, store }) => {
      const prompts = await client.listPrompts();
      const listed = prompts.prompts.find((p) => p.name === "consolidate");
      expect(listed?.description).toBeTruthy();

      const prompt = await client.getPrompt({ name: "consolidate" });
      // The server resolves its working directory, so the tmpdir symlink is resolved too.
      const storeDir = await realpath(store.root);
      expect(prompt.messages).toEqual([
        {
          role: "user",
          content: { type: "text", text: getConsolidatePrompt(storeDir) },
        },
      ]);
      const [message] = prompt.messages;
      expect(
        message?.content.type === "text" && message.content.text
      ).toContain(`Memory store: \`${storeDir}\``);
      expect(
        message?.content.type === "text" && message.content.text
      ).toContain("if you can search your own past sessions and need specific");

      // from names a second store to fold in, which must be a directory
      const other = join(dirname(storeDir), "home", ".mdmem", "-other");
      await mkdir(other, { recursive: true });
      const folding = await client.getPrompt({
        name: "consolidate",
        arguments: { from: other },
      });
      expect(folding.messages[0]?.content).toEqual({
        type: "text",
        text: getConsolidatePrompt(storeDir, undefined, other),
      });
      await expect(
        client.getPrompt({
          name: "consolidate",
          arguments: { from: join(other, "nope") },
        })
      ).rejects.toThrow(`${join(other, "nope")} is not a directory`);
    });
  });

  test("the prompt consolidate with an agent returns the CLI's text for that agent, and refuses an unknown one", async () => {
    await withServer(async ({ client, store }) => {
      // The server's environment, as withServer gave it: CODEX_HOME is not resolved through the tmpdir symlink.
      const dir = dirname(store.root);
      const prompt = await client.getPrompt({
        name: "consolidate",
        arguments: { agent: "codex" },
      });
      const cli = Bun.spawnSync(
        [process.execPath, CLI, "consolidate", "--agent", "codex"],
        { cwd: dir, env: { ...process.env, ...tempHomeEnv(dir) } }
      );
      const [message] = prompt.messages;
      const text = message?.content.type === "text" && message.content.text;
      expect(text).toBe(cli.stdout.toString());
      expect(text).toContain(
        `your past sessions are in \`${join(dir, "home", ".codex", "sessions")}/\``
      );
      await expect(
        client.getPrompt({ name: "consolidate", arguments: { agent: "nope" } })
      ).rejects.toThrow('unknown agent "nope". Known: claude-code, bob, codex');
    });
  });

  test("in a repository with no store, reads refuse, memory_check checks the wiring alone, and the first memory_write creates the home store with its project file, importing Claude Code's memories where Claude Code is wired", async () => {
    await withServer(
      async ({ client, store: local }) => {
        const store = homeStoreOf(dirname(local.root));
        const read = await client.callTool({
          name: "memory_read",
          arguments: { path: "MEMORY.md" },
        });
        expect(read.isError).toBe(true);
        expect(textOf(read)).toBe(
          `No store for this project yet: the first memory write (memory_write, \`mdmem add\`) creates the home store ${store.root}`
        );
        const check = await client.callTool({
          name: "memory_check",
          arguments: {},
        });
        expect(textOf(check)).toBe(
          `Store: none yet; the first save creates the home store ${store.root}\n✓ no problems`
        );
        // A write that names a version cannot match a document that does not exist, so it creates nothing.
        const stale = await write(
          client,
          "uses-bun.md",
          memory("uses-bun", "Use bun."),
          "0123456789ab"
        );
        expect(stale.isError).toBe(true);
        expect(textOf(stale)).toContain(
          'Version conflict on "uses-bun.md": the file does not exist'
        );
        expect(existsSync(store.root)).toBe(false);

        const written = await write(
          client,
          "uses-bun.md",
          memory("uses-bun", "Use bun."),
          "new"
        );
        expect(written.isError).toBeUndefined();
        const lines = textOf(written).split("\n");
        expect(lines[0]).toBe(`Created the home store at ${store.root}`);
        expect(lines[1]).toBe("Copied into the store:");
        // git has nothing to ignore in a home store
        expect(lines).not.toContain(IGNORE_NOTE);
        expect(lines).toContain("Saved uses-bun.md");
        // The structured content carries the creation lines too, one field each.
        expect(written.structuredContent).toEqual({
          file: "uses-bun.md",
          version: await store.version("uses-bun.md"),
          index: "pointer added",
          created: {
            store: store.root,
            placement: "home",
            imported: lines.slice(1, lines.indexOf("Saved uses-bun.md")),
          },
          warnings: [],
        });
        expect(store.exists("b.md")).toBe(true);
        expect(store.exists("uses-bun.md")).toBe(true);
        expect(await store.view("project")).toBe(`${store.project}\n`);
        expect(existsSync(local.root)).toBe(false);
      },
      {
        setup: unstoredRepo,
        env: (dir) => ({
          ...tempHomeEnv(dir),
          PATH: `${join(dir, "bin")}:${dirname(Bun.which("git") ?? "/usr/bin/git")}`,
        }),
      }
    );
  });

  test("outside git with no store, the first memory_write creates the home store of the working directory", async () => {
    await withServer(
      async ({ client, store: local }) => {
        const store = homeStoreOf(dirname(local.root));
        const written = await write(
          client,
          "uses-bun.md",
          memory("uses-bun", "Use bun."),
          "new"
        );
        expect(written.isError).toBeUndefined();
        expect(textOf(written)).toStartWith(
          `Created the home store at ${store.root}\nSaved uses-bun.md\n`
        );
        expect(store.exists("uses-bun.md")).toBe(true);
        expect(store.exists("MEMORY.md")).toBe(true);
        expect(
          (written.structuredContent as { created?: { store: string } }).created
            ?.store
        ).toBe(store.root);
      },
      {
        // no repository and no store: the server runs in an empty temp directory outside git
        setup: async () => {},
      }
    );
  });
});
