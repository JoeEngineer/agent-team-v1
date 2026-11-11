# Handoff: making team activity visible

Written 2026-11-10 from a cloud session, for a local agent to pick up. Read against `main` at 0.4.8 (`0d80702`).

## What Joe asked

How to visualize what the agent team is doing. He runs a self-hosted Mattermost, so channels and boards are available, and he is open to other tools. No option has been chosen yet and no code has been written. This note records what was found and what was suggested, so the work can start locally.

## What this note is based on

- Reading the repo: `README.md`, `STATUS.md`, `hooks/hooks.json`, `scripts/lib.js`, `scripts/records.js`, `scripts/log-delegation.js`, `scripts/log-event.js`, `skills/status/SKILL.md`, `skills/director/references/task-card.md`.
- The Mattermost incoming-webhook documentation and the Boards maintenance notice (links at the end).

Not checked: Joe's Mattermost server (version, whether the Boards plugin is installed, whether he can create bots), and real log files. Logs are gitignored, so the record fields below come from the code that writes them, not from sample data. Nothing was run against a Mattermost server.

## What the repo already has

The data exists. Visibility is a question of where to send it.

- **One write path.** Every log line goes through `appendJsonl(input, file, record)` in `scripts/lib.js`. The Claude logger, the Codex logger, `log-event.js` and `reconcile-logs.js` all call it.
- **Files** in `<project>/.agent-team/logs/`:

  | File | Written when |
  |---|---|
  | `delegations.jsonl` | A task is handed out. `kind` is `subagent`, `resume`, `followup`, `session`, `session-setting` or `bridge`. Carries `task` (the parsed card: `id`, `type`, `difficulty`, `milestone`, `attempt`, `reason`, `pr`, `issue`), `agent`, `tier`, `effort`, and warnings such as `uncarded`, `card_drift`, `tier_mismatch` |
  | `completions.jsonl` | A subagent stops. Carries the `result-json` block, tokens, and `interrupted` when a turn was cut off |
  | `reviews.jsonl` | A reviewer reports. Carries `task_id`, `attempt`, `pr`, `milestone` and the `review-json` fields, including the verdict |
  | `merges.jsonl` | A `gh pr merge` ran. Carries `pr`, `milestone`, `outcome` |
  | `pauses.jsonl` | The Director waits. `reason` is `user`, `runway` or `usage_limit`; a `kind: "resume"` line closes it with `duration_ms` |
  | `decisions.jsonl`, `escalations.jsonl`, `notes.jsonl`, `milestones.jsonl`, `tier_fallbacks.jsonl` | Written by the Director with `log-event.js` |
  | `hook-errors.jsonl` | A hook threw |
  | `codex-events.jsonl` | Raw Codex debug log. Not a source for any of this |

- **`STATUS.md`** is the only board today, and the Director keeps it by hand. Its states are `planned`, `in progress`, `in review`, `changes requested`, `merged`, `blocked`.
- **GitHub** already holds an issue and a PR per task, and a `milestone/<slug>` branch per milestone.
- **No notification code exists.** A search for Mattermost, webhook, Slack and notify found nothing.

## Options

In the order suggested to Joe.

### 1. Mattermost activity feed (suggested first)

Post a short message to a channel for each event worth seeing: task delegated, completed, review verdict, merged.

The natural hook point is `appendJsonl`, or a thin wrapper around it, switched on by an environment variable so the plugin stays silent for everyone else.

### 2. A separate "needs you" channel

Send only the events that need Joe: `pauses.jsonl` lines with reason `user` or `usage_limit`, escalations, tier fallbacks, and hook errors. A second channel lets him keep notifications on for this one and mute the feed.

### 3. Kanban board

The `STATUS.md` states map directly to columns.

- **GitHub Projects.** Issues and PRs already exist per task, so the built-in automations move the cards. No plugin code is needed.
- **Mattermost Boards.** Keeps everything in Mattermost. The plugin is in maintenance mode and is now community-run, so confirm it works on Joe's server version before building on it.

### 4. Generated dashboard

A script that reads the logs and writes a static HTML page: a timeline per task, attempts, tokens by tier, review outcomes. It suits milestone retrospectives and the Coach better than live tracking. It would also work on archived logs.

## Correction to what Joe was told

The earlier answer suggested "one thread per task ID" using an incoming webhook. **That does not work with an incoming webhook alone.** The documented payload has no `root_id`, and the response body is the text `ok`, so the post id is never returned.

Two ways forward:

