# 0010: Forge layer for GitHub and GitLab

Status: proposed

## Context
The full GitHub-to-GitLab mapping, guard coverage and open checks are in
`docs/gitlab-mapping.md`.

Everything that talks to the code host went through `gh`: the guard asked
`gh pr view` for a PR's base, the merge logger asked it for the outcome, and the
skills told the Director to use `gh pr …` and `gh issue …`. On a GitLab project
(gitlab.com or self-hosted) none of that works, and the guard fails open: it
only recognized `gh pr merge` and `gh api`, so `glab mr merge` into `main` went
through unchecked.

## Decision
- `scripts/forge.js` is the one place that knows both CLIs. It builds the
  "view one request" call for `gh` or `glab` and normalizes the answer to
  `{number, state: OPEN|MERGED|CLOSED, autoMerge, base}`. GitLab's
  `opened/merged/closed/locked`, `target_branch`, `iid` and
  `merge_when_pipeline_succeeds` map onto those.
- The guard and the merge logger parse **both** CLIs on every project, with no
  forge detection. A `glab` command on a GitHub project fails closed in the
  guard (it can't confirm the target), which is the safe direction.
- `glab` checks mirror the `gh` ones: `glab mr merge` / `mr accept` /
  `merge-request merge` must target an unprotected branch; `glab api` writes are
  blocked for MR merges into protected branches, protected branches, push rules,
  approval rules, deleting protected or milestone branches, commits or file
  edits on a protected branch (`branch=` field), releases, and project
  edit/delete/archive/transfer, plus the matching GraphQL mutations.
  `glab repo delete|transfer|update|edit` and `glab release create|delete|upload|update`
  are blocked. `glab repo archive` is a download and stays allowed.
- Forge detection is only for the Director's instructions: `AGENT_TEAM_FORGE`,
  then `git config agent-team.forge`, then the `origin` host (`github` /
  `gitlab` in the name), then GitHub. On GitLab, SessionStart adds
  `agent-team forge: gitlab` to the context, and the Director reads
  `skills/director/references/gitlab.md`. GitHub's context line is unchanged.
- Merge lines from `glab` get `"forge": "gitlab"` and
  `outcome_source: "glab mr view"`. GitHub lines keep their exact format.
- Tests fake `glab` the way they fake `gh` (`AGENT_TEAM_FAKE_GLAB`). The guard
  now honors both fake variables too, so tests can cover the "allowed" path.

## Alternatives
- Teach the skills `glab` and leave the scripts alone: the guard would still
  fail open on GitLab.
- Call the GitLab REST API directly with a token: needs the host, project id
  and token plumbing that `glab` already does, and a second auth setup.
- Detect the forge in the guard and only parse that CLI: a mis-detected
  self-hosted host would turn the guard off for the CLI that's actually used.

## Consequences
- Needs a `glab` with `mr view --output json`. Older builds (Ubuntu 24.04's
  packaged 1.36) make the guard block every MR merge, since it can't read the
  target branch. The docs say so.
- Self-hosted hosts whose name doesn't contain `gitlab` need
  `git config agent-team.forge gitlab` per clone (team-init asks).
- Verified with unit tests against a stand-in `glab` and a stand-in run of
  `tests/live/gitlab-live.sh`; the live script against a real instance is the
  remaining check.
