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

const lib = require('./lib');
const { claimOnce } = require('./records');

const MAX_NUDGES = 2;

function check(input) {
  if (input.tool_name !== 'SubagentHandback') return null;
  const agentType = input.agent_type || '';
  if (!agentType.startsWith('agent-team:')) return null;
  const message = lib.responseText((input.tool_input || {}).message) || '';
  // lastFencedJson returns { _unparsed } for a block that isn't valid JSON.
  const parsed = (tag) => { const v = lib.lastFencedJson(message, tag); return v && !v._unparsed; };
  if (parsed('result-json') || parsed('review-json')) return null;
  const agentId = input.agent_id || 'unknown';
  let claimed = false;
  for (let n = 1; n <= MAX_NUDGES && !claimed; n++) claimed = claimOnce(input, `handback-${agentId}-${n}`);
  if (!claimed) return null;
  const block = agentType === 'agent-team:reviewer' ? 'review-json' : 'result-json';
  const fenced = /```(result|review)-json/.test(message);
  const why = fenced ? `its \`${block}\` block is not valid JSON` : `it has no \`${block}\` block`;
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

module.exports = { check };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    try { lib.appendJsonl({}, 'hook-errors.jsonl', { ts: new Date().toISOString(), hook: 'handback-check', error: String(err && err.stack || err) }); } catch { /* ignore */ }
  }
  process.exit(0);
}
