---
description: Set up the current project for the agent team (STATUS.md, decisions folder, logs folder, CLAUDE.md section).
---

Set up this project for the `agent-team` plugin. Templates are in `${CLAUDE_PLUGIN_ROOT}/templates/project/`.

1. Confirm the current folder is a git repo with a GitHub remote (`git remote -v`). If not, stop and tell me.
2. Copy, without overwriting anything that already exists:
   - `STATUS.md` → project root
   - `docs/decisions/0000-template.md` → `docs/decisions/`
   - `.claude/settings.json` → merge its `extraKnownMarketplaces` and `enabledPlugins` keys into the project's `.claude/settings.json` (create it if missing; keep existing keys).
3. Create `.agent-team/logs/` with a `.gitkeep`. Add `.agent-team/logs/.pending/` to `.gitignore`.
4. Show me `CLAUDE.agent-team.md` and ask whether to append it to the project's `CLAUDE.md`. Fill in the test/lint/CI commands you can find in the repo, and mark the rest `<fill in>`.
5. Suggest (don't apply) branch protection: `main` requires a PR plus status checks; `milestone/*` requires status checks only.
6. Commit on a new branch `chore/agent-team-setup` and tell me what you did. Don't push unless I say so.
