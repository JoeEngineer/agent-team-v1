---
id: 0022
title: A security review at every milestone close, and a per-milestone xlarge grant
date: 2026-11-22
status: accepted            # the user accepted it on 2026-11-22; not yet implemented
milestone: none
task: none
decided_by: user            # drafted in a single Claude session, not a Director run
model: claude-fable-5-2
effort: unknown
---

# 0022: A security review at every milestone close, and a per-milestone xlarge grant

## Context

The review workflow has no security step. `security` is one of the reviewer's
finding categories and part of the definition of `critical`, but no step tells
the reviewer to look for security problems, and nothing in the agents, skills or
templates mentions a scanner (Trivy, secret scanning, dependency audit). The
milestone final review is a general `reviewer` pass at large/high.

The user wants a security review by an advanced model (Fable or Astra) to be
part of every milestone. Those models are the xlarge tier. Today xlarge is
disabled in the shipped map, is never chosen by the table or the ladder, and can
be offered only when the ladder runs out at large/high, with the user's yes for
each task (decision 0001). The user now has plans that include limited use of
both models, and wants to decide per milestone where that use is spent.

## Decision

### 1. A `security-reviewer` agent

A new agent, `agents/security-reviewer.md`, separate from `reviewer`. Read-only
tools, like the reviewer. One tool-neutral prompt for Claude and Codex. It
carries:

- **Method.** List the trust boundaries the diff touches, then trace each
  untrusted input to where it is used.
- **Categories.** The OWASP Top 10 by name, plus what it leaves out: CI config
  (unpinned actions, token permissions, `pull_request_target`), containers
  (root user, secrets in layers, base image), supply chain (new or unpinned
  dependencies, install scripts), and secrets in code, logs, errors and
  fixtures.
- **Evidence rule.** A `major` or `critical` finding names a concrete exploit
  path: the input, the path through the code, and the consequence. A concern it
  could not confirm is `minor`, with what would confirm it.
- **Coverage.** It reports what it checked and what it did not.
- **Scan status.** It confirms that the project's scanner checks exist and
  passed on the reviewed SHA, and reports `scan` as `green`, `red`, `none` or
  `unknown`. It does not run the scanners itself.
- **Project lessons.** A short list that grows from the Coach's reports. First
  entry: redaction checked on the raw string but not on the serialized form.

It ends with the same `review-json` block as the reviewer, plus `scan` and
`coverage`, under task type `security-review`, so the logs and the Coach can
count it apart from general reviews.

### 2. Where security is checked

| Level | What | Who |
|---|---|---|
| Task PR | Scanners in the project's CI | CI. The existing CI gate covers it |
| Task PR | A four-line security checklist added to "How to review" | `reviewer`, medium/high, unchanged |
| Task PR, flagged | Security review of that PR, after the general review approves | `security-reviewer`, per the table in 4 |
| Milestone close | Security review of the milestone branch against `main` | `security-reviewer`, per the table in 4 |
| Milestone close, optional | A second, independent security review by another model family | Codex bridge, see 5 |

- A task is flagged when the architect's breakdown marks it
  `security-sensitive` (auth, secrets, input parsing, containers, CI config).
- The milestone-close review is mandatory for every milestone. It is a new step
  in "Closing the milestone", next to the final `reviewer` pass, not part of it.
- The plugin does not supply the scanners. `team-init` offers a CI job template
  (Trivy for images, config and dependencies; a secret scan) that the project
  may adopt.

### 3. What blocks

- A `major` or `critical` security finding blocks. At task level the PR goes
  back like any `changes_requested`. At milestone close the Director does not
  report "complete": the finding becomes a fix task with a normal per-PR
  review, and the security reviewer is resumed only to confirm its own finding
  on the incremental diff (the rule of decision 0018).
- `scan: red` blocks. `scan: unknown` is handled like `ci: unknown`: the
  Director asks the user.
- `scan: none` does not block. The Director states "no scanner" in its
  completion report, as it states "no CI" today.

### 4. The xlarge grant

**The shipped map makes no claim about any plan.** The plugin cannot detect a
plan, and what is included, limited or billed as credits differs between
plans. So in `config/models.json` the xlarge tier loses `enabled: false`, and
the `billing: "credits"` field on its entries becomes a neutral `note`
("included, limited, or billed as credits, depending on your plan"). xlarge
is still never auto-eligible: the table and the ladder never choose it.

**The user is asked on every milestone.** At the start of intake, before any
delegation (the breakdown included), the Director asks one multi-select
question whenever the effective map has an xlarge model for the current tool:

> Use xlarge in this milestone for: security reviews (at close and on flagged
> task PRs), architect, coach at close, hard-fix escalation?

