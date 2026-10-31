---
name: milestone
description: Start a milestone as Director — turn broad tasking into a plan and begin delegating. Use only when the user explicitly asks to start a milestone as Director or invokes this skill with a slug and goal.
argument-hint: <slug> <what to build, in plain words>
---

Load the `agent-team:director` skill and act as Director for this milestone. Take the milestone from the user's message: a slug followed by what to build (on Claude, the slash command appends an `ARGUMENTS:` line; on Codex, whatever the user wrote when invoking this skill). If none was given, ask for the slug and a plain-words description before doing anything else.

Start with intake (step 1 of the loop): restate the goal, acceptance criteria, and out-of-scope in a few lines, then show me the planned task breakdown with routing (agent, tier (model)/effort, vehicle) before you delegate any implementation. Research and breakdown delegations can start right away.
