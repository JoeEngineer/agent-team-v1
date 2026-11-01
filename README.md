# agent-team

A plugin for **Claude Code and Codex** that runs the **Director pattern**: one session acts as Director, breaks broad tasking into tasks, and delegates each to a role agent or a separate session with an explicitly chosen tier (model) and effort level. Every delegation, review verdict, merge and decision is logged, so a Coach agent can later tune the routing.

## What's in it

| Path | What |
|---|---|
| `skills/director/` | The Director's instructions, routing table, task-card format, decision-record format, merge rules. `references/codex.md` holds the Codex-specific steps |
| `agents/` | Role agents with a default tier and effort: `scout` (small/low), `implementer` (medium/medium), `architect` (large/high), `reviewer` (medium/high), `coach` (large/high). Each tier maps to a model per tool via `config/models.json` |
| `skills/` | `director` plus `team-init`, `milestone`, `status`, `coach`. In Claude Code they're invoked as `/agent-team:<name>`; in Codex, as `$agent-team:<name>` |
| `config/models.json` | Tier → model map per tool, with `enabled` and `billing` (see [Models and tiers](#models-and-tiers)) |
| `hooks/hooks.json` | The plugin's hook set for Claude Code: logger, guard and the SessionStart hooks-active check. The Codex CLI doesn't run plugin hooks, so on Codex `team-init` writes project hooks from this file ([Codex](#codex)) |
| `scripts/log-delegation.js` | Logs delegations, results, reviews and merges to `.agent-team/logs/*.jsonl` in the project |
| `scripts/guard.js` | Blocks merges into `main`/`master`, force-pushes, pushes to protected branches, branch-protection and repo changes, releases, and `git add -A`/`.` while unignored agent worktrees exist |
| `scripts/log-event.js` | Manual logging: decisions, escalations, notes, pauses, and the Director's own delegation and review lines (used for Codex) |
| `scripts/models.js` | `show` prints the effective tier → model map; `resolve <tier> [--tool t]` prints the model for a tier; `up <tier>` and `down <tier>` move to the next auto-eligible tier for a tool |
| `scripts/codex-log.js` | Codex hook handler. Writes full records (delegation, completion, review, merge) into the shared log files with `tool: "codex"`, and selected raw fields of Codex events into `codex-events.jsonl` |
| `scripts/codex-agents.js` | Writes `.codex/agents/<role>-<tier>.toml` for each role and enabled Codex tier, from the model map. Per machine, gitignored. `--check` reports drift |
| `scripts/codex-hooks.js` | Writes the project's `.codex/hooks.json` and `.codex/agent-team-hook.js`. Both are committed |
| `scripts/session-start.js` | SessionStart hook. Tells the session `agent-team hooks: active (<tool>, <version>)` so the Director can see that hooks run |
| `scripts/archive-logs.js` | Milestone close: copies the project's logs to an archive folder outside the repo, and with `--clear` removes the live copies once the archive is verified |
| `scripts/reconcile-logs.js` | Drains snapshots from observed Codex stops and backfills Claude completion/review records from transcripts. May rewrite `completions.jsonl`/`reviews.jsonl` to add `stale_of` to lines holding another attempt's report; all other lines are kept as they were |
| `plugin.json` (root) | Portable Agent Plugins manifest that Codex reads; `.claude-plugin/` stays for Claude Code |
| `templates/project/` | Files `/agent-team:team-init` copies into a project, including the Codex hook shim |

## How it works

```
You ── tasking ──▶ Director (this session)
                     │  task card: TASK id=… type=… difficulty=…  WHY …
                     ├─▶ scout / architect / implementer  (subagents, worktree for writers)
                     ├─▶ separate sessions                (long work → PR into milestone/<slug>)
                     ├─▶ codex / antigravity bridges      (optional, local only)
                     └─▶ reviewer ── review-json verdict ──▶ Director merges into milestone/<slug>
                                                             You merge milestone/<slug> → main
hooks ──▶ .agent-team/logs/{delegations,reviews,merges,decisions,completions}.jsonl ──▶ coach
```

- **Routing:** `skills/director/references/routing.md`: task type × difficulty → agent, tier, effort, vehicle, plus an escalation ladder (feedback → more effort → bigger tier → architect).
- **Codex logging:** Codex records go into the same log files as Claude's, with `tool: "codex"`. The spawn message is encrypted on Codex, so the Director logs each Codex delegation itself before spawning it (`log-event.js delegation` with the task card and a `task_name`). The hooks then link the subagent's completion and review to that line by `task_name`, and only add a fallback line if the Director didn't log one. `codex-events.jsonl` is a raw debug log, not used by the Coach.
- **Records:** each log line carries `guidance_version` (this plugin's version), so the Coach can compare results before and after a routing change.
- **Merges:** GitHub won't let an account approve its own PR, so the reviewer's verdict is recorded in the logs and as a PR comment, and the Director merges task PRs into the milestone branch. The guard hook stops it from merging into `main`.
- **Script commands:** run them from the project root with the plugin path, `node "<plugin root>/scripts/…"`, as `team-init` does. The commands below are written relative to the plugin root.
- **Milestone close:** `node scripts/archive-logs.js <milestone>` copies the project's logs to `<archive>/<project>/<date>-<milestone>/`. The archive is `~/.agent-team/archive/` by default, or the folder in `AGENT_TEAM_ARCHIVE`. Add `--clear` to delete the live logs after the archive is verified; `--dry-run` shows what would happen.
- **Backfill:** `node scripts/reconcile-logs.js` drains snapshots from observed Codex stop events and rebuilds missing Claude completion or review records from Claude subagent transcripts. Codex stop events may be saved temporarily while the child transcript finishes; a later hook dispatch (including `wait_agent`) or reconciliation drains them. An entirely missed Codex stop leaves no snapshot to recover. In Codex-only projects, reconciliation handles pending snapshots before checking for a Claude projects root. `--dry-run` previews work without changing logs or pending files. Rebuilt Claude lines are marked `report_source: "reconcile"`. For a resumed agent, reconcile may also rewrite `completions.jsonl` and `reviews.jsonl` to add `stale_of` to lines that hold a different attempt's report (for example, an older logger wrote turn 1's report under attempt 2). `stale_of` names the attempt the content really belongs to, and readers (the Coach) drop lines that carry it. Only those lines change; every other line, including ones that are not valid JSON, is kept byte for byte, and lines a hook appends while the rewrite runs are carried over (an append in the instant before the final file swap can still be lost, so run it when no agents are active). Since 0.4.2 it exits 1 on errors (it used to exit 0). It prints how many lines it marked and in which files. If a file cannot be rewritten, the file is left as it was and the command exits 1. `--dry-run` only reports the count.

## Models and tiers

Agents and the routing table name tiers, not models. Each tier maps to a model per tool:

| Tier | Claude | Codex | On by default |
|---|---|---|---|
| small | haiku | gpt-6-luna | yes |
| medium | sonnet | gpt-6.1-terra | yes |
| large | opus | gpt-6.1-sol | yes |
| xlarge | fable (billed as usage credits on some plans) | gpt-6-astra (not available everywhere) | **no** |

- The model names are the shipped defaults. The Director never assumes a model is available: if a mapped model is missing, it falls back as described below. An account without one of the tools can drop that column with an override.
- Routing and the escalation ladder never pick xlarge or any entry with `enabled: false` or `billing: "credits"`. The Director may offer xlarge, and uses it only after you say yes for that task.
- A tool with no entries in the map is never routed to.
- **Override:** copy `config/models.json` to `~/.agent-team/models.json` (or point `AGENT_TEAM_MODELS` at a file) and edit it. The override replaces the whole map, so it must list every tier you use. Run `node scripts/models.js show` to see the effective map. Example: a Codex-only install deletes the `claude` keys and leaves xlarge disabled.
- **Fallback:** if a mapped model isn't available at run time, the Director falls back one tier down, logs `tier_fallback`, and tells you. It never falls up.
- **Logs** record `tier`, `tier_source`, `resolved_model` and `billing`.

## Install

**Before you install:** the plugin's hooks run Node scripts on your machine on every subagent, session, shell and bridge call, in both Claude Code and Codex. They're short and dependency-free. Read [`scripts/`](scripts/) first, as you would for any plugin with hooks.

### Claude Code

This repo is its own one-plugin marketplace. In Claude Code (2.1.275 or later):

```
/plugin install agent-team --marketplace JoeEngineer/agent-team-v1
```

Or from a terminal:

```bash
claude plugin marketplace add JoeEngineer/agent-team-v1
```

```bash
claude plugin install agent-team@agent-team
```

**Turn it on for a whole team:** commit this to the project's `.claude/settings.json`, so anyone who opens the project is offered the plugin:

```json
{
  "extraKnownMarketplaces": {
    "agent-team": { "source": { "source": "github", "repo": "JoeEngineer/agent-team-v1" } }
  },
  "enabledPlugins": { "agent-team@agent-team": true }
}
```

Then in the project: `/agent-team:team-init`, then `/agent-team:milestone <slug> <tasking>`.

### Codex

1. **Install the plugin.**

   ```bash
   codex plugin marketplace add JoeEngineer/agent-team-v1
   ```

   ```bash
   codex plugin add agent-team@agent-team
   ```

   This installs the skills. Invoke them as `$agent-team:<skill>`, for example `$agent-team:team-init`. The Codex CLI doesn't run plugin hooks, so the guard and logging need step 2.

2. **Run `$agent-team:team-init` in each project.** On Codex it:
   - generates `.codex/agents/<role>-<tier>.toml` from the model map. These are gitignored, because they bake in your model map. Re-run `node scripts/codex-agents.js` after a plugin update or a map change;
   - writes the project's `.codex/hooks.json` and `.codex/agent-team-hook.js`. Commit both. They are what make the guard and logging work on Codex.

3. **Trust the project and its hooks, once.** Accept the startup prompt, or open `/hooks` and trust them. Untrusted hooks fail silently: nothing is guarded or logged, and no error is shown. Trust them again after a plugin update or regeneration that changes the hook set.

4. **Check the hooks.** The first session should show `agent-team hooks: active (codex, <version>)`. If that line is missing, the hooks are not running. The Director then warns you, logs by hand with `log-event.js`, and relies on the GitHub rulesets below, since the guard isn't running.

On Windows, a very long `CODEX_HOME` path can break the git clone during install. If that happens, use a shorter `CODEX_HOME`.

## Protect your branches

Do this in every repo where the Director will work, before the first milestone.

**Why:** the plugin's guard hook stops the Director from merging into `main` or force-pushing. But it's a hook on your machine that reads commands as text, so a mistake can slip past it. GitHub's branch rules are enforced on GitHub's side, so they hold no matter what runs locally. Use both: the hook catches mistakes early with a clear message, and the ruleset is the hard stop.

You need two rulesets: a strict one for `main`, which only you merge into, and a lighter one for `milestone/*`, where the Director merges task PRs on its own.

### Ruleset 1: `main`

Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**:

| Setting | Value | Why |
|---|---|---|
| Name | `protect-main` | |
| Enforcement status | Active | |
| Bypass list | **Leave empty** | The Director and its agents act through *your* `gh` login. If repository admins can bypass the rules, so can every agent. An empty list means the rules bind everyone, you included. |
| Target branches | Include default branch | |
| Restrict deletions | On | `main` should never be deleted. |
| Block force pushes | On | A force-push can silently rewrite reviewed history. |
| Require a pull request before merging | On, **Required approvals: 0** | Every change reaches `main` through a PR you can see and undo. Approvals stay at 0 because GitHub won't let an account approve its own PR. With your agents acting as you, 1 required approval would lock everyone out. |
| Require status checks to pass | On, once you have CI | Turn on when the project has CI, so a red build can't reach `main`. |

Or from a terminal:

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } }
  ]
}
EOF
```

### Ruleset 2: `milestone/*`

| Setting | Value | Why |
|---|---|---|
| Name | `protect-milestones` | |
| Enforcement status | Active | |
| Bypass list | Leave empty | Same reason as above. |
| Target branches | Include by pattern: `milestone/*` | |
| Block force pushes | On | Milestone branches collect reviewed work. Rewriting them would drop it without a trace. |
| Require status checks to pass | On, once you have CI | The Director merges task PRs here without you, so CI is the automatic check. |
| Require a pull request | **Off** | The Director's task PRs already go through the `reviewer` agent. Requiring a GitHub PR here adds nothing, and it would block the Director from tidying up the branch. |
| Restrict deletions | **Off** | You'll want to delete a milestone branch after it's merged into `main`, and with an empty bypass list this rule would stop you too. The guard hook already blocks agents from deleting milestone branches. |

Or from a terminal (add a `required_status_checks` rule once you have CI):

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'EOF'
{
  "name": "protect-milestones",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/milestone/*"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" } ]
}
EOF
```

Rulesets are free on public repos. Private repos need a paid GitHub plan for them.

### What this means day to day

- You and the Director can't push to `main` directly. Every change, yours included, goes through a branch and a PR.
- The Director opens and merges task PRs into `milestone/<slug>`. When the milestone is done, it opens `milestone/<slug>` → `main` and hands that PR to you to merge.

## Developing the plugin

Clone the repo and load it from disk instead of the marketplace, so edits take effect without pushing:

```bash
claude --plugin-dir /path/to/agent-team-v1
```

Check it with:

```bash
claude plugin validate .
```

```bash
node tests/run.js
```

`node tests/run.js` runs every `tests/*.test.js`. The opt-in live test against a local Codex CLI is `node tests/live/codex-live.js`; it is not part of `tests/run.js`.

Bump `version` in both `plugin.json` and `.claude-plugin/plugin.json` whenever routing or agent prompts change; the manifest test enforces that they match. The logs record it as `guidance_version`.

`main` in this repo is protected the same way, so contributions go through pull requests.

## Requirements

- Node 18+ on PATH (hooks are dependency-free Node scripts).
- `git` and `gh` (authenticated) for the guard and merges.
- Local Director session. Cloud sessions can't report back to it yet, and the Codex/Antigravity bridges only run locally.

## Limits and known gaps

- **The guard is a guardrail, not a sandbox.** It parses commands simply. GitHub's branch rules are the real enforcement; see [Protect your branches](#protect-your-branches).
- **How the guard blocks:** it prints a `PreToolUse` JSON `deny` decision and exits 0. Claude Code and Codex both honour that. Codex ignores the older exit-code-2 signal, so guards before 0.2.1 didn't block anything in Codex.
- **Hooks-active check:** the SessionStart line `agent-team hooks: active` is how the Director knows the hooks run. Without it, nothing is guarded or logged, whatever the install says.
- **The Codex shim isn't covered by the trust hash.** Codex hashes only the `hooks.json` command strings, not the committed `.codex/agent-team-hook.js`. An agent with workspace write access could edit it and turn off the guard and logging without a re-trust prompt. GitHub rulesets still apply, and the shim is reviewed in PRs like any other file.
- **Codex users re-trust hooks after updating.** The hook set changed in 0.4.0, so each Codex project trusts the hooks again once (`/hooks`), and again after any later change to the hook set.
- **Codex has no per-agent worktrees.** Subagents share the workspace, so on Codex the Director makes the worktree for each writer itself. In the sandbox `.git` can be read-only, so those git commands may need approval.
- **Codex agent files are per project.** Plugins can't ship agents on Codex, so `team-init` generates them. Re-run the generator after a plugin update or a model-map change (`codex-agents.js --check` shows drift).
- **`codex-events.jsonl` is raw.** It keeps selected fields of Codex events for debugging and never records the encrypted spawn message. The Coach reads only the shared log files.
- **Subagent completion records:** Claude Code may run a subagent in the background even when the call doesn't ask for it; its completion is linked to the launch by `agent_id`. Codex completion capture uses the exact child `turn_id` window. If its transcript has not yet recorded `task_complete`, a durable pending snapshot is drained on a later hook dispatch. Requested model/effort values are kept distinct from resolved settings observed in the completion.
- **Missing-block nudge:** when a role agent (`agent-team:*`) stops without its `result-json`/`review-json` block, the SubagentStop hook returns `additionalContext` asking it to end its reply with the block. Claude Code delivers that text to the subagent, which continues so it can act on it; it does not reach the Director. It needs a Claude Code version whose SubagentStop accepts `additionalContext` (seen in 2.1.314), and older versions may ignore it. It is sent at most once per turn (not when `stop_hook_active` is set). A second stop in the same turn writes its own completion line, so for several lines with the same `agent_id` and `turn`, use the last.
- **Hook input formats aren't a published contract.** The logger relies on fields seen in recent Claude Code releases (`agentId`, `isAsync`, `resolvedModel`, `agent_transcript_path`, SubagentStop's `last_assistant_message` and `effort`, the transcript JSONL shape, the `SubagentHandback` tool's `message`, `SendMessage`'s `to`/`message`). It never fails a tool call if they change, but log fields may come out empty. Errors go to `.agent-team/logs/hook-errors.jsonl`.
- **Two token numbers:** `tokens` on a delegation line is Claude Code's own total for the subagent, and it doesn't include cached input. `tokens_with_cache` on a completion line is summed from the transcript, cache included. Compare like with like.
- **Merge outcomes** come from `gh pr view` right after the `gh pr merge` call (7 s timeout). If GitHub can't be asked, the line says `outcome: "unknown"` rather than guessing.
- **Retries by `SendMessage`** are logged as `kind: "resume"` delegations only when the message carries a TASK line.
- **Sessions:** token usage of separate sessions isn't captured automatically yet.
- **Effort of the Director itself** isn't visible to hooks. Decision records say `unknown` unless the Director knows it.
- **Codex gaps:** admins can disable hooks, which turns off the guard and logging. The worktree and agent-file limits above also apply. See [`docs/codex-mapping.md`](docs/codex-mapping.md) for detail.
- **Windows, macOS, Linux:** developed and tested on Windows 11 (Git Bash and PowerShell). The scripts are plain Node, so they should work on other systems, but they haven't been tested there yet.

## License

MIT. See [LICENSE](LICENSE).
