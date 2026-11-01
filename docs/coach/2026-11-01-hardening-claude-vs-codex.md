# Coach report: S3 sync utility, milestone `hardening`, Claude vs Codex (2026-11-01)

Task COACH-20261101 (attempt 1). This report compares two runs of the same `hardening` milestone on the S3 sync utility. One run used the Claude Director and Claude agents (the "Claude variant"). The other used the Codex Director and Codex agents (the "Codex variant"). Both ran on plugin **0.4.1**.
Logs: the two milestone archive folders, read as-is. Codex `codex-events.jsonl` was ignored, as `coach.md` says.
Routing table compared: plugin 0.4.1 `skills/director/references/routing.md`.
Baseline: [2026-11-01-live-data-framework.md](2026-11-01-live-data-framework.md) ("C"), plus [2026-10-31-codex-director.md](2026-10-31-codex-director.md) ("B") and [2026-10-31-shared-structure.md](2026-10-31-shared-structure.md) ("A") for pooled Claude numbers.

## Summary

- **The two platforms behaved very differently on the same milestone.**
  - **Claude:** 9 of 10 per-PR first reviews approved. The one send-back was docs on haiku/low.
  - **Codex:** **0 of 8** per-PR first reviews approved. All 8 send-backs had top-level severity `major`. Codex reached the large tier (Sol) twice. Claude never escalated a tier.
- **Low effort was the most expensive setting, on both platforms.** All 3 first attempts that started at `low` failed review: Codex test/hard on terra/low, Codex docs/medium on luna/low, and Claude docs/medium on haiku/low.
  - Each low attempt used **more** tokens than the `medium` retry that fixed it: 7.70M vs 2.05M, 3.42M vs 0.35M, and 1.19M vs 0.76M.
  - The two Codex low turns alone were **34% of all logged Codex tokens**.
  - The Claude Director had already lifted test tasks off the table's `low` in a project decision record (decision 0006, after a test task failed at low in an earlier milestone). All 4 of its test tasks passed first review. The Codex Director followed the table and repeated the failure.
- **Routing table: one proposed change, which is still a candidate.** It raises the `test` row from `low` to `medium` effort and splits `docs` so that only easy docs stay at `low`.
  - Each row has n = 3 at low, below the 5-task minimum. Taken together the evidence is 0 of 6 across 2 tools and 4 milestones, and the measured cost points the same way. Details are in "Proposed changes".
  - Keep the other rows. Implement/medium on sonnet/medium was 3/3 here and **19/22 pooled**. Implement/easy on haiku was 1/1 here and **6/6 pooled**.
- **0.4.1's Codex retry fix works.** On Codex, 9 of 9 effort or tier escalations were new spawns, and every completion shows the requested model and effort.
  - In the earlier Codex milestone in the same archive (0.4.0), 5 of 5 requested escalations were resumes, and all 5 ran at the **unchanged** setting.
- **The Codex reviewer never reported a minor finding.** All 16 of its findings in 19 reviews were `major` and blocking. The Claude reviewer reported 23 minor and 1 major in its per-PR reviews. Both use the same `reviewer.md` body.
  - **Effect on Codex:** every send-back looked major, so the ladder's step 1 (send back at the same settings) was never used. Every Codex retry was a cold new spawn.
  - **Effect on Claude:** the minors drove 7 optional fold-ins, which cost $1.89.
