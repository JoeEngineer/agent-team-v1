---
id: 0018
title: Gate the auto-merge queue call on a live required-checks read; final-review fix scope
date: 2026-11-12
status: accepted
milestone: ci-wait
task: CW-10
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
The final review (Fable / high, user-chosen) found one critical (C1: `gh pr merge --admin=true` passes the guard) and three majors. M1: the `--auto` queue call trusts STATUS.md's note that the base requires named checks. If the base in fact requires none, `gh pr merge --auto` merges at once with CI running. M2: reconcile reports a queued PR merged at another head as plain "merged". M3: `--disable-auto` is logged as cancelled without asking the forge, so a failed cancel stops reconcile from tracking a PR that may still auto-merge an unreviewed head. The user asked for critical findings to be fixed and the rest reported.

## Options
1. Fix C1 only and report the majors.
2. Treat M1 and M3 as critical, since both can merge without green CI or merge an unreviewed head, and fix them with C1 and M2.

## Decision
Option 2. M1 is fixed with a live gate on the queue call: `ci-wait.js <n> --queue-check --sha <head_sha>`, chained with `&&` before `gh pr merge --auto`. It exits 0 only when the head matches and nothing is red. On GitHub, the base must also require a non-empty list of named checks, all of which the head runs. On GitLab, "Pipelines must succeed" must be on. Unreadable means exit 2, which fails closed. M3 logs the cancel only after the forge confirms auto-merge is off. M2 flags a head mismatch at merge. The work is split: CW-10 (scripts and tests) and CW-11 (docs, harness 0017 items, carried items).

## Consequences
- Queueing can no longer rely on a stale STATUS.md note. A wrong note costs a failed queue call, not an ungated merge.
- Minor findings not fixed in CW-10/CW-11 are reported to the user at close.
