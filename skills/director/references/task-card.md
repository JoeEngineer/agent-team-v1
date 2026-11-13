# Task card

Every delegation prompt (subagent, session, bridge, or a retry sent to an existing agent) starts with these two lines. The logging hook parses them; the agent reads them as its brief. A role agent spawned without a TASK line is logged with `uncarded: true`, and you are warned.

```
TASK id=AUTH-14 type=implement difficulty=medium milestone=auth attempt=1 tier=medium effort=medium branch=task/AUTH-14 base=milestone/auth
WHY medium tier / medium effort per routing table; clear spec, follows existing handler pattern
```

## The TASK line

Space-separated `key=value`, no spaces inside values.

| Key | When | Values |
|---|---|---|
| `id`, `type`, `difficulty`, `milestone`, `attempt` | always | `type`: `research`, `breakdown`, `design`, `implement`, `fix`, `test`, `docs`, `review`, `coach`. `difficulty`: `easy`, `medium`, `hard`. `milestone=none` for side work that belongs to no milestone. |
| `tier`, `effort` | always | what you chose from the routing table: `small|medium|large|xlarge`, `low|medium|high|xhigh|max`. The logger warns when something else ran (`tier_mismatch`, `effort_mismatch`). |
| `reason` | from attempt 2 | `sendback` (changes requested, same settings), `escalation` (new tier or effort), `fold-in` (approved with minors), `retry` (the last turn was cut off). |
| `base` | any task in a worktree | the branch to start from, usually `milestone/<slug>`. |
| `branch`, `pr`, `issue` | optional | |
| `worktree` | set by the Codex Director | repo-relative path of the folder the task runs in. |
| `kind=followup` | scope added without a review | see below. |

The `WHY` line is free text: why this agent, tier and effort. On an escalation, name the ladder step.

## Attempts

- **Bump `attempt` only after a review verdict** (a send-back or an escalation) **or for a fold-in**, and say which with `reason=`. A continuation sent before any review keeps the attempt.
- **A retry keeps the attempt-1 `type` and `difficulty`**, even when the work is now a fix. The logger records `card_drift` when they change.
- **`reason=retry`** follows an interruption (a usage limit, a model at capacity, an abort). It keeps the attempt number and the settings. Send it to the same agent if it still has its context, with the findings and test evidence it had already reported.
- **An escalation is always a new spawn.** A resume (`SendMessage`, a Codex followup) keeps the original model and effort, and the logger warns when a resume's card asks for others.
- **A followup** is scope added to a task that is not a retry (a missed file, an extra small change): keep the attempt and add `kind=followup` (Codex: `"kind":"followup"` in the logged delegation line). Work big enough to review on its own gets a new task id.

## The brief

```
GOAL
<what done looks like, one or two sentences>

ACCEPTANCE CRITERIA
- ...

EDGE CASES (optional)
- <preconditions to prove, boundary inputs, the state after a terminal event>

CONTEXT
<files, prior decisions (docs/decisions/...), reviewer findings on a retry>

OUT OF SCOPE
- ...

DELIVER
<e.g. "commit to task/AUTH-14, push, open PR against milestone/auth"> and end with your result-json block.
```

## Standard CONTEXT lines

Add the ones that apply. Agents don't know these on their own.

- **Worktree base** (every worktree task): "Your worktree starts on `origin/HEAD` (usually `main`), not on the milestone. First run `git fetch origin && git checkout -b <branch> origin/<base>`, and confirm with `git merge-base --is-ancestor origin/<base> HEAD`."
- **Docker** (any task that starts containers, networks or volumes): "Use the compose project / name prefix `<task-id>-<role>` (e.g. `iv9-impl`, `iv9-rev`) for everything you create, and remove only what you created." If the task must use fixed names (ones the README documents, say), say so, and don't run it alongside other Docker tasks. For a reviewer, add the exact-SHA result of any memory-heavy suite that already passed ("2 GiB acceptance passed on `<sha>`"), so it can cite that instead of running it again.
- **CI artifacts** (a task that adds or changes a job that uploads artifacts): "Upload only on `push` to `main` or `milestone/**`, not on pull requests. Set `retention-days: 1`. Don't upload from test or integration jobs." Before the first such task, ask the user about Actions storage headroom: artifact storage is account-wide, and a full quota blocks every PR's checks.
- **CI wait** (every review task): "CI wait: `node "<absolute plugin root>/scripts/ci-wait.js" <n> --sha <head_sha>`, after your review work; shell timeout 600000 ms; at most two calls." Use the real absolute path and PR number.
- **Scratch files** (reviewers, and anyone building or running things outside their branch): "Put scratch worktrees, venvs and compose projects under your scratchpad or `/tmp`, never in the main checkout."

## Review tasks

- Put the PR number in `pr=`, and paste the original task's acceptance criteria (and EDGE CASES, if any) into the brief.
- DELIVER is "end with your `review-json` block". Don't ask a reviewer for a `result-json` or a custom block: the hook and the Coach read `review-json`.
- Say how far to verify: "run the tests and every command the diff documents", or "diff only: wording change". The scope you set drives the cost more than effort does.
