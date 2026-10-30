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
- **Records:** each log line carries `guidance_version` (this plugin's version), so the Coach can compare results before and after a routing change. **Bump `version` in `.claude-plugin/plugin.json` whenever routing or agent prompts change.**
- **Merges:** GitHub won't let an account approve its own PR, so the reviewer's verdict is recorded in the logs and as a PR comment, and the Director merges task PRs into the milestone branch. The guard hook stops it from merging into `main`.

## Install in a project

The repo is its own one-plugin marketplace. In the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agent-team": { "source": { "source": "github", "repo": "JoeEngineer/agent-team-v1" } }
  },
  "enabledPlugins": { "agent-team@agent-team": true }
}
```

The repo is private, so Claude Code needs GitHub access (your `gh`/git credentials) to fetch it. For local development of the plugin itself, point the marketplace at this folder instead: `"source": { "source": "directory", "path": "C:/Users/JoeBr/Documents/agent-team-v1" }`.

Then in the project: `/agent-team:team-init`, then `/agent-team:milestone <slug> <tasking>`.

## Requirements

- Node 18+ on PATH (hooks are dependency-free Node scripts).
- `git` and `gh` (authenticated) for the guard and merges.
- Local Director session. Cloud sessions can't report back to it yet, and the Codex/Antigravity bridges only exist on this machine.

## Limits and known gaps

- **The guard is a guardrail, not a sandbox.** It parses commands simply. Server-side branch protection on `main` is the real enforcement; set it up.
- **Background subagents:** results arrive after the tool call returns. The `SubagentStop` hook tries to capture them into `completions.jsonl` from the subagent transcript. That depends on fields the hook input may not provide, so verify it on first use.
- **Token/duration numbers** are captured when the tool response includes them. Session token usage isn't captured automatically yet.
- **Effort of the Director itself** isn't visible to hooks. Decision records say `unknown` unless the Director knows it.

## Tests

```bash
node tests/run.js
```
