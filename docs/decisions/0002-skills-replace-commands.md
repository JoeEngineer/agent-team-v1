# 0002: Skills replace commands

Status: accepted

## Context
The plugin shipped four slash commands in `commands/` (team-init, milestone, status, coach). Codex converts only commands without `$ARGUMENTS`, so it dropped `milestone` and `coach`. A command and a skill with the same name collapse into one entry, so thin command files pointing at skills would only duplicate content.

## Decision
Convert the four commands to skills under `skills/<name>/SKILL.md` and delete `commands/`. Skill bodies read their input from the user's message instead of `$ARGUMENTS`. Verified with Claude Code 2.1.314: a plugin with only skills exposes `/agent-team:<name>`, and a skill without an `$ARGUMENTS` placeholder gets an `ARGUMENTS: <input>` line appended when run as a slash command.

## Consequences
- Claude users keep the same `/agent-team:<name>` slash names; Codex gets all four.
- One body serves both tools.
- Anyone who referenced `commands/` paths must use `skills/` instead.
- Skills stay model-invocable, so descriptions say when to use them.
