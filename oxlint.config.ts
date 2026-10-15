import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Keys follow semantic order (e.g. name before description), not alphabetical.
    "sort-keys": "off",
    // Function declarations are fine; hoisting keeps the CLI's command table readable.
    "func-style": "off",
    // Named imports from node builtins are standard and readable.
    "unicorn/import-style": "off",
  },
});
