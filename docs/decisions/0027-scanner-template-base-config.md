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
   before Trivy runs, or removes the file when the base has none. The SHA reaches
   the script through `env:`. The step fetches that one commit (`--depth=1`), so
   the default shallow checkout is enough. A PR that deletes a file gets it back.
   On `push` the tree's own files are used. Permissions stay `contents: read`,
   there is no `pull_request_target`, and actions stay pinned by SHA.
2. A job `detect-dockerfile` outputs `found`. `trivy-image` has `needs` and a
   job-level `if`, so with no root `Dockerfile` it shows as skipped. The names
   `trivy-fs` and `trivy-image` are unchanged.

## Assumptions

- Trivy reads only those four files from the scan root. This is untested. If
  it reads others, the fallback is the role file's "Scanner config" rule
  (`agents/security-reviewer.md`), which flags diff changes to such files.
- A skipped required job does not block a merge on GitHub.
- Inline `trivy:ignore` comments are not covered.
- The template is unparsed and has had no live run. A live run in a scratch
  repo stays a follow-up.

## Consequences

- Changing the scan config takes two steps: merge the change, then it applies.
- The security reviewer reports `scan: none` only when the tree at `head_sha`
  has no Dockerfile anywhere, so a skipped `trivy-image` is safe for it.
