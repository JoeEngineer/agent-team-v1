# Live Codex test

`node tests/live/codex-live.js` installs this checkout as a plugin into a throwaway Codex home and runs the Codex Director path with one real `codex exec` (small Codex model from the model map, low effort, `workspace-write`). It is opt-in: `node tests/run.js` only loads `tests/*.test.js` and never runs this.

It skips with a message when `codex` is not on PATH, the model map has no Codex small tier, or no `auth.json` is found.

## What it does
1. Temp dirs on a short path (`C:\cx2\<pid>` on Windows, `<tmpdir>/cx2/<pid>` elsewhere): a git project with a local bare `origin`, and a temp `CODEX_HOME`.
2. Copies your `auth.json` into the temp home (it never writes to your real Codex home) and deletes it at cleanup.
3. Runs `codex plugin marketplace add <this checkout>` and `codex plugin add agent-team@agent-team`, then `scripts/codex-agents.js` and `scripts/codex-hooks.js` on the project.
4. Trust, the way a user's trust is recorded: marks the project trusted and writes one `[hooks.state.'<key>'] trusted_hash` per hook into the temp `config.toml`, with the hash from `codex app-server` `hooks/list` (`currentHash`). No flag that skips hook trust is used.
5. One `codex exec` makes the Director log delegations, spawn a scout and a reviewer, try a push to `main` (the guard must block it) and try a `git worktree add`.
6. Prints a PASS/FAIL table and deletes the temp dirs, also on failure.

`CODEX_LIVE_WINDOWS_SANDBOX` (default `unelevated`) sets `[windows] sandbox` in the temp config. `CODEX_LIVE_DEBUG=1` saves the raw exec output to the OS temp folder.

## Cost
One `codex exec` with two subagents on the small model: a few hundred thousand input tokens at most, mostly cached.

## Cleanup
Automatic. If it prints "cleanup incomplete", delete the printed folder by hand.
