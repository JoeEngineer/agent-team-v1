#!/usr/bin/env node
// PreToolUse hook for SubagentHandback. A role agent (agent-team:*) that ends
// its run through SubagentHandback must put its result-json (or, for the
// reviewer, review-json) block in the handback message: the handback ends the
// run, so the SubagentStop nudge in log-delegation.js comes too late. When the
// block is missing or does not parse, deny the call once with a reason the
// agent can act on, so it retries with the block.
//
// At most MAX_NUDGES denials per agent, so an agent that can't comply still
// finishes. Outside a subagent, or for other agent types, it does nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { claimOnce, findDelegation } = require('./records');

const MAX_NUDGES = 2;

// The agent's task card, for the review's head check (lib.reviewFor). A
// foreground agent's delegation line is written only when it returns, so the
// card comes first from the TASK line of the latest turn in the agent's own
// transcript (<session transcript without .jsonl>/subagents/agent-<id>.jsonl),
// then from its delegation line. Null when neither is found: the check then
// runs without a card, and log-delegation.js still applies it at SubagentStop.
function cardOf(input) {
  const id = input.agent_id;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null;
  const file = typeof input.agent_transcript_path === 'string' && input.agent_transcript_path
    ? input.agent_transcript_path
    : typeof input.transcript_path === 'string' && /\.jsonl$/.test(input.transcript_path)
      ? path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents', `agent-${id}.jsonl`) : null;
  let card = null;
  try {
    if (file) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.includes('TASK')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== 'user' || !e.message) continue;
        const task = lib.parseTaskCard(lib.responseText(e.message.content));
        if (task.id) card = task; // the latest turn's card
      }
    }
  } catch { /* no transcript to read */ }
  if (card) return card;
  try {
    const d = findDelegation(input, (rec) => rec.agent_id === id);
    return d && d.task && d.task.id ? d.task : null;
  } catch { return null; }
}

function check(input) {
  if (input.tool_name !== 'SubagentHandback') return null;
  const agentType = input.agent_type || '';
  if (!agentType.startsWith('agent-team:')) return null;
  const message = lib.responseText((input.tool_input || {}).message) || '';
  // Both readers return { _unparsed } for a block that isn't valid JSON. The
  // review reader also returns { _ambiguous } when its fence is not one
  // top-level block at the end of the message, or (with a card that names a PR)
  // its head_sha is not a full SHA or not the card's head: the logger would
  // read no review. A reviewer's hand-back is its review: a result-json block
  // does not stand in for a review-json one that is missing or ambiguous.
  // Only a reviewer agent gets the ambiguity reading; an agent of another type
  // that quotes a review-json fence is not asked about it.
  const card = lib.REVIEWER_AGENT_TYPES.includes(agentType) ? cardOf(input) : null;
  if (lib.handbackReadable(message, agentType, card)) return null;
  const agentId = input.agent_id || 'unknown';
  let claimed = false;
  for (let n = 1; n <= MAX_NUDGES && !claimed; n++) claimed = claimOnce(input, `handback-${agentId}-${n}`);
  if (!claimed) return null;
  const review = lib.reviewFor(message, agentType, card);
  const block = lib.REVIEWER_AGENT_TYPES.includes(agentType) ? 'review-json' : 'result-json';
  const fenced = /```(result|review)-json/.test(message);
  // A JSON string needs every backslash doubled; a Windows path written with
  // single ones (`C:\Users`) is the usual way a block fails to parse.
  const read = review && review._unparsed ? review : lib.lastFencedJson(message, block);
  const backslash = read && read._unparsed && read._unparsed.includes('\\')
    ? ' (inside a JSON string, write each backslash as `\\\\`, Windows paths too)' : '';
  const why = lib.headWhy(review)
    || (review && review._ambiguous
      ? 'its `review-json` block is not exactly one fence at column 0, outside any other fence or quote, as the last thing in the message'
      : fenced ? `its \`${block}\` block is not valid JSON${backslash}` : `it has no \`${block}\` block`);
  return `agent-team: SubagentHandback not sent: ${why}. Call SubagentHandback again with your full report, ending with the fenced \`${block}\` block your instructions describe (valid JSON, no placeholders). The Director and the logs read your result only from that block.`;
}

function main() {
  const input = lib.readStdin();
  const reason = check(input);
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

module.exports = { check, cardOf };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    try { lib.appendJsonl({}, 'hook-errors.jsonl', { ts: new Date().toISOString(), hook: 'handback-check', error: String(err && err.stack || err) }); } catch { /* ignore */ }
  }
  process.exit(0);
}
