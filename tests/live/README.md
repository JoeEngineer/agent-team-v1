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

# Live CI-wait harness

`node tests/live/ci-wait-live.js` runs a small fixed milestone with a headless Director (Claude or Codex) against a real GitHub repo whose CI takes about two minutes, then measures from the Director's own transcript how many turns and context tokens went to CI. It works with any plugin checkout, so the 0.5.0 baseline and the new version are measured the same way. It is opt-in: `node tests/run.js` never runs it (its helpers are unit-tested in `tests/ci-turns.test.js` and `tests/ci-wait-live.test.js`).

```
node tests/live/ci-wait-live.js --tool claude --repo OWNER/REPO --plugin <path to a plugin checkout> --label before
node tests/live/ci-wait-live.js --tool codex --repo OWNER/REPO --plugin <path to a plugin checkout> --label after --probe-auto-head
```

| Option | Meaning |
|---|---|
| `--tool claude\|codex` | Which Director to run. |
| `--repo OWNER/REPO` | The scratch repo (see below). |
| `--plugin <path>` | The plugin checkout under test: a checkout of commit `0205ab8` for the 0.5.0 baseline, or the milestone branch for "after". |
| `--label <text>` | Names the report (`before`, `after`, ...). |
| `--probe-auto-head` | After the run, queue `gh pr merge --auto --squash --match-head-commit <sha>` on a throwaway PR into the run's milestone branch, push another commit, wait for the checks, and record whether it merged anyway (`merged-anyway`, `held` or `inconclusive`). |
| `--keep` | Keep the temp folder and the GitHub items for inspection (the copied Codex `auth.json` is still deleted). |
| `--preflight-only` | Run only the read-only preflight and exit: 0 when the repo is ready, 2 when it is not (with the steps to fix it). Starts no clone, PR or Director. **Use this to check readiness**: running the harness without it starts a real run, including a seed run of about 3 minutes. |
| `--seed-only` | Push the fixture once so the `sample-ci` check name exists, then clean up. Use it before adding the check to the ruleset. |
| `--smoke` | Plumbing check only: a one-line Director prompt instead of the milestone, about 3 minutes. It does not need auto-merge or the ruleset. |
| `--model M`, `--timeout-min N`, `--out-dir DIR` | Director model (default: the tool's default), Director time limit (default 75), where the report goes (default `<tmp>/agent-team-ci-wait-live`). |
| `--cleanup-run <run> [--dry-run] [--force] [--out-dir DIR]` | Close the open PRs and issues, delete the branches of one earlier run, and delete that run's temp folder (found through the run file below), for example after the harness was killed hard. `--dry-run` only lists them. Pass the same `--out-dir` the run used, if any. |

## What you set up once

The scratch repo is a private GitHub repo with a `main` branch (a README is enough). The harness never changes repo settings or rules, so these are yours to do:

1. Settings > General > Pull Requests: tick **Allow auto-merge**.
2. Run `node tests/live/ci-wait-live.js --repo OWNER/REPO --seed-only` once. It pushes the fixture on a branch, opens a PR so the workflow runs, waits for `sample-ci`, and removes what it made. GitHub only offers check names it has seen run.
3. Settings > Rules > Rulesets > New branch ruleset: name `protect-milestones`, enforcement Active, empty bypass list, target `milestone/*` by pattern, **Block force pushes** on, **Require status checks to pass** on with `sample-ci`, **Require a pull request** off, **Restrict deletions** off. This is "Ruleset 2" of the plugin README with the check added. Rulesets on a private repo need a paid GitHub plan.
4. Check it with `node tests/live/ci-wait-live.js --repo OWNER/REPO --preflight-only`, not with a plain run: a plain run starts a real seed run and a Director.

Before every run the harness does a read-only preflight (`--preflight-only` runs just this): `gh` logged in, repo reachable with push access, Actions enabled, `allow_auto_merge`, and a ruleset requiring `sample-ci` on `milestone/*`. If something is missing it prints what, and the exact steps, and exits with code 2 without touching anything.

## What a run does

1. Clones the repo into a short temp folder (`C:\cw6\<pid>` on Windows, `<tmp>/cw6/<pid>` elsewhere; `AGENT_TEAM_LIVE_TMP` changes the base). Everything it creates carries a run prefix, `live-<UTC timestamp>-<tool>-<4 hex digits>`; the random part keeps two runs of the same tool in the same second apart. Before creating anything in the temp folder it writes a small run file, `ci-wait-<run>.run.json`, in the out-dir with the run name and the temp folder path, so `--cleanup-run` can find the folder later.
2. Seeds the fixture (`tests/live/fixtures/ci-sample`: a dependency-free Node project, a `sample-ci` workflow of about two minutes, and the files `team-init` would create). The fixture goes on `<run>-seed`, a PR runs the workflow on that commit, and once `sample-ci` is green the same commit is pushed as `milestone/<run>`. That is why a ruleset that requires `sample-ci` on `milestone/*` does not block the first push. The seed PR is then closed.
3. Starts the Director headless in the clone with the plugin under test:
   - Claude: `claude -p --plugin-dir <plugin> --output-format stream-json --verbose --dangerously-skip-permissions`. The run stops at once if Claude loaded a different `agent-team` than `--plugin`, or if the `agent-team hooks: active` line is missing, so the guard hooks always run.
   - Codex: `codex exec --json --dangerously-bypass-approvals-and-sandbox` with the plugin installed into a temp `CODEX_HOME` as `codex-live.js` does (marketplace add, plugin add, `codex-agents.js`, `codex-hooks.js`, hook trust recorded from `hooks/list`). The hooks-active line is checked after the run.

   The permission and sandbox bypass is only for this temp clone and this fixed prompt.
4. The prompt is the same for both plugin versions and does not say how to wait for CI: it invokes the milestone skill with a fixed plan of three small tasks (no architect, small tier, everything approved), asks for the milestone PR, and for a final `milestone-json {"status":"complete|incomplete","pr":<n>,"ci":"..."}` line. The plugin's own skill text drives the CI behaviour.
5. Reads the Director's transcript, the temp clone's `.agent-team/logs/`, and GitHub, writes the report, then cleans up.

## Report

A PASS/FAIL table for the four targets, the metrics, and a JSON file with everything (the path is printed; a redacted copy of the transcript sits beside it).

| Target | PASS when |
|---|---|
| no foreground `--watch` | no `--watch` command (or `gh run watch`) ran in the foreground. On Codex there is no background shell, so any `--watch` counts. |
| <= 1 CI-related Director turn per task PR | for each PR into the milestone branch, at most one Director turn was about CI, **and** the CI turns on task PRs plus the CI turns that name no PR (a bare `gh pr list --json statusCheckRollup`, a `reconcile-logs.js --merges` run) number no more than the task PRs. So three task PRs allow three CI turns in all; one extra turn that names no PR fails it. Turns that name only another PR, such as the milestone PR, are not counted. The detail line says how many turns were not tied to a PR. |
| reviewer `pending` only on timeout | every `ci: pending` in `reviews.jsonl` has a summary that states a wait of 8 minutes or more (the helper's default deadline is 9). |
| not "complete" before the PR checks finished | the Director's `milestone-json` said `incomplete`, or the milestone PR's checks had all finished before the line was printed. The line is stamped with the local clock when the harness reads it from the stream and compared with GitHub's `completedAt` for the last check, so only a gap of more than 10 seconds counts as early; the margin in seconds (negative: printed before the check finished) is shown next to the verdict and kept in the JSON as `milestone.marginSeconds`. `N/A` when no line was printed. |

Below the four targets the table has three `INFO` rows (no pass or fail; also in the JSON under `metrics.ci`):

| Row | JSON | What it counts |
|---|---|---|
| milestone PR CI turns | `metrics.ci.milestonePr` | CI-related Director turns that name the milestone PR (the one the harness finds for `milestone/<run>`, or the one `milestone-json` reports): count, total context tokens, foreground `--watch` commands. A turn naming both a task PR and the milestone PR counts here too, so batching them cannot hide milestone polling. |
| other PR CI turns | `metrics.ci.otherPr` | CI turns that name any PR that is neither a task PR nor the milestone PR, even alongside one that is (`ci-wait.js --once 4 77` counts under task and other). |
| total CI-related Director turns | `metrics.ci.total` | Every CI turn once (task PRs, milestone PR, other, and turns naming no PR) with its total context tokens: the figure to compare before and after. `metrics.ci.taskPrs` holds the task-PR share. |

A baseline run is expected to miss targets: that is data, not a harness failure. **Exit code:** 0 when the run finished and the report was written, whatever the targets say; 1 for a harness error (setup failed, the Director crashed or timed out, the wrong plugin or no hooks, cleanup failed); 2 for bad arguments or a failed preflight.

The metrics come from the Director's own transcript only, not its subagents' (Claude: assistant messages without a parent tool call, a message split over several lines counted once; Codex: the non-subagent rollout in the temp home):

- turns (model calls) and context tokens per turn: Claude `input + cache_read + cache_creation` per message id; Codex `last_token_usage.input_tokens` per `token_count` (cached input is included).
- CI-related turns: a turn whose shell calls match `gh pr checks`, `gh run watch|view`, `ci-wait.js`, `glab ci`, `head_pipeline`, `statusCheckRollup`, `reconcile-logs.js --merges`, `merge ... --auto|--auto-merge` or `--disable-auto`, or that a background-task notification started for such a command, or a poll of such a task. Matching is on the command text, so a PR description that quotes one of these also matches. Counts, tokens and a split per task PR.
- foreground vs background `--watch` count.
- the `ci` values in `reviews.jsonl`, and for each `pending` whether its summary states how long it waited.
- when `milestone-json` was printed against the milestone PR's last check, and queued lines in `merges.jsonl` with no later resolution (it runs `reconcile-logs.js --merges` first when the plugin under test has it, and looks up what GitHub says for any left).

## Cost

Each run takes 20 to 40 minutes of wall clock, plus the Director's model usage (three implementers, reviewers, and a Director that re-reads a long context each turn). On Actions expect roughly 15 to 25 runner minutes (ubuntu): the seed PR, each task PR, the push run after each merge, the milestone PR, a rerun when a task needs a fold-in, and the probe. A private repo on the free plan has 2000 minutes a month.

## Cleanup

On success, failure and Ctrl-C (SIGTERM and SIGHUP too, where the OS delivers them) the harness closes its own open PRs and issues, deletes the branches whose name starts with its run prefix (never `main` or the default branch, never another run's), and removes the temp folder, including any copied Codex `auth.json`. Auth is never written to the report, the transcript copy or the console.

A process that is killed hard (on Windows, Stop-Process, a timeout that kills the process, or a background task stopped by its parent) gets no handler, so it leaves its PRs, issues and branches on GitHub **and its temp folder** (`C:\cw6\<pid>` by default), which for a Codex run holds a copied `auth.json` under `h\`. Run `node tests/live/ci-wait-live.js --repo OWNER/REPO --cleanup-run <run> --dry-run` to see what is left (the run name is in the first lines of the output, and in the file name of the run file), then the same without `--dry-run`. It deletes the temp folder it finds in the run file, but only if the recorded base is the one the harness would use now (`AGENT_TEAM_LIVE_TMP` if set, else `C:\cw6` on Windows or `<os tmp>/cw6`), the folder is `<base>/<digits>`, it holds nothing but `h` and `p`, and none of the folder, `h` and `p` is a symlink or junction (nothing is ever deleted through a link; there is no separate pre-delete of `auth.json`). Before anything else (before it closes a PR or issue or deletes a branch) it reads the run file and refuses the whole cleanup, remote and temp folder, while the recorded pid is still alive, because the run may still be in flight; a dry run reports the same refusal. A run file with a missing or invalid pid cannot be told apart from a live run, so it is refused the same way. Pass `--force` when that pid is not the harness any more (a reused pid) or the pid is unknown. With no run file the remote cleanup still runs. Anything refused is left alone and reported (exit 1). Run `--cleanup-run` with the same `AGENT_TEAM_LIVE_TMP` the run had. If there is no run file (a different `--out-dir`, or it was deleted), delete the temp folder by hand. `--keep` skips cleanup, leaves the run file and prints that command.

## Known gaps

- The Claude stream format for a long Director run with subagents was checked on short runs only. If subagent messages ever arrive without `parent_tool_use_id`, the turn counts would include them; the report keeps every turn, so this is easy to spot.
- The full milestone run and `--probe-auto-head` need the repo set up as above. They are covered by tests against a stand-in `gh` and a local bare repo, and `--seed-only` and `--smoke` have run against GitHub for both tools, but a full run has not yet.
