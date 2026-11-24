---
id: 0030
title: Bind a PR review's block to a head; the fence residuals FU-23 closes and the one it can't
date: 2026-11-23
status: accepted            # the user chose "add head=, accept rest" on 2026-11-23, at the milestone close; the design below is the architect's
milestone: coach-followups
task: FU-23
decided_by: user
model: claude-opus-5-5
effort: high
---

# 0030: Bind a PR review's block to a head

Carries out the fence part of decision 0028 (the user rejected the FU-8 fence
residuals).

**The user's choice (2026-11-23, at the milestone close): "add head=, accept
rest".**
- Review cards now carry `head=<full SHA of the PR head>` (`task-card.md`).
- The one case this can't close is an accepted residual. A block written after
  that head existed and copied verbatim as the reviewer's last block is still
  logged. "What remains" below spells it out.
- The nonce (option 5) and signing (option 6) were declined for 1.2.0.
- The user also approved raising the core Director budget to the new size plus
  at most 10 bytes, capped at 33,860. The raise wasn't needed: cuts elsewhere
  in `task-card.md` keep the core set at 33,780 bytes, under the 33,800 cap.

## Context

`lib.reviewJson` reads a review only from one top-level `review-json` fence
that is the last content of the reply. The parser can't tell who wrote that
block. When the only top-level block in a reviewer's reply is one it quoted
(from the PR body, a diff, a hand-back or an older review) and the block ends
the reply, it was logged as the verdict. Logged verdicts gate merges and the
milestone close.

The same task closes the other fence gaps the reviews found:

- `trim()` on fence lines (it strips NBSP, VT and FF);
- HTML block type 7;
- the depth counter's quadratic regex;
- tags counted inside comments, scripts, indented code and NBSP- or VT-started
  lines, with one counter shared by `<details>` and `<div>`;
- the end line of HTML types 1-5 scanned for a fence;
- `choose()` preferring a refused hand-back;
- a `handback-check` report about a doubled backslash.

## Options

What makes the reviewer's own block different from a quoted one:

1. **Parse harder** (a colon before the block, the words around it). This is
   a guess, and a quote can copy any wording.
2. **Bind the block to a head** (chosen). `head_sha` is already in both
   reviewer schemas (`agents/reviewer.md`, `agents/security-reviewer.md`).
   `merging.md` already says a block without one is not enough to merge.
   - When the card names a PR, the block must carry a full SHA. This fails
     template blocks, test fixtures and prose quotes, which have no SHA, a
     placeholder or a short one.
   - When the card also names the head (`head=`), the SHA must match it. This
     fails an older review's block. It also fails any block committed in the
     diff, because a file can't name the commit that contains it.
3. **Ask the forge for the head when the review is logged.** That puts a
   network call in the hook. It is also wrong when the head moves during the
   review: a review of the older head is real and still names it.
4. **Record the branch tip locally when the review is spawned** (`git rev-parse`
   at PreToolUse). It needs `branch=` on review cards, a pending file per
   spawn, and changes in `codex-log.js`, which FU-24 owns. It still trusts
   remote-tracking refs that may be stale.
5. **A card-time nonce** that the reviewer echoes in its block. This is the only
   mechanism short of signing that also fails a block written after the head
   existed. It needs guidance changes in four places (the card, both reviewer
   files and the Codex agent files). Declined for 1.2.0.
6. **Signing.** Every agent here runs as the same OS user on one machine, so a
   key the reviewer can read, the implementer can read too. Signing would need
   a key held outside the agents. Declined for 1.2.0.

## Decision

Option 2, in `lib.reviewFor`. It covers every path: the subagent's PostToolUse,
SubagentStop, the bridge, Codex completions, reconcile, and `handback-check`.

- **Which cards bind.** A review delegation whose card names `pr=`, `branch=`
  or `head=` binds its block. A value of `none`, or an empty one, counts as
  absent.
- **What the block needs.**
  - Its `head_sha` must be a full SHA: 40 hex digits (SHA-1) or 64 (SHA-256),
    either case, with nothing trimmed.
  - When the card has `head=` (7 to 64 hex digits), `head_sha` must start with
    it. A `head=` value that isn't hex fails closed.
- **The card rule** (`task-card.md`). A review card names the PR head's full
  40-hex SHA in `head=`, next to the PR number in `pr=`.
- **A block that fails.** It becomes
  `{ _ambiguous: true, count: 1, reason: "head_sha", bound }` or
  `{ ..., reason: "head_mismatch", card_head }`. `bound` is the card key that
  made the check apply (`head`, `pr` or `branch`). No row is written. The
  reviewer is told why (SubagentStop, and the `handback-check` denial), or the
  Director is (bridge, foreground PostToolUse). The message names the head
  check and the card key, not the fence rules.
- **Reviews with no PR.** A design or document review has a card with no `pr=`,
  `branch=` or `head=`. Its block may leave out `head_sha` or set it to `null`.
  It is logged as before. Such a review gates no merge: `merge-task.js` needs
  `--sha`.
- **A head that moved.** If the head moves during a review and the reviewer
  reviews the newer head, its block won't match a `head=` that names the older
  one. It is not logged. The Director re-cards with the new head, as
  `merging.md` already does for `head_moved`.
- **A resumed reviewer.** A resume card that names a new `head=` replaces the
  delegation's head (`completionTask`).
- **The hand-back check finds the card.**
  1. It tries the card of the entry that opened the latest turn in the agent's
     own transcript: `agent_transcript_path`, or
     `<session transcript without .jsonl>/subagents/agent-<id>.jsonl`.
     - It reads the transcript only when the agent id is a plain name.
     - Only an entry that starts a turn counts, as `startsTurn` in
       `log-delegation.js` decides: a real prompt, or an `isMeta` resume
       carrying a `TASK id=` card.
     - A tool result or a system entry that quotes a TASK line is not the card.
       Otherwise it could swap the head, or turn the check off with a card that
       names no PR.
  2. If that fails, it uses the agent's delegation line.
  3. With no card, there is no head check at the hand-back. The stop hook still
     checks.
