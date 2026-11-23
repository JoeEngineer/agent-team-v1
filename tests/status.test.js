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

test('set reads the file back: a corrupted write is detected and the original restored', () => {
  const f = fixture(FIXTURE);
  const real = fs.writeFileSync;
  let hits = 0;
  fs.writeFileSync = (p, data, ...rest) => real(p, hits++ === 0 ? `X${data}` : data, ...rest);
  let r;
  try { r = withStub('renameSync', (rn) => rn, ['set', 'T-1', '--state', 'merged', '--file', f]); } finally { fs.writeFileSync = real; }
  eq(hits, 2, 'a write was made, then the restore');
  eq(r.code, 11, 'exit');
  assert(r.json.reason.includes('the original was restored'), r.out);
  eq(fs.readFileSync(f, 'utf8'), FIXTURE, 'original restored');
  noTemp('read-back');
});

test('set reports the original as NOT restored when the restore itself fails', () => {
  const f = fixture(FIXTURE);
  const real = fs.writeFileSync;
  let writes = 0;
  let renames = 0;
  fs.writeFileSync = (p, data, ...rest) => real(p, writes++ === 0 ? `X${data}` : data, ...rest);
  let r;
  try {
    r = withStub('renameSync', (rn) => (a, b) => { if (++renames === 2) { assert(fs.existsSync(a), 'the restore temp file exists when the rename fails'); throw eperm(); } return rn(a, b); }, ['set', 'T-1', '--state', 'merged', '--file', f]);
  } finally { fs.writeFileSync = real; }
  eq(writes, 2, 'precondition: the first write and the restore were both made');
  eq(renames, 2, 'precondition: the restore rename was reached');
  eq(r.code, 11, 'exit');
  assert(r.json.reason.includes('could NOT be restored') && !r.json.reason.includes('was restored'), r.out);
  assert(fs.readFileSync(f, 'utf8').startsWith('X'), 'the corrupted file is what is left, and the reason says so');
  noTemp('failed restore');
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
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-nogit-'));
  const r = run(['--check', '--since', base], nogit, { GIT_CEILING_DIRECTORIES: path.dirname(nogit) });
  eq(r.code, 15, `outside a repo: ${r.out}`);
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
  assert(/execFileSync\('git', args/.test(src), 'execFileSync with an argv array');
  assert(!/(^|[^.\w])exec\(|\bexecSync\b|shell\s*:/m.test(src), 'no exec, execSync or shell option');
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
const grantIn = (dir, extra = []) => run(['grant', ...extra], dir, { CLAUDE_PROJECT_DIR: dir });
// The "Granted roles" line of this repo's STATUS.md, read live so the test cannot drift from it.
// A checkout whose STATUS.md has no such line falls back to a sample with the same shape.
const SAMPLE_ROLES = 'security reviews, architect, hard-fix escalation (a note that repeats security reviews and coach at close; the close review stays xlarge/high)';
const LIVE_STATUS = path.join(ROOT, 'STATUS.md');
const LIVE_ROLES_LINE = (fs.existsSync(LIVE_STATUS) ? (fs.readFileSync(LIVE_STATUS, 'utf8').match(/^[-*]\s+Granted roles:[ \t]*(.+)$/m) || [])[1] : undefined);
const REPO_ROLES = LIVE_ROLES_LINE ? LIVE_ROLES_LINE.trim() : SAMPLE_ROLES;

test('grant: block and log agree, the free text after the roles is not read as roles, exit 0', () => {
  // The log roles are what the script reads from the block itself (no log: exit 18 shows the block).
  const probe = grantIn(project(STATUS_DOC('m1', REPO_ROLES, 'large/high'), null));
  eq(probe.code, 18, `precondition: the block grants roles and the log is missing: ${probe.out}`);
  assert(probe.json.block.roles.length > 0, 'precondition: the block names roles');
  const dir = project(STATUS_DOC('m1', REPO_ROLES, 'large/high'), `${intake('m1', probe.json.block.roles, 'large')}\n`);
  const r = grantIn(dir);
  eq(r.code, 0, r.out);
  deq(r.json.grant, { roles: probe.json.block.roles, second_review: 'large' }, 'effective grant');
  eq(r.json.milestone, 'm1', 'slug from the Current milestone heading');
  // The fallback sample has the same shape: a note that repeats granted roles and names one that is not.
  const s = grantIn(project(STATUS_DOC('m1', SAMPLE_ROLES, 'large/high'), `${intake('m1', ['security-review', 'architect', 'hard-fix'], 'large')}\n`));
  eq(s.code, 0, `sample note: ${s.out}`);
  deq(s.json.grant.roles, ['architect', 'hard-fix', 'security-review'], 'the note names coach but coach is not granted');
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
  deq(w.json.block.roles, ['architect', 'security-review'], 'block with the word outside the note');
  // A note must be parenthesised: a dash or semicolon note is read as role words and fails closed.
  for (const roles of ['architect - a note', 'architect — a note', 'architect; a note']) {
    eq(grantIn(project(STATUS_DOC('m1', roles, 'no'), log)).code, 17, `unparenthesised note "${roles}"`);
  }
});

test('grant: the shipped template and this repo STATUS.md both parse', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'project', 'STATUS.md'), 'utf8');
  let r = grantIn(project(tpl, null));
  eq(r.code, 0, `template with no log: ${r.out}`);
  deq(r.json.grant, { roles: [], second_review: 'none' }, 'unfilled template is an empty grant');
  const live = fs.readFileSync(path.join(ROOT, 'STATUS.md'), 'utf8');
  r = grantIn(project(live, null));
  eq(r.code, 18, `the repo block grants roles and there is no log: ${r.out}`);
  deq(r.json.block.roles, ['architect', 'hard-fix', 'security-review'], 'the repo block roles');
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
  deq(r.json.block.roles, ['architect', 'coach', 'security-review'], 'block shown');
  deq(r.json.log.roles, ['architect', 'security-review'], 'log shown');
  deq(r.json.grant.roles, ['architect', 'security-review'], 'narrower');
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

test('grant: a torn first log line that could be the intake line exits 19; one for another milestone is skipped', () => {
  const torn = '{"ts":"t","milestone":"m1","xlarge_grant":["archi';
  let r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${torn}\n${intake('m1', ['architect'])}\n`));
  eq(r.code, 19, `torn line mentioning the slug, a later line says the same: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `{"ts":"t","milestone":"zz","xl\n${intake('m1', ['architect'])}\n`));
  eq(r.code, 0, `torn line for another slug: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['bogus'])}\n`));
  eq(r.code, 19, `bad role in the log: ${r.out}`);
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['architect'], 'huge')}\n`));
  eq(r.code, 19, `bad tier in the log: ${r.out}`);
});

test('grant: two milestones in one log; --milestone picks the slug; the heading picks it otherwise', () => {
  const log = `${intake('m1', ['architect'])}\n${intake('m2', ['coach'], 'xlarge')}\n`;
  const dir = project(STATUS_DOC('m2', 'coach at close', 'xlarge/high'), log);
  let r = grantIn(dir);
  eq(r.code, 0, r.out);
  deq(r.json.grant, { roles: ['coach'], second_review: 'xlarge' }, 'm2 from the heading');
  r = grantIn(dir, ['--milestone', 'm1']);
  eq(r.code, 16, `m1 against the m2 block: ${r.out}`);
  eq(r.json.milestone, 'm1', 'slug from --milestone');
});

test('grant: a later line for the same slug is ignored, whether it widens or narrows', () => {
  const dir = project(STATUS_DOC('m1', 'architect, coach at close', 'xlarge/high'), `${intake('m1', ['architect'])}\n${intake('m1', ['architect', 'coach'], 'xlarge')}\n`);
  let r = grantIn(dir);
  eq(r.code, 16, `the first line (architect, none) is the answer: ${r.out}`);
  deq(r.json.grant, { roles: ['architect'], second_review: 'none' }, 'first line wins');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m1', ['architect'])}\n${intake('m1', [])}\n`));
  eq(r.code, 0, `a later narrowing line is ignored too: ${r.out}`);
});

