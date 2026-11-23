# Status

_Maintained by the Director. Last updated: <date>_

## Current milestone

**<slug>** — <goal in one sentence>
Branch: `milestone/<slug>` · Issue: #<n> · Started: <date>

## Tasks

| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |
|---|---|---|---|---|---|---|
| <SLUG>-1 | ... | implementer | medium (sonnet) / medium | 1 | in progress | |

States: `planned` · `in progress` · `in security review` · `in review` · `waiting CI` · `queued` (auto-merge on, not yet merged) · `changes requested` · `merged` · `blocked`

Tasks flagged by the breakdown carry `security-sensitive` in the Title.

## xlarge grant

Fill when the milestone starts (decision 0022).

- Granted roles: <security reviews / architect / coach (run for this milestone) / hard-fix escalation, or none>
- xlarge model and note per tool: <Claude: model, note · Codex: model, note>
- Map source: <default / user / env>
- Second security review: <no / large/high / xlarge/high / not offered>

## CI

Fill after the first CI run on the milestone (names come from the `names` line of the first `merge-task.js … --names` call).

- Required checks on `milestone/*`: <names, or none>
- Auto-merge ("Allow auto-merge"; GitLab: "Pipelines must succeed"): on / off
- If auto-merge isn't used, why: <reason>

## Blocked

- (none)

## Needs the user

- (none)

## Recent decisions

- (none) — see `docs/decisions/`
