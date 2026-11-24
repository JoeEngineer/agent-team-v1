# Merging

On GitLab, read `gitlab.md` too: an MR stands in for a PR, its target branch for the base.

## Branch model

```
main  ←── (user merges) ──  milestone/<slug>  ←── (Director merges) ──  task/<ID>
```

The guard blocks merges into `main`/`master`, force-pushes and direct pushes to them.

## Merging a task PR

All of these must be true first:

1. A `reviewer` returned a `review-json` block with `"verdict": "approve"` for this PR.
2. You have that block's `head_sha`. If the block has none, ask the reviewer for it; never substitute the PR's current head.
3. Its `ci` is `green`, `pending`, or `none` with `"tests_passed": true`. With `none` and no passing test run, send the reviewer a followup to run the tests. `red` and `unknown` never reach the command (loop step 7).
4. For a `security-sensitive` task: the `security-reviewer` also approved this same `head_sha`, and its `scan` is neither `red` (send it back) nor `unknown` (ask the user). If it approved an older head, send it the incremental diff first. Its `changes_requested` or `reject` sends the PR back and escalates like the reviewer's (loop step 7). A blocked flagged PR holds up only the tasks that need it.

Then run one call with nothing else in it:

```
node "<plugin root>/scripts/merge-task.js" <n> --sha <head_sha> --task <ID> --attempt <a>
```

- Add `--allow-none` only when the review says `ci: none` with `tests_passed: true`.
- Add `--names` on the first task PR whose CI has run ("First CI run" below).
- Same line in bash and PowerShell, GitHub and GitLab.

The script checks that the PR is open, targets `milestone/*` and is still at `head_sha`; gates on CI; merges pinned to `head_sha`; comments on the PR; and writes the merge log line. It prints one JSON result line. **Do what its `next` field says.**

| `state` | Exit | What happened |
|---|---|---|
| `merged` | 0 | Merged and commented. Set `merged` in `STATUS.md`; `git pull` in a separate call. |
| `queued` | 0 | CI was pending, so auto-merge is on, pinned to the reviewed head. Set `queued`; see "Queued PRs". |
| `waiting` | 8 | CI is pending and the PR can't be queued. Set `waiting CI` with the reason. Claude: rerun the command with `--wait 1800` as a background command. Codex: reviewer followup, then rerun. One extra wait only; still pending after it, tell the user. |
| `red` | 1 | Send it back to the implementer with the failing check names. |
| `head_moved` | 4 | Commits landed after the review. Send the reviewer the new commits only (`git diff <reviewed-sha>..<new head>`); that review's verdict, `ci` and `head_sha` then decide. |
| `unknown` | 2 | CI can't be read. Ask the user. |
| `none` | 3 | No CI found. See precondition 3; if the reviewer reported `green`, the checks are gone: ask the user. |
| `failed`, `refused` | 7, 9 | Nothing merged. Tell the user; don't work around a branch rule. |

Whether a pending PR is queued is decided live by the script's queue check, not by any note in `STATUS.md`.

## Queued PRs

**Before any push to a queued PR** (a send-back or a fold-in), cancel auto-merge: `gh pr merge <n> --disable-auto` (GitLab: the cancel row in `gitlab.md`). GitHub keeps auto-merge on when someone with write access pushes. If the merge logger then warns `auto-merge may still be on for PR <n>`, don't push yet: run the check it names (`gh pr view <n> --json autoMergeRequest` must show `null`; GitLab: `merge_when_pipeline_succeeds` false) and cancel again if needed.

**Checkpoints.** Only when `STATUS.md` has a `queued` row, run `node "<plugin root>/scripts/reconcile-logs.js" --merges`: before the next merge, at the end of a wave, and before opening the milestone PR. One call prints a line for each queued PR:

- Merged: set `merged`. If its `task/*` branch still exists, delete it (`git push origin --delete task/<ID>`).
- Still queued: nothing to do until the next checkpoint.
- Cancelled or red: cancel auto-merge if it is still on, then send it back to the implementer with the failing check names.
- Head moved: cancel auto-merge at once, then get the incremental review.
- Closed: ask the user.
- `WARNING: PR <n> merged at <X>, not the reviewed <Y>: check it`: it merged at a head nobody reviewed. Run `status.js set <ID> --state merged --note "head moved"`, tell the user which commits merged unreviewed (`git log <Y>..<X>`), and don't build on it until they decide.
- `no queued merges (…)`: remove any stale `queued` row.
- `no merges.jsonl at <path>; hooks may be off`: tell the user the hooks may be off, and check each queued PR with `gh pr view <n> --json state,autoMergeRequest`.

