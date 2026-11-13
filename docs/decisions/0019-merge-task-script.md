---
id: 0019
title: One script merges a task PR (gate, merge, comment, log)
date: 2026-11-13
status: proposed            # implemented on milestone/v1; the user has not reviewed the details yet
milestone: v1
task: none
decided_by: architect       # a single Claude session, not a Director run; see Context
model: claude-fable-5-2
effort: unknown
---

## Context
In 0.6.0 the Director assembled each merge by hand: `ci-wait.js --once --sha` chained to `gh pr merge` chained to `gh pr comment`, in a bash form and a PowerShell 5.1 form, on GitHub and GitLab, with a queue variant and a `--names` prefix. It then read six exit codes and looked up what each meant. That procedure took about half of `merging.md` (15 KB), was restated in `SKILL.md`, `codex.md` and `gitlab.md`, and was pinned by tests that matched whole sentences. `merging.md` is not re-attached after a compaction, so the most safety-critical procedure was also the one most likely to be lost.

The user asked on 2026-11-13 for the guidance to be rewritten to be more succinct without losing intent, as 1.0.0, and was away while it was done. The choices below were made without them.

## Options
1. **Keep the chained command, shorten the prose around it.** No code change. The two shell forms, the queue variant and the exit-code table all stay.
2. **A script that prints the right command for the Director to run.** Removes the shell forms from the docs but adds a turn and still has the Director act on exit codes.
3. **A script that does the whole merge** and prints what to do next.

## Decision
Option 3: `scripts/merge-task.js <n> --sha <head_sha> --task <ID> --attempt <a>`.

- It refuses a request that is not open, whose base is protected or not `milestone/*`, or whose head is not `--sha`.
- It runs the 0.6.0 gate unchanged (`ci-wait.js --once --sha`, in process). Green merges, pinned to the full head SHA.
- On pending it runs the queue check from decision 0018 and queues auto-merge only on exit 0. Otherwise it reports `waiting`; with `--wait <s>` it waits for CI and then merges, which is how Claude's background fallback now works in one command.
- It asks the forge what happened, posts the comment, and writes the `merges.jsonl` line itself (`via: "merge-task"`), because the PostToolUse hook can't see a merge that runs inside a script.
- It prints one JSON line with a `next` field: the instruction for that result.
- The guard checks a `merge-task.js <n>` command the way it checks a typed `gh pr merge <n>`.

Typed `gh pr merge` / `glab mr merge` commands are still guarded and logged as before; nothing was removed from the guard or the logger. The guidance simply no longer tells the Director to type them.

## Consequences
- `merging.md` halves, the PowerShell command forms are gone from the guidance, and the per-result instructions arrive only when they apply.
- **Changed behaviour to review:**
  - A queued PR now gets its comment when it is queued ("Auto-merge queued by the Director…"), not after it merges. The checkpoint no longer posts one.
  - Queueing on pending is automatic when the queue check passes. In 0.6.0 the Director chose to make the queue call; the check that decided was the same.
  - The script only merges into `milestone/*`. A project whose instructions widen the Director's merge authority to other branches has to type the merge.
  - The merge line always carries `match_head`, `task`, `attempt` and `ci`. The Coach's instructions describe the new fields.
- Decision 0016 (`--names` never a call of its own) holds by construction: `--names` is a flag on the merge command.
- **Not verified:** the script has unit tests against the stand-in CLIs (24 tests), not a live run against GitHub or GitLab. `tests/live/` should be run on 1.0.0 before relying on it for a real milestone.
