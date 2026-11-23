---
id: 0024
title: Scan states as one ordered table
date: 2026-11-23
status: accepted            # design only; FU-9 applies the text and the tests
milestone: coach-followups
task: FU-2
decided_by: architect
model: fable
effort: medium
---

# 0024: Scan states as one ordered table

Replaces the `scan` state prose in `agents/security-reviewer.md`, "Scan status".
Refines decision 0022, section 2 ("Scan status"). The four values and the
Director's handling of them do not change.

## Context

The paragraph that says which of `green`, `red`, `none` and `unknown` applies
drew 9 findings in 6 reviews in milestone `security-review`, and 5 of 5 reviews
of a fix to that file found something new (Coach report
`docs/coach/2026-11-23-security-review.md`, finding 7, proposal A3). Each patch
added a clause, and the clauses overlap: the reader has to work out which one
wins. Four gaps were open in its fourth version:

1. The `green` clause ("every scanner check passed and scanned") contradicts the
   nothing-to-scan exception ("does not change `scan` by itself").
2. Nothing says what `scan` is when every job had nothing to scan.
3. "The head moved" gives `unknown` even when a scanner check failed on the
   reviewed head, and `gh pr checks` cannot show that head any more.
4. The exception trusts the job's own notice, which the reviewed diff can write.

The safety rule the section must never break: **a scan that did not run never
reads as `green`, and `red` always blocks.**

## Options

1. **One ordered table, first matching row wins** (A3). Overlap is settled by
   row order, not by wording. The last row is `unknown`, so a combination nobody
   listed cannot fall through to `green`.
2. **Patch the prose a fifth time.** Four more clauses in a paragraph that has
   produced a new finding on every patch.
3. **A script** (`scan-state.js`) that reads the checks and prints the value, as
   decision 0020's script-first rule prefers. Two of the inputs are the
   reviewer's judgement (did a passed job scan; is there anything of that kind in
   the tree), so the script could only do part of it, and it would need its own
   forge code for GitHub and GitLab.

## Decision

Option 1. Option 3 is not rejected, only not done here: if the table still draws
findings after one milestone, move the mechanical rows into a script.

Choices made inside the table:

- **Always read the checks of `head_sha` itself**, not of the PR. One command
  covers "head moved" and "head did not move", so there is no second code path
  for the old head.
- **`red` is row 1.** A failed scanner check on the reviewed head is a fact about
  the reviewed code. A later push, a skipped job or an unreadable page does not
  remove it.
- **"Head moved" comes before "no scanner jobs".** The new head may have added
  or removed scanner jobs, so nothing but `red` can be said about it.
- **"Unscanned" is one idea**: a job that was skipped, is missing, or passed
  without scanning. All three are handled the same way.
- **"With cause" is the reviewer's own check of the tree at `head_sha`**: nothing
  of the job's kind exists. The job's notice, log line or `if` is not evidence.
- **Every job unscanned with cause is `none`**, not `green` and not `unknown`.
  Nothing was scanned, so it is not `green`. `unknown` would ask the user at
  every close of, for example, a project whose only scanner job is an image scan
  and which has no image. That is the nagging the exception was written to stop
  (finding 7, item 3). `none` makes the Director report "no scanner", which is
  true, and `not_checked` says why.
- **The last row is `unknown`.** A cancelled or neutral job, or any state not
  named, lands there.

### What `skipped` means for a job with a job-level `if`

A job whose job-level `if` is false does not run. GitHub reports it as a check
run with conclusion `skipped`, and branch protection counts a skipped required
check as passing. Here it is **unscanned**, like any other skipped job:

- If the reviewer sees in the tree at `head_sha` that nothing of its kind exists
  (for `trivy-image`: no `Dockerfile` anywhere), it is unscanned with cause. It
  is listed under `not_checked` and the other jobs decide `scan`.
- Otherwise `scan` is `unknown`.

The `if` expression itself is never the cause. FU-10 will make `trivy-image`
skip when there is no root `Dockerfile`. A project with a `Dockerfile` only in a
subdirectory then gets `unknown` at every review until the job is pointed at it.
That is intended: an image exists and nothing scans it.

## The replacement text

