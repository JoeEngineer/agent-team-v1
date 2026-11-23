// FU-3: review cards are never drift baselines or escalation resumes, reason=confirm,
// flags= on the task card, and a review-json verdict that contradicts its severity.
// Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, NO_MODELS_FILE, tmpProject, run, readLog, test, assert, eq } = require('./helpers');

console.log('fu3-logger');

const env = { AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_STOP_RETRY_MS: '0' };
const impl = 'TASK id=F-1 type=implement difficulty=medium milestone=m attempt=1';
const context = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; } };

function spawnAgent(p, prompt, n = 1) {
  return run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: `tu${n}`,
    tool_input: { subagent_type: 'agent-team:implementer', prompt }, tool_response: { agentId: `a${n}`, status: 'async_launched' } }, p, env);
}
function sendMessage(p, message, n = 9, to = 'a1') {
  return run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'SendMessage', tool_use_id: `tm${n}`,
    tool_input: { to, message } }, p, env);
}
function logEvent(p, data) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'delegation', '-'], {
    input: JSON.stringify(data), cwd: p, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: p, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_TOOL: '' },
  });
}

test('G15: an implement card followed by a review card with the same id is not drift; implement-to-fix still is', () => {
  const p = tmpProject();
  spawnAgent(p, impl);
  const r = sendMessage(p, 'TASK id=F-1 type=review difficulty=hard milestone=m attempt=1', 2);
  const ds = readLog(p, 'delegations.jsonl');
  eq(ds.length, 2, 'precondition: both lines logged');
  eq(ds[1].task.type, 'review', 'precondition: the second card is a review');
  eq(ds[1].card_drift, undefined, 'review card: no card_drift');
  eq(context(r), '', 'review card: no drift message');
  const sr = sendMessage(p, 'TASK id=F-1 type=security-review difficulty=hard milestone=m attempt=1', 3);
  eq(readLog(p, 'delegations.jsonl')[2].card_drift, undefined, 'security-review card: no card_drift');
  eq(context(sr), '', 'security-review: no message');
  // Recovery control: a fix card still drifts against the implement baseline.
  const fx = sendMessage(p, 'TASK id=F-1 type=fix difficulty=medium milestone=m attempt=2', 4);
  eq(readLog(p, 'delegations.jsonl')[3].card_drift.type.to, 'fix', 'implement-to-fix still drifts');
  assert(/type implement -> fix/.test(context(fx)), context(fx));
});

test('G15: a review card first in the log is not a baseline for a later implement card', () => {
  const p = tmpProject();
  eq(logEvent(p, { card: 'TASK id=F-2 type=review difficulty=hard milestone=m attempt=1', tool: 'codex', task_name: 'f2r' }).stderr, '', 'review first');
  const r = logEvent(p, { card: 'TASK id=F-2 type=implement difficulty=medium milestone=m attempt=1', tool: 'codex', task_name: 'f2i' });
  eq(r.stderr, '', 'no drift against a review');
  eq(readLog(p, 'delegations.jsonl')[1].card_drift, undefined, 'no field');
});

test('G16: an escalation resume on a review card draws no message; on an implement card it still does', () => {
  const p = tmpProject();
  spawnAgent(p, impl);
  const rv = sendMessage(p, 'TASK id=F-1 type=review milestone=m attempt=2 reason=escalation', 2);
  eq(readLog(p, 'delegations.jsonl')[1].task.reason, 'escalation', 'precondition: reason=escalation reached the line');
  eq(context(rv), '', 'review: no escalation message');
  const im = sendMessage(p, 'TASK id=F-1 type=implement difficulty=medium milestone=m attempt=3 reason=escalation', 3);
  assert(/escalation sent as a resume/.test(context(im)), context(im));
});

test('confirm is an accepted reason on a review card and warned on any other card', () => {
  const p = tmpProject();
  spawnAgent(p, impl);
  const ok = sendMessage(p, 'TASK id=F-1 type=security-review milestone=m attempt=2 reason=confirm', 2);
  eq(readLog(p, 'delegations.jsonl')[1].task.reason, 'confirm', 'precondition: reason reached the line');
  eq(context(ok), '', 'review card: accepted quietly');
  const bad = sendMessage(p, 'TASK id=F-1 type=implement difficulty=medium milestone=m attempt=3 reason=confirm', 3);
  assert(/reason=confirm on a implement/.test(context(bad)), context(bad));
  assert(!/use one of/.test(context(bad)), 'confirm is not an unknown reason');
});

