// Tests for scripts/archive-logs.js. All archives go to temp dirs; never the real ~/.agent-team.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { SCRIPTS, tmpProject, test, assert, eq } = require('./helpers');

const SCRIPT = path.join(SCRIPTS, 'archive-logs.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-arch-'));

function arch(proj, args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, AGENT_TEAM_ARCHIVE: tmp(), ...env },
  });
}
function project(files = { 'delegations.jsonl': '' }) {
  const p = tmpProject();
  const d = path.join(p, '.agent-team', 'logs');
  fs.mkdirSync(path.join(d, '.pending'), { recursive: true });
  fs.writeFileSync(path.join(d, '.gitkeep'), '');
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return p;
}
const rec = (m, v = '0.3.0') => JSON.stringify({ guidance_version: v, task: { milestone: m } });
const destOf = (r) => r.stdout.trim().split('\n').pop();
const logs = (p) => path.join(p, '.agent-team', 'logs');

test('archive: copies, writes README, leaves originals', () => {
  const content = [rec('m1'), rec('m2', '0.2.1'), 'not json', ''].join('\n');
  const p = project({ 'a.jsonl': content, 'empty.jsonl': '' });
  const r = arch(p, ['m1', '--project', 'proj']);
  eq(r.status, 0, r.stderr);
  const dest = destOf(r);
  assert(/proj[\\/]\d{4}-\d\d-\d\d-m1$/.test(dest), dest);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), content, 'copy');
  assert(fs.existsSync(path.join(dest, 'empty.jsonl')), 'empty copied');
  assert(!fs.existsSync(path.join(dest, '.gitkeep')), 'gitkeep not copied');
  assert(!fs.existsSync(path.join(dest, '.pending')), 'pending not copied');
  const md = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
  assert(/^# agent-team logs — milestone m1 \(\d{4}-\d\d-\d\d\)/.test(md), 'title');
  assert(md.includes('Project: proj'), 'project');
  assert(md.includes('0.2.1, 0.3.0'), 'versions');
  assert(md.includes('`a.jsonl`: 3 line(s), 1 for milestone `m1`, 1 malformed'), md);
  assert(md.includes('`empty.jsonl`: 0 line(s)'), 'empty');
  assert(md.includes('Originals left in place.'), 'left');
  assert(md.includes('`.pending/` was not copied'), 'pending note');
  assert(!md.includes(os.tmpdir()), 'no absolute paths');
  eq(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8'), content, 'original untouched');
});

test('archive: stale .pending removed, fresh kept, logs untouched', () => {
  const p = project();
  const pd = path.join(logs(p), '.pending');
  const old = path.join(pd, 'old');
  const fresh = path.join(pd, 'fresh');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const t = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(old, t, t);
  const r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(old), 'stale deleted');
  assert(fs.existsSync(fresh), 'fresh kept');
  assert(r.stdout.includes('deleted 1 stale, kept 1'), r.stdout);
  assert(fs.existsSync(path.join(logs(p), 'delegations.jsonl')), 'log kept');
});

const leftovers = (root) => fs.readdirSync(path.join(root, 'x')).filter((n) => n.includes('.tmp-'));

test('archive: existing destination refused, nothing changed; --force replaces only the files it writes', () => {
  const content = rec('m') + '\n';
  const p = project({ 'a.jsonl': content });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root];
  const first = arch(p, args);
  eq(first.status, 0, first.stderr);
  const dest = destOf(first);
  fs.writeFileSync(path.join(dest, 'marker'), 'x');
  fs.mkdirSync(path.join(dest, 'notes'));
  fs.writeFileSync(path.join(dest, 'notes', 'n.txt'), 'keep');
  fs.writeFileSync(path.join(dest, 'other.jsonl'), 'not ours');
  fs.writeFileSync(path.join(dest, 'a.jsonl'), 'stale copy');
  fs.writeFileSync(path.join(dest, 'README.md'), 'old readme');
  const again = arch(p, args);
  eq(again.status, 1, 'refused');
  assert(/already exists/.test(again.stderr), again.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), 'stale copy', 'untouched on refusal');
  eq(leftovers(root).length, 0, 'no temp folder after refusal');
  const forced = arch(p, [...args, '--force']);
  eq(forced.status, 0, forced.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), content, 'copied file replaced');
  assert(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').includes('Project: x'), 'README replaced');
  eq(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'x', 'unrelated file survives');
  eq(fs.readFileSync(path.join(dest, 'notes', 'n.txt'), 'utf8'), 'keep', 'unrelated folder survives');
  eq(fs.readFileSync(path.join(dest, 'other.jsonl'), 'utf8'), 'not ours', 'unrelated jsonl survives');
  eq(leftovers(root).length, 0, 'no temp folder after --force');
});

