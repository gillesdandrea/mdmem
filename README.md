# mdmem

One memory per project, shared by your coding agents.

mdmem gives Claude Code, Codex CLI and IBM Bob the same memory. What one agent
learns about a project, the others know in their next session, in every
worktree. Memories are Markdown files in Claude Code's format, kept in your
home directory or committed with the project.

## Install

mdmem needs Node 22 or later.

```bash
npm install -g @gillesdandrea/mdmem
mdmem enable --all
```

`mdmem enable --all` wires the agents it finds on your machine, once, for every
project. Keep `mdmem` on your PATH, because the agents run it. Codex asks you
to review mdmem's hooks at its next interactive start, and has no memory until
you do.

## Try it

Start a new session in your agent, in any project, and ask:

> What is your memory system?

It should describe mdmem. Then give it something to keep:

> Remember that I want a short summary at the end of each task.

Open a new session, or another agent, in the same project and ask:

> What do you remember about me and this project?

## What it does

- **One store per project.** A store is a directory of Markdown memories with
  an index, `MEMORY.md`. A repository shares one store with its worktrees and
  subdirectories. Outside git, the project is the directory you work in.
- **Recall.** Each session starts with the index and the rules for saving.
  Before each prompt, the agent is pointed at the memories that changed or bear
  on the prompt.
- **Saving.** Agents save through mdmem's MCP server. It refuses a write over a
  version the agent has not read, so two agents do not overwrite each other.
- **No setup per project.** The first save creates the store in `~/.mdmem/`.
  If Claude Code already kept memories for the project, mdmem imports them
  then.

## What `enable` changes

`mdmem enable --all` adds mdmem's hooks and MCP server to each agent's
user-wide files:

| Agent | Files |
|---|---|
| Claude Code | `~/.claude/settings.json`, `~/.claude.json` |
| Codex CLI | `~/.codex/hooks.json`, `~/.codex/config.toml` |
| IBM Bob | `~/.bob/settings/settings.json`, `~/.bob/settings/mcp.json` |

It also turns Claude Code's own auto memory off on the whole machine, because
that memory and the store would compete. Codex's own memory stays on.

`mdmem disable --all` removes exactly what `enable` added and leaves your
memories. The entries and each agent's rules are in the
[reference](docs/reference.md#enable-and-disable).

## Share with your team

The store in your home directory is shared by your agents, not by your
teammates. `mdmem store local` moves it to `.mdmem/` in the repository. Commit
that directory and your teammates get the memories with the code. See
[Sharing mdmem with a team](docs/team.md).

## When it does not work

Run `mdmem status` in the project. It shows the store and each agent's wiring,
and each warning says how to fix what it reports. If an agent still has no
memory, see [Troubleshooting](docs/troubleshooting.md).

## More

- [Reference](docs/reference.md): the store, the memory format, every command,
  each agent's wiring, the MCP tools and consolidation.
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md): running mdmem from a checkout, and
  releasing.

## License

[MIT](LICENSE) © Gilles d'Andrea
