---
id: 0023
title: One same-agent send-back at large/high before xlarge
date: 2026-11-23
status: accepted            # the user chose it at intake on 2026-11-23; implemented in 1.2.0
milestone: coach-followups
task: none
decided_by: user
model: claude-opus-5-5
effort: unknown
---

# 0023: One same-agent send-back at large/high before xlarge

Amends decision 0022, section 4 ("hard-fix escalation, after large/high fails").

## Context

In milestone `security-review`, SR-4 started at large/high and failed its first
review with one major. The 1.0.2 ladder had no automatic step left, so the
Director paused for 17 m 44 s to ask the user. The user picked xlarge, which cost
≥ $3.08 and 19.8 minutes for a fix of 37 added and 10 removed lines. The
Director had recommended sending it back to the same architect. Under 1.1.0, with
`hard-fix` granted, the same first failure goes to xlarge/high without asking.
That spends xlarge on any first failure at large/high, one-clause fixes included.
The Coach report (`docs/coach/2026-11-23-security-review.md`, R3) also found two
open wording gaps. Ladder step 3 still says "ask the user" when hard-fix is
granted. Nothing says whose attempt the granted xlarge run is.

## Options

1. **R3: one send-back at large/high first.** On the first failure at large/high,
   send it back to the same agent once. On a second failure, go to step 4: the
   grant runs xlarge/high, or else the user is asked. The xlarge attempt is a new
   spawn of the role that made the failed attempt.
2. **Wording fixes only.** Keep "after large/high fails" (one failure). Fix step 3
   to say "go to step 4", and name whose attempt it is.

## Decision

Option 1, chosen by the user at intake. A warm send-back is cheaper than a new
xlarge spawn, which has to read the whole guidance set again. Every fix round in
the last milestone passed its re-review (effort raises 8 of 8 pooled). Only one
data point supports this (SR-4), so the Coach keeps counting.

## Consequences

- A task that starts at large/high now needs two failures before xlarge or before
  the user is asked. The cost is one more round in the case where large/high
  really cannot fix it.
- `routing.md`, "Escalation ladder", steps 3 and 4, and the grant table row
  "hard-fix escalation" change wording. Decision 0022's text stays as written,
  and this record amends it.
- The Coach should report, for each task that fails at large/high, whether the
  send-back fixed it.
