# Antigravity mapping

How each piece of the `agent-team` plugin maps to the Antigravity CLI (`agy`), as the spike for supporting it as a third Director harness. Written against plugin 1.0.1. Nothing in the plugin was changed for this spike.

**Checked against:**
- Antigravity CLI 1.5.11 on Windows 11.
- The docs bundled with the CLI (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/`) and `antigravity.google/docs/subagents`, as of 2026-11-18.
- 17 live headless runs (`agy -p … --output-format json`) with `gemini-3.8-flash-low` in two throwaway git repos, using workspace hooks in `.agents/hooks.json` that saved every hook payload. See [Live test results](#live-test-results).
- `agy plugin validate .` on this repo.
- Two live installs of the plugin into Antigravity, each followed by a session and then uninstalled: the repo as it is, and a copy without the root `plugin.json` so that Antigravity converts it as a Claude plugin. See [Install results](#install-results).

**Labels**
- ✅ **Verified** in a live run.
- 📄 **Documented** by Google, not tested here.
- ❌ **Differs** from Claude Code in a way the plugin must handle.
- ❓ **Unknown**: still needs a test.

## Summary

1. **A Director port is feasible.** Antigravity has every building block: plugins, skills, lifecycle hooks that can block, custom agents, subagents with their own worktrees, and a headless mode with structured output.
2. **Nothing works unchanged except the skills.** ✅ Installed as it is, the plugin gives 5 skills and nothing else: all 5 agent files fail to parse, and `hooks/hooks.json` is never read. Installed through the Claude conversion, the hooks are converted and do run, but they do nothing useful: the session-start reply is rejected, the guard lets a push through, and the agents still can't be spawned. Antigravity's hook file format, hook input and hook output are all different from Claude Code's.
3. **The guard can block, in the main session and inside subagents.** ✅ It needs Antigravity's own reply (`{"decision":"deny","reason":"…"}`) and its own input fields (`toolCall.args.CommandLine`). Today's `guard.js` reads `tool_input.command`, finds nothing, stays silent, and silence means allow. So the current guard would protect nothing.
4. **Hook errors block the tool.** ❌ A `PreToolUse` hook that exits non-zero, prints JSON with a field Antigravity doesn't know, or prints `{}` stops the tool call. Only no output at all (exit 0) is neutral. A logger bug would stop the Director, where on Claude Code it is harmless.
5. **Logging is easier than on Codex.** ✅ The spawn prompt (the task card) is plain text in the hook input. Each subagent's result is plain text in its `send_message` call. Transcripts are JSONL with the model and token counts per step.
6. **Subagent worktrees exist, but commits need the sandbox bypassed.** ✅ `Workspace: "share"` or `"branch"` gives the subagent a git worktree on its own branch. By default the terminal sandbox makes the workspace and `.git` read-only for shell commands, as Codex's does. A command run with `BypassSandbox: true` gets through, with no prompt in headless Auto mode.
7. **Model choice per subagent is coarse.** ❌ A spawn takes one of three aliases, and effort is part of the alias. An agent file that sets `model` overrides the spawn. Any model id works for a separate `agy -p` session.

## Concept-by-concept mapping

### Packaging and install

| agent-team (Claude) | Antigravity | Status | Notes |
|---|---|---|---|
| `.claude-plugin/plugin.json` | Native: `plugin.json` at the plugin root (also `.antigravity-plugin/plugin.json`, `.gemini-plugin/plugin.json`). Claude manifests are converted on install | ✅ validate · 📄 install | This repo has a root `plugin.json` (added for Codex), so Antigravity treats it as a **native** plugin and skips the Claude conversion. |
| `claude plugin install` | `agy plugin install <dir or name@marketplace>`, `agy plugin import` (from Gemini CLI or Claude) | ✅ | Copies the whole folder to `~/.gemini/config/plugins/agent-team`. `agy plugin uninstall agent-team` removes it and leaves `config.json` as it was. |
| `claude plugin validate` | `agy plugin validate [dir] [--strict] [--json]` | ✅ | Read-only. Result for 1.0.1: `skills 5 · agents 0 · rules 0 · hooks 0`, 5 errors, 1 warning. |
| Project-scope enable | `.agents/plugins.json` in the project, listing plugin paths inside the workspace | 📄 | A plugin can be loaded from the project with no global install. Paths outside the workspace are skipped. |
| Plugin files on disk | Hooks from a plugin run with the plugin folder as their working directory, with `PLUGIN_ROOT` and `PLUGIN_DATA` set | 📄 | `${CLAUDE_PLUGIN_ROOT}` in a command is not substituted. Use a relative path. |
| Workspace trust | `trustedWorkspaces` in `settings.json` | ✅ headless | Most runs passed the test repo as trusted through `--settings` (session only, nothing saved). One run passed nothing: project hooks and project agents loaded anyway. So there is no trust step for hooks in headless mode, unlike Codex. ❓ Interactive mode. |

### Instructions, skills and commands

| agent-team (Claude) | Antigravity | Status | Notes |
|---|---|---|---|
| `CLAUDE.md` + standing authorization | `AGENTS.md` or `GEMINI.md`, and `.agents/rules/*.md` | 📄 | `team-init` already writes an `AGENTS.md` section for Codex. |
| `skills/<name>/SKILL.md` | Same format, found automatically | ✅ | All 5 skills loaded in a session after install. The model saw them under bare names (`status`, `director`, …) with the path to each `SKILL.md`, and loaded one by reading that file. Skill bodies over 24 KB get a warning. |
| Skill invocation | `/<plugin>:<skill>` for the user; the model reads the file | 📄 · ✅ | The skills refer to each other as `agent-team:director`. The model saw no skill under that name, so those references need checking. The `/` form was not tested (headless). |

### Agents and delegation

| agent-team (Claude) | Antigravity | Status | Notes |
|---|---|---|---|
| `agents/*.md` (`model`, `effort`, `tools` as a comma list) | `.agents/agents/<name>.md` (project), `~/.gemini/config/agents/` (user), or `agents/` in a plugin. Frontmatter: `name`, `description`, `tools` (a YAML **list**), `model`, `commandExecutionPolicy`, `skills`, `rules`, `agents`, `hooks`, `mcpServers` | ❌ / ✅ | Our files fail to parse: `tools: Read, Grep, …` is a string, not a list (`cannot unmarshal !!str … into []string`), so the loader skips all 5 agents. The Claude conversion reports `agents: 5 installed` but copies the files unchanged, and a spawn then fails with `subagent "scout" not found or not allowed to be invoked`. Plugins **can** ship agents here, unlike Codex (📄). |
| `tools:` allow-list | `tools:` with Antigravity tool names (`read_file`, `run_command`, …) | ✅ | An agent with no `tools` gets no shell: the scout reported only `read_file`, `send_message`, `manage_task`, `schedule`, `search_web`, `generate_image`. Google's docs warn that a misspelled tool name can hang the subagent. |
| `Agent` tool, `subagent_type` | `invoke_subagent` with `TypeName`, `Role`, `Prompt`, optional `Model`, optional `Workspace` | ✅ | 12 of 12 spawns seen by `PreToolUse`. Built-in types: `self`, `research`, `image-generator`. Custom agents appear by `name`. |
| Task card in the delegation prompt | `toolCall.args.Prompt`, plain text | ✅ | The full `TASK …` / `WHY …` card is readable in the hook input. No encryption (Codex) and no name restrictions. |
| Per-delegation `model` | `Model`: `inherit` (default), `flash_lite`, `flash`, `pro` | ✅ | Observed: `flash_lite` → `gemini-3.5-flash-lite`, `flash` → `gemini-4-hydrogen-tiered-high`, `pro` → `gemini-4-hydrogen-tiered-xhigh`, omitted → the parent's model. **An agent file's `model` wins**: a scout with `model: flash` ran on `gemini-4-hydrogen-tiered-high` whether the spawn said nothing, `pro` or `flash_lite`. ❓ Whether an agent file accepts a full model id. |
| Per-delegation `effort` | **None.** Effort is part of the model alias | ❌ | The routing table's effort column can't be applied to a subagent. A separate session can set it (`--effort`, or a model id that ends in the effort). |
| `isolation: "worktree"` | `Workspace: "share"` or `"branch"` on the spawn | ✅ | Both created a git worktree at `~/.gemini/antigravity-cli/worktrees/<parent conversation>/subagent-<Role>-<type>-<hash>` on a new branch of the same name. The worktree includes uncommitted and untracked files. They are **not removed** when a headless run ends. |
| Commits in a worktree | Blocked by the terminal sandbox unless the command sets `BypassSandbox: true` | ✅ | Default: `Unable to create '…/.git/worktrees/<name>/index.lock': Permission denied`. An agent with `commandExecutionPolicy: "off"` committed after retrying with `BypassSandbox: true`. |
| Background subagents | Always asynchronous. The parent's turn ends and it is woken by the child's message | ✅ | The parent called no wait tool. A headless run waits for background work (`root agent idle; waiting up to 9m0s for 1 background task(s)`). |
| Follow-up / resume | `send_message` with `Recipient` = the conversation id; an idle subagent wakes with its context | 📄 | Only the child → parent direction was seen live. |
| Separate session (`start_session`) | `agy -p "<prompt>" --model <id> --effort <level> --output-format json --json-schema <file>` | ✅ | Result JSON has `conversation_id`, `status`, `response`, `duration_seconds`, `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`), `structured_output` and `denied_actions`. `--conversation <id>` resumes. `--effort low` was accepted; its effect was not measured. |

### Hooks (guard and logger)

| agent-team (Claude) | Antigravity | Status | Notes |
|---|---|---|---|
| `hooks/hooks.json` in the plugin | `hooks.json` at the **plugin root**, or `.agents/hooks.json` in the project | ❌ | `hooks/hooks.json` is "never loaded". A Claude-style file with a top-level `"hooks"` key loads as one hook named `hooks`. |
| File shape | Top-level keys are hook **names**; each holds the events. `PreToolUse` and `PostToolUse` use `matcher` + `hooks` groups; the other events are a flat list of handlers | ✅ | Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. No `SubagentStart`, `SubagentStop` or `UserPromptSubmit`. |
| Hook input (`tool_name`, `tool_input`, `session_id`, `hook_event_name`) | camelCase: `toolCall.name`, `toolCall.args`, `toolCall.id`, `conversationId`, `hookEventName`, `cwd`, `workspacePaths`, `transcriptPath`, `modelName`, `lastUserInput`, `stepIdx` | ❌ / ✅ | Every script that reads hook input needs an Antigravity branch. `modelName` is the real model on every event. |
| Tool names in matchers | `run_command` (shell), `read_file`, `invoke_subagent`, `send_message`, `manage_task` | ✅ | The shell tool's command is `toolCall.args.CommandLine`. It is PowerShell on Windows. |
| Block with `permissionDecision: "deny"` JSON | `{"decision":"deny","reason":"…"}` on stdout | ✅ | Blocked `git push origin main` in the main session and in a subagent. The model saw `tool call denied by pre-tool hook: <reason>`, and the bare remote stayed empty. It also blocked a command that set `BypassSandbox: true`. `PostToolUse` does not fire for a blocked call. |
| Other `PreToolUse` replies | See the table under [Live test results](#live-test-results) | ✅ | No output = allow. `{}` = deny with no reason. Any non-zero exit = blocked. Claude's JSON = blocked by a parse error. `"allow"` approves the call outright; a logger must not print it. |
| `PostToolUse` with `tool_response` | **No tool output.** Only `toolCall` and `error` | ❌ | The merge logger reads command output from the hook input. Here it has to read the transcript (the `GENERIC` step after the call) or run its own check. |
| `SessionStart` + `additionalContext` | Reply `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}` | ✅ | The marker line came back verbatim from the model. It also fires for each subagent, so subagents see the line too. |
| `SubagentStop` + transcript parsing | `Stop` in the child's conversation, and the child's `send_message` | ✅ | `send_message` carries `Message` (the full final report, `result-json` block included) and `Recipient` (the parent's conversation id). `Stop` has `terminationReason` and `fullyIdle`. The parent's `Stop` fires once per wake, with `fullyIdle: false` while children run. |
| Linking a result to its delegation | Hooks in a subagent carry the **child's** `conversationId` and `transcriptPath`, not the parent's | ✅ | Three ways to link: `send_message.Recipient`; the parent's `.system_generated/subagents/<child id>.json` (`typeName`, `role`, `workspaceUris`); the child transcript, whose first message holds the prompt and `sender=<parent id>`. |
| Tokens and actual model | `transcript_full.jsonl`: each `PLANNER_RESPONSE` step has `model`, `input_tokens`, `cache_read_tokens`, `output_tokens` | ✅ | Sum the steps for a total. No separate effort field; it is in the model id. |
| `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`, `PLUGIN_DATA` for plugin hooks; `ANTIGRAVITY_CONVERSATION_ID` for all hooks | 📄 · ✅ | Only `ANTIGRAVITY_CONVERSATION_ID` was seen, because the test hooks were project hooks. |
| `CLAUDE_PROJECT_DIR` | **None.** The hook's working directory is the folder holding `hooks.json`; the payload's `cwd` is the agent's | ✅ | In a worktree subagent, both point into the **worktree**. `lib.projectDir()` falls back to `git rev-parse --show-toplevel`, which returns the worktree, so logs would be split across worktrees. It needs `--git-common-dir`. |
| Hooks inside subagents | Yes, including subagents in their own worktree | ✅ | Workspace hooks are found in the worktree's own copy of `.agents/`. |
| Hook command shell (Windows) | `cmd /c` | 📄 · ✅ | `node dump.js` worked. Default timeout 30 s. Hooks run synchronously. |

### Permissions and visibility

| agent-team (Claude) | Antigravity | Status | Notes |
|---|---|---|---|
| Permission modes | `--mode accept-edits\|auto\|plan`; headless defaults to Auto | ✅ | In Auto mode a hook reply of `"ask"` ran with no prompt. |
| Shell writes | Terminal sandbox: shell commands can't write the workspace or `.git` | ✅ | `git checkout -b`, `git add`, `git commit`, `git worktree add` and `Set-Content` all failed, in two repos (one outside `AppData`). `--agent` with `commandExecutionPolicy: "off"` did not change this for the main session. |
| Getting past the sandbox | `BypassSandbox: true` on `run_command` | ✅ | All six git writes then worked, with the hook silent and with no prompt. The sandbox is therefore not a control the guard can lean on; the guard's own deny is. |
| Subagent visibility | `/agents` panel, `/swarm board` | 📄 | Not needed for the port. |

### Models and effort

| Tier | Claude | Codex | Antigravity subagent (`Model`) | Antigravity session (`--model`) |
|---|---|---|---|---|
| small | `haiku` | `gpt-6-luna` | `flash_lite` → `gemini-3.5-flash-lite` | `gemini-3.8-flash-low` and up |
| medium | `sonnet` | `gpt-6.1-terra` | `flash` → `gemini-4-hydrogen-tiered-high` | any id from `agy models` |
| large | `opus` | `gpt-6.1-sol` | `pro` → `gemini-4-hydrogen-tiered-xhigh` | e.g. `gemini-4-argon-high` |

- The aliases resolve on Google's side and may change. Log the `modelName` the hooks report, not the alias.
- `agy models` also lists Neon, Argon, Hydrogen at several efforts, and Claude and GPT-OSS models. The local bridge notes that Argon has its own weekly quota. The tier map for sessions is a choice for the milestone, not a finding.
- `models.js` resolves one model string per tier and tool. Antigravity needs two (alias for subagents, id for sessions), or sessions only.

## What this means for the port

- **Generate, don't share, three things:** a root `hooks.json` in Antigravity's format, agent files with list-form `tools` and Antigravity tool names, and the model entries. This is the same pattern as `codex-agents.js` and `codex-hooks.js`.
- **Guard:** read `toolCall.args.CommandLine` when `toolCall.name` is `run_command`; reply `{"decision":"deny","reason":…}`; print nothing to allow. Match only `run_command`: a rule that searched all arguments blocked a spawn whose prompt merely mentioned `git push`.
- **Fail-closed hooks:** wrap every Antigravity hook entry so an exception prints nothing and exits 0, except in the guard, where failing closed is right.
- **Logger:** a parser for `invoke_subagent` (delegation, from `Prompt`), `send_message` from a child (completion, from `Message`), and the transcript (model, tokens, merge output). Simpler than `codex-log.js`: no encrypted prompt, no turn matching, no pending snapshots.
- **Session start:** reply with `injectSteps`.
- **Project directory:** resolve the main checkout through `git rev-parse --git-common-dir`.
- **Director instructions:** a `references/antigravity.md`: spawn with `invoke_subagent`, `Workspace: "share"` for writers, `BypassSandbox: true` for git writes, clean up worktrees, use `agy -p` for sessions and for any task that needs a specific model or effort.
- **Routing:** effort can't be set per subagent. Either route by alias only, or send tasks that need `high` effort to sessions.

**Size:** one milestone, smaller than the Codex one. The logging half is easier; the hook half needs a new file format and replies, which Codex did not.

## Live test results

**Runs:** 2026-11-18, `agy` 1.5.11, Windows 11, `gemini-3.8-flash-low`, headless, default Auto mode, no bypass flags. Two throwaway repos with an empty bare remote, one under `AppData\Local\Temp` and one under the user's home. Hooks for every event wrote their input to `.dump/`.

| Question | Answer |
|---|---|
| Do workspace hooks run in headless mode? | Yes, all six events. |
| Is `SessionStart` context injected? | Yes. The model repeated the marker line. |
| Shell tool name and fields | `run_command`: `CommandLine`, `WaitMsBeforeAsync`, `toolSummary`, optional `BypassSandbox`, `IsDaemon`. |
| Does the guard block a push? | Yes with `{"decision":"deny"}`: main session, subagent, and with `BypassSandbox: true`. The remote stayed empty. |
| Spawn tool name and fields | `invoke_subagent`: `TypeName`, `Role`, `Prompt`, `Model`, `Workspace`. |
| Is the task card readable by hooks? | Yes, in `Prompt`, on `PreToolUse` and `PostToolUse`. |
| Do hooks fire inside subagents? | Yes, with the child's `conversationId`. Also in worktree subagents. |
| Subagent result | The child's `send_message` (`Message`, `Recipient`). |
| Is a per-spawn `Model` honoured? | Yes when the agent file sets no model. No when it does. |
| Worktree per subagent | `share` and `branch` both made a git worktree on a new branch. |
| Commits | Fail in the sandbox, in the main session and in worktrees. Work with `BypassSandbox: true`. |
| Structured output | `--json-schema` returned `structured_output` matching the schema. |
| Does this repo load as a plugin? | Skills only. Agents and hooks are skipped. |
| Reliability | 1 of 17 runs returned an empty response with no hooks fired and `denied_actions: [{"action":"command","display_name":"Bash"}]`. The same prompt worked on the next run. Cause unknown. |

**`PreToolUse` replies, each tried on a harmless git command:**

| Hook reply | Result |
|---|---|
| No output, exit 0 | Ran. |
| `{"decision":"allow"}` | Ran. |
| `{"decision":"ask"}` | Ran, no prompt (headless Auto mode). |
| `{"decision":"deny","reason":"…"}` | Blocked; the model saw the reason. |
| `{}` | Blocked: `tool call denied by pre-tool hook:` with no reason. |
| Exit 2 with stderr | Blocked: `JSON hook … failed: command failed: exit status 2, stderr: …`. |
| Exit 1 with stderr | Blocked, same message with `exit status 1`. |
| Claude's `hookSpecificOutput` deny | Blocked by a parse error: `unknown field "hookSpecificOutput"`. A Claude-style *allow* would be blocked the same way. |

## Install results

Both installs: 2026-11-18, `agy plugin install <dir>`, then one headless session in the test repo, then `agy plugin uninstall agent-team`.

| Question | As it is (root `plugin.json`) | Claude conversion (no root `plugin.json`) |
|---|---|---|
| Install summary | `skills: 5 installed` | `skills: 5`, `agents: 5`, `hooks: 3 installed (PostToolUse, PreToolUse, SessionStart)` |
| Skipped, per the summary | Nothing listed | `SubagentStop` and `UserPromptSubmit` (no such events); the `SubagentHandback` matcher (no such tool) |
| Hook file written | None | A root `hooks.json` in Antigravity's format: `Bash\|PowerShell` → `run_command`, `Agent\|Task` → `invoke_subagent`, commands as `node "./scripts/<name>.js"` |
| Do plugin hooks run? | No hooks | Yes. The CLI log shows the file loaded and the session-start hook called. |
| Session-start line | None | None. The reply was rejected: `unknown field "hookSpecificOutput"`. |
| Guard on `git push origin main` | No guard | **Not blocked.** The push ran, and failed only because the sandbox stopped git reaching the remote. |
| Plugin agents | None | None available. Spawning `scout` failed: `not found or not allowed to be invoked`. |
| Logs | None | None written. |
| Skills | 5, loaded | 5 |

So the conversion is no shortcut: it produces a `hooks.json` worth copying as a starting point, and nothing that works. The port has to ship a native root `hooks.json` and Antigravity-aware scripts.

## Still open

- [ ] **`PLUGIN_ROOT` in plugin hooks:** the converted hooks ran from the plugin folder with relative paths; the variable itself was not read.
- [ ] **Project-only install** through `.agents/plugins.json`, which `team-init` could write.
- [ ] **Interactive sessions:** every run was headless. Check `ask`, the sandbox bypass prompt, workspace trust and hook behaviour in an interactive Director session, and in the desktop app and IDE.
- [ ] **Full model ids in agent files** (`model: gemini-4-argon-high`), which would give per-agent effort.
- [ ] **Parent → child follow-up** with `send_message`, and whether it keeps the child's model.
- [ ] **Worktree cleanup:** who removes subagent worktrees and branches after a run, and what `manage_subagents` offers.
- [ ] **The empty headless run** (1 of 17): reproduce and find the cause.
- [ ] **Admin controls:** `pluginsDisabled` and managed settings can switch plugins off; the Director needs the same "hooks not active" fallback as on Codex.

**Cleaning up after a test like this:** the spike uninstalled the plugin, removed its worktrees and test repos, and left Antigravity's `settings.json`, `config.json` and plugin list as they were. The test conversations remain under `~/.gemini/antigravity-cli/brain/<conversation id>/` and can be deleted.

## Sources

- Bundled: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/` (`docs/hooks.md`, `docs/plugins.md`, `docs/json_configs.md`)
- [Antigravity subagents](https://antigravity.google/docs/subagents)
- [Antigravity features (CLI)](https://antigravity.google/docs/features?tab=cli)
- Local: `agy --help`, `agy changelog`, `agy models`, `agy plugin validate`
