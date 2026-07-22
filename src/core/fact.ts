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
  const frontmatter = frontmatterSchema.parse(data);
  const body = raw.slice(match[0].length).trim();
  return { frontmatter, body };
}

export function serializeFact(fact: Fact): string {
  const yaml = stringifyYaml(fact.frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${fact.body.trim()}\n`;
}

export function factFileName(name: string): string {
  return `${name}.md`;
}
