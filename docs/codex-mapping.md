# Codex mapping

How each piece of the `agent-team` plugin (0.2.0) maps to Codex, as step 2 of supporting both harnesses as Director.

**Checked against:** Codex CLI 0.166.0 on Windows 11, OpenAI's Codex docs (Hooks, Subagents, Plugins → Build) as of 2026-10-31, and a live install of this repo into an isolated Codex home.

**Labels**
- ✅ **Verified** on this machine.
- 📄 **Documented** by OpenAI, not yet tested here.
- ❓ **Unknown**: not documented, needs a live test (see [Open questions](#open-questions)).

## Summary

1. **Codex is much closer to Claude Code than expected.** It uses the same hook events and input fields, the same exit-code-2 block, the same `hooks/hooks.json` location in plugins, and the same `SKILL.md` format. It even sets `CLAUDE_PLUGIN_ROOT` for hook commands.
2. **This repo installs into Codex unchanged.** ✅ `codex plugin marketplace add JoeEngineer/agent-team-v1` reads `.claude-plugin/marketplace.json`. Installing it picks up version 0.2.0 and turns argument-free Claude commands into Codex skills.
3. **So the plan changes:** one plugin package can serve both tools. Generate only the parts that really differ: agent definitions (Markdown header for Claude, TOML for Codex), tool names in hook matchers, and routing model names.
4. **The real gaps are in delegation, not packaging:**
   - Codex subagents share the parent's workspace, so there are no per-agent worktrees.
   - Plugins can't ship custom agents.
   - Codex has no "separate session" tool. `codex exec` is the closest equivalent.
5. **At work, hooks may be switched off by policy** (`requirements.toml`). The Codex Director has to keep working, logging by hand, when they are.

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

### Agents and delegation

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `agents/*.md` (Markdown header: `model`, `effort`, `tools`) | One TOML file per agent in `.codex/agents/` (project) or `~/.codex/agents/` (user). Required: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort` | 📄 | Instructions move into `developer_instructions`. **Plugins can't ship agents** (not in the plugin docs), so `team-init` copies generated TOML into the project's `.codex/agents/`. |
| `tools:` allow-list per agent | Coarse switches only: `features.shell_tool`, `features.apps`, `features.plugins` = `false` | 📄 | No per-tool list. A read-only scout means sandbox and approval settings plus instructions. Note: a custom agent's `sandbox_mode` and `approval_policy` **don't override the parent's**. |
| `Agent` tool, `subagent_type` | `spawn_agent` (hooks also match it as `Agent`) | 📄 | ❓ Exact `tool_input` fields. Per GitHub issues: agent type, message, and `reasoning_effort` (not `model_reasoning_effort`) per spawn. |
| Per-delegation `model` / `effort` override | Explicit spawn value → `[agents]` default → parent's value; an agent file's `model` / `model_reasoning_effort` override all of these | 📄 | ⚠️ Odd ordering: **the agent file wins over an explicit spawn value.** For the escalation ladder to raise a tier, the agent file must *not* pin model/effort, or the Director needs one agent file per tier (`implementer-medium`, `implementer-large`). Recommendation: per-tier files. |
| `isolation: "worktree"` | **None.** Subagents inherit the parent's sandbox and workspace | 📄 | Biggest gap. The Director must make worktrees itself (`git worktree add`), point each writer at its own, and never run two writers in one tree. |
| Background subagents | Parallel by default; the parent waits for all results, then answers | 📄 | Up to `agents.max_concurrent_threads_per_session` (default not stated; `max_threads` is the old name). |
| `SendMessage` (resume a subagent) | `send_input` / `resume_agent` (also `wait_agent`, `close_agent`, `list_agents`) | ✅ names in the program · ❓ fields | Log a retry as `kind: "resume"` the same way. |
| Separate session (`start_session`) | `codex exec -C <worktree> -m <model> -c model_reasoning_effort=… --output-schema <file> --json`, run from the shell | ✅ flags exist | Arguably **better** for logging: `--json` streams events and `--output-schema` enforces `result-json`/`review-json`. It runs as the user's account like any shell command. Codex Cloud tasks exist too (experimental), but are out of scope at first. |
| Claude → Codex bridge (personal) | n/a | | Stays a routing row in the Claude package only. Never in the Codex package (work = OpenAI only). |

### Hooks (guard and logger)

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| `hooks/hooks.json` in the plugin | Same default path, or a `hooks` entry in the manifest; also `.codex/hooks.json` and `[hooks]` in `config.toml` | 📄 · ✅ inline hooks in bundled plugins | Docs: plugin hooks are supported **only for manually installed Codex Desktop plugins**, and plugins with hooks can't be listed in the public directory. ❓ Whether CLI sessions run plugin hooks. Fallback: `team-init` writes project `.codex/hooks.json`. |
| Hooks run without asking | **Must be trusted** through `/hooks` (interactive). Trust is tied to the hook's hash, so every change means trusting again. Installing a plugin doesn't trust its hooks | 📄 | One manual step per machine and per hook change. Put it in the setup instructions. `--dangerously-bypass-hook-trust` exists but shouldn't be used. |
| Admins can't disable | `[features] hooks = false`, enforceable through managed `requirements.toml` | 📄 | **Work risk.** If hooks are off, there's no guard and no automatic logs. The Codex Director must check (SessionStart marker missing → warn), log by hand with `scripts/log-event.js`, and rely on GitHub rulesets. |
| `PreToolUse` / `PostToolUse` | Same names | 📄 | Shell is `Bash` (including unified exec), file edits are `apply_patch` (also matches `Edit`/`Write`), MCP is `mcp__server__tool`, and `spawn_agent` also matches `Agent`. Hosted tools such as web search aren't covered. ❓ Whether these fire for tool calls *inside* subagents. |
| Block with exit 2 + stderr | Same; also `hookSpecificOutput.permissionDecision: "deny"` | 📄 | `guard.js` should work unchanged. ❓ Whether Windows shell commands report as `Bash` even under PowerShell. |
| `SubagentStop` + transcript parsing | `SubagentStop` with `agent_id`, `agent_type`, `agent_transcript_path`, **`last_assistant_message`** | 📄 | Simpler than Claude: read `result-json`/`review-json` from `last_assistant_message` directly. Tokens still need the transcript (❓ format). |
| `SubagentStart` | Exists (`agent_id`, `agent_type`) | 📄 | Can be used to log the launch when spawn input is hard to parse. |
| Common hook fields | `session_id` (the parent's, for subagents), `transcript_path`, `cwd`, `hook_event_name`, **`model`**, `turn_id`, `permission_mode` | 📄 | `model` on every event means the real model is logged without any lookup. |
| `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`, plus `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` for compatibility | 📄 | `lib.js` works as-is. |
| `CLAUDE_PROJECT_DIR` | **None.** Hooks run in the session `cwd` | 📄 | `lib.projectDir()` already falls back to `input.cwd` (checked in 0.2.0), but that may be a subfolder. Change it to use `git rev-parse --show-toplevel`. |
| Hook matchers in `hooks/hooks.json` | `Bash`, `apply_patch`, `spawn_agent`/`Agent`, `mcp__…` | ✅ checked 0.2.0 file | The current matchers include `Agent` and `Bash`, which Codex also uses. `PowerShell`, `Task`, `SendMessage` and `mcp__ccd_*` are Claude-only and harmless in Codex. Add `spawn_agent\|send_input\|resume_agent` for Codex. |
| Windows command | `commandWindows` / `command_windows` override per hook | 📄 | Same `node "…"` command works for both, so this isn't needed at first. |

### Permissions and visibility

| agent-team (Claude) | Codex | Status | Notes |
|---|---|---|---|
| Permission modes, auto mode | `approval_policy`, `sandbox_mode`, and a `PermissionRequest` hook | 📄 | A `PermissionRequest` hook could auto-approve narrow, known-safe actions for the Director. Leave that until later. |
| Remote Control (phone) | `codex remote-control` (experimental); the ChatGPT web sidebar shows subagents **read-only** | ✅ command exists | Not a goal for the work setup. |
| Subagent visibility | CLI `/subagents`; Desktop has a Subagents panel (Active / Done) | 📄 | |

### Models and effort

Both families have **four** models, largest first:
- **Claude:** Fable → Opus → Sonnet → Haiku.
- **OpenAI:** Astra → Sol → Terra → Luna. Terra is the newest and reportedly better than Sol at writing.

The orderings come from the project owner; `models_cache.json` only gives short descriptions. The top model of each family is off-limits by default:
- **Fable** needs **usage credits** on the owner's Claude plan (billed at API rates, not covered by the plan).
- **Astra** isn't available in the owner's work environment.

So both families get the same shape: three **standard** tiers built from models every install can use, plus an opt-in **xlarge** tier.

| Tier | Claude | Codex | On by default? | Notes |
|---|---|---|---|---|
| small | `haiku` | `gpt-6-luna` ("fast and affordable") | yes | `gpt-reserve` is also listed as "fast and affordable agentic coding". Worth comparing. |
| medium | `sonnet` | `gpt-6.1-terra` | yes | Below Sol in general ability, reportedly better than Sol at writing. A good fit for `docs`, PR descriptions and decision records. |
| large | `opus` | `gpt-6.1-sol` ("workhorse", the owner's current default) | yes | **Top of the escalation ladder.** Available at work. |
| xlarge | `fable` | `gpt-6-astra` ("frontier") | **no** | Opt-in per install, and per task (see the rule below). A work install leaves the Codex entry out entirely. |

**The tiers aren't equal across families.** Codex `large` (Sol) is a step below the top of its family, while Claude `large` (Opus) is the top of what the plan covers. Expect Codex installs to escalate sooner, and to need `high` effort more often. The Coach should compare results **per model**, using the `model` field Codex reports, not per tier name across tools.

**Rule for opt-in tiers:** an xlarge tier, or any tier marked `billing = "credits"` or `enabled = false`, is never chosen by the routing table or the escalation ladder.
- When the ladder runs out at `large`, the Director stops and asks the user, as it does today.
- It can *offer* xlarge with a note on cost or availability, and only uses it after a yes for that task.
- The log line records `tier: xlarge` and the billing flag, so the Coach can show what those tasks cost and whether they passed review.

**Per-install model map** (a sketch; the restructure decides the file name):

```toml
# personal machine
[tiers.small]   claude = "haiku"   codex = "gpt-6-luna"
[tiers.medium]  claude = "sonnet"  codex = "gpt-6.1-terra"
[tiers.large]   claude = "opus"    codex = "gpt-6.1-sol"
[tiers.xlarge]  enabled = false
  claude = { model = "fable", billing = "credits" }   # API-rate usage credits
  codex  = { model = "gpt-6-astra" }                  # personal account only

# work machine: no claude keys, no xlarge
[tiers.small]   codex = "gpt-6-luna"
[tiers.medium]  codex = "gpt-6.1-terra"
[tiers.large]   codex = "gpt-6.1-sol"
```

The routing table names tiers only. Each package resolves them through this map, so the core routing file stays shared. If a mapped model is missing at run time (models change), the Director falls back one tier down, logs `"tier_fallback"`, and tells the user. It never falls back up.

| Effort tier | Claude | Codex |
|---|---|---|
| low / medium / high | `low` / `medium` / `high` | `low` / `medium` / `high` |
| (unused at first) | `xhigh`, `max` | `xhigh`, `max`, `ultra` (model-dependent) |

Higher effort levels cost more on both plans. They stay off the ladder at first, like the xlarge tier, until the Coach has data that `high` isn't enough for some task type.

The routing table should name **tiers**. Each package maps tiers to models in one small, per-install config file, because the work account may expose different models. Logs record both the tier and the `model` Codex reports.

## What this means for the restructure (step 3)

The earlier plan was a harness-neutral `core/` plus two generated adapters. With the compatibility findings, it gets simpler:

- **One plugin folder, two manifests.** Keep `.claude-plugin/`. Add a portable root `plugin.json` so Codex treats it as a native plugin. `skills/`, `hooks/hooks.json` and `scripts/` are shared as-is.
- **Generate only:**
  - **Agent definitions.** Markdown header for Claude; TOML per tier for Codex, which `team-init` installs into `.codex/agents/`.
  - **Routing model names**, per tool.
  - **Hook matcher tool names**, where they differ (`start_session` / bridges are Claude-only).
- **Turn `commands/` into skills**, so both tools get the same entry points, `milestone` and `coach` included.
- **Make `scripts/` tool-aware**, picking the parser by tool name and fields: `spawn_agent` input vs `Agent`, and `last_assistant_message` vs transcript parsing.
- **Director instructions:** one `director` skill with a short per-tool section on how to delegate:
  - Claude: `Agent` with worktree isolation, sessions.
  - Codex: `spawn_agent` plus Director-made worktrees, and `codex exec` for long work.

## Open questions

The live test needs hooks to be trusted, which this session couldn't do safely (it would have needed `--dangerously-bypass-hook-trust`). The test repo is ready at `C:\Users\JoeBr\.cxt-b`. It has capture hooks for every event, the real `guard.js` on `Bash`, and a `scout` agent in Codex TOML format.

**To finish it:**
1. In a terminal: `cd C:\Users\JoeBr\.cxt-b`, run `codex`, and trust the folder when asked.
2. Type `/hooks`, review the hooks (they only run `dump.js` and this repo's `guard.js`), and trust them. Then exit.
3. Ask Claude to run the live test. It runs `codex exec` there with `gpt-6-luna` at low effort, with no bypass flags.

**What it answers:**
- [ ] `spawn_agent` `tool_input` / `tool_response` fields, including whether `reasoning_effort` per spawn is honoured.
- [ ] Whether `scout.toml`'s `model` / `model_reasoning_effort` are applied on Windows (an older issue said no).
- [ ] Whether `PreToolUse` fires for tool calls inside subagents.
- [ ] Whether `guard.js` blocks `git push origin main` through Codex (exit 2), and what `tool_name` the Windows shell reports.
- [ ] Subagent transcript format, for token counts.
- [ ] Whether CLI sessions run **plugin** hooks or only project/user hooks.
- [ ] How plugin skills are named when invoked.

## Sources

- [Codex Hooks](https://developers.openai.com/codex/hooks) (now at learn.chatgpt.com/docs/hooks)
- [Codex Subagents](https://developers.openai.com/codex/subagents) (now at learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex Plugins: package your plugin](https://developers.openai.com/codex/plugins/build)
- [openai/codex#26948](https://github.com/openai/codex/issues/26948): per-spawn `reasoning_effort` works but isn't advertised
- [openai/codex#19399](https://github.com/openai/codex/issues/19399): agent TOML config not applied on Windows (older report)
- Local: `codex --help`, `codex exec --help`, `codex features list`, bundled plugins in `~/.codex/plugins/cache`, `~/.codex/models_cache.json`
