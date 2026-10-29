import { adapterIds } from "../adapters/index.ts";
import { HOOK_AGENTS, HOOK_PARTS } from "../core/hook.ts";
import { MEMORY_TYPES } from "../core/memory.ts";

/**
 * The CLI's help: the top-level page, which lists the commands in three groups by
 * who runs them, one line each, and one page per command with its options, an
 * example and the refusals it can give. The words are the glossary's
 * (GLOSSARY.md): store, memory, index, wiring, scope, check, note, consolidation.
 */

export const USAGE_LINE = "Usage: mdmem <command> [options]";
export const HELP_FOOTER =
  "Use mdmem <command> --help for a command's arguments and flags.";

const TAGLINE = "mdmem: shared, Claude-style memory for any coding agent";
const WRAP_WIDTH = 80;

type Row = readonly [string, string];

/** A titled block of a page: aligned two-column rows, or plain lines. */
interface Section {
  heading: string;
  rows?: readonly Row[];
  lines?: readonly string[];
}

interface CommandPage {
  usage: string;
  /** Two or three sentences: what the command does and when to run it. */
  about: string;
  /** Blocks between the paragraph and the example: options, scopes, files. */
  sections?: readonly Section[];
  example: string;
  /** One line per refusal, or one line saying the command never refuses. */
  refuses: readonly string[];
}

const SCOPES: Section = {
  heading: "Scopes:",
  rows: [
    [
      "global",
      "The default: the agent's user-wide files, which it reads in every project",
    ],
    [
      "project",
      "With --project: the repository's files, meant to be committed with it",
    ],
  ],
};

const WIRING_FILES: Section = {
  heading: "Files, in the global scope, then the project scope:",
  rows: [
    [
      "claude-code",
      "~/.claude/settings.json and ~/.claude.json ($CLAUDE_CONFIG_DIR when set); .claude/settings.json and .mcp.json",
    ],
    [
      "bob",
      "~/.bob/settings/settings.json and ~/.bob/settings/mcp.json; .bob/settings.json and .bob/mcp.json",
    ],
    [
      "codex",
      "~/.codex/hooks.json and ~/.codex/config.toml ($CODEX_HOME when set); .codex/hooks.json and .codex/config.toml",
    ],
  ],
};

const WIRING_REFUSALS = [
  "no agent is named and --all is not given, or both are",
  "an agent is unknown",
  "--global or --prefer is given: both are gone, and the refusal names what replaced them",
  "a file it would change does not parse",
  "a key on the path to one of mdmem's entries is not an object, or in TOML a table",
];

const AGENTS: Section = {
  heading: "Agents:",
  lines: [adapterIds().join(", ")],
};

const NO_STORE = "there is no store yet";
const NO_NAME_GIVEN = "no name is given";
const INDEX_OR_NESTED = "the name is the index's, or a path inside a directory";

