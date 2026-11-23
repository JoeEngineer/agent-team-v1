---
id: 0028
title: Two security-review grant words; which close residuals are accepted
date: 2026-11-23
status: accepted            # the user chose both on 2026-11-23, at the milestone close
milestone: coach-followups
task: none
decided_by: user
model: claude-opus-5-5
effort: unknown
---

# 0028: Two security-review grant words; which close residuals are accepted

## Context

The close reviews of the milestone PR (#160) raised two questions for the user.

1. The Codex second security review (major 3) found that the xlarge grant has a
   single `security reviews` role. `status.js grant` strips free-text notes, so
   the note this milestone used ("flagged task PRs at large/high; the close
   review stays xlarge/high") is not enforced. The one role covers both rows of
   the grant table in `routing.md`: the close review and flagged task PRs.
2. Three groups of known residuals had been waiting under "Needs the user":
   - the grant check (decision 0026, FU-6);
   - the scanner template (decision 0027, FU-10);
   - the `review-json` fence (FU-8).

## Options

For the grant:

1. **Close-only rule.** The grant covers only the close review, and flagged
   task-PR reviews always run at large/high.
2. **Two grant words.** The intake offers one word for the close review only and
   one for the close review plus flagged task PRs. `status.js grant` prints them
   as separate roles.
3. **Accept as a residual.** Keep one role and let the Director read the note.

For the residuals: accept each group, or reject it and fix it.

## Decision

- **Two grant words** (option 2), chosen by the user.
- **Accepted:** the scanner template residuals (0027). They are workflow
  self-edits, inline `trivy:ignore`, Dockerfile removal, and files a base
  `trivy.yaml` names.
- **Rejected, so they get fixed:**
  - the grant check residuals (0026), as task FU-22;
  - the fence residuals (FU-8), as task FU-23. FU-21 already covers the
    protected-field gap.

## Consequences

- FU-22 changes four places:
  - the intake question (`skills/milestone/SKILL.md`);
  - the template grant line;
  - the grant table in `routing.md`;
  - `status.js grant`.

  It also hardens the grant check against a pre-appended slug line, torn first
  lines, and `GIT_*` or `CLAUDE_PROJECT_DIR` in `lib.projectDir`. Where an
  attacker who can rewrite `milestones.jsonl` or `.git` cannot be stopped,
  decision 0026 must say so plainly.
- FU-23 closes the remaining fence gaps: a quoted block that is the only final
  block, and Unicode `trim()`.
- The 1.2.0 release notes state the accepted scanner residuals.
