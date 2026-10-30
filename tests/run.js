#!/usr/bin/env node
// Dependency-free tests for the hook scripts. Run: node tests/run.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
let passed = 0, failed = 0;

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-test-'));
  execFileSync('git', ['init', '-q', '-b', 'task/T-1'], { cwd: dir });
  return dir;
}

function run(script, input, projectDir) {
  return spawnSync('node', [path.join(SCRIPTS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: ROOT },
  });
}

function readLog(projectDir, file) {
  const p = path.join(projectDir, '.agent-team', 'logs', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------- guard
console.log('guard.js');
const gproj = tmpProject();
const guard = (command, cwd = gproj) =>
  run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }, gproj);

const blocked = [
  ['force push', 'git push --force origin task/T-1'],
  ['short force flag', 'git push -f origin task/T-1'],
  ['force-with-lease', 'git push --force-with-lease'],
  ['plus refspec', 'git push origin +task/T-1'],
  ['push to main', 'git push origin main'],
  ['push HEAD:main', 'git push origin HEAD:main'],
  ['push in a chain', 'git add . && git commit -m x && git push origin main'],
  ['git -C push to master', 'git -C ../other push origin master'],
  ['delete milestone branch', 'git push origin --delete milestone/auth'],
  ['merge --admin', 'gh pr merge 12 --admin --squash'],
  ['merge with unverifiable base', 'gh pr merge 999999 --squash'],
  ['change protection', 'gh api -X PUT repos/o/r/branches/main/protection -f x=y'],
  ['rulesets via fields', 'gh api repos/o/r/rulesets -f name=x'],
  ['repo delete', 'gh repo delete o/r --yes'],
  ['release create', 'gh release create v1.0.0'],
  ['powershell-style chain', 'git status; git push origin main'],
];
for (const [name, cmd] of blocked) {
  test(`blocks: ${name}`, () => {
    const r = guard(cmd);
    eq(r.status, 2, `exit code for "${cmd}"`);
    assert(/agent-team guard blocked/.test(r.stderr), 'stderr explains the block');
  });
}

const allowed = [
  ['push task branch', 'git push -u origin task/T-1'],
  ['push current non-protected branch', 'git push'],
  ['push HEAD on task branch', 'git push origin HEAD'],
  ['git status', 'git status'],
  ['read protection', 'gh api repos/o/r/branches/main/protection'],
  ['pr list', 'gh pr list --state open'],
  ['pr view', 'gh pr view 12'],
  ['echo mentioning main', 'echo "git push origin main is blocked"'],
  ['non-git command', 'npm test'],
];
for (const [name, cmd] of allowed) {
  test(`allows: ${name}`, () => {
    const r = guard(cmd);
    eq(r.status, 0, `exit code for "${cmd}" (stderr: ${r.stderr.trim()})`);
  });
}

test('blocks bare push while on main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-main-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const r = run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: dir }, dir);
  eq(r.status, 2, 'exit code');
});

// ---------------------------------------------------------------- logger
console.log('log-delegation.js');

test('subagent: task card, agent-file defaults, result block, duration', () => {
  const proj = tmpProject();
  const prompt = 'TASK id=AUTH-14 type=implement difficulty=medium milestone=auth attempt=1 branch=task/AUTH-14\nWHY sonnet/medium per table\n\nGOAL\n...';
  const ti = { subagent_type: 'agent-team:implementer', description: 'Add login handler', prompt, isolation: 'worktree' };
  run('log-delegation.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: ti, session_id: 's1' }, proj);
  const resp = { content: [{ type: 'text', text: 'Done.\n```result-json\n{"status":"done","summary":"added handler","tests":"pass"}\n```' }], totalTokens: 12345, totalDurationMs: 61000 };
  const r = run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: ti, tool_response: resp, session_id: 's1' }, proj);
  eq(r.status, 0, 'exit code');
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.kind, 'subagent', 'kind');
  eq(rec.model, 'sonnet', 'model from agent file');
  eq(rec.model_source, 'agent-file', 'model source');
  eq(rec.effort, 'medium', 'effort from agent file');
  eq(rec.task.id, 'AUTH-14', 'task id');
  eq(rec.task.attempt, 1, 'attempt is a number');
  eq(rec.task.why, 'sonnet/medium per table', 'why');
  eq(rec.result.status, 'done', 'result parsed');
  eq(rec.tokens, 12345, 'tokens');
  eq(rec.duration_ms, 61000, 'duration from response wins');
  eq(rec.guidance_version, JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version, 'guidance version');
});

