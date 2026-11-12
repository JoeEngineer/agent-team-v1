# ci-wait live runs: before and after

Six live runs of the same small milestone (three tiny functions plus tests, one reviewer per task PR, one final review on the milestone PR) against a scratch GitHub repo whose CI takes about two minutes. Each tool ran once on plugin 0.5.0 (before), once on 0.6.0 (after), and once on 0.6.0 plus CW-9 (the "re-run after CW-9", label `cw9`, last section). All six runs used harness commit `5f9153f` and the large tier on both tools (Claude opus, Codex gpt-6.1-sol).

Where the commit SHAs come from. The plugin commit of each run is the `plugin=<version>@<commit>` part of the header line each run prints (`=== ci-wait live run: <run> label=<label> tool=<tool> plugin=0.6.0@54415b1 ===` in the run logs `before-*.log`, `after-*.log`, `cw9-*.log`, and as `plugin.version` and `plugin.commit` in the run report JSON). It is the `git rev-parse --short HEAD` of the plugin checkout the harness was pointed at (a separate worktree per plugin version): `0205ab8` (0.5.0), `666ce58` (0.6.0, after), `54415b1` (0.6.0 plus CW-9). The harness commit `5f9153f` is the head of the harness worktree the runs were started from; the run output and the report do not contain it (I found no harness commit in either), so it comes from the harness worktree the runs were started from, as given in the task for this report.

Every number below was recomputed from the saved Director transcripts with the final harness parser (`tests/live/ci-turns.js`, `tests/live/ci-wait-lib.js`), through `tests/live/ci-recompute.js`. The review `ci` values, task PR list and milestone timing come from the run reports (the transcripts do not hold them).

The parser changed in this PR (PR numbers are now taken only from the CI part of a call; see "The parser and target fixes"). That changed how CI turns are split between PRs, not how many there are. Turns, context tokens, CI turns, CI tokens and `--watch` counts are identical to the original run reports in all six runs. The per-PR split and the no-PR count differ in five of the six runs, and in the tables the old parser's number is shown beside the new one wherever they differ. `node tests/live/ci-recompute.js <run>.transcript.jsonl --compare <run>.json` prints exactly those differences.

To redo it:

```
node tests/live/ci-recompute.js <run>.transcript.jsonl
node tests/live/ci-recompute.js <run>.transcript.jsonl --compare <run>.json
```

It reads the task and milestone PR numbers from `<run>.json` next to the transcript, or takes `--task-prs 36,37 --milestone-prs 42`.

One run per cell is one sample. Treat differences of a few turns as noise.

## Before and after

New parser first; old parser's number in brackets where it differs.

### Claude

| | before (0.5.0) | after (0.6.0) |
|---|---|---|
| Director turns | 34 | 28 |
| Director context tokens | 2,403,985 | 1,858,016 |
| CI-related Director turns | 6 | 6 |
| CI-related context tokens (share of all) | 469,429 (19.5%) | 466,453 (25.1%) |
| `--watch`, foreground / background | 4 / 0 | 0 / 0 |
| Reviewer `ci` values | pending 5 | green 4 |
| CI turns on task PRs / milestone PR / no PR named | 4 [5] / 1 / 1 [0] | 4 / 1 / 1 |
| CI turns per task PR | #17: 3 [4], #23: 1 (#18, #19: 0) | #36: 2, #37: 1, #38: 1 |
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
| CI turns on task PRs / milestone PR / no PR named | 10 / 1 / 2 | 4 / 1 [2] / 3 [2] |
| CI turns per task PR | #20: 6, #21: 4 [6], #22: 5 [6] | #39: 2, #40: 1, #41: 1 |
| Reported complete, relative to last check finishing | while 1 check was still running | 65 s after |

How to read the groups. A turn that names several PRs counts once in each group, so the per-PR counts can add up to more than the CI turn total. "No PR named" is a CI turn whose command names no PR (for example `reconcile-logs.js --merges`). The Claude "before" run's task PRs include the Director-records PR #23, because the harness counts every PR into the milestone branch.

Two things the table says plainly:

- Claude's CI turn count and CI token count did not move (6 turns, about 467,000 tokens). Its total fell (34 to 28 turns), so the CI share went up from 19.5% to 25.1%. The gain on Claude is in the 4 foreground `--watch` calls, the pending reviews and the total turn count, not in fewer CI turns.
- Codex fell from 13 CI turns to 8, and from 759,547 to 543,504 context tokens.

