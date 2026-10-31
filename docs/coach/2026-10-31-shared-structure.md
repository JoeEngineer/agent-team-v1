# Coach report — Milestone A `shared-structure` (2026-10-31)

Task COACH-20261031. Covers PR #27 / issue #6, released as v0.3.0.
Logs: the milestone archive folder (written by plugin 0.2.1).
Routing table compared: plugin 0.3.0 `skills/director/references/routing.md`.

## Summary

- **The routing worked well.** There were 12 tasks and 9 task PRs. No PR was rejected and only 1 was sent back (SS-8, docs). 5 of 5 sonnet implement-medium PRs passed review on the first try, with only minor findings. 3 of 3 haiku easy code PRs were approved clean.
- **No `routing.md` change is proposed.** Only one task type × difficulty × model group reaches the 5-task minimum (implement/medium on sonnet/medium), and its numbers support the current row. Every other group is "insufficient data".
- **The logger is the main problem, and 0.3.0 does not fix it.** Only 3 of 15 review verdicts were logged correctly, and 1 of 16 implementer results. Resumed attempts report cumulative tokens and time (one shows 9,854 s for a 29 s re-review). The logged history shows PR #24 merged over a `changes_requested`; the actual verdict on the reviewed commit was `approve`. The cause has been located in the code (see "Logger gaps").
- **Repeated reviewer findings point to a prompt fix, not a model change.** The two recurring problems were missing tests (5 findings across 3 of 5 sonnet PRs) and fixing one instance of a bug while leaving its siblings (the opus final review then found 3 such leftovers).

## Method and data quality

- **Scope.** 31 milestone delegation lines: 24 spawns and 7 `SendMessage` resumes, giving 31 attempts. Excluded: 3 `kind: session` lines with no task card. Those are one 0.2.0 guard-fix session, the Director session start, and one 0.3.0 Milestone B session.
- **All runs were Claude.** `tool` was absent in 0.2.1, but every `resolved_model` is `claude-*`. There were no Codex runs and no `tier_fallbacks.jsonl`. Tiers below are mapped from the model using the 0.3.0 default map: haiku = small, sonnet = medium, opus = large.
- **Ground truth came from the transcripts, not the logs.** The logged results, verdicts, tokens and durations are wrong in systematic ways (see "Logger gaps"). So I rebuilt every attempt from the subagent transcripts, read-only, in the session's `subagents/agent-<id>.jsonl` files. I split turns on each `TASK id=` prompt and took the last `SubagentHandback` per turn. Tokens are input + output + cache read + cache write, counted once per message id, so they match the logger's `tokens_with_cache` definition. I didn't need to check verdicts with `gh`, because the reviewers' own handbacks are in the transcripts.
- **No before/after comparison is possible.** Every milestone line is `guidance_version` 0.2.1.

## Per model / effort / task type (tool = claude)

| Group (model/effort · type/difficulty) | n | First-review outcome | Avg tokens | Avg duration | Total tokens |
|---|---|---|---|---|---|
| opus/high · breakdown/hard (SS-0) | 1 | — (12 tasks, 0 rejects downstream) | 875k | 366 s | 875k |
| sonnet/medium · implement/medium (SS-3..7) | **5** | 5× approve with minors, 0 send-backs | 242k | 117 s | 1,212k |
| sonnet/medium · fold-in fix/easy, warm resume | 4 | 4/4 re-review approved clean | 177k | 47 s | 706k |
| haiku/medium · implement/easy (SS-1, SS-2) | 2 | 2/2 approve, no findings | 564k | 172 s | 1,127k |
| haiku/medium · fix/easy (SS-11) | 1 | approve, no findings | 524k | 136 s | 524k |
| haiku/low · docs/medium (SS-8 a1) | 1 | **changes_requested (major)** | 216k | 82 s | 216k |
| haiku/medium · docs/medium (SS-8 a2, ladder step 2) | 1 | approve | 302k | 85 s | 302k |
| sonnet/low · test/medium (SS-9) | 1 | not reviewed (9/10 checks pass, 1 open) | 91k | 103 s | 91k |
| sonnet/high · review, first pass | 9 | 7 approve, 1 approve-minor-unfolded, 1 changes_requested | 84k | 71 s | 758k |
| sonnet/high · incremental re-review | 5 | 5/5 approve | 60k | 25 s | 302k |
| opus/high · milestone final review (SS-10) | 1 | approve, 7 minors | 1,330k | 322 s | 1,330k |
| **Milestone total** | 31 attempts | | | ≈ 2,976 agent-s | **7.44M** |

