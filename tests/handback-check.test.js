// scripts/handback-check.js: a role agent's SubagentHandback must carry its
// result-json / review-json block, or the call is denied (at most twice).
'use strict';

const { tmpProject, run, test, assert, eq } = require('./helpers');

const RESULT = '```result-json\n{"status": "done", "summary": "x", "branch": "task/T-1", "pr": 1, "tests": "pass", "files_changed": 1, "follow_up": ""}\n```';
const REVIEW = '```review-json\n{"verdict": "approve", "severity": "none", "issues": [], "findings": [], "ci": "green", "tests_run": true, "tests_passed": true, "criteria_met": "all", "summary": "x"}\n```';

const input = (agentType, message, agentId = 'a1') => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'SubagentHandback',
  tool_use_id: `t-${Math.random()}`,
  ...(agentType ? { agent_type: agentType, agent_id: agentId } : {}),
  tool_input: { message },
});

function decision(r) {
  eq(r.status, 0, 'exit');
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout).hookSpecificOutput;
}

test('handback: implementer report without result-json is denied with a reason naming the block', () => {
  const p = tmpProject();
  const d = decision(run('handback-check.js', input('agent-team:implementer', 'Done. Tests pass. Follow-up: none.'), p));
  assert(d, 'a decision was written');
  eq(d.hookEventName, 'PreToolUse', 'event');
  eq(d.permissionDecision, 'deny', 'decision');
  assert(/no `result-json` block/.test(d.permissionDecisionReason), d.permissionDecisionReason);
});

test('handback: a parseable result-json (or review-json) block passes', () => {
  const p = tmpProject();
  eq(decision(run('handback-check.js', input('agent-team:implementer', `Summary.\n\n${RESULT}`), p)), null, 'implementer with block');
  eq(decision(run('handback-check.js', input('agent-team:reviewer', `Findings.\n\n${REVIEW}`), p)), null, 'reviewer with block');
});

test('handback: a fenced block that is not valid JSON is denied as invalid', () => {
  const p = tmpProject();
  const bad = '```result-json\n{"status": "done | partial", "summary": }\n```';
  const d = decision(run('handback-check.js', input('agent-team:architect', `Plan.\n${bad}`), p));
  assert(d && d.permissionDecision === 'deny', 'denied');
  assert(/not valid JSON/.test(d.permissionDecisionReason), d.permissionDecisionReason);
});

test('handback: the reviewer is asked for review-json', () => {
  const p = tmpProject();
  const d = decision(run('handback-check.js', input('agent-team:reviewer', 'Looks good.'), p));
  assert(d && /`review-json`/.test(d.permissionDecisionReason), d && d.permissionDecisionReason);
});

test('handback: other agents, the main session and other tools are left alone', () => {
  const p = tmpProject();
  eq(decision(run('handback-check.js', input('general-purpose', 'no block'), p)), null, 'general-purpose');
  eq(decision(run('handback-check.js', input(null, 'no block'), p)), null, 'no agent_type');
  eq(decision(run('handback-check.js', { ...input('agent-team:implementer', 'no block'), tool_name: 'Bash' }, p)), null, 'other tool');
});

test('handback: at most two denials per agent, then the handback goes through', () => {
  const p = tmpProject();
  const go = () => decision(run('handback-check.js', input('agent-team:implementer', 'still no block', 'a-cap'), p));
  assert(go(), 'first denied');
  assert(go(), 'second denied');
  eq(go(), null, 'third allowed');
  // A different agent still gets its own nudge.
  assert(decision(run('handback-check.js', input('agent-team:implementer', 'no block', 'a-other'), p)), 'other agent denied');
});
