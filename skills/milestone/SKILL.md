---
name: milestone
description: Start a milestone as Director — turn broad tasking into a plan and begin delegating. Use only when the user explicitly asks to start a milestone as Director or invokes this skill with a slug and goal.
argument-hint: <slug> <what to build, in plain words>
---

Load the `agent-team:director` skill and act as Director for this milestone. Take the milestone from the user's message: a slug followed by what to build (on Claude, the slash command appends an `ARGUMENTS:` line; on Codex, whatever the user wrote when invoking this skill). If none was given, ask for the slug and a plain-words description before doing anything else.

## Intake questions

Ask these at the start of intake, before any delegation (the breakdown included). The plugin root is two folders up from this skill's folder. Run `node "<plugin root>/scripts/models.js" show` first: it gives each tool's xlarge model, whether it is enabled, its `note`, and the map's `source` (the shipped default or the user's file).

1. **The xlarge grant.** Ask whenever the effective map has an xlarge model for the current tool that is not disabled. One multi-select question, showing each tool's xlarge model, its `note` and the map source, so the user can see whether the mapping is current:

   > Use xlarge in this milestone for: security reviews (at close and on flagged task PRs), architect, coach at close, hard-fix escalation?

   Choosing nothing is a valid answer: every role then runs its default row. A user who never wants this question sets `enabled: false` on xlarge in `~/.agent-team/models.json`.

2. **A second security review.** Ask only when you run on Claude and the Codex bridge tools (`mcp__codex-bridge__*`) are present:

   > Run a second, independent security review at milestone close through the Codex bridge? No / large/high / xlarge/high

   Offer xlarge/high only when the map's Codex xlarge entry is not disabled.

Write the answers into the project's `STATUS.md` under `## xlarge grant` (the granted roles, or none; the second review: none, large or xlarge), and log them (PowerShell form: the director skill's `references/codex.md`, "Logging from PowerShell"):

```
node "<plugin root>/scripts/log-event.js" milestone - <<'EOF'
{"milestone":"<slug>","xlarge_grant":["security-review","architect","coach","hard-fix"],"second_review":"none","map_source":"default"}
EOF
```

`xlarge_grant` lists only the granted roles (`[]` for none); `second_review` is `none`, `large` or `xlarge`; `map_source` is the `source` from `models.js show`. How the grant is used: the director skill's `references/routing.md`, "The xlarge grant".

## Then

Restate the goal, acceptance criteria, and out-of-scope in a few lines, then show me the planned task breakdown with routing (agent, tier (model)/effort, vehicle) before you delegate any implementation. Research and breakdown delegations can start after the intake questions.
