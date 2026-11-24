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
import { projectKey } from "./key.ts";
import { RefusalError } from "./refusal.ts";

/**
 * MemoryStore is the filesystem behind a store's directory, a home store under
 * `~/.mdmem/` or a local store at `.mdmem/` (ADR 0005). It exposes read
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

/** The local store's directory at a project's root, and the home stores' directory under the home directory. */
export const STORE_DIR = ".mdmem";

/** The file in a store naming the project root it serves; not a memory, since it is not `*.md`. */
export const PROJECT_FILE = "project";

/** The version a writer passes for a file that must not exist yet. */
export const NEW_FILE_VERSION = "new";

export class VersionConflictError extends RefusalError {
  /** The path the conflict is on. */
  readonly path: string;
  /** The file's content when the conflict was found; undefined when it does not exist. */
  readonly current: string | undefined;

  constructor(path: string, current: string | undefined, reason: string) {
    super(`Version conflict on "${path}": ${reason}`);
    this.name = "VersionConflictError";
    this.path = path;
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
  /** The store's directory. */
  readonly root: string;
  /** The project root the store serves; by default the directory holding it, as a local store's. */
  readonly project: string;

  constructor(root: string, project?: string) {
    this.root = resolve(root);
    this.project =
      project === undefined ? dirname(this.root) : resolve(project);
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

/** Where a project's store lives (GLOSSARY.md): in the home directory, or at the project's root. */
export const PLACEMENTS = ["home", "local"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * Where a project's store is (ADR 0005): `root` is the project, `dir` the store the
 * rule names, `placement` which of the two that is, and `exists` whether `dir` is
 * there yet. `local` and `home` are both placements' directories, whichever is used.
 */
export interface StoreLocation {
  root: string;
  dir: string;
  placement: Placement;
  exists: boolean;
  local: string;
  home: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The real path of `path`, symlinks resolved; `path` resolved, when it cannot be (it does not exist, say). */
export function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The directory holding every home store: `~/.mdmem`. */
export function homeStoresDir(home: string = homedir()): string {
  return join(home, STORE_DIR);
}

/** The home store of the project at `root`: `~/.mdmem/<key>`. */
export function homeStoreOf(root: string, home: string = homedir()): string {
  return join(homeStoresDir(home), projectKey(root));
}

/**
 * The store of the project holding `startDir` (ADR 0005). The project's root is the
 * repository (./git.ts says which directory keys it), so every worktree, subdirectory
 * and submodule shares one store; outside git it is `startDir` itself, with no
 * walk-up. The store is the local one, `<root>/.mdmem/`, when that directory exists,
 * else the home one, `~/.mdmem/<key>/`, keyed by ./key.ts. In the home directory
 * itself, `~/.mdmem` holds the home stores, so it is never a local store.
 */
export function locateStore(
  startDir: string,
  home: string = homedir()
): StoreLocation {
  const start = realDir(startDir);
  const root = repositoryRoot(start) ?? start;
  const local = join(root, STORE_DIR);
  const stores = homeStoresDir(home);
  const homeDir = homeStoreOf(root, home);
  const isLocal = isDirectory(local) && realDir(local) !== realDir(stores);
  const dir = isLocal ? local : homeDir;
  return {
    root,
    dir,
    placement: isLocal ? "local" : "home",
    exists: isLocal || isDirectory(homeDir),
    local,
    home: homeDir,
  };
}

/** The store at `location`, serving its project. */
export function storeAt(location: StoreLocation): MemoryStore {
  return new MemoryStore(location.dir, location.root);
}

/** A store's placement: local when it is `.mdmem/` at its project's root, else home. */
export function placementOf(store: MemoryStore): Placement {
  return store.root === join(store.project, STORE_DIR) ? "local" : "home";
}

/** A store's line, as every surface prints it: `Store: home, <dir>` or `Store: local, <dir>`. */
export function placementLine(store: MemoryStore): string {
  return `Store: ${placementOf(store)}, ${store.root}`;
}

/** The line for a project with no store yet, naming the home store `home` the first save creates. */
export function noStoreLine(home: string): string {
  return `Store: none yet; the first save creates the home store ${home}`;
}

/** The project's store line: its placement and path, or the home store the first save creates. */
export function locationLine(location: StoreLocation): string {
  return location.exists
    ? `Store: ${location.placement}, ${location.dir}`
    : noStoreLine(location.home);
}
