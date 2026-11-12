---
id: 0014
title: ci-wait fails closed when required checks can't be read
date: 2026-11-11
status: accepted
milestone: ci-wait
task: CW-1
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
The CW-1 review found that when the base's required checks can't be read
(classic branch protection needs admin rights, so a non-admin or fine-grained
token gets 403), `ci-wait.js` fell back to all checks on the head and could
report green while a required check had not appeared yet.

## Options
1. **Fall back to all checks** — keeps merges moving for non-admin tokens, but
   can pass a PR that a required check would have stopped.
2. **Fail closed** — report `unknown` (exit 2) with a note naming what couldn't
   be read.

## Decision
Option 2. The helper is the merge gate, and green must mean green. A non-admin
reader may use another read path (e.g. GraphQL `refUpdateRule`) only if it is
verified against the real API, and a required check that hasn't appeared on
the head still keeps the result pending. Also: `--once --allow-none` passes
`none` only with a matching `--sha`, since only then has the reviewer already
waited out the grace period on that head.

## Consequences
A Director whose token can't read branch protection gets `unknown` and must
ask the user (or have the user grant read access), instead of merging.
