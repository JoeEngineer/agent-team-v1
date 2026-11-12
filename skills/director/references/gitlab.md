# GitLab (gitlab.com or self-hosted)

Read this when the session context says `agent-team forge: gitlab`. Everything else in the Director's instructions applies; only the CLI and a few names change. A GitLab **merge request (MR)** is what the rest of these instructions call a PR, and its **target branch** is the PR's base.

## Prerequisites

- `glab` is installed and logged in to the project's host: `glab auth status`. For a self-hosted instance the user logs in once with `glab auth login --hostname <host>` (or sets `GITLAB_HOST` and `GITLAB_TOKEN`, a token with the `api` scope). If `glab` is missing or not logged in, tell the user. Don't fall back to `gh`.
- `glab` must support `glab mr view --output json`. Old packaged builds (Ubuntu 24.04 ships 1.36) don't, and then the guard can't read an MR's target branch, so it blocks every merge. Check with `glab mr view --help`; if `--output` is missing, ask the user to update `glab`.
- Inside the repo, `glab` picks the host and project from the `origin` remote, so commands need no `--repo`.

## Command map

| Step | GitHub | GitLab |
|---|---|---|
| Open a task request | `gh pr create --base milestone/<slug> --head task/<ID> --title … --body …` | `glab mr create --target-branch milestone/<slug> --source-branch task/<ID> --title … --description … --remove-source-branch --yes` |
| List open requests | `gh pr list --state open` | `glab mr list` (open is the default) |
| Read the diff | `gh pr diff <n>` | `glab mr diff <n>` |
| View one | `gh pr view <n>` | `glab mr view <n>` (`--output json` for fields) |
| CI status | `gh pr checks <n>` | `glab mr view <n> --output json`, field `head_pipeline.status` (`success`, `failed`, `running`, `pending`, `canceled`, `skipped`); `glab ci status --branch <source branch>` for a readable view |
| CI wait (reviewer) | `node "<plugin root>/scripts/ci-wait.js" <n> --sha <head_sha>` | the same command; without the helper, one command polling `head_pipeline.status` every 30 s |
| CI gate (in the merge call) | `node "<plugin root>/scripts/ci-wait.js" <n> --once --sha <head_sha>` | the same command |
| Comment | `gh pr comment <n> -b "…"` | `glab mr note <n> -m "…"` |
| Merge a task request | `gh pr merge <n> --squash --delete-branch --match-head-commit <head_sha>` | `glab mr merge <n> --squash --remove-source-branch --yes --sha <head_sha>` |
| Queue auto-merge (gated) | `node "<plugin root>/scripts/ci-wait.js" <n> --queue-check --sha <head_sha> && gh pr merge <n> --auto --squash --delete-branch --match-head-commit <head_sha>` | `node "<plugin root>/scripts/ci-wait.js" <n> --queue-check --sha <head_sha> && glab mr merge <n> --auto-merge --squash --remove-source-branch --yes --sha <head_sha>` |
| Cancel auto-merge | `gh pr merge <n> --disable-auto` | `glab api -X POST projects/:id/merge_requests/<n>/cancel_merge_when_pipeline_succeeds` (GitLab REST; the guard allows it; untested against a live instance). If it fails, use the "Cancel auto-merge" button on the MR page or ask the user |
| Create an issue | `gh issue create --title … --body … --label agent-team` | `glab issue create --title … --description … --label agent-team` |
| List issues | `gh issue list --label agent-team --state open` | `glab issue list --label agent-team` (open is the default) |

Always pass `--yes` to `glab mr create` and `glab mr merge`: without it glab asks for confirmation, and an agent's shell can't answer.

## Merging

The merge rules in `merging.md` are unchanged: reviewer `approve` plus a green pipeline, the CI gate, the merge and a note in one chained call (`merging.md`, "The merge call": gate, then `glab mr merge … --sha <head_sha>`, then `glab mr note`, each only if the one before succeeded). On the first task MR whose CI has run, the call starts with `node "<plugin root>/scripts/ci-wait.js" --names <n>;` (it prints the pipeline's job names; GitLab has no per-job required list), a plain `;` before the same glab gate chain, as in `merging.md` ("First task PR: the names"). CI is green when `head_pipeline.status` is `success`. No pipeline (`head_pipeline` is null) counts as "no CI configured", so the reviewer must have run the tests.

The gate passes only on a green pipeline, so the merge after it never meets a running one. `glab mr merge` without `--auto-merge` may still queue the merge on a running pipeline; the gate prevents that. Queueing on purpose is the "Queue auto-merge (gated)" row above, used only when `merging.md` says auto-merge is usable (on GitLab: "Pipelines must succeed" on), and the merge log records it as `auto-merge-queued`. The queue-check is what decides: it reads the setting live, and exit 5 (not queueable, for example "Pipelines must succeed" off) means don't queue and use the fallback (background wait on Claude, reviewer followup on Codex), saying why in `STATUS.md`; 1 is red, 4 head moved, 2 ask the user. Treat a queued MR as merged only after a checkpoint (`reconcile-logs.js --merges`, run only when `STATUS.md` has a `queued` row; `merging.md`) shows it merged; then delete its `task/*` source branch if it still exists and post the "Merged by the Director" note.

The guard checks `glab mr merge` the same way it checks `gh pr merge`: it asks `glab mr view` for the target branch and blocks the merge when that's `main`/`master` or when it can't tell. It also blocks the same actions done through `glab api` (MR merges, protected branches, push rules, approval rules, branch deletes, commits to protected branches, project edits, releases).

## Issues

`Closes #N` works as on GitHub: GitLab closes the issues when the MR merges into the default branch. Put every task issue in the milestone MR's description, as `merging.md` says.

## Approvals

On GitLab the author of an MR can approve it unless the project turns on "Prevent approval by author" (a paid-tier setting). The Director still doesn't approve MRs: the reviewer's verdict lives in the logs and an MR note, as on GitHub.
