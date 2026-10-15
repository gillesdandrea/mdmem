/**
 * Obvious credentials a memory must never hold: the store is shared with every
 * agent on the project, and Claude Code refuses such writes in every store. This
 * catches the common shapes of keys and tokens; it is not a secret scanner.
 */

/** One kind of secret and the pattern that finds it on a line. */
interface SecretPattern {
  kind: string;
  pattern: RegExp;
}

/** Ordered so the more specific prefix names the kind (an Anthropic key before a generic `sk-` key). */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u,
  },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  {
    kind: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/u,
  },
  { kind: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/u },
  {
    // Legacy keys are plain alphanumerics; only the prefixed kinds carry `_` and `-`, so hyphenated words like `sk-learn-…` don't match.
    kind: "OpenAI API key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})/u,
  },
  { kind: "Stripe key", pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/u },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { kind: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}/u },
  {
    kind: "JSON Web Token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  },
  {
    // A literal value assigned to a secret-named key, prefixed or not (`DB_PASSWORD=`, `GITHUB_TOKEN=`); `$VAR`, `process.env.VAR`, `<placeholder>` and `{template}` values are references, and `/`, `~` or `.` starts a path, not a secret.
    kind: "secret in an assignment",
    pattern:
      /(?<![A-Za-z])(?:password|passwd|pwd|secret|secret[_-]?(?:access[_-]?)?key|api[_-]?key|token|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'`]?(?![$<{%*/~.]|process\.env|import\.meta\.env|os\.environ|os\.getenv)[^\s"'`]{6,}/iu,
  },
];

/** A line that looks like it holds a secret, and the kind of secret. */
export interface SecretMatch {
  /** 1-based line number in the text. */
  line: number;
  kind: string;
}

/** The lines of `text` that look like they hold a secret, at most one match per line. */
export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const found = SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
    if (found) {
      matches.push({ line: index + 1, kind: found.kind });
    }
  }
  return matches;
}

/** Where the secrets are, by line and kind, never quoting the secret itself. */
export function describeSecrets(matches: SecretMatch[]): string {
  return matches.map(({ line, kind }) => `line ${line} (${kind})`).join(", ");
}

/** Refuse `content` for `file` if any line looks like it holds a secret. */
export function assertNoSecrets(file: string, content: string): void {
  const matches = findSecrets(content);
  if (matches.length > 0) {
    throw new Error(
      `Refused "${file}": it looks like it holds a secret at ${describeSecrets(matches)}. Memories are shared with every agent on the project, so never save secrets or credentials in one; say where the secret is kept instead`
    );
  }
}
