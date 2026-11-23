---
name: milestone
description: Start a milestone as Director — turn broad tasking into a plan and begin delegating. Use only when the user explicitly asks to start a milestone as Director or invokes this skill with a slug and goal.
argument-hint: <slug> <what to build, in plain words>
---

Load the `agent-team:director` skill and act as Director for this milestone. Take the milestone from the user's message: a slug followed by what to build (on Claude, the slash command appends an `ARGUMENTS:` line; on Codex, whatever the user wrote when invoking this skill). If none was given, ask for the slug and a plain-words description before doing anything else.

## Intake questions

Ask these at the start of intake, before any delegation (the breakdown included). The plugin root is two folders up from this skill's folder. Run `node "<plugin root>/scripts/models.js" show` first: it gives each tool's xlarge model, whether it is enabled, its `note`, and the map's `source` (the shipped default or the user's file).

1. **The xlarge grant.** Ask whenever the effective map has an xlarge model for the current tool that is not disabled. One multi-select question, showing each tool's xlarge model, its `note` and the map source, so the user can see whether the mapping is current:

   > Use xlarge in this milestone for: close security review, all security reviews (close and flagged task PRs), architect, coach (run for this milestone), hard-fix escalation?

   Choosing nothing is a valid answer: every role then runs its default row. A user who never wants this question sets `enabled: false` on xlarge in `~/.agent-team/models.json`.

2. **A second security review.** Ask only when you run on Claude and the Codex bridge tools (`mcp__codex-bridge__*`) are present:

   > Run a second, independent security review at milestone close through the Codex bridge? No / large/high / xlarge/high

   Offer xlarge/high only when the map's Codex xlarge entry is not disabled.

Write the answers into the project's `STATUS.md` under `## xlarge grant` (the granted roles, or none; the second review as the STATUS template words it: no / large/high / xlarge/high / not offered), and log them (PowerShell form: the director skill's `references/codex.md`, "Logging from PowerShell"):

```
node "<plugin root>/scripts/log-event.js" milestone - <<'EOF'
{"milestone":"<slug>","xlarge_grant":["security-review-close","security-review-task","architect","coach","hard-fix"],"second_review":"none","map_source":"default"}
EOF
```

`xlarge_grant` lists only the granted roles (`[]` for none) by their log names: `security-review-close` ("close security review": the milestone-close row of the grant table only), `security-review-close` and `security-review-task` together ("all security reviews": the close row and the flagged task PR row), `architect`, `coach` ("coach (run for this milestone)") and `hard-fix` ("hard-fix escalation"). The guidance uses these names too, as in "with `hard-fix` in the grant". `second_review` is `none`, `large` or `xlarge`; `map_source` is the `source` from `models.js show`. Log the line for every milestone, also when nothing was asked or granted (`[]`, `none`): it is what `status.js grant` checks the block against.

The logger keeps one answer per slug. If yours is refused (exit 1), record no grant and read the message:

- **Lines that disagree.** The slug already had a line that grants something else, logged by an agent or committed in the repository. Your line is written next to it, and `status.js grant` grants nothing for the slug (exit 23) until the user removes the foreign line by hand. The milestone must not use any grant until then. Show the user the lines the message lists and ask them to remove the foreign one from `.agent-team/logs/milestones.jsonl`; never remove a line yourself. Then log your line again: exit 0 is the only all-clear.
- **A rejected line** (an unknown role or key): fix your line and log it again.
- **A damaged log, a log git tracks, or a foreign `CLAUDE_PROJECT_DIR`:** ask the user. The message says what they must repair, untrack or change. Nothing was written: once it is fixed, log your line again; only exit 0 clears it.

Exit 0 with "already has this intake line" at a first intake means the line was there before you logged it: tell the user. How the grant is used: the director skill's `references/routing.md`, "The xlarge grant".

## Then

Restate the goal, acceptance criteria, and out-of-scope in a few lines, then show me the planned task breakdown with routing (agent, tier (model)/effort, vehicle) before you delegate any implementation. Research and breakdown delegations can start after the intake questions.
