# Bead workflows

How the bead workflows (`bead-plan`, `bead-batches`, `bead-triage`) run in this repo. The scripts are shared with other repos and live outside it, on the `bead-workflows` branch of gda-skills. `.claude/workflows/` holds thin local wrappers that pass this repo's path. The scripts read the JSON block below, and each of its fields replaces the scripts' default. A run's `config` argument overrides it.

Batches are squash-merged straight onto local `main`, with no PR and no landing step. The scripts never push: `origin` is pushed by hand. Plain git worktrees go under `.claude/worktrees`, on `wf/*` branches. Each squash commit ends with its bead ids, which is how `/code-review` finds the spec. After each merge, the main checkout reinstalls its dependencies, because `bun link` points the `mdmem` on your PATH at it.

Follow-ups go under the parent epic of the batch's first bead. Labels follow [triage-labels.md](./triage-labels.md): every leaf labelled `ready-for-agent` also carries `afk` or `hitl`, and only `afk` beads are planned into runs.

```json
{
  "check": "bun run all:check",
  "fix": "bun run fix",
  "setup": "bun install --frozen-lockfile",
  "target": "default",
  "land": "none",
  "remote": false,
  "commitRef": "trailer",
  "afterMerge": "bun install --frozen-lockfile",
  "planDir": ".scratch/bead-plans"
}
```