const PAGES: Record<string, CommandPage> = {
  enable: {
    usage: "mdmem enable <agent…> | --all [--project]",
    about:
      "Wire agents to mdmem in one scope: their session-start hooks, their per-prompt hook and the mdmem MCP server, and for Claude Code its auto memory turned off and the mdmem tools' permission. Neither scope needs a store or creates one: the first memory saved creates it. Every agent is planned before any file is written, so a refusal leaves every file as it was, and running it again changes nothing.",
    sections: [
      {
        heading: "Options:",
        rows: [
          [
            "--all",
            "Wire the agents found on this machine, by their command on PATH or config directory",
          ],
          ["--project", "Wire the project scope instead of the global one"],
        ],
      },
      SCOPES,
      WIRING_FILES,
      AGENTS,
    ],
    example: "mdmem enable claude-code codex --project",
    refuses: [
      ...WIRING_REFUSALS,
      "a key of mdmem's holds another value, such as another mcpServers.mdmem or autoMemoryEnabled: true",
      "with --project, in a bare repository or the folder holding one",
      "with --project, in the home directory, which the global scope wires",
    ],
  },
  disable: {
    usage: "mdmem disable <agent…> | --all [--project]",
    about:
      "Remove exactly mdmem's wiring from agents in one scope, leaving everything else in their files as it was. It needs no store and leaves the store as it is, so it works after the store was deleted.",
    sections: [
      {
        heading: "Options:",
        rows: [
          ["--all", "Unwire the agents found on this machine"],
          ["--project", "Unwire the project scope instead of the global one"],
        ],
      },
      SCOPES,
      WIRING_FILES,
      AGENTS,
    ],
    example: "mdmem disable bob --project",
    refuses: [
      ...WIRING_REFUSALS,
      "with --project, in the home directory, which the global scope wires",
    ],
  },
  status: {
    usage: "mdmem status",
    about:
      "Show the store and its placement, or the home store the first memory write creates, the check in one line, whether git ignores a local store, and each agent's wiring in each scope, entry by entry. Warnings follow for memories in a home store a local store hides, for what mdmem cannot check, and for wiring an agent started here would not get.",
    example: "mdmem status",
    refuses: ["never: it shows what it finds and exits 0"],
  },
  doctor: {
    usage: "mdmem doctor",
    about:
      "Run a check, also as mdmem check: name the store and its placement, then report every problem with the store's memories and index, and with the agents' wiring in both scopes. With no store, it checks the wiring alone. A link to a memory not written yet is a note, not a problem, as is an agent wired in both scopes.",
    example: "mdmem doctor",
    refuses: [
      "never: it exits 1 when the check finds a problem, and 0 when notes are its only findings",
    ],
  },
  consolidate: {
    usage: "mdmem consolidate [--agent <agent>] [--from <dir>]",
    about:
      "Print a prompt that has an agent consolidate the store: merge, correct and prune its memories. Pass it to an agent session, as in the example. With --from, the prompt also has the agent fold a second store into this one, then delete it.",
    sections: [
      {
        heading: "Options:",
        rows: [
          [
            "--agent <agent>",
            "Point the prompt at that agent's past sessions of the project",
          ],
          [
            "--from <dir>",
            "Fold the store at <dir> into this one, such as the home store a local store hides",
          ],
        ],
      },
      {
        heading: "Past sessions, by agent:",
        rows: [
          [
            "claude-code",
            "its project directory in $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects",
          ],
          [
            "codex",
            "the sessions in $CODEX_HOME/sessions or ~/.codex/sessions whose cwd is the project",
          ],
          ["bob", "keeps the generic line"],
        ],
      },
    ],
    example: 'codex "$(mdmem consolidate --agent codex)"',
    refuses: [
      NO_STORE,
      "--agent names an unknown agent",
      "--from names no directory, or this store's",
    ],
  },
  add: {
    usage:
      "mdmem add --type <type> --name <name> --description <text> [--body <text>] [--force]",
    about:
      "Save a memory and add its pointer to the index. The body comes from --body, or from stdin when it is piped. With no store yet, the first save creates the home store, ~/.mdmem/<key>, and says so; mdmem store local moves it into the project.",
    sections: [
      {
        heading: "Options:",
        rows: [
          ["--type <type>", `The memory type: ${MEMORY_TYPES.join(", ")}`],
          [
            "--name <name>",
            "The memory's name, in kebab-case or snake_case; the file is <name>.md",
          ],
          [
            "--description <text>",
            "The one-line summary an agent reads to decide what to recall",
          ],
          ["--body <text>", "The memory's body, instead of stdin"],
          ["--force", "Overwrite the memory with that name"],
        ],
      },
    ],
    example:
      'mdmem add --type feedback --name use-bun --description "Run scripts with bun, not npm" --body "The lockfile is bun.lock."',
    refuses: [
      "--type is missing or not a memory type",
      "--name or --description is missing",
      "the name is not kebab-case or snake_case, is the index's, or holds a directory",
      "the memory does not parse, such as an empty description",
      "the memory looks like it holds a secret",
      "a memory with that name exists and --force is not given",
      "with --force, the memory changes while it is saved",
    ],
  },
  read: {
    usage: "mdmem read <name>",
    about:
      "Print one memory, by its name or <name>.md. mdmem read MEMORY.md prints the index.",
    example: "mdmem read use-bun",
    refuses: [
      NO_NAME_GIVEN,
      NO_STORE,
      "no memory has that name",
      "the path leads outside the store",
    ],
  },
  edit: {
    usage: "mdmem edit <name>",
    about:
      "Open a copy of a memory in $VISUAL or $EDITOR, then save it back and update the index. A refused save leaves the store as it was and prints where your copy is kept. With neither variable set, it prints the memory's path: edit the file by hand, then run mdmem reindex.",
    example: "mdmem edit use-bun",
    refuses: [
      NO_NAME_GIVEN,
      NO_STORE,
      INDEX_OR_NESTED,
      "no memory has that name",
      "the editor exits with an error",
      "the editor removed the copy, so there is no edit to read",
      "the edit does not parse, changes the memory's name, or looks like it holds a secret",
      "the memory changes while you edit it",
    ],
  },
  delete: {
    usage: "mdmem delete <name>",
    about:
      "Delete a memory, by its name or <name>.md, and remove its pointer from the index. The alias rm does the same.",
    example: "mdmem delete use-bun",
    refuses: [
      NO_NAME_GIVEN,
      NO_STORE,
      INDEX_OR_NESTED,
      "no memory has that name",
      "the memory changes while it is deleted",
    ],
  },
  list: {
    usage: "mdmem list",
    about:
      "Print the index: one pointer per memory, as agents read it at the start of every session. A missing index is created first.",
    example: "mdmem list",
    refuses: [NO_STORE],
  },
  search: {
    usage: "mdmem search [--] <word>...",
    about:
      "Print the memories whose name, description, headings or body hold the words of the query, each word stemmed and matched on its own, best match first, each with its description; quote text to require it as an exact phrase, and common function words are ignored. The arguments are the words of the query, quoted or not. A memory that does not parse is left out and named in a warning. Put -- before a query that is -h or --help.",
    example: "mdmem search bun tests",
    refuses: ["no query is given", NO_STORE],
  },
  reindex: {
    usage: "mdmem reindex",
    about:
      "Bring the index up to date with the memories, keeping its lines that are not pointers. Run it after editing a memory by hand. A memory that does not parse keeps the pointer it has and is named in a warning.",
    example: "mdmem reindex",
    refuses: [NO_STORE],
  },
  path: {
    usage: "mdmem path",
    about:
      "Print the absolute path of the project's store, home or local. It finds the store from any folder of the project, as the other commands do; mdmem store also names the placement.",
    example: 'cd "$(mdmem path)"',
    refuses: [NO_STORE],
  },
  hook: {
    usage: "mdmem hook <agent> <part> [--global]",
    about:
      "Run by an agent's hooks, not typed by hand: read the hook's payload on stdin and print the memory protocol or the index at session start, or, before each prompt, pointers to the memories that changed or bear on it. It speaks in every directory, git or not; with no store yet, the index part names the home store the first save creates. Where it prints nothing, one line on stderr says why; with no payload, that line gives the command that shows what it would inject here, or names an unknown agent or part.",
    sections: [
      {
        heading: "Arguments:",
        rows: [
          ["<agent>", HOOK_AGENTS.join(", ")],
          ["<part>", HOOK_PARTS.join(", ")],
        ],
      },
      {
        heading: "Options:",
        rows: [
          [
            "--global",
            "Mark a global-scope entry: silent where the project's own entry for that part runs",
          ],
        ],
      },
    ],
    example: `echo '{"hook_event_name":"SessionStart"}' | mdmem hook claude-code index`,
    refuses: [
      "never: it exits 0, and an error becomes a one-line context saying why the memory could not be loaded",
    ],
  },
  store: {
    usage: "mdmem store [local | home | list]",
    about:
      "Show or change where the project's store lives. With no argument, print its placement and path, or the home store the first save creates. The home store, ~/.mdmem/<key>, is the default; the local store, .mdmem/ at the project's root, is for a team that commits it. Agents use the local store whenever it exists.",
    sections: [
      {
        heading: "Arguments:",
        rows: [
          [
            "local",
            "Move the home store to .mdmem/ at the project's root, or create an empty local store when there is none",
          ],
          ["home", "Move the local store back to ~/.mdmem/<key>"],
          [
            "list",
            "Print every home store: its key, project, memory count, and whether the project is missing",
          ],
        ],
      },
    ],
    example: "mdmem store local",
    refuses: [
      "the argument is not local, home or list",
      "the destination already holds memories: the refusal names the other store and how to fold it in",
      "store local in the home directory, where ~/.mdmem holds the home stores",
      "store local in a repository whose git directory is not named .git (a bare x.git, a worktree of one, --separate-git-dir), where .mdmem would sit inside that git directory",
    ],
  },
  mcp: {
    usage: "mdmem mcp",
    about:
      "Serve the mdmem MCP tools over stdio, for an agent's tool calls. Agents start it themselves once mdmem enable has registered it.",
    example: "mdmem mcp",
    refuses: [
      "never: a tool that refuses returns its refusal as that tool's error result",
    ],
  },
  version: {
    usage: "mdmem version",
    about:
      "Print mdmem and its version, the one the MCP server reports. --version, -v and -V do the same.",
    example: "mdmem --version",
    refuses: ["never"],
  },
};

