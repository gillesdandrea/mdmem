import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Prose keeps its authors' wrapping; templates/ is copied verbatim into
  // users' instruction files; bd writes .beads/ itself. The formatter owns
  // source and config only.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/*.md", ".beads/**"],
});
