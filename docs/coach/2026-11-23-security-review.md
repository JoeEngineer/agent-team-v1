# Coach report: milestone `security-review` (2026-11-23)

Task COACH-20261123 (attempt 1). Run at xlarge (Fable) / high because the user asked for it; the table row is coach / large / high.
Logs: `~/.agent-team/archive/agent-team-v1/2026-11-23-security-review/` (identical to the live `.agent-team/logs/`; counted once). Director session `9f9e2c2d-21fd-4008-aad2-686dbc89470b`. The milestone implemented decision 0022, merged into `main` as PR #125 and was released as v1.1.0.
Routing tables: "the 1.0.2 table" is the one that governed the run (the installed plugin). "The 1.1.0 table" is the one now on `main`. All proposals target the 1.1.0 files.
Baselines: [2026-11-01-live-data-framework.md](2026-11-01-live-data-framework.md) ("C"), [2026-11-01-hardening-claude-vs-codex.md](2026-11-01-hardening-claude-vs-codex.md) and [2026-11-03-consolidated-plan.md](2026-11-03-consolidated-plan.md) for pooled numbers and the watch list.

This is one milestone. Every recommendation says how many data points support it. Anything under 5 tasks in a category is marked as a candidate, not a row change.

## Summary

- **Routing was applied as written: 32 of 32 delegations ran on the model and effort the card asked for**, with no uncarded line and no mismatch. One task was routed above the table on purpose (SR-4), and two above-table flags from the breakdown were declined (SR-5, SR-6).
- **Two thirds of the agent cost went to two places: SR-4 (30%) and the close (36%).** Estimated agent cost is about $34.6 for 39.1M tokens; 37% of it was rework (send-backs, fold-ins and close rounds after the first two close reviews).
- **The close took three review rounds and 61 minutes; one round was needed.** The only blocking finding was a `STATUS.md` the Director's own update script had corrupted in five pushes. Rounds 2 and 3 came from fixing 14 non-blocking findings before reporting complete: about $4.9 and 40 minutes.
- **The separate security review earned its cost on this first data point.** At large/high it found 8 things, none of which the final review found (0 of 15 findings overlap), and 6 of the 8 were weaknesses in a control. Its first pass cost $3.32, about the same as the final review's ($2.81). There is no xlarge security review to compare with.
- **SR-4's override did not prevent a failed first review, and starting at large/high left the ladder with no automatic step**, so the first failure went to the user (a 17 m 44 s pause) and then to xlarge. The xlarge fix worked (clean re-review) but nothing shows it was needed: the fix was 37 added and 10 removed lines, and it cost 3.0M tokens because a new spawn re-reads everything.
- **SR-6 failed on work that was not docs.** Its major finding was a test anchor the Director had batched into the small-tier docs task from SR-5's re-review. The README text, which the breakdown's flag was about, drew only minor findings. Declining the flag was not the cause.
- **The watch-list trigger from 2026-11-03 has fired**: a docs/medium task on haiku/medium got a major at first review. Docs/medium on haiku is now 1 of 5 at first review across milestones.
- **One paragraph was written, patched three times, and still has four open gaps.** The `scan` states in `agents/security-reviewer.md` drew 9 findings across 6 reviews. Each wording fix opened the next edge case. It needs a state table from a design task, not another wording patch.
- **The Director's own session is the largest cost and is not in the logs**: 27.4M tokens on Fable (about 40% of all tokens in the milestone), with the context growing from 77k to 335k tokens and no compaction.
- **Logger defects:** `card_drift` fired on 13 of 13 per-PR review cards (false positives), the "escalation sent as a resume" check fires on review cards where a resume is correct, 2 of 8 merge lines carry another session's id, and 1.2M agent tokens are unlogged.

## How records were attributed

| Record | Rule | Count |
|---|---|---|
| Delegations | `task.milestone: security-review` and the Director session | 32 (19 spawns, 13 resumes), all `guidance_version: 1.0.2`, all `tier_source: override` |
| Completions | Same; last line per `agent_id` and `turn` | 37 lines, 32 turns. 5 lines are interim lines of a turn that stopped while its own background work ran; the last line supersedes them |
| Reviews | `milestone: security-review` | 18, with 18 distinct `review_id` values. 15 have `role: review`, 3 have `role: security-review` |
| Merges | `milestone: security-review` | 8, all `via: merge-task`, `gate: ci-wait`, `ci: green`, `outcome: merged`, at the reviewed `match_head`. Two carry session id `03c74903…` (see "Logging defects") |
| Pauses | `milestone: security-review` | 2 pauses, both closed by `user_prompt` |
| Not in the logs | The merge of PR #125 into `main` (the user's); the Director's own token use; `notes`, `escalations` and `tier_fallbacks` (none written) | |

- **Ground truth.** I rebuilt every agent turn from the subagent transcripts of the Director session (read-only), counting usage once per message id. 31 of 32 turns match their completion line to the token. SR-6 attempt 2 is logged 121,104 tokens low (851,627 against 972,731). The 18 verdicts match the hand-back messages in the Director's transcript. So the Director's caveat that tokens and durations might be missing does not apply: the hooks recorded them.
- **Observed settings.** `resolved_model` and `resolved_effort` equal the requested values on 32 of 32 turns. Both escalations were observed at their new setting (haiku at `high`, `claude-fable-5-2` at `high`).
- **Cost.** Dollar figures are estimates at the list-price ratios the earlier reports used: haiku $1/$5, sonnet $3/$15 and opus $5/$25 per M input/output, cache read at 0.1× and cache write at 1.25× input. **No rate for Fable is on record, so Fable is priced at the opus rates and marked "≥".** Use the figures for comparison, not for billing.
- **The merged tree is the reviewed tree.** `git rev-parse` gives the same tree for `dda76dc` (the last reviewed head) and `b5d9a73` (the squash merge on `main`).

## Milestone at a glance

