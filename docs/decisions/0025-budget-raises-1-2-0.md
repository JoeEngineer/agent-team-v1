---
id: 0025
title: Guidance budget raises for 1.2.0
date: 2026-11-23
status: accepted            # the user approved all four raises on 2026-11-23
milestone: coach-followups
task: FU-0
decided_by: user
model: claude-opus-5-5
effort: unknown
---

# 0025: Guidance budget raises for 1.2.0

## Context

Milestone coach-followups adds about ten rules from the Coach report of
2026-11-23 (R1, R3, R4, T1, `flags=`, M1, M2, A1, A2, A4, the scan-state table,
and the Coach's new fields). Under decision 0020 each guidance file has a byte
budget, enforced by `tests/guidance.test.js`. The core Director set had 26 bytes
free, `agents/security-reviewer.md` 72, and `agents/coach.md` 4. The breakdown
(FU-0) already moved about 600 bytes of rules into scripts: the verdict-conflict
nudge, the conditions of the STATUS-only head rule (`status.js --check --since`),
the grant check (`status.js grant`), and the `merged` step (`merge-task.js`
`next`).

## Options

1. **Raise four budgets.** Core set 32,500 → 33,800; `routing.md` 7,500 → 7,900;
   `agents/security-reviewer.md` 7,200 → 8,100; `agents/coach.md` 12,500 → 13,000.
2. **No raises.** Move the "Queued PRs" checkpoint bullets of `merging.md` (about
   1,300 bytes) into `reconcile-logs.js` output. That is a behaviour refactor with
   about ten anchors to re-home, and the architect advised against it in this
   milestone.

## Decision

Option 1, approved by the user. Each task sets its file's budget a little above
the final size, within these ceilings, so the headroom stays small.

## Consequences

- The core set grows about 3.4%. Its token cost is paid on every Director turn.
- The next guidance addition again needs a cut or a raise. The script-first rule
  from 0020 still applies.
