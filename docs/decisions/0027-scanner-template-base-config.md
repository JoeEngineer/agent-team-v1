---
id: 0027
title: Scanner template uses base-branch Trivy config on PRs
date: 2026-11-23
status: accepted
milestone: coach-followups
task: FU-10
decided_by: director
model: claude-sonnet-5-5
effort: medium
---

# 0027: Scanner template uses base-branch Trivy config on PRs

Amends decision 0022 (the scan template). Source: Coach report
`docs/coach/2026-11-23-security-review.md`, finding 6.

## Context

The template scanned the PR's own tree, so a PR could edit `.trivyignore` or
`trivy.yaml` and turn its own scan green. With no Dockerfile, `trivy-image`
finished as a passed job, which reads as scanned. Decision 0024 treats a skipped
job as unscanned.

## Decision

1. On `pull_request`, each job restores `trivy.yaml`, `.trivyignore`,
   `.trivyignore.yaml` and `trivy-secret.yaml` from `github.event.pull_request.base.sha`
   before Trivy runs, or removes the file when the base has none. A second
   `actions/checkout` (same pinned SHA, `persist-credentials: false`) fetches that
   commit into `.scan-base`; the SHA appears only in its `with: ref:`, never in a
   `run:` script. The restore step removes the PR's copy of each file, copies the
   base's if it exists, then deletes `.scan-base`, so Trivy never scans it. A PR
   that deletes a file gets it back.
   The step right before the second checkout fails the job if `.scan-base`
   already exists in any form (`[ -e .scan-base ] || [ -L .scan-base ]`, so a
   dangling link counts). Otherwise a PR could commit a symlink `.scan-base -> .`:
   `actions/checkout` follows it, finds the workspace's own repo, and checks the
   base out over the PR tree, so neither job would scan the PR. The guard fails
   visibly rather than deleting the path.
   On `push` the tree's own files are used. Permissions stay `contents: read`,
   there is no `pull_request_target`, and actions stay pinned by SHA.
2. A job `detect-dockerfile` outputs `found`. `trivy-image` has `needs` and a
   job-level `if`, so with no root `Dockerfile` it shows as skipped. The names
   `trivy-fs` and `trivy-image` are unchanged.

## Assumptions

- Trivy reads only those four files from the scan root, except for files a
  base `trivy.yaml` names: its `ignorefile:`, secret config, VEX documents,
  `ignore-policy` and check paths are read from the PR tree, so a PR can change
  them. A project that uses them should keep them out of the PR's reach or add
  them to the restore list in its own copy of the workflow; the template's list
  stays at four. The rest is untested. The role file's "Scanner config" rule
  (`agents/security-reviewer.md`) flags diff changes to the four files.
- A skipped required job does not block a merge on GitHub. So a PR that removes
  or moves the root `Dockerfile` skips `trivy-image` and still merges.
- Inline `trivy:ignore` comments are not covered.
- A `pull_request` run uses the PR's own copy of `security-scan.yml`, so a PR can
  still edit the workflow itself (for example drop the restore step or the
  `.scan-base` guard). This is inherent to `pull_request`. team-init tells the
  user to review changes to the workflow or make it an org ruleset's required
  workflow. The "Scanner config" rule does not name the workflow yet (follow-up).
- `actions/checkout` follows a symlink at its `path:` and reuses a repo it finds
  there; the `.scan-base` guard rests on this reading of its source. A dangling
  link or a regular file or directory at that path also fails the guard.
- The base files come from a second checkout, not `git fetch`, because the first
  checkout keeps no token (`persist-credentials: false`) and a bare `git fetch`
  of the base commit would likely fail on a private or internal repo. The second
  checkout also keeps no token. It must sit inside the workspace (`actions/checkout`
  rejects a path outside it), hence the delete before Trivy. Untested live.
- The template is unparsed and has had no live run. A live run in a scratch
  repo stays a follow-up.

## Consequences

- Changing the scan config takes two steps: merge the change, then it applies.
- With no Dockerfile at the root, a skipped `trivy-image` plus a passed
  `trivy-fs` reads `green` in the 0024 scan table (row 7, nothing to scan for
  some jobs, the others passed). `none` is only "the CI config has no scanner
  jobs". A skipped `trivy-image` is safe for the reviewer only when the tree at
  `head_sha` has no Dockerfile anywhere.

## Amendment (FU-19)

Close reviews of the milestone PR found two gaps; the template now does this:

- **The PR's own config files are secret-scanned.** In `trivy-fs` the restore
  step first copies the PR's version of each of the four files to
  `.scan-pr-config` (created with `mkdir`, which fails the job if the PR already
  has that path), then restores the base's. The `.scan-pr-config` folder stays in
  the workspace, so the one fs scan (base config, `secret` included,
  `exit-code: '1'`) reads those copies and fails on a secret in them. The copies
  are not config. Base-config protections from item 1 are unchanged.
- **Push runs use trusted config.** `milestone/**` is removed from the `push`
  trigger; `main` pushes are still scanned. Chosen over running push with
  `main`'s config because a milestone push run used the branch's own config under
  the same job names as the PR run, and PRs into and out of the milestone branch
  already get the base config. Cost: no scan on a plain push to a milestone
  branch until its PR is open.
- Item 1's "On `push` the tree's own files are used" now applies to `main` only.
- Confirmed from the Trivy v0.76.2 source (the pinned version): the fs walker
  skips only `**/.git`, `proc`, `sys` and `dev` by default, and the secret
  analyzer skips only the exact configured secret-config path, so files under
  `.scan-pr-config` are scanned. Residual, unchanged: a base `trivy.yaml` with
  `skip-dirs` or `skip-files` could still skip that folder. The template has had
  no live run.
