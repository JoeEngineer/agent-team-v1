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

// --- FU-23 ------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// A doubled backslash is valid JSON and passes; a single one before a letter
// that is no JSON escape (a Windows path) is invalid, and the reason says how to fix it.
test('handback: backslashes in a result-json string: doubled ones pass, a Windows path with single ones is refused with a hint', () => {
  const p = tmpProject();
  const BS = String.fromCharCode(92);
  const block = (summary) => '```result-json\n{"status": "done", "summary": "' + summary + '", "follow_up": ""}\n```';
  for (const s of [`a${BS}${BS}b`, `a${BS.repeat(4)}b`, `C:${BS}${BS}Users${BS}${BS}x`]) {
    eq(decision(run('handback-check.js', input('agent-team:implementer', `Done.\n\n${block(s)}`, `bs-ok-${s.length}`), p)), null, `passes: ${s}`);
  }
  const d = decision(run('handback-check.js', input('agent-team:implementer', `Done.\n\n${block(`C:${BS}Users${BS}x`)}`, 'bs-bad'), p));
  assert(d && d.permissionDecision === 'deny', 'single backslashes denied');
  assert(/not valid JSON/.test(d.permissionDecisionReason) && d.permissionDecisionReason.includes(`each backslash as \`${BS}${BS}\``), d.permissionDecisionReason);
  // Invalid JSON with no backslash gets no hint.
  const plain = decision(run('handback-check.js', input('agent-team:implementer', 'Plan.\n```result-json\n{"status": }\n```', 'bs-none'), p));
  assert(plain && /not valid JSON/.test(plain.permissionDecisionReason) && !/backslash/.test(plain.permissionDecisionReason), plain && plain.permissionDecisionReason);
});

const HEAD = 'c0ffee' + '1'.repeat(34);
const reviewBlock = (extra) => '```review-json\n' + JSON.stringify({ verdict: 'approve', severity: 'none', issues: [], summary: 'x', ...extra }) + '\n```';
const CARD = (extra = '') => `TASK id=V-7 type=review milestone=m attempt=1 pr=9 ${extra}`.trim();
const userLine = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';

test('handback: a reviewer whose card names a PR is refused a block without a full head_sha (card from its transcript)', () => {
  const p = tmpProject();
  const dir = fs.mkdtempSync(path.join(p, 'sess-'));
  // The session transcript and the subagent's own, as Claude Code lays them out.
  const session = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(session, '');
  fs.mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-1', 'subagents', 'agent-rv1.jsonl'), userLine(CARD(`head=${HEAD.slice(0, 10)}`)));
  const send = (message) => decision(run('handback-check.js', { ...input('agent-team:reviewer', message, 'rv1'), transcript_path: session }, p));
  const d = send(`Review.\n\n${reviewBlock({})}`);
  assert(d && d.permissionDecision === 'deny', 'no head_sha: denied');
  assert(/`head_sha` is not the full SHA/.test(d.permissionDecisionReason), d.permissionDecisionReason);
  const old = send(`Review.\n\n${reviewBlock({ head_sha: 'badbad' + '2'.repeat(34) })}`);
  assert(old && old.permissionDecisionReason.includes('not the head the card names (`head=c0ffee1111`)'), old && old.permissionDecisionReason);
  eq(send(`Review.\n\n${reviewBlock({ head_sha: HEAD })}`), null, 'the card head: passes');
});

test('handback: the card also comes from agent_transcript_path, or else the delegation line; with none, no head check', () => {
  const p = tmpProject();
  const t = path.join(p, 'agent-rv2.jsonl');
  fs.writeFileSync(t, userLine(CARD()));
  const viaPath = decision(run('handback-check.js', { ...input('agent-team:reviewer', `R.\n\n${reviewBlock({})}`, 'rv2'), agent_transcript_path: t }, p));
  assert(viaPath && /head_sha/.test(viaPath.permissionDecisionReason), 'agent_transcript_path card');
  fs.writeFileSync(path.join(p, '.agent-team', 'logs', 'delegations.jsonl'), JSON.stringify({ kind: 'subagent', agent_id: 'rv3', task: { id: 'V-8', type: 'review', pr: '4' } }) + '\n');
  const viaLog = decision(run('handback-check.js', input('agent-team:reviewer', `R.\n\n${reviewBlock({})}`, 'rv3'), p));
  assert(viaLog && /head_sha/.test(viaLog.permissionDecisionReason), 'delegation-line card');
  eq(decision(run('handback-check.js', input('agent-team:reviewer', `R.\n\n${reviewBlock({})}`, 'rv4'), p)), null, 'no card found: the block passes, as before');
  // An agent id that is not a plain name is never joined into a path: this one
  // would reach a transcript holding a PR card.
  fs.mkdirSync(path.join(p, 'a', 's'), { recursive: true });
  fs.writeFileSync(path.join(p, 'a', 's', 'agent-rv5.jsonl'), userLine(CARD()));
  const odd = decision(run('handback-check.js', { ...input('agent-team:reviewer', `R.\n\n${reviewBlock({})}`, '../../../agent-rv5'), transcript_path: path.join(p, 'a', 's.jsonl') }, p));
  eq(odd, null, 'odd agent id: no card read');
});
