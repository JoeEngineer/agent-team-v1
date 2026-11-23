// FU-18: symlinked logs are not appended to; ids from log lines are not trusted as paths.
// Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, tmpProject, test, assert, eq } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu18-'));
const U = (input, output, cacheRead, cacheWrite) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const logsOf = (p) => path.join(p, '.agent-team', 'logs');
const readLive = (p, f) => {
  try { return fs.readFileSync(path.join(logsOf(p), f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// A turn handed back, then a later turn the hook never saw: the archive supersedes the completion line.
const transcript = () => [
  { type: 'user', isMeta: false, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'TASK id=AU-1 type=implement difficulty=easy milestone=m1 attempt=1' } },
  { type: 'assistant', timestamp: '2026-11-01T10:00:05.000Z', message: { id: 'n0', model: 'claude-sonnet-5-5', usage: U(10, 20, 100, 5), content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'done' } }] } },
  { type: 'assistant', timestamp: '2026-11-01T10:01:05.000Z', message: { id: 'n1', model: 'claude-sonnet-5-5', usage: U(5, 50, 200, 0), content: [{ type: 'text', text: 'woken' }] } },
];

// Returns { p, root, env }: a project with one delegation and completion for session dir-1, and a projects root.
function setup({ agentId = 'ag-dir-1', withDirector = true, withAgent = true } = {}) {
  const root = path.join(tmp(), 'root'); // nested, so the root's parent is a fresh directory of ours
  const folder = path.join(root, 'proj-folder');
  fs.mkdirSync(folder, { recursive: true });
  if (withDirector) fs.writeFileSync(path.join(folder, 'dir-1.jsonl'), jl([{ type: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', message: { id: 'a1', model: 'claude-fable-5-2', usage: U(1, 1, 1, 1), content: [{ type: 'text', text: 'x' }] } }]));
  if (withAgent) {
    fs.mkdirSync(path.join(folder, 'dir-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'dir-1', 'subagents', 'agent-ag-dir-1.jsonl'), jl(transcript()));
  }
  const del = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'subagent', agent: 'agent-team:implementer', agent_id: agentId, task: { id: 'AU-1', milestone: 'm1', attempt: '1' } };
  const comp = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'completion', agent: 'agent-team:implementer', agent_id: agentId, turn: 1, task: { id: 'AU-1', milestone: 'm1', attempt: '1' }, tokens_with_cache: 135 };
  const p = tmpProject();
  const d = logsOf(p);
  fs.mkdirSync(path.join(d, '.pending'), { recursive: true });
  fs.writeFileSync(path.join(d, '.gitkeep'), '');
  fs.writeFileSync(path.join(d, 'delegations.jsonl'), jl([del]));
  fs.writeFileSync(path.join(d, 'completions.jsonl'), jl([comp]));
  return { p, root, env: { AGENT_TEAM_PROJECTS_ROOT: root } };
}

const arch = (s) => spawnSync('node', [path.join(SCRIPTS, 'archive-logs.js'), 'm1', '--project', 'proj'], {
  cwd: s.p, encoding: 'utf8', env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), ...s.env },
});

const link = (target, at) => { try { fs.symlinkSync(target, at, 'file'); return true; } catch { return false; } };

test('FU-18: a symlinked completions.jsonl / sessions.jsonl is not appended to; the warning names the path', () => {
  // recovery control first: regular files are written
  const ok = setup();
  const r0 = arch(ok);
  eq(r0.status, 0, r0.stderr);
  eq(readLive(ok.p, 'completions.jsonl').length, 2, 'superseding line written to a regular file');
  eq(readLive(ok.p, 'sessions.jsonl').length, 1, 'session line written to a regular file');

  const s = setup();
  const out1 = path.join(tmp(), 'victim1.jsonl');
  const out2 = path.join(tmp(), 'victim2.jsonl');
  fs.writeFileSync(out1, 'ORIGINAL1\n');
  fs.writeFileSync(out2, 'ORIGINAL2\n');
  const cLog = path.join(logsOf(s.p), 'completions.jsonl');
  const sLog = path.join(logsOf(s.p), 'sessions.jsonl');
  const target = fs.readFileSync(cLog, 'utf8');
  fs.rmSync(cLog);
  if (!link(out1, cLog)) { console.log('  (skipped: links cannot be created here)'); return; }
  assert(link(out2, sLog), 'second symlink');
  assert(fs.lstatSync(cLog).isSymbolicLink() && fs.lstatSync(sLog).isSymbolicLink(), 'precondition: both logs are symlinks');
  fs.writeFileSync(out1, target); // the link target holds the line to supersede, so the pass reaches the append
  const r = arch(s);
  // The script resolves its cwd, so it prints the long path form where tmpdir() may be an 8.3 short form
  // (Windows runners): compare against the real log directory, not the one the test built.
  const realDir = fs.realpathSync.native(logsOf(s.p));
  assert(r.stdout.includes('refusing to write'), r.stdout);
  assert(r.stdout.includes(path.join(realDir, 'completions.jsonl')), r.stdout);
  assert(r.stdout.includes(path.join(realDir, 'sessions.jsonl')), r.stdout);
  eq(fs.readFileSync(out1, 'utf8'), target, 'completions target untouched');
  eq(fs.readFileSync(out2, 'utf8'), 'ORIGINAL2\n', 'sessions target untouched');
});

test('FU-18: appendLogLine refuses a path that is not a regular file (works without symlink rights), and appends to a regular or new file', () => {
  const { appendLogLine } = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const d = tmp();
  const dirAsLog = path.join(d, 'completions.jsonl');
  fs.mkdirSync(dirAsLog);
  let msg = '';
  try { appendLogLine(dirAsLog, 'x\n'); } catch (e) { msg = e.message; }
  assert(msg.includes('refusing to write') && msg.includes(dirAsLog), `refused with the path: ${msg}`);
  const f = path.join(d, 'new.jsonl');
  appendLogLine(f, 'a\n'); // absent: created
  appendLogLine(f, 'b\n');
  eq(fs.readFileSync(f, 'utf8'), 'a\nb\n', 'recovery control: regular file appended');
});

test('FU-18: a non-plain agent_id or session_id is not joined into a path; nothing outside the root is read', () => {
  const evil = 'x/../../../../../outside/evil';
  const s = setup({ agentId: evil, withAgent: false });
  // The file the traversal would reach: <projects root>/../outside/evil.jsonl (the root's parent is a fresh mkdtemp dir, not a shared name)
  const target = path.join(path.dirname(s.root), 'outside', 'evil.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, jl(transcript()));
  try {
    const reached = path.join(s.root, 'proj-folder', 'dir-1', 'subagents', `agent-${evil}.jsonl`);
    eq(path.resolve(reached), path.resolve(target), 'precondition: the traversal lands on the planted transcript');
    assert(fs.existsSync(reached), 'precondition: the planted transcript is reachable by that path');
    const r = arch(s);
    eq(r.status, 0, r.stderr);
    assert(r.stdout.includes('1 transcripts not found'), r.stdout);
    eq(readLive(s.p, 'completions.jsonl').length, 1, 'no superseding line from outside the root');
    const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
    eq(rc.findTranscript(s.root, '../x', 'ag'), null, 'bad session id');
    eq(rc.findTranscript(s.root, 'dir-1', evil), null, 'bad agent id');
    // recovery control: a plain id of a real transcript is still found, and supersedes
    const good = setup();
    assert(rc.findTranscript(good.root, 'dir-1', 'ag-dir-1'), 'plain id found');
    eq(arch(good).status, 0, 'archive ok');
    eq(readLive(good.p, 'completions.jsonl').length, 2, 'plain id supersedes');
  } finally { fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true }); }
});