test('subagent: overrides recorded as override; duration from pre/post', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'agent-team:implementer', model: 'opus', effort: 'high', prompt: 'TASK id=A-2 type=fix difficulty=hard milestone=a attempt=3\nWHY ladder step 3' };
  run('log-delegation.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_2', tool_input: ti }, proj);
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu_2', tool_input: ti, tool_response: 'ok' }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.model, 'opus', 'model');
  eq(rec.model_source, 'override', 'model source');
  eq(rec.effort_source, 'override', 'effort source');
  assert(typeof rec.duration_ms === 'number', 'duration measured from pre/post');
  assert(!fs.existsSync(path.join(proj, '.agent-team', 'logs', '.pending', 'tu_2.json')), 'pending file cleaned up');
});

test('subagent: unknown agent type is logged as inherited', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'general-purpose', prompt: 'no card' };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: 'x' }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.model, 'inherited', 'model');
  eq(Object.keys(rec.task).length, 0, 'empty task card');
});

test('reviewer verdict goes to reviews.jsonl', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'agent-team:reviewer', prompt: 'TASK id=AUTH-14 type=review difficulty=medium milestone=auth attempt=1 pr=212\nWHY standard review' };
  const text = 'Findings...\n```review-json\n{"verdict":"changes_requested","severity":"major","issues":["missing-tests","error-handling"],"tests_run":true,"tests_passed":true,"criteria_met":"some","summary":"needs tests"}\n```';
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: text }, proj);
  const [rev] = readLog(proj, 'reviews.jsonl');
  eq(rev.task_id, 'AUTH-14', 'task id');
  eq(rev.pr, '212', 'pr');
  eq(rev.verdict, 'changes_requested', 'verdict');
  eq(rev.reviewer_model, 'sonnet', 'reviewer model');
  eq(rev.reviewer_effort, 'high', 'reviewer effort');
  eq(rev.issues.length, 2, 'issues');
});

test('background subagent: no result parsed', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'agent-team:scout', run_in_background: true, prompt: 'TASK id=R-1 type=research difficulty=easy milestone=a attempt=1' };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: ti, tool_response: 'launched' }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.background, true, 'background');
  assert(!('result' in rec), 'no result field');
  eq(rec.model, 'haiku', 'scout model');
});

// Shapes below match what Claude Code 2.1.314 produced in a live run.
function writeSubagentTranscript(dir, agentId, prompt, finalText, model = 'claude-haiku-5-5') {
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 100 };
  const lines = [
    { type: 'user', timestamp: '2026-10-30T18:33:35.000Z', message: { role: 'user', content: prompt } },
    { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'ignore me' }] } },
    { type: 'assistant', timestamp: '2026-10-30T18:33:37.000Z', message: { id: 'msg_1', model, usage, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: '2026-10-30T18:33:38.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', timestamp: '2026-10-30T18:33:40.000Z', message: { id: 'msg_2', model, usage, content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', timestamp: '2026-10-30T18:33:41.000Z', message: { id: 'msg_2', model, usage, content: [{ type: 'text', text: finalText }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-team:reviewer', toolUseId: 'toolu_X', requestShape: 'background' }));
  return file;
}

test('async launch: agent id and resolved model logged, no result', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'agent-team:scout', prompt: 'TASK id=LIVE-1 type=research difficulty=easy milestone=live attempt=1' };
  const resp = { isAsync: true, status: 'async_launched', agentId: 'a1', resolvedModel: 'claude-haiku-5-5', description: 'x' };
  run('log-delegation.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_a', tool_input: ti }, proj);
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu_a', tool_input: ti, tool_response: resp }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.background, true, 'detected as background without run_in_background');
  eq(rec.agent_id, 'a1', 'agent id');
  eq(rec.resolved_model, 'claude-haiku-5-5', 'resolved model');
  assert(!('result' in rec) && !('duration_ms' in rec), 'no result or duration on launch');
  assert(typeof rec.launch_ms === 'number', 'launch time recorded');
});

