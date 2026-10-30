---
description: Run the Coach over the team logs and get routing recommendations.
argument-hint: [optional focus, e.g. "implementer on hard tasks"]
---

Delegate to the `agent-team:coach` agent with this task card:

```
TASK id=COACH-<YYYYMMDD> type=coach difficulty=medium milestone=<current or none> attempt=1
WHY periodic routing review
```

Brief: analyze `.agent-team/logs/` and `docs/decisions/` against the routing table at `${CLAUDE_PLUGIN_ROOT}/skills/director/references/routing.md`. Focus: $ARGUMENTS

When it returns, summarize its recommendations for me in a few lines with the supporting numbers, and link its report. Don't change the routing table — ask me whether to open a PR against the plugin repo with the proposed changes.
