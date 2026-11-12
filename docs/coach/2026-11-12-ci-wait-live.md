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
| CI turns on task PRs / milestone PR | 4 [5] / 1 | 4 / 1 |
| No-PR CI turns: reconcile checkpoints / unattributed CI reads | 0 / 1 [0 / 0] | 1 / 0 |
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
| CI turns on task PRs / milestone PR | 10 / 1 | 4 / 1 [2] |
| No-PR CI turns: reconcile checkpoints / unattributed CI reads | 0 / 2 | 3 [2] / 0 |
| CI turns per task PR | #20: 6, #21: 4 [6], #22: 5 [6] | #39: 2, #40: 1, #41: 1 |
| Reported complete, relative to last check finishing | while 1 check was still running | 65 s after |

How to read the groups. A turn that names several PRs counts once in each group, so the per-PR counts can add up to more than the CI turn total. A "no-PR" CI turn is one whose command names no PR the parser can read. There are two kinds. A **reconcile checkpoint** is a turn whose only CI kind is `reconcile-logs.js --merges`; it is not a look at CI and is not charged to a task PR. An **unattributed CI read** is any other no-PR CI turn; it is a real look at CI whose PR could not be read, and it is charged to the task-PR total. The Claude "before" run has one of those, and it is not a checkpoint: turn 20 is `for n in 18 19; do gh pr checks $n --watch --interval 15 >/dev/null 2>&1; gh pr checks $n; ...`, a foreground `--watch` on #18 and #19 through a loop variable (the PR number is in `$n`, so the parser cannot read it). Codex "before" has two unattributed reads (turns 10 and 11: `gh pr list ... --json statusCheckRollup`). The Claude "before" run's task PRs include the Director-records PR #23, because the harness counts every PR into the milestone branch.

Two things the table says plainly:

- Claude's CI turn count and CI token count did not move (6 turns, about 467,000 tokens). Its total fell (34 to 28 turns), so the CI share went up from 19.5% to 25.1%. The gain on Claude is in the 4 foreground `--watch` calls, the pending reviews and the total turn count, not in fewer CI turns.
- Codex fell from 13 CI turns to 8, and from 759,547 to 543,504 context tokens.

## The four spec targets

