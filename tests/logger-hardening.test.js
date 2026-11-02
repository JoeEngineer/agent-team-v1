// G12 decision ids and resolved model/effort, G13 task card drift and
// followups, G14 merge commands without local paths. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, SCRIPTS, NO_MODELS_FILE, tmpProject, run, fakeGh, readLog, test, assert, eq } = require('./helpers');
const records = require(path.join(SCRIPTS, 'records.js'));

function logEvent(project, kind, data, env = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), kind, '-'], {
    input: JSON.stringify(data), cwd: project, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_TOOL: '', ...env },
  });
}

const logsDir = (p) => {
  const d = path.join(p, '.agent-team', 'logs');
  fs.mkdirSync(path.join(d, '.pending'), { recursive: true });
  return d;
};

// --- G12 ----------------------------------------------------------------------

test('G12: a duplicate decision id is rejected with the next free id, nothing written', () => {
  const p = tmpProject();
  eq(logEvent(p, 'decision', { id: '0004', title: 'first', model: 'claude-opus-5-5', effort: 'high' }).status, 0, 'first');
  const r = logEvent(p, 'decision', { id: '0004', title: 'second', model: 'claude-opus-5-5', effort: 'high' });
  eq(r.status, 1, 'duplicate rejected');
  assert(/duplicate decision id 0004/.test(r.stderr) && /next free id is 0005/.test(r.stderr), `message: ${r.stderr}`);
  eq(readLog(p, 'decisions.jsonl').length, 1, 'one line');
  eq(logEvent(p, 'decision', { id: '0005', title: 'second', model: 'claude-opus-5-5', effort: 'high' }).status, 0, 'next id accepted');
});

test('G12: on Codex a family name and "unknown" effort are filled from the session transcript', () => {
  const p = tmpProject();
  const dir = logsDir(p);
  const parent = path.join(p, 'parent.jsonl');
  fs.writeFileSync(parent, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-terra', effort: 'low' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-terra', effort: 'xhigh' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'codex-events.jsonl'), JSON.stringify({ tool: 'codex', hook_event_name: 'PostToolUse', model: 'gpt-6.1-terra', transcript_path: parent }) + '\n');
  eq(logEvent(p, 'decision', { id: '0001', title: 't', model: 'GPT-6', effort: 'unknown' }, { AGENT_TEAM_TOOL: 'codex' }).status, 0, 'logged');
  const [d] = readLog(p, 'decisions.jsonl');
  eq(d.model, 'gpt-6.1-terra', 'resolved model');
  eq(d.model_given, 'GPT-6', 'text given kept');
  eq(d.model_source, 'session', 'source');
  eq(d.effort, 'xhigh', 'latest effort');
  assert(!JSON.stringify(d).includes(p), 'no local path in the line');
});

test('G12: on Claude the model comes from the SessionStart marker; an unrelated model id is kept', () => {
  const p = tmpProject();
  const dir = logsDir(p);
  const r = run('session-start.js', { session_id: 's', model: 'claude-opus-5-5', hook_event_name: 'SessionStart' }, p);
  eq(r.status, 0, 'session start');
  eq(JSON.parse(fs.readFileSync(path.join(dir, '.pending', 'hooks-alive.json'), 'utf8')).model, 'claude-opus-5-5', 'marker model');
  logEvent(p, 'decision', { id: '0001', model: 'Opus', effort: 'high' }, { AGENT_TEAM_TOOL: 'claude' });
  logEvent(p, 'decision', { id: '0002', model: 'claude-sonnet-5-5', effort: 'high' }, { AGENT_TEAM_TOOL: 'claude' });
  logEvent(p, 'decision', { id: '0003' }, { AGENT_TEAM_TOOL: 'claude' });
  const [a, b, c] = readLog(p, 'decisions.jsonl');
  eq(a.model, 'claude-opus-5-5', 'family name resolved');
  eq(a.model_given, 'Opus', 'given kept');
  eq(b.model, 'claude-sonnet-5-5', 'a different model id is not replaced');
  eq(b.model_given, undefined, 'no model_given');
  eq(c.model, 'claude-opus-5-5', 'missing model filled');
  eq(c.effort, null, 'unknown effort is null, not "unknown"');
});

test('G4/G6 gaps: pause takes usage_limit; a manual merge line gets its milestone from base', () => {
  const p = tmpProject();
  eq(logEvent(p, 'pause', { reason: 'usage_limit', until: '2026-11-01T17:00:00Z' }).status, 0, 'usage_limit pause');
  eq(logEvent(p, 'pause', { reason: 'lunch' }).status, 1, 'other reasons still rejected');
  eq(logEvent(p, 'merge', { pr: '5', base: 'milestone/s3-sync' }).status, 0, 'merge');
  eq(readLog(p, 'merges.jsonl')[0].milestone, 's3-sync', 'milestone from base');
});

// --- G13 ----------------------------------------------------------------------

const card = (attempt, type, difficulty) => `TASK id=S3-2 type=${type} difficulty=${difficulty} milestone=s3 attempt=${attempt}\nWHY test`;

