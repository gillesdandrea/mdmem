# Issue tracker: Beads

Issues and specs for this repo live as beads in `.beads/`, managed with the `bd` CLI. GitHub Issues on `gillesdandrea/mdmem` are not used to track work.

## Conventions

- **Create a bead**: `bd create --title "..." --type task|bug|feature|epic --priority 2 --body-file <file>`. Bodies are GitHub-flavored markdown; past one sentence, write the body to a file, because inline `-d "…"` text lands as one unbroken line.
- **Read a bead**: `bd show <id>`, or `bd show <id> --json --include-comments`.
- **List beads**: `bd list --status open --json`, filtered with `--label`, `--label-any`, `--exclude-label` and `--parent`.
- **Make a bead a child of a parent**: `bd create --parent <parent-id> ...`.
- **Comment on a bead**: `bd comments add <id> -f <file>` (or inline text for one sentence).
- **Apply / remove labels**: `bd label add <id> <label>` / `bd label remove <id> <label>`. Labels need no creation step.
- **Block one bead on another**: `bd dep add <blocked> <blocker>`.
- **Close**: `bd close <id> --reason-file <file>` (or `--reason "..."`). Work closes with `bd close`, not through pull requests.

Bead ids look like `<prefix>-<hash>`. Where a skill says `#42`, read it as a bead id.

## When a skill says "publish to the issue tracker"

Create a bead. A spec is an `epic`; the tickets cut from it are its children (`--parent <spec-id>`), ordered with `bd dep add`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read a bead** above, comments included.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic bead with **child** beads as tickets.

- **Map**: an `epic` bead labelled `wayfinder:map`, its description holding the Notes / Decisions-so-far / Fog body. Rewrite it with `bd update <map-id> --body-file <file>`.
- **Child ticket**: `bd create --parent <map-id> --labels wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: `bd dep add <child> <blocker>`. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `bd ready --parent <map-id> --unassigned --sort oldest --json`; the first result wins.
- **Claim**: `bd update <id> --claim`, the session's first write.
- **Resolve**: `bd comments add <id> -f <answer-file>`, then `bd close <id>`, then append a context pointer (gist + bead id) to the map's Decisions-so-far.
