# Status

_Maintained by the Director. Last updated: 2026-11-12_

## Current milestone

**ci-wait**: Stop the Director from spending its own turns waiting on CI, without weakening the green-CI merge gate.
Branch: `milestone/ci-wait` · Issue: #81 · Started: 2026-11-11

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | Issue | PR |
|---|---|---|---|---|---|---|---|
| CW-0 | Breakdown | architect | large (opus) / high | 1 | done | #81 | |
| CW-1 | CI wait helper and forge status | implementer | large (opus) / high | 2 | merged | #82 | #90 |
| CW-2 | Guard tests for auto-merge; fix `2>&1` | architect | large (opus) / high | 3 | merged | #83 | #89 |
| CW-3 | Resolve queued auto-merges in the logs | implementer | medium (sonnet) / medium | 2 | merged | #84 | #94 |
| CW-4 | Reviewer and Director prompts | implementer | large (opus) / high | 4 | merged | #85 | #91 |
| CW-5 | Setup guidance, README, 0.6.0 | implementer | small (haiku) / medium | 2 | merged | #86 | #93 |
| CW-6 | Live CI harness and transcript metrics | implementer | medium (sonnet) / high | 2 | merged | #87 | #92 |
| CW-8 | Harness: milestone-PR CI metric, temp hardening | implementer | medium (sonnet) / medium | 2 | merged | #95 | #96 |
| CW-7 | Live runs and before/after report | implementer | medium (sonnet) / medium | 4 | merged | #88 | #97 |
| CW-9 | List check names in the first merge-gate call | implementer | medium (sonnet) / medium | 2 | merged | #98 | #99 |
| CW-final | Final milestone review | reviewer | Fable (user-chosen) / high | 1 | done: 1 critical, 3 major, 15 minor | #81 | |
| CW-10 | Final-review script fixes: guard `--admin=`, `--queue-check`, reconcile | implementer | large (opus) / high | 2 | merged | #100 | #103 |
| CW-11 | Final-review doc fixes, 0017 items, carried items | implementer | medium (sonnet) / medium | 2 | merged | #101 | #102 |

States: `planned` · `in progress` · `in review` · `changes requested` · `queued` · `merged` · `blocked`

Waves: W1 CW-1, CW-2, CW-6 → W2 CW-3, CW-4, CW-5 → CW-8 → W3 CW-7 → CW-9 (+ live re-run on both tools) → final review (Fable / high, started 2026-11-12) → CW-10 (scripts) ∥ CW-11 (docs) → milestone PR. All tasks merged 2026-11-12; 945 tests pass on the milestone head; no queued merges. Decision 0018: M1 and M3 treated as critical with C1.

