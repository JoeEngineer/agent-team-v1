# Routing table

**Guidance version:** see `version` in the plugin's `.claude-plugin/plugin.json`. Bump it whenever this file changes so the logs can tell before from after.

Change this file only through a PR against the plugin repo (that's how the Coach proposes changes).

## Starting tier

Plugin agents are addressed as `agent-team:<name>` (e.g. `subagent_type: "agent-team:implementer"`). The agent's file sets its default tier and effort (and, on Claude, the matching `model:` header); only pass `model`/`effort` when this table says something different from the default. See "Tiers and models" below.

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
| test | any | implementer | medium | low | subagent (worktree) |
| docs | any | implementer | small | low | subagent (worktree) |
| review | any | reviewer | medium | high | subagent |
| review (milestone final) | any | reviewer | large | high | subagent |
| coach | any | coach | large | high | subagent |

**Difficulty guide:** *easy* — clear spec, one area, existing pattern to copy. *medium* — clear spec, several files or a new pattern. *hard* — unclear cause, cross-cutting, or real design choices inside the task.

**Review rows:** use the row as written. A reviewer's tier/effort does not follow the implementer's tier, and does not follow the reviewed task's difficulty unless a row splits on it. `any` means any.

**Vehicle fallback:** `session` needs a session-launch tool (e.g. `mcp__ccd_session__start_session`). If it isn't available, run the task as a background subagent in a worktree at the **same** tier/effort, and say "session unavailable; subagent fallback" in `WHY`. Don't change the tier to compensate.

## Escalation ladder

On a reviewer verdict of `changes_requested`:

1. **First failure:** send back to the same tier with the reviewer's findings. Many failures are fixable with feedback alone.
2. **Second failure, or first failure whose `review-json` top-level `severity` is `major`/`critical`:** raise effort one step (low → medium → high). Use the top-level field, not individual finding labels. If the block is missing or contradicts itself, ask the reviewer for a corrected `review-json` before choosing the step.
3. **Already at high effort:** raise the tier one step (small → medium → large), get the next tier with `node "${CLAUDE_PLUGIN_ROOT}/scripts/models.js" up <tier> --tool <t>`, which skips any tier that is not auto-eligible. If it exits 1 there is none; ask the user.
4. **Large/high still failing, or verdict `reject`:** stop. Send to `architect` to re-examine the spec, and tell the user if the milestone is at risk. The Director may *offer* xlarge, but only if it is enabled in the model map for that tool, with a note on cost (e.g. billed as usage credits) or availability. Use it only after the user's yes for that task.

Each escalation is a new delegation with the same task `id` and `attempt` incremented, and a `why` naming the step taken.

## Tiers and models

The table and ladder name tiers (small, medium, large; xlarge is opt-in). Each tier maps to a model per tool.

- Read the effective map with `node "${CLAUDE_PLUGIN_ROOT}/scripts/models.js" show`. The shipped default is `config/models.json`; `AGENT_TEAM_MODELS` or `~/.agent-team/models.json` replaces it as a whole file.
- To get the model for a tier, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/models.js" resolve <tier> --tool claude`.
- xlarge, and any entry with `enabled: false` or `billing: "credits"`, is never chosen by the routing table or the ladder.
- A tool with no entries in the map is never routed to.
- If a mapped model is missing at run time, fall back one tier down (`node "${CLAUDE_PLUGIN_ROOT}/scripts/models.js" down <tier> --tool <t>`), log it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/log-event.js" tier_fallback '{"task":…,"from":…,"to":…,"tool":…,"reason":…}'`, and tell the user. Never fall back up.
- Agent files' `model:` headers match the default map. When `show` reports `differs_from_default` for a tier, pass `model` explicitly on the delegation.
- When passing `model` to Claude's Agent tool, use the map's model for the tier.

## Local-only routes (optional)

Only when the bridge tools are present in the session and runway allows.

| Task type | Difficulty | Route | Notes |
|---|---|---|---|
| (none yet) | | `codex-bridge` / `antigravity-bridge` | Add rows here once you want to trial them. Log them with a task card like any other delegation. |
