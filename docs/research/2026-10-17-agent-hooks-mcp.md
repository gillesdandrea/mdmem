# Hooks, MCP and AGENTS.md in Bob, Codex, Cursor and Gemini CLI (2026-10-17)

Research for mdmem-dd2.7: which hooks and MCP registration mdmem can use to wire each agent other than Claude Code through a session-start hook. mdmem had no `docs/` folder; this note starts `docs/research/`.

Versions checked:

- **IBM Bob Shell 2.0.6** (`bobshell` npm package, `releaseCommit 88346061a`, released 2026-10-09), installed under `~/.local/share/mise/installs/node/latest/lib/node_modules/bobshell`.
- **Codex CLI 0.160.0** (`codex --version`), source at tag `rust-v0.160.0` (commit `79b1b666`).
- **Cursor** and **Gemini CLI**: current official docs and source as of 2026-10-17 (versions in their sections).

Source keys:

- `bob.js L<n>:c<col>` is a line and column in Bob 2.0.6's `dist/bob.js`. Lines run to 100k+ characters.
- "Bob skill" is the "Configure Hooks" or "Configure MCP" built-in skill text embedded in the 2.0.6 bundle (`bob.js` L4351–L4640 and L4648). It is first-party documentation shipped in the binary.
- `src <path>:<line>` is a file under `codex-rs/` in openai/codex at `rust-v0.160.0`.
- [D-…] keys are web docs fetched 2026-10-17, listed under Sources.
- "2.0.4 note" and "0.154 note" are shepr's `docs/reference/2026-09-27-bob-pane-facts.md` and `2026-09-28-codex-pane-facts.md`, whose facts came partly from live probes.
- **Unverified** means no primary source confirmed the claim.

## Summary table

| | Bob 2.0.6 | Codex 0.160 | Cursor | Gemini CLI |
| --- | --- | --- | --- | --- |
| Session-start event | `SessionStart` | `SessionStart` | `sessionStart` | `SessionStart` |
| Its output reaches the model | yes: plain stdout or `hookSpecificOutput.additionalContext` | yes: plain stdout or `hookSpecificOutput.additionalContext`, capped at ~2,500 tokens by default | yes: JSON `additional_context` only; fire-and-forget | yes: JSON `hookSpecificOutput.additionalContext` only, `<`/`>` escaped |
| Lands as | prefix of the first user message (`envContext`) | `developer` message | "initial system context" (docs) | user turn wrapped in `<hook_context>` |
| Post-compaction context | SessionStart re-fires with `source: "compact"` | SessionStart re-fires with `source: "compact"` | none: `preCompact` is observational | none: `PreCompress` output shown to the user only |
| Global hooks file | `~/.bob/settings/settings.json` `hooks` | `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml` | `~/.cursor/hooks.json` | `~/.gemini/settings.json` `hooks` |
| Project hooks file | `<ws>/.bob/settings.json` | `<repo>/.codex/hooks.json` or `.codex/config.toml` | `<root>/.cursor/hooks.json` | `.gemini/settings.json` |
| Trust gate | folder trust gates global and workspace hooks | per-hook SHA-256 pin keyed by the declaring file's absolute path; project layers also need folder trust | project hooks need workspace trust (off by default in the editor); no per-hook approval | folder trust gates all settings hooks, user ones included; project hooks auto-trusted after a warning |
| Global hook in every worktree | yes, in trusted workspaces | yes, after one review | yes | yes, in trusted folders |
| MCP global / project | `~/.bob/settings/mcp.json` / `<ws>/.bob/mcp.json` | `[mcp_servers.*]` in `~/.codex/config.toml` / `<repo>/.codex/config.toml` | `~/.cursor/mcp.json` / `.cursor/mcp.json` | `mcpServers` in `~/.gemini/settings.json` / `.gemini/settings.json` |
| Reads AGENTS.md natively | yes, workspace root only | yes, root-to-cwd chain plus `~/.codex/AGENTS.md` | yes, root and nested | no, only with `context.fileName` |

## IBM Bob Shell 2.0.6

### What changed since 2.0.4 and 2.0.5

- **Nothing in hooks.** The changelog entries for 2.0.5 and 2.0.6 mention no hook change. The last hook changes were PreCompact, PostCompact and HTTPS handlers in 2.0.3, and `EnforcedHooks` in 2.0.2 [D-BOB-CL].
- **MCP fix.** In 2.0.6, `bob mcp add` and `bob mcp add-json` create the `.bob` directory when it is missing, so adding the first server no longer fails [D-BOB-CL].
- **New in the bundle: first-party hook docs.** 2.0.6 ships a built-in "Configure Hooks" skill that documents the events, schema, scopes, output contract and trust rule. The public docs still have no hooks page [Bob skill; D-BOB-CL]. Whether the skill was already in 2.0.4 or 2.0.5 is **unverified**: no older bundle is installed to compare.
- **Re-verified against the 2.0.6 bundle:** the event list, the strict schema, the output parsing, the trust gating of hooks, MCP and rules, the SessionStart re-fire after compaction, the MCP file paths and AGENTS.md loading. Each is cited to a 2.0.6 line below.
- **Carried from the 2.0.4 live probe, consistent with the 2.0.6 source but not re-probed:** SessionStart fires lazily with the first prompt rather than at launch; context lands as `<context>\n\n<prompt>` in the user turn; `bob run` treats a folder with no trust entry as trusted.

