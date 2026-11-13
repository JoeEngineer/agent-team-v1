# Status

_Last updated: 2026-11-13. This milestone was done by one Claude session working inline (no Director run, no delegation, no reviewer pass), at the user's request while they were away._

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

- **Merge #107 (1.0.1).** The live CI-wait harness was run on 1.0.0 on 2026-11-13 (Claude and Codex). It found three wording regressions, fixed in #107, which also holds the report (`docs/coach/2026-11-13-v1-live.md`). On 1.0.1 both Directors complete the test milestone. Not covered by those runs: compaction, the queued and waiting merge paths, GitLab.
- **Harness parser follow-up.** `tests/live/ci-turns.js` counts script names inside task-card text piped to `log-event.js` as CI turns (Codex runs). Not changed; it needs its own task.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0019: one script merges a task PR (accepted by the user 2026-11-13)
- 0020: guidance in layers, one home per rule, size budgets (accepted by the user 2026-11-13)
