// scripts/status.js: set, --check, and the refusals that leave the file untouched.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, SCRIPTS, test, assert, eq } = require('./helpers');
const status = require('../scripts/status');
const { nextStep } = require('../scripts/merge-task');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-status-'));
const FIXTURE = [
  '# Status',
  '',
  '## Tasks',
  '',
  '| ID | Title | Agent | Tier (model) / effort | Attempt | State | PR |',
  '|---|---|---|---|---|---|---|',
  '| T-1 | Plain `code` and a \\| pipe | implementer | medium (sonnet) / medium | 1 | in progress | |',
  '| T-2 | Second | implementer | small (haiku) / low | 1 | changes requested on X, then more | #5 |',
  '| T-3 | Third | reviewer | medium (sonnet) / medium | 2 | planned | |',
  '',
  'States: `planned` · `in progress` · `changes requested` · `waiting CI` · `queued` · `merged`',
  '',
  '## Other',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
].join('\n');

let n = 0;
function fixture(text, eol = '\n') {
  const f = path.join(DIR, `s${n++}.md`);
  fs.writeFileSync(f, eol === '\n' ? text : text.replace(/\n/g, eol));
  return f;
}
function cli(args) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'status.js'), ...args], { encoding: 'utf8', timeout: 20000 });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* checked by the caller */ }
  return { code: r.status, json, out: r.stdout, err: r.stderr };
}
// Run a refused command and assert the exit code, one JSON line with a reason, and a byte-identical file.
function refused(text, args, code, label) {
  const f = fixture(text);
  const before = fs.readFileSync(f);
  const r = cli([...args, '--file', f]);
  eq(r.code, code, `${label}: exit`);
  assert(r.json && r.json.ok === false && r.json.reason, `${label}: one JSON line with a reason: ${r.out}`);
  eq(r.out.trim().split('\n').length, 1, `${label}: one output line`);
  assert(Buffer.compare(before, fs.readFileSync(f)) === 0, `${label}: file changed`);
  assert(!fs.readdirSync(DIR).some((x) => x.includes('.tmp-')), `${label}: temp file left behind`);
}

test('set changes only the named cells of the one row, and prints one JSON line', () => {
  const f = fixture(FIXTURE);
  const r = cli(['set', 'T-2', '--state', 'merged', '--pr', '#9', '--attempt', '2', '--tier', 'large (opus) / high', '--file', f]);
  eq(r.code, 0, 'exit');
  assert(r.json.ok && r.json.changed && r.json.line === 8, r.out);
  const a = FIXTURE.split('\n');
  const b = fs.readFileSync(f, 'utf8').split('\n');
  eq(b.length, a.length, 'line count');
  const diff = b.map((l, i) => i).filter((i) => a[i] !== b[i]);
  eq(diff.join(','), '7', 'only the T-2 line differs');
  eq(b[7], '| T-2 | Second | implementer | large (opus) / high | 2 | merged | #9 |', 'row');
});

test('set --state writes the bare state; --note appends after it; a spaced state works', () => {
  const f = fixture(FIXTURE);
  eq(cli(['set', 'T-2', '--state', 'waiting CI', '--file', f]).code, 0, 'exit');
  assert(fs.readFileSync(f, 'utf8').includes('| 1 | waiting CI | #5 |'), 'bare spaced state replaces the trailing text');
  eq(cli(['set', 'T-2', '--state', 'changes requested', '--note', 'on X, then Y', '--file', f]).code, 0, 'exit');
  assert(fs.readFileSync(f, 'utf8').includes('| 1 | changes requested: on X, then Y | #5 |'), 'note appended');
  eq(cli(['--check', '--file', f]).code, 0, 'a state with a note still checks');
});

test('set keeps CRLF and LF line endings, and the rest of the file byte for byte', () => {
  for (const eol of ['\r\n', '\n']) {
    const f = fixture(FIXTURE, eol);
    eq(cli(['set', 'T-1', '--state', 'queued', '--file', f]).code, 0, 'exit');
    const got = fs.readFileSync(f, 'utf8');
    const want = FIXTURE.replace('| 1 | in progress | |', '| 1 | queued | |').replace(/\n/g, eol);
    eq(got, want, `eol ${JSON.stringify(eol)}`);
    eq(got.split('\n').length, FIXTURE.split('\n').length, 'line count');
  }
});

test('set matches the ID cell by string, with escaped pipes and backticks in other cells', () => {
  const f = fixture(FIXTURE);
  eq(cli(['set', 'T-1', '--state', 'merged', '--file', f]).code, 0, 'exit');
  assert(fs.readFileSync(f, 'utf8').includes('| T-1 | Plain `code` and a \\| pipe | implementer | medium (sonnet) / medium | 1 | merged | |'), 'row intact');
  // Regex metacharacters in an ID are plain text, not a pattern.
  refused(FIXTURE, ['set', 'T-.', '--state', 'merged'], 5, 'ID "T-." is not a pattern');
  refused(FIXTURE, ['set', '.*', '--state', 'merged'], 5, 'ID ".*" is not a pattern');
  refused(FIXTURE, ['set', 'T-', '--state', 'merged'], 5, 'a part of an ID is not the ID');
});

test('set refuses the empty ID and prepends nothing to line 1 (the empty-pattern incident)', () => {
  for (const id of ['', '  ']) refused(FIXTURE, ['set', id, '--state', 'merged'], 2, `ID ${JSON.stringify(id)}`);
  const f = fixture(FIXTURE);
  cli(['set', '', '--state', 'merged', '--file', f]);
  eq(fs.readFileSync(f, 'utf8').split('\n')[0], '# Status', 'line 1');
});

test('set refuses, with a distinct code and an untouched file: header, no table, missing, duplicate, state, value', () => {
  refused(FIXTURE.replace('# Status', '# Status of things'), ['set', 'T-1', '--state', 'merged'], 3, 'line 1');
  refused(FIXTURE.replace('## Tasks', '## Work'), ['set', 'T-1', '--state', 'merged'], 4, 'no Tasks heading');
  refused(FIXTURE.replace(/\| ID[^\n]*\n\|---[^\n]*\n(\|[^\n]*\n)*/, ''), ['set', 'T-1', '--state', 'merged'], 4, 'no table');
  refused(FIXTURE, ['set', 'T-9', '--state', 'merged'], 5, 'row missing');
  refused(FIXTURE.replace('| T-3 |', '| T-1 |'), ['set', 'T-1', '--state', 'merged'], 6, 'duplicate ID');
  refused(FIXTURE, ['set', 'T-1', '--state', 'done'], 7, 'state not in legend');
  refused(FIXTURE, ['set', 'T-1', '--state', 'merg'], 7, 'a prefix of a legend state is not a state');
  refused(FIXTURE.replace(/States:[^\n]*\n/, ''), ['set', 'T-1', '--state', 'merged'], 7, 'no legend');
  refused(FIXTURE, ['set', 'T-1', '--state', 'merged', '--note', 'a|b'], 8, 'pipe in note');
  refused(FIXTURE, ['set', 'T-1', '--state', 'merged', '--pr', '1\n2'], 8, 'newline in pr');
  refused(FIXTURE, ['set', 'T-1', '--state', 'merged', '--tier', 'a\rb'], 8, 'carriage return in tier');
  refused(FIXTURE, ['set', 'T-1'], 2, 'nothing to set');
  refused(FIXTURE, ['set', 'T-1', '--note', 'x'], 2, 'note without state');
  refused(FIXTURE, ['set', 'T-1', '--state'], 2, 'flag without value');
  refused(FIXTURE, ['set', 'T-1', '--bogus', 'x'], 2, 'unknown flag');
  refused(FIXTURE.replace('| Attempt |', '| Tries |'), ['set', 'T-1', '--attempt', '3'], 4, 'missing column');
  const r = cli(['set', 'T-1', '--state', 'merged', '--file', path.join(DIR, 'nope.md')]);
  eq(r.code, 10, 'unreadable file');
});

// Run status.main in-process with a stubbed fs function; always restore it. Returns { code, out }.
function withStub(name, make, args) {
  const real = fs[name];
  fs[name] = make(real);
  const lines = [];
  let code;
  try { code = status.main(args, { out: (l) => lines.push(l) }); } finally { fs[name] = real; }
  return { code, out: lines.join('\n'), json: JSON.parse(lines[lines.length - 1]) };
}
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const noTemp = (label) => assert(!fs.readdirSync(DIR).some((x) => x.includes('.tmp-')), `${label}: temp file left behind`);

test('set reads the file back: a corrupted write is detected, exits 11 and is not rolled back', () => {
  const f = fixture(FIXTURE);
  const real = fs.writeFileSync;
  let hits = 0;
  fs.writeFileSync = (p, data, ...rest) => real(p, hits++ === 0 ? `X${data}` : data, ...rest);
  let r;
  try { r = withStub('renameSync', (rn) => rn, ['set', 'T-1', '--state', 'merged', '--file', f]); } finally { fs.writeFileSync = real; }
  eq(hits, 1, 'one write; no restore write follows');
  eq(r.code, 11, 'exit');
  assert(r.json.reason.includes('NOT restored') && r.json.reason.includes(f), r.out);
  assert(fs.readFileSync(f, 'utf8').startsWith('X'), 'the file is left as found, and the reason names it');
  noTemp('read-back');
});

