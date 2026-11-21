---
id: 0021
title: The guard and the hooks-active line are enabled per project
date: 2026-11-20
status: accepted            # the user asked for it on 2026-11-20
milestone: v1
task: none
decided_by: user            # implemented in a single Claude session, not a Director run
model: claude-fable-5-2
effort: unknown
---

# 0021: The guard and the hooks-active line are enabled per project

## Context

The plugin is usually installed at user level (`enabledPlugins` in
`~/.claude/settings.json`), so Claude Code loads `hooks/hooks.json` in every
session of every project. The logger already stayed out of projects that never
set agent-team up (`lib.inUse`). The guard and the SessionStart line did not:
the guard blocked pushes to `main`, force-pushes, releases and repo edits in
every project, and every session showed `agent-team hooks: active`. Nobody had
decided that; the user expected agent-team to be on only where they chose it.

## Decision

Agent-team is enabled per project. `guard.js` and `session-start.js` act only
where `lib.enabledHere` is true:

- the hook was run by the project's own hooks (`AGENT_TEAM_HOOK_SOURCE=project`,
  the Codex shim), or
- the project is in use (`lib.inUse`): it has an `.agent-team/` folder, or its
  `.claude/settings.json` / `settings.local.json` enables the plugin, or its
  `.codex/hooks.json` calls the shim, or
- the project folder is a git worktree whose main checkout is in use. A
  worktree has no ignored files, so a project that ignores `.agent-team/`
  shows no sign of it there.

Anywhere else the guard returns without a decision and the SessionStart hook
prints nothing. The logger's own check (`lib.inUse`) counts such a worktree too.

**Logs live in the main checkout.** `.agent-team/logs/` is ignored and a
worktree is removed when its task ends, so lines written inside a worktree
would be deleted with it. `lib.logPath` / `lib.logDir`, the SessionStart
marker and `archive-logs.js` therefore use the main checkout's `.agent-team/`
when the project folder is a linked worktree (`lib.logRoot`). On Claude Code
the logs of worktree agents and sessions already landed there; on Codex the
project folder is the git root of the working folder, so a session or shim run
from a worktree wrote into the worktree.

## Consequences

- A user-level install no longer changes what git, `gh` or `glab` commands do
  in other projects.
- The Director's hooks check reads a missing line as "hooks not running or
  project not set up", and the fix for the second is `team-init`.
- The guard fails open where it cannot tell that a project is set up. That
  matches its role: a guardrail against mistakes, with the forge's branch rules
  as the real enforcement.
- The logger still starts logs in a project that is not set up when the event
  is the team's own (a role agent or a task card). That creates `.agent-team/`,
  which turns the guard on there from then on.
- The guard checks `enabledHere` only for commands that mention git, gh, glab
  or merge-task. The worktree lookup reads git's own files (`.git`, then
  `commondir`) and spawns no process, because the logger asks on every hook
  call.
- A Director that itself runs in a worktree finds the logs in the main
  checkout, not under its own folder. The scripts resolve that for it; a path
  typed by hand has to name the main checkout.

## Alternatives

- **Per session (only while the Director skill runs):** closer to "who is the
  guard for", but the Director's subagents and spawned sessions have their own
  session ids, and hooks have no reliable way to tell a Director session.
- **Install the plugin per project only:** needs no code, but then `team-init`
  is not available in a new project until its settings are edited by hand.
