# How the guidance is kept small

"Guidance" is every file an agent reads as instructions: `skills/director/SKILL.md`, the files in `skills/director/references/`, and `agents/*.md`. This page says how those files are laid out, why, and how to change them without growing them back. The decision is in [decisions/0020](decisions/0020-guidance-layers-and-budgets.md).

## Why size matters here

- **Compaction.** After Claude Code compacts a conversation it re-attaches the first 5,000 tokens of each invoked skill, and nothing of the reference files the skill told the model to read ([skills docs](https://code.claude.com/docs/en/skills), "Skill content lifecycle"). So a rule that lives only in a reference file can be gone halfway through a milestone, and a `SKILL.md` over the cap loses its end.
- **Drift.** A rule written out in three files is three rules. Before 1.0.0 the merge comment had two wordings and the exit-code handling was restated in five places.
- **Cost.** A role file is the system prompt of every spawn of that role.

## The four layers

| Layer | Where | What goes there | Survives compaction |
|---|---|---|---|
| 1. Invariants | `skills/director/SKILL.md` | Every rule that must hold at all times, one line each; the loop; where to read more | Yes (re-attached) |
| 2. Procedures | `skills/director/references/*.md` | How to do one step: the commands, the formats, the cases | No. `SKILL.md` and the SessionStart hook tell the Director to re-read them |
| 3. Just in time | The output of a script | What to do about one particular result (`merge-task.js` prints a `next` field) | Not needed: it is printed when it applies |
| 4. Enforcement | `scripts/guard.js`, `scripts/merge-task.js`, `scripts/ci-wait.js` | Rules that must not depend on anyone reading anything | Always |

Prefer the lowest layer that works. A rule a script can enforce or print should not be prose the Director has to remember. History (why a rule exists, what went wrong once) goes in `docs/decisions/` and `docs/coach/`, not in the guidance.

Role files (`agents/*.md`) are a subagent's system prompt, so compaction doesn't remove them; for those only drift and cost apply.

## One home per rule

Each rule is stated in one file. Other files point at it by file and section name; they don't restate it. A command line is written out once: the merge command only in `merging.md`, the PowerShell here-string only in `codex.md`. `tests/guidance.test.js` checks the cases that drifted before.

## The inventory

[`tests/guidance-rules.js`](../tests/guidance-rules.js) lists every rule: an id, its home file, a short anchor regex, the rule in plain words, and what enforces it besides the words. The test checks that each anchor matches its home file.

An anchor is a presence check, not a wording pin: a few distinctive words, at most 90 characters of regex. Rewording a file is free while the anchors still match.

## Size budgets

`tests/guidance.test.js` holds a byte budget per file, a little above its current size, and one for the set a Claude + GitHub Director loads (30 KB; it was 42 KB in 0.6.0). `SKILL.md` must stay under about 3,500 tokens by a bytes ÷ 3 estimate.

When a change doesn't fit, in this order:

1. Can a script enforce it or print it? Then it needs one line, or none.
2. Is it already said elsewhere? Point at that.
3. Is something else in the file history, or a special case that a script now handles? Remove it.
4. Only then raise the budget, in the same PR, and say why.

## Changing the guidance

- **Add a rule:** put it in its one home, add an inventory entry, stay inside the budget.
- **Move a rule:** change its `home` in the inventory.
- **Drop a rule:** delete its inventory entry in the same PR. A rule can't disappear by accident, because its anchor stops matching.
- **Every change:** bump `version` in both manifests, so the logs (`guidance_version`) can tell before from after and the Coach can compare. On Codex, re-run `scripts/codex-agents.js` so the generated agent files carry the new role text.

## What was not measured

The 1.0.0 rewrite was checked against the inventory and the test suite, not against live runs. Whether a Director follows the shorter files as well as the longer ones is a question for the live harness (`tests/live/`) and a Coach comparison across `guidance_version` 0.6.0 and 1.0.0.
