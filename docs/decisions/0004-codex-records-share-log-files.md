# 0004: Codex records share the log files

Status: accepted. Amends 0003 (its "separate file" clause and its tool list).

## Context
0003 sent Codex events only to `codex-events.jsonl` so the Coach's data stayed
clean. That left Codex work invisible to the Coach. Live runs on Codex CLI 0.166
(see `docs/codex-mapping.md`) showed what the hooks can and cannot see: the
spawn `message` is encrypted, so the task card is unreadable, but `task_name` is
plain text and the subagent transcript carries the same name in
`session_meta.agent_path`. Decided with the user at intake.

## Decision
- **Shared files.** Codex delegations, completions, reviews and merges go into
  the same `delegations.jsonl`, `completions.jsonl`, `reviews.jsonl` and
  `merges.jsonl` as Claude's, with `tool: "codex"`. 0003's separate-file clause
  no longer applies to these records.
- **`task_name` convention.** `task_name` allows only `[a-z0-9_]` and must be
  unique per session. Use `<task id lowercased, "-" replaced by "_">_a<attempt>`,
  e.g. `CD-7` attempt 1 is `cd_7_a1`. The spawn response is
  `{"task_name":"/root/<name>"}`. Hooks link everything by this name.
- **Director-first logging.** The Director writes the task card itself, before
  spawning, with `log-event.js delegation '{"card":"TASK ...","tool":"codex","task_name":"..."}'`
  (and `log-event.js review ...`). Those lines carry `source: "director"`, the
  parsed `task` and the `WHY`. In PowerShell, or for JSON with quotes or newlines, pass `-` and pipe the JSON on stdin (see [codex.md](../../skills/director/references/codex.md)).
- **Hook fallback.** On a spawn the hook writes a `kind: "subagent"` line with
  `source: "hook"` (agent, effort, model and tier from
  `.codex/agents/<agent_type>.toml`, else from the `<role>-<tier>` name through
  the model map) only if no delegation with that `task_name` exists. A
  follow-up tool (`followup_task`, or `send_input`/`resume_agent` on other
  versions) with a known target writes a `kind: "resume"` fallback, unless the
  latest line for that name is already a Director `resume`. If the Director logs
  after spawning, both lines exist; the Coach merges the hook fallback
  line into the Director line with the same `task_name` (hook lines have
  `task: {}`); when there is no Director line, it counts the hook line once.
- **Completions.** `SubagentStop` writes a `completions.jsonl` line:
  `task_name` from the agent transcript, `resolved_model` / `resolved_effort`
  from the last `turn_context`, `tokens` (this turn's `total_tokens`, so a
  resumed agent's earlier turns are subtracted), `tokens_detail`, `duration_ms`,
  `report_source: "hook-input"`, `result` and `review`. It links to the latest
  Director delegation with that `task_name`. A missing transcript leaves those
  fields null. A `review-json` block also writes `reviews.jsonl` through
  `records.logReview`. Codex `Bash` runs `records.logMerges(input, "codex")`.
- **Raw log kept.** `codex-events.jsonl` is still written (selected raw fields,
  never `tool_input.message`) for debugging. The Coach ignores it.
- **Project dir.** With `CLAUDE_PROJECT_DIR` unset (Codex), `lib.projectDir`
  uses `git rev-parse --show-toplevel` from the event `cwd`, falling back to
  `cwd`, then the process cwd. Hooks can run from a subfolder.
- **Tool list (amends 0003).** Codex-only tool names are `^collaboration`,
  exact `^spawn_agent$`, or one of `send_input`, `resume_agent`, `followup_task`,
  `wait_agent`, `close_agent`, `list_agents`, `apply_patch`. The raw log and
  hook matcher accept `^(?:collaboration)?(?:spawn_agent|followup_task|wait_agent|close_agent|send_input|resume_agent)$`.

## Consequences
- `tests/tools.test.js` asserted "delegations.jsonl untouched" after a Codex
  spawn; that assertion is superseded by this record.
- The Coach must treat the hook and Director lines for one `task_name` as one
  delegation.
