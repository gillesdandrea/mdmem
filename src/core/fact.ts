import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * A fact is the unit of memory: one file, one fact. The format reproduces
 * Claude Code's memory files — YAML frontmatter plus a Markdown body.
 */

export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const frontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
      "name must be kebab-case (a-z, 0-9, hyphens)"
    ),
  description: z.string().min(1),
  metadata: z.object({
    type: z.enum(MEMORY_TYPES),
  }),
});
export type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface Fact {
  frontmatter: Frontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n?/u;

export function parseFact(raw: string): Fact {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error("Fact file is missing YAML frontmatter delimited by `---`");
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

/** `parseFact` for a stored file: a failure names the file, so the reader knows which fact to fix. */
export function parseFactFile(file: string, raw: string): Fact {
  try {
    return parseFact(raw);
  } catch (error) {
    throw new Error(
      `${file}: unparseable — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export function serializeFact(fact: Fact): string {
  const yaml = stringifyYaml(fact.frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${fact.body.trim()}\n`;
}

export function factFileName(name: string): string {
  return `${name}.md`;
}

/** Resolve a user-supplied id — a bare slug or a `<slug>.md` file name — to a file name. */
export function factFileFor(id: string): string {
  return id.endsWith(".md") ? id : factFileName(id);
}