test('archive: verify failure (fresh) removes the temp copy and leaves no destination', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root];
  const r = arch(p, args, { AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY: '1' });
  eq(r.status, 1, 'failed');
  // Precondition: the failure came from the verify step, which runs after the file was copied.
  assert(/verification failed for a\.jsonl/.test(r.stderr), r.stderr);
  assert(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
  eq(fs.readdirSync(path.join(root, 'x')).length, 0, 'no dest and no temp folder');
  eq(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8'), rec('m') + '\n', 'live log untouched');
  // One step past: a clean retry works.
  const retry = arch(p, args);
  eq(retry.status, 0, retry.stderr);
});

test('archive: verify failure with --force leaves the old archive intact and no temp copy', () => {
  const p = project({ 'a.jsonl': rec('new') + '\n' });
  const root = tmp();
  const args = ['m', '--project', 'x', '--root', root, '--force'];
  const first = arch(p, args);
  eq(first.status, 0, first.stderr);
  const dest = destOf(first);
  fs.writeFileSync(path.join(dest, 'marker'), 'x');
  fs.writeFileSync(path.join(dest, 'a.jsonl'), 'old archive data');
  const readmeBefore = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
  const r = arch(p, args, { AGENT_TEAM_ARCHIVE_TEST_FAIL_VERIFY: '1' });
  eq(r.status, 1, 'failed');
  assert(/verification failed for a\.jsonl/.test(r.stderr), r.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), 'old archive data', 'old copy intact');
  eq(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'x', 'unrelated file intact');
  eq(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), readmeBefore, 'old README intact');
  eq(leftovers(root).length, 0, 'no temp folder');
  // One step past: a clean --force retry now replaces the copy.
  const retry = arch(p, args);
  eq(retry.status, 0, retry.stderr);
  eq(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8'), rec('new') + '\n', 'replaced on retry');
});

test('archive: --clear skips a live log that changed after verification, deletes the unchanged ones', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n', 'b.jsonl': rec('m') + '\n' });
  const r = arch(p, ['m', '--project', 'x', '--clear'], { AGENT_TEAM_ARCHIVE_TEST_APPEND_AFTER_VERIFY: 'a.jsonl' });
  eq(r.status, 0, r.stderr);
  // Precondition: the late write really landed in the live log.
  assert(fs.readFileSync(path.join(logs(p), 'a.jsonl'), 'utf8').includes('late write'), 'late write present');
  assert(/Not cleared.*a\.jsonl/.test(r.stdout), r.stdout);
  assert(!fs.existsSync(path.join(logs(p), 'b.jsonl')), 'unchanged log cleared');
  assert(r.stdout.includes('Cleared 1 live log'), r.stdout);
  assert(!fs.readFileSync(path.join(destOf(r), 'a.jsonl'), 'utf8').includes('late write'), 'archive has the verified content');
});

test('archive: --clear unlink error exits non-zero with a message and no stack trace', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  const r = arch(p, ['m', '--project', 'x', '--root', root, '--clear'], { AGENT_TEAM_ARCHIVE_TEST_UNLINK_FAIL: '1' });
  eq(r.status, 1, 'non-zero');
  assert(/could not delete a\.jsonl: EPERM/.test(r.stderr), r.stderr);
  assert(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
  assert(fs.existsSync(path.join(logs(p), 'a.jsonl')), 'live log kept');
  const archived = fs.readdirSync(path.join(root, 'x'));
  eq(archived.length, 1, 'archive complete, no temp folder');
  assert(fs.existsSync(path.join(root, 'x', archived[0], 'a.jsonl')), 'archive has the log');
});