test('a failing rename (a read-only or locked file) exits 11, leaves the file byte-identical and no temp file', () => {
  const f = fixture(FIXTURE);
  const before = fs.readFileSync(f);
  let renameCalls = 0;
  const r = withStub('renameSync', () => (a) => {
    renameCalls++;
    assert(path.basename(a).includes('.tmp-') && fs.readFileSync(a, 'utf8') !== FIXTURE, 'precondition: the temp file holds the new text when the rename fails');
    throw eperm();
  }, ['set', 'T-1', '--state', 'merged', '--file', f]);
  eq(renameCalls, 1, 'precondition: the rename was reached');
  eq(r.code, 11, 'exit');
  assert(r.json.ok === false && r.json.reason.includes('EPERM'), r.out);
  assert(Buffer.compare(before, fs.readFileSync(f)) === 0, 'file changed');
  noTemp('rename');
  // Recovery control: once the failure clears, the same command works.
  eq(cli(['set', 'T-1', '--state', 'merged', '--file', f]).code, 0, 'recovery exit');
  assert(fs.readFileSync(f, 'utf8').includes('| 1 | merged | |'), 'recovery wrote the row');
});

test('a failing temp-file write exits 11, leaves the file byte-identical and removes the partial temp file', () => {
  const f = fixture(FIXTURE);
  const before = fs.readFileSync(f);
  let partial = false;
  const r = withStub('writeFileSync', (w) => (p, data, ...rest) => {
    w(p, data.slice(0, 10), ...rest);
    partial = path.basename(p).includes('.tmp-') && fs.existsSync(p);
    throw eperm();
  }, ['set', 'T-1', '--state', 'merged', '--file', f]);
  assert(partial, 'precondition: a partial temp file existed when the write failed');
  eq(r.code, 11, 'exit');
  assert(r.json.ok === false && r.json.reason.includes('EPERM'), r.out);
  assert(Buffer.compare(before, fs.readFileSync(f)) === 0, 'file changed');
  noTemp('write');
  eq(cli(['set', 'T-1', '--state', 'merged', '--file', f]).code, 0, 'recovery exit');
});

test('set keeps the file mode: the temp file gets the original mode before the rename', () => {
  const f = fixture(FIXTURE);
  fs.chmodSync(f, 0o640);
  const mode = fs.statSync(f).mode & 0o7777;
  const calls = [];
  const realRename = fs.renameSync;
  const r = withStub('chmodSync', (c) => (p, m) => {
    calls.push({ p, m });
    fs.renameSync = (a, b) => { calls.push({ renamed: a }); return realRename(a, b); };
    return c(p, m);
  }, ['set', 'T-1', '--state', 'merged', '--file', f]);
  fs.renameSync = realRename;
  eq(r.code, 0, 'exit');
  eq(calls.length, 2, 'precondition: one chmod, then the rename');
  assert(path.basename(calls[0].p).includes('.tmp-') && calls[0].m === mode, `chmod of the temp file to ${mode}: ${JSON.stringify(calls[0])}`);
  eq(calls[1].renamed, calls[0].p, 'the chmod came before the rename of the same temp file');
  if (process.platform !== 'win32') eq(fs.statSync(f).mode & 0o7777, 0o640, 'mode after set');
});

test('set refuses a symlink with a reason and its own exit code; --check still reads one', () => {
  const f = fixture(FIXTURE);
  const before = fs.readFileSync(f);
  // A stubbed lstat works everywhere; creating a real symlink may need privileges on Windows.
  let asked = 0;
  const r = withStub('lstatSync', (ls) => (p, ...rest) => {
    const st = ls(p, ...rest);
    if (path.resolve(String(p)) !== path.resolve(f)) return st;
    asked++;
    return Object.create(st, { isSymbolicLink: { value: () => true } });
  }, ['set', 'T-1', '--state', 'merged', '--file', f]);
  assert(asked >= 1, 'precondition: the file was lstat-ed');
  eq(r.code, 13, 'exit');
  assert(r.json.ok === false && r.json.reason.includes('symlink') && r.json.reason.includes('--file'), r.out);
  assert(Buffer.compare(before, fs.readFileSync(f)) === 0, 'file changed');
  noTemp('symlink');
  // Recovery control: the same command on a regular file works.
  eq(cli(['set', 'T-1', '--state', 'merged', '--file', f]).code, 0, 'regular file');
  // A real symlink, where the platform lets this process make one.
  const link = path.join(DIR, `link${n++}.md`);
  let made = true;
  try { fs.symlinkSync(f, link, 'file'); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; made = false; }
  if (made) {
    const target = fs.readFileSync(f);
    eq(cli(['set', 'T-2', '--state', 'merged', '--file', link]).code, 13, 'real symlink');
    assert(fs.lstatSync(link).isSymbolicLink() && Buffer.compare(target, fs.readFileSync(f)) === 0, 'link and target untouched');
    eq(cli(['--check', '--file', link]).code, 0, '--check through a link');
  }
});

test('set refuses a malformed row anywhere in the table (exit 12) instead of skipping it', () => {
  const cases = [
    ['too many cells, last row', FIXTURE.replace('| T-3 | Third |', '| T-3 | Th | ird |'), 'T-1', 9],
    ['too few cells, first row', FIXTURE.replace('| 1 | in progress | |', '| 1 | in progress |'), 'T-3', 7],
    ['no closing pipe', FIXTURE.replace('| 2 | planned | |', '| 2 | planned'), 'T-1', 9],
    ['the target row itself', FIXTURE.replace('| T-3 | Third |', '| T-3 | Th | ird |'), 'T-3', 9],
    ['a malformed duplicate of the target', FIXTURE.replace('| T-3 | Third |', '| T-1 | Th | ird |'), 'T-1', 9],
  ];
  for (const [label, text, id, line] of cases) {
    const f = fixture(text);
    const before = fs.readFileSync(f);
    const r = cli(['set', id, '--state', 'merged', '--file', f]);
    eq(r.code, 12, `${label}: exit`);
    assert(r.json.ok === false && /row malformed/.test(r.json.reason) && r.json.reason.includes('run --check') && r.json.reason.includes(`line ${line}`), `${label}: ${r.out}`);
    assert(Buffer.compare(before, fs.readFileSync(f)) === 0, `${label}: file changed`);
    eq(cli(['--check', '--file', f]).code, 9, `${label}: --check agrees`);
  }
  noTemp('malformed');
});

test('set with the same value is a no-op: nothing differs', () => {
  const f = fixture(FIXTURE);
  const r = cli(['set', 'T-3', '--state', 'planned', '--file', f]);
  eq(r.code, 0, 'exit');
  eq(r.json.changed, false, 'changed');
  eq(fs.readFileSync(f, 'utf8'), FIXTURE, 'bytes');
});

test('--check passes on a good file, on the repo STATUS.md and on the template', () => {
  eq(cli(['--check', '--file', fixture(FIXTURE)]).code, 0, 'fixture');
  eq(cli(['--check', '--file', path.join(ROOT, 'STATUS.md')]).code, 0, 'repo STATUS.md');
  eq(cli(['--check', '--file', path.join(ROOT, 'templates', 'project', 'STATUS.md')]).code, 0, 'template');
  eq(cli(['--check', '--file', fixture(FIXTURE, '\r\n')]).code, 0, 'CRLF');
});

test('--check fails, with the reason, on each broken thing', () => {
  const bad = (text, re, label) => {
    const r = cli(['--check', '--file', fixture(text)]);
    eq(r.code, 9, label);
    assert(r.json.ok === false && r.json.problems.some((p) => re.test(p)), `${label}: ${r.out}`);
  };
  bad(FIXTURE.replace('# Status', '# Stat'), /line 1/, 'line 1');
  bad(FIXTURE.replace('## Tasks', '## Work'), /Tasks/, 'no Tasks heading');
  bad(FIXTURE.replace('## Other', '## Tasks'), /more than one/, 'two Tasks headings');
  bad(FIXTURE.replace('\n## Other', '\n| x | y |\n|---|---|\n\n## Other'), /more than one table/, 'two tables under Tasks');
  bad(FIXTURE.replace('| T-3 | Third |', '| T-3 | Th | ird |'), /cells/, 'too many cells');
  bad(FIXTURE.replace('| 2 | planned | |', '| 2 | planned |'), /cells/, 'too few cells');
  bad(FIXTURE.replace('| T-3 |', '| T-1 |'), /duplicate ID T-1/, 'duplicate ID');
  bad(FIXTURE.replace('| T-3 |', '|  |'), /empty ID/, 'empty ID');
  bad(FIXTURE.replace('| 2 | planned |', '| 2 | donezo |'), /not a legend state/, 'bad state');
  bad(FIXTURE.replace('| 2 | planned |', '| 2 | plannedish |'), /not a legend state/, 'state prefix without a word boundary');
  bad(FIXTURE.replace(/States:[^\n]*\n/, ''), /no States: legend/, 'no legend');
  bad(FIXTURE.replace('|---|---|---|---|---|---|---|', '|---|---|'), /separator/, 'separator cell count');
});

test('--check accepts a State cell with trailing text that starts with a legend state', () => {
  const r = cli(['--check', '--file', fixture(FIXTURE)]);
  eq(r.code, 0, r.out);
  assert(status.startsWithState('changes requested on X, then more', ['changes requested']), 'helper');
  assert(!status.startsWithState('changes', ['changes requested']), 'helper rejects a shorter word');
});