| Target | Claude before | Claude after | Codex before | Codex after |
|---|---|---|---|---|
| No foreground `--watch` | FAIL (4 foreground) | PASS (0) | PASS (0) | PASS (0) |
| At most one CI-related Director turn per task PR | FAIL (#17: 3, plus 1 unattributed read: 5 for 4 PRs) | FAIL (#36: 2) | FAIL (#20: 6, #21: 4, #22: 5, plus 2 unattributed reads) | FAIL (#39: 2) |
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

Two kinds, and they are not the same thing (see the table notes): reconcile checkpoints, and unattributed CI reads. The Claude "before" turn 20 is an unattributed read (a foreground `--watch` on #18 and #19 through a loop variable), not a checkpoint; the after runs have none of those.

- **Claude after (1 reconcile checkpoint): turn 22.** `for n in 37 38; do gh pr view $n --json state -q .state; done; node ".../reconcile-logs.js" --merges; sed -i ... STATUS.md; git pull; ...`. The PR number is a shell loop variable. It is the "end of a wave" `reconcile-logs.js --merges` checkpoint. `skills/director/references/merging.md` ("Queued PRs: checkpoints") and `skills/director/SKILL.md` step 9 require it: before the next merge when something is queued, at the end of a wave, and before opening the milestone PR. Nothing was queued in this run. Verdict: **(c) required checkpoint**, not a CI wait.
- **Codex after (3 with the fixed parser, 2 with the old): turns 25, 39 and 42.** Turns 25 and 39 are the same checkpoint (once before the fold-in merge, once before opening the milestone PR), each bundled with housekeeping (`git rebase`, `Move-Item run-state.json`, `gh pr create`). Turn 42 is `reconcile-logs.js --merges; git worktree list; gh pr view 43 --json title,body,commits`. Verdict for all three: **(c) required checkpoint**. Turn 42 was a parser over-count of a different kind: see below.

### The over-count found in turn 42 (fixed here)

The old parser took PR numbers from every `gh pr` command in a call that matched any CI pattern. Turn 42 matched only because of `reconcile-logs.js --merges`, but `gh pr view 43 --json title,body,commits` (a read of the PR body, not its checks) was charged to milestone PR #43. That made Codex's milestone count 2 where one turn was a CI check (turn 48: `ci-wait.js 43 --once`). Fixed: it is now a no-PR turn, and the milestone count is 1. The per-task-PR target is untouched by this.

## Recommendation per miss

| Miss | Verdict | Recommendation |
|---|---|---|
| Claude #36: 2 turns | (c) required first-run step | Stays FAIL as written. Done: CW-9 puts `--names` into the first merge-gate call (option 2 below). |
| Codex #39: 2 turns | (c) required first-run step | Same. |
| Reconcile checkpoints (no PR) | (c) required checkpoint | Measured and reported, but not charged to a task PR (a measurement fix, below). |
| Unattributed CI reads (no PR) | real CI looks (only in the "before" runs) | Charged to the task-PR total. |

The two options that were open in the first version of this report:

1. **Change the target** to exclude the first-run call and the checkpoints. Not taken for the first-run step: it would move the goalposts.
2. **Keep the target and change the prompt** so `--names` rides in the first merge-gate call. **Done**: CW-9, PR #99, decision `docs/decisions/0016-names-in-first-gate-call.md`. The re-run below checks it.

The `reconcile-logs.js --merges` checkpoints are the part of option 1 that was taken, as a measurement fix and not as a softer target; see the next section.

## The parser and target fixes in this PR

All in `tests/live/ci-turns.js` and `tests/live/ci-wait-lib.js`, with unit tests.

**1. Attribution.** A turn's PR numbers used to come from the whole call. Now a command is first reduced to the code that runs (`codeView`): heredoc bodies and PowerShell here-strings, the value of `--body`/`-b`/`--message`/`--title`, the script of the `sed` segment, `.Replace(...)` and `-replace` arguments, and the own arguments of `echo`/`printf`/`Write-Host`/`Write-Output` are removed. Three limits keep this from hiding real CI calls (the first version of this fix did, found in review): a print command loses only its own arguments up to the next `;`, `&&`, `||`, `|` or line break, and a `$(...)`, backtick or `(...)` sub-expression inside it is kept because it runs (`echo $(gh pr checks 5)`, `Write-Host (gh pr checks 5)`); the sed removal stops at the end of the sed segment; and a heredoc or here-string that an interpreter reads (`bash <<EOF`, `sh`, `pwsh`, `node`, `python`, `Invoke-Expression`, `iex`) keeps its text. When in doubt the text stays, because an over-count is cosmetic and an under-count hides a CI call. PR numbers are then taken only from the segments (split at `;`, `&&`, `||`, `|` and line breaks) that match a CI pattern: `ci-wait.js <n>`, `gh pr checks|merge|view|status <n>`, the `glab mr` equivalents. Evidence that this was wrong before: Claude cw9 turn 21 is `reconcile-logs.js --merges`, then a `sed` STATUS edit, then `gh pr create --body "...#54, #55, #56..."`; it was charged to #55 and #56. Codex after turn 42 is above. New tests: both shapes, plus a table of quoted-text shapes that must name no PR and count as no CI.

**2. Classification (Codex cw9 turns 26 and 40).** They are not misclassified. Both calls do end with `node .../reconcile-logs.js --merges` (the last line of the call). The first 400 characters of the command, which is all the report keeps, show only the STATUS edit, which is why it looked otherwise. The classification was right, so there is no bug to fix in that case. What I did change: a script name mentioned inside quoted text, a heredoc, a `.Replace(...)` string, a `--body` or an `echo` no longer counts as the script running. The test pins both sides: the STATUS edit alone is not a CI turn; the same edit followed by `reconcile-logs.js --merges` is one reconcile turn, tied to no PR. (That test passes on the old parser too, as expected: it protects the right behaviour.)

**3. The target with no-PR turns.** The exact old rule in `evaluateTargets` was: FAIL if any task PR had more than 1 CI turn, **or** if (CI turns on task PRs) + (CI turns naming no PR) was more than the number of task PRs. Codex cw9: 5 task PRs at 1 turn each, plus 6 `reconcile-logs.js --merges` turns that name no PR, is 11 > 5, so FAIL ("11 CI turn(s) for 5 task PR(s), 6 of them not tied to a PR") although every task PR got exactly 1. Those checkpoints are required by the Director prompt and belong to no task PR, so charging them against the task PRs was a measurement error. New rule: only reconcile-only turns (`reconcile-logs.js --merges` is the only CI kind in the turn) go uncharged. Any other no-PR CI turn is a real CI look whose PR could not be read (a `statusCheckRollup` read, `gh pr checks $n` in a loop, `ci-wait.js $n`), so it is charged: FAIL if some task PR has 2 or more CI turns that name it, or if (task-PR CI turns) + (unattributed CI reads) is more than the number of task PRs. The INFO output has two rows, "reconcile checkpoints" and "unattributed CI reads", each with count and tokens (the first version of this fix exempted every no-PR turn, which let a loop poll through; found in review). **This is a measurement fix, not a softened target:** a task PR with 2 CI turns still FAILs, and so does a loop poll (tests: 2 real turns with 0 no-PR turns, 2 real turns next to 6 reconcile turns, a `for n in 5 6; do gh pr checks $n; done` poll, and a `statusCheckRollup` read all FAIL; reconcile-only turns PASS), and Claude and Codex "after" still FAIL it. Note: decision 0016 says the harness "stays as written"; this changes the harness rule on the Director's request (the no-PR half only).

## Re-run after CW-9

Plugin `54415b1` (0.6.0 plus CW-9), harness `5f9153f`, large tier, label `cw9`. The runs differ in size from the "after" runs: Claude had 4 task PRs (the three tasks plus a STATUS bookkeeping PR, #60), Codex had 5 task PRs (#57, #58 and #59 are the three tasks; #62 is a records PR; **#64 is the fix PR**: the large-tier final review of the milestone PR #63 requested changes on head `5f43506` for a Unicode lowercasing bug in `slugify` (`Kelvin sign` and `dotted capital I` turn into ASCII letters), the Director sent task `-3` back, #64 ("Fix Unicode slugification") fixed it, and the final review ran again on #63 and approved head `7276c56`), plus an earlier changes-requested round on #59, with 91 turns. Totals are not directly comparable with the "after" runs; per task PR they are.

| | Claude after | Claude cw9 | Codex after | Codex cw9 |
|---|---|---|---|---|
| Task PRs | 3 | 4 | 3 | 5 |
| Director turns | 28 | 30 | 50 | 91 |
| Director context tokens | 1,858,016 | 2,101,339 | 3,115,461 | 5,877,903 |
| CI-related Director turns | 6 | 7 | 8 | 12 |
| CI-related context tokens (share) | 466,453 (25.1%) | 563,515 (26.8%) | 543,504 (17.4%) | 826,563 (14.1%) |
| CI turns on task PRs (tokens) | 4 (304,728) | 4 [5] (313,360 [392,468]) | 4 (255,974) | 5 (339,580) |
| CI turns on milestone PR (tokens) | 1 (83,026) | 1 (87,513) | 1 [2] (76,014 [150,000]) | 1 (81,656) |
| No-PR reconcile checkpoints (tokens) | 1 (78,699) | 2 [1] (162,642 [83,534]) | 3 [2] (211,516 [137,530]) | 6 (405,327) |
| No-PR unattributed CI reads (tokens) | 0 | 0 | 0 | 0 |
| CI turns per task PR | #36: 2, #37: 1, #38: 1 | #54: 1, #55: 1 [2], #56: 1 [2], #60: 1 | #39: 2, #40: 1, #41: 1 | #57: 1, #58: 1, #59: 1, #62: 1, #64: 1 |
| CI tokens per task PR | 101,576 | 78,340 | 85,325 | 67,916 |
| `--watch`, foreground / background | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Reviewer `ci` values | green 4 | green 5 | green 5 | green 9, pending 1 |
| Reported complete, relative to last check finishing | 37 s after | 35 s after | 65 s after | 64 s after |

Targets, per run:

| Target | Claude cw9 | Codex cw9 |
|---|---|---|
| No foreground `--watch` | PASS (0) | PASS (0) |
| At most one CI-related Director turn per task PR | PASS (#54: 1, #55: 1, #56: 1, #60: 1; 2 reconcile checkpoints not charged, 0 unattributed reads) (old parser: FAIL, #55: 2, #56: 2) | PASS (#57, #58, #59, #62, #64: 1 each; 6 reconcile checkpoints not charged, 0 unattributed reads) (old rule: FAIL, "11 CI turn(s) for 5 task PR(s)") |
| Reviewer `ci: pending` only on timeout | PASS (5 reviews, all green) | PASS under decision 0017 (1 pending of 10, a `changes_requested` review marked "not waited: changes requested"; FAIL under the harness as it was when the run was scored: see below) |
| Milestone not reported complete before its PR checks finished | PASS (35 s after) | PASS (64 s after) |

The first-PR step now fits in one turn on both tools. Claude cw9 turn 16 is `ci-wait.js --names 54; ci-wait.js 54 --once --sha ... && gh pr merge 54 ... && gh pr comment 54 ...`; Codex cw9 turn 25 is the same chain for #58 (its first merged PR). The Director wrote "Merging, with the one-time check-name readout added in front". Both runs got 1 CI turn on every task PR, including the first.

The six no-PR turns in Codex cw9 (turns 26, 33, 40, 47, 63, 83) are all `reconcile-logs.js --merges` checkpoints, several bundled with STATUS edits. That is more than the prompt requires (it asks for one at the end of a wave and one before the milestone PR). They cost 405,327 context tokens, 49% of Codex's CI tokens in that run. They are not a target miss, but they are the largest remaining CI-related spend, and at least two of them (turns 26 and 40) printed nothing, so nothing was queued. Worth a look in a later task.

### Codex cw9, "reviewer pending only on timeout or a marked blocking review": the documented blocking-review case (PASS with decision 0017)

The pending review is the first review of task `-3` (slugify), PR #59, head `d68bde5` (the first head of #59; the second round approved head `fe5d56c`, which is the one merged). The reviewer's `review-json` (in the Director transcript and in `reviews.jsonl`) says:

- `verdict: changes_requested`, `severity: major`, one blocking finding (`missing-tests`: no non-ASCII input test), `tests_passed: true`,
- `ci: pending`, `summary: "The suite passes, but the ASCII-only boundary lacks required coverage; CI was not waited: changes requested."`

What happened: the reviewer did not time out. It followed `agents/reviewer.md` ("Waiting for CI": for a blocking finding, don't do the full wait; run `ci-wait.js <n> --once --sha <head_sha>` once, and if it shows pending put "not waited: changes requested" in `summary`; and the `ci` field text: "The one other case is the blocking-finding single check above, marked 'not waited: changes requested'"). The Director sent #59 back (attempt 2), and the review of the fix reported green. So the reviewer behaved as written, and **the harness misread it**: `reviewStats` in `tests/live/ci-wait-lib.js` counts every `ci: pending` that does not state a wait of at least `TIMEOUT_MIN` minutes as a violation, and never looks at the verdict or at the documented exception.

Decision 0017 (`docs/decisions/0017-pending-on-blocking-reviews.md`) accepts this case, and CW-11 made the change. The target now reads "reviewer `ci: pending` only on a timeout or a marked blocking review". The first version of this report recommended the change as follows:

1. Harness, `tests/live/ci-wait-lib.js`, `reviewStats`: record the review's `verdict`, and in `evaluateTargets` do not count as a violation a pending whose verdict is `changes_requested` or `reject` and whose summary says it was not waited ("not waited" or "was not waited"). Show it in the detail line ("1 pending, not waited because changes were requested"). A pending on an approving review with no stated wait stays FAIL. This needs the same kind of decision as the no-PR rule: the spec target says "pending only on timeout", so the exception is real only if the spec accepts what `reviewer.md` already says. The director should decide that.
2. Prompt, `agents/reviewer.md` "Waiting for CI": the prescribed phrase is "not waited: changes requested" but the reviewer wrote "CI was not waited: changes requested". Tighten the wording of the rule, for example "put exactly `not waited: changes requested` at the start of `summary`", so a harness (or the Coach) can match it exactly.

Done in CW-11 (decision 0017):

- `agents/reviewer.md`: on a blocking verdict with the single `--once` check pending, `summary` must start with exactly `not waited: changes requested` (`not waited: rejected` for `reject`).
- `tests/live/ci-wait-lib.js`: `reviewStats` records each review's verdict, and `evaluateTargets` accepts `ci: pending` only when (a) the summary states a wait of 8 minutes or more, or (b) the verdict is `changes_requested` or `reject` and the summary starts with `not waited:` (case-insensitive). The legacy phrase "not waited: changes requested" anywhere in the summary also counts for a blocking verdict, which is how this saved run's "CI was not waited: changes requested" passes. An approve with pending and no stated wait still FAILs (unit tests pin this).

Recomputed on the saved run. `ci-recompute.js` passes empty reviews to `evaluateTargets`, so it does not evaluate this target; I read the ten `review-json` blocks from the Director transcript (the same data `reviews.jsonl` held) and ran `reviewStats` and `evaluateTargets` on them. Result: the one pending review has `verdict: changes_requested`, `blockingNotWaited: true`, and the target is **PASS** ("1 pending review(s): changes_requested, marked not waited"). `node tests/live/ci-recompute.js <transcript> --compare <report.json>` on the same run prints one difference, `ci-turns-per-task-pr`: FAIL in the report, PASS recomputed (the no-PR rule above), and no difference on the pending target because it does not check it.

## The notification stream (CW-6 review finding 2)

"Started by a background notification" was 0 in all six runs. Why, from the transcripts:

- **Codex:** the rollout has no background-completion events at all, and the Director ran nothing in the background. Codex has no background shell. 0 is expected.
- **Claude:** the stream has 19 `{"type":"system","subtype":"task_notification"}` events in the "after" run. None is a CI command. They are completions of background subagents (reviewers, implementers: `Agent` calls) and one backgrounded `gh issue create` script. No Claude Director call used `--watch`, a long `ci-wait.js --timeout`, or `Monitor`. No background CI watch was needed, because the reviewers had already waited for CI and every gate answered in under a second. So 0 is the correct answer for these runs.

Can the metric detect them? Not in this stream shape. The parser attaches a notification to the next turn only when a `{"type":"result"}` event was seen first (`idle` in `parseClaudeStream`). In these transcripts the notifications arrive in the middle of the run, between assistant turns, and the three `result` events all come at the end. The event order looks like `A U A N U A Nx2 A ...`, with no `result` before any notification. So none could ever be attached, CI or not. The link from a notification to its command (`tool_use_id`) is there and would work. The `idle` gate is what blocks it. This does not affect the CI turn counts (the turn that starts a background watch is counted when it runs), but a real background watch that finishes mid-run would not show up in "started by a background notification". Not fixed here (out of scope).

## Follow-ups (not done here)

1. Reviewer pending exception: done in CW-11 (decision 0017), see above.
2. Parser: attach a `task_notification` to the next turn even without a preceding `result` event, if its `tool_use_id` is a CI command, with a test using the mid-run order above.
3. A live run with a slow CI would be needed to see a non-zero "started by a background notification". None of the six runs covered that path.
4. Codex runs `reconcile-logs.js --merges` more often than the prompt asks (6 times in cw9, and at least two of them printed nothing). Done in CW-11 (decision 0017): the prompt now says to run it only when `STATUS.md` has a `queued` row.

## Limits of these runs

- **Never exercised live.** No run queued anything, so these paths were not run against a real forge: queueing with `--auto`, cancelling auto-merge, `reconcile-logs.js --merges` resolving a queued PR, the red and pending gate results, `ci-wait.js --queue-check` (added after the runs, decision 0018), and the Claude background wait (`run_in_background`). The reconcile checkpoints in the runs found nothing queued. Their behaviour rests on the unit and fake-CLI tests only.
- **Parser under-count gap that remains.** A PowerShell here-string run through `& $c`, through another variable, or through an alias (an interpreter the parser does not recognise) is treated as text, so a CI call inside it is not counted. The parser leans toward over-counting, but this shape under-counts.
- One run per cell is one sample; see the note at the top.
