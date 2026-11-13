---
id: 0012
title: The Director merges without waiting on CI
date: 2026-11-11
status: accepted
milestone: ci-wait
task: CW-0
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
Director turns re-read 150–270k tokens. In the minio-s3-sync hardening
milestone, 18 Director calls were about CI (3.4M tokens) and the Director
blocked on foreground `gh pr checks --watch`. Green CI must stay a hard gate
for every merge into a milestone branch, and nothing may merge at a SHA the
reviewer did not approve. Proposed by the architect (CW-0); accepted by the
Director.

## Options
1. Keep the Director checking CI itself, but in the background.
2. The reviewer waits for CI; the Director gates the merge with one quick
   check in the merge call, queues auto-merge when CI is still pending, and
   reconciles queued merges at checkpoints.

## Decision
Option 2:
- **One call per merge.** The CI gate (`ci-wait.js <n> --once --sha <sha>`),
  the merge (`--match-head-commit <sha>` / glab `--sha <sha>`) and the PR
  comment may share one call, joined so each runs only if the one before
  succeeded (`&&` in sh; `if ($LASTEXITCODE -eq 0)` in PowerShell 5.1). No
  other merges, pulls or file edits in that call. The merge logger already
  finds one merge segment in a chained command and asks the forge for the
  outcome, so the log stays correct.
- **Auto-merge only with named required checks.** `--auto` waits only for
  required checks, so it is used only when the base's ruleset names them and
  the repo allows auto-merge. Otherwise: a background `ci-wait.js` on Claude,
  or a follow-up to the same reviewer to wait again on Codex (Codex has no
  background shell that wakes the Director). That fallback costs two Director
  turns for the PR, and STATUS.md says why.
- **Pushed since review** is caught by the reviewer's `head_sha` in
  review-json plus `--match-head-commit`. A fold-in still gets its incremental
  review; only a reviewed head is ever merged or queued. Auto-merge is turned
  off before any push to a queued PR.
- **Reconcile appends** resolution lines (`merged` with `merged_at`,
  `auto-merge-cancelled`, `closed`) to merges.jsonl; it never rewrites the
  queued line.
- **Milestone close:** the Director reports "complete" only after the
  milestone PR's checks have finished green.

## Consequences
- Accepted risk B2: whether GitHub enforces the expected head at the eventual
  auto-merge is untested. Covered by "disable auto-merge before any push" and
  reconcile's head-moved alert; the live harness can probe it.
- The guard's `2>&1` parsing bug (it read `2` as the PR number) is fixed in
  this milestone, since chained merge calls make redirections more likely.
- GitLab is covered by unit tests only in this milestone.
