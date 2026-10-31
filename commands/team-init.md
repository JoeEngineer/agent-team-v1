---
description: Set up the current project for the agent team (STATUS.md, decisions folder, logs folder, CLAUDE.md section).
---

Set up this project for the `agent-team` plugin. Templates are in `${CLAUDE_PLUGIN_ROOT}/templates/project/`.

1. Confirm the current folder is a git repo with a GitHub remote (`git remote -v`). If not, stop and tell me.
2. Copy, without overwriting anything that already exists:
   - `STATUS.md` → project root
   - `docs/decisions/0000-template.md` → `docs/decisions/`
   - `.claude/settings.json` → merge its `extraKnownMarketplaces` and `enabledPlugins` keys into the project's `.claude/settings.json` (create it if missing; keep existing keys).
3. Create `.agent-team/logs/` with a `.gitkeep`. Add `.agent-team/logs/.pending/` and `.claude/worktrees/` to `.gitignore` (agent worktrees live there and must never be committed).
4. Show me `CLAUDE.agent-team.md` and ask whether to append it to the project's `CLAUDE.md`. Fill in the test/lint/CI commands you can find in the repo, and mark the rest `<fill in>`.
5. Check branch protection with `gh api repos/{owner}/{repo}/rulesets` (read-only). If `main` or `milestone/*` isn't covered, show me the two rulesets from the plugin README's "Protect your branches" section (`${CLAUDE_PLUGIN_ROOT}/README.md`) with the repo filled in, and explain why the bypass list stays empty and approvals stay at 0. Don't apply them. Changing repo rules is mine to do, and the guard hook blocks it anyway.
6. Commit on a new branch `chore/agent-team-setup` and tell me what you did. Don't push unless I say so.