| | This milestone | C `live-data-framework` (0.4.1) |
|---|---|---|
| Project / plugin | plugin repo / 1.0.2 | application / 0.4.1 |
| Tasks / agent turns | 8 (SR-0 to SR-7) plus 2 close reviews / 32 | 10 (+ final) / 40 |
| Agent tokens (incl. cache) | 39.1M logged, 40.3M with the unlogged turns | 26.2M |
| Estimated agent cost | **≈ $34.6**: opus $20.55 (59%), sonnet $10.12 (29%), Fable ≥ $3.08 (9%), haiku $0.83 (2%) | ≈ $23.3 |
| Director session (not logged) | 27.4M tokens on Fable, 123 model calls; ≥ $19.2 at opus rates | not measured |
| Agent-seconds | 17,335 (4 h 49 m) | 7,840 |
| Wall clock | 10 h 07 m, of which 6 h 49 m logged pauses: **3 h 17 m active** (2 h 17 m for the six tasks, 1 h 01 m for the close) | 1 h 48 m active |
| Per-PR first reviews sent back | 2 of 7 | 2 of 9 |
| Final review | 1 major (the Director's `STATUS.md`), 6 minors | 1 major, 5 minors |
| Security review | approve, 8 minors; then changes requested (4 new minors); then approve, 1 minor. `scan: none` | none |
| Verdicts right in the logs | 18 of 18 | 20 of 20 |

**Where the money went.**
- **SR-4: ≥ $10.34, 30%.** Attempt 1 on opus $5.97, its review $0.83, the Fable fix ≥ $3.08, the re-review $0.46.
- **The close: $12.42, 36%.** Final review $4.21 (2 passes), security review $6.87 (3 passes), SR-7 and its two reviews $1.33.
- **Rework: ≈ $12.64, 37%.**
  - Send-back loops: SR-4 ≥ $3.54, SR-6 $0.47.
  - Fold-ins: $2.34 for 12 minor findings.
  - Close rounds after the first two close reviews: $6.29.

## Per task

"Table" is the 1.0.2 table. Tokens include cache. Durations are from delegation to completion and include the reviewers' CI waits (about 240 to 300 s on four re-reviews).

| Task | Type / difficulty | Asked = ran | Attempts and verdicts | Tokens | Est. $ | Agent s | On the table? |
|---|---|---|---|---|---|---|---|
| SR-0 breakdown | breakdown / medium | architect, large (opus) / high | 1; no review | 2.50M | 3.49 | 587 | Yes |
| SR-1 model map | implement / medium | implementer, medium (sonnet) / medium | 1: approve, no findings | 1.23M | 0.93 | 1,389 | Yes |
| SR-2 logger | implement / medium | same | 1: approve, 3 minors → fold-in → approve, 1 new minor (left open) | 2.59M | 1.90 | 2,263 | Yes |
| SR-3 scanner template | implement / medium, flagged security-sensitive | same | 1: approve, 2 minors → fold-in → approve, none | 1.90M | 1.61 | 2,086 | Yes |
| SR-4 Director guidance | implement / hard | attempt 1: architect, large (opus) / high. Attempt 2: architect, xlarge (Fable) / high, new spawn | 1: **changes requested, 1 major**, 5 minors → 2 (escalation): approve, none | 11.50M | ≥ 10.34 | 3,318 | **No, above it.** The row is implementer, medium / high, session |
| SR-5 role files | implement / medium, flagged above-table (declined) | implementer, medium (sonnet) / medium | 1: approve, 7 minors → fold-in → approve, 4 new minors (batched into SR-6) | 3.49M | 2.45 | 2,165 | Yes |
| SR-6 docs, 1.1.0 | docs / medium, flagged above-table (declined) | attempt 1: implementer, small (haiku) / medium. Attempt 2: small (haiku) / high, new spawn | 1: **changes requested, 1 major**, 4 minors → 2 (escalation): approve, none | 4.45M | 1.46 | 1,455 | Yes, and ladder step 2 |
| SR-7 close-review fixes | fix / medium | implementer, medium (sonnet) / medium | 1: approve, 3 minors (PR #127) → sent back by the security reviewer → 2: approve, 3 minors (PR #128) | 1.77M | 1.33 | 1,880 | Yes, and ladder step 1 |
| SR-final | review (milestone final) | reviewer, large (opus) / high | 1: **changes requested, 1 major**, 6 minors → 2 (confirm): approve, none | 3.98M | 4.21 | 1,115 | Yes |
| SR-security | security-review | general-purpose agent with the branch's role file, large (opus) / high | 1: approve, 8 minors → 2: changes requested, severity minor (4 new, 4 restated) → 3: approve, 1 minor | 5.70M | 6.87 | 1,076 | Not in the 1.0.2 table (the user asked for it). It matches the 1.1.0 default row |

All seven per-PR reviews ran on reviewer, medium (sonnet) / high, as the review row says, including the review of the opus architect's PR.

## Per model / effort / task type (tool = claude)

| Group (as ran) | n | First review | Avg tokens | Avg est. $ | Avg s |
|---|---|---|---|---|---|
| opus/high · breakdown (SR-0) | 1 | not reviewed | 2.50M | 3.49 | 587 |
| sonnet/medium · implement/medium (SR-1, 2, 3, 5) | 4 | 4 approve (1 clean; 2, 3 and 7 minors) | 1.10M | 0.72 | 872 |
| sonnet/medium · fix/medium (SR-7) | 1 | approve, 3 minors | 750k | 0.49 | 668 |
| opus/high · implement/hard by the architect (SR-4, above table) | 1 | **changes requested, major** | 7.18M | 5.97 | 1,548 |
| Fable/high · ladder to xlarge, new spawn (SR-4 a2) | 1 | approve on re-review, none | 3.02M | ≥ 3.08 | 1,190 |
| haiku/medium · docs/medium (SR-6) | 1 | **changes requested, major** | 3.06M | 0.63 | 646 |
| haiku/high · ladder step 2, new spawn (SR-6 a2) | 1 | approve on re-review, none | 0.97M (0.85M logged) | 0.21 | 447 |
| sonnet/medium · fold-in resume (SR-2, 3, 5) | 3 | 3 approve on re-review (2 with new minors) | 624k | 0.47 | 565 |
| sonnet/medium · send-back resume (SR-7 a2) | 1 | approve, 3 minors | 469k | 0.26 | 592 |
| sonnet/high · per-PR first review | 7 | 5 approve, 2 changes requested | 528k | 0.45 | 423 |
| sonnet/high · re-review (resume) | 6 | 6 approve | 273k | 0.32 | 219 |
| opus/high · milestone final review | 1 | changes requested, major | 3.00M | 2.81 | 699 |
| opus/high · final reviewer's confirm (resume) | 1 | approve | 988k | 1.41 | 416 |
| opus/high · security review, general agent | 1 | approve, 8 minors | 3.38M | 3.32 | 402 |
| opus/high · security reviewer's confirm (resume) | 2 | 1 changes requested, 1 approve | 1.16M | 1.78 | 337 |

### Pooled with earlier milestones (same model and effort)

| Row | Here | Pooled | Verdict |
|---|---|---|---|
| implement/medium · sonnet/medium, first review passed | 4/4 | 23/26 (19/22 in the hardening report) | keep |
| docs/medium · haiku, first review passed | 0/1 at medium | **1/5**: low 0/2 (SS-8, HD-11), medium 1/3 (AE-4 failed, CW-5 passed, SR-6 failed) | trigger met; see finding 3 |
| Ladder: raise effort one step, fixed on the next review | 1/1 (SR-6) | 8/8 | keep |
| Ladder: large/high → xlarge on the user's yes | 1/1 (SR-4) | 1/1 | insufficient data |
| Fold-in approved on re-review | 3/3 | 18/19 (15/16 in A to C) | keep |
| Above-table flag, started at the table tier, first review passed | 1/2 (SR-5 passed, SR-6 failed) | 5/8 (C 1/2, access-errors 3/4) | keep starting at the table |
| Above-table flag, started above the table, first review passed | 0/1 (SR-4) | 0/1 | insufficient data |
| Final review (opus/high) found a blocker no per-PR review saw | 1/1 | 5/6 | keep |

## Findings

### 1. Routing followed the table (32 delegations; high confidence)

- **Applied.** Every spawn passed `model` and `effort`; every completion shows the same resolved values. There are no `tier_mismatch`, `effort_mismatch` or `uncarded` lines.
- **Ladder.** SR-6's major went to step 2 as a new spawn at the same tier with effort raised (haiku medium → high). SR-4's major at large/high had no automatic step (`models.js up large` exits 1), so the Director logged a pause and asked the user. Both are what the 1.0.2 ladder says.
- **Review rows.** Per-PR reviews stayed on medium/high whatever the author's tier. The sonnet reviewer found the major in the opus architect's PR (1 data point for "use the row as written").
- **Fix PRs at close** got a normal per-PR review, and the close reviewers were resumed on incremental diffs, as "Final-review fixes" says.
- **One vehicle deviation.** SR-4's row says `session`. It ran as a subagent "so the full result block returns to the Director". The table's only allowed reason for that is a missing session tool. It had no visible effect.

### 2. SR-4: the override and the xlarge fix (1 task; low confidence)

**Was the override justified?** The reasons were sound; the evidence that it helped is absent.

- **For it.** SR-4 was the hardest task: 11 files, one home per rule, and a core guidance set that ended at 32,470 of 32,500 bytes. The result held up downstream. The reviewer wrote that "every cut rule keeps a home". The final review had no finding against SR-4's rules, only a stale test description. The two security findings in its files (the security result is not tied to the reported head; the grant lives only in `STATUS.md`) are gaps in decision 0022 itself.
- **Against it.** It still failed its first review with a major: the hard-fix grant fired on a `reject` at any tier, wider than the record allows. It was the most expensive turn of the milestone ($5.97, 7.18M tokens, 25.8 minutes) and set wave 1's critical path; SR-1 to SR-3 were done at least 10 minutes earlier. The same tokens at sonnet rates would be $3.58.
- **The side effect nobody priced.** A task that starts at large/high has no ladder step left. Under the table, a failure at medium/high would have moved to large/high without a question. Here the first failure went straight to "ask the user": a 17 m 44 s pause on the critical path, and then xlarge.
- **Pooled.** Flagged tasks that started at the table passed first review 5 of 8 times; unflagged implement/medium passes 23 of 26. So a flag carries some signal. The one flagged task that started higher failed anyway. That is not enough to say overrides don't help, and not enough to say they do.

**Was xlarge needed for the fix?** Nothing shows that it was.

- **The fix was small.** One clause scoping the grant to "a task that has already failed at large/high", plus three minors: 5 files, 37 lines added, 10 removed.
- **The Director recommended the cheaper option.** Its question to the user marked "Same architect at large/high" as recommended and described the fix as "a one-clause scoping plus four minor findings". The user chose xlarge. That was the user's call to make, and it was applied correctly (new spawn, `reason=escalation`, `billing: credits` logged).
- **What it cost.** 3.02M tokens, 19.8 minutes, ≥ $3.08. 2.87M of the tokens are cache reads: a new spawn has to read the guidance set again. The three warm fold-in resumes in this milestone cost 0.3M to 1.0M tokens and 8 to 11 minutes each. So a same-agent send-back would probably have cost about a third of the tokens and about half the time. That is an estimate, not a measurement.
- **What it delivered.** A clean re-review with no new findings, and three useful follow-ups in its report (ladder step 3 still says "ask the user" with hard-fix granted; whose attempt the granted run is; a wording mismatch between the milestone skill and the STATUS template).
- **No counterfactual.** Every other fix round in this milestone also passed its re-review (SR-6 on haiku/high, three fold-ins and SR-7 attempt 2 on sonnet/medium), and effort raises are 8/8 pooled. Nothing suggests large/high would have failed on a fix whose text the reviewer had all but written.

**What this means for 1.1.0.** With `hard-fix` granted, the 1.1.0 ladder sends the same situation to xlarge/high without asking. That removes the pause but spends xlarge on any first failure of a task that started at large/high, including one-clause fixes. See proposal R3.

### 3. SR-5 and SR-6: declining the flags (2 tasks; low confidence)

**SR-6 (docs/medium on haiku/medium): the failure came from the card, not from the flag.**

- **The flag's reason did not materialize.** The breakdown flagged SR-6 because "the README restates decision 0022's rules". The reviewer checked every README and `docs/codex-mapping.md` statement against the merged files and found none that contradicts them; the four docs findings were minor.
- **The major was in batched test work.** The blocking finding was `tests/guidance-rules.js:388`: the new SV-14 anchor claimed to pin all three causes of `scan: unknown` but passed with "the head moved" deleted. That anchor was one of four leftovers from SR-5's re-review, which the Director put on SR-6's card under "Leftover review findings" together with two rule sentences for `agents/security-reviewer.md`.
- **That went against "Minor findings".** `merging.md` says to batch docs-wording findings into the next docs task. A test anchor and a role-file rule are not docs wording. The table routes `test` work to medium/medium; SR-6 ran it on small/medium.
- **Did declining cost more than it saved?** No, in dollars. Attempt 1 cost $0.63 on haiku; the same tokens on sonnet would be $1.88. The failed review cost a retry of $0.47 and 13.5 minutes on the critical path (first review at 03:31:52Z, merge at 03:45:24Z). So declining saved about $0.8 net and cost about 13 minutes.

**SR-5 (implement/medium on sonnet/medium): passed, but its product drove the close.**

- **It passed first review** with 7 minors, 4 of them real (an unpaginated GitLab jobs call, an undefined `scan` value, a missing blocking-finding rule, shallow test anchors).
- **Its role file then drew findings in every later review that touched it**: 3 from the first security review, 1 from SR-7's review, 4 from the second security pass, 3 from the review of PR #128 and 1 from the third security pass.
- **Would a higher start have avoided that? Unknown.** SR-4 on opus/high also failed its first review. About half of the later gaps were introduced by fix rounds written under a byte budget (the file went from 5,776 to 7,128 bytes and its budget had to be raised to 7,200), not by SR-5's first version. The pattern points at how the `scan` states are specified (prose, patched clause by clause), not at the tier (finding 7).

**The watch list.** The consolidated plan of 2026-11-03 set a trigger: if one or more of the next three docs/medium tasks on haiku/medium gets a major at first review, apply docs/medium → small/high. CW-5 passed and SR-6 failed, so the trigger is met on its face. (AE-4 is counted as the plan reports it; that project's logs are not in this archive.) Two cautions: SR-6's major was in test work, and there is no first attempt at haiku/high on record (0 data points; only retries, 2 of 2 passed). See proposals R1 and R2.

### 4. Fold-ins (3 rounds; medium confidence)

| PR | Minors folded in | Fold-in turn | Incremental review | Round cost | New minors | Minutes added (fold-in plus review) |
|---|---|---|---|---|---|---|
| SR-2 #120 | 3 (1 real, 2 style) | 1.00M tokens, 659 s, $0.65 | 182k, 78 s, $0.21: approve | $0.86 | 1 (timing-based tests; left open) | about 12, off the critical path |
| SR-3 #119 | 2 (both real) | 305k, 581 s, $0.29 | 233k, 29 s, $0.27: approve | $0.56 | 0 | about 10, off the critical path |
| SR-5 #123 | 7 (4 real, 3 wording) | 564k, 456 s, $0.47 | 441k, 354 s, $0.45: approve | $0.92 | 4 (batched into SR-6) | 14.3, **on** the critical path |
| Total | 12 | 1.87M, $1.41 | 0.86M, $0.93 | **$2.34**, 6 turns, 36 agent-minutes | 5 | |

- **Cost per finding fixed:** about $0.20 (C: about $0.12). 7 of the 12 were real defects: a missing skip notice and unpinned job names in the scanner template, an untested retry wait, and four gaps in the security reviewer's role file.
- **A warm resume is not cheap.** SR-2's fold-in used 89% of the tokens of its first attempt (1.00M against 1.13M), because the agent's whole context is read again on every call.
- **Two of three fold-in reviews raised new minors.** The Director did not start a second fold-in round on either PR. That limit is right and is not written down.
- **Is the rule paying for itself?** Yes for SR-2 and SR-3: $1.42, no time on the critical path, real fixes. For SR-5 the fold-in itself was worth it, but what happened to its leftovers was the expensive part: batching them into SR-6 caused SR-6's send-back ($0.47, 13.5 minutes). Keep the rule; add the two limits in proposal M1.

### 5. The close: three rounds on the milestone PR (1 close; medium confidence)

| Round | Time (UTC) | What ran | Result | Est. $ |
|---|---|---|---|---|
| 1 | 10:18 to 10:30 | Final review and security review, in parallel, at `04950d1` | Final: changes requested, 1 major (`STATUS.md`), 6 minors. Security: approve, 8 minors | 6.13 |
| Fix 1 | 10:31 to 10:48 | SR-7 (10 wording and fixture fixes from both reviews), its per-PR review, the Director's `STATUS.md` repair | PR #127 approved with 3 minors, merged | 0.79 |
| 2 | 10:49 to 10:56 | Both close reviewers resumed on `04950d1..64663ac` | Final: approve. Security: **changes requested**, top-level severity minor, 4 new findings on SR-7's wording | 3.22 |
| Fix 2 | 10:55 to 11:10 | SR-7 attempt 2 (PR #128) and its per-PR review | Approved with 3 minors, merged | 0.54 |
| 3 | 11:11 to 11:17 | Security reviewer resumed on `64663ac..dda76dc` | Approve, 1 minor | 1.74 |
| Total | 61 minutes | 5 review turns on PR #125, 2 per-PR reviews, 2 implementer turns | | **12.42** |

- **Review rounds on the milestone PR: three, with five review turns** (final ×2, security ×3) costing $11.08 and 9.69M opus tokens.
- **Only round 1 was forced, and by the Director's own file.** Without the `STATUS.md` corruption, both close reviews would have passed at `04950d1`.
- **Rounds 2 and 3 were a choice.** No rule asked for the 14 non-blocking findings to be fixed before "complete": the security review had approved, and under 1.1.0's "Security results" only `major` or `critical` blocks. Fixing them first cost SR-7 ($0.75), two per-PR reviews ($0.58) and two security passes ($3.55): **about $4.9 and about 40 of the 61 minutes**. A close with only the `STATUS.md` repair and one confirm pass would have cost about $7.5 and about 21 minutes.
- **What the extra rounds bought.** v1.1.0 shipped with "`red` wins", the rule against a decision record exempting itself, and the no-secret-values rule. Whether that was worth 40 minutes is the user's call; the data only says it was not free and that four of the fixes had to be redone once.
- **A confirm pass by a resumed opus reviewer costs about $1.65 however small the diff.** The three confirm passes averaged 1.10M tokens; 144k to 189k of each is the old context being written to the cache again after it expired. A per-PR review on sonnet averaged $0.45.
- **Every round has a floor of two CI cycles** (the fix PR, then the milestone PR), about 4.5 to 5 minutes each.
- **The contradictory block was acted on as written.** The second security pass returned `changes_requested` with top-level `severity: minor` and no blocking finding. The role file defines `major` as blocking, and the ladder says to ask for a corrected block when one contradicts itself. The Director treated it as a send-back (ladder step 1). Asking first would have produced either a `major` with its exploit path (then the round was needed) or an `approve` (then round 3 was optional).
- **`STATUS.md` on `main` is one event behind.** The Director could not record the third security verdict without moving the head again, so the SR-security row still says attempt 2 and "then confirms", and the last finding (the nothing-to-scan exception trusts the job's own notice) is only in the hand-over note. Records that live in the reviewed tree can never contain their own final verdict. See proposal M2.

### 6. Final review against security review: first data for decision 0022 (1 milestone; low confidence)

| | Final review (reviewer, opus/high) | Security review (general agent with the role file, opus/high) |
|---|---|---|
| First pass | 3.00M tokens, 699 s, $2.81 | 3.38M tokens, 402 s, $3.32 |
| All passes | 2 passes, $4.21 | 3 passes, $6.87 |
| Verdict at `04950d1` | changes requested (1 major) | approve (8 minors), `scan: none` |
| Findings | 7 | 8 |
| Found by both | 0 | 0 |
| Kinds | The corrupted `STATUS.md` (major); bridge review rows logged with `tool: claude` and no agent or tier; test fixtures in a shape the agent never emits; a README upgrade note that omits `enabled: false` surviving from a 1.0.2 map; no card field for `security-sensitive`; the "coach at milestone close" row with no close step; a stale test description | A PR can weaken the Trivy scan with its own `trivy.yaml` or `.trivyignore`; `trivy-image` reports success with no Dockerfile; `scan` undefined when some jobs pass and others are skipped; a decision record in the diff can exempt its own weakness; the security result is not tied to the head reported complete; the grant lives only in an agent-writable `STATUS.md`; nothing forbids quoting a secret in a logged finding; a quoted `review-json` fence can forge the logged bridge verdict |
| Real defects / design gaps / wording | 3 / 2 / 2 | 6 / 2 / 0 |
| Coverage recorded | not a field of the general review | 10 items checked, 5 not checked (full suite not run locally, no YAML parser, no live Actions run, behaviour after compaction, `setup-trivy` internals) |

- **Each found what the other did not.** The nearest pair is in `scripts/log-delegation.js` around line 203, where the final review found wrong attribution fields on bridge rows and the security review found that a quoted fence can forge the row. Same code, different defects.
- **The final review found nothing in a security category, and the security review found nothing about consistency or records.** The split of duties in decision 0022 section 2 worked as designed.
- **Per-PR reviews had seen two of the eight at lower depth.** SR-3's reviewer, briefed for CI security, saw the image job going green with no message and asked for a notice. SR-5's reviewer saw `scan` undefined when every job is skipped. The security review found what was left after those fixes. The other six were new.
- **Verdict on this data point:** at large/high the separate pass produced eight findings nobody else produced, six of them about controls, for about the price of the final review. Keep the pass and its default row. **There is no evidence for or against xlarge:** no xlarge security review ran.
- **Three caveats.**
  - The milestone built the security tooling itself (a CI scanner template, the gate's prompt), so there was unusually much for a security reviewer to find. A milestone without that surface may yield less.
  - It ran as a `general-purpose` agent with the role file pasted from the branch, under 1.0.2, and it was reviewing its own role file.
  - The one flagged task (SR-3) got no security review of its own, because the 1.0.2 rules governed. The close review later found 2 minors in SR-3's template. That is the only data on the "flagged task PR" row: 1 task, 2 minor findings that waited until the close.

### 7. Review quality (18 reviews, 54 distinct findings; medium confidence)

**Real defects against wording.** "Real" means the finding names changed behaviour, a control or gate that can be passed wrongly, or a test that cannot fail. For a role file, a case where the prompt gives a wrong or undefined gate value counts as real.

| Reviewer | Reviews | Findings | Real defect | Design gap | Wording, style or a note on another task |
|---|---|---|---|---|---|
| Per-PR reviewer (sonnet/high), first reviews and re-reviews | 13 | 34 | 18 (53%), 2 of them major | 0 | 16 |
| Final reviewer (opus/high) | 2 | 7 | 3, 1 of them major | 2 | 2 |
| Security reviewer (opus/high) | 3 | 13 (plus 4 restated) | 11 | 2 | 0 |
| Total | 18 | 54 | 32 (59%) | 4 | 18 (33%) |

- **The three majors were all real:** the grant scoping in SR-4, the anchor that could not fail in SR-6, and the corrupted `STATUS.md`. No major was withdrawn or disputed.
- **Minors per per-PR first review: 3.4** (24 over 7 reviews). The reviewers list minors as the calibration rules ask.
- **Tests that cannot fail are the recurring class: 10 of 54 findings.** Five of them are text anchors in `tests/guidance-rules.js` that are missing, pin only a heading, or pass when the pinned text is removed (SR-4, SR-5's first review, SR-5's re-review twice, and SR-6's major). The reviewers caught them by deleting the text and running the test. No implementer reported doing that. The implementer's "make it fail first" rule covers failure-path tests, not wording anchors. See proposal A1.
- **Reviewers could not finish the full suite locally in 4 of 7 first reviews** (SR-2, SR-3, SR-4, SR-5: "hit my time cap", "did not finish", "cut off" at 253 tests) and relied on CI. Those four reviews took 307 to 759 s; SR-2's spent 759 s on 274k tokens. The cards did not say how far to verify.

**How often a finding on a fix created the next round.** Ten reviews looked at a fix or a fold-in. Six of them returned new findings (16 new minors). Two of those created more work inside the milestone: SR-5's re-review (4 leftovers batched into SR-6, one of which became SR-6's major) and the second security pass (PR #128).

- On `agents/security-reviewer.md`: **5 of 5** reviews of a fix returned new findings on the file.
- Everywhere else: 1 of 5 (SR-2's timing-based tests).

**The `scan` paragraph.** Nine findings in six reviews concern one paragraph: which of `green`, `red`, `none` and `unknown` applies when scanner jobs fail, pass, are skipped, have nothing to scan, or the head moves. Four gaps are still open in its fourth version (SR-5, the fold-in, PR #127, PR #128). Each fix added a clause that opened the next case.

**Findings the next reviewer contradicted, or reviewers who disagreed with themselves.**

1. **The `tests_run` template (same reviewer, SR-5).** The first review objected that the output template hard-codes `tests_run: false`. The fold-in changed it to `true`/`true`. The re-review objected that `true`/`true` invites an agent that ran nothing to log a pass. The first finding did not say what the template should show.
2. **The `red` against `unknown` precedence (two reviewers, 7 minutes apart).** SR-7's per-PR reviewer found it, rated it minor and approved; PR #127 merged at 10:48:31Z. The security reviewer found the same gap at 10:55:12Z and requested changes. One issue, approved once and sent back once.
3. **The image scan with no Dockerfile (three reviews).** SR-3's reviewer asked for a notice step, and approved the fold-in. The security reviewer then said a green job without a scan reads as a passed check, and asked for "not a passed scan". On the next pass it found that its own rule makes every non-Docker project `unknown` at every close. On the last pass it found that the exception added for that trusts the job's own notice. Each requested fix was the next finding.
4. **The security reviewer's severity (same reviewer, same issue).** In pass 1 it approved with "a decision record in the diff can exempt its own weakness" as a minor. In pass 2 it requested changes over what was left of the same finding, still labelled minor. If a reading "lets a blocking result be avoided", the evidence rule makes it a `major` with its path; if not, it is an approve with minors.

### 8. The Director's own conduct

**What went right (from the logs and the transcript).**
- Cards, settings and reasons on every delegation; flags decided and explained on the `WHY` line; every merge through `merge-task.js` at the reviewed head with green CI.
- Both pauses logged and closed exactly. Runway was read before most waves. The wave at 02:15Z that held the xlarge spawn had no fresh reading; the last one (83%) was 25 minutes old.
- No second fold-in round on SR-2 or SR-5. The user was told about each of the Director's own errors in plain words.
- The hand-over note's claims check out against the logs: heads, verdicts, the eight merges, the archive and the 32,474-byte figure.

**Errors.**

| # | What | Evidence | Cost |
|---|---|---|---|
| 1 | **`STATUS.md` corrupted and never read back.** The fragments on line 1 are what the update script writes when its row pattern matches the empty string at the start of the file. That is what the pattern becomes if its backslashes are lost on the way to node, which is the likely cause (the script as sent has them). Its "row not found" guard then cannot fail. Each update prepended a fragment to line 1 and changed no row | 5 pushes (`a249f17`, `47960cb`, `8409257`, `c76d768`, `04950d1`) over 8.5 hours. The table showed all six tasks as `planned` throughout. The Director told the user twice that `STATUS.md` was up to date or current | The final review's only blocker; a confirm pass ($1.41, 416 s). Had the session compacted, the Director would have re-read a wrong table |
| 2 | **Test and role-file findings batched into the docs task** | SR-6's card, "Leftover review findings"; `merging.md` allows batching docs wording only | SR-6's send-back: $0.47, 13.5 minutes |
| 3 | **A contradictory `review-json` acted on without asking for a corrected one** | Second security pass: `changes_requested`, `severity: minor`, no blocking finding | Round 3: $2.29, about 21 minutes (if the reviewer had answered "approve") |
| 4 | **Close-review minors fixed before "complete"** (a judgement call, not a rule broken) | SR-7 and PR #128 | About $4.9 and 40 minutes (finding 5) |
| 5 | **`reason=` on review cards was inconsistent** | SR-4's re-review card said `escalation` (the Director reported this itself); SR-6's said `sendback` although the attempt was an escalation; SR-security attempt 2 said `sendback` after an approve | Log noise only. The card rules don't say what a re-review card carries (see "Logging defects") |
| 6 | **The last security finding is not in `STATUS.md`** | Only in the hand-over note | A follow-up that could be lost |

**Three things that are costs, not errors.**
- **The Director's context.** 123 model calls on Fable used 27.4M tokens. The context grew from 77k tokens to 335k with no compaction, so every late turn re-read about 300k tokens. 78% of the tokens went to turns triggered by a hand-back.
- **No-op turns.** Seven turns only acknowledged a task notification ("the agent has now fully stopped; that changes nothing"). They cost 2.06M Fable tokens, 7.5% of the Director's total. They happen when an agent hands back while its own background command (a CI wait, a test run) is still running. The same wake-ups cost the agents 1.10M tokens that no log line records.
- **A blocking question with work in flight.** While the SR-4 question was open, the SR-2 and SR-3 fold-ins finished and waited 14 and 16 minutes for their re-reviews. Neither was on the critical path this time.

### 9. Pauses and wall time

| | UTC | Duration |
|---|---|---|
| Session start to the completion report | 01:11:18 to 11:17:55 | 10 h 06 m 37 s |
| Pause 1: SR-4 question to the user | 01:57:01 to 02:14:45 | 17 m 44 s |
| Pause 2: overnight, at the user's request | 03:45:45 to 10:17:11 | 6 h 31 m 25 s |
| **Active wall time** | | **3 h 17 m 28 s** |

- Both pauses were closed by `user_prompt`, so they are exact, not upper bounds. Two fold-in agents kept working for the first 2.5 and 4.7 minutes of pause 1.
- Evening: 2 h 17 m for the breakdown and six tasks. Wave 1 took 58 minutes net of the pause, and SR-4 set it. SR-5 took 37 minutes and SR-6 took 26.
- Morning: 61 minutes for the close.
- Agent time was 4 h 49 m in 3 h 17 m of wall time, a parallelism of 1.5. After wave 1 the plan was a chain (SR-5, then SR-6, then the close).

### 10. Other groups: insufficient data

- **Breakdown on opus/high (SR-0).** 1 here, 4 with the three the earlier reports counted, all held up. Here: 6 tasks, no file clashes between parallel tasks, nothing blocked, for $3.49 and 9.8 minutes.
- **fix/medium on sonnet/medium.** 1 task (SR-7): passed its per-PR review twice.
- **Haiku and the hand-back.** 1 of 2 haiku turns ended without calling the hand-back tool and needed the enforce nudge (SR-6 attempt 2). The nudge worked. The watch item stays open.

## Logging defects

| # | Defect | Evidence | Director error or logger behaviour? | Proposed |
|---|---|---|---|---|
| G15 | `card_drift` on every per-PR review card | 13 of 13 here (7 spawns, 6 resumes); 10 of 28 review lines in the ci-wait milestone. `cardDrift` in `scripts/records.js` compares a card with the first delegation of the same task id, and review cards carry the task's id by convention, so `implement → review` always differs. Unchanged in 1.1.0 | **Logger.** The Director checked the earlier logs and kept the convention, which was right | Skip the comparison when the new card's type is a review type, or compare a review card only with earlier review cards of the same id. Each false warning is also text injected into the Director's context |
| G16 | "Escalation sent as a resume" on a re-review card | 1 line (SR-4 re-review). The check in `cardSettings` fires on any resume with `reason=escalation` | **Both.** The Director's reasons on review cards were inconsistent. But a re-review is always a resume of the same reviewer, and the card rules don't say which reason it carries | Logger: exempt review types. `task-card.md`: a review card repeats the reason of the attempt it reviews; a close reviewer resumed on an incremental diff uses a new value, `confirm` |
| G17 | Merge lines carry the wrong session id | PRs #127 and #128 have `session_id: 03c74903…`, the session that launched the Director. `merge-task.js` reads the id from `.pending/hooks-alive.json`, which any session's start overwrites; the launching session was resumed at about 10:19Z | **Logger.** A session filter would have dropped 2 of 8 merges | Take the session id from the hook input of the shell call that ran the script, or key the marker by session |
| G18 | Agent turns after the hand-back are not logged | 8 wake-ups, 1,099,687 tokens (612k opus, 488k sonnet). SR-6 attempt 2 is 121k low: its only line was written before the enforce-nudge turn | **Logger** | Write a line for every stop of a carded agent, or have `reconcile-logs.js` add them. Also stop the cause (proposal A2) |
| G19 | The Director's own usage is not logged | 27.4M tokens on Fable, about 40% of the milestone's tokens | **Logger gap.** The Coach cannot weigh the Director's cost without the transcript | Have `archive-logs.js` write one `session_usage` line per model from the Director's transcript at close |
| G20 | `security-sensitive` is not a field | SR-3's flag appears only in the free-text `WHY` of two lines | **Guidance gap** (already a follow-up) | A `flags=` key on the TASK line, copied to the delegation line |
| G21 | SR-security logged from `agent: general-purpose` | 3 delegation lines, 3 review rows with `role: security-review` | **Neither.** A stated workaround: the installed 1.0.2 had no such agent. The rows are countable by `role`. Pool them later with `agent-team:security-reviewer` at opus/high, noting the prompt was the branch's role file as of `04950d1` | None |
| G10 (carried) | The milestone PR's merge has no log line | PR #125 was merged by the user | Logger gap, low | As before |
| — | The launch line of the Director session has `child_session: null` | Delegation line of 01:05:42Z, session `03c74903…` | Logger, low | Fill it when the launch tool returns the id |

No `uncarded`, `tier_mismatch` or `effort_mismatch` lines. `escalations.jsonl` got no line; the two escalations are derivable from the delegation lines, as G8 settled.

## Follow-ups in `STATUS.md`: which the logs support

| Follow-up | Support in the logs | Worth a task? |
|---|---|---|
| The close-time security result is not tied to the head reported complete | The Director improvised the answer: two extra security passes ($3.55), the final reviewer's approval one head behind the security reviewer's, `STATUS.md` on `main` one event behind | **Yes, first.** It decides how many rounds a close takes. Proposal M2 |
| The scan-state wording gaps (and the unrecorded "trusts the job's own notice" finding) | 9 findings in 6 reviews on one paragraph, 4 open | **Yes, as a design task** (architect): one state table covering every combination. Another wording patch will draw another round |
| The card-drift warning on every review card | 13 of 13 | **Yes** (G15), small |
| Ladder step 3 against the hard-fix grant; whose attempt the granted run is | 1 task (SR-4) | Yes, wording, with proposal R3 |
| No task-card field for `security-sensitive` | 1 flagged task, invisible to the Coach | Yes, small (G20) |
| The "coach (at milestone close)" row has no close step | This run: the Coach was asked for by the user after the merge, at xlarge/high, not the row's xlarge/medium | Yes, wording (proposal R4) |
| The grant lives only in an agent-writable `STATUS.md` | This run corrupted `STATUS.md` five times with a script. No grant existed in this run, so 0 direct data points | Yes; the corruption shows the file is not a safe single source |
| Bridge review rows (forged fence; `tool: claude`, no agent or tier) | No bridge ran: 0 data points | Yes, **before the first second review runs**, or its rows cannot be compared |
| Scanner template: PR-controlled Trivy config, `trivy-image` success without a Dockerfile, never parsed | 2 reviews list "no YAML parser" and "no live Actions run" under not checked | Yes: one live run in a scratch repo |
| `tests/guidance.test.js` run alone exits 0 on failure | Reviewers ran it alone as their evidence in at least 7 of 18 reviews and read the counts, not the exit code | Yes, small |
| SR-2's timing-based retry tests | 1 minor finding; CI was green on every head | No, not from this data |
| GitLab command not run live; OWASP list is 2021 | Listed under not checked in 2 reviews | Not from these logs |

## Decision 0022, section 4: evidence for the grant table

Open point 1 asks the Coach to review the effort values. One milestone gives this much:

| Row | Ran here | Evidence |
|---|---|---|
| Security review at close, default large/high | 1 review (3 passes), from a general agent | **For the default row:** 8 findings unique to it, 6 about controls, first pass $3.32 and 402 s, coverage recorded. Nothing suggests high effort was wasted; no lower effort ran to compare |
| Security review at close, granted xlarge/high | 0 | None |
| Security review of a flagged task PR | 0 (SR-3 was flagged; the 1.0.2 rules governed) | Indirect only: the close review found 2 minors in SR-3's template that waited until the close |
| Architect, granted xlarge/medium | 0 at xlarge/medium | None. The breakdown at large/high held up |
| Coach, granted xlarge/medium | 0 at xlarge/medium | None. This run is xlarge/high on the user's yes; I cannot assess it myself |
| Hard-fix escalation, xlarge/high | 1 (SR-4 attempt 2), on the user's yes | **It works:** 1 of 1, clean re-review. **Not shown to be needed:** a 47-line fix, 3.02M tokens, 19.8 minutes; the Director had recommended large/high. No evidence about the effort value |

No row has enough data to change. The two things to settle are wording, not values: the hard-fix trigger (R3) and the coach row's label (R4).

## Proposed changes (propose only; nothing applied)

**Budget note.** The core guidance set is at 32,474 of 32,500 bytes, `agents/security-reviewer.md` at 7,128 of 7,200 and `agents/coach.md` at 12,496 of 12,500. Every guidance addition below needs a matching cut or a budget raise under decision 0020. So where a script can carry the fix, the script is proposed first.

### `routing.md` (1.1.0)

**R1. Type a task by its hardest part** (1 task here; docs/medium on haiku 1/5 pooled; candidate).

```diff
 - **Difficulty.** *easy*: clear spec, one area, an existing pattern to copy. *medium*: clear spec, several files or a new pattern. *hard*: unclear cause, cross-cutting, or real design choices inside the task.
+- **Type.** By the hardest part. `docs` is prose only: a task that also edits tests, role files or skills is `test` or `implement`.
```
- SR-6 was carded docs/medium and held test anchors and two role-file rules. Its major was in the anchors. Typed `test`, it would have started on medium/medium.

**R2. docs/medium starts at high effort** (the 2026-11-03 trigger is met; 5 tasks in the category).

```diff
-| docs | medium/hard | implementer | small | medium | subagent (worktree) |
+| docs | medium/hard | implementer | small | high | subagent (worktree) |
```
- Docs/medium on haiku passed first review 1 of 5 times: low 0/2, medium 1/3. Every retry one effort step up passed (2 of 2).
- A failed first review cost $0.47 and 13.5 minutes here; SR-6's whole first attempt on haiku cost $0.63.
- **Weak points.** No first attempt at haiku/high exists (0 data points), SR-6's major was in test work that R1 would have moved, and docs/hard has no data (it only shares the row). If R1 is adopted, it is reasonable to hold R2 and count the next three docs/medium tasks instead. The plan's trigger says to apply it.

**R3. One send-back at large/high before xlarge** (1 task; candidate, and it amends decision 0022's "after large/high fails", so it is the user's decision).

```diff
-3. **Already at high effort:** raise the tier one step with `node "<plugin root>/scripts/models.js" up <tier> --tool <t>`, which skips tiers that are not auto-eligible. Exit 1 means there is none: ask the user.
-4. **Large/high still failing, or a verdict of `reject`:** stop. Send it to `architect` to re-examine the spec, and tell the user if the milestone is at risk. […] With `hard-fix` in the milestone's grant, a task that has already failed at large/high runs its next attempt at xlarge/high without asking. The grant doesn't cover a `reject` at a lower tier.
+3. **Already at high effort:** raise the tier one step with `node "<plugin root>/scripts/models.js" up <tier> --tool <t>`, which skips tiers that are not auto-eligible. Exit 1 means you are at large/high: on the first failure there, send it back once to the same agent; on the next, step 4.
+4. **Large/high failing a second time, or a verdict of `reject`:** stop. Send it to `architect` to re-examine the spec, and tell the user if the milestone is at risk. […] With `hard-fix` in the milestone's grant, a task that has failed twice at large/high runs its next attempt at xlarge/high without asking, as a new spawn of the role that made the failed attempt. The grant doesn't cover a `reject` at a lower tier.
```
- SR-4's first failure at large/high cost a 17 m 44 s pause and then ≥ $3.08 and 19.8 minutes at xlarge, for a fix of 37 added and 10 removed lines that the Director had recommended sending back to the same architect.
- It also settles two open follow-ups: step 3 no longer asks a redundant question when hard-fix is granted, and the granted attempt belongs to the role that failed.
- **If not adopted:** make only the two wording fixes (step 3 ends "go to step 4"; step 4 names whose attempt it is), and count the next tasks that fail at large/high.

**R4. The coach row's label** (wording; 1 run).

```diff
-| coach (at milestone close) | large / high | xlarge / medium |
+| coach (run for this milestone) | large / high | xlarge / medium |
```
- `merging.md`'s close has no Coach step, and this run's Coach was asked for after the merge.

**Rows to keep.** implement/medium at medium/medium (4/4 here, 23/26 pooled); review at medium/high (found both per-PR majors, $0.45 per first review); the final review at large/high; `security-review` at large/high (finding 6); breakdown at large/high. No change to the grant table's values.

### `merging.md` (1.1.0)

**M1. Two limits on fold-ins** (3 fold-in rounds, 1 failed batch).

```diff
 - **Batch** docs-wording findings into the milestone's next docs task, if there is one.
+  Wording only: never a finding on a test, an anchor or a role-file rule.
+- **One round per PR.** Minors from the incremental review become follow-ups.
```

**M2. What happens to non-blocking findings at close, and which head counts as reviewed** (1 close; this is the follow-up "security result not tied to the head").

```diff
 7. Report "complete" only on green, with no blocking security result ("Security results" below). […]
+8. Minor findings from the close reviews go into `STATUS.md` as follow-ups. Fix them before "complete" only if the user asks: each fix PR costs a per-PR review and a confirm pass from each close reviewer on the incremental diff.
+9. The head you report must be one both close reviewers have seen. A head that differs from it only in `STATUS.md` counts as seen.
```
```diff
 ### Security results
+- `changes_requested` with top-level `severity: minor` contradicts itself: ask the reviewer for a `major` with its exploit path, or an `approve`.
```
- Rounds 2 and 3 of this close cost about $4.9 and 40 minutes for non-blocking findings; the `STATUS.md` exemption lets the Director record the last verdict without moving the reviewed head.
- The exemption is only safe together with S1 below.

### `task-card.md`

**T1. The reason on a review card** (3 inconsistent cards of 9 review resumes; with G16).

```diff
 | `reason` | from attempt 2 | `sendback` (changes requested, same settings), `escalation` (new tier or effort), `fold-in` (approved with minors), `retry` (the last turn was cut off). |
+| | on a review card | the reason of the attempt it reviews; `confirm` for a close reviewer resumed on an incremental diff. |
```

**T2. Say how far to verify on every review card** (4 of 7 first reviews could not finish the full suite). The "Review tasks" section already asks for this line. For this repo the line is: "run the test files the diff touches; CI covers the full suite". No text change; a note for the Director.

### Role files

**A1. `agents/implementer.md`, "Tests that prove something"** (5 findings in 4 reviews, 1 of them SR-6's major; the file has 650 bytes free).

```diff
+7. **Wording anchors.** For a test that pins text in a guidance or docs file, delete each pinned phrase in turn and confirm the test fails. Say in the PR body that you did.
```

**A2. `agents/reviewer.md`, `agents/implementer.md`, `agents/security-reviewer.md`** (10 notifications, 7 no-op Director turns costing 2.06M Fable tokens, 1.10M unlogged agent tokens).

```diff
+- Don't hand back while a background command of yours (a CI wait, a test run) is still running: wait for it or stop it first.
```

**A3. `agents/security-reviewer.md`: replace the scan-state prose with a table** (9 findings in 6 reviews, 4 open). A design task for the architect: one row per combination (any failed; any skipped; passed but did not scan; nothing to scan; all nothing to scan; pending; unreadable; head moved, with and without an old failed check; no scanner jobs), each with one `scan` value, `red` first. A table is likely shorter than the current paragraph, which matters at 72 bytes of headroom.

**A4. Additions to "Project lessons" in `agents/security-reviewer.md`.** Each is supported by findings in this milestone. They need about 600 bytes, so they depend on A3 freeing room or on a budget raise.

```diff
 ## Project lessons
 Grows from the Coach's reports. Check each one on every review.
 - Redaction checked on the raw string but not on the serialized form (JSON, repr, log line, exception chain).
+- A check the reviewed change can switch off: scanner config or ignore files, a decision record or exemption added in the same diff, a state block the agent itself writes.
+- A status defined in prose (`scan`, `ci`): list every combination (failed + skipped, passed + skipped, all skipped, nothing to scan, head moved) and check each has one value and the blocking one wins.
+- A job or step that reports success without doing its work (a guarded step skipped inside a green job).
+- Text parsed or logged as a verdict: check which block the parser takes when the reply quotes another.
```

| Lesson | Findings behind it |
|---|---|
| A check the change can switch off | 4: Trivy config files, the in-diff decision record (twice), the grant block in `STATUS.md` |
| A status defined in prose | 9 in 6 reviews |
| Success without doing the work | 4: SR-3's review and all three security passes |
| Text parsed as a verdict | 1: the quoted `review-json` fence |

### Scripts and logger (no guidance bytes)

**S1. A `STATUS.md` helper** (1 incident: 5 corrupted pushes, the final review's only blocker). `scripts/status.js set <ID> --state <s> [--attempt <a>] [--pr <n>] [--tier <t>]` edits one table row by parsing the table. It exits non-zero when the file does not start with `# Status`, the row is missing, or the state is not in the legend. `merge-task.js` can name it in its `next` field. A `--check` mode gives M2's exemption something to rely on. Until it exists, the rule is: read `STATUS.md` back after every write.

**S2. Logger fixes**, in this order: G15 (drift on review cards), G16 (exempt review types; accept `confirm`), G17 (merge session id), G18 (turns after the hand-back), G19 (the Director's usage at archive time), G20 (`flags=`).

**S3. Bridge review rows** (the two `STATUS.md` follow-ups), before the first second security review runs.

## Recommendations (consolidated)

| # | Recommendation | Evidence | Data points | Confidence |
|---|---|---|---|---|
| 1 | **Close rules (M2):** non-blocking close findings become follow-ups unless the user asks; the reported head is one both close reviewers have seen, with a `STATUS.md`-only exemption; a `changes_requested` with severity minor goes back for a corrected block | The close was $12.42 (36%) and 61 minutes in 3 rounds; about $4.9 and 40 minutes came from 14 non-blocking findings; round 3 alone $2.29 | 1 close | Medium |
| 2 | **`STATUS.md` helper script with a check (S1)** | The Director's regex script corrupted line 1 in 5 pushes over 8.5 hours and changed no row; the final review's only blocker | 1 incident, 5 pushes | High that it is needed; it is a bug, not a trend |
| 3 | **Type by the hardest part (R1), no test or role-file findings in a docs task, one fold-in round per PR (M1)** | SR-6's major was a batched test anchor; send-back $0.47 and 13.5 minutes; fold-ins otherwise 3/3 approved for $2.34 | 1 failed batch, 3 fold-ins | Medium |
| 4 | **docs/medium → small/high (R2)**, as the 2026-11-03 trigger says | Docs/medium on haiku 1/5 at first review (medium 1/3); effort raises fixed 2/2 | 5 tasks, 0 first attempts at haiku/high | Low to medium; hold it if R1 is adopted |
| 5 | **One same-agent send-back at large/high before xlarge (R3)** | SR-4: 17 m 44 s pause, then ≥ $3.08 and 19.8 minutes for a 47-line fix the Director recommended sending back | 1 task | Insufficient data; candidate, and the user's decision |
| 6 | **Keep the separate security review at large/high; no change to the grant values; relabel the coach row (R4)** | 8 findings, 0 shared with the final review, 6 about controls, first pass $3.32 against $2.81 | 1 review; 0 at xlarge | Low (1 milestone, unusually security-heavy) |
| 7 | **Scan states as a table, by the architect (A3), then the four Project lessons (A4)** | 9 findings in 6 reviews on one paragraph, 4 open; 5 of 5 fix reviews of that file found something new | 6 reviews | Medium |
| 8 | **Implementer rule for wording anchors (A1)** | 5 anchor findings in 4 reviews, including SR-6's major; all caught by reviewers deleting the text | 4 reviews | Medium |
| 9 | **No hand-back with background work running (A2)** | 7 no-op Director turns (2.06M Fable tokens) and 1.10M unlogged agent tokens | 10 notifications | Medium |
| 10 | **Logger (S2):** review cards exempt from drift and from the escalation-resume check, `confirm` as a reason, session id on merge lines, turns after the hand-back, the Director's usage, `flags=` | 13/13 false drift warnings; 2/8 merge lines misattributed; 1.22M agent tokens and 27.4M Director tokens unlogged | 32 delegations, 8 merges | High (deterministic) |
| 11 | **Keep** implement/medium on sonnet/medium, the review row, the final review and the effort-first ladder | 4/4 here and 23/26 pooled; both per-PR majors found by sonnet/high; effort raises 8/8 | Pooled | Medium to high |
| 12 | **Watch:** above-table starts (0/1 started higher, 5/8 at the table), xlarge security reviews (0), flagged task-PR security reviews (0), the confirm pass by a resumed opus reviewer ($1.65 average, n = 3), haiku and the hand-back tool (1 of 2 needed the nudge) | — | Under 5 each | Insufficient data |

```result-json
{"status": "done", "summary": "Routing was applied as written (32/32) and the logs were right (18/18 verdicts), but 37% of the ≈$34.6 agent cost was rework: the close took 3 review rounds ($12.42, 61 min) where one was forced, and that one by a STATUS.md the Director's own script corrupted; the separate security review found 8 things the final review did not (0 overlap) for about the same price, SR-6 failed on test work batched into a docs task, and SR-4's xlarge fix worked but is not shown to have been needed.", "tasks_analyzed": 10, "recommendations": 12, "report": "docs/coach/2026-11-23-security-review.md"}
```
