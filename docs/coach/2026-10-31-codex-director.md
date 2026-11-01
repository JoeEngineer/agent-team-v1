# Coach report: Milestone B `codex-director` (2026-10-31)

Task COACH-20261031 (attempt 1). Covers issue #28, task PRs #47–#69, milestone PR #70 (released as 0.4.0).
Logs: the milestone archive folder. The run used plugin 0.3.0; `reconcile-logs.js` from 0.4.0 backfilled the logs at close.
Routing table compared: plugin 0.4.0 `skills/director/references/routing.md`. Its rows match 0.3.0; only the ladder and fallback wording changed.

## Summary

- **The routing table held up again, so no row changes are proposed.**
  - implement/medium on sonnet/medium passed its first review on 6 of 7 tasks (11 of 12 across both milestones).
  - The ladder's "raise effort" step fixed all 3 major send-backs on the next try (CD-13, CD-14, CD-16).
- **The Director did not always apply the route it wrote down.**
  - CD-3 and CD-9 (implement/easy) were spawned without `model`, so they ran on **sonnet**. Their WHY, task card (`tier=small`) and STATUS.md all say haiku.
  - CD-1 (test) was spawned without `effort`, so it ran at **medium** although it was recorded as low.
  - That is 3 of 3 wave-1 spawns whose route differed from the agent default. Later spawns passed both values explicitly.
  - Proposed fix: always pass `model` and `effort`, and have the logger flag a tier mismatch.
- **One cause is behind most rework: command examples were never run as written, especially in PowerShell.** It produced 5 findings across 4 PRs, and caused CD-14's escalation to a third attempt. Reviewers rated the same failure as major/blocking twice and as minor once. This calls for a guidance fix, not a bigger model.
- **The logs are still unreliable, and part of the cause is new.**
  - The 0.3.0 hook recorded 2 of 30 reviewer turns correctly and 2 of 33 implementer turns. Milestone A's fixes shipped in 0.4.0 and were not installed during the run.
  - The 0.4.0 backfill raised this to 21/30 and 27/33. But **all 4 `changes_requested` verdicts are still stamped one attempt late**, because the backfill dedupes against the stale lines.
  - The backfill also stamps `guidance_version: 0.4.0` on runs that used 0.3.0, which corrupts before/after comparisons.
- **Previous Coach recommendations were all implemented in this milestone** (CF-1 → CD-21, CD-5, CD-6, CD-15). None were live during it, so this milestone is the "before" baseline, and the same problems recurred as expected.

## How records were attributed to this run

The archive README counts 0 milestone-tagged reviews, merges, notes and escalations, because those record types have no `milestone` field. I attributed records as follows:

