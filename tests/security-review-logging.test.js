// The security reviewer and the security-review task type (decision 0022):
// SubagentStop nudge, handback check, bridge review logging, Codex completion.
// Every run uses a throwaway project folder (run() points CLAUDE_PROJECT_DIR at it).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ROOT, SCRIPTS, tmpProject, run, readLog, test, assert, eq } = require('./helpers');

console.log('security-review-logging');

const SCAN = { files: 12, tools: ['npm audit'], clean: true };
const COVERAGE = { reviewed: ['scripts/'], skipped: [] };
const REVIEW = { verdict: 'approve', severity: 'none', issues: [], findings: [], summary: 'ok', scan: SCAN, coverage: COVERAGE };
const block = (v, tag = 'review-json') => '```' + tag + '\n' + JSON.stringify(v) + '\n```';
const CARD = 'TASK id=SEC-1 type=security-review reviewed_task=T-1 pr=5 attempt=1\nWHY test';

function transcript(card) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-secrev-')), 'agent-s1.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-30T18:33:35.000Z', message: { role: 'user', content: card } },
    { type: 'assistant', timestamp: '2026-10-30T18:33:37.000Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const stop = (p, file, over = {}) => run('log-delegation.js', {
  hook_event_name: 'SubagentStop', agent_id: 's1', agent_type: 'agent-team:security-reviewer',
  agent_transcript_path: file, ...over,
}, p, { AGENT_TEAM_STOP_RETRY_MS: '0' });

test('SubagentStop: a security reviewer with no block is nudged for review-json', () => {
  const p = tmpProject();
  const r = stop(p, transcript(CARD), { last_assistant_message: 'No findings.' });
  eq(r.status, 0, 'exit');
  const c = readLog(p, 'completions.jsonl');
  eq(c.length, 1, 'precondition: completion written');
  eq(c[0].review, null, 'precondition: the report had no review block');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert(ctx.includes('`review-json`') && !ctx.includes('`result-json`'), ctx);
});

test('SubagentStop: a security-review card on a general agent also gets the review-json nudge', () => {
  const p = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu', tool_input: { subagent_type: 'agent-team:implementer', prompt: CARD }, tool_response: { agentId: 's1', isAsync: true, status: 'async_launched' } }, p);
  eq(readLog(p, 'delegations.jsonl').length, 1, 'precondition: delegation with the card logged');
  const r = stop(p, transcript(CARD), { agent_type: 'agent-team:implementer', last_assistant_message: 'No findings.' });
  assert(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('`review-json`'), r.stdout);
});

test('SubagentStop: the implementer still gets the result-json nudge', () => {
  const p = tmpProject();
  const r = stop(p, transcript('TASK id=T-1 type=implement attempt=1'), { agent_type: 'agent-team:implementer', last_assistant_message: 'Done.' });
  assert(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('`result-json`'), r.stdout);
});

test('SubagentStop: a security reviewer completion keeps scan, coverage and role security-review', () => {
  const p = tmpProject();
  const r = stop(p, transcript(CARD), { last_assistant_message: `Report.\n${block(REVIEW)}` });
  eq(r.stdout, '', 'precondition: block present, no nudge');
  const [c] = readLog(p, 'completions.jsonl');
  eq(c.task.type, 'security-review', 'card type on the completion');
  eq(JSON.stringify(c.review.scan), JSON.stringify(SCAN), 'scan on the completion');
  eq(JSON.stringify(c.review.coverage), JSON.stringify(COVERAGE), 'coverage on the completion');
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'one review row');
  eq(rows[0].role, 'security-review', 'role');
  eq(rows[0].task_id, 'T-1', 'reviewed task');
  eq(JSON.stringify(rows[0].scan), JSON.stringify(SCAN), 'scan on the row');
  eq(JSON.stringify(rows[0].coverage), JSON.stringify(COVERAGE), 'coverage on the row');
});

test('handback: a security reviewer is asked for review-json, and a valid block passes', () => {
  const p = tmpProject();
  const input = (message) => ({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_use_id: 'x', agent_type: 'agent-team:security-reviewer', agent_id: 'sh1', tool_input: { message } });
  const denied = run('handback-check.js', input('No findings.'), p);
  const d = JSON.parse(denied.stdout).hookSpecificOutput;
  eq(d.permissionDecision, 'deny', 'precondition: denied');
  assert(/`review-json`/.test(d.permissionDecisionReason) && !/`result-json`/.test(d.permissionDecisionReason), d.permissionDecisionReason);
  eq(run('handback-check.js', input(block(REVIEW)), p).stdout, '', 'a parseable block goes through');
});

// --- bridge calls --------------------------------------------------------------

const bridge = (p, prompt, text, tool = 'mcp__codex-bridge__codex_exec', model = 'gpt-6.1-sol') => {
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: `b-${Math.random()}`,
    tool_input: { prompt, model }, tool_response: { content: [{ type: 'text', text }] },
  }, p);
  eq(r.status, 0, 'exit');
};

test('bridge: a parseable review-json with a card id logs a review row with the card type and bridge model', () => {
  const p = tmpProject();
  bridge(p, CARD, `Report\n${block(REVIEW)}`);
  const [d] = readLog(p, 'delegations.jsonl');
  eq(d.kind, 'bridge', 'precondition: bridge delegation');
  eq(d.review.verdict, 'approve', 'delegation line has review');
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'one review row');
  eq(rows[0].role, 'security-review', 'role from the card type');
  eq(rows[0].reviewer_model, 'gpt-6.1-sol', 'bridge model');
  eq(rows[0].task_id, 'T-1', 'reviewed task');
  eq(rows[0].scan.files, 12, 'scan kept');
});