## The four spec targets

| Target | Claude before | Claude after | Codex before | Codex after |
|---|---|---|---|---|
| No foreground `--watch` | FAIL (4 foreground) | PASS (0) | PASS (0) | PASS (0) |
| At most one CI-related Director turn per task PR | FAIL (#17: 3) | FAIL (#36: 2) | FAIL (#20: 6, #21: 4, #22: 5) | FAIL (#39: 2) |
| Reviewer `ci: pending` only on timeout | FAIL (5 of 5 pending, no wait time stated) | PASS (0 pending of 4) | FAIL (5 pending, no wait time stated; 2 more `none`) | PASS (0 pending of 5) |
| Milestone not reported complete before its PR checks finished | PASS (25 s after) | PASS (37 s after) | FAIL (reported complete, `ci: pending`, 1 check still running) | PASS (65 s after) |

The per-PR target stays FAIL for both "after" runs under both the old and the new rule. It is a real miss as written: see the diagnosis. (The old harness rule also charged the no-PR turns against the task PRs, which made every run fail it a second way. That rule is replaced; see "The parser and target fixes".)

## Context only: minio-s3-sync (issue #81)

Not comparable. Taken from issue #81 as reported there, not recomputed here:

- 18 CI calls and 3.4M tokens in one run.
- 10 calls with 3 pending.

That was a different repository and task, counted as calls rather than as Director turns, on an unfixed harness. Do not set it beside the tables above. It only shows the size of the problem the milestone set out to fix.

## Diagnosis: why the first task PR got 2 CI turns in both "after" runs

I listed every turn the parser counted as CI-related in both "after" transcripts (turn numbers are the parser's turn index, counting from 0) and read each command. The verdicts hold under the fixed parser.

### Claude, after (PR #36: turns 18 and 19)

- **Turn 18** is the required gate. It runs `ci-wait.js 36 --once --sha b9cf579...`, then `gh pr merge 36 --squash --delete-branch --match-head-commit ...`, then `gh pr comment`. The gate answered `"ci":"green",...,"waited_s":0.7`. That is the one CI turn the target allows. The reviewer had already waited for CI, so the Director did not wait.
- **Turn 19** is `gh pr view 36 --json state -q .state; node ".../ci-wait.js" --names 36; sed -i ... STATUS.md`. The `--names` call printed `"checks":["sample-ci"],"required":["sample-ci"]`. Three turns later (turn 22) the Director filled the `STATUS.md` CI block with `` Required checks on `milestone/*`: `sample-ci` (already required). Allow auto-merge: on. ``

Verdict: **(c) the required first-run step.** `skills/team-init/SKILL.md` (item 1, "Required check names") and `skills/director/references/merging.md` (the "Fill the block after the first CI run on the milestone" sentence) tell the Director to run `ci-wait.js --names` once after the first CI run. It does not wait on CI and does not poll. It ran once, on the first PR only. The parser counts it because `ci-wait.js` is in its CI pattern list.

### Codex, after (PR #39: turns 16 and 20)

- **Turn 16** is one call: `reconcile-logs.js; ci-wait.js --names 39; gh pr view 39 --json headRefOid,statusCheckRollup; Get-Content .agent-team/logs/delegations.jsonl -Tail 6`. The next turn writes `STATUS.md`: "Required check: sample-ci (confirmed by ci-wait --names on PR #39). Allow auto-merge: on." This is the same first-run `--names` step, bundled with a log reconcile and a log tail.
- **Turn 20** is the gate: `ci-wait.js 39 --once --sha 43219b0...; if ($LASTEXITCODE -eq 0) { gh pr merge 39 ...; gh pr comment 39 ... }`, answered green with `waited_s` 0.5.

Verdict: **(c) the required first-run step**, same as Claude. Neither run polled, slept on CI, or re-checked a PR the reviewer had reported green. Neither miss is (a) a real extra CI wait. Neither is (b) a parser over-count: the commands do read CI check names, which is what the pattern list looks for.

### The "no PR named" turns

- **Claude after (1): turn 22.** `for n in 37 38; do gh pr view $n --json state -q .state; done; node ".../reconcile-logs.js" --merges; sed -i ... STATUS.md; git pull; ...`. The PR number is a shell loop variable. It is the "end of a wave" `reconcile-logs.js --merges` checkpoint. `skills/director/references/merging.md` ("Queued PRs: checkpoints") and `skills/director/SKILL.md` step 9 require it: before the next merge when something is queued, at the end of a wave, and before opening the milestone PR. Nothing was queued in this run. Verdict: **(c) required checkpoint**, not a CI wait.
- **Codex after (3 with the fixed parser, 2 with the old): turns 25, 39 and 42.** Turns 25 and 39 are the same checkpoint (once before the fold-in merge, once before opening the milestone PR), each bundled with housekeeping (`git rebase`, `Move-Item run-state.json`, `gh pr create`). Turn 42 is `reconcile-logs.js --merges; git worktree list; gh pr view 43 --json title,body,commits`. Verdict for all three: **(c) required checkpoint**. Turn 42 was a parser over-count of a different kind: see below.

### The over-count found in turn 42 (fixed here)

The old parser took PR numbers from every `gh pr` command in a call that matched any CI pattern. Turn 42 matched only because of `reconcile-logs.js --merges`, but `gh pr view 43 --json title,body,commits` (a read of the PR body, not its checks) was charged to milestone PR #43. That made Codex's milestone count 2 where one turn was a CI check (turn 48: `ci-wait.js 43 --once`). Fixed: it is now a no-PR turn, and the milestone count is 1. The per-task-PR target is untouched by this.

## Recommendation per miss

| Miss | Verdict | Recommendation |
|---|---|---|
| Claude #36: 2 turns | (c) required first-run step | Stays FAIL as written. Done: CW-9 puts `--names` into the first merge-gate call (option 2 below). |
| Codex #39: 2 turns | (c) required first-run step | Same. |
| "No PR named" turns | (c) required checkpoint | They are measured and reported, but not charged to a task PR (a measurement fix, below). |

The two options that were open in the first version of this report:

1. **Change the target** to exclude the first-run call and the checkpoints. Not taken for the first-run step: it would move the goalposts.
2. **Keep the target and change the prompt** so `--names` rides in the first merge-gate call. **Done**: CW-9, PR #99, decision `docs/decisions/0016-names-in-first-gate-call.md`. The re-run below checks it.

The `reconcile-logs.js --merges` checkpoints are the part of option 1 that was taken, as a measurement fix and not as a softer target; see the next section.

## The parser and target fixes in this PR

All in `tests/live/ci-turns.js` and `tests/live/ci-wait-lib.js`, with unit tests.

**1. Attribution.** A turn's PR numbers used to come from the whole call. Now a command is first reduced to the code that runs: heredoc bodies and PowerShell here-strings, the value of `--body`/`-b`/`--message`/`--title`, the script of `sed`, `.Replace(...)` and `-replace` arguments, and `echo`/`Write-Host` lines are removed. PR numbers are then taken only from the segments (split at `;`, `&&`, `||`, `|` and line breaks) that match a CI pattern: `ci-wait.js <n>`, `gh pr checks|merge|view|status <n>`, the `glab mr` equivalents. Evidence that this was wrong before: Claude cw9 turn 21 is `reconcile-logs.js --merges`, then a `sed` STATUS edit, then `gh pr create --body "...#54, #55, #56..."`; it was charged to #55 and #56. Codex after turn 42 is above. New tests: both shapes, plus a table of quoted-text shapes that must name no PR and count as no CI.

**2. Classification (Codex cw9 turns 26 and 40).** They are not misclassified. Both calls do end with `node .../reconcile-logs.js --merges` (the last line of the call). The first 400 characters of the command, which is all the report keeps, show only the STATUS edit, which is why it looked otherwise. The classification was right, so there is no bug to fix in that case. What I did change: a script name mentioned inside quoted text, a heredoc, a `.Replace(...)` string, a `--body` or an `echo` no longer counts as the script running. The test pins both sides: the STATUS edit alone is not a CI turn; the same edit followed by `reconcile-logs.js --merges` is one reconcile turn, tied to no PR. (That test passes on the old parser too, as expected: it protects the right behaviour.)

**3. The target with no-PR turns.** The exact old rule in `evaluateTargets` was: FAIL if any task PR had more than 1 CI turn, **or** if (CI turns on task PRs) + (CI turns naming no PR) was more than the number of task PRs. Codex cw9: 5 task PRs at 1 turn each, plus 6 `reconcile-logs.js --merges` turns that name no PR, is 11 > 5, so FAIL ("11 CI turn(s) for 5 task PR(s), 6 of them not tied to a PR") although every task PR got exactly 1. Those checkpoints are required by the Director prompt and belong to no task PR, so charging them against the task PRs was a measurement error. New rule: FAIL only if some task PR has 2 or more CI turns that name it. No-PR turns get their own INFO row (count, context tokens), and the target's detail line says how many there were. **This is a measurement fix, not a softened target:** a task PR with 2 CI turns still FAILs (tests: 2 real turns with 0 no-PR turns, and 2 real turns next to 6 no-PR turns, both FAIL), and Claude and Codex "after" still FAIL it. Note: decision 0016 says the harness "stays as written"; this changes the harness rule on the Director's request (the no-PR half only).

## Re-run after CW-9

Plugin `54415b1` (0.6.0 plus CW-9), harness `5f9153f`, large tier, label `cw9`. The runs differ in size from the "after" runs: Claude had 4 task PRs (the three tasks plus a STATUS bookkeeping PR, #60), Codex had 5 task PRs (the three tasks, a records PR #62, and a re-review of #59 that led to a fix PR #64), with 91 turns. Totals are not directly comparable with the "after" runs; per task PR they are.

| | Claude after | Claude cw9 | Codex after | Codex cw9 |
|---|---|---|---|---|
| Task PRs | 3 | 4 | 3 | 5 |
| Director turns | 28 | 30 | 50 | 91 |
| Director context tokens | 1,858,016 | 2,101,339 | 3,115,461 | 5,877,903 |
| CI-related Director turns | 6 | 7 | 8 | 12 |
| CI-related context tokens (share) | 466,453 (25.1%) | 563,515 (26.8%) | 543,504 (17.4%) | 826,563 (14.1%) |
| CI turns on task PRs (tokens) | 4 (304,728) | 4 [5] (313,360 [392,468]) | 4 (255,974) | 5 (339,580) |
| CI turns on milestone PR (tokens) | 1 (83,026) | 1 (87,513) | 1 [2] (76,014 [150,000]) | 1 (81,656) |
| CI turns naming no PR (tokens) | 1 (78,699) | 2 [1] (162,642 [83,534]) | 3 [2] (211,516 [137,530]) | 6 (405,327) |
| CI turns per task PR | #36: 2, #37: 1, #38: 1 | #54: 1, #55: 1 [2], #56: 1 [2], #60: 1 | #39: 2, #40: 1, #41: 1 | #57: 1, #58: 1, #59: 1, #62: 1, #64: 1 |
| CI tokens per task PR | 101,576 | 78,340 | 85,325 | 67,916 |
| `--watch`, foreground / background | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Reviewer `ci` values | green 4 | green 5 | green 5 | green 9, pending 1 |
| Reported complete, relative to last check finishing | 37 s after | 35 s after | 65 s after | 64 s after |

Targets, per run:

| Target | Claude cw9 | Codex cw9 |
|---|---|---|
| No foreground `--watch` | PASS (0) | PASS (0) |
| At most one CI-related Director turn per task PR | PASS (#54: 1, #55: 1, #56: 1, #60: 1) (old parser: FAIL, #55: 2, #56: 2) | PASS (#57, #58, #59, #62, #64: 1 each) (old rule: FAIL, "11 CI turn(s) for 5 task PR(s)") |
| Reviewer `ci: pending` only on timeout | PASS (5 reviews, all green) | **FAIL** (1 pending of 10: see below) |
| Milestone not reported complete before its PR checks finished | PASS (35 s after) | PASS (64 s after) |

The first-PR step now fits in one turn on both tools. Claude cw9 turn 16 is `ci-wait.js --names 54; ci-wait.js 54 --once --sha ... && gh pr merge 54 ... && gh pr comment 54 ...`; Codex cw9 turn 25 is the same chain for #58 (its first merged PR). The Director wrote "Merging, with the one-time check-name readout added in front". Both runs got 1 CI turn on every task PR, including the first.

The six no-PR turns in Codex cw9 (turns 26, 33, 40, 47, 63, 83) are all `reconcile-logs.js --merges` checkpoints, several bundled with STATUS edits. That is more than the prompt requires (it asks for one at the end of a wave and one before the milestone PR). They cost 405,327 context tokens, 49% of Codex's CI tokens in that run. They are not a target miss, but they are the largest remaining CI-related spend, and at least two of them (turns 26 and 40) printed nothing, so nothing was queued. Worth a look in a later task.

### New miss: Codex cw9, "reviewer pending only on timeout"

The pending review is the first review of task `-3` (slugify), head `d68bde5`. The reviewer's `review-json` (in the Director transcript and in `reviews.jsonl`) says:

- `verdict: changes_requested`, `severity: major`, one blocking finding (`missing-tests`: no non-ASCII input test), `tests_passed: true`,
- `ci: pending`, `summary: "The suite passes, but the ASCII-only boundary lacks required coverage; CI was not waited: changes requested."`

What happened: the reviewer did not time out. It followed `agents/reviewer.md` ("Waiting for CI": for a blocking finding, don't do the full wait; run `ci-wait.js <n> --once --sha <head_sha>` once, and if it shows pending put "not waited: changes requested" in `summary`; and the `ci` field text: "The one other case is the blocking-finding single check above, marked 'not waited: changes requested'"). The Director sent the PR back, and the later review of the fix reported green. So the reviewer behaved as written, and **the harness misread it**: `reviewStats` in `tests/live/ci-wait-lib.js` counts every `ci: pending` that does not state a wait of at least `TIMEOUT_MIN` minutes as a violation, and never looks at the verdict or at the documented exception.

Recommended change (not made here, as asked; I did not touch `agents/reviewer.md`):

1. Harness, `tests/live/ci-wait-lib.js`, `reviewStats`: record the review's `verdict`, and in `evaluateTargets` do not count as a violation a pending whose verdict is `changes_requested` or `reject` and whose summary says it was not waited ("not waited" or "was not waited"). Show it in the detail line ("1 pending, not waited because changes were requested"). A pending on an approving review with no stated wait stays FAIL. This needs the same kind of decision as the no-PR rule: the spec target says "pending only on timeout", so the exception is real only if the spec accepts what `reviewer.md` already says. The director should decide that.
2. Prompt, `agents/reviewer.md` "Waiting for CI": the prescribed phrase is "not waited: changes requested" but the reviewer wrote "CI was not waited: changes requested". Tighten the wording of the rule, for example "put exactly `not waited: changes requested` at the start of `summary`", so a harness (or the Coach) can match it exactly.

Until one of these is done, this target will FAIL whenever a reviewer sends a PR back while CI is still running.

## The notification stream (CW-6 review finding 2)

"Started by a background notification" was 0 in all six runs. Why, from the transcripts:

- **Codex:** the rollout has no background-completion events at all, and the Director ran nothing in the background. Codex has no background shell. 0 is expected.
- **Claude:** the stream has 19 `{"type":"system","subtype":"task_notification"}` events in the "after" run. None is a CI command. They are completions of background subagents (reviewers, implementers: `Agent` calls) and one backgrounded `gh issue create` script. No Claude Director call used `--watch`, a long `ci-wait.js --timeout`, or `Monitor`. No background CI watch was needed, because the reviewers had already waited for CI and every gate answered in under a second. So 0 is the correct answer for these runs.

Can the metric detect them? Not in this stream shape. The parser attaches a notification to the next turn only when a `{"type":"result"}` event was seen first (`idle` in `parseClaudeStream`). In these transcripts the notifications arrive in the middle of the run, between assistant turns, and the three `result` events all come at the end. The event order looks like `A U A N U A Nx2 A ...`, with no `result` before any notification. So none could ever be attached, CI or not. The link from a notification to its command (`tool_use_id`) is there and would work. The `idle` gate is what blocks it. This does not affect the CI turn counts (the turn that starts a background watch is counted when it runs), but a real background watch that finishes mid-run would not show up in "started by a background notification". Not fixed here (out of scope).

## Follow-ups (not done here)

1. Reviewer pending exception (harness `reviewStats`/`evaluateTargets`, and the `reviewer.md` wording), as above. The director decides whether the target accepts "not waited: changes requested".
2. Parser: attach a `task_notification` to the next turn even without a preceding `result` event, if its `tool_use_id` is a CI command, with a test using the mid-run order above.
3. A live run with a slow CI would be needed to see a non-zero "started by a background notification". None of the six runs covered that path.
4. Codex runs `reconcile-logs.js --merges` more often than the prompt asks (6 times in cw9, and at least two of them printed nothing). A prompt tweak could limit it to "when something is queued, at the end of a wave and before the milestone PR".
