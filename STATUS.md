# Status

_Last updated: 2026-11-21. The v1 milestone was done by one Claude session working inline (no Director run, no delegation, no reviewer pass), at the user's request while they were away. The changes after it were made the same way._

## Since the milestone

| Version | Change | PR | Merged | Tag |
|---|---|---|---|---|
| 1.0.1 | Three wording fixes from the live runs, and the live-run report | #107 | 2026-11-14 | `v1.0.1` |
| (docs) | Antigravity mapping from the live spike (`docs/antigravity-mapping.md`) | #108 | 2026-11-19 | |
| 1.0.2 | The guard and the hooks-active line act only in projects set up for agent-team; logs go to the main checkout when run from a git worktree (decision 0021) | #109 | 2026-11-21 | not tagged yet |

## Current milestone

**v1**: Rewrite the guidance for all roles to be shorter without losing intent, so it costs less context and survives compaction. Version 1.0.0.
Branch: `milestone/v1` (from `main` at 03fd01f) · Issue: none · Started: 2026-11-13 · **Merged into `main` as #105 on 2026-11-13** (tag `v1.0.0`)

Previous milestone: **ci-wait** (0.6.0), merged into `main` as #104.

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |
|---|---|---|---|---|---|---|
| V1-1 | `scripts/merge-task.js`: gate, merge, comment and log in one call; guard check; tests | (inline) | Fable 5.2 | 1 | merged (#105) | |
| V1-2 | Director `SKILL.md` and references rewritten in layers, one home per rule | (inline) | Fable 5.2 | 1 | merged (#105) | |
| V1-3 | Role files: `reviewer`, `implementer` tightened; `coach` regrouped by log file | (inline) | Fable 5.2 | 1 | merged (#105) | |
| V1-4 | SessionStart note after a compaction | (inline) | Fable 5.2 | 1 | merged (#105) | |
| V1-5 | Rule inventory, size budgets and single-source tests replace the sentence-matching tests | (inline) | Fable 5.2 | 1 | merged (#105) | |
| V1-6 | 1.0.0 manifests, README, `docs/guidance.md`, decisions 0019 and 0020, live-harness parser | (inline) | Fable 5.2 | 1 | merged (#105) | |

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked`

Result: `node tests/run.js` passes on the branch head. What a Claude + GitHub Director loads fell from 42.1 KB to 28 KB; `SKILL.md` from 14.1 KB to 8.1 KB.

## CI

- Required checks on `milestone/*`: not set for this branch
- Auto-merge: not used

## Blocked

- (none)

## Needs the user

- **Tag and release `v1.0.2`.** #109 is on `main` and the manifests say 1.0.2, but there is no tag or GitHub release yet. Only the user creates releases (the guard blocks `gh release create`).
- **Not covered by live runs.** The 1.0.1 live runs (`docs/coach/2026-11-13-v1-live.md`) did not cover compaction, the queued and waiting merge paths, or GitLab. The 1.0.2 change to where logs are written was tested with the unit tests only, not in a live Codex session run from a worktree.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0019: one script merges a task PR (accepted by the user 2026-11-13)
- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
- 0021: the guard and the hooks-active line are enabled per project; logs live in the main checkout (asked for by the user 2026-11-20)