test('SubagentStop: completion linked to delegation, tokens and duration, review logged once', () => {
  const proj = tmpProject();
  const ti = { subagent_type: 'agent-team:reviewer', effort: 'high', prompt: 'TASK id=AUTH-14 type=review difficulty=medium milestone=auth attempt=2 pr=212\nWHY review' };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_X', tool_input: ti, tool_response: { isAsync: true, status: 'async_launched', agentId: 'r1', resolvedModel: 'claude-sonnet-5-5' } }, proj);
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tx-'));
  const final = 'Findings.\n```review-json\n{"verdict":"approve","severity":"none","issues":[],"tests_run":true,"tests_passed":true,"criteria_met":"all","summary":"ok"}\n```';
  const tPath = writeSubagentTranscript(tdir, 'r1', ti.prompt, final, 'claude-sonnet-5-5');
  const stop = { hook_event_name: 'SubagentStop', agent_id: 'r1', agent_type: 'agent-team:reviewer', agent_transcript_path: tPath };
  run('log-delegation.js', stop, proj);
  run('log-delegation.js', stop, proj); // duplicate stop must not double-log the review
  const [c] = readLog(proj, 'completions.jsonl');
  eq(c.agent_id, 'r1', 'agent id');
  eq(c.tool_use_id, 'toolu_X', 'tool use id from meta');
  eq(c.task.id, 'AUTH-14', 'task from delegation');
  eq(c.effort, 'high', 'effort from delegation override');
  eq(c.resolved_model, 'claude-sonnet-5-5', 'model from transcript');
  eq(c.tokens_with_cache, 2 * 1602, 'tokens counted once per message id');
  eq(c.duration_ms, 6000, 'duration from first prompt to last assistant entry');
  eq(c.review.verdict, 'approve', 'review parsed from split message');
  const reviews = readLog(proj, 'reviews.jsonl');
  eq(reviews.length, 1, 'review logged once');
  eq(reviews[0].task_id, 'AUTH-14', 'review task id');
  eq(reviews[0].reviewer_model, 'claude-sonnet-5-5', 'reviewer model');
  eq(reviews[0].reviewer_effort, 'high', 'reviewer effort');
});

test('SubagentStop without a delegation record falls back to transcript task card', () => {
  const proj = tmpProject();
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tx-'));
  const tPath = writeSubagentTranscript(tdir, 's9', 'TASK id=Z-1 type=research difficulty=easy milestone=z attempt=1\nWHY w', 'done\n```result-json\n{"status":"done"}\n```');
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_type: 'agent-team:scout', agent_transcript_path: tPath }, proj);
  const [c] = readLog(proj, 'completions.jsonl');
  eq(c.agent_id, 's9', 'agent id from file name');
  eq(c.task.id, 'Z-1', 'task from transcript');
  eq(c.model, 'haiku', 'model from agent file');
  eq(c.result.status, 'done', 'result');
});

test('session start logged with child session id', () => {
  const proj = tmpProject();
  const ti = { title: 'Auth API', initiation: 'user_asked', model: 'sonnet', use_worktree: true, prompt: 'TASK id=AUTH-2 type=implement difficulty=hard milestone=auth attempt=1\nWHY hard -> session' };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_session__start_session', tool_input: ti, tool_response: 'Started session local_abc123 (name: auth-api)' }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.kind, 'session', 'kind');
  eq(rec.child_session, 'local_abc123', 'child session id');
  eq(rec.task.id, 'AUTH-2', 'task id');
});

test('bridge call logged', () => {
  const proj = tmpProject();
  const ti = { prompt: 'TASK id=X-1 type=test difficulty=easy milestone=x attempt=1\nWHY trial codex' };
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'mcp__codex-bridge__codex_run', tool_input: ti, tool_response: 'done' }, proj);
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.kind, 'bridge', 'kind');
  eq(rec.agent, 'codex-bridge', 'agent');
});

test('runway check is not logged as a delegation', () => {
  const proj = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'mcp__codex-bridge__check_runway', tool_input: {}, tool_response: '{}' }, proj);
  eq(readLog(proj, 'delegations.jsonl').length, 0, 'no records');
});

test('gh pr merge logged to merges.jsonl', () => {
  const proj = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 212 --squash --delete-branch' }, tool_response: { stdout: 'Squashed and merged pull request #212' } }, proj);
  const [m] = readLog(proj, 'merges.jsonl');
  eq(m.pr, '212', 'pr');
  eq(m.outcome, 'merged', 'outcome');
});

test('other shell commands are ignored', () => {
  const proj = tmpProject();
  run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'ok' }, proj);
  eq(readLog(proj, 'merges.jsonl').length, 0, 'no merge records');
});

test('garbage input never fails the hook', () => {
  const proj = tmpProject();
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-delegation.js')], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  eq(r.status, 0, 'exit code');
});

// ---------------------------------------------------------------- log-event
console.log('log-event.js');

test('decision event appended', () => {
  const proj = tmpProject();
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'decision', '{"id":"0007","model":"opus","effort":"high"}'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  eq(r.status, 0, 'exit code');
  const [d] = readLog(proj, 'decisions.jsonl');
  eq(d.id, '0007', 'id');
  assert(d.guidance_version, 'has guidance version');
});

test('unknown kind rejected', () => {
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'bogus', '{}'], { encoding: 'utf8' });
  eq(r.status, 1, 'exit code');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