- **Cache reads dominate the token counts.** They are 90% of opus tokens, 88% of haiku and 83% of sonnet. So raw token counts overstate cost, and per-model prices aren't logged.
- **End-to-end cost per PR.** This is implement + review + fold-in + re-review. Haiku easy PRs came to 533k, 728k and 612k. Sonnet medium PRs came to 343k–661k. In raw tokens, the easy tasks on the small tier cost as much as the medium tasks on the medium tier. Haiku also took about 1.4× longer per task (160 s vs 117 s) and produced more output tokens (18.1k vs 13.8k on average).
- **Wall clock.** The milestone ran 11:58 → 15:41 (3 h 43 m), but subagents were active for only about 50 minutes. There was a 2 h 42 m idle gap between the SS-6 fold-in finishing (12:39:42) and its re-review (15:21:30). The logs don't say why; it may have been a pause or the user being away.

## Findings

### 1. implement/medium on sonnet/medium: keep (n = 5, medium confidence)
- **First-review results.** 5/5 were approved on the first review and none were sent back. But every PR had 1–4 minor findings, 13 in total: 2 correctness, 1 error-handling, 5 missing-tests, 3 design, 1 spec-mismatch and 1 docs.
- **Why not lower it.** Some of the minors were real bugs. The unanchored `spawn_agent$` regex misrouted MCP tools (SS-4), and a never-throws contract was broken (SS-3). Neither suggests a smaller model would do as well.
- **Why not raise it.** Nothing failed.
- **0.3.0:** the row is unchanged (now written as `medium`/`medium`).

### 2. Folding in minor findings is worth it, but `merging.md` contradicts what the Director did (n = 4, low–medium confidence)
- **Cost.** The 4 fold-in cycles (SS-3..6) cost 706k implementer tokens plus 244k reviewer tokens, 950k in total. That is 12.8% of milestone tokens. Each cycle took about 75 s (implementer 47 s, reviewer 28 s).
- **Result.** The fold-ins fixed 13 findings and all 4 re-reviews approved clean. That works out to about 73k tokens per finding fixed.
- **Comparison with a follow-up task.** SS-11 was a separate fresh-haiku task with its own issue and PR, for SS-10's 7 minors. It cost 612k, about 87k per finding.
- **The contradiction.** `merging.md` says "Follow-up task only for findings that need real work: missing tests…". Yet the Director folded missing-tests findings into SS-3, SS-4 and SS-6, and it worked. The rule and its "touches only this PR's own files" condition conflict.
- **0.3.0:** `merging.md` is identical to 0.2.1, so this is not addressed.

### 3. Implementers and reviewers fix one instance, not the whole class of bug (low confidence; guidance fix)
- **Leftovers the final review caught.** The opus final review (SS-10) found 7 minors. Three were leftovers from per-PR work:
  - Unanchored matchers in `hooks.json` and `codex-log`. SS-4's fold-in had anchored only `lib.js`.
  - A stale "inherited" comment in `log-delegation.js` (SS-6).
  - Unused ladder/fallback helpers in `models.js` (SS-3).
- **Stale wording after the rename.** A further 3 were stale "model/effort" wording left after the tier rename (SS-7 scope).
- **The cost of catching them late.** SS-10 plus SS-11 plus their review cost 1.94M tokens, 26% of the milestone, for 7 minors and 0 majors.
- **Missing tests recur despite existing guidance.** The "Tests that prove something" section was already in the 0.2.1 implementer prompt. It was unchanged in 0.3.0 apart from the `tier` header. Missing tests still recurred: 5 findings in 3 of 5 sonnet PRs. One of them (SS-6, "broken-override test cannot distinguish fallback from failure") is exactly the "assert the precondition" rule. The other gaps were paths not covered at all: new CLI flags, new record fields, and resume/session branches.

### 4. docs on haiku/low: insufficient data (n = 1)
- **What happened.** SS-8 (README + 0.3.0 bump, marked medium difficulty) failed with a major spec-mismatch: it overstated Codex hook support against `codex-mapping.md`'s "Still open" section. The implementer's own handback had noticed related issues ("did not check them against the log scripts"; "'Before you install' … also applies to Codex. I left its wording alone") and left them. It also returned no `result-json` block.
- **Recovery.** Ladder step 2 (haiku, effort raised to medium) passed on the next review.
- **The send-back cost.** 109k tokens for the failed review cycle, plus a fresh 302k attempt.
- **Next step.** Don't change the docs row on one task. Watch docs tasks that make claims about behaviour; a candidate diff is below.

