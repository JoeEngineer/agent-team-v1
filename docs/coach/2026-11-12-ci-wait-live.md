# ci-wait live runs: before and after

Four live runs of the same small milestone (three tiny functions plus tests, one reviewer per task PR, one final review on the milestone PR) against a scratch GitHub repo whose CI takes about two minutes. Each tool ran once on plugin 0.5.0 (before) and once on 0.6.0 (after). The "before" plugin is `0205ab8`, the "after" plugin is `666ce58`. All four runs used harness commit `5f9153f` and the large tier on both tools (Claude opus, Codex gpt-6.1-sol).

Every number below was recomputed from the saved Director transcripts with the final harness parser at `milestone/ci-wait` (`tests/live/ci-turns.js`, `tests/live/ci-wait-lib.js`), through the new `tests/live/ci-recompute.js`. Every recomputed number matches the original run report (turns, context tokens, CI turns and tokens, `--watch` counts, per-PR counts). Nothing needed to be restated. The review `ci` values, task PR list and milestone timing come from the run reports (the transcripts do not hold them).

To redo it:

```
node tests/live/ci-recompute.js <run>.transcript.jsonl
```

It reads the task and milestone PR numbers from `<run>.json` next to the transcript, or takes `--task-prs 36,37 --milestone-prs 42`.

One run per cell is one sample. Treat differences of a few turns as noise.

## Before and after

### Claude

| | before (0.5.0) | after (0.6.0) |
|---|---|---|
| Director turns | 34 | 28 |
| Director context tokens | 2,403,985 | 1,858,016 |
| CI-related Director turns | 6 | 6 |
| CI-related context tokens (share of all) | 469,429 (19.5%) | 466,453 (25.1%) |
| `--watch`, foreground / background | 4 / 0 | 0 / 0 |
| Reviewer `ci` values | pending 5 | green 4 |
| CI turns on task PRs / milestone PR / no PR named | 5 / 1 / 0 | 4 / 1 / 1 |
| CI turns per task PR | #17: 4, #23: 1 (#18, #19: 0) | #36: 2, #37: 1, #38: 1 |
| Reported complete, relative to last check finishing | 25 s after | 37 s after |

### Codex

| | before (0.5.0) | after (0.6.0) |
|---|---|---|
| Director turns | 56 | 50 |
| Director context tokens | 3,183,583 | 3,115,461 |
| CI-related Director turns | 13 | 8 |
| CI-related context tokens (share of all) | 759,547 (23.9%) | 543,504 (17.4%) |
| `--watch`, foreground / background | 0 / 0 | 0 / 0 |
| Reviewer `ci` values | pending 5, none 2 | green 5 |
| CI turns on task PRs / milestone PR / no PR named | 10 / 1 / 2 | 4 / 2 / 2 |
| CI turns per task PR | #20: 6, #21: 6, #22: 6 | #39: 2, #40: 1, #41: 1 |
| Reported complete, relative to last check finishing | while 1 check was still running | 65 s after |

How to read the groups. A turn that names several PRs counts once in each group, so the per-PR counts can add up to more than the CI turn total (Codex before: 18 per-PR counts, 13 turns). "No PR named" is a CI turn whose command names no PR number (for example `reconcile-logs.js --merges`). Before, the Claude run's "task PRs" include the Director-records PR #23 because the harness counts every PR into the milestone branch.

Two things the table says plainly:

- Claude's CI turn count and CI token count did not move (6 turns, about 467,000 tokens). Its total fell (34 to 28 turns), so the CI share went up from 19.5% to 25.1%. The gain on Claude is in the 4 foreground `--watch` calls, the pending reviews, and the total turn count, not in fewer CI turns.
- Codex fell from 13 CI turns to 8, and from 759,547 to 543,504 context tokens. The big drop is the task PRs (10 to 4 turns).

## The four spec targets

