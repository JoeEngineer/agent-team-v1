---
id: 0026
title: The xlarge grant is cross-checked against the intake log line
date: 2026-11-23
status: accepted            # the user chose first-line-wins on 2026-11-23; implemented in 1.2.0
milestone: coach-followups
task: FU-6
decided_by: user
model: claude-sonnet-5-5
effort: medium
---

# 0026: The xlarge grant is cross-checked against the intake log line

Builds on decision 0022 (the per-milestone xlarge grant).

## Context

The grant is written in two places at intake: the `## xlarge grant` block of
`STATUS.md` and one `milestone` line in `.agent-team/logs/milestones.jsonl`.
Agents can edit `STATUS.md`, and the Director reads the grant from it before it
spends xlarge. A block edited by mistake, or forged, would widen the grant with
no trace. The log line is written once, at intake, from the user's answer.

`node scripts/status.js grant` reads both and prints the grant that holds. A
companion mode, `--check --since <sha>`, lets the Director record a close
review's verdict in `STATUS.md` without moving the reviewed tree: it passes only
when the head differs from the reviewed commit in nothing, or in `M STATUS.md`
with an unchanged file mode.

## Decision

1. **The first `milestone` line for the slug wins.** The intake answer is fixed
   for the milestone, so a later line for the same slug (a re-run, a hand edit,
   an appended forgery) is ignored. The user chose this on 2026-11-23.
2. **The narrower grant wins, and the user is asked.** The effective grant is the
   roles named in both, and the lower of the two second-review tiers
   (`none` < `large` < `xlarge`). When the two differ, the command exits 16,
   prints both and says "use the narrower; ask the user". It never widens.
3. **A block with no log line is not trusted.** A block that names a role, or a
   second review, for a slug with no log line exits 18 and grants nothing. An
   unknown role word or tier word in the block exits 17. A first line for the slug
   that is torn, or has an unknown role or tier, exits 19. A line that does not
   parse and mentions the slug counts as the first line: it could have been it.
4. **No block and no line is an empty grant** and exits 0. So does the unfilled
   template.
5. Free text in parentheses after the roles is a note and is not read as roles.
   One table in `scripts/status.js` maps the question's words (security reviews,
   architect, coach at close, hard-fix escalation) to the log's names
   (`security-review`, `architect`, `coach`, `hard-fix`).
6. In a linked git worktree the log is read from the main checkout, through the
   same helper the logger uses (`logRoot` in `scripts/lib.js`).

## Consequences

- The Director runs `grant` before spending xlarge and follows its exit code.
- **Residual:** an agent that can rewrite `milestones.jsonl` is not stopped. The
  check raises the cost of a forged `STATUS.md` block from one edit to an edit of
  an ignored log file; it does not sign or lock the log. Signing is out of scope.
- `--check --since` compares trees, not intent: a `STATUS.md` edit that passes
  `--check` and keeps its mode counts as status-only, whatever it says.
