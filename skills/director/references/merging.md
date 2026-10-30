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

GitHub doesn't let an account approve its own PR, and the Director and its agents act as the user's account. So the reviewer's verdict lives in the logs and a PR comment, not a formal GitHub approval. If the project uses a separate reviewer bot account, the project's `CLAUDE.md` says so and how to use it.

Expected repo rules are in the plugin README under "Protect your branches":
- `main`: PR required with 0 approvals, no force pushes, no deletion, and no bypass for anyone.
- `milestone/*`: no force pushes, plus status checks once the project has CI.

If a merge is refused by a ruleset, don't look for a way around it. Report it to the user.