/** Other names a command answers to, and the command whose page they share. */
const ALIASES: Record<string, string> = {
  rm: "delete",
  check: "doctor",
  "--version": "version",
  "-v": "version",
  "-V": "version",
};

/** The top-level page's groups, by who runs the commands, each command on one line. */
const GROUPS: readonly { heading: string; rows: readonly Row[] }[] = [
  {
    heading: "Set up and look after a project:",
    rows: [
      [
        "enable <agent…> | --all [--project]",
        "Wire agents to mdmem in the global or project scope",
      ],
      [
        "disable <agent…> | --all [--project]",
        "Remove mdmem's wiring from agents in one scope",
      ],
      ["status", "Show the store, the check and each agent's wiring"],
      [
        "store [local | home | list]",
        "Show the store's placement, move it, or list the home stores",
      ],
      ["doctor | check", "Check the store and the agents' wiring"],
      [
        "consolidate [--agent <agent>] [--from <dir>]",
        "Print a prompt that has an agent consolidate the store",
      ],
    ],
  },
  {
    heading: "Work with memories:",
    rows: [
      ["add", "Save a memory"],
      ["read <name>", "Print a memory or the index"],
      ["edit <name>", "Edit a memory in $VISUAL or $EDITOR"],
      ["delete <name>", "Delete a memory"],
      ["list", "Print the index"],
      ["search <query>", "Find the memories that match some words"],
      ["reindex", "Bring the index up to date with the memories"],
      ["path", "Print the store's directory"],
    ],
  },
  {
    heading: "Run by the agents, never typed:",
    rows: [
      [
        "hook <agent> <part> [--global]",
        "Print the memory protocol, the index or the per-prompt pointers",
      ],
      ["mcp", "Serve the mdmem MCP tools over stdio"],
    ],
  },
];