| Record | Rule | Count |
|---|---|---|
| Delegations | Director session `ffe39f64…` (worktree `milestone-b-director-50d7da`), task ids `CD-*`, `milestone: codex-director` | 45 spawns + 15 resumes = 60 |
| Completions | Same session; `CD-*` | 59 hook lines (0.3.0) + 42 reconcile lines (stamped 0.4.0) |
| Reviews | `task_id` `CD-*`, linked by `agent_id` to CD delegations | 9 hook + 18 reconcile |
| Merges | Session `ffe39f64`, PRs #47–#69 | 19 (#52, #57, #65 and #68 are not task PRs: #52 was closed, the others are issues) |
| Notes, escalations | Task `CD-*`, timestamps 19:55–22:04 | 19 notes, 3 escalations |
| **coach-a-fixes (CF-1, CF-1-review)** | A separate session (`5a8cb589`, the user's main session) running in parallel 19:50–20:05. PR #52 was never merged; its content entered the milestone through CD-21 (#61). | 4 delegations, 5 completions, 2 reviews. **Reported separately; not in milestone totals.** |
| Excluded | All `SS-*` lines (Milestone A), including the 9 SS reviews and 19 SS completions the 0.4.0 backfill re-wrote; `kind: session` lines; the Milestone A coach run | |

- **Ground truth.** As in Milestone A, I rebuilt every turn from the subagent transcripts in the session's `subagents/agent-<id>.jsonl` files, read-only. I split turns on each `TASK id=` prompt, including `isMeta` "coordinator sent a message" resumes, and took the last `SubagentHandback` per turn. Usage is counted once per message id.
  - This gives 59 turns for 24 CD tasks. The 0.4.0 reconcile lines match these per-turn token counts exactly where they exist.
  - The Director's Agent and SendMessage calls came from the Director transcript.
- **Tools.** Every subagent run was Claude (`tool: claude`); there are no `tool: codex` records. The Codex runs inside CD-1, CD-16 and CD-19 logged into throwaway test projects. So there is no cross-tool comparison.
- **Cost.** No prices are logged. The dollar figures below are **estimates** using 4.5-generation list-price ratios: haiku $1/$5, sonnet $3/$15 and opus $5/$25 per M input/output; cache read at 0.1× input and cache write at 1.25× input. Use them for comparison, not for billing.
- **Guidance version.** Every CD run used 0.3.0 guidance. The `0.4.0` stamp on reconcile lines is the backfill tool's version, not the version that ran (see "Logging gaps").

## Milestone at a glance (A vs B)

| | A `shared-structure` | B `codex-director` |
|---|---|---|
| Tasks / agent turns | 12 / 31 | 24 / 59 |
| Tokens (incl. cache) | 7.44M | 29.26M (cache read 90%) |
| Estimated cost | not priced | ≈ $27.3: sonnet $17.7, opus $8.2, haiku $1.3 |
| Agent-seconds | 2,976 | 11,964 |
| Wall clock (active) | ≈ 3 h 43 m incl. 2 h 42 m idle | 19:24 → 22:05, incl. a 45 m wait for a user decision. Intake also waited 133 m for the user's answers. |
| Per-PR first reviews sent back | 1 of 9 | 2 of 18 (CD-13, CD-16); 1 more after a fold-in (CD-14) |
| Final review | 0 majors, 7 minors | 1 major (log policy contradicted itself across PRs), 8 minors |

**Where the money went.** Opus was 2 of 24 tasks but about 30% of estimated cost: CD-20 final review $4.93 and CD-0 breakdown $3.27. Rework (send-backs, fold-ins, re-reviews) was about $3.0, or 11%.

## Per model / effort / task type (tool = claude, B only)

The "as ran" column is the model and effort the agent actually used, which is not always what was logged as intended. "1st review" counts per-PR first reviews only.

| Group (as ran) | n | 1st review | Avg tokens | Avg est. $ | Avg s | Notes |
|---|---|---|---|---|---|---|
| sonnet/medium · implement/medium | 7 | 6 approve (2 clean, 4 minor), 1 CR-major (CD-13) | 449k | 0.48 | 193 | CD-7 includes a 'blocked' turn (file clash with CD-10). CF-1 (separate session) also approved with minors. |
| sonnet/high · implement/hard (CD-11, session→subagent fallback) | 1 | approve minor | 2.10M | 1.64 | 679 | |
| sonnet/medium · implement/easy (CD-3, CD-9) **routed small, ran medium** | 2 | 2 approve (1 clean) | 91k | 0.10 | 65 | |
| haiku/medium · implement/easy (CD-12, CD-22) | 2 | 2 approve minor | 822k | 0.25 | 292 | CD-22 reported `partial`; it used 1.36M tokens and needed a fold-in. |
| haiku/low · docs/easy (CD-15, 17, 18) | 3 | 3 approve minor | 531k | 0.22 | 190 | CD-17 had 5 minors (1 spec-mismatch) and needed a fold-in. |
| sonnet/medium · fix/medium (CD-5, 21, 23) | 3 | 3 approve minor | 998k | 0.74 | 270 | CD-23 was reviewed by the final reviewer. |
| sonnet/low · test/medium (CD-16, CD-19) + CD-1 **ran at medium** | 3 | CD-16 CR-major; CD-1 and CD-19 no PR | 1.26M | 0.90 | 848 | CD-16 ships code (a harness) |
| sonnet/medium · research/hard (CD-2) | 1 | — | 815k | 0.71 | 184 | Its diagnosis made CD-5 pass on the first try. |
| opus/high · breakdown (CD-0) | 1 | — | 903k | 3.27 | 635 | 21 planned tasks; 3 added later (CD-21, 22, 23) |
| sonnet/high · per-PR first review | 18 | 16 approve, 2 CR | 227k | 0.26 | 138 | |
| sonnet/high · re-review | 7 | 5 approve, 1 CR (CD-14 a2), 1 re-ask | 142k | 0.12 | 70 | |
| opus/high · milestone final review (3 turns) | 1 task | CR-major → approve → approve | 1.46M/turn | 1.64/turn | 196 | a1 cost $3.15. Re-reviewing the fix PR on opus cost $1.78. |

## Findings

### 1. implement/medium on sonnet/medium: keep (n = 7 here, 12 across A+B; medium–high confidence)
- **First-review pass rate.** 6 of 7 tasks passed their first review here, and 11 of 12 across both milestones (12 of 13 with CF-1).
- **The one send-back.** CD-13 (archive-logs) failed with a real data-loss bug: `--force` deleted the old archive before the copy was checked. Raising effort to high fixed it on the next try for 379k tokens ($0.48).
- **Why not lower.** Two real correctness findings show up among the minors (CD-8 frontmatter unescaping, CD-6 dedupe), so moving down to small isn't supported.
- **Why not raise.** One failure in 12 doesn't justify the cost.

### 2. The route in the task card wasn't applied on 3 wave-1 spawns (high confidence; process fix)
- **What happened.** `routing.md` says to pass `model`/`effort` only when the row differs from the agent file. The implementer's file default is medium/medium.
  - CD-3 and CD-9 (implement/easy → small) were spawned with neither `model` nor `effort`, so they ran on sonnet.
  - CD-1 (test → medium/low) was spawned without `effort`, so it ran at medium.
- **Where the wrong route was written down.** The WHY, the card's `tier=small`, STATUS.md (`small (haiku) / medium`) and the Director's notes all record the intended route, not the one that ran.
- **What the logs show.** The delegation lines show `task.tier: small` next to `tier: medium`, so the mismatch was visible but nothing flagged it.
- **The Director corrected itself.** All 12 later spawns that needed an override passed it explicitly (CD-13 a2 at 19:59 onward). But the misreport stayed in STATUS.md through close.
- **An accidental trial.** It ran sonnet on implement/easy: CD-3 and CD-9 averaged 91k tokens, $0.10 and 65 s, and both passed. See finding 6.

### 3. Command examples were never run as written (medium confidence; guidance fix for implementer and reviewer)
- **Where it showed up.**
  - CD-14-R a1, minor: no PowerShell note.
  - CD-14-R a2, two **major blocking** findings: the fold-in added a raw newline inside JSON, and used `\"` quoting that breaks in PowerShell 5.1.
  - CD-22-R a1, minor: the `tier_fallback` argv example "fails in Windows PowerShell 5.1 … the fallback line would be lost".
  - CD-20 a1, minor: the harness uses the quoted-argument form that `codex.md` warns against, a possible cause of the CD-19 flake.
  - The Director had to add a whole task (CD-22) to fix this class of problem.
- **Cost.** CD-14's rework (the fold-in that introduced the bug, plus re-review, attempt 3 and re-review) cost 1.11M tokens, about $0.88. That makes it the most expensive rework loop in the milestone.
- **Severity was inconsistent.** "A documented command fails when pasted, and a log line is silently lost" was rated major/blocking in CD-14-R a2 but minor/non-blocking in CD-22-R a1.
- **A bigger model wouldn't help.** The CD-14 fold-in that broke ran on sonnet; the implementers simply didn't run the commands.

### 4. Leftovers that only the final review catches recurred, as expected (low confidence)
- **The guidance wasn't live.** The 0.4.0 guidance ("grep for every other instance", "every new branch gets a test") was not in effect, so B is the baseline.
- **Missing tests.** Missing-tests findings appeared in 5 of 18 per-PR first reviews (28%). In A it was 3 of 9 PRs (33%).
- **Final-review findings.** 4 of the 9 were sibling leftovers or cross-PR issues:
  - `routing.md:51` kept `--tool claude` after CD-3 made its other lines `--tool <t>`.
  - The `git add -A` warning names only the Claude worktree path.
  - The harness uses the argv form.
  - The log-policy contradiction spread across the template, team-init and the Director skill (the major).
- **Next milestone.** Re-measure both rates against 0.4.0.

### 5. The escalation ladder and fold-ins worked (n = 3 ladder steps, 5 fold-ins; medium confidence)
- **Ladder step 2.** "Raise effort one step" on a first major went 3 of 3: CD-13 (medium→high), CD-14 (medium→high), CD-16 (low→medium). Each passed its next review. No tier escalation was needed.
- **Fold-ins.** 4 of 5 were approved on re-review: CF-1, CD-17, CD-22, CD-23. CD-14's broke (finding 3).
  - Fold-in turns averaged 378k tokens but only about $0.10 each, because they are 90%+ cache reads on a warm agent.
  - For example, haiku used 563k tokens to fold in 5 doc nits on CD-17, for about $0.09.
  - Raw tokens overstate the cost of folding in, so keep folding in.

### 6. implement/easy and docs on haiku: insufficient data, but there's a signal worth watching
- **implement/easy, both milestones.**
  - Haiku: n = 4 (SS-1, SS-2, CD-12, CD-22), 4 of 4 approved at first review.
  - Sonnet: n = 2 (CD-3, CD-9), 2 of 2 approved.
  - Cost per first attempt in B: haiku 822k tokens / ≈$0.25 / 292 s against sonnet 91k / ≈$0.10 / 65 s. The tasks weren't equal: CD-22 was larger than CD-3 and CD-9.
  - Even at haiku's lower price, it was not cheaper per task here, and it was 4.5× slower.
  - n = 2 for sonnet is below the minimum, so **no change**. The candidate diff below is for reference only.
- **docs on haiku/low.** n = 4 across both milestones: 3 easy tasks approved, and SS-8 (medium) sent back. That's below the minimum, so the A-report candidate (medium-effort docs/medium) stays unproven.

### 7. The final review on opus/high is worth keeping (n = 2; insufficient data for a change)
- **What it found.** A: 0 majors. B: 1 real major that no per-PR reviewer could see (the log policy contradicted itself across 3 PRs; the user decided it).
- **Cost.** a1 cost $3.15. Re-reviewing CD-23's fix PR on the resumed opus agent cost $1.57 + $0.21. A sonnet/high per-PR review averages $0.26.
- **The ambiguity.** It's unclear whether the "milestone final" row covers re-reviewing its own fix PR. Watch this; n = 1.

### 8. Reviewer consistency (low–medium confidence)
- **Send-backs were justified.** Both per-PR CRs were real: data loss in CD-13, and a harness exit code that contradicted its spec in CD-16. I found no approve/reject flip on the same issue except the PowerShell severity split (finding 3).
- **One missing block.** CD-22-R's first report had no `review-json` and needed a re-ask (24k tokens). A similar thing happened in A (SS-8 had no `result-json`).
- **No CI.** `ci: "none"` on every review; the repo has no CI. CD-17-R a2 reported `tests_passed: false` because, on a docs-only diff, it didn't run the tests. That's fine, but the field reads as a failure.

### 9. Smaller observations (n = 1 each; watch)
- **Parallel tasks touching the same file.** CD-7 and CD-10 both touched `tests/tools.test.js`. CD-7 returned `blocked` after an $0.86 turn and resumed after CD-10 merged. The breakdown lists files per task; the Director could avoid running clashing tasks in the same wave.
- **The test row.** CD-16 ("live test harness") ships code in a PR, which is closer to implement/medium than to a test run. It failed at low effort. The other three test tasks (SS-9, CD-1, CD-19) were verification runs with no PR.
- **A spawn blocked by permissions.** One spawn (CD-16) was denied by the auto-mode classifier for a trust-bypass flag in its card, and was re-issued without it.

## Were the Milestone A recommendations followed?

| A recommendation | Status | Did the problem recur in B? |
|---|---|---|
| 1. Fix the completion logger (isMeta resume, attempt in dedupe key, backfill, real-shape test) | **Done** in CF-1 (#52) → CD-21 (#61), CD-5 (#54) and CD-6 (#56). Ships in 0.4.0. | **Yes**, because 0.3.0 was installed: 2 of 30 verdict turns were right from the hook. The 0.4.0 backfill partly repaired this but added new gaps (see "Logging gaps"). |
| 2. Keep implement/medium on sonnet/medium | Followed | 6 of 7 passed first review |
| 3. Clarify `merging.md` so own-file missing tests are folded in | **Done**, in the 0.4.0 `merging.md` | The Director already folded in (5 fold-ins; 4 OK) |
| 4. Implementer/reviewer: fix the whole class; test every new path | **Done**, in 0.4.0 `implementer.md` and `reviewer.md` | Yes (finding 4), but not live; B is the baseline |
| 5. Log token classes and pauses | Token classes **done** (`tokens_by_class` on reconcile lines). Pauses **not done**. | User waits of 133 m and 45 m are unlogged |
| 6. Watch docs on haiku/low, the opus final review, and haiku implement/easy | Watched | Each now n = 2–4; still insufficient |

## Logging gaps

| Gap | Evidence | Impact |
|---|---|---|
| **G1. The backfill can't fix mislabelled lines.** `reconcile-logs.js` skips a turn whose result or review matches *any* existing line. But the 0.3.0 hook wrote turn *n*'s report under attempt *n+1*, so the true turn matches the stale line and is skipped. | After reconcile: 8 of 30 reviewer turns are mislabelled. These include **all 4 `changes_requested`** (CD-13-R a1, CD-14-R a2, CD-16-R a1, CD-20 a1), each stamped one attempt late. 6 of 33 implementer turns are still wrong, and CD-22 has no correct line at all. | First-review pass rates computed from `reviews.jsonl` are wrong. For example, CD-13 shows as "approve, then CR on a2". |
| **G2. The backfill stamps its own `guidance_version`.** | 63 lines say 0.4.0 for runs on 0.3.0 (B) and 0.2.1 (A) | Breaks "before/after guidance change" comparisons, which are the Coach's main use |
| G3. No warning when the requested tier differs from the tier that ran | CD-3, CD-9: `task.tier: small` but `tier: medium`. CD-1 effort is not recorded on the card at all. | Silent routing deviations; STATUS.md misreports |
| G4. No `milestone` on reviews, merges, notes and escalations | Archive README shows 0 for each | Attribution relies on session, id prefix and timestamps |
| G5. Two lines for one attempt that disagree | CD-22 a2: `hook-input` says `done`, `handback` says `partial`; both are cumulative 1.93M | "Last line wins" picks `partial`, which is the stale a1 report |
| G6. Pauses and user waits are not logged | 133 m intake, 45 m final-review question; 5 runway checks appear only in the transcript | Wall-clock and capacity analysis need the transcript |
| G7. Hook token counts on first attempts are low | 5–16% under (e.g. CD-0: 757k logged vs 903k true) | Fixed by reconcile when it runs. The 0.4.0 retry may fix it at the source; check this in C. |
| G8. Escalation lines are inconsistent | CD-13's line has no `attempt`; none have `milestone`; CD-20 → CD-23 is a follow-up task, not an escalation, so it isn't there | Minor |

**How the Coach should read these logs until G1 and G2 are fixed:** prefer transcripts. Otherwise, for any agent with resumes, treat 0.3.0-and-earlier hook lines as unreliable, and take `report_source: "reconcile"` lines as correct only for the attempt they name.

## Proposed changes (propose only; not applied)

### routing.md: no row changes; one wording change (finding 2)

```diff
-Plugin agents are addressed as `agent-team:<name>` (e.g. `subagent_type: "agent-team:implementer"`). The agent's file sets its default tier and effort (and, on Claude, the matching `model:` header); only pass `model`/`effort` when this table says something different from the default. See "Tiers and models" below.
+Plugin agents are addressed as `agent-team:<name>` (e.g. `subagent_type: "agent-team:implementer"`). The agent's file sets a default tier and effort, but **always pass `model` (from `models.js resolve <tier> --tool <t>`) and `effort` from this table on every spawn**, even when they match the default. The task card's `tier=` and `WHY` are not applied by themselves. See "Tiers and models" below.
```

Evidence: 3 of 3 wave-1 spawns that needed an override ran on the default instead (CD-1, CD-3, CD-9); 12 of 12 later spawns that needed an override passed it and ran as routed.

Reference only. **Do not apply** (implement/easy on sonnet: n = 2). Revisit if the next milestone has 5 or more implement/easy tasks on each model:
```diff
-| implement | easy | implementer | small | medium | subagent (worktree) |
+| implement | easy | implementer | medium | medium | subagent (worktree) |
```

### Logger (plugin PR; highest value)

1. **G1, G2.** In `reconcile-logs.js`, only trust a content match on the same attempt, and keep the run's version.
   This is a sketch; the attempt comes from the turn's TASK line, or from `taskDel`.
   ```diff
   -      if (known.some((k) => sameContent(k, probe))) continue;
   +      const att = String(t.attempt || (taskDel && taskDel.task && taskDel.task.attempt) || '');
   +      const kAtt = (k) => String((k.task && k.task.attempt) || k.attempt || '');
   +      if (known.some((k) => sameContent(k, probe) && kAtt(k) === att)) continue;
   ...
   -      const record = completionRecord(sess, { … });
   +      const record = completionRecord(sess, { … });
   +      record.guidance_version = (taskDel && taskDel.guidance_version) || record.guidance_version;
   +      record.reconciled_by = lib.pluginVersion();
   ```
   (`taskDel` has to be computed before the `known` check.)
   - Also write `stale_of: <attempt>` to a review or completion line whose content belongs to an earlier turn, so readers can drop it. Or have reconcile emit one authoritative line per turn and have `coach.md` prefer those.
   - Add a test fixture: a 3-turn reviewer with hook lines shifted by one attempt (the CD-20 shape). After reconcile, each attempt must have exactly one verdict and it must be the right one.
2. **G3.** In the delegation hook, when the card's `tier=` differs from the resolved tier, add `tier_mismatch: {card, ran}` to the line and return `additionalContext` "agent-team: task card says tier X but the spawn ran tier Y". Optionally add an `effort=` key to the card so effort can be checked too.
3. **G4.** Copy `milestone` from the linked delegation's task card onto review, escalation and note lines. On merge lines, use the PR's base branch `milestone/<name>`.
4. **G6.** Add `log-event.js pause '{"reason":"user"|"runway","until":…}'` and call it from the Director skill before an `AskUserQuestion` or a runway wait.

### Agent guidance (finding 3)

```diff
 # agents/implementer.md, under the testing rules
+- Every command example you add or change in docs or skills: run it exactly as written, in each shell the doc names (sh, and PowerShell 5.1 when the doc mentions Windows or PowerShell). Say in your report which ones you ran. JSON passed as an argument must survive the shell; prefer the stdin form.
```
```diff
 # agents/reviewer.md
+- A documented command that fails when pasted as written is `major` and blocking when the failure loses data or a log record silently; otherwise `minor`. Run at least one such example yourself when the diff adds them.
```

### Director skill (finding 2, finding 9; low cost)
- After each spawn, compare the delegation line's `tier` with the card. Write STATUS.md's "Tier (model) / effort" column from the logged `resolved_model`/`effort`, not from the plan.
- Don't put tasks that edit the same file in the same wave unless the breakdown says how they split it (CD-7/CD-10; n = 1, advisory).

### coach.md (until G1/G2 ship)
```diff
+- Archives reconciled by 0.4.0 `reconcile-logs.js`: its lines carry the reconcile tool's `guidance_version`, not the run's; take the version from the linked delegation line. For resumed agents, 0.3.0 hook review/completion lines may hold the previous turn's report; when a reconcile line exists for the same agent and attempt, it wins, and a hook line whose content matches a different attempt's reconcile line is stale.
```

## Recommendations

| # | Recommendation | Evidence | Confidence |
|---|---|---|---|
| 1 | Fix `reconcile-logs.js`: same-attempt dedupe, keep the run's `guidance_version`, mark stale lines; add a 3-turn fixture | After reconcile: 8/30 verdict turns and 6/33 results still wrong, including all 4 `changes_requested`; 63 lines carry the wrong version | High |
| 2 | Always pass `model` and `effort` on spawns (routing.md wording), and flag `tier_mismatch` in the delegation hook | CD-1, CD-3, CD-9 ran off-route; STATUS.md misreported 2 tiers | High |
| 3 | Implementer runs every command example as written in each documented shell; reviewer rates silent-loss paste failures as major consistently | 5 findings in 4 PRs; CD-14's 3-attempt loop (1.11M tokens, ≈$0.88); CD-22 created for this class; severity split major ×2 / minor ×1 | Medium |
| 4 | Keep implement/medium on sonnet/medium and keep the effort-first ladder | 11/12 first-pass across A+B; ladder step 2 fixed 3/3 majors | Medium–high |
| 5 | Add `milestone` to reviews/merges/notes/escalations, and log pauses | README showed 0 for 4 files; 178 min of user waits were unlogged | Medium |
| 6 | Re-measure missing-tests and sibling-leftover rates in Milestone C against this baseline | Missing tests in 28% of PRs; 4 of 9 final-review findings were leftovers or cross-PR (0.4.0 guidance not yet live) | Baseline |
| 7 | Watch: implement/easy haiku vs sonnet, docs on haiku/low, opus re-review of final-review fix PRs, test tasks that ship code | n = 4/2, 4, 1, 1 | Insufficient data |

```result-json
{"status": "done", "summary": "Milestone B routing held (implement/medium sonnet 6/7 first-pass, effort-first ladder 3/3) so no routing rows change, but three wave-1 spawns silently ran off-route, unexecuted PowerShell command examples drove most rework, and the 0.4.0 backfill still mislabels every changes_requested verdict and stamps the wrong guidance_version.", "tasks_analyzed": 59, "recommendations": 7, "report": "docs/coach/2026-10-31-codex-director.md"}
```
