---
id: 0029
title: Two security-review grant words, and the grant-check residuals the user rejected
date: 2026-11-23
status: accepted            # designs what decision 0028 (the user's) asked for
milestone: coach-followups
task: FU-22
decided_by: architect
model: claude-fable-5-2
effort: medium
---

# 0029: Two security-review grant words, and the rejected grant-check residuals

Carries out decision 0028. Amends decision 0026.

## Context

Decision 0028 (the user's) asked for two things.

1. Two grant words for security reviews. The grant had one `security reviews`
   role covering two rows of the grant table: the milestone-close review and the
   review of a flagged task PR. A note in parentheses could not narrow it,
   because `status.js grant` strips notes.
2. Fixes for the residuals decision 0026 had accepted:
   - a. a slug line appended to the log ahead of the Director's intake line;
   - b. a hand-made first line torn before the slug ends;
   - c. an agent that rewrites `milestones.jsonl` or the shared `.git`;
   - d. `GIT_DIR`, `GIT_WORK_TREE` or `CLAUDE_PROJECT_DIR` moving the log that
     `grant` reads.

Four minor findings from the reviews of FU-16 ride along.

## Options

**The words.**

1. **Two words that each name a set of rows** (chosen): one for the close row,
   one for both rows.
2. One word per row, "close security review" and "task PR security reviews".
   The user could then grant task PRs without the close review. Decision 0028
   did not ask for that, and the close review is the one that matters most.
3. Keep one word and read a qualifier in parentheses. The parser strips
   parentheses on purpose, so that a note cannot grant or narrow anything.
   Reading some parentheses and not others would undo that.

**The log names.**

1. **One log name per row** (chosen): `security-review-close` and
   `security-review-task`. "All" is both names. The narrower-wins rule of
   decision 0026 is then plain set intersection, with no special case.
2. One log name per word (`security-review-close`, `security-review-all`).
   The check would need to know that `all` contains `close`.

**Residual b, the torn line.**

1. **Refuse any line that is not a JSON object, before the slug's first line**
   (chosen).
2. Work out whether a torn line could have gone on to name the slug. Every torn
   line could: `{"milestone":"zz","xl` can continue with a second `milestone`
   key. So this is option 1 with more code.

**Residual d, `CLAUDE_PROJECT_DIR`.**

1. **It may agree with the cwd's project; it may not move the check** (chosen).
2. Ignore it. A session whose cwd and `CLAUDE_PROJECT_DIR` name different
   projects would then get a quiet "no line" answer with no reason given.
3. Follow it, as before. Then the environment picks the log.

## Decision

### 1. The two words

| Intake word | Grants (log names) | Row of the grant table in `routing.md` |
|---|---|---|
| `close security review` | `security-review-close` | security review (milestone close) |
| `all security reviews` | `security-review-close`, `security-review-task` | both security rows |

- Neither word has parentheses. The intake question adds a note to the second,
  "all security reviews (close and flagged task PRs)", and the parser drops it.
- Both words together mean the same as `all security reviews`.
- `status.js grant` prints the log names. It never prints `security-review`.
- No word grants flagged task PRs without the close review. A log line with
  `security-review-task` and no `security-review-close` is not an intake answer:
  exit 19.

**Back-compat.** The older word and the older log name keep their old meaning,
both rows:

- `security reviews` in a `STATUS.md` block reads as `all security reviews`;
- `security-review` in a log line reads as both log names.

So a project started on 1.1.0 keeps the grant it had, printed under the new
names. The template and the intake question no longer offer the older word.
This repository's own grant for coach-followups is such a block. Its note about
task PRs was never enforced and still is not; the Director follows it by hand
until the milestone closes.

### 2. The residuals

**a. A slug line appended ahead of the Director: fixed in the logger.**
`log-event.js milestone` refuses a second line for a slug.

- It reads `milestones.jsonl` with the same reader `grant` uses, under the
  logger's lock, so "is there a line for this slug" has one answer in both
  places.
- A line already there with a different grant: nothing is written, the existing
  line is printed, and the exit code is non-zero. The intake guidance tells the
  Director to write no grant, show the user that line, and ask.
- A line already there with the same roles and the same second review: nothing
  is written and the exit is 0. This is the lost-response case (the line was
  appended and the reply did not arrive) and a resumed session logging intake
  again.
- It also refuses, before writing, a line `grant` would not accept: an unknown
  role, the older `security-review`, `security-review-task` without
  `security-review-close`, a `second_review` outside `none`/`large`/`xlarge`,
  or an empty slug. Without this, one typo would become the first line and lock
  the milestone at exit 19, because the correcting line would be refused.
- Decision 0026 item 1 stands: `grant` still reads the first line and ignores
  later ones. What changes is that the logger no longer writes later ones.

**b. A torn first line: fixed in `grant`.** A line that is not a JSON object,
and that comes before the slug's first line, exits 19 whatever it mentions. The
message gives the line number and says to ask the user to repair or remove it.
Blank lines are skipped. A bad line after the slug's first line is never read.

The cost: one damaged line in `milestones.jsonl` stops every later milestone's
grant until the user repairs it. That is the fail-closed side, and the file has
one line per milestone.

**c. Rewriting `milestones.jsonl` or the shared `.git`: not fixable from inside
the plugin.** Stated plainly:

- `milestones.jsonl` is an ignored, plain file in the checkout. Any agent with
  write access to the checkout can replace its first line for a slug.
- `.git` is shared by every worktree. An agent can edit `.git/config` (for
  example `core.worktree`, which moves the folder `grant` treats as the project)
  or replace an object file that `--check --since` reads.
- The plugin has no secret an agent cannot read and no place an agent cannot
  write, so it cannot sign or lock either. A hash kept beside the log would be
  rewritten with it.
- What does stop it is outside the plugin: a sandbox or file permissions that
  keep agents out of `.agent-team/logs/` and `.git`, or running the check from a
  checkout agents cannot write. The user can also compare the grant shown at
  intake with the `WHY` line of each xlarge spawn.

The README says this under "Limits and known gaps", and decision 0026 now says
it in its residuals.

**d. The environment moving the log: fixed.**

- `grant` finds the project from its cwd: `git rev-parse --show-toplevel` with
  every `GIT_*` variable removed (the filter `--check --since` uses), then the
  main checkout when that is a linked worktree. Outside a repository it is the
  cwd itself.
- `CLAUDE_PROJECT_DIR`, when set, is resolved the same way. If it is another
  project, `grant` exits **22**, grants nothing and prints both paths.
- `lib.projectDir` gets the same `GIT_*` filter, so the logger and `grant` look
  for the repository the same way. It still returns `CLAUDE_PROJECT_DIR` first:
  hooks need that, since Claude sets it and a hook's cwd can be anywhere.
- `log-event.js milestone` applies the same agreement rule before it writes, so
  the intake line cannot land in a project other than the one `grant` reads.

### 3. The minor findings from FU-16

- **`set` no longer rolls back.** The one-line-differs check now runs before the
  write, on the text about to be written. After the write, a read-back that is
  not that text exits 11 and the file is left alone. The reviewer asked for a
  restore only when the file still holds what this run wrote; once the check
  moved ahead of the write, that case has nothing to restore. Before, an edit
  that landed between the rename and the read-back was overwritten with the
  original. The cost: a write the disk corrupted is reported and not undone.
- **`--check --since` no longer hops to `rev-parse --show-toplevel`.** That
  followed `core.worktree` into another repository. `--no-relative` alone stops
  a subdirectory cwd from hiding the rest of the tree. Where a top level is
  still read (for `grant`), only the trailing newline is cut.
- Decision 0026: item 6 is re-wrapped, and its exit table gains 21 and 22.
- `status.js` says in a comment that the bare `coach` key is deliberate.

## Assumptions behind the rule "the grant never widens past the user's answer"

| Assumption | Holds because | If it does not hold |
|---|---|---|
| The first line for the slug is the user's answer | The Director's intake append is first, and a refused append makes it ask the user (a) | Residual c: a rewritten file is not detected |
| A line that cannot be read is never skipped | Any non-object line before the slug's line exits 19 (b) | Fails closed |
| `grant` reads the log of the project it runs in | `GIT_*` filtered; `CLAUDE_PROJECT_DIR` must agree (d) | `.git/config` is trusted: residual c |
| A note cannot change a word | Notes are stripped before the lookup; no word has parentheses | An unbalanced parenthesis exits 17 |
| The block's words and the log's names mean the same rows | One table in `status.js`; the test reads the template and the intake question through it | An unknown word exits 17, an unknown name 19 |

**Gaps (not tested).**

- Paths are compared after `realpath`, and case-insensitively on Windows. A
  case-sensitive folder on Windows, or two names for one network share, could
  make one project look like two. That exits 22: closed, not open.
- When git refuses the repository (`safe.directory`, git missing), the project
  is the cwd itself. From a subfolder no log is found, and a block that grants
  something exits 18.

**Contracts.**

- *Lost response.* An intake append that succeeded with a lost reply is retried
  as the same line, which exits 0 and writes nothing.
- *Fairness.* One file and one reader; nothing queues.
- *Request amplification.* `grant` runs at most two git processes (the cwd, and
  `CLAUDE_PROJECT_DIR` when set) and reads the log once. `log-event.js
  milestone` reads the log once per call. Neither grows with anything but the
  number of milestones.

## Not doing

- Signing or hashing the log (see c).
- A word for task PRs without the close review.
- Making `grant` refuse when a later line for the slug differs from the first.
  First-line-wins was the user's choice in decision 0026.
- Rewriting this repository's own grant block or log line.

## Consequences

- The Director sees `security-review-close` and `security-review-task` in the
  `grant` output and spends xlarge on a security row only when its name is
  there.
- A project upgrading from 1.1.0 changes nothing. Its next intake offers the
  two words.
- A script that read `security-review` from `grant` output must read the two
  names. Nothing in the plugin did.
- `grant` exits 19 in two cases that passed before: a damaged line ahead of the
  slug's line, and a log line with only `security-review-task`.
- `status.js set` exit 11 now always means "check the file"; it never restores.
