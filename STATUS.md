# Status

_Maintained by the Director. Last updated: 2026-11-11_

## Current milestone

**ci-wait**: Stop the Director from spending its own turns waiting on CI, without weakening the green-CI merge gate.
Branch: `milestone/ci-wait` · Issue: #81 · Started: 2026-11-11

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | Issue | PR |
|---|---|---|---|---|---|---|---|
| CW-0 | Breakdown | architect | large (opus) / high | 1 | done | #81 | |
| CW-1 | CI wait helper and forge status | implementer | large (opus) / high | 2 | merged | #82 | #90 |
| CW-2 | Guard tests for auto-merge; fix `2>&1` | architect | large (opus) / high | 3 | changes requested | #83 | #89 |
| CW-3 | Resolve queued auto-merges in the logs | implementer | medium (sonnet) / medium | 1 | in review | #84 | #94 |
| CW-4 | Reviewer and Director prompts | implementer | medium (sonnet) / high | 2 | changes requested | #85 | #91 |
| CW-5 | Setup guidance, README, 0.6.0 | implementer | small (haiku) / medium | 1 | in review | #86 | #93 |
| CW-6 | Live CI harness and transcript metrics | implementer | medium (sonnet) / high | 1 | in review | #87 | #92 |
| CW-7 | Live runs and before/after report | implementer | medium (sonnet) / medium | | planned | #88 | |

States: `planned` · `in progress` · `in review` · `changes requested` · `queued` · `merged` · `blocked`

Waves: W1 CW-1, CW-2, CW-6 → W2 CW-3, CW-4, CW-5 → W3 CW-7 → final review.

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
- User: the milestone final review runs on Fable / high (user-chosen model, outside the routing table). Critical findings get fixed; other findings not implemented are reported to the user.

## Blocked

## Needs the user

- Delete the leftover temp folder `C:\cw6\38888` from an aborted harness run (its PR and branch were cleaned up; the safety check blocked the Director's removal).

## Scratch repo

`JoeEngineer/agent-team-ci-sample` (private): auto-merge on and `sample-ci` required on `milestone/*`, set by the user. The harness preflight passes.
