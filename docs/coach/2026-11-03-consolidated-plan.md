# Consolidated plan: Coach reports of 2026-11-03

Sources:
- Claude run: `minio-s3-sync/.agent-team/coach/2026-11-03-report.md` (milestone access-errors, 26 turns, guidance 0.4.3)
- Codex run: `minio-s3-sync-codex/.agent-team/coach/2026-11-03-report.md` (three milestones, 101 turns, guidance "0.4.4")
- Claude Director's after-action on closing task issues

## Bottom line

- **No `routing.md` change.** Both Coaches say so independently. Every category is under 5 tasks, except Codex Terra/medium (9), and that one has no higher-tier tasks to compare against.
- **Everything else is process.** Ship it as one plugin PR (0.4.4), in three groups: agent guidance (A), hooks and logging (B), Director merge flow (C).
- **Keep the milestone final review** (large/high) and the normal per-PR review for fix PRs. The final review found something in 3/3 Claude milestones. In AE-6, the per-PR review caught a wrong final-review finding.

## A. Agent guidance

| # | Change | File | From | Evidence |
|---|---|---|---|---|
| A1 | The architect names a table row (type/difficulty), not a model or effort. When a task needs more than its row gives, it adds `above-table: <reason>`. | `agents/architect.md` line 15 | Claude 2 | 4/5 suggestions were above the table, and 3/4 of those passed at the table tier. Following them would have cost about +$5 (+22%). |
| A2 | Design checklist for the architect. (a) For each must-never-break rule, list the behaviour it assumes. Put any untested assumption, or one with edge cases (0-byte, multipart, archived), under Gaps with its fallback. (b) Hard-task contracts cover terminal cleanup (lost abort responses, confirmed absence vs generic 404), fairness (denial-cap starvation) and request amplification (probe growth). | `agents/architect.md` | Claude 3 + Codex 4 | Claude: the 0-byte/kms gap came from the spec (0008), cost about $4 and 10.5 min. Codex: AE-1 was sent back twice on these topics and needed decisions 0011 and 0012. |
| A3 | Implementer results for failure-path work state the trigger, the observed boundary, the durable postcondition and a positive recovery control. | `agents/implementer.md` and the task-card template | Codex 2 | 9 missing-test findings across 6 tasks (IS-4/6, HD-3/5/7/8) |
| A4 | Reviewers never check out in the shared checkout. They use `git worktree add <scratch>/pr-<n> origin/<branch>`. Never `git checkout`, `switch` or `gh pr checkout` in the cwd. | `agents/reviewer.md` step 4 | Claude 4 | Step 4 contradicts "Side effects". 11/11 reviewer spawns had no isolation. One detached-checkout incident. |
| A5 | Docker etiquette: give each Compose project a unique name, bound every subprocess and readiness wait, and remove only what you started. Run memory-heavy acceptance tests one at a time. Share test evidence tied to the exact SHA instead of re-running. | Side-effects section of `implementer.md`/`reviewer.md`, plus a Director note | Codex 3 | Decision 0010: 270 MB RSS when runs overlapped vs 139 MB alone. Lock-startup races caused review findings. Prefixes are already covered; bounded waits and running one at a time are new. |
| A6 | Review hygiene: label additions after approval as follow-ups, not failures. Withdraw wrong findings explicitly. Tie each accepted limitation to a decision record. Approval with CI pending still needs green CI before merge. | `agents/reviewer.md`, `merging.md` | Codex 5 | Scope additions on HD-6 and AE-DOCS. One withdrawn regex finding. AE-FINAL accepted 263,664 GETs per 128 denied keys under 0012. |
| A7 | **Check severity calibration on Codex.** Codex reviewers gave 30 major and 4 minor. Claude reviewers gave 1 major and 26 minor. Check that the Codex reviewer gets the same severity definitions (`codex.md` / Codex agent files) before reading the 6/20 first-approval rate as a quality gap. | `skills/director/references/codex.md`, Codex reviewer agent file | New (cross-report) | The Codex Coach flagged "calibration attention" (hardening: 16 major, 0 minor). Every Codex send-back was a major. |

## B. Hooks and logging

All of these make the next Coach run cheaper and more accurate. Both Coaches spent effort rebuilding data that should have been logged.