- **Both final reviews found a blocking issue that no per-PR review had caught** (pooled 4 of 5 milestones). Keep the final review on the large tier.
- **Cost.**
  - **Claude:** ≈ $20.0 estimated, 21.3M tokens, 7,587 agent-seconds. Opus was 52% of the cost. The final-review fix loop (an architect fix on opus plus an opus re-review) cost $5.68, which is 28%.
  - **Codex:** 32.4M tokens logged (more than Claude's 21.3M, with 3 turns missing) and 5,334 agent-seconds. It is not priced. Rework (retries and re-reviews) was **31%** of its tokens.
- **Logger gaps (Codex):**
  - 3 of 41 delegations have no completion. Among them are the final reviewer's first two turns, which found the 2 bugs that became HD-7 and HD-8, and their verdicts are not in `reviews.jsonl`.
  - Decision id `0004` was logged twice for different decisions.
  - Retries changed task type and difficulty (test/hard → fix/medium), which splits one task across groups.
- **Logger gaps (both platforms):** G4 (no `milestone` on reviews and merges), G6 (pauses not logged) and G10 (no merge line for the milestone PR) all recur.

## How records were attributed

| Record | Rule | Claude variant | Codex variant |
|---|---|---|---|
| Delegations | `task.milestone: hardening` | 40 (24 spawns, 16 resumes) | 41 (27 spawns, 14 resumes), all `source: director` |
| Completions | Same; deduped by `agent_id` + `task.attempt` + turn | 40, one per turn; `report_source` handback 38, hook-input 2 | 38; **3 delegated turns have none** (see G11) |
| Reviews | `task_id` `HD-*` (the README counts 0 milestone-tagged reviews) | 20 for 20 review turns, no duplicates | 19 for 21 review turns (HD-FINAL attempts 1–2 missing) |
| Merges | Session and PR numbers after the milestone started (not tagged) | 11, all `merged` | 8, all `merged` |
| Decisions | Task `HD-*` | 3 (0005–0007) | 6, with id `0004` used twice |

- **Observed vs requested settings.** On both tools, every completion's `resolved_model` matches the tier map, and `resolved_effort` equals the requested effort: Claude 40/40, Codex 38/38.
- **Tier mismatches.** There were none, and the delegated tier matches the completion every time. Neither variant writes a `tier_mismatch` field (G3 is still unshipped).
- **Cost.** Claude is priced at the same list-price ratios as A–C: haiku $1/$5, sonnet $3/$15 and opus $5/$25 per M input/output, with cache read at 0.1× input and cache write at 1.25× input. Codex is **not priced**, because no rates are on record. Codex is compared on tokens, using `tokens_detail` (97% cached input), and on seconds.
- **The earlier milestone in each archive** is used only for the before/after check on 0.4.1 and for pooled context. It is labeled as such wherever it appears: `initial-sync` on Codex at 0.4.0, and `initial-version` on Claude at 0.1.1.

## Milestone at a glance

| | Claude variant | Codex variant |
|---|---|---|
| Plan | 11 tasks from the breakdown (HD-4 folded into HD-11) + 1 fix from the final review | 6 tasks from the breakdown + 2 fixes from the final review |
| Agent turns | 40 | 38 logged (41 delegated) |
| Tokens incl. cache | 21.33M (cache read 92%) | 32.41M logged (cached input 97%) |
| Uncached input / output | 0.9k + 1.33M cache write / 436k | 913k / 197k (35k reasoning) |
| Estimated cost | **≈ $20.04**: opus $10.38, sonnet $8.92, haiku $0.75 | not priced |
| Agent-seconds | 7,587 | 5,334 logged |
| Wall clock | 1 h 44 m (11:56–13:40Z), including a ≈ 3 min wait for the user to accept decision 0005 | 1 h 17 m (12:01–13:18Z), including a **≈ 27 min stop on a usage limit** (12:49–13:16Z) |
| Per-PR first reviews approved | **9 of 10** | **0 of 8** |
| Implementer retries after a send-back | 1 (HD-11) | 10 turns on 8 tasks (HD-1 needed 3 attempts) |
| Tier escalations | 0 | 2 (HD-1 and HD-4 to Sol) |
| Optional fold-ins | 7 loops, $1.89 | 0 (no minors reported) |
| Final review | opus: 1 major, 2 minors → HD-12 | Sol: 2 bugs → HD-7 and HD-8 (verdict lines missing), then approve |

**Where the Claude money went (≈ $20.04).**
- **Breakdown (HD-0, opus): $3.18, 16%.**
- **First attempts, 10 tasks: $5.32, 27%.**
- **First reviews on sonnet/high, 10: $2.07, 10%.** About $0.21 each.
- **Final-review loop: $7.20, 36%.**
  - The final review: $1.52.
  - The HD-12 fix on architect/opus: **$4.56**, the most expensive turn of either run, at 4.90M tokens and 860 s.
  - The resumed opus final reviewer reviewing the HD-12 PR: $1.12.
- **Fold-ins: $1.89, 9%.** 13 minors at about $0.15 per finding. HD-7's fold-in alone cost $0.53 for 2 test-file minors, because the agent's context was 1.09M tokens.
- **Send-back loop (HD-11): $0.36, 2%.**

**Where the Codex tokens went (32.41M logged).**
- **First attempts, 8 tasks: 18.58M, 57%.** Of that, terra/low on test (HD-5) used **7.70M** and luna/low on docs (HD-6) used **3.42M**.
- **Retries: 8.29M, 26%.**
- **First reviews: 2.80M, 9%.**
- **Re-reviews: 1.85M, 6%.**
- **Breakdown: 0.44M.**
- **Final review: 0.45M.** Only attempt 3 was logged.

## Per model / effort / task type

### Claude variant (tool = claude)

| Group (as ran) | n | 1st review | Avg tokens | Avg est. $ | Avg s |
|---|---|---|---|---|---|
| opus/high · breakdown/hard (HD-0) | 1 | held up: 11 tasks, 1 decision accepted | 1.93M | 3.18 | 763 |
| haiku/medium · implement/easy (HD-2) | 1 | approve, 2 minors | 360k | 0.12 | 76 |
| sonnet/medium · implement/medium (HD-1, 3, 6) | 3 | **3/3** approve-minor | 320k | 0.42 | 143 |
| sonnet/high · implement/hard (HD-5) | 1 | approve, 1 minor (with `ci: red`) | 1.35M | 1.20 | 464 |
| sonnet/high · test/hard (HD-7, 9); effort above the table per decision 0006 | 2 | **2/2** | 1.32M | 0.94 | 540 |
| sonnet/medium · test/medium (HD-8, 10); above the table per decision 0006 | 2 | **2/2** | 237k | 0.26 | 307 |
| haiku/low · docs/medium (HD-11) | 1 | **CR major** (1 major, 5 minors) | 1.19M | 0.37 | 162 |
| haiku/medium · ladder step 2, new spawn (HD-11 a2) | 1 | approve | 756k | 0.24 | 117 |
| opus/high · fix/hard on the architect (HD-12, from the final review) | 1 | approve, 1 minor | 4.90M | 4.56 | 860 |
| fold-in resumes (HD-1, 2, 3, 5, 6, 7, 8) | 7 | 7/7 approve on re-review | 366k | 0.20 | 103 |
| sonnet/high · per-PR first review | 10 | 9 approve, 1 CR | 165k | 0.21 | 124 |
| sonnet/high · re-review (incremental) | 8 | 8 approve | 91k | 0.07 | 72 |
| opus/high · milestone final review | 1 | **CR major** | 1.09M | 1.52 | 270 |
| opus/high · resumed final reviewer reviews the HD-12 PR | 1 | approve | 740k | 1.12 | 226 |

### Codex variant (tool = codex)

| Group (as ran, observed model/effort) | n | 1st review | Avg tokens | Avg s |
|---|---|---|---|---|
| gpt-6.1-sol/high · breakdown/hard (HD-PLAN) | 1 | held up: 6 tasks and 5 decisions; 2 more tasks came from the final review | 437k | 275 |
| gpt-6.1-terra/medium · implement/medium (HD-1, 2, 3) | 3 | **0/3**, all major | 976k¹ | 153 |
| gpt-6.1-terra/high · implement/hard (HD-4) | 1 | **CR major** | 2.67M | 306 |
| gpt-6.1-terra/low · test/hard (HD-5) | 1 | **CR major** (3 findings) | **7.70M** | **938** |
| gpt-6-luna/low · docs/medium (HD-6) | 1 | **CR major** (2 findings) | **3.42M** | **606** |
| gpt-6-luna/medium · fix/easy (HD-7, 8, from the final review) | 2 | **0/2**, both missing-tests | 931k | 115 |
| terra/high · effort-raise spawn (HD-1, 2, 3 a2) | 3 | 2/3 approve | 570k | 95 |
| sol/high · tier-raise spawn (HD-1 a3, HD-4 a2) | 2 | 2/2 approve | 973k | 337 |
| terra/medium · effort-raise spawn (HD-5 a2) | 1 | approve | 2.05M | 348 |
| luna/medium · effort-raise spawn (HD-6 a2), then a resume for a scope add (a3) | 2 | approve, approve | 348k / 398k | 34 / 51 |
| luna/high · effort-raise spawn (HD-7, 8 a2) | 2 | 2/2 approve | 920k | 137 |
| terra/high · per-PR first review | 8 | 0 approve, 8 CR | 350k | 63 |
| terra/high · re-review | 10 | 9 approve, 1 CR | 185k | 31 |
| sol/high · final review | 3 turns | a3 approve; a1 and a2 not logged | 450k (a3 only) | 45 |

¹ HD-2's logged completion is labeled attempt 2. It is a continuation the Director sent before any review, and one HD-2 turn has no line (G11), so the true average is higher.

### Pooled (same model and effort; earlier milestones as noted)

| Row | Here | Pooled | Verdict |
|---|---|---|---|
| implement/medium · sonnet/medium, first review passed | 3/3 | **19/22** (A+B+C+here) | keep |
| implement/easy · haiku/medium, first review passed | 1/1 | **6/6** | keep |
| implement/medium · terra/medium, first review passed | 0/3 | 3/8 with Codex `initial-sync` | insufficient in this milestone; see candidate C2 |
| test at `low`, first review passed | 0/1 (terra) | **0/3**: sonnet/low in Claude `initial-version`, terra/low in Codex `initial-sync`, terra/low here | candidate C1 |
| test at ≥ `medium` (sonnet), first review passed | 4/4 | 4/4 | candidate C1 |
| docs/medium at small/`low`, first review passed | 0/2 (haiku, luna) | **0/3** (+ A's haiku/low docs/medium) | candidate C1 |
| docs/easy · haiku/low, first review passed | — | 4/4 (A–C) | keep `low` for easy |
| Ladder effort raise fixed it on the next review | Claude 1/1, Codex 6/7 | Claude 7/7 (A–C + here) | keep |
| Ladder tier raise (Codex, medium → large) fixed it | 2/2 | 2/2 | keep (n = 2) |
| Final review found a blocking issue no per-PR review caught | 2/2 | **4/5** | keep |
| Resumed final reviewer reviews its own fix PR (Claude) | $1.12 | $1.78 (B), $1.42 (C), $1.12: n = 3 | wording only (see below) |

## Findings

### 1. On Codex, every first attempt failed review; on Claude, 9 of 10 passed (high confidence on the gap; its cause is mixed)
- **Codex by model.** Terra was 0/5 on first attempts (implement/medium ×3, implement/hard, test/hard). Luna was 0/3 (docs/medium, fix/easy ×2).
- **The ladder worked on Codex.**
  - Raising effort fixed 6 of 7 on the next review.
  - Raising the tier to Sol fixed 2 of 2: HD-1 after failing at terra/high, and HD-4, which started at high.
  - So the shipped ladder carried Codex through with no stuck tasks, but at **31% rework tokens** against **2% on Claude**.
- **This matches what `codex-mapping.md` predicted** ("expect Codex installs to escalate sooner, and to need `high` effort more often"). It is the first milestone with enough Codex records to show it.
- **Part of the gap is the reviewer (finding 4).** The Codex reviewer flags only blocking issues, so a borderline issue that Claude's reviewer would call minor becomes a send-back on Codex. The Codex findings were substantive, though: secrets leaking through JSON escaping, non-transactional migration DDL, and tests that never reached their precondition. Neither final review contradicted any of them.
- **Per-row data is thin.** Every Codex row has n ≤ 3 in this milestone, so no Codex-only row change meets the minimum. See candidate C2.

### 2. `low` effort on non-easy implementer work failed every time and cost more (medium confidence; each row is n = 3)
| Task | Model/effort | Tokens / s | Review | Fixed by | Tokens / s |
|---|---|---|---|---|---|
| HD-5 test/hard (Codex) | terra/low | **7.70M / 938** | CR: 3 majors | terra/medium | 2.05M / 348 |
| HD-6 docs/medium (Codex) | luna/low | **3.42M / 606** | CR: 2 majors | luna/medium | 0.35M / 34 |
| HD-11 docs/medium (Claude) | haiku/low | 1.19M / 162 | CR: 1 major, 5 minors | haiku/medium | 0.76M / 117 |

- **Earlier milestones point the same way** (context only). Codex `initial-sync`: test on terra/low (3.30M tokens) and docs on luna/low (1.58M) both failed. Claude `initial-version`: a sonnet/low test task failed, which is why decision 0006 exists.
- **The Claude Director routed around the table.** Decision 0006 put all 4 hardening test tasks at sonnet/medium or high, and they passed 4/4 with 0 send-backs.
  - test/medium cost $0.26 on average.
  - test/hard at high cost $0.94 on average. HD-7's 2.06M tokens were mostly cache reads from Docker test runs.
- **The Codex Director followed the table** (test → low) and repeated its own earlier failure.
- **Low did not save money in these cases.** The low runs explored longer and still missed the acceptance criteria. Low still works where the spec is exact: docs/easy on haiku/low is 4/4 across A–C.

### 3. Missing-tests findings are the shared defect class, and on Codex they are violations of rules that are already written (medium confidence; guidance fix)
- **Codex.** 5 of the 16 majors (31%) are missing-tests, in 4 of 8 tasks: HD-3, HD-5, HD-7 and HD-8. Four of the five break rule 1 of the implementer's "Tests that prove something" ("assert the precondition was reached"), which 0.4.0 already shipped:
  - The signal handshake never shows that a multipart upload is active.
  - The credential-redaction test never puts the credential in the error.
  - The rollback test fails before any write.
  - The abort test never checks history after a part has uploaded.
- **Each was fixed only by raising effort.** The rule is there; the lower-effort runs skipped it.
- **Claude.** 6 of 10 per-PR first reviews had a missing-tests minor (C: 6 of 9). These are smaller ("could also assert X"), and fold-ins handled them.
- **Codex security (3 majors, HD-1 ×2 and HD-4).** Redaction was checked on raw strings but not on the serialized form, so JSON escaping and numeric values could re-expose a secret, and one credential source was missed. HD-1 needed 3 attempts and a tier raise.
- **The proposed fix** is a mechanical self-check that a lower-effort run can follow. See "Agent guidance".

### 4. The Codex reviewer never reports minors (medium confidence)
- **The counts.** Terra/high wrote 0 minors in 18 reviews, and Sol/high wrote 0 in 1. The earlier Codex milestone had 1 minor in 17 lines. Claude sonnet/high wrote 23 minors and 1 major across its 10 first reviews.
- **The prompt is the same.** The Codex TOMLs are generated from the same `reviewer.md`.
- **Its majors follow the rubric.** "Makes a test not prove what it claims" is defined as `major`. So the gap is the **absence of minors**, not inflated majors.
- **Consequences.**
  1. The Coach can't see Codex's non-blocking quality, and the "fold in minors" path never runs on Codex.
  2. Every Codex send-back was major, so ladder step 1 (same settings plus findings, warm context) was never tried. Every retry was a cold new spawn at higher effort.
- **Step 1 may still work on Codex.** In the 0.4.0 Codex milestone the requested raises silently didn't apply, so those retries were effectively step 1 at the same settings, with warm context. 3 of 4 passed the next review. That is n = 4, and the 0.4.0 data is confounded, so this is a watch item and not a ladder change.

### 5. 0.4.1's retry-settings fix is confirmed on Codex (high confidence)
- **0.4.0** (Codex `initial-sync`, context). 5 requested escalations were sent as follow-up resumes: IS-1 and IS-4 to high, IS-6 and IS-7 to medium, then IS-7 to high. **5 of 5 ran at the unchanged setting**, which `coach.md` counts as an ineffective escalation.
- **0.4.1** (hardening). **9 of 9** escalations were new spawns with unique `task_name`s, and every completion shows the requested model and effort. Claude matched this 1/1 (HD-11 a2).
- **Logging.** The Codex hook wrote one correct completion per logged turn, with an exact `turn_id`. No stale reports were seen, apart from the missing turns in G11.

### 6. Final review: keep on large; the Claude fix loop was the costliest item (medium confidence)
- **Claude.** Opus found that the state-store write probe needs fewer free pages than a real insert. A nearly full volume could therefore upload an object and then fail to record it. This is a real data-correctness bug. The Director routed it as fix/hard to the architect on opus (the table's row), which cost **$4.56** (4.90M tokens and 860 s). It then had the final reviewer review the fix PR, for another $1.12.
- **Codex.** Sol's first-turn audit found 2 bugs: a CLI diagnostic that could include a credential, and stale retry state left on a completed key. The Director routed them as fix/easy on luna/medium, and **both failed first review** on missing-tests. Luna/high fixed both.
- **The two Directors priced the same kind of work very differently.** Claude spent $4.56 on one fix; Codex used the small tier for two. Neither choice is clearly wrong at n = 1–2.
- **The resumed final reviewer reviewing its own fix PR** has now happened in 3 milestones: $1.78, $1.42 and $1.12, against about $0.21 for a sonnet per-PR review here. Carry C's wording proposal forward (n = 3).

### 7. Reviewer consistency, smaller items (medium–low confidence)
- **HD-5 (Claude) was approved with `ci: red`.** The Director caught it and folded in the CI gate. `reviewer.md` says a failing required check is blocking unless the reviewer explains why. This is n = 1, but it is a rule miss, not a judgement call.
- **`tests_run` and `tests_passed` disagree.** HD-7 a2 (Claude) has `tests_run: false, tests_passed: true`. Docs-only reviews on both tools report `false/false`, which reads as a failure (C noted the same, so n = 3+).
- **Command-example accuracy recurred.** 2 of HD-11's 5 doc minors (Claude) were commands that don't match reality: a `-p` flag CI doesn't use, and a literal `...` placeholder. This is the same class as C's finding 3, now seen in 3 milestones and 3 projects.

### 8. The Directors followed the table, with documented deviations (high confidence)
- **Claude.** All 40 lines ran on the card's tier. Deviations:
  - The 4 test tasks were raised above the table and logged as decision 0006.
  - The final reviewer reviewed the HD-12 fix, and the WHY said so.
  - The session fallback for implement/hard and fix/hard was noted in WHY.
- **Codex.** All 41 lines followed the table literally, ladder steps included. The session fallback on HD-4 was noted.
- **Attempt numbering on Codex.**
  - A continuation sent before any review was numbered attempt 2 (HD-2), so HD-2 has two different "attempt 2"s.
  - A scope addition from the final review was numbered attempt 3 (HD-6).
  - Neither was a send-back, but both look like one in attempt counts.

## Effects of the last guidance change
- **Codex.** Every hardening line is 0.4.1, and the earlier Codex milestone is 0.4.0. The 0.4.1 change (decision 0009: turn identity and retry settings) moved effective escalations from 0/5 to 9/9 (finding 5), and per-turn token attribution looks right. A first-pass comparison isn't meaningful, because the project phases differ.
- **Claude.** All hardening lines are 0.4.1, and the prior milestone is 0.1.1. It is too old and too different to compare.

## Logging gaps

| Gap | Status | Evidence here | Proposed |
|---|---|---|---|
| G3 no `tier_mismatch` field | open | 0 mismatches on either tool | Keep (low) |
| G4 no `milestone` on reviews or merges | **recurs, both tools** | README: 0/20 and 0/19 reviews, 0/11 and 0/8 merges | Copy from the linked delegation; for merges, use the PR base `milestone/<name>` |
| G6 pauses not logged | **recurs** | Codex: ≈ 27 min usage-limit stop mid–final review, known only from a WHY string. Claude: wait for the user to accept decision 0005 | Add `log-event.js pause` with `reason: "usage_limit"\|"user"\|"runway"` |
| G10 no merge line for the milestone PR | **recurs, both tools** | No line for the milestone PR to `main` | Low; carry C's proposal |
| **G11 (new) Codex turns with no completion** | — | 3 of 41 delegations have none: HD-FINAL a1 and a2, and one HD-2 turn. HD-FINAL a1/a2 also have **no review lines**, although a1's findings created HD-7 and HD-8. HD-2's only completion started ≈ 2 min before the Director's resume line was written | On `SubagentStop` with no matching transcript turn, write a stub completion (`report_source: "missing"`, `turn_id`, `task_name`). Have reconcile backfill Codex turns by `turn_id`. Add a test for a turn cut off by a usage limit |
| **G12 (new) Codex decision log** | — | Id `0004` logged for two different decisions (HD-2 at 12:07, HD-8 at 12:44); `model: "GPT-6"` (not a resolved model id); `effort: "unknown"` on every line | `log-event.js decision`: reject a duplicate `id` in the same logs folder; fill `model`/`effort` from the session's resolved settings when given a family name |
| **G13 (new) task card drift on retries** | — | Codex: HD-1 implement → fix; HD-5 test/hard → fix/medium. A pre-review continuation and a scope addition each bumped `attempt` | Director skill (both tools): retries keep the attempt-1 `type` and `difficulty`; bump `attempt` only after a review verdict or for a fold-in; mark a scope addition with `kind: "followup"`. Logger: warn on a type or difficulty change within a task id |
| **G14 (new) merge lines store the whole shell command** | — | Claude merge `command` fields begin with `cd <absolute local path>;` | Strip leading `cd …;`/`&&` segments before logging, so archives can be shared without local paths |
| Codex delegation lines lack `agent_id`, `model`, `tier_source`, `effort_source` | known | Linking must go by `task_name`; mismatch checks must use completions | Low: add `requested_model` (from the map) so a mismatch is visible without the completion |

## Proposed changes (propose only; not applied)

### routing.md: candidate C1, effort floor for non-easy implementer work

```diff
-| test | any | implementer | medium | low | subagent (worktree) |
-| docs | any | implementer | small | low | subagent (worktree) |
+| test | any | implementer | medium | medium | subagent (worktree) |
+| test | hard | implementer | medium | high | subagent (worktree) or session if > ~1 hour |
+| docs | easy | implementer | small | low | subagent (worktree) |
+| docs | medium/hard | implementer | small | medium | subagent (worktree) |
```
- **Evidence.**
  - Test at `low` is 0/3 (sonnet ×1, terra ×2, across 3 milestones). Test at ≥ medium on sonnet is 4/4.
  - Docs/medium at small/low is 0/3 (haiku ×2, luna ×1). Every docs/medium retry at small/medium passed (2/2).
  - Docs/easy at haiku/low is 4/4, so it stays.
  - In all 3 measured cases here, the `low` attempt cost more tokens than the `medium` fix: 7.70M vs 2.05M, 3.42M vs 0.35M, and 1.19M vs 0.76M. So the change is expected to **save** tokens.
- **Confidence: low–medium.**
  - Each row is n = 3, below the 5-task minimum, so treat this as a candidate.
  - It is put forward anyway because the combined count is 0/6 across 2 tools and 4 milestones, the cost points the same way, and one Director already overrides the row by project decision.
  - The `test | hard → high` line copies `implement | hard` and decision 0006. It rests on n = 2 (2/2 at $0.94 each).
- **If not adopted:** watch the next 2 test tasks and 2 docs/medium tasks per tool.

### routing.md: candidate C2, a per-tool note for Codex (insufficient data; do not merge yet)

```diff
+## Per-tool notes
+
+Tiers aren't equal across families (see `docs/codex-mapping.md`). Until the Coach has ≥ 5 tasks per row:
+- **Codex:** expect one send-back per task. Don't start an implementer row below `medium` effort.
```
- **Evidence.** Codex first reviews passed 0/8 here, and Terra implement/medium passed 3/8 counting the earlier Codex milestone, against 19/22 for sonnet.
- **What it is not.** It does **not** raise Codex implement/medium to `high`. The only Terra first attempt at high (HD-4, implement/hard) also failed, so there is no evidence that starting at high passes more often. Revisit at n ≥ 5 Terra implement/medium tasks under 0.4.1.

### routing.md: wording (carried from C, now n = 3)

```diff
 | review (milestone final) | any | reviewer | large | high | subagent |
+
+A fix PR for a final-review finding gets a normal per-PR review (`review` row). Resume the final reviewer only to confirm its own blocking finding on the incremental diff, not for a fresh milestone check.
```
Evidence: resumed large-tier reviews of fix PRs cost $1.78 (B), $1.42 (C) and $1.12 (here), against $0.21 for a sonnet/high per-PR review here. (Shipped in 0.4.2, after these runs.)

### Agent guidance (both tools; targets findings 3, 4 and 7)

```diff
 # agents/implementer.md, "Tests that prove something"
+4. **Make it fail first.** For each failure-path test, break the precondition or revert the fix locally and confirm the test fails, then restore it. In the PR body, name the line that asserts the precondition.
+5. **Secrets.** When code redacts a secret, test the serialized output a user sees (JSON, repr, log line, exception chain), with the secret actually present in the input.
```
```diff
 # agents/reviewer.md, under Severity
+List every finding you would raise with a human author, minors included. Don't leave out minors to keep a verdict clean: the Director uses them to decide what to fold in, and the Coach uses them to compare models.
```
```diff
 # agents/reviewer.md, step 3 (CI)
-3. Check CI yourself: `gh pr checks <n>`. A failing required check is blocking unless you explain why it isn't caused by this PR. Pending checks: say so in `ci`.
+3. Check CI yourself: `gh pr checks <n>`. A failing required check is blocking unless you explain why it isn't caused by this PR: don't `approve` with `ci: red` without that explanation in `summary`. Pending checks: say so in `ci`. If you ran no tests, set `tests_passed` to `null`, not `true` or `false`.
```
C's command-example rule (C, recommendation 1) was unshipped in 0.4.1, the version these runs used; it shipped in 0.4.2. HD-11 adds a third milestone of evidence for it.

### Logger (plugin PR)
1. **G11.** Write a stub completion for Codex turns that have no transcript match, and let reconcile backfill them by `turn_id`. Add a usage-limit interruption fixture.
2. **G12.** Reject duplicate decision ids. Fill the resolved model and effort.
3. **G13.** Warn when a retry changes `type` or `difficulty`. Document when `attempt` is bumped, and add `kind: "followup"` for scope additions.
4. **G4 and G6.** Add `milestone` on reviews and merges, and a `pause` event that covers usage-limit stops.
5. **G14.** Strip `cd …` prefixes from logged merge commands.

### coach.md

```diff
+- When the same milestone was run on both tools, compare first-review pass rates per model, but read reviewer severity mix first: a reviewer that reports no minors turns borderline issues into send-backs and skips ladder step 1.
+- Codex completions can be missing for turns cut off by a usage limit or still running when the Director sent a follow-up; count delegated turns as well as completions, and say how many have no line.
```

## Recommendations (consolidated)

| # | Recommendation | Evidence | Confidence |
|---|---|---|---|
| 1 | **Candidate C1:** test → medium effort (hard → high), and docs split so only easy stays at low | low: 0/6 non-easy starts (test 0/3, docs/medium 0/3), across 2 tools and 4 milestones; ≥ medium test 4/4; the low runs cost more than the medium fixes (7.70M vs 2.05M, 3.42M vs 0.35M, 1.19M vs 0.76M) | Low–medium (n = 3 per row) |
| 2 | **Keep** implement/medium sonnet/medium, implement/easy haiku, the ladder, and the final review on large | 19/22 and 6/6 pooled; effort raise Claude 7/7 pooled, Codex 6/7; tier raise 2/2; final review found blockers in 4/5 milestones | Medium–high |
| 3 | **Codex:** expect a send-back per task; no implementer row below medium (candidate C2). Don't raise Codex implement/medium to high yet | Codex first reviews 0/8; Terra implement/medium 0/3 (3/8 pooled); Terra at high first try 0/1 | Insufficient data |
| 4 | **Implementer guidance:** "make it fail first" and test the serialized form of secrets | Codex: 5/16 majors are missing-tests, 4 of them violate an existing rule, fixed only by raising effort; 3 redaction majors (HD-1 took 3 attempts); Claude: missing-tests minors in 6/10 PRs | Medium |
| 5 | **Reviewer guidance:** report minors; no `approve` on red CI without a reason; `tests_passed: null` when no tests ran | Codex: 0 minors in 19 reviews vs 23 on Claude; HD-5 approved on red CI; `tests_run` and `tests_passed` disagree | Medium |
| 6 | **Logger:** G11 missing Codex turns, G12 duplicate decision ids, G13 card drift on retries, G4/G6/G14 | 3/41 Codex turns with no line, including the final-review turns that created 2 tasks; id 0004 twice; 2 tasks changed type mid-task; 27 min stop unlogged | Medium |
| 7 | **Wording:** the final-review fix PR gets a normal per-PR review | $1.78 / $1.42 / $1.12 vs $0.21 | Low (n = 3) |
| 8 | **Watch:** ladder step 1 on Codex (feedback only at the same settings); Codex final-review fixes on small/medium (0/2); fix/hard on the architect (opus, $4.56, n = 1) | warm same-setting retries passed 3/4 in the 0.4.0 Codex milestone (context) | Insufficient data |

```result-json
{"status": "done", "summary": "Same hardening milestone on both tools: Claude passed 9/10 first reviews (~$20, 21.3M tokens) while Codex passed 0/8 and spent 31% of 32.4M tokens on rework; low effort failed on every non-easy implementer start and cost more than the medium fix, so the main (candidate) routing change is an effort floor for test and docs/medium, with guidance and logger fixes for missing-tests, reviewer minors, and missing Codex turns.", "tasks_analyzed": 23, "recommendations": 8, "report": "docs/coach/2026-11-01-hardening-claude-vs-codex.md"}
```
