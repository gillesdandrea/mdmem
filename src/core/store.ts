/* oxlint-disable max-classes-per-file -- the small error class is co-located with the store that throws it */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { repositoryRoot } from "./git.ts";
import { RefusalError } from "./refusal.ts";

/**
 * MemoryStore is the filesystem behind a `.memory/` directory. It exposes read
 * (`view`), write (`create`), delete (`remove`) and list, each write and delete
 * under an optional version guard that lets a writer detect a lost update on a
 * read-modify-write, or insist on creating a new file (the document operations
 * in ./operations.ts always pass one). It holds no policy: what a memory must
 * contain, and the Check that reports problems with memories and the index
 * (GLOSSARY.md), live above it. It refuses a path that escapes the store, and a
 * write or delete against a version the caller has not seen with
 * VersionConflictError, which carries the current content for a merge (ADR 0002,
 * docs/adr/0002-refuse-or-degrade-never-crash.md). Which file is the index, and
 * how it is kept up to date from the memories, is the business of ./check.ts.
 */

export const STORE_DIR = ".memory";

/** The version a writer passes for a file that must not exist yet. */
export const NEW_FILE_VERSION = "new";

export class VersionConflictError extends RefusalError {
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
      throw new RefusalError(`Path "${path}" escapes the memory store`);
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

  /** Top-level memory documents' paths: every `*.md`, the index included, sorted. */
  async listFiles(): Promise<string[]> {
    if (!existsSync(this.root)) {
      return [];
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .toSorted();
  }

  /** Top-level memory documents: every `*.md`, the index included, sorted by path. */
  async listDocuments(): Promise<DocumentInfo[]> {
    const paths = await this.listFiles();
    return Promise.all(
      paths.map(async (path) => {
        const info = await stat(this.full(path));
        return { path, size: info.size, updated: info.mtime };
      })
    );
  }
}

/**
 * Where a project's store is: `root` is the project directory, `dir` its `.memory/`,
 * and `exists` whether that directory is there yet.
 */
export interface StoreLocation {
  root: string;
  dir: string;
  exists: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function storeAt(root: string): StoreLocation {
  const dir = join(root, STORE_DIR);
  return { root, dir, exists: isDirectory(dir) };
}

/** The real path of `path`, symlinks resolved; `path` resolved, when it cannot be (it does not exist, say). */
export function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The store of the project holding `startDir`. In git, the project is the repository
 * (./git.ts says which directory keys it), so every worktree, subdirectory and submodule
 * shares one store and a `.memory/` lower down is ignored. Without git, it is the first
 * directory holding a `.memory/`, walking up from `startDir` and stopping before the home
 * directory (unless `startDir` is the home directory), else `startDir` itself, where
 * `mdmem init` creates one.
 */
export function locateStore(
  startDir: string,
  home: string = homedir()
): StoreLocation {
  const start = realDir(startDir);
  const repository = repositoryRoot(start);
  if (repository !== null) {
    return storeAt(repository);
  }
  const stop = realDir(home);
  let dir = start;
  for (;;) {
    if (dir === stop && dir !== start) {
      break;
    }
    const location = storeAt(dir);
    if (location.exists) {
      return location;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return storeAt(start);
}
