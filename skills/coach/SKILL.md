---
name: coach
description: Run the Coach over the team logs and get routing recommendations. Use when the user asks for a routing review, wants to know how the agent team is performing, or invokes the coach.
argument-hint: [optional focus, e.g. "implementer on hard tasks"]
---

Delegate to the `agent-team:coach` agent with this task card:

```
TASK id=COACH-<YYYYMMDD> type=coach difficulty=medium milestone=<current or none> attempt=1
WHY periodic routing review
```

Brief: analyze `.agent-team/logs/` and `docs/decisions/` against the routing table at `${CLAUDE_PLUGIN_ROOT}/skills/director/references/routing.md` (the plugin root is two folders up from this skill's folder). Focus: take it from the user's message (on Claude, the slash command appends an `ARGUMENTS:` line; on Codex, whatever the user wrote when invoking this skill). If none was given, there is no particular focus; review everything.

When it returns, summarize its recommendations for me in a few lines with the supporting numbers, and link its report. Don't change the routing table — ask me whether to open a PR against the plugin repo with the proposed changes.
