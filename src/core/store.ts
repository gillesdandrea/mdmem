/* oxlint-disable max-classes-per-file -- the small error class is co-located with the store that throws it */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * MemoryStore is the filesystem behind a `.memory/` directory. It exposes read
 * (`view`), write (`create`), delete (`remove`) and list, each write and delete
 * under an optional version guard that lets a writer detect a lost update on a
 * read-modify-write, or insist on creating a new file (the MCP write path uses
 * it). It holds no policy: what a memory must contain, and the Check that reports
 * problems with memories and the index (GLOSSARY.md), live above it. Its one
 * typed refusal is VersionConflictError, which carries the current content for
 * a merge (ADR 0002, docs/adr/0002-refuse-or-degrade-never-crash.md). The derived
 * index stays off the concurrent-write path entirely (see ./index.ts).
 */

export const STORE_DIR = ".memory";
export const INDEX_FILE = "MEMORY.md";

/** The version a writer passes for a file that must not exist yet. */
export const NEW_FILE_VERSION = "new";

export class VersionConflictError extends Error {
  /** The file's content when the conflict was found; undefined when it does not exist. */
  readonly current: string | undefined;

  constructor(path: string, current: string | undefined, reason: string) {
    super(`Version conflict on "${path}": ${reason}`);
    this.name = "VersionConflictError";
    this.current = current;
  }
}

/** A short content hash used as the optimistic-concurrency token. */
export function versionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** A memory document as a listing shows it: its path in the store, size and last change. */
export interface DocumentInfo {
  path: string;
  size: number;
  updated: Date;
}

export class MemoryStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private full(path: string): string {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Path "${path}" escapes the memory store`);
    }
    return full;
  }

  private async assertVersion(
    path: string,
    ifVersion: string | undefined
  ): Promise<void> {
    if (ifVersion === undefined) {
      return;
    }
    const current = this.exists(path)
      ? await readFile(this.full(path), "utf-8")
      : undefined;
    if (ifVersion === NEW_FILE_VERSION) {
      if (current !== undefined) {
        throw new VersionConflictError(
          path,
          current,
          "the file already exists"
        );
      }
      return;
    }
    if (current === undefined) {
      throw new VersionConflictError(path, current, "the file does not exist");
    }
    if (versionOf(current) !== ifVersion) {
      throw new VersionConflictError(
        path,
        current,
        "the file changed since it was read"
      );
    }
  }

  exists(path: string): boolean {
    return existsSync(this.full(path));
  }

  async version(path: string): Promise<string> {
    return versionOf(await readFile(this.full(path), "utf-8"));
  }

  /** Read a file in the store. */
  async view(path: string): Promise<string> {
    return await readFile(this.full(path), "utf-8");
  }

  async create(
    path: string,
    content: string,
    ifVersion?: string
  ): Promise<void> {
    await this.assertVersion(path, ifVersion);
    const full = this.full(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf-8");
  }

  async remove(path: string, ifVersion?: string): Promise<void> {
    await this.assertVersion(path, ifVersion);
    await rm(this.full(path));
  }

  /** Top-level memory files: every `*.md` except the generated index. */
  async listMemoryFiles(): Promise<string[]> {
    if (!existsSync(this.root)) {
      return [];
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter(
        (e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE
      )
      .map((e) => e.name)
      .toSorted();
  }

  /** Top-level memory documents: every `*.md`, the index included, sorted by path. */
  async listDocuments(): Promise<DocumentInfo[]> {
    if (!existsSync(this.root)) {
      return [];
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    const paths = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .toSorted();
    return Promise.all(
      paths.map(async (path) => {
        const info = await stat(this.full(path));
        return { path, size: info.size, updated: info.mtime };
      })
    );
  }
}

/** Walk up from `startDir` to the first existing `.memory/` directory. */
export function findStoreRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, STORE_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Walk up to the enclosing project root (`.git` or `package.json`), else `startDir`. */
export function findProjectRoot(startDir: string): string {
  const start = resolve(startDir);
  let dir = start;
  for (;;) {
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}