test('merge-task.js next names the exact status.js set command for merged, queued and waiting', () => {
  const c = { pr: '7', forge: 'github', sha: 'abc', task: 'AUTH-3', attempt: '1' };
  const cmd = (st) => `node "<plugin root>/scripts/status.js" set AUTH-3 --state "${st}" --pr 7`;
  assert(nextStep('merged', c).includes(cmd('merged')), nextStep('merged', c));
  assert(nextStep('merged', { ...c, already: true }).includes(cmd('merged')), 'already merged');
  assert(nextStep('queued', c).includes(cmd('queued')), nextStep('queued', c));
  assert(nextStep('waiting', c).includes(cmd('waiting CI')), nextStep('waiting', c));
  assert(nextStep('waiting', { ...c, waited: true }).includes(cmd('waiting CI')), 'still waiting');
});

test('set creates the temp file exclusively: a file or symlink already at that path is never followed, exit 21', () => {
  const crypto = require('crypto');
  const realRandom = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.from('0123456789abcdef', 'hex');
  try {
    const f = fixture(FIXTURE);
    const tmp = `${f}.tmp-${process.pid}-0123456789abcdef`;
    const before = fs.readFileSync(f);
    // A file already there.
    fs.writeFileSync(tmp, 'precious');
    let r = withStub('renameSync', (rn) => rn, ['set', 'T-1', '--state', 'merged', '--file', f]);
    eq(r.code, 21, `exit: ${r.out}`);
    assert(r.json.ok === false && r.json.reason.includes('already exists'), r.out);
    eq(fs.readFileSync(tmp, 'utf8'), 'precious', 'the pre-existing file is untouched and not removed');
    assert(Buffer.compare(before, fs.readFileSync(f)) === 0, 'file changed');
    fs.unlinkSync(tmp);
    // A symlink already there, pointing at a victim.
    const victim = path.join(DIR, `victim${n++}.txt`);
    fs.writeFileSync(victim, 'victim');
    let made = true;
    try { fs.symlinkSync(victim, tmp, 'file'); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; made = false; }
    if (made) {
      r = withStub('renameSync', (rn) => rn, ['set', 'T-1', '--state', 'merged', '--file', f]);
      eq(r.code, 21, `symlink exit: ${r.out}`);
      eq(fs.readFileSync(victim, 'utf8'), 'victim', 'the link target is not overwritten');
      assert(fs.lstatSync(tmp).isSymbolicLink(), 'the link is still there');
      assert(Buffer.compare(before, fs.readFileSync(f)) === 0, 'file changed (symlink case)');
      fs.unlinkSync(tmp);
    }
    // Recovery control: with the path free the same command works.
    r = withStub('renameSync', (rn) => rn, ['set', 'T-1', '--state', 'merged', '--file', f]);
    eq(r.code, 0, `recovery: ${r.out}`);
  } finally { crypto.randomBytes = realRandom; }
});

// Decision 0029: the file is restored never, because a read-back that differs may be another
// writer's edit. Before, an edit that landed between the rename and the read-back was read back,
// found unchanged on the second read, and overwritten with the original.
test('set does not roll back over an edit made by someone else between the rename and the read-back', () => {
  const f = fixture(FIXTURE);
  const real = fs.writeFileSync;
  const realRead = fs.readFileSync;
  let reads = 0;
  let tampered = false;
  fs.readFileSync = (p, ...rest) => {
    // Read 1 is the original; read 2 is the read-back. The other writer gets in just before it.
    if (path.resolve(String(p)) === path.resolve(f) && ++reads === 2) { real(f, 'SOMEONE ELSE EDITED\n'); tampered = true; }
    return realRead(p, ...rest);
  };
  let r;
  try { status.main(['set', 'T-1', '--state', 'merged', '--file', f], { out: (l) => { r = l; } }); } finally { fs.readFileSync = realRead; }
  assert(tampered, 'precondition: the other writer edited before the read-back');
  const j = JSON.parse(r);
  eq(j.code, 11, r);
  assert(j.reason.includes('edit by someone else') && j.reason.includes('NOT restored'), r);
  eq(fs.readFileSync(f, 'utf8'), 'SOMEONE ELSE EDITED\n', 'the other edit is left in place');
  noTemp('rollback');
});

// ---- --check --since ----

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 20000 });
  assert(r.status === 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function run(args, cwd, env = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'status.js'), ...args], { encoding: 'utf8', cwd, timeout: 20000, env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* checked by the caller */ }
  return { code: r.status, json, out: r.stdout, err: r.stderr };
}
const deq = (a, b, m) => eq(JSON.stringify(a), JSON.stringify(b), m);
let repoN = 0;
// A repo whose first commit holds a valid STATUS.md and one other file. Returns { dir, base }.
function repo() {
  const dir = path.join(DIR, `repo${repoN++}`);
  fs.mkdirSync(dir);
  g(dir, 'init', '-q', '-b', 'main');
  // Linux defaults to core.fileMode=true and Windows to false; pin true so both take the same path
  // (commit -a then re-stages the on-disk mode, which is why the mode case commits without -a).
  g(dir, 'config', 'core.fileMode', 'true');
  fs.writeFileSync(path.join(dir, 'STATUS.md'), FIXTURE);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g(dir, 'add', 'STATUS.md', 'a.txt');
  g(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: g(dir, 'rev-parse', 'HEAD') };
}
function commit(dir, msg = 'c') {
  g(dir, 'commit', '-q', '-a', '-m', msg);
  return g(dir, 'rev-parse', 'HEAD');
}
// Run --check --since and assert the verdict, exit code and output shape.
function since(dir, sha, extra, want, code, label) {
  const r = run(['--check', '--since', sha, ...extra], dir);
  eq(r.code, code, `${label}: exit (${r.out}${r.err})`);
  assert(r.json && r.json.status_only === want, `${label}: status_only ${want}: ${r.out}`);
  eq(r.json.since, sha, `${label}: since echoed`);
  assert(/^[0-9a-f]{40}$/.test(r.json.head), `${label}: head echoed`);
  assert(want ? r.json.reason === undefined : typeof r.json.reason === 'string' && r.json.reason, `${label}: reason only when false: ${r.out}`);
  return r;
}

test('--since: an empty diff and an edit of STATUS.md alone pass, with head defaulting to HEAD', () => {
  const { dir, base } = repo();
  since(dir, base, [], true, 0, 'empty diff');
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'more\n');
  const head = commit(dir);
  eq(g(dir, 'diff', '--name-status', base, head), 'M\tSTATUS.md', 'precondition: the diff is exactly M STATUS.md');
  const r = since(dir, base, [], true, 0, 'status only');
  eq(r.json.head, head, 'head defaults to HEAD');
  since(dir, base, ['--head', head], true, 0, 'explicit head');
});

test('--since: any other path, alone or with STATUS.md, fails', () => {
  const { dir, base } = repo();
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
  const h1 = commit(dir);
  eq(g(dir, 'diff', '--name-status', base, h1), 'M\ta.txt', 'precondition');
  assert(/a\.txt/.test(since(dir, base, [], false, 14, 'other path').json.reason), 'reason names the path');
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'x\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  g(dir, 'add', 'new.txt');
  commit(dir);
  since(dir, base, [], false, 14, 'status plus others');
});

test('--since: STATUS.md deleted, renamed, or changed in mode or type fails', () => {
  let r = repo();
  g(r.dir, 'rm', '-q', 'STATUS.md');
  commit(r.dir);
  eq(g(r.dir, 'diff', '--name-status', r.base, 'HEAD'), 'D\tSTATUS.md', 'precondition: deleted');
  since(r.dir, r.base, [], false, 14, 'deleted');

  r = repo();
  g(r.dir, 'mv', 'STATUS.md', 'OTHER.md');
  commit(r.dir);
  assert(/^R/.test(g(r.dir, 'diff', '--name-status', r.base, 'HEAD')), 'precondition: git sees a rename');
  since(r.dir, r.base, [], false, 14, 'renamed');

  r = repo();
  g(r.dir, 'update-index', '--chmod=+x', 'STATUS.md');
  // No -a: with core.fileMode true, -a would re-stage the on-disk 644 file and wipe the mode change.
  g(r.dir, 'commit', '-q', '-m', 'mode');
  eq(g(r.dir, 'diff', '--name-status', r.base, 'HEAD'), 'M\tSTATUS.md', 'precondition: name-status alone shows only M for a mode change');
  assert(/mode/.test(since(r.dir, r.base, [], false, 14, 'mode only').json.reason), 'reason says mode');

  r = repo();
  const lnk = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.dir, input: 'a.txt', encoding: 'utf8', env: GIT_ENV }).stdout.trim();
  g(r.dir, 'update-index', '--cacheinfo', `120000,${lnk},STATUS.md`);
  g(r.dir, 'commit', '-q', '-m', 'type');
  assert(/^T/.test(g(r.dir, 'diff', '--name-status', r.base, 'HEAD')), 'precondition: git reports a type change');
  since(r.dir, r.base, [], false, 14, 'type change');
  // A symlink edited in place keeps its mode, so only the regular-file check stops it.
  const lnk2 = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: r.dir, input: 'b.txt', encoding: 'utf8', env: GIT_ENV }).stdout.trim();
  g(r.dir, 'update-index', '--cacheinfo', `120000,${lnk2},STATUS.md`);
  g(r.dir, 'commit', '-q', '-m', 'link edit');
  const typed = g(r.dir, 'rev-parse', 'HEAD~1');
  eq(g(r.dir, 'diff', '--name-status', typed, 'HEAD'), 'M\tSTATUS.md', 'precondition: a symlink edit shows as M with equal modes');
  assert(/regular file/.test(since(r.dir, typed, [], false, 14, 'symlink edit').json.reason), 'reason says not a regular file');
});

