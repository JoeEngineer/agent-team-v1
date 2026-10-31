# 0007: Hooks-active check at SessionStart

Status: accepted

## Context
Hooks fail silently: if they are not installed, not trusted (Codex), or not
loaded, the Director logs and guards nothing and nobody notices. We want a cheap
way for a session to learn that the hooks are running. See
`docs/codex-mapping.md` ("Hooks") for the Codex payloads.

## Decision
- `hooks/hooks.json` gains a `SessionStart` entry running
  `scripts/session-start.js` (timeout 10).
- The script prints `hookSpecificOutput.additionalContext` =
  `agent-team hooks: active (<tool>, <version>)`. The tool comes from
  `lib.detectTool`, the version from the plugin manifest. This puts the line in
  the model's context, so the Director can check it without running anything.
  Verified on Codex CLI 0.166: SessionStart `additionalContext` is injected.
- It also writes `.agent-team/logs/.pending/hooks-alive.json`
  `{ts, tool, guidance_version, session_id}`, but only when `.agent-team/`
  already exists, so unrelated repos get no new folders. If Codex (or a future
  version) does not inject `additionalContext`, this marker file is the
  fallback check. A non-git project works the same: nothing here needs git.
- SessionStart has no matcher, so it also fires on resume, clear and compact.
  That is harmless: each run refreshes the marker. The marker is only written
  when `.agent-team/` exists, so on Codex the context line is the primary check.
- The script never throws and always exits 0.
- No `SubagentStart` entry. `SubagentStop` plus the transcript give everything
  we need, and each extra hook entry costs Codex users another trust step
  (decided with the user at intake).
- Codex logger matchers change (live finding, Codex CLI 0.166): matchers are
  anchored regexes, so `spawn_agent` does not catch `collaborationspawn_agent`.
  The Codex part is now
  `^(?:collaboration)?(?:spawn_agent|followup_task|wait_agent|close_agent|send_input|resume_agent)$`.
  The real follow-up tool is `collaborationfollowup_task`; `send_input` and
  `resume_agent` do not exist in 0.166 but stay for older or newer versions.
  Claude names in the same matcher are unchanged.
- The guard's `git add -A` / `git add .` check now also covers
  `.agent-team/worktrees/`, with the same "exists and not ignored" rule.

## Alternatives
- Marker file only: goes stale across sessions (a file from last week says
  nothing about this session) and the model never sees it unless it looks.
  Kept as a fallback only.
- A probe command the Director runs at start: costs a tool call every session
  and proves less than the hook having actually fired.
- SessionStart context (chosen): fires every session, costs nothing, and is
  visible to the model.

## Consequences
- Codex users re-trust the hooks once after this release, because the hook set
  changed (new entry and a changed matcher).
- The Codex CLI does not run plugin hooks. On Codex these entries take effect
  through the project hooks file that a later task (CD-11) generates from
  `hooks/hooks.json`; until then only Claude Code runs them.
