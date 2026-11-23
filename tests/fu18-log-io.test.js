// FU-18: symlinked logs are not appended to; ids from log lines are not trusted
// as paths; a transcript is used only when its recorded cwd is this project.
// Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { SCRIPTS, tmpProject, test, assert, eq } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu18-'));
const U = (input, output, cacheRead, cacheWrite) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const logsOf = (p) => path.join(p, '.agent-team', 'logs');
const readLive = (p, f) => {
  try { return fs.readFileSync(path.join(logsOf(p), f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// A turn handed back, then a later turn the hook never saw: the archive supersedes the completion line.
// `cwd` is the folder the session ran in, as Claude Code records it on each line (undefined: no cwd field).
const transcript = (cwd) => [
  { type: 'user', isMeta: false, cwd, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'TASK id=AU-1 type=implement difficulty=easy milestone=m1 attempt=1' } },
  { type: 'assistant', cwd, timestamp: '2026-11-01T10:00:05.000Z', message: { id: 'n0', model: 'claude-sonnet-5-5', usage: U(10, 20, 100, 5), content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'done' } }] } },
  { type: 'assistant', cwd, timestamp: '2026-11-01T10:01:05.000Z', message: { id: 'n1', model: 'claude-sonnet-5-5', usage: U(5, 50, 200, 0), content: [{ type: 'text', text: 'woken' }] } },
];

// Returns { p, root, env }: a project with one delegation and completion for session dir-1, and a projects root.
// cwd(p) picks the cwd the transcripts record (default: the project folder).
function setup({ agentId = 'ag-dir-1', withDirector = true, withAgent = true, cwd = (p) => p } = {}) {
  const p = tmpProject();
  const root = path.join(tmp(), 'root'); // nested, so the root's parent is a fresh directory of ours
  const folder = path.join(root, 'proj-folder');
  fs.mkdirSync(folder, { recursive: true });
  const at = cwd(p);
  if (withDirector) fs.writeFileSync(path.join(folder, 'dir-1.jsonl'), jl([{ type: 'assistant', cwd: at, timestamp: '2026-11-01T10:00:00.000Z', message: { id: 'a1', model: 'claude-fable-5-2', usage: U(1, 1, 1, 1), content: [{ type: 'text', text: 'x' }] } }]));
  if (withAgent) {
    fs.mkdirSync(path.join(folder, 'dir-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'dir-1', 'subagents', 'agent-ag-dir-1.jsonl'), jl(transcript(at)));
  }
  const del = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'subagent', agent: 'agent-team:implementer', agent_id: agentId, task: { id: 'AU-1', milestone: 'm1', attempt: '1' } };
  const comp = { ts: 't', tool: 'claude', session_id: 'dir-1', kind: 'completion', agent: 'agent-team:implementer', agent_id: agentId, turn: 1, task: { id: 'AU-1', milestone: 'm1', attempt: '1' }, tokens_with_cache: 135 };
  const d = logsOf(p);
  fs.mkdirSync(path.join(d, '.pending'), { recursive: true });
  fs.writeFileSync(path.join(d, '.gitkeep'), '');
  fs.writeFileSync(path.join(d, 'delegations.jsonl'), jl([del]));
  fs.writeFileSync(path.join(d, 'completions.jsonl'), jl([comp]));
  return { p, root, env: { AGENT_TEAM_PROJECTS_ROOT: root } };
}

const arch = (s) => spawnSync('node', [path.join(SCRIPTS, 'archive-logs.js'), 'm1', '--project', 'proj'], {
  cwd: s.p, encoding: 'utf8', timeout: 60000, env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), ...s.env },
});

// A symlink where this machine can make one, else a hard link (Windows without Developer Mode).
const link = (target, at) => { try { fs.symlinkSync(target, at, 'file'); return 'symlink'; } catch { fs.linkSync(target, at); return 'hard link'; } };
const isLinked = (f) => { const st = fs.lstatSync(f); return st.isSymbolicLink() || st.nlink > 1; };

