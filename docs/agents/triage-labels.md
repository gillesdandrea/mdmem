# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the bead labels used in this repo.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Mode: `afk` or `hitl`

How an agent-run bead runs. Exactly one on every leaf labelled `ready-for-agent`. A `ready-for-human` leaf carries no mode label.

| Label  | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `afk`  | The agent works alone; the human reviews the result at the end.               |
| `hitl` | The human gates each step, or must be present for a live check or a demo.     |

Readiness says whether work can start; mode says who is in the loop while it runs. The bead workflows ([workflows.md](./workflows.md)) plan only `afk` beads.
