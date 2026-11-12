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
2. The review block's `head_sha` equals the PR's current head (`gh pr view <n> --json headRefOid`). Commits pushed after the review need a new review first (see "Commits pushed after the review"). Only a reviewed head is ever merged or queued.
3. The reviewer reported `"ci": "green"`, or `"ci": "none"` with `"tests_passed": true` (no CI configured, so the reviewer must have run the tests). Don't re-check what the reviewer reported; the gate in the merge call (below) re-reads it. `pending`, `unknown` and `red` never go to the merge call: each has its own section below.
4. The PR's base is `milestone/<slug>`.

You never wait on CI in the foreground: no watch or polling loop. A task PR costs one short Director turn on CI, or two when the auto-merge fallback below applies.

## The merge call

Merge in ONE call holding exactly three things: the CI gate, the merge and the comment, each running only if the one before succeeded.

```bash
node "<plugin root>/scripts/ci-wait.js" <n> --once --sha <head_sha> && gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha> && gh pr comment <n> -b "Merged by Director after reviewer approval (task <ID>, attempt <a>)."
```

In PowerShell (Windows PowerShell 5.1):

```
node "<plugin root>\scripts\ci-wait.js" <n> --once --sha <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha>; if ($LASTEXITCODE -eq 0) { gh pr comment <n> -b "Merged by Director after reviewer approval (task <ID>, attempt <a>)." } }
```

- Put no other merges, `git pull` or file edits in that call. In sh never join with a bare `;`: use `&&`. Always pass the PR number.
- Always use both merge flags: without `--delete-branch` the `task/<ID>` branch stays behind. If a merge went through without them, delete the branch (`git push origin --delete task/<ID>`).
- `--match-head-commit` makes the merge fail if the PR head moved since the review.
- The log stays correct: the logging hook finds the one merge segment in the chained command and asks the forge for the PR's state afterwards, so the merge line records the real outcome.
- Do the bookkeeping (`git pull`, STATUS.md edits, the next PR's checks) in a separate call.

Gate results. Exit 0 (green): the merge and the comment run. Any other exit stops the call and nothing is merged; then act on it as on the same reviewer result:
- 1 (red): "Red CI" below.
- 8 (pending): "Reviewer reported `ci: pending`" below.
- 4 (head moved): "Commits pushed after the review" below.
- 2 (`unknown`, or an error): "Reviewer reported `ci: unknown`" below.
- 3 (none) after the reviewer reported `green`: the checks the reviewer saw are gone. Don't merge; ask the user.

### Reviewer reported `ci: none`

If the reviewer ran the tests and they passed (`"tests_passed": true`), use the same call with `--allow-none` after `--sha <head_sha>` (`--allow-none` only passes with a matching `--sha`). If `tests_passed` is not `true`, don't merge: send the reviewer a followup to run the tests.

### Commits pushed after the review

A fold-in (see "Minor findings") or anyone else may add commits after an approving review. Send the reviewer the new commits only (`git diff <reviewed-sha>..<new head>`) and wait for its report. That incremental review then decides like any review: its verdict, its `ci` and its `head_sha`. Never merge or queue a head no review approved.

### Reviewer reported `ci: pending`

The reviewer's CI wait timed out. Don't wait in the foreground. The head to queue or wait for is the review's `head_sha`, and only if it still equals the PR's current head (if not, follow "Commits pushed after the review").

If auto-merge is usable, queue the pending PR:

```bash
gh pr merge <n> --auto --squash --delete-branch --match-head-commit <head_sha>
```

(GitLab: `glab mr merge <n> --auto-merge --squash --remove-source-branch --yes --sha <head_sha>`.) Set the state to `queued` in `STATUS.md` and move on. The checkpoints below follow it up.

Auto-merge is usable when `STATUS.md`'s CI block records named required checks on the milestone base and "Allow auto-merge" on (GitLab: "Pipelines must succeed" on; it covers the whole pipeline, so no names are needed). Fill the block after the first CI run on the milestone: `node "<plugin root>/scripts/ci-wait.js" --names <n>` lists the required checks. `--auto` waits only for required checks, so without named ones it could merge before CI ran.

When auto-merge is not usable, say why in `STATUS.md` and set the state to `waiting CI` (this fallback costs two Director turns for that PR):
- Claude: run `node "<plugin root>/scripts/ci-wait.js" <n> --sha <head_sha> --timeout 1800` as a background command (Bash `run_in_background`).
- Codex has no background shell that wakes the Director. Send a followup to the same reviewer ("wait again and report ci", `kind=followup`, same attempt).

When the background wait finishes or the reviewer reports, act on the result as in "Gate results": green runs the merge call above, and every other result goes to its section. Still pending after this one extra wait: tell the user, keep the state `waiting CI`, and don't start another wait.

### Reviewer reported `ci: unknown`

The helper couldn't tell (decision 0014), for example because the required checks can't be read. Don't merge, don't queue and don't wait: ask the user.

### Red CI

Red CI, whether from the reviewer, the merge-call gate (exit 1), a checkpoint or a cancelled auto-merge: send it back to the implementer with the failing check names. Only when the reviewer approved and explained the failure as not this PR's fault: still don't merge (the gate stops on red), ask the user.

### Queued PRs: checkpoints

Run `node "<plugin root>/scripts/reconcile-logs.js" --merges` before the next merge when something is queued, at the end of a wave, and before opening the milestone PR. One call covers every queued PR. It prints one line per PR: merged, auto-merge-cancelled, closed, still queued (with its CI state), or head moved.
- Merged: set the state to `merged` in `STATUS.md`.
- Still queued: nothing to do until the next checkpoint.
- Cancelled or red: `gh pr merge <n> --disable-auto` if it is still on (GitLab: the cancel row in `gitlab.md`), then send it back to the implementer with the failing check names ("Red CI").
- Head moved: disable auto-merge at once, then follow "Commits pushed after the review".
- Closed: ask the user.

Before any push to a queued PR (a send-back or a fold-in), disable auto-merge first (`gh pr merge <n> --disable-auto`; GitLab: the cancel row in `gitlab.md`). GitHub keeps auto-merge on when someone with write access pushes.

## The milestone PR

Order at close: (1) `reconcile-logs.js --merges` shows nothing queued; (2) open the milestone PR; (3) the final reviewer runs on that PR and waits for its CI; (4) archive the logs; (5) `node "<plugin root>/scripts/ci-wait.js" <milestone PR> --once` (it may share the archive call); (6) report "complete" only on green. Otherwise tell the user "PR open, CI <red, pending or unknown> at <sha>". If it is pending: on Claude, wait in the background (`ci-wait.js <milestone PR> --timeout 1800` with `run_in_background`) and report again when it finishes; on Codex, report it as pending.

Its body ends with one `Closes #N` line per issue: the milestone issue and every task issue in the milestone, including follow-up tasks.

```
Closes #58
Closes #59
Closes #60
```

GitHub only closes issues for a PR merged into the default branch. A task PR's own `Closes #N` does nothing, because it merges into `milestone/<slug>`, so the milestone PR has to close them all. List the issues with `gh issue list --label agent-team --state open` and check them against `STATUS.md`. Don't list an issue for work that was dropped or moved to a later milestone.

## Minor findings

When a reviewer approves with minor findings, decide before merging:

- **Fold in** when a finding has exact replacement text, or touches only this PR's own files and needs no design choice. Send it to the same implementer with `SendMessage` (warm context), with a TASK line for the same `id`, `attempt` incremented. Then send the reviewer the incremental diff only (`git diff <reviewed-sha>..HEAD`) and act on its review as "Commits pushed after the review" says.
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