test('--since: diff.relative and a subdirectory cwd do not hide a change outside the subdirectory', () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'sub'));
  fs.writeFileSync(path.join(r.dir, 'sub', 'b.txt'), 'b\n');
  g(r.dir, 'add', 'sub/b.txt');
  g(r.dir, 'commit', '-q', '-m', 'sub');
  const base = g(r.dir, 'rev-parse', 'HEAD');
  g(r.dir, 'config', 'diff.relative', 'true');
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'changed\n');
  commit(r.dir);
  const sub = path.join(r.dir, 'sub');
  // Precondition: from sub with diff.relative, a plain git diff does not list the outside change.
  eq(g(sub, 'diff', '--name-status', base, 'HEAD'), '', 'precondition: the relative diff is blind to a.txt');
  const out = since(sub, base, [], false, 14, 'outside change from a subdirectory');
  assert(out.json.reason.includes('a.txt'), out.out);
  // Recovery control: a STATUS.md-only change from the subdirectory still passes.
  const head = g(r.dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.dir, 'STATUS.md'), FIXTURE.replace('planned', 'queued'));
  commit(r.dir);
  since(sub, head, [], true, 0, 'status only from a subdirectory');
});

test('--since: a sha that is not an ancestor, an unknown sha, and git failing exit non-zero', () => {
  const { dir, base } = repo();
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'x\n');
  const h1 = commit(dir);
  g(dir, 'checkout', '-q', '-b', 'side', base);
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'y\n');
  const sib = commit(dir);
  eq(spawnSync('git', ['merge-base', '--is-ancestor', h1, sib], { cwd: dir, env: GIT_ENV }).status, 1, 'precondition: h1 is not an ancestor of sib');
  assert(/not an ancestor/.test(since(dir, h1, ['--head', sib], false, 14, 'not an ancestor').json.reason), 'reason');
  since(dir, '0'.repeat(40), [], false, 15, 'unknown sha');
  // status.js drops GIT_CEILING_DIRECTORIES, so git may find a repo above tmp; base is not in it either way.
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-nogit-'));
  const r = run(['--check', '--since', base], nogit);
  eq(r.code, 15, `outside the repo that holds base: ${r.out}`);
});

test('--since: a short sha, a branch name, an uppercase sha and a non-hex argument are refused before git runs', () => {
  const { dir, base } = repo();
  for (const bad of [base.slice(0, 12), 'main', base.toUpperCase(), `${base.slice(0, 39)}g`, `${base}0`, '--output=x']) {
    const r = run(['--check', '--since', bad], dir);
    eq(r.code, 2, `since ${bad}: ${r.out}`);
    assert(r.json && r.json.ok === false, 'one JSON refusal');
  }
  eq(run(['--check', '--since', base, '--head', 'HEAD'], dir).code, 2, 'head must be a full sha too');
  eq(run(['--check', '--since'], dir).code, 2, 'value missing');
  eq(run(['--head', base], dir).code, 2, '--head alone');
  eq(run(['--check', '--since', base, '--file', 'x'], dir).code, 2, '--file with --since');
});

test('--since: a head whose STATUS.md fails --check fails, and passes again once fixed', () => {
  const { dir, base } = repo();
  fs.writeFileSync(path.join(dir, 'STATUS.md'), FIXTURE.replace(/States:[^\n]*\n/, ''));
  commit(dir);
  assert(/--check fails/.test(since(dir, base, [], false, 14, 'broken at head').json.reason), 'reason');
  fs.writeFileSync(path.join(dir, 'STATUS.md'), FIXTURE.replace('| 1 | in progress |', '| 1 | merged |'));
  const fixed = commit(dir);
  eq(since(dir, base, [], true, 0, 'recovered').json.head, fixed, 'head');
});

test('--since: git runs from an argv array, never a shell', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'status.js'), 'utf8');
  assert(/const argv = \[\.\.\.GIT_PRE, \.\.\.args\];/.test(src) && /execFileSync\('git', argv, /.test(src), 'execFileSync with an argv array');
  assert(!/(^|[^.\w])exec\(|\bexecSync\b|shell\s*:/m.test(src), 'no exec, execSync or shell option');
});

// A repo whose base holds STATUS.md and a gitlink "sub" at s1; the head moves the gitlink to s2.
// No submodule clone: the gitlink is written straight into the index.
function gitlinkRepo(gitmodules) {
  const { dir, base: first } = repo();
  const s1 = g(dir, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'b\n');
  const s2 = commit(dir);
  g(dir, 'update-index', '--add', '--cacheinfo', `160000,${s1},sub`);
  if (gitmodules) {
    fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
    g(dir, 'add', '.gitmodules');
  }
  g(dir, 'commit', '-q', '-m', 'gitlink at s1');
  const base = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'update-index', '--cacheinfo', `160000,${s2},sub`);
  g(dir, 'commit', '-q', '-m', 'gitlink to s2');
  assert(first !== base, 'precondition: a new base');
  eq(g(dir, 'diff', '--ignore-submodules=none', '--name-status', base, 'HEAD'), 'M\tsub', 'precondition: the head moves only the gitlink');
  return { dir, base };
}

test('--since: a gitlink bump fails even when .gitmodules or config says ignore = all', () => {
  let r = gitlinkRepo(true);
  eq(g(r.dir, 'diff', '--name-status', r.base, 'HEAD'), '', 'precondition: plain git diff hides the bump (ignore = all)');
  assert(/M sub/.test(since(r.dir, r.base, [], false, 14, '.gitmodules ignore = all').json.reason), 'reason names the gitlink');
  // The same through the caller's environment (GIT_CONFIG_COUNT/KEY/VALUE), with no .gitmodules.
  r = gitlinkRepo(false);
  const cfg = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'all' };
  eq(spawnSync('git', ['diff', '--name-status', r.base, 'HEAD'], { cwd: r.dir, encoding: 'utf8', env: { ...GIT_ENV, ...cfg } }).stdout.trim(), '', 'precondition: the env config hides the bump from plain git');
  const e = run(['--check', '--since', r.base], r.dir, cfg);
  eq(e.code, 14, `env diff.ignoreSubmodules=all: ${e.out}`);
  eq(e.json.status_only, false, 'not status-only');
  // And through the repo's own config.
  g(r.dir, 'config', 'diff.ignoreSubmodules', 'all');
  eq(g(r.dir, 'diff', '--name-status', r.base, 'HEAD'), '', 'precondition: repo config hides the bump from plain git');
  since(r.dir, r.base, [], false, 14, 'config diff.ignoreSubmodules=all');
});

// A repo where `real` changes a.txt and STATUS.md, and `fake` (a sibling of real) changes STATUS.md alone.
function forgeRepo() {
  const { dir, base } = repo();
  fs.appendFileSync(path.join(dir, 'a.txt'), 'evil\n');
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'x\n');
  const real = commit(dir, 'real');
  g(dir, 'checkout', '-q', '-b', 'fake', base);
  fs.appendFileSync(path.join(dir, 'STATUS.md'), 'x\n');
  const fake = commit(dir, 'fake');
  g(dir, 'checkout', '-q', 'main');
  since(dir, base, ['--head', real], false, 14, 'precondition: real is not status-only');
  return { dir, base, real, fake };
}

test('--since: a replace ref that swaps the head for a status-only commit does not pass', () => {
  const { dir, base, real, fake } = forgeRepo();
  g(dir, 'replace', real, fake);
  eq(g(dir, 'diff', '--name-status', base, real), 'M\tSTATUS.md', 'precondition: plain git now reads real as status-only');
  assert(/a\.txt/.test(since(dir, base, ['--head', real], false, 14, 'replaced head').json.reason), 'reason names a.txt');
  // One step past: the default head (HEAD is real) is refused too, and the fake itself still passes.
  since(dir, base, [], false, 14, 'replaced head as HEAD');
  since(dir, base, ['--head', fake], true, 0, 'the status-only commit itself');
});

test('--since: a forged commit-graph that gives the head a status-only tree does not pass', () => {
  const { dir, base, real, fake } = forgeRepo();
  g(dir, 'commit-graph', 'write', '--reachable');
  const file = path.join(dir, '.git', 'objects', 'info', 'commit-graph');
  const b = fs.readFileSync(file);
  const chunk = {};
  for (let i = 0; i < b[6]; i++) chunk[b.toString('latin1', 8 + i * 12, 12 + i * 12)] = Number(b.readBigUInt64BE(12 + i * 12));
  const count = (chunk.CDAT - chunk.OIDL) / 20;
  let at = -1;
  for (let i = 0; i < count; i++) if (b.toString('hex', chunk.OIDL + i * 20, chunk.OIDL + i * 20 + 20) === real) at = i;
  assert(at >= 0, 'precondition: real is in the commit-graph');
  Buffer.from(g(dir, 'rev-parse', `${fake}^{tree}`), 'hex').copy(b, chunk.CDAT + at * 36);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, b);
  eq(g(dir, 'diff', '--name-status', base, real), 'M\tSTATUS.md', 'precondition: plain git reads real through the forged graph');
  assert(/a\.txt/.test(since(dir, base, ['--head', real], false, 14, 'forged graph').json.reason), 'reason names a.txt');
});