- **Flat posts through the webhook.** Start each message with the task id so the channel can be searched and filtered. Simplest; needs only a webhook URL.
- **Threads through a bot account.** Post with the REST API (`POST /api/v4/posts`), which returns the post id and accepts `root_id`. This needs a bot token, and somewhere to keep the task id to root post id map between hook runs. Hook processes are short-lived, so the map must be a file.

Joe has not been asked which he prefers.

## Constraints for whoever builds option 1 or 2

- **No dependencies.** Scripts are plain Node 18+. Node 18 has a global `fetch`.
- **A hook must never fail or slow a tool call.** Hooks have a 10 second timeout (`hooks/hooks.json`), and the loggers swallow errors into `hook-errors.jsonl`. A slow or unreachable Mattermost must not block the Director. Waiting on the HTTP call inside the hook adds its latency to every logged tool call; decide whether to wait with a short timeout or hand the post to a detached process.
- **No secrets in the repo.** The webhook URL or bot token comes from the environment or from a file under `~/.agent-team/`, the same pattern as `AGENT_TEAM_MODELS` and `AGENT_TEAM_ARCHIVE`.
- **Backfill must not repost.** `reconcile-logs.js` appends rebuilt completions and rewrites lines to add `stale_of`. A feed wired into `appendJsonl` would post those as if they were live. Either skip records with `report_source: "reconcile"` or `reconciled_by`, or have reconcile opt out.
- **Duplicates.** Codex delegations can be logged twice (a Director line and a hook fallback), and a second `SubagentStop` in a turn writes a second completion. The feed needs the same dedupe rules the Coach uses.
- **What leaves the machine.** Records hold task briefs, `WHY` text and commands. `sanitizeCommand` already strips local paths from merge commands; other fields are not sanitized. Post a few chosen fields, not whole records.
- **Codex.** The Codex CLI runs project hooks through `.codex/agent-team-hook.js`, which calls the same scripts, so a change in `lib.js` covers both tools. Changing the hook set would cost Codex users a re-trust step; changing only script internals does not.
- **Per machine.** Logs are local. A feed driven by hooks only shows activity from machines that have it configured.
- **Tests and version.** `node tests/run.js` must pass on Windows and Linux. Tests fake `gh` with `AGENT_TEAM_FAKE_GH`; a fake endpoint for Mattermost would follow that pattern. Bump `version` in both manifests if routing or agent prompts change, and add the new behaviour to the README.

## Suggested event to message mapping

A starting point, not a spec.

| Event | Source | Channel |
|---|---|---|
| Task delegated (attempt 1) | `delegations.jsonl`, `kind` `subagent`, `session` or `bridge` | feed |
| Retry, send-back or escalation | `delegations.jsonl`, `attempt` > 1, with `reason` | feed |
| Task completed | `completions.jsonl` | feed |
| Turn interrupted | `completions.jsonl` with `interrupted` | needs you |
| Review verdict | `reviews.jsonl` | feed |
| PR merged into the milestone | `merges.jsonl`, `outcome: "merged"` | feed |
| Waiting on Joe | `pauses.jsonl`, reason `user` or `usage_limit` | needs you |
| Escalation or tier fallback | `escalations.jsonl`, `tier_fallbacks.jsonl` | needs you |
| Hook error | `hook-errors.jsonl` | needs you |

## Found along the way, not fixed here

- **`STATUS.md` line 1 is damaged.** Table fragments sit in front of the `# Status` heading, which looks like a bad merge or edit.
- **`STATUS.md` is stale.** It says "Last updated: 2026-10-31" and still describes the `codex-director` milestone, while `main` is at 0.4.8 from 6 November.

Both point the same way: a task table generated from the logs would not drift, and the same output could feed a board (option 3) or the dashboard (option 4).

## Questions for Joe before starting

1. Webhook with flat posts, or a bot account with threads?
2. One channel or two (feed and "needs you")? Channel names?
3. For a board: GitHub Projects or Mattermost Boards? Is the Boards plugin installed on his server?
4. Does anyone else run the Director, or only Joe? This decides whether per-machine configuration is enough.
5. Should `STATUS.md` become generated?

## Sources

- [Mattermost incoming webhooks](https://docs.mattermost.com/developers/integrate/webhooks/incoming)
- [Boards Plugin in Maintenance Mode](https://support.mattermost.com/hc/en-us/articles/19614000831252-Boards-Plugin-in-Maintenance-Mode)
- [mattermost-community/focalboard README](https://cdn.jsdelivr.net/gh/mattermost-community/focalboard@main/README.md)