### 5. Milestone final review on opus/high: insufficient data (n = 1)
It was the biggest single cost: 1.33M tokens, 18% of the milestone. It found 0 majors and 7 minors. Most of those were cross-PR consistency issues that a per-PR reviewer can't see, so this review has some value. Revisit once there are 5 milestones: if final reviews keep finding only minors, try large/medium effort.

### 6. The reviewer looks consistent (low confidence)
- **Severity use.** The sonnet/high reviewer used `major` once (SS-8, correctly blocking). It marked everything else minor and non-blocking. I found no approve/reject flip on the same kind of issue.
- **Re-reviews stay cheap.** Re-reviews (60k, 25 s each) are only 4% of tokens, so lowering their effort isn't worth doing.
- **No major missed.** The opus final review found no blocking issue that a per-PR review had missed.

### 7. Other groups: insufficient data
breakdown on opus/high (n = 1; the breakdown held up with 0 rejects and 1 send-back), test on sonnet/low (n = 1), fix/easy on haiku/medium (n = 1), and implement/easy on haiku/medium (n = 2). Haiku's raw token counts are high, and this is worth tracking once priced cost is available.

## Logger gaps (present in 0.3.0, `scripts/log-delegation.js` unchanged apart from tier fields)

The table compares what was logged with what the transcripts show.

| Signal | Logged correctly | Detail |
|---|---|---|
| Review verdicts (15 attempts) | **3** | 9 missing. 3 mislabeled: SS-4/SS-6/SS-8-review attempt 2 lines contain the attempt-1 verdict. SS-8's line says `changes_requested`, but the real attempt-2 verdict was `approve`, so the log shows PR #24 merged over a rejection. |
| Implementer/architect/test results (16 attempts) | **1** (SS-8 a2, via `hook-input`) | The SS-3/4/5/6 attempt-2 `result` fields are the attempt-1 reports. |
| Completion lines | 30 of 31 | SS-5-review a2 is missing, dropped as a "duplicate". |
| Tokens, first attempts | low by 0–33% | The final message is missing, e.g. SS-6-review 70k logged vs 104k true. |
| Tokens and duration, resumed attempts | cumulative from the original spawn | SS-3 a2: 483k logged vs 286k true. SS-6-review a2: 9,854 s logged vs 29 s true. Logged durations sum to 13,586 s; the true total is 2,976 s. |

**Root causes**, confirmed against `agent-af74b939d793f1766.jsonl`. The logged a1 figure (81,065) equals the true total (108,303) minus the final message (27,238). The logged a2 figure (136,158) equals the cumulative total minus the final message.

1. **The turn reset never fires on a real resume.** `readSubagentTranscript` starts a new turn only for `type: user && !isMeta && !tool_results`. In Claude Code 2.1.314, a `SendMessage` resume is written with **`isMeta: true`** and starts with "The coordinator sent a message while you were working: … TASK id=…". The tests (`tests/hooks.test.js` around lines 294–336) write the resume as a plain user entry, so they pass while production fails.
2. **The transcript lags.** The final message (the `SubagentHandback` call) is usually not in the file yet when `SubagentStop` runs. `last_assistant_message` was present only once. The "hook fires again after catching up" behaviour never happened here.
3. **The dedupe key ignores the attempt.** `claimOnce('stop-<agent>-<hash(report)>')` uses only the agent and report. When the report is stale, attempt 2 hashes the same as attempt 1 and is dropped.
4. **The review record takes its attempt number from the latest delegation,** so a stale verdict is stamped with the new attempt number.

**Other gaps:**
- Token classes aren't split out, so cost can't be priced.
- Pauses and waits aren't logged.
- `merging.md` gate 1 ("approve … logged in reviews.jsonl") can't be checked against these logs.

## Proposed changes (propose only; not applied)

### routing.md — no change

No group other than implement/medium on sonnet/medium has 5 or more tasks, and that group supports the current row. For reference only, this is the candidate to test **if** the next 4 or more docs tasks repeat SS-8's pattern. **Do not apply now (n = 1):**