test('G20: flags= is logged as an array on spawn, resume and Codex lines; no key, no field', () => {
  const p = tmpProject();
  const s = spawnAgent(p, impl + ' flags=security-sensitive,above-table');
  sendMessage(p, 'TASK id=F-1 type=implement difficulty=medium milestone=m attempt=2 flags=above-table', 2);
  logEvent(p, { card: impl.replace('F-1', 'F-3') + ' flags=security-sensitive', tool: 'codex', task_name: 'f3' });
  spawnAgent(p, impl.replace('F-1', 'F-4'), 4);
  const ds = readLog(p, 'delegations.jsonl');
  eq(JSON.stringify(ds[0].task.flags), '["security-sensitive","above-table"]', 'spawn');
  eq(JSON.stringify(ds[1].task.flags), '["above-table"]', 'resume');
  eq(JSON.stringify(ds[2].task.flags), '["security-sensitive"]', 'codex');
  assert(!('flags' in ds[3].task), 'no key, no field');
  eq(context(s), '', 'known flags: no warning');
});

test('G20: an unknown flag is kept and draws one warning', () => {
  const p = tmpProject();
  const r = spawnAgent(p, impl + ' flags=security-sensitive,bogus');
  eq(JSON.stringify(readLog(p, 'delegations.jsonl')[0].task.flags), '["security-sensitive","bogus"]', 'kept');
  const msgs = context(r).split('\n').filter((l) => /unknown flags/.test(l));
  eq(msgs.length, 1, 'one warning');
  assert(/unknown flags=bogus/.test(msgs[0]) && !/unknown flags=security/.test(msgs[0]), msgs[0]);
  const cli = logEvent(p, { card: impl.replace('F-1', 'F-5') + ' flags=nope', tool: 'codex', task_name: 'f5' });
  assert(/unknown flags=nope/.test(cli.stderr), cli.stderr);
});

// --- verdict conflict ---------------------------------------------------------

const block = (verdict, severity) => '```review-json\n' + JSON.stringify({ verdict, severity, issues: [], summary: 's' }) + '\n```';
function stopWith(p, agentId, report, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu3-'));
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const lines = [
    { type: 'user', timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'TASK id=V-1 type=review milestone=m attempt=1 pr=9' } },
    { type: 'assistant', timestamp: '2026-10-30T10:00:05.000Z', message: { id: 'm0', model: 'claude-sonnet-5-5', usage,
      content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } },
  ];
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'agent-team:reviewer', agent_transcript_path: file, ...extra }, p, env);
}

test('verdict conflict: the contradictions set verdict_conflict; consistent verdicts do not', () => {
  const cases = [
    ['changes_requested', 'none', true], ['changes_requested', 'minor', true], ['reject', 'minor', true], ['reject', 'none', true],
    ['approve', 'major', true], ['approve', 'critical', true],
    ['changes_requested', 'major', false], ['reject', 'critical', false], ['approve', 'none', false], ['approve', 'minor', false],
  ];
  cases.forEach(([v, sev, want], i) => {
    const p = tmpProject();
    stopWith(p, `vc${i}`, block(v, sev));
    const rows = readLog(p, 'reviews.jsonl');
    eq(rows.length, 1, `precondition: ${v}/${sev} wrote a row`);
    eq(rows[0].verdict_conflict, want ? true : undefined, `${v}/${sev}`);
  });
});

test('verdict conflict: one nudge at SubagentStop, none under stop_hook_active or without a conflict', () => {
  const p = tmpProject();
  const r = stopWith(p, 'vn1', block('changes_requested', 'minor'));
  eq(readLog(p, 'reviews.jsonl')[0].verdict_conflict, true, 'precondition: conflict detected');
  assert(/give a `major` with its exploit path, or an `approve`/.test(context(r)), r.stdout);
  const again = stopWith(p, 'vn2', block('changes_requested', 'minor'), { stop_hook_active: true });
  eq(readLog(p, 'reviews.jsonl').length, 2, 'precondition: the repeated stop was logged');
  eq(again.stdout, '', 'stop_hook_active: quiet');
  const fine = stopWith(p, 'vn3', block('changes_requested', 'major'));
  eq(fine.stdout, '', 'consistent verdict: quiet');
});

test('verdict conflict: on the bridge path the Director gets the message and the row is flagged', () => {
  const p = tmpProject();
  const bridge = (text, n) => run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'mcp__codex-bridge__codex', tool_use_id: `tb${n}`,
    tool_input: { prompt: 'TASK id=B-1 type=review milestone=m attempt=1 pr=9' }, tool_response: text }, p, env);
  const r = bridge(block('reject', 'none'), 1);
  eq(readLog(p, 'reviews.jsonl')[0].verdict_conflict, true, 'precondition: conflict on the row');
  assert(/give a `major` with its exploit path, or an `approve`/.test(context(r)), r.stdout);
  const ok = bridge(block('approve', 'none'), 2);
  eq(context(ok), '', 'consistent: quiet');
});
