# Task card

Every delegation prompt — subagent, session, or bridge — starts with these two lines. The logging hook parses them; the agent reads them as its brief. This includes a retry sent to an existing agent with `SendMessage`: put a new TASK line (same `id`, `attempt` incremented) in the message so it's logged as an attempt.

```
TASK id=AUTH-14 type=implement difficulty=medium milestone=auth attempt=1 branch=task/AUTH-14 base=milestone/auth
WHY sonnet/medium per routing table; clear spec, follows existing handler pattern
```

- `TASK` line: space-separated `key=value`, no spaces inside values.
  - Required: `id`, `type`, `difficulty`, `milestone`, `attempt`.
  - Also required for any task that runs in a worktree: `base` (the branch to start from, usually `milestone/<slug>`).
  - Optional: `branch`, `pr`, `issue`.
  - `type`: one of `research`, `breakdown`, `design`, `implement`, `fix`, `test`, `docs`, `review`, `coach`.
  - `difficulty`: `easy`, `medium`, `hard`.
- `WHY` line: free text — why this agent/model/effort. On escalations, say which ladder step.

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
- **Docker** (any task that starts containers, networks or volumes): "Use the compose project / name prefix `<task-id>-<role>` (e.g. `iv9-impl`, `iv9-rev`) for everything you create, and remove only what you created." If the task must use fixed names (e.g. ones the README documents), say so; the Director doesn't run it alongside other Docker tasks.
- **CI artifacts** (a task that adds or changes a job that uploads artifacts): "Upload only on `push` to `main` or `milestone/**`, not on pull requests. Set `retention-days: 1`. Don't upload from test or integration jobs."
- **Scratch files** (reviewers, and anyone building or running things outside their branch): "Put scratch worktrees, venvs and compose projects under your scratchpad or `/tmp`, never in the main checkout."

## Review tasks

- Put the PR number in `pr=` and paste the original task's acceptance criteria (and EDGE CASES, if any) into the brief.
- DELIVER for `type=review` is: "end with your `review-json` block" — the contract in the reviewer agent. Don't ask reviewers for a `result-json` or a custom block; the hook and the Coach read `review-json`.
- Say how far to verify: e.g. "run the tests and every command the diff documents" or "diff only — wording change". The scope you set drives the cost more than effort does.