The question shows the xlarge model for each tool, its `note`, and where the
map came from (the shipped default or the user's file), so every milestone
start is also a check that the mapping is current. Choosing nothing is a valid
answer: every role then runs its default row. A user who never wants the
question sets `enabled: false` on xlarge in `~/.agent-team/models.json`.

The Director
records the answer in `STATUS.md` as the milestone's xlarge grant and logs it.
The grant replaces the per-task yes for the granted roles in that milestone
only. Anything outside it still needs the user's yes for that task.

**Tier and effort are fixed per role**, as for every other routing row:

| Role | Default | With the grant |
|---|---|---|
| security review (milestone close) | large / high | xlarge / high |
| security review (flagged task PR) | large / high | xlarge / high |
| architect (breakdown, design) | large / high | xlarge / medium |
| coach (at milestone close) | large / high | xlarge / medium |
| hard-fix escalation, after large/high fails | ask the user | xlarge / high |

These go into `references/routing.md` as rows, so the Coach can propose changes
to them like any other row.

**Runway.** Before each granted xlarge spawn the Director checks runway. If it
is short, it asks the user whether to wait or to run the default row. It does
not fall back silently, and it logs a `tier_fallback` event when the user
chooses the default row.

**Outside a milestone.** A standalone Coach run has no intake, so it asks when
invoked.

### 5. A second security review by another model family

When the Director runs on Claude and the Codex bridge tools are present, intake
asks a second question:

> Run a second, independent security review at milestone close through the
> Codex bridge? No / large/high / xlarge/high

The xlarge option appears only if the map has an xlarge Codex model that is
not disabled. The answer is recorded in `STATUS.md` with the grant.

- **Independent.** The second reviewer gets the same card as the first (the
  milestone PR, the acceptance criteria, the `security-reviewer` prompt) and
  none of the first review's findings or verdict. The two run in parallel.
- **Adversarial.** Its card says another model has already reviewed this
  milestone and that its job is to find what that review missed.
- **Both count.** A blocking finding from either review blocks under the rules
  in 3. The evidence rule applies to both, so a finding only one of them raises
  still needs its exploit path.
- **Routing.** This is the first row in the local-routes table of
  `references/routing.md`. It is logged with a task card like any delegation,
  with the tool and model, so the Coach can compare the two families.
- **Runway.** The Director calls the bridge's `check_runway` first. If runway
  is short, or the bridge is missing at close, it asks the user whether to
  wait, drop the tier, or skip the second review. It does not skip silently.

## Consequences

- Every milestone gets a security review even when the user grants nothing: it
  then runs at large/high.
- A milestone close has three gates: the final review, the security review, and
  CI. The second security review, when the user asked for it, is a fourth.
- This amends decision 0001 ("when the ladder runs out at large, the Director
  asks the user": still true without a grant) and the Director's authorization
  line ("the opt-in xlarge tier needs the user's yes for each task").
- Files that change: a new `agents/security-reviewer.md`; `agents/reviewer.md`
  (checklist); `agents/architect.md` (the `security-sensitive` flag);
  `skills/director/SKILL.md`, `references/routing.md`, `references/merging.md`,
  `references/task-card.md`; `skills/milestone/SKILL.md` (the intake question);
  `skills/team-init` and a CI template; the `STATUS.md` template;
  `config/models.json`, `scripts/models.js` and `scripts/codex-agents.js` (the
  `note` field and the xlarge default); the README's
  "Models and tiers"; the logger and the Coach, if they need to know the new
  task type and fields; and the plugin version, because routing changes.
- On Codex, `codex-agents.js` writes `security-reviewer-<tier>.toml` files. It
  now writes the xlarge files unless the map disables xlarge, because a grant
  needs them to exist. That amends decision 0005, which wrote them only on
  `enabled: true`.
- The escalation ladder's offer of xlarge no longer depends on an `enabled`
  flag: without a grant the Director may offer it whenever the map has an
  xlarge model that is not disabled, and still needs the user's yes.
- A user on a plan without these models answers "none" once per milestone, or
  disables xlarge in their own map to stop the question.
- xlarge use becomes visible in the logs per role, so the Coach can compare
  large and xlarge security reviews and say whether the grant is worth it.
- Intake gains one question on every milestone, and a second when the Codex
  bridge is present.

## Alternatives

- **Fold security into the existing `reviewer`:** no new agent, but a longer
  reviewer prompt for every PR, shallower security coverage, and no separate
  log line for the Coach.
- **Security review at milestone close only:** cheapest, but a problem in an
  auth or CI task is found after everything else was built on it.
- **Dedicated security review on every task PR:** most coverage, at a cost per
  PR that most tasks (docs, tests) do not justify.
- **A per-machine switch that turns the question on:** a user on a plan without
  these models is never asked, but a user who has them must find and run a
  command first, and nothing reminds anyone that their map may be out of date.
- **A standing xlarge exception for the security review:** no question at
  intake, but the user loses control of plan limits.
- **Keep the per-task yes:** no change to 0001, but the security review runs at
  the end of a milestone, when a prompt is easy to miss and the user may be
  away.
- **Leave effort to the Director when granted:** flexible, but every other row
  fixes effort, and the Coach cannot compare runs whose effort varies.

## Open points

1. **Effort values** in the table in 4 are starting values the user accepted,
   not measured ones. The Coach reviews them after the first milestones.
