# Live Codex test

`node tests/live/codex-live.js` installs this checkout as a plugin into a throwaway Codex home and runs the Codex Director path with one real `codex exec` (small Codex model from the model map, low effort, `workspace-write`). It is opt-in: `node tests/run.js` only loads `tests/*.test.js` and never runs this.

It skips with a message when `codex` is not on PATH, the model map has no Codex small tier, or no `auth.json` is found.

## What it does
1. Temp dirs on a short path (override the base folder with `AGENT_TEAM_LIVE_TMP`; `C:\cx2\<pid>` on Windows, `<tmpdir>/cx2/<pid>` elsewhere by default): a git project with a local bare `origin`, and a temp `CODEX_HOME`.
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

## Known limitation row
Row (a) (`git worktree add` inside the exec sandbox) is expected to fail on the unelevated Windows sandbox, where `.git` is read-only (see `skills/director/references/codex.md`). It prints `KNOWN-LIMITATION` instead of `FAIL` and does not affect the exit code; it prints `PASS` if the worktree add works. Any other failing row exits 1.

If the run is interrupted (Ctrl-C or SIGTERM), the handler deletes the temp folder, including the copied `auth.json`, and exits 130.

`node tests/live/helpers-check.js` unit-checks the exit-code, cleanup-scoping and cache-version logic without Codex.

# Live GitLab test

`GITLAB_TEST_PROJECT=group/scratch bash tests/live/gitlab-live.sh` checks the GitLab path against a real instance (gitlab.com or self-hosted) through the real `glab`. It is opt-in like the Codex test.

Needs `git`, Node 18+, and a current `glab` logged in to the project's host (`glab auth login --hostname <host>`); it fails early if `glab mr view` has no `--output json`. Point it at a throwaway project you can push to and merge in.

## What it does
1. Clones the project into a temp folder and pushes three branches: `live-main-<ts>` (stands in for `main`, so your real `main` is never touched), `milestone/live-<ts>` and `task/live-<ts>`.
2. Opens two MRs with `glab mr create`: task → milestone, and milestone → the stand-in main.
3. Checks the `glab mr view --output json` fields the forge layer reads, forge detection from the remote (setting `git config agent-team.forge gitlab` in the temp clone if the host name is neutral), and the session-start note.
4. Runs `scripts/guard.js` on merge, `glab api` and push commands, with the stand-in main marked protected: merges into the milestone are allowed; merges into the stand-in main, an unknown MR, unprotecting a branch and pushing to it are blocked.
5. Merges the task MR for real, feeds that command to `scripts/log-delegation.js`, and checks the `merges.jsonl` line (`merged`, or `auto-merge-queued` if a pipeline is running; `forge`, `milestone`, `outcome_source`).
6. Prints a PASS/FAIL table, closes the open MR and deletes the three branches and the temp folder, also on failure or Ctrl-C.
