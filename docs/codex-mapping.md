# Codex mapping

How each piece of the `agent-team` plugin maps to Codex, as step 2 of supporting both harnesses as Director. Written against 0.2.0; the guard finding below was fixed in 0.2.1.

**Checked against:**
- Codex CLI 0.166.0 on Windows 11.
- OpenAI's Codex docs (Hooks, Subagents, Plugins → Build) as of 2026-10-31.
- A live install of this repo into an isolated Codex home.
- A live hook test with `gpt-6-luna`; see [Live test results](#live-test-results).

**Labels**
- ✅ **Verified** in a live run (see [Live test results](#live-test-results)).
- 📄 **Documented** by OpenAI, not yet tested here.
- ❌ **Differs from the docs**, found in the live test.
- ❓ **Unknown**: still needs a test (see [Still open](#still-open)).

## Summary

0. **The guard didn't protect Codex sessions before 0.2.1. Fixed in 0.2.1 ([#4](https://github.com/JoeEngineer/agent-team-v1/pull/4)).** Codex ignores exit code 2 from a `PreToolUse` hook (❌, contrary to its docs) but honours the JSON form, `hookSpecificOutput.permissionDecision: "deny"`. Since 0.2.1, `guard.js` blocks with that JSON response, which Claude Code also accepts. It was verified live in both tools. The same release stopped the guard reading heredoc and multi-line quoted text as commands.
1. **Codex is much closer to Claude Code than expected.** It uses the same hook event names and input fields, the same `hooks/hooks.json` location in plugins, and the same `SKILL.md` format. It even sets `CLAUDE_PLUGIN_ROOT` for hook commands.
2. **This repo installs into Codex unchanged.** ✅ `codex plugin marketplace add JoeEngineer/agent-team-v1` reads `.claude-plugin/marketplace.json`. Installing it picks up version 0.2.0 and turns argument-free Claude commands into Codex skills.
3. **So the plan changes:** one plugin package can serve both tools. Generate only the parts that really differ: agent definitions (Markdown header for Claude, TOML for Codex), tool names in hook matchers, and routing model names.
4. **The real gaps are in delegation, not packaging:**
   - Codex subagents share the parent's workspace, so there are no per-agent worktrees.
   - Plugins can't ship custom agents.
   - Codex has no "separate session" tool. `codex exec` is the closest equivalent.
5. **Admins can switch hooks off by policy** (managed `requirements.toml`). The Codex Director has to keep working, logging by hand, when they are.

## Concept-by-concept mapping

### Packaging and install

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `.claude-plugin/plugin.json` | Portable root `plugin.json` ([Agent Plugins schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)); `.codex-plugin/plugin.json` as a fallback; Claude manifests accepted | ✅ Claude manifest read (version 0.2.0) · 📄 portable format | OpenAI says new packages should use the portable root `plugin.json`. Adding one doesn't break Claude, which reads `.claude-plugin/`. |
| `.claude-plugin/marketplace.json` | Read as a "legacy-compatible" marketplace; native location is `.agents/plugins/marketplace.json` | ✅ | `codex plugin marketplace add owner/repo` works on this repo as-is. |
| `claude plugin install` | `codex plugin add agent-team@agent-team` | ✅ | Enabled in `config.toml` as `[plugins."agent-team@agent-team"] enabled = true`. |
| Project-scope enable (`.claude/settings.json`) | `[plugins."…"] enabled = true` in `<repo>/.codex/config.toml` | 📄 | Project config only applies once the project is **trusted**. |
| `claude plugin validate` | No validator found in CLI 0.166 | ✅ none | Test with a local marketplace entry plus a restart. |
| Git clone on Windows | Same, but the clone fails under long paths (`'$GIT_DIR' too big`) | ✅ | Hit with a long `CODEX_HOME`. Normal `~/.codex` is fine. |

### Instructions, skills and commands

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `CLAUDE.md` + standing authorization | `AGENTS.md` | 📄 | Same idea. `team-init` writes the agent-team section into `AGENTS.md` for Codex projects. |
| `skills/director/SKILL.md` + `references/` | `skills/<name>/SKILL.md`, found automatically | 📄 (format ✅ in bundled plugins) | Same frontmatter (`name`, `description`). Optional `agents/openai.yaml` in a skill is **display metadata only**, not a subagent. ❓ How plugin skills are named when invoked (`$director`? `agent-team:director`?). |
| `commands/*.md` (slash commands) | Converted into skills under `.codex-plugin/migrated-command-skills/` | ✅ partly | **Only `status` and `team-init` converted.** `milestone` and `coach` (which take `$ARGUMENTS`) were dropped. Fix: ship them as real skills that read their arguments from the user's message. |

Since 0.3.0 the four commands are skills under `skills/`, so Codex gets all of them.

### Agents and delegation

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `agents/*.md` (Markdown header: `model`, `effort`, `tools`) | One TOML file per agent in `.codex/agents/` (project) or `~/.codex/agents/` (user). Required: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort` | 📄 | Instructions move into `developer_instructions`. **Plugins can't ship agents** (not in the plugin docs), so `team-init` copies generated TOML into the project's `.codex/agents/`. |
| `tools:` allow-list per agent | Coarse switches only: `features.shell_tool`, `features.apps`, `features.plugins` = `false` | 📄 | No per-tool list. A read-only scout means sandbox and approval settings plus instructions. Note: a custom agent's `sandbox_mode` and `approval_policy` **don't override the parent's**. |
| `Agent` tool, `subagent_type` | Hooks report `tool_name: "collaborationspawn_agent"` (also `collaborationwait_agent`) | ❌ docs say `spawn_agent` | `tool_input`: `task_name`, `agent_type`, `reasoning_effort`, `fork_turns`, `message`. **`message` is encrypted** (`gAAAA…`), here and in the subagent transcript, so hooks **can't read the task card**. `tool_response`: `{"task_name":"/root/<name>"}`. ❓ Whether a matcher of `Agent` or `spawn_agent` catches it. Match `.*spawn_agent` to be safe. |
| Task card in the delegation prompt | Readable by hooks only through **`task_name`**, which is plain text | ✅ | The Codex Director puts the task ID in `task_name` (e.g. `auth-14-a1`) and writes the task card to the log itself (`log-event.js delegation …`) before spawning. Hooks link everything by `task_name` = the subagent's `agent_path` (in its transcript `session_meta`). |
| Per-delegation `model` / `effort` override | Explicit spawn value → `[agents]` default → parent's value; an agent file's `model` / `model_reasoning_effort` override all of these | ✅ | **Confirmed:** the spawn asked for `reasoning_effort: medium`, but `scout.toml`'s `low` was used (the subagent transcript's `turn_context.effort`). For the escalation ladder to raise a tier, the Director needs **one agent file per tier** (`implementer-medium`, `implementer-large`), or agent files that don't pin model or effort. Recommendation: per-tier files. |
| Agent TOML applied on Windows | Yes | ✅ | The older Windows bug ([#19399](https://github.com/openai/codex/issues/19399)) doesn't reproduce in 0.166. |
| `isolation: "worktree"` | **None.** Subagents inherit the parent's sandbox and workspace | 📄 | Biggest gap. The Director must make worktrees itself (`git worktree add`), point each writer at its own, and never run two writers in one tree. |
| Background subagents | Parallel by default; the parent waits for all results, then answers | 📄 | Up to `agents.max_concurrent_threads_per_session` (default not stated; `max_threads` is the old name). |
| `SendMessage` (resume a subagent) | `send_input` / `resume_agent` (also `wait_agent`, `close_agent`, `list_agents`) | ✅ names in the program · ❓ fields | Log a retry as `kind: "resume"` the same way. |
| Separate session (`start_session`) | `codex exec -C <worktree> -m <model> -c model_reasoning_effort=… --output-schema <file> --json`, run from the shell | ✅ flags exist | Arguably **better** for logging: `--json` streams events and `--output-schema` enforces `result-json`/`review-json`. It runs as the user's account like any shell command. Codex Cloud tasks exist too (experimental), but are out of scope at first. |
| Claude → Codex bridge (optional) | n/a | | Stays an optional routing row in the Claude package only. The Codex package never routes outside OpenAI models, so it suits environments without Claude. |

### Hooks (guard and logger)

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `hooks/hooks.json` in the plugin | Same default path, or a `hooks` entry in the manifest; also `.codex/hooks.json` and `[hooks]` in `config.toml` | 📄 · ✅ inline hooks in bundled plugins | Docs: plugin hooks are supported **only for manually installed Codex Desktop plugins**, and plugins with hooks can't be listed in the public directory. ❓ Whether CLI sessions run plugin hooks. Fallback: `team-init` writes project `.codex/hooks.json`. |
| Hooks run without asking | **Must be trusted.** Codex asks when it first starts in the project; `/hooks` reviews them later. Trust is stored in `~/.codex/config.toml` under `[hooks.state]`, one `trusted_hash` per hook entry (`<file>:<event>:<group>:<index>`). Installing a plugin doesn't trust its hooks | ✅ | The hash covers the hook **definition** (its command), not the script it runs: editing `guard.js` didn't need new trust, editing `hooks.json` would. So keep hook commands stable and put logic in scripts. One trust step per machine. `--dangerously-bypass-hook-trust` exists but shouldn't be used. |
| Admins can't disable | `[features] hooks = false`, enforceable through managed `requirements.toml` | 📄 | **Risk in managed environments.** If hooks are off, there's no guard and no automatic logs. The Codex Director must check (SessionStart marker missing → warn), log by hand with `scripts/log-event.js`, and rely on GitHub rulesets. |
| `PreToolUse` / `PostToolUse` | Same names | ✅ | Shell is **`Bash` even when the command is PowerShell** (`Get-ChildItem …` reported as `Bash`). File edits are `apply_patch`, MCP is `mcp__server__tool`, and spawns are `collaborationspawn_agent`. **They also fire for tool calls inside subagents:** the event's `transcript_path` is then the subagent's transcript, so the logger can tell who made the call. `session_id` is the parent's for both. |
| Block with exit 2 + stderr | **Exit 2 is ignored**; JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` on stdout with exit 0 **blocks** | ❌ / ✅ | Tested both against `git push origin main`. With exit 2 (`guard.js` 0.2.0, and again through a wrapper) the push ran. With the JSON response it was blocked, and the agent reported the guard's reason. `guard.js` 0.2.1 uses the JSON response and was re-tested as the only blocking hook: blocked, and no `PostToolUse` fired. Run in `codex exec --sandbox workspace-write` (hook `permission_mode: bypassPermissions`). ❓ Whether exit 2 works in other approval modes. Don't depend on it. |
| `SubagentStop` + transcript parsing | `SubagentStop` with `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` | ✅ | `last_assistant_message` held the scout's full reply, including its `result-json` block. Read results from it directly, without parsing the transcript. |
| Tokens and actual effort | Subagent transcript (`agent_transcript_path`): `turn_context` has `model` and `effort`; `event_msg/token_count` has a running `total_token_usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`) | ✅ | Take the last `token_count` event. `session_meta` has `agent_role`, `agent_path`, `parent_thread_id` and `depth`, which is enough to link the result to its delegation. |
| `SubagentStart` | Exists (`agent_id`, `agent_type`, plus the subagent's `transcript_path`) | ✅ | `agent_id` is the subagent's thread ID; the same value appears in its transcript file name. |
| Common hook fields | `session_id` (the parent's, for subagents), `transcript_path`, `cwd`, `hook_event_name`, **`model`**, `turn_id`, `permission_mode` | 📄 | `model` on every event means the real model is logged without any lookup. |
| `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`, plus `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` for compatibility | 📄 · ✅ absent for project hooks | Set only for **plugin** hooks. Project hooks (`.codex/hooks.json`) get neither, so their commands need absolute paths or a git-root lookup. `lib.js` already falls back to the script's own folder. |
| `CLAUDE_PROJECT_DIR` | **None.** Hooks run in the session `cwd` | 📄 | `lib.projectDir()` already falls back to `input.cwd` (checked in 0.2.0), but that may be a subfolder. Change it to use `git rev-parse --show-toplevel`. |
| Hook matchers in `hooks/hooks.json` | `Bash`, `apply_patch`, `spawn_agent`/`Agent`, `mcp__…` | ✅ checked 0.2.0 file | The current matchers include `Agent` and `Bash`, which Codex also uses. `PowerShell`, `Task`, `SendMessage` and `mcp__ccd_*` are Claude-only and harmless in Codex. Add `spawn_agent\|send_input\|resume_agent` for Codex. |
| Windows command | `commandWindows` / `command_windows` override per hook | 📄 | Same `node "…"` command works for both, so this isn't needed at first. |

### Permissions and visibility

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| Permission modes, auto mode | `approval_policy`, `sandbox_mode`, and a `PermissionRequest` hook | 📄 | A `PermissionRequest` hook could auto-approve narrow, known-safe actions for the Director. Leave that until later. |
| Remote Control (phone) | `codex remote-control` (experimental); the ChatGPT web sidebar shows subagents **read-only** | ✅ command exists | Not needed for the Codex adapter at first. |
| Subagent visibility | CLI `/subagents`; Desktop has a Subagents panel (Active / Done) | 📄 | |

### Models and effort

Both families have **four** models, largest first:
- **Claude:** Fable → Opus → Sonnet → Haiku.
- **OpenAI:** Astra → Sol → Terra → Luna. Terra is the newest and reportedly better than Sol at writing.

`models_cache.json` only gives short descriptions, so the orderings come from user reports. The top model of each family is off by default, because not every user can use it:
- **Fable** is billed as **usage credits** (API rates) on some Claude plans, not covered by the plan.
- **Astra** isn't available in every OpenAI environment.

Some environments don't have Claude at all, or have only some OpenAI models. So both families get the same shape: three **standard** tiers built from widely available models, plus an opt-in **xlarge** tier.

| Tier | Claude | Codex | On by default? | Notes |
|---|---|---|---|---|
| small | `haiku` | `gpt-6-luna` ("fast and affordable") | yes | `gpt-reserve` is also listed as "fast and affordable agentic coding". Worth comparing. |
| medium | `sonnet` | `gpt-6.1-terra` | yes | Below Sol in general ability, reportedly better than Sol at writing. A good fit for `docs`, PR descriptions and decision records. |
| large | `opus` | `gpt-6.1-sol` ("workhorse") | yes | **Top of the escalation ladder.** |
| xlarge | `fable` | `gpt-6-astra` ("frontier") | **no** | Opt-in per install, and per task (see the rule below). Installs without access to these models leave the entries out. |

**The tiers aren't equal across families.** Codex `large` (Sol) is a step below the top of its family, while Claude `large` (Opus) is the top of what most plans cover. Expect Codex installs to escalate sooner, and to need `high` effort more often. The Coach should compare results **per model**, using the `model` field Codex reports, not per tier name across tools.

**Rule for opt-in tiers:** an xlarge tier, or any tier marked `billing = "credits"` or `enabled = false`, is never chosen by the routing table or the escalation ladder.
- When the ladder runs out at `large`, the Director stops and asks the user, as it does today.
- It can *offer* xlarge with a note on cost or availability, and only uses it after a yes for that task.
- The log line records `tier: xlarge` and the billing flag, so the Coach can show what those tasks cost and whether they passed review.

**Per-install model map** (a sketch; the restructure decides the file name):

```toml
# Both tools available, with access to the top models
[tiers.small]   claude = "haiku"   codex = "gpt-6-luna"
[tiers.medium]  claude = "sonnet"  codex = "gpt-6.1-terra"
[tiers.large]   claude = "opus"    codex = "gpt-6.1-sol"
[tiers.xlarge]  enabled = false
  claude = { model = "fable", billing = "credits" }   # API-rate usage credits on some plans
  codex  = { model = "gpt-6-astra" }                  # only where Astra is available

# Codex only, without Astra: no claude keys, no xlarge
[tiers.small]   codex = "gpt-6-luna"
[tiers.medium]  codex = "gpt-6.1-terra"
[tiers.large]   codex = "gpt-6.1-sol"
```

The routing table names tiers only. Each package resolves them through this map, so the core routing file stays shared. A tool with no entries in the map is simply never routed to. If a mapped model is missing at run time (models change, or an environment doesn't offer it), the Director falls back one tier down, logs `"tier_fallback"`, and tells the user. It never falls back up.

| Effort tier | Claude | Codex |
|---|---|---|
| low / medium / high | `low` / `medium` / `high` | `low` / `medium` / `high` |
| (unused at first) | `xhigh`, `max` | `xhigh`, `max`, `ultra` (model-dependent) |

Higher effort levels cost more with both tools. They stay off the ladder at first, like the xlarge tier, until the Coach has data that `high` isn't enough for some task type.

The routing table should name **tiers**. Each package maps tiers to models in one small, per-install config file, because accounts and environments expose different models. Logs record both the tier and the `model` Codex reports.

## What this means for the restructure (step 3)

The earlier plan was a harness-neutral `core/` plus two generated adapters. With the compatibility findings, it gets simpler:

- **One plugin folder, two manifests.** Keep `.claude-plugin/`. Add a portable root `plugin.json` so Codex treats it as a native plugin. `skills/`, `hooks/hooks.json` and `scripts/` are shared as-is.
- **Generate only:**
  - **Agent definitions.** Markdown header for Claude; TOML per tier for Codex, which `team-init` installs into `.codex/agents/`.
  - **Routing model names**, per tool.
  - **Hook matcher tool names**, where they differ (`start_session` / bridges are Claude-only).
- **Turn `commands/` into skills**, so both tools get the same entry points, `milestone` and `coach` included.
- **Make `scripts/` tool-aware**, picking the parser by tool name and fields:
  - Claude's `Agent` input vs Codex's `collaborationspawn_agent`.
  - Codex's `last_assistant_message` vs Claude's transcript parsing.
  - Codex's `task_name` link, since its spawn message is encrypted.
- **Block with JSON, not exit codes.** Done in 0.2.1 (#4). Any new blocking hook should follow the same pattern: `hookSpecificOutput.permissionDecision: "deny"` with exit 0.
- **Director instructions:** one `director` skill with a short per-tool section on how to delegate:
  - Claude: `Agent` with worktree isolation, sessions.
  - Codex: spawn with `task_name` = task ID and a per-tier agent type, after logging the task card. Director-made worktrees. `codex exec` for long work.

## Live test results

**Run:** 2026-10-31, Codex CLI 0.166.0, Windows 11, in a throwaway git repo (called `<test-repo>` below). That repo has:
- project hooks for every event, writing their input to `.dump/`,
- this repo's `guard.js` on `Bash`,
- a `scout` agent in `.codex/agents/scout.toml` (`gpt-6-luna`, `low`).

Each run was `codex exec -m gpt-6-luna -c model_reasoning_effort="low" --sandbox workspace-write`, with no bypass flags. The folder and its hooks were trusted through Codex's startup prompt; all seven hooks then showed up under `[hooks.state]`. About 17–18k tokens per run.

| Question | Answer |
|---|---|
| Spawn tool name and fields | `collaborationspawn_agent`: `task_name`, `agent_type`, `reasoning_effort`, `fork_turns`, `message` (encrypted). The response is `{"task_name":"/root/<name>"}`. |
| Is a per-spawn `reasoning_effort` honoured? | **Not when the agent file sets one.** The spawn asked for `medium`, and the scout ran at `low` from its TOML. |
| Agent TOML applied on Windows? | Yes. |
| Do hooks fire inside subagents? | Yes. The scout's `Bash` call was captured, with the subagent's own `transcript_path`. |
| Shell `tool_name` on Windows | `Bash`, even for PowerShell commands. |
| Does the guard block a push? | **Not with exit code 2.** `guard.js` 0.2.0 exited 2 with its reason, and the push ran anyway (twice). **Yes with the JSON response:** it was blocked, and the agent repeated the guard's reason. 0.2.1 ships the JSON response. |
| Subagent result | `SubagentStop.last_assistant_message` has the full final reply, `result-json` block included. |
| Tokens and actual effort | Subagent transcript: `turn_context` (`model`, `effort`) and the last `event_msg/token_count` (`total_token_usage`). |
| Hook environment (project hooks) | No `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` (they're for plugin hooks only), and no project directory variable. `cwd` was the repo root. |

## Still open

- [ ] **Do CLI sessions run *plugin* hooks?** The test used project hooks. OpenAI's docs say plugin hooks are for manually installed **Desktop** plugins. If the CLI skips them, `team-init` has to write `.codex/hooks.json` into each project. Test that in step 4 with the real plugin installed.
- [ ] **Does exit 2 block in other approval modes** (e.g. `on-request`)? Doesn't matter once the guard uses JSON. Worth reporting to OpenAI, since the docs say exit 2 blocks.
- [ ] **Does a matcher of `Agent` or `spawn_agent` catch `collaborationspawn_agent`?** Use `.*spawn_agent` until it's checked.
- [ ] **How are plugin skills named when invoked** (`$director`, `agent-team:director`, …)?
- [ ] **Codex Desktop** shares `~/.codex` with the CLI (same `config.toml`), but its subagent and hook behaviour wasn't tested separately.

**Cleaning up after a test like this:** trusting a project and its hooks leaves entries in your Codex config. To remove them:
- Delete `<test-repo>`.
- Remove its entries from `~/.codex/config.toml`: the `[projects.'<test-repo>']` table and the `[hooks.state.'<test-repo>\.codex\hooks.json:…']` tables (one per trusted hook).
- Optionally delete the test sessions from `~/.codex/sessions/<year>/<month>/<day>/`.

Keep `<test-repo>` on a short path on Windows: git fails to clone or check out under very long paths (`'$GIT_DIR' too big`).

## Sources

- [Codex Hooks](https://developers.openai.com/codex/hooks) (now at learn.chatgpt.com/docs/hooks)
- [Codex Subagents](https://developers.openai.com/codex/subagents) (now at learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex Plugins: package your plugin](https://developers.openai.com/codex/plugins/build)
- [openai/codex#26948](https://github.com/openai/codex/issues/26948): per-spawn `reasoning_effort` works but isn't advertised
- [openai/codex#19399](https://github.com/openai/codex/issues/19399): agent TOML config not applied on Windows (older report)
- Local: `codex --help`, `codex exec --help`, `codex features list`, bundled plugins in `~/.codex/plugins/cache`, `~/.codex/models_cache.json`
