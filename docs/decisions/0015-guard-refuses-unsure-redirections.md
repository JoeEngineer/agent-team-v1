---
id: 0015
title: The guard refuses redirections the shells read differently
date: 2026-11-11
status: accepted
milestone: ci-wait
task: CW-2
decided_by: architect
model: claude-opus-5-5
effort: high
---

## Context
The guard read the `2` of `gh pr merge --squash 2>&1` as the PR number
(decision 0012 schedules the fix). Two attempts each left a fail-open: the
guard checked a different PR, or the current branch, than the shell would
merge. Attempt 1 dropped a digit glued to `&>`. Attempt 2 modelled bash and
PowerShell as two readings and refused only when they merged different PRs,
but `""5>f` and `5"">f` were still dropped as file descriptors (bash reads
them as the argument 5). Each fix listed more cases, and each review found
one more.

Checked with bash, PowerShell 5.1 and cmd: a lone 1-6 written right before
`>`, `>>` or `>&1` is a stream in all three. PowerShell's other `N>&M` and
`N>|` forms don't parse, so nothing runs. Every other glued word is either
read differently by some shell or depends on rules the guard's parser doesn't
model (quote removal, escapes, variables, globs): bash takes any unquoted digit string as a
file descriptor and a quoted, escaped or variable word as an argument;
PowerShell takes only 1-6 and `*`; cmd takes the last digit.

## Options
1. **Model each shell** (attempt 2): keep a bash and a PowerShell reading per
   segment, refuse when they merge different requests, check both otherwise.
   It allows the most commands, but it is only as safe as the model, and the
   model is what kept missing cases.
2. **Refuse what isn't certain**: drop a glued word as a stream number only
   when its raw text is exactly one digit 1-6 and the operator starts with `>`.
   Any other glued word, and any redirection target ending in a backslash
   (bash escapes the next character, PowerShell doesn't), makes the whole
   command unsure. The guard refuses an unsure command that runs git, gh or
   glab, before any lookup.
3. Option 2, but refuse only in segments the guard checks (merge, push, API
   write). Narrower, but it needs the guard's list of checked commands and
   each shell's reading of command words again, so it brings back the
   modelling from option 1.

## Decision
Option 2. The invariant: *the guard drops a word glued to a redirection only
when every supported shell reads it as a stream number; for any other glued
word it refuses the command instead of checking any reading of it.* The check
reads the raw source text (quotes, backslashes, braces, line continuations
included), so a word can't pass for `5` by decoding to it. The Director never
needs another glued form: `2>&1`, `2>/dev/null`, `2>$null`, `>out.txt` after a
space, `| tee` and the chained gate calls of decision 0012 are all unaffected.
The deny message says how to rewrite the command, and does not send the agent
to the user.

## Consequences
- Some harmless commands are refused when they also run git, gh or glab:
  `git diff>patch.txt`, `gh pr view 5 --json number>out.json`,
  `gh pr merge 5 7>log`, `echo a>b; git status`. Rewriting with a space fixes them.
- `5&>f`, which attempt 2 checked as PR 5, is now refused.
- The segments still hold bash's reading, for the merge logger, which only
  describes commands that already ran.
- Not covered (they are not about redirections, and the guard is a guardrail,
  not a sandbox): input redirections (`<`), globs outside a redirection, a
  backslash before a separator or quote outside a redirection target
  (`--subject a\;b 5`, `"a \"b\" c"`), PowerShell backtick escapes, and
  variables used as command words or targets (`gh pr merge $n`).
