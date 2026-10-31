---
name: status
description: Director status report — done, in progress, blocked, needs you. Use when the user asks for the agent team's status report, or what is blocked or waiting on them.
---

As Director (load the `agent-team:director` skill if it isn't loaded), give me a status report. Don't delegate this.

Read `STATUS.md`, the last ~30 lines of `.agent-team/logs/delegations.jsonl` and `reviews.jsonl`, and `gh pr list --state open`. Then answer in this order, briefly:

1. **Needs me** — decisions or approvals waiting on me.
2. **Blocked** — what and why.
3. **In progress** — task, agent, model/effort, attempt.
4. **Done since last report** — merged tasks.
5. **Escalations** — any task that moved up a tier, and why.

If `STATUS.md` disagrees with git/GitHub, say so and fix `STATUS.md`.