test('--since: GIT_DIR and GIT_* in the caller env do not redirect the check', () => {
  const a = repo();
  fs.appendFileSync(path.join(a.dir, 'a.txt'), 'x\n');
  commit(a.dir);
  const b = repo();
  fs.appendFileSync(path.join(b.dir, 'STATUS.md'), 'x\n');
  const bHead = commit(b.dir);
  since(b.dir, b.base, [], true, 0, 'precondition: b base..head is status-only in b');
  const env = { GIT_DIR: path.join(b.dir, '.git'), GIT_WORK_TREE: b.dir };
  eq(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: a.dir, encoding: 'utf8', env: { ...GIT_ENV, ...env } }).stdout.trim(), bHead, 'precondition: plain git in a follows GIT_DIR to b');
  let r = run(['--check', '--since', b.base, '--head', bHead], a.dir, env);
  eq(r.code, 15, `b's commits are not in a: ${r.out}`);
  r = run(['--check', '--since', a.base], a.dir, { ...env, GIT_INDEX_FILE: path.join(b.dir, '.git', 'index'), GIT_OBJECT_DIRECTORY: path.join(b.dir, '.git', 'objects') });
  eq(r.code, 14, `HEAD is a's own (a.txt changed): ${r.out}`);
  assert(/a\.txt/.test(r.json.reason), 'reason names a.txt');
  // Recovery control: without the env, a's status-only change passes.
  fs.appendFileSync(path.join(a.dir, 'STATUS.md'), 'y\n');
  const aHead = commit(a.dir);
  since(a.dir, g(a.dir, 'rev-parse', 'HEAD~1'), [], true, 0, 'a status-only commit in a');
  eq(run(['--check', '--since', g(a.dir, 'rev-parse', 'HEAD~1')], a.dir, env).json.head, aHead, 'with the env, HEAD is still a\'s');
});

// ---- grant ----

const BLOCK = (roles, second) => `## xlarge grant\n\n- Granted roles: ${roles}\n- xlarge model and note per tool: Claude: fable\n- Map source: default\n- Second security review: ${second}\n`;
const STATUS_DOC = (slug, roles, second, eol = '\n') => `# Status\n\n## Current milestone\n\n**${slug}**: a goal\nBranch: \`milestone/${slug}\`\n\n${BLOCK(roles, second)}\n## CI\n\n- x\n`.replace(/\n/g, eol);
const intake = (slug, grantRoles, second = 'none') => JSON.stringify({ ts: 't', milestone: slug, xlarge_grant: grantRoles, second_review: second, map_source: 'default' });
let projN = 0;
function project(statusText, logLines) {
  const dir = path.join(DIR, `proj${projN++}`);
  fs.mkdirSync(path.join(dir, '.agent-team', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'STATUS.md'), statusText);
  if (logLines !== null) fs.writeFileSync(path.join(dir, '.agent-team', 'logs', 'milestones.jsonl'), logLines);
  return dir;
}
// The Director passes its own slug; the tests default to m1, the slug STATUS_DOC is given.
const grantIn = (dir, extra = [], slug = 'm1') => run(['grant', '--milestone', slug, ...extra], dir, { CLAUDE_PROJECT_DIR: dir });
const NOTHING = { roles: [], second_review: 'none' };

// This repo's STATUS.md, read by the test itself and not through status.js, so the expectations
// follow the file from milestone to milestone and a parse regression in status.js still shows.
const SAMPLE_ROLES = 'security reviews, architect, hard-fix escalation (a note that repeats security reviews and coach at close; the close review stays xlarge/high)';
const BOTH_SEC = ['security-review-close', 'security-review-task'];
const SAMPLE_ROLE_NAMES = ['architect', 'hard-fix', ...BOTH_SEC];
const WIDE = ['architect', 'coach', 'hard-fix', ...BOTH_SEC];
const WIDE_WORDS = 'all security reviews, architect, coach (run for this milestone), hard-fix escalation';
const LIVE_STATUS = path.join(ROOT, 'STATUS.md');
const LIVE_TEXT = fs.existsSync(LIVE_STATUS) ? fs.readFileSync(LIVE_STATUS, 'utf8') : null;
function liveGrant(text) {
  const out = { found: false, rolesRaw: null, roles: [], second: 'none', slug: null };
  if (text === null) return out;
  const lines = text.replace(/\r/g, '').split('\n');
  const section = (title) => {
    const i = lines.findIndex((l) => l.trim().toLowerCase() === title);
    if (i < 0) return null;
    const end = lines.findIndex((l, j) => j > i && l.startsWith('## '));
    return lines.slice(i + 1, end < 0 ? lines.length : end);
  };
  const cur = section('## current milestone');
  const bold = cur && cur.map((l) => /^\*\*([^*]+)\*\*/.exec(l.trim())).find(Boolean);
  if (bold && !/^<.*>$/.test(bold[1].trim())) out.slug = bold[1].trim();
  const block = section('## xlarge grant');
  if (!block) return out;
  out.found = true;
  const field = (label) => {
    const l = block.map((x) => x.trim().replace(/^[-*]\s+/, '')).find((x) => x.toLowerCase().startsWith(`${label}:`));
    return l === undefined ? null : l.slice(label.length + 1).trim();
  };
  const words = (v) => {
    let s = v;
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, '');
    return s.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim().toLowerCase();
  };
  const unset = (v) => v === null || /^<[^>]*>$/.test(v);
  const ROLE = { 'close security review': ['security-review-close'], 'all security reviews': BOTH_SEC, 'security reviews': BOTH_SEC, 'architect': ['architect'], 'coach at close': ['coach'], 'coach': ['coach'], 'hard-fix escalation': ['hard-fix'] };
  const SECOND = { 'no': 'none', 'not offered': 'none', 'large/high': 'large', 'xlarge/high': 'xlarge' };
  out.rolesRaw = field('granted roles');
  if (!unset(out.rolesRaw) && !['none', ''].includes(words(out.rolesRaw))) {
    out.roles = [...new Set(words(out.rolesRaw).split(',').flatMap((t) => ROLE[t.trim()] || [`UNKNOWN ${t.trim()}`]))].sort();
  }
  const second = field('second security review');
  if (!unset(second)) out.second = SECOND[words(second)] || `UNKNOWN ${words(second)}`;
  assert(![...out.roles, out.second].some((x) => x.startsWith('UNKNOWN')), `this repo STATUS.md grant block has a word status.js does not know: ${out.roles} / ${out.second}`);
  return out;
}

test('grant: block and log agree, the free text after the roles is not read as roles, exit 0', () => {
  // The log line is built from the test's own reading of the roles line, not from status.js.
  const live = liveGrant(LIVE_TEXT);
  const lines = [[SAMPLE_ROLES, SAMPLE_ROLE_NAMES, 'sample']];
  if (live.roles.length) lines.unshift([live.rolesRaw, live.roles, 'this repo STATUS.md']);
  else console.log('       note: this repo STATUS.md grants no roles (or has no block); only the sample roles line is checked here');
  for (const [rolesLine, want, label] of lines) {
    assert(want.length > 0, `precondition: the ${label} roles line names roles`);
    const dir = project(STATUS_DOC('m1', rolesLine, 'large/high'), `${intake('m1', want, 'large')}\n`);
    const r = grantIn(dir);
    eq(r.code, 0, `${label}: ${r.out}`);
    deq(r.json.grant, { roles: want, second_review: 'large' }, `${label}: effective grant`);
    eq(r.json.milestone, 'm1', `${label}: slug from --milestone`);
  }
  // The sample's note repeats granted roles and names coach, which is not granted.
  assert(/coach at close/.test(SAMPLE_ROLES) && !SAMPLE_ROLE_NAMES.includes('coach'), 'precondition: the sample note names a role it does not grant');
});

test('grant: a role word only inside a parenthetical note is not granted', () => {
  const log = `${intake('m1', ['architect'])}\n`;
  const r = grantIn(project(STATUS_DOC('m1', 'architect (security reviews declined)', 'no'), log));
  eq(r.code, 0, `a note naming a role the log lacks must not widen the block: ${r.out}`);
  deq(r.json.block.roles, ['architect'], 'block: the note is not read');
  deq(r.json.grant.roles, ['architect'], 'grant');
  // Control: the same word outside parentheses is a role the log lacks, so it is a mismatch.
  const w = grantIn(project(STATUS_DOC('m1', 'architect, security reviews', 'no'), log));
  eq(w.code, 16, `the role word outside the note is read: ${w.out}`);
  deq(w.json.block.roles, ['architect', ...BOTH_SEC], 'block with the word outside the note');
  // A note must be parenthesised: a dash or semicolon note is read as role words and fails closed.
  for (const roles of ['architect - a note', 'architect — a note', 'architect; a note']) {
    eq(grantIn(project(STATUS_DOC('m1', roles, 'no'), log)).code, 17, `unparenthesised note "${roles}"`);
  }
});

