---
name: team-init
description: Set up the current project for the agent team (STATUS.md, decisions folder, logs folder, gitignore, branch rulesets, and the agent-team section for CLAUDE.md on Claude Code or AGENTS.md on Codex, plus Codex agent files and project hooks when run on Codex). Use when the user wants to initialize or set up a project for the agent team.
---

Set up this project for the `agent-team` plugin. The shared steps apply to both tools. Then run the steps for the tool you are running in (Claude Code or Codex), and offer the other tool's steps at the end. If you cannot tell which tool you are in, ask me.

**Plugin root:** the folder two levels up from this skill's folder. Templates are in `<plugin root>/templates/project/`. On Claude Code the plugin root is `${CLAUDE_PLUGIN_ROOT}`. Codex does not expand that variable in skill text, and its plugin lives in the Codex plugin cache: `<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/agent-team/<version>/`. Use the newest version folder (find it with `ls "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/agent-team/`). Run the commands below from the project root.

## Shared steps (both tools)

1. Confirm the current folder is a git repo with a GitHub remote (`git remote -v`). If not, stop and tell me.
2. Copy, without overwriting anything that already exists:
   - `STATUS.md` → project root
   - `docs/decisions/0000-template.md` → `docs/decisions/`
3. Create `.agent-team/logs/` with a `.gitkeep` if it is not there yet.
4. Gitignore. Open `.gitignore` (create it if missing) and add each line below that is not already in it, once each. Keep existing lines as they are.
   - `.agent-team/logs/*` and `!.agent-team/logs/.gitkeep` (logs stay local and are archived at milestone close; the folder is kept; `.agent-team/logs/.pending/` is covered by the first line)
   - `.agent-team/worktrees/` and `.claude/worktrees/` (agent worktrees live there and must never be committed)
   - `.codex/agents/*-small.toml`, `.codex/agents/*-medium.toml`, `.codex/agents/*-large.toml`, `.codex/agents/*-xlarge.toml` (generated per machine by `codex-agents.js`; harmless in a project that never uses Codex)

   Do not ignore `.codex/hooks.json` or `.codex/agent-team-hook.js`. Those are committed.
5. Check branch protection with `gh api repos/{owner}/{repo}/rulesets` (read-only). If `gh` is not installed or not logged in, say so, skip this check, and tell me to look at the rulesets by hand. If `main` or `milestone/*` is not covered, show me the two rulesets from the plugin README's "Protect your branches" section (`<plugin root>/README.md`) with the repo filled in, and explain why the bypass list stays empty and approvals stay at 0. Don't apply them. Changing repo rules is mine to do, and the guard hook blocks it anyway.

## Claude Code steps

Run these only when you are running in Claude Code.

C1. Merge `templates/project/.claude/settings.json` into the project's `.claude/settings.json`: merge its `extraKnownMarketplaces` and `enabledPlugins` keys, create the file if it is missing, and keep existing keys.

C2. Show me `templates/project/CLAUDE.agent-team.md` and ask whether to append it to the project's `CLAUDE.md`. If `CLAUDE.md` already has an "## Agent team" section, don't add a second one; offer to update the existing section instead. Fill in the test, lint and CI commands you can find in the repo, and mark the rest `<fill in>`.

## Codex steps

Run these only when you are running in Codex.

X1. Agent files. Run `node "<plugin root>/scripts/codex-agents.js"` and show me its summary. It writes one `<role>-<tier>.toml` per agent role and enabled Codex tier into `.codex/agents/`, which is gitignored. If the summary says no Codex entries are enabled in the model map, tell me that no agent files were generated, so the Director cannot route to a Codex tier until the model map enables one.

X2. Project hooks. Run `node "<plugin root>/scripts/codex-hooks.js"` and show me its output. It writes `.codex/agent-team-hook.js` and `.codex/hooks.json`, and both are committed. If it reports that `hooks.json` is not valid JSON, it changed nothing: show me the message and skip the rest of this step until I fix the file. Then tell me the Codex CLI does not run plugin hooks, so these project hooks are what make the guard and the logs work. Codex runs project hooks only after I trust them once per project: open `/hooks` or accept the startup prompt. Untrusted hooks do nothing and fail silently. Ask me to confirm I have trusted them, and say that the next session should show an `agent-team hooks: active` line.

X3. AGENTS.md. Show me `templates/project/AGENTS.agent-team.md` and ask whether to append it to the project's `AGENTS.md` (create the file if it is missing, once I agree). If `AGENTS.md` already has an "## Agent team" section, don't add a second one; offer to update the existing section instead. Fill in the test, lint, CI and reviewer identity lines the same way as step C2.

## Other tool's steps

When the steps for this tool are done, ask whether I want the other tool set up too. Offer Codex (X1 to X3) if you ran in Claude Code, or Claude Code (C1 and C2) if you ran in Codex. The other tool's steps only read and write project files and use the same plugin root, so they also work from this session.

## Commit

6. Commit on a new branch `chore/agent-team-setup` and tell me what you did. Stage only the paths this run wrote or changed, by name, never with `git add -A` or `git add .`. The possible paths are `STATUS.md`, `docs/decisions/0000-template.md`, `.agent-team/logs/.gitkeep`, `.gitignore`, `.claude/settings.json` (Claude), `CLAUDE.md` (Claude, if appended), `AGENTS.md` (Codex, if appended), and `.codex/hooks.json` and `.codex/agent-team-hook.js` (Codex). Don't stage ignored files such as `.codex/agents/`. Don't push unless I say so.

## Running it again

Re-running this skill is safe. Nothing that already exists is overwritten, gitignore lines are not duplicated, `codex-hooks.js` merges its own entries and keeps the rest of `hooks.json`, `codex-agents.js` only rewrites files it generated, and an existing "## Agent team" section is detected rather than added twice. Tell me what was already in place and what changed.
