# Routing table

**Guidance version:** `version` in the plugin's `.claude-plugin/plugin.json`. Bump it whenever this file changes, so the logs can tell before from after. Change this file only through a PR against the plugin repo; that is how the Coach proposes changes.

## Starting tier

Plugin agents are addressed as `agent-team:<name>` (`subagent_type: "agent-team:implementer"`). **Pass `model` and `effort` from this table on every spawn**, even when they match the agent file's defaults: the card's `tier=` and `WHY` are not applied by themselves. Get the model with `node "<plugin root>/scripts/models.js" resolve <tier> --tool <t>`.

| Task type | Difficulty | Agent | Tier | Effort | Vehicle |
|---|---|---|---|---|---|
| research | any | scout | small | low | subagent |
| research | hard | scout | medium | medium | subagent |
| breakdown | any | architect | large | high | subagent |
| design | any | architect | large | high | subagent |
| implement | easy | implementer | small | medium | subagent (worktree) |
| implement | medium | implementer | medium | medium | subagent (worktree) or session if > ~1 hour |
| implement | hard | implementer | medium | high | session |
| fix | easy | implementer | small | medium | subagent (worktree) |
| fix | medium | implementer | medium | medium | subagent (worktree) |
| fix | hard | architect | large | high | session |
| test | any | implementer | medium | medium | subagent (worktree) |
| test | hard | implementer | medium | high | subagent (worktree) or session if > ~1 hour |
| docs | easy | implementer | small | low | subagent (worktree) |
| docs | medium/hard | implementer | small | medium | subagent (worktree) |
| review | any | reviewer | medium | high | subagent |
| review (milestone final) | any | reviewer | large | high | subagent |
| security-review | any | security-reviewer | large | high | subagent |
| coach | any | coach | large | high | subagent |

- **Difficulty.** *easy*: clear spec, one area, an existing pattern to copy. *medium*: clear spec, several files or a new pattern. *hard*: unclear cause, cross-cutting, or real design choices inside the task.
- **Review rows.** Use the row as written. A reviewer's tier and effort don't follow the implementer's tier or the reviewed task's difficulty.
- **Final-review fixes.** A fix PR for a finding from the milestone final review or a close-time security review gets a normal per-PR review. Resume that reviewer only to confirm its own blocking finding is resolved on the incremental diff, not for a fresh milestone check.
- **No session tool.** `session` needs a session-launch tool (such as `mcp__ccd_session__start_session`). Without one, run the task as a background subagent in a worktree at the same tier and effort, and say "session unavailable; subagent fallback" in `WHY`. Don't change the tier to compensate.

## Escalation ladder

On a reviewer verdict of `changes_requested`:

1. **First failure:** send it back to the same tier with the reviewer's findings.
2. **Second failure, or a first failure whose `review-json` top-level `severity` is `major` or `critical`:** raise effort one step (low → medium → high). Use the top-level field, not the labels of single findings. If the block is missing or contradicts itself, ask the reviewer for a corrected `review-json` first.
3. **Already at high effort:** raise the tier one step with `node "<plugin root>/scripts/models.js" up <tier> --tool <t>`, which skips tiers that are not auto-eligible. Exit 1 means there is none: ask the user.
4. **Large/high still failing, or a verdict of `reject`:** stop. Send it to `architect` to re-examine the spec, and tell the user if the milestone is at risk. You may offer xlarge, noting its cost or availability, whenever the map has an xlarge model for that tool that is not disabled; use it only after the user's yes for that task. With `hard-fix` in the milestone's grant, the next attempt runs at xlarge/high without asking.

Each escalation is a new spawn with the same task `id`, `attempt` incremented, `reason=escalation`, and a `WHY` naming the step.

## Tiers and models

The table and ladder name tiers (small, medium, large, xlarge). Each tier maps to a model per tool.

- The effective map: `node "<plugin root>/scripts/models.js" show`. The shipped default is `config/models.json`; `AGENT_TEAM_MODELS` or `~/.agent-team/models.json` replaces it as a whole file.
- xlarge is never chosen by the table or the ladder, and neither is an entry a user map marks `enabled: false` or `billing: "credits"`. A tool with no entries in the map is never routed to.
- If a mapped model is missing at run time, fall one tier down (`models.js down <tier> --tool <t>`), log it (`log-event.js tier_fallback` with `{"task":…,"from":…,"to":…,"tool":…,"reason":…}` on stdin), and tell the user. Never fall back up.

## The xlarge grant

The user grants xlarge to some roles, or none, at each milestone's intake (`<plugin root>/skills/milestone/SKILL.md`). The grant is the `## xlarge grant` block of `STATUS.md`; re-read it there after a compaction. No block (an older project) means no grant.

| Role | Default | With the grant |
|---|---|---|
| security review (milestone close) | large / high | xlarge / high |
| security review (flagged task PR) | large / high | xlarge / high |
| architect (breakdown, design) | large / high | xlarge / medium |
| coach (at milestone close) | large / high | xlarge / medium |
| hard-fix escalation, after large/high fails | ask the user | xlarge / high |

- The grant covers the granted roles in this milestone only. Any other xlarge use still needs the user's yes for that task.
- **Runway.** Check runway before each granted xlarge spawn. If it is short, ask the user whether to wait or to run the default row; never fall back silently. When they pick the default row, log `tier_fallback` with `"reason":"runway"`. If runway can't be checked, say so on the `WHY` line and go ahead.

## Local-only routes (optional)

The Codex and Antigravity bridges (`mcp__codex-bridge__*`, `mcp__antigravity-bridge__*`) exist only on the user's machine. Use one only when its tools are present in this session and a row below assigns the task to it. Check runway first (`check_runway`). If a bridge is missing, fall back to the Claude route and log why (not for the second security review, below). Log a bridge route with a task card like any delegation, naming the tool and model. Add rows to trial a route.

| Task type | Difficulty | Route | Notes |
|---|---|---|---|
| security-review (second, at close) | any | `codex-bridge` | If asked for at intake; see below. |

**The second security review.** Tier from the intake answer, effort high: `models.js resolve <tier> --tool codex`. Run it in parallel with the first security review, with the same card (the milestone PR, the acceptance criteria, the `security-reviewer` prompt) and none of the first review's findings or verdict. Add: "Another model has already reviewed this milestone. Your job is to find what that review missed." If `check_runway` says runway is short, or the bridge is missing at close, vanishes or loses the reply, ask the user whether to wait, drop the tier or skip; never skip silently. If the reply has no `review-json` the hook could log, log it with `log-event.js review`.