test('grant: every role label in the template and the milestone intake question parses to a known role', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'STATUS.md'), 'utf8');
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'milestone', 'SKILL.md'), 'utf8');
  const tplLine = /^- Granted roles: (.*)$/m.exec(tpl.replace(/\r/g, ''));
  const qLine = /^\s*> Use xlarge in this milestone for: (.*)\?\s*$/m.exec(skill.replace(/\r/g, ''));
  assert(tplLine && qLine, 'precondition: both the template line and the intake question were found');
  const labels = (list) => list.replace(/^<|>$/g, '').replace(/, or none$/, '').split(/\s*\/\s*|,\s+(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
  const fromTpl = labels(tplLine[1]);
  const fromQ = labels(qLine[1]);
  assert(fromTpl.length >= 4 && fromQ.length >= 4, `precondition: four or more labels each: ${fromTpl} | ${fromQ}`);
  assert(fromTpl.length >= 5 && fromQ.length >= 5, `precondition: five or more labels each: ${fromTpl} | ${fromQ}`);
  // Both security words are offered in both places, and the older single word in neither.
  const bare = (label) => label.replace(/\s*\(.*\)$/, '');
  for (const [where, list] of [['template', fromTpl], ['intake question', fromQ]]) {
    for (const word of ['close security review', 'all security reviews']) assert(list.map(bare).includes(word), `the ${where} offers "${word}": ${list}`);
    assert(!list.map(bare).includes('security reviews'), `the ${where} no longer offers the older "security reviews": ${list}`);
  }
  const all = [...new Set([...fromTpl, ...fromQ, 'coach at close', 'security reviews'])];
  const names = new Set();
  const want = { 'close security review': ['security-review-close'], 'all security reviews': BOTH_SEC, 'security reviews': BOTH_SEC };
  for (const label of all) {
    const r = grantIn(project(STATUS_DOC('m1', label, 'no'), `${intake('m1', [])}\n`));
    assert(r.code !== 17, `label "${label}" is not a known role: ${r.out}`);
    deq(r.json.block.roles.length, (want[bare(label)] || [0]).length, `label "${label}" gives one role, or the security rows it names: ${r.out}`);
    if (want[bare(label)]) deq(r.json.block.roles, want[bare(label)], `label "${label}"`);
    for (const role of r.json.block.roles) names.add(role);
  }
  deq([...names].sort(), ['architect', 'coach', 'hard-fix', ...BOTH_SEC], 'every role is reachable from the labels');
  // The 1.2.0 coach label is a full grant when the log agrees; an unknown word still fails closed.
  const ok = grantIn(project(STATUS_DOC('m1', 'architect, coach (run for this milestone)', 'no'), `${intake('m1', ['architect', 'coach'])}\n`));
  eq(ok.code, 0, ok.out);
  deq(ok.json.grant.roles, ['architect', 'coach'], 'coach granted');
  eq(grantIn(project(STATUS_DOC('m1', 'coach (run) extra', 'no'), `${intake('m1', ['coach'])}\n`)).code, 17, 'unknown word beside a coach label');
});

test('note stripping is linear in nested parentheses: 5,000 levels finish quickly, deeper ones too', () => {
  const dir = project(STATUS_DOC('m1', `architect ${'('.repeat(5000)}note${')'.repeat(5000)}`, 'no'), `${intake('m1', ['architect'])}\n`);
  const t0 = Date.now();
  const r = grantIn(dir);
  assert(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, ['architect'], 'nested note dropped');
  const big = project(STATUS_DOC('m1', `architect ${'('.repeat(200000)}x${')'.repeat(200000)}`, 'no'), `${intake('m1', ['architect'])}\n`);
  const t1 = Date.now();
  eq(grantIn(big).code, 0, 'very deep');
  assert(Date.now() - t1 < 5000, `very deep took ${Date.now() - t1} ms`);
  // One unmatched parenthesis still fails closed.
  eq(grantIn(project(STATUS_DOC('m1', `architect ${'('.repeat(5000)}x${')'.repeat(4999)}`, 'no'), `${intake('m1', ['architect'])}\n`)).code, 17, 'unbalanced');
});

test('grant: the shipped template and this repo STATUS.md both parse', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'STATUS.md'), 'utf8');
  assert(/\*\*<slug>\*\*/.test(tpl), 'precondition: the template names the placeholder slug');
  let r = grantIn(project(tpl, null));
  eq(r.code, 0, `template with no log (its <slug> is no slug): ${r.out}`);
  deq(r.json.grant, NOTHING, 'unfilled template is an empty grant');
  assert(LIVE_TEXT !== null, 'precondition: this repo has a STATUS.md');
  const live = liveGrant(LIVE_TEXT);
  r = grantIn(project(LIVE_TEXT, null), [], live.slug || 'm1');
  if (!live.found || (!live.roles.length && live.second === 'none')) {
    console.log(`       note: this repo STATUS.md ${live.found ? 'grants nothing' : 'has no xlarge grant block'}; checking only that it parses to an empty grant`);
    eq(r.code, 0, `the repo STATUS.md, granting nothing, with no log: ${r.out}`);
    deq(r.json.grant, NOTHING, 'empty grant');
    return;
  }
  eq(r.code, 18, `the repo block grants something and there is no log: ${r.out}`);
  deq(r.json.block, { roles: live.roles, second_review: live.second }, 'the repo block, as the test reads it');
  deq(r.json.grant, NOTHING, 'nothing granted without the log');
});

test('grant: no block and no line prints an empty grant and exits 0; a missing or empty log is the same', () => {
  const doc = '# Status\n\n## Current milestone\n\n**m1**: g\n';
  for (const log of [null, '', '\n']) {
    const r = grantIn(project(doc, log));
    eq(r.code, 0, r.out);
    deq(r.json.grant, { roles: [], second_review: 'none' }, 'empty grant');
  }
  eq(grantIn(project(STATUS_DOC('m1', 'none', 'no'), null)).code, 0, 'a block that grants nothing, with no log, is fine');
});

test('grant: a role added to the block is not granted; exit 16 prints both and says use the narrower', () => {
  const dir = project(STATUS_DOC('m1', 'security reviews, architect, coach at close', 'no'), `${intake('m1', ['security-review', 'architect'])}\n`);
  const r = grantIn(dir);
  eq(r.code, 16, r.out);
  deq(r.json.block.roles, ['architect', 'coach', ...BOTH_SEC], 'block shown');
  deq(r.json.log.roles, ['architect', ...BOTH_SEC], 'log shown: the older log name reads as both security rows');
  deq(r.json.grant.roles, ['architect', ...BOTH_SEC], 'narrower');
  assert(/use the narrower; ask the user/.test(r.json.reason), r.out);
});

test('grant: a role removed from the block narrows the grant; exit 16', () => {
  const dir = project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['security-review', 'architect'])}\n`);
  const r = grantIn(dir);
  eq(r.code, 16, r.out);
  deq(r.json.grant.roles, ['architect'], 'narrower');
});

test('grant: the lower second-review tier wins, from either side; equal tiers exit 0', () => {
  let r = grantIn(project(STATUS_DOC('m1', 'architect', 'xlarge/high'), `${intake('m1', ['architect'], 'large')}\n`));
  eq(r.code, 16, r.out);
  deq(r.json.grant.second_review, 'large', 'log lower');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'large/high'), `${intake('m1', ['architect'], 'xlarge')}\n`));
  eq(r.code, 16, r.out);
  deq(r.json.grant.second_review, 'large', 'block lower');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'not offered'), `${intake('m1', ['architect'], 'none')}\n`));
  eq(r.code, 0, `"not offered" is none: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'none', 'large/high'), null));
  eq(r.code, 18, `a second review in the block with no log line: ${r.out}`);
});

test('grant: a forged block with no log line exits 18 and grants nothing', () => {
  const dir = project(STATUS_DOC('m1', 'security reviews, architect', 'xlarge/high'), `${intake('other', ['architect'])}\n`);
  const r = grantIn(dir);
  eq(r.code, 18, r.out);
  deq(r.json.grant, { roles: [], second_review: 'none' }, 'nothing granted');
  eq(grantIn(project(STATUS_DOC('m1', 'architect', 'no'), null)).code, 18, 'log file missing');
});

test('grant: an unknown role token or tier word in the block exits 17', () => {
  const log = `${intake('m1', ['architect'])}\n`;
  for (const roles of ['architect, everything', 'architects', 'architect and coach at close', 'architect (x']) {
    const r = grantIn(project(STATUS_DOC('m1', roles, 'no'), log));
    eq(r.code, 17, `${roles}: ${r.out}`);
  }
  eq(grantIn(project(STATUS_DOC('m1', 'architect', 'maybe'), log)).code, 17, 'tier word');
  const twice = STATUS_DOC('m1', 'architect', 'no').replace('- Map source', '- Granted roles: architect, coach at close\n- Map source');
  eq(grantIn(project(twice, log)).code, 17, 'roles line twice');
});

test('grant: a line before the slug\'s first line that is not a JSON object exits 19, whatever it mentions', () => {
  const doc = STATUS_DOC('m1', 'architect', 'no');
  const torn = '{"ts":"t","milestone":"m1","xlarge_grant":["archi';
  let r = grantIn(project(doc, `${torn}\n${intake('m1', ['architect'])}\n`));
  eq(r.code, 19, `torn line mentioning the slug, a later line says the same: ${r.out}`);
  // Residual b of decision 0026: torn before the slug ends, so the raw text does not name it.
  // The later line is the forgery: it grants more than the line that was torn.
  const wide = STATUS_DOC('cur', WIDE_WORDS, 'xlarge/high');
  r = grantIn(project(wide, `{"milestone":"cu\n${intake('cur', WIDE, 'xlarge')}\n`), [], 'cur');
  eq(r.code, 19, `torn before the slug ends: ${r.out}`);
  eq(r.json.grant, undefined, 'no grant is printed');
  assert(/line 1 of .*is not a JSON object/.test(r.json.reason), r.out);
  const others = {
    'torn in another slug (it could have gone on to repeat the key)': '{"ts":"t","milestone":"zz","xl',
    'torn before any key': '{',
    'a JSON value that is not an object': '123',
    'an array': '[{"milestone":"m1"}]',
    'not JSON at all': 'hello',
  };
  for (const [label, line] of Object.entries(others)) {
    r = grantIn(project(doc, `${line}\n${intake('m1', ['architect'])}\n`));
    eq(r.code, 19, `${label}: ${r.out}`);
  }
  // A bad line after the slug's first line is refused too (decision 0029, amended): every line
  // for the slug counts now, so a line that could have been one is never skipped.
  r = grantIn(project(doc, `\n${intake('zz', ['coach'])}\n\n${intake('m1', ['architect'])}\n{"milestone":"m\n`));
  eq(r.code, 19, `a torn line after the first line for the slug: ${r.out}`);
  assert(/line 5 of .*is not a JSON object/.test(r.json.reason), r.out);
  eq(r.json.grant, undefined, 'no grant is printed');
  // Control: blank lines are not lines.
  r = grantIn(project(doc, `\n${intake('zz', ['coach'])}\n\n${intake('m1', ['architect'])}\n\n`));
  eq(r.code, 0, `blank lines around the lines: ${r.out}`);
  deq(r.json.grant.roles, ['architect'], 'the line for the slug');
  r = grantIn(project(doc, `${intake('m1', ['bogus'])}\n`));
  eq(r.code, 19, `bad role in the log: ${r.out}`);
  r = grantIn(project(doc, `${intake('m1', ['architect'], 'huge')}\n`));
  eq(r.code, 19, `bad tier in the log: ${r.out}`);
});