test('G13: a retry that changes type or difficulty is logged with card_drift and a warning', () => {
  const p = tmpProject();
  eq(logEvent(p, 'delegation', { card: card(1, 'test', 'hard'), tool: 'codex', task_name: 's3_2_a1' }).stderr, '', 'first: no warning');
  const r = logEvent(p, 'delegation', { card: card(2, 'fix', 'medium'), tool: 'codex', task_name: 's3_2_a2' });
  eq(r.status, 0, 'still logged');
  assert(/type test -> fix and difficulty hard -> medium/.test(r.stderr), `warning: ${r.stderr}`);
  const ds = readLog(p, 'delegations.jsonl');
  eq(ds[1].card_drift.type.from, 'test', 'drift recorded');
  eq(ds[1].card_drift.difficulty.to, 'medium', 'difficulty drift');
  eq(ds[0].card_drift, undefined, 'first line clean');
  eq(logEvent(p, 'delegation', { card: card(3, 'test', 'hard'), tool: 'codex', kind: 'resume', task_name: 's3_2_a2' }).stderr, '', 'same card as attempt 1: no warning');
});

test('G13: kind followup is accepted, not compared, and warned when it bumps the attempt; bad kinds rejected', () => {
  const p = tmpProject();
  logEvent(p, 'delegation', { card: card(1, 'implement', 'medium'), tool: 'codex', task_name: 's3_2_a1' });
  const ok = logEvent(p, 'delegation', { card: card(1, 'docs', 'easy'), tool: 'codex', kind: 'followup', task_name: 's3_2_a1' });
  eq(ok.status, 0, 'followup logged');
  eq(ok.stderr, '', 'followup: no drift warning');
  const bump = logEvent(p, 'delegation', { card: card(2, 'implement', 'medium'), tool: 'codex', kind: 'followup', task_name: 's3_2_a1' });
  assert(/followup keeps the attempt/.test(bump.stderr), `bump warning: ${bump.stderr}`);
  const ds = readLog(p, 'delegations.jsonl');
  eq(ds[1].kind, 'followup', 'kind kept');
  eq(ds[1].card_drift, undefined, 'no drift on a followup');
  eq(logEvent(p, 'delegation', { card: card(2, 'implement', 'medium'), kind: 'retry' }).status, 1, 'unknown kind rejected');
});

test('G13: the Claude hook flags drift on a SendMessage retry and logs kind=followup from the TASK line', () => {
  const p = tmpProject();
  const env = { AGENT_TEAM_MODELS: NO_MODELS_FILE };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_1',
    tool_input: { subagent_type: 'agent-team:implementer', prompt: card(1, 'implement', 'medium') }, tool_response: { agentId: 'a1', status: 'async_launched' } }, p, env);
  const r = run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'SendMessage', tool_use_id: 'toolu_2',
    tool_input: { to: 'a1', message: card(2, 'fix', 'medium') } }, p, env);
  assert(/type implement -> fix/.test(r.stdout), `context to the Director: ${r.stdout}`);
  run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'SendMessage', tool_use_id: 'toolu_3',
    tool_input: { to: 'a1', message: card(2, 'docs', 'easy').replace('TASK ', 'TASK kind=followup ') } }, p, env);
  const ds = readLog(p, 'delegations.jsonl');
  eq(ds[1].kind, 'resume', 'retry');
  eq(ds[1].card_drift.type.to, 'fix', 'drift on the retry');
  eq(ds[2].kind, 'followup', 'followup from the TASK line');
  eq(ds[2].card_drift, undefined, 'followup not compared');
});

// --- G14 ----------------------------------------------------------------------

test('G14: sanitizeCommand drops leading cd segments and absolute local paths', () => {
  const cases = [
    [String.raw`cd C:\Users\someone\s3-sync; gh pr merge 5 --squash`, 'gh pr merge 5 --squash'],
    ['cd "/Users/x/my proj" && gh pr merge 5', 'gh pr merge 5'],
    ['Set-Location C:/Users/x/p; gh pr merge 3', 'gh pr merge 3'],
    ['pushd ~/src/p && cd sub && gh pr merge 2', 'gh pr merge 2'],
    ['gh pr merge 7 --body-file /home/x/b.md', 'gh pr merge 7 --body-file <path>'],
    [String.raw`git -C "C:\Users\x\a b" pull; gh pr merge 9`, 'git -C <path> pull; gh pr merge 9'],
    ['gh pr merge https://github.com/o/r/pull/4 -R o/r --body "fixes a/b"', 'gh pr merge https://github.com/o/r/pull/4 -R o/r --body "fixes a/b"'],
  ];
  for (const [input, want] of cases) eq(records.sanitizeCommand(input), want, input);
});

test('G14: a hook merge line stores the command without the cd prefix or local path', () => {
  const p = tmpProject();
  const cmd = `cd ${p} && gh pr merge 12 --squash --delete-branch`;
  const r = run('log-delegation.js', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: '' }, p,
    fakeGh('{"number":12,"state":"MERGED","baseRefName":"milestone/s3"}'));
  eq(r.status, 0, 'hook');
  const [m] = readLog(p, 'merges.jsonl');
  eq(m.command, 'gh pr merge 12 --squash --delete-branch', 'clean command');
  eq(m.milestone, 's3', 'milestone kept');
  eq(m.outcome, 'merged', 'outcome');
  // log-event merge lines are cleaned the same way
  logEvent(p, 'merge', { pr: '13', command: `cd ${p}; gh pr merge 13` });
  eq(readLog(p, 'merges.jsonl')[1].command, 'gh pr merge 13', 'manual line cleaned');
});
