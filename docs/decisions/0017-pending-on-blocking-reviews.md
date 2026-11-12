---
id: 0017
title: Keep "not waited" pending on blocking reviews; checkpoints only when something is queued
date: 2026-11-12
status: accepted
milestone: ci-wait
task: CW-10
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
The Codex re-run after CW-9 failed "reviewer `ci: pending` only on timeout" on one review. CW-7 found it was a `changes_requested` review that did one `--once` check instead of the full wait, as agents/reviewer.md allows (CW-4). It wrote "CI was not waited: changes requested" instead of the exact marker. The same run spent 6 Director turns on `reconcile-logs.js --merges` checkpoints, 49% of its CI tokens, some with nothing queued. CW-7 also changed the harness so no-PR checkpoint turns are reported but not charged to a task PR, which amends 0016's "the harness stays as written" for that half.

## Options
1. **The reviewer always does the full wait**, even when requesting changes. This meets the spec's wording literally, but delays every send-back by up to 15 minutes of reviewer time, and the Director's action (send back) doesn't depend on `ci`.
2. **Keep the single check on blocking verdicts**, require the exact marker at the start of `summary`, and have the harness accept `pending` only from a timed-out wait (with the time waited) or a blocking verdict with the marker.

## Decision
Option 2. The spec's concern is a `pending` that leaves the Director to check CI itself. A blocking verdict never leads to a CI check by the Director, so that concern doesn't arise. The user may overrule this (reported at close).

Checkpoints: the Director runs `reconcile-logs.js --merges` only when STATUS.md has a `queued` row, at the next merge, at the end of a wave and before the milestone PR. With nothing queued, it skips them.

## Consequences
- The harness records each review's verdict. An approve with `pending` and no stated wait still FAILs.
- Fewer Director checkpoint turns on Codex. The milestone PR is still gated on its own green checks.