Live runs (CW-7): the Director starts the four harness runs as background commands (each takes 20–40 min, longer than an agent's foreground shell cap). The headless Directors use the large tier on both tools (Claude `opus`, Codex `gpt-6.1-sol`) in every run, so before/after compare the same model. A CW-7 implementer analyses the JSON reports and writes the before/after report. Baseline runs (0.5.0, commit 0205ab8) start once CW-8 is merged; the after runs start once CW-4 is merged. Baseline runs started 2026-11-12 03:04 UTC (runs live-20261112t030358-claude-a684 and live-20261112t030359-codex-def4), harness at CW-8 head 5f9153f. After runs (0.6.0, commit 666ce58) started 03:24 UTC: live-20261112t032427-claude-b8d9 and live-20261112t032428-codex-b4c2. Baselines done: Claude 6 CI turns / 469k tokens, 4 foreground --watch, 5/5 reviews pending; Codex 13 CI turns / 760k tokens, 5 pending reviews, reported complete while a check was running. After runs done: Claude 6 CI turns / 466k tokens, Codex 8 / 544k; both 0 --watch, 0 pending reviews, complete after green checks (37 s / 65 s); both miss "≤1 CI turn per task PR" on the first task PR (2 turns), which CW-7 diagnoses. Cleanup left each run's `milestone/live-*` branch (ruleset). CW-9 re-runs (plugin at PR #99 head 54415b1, same harness and models, label `cw9`) started alongside its review. Claude re-run (live-20261112t041015-claude-6cc7): `--names` now shares the first gate call, one gate turn per task PR; the target still reads FAIL (#55, #56: 2) because an end-of-wave reconcile + STATUS bookkeeping turn names both PRs in sed/PR-body text, which the parser counts (CW-7 parser follow-up). 7 CI turns / 564k tokens, 0 --watch, 0 pending, complete +35 s. Codex re-run (live-20261112t041017-codex-f463): 1 CI turn on every task PR (#57, #58, #59, #62, #64), but the target reads FAIL because 6 no-PR reconcile turns are charged; 1 review `pending` without a stated wait (new miss); 12 CI turns / 827k tokens over 91 turns, 5 task PRs; complete +64 s. CW-7 fold-in fixes the parser attribution and diagnoses the pending review.

Vehicle: CW-1 and CW-6 run as background worktree subagents at the table's tier (record 0013). Overrides: CW-2 effort high, CW-4 tier medium (record 0013).

## Decisions at intake

- Live runs use a new scratch repo on GitHub, created by the Director with `gh`. The user turns on "Allow auto-merge" and adds the required check names to its milestone ruleset; the Director does not change repo settings or rules.
- Before/after: the same live harness runs once on 0.5.0 (baseline) and once on the new version, on Claude and on Codex.
- 0011: `scripts/ci-wait.js` waits for CI with its own deadline (both forges, both shells).
- 0012: one call per merge (gate + merge + comment), auto-merge only with named required checks, `head_sha` + `--match-head-commit`, reconcile appends resolution lines, milestone complete only on green PR checks.
- The guard's `2>&1` bug (reads `2` as the PR number; reproduced on main) is fixed in this milestone (CW-2).
- Fold-ins keep their incremental review; only a reviewed head is merged or queued.
- GitLab: unit tests only; no live GitLab run.
- CW-1: `ci-wait.js --once` makes N+2 calls for N PRs on one base (adds the classic-protection lookup) instead of 2 per PR; accepted, since skipping it would change the gate.
- Scratch repo is private (user has Pro/Team). Headless live runs skip permissions inside the temp clone only; the guard hooks still run.
- CW-4: after the one fallback CI wait (Claude background, Codex reviewer re-wait), still pending means tell the user; no further waits.
- 0017: keep the single `--once` check on blocking reviews (marker required); checkpoints only when something is queued; harness reports no-PR turns separately (amends 0016). Confirmed by the user at close (2026-11-12).
- 0016: both after runs missed "≤1 CI turn per task PR" on the first PR only, because of the one-time `--names` call (CW-7). Fix the prompt (CW-9: `--names` shares the first merge-gate call); the target stays as written; re-run live on both tools.
- User: the milestone final review runs on Fable / high (user-chosen model, outside the routing table). Critical findings get fixed; other findings not implemented are reported to the user.

## Final review: not fixed in this milestone (report to the user)

- PowerShell `$LASTEXITCODE` keeps a stale value if `node` can't start; `$LASTEXITCODE = 1;` before the gate would harden it (merging.md ~36; not reproducible).
- GitLab `head_pipeline.sha` isn't compared with the MR head, so just after a push an older pipeline could be read (forge.js ~244; unconfirmed, needs a live GitLab run).
- On a project with no CI, every review waits the 120 s grace before `none` (reviewer.md / ci-wait.js).
- CW-10 review: `git add` exclude-only pathspecs (`':!x.md'`, `':(exclude)x.md'`) and `:/*` / `":(top)*"` still pass the whole-tree check (convenience guard against committing agent worktrees; `git add -n` showed them adding `.claude/worktrees/`).
- CW-10 review: merging.md's head-moved bullet uses the state `merged (head moved)`, which isn't in the template's state list.
- CW-10 review, unconfirmed glab: `glabCancels` passes a numeric project id as `--repo` (likely rejected by glab: a false warning, safe direction); a bare `glab mr merge` may default to auto-merge on recent glab, so it would be logged without `match_head` (needs `glab mr merge --help` on a current glab).

## Carried into the post-final-review fix batch (CW-11)

- SKILL.md:87 still says to put `--names` "on the queue call or the wait/followup call" in the pending case; merging.md and codex.md now say: on the merge call after the green report, or the Claude background wait (CW-9 incremental review).
- tests/ci-docs.test.js no-bare-`;` test should assert it scanned at least one merge example line (CW-9 incremental review).
- 0017: reviewer marker "not waited: changes requested" exact at the start of `summary`; harness records the verdict and accepts `pending` only from a timed-out wait with the time stated or a blocking verdict with the marker.
- CW-7 review: the report's limits paragraph should name the remaining under-count gap (a here-string run through `& $c`, another variable or an alias).
- 0017: run `reconcile-logs.js --merges` checkpoints only when STATUS.md has a `queued` row (SKILL.md, merging.md, codex.md, gitlab.md).

## Blocked

## Needs the user

- Scratch repo: the `protect-milestones` ruleset has "Restrict deletions" on, so the harness can't delete each run's `milestone/live-…` branch (the guard rightly blocks the Director from deleting it too). Either turn that rule off on the scratch repo, or delete the leftover `milestone/live-*` branches by hand after CW-7. They are harmless meanwhile.

## Scratch repo

`JoeEngineer/agent-team-ci-sample` (private): auto-merge on and `sample-ci` required on `milestone/*`, set by the user. The harness preflight passes.

## Follow-ups (not in this milestone)

- Guard, pre-existing: input redirections are not parsed, so `git push origin main<in` is allowed while bash pushes main (CW-2 review; listed in 0015).
- Guard, pre-existing: an escaped double quote inside double quotes can hide a later merge (`"a \"b\" c" && gh pr merge 7`); PowerShell backtick escapes and variables as merge targets aren't modelled (CW-2 architect).
- Guard over-block: a read-only `gh api graphql` query that names `branchProtectionRules` is refused as "changing branch protection".
- CW-2 (0015) refuses harmless glued redirections in git/gh/glab commands (`git diff>x`); the message says to add a space.
- Merge lines record no repo, so a PR merged with `-R other/repo` is reconciled against the current repo (CW-3).
- CW-3 review minors: tests/ci-wait.test.js ~842 recovery control still uses `--call-timeout 1` (same slow-runner flake class); `mergeGates` logs `gh-checks` when both gates precede a merge (cosmetic).
- Live harness parser (CW-7): PR numbers are taken from the whole call, not only the CI part (Codex turn 42 over-counts the milestone PR); a `task_notification` is attached only after a `result` event, so a background CI completion would go undetected. A slow-CI run is needed to see a non-zero notification count.