### Hook events

- **Seven events:** `SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `PreToolUse`, `PostToolUse`, `Stop`. There is no `SessionEnd`, `Notification`, `PermissionRequest` or `SubagentStop` [bob.js L1462:c8332; Bob skill].
- **SessionStart matcher values:** `startup`, `resume`, `compact`. `PreCompact` and `PostCompact` match `manual` or `auto` [bob.js L5876:c3847; Bob skill].
- **SessionStart is lazy.** It fires when the task's first turn input arrives, with `startup` when the task has no messages and `resume` otherwise [bob.js L5880:c944]. The 2.0.4 live probe saw it fire with the first prompt, not at launch (2.0.4 note).

### Does SessionStart output reach the model?

- **Yes.** On exit 0, trimmed stdout is parsed as JSON when it starts with `{` and is an object. Then `hookSpecificOutput.additionalContext` is used, but only when `hookSpecificOutput.hookEventName` equals the event. Any other stdout is used verbatim as context for `SessionStart`, `UserPromptSubmit` and `PostToolUse` only [bob.js L5876:c5695; Bob skill].
- **JSON form:**

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}}
```

- **JSON without a matching `hookSpecificOutput` yields no context**, so a hook must not print unrelated JSON [bob.js L5876:c5695].
- **Where it lands.** The context is joined into the user message's `envContext` [bob.js L5880:c944, `QEt` at L5878:c10]. The 2.0.4 probe saw the model receive `<context>\n\n<prompt>` with no wrapper tags (2.0.4 note). Several handlers' contexts are joined with a blank line.
- **No size cap** was found in the hook path. Handler stdout is bounded by `exec`'s 1 MiB `maxBuffer` (2.0.4 note; `RZs` at bob.js L5876:c3847). **Unverified** whether a larger context is truncated later.
- **Exit 2 cannot block SessionStart**, and other non-zero exits, timeouts and thrown errors fail open [bob.js L5876:c5122; Bob skill].

### Post-compaction context

- **`PostCompact` output is ignored.** Its exit-0 stdout does not reach the model [bob.js L5876:c5695; Bob skill table].
- **SessionStart re-fires with `source: "compact"`.** After a successful `PostCompact`, Bob runs the `SessionStart` hooks with `source: "compact"` and adds their context to the last user message's `envContext`, or holds it as pending context for the next request when the last message is not a user message [bob.js L5880:c2279]. The Bob skill says the stdout is added "to the compacted conversation before the next model request".
- **No `PostCompact` hook is needed for it.** The harness's `onPostCompact` callback runs on every successful compaction. It runs any `PostCompact` hooks (none is a no-op), then the `SessionStart` hooks if any exist (`n.SessionStart?.length`) [bob.js L5880:c2164–c2371].
- **So one `SessionStart` hook with no matcher covers startup, resume and compaction.**

### Config files and schema

- **Global:** `hooks` in `~/.bob/settings/settings.json`, which applies to all workspaces. **Workspace:** `hooks` in `<workspace>/.bob/settings.json` [Bob skill]. The global directory is `os.homedir()/.bob`, with no env var or flag to move it (2.0.4 note).
- **Combined, not replaced.** Global and workspace groups are concatenated per event, after the machine policy `EnforcedHooks` [Bob skill; 2.0.4 note].
- **Schema** (zod `.strict()` at every level) [bob.js L4081:c7421; Bob skill]:

```json
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/abs/path/mdmem hook session-start", "timeout": 10}]}
    ]
  }
}
```

- **Handler fields.** Command: `type: "command"`, non-empty `command`, optional `timeout` (positive seconds, default 10), optional `disabled`. HTTP: `type: "http"`, HTTPS `url`, optional `headers`, `allowedEnvVars`, `timeout` [bob.js L4081:c7421; Bob skill].
- **One bad key disables the whole block.** Because the schema is strict, an unknown key anywhere in `hooks` invalidates every hook in that file, which is then ignored with a warning [bob.js L4081:c7421; Bob skill: "invalid hook configuration is ignored"]. mdmem must merge exactly this shape.
- **Command environment.** The command runs through `/bin/sh` with the task's workspace as cwd and the payload JSON on stdin. Bob has no `${CLAUDE_PROJECT_DIR}`: use the cwd or the payload's `cwd`. A global hook should call its script by absolute path [Bob skill].
- **Payload:** `session_id`, `cwd`, `hook_event_name`, plus `source` for SessionStart [Bob skill].
- **Scope switches.** `disableGlobalHooks: true` drops global hooks [bob.js L5959:c9753]. `disableWorkspaceHooks` drops a workspace's hooks (2.0.4 note).
- **Live reload.** Changes apply to later hook events; a `SessionStart` change applies when a task starts or resumes [Bob skill].

### Trust gates

- **Hooks run only in a trusted workspace, from either scope.** In an untrusted workspace `getConfig()` returns the defaults, whose `hooks` are empty, so global hooks vanish too, and workspace hooks are skipped [bob.js L5959:c9513–c9753; Bob skill: "untrusted workspaces do not run hooks from either scope"]. Only `EnforcedHooks` policy hooks are exempt (2.0.4 note).
- **Trust also gates MCP, rules and AGENTS.md.** MCP servers start only when the workspace is trusted [bob.js L5959:c8561], and the rule loader returns nothing, AGENTS.md included, when it is not [bob.js L5024:c221, L5875:c10386].
- **Trust store.** `~/.bob/trustedFolders.json`, `{version: 1, folders: {<abs path>: "TRUST_FOLDER" | "TRUST_PARENT" | "DONT_TRUST"}}`. The lookup is by path prefix: `TRUST_FOLDER` covers the folder's subtree, `TRUST_PARENT` covers the parent's subtree [bob.js L5024:c2750].
- **Folder trust can be turned off.** `security.folderTrust.enabled` (default `true`) in global settings. When it is `false`, no trust is looked up and the workspace counts as trusted [bob.js L1462:c9474, L6172:c12208, L5959:c7562].
- **Hooks need no per-hook approval.** Hook commands bypass Bob's command-approval flow [Bob skill].
- **Interactive vs headless.** `bob chat` shows a trust dialog in an unknown folder, and `--trust` persists `TRUST_FOLDER`. `bob run` treats an unknown folder as trusted without writing anything (2.0.4 note; not re-probed).

### Global hooks across projects and worktrees

- **A global hook runs in every trusted workspace** [Bob skill: "Global: ~/.bob/settings/settings.json (all workspaces)"].
- **Worktrees follow path-prefix trust.** A worktree inside a trusted repo's folder (for example under `.claude/worktrees/`) inherits trust. A sibling worktree elsewhere needs its own entry, or a `TRUST_PARENT` on a common parent [derived from bob.js L5024:c2750].
- **The workspace is the launch folder** (`-w` or cwd), so a workspace hook lives in each worktree's own `.bob/settings.json` (2.0.4 note).

### MCP registration

- **Global:** `~/.bob/settings/mcp.json`, all workspaces. **Workspace:** `<workspace>/.bob/mcp.json`, which overrides a global server of the same name. A deeper `.bob/mcp.json` in a nested project overrides a shallower one [Bob skill "Configure MCP", bob.js L4648].
- **Schema:** a `mcpServers` object keyed by server name, with `command`/`args`/`env` for stdio or `url`/`headers` for HTTP, plus `alwaysAllow` and `groups` [Bob skill; D-BOB-CL 2.0.1].
- **CLI:** `bob mcp add [-s workspace|global] [-t stdio|http] [-e KEY=VALUE] <name> <commandOrUrl> [args…]`, default scope `workspace` [`bob mcp add --help`]. That `-s global` writes `~/.bob/settings/mcp.json` follows from the skill text; **unverified** by running it.
- **Migration.** Bob 2.0.0 moved the global file from `mcp_settings.json` to `mcp.json` [bob.js L6159:c1345].
- **Trust:** MCP is off entirely in an untrusted workspace [bob.js L5959:c8561].

### AGENTS.md

- **Read natively, workspace root only.** The rule loader reads `<workspace>/AGENTS.md` and puts it in the system prompt under a `### agents_md` heading, after workspace rules (`.bob/rules/`, `.bob/rules-<mode>/`) and before global rules (`~/.bob/rules/`, `~/.bob/rules-<mode>/`) [bob.js L5024:c221, L1603:c339, L1581:c25].
- **No nested or global AGENTS.md.** Only the workspace root file is read; `.bob/rules-<mode>/AGENTS.md` files load as ordinary mode rules [bob.js L5024:c221; `/init` prompt at L1239].
- **Gated on trust** like everything else [bob.js L5875:c10386].
- **A static alternative to a hook:** a file in `~/.bob/rules/` reaches every trusted workspace's system prompt [bob.js L5024:c221].

## Codex CLI 0.160.0

### What changed since 0.154

- **Hooks are stable and on by default**, as at 0.154 (0.154 note). The twelve events are unchanged [src config/src/hook_config.rs:36-60].
- **New handler field `additionalContextLimit`.** Model-visible hook context is capped at about 2,500 tokens by default; the excess is written to `<tmpdir>/hook_outputs/<thread_id>/<uuid>.txt` and replaced by a head-and-tail preview with the file path. `0` disables the cap for that handler [src hooks/src/output_spill.rs:12-31, 53-90; config/src/hook_config.rs:174-184; D-CX-HOOKS]. Whether this field existed at 0.154 is **unverified**; the 0.154 note does not mention it.
- **New SessionStart sources** `clear` and `fork`, besides `startup`, `resume` and `compact` [src hooks/src/events/session_start.rs:23-42; D-CX-HOOKS].
- **New handler types** `prompt` and `agent` parse but are skipped as unsupported [src config/src/hook_config.rs:196-199; hooks/src/engine/discovery.rs:640-655].

### Hook events

- **Twelve events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt` [src config/src/hook_config.rs:36-60; D-CX-HOOKS].
- **SessionStart matcher values:** `startup`, `resume`, `clear`, `compact`, `fork` [src hooks/src/events/session_start.rs:33-42].
- **SessionStart is lazy.** It is queued and runs before the first model request, so it fires with the first input, not at launch [src core/src/hook_runtime.rs:127-180; 0.154 note, live].

### Does SessionStart output reach the model?

- **Yes, in both forms.** On exit 0, plain (non-JSON) stdout becomes additional context. JSON stdout is parsed, and `hookSpecificOutput.additionalContext` becomes additional context. Output that looks like JSON but fails to parse marks the hook failed and adds nothing [src hooks/src/events/session_start.rs:245-312; hooks/src/engine/output_parser.rs:93-100; D-CX-HOOKS: "Plain text on `stdout` is added as extra developer context"].

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}}
```

- **Where it lands:** each context becomes its own conversation item with role `developer`, no wrapper markers, recorded into the history before the turn's model request [src core/src/hook_runtime.rs:849-873; core/src/context/hook_additional_context.rs].
- **Size cap:** about 2,500 tokens per context unless `additionalContextLimit` is set (see above). A memory index longer than that is truncated to a preview plus a temp-file path.
- **Other output fields:** `systemMessage` shows as a UI warning; `continue: false` stops the session with `stopReason` [src hooks/src/events/session_start.rs:258-290].
- **Non-zero exit** marks the hook failed and adds nothing [src hooks/src/events/session_start.rs:313-328].

### Post-compaction context

- **PreCompact and PostCompact output never reaches the model.** Plain stdout is ignored; JSON can only set `continue: false` or a `systemMessage` warning. `additionalContextLimit` on these events is ignored with a warning, because "this event cannot emit additionalContext" [src hooks/src/events/compact.rs:254-320, 475-497; hooks/src/engine/discovery.rs:539-556; D-CX-HOOKS].
- **SessionStart re-fires with `source: "compact"`.** After compaction is persisted, Codex queues a pending SessionStart with source `compact`, which runs before the next model request, and its context is recorded as a developer item [src core/src/session/mod.rs:4210-4213; core/src/hook_runtime.rs:127-180; D-CX-HOOKS].
- **So one `SessionStart` hook with no matcher covers startup, resume, clear, fork and compaction.**

### Config files and schema

- **Layers, low to high:** system `/etc/codex/config.toml`, user `$CODEX_HOME/config.toml` (default `~/.codex`), profile, then project layers: `.codex/config.toml` in each parent directory up to the project root and at the git root, then `-c` overrides [src config/src/loader/mod.rs:120-138].
- **Hooks sit beside each layer** as `hooks.json` next to that layer's `config.toml`, or as an inline `[hooks]` table in it. So the global files are `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`, and the project files are `<repo>/.codex/hooks.json` or `[hooks]` in `<repo>/.codex/config.toml`. Both forms in one layer load with a warning [src hooks/src/engine/discovery.rs:129-185; D-CX-HOOKS].
- **Schema** (`hooks.json`; `deny_unknown_fields` at the top level) [src config/src/hook_config.rs:11-16, 154-199; D-CX-HOOKS]:

```json
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/abs/path/mdmem hook session-start", "timeout": 30, "additionalContextLimit": 0}]}
    ]
  }
}
```

- **Handler fields.** `command`: `command`, optional `commandWindows`, `timeout` (seconds, default 600), `async`, `statusMessage`, `additionalContextLimit`. `mcp_tool`: `server`, `tool`, `input`, `timeout`, `statusMessage` [src config/src/hook_config.rs:160-199].
- **Payload:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, plus `source` for SessionStart [src core/src/hook_runtime.rs:162-170; shepr verified-adapter-facts.md].
- **Per launch:** `-c 'hooks={SessionStart=[…]}'` loads hooks for one process (0.154 note, live).

### Trust gates

- **Every non-managed hook needs a pinned hash.** A handler runs if it is managed (system, MDM, cloud or `requirements.toml`), or its `trusted_hash` matches its current hash, or the process has `--dangerously-bypass-hook-trust`. A new or changed hook is skipped until trusted [src hooks/src/engine/discovery.rs:665-680, 790-821; D-CX-HOOKS].
- **The pin lives in `$CODEX_HOME/config.toml`:**

```toml
[hooks.state."/Users/me/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:…"
```

  The key is `<source file path>:<event label>:<group index>:<handler index>`, where the source path is the absolute path of the `hooks.json` or `config.toml` that declared the hook [src hooks/src/lib.rs:113-124; hooks/src/engine/discovery.rs:174, 665].
- **The hash** is `sha256:` plus the hex SHA-256 of canonical JSON (keys sorted) of `{event_name, matcher, hooks: [normalized handler]}` [src hooks/src/engine/discovery.rs:775-790; config/src/fingerprint.rs:54-80]. The normalized handler fills defaults such as the timeout, so mdmem writing its own pin would have to reproduce that normalization exactly. Doing so is **unverified**; the documented route is the `/hooks` review or the startup "Hooks need review" screen, whose "Trust all" writes the pin (0.154 note, live).
- **Project layers need a trusted folder.** Project `.codex/` config, hooks and MCP servers load only when the project is trusted; otherwise those layers are "loaded but disabled". User and system hooks still load in untrusted projects [src config/src/loader/mod.rs:130-133; D-CX-HOOKS; D-CX-MCP].
- **Folder trust** is `[projects."<abs path>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml`, looked up for the cwd and then for the git repo root [src config/src/config_toml.rs:880-897]. For a linked git worktree the repo root resolves to the main checkout, so trusting the main repo trusts its worktrees [src core/src/worktree_trust_tests.rs:86-95].
- **Admins** can set `allow_managed_hooks_only = true` in `requirements.toml` to ignore user, project and session hooks [codex docs/config.md].

### Global hooks across projects and worktrees

- **A user hook in `~/.codex/hooks.json` runs in every project and worktree once trusted.** Its pin key is the one absolute path `$CODEX_HOME/hooks.json`, so one review covers every cwd, and user hooks load even in untrusted projects [derived from src hooks/src/lib.rs:113-124 and D-CX-HOOKS].
- **A project hook is pinned per worktree.** Each worktree's `<worktree>/.codex/hooks.json` is a different absolute path, so each needs its own review, even though folder trust carries over from the main checkout. These are two separate trust systems [derived from the same sources; 0.154 note, live: the pin key held the absolute path].

### MCP registration

- **Global:** `[mcp_servers.<name>]` in `~/.codex/config.toml`. **Project:** the same table in `<repo>/.codex/config.toml`, trusted projects only [D-CX-MCP].
- **Schema (stdio):** `command` (required), `args`, `env`, `env_vars`, `cwd`. HTTP: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`. Common: `startup_timeout_sec` (10), `tool_timeout_sec` (60), `enabled`, `required`, `enabled_tools`, `disabled_tools` [D-CX-MCP].
- **CLI:** `codex mcp add <name> [--env K=V] -- <command…>` or `--url <url>`. It has no scope flag and writes the user config [D-CX-MCP; `codex mcp add --help`].

### AGENTS.md

- **Read natively.** Global: `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`. Project: one file per directory from the project root (normally the git root) down to the cwd, `AGENTS.override.md`, then `AGENTS.md`, then names in `project_doc_fallback_filenames`. Files are concatenated root first, up to `project_doc_max_bytes` (32 KiB) [D-CX-AGENTS].

## Cursor

Cursor's docs were read as raw Markdown (`https://cursor.com/docs/<page>.md`); the pages carry no revision date. The dated source is the CLI changelog, whose latest entry is v2026.10.08 [D-CU-CLI-CL]. The CLI binary is now `agent`; current docs no longer say `cursor-agent` [D-CU-CLI]. Cursor is closed source, so its docs are the ceiling here.

### Hook events

- **21 events.** Agent: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. Tab: `beforeTabFileRead`, `afterTabFileEdit`. App: `workspaceOpen` [D-CU-HOOKS "Hook categories"].
- **The CLI runs hooks too**, including session start/end, stop, pre-compaction and subagent hooks (changelog, January 2026) [D-CU-CLI-CL].
- **Cloud agents skip** `sessionStart`, `sessionEnd`, the MCP and Tab hooks and `workspaceOpen` [D-CU-HOOKS "Hooks not available in cloud agents"].
- **Cursor also loads Claude Code hooks** from `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json` when "Include Third-Party Plugins, Skills, and Other Configs" is on, which is the default. `SessionStart` maps to `sessionStart`, `PreCompact` to `preCompact`, `UserPromptSubmit` to `beforeSubmitPrompt`, and so on; `Notification` and `PermissionRequest` are unsupported [D-CU-3P]. The CLI also reads and merges them, and accepts "Claude Code-format hook responses" (changelog, January and April 2026) [D-CU-CLI-CL].

### Does sessionStart output reach the model?

- **Yes, as JSON on stdout:**

```json
{"env": {"KEY": "value"}, "additional_context": "…"}
```

  `additional_context` is "Additional context to add to the conversation's initial system context"; `env` sets variables for later hook runs [D-CU-HOOKS "Reference → sessionStart"].
- **Plain stdout is not documented as context**; the protocol is "JSON in both directions" [D-CU-HOOKS].
- **It is fire-and-forget:** "the agent loop does not wait for or enforce a blocking response" [D-CU-HOOKS]. **Unverified** whether a slow hook's context still reaches the first model request.
- **Unverified** whether a Claude-format `SessionStart` hook's `hookSpecificOutput.additionalContext` is mapped to `additional_context`. The third-party page documents the nested format only for `PreToolUse`, `Stop` and `SubagentStop` [D-CU-3P].
- **Other context events:** `postToolUse` and `postToolUseFailure` accept `additional_context`, "injected into the conversation after the tool result" [D-CU-HOOKS].

### Post-compaction context

- **None.** Cursor has `preCompact` only, "an observational hook that cannot block or modify the compaction behavior". Its only output is `user_message`, shown to the user [D-CU-HOOKS "Reference → preCompact"]. There is no post-compaction event, and no documented re-fire of `sessionStart` after compaction.

### Config files and schema

- **Locations, highest priority first:** enterprise (`/Library/Application Support/Cursor/hooks.json` on macOS, `/etc/cursor/hooks.json` on Linux), team (dashboard), project `<project-root>/.cursor/hooks.json` (commands run from the project root), user `~/.cursor/hooks.json` (commands run from `~/.cursor/`). Claude Code files rank below all of these. All matching hooks from all sources run and their responses are merged. Files are watched and reloaded on save [D-CU-HOOKS "Configuration"; D-CU-3P].
- **Schema:**

```json
{"version": 1, "hooks": {"sessionStart": [{"command": "/abs/path/mdmem hook session-start"}]}}
```

  `version` is required (use `1`). Per hook: `command` (required), `type` (`command` or `prompt`), `timeout` (seconds), `loop_limit`, `failClosed`, `matcher` (regex). Exit 2 denies; other non-zero exits proceed unless `failClosed` [D-CU-HOOKS "Quickstart", "Configuration file"].

### Trust gates

- **Project hooks need a trusted workspace** ("Require the workspace to be trusted to run") [D-CU-HOOKS "Team Distribution → Project Hooks"].
- **Editor workspace trust is off by default** ("Cursor supports workspace trust, but it's disabled by default"); `security.workspace.trust.enabled: true` turns it on [D-CU-SEC "Workspace trust"]. Inference, not stated by Cursor: with trust off, a committed `.cursor/hooks.json` runs.
- **The CLI has its own trust dialog** that saves the decision, and a `--trust` flag; non-interactive runs in untrusted workspaces fail unless `--trust` or `--force` is passed; "Worktrees inherit workspace trust" (April 2026) [D-CU-CLI-CL]. **Unverified** where the CLI stores trust and how it keys it.
- **No per-hook approval, fingerprint or hash pin is documented** [D-CU-HOOKS].

### Global hooks across projects and worktrees

- **User hooks apply everywhere:** "home directory hooks apply globally" [D-CU-HOOKS "Quickstart"]. No trust gate is documented for them. They do not run in cloud agents [D-CU-HOOKS].
- Nothing worktree-specific is documented for hooks; a project hook comes from the worktree's own `.cursor/hooks.json` (inference).

### MCP registration

- **Global** `~/.cursor/mcp.json`, **project** `.cursor/mcp.json`, key `mcpServers` with `command`/`args`/`env` or `url`/`headers`. Interpolation: `${env:NAME}`, `${userHome}`, `${workspaceFolder}` and others [D-CU-MCP].
- **The CLI uses the same files** [D-CU-CLI "MCP"]. Global servers load without per-workspace prompts; project servers still need approval (April 2026) [D-CU-CLI-CL]. The editor asks before using MCP tools by default [D-CU-MCP "Tool approval"].

### AGENTS.md

- **Read natively**, root and nested: "Cursor supports AGENTS.md in the project root and subdirectories" [D-CU-RULES]. The CLI reads `AGENTS.md` and `CLAUDE.md` at the project root [D-CU-CLI "Rules"]. `CLAUDE.md` is read the same way and "always applied to every conversation" [D-CU-HELP-RULES].
- Also read: `.cursor/rules/*.mdc`, User Rules (in settings, synced to the account) and Team Rules. **Unverified:** any user-level AGENTS.md file; none is documented.

## Gemini CLI

Read from `google-gemini/gemini-cli` at `main`, commit `ed96fae` (2026-10-16, `package.json` `0.66.0-nightly.20261013`); latest stable is v0.64.0 (2026-10-13) [GM `docs/changelogs/latest.md`]. `GM <path>:<line>` is a file in that commit. Docs live in the same repo under `docs/`.

### Hook events

- **11 events:** `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification` [GM packages/core/src/hooks/types.ts:43-55; docs/hooks/index.md].
- **On by default:** `hooksConfig.enabled` defaults to `true` [GM packages/cli/src/config/settingsSchema.ts:2548-2565].

### Does SessionStart output reach the model?

- **Yes, JSON only:**

```json
{"hookSpecificOutput": {"additionalContext": "…"}, "systemMessage": "optional, shown to the user"}
```

  [GM docs/hooks/reference.md:245-258; packages/core/src/hooks/types.ts:263-275].
- **Where it lands.** Interactive: a history entry with role `user` and text `<hook_context>…</hook_context>` [GM packages/cli/src/ui/AppContainer.tsx:590-604]. Headless: the same wrapper prepended to the prompt [GM packages/cli/src/gemini.tsx:945-956].
- **`<` and `>` are escaped** to `&lt;` and `&gt;` before injection, and a non-string value is dropped [GM packages/core/src/hooks/types.ts:263-275]. Markdown with angle brackets reaches the model escaped.
- **Plain stdout does not reach the model.** Non-JSON stdout with exit 0 becomes `systemMessage`, shown to the user only [GM packages/core/src/hooks/hookRunner.ts:455-475, 537-563; docs/hooks/index.md "Strict JSON requirements"].
- **`source`** is `startup`, `resume` or `clear`. After `/clear` the hook fires but its `additionalContext` is not injected, although the docs imply it is [GM packages/cli/src/ui/commands/clearCommand.ts:60-88].
- **Startup is never blocked;** `continue` and `decision` are ignored [GM docs/hooks/reference.md].
- **Other context events:** `BeforeAgent` (appended to that turn's prompt) and `AfterTool` accept `additionalContext` [GM docs/hooks/reference.md:131, 153].

### Post-compaction context

- **None.** Only `PreCompress` exists; its `systemMessage` is shown to the user and it cannot change compression [GM docs/hooks/reference.md:287-297]. The source awaits it and discards the result, and fires it before the threshold check, so it can fire with no compression following [GM packages/core/src/context/chatCompressionService.ts:490-493]. There is no SessionStart re-fire after compression.

### Config files and schema

- **`hooks` in `settings.json`** at each level: project `.gemini/settings.json`, user `~/.gemini/settings.json`, system `/etc/gemini-cli/settings.json` (Linux) or `/Library/Application Support/GeminiCli/settings.json` (macOS), plus extensions [GM docs/hooks/index.md "Configuration"; docs/reference/configuration.md:9-60; packages/core/src/config/storage.ts:78-80].
- **Arrays are concatenated** across levels (`mergeStrategy: CONCAT`), so every level's hooks run [GM settingsSchema.ts:2595+]. The docs disagree on precedence order, which affects run order only.
- **Schema:**

```json
{"hooks": {"SessionStart": [{"hooks": [{"name": "mdmem", "type": "command", "command": "/abs/path/mdmem hook session-start", "timeout": 10000}]}]}}
```

  Group keys: `matcher`, `sequential`, `hooks`. Hook keys: `type` (only `command`), `command`, `name`, `timeout` (milliseconds, default 60000), `description` [GM docs/hooks/reference.md:26-42].

### Trust gates

- **Folder trust** in `~/.gemini/trustedFolders.json` (path overridable with `GEMINI_CLI_TRUSTED_FOLDERS_PATH`), rules `TRUST_FOLDER`, `TRUST_PARENT`, `DO_NOT_TRUST`; the longest matching rule wins and covers its subtree [GM docs/cli/trusted-folders.md; packages/core/src/utils/trust.ts:157-196]. Overrides: `GEMINI_CLI_TRUST_WORKSPACE=true|false`, `GEMINI_RESTRICTED_MODE=true`, `--skip-trust`; a connected IDE's trust answer wins [GM trust.ts:47-65].
- **Default is on.** `security.folderTrust.enabled` defaults to `true` in source and the configuration reference; `docs/cli/trusted-folders.md:10` still says "disabled by default", which is stale [GM settingsSchema.ts:1906-1918; docs/reference/configuration.md:1983-1986]. With no matching rule the folder is untrusted [GM packages/core/src/config/config.ts:3187-3205].
- **Untrusted folders drop all settings hooks, user hooks included.** Hooks from the merged settings register only when `isTrustedFolder()`; otherwise the log says "Project hooks disabled because the folder is not trusted". Extension hooks still register [GM packages/core/src/hooks/hookRegistry.ts:172-187, checked]. The workspace `settings.json` is dropped and MCP servers do not connect; headless runs throw `FatalUntrustedWorkspaceError` [GM packages/cli/src/config/settings.ts:262].
- **Project-hook fingerprinting warns but does not block.** A new project hook, keyed `name:command` per project root in `~/.gemini/trusted_hooks.json`, raises a warning ("These hooks will be executed…") and is then trusted automatically [GM packages/core/src/hooks/hookRegistry.ts:139-167, checked; trustedHooks.ts:18-30; types.ts:121-125]. The docs' "you will be warned before it executes" means exactly that.

### Global hooks across projects and worktrees

- **User hooks run in every trusted folder** (or everywhere when folder trust is off) [GM hookRegistry.ts:172-187].
- **Worktrees:** Gemini's own worktrees live under `.gemini/worktrees/<name>`, inside the project, so the project's trust rule covers them [GM docs/cli/git-worktrees.md; trust.ts:180]. A worktree outside the trusted tree needs its own rule (inference from the matching code).

### MCP registration

- **`mcpServers` in `settings.json`**: user `~/.gemini/settings.json`, project `.gemini/settings.json`, or extensions. `gemini mcp add -s user|project` defaults to `project` [GM docs/tools/mcp-server.md; settingsSchema.ts:161-174].
- **Server fields:** `command`, `args`, `env`, `cwd`, `timeout`, `trust` (skips tool confirmations) [GM docs/tools/mcp-server.md]. Project servers do not load in untrusted folders.

### AGENTS.md

- **Not by default.** The context file name defaults to `GEMINI.md` [GM packages/core/src/tools/memoryTool.ts:11]; `context.fileName` replaces it, for example `["AGENTS.md", "GEMINI.md"]` [GM packages/cli/src/config/config.ts:623-628; docs/cli/gemini-md.md:94-108].
- **Default files:** `~/.gemini/GEMINI.md`, `GEMINI.md` in the workspace and its parents up to `context.memoryBoundaryMarkers` (default `[".git"]`), and `GEMINI.md` in directories tools touch [GM docs/cli/gemini-md.md:11-38; settingsSchema.ts:1434-1444].

## What this means for mdmem

These are conclusions drawn from the facts above, for mdmem-dd2.8 and mdmem-dd2.9.

- **All four can inject context at session start.** One user-level `SessionStart`/`sessionStart` hook per agent, calling mdmem by absolute path, reaches every project and worktree on the machine, subject to each agent's trust rule.
- **Emit JSON, not plain text.** `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}}` works in Bob, Codex and Gemini CLI. Plain stdout works only in Bob and Codex. Cursor needs its own shape, `{"additional_context": "…"}`. So the hook command needs an agent flag, or one output per agent.
- **Post-compaction differs.** Bob and Codex re-run `SessionStart` with `source: "compact"`, so a hook with no matcher re-injects memory after compaction for free. Cursor and Gemini CLI have no post-compaction path: their pre-compaction hooks show text to the user only. There, injected memory can be lost on compaction unless it also lives in a static context file.
- **Size matters in Codex.** Hook context over about 2,500 tokens is cut to a preview plus a temp-file path unless the handler sets `additionalContextLimit` (0 means no cap). mdmem should set it, or keep the injected index small.
- **Gemini escapes angle brackets** in injected context, and wraps it in `<hook_context>`.
- **Trust per agent:**
  - Bob: one global hook in `~/.bob/settings/settings.json`, no approval, but nothing runs in an untrusted workspace. `bob run` trusts unknown folders silently.
  - Codex: one `~/.codex/hooks.json` hook needs one review (or a hand-written `trusted_hash` pin, whose hash input mdmem would have to reproduce exactly). Prefer the user file over per-worktree `.codex/hooks.json`, which needs a review per worktree path.
  - Cursor: user hooks have no documented gate.
  - Gemini CLI: user hooks are skipped in untrusted folders, and folder trust is on by default.
- **AGENTS.md overlap.** Bob (root only), Codex and Cursor read AGENTS.md natively, so a hook that repeats AGENTS.md content duplicates it there. Gemini CLI reads only GEMINI.md unless `context.fileName` includes AGENTS.md, so mdmem either sets that or relies on the hook.
- **MCP registration** is a JSON `mcpServers` entry for Bob (`~/.bob/settings/mcp.json`), Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`), and a TOML `[mcp_servers.mdmem]` table for Codex (`~/.codex/config.toml`). Each agent also has a project-level file, gated by folder trust (Bob, Codex, Gemini CLI) or by per-server approval (Cursor CLI).
- **Cursor may already run mdmem's Claude Code hook.** Cursor reads `~/.claude/settings.json` hooks by default and maps `SessionStart`. Whether it passes on `hookSpecificOutput.additionalContext` for that event is unverified; if it does, wiring Claude Code covers Cursor too, and a separate Cursor hook would inject twice.

Still open (unverified):

- Cursor: whether a slow `sessionStart` hook's context reaches the first request, given fire-and-forget.
- Cursor: whether Claude-format `SessionStart` output is honoured.
- Codex: whether a hand-computed `trusted_hash` matches.
- Bob: whether a SessionStart context has a size cap.

A live probe per agent would close these.

## Sources

- [D-BOB-CL] https://bob.ibm.com/docs/shell/changelog (2.0.0 to 2.0.6, read through a summarising fetch, so wording is paraphrased except where quoted)
- Bob 2.0.6 `dist/bob.js`, `package.json`; `bob mcp add --help`; `bob --version`
- [D-CX-HOOKS] https://learn.chatgpt.com/docs/hooks (redirected from https://developers.openai.com/codex/hooks); no date shown
- [D-CX-MCP] https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirected from https://developers.openai.com/codex/mcp)
- [D-CX-AGENTS] https://learn.chatgpt.com/docs/agent-configuration/agents-md (redirected from https://developers.openai.com/codex/guides/agents-md)
- openai/codex at `rust-v0.160.0`: https://github.com/openai/codex/tree/rust-v0.160.0/codex-rs (paths and lines as cited); `docs/config.md`
- Local `codex --version`, `codex mcp add --help`
- shepr `docs/reference/2026-09-27-bob-pane-facts.md`, `2026-09-28-codex-pane-facts.md`, `verified-adapter-facts.md` (starting points; facts carried from them are marked)
- [D-CU-HOOKS] https://cursor.com/docs/hooks.md
- [D-CU-3P] https://cursor.com/docs/reference/third-party-hooks.md
- [D-CU-SEC] https://cursor.com/docs/agent/security.md
- [D-CU-MCP] https://cursor.com/docs/mcp.md
- [D-CU-RULES] https://cursor.com/docs/rules.md
- [D-CU-HELP-RULES] https://cursor.com/help/customization/rules.md
- [D-CU-CLI] https://cursor.com/docs/cli/overview.md and https://cursor.com/docs/cli/using.md
- [D-CU-CLI-CL] https://cursor.com/docs/cli/changelog.md (latest entry v2026.10.08)
- [GM] google-gemini/gemini-cli at commit `ed96fae`, 2026-10-16: https://github.com/google-gemini/gemini-cli/tree/ed96fae (code and `docs/`; `hookRegistry.ts` and `types.ts` lines re-read directly, the rest read by a research subagent)