test('FU-18: a linked (symlink, else hard link) completions.jsonl / sessions.jsonl is not appended to; the warning names the path', () => {
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
  const kind = link(out1, cLog);
  link(out2, sLog);
  assert(isLinked(cLog) && isLinked(sLog), `precondition: both logs are a ${kind}`);
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

test('FU-18: a non-plain agent_id or session_id is not joined into a path; nothing outside the root is read', () => {
  const evil = 'x/../../../../../outside/evil';
  const s = setup({ agentId: evil, withAgent: false });
  // The file the traversal would reach: <projects root>/../outside/evil.jsonl (the root's parent is a fresh mkdtemp dir, not a shared name)
  const target = path.join(path.dirname(s.root), 'outside', 'evil.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, jl(transcript(s.p)));
  const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const any = () => true; // accept every transcript: only the id check is under test here
  try {
    const reached = path.join(s.root, 'proj-folder', 'dir-1', 'subagents', `agent-${evil}.jsonl`);
    eq(path.resolve(reached), path.resolve(target), 'precondition: the traversal lands on the planted transcript');
    assert(fs.existsSync(reached), 'precondition: the planted transcript is reachable by that path');
    const r = arch(s);
    eq(r.status, 0, r.stderr);
    assert(r.stdout.includes('1 transcripts not found'), r.stdout);
    eq(readLive(s.p, 'completions.jsonl').length, 1, 'no superseding line from outside the root');
    eq(rc.findTranscript(s.root, '../x', 'ag', any), null, 'bad session id');
    eq(rc.findTranscript(s.root, 'dir-1', evil, any), null, 'bad agent id');
    // recovery control: a plain id of a real transcript is still found, and supersedes
    const good = setup();
    assert(rc.findTranscript(good.root, 'dir-1', 'ag-dir-1', any), 'plain id found');
    eq(arch(good).status, 0, 'archive ok');
    eq(readLive(good.p, 'completions.jsonl').length, 2, 'plain id supersedes');
  } finally { fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true }); }
});

test('FU-18: a numeric or array agent_id / session_id does not crash findTranscript, reconcile or the archive', () => {
  const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const s = setup();
  const any = () => true;
  // Before the fix String(id) passed the plain-id test, and path.join threw on the number.
  eq(rc.findTranscript(s.root, 'dir-1', 123, any), null, 'numeric agent id');
  eq(rc.findTranscript(s.root, 'dir-1', ['ag-dir-1'], any), null, 'array agent id');
  eq(rc.findTranscript(s.root, 7, 'ag-dir-1', any), null, 'numeric session id');
  eq(rc.findTranscript(s.root, ['dir-1'], 'ag-dir-1', any), null, 'array session id');
  assert(rc.findTranscript(s.root, 'dir-1', 'ag-dir-1', any), 'recovery control: string ids are found');
  // Log lines with numeric ids: a reconcile run and an archive run finish.
  const n = setup({ agentId: 123 });
  fs.writeFileSync(path.join(logsOf(n.p), 'delegations.jsonl'), jl([{ ts: 't', tool: 'claude', session_id: 42, kind: 'subagent', agent: 'agent-team:implementer', agent_id: 123, task: { id: 'AU-1', milestone: 'm1', attempt: '1' } }]));
  const r = spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js')], { cwd: n.p, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: n.p, ...n.env } });
  eq(r.status, 0, `reconcile exit 0: ${r.stderr}`);
  assert(/1 transcript not found/.test(r.stdout), r.stdout);
  const a = arch(n);
  eq(a.status, 0, `archive exit 0: ${a.stderr}`);
  assert(a.stdout.includes('1 transcripts not found'), a.stdout);
});

test('FU-18: a transcript whose cwd is another project, or that has no cwd, is not used; this project and its worktrees are', () => {
  // Another project: a same-named session and agent id under the projects root.
  const other = setup({ cwd: () => path.join(tmp(), 'someone-elses-project') });
  const r = arch(other);
  eq(r.status, 0, r.stderr);
  assert(r.stdout.includes('completions: 0 superseded') && r.stdout.includes('1 transcripts not found'), `agent transcript not used: ${r.stdout}`);
  assert(r.stdout.includes('usage: 1 sessions, 1 not found'), `Director transcript not used: ${r.stdout}`);
  eq(readLive(other.p, 'completions.jsonl').length, 1, 'no tokens imported from another project');
  eq(readLive(other.p, 'sessions.jsonl').length, 0, 'no session usage imported from another project');
  // No cwd on any line: skipped, counted as not found.
  const none = setup({ cwd: () => undefined });
  const rn = arch(none);
  assert(rn.stdout.includes('1 transcripts not found') && rn.stdout.includes('1 not found'), `no cwd: not used: ${rn.stdout}`);
  eq(readLive(none.p, 'completions.jsonl').length, 1, 'no cwd: nothing imported');
  // A worktree under the project (removed since: it no longer exists) and a subfolder count.
  for (const sub of [['.claude', 'worktrees', 'agent-gone'], ['src']]) {
    const w = setup({ cwd: (p) => path.join(p, ...sub) });
    const rw = arch(w);
    eq(readLive(w.p, 'completions.jsonl').length, 2, `${sub.join('/')}: superseded: ${rw.stdout}`);
  }
  // A git worktree outside the project folder counts while git lists it.
  const g = setup({ cwd: (p) => path.join(path.dirname(p), `${path.basename(p)}-wt`) });
  execFileSync('git', ['-C', g.p, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { timeout: 30000 });
  execFileSync('git', ['-C', g.p, 'worktree', 'add', '-q', path.join(path.dirname(g.p), `${path.basename(g.p)}-wt`)], { timeout: 30000 });
  const rg = arch(g);
  eq(readLive(g.p, 'completions.jsonl').length, 2, `outside worktree: superseded: ${rg.stdout}`);
  // The reconcile backfill obeys the same rule: rc.belongsTo is the predicate both use.
  const rc = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const mine = rc.belongsTo(other.p);
  const file = path.join(other.root, 'proj-folder', 'dir-1', 'subagents', 'agent-ag-dir-1.jsonl');
  eq(mine(file), false, 'another project: false');
  eq(rc.findTranscript(other.root, 'dir-1', 'ag-dir-1', mine), null, 'findTranscript skips it');
  eq(rc.belongsTo(path.join(tmp(), 'x'))(path.join(other.root, 'missing.jsonl')), false, 'unreadable transcript: false');
});

test('FU-18: reconcile does not backfill a handback result from another project\'s transcript; it does from this project\'s', () => {
  const RESULT = 'done\n```result-json\n{"status":"done","summary":"other project secret"}\n```';
  const make = (cwdOf) => {
    const p = tmpProject();
    const root = tmp();
    const dir = path.join(root, 'folder', 'sess-1', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const cwd = cwdOf(p);
    fs.writeFileSync(path.join(dir, 'agent-bf1.jsonl'), jl([
      { type: 'user', cwd, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'TASK id=BF-1 type=fix difficulty=easy milestone=m1 attempt=1' } },
      { type: 'assistant', cwd, timestamp: '2026-11-01T10:00:05.000Z', message: { id: 'b0', model: 'claude-sonnet-5-5', usage: U(1, 2, 0, 0), content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: RESULT } }] } },
    ]));
    fs.writeFileSync(path.join(logsOf(p), 'delegations.jsonl'), jl([{ ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'subagent', agent: 'agent-team:implementer', agent_id: 'bf1', task: { id: 'BF-1', milestone: 'm1', attempt: '1' } }]));
    const r = spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js')], { cwd: p, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: p, AGENT_TEAM_PROJECTS_ROOT: root } });
    return { p, r };
  };
  const other = make(() => path.join(tmp(), 'another-project'));
  eq(other.r.status, 0, other.r.stderr);
  assert(/0 completions backfilled.*1 transcript not found/.test(other.r.stdout), other.r.stdout);
  eq(readLive(other.p, 'completions.jsonl').length, 0, 'nothing imported from another project');
  // recovery control: the same transcript recorded in this project is backfilled
  const mine = make((p) => p);
  assert(/1 completions backfilled/.test(mine.r.stdout), mine.r.stdout);
  eq(readLive(mine.p, 'completions.jsonl')[0].result.summary, 'other project secret', 'backfilled from this project');
});
