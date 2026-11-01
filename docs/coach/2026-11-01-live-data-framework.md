# Coach report: TastyTrade prototype, milestone `live-data-framework` (2026-11-01)

Task COACH-20261101 (attempt 1). This is the first project built on plugin **0.4.1**, which was released in PR #71 on top of 0.4.0 (PR #70).
Logs: the milestone archive folder (identical to the project's `.agent-team/logs/`). Project: tastytrade-prototype. The project uses its milestone PRs #13–#23; PR #24 is the milestone PR to `main`.
Routing table compared: plugin 0.4.1 `skills/director/references/routing.md`. It is byte-identical to 0.4.0.
Baselines: [2026-10-31-codex-director.md](2026-10-31-codex-director.md) ("B") and [2026-10-31-shared-structure.md](2026-10-31-shared-structure.md) ("A"). This milestone is called "C" below.

## Summary

- **Routing table: still no row changes, and one watch item is now settled.**
  - implement/medium on sonnet/medium passed its first review on 5 of 7 tasks here, and 16 of 19 across A+B+C.
  - The effort-first ladder fixed both majors on the next try (2/2). Across A+B+C it is 6/6.
  - implement/easy on haiku has now reached the 5-task minimum: **5/5 passed first review** across 3 milestones. Keep it on small, and **drop B's reference-only candidate** to move it to medium.
- **The 0.4.0 logging fixes work in production.** Every completion and review line in this run is correct.
  - 40 of 40 agent turns have exactly one correct completion line, with tokens equal to the transcript to the token.
  - 20 of 20 verdicts are right and on the right attempt. No reconcile was needed.
  - This is the first time the logs could be used as-is, without rebuilding them from transcripts (A: 3/15 verdicts correct; B: 2/30 from the hook).
- **The Director applied every route it wrote down: 40 of 40 delegation lines ran on the card's tier, and 5 of 5 needed overrides were passed.** B's wave-1 off-route problem did not recur, even though B's fix (always pass `model`/`effort`, flag `tier_mismatch`) was not shipped.
- **B's top guidance problem recurred, and this time it had a side effect.** The problem is command examples that were never run as written in the user's shell.
  - **The defect.** The README's Windows steps fail under PowerShell 5.1's default `Restricted` policy. Only the opus final review caught this. It was the milestone's only blocking final finding, and it created a follow-up task (M1-11).
  - **Why the per-PR review missed it.** M1-4's reviewer ran the steps with `-ExecutionPolicy Bypass`, which hides the failure.
  - **The side effect.** The final reviewer ran the steps literally, chained with `;`. `Activate.ps1` failed, and the next `pip install` went to the user's **global** `C:\Python312`. The user had to clean it up.
  - So "run it as written" needs safety rails as well as the B guidance.
- **New pattern: async staleness and races.** 5 of 7 sonnet implement PRs had a finding where state was read before an await or lock and was stale after it. Both send-backs (M1-3, M1-6) were this class, and missing-tests findings rose to 6 of 9 PRs. This calls for a targeted implementer rule, not a bigger model.
- **Cost:** ≈ $23.3 estimated for 10 tasks and 40 turns. Opus was 34% of it, and rework (send-backs, the final-review fix loop and one re-ask) about 16%.
- **No Codex records.** All 40 runs are `tool: claude`, so 0.4.1's Codex fixes cannot be judged from this data.

## How records were attributed

Only delegations and completions carry `milestone`; the README counts 0 milestone-tagged reviews and merges (gap G4 recurs).

| Record | Rule | Count |
|---|---|---|
| Delegations | `task.milestone: live-data-framework`, session `8f77bad7…` | 40 (22 spawns, 18 resumes) |
| Completions | Same session; all have a milestone task card | 40, all `report_source: handback`, all `guidance_version: 0.4.1` |
| Reviews | `task_id` `M1-*`, linked to M1 delegations by `agent_id`; one session; the logs folder holds only this milestone | 20 (20 unique `review_id`, no duplicates) |
| Merges | Session `8f77bad7`; PRs #13–#21 and #23 match STATUS.md's task PRs (all into `milestone/live-data-framework`) | 10, all `outcome: merged` from `gh pr view` |
| Not logged | Milestone PR #24 to `main` (opened at close, merged by the user); no `notes.jsonl`, `escalations.jsonl`, `decisions.jsonl` or `tier_fallbacks.jsonl` | — |

- **Ground truth.** I rebuilt every turn from the subagent transcripts in the session's `subagents/` folder, read-only. I split turns on each `TASK id=` prompt and on `isMeta` "coordinator sent a message" resumes, and counted usage once per message id.
  - There are 40 turns, and each matches its completion line's `tokens_with_cache` exactly.
  - The verdict sequence for each reviewer matches `reviews.jsonl`.
  - The Director's timeline comes from the Director transcript.
- **Cost.** The figures are estimates at the same list-price ratios as B: haiku $1/$5, sonnet $3/$15 and opus $5/$25 per M input/output, with cache read at 0.1× input and cache write at 1.25× input. Cache reads are 92% of tokens.
- **Observed vs requested settings.** On Claude, `resolved_effort` comes from the stop hook's `effort.level` and `resolved_model` from the hook. Every turn's observed values match the requested ones (40/40). Both ladder steps were observed at `high`.
- **Context differs from A and B.**
  - **The project.** This is an application: a FastAPI backend plus a React/Vite frontend, with CI (GitHub Actions, `ci: green` on every review), async/concurrent code and a Windows end user. A and B were the plugin's own Node scripts and docs, with no CI.
  - **Task size.** Tasks were larger: an implement/medium first attempt averaged 1.11M tokens here, against 449k in B. Compare rates (pass rates, ladder success), not absolute cost.

## Milestone at a glance (A vs B vs C)

| | A `shared-structure` | B `codex-director` | C `live-data-framework` |
|---|---|---|---|
| Project / plugin | plugin repo / 0.2.1 | plugin repo / 0.3.0 | TastyTrade app / **0.4.1** |
| Tasks / agent turns | 12 / 31 | 24 / 59 | 10 (+ final) / 40 |
| Tokens (incl. cache) | 7.44M | 29.26M | 26.22M (cache read 92%) |
| Estimated cost | not priced | ≈ $27.3 | **≈ $23.3**: sonnet $14.95, opus $7.86, haiku $0.45 |
| Agent-seconds | 2,976 | 11,964 | 7,840 |
| Wall clock | 3 h 43 m (2 h 42 m idle) | ≈ 2 h 41 m + 133 m intake wait | **1 h 48 m** active (03:12–05:00Z), then 6 h 35 m waiting for the user (ruleset) |
| Per-PR first reviews sent back | 1 of 9 | 2 of 18 | 2 of 9 |
| Final review | 0 majors, 7 minors | 1 major, 8 minors | 1 major, 5 minors |
| Logs correct without transcripts | 3/15 verdicts | 2/30 verdicts (hook) | **20/20 verdicts, 40/40 turns** |

**Where the money went (C).**
- **Opus: $7.86, 34%.** That is M1-1 design $3.39 plus its fold-in $0.99, the final review $2.07, and reviewing the fix PR $1.42.
- **Rework: ≈ $3.80, 16%.**
  - Send-back loops: M1-3 $1.15 and M1-6 $0.93.
  - Final-review fix loop (M1-11): $1.69.
  - One review-json re-ask: $0.03.
- **Optional fold-ins: $3.70, 16%.** They fixed 30 minor findings, about $0.12 per finding.

## Per model / effort / task type (tool = claude, C only)

| Group (as ran) | n | 1st review | Avg tokens | Avg est. $ | Avg s |
|---|---|---|---|---|---|
| opus/high · design/medium (M1-1, incl. task map) | 1 | approve, 8 minors | 1.56M | 3.39 | 776 |
| haiku/medium · implement/easy (M1-2, tooling + CI) | 1 | approve clean | 491k | 0.18 | 186 |
| sonnet/medium · implement/medium (M1-3…M1-9) | 7 | 5 approve-minor, **2 CR-major** (M1-3, M1-6) | 1.11M | 0.92 | 316 |
| sonnet/high · ladder step 2, new spawn (M1-3 a2, M1-6 a2) | 2 | 2 approve on re-review | 822k | 0.68 | 240 |
| sonnet/medium · fold-in resume (M1-4, 5, 7, 8, 9) | 5 | 5 approve on re-review | 528k | 0.34 | 69 |
| haiku/low · docs/easy (M1-11, from final review) | 1 | approve, 2 minors (opus reviewer) | 804k | 0.21 | 227 |
| sonnet/high · per-PR first review | 9 | 7 approve, 2 CR | 451k | 0.43 | 207 |
| sonnet/high · re-review (incremental) | 8 | 8 approve | 291k | 0.19 | 89 |
| sonnet/high · re-ask for missing `review-json` (M1-7) | 1 | — | 35k | 0.03 | 5 |
| opus/high · milestone final review | 1 | **CR-major** | 1.95M | 2.07 | 591 |
| opus/high · same agent reviews fix PR #23, then re-review | 2 turns | approve, approve | 1.05M / 207k | 1.27 / 0.15 | 213 / 15 |

### Pooled across A+B+C (same model and effort, tool = claude)

| Row | A | B | C | Total | Verdict |
|---|---|---|---|---|---|
| implement/medium · sonnet/medium, first review passed | 5/5 | 6/7 | 5/7 | **16/19 (84%)** | keep |
| implement/easy · haiku/medium, first review passed | 2/2 | 2/2 | 1/1 | **5/5** | keep (minimum reached) |
| docs · haiku/low, first review passed | 0/1 (medium) | 3/3 (easy) | 1/1 (easy) | 4/5; easy 4/4 | keep; docs/medium still n = 1 |
| Ladder step 2 (raise effort after a major) fixed it on the next review | 1/1 | 3/3 | 2/2 | **6/6** | keep |
| Fold-in approved on re-review | 4/4 | 4/5 | 7/7 | **15/16** | keep |
| Final review (opus/high) found a blocking issue no per-PR review caught | 0/1 | 1/1 | 1/1 | 2/3 | keep |
| Reviewer/implementer report missing its JSON block | 1 | 1 | 1 | 3 in 3 milestones | fix (cheap) |

## Findings

### 1. implement/medium on sonnet/medium: keep (n = 7 here, 19 pooled; medium–high confidence)
- **What failed.** The two send-backs were real, reproduced bugs:
  - M1-3 (hub): `subscribe` checked `client.closed` outside the lock and leaked a provider subscription. A raising `status()` also silently killed the sender task.
  - M1-6 (watchlist): `handleAdd` used stale `inputs` after an `await`, so a removed symbol came back and was persisted.
- **The fix.** Each was fixed by one new sonnet/high spawn ($0.79 and $0.57) and approved on re-review.
- **The architect's suggestion.** The Director's WHY notes that the architect had suggested large/high for M1-3 and M1-8 ("concurrency", "P&L math"). The Director started at the table tier: M1-3 failed and M1-8 passed. That is n = 2, and the unflagged M1-6 also failed, so there is no evidence that a flag predicts failure.
- **Don't raise the row.** Starting all 7 at high would have to cost less than ≈ $0.30 extra per task to beat the $2.08 actually spent on rework. The data can't show that, so the row stays.

### 2. Async staleness and races are the recurring defect class (n = 7 PRs; medium confidence; guidance fix)
- **The defect.** 5 of the 7 sonnet implement PRs had a finding where state was read before an `await`, lock or in-flight request and was stale when used:
  - M1-3 (major)
  - M1-5 (an in-flight batch after unsubscribe is cached forever)
  - M1-6 (major)
  - M1-7 (the old chain flashes on A→B→A)
  - M1-9 (an in-flight poll overwrites a fresher account)
- **The missing tests.** Missing-tests findings appeared in **6 of 9** first reviews (67%), against 28% in B and 33% in A. At least 4 of them ask for exactly the interleaving test that would have caught the bug: M1-3, M1-6, M1-7 and M1-9.
- **The general rule wasn't enough.** The 0.4.0 rule "every new branch, CLI flag, record field or error path gets a test" was live. It doesn't name interleavings, and it didn't stop this.
- **Context.** A and B had almost no async UI code, so the rise is partly the project. A specific rule is still cheap and directly targeted.
- **Proposed rule.** See "Agent guidance" below.

### 3. Command examples: B's finding recurred, and running them literally harmed the user's machine (high confidence; guidance fix)
- **The defect.** M1-4's README told Windows users to run `.venv\Scripts\Activate.ps1`, which fails under the default `Restricted` policy. A user who follows the steps then installs into global Python.
- **Who missed it.**
  - M1-4's implementer never ran PowerShell (0 `powershell.exe` calls).
  - M1-4's reviewer ran the steps, but via `powershell.exe -ExecutionPolicy Bypass -File`, so it passed. It rated the README only minor ("hedged frontend section").
- **Who caught it.** The opus final review rated it **major/blocking**. That is consistent with the severity rule B proposed: a failure when pasted with a silent bad effect is major.
- **The side effect.** The final reviewer reproduced it with `py -3 -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -q -r requirements-dev.txt`.
  - In PowerShell 5.1, `;` keeps going after a failure, so `pip` resolved to the global interpreter and wrote `websockets` 17.4 into `C:\Python312\Lib\site-packages`. Writing its launcher to `Scripts` then failed for lack of permissions.
  - The Director then passed on the reviewer's wrong reading ("launcher went missing"). It sent the user a reinstall command that also failed for permissions, and only later found the real cause. It took the user 3 exchanges (11:36–11:42Z) to clean up.
  - On its next turn, the same reviewer used a safe form: check that `.venv\Scripts\python.exe` exists, otherwise STOP, then call `.venv\Scripts\python -m pip`.
- **Cost.** The M1-11 loop cost $1.69, plus the user's time. In B, CD-14's loop cost ≈ $0.88 and CD-22 was a task created for the same class. This is now 2 milestones in 2 projects.
- **0.4.1 status.** Not addressed: `implementer.md` and `reviewer.md` are unchanged since 0.4.0.

### 4. The 0.4.0 logger fixes are confirmed in production (high confidence)
- **One correct line per turn.** All 40 turns have exactly one correct line. Resume turns are counted per turn: for example, M1-1's architect fold-in shows 94 s, not cumulative. The `isMeta` "coordinator sent a message" resumes are split correctly (18 of 18). There are no stale `result`/`review` fields.
- **Tokens are exact.** First-attempt tokens are no longer undercounted, which was gap G7 (5–16% low in B).
- **Reviews.** Reviews carry `review_id`, `requested_*` and `reviewer_*`, with no duplicates.
- **One new gap.** M1-7's reviewer has two completion lines for attempt 1: the review turn (190k tokens, 160 s, no verdict) and the re-ask turn (35k, approve). The Coach rule "use the last line per `agent_id` and `task.attempt`" would drop the 190k turn. From 0.4.0 on, lines are per turn and must be summed (see G9).

### 5. The Director followed the routing table and process (high confidence)
- **Routes.** 40 of 40 delegation lines have the card's `tier` equal to the tier that ran. The 5 spawns that needed an override passed it: M1-2 haiku, M1-11 haiku/low, M1-3 a2 and M1-6 a2 at effort high, and M1-final on opus. STATUS.md's "Tier (model) / effort" column matches the logs.
- **Retries that changed effort were new spawns** with new agent ids and attempt 2, as 0.4.1's `coach.md` and `codex.md` now say. Fold-ins and re-reviews were `SendMessage` resumes. Both are correct.
- **No same-file clashes.** The architect's decision 0008 gave shared frontend files to M1-5, so M1-6, M1-7 and M1-9 could run in parallel. 0 tasks were blocked; in B, CD-7 lost $0.86 to a clash.

### 6. The final review on opus/high: keep (n = 3 pooled; medium–low confidence)
- **What it found.** A blocking issue no per-PR review caught, in 2 of 3 milestones: B's cross-PR log policy, and C's README.
- **Cost.** $2.07 here, against $3.15 in B.
- **Reviewing its own fix PR.** For the second time, the resumed opus final reviewer reviewed its own fix PR (#23). It re-ran a full milestone check (fresh clone, `npm ci`, backend and UI end to end) for $1.27, plus $0.15 for the re-review. In B this cost $1.78.
  - A sonnet/high per-PR review averages $0.43 here.
  - n = 2 is below the minimum for a row change, but the table doesn't say which row covers this review (see "Proposed changes").

### 7. Reviewer consistency (medium confidence)
- **Severity matched impact.** The same async class was rated major when the effect persisted or leaked (M1-3, M1-6) and minor when it was transient or cosmetic (M1-5, M1-7, M1-9). That is consistent.
- **One inconsistency.** The README-in-PowerShell issue was minor/missed at the per-PR review and major at the final review. Its cause was the `Bypass` flag, not judgement.
- **Missing JSON block, third time.** M1-7's reviewer ended its first turn with findings but no `review-json`. The re-ask cost $0.03 but added a Director turn.
- **`tests_passed: false` on a docs-only re-review.** M1-1 a2 had `ci: "pending"` and `tests_passed: false` on a docs-only fold-in, the same as CD-17-R a2 in B. The field still reads as a failure (n = 2).

### 8. Other groups: insufficient data
- **Design/breakdown on opus/high.** n = 3 pooled (SS-0, CD-0, M1-1). All held up downstream. M1-1's 8 minors were folded in on the opus agent for $0.99, which is 27% of C's fold-in spend. Folding docs nits into the architect may cost more than a small-tier fold-in, but n = 1.
- **Test tasks.** None in C. The question of "test tasks that ship code" stays open.

## Status of the prior recommendations

"Addressed" means shipped in 0.4.0 or 0.4.1. The C column says what this milestone shows.

### B's recommendations

| # | B recommendation | Addressed? | C evidence | Revised |
|---|---|---|---|---|
| 1 | Fix `reconcile-logs.js`: same-attempt dedupe, keep the run's `guidance_version`, mark stale lines, 3-turn fixture | **No.** 0.4.1 adds Codex `drainPending` and `review_id` identity on hook reviews. Line 120 still skips on `sameContent` with any attempt, and `records.js` still stamps `lib.guidanceVersion()`. | **Can't tell.** Reconcile was not needed; the hook was right 40/40. | **Keep, lower to medium.** It matters for old 0.3.0 archives and for runs where the hook misses. It is no longer the first fix. |
| 2 | Always pass `model`/`effort`; `tier_mismatch` flag | **No.** routing.md is unchanged; there is no `tier_mismatch` field. | **Did not recur:** 40/40 on route, 5/5 overrides applied, including wave 1. | **Change to low:** add the logger flag only (cheap, catches silent drift). Drop the routing.md wording change unless it recurs. |
| 3 | Run command examples as written in each documented shell; consistent severity | **No.** Agent prompts are unchanged since 0.4.0. | **Recurred**, as the only final-review major. Running literally also caused global-env damage. | **Keep, raise to high, and add safety rails** (finding 3) |
| 4 | Keep implement/medium sonnet/medium and the effort-first ladder | Followed | 5/7 first-pass; ladder 2/2 | **Keep** (16/19, 6/6 pooled) |
| 5 | `milestone` on reviews/merges/notes/escalations; log pauses | **No** | **Recurred.** README: 0 for reviews and merges. A 6 h 35 m wait for the user's ruleset change is logged nowhere. | **Keep, medium** |
| 6 | Re-measure missing tests and sibling leftovers with the 0.4.0 guidance live | Measured | Missing tests 6/9 PRs (67%, up from 28%). Final review: 2 of 6 findings were cross-PR leftovers (M1-8 added `PAPER_STRATEGIES` but the README config table wasn't updated; handoff.md was stale). | **Change:** the generic rule didn't help in an async app, so add the targeted async rule (finding 2) |
| 7 | Watch: implement/easy haiku vs sonnet; docs haiku/low; opus re-review of fix PRs; test tasks that ship code | — | implement/easy haiku n = 5 (5/5); docs haiku/low n = 5 (4/5); opus fix-PR re-review n = 2; test n = 0 | **Settle** implement/easy (keep small; drop the candidate). Docs: keep the row, candidate still n = 1. Fix-PR review: clarify the wording. Test: keep watching. |
| — | Director: STATUS.md tier from logs; avoid same-file tasks in one wave | Not in the skill | Followed anyway: STATUS.md matches, and decision 0008 split the files | Keep as advisory; low |
| — | `coach.md` note on 0.4.0-reconciled archives | **No.** 0.4.1's `coach.md` changed only the Codex and resume wording. | n/a | Keep, and fold in the G9 per-turn rule |

### A's recommendations

These are already tracked in B. All except "log pauses" shipped in 0.4.0. C confirms the logger fix (A-1) and the fold-in rule (A-3: 7/7). It shows A-4 (fix the class, test every path) did not lower the missing-tests rate in this project.

### 0.4.1's own changes (Codex turn attribution and effort escalation)
- **Codex.** There are no `tool: codex` records, so the change **can't be judged**.
- **Claude.** The one part that applies to Claude is the convention that "a retry that changes model or effort is a new spawn". It was followed 2/2, and both runs' completions show effort `high`.

## Logging gaps

| Gap | B status | C evidence | Proposed |
|---|---|---|---|
| G1 reconcile mislabels shifted lines | open | not exercised | Keep B's fix and 3-turn fixture (medium) |
| G2 reconcile stamps its own `guidance_version` | open | not exercised | Keep B's fix (medium); it is needed before any before/after comparison of reconciled lines |
| G3 no `tier_mismatch` warning | open | 0 mismatches | Add the field; low |
| G4 no `milestone` on reviews/merges/notes | open | **recurs**: README 0/20 reviews and 0/10 merges | Copy from the linked delegation; merges from the PR base `milestone/<name>` |
| G5 two disagreeing lines per attempt | open | **fixed in practice** (one line per turn) | Close |
| G6 pauses and user waits unlogged | open | **recurs**: 6 h 35 m (05:00→11:35Z) waiting for a ruleset change; 3 m intake question | `log-event.js pause` before AskUserQuestion or ending a turn on a user decision |
| G7 first-attempt tokens low | open | **fixed**: 40/40 exact | Close |
| G8 escalation lines inconsistent | open | **None written.** The Director wrote no `escalations`, `notes` or `decisions` events; the skill doesn't ask for them. | Drop the requirement. The Coach can derive escalations from delegations (same task id, attempt+1, changed effort or tier). Optionally have the hook add `escalated_from: {tier, effort}` to such lines. |
| **G9 (new)** per-turn lines vs the "last line per attempt" rule | — | M1-7-R attempt 1 has 2 turns. The last-line rule drops 190k tokens / $0.27 / 160 s. | Add `turn` (index within the agent) to Claude completion lines. `coach.md`: for 0.4.0+ lines, sum all lines of an attempt and take the verdict from the last non-null `review`. |
| **G10 (new)** the milestone PR to `main` has no merge line | — | PR #24 was opened by the Director and merged by the user, so the hook can't see the merge | Low: log the `gh pr create` for the milestone PR as a merge-candidate line, or record it in the archive README |

## Proposed changes (propose only; not applied)

### routing.md: no row changes; one clarification

```diff
 | review | any | reviewer | medium | high | subagent |
 | review (milestone final) | any | reviewer | large | high | subagent |
+
+A fix PR for a final-review finding gets a normal per-PR review (`review` row). Resume the final reviewer only to confirm its own blocking finding is resolved on the incremental diff, not for a fresh milestone check.
```
- **Evidence.** The opus re-reviews of fix PRs cost $1.78 (B) and $1.42 (C), against $0.43 for an average sonnet/high per-PR review here.
- **Confidence.** n = 2, so this is a wording proposal, not a row change. Low confidence.

**Dropped:** B's reference-only candidate (`implement | easy | … | medium`). Haiku is 5/5 on implement/easy across 3 milestones (≈ $0.18–0.25 per task where priced).

### Agent guidance (findings 2 and 3; highest value)

```diff
 # agents/implementer.md, under Rules
+- Every command example you add or change in docs: run it exactly as written, in each shell the doc names, under that shell's default settings (no `-ExecutionPolicy Bypass`, no extra env vars). On Windows that means PowerShell 5.1. Run in a throwaway clone or your scratchpad, never against global interpreters. Say in your report which ones you ran.
+- In docs, don't rely on venv activation: call the venv's interpreter (`.venv\Scripts\python -m pip …`), and never chain setup steps with `;` in PowerShell 5.1 (a failed step doesn't stop the next one).
```
```diff
 # agents/implementer.md, "Tests that prove something"
+4. **Interleavings in async code.** For each `await`, lock or in-flight request in code you change, ask what happens if the state it read changes before it resumes (a remove during an add, an unsubscribe during a batch, a newer response landing first). Fix it, and add one test that forces that order with a deferred promise or event.
```
```diff
 # agents/reviewer.md, "Side effects"
+When you run documented steps, run them as a user would (default execution policy, no bypass flags), but safely: in a scratch clone, and stop at the first failing step. Before any `pip`/`npm install`, check that it targets the scratch environment (for Python, `python -c "import sys; print(sys.prefix)"` is inside your scratch dir). If a documented step would write outside scratch, report it as a finding instead of running it.
```
```diff
 # agents/reviewer.md, under Severity
+- A documented command that fails when pasted as written is `major` when the failure silently changes the user's environment or loses data or a log record; otherwise `minor`.
```

### Logger (plugin PR; medium value)
1. **G9.** Add `turn` to Claude completion lines. The parser already splits turns; write its index.
2. **G4.** Add `milestone` on review, note and escalation lines, copied from the linked delegation's card. On merge lines, take it from the PR's base branch `milestone/<name>`.
3. **G6.** Add `log-event.js pause '{"reason":"user"|"runway","note":…}'`. The Director skill calls it before AskUserQuestion, and when it ends a turn waiting on the user.
4. **G1/G2.** Carry B's reconcile diff and fixture forward unchanged.
5. **G3.** On delegation lines, add `tier_mismatch: {card, ran}` when `task.tier` ≠ `tier`.
6. **Missing JSON block (finding 7, 3 milestones).** When a role agent's report has no `review-json`/`result-json`, have the stop hook return `additionalContext` that names the agent and says "ask for the block". The Director then re-asks without having to notice it.

### coach.md

```diff
-One attempt can have more than one line (the stop hook can fire before the transcript catches up): use the last line per `agent_id` and `task.attempt`.
+Lines from 0.4.0 on are one per turn. An attempt can span several turns (for example, a re-ask for a missing `review-json` keeps the attempt number), so sum tokens and duration over all lines of an attempt, and take the verdict from its last line with a non-null `review`. For 0.3.0 and earlier, use the last line per `agent_id` and `task.attempt`.
+Archives reconciled by 0.4.x `reconcile-logs.js` carry the reconcile tool's `guidance_version`, not the run's; take the version from the linked delegation line.
```

## Recommendations (consolidated)

| # | Recommendation | Evidence | Confidence | vs prior |
|---|---|---|---|---|
| 1 | **Command examples:** run them as written in the user's default shell (no bypass), but in scratch, stop at the first failure, and never write to a global interpreter. Rate silent env-changing paste failures as major. | B: 5 findings / 4 PRs, CD-14 loop ≈ $0.88. C: the only final-review major; the M1-4 reviewer used `Bypass`; the M1-11 loop cost $1.69; the literal run wrote to global `C:\Python312`. | **High** (2 projects) | B-3, kept and extended |
| 2 | **Implementer rule for async interleavings**, with a forced-order test | 5/7 sonnet implement PRs had a stale-after-await finding, including both send-backs ($2.08 rework). Missing tests in 6/9 PRs. | Medium (n = 7, one project) | new; replaces B-6's re-measure |
| 3 | **Keep implement/medium on sonnet/medium, and the effort-first ladder**; don't start async-heavy tasks higher yet | 16/19 first-pass pooled; ladder 6/6; concurrency-flagged starts 1/2 failed (n = 2) | Medium–high | B-4, kept |
| 4 | **Keep implement/easy on small (haiku)**; drop the move-to-medium candidate | 5/5 first-pass across A+B+C; ≈ $0.18–0.25 per task | Medium (n = 5 exactly) | B-7, settled |
| 5 | **Logger:** `turn` on completions (G9), `milestone` on reviews/merges (G4), `pause` events (G6), stop-hook nudge for a missing JSON block | C: re-ask turn would be dropped (190k); 0/30 review and merge lines tagged; 6 h 35 m wait unlogged; missing block in 3/3 milestones | Medium | B-5, kept + G9 |
| 6 | **Reconcile fixes** (G1/G2) and **`tier_mismatch`** (G3): ship, but behind #1–#5 | The hook is now 40/40 correct and routes were 40/40 applied, so these protect against regressions and old archives | Medium / low | B-1 and B-2, both lowered |
| 7 | **Clarify** that the final-review fix PR gets a normal per-PR review; resume opus only for its own finding's incremental diff | $1.78 (B) and $1.42 (C) against $0.43 for a sonnet per-PR review | Low (n = 2) | B-7, wording only |
| 8 | **Watch:** docs/medium on haiku/low (n = 1), test tasks that ship code (n = 1), fold-ins on the opus architect (n = 1, $0.99) and Codex runs on 0.4.1 (n = 0) | — | Insufficient data | carried |

```result-json
{"status": "done", "summary": "On 0.4.1 the logs were correct end to end (40/40 turns, 20/20 verdicts) and routes were applied 40/40, so the routing table stays (implement/medium sonnet 16/19 pooled, implement/easy haiku now 5/5, ladder 6/6); the top fixes are guidance: run command examples as written but safely (the README PowerShell major recurred and a literal run wrote to the user's global Python) and an async-interleaving rule (5/7 PRs, both send-backs).", "tasks_analyzed": 40, "recommendations": 8, "report": "docs/coach/2026-11-01-live-data-framework.md"}
```
