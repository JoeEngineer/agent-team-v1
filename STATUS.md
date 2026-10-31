# Status

_Maintained by the Director. Last updated: 2026-10-31_

## Current milestone

**shared-structure** — one plugin folder that serves both Claude Code and Codex, with no behaviour change for Claude users (milestone A of `docs/codex-mapping.md`).
Branch: `milestone/shared-structure` · Issue: #6 · Started: 2026-10-31

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | Issue | PR |
|---|---|---|---|---|---|---|---|
| SS-0 | Breakdown | architect | large (opus) / high | 1 | done | #6 | |
| SS-1 | Split test harness into per-area files | implementer | small (haiku) / medium | 1 | merged | #7 | #17 |
| SS-2 | Root `plugin.json` + manifest sync test | implementer | small (haiku) / medium | 1 | merged | #8 | #21 |
| SS-3 | Model map + `scripts/models.js` resolver | implementer | medium (sonnet) / medium | 2 | merged | #9 | #19 |
| SS-4 | Tool detection, Codex stub, hook matchers | implementer | medium (sonnet) / medium | 2 | merged | #10 | #18 |
| SS-5 | Commands → skills | implementer | medium (sonnet) / medium | 2 | merged | #11 | #20 |
| SS-6 | Tier + resolved model in logs; `tier_fallback` | implementer | medium (sonnet) / medium | 2 | merged | #12 | #22 |
| SS-7 | Routing in tiers; agent `tier:` headers | implementer | medium (sonnet) / medium | 1 | merged | #13 | #23 |
| SS-8 | README + 0.3.0 | implementer | small (haiku) / low | 1 | in progress | #14 | |
| SS-9 | Live verification (Claude + Codex) | implementer | medium (sonnet) / low | | planned | #15 | |
| SS-10 | Milestone final review | reviewer | large (opus) / high | | planned | #16 | |

States: `planned` · `in progress` · `in review` · `changes requested` · `merged` · `blocked`

Dependencies: SS-1 → SS-2…SS-5 (parallel) → SS-6 (needs SS-3, SS-4), SS-7 (needs SS-3) → SS-8 → SS-9 → SS-10.

## Capacity

Before each wave, the Director checks `runway --refresh --json` (Claude 5-hour window and `blockedBy`). Rule set by the user on 2026-10-31: keep going while the 5-hour window has 10% or more left; below 10%, or with anything in `blockedBy`, wait for the window to renew before starting more work.

Last check 2026-10-31 15:21 UTC: 5-hour window renewed (96% left; weekly 25% left) → resumed: SS-6 merged, SS-8 started.

## Blocked

- (none)

## Follow-ups

- SS-7 review: routing.md could mention `models.js resolve <tier> --tool <t>` for getting the model to pass — fold into SS-8.
- SS-6 decision: an agent with `model: inherit` gets its tier from the model that actually ran, not its `tier:` key.
- SS-4: `SubagentStart` hook entry not added (Claude Code acceptance unconfirmed) — check in SS-9.

## Needs the user

- Merge the `milestone/shared-structure` → `main` PR at the end.

## Recent decisions

User decisions at intake (2026-10-31); records are written by the tasks that implement them:
- Delete `commands/`; skills alone provide `/agent-team:<name>` (SS-5, `docs/decisions/0002`).
- Model map is JSON at `config/models.json`, overridden as a whole file by `AGENT_TEAM_MODELS` or `~/.agent-team/models.json` (SS-3, `docs/decisions/0001`).
- Add Codex spawn matchers to `hooks/hooks.json` now (SS-4, `docs/decisions/0003`).
- Commit `STATUS.md` and `docs/decisions/` to this repo; no agent-team section in `CLAUDE.md`; `.agent-team/` stays gitignored.