This is the whole "Scan status" section, from the `## Scan status` line to the
blank line before `## Coverage`. The intro and steps 1 and 2 are unchanged.
Step 5 and everything after it is new. **Steps 3 and 4 also change**, which is
more than the task card's "from step 5 on": gap 3 cannot be closed without them.
Step 3 loses "`scan` is `unknown`" (the table says it), and step 4 reads by SHA.

**Size: 1,997 bytes**, measured with `wc -c` on the text below with LF line
endings, including the one blank line that ends the section. The current section
is 1,656 bytes measured the same way. The limit is 1,850: the Director raised it
from 1,750 for the review fold-in, which added the definitions of passed,
pending, missing and "the rest", the unconfirmed-scan rule, and the GitLab and
step 3 clarifications. One byte is free, so any further wording needs a cut.

```markdown
## Scan status
Scanner checks (dependency, image, config and secret scans) run in the project's CI. You never run a scanner yourself.
1. Find the scanner jobs in the project's CI config (`.github/workflows/`, `.gitlab-ci.yml`).
2. Wait for CI as the task card's CI wait line says, after your review work. Report `ci` from that wait. With a blocking finding, don't wait: make one `--once` check and start `summary` with `not waited: changes requested` (`not waited: rejected` for `reject`).
3. Confirm the PR head is still `head_sha`. If it moved, review the new commits (the new head is then `head_sha`) or say so.
4. Read `head_sha`'s own checks once (`gh pr checks` shows only the current head): `gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs" --paginate`, or on GitLab `glab api --paginate "projects/:id/pipelines/<id>/jobs"` with each id from `glab api "projects/:id/pipelines?sha=<head_sha>"`.
5. Report `scan` from the first row that matches:

| Scanner jobs, on `head_sha` | `scan` |
|---|---|
| Any failed, even with a moved head or others skipped or unreadable | `red` |
| The head moved | `unknown` |
| The diff removes or disables a scanner job the base has (deletion, an `if:` that never runs, or a dropped trigger) | `unknown` |
| Base and head both have no scanner jobs | `none` |
| Checks unreadable, or any still pending after the wait | `unknown` |
| Any unscanned without cause | `unknown` |
| All unscanned with cause | `none` |
| All the rest passed | `green` |
| Anything else | `unknown` |

**Failed**: `failure` or `timed_out` (GitLab `failed`). **Passed**: `success`. **Pending**: not finished. **Unscanned**: skipped (a job-level `if` too), missing (in the config, no check), or passed without a scan you can confirm. **With cause**: you saw in the tree at `head_sha` that nothing of its kind exists (an image job: no `Dockerfile` anywhere); never trust the job's notice. **The rest**: jobs not unscanned with cause. List unscanned jobs under `not_checked`.

