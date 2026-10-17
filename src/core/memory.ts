import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * A memory is one Markdown file holding one fact. The format reproduces
 * Claude Code's memory files — YAML frontmatter plus a Markdown body.
 */

export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * A memory's frontmatter as mdmem reads it: as loosely as Claude Code writes it
 * (ADR 0001). The name is any non-empty string, the type sits under `metadata` or at
 * the top level, and unknown fields, nested or not, are kept. What mdmem itself
 * writes is stricter: see `MEMORY_NAME_RE`.
 */
export const frontmatterSchema = z
  .looseObject({
    name: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(MEMORY_TYPES).optional(),
    metadata: z
      .looseObject({ type: z.enum(MEMORY_TYPES).optional() })
      .nullish(),
  })
  .refine(
    (frontmatter) =>
      frontmatter.metadata?.type !== undefined ||
      frontmatter.type !== undefined,
    { message: "a memory type is required, in metadata.type or type" }
  );
export type Frontmatter = z.infer<typeof frontmatterSchema>;

/** The names mdmem writes: lowercase words of letters and digits, joined by `-` or `_`. */
export const MEMORY_NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;

export interface Memory {
  frontmatter: Frontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n?/u;

export function parseMemory(raw: string): Memory {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(
      "Memory file is missing YAML frontmatter delimited by `---`"
    );
  }
  const data: unknown = parseYaml(match.groups?.yaml ?? "");
  const result = frontmatterSchema.safeParse(data);
  if (!result.success) {
    // One line per problem, not zod's JSON dump: this text reaches users.
    throw new Error(
      result.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "frontmatter"}: ${issue.message}`
        )
        .join("; ")
    );
  }
  const body = raw.slice(match[0].length).trim();
  return { frontmatter: result.data, body };
}

/** `parseMemory` for a stored file: a failure names the file, so the reader knows which memory to fix. */
export function parseMemoryFile(file: string, raw: string): Memory {
  try {
    return parseMemory(raw);
  } catch (error) {
    throw new Error(
      `${file}: unparseable — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export function serializeMemory(memory: Memory): string {
  const yaml = stringifyYaml(memory.frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${memory.body.trim()}\n`;
}

export function memoryFileName(name: string): string {
  return `${name}.md`;
}

/** Resolve a user-supplied name — a bare name or a `<name>.md` file name — to a file name. */
export function memoryFileFor(name: string): string {
  return name.endsWith(".md") ? name : memoryFileName(name);
}
