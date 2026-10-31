# Running the Director on Codex

Read this when the session is Codex. Everything else in `SKILL.md` still applies.

## Basics

- Skills are invoked as `$agent-team:<skill>`.
- `<plugin root>` on Codex is the plugin cache folder: `<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/`. Find it with `ls "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/agent-team/`, and use the newest version folder.
- Merging needs `gh`. If it is not installed or not logged in, tell the user.

Commands here are written for sh/bash (Codex reports the shell as `Bash` even on Windows). In PowerShell use `$env:CODEX_HOME` instead of `${CODEX_HOME:-$HOME/.codex}`, and quote the JSON differently, for example:

```
node "<plugin root>/scripts/log-event.js" delegation '{\"tool\":\"codex\",\"task_name\":\"cd_7_a1\",\"card\":\"TASK id=CD-7 ...\nWHY ...\",\"agent\":\"implementer-medium\",\"tier\":\"medium\",\"effort\":\"medium\",\"vehicle\":\"subagent\"}'
```

## Setup (once per project, checked at intake)

- Hooks: run `node "<plugin root>/scripts/codex-hooks.js"` to write the project hooks, then have the user trust them once with `/hooks`. Check the hooks line described in `SKILL.md` ("Hooks check").
- Agent files: at intake run `node "<plugin root>/scripts/codex-agents.js" --check`. If it fails, run `node "<plugin root>/scripts/codex-agents.js"` (writes `.codex/agents/`). Re-run after a plugin update or a model-map change.
- Hooks on but `.codex/agents` missing: the check fails; run the generator before spawning.

## Spawning

- Agent type is `<role>-<tier>` (for example `implementer-medium`). The files pin only the model, so always pass `reasoning_effort` on the spawn; it is honoured.
- `task_name` is the task id lowercased with `-` changed to `_`, plus `_a<attempt>`: `CD-7` attempt 1 is `cd_7_a1`. Codex allows only `[a-z0-9_]`, and the name must be unique in the session.
- Log the delegation before every spawn or retry. The hooks may not see the card on Codex, so this line is the record:

```
node "<plugin root>/scripts/log-event.js" delegation '{"tool":"codex","task_name":"cd_7_a1","card":"TASK id=CD-7 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}'
```

- Retries go through the follow-up tool (`followup_task`, `target` = the task_name). Log a new delegation line first with `"kind":"resume"`. It reuses the follow-up target's original `task_name` (the name the agent was spawned with, for example `cd_7_a1`), and the card's TASK line carries the bumped `attempt`. A different name would not match in `codex-log.js` (`onFollowup`), and the hook would add a duplicate resume line.

```
node "<plugin root>/scripts/log-event.js" delegation '{"tool":"codex","kind":"resume","task_name":"cd_7_a1","card":"TASK id=CD-7 ... attempt=2 ...
WHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}'
```
- Escalation: `node "<plugin root>/scripts/models.js" up <tier> --tool codex` (or `down`). If the map has no Codex model for the routed tier, use `models.js down`, spawn at that tier and log it: `log-event.js tier_fallback '{"task":"X-1","from":"large","to":"medium","tool":"codex","reason":"no model mapped"}'`.
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
