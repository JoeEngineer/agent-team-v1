# Running the Director on Codex

Read this when the session is Codex. Everything in `SKILL.md` still applies.

## Basics

- Skills are invoked as `$agent-team:<skill>`.
- `<plugin root>` on Codex is the plugin cache folder: `<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/`. Find it with `ls "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/agent-team/` and use the newest version folder. In PowerShell use `$env:CODEX_HOME`.
- Merging needs `gh`, or `glab` on GitLab. If it is missing or not logged in, tell the user.
- Codex's shell tool is named `Bash` even when it runs PowerShell, and on Windows it is Windows PowerShell 5.1. Commands here are written for sh; "Logging from PowerShell" below gives the other form.

## Setup (once per project, checked at intake)

- Hooks: run `node "<plugin root>/scripts/codex-hooks.js"` to write the project hooks, then have the user trust them once with `/hooks`. Then do the hooks check in `SKILL.md`.
- Agent files: run `node "<plugin root>/scripts/codex-agents.js" --check`. If it fails, or `.codex/agents` is missing, run it without `--check` before spawning. Run it again after a plugin update or a model-map change.

## Spawning

- **Look at the collaboration tool's schema first.** Some Codex clients expose `agent_type`, `model`, `reasoning_effort` and `fork_turns`; others only some of them. Use the generated `<role>-<tier>` agent files when the client supports role selection; without `agent_type`, put the role instructions in the task message. Don't invent fields.
- **Name.** `task_name` is the task id lowercased with `-` changed to `_`, plus `_a<attempt>`: `CD-7` attempt 1 is `cd_7_a1`. Only `[a-z0-9_]`, unique in the session.
- **Log before every spawn or retry.** The hooks may not see the card on Codex, so this line is the record. Pass the JSON on stdin (`-`) or with `--file <path>`, never as a quoted argument, and keep the card's line break as `\n` inside the JSON string:

```
node "<plugin root>/scripts/log-event.js" delegation - <<'EOF'
{"tool":"codex","task_name":"cd_7_a1","card":"TASK id=CD-7 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}
EOF
```

- **Retry with the same settings: a follow-up.** `followup_task` addresses the original `task_name`. Send the bumped attempt and the review findings, and log it first with `"kind":"resume"` under that same name. A follow-up can't change model or effort. Use it only when retaining that agent's model and effort is intended.
- **Retry with a new model or effort: a fresh spawn** with a unique task name for the bumped attempt (`cd_7_a2`), the same task id, worktree and branch, the findings, and a compact handoff. When the tool supports overrides, pass `model` and/or `reasoning_effort` with `fork_turns: "none"`; a full-history fork does not apply them. Log the new name as a new delegation before spawning, not as a resume.
- **No overrides available:** use a generated role file that selects the settings, or a separate `codex exec` session.
- **Verify what ran.** Don't claim an escalation took effect until the completion reports the resolved model and effort. Record requested and observed settings separately, and mark a missing observation unknown.
- **Tiers.** Next tier: `node "<plugin root>/scripts/models.js" up <tier> --tool codex` (or `down`). If the map has no Codex model for the routed tier, go `down`, spawn there, and log a `tier_fallback` event: `{"task":"X-1","from":"large","to":"medium","tool":"codex","reason":"no model mapped"}`. xlarge only with the user's yes, and only if its agent file exists.

## Logging from PowerShell

In Windows PowerShell 5.1, pipe the same JSON from a single-quoted here-string. The closing `'@` must start its own line. This form works for every `log-event.js` kind (`delegation`, `pause`, `tier_fallback`, `decision`, `review`):

```
@'
{"tool":"codex","task_name":"cd_7_a1","card":"TASK id=CD-7 ...\nWHY ...","agent":"implementer-medium","tier":"medium","effort":"medium","vehicle":"subagent"}
'@ | node "<plugin root>/scripts/log-event.js" delegation -
```

## Missing completions

A stop event can arrive before the child turn has finished writing its transcript; the hook then saves a snapshot and a later hook run fills in the record. If a completion is still missing, run `node "<plugin root>/scripts/reconcile-logs.js"` (`--dry-run` previews it and changes nothing). It can't rebuild a stop event that never reached the hook. How the logger matches turns is in `docs/codex-mapping.md`.

## Worktrees

For writers, make the tree yourself: `git worktree add .agent-team/worktrees/<ID> -b task/<ID> origin/<base>`, and put `worktree=.agent-team/worktrees/<ID>` on the card. One writer per tree; remove it after the merge.

In Codex's unelevated `workspace-write` sandbox `.git` is read-only, so `git worktree add` and commits fail inside it, and `--add-dir` doesn't help. Run these git commands as the Director with approval to run outside the sandbox, or have the user choose a sandbox setting that allows `.git` writes.

## Separate sessions

For session-vehicle work, log the delegation first, then:

```
codex exec -C <worktree> -m <model> -c model_reasoning_effort=<effort> --sandbox workspace-write --json [--output-schema <file>]
```

Get `<model>` from `node "<plugin root>/scripts/models.js" resolve <tier> --tool codex`.

## Merging and CI

The merge command in `merging.md` is the same here. Codex has no background shell that wakes the Director, so when the command reports `waiting`, don't use `--wait`: send a followup to the same reviewer ("wait again and report ci", `kind=followup`, same attempt, logged first like any followup), set the state to `waiting CI`, and run the merge command again on its report. Still pending after that one extra wait: tell the user.

The reviewer waits for CI in one blocking shell call: it passes the shell tool's timeout parameter (such as `timeout_ms`), set to 600000 ms.

## Reviews

- When hooks are active, the hook logs `review-json` from `SubagentStop`. When they are off, log each verdict yourself with `log-event.js review`. Never both: the log would get duplicate review lines.
- End every review brief's DELIVER line with "List minor findings too, and apply the Calibration rules in your Severity section." Codex reviewers tend to report blocking findings only, and without minors fold-ins don't happen and the Coach can't compare reviewers.
