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

test('set reads the file back: a corrupted write is detected and the original restored', () => {
  const f = fixture(FIXTURE);
  const real = fs.writeFileSync;
  let hits = 0;
  fs.writeFileSync = (p, data, ...rest) => real(p, hits++ === 0 ? `X${data}` : data, ...rest);
  let code;
  try { code = status.main(['set', 'T-1', '--state', 'merged', '--file', f], { out: () => {} }); } finally { fs.writeFileSync = real; }
  eq(hits, 2, 'a write was made, then the restore');
  eq(code, 11, 'exit');
  eq(fs.readFileSync(f, 'utf8'), FIXTURE, 'original restored');
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
