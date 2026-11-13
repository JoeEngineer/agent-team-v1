# Status

_Last updated: 2026-11-13. This milestone was done by one Claude session working inline (no Director run, no delegation, no reviewer pass), at the user's request while they were away._

## Current milestone

**v1**: Rewrite the guidance for all roles to be shorter without losing intent, so it costs less context and survives compaction. Version 1.0.0.
Branch: `milestone/v1` (from `main` at 03fd01f) · Issue: none · Started: 2026-11-13

Previous milestone: **ci-wait** (0.6.0), merged into `main` as #104.

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |
|---|---|---|---|---|---|---|
| V1-1 | `scripts/merge-task.js`: gate, merge, comment and log in one call; guard check; tests | (inline) | Fable 5.2 | 1 | done, not reviewed | |
| V1-2 | Director `SKILL.md` and references rewritten in layers, one home per rule | (inline) | Fable 5.2 | 1 | done, not reviewed | |
| V1-3 | Role files: `reviewer`, `implementer` tightened; `coach` regrouped by log file | (inline) | Fable 5.2 | 1 | done, not reviewed | |
| V1-4 | SessionStart note after a compaction | (inline) | Fable 5.2 | 1 | done, not reviewed | |
| V1-5 | Rule inventory, size budgets and single-source tests replace the sentence-matching tests | (inline) | Fable 5.2 | 1 | done, not reviewed | |
| V1-6 | 1.0.0 manifests, README, `docs/guidance.md`, decisions 0019 and 0020, live-harness parser | (inline) | Fable 5.2 | 1 | done, not reviewed | |

States: `planned` · `in progress` · `in review` · `waiting CI` · `queued` · `changes requested` · `merged` · `blocked`

Result: `node tests/run.js` passes on the branch head. What a Claude + GitHub Director loads fell from 42.1 KB to 28 KB; `SKILL.md` from 14.1 KB to 8.1 KB.

## CI

- Required checks on `milestone/*`: not set for this branch
- Auto-merge: not used

## Blocked

- (none)

## Needs the user

- **Review the branch.** Nothing was pushed and no PR is open. Decisions 0019 and 0020 are marked `proposed`.
- **Behaviour changes to accept or reject** (decision 0019): a queued PR is commented on when queued, not after it merges; queueing on pending CI is automatic when the queue check passes; `merge-task.js` merges into `milestone/*` only.
- **Live verification.** The rewrite was checked against the rule inventory and unit tests only. Run `tests/live/` on Claude and Codex and compare `guidance_version` 0.6.0 with 1.0.0 before using 1.0.0 for a real milestone.
- **Codex projects** must re-run `scripts/codex-agents.js` after upgrading.

## Recent decisions

- 0019: one script merges a task PR (proposed)
- 0020: guidance in layers, one home per rule, size budgets (proposed)
