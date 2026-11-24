# Bead workflows

How the bead workflows (`bead-plan`, `bead-batches`, `bead-triage`) run in this repo. The scripts are shared with other repos and live outside it, on the `bead-workflows` branch of gda-skills. `.claude/workflows/` holds thin local wrappers that pass this repo's path. The scripts read the JSON block below, and each of its fields replaces the scripts' default. A run's `config` argument overrides it.

The workflows are not yet adapted to a `main` that changes through pull requests only: the settings below land each batch with a squash merge onto local `main`. Until they are adapted, `bead-triage` runs as before, since it only reads and writes beads. `bead-batches` does not run, and neither does `bead-plan`, whose plans only `bead-batches` reads.

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
  "afterMerge": "bun install --frozen-lockfile && bun run build",
  "planDir": ".scratch/bead-plans"
}
```
