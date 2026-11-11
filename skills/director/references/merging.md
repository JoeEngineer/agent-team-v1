# Merging

On GitLab, read this with `gitlab.md`: an MR stands in for a PR, its target branch for the base, and `glab` for `gh` (the command map is there).

## Branch model

```
main  ←── (user merges) ──  milestone/<slug>  ←── (Director merges) ──  task/<ID>
```

- Task PRs target `milestone/<slug>`. The Director merges them.
- The milestone PR targets `main`. **Only the user merges it.**
- A guard hook blocks `gh pr merge` / `glab mr merge` when the request's base is `main`/`master`, force-pushes, and direct pushes to `main`/`master`. Don't try to work around it — ask the user.

## Before merging a task PR

All must be true:
1. A `reviewer` delegation for this PR returned a `review-json` block with `"verdict": "approve"` (logged in `.agent-team/logs/reviews.jsonl`).
2. CI is green: `gh pr checks <n>` shows no failing or pending required checks. Check it yourself even if the reviewer says `"ci": "green"`. (No CI configured → the reviewer must have run the tests: `"tests_passed": true`.)
3. No new commits since the review. If there are, review again (for a fold-in commit, the incremental diff only; see below).
4. The PR's base is `milestone/<slug>`.

Then post a one-line PR comment: `Merged by Director after reviewer approval (task <ID>, attempt <n>).`, and merge **in a Bash call of its own**:

```bash
gh pr merge <n> --squash --delete-branch
```

Always use both flags: without `--delete-branch` the `task/<ID>` branch stays behind. If a merge went through without them, delete the branch (`git push origin --delete task/<ID>`).

Do the bookkeeping (`git pull`, STATUS.md edits, the next PR's checks) in a separate call. The logging hook asks GitHub for the PR's state after the call; keeping the merge alone keeps the log line and any error easy to read.

## The milestone PR

Its body ends with one `Closes #N` line per issue: the milestone issue and every task issue in the milestone, including follow-up tasks.

```
Closes #58
Closes #59
Closes #60
```

GitHub only closes issues for a PR merged into the default branch. A task PR's own `Closes #N` does nothing, because it merges into `milestone/<slug>`, so the milestone PR has to close them all. List the issues with `gh issue list --label agent-team --state open` and check them against `STATUS.md`. Don't list an issue for work that was dropped or moved to a later milestone.

## Minor findings

When a reviewer approves with minor findings, decide before merging:

- **Fold in** when a finding has exact replacement text, or touches only this PR's own files and needs no design choice. Send it to the same implementer with `SendMessage` (warm context), with a TASK line for the same `id`, `attempt` incremented. Then send the reviewer the incremental diff only (`git diff <reviewed-sha>..HEAD`) and merge on its approval.
- **Batch** docs-wording findings into the next docs task in the milestone, if there is one, instead of a new issue and PR.
- Missing tests for this PR's own code, in its own test files, count as **fold in**.
- **Follow-up task** only for findings that need real work: behaviour changes, or another area of the code.

An `approve` still means "may merge as is". Folding in is a cost choice, not a new gate.

## GitHub approvals

GitHub doesn't let an account approve its own PR, and the Director and its agents act as the user's account. So the reviewer's verdict lives in the logs and a PR comment, not a formal GitHub approval. If the project uses a separate reviewer bot account, the project's `CLAUDE.md` says so and how to use it.

Expected repo rules are in the plugin README under "Protect your branches":
- `main`: PR required with 0 approvals, no force pushes, no deletion, and no bypass for anyone.
- `milestone/*`: no force pushes, plus status checks once the project has CI.

If a merge is refused by a ruleset, don't look for a way around it. Report it to the user.