```

Notes on the definitions (all of them are in the fenced text; this only
explains them):

- **Passed** is `success` only. `neutral`, `cancelled`, `action_required` and
  any other state are neither passed nor failed, so they reach row 8.
- **Missing** covers a workflow that was not triggered and a GitLab job its
  `rules:` left out.
- **Passed without a scan you can confirm** covers both a job that is known not
  to have scanned and one whose scan step the reviewer cannot confirm ran (a
  conditional step and no readable log). Both are unscanned.
- **The rest** is never empty at row 8, because row 7 comes first.
- **GitLab, "each id"**: one commit can have a branch pipeline and a
  merge-request pipeline. The jobs of every pipeline for the SHA count, so a
  failure in any of them is `red`, and `green` needs all of them passed.
- **Step 3**: once the reviewer has reviewed the new commits, the new head is
  `head_sha`, step 4 reads that head, and "the head moved" no longer applies.

## Rows and the cases they cover

| Row | Condition | `scan` | Cases from the task card |
|---|---|---|---|
| 1 | Any failed | `red` | any failed; head moved with an old-head failed check |
| 2 | The head moved | `unknown` | head moved without a failed check |
| 3 | The diff removes or disables a scanner job the base has | `unknown` | a scanner job deleted, an `if:` that never runs, or a dropped trigger |
| 4 | Base and head both have no scanner jobs | `none` | no scanner jobs at base or head |
| 5 | Unreadable, or pending after the wait | `unknown` | unreadable; pending after the wait |
| 6 | Any unscanned without cause | `unknown` | any skipped; passed but did not scan |
| 7 | All unscanned with cause | `none` | all jobs nothing to scan |
| 8 | All the rest passed | `green` | nothing to scan (some jobs), the others passed |
| 9 | Anything else | `unknown` | cancelled, neutral, any state not named |

## The four open gaps

| Gap | Row | Reason |
|---|---|---|
| 1. `green` clause against the nothing-to-scan exception | 8 | `green` is defined over "the rest", the jobs left after those unscanned with cause, so the two rules can no longer disagree. |
| 2. All jobs nothing to scan | 7 | Nothing was scanned, so it is not `green`; it is `none`, and the report says "no scanner" instead of asking the user at every close. |
| 3. Head moved against an old-head failed check | 1, before 2 | A failure on the reviewed head stays `red` after a push. Step 4 reads `head_sha` itself, because `gh pr checks` shows only the current head. |
| 4. The exception trusted the job's own notice | 6 and 7, "with cause" | The diff can write the notice. The reviewer checks the tree at `head_sha` instead. |

Commands for gap 3 (both read by SHA, so they work whether or not the head
moved):

- GitHub: `gh api "repos/{owner}/{repo}/commits/<head_sha>/check-runs" --paginate`.
  `gh` fills in `{owner}` and `{repo}`. Useful fields: `name`, `status`,
  `conclusion`. For a short listing add
  `--jq '.check_runs[]|[.name,.status,.conclusion]|@tsv'`.
- GitLab: `glab api "projects/:id/pipelines?sha=<head_sha>"` gives the pipelines
  of that commit (there can be a branch pipeline and a merge-request pipeline);
  then `glab api --paginate "projects/:id/pipelines/<id>/jobs"` for each of
  them. There is no single GitLab command.

## Worked matrix

FU-9 turns this into tests. Columns are fixed:

- `head`: `same` or `moved` (the PR head against `head_sha`).
- `jobs`: `some` or `none` (scanner jobs in the CI config).
- `readable`: `yes` or `no` (the read in step 4 worked).
- `states`: the scanner jobs' states on `head_sha`, comma-separated, or `-` for
  none read. Each is one of `pass`, `fail`, `pending`, `cancelled`, `neutral`,
  `skip`, `missing`, `noscan` (passed, known not to have scanned),
  `unconfirmed` (passed, and the reviewer cannot confirm the scan step ran).
  `skip`, `missing`, `noscan` and `unconfirmed` are the unscanned states and may
  carry `+cause`: the reviewer confirmed in the tree that nothing of that kind
  exists.
- `scan`: the expected value. `row`: the table row that decides it.

| id | head | jobs | readable | removed | states | scan | row |
|---|---|---|---|---|---|---|---|
| M01 | same | some | yes | no | pass,pass | green | 8 |
| M02 | same | some | yes | no | pass,fail | red | 1 |
| M03 | same | some | yes | no | fail,skip | red | 1 |
| M04 | same | some | no | no | fail | red | 1 |
| M05 | moved | some | yes | no | fail,pass | red | 1 |
| M06 | moved | some | yes | no | pass,pass | unknown | 2 |
| M07 | moved | none | yes | no | - | unknown | 2 |
| M08 | same | none | yes | no | - | none | 4 |
| M09 | same | some | no | no | - | unknown | 5 |
| M10 | same | some | yes | no | pass,pending | unknown | 5 |
| M11 | same | some | yes | no | fail,pending | red | 1 |
| M12 | same | some | yes | no | pass,skip | unknown | 6 |
| M13 | same | some | yes | no | pass,noscan | unknown | 6 |
| M14 | same | some | yes | no | pass,missing | unknown | 6 |
| M15 | same | some | yes | no | pass,noscan+cause | green | 8 |
| M16 | same | some | yes | no | pass,skip+cause | green | 8 |
| M17 | same | some | yes | no | skip+cause | none | 7 |
| M18 | same | some | yes | no | noscan+cause,skip+cause | none | 7 |
| M19 | same | some | yes | no | skip+cause,skip | unknown | 6 |
| M20 | same | some | yes | no | pass,cancelled | unknown | 9 |
| M21 | same | some | yes | no | cancelled,noscan+cause | unknown | 9 |
| M22 | same | some | yes | no | pending,skip | unknown | 5 |
| M23 | moved | some | no | no | - | unknown | 2 |
| M24 | same | some | yes | no | fail,noscan+cause | red | 1 |
| M25 | same | some | yes | no | pass,neutral | unknown | 9 |
| M26 | same | some | yes | no | neutral,skip+cause | unknown | 9 |
| M27 | same | some | yes | no | pass,unconfirmed | unknown | 6 |
| M28 | same | some | yes | no | pass,unconfirmed+cause | green | 8 |
| M29 | same | some | yes | no | unconfirmed | unknown | 6 |
| M30 | same | some | yes | no | fail,neutral | red | 1 |
| M31 | same | none | yes | yes | - | unknown | 3 |

M13 is the notice case: the job printed "nothing to scan" and the reviewer did
not confirm it. M16 is FU-10's `trivy-image` with no `Dockerfile` in the tree.
M25 and M26 show that `neutral` is not passed. M27 and M29 are a passed job
whose scan step cannot be confirmed.

Reference evaluator. The matrix above was run through it: 31 rows, 0
mismatches, all 9 rows hit.

```js
const UNSCANNED = ['skip', 'missing', 'noscan', 'unconfirmed'];
function scanState({ head, jobs, readable, removed, states }) {
  const s = states === '-' ? [] : states.split(',');
  const cause = (x) => x.endsWith('+cause');
  const unscanned = (x) => UNSCANNED.includes(x.replace('+cause', ''));
  if (s.includes('fail')) return ['red', 1];
  if (head === 'moved') return ['unknown', 2];
  if (removed === 'yes') return ['unknown', 3];
  if (jobs === 'none') return ['none', 4];
  if (readable === 'no' || s.includes('pending')) return ['unknown', 5];
  if (s.some((x) => unscanned(x) && !cause(x))) return ['unknown', 6];
  if (s.length > 0 && s.every((x) => unscanned(x) && cause(x))) return ['none', 7];
  const rest = s.filter((x) => !(unscanned(x) && cause(x)));
  if (rest.length > 0 && rest.every((x) => x === 'pass')) return ['green', 8];
  return ['unknown', 9];
}
```

## Assumptions behind the safety rule

Rule: a scan that did not run never reads as `green`, and `red` always blocks.
"Tested" means run on 2026-11-23 against this repository's GitHub checks. Every
untested assumption falls back to `unknown`.

| # | Assumption | Status | If it does not hold |
|---|---|---|---|
| 1 | The check-runs call for a SHA returns that commit's runs after the PR head has moved on | tested (PR #125, old head `64663ac`, 4 runs returned) | Read fails or is empty: row 4 or 5, `unknown` |
| 2 | A failed job shows `conclusion: failure` in that call | tested (commit `dc1f686`) | An unnamed state: row 8, `unknown` |
| 3 | A cancelled job shows `cancelled`, not `failure` or `success` | tested (commit `d6534bc`) | Row 8, `unknown` |
| 4 | A job skipped by a job-level `if` shows as a check run with `conclusion: skipped` | untested (GitHub docs; this repository has no skipped run) | If it does not show at all it is "missing", the same row: `unknown` without cause |
| 5 | A workflow that was not triggered leaves no check run, and the reviewer notices by comparing with the jobs from step 1 | untested | "Missing": row 5, `unknown` |
| 6 | The reviewer can tell that a passed job did not scan (a conditional scan step in the CI config, or the job log) | untested | In the section text: a pass without a scan the reviewer can confirm is unscanned. Row 5, `unknown` (M27) |
| 7 | Scanner jobs report as check runs. A scanner that reports through the commit status API is not in the call | untested | It reads as "missing": row 5, `unknown` |
| 8 | `--paginate` returns every run when there are more than 30 | untested (the largest set read had 4) | A job not in the output is "missing": row 5, `unknown`. A failed job on an unread page is the one case that could hide a `red`; it still cannot give `green` |
| 9 | The call returns the latest attempt of a re-run job | untested (GitHub docs: `filter=latest` is the default) | A re-run that passed is a real pass. A stale failure would give `red`, the safe side |
| 10 | GitLab: `pipelines?sha=` lists every pipeline of the commit (branch and merge-request), and a job left out by `rules:` is absent from the job list | untested (no `glab` here; live GitLab is out of this milestone's scope) | Command fails: row 4. Job absent: row 5. Both `unknown` |
| 11 | The reviewer applies the rows in order | untested (FU-9's anchors pin the text, not the behaviour) | `unknown`: a case that matches no row is row 8, and `green` is given only by a positive match on row 7 |
| 12 | The tree the reviewer checks for "with cause" is the tree at `head_sha` | tested (matrix rows M06 and M23 through the evaluator: with a moved head, row 2 gives `unknown` before rows 5 to 7 are reached) | `unknown` |
| 13 | The Director blocks on `red` | untested here (it is `merging.md`, "Security results", pinned by anchors M-45 and M-46, and outside this section) | `unknown` is the fallback inside this section; nothing in this section can make the Director block |

### Gaps

- **Assumption 6: a pass that did not scan.** The section now says that a pass
  without a scan the reviewer can confirm is unscanned, so the unsure case is
  `unknown`. It does not say how to confirm; that is reading the job's steps and
  log. After FU-10 the template has no step-level condition left, which removes
  the known instance.
- **A scanner that runs and is configured not to fail** (for example Trivy with
  `exit-code: '0'` already on the base branch). The scan ran, so the rule holds
  as written, but `green` then says less than it seems to. The table does not
  cover it. A change to that setting in the diff is already a finding under
  "Scanner config".
- **Two checks with one name** (the same commit built by `push` and by
  `pull_request`). Every one counts as a job: any failed is `red`, and `green`
  needs all of them passed.

### Cost of the read

Step 4 is one call on GitHub (one more request per 30 check runs). On GitLab it
is one call to list the pipelines plus one per pipeline of the SHA, usually one
or two. Both are made once per reviewed head. A moved head that the reviewer goes on to review
is a new `head_sha` and one more read. There is no retry and no polling in this
section; waiting belongs to step 2.

## Consequences

- `scan` stays `green | red | none | unknown`. `merging.md`, "Security results",
  is unchanged: `red` blocks, `unknown` asks the user, `none` does not block and
  the report states "no scanner".
- `none` now has a second source (row 6). The Director's "no scanner" is still
  accurate: no scanner scanned anything. `not_checked` carries the reason.
- A moved head with a failed scanner check on the reviewed head now reports
  `red`, where it reported `unknown`. The user is no longer asked about a result
  that is already known to block.
- A scanner job that is in the config and never ran on `head_sha` ("missing") is
  now `unknown`. Under the old text it was undefined and could read as `green`.
- The section grows 193 bytes (1,656 to 1,849). The Director confirmed that
  `agents/security-reviewer.md` still fits under decision 0025's 8,100 with
  FU-9's other additions.
- **For FU-9.** Apply the fenced text byte for byte. These anchors in
  `tests/guidance-rules.js` pin text that is gone and need new patterns: SV-07,
  SV-08, SV-13, SV-14, SV-15, SV-16, SV-21, SV-22, SV-23. SV-05, SV-06, SV-09 and
  SV-12 still match. Pin each table row on its own line, condition and value
  together (for example `/\| The head moved \| `unknown` \|/`), and check that
  each anchor fails when its row is deleted. Also pin that the `red` row comes
  before the "head moved" row, and that "Anything else" is the last row. The
  matrix and the evaluator above are the behaviour tests.
- **For FU-10.** A job-level `if` on `trivy-image` is safe under this table: the
  skipped job is never `green` by itself. No notice step is needed for the
  reviewer's sake.

## Amendment (FU-20, 2026-11-23)

Amended by FU-20. The Director asked for the row after this record was
accepted. A diff that removes or disables the scanner jobs (deletes the
workflow or a job, gives a job an `if:` that never runs, or drops the trigger
for this event) reads `unknown`, so the Director asks the user, not `none`.
The row sits before the `none` row, so it matches first. `none` now means
the base and the head CI configs both have no scanner jobs.

Changes: the new row 3 (and rows 4 to 9, renumbered, with the gap and matrix
references); the "The CI config has none" label is now "Base and head both have
no scanner jobs"; the matrix has a `removed` column and case M31; the evaluator
takes `removed`. The section grows from 1,849 to 1,997 bytes, so the limit for
this section is now 2,000 bytes (agents/security-reviewer.md's budget is 8,090).

## Not doing

- No script for the scan state (option 3).
- No new `scan` value, and no change to `ci`.
- No change to `merging.md`, to the scanner template, or to any test.
- No rule for scanners configured not to fail (see Gaps).
- No live GitLab run.
