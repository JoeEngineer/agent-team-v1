---
id: 0031
title: The remaining Codex close-review majors are accepted as residuals
date: 2026-11-23
status: accepted            # the user chose this on 2026-11-23, at the milestone close
milestone: coach-followups
task: none
decided_by: user
model: claude-opus-5-5
effort: unknown
---

# 0031: The remaining Codex close-review majors are accepted as residuals

## Context

The Codex second security review of the milestone PR (#160) found nine majors at
`2bde391`. Fix tasks FU-16 to FU-22 merged, and Codex re-checked them at
`4eff1be`. It confirmed majors 5, 6 and 9 (the new part) resolved. Six stayed
open:

1. CommonMark HTML block type 7 is not raw text in `lib.reviewJson`. FU-23
   (PR #179) fixes this.
2. `codex-log.js`: a 1.1.0 v1 pending snapshot whose completion line already
   exists is promoted from that completion, which the old lenient parser wrote,
   without a strict re-parse.
3. This milestone's own grant uses the pre-1.2.0 word `security reviews`, which
   now means both security rows, so `status.js grant` returns
   `security-review-task`. The user's cap (flagged task-PR reviews at large/high)
   was a note, applied by hand by the Director throughout the milestone.
   Decision 0029 records this.
4. `status.js grant` follows an untracked symlink at the intake log path, which
   `log-event.js milestone` refuses. A foreign file behind the link can then
   match an edited `STATUS.md` block.
5. `status.js` (the STATUS writer) applies `chmodSync` by path after closing
   its exclusive temp file. A concurrent writer in the folder can swap in a link
   first. The final rename does not check that `STATUS.md` still matches the
   snapshot it edited.
6. `lib.safeAppend` checks parent folders by path, then opens by path. A
   concurrent swap of a parent folder can redirect an archive-time append.

## Options

1. Fix 2 and 4 and the `fchmod` half of 5 in one more task. Accept the
   folder-swap races and the legacy grant wording.
2. Fix all six. The races need the file helpers rewritten without `openat`,
   likely more architect and security rounds.
3. Accept every remaining major and close.

## Decision

Option 3, chosen by the user. Major 1 is still fixed by FU-23, which merges with
its own security review. Majors 2 to 6 are accepted residuals for 1.2.0.

## Consequences

- The 1.2.0 release notes list these residuals beside the scanner ones (0028).
- Items 4 and 5 (`fchmod`), and item 2, are small, well-located fixes for a later
  release. Items 5 (rename) and 6 need a design for race-free file access.
- Every residual except 3 needs an agent, or another process, that can already
  write the project's log folder or shared checkout, at the moment the Director
  runs a script. Item 3 affects only this milestone's record.
