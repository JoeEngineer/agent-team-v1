# Running the Director on Codex

Read this when the session is Codex. Everything else in `SKILL.md` still applies.

## Basics

- Skills are invoked as `$agent-team:<skill>`.
- `<plugin root>` on Codex is the plugin cache folder: `<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/`. Find it with `ls "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/agent-team/`, and use the newest version folder.
- Merging needs `gh`. If it is not installed or not logged in, tell the user.

Commands here are written for sh/bash. Codex's shell tool is named `Bash` even when the command runs in PowerShell, and on Windows the shell inside Codex is Windows PowerShell 5.1 (verified live; see the Hooks table and "Live test results" in `docs/codex-mapping.md`). In PowerShell use `$env:CODEX_HOME` instead of `${CODEX_HOME:-$HOME/.codex}`.

Pass the JSON to `log-event.js <kind> -` (stdin) or `log-event.js <kind> --file <path>`, not as a quoted argument. Quoting JSON as an argument is fragile on Windows PowerShell 5.1, and a live run lost a delegation line to it.

## Setup (once per project, checked at intake)

- Hooks: run `node "<plugin root>/scripts/codex-hooks.js"` to write the project hooks, then have the user trust them once with `/hooks`. Check the hooks line described in `SKILL.md` ("Hooks check").
- Agent files: at intake run `node "<plugin root>/scripts/codex-agents.js" --check`. If it fails, run `node "<plugin root>/scripts/codex-agents.js"` (writes `.codex/agents/`). Re-run after a plugin update or a model-map change.
- Hooks on but `.codex/agents` missing: the check fails; run the generator before spawning.

## Spawning

- Inspect the collaboration tool schema exposed in this session. Some Codex clients expose `agent_type`, `model`, `reasoning_effort` and `fork_turns`; others expose only a subset. Use generated `<role>-<tier>` agent files when the client supports role selection. In a session without `agent_type`, put the role instructions in the task message. Do not invent unavailable fields.
- `task_name` is the task id lowercased with `-` changed to `_`, plus `_a<attempt>`: `CD-7` attempt 1 is `cd_7_a1`. Codex allows only `[a-z0-9_]`, and the name must be unique in the session.
- Log the delegation before every spawn or retry. The hooks may not see the card on Codex, so this line is the record:

```
node "<plugin root>/scripts/log-event.js" delegation - <<'EOF'
{"tool":"codex","task_name":"cd_7_a1","card":"TASK id=CD-7 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}
EOF
```

In PowerShell (Windows PowerShell 5.1), pipe the same JSON from a single-quoted here-string. The closing `'@` must start its own line:

```
@'
{"tool":"codex","task_name":"cd_7_a1","card":"TASK id=CD-7 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}
'@ | node "<plugin root>/scripts/log-event.js" delegation -
```

Keep the card's line break as `\n` inside the JSON string, not as a real newline in the JSON.

- Retry with a follow-up only when retaining that agent's model and effort is intended. `followup_task` addresses the original `task_name`; send the bumped attempt and review findings, and log it first as `kind: "resume"` under that same name. The follow-up API does not change model or effort.

```
node "<plugin root>/scripts/log-event.js" delegation - <<'EOF'
{"tool":"codex","kind":"resume","task_name":"cd_7_a1","card":"TASK id=CD-7 ... attempt=2 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}
EOF
```
- If the retry changes model or effort, use a fresh spawn with a unique task name for the bumped attempt (for example `cd_7_a2`), the same task id, existing worktree and branch, findings, and a compact handoff of relevant context. When the tool supports overrides, pass the requested `model` and/or `reasoning_effort` with `fork_turns: "none"`; full-history fork does not apply those overrides. Log the new name as a new delegation before spawning, not as a resume on the old agent:

```js
// Illustrative only: include only fields present in this session's spawn schema.
spawn_agent({
  task_name: "cd_7_a2",
  model: "<requested-model>",
  reasoning_effort: "high",
  fork_turns: "none",
  message: "<role instructions; TASK id=CD-7 attempt=2; same worktree and branch; findings and concise handoff>"
});
```

If overrides are unavailable, use a generated role file/configuration that selects the requested settings when supported, or a separate `codex exec` session with explicit model and effort configuration. Follow that client's actual interface; don't claim an escalation took effect until the completion reports the resolved model and effort. Record requested and observed settings separately, and mark unavailable observations unknown.
- Escalation: `node "<plugin root>/scripts/models.js" up <tier> --tool codex` (or `down`). If the map has no Codex model for the routed tier, use `models.js down`, spawn at that tier and log it with the stdin form:

```
node "<plugin root>/scripts/log-event.js" tier_fallback - <<'EOF'
{"task":"X-1","from":"large","to":"medium","tool":"codex","reason":"no model mapped"}
EOF
```

In PowerShell (Windows PowerShell 5.1), pipe the same JSON from a single-quoted here-string:

```
@'
{"task":"X-1","from":"large","to":"medium","tool":"codex","reason":"no model mapped"}
'@ | node "<plugin root>/scripts/log-event.js" tier_fallback -
```

- xlarge only with the user's yes, and only if its agent file exists.

## Worktrees

For writers, make the tree yourself: `git worktree add .agent-team/worktrees/<ID> -b task/<ID> origin/<base>`. Put `worktree=.agent-team/worktrees/<ID>` in the card. One writer per tree; remove it after the merge.

Caveat (seen live): in Codex's unelevated `workspace-write` sandbox `.git` is read-only, so `git worktree add` and commits fail inside the sandbox, and `--add-dir` did not help. Run these git commands as the Director with approval to run outside the sandbox, or have the user choose a sandbox setting that allows `.git` writes. How the elevated sandbox behaves is being re-checked in the live tests.

## Separate sessions

For session-vehicle work, log the delegation first, then:

```
codex exec -C <worktree> -m <model> -c model_reasoning_effort=<effort> --sandbox workspace-write --json [--output-schema <file>]
```

Get `<model>` from `node "<plugin root>/scripts/models.js" resolve <tier> --tool codex`.

## Reviews

When hooks are active, the hook logs `review-json` from `SubagentStop`. When hooks are off, log each verdict yourself with `log-event.js review`. Never both, or the log gets duplicate review lines.