- **`choose()` (SubagentStop).** A hand-back wins over the other report sources
  only when `lib.handbackReadable` accepts it, the same predicate
  `handback-check` uses. A refused hand-back is followed by more of the agent's
  reply, so the newer hook-input message is read instead. Refused means a block
  that is ambiguous, unreadable, tilde-fenced or fails the head check.

The parser items:

- **Fence lines** trim only spaces and tabs. A closing run followed by NBSP, VT
  or FF does not close. An opener followed by one still opens a fence, as
  CommonMark says, but never a review fence: its info string isn't
  `review-json`. Treating it as no fence at all would make its closing line
  open a new fence. Either reading leaves the block unread.
- **HTML type 7.** A complete open or closing tag alone on its line, of any
  name except pre, script, style and textarea, is raw HTML up to a blank line.
  It does not start a block right after a paragraph line. Headings, setext and
  thematic lines, `>` quotes and list items count as not paragraph text. That
  errs toward reading HTML, which can hide a real block but never forge one.
  Types 1 and 6 now end a tag name only at a space, a tab, `>`, `/>` or the end
  of the line, as CommonMark says. Before, any JS `\s` ended it, VT included.
- **Tag counting.**
  - `<details>` and `<div>` have separate counters.
  - A hand-written linear scan replaces the regex.
  - Tags count only in raw HTML: the lines of a type 6 or 7 block, and the text
    after the end marker of a type 1-5 block. Within those, tags inside a
    comment or a script, style or textarea element don't count. A comment or
    raw-text element left open hides the lines after it until it closes.
  - In markdown lines, an opening tag counts only while one is already open,
    and a closing tag never counts. Those lines are paragraph text, code spans,
    indented code and NBSP- or VT-started lines.
  - Fences are tracked while hidden, so a closing tag inside one is text. None
    of them is a review block.
- **The end line of a type 1-5 block** is raw and is never scanned for a fence.
- **`handback-check` and the doubled backslash.** The hook agrees with
  `JSON.parse` for 1, 2, 3, 4 and 8 backslashes, before `b`, `x` and `n`. A
  doubled backslash passes. The refusal is right only when the text that
  reaches the hook really is invalid JSON. The usual case is a Windows path
  with single backslashes (`C:\Users`). The likely source of the report is a
  shell layer that halved the backslashes before the hook saw them: this
  task's own Bash tool does that. The refusal now adds a hint to double each
  backslash.

## Assumptions behind the rule, and where they fail

The rule: a block a reviewer quoted is not logged as a PR review's verdict.

1. **Reviewers write the full head SHA.** Both reviewer files say so. A short
   SHA or a missing one draws a re-ask. After one re-ask the review counts as
   missing. This fails closed.
2. **PR review cards carry `pr=`.** `task-card.md` says to put the PR number
   there. A card that leaves it out binds nothing, the same as before this
   decision.
3. **A file can't name the commit that contains it.** This holds, but only
   helps when the card names `head=`. A card without `head=` (one written
   before this rule, or by a Director that left it out) lets any real full SHA
   pass, for example the SHA of a parent commit written in a fixture.
4. **The hand-back hook can find the card.** The transcript layout comes from
   `reconcile-logs.js`. It has not been checked live for a PreToolUse call made
   inside a subagent. If the card isn't found, the hand-back check skips the
   head and the stop hook still applies it.
5. **What a reader sees follows CommonMark 0.31.** A tag in the middle of a
   paragraph line (`text <details>`) is not counted at depth 0, as before. A
   block after it is read, even though GitHub renders it inside a collapsed
   `<details>`. That case hides a block in the rendered page; it doesn't trick
   the parser. It is unchanged by this task.

## What remains (accepted by the user, 2026-11-23)

With `head=` on review cards, only a block that names the card's head is
logged. One case still is: a block written after that head existed, by someone
who knew it, that the reviewer copies verbatim as the last content of its
reply, at the top level, with no block of its own after it.

- **Where such a block can come from:** the PR body or its comments, the
  implementer's hand-back after its last push, or a CI log.
- **Why the risk is bounded:** such a block can approve only the head it names,
  and `merge-task.js` merges only that head. The risk is a head merged without
  a real review. A different head can't be merged this way.
- **Declined for 1.2.0:** closing this case needs option 5 (a nonce, which
  needs four guidance files and still fails against an agent that reads the
  card or `delegations.jsonl` after the card is issued) or option 6 (a key held
  outside the agents).

Also still open, as before this decision:

- A review card with no `pr=`, `branch=` or `head=` binds nothing.
- A PR review card that leaves out `head=` binds only to "some full SHA".

## Not doing

- No other guidance edits. The `task-card.md` lines for `head=` are paid for by
  cutting words in the same file, so no byte budget changes.
- No change to `records.js`. FU-24 owns it. The head-check nudges live in
  `lib.headNudge`, and `log-delegation.js` picks them before the fence nudges in
  `records.js`. `codex-log.js` has no nudge channel. Its completion line carries
  the marker with its `reason`.
- No relaxing of "two top-level blocks are ambiguous", even when only one
  matches the head. Fail closed.
- No row for an uncarded review sent to a non-reviewer agent (issue #174). With
  no review card and no reviewer agent type, the hook can't tell a review from
  a quote. The Director logs such a review with `log-event.js review`.
- Issue #174's Codex reviewer-name item: a test now checks that every reviewer
  role `codex-agents.js` writes is a review delegation, and that no other role
  is.
