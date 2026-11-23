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
| FU-0 | Breakdown | architect | xlarge (fable) / medium, granted | 1 | in progress | |

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked`

## xlarge grant

- Granted roles: security reviews, architect, hard-fix escalation
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
- **Not covered by live runs.** The 1.0.1 live runs (`docs/coach/2026-11-13-v1-live.md`) did not cover compaction, the queued and waiting merge paths, or GitLab. The 1.0.2 change to where logs are written was tested with the unit tests only, not in a live Codex session run from a worktree.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
- 0021: the guard and the hooks-active line are enabled per project; logs live in the main checkout (asked for by the user 2026-11-20)
- 0022: a security review at every milestone close, and a per-milestone xlarge grant (accepted by the user 2026-11-22; implemented in 1.1.0)
- 0023: one same-agent send-back at large/high before xlarge; amends 0022 (chosen by the user 2026-11-23)
