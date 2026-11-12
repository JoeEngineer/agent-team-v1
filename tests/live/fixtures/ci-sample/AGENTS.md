# ci-sample

Sample project for the agent-team live CI harness (see README.md).

## Agent team (Director pattern)

This project uses the `agent-team` plugin on Codex. Skills are invoked as `$agent-team:<skill>`. When I ask you to act as Director, run a milestone, or report team status, invoke `$agent-team:director` and follow it. The Director's Codex notes are in its `references/codex.md`; read that file before you spawn any agent. For a milestone, invoke `$agent-team:milestone`.

**Hooks check:** at the start of a Director session, look for an `agent-team hooks: active` line in your context. If it is missing, tell me the hooks are not running. Without them there is no guard and no automatic logging, so log delegations and reviews by hand with `scripts/log-event.js` and rely on the forge's branch rules (GitHub rulesets or GitLab protected branches). Codex runs the project hooks only after I trust them once (`/hooks`).

**Standing authorization (from me, the project owner):**
- As Director, delegate tasks inside the current milestone to subagents and separate sessions without asking first.
- Choose the tier and effort level for each delegation per the routing table in the skill.
- Merge PRs into `milestone/*` branches after a `reviewer` verdict of `approve` and green CI.
- Commit `STATUS.md` and `docs/decisions/` to the milestone branch. Logs in `.agent-team/logs/` stay local (gitignored); archive them at milestone close with `archive-logs.js`.

**Still ask me first:** merging into `main`, anything touching repo settings or branch protection, releases, work outside the current milestone, spending on cloud sessions.

**Project specifics:**
- Test command: `npm test`
- Lint command: `none`
- CI: GitHub Actions workflow "Sample CI", job `sample-ci` (about 2 minutes)
- Reviewer identity: `same account`
