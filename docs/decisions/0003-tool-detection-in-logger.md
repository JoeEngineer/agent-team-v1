# 0003: Tool detection in the logger

Status: accepted

## Context
The same hook scripts now receive events from Claude Code and Codex. Claude
handling must not change. See `docs/codex-mapping.md` ("Hooks", "Live test
results") for the captured Codex payloads.

## Decision
- `lib.detectTool(input, env)` returns `claude` or `codex`.
  1. `AGENT_TEAM_TOOL=claude|codex` wins (escape hatch).
  2. Codex if `tool_name` is Codex-only or the input has a `turn_id`. Names
     starting with `mcp__` are never Codex by name. Codex-only names are
     `^collaboration`, exact `^spawn_agent$`, or one of `send_input`,
     `resume_agent`, `wait_agent`, `close_agent`, `list_agents`, `apply_patch`.
     `turn_id` counts when present and not null.
  3. Otherwise Claude, which keeps today's behaviour, including for garbage or
     empty input.
- `model` is not a signal (both tools may send it). `Bash` alone is not a
  signal (Codex reports shell as `Bash` too).
- Codex events go to a separate `codex-events.jsonl`, never `delegations.jsonl`,
  so the Coach's data stays clean. `scripts/codex-log.js` filters which Codex
  events it logs separately: PreToolUse/PostToolUse for `spawn_agent$`,
  `^send_input$`, `^resume_agent$`, `^wait_agent$`, `^close_agent$`, and
  SubagentStart/SubagentStop. For now only delegation-related events are
  logged; Codex merge logging comes later.
- `tool_input.message` is never logged: it is encrypted on Codex.
- The logger matchers in `hooks/hooks.json` gain the Codex spawn/messaging
  tool names now (decided at intake). Command strings are unchanged. Codex users
  re-trust the hooks once after updating.
- `SubagentStart` is not registered yet, because Claude Code support for it was
  not confirmed.

## Risk
If Claude Code ever sends `turn_id`, its events would be misrouted to the Codex
handler. Mitigations: set `AGENT_TEAM_TOOL=claude`, and the tests pin
Claude-shaped inputs to `claude` so a change in detection shows up.