test('bridge: a review with no card id keeps review on the delegation line and writes no row', () => {
  const p = tmpProject();
  bridge(p, 'review this please', block(REVIEW));
  const [d] = readLog(p, 'delegations.jsonl');
  eq(d.kind, 'bridge', 'precondition: delegation written');
  eq(d.review.verdict, 'approve', 'review on the delegation');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no review row');
});

test('bridge: a response with no block adds no review row and no review field', () => {
  const p = tmpProject();
  bridge(p, CARD, `Report\n${block({ status: 'done' }, 'result-json')}`);
  const [d] = readLog(p, 'delegations.jsonl');
  eq(d.result.status, 'done', 'precondition: result still read');
  assert(!('review' in d), 'no review field');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no review row');
});

test('bridge: an unparseable review-json is _unparsed and writes no row', () => {
  const p = tmpProject();
  bridge(p, CARD, '```review-json\n{"verdict": }\n```');
  const [d] = readLog(p, 'delegations.jsonl');
  assert(d.review && d.review._unparsed, 'precondition: _unparsed recorded');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no review row');
});

test('bridge: a check_runway call is still not logged as a delegation', () => {
  const p = tmpProject();
  bridge(p, CARD, block(REVIEW), 'mcp__codex-bridge__check_runway');
  eq(readLog(p, 'delegations.jsonl').length, 0, 'no delegation');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no review');
  bridge(p, CARD, block(REVIEW));
  eq(readLog(p, 'delegations.jsonl').length, 1, 'control: a real bridge call is logged');
});

// --- Codex ---------------------------------------------------------------------

test('codex: a security-reviewer-large completion logs its review with scan and tier large', () => {
  const p = tmpProject();
  const ev = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-secrev-cx-')), 'agent-cx.jsonl');
  fs.writeFileSync(file, [
    ev('session_meta', { id: 'agent-cx', agent_path: '/root/sec_1_a1', source: { subagent: { thread_spawn: { agent_path: '/root/sec_1_a1' } } } }),
    ev('session_meta', { id: 'sess-1', source: 'exec' }),
    ev('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    ev('turn_context', { turn_id: 'turn-1', model: 'gpt-6.1-sol', effort: 'high' }),
    ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 }, last_token_usage: {} } }),
    ev('event_msg', { type: 'task_complete', turn_id: 'turn-1', duration_ms: 1000 }),
  ].join('\n') + '\n');
  const le = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'delegation', JSON.stringify({
    card: CARD, tool: 'codex', task_name: 'sec_1_a1', agent: 'security-reviewer-large', model: 'gpt-6.1-sol', tier: 'large', effort: 'high',
  })], { cwd: p, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p, CLAUDE_PLUGIN_ROOT: ROOT } });
  eq(le.status, 0, le.stderr);
  eq(readLog(p, 'delegations.jsonl').length, 1, 'precondition: Director delegation line');
  const r = run('log-delegation.js', {
    session_id: 'sess-1', turn_id: 'turn-1', cwd: p, model: 'gpt-test', permission_mode: 'bypassPermissions',
    hook_event_name: 'SubagentStop', agent_id: 'agent-cx', agent_type: 'security-reviewer-large',
    agent_transcript_path: file, stop_hook_active: false, last_assistant_message: `Report\n${block(REVIEW)}`,
  }, p);
  eq(r.status, 0, 'exit');
  const [c] = readLog(p, 'completions.jsonl');
  assert(c, 'precondition: completion written');
  eq(c.task.type, 'security-review', 'card type');
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'one review row');
  eq(rows[0].tool, 'codex', 'tool');
  eq(rows[0].role, 'security-review', 'role');
  eq(rows[0].reviewer_tier, 'large', 'tier large');
  eq(rows[0].scan.files, 12, 'scan kept');
});

// --- block-retry wait ------------------------------------------------------------
// The block lands in the transcript 500 ms after the hook starts; the hook
// re-reads every 600 ms (up to four times), so the first read has no block and a
// later one does. Without the wait the completion would have no review.

const handbackLine = (message) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T18:33:42.000Z', message: { id: 'm_late', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] } }) + '\n';

function lateBlockStop(p, agentType, id) {
  const file = transcript(CARD);
  assert(!fs.readFileSync(file, 'utf8').includes('review-json'), 'precondition: no block in the transcript when the hook starts');
  const code = `setTimeout(()=>require('fs').appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(handbackLine(block(REVIEW)))}), 500)`;
  spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: id, agent_type: agentType, agent_transcript_path: file }, p, { AGENT_TEAM_STOP_RETRY_MS: '600' });
  const cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 1, 'one completion');
  return cs[0];
}

test('SubagentStop retry: a security reviewer whose block lands late is found by the wait', () => {
  const p = tmpProject();
  const c = lateBlockStop(p, 'agent-team:security-reviewer', 'late-sec');
  eq(c.report_source, 'handback', 'report from the late handback');
  eq(c.review.scan.files, 12, 'review read after the wait');
  eq(readLog(p, 'reviews.jsonl').length, 1, 'review logged');
});

test('SubagentStop retry: a security-review card on a non-agent-team agent waits for the block too', () => {
  const p = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu', tool_input: { subagent_type: 'general-purpose', prompt: CARD }, tool_response: { agentId: 'late-gp', isAsync: true, status: 'async_launched' } }, p);
  eq(readLog(p, 'delegations.jsonl')[0].task.type, 'security-review', 'precondition: delegation carries the security-review card');
  const c = lateBlockStop(p, 'general-purpose', 'late-gp');
  eq(c.report_source, 'handback', 'report from the late handback');
  eq(readLog(p, 'reviews.jsonl')[0].role, 'security-review', 'review logged with the card type');
});