| Target | Claude before | Claude after | Codex before | Codex after |
|---|---|---|---|---|
| No foreground `--watch` | FAIL (4 foreground) | PASS (0) | PASS (0) | PASS (0) |
| At most one CI-related Director turn per task PR | FAIL (#17: 4, 5 CI turns for 4 task PRs) | FAIL (#36: 2, 5 CI turns for 3 task PRs, 1 not tied to a PR) | FAIL (6 per PR, 20 for 3 task PRs) | FAIL (#39: 2, 6 CI turns for 3 task PRs, 2 not tied to a PR) |
| Reviewer `ci: pending` only on timeout | FAIL (5 of 5 pending, no wait time stated) | PASS (0 pending of 4) | FAIL (5 pending, no wait time stated; 2 more `none`) | PASS (0 pending of 5) |
| Milestone not reported complete before its PR checks finished | PASS (25 s after) | PASS (37 s after) | FAIL (reported complete, `ci: pending`, 1 check still running) | PASS (65 s after) |

The harness's per-PR target is stricter than "at most one per PR". It also fails when the task-PR turns plus the CI turns that name no PR exceed the number of task PRs (see `evaluateTargets` in `tests/live/ci-wait-lib.js`). Both "after" runs fail it on both counts, and the misses are separate: see the diagnosis below. The target stays FAIL for both "after" runs. It is a real miss as written.

## Context only: minio-s3-sync (issue #81)

Not comparable. Taken from issue #81 as reported there, not recomputed here:

- 18 CI calls and 3.4M tokens in one run.
- 10 calls with 3 pending.

That was a different repository and task, counted as calls rather than as Director turns, on an unfixed harness. Do not set it beside the tables above. It only shows the size of the problem the milestone set out to fix.

## Diagnosis: why the first task PR got 2 CI turns in both "after" runs

I listed every turn the parser counted as CI-related in both "after" transcripts (turn numbers below are the parser's turn index, counting from 0) and read each command.

### Claude, after (PR #36: turns 18 and 19)

- **Turn 18** is the required gate. It runs `ci-wait.js 36 --once --sha b9cf579...`, then `gh pr merge 36 --squash --delete-branch --match-head-commit ...`, then `gh pr comment`. The gate answered `"ci":"green",...,"waited_s":0.7`. That is the one CI turn the target allows. The reviewer had already waited for CI, so the Director did not wait.
- **Turn 19** is `gh pr view 36 --json state -q .state; node ".../ci-wait.js" --names 36; sed -i 's/| 1 | in review | #36 |/| 1 | merged | #36 |/' STATUS.md`. The `--names` call printed `"checks":["sample-ci"],"required":["sample-ci"]`. Three turns later (turn 22) the Director filled the `STATUS.md` CI block with `` Required checks on `milestone/*`: `sample-ci` (already required). Allow auto-merge: on. ``

Verdict: **(c) the required first-run step.** `skills/team-init/SKILL.md` (item 1, "Required check names") and `skills/director/references/merging.md` (line 72: "Fill the block after the first CI run on the milestone: `ci-wait.js --names <n>` lists the required checks") both tell the Director to run `--names` once after the first CI run. It does not wait on CI and does not poll. It ran once, on the first PR only (#37 and #38 got no `--names`). The parser counts it because `ci-wait.js` is in its CI pattern list.

### Codex, after (PR #39: turns 16 and 20)

- **Turn 16** is one call: `reconcile-logs.js; ci-wait.js --names 39; gh pr view 39 --json headRefOid,statusCheckRollup; Get-Content .agent-team/logs/delegations.jsonl -Tail 6`. The next turn writes `STATUS.md`: "Required check: sample-ci (confirmed by ci-wait --names on PR #39). Allow auto-merge: on." This is the same first-run `--names` step, bundled with a log reconcile and a log tail. The `statusCheckRollup` read is the Director looking at the same check names a second way.
- **Turn 20** is the gate: `ci-wait.js 39 --once --sha 43219b0...; if ($LASTEXITCODE -eq 0) { gh pr merge 39 ...; gh pr comment 39 ... }`, answered green with `waited_s` 0.5.

Verdict: **(c) the required first-run step**, same as Claude. The `statusCheckRollup` read in turn 16 is a small real extra look, but it sits in the same call as the required `--names`, so it did not add a turn. Neither run polled, slept on CI, or re-checked a PR that the reviewer had reported green.

So neither miss is (a) a real extra CI wait, and neither is (b) a parser over-count in the sense of a turn that only mentions a PR number. The turn-19 and turn-16 commands do read CI check names, which is what the pattern list looks for.

### The "not tied to a PR" turns

- **Claude (1): turn 22.** `for n in 37 38; do gh pr view $n --json state -q .state; done; node ".../reconcile-logs.js" --merges; sed -i ... STATUS.md; git pull; ...`. The PR number is a shell loop variable, so the parser cannot read it. It is the "end of a wave" `reconcile-logs.js --merges` checkpoint. `skills/director/references/merging.md` ("Queued PRs: checkpoints") and `skills/director/SKILL.md` step 9 both require it: before the next merge when something is queued, at the end of a wave, and before opening the milestone PR. Nothing was queued in this run (the Director merged each PR with the gate call, not auto-merge). Verdict: **(c) required checkpoint**, not a CI wait.
- **Codex (2): turns 25 and 39.** Turn 25 is `git restore STATUS.md; Remove-Item ...plan.md; git rebase origin/milestone/...; Move-Item run-state.json ...; reconcile-logs.js --merges; git status`. Turn 39 is `git pull --ff-only; reconcile-logs.js --merges; gh pr create --base main ...; git status`. Both are the same checkpoint, once before the fold-in merge and once before opening the milestone PR (SKILL.md step 9 item 1). Each is bundled with housekeeping, and neither checks CI. Verdict: **(c) required checkpoint**.

### One real over-count I found (milestone PR, not the target)

Codex turn 42 is `reconcile-logs.js --merges; git worktree list; gh pr view 43 --json title,body,commits`. It is counted as a CI turn only because of `reconcile-logs.js --merges`, and it is attributed to milestone PR #43 because the parser takes PR numbers from every `gh pr` command in the call, not only from the CI-matching part. The `gh pr view 43` read the PR body, not its checks. Effect: Codex's "milestone PR" count is 2 where 1 is a CI check (turn 48: `ci-wait.js 43 --once`). Its "no PR named" count would then be 3 and its milestone count 1. That does not touch the per-task-PR target, so I did not change the parser in this PR (a change would also change the pinned test of the `reconcile-merges` pattern). Follow-up below.

## Recommendation per miss

| Miss | Verdict | Recommendation |
|---|---|---|
| Claude #36: 2 turns | (c) required first-run step | Stays FAIL as written. Either change the wording of the target, or change the prompt (below). Do not pass it by loosening the parser. |
| Codex #39: 2 turns | (c) required first-run step | Same. |
| "No PR named" turns (Claude 1, Codex 2) | (c) required checkpoint | The harness counts them against the per-PR target (task-PR turns plus no-PR turns must not exceed the number of task PRs). With them, an "after" run could pass only by skipping a checkpoint the prompt requires. |

Both options, for the Director to choose:

1. **Change the target.** State that it excludes the one-time `ci-wait.js --names` listing and the `reconcile-logs.js --merges` checkpoint, because both are mandated and neither waits on CI. Then change `evaluateTargets` to match. With the first-run call (including the `statusCheckRollup` read in Codex turn 16) and the checkpoint turns excluded, the per-PR counts would be #36: 1, #37: 1, #38: 1 (Claude) and #39: 1, #40: 1, #41: 1 (Codex), with 3 CI turns for 3 task PRs each, which would pass. I have not made this change: it moves the goalposts, so it needs the Director's decision.
2. **Keep the target and change the prompt** so the run can meet it. File `skills/director/references/merging.md`, line 72, after "Fill the block after the first CI run on the milestone:" add "run `ci-wait.js --names <n>` in the same call as the first merge gate, not in a later turn." That puts both in one turn for the first PR. It does nothing for the checkpoint turns, so the `reconcile-logs.js --merges` turns (and the "total" rule) would still need option 1 or a prompt change to fold the checkpoint into a turn that is already about something else. Needs a separate fix task.

Whichever is chosen, the reports above stay FAIL.

## The notification stream (CW-6 review finding 2)

"Started by a background notification" was 0 in both "after" runs. Why, from the transcripts:

- **Codex:** the rollout has no background-completion events at all, and the Director ran nothing in the background. Codex has no background shell. 0 is expected.
- **Claude:** the stream has 19 `{"type":"system","subtype":"task_notification"}` events. None is a CI command. They are completions of background subagents (reviewers, implementers: `Agent` calls) and one backgrounded `gh issue create` script (its notification's `summary` is the script text). No Claude Director call in this run used `--watch`, `ci-wait.js` with a long timeout, or `Monitor`. No background CI watch was needed, because the reviewers had already waited for CI and every gate answered in under a second. So 0 is the correct answer for these runs.

Can the metric detect them? Not in this stream shape. The parser attaches a notification to the next turn only when a `{"type":"result"}` event was seen first (`idle` in `parseClaudeStream`). In these transcripts the 19 notifications arrive in the middle of the run, between assistant turns, and the three `result` events all come at the end. The event order looks like `A U A N U A Nx2 A ...`, with no `result` before any notification. So none could ever be attached, CI or not. The tool-use link (`tool_use_id` on the notification, matched to a CI Bash call) is there and would work. The `idle` gate is what blocks it. This does not affect the CI turn counts (the turn that starts a background watch is counted when it runs), but a real background watch that finishes mid-run would not show up in "started by a background notification". This is not fixed here (out of scope); see the follow-up.

## Follow-ups (not done here)

1. Director decision on the per-PR target (option 1 or 2 above), then a fix task for `evaluateTargets` or `merging.md`.
2. Parser: take PR numbers only from the CI-matching part of a command (the Codex turn 42 case), with a test.
3. Parser: attach a `task_notification` to the next turn even without a preceding `result` event, if its `tool_use_id` is a CI command, with a test using the mid-run order above.
4. A live run that forces a background watch (a slow CI) would be needed to see a non-zero "started by a background notification". None of the four runs covered that path.
