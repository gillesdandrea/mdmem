/**
 * Build the package npm ships: `dist/index.js`, run by Node, and the chunks it
 * loads (the MCP server's is loaded on `mdmem mcp` only). Dependencies stay
 * external, so `npm install` provides them. Run by `bun run build`.
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const DIST = "dist";
const BUN_API = /\bBun\./u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

// The built code runs on Node: a Bun API in src/ would fail there.
const usingBun = sourceFiles(SRC).filter((file) =>
  BUN_API.test(readFileSync(file, "utf-8"))
);
if (usingBun.length > 0) {
  throw new Error(
    `Bun APIs in ${usingBun.join(", ")}: the package runs on Node`
  );
}

rmSync(DIST, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(SRC, "cli", "index.ts")],
  outdir: DIST,
  target: "node",
  packages: "external",
  splitting: true,
  banner: "#!/usr/bin/env node",
});
if (!result.success) {
  throw new AggregateError(result.logs, "build failed");
}
for (const output of result.outputs) {
  process.stdout.write(`${output.path} ${output.size} bytes\n`);
}
