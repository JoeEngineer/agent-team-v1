# 0008: Logs are gitignored and archived at milestone close

Status: accepted

## Context
The templates and the Director skill disagreed: some said to commit
`.agent-team/logs/` to the milestone branch, others said the folder is
gitignored. The user decided which one holds.

## Decision
- `.agent-team/logs/` contents are gitignored. `team-init` adds
  `.agent-team/logs/*` and `!.agent-team/logs/.gitkeep`, so the folder stays in
  the repo and the files do not.
- The Director commits `STATUS.md` and `docs/decisions/` to the milestone
  branch, nothing from the logs.
- At milestone close the logs are archived outside the repo with
  `archive-logs.js`.

## Why
Logs hold task-card text, session ids and per-task model and token data. Many
projects are public repos, and that data does not belong in their history. The
archive keeps the history for the Coach, outside the repo.

## Alternatives
- Commit the logs to the milestone branch: leaks card text and session data into
  public history and adds noise to every PR.
- Ask per project: one more question at setup, and a wrong answer is hard to
  undo once the logs are in history.

## Consequences
- `archive-logs.js --clear` deletes every log file it verified, tracked or not.
  A project that committed logs before 0.4.0 should run
  `git rm --cached .agent-team/logs/*.jsonl` and commit that before using
  `--clear`; the files stay in git history.
- Logs are lost if the folder is deleted before archiving; archive at close.
