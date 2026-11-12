# GitLab mapping

How each GitHub-facing piece of the `agent-team` plugin maps to GitLab (gitlab.com and self-hosted), as added in 0.5.0. The design decision is [ADR 0010](decisions/0010-forge-layer-gitlab.md); the Director's working instructions are [`skills/director/references/gitlab.md`](../skills/director/references/gitlab.md).

**Checked against:**
- `glab` docs as of 2026-11-10: the `glab mr merge` and `glab mr view` man pages (current), and Ubuntu 24.04's packaged 1.36 for the old-version gap. See [Sources](#sources).
- The GitLab REST API's merge request, protected branches and repository endpoints.
- Unit tests (`tests/gitlab.test.js`) with a stand-in `glab` that prints GitLab's MR JSON.
- A run of `tests/live/gitlab-live.sh` against a stand-in `glab` backed by a local bare repo (20/20).
- **Not yet** a real GitLab instance. The build environment's network allowlist blocked every container registry and the Go module proxy, so neither `gitlab/gitlab-ce` nor a real `glab` could run there.

**Labels**
- 🧪 **Stand-in tested**: covered by unit tests and the stand-in live run, not yet against real GitLab.
- 📄 **Documented** by GitLab / `glab`, relied on but not exercised.
- ❓ **Unknown**: needs the live run (see [Still open](#still-open)).

## Summary

1. **Before 0.5.0 the guard failed open on GitLab.** It only recognized `gh pr merge` and `gh api`, so `glab mr merge` into `main` went through unchecked. The guard now parses `glab` on every project, whatever the detected forge, and fails closed when `glab` can't confirm an MR's target branch.
2. **One small layer holds the differences.** `scripts/forge.js` builds the "view one request" call for `gh` or `glab` and normalizes the answer to `{number, state, autoMerge, base}`. The guard and the merge logger use it; nothing else in the scripts knows which forge is in use.
3. **Forge detection only steers the Director.** SessionStart adds `agent-team forge: gitlab` to the context, and the Director switches to the `glab` command map. Detection never turns guard checks on or off, so a mis-detected host can't weaken the guard.
4. **GitHub output is unchanged.** Same context line, same `merges.jsonl` fields. GitLab merge lines add `"forge": "gitlab"`.
5. **The main dependency is a current `glab`.** `glab mr view --output json` is required; old builds (Ubuntu 24.04's 1.36) lack it, and then the guard blocks every MR merge because it can't read the target branch.

## Concept-by-concept mapping

### Concepts

| GitHub | GitLab | Notes |
|---|---|---|
| Pull request (PR) | Merge request (MR) | The Director's instructions say PR throughout; on GitLab read MR. |
| PR number | MR `iid` | The per-project number shown as `!12`. `id` is global and not used. |
| Base branch (`baseRefName`) | Target branch (`target_branch`) | What the guard checks against the protected list. |
| Head branch | Source branch (`source_branch`) | |
| Rulesets | Protected branches | Both server-side; see [Branch protection](#branch-protection). |
| Auto-merge (`autoMergeRequest`) | Merge when pipeline succeeds (`merge_when_pipeline_succeeds`) | `glab mr merge` turns it on by default (`--auto-merge`) when a pipeline is running. Logged as `auto-merge-queued`. |
| Checks | Pipeline (`head_pipeline.status`) | `null` means no CI configured. |
| `Closes #N` | `Closes #N` | Same: issues close when the MR merges into the default branch. 📄 |
| Self-approval blocked | Self-approval allowed unless "Prevent approval by author" (paid tier) | The plugin never relies on approvals on either forge. |

### CLI commands

| Step | `gh` | `glab` | Status |
|---|---|---|---|
| Open a task request | `gh pr create --base … --head …` | `glab mr create --target-branch … --source-branch … --yes` | 🧪 |
| View as JSON | `gh pr view <n> --json number,state,autoMergeRequest,baseRefName` | `glab mr view <n> --output json` | 🧪 (current `glab` 📄) |
| Merge | `gh pr merge <n> --squash --delete-branch` | `glab mr merge <n> --squash --remove-source-branch --yes` | 🧪 |
| Queue merge after CI | `gh pr merge <n> --auto --squash` | `glab mr merge <n> --auto-merge --sha <sha> --squash --remove-source-branch --yes` (`--sha` refuses if the head moved) | 📄 |
| Cancel queued merge | `gh pr merge <n> --disable-auto` | `glab api -X POST projects/:id/merge_requests/<n>/cancel_merge_when_pipeline_succeeds` | 📄 |
| Wait for CI | `node scripts/ci-wait.js <n>` (reads `statusCheckRollup` from `gh pr view --json`) | `node scripts/ci-wait.js <n>` polls `head_pipeline.status` from `glab mr view <n> --output json`; `--once` checks once; `--names` lists the job names | 🧪 |
| Merge aliases | — | `glab mr accept`, `glab merge-request merge` | 🧪 guarded |
| Diff | `gh pr diff <n>` | `glab mr diff <n>` | 📄 |
| CI | `gh pr checks <n>` | `head_pipeline.status` from `glab mr view --output json`; `glab ci status --branch <b>` | 📄 |
| Comment | `gh pr comment` | `glab mr note <n> -m …` | 🧪 allowed by guard |
| Issues | `gh issue create/list` | `glab issue create/list` | 📄 |
| Raw API | `gh api` (REST + GraphQL) | `glab api` (REST + `graphql`), `:id` placeholder for the current project | 🧪 guarded |
| Login | `gh auth login` | `glab auth login --hostname <host>` or `GITLAB_HOST` + `GITLAB_TOKEN` (`api` scope) | 📄 |

`--yes` matters: without it `glab mr create` and `glab mr merge` prompt, and an agent's shell can't answer.

### JSON fields read by `forge.js`

| Normalized | From `gh` | From `glab` (REST MR object) |
|---|---|---|
| `number` | `number` | `iid` |
| `state` | `OPEN` / `MERGED` / `CLOSED` | `opened`, `locked` → `OPEN`; `merged` → `MERGED`; `closed` → `CLOSED` |
| `autoMerge` | `autoMergeRequest` non-null | `merge_when_pipeline_succeeds` (or `auto_merge_enabled`) |
| `base` | `baseRefName` | `target_branch` |

### Guard coverage

The `gh` checks and their GitLab counterparts. All 🧪.

| Blocked action | `gh` form | `glab` form |
|---|---|---|
| Merge into `main`/`master` (or `AGENT_TEAM_PROTECTED_BRANCHES`) | `gh pr merge` | `glab mr merge` / `accept` / `merge-request merge` |
| Merge when the target can't be confirmed | `gh pr merge` | same, via `glab mr view` |
| API merge | `gh api …/pulls/N/merge` | `glab api -X PUT projects/:id/merge_requests/N/merge` and `…/merge_when_pipeline_succeeds` |
| Branch protection / rules | rulesets, branch protection | `protected_branches`, `protected_tags`, `push_rule`, `approval_rules`, approval settings |
| Delete protected or milestone branch | `gh api -X DELETE …/git/refs/heads/…` | `glab api -X DELETE projects/:id/repository/branches/<b>` (URL-encoded names decoded), `repository/merged_branches` |
| Write to a protected branch through the API | ref updates | `repository/commits` or `repository/files` with `branch=<protected>` |
| Releases | `gh release create/delete/edit` | `glab release create/delete/upload/update`, `glab api …/releases` |
| Project changes | `gh repo delete/archive/edit/rename` | `glab repo delete/transfer/update/edit`, `glab api -X PUT` or `-X DELETE projects/:id`, `…/transfer`, `…/archive` |
| GraphQL equivalents | merge/ruleset mutations | `mergeRequestAccept`, `mergeRequestSetAutoMerge`, `commitCreate`, `branchRule*`, `projectUpdate`/`projectDelete`, `release*` |

Allowed on purpose: MR create/list/diff/view/note, `glab ci status`, issue commands, approving an MR, API reads, deleting task branches, and `glab repo archive` (that's a download, not an archive of the project).

The plain-git checks (force push, push to protected branches, `--mirror`/`--prune`/`--all`, `git add -A` with unignored worktrees) are forge-independent and unchanged.

### Forge detection

In order, first match wins:

1. `AGENT_TEAM_FORGE=github|gitlab`
2. `git config agent-team.forge` (per clone, in `.git/config`, not committed; `team-init` offers to set it)
3. The `origin` remote's host: contains `github` → GitHub; contains `gitlab` → GitLab. https, `ssh://` and scp-style (`git@host:path`) URLs are parsed.
4. GitHub (the original default)

A self-hosted server with a neutral name (`git.example.com`) needs step 1 or 2.

### Branch protection

| Branch | GitHub ruleset | GitLab protected branch |
|---|---|---|
| `main` | Require a PR (0 approvals), block force pushes, no bypass | Allowed to merge: Maintainers; Allowed to push and merge: **No one**; Allowed to force push: off. GitLab protects the default branch already; change "Allowed to push and merge" to No one in the UI. |
| `milestone/*` | Block force pushes | Wildcard `milestone/*`. Allowed to merge: Developers + Maintainers; Allowed to push and merge: Developers + Maintainers; Allowed to force push: **off** |

On both forges the Director acts as the user, so server rules can't tell them apart. The guard is what keeps the Director from merging into `main`; the server rules catch anything that gets past it.

## Still open

Each is checked by `tests/live/gitlab-live.sh` against a real instance:

- ❓ The exact JSON from a current `glab mr view --output json` on a real server (`iid`, `state`, `target_branch` present and named as expected).
- ❓ `glab mr create … --yes` creating without prompts, and `glab mr merge … --yes` merging (or queuing behind a pipeline) without prompts.
- ❓ Outcome logging with a real pipeline running (`auto-merge-queued`) as well as without one (`merged`).
- ❓ `glab api` placeholders (`:id`) resolving on a self-hosted host.
- ❓ `glab mr merge <n> --auto-merge --sha <sha>` queuing behind a real pipeline, its `--sha` refusal when the head moved, and the `cancel_merge_when_pipeline_succeeds` call.
- ❓ Which `glab` version first shipped `mr view --output json`. Today the docs only say 1.36 lacks it.

Not covered by the live script: the Director's end-to-end flow on GitLab (issues, milestone MR, `Closes #N`). That needs a real milestone run.

## Sources

- [glab mr merge (man page)](https://man.archlinux.org/man/glab-mr-merge.1.en)
- [glab mr view (man page, current)](https://www.mankier.com/1/glab-mr-view)
- [glab mr view 1.36 (Ubuntu 24.04)](https://manpages.ubuntu.com/manpages/noble/en/man1/glab-mr-view.1.html)
- [GitLab docs: glab CLI](https://docs.gitlab.com/cli/)
