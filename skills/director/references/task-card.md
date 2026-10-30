# Task card

Every delegation prompt — subagent, session, or bridge — starts with these two lines. The logging hook parses them; the agent reads them as its brief.

```
TASK id=AUTH-14 type=implement difficulty=medium milestone=auth attempt=1 branch=task/AUTH-14 base=milestone/auth
WHY sonnet/medium per routing table; clear spec, follows existing handler pattern
```

- `TASK` line: space-separated `key=value`, no spaces inside values.
  - Required: `id`, `type`, `difficulty`, `milestone`, `attempt`.
  - Optional: `branch`, `base`, `pr`, `issue`.
  - `type`: one of `research`, `breakdown`, `design`, `implement`, `fix`, `test`, `docs`, `review`, `coach`.
  - `difficulty`: `easy`, `medium`, `hard`.
- `WHY` line: free text — why this agent/model/effort. On escalations, say which ladder step.

Then the brief:

```
GOAL
<what done looks like, one or two sentences>

ACCEPTANCE CRITERIA
- ...

CONTEXT
<files, prior decisions (docs/decisions/...), reviewer findings on a retry>

OUT OF SCOPE
- ...

DELIVER
<e.g. "commit to task/AUTH-14, push, open PR against milestone/auth"> and end with your result-json block.
```

For `review` tasks, put the PR number in `pr=` and paste the original task's acceptance criteria into the brief.