const OPTIONS: readonly Row[] = [
  ["-h, --help", "Show this help, or a command's"],
  ["-v, --version", "Print mdmem's version"],
];

/** Rows indented by two spaces, their second column aligned. */
function table(rows: readonly Row[]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

/** `text` broken into lines of at most `width` characters, at spaces. */
function wrap(text: string, width = WRAP_WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/** Like `table`, with each second column wrapped at WRAP_WIDTH under its own start. */
function wrappedTable(rows: readonly Row[]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  const indent = " ".repeat(width + 4);
  return rows.flatMap(([left, right]) => {
    const [first, ...more] = wrap(right, WRAP_WIDTH - indent.length);
    return [
      `  ${left.padEnd(width)}  ${first}`,
      ...more.map((line) => `${indent}${line}`),
    ];
  });
}

/** A command page's block: its rows and lines wrapped, a line's continuation indented under its text. */
function section({ heading, rows, lines }: Section): string[] {
  const body = rows === undefined ? [] : wrappedTable(rows);
  const text = (lines ?? []).flatMap((line) =>
    wrap(line, WRAP_WIDTH - 4).map(
      (part, i) => `${i === 0 ? "  " : "    "}${part}`
    )
  );
  return [heading, ...body, ...text, ""];
}

/** The page `mdmem`, `mdmem help`, `-h` and `--help` print. */
export function topLevelHelp(): string {
  const lines = [TAGLINE, "", USAGE_LINE, ""];
  for (const group of GROUPS) {
    lines.push(group.heading, ...table(group.rows), "");
  }
  lines.push("Options:", ...table(OPTIONS), "", HELP_FOOTER);
  return lines.join("\n");
}

/** The page of `command` or one of its aliases, or undefined when it has none. */
export function commandHelp(command: string): string | undefined {
  const page = PAGES[ALIASES[command] ?? command];
  if (page === undefined) {
    return undefined;
  }
  const lines = [`Usage: ${page.usage}`, "", ...wrap(page.about), ""];
  for (const block of page.sections ?? []) {
    lines.push(...section(block));
  }
  lines.push(
    // The example stays on one line, so it can be copied as it is.
    "Example:",
    `  ${page.example}`,
    "",
    ...section({ heading: "Refuses when:", lines: page.refuses })
  );
  return lines.join("\n").trimEnd();
}

/** What an unknown command, or `mdmem help` of one, prints on stderr: a line naming it, the usage line and the footer. */
export function unknownCommandHelp(command: string): string {
  return [`mdmem: unknown command "${command}"`, USAGE_LINE, HELP_FOOTER].join(
    "\n"
  );
}
