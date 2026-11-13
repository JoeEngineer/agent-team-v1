# GitLab (gitlab.com or self-hosted)

Read this when your context says `agent-team forge: gitlab`. Everything else in the Director's instructions applies; only the CLI and a few names change. A GitLab **merge request (MR)** is what the other files call a PR, and its **target branch** is the PR's base.

## Prerequisites

- `glab` is installed and logged in to the project's host: `glab auth status`. For a self-hosted instance the user logs in once with `glab auth login --hostname <host>` (or sets `GITLAB_HOST` and `GITLAB_TOKEN`, a token with the `api` scope). If `glab` is missing or not logged in, tell the user. Don't fall back to `gh`.
- `glab mr view --output json` must work. Old packaged builds (Ubuntu 24.04 ships 1.36) lack `--output`; then the guard can't read an MR's target branch and blocks every merge. Check with `glab mr view --help`; if it is missing, ask the user to update `glab`.
- Inside the repo, `glab` takes the host and project from the `origin` remote, so commands need no `--repo`.

## Command map

| Step | GitHub | GitLab |
|---|---|---|
| Open a task request | `gh pr create --base milestone/<slug> --head task/<ID> --title … --body …` | `glab mr create --target-branch milestone/<slug> --source-branch task/<ID> --title … --description … --remove-source-branch --yes` |
| List open requests | `gh pr list --state open` | `glab mr list` |
| Read the diff | `gh pr diff <n>` | `glab mr diff <n>` |
| View one | `gh pr view <n>` | `glab mr view <n>` (`--output json` for fields) |
| CI status | `gh pr checks <n>` | field `head_pipeline.status` of `glab mr view <n> --output json`; `glab ci status --branch <source branch>` for a readable view |
| Comment | `gh pr comment <n> -b "…"` | `glab mr note <n> -m "…"` |
| Merge a task request | `merge-task.js` (`merging.md`) | the same command |
| Cancel auto-merge | `gh pr merge <n> --disable-auto` | `glab api -X POST projects/:id/merge_requests/<n>/cancel_merge_when_pipeline_succeeds` (the guard allows it; untested against a live instance). If it fails, use the "Cancel auto-merge" button on the MR page or ask the user |
| Create an issue | `gh issue create --title … --body … --label agent-team` | `glab issue create --title … --description … --label agent-team` |
| List issues | `gh issue list --label agent-team --state open` | `glab issue list --label agent-team` |

Always pass `--yes` to `glab mr create`: without it glab asks for confirmation, and an agent's shell can't answer.

## What differs

- **CI.** CI is green when `head_pipeline.status` is `success`. No pipeline (`head_pipeline` is null) counts as "no CI", so the reviewer must have run the tests.
- **Queueing.** A pending MR is queued only when the project has "Pipelines must succeed" on; the merge command reads that setting live. Treat a queued MR as merged only after a checkpoint shows it merged.
- **Check names.** `--names` prints the pipeline's job names. GitLab has no per-job required list, so the user turns on "Pipelines must succeed" instead.
- **Guard.** It reads the MR's target branch with `glab mr view` and blocks a merge into `main`/`master`, or one it can't check. It blocks the same actions done through `glab api`.
- **Issues.** `Closes #N` works as on GitHub: the issues close when the milestone MR merges into the default branch.
- **Approvals.** The Director doesn't approve MRs, even where GitLab would let the author do it. The reviewer's verdict lives in the logs and an MR note.
