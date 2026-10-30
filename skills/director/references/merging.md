# Merging

## Branch model

```
main  ←── (user merges) ──  milestone/<slug>  ←── (Director merges) ──  task/<ID>
```

- Task PRs target `milestone/<slug>`. The Director merges them.
- The milestone PR targets `main`. **Only the user merges it.**
- A guard hook blocks `gh pr merge` when the PR's base is `main`/`master`, force-pushes, and direct pushes to `main`/`master`. Don't try to work around it — ask the user.

## Before merging a task PR

All must be true:
1. A `reviewer` delegation for this PR returned `"verdict": "approve"` (logged in `.agent-team/logs/reviews.jsonl`).
2. CI is green: `gh pr checks <n>` shows no failing or pending required checks. (No CI configured → the reviewer must have run the tests: `"tests_passed": true`.)
3. No new commits since the review. If there are, review again.
4. The PR's base is `milestone/<slug>`.

Then:

```bash
gh pr merge <n> --squash --delete-branch
```

Post a one-line PR comment before merging: `Merged by Director after reviewer approval (task <ID>, attempt <n>).`

## GitHub approvals

GitHub doesn't let an account approve its own PR, and the Director and its agents act as the user's account. So the reviewer's verdict lives in the logs and a PR comment, not a formal GitHub approval. Branch protection on `milestone/*` should require status checks, not approving reviews. If the project uses a separate reviewer bot account, the project's `CLAUDE.md` says so and how to use it.
