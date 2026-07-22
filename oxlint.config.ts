import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Domain object key order carries meaning (e.g. name before description).
    "sort-keys": "off",
    // Function declarations are fine; don't mandate expression style.
    "func-style": "off",
    // Sequential fs iteration is intentional — it keeps writes ordered and race-free.
    "no-await-in-loop": "off",
    // Co-locating a small error class with the class it guards is deliberate.
    "max-classes-per-file": "off",
    // Short inline clarifications earn their place.
    "no-inline-comments": "off",
    // Named imports from node builtins are standard and readable.
    "unicorn/import-style": "off",
    // Method signatures read better for an interface that is all methods.
    "typescript/method-signature-style": "off",
  },
});
