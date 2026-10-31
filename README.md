# agent-team

A Claude Code plugin for the **Director pattern**: one session acts as Director, breaks broad tasking into tasks, and delegates each to a role agent or a separate session with an explicitly chosen model and effort level. Every delegation, review verdict, merge and decision is logged, so a Coach agent can later tune the routing.

## What's in it

| Path | What |
|---|---|
| `skills/director/` | The Director's instructions, routing table, task-card format, decision-record format, merge rules |
| `agents/` | `scout` (haiku/low), `implementer` (sonnet/medium), `architect` (opus/high), `reviewer` (sonnet/high), `coach` (opus/high) |
| `commands/` | `/agent-team:team-init`, `/agent-team:milestone`, `/agent-team:status`, `/agent-team:coach` |
| `hooks/hooks.json` | Wires up the logger and the guard |
| `scripts/log-delegation.js` | Logs delegations, results, reviews and merges to `.agent-team/logs/*.jsonl` in the project |
| `scripts/guard.js` | Blocks merges into `main`/`master`, force-pushes, pushes to protected branches, branch-protection and repo changes, releases, and `git add -A`/`.` while unignored agent worktrees exist |
| `scripts/log-event.js` | Manual logging (decisions, escalations, notes) |
| `templates/project/` | Files `/agent-team:team-init` copies into a project |

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

- **Routing:** `skills/director/references/routing.md`: task type × difficulty → agent, model, effort, vehicle, plus an escalation ladder (feedback → more effort → bigger model → architect).
- **Records:** each log line carries `guidance_version` (this plugin's version), so the Coach can compare results before and after a routing change.
- **Merges:** GitHub won't let an account approve its own PR, so the reviewer's verdict is recorded in the logs and as a PR comment, and the Director merges task PRs into the milestone branch. The guard hook stops it from merging into `main`.

## Install

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

**Before you install:** the plugin's hooks run Node scripts on your machine on every subagent, session, shell and bridge call. They're short and dependency-free. Read [`scripts/`](scripts/) first, as you would for any plugin with hooks.

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

Bump `version` in `.claude-plugin/plugin.json` whenever routing or agent prompts change. The logs record it as `guidance_version`.

`main` in this repo is protected the same way, so contributions go through pull requests.

## Requirements

- Node 18+ on PATH (hooks are dependency-free Node scripts).
- `git` and `gh` (authenticated) for the guard and merges.
- Local Director session. Cloud sessions can't report back to it yet, and the Codex/Antigravity bridges only exist on this machine.

## Limits and known gaps

- **The guard is a guardrail, not a sandbox.** It parses commands simply. GitHub's branch rules are the real enforcement; see [Protect your branches](#protect-your-branches).
- **Background subagents:** Claude Code may run a subagent in the background even when the call doesn't ask for it. The delegation line then records only the launch (`background: true`, `agent_id`, `resolved_model`). The result, tokens and duration land in `completions.jsonl` with the same `agent_id`, read from the subagent transcript when it stops. Reviewer verdicts are logged once, whichever path sees them first.
- **Hook input formats aren't a published contract.** The logger relies on fields seen in Claude Code 2.1.314 (`agentId`, `isAsync`, `resolvedModel`, `agent_transcript_path`, SubagentStop's `last_assistant_message` and `effort`, the transcript JSONL shape, the `SubagentHandback` tool's `message`, `SendMessage`'s `to`/`message`). It never fails a tool call if they change, but log fields may come out empty. Errors go to `.agent-team/logs/hook-errors.jsonl`.
- **Two token numbers:** `tokens` on a delegation line is Claude Code's own total for the subagent, and it doesn't include cached input. `tokens_with_cache` on a completion line is summed from the transcript, cache included. Compare like with like.
- **Merge outcomes** come from `gh pr view` right after the `gh pr merge` call (7 s timeout). If GitHub can't be asked, the line says `outcome: "unknown"` rather than guessing.
- **Retries by `SendMessage`** are logged as `kind: "resume"` delegations only when the message carries a TASK line.
- **Sessions:** token usage of separate sessions isn't captured automatically yet.
- **Effort of the Director itself** isn't visible to hooks. Decision records say `unknown` unless the Director knows it.
- **Windows, macOS, Linux:** developed and tested on Windows 11 (Git Bash and PowerShell). The scripts are plain Node, so they should work on other systems, but they haven't been tested there yet.

## License

MIT. See [LICENSE](LICENSE).
