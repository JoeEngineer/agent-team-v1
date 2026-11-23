# Status

_Last updated: 2026-11-23. Milestone coach-followups is a Director run under 1.1.0._

## Since the milestone

| Version | Change | PR | Merged | Tag |
|---|---|---|---|---|
| 1.0.1 | Three wording fixes from the live runs, and the live-run report | #107 | 2026-11-14 | `v1.0.1` |
| (docs) | Antigravity mapping from the live spike (`docs/antigravity-mapping.md`) | #108 | 2026-11-19 | |
| 1.0.2 | The guard and the hooks-active line act only in projects set up for agent-team; logs go to the main checkout when run from a git worktree (decision 0021) | #109 | 2026-11-21 | `v1.0.2` |
| 1.1.0 | Milestone security-review: decision 0022 (security reviewer, security review at close, per-milestone xlarge grant, plan-neutral model map) | #125 | 2026-11-23 | `v1.1.0` |
| (docs) | Coach report for milestone security-review (`docs/coach/2026-11-23-security-review.md`) | #129 | 2026-11-23 | |

## Current milestone

**coach-followups**: act on the Coach report for milestone security-review. Make the close and the records cheaper and safer, and close the security reviewer's open gaps. Version 1.2.0.
Branch: `milestone/coach-followups` (from `main` at 9c47e4c) · Issue: #130 · Started: 2026-11-23

In scope:
- **Records and logger:** S1 `scripts/status.js` with `--check`; S2 G15–G20; `tests/guidance.test.js` exits non-zero on failure.
- **Close and card rules:** M2, M1, T1 (`confirm`), R1, R3 (decision 0023), R4, A1, A2.
- **Security reviewer:** A3 scan-state table (architect design), A4 project lessons, the forged `review-json` fence, bridge review row attribution, the grant cross-checked against `milestones.jsonl`, and the Trivy config and no-Dockerfile gaps in the scanner template.

Out of scope: R2 (held; count the next three docs/medium tasks), a live run of the scanner template, live GitLab, the OWASP list edition, the SR-2 timing-based tests, and the `tests/live/ci-turns.js` parser.

