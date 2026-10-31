<!-- Paste this section into the project's CLAUDE.md (or keep as its own file and reference it). -->

## Agent team (Director pattern)

This project uses the `agent-team` plugin. When I ask you to act as Director, run a milestone, or report team status, load the `agent-team:director` skill and follow it.

**Standing authorization (from me, the project owner):**
- As Director, delegate tasks inside the current milestone to subagents and separate sessions without asking first.
- Choose the tier and effort level for each delegation per the routing table in the skill.
- Merge PRs into `milestone/*` branches after a `reviewer` verdict of `approve` and green CI.
- Commit `STATUS.md` and `docs/decisions/` to the milestone branch. Logs in `.agent-team/logs/` stay local (gitignored); archive them at milestone close with `archive-logs.js`.

**Still ask me first:** merging into `main`, anything touching repo settings or branch protection, releases, work outside the current milestone, spending on cloud sessions.

**Project specifics:**
- Test command: `<fill in>`
- Lint command: `<fill in>`
- CI: `<GitHub Actions workflow name, or "none">`
- Reviewer identity: `<"same account" or bot account name>`