test('grant: a first line that names the slug but parses to another milestone exits 19', () => {
  const later = `${intake('m1', ['architect'])}\n`;
  const doc = STATUS_DOC('m1', 'architect', 'no');
  const bad = {
    'repeated key': '{"milestone":"m1","milestone":"x","xlarge_grant":[],"second_review":"none"}',
    'repeated key, spaced': '{"milestone" : "m1", "milestone":"x","xlarge_grant":[],"second_review":"none"}',
    'escaped key and value': '{"mil\\u0065stone":"m\\u0031","milestone":"x","xlarge_grant":[],"second_review":"none"}',
    'non-string milestone': '{"milestone":["m1"],"xlarge_grant":[],"second_review":"none"}',
  };
  for (const [label, line] of Object.entries(bad)) {
    const o = JSON.parse(line);
    assert(o.milestone !== 'm1', `precondition (${label}): JSON.parse does not read it as m1`);
    const r = grantIn(project(doc, `${line}\n${later}`));
    eq(r.code, 19, `${label}: ${r.out}`);
    assert(/names "m1"/.test(r.json.reason), `${label}: reason: ${r.out}`);
  }
  // Controls: lines for other slugs that only mention m1, or share its prefix, are skipped.
  const fine = [
    intake('m10', ['coach']),
    '{"milestone":"zz","note":"after m1","xlarge_grant":[],"second_review":"none"}',
    '{"milestone":"zz","m1":"milestone","xlarge_grant":[],"second_review":"none"}',
  ].join('\n');
  const r = grantIn(project(doc, `${fine}\n${later}`));
  eq(r.code, 0, `other slugs are skipped: ${r.out}`);
  deq(r.json.grant, { roles: ['architect'], second_review: 'none' }, 'the m1 line');
});

test('grant: two milestones in one log; --milestone picks the line', () => {
  const log = `${intake('m1', ['architect'])}\n${intake('m2', ['coach'], 'xlarge')}\n`;
  let r = grantIn(project(STATUS_DOC('m2', 'coach (run for this milestone)', 'xlarge/high'), log), [], 'm2');
  eq(r.code, 0, r.out);
  deq(r.json.grant, { roles: ['coach'], second_review: 'xlarge' }, 'm2');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), log), [], 'm1');
  eq(r.code, 0, r.out);
  deq(r.json.grant, { roles: ['architect'], second_review: 'none' }, 'm1');
});

// The reviewer's attack: STATUS.md is pointed at an earlier milestone whose first line granted more,
// and that grant is copied into the block. The Director's own slug is "cur".
const SWAP_LOG = `${intake('old', WIDE, 'xlarge')}\n${intake('cur', [])}\n`;

test('grant: a STATUS.md slug other than --milestone exits 20, prints both and grants nothing', () => {
  const swapped = STATUS_DOC('old', WIDE_WORDS, 'xlarge/high');
  const pre = grantIn(project(swapped, SWAP_LOG), [], 'old');
  eq(pre.code, 0, `precondition: the swapped file agrees with the old line: ${pre.out}`);
  deq(pre.json.grant.roles, WIDE, 'precondition: the old line grants every role');
  const r = grantIn(project(swapped, SWAP_LOG), [], 'cur');
  eq(r.code, 20, `slug swap: ${r.out}`);
  eq(r.json.ok, false, 'not ok');
  eq(r.json.milestone, 'cur', 'the Director slug is shown');
  eq(r.json.status_milestone, 'old', 'the STATUS.md slug is shown');
  assert(/"old"/.test(r.json.reason) && /"cur"/.test(r.json.reason), `the reason names both: ${r.json.reason}`);
  deq(r.json.grant, NOTHING, 'nothing granted');
  // One step past: dropping the Current milestone section does not help; the cur line is read.
  const headless = swapped.replace(/## Current milestone\n\n\*\*old\*\*: a goal\nBranch: `milestone\/old`\n\n/, '');
  assert(!/Current milestone/.test(headless), 'precondition: the section is gone');
  const h = grantIn(project(headless, SWAP_LOG), [], 'cur');
  eq(h.code, 16, `no section, the cur line says nothing: ${h.out}`);
  deq(h.json.grant, NOTHING, 'narrowed to the cur line');
  // Recovery control: STATUS.md names cur and copies the cur grant.
  const ok = grantIn(project(STATUS_DOC('cur', 'none', 'no'), SWAP_LOG), [], 'cur');
  eq(ok.code, 0, `matching slug: ${ok.out}`);
  deq(ok.json.grant, NOTHING, 'the cur grant');
});

test('grant: --milestone is required (exit 2, nothing read)', () => {
  const dir = project(STATUS_DOC('cur', WIDE_WORDS, 'xlarge/high'), SWAP_LOG);
  for (const args of [['grant'], ['grant', '--file', path.join(dir, 'STATUS.md')]]) {
    const r = run(args, dir, { CLAUDE_PROJECT_DIR: dir });
    eq(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert(r.json && r.json.ok === false && /--milestone is required/.test(r.json.reason), `usage reason: ${r.out}`);
    eq(r.json.grant, undefined, 'no grant printed');
  }
  eq(run(['grant', '--milestone'], dir).code, 2, 'value missing');
  eq(run(['grant', '--milestone', ' '], dir).code, 2, 'blank slug');
});

test('grant: two Current milestone headings or two bold slug lines exit 17, whichever comes first', () => {
  const block = BLOCK(WIDE_WORDS, 'xlarge/high');
  const docs = {
    'two headings': `# Status\n\n## Current milestone\n\n**cur**: g\n\n## Current milestone\n\n**old**: g\n\n${block}`,
    'two headings, same slug': `# Status\n\n## Current milestone\n\n**cur**: g\n\n## current milestone\n\n**cur**: g\n\n${block}`,
    'two bold lines': `# Status\n\n## Current milestone\n\n**cur**: g\n**old**: g\n\n${block}`,
    'two bold lines, old first': `# Status\n\n## Current milestone\n\n**old**: g\n\n**cur**: g\n\n${block}`,
  };
  for (const [label, doc] of Object.entries(docs)) {
    const r = grantIn(project(doc, SWAP_LOG), [], 'cur');
    eq(r.code, 17, `${label}: ${r.out}`);
    assert(/Current milestone/.test(r.json.reason), `${label}: reason: ${r.out}`);
  }
  // Control: one heading and one bold line, with the cur grant, passes.
  const one = grantIn(project(`# Status\n\n## Current milestone\n\n**cur**: g\n- **In scope:** x\n\n${BLOCK('none', 'no')}`, SWAP_LOG), [], 'cur');
  eq(one.code, 0, `one slug (a bold label inside a bullet is not a slug line): ${one.out}`);
});

// Decision 0026 item 1 as amended by decision 0029: the first line wins among lines that agree.
// A later line that grants something else used to be ignored; it now stops the grant, because the
// line that came first cannot be told from the user's answer (tests/fu22-intake-line.test.js).
test('grant: a later line for the same slug that grants something else exits 23, whether it widens or narrows', () => {
  const dir = project(STATUS_DOC('m1', 'architect, coach at close', 'xlarge/high'), `${intake('m1', ['architect'])}\n${intake('m1', ['architect', 'coach'], 'xlarge')}\n`);
  let r = grantIn(dir);
  eq(r.code, 23, `a later widening line: ${r.out}`);
  deq(r.json.grant, NOTHING, 'nothing is granted, not the first line and not the narrower');
  eq(r.json.log, null, 'neither line is the log\'s answer');
  deq(r.json.log_lines, [{ line: 1, roles: ['architect'], second_review: 'none' }, { line: 2, roles: ['architect', 'coach'], second_review: 'xlarge' }], 'both are listed');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['architect'])}\n${intake('m1', [])}\n`));
  eq(r.code, 23, `a later narrowing line: ${r.out}`);
  deq(r.json.grant, NOTHING, 'nothing is granted');
  // A later line that says the same is a repeat: the first line still holds.
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['architect'])}\n${intake('m2', ['coach'])}\n${intake('m1', ['architect'])}\n`));
  eq(r.code, 0, `a repeat of the first line: ${r.out}`);
  deq(r.json.grant, { roles: ['architect'], second_review: 'none' }, 'the grant both lines state');
});

