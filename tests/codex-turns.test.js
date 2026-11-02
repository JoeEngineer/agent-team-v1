// G11: Codex turns with no completion line. Stub completions on SubagentStop,
// usage-limit interruptions, and reconcile backfilling turns by turn_id.
// Fixtures are synthetic, trimmed copies of the Codex child transcript shape.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, NO_MODELS_FILE, tmpProject, run, readLog, test, assert, eq } = require('./helpers');

const SID = 'sess-1';
const AID = 'agent-1';
const ev = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
const RESULT = 'done\n```result-json\n{"status":"done"}\n```';
const REVIEW = 'ok\n```review-json\n{"verdict":"changes_requested","findings":[]}\n```';

// One child turn: start, context, usage, then an ending.
// end: 'complete' | 'usage_limit' | 'aborted' | 'running'
function turnLines(id, n, end, message) {
  const total = 1000 * n;
  const lines = [
    ev('event_msg', { type: 'task_started', turn_id: id }),
    ev('turn_context', { turn_id: id, model: 'gpt-6.1-terra', effort: 'high' }),
    ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } } }),
  ];
  if (end === 'complete') lines.push(ev('event_msg', { type: 'task_complete', turn_id: id, duration_ms: 500 * n, last_agent_message: message || null }));
  if (end === 'usage_limit') lines.push(ev('event_msg', { type: 'error', message: "You've hit your usage limit. Try again later." }));
  if (end === 'aborted') lines.push(ev('event_msg', { type: 'turn_aborted', reason: 'interrupted' }));
  return lines;
}

function transcript(dir, turns) {
  const lines = [
    ev('session_meta', { id: AID, agent_path: '/root/s3_2_a1', source: { subagent: { thread_spawn: { agent_path: '/root/s3_2_a1' } } } }),
    ev('session_meta', { id: SID, source: 'exec' }),
    // Inherited parent history: a parent turn that must never be logged.
    ev('event_msg', { type: 'task_started', turn_id: 'parent-turn' }),
    ev('turn_context', { turn_id: 'parent-turn', model: 'parent-model', effort: 'low' }),
  ];
  turns.forEach(([end, message], i) => lines.push(...turnLines(`turn-${i + 1}`, i + 1, end, message)));
  const file = path.join(dir, 'child.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const appendTurn = (file, n, end, message) => fs.appendFileSync(file, turnLines(`turn-${n}`, n, end, message).join('\n') + '\n');

function hook(project, input) {
  const r = run('log-delegation.js', { session_id: SID, cwd: project, model: 'gpt-test', ...input }, project);
  eq(r.status, 0, 'hook exit');
}

const stop = (file, turnId, message) => ({
  hook_event_name: 'SubagentStop', agent_id: AID, agent_type: 'reviewer-medium', turn_id: turnId,
  agent_transcript_path: file, last_assistant_message: message,
});

const reconcile = (p, args = []) => spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js'), ...args], {
  encoding: 'utf8', cwd: p,
  env: { ...process.env, CLAUDE_PROJECT_DIR: p, AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_PROJECTS_ROOT: path.join(os.tmpdir(), 'agent-team-no-projects-root') },
});