| # | Change | From | Evidence |
|---|---|---|---|
| B1 | A stop-hook re-asks for a missing `result-json`, the same way it already does for `review-json`. | Claude 5 | 2/4 haiku first turns (AE-1, AE-5) had no result. 0/5 sonnet/opus turns were missing one. |
| B2 | Every attempt gets a reason, `escalation`, `fold-in`, `followup` or `availability-retry`, plus the requested **and** the resolved model/effort. | Claude 7 + Codex 1 | Claude: 4/6 tasks had attempt ≥ 2 without failing a review. Codex: initial-sync asked for 5 escalations and ran 0 of them, which the logs alone didn't show. |
| B3 | Interrupted turns write a completion line with `verdict: null` and an `interruption` field (`aborted`, `usage_limit_exceeded`, `server_overloaded`). Their usage is not charged to the retry. | Codex 1 + 6 | 3 missing completion lines, 14.4 agent-minutes, and token cost not counted. |
| B4 | Pause lines get `resumed_ts` or `duration_ms` and a `milestone` field. Codex pause logging needs to work at all. | Claude 7 + Codex 6 | Claude wall time had to be estimated from gaps. Codex has no pause file, and a 22-min gap after the usage limit is unexplained. |
| B5 | The archive README counter counts review, merge and pause lines by their own `milestone`, not only `task.milestone`. | Claude 7 | The README says 0 reviews and merges, but 12 review and 6 merge lines exist. |
| B6 | Uncarded work (plugin fixes made mid-milestone) gets a task card so turns have an identity. | Codex 6 | 9 uncarded turns. Older completions have null task/turn keys. |

## C. Director merge flow

| # | Change | File | From |
|---|---|---|---|
| C1 | **The milestone PR body has one `Closes #N` line per task issue**, so the user's merge into `main` closes them all. A task PR's own `Closes` line does nothing, because it merges into `milestone/<slug>`, not the default branch. | `skills/director/references/merging.md` (milestone PR section), and the milestone PR template if there is one | Claude Director after-action |
| C2 | Always `gh pr merge <n> --squash --delete-branch`. AE-3 (#69) was merged without the flags and its branch may still be there. Check for and delete leftover `task/*` branches. | `merging.md` already says this, so it's a Director slip. Optionally have the guard hook warn on a bare `gh pr merge`. | Claude 7 |

## Watch list (no action yet)

| Item | Trigger to act |
|---|---|
| Claude docs/medium on haiku (AE-4 and HD-11 both got a major) | If 1 or more of the next 3 docs/medium tasks on haiku/medium gets a major at first review, apply Claude's conditional diff: docs/medium → small/**high**, docs/hard → medium/medium. |
| Haiku missing `result-json` (n=4) | B1 fixes the symptom. Keep checking whether it only happens on haiku. |
| Codex Terra/medium implement, 3/9 first approval | Rate it again after A7. If it stays low with calibrated severities, run about 5 tasks starting one step higher to compare. |
| Codex Luna docs/medium 0/1, fix/easy 0/2 | n too small, keep counting. |
| Per-task reviewer tier | Don't raise it. The one miss was a gap in the spec (A2 targets that). |

## Housekeeping

- **Version:** the Codex run used 0.4.4, which is on `main` (#74). The plugin PR for this plan is 0.4.5.
- **B1 root cause:** the existing stop-hook re-ask already covered a missing `result-json`. AE-1 and AE-5 ended through `SubagentHandback` without the block in the handback message, and the handback ends the run before the re-ask can reach the agent. The fix is a PreToolUse check on `SubagentHandback`.
- The Claude totals leave out the Windows session's AE-0/AE-R runs, which are not in the archive.

## Suggested order

1. One plugin PR on a new branch from `main`: A1–A6, B1, B5, C1 and C2's guidance. All are small text or hook changes.
2. Logging schema PR: B2, B3, B4, B6. These touch `log-delegation.js`, `codex-log.js` and `reconcile-logs.js`, and the Coach skill needs to read the new fields.
3. A7 investigation (read-only): compare the severity definitions in the Claude and Codex reviewer prompts.
4. Next milestone: recount the watch list.
