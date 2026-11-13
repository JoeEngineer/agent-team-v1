---
id: 0020
title: Guidance in layers, one home per rule, size budgets (1.0.0)
date: 2026-11-13
status: accepted            # the user confirmed it on 2026-11-13, after merging #105
milestone: v1
task: none
decided_by: architect       # a single Claude session, not a Director run
model: claude-fable-5-2
effort: unknown
---

## Context
The user suspected the guidance was wordier than it needed to be, bloating context and risking loss at compaction. Looking at 0.6.0:

- The sentences were already terse. The bulk came from rules restated in several files (the `--names` rule in four places, exit-code handling in five, the close order written out twice), from procedure written as prose, and from history kept inside instructions.
- Claude Code re-attaches only the first 5,000 tokens of an invoked skill after a compaction, and none of the reference files it read (checked against the skills docs on 2026-11-13). `SKILL.md` was 14 KB, roughly 3,500 to 4,200 tokens, and growing; `merging.md` was not protected at all.
- About 195 test assertions matched guidance sentences word for word, some requiring the same rule in two files. A review finding added a sentence and a test pinned it, so the text could only grow.

## Options
1. **Copy-edit for length.** Little to gain; the sentences were not the problem.
2. **Re-layer and deduplicate**, with an inventory so no rule is lost, and tests that stop regrowth.
3. **Option 2 plus moving procedure into scripts** where a script can do or print the step.

## Decision
Option 3. The layout is described in `docs/guidance.md`:

1. `SKILL.md` holds every invariant, the loop and pointers. Budget 10,000 bytes.
2. Reference files hold procedures, each rule in one home.
3. `merge-task.js` prints the instruction for each result (decision 0019).
4. The guard and the scripts enforce what they can.

Supporting changes:
- `tests/guidance-rules.js` inventories 242 rules with a home file and a short anchor; `tests/guidance.test.js` checks them, per-file byte budgets, and single-source rules. The sentence-matching tests for the Director and role files are removed. Tests for the README, team-init, the mapping docs and the templates stay.
- The SessionStart hook adds a line after a compaction telling the Director to re-read `STATUS.md` and the reference for its next step.
- Codex logger internals moved from `codex.md` to `docs/codex-mapping.md`.

## Consequences
- What a Claude + GitHub Director loads fell from 42.1 KB to about 28 KB; `SKILL.md` from 14.1 KB to 8.1 KB.
- `reviewer.md` and `implementer.md` shrank only a few percent. Their rules are calibration, each one distinct; deduplication had little to remove. `coach.md` fell 24% by regrouping its log notes by file instead of by version.
- `architect.md`, `scout.md`, the `coach`, `milestone` and `status` skills and the `CLAUDE.md` / `AGENTS.md` templates are unchanged. `team-init` and the `STATUS.md` template each changed one line (where the check names come from).
- **Risk:** a shorter rule may be followed less reliably than the long form a past review asked for. The inventory shows every rule is still stated; it can't show that it is still obeyed. This needs the live harness on both tools and a Coach comparison of `guidance_version` 0.6.0 against 1.0.0.
- Projects on Codex must re-run `scripts/codex-agents.js` after upgrading, so the generated agent files carry the new role text.