test('grant: CRLF in the log and the file, and a slug with regex metacharacters', () => {
  const slug = 'a.b+(c)[d]';
  let r = grantIn(project(STATUS_DOC('m1', 'architect', 'no', '\r\n'), `${intake('m1', ['architect'])}\r\n`));
  eq(r.code, 0, `CRLF: ${r.out}`);
  r = grantIn(project(STATUS_DOC(slug, 'architect', 'no'), `${intake('aXb+(c)[d]', ['coach'])}\n${intake(slug, ['architect'])}\n`));
  eq(r.code, 0, `metacharacter slug is compared as a string: ${r.out}`);
  eq(r.json.milestone, slug, 'slug');
  r = grantIn(project(STATUS_DOC('m1', 'architect', 'no'), `${intake('m.', ['coach'])}\n`), ['--milestone', 'm1']);
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
  const r = run(['grant'], wt, { CLAUDE_PROJECT_DIR: wt });
  eq(r.code, 0, r.out);
  deq(r.json.grant.roles, ['architect'], 'read from the main checkout');
});

test('grant and --since keep the usage rules', () => {
  eq(run(['grant', 'extra']).code, 2, 'extra word');
  eq(run(['grant', '--check']).code, 2, 'grant with --check');
  eq(run(['grant', '--state', 'x']).code, 2, 'grant with --state');
  eq(run(['set', 'T-1', '--state', 'merged', '--milestone', 'x']).code, 2, 'set with --milestone');
  eq(run(['grant', '--milestone', '']).code, 2, 'empty slug');
});
