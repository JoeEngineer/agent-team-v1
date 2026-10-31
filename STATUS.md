||||| 1 | in progress ||||| 1 | in progress ||||| 1 | in progress |||| medium (sonnet) / high | 2 | changes requested || #50 |||||| merged || #47 |||||| merged || #51 |||||| merged || #49 |||||| merged || #48 # Status

_Maintained by the Director. Last updated: 2026-10-31_

## Current milestone

**codex-director**: Codex works fully as Director (milestone B of `docs/codex-mapping.md`).
Branch: `milestone/codex-director` · Issue: #28 · Started: 2026-10-31

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | Issue | PR |
|---|---|---|---|---|---|---|---|
| CD-0 | Breakdown | architect | large (opus) / high | 1 | done | #28 | |
| CD-1 | Live spike: plugin hooks, matchers, skill names | implementer | medium (sonnet) / low | 1 | done | #28 | |
| CD-2 | Review-logging diagnosis | scout | medium (sonnet) / medium | 1 | done | #28 | |
| CD-3 | `models.js up/down` + routing.md | implementer | small (haiku) / medium | 1 | merged | #29 | #48 |
| CD-4 | Extract record helpers to `records.js` | implementer | medium (sonnet) / medium | 1 | merged | #30 | #49 |
| CD-5 | Fix review-logging gaps | implementer | medium (sonnet) / medium | 1 | merged | #31 | #54 |
| CD-6 | Backfill missed records | implementer | medium (sonnet) / medium | 1 | in progress | #32 | |
| CD-7 | Full Codex log parsing | implementer | medium (sonnet) / medium | 1 | in review | #33 | #55 |
| CD-8 | Codex agent TOML generator | implementer | medium (sonnet) / medium | 1 | merged | #34 | #51 |
| CD-9 | Tool-neutral agent prompts; `worktree=` key | implementer | small (haiku) / medium | 1 | merged | #35 | #47 |
| CD-10 | SessionStart marker, Codex matchers, guard | implementer | medium (sonnet) / medium | 1 | merged | #36 | #53 |
| CD-11 | Codex project hooks + shim | implementer | medium (sonnet) / high | | planned | #37 | |
| CD-12 | team-init for Codex + AGENTS.md | implementer | small (haiku) / medium | | planned | #38 | |
| CD-13 | `archive-logs.js` | implementer | medium (sonnet) / high | 2 | merged | #39 | #50 |
| CD-14 | Director Codex section; close step archives | implementer | medium (sonnet) / medium | | planned | #40 | |
| CD-15 | Coach: archive input, Codex records | implementer | small (haiku) / low | | planned | #41 | |
| CD-16 | Codex live test harness | implementer | medium (sonnet) / low | | planned | #42 | |
| CD-17 | codex-mapping.md: close "Still open" | implementer | small (haiku) / low | | planned | #43 | |
| CD-18 | README + 0.4.0 | implementer | small (haiku) / low | | planned | #44 | |
| CD-19 | Live verification, Claude + Codex | implementer | medium (sonnet) / low | | planned | #45 | |
| CD-20 | Milestone final review | reviewer | large (opus) / high | | planned | #46 | |

States: `planned` · `in progress` · `in review` · `changes requested` · `merged` · `blocked`

Waves: W1 CD-3, 4, 8, 9, 13 → W2 CD-5, 7, 10 → W3 CD-6, 11, 15 → W4 CD-12, 14 → W5 CD-16 → W6 CD-17, 18 → CD-19 → CD-20.

Vehicle: tasks the routing table puts in a session (CD-7, CD-11) run as background worktree subagents at the same tier (session unavailable; subagent fallback).

## Decisions at intake

- Codex records share the Claude log files with `tool: "codex"`; `codex-events.jsonl` stays a raw debug log (record 0004, amends 0003).
- `SubagentStart` is not registered: SubagentStop plus the transcript cover it, and each new hook costs Codex users a trust step (record 0007).
- Live tests copy Codex credentials into a temporary Codex home and delete them at cleanup.
- The optional backfill script (CD-6) is in scope.

## Live findings (CD-1, Codex CLI 0.166)

- The CLI does not run plugin hooks, so `team-init` writes project `.codex/hooks.json` (CD-11).
- Matchers are anchored: only `^(?:collaboration)?spawn_agent$` catches `collaborationspawn_agent`. The follow-up tool is `collaborationfollowup_task`; `send_input`/`resume_agent` don't exist.
- Skills are invoked as `$agent-team:<skill>`.
- `task_name` allows only `[a-z0-9_]`, so the link key is e.g. `cd_7_a1`.
- Per-spawn `reasoning_effort` applies when the agent file pins only `model`.
- SessionStart `additionalContext` reaches the model.
- In the unelevated `workspace-write` sandbox `.git` is read-only (no worktree or commit). Needs a re-check under the elevated sandbox (CD-16).

## Follow-ups

- CD-3 review: the xlarge `auto: false` test also has `billing: credits`, so it doesn't isolate the tier rule (minor).
- CD-8 review: `.codex/agents/` is not gitignored yet; CD-12 adds it with team-init.
- Reviewer verdicts for CD-3, CD-4, CD-8 and CD-9 were not captured by the logger (the bug CD-5 fixes); the Director logged notes, and CD-6's backfill should recover them.
- CD-10 review: note in 0007 that SessionStart also fires on resume/clear/compact (batched into CD-17).
- CD-7: the Coach must dedupe delegations by `task_name` + `task.attempt`, preferring `source: "director"` (CD-15).

## Blocked

- (none)

## Needs the user

- Delete the leftover CD-1 test folder (temporary Codex home with a copy of the Codex credentials, throwaway repo); the agent's delete was blocked by a permission check.