## First CI run (once per milestone)

On the first task PR whose CI has run, add `--names` to its merge command. It prints a `names` line: the checks the head runs, what the base requires, and whether auto-merge is allowed. Then:

1. Ask the user to require the check names on the `milestone/*` ruleset, with no bypass list, and to turn on "Allow auto-merge". On GitLab ask for "Pipelines must succeed" (Settings → Merge requests) instead; GitLab has no per-job list.
2. Record the names and the auto-merge setting in the CI block of `STATUS.md`.

If the names are already recorded, skip `--names`. Detail: the team-init skill, "CI names and auto-merge (after the first CI run)".

## Minor findings

When a reviewer approves with minor findings, decide before merging. An `approve` still means "may merge as is": folding in is a cost choice, not a new gate.

- **Fold in** a finding that has exact replacement text, or that touches only this PR's own files and needs no design choice. Missing tests for this PR's own code count too. Send it to the same implementer (`SendMessage`, warm context) with a TASK line for the same `id`, `attempt` incremented, `reason=fold-in`. Then send the reviewer the incremental diff only (`git diff <reviewed-sha>..HEAD`) and act on that review. One fold-in round per PR; a minor found later becomes a `STATUS.md` follow-up.
- **Batch** docs-wording findings into the milestone's next docs task, if there is one. A finding on a test, an anchor or a role-file rule is never batched: fold it in if it meets those conditions, else a follow-up.
- **Follow-up task** only for findings that need real work: a behaviour change, or another area of the code.

## Closing the milestone

In this order:

1. Nothing is queued: if `STATUS.md` has a `queued` row, the checkpoint shows it resolved.
2. Open the milestone → `main` PR. Its body ends with one `Closes #N` line per issue: the milestone issue and every task issue, follow-up tasks included, but not work that was dropped or moved to a later milestone. (A task PR's `Closes` does nothing: only a merge into the default branch closes an issue.) List them with `gh issue list --label agent-team --state open` and check against `STATUS.md`.
3. The final `reviewer` pass runs on that PR and waits for its CI.
4. The security review runs on the same PR, in every milestone: a separate `security-reviewer` pass, routed by `routing.md`. If the user asked for the second review at intake, start it in parallel (`routing.md`, "Local-only routes").
5. Archive the logs: `node "<plugin root>/scripts/archive-logs.js" <slug>` (the milestone slug: letters, digits, `.`, `_`, `-`). Tell the user the destination. Exit 1 means there were no logs: say so and carry on. Add `--clear` only if the user says so.
6. Check CI once: `node "<plugin root>/scripts/ci-wait.js" <milestone PR> --once`.
7. Report "complete" only on green, with no blocking security result ("Security results" below). With no CI (exit 3) and a final review of `ci: none` with `tests_passed: true`, rerun with `--sha <head_sha> --allow-none` and report complete with "no CI" stated. Otherwise report "PR open, CI <red, pending or unknown> at <sha>". On pending, Claude waits in the background (`ci-wait.js <milestone PR> --timeout 1800`) and reports again; Codex reports it as pending. Report a head only if every close reviewer (the final reviewer, the security review, and the second security review when the user asked for one at intake) approved that exact SHA, or `node "<plugin root>/scripts/status.js" --check --since <full SHA all approved> --head <PR head>` exits 0 (only `STATUS.md` changed since). The PR head is the one `ci-wait.js` reports, or `gh pr view <n> --json headRefOid`, not the local HEAD. CI on it is still required.

Minors from the close reviews go to `STATUS.md` follow-ups unless the user asks otherwise.

Then hand the PR to the user. You don't merge it.

### Security results

From each security review at close:

- A `major` or `critical` finding blocks "complete" and becomes a fix task, reviewed under the "Final-review fixes" rule in `routing.md`. One without an exploit path (input, path, consequence) goes back to its reviewer for the path or a downgrade.
- `scan: red` blocks. `scan: unknown`: ask the user, as for `ci: unknown`. `scan: none` doesn't block; the report states "no scanner".
- No `review-json` after one re-ask, or a missing bridge: ask the user. A review that didn't report never counts as passed.

## Approvals and branch rules

The reviewer's verdict lives in the logs and a PR comment, not in a GitHub approval. If the project uses a separate reviewer bot account, its `CLAUDE.md` says so.

The expected rules for `main` and `milestone/*` are in the plugin README, "Protect your branches".
