# Status

_Maintained by the Director. Last updated: 2026-10-31_

## Current milestone

**shared-structure** — one plugin folder that serves both Claude Code and Codex, with no behaviour change for Claude users (milestone A of `docs/codex-mapping.md`).
Branch: `milestone/shared-structure` · Issue: #6 · Started: 2026-10-31

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | Issue | PR |
|---|---|---|---|---|---|---|---|
| SS-0 | Breakdown | architect | large (opus) / high | 1 | done | #6 | |
| SS-1 | Split test harness into per-area files | implementer | small (haiku) / medium | 1 | in progress | #7 | |
| SS-2 | Root `plugin.json` + manifest sync test | implementer | small (haiku) / medium | | planned | #8 | |
| SS-3 | Model map + `scripts/models.js` resolver | implementer | medium (sonnet) / medium | | planned | #9 | |
| SS-4 | Tool detection, Codex stub, hook matchers | implementer | medium (sonnet) / medium | | planned | #10 | |
| SS-5 | Commands → skills | implementer | medium (sonnet) / medium | | planned | #11 | |
| SS-6 | Tier + resolved model in logs; `tier_fallback` | implementer | medium (sonnet) / medium | | planned | #12 | |
| SS-7 | Routing in tiers; agent `tier:` headers | implementer | medium (sonnet) / medium | | planned | #13 | |
| SS-8 | README + 0.3.0 | implementer | small (haiku) / low | | planned | #14 | |
| SS-9 | Live verification (Claude + Codex) | implementer | medium (sonnet) / low | | planned | #15 | |
| SS-10 | Milestone final review | reviewer | large (opus) / high | | planned | #16 | |

States: `planned` · `in progress` · `in review` · `changes requested` · `merged` · `blocked`

Dependencies: SS-1 → SS-2…SS-5 (parallel) → SS-6 (needs SS-3, SS-4), SS-7 (needs SS-3) → SS-8 → SS-9 → SS-10.

## Capacity

Before each wave, the Director checks `runway --refresh --json` (Claude 5-hour window and `blockedBy`):
- more than 40% left in the 5-hour window: start the whole wave;
- 20–40% left: start at most two tasks, and keep the rest for after the window renews;
- under 20% left, or anything in `blockedBy`: `runway wait` (in the background) before starting.

Last check 2026-10-31 12:10 UTC: 5-hour window 34% left (renews 15:20 UTC), weekly 29% left (lasts to renewal).

## Blocked

- (none)

## Needs the user

- Merge the `milestone/shared-structure` → `main` PR at the end.

## Recent decisions

User decisions at intake (2026-10-31); records are written by the tasks that implement them:
- Delete `commands/`; skills alone provide `/agent-team:<name>` (SS-5, `docs/decisions/0002`).
- Model map is JSON at `config/models.json`, overridden as a whole file by `AGENT_TEAM_MODELS` or `~/.agent-team/models.json` (SS-3, `docs/decisions/0001`).
- Add Codex spawn matchers to `hooks/hooks.json` now (SS-4, `docs/decisions/0003`).
- Commit `STATUS.md` and `docs/decisions/` to this repo; no agent-team section in `CLAUDE.md`; `.agent-team/` stays gitignored.
