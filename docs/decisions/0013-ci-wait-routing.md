---
id: 0013
title: ci-wait routing overrides and vehicle
date: 2026-11-11
status: accepted
milestone: ci-wait
task: none
decided_by: director
model: claude-opus-5-5
effort: unknown
---

## Context
The CW-0 breakdown flagged three tasks `above-table` and two tasks the table
puts in a session.

## Options
1. Follow the table as written.
2. Override where the reason touches a never-break rule.

## Decision
- **CW-2** (fix, medium): medium tier at **high** effort instead of medium. It
  changes the guard tokenizer that every merge base check uses, and fixes a
  fail-open bug.
- **CW-4** (docs, medium): **medium** tier (sonnet) instead of small. It
  restates the merge gates across the reviewer, Director, GitLab and Codex
  prompts; a wrong sentence weakens the gate.
- **CW-5** (docs, medium): table as written (small/medium). The README follows
  decisions already written down.
- **CW-1, CW-6** (hard): the table says session. They run as background
  worktree subagents at the same tier and effort, so their delegation, result
  and review stay in this session's logs and the Director gets the result
  back directly.
- **CW-6** starts in wave 1 against CW-1's pinned interface (only new files),
  so the baseline run can start sooner.

## Consequences
The Coach sees two deliberate overrides with reasons on the cards' `WHY` lines.