test('archive: stale sweep leaves dotfiles such as .gitkeep in .pending', () => {
  const p = project();
  const pd = path.join(logs(p), '.pending');
  const keep = path.join(pd, '.gitkeep');
  const old = path.join(pd, 'old');
  fs.writeFileSync(keep, '');
  fs.writeFileSync(old, '{}');
  const t = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(keep, t, t);
  fs.utimesSync(old, t, t);
  const r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(old), 'stale entry deleted (sweep ran)');
  assert(fs.existsSync(keep), '.gitkeep kept');
});

test('archive: --clear deletes live logs after verified copy and says cleared', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const r = arch(p, ['m', '--project', 'x', '--clear']);
  eq(r.status, 0, r.stderr);
  assert(!fs.existsSync(path.join(logs(p), 'a.jsonl')), 'live log deleted');
  const dest = destOf(r);
  assert(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').includes('cleared'), 'readme says cleared');
  assert(fs.readFileSync(path.join(dest, 'a.jsonl'), 'utf8').length > 0, 'archive has data');
});

test('archive: --dry-run writes nothing and deletes nothing', () => {
  const p = project();
  const old = path.join(logs(p), '.pending', 'old');
  fs.writeFileSync(old, '{}');
  const t = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(old, t, t);
  const root = tmp();
  const r = arch(p, ['m', '--project', 'x', '--root', root, '--clear', '--dry-run']);
  eq(r.status, 0, r.stderr);
  eq(fs.readdirSync(root).length, 0, 'root empty');
  assert(fs.existsSync(old), 'stale kept');
  assert(fs.existsSync(path.join(logs(p), 'delegations.jsonl')), 'log kept');
  assert(r.stdout.includes('dry-run'), r.stdout);
});

test('archive: no logs folder, or no jsonl, exits 1 with a message', () => {
  const p = tmpProject();
  let r = arch(p, ['m', '--project', 'x']);
  eq(r.status, 1, 'no folder');
  assert(/no \.agent-team\/logs/.test(r.stderr), r.stderr);
  fs.mkdirSync(logs(p), { recursive: true });
  fs.writeFileSync(path.join(logs(p), '.gitkeep'), '');
  const root = tmp();
  r = arch(p, ['m', '--project', 'x', '--root', root]);
  eq(r.status, 1, 'no jsonl');
  assert(/no \.jsonl/.test(r.stderr), r.stderr);
  eq(fs.readdirSync(root).length, 0, 'nothing written');
});

test('archive: project name derived from origin remote (https, ssh, .git, none)', () => {
  const cases = [
    ['https://github.com/Owner/repo-a.git', 'repo-a'],
    ['https://github.com/Owner/repo-b', 'repo-b'],
    ['git@github.com:Owner/repo-c.git', 'repo-c'],
    ['ssh://git@host.example/Owner/repo-d', 'repo-d'],
  ];
  for (const [url, name] of cases) {
    const p = project();
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: p });
    const r = arch(p, ['m']);
    eq(r.status, 0, r.stderr);
    eq(path.basename(path.dirname(destOf(r))), name, url);
  }
  const p = project();
  const r = arch(p, ['m']);
  eq(r.status, 0, r.stderr);
  eq(path.basename(path.dirname(destOf(r))), path.basename(fs.realpathSync(p)), 'folder-name fallback');
});

test('archive: milestone with "/" or spaces rejected, nothing written', () => {
  const p = project();
  for (const bad of ['a/b', 'a b', '..', '']) {
    const root = tmp();
    const r = arch(p, [bad, '--project', 'x', '--root', root]);
    eq(r.status, 1, `rejected "${bad}"`);
    eq(fs.readdirSync(root).length, 0, 'nothing written');
  }
});

test('archive: archive root may be a git repo (files only, no commits)', () => {
  const p = project({ 'a.jsonl': rec('m') + '\n' });
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const r = arch(p, ['m', '--project', 'x', '--root', root]);
  eq(r.status, 0, r.stderr);
  const log = spawnSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
  assert(log.status !== 0 || log.stdout.trim() === '', 'no commits made');
});
