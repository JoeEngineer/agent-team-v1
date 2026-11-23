// scripts/log-event.js: the session id on the lines it writes (G17). The session
// is CLAUDE_CODE_SESSION_ID when the shell has it, else the SessionStart marker's
// session_id, and session_source says which. Loaded and run by tests/run.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, NO_MODELS_FILE, test, assert, eq, tmpProject, readLog } = require('./helpers');

console.log('log-event session');

// The spawn env is built here, so a CLAUDE_CODE_SESSION_ID set in the runner's
// own shell never leaks into a case that means "no env var".
function logEvent(project, kind, data, env = {}) {
  const base = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_TOOL: 'claude' };
  delete base.CLAUDE_CODE_SESSION_ID;
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), kind, JSON.stringify(data)], {
    cwd: project, encoding: 'utf8', env: { ...base, ...env },
  });
}

// A project whose SessionStart marker names session A (as the last session to start would leave it).
function projectWithMarker(sessionId = 'sess-A', tool = 'claude') {
  const p = tmpProject();
  const pending = path.join(p, '.agent-team', 'logs', '.pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'hooks-alive.json'), JSON.stringify({ tool, session_id: sessionId }));
  return p;
}

test('log-event: CLAUDE_CODE_SESSION_ID (session B) beats the marker (session A) on a merge line and says env', () => {
  const p = projectWithMarker('sess-A');
  const r = logEvent(p, 'merge', { pr: '7', outcome: 'merged', task: 'AUTH-3' }, { CLAUDE_CODE_SESSION_ID: 'sess-B' });
  eq(r.status, 0, r.stderr);
  const m = readLog(p, 'merges.jsonl');
  eq(m.length, 1, 'one merge line: the precondition (a line was written) holds');
  eq(m[0].session_id, 'sess-B', 'session from the env, not the marker');
  eq(m[0].session_source, 'env', 'session source');
});

test('log-event: with no env var the marker (session A) is used and says marker', () => {
  const p = projectWithMarker('sess-A');
  const r = logEvent(p, 'merge', { pr: '7', outcome: 'merged' });
  eq(r.status, 0, r.stderr);
  const m = readLog(p, 'merges.jsonl');
  eq(m.length, 1, 'one merge line: the precondition holds');
  eq(m[0].session_id, 'sess-A', 'session from the marker');
  eq(m[0].session_source, 'marker', 'session source');
});

test('log-event: an empty CLAUDE_CODE_SESSION_ID counts as unset and the marker is used', () => {
  const p = projectWithMarker('sess-A');
  const r = logEvent(p, 'note', { text: 'hi' }, { CLAUDE_CODE_SESSION_ID: '' });
  eq(r.status, 0, r.stderr);
  const n = readLog(p, 'notes.jsonl');
  eq(n.length, 1, 'one note line: the precondition holds');
  eq(n[0].session_id, 'sess-A', 'session from the marker');
  eq(n[0].session_source, 'marker', 'session source');
});

test('log-event: no marker and no env var gives a null session id with source marker', () => {
  const p = tmpProject();
  const r = logEvent(p, 'note', { text: 'hi' });
  eq(r.status, 0, r.stderr);
  const n = readLog(p, 'notes.jsonl');
  eq(n.length, 1, 'one note line: the precondition holds');
  assert(n[0].session_id === null, 'session id is null');
  eq(n[0].session_source, 'marker', 'session source');
});

test('log-event: a delegation line takes the env session (B) over the marker (A)', () => {
  const p = projectWithMarker('sess-A');
  const r = logEvent(p, 'delegation', { card: 'TASK id=X-1 type=implement attempt=1 tier=small', task_name: 'x_1_a1', agent: 'implementer-small', tool: 'claude' }, { CLAUDE_CODE_SESSION_ID: 'sess-B' });
  eq(r.status, 0, r.stderr);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one delegation line: the precondition holds');
  eq(d[0].session_id, 'sess-B', 'session from the env');
  eq(d[0].session_source, 'env', 'session source');
});

test('log-event: a delegation line with no env var takes the marker and says marker (Codex)', () => {
  const p = projectWithMarker('sess-A', 'codex');
  const r = logEvent(p, 'delegation', { card: 'TASK id=X-1 type=implement attempt=1 tier=small', task_name: 'x_1_a1', agent: 'implementer-small', tool: 'codex' });
  eq(r.status, 0, r.stderr);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one delegation line: the precondition holds');
  eq(d[0].session_id, 'sess-A', 'session from the marker (Codex path)');
  eq(d[0].session_source, 'marker', 'session source');
});

test('log-event: a review line takes the env session (B) over the marker (A)', () => {
  const p = projectWithMarker('sess-A');
  const r = logEvent(p, 'review', { card: 'TASK id=X-2 type=review reviewed_task=X-1 pr=9 attempt=1', verdict: 'approve', agent_id: 'r1' }, { CLAUDE_CODE_SESSION_ID: 'sess-B' });
  eq(r.status, 0, r.stderr);
  const v = readLog(p, 'reviews.jsonl');
  eq(v.length, 1, 'one review line: the precondition holds');
  eq(v[0].session_id, 'sess-B', 'session from the env');
});
