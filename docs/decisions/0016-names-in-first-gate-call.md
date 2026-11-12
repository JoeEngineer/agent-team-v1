---
id: 0016
title: List check names in the first merge-gate call, keep the per-PR target
date: 2026-11-12
status: accepted
milestone: ci-wait
task: CW-9
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
Both 0.6.0 live runs (CW-7, PR #97) missed "at most one CI-related Director turn per task PR" on the first task PR only (Claude #36, Codex #39): 2 turns each. CW-7 traced the extra turn to the one-time `ci-wait.js --names <n>` call that SKILL.md and merging.md ask for after the first CI run. It was not a second CI wait. The "not tied to a PR" turns are `reconcile-logs.js --merges` checkpoints, which don't count against any task PR.

## Options
1. **Exclude the first-run step from the target** in the harness. The run would pass, but the Director would still spend the turn, which goes against the spec ("a missed target becomes a fix task, not a softened target").
2. **Put `--names` into the first merge-gate call.** It needs no extra turn, and the gate is unchanged: `--names` only reads names, and the merge still runs only when `ci-wait.js <n> --once --sha <head_sha>` passes.

## Decision
Option 2. The first PR's merge call starts with `ci-wait.js --names <n>` (its output is ignored by the gate; sh `;`, PowerShell `;`), followed by the usual gate-merge-comment chain. The Director reads the names from that same call's output and then asks the user. The target stays as written. (Amended by 0017: the harness no longer charges no-PR checkpoint turns to task PRs; it reports them separately.) A re-run of the live harness on both tools checks the fix.

## Consequences
- One call per PR also holds for the first PR. The user question about names and auto-merge is a user turn, not a CI turn.
- Parser over-count (Codex turn 42: PR numbers taken from the whole call) and notification attachment without a `result` event are harness follow-ups, not part of this change.
