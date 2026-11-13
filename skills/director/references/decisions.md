# Decision records

Write one for every real decision: choosing between approaches, changing scope, accepting a known risk, overriding the routing table, stopping an escalation, or deviating from the user's tasking. Routine routing that follows the table needs none; the delegation log covers it.

**File:** `docs/decisions/NNNN-short-title.md` (next free number, 4 digits).

```markdown
---
id: 0007
title: Use server-side sessions instead of JWTs
date: 2026-10-30
status: accepted            # proposed | accepted | superseded by NNNN
milestone: auth
task: AUTH-3                # or "none"
decided_by: director        # director | architect | user
model: opus                 # model of the agent that decided
effort: high                # its effort level, or "unknown"
---

## Context
What forced a decision. One paragraph.

## Options
1. **Server-side sessions** — ...
2. **JWTs** — ...

## Decision
Which one, and the main reason.

## Consequences
What this makes easier/harder; what to watch for.
```

Then log it, so it also lands in `.agent-team/logs/decisions.jsonl` for the Coach:

```
node "<plugin root>/scripts/log-event.js" decision - <<'EOF'
{"id":"0007","task":"AUTH-3","decided_by":"director","model":"opus","effort":"high","title":"..."}
EOF
```

Use the model id from your own system context for `model`. If you don't know your effort level, write `unknown`; don't guess. PowerShell form: `codex.md`, "Logging from PowerShell".
