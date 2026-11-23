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

> **Amended 2026-11-23 by [decision 0029](0029-two-security-grant-words-and-grant-check-fixes.md).**
> The user rejected the residuals below (decision 0028). 0029 fixes three of them
> and states the fourth as out of the plugin's reach. It also splits the
> `security reviews` role in two, changes item 4 (any line that is not a JSON
> object, before the slug's first line, now exits 19) and adds exit 22. The text
> below is kept as decided; where 0029 differs, 0029 holds.

## Context

The grant is written in two places at intake: the `## xlarge grant` block of
`STATUS.md` and one `milestone` line in `.agent-team/logs/milestones.jsonl`.
Agents can edit `STATUS.md`, and the Director reads the grant from it before it
spends xlarge. A block edited by mistake, or forged, would widen the grant with
no trace. The log line is written once, at intake, from the user's answer.

`node scripts/status.js grant --milestone <slug>` reads both and prints the
grant that holds. A companion mode, `--check --since <sha>`, lets the Director
record a close review's verdict in `STATUS.md` without moving the reviewed tree:
it passes only when the head differs from the reviewed commit in nothing, or in
`M STATUS.md` with an unchanged file mode.

## Decision

1. **The first `milestone` line for the slug wins.** The intake answer is fixed
   for the milestone, so a later line for the same slug (a re-run, a hand edit,
   an appended forgery) is ignored. The user chose this on 2026-11-23.
2. **The Director names the milestone.** `--milestone <slug>` is required;
   without it `grant` exits 2. The Director passes its own slug: the card's
   `milestone=`, or the `<slug>` of the `milestone/<slug>` branch. The slug is
   never read from `STATUS.md`, the file under check, so an edited
   `## Current milestone` cannot point the check at an earlier milestone whose
   first line granted more. When `STATUS.md` names a different slug there, the
   command exits 20, prints both and grants nothing. Two `## Current milestone`
   headings, or two bold slug lines under it, exit 17. The template's `<slug>`
   counts as no slug.
3. **The narrower grant wins, and the user is asked.** The effective grant is
   the roles named in both, and the lower of the two second-review tiers
   (`none` < `large` < `xlarge`). When the two differ, the command exits 16,
   prints both and says "use the narrower; ask the user". It never widens.
4. **A block with no log line is not trusted.** A block that names a role, or a
   second review, for a slug with no log line exits 18 and grants nothing. An
   unknown role word or tier word in the block exits 17. A first line for the
   slug that is torn, or has an unknown role or tier, exits 19. A line that does
   not parse and mentions the slug counts as the first line: it could have been
   it. So does a line whose raw text gives the slug as a `milestone` value but
   which parses to another milestone, as with a repeated `milestone` key (JSON
   keeps the last one).
5. **No block and no line is an empty grant** and exits 0. So does the unfilled
   template.
6. Free text in parentheses after the roles is a note and is not read as roles.
   A note must be in parentheses: `architect - a note`, `architect — a note`
   (em dash) and `architect; a note` read the note as a role word, exit 17 and
   grant nothing (fail closed). One table in `scripts/status.js` maps the
   question's words to the log's names:
   - security reviews: `security-review` (two words and two names since
     decision 0029);
   - architect: `architect`;
   - coach (run for this milestone), or the older coach at close: `coach`;
   - hard-fix escalation: `hard-fix`.
7. In a linked git worktree the log is read from the main checkout, through the
   same helper the logger uses (`logRoot` in `scripts/lib.js`).
8. **`--check --since` reads the commits, not the caller's view of them.** git
   runs as `git --no-replace-objects -c core.commitGraph=false`, with every
   `GIT_*` variable removed from its environment, and both diffs pass
   `--ignore-submodules=none`. So a replace ref, a forged commit-graph,
   `GIT_DIR` or `GIT_CONFIG_*` in the environment, or `ignore = all` for a
   submodule cannot make a commit that changes code read as status-only.

## Exit codes of `grant` and `--check --since`

| Code | Meaning |
|---|---|
| 0 | `grant`: the block and the line agree (or neither grants anything). `--since`: status-only |
| 2 | bad arguments: `grant` without `--milestone`, a SHA that is not full 40-hex |
| 14 | `--since`: not status-only (another path, a gitlink, a mode or type change, not an ancestor, `--check` fails at the head) |
| 15 | `--since`: git failed |
| 16 | `grant`: the block and the first line differ; use the narrower; ask the user |
| 17 | `grant`: `STATUS.md` is unreadable for the grant (unknown word, repeated line, two headings, two bold slug lines) |
| 18 | `grant`: the block grants something and the log has no line for the slug |
| 19 | `grant`: the log is unreadable, or the first line for the slug is torn, has bad fields, or repeats the `milestone` key |
| 20 | `grant`: `## Current milestone` names a slug other than `--milestone` |
| 21 | `set`: the temp file path already exists; nothing was written or followed |
| 22 | `grant`: `CLAUDE_PROJECT_DIR` names a different project from the cwd's (decision 0029) |

## Consequences

- The Director runs `grant --milestone <slug>` with its own slug before spending
  xlarge, and follows its exit code.
- **Residuals, as accepted on 2026-11-23 and rejected by the user the same day
  (decision 0028).** What became of each is in decision 0029: the torn first
  line and the pre-appended slug line are fixed, and so is the environment
  moving the log (found in the close review). **Rewriting `milestones.jsonl`
  or the shared `.git` is not fixed and cannot be from inside the plugin:**
  an agent that can write those files can still forge a grant, and nothing
  here detects it.

  The check raises the cost of a forged grant; it does not sign
  or lock anything. Signing is out of scope. These were not stopped:
  - **Rewriting `milestones.jsonl`.** An agent that can write the ignored log
    file can change or reorder its first line for the slug.
  - **A hand-crafted first line torn before the slug ends**, such as
    `{"milestone":"cu` followed by a newline. It does not name the slug, so it
    is skipped and a later line is read. A real torn append has no trailing
    newline, so it is the last line, and no later line follows it.
  - **A new slug appended ahead of the Director.** An agent can append a line
    for a slug through the normal logger (`log-event.js milestone`) and point
    `STATUS.md` at it, or write a wide line for the next milestone before the
    Director's own intake line. The only guard is that the Director passes
    its own slug, and that its intake line is the first for that slug.
    `grant` cannot tell an agent's line from the Director's.
  - **`--check --since` trusts the local repository** beyond the fixes in
    item 8. It reads the object store and config of the shared `.git` that
    agents can write: an object file replaced in place, or hooks and config
    that the fixes do not override, are not detected. Run it in a checkout
    agents cannot write when that matters.
- `--check --since` compares trees, not intent: a `STATUS.md` edit that passes
  `--check` and keeps its mode counts as status-only, whatever it says.
