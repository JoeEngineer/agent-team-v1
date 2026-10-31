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
| SS-8 | README + 0.3.0 | implementer | small (haiku) / low | 2 | merged | #14 | #24 |
| SS-9 | Live verification (Claude + Codex) | implementer | medium (sonnet) / low | 1 | done (9 pass, 1 open) | #15 | |
| SS-10 | Milestone final review | reviewer | large (opus) / high | 1 | approved; findings fixed in SS-11 or deferred | #16 | |
| SS-11 | Final-review cleanups | implementer | small (haiku) / medium | 1 | merged | #25 | #26 |

States: `planned` · `in progress` · `in review` · `changes requested` · `merged` · `blocked`

Dependencies: SS-1 → SS-2…SS-5 (parallel) → SS-6 (needs SS-3, SS-4), SS-7 (needs SS-3) → SS-8 → SS-9 → SS-10.

## Capacity

The Director checks remaining plan capacity before each wave and pauses below a threshold the user sets, resuming when the usage window renews. This milestone paused once and resumed after the renewal.

## Blocked

- (none)

## Follow-ups

- SS-7 review: routing.md could mention `models.js resolve <tier> --tool <t>` for getting the model to pass — fold into SS-8.
- SS-6 decision: an agent with `model: inherit` gets its tier from the model that actually ran, not its `tier:` key.
- SS-4: `SubagentStart` hook entry not added. SS-9 found Claude Code 2.1.314 accepts it in a plugin hooks.json (firing not tested) — candidate for milestone B.
- SS-10: `models.js` has tested `ladderUp`/`fallbackDown`/`autoTier` that nothing calls; add CLI commands (e.g. `up`/`down <tier>`) and point routing.md at them — milestone B.
- Open: whether the Codex CLI runs *plugin* hooks (SS-9 could not check without a model run) — milestone B live tests.

## Needs the user

- Merge the `milestone/shared-structure` → `main` PR (open; Director stops here).
- Optional cleanup: the isolated Codex home and temp folder SS-9 left behind (see SS-9 report).

## Recent decisions

User decisions at intake (2026-10-31); records are written by the tasks that implement them:
- Delete `commands/`; skills alone provide `/agent-team:<name>` (SS-5, `docs/decisions/0002`).
- Model map is JSON at `config/models.json`, overridden as a whole file by `AGENT_TEAM_MODELS` or `~/.agent-team/models.json` (SS-3, `docs/decisions/0001`).
- Add Codex spawn matchers to `hooks/hooks.json` now (SS-4, `docs/decisions/0003`).
- Commit `STATUS.md` and `docs/decisions/` to this repo; no agent-team section in `CLAUDE.md`; `.agent-team/` stays gitignored.