Previous milestone: **security-review** (1.1.0), merged into `main` as #125 on 2026-11-23 (tag `v1.1.0`).

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |
|---|---|---|---|---|---|---|
| FU-0 | Breakdown | architect | xlarge (fable) / medium, granted | 1 | done | |
| FU-1 | `scripts/status.js` set and `--check` (#131) | implementer | medium (sonnet) / medium; attempt 2 medium (sonnet) / high | 2 (escalation) | merged | #147 |
| FU-2 | Scan-state table design, decision 0024 (#132) | architect | xlarge (fable) / medium, granted | 1 | merged | #145 |
| FU-3 | Logger: review cards, `flags=`, `confirm`, verdict conflict (#133) | implementer | medium (sonnet) / medium; attempt 2 medium (sonnet) / high | 2 (escalation) | merged | #148 |
| FU-4 | A test file run alone exits non-zero (#134) | implementer | medium (sonnet) / medium | 1 | merged | #146 |
| FU-5 | Usage at archive time: G18, G19 (#135) | implementer (subagent; session unavailable) | medium (sonnet) / high | 1 | merged | #149 |
| FU-6 | `status.js --check --since` and `grant`; security-sensitive (#136) | implementer | medium (sonnet) / medium | 1 | in progress | |
| FU-7 | Merge-line session id from the calling shell, G17 (#137) | implementer | small (haiku) / medium | 1 | in review | #153 |
| FU-8 | `review-json` fence forgery, bridge rows; security-sensitive (#138) | implementer (subagent; session unavailable) | medium (sonnet) / high | 1 | in progress | |
| FU-9 | Role files: scan table, A4, A1, A2 (#139) | implementer | medium (sonnet) / medium | 2 (fold-in) | merged | #152 |
| FU-10 | Scanner template: base config, image job; security-sensitive (#140) | implementer | medium (sonnet) / medium; attempt 2 medium (sonnet) / high; attempt 3 large (opus) / high | 3 (escalation) | changes requested | #151 |
| FU-11 | `routing.md`, `task-card.md`: R1, R3, R4, T1, flags, grant (#141) | implementer (session) | medium (sonnet) / high | 1 | planned | |
| FU-12 | `merging.md`, `SKILL.md`: M1, M2, status.js pointer (#142) | implementer | medium (sonnet) / medium | 1 | planned | |
| FU-13 | Coach reads the new fields (#143) | implementer | medium (sonnet) / medium | 1 | planned | |
| FU-14 | Release 1.2.0 (#144) | implementer | medium (sonnet) / medium | 1 | planned | |
| FU-15 | A test file run alone still exits 0 when the code under test calls `process.exit` (follow-up to FU-4) (#150) | implementer | small (haiku) / medium | 1 | done: closed, not reproducible (the FU-1 branch predates FU-4; no change) | |

Waves: 1 = FU-1 to FU-5; 2 = FU-6, FU-7, FU-8, FU-9, FU-10; 3 = FU-11; 4 = FU-12; 5 = FU-13, FU-14. The guidance tasks are a chain (FU-9 → FU-11 → FU-12 → FU-13): they share `tests/guidance-rules.js` and the core budget. FU-8 and FU-11 were flagged above-table by the breakdown; declined (start at the table, per the Coach's 5/8 against 0/1). Each per-PR review: reviewer, medium (sonnet) / high. FU-6, FU-8 and FU-10 also get a security-reviewer pass at large (opus) / high.

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked` · `done`

## xlarge grant

- Granted roles: security reviews, architect, hard-fix escalation (the user narrowed security reviews of flagged task PRs to large/high on 2026-11-23; the close review stays xlarge/high)
- xlarge model and note per tool: Claude: fable, "included, limited, or billed as credits, depending on your plan" · Codex: gpt-6.2-astra, same note
- Map source: default
- Second security review: large/high

## CI

- Required checks on `milestone/*`: none set. The head runs `test (ubuntu-latest, node 18)`, `test (ubuntu-latest, node 26)`, `test (windows-latest, node 18)`, `test (windows-latest, node 26)`; the user was asked on 2026-11-22 to add them as required checks
- Auto-merge: not allowed on the repo

## Blocked

- (none)

## Needs the user

- **Required checks on `milestone/*`.** Add the four `test (...)` checks as required status checks with no bypass list, and turn on "Allow auto-merge" (asked 2026-11-22).
- **Follow-ups not in this milestone:** the scanner workflow template has not been through a YAML parser or a live Actions run; the security reviewer's GitLab command has not run against a live GitLab; its OWASP list is the 2021 edition; the SR-2 retry tests are timing-based.
- **Follow-ups from FU-2 (decision 0024), minor:** `noscan` and `unconfirmed` differ only in the matrix and evaluator (one rule in the section text); with several GitLab pipelines per SHA, whether a job absent from one counts as missing is unstated (safe reading: yes, `unknown`); one over-long line in "Cost of the read".
- **Follow-ups from FU-5 (PR #149), minor:** a superseding completion line keeps the old `duration_ms`; `markStale` skips superseding copies too (archive-first on a 0.3.0-era mislabelled resume could keep a stale copy); `supersedeShortTurns` covers agents of earlier milestones in the live log; no test for a `readFileSync` failure in `readSessionUsage`; reconcile and archive word the `completions:` line differently. Carried into later cards: `session_usage` is cumulative per session and model (readers take the last line per session+model) → FU-13; README and Coach text for `sessions.jsonl` → FU-13, FU-14.
- **Follow-up from FU-1 (PR #147), minor:** the real-symlink branch of the "refuses a symlink" test in `tests/status.test.js` is skipped silently where symlinks cannot be made; log the skip so CI shows it ran on ubuntu.
- **Follow-up from FU-9 (PR #152), minor:** the evaluator row-count test in `tests/scan-table.test.js` takes the highest row the matrix reaches, so it repeats "every row is hit" and would not catch a ninth unreached evaluator row.
- **Not covered by live runs.** The 1.0.1 live runs (`docs/coach/2026-11-13-v1-live.md`) did not cover compaction, the queued and waiting merge paths, or GitLab. The 1.0.2 change to where logs are written was tested with the unit tests only, not in a live Codex session run from a worktree.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
- 0021: the guard and the hooks-active line are enabled per project; logs live in the main checkout (asked for by the user 2026-11-20)
- 0022: a security review at every milestone close, and a per-milestone xlarge grant (accepted by the user 2026-11-22; implemented in 1.1.0)
- 0023: one same-agent send-back at large/high before xlarge; amends 0022 (chosen by the user 2026-11-23)
- 0025: guidance budget raises for 1.2.0 (approved by the user 2026-11-23). Reserved: 0024 scan-state table (FU-2), 0026 grant cross-check, first line wins (FU-6), 0027 scanner template (FU-10)