```diff
-| docs | any | implementer | small | low | subagent (worktree) |
+| docs | easy | implementer | small | low | subagent (worktree) |
+| docs | medium | implementer | small | medium | subagent (worktree) |
```

### Logger (plugin PR; highest value)

```diff
 // scripts/log-delegation.js, readSubagentTranscript
-    if (e.type === 'user' && !e.isMeta && !isToolResults(m.content)) {
+    const ut = e.type === 'user' && !isToolResults(m.content) ? lib.responseText(m.content) : '';
+    // SendMessage resumes arrive as isMeta "The coordinator sent a message…" entries.
+    if (ut && (!e.isMeta || /\bTASK id=/.test(ut))) {
+      out.turn = (out.turn || 0) + 1;
```

```diff
-  if (agentId && !claimOnce(input, `stop-${agentId}-${shortHash(report || t.lastId || t.last || 'none')}`)) return;
+  if (agentId && !claimOnce(input, `stop-${agentId}-t${t.turn || 1}-${shortHash(report || t.lastId || t.last || 'none')}`)) return;
```

- **A test fixture with the real resume shape.** It should write `isMeta: true` and the "The coordinator sent a message while you were working:" prefix.
- **Backfill at merge time.** In `onPostShell`, for `gh pr merge`, re-read the transcripts of agents whose latest completion has `result`/`review` null. Then append corrected lines with `report_source: "backfill"`. By merge time, every transcript in this milestone had caught up.
- **Split tokens by class** (input, output, cache_read, cache_write) on completion lines.
- **`coach.md`:** until the fix ships, replace the "since 0.2.0 … can be summed across attempts" note with "resumed lines are cumulative; do not sum".

### merging.md (fold-in rule)

```diff
-- **Follow-up task** only for findings that need real work: missing tests, behaviour changes, or another area of the code.
+- Missing tests for this PR's own code, in its own test files, count as **fold in**.
+- **Follow-up task** only for findings that need real work: behaviour changes, or another area of the code.
```

### Agent guidance

```diff
 # agents/implementer.md, after "Add or update tests…"
+- Every new branch, CLI flag, record field or error path gets a test. A test must fail, not skip, when its setup is missing; pin expected literals instead of diffing against a git ref.
+- When you fix a pattern bug (an unanchored regex, stale wording after a rename), grep for every other instance and fix those in scope; list the rest in `follow_up`.
+- If you notice an in-scope inaccuracy, fix it rather than noting it.
```

```diff
 # agents/reviewer.md
+- When a finding is an instance of a pattern, say so and list the other locations you found (grep), so the fold-in fixes the class.
```

## Recommendations

| # | Recommendation | Evidence | Confidence |
|---|---|---|---|
| 1 | Fix the completion logger: turn reset on `isMeta` resumes, attempt in the dedupe key, backfill at merge, real-shape test. | 3/15 verdicts and 1/16 results logged correctly; resumed durations up to 340× too high; a false `changes_requested` before the PR #24 merge. | High |
| 2 | Keep implement/medium on sonnet/medium. | n = 5; 5/5 passed first review; 242k tokens and 117 s on average. | Medium |
| 3 | Clarify `merging.md` so own-file missing tests are folded in. | 4/4 fold-ins approved clean; 73k tokens per finding vs 87k for a follow-up task. | Low–medium |
| 4 | Implementer/reviewer guidance: fix the whole class; test every new path. | 5 missing-tests findings in 3 of 5 PRs; 3 of SS-10's 7 minors were leftover siblings; the late-catch loop cost 1.94M tokens. | Low |
| 5 | Log token classes and pauses; price cost before judging haiku vs sonnet. | Cache reads are 83–90% of tokens; haiku easy PRs cost 533–728k raw vs 343–661k for sonnet medium. | Medium (logging); insufficient data (routing) |
| 6 | Watch docs on haiku/low, the opus final review, and haiku implement/easy. | n = 1, 1 and 2. | Insufficient data |

```result-json
{"status": "done", "summary": "Shared-structure routing held up (one send-back in 9 PRs; implement/medium at sonnet/medium 5/5 first-pass) so no routing.md change is proposed, but the 0.2.1/0.3.0 completion logger mis-records most verdicts, results and resumed-attempt costs and needs fixing first.", "tasks_analyzed": 31, "recommendations": 6, "report": "docs/coach/2026-10-31-shared-structure.md"}
```
