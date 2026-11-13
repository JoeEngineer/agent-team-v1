---
id: 0011
title: A Node helper waits for CI, with its own deadline
date: 2026-11-11
status: accepted
milestone: ci-wait
task: CW-0
decided_by: architect
model: opus
effort: high
---

## Context
Reviewers should wait for CI in one blocking command of about 15 minutes, on
GitHub and GitLab, from bash and Windows PowerShell 5.1, on Claude and Codex.
Claude's foreground Bash stops at 10 minutes. Codex's shell timeout is unclear.
`gh pr checks --watch` has no deadline. GitLab has no watch command, so a
polling loop would be written twice (bash and PowerShell 5.1, which has no `&&`
and whose `timeout` is a different program). `gh pr checks --required` may
error when a branch has no required checks.

## Options
1. **Raw commands**: `gh pr checks --watch --fail-fast --interval 30`, plus a
   GitLab loop per shell.
2. **`scripts/ci-wait.js`**: Node built-ins only, both forges, its own deadline
   (default 9 minutes), one JSON line per PR with the head SHA it saw, exit
   codes 0 green, 1 red, 8 pending, 3 none, 4 head moved, 2 unknown. `--once`
   for a quick gate; `--names` for setup.

## Decision
Option 2. One command for both forges and both shells, readable by scripts and
by the Director, and it reports the SHA it checked. The reviewer runs it after
the review work, in at most two blocking calls (about 9 + 6 minutes) to stay
under Claude's foreground cap. The README still documents the plain `gh` forms.

## Consequences
- Reviewers need the absolute plugin path on the task card.
- One more script to maintain and test (a stand-in gh/glab in tests).
- A CLI error reads as `unknown`, never as `none`, so a broken `gh` can't pass
  the gate.
