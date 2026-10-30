# Routing table

**Guidance version:** see `version` in the plugin's `.claude-plugin/plugin.json`. Bump it whenever this file changes so the logs can tell before from after.

Change this file only through a PR against the plugin repo (that's how the Coach proposes changes).

## Starting tier

Plugin agents are addressed as `agent-team:<name>` (e.g. `subagent_type: "agent-team:implementer"`). The agent's file sets its default model/effort; only pass `model`/`effort` when this table says something different from the default.

| Task type | Difficulty | Agent | Model | Effort | Vehicle |
|---|---|---|---|---|---|
| research | any | scout | haiku | low | subagent |
| research | hard | scout | sonnet | medium | subagent |
| breakdown | any | architect | opus | high | subagent |
| design | any | architect | opus | high | subagent |
| implement | easy | implementer | haiku | medium | subagent (worktree) |
| implement | medium | implementer | sonnet | medium | subagent (worktree) or session if > ~1 hour |
| implement | hard | implementer | sonnet | high | session |
| fix | easy | implementer | haiku | medium | subagent (worktree) |
| fix | medium | implementer | sonnet | medium | subagent (worktree) |
| fix | hard | architect | opus | high | session |
| test | any | implementer | sonnet | low | subagent (worktree) |
| docs | any | implementer | haiku | low | subagent (worktree) |
| review | any | reviewer | sonnet | high | subagent |
| review (milestone final) | any | reviewer | opus | high | subagent |
| coach | any | coach | opus | high | subagent |

**Difficulty guide:** *easy* — clear spec, one area, existing pattern to copy. *medium* — clear spec, several files or a new pattern. *hard* — unclear cause, cross-cutting, or real design choices inside the task.

## Escalation ladder

On a reviewer verdict of `changes_requested`:

1. **First failure:** send back to the same tier with the reviewer's findings. Many failures are fixable with feedback alone.
2. **Second failure, or first failure with severity `major`/`critical`:** raise effort one step (low → medium → high).
3. **Already at high effort:** raise the model one step (haiku → sonnet → opus).
4. **Opus/high still failing, or verdict `reject`:** stop. Send to `architect` to re-examine the spec, and tell the user if the milestone is at risk.

Each escalation is a new delegation with the same task `id` and `attempt` incremented, and a `why` naming the step taken.

## Local-only routes (optional)

Only when the bridge tools are present in the session and runway allows.

| Task type | Difficulty | Route | Notes |
|---|---|---|---|
| (none yet) | | `codex-bridge` / `antigravity-bridge` | Add rows here once you want to trial them. Log them with a task card like any other delegation. |
