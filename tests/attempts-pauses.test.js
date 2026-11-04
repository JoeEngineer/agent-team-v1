// Attempt settings on the card (effort=, reason=), uncarded delegations,
// pause end times, and Codex turns that ended with an error. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, NO_MODELS_FILE, tmpProject, run, readLog, test, assert, eq } = require('./helpers');
const codexLog = require(path.join(SCRIPTS, 'codex-log.js'));

console.log('attempts-pauses');

function logEvent(proj, kind, json, env = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), kind, '-'], {
    input: JSON.stringify(json), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, ...env },
  });
}
const context = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
const spawnAgent = (proj, prompt, ti = {}, tu = 'tu-1') => run('log-delegation.js', {
  hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { prompt, subagent_type: 'agent-team:implementer', ...ti }, tool_response: { agentId: 'ag-1' },
}, proj);
const sendMessage = (proj, message) => run('log-delegation.js', {
  hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_use_id: 'tu-sm',
  tool_input: { to: 'ag-1', message }, tool_response: {},
}, proj);
const writeLog = (proj, file, rows) => {
  const dir = path.join(proj, '.agent-team', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// Card settings

test('spawn: card effort differing from the spawn effort adds effort_mismatch and tells the Director', () => {
  const proj = tmpProject();
  const r = spawnAgent(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=1 effort=high');
  const [d] = readLog(proj, 'delegations.jsonl');
  eq(d.effort, 'medium', 'precondition: the implementer default effort ran');
  eq(JSON.stringify(d.effort_mismatch), JSON.stringify({ card: 'high', ran: 'medium' }), 'effort_mismatch');
  eq(context(r), 'agent-team: task card says effort high but the spawn ran effort medium', 'context');
  const ok = spawnAgent(proj, 'TASK id=E-2 type=implement difficulty=easy milestone=m attempt=1 effort=high', { effort: 'high' }, 'tu-2');
  eq(context(ok), '', 'matching override: no message');
  assert(!('effort_mismatch' in readLog(proj, 'delegations.jsonl')[1]), 'no field when it matches');
});

test('resume: a card asking for new effort is flagged, since a resume keeps the agent\'s settings', () => {
  const proj = tmpProject();
  spawnAgent(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=1');
  const r = sendMessage(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=2 effort=high reason=escalation\nfix it');
  const rows = readLog(proj, 'delegations.jsonl');
  eq(rows[1].kind, 'resume', 'precondition: logged as a resume');
  eq(JSON.stringify(rows[1].effort_mismatch), JSON.stringify({ card: 'high', ran: 'medium' }), 'effort_mismatch');
  eq(rows[1].task.reason, 'escalation', 'reason parsed onto the task');
  assert(/a resume keeps the agent's effort medium. To change tier or effort, spawn a new agent/.test(context(r)), context(r));
});

test('resume: reason=escalation with no new settings on the card is flagged; a sendback is not', () => {
  const proj = tmpProject();
  spawnAgent(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=1');
  const esc = sendMessage(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=2 reason=escalation');
  assert(/escalation sent as a resume/.test(context(esc)), context(esc));
  const back = sendMessage(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=3 reason=sendback');
  eq(context(back), '', 'sendback at the same settings: no message');
});

test('reason: an unknown value is flagged with the allowed list', () => {
  const proj = tmpProject();
  const r = spawnAgent(proj, 'TASK id=E-1 type=implement difficulty=easy milestone=m attempt=2 reason=oops');
  assert(/reason=oops; use one of sendback, escalation, fold-in, retry/.test(context(r)), context(r));
});

test('uncarded: a role agent with no TASK line is marked and the Director is told; other agents are not', () => {
  const proj = tmpProject();
  const r = spawnAgent(proj, 'Fix the plugin hook, please.');
  const [d] = readLog(proj, 'delegations.jsonl');
  eq(d.uncarded, true, 'uncarded');
  assert(/has no TASK line/.test(context(r)), context(r));
  const gp = spawnAgent(proj, 'Look around.', { subagent_type: 'Explore' }, 'tu-2');
  eq(context(gp), '', 'non-role agent: no message');
  assert(!('uncarded' in readLog(proj, 'delegations.jsonl')[1]), 'non-role agent: no field');
});

test('log-event delegation (Codex): resume with new effort and an uncarded line both warn', () => {
  const proj = tmpProject();
  eq(logEvent(proj, 'delegation', { card: 'TASK id=C-1 type=implement difficulty=medium milestone=m attempt=1', tool: 'codex', task_name: 'c_1_a1', effort: 'medium' }).status, 0, 'spawn line');
  const r = logEvent(proj, 'delegation', { card: 'TASK id=C-1 type=implement difficulty=medium milestone=m attempt=2 effort=high reason=escalation', tool: 'codex', kind: 'resume', task_name: 'c_1_a1' });
  eq(r.status, 0, r.stderr);
  assert(/a resume keeps the agent's effort medium/.test(r.stderr), r.stderr);
  const u = logEvent(proj, 'delegation', { tool: 'codex', task_name: 'side_fix', effort: 'low' });
  assert(/has no TASK line/.test(u.stderr), u.stderr);
  const rows = readLog(proj, 'delegations.jsonl');
  eq(JSON.stringify(rows[1].effort_mismatch), JSON.stringify({ card: 'high', ran: 'medium' }), 'resume effort_mismatch');
  eq(rows[2].uncarded, true, 'uncarded line marked');
});

// Pauses

test('pause: closed by the next delegation with duration and milestone; a later delegation adds nothing', () => {
  const proj = tmpProject();
  writeLog(proj, 'delegations.jsonl', [{ kind: 'subagent', task: { id: 'P-1', milestone: 'pm' } }]);
  eq(logEvent(proj, 'pause', { reason: 'runway' }).status, 0, 'pause');
  const before = readLog(proj, 'pauses.jsonl');
  eq(before.length, 1, 'precondition: one open pause');
  eq(before[0].milestone, 'pm', 'milestone from the latest delegation');
  eq(before[0].milestone_source, 'latest-delegation', 'milestone source');
  const pre = (tu) => run('log-delegation.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: tu, tool_input: {} }, proj);
  eq(pre('tu-a').status, 0, 'pre hook');
  const after = readLog(proj, 'pauses.jsonl');
  eq(after.length, 2, 'resume line added');
  eq(after[1].kind, 'resume', 'kind');
  eq(after[1].closed_by, 'delegation', 'closed_by');
  eq(after[1].paused_ts, before[0].ts, 'paused_ts');
  eq(after[1].reason, 'runway', 'reason carried');
  eq(after[1].milestone, 'pm', 'milestone carried');
  assert(Number.isFinite(after[1].duration_ms) && after[1].duration_ms >= 0, 'duration');
  pre('tu-b');
  eq(readLog(proj, 'pauses.jsonl').length, 2, 'no second resume');
});

test('pause: a Codex spawn_agent closes the open pause', () => {
  const proj = tmpProject();
  eq(logEvent(proj, 'pause', { reason: 'usage_limit' }).status, 0, 'pause');
  eq(readLog(proj, 'pauses.jsonl').length, 1, 'precondition: open pause');
  const r = run('log-delegation.js', {
    session_id: 's', turn_id: 't', cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'collaborationspawn_agent',
    tool_input: { agent_type: 'implementer-medium', task_name: 'x_1_a1' }, tool_response: '{}', tool_use_id: 'c1',
  }, proj);
  eq(r.status, 0, 'hook exit');
  const rows = readLog(proj, 'pauses.jsonl');
  eq(rows.length, 2, 'resume written');
  eq(rows[1].closed_by, 'delegation', 'closed_by');
  eq(readLog(proj, 'delegations.jsonl')[0].tool, 'codex', 'precondition: handled as Codex');
});

test('pause: the user\'s next prompt closes a user pause but not a runway pause', () => {
  const proj = tmpProject();
  const prompt = () => run('user-prompt.js', { hook_event_name: 'UserPromptSubmit', prompt: 'go on' }, proj);
  eq(logEvent(proj, 'pause', { reason: 'runway' }).status, 0, 'runway pause');
  eq(prompt().status, 0, 'hook exit');
  eq(readLog(proj, 'pauses.jsonl').length, 1, 'runway pause still open');
  eq(logEvent(proj, 'pause', { reason: 'user' }).status, 0, 'user pause (closes the runway one)');
  eq(readLog(proj, 'pauses.jsonl').length, 3, 'precondition: pause, resume, pause');
  prompt();
  const rows = readLog(proj, 'pauses.jsonl');
  eq(rows.length, 4, 'user pause closed');
  eq(rows[3].closed_by, 'user_prompt', 'closed_by');
  eq(rows[3].reason, 'user', 'reason');
});

test('log-event resume: closes the open pause once; with none open it writes nothing', () => {
  const proj = tmpProject();
  eq(logEvent(proj, 'pause', { reason: 'user', milestone: 'x' }).status, 0, 'pause');
  const r = logEvent(proj, 'resume', { note: 'back' });
  eq(r.status, 0, r.stderr);
  const rows = readLog(proj, 'pauses.jsonl');
  eq(rows[1].kind, 'resume', 'resume line');
  eq(rows[1].closed_by, 'director', 'closed_by');
  eq(rows[1].note, 'back', 'note');
  const again = logEvent(proj, 'resume', {});
  eq(again.status, 0, 'exit 0');
  assert(/no open pause/.test(again.stdout), again.stdout);
  eq(readLog(proj, 'pauses.jsonl').length, 2, 'nothing more written');
  assert(!fs.existsSync(path.join(proj, '.agent-team', 'logs', 'resumes.jsonl')), 'no resumes.jsonl');
});

// Codex turns that ended with an error

function codexTranscript(error) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-cx-'));
  const file = path.join(dir, 'rollout.jsonl');
  const ev = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
  fs.writeFileSync(file, [
    ev('session_meta', { id: 'a', agent_path: '/root/r_1_a1' }),
    ev('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    ev('turn_context', { turn_id: 'turn-1', model: 'gpt-6.1-sol', effort: 'high' }),
    ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 } } }),
    ev('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, ...(error ? { error } : {}), duration_ms: 246800 }),
  ].join('\n') + '\n');
  return file;
}

test('codex: a task_complete carrying an error is an interrupted turn, classed by codex_error_info', () => {
  const cases = [
    [{ message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }, 'server_overloaded'],
    [{ message: 'You have hit your usage limit.', codex_error_info: 'usage_limit_exceeded' }, 'usage_limit'],
    [{ message: 'something else' }, 'error'],
  ];
  for (const [error, want] of cases) {
    const t = codexLog.readTranscript(codexTranscript(error), 'turn-1');
    eq(t.complete, true, `${want}: precondition: task_complete seen`);
    eq(t.interrupted, want, `${want}: interrupted`);
    eq(t.duration_ms, 246800, `${want}: duration kept`);
    const rec = codexLog.fillFromTranscript({ report_source: 'missing', turn_id: 'turn-1' }, t);
    eq(rec.interrupted, want, `${want}: on the record`);
    eq(rec.interruption_message, error.message, `${want}: message on the record`);
  }
  const ok = codexLog.readTranscript(codexTranscript(null), 'turn-1');
  eq(ok.interrupted, null, 'a normal task_complete is not interrupted');
});