const pendingCount = (p) => {
  try { return fs.readdirSync(path.join(p, '.agent-team', 'logs', '.pending', 'codex-completions')).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
};

test('codex G11: a stop for a turn cut off by a usage limit writes a missing-report line at once, not a pending wait', () => {
  const p = tmpProject();
  const file = transcript(p, [['complete', RESULT], ['usage_limit']]);
  hook(p, stop(file, 'turn-2', ''));
  const [c] = readLog(p, 'completions.jsonl');
  assert(c, 'completion written');
  eq(c.turn_id, 'turn-2', 'turn id');
  eq(c.report_source, 'missing', 'no report');
  eq(c.interrupted, 'usage_limit', 'interruption');
  eq(c.result, null, 'no result');
  eq(c.resolved_model, 'gpt-6.1-terra', 'turn context still read');
  eq(c.stub, undefined, 'turn was found: not a stub');
  eq(pendingCount(p), 0, 'no snapshot left waiting forever');
});

test('codex G11: an aborted turn is logged as interrupted aborted', () => {
  const p = tmpProject();
  const file = transcript(p, [['aborted']]);
  hook(p, stop(file, 'turn-1', ''));
  eq(readLog(p, 'completions.jsonl')[0].interrupted, 'aborted', 'aborted');
});

test('codex G11: a stop whose turn is not in the transcript writes a stub; reconcile fills it by turn_id, once', () => {
  const p = tmpProject();
  const file = transcript(p, [['complete', RESULT]]);
  hook(p, stop(file, 'turn-1', RESULT));
  hook(p, stop(file, 'turn-2', '')); // final review, transcript not written yet
  let cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 2, 'both turns have a line');
  const stub = cs.find((c) => c.turn_id === 'turn-2');
  eq(stub.stub, true, 'stub');
  eq(stub.report_source, 'missing', 'no report yet');
  eq(stub.task_name, 's3_2_a1', 'task name from the transcript');
  appendTurn(file, 2, 'complete', REVIEW);
  const r = reconcile(p);
  eq(r.status, 0, `exit 0: ${r.stderr}`);
  assert(/1 stub lines filled/.test(r.stdout), `printed: ${r.stdout}`);
  cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 2, 'filled in place, no new line');
  const filled = cs.find((c) => c.turn_id === 'turn-2');
  eq(filled.stub, undefined, 'no longer a stub');
  eq(filled.report_source, 'transcript', 'report from the transcript');
  eq(filled.review.verdict, 'changes_requested', 'verdict recovered');
  eq(filled.duration_ms, 1000, 'duration');
  eq(filled.resolved_effort, 'high', 'effort');
  assert(filled.reconciled_by, 'reconciled_by');
  const reviews = readLog(p, 'reviews.jsonl');
  eq(reviews.length, 1, 'review line written');
  eq(reviews[0].verdict, 'changes_requested', 'review verdict');
  const before = fs.readFileSync(path.join(p, '.agent-team', 'logs', 'completions.jsonl'), 'utf8');
  reconcile(p);
  eq(fs.readFileSync(path.join(p, '.agent-team', 'logs', 'completions.jsonl'), 'utf8'), before, 'second run changes nothing');
  eq(readLog(p, 'reviews.jsonl').length, 1, 'still one review');
});

test('codex G11: reconcile adds lines for turns whose stop never fired (usage limit and a lost verdict), never the parent turn', () => {
  const p = tmpProject();
  const file = transcript(p, [['complete', RESULT], ['complete', REVIEW], ['usage_limit']]);
  hook(p, stop(file, 'turn-1', RESULT)); // only turn 1 reached the hook
  const dry = reconcile(p, ['--dry-run']);
  assert(/2 missing turns added/.test(dry.stdout), `dry run: ${dry.stdout}`);
  eq(readLog(p, 'completions.jsonl').length, 1, 'dry run writes nothing');
  const r = reconcile(p);
  eq(r.status, 0, `exit 0: ${r.stderr}`);
  const cs = readLog(p, 'completions.jsonl');
  eq(cs.map((c) => c.turn_id).join(','), 'turn-1,turn-2,turn-3', 'one line per child turn, no parent turn');
  const t2 = cs[1];
  eq(t2.report_source, 'transcript', 'turn 2 report from task_complete');
  eq(t2.review.verdict, 'changes_requested', 'lost verdict recovered');
  eq(t2.tokens, 1000, 'turn 2 tokens only');
  const t3 = cs[2];
  eq(t3.report_source, 'missing', 'turn 3 had no report');
  eq(t3.interrupted, 'usage_limit', 'usage limit');
  eq(t3.agent, 'reviewer-medium', 'agent type from the raw events');
  eq(readLog(p, 'reviews.jsonl').length, 1, 'review line for turn 2');
  reconcile(p);
  eq(readLog(p, 'completions.jsonl').length, 3, 'second run adds nothing');
  // A late stop for turn 2 dedupes against the backfilled line.
  hook(p, stop(file, 'turn-2', REVIEW));
  eq(readLog(p, 'completions.jsonl').length, 3, 'late stop dedupes by event id');
});

test('codex G11: reconcile leaves a last turn that may still be running, and settles it once a later turn starts', () => {
  const p = tmpProject();
  const file = transcript(p, [['complete', RESULT], ['running']]);
  hook(p, stop(file, 'turn-1', RESULT));
  let r = reconcile(p);
  assert(/1 still running/.test(r.stdout), `printed: ${r.stdout}`);
  eq(readLog(p, 'completions.jsonl').length, 1, 'running turn not logged');
  appendTurn(file, 3, 'complete', RESULT);
  hook(p, stop(file, 'turn-3', RESULT));
  r = reconcile(p);
  const t2 = readLog(p, 'completions.jsonl').find((c) => c.turn_id === 'turn-2');
  eq(t2.interrupted, 'no_task_complete', 'superseded turn marked');
  eq(t2.report_source, 'missing', 'no report');
});
