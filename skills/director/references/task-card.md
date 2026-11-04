# Task card

Every delegation prompt — subagent, session, or bridge — starts with these two lines. That includes side work during a milestone, such as a plugin fix: use `milestone=none` when it belongs to no milestone. A role agent spawned without a TASK line is logged with `uncarded: true`, and the Director is warned. The logging hook parses them; the agent reads them as its brief. This includes a retry sent to an existing agent with `SendMessage`: put a new TASK line (same `id`, `attempt` incremented) in the message so it's logged as an attempt.

```
TASK id=AUTH-14 type=implement difficulty=medium milestone=auth attempt=1 branch=task/AUTH-14 base=milestone/auth
WHY medium tier (sonnet) / medium effort per routing table; clear spec, follows existing handler pattern
```

- `TASK` line: space-separated `key=value`, no spaces inside values.
  - Required: `id`, `type`, `difficulty`, `milestone`, `attempt`.
  - Optional: `tier` (`small|medium|large|xlarge`) and `effort` (`low|medium|high|xhigh|max`), the settings chosen from the routing table. The logger compares them with what actually runs and warns on a difference (`tier_mismatch`, `effort_mismatch`).
  - From attempt 2: `reason`, why this attempt exists. `sendback` (changes requested, same settings), `escalation` (new tier or effort, which needs a new spawn), `fold-in` (approved with minors), or `retry` (the last turn was cut off by a usage limit, a model at capacity or an abort; same settings, and the attempt number stays the same).
  - Also required for any task that runs in a worktree: `base` (the branch to start from, usually `milestone/<slug>`).
  - Optional: `branch`, `pr`, `issue`.
  - Optional: `worktree` (repo-relative path, no spaces), the folder the task runs in; set by the Codex Director.
  - `type`: one of `research`, `breakdown`, `design`, `implement`, `fix`, `test`, `docs`, `review`, `coach`.
  - `difficulty`: `easy`, `medium`, `hard`.
- `WHY` line: free text — why this agent/tier/effort. On escalations, say which ladder step.

### Attempts and followups

- A retry keeps the attempt-1 `type` and `difficulty`, even when the work is now a fix. The logger warns and records `card_drift` when they change.
- Bump `attempt` only after a review verdict (a send-back or an escalation) or for a fold-in, and say which with `reason=`. A continuation sent before any review keeps the attempt.
- A `retry` after an interruption keeps the attempt and the settings. Send it to the same agent if it still has its context, and include the findings and test evidence it had already reported, so the retry doesn't redo them.
- An escalation is always a new spawn: a resume (`SendMessage`, Codex followup) keeps the original model and effort. The logger warns when a resume's card asks for a different `tier` or `effort`, or says `reason=escalation`.
- Scope added to a task that is not a retry (a missed file, an extra small change) is a followup: keep the attempt and add `kind=followup` to the TASK line (Codex: `"kind":"followup"` in the `log-event.js delegation` line). Work big enough to review on its own gets a new task id instead.

Then the brief:

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
- **Docker** (any task that starts containers, networks or volumes): "Use the compose project / name prefix `<task-id>-<role>` (e.g. `iv9-impl`, `iv9-rev`) for everything you create, and remove only what you created." If the task must use fixed names (e.g. ones the README documents), say so; the Director doesn't run it alongside other Docker tasks. For a reviewer, add the exact-SHA result of any memory-heavy suite that already passed ("2 GiB acceptance passed on `<sha>`"), so it can cite that instead of running it again.
- **CI artifacts** (a task that adds or changes a job that uploads artifacts): "Upload only on `push` to `main` or `milestone/**`, not on pull requests. Set `retention-days: 1`. Don't upload from test or integration jobs."
- **Scratch files** (reviewers, and anyone building or running things outside their branch): "Put scratch worktrees, venvs and compose projects under your scratchpad or `/tmp`, never in the main checkout."

## Review tasks

- Put the PR number in `pr=` and paste the original task's acceptance criteria (and EDGE CASES, if any) into the brief.
- DELIVER for `type=review` is: "end with your `review-json` block" — the contract in the reviewer agent. Don't ask reviewers for a `result-json` or a custom block; the hook and the Coach read `review-json`.
- Say how far to verify: e.g. "run the tests and every command the diff documents" or "diff only — wording change". The scope you set drives the cost more than effort does.