test('grant: CRLF in the log and the file, and a slug with regex metacharacters', () => {
  const slug = 'a.b+(c)[d]';
  let r = grantIn(project(STATUS_DOC('m1', 'architect', 'no', '\r\n'), `${intake('m1', ['architect'])}\r\n`));
  eq(r.code, 0, `CRLF: ${r.out}`);
  r = grantIn(project(STATUS_DOC(slug, 'architect', 'no'), `${intake('aXb+(c)[d]', ['coach'])}\n${intake(slug, ['architect'])}\n`), [], slug);
  eq(r.code, 0, `metacharacter slug is compared as a string: ${r.out}`);
  eq(r.json.milestone, slug, 'slug');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m.', ['coach'])}\n`));
  eq(r.code, 18, 'a regex-like neighbour does not match');
});

test('grant: in a linked worktree it reads the main checkout logs', () => {
  const main = path.join(DIR, 'wt-main');
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'STATUS.md'), STATUS_DOC('m1', 'architect', 'no'));
  g(main, 'add', 'STATUS.md');
  g(main, 'commit', '-q', '-m', 'x');
  fs.mkdirSync(path.join(main, '.agent-team', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(main, '.agent-team', 'logs', 'milestones.jsonl'), `${intake('m1', ['architect'])}\n`);
  const wt = path.join(DIR, 'wt-linked');
  g(main, 'worktree', 'add', '-q', '-b', 'wtb', wt);
  assert(fs.statSync(path.join(wt, '.git')).isFile(), 'precondition: a linked worktree');
  assert(!fs.existsSync(path.join(wt, '.agent-team')), 'precondition: no logs inside the worktree');
  const r = run(['grant', '--milestone', 'm1'], wt, { CLAUDE_PROJECT_DIR: wt });
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, ['architect'], 'read from the main checkout');
});

// ---- the two security words (decisions 0028 and 0029) ----

test('grant: "close security review" and "all security reviews" print distinct roles', () => {
  const CLOSE = ['security-review-close'];
  const one = (words, logRoles) => grantIn(project(STATUS_DOC('m1', words, 'no'), `${intake('m1', logRoles)}\n`));
  let r = one('close security review', CLOSE);
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, CLOSE, 'the close word grants the close row only');
  r = one('all security reviews', BOTH_SEC);
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, BOTH_SEC, 'the all word grants both rows');
  // A note cannot widen the close word: this is the note the coach-followups milestone relied on, turned round.
  r = one('close security review (and flagged task PRs, all security reviews)', CLOSE);
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, CLOSE, 'a note beside the close word grants nothing more');
  // Both options ticked is the wider one.
  r = one('close security review, all security reviews, architect', ['architect', ...BOTH_SEC]);
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, ['architect', ...BOTH_SEC], 'both words');
});

test('grant: the block cannot widen close-only to all, and the narrower of the two holds either way; exit 16', () => {
  const CLOSE = ['security-review-close'];
  // The attack the two words exist for: the user granted the close review, the block says all.
  let r = grantIn(project(STATUS_DOC('m1', 'all security reviews', 'no'), `${intake('m1', CLOSE)}\n`));
  eq(r.code, 16, r.out);
  deq(r.json.block.roles, BOTH_SEC, 'block shown');
  deq(r.json.log.roles, CLOSE, 'log shown');
  deq(r.json.grant.roles, CLOSE, 'flagged task PRs are not granted');
  r = grantIn(project(STATUS_DOC('m1', 'close security review', 'no'), `${intake('m1', BOTH_SEC)}\n`));
  eq(r.code, 16, r.out);
  deq(r.json.grant.roles, CLOSE, 'a narrowed block narrows');
});

test('grant: the older word "security reviews" and the older log name "security-review" still mean both rows', () => {
  let r = grantIn(project(STATUS_DOC('m1', 'security reviews', 'no'), `${intake('m1', ['security-review'])}\n`));
  eq(r.code, 0, `an untouched 1.1.0 project: ${r.out}`);
  deq(r.json.grant.roles, BOTH_SEC, 'both rows, under the new names');
  assert(!JSON.stringify(r.json).includes('"security-review"'), `the older name is never printed: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'security reviews', 'no'), `${intake('m1', BOTH_SEC)}\n`));
  eq(r.code, 0, `older block, new log: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'close security review', 'no'), `${intake('m1', ['security-review'])}\n`));
  eq(r.code, 16, `new close-only block, older log: ${r.out}`);
  deq(r.json.grant.roles, ['security-review-close'], 'narrower');
  // No intake answer grants task PRs without the close review; such a line is not an intake line.
  r = grantIn(project(STATUS_DOC('m1', 'all security reviews', 'no'), `${intake('m1', ['security-review-task'])}\n`));
  eq(r.code, 19, `task without close in the log: ${r.out}`);
});

// ---- where the log is read from (decision 0029, residual d) ----

// Two repositories: "mine" grants architect, "other" grants everything. The block in mine is forged wide.
function twoProjects() {
  const mk = (name, logRoles) => {
    const dir = path.join(DIR, `${name}${projN++}`);
    fs.mkdirSync(dir);
    g(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'STATUS.md'), STATUS_DOC('m1', WIDE_WORDS, 'no'));
    g(dir, 'add', 'STATUS.md');
    g(dir, 'commit', '-q', '-m', 'x');
    fs.mkdirSync(path.join(dir, '.agent-team', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agent-team', 'logs', 'milestones.jsonl'), `${intake('m1', logRoles)}\n`);
    return dir;
  };
  return { mine: mk('mine', ['architect']), other: mk('other', WIDE) };
}

test('grant: GIT_DIR and GIT_WORK_TREE in the caller env do not move the log it reads', () => {
  const { mine, other } = twoProjects();
  const env = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other };
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: mine, encoding: 'utf8', env: { ...GIT_ENV, ...env } }).stdout.trim();
  eq(fs.realpathSync.native(top), fs.realpathSync.native(other), 'precondition: plain git in mine follows GIT_DIR to other');
  const pre = run(['grant', '--milestone', 'm1'], other);
  eq(pre.code, 0, `precondition: other's own log backs the wide block: ${pre.out}`);
  const r = run(['grant', '--milestone', 'm1'], mine, env);
  eq(r.code, 16, `mine's log is read, and it grants less than the block: ${r.out}`);
  deq(r.json.log.roles, ['architect'], 'the log of the cwd project');
  deq(r.json.grant.roles, ['architect'], 'narrower');
});

test('grant: CLAUDE_PROJECT_DIR may agree with the cwd but cannot move the log; another project exits 22', () => {
  const { mine, other } = twoProjects();
  const r = run(['grant', '--milestone', 'm1'], mine, { CLAUDE_PROJECT_DIR: other });
  eq(r.code, 22, r.out);
  deq(r.json.grant, NOTHING, 'nothing granted');
  assert(r.json.reason.includes('CLAUDE_PROJECT_DIR') && r.json.reason.includes('ask the user'), r.out);
  // Agreeing values: the project itself, a folder inside it, and unset.
  fs.mkdirSync(path.join(mine, 'sub'));
  for (const [label, env, cwd] of [['same folder', { CLAUDE_PROJECT_DIR: mine }, mine], ['a subfolder of the project', { CLAUDE_PROJECT_DIR: path.join(mine, 'sub') }, mine], ['cwd in a subfolder', { CLAUDE_PROJECT_DIR: mine }, path.join(mine, 'sub')], ['unset', {}, mine]]) {
    const ok = run(['grant', '--milestone', 'm1', '--file', path.join(mine, 'STATUS.md')], cwd, env);
    eq(ok.code, 16, `${label}: mine's log is read: ${ok.out}`);
    deq(ok.json.grant.roles, ['architect'], label);
  }
});

test('--since: core.worktree naming another repository does not move the check', () => {
  const a = repo();
  const b = repo();
  fs.appendFileSync(path.join(a.dir, 'a.txt'), 'x\n');
  const code = commit(a.dir);
  fs.appendFileSync(path.join(a.dir, 'STATUS.md'), 'y\n');
  const stat = commit(a.dir);
  g(a.dir, 'config', 'core.worktree', b.dir);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: b.dir, encoding: 'utf8', env: { ...GIT_ENV, GIT_DIR: path.join(a.dir, '.git') } }).stdout.trim();
  eq(fs.realpathSync.native(top), fs.realpathSync.native(b.dir), 'precondition: a\'s top level is now b');
  // Before, the check hopped to that top level and ran in b, where a's commits do not exist (exit 15).
  let r = run(['--check', '--since', a.base, '--head', code], a.dir);
  eq(r.code, 14, `a code change in a is still seen: ${r.out}`);
  assert(/a\.txt/.test(r.json.reason), r.out);
  r = run(['--check', '--since', code, '--head', stat], a.dir);
  eq(r.code, 0, `a status-only change in a still passes: ${r.out}`);
});

test('grant and --since keep the usage rules', () => {
  eq(run(['grant', '--milestone', 'm1', 'extra']).code, 2, 'extra word');
  eq(run(['grant', '--milestone', 'm1', '--check']).code, 2, 'grant with --check');
  eq(run(['grant', '--milestone', 'm1', '--state', 'x']).code, 2, 'grant with --state');
  eq(run(['set', 'T-1', '--state', 'merged', '--milestone', 'x']).code, 2, 'set with --milestone');
  eq(run(['grant', '--milestone', '']).code, 2, 'empty slug');
});
