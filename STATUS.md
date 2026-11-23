# Status

_Last updated: 2026-11-22. Milestone security-review is a Director run._

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
| SR-1 | Model map `note`, xlarge on by default but never auto, Codex xlarge agent files (#113) | implementer | medium (sonnet) / medium | 1 | planned | |
| SR-2 | Logger and handback check know the security reviewer; bridge reviews are logged (#114) | implementer | medium (sonnet) / medium | 1 | planned | |
| SR-3 | team-init scanner CI template; STATUS template grant block; `security-sensitive` (#115) | implementer | medium (sonnet) / medium | 1 | planned | |
| SR-4 | Director guidance: grant, intake questions, security reviews, blocking rules, second review (#116) | architect | large (opus) / high | 1 | planned | |
| SR-5 | Role files: new `security-reviewer`, reviewer checklist, architect flag, Coach (#117); after SR-1, SR-4 | implementer | medium (sonnet) / medium | 1 | planned | |
| SR-6 | README, docs, "amended by 0022" notes, version 1.1.0 (#118); after SR-1 to SR-5 | implementer | small (haiku) / medium | 1 | planned | |

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked`

Waves: SR-1, SR-2, SR-3, SR-4 in parallel; then SR-5; then SR-6. SR-4 is routed above the table (implement/hard is implementer medium/high): it amends the Director's authorization line and must keep one home per rule across seven files inside the size budgets, which is design work.

## CI

- Required checks on `milestone/*`: not set for this branch
- Auto-merge: not used

## Blocked

- (none)

## Needs the user

- **Not covered by live runs.** The 1.0.1 live runs (`docs/coach/2026-11-13-v1-live.md`) did not cover compaction, the queued and waiting merge paths, or GitLab. The 1.0.2 change to where logs are written was tested with the unit tests only, not in a live Codex session run from a worktree.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0019: one script merges a task PR (accepted by the user 2026-11-13)
- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
- 0021: the guard and the hooks-active line are enabled per project; logs live in the main checkout (asked for by the user 2026-11-20)
