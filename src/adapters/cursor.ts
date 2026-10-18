import { rulesFileAdapter } from "./rules-file.ts";

// Cursor only recognizes .cursor/rules/*.mdc, and needs `alwaysApply: true`
// frontmatter to apply a rule to every session — so the file is the protocol
// behind a small Cursor preamble.
const CURSOR_FRONTMATTER = `---
description: Recall and save memories in the project's memory store (.memory/)
alwaysApply: true
---

`;

export const cursorAdapter = rulesFileAdapter({
  id: "cursor",
  title: "Cursor",
  rulePath: ".cursor/rules/memory.mdc",
  frontmatter: CURSOR_FRONTMATTER,
});
