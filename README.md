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
| `scripts/guard.js` | Blocks merges into `main`/`master`, force-pushes, pushes to protected branches, branch-protection and repo changes, releases |
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

## Requirements

- Node 18+ on PATH (hooks are dependency-free Node scripts).
- `git` and `gh` (authenticated) for the guard and merges.
- Local Director session. Cloud sessions can't report back to it yet, and the Codex/Antigravity bridges only exist on this machine.

## Limits and known gaps

- **The guard is a guardrail, not a sandbox.** It parses commands simply. Server-side branch protection on `main` is the real enforcement; set it up.
- **Background subagents:** Claude Code may run a subagent in the background even when the call doesn't ask for it. The delegation line then records only the launch (`background: true`, `agent_id`, `resolved_model`). The result, tokens and duration land in `completions.jsonl` with the same `agent_id`, read from the subagent transcript when it stops. Reviewer verdicts are logged once, whichever path sees them first.
- **Hook input formats aren't a published contract.** The logger relies on fields seen in Claude Code 2.1.314 (`agentId`, `isAsync`, `resolvedModel`, `agent_transcript_path`, the transcript JSONL shape). It never fails a tool call if they change, but log fields may come out empty. Errors go to `.agent-team/logs/hook-errors.jsonl`.
- **Two token numbers:** `tokens` on a delegation line is Claude Code's own total for the subagent, and it doesn't include cached input. `tokens_with_cache` on a completion line is summed from the transcript, cache included. Compare like with like.
- **Sessions:** token usage of separate sessions isn't captured automatically yet.
- **Effort of the Director itself** isn't visible to hooks. Decision records say `unknown` unless the Director knows it.
- **Windows, macOS, Linux:** developed and tested on Windows 11 (Git Bash and PowerShell). The scripts are plain Node, so they should work on other systems, but they haven't been tested there yet.
