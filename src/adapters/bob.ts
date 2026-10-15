import { rulesFileAdapter } from "./rules-file.ts";

// IBM Bob loads always-on rules from .bob/rules/*.md; a dedicated file holds the
// memory protocol rendered from templates/memory-protocol.md.
export const bobAdapter = rulesFileAdapter({
  id: "bob",
  title: "IBM Bob",
  rulePath: ".bob/rules/memory.md",
});
