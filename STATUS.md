# Status

_Last updated: 2026-11-23. Milestone security-review is a Director run._

## Since the milestone

| Version | Change | PR | Merged | Tag |
|---|---|---|---|---|
| 1.0.1 | Three wording fixes from the live runs, and the live-run report | #107 | 2026-11-14 | `v1.0.1` |
| (docs) | Antigravity mapping from the live spike (`docs/antigravity-mapping.md`) | #108 | 2026-11-19 | |
| 1.0.2 | The guard and the hooks-active line act only in projects set up for agent-team; logs go to the main checkout when run from a git worktree (decision 0021) | #109 | 2026-11-21 | `v1.0.2` |

## Current milestone

**security-review**: implement decision 0022 in full (a `security-reviewer` agent, the reviewer's security checklist, the `security-sensitive` flag, a mandatory security review at milestone close, the per-milestone xlarge grant, a plan-neutral model map, the optional second security review through the Codex bridge). Version 1.1.0.
Branch: `milestone/security-review` (from `main` at 41814ee) · Issue: #112 · Started: 2026-11-22

This run follows the installed 1.0.2 rules: xlarge needs the user's yes per task, and there is no security-review step yet. The new rules apply after this milestone merges. One exception the user asked for on 2026-11-22: a security review at close, run with the new `security-reviewer` role file from the branch (large / high, as a general agent, because the installed plugin has no such agent yet).

Previous milestone: **v1** (1.0.0), merged into `main` as #105 on 2026-11-13 (tag `v1.0.0`).

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |
|---|---|---|---|---|---|---|
| SR-0 | Breakdown | architect | large (opus) / high | 1 | done | |
| SR-1 | Model map `note`, xlarge on by default but never auto, Codex xlarge agent files (#113) | implementer | medium (sonnet) / medium | 1 | merged | #121 |
| SR-2 | Logger and handback check know the security reviewer; bridge reviews are logged (#114) | implementer | medium (sonnet) / medium | 2 (fold-in) | merged | #120 |
| SR-3 | team-init scanner CI template; STATUS template grant block; `security-sensitive` (#115) | implementer | medium (sonnet) / medium | 2 (fold-in) | merged | #119 |
| SR-4 | Director guidance: grant, intake questions, security reviews, blocking rules, second review (#116) | architect | attempt 1 large (opus) / high; attempt 2 xlarge (fable) / high on the user's yes for this task | 2 (escalation) | merged | #122 |
| SR-5 | Role files: new `security-reviewer`, reviewer checklist, architect flag, Coach (#117) | implementer | medium (sonnet) / medium | 2 (fold-in) | merged | #123 |
| SR-6 | README, docs, "amended by 0022" notes, version 1.1.0 (#118) | implementer | attempt 1 small (haiku) / medium; attempt 2 small (haiku) / high | 2 (escalation) | merged | #124 |
| SR-7 | Fold in minor findings from the final and security reviews (#126) | implementer | medium (sonnet) / medium | 1 | merged | #127 |
| SR-final | Final review of the milestone PR | reviewer | large (opus) / high | 1 | changes requested on `STATUS.md` (repaired), then confirmed on the incremental diff | #125 |
| SR-security | Security review of the milestone PR | general agent with `agents/security-reviewer.md` from the branch | large (opus) / high | 1 | approve, `scan: none` (no scanner in this repo's CI), eight minor findings | #125 |

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked`

All tasks are merged. Milestone PR: #125 into `main` (opened 2026-11-23). The final review and the security review ran on it at 04950d1; SR-7 folded in their cheap minor findings, and both reviewers then confirm the incremental diff (verdicts are in the logs and in comments on the PR). Only the user merges it.

Waves: SR-1, SR-2, SR-3, SR-4 in parallel; then SR-5; then SR-6. SR-4 is routed above the table (implement/hard is implementer medium/high): it amends the Director's authorization line and must keep one home per rule across seven files inside the size budgets, which is design work.

## CI

- Required checks on `milestone/*`: none set. The head runs `test (ubuntu-latest, node 18)`, `test (ubuntu-latest, node 26)`, `test (windows-latest, node 18)`, `test (windows-latest, node 26)`; the user was asked on 2026-11-22 to add them as required checks
- Auto-merge: not allowed on the repo

## Blocked

- (none)

## Needs the user

- **Required checks on `milestone/*`.** Add the four `test (...)` checks as required status checks with no bypass list, and turn on "Allow auto-merge" (asked 2026-11-22).
- **After the milestone merges:** tag and release 1.1.0 if wanted; update the installed plugin so the new rules apply.
- **Follow-ups from the close-time reviews, not fixed in this milestone:** the close-time security result is not tied to the head reported complete (`merging.md`); the xlarge grant lives only in an agent-writable `STATUS.md` block with no cross-check against `milestones.jsonl`; a quoted `review-json` fence in a bridge reply can forge the logged second-review verdict (`log-delegation.js`); bridge review rows in `reviews.jsonl` say `tool: claude` with no `agent` or tier; no task-card field carries the `security-sensitive` flag; the grant row "coach (at milestone close)" refers to a close step that does not exist; the scanner template lets a PR weaken the scan with its own `trivy.yaml` or `.trivyignore`, and `trivy-image` reports success without a root Dockerfile; `red` versus `unknown` precedence in the security reviewer's scan states.
- **Follow-ups from this milestone, not fixed in it:** ladder step 3 still says "ask the user" with hard-fix granted; the guidance does not say whether the granted xlarge attempt is the architect's or the implementer's; the logger reports card drift on every review card that carries its task's id; `tests/guidance.test.js` run on its own exits 0 on failure; the SR-2 retry tests are timing-based; the security reviewer's GitLab command has not run against a live GitLab; its OWASP list is the 2021 edition; the scanner workflow template has not been through a YAML parser.
- **Not covered by live runs.** The 1.0.1 live runs (`docs/coach/2026-11-13-v1-live.md`) did not cover compaction, the queued and waiting merge paths, or GitLab. The 1.0.2 change to where logs are written was tested with the unit tests only, not in a live Codex session run from a worktree.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0019: one script merges a task PR (accepted by the user 2026-11-13)
- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
- 0021: the guard and the hooks-active line are enabled per project; logs live in the main checkout (asked for by the user 2026-11-20)
- 0022: a security review at every milestone close, and a per-milestone xlarge grant (accepted by the user 2026-11-22; implemented in 1.1.0 by this milestone)
